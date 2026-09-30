import { withWorkspaceEdit, OperationError } from './operations';
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { accountRates, selfPauseReason } from './accounts';
import { providerFor } from './mail/provider';
import type { InboundFull, InboundItem } from './mail/types';
import { escapeHtml, htmlToText, wrapEmailHtml } from './render';
import { recordEvent } from './stats';
import type { CampaignDoc, EmailAccountDoc, LeadDoc, MessageDoc } from './types';

const BOUNCE_FROM = /^(postmaster|mailer-daemon|mail-daemon|no-?reply@.*(microsoftexchange|outlook)|microsoftexchange)/i;
const BOUNCE_SUBJECT = /^(undeliverable|undelivered mail|delivery status notification|delivery has failed|delivery failure|mail delivery failed|returned mail|failure notice|no se (ha podido|pudo) entregar|entrega no realizada|message not delivered)/i;
const OOO_SUBJECT = /(automatic reply|auto(?:matic)?[- ]?reply|autoreply|out of (the )?office|fuera de la oficina|respuesta autom[aá]tica|ausen(te|cia)|vacaciones|estar[eé] fuera)/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function looksLikeBounce(item: Pick<InboundItem, 'from' | 'subject'>): boolean {
  return BOUNCE_FROM.test(item.from) || BOUNCE_SUBJECT.test(item.subject ?? '');
}
export function isAutoReply(full: Pick<InboundFull, 'autoSubmitted' | 'headers' | 'subject'>): boolean {
  const auto = (full.autoSubmitted ?? '').toLowerCase();
  if (auto && auto !== 'no') return true;
  const h = full.headers ?? {};
  if (h['x-auto-response-suppress'] || h['x-autoreply'] || h['x-autorespond']) return true;
  if (/^(auto_reply|auto-reply|junk)$/i.test(h['precedence'] ?? '')) return true;
  return OOO_SUBJECT.test(full.subject ?? '');
}

export interface Match { lead: LeadDoc; via: 'conversation' | 'headers' | 'address' }

export async function matchItem(db: Db, account: EmailAccountDoc, item: InboundItem): Promise<Match | null> {
  const c = cols(db);
  if (!item.from || item.from === account.address.toLowerCase()) return null;
  if (item.conversationId) {
    const lead = await c.leads.findOne({ accountId: account._id, 'thread.conversationId': item.conversationId });
    if (lead) return { lead, via: 'conversation' };
  }
  const ids = [item.inReplyTo, ...(item.references ?? [])].filter(Boolean) as string[];
  if (ids.length) {
    const lead = await c.leads.findOne({ accountId: account._id, $or: [{ 'thread.internetMessageId': { $in: ids } }, { 'thread.firstInternetMessageId': { $in: ids } }] });
    if (lead) return { lead, via: 'headers' };
    const msg = await c.messages.findOne({ accountId: account._id, direction: 'out', internetMessageId: { $in: ids } });
    if (msg?.leadId) { const l = await c.leads.findOne({ _id: msg.leadId }); if (l) return { lead: l, via: 'headers' }; }
  }
  const byAddress = await c.leads.findOne(
    { accountId: account._id, email: item.from, status: { $in: ['contacted', 'opened', 'replied', 'interested', 'meeting', 'won', 'not_interested'] } },
    { sort: { lastEventAt: -1 } }
  );
  if (byAddress) return { lead: byAddress, via: 'address' };
  return null;
}

export async function bouncedLead(db: Db, account: EmailAccountDoc, full: InboundFull): Promise<LeadDoc | null> {
  const c = cols(db);
  const candidates = new Set((full.text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()).filter((e) => e !== account.address.toLowerCase()));
  if (candidates.size) {
    const lead = await c.leads.findOne({ accountId: account._id, email: { $in: [...candidates] }, status: { $ne: 'bounced' } }, { sort: { lastEventAt: -1 } });
    if (lead) return lead;
  }
  if (full.conversationId) return c.leads.findOne({ accountId: account._id, 'thread.conversationId': full.conversationId });
  return null;
}

export async function cancelPending(db: Db, leadId: LeadDoc['_id'], reason: string): Promise<number> {
  const r = await cols(db).sends.updateMany({ leadId, status: { $in: ['planned', 'claimed'] } }, { $set: { status: 'cancelled', reason } });
  return r.modifiedCount;
}

/** One line of a message for the thread list. */
export const snippetOf = (text: string, n = 160): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Stores the inbound message and puts its summary on the lead, so the Inbox lists threads from `leads` alone.
 * A reply is born `ai.status: pending`: the agent will look at it once.
 */
async function storeInbound(db: Db, account: EmailAccountDoc, lead: LeadDoc, kind: 'reply' | 'bounce' | 'ooo', full: InboundFull): Promise<ObjectId> {
  const c = cols(db);
  const at = full.receivedAt ?? new Date();
  const _id = new ObjectId();
  await c.messages.insertOne({
    _id, space: lead.space, campaignId: lead.campaignId, leadId: lead._id, accountId: account._id, direction: 'in', kind,
    internetMessageId: full.internetMessageId, inReplyTo: full.inReplyTo, conversationId: full.conversationId,
    from: full.from, to: account.address, subject: full.subject, text: full.text.slice(0, 20000), html: full.html?.slice(0, 60000), at,
    ...(kind === 'reply' ? { ai: { status: 'pending' } } : {})
  } as MessageDoc);
  await c.leads.updateOne({ _id: lead._id }, { $set: { lastInboundAt: at, lastInbound: { messageId: _id, kind, subject: full.subject, snippet: snippetOf(full.text), at }, inboundUnread: true } });
  return _id;
}

export async function applyReply(db: Db, account: EmailAccountDoc, campaign: CampaignDoc | null, lead: LeadDoc, full: InboundFull): Promise<void> {
  const c = cols(db);
  const now = full.receivedAt ?? new Date();
  await storeInbound(db, account, lead, 'reply', full);
  const set: Record<string, unknown> = { lastEventAt: now };
  if (['queued', 'contacted', 'opened'].includes(lead.status)) set.status = 'replied';
  if (!campaign || campaign.stopOnReply) { set.nextDueAt = null; await cancelPending(db, lead._id, 'replied'); }
  await c.leads.updateOne({ _id: lead._id }, { $set: set });
  // a reply outranks curious: the daily check's mark goes (a person's stays)
  await c.leads.updateOne({ _id: lead._id, curious: true, curiousBy: 'rule' }, { $set: { curious: false, curiousAt: now } });
  await recordEvent(db, { space: lead.space, campaignId: lead.campaignId, leadId: lead._id, accountId: account._id, stepIndex: Math.max(0, lead.currentStep - 1), type: 'reply', at: now, meta: { subject: full.subject } });
}

export async function applyOoo(db: Db, account: EmailAccountDoc, campaign: CampaignDoc | null, lead: LeadDoc, full: InboundFull): Promise<void> {
  const c = cols(db);
  const now = full.receivedAt ?? new Date();
  await storeInbound(db, account, lead, 'ooo', full);
  const set: Record<string, unknown> = { lastEventAt: now };
  if (campaign?.oooStops) { set.nextDueAt = null; set.status = lead.status === 'queued' ? lead.status : 'replied'; await cancelPending(db, lead._id, 'out of office reply'); }
  await c.leads.updateOne({ _id: lead._id }, { $set: set });
  await recordEvent(db, { space: lead.space, campaignId: lead.campaignId, leadId: lead._id, accountId: account._id, stepIndex: Math.max(0, lead.currentStep - 1), type: 'ooo', at: now });
}

export async function applyBounce(db: Db, account: EmailAccountDoc, lead: LeadDoc, full: InboundFull): Promise<void> {
  const c = cols(db);
  const now = full.receivedAt ?? new Date();
  await storeInbound(db, account, lead, 'bounce', full);
  await c.leads.updateOne({ _id: lead._id }, { $set: { status: 'bounced', lastEventAt: now, nextDueAt: null } });
  await cancelPending(db, lead._id, 'bounced');
  await c.suppressions.updateOne({ space: lead.space, email: lead.email }, { $setOnInsert: { reason: 'bounce', at: now } }, { upsert: true });
  await recordEvent(db, { space: lead.space, campaignId: lead.campaignId, leadId: lead._id, accountId: account._id, stepIndex: Math.max(0, lead.currentStep - 1), type: 'bounce', at: now });
  // self-pause: the mailbox's bounce share over the last 7 days (dailyStats, which the event above just fed)
  const r7 = await accountRates(db, account._id, new Date(), 7);
  const reason = selfPauseReason(account, r7.sent, r7.bounces);
  if (reason) await c.emailAccounts.updateOne({ _id: account._id, status: 'active' }, { $set: { status: 'paused', pausedReason: reason } });
}

export interface SyncCounts { items: number; replies: number; bounces: number; ooo: number; ignored: number; [k: string]: number }

export async function syncAccount(db: Db, account: EmailAccountDoc): Promise<SyncCounts> {
  const c = cols(db);
  const provider = providerFor(db, account);
  const counts: SyncCounts = { items: 0, replies: 0, bounces: 0, ooo: 0, ignored: 0 };
  try {
    const baseline = !account.sync?.baselineDone;
    const { items, state } = await provider.fetchNew(account.sync ?? {}, { baseline });
    counts.items = items.length;
    for (const item of items) {
      try {
        const bounce = looksLikeBounce(item);
        const match = bounce ? null : await matchItem(db, account, item);
        if (!bounce && !match) { counts.ignored++; continue; }
        const full = await provider.getMessage(item.providerId);
        if (bounce) {
          const lead = await bouncedLead(db, account, full);
          if (lead) { await applyBounce(db, account, lead, full); counts.bounces++; } else counts.ignored++;
          continue;
        }
        const campaign = await c.campaigns.findOne({ _id: match!.lead.campaignId });
        if (isAutoReply(full)) { await applyOoo(db, account, campaign, match!.lead, full); counts.ooo++; }
        else { await applyReply(db, account, campaign, match!.lead, full); counts.replies++; }
      } catch (e: any) {
        console.error(`[inbox] ${account.address} item ${item.providerId}: ${e?.message ?? e}`);
      }
    }
    // Providers preserve cursor state by spreading their input, which may contain a previous error.
    const { lastError: _previousError, ...cleanState } = state as typeof state & { lastError?: string };
    await c.emailAccounts.updateOne({ _id: account._id }, { $set: { sync: { ...cleanState, lastSyncAt: new Date() } } });
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 500);
    const authProblem = /invalid_grant|AADSTS|401|Authentication|AUTHENTICATIONFAILED|Invalid credentials|Login failed/i.test(message);
    await c.emailAccounts.updateOne({ _id: account._id }, {
      $set: { 'sync.lastError': message, 'sync.lastSyncAt': new Date(), ...(authProblem ? { status: 'error', pausedReason: `Login failed while reading the inbox: ${message}. Reconnect the mailbox.` } : {}) }
    });
    throw e;
  }
  return counts;
}

export async function syncAll(db: Db): Promise<SyncCounts & { accounts: number; errors: number }> {
  const accounts = await cols(db).emailAccounts.find({ status: 'active' }).toArray();
  const total: SyncCounts & { accounts: number; errors: number } = { items: 0, replies: 0, bounces: 0, ooo: 0, ignored: 0, accounts: accounts.length, errors: 0 };
  for (const a of accounts) {
    try {
      const r = await syncAccount(db, a);
      for (const k of ['items', 'replies', 'bounces', 'ooo', 'ignored'] as const) total[k] += r[k];
    } catch { total.errors++; }
  }
  return total;
}

/**
 * Removes inbound mail from Hedwig's Inbox: one message, or every reply, bounce and out-of-office note of the thread.
 * The email stays in the mailbox and the sync cursor is already past it, so it does not come back. Sent steps and manual
 * replies stay: they are the sending history and match future answers by header. The lead keeps its status; its inbox
 * summary and agent label are recomputed from what is left, and the thread leaves the Inbox once nothing inbound remains.
 */
export async function deleteInbound(db: Db, lead: LeadDoc, messageId?: ObjectId): Promise<{ deleted: number; threadGone: boolean }> {
  const c = cols(db);
  const { deletedCount: deleted } = await c.messages.deleteMany({ leadId: lead._id, direction: 'in', ...(messageId ? { _id: messageId } : {}) });
  const last = await c.messages.findOne({ leadId: lead._id, direction: 'in' }, { sort: { at: -1 } });
  if (!last) {
    await c.leads.updateOne({ _id: lead._id }, { $unset: { lastInbound: '', lastInboundAt: '', inboundUnread: '', inboundReadAt: '', ai: '' } });
    return { deleted, threadGone: true };
  }
  const labelled = await c.messages.findOne({ leadId: lead._id, direction: 'in', 'ai.label': { $exists: true } }, { sort: { at: -1 } });
  const kind = last.kind as 'reply' | 'bounce' | 'ooo';
  await c.leads.updateOne({ _id: lead._id }, {
    $set: { lastInboundAt: last.at, lastInbound: { messageId: last._id, kind, subject: last.subject, snippet: snippetOf(last.text), at: last.at }, ...(labelled?.ai?.label ? { ai: { label: labelled.ai.label, confidence: labelled.ai.confidence ?? 0, at: labelled.ai.at ?? labelled.at, messageId: labelled._id } } : {}) },
    ...(labelled?.ai?.label ? {} : { $unset: { ai: '' } })
  });
  return { deleted, threadGone: false };
}

/** Opening a thread in the Inbox. */
export async function markThreadRead(db: Db, leadId: ObjectId): Promise<void> {
  await cols(db).leads.updateOne({ _id: leadId, inboundUnread: true }, { $set: { inboundUnread: false, inboundReadAt: new Date() } });
}

export interface ManualReplyInput { lead: LeadDoc; campaign: CampaignDoc; account: EmailAccountDoc; html: string; nonce: string; byUserId: ObjectId }

/**
 * A person answers from the Inbox. Sent through the mailbox that holds the thread, as a reply to the lead's latest
 * message, with their last email quoted below. The message document is written first with a unique nonce (a double
 * click is a duplicate key, not a second email); the provider hands back the ids before the send; the booked steps of
 * the sequence are cancelled: a human has taken over.
 */
export async function sendManualReply(db: Db, input: ManualReplyInput): Promise<{ messageId: ObjectId; internetMessageId: string }> {
  const c = cols(db);
  const { lead, campaign, account, nonce, byUserId } = input;
  const last = await c.messages.findOne({ leadId: lead._id, direction: 'in' }, { sort: { at: -1 } });
  const baseSubject = (last?.subject || lead.thread?.subject || campaign.steps[0]?.subject || '').replace(/^\s*(re|fwd?|rv)\s*:\s*/i, '').trim();
  const subject = baseSubject ? `Re: ${baseSubject}` : 'Re:';
  const inner = input.html.trim();
  const text = htmlToText(inner);
  if (!text.trim()) throw new Error('Write something first.');
  let quotedText = '', quotedHtml = '';
  if (last) {
    const when = new Date(last.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: campaign.schedule.timezone || 'UTC' });
    const head = `On ${when}, ${last.from} wrote:`;
    const body = (last.text ?? '').slice(0, 4000);
    quotedText = `\n\n${head}\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`;
    quotedHtml = `<div style="margin:1.4em 0 0;padding-left:1em;border-left:2px solid #ccc;color:#555"><p style="margin:0 0 .6em">${escapeHtml(head)}</p>${escapeHtml(body).replace(/\n/g, '<br>')}</div>`;
  }
  const _id = new ObjectId();
  const doc: MessageDoc = {
    _id, space: lead.space, campaignId: campaign._id, leadId: lead._id, accountId: account._id, direction: 'out', kind: 'manual', status: 'sending', nonce, byUserId,
    inReplyTo: last?.internetMessageId, conversationId: last?.conversationId ?? lead.thread?.conversationId,
    from: account.address, to: lead.email, subject, text, html: inner, at: new Date()
  };
  try { await withWorkspaceEdit(db, lead.space, async () => {
    if (!await c.campaigns.findOne({ _id: campaign._id, space: lead.space }) || !await c.emailAccounts.findOne({ _id: account._id, space: lead.space, status: 'active' })) throw new OperationError('not_found', 'Campaign or active mailbox no longer exists.');
    if (!await c.leads.findOne({ _id: lead._id, campaignId: campaign._id, space: lead.space })) throw new OperationError('not_found', 'Lead no longer exists.');
    if (await c.sends.findOne({ leadId: lead._id, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] })) throw new OperationError('send_in_flight', 'A sequence email is in flight. Wait for it to settle before replying.');
    await c.messages.insertOne(doc);
    await c.sends.updateMany({ leadId: lead._id, status: 'planned', ids: { $exists: false } }, { $set: { status: 'cancelled', reason: 'reply requested' } });
    await c.leads.updateOne({ _id: lead._id, status: { $in: ['queued', 'contacted', 'opened'] } }, { $set: { status: 'replied', statusBy: byUserId.toHexString(), nextDueAt: null } });
  }); }
  catch (e: any) { if (e?.code === 11000) throw new Error('That reply was already sent.'); throw e; }
  const thread = last?.internetMessageId ? { internetMessageId: last.internetMessageId, conversationId: last.conversationId ?? lead.thread?.conversationId } : lead.thread ? { internetMessageId: lead.thread.internetMessageId, conversationId: lead.thread.conversationId } : undefined;
  try {
    const info = await providerFor(db, account).send(
      { to: lead.email, toName: lead.vars.contactPerson ?? lead.vars.firstName, subject, text: text + quotedText, html: wrapEmailHtml(inner + quotedHtml), sendId: `reply-${_id.toHexString()}` },
      thread,
      async (ids) => { await c.messages.updateOne({ _id }, { $set: { internetMessageId: ids.internetMessageId, conversationId: ids.conversationId ?? doc.conversationId } }); }
    );
    const now = new Date();
    await c.messages.updateOne({ _id }, { $set: { status: 'sent', internetMessageId: info.internetMessageId, conversationId: info.conversationId ?? doc.conversationId, at: now } });
    await cancelPending(db, lead._id, 'answered by hand from the Inbox');
    await c.leads.updateOne({ _id: lead._id }, { $set: { lastEventAt: now, lastAnsweredAt: now, nextDueAt: null, 'thread.internetMessageId': info.internetMessageId, ...(info.conversationId ? { 'thread.conversationId': info.conversationId } : {}) } });
    return { messageId: _id, internetMessageId: info.internetMessageId };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 500);
    await c.messages.updateOne({ _id }, { $set: { status: 'failed', error } });
    throw new Error(`Could not send: ${error}`);
  }
}

/**
 * One-time: leads that got replies before the Inbox existed get their summary, and replies from the last 30 days are
 * handed to the agent. Runs at worker start; the migrations collection remembers it was done.
 */
export async function backfillInbound(db: Db): Promise<{ leads: number; queued: number }> {
  const c = cols(db);
  const key = 'inbox-backfill-1';
  if (await c.migrations.findOne({ _id: key })) return { leads: 0, queued: 0 };
  const rows = await c.messages.aggregate<{ _id: ObjectId; at: Date; messageId: ObjectId; kind: 'reply' | 'bounce' | 'ooo'; subject: string; text: string }>([
    { $match: { direction: 'in', leadId: { $exists: true } } },
    { $sort: { at: 1 } },
    { $group: { _id: '$leadId', at: { $last: '$at' }, messageId: { $last: '$_id' }, kind: { $last: '$kind' }, subject: { $last: '$subject' }, text: { $last: '$text' } } }
  ]).toArray();
  let leads = 0;
  for (const r of rows) {
    const u = await c.leads.updateOne({ _id: r._id, lastInboundAt: { $exists: false } }, { $set: { lastInboundAt: r.at, lastInbound: { messageId: r.messageId, kind: r.kind, subject: r.subject, snippet: snippetOf(r.text), at: r.at }, inboundUnread: false } });
    leads += u.modifiedCount;
  }
  const since = new Date(Date.now() - 30 * 864e5);
  const q = await c.messages.updateMany({ direction: 'in', kind: 'reply', ai: { $exists: false }, at: { $gte: since } }, { $set: { ai: { status: 'pending' } } });
  await c.messages.updateMany({ direction: 'in', kind: 'reply', ai: { $exists: false } }, { $set: { ai: { status: 'skipped', error: 'older than 30 days when the agent arrived' } } });
  await c.migrations.insertOne({ _id: key, at: new Date(), note: `${leads} leads summarised, ${q.modifiedCount} replies queued for the agent` });
  return { leads, queued: q.modifiedCount };
}
