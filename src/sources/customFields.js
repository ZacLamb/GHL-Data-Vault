// Contact + opportunity custom fields of type FILE_UPLOAD.
import { ghl, parseFileFieldValue } from '../ghl.js';
import { ingest, limiter } from '../storage.js';

async function fileFields(locationId, model) {
  const data = await ghl(locationId, 'GET', `/locations/${locationId}/customFields`, { query: { model } });
  return (data.customFields || []).filter(f => /FILE/i.test(f.dataType || ''));
}

export async function contactFields(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const fields = await fileFields(locationId, 'contact');
  const byId = Object.fromEntries(fields.map(f => [f.id, f]));
  if (!fields.length) { progress.note = 'no file fields'; return; }

  const run = limiter();
  let searchAfter = progress.searchAfter || undefined;
  progress.contactsSeen ??= 0; progress.filesFound ??= 0;

  while (true) {
    const data = await ghl(locationId, 'POST', '/contacts/search', {
      body: { locationId, pageLimit: 100, ...(searchAfter ? { searchAfter } : {}) },
    });
    const contacts = data.contacts || [];
    if (!contacts.length) break;

    const tasks = [];
    for (const c of contacts) {
      for (const cf of c.customFields || []) {
        const def = byId[cf.id]; if (!def) continue;
        for (const f of parseFileFieldValue(cf.value)) {
          progress.filesFound++;
          tasks.push(run(() => ingest(jobId, locationId, f.url, {
            source: 'contact_field', contactId: c.id, fieldId: def.id, fieldName: def.name,
            originalFilename: f.name, mimeType: f.mimeType, size: f.size,
          })));
        }
      }
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
