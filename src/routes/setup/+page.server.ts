import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { ctx, plain } from '$lib/server/context';
import { oauthOrigin, SCOPE_LABELS } from '$lib/server/mcpAuth';
import type { Actions, PageServerLoad } from './$types';
import { envOpt, masterKeyProblem } from '$lib/server/env';
import { normalizeEmail } from '$lib/server/auth';
import { workerStatus } from '$lib/server/jobs';
import { llmUsage } from '$lib/server/agent';
import { createFeedToken, feedTokenInfo, revokeFeedToken } from '$lib/server/feed';
export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals), db = await getDb();
  // the worker's health is for whoever runs the server: the first user, the one named in BOOTSTRAP_USER_EMAIL
  const runsServer = c.user.email === normalizeEmail(envOpt('BOOTSTRAP_USER_EMAIL') ?? '');
  const status = runsServer ? await workerStatus(db) : null;
  const feedBase = `${new URL(envOpt('ORIGIN') || url.origin).origin}/feed`;
  return { masterKeyProblem: masterKeyProblem(), llm: plain(await llmUsage(db)), worker: status ? { stale: status.stale, ageSec: status.ageSec } : null, endpoint: `${oauthOrigin(url.origin)}/mcp`, scopeLabels: SCOPE_LABELS, connections: plain(await db.collection('oauthGrants').find({ userId: c.user._id.toHexString(), revokedAt: { $exists: false } }).sort({ createdAt: -1 }).toArray()), feed: plain(await feedTokenInfo(db, c.space.key)), feedBase };
};
export const actions: Actions = {
  revoke: async ({ request, locals }) => {
    const c = ctx(locals), db = await getDb(), id = String((await request.formData()).get('id'));
    const result = await db.collection('oauthGrants').updateOne({ _id: id as any, userId: c.user._id.toHexString() }, { $set: { revokedAt: new Date() } });
    if (!result.matchedCount) return fail(404, { error: 'Connection not found.' });
    return { revoked: true };
  },
  /** A new results feed link for the current workspace; any old one stops working. The token is in this answer only. */
  createFeed: async ({ locals }) => {
    const c = ctx(locals), db = await getDb();
    return { feedToken: await createFeedToken(db, c.space.key, c.user._id) };
  },
  revokeFeed: async ({ locals }) => {
    const c = ctx(locals), db = await getDb();
    if (!await revokeFeedToken(db, c.space.key)) return fail(404, { feedError: 'This workspace has no feed link.' });
    return { feedOff: true };
  }
};
