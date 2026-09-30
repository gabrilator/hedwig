import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { ctx, plain } from '$lib/server/context';
import { createTable, deleteTables, researchCols } from '$lib/server/research';
import { OperationError } from '$lib/server/operations';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) => { const c = ctx(locals); return { tables: plain(await researchCols(await getDb()).tables.find({ space: c.space.key }).sort({ createdAt: -1 }).limit(200).toArray()) }; };
export const actions: Actions = {
  create: async ({ request, locals }) => {
    const c = ctx(locals), name = String((await request.formData()).get('name') ?? '').trim();
    if (!name || name.length > 200) return fail(400, { error: 'Give the list a name (up to 200 characters).' });
    const table = await createTable(await getDb(), { userId: c.user._id, space: c.space.key }, name, [{ key: 'companyName', label: 'Company', type: 'text' }, { key: 'firstName', label: 'First name', type: 'text' }, { key: 'website', label: 'Website', type: 'url' }]);
    redirect(303, `/lists/${table._id}`);
  },
  delete: async ({ request, locals }) => {
    const c = ctx(locals), ids = (await request.formData()).getAll('ids').map(String);
    try { return { deleted: (await deleteTables(await getDb(), { userId: c.user._id, space: c.space.key }, ids)).deleted }; }
    catch (e) { if (e instanceof OperationError || e instanceof z.ZodError) return fail(400, { error: 'Choose at least one list to delete.' }); throw e; }
  }
};
