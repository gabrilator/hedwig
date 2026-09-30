import { withCampaignEdit, OperationError } from '$lib/server/operations';
import { guardCampaignActions } from '$lib/server/webCampaignActions';
import { fail } from '@sveltejs/kit';
import type { Filter } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, oid, ownedCampaign, plain, str } from '$lib/server/context';
import { applyLeadStatus, LEAD_STATUSES, STATUS_LABEL } from '$lib/server/campaigns';
import { cancelPending } from '$lib/server/inbox';
import { setCurious } from '$lib/server/curious';
import type { LeadDoc, LeadStatus } from '$lib/server/types';

const PAGE = 50;

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const c = ctx(locals);
  const db = await getDb();
  const col = cols(db);
  const campaign = await ownedCampaign(db, c, params.id);
  const status = url.searchParams.get('status') ?? '';
  const curious = url.searchParams.get('curious') === '1';
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const filter: Filter<LeadDoc> = { campaignId: campaign._id };
  if (status && (LEAD_STATUSES as string[]).includes(status)) filter.status = status as LeadStatus;
  if (curious) filter.curious = true;
  if (q) filter.$or = [{ email: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { 'vars.companyName': { $regex: q, $options: 'i' } }, { 'vars.company': { $regex: q, $options: 'i' } }];
  const [total, leads, curiousCount] = await Promise.all([col.leads.countDocuments(filter), col.leads.find(filter, { sort: { lastEventAt: -1, createdAt: -1 }, skip: (page - 1) * PAGE, limit: PAGE }).toArray(), col.leads.countDocuments({ campaignId: campaign._id, curious: true })]);
  const accounts = await col.emailAccounts.find({ _id: { $in: campaign.accountIds } }, { projection: { address: 1 } }).toArray();
  const accName = new Map(accounts.map((a) => [a._id.toHexString(), a.address]));
  const leadParam = url.searchParams.get('lead');
  let drawer: any = null;
  if (leadParam) {
    const lead = await col.leads.findOne({ _id: oid(leadParam), campaignId: campaign._id });
    if (lead) {
      const [messages, sends] = await Promise.all([
        col.messages.find({ leadId: lead._id }, { sort: { at: 1 } }).toArray(),
        col.sends.find({ leadId: lead._id }, { projection: { stepIndex: 1, status: 1, dueAt: 1, accountId: 1, opens: 1, openCount: 1 } }).toArray()
      ]);
      const pending = sends.filter((s) => s.status === 'planned' || s.status === 'claimed').sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
      const bySend = new Map(sends.map((s) => [s._id.toHexString(), s]));
      drawer = {
        lead: plain(lead),
        messages: plain(messages.map((m) => ({ ...m, opens: m.sendId ? bySend.get(m.sendId.toHexString())?.opens ?? [] : [] }))),
        pending: pending ? { dueAt: pending.dueAt, stepIndex: pending.stepIndex, account: accName.get(pending.accountId.toHexString()) } : null, account: lead.accountId ? accName.get(lead.accountId.toHexString()) : null
      };
    }
  }
  // overview of the uploaded list
  const [byProvider, topDomains, withFirst, sample] = await Promise.all([
    col.leads.aggregate<{ _id: string; n: number }>([{ $match: { campaignId: campaign._id } }, { $group: { _id: '$provider', n: { $sum: 1 } } }]).toArray(),
    col.leads.aggregate<{ _id: string; n: number }>([{ $match: { campaignId: campaign._id } }, { $group: { _id: '$domain', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 6 }]).toArray(),
    col.leads.countDocuments({ campaignId: campaign._id, 'vars.firstName': { $exists: true, $ne: '' } }),
    col.leads.find({ campaignId: campaign._id }, { projection: { vars: 1 }, limit: 500 }).toArray()
  ]);
  const varCounts = new Map<string, number>();
  for (const l of sample) for (const k of Object.keys(l.vars)) varCounts.set(k, (varCounts.get(k) ?? 0) + 1);
  const overview = {
    providers: Object.fromEntries(byProvider.map((r) => [r._id, r.n])),
    topDomains: topDomains.map((r) => ({ domain: r._id, n: r.n })),
    withFirstName: withFirst,
    variables: [...varCounts.entries()].map(([k, n]) => ({ key: k, pct: sample.length ? Math.round((n / sample.length) * 100) : 0 })).sort((a, b) => b.pct - a.pct),
    sampled: sample.length
  };
  return {
    overview,
    leads: plain(leads.map((l) => ({ ...l, company: l.vars.companyName ?? l.vars.company ?? l.vars.organisation ?? l.vars.organization ?? '', account: l.accountId ? accName.get(l.accountId.toHexString()) : null }))),
    total, page, pages: Math.max(1, Math.ceil(total / PAGE)), status, curious, curiousCount, q, drawer, statuses: LEAD_STATUSES, labels: STATUS_LABEL, imported: url.searchParams.get('imported')
  };
};

const rawActions: Actions = {
  status: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const status = str(fd, 'status') as LeadStatus;
    if (!(LEAD_STATUSES as string[]).includes(status)) return fail(400, { error: 'Unknown status' });
    const lead = await cols(db).leads.findOne({ _id: oid(str(fd, 'lead')), campaignId: campaign._id });
    if (!lead) return fail(404, { error: 'Lead not found' });
    if (['queued', 'contacted', 'opened'].includes(status)) {
      try { await withCampaignEdit(db, campaign._id, () => applyLeadStatus(db, lead, status, c.user.email, { byPerson: true })); }
      catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
    } else await applyLeadStatus(db, lead, status, c.user.email, { byPerson: true });
    return { ok: true };
  },
  /** A person sets or resets the curious flag; the daily check leaves this lead alone from then on. */
  curious: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    if (!await setCurious(db, oid(str(fd, 'lead')), campaign._id, str(fd, 'on') === '1', c.user.email)) return fail(404, { error: 'Lead not found' });
    return { ok: true };
  },
  remove: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const leadId = oid(str(await request.formData(), 'lead'));
    if (!await cols(db).leads.findOne({ _id: leadId, campaignId: campaign._id })) return fail(404, { error: 'Lead not found' });
    await cancelPending(db, leadId, 'removed from campaign');
    await cols(db).leads.deleteOne({ _id: leadId, campaignId: campaign._id });
    return { ok: true, removed: true };
  },
  requeue: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const leadId = oid(str(await request.formData(), 'lead'));
    await cols(db).leads.updateOne({ _id: leadId, campaignId: campaign._id, status: 'paused' }, { $set: { status: 'contacted', nextDueAt: new Date() } });
    return { ok: true };
  }
};

export const actions = guardCampaignActions(rawActions, ["remove", "requeue"]);
