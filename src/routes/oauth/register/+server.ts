import { boundedBody } from '$lib/server/httpBody';
import { getDb } from '$lib/server/db';
import { oauthError, oauthHeaders, rateLimit, registerClient } from '$lib/server/mcpAuth';
import { OperationError } from '$lib/server/operations';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  try {
    const db = await getDb(); await rateLimit(db, `register:${getClientAddress()}`, 10, 3600); await rateLimit(db, 'register:global', 100, 3600);
    const text = await boundedBody(request, 16000);
    if (text.length > 16000) throw new OperationError('invalid_request', 'Request too large.');
    return Response.json(await registerClient(db, JSON.parse(text)), { status: 201, headers: oauthHeaders });
  } catch (e) { return oauthError(e); }
};
export { OPTIONS } from '../token/+server';
