// k-nearest-neighbour regressor: the recorded dataset is the model, prediction is the
// inverse-distance-weighted mean of the k closest recorded inputs. No model file.
'use strict';

class KNN {
  constructor(k) { this.k = Math.max(1, Number(k) || 3); this.X = []; this.Y = []; }
  fit(X, Y) { this.X = X.map(r => r.slice()); this.Y = Y.map(r => r.slice()); return `${this.X.length} points, k=${this.k}`; }
  predict(x) {
    if (!this.X.length) throw new Error('knn has no data');
    const d = this.X.map((p, i) => ({ i, d: Math.sqrt(p.reduce((s, v, j) => s + (v - x[j]) ** 2, 0)) })).sort((a, b) => a.d - b.d).slice(0, this.k);
    if (d[0].d < 1e-9) return this.Y[d[0].i].slice();                       // exact hit
    const w = d.map(e => 1 / e.d), ws = w.reduce((a, b) => a + b, 0);
    return this.Y[0].map((_, j) => d.reduce((s, e, n) => s + w[n] * this.Y[e.i][j], 0) / ws);
  }
  toJSON() { return null; }
}

module.exports = {
  name: 'knn',
  modelFile: false,
  create(cfg) { return new KNN(cfg.k); },
  fromJSON() { throw new Error('knn has no model file'); },
  describe(cfg) { return `k=${Math.max(1, Number(cfg.k) || 3)}`; },
};
