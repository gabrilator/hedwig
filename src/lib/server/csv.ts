import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { cols } from './db';
import { camelKey, firstNameFrom, isEmail } from './render';
import { SENDABLE } from './campaigns';
import { enqueue } from './jobs';
import type { CampaignDoc, LeadDoc } from './types';

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; errors: string[] } {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true, skipEmptyLines: 'greedy', transformHeader: (h: string) => h.trim()
  });
  const headers = (res.meta.fields ?? []).filter((h) => h !== '');
  const rows = res.data.map((r) => { const o: Record<string, string> = {}; for (const h of headers) o[h] = String(r[h] ?? '').trim(); return o; });
  return { headers, rows, errors: res.errors.slice(0, 5).map((e) => `${e.type}: ${e.message} (row ${e.row})`) };
}

/** .xlsx / .xls → same shape as parseCsv, first sheet, first row = headers. */
export function parseExcel(buf: Buffer): { headers: string[]; rows: Record<string, string>[]; errors: string[] } {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const name = wb.SheetNames[0];
  if (!name) return { headers: [], rows: [], errors: ['The workbook has no sheets.'] };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false });
  if (!grid.length) return { headers: [], rows: [], errors: ['The first sheet is empty.'] };
  const headers = (grid[0] as unknown[]).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  const rows = grid.slice(1).map((r) => { const o: Record<string, string> = {}; headers.forEach((h, i) => { o[h] = String((r as unknown[])[i] ?? '').trim(); }); return o; })
    .filter((o) => Object.values(o).some((v) => v !== ''));
  return { headers, rows, errors: [] };
}
export function parseSheet(fileName: string, buf: Buffer) {
  return /\.xlsx?$/i.test(fileName) ? parseExcel(buf) : parseCsv(buf.toString('utf8'));
}

/** Best guess for the address column: a header that says email/correo and actually holds addresses, else the column with the most of them. The user confirms it on the import screen. */
export function detectEmailColumn(headers: string[], rows: Record<string, string>[]): string | null {
  const score = new Map(headers.map((h) => [h, rows.reduce((n, r) => n + (isEmail(r[h] ?? '') ? 1 : 0), 0)]));
  const named = headers.filter((h) => /e-?mail|correo/i.test(h)).sort((a, b) => score.get(b)! - score.get(a)!)[0];
  if (named && score.get(named)! > 0) return named;
  let best: string | null = null;
  for (const h of headers) if (score.get(h)! > 0 && (best === null || score.get(h)! > score.get(best)!)) best = h;
  return best;
}

export interface ColumnStat { filled: number; emails: number; unique: number; alreadyIn: number; suppressed: number; willImport: number }

/**
 * What each column would yield if it were the email column: only rows with a valid address survive, once per address,
 * minus the ones already in the campaign or on the suppression list. Same order of checks as buildLeadDocs, so the
 * number shown before the import is the number of leads after it.
 */
export function columnStats(headers: string[], rows: Record<string, string>[], existing: Set<string>, suppressed: Set<string>): Record<string, ColumnStat> {
  const out: Record<string, ColumnStat> = {};
  for (const h of headers) {
    const st: ColumnStat = { filled: 0, emails: 0, unique: 0, alreadyIn: 0, suppressed: 0, willImport: 0 };
    const seen = new Set<string>();
    for (const r of rows) {
      const v = (r[h] ?? '').trim();
      if (!v) continue;
      st.filled++;
      if (!isEmail(v)) continue;
      st.emails++;
      const email = v.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      st.unique++;
      if (suppressed.has(email)) st.suppressed++;
      else if (existing.has(email)) st.alreadyIn++;
      else st.willImport++;
    }
    out[h] = st;
  }
  return out;
}

export interface ImportStats { total: number; inserted: number; duplicatesInFile: number; alreadyInCampaign: number; invalid: number; suppressed: number; activeElsewhere?: number; previousOutreach?: number }

export interface ColumnMap { emailColumn: string; columns: { header: string; variable: string }[] }
export const defaultColumnMap = (headers: string[], emailColumn: string): ColumnMap => ({ emailColumn, columns: headers.filter((h) => h !== emailColumn).map((h) => ({ header: h, variable: camelKey(h) })) });

export function buildLeadDocs(campaign: CampaignDoc, rows: Record<string, string>[], map: ColumnMap, suppressed: Set<string>) {
  const seen = new Set<string>();
  const docs: LeadDoc[] = [];
  const stats: ImportStats = { total: rows.length, inserted: 0, duplicatesInFile: 0, alreadyInCampaign: 0, invalid: 0, suppressed: 0 };
  const cols = map.columns.filter((c) => c.header !== map.emailColumn && c.variable.trim()).map((c) => ({ header: c.header, variable: camelKey(c.variable) || camelKey(c.header) }));
  for (const r of rows) {
    const email = (r[map.emailColumn] ?? '').trim().toLowerCase();
    if (!isEmail(email)) { stats.invalid++; continue; }
    if (seen.has(email)) { stats.duplicatesInFile++; continue; }
    seen.add(email);
    if (suppressed.has(email)) { stats.suppressed++; continue; }
    const vars: Record<string, string> = {};
    for (const c of cols) { const v = (r[c.header] ?? '').trim(); if (v) vars[c.variable] = v; }
    vars.email = email;
    if (!vars.firstName) {
      const nameSource = vars.contactPerson ?? vars.name ?? vars.contact ?? vars.fullName ?? vars.nombre ?? vars.persona;
      const fn = firstNameFrom(nameSource);
      if (fn) vars.firstName = fn;
    }
    docs.push({
      _id: new ObjectId(), campaignId: campaign._id, space: campaign.space, email, domain: email.split('@')[1],
      vars, provider: 'unknown', currentStep: 0, nextDueAt: null, status: 'queued', createdAt: new Date()
    });
  }
  return { docs, stats };
}

export async function importLeads(db: Db, campaign: CampaignDoc, rows: Record<string, string>[], map: ColumnMap): Promise<ImportStats> {
  const c = cols(db);
  const suppressedDocs = await c.suppressions.find({ space: campaign.space }, { projection: { email: 1 } }).toArray();
  const suppressed = new Set(suppressedDocs.map((s) => s.email));
  const { docs: candidates, stats } = buildLeadDocs(campaign, rows, map, suppressed);
  const activeIds = await c.campaigns.distinct('_id', { space: campaign.space, status: 'active', _id: { $ne: campaign._id } });
  const emails = candidates.map(l => l.email);
  const previous = new Set(await c.leads.distinct('email', { space: campaign.space, campaignId: { $ne: campaign._id }, email: { $in: emails }, currentStep: { $gt: 0 } }));
  const elsewhere = new Set(activeIds.length ? await c.leads.distinct('email', { campaignId: { $in: activeIds }, email: { $in: emails }, status: { $in: SENDABLE } }) : []);
  stats.activeElsewhere = candidates.filter(l => elsewhere.has(l.email)).length;
  stats.previousOutreach = candidates.filter(l => !elsewhere.has(l.email) && previous.has(l.email)).length;
  const docs = candidates.filter(l => !elsewhere.has(l.email) && !previous.has(l.email));
  if (docs.length) {
    try {
      const r = await c.leads.insertMany(docs, { ordered: false });
      stats.inserted = r.insertedCount;
    } catch (e: any) {
      // duplicate key errors → already in campaign; everything else was inserted
      stats.inserted = e?.result?.insertedCount ?? e?.insertedCount ?? 0;
      const writeErrors = e?.writeErrors ?? e?.result?.writeErrors ?? [];
      const dupes = writeErrors.filter((w: any) => w.code === 11000).length;
      stats.alreadyInCampaign = dupes;
      if (writeErrors.length !== dupes) throw e;
    }
  }
  await enqueue(db, 'enrich-leads', { campaignId: campaign._id.toHexString() });
  return stats;
}
