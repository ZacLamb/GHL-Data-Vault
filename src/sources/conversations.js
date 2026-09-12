// Conversation message attachments (images, PDFs, MMS) + call recordings / voicemails.
import { ghl } from '../ghl.js';
import { ingest, limiter } from '../storage.js';

const BASE = 'https://services.leadconnectorhq.com';
const CALL_TYPES = new Set(['TYPE_CALL', 'TYPE_VOICEMAIL']);

export async function conversations(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  const run = limiter();
  progress.conversations ??= 0; progress.messages ??= 0; progress.filesFound ??= 0;
  let startAfterDate = progress.startAfterDate || undefined;

  while (true) {
    const data = await ghl(locationId, 'GET', '/conversations/search', {
      query: { locationId, limit: 100, sort: 'asc', sortBy: 'last_message_date', startAfterDate },
    });
    const convs = data.conversations || [];
    if (!convs.length) break;

    for (const conv of convs) {
      let lastMessageId;
      while (true) {
        const page = await ghl(locationId, 'GET', `/conversations/${conv.id}/messages`, { query: { limit: 100, lastMessageId } });
        const box = page.messages || {};
        const msgs = Array.isArray(box) ? box : (box.messages || []);
        const tasks = [];
        for (const m of msgs) {
          progress.messages++;
          for (const url of m.attachments || []) {
            progress.filesFound++;
            tasks.push(run(() => ingest(jobId, locationId, typeof url === 'string' ? url : url.url, {
              source: 'conversation', conversationId: conv.id, messageId: m.id, contactId: conv.contactId,
            })));
          }
          const dur = Number(m.meta?.call?.duration ?? m.meta?.duration ?? 0);
          if ((CALL_TYPES.has(m.messageType) || CALL_TYPES.has(m.type)) && dur > 0) {
            // Recording endpoint returns the audio bytes and needs the bearer token.
            // Calls with no duration (missed, failed, <1s) have no recording and return 422.
            const recUrl = `${BASE}/conversations/messages/${m.id}/locations/${locationId}/recording`;
            progress.filesFound++;
            tasks.push(run(() => ingest(jobId, locationId, recUrl, {
              source: 'recording', conversationId: conv.id, messageId: m.id, contactId: conv.contactId,
              originalFilename: `${m.id}.wav`, authenticated: true,
            })));
          }
        }
        await Promise.all(tasks);
        if (!box.nextPage || !box.lastMessageId) break;
        lastMessageId = box.lastMessageId;
      }
      progress.conversations++;
    }
    const last = convs[convs.length - 1];
    startAfterDate = last.lastMessageDate;
    progress.startAfterDate = startAfterDate;
    await save();
    if (convs.length < 100) break;
  }
}
