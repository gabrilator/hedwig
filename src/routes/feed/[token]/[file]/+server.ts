import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { serveFeed } from '$lib/server/feed';

/** /feed/<token>/leads.csv and /feed/<token>/daily.csv: no session, the token is the key (src/lib/server/feed.ts). */
export const GET: RequestHandler = async ({ params, request, getClientAddress }) => {
  let ip = 'unknown'; try { ip = getClientAddress(); } catch { /* not available */ }
  return serveFeed(await getDb(), { token: params.token, file: params.file, ip, accept: request.headers.get('accept') });
};
