'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toDataset, pairDatasets } = require('../nodes/lib/dataset.js');
const ml = require('../nodes/pihub-ml.js');

test('toDataset: default ids and custom ids', () => {
  assert.deepEqual(toDataset([[1, 2], [3, 4]]), { cols: 2, data: { 'point-0': [1, 2], 'point-1': [3, 4] } });
  assert.deepEqual(toDataset([[1]], ['dark']), { cols: 1, data: { dark: [1] } });
  assert.deepEqual(toDataset([]), { cols: 0, data: {} });
});

test('pairDatasets: pairs by id, drops unpaired, rejects bad files', () => {
  const r = pairDatasets({ cols: 1, data: { 'point-1': [0.5], 'point-0': [0.1], extra: [1] } }, { cols: 1, data: { 'point-0': [0.9], 'point-1': [0.5] } });
  assert.deepEqual(r.ids, ['point-0', 'point-1']); assert.deepEqual(r.X, [[0.1], [0.5]]); assert.deepEqual(r.Y, [[0.9], [0.5]]); assert.match(r.note, /1 unpaired/);
  assert.throws(() => pairDatasets({}, {}), /not a fluid.dataset/);
  assert.throws(() => pairDatasets({ data: { a: [1, 'x'] } }, { data: { a: [1] } }), /bad row a/);
  assert.throws(() => pairDatasets({ data: { a: [1, 2], b: [1] } }, { data: { a: [1], b: [1] } }), /ragged/);
});

test('the ml mapper still exposes the same helpers', () => {
  assert.equal(typeof ml.lib.pairedDatasets, 'function'); assert.equal(typeof ml.lib.datasetToJSON, 'function');
  assert.deepEqual(ml.lib.datasetToJSON([[1]]), { cols: 1, data: { 'point-0': [1] } });
  assert.ok(ml.lib.LEARNERS['fluid-mlp'] && ml.lib.LEARNERS.knn);
});
