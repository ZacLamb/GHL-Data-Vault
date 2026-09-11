// Media Library (Media Storage API). Recurses folders.
import { ghl } from '../ghl.js';
import { ingest, limiter } from '../storage.js';

export async function media(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const run = limiter();
  progress.filesFound ??= 0;
  const queue = [progress.folder || null];
  const seenFolders = new Set(progress.doneFolders || []);

  while (queue.length) {
    const parentId = queue.shift();
    let offset = 0;
    while (true) {
      const data = await ghl(locationId, 'GET', '/medias/files', {
        query: { altType: 'location', altId: locationId, limit: 100, offset, sortBy: 'createdAt', sortOrder: 'asc', parentId: parentId || undefined },
      });
      const items = data.files || [];
      if (!items.length) break;
      const tasks = [];
      for (const f of items) {
        if (f.type === 'folder' || f.isFolder) { if (!seenFolders.has(f._id || f.id)) queue.push(f._id || f.id); continue; }
        if (!f.url) continue;
        progress.filesFound++;
        tasks.push(run(() => ingest(jobId, locationId, f.url, {
          source: 'media', documentId: f._id || f.id, originalFilename: f.name, mimeType: f.contentType || f.type, size: f.size,
          fieldName: f.path || undefined,
        })));
      }
      await Promise.all(tasks);
      offset += items.length;
      if (items.length < 100) break;
    }
    if (parentId) seenFolders.add(parentId);
    progress.doneFolders = [...seenFolders];
    await save();
  }
}
