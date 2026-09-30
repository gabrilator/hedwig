import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import OAuth2Server from '@node-oauth/oauth2-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { createTable, deleteTables, removeFromTable, upsertRows, enrollTable, enrollContacts, readTable, researchCols } from '../../src/lib/server/research';
import { createMcpServer, handleMcp } from '../../src/lib/server/mcp';
import { actorForGrant, authenticateMcp, oauthServer, registerClient, validateAuthorization } from '../../src/lib/server/mcpAuth';
import { pkcePair, randomToken, sha256 } from '../../src/lib/server/crypto';
import { command, type Actor } from '../../src/lib/server/operations';
import { importList } from '../../src/lib/server/listImport';
import { newCampaign } from '../../src/lib/server/campaigns';
import { pauseCampaign, startCampaign, updateCampaign, campaignStats, readiness, resolveCampaignConflict } from '../../src/lib/server/campaignOperations';
import { planCampaign } from '../../src/lib/server/planner';

let db: Db;
const userId = new ObjectId(), space = `user:${userId}`, actor: Actor = { userId, space };
const origin = 'http://localhost:5180';
process.env.ORIGIN = origin;
beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); await cols(db).users.insertOne({ _id: userId, email: 'owner@example.com', name: 'Owner', passwordHash: 'unused', createdAt: new Date() }); });
afterAll(async () => { await db.dropDatabase(); await closeDb(); });
const column = { key: 'signal', label: 'Signal', type: 'text' as const };
const observed = (value: string) => ({ value, kind: 'observed', sources: ['https://example.com/careers'] });
async function fixture() {
  const cp = { _id: new ObjectId(), ...newCampaign(space, userId, 'Test campaign', 'owner@example.com', 'UTC') };
  const accountId = new ObjectId();
  cp.steps = [{ subject: 'Hello', body: 'Hello {{signal|there}}', delayDays: 0 }]; cp.accountIds = [accountId];
  cp.schedule = { timezone: 'UTC', from: '00:00', to: '23:59', days: [0,1,2,3,4,5,6] };
  await cols(db).emailAccounts.insertOne({ _id: accountId, space, ownerUserId: userId, address: `${accountId}@example.com`, fromName: 'Test', kind: 'imapSmtp', status: 'active', dailyLimit: 30, ramp: { enabled: false, startedAt: new Date() }, secrets: '', sync: {}, createdAt: new Date() });
  await cols(db).campaigns.insertOne(cp);
  await cols(db).heartbeat.updateOne({ _id: 'worker' }, { $set: { at: new Date(), version: 'test', pid: 0, host: 'test' } }, { upsert: true });
  return cp;
}

describe('research and campaign safety', () => {
  it('identifies overlapping contacts and resolves either side without deleting other campaign history', async () => {
    const a = await fixture(), b = await fixture(), table = await createTable(db, actor, 'Conflict resolution', []);
    const saved = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'overlap@example.com' }, { email: 'remove-overlap@example.com' }]);
    const ids = saved.results.map(r => r.contactId!);
    await enrollContacts(db, actor, a._id.toHexString(), ids);
    await enrollContacts(db, actor, b._id.toHexString(), ids);
    await startCampaign(db, actor, b._id.toHexString());
    const ready = await readiness(db, a);
    expect(ready.conflicts).toBe(2);
    const contact = ready.conflictingContacts.find(l => l.email === 'overlap@example.com')!;
    expect(contact.campaigns[0]).toMatchObject({ id: b._id.toHexString(), name: b.name });
    await expect(resolveCampaignConflict(db, { ...actor, space: 'org:other' }, a._id.toHexString(), contact.leadId, 'keep')).rejects.toMatchObject({ code: 'not_found' });
    const other = await cols(db).leads.findOne({ campaignId: b._id, email: contact.email });
    const sendId = new ObjectId();
    await cols(db).sends.insertOne({ _id: sendId, space, campaignId: b._id, leadId: other!._id, stepIndex: 0, accountId: b.accountIds[0], dueAt: new Date(), status: 'claimed', inFlight: true, attempt: 1, tokens: { open: randomToken(), unsub: randomToken() }, createdAt: new Date() });
    await expect(resolveCampaignConflict(db, actor, a._id.toHexString(), contact.leadId, 'keep')).rejects.toMatchObject({ code: 'send_in_flight' });
    expect((await cols(db).leads.findOne({ _id: other!._id }))?.status).toBe('queued');
    await cols(db).sends.updateOne({ _id: sendId }, { $set: { status: 'planned', inFlight: false } });
    await resolveCampaignConflict(db, actor, a._id.toHexString(), contact.leadId, 'keep');
    expect((await cols(db).leads.findOne({ _id: other!._id }))?.status).toBe('paused');
    expect((await cols(db).sends.findOne({ _id: sendId }))?.status).toBe('cancelled');
    expect((await cols(db).campaigns.findOne({ _id: b._id }))?.status).toBe('active');
    const remaining = (await readiness(db, a)).conflictingContacts[0];
    await resolveCampaignConflict(db, actor, a._id.toHexString(), remaining.leadId, 'remove');
    expect(await cols(db).leads.findOne({ _id: new ObjectId(remaining.leadId) })).toBeNull();
    expect((await cols(db).leads.findOne({ campaignId: b._id, email: remaining.email }))?.status).toBe('queued');
    expect((await readiness(db, a)).conflicts).toBe(0);
    await startCampaign(db, actor, a._id.toHexString());
    await expect(resolveCampaignConflict(db, actor, a._id.toHexString(), contact.leadId, 'remove')).rejects.toMatchObject({ code: 'campaign_busy' });
  });
  it('deduplicates concurrent research saves, protects manual values, and freezes enrollment snapshots', async () => {
    const table = await createTable(db, actor, 'Prospects', [column]);
    const row = { email: 'PERSON@example.com', fields: { signal: observed('Hiring') } };
    const results = await Promise.all(Array.from({ length: 3 }, () => upsertRows(db, actor, table._id.toHexString(), [row])));
    expect(results.every(r => r.saved === 1)).toBe(true);
    expect(await researchCols(db).contacts.countDocuments({ space, email: 'person@example.com' })).toBe(1);
    const contact = (await readTable(db, actor, table._id.toHexString())).rows[0];
    await upsertRows(db, actor, table._id.toHexString(), [{ contactId: contact._id.toHexString(), fields: { signal: { value: 'Human reviewed', kind: 'manual' } } }], 'replace', true);
    await upsertRows(db, actor, table._id.toHexString(), [{ ...row, fields: { signal: observed('Overwrite') } }], 'replace');
    expect((await readTable(db, actor, table._id.toHexString())).rows[0].fields.signal.value).toBe('Human reviewed');
    const cp = await fixture();
    expect((await enrollContacts(db, actor, cp._id.toHexString(), [contact._id.toHexString(), contact._id.toHexString()])).enrolled).toBe(1);
    expect((await enrollContacts(db, actor, cp._id.toHexString(), [contact._id.toHexString()])).results[0].status).toBe('already_enrolled');
    await upsertRows(db, actor, table._id.toHexString(), [{ contactId: contact._id.toHexString(), fields: { signal: { value: 'Changed later', kind: 'manual' } } }], 'replace', true);
    expect((await cols(db).leads.findOne({ campaignId: cp._id }))?.vars.signal).toBe('Human reviewed');
  });
  it('rejects identity collisions, unsourced observations and cross-workspace access', async () => {
    const table = await createTable(db, actor, 'Identity checks', [column]);
    await upsertRows(db, actor, table._id.toHexString(), [{ email: 'a@example.com', profileUrl: 'https://example.com/a' }, { email: 'b@example.com', profileUrl: 'https://example.com/b' }]);
    const collision = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'a@example.com', profileUrl: 'https://example.com/b' }]);
    expect(collision.results[0].status).toBe('identity_conflict');
    const noSource = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'c@example.com', fields: { signal: { value: 'Invented', kind: 'observed' } } }]);
    expect(noSource.results[0].status).toBe('evidence_required');
    await expect(readTable(db, { userId: new ObjectId(), space: 'org:other' }, table._id.toHexString())).rejects.toMatchObject({ code: 'not_found' });
  });
  it('revives paused slots without creating duplicates and blocks edits while active or in flight', async () => {
    const cp = await fixture(), table = await createTable(db, actor, 'Pause test', [column]);
    const r = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'pause@example.com' }]);
    await enrollContacts(db, actor, cp._id.toHexString(), [r.results[0].contactId!]);
    await startCampaign(db, actor, cp._id.toHexString());
    await expect(updateCampaign(db, actor, cp._id.toHexString(), { name: 'No' })).rejects.toMatchObject({ code: 'campaign_busy' });
    const now = new Date(); now.setUTCHours(10, 0, 0, 0);
    expect((await planCampaign(db, cp, now)).planned).toBe(1);
    const original = await cols(db).sends.findOne({ campaignId: cp._id });
    expect((await pauseCampaign(db, actor, cp._id.toHexString())).safeToEdit).toBe(true);
    await startCampaign(db, actor, cp._id.toHexString());
    expect((await planCampaign(db, cp, now)).planned).toBe(1);
    expect(await cols(db).sends.countDocuments({ campaignId: cp._id })).toBe(1);
    expect((await cols(db).sends.findOne({ campaignId: cp._id }))?._id.equals(original!._id)).toBe(true);
    await cols(db).sends.updateOne({ _id: original!._id }, { $set: { status: 'claimed' } });
    expect((await pauseCampaign(db, actor, cp._id.toHexString())).safeToEdit).toBe(false);
    await expect(updateCampaign(db, actor, cp._id.toHexString(), { name: 'No' })).rejects.toMatchObject({ code: 'send_in_flight' });
    await expect(startCampaign(db, actor, cp._id.toHexString())).rejects.toMatchObject({ code: 'not_ready' });
  });
  it('blocks suppression and concurrent outreach; retry receipts cannot restart a paused campaign', async () => {
    const table = await createTable(db, actor, 'Suppression', [column]);
    const r = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'blocked@example.com' }, { email: 'active@example.com' }]);
    await cols(db).suppressions.insertOne({ _id: new ObjectId(), space, email: 'blocked@example.com', reason: 'test', at: new Date() });
    const a = await fixture(), b = await fixture();
    const ids = r.results.map(r => r.contactId!);
    const enrolled = await enrollContacts(db, actor, a._id.toHexString(), ids);
    expect(enrolled.results[0].status).toBe('suppressed');
    const request = 'start-test-retry';
    await command(db, actor, request, 'start', { id: a._id }, () => startCampaign(db, actor, a._id.toHexString()));
    expect((await enrollContacts(db, actor, b._id.toHexString(), [ids[1]])).results[0].status).toBe('another_active_campaign');
    await pauseCampaign(db, actor, a._id.toHexString());
    await command(db, actor, request, 'start', { id: a._id }, () => startCampaign(db, actor, a._id.toHexString()));
    expect((await cols(db).campaigns.findOne({ _id: a._id }))?.status).toBe('paused');
    await expect(command(db, actor, request, 'start', { id: b._id }, async () => ({}))).rejects.toMatchObject({ code: 'request_conflict' });
  });
  it('filters every statistics total to the requested UTC date range', async () => {
    const cp = await fixture();
    await cols(db).dailyStats.insertMany(['2026-01-01', '2026-02-01'].map(day => ({ _id: new ObjectId(), space, campaignId: cp._id, accountId: cp.accountIds[0], stepIndex: 0, day, sent: 7, opens: 1, uniqueOpens: 1, replies: 1, bounces: 0, ooo: 0, unsubscribes: 0 })));
    const stats = await campaignStats(db, actor, cp._id.toHexString(), '2026-02-01', '2026-02-01');
    expect(stats.totals.sent).toBe(7); expect(stats.byStep[0].sent).toBe(7); expect(stats.byMailbox[0].sent).toBe(7);
  });
});

async function authorization(scopes = ['campaigns:read', 'research:read', 'research:write', 'offline_access']) {
  const client = await registerClient(db, { client_name: 'Test client', redirect_uris: ['http://localhost:9876/callback'] });
  const grantId = randomToken();
  await db.collection('oauthGrants').insertOne({ _id: grantId as any, userId: userId.toHexString(), space, scope: scopes, clientId: client.client_id });
  const pair = pkcePair();
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope: scopes.join(' '), resource: `${origin}/mcp`, code_challenge: pair.challenge, code_challenge_method: 'S256', state: 'random-state' });
  await validateAuthorization(db, params, origin);
  const response = new OAuth2Server.Response();
  const code = await oauthServer(db, origin, true).authorize(new OAuth2Server.Request({ method: 'GET', query: Object.fromEntries(params), headers: {} }), response, { authenticateHandler: { handle: async () => ({ id: userId.toHexString(), grantId }) } });
  return { client, pair, code, grantId, params };
}
async function exchange(body: Record<string, string>) {
  const response = new OAuth2Server.Response();
  await oauthServer(db, origin).token(new OAuth2Server.Request({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '100' }, query: {}, body }), response);
  return response.body;
}
describe('OAuth and MCP interoperability', () => {
  it('completes PKCE, rejects replay, rotates refresh tokens and immediately revokes access', async () => {
    const { client, pair, code, grantId } = await authorization();
    const body = { client_id: client.client_id, grant_type: 'authorization_code', code: code.authorizationCode, redirect_uri: client.redirect_uris[0], code_verifier: pair.verifier };
    const tokens = await exchange(body);
    expect(tokens.access_token).toBeTruthy(); expect(tokens.refresh_token).toBeTruthy();
    const request = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect((await authenticateMcp(db, request, origin))?.space).toBe(space);
    expect(await db.collection('oauthTokens').findOne({ _id: tokens.access_token })).toBeNull();
    await expect(exchange(body)).rejects.toThrow();
    const refreshed = await exchange({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    await expect(exchange({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token })).rejects.toThrow();
    await db.collection('oauthGrants').updateOne({ _id: grantId as any }, { $set: { revokedAt: new Date() } });
    expect(await authenticateMcp(db, request, origin)).toBeNull();
    await expect(exchange({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: refreshed.refresh_token })).rejects.toThrow();
  });
  it('rejects bad PKCE, wrong redirect/resource, and scope escalation', async () => {
    const { client, pair, code, params } = await authorization();
    params.set('resource', 'https://other.example/mcp');
    await expect(validateAuthorization(db, params, origin)).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(exchange({ client_id: client.client_id, grant_type: 'authorization_code', code: code.authorizationCode, redirect_uri: client.redirect_uris[0], code_verifier: 'x'.repeat(43) })).rejects.toThrow();
    await expect(exchange({ client_id: client.client_id, grant_type: 'authorization_code', code: code.authorizationCode, redirect_uri: client.redirect_uris[0], code_verifier: pair.verifier })).rejects.toThrow();
    const auth = await authorization(['campaigns:read', 'offline_access']);
    const tokens = await exchange({ client_id: auth.client.client_id, grant_type: 'authorization_code', code: auth.code.authorizationCode, redirect_uri: auth.client.redirect_uris[0], code_verifier: auth.pair.verifier });
    await expect(exchange({ client_id: auth.client.client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: 'campaigns:send' })).rejects.toThrow();
  });
  it('removes access when organization membership is removed', async () => {
    const orgId = new ObjectId(), grantId = randomToken();
    await cols(db).orgs.insertOne({ _id: orgId, name: 'Team', members: [{ userId, role: 'member', addedAt: new Date() }], createdAt: new Date() });
    await db.collection('oauthGrants').insertOne({ _id: grantId as any, userId: userId.toHexString(), space: `org:${orgId}`, scope: ['campaigns:read'] });
    expect(await actorForGrant(db, grantId)).not.toBeNull();
    await cols(db).orgs.updateOne({ _id: orgId }, { $set: { members: [] } });
    expect(await actorForGrant(db, grantId)).toBeNull();
  });
  it('a real MCP client discovers scoped tools, creates a table and retries without duplicating it', async () => {
    const server = createMcpServer(db, { ...actor, scopes: ['research:read', 'research:write'] });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.some(t => t.name === 'research_upsert')).toBe(true);
    expect(tools.tools.some(t => t.name === 'campaign_start')).toBe(false);
    const args = { requestId: 'mcp-create-table', name: 'MCP research', columns: [column] };
    const a = await client.callTool({ name: 'research_create', arguments: args });
    const b = await client.callTool({ name: 'research_create', arguments: args });
    expect(a.isError).not.toBe(true); expect(b.structuredContent).toEqual(a.structuredContent);
    expect(await researchCols(db).tables.countDocuments({ name: 'MCP research' })).toBe(1);
    await client.close(); await server.close();
  });
  it('serves Streamable HTTP initialization with the official transport', async () => {
    const response = await handleMcp(db, { ...actor, scopes: ['research:read'] }, new Request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.serverInfo.name).toBe('hedwig');
  });
});

describe('additional authorization and edit boundaries', () => {
  it('serializes simultaneous activation of drafts sharing a contact', async () => {
    const table = await createTable(db, actor, 'Concurrent campaigns', [column]);
    const rows = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'race@example.com' }]);
    const a = await fixture(), b = await fixture();
    await enrollContacts(db, actor, a._id.toHexString(), [rows.results[0].contactId!]);
    await enrollContacts(db, actor, b._id.toHexString(), [rows.results[0].contactId!]);
    const results = await Promise.allSettled([startCampaign(db, actor, a._id.toHexString()), startCampaign(db, actor, b._id.toHexString())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await cols(db).campaigns.countDocuments({ _id: { $in: [a._id, b._id] }, status: 'active' })).toBe(1);
  });
  it('keeps editing blocked if a stop action changes a live send status to cancelled', async () => {
    const cp = await fixture();
    await cols(db).sends.insertOne({ _id: new ObjectId(), space, campaignId: cp._id, leadId: new ObjectId(), stepIndex: 0, accountId: cp.accountIds[0], dueAt: new Date(), status: 'cancelled', inFlight: true, attempt: 1, tokens: { open: randomToken(), unsub: randomToken() }, createdAt: new Date() });
    expect((await pauseCampaign(db, actor, cp._id.toHexString())).safeToEdit).toBe(false);
    await expect(updateCampaign(db, actor, cp._id.toHexString(), { steps: [{ subject: 'changed', body: 'changed', delayDays: 0 }] })).rejects.toMatchObject({ code: 'send_in_flight' });
  });
  it('rejects confidential-client tokens without the client secret', async () => {
    const registered = await registerClient(db, { client_name: 'Confidential', redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'client_secret_post' });
    const server = oauthServer(db, origin), model = server.options.model as any;
    expect(await model.getClient(registered.client_id)).toBe(false);
    expect(await model.getClient(registered.client_id, 'wrong')).toBe(false);
    expect((await model.getClient(registered.client_id, registered.client_secret)).id).toBe(registered.client_id);
  });
  it('checks token expiry and resource audience on every request', async () => {
    const auth = await authorization();
    const tokens = await exchange({ client_id: auth.client.client_id, grant_type: 'authorization_code', code: auth.code.authorizationCode, redirect_uri: auth.client.redirect_uris[0], code_verifier: auth.pair.verifier });
    const request = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(await authenticateMcp(db, request, 'https://other.example')).toBeNull();
    await db.collection('oauthTokens').updateOne({ _id: sha256(tokens.access_token) as any }, { $set: { accessTokenExpiresAt: new Date(0) } });
    expect(await authenticateMcp(db, request, origin)).toBeNull();
  });
});


describe('saved CSV lists', () => {
  it('deduplicates imports, preserves values and enrolls a saved list without duplicating recipients', async () => {
    const email = `${new ObjectId()}@example.com`;
    const rows = [{ Email: email.toUpperCase(), Name: 'Original' }, { Email: email, Name: 'Duplicate' }, { Email: 'invalid', Name: 'Invalid' }];
    const first = await importList(db, actor, 'CSV list', rows, 'Email', [{ header: 'Name', variable: 'csvName' }]);
    expect(first).toMatchObject({ saved: 1, duplicates: 1, invalid: 1, conflicts: 0 });
    const second = await importList(db, actor, 'Another list', [{ Email: email, Name: 'Replacement' }], 'Email', [{ header: 'Name', variable: 'csvName' }]);
    const contacts = await researchCols(db).contacts.find({ space, email }).toArray();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].fields.csvName.value).toBe('Original');
    expect(contacts[0].tableIds).toHaveLength(2);
    const cp = await fixture();
    expect((await enrollTable(db, actor, cp._id.toHexString(), first.table._id.toHexString())).enrolled).toBe(1);
    expect((await enrollTable(db, actor, cp._id.toHexString(), second.table._id.toHexString())).enrolled).toBe(0);
    await cols(db).campaigns.updateOne({ _id: cp._id }, { $set: { status: 'active' } });
    await expect(enrollTable(db, actor, cp._id.toHexString(), first.table._id.toHexString())).rejects.toThrow();
    await expect(enrollTable(db, { ...actor, space: 'other' }, cp._id.toHexString(), first.table._id.toHexString())).rejects.toThrow();
  });
  it('deletes lists, keeps contacts shared with another list, and leaves enrolled recipients alone', async () => {
    const email = `${new ObjectId()}@example.com`, mapping = [{ header: 'Name', variable: 'csvName' }];
    const a = await importList(db, actor, 'List A', [{ Email: email, Name: 'A' }], 'Email', mapping);
    const b = await importList(db, actor, 'List B', [{ Email: email, Name: 'B' }], 'Email', mapping);
    const cp = await fixture();
    expect((await enrollTable(db, actor, cp._id.toHexString(), a.table._id.toHexString())).enrolled).toBe(1);
    expect(await deleteTables(db, { ...actor, space: 'other' }, [a.table._id.toHexString()])).toEqual({ deleted: 0, contacts: 0 });
    expect(await researchCols(db).tables.countDocuments({ _id: { $in: [a.table._id, b.table._id] } })).toBe(2);
    expect(await deleteTables(db, actor, [a.table._id.toHexString()])).toEqual({ deleted: 1, contacts: 0 });
    expect((await researchCols(db).contacts.findOne({ space, email }))?.tableIds).toEqual([b.table._id]);
    expect(await deleteTables(db, actor, [b.table._id.toHexString()])).toEqual({ deleted: 1, contacts: 1 });
    expect(await researchCols(db).contacts.findOne({ space, email })).toBeNull();
    expect(await cols(db).leads.countDocuments({ campaignId: cp._id, email })).toBe(1);
    expect(await deleteTables(db, actor, [a.table._id.toHexString(), b.table._id.toHexString()])).toEqual({ deleted: 0, contacts: 0 });
    await expect(deleteTables(db, actor, [])).rejects.toThrow();
  });
  it('removes selected contacts from one list without touching the other list they are in', async () => {
    const shared = `${new ObjectId()}@example.com`, only = `${new ObjectId()}@example.com`, mapping = [{ header: 'Name', variable: 'csvName' }];
    const a = await importList(db, actor, 'List A', [{ Email: shared, Name: 'S' }, { Email: only, Name: 'O' }], 'Email', mapping);
    const b = await importList(db, actor, 'List B', [{ Email: shared, Name: 'S' }], 'Email', mapping);
    const ids = (await researchCols(db).contacts.find({ space, email: { $in: [shared, only] } }).toArray()).map(c => c._id.toHexString());
    await expect(removeFromTable(db, { ...actor, space: 'other' }, a.table._id.toHexString(), ids)).rejects.toThrow();
    expect(await removeFromTable(db, actor, a.table._id.toHexString(), ids)).toEqual({ removed: 2, deleted: 1 });
    expect(await researchCols(db).contacts.findOne({ space, email: only })).toBeNull();
    expect((await researchCols(db).contacts.findOne({ space, email: shared }))?.tableIds).toEqual([b.table._id]);
    expect((await readTable(db, actor, a.table._id.toHexString())).rows).toHaveLength(0);
    expect(await removeFromTable(db, actor, a.table._id.toHexString(), ids)).toEqual({ removed: 0, deleted: 0 });
  });
  it('rejects invalid mappings before creating a list', async () => {
    const before = await researchCols(db).tables.countDocuments({ space });
    await expect(importList(db, actor, 'Invalid', [{ Email: 'new@example.com', A: 'x' }], 'Email', [{ header: 'A', variable: 'email' }])).rejects.toThrow();
    expect(await researchCols(db).tables.countDocuments({ space })).toBe(before);
  });
});
