// Conversation message attachments (images, PDFs, MMS) + call recordings / voicemails.
import { ghl } from '../ghl.js';
import { ingest, limiter } from '../storage.js';
import { q } from '../db.js';

const CHANNEL = t => {
  const s = String(t || '').toUpperCase();
  if (s.includes('SMS')) return 'SMS'; if (s.includes('EMAIL')) return 'EMAIL'; if (s.includes('VOICEMAIL')) return 'VOICEMAIL';
  if (s.includes('CALL')) return 'CALL'; if (s.includes('WHATSAPP')) return 'WHATSAPP'; if (s.includes('FB') || s.includes('FACEBOOK')) return 'FB';
  if (s.includes('INSTAGRAM') || s.includes('IG')) return 'IG'; if (s.includes('LIVE') || s.includes('CHAT')) return 'LIVE_CHAT'; if (s.includes('GMB')) return 'GMB';
  if (s.includes('ACTIVITY')) return 'ACTIVITY'; return 'OTHER';
};
// Wording is kept for text channels only (emails are HTML and calls have none): it feeds Best texts.
const TEXT_CHANNELS = new Set(['SMS', 'WHATSAPP', 'FB', 'IG', 'LIVE_CHAT', 'GMB']);
async function recordMessage(locationId, conv, m) {
  const channel = CHANNEL(m.messageType || m.type);
  const body = TEXT_CHANNELS.has(channel) && typeof m.body === 'string' && m.body.trim() ? m.body.slice(0, 2000) : null;
  await q(`INSERT INTO messages (location_id, message_id, conversation_id, contact_id, user_id, direction, channel, status, call_duration, date_added, body, sent_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (location_id, message_id) DO UPDATE SET user_id=EXCLUDED.user_id, status=EXCLUDED.status, call_duration=EXCLUDED.call_duration,
             body=COALESCE(EXCLUDED.body, messages.body), sent_by=COALESCE(EXCLUDED.sent_by, messages.sent_by)`,
    [locationId, m.id, conv.id, m.contactId || conv.contactId, m.userId || null, m.direction || null, channel,
     m.status || m.meta?.call?.status || null, Number(m.meta?.call?.duration ?? 0) || null, m.dateAdded ? new Date(m.dateAdded) : null,
     body, m.source || null]);
}

const BASE = 'https://services.leadconnectorhq.com';
const CALL_TYPES = new Set(['TYPE_CALL', 'TYPE_VOICEMAIL']);

// On-demand "message_text": the same walk, recording messages only (no attachment or recording
// downloads). Used once per sub-account to fill in wording for messages backed up before it was kept.
export const messageText = (ctx) => conversations({ ...ctx, textOnly: true });

export async function conversations(ctx) {
  const { jobId, locationId, progress, save, since, textOnly } = ctx;
  const run = limiter();
  progress.conversations ??= 0; progress.messages ??= 0; progress.filesFound ??= 0;
  let startAfterDate = progress.startAfterDate || (since ? new Date(since).getTime() : undefined);

  while (true) {
    const data = await ghl(locationId, 'GET', '/conversations/search', {
      query: { locationId, limit: 100, sort: 'asc', sortBy: 'last_message_date', startAfterDate },
    });
    const convs = data.conversations || [];
    // Size of the job, for progress bars (only meaningful for a full pass, not a since-last-backup one).
    if (!since && progress.total == null && Number.isFinite(Number(data.total))) progress.total = Number(data.total);
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
          tasks.push(recordMessage(locationId, conv, m).catch(() => {}));
          if (textOnly) continue;
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
