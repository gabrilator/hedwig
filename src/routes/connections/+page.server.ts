import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { ctx, plain } from '$lib/server/context';
import { oauthOrigin, SCOPE_LABELS } from '$lib/server/mcpAuth';

/** The MCP screen: the address to add to an assistant, and every connection of this account (they are per account, not per workspace). */
export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals), db = await getDb();
  const grants = await db.collection('oauthGrants').find({ userId: c.user._id.toHexString(), revokedAt: { $exists: false } }, { projection: { clientName: 1, scope: 1, space: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(100).toArray();
  const name = (key: string) => c.spaces.find((s) => s.key === key)?.name ?? 'Personal';
  let endpoint: string | null = null, endpointProblem: string | null = null;
  try { endpoint = `${oauthOrigin(url.origin)}/mcp`; } catch (e) { endpointProblem = (e as Error).message; }
  return {
    endpoint, endpointProblem, scopeLabels: SCOPE_LABELS, workspaces: c.spaces.map((s) => s.name),
    connections: plain(grants.map((g) => ({ id: g._id, clientName: g.clientName ?? 'MCP connection', workspace: name(g.space), scope: g.scope ?? [], createdAt: g.createdAt })))
  };
};
export const actions: Actions = {
  revoke: async ({ request, locals }) => {
    const c = ctx(locals), db = await getDb(), id = String((await request.formData()).get('id') ?? '');
    const result = await db.collection('oauthGrants').updateOne({ _id: id as any, userId: c.user._id.toHexString(), revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (!result.matchedCount) return fail(404, { error: 'Connection not found.' });
    return { revoked: true };
  }
};
