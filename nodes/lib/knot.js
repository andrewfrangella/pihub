// The knot: a corpus of recorded states and a retrieval policy, after CinemaKnot's Corpus / queryKnot.
//
// Retrieval, not regression. The ml mapper fits a curve through the recorded pairs and answers any input with a
// point on that curve. The knot keeps the recorded states themselves and answers an input with ONE of them, the
// nearest (or, with randomness, one of the k nearest), together with the distance to it. Nothing is interpolated,
// nothing is invented: every output was once a real state of the devices, and the distance says how far the live
// gesture is from it.
//
// Corpus  entries { id, x, y }: x is the input point (one number per input parameter, 0..1), y the stored output
//         state. Brute-force k-nearest search with per-dimension weights; a few thousand entries at 20 Hz is nothing
//         for a Pi, so no tree.
// Knot    the policy on top: k, randomness (CinemaKnot's "knotting"), hold (hysteresis), recall by id.
'use strict';
const { toDataset, pairDatasets } = require('./dataset.js');

const METRICS = {
  euclidean: (a, b, w) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += (w ? w[i] : 1) * d * d; } return Math.sqrt(s); },
  manhattan: (a, b, w) => { let s = 0; for (let i = 0; i < a.length; i++) s += (w ? w[i] : 1) * Math.abs(a[i] - b[i]); return s; },
};

class Corpus {
  constructor({ nIn, nOut, weights = null, metric = 'euclidean' } = {}) {
    this.nIn = Number(nIn); this.nOut = Number(nOut);
    if (!(this.nIn > 0) || !(this.nOut > 0)) throw new Error('corpus needs nIn and nOut > 0');
    this.metric = METRICS[metric] ? metric : 'euclidean';
    this.entries = []; this.byId = new Map();
    this.setWeights(weights);
  }
  /** per-input-dimension weights; missing or invalid entries count as 1 */
  setWeights(w) {
    if (!w || !w.length) { this.weights = null; return; }
    this.weights = Array.from({ length: this.nIn }, (_, i) => (Number.isFinite(w[i]) && w[i] >= 0 ? Number(w[i]) : 1));
    if (this.weights.every(v => v === 1)) this.weights = null;
  }
  get size() { return this.entries.length; }
  distance(a, b) { return METRICS[this.metric](a, b, this.weights); }

  /** add an entry, or replace the one with the same id; returns true if replaced */
  set(id, x, y) {
    id = String(id);
    if (!id) throw new Error('entry needs an id');
    if (x.length !== this.nIn || y.length !== this.nOut) throw new Error(`entry is ${x.length}->${y.length}, corpus is ${this.nIn}->${this.nOut}`);
    if (![...x, ...y].every(Number.isFinite)) throw new Error('entry has a non-finite value');
    const e = this.byId.get(id);
    if (e) { e.x = x.slice(); e.y = y.slice(); return true; }
    const n = { id, x: x.slice(), y: y.slice() };
    this.entries.push(n); this.byId.set(id, n);
    return false;
  }
  get(id) { return this.byId.get(String(id)) || null; }
  remove(id) {
    const e = this.byId.get(String(id));
    if (!e) return false;
    this.byId.delete(e.id); this.entries.splice(this.entries.indexOf(e), 1);
    return true;
  }
  clear() { this.entries = []; this.byId.clear(); }
  ids() { return this.entries.map(e => e.id); }
  /** a free FluCoMa-style id: point-<n>, n one above the highest in use */
  nextId() {
    let max = -1;
    for (const id of this.byId.keys()) { const m = /^point-(\d+)$/.exec(id); if (m) max = Math.max(max, Number(m[1])); }
    return 'point-' + (max + 1);
  }
  /** the k entries closest to x, nearest first: [{ id, distance, entry }]. Ties keep recording order. */
  nearest(x, k = 1) {
    if (x.length !== this.nIn) throw new Error(`query has ${x.length} values, corpus has ${this.nIn} inputs`);
    const all = this.entries.map(e => ({ id: e.id, distance: this.distance(x, e.x), entry: e }));
    all.sort((a, b) => a.distance - b.distance);
    return all.slice(0, Math.max(1, Math.round(k) || 1));
  }

  /** the corpus as a fluid.dataset pair, ids preserved: { in, out } */
  toDatasets() {
    const ids = this.ids();
    return { in: toDataset(this.entries.map(e => e.x), ids), out: toDataset(this.entries.map(e => e.y), ids) };
  }
  /** replace the contents from a fluid.dataset pair; throws (and keeps the old contents) if the shape does not fit */
  loadDatasets(jin, jout) {
    const { ids, X, Y, note } = pairDatasets(jin, jout);
    if (X.length && (X[0].length !== this.nIn || Y[0].length !== this.nOut)) throw new Error(`datasets are ${X[0].length}->${Y[0].length}, knot is ${this.nIn}->${this.nOut}`);
    this.clear();
    ids.forEach((id, i) => this.set(id, X[i], Y[i]));
    return note;
  }
}

/**
 * Retrieval policy over a Corpus.
 *   k           size of the candidate neighbourhood
 *   randomness  0: always the nearest entry. 1: any of the k nearest, chosen at random. In between: that chance of a
 *               random pick. The random choice (a "roll") is made when the nearest entry changes, or when a query is
 *               forced (an onset, `once`), never on every tick: a still input stays on one entry.
 *   hold        hysteresis in distance units: the current entry is kept while it is within `hold` of the nearest, so
 *               an input sitting on the boundary between two entries does not flicker between them.
 * A roll or a recall is a "sticky" choice: it is not the nearest, and it holds for as long as the nearest entry stays
 * the one it was made next to (its anchor). Once the input moves to another neighbourhood the choice is made again.
 * The result of every query reports the chosen id, its stored state y, the distance, whether the choice changed and
 * whether it was a roll, and the whole neighbourhood, so the performer sees what the knot saw.
 */
class Knot {
  constructor(corpus, { k = 3, randomness = 0, hold = 0, rng = Math.random } = {}) {
    this.corpus = corpus; this.rng = rng;
    this.k = k; this.randomness = randomness; this.hold = hold;
    this.current = null;       // id of the entry last chosen
    this.sticky = false;       // current was a roll or a recall, i.e. not necessarily the nearest
    this.anchor = null;        // for a sticky choice: id of the nearest entry when it was made; null = adopt the next neighbourhood seen
  }
  set k(v) { this._k = Math.max(1, Math.round(Number(v)) || 1); } get k() { return this._k; }
  set randomness(v) { this._r = Math.min(1, Math.max(0, Number(v) || 0)); } get randomness() { return this._r; }
  set hold(v) { this._h = Math.max(0, Number(v) || 0); } get hold() { return this._h; }

  /** forget the current choice */
  reset() { this.current = null; this.sticky = false; this.anchor = null; }
  /** the corpus changed under us: drop a choice that no longer exists; a sticky choice must pass the hold test again */
  touch() {
    if (this.current !== null && !this.corpus.get(this.current)) { this.reset(); return; }
    if (this.sticky) this.anchor = '';
  }

  /** query with input point x. roll=true forces a fresh choice (and a fresh random roll). null if the corpus is empty. */
  query(x, { roll = false } = {}) {
    const near = this.corpus.nearest(x, this.k);
    if (!near.length) { this.reset(); return null; }
    const best = near[0];
    const cur = this.current !== null ? this.corpus.get(this.current) : null;
    let choice = null, rolled = false;
    if (cur && !roll) {
      const dc = this.corpus.distance(x, cur.x), kept = { id: cur.id, distance: dc, entry: cur };
      if (cur.id === best.id) { choice = kept; this.sticky = false; this.anchor = best.id; }         // on the nearest: nothing to hold
      else if (this.sticky && this.anchor === null) { choice = kept; this.anchor = best.id; }        // a fresh recall adopts the neighbourhood it was made in
      else if (this.sticky && this.anchor === best.id) choice = kept;                                // a roll or recall holds while its neighbourhood stands
      else if (dc <= best.distance + this.hold) { choice = kept; this.anchor = best.id; }            // hysteresis, measured against the nearest of today
    }
    if (!choice) {
      choice = best; this.sticky = false; this.anchor = best.id;
      if (this.randomness > 0 && near.length > 1 && this.rng() < this.randomness) {
        choice = near[Math.min(near.length - 1, Math.floor(this.rng() * near.length))];
        rolled = true; this.sticky = choice.id !== best.id;
      }
    }
    const changed = choice.id !== this.current;
    this.current = choice.id;
    return { id: choice.id, y: choice.entry.y.slice(), distance: choice.distance, changed, rolled, neighbors: near.map(n => ({ id: n.id, distance: n.distance })) };
  }
  /** choose an entry by id, without a query (a cue). It holds until the input moves to a new neighbourhood. */
  recall(id) {
    const e = this.corpus.get(id);
    if (!e) return null;
    const changed = e.id !== this.current;
    this.current = e.id; this.sticky = true; this.anchor = null;
    return { id: e.id, y: e.y.slice(), distance: 0, changed, rolled: false, neighbors: [] };
  }
}

module.exports = { Corpus, Knot, METRICS };
