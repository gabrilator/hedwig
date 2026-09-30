import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { recordUnsubscribe } from '$lib/server/tracking';

export const load: PageServerLoad = async ({ params }) => {
  const db = await getDb();
  const send = await cols(db).sends.findOne({ 'tokens.unsub': params.token });
  if (!send) return { valid: false, done: false, email: '' };
  const lead = await cols(db).leads.findOne({ _id: send.leadId }, { projection: { email: 1, status: 1 } });
  return { valid: !!lead, done: lead?.status === 'unsubscribed', email: lead?.email ?? '' };
};
export const actions: Actions = {
  default: async ({ params }) => {
    const db = await getDb();
    const r = await recordUnsubscribe(db, params.token);
    return { done: r.ok, email: r.email ?? '' };
  }
};
