import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { cols } from './db';
import { campaignFor, objectId, OperationError, withCampaignEdit, type Actor } from './operations';
import { isEmail } from './render';
import { SENDABLE } from './campaigns';

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(k => !['__proto__', 'constructor', 'prototype', 'email'].includes(k), 'Reserved field name');
const url = z.string().url().max(2000).refine(v => ['https:', 'http:'].includes(new URL(v).protocol), 'Use an HTTP or HTTPS source');
export const columnSchema = z.object({ key, label: z.string().trim().min(1).max(100), type: z.enum(['text', 'number', 'boolean', 'url']), description: z.string().max(1000).default('') }).strict();
export const cellSchema = z.object({ value: z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]), sources: z.array(url).max(10).default([]), kind: z.enum(['observed', 'inferred', 'manual']), status: z.enum(['complete', 'missing', 'failed']).default('complete'), retrievedAt: z.string().datetime({ offset: true }).optional(), note: z.string().max(1000).optional() }).strict();
export const rowSchema = z.object({ contactId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), kind: z.enum(['person', 'company']).default('person'), email: z.string().trim().max(320).refine(isEmail).optional(), profileUrl: url.optional(), domain: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/).max(253).optional(), fields: z.record(key, cellSchema).default({}) }).strict();
export type Column = z.infer<typeof columnSchema>;
export type Cell = z.infer<typeof cellSchema> & { updatedAt: Date; byUserId: string };
export interface ResearchTable { _id: ObjectId; space: string; name: string; columns: Column[]; createdAt: Date; updatedAt: Date }
export interface Contact { _id: ObjectId; space: string; kind: 'person' | 'company'; email?: string; profileUrl?: string; domain?: string; identities: string[]; tableIds: ObjectId[]; fields: Record<string, Cell>; revision: number; createdAt: Date; updatedAt: Date }
export const researchCols = (db: Db) => ({ tables: db.collection<ResearchTable>('researchTables'), contacts: db.collection<Contact>('contacts') });
export async function tableFor(db: Db, actor: Actor, id: string) {
  const table = await researchCols(db).tables.findOne({ _id: objectId(id), space: actor.space });
  if (!table) throw new OperationError('not_found', 'Research table not found in this workspace.');
  return table;
}
async function checkColumnTypes(db: Db, actor: Actor, columns: Column[]) {
  for (const column of columns) {
    if (await researchCols(db).tables.findOne({ space: actor.space, columns: { $elemMatch: { key: column.key, type: { $ne: column.type } } } })) throw new OperationError('column_conflict', `Column ${column.key} already uses a different type in this workspace.`);
  }
}
export async function createTable(db: Db, actor: Actor, name: string, columns: unknown[]) {
  const parsed = z.array(columnSchema).max(50).parse(columns);
  if (new Set(parsed.map(c => c.key)).size !== parsed.length) throw new OperationError('invalid_input', 'Column keys must be unique.');
  await checkColumnTypes(db, actor, parsed);
  const table: ResearchTable = { _id: new ObjectId(), space: actor.space, name: z.string().trim().min(1).max(200).parse(name), columns: parsed, createdAt: new Date(), updatedAt: new Date() };
  await researchCols(db).tables.insertOne(table);
  return table;
}
/** Removes lists. Contacts that were only in those lists go with them; contacts shared with another list stay there.
 *  Enrolled campaign recipients are snapshots and are untouched. Each step is idempotent, so a retry after a crash finishes the job. */
export async function deleteTables(db: Db, actor: Actor, ids: string[]) {
  const wanted = z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(200).parse(ids).map(objectId);
  const c = researchCols(db);
  const owned = (await c.tables.find({ _id: { $in: wanted }, space: actor.space }, { projection: { _id: 1 } }).toArray()).map(t => t._id);
  if (!owned.length) return { deleted: 0, contacts: 0 };
  await c.contacts.updateMany({ space: actor.space, tableIds: { $in: owned } }, { $pullAll: { tableIds: owned }, $set: { updatedAt: new Date() } });
  const { deletedCount: contacts } = await c.contacts.deleteMany({ space: actor.space, tableIds: [] });
  const { deletedCount: deleted } = await c.tables.deleteMany({ _id: { $in: owned }, space: actor.space });
  return { deleted, contacts };
}
/** Takes contacts out of one list. A contact that is in no other list is deleted; one shared with another list stays there. */
export async function removeFromTable(db: Db, actor: Actor, tableId: string, contactIds: string[]) {
  const table = await tableFor(db, actor, tableId);
  const ids = z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(200).parse(contactIds).map(objectId);
  const c = researchCols(db);
  const { modifiedCount: removed } = await c.contacts.updateMany({ _id: { $in: ids }, space: actor.space, tableIds: table._id }, { $pull: { tableIds: table._id }, $set: { updatedAt: new Date() } });
  const { deletedCount: deleted } = await c.contacts.deleteMany({ _id: { $in: ids }, space: actor.space, tableIds: [] });
  return { removed, deleted };
}
export async function addColumn(db: Db, actor: Actor, tableId: string, input: unknown) {
  const column = columnSchema.parse(input), table = await tableFor(db, actor, tableId);
  await checkColumnTypes(db, actor, [column]);
  const existing = table.columns.find(c => c.key === column.key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(column)) throw new OperationError('column_conflict', 'That column already has a different definition.');
    return table;
  }
  const result = await researchCols(db).tables.findOneAndUpdate({ _id: table._id, 'columns.key': { $ne: column.key }, 'columns.49': { $exists: false } }, { $push: { columns: column }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
  if (!result) throw new OperationError('column_conflict', 'The table changed or reached 50 columns. Reload it.');
  return result;
}
function profileIdentity(value: string) {
  const u = new URL(value); u.hash = ''; u.search = ''; u.hostname = u.hostname.toLowerCase();
  return u.toString().replace(/\/$/, '');
}
/** Natural identities + optimistic revision updates make imports race-safe without merging uncertain matches. */
export async function upsertRows(db: Db, actor: Actor, tableId: string, rows: unknown[], mode: 'fill_missing' | 'replace' = 'fill_missing', manual = false) {
  const table = await tableFor(db, actor, tableId), c = researchCols(db);
  const parsed = z.array(rowSchema).min(1).max(200).parse(rows);
  const results: { index: number; contactId?: string; status: string; detail?: string }[] = [];
  for (const [index, raw] of parsed.entries()) {
    try {
      const email = raw.email?.toLowerCase();
      const profileUrl = raw.profileUrl ? profileIdentity(raw.profileUrl) : undefined;
      const identities = [email ? `email:${email}` : '', profileUrl ? `profile:${profileUrl}` : '', raw.kind === 'company' && raw.domain ? `domain:${raw.domain}` : ''].filter(Boolean);
      if (!raw.contactId && !identities.length) throw new OperationError('identity_required', 'Supply an email, stable profile URL, or a domain for a company. Names alone are not deduplicated.');
      for (const [name, cell] of Object.entries(raw.fields)) {
        const column = table.columns.find(c => c.key === name);
        if (!column) throw new OperationError('unknown_column', `Define column ${name} first.`);
        if (cell.kind === 'manual' && !manual) throw new OperationError('invalid_input', 'Only edits in Hedwig may mark a value as manual.');
        if (cell.value !== null && (column.type === 'url' ? !url.safeParse(cell.value).success : typeof cell.value !== (column.type === 'text' ? 'string' : column.type))) throw new OperationError('invalid_input', `${name} must be ${column.type}.`);
        if (cell.status === 'complete' && cell.value !== null && cell.kind === 'observed' && !cell.sources.length) throw new OperationError('evidence_required', `${name} needs a source URL for an observed fact.`);
      }
      let saved: Contact | null = null;
      for (let attempt = 0; attempt < 5 && !saved; attempt++) {
        const matches = identities.length ? await c.contacts.find({ space: actor.space, identities: { $in: identities } }).limit(3).toArray() : [];
        let current = raw.contactId ? await c.contacts.findOne({ _id: objectId(raw.contactId), space: actor.space }) : matches[0];
        if (raw.contactId && !current) throw new OperationError('not_found', 'Contact not found.');
        if (matches.some(m => current && !m._id.equals(current._id)) || matches.length > 1) throw new OperationError('identity_conflict', 'These identifiers belong to different contacts. Review rather than auto-merge.');
        if (current && ((email && current.email && email !== current.email) || (profileUrl && current.profileUrl && profileUrl !== current.profileUrl) || current.kind !== raw.kind)) throw new OperationError('identity_conflict', 'Changing an existing identity requires manual review.');
        const fields = { ...(current?.fields ?? {}) };
        if (new Set([...Object.keys(fields), ...Object.keys(raw.fields)]).size > 100) throw new OperationError('field_limit', 'A contact can have up to 100 fields.');
        for (const [name, value] of Object.entries(raw.fields)) {
          const old = fields[name];
          if (!manual && old?.kind === 'manual') continue;
          if (mode === 'fill_missing' && old?.status === 'complete' && old.value !== null && old.value !== '') continue;
          fields[name] = { ...value, retrievedAt: value.retrievedAt ?? new Date().toISOString(), updatedAt: new Date(), byUserId: actor.userId.toHexString() };
        }
        const now = new Date();
        if (current) {
          try {
            saved = await c.contacts.findOneAndUpdate({ _id: current._id, revision: current.revision }, { $set: { fields, updatedAt: now, ...(email ? { email } : {}), ...(profileUrl ? { profileUrl } : {}), ...(raw.domain ? { domain: raw.domain } : {}) }, $addToSet: { identities: { $each: identities }, tableIds: table._id }, $inc: { revision: 1 } }, { returnDocument: 'after' });
          } catch (e: any) { if (e.code !== 11000) throw e; }
        } else {
          const doc: Contact = { _id: new ObjectId(), space: actor.space, kind: raw.kind, identities, tableIds: [table._id], fields, revision: 1, createdAt: now, updatedAt: now, ...(email ? { email } : {}), ...(profileUrl ? { profileUrl } : {}), ...(raw.domain ? { domain: raw.domain } : {}) };
          try { await c.contacts.insertOne(doc); saved = doc; } catch (e: any) { if (e.code !== 11000) throw e; }
        }
      }
      if (!saved) throw new OperationError('conflict', 'Concurrent update. Retry this row.');
      results.push({ index, contactId: saved._id.toHexString(), status: 'saved' });
    } catch (e) { if (!(e instanceof OperationError)) throw e; results.push({ index, status: e.code, detail: e.message }); }
  }
  return { results, saved: results.filter(r => r.status === 'saved').length };
}
export async function readTable(db: Db, actor: Actor, id: string, after?: string, limit = 50) {
  const table = await tableFor(db, actor, id);
  const rows = await researchCols(db).contacts.find({ space: actor.space, tableIds: table._id, ...(after ? { _id: { $gt: objectId(after) } } : {}) }).sort({ _id: 1 }).limit(Math.max(1, Math.min(limit, 200)) + 1).toArray();
  const more = rows.length > limit;
  if (more) rows.pop();
  return { table, rows, nextCursor: more ? rows.at(-1)!._id.toHexString() : null };
}
export async function enrollContacts(db: Db, actor: Actor, campaignId: string, contactIds: string[], allowPreviousOutreach = false) {
  z.array(z.string()).min(1).max(200).parse(contactIds);
  const campaign = await campaignFor(db, actor, campaignId);
  return withCampaignEdit(db, campaign._id, async fresh => {
    const c = cols(db), results: { contactId: string; status: string; leadId?: string }[] = [];
    const active = await c.campaigns.distinct('_id', { space: actor.space, status: 'active', _id: { $ne: fresh._id } });
    for (const id of [...new Set(contactIds)]) {
      const contact = await researchCols(db).contacts.findOne({ _id: objectId(id), space: actor.space });
      if (!contact?.email) { results.push({ contactId: id, status: 'email_missing' }); continue; }
      const email = contact.email;
      if (await c.suppressions.findOne({ space: actor.space, email })) { results.push({ contactId: id, status: 'suppressed' }); continue; }
      if (await c.leads.findOne({ campaignId: fresh._id, email })) { results.push({ contactId: id, status: 'already_enrolled' }); continue; }
      if (active.length && await c.leads.findOne({ campaignId: { $in: active }, email, status: { $in: SENDABLE } })) { results.push({ contactId: id, status: 'another_active_campaign' }); continue; }
      const previous = await c.leads.findOne({ space: actor.space, email, currentStep: { $gt: 0 } });
      if (previous && !allowPreviousOutreach) { results.push({ contactId: id, status: 'previous_outreach' }); continue; }
      const vars: Record<string, string> = { email };
      for (const [name, cell] of Object.entries(contact.fields)) if (cell.status === 'complete' && cell.value !== null) vars[name] = String(cell.value);
      const _id = new ObjectId();
      await c.leads.updateOne({ campaignId: fresh._id, email }, { $setOnInsert: { _id, space: actor.space, domain: email.split('@')[1], vars, provider: 'unknown', currentStep: 0, nextDueAt: null, status: 'queued', createdAt: new Date(), contactId: contact._id, researchRevision: contact.revision } }, { upsert: true });
      results.push({ contactId: id, status: 'enrolled', leadId: _id.toHexString() });
    }
    return { campaignId, campaignStatus: fresh.status, results, enrolled: results.filter(r => r.status === 'enrolled').length };
  });
}

/** Enroll a list in bounded batches using the same checks as selected-contact enrollment. */
export async function enrollTable(db: Db, actor: Actor, campaignId: string, tableId: string, allowPreviousOutreach = false) {
  const table = await tableFor(db, actor, tableId);
  const cursor = researchCols(db).contacts.find({ space: actor.space, tableIds: table._id }, { projection: { _id: 1 } }).sort({ _id: 1 });
  let batch: string[] = [], enrolled = 0;
  const skipped: Record<string, number> = {};
  const flush = async () => {
    const result = await enrollContacts(db, actor, campaignId, batch, allowPreviousOutreach);
    enrolled += result.enrolled;
    for (const row of result.results) if (row.status !== 'enrolled') skipped[row.status] = (skipped[row.status] ?? 0) + 1;
    batch = [];
  };
  try { for await (const row of cursor) { batch.push(row._id.toHexString()); if (batch.length === 200) await flush(); } if (batch.length) await flush(); }
  finally { await cursor.close(); }
  return { enrolled, results: Object.entries(skipped).map(([status, count]) => ({ status, detail: `${count} ${status.replaceAll('_', ' ')}` })) };
}
