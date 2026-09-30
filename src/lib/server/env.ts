/** Reads process.env lazily so the same code serves the SvelteKit server, the worker and tests. */
export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable ${name}`);
  }
  return v;
}
export function envOpt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}
export const isProd = () => process.env.NODE_ENV === 'production';
/** Cookies are marked Secure exactly when the site is served over https; a plain-http origin would otherwise never get them back. */
export const secureCookies = () => env('ORIGIN', '').startsWith('https://');
/** The key that seals mailbox passwords and refresh tokens: 32 bytes, base64. Read lazily, so the app boots without it and only mailbox work fails. */
export const masterKeyProblem = (): string | null => {
  const raw = envOpt('HEDWIG_MASTER_KEY');
  if (!raw) return 'HEDWIG_MASTER_KEY is not set. Mailboxes cannot be connected until it is.';
  if (Buffer.from(raw, 'base64').length !== 32) return 'HEDWIG_MASTER_KEY is not 32 bytes in base64. Generate a new one and restart.';
  return null;
};
export const microsoftConfigured = () => !!(envOpt('MS_CLIENT_ID') && envOpt('MS_CLIENT_SECRET'));
export const resendConfigured = () => !!envOpt('RESEND_API_KEY');
export const trackingBase = () => (envOpt('TRACKING_BASE_URL') ?? env('ORIGIN')).replace(/\/$/, '');
export const geminiConfigured = () => !!envOpt('GEMINI_API_KEY');
/** Jev (TypeSafe) labels replies when its key is set; Gemini then only writes drafts. */
export const jevConfigured = () => !!envOpt('TYPESAFE_API_KEY');
/** Something can label replies: Jev, or else the agent's Gemini model. */
export const classifierConfigured = () => jevConfigured() || geminiConfigured();
/** Hard ceiling on model calls (Jev and Gemini together) per UTC day for the whole instance; the agent stops asking above it. */
export const geminiDailyCap = () => Math.max(1, Number(envOpt('GEMINI_DAILY_CAP') ?? 300) || 300);
/** Hostname of ORIGIN (no port), or null when ORIGIN is unset or not a URL. */
export const originHost = (): string | null => { try { return new URL(env('ORIGIN')).hostname.toLowerCase(); } catch { return null; } };
