/**
 * The mailbox daily limit counts per calendar day in the mailbox's own zone (hedwig_test on the local MongoDB).
 * Proves: yesterday's sends do not eat today's quota; today's do; the sender and the planner agree; a mailbox with no zone
 * of its own inherits the campaign's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { accountCapacity, assignMailboxZones, dayStartFor, mailboxZone } from '../../src/lib/server/accounts';
import { planCampaign } from '../../src/lib/server/planner';
import { seal } from '../../src/lib/server/crypto';
import type { CampaignDoc, EmailAccountDoc, LeadDoc, SendDoc } from '../../src/lib/server/types';

process.env.HEDWIG_MASTER_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.ORIGIN ||= 'http://localhost:5180';

let db: Db;
const space = 'user:' + new ObjectId().toHexString();
// Thu 2026-09-17 12:24 in Toronto (EDT, UTC-4)
const now = new Date('2026-09-17T16:24:00Z');

function account(over: Partial<EmailAccountDoc> = {}): EmailAccountDoc {
  return { _id: new ObjectId(), space, ownerUserId: new ObjectId(), address: `box${Math.random().toString(36).slice(2, 7)}@test.local`, fromName: 'T', kind: 'imapSmtp', status: 'active', dailyLimit: 30, ramp: { enabled: false, startedAt: now }, secrets: seal({ imapPass: 'x', smtpPass: 'x' }), imap: { host: 'h', port: 993, secure: true, user: 'u' }, smtp: { host: 'h', port: 465, secure: true, user: 'u' }, sync: {}, createdAt: now, ...over };
}
function campaign(accountIds: ObjectId[]): CampaignDoc {
  return { _id: new ObjectId(), space, ownerUserId: new ObjectId(), name: 'Autumn outreach', status: 'active', schedule: { timezone: 'America/Toronto', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }, steps: [{ subject: 'Hi', body: 'Hello', delayDays: 0 }], accountIds, dailyLimit: 40, stopOnReply: true, oooStops: false, openTracking: false, testRecipient: 't@test.local', unsubscribeLine: '', agentId: null, agentRules: [], createdAt: now, updatedAt: now };
}
function sentSend(cp: CampaignDoc, acc: EmailAccountDoc, sentAt: Date, i: number): SendDoc {
  const lead = new ObjectId();
  return { _id: new ObjectId(), space, campaignId: cp._id, leadId: lead, stepIndex: 0, accountId: acc._id, dueAt: sentAt, sentAt, status: 'sent', attempt: 1, tokens: { open: `o${i}${lead}`, unsub: `u${i}${lead}` }, createdAt: sentAt };
}

beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); });
afterAll(async () => { await db.dropDatabase(); await closeDb(); });

describe('mailbox day', () => {
  it('starts at midnight in the mailbox zone, falls back to the campaign zone, then UTC', () => {
    expect(dayStartFor({ timezone: 'America/Toronto' }, now).toISOString()).toBe('2026-09-17T04:00:00.000Z');
    expect(dayStartFor({}, now, 'Europe/Madrid').toISOString()).toBe('2026-09-16T22:00:00.000Z');
    expect(dayStartFor({}, now).toISOString()).toBe('2026-09-17T00:00:00.000Z');
    expect(mailboxZone({ timezone: 'Mars/Olympus' }, 'America/Toronto')).toBe('America/Toronto');
  });

  it('yesterday\'s 30 sends leave today\'s quota untouched; today\'s sends use it', async () => {
    const c = cols(db);
    const acc = account({ timezone: 'America/Toronto' }); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    // yesterday 12:30–17:00 Toronto = 16:30–21:00Z on the 16th: all inside the last 24 h, none inside today
    const yesterday = Array.from({ length: 30 }, (_, i) => sentSend(cp, acc, new Date(Date.UTC(2026, 8, 16, 16, 30 + i * 9)), i));
    await c.sends.insertMany(yesterday);
    let cap = await accountCapacity(db, acc, now, cp.schedule.timezone);
    expect(cap.sentToday).toBe(0);
    expect(cap.capacity).toBe(30);
    expect(cap.zone).toBe('America/Toronto');
    // the planner books today's sends at 09:00 Toronto instead of waiting for yesterday's to age out
    const leads: LeadDoc[] = Array.from({ length: 10 }, (_, i) => ({ _id: new ObjectId(), campaignId: cp._id, space, email: `l${i}@x.ca`, domain: 'x.ca', vars: {}, provider: 'unknown', currentStep: 0, nextDueAt: null, status: 'queued', createdAt: now }));
    await c.leads.insertMany(leads);
    const morning = new Date('2026-09-17T13:05:00Z'); // 09:05 Toronto
    const plan = await planCampaign(db, cp, morning, () => 0.5);
    expect(plan.planned).toBe(10);
    // sends made today count
    await c.sends.insertMany(Array.from({ length: 5 }, (_, i) => sentSend(cp, acc, new Date('2026-09-17T14:00:00Z'), 100 + i)));
    cap = await accountCapacity(db, acc, now, cp.schedule.timezone);
    expect(cap.sentToday).toBe(5);
    expect(cap.pending).toBe(10);
    expect(cap.capacity).toBe(15);
  });

  it('gives a mailbox with no day of its own the zone of the campaign that uses it', async () => {
    const c = cols(db);
    const acc = account(); await c.emailAccounts.insertOne(acc);
    const cp = campaign([acc._id]); await c.campaigns.insertOne(cp);
    const loner = account(); await c.emailAccounts.insertOne(loner);
    expect(await assignMailboxZones(db)).toBe(1);
    expect((await c.emailAccounts.findOne({ _id: acc._id }))?.timezone).toBe('America/Toronto');
    expect((await c.emailAccounts.findOne({ _id: loner._id }))?.timezone).toBeUndefined();
    expect(await assignMailboxZones(db)).toBe(0);
  });
});
