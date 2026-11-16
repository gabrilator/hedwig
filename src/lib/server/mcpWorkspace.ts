import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { cols } from './db';
import { objectId, OperationError, withWorkspaceEdit, type Actor } from './operations';
import type { RegisterTool } from './mcpControls';
import { SCOPES, oauthOrigin, spacesOf } from './mcpAuth';
import { workerStatus } from './jobs';
import { jevConfigured } from './env';
import { cancelInvite, deleteOrganization, inviteToOrg } from './team';
import { createFeedToken, feedTokenInfo, revokeFeedToken } from './feed';
import { series, totals } from './stats';

const id = z.string().regex(/^[a-f0-9]{24}$/i), requestId = z.string().regex(/^[\w:-]{8,128}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'A real date, YYYY-MM-DD');
async function organization(db: Db, actor: Actor, owner = false) {
  if (!actor.space.startsWith('org:')) throw new OperationError('invalid_input', 'The connection is in your Personal workspace. Switch to an organization (workspace_switch) to manage its team.');
  const org = await cols(db).orgs.findOne({ _id: objectId(actor.space.slice(4)), members: { $elemMatch: { userId: actor.userId, ...(owner ? { role: 'owner' } : {}) } } });
  if (!org) throw new OperationError('forbidden', owner ? 'Only a current workspace owner can do this.' : 'Workspace membership is required.');
  return org;
}
/** Point this connection at another workspace; later calls act there. */
async function moveConnection(db: Db, actor: Actor, space: string) {
  if (actor.connectionId) await db.collection('oauthGrants').updateOne({ _id: actor.connectionId as any, userId: actor.userId.toHexString() }, { $set: { space } });
  actor.space = space;
}
export function registerWorkspaceTools(db: Db, actor: Actor, register: RegisterTool) {
  const c = cols(db);
  const anyScope = actor.scopes?.find(s => s.endsWith(':read')) ?? actor.scopes?.find(s => s !== 'offline_access') ?? 'campaigns:read';
  register('workspace_list', 'List every workspace you can reach (your Personal one and each organization you are in), with your role and which one this connection is acting in now.', anyScope, {}, false, async () => {
    const spaces = await spacesOf(db, actor.userId);
    return { current: actor.space, workspaces: spaces.map(s => ({ workspace: s.key, name: s.name, kind: s.kind, role: s.role ?? 'owner', current: s.key === actor.space })) };
  });
  register('workspace_switch', 'Make this connection act in another of your workspaces (by its key from workspace_list, or its exact name). Every later call acts there until you switch again. The connection belongs to your account, so no reconnect is needed.', anyScope, { workspace: z.string().trim().min(1).max(200) }, false, async a => {
    const spaces = await spacesOf(db, actor.userId);
    const matches = spaces.filter(s => s.key === a.workspace || s.name.toLowerCase() === a.workspace.toLowerCase());
    if (!matches.length) throw new OperationError('not_found', 'No workspace of yours has that key or name. Use workspace_list.');
    if (matches.length > 1) throw new OperationError('ambiguous', 'Several of your workspaces have that name. Use its key from workspace_list.');
    await moveConnection(db, actor, matches[0].key);
    return { current: matches[0].key, name: matches[0].name, kind: matches[0].kind };
  });
  register('workspace_get', 'Read the workspace this connection acts in, your profile, granted/missing permissions, service health and secure setup links. Does not return secrets.', 'workspace:read', {}, false, async () => {
    const user = await c.users.findOne({ _id: actor.userId }, { projection: { name: 1, email: 1 } });
    const org = actor.space.startsWith('org:') ? await organization(db, actor) : null;
    const members = org ? await c.users.find({ _id: { $in: org.members.map(m => m.userId) } }, { projection: { name: 1, email: 1 } }).toArray() : [];
    const status = await workerStatus(db);
    return {
      space: actor.space, user,
      organization: org ? { id: org._id, name: org.name, members: members.map(m => ({ ...m, role: org.members.find(x => x.userId.equals(m._id))?.role })), invites: await c.invites.find({ orgId: org._id, acceptedAt: { $exists: false } }, { projection: { email: 1, createdAt: 1, sentAt: 1, expiresAt: 1 } }).limit(100).toArray() } : null,
      permissions: actor.scopes, missingPermissions: SCOPES.filter(s => !actor.scopes?.includes(s)), worker: { stale: status.stale, ageSec: status.ageSec }, repliesLabelled: jevConfigured(),
      links: { mailboxSetup: `${oauthOrigin()}/mailboxes/new`, account: `${oauthOrigin()}/team`, connections: `${oauthOrigin()}/connections` },
      note: 'Passwords, mailbox authorization and server environment secrets are configured through the secure UI or host. This connection belongs to your account: workspace_list and workspace_switch move it between your workspaces.'
    };
  });
  register('workspace_stats', 'Workspace-wide statistics (all campaigns, or one mailbox) for an inclusive UTC date range, plus lead counts by status. The same numbers as the Analytics screen.', 'workspace:read', { from: day, to: day, accountId: id.optional() }, false, async a => {
    if (a.from > a.to || Date.parse(a.to) - Date.parse(a.from) > 366 * 864e5) throw new OperationError('invalid_input', 'Choose an ascending date range of at most 367 days.');
    const match: Record<string, unknown> = { space: actor.space, day: { $gte: a.from, $lte: a.to }, ...(a.accountId ? { accountId: objectId(a.accountId) } : {}) };
    const { day: _d, ...base } = match; void _d;
    const leads = await c.leads.aggregate<{ _id: string; n: number }>([{ $match: { space: actor.space } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    return { from: a.from, to: a.to, timezone: 'UTC', totals: await totals(db, match), daily: await series(db, base, new Date(a.from), new Date(a.to)), leadsByStatus: Object.fromEntries(leads.map(r => [r._id, r.n])) };
  });
  register('profile_update', 'Change your own display name.', 'workspace:write', { requestId, name: z.string().trim().min(1).max(200) }, true, async a => { await c.users.updateOne({ _id: actor.userId }, { $set: { name: a.name } }); return { name: a.name }; });
  register('workspace_create', 'Create an organization owned by you and switch this connection to it.', 'workspace:write', { requestId, name: z.string().trim().min(1).max(200) }, true, async a => {
    const _id = new ObjectId(); await c.orgs.insertOne({ _id, name: a.name, members: [{ userId: actor.userId, role: 'owner', addedAt: new Date() }], createdAt: new Date() });
    await moveConnection(db, actor, `org:${_id}`);
    return { id: _id, space: `org:${_id}`, name: a.name, current: true };
  });
  register('workspace_rename', 'Rename the organization this connection acts in. Requires ownership.', 'workspace:write', { requestId, name: z.string().trim().min(1).max(200) }, true, async a => {
    const org = await organization(db, actor, true); await c.orgs.updateOne({ _id: org._id, members: { $elemMatch: { userId: actor.userId, role: 'owner' } } }, { $set: { name: a.name } }); return { name: a.name };
  });
  register('team_invite', 'Email an invitation to join the organization this connection acts in. The person joins only by opening the emailed link, signed in as that exact address (an existing account too). Inviting the same address again sends a new link and voids the old one. Requires ownership. Check emailed/error in the result.', 'workspace:write', { requestId, email: z.string().trim().toLowerCase().email() }, true, async a => {
    const org = await organization(db, actor, true);
    const user = await c.users.findOne({ _id: actor.userId }, { projection: { name: 1, email: 1 } });
    if (!user) throw new OperationError('not_found', 'Your account is gone.');
    return inviteToOrg(db, { orgId: org._id, inviter: user, email: a.email, origin: oauthOrigin() });
  });
  register('team_update', 'Change a member role, remove a member (or leave yourself), or cancel an invitation (its link stops working). Owners manage others; the last owner cannot leave or be demoted.', 'workspace:write', { requestId, action: z.enum(['owner', 'member', 'remove', 'cancel_invite']), memberId: id.optional(), inviteId: id.optional() }, true, a => withWorkspaceEdit(db, actor.space, async () => {
    const self = a.memberId === actor.userId.toHexString();
    const org = await organization(db, actor, !(a.action === 'remove' && self));
    if (a.action === 'cancel_invite') {
      if (!a.inviteId) throw new OperationError('invalid_input', 'inviteId is required.');
      const invite = await c.invites.findOne({ _id: objectId(a.inviteId), orgId: org._id });
      return { deleted: invite ? (await cancelInvite(db, invite._id, actor.userId) ? 1 : 0) : 0 };
    }
    if (!a.memberId) throw new OperationError('invalid_input', 'memberId is required.');
    const userId = objectId(a.memberId), target = org.members.find(m => m.userId.equals(userId));
    if (!target) throw new OperationError('not_found', 'Member not found.');
    if (target.role === 'owner' && a.action !== 'owner' && org.members.filter(m => m.role === 'owner').length === 1) throw new OperationError('last_owner', 'Assign another owner first.');
    if (a.action === 'remove') await c.orgs.updateOne({ _id: org._id }, { $pull: { members: { userId } } });
    else await c.orgs.updateOne({ _id: org._id, 'members.userId': userId }, { $set: { 'members.$.role': a.action } });
    return { memberId: a.memberId, action: a.action };
  }));
  register('workspace_delete', 'Delete the organization this connection acts in and its outreach data. Requires ownership, exact organization name, all campaigns stopped and no unresolved sends. Connections stay (they belong to accounts) and move to each person\'s Personal workspace.', 'workspace:write', { requestId, confirmName: z.string() }, true, a => withWorkspaceEdit(db, actor.space, async () => {
    const org = await organization(db, actor, true);
    if (org.name !== a.confirmName) throw new OperationError('invalid_input', 'confirmName must match the organization.');
    if (await c.campaigns.findOne({ space: actor.space, status: 'active' })) throw new OperationError('campaign_busy', 'Pause every campaign first.');
    if (await c.sends.findOne({ space: actor.space, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] }) || await c.messages.findOne({ space: actor.space, status: 'sending' })) throw new OperationError('send_in_flight', 'Wait for all sends to settle.');
    await deleteOrganization(db, org._id);
    return { deleted: true, name: org.name };
  }));
  register('feed_get', 'Whether the workspace has a results feed link (leads.csv and daily.csv for a spreadsheet), when it was made and last read. The link itself is shown only when it is made.', 'workspace:read', {}, false, async () => ({ feed: await feedTokenInfo(db, actor.space) }));
  register('feed_create', 'Make a new results feed link for this workspace; any older link stops working. Only when the user asks for the link: anyone holding it can read the workspace\'s lead results, so give it to the user and nowhere else.', 'workspace:write', { requestId }, true, async () => {
    const token = await createFeedToken(db, actor.space, actor.userId), base = `${oauthOrigin()}/feed/${token}`;
    return { leadsCsv: `${base}/leads.csv`, dailyCsv: `${base}/daily.csv`, note: 'Shown once. In a spreadsheet: =IMPORTDATA("<link>").' };
  });
  register('feed_revoke', 'Turn off the workspace\'s results feed link.', 'workspace:write', { requestId }, true, async () => ({ revoked: await revokeFeedToken(db, actor.space) }));
  register('connection_list', 'List your assistant connections (they belong to your account), with the workspace each acts in. Excludes credentials.', 'workspace:read', {}, false, async () => {
    const [grants, spaces] = await Promise.all([db.collection('oauthGrants').find({ userId: actor.userId.toHexString(), revokedAt: { $exists: false } }, { projection: { clientName: 1, scope: 1, space: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(100).toArray(), spacesOf(db, actor.userId)]);
    return { connections: grants.map(g => ({ ...g, workspace: spaces.find(s => s.key === g.space)?.name ?? 'Personal', thisConnection: String(g._id) === actor.connectionId })) };
  });
  register('connection_revoke', 'Revoke one of your assistant connections. Revoking this connection disconnects it immediately.', 'workspace:write', { requestId, connectionId: z.string().min(1).max(128) }, true, async a => ({ revoked: !!(await db.collection('oauthGrants').updateOne({ _id: a.connectionId as any, userId: actor.userId.toHexString(), revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } })).matchedCount }));
}
