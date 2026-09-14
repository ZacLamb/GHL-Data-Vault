import { q } from './db.js';

/**
 * Build a WHERE clause over `contacts c` from dashboard filters. Returns { sql, params }.
 * Document counts use the files table (status='done') so they reflect what's actually in R2.
 */
export function buildFilter(locationId, f = {}) {
  const params = [locationId];
  const where = ['c.location_id = $1'];
  const p = v => { params.push(v); return `$${params.length}`; };
  const docCount = `(SELECT count(*) FROM files fx WHERE fx.location_id=c.location_id AND fx.contact_id=c.contact_id AND fx.status='done')`;

  if (f.minFiles != null && f.minFiles !== '') where.push(`${docCount} >= ${p(Number(f.minFiles))}`);
  if (f.maxFiles != null && f.maxFiles !== '') where.push(`${docCount} <= ${p(Number(f.maxFiles))}`);
  for (const field of arr(f.fields)) where.push(`EXISTS (SELECT 1 FROM files fx WHERE fx.location_id=c.location_id AND fx.contact_id=c.contact_id AND fx.status='done' AND fx.field_name = ${p(field)})`);
  for (const field of arr(f.notFields)) where.push(`NOT EXISTS (SELECT 1 FROM files fx WHERE fx.location_id=c.location_id AND fx.contact_id=c.contact_id AND fx.status='done' AND fx.field_name = ${p(field)})`);
  if (arr(f.tags).length) where.push(`c.tags && ${p(arr(f.tags))}::text[]`);
  if (arr(f.states).length) where.push(`upper(c.state) = ANY(${p(arr(f.states).map(s => s.toUpperCase()))}::text[])`);
  if (f.docsFrom || f.docsTo) {
    const conds = [`fx.location_id=c.location_id`, `fx.contact_id=c.contact_id`, `fx.status='done'`];
    if (f.docsFrom) conds.push(`fx.uploaded_at >= ${p(f.docsFrom)}`);
    if (f.docsTo) conds.push(`fx.uploaded_at < ${p(f.docsTo)}::date + 1`);
    if (f.docsField) conds.push(`fx.field_name = ${p(f.docsField)}`);
    where.push(`EXISTS (SELECT 1 FROM files fx WHERE ${conds.join(' AND ')})`);
  }
  if (f.updatedFrom) where.push(`c.date_updated >= ${p(f.updatedFrom)}`);
  if (f.updatedTo) where.push(`c.date_updated < ${p(f.updatedTo)}::date + 1`);
  if (f.addedFrom) where.push(`c.date_added >= ${p(f.addedFrom)}`);
  if (f.addedTo) where.push(`c.date_added < ${p(f.addedTo)}::date + 1`);
  if (f.customKey && f.customValue != null && f.customValue !== '') where.push(`c.custom->>${p(f.customKey)} ILIKE ${p('%' + f.customValue + '%')}`);
  if (f.q) { const like = p('%' + f.q + '%'); where.push(`(c.first_name ILIKE ${like} OR c.last_name ILIKE ${like} OR c.email ILIKE ${like} OR c.company ILIKE ${like} OR c.phone ILIKE ${like})`); }
  if (f.unassigned) where.push(`NOT EXISTS (SELECT 1 FROM package_contacts pc WHERE pc.location_id=c.location_id AND pc.contact_id=c.contact_id AND pc.locked)`);

  return { sql: where.join(' AND '), params, docCount };
}
const arr = v => v == null || v === '' ? [] : Array.isArray(v) ? v.filter(Boolean) : String(v).split(',').map(s => s.trim()).filter(Boolean);

export async function summary(locationId) {
  const { rows: [s] } = await q(`
    WITH dc AS (
      SELECT c.contact_id, (SELECT count(*) FROM files f WHERE f.location_id=c.location_id AND f.contact_id=c.contact_id AND f.status='done') AS n
      FROM contacts c WHERE c.location_id=$1)
    SELECT count(*)                                  AS contacts,
           count(*) FILTER (WHERE n > 0)             AS with_docs,
           count(*) FILTER (WHERE n = 0)             AS without_docs,
           coalesce(sum(n),0)                        AS documents,
           round(avg(n) FILTER (WHERE n > 0), 2)     AS avg_per_contact_with_docs,
           count(*) FILTER (WHERE n = 1)             AS b1,
           count(*) FILTER (WHERE n BETWEEN 2 AND 4) AS b2_4,
           count(*) FILTER (WHERE n BETWEEN 5 AND 9) AS b5_9,
           count(*) FILTER (WHERE n >= 10)           AS b10p
    FROM dc`, [locationId]);
  const { rows: [pk] } = await q(`SELECT count(*) AS assigned FROM package_contacts WHERE location_id=$1 AND locked`, [locationId]);
  const { rows: [st] } = await q(`SELECT coalesce(sum(size_bytes),0) AS bytes, count(*) FILTER (WHERE status='failed') AS failed FROM files WHERE location_id=$1`, [locationId]);
  return { ...num(s), assigned: Number(pk.assigned), unassigned: Number(s.contacts) - Number(pk.assigned), bytes: Number(st.bytes), failed_files: Number(st.failed) };
}

export async function breakdowns(locationId) {
  const [fields, tags, states, months, sources, docMonths] = await Promise.all([
    q(`SELECT field_name AS key, count(DISTINCT contact_id) AS contacts, count(*) AS files FROM files
        WHERE location_id=$1 AND status='done' AND contact_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [locationId]),
    q(`SELECT t AS key, count(*) AS contacts FROM contacts c, unnest(c.tags) t WHERE c.location_id=$1 GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [locationId]),
    q(`SELECT upper(state) AS key, count(*) AS contacts FROM contacts WHERE location_id=$1 AND state <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 60`, [locationId]),
    q(`SELECT to_char(date_trunc('month', date_added),'YYYY-MM') AS key, count(*) AS contacts FROM contacts
        WHERE location_id=$1 AND date_added IS NOT NULL GROUP BY 1 ORDER BY 1`, [locationId]),
    q(`SELECT source AS key, count(*) AS files, count(*) FILTER (WHERE status='done') AS done, count(*) FILTER (WHERE status='failed') AS failed
        FROM files WHERE location_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [locationId]),
    q(`SELECT to_char(date_trunc('month', uploaded_at),'YYYY-MM') AS key, count(*) AS files, count(DISTINCT contact_id) AS contacts FROM files
        WHERE location_id=$1 AND status='done' AND uploaded_at IS NOT NULL GROUP BY 1 ORDER BY 1`, [locationId]),
  ]);
  const { rows: [undated] } = await q(`SELECT count(*) AS n FROM files WHERE location_id=$1 AND status='done' AND uploaded_at IS NULL`, [locationId]);
  const { rows: customKeys } = await q(`SELECT DISTINCT jsonb_object_keys(custom) AS key FROM contacts WHERE location_id=$1 ORDER BY 1`, [locationId]);
  return { fields: fields.rows.map(num), tags: tags.rows.map(num), states: states.rows.map(num), months: months.rows.map(num), sources: sources.rows.map(num),
           docMonths: docMonths.rows.map(num), undatedFiles: Number(undated.n), customKeys: customKeys.map(r => r.key) };
}

export async function search(locationId, filters, { page = 1, limit = 50 } = {}) {
  const { sql, params, docCount } = buildFilter(locationId, filters);
  const { rows: [{ total }] } = await q(`SELECT count(*) AS total FROM contacts c WHERE ${sql}`, params);
  const { rows } = await q(`
    SELECT c.contact_id, c.first_name, c.last_name, c.email, c.phone, c.company, c.state, c.tags, c.date_added,
           ${docCount} AS docs,
           (SELECT string_agg(DISTINCT fx.field_name, ', ') FROM files fx WHERE fx.location_id=c.location_id AND fx.contact_id=c.contact_id AND fx.status='done') AS fields,
           EXISTS (SELECT 1 FROM package_contacts pc WHERE pc.location_id=c.location_id AND pc.contact_id=c.contact_id AND pc.locked) AS assigned
    FROM contacts c WHERE ${sql}
    ORDER BY c.date_added DESC NULLS LAST, c.contact_id
    LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`, params);
  return { total: Number(total), page: Number(page), limit: Number(limit), rows: rows.map(r => ({ ...r, docs: Number(r.docs) })) };
}

export async function* searchAll(locationId, filters) {
  const { sql, params, docCount } = buildFilter(locationId, filters);
  const { rows } = await q(`SELECT c.*, ${docCount} AS docs FROM contacts c WHERE ${sql} ORDER BY c.contact_id`, params);
  for (const r of rows) yield r;
}

const num = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
