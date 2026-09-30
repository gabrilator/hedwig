import { guardCampaignActions } from '$lib/server/webCampaignActions';
import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx, oid, ownedCampaign, str } from '$lib/server/context';
import { columnStats, detectEmailColumn, importLeads, parseSheet } from '$lib/server/csv';
import { enrollTable, researchCols } from '$lib/server/research';
import { OperationError } from '$lib/server/operations';
import { plain } from '$lib/server/context';
import { camelKey, isEmail } from '$lib/server/render';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const c = ctx(locals); const db = await getDb();
  const campaign = await ownedCampaign(db, c, params.id);
  const importId = url.searchParams.get('import');
  const lists = plain(await researchCols(db).tables.find({ space: c.space.key }).sort({ updatedAt: -1 }).limit(200).toArray());
  if (!importId) return { preview: null, lists };
  const imp = await cols(db).imports.findOne({ _id: oid(importId), campaignId: campaign._id });
  if (!imp) return { preview: null, lists, error: 'That upload expired. Upload the file again.' };
  // per column: how many leads survive if it is the email column, so the screen can show the real count before importing
  const [existing, suppressed] = await Promise.all([
    cols(db).leads.find({ campaignId: campaign._id }, { projection: { email: 1 } }).map((l) => l.email).toArray(),
    cols(db).suppressions.find({ space: campaign.space }, { projection: { email: 1 } }).map((s) => s.email).toArray()
  ]);
  const stats = columnStats(imp.headers, imp.rows, new Set(existing), new Set(suppressed));
  return {
    lists, preview: {
      id: imp._id.toHexString(), fileName: imp.fileName, total: imp.rows.length, emailColumn: imp.emailColumn,
      columns: imp.headers.map((h) => ({ header: h, variable: camelKey(h), samples: imp.rows.slice(0, 3).map((r) => r[h] ?? ''), stat: stats[h] }))
    }
  };
};

const rawActions: Actions = {
  list: async ({ request, locals, params }) => {
    const c = ctx(locals), db = await getDb(), fd = await request.formData();
    let result;
    try { result = await enrollTable(db, { userId: c.user._id, space: c.space.key }, params.id, str(fd, 'listId')); }
    catch (e) { if (e instanceof OperationError) return fail(400, { error: e.message }); throw e; }
    const message = `${result.enrolled} contacts added` + result.results.map(r => ` · ${r.detail}`).join('');
    redirect(303, `/campaigns/${params.id}/leads?imported=${encodeURIComponent(message)}`);
  },
  upload: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const file = fd.get('file');
    if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'Choose a CSV or Excel file first.' });
    if (file.size > 25 * 1024 * 1024) return fail(400, { error: 'That file is over 25 MB. Split it.' });
    let parsed;
    try { parsed = parseSheet(file.name, Buffer.from(await file.arrayBuffer())); }
    catch (e: any) { return fail(400, { error: `Could not read ${file.name}: ${e.message}` }); }
    const { headers, rows, errors } = parsed;
    if (!headers.length || !rows.length) return fail(400, { error: `No rows found in ${file.name}. ${errors[0] ?? 'Is there a header row?'}` });
    const emailColumn = detectEmailColumn(headers, rows);
    const _id = new ObjectId();
    await cols(db).imports.insertOne({ _id, campaignId: campaign._id, space: campaign.space, fileName: file.name, headers, rows, emailColumn, createdAt: new Date() });
    redirect(303, `/campaigns/${params.id}/leads/import?import=${_id.toHexString()}`);
  },
  confirm: async ({ request, locals, params }) => {
    const c = ctx(locals); const db = await getDb();
    const campaign = await ownedCampaign(db, c, params.id);
    const fd = await request.formData();
    const imp = await cols(db).imports.findOne({ _id: oid(str(fd, 'import')), campaignId: campaign._id });
    if (!imp) return fail(400, { error: 'That upload expired. Upload the file again.' });
    const emailColumn = str(fd, 'emailColumn');
    if (!imp.headers.includes(emailColumn)) return fail(400, { error: 'Pick the column that holds the email address.' });
    if (!imp.rows.some((r) => isEmail(r[emailColumn] ?? ''))) return fail(400, { error: `No row has a valid email address in “${emailColumn}”. Pick the column with the addresses.` });
    const keep = new Set(fd.getAll('keep').map(String));
    const columns = imp.headers.filter((h) => h !== emailColumn && keep.has(h)).map((h) => ({ header: h, variable: str(fd, `var:${h}`) || camelKey(h) }));
    const stats = await importLeads(db, campaign, imp.rows, { emailColumn, columns });
    await cols(db).imports.deleteOne({ _id: imp._id });
    const msg = `${stats.inserted} leads imported from ${imp.fileName} with ${columns.length} variable${columns.length === 1 ? '' : 's'}` +
      (stats.alreadyInCampaign ? ` · ${stats.alreadyInCampaign} already in this campaign` : '') +
      (stats.duplicatesInFile ? ` · ${stats.duplicatesInFile} duplicates in the file` : '') +
      (stats.invalid ? ` · ${stats.invalid} without a valid email` : '') +
      (stats.activeElsewhere ? ` · ${stats.activeElsewhere} in another active campaign` : '') +
      (stats.previousOutreach ? ` · ${stats.previousOutreach} previously contacted` : '') +
      (stats.suppressed ? ` · ${stats.suppressed} on the suppression list` : '');
    redirect(303, `/campaigns/${params.id}/leads?imported=${encodeURIComponent(msg)}`);
  }
};

export const actions = guardCampaignActions(rawActions, ["confirm"]);
