import express from 'express';
import archiver from 'archiver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q } from './db.js';
import { startWorker } from './runner.js';
import { ALL_SOURCES } from './sources/index.js';
import { getObjectStream } from './storage.js';
import { ghl } from './ghl.js';

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

app.get('/api/locations/:id/export.zip', async (req, res) => {
  const { rows } = await q(`SELECT r2_key FROM files WHERE location_id=$1 AND status='done' AND r2_key IS NOT NULL`, [req.params.id]);
  res.set('Content-Type', 'application/zip').set('Content-Disposition', `attachment; filename="${req.params.id}-files.zip"`);
  const zip = archiver('zip', { zlib: { level: 1 } }); // most content is already compressed
  zip.on('error', err => { console.error(err); res.destroy(err); });
  zip.pipe(res);
  for (const { r2_key } of rows) zip.append(await getObjectStream(r2_key), { name: r2_key });
  zip.finalize();
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
