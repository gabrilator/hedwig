import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { cols, getDb } from '$lib/server/db';
import { ctx, plain } from '$lib/server/context';
import { addColumn, deleteTables, enrollTable, enrollContacts, readTable, removeFromTable, upsertRows } from '$lib/server/research';
import { OperationError } from '$lib/server/operations';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, params, url }) => {
  const c = ctx(locals), db = await getDb();
  return plain({ ...(await readTable(db, { userId: c.user._id, space: c.space.key }, params.id, url.searchParams.get('after') ?? undefined)), campaigns: await cols(db).campaigns.find({ space: c.space.key, status: { $ne: 'active' } }, { projection: { name: 1, status: 1 } }).limit(200).toArray() });
};
async function result(fn: () => Promise<unknown>) { try { return { result: plain(await fn()) }; } catch (e) { if (e instanceof OperationError || e instanceof z.ZodError || e instanceof SyntaxError) return fail(400, { error: e.message }); throw e; } }
export const actions: Actions = {
  column: async ({ request, locals, params }) => { const c = ctx(locals), fd = await request.formData(); return result(async () => addColumn(await getDb(), { userId: c.user._id, space: c.space.key }, params.id, { key: String(fd.get('key')), label: String(fd.get('label')), type: String(fd.get('type')), description: String(fd.get('description') ?? '') })); },
  cell: async ({ request, locals, params }) => {
    const c = ctx(locals), fd = await request.formData(); let value: unknown = String(fd.get('value') ?? '');
    if (fd.get('type') === 'number') value = value === '' ? null : Number(value);
    if (fd.get('type') === 'boolean') value = value === '' ? null : value === 'true';
    return result(async () => upsertRows(await getDb(), { userId: c.user._id, space: c.space.key }, params.id, [{ contactId: String(fd.get('contactId')), kind: String(fd.get('kind')), fields: { [String(fd.get('key'))]: { value, kind: 'manual', status: value === '' || value === null ? 'missing' : 'complete', sources: [] } } }], 'replace', true));
  },
  enrollAll: async ({ request, locals, params }) => { const c = ctx(locals), fd = await request.formData(); return result(async () => enrollTable(await getDb(), { userId: c.user._id, space: c.space.key }, String(fd.get('campaignId')), params.id, fd.get('allowPreviousOutreach') === 'on')); },
  deleteRows: async ({ request, locals, params }) => { const c = ctx(locals), fd = await request.formData(); return result(async () => removeFromTable(await getDb(), { userId: c.user._id, space: c.space.key }, params.id, fd.getAll('contactIds').map(String))); },
  deleteList: async ({ locals, params }) => { const c = ctx(locals); await deleteTables(await getDb(), { userId: c.user._id, space: c.space.key }, [params.id]); redirect(303, '/lists'); },
  enroll: async ({ request, locals }) => { const c = ctx(locals), fd = await request.formData(); return result(async () => enrollContacts(await getDb(), { userId: c.user._id, space: c.space.key }, String(fd.get('campaignId')), fd.getAll('contactIds').map(String), fd.get('allowPreviousOutreach') === 'on')); }
};
