import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { signup } from '../../src/lib/server/auth';
import { adminOverview, notifyAdminsOfSignup } from '../../src/lib/server/admin';
import { isAdminEmail } from '../../src/lib/server/env';
import { orgSpace, personalSpace } from '../../src/lib/server/scope';

let db: Db;
beforeAll(async () => { db = await getDb(); await ensureIndexes(db); });
afterAll(async () => { delete process.env.ADMIN_EMAILS; await closeDb(); });

describe('admin', () => {
  it('admin addresses come from ADMIN_EMAILS and cannot be claimed by signing up', async () => {
    process.env.ADMIN_EMAILS = ' Boss@Example.com, ops@example.com ';
    expect(isAdminEmail('boss@example.com')).toBe(true);
    expect(isAdminEmail('OPS@example.com')).toBe(true);
    expect(isAdminEmail('someone@example.com')).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    await expect(signup(db, { email: 'BOSS@example.com', name: 'x', password: 'secret1' })).rejects.toThrow(/cannot sign up/);
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail('boss@example.com')).toBe(false);
  });

  it('counts sign-ups and each account’s mailboxes, campaigns and sends across its spaces', async () => {
    const c = cols(db);
    const stamp = Date.now();
    const a = await signup(db, { email: `a${stamp}@example.com`, name: 'A', password: 'secret1' });
    const b = await signup(db, { email: `b${stamp}@example.com`, name: 'B', password: 'secret1' });
    const org = { _id: new ObjectId(), name: 'Org', members: [{ userId: a._id, role: 'owner' as const, addedAt: new Date() }], createdAt: new Date() };
    await c.orgs.insertOne(org);
    await c.emailAccounts.insertOne({ _id: new ObjectId(), space: personalSpace(a._id), address: `box${stamp}@example.com` } as any);
    await c.campaigns.insertMany([
      { _id: new ObjectId(), space: orgSpace(org._id), status: 'active', name: 'x' } as any,
      { _id: new ObjectId(), space: personalSpace(a._id), status: 'draft', name: 'y' } as any
    ]);
    const today = new Date().toISOString().slice(0, 10);
    await c.dailyStats.insertOne({ _id: new ObjectId(), day: today, space: orgSpace(org._id), campaignId: new ObjectId(), stepIndex: 0, accountId: new ObjectId(), sent: 7, opens: 0, uniqueOpens: 0, replies: 0, bounces: 0, ooo: 0, unsubscribes: 0 });

    const o = await adminOverview(db);
    expect(o.last24).toBeGreaterThanOrEqual(2);
    expect(o.perDay).toHaveLength(30);
    expect(o.perDay[29].day).toBe(today);
    expect(o.perDay[29].n).toBeGreaterThanOrEqual(2);
    const ra = o.rows.find((r) => r.id === a._id.toHexString())!;
    const rb = o.rows.find((r) => r.id === b._id.toHexString())!;
    expect(ra).toMatchObject({ mailboxes: 1, campaigns: 2, active: 1, sent30: 7 });
    expect(rb).toMatchObject({ mailboxes: 0, campaigns: 0, active: 0, sent30: 0 });
    expect(o.rows[0].joined.getTime()).toBeGreaterThanOrEqual(o.rows[o.rows.length - 1].joined.getTime());
  });

  it('sends no sign-up note without admins, or to an admin address that has no account', async () => {
    const who = { email: `new${Date.now()}@example.com`, name: 'New' };
    delete process.env.ADMIN_EMAILS;
    expect(await notifyAdminsOfSignup(db, who, 'https://hedwig.example.com')).toBe(0);
    process.env.ADMIN_EMAILS = `nobody${Date.now()}@example.com`;
    expect(await notifyAdminsOfSignup(db, who, 'https://hedwig.example.com')).toBe(0);
    delete process.env.ADMIN_EMAILS;
  });
});
