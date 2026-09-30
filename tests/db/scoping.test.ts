import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { createSession, login, signup, userForToken, acceptInvites } from '../../src/lib/server/auth';
import { spacesFor } from '../../src/lib/server/scope';

let db: Db;
beforeAll(async () => { db = await getDb(); await ensureIndexes(db); });
afterAll(async () => { await closeDb(); });

describe('auth + spaces', () => {
  it('signs up, logs in, sessions resolve, invites become memberships', async () => {
    const c = cols(db);
    const email = `u${Date.now()}@test.local`;
    const u = await signup(db, { email, name: 'Test', password: 'jijijaja' });
    expect(await login(db, { email, password: 'wrong' })).toBeNull();
    expect((await login(db, { email, password: 'jijijaja' }))?._id.equals(u._id)).toBe(true);
    const s = await createSession(db, u._id);
    expect((await userForToken(db, s.token))?.email).toBe(email);
    expect(await userForToken(db, 'nope')).toBeNull();
    const org = { _id: new ObjectId(), name: 'Org', members: [{ userId: new ObjectId(), role: 'owner' as const, addedAt: new Date() }], createdAt: new Date() };
    await c.orgs.insertOne(org);
    await c.invites.insertOne({ _id: new ObjectId(), orgId: org._id, email, invitedBy: org.members[0].userId, createdAt: new Date() });
    expect(await acceptInvites(db, u)).toBe(1);
    const orgs = await c.orgs.find({ 'members.userId': u._id }).toArray();
    const spaces = spacesFor(u, orgs);
    expect(spaces.map((x) => x.kind)).toEqual(['org', 'personal']);
    expect(spaces[0].role).toBe('member');
  });
});
