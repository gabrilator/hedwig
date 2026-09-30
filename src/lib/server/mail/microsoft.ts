import type { Db } from 'mongodb';
import { cols } from '../db';
import { env, envOpt } from '../env';
import { open, seal } from '../crypto';
import type { EmailAccountDoc } from '../types';
import type { InboundFull, InboundItem, MailProvider, OutboundMail, SentInfo, SyncState, ThreadRef } from './types';

export const MS_SCOPES = ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'];
const GRAPH = 'https://graph.microsoft.com/v1.0';
const tenant = () => envOpt('MS_TENANT_ID') ?? 'common';
const authority = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;
export const msRedirectUri = () => `${env('ORIGIN').replace(/\/$/, '')}/emails/microsoft/callback`;

export interface MsTokens { accessToken: string; refreshToken: string; expiresAt: number; scope?: string }

export function msAuthUrl(state: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_id: env('MS_CLIENT_ID'), response_type: 'code', redirect_uri: msRedirectUri(), response_mode: 'query',
    scope: MS_SCOPES.join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account'
  });
  return `${authority()}/authorize?${p.toString()}`;
}
async function tokenRequest(body: Record<string, string>): Promise<MsTokens> {
  const res = await fetch(`${authority()}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('MS_CLIENT_ID'), client_secret: env('MS_CLIENT_SECRET'), ...body })
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft login failed: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + (Number(json.expires_in ?? 3600) - 90) * 1000, scope: json.scope };
}
export const msExchangeCode = (code: string, codeVerifier: string) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: msRedirectUri(), code_verifier: codeVerifier, scope: MS_SCOPES.join(' ') });
export const msRefresh = (refreshToken: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: MS_SCOPES.join(' ') });

export async function msProfile(accessToken: string): Promise<{ address: string; name: string; id: string }> {
  const r = await fetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, { headers: { authorization: `Bearer ${accessToken}` } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Graph /me failed: ${j?.error?.message ?? r.status}`);
  return { address: String(j.mail ?? j.userPrincipalName ?? '').toLowerCase(), name: j.displayName ?? '', id: j.id };
}

const odata = (s: string) => s.replace(/'/g, "''");
const parseRefs = (v?: string) => (v ? v.match(/<[^>]+>/g) ?? [] : []);

export class MicrosoftProvider implements MailProvider {
  kind = 'microsoft' as const;
  constructor(private db: Db, private account: EmailAccountDoc) {}

  private async token(): Promise<string> {
    let t = open<MsTokens>(this.account.secrets);
    if (!t.accessToken || Date.now() > t.expiresAt) {
      const fresh = await msRefresh(t.refreshToken);
      t = { ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken };
      this.account.secrets = seal(t);
      await cols(this.db).emailAccounts.updateOne({ _id: this.account._id }, { $set: { secrets: this.account.secrets } });
    }
    return t.accessToken;
  }
  private async graph<T = any>(path: string, init: RequestInit & { prefer?: string } = {}, retry = true): Promise<T> {
    const token = await this.token();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.prefer ? { Prefer: init.prefer } : {}),
      ...((init.headers as Record<string, string>) ?? {})
    };
    const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429 && retry) {
      const wait = Math.min(30, Number(res.headers.get('retry-after') ?? '5'));
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.graph(path, init, false);
    }
    if (res.status === 202 || res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!res.ok) throw new Error(`Graph ${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text.slice(0, 200)}`.trim());
    return json as T;
  }

  async test() {
    try {
      const me = await this.graph('/me?$select=mail,userPrincipalName,displayName');
      const inbox = await this.graph('/me/mailFolders/inbox?$select=totalItemCount');
      return { ok: true, detail: `Connected as ${me.mail ?? me.userPrincipalName} · inbox has ${inbox.totalItemCount} messages` };
    } catch (e: any) { return { ok: false, detail: e.message }; }
  }

  private recipients(mail: OutboundMail) { return [{ emailAddress: { address: mail.to, name: mail.toName || undefined } }]; }

  async send(mail: OutboundMail, thread?: ThreadRef, onPrepared?: (ids: SentInfo) => Promise<void>): Promise<SentInfo> {
    if (thread) {
      const prev = await this.graph(`/me/messages?$filter=internetMessageId eq '${odata(thread.internetMessageId)}'&$select=id,conversationId&$top=1`);
      const prevId = prev?.value?.[0]?.id as string | undefined;
      if (prevId) {
        const draft = await this.graph(`/me/messages/${prevId}/createReply`, { method: 'POST', body: '{}' });
        await this.graph(`/me/messages/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body: { contentType: 'HTML', content: mail.html }, toRecipients: this.recipients(mail), ccRecipients: [], bccRecipients: [] })
        });
        const ids = { internetMessageId: draft.internetMessageId, conversationId: draft.conversationId ?? thread.conversationId, providerMessageId: draft.id };
        if (onPrepared) await onPrepared(ids);
        await this.graph(`/me/messages/${draft.id}/send`, { method: 'POST' });
        return ids;
      }
    }
    const draft = await this.graph('/me/messages', {
      method: 'POST',
      body: JSON.stringify({
        subject: mail.subject, body: { contentType: 'HTML', content: mail.html }, toRecipients: this.recipients(mail),
        internetMessageHeaders: [{ name: 'X-Hedwig-Send', value: mail.sendId }]
      })
    });
    const ids = { internetMessageId: draft.internetMessageId, conversationId: draft.conversationId, providerMessageId: draft.id };
    if (onPrepared) await onPrepared(ids);
    await this.graph(`/me/messages/${draft.id}/send`, { method: 'POST' });
    return ids;
  }

  async fetchNew(state: SyncState, opts: { baseline: boolean }): Promise<{ items: InboundItem[]; state: SyncState }> {
    const select = '$select=id,subject,from,receivedDateTime,conversationId,internetMessageId,bodyPreview,isDraft';
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    let url = state.deltaLink ?? `${GRAPH}/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge ${since}&${select}`;
    const items: InboundItem[] = [];
    let deltaLink: string | undefined;
    for (let page = 0; page < 200; page++) {
      const res = await this.graph(url, { prefer: 'odata.maxpagesize=50' });
      for (const m of res?.value ?? []) {
        if (m['@removed'] || m.isDraft) continue;
        items.push({
          providerId: m.id, from: String(m.from?.emailAddress?.address ?? '').toLowerCase(), fromName: m.from?.emailAddress?.name,
          subject: m.subject ?? '', receivedAt: new Date(m.receivedDateTime), conversationId: m.conversationId,
          internetMessageId: m.internetMessageId, preview: m.bodyPreview
        });
      }
      if (res?.['@odata.nextLink']) { url = res['@odata.nextLink']; continue; }
      deltaLink = res?.['@odata.deltaLink'];
      break;
    }
    const next: SyncState = { ...state, deltaLink: deltaLink ?? state.deltaLink, baselineDone: true };
    return { items: opts.baseline ? [] : items, state: next };
  }

  async getMessage(providerId: string): Promise<InboundFull> {
    const m = await this.graph(`/me/messages/${providerId}?$select=id,subject,from,toRecipients,receivedDateTime,conversationId,internetMessageId,body,bodyPreview,internetMessageHeaders`, { prefer: 'outlook.body-content-type="text"' });
    const headers: Record<string, string> = {};
    for (const h of m.internetMessageHeaders ?? []) headers[String(h.name).toLowerCase()] = h.value;
    return {
      providerId: m.id, from: String(m.from?.emailAddress?.address ?? '').toLowerCase(), fromName: m.from?.emailAddress?.name,
      to: (m.toRecipients ?? []).map((r: any) => String(r.emailAddress?.address ?? '').toLowerCase()),
      subject: m.subject ?? '', receivedAt: new Date(m.receivedDateTime), conversationId: m.conversationId, internetMessageId: m.internetMessageId,
      inReplyTo: headers['in-reply-to'], references: parseRefs(headers['references']),
      autoSubmitted: headers['auto-submitted'] ?? headers['x-auto-response-suppress'] ?? headers['x-autoreply'] ?? headers['x-autorespond'],
      text: m.body?.content ?? m.bodyPreview ?? '', html: undefined, headers, preview: m.bodyPreview
    };
  }

  async findSent(internetMessageId: string) {
    const r = await this.graph(`/me/mailFolders/sentitems/messages?$filter=internetMessageId eq '${odata(internetMessageId)}'&$select=id,sentDateTime&$top=1`);
    const m = r?.value?.[0];
    return m ? { found: true, sentAt: new Date(m.sentDateTime) } : { found: false };
  }
}
