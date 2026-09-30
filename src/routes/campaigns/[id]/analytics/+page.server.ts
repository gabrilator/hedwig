import type { PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, ownedCampaign, plain } from '$lib/server/context';
import { groupedTotals, series, totals } from '$lib/server/stats';
import { accountCapacity } from '$lib/server/accounts';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const c = ctx(locals);
  const db = await getDb();
  const campaign = await ownedCampaign(db, c, params.id);
  const days = Number(url.searchParams.get('days') ?? 0) || 0;
  const now = new Date();
  const start = days ? new Date(now.getTime() - (days - 1) * 864e5) : new Date(Math.min((campaign.startedAt ?? campaign.createdAt).getTime(), now.getTime() - 6 * 864e5));
  const match = { campaignId: campaign._id, ...(days ? { day: { $gte: start.toISOString().slice(0, 10), $lte: now.toISOString().slice(0, 10) } } : {}) };
  const [pts, tot, byStep, byAcc] = await Promise.all([series(db, match, start, now), totals(db, match), groupedTotals(db, match, '$stepIndex'), groupedTotals(db, match, '$accountId')]);
  const accounts = await cols(db).emailAccounts.find({ _id: { $in: campaign.accountIds } }).toArray();
  const accRows = await Promise.all(accounts.map(async (a) => {
    const t = byAcc.find((r) => String(r.key) === a._id.toHexString());
    const cap = await accountCapacity(db, a, now, campaign.schedule.timezone);
    return { address: a.address, status: a.status, sentToday: cap.sentToday, limit: cap.limit, sent: t?.sent ?? 0, replies: t?.replies ?? 0, bounces: t?.bounces ?? 0, uniqueOpens: t?.uniqueOpens ?? 0 };
  }));
  return { points: pts, totals: tot, byStep: plain(byStep), byAccount: accRows, days };
};
