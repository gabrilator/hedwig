/**
 * The sender against a fake provider on the local MongoDB (database hedwig_test).
 * Proves: atomic claim, idempotent recovery (a crash between provider and record never double-sends), stop on reply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { planCampaign } from '../../src/lib/server/planner';
import { reconcileClaims, runSender } from '../../src/lib/server/sender';
import { applyReply } from '../../src/lib/server/inbox';
import { seal } from '../../src/lib/server/crypto';
import type { CampaignDoc, EmailAccountDoc, LeadDoc } from '../../src/lib/server/types';
import * as providerMod from '../../src/lib/server/mail/provider';

process.env.HEDWIG_MASTER_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.ORIGIN ||= 'http://localhost:5180';

const sentByFake: { to: string; subject: string; sendId: string; ids: any }[] = [];
let crashAfterProviderAccepts = false;
const fake = {
  kind: 'imapSmtp' as const,
  async test() { return { ok: true, detail: 'fake' }; },
  async send(mail: any, _thread: any, onPrepared?: (ids: any) => Promise<void>) {
    const ids = { internetMessageId: `<${mail.sendId}@fake>` };
    if (onPrepared) await onPrepared(ids);
    sentByFake.push({ to: mail.to, subject: mail.subject, sendId: mail.sendId, ids });
    if (crashAfterProviderAccepts) throw new Error('socket hang up after 250 OK');
    return ids;
  },
  async fetchNew() { return { items: [], state: {} }; },
  async getMessage(): Promise<any> { throw new Error('n/a'); },
  async findSent(id: string) { return { found: sentByFake.some((s) => s.ids.internetMessageId === id) }; }
};
vi.spyOn(providerMod, 'providerFor').mockImplementation(() => fake as any);

let db: Db;
const space = 'user:' + new ObjectId().toHexString();
const now = new Date('2026-09-03T10:00:00Z'); // Thu 11:00 Lisbon, inside 09:00–15:00

function account(over: Partial<EmailAccountDoc> = {}): EmailAccountDoc {
  return { _id: new ObjectId(), space, ownerUserId: new ObjectId(), address: `box${Math.random().toString(36).slice(2, 7)}@test.local`, fromName: 'Test', kind: 'imapSmtp', status: 'active', dailyLimit: 40, ramp: { enabled: false, startedAt: now }, secrets: seal({ imapPass: 'x', smtpPass: 'x' }), imap: { host: 'h', port: 993, secure: true, user: 'u' }, smtp: { host: 'h', port: 465, secure: true, user: 'u' }, sync: {}, createdAt: now, ...over };
}
function campaign(accountIds: ObjectId[], over: Partial<CampaignDoc> = {}): CampaignDoc {
  return { _id: new ObjectId(), space, ownerUserId: new ObjectId(), name: 'T', status: 'active', schedule: { timezone: 'Europe/Lisbon', from: '09:00', to: '15:00', days: [1, 2, 3, 4, 5] }, steps: [{ subject: 'Hola {{companyName}}', body: 'Hola {{firstName|there}}', delayDays: 0 }, { subject: null, body: 'Seguimiento', delayDays: 2 }], accountIds, dailyLimit: 30, stopOnReply: true, oooStops: false, openTracking: true, testRecipient: 't@test.local', unsubscribeLine: 'Baja', agentRules: [], createdAt: now, updatedAt: now, ...over };
}
function lead(campaignId: ObjectId, i: number): LeadDoc {
  return { _id: new ObjectId(), campaignId, space, email: `lead${i}@example.org`, domain: 'example.org', vars: { companyName: `Empresa ${i}` }, provider: 'unknown', currentStep: 0, nextDueAt: null, status: 'queued', createdAt: now };
}

beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); });
afterAll(async () => { await db.dropDatabase(); await closeDb(); });
beforeEach(() => { sentByFake.length = 0; crashAfterProviderAccepts = false; });

describe('planner + sender', () => {
  it('plans inside the window, sends due sends once, pins the mailbox and schedules the follow-up', async () => {
    const c = cols(db);
    const a = account(); await c.emailAccounts.insertOne(a);
    const cp = campaign([a._id]); await c.campaigns.insertOne(cp);
    await c.leads.insertMany(Array.from({ length: 5 }, (_, i) => lead(cp._id, i)));
    const plan = await planCampaign(db, cp, now, () => 0.5);
    expect(plan.planned).toBe(5);
    const again = await planCampaign(db, cp, now, () => 0.5);
    expect(again.planned).toBe(0); // idempotent
    const sends = await c.sends.find({ campaignId: cp._id }).toArray();
    expect(sends.every((s) => s.dueAt > now && s.dueAt < new Date('2026-09-03T14:00:00Z'))).toBe(true);
    const late = new Date('2026-09-03T14:00:00Z');
    const r = await runSender(db, late);
    expect(r.sent).toBe(5);
    expect(sentByFake).toHaveLength(5);
    expect(sentByFake[0].subject).toMatch(/^Hola Empresa/);
    const l = await c.leads.findOne({ email: 'lead0@example.org' });
    expect(l?.status).toBe('contacted');
    expect(l?.currentStep).toBe(1);
    expect(l?.accountId?.equals(a._id)).toBe(true);
    expect(l?.nextDueAt?.toISOString()).toBe(new Date(l!.lastEventAt!.getTime() + 2 * 864e5).toISOString());
    expect(await c.events.countDocuments({ campaignId: cp._id, type: 'sent' })).toBe(5);
    expect(await c.dailyStats.countDocuments({ campaignId: cp._id })).toBe(1);
    expect((await runSender(db, late)).sent).toBe(0); // nothing left
  });

  it('never sends twice when the provider accepted but the record step crashed', async () => {
    const c = cols(db);
    const a = account(); await c.emailAccounts.insertOne(a);
    const cp = campaign([a._id]); await c.campaigns.insertOne(cp);
    await c.leads.insertOne(lead(cp._id, 99));
    await planCampaign(db, cp, now, () => 0.5);
    crashAfterProviderAccepts = true;
    const late = new Date('2026-09-03T14:00:00Z');
    const r1 = await runSender(db, late);
    expect(r1.failed).toBe(1);
    expect(sentByFake).toHaveLength(1);
    // the failed attempt was re-planned; a naive retry would send again. Reconcile first, like the worker does.
    const send = await c.sends.findOne({ campaignId: cp._id });
    expect(send?.ids?.internetMessageId).toBeDefined();
    await c.sends.updateOne({ _id: send!._id }, { $set: { status: 'claimed', claimedAt: new Date(late.getTime() - 20 * 60_000) } });
    crashAfterProviderAccepts = false;
    const rec = await reconcileClaims(db, late);
    expect(rec.confirmed).toBe(1);
    expect((await c.sends.findOne({ _id: send!._id }))?.status).toBe('sent');
    expect((await runSender(db, late)).sent).toBe(0);
    expect(sentByFake).toHaveLength(1);
  });

  it('respects the mailbox limit shared across campaigns', async () => {
    const c = cols(db);
    const a = account({ dailyLimit: 3 }); await c.emailAccounts.insertOne(a);
    const cp1 = campaign([a._id]); const cp2 = campaign([a._id]);
    await c.campaigns.insertMany([cp1, cp2]);
    await c.leads.insertMany([...Array.from({ length: 4 }, (_, i) => lead(cp1._id, 100 + i)), ...Array.from({ length: 4 }, (_, i) => lead(cp2._id, 200 + i))]);
    const p1 = await planCampaign(db, cp1, now, () => 0.5);
    const p2 = await planCampaign(db, cp2, now, () => 0.5);
    expect(p1.planned + p2.planned).toBe(3);
  });

  it('a reply stops the sequence and cancels booked sends', async () => {
    const c = cols(db);
    const a = account(); await c.emailAccounts.insertOne(a);
    const cp = campaign([a._id]); await c.campaigns.insertOne(cp);
    const l = lead(cp._id, 300); await c.leads.insertOne(l);
    await planCampaign(db, cp, now, () => 0.5);
    await runSender(db, new Date('2026-09-03T14:00:00Z'));
    // follow-up becomes due two days later; plan it, then a reply arrives
    const later = new Date('2026-09-07T10:00:00Z'); // Monday
    await c.leads.updateOne({ _id: l._id }, { $set: { nextDueAt: new Date('2026-09-05T14:00:00Z') } });
    const p = await planCampaign(db, cp, later, () => 0.5);
    expect(p.planned).toBe(1);
    const fresh = (await c.leads.findOne({ _id: l._id }))!;
    await applyReply(db, a, cp, fresh, { providerId: 'x', from: fresh.email, to: [a.address], subject: 'RE: Hola', text: 'Nos interesa', receivedAt: later, headers: {}, references: [] } as any);
    expect((await c.leads.findOne({ _id: l._id }))?.status).toBe('replied');
    expect(await c.sends.countDocuments({ leadId: l._id, status: 'cancelled' })).toBe(1);
    expect((await runSender(db, new Date('2026-09-07T14:00:00Z'))).sent).toBe(0);
  });
});

it('a locked workspace does not prevent sending in another workspace', async () => {
  const c = cols(db), blockedSpace = 'user:' + new ObjectId();
  const blockedAccount = account({ space: blockedSpace });
  const healthyAccount = account();
  await c.emailAccounts.insertMany([blockedAccount, healthyAccount]);
  const blocked = campaign([blockedAccount._id], { space: blockedSpace });
  const healthy = campaign([healthyAccount._id]);
  await c.campaigns.insertMany([blocked, healthy]);
  const blockedLead = { ...lead(blocked._id, 900), space: blockedSpace };
  const healthyLead = lead(healthy._id, 901);
  await c.leads.insertMany([blockedLead, healthyLead]);
  await planCampaign(db, blocked, now, () => 0.5);
  await planCampaign(db, healthy, now, () => 0.5);
  await db.collection('workspaceLocks').insertOne({ _id: blockedSpace as any, token: 'test-lock' });
  try {
    await runSender(db, new Date('2026-09-03T14:00:00Z'));
    expect(sentByFake.some(s => s.to === healthyLead.email)).toBe(true);
    expect(sentByFake.some(s => s.to === blockedLead.email)).toBe(false);
  } finally { await db.collection('workspaceLocks').deleteOne({ _id: blockedSpace as any }); }
});
