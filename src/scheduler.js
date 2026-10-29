// Monthly agency-wide backup. Runs inside the web process; survives restarts because state lives in `settings`.
import { q } from './db.js';
import { importAgencyLocations } from './ghl.js';
import { ALL_SOURCES } from './sources/index.js';

export const DEFAULTS = { enabled: true, day: 1, hour: 2, sources: ['contact_fields', 'opportunity_fields', 'conversations', 'forms', 'surveys', 'media', 'documents', 'usage'], mode: 'incremental', importFirst: true };

// One schedule per hub account (settings keys backup_schedule:<owner>, backup_last:<owner>).
export async function getSchedule(ownerId) {
  const { rows: [r] } = await q(`SELECT value FROM settings WHERE key=$1`, [`backup_schedule:${ownerId}`]);
  const { rows: [last] } = await q(`SELECT value FROM settings WHERE key=$1`, [`backup_last:${ownerId}`]);
  return { ...DEFAULTS, ...(r?.value || {}), last: last?.value || null };
}
export async function setSchedule(ownerId, patch) {
  const cur = await getSchedule(ownerId); delete cur.last;
  const next = { ...cur, ...patch };
  next.day = Math.min(28, Math.max(1, Number(next.day) || 1)); next.hour = Math.min(23, Math.max(0, Number(next.hour) || 0));
  next.sources = (next.sources || []).filter(s => ALL_SOURCES.includes(s));
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [`backup_schedule:${ownerId}`, next]);
  return next;
}

/** Queue a backup for every enabled location. Returns counts. Used by the schedule and the "Backup all now" button. */
export async function backupAll(ownerId, { mode, sources, importFirst, trigger = 'manual' } = {}) {
  const sch = await getSchedule(ownerId);
  mode ??= sch.mode; sources ??= sch.sources; importFirst ??= sch.importFirst;
  let imported = null;
  if (importFirst) { try { imported = await importAgencyLocations(ownerId); } catch (err) { imported = { error: err.message }; } }
  const { rows: locs } = await q(`SELECT location_id FROM locations WHERE backup_enabled AND owner_id=$1 ORDER BY name NULLS LAST`, [ownerId]);
  let queued = 0, skipped = 0;
  for (const { location_id } of locs) {
    const { rows: busy } = await q(`SELECT 1 FROM jobs WHERE location_id=$1 AND status IN ('queued','running') LIMIT 1`, [location_id]);
    if (busy.length) { skipped++; continue; }
    let since = null;
    if (mode === 'incremental') {
      const { rows: [last] } = await q(`SELECT started_at FROM jobs WHERE location_id=$1 AND status='done' AND NOT (sources <@ ARRAY['notes']::text[]) ORDER BY id DESC LIMIT 1`, [location_id]);
      if (last) since = new Date(new Date(last.started_at).getTime() - 60 * 60_000);   // never backed up → full crawl
    }
    await q(`INSERT INTO jobs (location_id, sources, since, trigger) VALUES ($1,$2,$3,$4)`, [location_id, sources, since, trigger]);
    queued++;
  }
  const summary = { at: new Date(), trigger, mode, queued, skipped, imported };
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [`backup_last:${ownerId}`, summary]);
  return summary;
}

// Fires when local (TZ env, default UTC) date/hour match and nothing has fired yet this month.
export function startScheduler() {
  const check = async () => {
    try {
      const now = new Date();
      const tz = process.env.TZ || 'UTC';
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', hour: 'numeric', hour12: false, month: 'numeric', year: 'numeric' }).formatToParts(now).map(p => [p.type, p.value]));
      const stamp = `${parts.year}-${parts.month}`;
      const { rows: owners } = await q(`SELECT DISTINCT owner_id FROM locations WHERE owner_id IS NOT NULL`);
      for (const { owner_id } of owners) {
        const sch = await getSchedule(owner_id);
        if (!sch.enabled) continue;
        if (Number(parts.day) !== sch.day || Number(parts.hour) % 24 !== sch.hour) continue;
        if (sch.last?.trigger === 'scheduled' && sch.last?.stamp === stamp) continue;
        try {   // one account's failure must not stop the others' monthly backups
          const summary = await backupAll(owner_id, { trigger: 'scheduled' });
          await q(`UPDATE settings SET value = value || $2 WHERE key=$1`, [`backup_last:${owner_id}`, { stamp }]);
          console.log(`[scheduler] owner ${owner_id}: monthly backup queued: ${summary.queued} locations (${summary.skipped} busy)`);
        } catch (err) { console.error(`[scheduler] owner ${owner_id}:`, err.message); }
      }
    } catch (err) { console.error('[scheduler]', err.message); }
  };
  setInterval(check, 5 * 60_000);
  check();
}
