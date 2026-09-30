/** Create or reset a user: npm run seed:user -- email password [name] */
import { ObjectId } from 'mongodb';
import { cols, ensureIndexes, getDb, closeDb } from '../src/lib/server/db';
import { hashPassword } from '../src/lib/server/crypto';
import { normalizeEmail } from '../src/lib/server/auth';

const [email, password, name] = process.argv.slice(2);
if (!email || !password) { console.error('usage: npm run seed:user -- email password [name]'); process.exit(1); }
const db = await getDb();
await ensureIndexes(db);
const c = cols(db);
const passwordHash = await hashPassword(password);
const r = await c.users.updateOne({ email: normalizeEmail(email) }, { $set: { passwordHash, ...(name ? { name } : {}) }, $setOnInsert: { _id: new ObjectId(), email: normalizeEmail(email), name: name ?? email.split('@')[0], createdAt: new Date() } }, { upsert: true });
console.log(r.upsertedCount ? `created ${email}` : `password updated for ${email}`);
await closeDb();
