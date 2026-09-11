// Documents & Contracts (proposals/estimates/signed agreements).
// NOTE: this is the least stable part of GHL's public API. The list endpoint is
// GET /proposals/document?locationId=...; the signed PDF link key varies by document
// state, so we harvest every URL on the object that looks like a file and skip the rest.
import { ghl, harvestUrls } from '../ghl.js';
import { ingest, limiter } from '../storage.js';

export async function documents(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const run = limiter();
  progress.documents ??= 0; progress.filesFound ??= 0;
  let skip = progress.skip || 0;

  while (true) {
    let data;
    try {
      data = await ghl(locationId, 'GET', '/proposals/document', { query: { locationId, limit: 50, skip } });
    } catch (err) {
      progress.note = `documents endpoint unavailable: ${err.message.slice(0, 200)}`;
      await save(); return;
    }
    const docs = data.documents || data.data || [];
    if (!docs.length) break;
    const tasks = [];
    for (const d of docs) {
      const urls = harvestUrls(d).filter(u => /\.(pdf|png|jpe?g|docx?)(\?|$)/i.test(u) || /download|storage|msgsndr|documents/i.test(u));
      for (const url of new Set(urls)) {
        progress.filesFound++;
        tasks.push(run(() => ingest(jobId, locationId, url, {
          source: 'document', documentId: d._id || d.id, contactId: d.contactId ?? d.contact?.id,
          originalFilename: d.name ? `${d.name}.pdf` : undefined,
        })));
      }
    }
    await Promise.all(tasks);
    progress.documents += docs.length;
    skip += docs.length; progress.skip = skip;
    await save();
    if (docs.length < 50) break;
  }
}
