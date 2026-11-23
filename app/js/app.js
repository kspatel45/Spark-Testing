/* Jofemar Lane Tester – UI controller (J-CONNECT via JSD) */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BAUDS = [1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  const { AVAIL, QSTATE, EVENTS } = JsdText;

  let cfg = null;              // public config from server
  let session = null;          // {tester, so, soId, customer, unitCode, unitName, startedAt, lanes:[], scannedAt}
  let running = false;
  let ports = [];
  let initDone = false;
  const link = new SerialSwitch();
  const jsd = new Jsd(link);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('jt.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('jt.' + k, JSON.stringify(v)); } catch { } }
  };

  // ============================================================ helpers
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (admin.token) headers['X-Admin-Token'] = admin.token;
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }
  function toast(msg, type = '', ms = 3500) {
    const d = document.createElement('div'); d.className = 'toast ' + type; d.textContent = msg;
    $('#toasts').appendChild(d); setTimeout(() => d.remove(), ms);
  }
  function confirmDlg(title, text, okLabel = 'OK') {
    return new Promise(res => {
      $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfYes').textContent = okLabel;
      const m = $('#modalConfirm'); m.hidden = false;
      const done = v => { m.hidden = true; $('#cfYes').onclick = $('#cfNo').onclick = null; res(v); };
      $('#cfYes').onclick = () => done(true); $('#cfNo').onclick = () => done(false);
    });
  }
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 880 : 220; o.type = ok ? 'sine' : 'square';
      g.gain.setValueAtTime(.12, actx.currentTime); g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + (ok ? .15 : .45));
      o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? .15 : .45));
    } catch { }
  }
  function getPath(o, p) { return p.split('.').reduce((a, k) => a == null ? a : a[k], o); }
  function setPath(o, p, v) { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach(k => { if (a[k] == null) a[k] = {}; a = a[k]; }); a[ks[ks.length - 1]] = v; }

  // ============================================================ lanes
  function laneCode(tray, ch) {
    const f = cfg.machine.laneCodeFormat || '{tray}-{ch}';
    return f.replace(/\{(tray|ch|row|col)\}/g, (m, k) => String(k === 'tray' || k === 'row' ? tray : ch));
  }
  function saveSession() { store.set('session', session); }
  const testable = l => l.status !== 'absent';

  function renderGrid() {
    const g = $('#laneGrid');
    if (!session || !session.lanes.length) {
      g.innerHTML = `<div class="empty">${jsd.ready ? 'No lanes yet. Press <b>Scan lanes</b> to read the tray / channel layout from the machine.' : 'Connect to the JSD, then press <b>Scan lanes</b>.'}</div>`;
      $('#layoutInfo').textContent = ''; updateStats(); return;
    }
    const rows = {};
    session.lanes.forEach((l, i) => { if (l.status !== 'absent') (rows[l.row] = rows[l.row] || []).push(i); });
    const keys = Object.keys(rows).map(Number).sort((a, b) => b - a); // highest tray on top, like the machine
    g.innerHTML = keys.map(r => `
      <div class="lane-row">
        <div class="row-label">Tray<b>${r}</b></div>
        ${rows[r].map(i => laneBtn(session.lanes[i], i)).join('')}
      </div>`).join('') || '<div class="empty">The scan found no connected lanes.</div>';
    const n = session.lanes.filter(testable).length;
    $('#layoutInfo').textContent = `${keys.length} trays · ${n} lanes${session.scannedAt ? ' · scanned ' + new Date(session.scannedAt).toLocaleTimeString() : ''}`;
    updateStats();
  }
  function laneBtn(l, i) {
    const cyc = l.cycles ? ` ${l.cycles.pass}/${l.cycles.pass + l.cycles.fail}` : '';
    const sub = l.status === 'pass' ? (l.cycles ? `PASS${cyc}` : `PASS ${(l.ms / 1000).toFixed(0)}s`) : l.status === 'fail' ? `FAIL${cyc}${l.step && STEP_SHORT[l.step] ? ' · ' + STEP_SHORT[l.step] : ''}` : l.status === 'testing' ? (l.cycleNow ? `cycle ${l.cycleNow}` : 'testing…') : `T${l.row} C${l.col}`;
    const modeTxt = l.mode === 'basic' ? 'Basic test' : l.mode === 'full' ? 'Full cycle' : '';
    const failTxt = l.status === 'fail'
      ? (l.fails && l.fails.length
        ? 'FAILED' + (modeTxt ? ` (${modeTxt})` : '') + '\n' + l.fails.map(f => `${f.cycle ? 'Cycle ' + f.cycle + ' – ' : ''}failed at step ${STEP_NO[f.step] || '?'} "${STEP_LABEL[f.step] || f.step || '?'}": ${f.error}`).join('\n')
        : `FAILED${l.step ? ` at step ${STEP_NO[l.step] || '?'} "${STEP_LABEL[l.step] || l.step}"` : ''}: ${l.error}`)
      : '';
    const tip = [failTxt, l.status === 'pass' ? `PASS${modeTxt ? ' (' + modeTxt + ')' : ''}${l.cycles ? ` – ${l.cycles.pass}/${l.cycles.pass + l.cycles.fail} cycles` : ''}${l.note ? ' – ' + l.note : ''}` : '',
      l.chStatus === 3 ? 'Machine reports this channel as faulty' : '', l.chStatus === 1 ? 'Product loaded' : ''].filter(Boolean).join('\n');
    return `<button class="lane ${l.status}${l.chStatus === 3 ? ' faulty' : ''}" data-i="${i}" title="${esc(tip)}" ${running ? 'disabled' : ''}>${l.chStatus === 1 ? '<i class="dot-prod"></i>' : ''}${esc(l.code)}<small>${sub}</small></button>`;
  }
  function updateLane(i) {
    const el = document.querySelector(`.lane[data-i="${i}"]`);
    if (el) el.outerHTML = laneBtn(session.lanes[i], i);
    updateStats();
  }
  function updateStats() {
    const L = session ? session.lanes.filter(testable) : [];
    const pass = L.filter(l => l.status === 'pass').length, fail = L.filter(l => l.status === 'fail').length;
    $('#stTotal').textContent = L.length; $('#stPass').textContent = pass; $('#stFail').textContent = fail;
    $('#stLeft').textContent = L.length - pass - fail;
    $('#btnRetest').disabled = running || !fail;
    $('#btnTestAll').disabled = running || !L.length;
  }
  function setProgress(done, total, text) {
    $('#progBar').style.width = total ? (100 * done / total) + '%' : '0';
    $('#progTxt').textContent = text;
  }
  const ORDER = ['move', 'motor', 'hatchPos', 'hatch', 'home'];
  const STEP_LABEL = { move: 'Elevator → lane', motor: 'Run lane', hatchPos: 'Elevator → hatch', hatch: 'Hatch open / close', home: 'Home' };
  const STEP_NO = { move: 1, motor: 2, hatchPos: 3, hatch: 4, home: 5 };
  const STEP_SHORT = { move: '→ lane', motor: 'lane', hatchPos: '→ hatch', hatch: 'hatch', home: 'home' };
  function setStep(id, state) {
    const idx = ORDER.indexOf(id);
    $$('#stepper li').forEach((li, n) => {
      li.className = '';
      if (id === 'reset') return;
      if (id === 'done' || n < idx) li.classList.add('done');
      else if (n === idx) li.classList.add(state === 'err' ? 'err' : 'active');
    });
    if (id === 'reset') $('#stepDetail').textContent = '';
  }
  function showPrompt(text) {
    $('#promptBar').hidden = !text; $('#promptText').textContent = text || '';
    if (text) beep(true);
  }

  // ============================================================ test runs
  function setRunning(v) {
    running = v; jsd.abort = false;
    $('#btnStop').hidden = !v;
    ['#btnScan', '#btnReset', '#btnFinish', '#btnChangeSession'].forEach(s => $(s).disabled = v);
    $$('[data-act]').forEach(b => b.disabled = v);
    $$('.lane').forEach(b => b.disabled = v);
    updateStats();
    if (v) $('#btnTestAll').disabled = true;
  }
  function ensureReady() {
    if (jsd.ready) return true;
    toast('Connect the COM port first (or turn on the Simulator in Admin → Machine).', 'warn'); return false;
  }
  const testPrefs = () => store.get('testPrefs', { mode: 'full', cycles: 1 }) || { mode: 'full', cycles: 1 };
  function cyclesWanted() { const n = Math.round(Number($('#inCycles').value)); return Math.min(999, Math.max(1, n || 1)); }
  async function runLanes(indexes, label) {
    if (running || !ensureReady() || !indexes.length) return;
    const mode = testPrefs().mode === 'basic' ? 'basic' : 'full', cycles = cyclesWanted();
    const total = indexes.length * cycles;
    if (mode === 'basic') {
      // Basic runs unattended: a product that drops would block the hatch, so it needs empty lanes
      const loaded = indexes.filter(i => session.lanes[i].chStatus === 1).map(i => session.lanes[i].code);
      if (loaded.length && !await confirmDlg('Basic test needs empty lanes',
        `${loaded.length} lane(s) had product at the last scan (${loaded.slice(0, 12).join(', ')}${loaded.length > 12 ? ' …' : ''}). ` +
        'A product that drops stays in the hatch and the Qendra keeps the door open until it is taken out – the test keeps retrying the close and then carries on. Unload those lanes for an unattended run, or use Full cycle. Start anyway?', 'Start anyway')) return;
    }
    setRunning(true); acquireWakeLock(); setStep('reset');
    setProgress(0, total, 'Checking machine…');
    const pre = await jsd.preflight();
    if (!pre.ok) { setRunning(false); setProgress(0, 0, 'Not started'); toast(pre.error, 'err', 7000); log('err', 'Pre-check failed: ' + pre.error); return; }
    let done = 0, fails = 0, fatal = null;
    const modeTxt = mode === 'basic' ? 'Basic test' : 'Full cycle';
    log('info', `=== ${label}: ${indexes.length} lane(s) × ${cycles} cycle(s) – ${session.unitName} (${jsd.qendraFor(session.unitCode) ? 'Qendra' : 'ES-Plus'}, ${modeTxt}) ===`);
    // per-lane tally across cycles: a lane is FAIL if any cycle failed
    const tally = Object.fromEntries(indexes.map(i => [i, { pass: 0, fail: 0, errors: [], fails: [] }]));
    indexes.forEach(i => { const l = session.lanes[i]; l.status = 'untested'; l.error = ''; l.note = ''; l.cycles = null; });
    renderGrid();
    outer:
    for (let c = 1; c <= cycles; c++) {
      if (c > 1 && cfg.jconnect.resetSoldOut && !jsd.abort) {
        // a lane that ran empty is flagged sold-out by the machine and would be refused next cycle
        const r = await jsd.resetSoldOut();
        if (!r.ok || r.msg.f[1] !== '0') log('err', 'Could not reset sold-out flags before cycle ' + c + ': ' + (r.error || r.msg.text));
      }
      for (const i of indexes) {
        if (jsd.abort) break outer;
        const lane = session.lanes[i], t = tally[i];
        lane.status = 'testing'; lane.cycleNow = cycles > 1 ? `${c}/${cycles}` : ''; updateLane(i);
        document.querySelector(`.lane[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setProgress(done, total, `Lane ${lane.code}${cycles > 1 ? ` · cycle ${c}/${cycles}` : ''} (${done + 1}/${total})`);
        const r = await jsd.testLane(lane, session.unitCode, {
          mode,
          step: id => setStep(id),
          detail: x => { $('#stepDetail').textContent = x; },
          prompt: showPrompt
        });
        showPrompt(null); lane.cycleNow = '';
        if (r.status === 'stopped') {
          lane.status = t.fail ? 'fail' : t.pass ? 'pass' : 'untested'; updateLane(i); saveSession();
          if (r.halt) { fatal = r.halt; log('err', r.halt); }
          break outer;
        }
        if (r.status === 'fail') { t.fail++; t.errors.push(cycles > 1 ? `#${c}: ${r.error}` : r.error); t.fails.push({ cycle: cycles > 1 ? c : 0, step: r.step, error: r.error }); fails++; setStep(r.step, 'err'); log('err', `Lane ${lane.code}${cycles > 1 ? ' cycle ' + c : ''} FAIL – ${r.error}`); }
        else { t.pass++; log('info', `Lane ${lane.code}${cycles > 1 ? ' cycle ' + c : ''} PASS – ${r.note} (${(r.ms / 1000).toFixed(1)} s)`); }
        lane.status = t.fail ? 'fail' : 'pass'; lane.error = t.errors.join(' · '); lane.note = r.note || ''; lane.ms = r.ms; lane.step = r.step || '';
        lane.mode = mode; lane.fails = t.fails.slice(); lane.cycles = cycles > 1 ? { pass: t.pass, fail: t.fail, of: cycles } : null; lane.at = new Date().toISOString();
        beep(r.status === 'pass');
        updateLane(i); saveSession();
        done++;
        setProgress(done, total, `${done}/${total} done`);
        if (r.fatal) { fatal = r.error; break outer; }
        if (r.halt) { fatal = r.halt; log('err', r.halt); break outer; }
        if (!jsd.abort && done < total) await sleep(Number(cfg.timing.betweenLanesMs) || 0);
      }
    }
    const stopped = jsd.abort;
    setRunning(false);
    const failedLanes = indexes.filter(i => tally[i].fail).length;
    if (!fails && !stopped && !fatal) setStep('done');
    const msg = fatal ? `Stopped: ${fatal}` : stopped ? `Stopped after ${done} test(s)` :
      `${label} complete: ${indexes.length - failedLanes} lane(s) pass, ${failedLanes} fail${cycles > 1 ? ` (${done} runs, ${fails} failed)` : ''}`;
    setProgress(done, total, msg);
    toast(msg, stopped || fatal ? 'warn' : fails ? 'err' : 'ok', 6000);
    log('info', '=== ' + msg + ' ===');
    jsd.readSensors().catch(() => { });
  }

  let scanning = false;
  // the JSD also sends Op 202 by itself when a channel changes (e.g. after the machine self-check): keep the grid live
  jsd.on('rx', msg => {
    if (msg.op !== 202 || scanning || !session || !Array.isArray(session.lanes) || msg.f[0] !== jsd.mn) return;
    const tray = Number(msg.f[1]), ch = Number(msg.f[2]), stv = Number(msg.f[3]);
    let l = session.lanes.find(x => x.row === tray && x.col === ch);
    if (!l && stv) { l = { row: tray, col: ch, code: laneCode(tray, ch), status: 'untested', error: '', note: '', ms: 0, at: '' }; session.lanes.push(l); session.lanes.sort((a, b) => a.row - b.row || a.col - b.col); }
    if (!l || l.status === 'testing') return;
    l.chStatus = stv;
    if (!stv) l.status = 'absent'; else if (l.status === 'absent') l.status = 'untested';
    saveSession(); renderGrid();
  });
  async function scanLanes(silent) {
    if (running || !ensureReady()) return;
    setRunning(true);
    setProgress(0, 1, 'Scanning lanes…');
    scanning = true;
    const r = await jsd.scan((n, total, tray, ch) => setProgress(n, total, `Scanning tray ${tray} channel ${ch}`),
      { redetect: !silent, onStage: t => setProgress(0, 1, t) });
    scanning = false;
    setRunning(false);
    if (r.error) { toast(r.error, 'err', 6000); setProgress(0, 0, 'Scan failed'); return; }
    if (r.aborted) { setProgress(0, 0, 'Scan stopped'); return; }
    const prev = Object.fromEntries((session.lanes || []).map(l => [l.row + '-' + l.col, l]));
    session.lanes = r.lanes.map(x => {
      const p = prev[x.tray + '-' + x.ch];
      const present = x.status != null && x.status !== 0;
      return {
        row: x.tray, col: x.ch, code: laneCode(x.tray, x.ch), chStatus: x.status,
        status: !present ? 'absent' : p && p.status !== 'absent' && p.status !== 'testing' ? p.status : 'untested',
        error: p && present ? p.error : '', note: p && present ? p.note : '', ms: p && present ? p.ms : 0, at: p && present ? p.at : ''
      };
    });
    session.scannedAt = new Date().toISOString();
    saveSession(); renderGrid();
    const n = session.lanes.filter(testable).length, faulty = session.lanes.filter(l => l.chStatus === 3).length;
    const bad = (r.sensors || []).map((s, i) => ({ s, tray: (Number(cfg.jconnect.firstTray) || 11) + i })).filter(x => x.s === 'C' || x.s === 'N');
    setProgress(0, 0, `Scan complete: ${n} lanes`);
    if (!silent || faulty || bad.length) toast(`Scan complete: ${n} lane(s)${faulty ? `, ${faulty} reported faulty` : ''}`, faulty ? 'warn' : 'ok');
    if (bad.length) toast('Tray sensor problem on tray ' + bad.map(b => `${b.tray} (${b.s === 'C' ? 'short circuit' : 'not detected'})`).join(', '), 'err', 8000);
  }

  // ============================================================ log
  const logLines = [];
  function log(cls, text) {
    const t = new Date().toTimeString().slice(0, 8);
    logLines.push(`<span class="t">${t}</span> <span class="${cls}">${esc(text)}</span>`);
    if (logLines.length > 800) logLines.splice(0, logLines.length - 600);
    scheduleLog();
  }
  let logPending = false;
  function scheduleLog() {
    if (logPending) return; logPending = true;
    setTimeout(() => {
      logPending = false;
      const el = $('#log'); const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      el.innerHTML = logLines.join('\n'); if (atBottom) el.scrollTop = el.scrollHeight;
      $('#logCount').textContent = `(${logLines.length})`;
    }, 60);
  }
  const hex = b => Array.from(b, x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const quiet = op => (op === 100 || op === 201 || op === 208) && !$('#chkLogHb').checked;
  jsd.on('tx', t => {
    if (quiet(t.op)) return;
    log('tx', `TX ${jsd.sim ? '[SIM] ' : ''}${t.op} ${JConnect.OPS[t.op] || ''}${t.retry ? ' (retry)' : ''}: ${t.text}${$('#chkLogRaw').checked ? '   [' + hex(t.bytes) + ']' : ''}`);
  });
  jsd.on('rx', m => { if (!quiet(m.op)) log(m.op >= 300 || m.op === 200 ? 'err' : 'rx', `RX ${m.op} ${JConnect.OPS[m.op] || ''}: ${m.text}`); });
  jsd.on('raw', b => { if ($('#chkLogRaw').checked) log('t', 'raw ' + hex(b)); });
  jsd.on('log', (c, t) => log(c === 'warn' ? 'err' : c, t));

  // ============================================================ machine panel
  let infoPending = false;
  jsd.on('state', () => {
    if (infoPending) return; infoPending = true;
    setTimeout(() => {
      infoPending = false;
      const m = jsd.m, i = jsd.info;
      const set = (id, text, cls = '') => { const e = $(id); e.textContent = text; e.className = cls; };
      set('#miModel', i.model ? `${i.model}${i.serial ? ' · ' + i.serial : ''}` : '–');
      set('#miJsd', i.jsdFw || '–');
      set('#miDoor', m.door == null ? '–' : m.door === 1 ? 'Closed' : 'OPEN', m.door === 0 ? 'bad' : m.door === 1 ? 'good' : '');
      const avail = m.comm != null && m.comm !== 1 ? (m.comm === 2 ? 'Machine lost' : 'Machine not connected') : m.service === 0 ? 'Out of service' : AVAIL[m.avail];
      set('#miAvail', avail || '–', m.service === 0 || (m.comm != null && m.comm !== 1) ? 'bad' : m.avail === 0 ? 'good' : m.avail != null ? 'warn' : '');
      set('#miQ', m.qSeen ? (QSTATE[m.q] || m.q) : jsd.qendraFor(session && session.unitCode) ? 'waiting for Op 225' : 'n/a (ES-Plus)');
      set('#miTemp', m.temp ? m.temp + ' °C' : '–');
      set('#miFaults', m.faults.size ? [...m.faults].map(f => `${f} ${EVENTS[f] || ''}`).join(', ') : 'none', m.faults.size ? 'bad' : '');
      renderSensors();
    }, 60);
  });

  // ============================================================ sensor LEDs
  // J-CONNECT has no raw I/O read: each LED comes from what the JSD reports –
  // Op 201 (status), 225 (Qendra precise state), 223 (product detector), 209/219 (device faults), 222 (tray phototransistors).
  const SENSOR_FAULTS_COMMON = [[1, 'Product detector'], [6, 'Elevator position sensor'], [5, 'Elevator'], [2, 'Lane motors'], [3, 'Jam detector'], [4, 'Temperature control']];
  const SENSOR_FAULTS_QENDRA = [[10, 'Hatch door'], [11, 'Hatch safety sensor'], [18, 'Lower product sensors'], [19, 'Upper product sensors'],
    [23, 'Delivery sensor stuck'], [25, 'Delivery sensor dead'], [24, 'Standby sensor'], [21, 'Elevator encoder'],
    [14, 'Shutter lock motor'], [15, 'Elevator blind'], [20, 'Elevator card'], [12, 'Elevator/door PSU'], [13, 'Elevator card PSU'], [22, 'Motor voltage'],
    [16, 'Cooling fan 1'], [17, 'Cooling fan 2']];
  const SENSOR_FAULTS_ESPLUS = [[7, 'Elevator tester (flap)']];
  function renderSensors() {
    const el = $('#sensorPanel'); if (!el || !cfg) return;
    const m = jsd.m, on = jsd.ready;
    const qendra = jsd.qendraFor(session && session.unitCode);
    const hb = jsd.hb.state;
    const led = (state, label, tip) => `<div class="sn" title="${esc(tip || label)}"><i class="led ${state}"></i><span>${esc(label)}</span></div>`;
    const b = (v, okVal) => v == null || !on ? 'unk' : v === okVal ? 'on' : 'bad';
    const q = m.qSeen ? m.q : null;
    const groups = [];
    groups.push(['Machine', [
      led(!on ? 'unk' : hb === 'ok' ? 'on' : hb === 'lost' ? 'bad' : hb === 'off' ? 'off' : 'warn', 'JSD heartbeat', 'Op 100 → 201 every heartbeat'),
      led(b(m.comm, 1), 'Machine link', 'Op 201 data 2'),
      led(b(m.service, 1), 'In service', 'Op 201 data 3'),
      led(b(m.door, 1), 'Main door closed', 'Op 201 data 4'),
      led(m.avail == null || !on ? 'unk' : m.avail === 0 ? 'on' : 'warn', m.avail == null ? 'Ready to dispense' : m.avail === 0 ? 'Ready to dispense' : (AVAIL[m.avail] || 'Busy'), 'Op 201 data 5'),
      led(m.light == null || !on ? 'unk' : m.light === 1 ? 'on' : 'off', 'Cabinet LED light', 'Op 201 data 6 – use Light on/off to toggle')
    ]]);
    if (qendra) {
      const st = arr => q == null || !on ? 'unk' : arr.includes(q) ? 'on' : 'off';
      groups.push(['Elevator / hatch (live, Op 225)', [
        led(st([1, 2]), 'At rest (home)', 'Elevator at rest'),
        led(st([3, 8, 10]), 'Elevator moving'),
        led(st([9]), 'Lane running', 'Extractor / lane motor running'),
        led(st([4, 5, 6]), 'Hatch open'),
        led(st([7]), 'Hatch closing'),
        led(m.prod == null || !on ? 'unk' : m.prod === 1 ? 'warn' : 'off', 'Product in hatch', 'Product detectors – Op 225 states 2/5/12, Op 223'),
        led(q == null || !on ? 'unk' : [11, 12].includes(q) ? 'bad' : 'on', 'Elevator in service', 'Op 225 states 11/12 = out of service')
      ]]);
    }
    const fl = [...SENSOR_FAULTS_COMMON, ...(qendra ? SENSOR_FAULTS_QENDRA : SENSOR_FAULTS_ESPLUS)];
    groups.push(['Sensors & safety devices (Op 209 / 115)', fl.map(([n, label]) =>
      led(m.faults.has(n) ? 'bad' : !on || !m.faultsSeen ? 'unk' : 'on', label, `Machine event ${n} – ${EVENTS[n] || label}: ${m.faults.has(n) ? 'FAULT ACTIVE' : m.faultsSeen ? 'OK' : 'not read yet'}`))]);
    const first = Number(cfg.jconnect.firstTray) || 11, last = Number(cfg.jconnect.lastTray) || 18;
    const trays = m.trays || [];
    const tl = [];
    for (let t = first; t <= last; t++) {
      const v = trays[t - 11];
      tl.push(led(!on || v == null || v === '' ? 'unk' : v === '0' ? 'on' : 'bad', `Tray ${t}`,
        v === 'C' ? 'Tray photodetector short-circuited – tray out of service' : v === 'N' ? 'Tray photodetector not detected (wiring, sensor, or tray not seated)' : 'Tray positioning photo-transistor (Op 117 → 222)'));
    }
    groups.push(['Tray position sensors (Op 222)', tl]);
    el.innerHTML = groups.map(([h, items]) => `<div class="sg"><h4>${esc(h)}</h4><div class="sg-items">${items.join('')}</div></div>`).join('');
  }

  // ============================================================ connection
  function connUI() {
    const p = $('#pillConn');
    if (jsd.sim) { p.className = 'pill ok'; p.lastChild.textContent = `Simulator (${cfg.machine.simModel === 'qendra' ? 'Qendra' : 'ES-Plus'})`; }
    else if (link.connected) { p.className = 'pill ok'; p.lastChild.textContent = `${link.kind === 'bridge' ? link.bridge.port : 'Connected'} · ${$('#selBaud').value}`; }
    else { p.className = 'pill bad'; p.lastChild.textContent = 'Disconnected'; }
    $('#pillSim').hidden = !jsd.sim;
    $('#btnConnect').textContent = link.connected ? 'Disconnect' : 'Connect';
    $('#btnConnect').className = 'btn btn-block ' + (link.connected ? 'btn-danger' : 'btn-primary');
    ['#selPort', '#selBaud', '#selData', '#selParity', '#selStop', '#btnAddPort', '#btnRefreshPorts'].forEach(s => $(s).disabled = link.connected);
  }
  jsd.on('heartbeat', (s, hb) => {
    const p = $('#pillHb');
    const fw = jsd.info.jsdName ? ' · ' + jsd.info.jsdName : '';
    const map = { off: ['', 'Heartbeat off'], wait: ['warn', 'Heartbeat…'], ok: ['ok', 'JSD alive' + fw], warn: ['warn', `Heartbeat miss ${hb.misses}${fw}`], lost: ['bad', 'JSD not responding'] };
    p.title = jsd.info.jsdName ? `JSD firmware ${jsd.info.jsdName} · build ${jsd.info.jsdBuild || '?'} · ${jsd.info.jsdDate || ''}` : 'JSD heartbeat';
    const [c, t] = map[s] || map.off;
    p.className = 'pill ' + c; p.lastChild.textContent = t;
    if (s === 'ok') { p.classList.add('beat'); setTimeout(() => p.classList.remove('beat'), 350); }
    if (s === 'lost' && !p.dataset.warned) { p.dataset.warned = 1; toast('The JSD is not answering. Check the cable, the COM port and 9600 baud.', 'err', 7000); }
    if (s === 'ok') delete p.dataset.warned;
  });
  function updateHeartbeat() { if ($('#chkHb').checked && jsd.ready) jsd.startHeartbeat(); else jsd.stopHeartbeat(); }

  async function initJsd() {
    if (!jsd.ready) return;
    const r = await jsd.init();
    initDone = r.ok;
    if (!r.ok) { toast('The JSD did not answer. Check cable, COM port, 9600 baud and JSD power.', 'err', 7000); return; }
    toast(`JSD connected – ${jsd.info.model || 'machine'} ${jsd.info.serial || ''}`, 'ok');
    renderGrid();
    await jsd.readSensors().catch(() => { });
    if (session && !session.lanes.length && !running) scanLanes(true);
  }

  // Port list: COM ports from Windows via the local server (preferred, no browser picker needed)
  // plus any ports already granted to the browser's Web Serial API.
  let comPorts = [];
  async function refreshPorts(selectKey) {
    const sel = $('#selPort');
    try { const r = await BridgeLink.list(); comPorts = r.ports || []; } catch { comPorts = []; }
    ports = SerialLink.supported() && !embeddedBrowser() ? await link.web.grantedPorts() : [];
    const opts = comPorts.map(p => `<option value="b:${esc(p.path)}">${esc(p.path)} – ${esc(p.name.replace(/\s*\(COM\d+\)/, ''))}${p.ftdi ? ' (FTDI)' : ''}${p.status && p.status !== 'OK' ? ' [' + esc(p.status) + ']' : ''}</option>`)
      .concat(ports.map((p, i) => `<option value="w:${i}">Browser: ${esc(SerialLink.describe(p))}</option>`));
    sel.innerHTML = opts.length ? opts.join('') : window.LANE_WEB
      ? '<option value="">— click + Port and pick the FTDI adapter —</option>'
      : '<option value="">— no COM port found – plug in the adapter —</option>';
    const prefs = store.get('serial', {});
    const want = selectKey || prefs.portKey;
    const has = k => k && [...sel.options].some(o => o.value === k);
    if (has(want)) sel.value = want;
    else { const ftdi = comPorts.find(p => p.ftdi); if (ftdi) sel.value = 'b:' + ftdi.path; }
    return opts.length;
  }
  const serialOpts = () => ({ baudRate: +$('#selBaud').value, dataBits: +$('#selData').value, parity: $('#selParity').value, stopBits: +$('#selStop').value });
  function saveSerialPrefs(extra = {}) {
    store.set('serial', { ...store.get('serial', {}), baud: $('#selBaud').value, eol: $('#selEol').value, data: $('#selData').value, parity: $('#selParity').value, stop: $('#selStop').value, portKey: $('#selPort').value || null, ...extra });
  }
  let connecting = false;
  async function connect() {
    if (connecting) return;
    if (jsd.sim) { toast('Simulator mode is on – turn it off in Admin → Machine to use the COM port.', 'warn', 6000); return; }
    let key = $('#selPort').value;
    if (!key) { await refreshPorts(); key = $('#selPort').value; }
    if (!key) { portHelp(false); return; }
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    const label = kind === 'b' ? id : SerialLink.describe(ports[+id]);
    connecting = true; $('#btnConnect').disabled = true; $('#btnConnect').textContent = 'Opening ' + label + '…';
    try {
      if (kind === 'b') await link.open('bridge', id, serialOpts());
      else await link.open('web', ports[+id], serialOpts());
      saveSerialPrefs({ wasConnected: true });
      log('info', `Opened ${label} @ ${$('#selBaud').value} ${$('#selData').value}${$('#selParity').value[0].toUpperCase()}${$('#selStop').value}`);
    } catch (e) {
      toast(`Could not open ${label}: ${e.message}`, 'err', 7000);
      log('err', 'Open failed: ' + e.message);
      return;
    } finally { connecting = false; $('#btnConnect').disabled = false; connUI(); }
    await initJsd(); updateHeartbeat();
  }
  async function disconnect() {
    jsd.abort = true; jsd.stopHeartbeat();
    await link.close(); saveSerialPrefs({ wasConnected: false });
    connUI(); updateHeartbeat();
  }
  const embeddedBrowser = () => /Electron|Claude|WebView|; wv\)/i.test(navigator.userAgent);
  function portHelp(browserProblem) {
    $('#phBrowser').hidden = !browserProblem;
    $('#modalPortHelp').hidden = false;
  }
  async function addPort() {
    // Browser (Web Serial) port picker – only needed if the server can't list the port
    if (!SerialLink.supported() || embeddedBrowser()) { portHelp(true); return; }
    const t0 = Date.now();
    try { const p = await link.web.requestPort(); ports = await link.web.grantedPorts(); await refreshPorts('w:' + ports.indexOf(p)); }
    catch (e) {
      if (e.name === 'NotFoundError') portHelp(Date.now() - t0 < 400);
      else if (e.name === 'SecurityError') portHelp(true);
      else toast(e.message, 'err');
    }
  }
  link.on('close', why => {
    connUI(); updateHeartbeat();
    if (why === 'lost') { toast('Serial connection lost', 'err', 6000); log('err', 'Serial connection lost'); jsd.abort = true; }
  });
  link.on('error', e => log('err', 'Serial error: ' + e.message));

  // ============================================================ start screen / SO
  async function lookupSO() {
    const tester = $('#inTester').value.trim(), so = $('#inSO').value.trim().toUpperCase();
    if (!tester) { toast('Enter the tester name', 'warn'); $('#inTester').focus(); return; }
    if (!so) { toast('Enter the SO number', 'warn'); $('#inSO').focus(); return; }
    store.set('lastTester', tester);
    const box = $('#soResult'); box.hidden = false;
    if (!cfg.odoo.configured) { renderUnits({ name: so }, cfg.products.map(p => ({ ...p, qty: null })), 'Odoo is not configured – choose the unit manually.'); return; }
    box.innerHTML = '<p class="muted">Searching Odoo…</p>';
    $('#btnLookup').disabled = true;
    try {
      const r = await api('/api/so?name=' + encodeURIComponent(so));
      if (!r.found) { box.innerHTML = `<div class="notice notice-err">Sales Order <b>${esc(so)}</b> was not found in Odoo.</div>`; return; }
      if (!r.units.length) {
        renderUnits(r.so, cfg.products.map(p => ({ ...p, qty: null })), `This SO has no ${cfg.products.map(p => p.name).join(' / ')} line. Choose the unit manually only if you are sure.`);
        return;
      }
      renderUnits(r.so, r.units, r.units.length > 1 ? 'This SO has more than one unit type. Select the one you are testing.' : '');
    } catch (e) {
      box.innerHTML = `<div class="notice notice-err">Odoo error: ${esc(e.message)}</div>`;
    } finally { $('#btnLookup').disabled = false; }
  }
  function renderUnits(so, units, note) {
    const box = $('#soResult');
    box.innerHTML = `
      <div class="so-head"><b>${esc(so.name)}</b><span class="muted">${esc(so.customer || '')}${so.state ? ' · ' + esc(so.state) : ''}</span></div>
      ${note ? `<div class="notice">${esc(note)}</div>` : ''}
      <div class="units">${units.map((u, i) => `
        <button class="unit-card" data-u="${i}">
          <div class="u-name">${esc(u.name)}</div>
          <div class="u-code">${esc(u.variants && u.variants.length ? u.variants.join(', ') : u.code)}</div>
          ${u.odooName ? `<div class="u-desc" title="${esc(u.odooName)}">${esc(u.odooName.replace(/^\[[^\]]*\]\s*/, ''))}</div>` : ''}
          ${u.qty != null ? `<div class="u-qty">Qty on SO: ${u.qty}</div>` : ''}
        </button>`).join('')}</div>
      <div class="start-actions"><button class="btn btn-primary btn-lg" id="btnStart" disabled>Start testing →</button></div>`;
    let chosen = units.length === 1 ? 0 : null;
    const mark = () => { $$('.unit-card').forEach(c => c.classList.toggle('selected', +c.dataset.u === chosen)); $('#btnStart').disabled = chosen == null; };
    $$('.unit-card').forEach(c => c.onclick = () => { chosen = +c.dataset.u; mark(); });
    mark();
    $('#btnStart').onclick = () => startSession(so, units[chosen], units);
  }
  function startSession(so, unit, units) {
    session = {
      tester: $('#inTester').value.trim(), so: so.name, soId: so.id || null, customer: so.customer || '',
      unitCode: unit.code, unitName: unit.name, startedAt: new Date().toISOString(), lanes: [], scannedAt: null,
      // every unit on the SO with its variant options – drives the peripheral check
      soUnits: (units || [unit]).filter(u => u.attrs || u.options || u.odooName).map(u => ({ code: u.code, name: u.name, attrs: u.attrs || [], options: u.options || [] }))
    };
    saveSession(); showDashboard();
    toast(`Active unit: ${unit.name}`, 'ok');
    if (jsd.ready && initDone) scanLanes(true);
  }
  function showStart() {
    $('#screenTest').hidden = true; $('#screenStart').hidden = false; $('#sessionChips').hidden = true;
    $('#inTester').value = store.get('lastTester', ''); $('#inSO').value = '';
    $('#soResult').hidden = true; $('#soResult').innerHTML = '';
    $('#odooWarn').hidden = cfg.odoo.configured;
    ($('#inTester').value ? $('#inSO') : $('#inTester')).focus();
  }
  function showDashboard() {
    $('#screenStart').hidden = true; $('#screenTest').hidden = false; $('#sessionChips').hidden = false;
    $('#chipSO').textContent = session.so; $('#chipUnit').textContent = session.unitName; $('#chipTester').textContent = session.tester;
    setStep('reset'); setProgress(0, 0, 'Ready'); renderGrid(); connUI(); updateHeartbeat(); jsd.emit('state');
    checkPeripherals();
  }

  // ============================================================ peripherals (SO options vs. devices on this PC)
  let periph = null;
  async function checkPeripherals(force) {
    if (!session) return;
    const btn = $('#btnPeriph'); btn.disabled = true; $('#periphInfo').textContent = 'checking…';
    try {
      periph = await api('/api/peripherals', { method: 'POST', body: { units: session.soUnits || [], force: !!force } });
      session.peripherals = { at: periph.at, missing: periph.missing, rows: periph.rows.map(r => ({ label: r.label, status: r.status, required: r.required, found: r.found.map(f => f.name), value: r.value })) };
      saveSession();
      renderPeripherals();
    } catch (e) {
      const old = /not found|404/i.test(e.message);
      $('#periphInfo').textContent = '';
      $('#periphNote').innerHTML = `<div class="notice notice-err">Device check failed: ${old ? 'the tester server is an older version. Close the "Lane Tester Server" window and the kiosk (Alt+F4), then run start-kiosk.bat again.' : esc(e.message)}</div>`;
    } finally { btn.disabled = false; }
  }
  const PST = { ok: ['on', 'Connected'], missing: ['bad', 'MISSING'], extra: ['warn', 'Connected – not on SO'], na: ['off', 'Not required'], unknown: ['unk', 'Not checked'] };
  function renderPeripherals() {
    const p = periph; if (!p) return;
    $('#periphInfo').textContent = `${p.os} · ${p.host.name || ''} · ${new Date(p.at).toLocaleTimeString()}`;
    const notes = [];
    if (p.error) notes.push(`<div class="notice notice-err">${esc(p.error)}</div>`);
    if (!p.requirementsKnown && window.LANE_WEB) notes.push(`<div class="notice">Only the cameras can be checked from the browser. The NUC serial number, barcode scanner and badge readers are checked by the Windows tester (browsers may not read the USB device list).</div>`);
    else if (!p.requirementsKnown) notes.push(`<div class="notice">The SO options are not known (Odoo lookup without variant options, or unit chosen manually) – only the default camera is expected. Look up the SO again to load its options.</div>`);
    else if (p.missing) notes.push(`<div class="notice notice-err"><b>${p.missing} item(s) missing</b> – check the cables / USB hub, then press Check devices.</div>`);
    else notes.push(`<div class="notice notice-ok">All peripherals required by ${esc(session.so)} are connected (cameras ${p.cameraCount.found}/${p.cameraCount.expected}).</div>`);
    $('#periphNote').innerHTML = notes.join('');
    $('#periphTable').innerHTML = `<thead><tr><th></th><th>Peripheral</th><th>Needed by SO</th><th>Detected on this PC</th><th></th></tr></thead><tbody>` + p.rows.map((r, i) => {
      const [led, txt] = PST[r.status] || PST.unknown;
      const need = r.id === 'nuc' ? '' : r.required == null ? '?' : r.required ? 'Yes' : 'No';
      const found = r.id === 'nuc' ? `<b>${esc(r.value || '')}</b>${r.detail ? `<br><small class="muted">${esc(r.detail)}</small>` : ''}`
        : r.found.length ? r.found.map(f => `${esc(f.name)}${f.vid ? ` <small class="muted">${f.vid}:${f.pid}</small>` : ''}`).join('<br>') : `<span class="muted">${r.required ? 'not found' : '–'}</span>`;
      const why = (r.why || []).length ? `<br><small class="muted">${esc(r.why.join(' · '))}</small>` : '';
      return `<tr class="ps-${r.status}"><td><i class="led ${led}"></i></td><td><b>${esc(r.label)}</b>${why}</td><td>${need}</td><td>${found}<div class="ps-txt">${txt}</div></td>
        <td>${r.camera && r.found.length ? `<button class="btn btn-sm" data-cam="${r.index}">▶ Live view</button>` : ''}</td></tr>`;
    }).join('') + '</tbody>';
    $$('#periphTable [data-cam]').forEach(b => b.onclick = () => openCamera(+b.dataset.cam));
  }

  // live camera view (browser getUserMedia; the kiosk is started with --use-fake-ui-for-media-stream so no prompt)
  let camStream = null;
  async function browserCams() {
    let list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    if (list.length && !list[0].label) {   // labels need a permission grant first
      try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); } catch { }
      list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    }
    return list;
  }
  function stopCam() { if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } $('#camVideo').srcObject = null; }
  async function openCamera(index) {
    $('#modalCam').hidden = false; $('#camMsg').textContent = 'Opening camera…';
    const rowsCams = (periph && periph.rows.filter(r => r.camera && r.found.length)) || [];
    const want = rowsCams.find(r => r.index === index);
    $('#camTitle').textContent = want ? want.label : 'Camera';
    let cams = [];
    try { cams = await browserCams(); } catch (e) { $('#camMsg').textContent = 'Camera access is not available: ' + e.message; return; }
    if (!cams.length) { $('#camMsg').textContent = 'The browser sees no camera. Check camera permission for this page.'; return; }
    // match Device-Manager camera to browser camera: Chrome labels end with "(vid:pid)"
    const f = want && want.found[0];
    let pick = f && cams.findIndex(c => f.vid && c.label.toLowerCase().includes(`(${f.vid}:${f.pid})`.toLowerCase()) && c.label.toLowerCase().includes(String(f.name).toLowerCase().slice(0, 12)));
    if (!(pick >= 0) && f) pick = cams.findIndex(c => c.label.toLowerCase().includes(String(f.name).toLowerCase()));
    if (!(pick >= 0) && f && f.vid) pick = cams.findIndex(c => c.label.toLowerCase().includes(`(${f.vid}:${f.pid})`.toLowerCase()));
    if (!(pick >= 0)) pick = Math.min(index, cams.length - 1);
    $('#selCam').innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || 'Camera ' + (i + 1))}</option>`).join('');
    $('#selCam').selectedIndex = pick;
    $('#selCam').onchange = () => startCam($('#selCam').value);
    startCam(cams[pick].deviceId);
  }
  async function startCam(deviceId) {
    stopCam(); $('#camMsg').textContent = 'Opening camera…'; $('#camInfo').textContent = '';
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = $('#camVideo'); v.srcObject = camStream; await v.play().catch(() => { });
      const s = camStream.getVideoTracks()[0].getSettings();
      $('#camMsg').textContent = ''; $('#camInfo').textContent = s.width ? `${s.width}×${s.height}${s.frameRate ? ' · ' + Math.round(s.frameRate) + ' fps' : ''}` : '';
    } catch (e) {
      $('#camMsg').textContent = /NotReadable|TrackStart/i.test(e.name + e.message) ? 'Camera is in use by another program (close the kiosk software / other camera app).'
        : /NotAllowed|Permission/i.test(e.name + e.message) ? 'Camera permission is blocked for this page. Start the tester with start-kiosk.bat (it allows the camera), or allow the camera in the browser settings.'
        : 'Could not open the camera: ' + (e.message || e.name);
    }
  }

  // ============================================================ summary / save
  function summary() {
    const L = session.lanes.filter(testable);
    return { L, pass: L.filter(l => l.status === 'pass'), fail: L.filter(l => l.status === 'fail'), left: L.filter(l => l.status === 'untested' || l.status === 'testing') };
  }
  function openSummary() {
    const s = summary(); const ok = !s.fail.length && !s.left.length && s.L.length;
    $('#sumTitle').textContent = `Summary – ${session.so}`;
    $('#sumBody').innerHTML = `
      <div class="verdict ${ok ? 'pass' : 'fail'}">${!s.L.length ? 'NO LANES TESTED' : ok ? 'ALL LANES PASSED' : s.fail.length ? `${s.fail.length} LANE(S) FAILED` : `${s.left.length} LANE(S) NOT TESTED`}</div>
      <div class="sum-big">
        <div class="stat"><span>Unit</span><b style="font-size:1.1rem">${esc(session.unitName)}</b></div>
        <div class="stat pass"><span>Pass</span><b>${s.pass.length}</b></div>
        <div class="stat fail"><span>Fail</span><b>${s.fail.length}</b></div>
        <div class="stat"><span>Untested</span><b>${s.left.length}</b></div>
      </div>
      <p class="muted">Machine: ${esc(jsd.info.model || '?')} ${esc(jsd.info.serial || '')} · JSD ${esc(jsd.info.jsdFw || '?')}</p>
      ${s.fail.length ? `<table class="tbl"><tr><th>Lane</th><th>Error</th></tr>${s.fail.map(l => `<tr><td>${esc(l.code)}</td><td>${esc(l.error)}</td></tr>`).join('')}</table>` : ''}`;
    $('#chkPostOdoo').parentElement.hidden = !(cfg.odoo.configured && session.soId);
    $('#chkPostOdoo').checked = !!cfg.odoo.postResultsToChatter;
    $('#modalSummary').hidden = false;
  }
  function resultPayload() {
    return {
      ...session, lanes: session.lanes.filter(testable),
      machine: { model: jsd.info.model, serial: jsd.info.serial, firmware: jsd.info.fw, jsd: jsd.info.jsdFw, simulator: jsd.sim },
      testMode: testPrefs().mode, cycles: cyclesWanted(),
      finishedAt: new Date().toISOString(), postToOdoo: $('#chkPostOdoo').checked && !$('#chkPostOdoo').parentElement.hidden
    };
  }
  async function saveResults() {
    const s = summary();
    if (s.left.length && !await confirmDlg('Untested lanes', `${s.left.length} lane(s) were not tested. Save anyway?`, 'Save')) return;
    $('#btnSave').disabled = true;
    try {
      const r = await api('/api/results', { method: 'POST', body: resultPayload() });
      toast(`Results saved${r.chatter === true ? ' and posted to Odoo' : ''}`, 'ok');
      if (typeof r.chatter === 'string') toast('Odoo post failed: ' + r.chatter, 'err', 7000);
      $('#modalSummary').hidden = true;
      session = null; store.set('session', null); showStart();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    finally { $('#btnSave').disabled = false; }
  }
  function downloadCsv() {
    const rows = [['SO', 'Customer', 'Unit', 'Unit code', 'Machine S/N', 'Tester', 'Lane', 'Tray', 'Channel', 'Result', 'Duration s', 'Note', 'Error', 'Tested at']];
    session.lanes.filter(testable).forEach(l => rows.push([session.so, session.customer, session.unitName, session.unitCode, jsd.info.serial, session.tester, l.code, l.row, l.col, l.status.toUpperCase(), l.ms ? (l.ms / 1000).toFixed(1) : '', l.note || '', l.error || '', l.at || '']));
    const csv = rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${session.so}_${session.unitCode}_lane_test.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function printReport() {
    const s = summary();
    $('#printArea').innerHTML = `
      <img src="img/signifi-logo.png" class="print-logo" alt="Signifi">
      <h2>Lane Test Report – ${esc(session.so)}</h2>
      <p>Customer: ${esc(session.customer)}<br>Unit: ${esc(session.unitName)} (${esc(session.unitCode)})<br>Machine: ${esc(jsd.info.model)} S/N ${esc(jsd.info.serial)}<br>Tester: ${esc(session.tester)}<br>
      Started: ${new Date(session.startedAt).toLocaleString()}<br>Printed: ${new Date().toLocaleString()}</p>
      <p><b>Pass: ${s.pass.length} &nbsp; Fail: ${s.fail.length} &nbsp; Untested: ${s.left.length}</b></p>
      <table><tr><th>Lane</th><th>Tray</th><th>Channel</th><th>Result</th><th>Note / error</th></tr>
      ${s.L.map(l => `<tr><td>${esc(l.code)}</td><td>${l.row}</td><td>${l.col}</td><td>${l.status.toUpperCase()}</td><td>${esc(l.error || l.note || '')}</td></tr>`).join('')}</table>`;
    window.print();
  }

  // ============================================================ admin
  const admin = { token: null, draft: null, tab: window.LANE_WEB ? 'products' : 'odoo' };   // web build has no Odoo
  function openAdmin() {
    $('#modalAdmin').hidden = false;
    if (admin.token) { loadAdmin(); return; }
    $('#adminLogin').hidden = false; $('#adminBody').hidden = true; $('#inPin').value = ''; $('#inPin').focus();
  }
  async function adminLogin() {
    try { const r = await api('/api/admin/login', { method: 'POST', body: { pin: $('#inPin').value } }); admin.token = r.token; loadAdmin(); }
    catch (e) { toast(e.message, 'err'); $('#inPin').value = ''; }
  }
  async function loadAdmin() {
    try { admin.draft = await api('/api/admin/config'); }
    catch (e) { admin.token = null; toast(e.message, 'err'); openAdmin(); return; }
    $('#adminLogin').hidden = true; $('#adminBody').hidden = false; $('#adminMsg').textContent = '';
    renderAdminTab();
  }
  const fld = (label, path, type = 'text', extra = '') => {
    const v = getPath(admin.draft, path);
    if (type === 'bool') return `<label class="toggle"><input type="checkbox" data-path="${path}" data-type="bool" ${v ? 'checked' : ''}><span>${label}</span></label>`;
    return `<label class="field"><span>${label}</span><input type="${type === 'num' ? 'number' : type}" data-path="${path}" data-type="${type}" value="${esc(v == null ? '' : v)}" ${extra}></label>`;
  };
  const sel = (label, path, opts, numeric) => {
    const v = String(getPath(admin.draft, path));
    return `<label class="field"><span>${label}</span><select data-path="${path}" ${numeric ? 'data-type="num"' : ''}>${opts.map(([k, t]) => `<option value="${esc(k)}" ${String(k) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  };
  const SPEEDS = [...Array(21).keys()].map(n => [n, n === 20 ? '20 – auto adjust (V8 and newer)' : n < 10 ? `${n} – continuous${n === 0 ? ' (slowest)' : n === 9 ? ' (fastest)' : ''}` : `${n} – pulses${n === 10 ? ' (slowest)' : n === 19 ? ' (fastest)' : ''}`]);
  function renderAdminTab() {
    $$('#adminTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === admin.tab));
    const d = admin.draft, body = $('#adminTabBody');
    const T = {
      odoo: () => `
        <p class="help">Odoo external API (JSON-RPC). Create an API key in Odoo: <i>Preferences → Account Security → New API Key</i>. The key stays on this kiosk's server and is never sent to the browser.</p>
        <div class="form-grid">
          ${fld('Odoo URL', 'odoo.url', 'text', 'placeholder="https://yourcompany.odoo.com"')}
          ${fld('Database', 'odoo.db')}
          ${fld('Username / login email', 'odoo.username')}
          ${fld('API key', 'odoo.apiKey', 'password', 'autocomplete="new-password"')}
        </div>
        ${fld('Post test results to the Sales Order chatter', 'odoo.postResultsToChatter', 'bool')}
        <p style="margin-top:16px"><button class="btn btn-primary" id="btnOdooTest">Save &amp; test connection</button> <span id="odooTestRes" class="muted"></span></p>`,
      products: () => `
        <p class="help">Products searched on the SO (by Internal Reference). <b>Machine type</b> picks the hatch cycle: <i>Qendra</i> has a motorised collection door (Op 158 / 157); <i>ES-Plus</i> has a passive flap (Op 154). <i>Auto</i> reads the model from the JSD (Op 105). <b>Speed</b> is the lane extraction speed sent with Op 150.</p>
        <table class="tbl"><tr><th>Internal reference</th><th>Display name</th><th>Machine type</th><th>Lane speed</th><th></th></tr>
        ${d.products.map((p, i) => `<tr>
          <td><input data-path="products.${i}.code" value="${esc(p.code)}"></td>
          <td><input data-path="products.${i}.name" value="${esc(p.name)}"></td>
          <td><select data-path="products.${i}.machineType">${[['auto', 'Auto (from JSD)'], ['esplus', 'Vision ES-Plus'], ['qendra', 'Qendra']].map(([k, t]) => `<option value="${k}" ${p.machineType === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
          <td><select data-path="products.${i}.speed" data-type="num">${SPEEDS.map(([k, t]) => `<option value="${k}" ${Number(p.speed) === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
          <td><button class="btn btn-sm btn-danger" data-delprod="${i}">✕</button></td></tr>`).join('')}
        </table>
        <p><button class="btn btn-sm" id="btnAddProd">+ Add product</button></p>`,
      machine: () => `
        ${fld('Simulator mode (no serial traffic – for training / demo)', 'machine.simulator', 'bool')}
        <div class="form-grid" style="margin-top:12px">
          ${sel('Simulated machine', 'machine.simModel', [['esplus', 'Vision ES-Plus'], ['qendra', 'Qendra']])}
          ${fld('Simulated failure rate (0-1)', 'machine.simFailRate', 'num', 'step="0.01" min="0" max="1"')}
        </div>
        <h4>J-CONNECT (application 402 – Vision)</h4>
        <div class="form-grid">
          ${sel('Machine number on the JSD', 'jconnect.machineNumber', [[0, '0'], [1, '1'], [2, '2'], [3, '3']], true)}
          ${fld('First tray to scan', 'jconnect.firstTray', 'num', 'min="11" max="18"')}
          ${fld('Last tray to scan', 'jconnect.lastTray', 'num', 'min="11" max="18"')}
          ${fld('Channels per tray to scan', 'jconnect.maxChannels', 'num', 'min="1" max="10"')}
          ${fld('Extra lane run after product detected (ms)', 'jconnect.postRunMs', 'num', 'step="100" min="0"')}
          ${fld('Lane code format ({tray} {ch})', 'machine.laneCodeFormat')}
        </div>
        ${fld('Reset sold-out flags before each test run (Op 108) – so every lane is really run', 'jconnect.resetSoldOut', 'bool')}
        ${fld('Empty lane counts as PASS when the motor ran (no product loaded)', 'jconnect.emptyLanePass', 'bool')}
        ${fld('Enable extended dispense data on connect (Op 116) – detailed failure reasons', 'jconnect.enableExtended204', 'bool')}
        ${fld('Enable Qendra precise state tracking on connect (Op 118)', 'jconnect.qendraTracking', 'bool')}
        <h4>Default serial settings for new kiosks</h4>
        <div class="form-grid">
          ${sel('Baud rate', 'serial.baudRate', BAUDS.map(b => [b, b]), true)}
          ${sel('Line ending', 'serial.lineEnding', [['none', 'None'], ['cr', 'CR'], ['lf', 'LF'], ['crlf', 'CR+LF']])}
          ${sel('Data bits', 'serial.dataBits', [[8, 8], [7, 7]], true)}
          ${sel('Parity', 'serial.parity', [['none', 'None'], ['even', 'Even'], ['odd', 'Odd']])}
          ${sel('Stop bits', 'serial.stopBits', [[1, 1], [2, 2]], true)}
        </div>
        ${fld('Reconnect the COM port automatically on start-up / re-plug', 'serial.autoReconnect', 'bool')}`,
      timing: () => `
        <div class="form-grid">
          ${fld('Hatch open time (ms)', 'timing.hatchOpenMs', 'num')}
          ${fld('Basic test: lane run time (ms)', 'timing.basicRunMs', 'num')}
          ${fld('Basic test: hatch open time (ms)', 'timing.basicHatchOpenMs', 'num')}
          ${fld('Basic test: elevator travel time if no state (ms)', 'timing.basicTravelMs', 'num')}
          ${fld('Basic test: keep retrying hatch close for (ms)', 'timing.basicCloseWaitMs', 'num')}
          ${fld('Pause between lanes (ms)', 'timing.betweenLanesMs', 'num')}
          ${fld('Heartbeat interval (ms)', 'timing.heartbeatMs', 'num')}
          ${fld('Missed heartbeats before alarm', 'timing.heartbeatMissLimit', 'num')}
          ${fld('Dispense timeout (ms)', 'timing.dispenseTimeoutMs', 'num')}
          ${fld('Elevator → hatch timeout (ms)', 'timing.hatchTimeoutMs', 'num')}
          ${fld('Elevator → rest timeout (ms)', 'timing.homeTimeoutMs', 'num')}
          ${fld('Wait for product pick-up (ms)', 'timing.collectTimeoutMs', 'num')}
        </div>`,
      security: () => `
        <p class="help">Change the admin PIN (leave empty to keep the current one).</p>
        <div class="form-grid">${fld('New admin PIN', 'newPin', 'password', 'inputmode="numeric" autocomplete="new-password"')}</div>`,
      history: () => '<p class="muted">Loading…</p>'
    };
    body.innerHTML = T[admin.tab]();
    bindAdminInputs();
    if (admin.tab === 'history') loadHistory();
  }
  function bindAdminInputs() {
    $$('#adminTabBody [data-path]').forEach(el => {
      const h = () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.type === 'num') v = el.value === '' ? '' : Number(el.value);
        setPath(admin.draft, el.dataset.path, v);
      };
      el.addEventListener('input', h); el.addEventListener('change', h);
    });
    $('#btnAddProd') && ($('#btnAddProd').onclick = () => { admin.draft.products.push({ code: '', name: '', machineType: 'auto', speed: 5 }); renderAdminTab(); });
    $$('[data-delprod]').forEach(b => b.onclick = () => { admin.draft.products.splice(+b.dataset.delprod, 1); renderAdminTab(); });
    $('#btnOdooTest') && ($('#btnOdooTest').onclick = async () => {
      const out = $('#odooTestRes'); out.textContent = 'Testing…';
      try { await saveAdmin(true); const r = await api('/api/admin/odoo-test', { method: 'POST' }); out.innerHTML = `<span class="res-pass">Connected</span> – ${esc(r.company || '')} · Odoo ${esc(r.version || '?')} · ${r.protocol === 'json2' ? 'JSON-2 API' : 'JSON-RPC'}`; if (admin.draft.odoo.url !== r.url) { admin.draft.odoo.url = r.url; } }
      catch (e) { out.innerHTML = `<span class="res-fail">${esc(e.message)}</span>`; }
    });
  }
  async function loadHistory() {
    try {
      const list = await api('/api/results');
      $('#adminTabBody').innerHTML = list.length ? `<table class="tbl"><tr><th>Finished</th><th>SO</th><th>Unit</th><th>Tester</th><th>Pass</th><th>Fail</th><th>File</th></tr>
        ${list.map(r => `<tr><td>${r.finishedAt ? new Date(r.finishedAt).toLocaleString() : ''}</td><td>${esc(r.so)}</td><td>${esc(r.unit)}</td><td>${esc(r.tester)}</td>
        <td class="res-pass">${r.pass ?? ''}</td><td class="${r.fail ? 'res-fail' : ''}">${r.fail ?? ''}</td><td class="muted">${esc(r.file)}</td></tr>`).join('')}</table>
        <p class="help" style="margin-top:10px">Result files are stored in the <code>results</code> folder next to server.js.</p>` : '<p class="muted">No saved results yet.</p>';
    } catch (e) { $('#adminTabBody').innerHTML = `<div class="notice notice-err">${esc(e.message)}</div>`; }
  }
  async function saveAdmin(silent) {
    const r = await api('/api/admin/config', { method: 'POST', body: admin.draft });
    admin.draft = r.config;
    await reloadConfig();
    if (!silent) { $('#adminMsg').textContent = 'Saved ✓'; toast('Settings saved', 'ok'); }
  }
  async function reloadConfig() {
    const wasSim = jsd.sim;
    cfg = await api('/api/config');
    jsd.setConfig(cfg);
    if (jsd.sim && wasSim !== jsd.sim && link.connected) await disconnect();
    if (session) { session.lanes.forEach(l => { l.code = laneCode(l.row, l.col); }); saveSession(); renderGrid(); }
    else $('#odooWarn').hidden = cfg.odoo.configured;
    connUI();
    if (jsd.sim && (wasSim !== jsd.sim || !initDone)) await initJsd();
    updateHeartbeat();
  }

  // ============================================================ wake lock / kiosk niceties
  let wakeLock = null;
  async function acquireWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch { } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquireWakeLock(); });
  document.addEventListener('contextmenu', e => { if (!e.target.closest('input,textarea,.log')) e.preventDefault(); });

  // ============================================================ manual actions
  async function manual(act, btn) {
    if (!ensureReady() || running) return;
    btn.disabled = true;
    let r;
    try {
      if (act === 'status') { await showFaults(); return; }
      if (act === 'toHatch') r = await jsd.toHatch(session && session.unitCode);
      if (act === 'closeHatch') r = await jsd.closeHatch();
      if (act === 'light') r = await jsd.light(!(jsd.m.light === 1));
      if (act === 'soldout') r = await jsd.resetSoldOut();
      if (act === 'faults') { await resetAllFaults(); return; }
    } finally { btn.disabled = false; }
    const answer = r && r.ok ? r.msg.text : '';
    let okText = r && r.ok;
    if (r && r.ok && [211, 226, 227, 212].includes(r.msg.op) && r.msg.f[1] !== '0') okText = false;
    toast(`${btn.textContent}: ${r.ok ? (okText ? 'OK' : 'refused by machine') + (answer ? ` (${r.msg.op}: ${answer})` : '') : r.error}`, okText ? 'ok' : 'err', 5000);
  }

  // ============================================================ machine status / faults (Op 100, 115, 111 → 215)
  const faultRow = (f, active) => `<tr class="${active ? 'f-act' : ''}"><td><i class="led ${active ? 'bad' : 'off'}"></i></td><td><b>${f.n}</b></td><td>${esc(EVENTS[f.n] || 'Unknown fault')}</td>` +
    `<td>${f.times != null ? f.times + '×' : ''}${f.minutes != null ? ` · ${f.minutes} min` : ''}</td><td>${esc(f.last || '')}</td></tr>`;
  function renderFaults(rep) {
    const m = jsd.m;
    const kv = (k, v, cls = '') => `<div class="kv"><span>${k}</span><b class="${cls}">${esc(v)}</b></div>`;
    const avail = m.comm != null && m.comm !== 1 ? (m.comm === 2 ? 'Machine lost' : 'Machine not connected') : m.service === 0 ? 'Out of service' : (AVAIL[m.avail] || '–');
    const tbl = (list, active, err) => err ? `<div class="notice notice-err">${esc(err)}</div>` : list.length
      ? `<table class="fault-tbl"><thead><tr><th></th><th>#</th><th>Fault</th><th>Count</th><th>Last active</th></tr></thead><tbody>${list.map(f => faultRow(f, active)).join('')}</tbody></table>`
      : `<div class="notice notice-ok">${active ? 'No active faults' : 'No non-active faults in the history'}</div>`;
    $('#faultBody').innerHTML = (rep.error ? `<div class="notice notice-err">${esc(rep.error)}</div>` : '') +
      `<div class="fault-kv">${kv('Machine link', m.comm === 1 ? 'Connected' : m.comm == null ? '–' : 'Not connected', m.comm === 1 ? 'good' : 'bad')}${kv('Service', m.service === 1 ? 'In service' : m.service === 0 ? 'Out of service' : '–', m.service === 1 ? 'good' : 'bad')}` +
      `${kv('Main door', m.door === 1 ? 'Closed' : m.door === 0 ? 'OPEN' : '–', m.door === 1 ? 'good' : 'bad')}${kv('Availability', avail)}${kv('Elevator (Op 225)', m.qSeen ? (QSTATE[m.q] || String(m.q)) : '–')}${kv('Temperature', m.temp ? m.temp + ' °C' : '–')}</div>` +
      `<h4>Active faults (${rep.active.length})</h4>${tbl(rep.active, true, rep.activeError)}` +
      `<h4>Non-active faults – history (${rep.inactive.length})</h4>${tbl(rep.inactive, false, rep.inactiveError)}`;
    $('#faultAt').textContent = 'Read ' + new Date().toLocaleTimeString();
  }
  async function showFaults() {
    $('#modalFaults').hidden = false;
    $('#faultBody').innerHTML = '<div class="muted">Reading machine status and faults…</div>';
    const rep = await jsd.faultReport();
    renderFaults(rep);
    log(rep.active.length ? 'err' : 'info', `Machine status: ${rep.active.length} active fault(s), ${rep.inactive.length} non-active`);
  }
  async function resetAllFaults() {
    if (!await confirmDlg('Reset faults', 'This resets the ACTIVE faults and runs the machine auto-test (Op 153), then clears the NON-ACTIVE fault history (Op 111). Jofemar warns not to send it while the machine is trying to recover by itself. Continue?', 'Reset')) return;
    $('#modalFaults').hidden = false;
    $('#faultBody').innerHTML = '<div class="muted">Resetting faults – machine auto-test running…</div>';
    const r = await jsd.resetAllFaults();
    log(r.ok ? 'info' : 'err', 'Reset faults: ' + r.text);
    toast(r.text, r.ok ? 'ok' : 'err', 7000);
    renderFaults(await jsd.faultReport());
  }

  // ============================================================ wiring
  function wire() {
    $('#selBaud').innerHTML = BAUDS.map(b => `<option value="${b}">${b}${b === 9600 ? ' (J-CONNECT)' : ''}</option>`).join('');
    const prefs = store.get('serial', {});
    $('#selBaud').value = prefs.baud || cfg.serial.baudRate;
    $('#selEol').value = prefs.eol || cfg.serial.lineEnding;
    $('#selData').value = prefs.data || cfg.serial.dataBits;
    $('#selParity').value = prefs.parity || cfg.serial.parity;
    $('#selStop').value = prefs.stop || cfg.serial.stopBits;
    $('#selEol').onchange = () => { saveSerialPrefs(); if ($('#selEol').value !== 'none') toast('J-CONNECT frames are binary – the line ending is not used.', 'warn'); };
    ['#selBaud', '#selData', '#selParity', '#selStop', '#selPort'].forEach(s => $(s).addEventListener('change', () => saveSerialPrefs()));
    $('#chkHb').checked = prefs.heartbeat !== false;
    $('#chkHb').onchange = () => { saveSerialPrefs({ heartbeat: $('#chkHb').checked }); updateHeartbeat(); };

    $('#btnAddPort').onclick = addPort;
    $('#lnkPortHelp').onclick = e => { e.preventDefault(); portHelp(embeddedBrowser()); };
    $('#btnRefreshPorts').onclick = async () => { const n = await refreshPorts(); toast(n ? `${n} COM port(s) found` : 'No COM port found – plug in the FTDI adapter', n ? 'ok' : 'warn'); };
    if (embeddedBrowser() || !SerialLink.supported()) $('#btnAddPort').hidden = true;
    $('#btnConnect').onclick = () => link.connected ? disconnect() : connect();
    $('#btnLookup').onclick = lookupSO;
    $('#inSO').addEventListener('keydown', e => { if (e.key === 'Enter') lookupSO(); });
    $('#inTester').addEventListener('keydown', e => { if (e.key === 'Enter') $('#inSO').focus(); });
    $('#btnChangeSession').onclick = async () => {
      const s = summary();
      if ((s.pass.length || s.fail.length) && !await confirmDlg('Leave this session?', 'Results that are not saved will be lost. Use "Finish & save" to keep them.', 'Leave')) return;
      session = null; store.set('session', null); showStart();
    };

    $('#laneGrid').addEventListener('click', e => {
      const b = e.target.closest('.lane'); if (!b || running) return;
      const i = +b.dataset.i;
      runLanes([i], `Lane ${session.lanes[i].code}`);
    });
    $('#btnTestAll').onclick = async () => {
      const idx = session.lanes.map((l, i) => testable(l) ? i : -1).filter(i => i >= 0);
      const tested = session.lanes.some(l => l.status === 'pass' || l.status === 'fail');
      if (tested && !await confirmDlg('Test all lanes', 'Previous results on this unit will be overwritten. Continue?', 'Start')) return;
      runLanes(idx, 'Test all lanes');
    };
    $('#btnRetest').onclick = () => runLanes(session.lanes.map((l, i) => l.status === 'fail' ? i : -1).filter(i => i >= 0), 'Retest failed lanes');
    const tp = testPrefs();
    $('#inCycles').value = tp.cycles || 1;
    const setMode = mode => { $$('#segMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode)); store.set('testPrefs', { ...testPrefs(), mode }); };
    setMode(tp.mode === 'basic' ? 'basic' : 'full');
    $$('#segMode button').forEach(b => b.onclick = () => { if (!running) setMode(b.dataset.mode); });
    $('#inCycles').onchange = () => { $('#inCycles').value = cyclesWanted(); store.set('testPrefs', { ...testPrefs(), cycles: cyclesWanted() }); };
    $('#btnSensors').onclick = async () => {
      if (!ensureReady()) return;
      if (running) { toast('Sensors update live while a test runs.', 'ok'); return; }
      $('#btnSensors').disabled = true; await jsd.readSensors().catch(() => { }); $('#btnSensors').disabled = false;
    };
    $('#btnPeriph').onclick = () => checkPeripherals(true);
    $('#btnFaultRefresh').onclick = () => { if (ensureReady()) showFaults(); };
    $('#btnFaultReset').onclick = () => { if (ensureReady() && !running) resetAllFaults(); };
    $('#btnCamClose').onclick = () => { stopCam(); $('#modalCam').hidden = true; };
    $('#btnStop').onclick = () => { jsd.abort = true; $('#progTxt').textContent = 'Stopping – bringing the machine to a safe state…'; };
    $('#btnScan').onclick = () => scanLanes(false);
    $('#btnReset').onclick = async () => {
      if (!await confirmDlg('Reset results', 'Clear all lane results for this unit?', 'Reset')) return;
      session.lanes.forEach(l => { if (testable(l)) { l.status = 'untested'; l.error = ''; l.note = ''; l.ms = 0; } });
      saveSession(); renderGrid(); setStep('reset'); setProgress(0, 0, 'Ready');
    };
    $('#btnFinish').onclick = openSummary;
    $('#btnSave').onclick = saveResults;
    $('#btnCsv').onclick = downloadCsv;
    $('#btnPrint').onclick = printReport;

    $$('[data-act]').forEach(b => b.onclick = () => manual(b.dataset.act, b));
    $('#btnRaw').onclick = async () => {
      if (!ensureReady()) return;
      const op = parseInt($('#inOp').value, 10);
      if (!(op >= 100 && op < 1000)) { toast('Enter an opcode (e.g. 100)', 'warn'); return; }
      if (op === 156 && !await confirmDlg('JSD reset', 'Op 156 resets the JSD completely, whatever the machine is doing. Continue?', 'Reset JSD')) return;
      try { await jsd.send(op, $('#inOpData').value.trim()); $('#logWrap').open = true; }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#inOpData').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnRaw').click(); });
    $('#btnLogClear').onclick = () => { logLines.length = 0; scheduleLog(); };

    // admin
    $('#btnAdmin').onclick = openAdmin;
    $('#keypad').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, '⌫', 0, '✓'].map(k => `<button class="btn" data-k="${k}">${k}</button>`).join('');
    $('#keypad').onclick = e => {
      const k = e.target.dataset.k; if (k == null) return;
      if (k === '⌫') $('#inPin').value = $('#inPin').value.slice(0, -1);
      else if (k === '✓') adminLogin();
      else $('#inPin').value += k;
    };
    $('#btnPin').onclick = adminLogin;
    $('#inPin').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
    $('#adminTabs').onclick = e => { const t = e.target.dataset.tab; if (t) { admin.tab = t; renderAdminTab(); } };
    $('#btnAdminSave').onclick = () => saveAdmin().catch(e => toast(e.message, 'err'));
    $$('[data-close]').forEach(b => b.onclick = () => { b.closest('.modal').hidden = true; });

    // Re-plug detection: while disconnected, look for the remembered COM port every 5 s and reconnect
    setInterval(async () => {
      if (link.connected || jsd.sim || connecting || document.hidden || $('#screenTest').hidden) return;
      const prefs = store.get('serial', {});
      await refreshPorts();
      if (cfg.serial.autoReconnect && prefs.wasConnected && prefs.portKey && $('#selPort').value === prefs.portKey) {
        toast('COM port is back – reconnecting'); connect();
      }
    }, 5000);
  }

  async function init() {
    try { cfg = await api('/api/config'); }
    catch (e) { document.body.innerHTML = `<div class="notice notice-err" style="margin:40px">Cannot reach the tester server: ${esc(e.message)}. Start it with start-kiosk.bat.</div>`; return; }
    jsd.setConfig(cfg);
    wire();
    await refreshPorts();
    session = store.get('session', null);
    if (session && Array.isArray(session.lanes) && session.lanes.every(l => 'chStatus' in l || l.status === 'absent')) {
      session.lanes.forEach(l => { if (l.status === 'testing') l.status = 'untested'; });
      showDashboard();
    } else { session = null; store.set('session', null); showStart(); }
    connUI();
    const prefs = store.get('serial', {});
    if (jsd.sim) await initJsd();
    else if (cfg.serial.autoReconnect && prefs.wasConnected && prefs.portKey && $('#selPort').value === prefs.portKey) connect();
    updateHeartbeat();
    acquireWakeLock();
  }
  init();
})();
