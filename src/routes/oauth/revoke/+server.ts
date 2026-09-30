import { boundedBody } from '$lib/server/httpBody';
import { getDb } from '$lib/server/db';
import { sha256 } from '$lib/server/crypto';
import { oauthError, oauthHeaders, rateLimit } from '$lib/server/mcpAuth';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  try {
    const db = await getDb(); await rateLimit(db, `revoke:${getClientAddress()}`, 60);
    const body = new URLSearchParams((await boundedBody(request, 16000)).slice(0, 16000)), token = body.get('token');
    if (token) {
      const hash = sha256(token);
      const stored = await db.collection('oauthTokens').findOne({ $or: [{ _id: hash as any }, { refreshTokenHash: hash }] });
      if (stored) await db.collection('oauthGrants').updateOne({ _id: stored.user.grantId }, { $set: { revokedAt: new Date() } });
    }
    return new Response(null, { status: 200, headers: oauthHeaders });
  } catch (e) { return oauthError(e); }
};
export { OPTIONS } from '../token/+server';
