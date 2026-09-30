import { guardCampaignActions } from '$lib/server/webCampaignActions';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, num, oid, ownedCampaign, plain, str } from '$lib/server/context';
import { buildStepMail, SAMPLE_VARS, sendTest } from '$lib/server/sender';
import { looksLikeHtml, textToEditorHtml, variablesIn } from '$lib/server/render';
import { sanitizeBody } from '$lib/server/sanitize';
import type { StepSpec } from '$lib/server/types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const c = ctx(locals); const db = await getDb(); const col = cols(db);
  const campaign = await ownedCampaign(db, c, params.id);
  const sample = await col.leads.find({ campaignId: campaign._id }, { limit: 300, projection: { vars: 1, email: 1 } }).toArray();
  const keys = new Set<string>();
  for (const l of sample) for (const k of Object.keys(l.vars)) keys.add(k);
  if (!sample.length) ['firstName', 'companyName'].forEach((k) => keys.add(k));
  const used = new Set(campaign.steps.flatMap((st) => [...variablesIn(st.subject ?? ''), ...variablesIn(st.body)]));
  const missingVars = [...used].filter((k) => !keys.has(k) && k !== 'email');
  const testLog = await col.messages.find({ campaignId: campaign._id, kind: 'test' }, { sort: { at: -1 }, limit: 5, projection: { to: 1, from: 1, subject: 1, at: 1, text: 1 } }).toArray();
  const previewLead = sample[0] ? { vars: sample[0].vars, email: sample[0].email } : { vars: SAMPLE_VARS, email: 'alex@example.com' };
  const previews = campaign.steps.map((_, i) => {
    try {
      const b = buildStepMail(campaign, i, { ...previewLead, thread: i > 0 ? { internetMessageId: 'x', subject: campaign.steps[0].subject ?? '' } : undefined }, null);
      return { subject: b.subject, text: b.text, missing: b.missing };
    } catch { return { subject: '', text: '', missing: [] }; }
  });
  const accounts = await col.emailAccounts.find({ space: { $in: c.spaceKeys }, status: 'active' }, { projection: { address: 1 } }).toArray();
  const editorSteps = campaign.steps.map((s) => ({ subject: s.subject ?? '', body: looksLikeHtml(s.body) ? s.body : textToEditorHtml(s.body), delayDays: s.delayDays }));
  return { editorSteps, variables: [...keys].sort(), missingVars, testLog: plain(testLog), previews, previewEmail: previewLead.email, accounts: plain(accounts), testTo: campaign.testRecipient || c.user.email };
};

const rawActions: Actions = {
  saveAll: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    let incoming: unknown;
    try { incoming = JSON.parse(str(fd, 'steps')); } catch { return fail(400, { error: 'Could not read the steps.' }); }
    if (!Array.isArray(incoming) || !incoming.length) return fail(400, { error: 'A campaign needs at least one step.' });
    const steps: StepSpec[] = incoming.slice(0, 12).map((raw: any, i: number) => ({
      subject: i === 0 ? String(raw?.subject ?? '').trim() : (String(raw?.subject ?? '').trim() || null),
      body: sanitizeBody(String(raw?.body ?? '')),
      delayDays: i === 0 ? 0 : Math.max(0, Math.min(90, Number(raw?.delayDays) || 0))
    }));
    await cols(db).campaigns.updateOne({ _id: campaign._id }, { $set: { steps, updatedAt: new Date() } });
    return { saved: true };
  },
  test: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb(); const col = cols(db);
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const i = num(fd, 'step', 0);
    const to = str(fd, 'to') || campaign.testRecipient || c.user.email;
    const accountId = str(fd, 'account');
    const account = accountId
      ? await col.emailAccounts.findOne({ _id: oid(accountId), space: { $in: c.spaceKeys } })
      : await col.emailAccounts.findOne({ _id: { $in: campaign.accountIds }, status: 'active' }) ?? await col.emailAccounts.findOne({ space: { $in: c.spaceKeys }, status: 'active' });
    if (!account) return fail(400, { testError: 'Connect a mailbox first (Emails screen). Test sends go out through a real mailbox.' });
    const lead = await col.leads.findOne({ campaignId: campaign._id }, { projection: { vars: 1, email: 1 } });
    try {
      const r = await sendTest(db, campaign, i, account, to, lead ? { vars: lead.vars, email: lead.email, thread: undefined } : undefined);
      return { testOk: `Test of step ${i + 1} sent to ${to} from ${account.address}` + (r.built.missing.length ? ` · missing variables: ${r.built.missing.join(', ')}` : '') };
    } catch (e: any) {
      return fail(500, { testError: `Could not send: ${e.message}` });
    }
  }
};

export const actions = guardCampaignActions(rawActions, ["saveAll"]);
