import { fail, redirect, type Cookies } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { SESSION_COOKIE, SPACE_COOKIE, createSession, login, signup } from '$lib/server/auth';
import { acceptInvite, inviteForToken } from '$lib/server/team';
import { orgSpace } from '$lib/server/scope';
import { envOpt, secureCookies } from '$lib/server/env';
import { str } from '$lib/server/context';
import { notifyAdminsOfSignup } from '$lib/server/admin';
import type { ObjectId } from 'mongodb';

/**
 * A team invitation link. Opening it changes nothing (mail scanners open links too); joining is a button, and only the
 * invited address can press it: signed in as that address, or by logging in or creating the account for it right here.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
  const db = await getDb();
  const check = await inviteForToken(db, params.token);
  if (!check.ok) return { valid: false as const, reason: check.reason };
  const { invite, org } = check;
  const inviter = await cols(db).users.findOne({ _id: invite.invitedBy }, { projection: { name: 1, email: 1 } });
  const me = locals.user;
  const hasAccount = me ? true : !!(await cols(db).users.findOne({ email: invite.email }, { projection: { _id: 1 } }));
  const alreadyIn = !!me && org.members.some((m) => m.userId.equals(me._id));
  return {
    valid: true as const, org: org.name, email: invite.email, inviter: inviter ? inviter.name || inviter.email : 'An owner',
    signedInAs: me?.email ?? null, sameUser: !!me && me.email === invite.email, hasAccount, alreadyIn
  };
};

const goToTeam = (cookies: Cookies, orgId: ObjectId) => {
  cookies.set(SPACE_COOKIE, orgSpace(orgId), { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
  redirect(303, '/campaigns');
};
const signIn = async (cookies: Cookies, userId: ObjectId) => {
  const s = await createSession(await getDb(), userId);
  cookies.set(SESSION_COOKIE, s.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), expires: s.expiresAt });
};

export const actions: Actions = {
  /** Signed in as the invited address: join. */
  accept: async ({ params, locals, cookies }) => {
    if (!locals.user) return fail(401, { error: 'Sign in first.' });
    const r = await acceptInvite(await getDb(), params.token, locals.user);
    if (!r.ok) return fail(400, { error: r.reason });
    goToTeam(cookies, r.org._id);
  },
  /** Not signed in, the address has an account: its password, then join. */
  login: async ({ params, request, cookies, locals }) => {
    if (locals.user) return fail(400, { error: 'You are already signed in.' });
    const db = await getDb();
    const check = await inviteForToken(db, params.token);
    if (!check.ok) return fail(400, { error: check.reason });
    const user = await login(db, { email: check.invite.email, password: String((await request.formData()).get('password') ?? '') });
    if (!user) return fail(400, { error: 'That password is not right.' });
    await signIn(cookies, user._id);
    const r = await acceptInvite(db, params.token, user);
    if (!r.ok) return fail(400, { error: r.reason });
    goToTeam(cookies, r.org._id);
  },
  /** Not signed in, no account yet: create it for the invited address (the link proves they read it), then join. */
  signup: async ({ params, request, cookies, locals, url }) => {
    if (locals.user) return fail(400, { error: 'You are already signed in.' });
    const db = await getDb();
    const check = await inviteForToken(db, params.token);
    if (!check.ok) return fail(400, { error: check.reason });
    const fd = await request.formData();
    let user;
    try { user = await signup(db, { email: check.invite.email, name: str(fd, 'name'), password: String(fd.get('password') ?? '') }); }
    catch (e: any) { return fail(400, { error: e.message, name: str(fd, 'name') }); }
    await signIn(cookies, user._id);
    void notifyAdminsOfSignup(db, user, envOpt('ORIGIN') || url.origin).catch(() => {});
    const r = await acceptInvite(db, params.token, user);
    if (!r.ok) return fail(400, { error: r.reason });
    goToTeam(cookies, r.org._id);
  }
};
