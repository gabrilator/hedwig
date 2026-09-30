import { withCampaignEdit, OperationError } from '$lib/server/operations';
import { error, fail } from '@sveltejs/kit';
import { ObjectId, type Filter } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, oid, plain, str } from '$lib/server/context';
import { applyLeadStatus, LEAD_STATUSES, STATUS_LABEL } from '$lib/server/campaigns';
import { deleteInbound, markThreadRead, sendManualReply } from '$lib/server/inbox';
import { classifyMessage, describeAgent, draftForMessage, effectiveAgent } from '$lib/server/agent';
import { sanitizeBody, sanitizeInboundHtml } from '$lib/server/sanitize';
import { classifierConfigured, geminiConfigured, jevConfigured } from '$lib/server/env';
import { AI_LABELS, type LeadDoc, type LeadStatus } from '$lib/server/types';
import type { Ctx } from '$lib/server/context';

const PAGE = 40;
const rx = (q: string) => ({ $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' });

/** Threads are leads that got at least one email back; everything the list needs sits on the lead. */
export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const status = url.searchParams.get('status') ?? '';
  const label = url.searchParams.get('label') ?? '';
  const campaignId = url.searchParams.get('campaign') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const base: Filter<LeadDoc> = { space: c.space.key, lastInboundAt: { $exists: true } };
  const filter: Filter<LeadDoc> = { ...base };
  if (status === 'unread') filter.inboundUnread = true;
  else if ((LEAD_STATUSES as string[]).includes(status)) filter.status = status as LeadStatus;
  if ((AI_LABELS as readonly string[]).includes(label)) filter['ai.label'] = label as never;
  if (campaignId && ObjectId.isValid(campaignId)) filter.campaignId = new ObjectId(campaignId);
  if (q) filter.$or = [{ email: rx(q) }, { 'vars.companyName': rx(q) }, { 'vars.company': rx(q) }, { 'lastInbound.subject': rx(q) }];

  const [total, threads, byStatus, byCampaign, byLabel, unread, campaigns] = await Promise.all([
    col.leads.countDocuments(filter),
    col.leads.find(filter, { sort: { lastInboundAt: -1 }, skip: (page - 1) * PAGE, limit: PAGE, projection: { email: 1, vars: 1, campaignId: 1, status: 1, ai: 1, lastInbound: 1, lastInboundAt: 1, inboundUnread: 1 } }).toArray(),
    col.leads.aggregate<{ _id: string; n: number }>([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    col.leads.aggregate<{ _id: ObjectId; n: number }>([{ $match: base }, { $group: { _id: '$campaignId', n: { $sum: 1 } } }]).toArray(),
    col.leads.aggregate<{ _id: string; n: number }>([{ $match: { ...base, 'ai.label': { $exists: true } } }, { $group: { _id: '$ai.label', n: { $sum: 1 } } }]).toArray(),
    col.leads.countDocuments({ space: c.space.key, inboundUnread: true }),
    col.campaigns.find({ space: c.space.key }, { projection: { name: 1, status: 1 }, sort: { createdAt: -1 } }).toArray()
  ]);
  const cpName = new Map(campaigns.map((x) => [x._id.toHexString(), x.name]));
  const counts = {
    all: byStatus.reduce((s, r) => s + r.n, 0), unread,
    status: Object.fromEntries(byStatus.map((r) => [r._id, r.n])) as Record<string, number>,
    label: Object.fromEntries(byLabel.map((r) => [r._id, r.n])) as Record<string, number>,
    campaign: Object.fromEntries(byCampaign.map((r) => [r._id.toHexString(), r.n])) as Record<string, number>
  };

  let thread: any = null;
  const threadParam = url.searchParams.get('thread');
  if (threadParam && ObjectId.isValid(threadParam)) {
    const lead = await col.leads.findOne({ _id: new ObjectId(threadParam), space: { $in: c.spaceKeys } });
    if (lead) {
      const [campaign, messages, sends] = await Promise.all([
        col.campaigns.findOne({ _id: lead.campaignId }), col.messages.find({ leadId: lead._id }, { sort: { at: 1 } }).toArray(),
        col.sends.find({ leadId: lead._id }, { projection: { opens: 1 } }).toArray()
      ]);
      const bySend = new Map(sends.map((s) => [s._id.toHexString(), s]));
      const mailbox = await replyMailbox(db, lead, campaign?.accountIds ?? []);
      const agent = campaign ? await effectiveAgent(db, campaign) : null;
      await markThreadRead(db, lead._id);
      const lastReply = [...messages].reverse().find((m) => m.direction === 'in' && m.kind === 'reply');
      thread = {
        lead: plain(lead), campaign: campaign ? { id: campaign._id.toHexString(), name: campaign.name, status: campaign.status } : null,
        mailbox: mailbox?.address ?? null,
        messages: plain(messages.map((m) => ({
          _id: m._id, direction: m.direction, kind: m.kind, from: m.from, to: m.to, subject: m.subject, text: m.text, at: m.at, status: m.status ?? null, error: m.error ?? null,
          opens: m.sendId ? bySend.get(m.sendId.toHexString())?.opens ?? [] : [],
          html: m.direction === 'in' && m.html ? sanitizeInboundHtml(m.html) : m.kind === 'manual' && m.html ? sanitizeBody(m.html) : null,
          ai: m.ai?.label ? { label: m.ai.label, confidence: m.ai.confidence ?? 0, reason: m.ai.reason ?? '', appliedStatus: m.ai.appliedStatus ?? null } : null
        }))),
        agent: agent ? { id: agent._id.toHexString(), name: agent.name, mode: agent.mode, active: agent.active, what: describeAgent(agent) } : { id: null, name: null, mode: null, active: false, what: describeAgent(null) },
        lastReply: lastReply ? { id: lastReply._id.toHexString(), ai: plain(lastReply.ai ?? null), draft: lastReply.ai?.draft ?? null } : null
      };
    }
  }
  return {
    threads: plain(threads.map((l) => ({ ...l, company: l.vars.companyName ?? l.vars.company ?? l.vars.organisation ?? l.vars.organization ?? '', campaignName: cpName.get(l.campaignId.toHexString()) ?? '?' }))),
    total, page, pages: Math.max(1, Math.ceil(total / PAGE)), status, label, campaignId, q, counts,
    campaigns: campaigns.map((x) => ({ id: x._id.toHexString(), name: x.name, status: x.status })),
    statuses: LEAD_STATUSES, statusLabels: STATUS_LABEL, labels: AI_LABELS, thread,
    canLabel: classifierConfigured(), canDraft: geminiConfigured(), labeller: jevConfigured() ? 'Jev' : 'Gemini'
  };
};

/** The mailbox a manual reply leaves from: the one that holds the thread, else the campaign's first active one. */
async function replyMailbox(db: Awaited<ReturnType<typeof getDb>>, lead: LeadDoc, campaignAccountIds: ObjectId[]) {
  const col = cols(db);
  if (lead.accountId) {
    const own = await col.emailAccounts.findOne({ _id: lead.accountId, status: 'active' });
    if (own) return own;
  }
  return col.emailAccounts.findOne({ _id: { $in: campaignAccountIds }, status: 'active' });
}

async function ownedLead(db: Awaited<ReturnType<typeof getDb>>, c: Ctx, id: string) {
  const lead = await cols(db).leads.findOne({ _id: oid(id), space: { $in: c.spaceKeys } });
  if (!lead) error(404, 'Thread not found');
  return lead;
}

export const actions: Actions = {
  status: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const status = str(fd, 'status') as LeadStatus;
    if (!(LEAD_STATUSES as string[]).includes(status)) return fail(400, { error: 'Unknown status' });
    const lead = await ownedLead(db, c, str(fd, 'lead'));
    if (['queued', 'contacted', 'opened'].includes(status)) {
      try { await withCampaignEdit(db, lead.campaignId, () => applyLeadStatus(db, lead, status, c.user.email, { byPerson: true })); }
      catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
    } else await applyLeadStatus(db, lead, status, c.user.email, { byPerson: true });
    return { note: `${lead.email} marked ${STATUS_LABEL[status].toLowerCase()}` };
  },
  deleteMessage: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const lead = await ownedLead(db, c, str(fd, 'lead'));
    const r = await deleteInbound(db, lead, oid(str(fd, 'message')));
    if (!r.deleted) return fail(404, { error: 'That message is already gone.' });
    return { note: 'Message removed from Hedwig. It stays in your mailbox.', threadGone: r.threadGone };
  },
  deleteThreads: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db);
    const ids = (await request.formData()).getAll('lead').map(String).filter((id) => ObjectId.isValid(id)).slice(0, 200);
    if (!ids.length) return fail(400, { error: 'Choose at least one thread.' });
    let n = 0;
    for (const lead of await col.leads.find({ _id: { $in: ids.map((id) => new ObjectId(id)) }, space: { $in: c.spaceKeys } }).toArray()) { await deleteInbound(db, lead); n++; }
    return { note: `${n} thread${n === 1 ? '' : 's'} removed from Hedwig. The emails stay in your mailbox.`, threadGone: true };
  },
  reply: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db); const fd = await request.formData();
    const lead = await ownedLead(db, c, str(fd, 'lead'));
    const nonce = str(fd, 'nonce');
    if (!/^[A-Za-z0-9-]{8,80}$/.test(nonce)) return fail(400, { error: 'Reload the page and try again.' });
    const campaign = await col.campaigns.findOne({ _id: lead.campaignId });
    if (!campaign) return fail(400, { error: 'The campaign of this thread is gone.' });
    const account = await replyMailbox(db, lead, campaign.accountIds);
    if (!account) return fail(400, { error: 'No active mailbox can answer this thread. Resume the mailbox on the Emails screen.' });
    const html = sanitizeBody(str(fd, 'body'));
    try {
      await sendManualReply(db, { lead, campaign, account, html, nonce, byUserId: c.user._id });
      return { sent: true, note: `Reply sent to ${lead.email} from ${account.address}` };
    } catch (e: any) { return fail(400, { error: e.message }); }
  },
  draft: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db);
    const lead = await ownedLead(db, c, str(await request.formData(), 'lead'));
    if (!geminiConfigured()) return fail(400, { error: 'Drafts need GEMINI_API_KEY on the server. Add it to the environment and restart.' });
    const last = await col.messages.findOne({ leadId: lead._id, direction: 'in', kind: 'reply' }, { sort: { at: -1 } });
    if (!last) return fail(400, { error: 'There is no reply to answer yet.' });
    const r = await draftForMessage(db, last._id);
    if (!r.ok) return fail(400, { error: r.error ?? r.skipped ?? 'The agent could not draft this one.' });
    return { note: r.draft ? 'Draft ready: read it, edit it, then send it yourself.' : `The agent labelled this ${r.label} and wrote no draft for it.` };
  },
  classify: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db);
    const lead = await ownedLead(db, c, str(await request.formData(), 'lead'));
    if (!classifierConfigured()) return fail(400, { error: 'No model key on the server: add TYPESAFE_API_KEY (Jev) or GEMINI_API_KEY to the environment and restart.' });
    const last = await col.messages.findOne({ leadId: lead._id, direction: 'in', kind: 'reply' }, { sort: { at: -1 } });
    if (!last) return fail(400, { error: 'There is no reply to classify.' });
    const r = await classifyMessage(db, last._id, { force: true });
    if (!r.ok) return fail(400, { error: r.error ?? r.skipped ?? 'The agent could not read this one.' });
    return { note: `Labelled ${r.label} (${Math.round((r.confidence ?? 0) * 100)}%)${lead.statusBy ? ' · the agent labels this lead again' : ''}` };
  }
};
