import type { Db, Filter, ObjectId } from 'mongodb';
import { cols } from './db';
import type { DailyStatDoc, EventType, SpaceKey } from './types';

export function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
export function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (d <= end) { out.push(dayKey(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export interface EventInput {
  space: SpaceKey; campaignId: ObjectId; leadId: ObjectId; accountId: ObjectId; stepIndex: number;
  type: EventType; at?: Date; meta?: Record<string, unknown>; uniqueOpen?: boolean;
}
export async function recordEvent(db: Db, ev: EventInput): Promise<void> {
  const at = ev.at ?? new Date();
  const c = cols(db);
  await c.events.insertOne({
    space: ev.space, campaignId: ev.campaignId, leadId: ev.leadId, accountId: ev.accountId,
    stepIndex: ev.stepIndex, type: ev.type, at, meta: ev.meta
  } as never);
  const inc: Record<string, number> = {};
  if (ev.type === 'sent') inc.sent = 1;
  else if (ev.type === 'open') { inc.opens = 1; if (ev.uniqueOpen) inc.uniqueOpens = 1; }
  else if (ev.type === 'reply') inc.replies = 1;
  else if (ev.type === 'bounce') inc.bounces = 1;
  else if (ev.type === 'ooo') inc.ooo = 1;
  else if (ev.type === 'unsubscribe') inc.unsubscribes = 1;
  await c.dailyStats.updateOne(
    { day: dayKey(at), campaignId: ev.campaignId, stepIndex: ev.stepIndex, accountId: ev.accountId },
    { $inc: inc, $setOnInsert: { space: ev.space } },
    { upsert: true }
  );
}

export interface SeriesPoint { day: string; sent: number; opens: number; uniqueOpens: number; replies: number; bounces: number; ooo: number; unsubscribes: number }
export interface Totals { sent: number; opens: number; uniqueOpens: number; replies: number; bounces: number; ooo: number; unsubscribes: number }
const ZERO: Totals = { sent: 0, opens: 0, uniqueOpens: 0, replies: 0, bounces: 0, ooo: 0, unsubscribes: 0 };
const SUM_FIELDS = { sent: { $sum: '$sent' }, opens: { $sum: '$opens' }, uniqueOpens: { $sum: '$uniqueOpens' }, replies: { $sum: '$replies' }, bounces: { $sum: '$bounces' }, ooo: { $sum: '$ooo' }, unsubscribes: { $sum: '$unsubscribes' } };

export async function series(db: Db, match: Filter<DailyStatDoc>, from: Date, to: Date): Promise<SeriesPoint[]> {
  const rows = await cols(db).dailyStats.aggregate<{ _id: string } & Totals>([
    { $match: { ...match, day: { $gte: dayKey(from), $lte: dayKey(to) } } },
    { $group: { _id: '$day', ...SUM_FIELDS } }
  ]).toArray();
  const byDay = new Map(rows.map((r) => [r._id, r]));
  return daysBetween(from, to).map((day) => ({ day, ...ZERO, ...(byDay.get(day) ?? {}) })).map(({ _id, ...rest }: any) => rest);
}
export async function totals(db: Db, match: Filter<DailyStatDoc>): Promise<Totals> {
  const rows = await cols(db).dailyStats.aggregate<Totals>([{ $match: match }, { $group: { _id: null, ...SUM_FIELDS } }]).toArray();
  const r = rows[0] ?? ZERO;
  return { sent: r.sent ?? 0, opens: r.opens ?? 0, uniqueOpens: r.uniqueOpens ?? 0, replies: r.replies ?? 0, bounces: r.bounces ?? 0, ooo: r.ooo ?? 0, unsubscribes: r.unsubscribes ?? 0 };
}
export async function groupedTotals(db: Db, match: Filter<DailyStatDoc>, by: '$stepIndex' | '$accountId'): Promise<({ key: any } & Totals)[]> {
  const rows = await cols(db).dailyStats.aggregate<{ _id: any } & Totals>([{ $match: match }, { $group: { _id: by, ...SUM_FIELDS } }, { $sort: { _id: 1 } }]).toArray();
  return rows.map(({ _id, ...t }) => ({ key: _id, ...ZERO, ...t }));
}

/** Rebuilds dailyStats from events for every day ≥ fromDay. Used by the hourly verify job. */
export async function rebuildDailyStats(db: Db, from: Date): Promise<number> {
  const c = cols(db);
  const fromDay = dayKey(from);
  const rows = await c.events.aggregate<any>([
    { $match: { at: { $gte: new Date(fromDay + 'T00:00:00.000Z') } } },
    { $group: {
      _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$at' } }, campaignId: '$campaignId', stepIndex: '$stepIndex', accountId: '$accountId' },
      space: { $first: '$space' },
      sent: { $sum: { $cond: [{ $eq: ['$type', 'sent'] }, 1, 0] } },
      opens: { $sum: { $cond: [{ $eq: ['$type', 'open'] }, 1, 0] } },
      uniqueOpens: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'open'] }, { $eq: ['$meta.unique', true] }] }, 1, 0] } },
      replies: { $sum: { $cond: [{ $eq: ['$type', 'reply'] }, 1, 0] } },
      bounces: { $sum: { $cond: [{ $eq: ['$type', 'bounce'] }, 1, 0] } },
      ooo: { $sum: { $cond: [{ $eq: ['$type', 'ooo'] }, 1, 0] } },
      unsubscribes: { $sum: { $cond: [{ $eq: ['$type', 'unsubscribe'] }, 1, 0] } }
    } }
  ]).toArray();
  await c.dailyStats.deleteMany({ day: { $gte: fromDay } });
  if (rows.length) {
    await c.dailyStats.insertMany(rows.map((r) => ({
      day: r._id.day, campaignId: r._id.campaignId, stepIndex: r._id.stepIndex, accountId: r._id.accountId, space: r.space,
      sent: r.sent, opens: r.opens, uniqueOpens: r.uniqueOpens, replies: r.replies, bounces: r.bounces, ooo: r.ooo, unsubscribes: r.unsubscribes
    })) as never[]);
  }
  return rows.length;
}
