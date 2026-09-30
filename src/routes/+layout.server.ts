import type { LayoutServerLoad } from './$types';
import { userJson } from '$lib/server/context';
import { cols, getDb } from '$lib/server/db';

export const load: LayoutServerLoad = async ({ locals }) => ({
  user: locals.user ? userJson(locals.user) : null,
  space: locals.space ? { ...locals.space, orgId: locals.space.orgId?.toHexString() } : null,
  spaces: locals.spaces.map((s) => ({ ...s, orgId: s.orgId?.toHexString() })),
  inboxUnread: locals.space ? await cols(await getDb()).leads.countDocuments({ space: locals.space.key, inboundUnread: true }) : 0
});
