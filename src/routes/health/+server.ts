import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { workerStatus } from '$lib/server/jobs';

export const GET: RequestHandler = async () => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const w = await workerStatus(db);
    return json({ ok: true, db: true, worker: { alive: !w.stale, lastHeartbeatSec: w.ageSec } });
  } catch (e: any) {
    return json({ ok: false, error: e.message }, { status: 503 });
  }
};
