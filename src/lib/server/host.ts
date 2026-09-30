/**
 * Hedwig may answer on several hosts (the app domain, the tracking domain, a platform-provided preview address), but SvelteKit only
 * accepts form posts whose Origin matches ORIGIN. A page opened on any other host shows "Cross-site POST form submissions
 * are forbidden" on its first form. So: anything that is not tracking or health, requested on a host that is not ORIGIN's,
 * is redirected to the same path on ORIGIN. Local runs (localhost, 127.0.0.1) are left alone.
 */
const KEEP = [/^\/t\//, /^\/u\//, /^\/health$/];

/** The URL to redirect to, or null when the request is already on the right host (or must stay where it is). */
export function canonicalRedirect(hostHeader: string | null | undefined, path: string, search: string, origin: string | null | undefined): string | null {
  if (!origin || !hostHeader) return null;
  let originHost: string;
  try { originHost = new URL(origin).hostname.toLowerCase(); } catch { return null; }
  let host = hostHeader.split(',')[0].trim().toLowerCase();
  const v6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  host = v6 ? v6[1] : host.replace(/:\d+$/, '');
  if (!host || host === originHost) return null;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
  if (KEEP.some((re) => re.test(path))) return null;
  return `${origin.replace(/\/$/, '')}${path}${search}`;
}

const FORM_CT = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;
const UNSUB = /^\/u\//;

/**
 * SvelteKit's own form-origin check, with one exception it cannot express: the unsubscribe page. Mail clients POST the
 * RFC 8058 one-click there with no Origin header at all, and a person clicking "Yes, unsubscribe" on the tracking host
 * arrives with the tracking host as Origin. The token in the URL is the secret there, so those posts are let through.
 * Everything else must come from `expectedOrigin` (ORIGIN in production, the request's own origin in dev).
 */
export function csrfBlocked(method: string, contentType: string | null | undefined, requestOrigin: string | null | undefined, path: string, expectedOrigin: string): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return false;
  if (!FORM_CT.test((contentType ?? '').trim())) return false;
  if (UNSUB.test(path)) return false;
  return (requestOrigin ?? null) !== expectedOrigin;
}
