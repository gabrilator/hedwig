import { MongoClient, type Db } from 'mongodb';
import { env } from './env';
import type {
  AgentDoc, CampaignDoc, DailyStatDoc, DomainDoc, EmailAccountDoc, EventDoc, HeartbeatDoc, ImportDoc, InviteDoc,
  JobRunDoc, LeadDoc, LlmCallDoc, MessageDoc, MigrationDoc, OAuthStateDoc, OrgDoc, SendDoc, SessionDoc, SuppressionDoc, UserDoc
} from './types';

let client: MongoClient | null = null;
let db: Db | null = null;
let indexesReady: Promise<void> | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(env('MONGODB_URI'), { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(env('MONGODB_DB', 'hedwig'));
  return db;
}
export async function closeDb() {
  await client?.close();
  client = null; db = null; indexesReady = null;
}
export function cols(d: Db) {
  return {
    users: d.collection<UserDoc>('users'),
    sessions: d.collection<SessionDoc>('sessions'),
    orgs: d.collection<OrgDoc>('orgs'),
    invites: d.collection<InviteDoc>('invites'),
    emailAccounts: d.collection<EmailAccountDoc>('emailAccounts'),
    campaigns: d.collection<CampaignDoc>('campaigns'),
    leads: d.collection<LeadDoc>('leads'),
    sends: d.collection<SendDoc>('sends'),
    messages: d.collection<MessageDoc>('messages'),
    events: d.collection<EventDoc>('events'),
    dailyStats: d.collection<DailyStatDoc>('dailyStats'),
    suppressions: d.collection<SuppressionDoc>('suppressions'),
    agents: d.collection<AgentDoc>('agents'),
    jobRuns: d.collection<JobRunDoc>('jobRuns'),
    heartbeat: d.collection<HeartbeatDoc>('workerHeartbeat'),
    domains: d.collection<DomainDoc>('domains'),
    imports: d.collection<ImportDoc>('imports'),
    oauthStates: d.collection<OAuthStateDoc>('oauthStates'),
    llmCalls: d.collection<LlmCallDoc>('llmCalls'),
    migrations: d.collection<MigrationDoc>('migrations'),
    agendaJobs: d.collection('agendaJobs')
  };
}
export type Cols = ReturnType<typeof cols>;
export async function collections(): Promise<Cols> { return cols(await getDb()); }

export function ensureIndexes(d: Db): Promise<void> {
  if (indexesReady) return indexesReady;
  const c = cols(d);
  indexesReady = (async () => {
    await Promise.all([
      d.collection('contacts').createIndex({ space: 1, identities: 1 }, { unique: true }),
      d.collection('contacts').createIndex({ space: 1, tableIds: 1, _id: 1 }),
      d.collection('researchTables').createIndex({ space: 1, createdAt: -1 }),
      d.collection('operationReceipts').createIndex({ space: 1, createdAt: -1 }),
      d.collection('oauthClients').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      d.collection('oauthCodes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      d.collection('oauthTokens').createIndex({ refreshTokenHash: 1 }, { unique: true }),
      d.collection('oauthTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      d.collection('oauthLimits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      c.users.createIndex({ email: 1 }, { unique: true }),
      c.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
      c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      c.orgs.createIndex({ 'members.userId': 1 }),
      c.invites.createIndex({ email: 1, orgId: 1 }, { unique: true }),
      c.emailAccounts.createIndex({ space: 1 }),
      c.emailAccounts.createIndex({ address: 1 }, { unique: true }),
      c.campaigns.createIndex({ space: 1, status: 1 }),
      c.leads.createIndex({ campaignId: 1, email: 1 }, { unique: true }),
      c.leads.createIndex({ campaignId: 1, status: 1 }),
      c.leads.createIndex({ space: 1, email: 1 }),
      c.leads.createIndex({ campaignId: 1, nextDueAt: 1 }),
      c.leads.createIndex({ space: 1, lastInboundAt: -1 }, { partialFilterExpression: { lastInboundAt: { $exists: true } } }),
      c.leads.createIndex({ space: 1, inboundUnread: 1 }, { partialFilterExpression: { inboundUnread: true } }),
      c.sends.createIndex({ status: 1, dueAt: 1 }),
      c.sends.createIndex({ accountId: 1, status: 1, sentAt: 1 }),
      c.sends.createIndex({ campaignId: 1, dueAt: 1 }),
      c.sends.createIndex({ leadId: 1, stepIndex: 1 }, { unique: true }),
      c.sends.createIndex({ 'tokens.open': 1 }, { unique: true }),
      c.sends.createIndex({ 'tokens.unsub': 1 }, { unique: true }),
      c.sends.createIndex({ 'ids.internetMessageId': 1 }, { sparse: true }),
      c.messages.createIndex({ leadId: 1, at: 1 }),
      c.messages.createIndex({ internetMessageId: 1 }, { sparse: true }),
      c.messages.createIndex({ conversationId: 1 }, { sparse: true }),
      c.messages.createIndex({ campaignId: 1, at: -1 }),
      c.messages.createIndex({ 'ai.status': 1, at: 1 }, { partialFilterExpression: { 'ai.status': { $exists: true } } }),
      c.messages.createIndex({ nonce: 1 }, { unique: true, sparse: true }),
      c.llmCalls.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
      c.llmCalls.createIndex({ space: 1, at: -1 }),
      c.events.createIndex({ campaignId: 1, at: 1 }),
      c.events.createIndex({ space: 1, at: 1 }),
      c.dailyStats.createIndex({ campaignId: 1, day: 1, stepIndex: 1, accountId: 1 }, { unique: true }),
      c.dailyStats.createIndex({ space: 1, day: 1 }),
      c.dailyStats.createIndex({ accountId: 1, day: 1 }),
      c.suppressions.createIndex({ space: 1, email: 1 }, { unique: true }),
      c.agents.createIndex({ space: 1 }),
      c.agents.createIndex({ space: 1, builtin: 1 }, { unique: true, partialFilterExpression: { builtin: true } }),
      c.jobRuns.createIndex({ job: 1, startedAt: -1 }),
      c.jobRuns.createIndex({ startedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
      d.collection('listImports').createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 6 }),
      c.imports.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 6 }),
      c.oauthStates.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 15 }),
      c.domains.createIndex({ checkedAt: 1 })
    ]);
  })();
  return indexesReady;
}
