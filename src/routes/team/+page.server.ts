import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, oid, plain, str } from '$lib/server/context';
import { SPACE_COOKIE, normalizeEmail, passwordOk } from '$lib/server/auth';
import { hashPassword, verifyPassword } from '$lib/server/crypto';
import { orgSpace, personalSpace } from '$lib/server/scope';
import { envOpt, secureCookies } from '$lib/server/env';
import { systemSender } from '$lib/server/systemMail';
import { cancelInvite, deleteOrganization, inviteToOrg } from '$lib/server/team';
import { OperationError } from '$lib/server/operations';

export const load: PageServerLoad = async ({ locals }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const orgs = await col.orgs.find({ 'members.userId': c.user._id }).toArray();
  const userIds = [...new Set(orgs.flatMap((o) => o.members.map((m) => m.userId.toHexString())))].map((s) => new ObjectId(s));
  const users = await col.users.find({ _id: { $in: userIds } }, { projection: { email: 1, name: 1 } }).toArray();
  const uname = new Map(users.map((u) => [u._id.toHexString(), u]));
  const invites = await col.invites.find({ orgId: { $in: orgs.map((o) => o._id) }, acceptedAt: { $exists: false } }).toArray();
  const counts = await Promise.all(orgs.map(async (o) => ({
    id: o._id.toHexString(), campaigns: await col.campaigns.countDocuments({ space: orgSpace(o._id) }), accounts: await col.emailAccounts.countDocuments({ space: orgSpace(o._id) })
  })));
  const personal = { campaigns: await col.campaigns.countDocuments({ space: `user:${c.user._id.toHexString()}` }), accounts: await col.emailAccounts.countDocuments({ space: `user:${c.user._id.toHexString()}` }) };
  return {
    orgs: plain(orgs.map((o) => ({
      id: o._id.toHexString(), name: o.name, key: orgSpace(o._id), myRole: o.members.find((m) => m.userId.equals(c.user._id))?.role,
      members: o.members.map((m) => ({ id: m.userId.toHexString(), email: uname.get(m.userId.toHexString())?.email ?? '?', name: uname.get(m.userId.toHexString())?.name ?? '', role: m.role })),
      invites: invites.filter((i) => i.orgId.equals(o._id)).map((i) => ({ id: i._id.toHexString(), email: i.email, createdAt: i.createdAt, sentAt: i.sentAt ?? null, live: !!i.tokenHash && !!i.expiresAt && i.expiresAt > new Date() })),
      ...counts.find((x) => x.id === o._id.toHexString())
    }))),
    personal, senders: Object.fromEntries(await Promise.all(orgs.map(async (o) => [o._id.toHexString(), await systemSender(db, orgSpace(o._id))])))
  };
};

export const actions: Actions = {
  switch: async ({ request, locals, cookies }) => {
    const c = ctx(locals);
    const key = str(await request.formData(), 'space');
    if (!c.spaces.some((s) => s.key === key)) return fail(400, { error: 'Unknown space' });
    cookies.set(SPACE_COOKIE, key, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
    const ref = request.headers.get('referer');
    redirect(303, ref && new URL(ref).pathname.startsWith('/') && !/\/campaigns\/[a-f0-9]{24}/.test(ref) ? new URL(ref).pathname : '/campaigns');
  },
  createOrg: async ({ request, locals, cookies }) => {
    const c = ctx(locals); const db = await getDb();
    const name = str(await request.formData(), 'name');
    if (!name) return fail(400, { error: 'Give the org a name.' });
    const _id = new ObjectId();
    await cols(db).orgs.insertOne({ _id, name, members: [{ userId: c.user._id, role: 'owner', addedAt: new Date() }], createdAt: new Date() });
    cookies.set(SPACE_COOKIE, orgSpace(_id), { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
    return { note: `${name} created` };
  },
  /** Emails a join link; the person joins only by opening it, signed in as that address. Sending it again replaces the link. */
  invite: async ({ request, locals, url }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    try {
      const r = await inviteToOrg(db, { orgId: oid(str(fd, 'org')), inviter: c.user, email: normalizeEmail(str(fd, 'email')), origin: envOpt('ORIGIN') || url.origin });
      if (r.alreadyMember) return fail(400, { error: `${r.email} is already in ${r.org}.` });
      if (r.emailed) return { note: `Invitation emailed to ${r.email} from ${r.via}. They join ${r.org} when they open the link.` };
      // saved, so the list must show it: a warning, not a failure
      return { warn: `The invitation to ${r.email} is saved, but the email did not go out: ${r.error ?? 'unknown error'} Fix that, then press resend.` };
    } catch (e) { if (e instanceof OperationError) return fail(400, { error: e.message }); throw e; }
  },
  /** An owner removes anyone; anyone removes themselves (leaves), as long as an owner stays behind. */
  remove: async ({ request, locals, cookies }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db); const fd = await request.formData();
    const orgId = oid(str(fd, 'org')); const userId = oid(str(fd, 'user'));
    const org = await col.orgs.findOne({ _id: orgId, 'members.userId': c.user._id });
    if (!org) return fail(404, { error: 'Org not found' });
    const me = org.members.find((m) => m.userId.equals(c.user._id))!;
    const self = userId.equals(c.user._id);
    if (!self && me.role !== 'owner') return fail(400, { error: 'Only an owner can remove members.' });
    const target = org.members.find((m) => m.userId.equals(userId));
    if (!target) return fail(404, { error: 'Not a member' });
    if (target.role === 'owner' && org.members.filter((m) => m.role === 'owner').length === 1) return fail(400, { error: self ? 'You are the only owner. Make someone else owner first, or delete the org.' : 'That is the only owner. Make someone else owner first.' });
    await col.orgs.updateOne({ _id: orgId }, { $pull: { members: { userId } } });
    if (self && c.space.key === orgSpace(orgId)) cookies.set(SPACE_COOKIE, personalSpace(c.user._id), { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
    return { note: self ? `You left ${org.name}` : 'Member removed' };
  },
  /** owner ↔ member. The last owner cannot step down. */
  role: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db); const fd = await request.formData();
    const orgId = oid(str(fd, 'org')); const userId = oid(str(fd, 'user')); const role = str(fd, 'role');
    if (role !== 'owner' && role !== 'member') return fail(400, { error: 'Unknown role' });
    const org = await col.orgs.findOne({ _id: orgId, members: { $elemMatch: { userId: c.user._id, role: 'owner' } } });
    if (!org) return fail(400, { error: 'Only an owner can change roles.' });
    const target = org.members.find((m) => m.userId.equals(userId));
    if (!target) return fail(404, { error: 'Not a member' });
    if (target.role === 'owner' && role === 'member' && org.members.filter((m) => m.role === 'owner').length === 1) return fail(400, { error: 'That is the only owner. Make someone else owner first.' });
    await col.orgs.updateOne({ _id: orgId, 'members.userId': userId }, { $set: { 'members.$.role': role } });
    return { note: `${role === 'owner' ? 'Now an owner' : 'Now a member'}` };
  },
  /** Your own name. */
  profile: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const name = str(fd, 'name');
    if (!name) return fail(400, { error: 'Give yourself a name.' });
    await cols(db).users.updateOne({ _id: c.user._id }, { $set: { name } });
    return { note: 'Name saved' };
  },
  password: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const current = String(fd.get('current') ?? ''); const next = String(fd.get('next') ?? '');
    if (!(await verifyPassword(current, c.user.passwordHash))) return fail(400, { error: 'The current password is not right.' });
    if (!passwordOk(next)) return fail(400, { error: 'The new password needs at least 6 characters.' });
    await cols(db).users.updateOne({ _id: c.user._id }, { $set: { passwordHash: await hashPassword(next) } });
    return { note: 'Password changed' };
  },
  rename: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const orgId = oid(str(fd, 'org')); const name = str(fd, 'name');
    if (!name) return fail(400, { error: 'Give the org a name.' });
    const r = await cols(db).orgs.updateOne({ _id: orgId, members: { $elemMatch: { userId: c.user._id, role: 'owner' } } }, { $set: { name } });
    if (!r.matchedCount) return fail(400, { error: 'Only an owner can rename an org.' });
    return { note: `Renamed to ${name}` };
  },
  /** Deleting an org takes everything in it: campaigns with their leads, sends and stats, mailboxes, agents, invites. The name must be typed. */
  deleteOrg: async ({ request, locals, cookies }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db); const fd = await request.formData();
    const orgId = oid(str(fd, 'org'));
    const org = await col.orgs.findOne({ _id: orgId, members: { $elemMatch: { userId: c.user._id, role: 'owner' } } });
    if (!org) return fail(400, { error: 'Only an owner can delete an org.' });
    if (str(fd, 'confirm') !== org.name) return fail(400, { error: `Type the org's name exactly (${org.name}) to delete it.` });
    const space = orgSpace(orgId);
    const campaigns = await col.campaigns.countDocuments({ space });
    await deleteOrganization(db, orgId);
    if (c.space.key === space) cookies.set(SPACE_COOKIE, personalSpace(c.user._id), { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
    return { note: `${org.name} deleted, with its ${campaigns} campaign${campaigns === 1 ? '' : 's'}` };
  },
  cancelInvite: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    if (!await cancelInvite(db, oid(str(fd, 'invite')), c.user._id)) return fail(400, { error: 'Only an owner of the team can cancel its invitations.' });
    return { note: 'Invitation cancelled: its link no longer works' };
  }
};
