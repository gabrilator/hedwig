export const pct = (n: number, d: number, digits = 1): string => (d ? `${(Math.round((n / d) * 1000 * Math.pow(10, digits - 1)) / (10 * Math.pow(10, digits - 1))).toFixed(digits)}%` : '—');
export const pctInt = (n: number, d: number): string => (d ? `${Math.round((n / d) * 100)}%` : '—');
export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
export function fmtDT(iso: string | Date | null | undefined, tz?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
}
export function fmtTime(iso: string | Date | null | undefined, tz?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
}
export function fmtDay(iso: string | Date | null | undefined, tz?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz });
}
export const n = (x: number | undefined | null): string => (x ?? 0).toLocaleString('en-GB');
export const labelStatus = (s: string) => s.replace(/_/g, ' ');

export const AI_LABEL_TEXT: Record<string, string> = {
  interested: 'Interested', meeting: 'Meeting', question: 'Question', not_interested: 'Not interested',
  out_of_office: 'Out of office', bounce: 'Bounce', unsubscribe: 'Unsubscribe', other: 'Other'
};
export const labelAi = (l: string | null | undefined): string => (l ? AI_LABEL_TEXT[l] ?? l.replace(/_/g, ' ') : '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text → paragraphs for the editor (client side). */
export const textToParagraphs = (text: string): string => esc(text ?? '').split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
