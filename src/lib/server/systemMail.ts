import type { Db } from 'mongodb';
import { cols } from './db';
import { env, envOpt, resendConfigured } from './env';
import { providerFor } from './mail/provider';
import { textToHtml } from './render';
import type { SpaceKey } from './types';

/** Where Hedwig's own emails (team invites, "someone is interested" notes to you) go out from: Resend when configured, else the space's first active mailbox. Never outreach. */
export async function systemSender(db: Db, space: SpaceKey): Promise<{ via: 'resend' | 'mailbox' | 'none'; label: string }> {
  if (resendConfigured()) return { via: 'resend', label: envOpt('LOGIN_FROM') ?? 'Resend (LOGIN_FROM not set)' };
  const acc = await cols(db).emailAccounts.findOne({ space, status: 'active' }, { sort: { createdAt: 1 } });
  if (acc) return { via: 'mailbox', label: acc.address };
  return { via: 'none', label: 'nothing configured: no Resend key and no connected mailbox' };
}

export async function sendSystemMail(db: Db, space: SpaceKey, mail: { to: string; subject: string; text: string }): Promise<{ sent: boolean; via: string }> {
  if (resendConfigured()) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: envOpt('LOGIN_FROM') ?? 'Hedwig <onboarding@resend.dev>', to: mail.to, subject: mail.subject, text: mail.text })
    });
    return { sent: res.ok, via: 'Resend' };
  }
  const acc = await cols(db).emailAccounts.findOne({ space, status: 'active' }, { sort: { createdAt: 1 } });
  if (!acc) return { sent: false, via: 'none' };
  await providerFor(db, acc).send({ to: mail.to, subject: mail.subject, text: mail.text, html: textToHtml(mail.text), sendId: `sys-${Date.now().toString(36)}` });
  return { sent: true, via: acc.address };
}
