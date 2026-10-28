'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Corpus, Knot } = require('../nodes/lib/knot.js');

// a deterministic rng: returns the given values in turn
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const corpus3 = () => { const c = new Corpus({ nIn: 1, nOut: 1 }); c.set('dark', [0.1], [0.9]); c.set('mid', [0.5], [0.5]); c.set('bright', [0.9], [0.1]); return c; };

test('corpus: set, replace, remove, ids, nextId', () => {
  const c = new Corpus({ nIn: 2, nOut: 1 });
  assert.equal(c.set('a', [0, 0], [1]), false);
  assert.equal(c.set('a', [0.1, 0.1], [0.5]), true);
  assert.equal(c.size, 1); assert.deepEqual(c.get('a').x, [0.1, 0.1]);
  assert.equal(c.nextId(), 'point-0');
  c.set(c.nextId(), [1, 1], [0]); c.set('point-7', [0.5, 0.5], [0.5]);
  assert.equal(c.nextId(), 'point-8');
  assert.deepEqual(c.ids(), ['a', 'point-0', 'point-7']);
  assert.equal(c.remove('point-0'), true); assert.equal(c.remove('nope'), false);
  assert.deepEqual(c.ids(), ['a', 'point-7']);
  assert.throws(() => c.set('bad', [1], [1]), /entry is 1->1/);
  assert.throws(() => c.set('bad', [NaN, 0], [1]), /non-finite/);
});

test('corpus: nearest with metric and weights', () => {
  const c = new Corpus({ nIn: 2, nOut: 1 });
  c.set('x', [1, 0], [0]); c.set('y', [0, 1], [1]);
  // unweighted, the query is a little closer to x
  assert.equal(c.nearest([0.65, 0.6], 1)[0].id, 'x');
  // weight dim 1 heavily: y wins
  c.setWeights([0.1, 10]);
  assert.equal(c.nearest([0.65, 0.6], 1)[0].id, 'y');
  c.setWeights([1, 1]); assert.equal(c.weights, null);                 // all-ones is "no weights"
  assert.equal(c.nearest([0.65, 0.6], 2).length, 2);
  const m = new Corpus({ nIn: 2, nOut: 1, metric: 'manhattan' });
  m.set('o', [0, 0], [0]);
  assert.equal(m.nearest([0.3, 0.4])[0].distance.toFixed(3), '0.700');
  const e = new Corpus({ nIn: 2, nOut: 1 });
  e.set('o', [0, 0], [0]);
  assert.equal(e.nearest([0.3, 0.4])[0].distance.toFixed(3), '0.500');
  assert.throws(() => e.nearest([1], 1), /query has 1 values/);
});

test('knot: pure 1-NN with no randomness and no hold', () => {
  const k = new Knot(corpus3(), { k: 3, randomness: 0, hold: 0 });
  let r = k.query([0.15]);
  assert.equal(r.id, 'dark'); assert.deepEqual(r.y, [0.9]); assert.equal(r.changed, true); assert.equal(r.rolled, false);
  assert.equal(r.neighbors.length, 3); assert.equal(r.neighbors[0].id, 'dark');
  r = k.query([0.2]); assert.equal(r.id, 'dark'); assert.equal(r.changed, false);
  r = k.query([0.31]); assert.equal(r.id, 'mid'); assert.equal(r.changed, true);
  r = k.query([0.95]); assert.equal(r.id, 'bright');
});

test('knot: hold keeps the current entry across a boundary', () => {
  const k = new Knot(corpus3(), { k: 3, randomness: 0, hold: 0.1 });
  k.query([0.2]);                                  // dark
  assert.equal(k.query([0.33]).id, 'dark');        // 0.03 past the boundary: within hold, held
  assert.equal(k.query([0.29]).id, 'dark');
  assert.equal(k.query([0.4]).id, 'mid');          // clearly mid now
  assert.equal(k.query([0.27]).id, 'mid');         // held the other way
  assert.equal(k.query([0.2]).id, 'dark');
});

test('knot: randomness rolls only when the neighbourhood changes', () => {
  // rng sequence: first value decides "roll or not" (< randomness rolls), second picks the index
  const rng = seq(0.1, 0.99, 0.1, 0.99, 0.1, 0.99);  // always roll, always pick the last (farthest) of the k
  const k = new Knot(corpus3(), { k: 2, randomness: 1, hold: 0, rng });
  let r = k.query([0.1]);
  assert.equal(r.rolled, true); assert.equal(r.id, 'mid');          // the 2nd nearest of [dark, mid]
  r = k.query([0.12]);                                              // nearest is still dark: no new roll
  assert.equal(r.id, 'mid'); assert.equal(r.rolled, false); assert.equal(r.changed, false);
  r = k.query([0.95]);                                              // nearest is now bright: roll among [bright, mid]
  assert.equal(r.rolled, true); assert.equal(r.id, 'mid');
  r = k.query([0.95], { roll: true });                              // forced
  assert.equal(r.rolled, true);
});

test('knot: randomness 0 never rolls; once forces re-evaluation', () => {
  const k = new Knot(corpus3(), { k: 3, randomness: 0, hold: 0.5 });
  k.query([0.1]);
  assert.equal(k.query([0.5]).id, 'dark');                         // huge hold keeps dark
  const r = k.query([0.5], { roll: true });
  assert.equal(r.id, 'mid'); assert.equal(r.rolled, false);
});

test('knot: recall holds until the neighbourhood moves', () => {
  const k = new Knot(corpus3(), { k: 3, randomness: 0, hold: 0 });
  k.query([0.1]);
  const r = k.recall('bright');
  assert.equal(r.id, 'bright'); assert.deepEqual(r.y, [0.1]); assert.equal(r.changed, true);
  assert.equal(k.query([0.1]).id, 'bright');                        // input has not moved: the cue holds
  assert.equal(k.query([0.12]).id, 'bright');
  assert.equal(k.query([0.5]).id, 'mid');                           // nearest changed: back to the knot
  assert.equal(k.recall('nope'), null);
});

test('knot: touch after corpus edits, empty corpus', () => {
  const c = corpus3(), k = new Knot(c, { k: 3 });
  k.query([0.1]);
  c.remove('dark'); k.touch();
  assert.equal(k.current, null);
  assert.equal(k.query([0.1]).id, 'mid');
  c.clear(); k.reset();
  assert.equal(k.query([0.1]), null);
});

test('knot: live setters clamp', () => {
  const k = new Knot(corpus3());
  k.k = '0'; assert.equal(k.k, 1); k.k = 2.6; assert.equal(k.k, 3);
  k.randomness = 7; assert.equal(k.randomness, 1); k.randomness = 'x'; assert.equal(k.randomness, 0);
  k.hold = -1; assert.equal(k.hold, 0);
});

test('corpus: fluid.dataset round trip keeps labels and order', () => {
  const c = corpus3();
  const d = c.toDatasets();
  assert.equal(d.in.cols, 1); assert.deepEqual(Object.keys(d.in.data), ['dark', 'mid', 'bright']); assert.deepEqual(d.out.data.dark, [0.9]);
  const c2 = new Corpus({ nIn: 1, nOut: 1 });
  assert.equal(c2.loadDatasets(d.in, d.out), '');
  assert.deepEqual(c2.ids(), ['dark', 'mid', 'bright']);         // labels sort after point-N but keep their own order
  // point ids sort numerically, unpaired ids are reported
  const jin = { cols: 1, data: { 'point-10': [1], 'point-2': [0.2], lonely: [0] } }, jout = { cols: 1, data: { 'point-2': [0.5], 'point-10': [0.9] } };
  const c3 = new Corpus({ nIn: 1, nOut: 1 });
  assert.match(c3.loadDatasets(jin, jout), /1 unpaired/);
  assert.deepEqual(c3.ids(), ['point-2', 'point-10']);
  // wrong shape leaves the corpus unchanged
  assert.throws(() => c3.loadDatasets({ cols: 2, data: { a: [1, 2] } }, { cols: 1, data: { a: [1] } }), /datasets are 2->1/);
  assert.equal(c3.size, 2);
});

test('knot: a cue does not stick after the neighbourhood moved on and came back (stale anchor)', () => {
  const k = new Knot(corpus3(), { k: 3, randomness: 0, hold: 0 });
  k.query([0.1]); k.recall('bright');
  assert.equal(k.query([0.1]).id, 'bright');       // the cue holds where it was placed
  assert.equal(k.query([0.9]).id, 'bright');       // and is now simply the nearest
  assert.equal(k.query([0.1]).id, 'dark');         // back at 0.1 the knot answers dark, not the old cue
  assert.equal(k.query([0.5]).id, 'mid');
});

test('knot: a roll is made again each time the nearest changes, including back to where it was', () => {
  const rng = seq(0.1, 0.99);                       // always roll, always the farthest of the k
  const k = new Knot(corpus3(), { k: 3, randomness: 1, hold: 0, rng });
  let r = k.query([0.1]); assert.equal(r.id, 'bright'); assert.equal(r.rolled, true);
  r = k.query([0.15]); assert.equal(r.rolled, false); assert.equal(r.id, 'bright');       // same neighbourhood: holds
  r = k.query([0.5]); assert.equal(r.rolled, true);                                       // nearest is mid now: new roll
  r = k.query([0.9]); assert.equal(r.id, 'bright'); assert.equal(r.rolled, false);        // the roll was bright, which is the nearest here
  r = k.query([0.1]); assert.equal(r.rolled, true);                                       // nearest is dark again: a roll, not a stale hold
  // two entries, randomness 1: never stuck
  const c2 = new Corpus({ nIn: 1, nOut: 1 }); c2.set('a', [0], [0]); c2.set('b', [1], [1]);
  const k2 = new Knot(c2, { k: 2, randomness: 1, rng: seq(0.1, 0.99) });
  assert.equal(k2.query([0]).id, 'b'); assert.equal(k2.query([1]).id, 'b'); assert.equal(k2.query([0]).id, 'b');
  assert.equal(k2.query([0]).rolled, false); assert.equal(k2.query([1]).rolled, false);   // b is the nearest at 1 and sticky at 0: fine
  const k3 = new Knot(c2, { k: 2, randomness: 1, rng: seq(0.1, 0.01) });                  // always roll, always the nearest
  assert.equal(k3.query([0]).id, 'a'); assert.equal(k3.query([1]).id, 'b'); assert.equal(k3.query([0]).id, 'a');
});

test('knot: hysteresis re-bases on the current nearest, so hold never holds across two boundaries', () => {
  const c = new Corpus({ nIn: 1, nOut: 1 }); c.set('a', [0.0], [0]); c.set('b', [0.3], [0.5]); c.set('c', [0.6], [1]);
  const k = new Knot(c, { k: 3, randomness: 0, hold: 0.2 });
  assert.equal(k.query([0.0]).id, 'a');
  assert.equal(k.query([0.2]).id, 'a');            // within hold of b's lead: held
  assert.equal(k.query([0.44]).id, 'b');           // a is 0.44 away, b leads by 0.14 + hold 0.2 = 0.34: a is dropped, nearest b wins
});
