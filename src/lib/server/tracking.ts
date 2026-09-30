import type { Db } from 'mongodb';
import { cols } from './db';
import { trackingBase } from './env';
import { recordEvent } from './stats';

export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export const pixelUrl = (token: string) => `${trackingBase()}/t/o/${token}.gif`;
export const unsubUrl = (token: string) => `${trackingBase()}/u/${token}`;

/** Prefetch window: an "open" this soon after sending is a machine, not a person. */
const PREFETCH_MS = 10_000;
/** Two pixel hits closer than this are one open by one person (preview pane + full view, a re-render). */
const HUMAN_GAP_MS = 60_000;

export async function recordOpen(db: Db, token: string, meta: { ua?: string; ip?: string }): Promise<boolean> {
  const c = cols(db);
  const send = await c.sends.findOne({ 'tokens.open': token, status: 'sent' });
  if (!send || !send.sentAt) return false;
  const now = new Date();
  const prefetch = now.getTime() - send.sentAt.getTime() < PREFETCH_MS;
  const first = !send.firstOpenedAt;
  // A person's open: not the prefetch, and not a second hit of the same open (clients fetch the pixel more than once).
  const lastOpen = send.opens?.length ? new Date(send.opens[send.opens.length - 1]) : null;
  const human = !prefetch && (!lastOpen || now.getTime() - lastOpen.getTime() > HUMAN_GAP_MS);
  await c.sends.updateOne({ _id: send._id }, {
    $inc: { openCount: 1 },
    ...(first && !prefetch ? { $set: { firstOpenedAt: now } } : {}),
    ...(human ? { $push: { opens: { $each: [now], $slice: -30 } } } : {})
  });
  await recordEvent(db, {
    space: send.space, campaignId: send.campaignId, leadId: send.leadId, accountId: send.accountId, stepIndex: send.stepIndex,
    type: 'open', at: now, uniqueOpen: first && !prefetch, meta: { unique: first && !prefetch, prefetch, ua: meta.ua?.slice(0, 200) }
  });
  if (!prefetch) {
    await c.leads.updateOne({ _id: send.leadId, status: 'contacted' }, { $set: { status: 'opened', lastEventAt: now } });
    if (human) await c.leads.updateOne({ _id: send.leadId }, { $inc: { openCount: 1 }, $set: { lastOpenedAt: now } });
  }
  return true;
}

export async function recordUnsubscribe(db: Db, token: string): Promise<{ ok: boolean; email?: string }> {
  const c = cols(db);
  const send = await c.sends.findOne({ 'tokens.unsub': token });
  if (!send) return { ok: false };
  const lead = await c.leads.findOne({ _id: send.leadId });
  if (!lead) return { ok: false };
  const now = new Date();
  await c.leads.updateOne({ _id: lead._id }, { $set: { status: 'unsubscribed', lastEventAt: now, nextDueAt: null } });
  await c.sends.updateMany({ leadId: lead._id, status: { $in: ['planned', 'claimed'] } }, { $set: { status: 'cancelled', reason: 'unsubscribed' } });
  await c.suppressions.updateOne({ space: lead.space, email: lead.email }, { $setOnInsert: { reason: 'unsubscribed', at: now } }, { upsert: true });
  if (lead.status !== 'unsubscribed') {
    await recordEvent(db, { space: send.space, campaignId: send.campaignId, leadId: lead._id, accountId: send.accountId, stepIndex: send.stepIndex, type: 'unsubscribe', at: now });
  }
  return { ok: true, email: lead.email };
}
