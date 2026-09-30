import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, cols, getDb } from '../../src/lib/server/db';
import * as providers from '../../src/lib/server/mail/provider';
import { deleteInbound, syncAccount } from '../../src/lib/server/inbox';
import type { EmailAccountDoc, LeadDoc, MessageDoc } from '../../src/lib/server/types';
let db: Db;
beforeAll(async () => { db = await getDb(); await db.dropDatabase(); });
afterAll(async () => { vi.restoreAllMocks(); await db.dropDatabase(); await closeDb(); });
it('clears a prior connection error after successful sync, preserving the cursor and recording new failures', async () => {
  const account = { _id: new ObjectId(), space: 'test', status: 'active', sync: { baselineDone: true, lastUid: 10, uidValidity: 1, lastError: 'Failed to establish connection in required time' } } as EmailAccountDoc;
  await cols(db).emailAccounts.insertOne(account);
  const fetchNew = vi.fn(async (state) => ({ items: [], state: { ...state, lastUid: 11 } }));
  vi.spyOn(providers, 'providerFor').mockReturnValue({ fetchNew } as any);
  await syncAccount(db, account);
  const saved = await cols(db).emailAccounts.findOne({ _id: account._id });
  expect(saved?.sync.lastError).toBeUndefined();
  expect(saved?.sync.lastUid).toBe(11);
  expect(saved?.sync.lastSyncAt).toBeInstanceOf(Date);
  fetchNew.mockRejectedValueOnce(new Error('Connection timed out again'));
  await expect(syncAccount(db, saved!)).rejects.toThrow('Connection timed out again');
  expect((await cols(db).emailAccounts.findOne({ _id: account._id }))?.sync.lastError).toBe('Connection timed out again');
});

it('removes inbound mail from the Inbox, recomputes the thread summary, and keeps sent mail and the lead status', async () => {
  const c = cols(db), space = 'test', campaignId = new ObjectId(), accountId = new ObjectId();
  const lead = { _id: new ObjectId(), space, campaignId, accountId, email: 'lead@example.com', vars: {}, status: 'interested', currentStep: 1 } as unknown as LeadDoc;
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
  const base = { space, campaignId, leadId: lead._id, accountId, to: 'lead@example.com', text: 'body', html: '' };
  const sent = { _id: new ObjectId(), ...base, direction: 'out', kind: 'sent', from: 'me@example.com', subject: 'Hello', at: at(1), internetMessageId: '<sent@example.com>' } as unknown as MessageDoc;
  const reply = { _id: new ObjectId(), ...base, direction: 'in', kind: 'reply', from: 'lead@example.com', subject: 'Re: Hello', at: at(2), ai: { status: 'done', label: 'interested', confidence: 0.9, at: at(2) } } as unknown as MessageDoc;
  const ooo = { _id: new ObjectId(), ...base, direction: 'in', kind: 'ooo', from: 'lead@example.com', subject: 'Out of office', at: at(3) } as unknown as MessageDoc;
  await c.messages.insertMany([sent, reply, ooo]);
  await c.leads.insertOne({ ...lead, lastInboundAt: at(3), lastInbound: { messageId: ooo._id, kind: 'ooo', subject: 'Out of office', snippet: 'body', at: at(3) }, inboundUnread: true, ai: { label: 'interested', confidence: 0.9, at: at(2), messageId: reply._id } });

  expect(await deleteInbound(db, lead, sent._id)).toEqual({ deleted: 0, threadGone: false });
  expect(await deleteInbound(db, lead, ooo._id)).toEqual({ deleted: 1, threadGone: false });
  let saved = await c.leads.findOne({ _id: lead._id });
  expect(saved?.lastInbound).toMatchObject({ messageId: reply._id, kind: 'reply', subject: 'Re: Hello' });
  expect(saved?.ai).toMatchObject({ label: 'interested', messageId: reply._id });

  expect(await deleteInbound(db, lead)).toEqual({ deleted: 1, threadGone: true });
  saved = await c.leads.findOne({ _id: lead._id });
  expect(saved?.status).toBe('interested');
  expect(saved?.lastInboundAt).toBeUndefined(); expect(saved?.lastInbound).toBeUndefined(); expect(saved?.inboundUnread).toBeUndefined(); expect(saved?.ai).toBeUndefined();
  expect(await c.messages.find({ leadId: lead._id }).toArray()).toHaveLength(1);
  expect(await deleteInbound(db, lead)).toEqual({ deleted: 0, threadGone: true });
});
