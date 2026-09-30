import { boundedBody } from '$lib/server/httpBody';
import OAuth2Server from '@node-oauth/oauth2-server';
import { getDb } from '$lib/server/db';
import { oauthError, oauthHeaders, oauthOrigin, oauthServer, rateLimit } from '$lib/server/mcpAuth';
import { OperationError } from '$lib/server/operations';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
  try {
    const db = await getDb(), origin = oauthOrigin(url.origin);
    await rateLimit(db, `token:${getClientAddress()}`, 60);
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new OperationError('invalid_request', 'Use form encoding.');
    const text = await boundedBody(request, 16000);
    if (text.length > 16000) throw new OperationError('invalid_request', 'Request too large.');
    const params = new URLSearchParams(text);
    for (const key of new Set(params.keys())) if (params.getAll(key).length > 1) throw new OperationError('invalid_request', 'Duplicate parameter.');
    const body = Object.fromEntries(params);
    if (!['authorization_code', 'refresh_token'].includes(body.grant_type)) throw new OperationError('unsupported_grant_type', 'Only authorization code and refresh token grants are supported.');
    if (body.resource && body.resource !== `${origin}/mcp`) throw new OperationError('invalid_target', 'Wrong resource.');
    const response = new OAuth2Server.Response();
    await oauthServer(db, origin).token(new OAuth2Server.Request({ headers: Object.fromEntries(request.headers), method: 'POST', query: {}, body }), response);
    return Response.json(response.body, { status: response.status, headers: { ...response.headers, ...oauthHeaders } });
  } catch (e) { return oauthError(e); }
};
export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: { ...oauthHeaders, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' } });
