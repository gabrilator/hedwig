import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDb, cols, ensureIndexes, getDb } from '../../src/lib/server/db';
import { createMcpServer } from '../../src/lib/server/mcp';
import { SCOPES, actorForGrant, registerClient, validateAuthorization } from '../../src/lib/server/mcpAuth';
import { sha256 } from '../../src/lib/server/crypto';
import { acceptInvite, inviteForToken } from '../../src/lib/server/team';
import { newCampaign } from '../../src/lib/server/campaigns';
import { createTable, upsertRows } from '../../src/lib/server/research';
import { pkcePair } from '../../src/lib/server/crypto';
import type { Actor } from '../../src/lib/server/operations';

const { send, connectionTest } = vi.hoisted(() => ({ send: vi.fn(), connectionTest: vi.fn() }));
vi.mock('../../src/lib/server/mail/provider', () => ({ providerFor: () => ({ send, test: connectionTest }) }));
delete process.env.RESEND_API_KEY; // Hedwig's own emails go through the (mocked) mailbox here, never a real service
let db: Db;
const userId = new ObjectId(), space = `user:${userId}`, actor: Actor = { userId, space, scopes: [...SCOPES] };
const closers: (() => Promise<void>)[] = [];
async function connect(as: Actor = actor) {
  const server = createMcpServer(db, as), client = new Client({ name: 'Control test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  closers.push(async () => { await client.close(); await server.close(); }); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse((result.content as { text: string }[])[0].text);
  return { ...body, isError: !!result.isError };
}
async function fixture(scope = space) {
  const cp = { _id: new ObjectId(), ...newCampaign(scope, userId, 'Sequence', 'owner@example.com', 'UTC') }, accountId = new ObjectId(), leadId = new ObjectId();
  cp.steps = [{ subject: 'Hello {{firstName}}', body: '<p>Hello {{firstName}}</p>', delayDays: 0 }, { subject: null, body: 'Following up {{firstName}}', delayDays: 2 }]; cp.accountIds = [accountId];
  cp.schedule = { timezone: 'UTC', from: '00:00', to: '23:59', days: [0,1,2,3,4,5,6] };
  await cols(db).emailAccounts.insertOne({ _id: accountId, space: scope, ownerUserId: userId, address: `${accountId}@example.com`, fromName: 'Sender', kind: 'imapSmtp', status: 'active', dailyLimit: 30, ramp: { enabled: false, startedAt: new Date() }, secrets: 'do-not-expose', sync: { deltaLink: 'secret-cursor' }, createdAt: new Date() });
  await cols(db).campaigns.insertOne(cp);
  await cols(db).leads.insertOne({ _id: leadId, space: scope, campaignId: cp._id, email: `${leadId}@example.com`, domain: 'example.com', vars: { firstName: 'Alex' }, status: 'queued', currentStep: 0, provider: 'unknown', createdAt: new Date() });
  await cols(db).heartbeat.updateOne({ _id: 'worker' }, { $set: { at: new Date(), version: 'test', pid: 0, host: 'test' } }, { upsert: true });
  return { cp, accountId, leadId, campaignId: cp._id.toHexString() };
}
beforeAll(async () => { db = await getDb(); await db.dropDatabase(); await ensureIndexes(db); await cols(db).users.insertOne({ _id: userId, email: 'owner@example.com', name: 'Owner', passwordHash: 'private-hash', createdAt: new Date() }); });
beforeEach(() => { send.mockReset(); send.mockImplementation(async (_mail, _thread, prepared) => { const ids = { internetMessageId: `<${new ObjectId()}@example.com>`, conversationId: 'test-conversation' }; await prepared?.(ids); return ids; }); connectionTest.mockReset(); connectionTest.mockResolvedValue({ ok: true, detail: 'Connected' }); });
afterAll(async () => { for (const close of closers) await close(); await db.dropDatabase(); await closeDb(); });

describe('MCP control workflow', () => {
  it('publishes the workflow and full tool surface while read-only grants hide mutations', async () => {
    const client = await connect(), names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['campaign_preview','campaign_test','mailbox_update','inbox_reply','workspace_delete','workspace_list','workspace_switch','workspace_stats','feed_create','lead_update','research_edit_cells']));
    expect(names).not.toContain('agent_get'); expect(names).not.toContain('agent_update'); // agents are for admins only
    expect(client.getInstructions()).toContain('Default workflow');
    const limited = await connect({ ...actor, scopes: ['campaigns:read'] });
    const tools = (await limited.listTools()).tools.map(t => t.name);
    expect(tools).toContain('campaign_preview'); expect(tools).not.toContain('campaign_test'); expect(tools).not.toContain('mailbox_update');
    expect((await limited.callTool({ name: 'campaign_test', arguments: {} })).isError).toBe(true);
    expect((await call(limited, 'workflow_get')).missingPermissions).toContain('inbox:send');
  });
  it('defaults new authorization to full permissions without expanding explicit scopes', async () => {
    const registered = await registerClient(db, { client_name: 'Test', redirect_uris: ['http://localhost:9876/callback'] }), pkce = pkcePair();
    const params = new URLSearchParams({ client_id: registered.client_id, redirect_uri: registered.redirect_uris[0], response_type: 'code', resource: 'http://localhost:5180/mcp', code_challenge: pkce.challenge, code_challenge_method: 'S256' });
    expect((await validateAuthorization(db, params, 'http://localhost:5180')).scope).toEqual(SCOPES);
    params.set('scope', 'campaigns:read'); expect((await validateAuthorization(db, params, 'http://localhost:5180')).scope).toEqual(['campaigns:read']);
  });
  it('reads back saved settings and personalized numbered follow-ups without sending', async () => {
    const client = await connect(), f = await fixture();
    const r = await call(client, 'campaign_update', { requestId: 'readback-update', campaignId: f.campaignId, patch: { testRecipient: 'test@example.com', agentOff: true, dailyLimit: 12 } });
    expect(r.isError).toBe(false); expect(r.campaign.testRecipient).toBe('test@example.com'); expect(r.safeToEdit).toBe(true);
    expect(r.preview.steps[1]).toMatchObject({ step: 2, subject: 'Re: Hello Alex', delayDays: 2 });
    expect(r.mailboxes[0].address).toContain('@example.com'); expect(send).not.toHaveBeenCalled();
  });
  it('launches and pauses with fresh configuration; retrying launch never resumes a later pause', async () => {
    const client = await connect(), f = await fixture(), a = { requestId: 'launch-once', campaignId: f.campaignId };
    const launched = await call(client, 'campaign_start', a); expect(launched.campaign.status).toBe('active'); expect(launched.safeToEdit).toBe(false);
    expect((await call(client, 'campaign_update', { requestId: 'active-edit', campaignId: f.campaignId, patch: { dailyLimit: 99 } })).code).toBe('campaign_busy');
    await call(client, 'campaign_pause', { requestId: 'pause-after-launch', campaignId: f.campaignId }); await call(client, 'campaign_start', a);
    expect((await call(client, 'campaign_get', { campaignId: f.campaignId })).campaign.status).toBe('paused');
  });
  it('tests an entire sequence once, threads only test messages and leaves lead progress unchanged', async () => {
    const client = await connect(), f = await fixture(), a = { requestId: 'test-whole-sequence', campaignId: f.campaignId, accountId: f.accountId.toHexString(), to: 'test@example.com', leadId: f.leadId.toHexString() };
    const r = await call(client, 'campaign_test', a); expect(r.complete).toBe(true); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].to).toBe('test@example.com'); expect(send.mock.calls[0][1]).toBeUndefined();
    expect(send.mock.calls[1][1].internetMessageId).toBe(r.results[0].internetMessageId);
    expect((await cols(db).leads.findOne({ _id: f.leadId }))?.currentStep).toBe(0);
    expect((await call(client, 'campaign_test', a)).results).toEqual(r.results); expect(send).toHaveBeenCalledTimes(2);
    expect((await call(client, 'campaign_test_log', { campaignId: f.campaignId })).rows).toHaveLength(2);
    expect((await call(client, 'campaign_get', { campaignId: f.campaignId })).campaign.status).toBe('draft');
  });
  it('records partial tests and never repeats a provider-uncertain attempt on retry', async () => {
    const client = await connect(), f = await fixture(), a = { requestId: 'partial-sequence', campaignId: f.campaignId, accountId: f.accountId.toHexString(), to: 'test@example.com' };
    send.mockImplementationOnce(async () => ({ internetMessageId: '<first@example.com>' })).mockRejectedValueOnce(new Error('provider disconnected'));
    const result = await call(client, 'campaign_test', a); expect(result.complete).toBe(false); expect(result.results.map((r: any) => r.status)).toEqual(['sent', 'uncertain']);
    await call(client, 'campaign_test', a); expect(send).toHaveBeenCalledTimes(2);
    expect((await call(client, 'campaign_test_log', { campaignId: f.campaignId })).rows.map((r: any) => r.status)).toEqual(['sent','failed']);
  });
  it('rejects missing variables, nonexistent steps, paused or foreign mailboxes before any test send', async () => {
    const client = await connect(), f = await fixture(), foreign = await fixture('user:other'), base = { campaignId: f.campaignId, accountId: f.accountId.toHexString(), to: 'test@example.com' };
    expect((await call(client, 'campaign_test', { ...base, requestId: 'bad-step-test', step: 12 })).code).toBe('invalid_input');
    expect((await call(client, 'campaign_test', { ...base, requestId: 'foreign-test', accountId: foreign.accountId.toHexString() })).code).toBe('not_found');
    await cols(db).leads.updateOne({ _id: f.leadId }, { $set: { vars: {} } });
    expect((await call(client, 'campaign_test', { ...base, requestId: 'missing-test' })).code).toBe('missing_variables');
    await cols(db).emailAccounts.updateOne({ _id: f.accountId }, { $set: { status: 'paused' } });
    expect((await call(client, 'campaign_test', { ...base, requestId: 'paused-test' })).code).toBe('not_found'); expect(send).not.toHaveBeenCalled();
  });
  it('scopes reads and writes to the grant workspace', async () => {
    const client = await connect(), foreign = await fixture('user:foreign');
    for (const [name,args] of [ ['campaign_preview',{ campaignId: foreign.campaignId }], ['mailbox_get',{ accountId: foreign.accountId.toHexString() }], ['inbox_get',{ leadId: foreign.leadId.toHexString() }], ['lead_update',{ requestId: 'foreign-lead-update', leadId: foreign.leadId.toHexString(), vars: { firstName: 'Wrong' } }] ] as const) expect((await call(client,name,args)).code).toBe('not_found');
  });
  it('returns mailbox settings without secrets and allows mailbox-only discovery/receipts', async () => {
    const client = await connect({ ...actor, scopes: ['mailboxes:read','mailboxes:write'] }), f = await fixture();
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['mailbox_list', 'operation_get']));
    const r = await call(client, 'mailbox_update', { requestId: 'mailbox-settings', accountId: f.accountId.toHexString(), patch: { fromName: 'New sender', dailyLimit: 15, timezone: 'America/Toronto', rampEnabled: true, status: 'paused' } });
    expect(r.mailbox).toMatchObject({ fromName: 'New sender', dailyLimit: 15, status: 'paused', ramp: { enabled: true } });
    expect(JSON.stringify(r)).not.toContain('do-not-expose'); expect(JSON.stringify(r)).not.toContain('secret-cursor');
    expect((await call(client,'operation_get',{ requestId: 'mailbox-settings' })).receipt.status).toBe('done');
  });
  it('edits protected lead variables only through explicit correction and blocks edits while sending', async () => {
    const client = await connect(), f = await fixture();
    const r = await call(client, 'lead_update', { requestId: 'lead-correction', leadId: f.leadId.toHexString(), vars: { firstName: 'Sam' }, curious: true });
    expect(r.lead.vars.firstName).toBe('Sam'); expect(r.lead.fieldEvidence.firstName.kind).toBe('manual');
    await cols(db).campaigns.updateOne({ _id: f.cp._id }, { $set: { status: 'active' } });
    expect((await call(client, 'lead_update', { requestId: 'lead-active-correction', leadId: f.leadId.toHexString(), vars: { firstName: 'No' } })).code).toBe('campaign_busy');
    expect((await call(client, 'lead_update', { requestId: 'lead-opt-out', leadId: f.leadId.toHexString(), status: 'unsubscribed' })).isError).toBe(false);
    expect(await cols(db).suppressions.findOne({ space, email: r.lead.email })).not.toBeNull();
  });
  it('gives the reply agent tools to admins only; old custom-agent fields are refused', async () => {
    const admin = await connect({ ...actor, admin: true }), f = await fixture();
    expect((await admin.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['agent_get', 'agent_update']));
    const before = await call(admin, 'agent_get');
    expect(before.agent).toMatchObject({ name: 'Triage', active: true }); expect(before.jev).toMatchObject({ cap: expect.any(Number) });
    expect((await call(admin, 'agent_update', { requestId: 'agent-off', active: false, name: 'Reply reader' })).agent).toMatchObject({ name: 'Reply reader', active: false });
    expect((await call(admin, 'campaign_get', { campaignId: f.campaignId })).agent).toMatchObject({ name: 'Reply reader', active: false });
    const member = await connect();
    expect((await call(member, 'campaign_get', { campaignId: f.campaignId })).agent).toBeUndefined();
    expect((await member.callTool({ name: 'agent_update', arguments: { requestId: 'member-agent', active: true } })).isError).toBe(true);
    expect((await admin.callTool({ name: 'campaign_update', arguments: { requestId: 'legacy-agent-id', campaignId: f.campaignId, patch: { agentId: null } } })).isError).toBe(true);
    expect((await call(admin, 'campaign_update', { requestId: 'agent-off-campaign', campaignId: f.campaignId, patch: { agentOff: true } })).campaign.agentOff).toBe(true);
    await call(admin, 'agent_update', { requestId: 'agent-on-again', active: true, name: 'Triage' });
  });
  it('sends a requested inbox reply once using its original mailbox and keeps provider content out of errors', async () => {
    const client = await connect(), f = await fixture();
    await cols(db).leads.updateOne({ _id: f.leadId }, { $set: { accountId: f.accountId, lastInboundAt: new Date(), inboundUnread: true } });
    await cols(db).messages.insertOne({ _id: new ObjectId(), space, campaignId: f.cp._id, leadId: f.leadId, accountId: f.accountId, direction: 'in', kind: 'reply', from: 'recipient@example.com', to: 'sender@example.com', subject: 'Question', text: 'Can you explain?', internetMessageId: '<inbound@example.com>', at: new Date() });
    const args = { requestId: 'reply-exactly-once', leadId: f.leadId.toHexString(), body: 'Here are the details.' };
    const r = await call(client,'inbox_reply',args); expect(r.sent).toBe(true); expect(send.mock.calls[0][1].internetMessageId).toBe('<inbound@example.com>');
    await call(client,'inbox_reply',args); expect(send).toHaveBeenCalledTimes(1);
    expect((await call(client,'inbox_get',{ leadId: f.leadId.toHexString(), limit: 1 })).nextCursor).toBeTruthy();
    await call(client,'inbox_update',{ requestId: 'read-thread', leadId: f.leadId.toHexString(), action: 'read' });
    expect((await cols(db).leads.findOne({ _id: f.leadId }))?.inboundUnread).toBe(false);
  });
  it('applies explicit research corrections while automatic enrichment still protects them', async () => {
    const client = await connect(), table = await createTable(db, actor, 'Contacts', [{ key: 'name', label: 'Name', type: 'text' }]);
    const rows = await upsertRows(db, actor, table._id.toHexString(), [{ email: 'research@example.com', fields: { name: { value: 'Original', kind: 'manual' } } }], 'replace', true);
    const contactId = rows.results[0].contactId;
    expect((await call(client,'research_edit_cells',{ requestId: 'manual-correction', tableId: table._id.toHexString(), contactId, values: { name: 'Corrected' } })).saved).toBe(1);
    await upsertRows(db, actor, table._id.toHexString(), [{ contactId, fields: { name: { value: 'Automatic', kind: 'inferred' } } }], 'replace');
    const read = await call(client,'research_get',{ tableId: table._id.toHexString() }); expect(read.rows[0].fields.name.value).toBe('Corrected');
  });
  it('requires workspace ownership and preserves the last owner', async () => {
    const orgId = new ObjectId(), member = new ObjectId(); await cols(db).orgs.insertOne({ _id: orgId, name: 'Team', members: [{ userId, role: 'owner', addedAt: new Date() },{ userId: member, role: 'member', addedAt: new Date() }], createdAt: new Date() });
    const ownerClient = await connect({ ...actor, space: `org:${orgId}` }), memberClient = await connect({ ...actor, userId: member, space: `org:${orgId}` });
    expect((await call(memberClient,'workspace_rename',{ requestId: 'member-rename', name: 'No' })).code).toBe('forbidden');
    expect((await call(ownerClient,'team_update',{ requestId: 'last-owner-leave', action: 'remove', memberId: userId.toHexString() })).code).toBe('last_owner');
    expect((await call(ownerClient,'workspace_delete',{ requestId: 'wrong-name-delete', confirmName: 'Wrong' })).code).toBe('invalid_input');
    expect((await call(ownerClient,'workspace_rename',{ requestId: 'owner-rename', name: 'Renamed' })).name).toBe('Renamed');
  });
  it('blocks destructive controls during sends and preserves other workspace data', async () => {
    const client = await connect(), f = await fixture(), other = await fixture('user:untouched');
    expect((await call(client, 'mailbox_delete', { requestId: 'delete-assigned-mailbox', accountId: f.accountId.toHexString(), confirmAddress: `${f.accountId}@example.com` })).code).toBe('in_use');
    const messageId = new ObjectId(); await cols(db).messages.insertOne({ _id: messageId, space, campaignId: f.cp._id, accountId: f.accountId, direction: 'out', kind: 'test', status: 'sending', from: 'sender@example.com', to: 'test@example.com', subject: 'Test', text: 'Test', at: new Date() });
    expect((await call(client, 'campaign_delete', { requestId: 'delete-inflight-campaign', campaignId: f.campaignId, confirmName: f.cp.name })).code).toBe('send_in_flight');
    await cols(db).messages.updateOne({ _id: messageId }, { $set: { status: 'sent' } });
    expect((await call(client, 'campaign_delete', { requestId: 'delete-settled-campaign', campaignId: f.campaignId, confirmName: f.cp.name })).deleted).toBe(true);
    expect(await cols(db).campaigns.findOne({ _id: other.cp._id })).not.toBeNull();
    expect((await call(client, 'mailbox_delete', { requestId: 'delete-free-mailbox', accountId: f.accountId.toHexString(), confirmAddress: `${f.accountId}@example.com` })).deleted).toBe(true);
  });
  it('is one connection per account: it lists and switches between the account\'s workspaces, and loses a team the moment membership ends', async () => {
    const orgId = new ObjectId(), grantId = `grant-${new ObjectId()}`;
    await cols(db).orgs.insertOne({ _id: orgId, name: 'Switch Team', members: [{ userId, role: 'member', addedAt: new Date() }], createdAt: new Date() });
    await db.collection('oauthGrants').insertOne({ _id: grantId as any, userId: userId.toHexString(), space, scope: [...SCOPES], clientId: 'test', createdAt: new Date() });
    const first = (await actorForGrant(db, grantId))!; expect(first.space).toBe(space);
    const client = await connect(first);
    const list = await call(client, 'workspace_list');
    const byName = (n: string) => list.workspaces.find((w: any) => w.name === n);
    expect(byName('Switch Team')).toMatchObject({ workspace: `org:${orgId}`, role: 'member', current: false });
    expect(byName('Personal')).toMatchObject({ workspace: space, current: true });
    expect((await call(client, 'workspace_switch', { workspace: 'org:' + new ObjectId() })).code).toBe('not_found');
    expect((await call(client, 'workspace_switch', { workspace: 'switch team' })).current).toBe(`org:${orgId}`);
    const moved = (await actorForGrant(db, grantId))!; expect(moved.space).toBe(`org:${orgId}`);
    const inTeam = await connect(moved), teamCampaign = await fixture(`org:${orgId}`);
    expect((await call(inTeam, 'campaign_get', { campaignId: teamCampaign.campaignId })).campaign.name).toBe('Sequence');
    expect((await call(inTeam, 'connection_list')).connections.find((x: any) => x._id === grantId)).toMatchObject({ workspace: 'Switch Team', thisConnection: true });
    // removed from the team: the connection stays, back in Personal, and the team's data is out of reach
    await cols(db).orgs.updateOne({ _id: orgId }, { $set: { members: [] } });
    const after = (await actorForGrant(db, grantId))!; expect(after.space).toBe(space);
    expect((await call(await connect(after), 'campaign_get', { campaignId: teamCampaign.campaignId })).code).toBe('not_found');
  });
  it('invites by emailed link from the team\'s own mailbox; nobody joins without the link, and only as the invited address', async () => {
    const orgId = new ObjectId(), orgSpaceKey = `org:${orgId}`;
    await cols(db).orgs.insertOne({ _id: orgId, name: 'Invite Team', members: [{ userId, role: 'owner', addedAt: new Date() }], createdAt: new Date() });
    const personalBox = await fixture(); void personalBox; // a mailbox in the inviter's Personal space must not be used
    const teamBox = await fixture(orgSpaceKey);
    const existing = new ObjectId(); await cols(db).users.insertOne({ _id: existing, email: 'colleague@example.com', name: 'Colleague', passwordHash: 'x', createdAt: new Date() });
    const owner = await connect({ ...actor, space: orgSpaceKey });
    const r = await call(owner, 'team_invite', { requestId: 'invite-colleague', email: 'Colleague@Example.com' });
    expect(r).toMatchObject({ email: 'colleague@example.com', org: 'Invite Team', emailed: true, via: `${teamBox.accountId}@example.com` });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0]; expect(mail.to).toBe('colleague@example.com'); expect(mail.subject).toContain('Invite Team');
    const token = mail.text.match(/\/join\/([A-Za-z0-9_-]+)/)![1];
    // inviting never adds anyone, not even an existing account
    expect((await cols(db).orgs.findOne({ _id: orgId }))!.members.map(m => String(m.userId))).toEqual([String(userId)]);
    expect((await cols(db).invites.findOne({ orgId }))?.tokenHash).toBe(sha256(token));
    expect((await inviteForToken(db, token)).ok).toBe(true);
    // a different account holding the link cannot use it
    expect(await acceptInvite(db, token, { _id: new ObjectId(), email: 'someone-else@example.com' })).toMatchObject({ ok: false, reason: expect.stringContaining('colleague@example.com') });
    // the invited address joins this team, as a member, once
    const joined = await acceptInvite(db, token, { _id: existing, email: 'colleague@example.com' });
    expect(joined.ok && String(joined.org._id)).toBe(String(orgId));
    expect((await cols(db).orgs.findOne({ _id: orgId }))!.members.find(m => m.userId.equals(existing))?.role).toBe('member');
    expect((await acceptInvite(db, token, { _id: existing, email: 'colleague@example.com' })).ok).toBe(false);
    expect(await cols(db).orgs.countDocuments({ 'members.userId': existing })).toBe(1);
    expect((await call(owner, 'team_invite', { requestId: 'invite-member-again', email: 'colleague@example.com' })).alreadyMember).toBe(true);
    // a re-invite voids the previous link; a cancelled invite's link stops working
    await call(owner, 'team_invite', { requestId: 'invite-new-1', email: 'new@example.com' });
    const firstLink = send.mock.calls.at(-1)![0].text.match(/\/join\/([A-Za-z0-9_-]+)/)![1];
    await call(owner, 'team_invite', { requestId: 'invite-new-2', email: 'new@example.com' });
    const secondLink = send.mock.calls.at(-1)![0].text.match(/\/join\/([A-Za-z0-9_-]+)/)![1];
    expect((await inviteForToken(db, firstLink)).ok).toBe(false); expect((await inviteForToken(db, secondLink)).ok).toBe(true);
    const pending = await cols(db).invites.findOne({ orgId, email: 'new@example.com' });
    expect((await call(owner, 'team_update', { requestId: 'cancel-new', action: 'cancel_invite', inviteId: pending!._id.toHexString() })).deleted).toBe(1);
    expect((await inviteForToken(db, secondLink)).ok).toBe(false);
    // a member cannot invite
    expect((await call(await connect({ ...actor, userId: existing, space: orgSpaceKey }), 'team_invite', { requestId: 'member-invite', email: 'x@example.com' })).code).toBe('forbidden');
  });
  it('makes and turns off the results feed link, and reads workspace statistics', async () => {
    const client = await connect();
    expect((await call(client, 'feed_get')).feed).toBeNull();
    const made = await call(client, 'feed_create', { requestId: 'feed-make' });
    expect(made.leadsCsv).toMatch(/\/feed\/[A-Za-z0-9_-]+\/leads\.csv$/);
    expect((await call(client, 'feed_get')).feed).toMatchObject({ createdBy: 'Owner' });
    expect((await call(client, 'feed_revoke', { requestId: 'feed-off' })).revoked).toBe(true);
    const stats = await call(client, 'workspace_stats', { from: '2026-11-01', to: '2026-11-03' });
    expect(stats.daily).toHaveLength(3); expect(stats.totals).toMatchObject({ sent: expect.any(Number) });
    expect((await call(client, 'workspace_stats', { from: '2026-11-03', to: '2026-11-01' })).code).toBe('invalid_input');
  });
  it('preserves request receipts for send-only grants', async () => {
    const client = await connect({ ...actor, scopes: ['campaigns:send'] }), f = await fixture();
    const args = { requestId: 'send-only-test', campaignId: f.campaignId, accountId: f.accountId.toHexString(), to: 'test@example.com', step: 1 };
    expect((await call(client,'campaign_test',args)).complete).toBe(true);
    expect((await call(client,'operation_get',{ requestId: args.requestId })).receipt.status).toBe('done');
    const unrelated = await connect({ ...actor, scopes: ['research:read'] });
    expect((await call(unrelated,'operation_get',{ requestId: args.requestId })).code).toBe('forbidden');
  });
  it('stops follow-up scheduling before a reply is handed to the provider', async () => {
    const client = await connect(), f = await fixture();
    await cols(db).messages.insertOne({ _id: new ObjectId(), space, campaignId: f.cp._id, leadId: f.leadId, accountId: f.accountId, direction: 'in', kind: 'reply', from: 'lead@example.com', to: 'sender@example.com', subject: 'Question', text: 'Hello', at: new Date() });
    send.mockImplementationOnce(async () => {
      expect((await cols(db).leads.findOne({ _id: f.leadId }))?.status).toBe('replied');
      return { internetMessageId: '<reply@example.com>' };
    });
    expect((await call(client,'inbox_reply',{ requestId: 'reply-stops-scheduling', leadId: f.leadId.toHexString(), body: 'Thanks' })).sent).toBe(true);
  });
  it('rejects replies while a sequence send is unresolved', async () => {
    const client = await connect(), f = await fixture();
    await cols(db).messages.insertOne({ _id: new ObjectId(), space, campaignId: f.cp._id, leadId: f.leadId, accountId: f.accountId, direction: 'in', kind: 'reply', from: 'lead@example.com', to: 'sender@example.com', subject: 'Question', text: 'Hello', at: new Date() });
    await cols(db).sends.insertOne({ _id: new ObjectId(), space, campaignId: f.cp._id, leadId: f.leadId, accountId: f.accountId, stepIndex: 0, status: 'claimed', dueAt: new Date(), attempt: 0, tokens: { open: 'test', unsub: 'test' }, createdAt: new Date() });
    expect((await call(client,'inbox_reply',{ requestId: 'reply-during-send', leadId: f.leadId.toHexString(), body: 'Thanks' })).code).toBe('send_in_flight'); expect(send).not.toHaveBeenCalled();
  });

  it('requeues a paused follow-up without resetting progress or bypassing suppression', async () => {
    const client = await connect(), f = await fixture();
    await cols(db).leads.updateOne({ _id: f.leadId }, { $set: { status: 'paused', currentStep: 1, nextDueAt: null } });
    const result = await call(client, 'lead_requeue', { requestId: 'requeue-followup', leadId: f.leadId.toHexString() });
    expect(result).toMatchObject({ requeued: true, nextStep: 2, campaignStatus: 'draft' });
    const lead = await cols(db).leads.findOne({ _id: f.leadId }); expect(lead?.currentStep).toBe(1); expect(lead?.nextDueAt).toBeInstanceOf(Date);
    await cols(db).leads.updateOne({ _id: f.leadId }, { $set: { status: 'paused' } });
    await cols(db).suppressions.insertOne({ _id: new ObjectId(), space, email: lead!.email, reason: 'unsubscribed', at: new Date() });
    expect((await call(client, 'lead_requeue', { requestId: 'requeue-suppressed', leadId: f.leadId.toHexString() })).code).toBe('suppressed');
  });

});
