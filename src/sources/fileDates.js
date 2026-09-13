// Backfill uploaded_at (Last-Modified from GHL storage) for files downloaded before we captured it.
import { q } from '../db.js';
import { getToken } from '../ghl.js';
import { limiter } from '../storage.js';

export async function fileDates(ctx) {
  const { locationId, progress, save } = ctx;
  progress.checked ??= 0; progress.dated ??= 0; progress.noHeader ??= 0;
  const run = limiter(16);
  while (true) {
    const { rows } = await q(`SELECT id, source_url, cdn_url FROM files WHERE location_id=$1 AND status='done' AND uploaded_at IS NULL AND (error IS NULL OR error <> 'no last-modified') ORDER BY id LIMIT 500`, [locationId]);
    if (!rows.length) break;
    await Promise.all(rows.map(f => run(async () => {
      const cdn = f.cdn_url || (f.source_url.includes('filesafe.space') ? f.source_url : null);
      const url = cdn || f.source_url;
      const headers = cdn ? {} : { Authorization: `Bearer ${await getToken(locationId)}`, Version: process.env.GHL_API_VERSION || '2021-07-28' };
      let lm = null;
      try { const r = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) }); lm = r.headers.get('last-modified'); } catch {}
      progress.checked++;
      if (lm && !isNaN(Date.parse(lm))) { progress.dated++; await q('UPDATE files SET uploaded_at=$2 WHERE id=$1', [f.id, new Date(lm)]); }
      else { progress.noHeader++; await q(`UPDATE files SET error='no last-modified' WHERE id=$1`, [f.id]); }
    })));
    await save();
  }
}
