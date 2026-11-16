/**
 * Team invitations: the one way into an organization besides creating it.
 *
 * An owner invites an address; Hedwig emails that address a link with a one-time token (only its SHA-256 is stored).
 * Joining needs the link AND being signed in as the invited address, so:
 *  - nobody joins by signing up with an invited address they do not read (sign-up does not verify addresses);
 *  - a forwarded link cannot put a different account into the team;
 *  - an existing user is never added without opening the link (a typo cannot hand a stranger the team's data);
 *  - the link names one invite, which names one organization: the person lands in that team and no other.
 * Re-inviting rotates the token (the old link stops working); cancelling deletes it; it expires after INVITE_DAYS.
 * The invitation email goes out through the organization's own space (Resend, or that team's first active mailbox).
 */
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import { randomToken, sha256 } from './crypto';
import { orgSpace } from './scope';
import { sendSystemMail } from './systemMail';
import { OperationError } from './operations';
import { isEmail } from './render';
import type { InviteDoc, OrgDoc, UserDoc } from './types';

export const INVITE_DAYS = 14;
const DAY = 864e5;
const normalize = (e: string) => e.trim().toLowerCase();

export interface InviteResult {
  email: string;
  org: string;
  /** already in the team: nothing was sent */
  alreadyMember?: boolean;
  emailed: boolean;
  via: string;
  error?: string;
  expiresAt?: Date;
}

/** Invite (or re-invite) an address to an organization the inviter owns, and email it the join link. */
export async function inviteToOrg(db: Db, input: { orgId: ObjectId; inviter: Pick<UserDoc, '_id' | 'name' | 'email'>; email: string; origin: string; now?: Date }): Promise<InviteResult> {
  const c = cols(db);
  const now = input.now ?? new Date();
  const email = normalize(input.email);
  if (!isEmail(email)) throw new OperationError('invalid_input', 'That is not an email address.');
  const org = await c.orgs.findOne({ _id: input.orgId, members: { $elemMatch: { userId: input.inviter._id, role: 'owner' } } });
  if (!org) throw new OperationError('forbidden', 'Only an owner of this organization can invite.');
  const existing = await c.users.findOne({ email }, { projection: { _id: 1 } });
  if (existing && org.members.some((m) => m.userId.equals(existing._id))) return { email, org: org.name, alreadyMember: true, emailed: false, via: 'none' };

  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * DAY);
  // One invite per (org, address): a new one replaces the old link, and a used one (someone who left) is reopened.
  await c.invites.updateOne(
    { orgId: org._id, email },
    { $set: { tokenHash: sha256(token), expiresAt, invitedBy: input.inviter._id, sentAt: now }, $unset: { acceptedAt: '', acceptedBy: '' }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  const who = input.inviter.name || input.inviter.email;
  const link = `${input.origin.replace(/\/$/, '')}/join/${token}`;
  const mailed = await sendSystemMail(db, orgSpace(org._id), {
    to: email,
    subject: `${who} invited you to ${org.name} on Hedwig`,
    text: [
      `${who} (${input.inviter.email}) invited you to join "${org.name}" on Hedwig.`, '',
      `Open this link to join. You sign in, or create your account, with ${email}:`, link, '',
      `The link works once and expires in ${INVITE_DAYS} days. If you did not expect this, ignore it: nothing happens until the link is opened.`
    ].join('\n')
  });
  return { email, org: org.name, emailed: mailed.sent, via: mailed.via, error: mailed.error, expiresAt };
}

export type InviteCheck =
  | { ok: true; invite: InviteDoc; org: OrgDoc }
  | { ok: false; reason: string };

/** What a join link points at, if it still works. Read-only: opening the page never joins anyone. */
export async function inviteForToken(db: Db, token: string, now = new Date()): Promise<InviteCheck> {
  const gone = { ok: false as const, reason: 'This invitation link no longer works: it was used, cancelled, replaced by a newer one, or it expired. Ask an owner of the team to invite you again.' };
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return gone;
  const c = cols(db);
  const invite = await c.invites.findOne({ tokenHash: sha256(token) });
  if (!invite || invite.acceptedAt || !invite.expiresAt || invite.expiresAt <= now) return gone;
  const org = await c.orgs.findOne({ _id: invite.orgId });
  if (!org) return gone;
  return { ok: true, invite, org };
}

/**
 * Join the organization the link names, as `user`. The invite is claimed with one atomic findOneAndUpdate (Law 3), so a
 * link works once even when two tabs press Join; the membership push is idempotent. Only the invited address may join.
 */
export async function acceptInvite(db: Db, token: string, user: Pick<UserDoc, '_id' | 'email'>, now = new Date()): Promise<{ ok: true; org: OrgDoc } | { ok: false; reason: string }> {
  const check = await inviteForToken(db, token, now);
  if (!check.ok) return check;
  if (normalize(user.email) !== check.invite.email) return { ok: false, reason: `This invitation is for ${check.invite.email}. You are signed in as ${user.email}: sign out, then open the link again.` };
  const c = cols(db);
  const claimed = await c.invites.findOneAndUpdate(
    { _id: check.invite._id, tokenHash: sha256(token), acceptedAt: { $exists: false }, expiresAt: { $gt: now } },
    { $set: { acceptedAt: now, acceptedBy: user._id }, $unset: { tokenHash: '' } }
  );
  if (!claimed) return { ok: false, reason: 'This invitation link was just used.' };
  await c.orgs.updateOne({ _id: check.org._id, 'members.userId': { $ne: user._id } }, { $push: { members: { userId: user._id, role: 'member', addedAt: now } } });
  const org = await c.orgs.findOne({ _id: check.org._id });
  if (!org) return { ok: false, reason: 'The team was deleted.' };
  return { ok: true, org };
}

/** Cancel a pending invitation; any owner of its organization may. */
export async function cancelInvite(db: Db, inviteId: ObjectId, byUserId: ObjectId): Promise<boolean> {
  const c = cols(db);
  const invite = await c.invites.findOne({ _id: inviteId, acceptedAt: { $exists: false } });
  if (!invite) return false;
  const owner = await c.orgs.findOne({ _id: invite.orgId, members: { $elemMatch: { userId: byUserId, role: 'owner' } } }, { projection: { _id: 1 } });
  if (!owner) return false;
  return (await c.invites.deleteOne({ _id: invite._id, acceptedAt: { $exists: false } })).deletedCount === 1;
}

/** Every collection that holds a workspace's data, by `space`. Deleting an organization empties all of them. */
export const SPACE_COLLECTIONS = ['sends', 'leads', 'messages', 'events', 'dailyStats', 'imports', 'campaigns', 'emailAccounts', 'suppressions', 'agents', 'llmCalls', 'researchTables', 'contacts', 'feedTokens', 'operationReceipts'] as const;

/** Delete an organization and everything in its space. Assistant connections are per account, so they stay (they move to the person's own space). */
export async function deleteOrganization(db: Db, orgId: ObjectId): Promise<void> {
  const space = orgSpace(orgId);
  for (const name of SPACE_COLLECTIONS) await db.collection(name).deleteMany({ space });
  await cols(db).invites.deleteMany({ orgId });
  await cols(db).orgs.deleteOne({ _id: orgId });
}
