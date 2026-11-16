import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { adminCtx, bool, plain, str } from '$lib/server/context';
import { DEFAULT_AGENT_NAME, ensureDefaultAgent, llmUsage } from '$lib/server/agent';

/** Admins only (ADMIN_EMAILS): the workspace's reply agent and Jev's health. */
export const load: PageServerLoad = async ({ locals }) => {
  const c = adminCtx(locals); const db = await getDb();
  const agent = await ensureDefaultAgent(db, c.space.key, c.user._id);
  const [on, off, llm] = await Promise.all([
    cols(db).campaigns.countDocuments({ space: c.space.key, agentOff: { $ne: true } }),
    cols(db).campaigns.countDocuments({ space: c.space.key, agentOff: true }),
    llmUsage(db)
  ]);
  return { agent: { name: agent.name, active: agent.active }, campaignsOn: on, campaignsOff: off, llm: plain(llm) };
};
export const actions: Actions = {
  save: async ({ request, locals }) => {
    const c = adminCtx(locals); const db = await getDb(); const fd = await request.formData();
    const name = str(fd, 'name') || DEFAULT_AGENT_NAME;
    if (name.length > 60) return fail(400, { error: 'Keep the name under 60 characters.' });
    const agent = await ensureDefaultAgent(db, c.space.key, c.user._id);
    await cols(db).agents.updateOne({ _id: agent._id, space: c.space.key }, { $set: { name, active: bool(fd, 'active') } });
    return { saved: true };
  }
};
