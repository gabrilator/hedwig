import type { Db, ObjectId } from 'mongodb';
import { cols } from '../db';
import { open, seal } from '../crypto';
import type { EmailAccountDoc } from '../types';
import type { MailProvider } from './types';
import { MicrosoftProvider } from './microsoft';
import { ImapSmtpProvider } from './imapSmtp';

export function providerFor(db: Db, account: EmailAccountDoc): MailProvider {
  if (account.kind === 'microsoft') return new MicrosoftProvider(db, account);
  return new ImapSmtpProvider(db, account);
}
export function readSecrets<T>(account: EmailAccountDoc): T { return open<T>(account.secrets); }
export async function writeSecrets(db: Db, accountId: ObjectId, secrets: unknown): Promise<void> {
  await cols(db).emailAccounts.updateOne({ _id: accountId }, { $set: { secrets: seal(secrets) } });
}
