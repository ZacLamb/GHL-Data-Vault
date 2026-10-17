// Push vault data into another GHL sub-account: contacts (+ non-file custom fields, tags),
// their documents (uploaded into the matching file-upload fields), and optionally opportunities.
//
// It is a COPY. The source sub-account and the vault's own records are never modified.
// Idempotent: every created thing is recorded in push_items, so re-running a push (or pushing
// the same contacts again later) updates instead of duplicating.

import { q } from './db.js';
import { ghl } from './ghl.js';
import { getObjectStream } from './storage.js';
import { buildFilter } from './analytics.js';

const BATCH = 50;                       // contacts per progress checkpoint
const UPLOAD_BATCH_BYTES = 20 * 1024 * 1024;   // multipart batches stay under this
const FILES_PER_REQUEST = Number(process.env.PUSH_FILES_PER_REQUEST || 1);   // 1 = one upload call per file (safest)
const DEFAULT_MAX_FILES = Number(process.env.PUSH_FILE_FIELD_MAX || 25);

// ---------- creation ----------
export async function createPush({ targetLocationId, sourceLocationId, packageId, filters, include = {}, tag, label, limit }) {
  limit = Number(limit) > 0 ? Math.floor(Number(limit)) : null;
  if (!targetLocationId) throw new Error('targetLocationId required');
  if (!packageId && !sourceLocationId) throw new Error('packageId or sourceLocationId required');
  let src = sourceLocationId;
  if (packageId) {
    const { rows: [p] } = await q('SELECT * FROM packages WHERE id=$1', [packageId]);
    if (!p) throw new Error('package not found');
    src = p.location_id;
  }
  if (src === targetLocationId) throw new Error('source and target are the same sub-account');
  const { rows: [t] } = await q('SELECT 1 FROM locations WHERE location_id=$1', [targetLocationId]);
  if (!t) throw new Error('target sub-account is not in the vault — import it first');
  const counts = await previewCounts({ sourceLocationId: src, packageId, filters, limit });
  const options = { include: { documents: include.documents !== false, opportunities: !!include.opportunities, customFields: include.customFields !== false }, tag: tag || null, filters: filters || null, limit };
  const { rows: [push] } = await q(
    `INSERT INTO pushes (source_location_id, target_location_id, package_id, label, options, status, progress)
     VALUES ($1,$2,$3,$4,$5,'queued',$6) RETURNING *`,
    [src, targetLocationId, packageId || null, label || null, options, { total: counts.contacts, filesTotal: counts.files, contactsDone: 0, created: 0, updated: 0, filesDone: 0, filesFailed: 0, filesSkipped: 0, oppsDone: 0, errors: [] }]);
  return push;
}

// Which contacts does this push cover? (package → its members; else location, optionally filtered)
// Returns { sql, params } where sql is a SELECT c.* ... WHERE ... (always has a WHERE) using $1..$n.
function contactSet({ sourceLocationId, packageId, filters }) {
  if (packageId) return { sql: `SELECT c.* FROM package_contacts pc JOIN contacts c ON c.location_id=pc.location_id AND c.contact_id=pc.contact_id WHERE pc.package_id=$1`, params: [packageId] };
  const f = buildFilter(sourceLocationId, filters || {});
  return { sql: `SELECT c.* FROM contacts c WHERE ${f.sql}`, params: f.params };
}

export async function previewCounts({ sourceLocationId, packageId, filters, limit }) {
  let { sql: set, params } = contactSet({ sourceLocationId, packageId, filters });
  if (Number(limit) > 0) set = `${set} ORDER BY c.contact_id LIMIT ${Math.floor(Number(limit))}`;   // test sample: first N
  const { rows: [r] } = await q(`
    WITH s AS (${set})
    SELECT (SELECT count(*) FROM s) AS contacts,
           (SELECT count(*) FROM files f JOIN s ON s.location_id=f.location_id AND s.contact_id=f.contact_id WHERE f.status='done' AND f.source IN ('contact_field') AND f.field_name IS NOT NULL) AS files,
           (SELECT coalesce(sum(size_bytes),0) FROM files f JOIN s ON s.location_id=f.location_id AND s.contact_id=f.contact_id WHERE f.status='done' AND f.source IN ('contact_field') AND f.field_name IS NOT NULL) AS bytes,
           (SELECT count(*) FROM opportunities o JOIN s ON s.location_id=o.location_id AND s.contact_id=o.contact_id) AS opportunities,
           (SELECT array_agg(DISTINCT f.field_name) FROM files f JOIN s ON s.location_id=f.location_id AND s.contact_id=f.contact_id WHERE f.status='done' AND f.source='contact_field' AND f.field_name IS NOT NULL) AS file_fields,
           (SELECT array_agg(DISTINCT k) FROM s, jsonb_object_keys(s.custom) k) AS custom_fields`, params);
  return { contacts: Number(r.contacts), files: Number(r.files), bytes: Number(r.bytes), opportunities: Number(r.opportunities), fileFields: r.file_fields || [], customFields: r.custom_fields || [] };
}

// What will happen to each field in the target: exists (with type) or will be created.
export async function previewMapping({ sourceLocationId, packageId, filters, targetLocationId, limit }) {
  const counts = await previewCounts({ sourceLocationId, packageId, filters, limit });
  const tf = await targetFields(targetLocationId);
  const byName = new Map(tf.map(f => [norm(f.name), f]));
  const fields = [];
  for (const name of counts.fileFields) { const f = byName.get(norm(name)); fields.push({ name, kind: 'file', target: f ? (/FILE/i.test(f.dataType) ? 'exists' : `exists but is ${f.dataType} — files will be skipped`) : 'will be created (FILE_UPLOAD)' }); }
  for (const name of counts.customFields) { const f = byName.get(norm(name)); fields.push({ name, kind: 'text', target: f ? `exists (${f.dataType})` : 'will be created (TEXT)' }); }
  return { ...counts, fields };
}

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function targetFields(locationId) {
  const data = await ghl(locationId, 'GET', `/locations/${locationId}/customFields`, { query: { model: 'contact' } });
  return (data.customFields || []).filter(f => !f.model || f.model === 'contact');
}

async function ensureField(locationId, name, kind, cache) {
  const key = norm(name);
  if (cache.has(key)) return cache.get(key);
  const body = kind === 'file'
    ? { name, dataType: 'FILE_UPLOAD', model: 'contact', acceptedFormat: ['all'], maxNumberOfFiles: DEFAULT_MAX_FILES, placeholder: '' }
    : { name, dataType: 'TEXT', model: 'contact', placeholder: '' };
  const data = await ghl(locationId, 'POST', `/locations/${locationId}/customFields`, { body });
  const f = data.customField || data;
  cache.set(key, f);
  return f;
}

// ---------- the job ----------
export async function runPush(push) {
  const opts = push.options || {}; const inc = opts.include || {};
  const progress = push.progress || {}; progress.errors ??= [];
  const target = push.target_location_id, source = push.source_location_id;
  await q(`UPDATE pushes SET status='running', started_at=COALESCE(started_at, now()), error=NULL WHERE id=$1`, [push.id]);

  const save = async (note) => {
    progress.at = new Date().toISOString(); if (note !== undefined) progress.note = note;
    const { rows: [cur] } = await q('UPDATE pushes SET progress=$2 WHERE id=$1 RETURNING status', [push.id, progress]);
    if (cur.status === 'cancelled') throw Object.assign(new Error('cancelled'), { cancelled: true });
  };
  const fail = (what, err) => { if (progress.errors.length < 200) progress.errors.push(`${what}: ${String(err.message || err).slice(0, 200)}`); };

  try {
    // 1. field map in the target (create missing)
    const tf = await targetFields(target);
    const cache = new Map(tf.map(f => [norm(f.name), f]));
    const fieldFor = async (name, kind) => {
      const f = await ensureField(target, name, kind, cache);
      if (kind === 'file' && !/FILE/i.test(f.dataType || '')) return null;   // name clash with a non-file field
      return f;
    };
    await save('mapping fields');

    // 2. pipelines (only if opportunities included)
    let stageMap = null;
    if (inc.opportunities) {
      try {
        const [sp, tp] = await Promise.all([ghl(source, 'GET', '/opportunities/pipelines', { query: { locationId: source } }), ghl(target, 'GET', '/opportunities/pipelines', { query: { locationId: target } })]);
        stageMap = new Map();
        for (const p of sp.pipelines || []) {
          const tpipe = (tp.pipelines || []).find(x => norm(x.name) === norm(p.name));
          for (const s of p.stages || []) {
            const ts = tpipe?.stages?.find(x => norm(x.name) === norm(s.name));
            if (tpipe && ts) stageMap.set(s.id, { pipelineId: tpipe.id, stageId: ts.id });
          }
        }
      } catch (err) { fail('pipelines', err); stageMap = new Map(); }
    }

    // 3. contacts, in stable order with a cursor so a resume continues where it stopped
    const { sql: set, params } = contactSet({ sourceLocationId: source, packageId: push.package_id, filters: opts.filters });
    let cursor = progress.cursor || '';
    while (true) {
      const { rows } = await q(`${set} AND c.contact_id > $${params.length + 1} ORDER BY c.contact_id LIMIT ${BATCH}`, [...params, cursor]);
      if (!rows.length) break;
      let stop = false;
      for (const c of rows) {
        if (opts.limit && progress.contactsDone >= opts.limit) { stop = true; break; }
        try {
          const tid = await pushContact(c, { source, target, tag: opts.tag, fieldFor, inc, progress });
          if (inc.documents) await pushFiles(c, tid, { source, target, fieldFor, progress, fail });
          if (inc.opportunities && stageMap) await pushOpportunities(c, tid, { source, target, stageMap, progress, fail });
        } catch (err) {
          if (err.dailyLimit || err.cancelled) throw err;
          if (/401.*not authorized for this scope/i.test(err.message)) {
            throw new Error('The agency app token has no WRITE permission on the target. Add contacts.write, locations/customFields.write, opportunities.write and forms.write to the marketplace app\'s scopes, then click "Reconnect agency app" on the dashboard and Resume this push.');
          }
          fail(`contact ${c.contact_id}`, err);
        }
        progress.contactsDone++;
        cursor = c.contact_id; progress.cursor = cursor;
      }
      await save(`${progress.contactsDone.toLocaleString()} / ${Number(progress.total).toLocaleString()} contacts`);
      if (stop) break;
    }
    delete progress.cursor;
    await q(`UPDATE pushes SET status='done', finished_at=now(), progress=$2 WHERE id=$1`, [push.id, progress]);
  } catch (err) {
    if (err.cancelled) { await q('UPDATE pushes SET progress=$2 WHERE id=$1', [push.id, progress]); return; }
    if (err.dailyLimit) {
      const resetAt = nextQuotaReset();
      progress.note = `target hit GHL daily API quota · resumes ${resetAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      await q(`UPDATE pushes SET status='queued', not_before=$2, progress=$3 WHERE id=$1`, [push.id, resetAt, progress]);
      return;
    }
    await q(`UPDATE pushes SET status='failed', finished_at=now(), error=$2, progress=$3 WHERE id=$1`, [push.id, String(err.message).slice(0, 500), progress]);
    throw err;
  }
}

function nextQuotaReset() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 10));
  return (midnight - now) < 90 * 60_000 ? new Date(now.getTime() + 3600_000) : midnight;
}

async function mapped(target, kind, key) {
  const { rows: [r] } = await q('SELECT target_id FROM push_items WHERE target_location_id=$1 AND kind=$2 AND source_key=$3', [target, kind, key]);
  return r?.target_id || null;
}
async function remember(target, kind, key, id) {
  await q(`INSERT INTO push_items (target_location_id, kind, source_key, target_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (target_location_id, kind, source_key) DO UPDATE SET target_id=EXCLUDED.target_id, created_at=now()`, [target, kind, key, id]);
}

async function pushContact(c, { source, target, tag, fieldFor, inc, progress }) {
  const key = `${source}:${c.contact_id}`;
  const customFields = [];
  if (inc.customFields !== false) {
    for (const [name, value] of Object.entries(c.custom || {})) {
      if (value === null || value === '' || value === undefined) continue;
      const f = await fieldFor(name, 'text');
      if (f) customFields.push({ id: f.id, value: Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value) });
    }
  }
  const tags = [...new Set([...(c.tags || []), ...(tag ? [tag] : [])])];
  const body = {
    locationId: target,
    firstName: c.first_name || undefined, lastName: c.last_name || undefined,
    email: c.email || undefined, phone: c.phone || undefined, companyName: c.company || undefined,
    address1: c.address || undefined, city: c.city || undefined, state: c.state || undefined, postalCode: c.postal_code || undefined,
    tags, source: c.source || 'vault push', customFields,
  };
  if (!body.email && !body.phone && !body.firstName && !body.companyName) body.firstName = c.contact_id;   // GHL needs something identifying
  const existing = await mapped(target, 'contact', key);
  let id;
  if (existing) {
    try { await ghl(target, 'PUT', `/contacts/${existing}`, { body: { ...body, locationId: undefined } }); id = existing; progress.updated++; }
    catch (err) { if (!/404/.test(err.message)) throw err; id = null; }     // deleted in target since: recreate below
  }
  if (!id) {
    const data = await ghl(target, 'POST', '/contacts/upsert', { body });
    id = data.contact?.id || data.id;
    if (!id) throw new Error('upsert returned no contact id');
    if (data.new === false) progress.updated++; else progress.created++;
    await remember(target, 'contact', key, id);
  }
  return id;
}

async function pushFiles(c, targetContactId, { source, target, fieldFor, progress, fail }) {
  const { rows: files } = await q(
    `SELECT id, field_name, original_filename, mime_type, size_bytes, r2_key FROM files
     WHERE location_id=$1 AND contact_id=$2 AND status='done' AND source='contact_field' AND field_name IS NOT NULL AND r2_key IS NOT NULL ORDER BY field_name, id`,
    [source, c.contact_id]);
  if (!files.length) return;
  const byField = new Map();
  for (const f of files) {
    if (await mapped(target, 'file', String(f.id))) { progress.filesSkipped++; continue; }   // already pushed
    (byField.get(f.field_name) || byField.set(f.field_name, []).get(f.field_name)).push(f);
  }
  for (const [name, list] of byField) {
    const field = await fieldFor(name, 'file');
    if (!field) { for (const f of list) { progress.filesFailed++; } fail(`field "${name}"`, new Error('exists in target as a non-file field')); continue; }
    // batch files under a byte budget; one multipart request per batch, same key repeated per file
    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const fd = new FormData();
      for (const f of batch) {
        const buf = Buffer.from(await streamToBuffer(await getObjectStream(f.r2_key)));
        fd.append(field.id, new Blob([buf], { type: f.mime_type || 'application/octet-stream' }), f.original_filename || `${f.id}`);
      }
      try {
        await ghl(target, 'POST', '/forms/upload-custom-files', { query: { contactId: targetContactId, locationId: target }, form: fd });
        for (const f of batch) { await remember(target, 'file', String(f.id), targetContactId); progress.filesDone++; }
      } catch (err) {
        if (err.dailyLimit) throw err;
        progress.filesFailed += batch.length; fail(`upload ${name} for ${c.contact_id}`, err);
      }
      batch = []; bytes = 0;
    };
    for (const f of list) {
      if (batch.length && (batch.length >= FILES_PER_REQUEST || bytes + Number(f.size_bytes || 0) > UPLOAD_BATCH_BYTES)) await flush();
      batch.push(f); bytes += Number(f.size_bytes || 0);
    }
    await flush();
  }
}

async function pushOpportunities(c, targetContactId, { source, target, stageMap, progress, fail }) {
  const { rows } = await q('SELECT * FROM opportunities WHERE location_id=$1 AND contact_id=$2', [source, c.contact_id]);
  for (const o of rows) {
    const key = `${source}:${o.opportunity_id}`;
    if (await mapped(target, 'opportunity', key)) continue;
    const m = stageMap.get(o.stage_id);
    if (!m) { fail(`opportunity ${o.opportunity_id}`, new Error('no matching pipeline/stage name in target')); continue; }
    try {
      const data = await ghl(target, 'POST', '/opportunities/', { body: {
        pipelineId: m.pipelineId, pipelineStageId: m.stageId, locationId: target, contactId: targetContactId,
        name: c.company || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.contact_id,
        status: ['open', 'won', 'lost', 'abandoned'].includes(o.status) ? o.status : 'open',
        monetaryValue: o.monetary_value != null ? Number(o.monetary_value) : undefined,
      } });
      await remember(target, 'opportunity', key, data.opportunity?.id || data.id || 'ok'); progress.oppsDone++;
    } catch (err) { if (err.dailyLimit) throw err; fail(`opportunity ${o.opportunity_id}`, err); }
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const ch of stream) chunks.push(ch);
  return Buffer.concat(chunks);
}
