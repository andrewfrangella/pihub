// pihub-describe ("describe"): descriptors of a device parameter's stream, after CinemaKnot's signal descriptors
// but for gestures. For every parameter it sees, over a sliding window: mean, dev (flutter), speed, range, each 0..1,
// emitted as new parameters of the same device named <param>.<descriptor> (tv/m.speed); and onsets, a jump larger
// than a threshold within hopMs, as a pulse (value 1), optionally with a fixed topic such as knot/once so an onset
// can trigger a knot directly.
//
// In    : device messages (msg.device, msg.param, msg.value / numeric payload), or msg.topic '/dev/param' + numeric payload
// Out 1 : descriptor messages { device, param:'m.speed', value, topic:'/tv/m.speed', payload, window:{ n, min, max, slope } }
// Out 2 : onset messages     { device, param:'m.onset', value:1, payload:1, topic, delta, from, to }
'use strict';
const { Describer } = require('./lib/describe.js');

const DESCRIPTORS = ['mean', 'dev', 'speed', 'range'];

module.exports = function (RED) {
  function DescribeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const d = new Describer({ windowMs: config.windowMs, hopMs: config.hopMs, speedScale: config.speedScale, onsetThreshold: config.onsetThreshold, refractoryMs: config.refractoryMs });
    const which = DESCRIPTORS.filter(k => config[k] !== false && config[k] !== 'false');
    const onsets = config.onsets !== false && config.onsets !== 'false';
    const onsetTopic = String(config.onsetTopic || '').trim();
    const rateMs = Math.max(0, Number(config.rateMs) || 0);
    const lastEmit = new Map();
    let statusUntil = 0;

    node.on('input', (msg, send, done) => {
      try {
        const topic = typeof msg.topic === 'string' ? msg.topic.replace(/^\//, '') : '';
        const parts = topic.split('/');
        const device = typeof msg.device === 'string' ? msg.device : parts[0];
        const param = typeof msg.param === 'string' ? msg.param : parts.slice(1).join('/');
        const value = typeof msg.payload === 'number' ? msg.payload : msg.value;
        if (!device || !param || typeof value !== 'number' || !Number.isFinite(value)) return done();
        const key = device + '/' + param, now = performance.now();   // monotonic: windows survive a stepping system clock
        const r = d.push(key, value, now);
        const base = { device, ip: msg.ip };

        let out1 = null;
        if (!rateMs || now - (lastEmit.get(key) || 0) >= rateMs) {
          lastEmit.set(key, now);
          out1 = which.map(k => { const v = Math.min(1, Math.max(0, r[k])); return { ...base, param: `${param}.${k}`, value: v, topic: `/${device}/${param}.${k}`, payload: v, window: { n: r.n, min: r.min, max: r.max, slope: r.slope } }; });
          if (!out1.length) out1 = null;
        }
        let out2 = null;
        if (onsets && r.onset) {
          out2 = { ...base, param: `${param}.onset`, value: 1, payload: 1, topic: onsetTopic || `/${device}/${param}.onset`, delta: r.onset.delta, from: r.onset.from, to: r.onset.to };
          node.status({ fill: 'yellow', shape: 'dot', text: `onset ${key} Δ=${r.onset.delta.toFixed(2)}` }); statusUntil = now + 2000;
        } else if (now > statusUntil) {
          statusUntil = now + 500;
          node.status({ fill: 'green', shape: 'dot', text: `${key} ${which.map(k => `${k}=${r[k].toFixed(2)}`).join(' ')}` });
        }
        if (out1 || out2) send([out1, out2]);
        done();
      } catch (e) { done(e); }
    });
    node.status({});
  }
  RED.nodes.registerType('pihub-describe', DescribeNode);
};
module.exports.DESCRIPTORS = DESCRIPTORS;
