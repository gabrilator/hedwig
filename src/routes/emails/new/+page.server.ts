import { fail, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Actions, PageServerLoad } from './$types';
import { cols, getDb } from '$lib/server/db';
import { bool, ctx, num, str } from '$lib/server/context';
import { seal } from '$lib/server/crypto';
import { ImapSmtpProvider, PRESETS, presetForMx } from '$lib/server/mail/imapSmtp';
import { detectProvider } from '$lib/server/dns';
import { enqueue } from '$lib/server/jobs';
import { isEmail } from '$lib/server/render';
import { masterKeyProblem } from '$lib/server/env';
import type { EmailAccountDoc } from '$lib/server/types';

export const load: PageServerLoad = async ({ locals }) => { ctx(locals); return { presets: PRESETS }; };

function fromForm(fd: FormData, c: ReturnType<typeof ctx>): { account: EmailAccountDoc; error?: string } {
  const address = str(fd, 'address').toLowerCase();
  const imapPass = String(fd.get('imapPass') ?? ''), smtpPass = String(fd.get('smtpPass') ?? '') || imapPass;
  const account: EmailAccountDoc = {
    _id: new ObjectId(), space: c.space.key, ownerUserId: c.user._id, address, fromName: str(fd, 'fromName') || address.split('@')[0], kind: 'imapSmtp', status: 'active',
    dailyLimit: Math.max(1, Math.min(500, num(fd, 'dailyLimit', 30))), ramp: { enabled: bool(fd, 'ramp'), startedAt: new Date() },
    secrets: seal({ imapPass, smtpPass }),
    imap: { host: str(fd, 'imapHost'), port: num(fd, 'imapPort', 993), secure: bool(fd, 'imapSecure'), user: str(fd, 'imapUser') || address },
    smtp: { host: str(fd, 'smtpHost'), port: num(fd, 'smtpPort', 465), secure: bool(fd, 'smtpSecure'), user: str(fd, 'smtpUser') || address },
    sync: {}, createdAt: new Date()
  };
  if (!isEmail(address)) return { account, error: 'That does not look like an email address.' };
  if (!account.imap!.host || !account.smtp!.host) return { account, error: 'IMAP and SMTP hosts are both needed.' };
  if (!imapPass) return { account, error: 'The mailbox password (or app password) is needed.' };
  return { account };
}
const echo = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k]) => !/pass/i.test(k)).map(([k, v]) => [k, String(v)]));

export const actions: Actions = {
  detect: async ({ request, locals }) => {
    ctx(locals);
    const fd = await request.formData();
    const address = str(fd, 'address').toLowerCase();
    if (!isEmail(address)) return fail(400, { error: 'Type the email address first.', values: echo(fd) });
    const domain = address.split('@')[1];
    const { mx } = await detectProvider(domain);
    const found = presetForMx(mx);
    return { detected: { ...found, domain, mx: mx[0] ?? '' }, values: echo(fd) };
  },
  test: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const keyProblem = masterKeyProblem();
    if (keyProblem) return fail(400, { error: `${keyProblem} See Setup.`, values: echo(fd) });
    const { account, error } = fromForm(fd, c);
    if (error) return fail(400, { error, values: echo(fd) });
    const r = await new ImapSmtpProvider(db, account).test();
    return r.ok ? { testOk: r.detail, values: echo(fd) } : fail(400, { error: r.detail, values: echo(fd) });
  },
  save: async ({ request, locals }) => {
    const c = ctx(locals); const db = await getDb(); const fd = await request.formData();
    const keyProblem = masterKeyProblem();
    if (keyProblem) return fail(400, { error: `${keyProblem} See Setup.`, values: echo(fd) });
    const { account, error } = fromForm(fd, c);
    if (error) return fail(400, { error, values: echo(fd) });
    if (await cols(db).emailAccounts.findOne({ address: account.address })) return fail(400, { error: `${account.address} is already connected.`, values: echo(fd) });
    const r = await new ImapSmtpProvider(db, account).test();
    if (!r.ok) return fail(400, { error: `Not saved. ${r.detail}`, values: echo(fd) });
    await cols(db).emailAccounts.insertOne(account);
    await enqueue(db, 'dns-check', { accountId: account._id.toHexString() });
    await enqueue(db, 'sync-account', { accountId: account._id.toHexString() });
    redirect(303, `/emails?connected=${encodeURIComponent(account.address)}`);
  }
};
