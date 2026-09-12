// Media Library (Media Storage API). The endpoint requires type=file|folder; we list files at each
// level and walk folders recursively.
import { ghl } from '../ghl.js';
import { ingest, limiter } from '../storage.js';

async function listAll(locationId, type, parentId) {
  const out = []; let offset = 0;
  while (true) {
    const data = await ghl(locationId, 'GET', '/medias/files', {
      query: { altType: 'location', altId: locationId, type, limit: 100, offset, sortBy: 'createdAt', sortOrder: 'asc', parentId: parentId || undefined },
    });
    const items = data.files || [];
    out.push(...items);
    offset += items.length;
    if (items.length < 100) break;
  }
  return out;
}

export async function media(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const run = limiter();
  progress.filesFound ??= 0; progress.folders ??= 0;
  const queue = [null];
  const seen = new Set(progress.doneFolders || []);

  while (queue.length) {
    const parentId = queue.shift();
    if (parentId && seen.has(parentId)) continue;

    const files = await listAll(locationId, 'file', parentId);
    const tasks = [];
    for (const f of files) {
      if (!f.url) continue;
      progress.filesFound++;
      tasks.push(run(() => ingest(jobId, locationId, f.url, {
        source: 'media', documentId: f._id || f.id, originalFilename: f.name, mimeType: f.contentType || f.mimeType, size: f.size,
        fieldName: f.path || (parentId ? `folder-${parentId}` : 'root'),
      })));
    }
    await Promise.all(tasks);

    const folders = await listAll(locationId, 'folder', parentId);
    for (const d of folders) { const id = d._id || d.id; if (id && !seen.has(id)) queue.push(id); }

    if (parentId) { seen.add(parentId); progress.folders++; }
    progress.doneFolders = [...seen];
    await save();
  }
}
