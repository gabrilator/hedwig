import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { recordUnsubscribe } from '$lib/server/tracking';

/** RFC 8058 one-click: mail clients POST List-Unsubscribe=One-Click here. */
export const POST: RequestHandler = async ({ params, request }) => {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const body = await request.text();
    if (body.includes('List-Unsubscribe=One-Click')) {
      await recordUnsubscribe(await getDb(), params.token);
      return new Response('ok', { status: 200 });
    }
  }
  return new Response('use the page', { status: 400 });
};
