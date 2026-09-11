// Contact + opportunity custom fields of type FILE_UPLOAD.
import { ghl, parseFileFieldValue } from '../ghl.js';
import { ingest, limiter } from '../storage.js';
import { q } from '../db.js';

async function upsertContact(locationId, c, fileFieldIds, nameById, fileCount) {
  const custom = {};
  for (const cf of c.customFields || []) if (!fileFieldIds.has(cf.id)) custom[nameById[cf.id] || cf.id] = cf.value;
  await q(`INSERT INTO contacts (location_id, contact_id, first_name, last_name, email, phone, company, address, city, state,
             postal_code, tags, date_added, custom, file_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
           ON CONFLICT (location_id, contact_id) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
             email=EXCLUDED.email, phone=EXCLUDED.phone, company=EXCLUDED.company, address=EXCLUDED.address, city=EXCLUDED.city,
             state=EXCLUDED.state, postal_code=EXCLUDED.postal_code, tags=EXCLUDED.tags, date_added=EXCLUDED.date_added,
             custom=EXCLUDED.custom, file_count=EXCLUDED.file_count, updated_at=now()`,
    [locationId, c.id, c.firstName, c.lastName, c.email, c.phone, c.companyName, c.address1, c.city, c.state, c.postalCode,
     c.tags || [], c.dateAdded ? new Date(c.dateAdded) : null, custom, fileCount]);
}

async function fileFields(locationId, model) {
  const data = await ghl(locationId, 'GET', `/locations/${locationId}/customFields`, { query: { model } });
  return (data.customFields || []).filter(f => /FILE/i.test(f.dataType || ''));
}

export async function contactFields(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const fields = await fileFields(locationId, 'contact');
  const byId = Object.fromEntries(fields.map(f => [f.id, f]));
  const fileFieldIds = new Set(fields.map(f => f.id));
  const allDefs = (await ghl(locationId, 'GET', `/locations/${locationId}/customFields`, { query: { model: 'contact' } })).customFields || [];
  const nameById = Object.fromEntries(allDefs.map(f => [f.id, f.name]));
  if (!fields.length) progress.note = 'no file fields — contact records still captured';

  const run = limiter();
  let searchAfter = progress.searchAfter || undefined;
  progress.contactsSeen ??= 0; progress.filesFound ??= 0;

  while (true) {
    const data = await ghl(locationId, 'POST', '/contacts/search', {
      body: { locationId, pageLimit: 100, ...(searchAfter ? { searchAfter } : {}) },
    });
    let contacts = data.contacts || [];
    if (!contacts.length) break;

    // Some accounts' search results omit custom field values entirely. If a whole page has none,
    // fetch each contact individually (slower, but complete) and remember that for the rest of the run.
    if (fields.length && (progress.fetchIndividually || !contacts.some(c => c.customFields?.length))) {
      progress.fetchIndividually = true;
      contacts = await Promise.all(contacts.map(c => ghl(locationId, 'GET', `/contacts/${c.id}`).then(d => ({ ...c, ...d.contact })).catch(() => c)));
    }

    const tasks = [];
    for (const c of contacts) {
      let fileCount = 0;
      for (const cf of c.customFields || []) {
        const def = byId[cf.id]; if (!def) continue;
        for (const f of parseFileFieldValue(cf.value)) {
          progress.filesFound++; fileCount++;
          tasks.push(run(() => ingest(jobId, locationId, f.url, {
            source: 'contact_field', contactId: c.id, fieldId: def.id, fieldName: def.name,
            originalFilename: f.name, mimeType: f.mimeType, size: f.size,
          })));
        }
      }
      tasks.push(upsertContact(locationId, c, fileFieldIds, nameById, fileCount));
    }
    await Promise.all(tasks);
    progress.contactsSeen += contacts.length;
    searchAfter = contacts[contacts.length - 1].searchAfter;
    progress.searchAfter = searchAfter;
    await save();
    if (!searchAfter || contacts.length < 100) break;
  }
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
            fieldId: def.id, fieldName: def.name, originalFilename: f.name, mimeType: f.mimeType, size: f.size,
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
