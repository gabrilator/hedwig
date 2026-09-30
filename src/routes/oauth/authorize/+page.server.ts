import OAuth2Server from '@node-oauth/oauth2-server';
import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { ctx } from '$lib/server/context';
import { oauthOrigin, oauthServer, SCOPE_LABELS, validateAuthorization } from '$lib/server/mcpAuth';
import { randomToken } from '$lib/server/crypto';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
  // Not 'no-referrer': browsers send Origin: null on a form post from such a page, which the origin check rejects.
  // 'same-origin' still keeps this URL (client, state, challenge) out of the Referer sent to the client's callback.
  const c = ctx(locals); setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
  try {
    const { client, scope } = await validateAuthorization(await getDb(), url.searchParams, oauthOrigin(url.origin));
    return { clientName: client.client_name, redirectHost: new URL(url.searchParams.get('redirect_uri')!).host, permissions: scope.map(s => ({ key: s, label: SCOPE_LABELS[s] })), spaces: c.spaces.map(s => ({ key: s.key, name: s.name })) };
  } catch (e) { error(400, (e as Error).message); }
};
export const actions: Actions = {
  default: async ({ request, url, locals }) => {
    const c = ctx(locals), db = await getDb(), origin = oauthOrigin(url.origin);
    let auth;
    try { auth = await validateAuthorization(db, url.searchParams, origin); } catch (e) { return fail(400, { error: (e as Error).message }); }
    const form = await request.formData();
    if (form.get('decision') !== 'allow') {
      const target = new URL(auth.query.redirect_uri); target.searchParams.set('error', 'access_denied');
      if (auth.query.state) target.searchParams.set('state', auth.query.state);
      redirect(303, target.toString());
    }
    const space = String(form.get('space'));
    if (!c.spaces.some(s => s.key === space)) return fail(403, { error: 'Choose a workspace you can access.' });
    const scopes = form.getAll('scope').map(String);
    if (!scopes.length || scopes.some(s => !auth.scope.includes(s))) return fail(400, { error: 'Choose valid permissions.' });
    const grantId = randomToken(32);
    await db.collection('oauthGrants').insertOne({ _id: grantId as any, userId: c.user._id.toHexString(), space, scope: scopes, clientId: auth.query.client_id, clientName: auth.client.client_name, createdAt: new Date() });
    const response = new OAuth2Server.Response();
    try {
      await oauthServer(db, origin, true).authorize(new OAuth2Server.Request({ method: 'GET', headers: {}, query: { ...auth.query, scope: scopes.join(' ') } }), response, { allowEmptyState: true, authenticateHandler: { handle: async () => ({ id: c.user._id.toHexString(), grantId }) } });
    } catch (e) {
      await db.collection('oauthGrants').updateOne({ _id: grantId as any }, { $set: { revokedAt: new Date() } });
      return fail(400, { error: (e as Error).message });
    }
    redirect(303, response.get('location'));
  }
};
