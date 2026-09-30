/**
 * The curious flag on the local MongoDB (database hedwig_test): who the daily check marks, that a person's call is final,
 * and that a reply clears only the check's mark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { markCurious, setCurious } from '../../src/lib/server/curious';
import { applyReply } from '../../src/lib/server/inbox';
import type { EmailAccountDoc, LeadDoc } from '../../src/lib/server/types';

let db: Db;
const space = 'user:' + new ObjectId().toHexString();
const campaignId = new ObjectId();
const accountId = new ObjectId();
const now = new Date('2026-09-23T06:30:00Z');

function lead(i: number, over: Partial<LeadDoc>): LeadDoc {
  return { _id: new ObjectId(), campaignId, space, email: `p${i}@firm${i}.example`, domain: `firm${i}.example`, vars: {}, provider: 'unknown', accountId, currentStep: 2, nextDueAt: null, status: 'opened', createdAt: now, ...over };
}

beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); });
afterAll(async () => { await db.dropDatabase(); await closeDb(); });

describe('curious', () => {
  it('marks people who opened more often than they got emails and never replied, once, and never someone a person judged', async () => {
    const c = cols(db);
    const leads = {
      three: lead(1, { openCount: 3 }), // 2 emails, 3 opens
      two: lead(2, { openCount: 2 }), // 2 emails, 2 opens: one load per email is what machines do on arrival
      oneEmail: lead(3, { currentStep: 1, openCount: 2, status: 'contacted' }),
      replied: lead(4, { openCount: 6, status: 'replied' }),
      reset: lead(5, { openCount: 9, curious: false, curiousBy: 'someone@test.local' }),
      queued: lead(6, { currentStep: 0, openCount: 0, status: 'queued' })
    };
    await c.leads.insertMany(Object.values(leads));
    expect(await markCurious(db, now)).toBe(2);
    expect(await markCurious(db, now)).toBe(0);
    const get = (l: LeadDoc) => c.leads.findOne({ _id: l._id });
    expect(await get(leads.three)).toMatchObject({ curious: true, curiousBy: 'rule', status: 'opened' });
    expect(await get(leads.oneEmail)).toMatchObject({ curious: true, status: 'contacted' });
    expect((await get(leads.two))?.curious).toBeUndefined();
    expect((await get(leads.replied))?.curious).toBeUndefined();
    expect((await get(leads.reset))?.curious).toBe(false);
    expect((await get(leads.queued))?.curious).toBeUndefined();
  });

  it('a person sets or resets it for good, and a reply clears only the daily check\'s mark', async () => {
    const c = cols(db);
    const byRule = lead(7, { openCount: 5, curious: true, curiousAt: now, curiousBy: 'rule' });
    const byPerson = lead(8, { openCount: 1, curious: true, curiousAt: now, curiousBy: 'someone@test.local' });
    await c.leads.insertMany([byRule, byPerson]);
    const account = { _id: accountId, space, address: 'box@test.local' } as EmailAccountDoc;
    const full = (l: LeadDoc) => ({ providerId: '1', from: l.email, subject: 'Re: hola', receivedAt: now, to: ['box@test.local'], text: 'Gracias, lo miro.', headers: {} });
    await applyReply(db, account, null, byRule, full(byRule));
    await applyReply(db, account, null, byPerson, full(byPerson));
    expect(await c.leads.findOne({ _id: byRule._id })).toMatchObject({ curious: false, status: 'replied' });
    expect((await c.leads.findOne({ _id: byPerson._id }))?.curious).toBe(true);
    const again = lead(9, { openCount: 7 });
    await c.leads.insertOne(again);
    expect(await setCurious(db, again._id, campaignId, false, 'someone@test.local')).toBe(true);
    await markCurious(db, now);
    expect(await c.leads.findOne({ _id: again._id })).toMatchObject({ curious: false, curiousBy: 'someone@test.local' });
    expect(await setCurious(db, new ObjectId(), campaignId, true, 'someone@test.local')).toBe(false);
  });
});
