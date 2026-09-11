import { q } from './db.js';
import { copyObject, putText, limiter } from './storage.js';
import { buildFilter } from './analytics.js';

export const PACKAGE_SIZES = [1000, 5000, 10000, 20000, 50000, 100000];
const csvCell = v => v == null ? '' : `"${String(Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v).replace(/"/g, '""')}"`;
const safe = s => String(s || '').replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120);

/** Queue a package: pick N random contacts that aren't in any package yet and lock them in. */
export async function createPackage(locationId, size, label, filters = {}) {
  const { rows: [pkg] } = await q(`INSERT INTO packages (location_id, requested_size, label, progress) VALUES ($1,$2,$3,$4) RETURNING *`,
    [locationId, size, label || null, { filters }]);

  // Random sample of unassigned contacts matching the filter (if any).
  const { sql, params } = buildFilter(locationId, { ...filters, unassigned: true });
  params.push(pkg.id, size);
  const { rowCount } = await q(`
    INSERT INTO package_contacts (package_id, location_id, contact_id)
    SELECT $${params.length - 1}, c.location_id, c.contact_id
    FROM contacts c
    WHERE ${sql}
    ORDER BY random()
    LIMIT $${params.length}`, params);

  await q(`UPDATE packages SET contact_count=$2 WHERE id=$1`, [pkg.id, rowCount]);
  return { ...pkg, contact_count: rowCount };
}

/** Worker step: materialise the package in R2 (contacts.csv, manifest.csv, copied files). Resumable. */
export async function buildPackage(pkg) {
  const prefix = `packages/${pkg.location_id}/pkg-${pkg.id}`;
  const progress = pkg.progress || {};
  await q(`UPDATE packages SET status='running', r2_prefix=$2, error=NULL WHERE id=$1`, [pkg.id, prefix]);
  const save = () => q(`UPDATE packages SET progress=$2 WHERE id=$1`, [pkg.id, progress]);

  // 1. contacts.csv — GHL-importable column names, plus flattened custom fields.
  const { rows: contacts } = await q(`
    SELECT c.* FROM contacts c JOIN package_contacts pc ON pc.location_id=c.location_id AND pc.contact_id=c.contact_id
    WHERE pc.package_id=$1 ORDER BY c.contact_id`, [pkg.id]);
  const customKeys = [...new Set(contacts.flatMap(c => Object.keys(c.custom || {})))].sort();
  const base = ['Contact Id','First Name','Last Name','Email','Phone','Company Name','Address','City','State','Postal Code','Tags','Date Added','File Count'];
  const lines = [[...base, ...customKeys].map(csvCell).join(',')];
  for (const c of contacts) lines.push([
    c.contact_id, c.first_name, c.last_name, c.email, c.phone, c.company, c.address, c.city, c.state, c.postal_code,
    c.tags, c.date_added?.toISOString?.(), c.file_count, ...customKeys.map(k => c.custom?.[k]),
  ].map(csvCell).join(','));
  await putText(`${prefix}/contacts.csv`, lines.join('\n'));

  // 2. Copy files into a per-contact folder inside the package, and write the package manifest.
  const { rows: files } = await q(`
    SELECT f.* FROM files f JOIN package_contacts pc ON pc.location_id=f.location_id AND pc.contact_id=f.contact_id
    WHERE pc.package_id=$1 AND f.status='done' AND f.r2_key IS NOT NULL ORDER BY f.id`, [pkg.id]);

  const run = limiter(Number(process.env.COPY_CONCURRENCY || 32));
  progress.copied ??= 0; progress.total = files.length; progress.failed ??= [];
  const doneSet = new Set(progress.doneIds || []);
  const manifest = [['contact_id','field_name','original_filename','mime_type','size_bytes','package_path','vault_key'].join(',')];
  let pending = [];

  for (const f of files) {
    const dest = `${prefix}/${safe(f.contact_id)}/${safe(f.field_name || f.source)}/${safe(f.original_filename) || f.r2_key.split('/').pop()}`;
    manifest.push([f.contact_id, f.field_name, f.original_filename, f.mime_type, f.size_bytes, dest.replace(prefix + '/', ''), f.r2_key].map(csvCell).join(','));
    if (doneSet.has(f.id)) continue;
    pending.push(run(async () => {
      try { await copyObject(f.r2_key, dest); doneSet.add(f.id); progress.copied++; }
      catch (err) { progress.failed.push({ id: f.id, error: String(err.message).slice(0, 200) }); }
    }));
    if (pending.length >= 500) { await Promise.all(pending); pending = []; progress.doneIds = [...doneSet]; await save(); }
  }
  await Promise.all(pending);
  progress.doneIds = [...doneSet];
  await putText(`${prefix}/manifest.csv`, manifest.join('\n'));
  await putText(`${prefix}/README.txt`,
    `Package #${pkg.id} — ${contacts.length} contacts, ${files.length} files\n` +
    `contacts.csv  -> import into a GHL sub-account (Contacts > Import) or open in Excel\n` +
    `manifest.csv  -> one row per file; package_path is relative to this folder, contact_id joins to contacts.csv\n` +
    `<contactId>/<field name>/<file>  -> the files themselves\n`, 'text/plain');

  await q(`UPDATE packages SET status=$2, file_count=$3, progress=$4, finished_at=now() WHERE id=$1`,
    [pkg.id, progress.failed.length ? 'failed' : 'done', doneSet.size, progress]);
}

/** Release a package's contacts back into the pool (e.g. rep churned). Files in R2 are left in place. */
export async function dissolvePackage(id) {
  await q(`DELETE FROM packages WHERE id=$1`, [id]); // cascades package_contacts
}
