/*
 * Jofemar J-CONNECT protocol over RS232
 *
 * Transport (SP208M10N000EN):  C0 | code | id | data... | CRC16 hi | CRC16 lo | C0
 *   code 0x01 data, 0x02 ACK, 0x03 NACK.  0xC0 -> DB DC, 0xDB -> DB DD (after CRC).
 *   CRC16 poly 0x8005, init 0, MSB first, over C0+code+id+data (unescaped).
 *   Each data frame must be ACKed within 500 ms, max 3 attempts. 9600 8N1.
 * Application (SP132N001EN / SP208M10N001EN):
 *   len(2, LE, includes itself) | app(2, LE) = 402 | opcode(2, LE) | ASCII data separated by ','
 *
 * Verified against a real capture: C0 01 00 07 00 92 01 64 00 30 A6 E3 C0  (Op 100 "0")
 */
(function (global) {
  'use strict';
  const APP_VISION = 402;
  const FLAG = 0xC0, ESC = 0xDB, ESC_END = 0xDC, ESC_ESC = 0xDD;
  const ACK_TIMEOUT = 500, MAX_TRIES = 3;

  class Emitter {
    constructor() { this._h = {}; }
    on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
    off(e, f) { this._h[e] = (this._h[e] || []).filter(x => x !== f); }
    emit(e, ...a) { (this._h[e] || []).slice().forEach(f => { try { f(...a); } catch (err) { console.error(err); } }); }
  }

  function crc16(bytes) {
    let c = 0;
    for (const b of bytes) {
      c ^= b << 8;
      for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c;
  }

  function encodeFrame(code, id, data = []) {
    const raw = [FLAG, code, id, ...data];
    const c = crc16(raw);
    const body = [code, id, ...data, c >> 8, c & 0xFF];
    const out = [FLAG];
    for (const b of body) {
      if (b === FLAG) out.push(ESC, ESC_END);
      else if (b === ESC) out.push(ESC, ESC_ESC);
      else out.push(b);
    }
    out.push(FLAG);
    return new Uint8Array(out);
  }

  function buildApp(op, text = '', app = APP_VISION) {
    const d = Array.from(String(text), ch => ch.charCodeAt(0) & 0xFF);
    const len = 6 + d.length;
    return [len & 0xFF, len >> 8, app & 0xFF, app >> 8, op & 0xFF, op >> 8, ...d];
  }

  function parseApp(data) {
    if (!data || data.length < 6) return null;
    const app = data[2] | (data[3] << 8), op = data[4] | (data[5] << 8);
    const text = Array.from(data.slice(6), b => String.fromCharCode(b)).join('');
    return { app, op, text, f: text.length ? text.split(',').map(s => s.trim()) : [] };
  }

  /** Byte-by-byte frame decoder (mirrors Jofemar's TramaRecibida) */
  class FrameDecoder {
    constructor() { this.reset(); }
    reset() { this.state = 0; this.buf = []; this.esc = false; }
    /** @returns null | {code,id,data} | {error:'crc'|'escape', id} */
    push(b) {
      if (this.state === 0) { if (b === FLAG) { this.buf = [FLAG]; this.esc = false; this.state = 1; } return null; }
      if (this.esc) {
        this.esc = false;
        if (b === ESC_END) this.buf.push(FLAG);
        else if (b === ESC_ESC) this.buf.push(ESC);
        else { const id = this.buf[2]; this.reset(); return { error: 'escape', id }; }
        return this._guard();
      }
      if (b === ESC) { this.esc = true; return null; }
      if (b === FLAG) {
        if (this.buf.length === 1) return null;          // C0 C0: previous end + new start
        const buf = this.buf; this.reset();
        if (buf.length < 5) return { error: 'short', id: buf[2] };
        const calc = crc16(buf.slice(0, buf.length - 2));
        const got = (buf[buf.length - 2] << 8) | buf[buf.length - 1];
        if (calc !== got) return { error: 'crc', id: buf[2] };
        return { code: buf[1], id: buf[2], data: buf.slice(3, buf.length - 2) };
      }
      this.buf.push(b);
      return this._guard();
    }
    _guard() { if (this.buf.length > 520) { this.reset(); return { error: 'overflow' }; } return null; }
  }

  // ====================================================================== link
  /** J-Connect link over a SerialLink: ACK/NACK, retries, de-duplication */
  class JLink extends Emitter {
    constructor(serial) {
      super();
      this.serial = serial;
      this.dec = new FrameDecoder();
      this.txId = Math.floor(Math.random() * 256);
      this.q = []; this.cur = null; this.timer = null;
      this.lastRx = { id: -1, at: 0 };
      this._w = Promise.resolve();
      serial.on('data', chunk => { for (const b of chunk) { const fr = this.dec.push(b); if (fr) this._onFrame(fr); } });
      serial.on('close', () => this.flush('Port closed'));
    }
    get ready() { return this.serial.connected; }

    _write(bytes) {
      this._w = this._w.then(() => this.serial.write(bytes)).catch(e => this.emit('error', e));
      return this._w;
    }

    sendApp(op, text = '', app = APP_VISION) {
      return new Promise((resolve, reject) => {
        if (!this.serial.connected) return reject(new Error('Not connected'));
        const id = this.txId; this.txId = (this.txId + 1) & 0xFF;
        const payload = buildApp(op, text, app);
        this.q.push({ id, op, text, app, bytes: encodeFrame(0x01, id, payload), tries: 0, resolve, reject });
        this._pump();
      });
    }

    _pump() { if (this.cur || !this.q.length) return; this.cur = this.q.shift(); this._transmit(); }

    _transmit() {
      const c = this.cur; c.tries++;
      this.emit('tx', { op: c.op, text: c.text, app: c.app, bytes: c.bytes, retry: c.tries > 1 });
      this._write(c.bytes);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.cur !== c) return;
        if (c.tries < MAX_TRIES) { this.emit('warn', `No ACK for Op ${c.op} – retry ${c.tries}`); this._transmit(); }
        else { this.cur = null; c.reject(new Error(`JSD did not acknowledge Op ${c.op} (3 attempts)`)); this._pump(); }
      }, ACK_TIMEOUT);
    }

    _onFrame(fr) {
      if (fr.error) {
        this.emit('warn', `Bad frame from JSD (${fr.error})`);
        if (fr.id != null && fr.error !== 'overflow') this._write(encodeFrame(0x03, fr.id));
        return;
      }
      if (fr.code === 0x02) {
        if (this.cur && this.cur.id === fr.id) {
          clearTimeout(this.timer); const c = this.cur; this.cur = null; c.resolve(true); this._pump();
        }
        return;
      }
      if (fr.code === 0x03) {
        if (this.cur && this.cur.id === fr.id) {
          clearTimeout(this.timer);
          if (this.cur.tries < MAX_TRIES) this._transmit();
          else { const c = this.cur; this.cur = null; c.reject(new Error(`JSD rejected Op ${c.op} (NACK)`)); this._pump(); }
        }
        return;
      }
      if (fr.code === 0x01) {
        this._write(encodeFrame(0x02, fr.id));                       // acknowledge immediately
        const now = Date.now();
        if (fr.id === this.lastRx.id && now - this.lastRx.at < 3000) return; // retransmission of a frame we already have
        this.lastRx = { id: fr.id, at: now };
        const msg = parseApp(fr.data);
        if (msg) this.emit('message', msg);
      }
    }

    flush(reason) {
      clearTimeout(this.timer);
      const all = (this.cur ? [this.cur] : []).concat(this.q);
      this.cur = null; this.q = [];
      all.forEach(c => c.reject(new Error(reason)));
      this.dec.reset();
    }
  }

  // ====================================================================== simulator
  /** Behaves like a JSD with one ES-Plus or Qendra machine (for training / demo) */
  class SimJsd extends Emitter {
    constructor(model = 'esplus', failRate = 0.05) {
      super();
      this.model = model; this.failRate = failRate;
      this.avail = 0; this.door = 1; this.qstate = 1; this.extended = 1; this.tracking = 1;
      this.lanes = {};
      // Example layout: 6 trays, mix of 10 / 8 / 5 channels
      const layout = { 11: 10, 12: 10, 13: 8, 14: 8, 15: 5, 16: 5 };
      for (const t in layout) for (let c = 0; c < layout[t]; c++) {
        const r = Math.random();
        this.lanes[`${t}.${c}`] = r < 0.02 ? 3 : r < 0.35 ? 1 : 2;
      }
      this.timers = [];
    }
    get ready() { return true; }
    flush() { this.timers.forEach(clearTimeout); this.timers = []; }
    _at(ms, op, text) { this.timers.push(setTimeout(() => this.emit('message', { app: APP_VISION, op, text, f: text.split(',').map(s => s.trim()) }), ms)); }
    _status(ms, m = 0) { this._at(ms, 201, `${m},1,1,${this.door},${this.avail},1, 4.0`); }
    _q(ms, s) { if (this.model === 'qendra' && this.tracking) this.timers.push(setTimeout(() => { this.qstate = s; this.emit('message', { app: APP_VISION, op: 225, text: `0,${s}`, f: ['0', String(s)] }); }, ms)); }
    _set(ms, fn) { this.timers.push(setTimeout(fn, ms)); }

    sendApp(op, text = '') {
      const f = text.split(',').map(s => s.trim());
      this.emit('tx', { op, text, app: APP_VISION, bytes: encodeFrame(1, 0, buildApp(op, text)) });
      const m = f[0] || '0';
      switch (op) {
        case 100: this._status(40, m); break;
        case 101: { const k = `${f[1]}.${f[2]}`; this._at(25, 202, `${m},${f[1]},${f[2]},${Math.ceil(this.lanes[k] || 0)}`); break; }
        case 105: this._at(40, 207, `0,${this.model === 'qendra' ? 'QENDRA' : 'ES-PLUS'},SIM00${this.model === 'qendra' ? 2 : 1},SIMFW01`); break;
        case 108: Object.keys(this.lanes).forEach(k => { if (this.lanes[k] === 2) this.lanes[k] = 1.5; }); this._at(60, 212, `${m},0`); break;
        case 110: this._at(40, 214, 'JSDSIM01,1,01/01/2026 00:00,Simulator'); break;
        case 112: this._at(40, 216, '20,0,0'); break;
        case 111: case 115: this._at(40, op === 111 ? 215 : 219, `${m}${op === 111 ? ',0,0' : ''}`); break;
        case 116: if (f[0] !== '') this.extended = +f[0]; this._at(40, 221, String(this.extended)); break;
        case 117: this._at(40, 222, `${m},0,0,0,0,0,0,0,0`); break;
        case 118: if (f[1] != null && f[1] !== '') this.tracking = +f[1]; this._at(40, 224, `0,0`); break;
        case 152: this._status(40, m); break;
        case 153: this.avail = 1; this._status(40, m); this.avail = 0; this._status(2500, m); break;
        case 150: case 155: this._vend(f); break;
        case 154:
          if (this.model === 'qendra') { this._at(40, 211, `${m},3`); break; }
          this._at(40, 211, `${m},0`); this.avail = 2; this._status(60, m);
          this._set(1500, () => { this.avail = 4; this._status(0, m); });
          this._set(9000, () => { if (this.avail === 4) { this.avail = 0; this._status(0, m); } });
          break;
        case 157:
          if (this.model !== 'qendra' || ![4, 5, 6].includes(this.qstate)) { this._at(40, 226, `${m},1`); break; }
          if (this.productIn && this.qstate === 5) { this._at(40, 226, `${m},0`); break; }   // real Qendra: door stays open on a product
          this._at(40, 226, `${m},0`); this._q(300, 7); this._q(1300, 10); this._q(2600, 1); this._set(2600, () => { this.avail = 0; this._status(0, m); });
          break;
        case 158:
          if (this.model !== 'qendra' || ![1, 2, 13].includes(this.qstate)) { this._at(40, 227, `${m},1`); break; }
          this._at(40, 227, `${m},0`); this._q(200, 3); this._q(1600, 4); this._q(2200, 5); this._set(2200, () => { this.avail = 3; this._status(0, m); });
          if (this.qstate === 13 && this.pending) {
            const p = this.pending; this.pending = null;
            this._at(2250, 204, `${p.tok},2,${p.loc},0`);
            // simulated tester takes the product 3 s after the door opens
            this.productIn = p;
            if (this.autoPickup !== false) this._set(5200, () => this.takeProduct());
          }
          break;
        default: this._at(40, 200, `${op},${text}`);
      }
      return Promise.resolve(true);
    }

    /** simulated tester takes the product out of the open hatch */
    takeProduct() {
      const p = this.productIn; if (!p) return;
      this.productIn = null; this._q(0, 6); this._at(50, 204, `${p.tok},3,${p.loc},0`);
    }

    _vend(f) {
      const [tok, m, tray, ch] = f;
      if (f.length < 4) { this._at(30, 204, `${tok},5`); return; }
      const k = `${tray}.${ch}`, st = this.lanes[k], loc = `${m}.${tray}.${ch}`;
      this._at(30, 204, `${tok},0`);
      if (!st) { this._at(80, 204, `${tok},7,${loc},0`); this._at(120, 204, `${tok},4,${loc},0`); return; }
      if (st === 2) { this._at(80, 204, `${tok},9,${loc},5`); this._at(120, 204, `${tok},4,${loc},5`); return; } // flagged sold-out: not started
      this.avail = 2; this._status(60, m); this._q(100, 8);
      this._at(700, 204, `${tok},1,${loc},0`); this._q(1100, 9);
      const fail = st === 3 || Math.random() < this.failRate;
      if (fail) {
        const ext = st === 3 || Math.random() < 0.5 ? 4 : 8;
        this._at(2200, 204, `${tok},9,${loc},${ext}`); this._at(2300, 204, `${tok},4,${loc},${ext}`);
        this._q(2400, 10); this._q(3400, 1); this._set(3400, () => { this.avail = 0; this._status(0, m); });
        return;
      }
      if (st === 1) {               // product in lane -> product dispensed into elevator
        this.lanes[k] = Math.random() < 0.3 ? 2 : 1;
        if (this.model === 'qendra') {
          // real Qendra (tracking on): product held in the elevator, waiting for the order to go to pick-up (Op 158)
          this.pending = { tok, loc, m };
          this._q(2400, 13); this._set(2400, () => { this.avail = 2; this._status(0, m); });
          return;
        }
        this._at(2500, 204, `${tok},2,${loc},0`);
        this._set(2500, () => { this.avail = 3; this._status(0, m); });
        this._set(5200, () => { this._at(50, 204, `${tok},3,${loc},0`); this.avail = 0; this._status(100, m); });
        return;
      }
      // empty lane: motor runs, nothing detected
      this.lanes[k] = 2;
      this._at(3000, 204, `${tok},9,${loc},7`); this._at(3100, 204, `${tok},4,${loc},7`);
      this._q(3200, 10); this._q(4200, 1); this._set(4200, () => { this.avail = 0; this._status(0, m); });
    }
  }

  const OPS = {
    100: 'Machine status?', 101: 'Channel status?', 105: 'Machine ID?', 107: 'Timings', 108: 'Reset sold-out', 110: 'JSD firmware?',
    111: 'Faults?', 112: 'Queue', 115: 'Active faults?', 116: 'Extended 204', 117: 'Tray sensors?', 118: 'Qendra config',
    150: 'Dispense channel', 151: 'Dispense selection', 152: 'Light', 153: 'Reset faults', 154: 'Collection cycle', 155: 'Dispense ext.', 156: 'JSD RESET',
    157: 'End collection', 158: 'To pick-up',
    200: 'FORMAT ERROR', 201: 'Machine status', 202: 'Channel status', 203: 'Selection status', 204: 'Dispense status', 207: 'Machine ID',
    208: 'Temperature', 209: 'Event', 210: 'Timings', 211: 'Collection cycle', 212: 'Sold-out reset', 214: 'JSD firmware', 215: 'Faults',
    216: 'Queue', 219: 'Active faults', 220: 'JSD reset', 221: 'Extended 204', 222: 'Tray sensors', 223: 'Qendra product', 224: 'Qendra config',
    225: 'Qendra state', 226: 'End collection', 227: 'To pick-up', 300: 'LICENCE BLOCKED', 301: 'NO LICENCE', 302: 'PRICE CONTROL', 303: 'NO QENDRA LICENCE'
  };

  global.JConnect = { APP_VISION, crc16, encodeFrame, buildApp, parseApp, FrameDecoder, JLink, SimJsd, Emitter, OPS };
})(window);
