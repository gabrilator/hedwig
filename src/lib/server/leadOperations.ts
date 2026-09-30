import type { Db } from 'mongodb';
import { cols } from './db';
import { campaignFor, objectId, OperationError, withCampaignEdit, type Actor } from './operations';
import { cellSchema } from './research';
import { z } from 'zod';
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(k => !['email', '__proto__', 'constructor', 'prototype'].includes(k));
export async function listCampaignLeads(db: Db, actor: Actor, campaignId: string, after?: string, limit = 50) {
  const campaign = await campaignFor(db, actor, campaignId);
  const rows = await cols(db).leads.find({ campaignId: campaign._id, ...(after ? { _id: { $gt: objectId(after) } } : {}) }, { projection: { email: 1, vars: 1, status: 1, curious: 1, currentStep: 1, accountId: 1, nextDueAt: 1, fieldEvidence: 1 } }).sort({ _id: 1 }).limit(limit + 1).toArray();
  const more = rows.length > limit; if (more) rows.pop();
  return { leads: rows, nextCursor: more ? rows.at(-1)!._id : null };
}
export async function updateLeadFields(db: Db, actor: Actor, campaignId: string, input: unknown, mode: 'fill_missing' | 'replace') {
  const rows = z.array(z.object({ leadId: z.string(), fields: z.record(key, cellSchema) })).min(1).max(200).parse(input);
  const campaign = await campaignFor(db, actor, campaignId);
  return withCampaignEdit(db, campaign._id, async () => {
    const results = [];
    for (const row of rows) {
      const lead = await cols(db).leads.findOne({ _id: objectId(row.leadId), campaignId: campaign._id });
      if (!lead) { results.push({ leadId: row.leadId, status: 'not_found' }); continue; }
      const changes: Record<string, unknown> = {}, updated = [], skipped = [];
      for (const [name, cell] of Object.entries(row.fields)) {
        if (cell.kind === 'manual') throw new OperationError('invalid_input', 'Only a person editing Hedwig may mark a value manual.');
        if (cell.kind === 'observed' && cell.status === 'complete' && cell.value !== null && !cell.sources.length) throw new OperationError('evidence_required', `${name} requires a source URL.`);
        const existing = lead.vars[name];
        if (existing && (mode === 'fill_missing' || !lead.fieldEvidence?.[name] || lead.fieldEvidence[name].kind === 'manual')) { skipped.push(name); continue; }
        changes[`fieldEvidence.${name}`] = { ...cell, updatedAt: new Date(), byUserId: actor.userId.toHexString() };
        changes[`vars.${name}`] = cell.status === 'complete' && cell.value !== null ? String(cell.value) : '';
        updated.push(name);
      }
      if (updated.length) await cols(db).leads.updateOne({ _id: lead._id, campaignId: campaign._id }, { $set: changes });
      results.push({ leadId: row.leadId, status: 'updated', updated, skipped });
    }
    return { results };
  });
}
