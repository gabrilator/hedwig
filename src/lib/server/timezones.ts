/**
 * Timezones the scheduler can work in. The planner reads a campaign's window through luxon, which uses the same
 * Intl data as this file, so a zone accepted here is a zone the worker can schedule in.
 */
import { DateTime } from 'luxon';

const FALLBACK = ['Europe/Lisbon', 'Europe/Madrid', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/Toronto', 'America/New_York', 'America/Los_Angeles', 'America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney'];

let cached: string[] | null = null;

/** Every IANA zone this runtime knows, plus UTC (Node's list leaves it out). */
export function timezones(): string[] {
  if (cached) return cached;
  let zones: string[] = FALLBACK;
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* old runtime: keep the fallback */ }
  cached = [...new Set([...zones, 'UTC'])].sort();
  return cached;
}

/** Accepts aliases too (Europe/Kyiv, Etc/UTC): if Intl resolves it, luxon resolves it, and the planner runs. */
export function isTimezone(tz: string): boolean {
  if (!tz || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** "UTC+2", "UTC−3:30", "UTC" — the offset a zone has right now, in minutes from UTC. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60), m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

export interface TzOption { zone: string; offset: string; offsetMin: number; fixed?: boolean }

/** Fixed offsets, for people who think in UTC+1 / UTC+2 rather than in cities. Etc/GMT signs are inverted on purpose by IANA. */
export function fixedOffsets(): TzOption[] {
  const out: TzOption[] = [];
  for (let h = -12; h <= 14; h++) {
    const zone = h === 0 ? 'UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
    out.push({ zone, offset: formatOffset(h * 60), offsetMin: h * 60, fixed: true });
  }
  return out;
}

let optionsCache: { at: number; list: TzOption[] } | null = null;

/** Every zone with its offset right now (offsets move with summer time, so this is recomputed every 15 minutes). */
export function timezoneOptions(now: Date = new Date()): TzOption[] {
  if (optionsCache && Math.abs(now.getTime() - optionsCache.at) < 15 * 60_000) return optionsCache.list;
  const list: TzOption[] = [];
  for (const zone of timezones()) {
    if (zone === 'UTC') continue; // listed once, among the fixed offsets
    const d = DateTime.fromJSDate(now, { zone });
    if (!d.isValid) continue;
    list.push({ zone, offset: formatOffset(d.offset), offsetMin: d.offset });
  }
  const all = [...fixedOffsets(), ...list];
  optionsCache = { at: now.getTime(), list: all };
  return all;
}
