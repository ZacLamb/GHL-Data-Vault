import { q } from './db.js';

const digits = s => String(s || '').replace(/\D/g, '');

/** Cross-account contact search. Matches name, company, email, phone (digits), contact id, custom field values. */
export async function searchContacts(term, { locationId = null, limit = 50, offset = 0 } = {}) {
  const t = term.trim(); if (!t) return { total: 0, rows: [] };
  const d = digits(t);
  const params = [t, `%${t}%`, d.length >= 7 ? `%${d}%` : null, locationId];
  const where = `
    ($4::text IS NULL OR c.location_id = $4) AND (
      c.contact_id = $1
      OR lower(c.email) = lower($1)
      OR (coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')||' '||coalesce(c.company,'')||' '||coalesce(c.email,'')) ILIKE $2
      OR ($3::text IS NOT NULL AND regexp_replace(coalesce(c.phone,''), '\\D', '', 'g') LIKE $3)
      OR c.custom::text ILIKE $2
    )`;
  const { rows: [{ total }] } = await q(`SELECT count(*) AS total FROM contacts c WHERE ${where}`, params);
  const { rows } = await q(`
    SELECT c.location_id, l.name AS location_name, c.contact_id, c.first_name, c.last_name, c.email, c.phone, c.company, c.city, c.state,
           c.tags, c.date_added, c.assigned_to, u.name AS assigned_name,
           (SELECT count(*) FROM files f WHERE f.location_id=c.location_id AND f.contact_id=c.contact_id AND f.status='done') AS docs,
           (SELECT count(*) FROM opportunities o WHERE o.location_id=c.location_id AND o.contact_id=c.contact_id) AS opps,
           (SELECT max(date_added) FROM messages m WHERE m.location_id=c.location_id AND m.contact_id=c.contact_id) AS last_message
    FROM contacts c JOIN locations l ON l.location_id=c.location_id
    LEFT JOIN users u ON u.location_id=c.location_id AND u.user_id=c.assigned_to
    WHERE ${where}
    ORDER BY (c.contact_id = $1 OR lower(c.email) = lower($1)) DESC, c.date_added DESC NULLS LAST
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
  return { total: Number(total), rows: rows.map(r => ({ ...r, docs: Number(r.docs), opps: Number(r.opps) })) };
}

/** Cross-account file search by filename, field name, contact id, or mime type. */
export async function searchFiles(term, { locationId = null, limit = 50, offset = 0 } = {}) {
  const t = term.trim(); if (!t) return { total: 0, rows: [] };
  const params = [t, `%${t}%`, locationId];
  const where = `($3::text IS NULL OR f.location_id = $3) AND f.status='done' AND (
      f.contact_id = $1 OR f.original_filename ILIKE $2 OR f.field_name ILIKE $2 OR f.mime_type ILIKE $2 OR f.r2_key ILIKE $2)`;
  const { rows: [{ total }] } = await q(`SELECT count(*) AS total FROM files f WHERE ${where}`, params);
  const { rows } = await q(`
    SELECT f.id, f.location_id, l.name AS location_name, f.source, f.contact_id, f.field_name, f.original_filename, f.mime_type, f.size_bytes, f.uploaded_at, f.r2_key,
           c.first_name, c.last_name, c.company
    FROM files f JOIN locations l ON l.location_id=f.location_id
    LEFT JOIN contacts c ON c.location_id=f.location_id AND c.contact_id=f.contact_id
    WHERE ${where} ORDER BY f.uploaded_at DESC NULLS LAST, f.id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
  return { total: Number(total), rows };
}

/** Everything the vault holds about one contact. */
export async function contactDetail(locationId, contactId) {
  const [{ rows: [c] }, { rows: files }, { rows: opps }, { rows: msgs }, { rows: same }] = await Promise.all([
    q(`SELECT c.*, l.name AS location_name, u.name AS assigned_name FROM contacts c JOIN locations l ON l.location_id=c.location_id
        LEFT JOIN users u ON u.location_id=c.location_id AND u.user_id=c.assigned_to WHERE c.location_id=$1 AND c.contact_id=$2`, [locationId, contactId]),
    q(`SELECT id, source, field_name, original_filename, mime_type, size_bytes, uploaded_at, r2_key FROM files WHERE location_id=$1 AND contact_id=$2 AND status='done' ORDER BY field_name, id`, [locationId, contactId]),
    q(`SELECT opportunity_id, pipeline_id, stage_id, status, monetary_value, created_at, status_changed_at FROM opportunities WHERE location_id=$1 AND contact_id=$2 ORDER BY created_at DESC`, [locationId, contactId]),
    q(`SELECT channel, direction, count(*) AS n, max(date_added) AS last FROM messages WHERE location_id=$1 AND contact_id=$2 GROUP BY 1,2 ORDER BY 3 DESC`, [locationId, contactId]),
    q(`SELECT c2.location_id, l.name AS location_name, c2.contact_id, c2.first_name, c2.last_name, c2.company
        FROM contacts c1 JOIN contacts c2 ON c2.location_id <> c1.location_id AND (
          (c1.email <> '' AND lower(c2.email) = lower(c1.email)) OR
          (length(regexp_replace(coalesce(c1.phone,''), '\\D','','g')) >= 10 AND regexp_replace(coalesce(c2.phone,''), '\\D','','g') = regexp_replace(c1.phone, '\\D','','g')))
        JOIN locations l ON l.location_id=c2.location_id WHERE c1.location_id=$1 AND c1.contact_id=$2 LIMIT 50`, [locationId, contactId]),
  ]);
  return { contact: c, files, opportunities: opps, messages: msgs.map(m => ({ ...m, n: Number(m.n) })), alsoIn: same };
}

/** Agency-wide totals for the master page header. */
export async function agencyTotals() {
  const { rows: [r] } = await q(`SELECT (SELECT count(*) FROM locations) AS locations, (SELECT count(*) FROM contacts) AS contacts,
    (SELECT count(*) FROM files WHERE status='done') AS files, (SELECT coalesce(sum(size_bytes),0) FROM files WHERE status='done') AS bytes`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
