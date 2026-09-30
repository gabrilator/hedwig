import { fail } from '@sveltejs/kit';
import { ctx, ownedCampaign } from './context';
import { getDb } from './db';
import { OperationError, withCampaignEdit } from './operations';

/** Existing web forms use the same mutex and stopped-campaign rule as MCP operations. */
export function guardCampaignActions<A extends Record<string, (event: any) => any>>(actions: A, names: string[]): A {
  return Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, !names.includes(name) ? action : async (event: Parameters<typeof action>[0]) => {
    const db = await getDb(), c = ctx(event.locals);
    const campaign = await ownedCampaign(db, c, event.params.id!);
    try { return await withCampaignEdit(db, campaign._id, () => Promise.resolve(action(event))); }
    catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
  }])) as A;
}
