import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, destroySession } from '$lib/server/auth';

export const load: PageServerLoad = async () => { redirect(303, '/campaigns'); };
export const actions: Actions = {
  default: async ({ cookies }) => {
    await destroySession(await getDb(), cookies.get(SESSION_COOKIE));
    cookies.delete(SESSION_COOKIE, { path: '/' });
    redirect(303, '/login');
  }
};
