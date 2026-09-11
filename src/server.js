import express from 'express';
import archiver from 'archiver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q } from './db.js';
import { startWorker } from './runner.js';
import { ALL_SOURCES } from './sources/index.js';
import { getObjectStream } from './storage.js';
import { ghl, parseFileFieldValue } from './ghl.js';
import { createPackage, dissolvePackage, PACKAGE_SIZES } from './packager.js';
import { listObjects, deletePrefix } from './storage.js';
import { summary, breakdowns, search, searchAll } from './analytics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// --- basic auth on everything ------------------------------------------------------
app.use((req, res, next) => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const given = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (given === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="ghl-vault"').status(401).send('auth required');
});
app.use(express.static(path.join(__dirname, 'public')));

const csvCell = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;

// --- locations ----------------------------------------------------------------------
app.get('/api/locations', async (_req, res) => {
  const { rows } = await q(`
    SELECT l.location_id, l.name, (l.pit_token IS NOT NULL) AS has_pit, l.created_at,
           (SELECT count(*) FROM files f WHERE f.location_id=l.location_id AND f.status='done')   AS files_done,
           (SELECT count(*) FROM files f WHERE f.location_id=l.location_id AND f.status='failed') AS files_failed,
           (SELECT coalesce(sum(size_bytes),0) FROM files f WHERE f.location_id=l.location_id AND f.status='done') AS bytes,
           (SELECT row_to_json(j) FROM (SELECT id,status,sources,progress,created_at,finished_at FROM jobs WHERE location_id=l.location_id ORDER BY id DESC LIMIT 1) j) AS last_job
    FROM locations l ORDER BY l.name NULLS LAST, l.location_id`);
  res.json(rows);
});

app.post('/api/locations', async (req, res) => {
  const { locationId, name, pitToken } = req.body || {};
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  await q(`INSERT INTO locations (location_id, name, pit_token) VALUES ($1,$2,$3)
           ON CONFLICT (location_id) DO UPDATE SET name=COALESCE(EXCLUDED.name, locations.name),
           pit_token=COALESCE(EXCLUDED.pit_token, locations.pit_token)`, [locationId, name || null, pitToken || null]);
  // best-effort name lookup + token check
  try {
    const d = await ghl(locationId, 'GET', `/locations/${locationId}`);
    if (d.location?.name) await q('UPDATE locations SET name=$2 WHERE location_id=$1', [locationId, d.location.name]);
    res.json({ ok: true, name: d.location?.name });
  } catch (err) { res.json({ ok: true, warning: `saved, but token check failed: ${err.message}` }); }
});

async function resetLocation(locationId, { purgeR2 = false, dropLocation = false } = {}) {
  const { rows: running } = await q(`SELECT 1 FROM jobs WHERE location_id=$1 AND status='running' UNION SELECT 1 FROM packages WHERE location_id=$1 AND status='running'`, [locationId]);
  if (running.length) throw new Error('Stop the running job first');
  let deleted = 0;
  if (purgeR2) { deleted += await deletePrefix(`${locationId}/`); deleted += await deletePrefix(`packages/${locationId}/`); }
  await q('DELETE FROM package_contacts WHERE location_id=$1', [locationId]);
  await q('DELETE FROM packages WHERE location_id=$1', [locationId]);
  await q('DELETE FROM files WHERE location_id=$1', [locationId]);
  await q('DELETE FROM contacts WHERE location_id=$1', [locationId]);
  await q('DELETE FROM jobs WHERE location_id=$1', [locationId]);
  if (dropLocation) await q('DELETE FROM locations WHERE location_id=$1', [locationId]);
  return deleted;
}
app.post('/api/locations/:id/reset', async (req, res) => {
  try { res.json({ ok: true, r2Deleted: await resetLocation(req.params.id, { purgeR2: !!req.body?.purgeR2 }) }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
app.delete('/api/locations/:id', async (req, res) => {
  try { res.json({ ok: true, r2Deleted: await resetLocation(req.params.id, { purgeR2: !!req.body?.purgeR2, dropLocation: true }) }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// Bulk-import every sub-account under the agency (requires GHL_AGENCY_ACCESS_TOKEN + GHL_COMPANY_ID).
app.post('/api/locations/import-agency', async (_req, res) => {
  const token = process.env.GHL_AGENCY_ACCESS_TOKEN, companyId = process.env.GHL_COMPANY_ID;
  if (!token || !companyId) return res.status(400).json({ error: 'agency token not configured' });
  let skip = 0, imported = 0;
  while (true) {
    const r = await fetch(`https://services.leadconnectorhq.com/locations/search?companyId=${companyId}&limit=100&skip=${skip}`,
      { headers: { Authorization: `Bearer ${token}`, Version: process.env.GHL_API_VERSION || '2021-07-28', Accept: 'application/json' } });
    if (!r.ok) return res.status(502).json({ error: await r.text() });
    const { locations = [] } = await r.json();
    for (const l of locations) {
      await q(`INSERT INTO locations (location_id, name) VALUES ($1,$2) ON CONFLICT (location_id) DO UPDATE SET name=EXCLUDED.name`, [l.id, l.name]);
      imported++;
    }
    if (locations.length < 100) break;
    skip += 100;
  }
  res.json({ imported });
});

// --- jobs -----------------------------------------------------------------------------
app.post('/api/jobs', async (req, res) => {
  const { locationId, sources } = req.body || {};
  const chosen = (sources?.length ? sources : ALL_SOURCES).filter(s => ALL_SOURCES.includes(s));
  const { rows: [job] } = await q(`INSERT INTO jobs (location_id, sources) VALUES ($1,$2) RETURNING *`, [locationId, chosen]);
  res.json(job);
});
app.get('/api/jobs', async (req, res) => {
  const { rows } = await q(`SELECT * FROM jobs WHERE ($1::text IS NULL OR location_id=$1) ORDER BY id DESC LIMIT 50`, [req.query.locationId || null]);
  res.json(rows);
});
app.post('/api/jobs/:id/cancel', async (req, res) => {
  await q(`UPDATE jobs SET status='cancelled' WHERE id=$1 AND status IN ('queued','running')`, [req.params.id]); res.json({ ok: true });
});
app.post('/api/jobs/:id/resume', async (req, res) => {
  // keeps saved cursors; paused sources restart from where they stopped
  await q(`UPDATE jobs SET status='queued', finished_at=NULL WHERE id=$1 AND status IN ('cancelled','failed')`, [req.params.id]); res.json({ ok: true });
});
app.post('/api/jobs/:id/retry-failed', async (req, res) => {
  // Re-queue failed downloads: flip them back to pending so the next run re-ingests them.
  const { rows: [job] } = await q('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
  if (!job) return res.status(404).end();
  await q(`UPDATE files SET status='pending' WHERE job_id=$1 AND status='failed'`, [job.id]);
  const { rows: [fresh] } = await q(`INSERT INTO jobs (location_id, sources) VALUES ($1,$2) RETURNING *`, [job.location_id, job.sources]);
  res.json(fresh);
});

// --- manifest + zip --------------------------------------------------------------------
app.get('/api/locations/:id/manifest.csv', async (req, res) => {
  const cols = ['id','source','status','contact_id','opportunity_id','conversation_id','message_id','submission_id','document_id',
                'field_id','field_name','original_filename','mime_type','size_bytes','r2_key','source_url','downloaded_at','error'];
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="${req.params.id}-manifest.csv"`);
  res.write(cols.join(',') + '\n');
  const { rows } = await q(`SELECT ${cols.join(',')} FROM files WHERE location_id=$1 ORDER BY source, contact_id, id`, [req.params.id]);
  for (const r of rows) res.write(cols.map(c => csvCell(r[c])).join(',') + '\n');
  res.end();
});

const ZIP_MAX_FILES = Number(process.env.ZIP_MAX_FILES || 5000);
app.get('/api/locations/:id/export.zip', async (req, res) => {
  const { rows } = await q(`SELECT r2_key FROM files WHERE location_id=$1 AND status='done' AND r2_key IS NOT NULL`, [req.params.id]);
  if (rows.length > ZIP_MAX_FILES) {
    return res.status(413).type('text/plain').send(
      `This location has ${rows.length} files — too many to zip through the server.\n` +
      `Pull it straight from R2 instead:\n\n` +
      `  rclone sync r2:${process.env.R2_BUCKET}/${req.params.id} ./${req.params.id}\n\n` +
      `(rclone config: type=s3, provider=Cloudflare, endpoint=https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com)\n` +
      `Or use manifest.csv to look up individual files by contact ID.\n`);
  }
  res.set('Content-Type', 'application/zip').set('Content-Disposition', `attachment; filename="${req.params.id}-files.zip"`);
  const zip = archiver('zip', { zlib: { level: 1 } }); // most content is already compressed
  zip.on('error', err => { console.error(err); res.destroy(err); });
  zip.pipe(res);
  for (const { r2_key } of rows) zip.append(await getObjectStream(r2_key), { name: r2_key });
  zip.finalize();
});

// --- packages -------------------------------------------------------------------------
app.get('/api/locations/:id/pool', async (req, res) => {
  const { rows: [r] } = await q(`
    SELECT (SELECT count(*) FROM contacts WHERE location_id=$1) AS total,
           (SELECT count(*) FROM package_contacts WHERE location_id=$1) AS assigned`, [req.params.id]);
  res.json({ total: Number(r.total), assigned: Number(r.assigned), available: Number(r.total) - Number(r.assigned), sizes: PACKAGE_SIZES });
});

app.post('/api/locations/:id/packages', async (req, res) => {
  const size = Number(req.body?.size);
  if (!PACKAGE_SIZES.includes(size)) return res.status(400).json({ error: `size must be one of ${PACKAGE_SIZES.join(', ')}` });
  const pkg = await createPackage(req.params.id, size, req.body?.label, req.body?.filters || {});
  if (!pkg.contact_count) { await dissolvePackage(pkg.id); return res.status(409).json({ error: 'No unassigned contacts left in this location' }); }
  res.json(pkg);
});

app.get('/api/packages', async (req, res) => {
  const { rows } = await q(`SELECT * FROM packages WHERE ($1::text IS NULL OR location_id=$1) ORDER BY id DESC LIMIT 100`, [req.query.locationId || null]);
  res.json(rows.map(p => ({ ...p, progress: { copied: p.progress?.copied, total: p.progress?.total, failed: p.progress?.failed?.length || 0 } })));
});

app.delete('/api/packages/:id', async (req, res) => { await dissolvePackage(req.params.id); res.json({ ok: true }); });

app.get('/api/packages/:id/contacts.csv', async (req, res) => {
  const { rows: [pkg] } = await q('SELECT * FROM packages WHERE id=$1', [req.params.id]);
  if (!pkg?.r2_prefix) return res.status(404).send('package not built yet');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="package-${pkg.id}-contacts.csv"`);
  (await getObjectStream(`${pkg.r2_prefix}/contacts.csv`)).pipe(res);
});
app.get('/api/packages/:id/manifest.csv', async (req, res) => {
  const { rows: [pkg] } = await q('SELECT * FROM packages WHERE id=$1', [req.params.id]);
  if (!pkg?.r2_prefix) return res.status(404).send('package not built yet');
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="package-${pkg.id}-manifest.csv"`);
  (await getObjectStream(`${pkg.r2_prefix}/manifest.csv`)).pipe(res);
});
app.get('/api/packages/:id/export.zip', async (req, res) => {
  const { rows: [pkg] } = await q('SELECT * FROM packages WHERE id=$1', [req.params.id]);
  if (!pkg?.r2_prefix || pkg.status !== 'done') return res.status(404).send('package not built yet');
  if (pkg.file_count > ZIP_MAX_FILES) {
    return res.status(413).type('text/plain').send(`Package has ${pkg.file_count} files — pull it with:\n  rclone sync r2:${process.env.R2_BUCKET}/${pkg.r2_prefix} ./package-${pkg.id}\n`);
  }
  res.set('Content-Type', 'application/zip').set('Content-Disposition', `attachment; filename="package-${pkg.id}.zip"`);
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', err => { console.error(err); res.destroy(err); });
  zip.pipe(res);
  for await (const o of listObjects(pkg.r2_prefix + '/')) zip.append(await getObjectStream(o.Key), { name: o.Key.replace(pkg.r2_prefix + '/', '') });
  zip.finalize();
});

// --- analytics ------------------------------------------------------------------------
app.get('/api/locations/:id/analytics', async (req, res) => {
  const [sum, brk] = await Promise.all([summary(req.params.id), breakdowns(req.params.id)]);
  res.json({ summary: sum, ...brk });
});
app.post('/api/locations/:id/search', async (req, res) => {
  const { filters = {}, page, limit } = req.body || {};
  res.json(await search(req.params.id, filters, { page, limit }));
});
app.post('/api/locations/:id/search.csv', async (req, res) => {
  const filters = req.body?.filters || {};
  res.set('Content-Type', 'text/csv').set('Content-Disposition', `attachment; filename="${req.params.id}-filtered.csv"`);
  const cols = ['contact_id','first_name','last_name','email','phone','company','address','city','state','postal_code','tags','date_added','docs'];
  res.write(cols.join(',') + '\n');
  for await (const r of searchAll(req.params.id, filters)) res.write(cols.map(c => csvCell(Array.isArray(r[c]) ? r[c].join(';') : r[c])).join(',') + '\n');
  res.end();
});

// --- debug: see exactly what GHL returns for one contact -------------------------------
app.get('/api/locations/:id/debug/:contactId', async (req, res) => {
  const { id, contactId } = req.params;
  try {
    const defs = await ghl(id, 'GET', `/locations/${id}/customFields`, { query: { model: 'contact' } });
    const contact = await ghl(id, 'GET', `/contacts/${contactId}`);
    const search = await ghl(id, 'POST', '/contacts/search', { body: { locationId: id, pageLimit: 1, filters: [{ field: 'id', operator: 'eq', value: contactId }] } }).catch(e => ({ error: e.message }));
    const fileDefs = (defs.customFields || []).filter(f => /FILE/i.test(f.dataType || ''));
    const parsed = (contact.contact?.customFields || []).flatMap(cf => parseFileFieldValue(cf.value).map(f => ({ fieldId: cf.id, ...f })));
    res.json({
      fileFieldDefinitions: fileDefs,
      allFieldDataTypes: [...new Set((defs.customFields || []).map(f => f.dataType))],
      contact_get: contact.contact,
      contact_from_search: search.contacts?.[0] ?? search,
      parsedFiles: parsed,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/locations/:id/failures', async (req, res) => {
  const { rows } = await q(`
    SELECT error, count(*) AS n, min(source_url) AS sample_url, min(source) AS source, min(field_name) AS field_name
    FROM files WHERE location_id=$1 AND status='failed' GROUP BY error ORDER BY n DESC LIMIT 30`, [req.params.id]);
  const { rows: sizes } = await q(`SELECT count(*) AS done, count(*) FILTER (WHERE size_bytes IS NULL) AS no_size, min(r2_key) AS sample_key FROM files WHERE location_id=$1 AND status='done'`, [req.params.id]);
  res.json({ failures: rows.map(r => ({ ...r, n: Number(r.n) })), done: sizes[0] });
});

app.get('/api/sources', (_req, res) => res.json(ALL_SOURCES));

const port = process.env.PORT || 3000;
for (const k of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'])
  if (!process.env[k]) console.warn(`WARN: ${k} not set — downloads will fail until it is`);

migrate()
  .then(() => {
    startWorker();
    app.listen(port, () => console.log(`ghl-vault listening on ${port}`));
  })
  .catch(err => { console.error('FATAL on startup:', err.message); process.exit(1); });
