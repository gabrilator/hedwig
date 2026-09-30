export interface OutboundMail {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
  /** our own id for this send, put in an X-Hedwig-Send header where the provider allows it */
  sendId: string;
  headers?: Record<string, string>;
}
export interface ThreadRef { internetMessageId: string; conversationId?: string }
export interface SentInfo { internetMessageId: string; conversationId?: string; providerMessageId?: string }

export interface InboundItem {
  providerId: string;              // Graph message id · IMAP uid as string
  from: string;
  fromName?: string;
  subject: string;
  receivedAt: Date;
  conversationId?: string;
  internetMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  autoSubmitted?: string;
  preview?: string;
}
export interface InboundFull extends InboundItem {
  to: string[];
  text: string;
  html?: string;
  headers: Record<string, string>;
}
export interface SyncState { deltaLink?: string; lastUid?: number; uidValidity?: number; baselineDone?: boolean }

export interface MailProvider {
  kind: 'microsoft' | 'imapSmtp';
  /** Connect both directions and describe what was found. Never throws; returns ok:false with detail. */
  test(): Promise<{ ok: boolean; detail: string }>;
  /** Send inside a thread when `thread` is given (follow-ups), else a new conversation. */
  send(mail: OutboundMail, thread?: ThreadRef, onPrepared?: (ids: SentInfo) => Promise<void>): Promise<SentInfo>;
  /** New inbox items since state. With baseline=true, only records the current position and returns nothing. */
  fetchNew(state: SyncState, opts: { baseline: boolean }): Promise<{ items: InboundItem[]; state: SyncState }>;
  getMessage(providerId: string): Promise<InboundFull>;
  /** Did this message leave the mailbox? (Sent folder lookup, for the reconciler.) */
  findSent(internetMessageId: string): Promise<{ found: boolean; sentAt?: Date }>;
}
