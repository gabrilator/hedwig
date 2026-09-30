import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { ctx, oid, plain, str } from '$lib/server/context';
import { parseSheet, detectEmailColumn } from '$lib/server/csv';
import { camelKey } from '$lib/server/render';
import { importList } from '$lib/server/listImport';
import { OperationError } from '$lib/server/operations';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, url }) => {
  const c = ctx(locals), db = await getDb(), id = url.searchParams.get('import');
  const upload = id ? await db.collection('listImports').findOne({ _id: oid(id), space: c.space.key, userId: c.user._id }) : null;
  return { preview: upload ? plain({ id: upload._id, name: upload.name, total: upload.rows.length, emailColumn: upload.emailColumn, columns: upload.headers.map((header: string) => ({ header, variable: camelKey(header), samples: upload.rows.slice(0, 3).map((r: Record<string,string>) => r[header]) })) }) : null };
};
export const actions: Actions = {
  upload: async ({ locals, request }) => {
    const c = ctx(locals), db = await getDb(), fd = await request.formData(), file = fd.get('file');
    if (!(file instanceof File) || !file.size) return fail(400, { error: 'Choose a CSV or Excel file.' });
    if (file.size > 10 * 1024 * 1024) return fail(400, { error: 'Split files larger than 10 MB.' });
    let parsed;
    try { parsed = parseSheet(file.name, Buffer.from(await file.arrayBuffer())); } catch { return fail(400, { error: 'Could not read this file.' }); }
    if (!parsed.rows.length || parsed.headers.length > 51 || parsed.rows.length > 10000) return fail(400, { error: 'Use 1–10,000 rows and up to 50 columns plus email.' });
    const _id = new ObjectId();
    await db.collection('listImports').insertOne({ _id, space: c.space.key, userId: c.user._id, name: file.name.replace(/\.[^.]+$/, ''), ...parsed, emailColumn: detectEmailColumn(parsed.headers, parsed.rows), createdAt: new Date() });
    redirect(303, `/lists/import?import=${_id}`);
  },
  confirm: async ({ locals, request }) => {
    const c = ctx(locals), db = await getDb(), fd = await request.formData();
    const upload = await db.collection('listImports').findOne({ _id: oid(str(fd, 'import')), space: c.space.key, userId: c.user._id });
    if (!upload) return fail(400, { error: 'Upload expired. Choose the file again.' });
    const emailColumn = str(fd, 'emailColumn'), keep = new Set(fd.getAll('keep').map(String));
    if (!upload.headers.includes(emailColumn)) return fail(400, { error: 'Choose the email column.' });
    let result;
    try { result = await importList(db, { userId: c.user._id, space: c.space.key }, str(fd, 'name'), upload.rows, emailColumn, upload.headers.filter((h: string) => h !== emailColumn && keep.has(h)).map((h: string) => ({ header: h, variable: str(fd, `var:${h}`) || camelKey(h) }))); }
    catch (e) { if (e instanceof OperationError || e instanceof z.ZodError) return fail(400, { error: e.message }); throw e; }
    await db.collection('listImports').deleteOne({ _id: upload._id });
    redirect(303, `/lists/${result.table._id}?imported=${encodeURIComponent(`${result.saved} contacts saved · ${result.duplicates} duplicates skipped · ${result.invalid} invalid emails · ${result.conflicts} conflicts`)}`);
  }
};
