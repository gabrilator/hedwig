import type { Db } from 'mongodb';
import { createTable, rowSchema, upsertRows } from './research';
import { OperationError, type Actor } from './operations';
import { isEmail } from './render';

export async function importList(db: Db, actor: Actor, name: string, rows: Record<string, string>[], emailColumn: string, columns: { header: string; variable: string }[]) {
  const seen = new Set<string>();
  let invalid = 0, duplicates = 0;
  const contacts = [];
  for (const row of rows) {
    const email = (row[emailColumn] ?? '').trim().toLowerCase();
    if (!isEmail(email)) { invalid++; continue; }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    contacts.push(rowSchema.parse({ email, fields: Object.fromEntries(columns.map(c => [c.variable, { value: row[c.header] ?? '', kind: 'manual', status: row[c.header] ? 'complete' : 'missing', sources: [] }])) }));
  }
  if (!contacts.length) throw new OperationError('invalid_input', 'Choose a column containing valid email addresses.');
  const table = await createTable(db, actor, name, columns.map(c => ({ key: c.variable, label: c.header, type: 'text' })));
  let saved = 0;
  for (let i = 0; i < contacts.length; i += 200) saved += (await upsertRows(db, actor, table._id.toHexString(), contacts.slice(i, i + 200), 'fill_missing', true)).saved;
  return { table, saved, invalid, duplicates, conflicts: contacts.length - saved };
}
