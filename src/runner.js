import { q } from './db.js';
import { SOURCES } from './sources/index.js';
import { buildPackage } from './packager.js';
import { buildBundle } from './bundler.js';
import { runPush } from './pusher.js';

const MAX = Number(process.env.MAX_CONCURRENT_JOBS || 8);
const active = new Map(); // locationId -> Promise (one job or package per location at a time)

export async function runJob(job) {
  const progress = job.progress || {};
  await q(`UPDATE jobs SET status='running', started_at=COALESCE(started_at, now()), error=NULL WHERE id=$1`, [job.id]);

  for (const name of job.sources) {
    const crawl = SOURCES[name];
    if (!crawl) continue;
    progress[name] ??= {};
    if (progress[name].status === 'done') continue;   // resumed job: skip finished sources
    progress[name].status = 'running'; delete progress[name].note;
    progress[name].at = new Date().toISOString();

    // save() runs after every page; it also acts as the cancel checkpoint.
    const save = async () => {
      progress[name].at = new Date().toISOString();   // heartbeat: the dashboard shows "last progress Xm ago"
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
      if (err.dailyLimit) {
        // Park the job (keeping its cursor) until the sub-account's daily quota resets, then tick() re-launches it.
        const resetAt = nextQuotaReset();
        progress[name].status = 'paused';
        progress[name].note = `daily API quota reached · resumes ${resetAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        delete progress[name].error;
        await q(`UPDATE jobs SET status='queued', not_before=$2, progress=$3 WHERE id=$1`, [job.id, resetAt, progress]);
        console.warn(`[job ${job.id}] ${job.location_id} hit GHL daily quota; parked until ${resetAt.toISOString()}`);
        return;
      }
      if (err.inactive) {
        // No point trying the other sources: the sub-account can't be read at all.
        for (const other of job.sources) if (progress[other]?.status !== 'done') progress[other] = { ...(progress[other] || {}), status: 'failed', error: 'skipped — sub-account inactive' };
        progress[name].error = err.message;
        await q(`UPDATE jobs SET status='failed', finished_at=now(), progress=$2, error=$3 WHERE id=$1`, [job.id, progress, 'inactive']);
        console.warn(`[job ${job.id}] location ${job.location_id} inactive; excluded from backups`);
        return;
      }
      console.error(`[job ${job.id}] ${name} failed:`, err);
    }
    await save();
  }

  const failed = job.sources.some(s => progress[s]?.status === 'failed');
  await q(`UPDATE jobs SET status=$2, finished_at=now(), progress=$3 WHERE id=$1`,
    [job.id, failed ? 'failed' : 'done', progress]);
}

// GHL's daily quota resets at midnight UTC (observed); add a margin. If a job is parked and
// still limited when it wakes, it is parked again for an hour at a time.
function nextQuotaReset() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 10));
  const inOneHour = new Date(now.getTime() + 60 * 60_000);
  return (midnight - now) < 90 * 60_000 ? inOneHour : midnight;   // woke just after midnight and still limited → hourly
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
      `SELECT * FROM jobs WHERE status IN ('queued','running') AND (not_before IS NULL OR not_before <= now()) AND NOT (location_id = ANY($1::text[]))
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
    // pushes into another sub-account: rate-limited on the TARGET; keyed by push id so a crawl of the
    // same location can run alongside (the per-location throttle is shared in-process anyway)
    if (active.size >= MAX) return;
    const { rows: pushes } = await q(`SELECT * FROM pushes WHERE status IN ('queued','running') AND (not_before IS NULL OR not_before <= now()) ORDER BY status DESC, id ASC LIMIT 5`);
    for (const p of pushes) {
      if (active.size >= MAX) return;
      const slot = `push:${p.id}`;
      if (active.has(slot)) continue;
      launch(slot, () => runPush(p));
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

// Watchdog: a running job whose progress hasn't advanced in STALL_MIN minutes is logged
// loudly. With request timeouts in ghl.js/storage.js this should not happen; if it does,
// Stop + Resume from the dashboard restarts it from its last checkpoint.
const STALL_MIN = Number(process.env.STALL_MINUTES || 30);
async function watchdog() {
  try {
    const { rows } = await q(`
      SELECT j.id, j.location_id, l.name,
             (SELECT max((v->>'at')::timestamptz) FROM jsonb_each(coalesce(j.progress,'{}')::jsonb) AS p(k,v) WHERE jsonb_typeof(v)='object') AS last_at
      FROM jobs j JOIN locations l ON l.location_id=j.location_id
      WHERE j.status='running'`);
    for (const r of rows) {
      const age = r.last_at ? (Date.now() - new Date(r.last_at)) / 60000 : null;
      if (age != null && age > STALL_MIN) console.warn(`[watchdog] job ${r.id} (${r.name}) no progress for ${Math.round(age)} min · in-memory=${active.has(r.location_id)}`);
    }
  } catch { /* best effort */ }
}

export function startWorker() {
  setInterval(tick, 5000);
  setInterval(watchdog, 5 * 60 * 1000);
  tick();
}
