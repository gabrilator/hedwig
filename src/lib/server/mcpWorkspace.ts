import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { cols } from './db';
import { objectId, OperationError, withWorkspaceEdit, type Actor } from './operations';
import type { RegisterTool } from './mcpControls';
import { SCOPES, oauthOrigin } from './mcpAuth';
import { workerStatus } from './jobs';
import { classifierConfigured, geminiConfigured } from './env';

const id = z.string().regex(/^[a-f0-9]{24}$/i), requestId = z.string().regex(/^[\w:-]{8,128}$/);
async function organization(db: Db, actor: Actor, owner = false) {
  if (!actor.space.startsWith('org:')) throw new OperationError('invalid_input', 'This connection is for a personal workspace. Connect to an organization to manage its team.');
  const org = await cols(db).orgs.findOne({ _id: objectId(actor.space.slice(4)), members: { $elemMatch: { userId: actor.userId, ...(owner ? { role: 'owner' } : {}) } } });
  if (!org) throw new OperationError('forbidden', owner ? 'Only a current workspace owner can do this.' : 'Workspace membership is required.');
  return org;
}
export function registerWorkspaceTools(db: Db, actor: Actor, register: RegisterTool) {
  const c = cols(db);
  register('workspace_get', 'Read the connected workspace, your profile, granted/missing permissions, service health and secure setup links. Does not return secrets.', 'workspace:read', {}, false, async () => {
    const user = await c.users.findOne({ _id: actor.userId }, { projection: { name: 1, email: 1 } });
    const org = actor.space.startsWith('org:') ? await organization(db, actor) : null;
    const members = org ? await c.users.find({ _id: { $in: org.members.map(m => m.userId) } }, { projection: { name: 1, email: 1 } }).toArray() : [];
    const status = await workerStatus(db);
    return { space: actor.space, user, organization: org ? { id: org._id, name: org.name, members: members.map(m => ({ ...m, role: org.members.find(x => x.userId.equals(m._id))?.role })), invites: await c.invites.find({ orgId: org._id, acceptedAt: { $exists: false } }, { projection: { email: 1, createdAt: 1 } }).limit(100).toArray() } : null, permissions: actor.scopes, missingPermissions: SCOPES.filter(s => !actor.scopes?.includes(s)), worker: { stale: status.stale, ageSec: status.ageSec }, classifierConfigured: classifierConfigured(), draftsConfigured: geminiConfigured(), links: { mailboxSetup: `${oauthOrigin()}/emails/new`, account: `${oauthOrigin()}/team`, connections: `${oauthOrigin()}/connections` }, note: 'Passwords, mailbox authorization and server environment secrets are configured through the secure UI or host. A connection is bound to one workspace.' };
  });
  register('profile_update', 'Change your own display name.', 'workspace:write', { requestId, name: z.string().trim().min(1).max(200) }, true, async a => { await c.users.updateOne({ _id: actor.userId }, { $set: { name: a.name } }); return { name: a.name }; });
  register('workspace_create', 'Create an organization owned by you. Reconnect and select it to manage it; this grant stays in its current workspace.', 'workspace:write', { requestId, name: z.string().trim().min(1).max(200) }, true, async a => {
    const _id = new ObjectId(); await c.orgs.insertOne({ _id, name: a.name, members: [{ userId: actor.userId, role: 'owner', addedAt: new Date() }], createdAt: new Date() }); return { id: _id, space: `org:${_id}`, name: a.name, reconnectRequired: true };
  });
  register('workspace_rename', 'Rename the connected organization. Requires workspace ownership.', 'workspace:write', { requestId, name: z.string().trim().min(1).max(200) }, true, async a => {
    const org = await organization(db, actor, true); await c.orgs.updateOne({ _id: org._id, members: { $elemMatch: { userId: actor.userId, role: 'owner' } } }, { $set: { name: a.name } }); return { name: a.name };
  });
  register('team_invite', 'Add an existing user to the connected organization or register an invitation for signup. Requires ownership. This action does not send an email.', 'workspace:write', { requestId, email: z.string().trim().toLowerCase().email() }, true, a => withWorkspaceEdit(db, actor.space, async () => {
    const org = await organization(db, actor, true), user = await c.users.findOne({ email: a.email });
    if (user) {
      const r = await c.orgs.updateOne({ _id: org._id, 'members.userId': { $ne: user._id } }, { $push: { members: { userId: user._id, role: 'member', addedAt: new Date() } } });
      return { email: a.email, added: !!r.modifiedCount, alreadyMember: !r.modifiedCount };
    }
    await c.invites.updateOne({ orgId: org._id, email: a.email }, { $setOnInsert: { invitedBy: actor.userId, createdAt: new Date() } }, { upsert: true });
    return { invited: true, email: a.email, signupUrl: `${oauthOrigin()}/signup`, emailSent: false };
  }));
  register('team_update', 'Change a member role, remove a member (or leave yourself), or cancel an invitation. Owners manage others; the last owner cannot leave or be demoted.', 'workspace:write', { requestId, action: z.enum(['owner', 'member', 'remove', 'cancel_invite']), memberId: id.optional(), inviteId: id.optional() }, true, a => withWorkspaceEdit(db, actor.space, async () => {
    const self = a.memberId === actor.userId.toHexString();
    const org = await organization(db, actor, !(a.action === 'remove' && self));
    if (a.action === 'cancel_invite') {
      if (!a.inviteId) throw new OperationError('invalid_input', 'inviteId is required.');
      return { deleted: (await c.invites.deleteOne({ _id: objectId(a.inviteId), orgId: org._id })).deletedCount };
    }
    if (!a.memberId) throw new OperationError('invalid_input', 'memberId is required.');
    const userId = objectId(a.memberId), target = org.members.find(m => m.userId.equals(userId));
    if (!target) throw new OperationError('not_found', 'Member not found.');
    if (target.role === 'owner' && a.action !== 'owner' && org.members.filter(m => m.role === 'owner').length === 1) throw new OperationError('last_owner', 'Assign another owner first.');
    if (a.action === 'remove') await c.orgs.updateOne({ _id: org._id }, { $pull: { members: { userId } } });
    else await c.orgs.updateOne({ _id: org._id, 'members.userId': userId }, { $set: { 'members.$.role': a.action } });
    return { memberId: a.memberId, action: a.action };
  }));
  register('workspace_delete', 'Delete the connected organization and its outreach data. Requires ownership, exact organization name, all campaigns stopped and no unresolved sends. Revokes workspace connections.', 'workspace:write', { requestId, confirmName: z.string() }, true, a => withWorkspaceEdit(db, actor.space, async () => {
    const org = await organization(db, actor, true);
    if (org.name !== a.confirmName) throw new OperationError('invalid_input', 'confirmName must match the organization.');
    if (await c.campaigns.findOne({ space: actor.space, status: 'active' })) throw new OperationError('campaign_busy', 'Pause every campaign first.');
    if (await c.sends.findOne({ space: actor.space, $or: [{ status: { $in: ['claimed', 'unknown'] } }, { inFlight: true }, { status: 'planned', ids: { $exists: true } }] }) || await c.messages.findOne({ space: actor.space, status: 'sending' })) throw new OperationError('send_in_flight', 'Wait for all sends to settle.');
    for (const name of ['sends', 'leads', 'messages', 'events', 'dailyStats', 'imports', 'campaigns', 'emailAccounts', 'suppressions', 'agents', 'llmCalls', 'researchTables', 'contacts']) await db.collection(name).deleteMany({ space: actor.space });
    await c.invites.deleteMany({ orgId: org._id });
    await db.collection('oauthGrants').updateMany({ space: actor.space }, { $set: { revokedAt: new Date() } });
    await c.orgs.deleteOne({ _id: org._id }); return { deleted: true, name: org.name };
  }));
  register('connection_list', 'List your assistant connections for this workspace, excluding credentials.', 'workspace:read', {}, false, async () => ({ connections: await db.collection('oauthGrants').find({ space: actor.space, userId: actor.userId.toHexString(), revokedAt: { $exists: false } }, { projection: { clientName: 1, scope: 1, createdAt: 1 } }).limit(100).toArray() }));
  register('connection_revoke', 'Revoke one of your assistant connections in this workspace. Revoking this connection disconnects it immediately.', 'workspace:write', { requestId, connectionId: z.string().min(1).max(128) }, true, async a => ({ revoked: !!(await db.collection('oauthGrants').updateOne({ _id: a.connectionId as any, space: actor.space, userId: actor.userId.toHexString() }, { $set: { revokedAt: new Date() } })).matchedCount }));
}
