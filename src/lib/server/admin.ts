import type { Db } from 'mongodb';
import { cols } from './db';
import { adminEmails } from './env';
import { orgSpace, personalSpace } from './scope';
import { sendSystemMail } from './systemMail';
import type { SpaceKey, UserDoc } from './types';

const DAY = 864e5;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export interface AdminRow { id: string; email: string; name: string; joined: Date; lastLogin: Date | null; mailboxes: number; campaigns: number; active: number; sent30: number }

/**
 * Who signed up and what they did since: the one read across every space, for /admin only (ADMIN_EMAILS).
 * Bounded like any screen: the latest `limit` accounts, and per-space counts over their own spaces through indexed queries.
 */
export async function adminOverview(db: Db, now = new Date(), limit = 100) {
  const c = cols(db);
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  const [total, last24, last7, last30, users, byDay] = await Promise.all([
    c.users.estimatedDocumentCount(),
    c.users.countDocuments({ createdAt: { $gte: since(1) } }),
    c.users.countDocuments({ createdAt: { $gte: since(7) } }),
    c.users.countDocuments({ createdAt: { $gte: since(30) } }),
    c.users.find({}, { projection: { email: 1, name: 1, createdAt: 1, lastLoginAt: 1 } }).sort({ createdAt: -1 }).limit(limit).toArray(),
    c.users.aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: since(29) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } }
    ]).toArray()
  ]);

  // Each account's spaces: its personal one and every organisation it belongs to.
  const orgs = await c.orgs.find({ 'members.userId': { $in: users.map((u) => u._id) } }, { projection: { members: 1 } }).toArray();
  const spacesOf = new Map<string, SpaceKey[]>(users.map((u) => [u._id.toHexString(), [personalSpace(u._id)]]));
  for (const o of orgs) for (const m of o.members) spacesOf.get(m.userId.toHexString())?.push(orgSpace(o._id));
  const keys = [...new Set([...spacesOf.values()].flat())];

  const [boxes, camps, sent] = await Promise.all([
    c.emailAccounts.aggregate<{ _id: SpaceKey; n: number }>([{ $match: { space: { $in: keys } } }, { $group: { _id: '$space', n: { $sum: 1 } } }]).toArray(),
    c.campaigns.aggregate<{ _id: SpaceKey; n: number; active: number }>([
      { $match: { space: { $in: keys } } },
      { $group: { _id: '$space', n: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } }
    ]).toArray(),
    c.dailyStats.aggregate<{ _id: SpaceKey; n: number }>([
      { $match: { space: { $in: keys }, day: { $gte: dayOf(since(29)) } } },
      { $group: { _id: '$space', n: { $sum: '$sent' } } }
    ]).toArray()
  ]);
  const by = <T extends { _id: SpaceKey }>(rows: T[]) => new Map(rows.map((r) => [r._id, r]));
  const boxMap = by(boxes), campMap = by(camps), sentMap = by(sent);
  const sum = (spaces: SpaceKey[], pick: (k: SpaceKey) => number) => spaces.reduce((a, k) => a + pick(k), 0);

  const rows: AdminRow[] = users.map((u) => {
    const spaces = spacesOf.get(u._id.toHexString()) ?? [];
    return {
      id: u._id.toHexString(),
      email: u.email,
      name: u.name,
      joined: u.createdAt,
      lastLogin: u.lastLoginAt ?? null,
      mailboxes: sum(spaces, (k) => boxMap.get(k)?.n ?? 0),
      campaigns: sum(spaces, (k) => campMap.get(k)?.n ?? 0),
      active: sum(spaces, (k) => campMap.get(k)?.active ?? 0),
      sent30: sum(spaces, (k) => sentMap.get(k)?.n ?? 0)
    };
  });

  const counts = new Map(byDay.map((d) => [d._id, d.n]));
  const perDay = Array.from({ length: 30 }, (_, i) => { const day = dayOf(since(29 - i)); return { day, n: counts.get(day) ?? 0 }; });
  return { total, last24, last7, last30, perDay, rows };
}

/**
 * A note to each ADMIN_EMAILS address when someone signs up, through Hedwig's own system mail (Resend, or the admin's
 * first mailbox). Addresses with no account are skipped. Returns how many notes went out; a failed one never blocks a sign-up.
 */
export async function notifyAdminsOfSignup(db: Db, user: Pick<UserDoc, 'email' | 'name'>, origin: string): Promise<number> {
  const to = adminEmails().filter((e) => e !== user.email);
  if (!to.length) return 0;
  const c = cols(db);
  const [admins, total] = await Promise.all([c.users.find({ email: { $in: to } }, { projection: { email: 1 } }).toArray(), c.users.estimatedDocumentCount()]);
  let sent = 0;
  for (const a of admins) {
    try {
      const r = await sendSystemMail(db, personalSpace(a._id), {
        to: a.email,
        subject: `New sign-up: ${user.email}`,
        text: `${user.name} (${user.email}) just signed up on Hedwig.\n\nAccounts so far: ${total}.\nEveryone: ${origin}/admin\n`
      });
      if (r.sent) sent++;
    } catch { /* the sign-up already happened; the admin page still shows it */ }
  }
  return sent;
}
