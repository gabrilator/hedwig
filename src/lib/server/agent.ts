/**
 * The reply agent: reads one reply to one of our campaign emails, labels it (interested, meeting, question, not interested,
 * out of office, bounce, unsubscribe, other) and, when asked, drafts an answer for a person to review. Jev (TypeSafe's
 * classifier) labels when TYPESAFE_API_KEY is set and it answers; otherwise (no key, a rejected key, no room, down) the
 * agent's Gemini model labels. Drafts are always Gemini's. Nothing here
 * sends mail to a lead: the only email that leaves is the "someone is interested" note to the campaign's owner, through
 * Hedwig's own system mail. A status a person set is theirs: the classifier leaves that lead alone.
 *
 * Idempotency (Law 3): a message is claimed with one atomic findOneAndUpdate (ai.status pending → running). Two workers,
 * a worker and a button, a retry after a crash: the classifier is asked once per reply, at most three times after
 * failures, never in parallel; a draft is at most one more call. A hard daily cap on model calls (GEMINI_DAILY_CAP)
 * keeps a runaway inbox from becoming a bill.
 */
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { classifierConfigured, env, envOpt, geminiConfigured, geminiDailyCap, jevConfigured } from './env';
import { applyLeadStatus } from './campaigns';
import { sendSystemMail } from './systemMail';
import { AI_LABELS, type AgentDoc, type AiLabel, type CampaignDoc, type LeadDoc, type LeadStatus, type MessageDoc, type SpaceKey } from './types';

export const DEFAULT_AGENT_NAME = 'Triage';
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' }
];
/** The built-in agent knows nothing about you until you tell it: the persona is yours to write on the Agents screen. */
export const DEFAULT_PERSONA = '';
export const LABEL_TEXT: Record<AiLabel, string> = {
  interested: 'Interested', meeting: 'Meeting', question: 'Question', not_interested: 'Not interested',
  out_of_office: 'Out of office', bounce: 'Bounce', unsubscribe: 'Unsubscribe', other: 'Other'
};
/** What each label means: the Gemini prompt's list and Jev's choices, from one place. */
export const LABEL_MEANING: Record<AiLabel, string> = {
  interested: 'wants to know more, asks for information, prices, a demo or a call, or says yes.',
  meeting: 'proposes, accepts or confirms a meeting, call or specific date/time.',
  question: 'asks something (who we are, how it works) without a clear yes or no.',
  not_interested: 'declines, says no, not now, already has a solution, or asks us to stop.',
  out_of_office: 'an automatic absence reply.',
  bounce: 'a delivery failure notice from a mail system.',
  unsubscribe: 'asks to be removed, no more emails, or complains about spam.',
  other: 'forwards to someone else without a stance, empty, unrelated, or a signature only.'
};
/** Jev's stable alias, so a retired version never stops the labels; the version that answered is kept with each label. */
export const JEV_MODEL = 'jev-latest';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
/** Replies worth an answer: the only ones a draft is written for. */
const DRAFTABLE: AiLabel[] = ['interested', 'meeting', 'question'];
/** Below this the agent labels but does not touch the lead's status. */
export const APPLY_CONFIDENCE = 0.75;
/** From this the owner gets the "interested" email. */
export const NOTIFY_CONFIDENCE = 0.6;
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 15 * 60_000;

// ---------- the built-in agent ----------

/** The space's "Reply triage" agent: created on first use, one per space, never deleted. */
export async function ensureDefaultAgent(db: Db, space: SpaceKey, ownerUserId: ObjectId): Promise<AgentDoc> {
  const c = cols(db);
  const found = await c.agents.findOne({ space, builtin: true });
  if (found) return found;
  const doc: AgentDoc = { _id: new ObjectId(), space, ownerUserId, name: DEFAULT_AGENT_NAME, model: DEFAULT_MODEL, persona: DEFAULT_PERSONA, mode: 'classify', active: true, builtin: true, createdAt: new Date() };
  try { await c.agents.insertOne(doc); return doc; }
  catch (e: any) { if (e?.code === 11000) return (await c.agents.findOne({ space, builtin: true }))!; throw e; }
}

/** The agent that handles a campaign's replies: none when switched off, the chosen one, else the space's built-in one. */
export async function effectiveAgent(db: Db, campaign: Pick<CampaignDoc, 'space' | 'ownerUserId' | 'agentId' | 'agentOff'>): Promise<AgentDoc | null> {
  if (campaign.agentOff) return null;
  if (campaign.agentId) {
    const a = await cols(db).agents.findOne({ _id: campaign.agentId });
    if (a) return a;
  }
  return ensureDefaultAgent(db, campaign.space, campaign.ownerUserId);
}

/** What a campaign's agent does, in one line for the screens. */
export function describeAgent(a: AgentDoc | null): string {
  if (!a) return 'No agent on this campaign: replies are only matched and stopped, never labelled.';
  if (!a.active) return `${a.name} is switched off on the Agents screen.`;
  const what = a.mode === 'draft' ? 'reads every reply once, labels its sentiment and writes a draft answer for you to review' : 'reads every reply once and labels its sentiment (interested, meeting, question, not interested, out of office, unsubscribe)';
  return `${a.name} ${what}. Interested and meeting replies email the campaign owner. It never sends anything to a lead.`;
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

export function buildPrompt(input: { agent: AgentDoc; campaign: Pick<CampaignDoc, 'name' | 'agentRules'>; lead: Pick<LeadDoc, 'email' | 'vars'>; thread: ThreadItem[]; target: ThreadItem; wantDraft: boolean; fromName?: string }): { system: string; user: string } {
  const { agent, campaign, lead, thread, target, wantDraft } = input;
  const rules = (campaign.agentRules ?? []).filter((r) => r.if || r.then).map((r) => `- when ${r.if || '…'}: ${r.then || '…'}`).join('\n');
  const system = [
    'You are the reply-triage assistant of a cold-email tool. You read ONE reply someone sent to our outreach email and say how they feel about it: one label, a confidence, one line of reason.',
    agent.persona ? `About us: ${agent.persona}` : 'Nothing is known about the sender beyond the thread itself.',
    'Labels:',
    ...AI_LABELS.map((l) => `- ${l}: ${LABEL_MEANING[l]}`),
    'confidence is 0 to 1. reason is one short sentence in English quoting the decisive words. language is the ISO code of the reply.',
    wantDraft
      ? `Also write draft: the answer we would send, in the language of the reply, from ${input.fromName || 'us'}, plain text, short, no subject line, no signature block beyond the first name, no placeholders in brackets. For not_interested, unsubscribe, out_of_office, bounce and other, draft must be an empty string.${rules ? `\nRules for the answer:\n${rules}` : ''}`
      : 'Do not write a draft.',
    'Answer with JSON only.'
  ].filter(Boolean).join('\n');
  const who = [lead.vars?.contactPerson ?? lead.vars?.firstName, lead.vars?.companyName ?? lead.vars?.company].filter(Boolean).join(' · ');
  const fmt = (d: Date) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');
  const lines: string[] = [`Campaign: ${campaign.name}`, `Lead: ${lead.email}${who ? ` (${who})` : ''}`, '', 'Thread so far, oldest first:'];
  for (const m of thread) {
    const isTarget = m === target;
    const body = isTarget ? stripQuoted(m.text) : stripQuoted(m.text, 1500);
    lines.push(`--- ${m.direction === 'out' ? 'US' : 'THEM'} · ${fmt(m.at)}${isTarget ? ' · THE REPLY TO CLASSIFY' : ''}`, `Subject: ${m.subject || '(same thread)'}`, body, '');
  }
  lines.push(`Classify the message marked THE REPLY TO CLASSIFY (from ${target.from}).`);
  return { system, user: lines.join('\n') };
}

// ---------- Gemini ----------

export interface ModelAnswer { label: AiLabel; confidence: number; reason: string; language?: string; draft?: string; odds?: Partial<Record<AiLabel, number>> }

export function parseModelJson(text: string): ModelAnswer {
  let raw: any;
  try { raw = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Model did not return JSON: ${text.slice(0, 120)}`);
    raw = JSON.parse(m[0]);
  }
  const label = (AI_LABELS as readonly string[]).includes(raw?.label) ? (raw.label as AiLabel) : 'other';
  const n = Number(raw?.confidence);
  const confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n > 1 ? n / 100 : n)) : 0;
  return {
    label, confidence, reason: String(raw?.reason ?? '').slice(0, 300),
    language: raw?.language ? String(raw.language).slice(0, 8) : undefined,
    draft: typeof raw?.draft === 'string' && raw.draft.trim() ? raw.draft.trim().slice(0, 4000) : undefined
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface Deps { fetch?: FetchLike }

export class ModelError extends Error { constructor(message: string, public transient: boolean) { super(message); } }

function responseSchema(wantDraft: boolean) {
  const properties: Record<string, unknown> = {
    label: { type: 'STRING', enum: [...AI_LABELS] },
    confidence: { type: 'NUMBER' },
    reason: { type: 'STRING' },
    language: { type: 'STRING' }
  };
  if (wantDraft) properties.draft = { type: 'STRING' };
  return { type: 'OBJECT', properties, required: ['label', 'confidence', 'reason'] };
}

/** One generateContent call. Throws ModelError; `transient` says whether a later retry makes sense. */
export async function callGemini(model: string, prompt: { system: string; user: string }, wantDraft: boolean, deps: Deps = {}): Promise<{ answer: ModelAnswer; tokens: { prompt: number; output: number } }> {
  const f = deps.fetch ?? fetch;
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: 0.2, maxOutputTokens: wantDraft ? 1500 : 400, responseMimeType: 'application/json', responseSchema: responseSchema(wantDraft),
      ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {})
    }
  };
  let res: Response;
  try {
    res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000)
    });
  } catch (e: any) { throw new ModelError(`Gemini unreachable: ${e?.message ?? e}`, true); }
  const text = await res.text();
  let json: any = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
  if (!res.ok) {
    const msg = json?.error?.message ?? text.slice(0, 200);
    throw new ModelError(`Gemini ${res.status}: ${msg}`, res.status === 429 || res.status >= 500);
  }
  const part = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  if (!part) throw new ModelError(`Gemini returned no text (${json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? 'empty'})`, false);
  const answer = parseModelJson(part);
  const u = json?.usageMetadata ?? {};
  return { answer, tokens: { prompt: Number(u.promptTokenCount ?? 0), output: Number(u.candidatesTokenCount ?? 0) } };
}

// ---------- Jev ----------

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
  const label = (AI_LABELS as readonly string[]).includes(a.choice) ? (a.choice as AiLabel) : 'other';
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
    case 'not_interested': return AUTO.includes(current) ? 'not_interested' : null;
    case 'unsubscribe': return current === 'unsubscribed' || current === 'bounced' ? null : 'unsubscribed';
    default: return null;
  }
}

export const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function callsToday(db: Db, now = new Date()): Promise<number> {
  return cols(db).llmCalls.countDocuments({ at: { $gte: startOfUtcDay(now) } });
}

/** For the Setup screen: is the key there, how often the model was asked, the last error. Instance-wide. */
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
  return { configured: classifierConfigured(), jev: jevConfigured(), gemini: geminiConfigured(), cap: geminiDailyCap(), today, month, failedToday: failed, lastError: last ? { at: last.at, error: last.error ?? '' } : null, pending };
}

export interface ClassifyResult { ok: boolean; label?: AiLabel; confidence?: number; draft?: string; skipped?: string; error?: string }

interface ClassifyOpts { purpose?: 'classify' | 'draft'; force?: boolean; deps?: Deps; now?: Date }

/**
 * Label one inbound reply (and draft an answer if the agent or the caller wants one). Claims the message first; a message
 * that is not pending (already done, running, failed for good) is left alone unless `force` (a button) says otherwise.
 * Jev labels when its key is set; when it cannot answer, or has no key, Gemini labels. A draft is Gemini's, one more call
 * after a Jev label, only for a reply worth answering.
 * A lead whose status a person set is skipped; "Label again" (force) hands it back to the classifier.
 */
export async function classifyMessage(db: Db, messageId: ObjectId, opts: ClassifyOpts = {}): Promise<ClassifyResult> {
  const c = cols(db);
  const now = opts.now ?? new Date();
  const purpose = opts.purpose ?? 'classify';
  if (purpose === 'draft' && !geminiConfigured()) return { ok: false, skipped: 'GEMINI_API_KEY is not set' };
  if (!classifierConfigured()) return { ok: false, skipped: 'no model key is set' };
  const byJev = purpose === 'classify' && jevConfigured();
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
  if (purpose === 'classify' && lead.statusBy) {
    if (!opts.force) { await giveBack({ 'ai.status': 'skipped', 'ai.error': `status set by hand by ${lead.statusBy}` }); return { ok: false, skipped: 'status set by hand' }; }
    await c.leads.updateOne({ _id: lead._id }, { $unset: { statusBy: '' } });
  }
  if ((await callsToday(db, now)) >= geminiDailyCap()) { await giveBack({ 'ai.status': 'pending', 'ai.nextAttemptAt': new Date(now.getTime() + 60 * 60_000) }); return { ok: false, skipped: 'daily cap reached' }; }

  const account = await c.emailAccounts.findOne({ _id: msg.accountId }, { projection: { fromName: 1 } });
  const history = await c.messages.find({ leadId: lead._id, at: { $lte: msg.at }, kind: { $in: ['sent', 'reply', 'manual'] } }, { sort: { at: 1 }, limit: 8, projection: { direction: 1, kind: 1, from: 1, subject: 1, text: 1, at: 1 } }).toArray();
  const thread: ThreadItem[] = history.map((m) => ({ direction: m.direction, kind: m.kind, from: m.from, subject: m.subject, text: m.text, at: m.at }));
  let target = thread.find((t) => t.at.getTime() === msg.at.getTime() && t.direction === 'in' && t.from === msg.from);
  if (!target) { target = { direction: 'in', kind: msg.kind, from: msg.from, subject: msg.subject, text: msg.text, at: msg.at }; thread.push(target); }
  const wantDraft = purpose === 'draft' || agent.mode === 'draft';
  const geminiModel = agent.model || DEFAULT_MODEL;
  const geminiPrompt = (draft: boolean) => buildPrompt({ agent, campaign, lead, thread, target, wantDraft: draft, fromName: account?.fromName });
  const logCall = (model: string, callPurpose: 'classify' | 'draft', started: number, result: { tokens?: { prompt: number; output: number }; error?: string }) =>
    c.llmCalls.insertOne({ _id: new ObjectId(), space: lead.space, at: now, model, purpose: callPurpose, messageId: msg._id, ok: !result.error, ms: Date.now() - started, ...result });

  const errorOf = (e: unknown) => String((e as any)?.message ?? e).slice(0, 500);
  let answer: ModelAnswer | null = null;
  let model = geminiModel;
  let failure: unknown = null;
  // Jev first when its key is set; when it cannot answer (a rejected key, no room, down) Gemini labels this reply instead.
  if (byJev) {
    const t0 = Date.now();
    try {
      const r = await callJev(buildJevRequest({ thread, target }), opts.deps);
      ({ answer, model } = r);
      await logCall(r.model, purpose, t0, { tokens: r.tokens });
    } catch (e) { failure = e; await logCall(JEV_MODEL, purpose, t0, { error: errorOf(e) }); }
  }
  const jevLabelled = !!answer;
  if (!answer && geminiConfigured()) {
    const t0 = Date.now();
    try {
      const r = await callGemini(geminiModel, geminiPrompt(wantDraft), wantDraft, opts.deps);
      ({ answer } = r); model = geminiModel;
      await logCall(geminiModel, purpose, t0, { tokens: r.tokens });
    } catch (e) { failure = e; await logCall(geminiModel, purpose, t0, { error: errorOf(e) }); }
  }
  if (!answer) {
    const error = errorOf(failure);
    const retry = failure instanceof ModelError && failure.transient && attempts < MAX_ATTEMPTS;
    await giveBack(retry ? { 'ai.status': 'pending', 'ai.nextAttemptAt': new Date(now.getTime() + attempts * 10 * 60_000), 'ai.error': error } : { 'ai.status': 'failed', 'ai.error': error });
    return { ok: false, error };
  }

  // Jev only labels: a draft is one more call, to Gemini, for a reply worth answering. If it fails the label stands.
  if (jevLabelled && agent.mode === 'draft' && DRAFTABLE.includes(answer.label) && geminiConfigured() && (await callsToday(db, now)) < geminiDailyCap()) {
    const draftStarted = Date.now();
    try {
      const d = await callGemini(geminiModel, geminiPrompt(true), true, opts.deps);
      await logCall(geminiModel, 'draft', draftStarted, { tokens: d.tokens });
      if (d.answer.draft) answer.draft = d.answer.draft;
    } catch (e: any) { await logCall(geminiModel, 'draft', draftStarted, { error: errorOf(e) }); }
  }

  // A draft asked for from the Inbox keeps the label the reply already has.
  const keepLabel = purpose === 'draft' && !!msg.ai?.label;
  const set: Record<string, unknown> = { 'ai.status': 'done', 'ai.agentId': agent._id, 'ai.at': now };
  const unset: Record<string, ''> = { 'ai.error': '', 'ai.nextAttemptAt': '' };
  if (!keepLabel) {
    Object.assign(set, { 'ai.label': answer.label, 'ai.confidence': answer.confidence, 'ai.reason': answer.reason, 'ai.language': answer.language, 'ai.model': model });
    if (answer.odds) set['ai.odds'] = answer.odds; else unset['ai.odds'] = '';
    await c.leads.updateOne({ _id: lead._id }, { $set: { ai: { label: answer.label, confidence: answer.confidence, at: now, messageId: msg._id } } });
  }
  if (answer.draft) { set['ai.draft'] = answer.draft; set['ai.draftAt'] = now; }

  if (purpose === 'classify') {
    const next = labelToStatus(answer.label, lead.status);
    if (next && answer.confidence >= APPLY_CONFIDENCE) { await applyLeadStatus(db, lead, next, `agent ${agent.name}`); set['ai.appliedStatus'] = next; }
  }
  await c.messages.updateOne({ _id: msg._id }, { $set: set, $unset: unset });

  if (purpose === 'classify' && (answer.label === 'interested' || answer.label === 'meeting') && answer.confidence >= NOTIFY_CONFIDENCE) {
    await notifyOwner(db, msg, lead, campaign, answer, now);
  }
  const label = keepLabel ? msg.ai!.label! : answer.label;
  return { ok: true, label, confidence: keepLabel ? msg.ai?.confidence ?? 0 : answer.confidence, draft: answer.draft };
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
    answer.odds ? `The agent's odds: ${answer.reason}` : `Why the agent thinks so: ${answer.reason} (confidence ${Math.round(answer.confidence * 100)}%)`, '',
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
  if (!classifierConfigured()) return counts;
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const candidates = await c.messages.find(
    { direction: 'in', kind: 'reply', $or: [{ 'ai.status': 'pending', 'ai.nextAttemptAt': { $exists: false } }, { 'ai.status': 'pending', 'ai.nextAttemptAt': { $lte: now } }, { 'ai.status': 'running', 'ai.claimedAt': { $lt: stale } }] },
    { projection: { _id: 1 }, sort: { at: 1 }, limit: opts.limit ?? 20 }
  ).toArray();
  counts.waiting = candidates.length;
  for (const m of candidates) {
    if ((await callsToday(db, now)) >= geminiDailyCap()) break;
    const r = await classifyMessage(db, m._id, { deps: opts.deps, now });
    if (r.ok) counts.done++; else if (r.error) counts.failed++; else counts.skipped++;
  }
  return counts;
}

/** "Draft with the agent" from the Inbox: one call, stores the draft on the reply, never sends. */
export async function draftForMessage(db: Db, messageId: ObjectId, deps?: Deps): Promise<ClassifyResult> {
  return classifyMessage(db, messageId, { purpose: 'draft', force: true, deps });
}
