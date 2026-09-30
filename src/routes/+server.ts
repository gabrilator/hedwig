import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import landing from '$lib/landing/landing.html?raw';
import { envOpt, landingPage } from '$lib/server/env';

/** Signed in: the campaigns. Signed out: the public home page when HEDWIG_LANDING is on, else the login. */
export const GET: RequestHandler = ({ locals }) => {
  if (locals.user) redirect(303, '/campaigns');
  if (!landingPage()) redirect(303, '/login');
  const origin = (envOpt('ORIGIN') ?? '').replace(/\/$/, '');
  let host = origin;
  try { host = new URL(origin).host; } catch { /* ORIGIN unset or not a URL: show it as it is */ }
  const html = landing.replaceAll('%ORIGIN%', origin).replaceAll('%HOST%', host);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
};
