import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { randomToken, sha256 } from './crypto';
import type { CampaignDoc } from './types';

export class OperationError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface Actor { userId: ObjectId; space: string; scopes?: string[]; connectionId?: string }
export function requireScope(actor: Actor, scope: string) {
  if (actor.scopes && !actor.scopes.includes(scope)) throw new OperationError('forbidden', `This connection needs ${scope} permission.`);
}
export function objectId(id: string) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new OperationError('invalid_input', 'Invalid record id.');
  return new ObjectId(id);
}
export async function campaignFor(db: Db, actor: Actor, id: string) {
  const campaign = await cols(db).campaigns.findOne({ _id: objectId(id), space: actor.space });
  if (!campaign) throw new OperationError('not_found', 'Campaign not found in this workspace.');
  return campaign;
}

/** A single-document mutex serializes edits and activation. No external calls inside this lock.
 * Locks deliberately do not expire: a crashed mutation must not overlap another mutation.
 * Recovery is an explicit operator action after the stopped web process has been investigated. */
export async function withCampaignEdit<T>(db: Db, id: ObjectId, fn: (campaign: CampaignDoc) => Promise<T>, allowActive = false): Promise<T> {
  const original = await cols(db).campaigns.findOne({ _id: id });
  if (!original) throw new OperationError('not_found', 'Campaign not found.');
  return withWorkspaceEdit(db, original.space, async () => {
  const token = randomToken();
  const campaign = await cols(db).campaigns.findOneAndUpdate(
    { _id: id, editLock: { $exists: false }, ...(allowActive ? {} : { status: { $ne: 'active' } }) },
    { $set: { editLock: token, editLockedAt: new Date() } }, { returnDocument: 'after' }
  );
  if (!campaign) throw new OperationError('campaign_busy', 'Pause the campaign first, or wait for the current change to finish.');
  try {
    if (!allowActive && await cols(db).sends.findOne({ campaignId: id, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] })) {
      throw new OperationError('send_in_flight', 'The campaign is paused, but a send is still in flight or awaiting reconciliation. Try again once it has settled.');
    }
    return await fn(campaign);
  } finally {
    await cols(db).campaigns.updateOne({ _id: id, editLock: token }, { $unset: { editLock: '', editLockedAt: '' } });
  }
  });
}

export async function withWorkspaceEdit<T>(db: Db, space: string, fn: () => Promise<T>): Promise<T> {
  const token = randomToken(), locks = db.collection('workspaceLocks');
  try { await locks.insertOne({ _id: space as any, token, createdAt: new Date() }); }
  catch (e: any) { if (e.code === 11000) throw new OperationError('workspace_busy', 'Another workspace operation is running. Retry shortly.'); throw e; }
  try { return await fn(); } finally { await locks.deleteOne({ _id: space as any, token }); }
}

/** Durable receipts prevent a retried command from reactivating a subsequently paused campaign.
 * Interrupted operations remain pending for operator review rather than being blindly replayed. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export async function command<T>(db: Db, actor: Actor, key: string, action: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  if (!/^[\w:-]{8,128}$/.test(key)) throw new OperationError('invalid_input', 'requestId must be 8–128 letters, digits, underscores, colons or hyphens. Reuse it only when retrying the same command.');
  const collection = db.collection('operationReceipts');
  const id = sha256(`${actor.space}:${actor.userId}:${key}`);
  const fingerprint = sha256(JSON.stringify(canonical(JSON.parse(JSON.stringify({ action, input })))));
  try { await collection.insertOne({ _id: id as any, space: actor.space, userId: actor.userId, connectionId: actor.connectionId, action, fingerprint, status: 'pending', createdAt: new Date() }); }
  catch (e: any) {
    if (e.code !== 11000) throw e;
    const receipt = await collection.findOne({ _id: id as any });
    if (receipt?.fingerprint !== fingerprint) throw new OperationError('request_conflict', 'That requestId was already used for different input.');
    if (receipt?.status === 'done') return receipt.result as T;
    if (receipt?.status === 'failed') throw new OperationError('previous_failure', receipt.error);
    throw new OperationError('operation_pending', 'This command is running or was interrupted. Inspect its receipt before trying a new requestId.');
  }
  try {
    const result = JSON.parse(JSON.stringify(await fn()));
    await collection.updateOne({ _id: id as any }, { $set: { status: 'done', result, finishedAt: new Date() } });
    return result;
  } catch (e) {
    if (e instanceof OperationError && ['workspace_busy', 'campaign_busy'].includes(e.code)) {
      await collection.deleteOne({ _id: id as any, status: 'pending' });
      throw e;
    }
    await collection.updateOne({ _id: id as any }, { $set: { status: 'failed', error: e instanceof OperationError ? e.message : 'Operation failed; inspect server logs before retrying.', finishedAt: new Date() } });
    throw e;
  }
}
