import { describe, expect, it } from 'vitest';
import { composeRaw, pickSentFolder } from '../../src/lib/server/mail/imapSmtp';

const account = { address: 'me@example.com', fromName: 'Alex "the" Sender' };

describe('composeRaw', () => {
  it('carries our Message-ID, the from name, the thread headers and the unsubscribe headers', async () => {
    const raw = (await composeRaw(account, {
      to: 'lead@example.org', toName: 'Ana', subject: 'Hola', text: 'plain', html: '<p>html</p>', sendId: 'abc',
      headers: { 'List-Unsubscribe': '<https://t.example.com/u/tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    }, '<abc.xyz@example.com>', { internetMessageId: '<first@example.com>' })).toString('utf8');
    expect(raw).toMatch(/^Message-ID: <abc\.xyz@example\.com>$/m);
    expect(raw).toMatch(/^In-Reply-To: <first@example\.com>$/m);
    expect(raw).toMatch(/^References: <first@example\.com>$/m);
    expect(raw).toMatch(/^From: "?Alex the Sender"? <me@example\.com>$/m);
    expect(raw).toMatch(/^To: Ana <lead@example\.org>$/m);
    expect(raw).toMatch(/^List-Unsubscribe: <https:\/\/t\.example\.com\/u\/tok>$/m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(raw).toMatch(/^X-Hedwig-Send: abc$/m);
    expect(raw).toContain('plain');
    expect(raw).toContain('<p>html</p>');
  });
  it('sends a first step with no thread headers', async () => {
    const raw = (await composeRaw(account, { to: 'a@b.c', subject: 's', text: 't', html: '<p>t</p>', sendId: 'x' }, '<x.1@example.com>')).toString('utf8');
    expect(raw).not.toMatch(/^In-Reply-To:/m);
    expect(raw).not.toMatch(/^References:/m);
  });
});

describe('pickSentFolder', () => {
  it('prefers the special-use flag, then well-known names, then anything that looks like it', () => {
    expect(pickSentFolder([{ path: 'INBOX' }, { path: 'Outbox', specialUse: '\\Sent' }, { path: 'Sent' }])).toBe('Outbox');
    expect(pickSentFolder([{ path: 'INBOX' }, { path: 'Sent', name: 'Sent' }])).toBe('Sent');
    expect(pickSentFolder([{ path: 'INBOX' }, { path: 'INBOX.Elementos enviados', name: 'Elementos enviados' }])).toBe('INBOX.Elementos enviados');
    expect(pickSentFolder([{ path: 'INBOX' }, { path: 'Archive/sent-2025' }])).toBe('Archive/sent-2025');
    expect(pickSentFolder([{ path: 'INBOX' }, { path: 'Drafts' }])).toBeNull();
  });
});
