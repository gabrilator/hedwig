import { redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { RequestHandler } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx } from '$lib/server/context';
import { seal } from '$lib/server/crypto';
import { MS_SCOPES, msExchangeCode, msProfile } from '$lib/server/mail/microsoft';
import { enqueue } from '$lib/server/jobs';
import { envOpt } from '$lib/server/env';

export const GET: RequestHandler = async ({ locals, url }) => {
  const c = ctx(locals);
  const db = await getDb(); const col = cols(db);
  const fail = (m: string) => redirect(303, '/emails?error=' + encodeURIComponent(m));
  const err = url.searchParams.get('error');
  if (err) fail(`${err}: ${url.searchParams.get('error_description') ?? ''}`);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state) fail('Missing code or state from Microsoft.');
  const st = await col.oauthStates.findOne({ _id: state! });
  if (!st || !st.userId.equals(c.user._id)) fail('This sign-in attempt expired. Try again.');
  await col.oauthStates.deleteOne({ _id: state! });
  let tokens, profile;
  try {
    tokens = await msExchangeCode(code!, st!.codeVerifier);
    profile = await msProfile(tokens.accessToken);
  } catch (e: any) { fail(e.message); }
  if (!profile!.address) fail('Microsoft did not return an email address for that account.');
  const existing = await col.emailAccounts.findOne({ address: profile!.address });
  if (existing && existing.space !== st!.space) fail(`${profile!.address} is already connected in another space.`);
  const secrets = seal(tokens!);
  if (existing) {
    await col.emailAccounts.updateOne({ _id: existing._id }, { $set: { secrets, status: 'active', kind: 'microsoft', microsoft: { tenantId: envOpt('MS_TENANT_ID') ?? 'common', scopes: MS_SCOPES, homeAccountId: profile!.id } }, $unset: { pausedReason: '', 'sync.lastError': '' } });
    await enqueue(db, 'sync-account', { accountId: existing._id.toHexString() });
  } else {
    const _id = new ObjectId();
    await col.emailAccounts.insertOne({
      _id, space: st!.space, ownerUserId: c.user._id, address: profile!.address, fromName: profile!.name || profile!.address.split('@')[0], kind: 'microsoft', status: 'active',
      dailyLimit: 30, ramp: { enabled: true, startedAt: new Date() }, secrets,
      microsoft: { tenantId: envOpt('MS_TENANT_ID') ?? 'common', scopes: MS_SCOPES, homeAccountId: profile!.id }, sync: {}, createdAt: new Date()
    });
    await enqueue(db, 'dns-check', { accountId: _id.toHexString() });
    await enqueue(db, 'sync-account', { accountId: _id.toHexString() });
  }
  redirect(303, `/emails?connected=${encodeURIComponent(profile!.address)}`);
};
