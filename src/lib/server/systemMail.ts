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

/**
 * One of Hedwig's own emails. `space` decides the mailbox when there is no Resend key: always the space the email is about
 * (the team being joined, the campaign's workspace), never another one the sender happens to be in. Never throws: a
 * failure comes back as `error`, in words a person can act on.
 */
export async function sendSystemMail(db: Db, space: SpaceKey, mail: { to: string; subject: string; text: string }): Promise<{ sent: boolean; via: string; error?: string }> {
  if (resendConfigured()) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: envOpt('LOGIN_FROM') ?? 'Hedwig <onboarding@resend.dev>', to: mail.to, subject: mail.subject, text: mail.text }),
        signal: AbortSignal.timeout(20_000)
      });
      if (res.ok) return { sent: true, via: 'Resend' };
      const body = (await res.text().catch(() => '')).slice(0, 200);
      return { sent: false, via: 'Resend', error: `Resend refused it (${res.status})${body ? `: ${body}` : ''}${envOpt('LOGIN_FROM') ? '' : '. LOGIN_FROM is not set, so it went out from Resend\'s test address, which only reaches the Resend account\'s own email.'}` };
    } catch (e: any) { return { sent: false, via: 'Resend', error: `Resend unreachable: ${e?.message ?? e}` }; }
  }
  const acc = await cols(db).emailAccounts.findOne({ space, status: 'active' }, { sort: { createdAt: 1 } });
  if (!acc) return { sent: false, via: 'none', error: 'No Resend key on the server and no active mailbox in this workspace to send it from.' };
  try {
    await providerFor(db, acc).send({ to: mail.to, subject: mail.subject, text: mail.text, html: textToHtml(mail.text), sendId: `sys-${Date.now().toString(36)}` });
    return { sent: true, via: acc.address };
  } catch (e: any) { return { sent: false, via: acc.address, error: `${acc.address} could not send it: ${String(e?.message ?? e).slice(0, 200)}` }; }
}
