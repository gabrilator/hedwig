import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cols, getDb } from '$lib/server/db';
import { ctx } from '$lib/server/context';
import { pkcePair, randomToken } from '$lib/server/crypto';
import { msAuthUrl } from '$lib/server/mail/microsoft';
import { masterKeyProblem, microsoftConfigured } from '$lib/server/env';

export const GET: RequestHandler = async ({ locals }) => {
  const c = ctx(locals);
  if (!microsoftConfigured()) redirect(303, '/emails?error=' + encodeURIComponent('Microsoft is not configured on the server (MS_CLIENT_ID / MS_CLIENT_SECRET).'));
  const keyProblem = masterKeyProblem();
  if (keyProblem) redirect(303, '/emails?error=' + encodeURIComponent(`${keyProblem} See Setup.`));
  const db = await getDb();
  const state = randomToken(24);
  const { verifier, challenge } = pkcePair();
  await cols(db).oauthStates.insertOne({ _id: state, userId: c.user._id, space: c.space.key, codeVerifier: verifier, createdAt: new Date() });
  redirect(303, msAuthUrl(state, challenge));
};
