import type { PageServerLoad } from './$types';
import { ObjectId } from 'mongodb';
import { cols, getDb } from '$lib/server/db';
import { ctx, plain } from '$lib/server/context';
import { groupedTotals, series, totals } from '$lib/server/stats';
import { accountCapacity, accountRates, domainOf } from '$lib/server/accounts';

export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const days = Math.min(365, Number(url.searchParams.get('days') ?? 28) || 28);
  const campaignId = url.searchParams.get('campaign') ?? '';
  const accountId = url.searchParams.get('account') ?? '';
  const mbRaw = Number(url.searchParams.get('mb') ?? 7);
  const mb = [7, 14, 28].includes(mbRaw) ? mbRaw : 7; // window of the deliverability-by-mailbox rates
  const now = new Date();
  const from = new Date(now.getTime() - (days - 1) * 864e5);
  const match: Record<string, unknown> = { space: c.space.key };
  if (campaignId && ObjectId.isValid(campaignId)) match.campaignId = new ObjectId(campaignId);
  if (accountId && ObjectId.isValid(accountId)) match.accountId = new ObjectId(accountId);
  const [pts, tot, campaigns, accounts] = await Promise.all([
    series(db, match, from, now), totals(db, { ...match, day: { $gte: from.toISOString().slice(0, 10) } }),
    col.campaigns.find({ space: c.space.key }, { projection: { name: 1, status: 1 } }).toArray(),
    col.emailAccounts.find({ space: c.space.key }).toArray()
  ]);
  const leadAgg = await col.leads.aggregate<{ _id: string; n: number }>([{ $match: { space: c.space.key, ...(match.campaignId ? { campaignId: match.campaignId } : {}) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  const leads = Object.fromEntries(leadAgg.map((r) => [r._id, r.n]));
  const byAcc = await groupedTotals(db, { ...match, day: { $gte: from.toISOString().slice(0, 10) } }, '$accountId');
  const accountRows = await Promise.all(accounts.map(async (a) => {
    const t = byAcc.find((r) => String(r.key) === a._id.toHexString());
    const [cap, r] = await Promise.all([accountCapacity(db, a, now), accountRates(db, a._id, now, mb)]);
    return { id: a._id.toHexString(), address: a.address, status: a.status, domain: domainOf(a.address), dns: a.dns ?? null, sentToday: cap.sentToday, limit: cap.limit, sent: t?.sent ?? 0, replies: t?.replies ?? 0, bounces: t?.bounces ?? 0, sentWindow: r.sent, bounceRate: r.bounceRate, replyRate: r.replyRate, lastSync: a.sync?.lastSyncAt ?? null, lastError: a.sync?.lastError ?? null };
  }));
  const kinds = await col.messages.aggregate<{ _id: string; n: number }>([{ $match: { space: c.space.key, direction: 'in', at: { $gte: from } } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]).toArray();
  return { points: pts, totals: tot, days, mb, campaignId, accountId, campaigns: plain(campaigns), accounts: plain(accountRows), leads, opps: (leads.interested ?? 0) + (leads.meeting ?? 0) + (leads.won ?? 0), kinds: Object.fromEntries(kinds.map((k) => [k._id, k.n])) };
};
