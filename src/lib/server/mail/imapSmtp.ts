import type { Db } from 'mongodb';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { open } from '../crypto';
import type { EmailAccountDoc } from '../types';
import type { InboundFull, InboundItem, MailProvider, OutboundMail, SentInfo, SyncState, ThreadRef } from './types';

export interface ImapSmtpSecrets { imapPass: string; smtpPass: string }

export const PRESETS: Record<string, { label: string; imap: { host: string; port: number; secure: boolean }; smtp: { host: string; port: number; secure: boolean }; note: string }> = {
  titan: { label: 'Titan Email', imap: { host: 'imap.titan.email', port: 993, secure: true }, smtp: { host: 'smtp.titan.email', port: 587, secure: false }, note: 'Your normal Titan mailbox password.' },
  hostinger: { label: 'Hostinger', imap: { host: 'imap.hostinger.com', port: 993, secure: true }, smtp: { host: 'smtp.hostinger.com', port: 587, secure: false }, note: 'Your mailbox password.' },
  namecheap: { label: 'Namecheap Private Email', imap: { host: 'mail.privateemail.com', port: 993, secure: true }, smtp: { host: 'mail.privateemail.com', port: 587, secure: false }, note: 'Your mailbox password.' },
  zoho: { label: 'Zoho Mail (EU)', imap: { host: 'imap.zoho.eu', port: 993, secure: true }, smtp: { host: 'smtp.zoho.eu', port: 587, secure: false }, note: 'Enable IMAP in Zoho Mail settings; use an app-specific password if 2FA is on.' },
  zohoCom: { label: 'Zoho Mail (.com)', imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 587, secure: false }, note: 'Enable IMAP in Zoho Mail settings; use an app-specific password if 2FA is on.' },
  google: { label: 'Google Workspace / Gmail', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 587, secure: false }, note: 'Needs 2-step verification and an App password (Google Account → Security → App passwords).' },
  icloud: { label: 'iCloud', imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, note: 'Use an app-specific password from appleid.apple.com.' },
  ionos: { label: 'IONOS', imap: { host: 'imap.ionos.es', port: 993, secure: true }, smtp: { host: 'smtp.ionos.es', port: 587, secure: false }, note: 'Your mailbox password.' },
  custom: { label: 'Own server / other', imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 587, secure: false }, note: 'Ask your provider for the IMAP and SMTP hosts.' }
};

/** Which preset fits a domain, judged by its MX hosts. 'microsoft' means: use the Microsoft button, passwords do not work there. */
export function presetForMx(mx: string[]): { preset: string; provider: string } {
  const h = mx.join(' ').toLowerCase();
  if (/titan\.email/.test(h)) return { preset: 'titan', provider: 'Titan Email' };
  if (/google(mail)?\.com/.test(h)) return { preset: 'google', provider: 'Google Workspace' };
  if (/protection\.outlook\.com|outlook\.com|office365\.com/.test(h)) return { preset: 'microsoft', provider: 'Microsoft 365' };
  if (/zoho\.eu/.test(h)) return { preset: 'zoho', provider: 'Zoho (EU)' };
  if (/zoho\.(com|in)/.test(h)) return { preset: 'zohoCom', provider: 'Zoho' };
  if (/hostinger/.test(h)) return { preset: 'hostinger', provider: 'Hostinger' };
  if (/privateemail\.com|registrar-servers\.com/.test(h)) return { preset: 'namecheap', provider: 'Namecheap Private Email' };
  if (/ionos|1and1|kundenserver/.test(h)) return { preset: 'ionos', provider: 'IONOS' };
  if (/icloud\.com|me\.com/.test(h)) return { preset: 'icloud', provider: 'iCloud' };
  return { preset: 'custom', provider: h ? 'own server / other' : 'unknown (no MX record)' };
}

const msg = (e: unknown): string => {
  const x = e as any;
  const parts = [String(x?.message ?? e)];
  if (x?.responseText) parts.push(String(x.responseText));
  if (x?.serverResponseCode) parts.push(`[${x.serverResponseCode}]`);
  if (x?.code && !x?.responseText) parts.push(`(${x.code})`);
  if (x?.authenticationFailed) parts.push('→ the server rejected the login. Use the full address as user and the mailbox password; on Titan also check Settings → Email clients that IMAP access is on.');
  return parts.join(' ').slice(0, 400);
};
const parseRefs = (v?: string) => (v ? v.match(/<[^>]+>/g) ?? [] : []);
const toDate = (v: unknown): Date => (v instanceof Date ? v : v ? new Date(v as string) : new Date());

function parseHeaderBlock(buf?: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (!buf) return out;
  const lines = buf.toString('utf8').replace(/\r\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * TLS from the first byte on 465; STARTTLS (and nothing less) on 587 and 25. The port decides, so a ticked "TLS" box with
 * port 587 cannot start a TLS handshake against a plaintext port and hang until the timeout. Other ports follow the box.
 */
export function smtpImplicitTls(port: number, secure: boolean): boolean {
  if (port === 465) return true;
  if (port === 587 || port === 25) return false;
  return secure;
}

/** The Sent folder of a mailbox: the server's special-use flag first, then the usual names. */
export function pickSentFolder(boxes: { path: string; name?: string; specialUse?: string }[]): string | null {
  const flagged = boxes.find((b) => b.specialUse === '\\Sent');
  if (flagged) return flagged.path;
  const byName = boxes.find((b) => /^(sent|sent items|sent mail|sent messages|enviados|elementos enviados|correos enviados|envoy[ée]s|gesendet)$/i.test(b.name ?? b.path.split(/[./]/).pop() ?? ''));
  if (byName) return byName.path;
  return boxes.find((b) => /sent|enviad/i.test(b.path))?.path ?? null;
}

/**
 * The exact bytes that go out: built once, sent over SMTP as-is, then appended to the Sent folder as-is. Our own
 * Message-ID (the thread key for replies), In-Reply-To/References for follow-ups, and the caller's headers (List-Unsubscribe).
 */
export async function composeRaw(account: Pick<EmailAccountDoc, 'address' | 'fromName'>, mail: OutboundMail, messageId: string, thread?: ThreadRef): Promise<Buffer> {
  const from = `"${account.fromName.replace(/"/g, '')}" <${account.address}>`;
  const composer = new MailComposer({
    from, to: mail.toName ? { name: mail.toName, address: mail.to } : mail.to, subject: mail.subject, text: mail.text, html: mail.html,
    messageId, inReplyTo: thread?.internetMessageId, references: thread ? [thread.internetMessageId] : undefined, date: new Date(),
    headers: { 'X-Hedwig-Send': mail.sendId, ...(mail.headers ?? {}) }
  });
  return composer.compile().build();
}

export class ImapSmtpProvider implements MailProvider {
  kind = 'imapSmtp' as const;
  constructor(private db: Db, private account: EmailAccountDoc) {}

  private secrets() { return open<ImapSmtpSecrets>(this.account.secrets); }
  private transporter() {
    const s = this.account.smtp!;
    const implicitTls = smtpImplicitTls(s.port, s.secure);
    return nodemailer.createTransport({
      host: s.host, port: s.port, secure: implicitTls, requireTLS: !implicitTls, auth: { user: s.user, pass: this.secrets().smtpPass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000
    });
  }
  private imap() {
    const i = this.account.imap!;
    return new ImapFlow({ host: i.host, port: i.port, secure: i.secure, auth: { user: i.user, pass: this.secrets().imapPass }, logger: false, emitLogs: false, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 } as any);
  }
  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.imap();
    await client.connect();
    try { return await fn(client); } finally { try { await client.logout(); } catch { /* ignore */ } }
  }

  async test() {
    const [smtp, imap] = await Promise.allSettled([
      this.transporter().verify(),
      this.withImap(async (client) => (await client.mailboxOpen('INBOX')).exists)
    ]);
    const parts: string[] = [];
    let ok = true;
    if (smtp.status === 'fulfilled') parts.push('SMTP login ok'); else { ok = false; parts.push(`SMTP: ${msg(smtp.reason)}`); }
    if (imap.status === 'fulfilled') parts.push(`IMAP ok · INBOX has ${imap.value} messages`); else { ok = false; parts.push(`IMAP: ${msg(imap.reason)}`); }
    return { ok, detail: parts.join(' · ') };
  }

  /**
   * SMTP submission, then a copy into the Sent folder over IMAP. SMTP servers other than Gmail's do not keep a copy by
   * themselves, so without the append the mailbox would show nothing sent and the reconciler (which confirms a crashed
   * send from the Sent folder) would have nothing to look at. The copy failing never fails the send: the email has left.
   */
  async send(mail: OutboundMail, thread?: ThreadRef, onPrepared?: (ids: SentInfo) => Promise<void>): Promise<SentInfo> {
    const domain = this.account.address.split('@')[1];
    const messageId = `<${mail.sendId}.${Date.now().toString(36)}@${domain}>`;
    const ids: SentInfo = { internetMessageId: messageId };
    if (onPrepared) await onPrepared(ids);
    const raw = await composeRaw(this.account, mail, messageId, thread);
    await this.transporter().sendMail({ envelope: { from: this.account.address, to: [mail.to] }, raw });
    try { await this.saveToSent(raw); }
    catch (e: any) { console.error(`[smtp] ${this.account.address}: sent ${messageId} but could not copy it to the Sent folder: ${e?.message ?? e}`); }
    return ids;
  }

  private async saveToSent(raw: Buffer): Promise<void> {
    await this.withImap(async (client) => {
      const path = pickSentFolder(await client.list());
      if (!path) throw new Error('no Sent folder on this server');
      await client.append(path, raw, ['\\Seen'], new Date());
    });
  }

  async fetchNew(state: SyncState, opts: { baseline: boolean }): Promise<{ items: InboundItem[]; state: SyncState }> {
    return this.withImap(async (client) => {
      const mb = await client.mailboxOpen('INBOX');
      const uidValidity = Number(mb.uidValidity);
      const uidNext = Number(mb.uidNext);
      let lastUid = state.lastUid;
      if (state.uidValidity !== undefined && state.uidValidity !== uidValidity) lastUid = undefined; // mailbox was rebuilt
      if (opts.baseline || lastUid === undefined) return { items: [], state: { ...state, uidValidity, lastUid: uidNext - 1, baselineDone: true } };
      if (uidNext - 1 <= lastUid) return { items: [], state: { ...state, uidValidity, baselineDone: true } };
      const items: InboundItem[] = [];
      let maxUid = lastUid;
      for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, internalDate: true, headers: ['in-reply-to', 'references', 'auto-submitted', 'x-auto-response-suppress', 'x-autoreply', 'precedence'] }, { uid: true })) {
        if (m.uid <= lastUid) continue;
        maxUid = Math.max(maxUid, m.uid);
        const h = parseHeaderBlock(m.headers as Buffer | undefined);
        const env = m.envelope;
        items.push({
          providerId: String(m.uid), from: String(env?.from?.[0]?.address ?? '').toLowerCase(), fromName: env?.from?.[0]?.name ?? undefined,
          subject: env?.subject ?? '', receivedAt: toDate(m.internalDate), internetMessageId: env?.messageId ?? undefined,
          inReplyTo: env?.inReplyTo ?? h['in-reply-to'], references: parseRefs(h['references']),
          autoSubmitted: h['auto-submitted'] ?? h['x-auto-response-suppress'] ?? h['x-autoreply']
        });
      }
      return { items, state: { ...state, uidValidity, lastUid: maxUid, baselineDone: true } };
    });
  }

  async getMessage(providerId: string): Promise<InboundFull> {
    return this.withImap(async (client) => {
      await client.mailboxOpen('INBOX');
      const m = await client.fetchOne(providerId, { source: true, uid: true, internalDate: true }, { uid: true });
      if (!m || !m.source) throw new Error(`IMAP message ${providerId} not found`);
      const p = await simpleParser(m.source);
      const headers: Record<string, string> = {};
      for (const [k, v] of p.headers) headers[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : (v as any)?.text ?? JSON.stringify(v);
      const fromAddr = String(p.from?.value?.[0]?.address ?? '').toLowerCase();
      const toList = Array.isArray(p.to) ? p.to : p.to ? [p.to] : [];
      const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
      return {
        providerId, from: fromAddr, fromName: p.from?.value?.[0]?.name, to: toList.flatMap((t) => t.value.map((a) => String(a.address ?? '').toLowerCase())),
        subject: p.subject ?? '', receivedAt: p.date ?? toDate(m.internalDate), internetMessageId: p.messageId, inReplyTo: p.inReplyTo,
        references: refs, autoSubmitted: headers['auto-submitted'] ?? headers['x-auto-response-suppress'] ?? headers['x-autoreply'],
        text: p.text ?? (p.html ? String(p.html).replace(/<[^>]+>/g, ' ') : ''), html: p.html ? String(p.html) : undefined, headers
      };
    });
  }

  async findSent(internetMessageId: string) {
    return this.withImap(async (client) => {
      const path = pickSentFolder(await client.list());
      if (!path) return { found: false };
      await client.mailboxOpen(path, { readOnly: true });
      const uids = await client.search({ header: { 'message-id': internetMessageId } }, { uid: true });
      return { found: Array.isArray(uids) && uids.length > 0 };
    });
  }
}
