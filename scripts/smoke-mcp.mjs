// Run after npm run build, with a dedicated local mongod. Never starts the sending worker.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
const mongoUri = process.env.MCP_SMOKE_MONGODB_URI || 'mongodb://127.0.0.1:27119';
assert.match(mongoUri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/);
const port = Number(process.env.MCP_SMOKE_PORT || 5182), origin = `http://127.0.0.1:${port}`;
const database = `hedwig_mcp_smoke_${Date.now()}`;
const email = 'smoke@example.com', password = randomBytes(24).toString('hex');
const mongo = new MongoClient(mongoUri); await mongo.connect();
const child = spawn(process.execPath, ['build/index.js'], { env: { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, MONGODB_URI: mongoUri, MONGODB_DB: database, BOOTSTRAP_USER_EMAIL: email, BOOTSTRAP_USER_PASSWORD: password, HEDWIG_MASTER_KEY: randomBytes(32).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
const fetchLocal = (path, options) => fetch(origin + path, { redirect: 'manual', ...options });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetchLocal('/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready, 'Web server did not start');
  const denied = await fetchLocal('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  const metadata = await (await fetchLocal('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer, origin); assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.equal((await (await fetchLocal('/.well-known/oauth-protected-resource/mcp')).json()).resource, `${origin}/mcp`);
  const registrationResponse = await fetchLocal('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Smoke test client', redirect_uris: ['http://localhost:9999/callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(registrationResponse.status, 201);
  const client = await registrationResponse.json();
  const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const scopes = metadata.scopes_supported;
  assert.ok(scopes.includes('inbox:send')); assert.ok(scopes.includes('workspace:write'));
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope: scopes.join(' '), resource: `${origin}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', state: 'smoke-state' });
  const consentPath = `/oauth/authorize?${query}`;
  const unauth = await fetchLocal(consentPath); assert.equal(unauth.status, 303); assert.match(unauth.headers.get('location'), /^\/login\?next=/);
  const login = await fetchLocal(`/login?next=${encodeURIComponent(consentPath)}`, { method: 'POST', headers: { accept: 'text/html', origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  assert.equal(login.status, 303); assert.equal(login.headers.get('location'), consentPath);
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  assert.ok(cookie.includes('hedwig_session='));
  const consent = await fetchLocal(consentPath, { headers: { cookie } }); assert.equal(consent.status, 200);
  assert.notEqual(consent.headers.get('referrer-policy'), 'no-referrer', 'browsers send Origin: null on a form post from a no-referrer page, so the consent form would fail the origin check');
  assert.ok((await consent.text()).includes('Smoke test client'));
  const user = await mongo.db(database).collection('users').findOne({ email });
  const form = new URLSearchParams({ decision: 'allow', space: `user:${user._id}` }); for (const scope of scopes) form.append('scope', scope);
  const csrf = await fetchLocal(consentPath, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: form }); assert.equal(csrf.status, 403);
  const approval = await fetchLocal(consentPath, { method: 'POST', headers: { accept: 'text/html', cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(approval.status, 303, (await approval.text()).slice(0, 500));
  const callback = new URL(approval.headers.get('location')); assert.equal(callback.searchParams.get('state'), 'smoke-state');
  const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: client.redirect_uris[0], resource: `${origin}/mcp` });
  const tokenResponse = await fetchLocal('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenBody });
  assert.equal(tokenResponse.status, 200); const token = await tokenResponse.json(); assert.ok(token.access_token); assert.ok(token.refresh_token);
  let rpcId = 0;
  async function rpc(method, params) {
    const response = await fetchLocal('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    assert.equal(response.status, 200); const message = await response.json(); assert.ok(!message.error, JSON.stringify(message.error)); return message.result;
  }
  assert.equal((await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })).serverInfo.name, 'hedwig');
  const list = await rpc('tools/list', {});
  for (const name of ['campaign_start', 'campaign_test', 'inbox_reply', 'mailbox_update', 'agent_save', 'team_update']) assert.ok(list.tools.some(t => t.name === name), `${name} is discoverable`);
  assert.match((await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })).instructions, /Default workflow/);
  async function call(name, args) { const result = await rpc('tools/call', { name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; }
  const tableArgs = { requestId: 'smoke-table-create', name: 'Hiring prospects', columns: [{ key: 'signal', label: 'Hiring signal', type: 'text' }] };
  const table = await call('research_create', tableArgs); assert.equal((await call('research_create', tableArgs))._id, table._id);
  const rows = await call('research_upsert', { requestId: 'smoke-upsert-rows', tableId: table._id, rows: [{ email: 'contact@example.org', fields: { signal: { value: 'Hiring engineers', kind: 'observed', sources: ['https://example.org/careers'] } } }] }); assert.equal(rows.saved, 1);
  const cp = await call('campaign_create', { requestId: 'smoke-campaign-create', name: 'Research campaign', timezone: 'UTC' });
  const enrollment = await call('campaign_enroll', { requestId: 'smoke-enroll', campaignId: cp.id, contactIds: [rows.results[0].contactId] }); assert.equal(enrollment.enrolled, 1);
  const repeated = await call('campaign_enroll', { requestId: 'smoke-enroll-again', campaignId: cp.id, contactIds: [rows.results[0].contactId] }); assert.equal(repeated.enrolled, 0);
  const blocked = await rpc('tools/call', { name: 'campaign_start', arguments: { requestId: 'smoke-start-blocked', campaignId: cp.id } }); assert.equal(blocked.isError, true);
  // Fake readiness fixtures only: this isolated server never starts a worker or contacts a mail provider.
  const mailboxId = new ObjectId();
  await mongo.db(database).collection('emailAccounts').insertOne({ _id: mailboxId, space: `user:${user._id}`, ownerUserId: user._id, address: 'fake-sender@example.com', fromName: 'Fixture', kind: 'imapSmtp', status: 'active', dailyLimit: 30, ramp: { enabled: false, startedAt: new Date() }, secrets: '', sync: {}, createdAt: new Date() });
  await mongo.db(database).collection('workerHeartbeat').insertOne({ _id: 'worker', at: new Date(), version: 'fixture-no-worker', pid: 0, host: 'test' });
  await call('campaign_update', { requestId: 'smoke-configure', campaignId: cp.id, patch: { accountIds: [mailboxId.toHexString()], steps: [{ subject: 'Hello', body: 'Hello {{signal}}', delayDays: 0 }] } });
  assert.equal((await call('campaign_preview', { campaignId: cp.id })).steps[0].text, 'Hello Hiring engineers');
  assert.equal((await call('mailbox_update', { requestId: 'smoke-mailbox-update', accountId: mailboxId.toHexString(), patch: { fromName: 'Updated fixture' } })).mailbox.fromName, 'Updated fixture');
  assert.equal((await call('campaign_start', { requestId: 'smoke-start-ready', campaignId: cp.id })).status, 'active');
  const webEdit = await fetchLocal(`/campaigns/${cp.id}/sequence?/saveAll`, { method: 'POST', headers: { accept: 'text/html', cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ steps: JSON.stringify([{ subject: 'Unsafe change', body: 'changed', delayDays: 0 }]) }) });
  assert.equal(webEdit.status, 409);
  assert.equal((await call('campaign_pause', { requestId: 'smoke-pause', campaignId: cp.id })).safeToEdit, true);
  // Resume conflicts must name the contact and offer working resolution actions.
  const sourceCampaign = await mongo.db(database).collection('campaigns').findOne({ _id: new ObjectId(cp.id) });
  const sourceLead = await mongo.db(database).collection('leads').findOne({ campaignId: sourceCampaign._id });
  const otherCampaignId = new ObjectId(), otherLeadId = new ObjectId();
  await mongo.db(database).collection('campaigns').insertOne({ ...sourceCampaign, _id: otherCampaignId, name: 'Other active campaign', status: 'active' });
  await mongo.db(database).collection('leads').insertOne({ ...sourceLead, _id: otherLeadId, campaignId: otherCampaignId });
  const conflictPage = await fetchLocal(`/campaigns/${cp.id}/options?/resume`, { method: 'POST', headers: { cookie, origin, accept: 'text/html' }, body: new URLSearchParams() });
  assert.equal(conflictPage.status, 409);
  const conflictHtml = await conflictPage.text();
  assert.ok(conflictHtml.includes(sourceLead.email));
  assert.ok(conflictHtml.includes('Other active campaign'));
  assert.ok(conflictHtml.includes('Keep here · pause elsewhere'));
  assert.ok(conflictHtml.includes('Remove from this campaign'));
  const resolved = await fetchLocal(`/campaigns/${cp.id}/options?/resolveConflict`, { method: 'POST', headers: { cookie, origin, accept: 'text/html' }, body: new URLSearchParams({ lead: sourceLead._id.toHexString(), choice: 'keep' }) });
  assert.equal(resolved.status, 200);
  assert.equal((await mongo.db(database).collection('leads').findOne({ _id: otherLeadId })).status, 'paused');
  assert.equal((await mongo.db(database).collection('campaigns').findOne({ _id: sourceCampaign._id })).status, 'paused');
  const inboxIds = [];
  for (let i = 0; i < 6; i++) {
    const leadId = new ObjectId(), messageId = new ObjectId(); inboxIds.push(leadId);
    await mongo.db(database).collection('leads').insertOne({ ...sourceLead, _id: leadId, email: `inbox-${i}@example.org`, status: 'replied', lastInboundAt: new Date(), lastInbound: { messageId, kind: 'reply', subject: 'Test reply', snippet: 'Hello', at: new Date() } });
    await mongo.db(database).collection('messages').insertMany([
      { _id: messageId, space: sourceLead.space, campaignId: sourceCampaign._id, leadId, direction: 'in', kind: 'reply', from: `inbox-${i}@example.org`, to: 'fake-sender@example.com', subject: 'Test reply', text: 'Hello', at: new Date() },
      { _id: new ObjectId(), space: sourceLead.space, campaignId: sourceCampaign._id, leadId, direction: 'out', kind: 'sent', text: 'Original email', at: new Date() }
    ]);
  }
  const deletedThreads = await fetchLocal('/inbox?/deleteThreads', { method: 'POST', headers: { cookie, origin, accept: 'text/html' }, body: new URLSearchParams(inboxIds.map(id => ['lead', id.toHexString()])) });
  assert.equal(deletedThreads.status, 200);
  assert.ok((await deletedThreads.text()).includes('6 threads removed'));
  assert.equal(await mongo.db(database).collection('messages').countDocuments({ leadId: { $in: inboxIds }, direction: 'in' }), 0);
  assert.equal(await mongo.db(database).collection('messages').countDocuments({ leadId: { $in: inboxIds }, direction: 'out' }), 6);
  assert.equal(await mongo.db(database).collection('leads').countDocuments({ _id: { $in: inboxIds }, status: 'replied', lastInboundAt: { $exists: false } }), 6);
  const leads = await call('campaign_leads', { campaignId: cp.id });
  const enriched = await call('campaign_enrich_leads', { requestId: 'smoke-enrich-enrolled', campaignId: cp.id, rows: [{ leadId: leads.leads[0]._id, fields: { openingLine: { value: 'Your team is growing.', kind: 'inferred', sources: ['https://example.org/careers'] } } }] });
  assert.equal(enriched.results[0].status, 'updated');
  assert.equal((await call('campaign_stats', { campaignId: cp.id, from: '2026-01-01', to: '2026-12-31' })).totals.sent, 0);
  for (const path of ['/setup', '/lists', '/lists/import', `/lists/${table._id}`, `/campaigns/${cp.id}/leads/import`, `/campaigns/${cp.id}/leads`]) { const response = await fetchLocal(path, { headers: { cookie } }); assert.equal(response.status, 200, path); assert.ok(!(await response.text()).includes('Internal Error')); }
  const csv = new FormData(); csv.set('file', new File(['Email,Name\nlist@example.org,List contact\nLIST@example.org,Duplicate\ninvalid,Skip'], 'contacts.csv', { type: 'text/csv' }));
  const upload = await fetchLocal('/lists/import?/upload', { method: 'POST', headers: { cookie, origin, accept: 'text/html' }, body: csv });
  assert.equal(upload.status, 303);
  const uploadLocation = upload.headers.get('location');
  assert.equal((await fetchLocal(uploadLocation, { headers: { cookie } })).status, 200);
  const importId = new URL(uploadLocation, origin).searchParams.get('import');
  const confirm = await fetchLocal('/lists/import?/confirm', { method: 'POST', headers: { cookie, origin, accept: 'text/html' }, body: new URLSearchParams({ import: importId, name: 'Uploaded list', emailColumn: 'Email', keep: 'Name', 'var:Name': 'firstName' }) });
  assert.equal(confirm.status, 303);
  const listLocation = confirm.headers.get('location'), listId = new URL(listLocation, origin).pathname.split('/').at(-1);
  assert.match(decodeURIComponent(listLocation), /1 contacts saved/);
  for (let attempt = 0; attempt < 2; attempt++) {
    const enroll = await fetchLocal(`/campaigns/${cp.id}/leads/import?/list`, { method: 'POST', headers: { cookie, origin, accept: 'text/html' }, body: new URLSearchParams({ listId }) });
    assert.equal(enroll.status, 303);
    assert.match(decodeURIComponent(enroll.headers.get('location')), new RegExp(`${attempt ? 0 : 1} contacts added`));
  }
  assert.equal(await mongo.db(database).collection('leads').countDocuments({ campaignId: new ObjectId(cp.id), email: 'list@example.org' }), 1);
  const revoke = await fetchLocal('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refresh_token }) }); assert.equal(revoke.status, 200);
  const revoked = await fetchLocal('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: '{}' }); assert.equal(revoked.status, 401);
  for (const [oldPath, newPath] of [['/research', '/lists'], ['/connections', '/setup#connections']]) {
    const response = await fetchLocal(oldPath, { headers: { cookie } }); assert.equal(response.status, 303); assert.equal(response.headers.get('location'), newPath);
  }
  const setupHtml = await (await fetchLocal('/setup', { headers: { cookie } })).text();
  // The bootstrap account runs this server and should see worker health; ordinary users should not.
  assert.ok(setupHtml.includes('<h3>Worker</h3>')); assert.ok(!setupHtml.includes('Emails Hedwig sends itself')); assert.ok(setupHtml.includes('Assistant connections'));
  const memberEmail = 'member@example.com';
  await mongo.db(database).collection('users').insertOne({ _id: new ObjectId(), email: memberEmail, name: 'Member', passwordHash: user.passwordHash, createdAt: new Date() });
  const memberLogin = await fetchLocal('/login', { method: 'POST', headers: { accept: 'text/html', origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: memberEmail, password }) });
  assert.equal(memberLogin.status, 303);
  const memberCookie = memberLogin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const memberSetup = await fetchLocal('/setup', { headers: { cookie: memberCookie } }); assert.equal(memberSetup.status, 200);
  assert.ok(!(await memberSetup.text()).includes('<h3>Worker</h3>'));
  console.log('HTTP smoke passed: discovery, login redirect, consent/CSRF, PKCE, scoped tools, research, deduplication, enrollment, readiness, start/pause, active-edit rejection, enrichment, statistics, pages and revocation.');
} catch (e) { console.error(logs); console.error(e); throw e; }
finally { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1000); if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); } else child.once('exit', () => { clearTimeout(timer); resolve(); }); }); await mongo.db(database).dropDatabase(); await mongo.close(); }
