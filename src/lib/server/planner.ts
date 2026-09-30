import { withCampaignEdit, OperationError } from './operations';
import { DateTime } from 'luxon';
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { accountCapacity } from './accounts';
import { randomToken } from './crypto';
import type { CampaignDoc, ScheduleSpec, SendDoc } from './types';

export interface Window { open: boolean; reason?: string; start: Date; end: Date; dayStart: Date; dayEnd: Date; localDay: string; dow: number }

/** Where "now" falls in a schedule's own timezone. */
export function windowFor(s: ScheduleSpec, now: Date): Window {
  const zone = s.timezone || 'UTC';
  const local = DateTime.fromJSDate(now, { zone });
  if (!local.isValid) throw new Error(`Invalid timezone "${s.timezone}"`);
  const [fh, fm] = s.from.split(':').map(Number);
  const [th, tm] = s.to.split(':').map(Number);
  const start = local.set({ hour: fh, minute: fm, second: 0, millisecond: 0 });
  const end = local.set({ hour: th, minute: tm, second: 0, millisecond: 0 });
  const dow = local.weekday % 7; // luxon 1=Mon…7=Sun → 0=Sun…6=Sat
  let open = true;
  let reason: string | undefined;
  if (!s.days.includes(dow)) { open = false; reason = 'closed day'; }
  else if (local < start) { open = false; reason = 'before the window'; }
  else if (local >= end) { open = false; reason = 'after the window'; }
  if (s.startAt && now < new Date(s.startAt)) { open = false; reason = 'not started yet'; }
  if (s.endAt && now > new Date(s.endAt)) { open = false; reason = 'schedule ended'; }
  return { open, reason, start: start.toJSDate(), end: end.toJSDate(), dayStart: local.startOf('day').toJSDate(), dayEnd: local.endOf('day').toJSDate(), localDay: local.toISODate()!, dow };
}

/** Next moment the window is open at or after `from` (up to 21 days ahead). */
export function nextOpen(s: ScheduleSpec, from: Date): Date | null {
  const zone = s.timezone || 'UTC';
  let cursor = DateTime.fromJSDate(from, { zone });
  for (let i = 0; i < 22; i++) {
    const w = windowFor(s, cursor.toJSDate());
    if (w.open) return cursor.toJSDate();
    if (s.days.includes(w.dow) && cursor.toJSDate() < w.start && !(s.startAt && w.start < new Date(s.startAt))) return w.start;
    cursor = cursor.plus({ days: 1 }).startOf('day');
  }
  return null;
}

/** n moments spread evenly between from and to, each nudged by up to ±40% of the gap. Never a burst. */
export function spreadSlots(from: Date, to: Date, n: number, rnd: () => number = Math.random): Date[] {
  if (n <= 0) return [];
  const span = to.getTime() - from.getTime();
  if (span <= 0) return Array.from({ length: n }, () => new Date(from));
  const gap = span / n;
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    const center = from.getTime() + gap * (i + 0.5);
    const jitter = (rnd() - 0.5) * 0.8 * gap;
    out.push(new Date(Math.min(to.getTime() - 1, Math.max(from.getTime(), Math.round(center + jitter)))));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export interface PlanResult { planned: number; reason?: string }

/** Books today's sends for one active campaign. Safe to call every minute: it only fills what is still missing. */
export async function planCampaign(db: Db, campaign: CampaignDoc, now: Date, rnd?: () => number): Promise<PlanResult> {
  try { return await withCampaignEdit(db, campaign._id, fresh => planLocked(db, fresh, now, rnd), true); }
  catch (e) { if (e instanceof OperationError) return { planned: 0, reason: e.message }; throw e; }
}

async function planLocked(db: Db, campaign: CampaignDoc, now: Date, rnd?: () => number): Promise<PlanResult> {
  const c = cols(db);
  if (campaign.status !== 'active') return { planned: 0, reason: 'campaign not active' };
  const w = windowFor(campaign.schedule, now);
  if (!w.open) return { planned: 0, reason: w.reason };
  if (!campaign.steps.length) return { planned: 0, reason: 'no steps' };
  const accounts = await c.emailAccounts.find({ _id: { $in: campaign.accountIds }, space: campaign.space, status: 'active' }).toArray();
  if (!accounts.length) return { planned: 0, reason: 'no active mailbox' };

  const todayCount = await c.sends.countDocuments({ campaignId: campaign._id, status: { $in: ['planned', 'claimed', 'sent'] }, dueAt: { $gte: w.dayStart, $lte: w.dayEnd } });
  let remaining = campaign.dailyLimit - todayCount;
  if (remaining <= 0) return { planned: 0, reason: 'campaign daily limit reached' };

  const caps = new Map<string, number>();
  for (const a of accounts) caps.set(a._id.toHexString(), (await accountCapacity(db, a, now, campaign.schedule.timezone)).capacity);
  const totalCap = [...caps.values()].reduce((x, y) => x + y, 0);
  if (totalCap <= 0) return { planned: 0, reason: 'mailboxes at their limit' };
  remaining = Math.min(remaining, totalCap);

  const lastStep = campaign.steps.length - 1;
  const followUps = await c.leads.find(
    { campaignId: campaign._id, status: { $in: ['contacted', 'opened'] }, currentStep: { $gt: 0, $lte: lastStep }, nextDueAt: { $lte: now } },
    { sort: { nextDueAt: 1 }, limit: remaining * 2 }
  ).toArray();
  const fresh = await c.leads.find({ campaignId: campaign._id, status: 'queued', currentStep: 0 }, { sort: { createdAt: 1 }, limit: remaining * 2 }).toArray();
  const candidates = [...followUps, ...fresh];
  if (!candidates.length) return { planned: 0, reason: 'nothing due' };

  const existing = await c.sends.find({ leadId: { $in: candidates.map((l) => l._id) }, status: { $in: ['planned', 'claimed', 'sent'] } }, { projection: { leadId: 1, stepIndex: 1 } }).toArray();
  const has = new Set(existing.map((e) => `${e.leadId.toHexString()}:${e.stepIndex}`));
  const todo = candidates.filter((l) => !has.has(`${l._id.toHexString()}:${l.currentStep}`));

  const order = accounts.map((a) => a._id.toHexString());
  let rr = 0;
  const chosen: { leadId: ObjectId; stepIndex: number; accId: string }[] = [];
  for (const lead of todo) {
    if (chosen.length >= remaining) break;
    let accId: string | null = null;
    if (lead.accountId) {
      const k = lead.accountId.toHexString();
      if ((caps.get(k) ?? 0) > 0) accId = k; else continue; // pinned mailbox is full today
    } else {
      for (let i = 0; i < order.length; i++) {
        const k = order[(rr + i) % order.length];
        if ((caps.get(k) ?? 0) > 0) { accId = k; rr = (rr + i + 1) % order.length; break; }
      }
      if (!accId) break;
    }
    caps.set(accId, caps.get(accId)! - 1);
    chosen.push({ leadId: lead._id, stepIndex: lead.currentStep, accId });
  }
  if (!chosen.length) return { planned: 0, reason: 'no mailbox capacity for the leads due' };

  const from = new Date(Math.max(now.getTime() + 20_000, w.start.getTime()));
  const slots = spreadSlots(from, w.end, chosen.length, rnd);
  const docs: SendDoc[] = chosen.map((ch, i) => ({
    _id: new ObjectId(), space: campaign.space, campaignId: campaign._id, leadId: ch.leadId, stepIndex: ch.stepIndex,
    accountId: new ObjectId(ch.accId), dueAt: slots[i], status: 'planned', attempt: 0,
    tokens: { open: randomToken(18), unsub: randomToken(18) }, createdAt: now
  }));
  let planned = 0;
  for (const doc of docs) {
    try {
      const revived = await c.sends.updateOne(
        { leadId: doc.leadId, stepIndex: doc.stepIndex, status: 'cancelled', ids: { $exists: false } },
        { $set: { status: 'planned', accountId: doc.accountId, dueAt: doc.dueAt }, $unset: { reason: '', error: '' } }
      );
      if (revived.modifiedCount) { planned++; continue; }
      await c.sends.insertOne(doc); planned++;
    } catch (e: any) { if (e.code !== 11000) throw e; }
  }
  return { planned };
}

export async function planAll(db: Db, now: Date): Promise<{ planned: number; notes: string[] }> {
  const campaigns = await cols(db).campaigns.find({ status: 'active' }).toArray();
  let planned = 0;
  const notes: string[] = [];
  for (const camp of campaigns) {
    try {
      const r = await planCampaign(db, camp, now);
      planned += r.planned;
      if (r.reason && r.reason !== 'nothing due' && !/window|closed day/.test(r.reason)) notes.push(`${camp.name}: ${r.reason}`);
    } catch (e: any) { notes.push(`${camp.name}: ${e.message}`); }
  }
  return { planned, notes };
}

/** A campaign with nothing left to send is completed. */
export async function completeFinishedCampaigns(db: Db): Promise<number> {
  const c = cols(db);
  const active = await c.campaigns.find({ status: 'active' }).toArray();
  let n = 0;
  for (const candidate of active) {
    try { await withCampaignEdit(db, candidate._id, async camp => {
    if (camp.status !== 'active') return;
    const [queued, pendingFollowUps, pendingSends] = await Promise.all([
      c.leads.countDocuments({ campaignId: camp._id, status: 'queued' }),
      c.leads.countDocuments({ campaignId: camp._id, status: { $in: ['contacted', 'opened'] }, currentStep: { $lte: camp.steps.length - 1, $gt: 0 } }),
      c.sends.countDocuments({ campaignId: camp._id, status: { $in: ['planned', 'claimed'] } })
    ]);
    const anyLead = await c.leads.countDocuments({ campaignId: camp._id }, { limit: 1 });
    if (anyLead && queued === 0 && pendingFollowUps === 0 && pendingSends === 0) {
      await c.campaigns.updateOne({ _id: camp._id, status: 'active' }, { $set: { status: 'completed', updatedAt: new Date() } });
      n++;
    }
    }, true); } catch (e) { if (!(e instanceof OperationError)) throw e; }
  }
  return n;
}
