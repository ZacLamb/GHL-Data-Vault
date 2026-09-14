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
// Any async route that throws must answer 500, not take the process down (Node exits on unhandled rejections).
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) => orig(path, ...handlers.map(h => typeof h === 'function' && h.length < 4
    ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h));
}
process.on('unhandledRejection', err => console.error('unhandledRejection:', err?.stack || err));
process.on('uncaughtException', err => console.error('uncaughtException:', err?.stack || err));
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

// --- share-link password helpers -------------------------------------------------------
const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'ghl-vault';
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const checkPw = (pw, stored) => { if (!stored) return true; const [salt, h] = stored.split(':'); const a = Buffer.from(h, 'hex'); const b = crypto.scryptSync(pw || '', salt, 32); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const shareSig = token => crypto.createHmac('sha256', SECRET).update('share:' + token).digest('base64url');
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const unlocked = (req, token) => cookies(req)['sh_' + token] === shareSig(token);
const pwPage = (title, wrong) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#fbfaf7;color:#1c1b18;max-width:420px;margin:0 auto;padding:80px 24px}h1{font-size:20px}input{font:inherit;padding:10px;width:100%;border:1px solid #d9d6cc;border-radius:5px;margin:8px 0}
  button{font:inherit;background:#1f5eff;color:#fff;border:0;padding:10px 16px;border-radius:5px;font-weight:600;cursor:pointer}.err{color:#d64545}</style>
  <h1>${title}</h1><p>This download is password protected.</p>${wrong ? '<p class="err">Incorrect password.</p>' : ''}
  <form method="post"><input type="password" name="password" placeholder="Password" autofocus required><button>Unlock</button></form>`;

app.post('/share/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const { rows: [sh] } = await q(`SELECT s.*, l.name FROM shares s JOIN locations l ON l.location_id=s.location_id WHERE s.token=$1`, [req.params.token]);
  if (!sh) return res.status(404).send('This share link does not exist.');
  if (!checkPw(req.body?.password, sh.password_hash)) return res.status(401).type('html').send(pwPage(sh.label || sh.name || 'Export', true));
  res.set('Set-Cookie', `sh_${sh.token}=${shareSig(sh.token)}; Path=/share/${sh.token}; HttpOnly; SameSite=Lax; Max-Age=43200${req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : ''}`);
  res.redirect(`/share/${sh.token}`);
});

app.get('/share/:token', async (req, res) => {
  const { rows: [sh] } = await q(`SELECT s.*, l.name FROM shares s JOIN locations l ON l.location_id=s.location_id WHERE s.token=$1`, [req.params.token]);
  if (!sh) return res.status(404).send('This share link does not exist.');
  if (new Date(sh.expires_at) < new Date()) return res.status(410).send('This share link has expired.');
  if (sh.password_hash && !unlocked(req, sh.token)) return res.type('html').send(pwPage(sh.label || sh.name || 'Export', false));
  const { rows: parts } = await q(`SELECT * FROM bundles WHERE location_id=$1 AND scope=$2 ORDER BY part`, [sh.location_id, sh.scope]);
  const links = await Promise.all(parts.map(async b => ({ ...b, url: b.status === 'done' ? await presign(b.r2_key, b.r2_key.split('/').pop(), 6 * 3600) : null })));
  const fmt = n => { const u = ['B','KB','MB','GB','TB']; let i = 0; n = Number(n || 0); while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
  const ready = links.filter(b => b.url);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sh.label || sh.name || 'Export'}</title>
  <style>body{font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#fbfaf7;color:#1c1b18;max-width:760px;margin:0 auto;padding:40px 24px}h1{font-size:22px;margin:0 0 6px}p{color:#5f5c53}
  .part{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border:1px solid #e4e1d8;border-radius:6px;background:#fff;margin:10px 0}
  a.dl{background:#1f5eff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:5px;font-weight:600;white-space:nowrap}small{color:#7a776e}</style>
  <h1>${sh.label || (sh.name ? sh.name + ' — export' : 'Export')}</h1>
  <p>${ready.length} of ${links.length} part${links.length === 1 ? '' : 's'} ready · ${fmt(ready.reduce((a, b) => a + Number(b.bytes || 0), 0))} total · link valid until ${new Date(sh.expires_at).toLocaleDateString()}</p>
  <p><small>Download every part and unzip them into the same folder. Part 1 includes <b>contacts.csv</b> (the records) and <b>manifest.csv</b> (which file belongs to which contact); documents are in one folder per contact.</small></p>
  ${links.map(b => `<div class="part"><div><b>Part ${b.part} of ${b.total_parts}</b><br><small>${b.file_count.toLocaleString()} files${b.bytes ? ' · ' + fmt(b.bytes) : ''}${b.status !== 'done' ? ' · ' + b.status : ''}</small></div>${b.url ? `<a class="dl" href="${b.url}">Download</a>` : '<small>not ready yet</small>'}</div>`).join('') || '<p>Nothing prepared yet.</p>'}
  <p><small>Download links on this page refresh each time it's opened; if one stops working, reload the page.</small></p>`);
});

// --- login: ADMIN_USER + ADMIN_PASSWORD (set in Railway) --------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PW = process.env.ADMIN_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const sessionToken = () => {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const sig = crypto.createHmac('sha256', SECRET + ADMIN_PW).update(`session:${exp}`).digest('base64url');
  return `${exp}.${sig}`;
};
const validSession = t => {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', SECRET + ADMIN_PW).update(`session:${exp}`).digest('base64url');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
};
const loginPage = (err) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHL Vault · Sign in</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Instrument+Serif:ital@1&display=swap" rel="stylesheet">
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1210;color:#e6e9e4;font:14px/1.5 "IBM Plex Mono",ui-monospace,monospace;background-image:radial-gradient(circle at 20% -10%,rgba(242,179,61,.1),transparent 45%)}
  form{width:320px;padding:28px;border:1px solid #263029;border-radius:4px;background:#151a16}h1{font:italic 32px/1 "Instrument Serif",serif;margin:0 0 4px}h1 small{display:block;font:11px "IBM Plex Mono",monospace;color:#f2b33d;letter-spacing:.2em;text-transform:uppercase;margin-top:8px}
  input{font:inherit;width:100%;box-sizing:border-box;padding:9px 10px;margin:12px 0 0;background:#0f1210;color:#e6e9e4;border:1px solid #263029;border-radius:2px}button{font:inherit;width:100%;margin-top:16px;padding:10px;background:#f2b33d;color:#1b1608;border:0;border-radius:2px;font-weight:600;cursor:pointer}.err{color:#f06a5a;font-size:12px;margin:10px 0 0}</style>
  <form method="post" action="/login"><h1>GHL Vault<small>sign in</small></h1>${err ? `<p class="err">${err}</p>` : ''}
  <input name="user" placeholder="Username" autocomplete="username" autofocus required><input name="password" type="password" placeholder="Password" autocomplete="current-password" required><button>Sign in</button></form>`;

app.get('/login', (req, res) => { if (!ADMIN_PW || validSession(cookies(req).vault_session)) return res.redirect('/'); res.type('html').send(loginPage()); });
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ok = ADMIN_PW && req.body?.user === ADMIN_USER && req.body?.password === ADMIN_PW;
  if (!ok) return res.status(401).type('html').send(loginPage('Incorrect username or password.'));
  res.set('Set-Cookie', `vault_session=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.get('x-forwarded-proto') === 'https' ? '; Secure' : ''}`);
  res.redirect('/');
});
app.get('/logout', (req, res) => { res.set('Set-Cookie', 'vault_session=; Path=/; Max-Age=0'); res.redirect('/login'); });

app.use((req, res, next) => {
  if (!ADMIN_PW) { if (!global._warnedNoPw) { global._warnedNoPw = true; console.warn('WARN: ADMIN_PASSWORD not set — dashboard is open to anyone with the URL'); } return next(); }
  if (validSession(cookies(req).vault_session)) return next();
  // Basic auth still accepted for scripts / curl
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64) { const [u, ...p] = Buffer.from(b64, 'base64').toString().split(':'); if (u === ADMIN_USER && p.join(':') === ADMIN_PW) return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
  res.redirect('/login');
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
app.post('/api/locations/:id/shares', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body?.days) || 7));
  const token = crypto.randomBytes(15).toString('base64url');
  const pw = (req.body?.password || '').trim();
  await q(`INSERT INTO shares (token, location_id, scope, label, expires_at, password_hash) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, $6)`,
    [token, req.params.id, req.body?.scope || 'location', req.body?.label || null, String(days), pw ? hashPw(pw) : null]);
  res.json({ token, url: `${req.protocol}://${req.get('host')}/share/${token}`, days, protected: !!pw });
});
app.get('/api/locations/:id/shares', async (req, res) => {
  const { rows } = await q(`SELECT token, scope, label, expires_at, created_at, (password_hash IS NOT NULL) AS protected FROM shares WHERE location_id=$1 AND ($2::text IS NULL OR scope=$2) AND expires_at > now() ORDER BY created_at DESC`, [req.params.id, req.query.scope || null]);
  res.json(rows.map(r => ({ ...r, url: `${req.protocol}://${req.get('host')}/share/${r.token}` })));
});
app.delete('/api/shares/:token', async (req, res) => { await q('DELETE FROM shares WHERE token=$1', [req.params.token]); res.json({ ok: true }); });

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
  <h3 style="font-size:14px;margin-top:28px">Send to someone</h3>
  <p><small>Creates a public page (no login) that lists these parts with always-fresh download links. Prepare the download first.</small></p>
  <p><select id="days" style="font:inherit;padding:7px"><option value="1">valid 1 day</option><option value="7" selected>valid 7 days</option><option value="30">valid 30 days</option></select>
     <input id="pw" placeholder="Password (recommended)" style="font:inherit;padding:7px;background:#151a16;color:#e6e9e4;border:1px solid #263029;width:220px">
     <button id="share" style="background:#6fb3ff">Create share link</button></p>
  <div id="shares"></div>
  <p><small>Alternative with a terminal:</small></p>
  <pre>rclone sync r2:${process.env.R2_BUCKET}/${req.params.id} ./${req.params.id}
# rclone config: type=s3, provider=Cloudflare, endpoint=https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com</pre>
  <p><a href="/">← back</a></p>
  <script>
  const fmtB=n=>{const u=['B','KB','MB','GB','TB'];let i=0;n=Number(n||0);while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]};
  async function load(){const bs=await fetch('/api/locations/${req.params.id}/bundles?scope=${scope}').then(r=>r.json());
    document.getElementById('parts').innerHTML=bs.length?'<table><tr><th>Part</th><th>Files</th><th>Status</th><th>Size</th><th></th></tr>'+bs.map(b=>\`<tr><td>\${b.part} of \${b.total_parts}</td><td>\${b.file_count.toLocaleString()}</td><td><span class="pill \${b.status}">\${b.status}</span>\${b.error?' <small>'+b.error+'</small>':''}</td><td>\${b.bytes?fmtB(b.bytes):''}</td><td>\${b.url?'<a href="'+b.url+'">download part '+b.part+'</a>':''}</td></tr>\`).join('')+'</table><small>Links are valid for 24 hours; reload this page for fresh ones.</small>':'<small>No download prepared yet.</small>';
    if(bs.some(b=>b.status!=='done'&&b.status!=='failed'))setTimeout(load,5000)}
  async function loadShares(){const ss=await fetch('/api/locations/${req.params.id}/shares?scope=${scope}').then(r=>r.json());
    document.getElementById('shares').innerHTML=ss.map(s=>\`<p><input value="\${s.url}" readonly style="font:inherit;width:60%;padding:6px;background:#151a16;color:#e6e9e4;border:1px solid #263029" onclick="this.select()"> <small>\${s.protected?'🔒 password · ':''}until \${new Date(s.expires_at).toLocaleDateString()}</small> <a href="#" data-revoke="\${s.token}" style="color:#f06a5a">revoke</a></p>\`).join('')||'';
    document.querySelectorAll('[data-revoke]').forEach(a=>a.onclick=async e=>{e.preventDefault();await fetch('/api/shares/'+a.dataset.revoke,{method:'DELETE'});loadShares()})}
  document.getElementById('share').onclick=async()=>{const r=await fetch('/api/locations/${req.params.id}/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'${scope}',days:Number(document.getElementById('days').value),password:document.getElementById('pw').value})}).then(r=>r.json());
    await navigator.clipboard.writeText(r.url).catch(()=>{});document.getElementById('pw').value='';loadShares();alert('Share link created and copied:\\n'+r.url+(r.protected?'\\n\\nSend the password separately (text/call), not in the same email.':'\\n\\nNo password set — anyone with the link can download.'))};
  loadShares();
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

app.use((err, req, res, _next) => {
  console.error(`${req.method} ${req.originalUrl} ->`, err?.stack || err);
  if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
});

const port = process.env.PORT || 3000;
for (const k of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'])
  if (!process.env[k]) console.warn(`WARN: ${k} not set — downloads will fail until it is`);

migrate()
  .then(() => {
    startWorker();
    app.listen(port, () => console.log(`ghl-vault listening on ${port}`));
  })
  .catch(err => { console.error('FATAL on startup:', err.message); process.exit(1); });
