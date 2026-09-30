/**
 * Curious: someone who opened a campaign's emails more often than they got them (2 emails, 3 opens) and never replied.
 * A flag on the lead, apart from its status, checked once a day by the worker. Opens are a person's opens (the prefetch
 * discounted, hits within a minute collapsed), so the one machine load most emails get on arrival never makes anyone
 * curious alone. A reply outranks it: the reply clears the check's mark. A person may set or reset it, and that is final.
 */
import type { Db, ObjectId } from 'mongodb';
import { cols } from './db';

/** Marks every lead that qualifies and was never judged before. One atomic update; running it twice marks nobody twice. */
export async function markCurious(db: Db, now = new Date()): Promise<number> {
  const r = await cols(db).leads.updateMany(
    { status: { $in: ['contacted', 'opened'] }, curious: { $exists: false }, currentStep: { $gte: 1 }, openCount: { $gte: 2 }, $expr: { $gt: ['$openCount', '$currentStep'] } },
    { $set: { curious: true, curiousAt: now, curiousBy: 'rule' } }
  );
  return r.modifiedCount;
}

/** A person's call, either way. The daily check never touches this lead again. */
export async function setCurious(db: Db, leadId: ObjectId, campaignId: ObjectId, on: boolean, by: string): Promise<boolean> {
  const r = await cols(db).leads.updateOne({ _id: leadId, campaignId }, { $set: { curious: on, curiousAt: new Date(), curiousBy: by } });
  return r.matchedCount > 0;
}
