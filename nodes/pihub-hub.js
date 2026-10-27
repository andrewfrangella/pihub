// pihub palette, device side: hub config node, device in, device out, registry.
'use strict';
const Hub = require('./lib/hub.js');

module.exports = function (RED) {
  const list = s => String(s || '').split(',').map(t => t.trim().replace(/^\//, '')).filter(Boolean);

  // ---- config node: owns the socket + registry
  function HubConfig(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    try {
      node.hub = new Hub({ listenPort: Number(config.listenPort) || 9000, devicePort: Number(config.devicePort) || 9001, onlineMs: Number(config.onlineMs) || 3000 });
    } catch (e) { node.error(e.message); return; }
    let lastBad = 0;
    node.hub.on('error', err => node.error('hub socket error: ' + err.message + (err.code === 'EADDRINUSE' ? ' (retrying every 5 s)' : '')));
    node.hub.on('bad', err => { const now = Date.now(); if (now - lastBad > 5000) { lastBad = now; node.warn('dropped undecodable packet: ' + err.message); } });
    node.hub.on('listenerError', err => node.error('device node handler threw: ' + (err && err.stack || err)));
    node.hub.start(() => node.log(`listening for devices on udp ${node.hub.listenPort}, commands go to udp ${node.hub.devicePort}`));
    node.on('close', done => node.hub.stop(done));
  }
  RED.nodes.registerType('pihub-hub', HubConfig);

  const getHub = (node, config) => {
    const h = RED.nodes.getNode(config.hub);
    if (!h || !h.hub) { node.status({ fill: 'red', shape: 'ring', text: 'no hub configured' }); return null; }
    return h.hub;
  };

  // ---- device in: everything one device publishes
  function DeviceIn(config) {
    RED.nodes.createNode(this, config);
    const node = this, hub = getHub(node, config);
    if (!hub) return;
    const device = String(config.device || '').trim(), params = list(config.params);
    let lastStatus = 0, last = null;
    const onMsg = m => {
      if (m.device !== device || (params.length && !params.includes(m.param))) return;
      last = m;
      node.send({ device: m.device, param: m.param, value: m.value, topic: '/' + m.device + '/' + m.param, payload: m.value, ip: m.ip });
      const now = Date.now();
      if (now - lastStatus > 250) { lastStatus = now; node.status({ fill: 'green', shape: 'dot', text: `${m.param}=${typeof m.value === 'number' ? m.value.toFixed(3) : m.value}` }); }
    };
    hub.on('message', onMsg);
    const tick = setInterval(() => { if (!hub.isOnline(device)) node.status({ fill: 'red', shape: 'ring', text: last ? 'offline' : 'never seen' }); }, 1000);
    node.status({ fill: 'grey', shape: 'ring', text: 'waiting for ' + device });
    node.on('close', () => { hub.off('message', onMsg); clearInterval(tick); });
  }
  RED.nodes.registerType('pihub-device-in', DeviceIn);

  // ---- device out: /<device>/set/<param>
  // value: msg.payload if numeric or a numeric string (so range/change nodes in between take effect), else msg.value.
  // param: the node's param, else msg.param, else msg.topic.
  // A message whose param/topic carries a device prefix ('cassette/m', from the ml node) is accepted only if
  // that prefix is this node's device, whether or not a fixed param is configured.
  function DeviceOut(config) {
    RED.nodes.createNode(this, config);
    const node = this, hub = getHub(node, config);
    if (!hub) return;
    const device = String(config.device || '').trim(), fixedParam = String(config.param || '').trim().replace(/^\//, '');
    const clamp = config.clamp !== false;
    let lastStatus = 0;
    node.on('input', (msg, send, done) => {
      let param = typeof msg.param === 'string' ? msg.param : (typeof msg.topic === 'string' ? msg.topic.replace(/^\//, '') : '');
      if (param.includes('/')) {
        const [dev, ...rest] = param.split('/');
        if (dev !== device) return done();              // addressed to another device; not ours
        param = rest.join('/');
      }
      if (fixedParam) param = fixedParam;
      let v = typeof msg.payload === 'number' ? msg.payload : (typeof msg.payload === 'string' && msg.payload.trim() !== '' && Number.isFinite(Number(msg.payload))) ? Number(msg.payload) : msg.value;
      if (!param || typeof v !== 'number' || !Number.isFinite(v)) { node.status({ fill: 'yellow', shape: 'ring', text: !param ? 'no param' : 'non-numeric value, dropped' }); return done(); }
      if (clamp) v = Math.min(1, Math.max(0, v));
      const ok = hub.send(device, param, v);
      const now = Date.now();
      if (now - lastStatus > 250 || !ok) { lastStatus = now; node.status(ok ? { fill: 'blue', shape: 'dot', text: `${param}=${v.toFixed(3)}` } : { fill: 'red', shape: 'ring', text: device + ' offline, dropped' }); }
      done();
    });
    node.status({});
  }
  RED.nodes.registerType('pihub-device-out', DeviceOut);

  // ---- registry: who is online, emitted every N seconds (also in global context 'pihub_devices')
  function Registry(config) {
    RED.nodes.createNode(this, config);
    const node = this, hub = getHub(node, config);
    if (!hub) return;
    const every = Math.max(0.2, Number(config.every) || 2) * 1000;
    const emit = () => {
      const r = hub.report();
      node.context().global.set('pihub_devices', r);
      const names = Object.keys(r), online = names.filter(n => r[n].online);
      node.status({ fill: online.length ? 'green' : 'grey', shape: 'dot', text: `${online.length}/${names.length} online` });
      node.send({ topic: 'registry', payload: r });
    };
    const t = setInterval(emit, every);
    node.on('close', () => clearInterval(t));
  }
  RED.nodes.registerType('pihub-registry', Registry);
};
