import express from 'express';
import archiver from 'archiver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q } from './db.js';
import { startWorker } from './runner.js';
import { ALL_SOURCES } from './sources/index.js';
import { getObjectStream } from './storage.js';
import { ghl, parseFileFieldValue } from './ghl.js';
import { createPackage, dissolvePackage, PACKAGE_SIZES, STANDARD_COLUMNS } from './packager.js';
import { listObjects, deletePrefix, presign } from './storage.js';
import { queueBundles } from './bundler.js';
import { summary, breakdowns, search, searchAll } from './analytics.js';
import { locationUsage, userUsage, dailySeries, agencyOverview } from './usage.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// --- public routes (no basic auth): webhook receiver + owner report ---------------------
// GHL marketplace-app webhooks. Point the app's webhook URL at https://<host>/webhooks/ghl?key=<WEBHOOK_KEY>.
app.post('/webhooks/ghl', async (req, res) => {
  if (process.env.WEBHOOK_KEY && req.query.key !== process.env.WEBHOOK_KEY) return res.status(401).end();
  const b = req.body || {};
  const type = b.type || b.event || 'Unknown';
  const userId = b.userId || b.user?.id || b.assignedTo || b.createdBy?.userId || null;
  const contactId = b.contactId || b.contact_id || (type.startsWith('Contact') ? b.id : null);
  const objectId = b.id || b.messageId || b.opportunityId || b.noteId || b.taskId || null;
  const at = b.timestamp || b.dateAdded || b.createdAt || new Date().toISOString();
  if (b.locationId) {
    await q(`INSERT INTO events (location_id, event_type, user_id, contact_id, object_id, occurred_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [b.locationId, type, userId, contactId, objectId, new Date(at), b]).catch(err => console.error('webhook insert', err.message));
  }
  res.json({ ok: true });
});

app.get('/report/:token', async (req, res) => {
  const { rows: [loc] } = await q('SELECT location_id, name FROM locations WHERE report_token=$1', [req.params.token]);
  if (!loc) return res.status(404).send('Report not found');
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});
app.get('/api/report/:token', async (req, res) => {
  const { rows: [loc] } = await q('SELECT location_id, name FROM locations WHERE report_token=$1', [req.params.token]);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const { from, to } = req.query;
  const [s, users, daily] = await Promise.all([locationUsage(loc.location_id, from, to), userUsage(loc.location_id, from, to), dailySeries(loc.location_id, from, to)]);
  res.json({ name: loc.name, summary: s, users: users.map(u => ({ ...u, email: undefined })), daily });
});

// --- basic auth on everything else -----------------------------------------------------
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
  try {
    const { rows } = await q(`
      WITH f AS (SELECT location_id, count(*) FILTER (WHERE status='done') AS files_done, count(*) FILTER (WHERE status='failed') AS files_failed,
                        coalesce(sum(size_bytes) FILTER (WHERE status='done'),0) AS bytes FROM files GROUP BY location_id),
           j AS (SELECT DISTINCT ON (location_id) location_id, id, status, sources, progress, since, created_at, finished_at FROM jobs ORDER BY location_id, id DESC)
      SELECT l.location_id, l.name, (l.pit_token IS NOT NULL) AS has_pit, l.created_at,
             coalesce(f.files_done,0) AS files_done, coalesce(f.files_failed,0) AS files_failed, coalesce(f.bytes,0) AS bytes,
             CASE WHEN j.id IS NULL THEN NULL ELSE json_build_object('id',j.id,'status',j.status,'sources',j.sources,'progress',j.progress,'since',j.since,'created_at',j.created_at,'finished_at',j.finished_at) END AS last_job
      FROM locations l LEFT JOIN f ON f.location_id=l.location_id LEFT JOIN j ON j.location_id=l.location_id
      ORDER BY l.name NULLS LAST, l.location_id`);
    res.json(rows);
  } catch (err) { console.error('locations', err); res.status(500).json({ error: err.message }); }
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
  const { locationId, sources, incremental } = req.body || {};
  const chosen = (sources?.length ? sources : ALL_SOURCES).filter(s => ALL_SOURCES.includes(s));
  let since = null;
  if (incremental) {
    const { rows: [last] } = await q(`SELECT started_at FROM jobs WHERE location_id=$1 AND status='done' ORDER BY id DESC LIMIT 1`, [locationId]);
    if (!last) return res.status(409).json({ error: 'No completed export yet — run a full export first' });
    since = new Date(new Date(last.started_at).getTime() - 60 * 60_000); // 1h overlap
  }
  const { rows: [job] } = await q(`INSERT INTO jobs (location_id, sources, since) VALUES ($1,$2,$3) RETURNING *`, [locationId, chosen, since]);
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

const ZIP_MAX_FILES = Number(process.env.ZIP_MAX_FILES || 25000);
const ZIP_PART_FILES = Number(process.env.ZIP_PART_FILES || 2000);

async function locationZipRows(locationId) {
  const { rows } = await q(`SELECT r2_key, size_bytes FROM files WHERE location_id=$1 AND status='done' AND r2_key IS NOT NULL ORDER BY r2_key`, [locationId]);
  return rows;
}
function streamZip(res, filename, rows, stripPrefix) {
  res.set('Content-Type', 'application/zip').set('Content-Disposition', `attachment; filename="${filename}"`)
     .set('Cache-Control', 'no-store').set('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const zip = archiver('zip', { store: true }); // PDFs/images don't compress; store mode keeps the stream fast
  zip.on('error', err => { console.error('zip', err.message); res.destroy(err); });
  zip.on('warning', err => console.warn('zip warning', err.message));
  zip.pipe(res);
  let aborted = false; res.on('close', () => { aborted = true; });
  (async () => {
    const missing = [];
    for (const { r2_key } of rows) {
      if (aborted) return;
      let body;
      try { body = await getObjectStream(r2_key); } catch (err) { missing.push(`${r2_key}\t${err.name || err.message}`); continue; }
      await new Promise((resolve, reject) => {
        body.once('error', reject);
        zip.append(body, { name: stripPrefix ? r2_key.replace(stripPrefix, '') : r2_key });
        zip.once('entry', resolve);      // wait for each entry so we never queue thousands of open R2 streams
      }).catch(err => { missing.push(`${r2_key}\t${err.message}`); });
    }
    if (missing.length) zip.append(missing.join('\n'), { name: '_missing.txt' });
    zip.finalize();
  })().catch(err => { console.error('zip stream', err.message); res.destroy(err); });
}

const fmtB = n => { const u = ['B','KB','MB','GB','TB']; let i = 0; n = Number(n || 0); while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };

async function bundleStatus(locationId, scope) {
  const { rows } = await q(`SELECT * FROM bundles WHERE location_id=$1 AND scope=$2 ORDER BY part`, [locationId, scope]);
  return Promise.all(rows.map(async b => ({ ...b, url: b.status === 'done' ? await presign(b.r2_key, b.r2_key.split('/').pop()) : null })));
}
app.get('/api/locations/:id/bundles', async (req, res) => res.json(await bundleStatus(req.params.id, req.query.scope || 'location')));
app.post('/api/locations/:id/bundles', async (req, res) => {
  const scope = req.body?.scope || 'location';
  res.json({ parts: await queueBundles(req.params.id, scope) });
});

// Export page: prepare zip parts in R2, then download them directly from Cloudflare.
app.get('/api/locations/:id/export', async (req, res) => {
  const scope = req.query.scope || 'location';
  const rows = await locationZipRows(req.params.id);
  const total = rows.reduce((a, r) => a + Number(r.size_bytes || 0), 0);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Export ${req.params.id}</title>
  <style>body{font:14px/1.6 ui-monospace,monospace;background:#0f1210;color:#e6e9e4;padding:32px;max-width:900px}a{color:#6fb3ff}h1{font-weight:600;font-size:18px}
  table{border-collapse:collapse;margin:16px 0;width:100%}td,th{padding:6px 14px 6px 0;text-align:left;border-bottom:1px solid #263029}small{color:#8a948c}pre{background:#151a16;padding:12px;border-radius:3px;overflow-x:auto}
  button{font:inherit;padding:8px 14px;background:#f2b33d;border:0;border-radius:3px;cursor:pointer;font-weight:600}.pill{font-size:11px;padding:1px 6px;border:1px solid #263029;border-radius:2px;text-transform:uppercase}
  .done{color:#5fd38a;border-color:#5fd38a}.running{color:#f2b33d;border-color:#f2b33d}.failed{color:#f06a5a;border-color:#f06a5a}</style>
  <h1>Export · ${req.params.id}</h1>
  <p>${rows.length.toLocaleString()} files · ${fmtB(total)} in the vault. <a href="/api/locations/${req.params.id}/manifest.csv">manifest.csv</a></p>
  <p><button id="prep">Prepare download</button> <small>builds zip parts of up to ${ZIP_PART_FILES.toLocaleString()} files inside R2; you then download each part directly from Cloudflare (resumable, no proxy timeouts). Safe to close this tab while it builds.</small></p>
  <div id="parts"></div>
  <p><small>Alternative with a terminal:</small></p>
  <pre>rclone sync r2:${process.env.R2_BUCKET}/${req.params.id} ./${req.params.id}
# rclone config: type=s3, provider=Cloudflare, endpoint=https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com</pre>
  <p><a href="/">← back</a></p>
  <script>
  const fmtB=n=>{const u=['B','KB','MB','GB','TB'];let i=0;n=Number(n||0);while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]};
  async function load(){const bs=await fetch('/api/locations/${req.params.id}/bundles?scope=${scope}').then(r=>r.json());
    document.getElementById('parts').innerHTML=bs.length?'<table><tr><th>Part</th><th>Files</th><th>Status</th><th>Size</th><th></th></tr>'+bs.map(b=>\`<tr><td>\${b.part} of \${b.total_parts}</td><td>\${b.file_count.toLocaleString()}</td><td><span class="pill \${b.status}">\${b.status}</span>\${b.error?' <small>'+b.error+'</small>':''}</td><td>\${b.bytes?fmtB(b.bytes):''}</td><td>\${b.url?'<a href="'+b.url+'">download part '+b.part+'</a>':''}</td></tr>\`).join('')+'</table><small>Links are valid for 24 hours; reload this page for fresh ones.</small>':'<small>No download prepared yet.</small>';
    if(bs.some(b=>b.status!=='done'&&b.status!=='failed'))setTimeout(load,5000)}
  document.getElementById('prep').onclick=async()=>{if(!confirm('Build zip parts now? Existing parts are replaced.'))return;await fetch('/api/locations/${req.params.id}/bundles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'${scope}'})});load()};
  load();
  </script>`);
});

app.get('/api/locations/:id/export.zip', async (req, res) => {
  const rows = await locationZipRows(req.params.id);
  const part = Number(req.query.part);
  if (part) {
    const slice = rows.slice((part - 1) * ZIP_PART_FILES, part * ZIP_PART_FILES);
    if (!slice.length) return res.status(404).send('no such part');
    return streamZip(res, `${req.params.id}-part${part}.zip`, slice);
  }
  if (rows.length > ZIP_MAX_FILES) return res.redirect(`/api/locations/${req.params.id}/export`);
  streamZip(res, `${req.params.id}-files.zip`, rows);
});

// --- packages -------------------------------------------------------------------------
app.get('/api/locations/:id/pool', async (req, res) => {
  const { rows: [r] } = await q(`
    SELECT (SELECT count(*) FROM contacts WHERE location_id=$1) AS total,
           (SELECT count(*) FROM package_contacts WHERE location_id=$1 AND locked) AS assigned`, [req.params.id]);
  res.json({ total: Number(r.total), assigned: Number(r.assigned), available: Number(r.total) - Number(r.assigned), sizes: PACKAGE_SIZES, standardColumns: STANDARD_COLUMNS });
});

app.post('/api/locations/:id/packages', async (req, res) => {
  const all = req.body?.size === 'all';
  const size = all ? 'all' : Number(req.body?.size);
  if (!all && !PACKAGE_SIZES.includes(size)) return res.status(400).json({ error: `size must be one of ${PACKAGE_SIZES.join(', ')} or "all"` });
  const locked = req.body?.locked !== false && !all;   // "export all matching" never locks contacts
  const pkg = await createPackage(req.params.id, size, req.body?.label, { filters: req.body?.filters || {}, columns: req.body?.columns || null, fileFields: req.body?.fileFields || null, folderTemplate: req.body?.folderTemplate || null, locked });
  if (!pkg.contact_count) { await dissolvePackage(pkg.id); return res.status(409).json({ error: locked ? 'No not-yet-packaged contacts match this filter' : 'No contacts match this filter' }); }
  res.json(pkg);
});

app.get('/api/packages', async (req, res) => {
  const { rows } = await q(`SELECT * FROM packages WHERE ($1::text IS NULL OR location_id=$1) ORDER BY id DESC LIMIT 100`, [req.query.locationId || null]);
  res.json(rows.map(p => ({ ...p, progress: { copied: p.progress?.copied, total: p.progress?.total, failed: p.progress?.failed?.length || 0, all: !!p.progress?.all } })));
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
app.get('/api/packages/:id/export', async (req, res) => {
  const { rows: [pkg] } = await q('SELECT * FROM packages WHERE id=$1', [req.params.id]);
  if (!pkg) return res.status(404).send('no such package');
  res.redirect(`/api/locations/${pkg.location_id}/export?scope=package:${pkg.id}`);
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
  const { rows: [sk] } = await q(`SELECT count(*) AS skipped FROM files WHERE location_id=$1 AND status='skipped'`, [req.params.id]);
  res.json({ failures: rows.map(r => ({ ...r, n: Number(r.n) })), done: sizes[0], skipped_no_recording: Number(sk.skipped) });
});

// --- usage analytics ---------------------------------------------------------------------
app.get('/api/usage/overview', async (req, res) => res.json(await agencyOverview(req.query.from, req.query.to)));
app.get('/api/locations/:id/usage', async (req, res) => res.json(await locationUsage(req.params.id, req.query.from, req.query.to)));
app.get('/api/locations/:id/usage/users', async (req, res) => res.json(await userUsage(req.params.id, req.query.from, req.query.to)));
app.get('/api/locations/:id/usage/daily', async (req, res) => res.json(await dailySeries(req.params.id, req.query.from, req.query.to, req.query.userId)));

app.post('/api/locations/:id/report-token', async (req, res) => {
  const token = crypto.randomBytes(18).toString('base64url');
  await q('UPDATE locations SET report_token=$2 WHERE location_id=$1', [req.params.id, token]);
  res.json({ token, url: `${req.protocol}://${req.get('host')}/report/${token}` });
});
app.delete('/api/locations/:id/report-token', async (req, res) => { await q('UPDATE locations SET report_token=NULL WHERE location_id=$1', [req.params.id]); res.json({ ok: true }); });
app.get('/api/locations/:id/events', async (req, res) => {
  const { rows } = await q(`SELECT event_type, count(*) AS n, max(occurred_at) AS last FROM events WHERE location_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [req.params.id]);
  res.json(rows);
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
