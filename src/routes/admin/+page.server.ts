import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { isAdminEmail } from '$lib/server/env';
import { adminOverview } from '$lib/server/admin';

/** Every account on the server, for the addresses in ADMIN_EMAILS; everyone else gets a plain 404. */
export const load: PageServerLoad = async ({ locals }) => {
  if (!isAdminEmail(locals.user?.email)) error(404, 'Not found');
  return adminOverview(await getDb());
};
