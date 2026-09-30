import type { LayoutServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, ownedCampaign, plain } from '$lib/server/context';
import { activationProblems, leadCounts } from '$lib/server/campaigns';
import { windowFor } from '$lib/server/planner';
import { effectiveAgent } from '$lib/server/agent';

export const load: LayoutServerLoad = async ({ locals, params }) => {
  const c = ctx(locals);
  const db = await getDb();
  const campaign = await ownedCampaign(db, c, params.id);
  const [counts, accounts, agent] = await Promise.all([
    leadCounts(db, campaign._id),
    cols(db).emailAccounts.find({ _id: { $in: campaign.accountIds } }, { projection: { address: 1, status: 1 } }).toArray(),
    effectiveAgent(db, campaign)
  ]);
  let windowNote = '';
  try { const w = windowFor(campaign.schedule, new Date()); windowNote = w.open ? 'window open now' : `window closed: ${w.reason}`; } catch { windowNote = 'invalid timezone'; }
  return {
    campaign: plain(campaign), counts, accountsUsed: plain(accounts), problems: activationProblems(campaign, counts.total), windowNote,
    agent: agent ? { id: agent._id.toHexString(), name: agent.name, mode: agent.mode, active: agent.active } : null
  };
};
