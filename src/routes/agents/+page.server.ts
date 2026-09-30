import { fail } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { bool, ctx, oid, plain, str } from '$lib/server/context';
import { DEFAULT_MODEL, DEFAULT_PERSONA, ensureDefaultAgent, llmUsage, MODELS } from '$lib/server/agent';
import type { AgentMode } from '$lib/server/types';

export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals); const db = await getDb();
  await ensureDefaultAgent(db, c.space.key, c.user._id);
  const [agents, usage, llm] = await Promise.all([
    cols(db).agents.find({ space: c.space.key }, { sort: { builtin: -1, createdAt: 1 } }).toArray(),
    cols(db).campaigns.aggregate<{ _id: any; n: number }>([{ $match: { space: c.space.key, agentId: { $ne: null }, agentOff: { $ne: true } } }, { $group: { _id: '$agentId', n: { $sum: 1 } } }]).toArray(),
    llmUsage(db)
  ]);
  const [withDefault, off] = await Promise.all([
    cols(db).campaigns.countDocuments({ space: c.space.key, $or: [{ agentId: null }, { agentId: { $exists: false } }], agentOff: { $ne: true } }),
    cols(db).campaigns.countDocuments({ space: c.space.key, agentOff: true })
  ]);
  const editId = url.searchParams.get('edit');
  return {
    agents: plain(agents.map((a) => ({ ...a, usedBy: a.builtin ? withDefault : usage.find((u) => String(u._id) === a._id.toHexString())?.n ?? 0 }))),
    editId, models: MODELS, defaults: { model: DEFAULT_MODEL, persona: DEFAULT_PERSONA }, campaignsOff: off, llm: plain(llm)
  };
};
export const actions: Actions = {
  save: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const id = str(fd, 'id');
    const model = MODELS.some((m) => m.id === str(fd, 'model')) ? str(fd, 'model') : DEFAULT_MODEL;
    const mode: AgentMode = str(fd, 'mode') === 'draft' ? 'draft' : 'classify';
    const doc = { name: str(fd, 'name') || 'Triage', model, persona: str(fd, 'persona'), mode, active: bool(fd, 'active') };
    if (id) await cols(db).agents.updateOne({ _id: oid(id), space: c.space.key }, { $set: doc });
    else await cols(db).agents.insertOne({ _id: new ObjectId(), space: c.space.key, ownerUserId: c.user._id, ...doc, createdAt: new Date() });
    return { saved: true };
  },
  delete: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const id = oid(str(await request.formData(), 'id'));
    const agent = await cols(db).agents.findOne({ _id: id, space: c.space.key });
    if (!agent) return fail(404, { error: 'Agent not found' });
    if (agent.builtin) return fail(400, { error: 'Triage is built in. Switch it off instead of deleting it.' });
    const inUse = await cols(db).campaigns.countDocuments({ agentId: id });
    if (inUse) return fail(400, { error: `This agent is assigned to ${inUse} campaign(s). Point them at Triage first.` });
    await cols(db).agents.deleteOne({ _id: id, space: c.space.key });
    return { saved: true };
  }
};
