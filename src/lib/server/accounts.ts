import { DateTime } from 'luxon';
import type { Db, ObjectId } from 'mongodb';
import { cols } from './db';
import { totals } from './stats';
import type { EmailAccountDoc } from './types';

export const RAMP_START = 10;
export const RAMP_STEP = 5;

/** New mailboxes start at 10 a day and gain 5 a week until they reach their limit. */
export function effectiveDailyLimit(acc: Pick<EmailAccountDoc, 'dailyLimit' | 'ramp'>, now: Date): number {
  if (!acc.ramp?.enabled) return acc.dailyLimit;
  const weeks = Math.max(0, Math.floor((now.getTime() - new Date(acc.ramp.startedAt).getTime()) / (7 * 864e5)));
  return Math.max(1, Math.min(acc.dailyLimit, RAMP_START + RAMP_STEP * weeks));
}

/** Sends over the last 24 hours: the bounce-rate denominator, not the limit. */
export async function sentLast24h(db: Db, accountId: ObjectId, now: Date): Promise<number> {
  return cols(db).sends.countDocuments({ accountId, status: 'sent', sentAt: { $gte: new Date(now.getTime() - 864e5) } });
}
/** The zone whose midnight resets this mailbox's day: its own, else the campaign being planned, else UTC. */
export function mailboxZone(acc: Pick<EmailAccountDoc, 'timezone'>, fallbackZone?: string): string {
  for (const z of [acc.timezone, fallbackZone]) if (z && DateTime.now().setZone(z).isValid) return z;
  return 'UTC';
}
/** Midnight of the mailbox's current day. */
export function dayStartFor(acc: Pick<EmailAccountDoc, 'timezone'>, now: Date, fallbackZone?: string): Date {
  return DateTime.fromJSDate(now, { zone: mailboxZone(acc, fallbackZone) }).startOf('day').toJSDate();
}
/** Sends since the mailbox's midnight: what the daily limit counts. */
export async function sentToday(db: Db, accountId: ObjectId, dayStart: Date): Promise<number> {
  return cols(db).sends.countDocuments({ accountId, status: 'sent', sentAt: { $gte: dayStart } });
}
export async function pendingPlanned(db: Db, accountId: ObjectId): Promise<number> {
  return cols(db).sends.countDocuments({ accountId, status: { $in: ['planned', 'claimed'] } });
}
/**
 * How many more emails this mailbox may take on right now: its daily limit, minus what left since its midnight, minus
 * what is already booked. One count for all campaigns that share the mailbox.
 */
export async function accountCapacity(db: Db, acc: EmailAccountDoc, now: Date, fallbackZone?: string): Promise<{ capacity: number; limit: number; sentToday: number; pending: number; dayStart: Date; zone: string }> {
  const limit = effectiveDailyLimit(acc, now);
  const zone = mailboxZone(acc, fallbackZone);
  const dayStart = dayStartFor(acc, now, fallbackZone);
  const [sent, pending] = await Promise.all([sentToday(db, acc._id, dayStart), pendingPlanned(db, acc._id)]);
  return { capacity: Math.max(0, limit - sent - pending), limit, sentToday: sent, pending, dayStart, zone };
}
/** Mailboxes with no day of their own get the zone of the first campaign that uses them (active first). Idempotent. */
export async function assignMailboxZones(db: Db): Promise<number> {
  const c = cols(db);
  const orphans = await c.emailAccounts.find({ timezone: { $exists: false } }, { projection: { _id: 1 } }).toArray();
  let n = 0;
  for (const a of orphans) {
    const cp = await c.campaigns.findOne({ accountIds: a._id }, { sort: { status: 1, createdAt: 1 }, projection: { schedule: 1 } });
    const zone = cp?.schedule.timezone;
    if (!zone || !DateTime.now().setZone(zone).isValid) continue;
    const r = await c.emailAccounts.updateOne({ _id: a._id, timezone: { $exists: false } }, { $set: { timezone: zone } });
    n += r.modifiedCount;
  }
  return n;
}

/** Bounce and reply rates of one mailbox over the last `days` days (7 by default), from dailyStats. */
export async function accountRates(db: Db, accountId: ObjectId, now: Date, days = 7) {
  const from = new Date(now.getTime() - (days - 1) * 864e5);
  const t = await totals(db, { accountId, day: { $gte: from.toISOString().slice(0, 10) } });
  const rate = (n: number) => (t.sent ? n / t.sent : null);
  return { ...t, bounceRate: rate(t.bounces), replyRate: rate(t.replies) };
}
export const accountRates7d = (db: Db, accountId: ObjectId, now: Date) => accountRates(db, accountId, now, 7);

export function domainOf(address: string): string { return address.split('@')[1]?.toLowerCase() ?? ''; }

export const DEFAULT_BOUNCE_PAUSE_PCT = 5;
export const BOUNCE_MIN_SENT = 20;
export const BOUNCE_MIN_COUNT = 2;
/**
 * The reason to pause a mailbox after a bounce, or null. Judged over the last 7 days: at least 20 sends and 2 bounces
 * (one bounce is never a pattern), and bounces at or above the mailbox's percentage (5 by default, 0 switches it off).
 */
export function selfPauseReason(acc: Pick<EmailAccountDoc, 'bouncePausePct'>, sent: number, bounces: number): string | null {
  const pct = acc.bouncePausePct ?? DEFAULT_BOUNCE_PAUSE_PCT;
  if (pct <= 0 || sent < BOUNCE_MIN_SENT || bounces < BOUNCE_MIN_COUNT) return null;
  const rate = bounces / sent;
  if (rate < pct / 100) return null;
  return `Paused itself: ${bounces} bounces on ${sent} sends in the last 7 days (${Math.round(rate * 100)}%, the limit is ${pct}%). Check the list, then resume.`;
}
