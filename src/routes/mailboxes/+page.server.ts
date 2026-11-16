import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { bool, ctx, num, ownedAccount, plain, str } from '$lib/server/context';
import { accountCapacity, accountRates7d, DEFAULT_BOUNCE_PAUSE_PCT, domainOf } from '$lib/server/accounts';
import { enqueue, workerStatus } from '$lib/server/jobs';
import { microsoftConfigured } from '$lib/server/env';
import { isTimezone, timezoneOptions } from '$lib/server/timezones';
import { providerFor } from '$lib/server/mail/provider';

export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const now = new Date();
  const accounts = await col.emailAccounts.find({ space: c.space.key }, { sort: { createdAt: 1 } }).toArray();
  const usage = await col.campaigns.aggregate<{ _id: any; n: number; names: string[] }>([{ $match: { space: c.space.key, status: { $in: ['active', 'paused', 'draft'] } } }, { $unwind: '$accountIds' }, { $group: { _id: '$accountIds', n: { $sum: 1 }, names: { $push: '$name' } } }]).toArray();
  const rows = await Promise.all(accounts.map(async (a) => {
    const [cap, r7] = await Promise.all([accountCapacity(db, a, now), accountRates7d(db, a._id, now)]);
    const u = usage.find((x) => String(x._id) === a._id.toHexString());
    return {
      id: a._id.toHexString(), address: a.address, fromName: a.fromName, kind: a.kind, status: a.status, pausedReason: a.pausedReason ?? null, domain: domainOf(a.address),
      dailyLimit: a.dailyLimit, ramp: a.ramp, limit: cap.limit, sentToday: cap.sentToday, pending: cap.pending, timezone: a.timezone ?? '', zone: cap.zone, bouncePausePct: a.bouncePausePct ?? DEFAULT_BOUNCE_PAUSE_PCT, bounceRate7d: r7.bounceRate, replyRate7d: r7.replyRate, sent7d: r7.sent,
      dns: a.dns ?? null, lastSync: a.sync?.lastSyncAt ?? null, lastError: a.sync?.lastError ?? null, campaigns: u?.n ?? 0, campaignNames: u?.names ?? [], host: a.smtp?.host ?? 'Microsoft Graph'
    };
  }));
  const status = await workerStatus(db);
  return { accounts: plain(rows), timezones: timezoneOptions(), msConfigured: microsoftConfigured(), connected: url.searchParams.get('connected'), msError: url.searchParams.get('error'), worker: plain({ stale: status.stale, ageSec: status.ageSec, runs: status.runs.slice(0, 12), jobs: status.jobs }) };
};

export const actions: Actions = {
  pause: async ({ request, locals }) => { const c = ctx(locals); const db = await getDb(); const a = await ownedAccount(db, c, str(await request.formData(), 'id')); await cols(db).emailAccounts.updateOne({ _id: a._id }, { $set: { status: 'paused', pausedReason: 'Paused by you' } }); return { ok: true }; },
  resume: async ({ request, locals }) => { const c = ctx(locals); const db = await getDb(); const a = await ownedAccount(db, c, str(await request.formData(), 'id')); await cols(db).emailAccounts.updateOne({ _id: a._id }, { $set: { status: 'active' }, $unset: { pausedReason: '' } }); return { ok: true }; },
  sync: async ({ request, locals }) => { const c = ctx(locals); const db = await getDb(); const a = await ownedAccount(db, c, str(await request.formData(), 'id')); await enqueue(db, 'sync-account', { accountId: a._id.toHexString() }); return { ok: true, note: `Sync of ${a.address} queued` }; },
  dns: async ({ request, locals }) => { const c = ctx(locals); const db = await getDb(); const a = await ownedAccount(db, c, str(await request.formData(), 'id')); await enqueue(db, 'dns-check', { accountId: a._id.toHexString() }); return { ok: true, note: `DNS check of ${a.address} queued` }; },
  test: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const a = await ownedAccount(db, c, str(await request.formData(), 'id'));
    const r = await providerFor(db, a).test();
    return r.ok ? { ok: true, note: `${a.address}: ${r.detail}` } : fail(400, { error: `${a.address}: ${r.detail}` });
  },
  limit: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData(); const a = await ownedAccount(db, c, str(fd, 'id'));
    const dailyLimit = Math.max(1, Math.min(500, num(fd, 'dailyLimit', a.dailyLimit)));
    const rampEnabled = bool(fd, 'ramp');
    const timezone = str(fd, 'timezone');
    if (timezone && !isTimezone(timezone)) return fail(400, { error: `"${timezone}" is not a timezone the scheduler knows.` });
    const bouncePausePct = Math.max(0, Math.min(100, num(fd, 'bouncePausePct', a.bouncePausePct ?? DEFAULT_BOUNCE_PAUSE_PCT)));
    await cols(db).emailAccounts.updateOne({ _id: a._id }, { $set: { dailyLimit, fromName: str(fd, 'fromName') || a.fromName, 'ramp.enabled': rampEnabled, bouncePausePct, ...(timezone ? { timezone } : {}) } });
    return { ok: true, note: 'Mailbox settings saved' };
  },
  delete: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const a = await ownedAccount(db, c, str(await request.formData(), 'id'));
    const inUse = await cols(db).campaigns.countDocuments({ accountIds: a._id, status: { $in: ['active', 'paused'] } });
    if (inUse) return fail(400, { error: `${a.address} is used by ${inUse} active or paused campaign(s). Remove it from them first.` });
    await cols(db).campaigns.updateMany({ accountIds: a._id }, { $pull: { accountIds: a._id } });
    await cols(db).emailAccounts.deleteOne({ _id: a._id });
    return { ok: true, note: `${a.address} removed` };
  }
};
