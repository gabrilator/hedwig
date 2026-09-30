import { error, redirect } from '@sveltejs/kit';
import { ObjectId, type Db } from 'mongodb';
import { cols } from './db';
import type { SpaceInfo } from './scope';
import type { UserDoc } from './types';

export interface Ctx { user: UserDoc; space: SpaceInfo; spaces: SpaceInfo[]; spaceKeys: string[] }
export function ctx(locals: App.Locals): Ctx {
  if (!locals.user || !locals.space) redirect(303, '/login');
  return { user: locals.user, space: locals.space, spaces: locals.spaces, spaceKeys: locals.spaces.map((s) => s.key) };
}
/** Anything Mongo gives us → plain JSON (ObjectId → hex string, Date → ISO string) so it can cross to the page. */
export const plain = <T = any>(x: unknown): T => JSON.parse(JSON.stringify(x));

export function oid(s: string | null | undefined): ObjectId {
  if (!s || !ObjectId.isValid(s)) error(404, 'Not found');
  return new ObjectId(s);
}
export const str = (fd: FormData, k: string, d = ''): string => String(fd.get(k) ?? d).trim();
export const num = (fd: FormData, k: string, d: number): number => { const n = Number(fd.get(k)); return Number.isFinite(n) && String(fd.get(k) ?? '').trim() !== '' ? n : d; };
export const bool = (fd: FormData, k: string): boolean => { const v = fd.get(k); return v === 'on' || v === 'true' || v === '1'; };
export const list = (fd: FormData, k: string): string[] => fd.getAll(k).map(String).filter(Boolean);

export async function ownedCampaign(db: Db, c: Ctx, id: string) {
  const doc = await cols(db).campaigns.findOne({ _id: oid(id), space: { $in: c.spaceKeys } });
  if (!doc) error(404, 'Campaign not found');
  return doc;
}
export async function ownedAccount(db: Db, c: Ctx, id: string) {
  const doc = await cols(db).emailAccounts.findOne({ _id: oid(id), space: { $in: c.spaceKeys } });
  if (!doc) error(404, 'Mailbox not found');
  return doc;
}
export const userJson = (u: UserDoc) => ({ id: u._id.toHexString(), email: u.email, name: u.name });
