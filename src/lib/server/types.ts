import type { ObjectId } from 'mongodb';

/** A "space" is where things live: an org or a person's private area. Stored as a string key. */
export type SpaceKey = string; // `org:<orgId>` | `user:<userId>`

export type OrgRole = 'owner' | 'member';

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  lastLoginAt?: Date;
}
export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface OrgDoc {
  _id: ObjectId;
  name: string;
  members: { userId: ObjectId; role: OrgRole; addedAt: Date }[];
  createdAt: Date;
}
export interface InviteDoc {
  _id: ObjectId;
  orgId: ObjectId;
  email: string;
  invitedBy: ObjectId;
  createdAt: Date;
  acceptedAt?: Date;
}

export type AccountKind = 'microsoft' | 'imapSmtp';
export type AccountStatus = 'active' | 'paused' | 'error';
export interface DnsResult {
  domain: string;
  spf: { ok: boolean; record?: string };
  dkim: { ok: boolean; selector?: string };
  dmarc: { ok: boolean; record?: string; policy?: string };
  fixes: string[];
  checkedAt: Date;
}
export interface ServerSpec { host: string; port: number; secure: boolean; user: string }
export interface EmailAccountDoc {
  _id: ObjectId;
  space: SpaceKey;
  ownerUserId: ObjectId;
  address: string;
  fromName: string;
  kind: AccountKind;
  status: AccountStatus;
  pausedReason?: string;
  dailyLimit: number;
  /** IANA zone whose midnight resets the daily limit; taken from the first campaign that uses the mailbox, editable under Manage */
  timezone?: string;
  /** self-pause when bounces reach this share of the last 7 days' sends; 0 = never; unset = 5 */
  bouncePausePct?: number;
  ramp: { enabled: boolean; startedAt: Date };
  /** sealed JSON: microsoft → { refreshToken, accessToken?, expiresAt? } · imapSmtp → { imapPass, smtpPass } */
  secrets: string;
  microsoft?: { tenantId: string; scopes: string[]; homeAccountId?: string };
  imap?: ServerSpec;
  smtp?: ServerSpec;
  sync: { deltaLink?: string; lastUid?: number; uidValidity?: number; lastSyncAt?: Date; lastError?: string; baselineDone?: boolean };
  dns?: DnsResult;
  createdAt: Date;
}

export interface ScheduleSpec {
  timezone: string;   // IANA
  from: string;       // 'HH:MM' local
  to: string;         // 'HH:MM' local
  days: number[];     // 0 = Sunday … 6 = Saturday, local
  startAt?: Date | null;
  endAt?: Date | null;
}
export interface StepSpec {
  subject: string | null; // null → same thread as step 1
  body: string;           // plain text with {{variables}}
  delayDays: number;      // days after the previous step
}
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export interface CampaignDoc {
  editLock?: string;
  editLockedAt?: Date;
  _id: ObjectId;
  space: SpaceKey;
  ownerUserId: ObjectId;
  name: string;
  status: CampaignStatus;
  schedule: ScheduleSpec;
  steps: StepSpec[];
  accountIds: ObjectId[];
  dailyLimit: number;
  stopOnReply: boolean;
  oooStops: boolean;
  openTracking: boolean;
  testRecipient: string;
  unsubscribeLine: string;
  /** null = the space's built-in "Reply triage" agent · an id = that agent · agentOff = no agent on this campaign */
  agentId?: ObjectId | null;
  agentOff?: boolean;
  agentRules: { if: string; then: string }[];
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
}

export type LeadStatus =
  | 'queued' | 'contacted' | 'opened' | 'replied' | 'interested' | 'meeting' | 'won'
  | 'not_interested' | 'bounced' | 'unsubscribed' | 'paused';
export type Provider = 'google' | 'microsoft' | 'other' | 'unknown';
export interface LeadDoc {
  contactId?: ObjectId;
  researchRevision?: number;
  fieldEvidence?: Record<string, { kind: 'observed' | 'inferred' | 'manual'; [key: string]: unknown }>;
  _id: ObjectId;
  campaignId: ObjectId;
  space: SpaceKey;
  email: string;
  domain: string;
  vars: Record<string, string>;
  provider: Provider;
  accountId?: ObjectId;
  currentStep: number;         // index of the next step to send
  nextDueAt?: Date | null;
  status: LeadStatus;
  thread?: { internetMessageId: string; firstInternetMessageId?: string; conversationId?: string; subject: string };
  /** Inbox: kept on the lead so the thread list never scans messages. */
  lastInboundAt?: Date;
  lastInbound?: { messageId: ObjectId; kind: 'reply' | 'bounce' | 'ooo'; subject: string; snippet: string; at: Date };
  inboundUnread?: boolean;
  inboundReadAt?: Date;
  lastAnsweredAt?: Date;
  /** human opens across all steps, and the latest one */
  openCount?: number;
  lastOpenedAt?: Date;
  /**
   * Curious: opened the campaign's emails more often than it got them (2 emails, 3 opens) and never replied. A flag of its
   * own, apart from the status. The daily check sets it once; a reply clears the check's mark; a person may set or reset
   * it, and a person's choice is final. Absent = never judged.
   */
  curious?: boolean;
  curiousAt?: Date;
  /** 'rule' (the daily check) or the email of the person who set it */
  curiousBy?: string;
  /** Who set the status by hand. While it is there the reply classifier leaves this lead alone; "Label again" hands it back. */
  statusBy?: string;
  /** Latest classification by the reply agent (copied from the message so filters stay on `leads`). */
  ai?: { label: AiLabel; confidence: number; at: Date; messageId: ObjectId };
  completedAt?: Date;
  lastEventAt?: Date;
  createdAt: Date;
}

export type SendStatus = 'planned' | 'claimed' | 'sent' | 'failed' | 'cancelled' | 'unknown';
export interface SendDoc {
  inFlight?: boolean;
  _id: ObjectId;
  space: SpaceKey;
  campaignId: ObjectId;
  leadId: ObjectId;
  stepIndex: number;
  accountId: ObjectId;
  dueAt: Date;
  status: SendStatus;
  claimedAt?: Date;
  sentAt?: Date;
  attempt: number;
  error?: string;
  reason?: string;
  tokens: { open: string; unsub: string };
  ids?: { internetMessageId?: string; conversationId?: string; providerMessageId?: string };
  subject?: string;
  /** every pixel hit, machines included */
  openCount?: number;
  firstOpenedAt?: Date;
  /** moments a person opened it (prefetch discounted, hits within a minute collapsed), newest last, at most 30 */
  opens?: Date[];
  createdAt: Date;
}

export type MessageKind = 'sent' | 'reply' | 'bounce' | 'ooo' | 'test' | 'manual';
export const AI_LABELS = ['interested', 'meeting', 'question', 'not_interested', 'out_of_office', 'bounce', 'unsubscribe', 'other'] as const;
export type AiLabel = (typeof AI_LABELS)[number];
/**
 * The reply agent's work on one inbound message. `status` is the idempotency lock: a message is claimed pending → running
 * with one atomic findOneAndUpdate, so the model is called once per reply (twice at most after a failure, never in parallel).
 */
export interface AiWork {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts?: number;
  claimedAt?: Date;
  nextAttemptAt?: Date;
  error?: string;
  agentId?: ObjectId;
  model?: string;
  label?: AiLabel;
  confidence?: number;
  /** Jev: the probability of every label, so a later look can judge the thresholds */
  odds?: Partial<Record<AiLabel, number>>;
  reason?: string;
  language?: string;
  draft?: string;
  draftAt?: Date;
  at?: Date;
  /** set once, before the "interested" email goes out, so it never goes out twice */
  notifiedAt?: Date;
  appliedStatus?: LeadStatus;
}
export interface MessageDoc {
  _id: ObjectId;
  space: SpaceKey;
  campaignId: ObjectId;
  leadId?: ObjectId;
  accountId: ObjectId;
  sendId?: ObjectId;
  direction: 'out' | 'in';
  kind: MessageKind;
  internetMessageId?: string;
  inReplyTo?: string;
  conversationId?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  at: Date;
  ai?: AiWork;
  /** manual replies from the Inbox */
  status?: 'sending' | 'sent' | 'failed';
  nonce?: string;
  byUserId?: ObjectId;
  error?: string;
}

export type EventType = 'sent' | 'open' | 'reply' | 'bounce' | 'ooo' | 'unsubscribe';
export interface EventDoc {
  _id: ObjectId;
  space: SpaceKey;
  campaignId: ObjectId;
  leadId: ObjectId;
  accountId: ObjectId;
  stepIndex: number;
  type: EventType;
  at: Date;
  meta?: Record<string, unknown>;
}
export interface DailyStatDoc {
  _id: ObjectId;
  day: string; // YYYY-MM-DD (UTC)
  space: SpaceKey;
  campaignId: ObjectId;
  stepIndex: number;
  accountId: ObjectId;
  sent: number; opens: number; uniqueOpens: number; replies: number; bounces: number; ooo: number; unsubscribes: number;
}
export interface SuppressionDoc {
  _id: ObjectId;
  space: SpaceKey;
  email: string;
  reason: string;
  at: Date;
}
export type AgentMode = 'classify' | 'draft';
export interface AgentDoc {
  _id: ObjectId;
  space: SpaceKey;
  ownerUserId: ObjectId;
  name: string;
  model: string;
  persona: string;
  /** legacy: free labels from v1; the classifier uses AI_LABELS */
  labels?: string[];
  /** classify: label every reply · draft: label it and write an answer for you to review. Nothing ever sends by itself. */
  mode: AgentMode;
  active: boolean;
  /** the space's "Reply triage" agent, created by Hedwig; used by every campaign without a choice of its own; cannot be deleted */
  builtin?: boolean;
  createdAt: Date;
}
/** One row per model call, so the Setup screen can show exactly how often the model is asked. */
export interface LlmCallDoc {
  _id: ObjectId;
  space: SpaceKey;
  at: Date;
  model: string;
  purpose: 'classify' | 'draft';
  messageId?: ObjectId;
  ok: boolean;
  ms: number;
  tokens?: { prompt: number; output: number };
  error?: string;
}
export interface MigrationDoc { _id: string; at: Date; note?: string }
export interface JobRunDoc {
  _id: ObjectId;
  job: string;
  startedAt: Date;
  finishedAt?: Date;
  ok?: boolean;
  counts?: Record<string, number>;
  error?: string;
  note?: string;
}
export interface HeartbeatDoc { _id: string; at: Date; version: string; pid: number; host: string }
export interface DomainDoc { _id: string; provider: Provider; mx: string[]; checkedAt: Date }
export interface ImportDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  space: SpaceKey;
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  emailColumn: string | null;
  createdAt: Date;
}
export interface OAuthStateDoc { _id: string; userId: ObjectId; space: SpaceKey; codeVerifier: string; createdAt: Date }
