// A contact's saved conversation as a standalone page, plain text or CSV. Used for downloads, "Save as PDF"
// (the browser's print dialog) and the private share links. Pure functions: no database in here.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const CHANNEL_LABEL = { SMS: 'Text', EMAIL: 'Email', CALL: 'Call', VOICEMAIL: 'Voicemail', WHATSAPP: 'WhatsApp', FB: 'Facebook', IG: 'Instagram', LIVE_CHAT: 'Live chat', GMB: 'Google chat' };
const when = (t) => t ? new Date(t) : null;
const ymd = (t) => { const d = when(t); return d && !isNaN(d) ? d.toISOString().slice(0, 10) : ''; };
const stamp = (t) => { const d = when(t); return d && !isNaN(d) ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''; };
const dur = (s) => { s = Number(s) || 0; return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : ''; };
const who = (m) => m.direction === 'inbound' ? 'Them' : 'Us';

/** One line describing a message: its wording, or what kind of event it was when no wording is saved. */
export function lineOf(m) {
  const ch = CHANNEL_LABEL[m.channel] || m.channel || 'Message';
  if (m.body) return m.body;
  if (m.channel === 'CALL' || m.channel === 'VOICEMAIL') return `${ch} (${m.direction === 'inbound' ? 'incoming' : 'outgoing'}${dur(m.call_duration) ? ', ' + dur(m.call_duration) : ''})`;
  if (m.channel === 'EMAIL') return `Email ${m.direction === 'inbound' ? 'received' : 'sent'} (wording not saved)`;
  return `${ch} (wording not saved)`;
}

export function toText({ title, sub, messages, total }) {
  const head = [title, sub, `${messages.length}${total > messages.length ? ` of ${total}` : ''} messages`].filter(Boolean).join('\n');
  return head + '\n' + '-'.repeat(40) + '\n' + messages.map((m) => `[${stamp(m.date_added)}] ${who(m)} · ${CHANNEL_LABEL[m.channel] || m.channel || 'Message'}: ${lineOf(m)}`).join('\n') + '\n';
}

const cell = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
export function toCsv({ messages }) {
  const rows = [['Date (UTC)', 'Direction', 'Channel', 'Message', 'Sent by']];
  for (const m of messages) rows.push([stamp(m.date_added), m.direction || '', CHANNEL_LABEL[m.channel] || m.channel || '', lineOf(m), m.sent_by || '']);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const CSS = `*{box-sizing:border-box}body{font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f3ef;color:#1c1b18;margin:0}
.wrap{max-width:720px;margin:0 auto;padding:28px 18px 60px}h1{font-size:22px;margin:0 0 2px}.sub{color:#5f5c53;margin:0 0 4px}.meta{color:#7a776e;font-size:13px;margin:0 0 18px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}.bar a,.bar button{font:inherit;font-size:14px;font-weight:600;background:#1f5eff;color:#fff;border:0;border-radius:8px;padding:8px 14px;text-decoration:none;cursor:pointer}.bar a.alt{background:#e4e1d8;color:#1c1b18}
.thread{display:flex;flex-direction:column;gap:6px;background:#fff;border:1px solid #e4e1d8;border-radius:14px;padding:16px}
.day{align-self:center;font-size:12px;color:#8a877e;margin:8px 0 2px}.b{max-width:80%;padding:8px 13px;border-radius:17px;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}
.in{align-self:flex-start;background:#e9e8e3;border-bottom-left-radius:5px}.out{align-self:flex-end;background:#1f5eff;color:#fff;border-bottom-right-radius:5px}
.t{display:block;font-size:11px;opacity:.65;margin-top:3px}.na{font-style:italic;opacity:.8}.ev{align-self:center;font-size:12.5px;color:#5f5c53;background:#f0eee8;padding:4px 11px;border-radius:10px}
.more{align-self:center;font-size:12.5px;color:#7a776e}.foot{color:#8a877e;font-size:12px;margin-top:16px}
@media print{body{background:#fff}.bar{display:none}.wrap{padding:0}.thread{border:0;padding:0}.out{background:#dbe6ff!important;color:#111!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

export function renderPage({ title, sub, messages, total, note, links = [], autoPrint = false }) {
  const hm = (t) => { const d = when(t); return d && !isNaN(d) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) : ''; };
  const dayOf = (t) => { const d = when(t); return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
  let out = '', prev = '';
  if (total > messages.length) out += `<div class="more">Showing the latest ${messages.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} messages</div>`;
  for (const m of messages) {
    const dd = dayOf(m.date_added); if (dd !== prev) { out += `<div class="day">${esc(dd)}</div>`; prev = dd; }
    const dir = m.direction === 'inbound' ? 'in' : 'out', ch = CHANNEL_LABEL[m.channel] || m.channel || 'Message';
    if (m.body) out += `<div class="b ${dir}">${esc(m.body)}<span class="t">${esc(hm(m.date_added))}${m.channel && m.channel !== 'SMS' ? ' · ' + esc(ch) : ''}</span></div>`;
    else if (m.channel === 'CALL' || m.channel === 'VOICEMAIL' || m.channel === 'EMAIL') out += `<div class="ev">${esc(lineOf(m))} · ${esc(hm(m.date_added))}</div>`;
    else out += `<div class="b ${dir} na">${esc(lineOf(m))}<span class="t">${esc(hm(m.date_added))}</span></div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">
<h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}<p class="meta">${messages.length.toLocaleString('en-US')} message${messages.length === 1 ? '' : 's'}${note ? ' · ' + esc(note) : ''} · times in UTC</p>
<div class="bar"><button onclick="window.print()">Save as PDF</button>${links.map((l) => `<a class="alt" href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}</div>
<div class="thread">${out || '<div class="more">No messages saved</div>'}</div><p class="foot">Texts, emails and calls saved from GoHighLevel. Wording is not saved for emails or for texts backed up before wording was kept.</p></div>${autoPrint ? '<script>addEventListener("load",()=>setTimeout(()=>print(),300))</script>' : ''}</body></html>`;
}
