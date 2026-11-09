// Best texts: which outbound texts get the best replies, across every sub-account an account owns.
//
// For each outbound SMS (last 12 months, wording known) we record the contact's first reply in the
// same conversation within 3 days (before the next outbound text), label it, and note whether the
// contact had a deal marked won within 90 days. Texts are grouped into templates so a blast to
// 5,000 people counts as one message. Rows older than 90 days are final and never looked at again.
import { q } from './db.js';
import { templateOf, templateKey, labelReply, wilson, AI_PROMPT, parseAiLabels } from './texts-core.js';

const PAGE = 2000;
const AI_KEY = () => process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.TEXTS_AI_MODEL || 'claude-haiku-5-5';
const AI_MAX = Number(process.env.TEXTS_AI_MAX_PER_RUN || 3000);   // replies sent to AI per sub-account per run
const AI_BATCH = 40;

async function aiLabel(items) {
  const content = items.map((x, i) => `${i + 1}. Text: ${String(x.text).slice(0, 300).replace(/\s+/g, ' ')}\n   Reply: ${String(x.reply).slice(0, 300).replace(/\s+/g, ' ')}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 1200, system: AI_PROMPT, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`AI labelling ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return parseAiLabels(data.content?.map((c) => c.text || '').join(''), items.length);
}

/** (Re)work out outcomes for one sub-account's outbound texts. Safe to run any time. */
export async function analyzeLocation(locationId) {
  let cursor = ['-infinity', ''];
  let aiLeft = AI_KEY() ? AI_MAX : 0, done = 0;
  for (;;) {
    const { rows } = await q(`
      SELECT m.message_id, m.contact_id, m.date_added::text AS sent_key, m.date_added AS sent_at, m.body, m.sent_by,
             c.first_name, c.last_name, c.company, r.body AS reply, r.date_added AS reply_at,
             t.reply AS prev_reply, t.label AS prev_label, t.label_by AS prev_by,
             EXISTS (SELECT 1 FROM opportunities o WHERE o.location_id=m.location_id AND o.contact_id=m.contact_id AND o.status='won'
                       AND o.status_changed_at > m.date_added AND o.status_changed_at < m.date_added + interval '90 days') AS won
      FROM messages m
      LEFT JOIN contacts c ON c.location_id=m.location_id AND c.contact_id=m.contact_id
      LEFT JOIN text_outcomes t ON t.location_id=m.location_id AND t.message_id=m.message_id
      LEFT JOIN LATERAL (
        SELECT i.body, i.date_added FROM messages i
        WHERE i.location_id=m.location_id AND i.conversation_id=m.conversation_id AND i.direction='inbound' AND i.channel='SMS'
          AND i.date_added > m.date_added AND i.date_added < m.date_added + interval '3 days'
          AND NOT EXISTS (SELECT 1 FROM messages o2 WHERE o2.location_id=m.location_id AND o2.conversation_id=m.conversation_id
                            AND o2.direction='outbound' AND o2.channel='SMS'
                            AND o2.date_added > m.date_added + interval '2 minutes' AND o2.date_added < i.date_added)
        ORDER BY i.date_added LIMIT 1) r ON true
      WHERE m.location_id=$1 AND m.direction='outbound' AND m.channel='SMS' AND m.body IS NOT NULL
        AND m.date_added >= now() - interval '365 days' AND t.final IS NOT TRUE
        AND (m.date_added, m.message_id) > ($2::timestamptz, $3)
      ORDER BY m.date_added, m.message_id LIMIT ${PAGE}`, [locationId, ...cursor]);
    if (!rows.length) break;

    const out = rows.map((r) => {
      const template = templateOf(r.body, { first: r.first_name, last: r.last_name, company: r.company });
      let label = labelReply(r.reply), by = r.reply ? 'rule' : null;
      if (label === 'other' && r.prev_by === 'ai' && r.prev_reply === r.reply) { label = r.prev_label; by = 'ai'; }
      return { ...r, template, key: templateKey(template), label, by };
    });

    // Unclear replies → AI, in batches, within the per-run budget. A failed batch just stays "other".
    const unclear = out.filter((o) => o.label === 'other' && o.by === 'rule').slice(0, aiLeft);
    for (let i = 0; i < unclear.length; i += AI_BATCH) {
      const batch = unclear.slice(i, i + AI_BATCH);
      try {
        const labels = await aiLabel(batch.map((o) => ({ text: o.body, reply: o.reply })));
        if (labels) batch.forEach((o, j) => { o.label = labels[j]; o.by = 'ai'; });
      } catch (err) { console.warn(`[texts ${locationId}]`, err.message); aiLeft = 0; break; }
      aiLeft -= batch.length;
    }

    const col = (f) => out.map(f);
    await q(`INSERT INTO text_outcomes (location_id, message_id, contact_id, sent_at, sent_by, template_key, template, reply, reply_at, label, label_by, won, final)
      SELECT $1, * FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::text[], $11::text[], $12::bool[], $13::bool[])
      ON CONFLICT (location_id, message_id) DO UPDATE SET template_key=EXCLUDED.template_key, template=EXCLUDED.template, reply=EXCLUDED.reply,
        reply_at=EXCLUDED.reply_at, label=EXCLUDED.label, label_by=EXCLUDED.label_by, won=EXCLUDED.won, final=EXCLUDED.final, sent_by=EXCLUDED.sent_by`,
      [locationId, col((o) => o.message_id), col((o) => o.contact_id), col((o) => o.sent_at), col((o) => o.sent_by), col((o) => o.key), col((o) => o.template),
       col((o) => o.reply), col((o) => o.reply_at), col((o) => o.label), col((o) => o.by), col((o) => o.won),
       col((o) => Date.now() - new Date(o.sent_at).getTime() > 90 * 86_400_000)]);
    done += rows.length;
    const last = rows[rows.length - 1]; cursor = [last.sent_key, last.message_id];
  }
  return done;
}

// One refresh at a time per account; the page polls status.
const running = new Map();   // ownerId -> { started, done, total }
export function refreshAll(ownerId) {
  if (running.has(ownerId)) return running.get(ownerId);
  const state = { started: new Date().toISOString(), done: 0, total: 0 };
  running.set(ownerId, state);
  (async () => {
    const { rows } = await q(`SELECT DISTINCT m.location_id FROM messages m JOIN locations l ON l.location_id=m.location_id
      WHERE l.owner_id=$1 AND m.direction='outbound' AND m.body IS NOT NULL AND m.date_added >= now() - interval '365 days'`, [ownerId]);
    state.total = rows.length;
    for (const r of rows) { try { await analyzeLocation(r.location_id); } catch (err) { console.error('[texts]', r.location_id, err.message); } state.done++; }
  })().catch((err) => console.error('[texts refresh]', err)).finally(() => running.delete(ownerId));
  return state;
}

export async function textsStatus(ownerId) {
  const { rows: [s] } = await q(`
    SELECT count(*)::int AS subaccounts,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound' AND m.date_added >= now() - interval '90 days'))::int AS active,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.location_id=l.location_id AND 'message_text' = ANY(j.sources) AND j.status='done'))::int AS collected,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.location_id=l.location_id AND 'message_text' = ANY(j.sources) AND j.status IN ('queued','running')))::int AS collecting,
      (SELECT count(*) FROM text_outcomes t JOIN locations l2 ON l2.location_id=t.location_id WHERE l2.owner_id=$1)::int AS texts
    FROM locations l WHERE l.owner_id=$1 AND l.ghl_deleted_at IS NULL`, [ownerId]);
  // The wording pass, per sub-account (latest run of each): drives the progress bar on the page.
  const { rows: jobs } = await q(`
    SELECT DISTINCT ON (j.location_id) j.location_id, l.name, j.status, j.not_before, j.created_at, j.finished_at,
           j.progress->'message_text' AS p
    FROM jobs j JOIN locations l ON l.location_id=j.location_id
    WHERE l.owner_id=$1 AND 'message_text' = ANY(j.sources)
    ORDER BY j.location_id, j.id DESC`, [ownerId]);
  const collect = jobs.map((j) => ({
    location_id: j.location_id, name: j.name, created_at: j.created_at, finished_at: j.finished_at,
    status: j.status === 'queued' && j.not_before && new Date(j.not_before) > Date.now() ? 'paused' : j.status,
    resumes: j.not_before, conversations: Number(j.p?.conversations || 0), total: j.p?.total != null ? Number(j.p.total) : null,
    messages: Number(j.p?.messages || 0), error: j.p?.error || null,
  }));
  return { ...s, refreshing: running.get(ownerId) || null, ai: !!AI_KEY(), collect };
}

/** Queue the one-off wording pass for sub-accounts that texted in the last 90 days and don't have it yet. */
export async function collectText(ownerId, { all = false } = {}) {
  const { rows } = await q(`
    SELECT l.location_id FROM locations l
    WHERE l.owner_id=$1 AND l.ghl_deleted_at IS NULL
      AND ($2 OR EXISTS (SELECT 1 FROM messages m WHERE m.location_id=l.location_id AND m.direction='outbound' AND m.date_added >= now() - interval '90 days'))
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.location_id=l.location_id AND 'message_text' = ANY(j.sources) AND j.status IN ('queued','running','done'))`, [ownerId, !!all]);
  for (const r of rows) await q(`INSERT INTO jobs (location_id, sources, trigger) VALUES ($1, ARRAY['message_text'], 'manual')`, [r.location_id]);
  return { queued: rows.length };
}

const RANGE = (from, to) => [from ? new Date(from) : new Date(Date.now() - 90 * 86_400_000), to ? new Date(new Date(to).getTime() + 86_400_000) : new Date(Date.now() + 86_400_000)];

export async function rankTexts(ownerId, { from, to, locationId, minSends = 25, sort = 'positive', sentBy } = {}) {
  const [a, b] = RANGE(from, to);
  const { rows } = await q(`
    SELECT t.template_key AS key, min(t.template) AS template, count(*)::int AS sends,
      count(DISTINCT t.location_id)::int AS subaccounts, count(DISTINCT t.contact_id)::int AS contacts,
      count(*) FILTER (WHERE t.label <> 'none')::int AS replies,
      count(*) FILTER (WHERE t.label = 'positive')::int AS positive,
      count(*) FILTER (WHERE t.label = 'negative')::int AS negative,
      count(*) FILTER (WHERE t.label = 'opt_out')::int AS opt_out,
      count(DISTINCT t.contact_id) FILTER (WHERE t.won)::int AS won,
      min(t.sent_at) AS first_sent, max(t.sent_at) AS last_sent,
      mode() WITHIN GROUP (ORDER BY t.sent_by) AS sent_by
    FROM text_outcomes t JOIN locations l ON l.location_id=t.location_id
    WHERE l.owner_id=$1 AND t.sent_at >= $2 AND t.sent_at < $3 AND ($4::text IS NULL OR t.location_id=$4)
      AND ($6::text IS NULL OR ($6='automated' AND t.sent_by IN ('workflow','bulk_actions','campaign','api')) OR ($6='manual' AND (t.sent_by IS NULL OR t.sent_by NOT IN ('workflow','bulk_actions','campaign','api'))))
    GROUP BY t.template_key HAVING count(*) >= $5`, [ownerId, a, b, locationId || null, Math.max(1, Number(minSends) || 1), sentBy || null]);
  const score = { positive: (r) => wilson(r.positive, r.sends), replies: (r) => wilson(r.replies, r.sends), won: (r) => wilson(r.won, r.contacts), optout: (r) => -r.opt_out / r.sends, sends: (r) => r.sends }[sort] || ((r) => wilson(r.positive, r.sends));
  const list = rows.map((r) => ({ ...r, score: score(r) })).sort((x, y) => y.score - x.score).slice(0, 300);
  const tot = rows.reduce((t, r) => ({ sends: t.sends + r.sends, replies: t.replies + r.replies, positive: t.positive + r.positive, opt_out: t.opt_out + r.opt_out }), { sends: 0, replies: 0, positive: 0, opt_out: 0 });
  return { from: a, to: b, templates: rows.length, totals: tot, rows: list };
}

export async function textDetail(ownerId, key, { from, to, locationId } = {}) {
  const [a, b] = RANGE(from, to);
  const args = [ownerId, key, a, b, locationId || null];
  const where = `l.owner_id=$1 AND t.template_key=$2 AND t.sent_at >= $3 AND t.sent_at < $4 AND ($5::text IS NULL OR t.location_id=$5)`;
  const [{ rows: subs }, { rows: replies }, { rows: [ex] }] = await Promise.all([
    q(`SELECT t.location_id, l.name, count(*)::int AS sends, count(*) FILTER (WHERE t.label<>'none')::int AS replies,
         count(*) FILTER (WHERE t.label='positive')::int AS positive, count(*) FILTER (WHERE t.label='opt_out')::int AS opt_out,
         count(DISTINCT t.contact_id) FILTER (WHERE t.won)::int AS won
       FROM text_outcomes t JOIN locations l ON l.location_id=t.location_id WHERE ${where} GROUP BY 1,2 ORDER BY 3 DESC LIMIT 50`, args),
    q(`SELECT * FROM (SELECT t.label, t.reply, t.reply_at, t.location_id, t.contact_id, row_number() OVER (PARTITION BY t.label ORDER BY t.reply_at DESC) AS n
         FROM text_outcomes t JOIN locations l ON l.location_id=t.location_id WHERE ${where} AND t.label <> 'none') x WHERE n <= 8 ORDER BY label, reply_at DESC`, args),
    q(`SELECT m.body FROM text_outcomes t JOIN locations l ON l.location_id=t.location_id JOIN messages m ON m.location_id=t.location_id AND m.message_id=t.message_id
       WHERE ${where} ORDER BY t.sent_at DESC LIMIT 1`, args),
  ]);
  return { subaccounts: subs, replies, example: ex?.body || null };
}
