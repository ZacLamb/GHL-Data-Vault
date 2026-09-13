// Usage metadata: users, opportunities, appointments. (Messages are captured by the conversations crawler.)
import { ghl } from '../ghl.js';
import { q } from '../db.js';

export async function usage(ctx) {
  const { locationId, progress, save, since } = ctx;

  // ---- users ----
  const u = await ghl(locationId, 'GET', '/users/', { query: { locationId } });
  const users = u.users || [];
  for (const x of users) await q(`INSERT INTO users (location_id, user_id, name, email, role, type, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (location_id, user_id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, role=EXCLUDED.role, type=EXCLUDED.type, updated_at=now()`,
    [locationId, x.id, x.name || [x.firstName, x.lastName].filter(Boolean).join(' '), x.email, x.roles?.role || x.role, x.roles?.type || x.type]);
  progress.users = users.length; await save();

  // ---- opportunities (all pipelines) ----
  progress.opportunities ??= 0;
  let { startAfterId, startAfter } = progress;
  while (true) {
    const data = await ghl(locationId, 'GET', '/opportunities/search', { query: { location_id: locationId, limit: 100, startAfterId, startAfter, ...(since ? { date: since.slice(0, 10) } : {}) } });
    const opps = data.opportunities || [];
    if (!opps.length) break;
    for (const o of opps) await q(`INSERT INTO opportunities (location_id, opportunity_id, contact_id, assigned_to, pipeline_id, stage_id, status, monetary_value, created_at, updated_at, status_changed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (location_id, opportunity_id) DO UPDATE SET assigned_to=EXCLUDED.assigned_to, stage_id=EXCLUDED.stage_id,
      status=EXCLUDED.status, monetary_value=EXCLUDED.monetary_value, updated_at=EXCLUDED.updated_at, status_changed_at=EXCLUDED.status_changed_at`,
      [locationId, o.id, o.contactId ?? o.contact?.id, o.assignedTo, o.pipelineId, o.pipelineStageId, o.status, o.monetaryValue ?? null,
       o.createdAt ? new Date(o.createdAt) : null, o.updatedAt ? new Date(o.updatedAt) : null, o.lastStatusChangeAt ? new Date(o.lastStatusChangeAt) : null]);
    progress.opportunities += opps.length;
    startAfterId = data.meta?.startAfterId; startAfter = data.meta?.startAfter;
    Object.assign(progress, { startAfterId, startAfter }); await save();
    if (!data.meta?.nextPageUrl && !startAfterId) break;
  }
  delete progress.startAfterId; delete progress.startAfter;

  // ---- appointments: calendar events per user over the window ----
  progress.appointments ??= 0;
  const start = since ? new Date(since) : new Date(Date.now() - 365 * 86_400_000);
  const end = new Date(Date.now() + 90 * 86_400_000);
  for (const x of users) {
    try {
      const ev = await ghl(locationId, 'GET', '/calendars/events', { query: { locationId, userId: x.id, startTime: start.getTime(), endTime: end.getTime() } });
      for (const e of ev.events || []) {
        await q(`INSERT INTO appointments (location_id, event_id, contact_id, user_id, calendar_id, status, start_time, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (location_id, event_id) DO UPDATE SET status=EXCLUDED.status, start_time=EXCLUDED.start_time, user_id=EXCLUDED.user_id`,
          [locationId, e.id, e.contactId, e.assignedUserId || x.id, e.calendarId, e.appointmentStatus || e.status, e.startTime ? new Date(e.startTime) : null, e.dateAdded ? new Date(e.dateAdded) : null]);
        progress.appointments++;
      }
    } catch (err) { progress.apptErrors = (progress.apptErrors || 0) + 1; }
  }
  await save();
}
