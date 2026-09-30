import { pauseCampaign, startCampaign, readiness, resolveCampaignConflict } from '$lib/server/campaignOperations';
import { OperationError } from '$lib/server/operations';
import { guardCampaignActions } from '$lib/server/webCampaignActions';
import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { bool, ctx, list, num, ownedCampaign, plain, str } from '$lib/server/context';
import { duplicateCampaign } from '$lib/server/campaigns';

export const load: PageServerLoad = async ({ locals, params }) => {
  const c = ctx(locals); const db = await getDb();
  const campaign = await ownedCampaign(db, c, params.id);
  const accounts = await cols(db).emailAccounts.find({ space: campaign.space }, { projection: { address: 1, status: 1, dailyLimit: 1, kind: 1 } }).toArray();
  const ready = campaign.status === 'active' ? null : await readiness(db, campaign);
  return { accounts: plain(accounts), conflicts: ready?.conflicts ?? 0, conflictingContacts: ready?.conflictingContacts ?? [] };
};

const rawActions: Actions = {
  resolveConflict: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    try { return { resolved: await resolveCampaignConflict(db, { userId: c.user._id, space: campaign.space }, params.id, str(fd, 'lead'), str(fd, 'choice')) }; }
    catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
  },
  save: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const accountIds = list(fd, 'accountIds').filter((s) => ObjectId.isValid(s)).map((s) => new ObjectId(s));
    const valid = await cols(db).emailAccounts.find({ _id: { $in: accountIds }, space: campaign.space }, { projection: { _id: 1 } }).toArray();
    await cols(db).emailAccounts.updateMany({ _id: { $in: valid.map((a) => a._id) }, timezone: { $exists: false } }, { $set: { timezone: campaign.schedule.timezone } });
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: {
      name: str(fd, 'name') || campaign.name, accountIds: valid.map((a) => a._id), stopOnReply: bool(fd, 'stopOnReply'), oooStops: bool(fd, 'oooStops'),
      openTracking: bool(fd, 'openTracking'), dailyLimit: Math.max(1, num(fd, 'dailyLimit', campaign.dailyLimit)), testRecipient: str(fd, 'testRecipient'),
      unsubscribeLine: str(fd, 'unsubscribeLine'), updatedAt: new Date()
    } });
    return { saved: true };
  },
  activate: async ({ locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    try { await startCampaign(db, { userId: c.user._id, space: campaign.space }, params.id); }
    catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
    redirect(303, `/campaigns/${params.id}/analytics`);
  },
  pause: async ({ locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    try { await pauseCampaign(db, { userId: c.user._id, space: campaign.space }, params.id); }
    catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
    redirect(303, `/campaigns/${params.id}/analytics`);
  },
  resume: async ({ locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    try { await startCampaign(db, { userId: c.user._id, space: campaign.space }, params.id); }
    catch (e) { if (e instanceof OperationError) return fail(409, { error: e.message }); throw e; }
    redirect(303, `/campaigns/${params.id}/analytics`);
  },
  rename: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const name = str(await request.formData(), 'name');
    if (!name) return fail(400, { error: 'Give the campaign a name.' });
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: { name, updatedAt: new Date() } });
    return { renamed: name };
  },
  clone: async ({ locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const id = await duplicateCampaign(db, campaign, c.user._id);
    redirect(303, `/campaigns/${id.toHexString()}/leads`);
  },
  delete: async ({ locals, params }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db);
    const campaign = await ownedCampaign(db, c, params.id);
    await col.sends.deleteMany({ campaignId: campaign._id });
    await col.leads.deleteMany({ campaignId: campaign._id });
    await col.messages.deleteMany({ campaignId: campaign._id });
    await col.events.deleteMany({ campaignId: campaign._id });
    await col.dailyStats.deleteMany({ campaignId: campaign._id });
    await col.campaigns.deleteOne({ _id: campaign._id });
    redirect(303, '/campaigns');
  }
};

export const actions = guardCampaignActions(rawActions, ["save", "delete"]);
