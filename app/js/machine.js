/*
 * SerialLink  : Web Serial API (Chrome / Edge) – FTDI USB-RS232 to the JSD
 * Jsd         : J-CONNECT client for Jofemar Vision ES-Plus / Qendra through the JSD
 *               (status tracking, heartbeat, lane scan, lane test cycle, simulator)
 */
(function (global) {
  'use strict';
  const { Emitter, JLink, SimJsd, OPS } = JConnect;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ================================================================ SerialLink
  class SerialLink extends Emitter {
    constructor() { super(); this.port = null; this.reader = null; this.writer = null; this.connected = false; this._closing = false; }
    static supported() { return 'serial' in navigator; }
    static describe(port) {
      const i = port.getInfo ? port.getInfo() : {};
      if (i.usbVendorId === 0x0403) return `FTDI USB-Serial (PID ${(i.usbProductId || 0).toString(16).padStart(4, '0').toUpperCase()})`;
      if (i.usbVendorId) return `USB Serial VID ${i.usbVendorId.toString(16).toUpperCase()} PID ${(i.usbProductId || 0).toString(16).toUpperCase()}`;
      return 'Serial port';
    }
    async grantedPorts() { return SerialLink.supported() ? navigator.serial.getPorts() : []; }
    async requestPort() { return navigator.serial.requestPort({}); }
    async open(port, opts) {
      await this.close();
      this.port = port;
      await port.open({ baudRate: Number(opts.baudRate), dataBits: Number(opts.dataBits || 8), stopBits: Number(opts.stopBits || 1), parity: opts.parity || 'none', flowControl: 'none', bufferSize: 4096 });
      try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch { /* not all drivers */ }
      this.writer = port.writable.getWriter();
      this.connected = true; this._closing = false;
      this.emit('open');
      this._readLoop();
    }
    async _readLoop() {
      while (this.port && this.port.readable && !this._closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) { const { value, done } = await this.reader.read(); if (done) break; if (value && value.length) this.emit('data', value); }
        } catch (e) { if (!this._closing) this.emit('error', e); }
        finally { try { this.reader.releaseLock(); } catch { } }
        if (!this._closing) { await sleep(50); if (!this.port || !this.port.readable) break; }
      }
      if (!this._closing) { this.connected = false; this.emit('close', 'lost'); }
    }
    async write(bytes) { if (!this.writer) throw new Error('Port not open'); await this.writer.write(bytes); }
    async close() {
      if (!this.port) return;
      this._closing = true;
      try { if (this.reader) await this.reader.cancel(); } catch { }
      try { if (this.writer) this.writer.releaseLock(); } catch { }
      try { await this.port.close(); } catch { }
      const was = this.connected;
      this.port = null; this.reader = null; this.writer = null; this.connected = false;
      if (was) this.emit('close', 'user');
    }
  }

  // ================================================================ BridgeLink
  /** COM port opened by the local server (serial-bridge.ps1) – no browser port picker needed */
  class BridgeLink extends Emitter {
    constructor() { super(); this.connected = false; this.port = null; this.es = null; this._w = Promise.resolve(); }
    static async list() {
      const r = await fetch('/api/serial/ports', { cache: 'no-store' });
      if (!r.ok) throw new Error('Server could not list COM ports');
      return r.json();
    }
    _stream() {
      if (this.es) return;
      this.es = new EventSource('/api/serial/stream');
      this.es.addEventListener('data', e => {
        if (!this.connected) return;
        const hex = JSON.parse(e.data);
        this.emit('data', Uint8Array.from(hex.split('-'), h => parseInt(h, 16)));
      });
      this.es.addEventListener('close', e => {
        const d = JSON.parse(e.data);
        if (this.connected && d.reason !== 'reopen' && d.reason !== 'user') {
          this.connected = false;
          if (d.error) this.emit('error', new Error(d.error));
          this.emit('close', 'lost');
        }
      });
    }
    async open(path, opts) {
      this._stream();
      const r = await fetch('/api/serial/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, ...opts }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not open ' + path);
      this.port = path; this.connected = true; this.emit('open');
    }
    write(bytes) {
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('-');
      const p = this._w.then(() => fetch('/api/serial/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex }) }))
        .then(r => { if (!r.ok) throw new Error('Write failed'); });
      this._w = p.catch(() => { });
      return p;
    }
    async close() {
      if (!this.connected) return;
      this.connected = false;
      await fetch('/api/serial/close', { method: 'POST' }).catch(() => { });
      this.emit('close', 'user');
    }
  }

  // ================================================================ SerialSwitch
  /** One "serial" object for the JSD client; routes to the server bridge or to Web Serial */
  class SerialSwitch extends Emitter {
    constructor() {
      super();
      this.web = new SerialLink(); this.bridge = new BridgeLink(); this.active = null;
      for (const b of [this.web, this.bridge]) {
        for (const ev of ['data', 'close', 'error', 'open']) b.on(ev, (...a) => { if (b === this.active) this.emit(ev, ...a); });
      }
    }
    get connected() { return !!(this.active && this.active.connected); }
    get kind() { return this.active === this.bridge ? 'bridge' : this.active === this.web ? 'web' : null; }
    async open(kind, target, opts) {
      await this.close();
      this.active = kind === 'bridge' ? this.bridge : this.web;
      try { await this.active.open(target, opts); }
      catch (e) { this.active = null; throw e; }
    }
    write(bytes) { if (!this.active) return Promise.reject(new Error('Port not open')); return this.active.write(bytes); }
    async close() { if (this.active) await this.active.close(); }
  }

  // ================================================================ dictionaries (SP208M10N001EN)
  const ST204 = { 0: 'received', 1: 'in progress', 2: 'waiting for collection', 3: 'product collected', 4: 'not performed', 5: 'token not found', 6: 'JSD queue full', 7: 'channel not connected', 8: 'selection not available', 9: 'failed dispensing from channel', 10: 'collection time exceeded', 11: 'product in elevator', 12: 'eliminated', 13: 'product expired', 14: 'undetermined error' };
  const EXT = { 1: 'Machine door is open', 2: 'Machine not available', 3: 'Product detector (photosensor) error', 4: 'Lane motor fault (motor current)', 5: 'Lane flagged sold-out – not run', 6: 'Elevator product-detector tester error', 7: 'No product detected (lane empty)', 8: 'Elevator cannot reach the tray', 9: 'Elevator could not reach collection position', 10: 'Machine reset during dispense', 11: 'Communication error with the machine', 12: 'Communication lost during dispense', 13: 'Selection is not Vision', 14: 'Perishable product expired', 15: 'Product already in the elevator', 20: 'Elevator did not fully reach collection position' };
  const AVAIL = { 0: 'Free', 1: 'Busy', 2: 'Dispensing', 3: 'Product in hatch', 4: 'Elevator at collection', 5: 'Product detector blocked' };
  const QSTATE = { 1: 'Elevator at rest', 2: 'At rest – product detected', 3: 'Moving to collection', 4: 'Door opening', 5: 'Door open – waiting', 6: 'Door open – product taken', 7: 'Door closing', 8: 'Elevator → tray', 9: 'Extractor running', 10: 'Elevator → rest', 11: 'Out of service', 12: 'Out of service – product', 13: 'Waiting order (pick-up)', 14: 'Waiting order (storage)' };
  const EVENTS = { 1: 'Product detector', 2: 'No lane motors connected', 3: 'Lane jam detector', 4: 'Temperature control', 5: 'Elevator faulty', 6: 'Elevator position photosensor', 7: 'Elevator tester (flap)', 8: 'Product expired', 9: 'Not available', 10: 'Collection door', 11: 'Collection door safety detector', 12: 'Elevator/door motor power', 13: 'Elevator card motor power', 14: 'Elevator shutter lock motor', 15: 'Elevator blind', 16: 'Cooling fan 1', 17: 'Cooling fan 2', 18: 'Lower product detectors', 19: 'Upper product detectors', 20: 'Elevator card error', 21: 'Elevator encoder', 22: 'Low motor voltage', 23: 'Delivery phototransistor stuck on', 24: 'Standby phototransistor stuck on', 25: 'Delivery phototransistor not detecting' };
  const ERR_OPS = { 200: 'JSD reported a command format error', 300: 'JSD licence blocked', 301: 'JSD has no licence for this application', 302: 'Direct dispensing not allowed (JSD price control active)', 303: 'JSD is not licensed for this Qendra machine' };
  const R211 = { 1: 'wrong machine number', 2: 'machine not connected', 3: 'wrong machine model', 4: 'machine cannot perform the manoeuvre', 5: 'communication error' };

  function parse204(f) {
    const rest = f.slice(2);
    const chan = rest.find(x => /^\d+\.\d+\.\d+$/.test(x)) || '';
    const nums = rest.filter(x => x !== chan && /^\d+$/.test(x));
    return { token: f[0], st: Number(f[1]), chan, ext: nums.length ? Number(nums[nums.length - 1]) : null };
  }

  // ================================================================ Jsd
  class Jsd extends Emitter {
    constructor(serial) {
      super();
      this.serial = serial;
      this.link = new JLink(serial);
      this.simDev = null; this.simKey = null;
      this.cfg = null; this.abort = false;
      this.waiters = new Set();
      this.token = 1000 + Math.floor(Math.random() * 80000);
      this.m = this._blank();
      this.info = { jsdFw: '', model: '', serial: '', fw: '' };
      this.hb = { timer: null, misses: 0, state: 'off', inFlight: false };
      this.link.on('message', msg => this._onMsg(msg));
      this.link.on('tx', t => this.emit('tx', t));
      this.link.on('warn', w => this.emit('log', 'warn', w));
      serial.on('data', b => this.emit('raw', b));
    }
    _blank() { return { comm: null, service: null, door: null, avail: null, light: null, temp: '', q: null, qSeen: false, faults: new Set(), faultsSeen: false, trays: null, prod: null, at: 0 }; }

    setConfig(cfg) {
      this.cfg = cfg;
      const key = cfg.machine.simulator ? `${cfg.machine.simModel}|${cfg.machine.simFailRate}` : null;
      if (key === this.simKey) return;
      if (this.simDev) this.simDev.flush();
      this.simDev = null; this.simKey = key;
      this.m = this._blank(); this.info = { jsdFw: '', model: '', serial: '', fw: '' };
      if (key) {
        this.simDev = new SimJsd(cfg.machine.simModel, Number(cfg.machine.simFailRate) || 0);
        this.simDev.on('message', msg => this._onMsg(msg));
        this.simDev.on('tx', t => this.emit('tx', t));
      }
      this.emit('state');
    }
    get sim() { return !!this.simDev; }
    get ready() { return this.sim || this.serial.connected; }
    get mn() { return String(this.cfg.jconnect.machineNumber || 0); }
    nextToken() { this.token = this.token >= 99999 ? 1000 : this.token + 1; return String(this.token); }

    send(op, text = '') {
      if (!this.ready) return Promise.reject(new Error('Not connected'));
      return (this.sim ? this.simDev : this.link).sendApp(op, String(text));
    }

    /** resolve with the first message for which handler returns !== undefined */
    until(handler, ms, opts = {}) {
      let finish;
      const p = new Promise(resolve => {
        let done = false, last = Date.now();
        const end = v => { if (done) return; done = true; clearTimeout(to); clearInterval(iv); this.off('rx', on); resolve(v); };
        const on = msg => { if (opts.activity && opts.activity(msg)) last = Date.now(); const v = handler(msg); if (v !== undefined) end(v); };
        this.on('rx', on);
        const to = setTimeout(() => end({ timeout: true }), ms);
        const iv = setInterval(() => {
          if (this.abort && !opts.ignoreAbort) end({ aborted: true });
          else if (opts.check) { const v = opts.check(); if (v !== undefined) end(v); }
          if (opts.onIdle && Date.now() - last > opts.idleMs) { last = Date.now(); opts.onIdle(); }
        }, 150);
        finish = end;
      });
      p.cancel = v => finish(v || { cancelled: true });
      return p;
    }
    waitState(pred, ms, opts = {}) {
      if (pred()) return Promise.resolve(true);
      return this.until(() => pred() ? true : undefined, ms, { ...opts, check: () => pred() ? true : undefined });
    }

    async request(op, text, respOp, match, ms = 3000) {
      const w = this.until(msg => ((msg.op === respOp && (!match || match(msg))) || (ERR_OPS[msg.op] && msg.f[0] === String(op))) ? msg : undefined, ms, { ignoreAbort: true });
      try { await this.send(op, text); } catch (e) { w.cancel(); return { ok: false, error: e.message }; }
      const msg = await w;
      if (!msg || msg.timeout || msg.cancelled) return { ok: false, error: `No answer from JSD to Op ${op} (${OPS[op] || ''})` };
      if (ERR_OPS[msg.op]) return { ok: false, error: ERR_OPS[msg.op], msg, fatal: msg.op >= 300 };
      return { ok: true, msg };
    }
    mine(op) { return msg => msg.op === op && msg.f[0] === this.mn; }

    _onMsg(msg) {
      const f = msg.f, mine = f[0] === this.mn, m = this.m;
      switch (msg.op) {
        case 201: if (mine) { m.comm = +f[1]; m.service = +f[2]; m.door = +f[3]; m.avail = +f[4]; m.light = +f[5]; if (f[6]) m.temp = f[6]; m.at = Date.now(); } break;
        case 207: if (mine) { this.info.model = f[1] || ''; this.info.serial = f[2] || ''; this.info.fw = f.slice(3).join(' '); } break;
        case 208: if (mine && f[3]) m.temp = f[3]; break;
        case 209: if (mine) {
          const ev = +f[1], on = f[2] === '1';
          if (on) m.faults.add(ev); else m.faults.delete(ev);
          this.emit('log', on ? 'err' : 'info', `Machine event ${ev} – ${EVENTS[ev] || 'unknown'}: ${on ? 'ACTIVE' : 'cleared'}`);
        } break;
        case 214: this.info.jsdFw = [f[0], f[3]].filter(Boolean).join(' · '); this.info.jsdName = f[0] || ''; this.info.jsdBuild = f[1] || ''; this.info.jsdDate = f[2] || ''; break;
        case 219: if (mine) { m.faults = new Set(f.slice(1).map(Number).filter(Boolean)); m.faultsSeen = true; } break;
        case 222: if (mine) m.trays = f.slice(1); break;
        case 223: if (mine) m.prod = +f[1]; break;
        case 204: if (f[0] === this.curTok) this.tokSt = +f[1]; break;
        case 225: if (mine) { m.q = +f[1]; m.qSeen = true; if ([1, 3, 8, 9, 10, 11].includes(m.q)) m.prod = 0; else if ([2, 12].includes(m.q)) m.prod = 1; } break;
        case 200: case 300: case 301: case 302: case 303: this.emit('log', 'err', `${ERR_OPS[msg.op]} – ${msg.text}`); break;
      }
      this.emit('rx', msg);
      this.emit('state');
    }

    qendraFor(unitCode) {
      const p = (this.cfg.products || []).find(x => x.code === unitCode);
      const t = p && p.machineType;
      if (t === 'qendra') return true;
      if (t === 'esplus') return false;
      return /QEN/i.test(this.info.model);
    }

    // ---------------------------------------------------------- connect-time initialisation
    async init() {
      this.m = this._blank();
      const J = this.cfg.jconnect, mn = this.mn;
      const fw = await this.request(110, '', 214);
      if (!fw.ok) { this.emit('log', 'err', 'JSD did not answer the firmware request: ' + fw.error); return { ok: false, error: fw.error }; }
      await this.request(105, mn, 207, this.mine(207));
      await this.request(100, mn, 201, this.mine(201));
      if (J.enableExtended204) await this.request(116, '1', 221);
      const qendra = /QEN/i.test(this.info.model) || (this.cfg.products || []).some(p => p.machineType === 'qendra');
      if (qendra && J.qendraTracking) {
        const q = await this.request(118, '', 224);
        const d1 = q.ok && q.msg.f[0] !== '' ? q.msg.f[0] : '0';
        await this.request(118, `${d1},1`, 224);
      }
      await this.request(115, mn, 219, this.mine(219));
      this.emit('log', 'info', `JSD ${this.info.jsdFw || '?'} · machine ${mn}: ${this.info.model || 'unknown model'} ${this.info.serial ? 'S/N ' + this.info.serial : ''}`);
      this.emit('state');
      return { ok: true };
    }

    // ---------------------------------------------------------- heartbeat (Op 100 -> 201)
    startHeartbeat() {
      this.stopHeartbeat();
      const every = Math.max(1000, Number(this.cfg.timing.heartbeatMs) || 5000);
      this.hb.misses = 0; this._hbState('wait');
      this.hb.timer = setInterval(() => this._beat(), every);
      this._beat();
    }
    stopHeartbeat() { clearInterval(this.hb.timer); this.hb.timer = null; this._hbState('off'); }
    async _beat() {
      if (!this.ready || this.hb.inFlight) return;
      this.hb.inFlight = true;
      const r = await this.request(100, this.mn, 201, this.mine(201), 2500);
      this.hb.inFlight = false;
      if (!this.hb.timer) return;
      if (r.ok) { this.hb.misses = 0; this._hbState('ok'); }
      else { this.hb.misses++; this._hbState(this.hb.misses >= (Number(this.cfg.timing.heartbeatMissLimit) || 3) ? 'lost' : 'warn'); }
    }
    _hbState(s) { this.hb.state = s; this.emit('heartbeat', s, this.hb); }

    // ---------------------------------------------------------- pre-flight
    async preflight() {
      const mn = this.mn, J = this.cfg.jconnect;
      const st = await this.request(100, mn, 201, this.mine(201));
      if (!st.ok) return { ok: false, error: st.error };
      const m = this.m;
      if (m.comm !== 1) return { ok: false, error: m.comm === 2 ? 'The JSD lost communication with the machine.' : `Machine ${mn} is not connected to the JSD.` };
      if (m.door !== 1) return { ok: false, error: 'The machine door is open. Close the door and try again.' };
      if (m.service !== 1) return { ok: false, error: 'The machine is out of service (fault). Use "Reset faults" or check the machine display.' };
      if (m.avail === 3 || m.avail === 5) return { ok: false, error: 'There is a product in the hatch / elevator. Remove it first.' };
      if (m.avail !== 0) {
        this.emit('log', 'info', `Machine busy (${AVAIL[m.avail] || m.avail}) – waiting…`);
        const ok = await this.waitState(() => this.m.avail === 0, 60000);
        if (ok !== true) return { ok: false, error: `Machine is not free (${AVAIL[this.m.avail] || this.m.avail}).` };
      }
      if (J.resetSoldOut) {
        const r = await this.request(108, mn, 212, this.mine(212));
        if (!r.ok || r.msg.f[1] !== '0') this.emit('log', 'warn', 'Could not reset sold-out flags: ' + (r.error || r.msg.text));
      }
      return { ok: true };
    }

    // ---------------------------------------------------------- lane scan (Op 101 -> 202)
    async scan(onProgress, opts = {}) {
      const J = this.cfg.jconnect, mn = this.mn;
      const first = Number(J.firstTray) || 11, last = Number(J.lastTray) || 18, maxCh = Number(J.maxChannels) || 10;
      const total = (last - first + 1) * maxCh;
      const out = []; let n = 0, misses = 0;
      if (opts.redetect) {
        // The machine only re-detects its lane motors during its self-check (door closed / Op 153 auto test).
        // Without it the JSD keeps reporting a lane that was unplugged as connected.
        await this.request(100, mn, 201, this.mine(201), 2000);
        const busy = this.m.avail != null && this.m.avail !== 0;
        if (busy) this.emit('log', 'warn', 'Lane re-detect skipped: the machine is busy – scanning with the last detected lanes');
        else {
          opts.onStage && opts.onStage('Machine self-check (re-detecting lanes)…');
          this.emit('log', 'info', 'Lane re-detect: machine self-check (Op 153)');
          const selfCheck = this.until(msg => msg.op === 222 && msg.f[0] === mn ? true : undefined, 25000);
          const r = await this.request(153, mn, 201, this.mine(201), 8000);
          if (!r.ok) { selfCheck.cancel(); this.emit('log', 'warn', 'Self-check not started: ' + r.error); }
          else {
            const done = await selfCheck;
            if (done && done.aborted) return { aborted: true, lanes: out };
            await this.waitState(() => this.m.avail === 0, 20000);
            await sleep(500);
          }
        }
      }
      const ts = await this.request(117, mn, 222, this.mine(222), 2000);
      const sensors = ts.ok ? ts.msg.f.slice(1) : null;
      for (let tray = first; tray <= last; tray++) {
        for (let ch = 0; ch < maxCh; ch++) {
          if (this.abort) return { aborted: true, lanes: out, sensors };
          const r = await this.request(101, `${mn},${tray},${ch}`, 202, msg => msg.f[0] === mn && msg.f[1] === String(tray) && msg.f[2] === String(ch), 1500);
          n++; onProgress && onProgress(n, total, tray, ch);
          if (!r.ok) { misses++; if (misses >= 6 && out.every(l => l.status == null)) return { error: 'The JSD is not answering channel-status requests.', lanes: out, sensors }; out.push({ tray, ch, status: null }); continue; }
          out.push({ tray, ch, status: Number(r.msg.f[3]) });
        }
      }
      return { lanes: out, sensors };
    }

    // ---------------------------------------------------------- lane test
    /**
     * Elevator → lane, run lane (Op 150), elevator → hatch, hatch opens, waits, closes, elevator → rest.
     * hooks: step(id), detail(text), prompt(text|null)
     */
    async testLane(lane, unitCode, H = {}) {
      // poll machine status (Op 100) every second while a lane runs, so steps and sensor LEDs follow the machine live
      const fast = setInterval(() => this._poll(), Math.max(500, Number(this.cfg.timing.testPollMs) || 1000));
      try { return await (H.mode === 'basic' ? this._testLaneBasic(lane, unitCode, H) : this._testLane(lane, unitCode, H)); }
      finally { clearInterval(fast); this.curTok = null; }
    }
    async _poll() {
      if (!this.ready || this.hb.inFlight) return;
      this.hb.inFlight = true;
      try { await this.request(100, this.mn, 201, this.mine(201), 1500); } finally { this.hb.inFlight = false; }
    }
    /** Qendra: product left in the elevator (state 2/13) or door open: present it, let the tester take it, close, go home */
    async _clearElevator(prompt = () => { }, why = '', timed = false) {
      const mn = this.mn, T = this.cfg.timing, m = () => this.m;
      if (!m().qSeen) return true;
      if ([2, 13].includes(m().q)) {
        this.emit('log', 'info', `${why}Product in the elevator - sending it to the hatch (Op 158)`);
        await this.request(158, mn, 227, this.mine(227));
        await this.waitState(() => [5, 6].includes(m().q), Number(T.hatchTimeoutMs) || 30000, { ignoreAbort: true });
      }
      if (timed && [5, 6].includes(m().q)) await this._wait(Number(T.basicHatchOpenMs) || 2000);
      else if (m().q === 5) {
        prompt('Take the product out of the hatch');
        await this.waitState(() => m().q !== 5, Number(T.collectTimeoutMs) || 120000, { ignoreAbort: true });
        prompt(null);
      }
      if ([4, 5, 6].includes(m().q)) await this.request(157, mn, 226, this.mine(226));
      const ok = await this.waitState(() => m().q === 1 || (timed && m().q === 2), Number(T.homeTimeoutMs) || 40000, { ignoreAbort: true });
      return ok === true;
    }

    /**
     * BASIC test – time based, motors only. Every optical / product sensor result is ignored:
     *  run lane (Op 150) and hold it for basicRunMs → elevator to hatch (Op 158) → hatch open basicHatchOpenMs → close (Op 157) → home.
     * Only "the mechanism did not move" fails it: lane motor not connected / motor current, elevator cannot reach the tray,
     * machine door open, no answer from the JSD, or the elevator / hatch never reaching its position.
     */
    async _testLaneBasic(lane, unitCode, H = {}) {
      const step = H.step || (() => { }), detail = H.detail || (() => { }), prompt = H.prompt || (() => { });
      const C = this.cfg, J = C.jconnect, T = C.timing, mn = this.mn;
      const qendra = this.qendraFor(unitCode);
      const prod = (C.products || []).find(p => p.code === unitCode) || {};
      const speed = prod.speed !== undefined && prod.speed !== '' ? prod.speed : J.speed;
      const runMs = Math.max(500, Number(T.basicRunMs) || 3000);
      const openMs = Math.max(500, Number(T.basicHatchOpenMs) || 2000);
      const travelMs = Math.max(2000, Number(T.basicTravelMs) || 8000);       // used when the JSD gives no precise state (no tracking)
      const moveMs = Number(T.hatchTimeoutMs) || 30000, homeMs = Number(T.homeTimeoutMs) || 40000;
      const closeMs = Math.max(5000, Number(T.basicCloseWaitMs) || 60000);   // how long to keep retrying the hatch close
      const tok = this.nextToken(), t0 = Date.now();
      this.curTok = tok; this.tokSt = null;
      let cur = 'move';
      const st = id => { cur = id; step(id); };
      const q = () => this.m.qSeen ? this.m.q : null;
      const track = () => this.m.qSeen;
      const stateTxt = () => QSTATE[q()] || AVAIL[this.m.avail] || '?';
      const fail = async (error, extra = {}) => {
        if (qendra && [4, 5, 6].includes(q())) await this.request(157, mn, 226, this.mine(226));
        return { status: 'fail', step: extra.step || cur, error, ms: Date.now() - t0, token: tok, ...extra };
      };
      const stopped = async () => { await this._recover(qendra, true); return { status: 'stopped', step: cur, ms: Date.now() - t0 }; };

      // elevator must be home before a new lane, otherwise the JSD holds the request
      if (qendra && track() && q() !== 1) {
        detail('Basic: bringing the elevator home first');
        if (![2, 13, 4, 5, 6].includes(q())) await this.waitState(() => [1, 2, 13, 5, 6].includes(q()), homeMs);
        if (this.abort) return stopped();
        // Basic is unattended: never wait for a person – present / close the hatch by itself and carry on
        if (![1, 2].includes(q())) {
          if (q() === 13 || q() === 2) await this.request(158, mn, 227, this.mine(227));
          await this.waitState(() => [1, 2, 5, 6].includes(q()), moveMs);
          if (!(await this._closeHatchAuto(closeMs, detail)) && !this.abort) return fail(`Elevator is not home before the lane started – hatch held open (state: ${stateTxt()})`, { step: 'move' });
        }
        if (this.abort) return stopped();
      }

      // ---- 1. elevator → lane, run lane (time based)
      st('move'); detail('Basic: elevator → lane');
      let motorAt = 0, hard = null, finished = false;
      const watch = this.until(msg => {
        if (msg.op === 225 && msg.f[0] === mn) {
          const s = +msg.f[1];
          if (s === 9) { motorAt = motorAt || Date.now(); }
          if (motorAt && [10, 13, 1, 2, 3].includes(s)) finished = true;
          return;
        }
        if (ERR_OPS[msg.op] && msg.f[0] === '150') { hard = { error: ERR_OPS[msg.op], fatal: true, step: 'move' }; return true; }
        if (msg.op !== 204 || msg.f[0] !== tok) return;
        const p = parse204(msg.f);
        if (p.st === 1) motorAt = motorAt || Date.now();
        if (p.st === 7) { hard = { error: 'Lane not connected – no motor detected', step: 'motor' }; return true; }
        if ([4, 9].includes(p.st) && p.ext === 4) { hard = { error: EXT[4], step: 'motor' }; return true; }
        if ([4, 9].includes(p.st) && p.ext === 8) { hard = { error: EXT[8], step: 'move' }; return true; }
        if ([4, 9].includes(p.st) && p.ext === 1) { hard = { error: 'Machine door is open', fatal: true, step: 'move' }; return true; }
        if ([4, 9].includes(p.st) && [11, 12].includes(p.ext)) { hard = { error: EXT[p.ext], step: cur }; return true; }
        if ([2, 3, 4, 10, 11].includes(p.st)) finished = true;          // product / no product: ignored in Basic
      }, Number(T.dispenseTimeoutMs) || 90000);
      try { await this.send(150, `${tok},${mn},${lane.row},${lane.col},${speed},0`); }
      catch (e) { watch.cancel(); return fail('Command not acknowledged: ' + e.message); }

      // wait for the motor to start (or the run time when the JSD reports no motion state), then hold runMs
      const started = await this.waitState(() => !!motorAt || !!hard || finished, moveMs);
      if (started && started.aborted) { watch.cancel(); return stopped(); }
      if (hard) { watch.cancel(); return fail(hard.error, hard); }
      st('motor');
      const runFrom = motorAt || Date.now();
      detail(`Basic: lane running ${(runMs / 1000).toFixed(0)} s`);
      await this._wait(runFrom + runMs - Date.now());
      if (this.abort) { watch.cancel(); return stopped(); }
      if (hard) { watch.cancel(); return fail(hard.error, hard); }

      if (!qendra) {
        // ES-Plus: no motorised door – collection cycle (Op 154) then wait
        watch.cancel();
        st('hatchPos');
        await this.waitState(() => this.m.avail === 0 || this.m.avail === 3 || this.m.avail === 4, homeMs);
        if (this.m.avail === 0) await this.request(154, mn, 211, this.mine(211));
        st('hatch'); await this._wait(openMs);
        st('home'); st('done');
        return { status: 'pass', ms: Date.now() - t0, token: tok, note: 'Basic: motors ran (time based)' };
      }

      // ---- 2. elevator → hatch. Let the machine end its lane run first (it decides when the lane stops).
      st('hatchPos'); detail('Basic: lane time done – waiting for the machine to stop the lane, then elevator → hatch');
      const ended = await this.waitState(() => !!hard || finished || (track() ? [1, 2, 13, 3, 4, 5, 6].includes(q()) : this.m.avail !== 2 && Date.now() - runFrom > travelMs), Number(T.dispenseTimeoutMs) || 90000);
      watch.cancel();
      if (ended && ended.aborted) return stopped();
      if (hard) return fail(hard.error, hard);
      if (ended !== true) return fail(`Lane run did not end (state: ${stateTxt()})`, { step: 'motor' });
      if (track()) {
        if (![3, 4, 5, 6].includes(q())) {
          await this.waitState(() => [1, 2, 13].includes(q()), homeMs);
          const r = await this.request(158, mn, 227, this.mine(227));
          if (!r.ok) return fail('Send to pick-up: ' + r.error, { fatal: r.fatal });
          if (r.msg.f[1] !== '0' && ![3, 4, 5, 6].includes(q())) return fail(`Machine refused to go to pick-up (state: ${stateTxt()})`);
        }
        const open = await this.waitState(() => [5, 6].includes(q()), moveMs);
        if (open !== true) return open.aborted ? stopped() : fail(`Hatch did not open (state: ${stateTxt()})`);
      } else {
        await this.waitState(() => this.m.avail === 0, homeMs);
        const r = await this.request(158, mn, 227, this.mine(227));
        if (!r.ok) return fail('Send to pick-up: ' + r.error, { fatal: r.fatal });
        await this._wait(travelMs);
      }

      // ---- 3. hatch open → close after basicHatchOpenMs, no product check
      st('hatch'); detail(`Basic: hatch open ${(openMs / 1000).toFixed(0)} s`);
      await this._wait(openMs);
      if (this.abort) return stopped();
      st('home'); detail('Basic: closing hatch, elevator → home');
      let held = false;
      if (track()) {
        // Op 157 straight away – no product check; repeated while the door is still open (no person needed)
        const t1 = Date.now();
        const closed = await this._closeHatchAuto(closeMs, detail);
        if (this.abort) return stopped();
        held = Date.now() - t1 > 8000;
        if (!closed) {
          // motors all ran; only the product sensor keeps the door open → Basic ignores it and moves on (next lane retries the close)
          if (q() === 5 || q() === 6) { st('done'); return { status: 'pass', ms: Date.now() - t0, token: tok, note: 'Basic: lane, elevator and hatch moved – hatch kept open by the product sensor (product in the hatch?)' }; }
          const home = await this.waitState(() => [1, 2].includes(q()), homeMs);
          if (home !== true) return home.aborted ? stopped() : fail(`Hatch did not close / elevator did not return home (state: ${stateTxt()})`);
        }
      } else {
        const c = await this.request(157, mn, 226, this.mine(226));
        if (!c.ok) return fail('Close hatch: ' + c.error);
        await this._wait(travelMs);
      }
      st('done');
      return { status: 'pass', ms: Date.now() - t0, token: tok, note: 'Basic: lane, elevator and hatch moved (time based)' + (held ? ' – hatch was held open by the product sensor for a while' : '') };
    }

    async _testLane(lane, unitCode, H = {}) {
      const step = H.step || (() => { }), detail = H.detail || (() => { }), prompt = H.prompt || (() => { });
      this._prompt = prompt;
      const C = this.cfg, J = C.jconnect, T = C.timing, mn = this.mn;
      const qendra = this.qendraFor(unitCode);
      const prod = (C.products || []).find(p => p.code === unitCode) || {};
      const speed = prod.speed !== undefined && prod.speed !== '' ? prod.speed : J.speed;
      const post = Math.max(0, Math.round((Number(J.postRunMs) || 0) / 100));
      const tok = this.nextToken(), t0 = Date.now();
      this.curTok = tok; this.tokSt = null;
      let cur = 'move', motorAt = 0;
      const st = id => { cur = id; step(id); };
      const fail = async (error, extra = {}) => { await this._recover(qendra); return { status: 'fail', step: extra.step || cur, error, ms: Date.now() - t0, token: tok, ...extra }; };
      const stopped = async () => { await this._recover(qendra, true); return { status: 'stopped', step: cur, ms: Date.now() - t0 }; };

      // ---- 0. Qendra: elevator must be at rest and empty, otherwise the JSD queues the request and never starts it
      if (qendra && this.m.qSeen && this.m.q !== 1) {
        detail('Waiting for the elevator to be at rest...');
        if (![2, 13, 4, 5, 6].includes(this.m.q)) await this.waitState(() => [1, 2, 13, 5].includes(this.m.q), Number(T.homeTimeoutMs) || 40000);
        if (this.abort) return stopped();
        if (this.m.q !== 1 && !(await this._clearElevator(prompt, 'Before lane: '))) return fail('Elevator is not at rest / not empty before the lane started', { step: 'move' });
      }

      // ---- 1+2. dispense: elevator to tray, run lane
      st('move');
      let failExt = null;
      const outcome = this.until(msg => {
        if (msg.op === 225 && msg.f[0] === mn) {
          const s = +msg.f[1]; if (s === 8) st('move'); if (s === 9) { st('motor'); motorAt = motorAt || Date.now(); } detail(QSTATE[s] || '');
          if (s === 13) return { type: 'dispensed', st: 13, ext: 0 };   // product in elevator, waiting for the order to go to pick-up
          return;
        }
        if (ERR_OPS[msg.op] && (msg.f[0] === '150')) return { type: 'licence', op: msg.op };
        if (msg.op !== 204 || msg.f[0] !== tok) return;
        const p = parse204(msg.f);
        detail(`Dispense: ${ST204[p.st] || p.st}${p.ext ? ' – ' + (EXT[p.ext] || 'code ' + p.ext) : ''}`);
        if (p.st === 1) { st('motor'); if (!this.m.qSeen) motorAt = motorAt || Date.now(); return; }
        if ([2, 3, 10, 11].includes(p.st)) return { type: 'dispensed', st: p.st, ext: p.ext };
        if (p.st === 9) { failExt = p.ext; return; }
        if (p.st === 4) return { type: 'notdone', ext: p.ext != null && p.ext !== 0 ? p.ext : failExt };
        if ([5, 6, 7, 8, 12, 13, 14].includes(p.st)) return { type: 'error', st: p.st, ext: p.ext };
      }, Number(T.dispenseTimeoutMs) || 90000, {
        activity: msg => msg.op === 204 || msg.op === 225 || msg.op === 201,
        idleMs: 20000, onIdle: () => { this.emit('log', 'warn', `No news for token ${tok} – asking the JSD`); this.send(150, tok).catch(() => { }); }
      });
      try { await this.send(150, `${tok},${mn},${lane.row},${lane.col},${speed},${post}`); }
      catch (e) { outcome.cancel(); return fail('Command not acknowledged: ' + e.message); }
      const o = await outcome;
      if (o.aborted) return stopped();
      if (o.timeout) return fail('No dispense result from the JSD (timeout)');
      if (o.type === 'licence') return fail(ERR_OPS[o.op], { fatal: true });
      if (o.type === 'error') {
        if (o.st === 7) return fail('Lane not connected – no motor detected', { step: 'motor' });
        return fail(`Dispense ${ST204[o.st] || o.st}${o.ext ? ' – ' + (EXT[o.ext] || o.ext) : ''}`);
      }
      let dispensed = o.type === 'dispensed';
      if (o.type === 'notdone') {
        const ext = o.ext;
        if (ext === 7 && J.emptyLanePass) { detail('Lane empty – motor ran, no product detected'); }
        else if (ext === 1) return fail('Machine door is open', { fatal: true });
        else return fail(ext ? (EXT[ext] || `Error code ${ext}`) : 'Dispense not performed', { step: ext === 8 ? 'move' : 'motor' });
      }
      const collectedAlready = dispensed && (o.st === 3 || o.st === 10);

      // ---- 3+4+5. hatch
      const hatchMs = Number(T.hatchTimeoutMs) || 30000, homeMs = Number(T.homeTimeoutMs) || 30000;
      st('hatchPos');
      if (qendra) {
        const q = () => this.m.qSeen ? this.m.q : null;
        const restQ = () => this.m.qSeen ? this.m.q === 1 || (this.m.q === 2 && !dispensed) : this.m.avail === 0;
        // hatch open: precise state 5/6, or (no tracking) the dispense report "waiting for product to be collected"
        const openQ = () => this.m.qSeen ? [5, 6].includes(this.m.q) : this.tokSt === 2 || this.m.avail === 3 || this.m.avail === 4;
        const collectedQ = () => [3, 10].includes(this.tokSt) || (this.m.qSeen && [6, 7, 10, 1].includes(this.m.q));
        const stateTxt = () => QSTATE[q()] || AVAIL[this.m.avail] || '?';
        let sent158 = false;
        const to158 = async () => {
          sent158 = true;
          const r = await this.request(158, mn, 227, this.mine(227));
          if (!r.ok) return 'Send to pick-up: ' + r.error;
          if (r.msg.f[1] !== '0' && !openQ() && ![3, 4].includes(q())) return `Machine refused to go to pick-up (state: ${stateTxt()})`;
          return null;
        };
        if (!dispensed || collectedAlready) {
          // empty lane: wait until the elevator is back at rest, then send it to pick-up (door opens without product)
          const atRest = await this.waitState(() => restQ() || q() === 13 || openQ(), homeMs);
          if (atRest !== true) return atRest.aborted ? stopped() : fail(`Elevator did not return to rest after the lane run (state: ${stateTxt()})`);
        }
        if (!openQ() && (!dispensed || collectedAlready || q() === 13 || q() === 2)) {
          const e = await to158(); if (e) return fail(e);
        }
        // wait for the door to open; if the machine parks the product waiting for an order (13 / 2), send Op 158
        const open = await this.waitState(() => {
          if (!sent158 && [2, 13].includes(q())) to158();
          return openQ();
        }, hatchMs);
        if (open !== true) return open.aborted ? stopped() : fail(`Hatch did not open (state: ${stateTxt()})`);
        st('hatch');
        detail('Hatch open');
        await this._wait(Number(T.hatchOpenMs) || 3000);
        if (this.abort) return stopped();
        if (dispensed && !collectedAlready && !collectedQ() && (q() === 5 || (!this.m.qSeen && this.tokSt === 2))) {
          prompt('Take the product out of the hatch');
          const got = await this.waitState(collectedQ, Number(T.collectTimeoutMs) || 120000);
          prompt(null);
          if (got !== true) return got.aborted ? stopped() : fail('Product was not taken from the hatch');
        }
        st('home');
        if (!restQ() && ![7, 10].includes(q())) {
          const r = await this.request(157, mn, 226, this.mine(226));
          if (!r.ok) return fail('Close hatch: ' + r.error);
          if (r.msg.f[1] !== '0' && this.m.qSeen && ![7, 10, 1, 2].includes(q())) return fail(`Machine refused to close the hatch (state: ${stateTxt()})`);
        }
        const home = await this.waitState(() => this.m.qSeen ? this.m.q === 1 || this.m.q === 2 : this.m.avail === 0, homeMs);
        if (home !== true) return home.aborted ? stopped() : fail(`Hatch did not close / elevator did not return to rest (state: ${stateTxt()})`);
      } else {
        // ES-Plus: passive flap; Op 154 sends the elevator to the collection position
        if (dispensed && !collectedAlready) {
          st('hatch');
          prompt('Take the product out of the hatch');
          const got = this.until(msg => (msg.op === 204 && msg.f[0] === tok && ['3', '10'].includes(msg.f[1])) ? msg.f[1] : undefined, Number(T.collectTimeoutMs) || 120000);
          const g = await got; prompt(null);
          if (g.aborted) return stopped();
          if (g.timeout || g === '10') return fail('Product was not collected from the hatch');
        } else {
          const r = await this.request(154, mn, 211, this.mine(211));
          if (!r.ok) return fail('Collection cycle: ' + r.error, { fatal: r.fatal });
          if (r.msg.f[1] !== '0') return fail('Collection cycle refused – ' + (R211[r.msg.f[1]] || r.msg.f[1]));
          const at = await this.waitState(() => this.m.avail === 4, hatchMs);
          if (at !== true) return at.aborted ? stopped() : fail('Elevator did not reach the hatch');
          st('hatch');
          await this._wait(Number(T.hatchOpenMs) || 3000);
        }
        st('home');
        // ES-Plus returns to standby by itself (Op 107 timer) or when the next lane starts.
      }
      st('done');
      return { status: 'pass', ms: Date.now() - t0, token: tok, note: dispensed ? 'Product dispensed' : 'Motor ran – lane empty' };
    }

    async _wait(ms) { const end = Date.now() + ms; while (Date.now() < end && !this.abort) await sleep(Math.min(100, end - Date.now())); }

    async _recover(qendra, aborted) {
      const mn = this.mn;
      if (aborted) await this.request(112, '1', 216).catch(() => { });   // drop requests not yet started
      if (qendra && this.m.qSeen && [2, 13, 4, 5, 6].includes(this.m.q)) {
        this.emit('log', 'info', 'Recovery: bringing the elevator back to rest');
        await this._clearElevator(this._prompt || (() => { }), 'Recovery: ');
      }
    }

    /** refresh everything the sensor panel shows: Op 100 (door/service), 115 (active faults), 117 (tray phototransistors) */
    async readSensors() {
      const mn = this.mn;
      await this.request(100, mn, 201, this.mine(201), 2500);
      await this.request(115, mn, 219, this.mine(219), 2500);
      await this.request(117, mn, 222, this.mine(222), 2500);
      this.emit('state');
    }

    // ---------------------------------------------------------- manual actions
    async toHatch(unitCode) {
      return this.qendraFor(unitCode) ? this.request(158, this.mn, 227, this.mine(227)) : this.request(154, this.mn, 211, this.mine(211));
    }
    closeHatch() { return this.request(157, this.mn, 226, this.mine(226)); }
    status() { return this.request(100, this.mn, 201, this.mine(201)); }
    light(on) { return this.request(152, `${this.mn},${on ? 1 : 0}`, 201, this.mine(201)); }
    resetFaults() { return this.request(153, this.mn, 201, this.mine(201), 8000); }

    /** Op 111 → 215 (one message per fault): kind 0 = active, 1 = non-active (history) */
    async _faultList(kind) {
      const mn = this.mn, list = [];
      let last = 0, got = false;
      const w = this.until(msg => {
        if (ERR_OPS[msg.op] && msg.f[0] === '111') return { error: ERR_OPS[msg.op] };
        if (msg.op !== 215 || msg.f[0] !== mn || msg.f[1] !== String(kind)) return;
        got = true; last = Date.now();
        const n = Number(msg.f[2]);
        if (n && !list.some(x => x.n === n)) list.push({ n, times: Number(msg.f[3]) || 0, partial: Number(msg.f[4]) || 0, minutes: msg.f[5] != null && msg.f[5] !== '' ? Number(msg.f[5]) : null, last: msg.f[6] || '' });
      }, 6000, { ignoreAbort: true, check: () => got && Date.now() - last > 700 ? 'done' : undefined });
      try { await this.send(111, `${mn},${kind}`); } catch (e) { w.cancel(); return { ok: false, error: e.message }; }
      const r = await w;
      if (r && r.error) return { ok: false, error: r.error };
      if (!got) return { ok: false, error: 'No answer from JSD to Op 111 (faults)' };
      return { ok: true, list };
    }
    /** machine status (Op 100) + active (Op 115 and 111/0) + non-active (111/1) faults */
    async faultReport() {
      const mn = this.mn;
      const st = await this.request(100, mn, 201, this.mine(201));
      const act219 = await this.request(115, mn, 219, this.mine(219));
      const active = await this._faultList(0);
      const inactive = await this._faultList(1);
      this.emit('state');
      const a = active.ok ? active.list : [];
      if (act219.ok) for (const n of this.m.faults) if (!a.some(x => x.n === n)) a.push({ n, times: null });
      return { ok: st.ok, error: st.ok ? '' : st.error, active: a, inactive: inactive.ok ? inactive.list : [], inactiveError: inactive.ok ? '' : inactive.error, activeError: active.ok || act219.ok ? '' : active.error };
    }
    /** reset active faults + auto test (Op 153), then clear the non-active fault history (Op 111 data 2) */
    async resetAllFaults() {
      const mn = this.mn, out = [];
      const a = await this.request(153, mn, 201, this.mine(201), 8000);
      out.push(a.ok ? 'Active faults reset (Op 153) – machine auto-test running' : 'Reset active faults failed: ' + a.error);
      const c = await this.request(111, `${mn},2`, 215, msg => msg.f[0] === mn && msg.f[1] === '2', 4000);
      out.push(c.ok ? 'Non-active fault history cleared (Op 111)' : 'Clear non-active faults failed: ' + c.error);
      // the auto test re-reports the faults it still sees: give it a moment
      await this.waitState(() => this.m.avail === 0, 15000, { ignoreAbort: true });
      await this.request(115, mn, 219, this.mine(219), 2500);
      this.emit('state');
      return { ok: a.ok && c.ok, text: out.join(' · ') };
    }

    /** Qendra: close the hatch without anyone at the machine – Op 157, repeated, until the elevator is home or maxMs passes */
    async _closeHatchAuto(maxMs, detail = () => { }) {
      const mn = this.mn, q = () => this.m.q, t0 = Date.now();
      let lastSend = 0, sent158 = false, warned = false;
      while (Date.now() - t0 < maxMs) {
        if ([1, 2].includes(q())) return true;
        if ([11, 12].includes(q())) return false;
        if (q() === 13 && !sent158) { sent158 = true; await this.request(158, mn, 227, this.mine(227)); }
        if ([4, 5, 6].includes(q()) && Date.now() - lastSend > 2500) {
          lastSend = Date.now();
          await this.request(157, mn, 226, this.mine(226));
          if (!warned && q() === 5 && Date.now() - t0 > 6000) {
            warned = true;
            this.emit('log', 'warn', 'Hatch still open: the Qendra product sensor sees something in the hatch – it keeps the door open until it is clear. Retrying close…');
            detail('Hatch held open by the product sensor – retrying close');
          }
        }
        await sleep(200);
      }
      return [1, 2].includes(q());
    }
    resetSoldOut() { return this.request(108, this.mn, 212, this.mine(212)); }
    activeFaults() { return this.request(115, this.mn, 219, this.mine(219)); }
  }

  global.SerialLink = SerialLink;
  global.BridgeLink = BridgeLink;
  global.SerialSwitch = SerialSwitch;
  global.Jsd = Jsd;
  global.JsdText = { ST204, EXT, AVAIL, QSTATE, EVENTS, ERR_OPS };
  global.sleep = sleep;
})(window);
