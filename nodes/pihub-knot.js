// pihub-knot ("knot"): retrieval instead of regression, after CinemaKnot.
// Records states of the devices as entries in a corpus (inputs point -> stored outputs, with a label), then answers
// the live inputs with ONE recorded state: the nearest, or with randomness one of the k nearest, holding it through
// hysteresis. Emits the distance and the whole neighbourhood too, so the choice is never a black box.
//
// Data in : messages from `device in` / `describe` nodes (msg.device, msg.param, msg.value), or msg.topic '/dev/param' + numeric payload
// Control : msg.topic 'knot/record' (payload: label, optional) | 'knot/forget' (payload: id) | 'knot/query' (payload true/false)
//           | 'knot/once' | 'knot/recall' (payload: id) | 'knot/randomness' | 'knot/k' | 'knot/hold' (numeric payload)
//           | 'knot/save' | 'knot/load' | 'knot/clear' | 'knot/status'
// Out 1   : the chosen state as device messages from virtual device 'knot': { device:'knot', param:'cassette/m', value, topic, payload, knot:{ id, distance } }
// Out 2   : the match: { topic:'knot/match', id, distance, changed, payload:{ id, distance, changed, rolled, how, neighbors, query, outputs } }
// Out 3   : status text
'use strict';
const fs = require('fs');
const path = require('path');
const { Corpus, Knot } = require('./lib/knot.js');

module.exports = function (RED) {
  function KnotNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const list = s => String(s || '').split(',').map(t => t.trim().replace(/^\//, '')).filter(Boolean);
    // config keys are inputParams/outputParams: Node-RED reserves `inputs`/`outputs` for port counts (older flows are read)
    const inputs = list(config.inputParams ?? config.inputs), outputs = list(config.outputParams ?? config.outputs);
    const rateMs = Number(config.rateMs) || 50;
    const now = () => performance.now();                 // monotonic: a stepping system clock cannot stall the rate limiter
    const userDir = path.resolve(RED.settings.userDir);
    const dir = path.resolve(userDir, String(config.dir || 'knot').trim() || 'knot');
    if (!dir.startsWith(userDir + path.sep)) { node.status({ fill: 'red', shape: 'ring', text: 'data folder must be inside data/' }); node.error('data folder must be a relative path inside ' + userDir); return; }
    if (!inputs.length || !outputs.length) { node.status({ fill: 'red', shape: 'ring', text: 'set inputs and outputs' }); return; }
    fs.mkdirSync(dir, { recursive: true });
    const file = n => path.join(dir, n);

    let corpus, knot;
    try {
      corpus = new Corpus({ nIn: inputs.length, nOut: outputs.length, weights: list(config.weights).map(Number), metric: config.metric });
      knot = new Knot(corpus, { k: config.k, randomness: config.randomness, hold: config.hold });
    } catch (e) { node.status({ fill: 'red', shape: 'ring', text: e.message }); node.error(e.message); return; }

    const cur = Object.fromEntries([...inputs, ...outputs].map(k => [k, null]));
    let querying = false, lastQuery = -Infinity, pending = null, last = null;
    const stopPending = () => { if (pending) { clearTimeout(pending); pending = null; } };

    const badge = () => node.status({ fill: querying ? 'green' : corpus.size ? 'blue' : 'grey', shape: 'dot',
      text: `${corpus.size} entries${last ? ` → ${last.id} d=${last.distance.toFixed(3)}` : ''}${querying ? ' querying' : ''}${knot.randomness ? ` r=${knot.randomness}` : ''}` });
    const status = (text, send) => { badge(); node.log(text); if (send) send([null, null, { topic: 'knot/status', payload: text }]); };
    const save = () => {
      const d = corpus.toDatasets();
      fs.writeFileSync(file('dataset-in.json'), JSON.stringify(d.in, null, 2));
      fs.writeFileSync(file('dataset-out.json'), JSON.stringify(d.out, null, 2));
    };
    const load = send => {
      const fi = file('dataset-in.json'), fo = file('dataset-out.json');
      if (!fs.existsSync(fi) || !fs.existsSync(fo)) return status('loaded nothing (no dataset files in ' + dir + ')', send);
      try {
        const note = corpus.loadDatasets(JSON.parse(fs.readFileSync(fi, 'utf8')), JSON.parse(fs.readFileSync(fo, 'utf8')));
        knot.reset(); last = null;
        status(`loaded ${corpus.size} entries${note}: ${corpus.ids().join(', ')}`, send);
      } catch (e) { status('load failed, corpus unchanged: ' + e.message, send); }
    };
    const emit = (send, res, how) => {
      last = res;
      const out1 = outputs.map((k, i) => { const v = Math.min(1, Math.max(0, res.y[i])); return { device: 'knot', param: k, value: v, topic: '/knot/' + k, payload: v, knot: { id: res.id, distance: res.distance } }; });
      const out2 = { topic: 'knot/match', id: res.id, distance: res.distance, changed: res.changed,
        payload: { id: res.id, distance: res.distance, changed: res.changed, rolled: res.rolled, how, neighbors: res.neighbors,
          query: Object.fromEntries(inputs.map(k => [k, cur[k]])), outputs: Object.fromEntries(outputs.map((k, i) => [k, res.y[i]])) } };
      send([out1, out2, null]);
      if (res.changed) badge();
    };
    /** query with the current inputs; false if an input has no value yet or the corpus is empty. A live query after
     *  `query off` (a timer that was already pending) is dropped; `once` and `recall` work with live query off. */
    const queryNow = (send, roll, how) => {
      if (how === 'live' && !querying) return false;
      const x = inputs.map(k => cur[k]);
      if (x.some(v => v === null)) return false;
      lastQuery = now();
      const res = knot.query(x, { roll });
      if (!res) return false;
      emit(send, res, how);
      return true;
    };
    // at most one live query every rateMs; a value arriving inside the window is answered at the end of it, not dropped
    const schedule = send => {
      const wait = rateMs - (now() - lastQuery);
      if (wait <= 0) { queryNow(send, false, 'live'); return; }
      if (!pending) pending = setTimeout(() => { pending = null; queryNow(send, false, 'live'); }, wait);
    };
    const onOff = p => typeof p === 'string' ? !/^(off|0|false|no)$/i.test(p.trim()) : p === undefined ? true : !!Number(p);
    const idOf = p => (typeof p === 'string' || typeof p === 'number') ? String(p).trim() : '';

    const commands = {
      record(send, payload) {
        const missing = [...inputs, ...outputs].filter(k => cur[k] === null);
        if (missing.length) return status('record refused, no value yet for: ' + missing.join(', '), send);
        const id = idOf(payload) || corpus.nextId();
        const x = inputs.map(k => cur[k]), y = outputs.map(k => cur[k]);
        const replaced = corpus.set(id, x, y); knot.touch(); save();
        status(`${replaced ? 'replaced' : 'recorded'} "${id}" (${corpus.size} entries): in=[${x.map(v => v.toFixed(3))}] out=[${y.map(v => v.toFixed(3))}]`, send);
      },
      forget(send, payload) {
        const id = idOf(payload);
        if (!id) return status('forget needs the entry id as payload', send);
        if (!corpus.remove(id)) return status(`forget: no entry "${id}"`, send);
        knot.touch(); save(); status(`forgot "${id}" (${corpus.size} entries)`, send);
      },
      query(send, payload) {
        const on = onOff(payload);
        if (on && !corpus.size) return status('query refused, the corpus is empty (record first)', send);
        querying = on; if (!on) stopPending();
        status('query ' + (on ? 'on' : 'off'), send);
        if (on) queryNow(send, false, 'live');
      },
      once(send) {
        if (!corpus.size) return status('once refused, the corpus is empty', send);
        if (!queryNow(send, true, 'once')) status('once refused, no value yet for every input', send);
      },
      recall(send, payload) {
        const id = idOf(payload), res = knot.recall(id);
        if (!res) return status(`recall: no entry "${id}"`, send);
        emit(send, res, 'recall'); status(`recalled "${id}"`, send);
      },
      randomness(send, payload) { knot.randomness = payload; status(`randomness = ${knot.randomness}`, send); },
      k(send, payload) { knot.k = payload; status(`k = ${knot.k}`, send); },
      hold(send, payload) { knot.hold = payload; status(`hold = ${knot.hold}`, send); },
      save(send) { save(); status(`saved ${corpus.size} entries to ${dir}`, send); },
      load(send) { load(send); },
      clear(send) { corpus.clear(); knot.reset(); last = null; querying = false; stopPending(); status('cleared the corpus (files unchanged until save)', send); },
      status(send) {
        status(`${corpus.size} entries [${corpus.ids().join(', ')}] k=${knot.k} randomness=${knot.randomness} hold=${knot.hold} metric=${corpus.metric}` +
          ` weights=${corpus.weights ? corpus.weights : 'equal'} query=${querying ? 'on' : 'off'} current=${knot.current} inputs=${inputs} outputs=${outputs} cur=${JSON.stringify(cur)}`, send);
      },
    };

    node.on('input', (msg, send, done) => {
      try {
        const topic = typeof msg.topic === 'string' ? msg.topic.replace(/^\//, '') : '';
        if (topic.startsWith('knot/')) {
          const cmd = topic.slice(5);
          if (commands[cmd]) { commands[cmd](send, msg.payload); return done(); }
          // not a command: another knot's output ('/knot/cassette/m' with device/param) is ordinary data, anything else is a typo
          if (!(typeof msg.device === 'string' && typeof msg.param === 'string')) { status('unknown command ' + topic, send); return done(); }
        }
        // same value rule as device out: payload if numeric, else value (so range/change nodes in between take effect)
        const key = (typeof msg.device === 'string' && typeof msg.param === 'string') ? msg.device + '/' + msg.param : topic;
        const value = typeof msg.payload === 'number' ? msg.payload : msg.value;
        if (!key || typeof value !== 'number' || !Number.isFinite(value) || !(key in cur)) return done();
        cur[key] = value;
        if (querying && inputs.includes(key)) schedule(send);
        done();
      } catch (e) { done(e); }
    });
    node.on('close', () => stopPending());
    load(null);
  }
  RED.nodes.registerType('pihub-knot', KnotNode);
};
