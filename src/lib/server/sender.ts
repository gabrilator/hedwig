import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { cols } from './db';
import { withCampaignEdit, withWorkspaceEdit, OperationError } from './operations';
import { dayStartFor, effectiveDailyLimit, sentToday } from './accounts';
import { SENDABLE } from './campaigns';
import { providerFor } from './mail/provider';
import type { SentInfo } from './mail/types';
import { escapeHtml, htmlToText, looksLikeHtml, renderTemplate, textToHtml, wrapEmailHtml } from './render';
import { recordEvent } from './stats';
import { pixelUrl, unsubUrl } from './tracking';
import type { CampaignDoc, EmailAccountDoc, LeadDoc, SendDoc } from './types';

export interface BuiltMail { subject: string; text: string; html: string; missing: string[]; headers?: Record<string, string> }

/** RFC 2369 + 8058: the unsubscribe link mail clients show on their own, with no text in the email. */
export const unsubscribeHeaders = (token: string): Record<string, string> => ({ 'List-Unsubscribe': `<${unsubUrl(token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

export function buildStepMail(campaign: CampaignDoc, stepIndex: number, lead: Pick<LeadDoc, 'vars' | 'thread' | 'email'>, send: Pick<SendDoc, 'tokens'> | null): BuiltMail {
  const step = campaign.steps[stepIndex];
  if (!step) throw new Error(`Campaign has no step ${stepIndex + 1}`);
  const vars = { ...lead.vars, email: lead.email };
  const subjectTpl = step.subject && step.subject.trim()
    ? step.subject
    : lead.thread?.subject ? `Re: ${lead.thread.subject.replace(/^\s*re:\s*/i, '')}` : (campaign.steps[0]?.subject ?? '');
  const subj = renderTemplate(subjectTpl, vars);
  const unsub = send ? unsubUrl(send.tokens.unsub) : unsubUrl('preview');
  const line = campaign.unsubscribeLine?.trim();
  let text: string, inner: string, missing: string[];
  if (looksLikeHtml(step.body)) {
    const escVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeHtml(v ?? '')]));
    const h = renderTemplate(step.body, escVars);
    const t = renderTemplate(htmlToText(step.body), vars);
    inner = h.text; text = t.text; missing = h.missing;
    if (line) { text += `\n\n${line}: ${unsub}`; inner += `<p style="margin:1em 0 0;color:#666;font-size:12px">${escapeHtml(line)}: <a href="${unsub}">${unsub}</a></p>`; }
  } else {
    const body = renderTemplate(step.body, vars);
    text = body.text; missing = body.missing;
    if (line) text += `\n\n${line}: ${unsub}`;
    inner = textToHtml(text).replace(/^<div[^>]*>|<\/div>$/g, '');
  }
  let html = wrapEmailHtml(inner);
  if (campaign.openTracking && send) html += `<img src="${pixelUrl(send.tokens.open)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
  return { subject: subj.text, text, html, missing: [...subj.missing, ...missing], headers: send ? unsubscribeHeaders(send.tokens.unsub) : undefined };
}

export interface SenderCounts { sent: number; failed: number; skipped: number; [k: string]: number }

/** Claims due sends one at a time (atomic), sends, records. A crash between provider and record is repaired by reconcileClaims. */
export async function runSender(db: Db, now: Date, opts: { maxPerTick: number } = { maxPerTick: 60 }): Promise<SenderCounts> {
  const c = cols(db);
  const counts: SenderCounts = { sent: 0, failed: 0, skipped: 0 };
  const blockedSpaces = new Set<string>();
  for (let i = 0; i < opts.maxPerTick; i++) {
    const candidate = await c.sends.findOne({ status: 'planned', dueAt: { $lte: now }, space: { $nin: [...blockedSpaces] } }, { sort: { dueAt: 1 } });
    if (!candidate) break;
    let send: SendDoc | null = null;
    try {
      send = await withCampaignEdit(db, candidate.campaignId, async (campaign) => {
        if (campaign.status !== 'active') {
          await c.sends.updateOne({ _id: candidate._id, status: 'planned', ids: { $exists: false } }, { $set: { status: 'cancelled', reason: 'campaign not active' } });
          return null;
        }
        return c.sends.findOneAndUpdate({ _id: candidate._id, status: 'planned' },
          { $set: { status: 'claimed', claimedAt: new Date(), inFlight: true }, $inc: { attempt: 1 } }, { returnDocument: 'after' });
      }, true);
    } catch (e) {
      if (!(e instanceof OperationError)) throw e;
      if (e.code === 'not_found') await c.sends.updateOne({ _id: candidate._id, status: 'planned' }, { $set: { status: 'cancelled', reason: 'campaign missing' } });
      else blockedSpaces.add(candidate.space);
      counts.skipped++; continue;
    }
    if (!send) { counts.skipped++; continue; }
    const cancel = async (reason: string) => { await c.sends.updateOne({ _id: send._id }, { $set: { status: 'cancelled', reason } }); counts.skipped++; };
    try {
      const [campaign, lead, account] = await Promise.all([
        c.campaigns.findOne({ _id: send.campaignId }), c.leads.findOne({ _id: send.leadId }), c.emailAccounts.findOne({ _id: send.accountId })
      ]);
      if (!campaign || campaign.status !== 'active') { await cancel('campaign not active'); continue; }
      if (!lead || !SENDABLE.includes(lead.status) || lead.currentStep !== send.stepIndex) { await cancel('lead no longer due for this step'); continue; }
      if (!account || account.space !== campaign.space || !campaign.accountIds.some(id => id.equals(account._id)) || account.status !== 'active') { await cancel('mailbox not active'); continue; }
      if (await c.suppressions.findOne({ space: lead.space, email: lead.email })) { await cancel('address is on the suppression list'); continue; }
      const limit = effectiveDailyLimit(account, now);
      if ((await sentToday(db, account._id, dayStartFor(account, now, campaign.schedule.timezone))) >= limit) {
        await c.sends.updateOne({ _id: send._id }, { $set: { status: 'planned', dueAt: new Date(now.getTime() + 30 * 60_000) } });
        counts.skipped++;
        continue;
      }
      const built = buildStepMail(campaign, send.stepIndex, lead, send);
      const provider = providerFor(db, account);
      const thread = send.stepIndex > 0 && lead.thread ? { internetMessageId: lead.thread.internetMessageId, conversationId: lead.thread.conversationId } : undefined;
      const info = await provider.send(
        { to: lead.email, toName: lead.vars.contactPerson ?? lead.vars.firstName, subject: built.subject, text: built.text, html: built.html, sendId: send._id.toHexString(), headers: built.headers },
        thread,
        async (ids) => { await c.sends.updateOne({ _id: send._id }, { $set: { ids, subject: built.subject } }); }
      );
      await afterSent(db, campaign, lead, send, account, info, built.subject, built.text, new Date());
      counts.sent++;
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 600);
      const prepared = await c.sends.findOne({ _id: send._id, ids: { $exists: true } });
      if (prepared) { await c.sends.updateOne({ _id: send._id }, { $set: { status: 'claimed', error: message } }); }
      else if (send.attempt < 3) await c.sends.updateOne({ _id: send._id }, { $set: { status: 'planned', dueAt: new Date(Date.now() + send.attempt * 5 * 60_000), error: message } });
      else await c.sends.updateOne({ _id: send._id }, { $set: { status: 'failed', error: message } });
      counts.failed++;
    } finally { await c.sends.updateOne({ _id: send._id }, { $unset: { inFlight: '' } }); }
  }
  return counts;
}

export async function afterSent(db: Db, campaign: CampaignDoc, lead: LeadDoc, send: SendDoc, account: EmailAccountDoc, info: SentInfo, subject: string, text: string, sentAt: Date): Promise<void> {
  const c = cols(db);
  await c.sends.updateOne({ _id: send._id }, { $set: { status: 'sent', sentAt, ids: info, subject }, $unset: { error: '' } });
  const nextIndex = send.stepIndex + 1;
  const next = campaign.steps[nextIndex];
  const set: Record<string, unknown> = {
    accountId: account._id, currentStep: nextIndex, lastEventAt: sentAt,
    nextDueAt: next ? new Date(sentAt.getTime() + Math.max(0, next.delayDays) * 864e5) : null
  };
  if (lead.status === 'queued') set.status = 'contacted';
  if (!next) set.completedAt = sentAt;
  set.thread = {
    internetMessageId: info.internetMessageId,
    firstInternetMessageId: lead.thread?.firstInternetMessageId ?? (send.stepIndex === 0 ? info.internetMessageId : lead.thread?.internetMessageId ?? info.internetMessageId),
    conversationId: info.conversationId ?? lead.thread?.conversationId,
    subject: lead.thread?.subject && send.stepIndex > 0 ? lead.thread.subject : subject
  };
  await c.leads.updateOne({ _id: lead._id }, { $set: set });
  await c.messages.insertOne({
    space: campaign.space, campaignId: campaign._id, leadId: lead._id, accountId: account._id, sendId: send._id, direction: 'out', kind: 'sent',
    internetMessageId: info.internetMessageId, conversationId: info.conversationId, from: account.address, to: lead.email, subject, text, at: sentAt
  } as never);
  await recordEvent(db, { space: campaign.space, campaignId: campaign._id, leadId: lead._id, accountId: account._id, stepIndex: send.stepIndex, type: 'sent', at: sentAt });
}

/** Sends stuck in `claimed`: confirm from the Sent folder before deciding. Never re-sends something that might have left. */
export async function reconcileClaims(db: Db, now: Date, staleMinutes = 10): Promise<{ confirmed: number; requeued: number; unknown: number; [k: string]: number }> {
  const c = cols(db);
  const counts = { confirmed: 0, requeued: 0, unknown: 0 };
  const stuck = await c.sends.find({ status: 'claimed', claimedAt: { $lte: new Date(now.getTime() - staleMinutes * 60_000) } }).toArray();
  for (const send of stuck) {
    await c.sends.updateOne({ _id: send._id }, { $set: { inFlight: true } });
    try {
    const [campaign, lead, account] = await Promise.all([
      c.campaigns.findOne({ _id: send.campaignId }), c.leads.findOne({ _id: send.leadId }), c.emailAccounts.findOne({ _id: send.accountId })
    ]);
    if (!campaign || !lead || !account) { await c.sends.updateOne({ _id: send._id }, { $set: { status: 'cancelled', reason: 'missing campaign, lead or mailbox' } }); continue; }
    const prepared = send.ids?.internetMessageId;
    if (prepared) {
      try {
        const r = await providerFor(db, account).findSent(prepared);
        if (r.found) {
          await afterSent(db, campaign, lead, send, account, send.ids as SentInfo, send.subject ?? '', '', r.sentAt ?? now);
          counts.confirmed++;
          continue;
        }
      } catch { /* provider unreachable: leave for the next pass */ continue; }
    }
    if (send.attempt < 3) {
      await c.sends.updateOne({ _id: send._id }, { $set: { status: 'planned', dueAt: now }, $unset: { ids: '' } });
      counts.requeued++;
    } else {
      await c.sends.updateOne({ _id: send._id }, { $set: { status: 'unknown', error: 'Could not confirm whether this email left. Not retried, to avoid sending it twice.' } });
      counts.unknown++;
    }
    } finally { await c.sends.updateOne({ _id: send._id }, { $unset: { inFlight: '' } }); }
  }
  return counts;
}

export const SAMPLE_VARS: Record<string, string> = {
  firstName: 'Alex', contactPerson: 'Alex Morgan', companyName: 'Example Ltd', company: 'Example Ltd', city: 'Lisbon', province: 'Lisbon', contactRole: 'Head of operations', website: 'https://example.com'
};

export async function sendTest(db: Db, campaign: CampaignDoc, stepIndex: number, account: EmailAccountDoc, to: string, sample?: Pick<LeadDoc, 'vars' | 'email' | 'thread'>, sendId = `test-${new ObjectId().toHexString()}`) {
  const lead = sample ?? { vars: SAMPLE_VARS, email: to, thread: undefined };
  const built = buildStepMail(campaign, stepIndex, lead, null);
  const subject = `[TEST] ${built.subject}`;
  const _id = new ObjectId();
  await withWorkspaceEdit(db, campaign.space, async () => {
    if (!await cols(db).campaigns.findOne({ _id: campaign._id, space: campaign.space }) || !await cols(db).emailAccounts.findOne({ _id: account._id, space: campaign.space, status: 'active' })) throw new OperationError('not_found', 'Campaign or active mailbox no longer exists.');
    await cols(db).messages.insertOne({
      _id, space: campaign.space, campaignId: campaign._id, accountId: account._id, direction: 'out', kind: 'test', status: 'sending',
      from: account.address, to, subject, text: `step ${stepIndex + 1} · ${built.text.slice(0, 500)}`, at: new Date()
    });
  });
  try {
    const info = await providerFor(db, account).send({ to, subject, text: built.text, html: built.html, sendId }, stepIndex > 0 ? sample?.thread : undefined,
      async ids => { await cols(db).messages.updateOne({ _id }, { $set: { internetMessageId: ids.internetMessageId, conversationId: ids.conversationId } }); });
    await cols(db).messages.updateOne({ _id }, { $set: { status: 'sent', internetMessageId: info.internetMessageId, conversationId: info.conversationId } });
    return { info, built };
  } catch (e) {
    await cols(db).messages.updateOne({ _id }, { $set: { status: 'failed', error: 'Test send failed or could not be confirmed. Check the sending mailbox before retrying.' } });
    throw e;
  }
}
