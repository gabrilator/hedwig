import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import type { CampaignDoc, LeadDoc, LeadStatus, ScheduleSpec, SpaceKey } from './types';

export const LEAD_STATUSES: LeadStatus[] = ['queued', 'contacted', 'opened', 'replied', 'interested', 'meeting', 'won', 'not_interested', 'bounced', 'unsubscribed', 'paused'];
export const STATUS_LABEL: Record<LeadStatus, string> = {
  queued: 'Queued', contacted: 'Contacted', opened: 'Opened', replied: 'Replied', interested: 'Interested', meeting: 'Meeting', won: 'Won',
  not_interested: 'Not interested', bounced: 'Bounced', unsubscribed: 'Unsubscribed', paused: 'Paused'
};
/** Statuses from which the sequence keeps going. */
export const SENDABLE: LeadStatus[] = ['queued', 'contacted', 'opened'];

/** 09:00–15:00 on weekdays, read in the zone the user picked when creating the campaign. There is no default zone. */
export const defaultSchedule = (timezone: string): ScheduleSpec => ({ timezone, from: '09:00', to: '15:00', days: [1, 2, 3, 4, 5], startAt: null, endAt: null });

export function newCampaign(space: SpaceKey, ownerUserId: ObjectId, name: string, testRecipient: string, timezone: string): Omit<CampaignDoc, '_id'> {
  const now = new Date();
  return {
    space, ownerUserId, name: name.trim() || 'Untitled campaign', status: 'draft', schedule: defaultSchedule(timezone),
    steps: [{ subject: '', body: '', delayDays: 0 }], accountIds: [], dailyLimit: 30, stopOnReply: true, oooStops: false,
    openTracking: true, testRecipient, unsubscribeLine: '',
    agentId: null, agentRules: [], createdAt: now, updatedAt: now
  };
}

export async function leadCounts(db: Db, campaignId: ObjectId): Promise<Record<LeadStatus | 'total', number>> {
  const rows = await cols(db).leads.aggregate<{ _id: LeadStatus; n: number }>([{ $match: { campaignId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  const out = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus | 'total', number>;
  let total = 0;
  for (const r of rows) { out[r._id] = r.n; total += r.n; }
  out.total = total;
  return out;
}

export function activationProblems(c: CampaignDoc, leadTotal: number): string[] {
  const p: string[] = [];
  if (c.accountIds.length === 0) p.push('Pick at least one sending mailbox in Options.');
  if (!c.steps.length || !c.steps[0].body.trim()) p.push('Step 1 needs a body.');
  if (!c.steps[0]?.subject?.trim()) p.push('Step 1 needs a subject.');
  if (leadTotal === 0) p.push('Import some leads first.');
  if (!c.schedule.days.length) p.push('Pick at least one sending day in Schedule.');
  return p;
}

/** Statuses that stop the sequence when set by hand. */
const STOPS: LeadStatus[] = ['replied', 'interested', 'meeting', 'won', 'not_interested', 'bounced', 'unsubscribed', 'paused'];

/**
 * One place for "set this lead's status" (drawer, inbox, agent): a stopping status cancels the booked steps, unsubscribed
 * and bounced also suppress the address for the whole space. A status a person sets is marked as theirs: the reply
 * classifier leaves that lead alone from then on.
 */
export async function applyLeadStatus(db: Db, lead: Pick<LeadDoc, '_id' | 'space' | 'email' | 'campaignId'>, status: LeadStatus, by: string, opts: { byPerson?: boolean } = {}): Promise<void> {
  const c = cols(db);
  const now = new Date();
  const set: Record<string, unknown> = { status, lastEventAt: now };
  if (opts.byPerson) set.statusBy = by;
  if (STOPS.includes(status)) {
    set.nextDueAt = null;
    await c.sends.updateMany({ leadId: lead._id, status: { $in: ['planned', 'claimed'] } }, { $set: { status: 'cancelled', reason: `marked ${status} (${by})` } });
  }
  await c.leads.updateOne({ _id: lead._id, campaignId: lead.campaignId }, { $set: set });
  if (status === 'unsubscribed' || status === 'bounced') {
    await c.suppressions.updateOne({ space: lead.space, email: lead.email }, { $setOnInsert: { reason: `${by}: ${status}`, at: now } }, { upsert: true });
  }
}

/**
 * A copy of a campaign as a new draft: steps, schedule, mailboxes, options and agent settings travel; leads, sends, messages,
 * stats and the start date do not. Leads live in their own collection keyed by campaign id, so nothing has to be skipped.
 */
export async function duplicateCampaign(db: Db, campaign: CampaignDoc, ownerUserId: ObjectId): Promise<ObjectId> {
  const now = new Date();
  const { _id, startedAt, editLock, editLockedAt, ...rest } = campaign;
  void _id; void startedAt;
  const copy: CampaignDoc = { ...rest, _id: new ObjectId(), ownerUserId, name: `${campaign.name} (copy)`, status: 'draft', createdAt: now, updatedAt: now };
  await cols(db).campaigns.insertOne(copy);
  return copy._id;
}
