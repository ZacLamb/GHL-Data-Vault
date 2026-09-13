// Builds zip parts into R2 so the browser downloads straight from Cloudflare (no proxy timeouts).
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { q } from './db.js';
import { getObjectStream, uploadStream, listObjects } from './storage.js';

export const PART_FILES = Number(process.env.ZIP_PART_FILES || 2000);

export async function queueBundles(locationId, scope) {
  const rows = await bundleRows(locationId, scope);
  const total = Math.max(1, Math.ceil(rows.length / PART_FILES));
  await q(`DELETE FROM bundles WHERE location_id=$1 AND scope=$2`, [locationId, scope]);
  for (let i = 0; i < total; i++) {
    const n = Math.min(PART_FILES, rows.length - i * PART_FILES);
    await q(`INSERT INTO bundles (location_id, scope, part, total_parts, file_count) VALUES ($1,$2,$3,$4,$5)`, [locationId, scope, i + 1, total, n]);
  }
  return total;
}

export async function bundleRows(locationId, scope) {
  if (scope.startsWith('package:')) {
    const { rows: [pkg] } = await q('SELECT r2_prefix FROM packages WHERE id=$1', [scope.slice(8)]);
    if (!pkg?.r2_prefix) return [];
    const out = []; for await (const o of listObjects(pkg.r2_prefix + '/')) out.push({ key: o.Key, name: o.Key.replace(pkg.r2_prefix + '/', '') });
    return out;
  }
  const { rows } = await q(`SELECT r2_key FROM files WHERE location_id=$1 AND status='done' AND r2_key IS NOT NULL ORDER BY r2_key`, [locationId]);
  return rows.map(r => ({ key: r.r2_key, name: r.r2_key }));
}

export async function buildBundle(b) {
  await q(`UPDATE bundles SET status='running', error=NULL WHERE id=$1`, [b.id]);
  try {
    const rows = (await bundleRows(b.location_id, b.scope)).slice((b.part - 1) * PART_FILES, b.part * PART_FILES);
    const key = `exports/${b.location_id}/${b.scope.replace(':', '-')}/part-${b.part}-of-${b.total_parts}.zip`;
    const zip = archiver('zip', { store: true });
    const out = new PassThrough();
    zip.pipe(out);
    const uploading = uploadStream(key, out);
    const missing = [];
    (async () => {
      for (const { key: k, name } of rows) {
        let body;
        try { body = await getObjectStream(k); } catch (err) { missing.push(`${k}\t${err.name || err.message}`); continue; }
        await new Promise((res, rej) => { body.once('error', rej); zip.append(body, { name }); zip.once('entry', res); }).catch(err => missing.push(`${k}\t${err.message}`));
      }
      if (missing.length) zip.append(missing.join('\n'), { name: '_missing.txt' });
      zip.finalize();
    })().catch(err => zip.emit('error', err));
    const bytes = await uploading;
    await q(`UPDATE bundles SET status='done', r2_key=$2, bytes=$3, finished_at=now() WHERE id=$1`, [b.id, key, bytes]);
  } catch (err) {
    await q(`UPDATE bundles SET status='failed', error=$2 WHERE id=$1`, [b.id, String(err.message).slice(0, 500)]);
  }
}
