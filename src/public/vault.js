// Backup & Insights — small helpers shared by the vault pages (load after /ui/rgs-shell.js).
// The RGS shell provides the frame, theme, toasts and icons; this adds API, formatting, sheets and the page switcher.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HUB = window.HUB_URL || '';

  // JSON API call. Redirects to login / subscribe like the old pages did. Never throws on HTTP errors: returns the body.
  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await r.json().catch(() => ({}));
    if ((r.status === 401 || r.status === 402) && (d.login || d.subscribe)) { location.href = d.login || d.subscribe; return new Promise(() => {}); }
    if (!r.ok && d && typeof d === 'object' && !Array.isArray(d) && !d.error) d.error = `Request failed (${r.status})`;
    return d;
  }

  const N = (n) => Number(n || 0).toLocaleString();
  const fmtB = (n) => { n = Number(n || 0); const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
  const short = (n) => { n = Number(n || 0); return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : N(n); };
  const D = (s) => s ? new Date(s).toLocaleDateString() : '—';
  const DT = (s) => s ? new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  // "Today, 7:40 PM" / "Yesterday" / "Oct 15"
  function when(s) {
    if (!s) return '';
    const d = new Date(s), now = new Date(), day = 86400000;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.getTime() >= startToday) return 'Today, ' + t;
    if (d.getTime() >= startToday - day) return 'Yesterday, ' + t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  const ago = (s) => { if (!s) return '—'; const m = (Date.now() - new Date(s)) / 60000; if (m < 1) return 'just now'; if (m < 60) return Math.round(m) + 'm ago'; if (m < 1440) return Math.round(m / 60) + 'h ago'; return Math.round(m / 1440) + 'd ago'; };
  const mins = (s) => { s = Number(s || 0); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };

  // What each crawler collects, in plain words.
  const SOURCES = {
    contact_fields: ['Contact files', 'Files uploaded to contact fields'],
    opportunity_fields: ['Opportunity files', 'Files uploaded to opportunity fields'],
    conversations: ['Messages & recordings', 'Attachments and call recordings from conversations'],
    forms: ['Form uploads', 'Files sent through forms'],
    surveys: ['Survey uploads', 'Files sent through surveys'],
    media: ['Media library', 'Everything in the media library'],
    documents: ['Documents & contracts', 'Signed documents and proposals'],
    usage: ['Team activity', 'Users, messages and calls for the usage report'],
    file_dates: ['Upload dates', 'Looks up when each file was uploaded'],
    notes: ['Notes', 'Every note on every contact, for the notes CSV'],
  };
  const srcName = (k) => (SOURCES[k] || [String(k).replace(/_/g, ' ')])[0];

  // ---------- page switcher (segmented control in the toolbar) ----------
  function nav(active) {
    const el = document.getElementById('nav'); if (!el) return;
    const items = [['vault', '/app', 'Backups'], ['search', '/search.html', 'Search'], ['usage', '/usage.html', 'Usage']];
    el.innerHTML = items.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${label}</a>`).join('');
  }

  // ---------- sheets ----------
  function sheetEl() {
    let bg = document.getElementById('vsheet');
    if (!bg) {
      bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'vsheet';
      bg.innerHTML = '<div class="sheet" id="vsheetBox" role="dialog" aria-modal="true"></div>';
      document.body.appendChild(bg);
      bg.addEventListener('click', (e) => { if (e.target === bg) closeSheet(); });
    }
    return bg;
  }
  let onClose = null;
  function openSheet(html, { wide, onClose: oc } = {}) {
    const bg = sheetEl(); const box = bg.querySelector('.sheet');
    box.style.maxWidth = wide ? '680px' : '';
    box.innerHTML = html; bg.classList.add('open'); onClose = oc || null;
    box.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeSheet);
    return box;
  }
  function closeSheet() { const bg = document.getElementById('vsheet'); if (bg && bg.classList.contains('open')) { bg.classList.remove('open'); const f = onClose; onClose = null; if (f) f(); } }
  const sheetOpen = () => !!document.querySelector('#vsheet.open');
  const head = (icon, grad, title, sub) => `<div class="sheet-hd">${RGS.glyph(icon, grad)}<div><h2>${title}</h2>${sub ? `<div class="sec" style="font-size:12.5px">${sub}</div>` : ''}</div></div>`;

  // Confirmation sheet → Promise<boolean>. opts.toggle = { label, sub } adds a switch; resolves { ok, toggled } then.
  function ask({ title, body = '', ok = 'Continue', danger = false, icon = 'alert', grad = '--t-orange', toggle = null }) {
    return new Promise((resolve) => {
      let done = false;
      const box = openSheet(`${head(icon, grad, esc(title))}
        <div class="sheet-bd">${body ? `<p class="sec" style="margin-bottom:${toggle ? 12 : 4}px">${body}</p>` : ''}
          ${toggle ? `<div class="grp"><div class="fr"><div class="lbl"><b style="font-weight:550">${esc(toggle.label)}</b>${toggle.sub ? `<div class="sec" style="font-size:12px">${esc(toggle.sub)}</div>` : ''}</div><div class="ctl"><label class="sw"><input type="checkbox" id="askT"><i></i></label></div></div></div>` : ''}</div>
        <div class="sheet-ft"><button class="btn tinted" id="askNo">Cancel</button><button class="btn${danger ? ' danger' : ''}" id="askOk">${esc(ok)}</button></div>`,
        { onClose: () => { if (!done) { done = true; resolve(toggle ? { ok: false } : false); } } });
      box.querySelector('#askNo').onclick = () => closeSheet();
      box.querySelector('#askOk').onclick = () => { const t = toggle ? box.querySelector('#askT').checked : null; done = true; closeSheet(); resolve(toggle ? { ok: true, toggled: t } : true); };
      setTimeout(() => box.querySelector('#askOk').focus(), 0);
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) { e.stopImmediatePropagation(); closeSheet(); } }, true);

  function downloadText(name, text, type = 'text/csv') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); }
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const ghlContactUrl = (loc, id) => `https://app.gohighlevel.com/v2/location/${encodeURIComponent(loc)}/contacts/detail/${encodeURIComponent(id)}`;
  const ghlLocationUrl = (loc) => `https://app.gohighlevel.com/v2/location/${encodeURIComponent(loc)}/dashboard`;

  window.V = { esc, api, N, fmtB, short, D, DT, when, ago, mins, SOURCES, srcName, nav, openSheet, closeSheet, sheetOpen, head, ask, downloadText, csvCell, ghlContactUrl, ghlLocationUrl, HUB };
})();
