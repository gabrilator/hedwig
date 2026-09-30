import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, createSession, signup } from '$lib/server/auth';
import { str } from '$lib/server/context';
import { secureCookies } from '$lib/server/env';

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const fd = await request.formData();
    const email = str(fd, 'email'), name = str(fd, 'name'), password = String(fd.get('password') ?? '');
    if (!email || !password) return fail(400, { error: 'Email and password, please.', email, name });
    const db = await getDb();
    try {
      const user = await signup(db, { email, name, password });
      const s = await createSession(db, user._id);
      cookies.set(SESSION_COOKIE, s.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), expires: s.expiresAt });
    } catch (e: any) {
      return fail(400, { error: e.message, email, name });
    }
    redirect(303, '/campaigns');
  }
};
