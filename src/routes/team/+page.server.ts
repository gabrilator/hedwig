import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, oid, plain, str } from '$lib/server/context';
import { SPACE_COOKIE, normalizeEmail, passwordOk } from '$lib/server/auth';
import { hashPassword, verifyPassword } from '$lib/server/crypto';
import { orgSpace, personalSpace } from '$lib/server/scope';
import { secureCookies } from '$lib/server/env';
import { sendSystemMail, systemSender } from '$lib/server/systemMail';
import { isEmail } from '$lib/server/render';

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
      invites: invites.filter((i) => i.orgId.equals(o._id)).map((i) => ({ id: i._id.toHexString(), email: i.email, createdAt: i.createdAt })),
      ...counts.find((x) => x.id === o._id.toHexString())
    }))),
    personal, sender: await systemSender(db, c.space.key)
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
  invite: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db); const fd = await request.formData();
    const orgId = oid(str(fd, 'org')); const email = normalizeEmail(str(fd, 'email'));
    if (!isEmail(email)) return fail(400, { error: 'That is not an email address.' });
    const org = await col.orgs.findOne({ _id: orgId, members: { $elemMatch: { userId: c.user._id, role: 'owner' } } });
    if (!org) return fail(400, { error: 'Only an owner can invite.' });
    const user = await col.users.findOne({ email });
    if (user) {
      if (org.members.some((m) => m.userId.equals(user._id))) return fail(400, { error: `${email} is already a member.` });
      await col.orgs.updateOne({ _id: orgId }, { $push: { members: { userId: user._id, role: 'member', addedAt: new Date() } } });
      return { note: `${email} added to ${org.name}` };
    }
    await col.invites.updateOne({ orgId, email }, { $setOnInsert: { invitedBy: c.user._id, createdAt: new Date() } }, { upsert: true });
    let mailed = { sent: false, via: 'none' };
    try { mailed = await sendSystemMail(db, c.space.key, { to: email, subject: `${c.user.name || c.user.email} invited you to ${org.name} on Hedwig`, text: `${c.user.name || c.user.email} added you to "${org.name}" on Hedwig.\n\nSign up with this email address and the campaigns will be there:\n${new URL(request.url).origin}/signup\n` }); } catch { /* shown below */ }
    return { note: mailed.sent ? `Invitation emailed to ${email} from ${mailed.via}` : `${email} is invited: when they sign up with that address they join ${org.name}. No invite email went out (no Resend key and no connected mailbox in this space).` };
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
    const campaignIds = (await col.campaigns.find({ space }, { projection: { _id: 1 } }).toArray()).map((x) => x._id);
    await col.sends.deleteMany({ campaignId: { $in: campaignIds } });
    await col.leads.deleteMany({ campaignId: { $in: campaignIds } });
    await col.messages.deleteMany({ space });
    await col.events.deleteMany({ space });
    await col.dailyStats.deleteMany({ space });
    await col.imports.deleteMany({ space });
    await col.campaigns.deleteMany({ space });
    await col.emailAccounts.deleteMany({ space });
    await col.suppressions.deleteMany({ space });
    await col.agents.deleteMany({ space });
    await col.llmCalls.deleteMany({ space });
    await col.invites.deleteMany({ orgId });
    await col.orgs.deleteOne({ _id: orgId });
    if (c.space.key === space) cookies.set(SPACE_COOKIE, personalSpace(c.user._id), { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
    return { note: `${org.name} deleted, with its ${campaignIds.length} campaign${campaignIds.length === 1 ? '' : 's'}` };
  },
  cancelInvite: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    await cols(db).invites.deleteOne({ _id: oid(str(fd, 'invite')), invitedBy: c.user._id });
    return { note: 'Invitation cancelled' };
  }
};
