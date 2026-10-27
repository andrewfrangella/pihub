// The hub runtime: one UDP socket receiving OSC from every device, a registry of who is online,
// and a send path back to devices. Used by the pihub-hub config node; device nodes talk to this.
//
// Contract: devices send /<device>/<param> <float> to listenPort; the hub sends /<device>/set/<param> <float>
// to the device's last-seen IP on devicePort. A device is online if heard from within onlineMs.
'use strict';
const dgram = require('dgram');
const EventEmitter = require('events');
const osc = require('osc');

class Hub extends EventEmitter {
  constructor({ listenPort = 9000, devicePort = 9001, onlineMs = 3000 } = {}) {
    super();
    this.listenPort = Number(listenPort); this.devicePort = Number(devicePort); this.onlineMs = Number(onlineMs);
    this.devices = new Map();          // name -> { ip, lastSeen, params: { param: value } }
    this.sock = null; this.bound = false; this.stopped = false; this.retry = null;
    this.setMaxListeners(100);
    const okPort = p => Number.isInteger(p) && p > 0 && p < 65536;
    if (!okPort(this.listenPort) || !okPort(this.devicePort)) throw new Error(`ports must be 1..65535 (listen ${listenPort}, device ${devicePort})`);
  }

  /** bind the listen port; on failure (e.g. port busy) retries every retryMs until stop() */
  start(cb, retryMs = 5000) {
    if (this.sock || this.stopped) return;
    const sock = dgram.createSocket('udp4');
    this.sock = sock; this.bound = false;
    sock.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
    sock.on('error', err => {
      this.emit('error', err);
      if (!this.bound && this.sock === sock) {            // bind failed: drop it and retry later
        try { sock.close(); } catch (e) { /* already closed */ }
        this.sock = null;
        if (!this.stopped) this.retry = setTimeout(() => { this.retry = null; this.start(cb, retryMs); }, retryMs);
      }
    });
    sock.bind(this.listenPort, () => { this.bound = true; if (cb) cb(); });
  }
  stop(cb) {
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const s = this.sock; this.sock = null; this.bound = false;
    if (!s) return cb && cb();
    try { s.close(() => cb && cb()); } catch (e) { if (cb) cb(); }
  }

  _onPacket(buf, rinfo) {
    let pkt;
    try { pkt = osc.readPacket(buf, { metadata: true }); } catch (e) { this.emit('bad', e, rinfo); return; }
    this._handle(pkt, rinfo);
  }
  _handle(pkt, rinfo) {
    if (pkt.packets) { pkt.packets.forEach(p => this._handle(p, rinfo)); return; }   // bundle
    const parts = String(pkt.address || '').split('/').filter(Boolean);
    if (parts.length < 2) return;
    const device = parts[0], param = parts.slice(1).join('/');
    // normalise args to plain numbers/strings; booleans become 1/0; blobs, arrays, int64 objects are skipped
    const args = (pkt.args || []).map(a => (typeof a.value === 'number' || typeof a.value === 'string') ? a.value : typeof a.value === 'boolean' ? (a.value ? 1 : 0) : undefined).filter(v => v !== undefined);
    const value = args.length === 1 ? args[0] : args;
    let d = this.devices.get(device);
    const isNew = !d;
    if (isNew) { d = { ip: rinfo.address, lastSeen: 0, params: Object.create(null) }; this.devices.set(device, d); }
    d.ip = rinfo.address; d.lastSeen = Date.now(); d.params[param] = value;
    try {
      if (isNew) this.emit('device', device);
      this.emit('message', { device, param, value, args, ip: rinfo.address, address: pkt.address });
    } catch (e) { this.emit('listenerError', e); }   // a throwing listener must not kill the socket callback
  }

  isOnline(device) { const d = this.devices.get(device); return !!d && (Date.now() - d.lastSeen) < this.onlineMs; }
  report() {
    const now = Date.now(), out = {};
    for (const [name, d] of this.devices) out[name] = { online: (now - d.lastSeen) < this.onlineMs, ip: d.ip, ageMs: now - d.lastSeen, params: { ...d.params } };
    return out;
  }

  /** send /<device>/set/<param> <value> to the device; false if it is offline or unknown */
  send(device, param, value, type = 'f') {
    const d = this.devices.get(device);
    if (!this.sock || !d || !this.isOnline(device)) return false;
    this.sendRaw(d.ip, this.devicePort, `/${device}/set/${param}`, [{ type, value }]);
    return true;
  }
  /** send any OSC message anywhere (args as [{type, value}] or plain numbers/strings) */
  sendRaw(ip, port, address, args = []) {
    if (!this.sock || !this.bound) return false;
    const typed = args.map(a => (a && typeof a === 'object' && 'type' in a) ? a : (typeof a === 'number' ? { type: 'f', value: a } : { type: 's', value: String(a) }));
    const buf = Buffer.from(osc.writePacket({ address, args: typed }));
    this.sock.send(buf, Number(port), ip);
    return true;
  }
}
module.exports = Hub;
