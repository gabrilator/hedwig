/**
 * The reply agent: reads one reply to one of our campaign emails and labels it meeting, interested or replied. Jev
 * (TypeSafe's classifier) is the only classifier: with no TYPESAFE_API_KEY on the server nothing is labelled. Nothing here
 * sends mail to a lead and nothing writes an answer: the only email that leaves is the "someone is interested" note to the
 * campaign's owner, through Hedwig's own system mail. A status a person set is theirs: the classifier leaves that lead alone.
 * Bounces and out-of-office notes never reach the agent: the inbox sync files them before (`inbox.ts`).
 *
 * Idempotency (Law 3): a message is claimed with one atomic findOneAndUpdate (ai.status pending → running). Two workers,
 * a worker and a button, a retry after a crash: Jev is asked once per reply, at most three times after failures, never in
 * parallel. A hard daily cap on calls (JEV_DAILY_CAP) keeps a runaway inbox from becoming a bill.
 */
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { classifierDailyCap, env, envOpt, jevConfigured } from './env';
import { applyLeadStatus } from './campaigns';
import { sendSystemMail } from './systemMail';
import { AI_LABELS, type AgentDoc, type AiLabel, type CampaignDoc, type LeadDoc, type LeadStatus, type MessageDoc, type SpaceKey } from './types';

export const DEFAULT_AGENT_NAME = 'Triage';
export const LABEL_TEXT: Record<AiLabel, string> = { meeting: 'Meeting', interested: 'Interested', replied: 'Replied' };
/** What each label means: Jev's choices. */
export const LABEL_MEANING: Record<AiLabel, string> = {
  meeting: 'proposes, accepts or confirms a meeting, a call or a specific date or time.',
  interested: 'wants to know more, asks for information, prices or a demo, or says yes, without fixing a meeting.',
  replied: 'anything else: a question without a clear yes, a no, not now, a request to stop, a forward to someone else, or no stance at all.'
};
/** Jev's stable alias, so a retired version never stops the labels; the version that answered is kept with each label. */
export const JEV_MODEL = 'jev-latest';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
/** Below this the agent labels but does not touch the lead's status. */
export const APPLY_CONFIDENCE = 0.75;
/** From this the owner gets the "interested" email. */
export const NOTIFY_CONFIDENCE = 0.6;
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 15 * 60_000;

// ---------- the agent ----------

/** The space's agent: created on first use, one per space, never deleted. Admins switch it on or off. */
export async function ensureDefaultAgent(db: Db, space: SpaceKey, ownerUserId: ObjectId): Promise<AgentDoc> {
  const c = cols(db);
  const found = await c.agents.findOne({ space, builtin: true });
  if (found) return found;
  const doc: AgentDoc = { _id: new ObjectId(), space, ownerUserId, name: DEFAULT_AGENT_NAME, active: true, builtin: true, createdAt: new Date() };
  try { await c.agents.insertOne(doc); return doc; }
  catch (e: any) { if (e?.code === 11000) return (await c.agents.findOne({ space, builtin: true }))!; throw e; }
}

/** The agent that handles a campaign's replies: none when switched off on the campaign, else the space's one. */
export async function effectiveAgent(db: Db, campaign: Pick<CampaignDoc, 'space' | 'ownerUserId' | 'agentOff'>): Promise<AgentDoc | null> {
  if (campaign.agentOff) return null;
  return ensureDefaultAgent(db, campaign.space, campaign.ownerUserId);
}

/** What a campaign's agent does, in one line for the screens. */
export function describeAgent(a: AgentDoc | null): string {
  if (!a) return 'No agent on this campaign: replies are only matched and stopped, never labelled.';
  if (!a.active) return `${a.name} is switched off on the Agents screen.`;
  return `${a.name} reads every reply once with Jev and labels it meeting, interested or replied. Meeting and interested replies email the campaign owner. It never sends anything to a lead.`;
}

// ---------- text ----------

const QUOTE_MARKERS = [
  /^On .{6,120} wrote:\s*$/i,
  /^El .{6,140} escribi[oó]:\s*$/i,
  /^Le .{6,120} a [eé]crit\s*:\s*$/i,
  /^Am .{6,120} schrieb .{0,80}:\s*$/i,
  /^-{2,}\s*(Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}$/i,
  /^_{10,}\s*$/,
  /^(From|De|Von)\s*:\s.+$/i
];

/** The person's own words: everything before the quoted email they answered. Never returns an empty string. */
export function stripQuoted(text: string, limit = 6000): string {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (QUOTE_MARKERS.some((re) => re.test(line.trim()))) {
      const next = (lines[i + 1] ?? '').trim();
      // "From:" alone can be a real sentence; a header block follows it with Sent/To/Enviado/Para.
      if (/^(From|De|Von)\s*:/i.test(line.trim()) && !/^(Sent|To|Enviado|Para|Date|Fecha|Subject|Asunto|Gesendet|An)\s*:/i.test(next)) { out.push(line); continue; }
      break;
    }
    if (/^\s*>/.test(line)) break;
    out.push(line);
  }
  const own = out.join('\n').trim();
  const fallback = (text ?? '').trim();
  return (own || fallback).slice(0, limit);
}

export interface ThreadItem { direction: 'in' | 'out'; kind: string; from: string; subject: string; text: string; at: Date }

// ---------- Jev ----------

export interface ModelAnswer { label: AiLabel; confidence: number; reason: string; odds: Partial<Record<AiLabel, number>> }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface Deps { fetch?: FetchLike }

export class ModelError extends Error { constructor(message: string, public transient: boolean) { super(message); } }

export interface JevRequest { model: string; state: Record<string, string>; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> }

/** One question to Jev: which label fits their reply, next to the email of ours they answered. Quoted text stays out. */
export function buildJevRequest(input: { thread: ThreadItem[]; target: ThreadItem }): JevRequest {
  const { thread, target } = input;
  const ours = [...thread].reverse().find((m) => m.direction === 'out' && m.at.getTime() <= target.at.getTime());
  const state: Record<string, string> = { subject: target.subject || '' };
  if (ours) state.our_last_email = stripQuoted(ours.text, 1500);
  state.their_reply = stripQuoted(target.text);
  return {
    model: JEV_MODEL, state,
    questions: { label: { type: 'choice', instructions: 'Label their_reply: how does the person who wrote it answer our email?', criteria: LABEL_MEANING } }
  };
}

/** Jev's answer in Hedwig's terms: the label it chose, that label's probability as the confidence, the top odds as the reason. */
export function parseJevAnswer(json: any): ModelAnswer {
  const a = json?.answers?.label;
  if (!a || typeof a.choice !== 'string') throw new ModelError(`Jev returned no label: ${String(JSON.stringify(json ?? null)).slice(0, 160)}`, false);
  const label = (AI_LABELS as readonly string[]).includes(a.choice) ? (a.choice as AiLabel) : 'replied';
  const odds: Partial<Record<AiLabel, number>> = {};
  for (const l of AI_LABELS) {
    const p = Number(a.probabilities?.[l]);
    if (Number.isFinite(p)) odds[l] = Math.max(0, Math.min(1, p));
  }
  const fallback = Number(a.confidence);
  const confidence = odds[label] ?? (Number.isFinite(fallback) ? Math.max(0, Math.min(1, fallback)) : 0);
  const top = (Object.entries(odds) as [AiLabel, number][]).sort((x, y) => y[1] - x[1]).slice(0, 2).filter(([, p]) => p >= 0.01);
  const reason = top.map(([l, p]) => `${LABEL_TEXT[l]} ${Math.round(p * 100)}%`).join(' · ');
  return { label, confidence, reason, odds };
}

const errorText = (json: any, text: string): string => {
  const e = json?.error;
  const detail = typeof e === 'string' ? e : e?.message ?? json?.message ?? (json?.detail === undefined ? undefined : typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail));
  return String(detail ?? text).slice(0, 200);
};

/** One call to TypeSafe's classifier. Throws ModelError; `transient` (timeouts, rate limits, overload) means retry later. */
export async function callJev(request: JevRequest, deps: Deps = {}): Promise<{ answer: ModelAnswer; tokens: { prompt: number; output: number }; model: string }> {
  const f = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(JEV_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env('TYPESAFE_API_KEY')}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(30_000)
    });
  } catch (e: any) { throw new ModelError(`Jev unreachable: ${e?.message ?? e}`, true); }
  const text = await res.text();
  let json: any = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
  if (!res.ok) throw new ModelError(`Jev ${res.status}: ${errorText(json, text)}`, res.status === 408 || res.status === 429 || res.status >= 500);
  const answer = parseJevAnswer(json);
  return { answer, tokens: { prompt: Number(json?.usage?.input_tokens ?? 0), output: Number(json?.usage?.output_tokens ?? 0) }, model: typeof json?.model === 'string' ? json.model.slice(0, 40) : request.model };
}

// ---------- outcomes ----------

const AUTO: LeadStatus[] = ['queued', 'contacted', 'opened', 'replied'];

/** The status a label sets, or null when it must not touch what is there (a status set by hand is never downgraded). */
export function labelToStatus(label: AiLabel, current: LeadStatus): LeadStatus | null {
  switch (label) {
    case 'interested': return AUTO.includes(current) ? 'interested' : null;
    case 'meeting': return [...AUTO, 'interested'].includes(current) ? 'meeting' : null;
    default: return null;
  }
}

export const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function callsToday(db: Db, now = new Date()): Promise<number> {
  return cols(db).llmCalls.countDocuments({ at: { $gte: startOfUtcDay(now) } });
}

/** For the Agents screen: is the key there, how often Jev was asked, the last error. Instance-wide, so admins only. */
export async function llmUsage(db: Db) {
  const c = cols(db);
  const now = new Date();
  const [today, month, failed, last, pending] = await Promise.all([
    callsToday(db, now),
    c.llmCalls.countDocuments({ at: { $gte: new Date(now.getTime() - 30 * 864e5) } }),
    c.llmCalls.countDocuments({ at: { $gte: startOfUtcDay(now) }, ok: false }),
    c.llmCalls.findOne({ ok: false }, { sort: { at: -1 } }),
    c.messages.countDocuments({ 'ai.status': 'pending' })
  ]);
  return { configured: jevConfigured(), cap: classifierDailyCap(), today, month, failedToday: failed, lastError: last ? { at: last.at, error: last.error ?? '' } : null, pending };
}

export interface ClassifyResult { ok: boolean; label?: AiLabel; confidence?: number; skipped?: string; error?: string }

interface ClassifyOpts { force?: boolean; deps?: Deps; now?: Date }

/**
 * Label one inbound reply with Jev. Claims the message first; a message that is not pending (already done, running, failed
 * for good) is left alone unless `force` (a button) says otherwise. A lead whose status a person set is skipped; "Label
 * again" (force) hands it back to the classifier.
 */
export async function classifyMessage(db: Db, messageId: ObjectId, opts: ClassifyOpts = {}): Promise<ClassifyResult> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  if (!jevConfigured()) return { ok: false, skipped: 'TYPESAFE_API_KEY is not set' };
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const claimable = opts.force
    ? { $or: [{ 'ai.status': { $ne: 'running' } }, { 'ai.status': 'running', 'ai.claimedAt': { $lt: stale } }] }
    : { $or: [{ 'ai.status': 'pending', 'ai.nextAttemptAt': { $exists: false } }, { 'ai.status': 'pending', 'ai.nextAttemptAt': { $lte: now } }, { 'ai.status': 'running', 'ai.claimedAt': { $lt: stale } }] };
  const msg = await c.messages.findOneAndUpdate(
    { _id: messageId, direction: 'in', kind: 'reply', ...claimable },
    { $set: { 'ai.status': 'running', 'ai.claimedAt': now }, $inc: { 'ai.attempts': 1 } },
    { returnDocument: 'after' }
  );
  if (!msg) return { ok: false, skipped: 'not waiting for the agent' };
  const attempts = msg.ai?.attempts ?? 1;
  const giveBack = async (patch: Record<string, unknown>) => { await c.messages.updateOne({ _id: msg._id }, { $set: patch }); };

  const [lead, campaign] = await Promise.all([msg.leadId ? c.leads.findOne({ _id: msg.leadId }) : null, c.campaigns.findOne({ _id: msg.campaignId })]);
  if (!lead || !campaign) { await giveBack({ 'ai.status': 'skipped', 'ai.error': 'lead or campaign is gone' }); return { ok: false, skipped: 'lead or campaign is gone' }; }
  const agent = await effectiveAgent(db, campaign);
  if (!agent || !agent.active) { await giveBack({ 'ai.status': 'skipped', 'ai.error': agent ? `${agent.name} is switched off` : 'no agent on this campaign' }); return { ok: false, skipped: agent ? 'agent switched off' : 'no agent on this campaign' }; }
  if (lead.statusBy) {
    if (!opts.force) { await giveBack({ 'ai.status': 'skipped', 'ai.error': `status set by hand by ${lead.statusBy}` }); return { ok: false, skipped: 'status set by hand' }; }
    await c.leads.updateOne({ _id: lead._id }, { $unset: { statusBy: '' } });
  }
  if ((await callsToday(db, now)) >= classifierDailyCap()) { await giveBack({ 'ai.status': 'pending', 'ai.nextAttemptAt': new Date(now.getTime() + 60 * 60_000) }); return { ok: false, skipped: 'daily cap reached' }; }

  const history = await c.messages.find({ leadId: lead._id, at: { $lte: msg.at }, kind: { $in: ['sent', 'reply', 'manual'] } }, { sort: { at: 1 }, limit: 8, projection: { direction: 1, kind: 1, from: 1, subject: 1, text: 1, at: 1 } }).toArray();
  const thread: ThreadItem[] = history.map((m) => ({ direction: m.direction, kind: m.kind, from: m.from, subject: m.subject, text: m.text, at: m.at }));
  let target = thread.find((t) => t.at.getTime() === msg.at.getTime() && t.direction === 'in' && t.from === msg.from);
  if (!target) { target = { direction: 'in', kind: msg.kind, from: msg.from, subject: msg.subject, text: msg.text, at: msg.at }; thread.push(target); }

  const started = Date.now();
  const log = (model: string, result: { tokens?: { prompt: number; output: number }; error?: string }) =>
    c.llmCalls.insertOne({ _id: new ObjectId(), space: lead.space, at: now, model, purpose: 'classify', messageId: msg._id, ok: !result.error, ms: Date.now() - started, ...result });
  let r: Awaited<ReturnType<typeof callJev>>;
  try {
    r = await callJev(buildJevRequest({ thread, target }), opts.deps);
    await log(r.model, { tokens: r.tokens });
  } catch (e) {
    const error = String((e as any)?.message ?? e).slice(0, 500);
    await log(JEV_MODEL, { error });
    const retry = e instanceof ModelError && e.transient && attempts < MAX_ATTEMPTS;
    await giveBack(retry ? { 'ai.status': 'pending', 'ai.nextAttemptAt': new Date(now.getTime() + attempts * 10 * 60_000), 'ai.error': error } : { 'ai.status': 'failed', 'ai.error': error });
    return { ok: false, error };
  }
  const { answer, model } = r;

  const set: Record<string, unknown> = { 'ai.status': 'done', 'ai.agentId': agent._id, 'ai.at': now, 'ai.label': answer.label, 'ai.confidence': answer.confidence, 'ai.reason': answer.reason, 'ai.model': model, 'ai.odds': answer.odds };
  await c.leads.updateOne({ _id: lead._id }, { $set: { ai: { label: answer.label, confidence: answer.confidence, at: now, messageId: msg._id } } });
  const unset: Record<string, ''> = { 'ai.error': '', 'ai.nextAttemptAt': '', 'ai.draft': '', 'ai.draftAt': '' };
  const next = labelToStatus(answer.label, lead.status);
  if (next && answer.confidence >= APPLY_CONFIDENCE) { await applyLeadStatus(db, lead, next, `agent ${agent.name}`); set['ai.appliedStatus'] = next; }
  else unset['ai.appliedStatus'] = '';
  await c.messages.updateOne({ _id: msg._id }, { $set: set, $unset: unset });

  if ((answer.label === 'interested' || answer.label === 'meeting') && answer.confidence >= NOTIFY_CONFIDENCE) {
    await notifyOwner(db, msg, lead, campaign, answer, now);
  }
  return { ok: true, label: answer.label, confidence: answer.confidence };
}

/** The "someone is interested" email to the campaign's owner. Claimed with a set-if-unset, so it goes out once. */
async function notifyOwner(db: Db, msg: MessageDoc, lead: LeadDoc, campaign: CampaignDoc, answer: ModelAnswer, now: Date): Promise<void> {
  const c = cols(db);
  const claimed = await c.messages.findOneAndUpdate({ _id: msg._id, 'ai.notifiedAt': { $exists: false } }, { $set: { 'ai.notifiedAt': now } });
  if (!claimed) return;
  const owner = await c.users.findOne({ _id: campaign.ownerUserId }, { projection: { email: 1 } });
  if (!owner) return;
  const company = lead.vars?.companyName ?? lead.vars?.company ?? '';
  const who = company ? `${company} (${lead.email})` : lead.email;
  const kind = answer.label === 'meeting' ? 'wants a meeting' : 'sounds interested';
  const link = `${(envOpt('ORIGIN') ?? '').replace(/\/$/, '')}/inbox?thread=${lead._id.toHexString()}`;
  const text = [
    `${who} replied to "${campaign.name}" and ${kind}.`, '',
    'Their reply:', stripQuoted(msg.text, 800), '',
    `Jev's odds: ${answer.reason}`, '',
    `Open the thread: ${link}`
  ].join('\n');
  try {
    await sendSystemMail(db, campaign.space, { to: owner.email, subject: `${answer.label === 'meeting' ? 'Meeting' : 'Interested'}: ${company || lead.email} · ${campaign.name}`, text });
  } catch (e: any) {
    console.error(`[agent] could not email ${owner.email} about ${lead.email}: ${e?.message ?? e}`);
  }
}

/** The worker's pass: every reply waiting for the agent, oldest first, within the daily cap. */
export async function classifyPending(db: Db, opts: { limit?: number; deps?: Deps; now?: Date } = {}): Promise<{ waiting: number; done: number; failed: number; skipped: number; [k: string]: number }> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  const counts = { waiting: 0, done: 0, failed: 0, skipped: 0 };
  if (!jevConfigured()) return counts;
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const candidates = await c.messages.find(
    { direction: 'in', kind: 'reply', $or: [{ 'ai.status': 'pending', 'ai.nextAttemptAt': { $exists: false } }, { 'ai.status': 'pending', 'ai.nextAttemptAt': { $lte: now } }, { 'ai.status': 'running', 'ai.claimedAt': { $lt: stale } }] },
    { projection: { _id: 1 }, sort: { at: 1 }, limit: opts.limit ?? 20 }
  ).toArray();
  counts.waiting = candidates.length;
  for (const m of candidates) {
    if ((await callsToday(db, now)) >= classifierDailyCap()) break;
    const r = await classifyMessage(db, m._id, { deps: opts.deps, now });
    if (r.ok) counts.done++; else if (r.error) counts.failed++; else counts.skipped++;
  }
  return counts;
}
