import { DEFAULT_AGENT_NAME, DEFAULT_MODEL, DEFAULT_PERSONA } from './agent';
import { z } from 'zod';
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { activationProblems, leadCounts, newCampaign, SENDABLE } from './campaigns';
import { campaignFor, objectId, OperationError, withCampaignEdit, type Actor } from './operations';
import { isTimezone } from './timezones';
import { buildStepMail } from './sender';
import { sanitizeBody } from './sanitize';
import { nextOpen, windowFor } from './planner';
import { accountCapacity } from './accounts';
import { series, totals, groupedTotals } from './stats';
import { HEARTBEAT_STALE_SEC } from './jobs';
import type { CampaignDoc, LeadDoc } from './types';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleInput = z.object({ timezone: z.string().refine(isTimezone, 'Unknown timezone'), from: clock, to: clock, days: z.array(z.number().int().min(0).max(6)).min(1).max(7), startAt: z.string().datetime({ offset: true }).nullable().optional(), endAt: z.string().datetime({ offset: true }).nullable().optional() }).refine(s => s.from < s.to, 'Sending window must end after it starts').refine(s => !s.startAt || !s.endAt || Date.parse(s.startAt) < Date.parse(s.endAt), 'End date must follow start date');
export const campaignPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  steps: z.array(z.object({ subject: z.string().max(1000).nullable(), body: z.string().max(50000), delayDays: z.number().int().min(0).max(90) })).min(1).max(12).optional(),
  schedule: scheduleInput.optional(), accountIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(30).optional(),
  dailyLimit: z.number().int().min(1).max(10000).optional(), stopOnReply: z.boolean().optional(), oooStops: z.boolean().optional(), openTracking: z.boolean().optional(), unsubscribeLine: z.string().max(1000).optional(),
  testRecipient: z.union([z.string().email(), z.literal('')]).optional(),
  agentId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(), agentOff: z.boolean().optional(),
  agentRules: z.array(z.object({ if: z.string().max(2000), then: z.string().max(2000) }).strict()).max(50).optional()
}).strict();

export async function createCampaign(db: Db, actor: Actor, input: { name: string; timezone: string }) {
  const value = z.object({ name: z.string().trim().min(1).max(200), timezone: z.string().refine(isTimezone) }).parse(input);
  const user = await cols(db).users.findOne({ _id: actor.userId });
  const doc = { _id: new ObjectId(), ...newCampaign(actor.space, actor.userId, value.name, user?.email ?? '', value.timezone) };
  await cols(db).campaigns.insertOne(doc);
  return { id: doc._id.toHexString(), name: doc.name, status: doc.status };
}
export async function updateCampaign(db: Db, actor: Actor, id: string, input: unknown) {
  const patch = campaignPatch.parse(input);
  const campaign = await campaignFor(db, actor, id);
  return withCampaignEdit(db, campaign._id, async () => {
    const changes: Record<string, unknown> = { ...patch, updatedAt: new Date() };
    if (patch.schedule) changes.schedule = { ...patch.schedule, startAt: patch.schedule.startAt ? new Date(patch.schedule.startAt) : null, endAt: patch.schedule.endAt ? new Date(patch.schedule.endAt) : null };
    if (patch.accountIds) {
      const ids = patch.accountIds.map(objectId);
      if (await cols(db).emailAccounts.countDocuments({ _id: { $in: ids }, space: actor.space }) !== new Set(patch.accountIds).size) throw new OperationError('invalid_input', 'Choose mailboxes from this workspace.');
      changes.accountIds = ids;
    }
    if (patch.agentId !== undefined) {
      if (patch.agentId && !await cols(db).agents.findOne({ _id: objectId(patch.agentId), space: actor.space })) throw new OperationError('not_found', 'Agent not found in this workspace.');
      changes.agentId = patch.agentId ? objectId(patch.agentId) : null;
    }
    if (patch.steps) changes.steps = patch.steps.map((s, i) => ({ ...s, body: sanitizeBody(s.body), delayDays: i === 0 ? 0 : s.delayDays }));
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: changes });
    return { id, updated: true, status: campaign.status };
  });
}
export async function readiness(db: Db, campaign: CampaignDoc) {
  const c = cols(db), counts = await leadCounts(db, campaign._id);
  const problems = activationProblems(campaign, counts.total);
  const validSchedule = scheduleInput.safeParse({ ...campaign.schedule, startAt: campaign.schedule.startAt?.toISOString() ?? null, endAt: campaign.schedule.endAt?.toISOString() ?? null });
  if (!validSchedule.success) problems.push('The sending schedule is invalid.');
  if (campaign.schedule.endAt && campaign.schedule.endAt < new Date()) problems.push('The campaign end date has passed.');
  if (campaign.steps.some(s => !s.body.trim())) problems.push('Every step needs a body.');
  const accounts = await c.emailAccounts.find({ _id: { $in: campaign.accountIds }, space: campaign.space, status: 'active' }).toArray();
  if (!accounts.length) problems.push('No active sending mailbox in this workspace.');
  const hb = await c.heartbeat.findOne({ _id: 'worker' });
  if (!hb || Date.now() - hb.at.getTime() > HEARTBEAT_STALE_SEC * 1000) problems.push('The worker is offline or its heartbeat is stale.');
  if (await c.sends.findOne({ campaignId: campaign._id, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] })) problems.push('A send is still in flight or awaiting reconciliation.');
  const missing = new Set<string>();
  let eligible = 0;
  const other = await c.campaigns.distinct('_id', { space: campaign.space, _id: { $ne: campaign._id }, status: 'active' });
  let conflicts = 0;
  const conflictingContacts: { leadId: string; email: string; campaigns: { id: string; name: string; leadId: string }[] }[] = [];
  const otherCampaigns = await c.campaigns.find({ _id: { $in: other }, space: campaign.space }, { projection: { name: 1 } }).toArray();
  async function inspectBatch(batch: LeadDoc[]) {
    const emails = batch.map(l => l.email);
    const [suppressed, overlapping] = await Promise.all([
      c.suppressions.distinct('email', { space: campaign.space, email: { $in: emails } }),
      other.length ? c.leads.find({ space: campaign.space, campaignId: { $in: other }, email: { $in: emails }, status: { $in: SENDABLE } }, { projection: { email: 1, campaignId: 1 } }).toArray() : Promise.resolve([])
    ]);
    const blocked = new Set(suppressed);
    for (const lead of batch) {
      if (lead.currentStep >= campaign.steps.length || blocked.has(lead.email)) continue;
      eligible++;
      for (let i = lead.currentStep; i < campaign.steps.length; i++) for (const key of buildStepMail(campaign, i, lead, null).missing) missing.add(key);
      const matches = overlapping.filter(l => l.email === lead.email);
      if (matches.length) {
        conflicts++;
        if (conflictingContacts.length < 100) conflictingContacts.push({ leadId: lead._id.toHexString(), email: lead.email, campaigns: matches.map(l => ({ id: l.campaignId.toHexString(), name: otherCampaigns.find(cp => cp._id.equals(l.campaignId))?.name ?? 'Campaign', leadId: l._id.toHexString() })) });
      }
    }
  }
  let batch: LeadDoc[] = [];
  for await (const lead of c.leads.find({ campaignId: campaign._id, status: { $in: SENDABLE } }).batchSize(250)) {
    batch.push(lead);
    if (batch.length === 250) { await inspectBatch(batch); batch = []; }
  }
  if (batch.length) await inspectBatch(batch);
  if (!eligible) problems.push('No eligible leads remain.');
  if (missing.size) problems.push(`Missing required variables: ${[...missing].join(', ')}. Fill them or use template fallbacks.`);
  if (conflicts) problems.push(`${conflicts} ${conflicts === 1 ? 'contact is' : 'contacts are'} enrolled in another active campaign. Resolve the contacts in campaign Options.`);
  return { problems, eligible, counts, conflicts, conflictingContacts };
}
export async function resolveCampaignConflict(db: Db, actor: Actor, id: string, leadId: string, choice: string) {
  if (!['remove', 'keep'].includes(choice)) throw new OperationError('invalid_input', 'Choose how to resolve this contact.');
  const campaign = await campaignFor(db, actor, id);
  return withCampaignEdit(db, campaign._id, async () => {
    const c = cols(db);
    const lead = await c.leads.findOne({ _id: objectId(leadId), campaignId: campaign._id, space: actor.space });
    if (!lead) throw new OperationError('not_found', 'Contact no longer belongs to this campaign. Refresh the page.');
    if (choice === 'remove') {
      await c.sends.updateMany({ leadId: lead._id, status: 'planned', ids: { $exists: false } }, { $set: { status: 'cancelled', reason: 'removed from campaign' } });
      await c.leads.deleteOne({ _id: lead._id, campaignId: campaign._id });
      return `${lead.email} removed from this campaign. Other campaigns are unchanged.`;
    }
    const active = await c.campaigns.distinct('_id', { space: actor.space, _id: { $ne: campaign._id }, status: 'active' });
    const others = await c.leads.find({ space: actor.space, campaignId: { $in: active }, email: lead.email, status: { $in: SENDABLE } }).toArray();
    const ids = others.map(l => l._id);
    // The workspace mutex also blocks new sender claims in the other campaigns.
    if (await c.sends.findOne({ leadId: { $in: ids }, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] })) throw new OperationError('send_in_flight', `An email to ${lead.email} is already in flight or awaiting reconciliation in another campaign. Try again once it has settled.`);
    await c.leads.updateMany({ _id: { $in: ids }, status: { $in: SENDABLE } }, { $set: { status: 'paused', nextDueAt: null } });
    await c.sends.updateMany({ leadId: { $in: ids }, status: 'planned', ids: { $exists: false } }, { $set: { status: 'cancelled', reason: 'contact kept in another campaign' } });
    return `${lead.email} kept here. Outreach to this contact is paused in the other active campaigns; their history is preserved. This campaign has not been resumed.`;
  });
}
export async function pauseCampaign(db: Db, actor: Actor, id: string) {
  const campaign = await campaignFor(db, actor, id);
  return withCampaignEdit(db, campaign._id, async () => {
    const c = cols(db);
    await c.campaigns.updateOne({ _id: campaign._id }, { $set: { status: 'paused', updatedAt: new Date() } });
    await c.sends.updateMany({ campaignId: campaign._id, status: 'planned', ids: { $exists: false } }, { $set: { status: 'cancelled', reason: 'campaign paused' } });
    const inFlight = await c.sends.countDocuments({ campaignId: campaign._id, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] });
    return { id, status: 'paused', safeToEdit: inFlight === 0, inFlight };
  }, true);
}
export async function startCampaign(db: Db, actor: Actor, id: string) {
  const campaign = await campaignFor(db, actor, id);
  return withCampaignEdit(db, campaign._id, async fresh => {
    if (fresh.status === 'active') return { id, status: 'active' };
    const ready = await readiness(db, fresh);
    if (ready.problems.length) throw new OperationError('not_ready', ready.problems.join(' '));
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: { status: 'active', updatedAt: new Date(), startedAt: fresh.startedAt ?? new Date() } });
    return { id, status: 'active' };
  }, true);
}
export async function campaignState(db: Db, actor: Actor, id: string) {
  const campaign = await campaignFor(db, actor, id), c = cols(db), now = new Date();
  const accounts = await c.emailAccounts.find({ _id: { $in: campaign.accountIds }, space: actor.space }).toArray();
  const capacities = await Promise.all(accounts.map(async a => ({ id: a._id, address: a.address, status: a.status, ...(await accountCapacity(db, a, now, campaign.schedule.timezone)) })));
  let window: unknown;
  try { window = { ...windowFor(campaign.schedule, now), nextOpen: nextOpen(campaign.schedule, now) }; } catch { window = { reason: 'Invalid schedule' }; }
  const { editLock, editLockedAt, ...safe } = campaign;
  const inFlight = await c.sends.countDocuments({ campaignId: campaign._id, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] });
  const agent = campaign.agentOff ? null : await c.agents.findOne({ space: actor.space, ...(campaign.agentId ? { _id: campaign.agentId } : { builtin: true }) });
  const agentSettings = campaign.agentOff ? null : agent ?? { name: DEFAULT_AGENT_NAME, model: DEFAULT_MODEL, persona: DEFAULT_PERSONA, mode: 'classify', active: true, builtin: true };
  return { campaign: safe, agent: agentSettings, editing: !!editLock, safeToEdit: campaign.status !== 'active' && !editLock && inFlight === 0, inFlight, ...(await readiness(db, campaign)), window, mailboxes: capacities, asOf: now };
}
export async function campaignStats(db: Db, actor: Actor, id: string, from: string, to: string) {
  const campaign = await campaignFor(db, actor, id);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
  date.parse(from); date.parse(to);
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 864e5) throw new OperationError('invalid_input', 'Choose an ascending date range of at most 367 days.');
  const match = { space: actor.space, campaignId: campaign._id, day: { $gte: from, $lte: to } };
  return { from, to, timezone: 'UTC', definitions: { sent: 'Email messages, including follow-ups', uniqueOpens: 'Emails opened, not unique people', replies: 'Reply events, not unique people' }, totals: await totals(db, match), daily: await series(db, match, new Date(from), new Date(to)), byStep: await groupedTotals(db, match, '$stepIndex'), byMailbox: await groupedTotals(db, match, '$accountId') };
}
