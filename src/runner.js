import { q } from './db.js';
import { SOURCES } from './sources/index.js';
import { buildPackage } from './packager.js';
import { buildBundle } from './bundler.js';

const MAX = Number(process.env.MAX_CONCURRENT_JOBS || 3);
const active = new Map(); // locationId -> Promise (one job or package per location at a time)

export async function runJob(job) {
  const progress = job.progress || {};
  await q(`UPDATE jobs SET status='running', started_at=COALESCE(started_at, now()), error=NULL WHERE id=$1`, [job.id]);

  for (const name of job.sources) {
    const crawl = SOURCES[name];
    if (!crawl) continue;
    progress[name] ??= {};
    if (progress[name].status === 'done') continue;   // resumed job: skip finished sources
    progress[name].status = 'running';

    // save() runs after every page; it also acts as the cancel checkpoint.
    const save = async () => {
      const { rows: [cur] } = await q('UPDATE jobs SET progress=$2 WHERE id=$1 RETURNING status', [job.id, progress]);
      if (cur.status === 'cancelled') throw Object.assign(new Error('cancelled'), { cancelled: true });
    };
    try {
      await crawl({ jobId: job.id, locationId: job.location_id, progress: progress[name], save, since: job.since ? new Date(job.since).toISOString() : null });
      progress[name].status = 'done';
    } catch (err) {
      if (err.cancelled) { progress[name].status = 'paused'; await q('UPDATE jobs SET progress=$2 WHERE id=$1', [job.id, progress]); return; }
      progress[name].status = 'failed';
      progress[name].error = String(err.message).slice(0, 500);
      console.error(`[job ${job.id}] ${name} failed:`, err);
    }
    await save();
  }

  const failed = job.sources.some(s => progress[s]?.status === 'failed');
  await q(`UPDATE jobs SET status=$2, finished_at=now(), progress=$3 WHERE id=$1`,
    [job.id, failed ? 'failed' : 'done', progress]);
}

function launch(locationId, fn) {
  const p = fn().catch(err => console.error(`[worker ${locationId}]`, err)).finally(() => active.delete(locationId));
  active.set(locationId, p);
}

// Pick up work for locations that aren't already busy. Rate limits are per sub-account,
// so different locations run in parallel; within a location, exports and packages stay sequential.
export async function tick() {
  try {
    if (active.size >= MAX) return;
    const busy = [...active.keys()];
    const { rows: jobs } = await q(
      `SELECT * FROM jobs WHERE status IN ('queued','running') AND NOT (location_id = ANY($1::text[]))
       ORDER BY status DESC, id ASC`, [busy]);
    for (const job of jobs) {
      if (active.size >= MAX) return;
      if (active.has(job.location_id)) continue;
      launch(job.location_id, () => runJob(job));
    }
    if (active.size >= MAX) return;
    const { rows: pkgs } = await q(
      `SELECT * FROM packages WHERE status IN ('queued','running') AND NOT (location_id = ANY($1::text[]))
       ORDER BY status DESC, id ASC`, [[...active.keys()]]);
    for (const pkg of pkgs) {
      if (active.size >= MAX) return;
      if (active.has(pkg.location_id)) continue;
      launch(pkg.location_id, async () => {
        try { await buildPackage(pkg); }
        catch (err) { await q(`UPDATE packages SET status='failed', error=$2 WHERE id=$1`, [pkg.id, String(err.message).slice(0, 500)]); throw err; }
      });
    }
    // zip bundles: independent of GHL, keyed as 'bundle:<id>' so they can run beside a crawl for the same location
    if (active.size >= MAX) return;
    const { rows: bundles } = await q(`SELECT * FROM bundles WHERE status='queued' ORDER BY id ASC LIMIT 5`);
    for (const b of bundles) {
      if (active.size >= MAX) return;
      const slot = `bundle:${b.id}`;
      if (active.has(slot)) continue;
      launch(slot, () => buildBundle(b));
    }
  } catch (err) {
    // DB unreachable: one short line, try again next tick (no stack traces every 5s).
    const code = err.code || err.errors?.[0]?.code;
    if (code) console.error(`runner: database unreachable (${code}); will retry`);
    else console.error('runner error', err);
  }
}

export function startWorker() {
  setInterval(tick, 5000);
  tick();
}
