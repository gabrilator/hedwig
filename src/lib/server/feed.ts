/**
 * The results feed: a workspace's campaign results as two CSV files that a spreadsheet (=IMPORTDATA) or another app reads
 * without signing in. The secret is the token in the link. Only its SHA-256 is stored, like sessions and MCP tokens, so the
 * link is shown once, when it is made. One link per workspace: making a new one replaces the old in the same write. It
 * works while the person who made it is still in the workspace.
 * Read-only. No credentials, no message text or subjects. Every read is bounded and indexed (law 5) and filtered by the
 * token's workspace (law 6).
 */
import type { Db, ObjectId } from 'mongodb';
import Papa from 'papaparse';
import { cols } from './db';
import { randomToken, sha256 } from './crypto';
import { rateLimit } from './mcpAuth';
import { OperationError } from './operations';
import { spacesFor } from './scope';
import { dayKey } from './stats';
import type { LeadDoc, SpaceKey } from './types';

/** randomToken(32) is 43 characters of base64url. Anything else is not ours and never reaches the database. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const FEED_DAYS = 180;
export const FEED_MAX_LEADS = 50_000;
const MAX_CAMPAIGNS = 1_000;
const BATCH = 500;

export const LEAD_COLUMNS = ['campaign', 'email', 'lead_id', 'branch', 'segment', 'status', 'agent_label', 'first_sent_at', 'last_sent_at', 'steps_sent', 'opens', 'replied_at', 'curious'];
export const DAILY_COLUMNS = ['date', 'campaign', 'sent', 'opens', 'replies', 'interested', 'meetings', 'bounces'];

/** A new link for the workspace. The old one, if any, stops working with the same write. The token appears here and nowhere else. */
export async function createFeedToken(db: Db, space: SpaceKey, userId: ObjectId, now = new Date()): Promise<string> {
  const token = randomToken(32);
  await cols(db).feedTokens.updateOne({ space }, { $set: { tokenHash: sha256(token), createdBy: userId, createdAt: now }, $unset: { lastUsedAt: '' } }, { upsert: true });
  return token;
}
export async function revokeFeedToken(db: Db, space: SpaceKey): Promise<boolean> {
  return (await cols(db).feedTokens.deleteOne({ space })).deletedCount === 1;
}
/** For Setup: whether the workspace has a link, who made it, when it was last read. Never the token. */
export async function feedTokenInfo(db: Db, space: SpaceKey) {
  const c = cols(db);
  const doc = await c.feedTokens.findOne({ space }, { projection: { tokenHash: 0 } });
  if (!doc) return null;
  const by = await c.users.findOne({ _id: doc.createdBy }, { projection: { name: 1, email: 1 } });
  return { createdAt: doc.createdAt, lastUsedAt: doc.lastUsedAt ?? null, createdBy: by?.name || by?.email || '' };
}

/** The workspace a token opens, or null: malformed, unknown, replaced, turned off, or its maker has left the workspace. */
export async function feedSpace(db: Db, token: string, now = new Date()): Promise<SpaceKey | null> {
  if (!TOKEN.test(token)) return null;
  const c = cols(db);
  const doc = await c.feedTokens.findOne({ tokenHash: sha256(token) });
  if (!doc) return null;
  const user = await c.users.findOne({ _id: doc.createdBy });
  if (!user || !spacesFor(user, await c.orgs.find({ 'members.userId': user._id }).toArray()).some((s) => s.key === doc.space)) return null;
  // at most one write a minute per link; the hash in the filter keeps a read of a replaced link off the new one
  await c.feedTokens.updateOne(
    { _id: doc._id, tokenHash: doc.tokenHash, $or: [{ lastUsedAt: { $exists: false } }, { lastUsedAt: { $lt: new Date(now.getTime() - 60_000) } }] },
    { $set: { lastUsedAt: now } }
  );
  return doc.space;
}

/** UTC, written so a spreadsheet reads it as a date and time (it leaves ISO's T and Z as text). */
const time = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 19).replace('T', ' ') : '');
/** RFC 4180 with a header row. A cell that starts like a formula (= + - @) gets a leading ' so a spreadsheet keeps it as text. */
export function toCsv(fields: string[], rows: unknown[][]): string {
  const csv = Papa.unparse({ fields, data: rows }, { escapeFormulae: true, newline: '\r\n' });
  return csv.endsWith('\r\n') ? csv : `${csv}\r\n`; // Papa ends a header-only file with a line break, and other files without
}

/*
 * Every read below names its index (hint). Left to choose, the planner took sends' { status, dueAt } for status 'sent',
 * which walks every send ever made, and campaigns' _id for the sort, which walks every workspace's campaigns.
 */
const campaignsOf = (db: Db, space: SpaceKey) =>
  cols(db).campaigns.find({ space }, { projection: { name: 1 }, sort: { _id: -1 }, limit: MAX_CAMPAIGNS, hint: { space: 1, status: 1 } }).toArray();

/** When each lead first replied (a reply, not a bounce or an out-of-office note). Indexed on leadId, in batches. */
async function firstReplies(db: Db, space: SpaceKey, leadIds: ObjectId[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const rows = await cols(db).messages.aggregate<{ _id: ObjectId; at: Date }>([
      { $match: { leadId: { $in: leadIds.slice(i, i + BATCH) }, space, direction: 'in', kind: 'reply' } },
      { $group: { _id: '$leadId', at: { $min: '$at' } } }
    ], { hint: { leadId: 1, at: 1 } }).toArray();
    for (const r of rows) out.set(r._id.toHexString(), r.at);
  }
  return out;
}

const LEAD_FIELDS = { email: 1, 'vars.lead_id': 1, 'vars.leadId': 1, 'vars.branch': 1, 'vars.segment': 1, status: 1, 'ai.label': 1, openCount: 1, curious: 1, lastInboundAt: 1 };

async function leadRows(db: Db, space: SpaceKey, campaign: string, leads: LeadDoc[]): Promise<unknown[][]> {
  const sends = await cols(db).sends.find({ leadId: { $in: leads.map((l) => l._id) }, space, status: 'sent' }, { projection: { leadId: 1, sentAt: 1 }, hint: { leadId: 1, stepIndex: 1 } }).toArray();
  const sent = new Map<string, { first: Date; last: Date; n: number }>();
  for (const s of sends) {
    if (!s.sentAt) continue;
    const k = s.leadId.toHexString(), o = sent.get(k);
    if (!o) sent.set(k, { first: s.sentAt, last: s.sentAt, n: 1 });
    else { o.n++; if (s.sentAt < o.first) o.first = s.sentAt; if (s.sentAt > o.last) o.last = s.sentAt; }
  }
  const replied = await firstReplies(db, space, leads.filter((l) => l.lastInboundAt).map((l) => l._id));
  return leads.map((l) => {
    const k = l._id.toHexString(), s = sent.get(k), v = l.vars ?? {};
    // a research column keeps lead_id as is; a CSV import camel-cases it to leadId
    return [campaign, l.email, v.lead_id ?? v.leadId ?? '', v.branch ?? '', v.segment ?? '', l.status, l.ai?.label ?? '', time(s?.first), time(s?.last), s?.n ?? 0, l.openCount ?? 0, time(replied.get(k)), l.curious === true];
  });
}

/** One row per lead, newest campaign first, then by email. Sends and first replies are read per batch of leads. */
export async function leadsCsv(db: Db, space: SpaceKey): Promise<string> {
  const rows: unknown[][] = [];
  for (const campaign of await campaignsOf(db, space)) {
    if (rows.length >= FEED_MAX_LEADS) break;
    let batch: LeadDoc[] = [];
    const cursor = cols(db).leads.find({ campaignId: campaign._id, space }, { projection: LEAD_FIELDS, sort: { email: 1 }, limit: FEED_MAX_LEADS - rows.length, batchSize: BATCH, hint: { campaignId: 1, email: 1 } });
    for await (const lead of cursor) {
      batch.push(lead);
      if (batch.length === BATCH) { rows.push(...await leadRows(db, space, campaign.name, batch)); batch = []; }
    }
    if (batch.length) rows.push(...await leadRows(db, space, campaign.name, batch));
  }
  return toCsv(LEAD_COLUMNS, rows);
}

/**
 * One row per campaign per UTC day with something to count, last FEED_DAYS days, oldest first. Sent, opens (emails opened,
 * as the screens count them), replies and bounces come from dailyStats. Interested and meetings are not events: they count
 * leads whose status is interested or meeting now, on the day they first replied.
 */
export async function dailyCsv(db: Db, space: SpaceKey, now = new Date()): Promise<string> {
  const c = cols(db);
  const fromDay = dayKey(new Date(now.getTime() - (FEED_DAYS - 1) * 864e5));
  const names = new Map((await campaignsOf(db, space)).map((x) => [x._id.toHexString(), x.name]));
  type Row = { date: string; campaignId: string; sent: number; opens: number; replies: number; interested: number; meetings: number; bounces: number };
  const rows = new Map<string, Row>();
  const row = (campaignId: string, date: string): Row => {
    const k = `${date}|${campaignId}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { date, campaignId, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0, bounces: 0 }));
    return r;
  };
  const stats = await c.dailyStats.aggregate<{ _id: { campaignId: ObjectId; day: string }; sent: number; opens: number; replies: number; bounces: number }>([
    { $match: { space, day: { $gte: fromDay } } },
    { $group: { _id: { campaignId: '$campaignId', day: '$day' }, sent: { $sum: '$sent' }, opens: { $sum: '$uniqueOpens' }, replies: { $sum: '$replies' }, bounces: { $sum: '$bounces' } } }
  ], { hint: { space: 1, day: 1 } }).toArray();
  for (const s of stats) Object.assign(row(s._id.campaignId.toHexString(), s._id.day), { sent: s.sent, opens: s.opens, replies: s.replies, bounces: s.bounces });
  // a first reply inside the window means a latest inbound inside it too, so lastInboundAt narrows the leads to read
  const positive = await c.leads.find(
    { space, lastInboundAt: { $gte: new Date(`${fromDay}T00:00:00.000Z`) }, status: { $in: ['interested', 'meeting'] } },
    { projection: { campaignId: 1, status: 1 }, limit: FEED_MAX_LEADS, hint: { space: 1, lastInboundAt: -1 } }
  ).toArray();
  const replied = await firstReplies(db, space, positive.map((l) => l._id));
  for (const l of positive) {
    const at = replied.get(l._id.toHexString());
    if (!at || dayKey(at) < fromDay) continue;
    row(l.campaignId.toHexString(), dayKey(at))[l.status === 'meeting' ? 'meetings' : 'interested']++;
  }
  const out = [...rows.values()]
    .filter((r) => names.has(r.campaignId) && (r.sent || r.opens || r.replies || r.interested || r.meetings || r.bounces))
    .sort((a, b) => a.date.localeCompare(b.date) || names.get(a.campaignId)!.localeCompare(names.get(b.campaignId)!));
  return toCsv(DAILY_COLUMNS, out.map((r) => [r.date, names.get(r.campaignId), r.sent, r.opens, r.replies, r.interested, r.meetings, r.bounces]));
}

const HEADERS = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
const plainText = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra } });

async function underLimit(db: Db, bucket: string, maximum: number): Promise<boolean> {
  try { await rateLimit(db, bucket, maximum); return true; }
  catch (e) { if (e instanceof OperationError && e.code === 'rate_limited') return false; throw e; }
}

/** A browser tab gets text/plain, so it shows the file instead of saving it; a spreadsheet or an app gets text/csv. Same bytes. */
const csvType = (accept: string | null | undefined) => (/\btext\/html\b/i.test(accept ?? '') ? 'text/plain' : 'text/csv');

/** GET /feed/<token>/<file>: a limit per address, the token, a limit per link, then the file. Every bad link is the same 404. */
export async function serveFeed(db: Db, req: { token: string; file: string; ip: string; accept?: string | null }, now = new Date()): Promise<Response> {
  const { token, file } = req;
  if (file !== 'leads.csv' && file !== 'daily.csv') return plainText(404, 'Not found');
  const slowDown = () => plainText(429, 'Too many requests. Try again in a minute.', { 'retry-after': '60' });
  if (!await underLimit(db, `feed:${req.ip}`, 120)) return slowDown();
  const space = await feedSpace(db, token, now);
  if (!space) return plainText(404, 'Not found');
  if (!await underLimit(db, `feed:${sha256(token)}`, 30)) return slowDown();
  const csv = file === 'leads.csv' ? await leadsCsv(db, space) : await dailyCsv(db, space, now);
  return new Response(csv, { headers: { ...HEADERS, 'content-type': `${csvType(req.accept)}; charset=utf-8`, 'content-disposition': `inline; filename="${file}"`, vary: 'accept' } });
}
