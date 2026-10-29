// Contact + opportunity custom fields of type FILE_UPLOAD.
import { ghl, parseFileFieldValue, repairCursor, sleep } from '../ghl.js';
import { ingest, limiter } from '../storage.js';
import { q } from '../db.js';

async function upsertContact(locationId, c, fileFieldIds, nameById, fileCount) {
  const custom = {};
  for (const cf of c.customFields || []) if (!fileFieldIds.has(cf.id)) custom[nameById[cf.id] || cf.id] = cf.value;
  await q(`INSERT INTO contacts (location_id, contact_id, first_name, last_name, email, phone, company, address, city, state,
             postal_code, tags, date_added, custom, file_count, updated_at, assigned_to, created_by_user, source, date_updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$18,$19)
           ON CONFLICT (location_id, contact_id) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
             email=EXCLUDED.email, phone=EXCLUDED.phone, company=EXCLUDED.company, address=EXCLUDED.address, city=EXCLUDED.city,
             state=EXCLUDED.state, postal_code=EXCLUDED.postal_code, tags=EXCLUDED.tags, date_added=EXCLUDED.date_added,
             custom=EXCLUDED.custom, file_count=COALESCE(EXCLUDED.file_count, contacts.file_count), updated_at=now(),
             assigned_to=EXCLUDED.assigned_to, created_by_user=COALESCE(EXCLUDED.created_by_user, contacts.created_by_user), source=EXCLUDED.source, date_updated=EXCLUDED.date_updated`,
    [locationId, c.id, c.firstName, c.lastName, c.email, c.phone, c.companyName, c.address1 ?? c.address, c.city, c.state, c.postalCode,
     c.tags || [], c.dateAdded ? new Date(c.dateAdded) : null, custom, fileCount ?? 0,
     c.assignedTo || null, c.createdBy?.userId || (c.createdBy?.source === 'USER' ? c.createdBy?.sourceId : null) || null, c.source || null,
     c.dateUpdated ? new Date(c.dateUpdated) : null]);
}

// ---- contact paging ----------------------------------------------------------------------------
// POST /contacts/search caps page-number paging at ~10,000 results, so we only ever walk with the
// `searchAfter` cursor: every contact in a response carries its own `searchAfter` (its sort values,
// e.g. [dateAdded ms, id]) and sending the last one back returns the next page. The sort is pinned
// to dateAdded ascending so the order is stable for the whole walk and contacts created mid-crawl
// land at the end instead of shifting earlier pages. The cursor is checkpointed after every page,
// together with the sort it belongs to, so a stopped/failed/quota-parked job resumes exactly there.
const PAGE = 100;
const SORT = [{ field: 'dateAdded', direction: 'asc' }];
const is400 = err => / -> 400:/.test(err?.message || '');

// The search backend sometimes answers a valid request with a generic 400; give it two more tries.
async function search(locationId, body) {
  for (let attempt = 0; ; attempt++) {
    try { return await ghl(locationId, 'POST', '/contacts/search', { body }); }
    catch (err) { if (!is400(err) || attempt >= 2) throw err; await sleep(3000 * 3 ** attempt); }
  }
}

export async function walkContacts(locationId, { filters, progress, key, save }, onPage) {
  const sortKey = `${key}Sort`;
  let cursor = repairCursor(progress[key]) || undefined;
  if (cursor && !progress[sortKey]) progress[sortKey] = 'default';   // checkpoint from before the pinned sort: keep GHL's default order
  while (true) {
    const pinned = progress[sortKey] !== 'default';
    const body = { locationId, pageLimit: PAGE, ...(filters.length ? { filters } : {}), ...(pinned ? { sort: SORT } : {}), ...(cursor ? { searchAfter: cursor } : {}) };
    let data;
    try { data = await search(locationId, body); }
    catch (err) {
      // Sort rejected on the very first page: fall back to GHL's default order (also cursor-paged).
      if (pinned && !cursor && is400(err)) { progress[sortKey] = 'default'; continue; }
      throw err;
    }
    progress[sortKey] ??= 'dateAdded';
    const page = data.contacts || [];
    if (!page.length) break;
    await onPage(page);
    cursor = page[page.length - 1].searchAfter;
    progress[key] = cursor;
    await save();
    if (!Array.isArray(cursor) || !cursor.length || page.length < PAGE) break;
  }
  delete progress[key]; delete progress[sortKey];
}

async function fileFields(locationId, model) {
  const data = await ghl(locationId, 'GET', `/locations/${locationId}/customFields`, { query: { model } });
  return (data.customFields || []).filter(f => /FILE/i.test(f.dataType || ''));
}

export async function contactFields(ctx) {
  const { jobId, locationId, progress, save, since } = ctx;
  // Incremental runs: only contacts updated since the last export.
  const sinceFilter = since ? [{ field: 'dateUpdated', operator: 'range', value: { gte: since } }] : [];
  if (since) progress.since = since;
  const fields = await fileFields(locationId, 'contact');
  const byId = Object.fromEntries(fields.map(f => [f.id, f]));
  const fileFieldIds = new Set(fields.map(f => f.id));
  const allDefs = (await ghl(locationId, 'GET', `/locations/${locationId}/customFields`, { query: { model: 'contact' } })).customFields || [];
  const nameById = Object.fromEntries(allDefs.map(f => [f.id, f.name]));
  const run = limiter();
  progress.contactsSeen ??= 0; progress.filesFound ??= 0; progress.candidates ??= 0; progress.fetched ??= 0;

  // ---- Pass 1: every contact record, straight from search (fast; file fields are omitted by search) ----
  if (!progress.pass1Done) {
    await walkContacts(locationId, { filters: sinceFilter, progress, key: 'searchAfter', save }, async contacts => {
      await Promise.all(contacts.map(c => upsertContact(locationId, c, fileFieldIds, nameById, null)));
      progress.contactsSeen += contacts.length;
    });
    progress.pass1Done = true; await save();
  }
  if (!fields.length) { progress.note = 'no file fields on this location'; return; }

  // ---- Pass 2: only contacts with at least one file field populated (search "exists" filter), fetched individually ----
  // Falls back to scanning every contact if the filter is rejected.
  const existsFilter = { group: 'OR', filters: fields.map(f => ({ field: `customFields.${f.id}`, operator: 'exists' })) };
  if (progress.mode == null) {
    try {
      const probe = await ghl(locationId, 'POST', '/contacts/search', { body: { locationId, pageLimit: 1, filters: [...sinceFilter, existsFilter] } });
      progress.mode = 'filtered'; progress.candidatesTotal = probe.total ?? null;
    } catch (err) { progress.mode = 'full'; progress.note = `exists filter rejected (${err.message.slice(0, 120)}); scanning every contact`; }
    await save();
  }

  const filters = [...sinceFilter, ...(progress.mode === 'filtered' ? [existsFilter] : [])];
  await walkContacts(locationId, { filters, progress, key: 'searchAfter2', save }, async page => {
    progress.candidates += page.length;

    // GET /contacts/{id} is the only call that returns FILE_UPLOAD values.
    const contacts = await Promise.all(page.map(c => ghl(locationId, 'GET', `/contacts/${c.id}`).then(d => { progress.fetched++; return { ...c, ...d.contact }; })
      .catch(() => { progress.getErrors = (progress.getErrors || 0) + 1; return c; })));

    const tasks = [];
    for (const c of contacts) {
      let fileCount = 0;
      for (const cf of c.customFields || []) {
        const def = byId[cf.id]; if (!def) continue;
        for (const f of parseFileFieldValue(cf.value)) {
          progress.filesFound++; fileCount++;
          tasks.push(run(() => ingest(jobId, locationId, f.url, {
            source: 'contact_field', contactId: c.id, fieldId: def.id, fieldName: def.name,
            originalFilename: f.name, mimeType: f.mimeType, size: f.size, altUrl: f.altUrl,
          })));
        }
      }
      tasks.push(upsertContact(locationId, c, fileFieldIds, nameById, fileCount));
    }
    await Promise.all(tasks);
  });
}

export async function opportunityFields(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const fields = await fileFields(locationId, 'opportunity');
  const byId = Object.fromEntries(fields.map(f => [f.id, f]));
  if (!fields.length) { progress.note = 'no file fields'; return; }

  const run = limiter();
  let { startAfterId, startAfter } = progress;
  progress.seen ??= 0; progress.filesFound ??= 0;

  while (true) {
    const data = await ghl(locationId, 'GET', '/opportunities/search', {
      query: { location_id: locationId, limit: 100, startAfterId, startAfter },
    });
    const opps = data.opportunities || [];
    if (!opps.length) break;
    const tasks = [];
    for (const o of opps) {
      for (const cf of o.customFields || []) {
        const def = byId[cf.id]; if (!def) continue;
        for (const f of parseFileFieldValue(cf.fieldValue ?? cf.value)) {
          progress.filesFound++;
          tasks.push(run(() => ingest(jobId, locationId, f.url, {
            source: 'opportunity_field', opportunityId: o.id, contactId: o.contactId ?? o.contact?.id,
            fieldId: def.id, fieldName: def.name, originalFilename: f.name, mimeType: f.mimeType, size: f.size, altUrl: f.altUrl,
          })));
        }
      }
    }
    await Promise.all(tasks);
    progress.seen += opps.length;
    startAfterId = data.meta?.startAfterId; startAfter = data.meta?.startAfter;
    Object.assign(progress, { startAfterId, startAfter });
    await save();
    if (!data.meta?.nextPageUrl && !startAfterId) break;
  }
}
