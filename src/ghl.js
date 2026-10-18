import { q } from './db.js';

const BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const VERSION = process.env.GHL_API_VERSION || '2021-07-28';
const MAX_PER_10S = Number(process.env.GHL_MAX_REQ_PER_10S || 95);

// --- per-location sliding-window rate limiter ---------------------------------
const windows = new Map(); // locationId -> [timestamps]
async function throttle(locationId) {
  const now = Date.now();
  const w = (windows.get(locationId) || []).filter(t => now - t < 10_000);
  if (w.length >= MAX_PER_10S) {
    const wait = 10_000 - (now - w[0]) + 50;
    await sleep(wait);
    return throttle(locationId);
  }
  w.push(Date.now());
  windows.set(locationId, w);
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- token resolution -----------------------------------------------------------
// Every location belongs to a hub account (locations.owner_id). The hub holds the
// credential — a pasted PIT or a token minted from the owner's agency install — and
// hands it to us on request. Cached briefly; a 401 mid-run clears the cache and retries.
const HUB_URL = (process.env.HUB_URL || '').replace(/\/$/, '');
const HUB_KEY = process.env.HUB_SERVICE_KEY;
const tokenCache = new Map();   // locationId -> { token, exp }
const TOKEN_TTL = 5 * 60_000;

export function forgetToken(locationId) { tokenCache.delete(locationId); }

export async function getToken(locationId) {
  const hit = tokenCache.get(locationId);
  if (hit && hit.exp > Date.now()) return hit.token;
  const { rows: [loc] } = await q('SELECT owner_id, inactive FROM locations WHERE location_id=$1', [locationId]);
  if (!loc) throw new Error(`Unknown location ${locationId}`);
  if (!loc.owner_id) throw new Error(`Location ${locationId} has no owner on the hub — remove it and add it again from your account`);
  const res = await fetch(`${HUB_URL}/internal/users/${loc.owner_id}/credentials/${encodeURIComponent(locationId)}`, {
    headers: { 'x-hub-service-key': HUB_KEY }, signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      throw Object.assign(new Error(`This sub-account is no longer connected to the owning hub account. Reconnect it on the hub and re-run.`), { disconnected: true });
    }
    if (/not active/i.test(body)) {
      // Paused / deactivated sub-account: GHL will not issue tokens for it. Flag it and drop it from backups.
      await q(`UPDATE locations SET backup_enabled=false, inactive=true WHERE location_id=$1`, [locationId]);
      throw Object.assign(new Error(`Sub-account is inactive in GHL (paused or deactivated) — excluded from backups. Reactivate it in GHL and re-run, or delete it from the vault.`), { inactive: true });
    }
    throw new Error(`Could not get a token for ${locationId} from the hub (${res.status}): ${body.slice(0, 300)}`);
  }
  let d; try { d = JSON.parse(body); } catch { throw new Error('hub returned a non-JSON credential'); }
  if (!d.pit) throw new Error(`hub returned no token for ${locationId}`);
  tokenCache.set(locationId, { token: d.pit, exp: Date.now() + TOKEN_TTL });
  if (loc.inactive) await q('UPDATE locations SET inactive=false WHERE location_id=$1', [locationId]);
  return d.pit;
}

// Bring every sub-account the hub account has connected into the vault. A location can
// only be vaulted by one account (one copy of the data); others are reported, not stolen.
export async function importAgencyLocations(ownerId) {
  const res = await fetch(`${HUB_URL}/internal/users/${ownerId}`, { headers: { 'x-hub-service-key': HUB_KEY }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`hub /internal/users → ${res.status}`);
  const { connections = [] } = await res.json();
  let imported = 0, total = 0, elsewhere = 0;
  for (const c of connections) {
    const { rows: [cur] } = await q('SELECT owner_id FROM locations WHERE location_id=$1', [c.location_id]);
    if (cur && cur.owner_id && cur.owner_id !== ownerId) { elsewhere++; continue; }
    const { rows: [r] } = await q(`INSERT INTO locations (location_id, name, owner_id) VALUES ($1,$2,$3)
      ON CONFLICT (location_id) DO UPDATE SET name=COALESCE(locations.name, EXCLUDED.name), owner_id=$3 RETURNING (xmax = 0) AS inserted`, [c.location_id, c.label || null, ownerId]);
    total++; if (r.inserted) imported++;
  }
  return { imported, total, elsewhere };
}

// --- generic request with retry -------------------------------------------------
export async function ghl(locationId, method, path, { query, body, form, raw = false } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle(locationId);
    const token = await getToken(locationId);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: VERSION,
          Accept: raw ? '*/*' : 'application/json',
          ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
        },
        body: form ? form : body ? JSON.stringify(body) : undefined,   // form = FormData (multipart; fetch sets the boundary)
        // A hung connection must not stall a crawl forever: give up on headers after 60s
        // (raw downloads stream the body under storage.js's own timeout) and retry.
        signal: AbortSignal.timeout(raw ? 120_000 : 60_000),
      });
    } catch (err) {
      if (attempt >= 5) throw new Error(`GHL ${method} ${path}: ${err.name === 'TimeoutError' ? 'timed out' : err.message} after retries`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!raw && res.ok) {
      // JSON bodies can hang too; cap the read and retry on a stall.
      let text;
      try { text = await Promise.race([res.text(), sleep(60_000).then(() => { throw new Error('body timeout'); })]); }
      catch (err) {
        await res.body?.cancel().catch(() => {});
        if (attempt >= 5) throw new Error(`GHL ${method} ${path}: ${err.message} after retries`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      try { return JSON.parse(text); } catch { throw new Error(`GHL ${method} ${path}: non-JSON response`); }
    }

    if (res.status === 429) {
      // Two kinds of 429: the 10-second burst limit (back off and retry) and the 200k/day
      // per-sub-account quota (nothing to do but wait for the reset). GHL reports the daily
      // counter in headers; a persistent 429 with no burst-remaining info is treated as daily too.
      const daily = Number(res.headers.get('x-ratelimit-daily-remaining'));
      const text = await res.text().catch(() => '');
      if ((Number.isFinite(daily) && daily <= 0) || /daily/i.test(text) || attempt >= 4) {
        throw Object.assign(new Error(`GHL daily API quota reached for this sub-account (200k calls/day); paused until it resets`), { dailyLimit: true });
      }
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && attempt === 0) {
      // token may have expired mid-run: drop the cached one and let the hub re-mint
      await res.body?.cancel().catch(() => {});
      forgetToken(locationId);
      continue;
    }
    if (!res.ok) throw new Error(`GHL ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return raw ? res : res.json();
  }
  throw new Error(`GHL ${method} ${path}: gave up after retries`);
}

// Pull every http(s) URL out of an arbitrary JSON blob. Used for form/survey submission
// payloads and document objects where the file URL's exact key varies.
export function harvestUrls(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value.trim())) out.push(value.trim());
    else if (value.includes('http')) for (const m of value.match(/https?:\/\/[^\s"',<>]+/g) || []) out.push(m);
  } else if (Array.isArray(value)) value.forEach(v => harvestUrls(v, out));
  else if (typeof value === 'object') Object.values(value).forEach(v => harvestUrls(v, out));
  return out;
}

// GHL file-upload custom field values, as actually returned by GET /contacts/{id}:
//   { "<uuid>": { documentId, url: "https://services.leadconnectorhq.com/documents/download/<id>",   (needs bearer token)
//                 meta: { originalname, mimetype, size, originalUrl: "https://assets.cdn.filesafe.space/..." } } }  (public CDN)
//   signature fields: { meta, url, documentId } (no uuid wrapper, no originalUrl)
// Older accounts may return a bare string or array of strings. Normalise to
//   [{ url, altUrl, name, mimeType, size, docId }]  — url is the stable API link (used as the unique key),
//   altUrl is the CDN link to try first.
export function parseFileFieldValue(value) {
  const out = [];
  if (!value) return out;
  if (typeof value === 'string') return harvestUrls(value).map(url => ({ url }));
  if (Array.isArray(value)) return value.flatMap(parseFileFieldValue);
  if (typeof value === 'object') {
    if (value.url || value.meta?.originalUrl) {
      const m = value.meta || {};
      return [{
        url: value.url || m.originalUrl,
        altUrl: m.originalUrl && m.originalUrl !== value.url ? m.originalUrl : undefined,
        name: m.originalname || m.filename || m.name,
        mimeType: m.mimetype || m.mimeType,
        size: m.size,
        docId: value.documentId || m.uuid,
      }];
    }
    for (const [docId, v] of Object.entries(value)) for (const f of parseFileFieldValue(v)) out.push({ docId: f.docId || docId, ...f });
  }
  return out;
}
