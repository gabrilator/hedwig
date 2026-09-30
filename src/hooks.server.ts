import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { env as dyn } from '$env/dynamic/private';
import { cols, ensureIndexes, getDb } from '$lib/server/db';
import { SESSION_COOKIE, SPACE_COOKIE, bootstrap, userForToken } from '$lib/server/auth';
import { pickSpace, spacesFor } from '$lib/server/scope';
import { canonicalRedirect, csrfBlocked } from '$lib/server/host';
import { envOpt } from '$lib/server/env';

// SvelteKit exposes .env through $env/dynamic/private; the shared server code reads process.env, so mirror it once.
for (const [k, v] of Object.entries(dyn)) if (v !== undefined && process.env[k] === undefined) process.env[k] = v;

let booted: Promise<void> | null = null;
async function boot() {
  const db = await getDb();
  await ensureIndexes(db);
  await bootstrap(db);
}

const PUBLIC = [/^\/$/, /^\/mcp$/, /^\/oauth\/(token|register|revoke)$/, /^\/\.well-known\/oauth-(authorization-server|protected-resource)(\/mcp)?$/, /^\/login$/, /^\/signup$/, /^\/t\//, /^\/u\//, /^\/health$/, /^\/favicon\.svg$/];

export const handle: Handle = async ({ event, resolve }) => {
  // One canonical host: forms only work where Origin equals ORIGIN, so every other host of ours sends people there.
  const to = canonicalRedirect(event.request.headers.get('x-forwarded-host') ?? event.request.headers.get('host'), event.url.pathname, event.url.search, envOpt('ORIGIN'));
  if (to) redirect(308, to);
  // Forms must come from this origin (SvelteKit's own rule, moved here so the unsubscribe page can accept one-click posts).
  const machineEndpoint = /^\/oauth\/(token|register|revoke)$/.test(event.url.pathname);
  if (!machineEndpoint && csrfBlocked(event.request.method, event.request.headers.get('content-type'), event.request.headers.get('origin'), event.url.pathname, event.url.origin)) {
    return new Response(`Cross-site ${event.request.method} form submissions are forbidden`, { status: 403 });
  }
  booted ??= boot().catch((e) => { booted = null; throw e; });
  await booted;
  const db = await getDb();
  const user = await userForToken(db, event.cookies.get(SESSION_COOKIE));
  event.locals.user = user;
  if (user) {
    const orgs = await cols(db).orgs.find({ 'members.userId': user._id }).toArray();
    event.locals.spaces = spacesFor(user, orgs);
    event.locals.space = pickSpace(event.locals.spaces, event.cookies.get(SPACE_COOKIE));
  } else {
    event.locals.spaces = [];
    event.locals.space = null;
  }
  const p = event.url.pathname;
  const isPublic = PUBLIC.some((re) => re.test(p));
  if (!user && !isPublic) redirect(303, `/login?next=${encodeURIComponent(p + event.url.search)}`);
  if (user && (p === '/login' || p === '/signup')) redirect(303, '/campaigns');
  return resolve(event);
};
