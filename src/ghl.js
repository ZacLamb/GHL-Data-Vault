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
// Option A: Private Integration Token stored per location.
// Option B: agency OAuth token -> mint a location token (cached ~23h; GHL tokens live 24h).
// Agency credential, in order of preference:
//   1. GHL_AGENCY_PIT       — an agency-level Private Integration token (Agency Settings → Private Integrations).
//                             Used directly for every sub-account call; simplest for 85+ accounts.
//   2. GHL_AGENCY_ACCESS_TOKEN (+ GHL_CLIENT_ID/SECRET/REFRESH_TOKEN) — marketplace-app OAuth; location tokens are minted
//                             per sub-account and the agency token is refreshed automatically when it expires.
export const OAUTH_SCOPES = [
  'oauth.write', 'oauth.readonly', 'locations.readonly', 'locations/customFields.readonly',
  'contacts.readonly', 'conversations.readonly', 'conversations/message.readonly', 'opportunities.readonly',
  'forms.readonly', 'surveys.readonly', 'medias.readonly', 'users.readonly', 'calendars/events.readonly', 'calendars.readonly',
  // write scopes — only used by "Push to another sub-account" (create contacts, custom fields, opportunities, upload files)
  'contacts.write', 'locations/customFields.write', 'opportunities.write', 'forms.write',
];
export function oauthAuthorizeUrl(redirectUri) {
  const u = new URL('https://marketplace.gohighlevel.com/v2/oauth/chooselocation');
  u.searchParams.set('response_type', 'code'); u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('client_id', process.env.GHL_CLIENT_ID || ''); u.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  // Draft (unpublished) private apps need the app version id; it equals the app id, which is the client id's prefix.
  const versionId = process.env.GHL_APP_VERSION_ID || (process.env.GHL_CLIENT_ID || '').split('-')[0];
  if (versionId) u.searchParams.set('version_id', versionId);
  return u.toString();
}
// Exchange the authorization code from the marketplace install for agency tokens and store them.
export async function oauthExchange(code, redirectUri) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: 'authorization_code', code, user_type: 'Company', redirect_uri: redirectUri }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth exchange failed ${res.status}: ${JSON.stringify(d).slice(0, 300)}`);
  if (d.userType && d.userType !== 'Company') throw new Error(`App was installed on a single sub-account (${d.userType}); re-install choosing your AGENCY so it covers every location`);
  const value = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: new Date(Date.now() + (d.expires_in || 86_400) * 1000), companyId: d.companyId, installedAt: new Date() };
  await q(`INSERT INTO settings (key, value) VALUES ('agency_oauth', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [value]);
  if (d.companyId) await q(`INSERT INTO settings (key, value) VALUES ('company', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [{ id: d.companyId }]);
  await q(`UPDATE locations SET oauth_token=NULL, oauth_expires=NULL`);   // re-mint location tokens from the new agency token
  return value;
}

export async function agencyToken() {
  if (process.env.GHL_AGENCY_PIT && !process.env.GHL_CLIENT_ID) return process.env.GHL_AGENCY_PIT;
  const { rows: [row] } = await q(`SELECT value FROM settings WHERE key='agency_oauth'`).catch(() => ({ rows: [] }));
  const saved = row?.value || {};
  const access = saved.access_token || process.env.GHL_AGENCY_ACCESS_TOKEN;
  const refresh = saved.refresh_token || process.env.GHL_AGENCY_REFRESH_TOKEN;
  const exp = saved.expires_at ? new Date(saved.expires_at) : null;
  if (access && (!exp || exp > new Date(Date.now() + 10 * 60_000))) return access;
  if (!refresh || !process.env.GHL_CLIENT_ID || !process.env.GHL_CLIENT_SECRET) return access || null;
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refresh, user_type: 'Company' }),
  });
  if (!res.ok) throw new Error(`agency token refresh failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  const value = { access_token: d.access_token, refresh_token: d.refresh_token || refresh, expires_at: new Date(Date.now() + (d.expires_in || 86_400) * 1000) };
  await q(`INSERT INTO settings (key, value) VALUES ('agency_oauth', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [value]);
  return d.access_token;
}

const companyId_safe = () => companyId().catch(() => null);

export async function getToken(locationId) {
  const { rows: [loc] } = await q('SELECT * FROM locations WHERE location_id=$1', [locationId]);
  if (!loc) throw new Error(`Unknown location ${locationId}`);
  if (loc.pit_token) return loc.pit_token;

  const fresh = loc.oauth_token && loc.oauth_expires && new Date(loc.oauth_expires) > new Date(Date.now() + 5 * 60_000);
  if (fresh) return loc.oauth_token;

  // Agency-level tokens (PIT or OAuth) can't call sub-account endpoints directly — GHL answers
  // "not authorized for this scope" / "user type mismatch". They must be exchanged for a location token.
  const agency = await agencyToken();
  const cid = await companyId_safe();
  if (!agency || !cid) throw new Error(`No PIT for ${locationId} and no agency credential configured (GHL_AGENCY_PIT or agency OAuth)`);

  const res = await fetch(`${BASE}/oauth/locationToken`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agency}`, Version: VERSION, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ companyId: cid, locationId }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (/not active/i.test(body)) {
      // Paused / deactivated sub-account: GHL will not issue tokens for it. Flag it, drop it from
      // the monthly backup, and fail fast with a clear message (runner skips the remaining sources).
      await q(`UPDATE locations SET backup_enabled=false, inactive=true WHERE location_id=$1`, [locationId]);
      throw Object.assign(new Error(`Sub-account is inactive in GHL (paused or deactivated) — excluded from backups. Reactivate it in GHL and re-run, or delete it from the vault.`), { inactive: true });
    }
    throw new Error(`Could not mint a location token for ${locationId} (${res.status}): ${body}. ` +
      `The agency token needs the "oauth.write" scope plus the sub-account scopes it should grant (contacts, conversations, opportunities, forms, surveys, medias, users, calendars). ` +
      `Alternatively paste a per-location Private Integration token for this location.`);
  }
  const data = await res.json();
  const expires = new Date(Date.now() + (data.expires_in || 86_400) * 1000 - 60 * 60_000);
  await q('UPDATE locations SET oauth_token=$2, oauth_expires=$3, inactive=false WHERE location_id=$1', [locationId, data.access_token, expires]);
  return data.access_token;
}

// Company (agency) id: env var, else saved setting, else detected from the agency token.
export async function companyId() {
  if (process.env.GHL_COMPANY_ID) return process.env.GHL_COMPANY_ID;
  const { rows: [r] } = await q(`SELECT value FROM settings WHERE key='company'`);
  if (r?.value?.id) return r.value.id;
  const token = await agencyToken();
  if (!token) return null;
  // /locations/search without companyId returns the agency's own locations for an agency token; each carries companyId.
  const res = await fetch(`${BASE}/locations/search?limit=1`, { headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`could not detect company id (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  const id = d.locations?.[0]?.companyId;
  if (!id) throw new Error('could not detect company id: token returned no locations');
  await q(`INSERT INTO settings (key, value) VALUES ('company', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [{ id, detectedAt: new Date() }]);
  return id;
}

export async function importAgencyLocations() {
  const token = await agencyToken(); const cid = await companyId();
  if (!token || !cid) throw new Error('Agency credential not configured: set GHL_AGENCY_PIT (or agency OAuth vars) in Railway');
  let skip = 0, imported = 0, total = 0;
  while (true) {
    const r = await fetch(`${BASE}/locations/search?companyId=${cid}&limit=100&skip=${skip}`, { headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`locations/search ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const { locations = [] } = await r.json();
    for (const l of locations) {
      const { rowCount } = await q(`INSERT INTO locations (location_id, name) VALUES ($1,$2) ON CONFLICT (location_id) DO UPDATE SET name=EXCLUDED.name RETURNING (xmax = 0) AS inserted`, [l.id, l.name]);
      total++; imported += rowCount ? 1 : 0;
    }
    if (locations.length < 100) break;
    skip += 100;
  }
  return { imported, total };
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
      // token may have expired mid-run: clear cached oauth token and retry once
      await res.body?.cancel().catch(() => {});
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
