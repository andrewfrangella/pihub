// fluid.dataset helpers shared by the ml mapper and the knot.
// A fluid.dataset is { cols: N, data: { "<id>": [N numbers], ... } }. FluCoMa names ids "point-0", "point-1", ...;
// the knot uses the id as the entry's label ("dark", "needle-drop-2"), which fluid.dataset allows.
'use strict';

// point-N ids sort numerically (FluCoMa order); any other ids keep the order they have in the file (the sort is stable)
const idOrder = k => (/^point-\d+$/.test(k) ? [0, Number(k.slice(6))] : [1, 0]);
const cmpId = (a, b) => { const x = idOrder(a), y = idOrder(b); return x[0] - y[0] || x[1] - y[1]; };

/** rows -> fluid.dataset. ids default to point-0, point-1, ... */
function toDataset(rows, ids) {
  return { cols: rows.length ? rows[0].length : 0, data: Object.fromEntries(rows.map((r, i) => [ids ? String(ids[i]) : 'point-' + i, r.slice()])) };
}

/** two fluid.datasets -> { ids, X, Y, note }, paired by id like FluCoMa does; ids present in only one file are dropped */
function pairDatasets(jin, jout) {
  if (!jin || typeof jin.data !== 'object' || !jin.data || !jout || typeof jout.data !== 'object' || !jout.data) throw new Error('not a fluid.dataset (no "data" object)');
  const a = jin.data, b = jout.data, has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const ids = Object.keys(a).filter(k => has(b, k)).sort(cmpId);
  const dropped = Object.keys(a).length + Object.keys(b).length - 2 * ids.length;
  const row = (d, k) => { const r = d[k]; if (!Array.isArray(r) || !r.length || !r.every(Number.isFinite)) throw new Error('bad row ' + k); return r.map(Number); };
  const X = ids.map(k => row(a, k)), Y = ids.map(k => row(b, k));
  if (X.some(r => r.length !== X[0].length) || Y.some(r => r.length !== Y[0].length)) throw new Error('ragged dataset');
  return { ids, X, Y, note: dropped ? ` (${dropped} unpaired ids dropped)` : '' };
}

module.exports = { toDataset, pairDatasets, cmpId };
