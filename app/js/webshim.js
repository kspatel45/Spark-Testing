// Web (GitHub Pages) edition of the Lane Tester: there is no local server, so every /api/... call the app makes
// is answered here, inside the browser. Settings and results are kept in this browser (localStorage).
// - Odoo: not available (no API key in a public web page) – the tester picks the unit manually.
// - Serial: Chrome's Web Serial port picker ("+ Port").
// - Peripherals: cameras only (a web page cannot read the PC serial number or the USB device list).
(function () {
  'use strict';
  window.LANE_WEB = true;
  const installed = ['standalone', 'fullscreen', 'minimal-ui'].some(m => matchMedia('(display-mode: ' + m + ')').matches) || /[?&]kiosk/.test(location.search);
  window.LANE_INSTALLED = installed;
  const D = window.LANE_DEFAULTS || {};
  const LS = { get(k, d) { try { const v = localStorage.getItem('jt.web.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
               set(k, v) { try { localStorage.setItem('jt.web.' + k, JSON.stringify(v)); } catch { } } };
  const clone = o => JSON.parse(JSON.stringify(o));
  function merge(a, b) {
    const out = Array.isArray(a) ? a.slice() : { ...a };
    for (const k of Object.keys(b || {})) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a && typeof a[k] === 'object' && !Array.isArray(a[k])) out[k] = merge(a[k], b[k]);
      else out[k] = b[k];
    }
    return out;
  }
  const config = () => merge(clone(D), LS.get('config', {}));
  const publicCfg = () => { const c = config(); delete c.adminPin; c.odoo = { configured: false, postResultsToChatter: false, web: true }; return c; };
  const adminCfg = () => { const c = config(); delete c.adminPin; c.odoo = { url: '', db: '', username: '', apiKey: '' }; return c; };
  let token = null;

  async function camerasCheck(force) {
    let cams = [];
    try {
      cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      if (cams.length && !cams[0].label) {
        // camera names need permission: only ask when the tester presses "Check devices" (never block the dashboard)
        if (!force) return { os: 'Web browser', host: { name: location.host }, error: '', requirementsKnown: false, cameraCount: { expected: 1, found: 0 }, missing: 0, at: new Date().toISOString(),
          rows: [{ id: 'nuc', label: 'NUC serial number', required: true, found: [], status: 'unknown', value: 'not available in the web version' },
                 { id: 'cam1', label: 'Cameras', required: null, why: ['Press "Check devices" and allow camera access to list the cameras'], found: [], status: 'unknown' }] };
        const ask = navigator.mediaDevices.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => { });
        await Promise.race([ask, new Promise(r => setTimeout(r, 10000))]);
        cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      }
    } catch { }
    const P = config().peripherals || {};
    const excl = new RegExp(P.cameraExclude || '\\bIR\\b|infrared', 'i');
    cams = cams.filter(c => !excl.test(c.label || ''));
    const na = (id, label) => ({ id, label, required: null, why: ['Checked by the Windows tester only (browsers cannot read the USB device list)'], found: [], status: 'unknown' });
    const rows = [
      { id: 'nuc', label: 'NUC serial number', required: true, found: [], status: 'unknown', value: 'not available in the web version' },
      na('barcode', 'Barcode scanner'), na('twn4', 'Badge reader – TWN4 (Elatec)'), na('hid', 'HID reader (OMNIKEY / pcProx)')
    ];
    const n = Math.max(1, cams.length);
    for (let i = 0; i < n; i++) {
      const c = cams[i];
      const m = c && /\(([0-9a-f]{4}):([0-9a-f]{4})\)/i.exec(c.label || '');
      rows.push({ id: 'cam' + (i + 1), label: 'Camera ' + (i + 1), camera: true, index: i, required: i === 0, why: i === 0 ? ['Default camera (1)'] : [],
        found: c ? [{ name: (c.label || 'Camera ' + (i + 1)).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, ''), vid: m ? m[1].toUpperCase() : '', pid: m ? m[2].toUpperCase() : '' }] : [],
        status: c ? 'ok' : 'missing' });
    }
    return { os: 'Web browser', host: { name: location.host }, error: '', requirementsKnown: false,
      cameraCount: { expected: 1, found: cams.length }, rows, missing: rows.filter(r => r.status === 'missing').length, at: new Date().toISOString() };
  }

  async function handle(method, url, body) {
    const u = new URL(url, location.href), p = u.pathname.replace(/^.*\/api\//, '/api/');
    if (p === '/api/config') return publicCfg();
    if (p === '/api/admin/login') { if (String(body.pin || '') !== String(config().adminPin || '1234')) throw [401, 'Wrong PIN']; token = Math.random().toString(36).slice(2); return { token }; }
    if (p === '/api/admin/config') {
      if (method === 'GET') return adminCfg();
      const b = clone(body || {}); delete b.odoo;
      const saved = LS.get('config', {});
      const next = merge(saved, b);
      if (Array.isArray(b.products)) next.products = b.products;
      if (b.newPin) next.adminPin = String(b.newPin);
      delete next.newPin;
      LS.set('config', next);
      return { ok: true, config: adminCfg() };
    }
    if (p === '/api/admin/odoo-test') throw [400, 'Odoo is not available in the web version – use the installed Windows tester for Odoo.'];
    if (p === '/api/so') throw [400, 'Odoo is not available in the web version – choose the unit manually.'];
    if (p === '/api/peripherals') return camerasCheck(!!body.force);
    if (p === '/api/serial/ports') return { ports: [], open: null };
    if (p.startsWith('/api/serial/')) throw [409, 'The web version uses the browser serial port (+ Port).'];
    if (p === '/api/results' && method === 'POST') {
      const list = LS.get('results', []);
      const file = `${String(body.so || 'NO-SO').replace(/[^\w.-]+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      list.unshift({ file, ...body }); LS.set('results', list.slice(0, 100));
      return { ok: true, file, chatter: null };
    }
    if (p === '/api/results') {
      return LS.get('results', []).slice(0, 50).map(r => ({ file: r.file, so: r.so, tester: r.tester, unit: r.unitName, finishedAt: r.finishedAt,
        pass: (r.lanes || []).filter(l => l.status === 'pass').length, fail: (r.lanes || []).filter(l => l.status === 'fail').length }));
    }
    throw [404, 'Not found'];
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!/(^|\/)api\//.test(new URL(url, location.href).pathname)) return realFetch(input, opts);
    let body = {}; try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { }
    try { return new Response(JSON.stringify(await handle((opts.method || 'GET').toUpperCase(), url, body)), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    catch (e) { const [code, msg] = Array.isArray(e) ? e : [500, e.message || String(e)]; return new Response(JSON.stringify({ error: msg }), { status: code, headers: { 'Content-Type': 'application/json' } }); }
  };
  window.EventSource = class { constructor() { this.readyState = 2; } addEventListener() { } close() { } };

  // web-specific wording and layout
  const css = document.createElement('style');
  css.textContent = '#adminTabs [data-tab="odoo"], #btnRefreshPorts, #chkPostOdoo, label:has(> #chkPostOdoo) { display: none !important; } .web-badge { font-size: .7rem; font-weight: 700; letter-spacing: .06em; color: #1d4ed8; background: #e8efff; border: 1px solid #bfd0ff; border-radius: 999px; padding: 2px 8px; margin-left: 8px; vertical-align: middle; }';
  document.head.appendChild(css);
  document.addEventListener('DOMContentLoaded', () => {
    const w = document.getElementById('odooWarn');
    if (w) w.innerHTML = 'Enter the SO number and choose the unit (<b>Spark XL</b> / <b>Companion</b>) – the Odoo SO lookup runs only in the Windows tester.';
    document.querySelectorAll('.start-card p').forEach(p => { if (/pulled from Odoo/i.test(p.textContent)) p.textContent = 'Enter your name and the Sales Order number, then choose the unit you are testing.'; });
    const lk = document.getElementById('btnLookup'); if (lk) lk.textContent = 'Continue';
    const h = document.querySelector('.brand-title');
    if (h && !h.querySelector('.web-badge') && !installed) h.insertAdjacentHTML('beforeend', '<span class="web-badge">WEB</span>');
    if (installed) {
      // installed app: go full screen (kiosk look) on the first tap – browsers only allow it after a user gesture
      const fs = () => { document.removeEventListener('pointerdown', fs, true); if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => { }); };
      if (!matchMedia('(display-mode: fullscreen)').matches) document.addEventListener('pointerdown', fs, true);
    }
  });

  // offline / installable (PWA)
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => { }));
})();
