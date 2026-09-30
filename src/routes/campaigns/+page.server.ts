import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, ownedCampaign, plain, str } from '$lib/server/context';
import { duplicateCampaign, newCampaign } from '$lib/server/campaigns';
import { groupedTotals } from '$lib/server/stats';
import { windowFor } from '$lib/server/planner';
import { isTimezone, timezoneOptions } from '$lib/server/timezones';
import { ensureDefaultAgent } from '$lib/server/agent';

export const load: PageServerLoad = async ({ locals }) => {
  const c = ctx(locals);
  const db = await getDb();
  const col = cols(db);
  const campaigns = await col.campaigns.find({ space: c.space.key }, { sort: { createdAt: -1 } }).toArray();
  const ids = campaigns.map((x) => x._id);
  const [leadRows, statRows, accounts, nextSend, agents, defaultAgent] = await Promise.all([
    col.leads.aggregate<{ _id: { c: ObjectId; s: string }; n: number }>([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } }]).toArray(),
    col.dailyStats.aggregate<{ _id: ObjectId; sent: number; uniqueOpens: number; replies: number; bounces: number }>([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: '$campaignId', sent: { $sum: '$sent' }, uniqueOpens: { $sum: '$uniqueOpens' }, replies: { $sum: '$replies' }, bounces: { $sum: '$bounces' } } }]).toArray(),
    col.emailAccounts.find({ space: c.space.key }, { projection: { address: 1, status: 1 } }).toArray(),
    col.sends.findOne({ space: c.space.key, status: 'planned' }, { sort: { dueAt: 1 } }),
    col.agents.find({ space: { $in: c.spaceKeys } }, { projection: { name: 1, active: 1, mode: 1 } }).toArray(),
    ensureDefaultAgent(db, c.space.key, c.user._id)
  ]);
  const agentById = new Map(agents.map((a) => [a._id.toHexString(), a]));
  const since24h = new Date(Date.now() - 864e5);
  // opens are counted once per email here, like the Opened column: a second pixel hit on the same email is not a second open
  const last24 = await col.events.aggregate<{ _id: string; n: number }>([{ $match: { space: c.space.key, at: { $gte: since24h } } }, { $group: { _id: '$type', n: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'open'] }, { $ne: ['$meta.unique', true] }] }, 0, 1] } } } }]).toArray();
  const today = Object.fromEntries(last24.map((r) => [r._id, r.n]));
  const accName = new Map(accounts.map((a) => [a._id.toHexString(), a.address]));
  const now = new Date();
  const rows = campaigns.map((cp) => {
    const leads: Record<string, number> = {};
    let total = 0;
    for (const r of leadRows) if (r._id.c.equals(cp._id)) { leads[r._id.s] = r.n; total += r.n; }
    const st = statRows.find((r) => r._id.equals(cp._id));
    const done = total - (leads.queued ?? 0);
    let windowNote = '';
    if (cp.status === 'active') { try { const w = windowFor(cp.schedule, now); windowNote = w.open ? 'window open' : (w.reason ?? ''); } catch { windowNote = 'bad timezone'; } }
    const agent = cp.agentOff ? null : (cp.agentId && agentById.get(cp.agentId.toHexString())) || defaultAgent;
    return {
      id: cp._id.toHexString(), name: cp.name, status: cp.status, steps: cp.steps.length, createdAt: cp.createdAt, startedAt: cp.startedAt ?? null,
      agent: agent ? { name: agent.name, on: !!agent.active } : null,
      leads: total, contacted: done, progress: total ? Math.round((done / total) * 100) : 0,
      sent: st?.sent ?? 0, opens: st?.uniqueOpens ?? 0, replies: st?.replies ?? 0, bounces: st?.bounces ?? 0,
      opps: (leads.interested ?? 0) + (leads.meeting ?? 0) + (leads.won ?? 0),
      accounts: cp.accountIds.map((id) => accName.get(id.toHexString()) ?? '?'), windowNote, timezone: cp.schedule.timezone
    };
  });
  return {
    campaigns: plain(rows),
    timezones: timezoneOptions(),
    ticker: {
      sent24: today.sent ?? 0, opens24: today.open ?? 0, replies24: today.reply ?? 0,
      nextSend: nextSend ? { at: nextSend.dueAt.toISOString(), account: accName.get(nextSend.accountId.toHexString()) ?? '' } : null,
      activeWindows: rows.filter((r) => r.status === 'active').map((r) => `${r.name}: ${r.windowNote}`),
      accounts: accounts.length
    }
  };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const c = ctx(locals);
    const fd = await request.formData();
    const name = str(fd, 'name');
    if (!name) return fail(400, { error: 'Give the campaign a name.' });
    const timezone = str(fd, 'timezone');
    if (!isTimezone(timezone)) return fail(400, { error: 'Pick the timezone the sending window should follow.' });
    const db = await getDb();
    const doc = newCampaign(c.space.key, c.user._id, name, c.user.email, timezone);
    const r = await cols(db).campaigns.insertOne({ _id: new ObjectId(), ...doc });
    redirect(303, `/campaigns/${r.insertedId.toHexString()}/leads/import`);
  },
  /** Same steps, schedule, mailboxes and options; no leads; a draft. */
  duplicate: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, str(await request.formData(), 'id'));
    const id = await duplicateCampaign(db, campaign, c.user._id);
    redirect(303, `/campaigns/${id.toHexString()}/leads`);
  }
};
