import { q } from './db.js';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = process.env.GHL_API_VERSION || '2021-07-28';
const MAX_PER_10S = Number(process.env.GHL_MAX_REQ_PER_10S || 80);

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
// Option A: Private Integration Token stored per location.
// Option B: agency OAuth token -> mint a location token (cached ~23h; GHL tokens live 24h).
export async function getToken(locationId) {
  const { rows: [loc] } = await q('SELECT * FROM locations WHERE location_id=$1', [locationId]);
  if (!loc) throw new Error(`Unknown location ${locationId}`);
  if (loc.pit_token) return loc.pit_token;

  const fresh = loc.oauth_token && loc.oauth_expires && new Date(loc.oauth_expires) > new Date(Date.now() + 5 * 60_000);
  if (fresh) return loc.oauth_token;

  const agency = process.env.GHL_AGENCY_ACCESS_TOKEN;
  const companyId = process.env.GHL_COMPANY_ID;
  if (!agency || !companyId) throw new Error(`No PIT for ${locationId} and no agency OAuth token configured`);

  const res = await fetch(`${BASE}/oauth/locationToken`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agency}`, Version: VERSION, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ companyId, locationId }),
  });
  if (!res.ok) throw new Error(`locationToken failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const expires = new Date(Date.now() + (data.expires_in || 86_400) * 1000 - 60 * 60_000);
  await q('UPDATE locations SET oauth_token=$2, oauth_expires=$3 WHERE location_id=$1', [locationId, data.access_token, expires]);
  return data.access_token;
}

// --- generic request with retry -------------------------------------------------
export async function ghl(locationId, method, path, { query, body, raw = false } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle(locationId);
    const token = await getToken(locationId);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: VERSION,
        Accept: raw ? '*/*' : 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 401 && attempt === 0) {
      // token may have expired mid-run: clear cached oauth token and retry once
      await q('UPDATE locations SET oauth_expires=NULL WHERE location_id=$1', [locationId]);
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
