import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, createSession, login } from '$lib/server/auth';
import { str } from '$lib/server/context';
import { secureCookies } from '$lib/server/env';

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const fd = await request.formData();
    const email = str(fd, 'email'), password = String(fd.get('password') ?? '');
    if (!email || !password) return fail(400, { error: 'Email and password, please.', email });
    const db = await getDb();
    const user = await login(db, { email, password });
    if (!user) return fail(400, { error: 'That email and password do not match.', email });
    const s = await createSession(db, user._id);
    cookies.set(SESSION_COOKIE, s.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), expires: s.expiresAt });
    const next = url.searchParams.get('next');
    redirect(303, next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/campaigns');
  }
};
