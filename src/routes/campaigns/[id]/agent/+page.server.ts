import type { Actions, PageServerLoad } from './$types';
import { ObjectId } from 'mongodb';
import { cols, getDb } from '$lib/server/db';
import { ctx, ownedCampaign, plain, str } from '$lib/server/context';
import { describeAgent, effectiveAgent, ensureDefaultAgent } from '$lib/server/agent';
import { classifierConfigured, jevConfigured } from '$lib/server/env';

export const load: PageServerLoad = async ({ locals, params }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const campaign = await ownedCampaign(db, c, params.id);
  const [agents, agent, recent] = await Promise.all([
    col.agents.find({ space: { $in: c.spaceKeys } }, { sort: { builtin: -1, createdAt: 1 } }).toArray(),
    effectiveAgent(db, campaign),
    col.messages.find({ campaignId: campaign._id, 'ai.label': { $exists: true } }, { sort: { at: -1 }, limit: 10, projection: { leadId: 1, from: 1, subject: 1, at: 1, ai: 1 } }).toArray()
  ]);
  await ensureDefaultAgent(db, campaign.space, campaign.ownerUserId);
  const choice = campaign.agentOff ? 'none' : campaign.agentId ? campaign.agentId.toHexString() : 'default';
  return {
    agents: plain(agents.map((a) => ({ id: a._id.toHexString(), name: a.name, model: a.model, mode: a.mode, active: a.active, builtin: !!a.builtin }))),
    choice, agent: agent ? { id: agent._id.toHexString(), name: agent.name, model: agent.model, mode: agent.mode, active: agent.active, builtin: !!agent.builtin } : null,
    what: describeAgent(agent), canLabel: classifierConfigured(), jev: jevConfigured(),
    recent: plain(recent.map((m) => ({ leadId: m.leadId, from: m.from, subject: m.subject, at: m.at, label: m.ai?.label, confidence: m.ai?.confidence ?? 0, reason: m.ai?.reason ?? '', appliedStatus: m.ai?.appliedStatus ?? null })))
  };
};
export const actions: Actions = {
  save: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const choice = str(fd, 'choice');
    const ifs = fd.getAll('if').map(String), thens = fd.getAll('then').map(String);
    const agentRules = ifs.map((i, k) => ({ if: i.trim(), then: (thens[k] ?? '').trim() })).filter((r) => r.if || r.then);
    let agentId: ObjectId | null = null, agentOff = false;
    if (choice === 'none') agentOff = true;
    else if (choice !== 'default' && ObjectId.isValid(choice)) {
      const a = await cols(db).agents.findOne({ _id: new ObjectId(choice), space: { $in: c.spaceKeys } });
      if (a && !a.builtin) agentId = a._id;
    }
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: { agentId, agentOff, agentRules, updatedAt: new Date() }, $unset: { agentActive: '' } });
    return { saved: true };
  }
};
