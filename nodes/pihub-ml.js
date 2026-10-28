// pihub-ml ("ml mapper"): learns a mapping from some device parameters to others.
// The algorithm is a learner module from ./learners (see learners/README.md); this node only does
// the bookkeeping: latest values, recording pairs, FluCoMa dataset files, predictions, status.
//
// Data in : messages from `device in` nodes (msg.device, msg.param, msg.value), or msg.topic '/dev/param' + numeric payload
// Control : msg.topic 'ml/record' | 'ml/train' | 'ml/predict' (payload true/false) | 'ml/save' | 'ml/load' | 'ml/clear' | 'ml/status'
// Out 1   : predictions as device messages from virtual device 'ml': { device:'ml', param:'cassette/m', value, topic, payload }
// Out 2   : status text
'use strict';
const fs = require('fs');
const path = require('path');

const LEARNERS = {
  'fluid-mlp': require('./learners/fluid-mlp.js'),
  'knn':       require('./learners/knn.js'),
};

const { toDataset: datasetToJSON, pairDatasets: pairedDatasets } = require('./lib/dataset.js');   // fluid.dataset read/write, shared with the knot

module.exports = function (RED) {
  function MLNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const list = s => String(s || '').split(',').map(t => t.trim().replace(/^\//, '')).filter(Boolean);
    // config keys are inputParams/outputParams: Node-RED reserves `inputs`/`outputs` for port counts (older flows are read)
    const inputs = list(config.inputParams ?? config.inputs), outputs = list(config.outputParams ?? config.outputs);
    const learnerName = LEARNERS[config.learner] ? config.learner : 'fluid-mlp';
    const learner = LEARNERS[learnerName];
    const cfg = { nIn: inputs.length, nOut: outputs.length,
      hidden: list(config.hidden).map(Number).filter(n => Number.isInteger(n) && n > 0),
      activation: Number(config.activation ?? 3), epochs: Number(config.epochs) || 2000, lr: Number(config.lr) || 0.01, k: Number(config.k) || 3 };
    const rateMs = Number(config.rateMs) || 50;
    const logValues = config.logValues !== false;
    const userDir = path.resolve(RED.settings.userDir);
    const dir = path.resolve(userDir, String(config.dir || 'ml').trim() || 'ml');
    if (!dir.startsWith(userDir + path.sep)) { node.status({ fill: 'red', shape: 'ring', text: 'data folder must be inside data/' }); node.error('data folder must be a relative path inside ' + userDir); return; }
    const file = n => path.join(dir, n);
    fs.mkdirSync(path.join(dir, 'log'), { recursive: true });

    if (!inputs.length || !outputs.length) { node.status({ fill: 'red', shape: 'ring', text: 'set inputs and outputs' }); return; }

    const cur = Object.fromEntries([...inputs, ...outputs].map(k => [k, null]));
    let X = [], Y = [], model = null, predicting = false, lastPred = -Infinity, pendingPred = null;
    const now = () => performance.now();                 // monotonic: a stepping system clock cannot stall the rate limiter

    // value log: one CSV per deploy. Any stream error disables logging instead of crashing the process.
    let log = null;
    if (logValues) {
      const session = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      log = fs.createWriteStream(path.join(dir, 'log', session + '.csv'), { flags: 'a' });
      log.on('error', err => { node.warn('value log disabled: ' + err.message); const l = log; log = null; try { l.destroy(); } catch (e) { /* ignore */ } });
      log.write('time,device,param,value\n');
    }
    const csv = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

    const status = (text, send) => {
      node.status({ fill: predicting ? 'green' : (model ? 'blue' : 'grey'), shape: 'dot', text: `${learnerName} pairs=${X.length} ${model ? 'model' : 'no model'}${predicting ? ' predicting' : ''}` });
      node.log(text);
      if (send) send([null, { topic: 'ml/status', payload: text }]);
    };
    const saveDatasets = () => {
      fs.writeFileSync(file('dataset-in.json'),  JSON.stringify(datasetToJSON(X), null, 2));
      fs.writeFileSync(file('dataset-out.json'), JSON.stringify(datasetToJSON(Y), null, 2));
    };
    const saveModel = () => { const j = model && learner.modelFile ? model.toJSON() : null; if (j) fs.writeFileSync(file('model.json'), JSON.stringify(j, null, 2)); };
    const fit = () => { const m = learner.create(cfg); const info = m.fit(X, Y); model = m; saveModel(); return info; };
    const load = (send) => {
      const msgs = [];
      const fi = file('dataset-in.json'), fo = file('dataset-out.json'), fm = file('model.json');
      if (fs.existsSync(fi) && fs.existsSync(fo)) {
        try {
          const { X: x, Y: y, note } = pairedDatasets(JSON.parse(fs.readFileSync(fi, 'utf8')), JSON.parse(fs.readFileSync(fo, 'utf8')));
          if (!x.length || (x[0].length === cfg.nIn && y[0].length === cfg.nOut)) { X = x; Y = y; msgs.push(`${X.length} pairs${note}`); }
          else msgs.push(`datasets skipped (${x[0].length}->${y[0].length} does not match ${cfg.nIn}->${cfg.nOut})`);
        } catch (e) { msgs.push(`datasets skipped (${e.message})`); }
      }
      if (learner.modelFile && fs.existsSync(fm)) {
        try { model = learner.fromJSON(JSON.parse(fs.readFileSync(fm, 'utf8')), cfg); msgs.push('model'); }
        catch (e) { msgs.push(`model skipped (${e.message})`); }
      } else if (!learner.modelFile) {
        if (X.length) { try { msgs.push('fitted ' + fit()); } catch (e) { msgs.push(`fit failed (${e.message})`); } }
        else { model = null; predicting = false; }   // the datasets are the model; no data, no model
      }
      status('loaded ' + (msgs.length ? msgs.join(', ') : 'nothing (no files)'), send);
    };

    const commands = {
      record(send) {
        const missing = [...inputs, ...outputs].filter(k => cur[k] === null);
        if (missing.length) return status('record refused, no value yet for: ' + missing.join(', '), send);
        const x = inputs.map(k => cur[k]), y = outputs.map(k => cur[k]);
        X.push(x); Y.push(y); saveDatasets();
        status(`recorded pair ${X.length}: in=[${x.map(v => v.toFixed(3))}] out=[${y.map(v => v.toFixed(3))}]`, send);
      },
      train(send) {
        if (X.length < 2) return status('train refused, need at least 2 recorded pairs', send);
        try { status(`trained ${learnerName} on ${X.length} pairs, ${learner.describe(cfg)}, ${fit()}`, send); }
        catch (e) { status('train failed: ' + e.message, send); }
      },
      predict(send, payload) {
        const on = typeof payload === 'string' ? !/^(off|0|false|no)$/i.test(payload.trim()) : payload === undefined ? true : !!Number(payload);
        if (on && !model) return status('predict refused, no model (train or load first)', send);
        predicting = on; status('predict ' + (on ? 'on' : 'off'), send);
      },
      save(send) { saveDatasets(); saveModel(); status('saved to ' + dir, send); },
      load(send) { load(send); },
      clear(send) {
        X = []; Y = [];
        if (!learner.modelFile) { model = null; predicting = false; }   // the datasets are the model
        status('cleared recorded pairs (files unchanged until save)', send);
      },
      status(send) { status(`${learnerName} pairs=${X.length} model=${model ? 'yes' : 'no'} predict=${predicting ? 'on' : 'off'} inputs=${inputs} outputs=${outputs} cur=${JSON.stringify(cur)}`, send); },
    };

    node.on('input', (msg, send, done) => {
      try {
        const topic = typeof msg.topic === 'string' ? msg.topic.replace(/^\//, '') : '';
        if (topic.startsWith('ml/')) {
          const cmd = topic.slice(3);
          if (commands[cmd]) commands[cmd](send, msg.payload); else status('unknown command ' + topic, send);
          return done();
        }
        // same value rule as device out: payload if numeric, else value (so range/change nodes in between take effect)
        const key = (typeof msg.device === 'string' && typeof msg.param === 'string') ? msg.device + '/' + msg.param : topic;
        const value = typeof msg.payload === 'number' ? msg.payload : msg.value;
        if (!key || typeof value !== 'number' || !Number.isFinite(value) || key.startsWith('ml/')) return done();
        const slash = key.indexOf('/');
        if (log) log.write(`${(Date.now() / 1000).toFixed(3)},${csv(slash < 0 ? key : key.slice(0, slash))},${csv(slash < 0 ? '' : key.slice(slash + 1))},${value}\n`);
        if (!(key in cur)) return done();
        cur[key] = value;
        if (predicting && model && inputs.includes(key)) schedulePredict(send);
        done();
      } catch (e) { done(e); }
    });
    // predict at most every rateMs; a value arriving inside the window is predicted at the end of it, not dropped
    const predictNow = (send) => {
      const x = inputs.map(k => cur[k]);
      if (!predicting || !model || !x.every(v => v !== null)) return;
      lastPred = now();
      let y;
      try { y = model.predict(x); } catch (e) { node.error('predict failed: ' + e.message); predicting = false; status('predict off (error)', send); return; }
      send([outputs.map((k, i) => { const v = Math.min(1, Math.max(0, y[i])); return { device: 'ml', param: k, value: v, topic: '/ml/' + k, payload: v }; }), null]);
    };
    const schedulePredict = (send) => {
      const wait = rateMs - (now() - lastPred);
      if (wait <= 0) { predictNow(send); return; }
      if (!pendingPred) pendingPred = setTimeout(() => { pendingPred = null; predictNow(send); }, wait);
    };

    node.on('close', (removed, done) => { if (pendingPred) { clearTimeout(pendingPred); pendingPred = null; } if (log) log.end(done); else done(); });
    load(null);
  }
  RED.nodes.registerType('pihub-ml', MLNode);
};
module.exports.lib = { LEARNERS, pairedDatasets, datasetToJSON };
