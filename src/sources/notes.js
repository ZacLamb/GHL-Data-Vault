// Contact notes: every note on every contact, saved to the `notes` table so the sub-account's
// notes can be downloaded as one CSV (GHL has no notes export). Opt-in: it costs one API call
// per contact, so it only runs when asked for ("Get notes"), never in the monthly backup.
import { ghl } from '../ghl.js';
import { limiter } from '../storage.js';
import { q } from '../db.js';
import { walkContacts } from './customFields.js';

const name = c => [c.firstName ?? c.firstNameLowerCase, c.lastName ?? c.lastNameLowerCase].filter(Boolean).join(' ').trim() || c.contactName || c.companyName || null;

export async function notes(ctx) {
  const { jobId, locationId, progress, save } = ctx;
  // A fresh run replaces the saved set, so notes deleted in GHL drop out. A resumed run keeps
  // what it already saved and carries on from its cursor.
  if (!progress.started) {
    await q('DELETE FROM notes WHERE location_id=$1', [locationId]);
    progress.started = true; progress.contactsSeen = 0; progress.notesFound = 0;
    await save();
  }
  const run = limiter(Number(process.env.NOTES_CONCURRENCY || 4));
  await walkContacts(locationId, { filters: [], progress, key: 'searchAfter', save }, async contacts => {
    await Promise.all(contacts.map(c => run(async () => {
      let data;
      try { data = await ghl(locationId, 'GET', `/contacts/${encodeURIComponent(c.id)}/notes`); }
      catch (err) {
        // A contact deleted while we walk the list: skip it. Anything else (quota, scope) stops the run.
        if (/ -> (400|404):/.test(err?.message || '')) { progress.skipped = (progress.skipped || 0) + 1; return; }
        if (/ -> (401|403):/.test(err?.message || '')) throw new Error("This sub-account's connection can't read notes. Reconnect it with the contacts.readonly scope.");
        throw err;
      }
      const list = (data.notes || []).filter(n => n && n.id);
      for (const n of list) {
        await q(`INSERT INTO notes (location_id, note_id, contact_id, contact_name, email, phone, body, user_id, date_added, job_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (location_id, note_id) DO UPDATE SET body=EXCLUDED.body, contact_name=EXCLUDED.contact_name,
                   email=EXCLUDED.email, phone=EXCLUDED.phone, user_id=EXCLUDED.user_id, date_added=EXCLUDED.date_added, job_id=EXCLUDED.job_id`,
          [locationId, n.id, c.id, name(c), c.email || null, c.phone || null, n.body ?? n.bodyText ?? '', n.userId || null,
           n.dateAdded ? new Date(n.dateAdded) : null, jobId]);
      }
      progress.notesFound += list.length;
    })));
    progress.contactsSeen += contacts.length;
  });
}
