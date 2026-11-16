import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { createSession, login, signup, userForToken } from '../../src/lib/server/auth';
import { spacesFor } from '../../src/lib/server/scope';
import { acceptInvite, cancelInvite, deleteOrganization, inviteForToken, inviteToOrg } from '../../src/lib/server/team';
import * as providerMod from '../../src/lib/server/mail/provider';

delete process.env.RESEND_API_KEY;
const mails: { to: string; subject: string; text: string }[] = [];
vi.spyOn(providerMod, 'providerFor').mockImplementation(() => ({ async send(mail: any) { mails.push(mail); return { internetMessageId: '<x@test>' }; } }) as any);

let db: Db;
beforeAll(async () => { db = await getDb(); await ensureIndexes(db); });
afterAll(async () => { await closeDb(); });

const stamp = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const linkIn = (text: string) => text.match(/https?:\/\/[^\s]+\/join\/([A-Za-z0-9_-]+)/)?.[1] ?? '';

async function team(name: string) {
  const c = cols(db);
  const owner = await signup(db, { email: `owner${stamp()}@test.local`, name: 'Owner', password: 'pw-123456' });
  const org = { _id: new ObjectId(), name, members: [{ userId: owner._id, role: 'owner' as const, addedAt: new Date() }], createdAt: new Date() };
  await c.orgs.insertOne(org);
  // the team's own mailbox: Hedwig's invitation email goes out from it (no Resend key here)
  await c.emailAccounts.insertOne({ _id: new ObjectId(), space: `org:${org._id}`, ownerUserId: owner._id, address: `team${stamp()}@test.local`, fromName: name, kind: 'imapSmtp', status: 'active', dailyLimit: 30, ramp: { enabled: false, startedAt: new Date() }, secrets: '', sync: {}, createdAt: new Date() });
  return { owner, org };
}

describe('auth + spaces', () => {
  it('signs up, logs in, sessions resolve; a new account is only in its Personal space', async () => {
    const email = `u${stamp()}@test.local`;
    const u = await signup(db, { email, name: 'Test', password: 'pw-123456' });
    expect(await login(db, { email, password: 'pw-123456' })).not.toBeNull();
    expect(await login(db, { email, password: 'wrong-pass' })).toBeNull();
    const s = await createSession(db, u._id);
    expect((await userForToken(db, s.token))?.email).toBe(email);
    expect(await userForToken(db, 'nope')).toBeNull();
    expect(spacesFor(u, await cols(db).orgs.find({ 'members.userId': u._id }).toArray()).map((x) => x.kind)).toEqual(['personal']);
  });
});

describe('team invitations', () => {
  it('signing up or logging in with an invited address joins nothing: only the emailed link does, into that team only', async () => {
    const c = cols(db);
    const { owner, org } = await team('Alpha');
    const other = await team('Beta'); // a second team that must never see this person
    const email = `invitee${stamp()}@test.local`;
    mails.length = 0;
    const r = await inviteToOrg(db, { orgId: org._id, inviter: owner, email, origin: 'http://localhost:5180' });
    expect(r).toMatchObject({ email, org: 'Alpha', emailed: true });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(email);
    const token = linkIn(mails[0].text);
    expect(token).not.toBe('');

    // someone signs up with the invited address without the link: no team
    const u = await signup(db, { email, name: 'Invitee', password: 'pw-123456' });
    await login(db, { email, password: 'pw-123456' });
    expect(await c.orgs.countDocuments({ 'members.userId': u._id })).toBe(0);

    // with the link, signed in as that address: Alpha, as a member, and not Beta
    const joined = await acceptInvite(db, token, u);
    expect(joined.ok).toBe(true);
    const spaces = spacesFor(u, await c.orgs.find({ 'members.userId': u._id }).toArray());
    expect(spaces.map((s) => [s.name, s.kind, s.role])).toEqual([['Alpha', 'org', 'member'], ['Personal', 'personal', undefined]]);
    expect((await c.orgs.findOne({ _id: other.org._id }))!.members.some((m) => m.userId.equals(u._id))).toBe(false);
    // the link is spent
    expect((await inviteForToken(db, token)).ok).toBe(false);
    expect((await c.invites.findOne({ orgId: org._id, email }))?.acceptedBy?.equals(u._id)).toBe(true);
  });

  it('a link works only for its address, only until it expires, and not after it is cancelled or the team is deleted', async () => {
    const c = cols(db);
    const { owner, org } = await team('Gamma');
    const email = `gamma${stamp()}@test.local`;
    mails.length = 0;
    await inviteToOrg(db, { orgId: org._id, inviter: owner, email, origin: 'http://localhost:5180' });
    const token = linkIn(mails[0].text);
    const stranger = await signup(db, { email: `stranger${stamp()}@test.local`, name: 'S', password: 'pw-123456' });
    expect(await acceptInvite(db, token, stranger)).toMatchObject({ ok: false, reason: expect.stringContaining(email) });
    expect(await c.orgs.countDocuments({ 'members.userId': stranger._id })).toBe(0);
    // expired
    const invited = await signup(db, { email, name: 'I', password: 'pw-123456' });
    expect((await acceptInvite(db, token, invited, new Date(Date.now() + 15 * 864e5))).ok).toBe(false);
    // cancelled by an owner: a member or a stranger cannot cancel it
    const invite = (await c.invites.findOne({ orgId: org._id, email }))!;
    expect(await cancelInvite(db, invite._id, stranger._id)).toBe(false);
    expect(await cancelInvite(db, invite._id, owner._id)).toBe(true);
    expect((await acceptInvite(db, token, invited)).ok).toBe(false);
    // a team that is gone takes its invitations with it
    mails.length = 0;
    await inviteToOrg(db, { orgId: org._id, inviter: owner, email, origin: 'http://localhost:5180' });
    const again = linkIn(mails[0].text);
    await deleteOrganization(db, org._id);
    expect((await inviteForToken(db, again)).ok).toBe(false);
    expect(await c.emailAccounts.countDocuments({ space: `org:${org._id}` })).toBe(0);
  });

  it('only an owner invites, and the email goes from the team\'s own mailbox, never one from another space', async () => {
    const { owner, org } = await team('Delta');
    const member = await signup(db, { email: `member${stamp()}@test.local`, name: 'M', password: 'pw-123456' });
    await cols(db).orgs.updateOne({ _id: org._id }, { $push: { members: { userId: member._id, role: 'member', addedAt: new Date() } } });
    await expect(inviteToOrg(db, { orgId: org._id, inviter: member, email: `x${stamp()}@test.local`, origin: 'http://localhost:5180' })).rejects.toMatchObject({ code: 'forbidden' });
    const teamBox = await cols(db).emailAccounts.findOne({ space: `org:${org._id}` });
    const r = await inviteToOrg(db, { orgId: org._id, inviter: owner, email: `y${stamp()}@test.local`, origin: 'http://localhost:5180' });
    expect(r.via).toBe(teamBox!.address);
    // no mailbox in the team and no Resend key: the invitation is kept, and the reason it was not emailed is said
    await cols(db).emailAccounts.updateMany({ space: `org:${org._id}` }, { $set: { status: 'paused' } });
    const unsent = await inviteToOrg(db, { orgId: org._id, inviter: owner, email: `z${stamp()}@test.local`, origin: 'http://localhost:5180' });
    expect(unsent).toMatchObject({ emailed: false, error: expect.stringContaining('no active mailbox') });
  });
});
