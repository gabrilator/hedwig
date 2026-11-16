import { describe, expect, it } from 'vitest';
import { buildJevRequest, callJev, JEV_MODEL, labelToStatus, ModelError, parseJevAnswer, stripQuoted } from '../../src/lib/server/agent';
import { AI_LABELS } from '../../src/lib/server/types';

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

describe('labels', () => {
  it('are exactly meeting, interested and replied', () => {
    expect([...AI_LABELS]).toEqual(['meeting', 'interested', 'replied']);
  });
});

describe('labelToStatus', () => {
  it('moves forward from automatic statuses only, never over a status set by hand; replied changes nothing', () => {
    expect(labelToStatus('interested', 'replied')).toBe('interested');
    expect(labelToStatus('interested', 'contacted')).toBe('interested');
    expect(labelToStatus('interested', 'won')).toBeNull();
    expect(labelToStatus('interested', 'meeting')).toBeNull();
    expect(labelToStatus('meeting', 'interested')).toBe('meeting');
    expect(labelToStatus('meeting', 'replied')).toBe('meeting');
    expect(labelToStatus('meeting', 'not_interested')).toBeNull();
    expect(labelToStatus('replied', 'replied')).toBeNull();
    expect(labelToStatus('replied', 'contacted')).toBeNull();
  });
});

const at = new Date('2026-09-15T10:00:00Z');
const thread = [
  { direction: 'out' as const, kind: 'sent', from: 'us@example.com', subject: 'Una pregunta', text: 'Hola, ¿tenéis inglés?', at: new Date('2026-09-10T09:00:00Z') },
  { direction: 'in' as const, kind: 'reply', from: 'dir@empresa.example', subject: 'Re: Una pregunta', text: 'Sí, cuéntame más.\n\nEl 10 sept, Alex escribió:\n> Hola', at }
];

describe('Jev', () => {
  const jevOk = (probabilities: Record<string, number>, choice: string) => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { label: { type: 'choice', choice, probabilities, confidence: 0.9 } }, usage: { input_tokens: 210, output_tokens: 31 } }), { status: 200 });

  it('asks one choice question over the three labels, with their words and the email of ours they answered, quotes left out', () => {
    const r = buildJevRequest({ thread, target: thread[1] });
    expect(r.model).toBe(JEV_MODEL);
    expect(r.state.their_reply).toBe('Sí, cuéntame más.');
    expect(r.state.our_last_email).toBe('Hola, ¿tenéis inglés?');
    expect(r.state.subject).toBe('Re: Una pregunta');
    expect(r.questions.label.type).toBe('choice');
    expect(Object.keys(r.questions.label.criteria)).toEqual(['meeting', 'interested', 'replied']);
    expect(buildJevRequest({ thread: [thread[1]], target: thread[1] }).state.our_last_email).toBeUndefined();
  });

  it('takes the chosen label, its probability as the confidence, and the two likeliest labels as the reason', () => {
    const a = parseJevAnswer({ answers: { label: { choice: 'interested', probabilities: { interested: 0.91, replied: 0.06, meeting: 0.03 }, confidence: 0.8 } } });
    expect(a).toMatchObject({ label: 'interested', confidence: 0.91, reason: 'Interested 91% · Replied 6%' });
    expect(a.odds).toEqual({ interested: 0.91, replied: 0.06, meeting: 0.03 });
    // a label Jev should not give (an old one, or nonsense) counts as a plain reply
    expect(parseJevAnswer({ answers: { label: { choice: 'not_interested', probabilities: { replied: 0.2 } } } })).toMatchObject({ label: 'replied', confidence: 0.2 });
    expect(parseJevAnswer({ answers: { label: { choice: 'meeting', confidence: 0.7 } } })).toMatchObject({ label: 'meeting', confidence: 0.7, reason: '' });
    expect(() => parseJevAnswer({ answers: {} })).toThrow(ModelError);
  });

  it('sends the key as a bearer token to the System One endpoint; retries only timeouts, rate limits and overload', async () => {
    let seen: any = null;
    const r = await callJev(buildJevRequest({ thread, target: thread[1] }), { fetch: async (url, init) => { seen = { url, init }; return jevOk({ meeting: 0.8, interested: 0.2 }, 'meeting'); } });
    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((seen.init.headers as Record<string, string>).authorization).toBe('Bearer jev-test-key');
    expect(JSON.parse(seen.init.body as string).questions.label.criteria.meeting).toMatch(/meeting/);
    expect(r).toMatchObject({ answer: { label: 'meeting', confidence: 0.8 }, tokens: { prompt: 210, output: 31 }, model: 'jev-1.13.0' });
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
