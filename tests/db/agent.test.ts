/**
 * The reply agent and the Inbox on the local MongoDB (database hedwig_test), with a fake Gemini and a fake mailbox.
 * Proves: one model call per reply even when two runners race, status applied only forward, the owner note claimed once,
 * failures retried then given up, and a manual reply that cannot go out twice.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { classifyMessage, classifyPending, draftForMessage, ensureDefaultAgent, effectiveAgent } from '../../src/lib/server/agent';
import { backfillInbound, sendManualReply, snippetOf } from '../../src/lib/server/inbox';
import { applyLeadStatus } from '../../src/lib/server/campaigns';
import { seal } from '../../src/lib/server/crypto';
import type { CampaignDoc, EmailAccountDoc, LeadDoc, MessageDoc } from '../../src/lib/server/types';
import * as providerMod from '../../src/lib/server/mail/provider';

process.env.HEDWIG_MASTER_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.ORIGIN ||= 'http://localhost:5180';
process.env.GEMINI_API_KEY = 'test-key';
delete process.env.TYPESAFE_API_KEY; // Gemini labels unless a test turns Jev on
delete process.env.RESEND_API_KEY;

const sent: { to: string; subject: string; text: string; html: string; thread: any; sendId: string }[] = [];
const fakeProvider = {
  kind: 'imapSmtp' as const,
  async test() { return { ok: true, detail: 'fake' }; },
  async send(mail: any, thread: any, onPrepared?: (ids: any) => Promise<void>) {
    const ids = { internetMessageId: `<${mail.sendId}@fake>` };
    if (onPrepared) await onPrepared(ids);
    sent.push({ to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, thread, sendId: mail.sendId });
    return ids;
  },
  async fetchNew() { return { items: [], state: {} }; },
  async getMessage(): Promise<any> { throw new Error('n/a'); },
  async findSent() { return { found: false }; }
};
vi.spyOn(providerMod, 'providerFor').mockImplementation(() => fakeProvider as any);

let calls = 0;
let answer: any = { label: 'interested', confidence: 0.9, reason: 'asks for a call', language: 'es' };
let failWith: number | null = null;
const gemini = async (_url: string, _init: RequestInit) => {
  calls++;
  await new Promise((r) => setTimeout(r, 30)); // long enough for a racing runner to try the same message
  if (failWith) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: failWith });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
};
const deps = { fetch: gemini };

let db: Db;
const space = 'user:' + new ObjectId().toHexString();
const owner = new ObjectId();
const now = new Date('2026-09-15T10:00:00Z');

function account(): EmailAccountDoc {
  return { _id: new ObjectId(), space, ownerUserId: owner, address: `box${Math.random().toString(36).slice(2, 7)}@test.local`, fromName: 'Alex', kind: 'imapSmtp', status: 'active', dailyLimit: 40, ramp: { enabled: false, startedAt: now }, secrets: seal({ imapPass: 'x', smtpPass: 'x' }), imap: { host: 'h', port: 993, secure: true, user: 'u' }, smtp: { host: 'h', port: 465, secure: true, user: 'u' }, sync: {}, createdAt: now };
}
function campaign(accountIds: ObjectId[], over: Partial<CampaignDoc> = {}): CampaignDoc {
  return { _id: new ObjectId(), space, ownerUserId: owner, name: 'Sept', status: 'active', schedule: { timezone: 'Europe/Madrid', from: '09:00', to: '15:00', days: [1, 2, 3, 4, 5] }, steps: [{ subject: 'Una pregunta', body: 'Hola', delayDays: 0 }, { subject: null, body: 'Seguimiento', delayDays: 2 }], accountIds, dailyLimit: 30, stopOnReply: true, oooStops: false, openTracking: true, testRecipient: 't@test.local', unsubscribeLine: '', agentId: null, agentRules: [], createdAt: now, updatedAt: now, ...over };
}
function lead(cp: CampaignDoc, acc: EmailAccountDoc, i: number, status: LeadDoc['status'] = 'replied'): LeadDoc {
  return { _id: new ObjectId(), campaignId: cp._id, space, email: `dir${i}@empresa${i}.example`, domain: `empresa${i}.example`, vars: { companyName: `Empresa ${i}` }, provider: 'unknown', accountId: acc._id, currentStep: 1, nextDueAt: null, status, thread: { internetMessageId: `<step1-${i}@test.local>`, subject: 'Una pregunta' }, createdAt: now };
}
function reply(cp: CampaignDoc, acc: EmailAccountDoc, l: LeadDoc, text = 'Sí, nos interesa. ¿Hablamos?'): MessageDoc {
  return { _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, accountId: acc._id, direction: 'in', kind: 'reply', internetMessageId: `<r-${l._id}@empresa>`, from: l.email, to: acc.address, subject: 'Re: Una pregunta', text, at: now, ai: { status: 'pending' } };
}

beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); await cols(db).users.insertOne({ _id: owner, email: 'owner@test.local', name: 'Owner', passwordHash: 'x', createdAt: now }); });
afterAll(async () => { await db.dropDatabase(); await closeDb(); });

describe('reply agent', () => {
  it('creates one built-in agent per space and every campaign without a choice uses it', async () => {
    const a1 = await ensureDefaultAgent(db, space, owner);
    const a2 = await ensureDefaultAgent(db, space, owner);
    expect(a2._id.equals(a1._id)).toBe(true);
    expect(await cols(db).agents.countDocuments({ space, builtin: true })).toBe(1);
    const acc = account(); const cp = campaign([acc._id]);
    expect((await effectiveAgent(db, cp))?._id.equals(a1._id)).toBe(true);
    expect(await effectiveAgent(db, { ...cp, agentOff: true })).toBeNull();
    expect(a1.persona).toBe('');
    expect(a1.name).toBe('Triage');
  });

  it('asks the model once per reply even when two runners race, applies the status forward, emails the owner once', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 1); await c.leads.insertOne(l);
    await c.sends.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, stepIndex: 1, accountId: acc._id, dueAt: now, status: 'planned', attempt: 0, tokens: { open: 'o1', unsub: 'u1' }, createdAt: now });
    const m = reply(cp, acc, l); await c.messages.insertOne(m);
    calls = 0;
    const [r1, r2] = await Promise.all([classifyPending(db, { deps, now }), classifyPending(db, { deps, now })]);
    expect(calls).toBe(1);
    expect(r1.done + r2.done).toBe(1);
    const after = await c.messages.findOne({ _id: m._id });
    expect(after?.ai).toMatchObject({ status: 'done', label: 'interested', confidence: 0.9, attempts: 1, appliedStatus: 'interested' });
    expect(after?.ai?.notifiedAt).toBeInstanceOf(Date);
    const ld = await c.leads.findOne({ _id: l._id });
    expect(ld?.status).toBe('interested');
    expect(ld?.ai?.label).toBe('interested');
    expect((await c.sends.findOne({ leadId: l._id }))?.status).toBe('cancelled');
    expect(await c.llmCalls.countDocuments({ space, ok: true })).toBe(1);
    // a third pass finds nothing to do; the owner note is not sent again
    calls = 0;
    expect((await classifyPending(db, { deps, now })).waiting).toBe(0);
    expect(calls).toBe(0);
    // labelling again by hand is one more call, and still no second note
    await classifyMessage(db, m._id, { deps, now, force: true });
    expect(calls).toBe(1);
    expect((await c.messages.findOne({ _id: m._id }))?.ai?.notifiedAt).toEqual(after?.ai?.notifiedAt);
  });

  it('never overwrites a status set by hand and stays quiet below the confidence bar', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const won = lead(cp, acc, 2, 'won'); await c.leads.insertOne(won);
    const m1 = reply(cp, acc, won); await c.messages.insertOne(m1);
    answer = { label: 'not_interested', confidence: 0.95, reason: 'says no' };
    await classifyMessage(db, m1._id, { deps, now });
    expect((await c.leads.findOne({ _id: won._id }))?.status).toBe('won');
    expect((await c.messages.findOne({ _id: m1._id }))?.ai?.appliedStatus).toBeUndefined();
    const unsure = lead(cp, acc, 3); await c.leads.insertOne(unsure);
    const m2 = reply(cp, acc, unsure); await c.messages.insertOne(m2);
    answer = { label: 'interested', confidence: 0.5, reason: 'maybe' };
    await classifyMessage(db, m2._id, { deps, now });
    const ld = await c.leads.findOne({ _id: unsure._id });
    expect(ld?.status).toBe('replied');
    expect(ld?.ai).toMatchObject({ label: 'interested', confidence: 0.5 });
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.notifiedAt).toBeUndefined();
    answer = { label: 'interested', confidence: 0.9, reason: 'asks for a call', language: 'es' };
  });

  it('retries a transient failure later, gives up on a final one, and skips when the campaign has no agent', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 4); await c.leads.insertOne(l);
    const m = reply(cp, acc, l); await c.messages.insertOne(m);
    failWith = 503;
    await classifyMessage(db, m._id, { deps, now });
    let doc = await c.messages.findOne({ _id: m._id });
    expect(doc?.ai?.status).toBe('pending');
    expect(doc?.ai?.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect((await classifyPending(db, { deps, now })).waiting).toBe(0); // not before nextAttemptAt
    const later = new Date(now.getTime() + 11 * 60_000);
    failWith = 400;
    await classifyPending(db, { deps, now: later });
    doc = await c.messages.findOne({ _id: m._id });
    expect(doc?.ai?.status).toBe('failed');
    expect(doc?.ai?.attempts).toBe(2);
    failWith = null;
    const off = campaign([acc._id], { agentOff: true }); await c.campaigns.insertOne(off);
    const l2 = lead(off, acc, 5); await c.leads.insertOne(l2);
    const m2 = reply(off, acc, l2); await c.messages.insertOne(m2);
    calls = 0;
    const r = await classifyMessage(db, m2._id, { deps, now });
    expect(r.skipped).toMatch(/no agent/);
    expect(calls).toBe(0);
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.status).toBe('skipped');
  });

  it('writes a draft on request without touching the status', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 6, 'meeting'); await c.leads.insertOne(l);
    const m = reply(cp, acc, l); await c.messages.insertOne(m);
    answer = { label: 'interested', confidence: 0.9, reason: 'r', draft: 'Hola, encantado. ¿Le va bien el jueves?' };
    const r = await draftForMessage(db, m._id, deps);
    expect(r.ok).toBe(true);
    expect((await c.messages.findOne({ _id: m._id }))?.ai?.draft).toContain('jueves');
    expect((await c.leads.findOne({ _id: l._id }))?.status).toBe('meeting');
    answer = { label: 'interested', confidence: 0.9, reason: 'asks for a call', language: 'es' };
  });
});

describe('Jev labels, Gemini drafts', () => {
  const jevCalls: any[] = [];
  let geminiCalls = 0;
  let jevAnswer: { choice: string; probabilities: Record<string, number> } = { choice: 'interested', probabilities: { interested: 0.92, question: 0.05, other: 0.03 } };
  let jevFail: number | null = null;
  const both = async (url: string, init: RequestInit) => {
    if (url.includes('typesafe')) {
      jevCalls.push(JSON.parse(String(init.body)));
      if (jevFail) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: jevFail });
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { label: { type: 'choice', ...jevAnswer, confidence: 0.9 } }, usage: { input_tokens: 300, output_tokens: 1 } }), { status: 200 });
    }
    geminiCalls++;
    const wantsDraft = !!JSON.parse(String(init.body)).generationConfig?.responseSchema?.properties?.draft;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ label: 'not_interested', confidence: 0.99, reason: 'another reading', ...(wantsDraft ? { draft: 'Hola, ¿el jueves a las 10?' } : {}) }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  };
  const jdeps = { fetch: both };
  const reset = () => { jevCalls.length = 0; geminiCalls = 0; jevFail = null; };
  beforeAll(() => { process.env.TYPESAFE_API_KEY = 'jev-key'; });
  afterAll(() => { delete process.env.TYPESAFE_API_KEY; });

  it('labels with one Jev call, applies the status and emails the owner at the same bars, and shows the odds', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 11); await c.leads.insertOne(l);
    await c.messages.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, accountId: acc._id, direction: 'out', kind: 'sent', from: acc.address, to: l.email, subject: 'Una pregunta', text: 'Hola, ¿os interesa?', at: new Date(now.getTime() - 864e5) });
    const m = reply(cp, acc, l, 'Sí, nos interesa.\n\nEl lun, Alex escribió:\n> Hola, ¿os interesa?'); await c.messages.insertOne(m);
    const r = await classifyMessage(db, m._id, { deps: jdeps, now });
    expect(r).toMatchObject({ ok: true, label: 'interested', confidence: 0.92 });
    expect(jevCalls).toHaveLength(1);
    expect(geminiCalls).toBe(0);
    expect(jevCalls[0].state).toMatchObject({ their_reply: 'Sí, nos interesa.', our_last_email: 'Hola, ¿os interesa?' });
    const after = await c.messages.findOne({ _id: m._id });
    expect(after?.ai).toMatchObject({ status: 'done', label: 'interested', confidence: 0.92, reason: 'Interested 92% · Question 5%', model: 'jev-1.13.0', appliedStatus: 'interested' });
    expect(after?.ai?.notifiedAt).toBeInstanceOf(Date);
    expect((await c.leads.findOne({ _id: l._id }))?.status).toBe('interested');
    expect(await c.llmCalls.findOne({ messageId: m._id })).toMatchObject({ model: 'jev-1.13.0', purpose: 'classify', ok: true, tokens: { prompt: 300, output: 1 } });
  });

  it('drafts with Gemini only for replies worth answering, and the label stays Jev\'s', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const drafter = { _id: new ObjectId(), space, ownerUserId: owner, name: 'Closer', model: 'gemini-2.5-flash', persona: '', mode: 'draft' as const, active: true, createdAt: now };
    await c.agents.insertOne(drafter);
    const cp = campaign([acc._id], { agentId: drafter._id }); await c.campaigns.insertOne(cp);
    const l1 = lead(cp, acc, 12); await c.leads.insertOne(l1);
    const m1 = reply(cp, acc, l1, '¿Cuánto cuesta?'); await c.messages.insertOne(m1);
    jevAnswer = { choice: 'question', probabilities: { question: 0.7, interested: 0.3 } };
    await classifyMessage(db, m1._id, { deps: jdeps, now });
    expect(jevCalls).toHaveLength(1);
    expect(geminiCalls).toBe(1);
    expect((await c.messages.findOne({ _id: m1._id }))?.ai).toMatchObject({ label: 'question', confidence: 0.7, model: 'jev-1.13.0', draft: 'Hola, ¿el jueves a las 10?' });
    expect(await c.llmCalls.countDocuments({ messageId: m1._id, purpose: 'draft', model: 'gemini-2.5-flash', ok: true })).toBe(1);
    reset();
    const l2 = lead(cp, acc, 13); await c.leads.insertOne(l2);
    const m2 = reply(cp, acc, l2, 'No, gracias.'); await c.messages.insertOne(m2);
    jevAnswer = { choice: 'not_interested', probabilities: { not_interested: 0.95, other: 0.05 } };
    await classifyMessage(db, m2._id, { deps: jdeps, now });
    expect(jevCalls).toHaveLength(1);
    expect(geminiCalls).toBe(0);
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.draft).toBeUndefined();
    // a draft asked for in the Inbox is Gemini's, and the reply keeps Jev's label
    reset();
    expect(await draftForMessage(db, m2._id, jdeps)).toMatchObject({ ok: true, label: 'not_interested' });
    expect(jevCalls).toHaveLength(0);
    expect(geminiCalls).toBe(1);
    expect((await c.messages.findOne({ _id: m2._id }))?.ai).toMatchObject({ label: 'not_interested', model: 'jev-1.13.0', draft: 'Hola, ¿el jueves a las 10?' });
    jevAnswer = { choice: 'interested', probabilities: { interested: 0.92, question: 0.05, other: 0.03 } };
  });

  it('leaves a lead alone once a person set its status, until Label again hands it back', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 14); await c.leads.insertOne(l);
    await applyLeadStatus(db, l, 'meeting', 'someone@test.local', { byPerson: true });
    expect((await c.leads.findOne({ _id: l._id }))?.statusBy).toBe('someone@test.local');
    const m = reply(cp, acc, l, 'Perfecto, hablamos.'); await c.messages.insertOne(m);
    expect((await classifyMessage(db, m._id, { deps: jdeps, now })).skipped).toMatch(/by hand/);
    expect(jevCalls).toHaveLength(0);
    expect((await c.messages.findOne({ _id: m._id }))?.ai?.status).toBe('skipped');
    // a status the agent sets is not a person's
    const l2 = lead(cp, acc, 15); await c.leads.insertOne(l2);
    await applyLeadStatus(db, l2, 'interested', 'agent Triage');
    expect((await c.leads.findOne({ _id: l2._id }))?.statusBy).toBeUndefined();
    // Label again: the person hands the lead back, and the agent labels it
    expect(await classifyMessage(db, m._id, { deps: jdeps, now, force: true })).toMatchObject({ ok: true, label: 'interested' });
    expect(jevCalls).toHaveLength(1);
    const ld = await c.leads.findOne({ _id: l._id });
    expect(ld?.statusBy).toBeUndefined();
    expect(ld?.status).toBe('meeting'); // interested never moves a meeting back
  });

  it('lets Gemini label the reply in the same attempt when Jev cannot answer', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 16); await c.leads.insertOne(l);
    const m = reply(cp, acc, l, 'No, gracias.'); await c.messages.insertOne(m);
    jevFail = 401; // a rejected key; no room and an outage go the same way
    expect(await classifyMessage(db, m._id, { deps: jdeps, now })).toMatchObject({ ok: true, label: 'not_interested', confidence: 0.99 });
    expect(jevCalls).toHaveLength(1);
    expect(geminiCalls).toBe(1);
    expect((await c.messages.findOne({ _id: m._id }))?.ai).toMatchObject({ status: 'done', label: 'not_interested', model: 'gemini-2.5-flash', reason: 'another reading', attempts: 1 });
    expect((await c.messages.findOne({ _id: m._id }))?.ai?.draft).toBeUndefined();
    expect((await c.leads.findOne({ _id: l._id }))?.status).toBe('not_interested');
    const logged = await c.llmCalls.find({ messageId: m._id }, { sort: { _id: 1 } }).toArray();
    expect(logged.map((x) => [x.model, x.ok])).toEqual([['jev-latest', false], ['gemini-2.5-flash', true]]);
    expect(logged[0].error).toBe('Jev 401: nope');
  });

  it('without Gemini, a Jev failure is retried later or given up', async () => {
    reset();
    const gemini = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const c = cols(db);
      const acc = account(); await c.emailAccounts.insertOne(acc);
      const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
      const l = lead(cp, acc, 17); await c.leads.insertOne(l);
      const m = reply(cp, acc, l); await c.messages.insertOne(m);
      jevFail = 529;
      await classifyMessage(db, m._id, { deps: jdeps, now });
      expect((await c.messages.findOne({ _id: m._id }))?.ai).toMatchObject({ status: 'pending', error: 'Jev 529: nope' });
      jevFail = 401;
      await classifyMessage(db, m._id, { deps: jdeps, now: new Date(now.getTime() + 11 * 60_000) });
      expect((await c.messages.findOne({ _id: m._id }))?.ai).toMatchObject({ status: 'failed', attempts: 2 });
      expect(geminiCalls).toBe(0);
    } finally { process.env.GEMINI_API_KEY = gemini; jevFail = null; }
  });
});

describe('manual reply from the Inbox', () => {
  it('sends once per nonce as a reply to their last email, quotes it, stops the sequence, threads the next answer', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 7, 'contacted'); await c.leads.insertOne(l);
    await c.sends.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, stepIndex: 1, accountId: acc._id, dueAt: now, status: 'planned', attempt: 0, tokens: { open: 'o7', unsub: 'u7' }, createdAt: now });
    const m = reply(cp, acc, l, 'Buenas, ¿qué precio tiene?'); m.conversationId = 'conv-7'; await c.messages.insertOne(m);
    sent.length = 0;
    const nonce = 'n-' + new ObjectId().toHexString();
    const r = await sendManualReply(db, { lead: l, campaign: cp, account: acc, html: '<p>Hola, <b>120 €</b> al año. <a href="https://example.com/precios">Precios</a></p>', nonce, byUserId: owner });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(l.email);
    expect(sent[0].subject).toBe('Re: Una pregunta');
    expect(sent[0].thread).toEqual({ internetMessageId: m.internetMessageId, conversationId: 'conv-7' });
    expect(sent[0].text).toContain('120 € al año');
    expect(sent[0].text).toContain('> Buenas, ¿qué precio tiene?');
    expect(sent[0].html).toContain('<b>120 €</b>');
    expect(sent[0].html).toContain('Buenas, ¿qué precio tiene?');
    const doc = await c.messages.findOne({ _id: r.messageId });
    expect(doc).toMatchObject({ kind: 'manual', status: 'sent', direction: 'out', internetMessageId: r.internetMessageId });
    const ld = await c.leads.findOne({ _id: l._id });
    expect(ld?.thread?.internetMessageId).toBe(r.internetMessageId);
    expect(ld?.lastAnsweredAt).toBeInstanceOf(Date);
    expect((await c.sends.findOne({ leadId: l._id }))?.status).toBe('cancelled');
    await expect(sendManualReply(db, { lead: l, campaign: cp, account: acc, html: '<p>again</p>', nonce, byUserId: owner })).rejects.toThrow(/already sent/);
    expect(sent).toHaveLength(1);
    await expect(sendManualReply(db, { lead: l, campaign: cp, account: acc, html: '<p> </p>', nonce: 'n2-' + new ObjectId().toHexString(), byUserId: owner })).rejects.toThrow(/Write something/);
  });
});

describe('inbox backfill', () => {
  it('summarises old inbound mail on the lead once and queues recent replies for the agent', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 8); delete (l as any).lastInboundAt; await c.leads.insertOne(l);
    const old = reply(cp, acc, l, 'old one'); delete old.ai; old.at = new Date('2026-01-01T00:00:00Z'); await c.messages.insertOne(old);
    const fresh = reply(cp, acc, l, 'fresh one, the last word'); delete fresh.ai; fresh.at = new Date(); await c.messages.insertOne(fresh);
    const r = await backfillInbound(db);
    expect(r.leads).toBeGreaterThanOrEqual(1);
    const ld = await c.leads.findOne({ _id: l._id });
    expect(ld?.lastInbound?.snippet).toBe(snippetOf('fresh one, the last word'));
    expect(ld?.lastInbound?.messageId.equals(fresh._id)).toBe(true);
    expect((await c.messages.findOne({ _id: fresh._id }))?.ai?.status).toBe('pending');
    expect((await c.messages.findOne({ _id: old._id }))?.ai?.status).toBe('skipped');
    expect(await backfillInbound(db)).toEqual({ leads: 0, queued: 0 });
  });
});

describe('duplicate campaign', () => {
  it('copies steps, schedule, mailboxes and options into a fresh draft, and leaves leads, sends and stats behind', async () => {
    const { duplicateCampaign } = await import('../../src/lib/server/campaigns');
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id], { status: 'active', startedAt: now, dailyLimit: 17, stopOnReply: false, agentRules: [{ if: 'x', then: 'y' }] }); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 9); await c.leads.insertOne(l);
    await c.sends.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, stepIndex: 1, accountId: acc._id, dueAt: now, status: 'planned', attempt: 0, tokens: { open: 'o9', unsub: 'u9' }, createdAt: now });
    const id = await duplicateCampaign(db, cp, owner);
    const copy = (await c.campaigns.findOne({ _id: id }))!;
    expect(copy.name).toBe('Sept (copy)');
    expect(copy.status).toBe('draft');
    expect(copy.startedAt).toBeUndefined();
    expect(copy.steps).toEqual(cp.steps);
    expect(copy.schedule).toEqual(cp.schedule);
    expect(copy.accountIds.map(String)).toEqual([acc._id.toHexString()]);
    expect(copy).toMatchObject({ dailyLimit: 17, stopOnReply: false, agentRules: [{ if: 'x', then: 'y' }], space });
    expect(await c.leads.countDocuments({ campaignId: id })).toBe(0);
    expect(await c.sends.countDocuments({ campaignId: id })).toBe(0);
    expect(await c.leads.countDocuments({ campaignId: cp._id })).toBe(1);
  });
});

describe('open tracking', () => {
  it('counts every pixel hit, but a person\'s opens once per minute, never the prefetch, and shows them on the lead', async () => {
    const { recordOpen } = await import('../../src/lib/server/tracking');
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 10, 'contacted'); await c.leads.insertOne(l);
    const sentAt = new Date(Date.now() - 5 * 60_000);
    const s = { _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, stepIndex: 0, accountId: acc._id, dueAt: sentAt, sentAt, status: 'sent' as const, attempt: 1, tokens: { open: 'open-10', unsub: 'unsub-10' }, createdAt: sentAt };
    await c.sends.insertOne(s);
    expect(await recordOpen(db, 'open-10', {})).toBe(true);
    expect(await recordOpen(db, 'open-10', {})).toBe(true); // the client fetched the pixel twice within a minute
    const send = (await c.sends.findOne({ _id: s._id }))!;
    expect(send.openCount).toBe(2);
    expect(send.opens).toHaveLength(1);
    expect(send.firstOpenedAt).toBeInstanceOf(Date);
    const ld = (await c.leads.findOne({ _id: l._id }))!;
    expect(ld.status).toBe('opened');
    expect(ld.openCount).toBe(1);
    expect(ld.lastOpenedAt).toBeInstanceOf(Date);
    expect(await c.events.countDocuments({ leadId: l._id, type: 'open' })).toBe(2);
    expect(await c.events.countDocuments({ leadId: l._id, type: 'open', 'meta.unique': true })).toBe(1);
    // a hit ten seconds after sending is a machine, not a person
    const fresh = { ...s, _id: new ObjectId(), stepIndex: 1, sentAt: new Date(), tokens: { open: 'open-11', unsub: 'unsub-11' } };
    const l2 = lead(cp, acc, 11, 'contacted'); await c.leads.insertOne(l2); fresh.leadId = l2._id;
    await c.sends.insertOne(fresh);
    await recordOpen(db, 'open-11', {});
    expect((await c.sends.findOne({ _id: fresh._id }))?.opens ?? []).toHaveLength(0);
    expect((await c.leads.findOne({ _id: l2._id }))?.status).toBe('contacted');
    expect(await recordOpen(db, 'nope', {})).toBe(false);
  });
});
