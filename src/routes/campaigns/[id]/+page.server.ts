import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { ctx, ownedCampaign } from '$lib/server/context';
export const load: PageServerLoad = async ({ params, locals }) => {
  const c = ctx(locals);
  const campaign = await ownedCampaign(await getDb(), c, params.id);
  redirect(303, `/campaigns/${params.id}/${campaign.status === 'draft' ? 'leads' : 'analytics'}`);
};
