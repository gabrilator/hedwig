import type { Db } from 'mongodb';
import { cols } from './db';
import type { JobRunDoc } from './types';

/**
 * Enqueue a job for the worker by inserting an Agenda-shaped document.
 * The web process never runs jobs; the worker's Agenda instance claims this within its processEvery.
 */
export async function enqueue(db: Db, name: string, data: Record<string, unknown> = {}): Promise<void> {
  await cols(db).agendaJobs.insertOne({
    name, data, type: 'normal', priority: 0, nextRunAt: new Date(), lockedAt: null, lastModifiedBy: 'web', createdAt: new Date()
  });
}

export const HEARTBEAT_STALE_SEC = 300;

export async function workerStatus(db: Db) {
  const c = cols(db);
  const [hb, runs, jobs] = await Promise.all([
    c.heartbeat.findOne({ _id: 'worker' }),
    c.jobRuns.find({}, { sort: { startedAt: -1 }, limit: 30 }).toArray(),
    c.agendaJobs.find({ repeatInterval: { $exists: true } }, { projection: { name: 1, nextRunAt: 1, lastRunAt: 1, lastFinishedAt: 1, failCount: 1, failReason: 1, lockedAt: 1, repeatInterval: 1 } }).toArray()
  ]);
  const ageSec = hb ? Math.round((Date.now() - new Date(hb.at).getTime()) / 1000) : null;
  return { heartbeat: hb, ageSec, stale: ageSec === null || ageSec > HEARTBEAT_STALE_SEC, runs, jobs };
}

/** Wraps a job handler so every run is recorded with counts or the error. */
export async function withRun<T extends Record<string, number> | void>(db: Db, job: string, fn: () => Promise<T>): Promise<T> {
  const c = cols(db);
  const startedAt = new Date();
  const { insertedId } = await c.jobRuns.insertOne({ job, startedAt } as JobRunDoc);
  try {
    const counts = await fn();
    await c.jobRuns.updateOne({ _id: insertedId }, { $set: { finishedAt: new Date(), ok: true, counts: (counts ?? undefined) as any } });
    return counts;
  } catch (e: any) {
    await c.jobRuns.updateOne({ _id: insertedId }, { $set: { finishedAt: new Date(), ok: false, error: String(e?.message ?? e).slice(0, 2000) } });
    throw e;
  }
}
