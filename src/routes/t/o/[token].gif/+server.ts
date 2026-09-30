import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { GIF, recordOpen } from '$lib/server/tracking';

export const GET: RequestHandler = async ({ params, request, getClientAddress }) => {
  try {
    const db = await getDb();
    let ip = ''; try { ip = getClientAddress(); } catch { /* not available */ }
    await recordOpen(db, params.token, { ua: request.headers.get('user-agent') ?? undefined, ip });
  } catch (e) { console.error('[pixel]', e); }
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', pragma: 'no-cache', expires: '0', 'content-length': String(GIF.length) } });
};
