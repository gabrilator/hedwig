import { guardCampaignActions } from '$lib/server/webCampaignActions';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, list, num, ownedCampaign, plain, str } from '$lib/server/context';
import { nextOpen, windowFor } from '$lib/server/planner';
import { isTimezone, timezoneOptions } from '$lib/server/timezones';

export const load: PageServerLoad = async ({ locals, params }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const campaign = await ownedCampaign(db, c, params.id);
  const now = new Date();
  let w: any = null, next: Date | null = null, tzError = '';
  try { w = windowFor(campaign.schedule, now); next = nextOpen(campaign.schedule, now); } catch (e: any) { tzError = e.message; }
  const dayStart = w?.dayStart ?? new Date(now.getTime() - 12 * 3600e3), dayEnd = w?.dayEnd ?? new Date(now.getTime() + 12 * 3600e3);
  const sends = await col.sends.find({ campaignId: campaign._id, dueAt: { $gte: dayStart, $lte: dayEnd } }, { sort: { dueAt: 1 } }).toArray();
  const leadIds = sends.map((s) => s.leadId);
  const [leads, accounts] = await Promise.all([
    col.leads.find({ _id: { $in: leadIds } }, { projection: { email: 1, vars: 1 } }).toArray(),
    col.emailAccounts.find({ _id: { $in: campaign.accountIds } }, { projection: { address: 1 } }).toArray()
  ]);
  const leadName = new Map(leads.map((l) => [l._id.toHexString(), l.vars.companyName ?? l.vars.company ?? l.email]));
  const accName = new Map(accounts.map((a) => [a._id.toHexString(), a.address]));
  return {
    window: w ? { open: w.open, reason: w.reason, start: w.start, end: w.end, localDay: w.localDay } : null, next, tzError, timezones: timezoneOptions(),
    plan: plain(sends.map((s) => ({ dueAt: s.dueAt, status: s.status, stepIndex: s.stepIndex, lead: leadName.get(s.leadId.toHexString()) ?? '?', account: accName.get(s.accountId.toHexString()) ?? '?' }))),
    now
  };
};

const rawActions: Actions = {
  save: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const timezone = str(fd, 'timezone');
    if (!isTimezone(timezone)) return fail(400, { error: `"${timezone}" is not a timezone the scheduler knows. Pick one from the list.` });
    const from = str(fd, 'from'), to = str(fd, 'to');
    if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to) || from >= to) return fail(400, { error: 'The window needs a start before its end, as HH:MM.' });
    const days = list(fd, 'days').map(Number).filter((d) => d >= 0 && d <= 6);
    if (!days.length) return fail(400, { error: 'Pick at least one day.' });
    const startAt = str(fd, 'startAt') ? new Date(str(fd, 'startAt')) : null;
    const endAt = str(fd, 'endAt') ? new Date(str(fd, 'endAt')) : null;
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: { schedule: { timezone, from, to, days, startAt, endAt }, dailyLimit: Math.max(1, num(fd, 'dailyLimit', campaign.dailyLimit)), updatedAt: new Date() } });
    return { saved: true };
  }
};

export const actions = guardCampaignActions(rawActions, ["save"]);
