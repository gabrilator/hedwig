import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { adminCtx, bool, ownedCampaign, plain } from '$lib/server/context';
import { describeAgent, effectiveAgent, ensureDefaultAgent } from '$lib/server/agent';
import { jevConfigured } from '$lib/server/env';

export const load: PageServerLoad = async ({ locals, params }) => {
  const c = adminCtx(locals); const db = await getDb(); const col = cols(db);
  const campaign = await ownedCampaign(db, c, params.id);
  const [space, agent, recent] = await Promise.all([
    ensureDefaultAgent(db, campaign.space, campaign.ownerUserId),
    effectiveAgent(db, campaign),
    col.messages.find({ campaignId: campaign._id, 'ai.label': { $exists: true } }, { sort: { at: -1 }, limit: 10, projection: { leadId: 1, from: 1, subject: 1, at: 1, ai: 1 } }).toArray()
  ]);
  return {
    on: !campaign.agentOff, spaceAgent: { name: space.name, active: space.active },
    what: describeAgent(agent), canLabel: jevConfigured(),
    recent: plain(recent.map((m) => ({ leadId: m.leadId, from: m.from, subject: m.subject, at: m.at, label: m.ai?.label, confidence: m.ai?.confidence ?? 0, reason: m.ai?.reason ?? '', appliedStatus: m.ai?.appliedStatus ?? null })))
  };
};
export const actions: Actions = {
  save: async ({ request, locals, params }) => {
    const c = adminCtx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const on = bool(await request.formData(), 'on');
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: { agentOff: !on, updatedAt: new Date() }, $unset: { agentActive: '', agentId: '', agentRules: '' } });
    return { saved: true };
  }
};
