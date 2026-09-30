import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { cols } from './db';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto';
import { envOpt } from './env';
import type { UserDoc } from './types';

export const SESSION_COOKIE = 'hedwig_session';
export const SPACE_COOKIE = 'hedwig_space';
const SESSION_DAYS = 30;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const passwordOk = (p: string) => typeof p === 'string' && p.length >= 6;

export async function signup(db: Db, input: { email: string; name: string; password: string }): Promise<UserDoc> {
  const c = cols(db);
  const email = normalizeEmail(input.email);
  if (!passwordOk(input.password)) throw new Error('Password must be at least 6 characters');
  const existing = await c.users.findOne({ email });
  if (existing) throw new Error('There is already an account with that email. Log in instead.');
  const doc = { _id: new ObjectId(), email, name: input.name.trim() || email.split('@')[0], passwordHash: await hashPassword(input.password), createdAt: new Date() };
  await c.users.insertOne(doc);
  await acceptInvites(db, doc);
  return doc;
}

export async function login(db: Db, input: { email: string; password: string }): Promise<UserDoc | null> {
  const c = cols(db);
  const user = await c.users.findOne({ email: normalizeEmail(input.email) });
  if (!user) return null;
  if (!(await verifyPassword(input.password, user.passwordHash))) return null;
  await c.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  await acceptInvites(db, user);
  return user;
}

export async function createSession(db: Db, userId: ObjectId): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await cols(db).sessions.insertOne({ _id: new ObjectId(), userId, tokenHash: sha256(token), createdAt: new Date(), expiresAt });
  return { token, expiresAt };
}
export async function userForToken(db: Db, token: string | undefined): Promise<UserDoc | null> {
  if (!token) return null;
  const c = cols(db);
  const s = await c.sessions.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
  if (!s) return null;
  return c.users.findOne({ _id: s.userId });
}
export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await cols(db).sessions.deleteOne({ tokenHash: sha256(token) });
}

/** Pending invites for this email become memberships. */
export async function acceptInvites(db: Db, user: UserDoc): Promise<number> {
  const c = cols(db);
  const invites = await c.invites.find({ email: user.email, acceptedAt: { $exists: false } }).toArray();
  for (const inv of invites) {
    await c.orgs.updateOne({ _id: inv.orgId, 'members.userId': { $ne: user._id } }, { $push: { members: { userId: user._id, role: 'member', addedAt: new Date() } } });
    await c.invites.updateOne({ _id: inv._id }, { $set: { acceptedAt: new Date() } });
  }
  return invites.length;
}

/** Creates the first user (and its org) from BOOTSTRAP_* env the first time that email is unknown. Idempotent; never re-creates a deleted org. */
export async function bootstrap(db: Db): Promise<void> {
  const email = envOpt('BOOTSTRAP_USER_EMAIL');
  const password = envOpt('BOOTSTRAP_USER_PASSWORD');
  if (!email || !password) return;
  const c = cols(db);
  const existing = await c.users.findOne({ email: normalizeEmail(email) });
  if (existing) return; // the org is only created together with the user, so deleting it later sticks
  const user = await signup(db, { email, name: email.split('@')[0], password });
  console.log(`[hedwig] bootstrap user created: ${user.email}`);
  const orgName = envOpt('BOOTSTRAP_ORG_NAME');
  if (orgName) {
    await c.orgs.insertOne({ _id: new ObjectId(), name: orgName, members: [{ userId: user._id, role: 'owner', addedAt: new Date() }], createdAt: new Date() });
    console.log(`[hedwig] bootstrap org created: ${orgName}`);
  }
}
