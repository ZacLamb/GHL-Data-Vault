import { q } from './db.js';

const num = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
const range = (from, to) => [from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000), to ? new Date(new Date(to).getTime() + 86_400_000) : new Date()];

export async function locationUsage(locationId, from, to) {
  const [a, b] = range(from, to);
  const [{ rows: [m] }, { rows: [c] }, { rows: [o] }, { rows: [ap] }, { rows: channels }] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE direction='outbound') AS outbound, count(*) FILTER (WHERE direction='inbound') AS inbound,
              count(*) FILTER (WHERE channel='CALL') AS calls, coalesce(sum(call_duration) FILTER (WHERE channel='CALL'),0) AS talk_seconds,
              count(DISTINCT user_id) FILTER (WHERE direction='outbound') AS active_users, count(DISTINCT contact_id) AS contacts_touched
       FROM messages WHERE location_id=$1 AND date_added >= $2 AND date_added < $3`, [locationId, a, b]),
    q(`SELECT count(*) AS created FROM contacts WHERE location_id=$1 AND date_added >= $2 AND date_added < $3`, [locationId, a, b]),
    q(`SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $3) AS created,
              count(*) FILTER (WHERE status='won' AND status_changed_at >= $2 AND status_changed_at < $3) AS won,
              count(*) FILTER (WHERE status='lost' AND status_changed_at >= $2 AND status_changed_at < $3) AS lost,
              coalesce(sum(monetary_value) FILTER (WHERE status='won' AND status_changed_at >= $2 AND status_changed_at < $3),0) AS won_value,
              count(*) FILTER (WHERE status='open') AS open_now
       FROM opportunities WHERE location_id=$1`, [locationId, a, b]),
    q(`SELECT count(*) AS booked FROM appointments WHERE location_id=$1 AND start_time >= $2 AND start_time < $3`, [locationId, a, b]),
    q(`SELECT channel, direction, count(*) AS n FROM messages WHERE location_id=$1 AND date_added >= $2 AND date_added < $3 GROUP BY 1,2 ORDER BY 3 DESC`, [locationId, a, b]),
  ]);
  return { from: a, to: b, messages: num(m), contacts: num(c), opportunities: num(o), appointments: num(ap), channels: channels.map(num) };
}

export async function userUsage(locationId, from, to) {
  const [a, b] = range(from, to);
  const { rows } = await q(`
    WITH msg AS (
      SELECT user_id,
             count(*) FILTER (WHERE direction='outbound' AND channel='SMS') AS sms_out,
             count(*) FILTER (WHERE direction='outbound' AND channel='EMAIL') AS email_out,
             count(*) FILTER (WHERE direction='outbound' AND channel IN ('WHATSAPP','FB','IG','LIVE_CHAT','GMB')) AS social_out,
             count(*) FILTER (WHERE channel='CALL' AND direction='outbound') AS calls_out,
             count(*) FILTER (WHERE channel='CALL' AND direction='inbound') AS calls_in,
             coalesce(sum(call_duration) FILTER (WHERE channel='CALL'),0) AS talk_seconds,
             count(*) FILTER (WHERE direction='outbound') AS total_out,
             count(DISTINCT contact_id) FILTER (WHERE direction='outbound') AS contacts_touched,
             count(DISTINCT date_added::date) AS active_days,
             min(date_added) AS first_activity, max(date_added) AS last_activity
      FROM messages WHERE location_id=$1 AND date_added >= $2 AND date_added < $3 AND user_id IS NOT NULL GROUP BY user_id),
    cc AS (SELECT created_by_user AS user_id, count(*) AS contacts_created FROM contacts WHERE location_id=$1 AND date_added >= $2 AND date_added < $3 AND created_by_user IS NOT NULL GROUP BY 1),
    ca AS (SELECT assigned_to AS user_id, count(*) AS contacts_assigned FROM contacts WHERE location_id=$1 AND assigned_to IS NOT NULL GROUP BY 1),
    op AS (SELECT assigned_to AS user_id,
             count(*) FILTER (WHERE created_at >= $2 AND created_at < $3) AS opps_created,
             count(*) FILTER (WHERE status='won' AND status_changed_at >= $2 AND status_changed_at < $3) AS opps_won,
             coalesce(sum(monetary_value) FILTER (WHERE status='won' AND status_changed_at >= $2 AND status_changed_at < $3),0) AS won_value,
             count(*) FILTER (WHERE status='open') AS opps_open
           FROM opportunities WHERE location_id=$1 AND assigned_to IS NOT NULL GROUP BY 1),
    ap AS (SELECT user_id, count(*) AS appointments FROM appointments WHERE location_id=$1 AND start_time >= $2 AND start_time < $3 GROUP BY 1),
    ids AS (SELECT user_id FROM users WHERE location_id=$1 UNION SELECT user_id FROM msg UNION SELECT user_id FROM cc UNION SELECT user_id FROM op UNION SELECT user_id FROM ap)
    SELECT ids.user_id, u.name, u.email, u.role,
           coalesce(msg.sms_out,0) sms_out, coalesce(msg.email_out,0) email_out, coalesce(msg.social_out,0) social_out,
           coalesce(msg.calls_out,0) calls_out, coalesce(msg.calls_in,0) calls_in, coalesce(msg.talk_seconds,0) talk_seconds,
           coalesce(msg.total_out,0) total_out, coalesce(msg.contacts_touched,0) contacts_touched, coalesce(msg.active_days,0) active_days,
           msg.first_activity, msg.last_activity,
           coalesce(cc.contacts_created,0) contacts_created, coalesce(ca.contacts_assigned,0) contacts_assigned,
           coalesce(op.opps_created,0) opps_created, coalesce(op.opps_won,0) opps_won, coalesce(op.won_value,0) won_value, coalesce(op.opps_open,0) opps_open,
           coalesce(ap.appointments,0) appointments
    FROM ids LEFT JOIN users u ON u.location_id=$1 AND u.user_id=ids.user_id
    LEFT JOIN msg ON msg.user_id=ids.user_id LEFT JOIN cc ON cc.user_id=ids.user_id LEFT JOIN ca ON ca.user_id=ids.user_id
    LEFT JOIN op ON op.user_id=ids.user_id LEFT JOIN ap ON ap.user_id=ids.user_id
    ORDER BY total_out DESC, u.name`, [locationId, a, b]);
  const ev = await userEvents(locationId, from, to);
  return rows.map(num).map(r => {
    const e = ev[r.user_id] || {};
    const pick = (...ks) => ks.reduce((n, k) => n + (e[k] || 0), 0);
    return { ...r, status: userStatus(r), notes: pick('NoteCreate'), tasks: pick('TaskCreate', 'TaskComplete'),
             contact_edits: pick('ContactUpdate', 'ContactTagUpdate', 'ContactDndUpdate'), stage_moves: pick('OpportunityStageUpdate', 'OpportunityStatusUpdate', 'OpportunityMonetaryValueUpdate'),
             events_total: Object.values(e).reduce((x, y) => x + y, 0) };
  });
}

export async function dailySeries(locationId, from, to, userId) {
  const [a, b] = range(from, to);
  const { rows } = await q(`
    SELECT date_added::date AS day,
           count(*) FILTER (WHERE direction='outbound' AND channel='SMS') AS sms,
           count(*) FILTER (WHERE direction='outbound' AND channel='EMAIL') AS email,
           count(*) FILTER (WHERE channel='CALL') AS calls,
           count(*) FILTER (WHERE direction='inbound') AS inbound
    FROM messages WHERE location_id=$1 AND date_added >= $2 AND date_added < $3 AND ($4::text IS NULL OR user_id=$4)
    GROUP BY 1 ORDER BY 1`, [locationId, a, b, userId || null]);
  return rows.map(num);
}

export function healthTier(outbound30, outboundPrev30, ever) {
  if (!ever) return 'never';
  if (outbound30 === 0) return 'dormant';
  if (outboundPrev30 > 0 && outbound30 < outboundPrev30 * 0.5) return 'slowing';
  return 'active';
}
export function userStatus(u) {
  const days = u.last_activity ? (Date.now() - new Date(u.last_activity)) / 86_400_000 : null;
  if (days == null) return 'none';
  if (days <= 7 && u.active_days >= 3) return 'active';
  if (days <= 30) return 'low';
  return 'inactive';
}

export async function agencyOverview(from, to) {
  const [a, b] = range(from, to);
  const { rows } = await q(`
    SELECT l.location_id, l.name, l.report_token,
           (SELECT count(*) FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound' AND m.date_added >= now() - interval '30 days') AS out_30,
           (SELECT count(*) FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound' AND m.date_added >= now() - interval '60 days' AND m.date_added < now() - interval '30 days') AS out_prev30,
           (SELECT count(*) FROM users u WHERE u.location_id=l.location_id AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.location_id=l.location_id AND m.user_id=u.user_id AND m.date_added >= now() - interval '30 days')) AS idle_seats,
           (SELECT count(*) FROM users u WHERE u.location_id=l.location_id) AS users,
           (SELECT count(DISTINCT user_id) FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound' AND m.date_added >= $1 AND m.date_added < $2) AS active_users,
           (SELECT count(*) FROM contacts c WHERE c.location_id=l.location_id) AS contacts,
           (SELECT count(*) FROM contacts c WHERE c.location_id=l.location_id AND c.date_added >= $1 AND c.date_added < $2) AS contacts_new,
           (SELECT count(*) FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound' AND m.date_added >= $1 AND m.date_added < $2) AS outbound,
           (SELECT count(*) FROM messages m WHERE m.location_id=l.location_id AND m.direction='inbound' AND m.date_added >= $1 AND m.date_added < $2) AS inbound,
           (SELECT count(*) FROM messages m WHERE m.location_id=l.location_id AND m.channel='CALL' AND m.date_added >= $1 AND m.date_added < $2) AS calls,
           (SELECT coalesce(sum(call_duration),0) FROM messages m WHERE m.location_id=l.location_id AND m.channel='CALL' AND m.date_added >= $1 AND m.date_added < $2) AS talk_seconds,
           (SELECT count(*) FROM opportunities o WHERE o.location_id=l.location_id AND o.status='won' AND o.status_changed_at >= $1 AND o.status_changed_at < $2) AS won,
           (SELECT max(date_added) FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound') AS last_activity,
           (SELECT max(finished_at) FROM jobs j WHERE j.location_id=l.location_id AND j.status='done') AS last_export
    FROM locations l ORDER BY outbound DESC, l.name`, [a, b]);
  return rows.map(num).map(r => ({ ...r, health: healthTier(r.out_30, r.out_prev30, !!r.last_activity) }));
}

// Per-user counts from the webhook audit stream (notes, tasks, contact edits, stage moves, ...).
export async function userEvents(locationId, from, to) {
  const [a, b] = range(from, to);
  const { rows } = await q(`SELECT user_id, event_type, count(*) AS n FROM events WHERE location_id=$1 AND occurred_at >= $2 AND occurred_at < $3 AND user_id IS NOT NULL GROUP BY 1,2`, [locationId, a, b]);
  const by = {};
  for (const r of rows) (by[r.user_id] ??= {})[r.event_type] = Number(r.n);
  return by;
}
