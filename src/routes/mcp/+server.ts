import { boundedBody } from '$lib/server/httpBody';
import { getDb } from '$lib/server/db';
import { authenticateMcp, oauthOrigin, rateLimit } from '$lib/server/mcpAuth';
import { handleMcp } from '$lib/server/mcp';
import type { RequestHandler } from './$types';
const handler: RequestHandler = async ({ request, url }) => {
  const origin = oauthOrigin(url.origin), db = await getDb();
  const suppliedOrigin = request.headers.get('origin');
  if (suppliedOrigin && suppliedOrigin !== origin) return new Response('Untrusted request origin', { status: 403 });
  const actor = await authenticateMcp(db, request, origin);
  if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`, 'cache-control': 'no-store' } });
  try { await rateLimit(db, `mcp:${actor.connectionId}`, 120); } catch { return new Response('Rate limit exceeded', { status: 429, headers: { 'retry-after': '60' } }); }
  if (Number(request.headers.get('content-length')) > 1024 * 1024) return new Response('Request too large', { status: 413 });
  let body: string | undefined;
  try { if (request.method === 'POST') body = await boundedBody(request, 1024 * 1024); } catch { return new Response('Request too large', { status: 413 }); }
  const response = await handleMcp(db, actor, new Request(request.url, { method: request.method, headers: request.headers, ...(body !== undefined ? { body } : {}) }));
  response.headers.set('cache-control', 'no-store'); return response;
};
export const POST = handler;
export const GET = handler;
export const DELETE = handler;
