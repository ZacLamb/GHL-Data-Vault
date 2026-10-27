// Agency token for deleting sub-accounts (Usage › Delete sub-account).
// HighLevel only lets an agency-level token delete a location, so the account owner pastes an
// agency Private Integration token (View + Edit Locations). It is stored encrypted, per hub
// account, and used for nothing else.
import crypto from 'node:crypto';
import { q } from './db.js';
import { ghl } from './ghl.js';

const BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const VERSION = process.env.GHL_API_VERSION || '2021-07-28';
const HUB_URL = (process.env.HUB_URL || '').replace(/\/$/, '');
const HUB_KEY = process.env.HUB_SERVICE_KEY;

function key() {
  const k = process.env.VAULT_ENC_KEY || process.env.HUB_SERVICE_KEY;
  if (!k) throw new Error('No encryption key configured (VAULT_ENC_KEY)');
  return crypto.createHash('sha256').update('agency-token:' + k).digest();
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const settingKey = ownerId => `agency_token:${ownerId}`;

async function agencyCall(token, method, path) {
  const res = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  let msg = data?.message ?? data?.error ?? data?.msg;
  if (Array.isArray(msg)) msg = msg.join('; ');
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : `${typeof msg === 'string' && msg && !/^\s*</.test(msg) ? msg : 'HighLevel error'} (${res.status})` };
}

// Which agency (company) the owner's sub-accounts belong to, read through a sub-account token.
async function companyIdFor(ownerId) {
  const { rows } = await q('SELECT location_id FROM locations WHERE owner_id=$1 AND ghl_deleted_at IS NULL AND NOT inactive ORDER BY created_at LIMIT 5', [ownerId]);
  for (const r of rows) {
    try { const d = await ghl(r.location_id, 'GET', `/locations/${r.location_id}`); if (d?.location?.companyId) return d.location.companyId; } catch {}
  }
  return null;
}

export async function agencyStatus(ownerId) {
  const { rows: [s] } = await q('SELECT value, updated_at FROM settings WHERE key=$1', [settingKey(ownerId)]);
  if (!s?.value?.token) return { connected: false };
  return { connected: true, companyId: s.value.companyId, companyName: s.value.companyName || null, last4: s.value.last4, savedAt: s.updated_at };
}

export async function saveAgencyToken(ownerId, token) {
  token = String(token || '').trim();
  if (!/^pit-[\w-]{10,}$/i.test(token)) throw new Error('That doesn\'t look like a Private Integration token. It starts with "pit-".');
  const companyId = await companyIdFor(ownerId);
  if (!companyId) throw new Error('Couldn\'t work out your agency from your sub-accounts. Add at least one active sub-account to Backup & Insights first.');
  const t = await agencyCall(token, 'GET', `/locations/search?companyId=${encodeURIComponent(companyId)}&limit=1`);
  if (!t.ok) {
    if (t.status === 401 || t.status === 403) throw new Error(`HighLevel didn't accept that token for your agency (${t.status}). Make sure it's an agency-level Private Integration with View Locations and Edit Locations ticked.`);
    throw new Error(`Couldn't check the token: ${t.error}`);
  }
  let companyName = null;
  const c = await agencyCall(token, 'GET', `/companies/${encodeURIComponent(companyId)}`);
  if (c.ok) companyName = c.data?.company?.name || null;
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [settingKey(ownerId), JSON.stringify({ token: encrypt(token), companyId, companyName, last4: token.slice(-4) })]);
  return agencyStatus(ownerId);
}

export async function removeAgencyToken(ownerId) { await q('DELETE FROM settings WHERE key=$1', [settingKey(ownerId)]); }

const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Delete one sub-account in HighLevel. The vault keeps its backup; the hub connection is removed.
export async function deleteSubAccount(ownerId, locationId, { confirm, deleteTwilio = false } = {}) {
  const { rows: [s] } = await q('SELECT value FROM settings WHERE key=$1', [settingKey(ownerId)]);
  if (!s?.value?.token) throw Object.assign(new Error('Add your agency token first.'), { status: 412 });
  const token = decrypt(s.value.token);
  const { rows: [loc] } = await q('SELECT name, ghl_deleted_at FROM locations WHERE location_id=$1 AND owner_id=$2', [locationId, ownerId]);
  if (!loc) throw Object.assign(new Error('No such sub-account in your vault'), { status: 404 });
  if (loc.ghl_deleted_at) return { ok: true, already: true };
  const { rows: running } = await q(`SELECT 1 FROM jobs WHERE location_id=$1 AND status IN ('running','queued') UNION SELECT 1 FROM packages WHERE location_id=$1 AND status='running'`, [locationId]);
  if (running.length) throw Object.assign(new Error('A backup is running for this sub-account. Wait for it to finish, or stop it, then delete.'), { status: 409 });

  // Read it with the agency token: proves it's in this agency and gives the real name to confirm against.
  const g = await agencyCall(token, 'GET', `/locations/${encodeURIComponent(locationId)}`);
  if (g.status === 404 || (g.status === 400 && /not found/i.test(g.error || ''))) {
    await markDeleted(ownerId, locationId); return { ok: true, already: true };
  }
  if (!g.ok) throw Object.assign(new Error(g.status === 401 || g.status === 403 ? `Your agency token can't read this sub-account (${g.status}). Check it has View Locations and Edit Locations, or add it again.` : g.error), { status: 502 });
  const ghlLoc = g.data?.location || g.data || {};
  if (ghlLoc.companyId && s.value.companyId && ghlLoc.companyId !== s.value.companyId) throw Object.assign(new Error('This sub-account belongs to a different agency than your agency token.'), { status: 403 });
  const realName = ghlLoc.name || loc.name || locationId;
  if (norm(confirm) !== norm(realName)) throw Object.assign(new Error(`Type the sub-account's name exactly to confirm: ${realName}`), { status: 400 });

  const d = await agencyCall(token, 'DELETE', `/locations/${encodeURIComponent(locationId)}?deleteTwilioAccount=${deleteTwilio ? 'true' : 'false'}`);
  if (!d.ok) throw Object.assign(new Error(d.status === 401 || d.status === 403 ? `HighLevel refused (${d.status}). Your agency token needs Edit Locations ticked.` : `HighLevel couldn't delete it: ${d.error}`), { status: 502 });
  await markDeleted(ownerId, locationId);
  return { ok: true, name: realName };
}

async function markDeleted(ownerId, locationId) {
  await q('UPDATE locations SET ghl_deleted_at=now(), backup_enabled=false WHERE location_id=$1', [locationId]);
  try {
    await fetch(`${HUB_URL}/internal/users/${ownerId}/connections/${encodeURIComponent(locationId)}`, { method: 'DELETE', headers: { 'x-hub-service-key': HUB_KEY }, signal: AbortSignal.timeout(15_000) });
  } catch (e) { console.error('hub disconnect after delete failed', e.message); }
}
