/**
 * The reply agent and the Inbox on the local MongoDB (database hedwig_test), with a fake Jev and a fake mailbox.
 * Proves: one Jev call per reply even when two runners race, status applied only forward, the owner note claimed once,
 * failures retried then given up, nothing labelled without a Jev key, and a manual reply that cannot go out twice.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { classifyMessage, classifyPending, ensureDefaultAgent, effectiveAgent } from '../../src/lib/server/agent';
import { backfillInbound, sendManualReply, snippetOf } from '../../src/lib/server/inbox';
import { applyLeadStatus } from '../../src/lib/server/campaigns';
import { seal } from '../../src/lib/server/crypto';
import type { CampaignDoc, EmailAccountDoc, LeadDoc, MessageDoc } from '../../src/lib/server/types';
import * as providerMod from '../../src/lib/server/mail/provider';

process.env.HEDWIG_MASTER_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.ORIGIN ||= 'http://localhost:5180';
process.env.TYPESAFE_API_KEY = 'jev-test-key';
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

const jevCalls: any[] = [];
let jevAnswer: { choice: string; probabilities: Record<string, number> } = { choice: 'interested', probabilities: { interested: 0.92, replied: 0.05, meeting: 0.03 } };
let jevFail: number | null = null;
const jev = async (url: string, init: RequestInit) => {
  expect(url).toContain('typesafe');
  jevCalls.push(JSON.parse(String(init.body)));
  await new Promise((r) => setTimeout(r, 30)); // long enough for a racing runner to try the same message
  if (jevFail) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: jevFail });
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { label: { type: 'choice', ...jevAnswer, confidence: 0.9 } }, usage: { input_tokens: 300, output_tokens: 1 } }), { status: 200 });
};
const deps = { fetch: jev };
const answer = (choice: string, p: number) => { jevAnswer = { choice, probabilities: { [choice]: p, ...(choice === 'replied' ? {} : { replied: Math.round((1 - p) * 100) / 100 }) } }; };
const reset = () => { jevCalls.length = 0; jevFail = null; answer('interested', 0.92); };

let db: Db;
const space = 'user:' + new ObjectId().toHexString();
const owner = new ObjectId();
const now = new Date('2026-09-15T10:00:00Z');

function account(): EmailAccountDoc {
  return { _id: new ObjectId(), space, ownerUserId: owner, address: `box${Math.random().toString(36).slice(2, 7)}@test.local`, fromName: 'Alex', kind: 'imapSmtp', status: 'active', dailyLimit: 40, ramp: { enabled: false, startedAt: now }, secrets: seal({ imapPass: 'x', smtpPass: 'x' }), imap: { host: 'h', port: 993, secure: true, user: 'u' }, smtp: { host: 'h', port: 465, secure: true, user: 'u' }, sync: {}, createdAt: now };
}
function campaign(accountIds: ObjectId[], over: Partial<CampaignDoc> = {}): CampaignDoc {
  return { _id: new ObjectId(), space, ownerUserId: owner, name: 'Sept', status: 'active', schedule: { timezone: 'Europe/Madrid', from: '09:00', to: '15:00', days: [1, 2, 3, 4, 5] }, steps: [{ subject: 'Una pregunta', body: 'Hola', delayDays: 0 }, { subject: null, body: 'Seguimiento', delayDays: 2 }], accountIds, dailyLimit: 30, stopOnReply: true, oooStops: false, openTracking: true, testRecipient: 't@test.local', unsubscribeLine: '', createdAt: now, updatedAt: now, ...over };
}
function lead(cp: CampaignDoc, acc: EmailAccountDoc, i: number, status: LeadDoc['status'] = 'replied'): LeadDoc {
  return { _id: new ObjectId(), campaignId: cp._id, space, email: `dir${i}@empresa${i}.example`, domain: `empresa${i}.example`, vars: { companyName: `Empresa ${i}` }, provider: 'unknown', accountId: acc._id, currentStep: 1, nextDueAt: null, status, thread: { internetMessageId: `<step1-${i}@test.local>`, subject: 'Una pregunta' }, createdAt: now };
}
function reply(cp: CampaignDoc, acc: EmailAccountDoc, l: LeadDoc, text = 'Sí, nos interesa. ¿Hablamos?'): MessageDoc {
  return { _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, accountId: acc._id, direction: 'in', kind: 'reply', internetMessageId: `<r-${l._id}@empresa>`, from: l.email, to: acc.address, subject: 'Re: Una pregunta', text, at: now, ai: { status: 'pending' } };
}

beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); await cols(db).users.insertOne({ _id: owner, email: 'owner@test.local', name: 'Owner', passwordHash: 'x', createdAt: now }); });
afterAll(async () => { await db.dropDatabase(); await closeDb(); });

describe('reply agent (Jev only)', () => {
  it('creates one agent per space; every campaign uses it, a legacy custom agent choice included, unless switched off on the campaign', async () => {
    const a1 = await ensureDefaultAgent(db, space, owner);
    const a2 = await ensureDefaultAgent(db, space, owner);
    expect(a2._id.equals(a1._id)).toBe(true);
    expect(await cols(db).agents.countDocuments({ space, builtin: true })).toBe(1);
    expect(a1).toMatchObject({ name: 'Triage', active: true });
    expect(a1.model).toBeUndefined();
    const acc = account(); const cp = campaign([acc._id]);
    expect((await effectiveAgent(db, cp))?._id.equals(a1._id)).toBe(true);
    const legacyChoice: CampaignDoc = { ...cp, agentId: new ObjectId() };
    expect((await effectiveAgent(db, legacyChoice))?._id.equals(a1._id)).toBe(true);
    expect(await effectiveAgent(db, { ...cp, agentOff: true })).toBeNull();
  });

  it('asks Jev once per reply even when two runners race, applies the status forward, emails the owner once', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 1); await c.leads.insertOne(l);
    await c.sends.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, stepIndex: 1, accountId: acc._id, dueAt: now, status: 'planned', attempt: 0, tokens: { open: 'o1', unsub: 'u1' }, createdAt: now });
    await c.messages.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: l._id, accountId: acc._id, direction: 'out', kind: 'sent', from: acc.address, to: l.email, subject: 'Una pregunta', text: 'Hola, ¿os interesa?', at: new Date(now.getTime() - 864e5) });
    const m = reply(cp, acc, l, 'Sí, nos interesa.\n\nEl lun, Alex escribió:\n> Hola, ¿os interesa?'); await c.messages.insertOne(m);
    sent.length = 0;
    const [r1, r2] = await Promise.all([classifyPending(db, { deps, now }), classifyPending(db, { deps, now })]);
    expect(jevCalls).toHaveLength(1);
    expect(r1.done + r2.done).toBe(1);
    expect(jevCalls[0].state).toMatchObject({ their_reply: 'Sí, nos interesa.', our_last_email: 'Hola, ¿os interesa?' });
    expect(Object.keys(jevCalls[0].questions.label.criteria)).toEqual(['meeting', 'interested', 'replied']);
    const after = await c.messages.findOne({ _id: m._id });
    expect(after?.ai).toMatchObject({ status: 'done', label: 'interested', confidence: 0.92, reason: 'Interested 92% · Replied 8%', model: 'jev-1.13.0', attempts: 1, appliedStatus: 'interested' });
    expect(after?.ai?.notifiedAt).toBeInstanceOf(Date);
    const ld = await c.leads.findOne({ _id: l._id });
    expect(ld?.status).toBe('interested');
    expect(ld?.ai?.label).toBe('interested');
    expect((await c.sends.findOne({ leadId: l._id }))?.status).toBe('cancelled');
    expect(await c.llmCalls.findOne({ messageId: m._id })).toMatchObject({ model: 'jev-1.13.0', purpose: 'classify', ok: true, tokens: { prompt: 300, output: 1 } });
    expect(sent.filter((s) => s.to === 'owner@test.local')).toHaveLength(1);
    expect(sent.find((s) => s.to === 'owner@test.local')?.subject).toMatch(/^Interested: Empresa 1/);
    // a third pass finds nothing to do; the owner note is not sent again
    jevCalls.length = 0;
    expect((await classifyPending(db, { deps, now })).waiting).toBe(0);
    expect(jevCalls).toHaveLength(0);
    // labelling again by hand is one more call, and still no second note
    await classifyMessage(db, m._id, { deps, now, force: true });
    expect(jevCalls).toHaveLength(1);
    expect((await c.messages.findOne({ _id: m._id }))?.ai?.notifiedAt).toEqual(after?.ai?.notifiedAt);
    expect(sent.filter((s) => s.to === 'owner@test.local')).toHaveLength(1);
  });

  it('meeting moves an interested lead on; replied changes nothing and emails nobody', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 20, 'interested'); await c.leads.insertOne(l);
    const m = reply(cp, acc, l, '¿El jueves a las 10?'); await c.messages.insertOne(m);
    answer('meeting', 0.88);
    expect(await classifyMessage(db, m._id, { deps, now })).toMatchObject({ ok: true, label: 'meeting' });
    expect((await c.leads.findOne({ _id: l._id }))?.status).toBe('meeting');
    const plain = lead(cp, acc, 21); await c.leads.insertOne(plain);
    const m2 = reply(cp, acc, plain, 'Gracias, no por ahora.'); await c.messages.insertOne(m2);
    answer('replied', 0.97);
    sent.length = 0;
    expect(await classifyMessage(db, m2._id, { deps, now })).toMatchObject({ ok: true, label: 'replied', confidence: 0.97 });
    expect((await c.leads.findOne({ _id: plain._id }))?.status).toBe('replied');
    const doc = await c.messages.findOne({ _id: m2._id });
    expect(doc?.ai?.appliedStatus).toBeUndefined();
    expect(doc?.ai?.notifiedAt).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('never overwrites a status set by hand, stays quiet below the confidence bar, and a new label clears an old applied status', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const won = lead(cp, acc, 2, 'won'); await c.leads.insertOne(won);
    const m1 = reply(cp, acc, won); await c.messages.insertOne(m1);
    answer('interested', 0.95);
    await classifyMessage(db, m1._id, { deps, now });
    expect((await c.leads.findOne({ _id: won._id }))?.status).toBe('won');
    expect((await c.messages.findOne({ _id: m1._id }))?.ai?.appliedStatus).toBeUndefined();
    const unsure = lead(cp, acc, 3); await c.leads.insertOne(unsure);
    const m2 = reply(cp, acc, unsure); await c.messages.insertOne(m2);
    answer('interested', 0.5);
    await classifyMessage(db, m2._id, { deps, now });
    const ld = await c.leads.findOne({ _id: unsure._id });
    expect(ld?.status).toBe('replied');
    expect(ld?.ai).toMatchObject({ label: 'interested', confidence: 0.5 });
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.notifiedAt).toBeUndefined();
    // the same reply labelled again: interested (applied), then replied (nothing applied, the old mark goes)
    answer('interested', 0.9);
    await classifyMessage(db, m2._id, { deps, now, force: true });
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.appliedStatus).toBe('interested');
    answer('replied', 0.9);
    await classifyMessage(db, m2._id, { deps, now, force: true });
    expect((await c.messages.findOne({ _id: m2._id }))?.ai).toMatchObject({ label: 'replied' });
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.appliedStatus).toBeUndefined();
  });

  it('retries a transient failure later, gives up on a final one, and skips when the campaign or the workspace has no agent', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 4); await c.leads.insertOne(l);
    const m = reply(cp, acc, l); await c.messages.insertOne(m);
    jevFail = 529;
    await classifyMessage(db, m._id, { deps, now });
    let doc = await c.messages.findOne({ _id: m._id });
    expect(doc?.ai).toMatchObject({ status: 'pending', error: 'Jev 529: nope' });
    expect(doc?.ai?.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect((await classifyPending(db, { deps, now })).waiting).toBe(0); // not before nextAttemptAt
    const later = new Date(now.getTime() + 11 * 60_000);
    jevFail = 401;
    await classifyPending(db, { deps, now: later });
    doc = await c.messages.findOne({ _id: m._id });
    expect(doc?.ai).toMatchObject({ status: 'failed', attempts: 2, error: 'Jev 401: nope' });
    const logged = await c.llmCalls.find({ messageId: m._id }, { sort: { _id: 1 } }).toArray();
    expect(logged.map((x) => [x.model, x.ok])).toEqual([['jev-latest', false], ['jev-latest', false]]);
    jevFail = null;
    const off = campaign([acc._id], { agentOff: true }); await c.campaigns.insertOne(off);
    const l2 = lead(off, acc, 5); await c.leads.insertOne(l2);
    const m2 = reply(off, acc, l2); await c.messages.insertOne(m2);
    jevCalls.length = 0;
    const r = await classifyMessage(db, m2._id, { deps, now });
    expect(r.skipped).toMatch(/no agent/);
    expect(jevCalls).toHaveLength(0);
    expect((await c.messages.findOne({ _id: m2._id }))?.ai?.status).toBe('skipped');
    // the workspace's agent switched off (on the Agents screen) stops it for every campaign
    const otherSpace = 'user:' + new ObjectId().toHexString();
    const a = await ensureDefaultAgent(db, otherSpace, owner);
    await c.agents.updateOne({ _id: a._id }, { $set: { active: false } });
    const cp3 = { ...campaign([acc._id]), space: otherSpace }; await c.campaigns.insertOne(cp3);
    const l3 = { ...lead(cp3, acc, 6), space: otherSpace }; await c.leads.insertOne(l3);
    const m3 = { ...reply(cp3, acc, l3), space: otherSpace }; await c.messages.insertOne(m3);
    expect((await classifyMessage(db, m3._id, { deps, now })).skipped).toBe('agent switched off');
    expect(jevCalls).toHaveLength(0);
  });

  it('labels nothing without a Jev key: replies stay waiting for when one is set', async () => {
    reset();
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp, acc, 30); await c.leads.insertOne(l);
    const m = reply(cp, acc, l); await c.messages.insertOne(m);
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(await classifyMessage(db, m._id, { deps, now })).toMatchObject({ ok: false, skipped: 'TYPESAFE_API_KEY is not set' });
      expect(await classifyPending(db, { deps, now })).toEqual({ waiting: 0, done: 0, failed: 0, skipped: 0 });
      expect(jevCalls).toHaveLength(0);
      expect((await c.messages.findOne({ _id: m._id }))?.ai?.status).toBe('pending');
    } finally { process.env.TYPESAFE_API_KEY = 'jev-test-key'; }
    expect(await classifyMessage(db, m._id, { deps, now })).toMatchObject({ ok: true, label: 'interested' });
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
    expect((await classifyMessage(db, m._id, { deps, now })).skipped).toMatch(/by hand/);
    expect(jevCalls).toHaveLength(0);
    expect((await c.messages.findOne({ _id: m._id }))?.ai?.status).toBe('skipped');
    // a status the agent sets is not a person's
    const l2 = lead(cp, acc, 15); await c.leads.insertOne(l2);
    await applyLeadStatus(db, l2, 'interested', 'agent Triage');
    expect((await c.leads.findOne({ _id: l2._id }))?.statusBy).toBeUndefined();
    // Label again: the person hands the lead back, and the agent labels it
    expect(await classifyMessage(db, m._id, { deps, now, force: true })).toMatchObject({ ok: true, label: 'interested' });
    expect(jevCalls).toHaveLength(1);
    const ld = await c.leads.findOne({ _id: l._id });
    expect(ld?.statusBy).toBeUndefined();
    expect(ld?.status).toBe('meeting'); // interested never moves a meeting back
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
