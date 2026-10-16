// Shared chrome for every GHL Vault page: theme toggle + top bar.
// Usage: <script src="/vault.js" data-page="locations"></script> in <head>
// (theme is applied immediately; the bar is injected once the body exists).
(function () {
  const KEY = 'vault-theme';
  const html = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  if (saved === 'light' || saved === 'dark') html.dataset.theme = saved;
  else html.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

  const me = document.currentScript;
  const page = me && me.dataset.page;
  const noBar = me && me.hasAttribute('data-nobar');

  window.vaultTheme = {
    get: () => html.dataset.theme,
    set: (t) => { html.dataset.theme = t; try { localStorage.setItem(KEY, t); } catch {} },
    toggle: () => window.vaultTheme.set(html.dataset.theme === 'light' ? 'dark' : 'light'),
  };

  const SUN = '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function bar() {
    if (noBar || document.querySelector('.topbar')) return;
    const links = [
      ['locations', '/', 'Locations'],
      ['search', '/search.html', 'Master search'],
      ['usage', '/usage.html', 'Usage'],
    ];
    const el = document.createElement('header');
    el.className = 'topbar';
    el.innerHTML = `<a class="brand" href="/"><b>GHL Vault</b><small>file exporter</small></a>
      <nav>${links.map(([k, href, label]) => `<a href="${href}" class="${k === page ? 'on' : ''}">${label}</a>`).join('')}</nav>
      <span class="sp"></span><span class="status" id="conn"></span>
      <button class="iconbtn" id="themeToggle" title="Switch light / dark" aria-label="Switch theme">${SUN}${MOON}</button>
      <a class="logout" href="/logout">Log out</a>`;
    document.body.prepend(el);
    el.querySelector('#themeToggle').onclick = () => window.vaultTheme.toggle();
  }
  if (document.body) bar(); else document.addEventListener('DOMContentLoaded', bar);
})();
