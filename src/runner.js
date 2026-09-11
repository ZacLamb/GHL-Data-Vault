import { q } from './db.js';
import { SOURCES } from './sources/index.js';
import { buildPackage } from './packager.js';

let running = false;

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
      await crawl({ jobId: job.id, locationId: job.location_id, progress: progress[name], save });
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

// Simple in-process worker. One job at a time keeps us well inside GHL rate limits;
// bump to a pool if you want parallel locations.
export async function tick() {
  if (running) return;
  running = true;
  try {
    // On boot, anything left 'running' from a previous container is resumed from its saved cursors.
    const { rows } = await q(`SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY status DESC, id ASC LIMIT 1`);
    if (rows[0]) { await runJob(rows[0]); return; }
    const { rows: pkgs } = await q(`SELECT * FROM packages WHERE status IN ('queued','running') ORDER BY status DESC, id ASC LIMIT 1`);
    if (pkgs[0]) {
      try { await buildPackage(pkgs[0]); }
      catch (err) { console.error(`[package ${pkgs[0].id}]`, err); await q(`UPDATE packages SET status='failed', error=$2 WHERE id=$1`, [pkgs[0].id, String(err.message).slice(0, 500)]); }
    }
  } catch (err) {
    console.error('runner error', err);
  } finally {
    running = false;
  }
}

export function startWorker() {
  setInterval(tick, 5000);
  tick();
}
