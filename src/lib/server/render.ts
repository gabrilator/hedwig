/** {{name}} and {{name|fallback}} rendering, plain text → light HTML, header → variable names. */

const VAR_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function normalizeKey(k: string): string {
  return k.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function renderTemplate(tpl: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) lookup.set(normalizeKey(k), v ?? '');
  const missing: string[] = [];
  const text = (tpl ?? '').replace(VAR_RE, (_m, name: string, fallback?: string) => {
    const v = lookup.get(normalizeKey(name));
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return '';
  });
  return { text, missing };
}

export function variablesIn(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of (tpl ?? '').matchAll(VAR_RE)) out.add(m[1]);
  return [...out];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text → HTML: escaped, URLs linked, paragraphs kept. */
export function textToHtml(text: string): string {
  const esc = escapeHtml(text);
  const linked = esc.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, '<a href="$1">$1</a>');
  const paras = linked.split(/\n{2,}/).map((p) => `<p style="margin:0 0 1em">${p.replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${paras.join('')}</div>`;
}

/** "Contact Person" → contactPerson · "Postal_City" → postalCity · "EMAIL" → email */
export function camelKey(header: string): string {
  const parts = header.trim().replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'column';
  const isAllCaps = (s: string) => s === s.toUpperCase();
  return parts
    .map((p, i) => {
      const w = isAllCaps(p) ? p.toLowerCase() : p;
      return i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

export function firstNameFrom(fullName: string | undefined): string {
  if (!fullName) return '';
  const cleaned = fullName.replace(/^(sr\.?|sra\.?|d\.|dña\.?|mr\.?|mrs\.?|ms\.?|dr\.?)\s+/i, '').trim();
  return cleaned.split(/\s+/)[0] ?? '';
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

export const looksLikeHtml = (s: string): boolean => /<\s*(p|div|br|b|strong|i|em|u|a|ul|ol|li|span|blockquote)\b[^>]*>/i.test(s ?? '');

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
/** Email-safe plain text from editor HTML: paragraphs become blank lines, links keep their URL, lists get bullets. */
export function htmlToText(html: string): string {
  let s = html ?? '';
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const t = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    return t && t !== href ? `${t} (${href})` : href;
  });
  s = s.replace(/<li\b[^>]*>/gi, '• ').replace(/<\/li>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|blockquote|ul|ol|h[1-6])>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** Plain text → paragraphs of HTML for the editor (no wrapper). */
export function textToEditorHtml(text: string): string {
  const esc = escapeHtml(text ?? '');
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
export function wrapEmailHtml(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${inner}</div>`;
}
