/**
 * The results feed on the local MongoDB (database hedwig_test): the token opens one workspace and only while its maker is in
 * it, a new link or "Turn off" kills the old one, nothing from another workspace leaks in, and both files have the columns
 * and numbers the docs promise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import Papa from 'papaparse';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { sha256 } from '../../src/lib/server/crypto';
import { newCampaign } from '../../src/lib/server/campaigns';
import { createFeedToken, DAILY_COLUMNS, dailyCsv, feedSpace, feedTokenInfo, LEAD_COLUMNS, leadsCsv, revokeFeedToken, serveFeed } from '../../src/lib/server/feed';
import type { CampaignDoc, DailyStatDoc, LeadDoc, MessageDoc, SendDoc, UserDoc } from '../../src/lib/server/types';

let db: Db;
const now = new Date('2026-10-28T12:00:00Z');
const at = (iso: string) => new Date(iso);
const user = (name: string): UserDoc => ({ _id: new ObjectId(), email: `${name.toLowerCase()}@test.local`, name, passwordHash: 'x', createdAt: now });
const owner = user('Olive'), member = user('Max'), outsider = user('Oscar');
const orgId = new ObjectId();
const space = `org:${orgId.toHexString()}`;
const otherSpace = `user:${outsider._id.toHexString()}`;
const acc1 = new ObjectId(), acc2 = new ObjectId();
const campaign = (sp: string, name: string): CampaignDoc => ({ _id: new ObjectId(), ...newCampaign(sp, owner._id, name, 'owner@test.local', 'America/Toronto') });
// created in this order, so B is the newer campaign and comes first in leads.csv
const A = campaign(space, 'Corporate FR');
const B = campaign(space, 'Montréal, été "B"');
const OTHER = campaign(otherSpace, 'Other workspace');
function lead(c: CampaignDoc, email: string, over: Partial<LeadDoc> = {}): LeadDoc {
  return { _id: new ObjectId(), campaignId: c._id, space: c.space, email, domain: email.split('@')[1], vars: { email }, provider: 'unknown', currentStep: 0, nextDueAt: null, status: 'queued', createdAt: now, ...over };
}
const L = {
  a1: lead(A, 'ana@firm1.example', { vars: { email: 'ana@firm1.example', lead_id: 'L-001', branch: 'corporate', segment: 'hr', emailP1: 'A paragraph that must never reach the feed.' }, status: 'interested', ai: { label: 'interested', confidence: 0.92, at: at('2026-10-20T15:05:00Z'), messageId: new ObjectId() }, openCount: 3, currentStep: 2, lastInboundAt: at('2026-10-22T09:00:00Z') }),
  a2: lead(A, 'bob@firm2.example', { vars: { email: 'bob@firm2.example', leadId: 'L-002', branch: '=HYPERLINK("http://x.example")' }, status: 'contacted', openCount: 4, curious: true, currentStep: 1 }),
  a3: lead(A, 'cy@firm3.example'),
  // set interested by hand; the only thing that came back was an out-of-office note
  a4: lead(A, 'dee@firm4.example', { status: 'interested', statusBy: 'owner@test.local', lastInboundAt: at('2026-10-25T08:00:00Z') }),
  // first replied before the 180-day window, wrote again inside it
  a5: lead(A, 'eve@firm5.example', { status: 'interested', lastInboundAt: at('2026-10-01T10:00:00Z') }),
  b1: lead(B, 'fay@firm6.example', { status: 'meeting', ai: { label: 'meeting', confidence: 0.9, at: at('2026-10-27T10:01:00Z'), messageId: new ObjectId() }, currentStep: 1, lastInboundAt: at('2026-10-27T10:00:00Z') }),
  b2: lead(B, 'ana@firm1.example', { status: 'contacted', currentStep: 1 }),
  z1: lead(OTHER, 'zed@firm9.example', { status: 'interested', currentStep: 1, lastInboundAt: at('2026-10-20T11:00:00Z') })
};
let n = 0;
function send(l: LeadDoc, stepIndex: number, status: SendDoc['status'], sentAt?: string): SendDoc {
  n++;
  return { _id: new ObjectId(), space: l.space, campaignId: l.campaignId, leadId: l._id, stepIndex, accountId: acc1, dueAt: at(sentAt ?? '2026-10-29T13:00:00Z'), status, ...(sentAt ? { sentAt: at(sentAt) } : {}), attempt: 1, tokens: { open: `open${n}`, unsub: `unsub${n}` }, subject: 'A subject that must never reach the feed', createdAt: now };
}
function inbound(l: LeadDoc, kind: 'reply' | 'ooo', iso: string): MessageDoc {
  return { _id: new ObjectId(), space: l.space, campaignId: l.campaignId, leadId: l._id, accountId: acc1, direction: 'in', kind, from: l.email, to: 'box@test.local', subject: 'Re: hello', text: 'A reply body that must never reach the feed.', at: at(iso) };
}
function stat(c: CampaignDoc, day: string, stepIndex: number, accountId: ObjectId, over: Partial<DailyStatDoc>): DailyStatDoc {
  return { _id: new ObjectId(), day, space: c.space, campaignId: c._id, stepIndex, accountId, sent: 0, opens: 0, uniqueOpens: 0, replies: 0, bounces: 0, ooo: 0, unsubscribes: 0, ...over };
}
const parse = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });

beforeAll(async () => {
  db = await getDb(); await db.dropDatabase(); await ensureIndexes(db);
  const c = cols(db);
  await c.users.insertMany([owner, member, outsider]);
  await c.orgs.insertOne({ _id: orgId, name: 'Team', members: [{ userId: owner._id, role: 'owner', addedAt: now }, { userId: member._id, role: 'member', addedAt: now }], createdAt: now });
  await c.campaigns.insertMany([A, B, OTHER]);
  await c.leads.insertMany(Object.values(L));
  await c.sends.insertMany([
    send(L.a1, 0, 'sent', '2026-10-14T13:00:00Z'), send(L.a1, 1, 'sent', '2026-10-18T14:30:00Z'), send(L.a1, 2, 'cancelled'),
    send(L.a2, 0, 'sent', '2026-10-15T13:10:00Z'), send(L.a2, 1, 'planned'),
    send(L.b1, 0, 'sent', '2026-10-26T13:00:00Z'), send(L.b2, 0, 'sent', '2026-10-26T13:05:00Z'), send(L.z1, 0, 'sent', '2026-10-19T13:00:00Z')
  ]);
  await c.messages.insertMany([
    inbound(L.a1, 'reply', '2026-10-22T09:00:00Z'), inbound(L.a1, 'reply', '2026-10-20T15:00:00Z'),
    inbound(L.a4, 'ooo', '2026-10-25T08:00:00Z'),
    inbound(L.a5, 'reply', '2026-04-01T10:00:00Z'), inbound(L.a5, 'reply', '2026-10-01T10:00:00Z'),
    inbound(L.b1, 'reply', '2026-10-27T10:00:00Z'), inbound(L.z1, 'reply', '2026-10-20T11:00:00Z')
  ]);
  await c.dailyStats.insertMany([
    stat(A, '2026-05-01', 0, acc1, { sent: 4 }), // a day before the window
    stat(A, '2026-05-02', 0, acc1, { sent: 2 }), // the window's first day
    stat(A, '2026-10-20', 0, acc1, { sent: 2, opens: 4, uniqueOpens: 1, replies: 1 }),
    stat(A, '2026-10-20', 1, acc2, { sent: 1, opens: 1, uniqueOpens: 1, bounces: 1 }),
    stat(A, '2026-10-21', 0, acc1, { ooo: 1 }), // nothing the feed counts: no row
    stat(B, '2026-10-27', 0, acc1, { replies: 1 }),
    stat(OTHER, '2026-10-20', 0, acc1, { sent: 7, replies: 1 })
  ]);
});
afterAll(async () => { await db.dropDatabase(); await closeDb(); });

describe('feed token', () => {
  it('opens its own workspace, is stored only as a hash, and a wrong or malformed token opens nothing', async () => {
    const token = await createFeedToken(db, space, member._id, now);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const doc = await cols(db).feedTokens.findOne({ space });
    expect(doc?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(doc)).not.toContain(token);
    expect(await feedSpace(db, token, now)).toBe(space);
    expect(await feedSpace(db, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, now)).toBeNull();
    expect(await feedSpace(db, 'short', now)).toBeNull();
    expect(await feedSpace(db, `${token}x`, now)).toBeNull();
    expect((await cols(db).feedTokens.findOne({ space }))?.lastUsedAt).toEqual(now);
    expect(await feedTokenInfo(db, space)).toEqual({ createdAt: now, lastUsedAt: now, createdBy: 'Max' });
  });

  it('serves CSV for a good link and the same plain 404 for anything else', async () => {
    const token = await createFeedToken(db, space, owner._id, now);
    const ok = await serveFeed(db, { token, file: 'leads.csv', ip: '203.0.113.1' }, now);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    const body = await ok.text();
    expect(body.startsWith(`${LEAD_COLUMNS.join(',')}\r\n`)).toBe(true);
    // a browser tab gets the same file as text, so it shows instead of downloading
    const tab = await serveFeed(db, { token, file: 'leads.csv', ip: '203.0.113.1', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, now);
    expect(tab.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(tab.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await tab.text()).toBe(body);
    for (const [t, file] of [['A'.repeat(43), 'leads.csv'], [token, 'secrets.csv'], [token, '__proto__'], ['../../health', 'daily.csv']]) {
      const r = await serveFeed(db, { token: t, file, ip: '203.0.113.1' }, now);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe('Not found');
    }
  });

  it('a new link replaces the old, Turn off kills it, and it stops when its maker leaves the workspace', async () => {
    const first = await createFeedToken(db, space, member._id, now);
    const second = await createFeedToken(db, space, member._id, now);
    expect(await feedSpace(db, first, now)).toBeNull();
    expect(await feedSpace(db, second, now)).toBe(space);
    expect(await cols(db).feedTokens.countDocuments({ space })).toBe(1);
    expect(await revokeFeedToken(db, space)).toBe(true);
    expect(await feedSpace(db, second, now)).toBeNull();
    expect((await serveFeed(db, { token: second, file: 'daily.csv', ip: '203.0.113.2' }, now)).status).toBe(404);
    expect(await revokeFeedToken(db, space)).toBe(false);
    expect(await feedTokenInfo(db, space)).toBeNull();

    const third = await createFeedToken(db, space, member._id, now);
    await cols(db).orgs.updateOne({ _id: orgId }, { $pull: { members: { userId: member._id } } });
    expect(await feedSpace(db, third, now)).toBeNull();
    await cols(db).orgs.updateOne({ _id: orgId }, { $push: { members: { userId: member._id, role: 'member', addedAt: now } } });
    expect(await feedSpace(db, third, now)).toBe(space);
    // a token made for a workspace its maker is not in opens nothing
    expect(await feedSpace(db, await createFeedToken(db, `org:${new ObjectId().toHexString()}`, outsider._id, now), now)).toBeNull();
  });

  it('answers 429 past the limit per address and per link, before building anything', async () => {
    const token = await createFeedToken(db, space, owner._id, now);
    const fill = async (bucket: string, count: number) => {
      const w = Math.floor(Date.now() / 60_000);
      for (const window of [w, w + 1]) await db.collection('oauthLimits').updateOne({ _id: sha256(`${bucket}:${window}`) as any }, { $set: { count, expiresAt: new Date(Date.now() + 120_000) } }, { upsert: true });
    };
    await fill(`feed:${sha256(token)}`, 30);
    const perLink = await serveFeed(db, { token, file: 'leads.csv', ip: '203.0.113.3' }, now);
    expect(perLink.status).toBe(429);
    expect(perLink.headers.get('retry-after')).toBe('60');
    await fill('feed:203.0.113.4', 120);
    expect((await serveFeed(db, { token: 'B'.repeat(43), file: 'leads.csv', ip: '203.0.113.4' }, now)).status).toBe(429);
  });
});

describe('feed files', () => {
  it('leads.csv: one row per enrolled lead, newest campaign first, the promised columns and nothing private', async () => {
    const csv = await leadsCsv(db, space);
    const { data, meta } = parse(csv);
    expect(meta.fields).toEqual(LEAD_COLUMNS);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(data.map((r) => `${r.campaign} | ${r.email}`)).toEqual([
      'Montréal, été "B" | ana@firm1.example', 'Montréal, été "B" | fay@firm6.example',
      'Corporate FR | ana@firm1.example', 'Corporate FR | bob@firm2.example', 'Corporate FR | cy@firm3.example', 'Corporate FR | dee@firm4.example', 'Corporate FR | eve@firm5.example'
    ]);
    const row = (campaign: string, email: string) => data.find((r) => r.campaign === campaign && r.email === email);
    expect(row('Corporate FR', 'ana@firm1.example')).toEqual({ campaign: 'Corporate FR', email: 'ana@firm1.example', lead_id: 'L-001', branch: 'corporate', segment: 'hr', status: 'interested', agent_label: 'interested', first_sent_at: '2026-10-14 13:00:00', last_sent_at: '2026-10-18 14:30:00', steps_sent: '2', opens: '3', replied_at: '2026-10-20 15:00:00', curious: 'false' });
    // leadId from a CSV import counts as lead_id; a formula-like cell stays text
    expect(row('Corporate FR', 'bob@firm2.example')).toMatchObject({ lead_id: 'L-002', branch: `'=HYPERLINK("http://x.example")`, status: 'contacted', first_sent_at: '2026-10-15 13:10:00', last_sent_at: '2026-10-15 13:10:00', steps_sent: '1', opens: '4', replied_at: '', curious: 'true' });
    expect(row('Corporate FR', 'cy@firm3.example')).toMatchObject({ lead_id: '', branch: '', segment: '', status: 'queued', agent_label: '', first_sent_at: '', steps_sent: '0', opens: '0', replied_at: '', curious: 'false' });
    expect(row('Corporate FR', 'dee@firm4.example')).toMatchObject({ status: 'interested', agent_label: '', replied_at: '' });
    expect(row('Corporate FR', 'eve@firm5.example')?.replied_at).toBe('2026-04-01 10:00:00');
    expect(row('Montréal, été "B"', 'fay@firm6.example')).toMatchObject({ status: 'meeting', agent_label: 'meeting', replied_at: '2026-10-27 10:00:00', steps_sent: '1' });
    expect(csv).toContain('"Montréal, été ""B"""');
    for (const secret of ['zed@firm9.example', 'Other workspace', 'must never reach the feed', 'subject']) expect(csv).not.toContain(secret);
  });

  it('daily.csv: one row per campaign per day with activity, last 180 days, positives on the day they first replied', async () => {
    const csv = await dailyCsv(db, space, now);
    const { data, meta } = parse(csv);
    expect(meta.fields).toEqual(DAILY_COLUMNS);
    expect(data).toEqual([
      { date: '2026-05-02', campaign: 'Corporate FR', sent: '2', opens: '0', replies: '0', interested: '0', meetings: '0', bounces: '0' },
      { date: '2026-10-20', campaign: 'Corporate FR', sent: '3', opens: '2', replies: '1', interested: '1', meetings: '0', bounces: '1' },
      { date: '2026-10-27', campaign: 'Montréal, été "B"', sent: '0', opens: '0', replies: '1', interested: '0', meetings: '1', bounces: '0' }
    ]);
    expect(csv).not.toContain('Other workspace');
  });

  it('a link for another workspace sees only that workspace', async () => {
    const token = await createFeedToken(db, otherSpace, outsider._id, now);
    const leads = parse(await (await serveFeed(db, { token, file: 'leads.csv', ip: '203.0.113.5' }, now)).text()).data;
    expect(leads.map((r) => `${r.campaign} | ${r.email} | ${r.status}`)).toEqual(['Other workspace | zed@firm9.example | interested']);
    const daily = parse(await (await serveFeed(db, { token, file: 'daily.csv', ip: '203.0.113.5' }, now)).text()).data;
    expect(daily).toEqual([{ date: '2026-10-20', campaign: 'Other workspace', sent: '7', opens: '0', replies: '1', interested: '1', meetings: '0', bounces: '0' }]);
  });

  it('an empty workspace gets the header row alone', async () => {
    const empty = `user:${new ObjectId().toHexString()}`;
    expect(await leadsCsv(db, empty)).toBe(`${LEAD_COLUMNS.join(',')}\r\n`);
    expect(await dailyCsv(db, empty, now)).toBe(`${DAILY_COLUMNS.join(',')}\r\n`);
  });
});
