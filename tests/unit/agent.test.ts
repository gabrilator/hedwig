import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { buildJevRequest, buildPrompt, callGemini, callJev, JEV_MODEL, labelToStatus, ModelError, parseJevAnswer, parseModelJson, stripQuoted } from '../../src/lib/server/agent';
import type { AgentDoc } from '../../src/lib/server/types';

process.env.GEMINI_API_KEY ||= 'test-key';
process.env.TYPESAFE_API_KEY = 'jev-test-key';

describe('stripQuoted', () => {
  it('keeps the person\'s words and drops the quoted email under them', () => {
    const t = 'Buenas tardes,\nSí, nos interesa. ¿Podemos hablar el jueves?\n\nUn saludo\n\nEl mar, 15 sept 2026 a las 10:02, Alex <alex@example.com> escribió:\n> Hola,\n> Una pregunta sobre inglés';
    expect(stripQuoted(t)).toBe('Buenas tardes,\nSí, nos interesa. ¿Podemos hablar el jueves?\n\nUn saludo');
  });
  it('cuts at Outlook header blocks and at "On … wrote:", but not at a sentence that starts with From:', () => {
    expect(stripQuoted('No gracias.\n\nFrom: Alex\nSent: Monday\nTo: me\nSubject: x\n\nHola')).toBe('No gracias.');
    expect(stripQuoted('From: our side, all good.\nThanks!\n\nOn Mon, Sep 14, 2026 at 9:00 AM Alex wrote:\n> hi')).toBe('From: our side, all good.\nThanks!');
  });
  it('never returns an empty string and respects the limit', () => {
    expect(stripQuoted('> only quoted\n> lines')).toBe('> only quoted\n> lines');
    expect(stripQuoted('a'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('parseModelJson', () => {
  it('reads clean JSON and JSON wrapped in prose; clamps confidence; unknown labels become other', () => {
    expect(parseModelJson('{"label":"interested","confidence":0.92,"reason":"asks for a call"}')).toMatchObject({ label: 'interested', confidence: 0.92 });
    expect(parseModelJson('Sure: {"label":"meeting","confidence":85,"reason":"date"} done')).toMatchObject({ label: 'meeting', confidence: 0.85 });
    expect(parseModelJson('{"label":"banana","confidence":"x","reason":1}')).toMatchObject({ label: 'other', confidence: 0, reason: '1' });
    expect(parseModelJson('{"label":"question","confidence":0.5,"reason":"r","draft":"   "}').draft).toBeUndefined();
    expect(() => parseModelJson('nope')).toThrow(/JSON/);
  });
});

describe('labelToStatus', () => {
  it('moves forward from automatic statuses only, never over a status set by hand', () => {
    expect(labelToStatus('interested', 'replied')).toBe('interested');
    expect(labelToStatus('interested', 'won')).toBeNull();
    expect(labelToStatus('interested', 'meeting')).toBeNull();
    expect(labelToStatus('meeting', 'interested')).toBe('meeting');
    expect(labelToStatus('not_interested', 'contacted')).toBe('not_interested');
    expect(labelToStatus('not_interested', 'interested')).toBeNull();
    expect(labelToStatus('unsubscribe', 'won')).toBe('unsubscribed');
    expect(labelToStatus('unsubscribe', 'bounced')).toBeNull();
    expect(labelToStatus('question', 'replied')).toBeNull();
    expect(labelToStatus('out_of_office', 'replied')).toBeNull();
  });
});

const agent: AgentDoc = { _id: new ObjectId(), space: 'user:x', ownerUserId: new ObjectId(), name: 'Reply triage', model: 'gemini-2.5-flash', persona: 'We sell an English tutor.', mode: 'classify', active: true, createdAt: new Date() };
const at = new Date('2026-09-15T10:00:00Z');
const thread = [
  { direction: 'out' as const, kind: 'sent', from: 'us@example.com', subject: 'Una pregunta', text: 'Hola, ¿tenéis inglés?', at: new Date('2026-09-10T09:00:00Z') },
  { direction: 'in' as const, kind: 'reply', from: 'dir@empresa.example', subject: 'Re: Una pregunta', text: 'Sí, cuéntame más.\n\nEl 10 sept, Alex escribió:\n> Hola', at }
];

describe('buildPrompt', () => {
  it('lists the labels, marks the reply to classify, strips the quote, and only asks for a draft when wanted', () => {
    const p = buildPrompt({ agent, campaign: { name: 'Sept', agentRules: [{ if: 'asks for prices', then: 'send the link' }] }, lead: { email: 'dir@empresa.example', vars: { companyName: 'Empresa X' } }, thread, target: thread[1], wantDraft: false });
    expect(p.system).toContain('not_interested');
    expect(p.system).toContain('Do not write a draft');
    expect(p.system).toContain('About us: We sell an English tutor.');
    expect(p.system).not.toMatch(/school|company name|Alex/);
    const bare = buildPrompt({ agent: { ...agent, persona: '' }, campaign: { name: 'x', agentRules: [] }, lead: { email: 'a@b.c', vars: {} }, thread, target: thread[1], wantDraft: false });
    expect(bare.system).not.toContain('About us');
    expect(p.system).not.toContain('asks for prices');
    expect(p.user).toContain('THE REPLY TO CLASSIFY');
    expect(p.user).toContain('Sí, cuéntame más.');
    expect(p.user).not.toContain('> Hola');
    const d = buildPrompt({ agent, campaign: { name: 'Sept', agentRules: [{ if: 'asks for prices', then: 'send the link' }] }, lead: { email: 'dir@empresa.example', vars: {} }, thread, target: thread[1], wantDraft: true, fromName: 'Alex' });
    expect(d.system).toContain('draft');
    expect(d.system).toContain('asks for prices');
    expect(d.system).toContain('from Alex');
  });
});

describe('callGemini', () => {
  const ok = (bodyText: string, usage = { promptTokenCount: 120, candidatesTokenCount: 30 }) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: bodyText }] }, finishReason: 'STOP' }], usageMetadata: usage }), { status: 200 });
  it('sends the key in a header, asks for JSON with the label enum, and parses the answer', async () => {
    let seen: any = null;
    const f = async (url: string, init: RequestInit) => { seen = { url, init }; return ok('{"label":"interested","confidence":0.9,"reason":"asks to know more","language":"es"}'); };
    const r = await callGemini('gemini-2.5-flash', { system: 's', user: 'u' }, false, { fetch: f });
    expect(r.answer).toMatchObject({ label: 'interested', confidence: 0.9, language: 'es' });
    expect(r.tokens).toEqual({ prompt: 120, output: 30 });
    expect(seen.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(seen.url).not.toContain('test-key');
    expect((seen.init.headers as any)['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(seen.init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.properties.label.enum).toContain('unsubscribe');
    expect(body.generationConfig.responseSchema.properties.draft).toBeUndefined();
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
  it('marks 429 and 5xx as transient, 400 as final, and an empty candidate as final', async () => {
    const status = (code: number) => async () => new Response(JSON.stringify({ error: { message: `boom ${code}` } }), { status: code });
    await expect(callGemini('m', { system: 's', user: 'u' }, false, { fetch: status(429) })).rejects.toMatchObject({ transient: true });
    await expect(callGemini('m', { system: 's', user: 'u' }, false, { fetch: status(503) })).rejects.toMatchObject({ transient: true });
    await expect(callGemini('m', { system: 's', user: 'u' }, false, { fetch: status(400) })).rejects.toMatchObject({ transient: false, message: /boom 400/ });
    const empty = async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), { status: 200 });
    await expect(callGemini('m', { system: 's', user: 'u' }, false, { fetch: empty })).rejects.toBeInstanceOf(ModelError);
    const down = async () => { throw new Error('ECONNRESET'); };
    await expect(callGemini('m', { system: 's', user: 'u' }, false, { fetch: down })).rejects.toMatchObject({ transient: true });
  });
});

describe('Jev', () => {
  const jevOk = (probabilities: Record<string, number>, choice: string) => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { label: { type: 'choice', choice, probabilities, confidence: 0.9 } }, usage: { input_tokens: 210, output_tokens: 31 } }), { status: 200 });

  it('asks one choice question over every label, with their words and the email of ours they answered, quotes left out', () => {
    const r = buildJevRequest({ thread, target: thread[1] });
    expect(r.model).toBe(JEV_MODEL);
    expect(r.state.their_reply).toBe('Sí, cuéntame más.');
    expect(r.state.our_last_email).toBe('Hola, ¿tenéis inglés?');
    expect(r.state.subject).toBe('Re: Una pregunta');
    expect(r.questions.label.type).toBe('choice');
    expect(Object.keys(r.questions.label.criteria)).toEqual(['interested', 'meeting', 'question', 'not_interested', 'out_of_office', 'bounce', 'unsubscribe', 'other']);
    expect(buildJevRequest({ thread: [thread[1]], target: thread[1] }).state.our_last_email).toBeUndefined();
  });

  it('takes the chosen label, its probability as the confidence, and the two likeliest labels as the reason', () => {
    const a = parseJevAnswer({ answers: { label: { choice: 'interested', probabilities: { interested: 0.91, question: 0.06, other: 0.03 }, confidence: 0.8 } } });
    expect(a).toMatchObject({ label: 'interested', confidence: 0.91, reason: 'Interested 91% · Question 6%' });
    expect(a.odds).toEqual({ interested: 0.91, question: 0.06, other: 0.03 });
    expect(parseJevAnswer({ answers: { label: { choice: 'banana', probabilities: { other: 0.2 } } } })).toMatchObject({ label: 'other', confidence: 0.2 });
    expect(parseJevAnswer({ answers: { label: { choice: 'meeting', confidence: 0.7 } } })).toMatchObject({ label: 'meeting', confidence: 0.7, reason: '' });
    expect(() => parseJevAnswer({ answers: {} })).toThrow(ModelError);
  });

  it('sends the key as a bearer token to the System One endpoint; retries only timeouts, rate limits and overload', async () => {
    let seen: any = null;
    const r = await callJev(buildJevRequest({ thread, target: thread[1] }), { fetch: async (url, init) => { seen = { url, init }; return jevOk({ question: 0.8, interested: 0.2 }, 'question'); } });
    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((seen.init.headers as Record<string, string>).authorization).toBe('Bearer jev-test-key');
    expect(JSON.parse(seen.init.body as string).questions.label.criteria.question).toMatch(/asks something/);
    expect(r).toMatchObject({ answer: { label: 'question', confidence: 0.8 }, tokens: { prompt: 210, output: 31 }, model: 'jev-1.13.0' });
    expect(JSON.parse(seen.init.body as string).model).toBe('jev-latest');
    const fail = (status: number, body: unknown) => callJev(buildJevRequest({ thread, target: thread[1] }), { fetch: async () => new Response(JSON.stringify(body), { status }) }).catch((e) => e);
    const overloaded = await fail(529, { error: { message: 'overloaded' } });
    expect(overloaded).toBeInstanceOf(ModelError);
    expect(overloaded).toMatchObject({ transient: true, message: 'Jev 529: overloaded' });
    expect(await fail(429, { message: 'slow down' })).toMatchObject({ transient: true, message: 'Jev 429: slow down' });
    expect(await fail(401, { error: 'invalid key' })).toMatchObject({ transient: false, message: 'Jev 401: invalid key' });
    expect(await fail(422, { detail: [{ loc: ['questions'], msg: 'bad' }] })).toMatchObject({ transient: false });
    const offline = await callJev(buildJevRequest({ thread, target: thread[1] }), { fetch: async () => { throw new Error('ECONNRESET'); } }).catch((e) => e);
    expect(offline).toMatchObject({ transient: true });
  });
});
