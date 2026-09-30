/**
 * Hedwig worker: the only scheduler. Runs Agenda (MongoDB-backed) with the jobs below.
 * Start: node build-worker/index.js (production, env from the host)   ·   dev: npm run worker
 */
import { Agenda, backoffStrategies } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import { hostname } from 'node:os';
import { cols, ensureIndexes, getDb } from '../lib/server/db';
import { withRun } from '../lib/server/jobs';
import { completeFinishedCampaigns, planAll } from '../lib/server/planner';
import { reconcileClaims, runSender } from '../lib/server/sender';
import { backfillInbound, syncAccount, syncAll } from '../lib/server/inbox';
import { classifyPending } from '../lib/server/agent';
import { checkDomainDns, detectProvider } from '../lib/server/dns';
import { rebuildDailyStats } from '../lib/server/stats';
import { assignMailboxZones, domainOf } from '../lib/server/accounts';
import { markCurious } from '../lib/server/curious';
import { ObjectId } from 'mongodb';

const VERSION = process.env.npm_package_version ?? '0.1.0';

async function main() {
  const db = await getDb();
  await ensureIndexes(db);
  const c = cols(db);
  const agenda = new Agenda({
    backend: new MongoBackend({ mongo: db, collection: 'agendaJobs' }),
    processEvery: '5 seconds', defaultLockLifetime: 10 * 60_000, maxConcurrency: 4, defaultConcurrency: 1
  });

  agenda.define('tick', async () => {
    await withRun(db, 'tick', async () => {
      const now = new Date();
      const plan = await planAll(db, now);
      const sent = await runSender(db, now, { maxPerTick: 60 });
      const completed = await completeFinishedCampaigns(db);
      if (plan.notes.length) console.log('[tick]', plan.notes.join(' | '));
      return { planned: plan.planned, sent: sent.sent, failed: sent.failed, skipped: sent.skipped, completed };
    });
  }, { lockLifetime: 5 * 60_000, concurrency: 1 });

  agenda.define('inbox-sync', async () => {
    await withRun(db, 'inbox-sync', async () => {
      const r = await syncAll(db);
      const ai = r.replies ? await classifyPending(db) : { done: 0, failed: 0 };
      return { accounts: r.accounts, items: r.items, replies: r.replies, bounces: r.bounces, ooo: r.ooo, ignored: r.ignored, errors: r.errors, labelled: ai.done, labelFailed: ai.failed };
    });
  }, { lockLifetime: 9 * 60_000, concurrency: 1 });

  agenda.define<{ accountId: string }>('sync-account', async (job) => {
    await withRun(db, 'sync-account', async () => {
      const account = await c.emailAccounts.findOne({ _id: new ObjectId(job.attrs.data.accountId) });
      if (!account) return { accounts: 0, items: 0, replies: 0, bounces: 0, ooo: 0, ignored: 0, labelled: 0 };
      const r = await syncAccount(db, account);
      const ai = r.replies ? await classifyPending(db) : { done: 0 };
      return { accounts: 1, items: r.items, replies: r.replies, bounces: r.bounces, ooo: r.ooo, ignored: r.ignored, labelled: ai.done };
    });
  }, { lockLifetime: 5 * 60_000, removeOnComplete: true, backoff: backoffStrategies.exponential({ delay: 30_000, maxRetries: 2 }) });

  // The reply agent's sweeper: replies still waiting (a retry after a model error, a stale claim, a cap that lifted at midnight).
  agenda.define('classify-replies', async () => {
    await withRun(db, 'classify-replies', async () => {
      const r = await classifyPending(db, { limit: 20 });
      return { waiting: r.waiting, labelled: r.done, failed: r.failed, skipped: r.skipped };
    });
  }, { lockLifetime: 9 * 60_000, concurrency: 1 });

  agenda.define('reconcile', async () => {
    await withRun(db, 'reconcile', async () => reconcileClaims(db, new Date()));
  }, { lockLifetime: 5 * 60_000 });

  agenda.define('stats-verify', async () => {
    await withRun(db, 'stats-verify', async () => ({ rows: await rebuildDailyStats(db, new Date(Date.now() - 2 * 864e5)) }));
  }, { lockLifetime: 10 * 60_000 });

  agenda.define<{ accountId?: string }>('dns-check', async (job) => {
    await withRun(db, 'dns-check', async () => {
      const filter = job.attrs.data?.accountId ? { _id: new ObjectId(job.attrs.data.accountId) } : {};
      const accounts = await c.emailAccounts.find(filter).toArray();
      for (const a of accounts) {
        const hint = a.kind === 'microsoft' ? 'microsoft' : /gmail|google/i.test(a.smtp?.host ?? '') ? 'google' : 'other';
        const dns = await checkDomainDns(domainOf(a.address), hint);
        await c.emailAccounts.updateOne({ _id: a._id }, { $set: { dns } });
      }
      return { accounts: accounts.length };
    });
  }, { lockLifetime: 5 * 60_000, removeOnComplete: true });

  // Once a day: people who opened more often than they got emails, with no reply, get the curious flag.
  agenda.define('curious', async () => {
    await withRun(db, 'curious', async () => ({ marked: await markCurious(db) }));
  }, { lockLifetime: 5 * 60_000 });

  agenda.define<{ campaignId: string }>('enrich-leads', async (job) => {
    await withRun(db, 'enrich-leads', async () => {
      const campaignId = new ObjectId(job.attrs.data.campaignId);
      const domains = await c.leads.distinct('domain', { campaignId, provider: 'unknown' });
      let looked = 0;
      for (const domain of domains) {
        let cached = await c.domains.findOne({ _id: domain });
        if (!cached || Date.now() - new Date(cached.checkedAt).getTime() > 30 * 864e5) {
          const r = await detectProvider(domain);
          cached = { _id: domain, provider: r.provider, mx: r.mx, checkedAt: new Date() };
          await c.domains.updateOne({ _id: domain }, { $set: cached }, { upsert: true });
          looked++;
        }
        await c.leads.updateMany({ campaignId, domain, provider: 'unknown' }, { $set: { provider: cached.provider } });
      }
      return { domains: domains.length, lookedUp: looked };
    });
  }, { lockLifetime: 15 * 60_000, removeOnComplete: true });

  agenda.on('fail', (err, job) => console.error(`[agenda] ${job.attrs.name} failed: ${err.message}`));
  agenda.on('error', (err) => console.error('[agenda] error', err));

  try { const b = await backfillInbound(db); if (b.leads || b.queued) console.log(`[hedwig-worker] inbox backfill: ${b.leads} leads summarised, ${b.queued} replies queued for the agent`); }
  catch (e) { console.error('[hedwig-worker] inbox backfill failed', e); }
  try { const n = await assignMailboxZones(db); if (n) console.log(`[hedwig-worker] ${n} mailbox(es) got the day of the campaign that uses them`); }
  catch (e) { console.error('[hedwig-worker] mailbox zone assignment failed', e); }

  await agenda.start();
  await agenda.every('1 minute', 'tick');
  await agenda.every('2 minutes', 'inbox-sync');
  await agenda.every('5 minutes', 'classify-replies');
  await agenda.every('5 minutes', 'reconcile');
  await agenda.every('1 hour', 'stats-verify');
  await agenda.every('0 6 * * *', 'dns-check', {}, { timezone: 'UTC' }); // daily, host-independent; campaigns carry their own zones
  await agenda.every('30 6 * * *', 'curious', {}, { timezone: 'UTC' });

  const beat = async () => {
    try { await c.heartbeat.updateOne({ _id: 'worker' }, { $set: { at: new Date(), version: VERSION, pid: process.pid, host: hostname() } }, { upsert: true }); }
    catch (e) { console.error('[heartbeat]', e); }
  };
  await beat();
  const beatTimer = setInterval(beat, 30_000);
  console.log(`[hedwig-worker] up · v${VERSION} · pid ${process.pid}`);

  const shutdown = async (sig: string) => {
    console.log(`[hedwig-worker] ${sig}: draining…`);
    clearInterval(beatTimer);
    try { await agenda.drain(20_000); await agenda.stop(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => { console.error('[hedwig-worker] fatal', e); process.exit(1); });
