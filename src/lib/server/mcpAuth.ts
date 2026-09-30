import OAuth2Server from '@node-oauth/oauth2-server';
import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { cols } from './db';
import { randomToken, sha256 } from './crypto';
import { envOpt } from './env';
import { spacesFor } from './scope';
import { OperationError, type Actor } from './operations';

export const SCOPES = ['campaigns:read', 'campaigns:write', 'campaigns:send', 'research:read', 'research:write', 'mailboxes:read', 'mailboxes:write', 'agents:read', 'agents:write', 'inbox:read', 'inbox:write', 'inbox:send', 'workspace:read', 'workspace:write', 'offline_access'] as const;
export const SCOPE_LABELS: Record<string, string> = { 'campaigns:read': 'Read campaigns and statistics', 'campaigns:write': 'Create drafts, edit paused campaigns, enroll contacts and pause sending', 'campaigns:send': 'Start campaigns and send requested sequence tests', 'research:read': 'Read lists and contacts', 'research:write': 'Save lists and enrich columns', 'mailboxes:read': 'Read mailbox settings and health', 'mailboxes:write': 'Manage, check and disconnect mailboxes', 'agents:read': 'Read reply agents', 'agents:write': 'Create, edit and delete reply agents', 'inbox:read': 'Read conversations and drafts', 'inbox:write': 'Manage conversations and request drafts', 'inbox:send': 'Send replies when you ask', 'workspace:read': 'Read workspace settings and team', 'workspace:write': 'Manage your profile, workspace, team and connections', offline_access: 'Stay connected until you disconnect' };
export function oauthOrigin(fallback?: string) {
  const origin = new URL(envOpt('ORIGIN') || fallback || 'http://localhost:5180');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new OperationError('configuration', 'MCP requires an HTTPS ORIGIN (HTTP is allowed only on loopback).');
  return origin.origin;
}
export const resourceUrl = (fallback?: string) => `${oauthOrigin(fallback)}/mcp`;
export const authMetadata = (origin: string) => ({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: SCOPES });

export async function rateLimit(db: Db, bucket: string, maximum: number, seconds = 60) {
  const now = Date.now(), id = sha256(`${bucket}:${Math.floor(now / (seconds * 1000))}`);
  const collection = db.collection('oauthLimits');
  let r;
  try { r = await collection.findOneAndUpdate({ _id: id as any }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now + seconds * 2000) } }, { upsert: true, returnDocument: 'after' }); }
  catch (e: any) { if (e.code !== 11000) throw e; r = await collection.findOneAndUpdate({ _id: id as any }, { $inc: { count: 1 } }, { returnDocument: 'after' }); }
  if (!r || r.count > maximum) throw new OperationError('rate_limited', 'Too many requests. Try again later.');
}
function validRedirect(value: string) {
  try { const u = new URL(value); return !u.hash && !u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))); } catch { return false; }
}
export async function registerClient(db: Db, input: unknown) {
  const data = z.object({ client_name: z.string().trim().min(1).max(100).default('MCP connection'), redirect_uris: z.array(z.string().max(2000).refine(validRedirect)).min(1).max(10), token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('none'), grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']), response_types: z.array(z.literal('code')).default(['code']) }).parse(input);
  const id = randomToken(32), secret = data.token_endpoint_auth_method === 'none' ? undefined : randomToken(32);
  await db.collection('oauthClients').insertOne({ _id: id as any, ...data, ...(secret ? { secretHash: sha256(secret) } : {}), createdAt: new Date() });
  return { client_id: id, ...data, client_id_issued_at: Math.floor(Date.now() / 1000), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) };
}
export async function validateAuthorization(db: Db, params: URLSearchParams, origin: string) {
  for (const k of new Set(params.keys())) if (params.getAll(k).length !== 1) throw new OperationError('invalid_request', 'Duplicate authorization parameter.');
  const client = await db.collection('oauthClients').findOne({ _id: params.get('client_id') as any });
  if (!client || !client.redirect_uris.includes(params.get('redirect_uri'))) throw new OperationError('invalid_request', 'Unknown client or redirect address.');
  if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(params.get('code_challenge') ?? '')) throw new OperationError('invalid_request', 'Authorization requires an S256 PKCE challenge and response_type=code.');
  if (params.get('resource') !== `${origin}/mcp`) throw new OperationError('invalid_target', 'The resource must be this Hedwig instance’s /mcp URL.');
  const scope = (params.get('scope') || SCOPES.join(' ')).split(' ').filter(Boolean);
  if (scope.some(s => !(SCOPES as readonly string[]).includes(s))) throw new OperationError('invalid_scope', 'Unknown permission requested.');
  return { client, scope, query: Object.fromEntries(params) };
}
export async function actorForGrant(db: Db, id: string): Promise<Actor | null> {
  const grant = await db.collection('oauthGrants').findOne({ _id: id as any, revokedAt: { $exists: false } });
  if (!grant) return null;
  const user = await cols(db).users.findOne({ _id: new ObjectId(grant.userId) });
  if (!user) return null;
  const orgs = await cols(db).orgs.find({ 'members.userId': user._id }).toArray();
  if (!spacesFor(user, orgs).some(s => s.key === grant.space)) return null;
  return { userId: user._id, space: grant.space, scopes: grant.scope, connectionId: id };
}
/** The library owns OAuth validation and PKCE. The model owns atomic consumption and hashed credential storage. */
export function oauthServer(db: Db, origin: string, authorization = false) {
  const clients = db.collection('oauthClients'), codes = db.collection('oauthCodes'), tokens = db.collection('oauthTokens');
  const model = {
    async getClient(id: string, secret?: string) {
      const c = await clients.findOne({ _id: id as any });
      if (!c) return false;
      if (!authorization && c.secretHash && (!secret || !timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(c.secretHash)))) return false;
      return { id, grants: c.grant_types, redirectUris: c.redirect_uris };
    },
    async validateScope(_user: any, _client: any, scopes?: string[]) { return scopes?.every(s => (SCOPES as readonly string[]).includes(s)) ? scopes : false; },
    async saveAuthorizationCode(code: any, client: any, user: any) {
      if (code.codeChallengeMethod !== 'S256' || !/^[\w-]{43}$/.test(code.codeChallenge ?? '')) throw new OAuth2Server.InvalidRequestError('S256 PKCE is required.');
      await codes.insertOne({ _id: sha256(code.authorizationCode) as any, expiresAt: code.expiresAt, redirectUri: code.redirectUri, scope: code.scope, codeChallenge: code.codeChallenge, codeChallengeMethod: code.codeChallengeMethod, client, user });
      return { ...code, client, user };
    },
    async getAuthorizationCode(code: string) {
      const stored = await codes.findOne({ _id: sha256(code) as any });
      return stored && await actorForGrant(db, stored.user.grantId) ? { ...stored, authorizationCode: code } : false;
    },
    async revokeAuthorizationCode(code: any) { return (await codes.deleteOne({ _id: sha256(code.authorizationCode) as any })).deletedCount === 1; },
    async generateAccessToken() { return randomToken(32); },
    async generateRefreshToken() { return randomToken(48); },
    async saveToken(token: any, client: any, user: any) {
      if (!await actorForGrant(db, user.grantId)) throw new OAuth2Server.InvalidGrantError('Connection was revoked.');
      if (!token.scope?.includes('offline_access')) { delete token.refreshToken; delete token.refreshTokenExpiresAt; }
      await tokens.insertOne({ _id: sha256(token.accessToken) as any, refreshTokenHash: token.refreshToken ? sha256(token.refreshToken) : randomToken(), accessTokenExpiresAt: token.accessTokenExpiresAt, refreshTokenExpiresAt: token.refreshTokenExpiresAt, expiresAt: token.refreshTokenExpiresAt ?? token.accessTokenExpiresAt, scope: token.scope, client, user, resource: `${origin}/mcp` });
      return { ...token, client, user };
    },
    async getAccessToken(token: string) {
      const stored = await tokens.findOne({ _id: sha256(token) as any });
      return stored && stored.resource === `${origin}/mcp` && await actorForGrant(db, stored.user.grantId) ? { ...stored, accessToken: token } : false;
    },
    async getRefreshToken(token: string) {
      const stored = await tokens.findOne({ refreshTokenHash: sha256(token), });
      if (stored?.refreshUsed) { await db.collection('oauthGrants').updateOne({ _id: stored.user.grantId }, { $set: { revokedAt: new Date(), reason: 'refresh token replay' } }); return false; }
      return stored && stored.resource === `${origin}/mcp` && await actorForGrant(db, stored.user.grantId) ? { ...stored, refreshToken: token } : false;
    },
    async revokeToken(token: any) {
      return (await tokens.updateOne({ refreshTokenHash: sha256(token.refreshToken), refreshUsed: { $ne: true } }, { $set: { refreshUsed: true } })).modifiedCount === 1;
    }
  };
  return new OAuth2Server({ model, accessTokenLifetime: 15 * 60, refreshTokenLifetime: 30 * 86400, allowBearerTokensInQueryString: false, requireClientAuthentication: { authorization_code: false, refresh_token: false } } as any);
}
export async function authenticateMcp(db: Db, request: Request, origin: string) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/i)?.[1];
  if (!token) return null;
  const stored = await db.collection('oauthTokens').findOne({ _id: sha256(token) as any, resource: `${origin}/mcp`, accessTokenExpiresAt: { $gt: new Date() } });
  if (!stored) return null;
  const actor = await actorForGrant(db, stored.user.grantId);
  if (!actor) return null;
  return { ...actor, scopes: stored.scope.filter((s: string) => actor.scopes!.includes(s)) };
}
export const oauthHeaders = { 'cache-control': 'no-store', pragma: 'no-cache', 'access-control-allow-origin': '*' };
export function oauthError(e: unknown) {
  const known = e instanceof OperationError || e instanceof OAuth2Server.OAuthError || e instanceof z.ZodError || e instanceof SyntaxError;
  const code = e instanceof OperationError ? e.code : e instanceof OAuth2Server.OAuthError ? e.name : 'invalid_request';
  return Response.json({ error: known ? code : 'server_error', error_description: known ? (e as Error).message : 'Unable to complete authorization.' }, { status: code === 'rate_limited' ? 429 : known ? 400 : 500, headers: oauthHeaders });
}
