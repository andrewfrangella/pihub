// FluCoMa-compatible MLP regressor.
// JSON: { layers: [ { activation, biases[cols], cols, rows, weights[rows][cols] } ] }   (fluid.mlpregressor)
// activation: 0 identity, 1 sigmoid, 2 relu, 3 tanh.  A layer computes act(x·W + b); W is rows(in) x cols(out).
'use strict';

const ACT_NAME = { 0: 'identity', 1: 'sigmoid', 2: 'relu', 3: 'tanh' };
function act(a, z) {
  switch (a) { case 0: return z; case 1: return 1 / (1 + Math.exp(-z)); case 2: return z > 0 ? z : 0; case 3: return Math.tanh(z); default: throw new Error('unknown activation ' + a); }
}
function dact(a, y) {            // derivative in terms of the layer output y
  switch (a) { case 0: return 1; case 1: return y * (1 - y); case 2: return y > 0 ? 1 : 0; case 3: return 1 - y * y; default: throw new Error('unknown activation ' + a); }
}

class FluidMLP {
  constructor(layers, opts = {}) {
    if (!Array.isArray(layers) || !layers.length) throw new Error('model has no layers');
    this.layers = layers.map(l => {
      const W = l.weights.map(r => r.map(Number)), b = l.biases.map(Number), a = Number(l.activation);
      if (W.length !== l.rows || W.some(r => r.length !== l.cols) || b.length !== l.cols) throw new Error('layer shape mismatch');
      if (!(a in ACT_NAME) || W.flat().some(v => !Number.isFinite(v)) || b.some(v => !Number.isFinite(v))) throw new Error('bad layer values');
      if (!W.length) throw new Error('layer with no rows');
      return { W, b, a };
    });
    for (let i = 1; i < this.layers.length; i++)
      if (this.layers[i].W.length !== this.layers[i - 1].b.length) throw new Error(`layer ${i} expects ${this.layers[i].W.length} inputs but layer ${i - 1} has ${this.layers[i - 1].b.length} outputs`);
    this.epochs = opts.epochs || 2000; this.lr = opts.lr || 0.01;
  }
  get nIn()  { return this.layers[0].W.length; }
  get nOut() { return this.layers[this.layers.length - 1].b.length; }

  static create(sizes, hiddenAct, outAct, seed = 1, opts) {
    let s = (seed >>> 0) || 1;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const layers = [];
    for (let i = 0; i < sizes.length - 1; i++) {
      const rows = sizes[i], cols = sizes[i + 1], dev = Math.sqrt(6 / (rows + cols));   // same init range as FluCoMa
      layers.push({ activation: i === sizes.length - 2 ? outAct : hiddenAct, rows, cols,
        weights: Array.from({ length: rows }, () => Array.from({ length: cols }, () => (rnd() * 2 - 1) * dev)),
        biases: new Array(cols).fill(0) });
    }
    return new FluidMLP(layers, opts);
  }
  forwardAll(x) {
    const acts = [x]; let h = x;
    for (const { W, b, a } of this.layers) {
      const out = new Array(b.length);
      for (let j = 0; j < b.length; j++) { let z = b[j]; for (let i = 0; i < h.length; i++) z += h[i] * W[i][j]; out[j] = act(a, z); }
      acts.push(out); h = out;
    }
    return acts;
  }
  predict(x) { const acts = this.forwardAll(x); return acts[acts.length - 1]; }
  toJSON() { return { layers: this.layers.map(({ W, b, a }) => ({ activation: a, biases: b.slice(), cols: b.length, rows: W.length, weights: W.map(r => r.slice()) })) }; }

  // full-batch Adam on mean squared error; a few dozen gesture pairs train in milliseconds
  fit(X, Y) {
    const L = this.layers, N = X.length, epochs = this.epochs, lr = this.lr, tol = 1e-7;
    const mW = L.map(l => l.W.map(r => r.map(() => 0))), vW = L.map(l => l.W.map(r => r.map(() => 0)));
    const mb = L.map(l => l.b.map(() => 0)), vb = L.map(l => l.b.map(() => 0));
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const t0 = Date.now(); let loss = Infinity, ep = 0;
    for (ep = 1; ep <= epochs; ep++) {
      const gW = L.map(l => l.W.map(r => r.map(() => 0))), gb = L.map(l => l.b.map(() => 0));
      loss = 0;
      for (let n = 0; n < N; n++) {
        const acts = this.forwardAll(X[n]), y = acts[acts.length - 1];
        let delta = y.map((v, j) => { const e = v - Y[n][j]; loss += e * e; return 2 * e * dact(L[L.length - 1].a, v) / (N * y.length); });
        for (let li = L.length - 1; li >= 0; li--) {
          const inp = acts[li], { W } = L[li];
          for (let j = 0; j < delta.length; j++) { gb[li][j] += delta[j]; for (let i = 0; i < inp.length; i++) gW[li][i][j] += inp[i] * delta[j]; }
          if (li > 0) {
            const prev = new Array(inp.length);
            for (let i = 0; i < inp.length; i++) { let s = 0; for (let j = 0; j < delta.length; j++) s += W[i][j] * delta[j]; prev[i] = s * dact(L[li - 1].a, inp[i]); }
            delta = prev;
          }
        }
      }
      loss /= N * Y[0].length;
      if (loss < tol) break;
      const c1 = 1 - Math.pow(b1, ep), c2 = 1 - Math.pow(b2, ep);
      for (let li = 0; li < L.length; li++) {
        const { W, b } = L[li];
        for (let i = 0; i < W.length; i++) for (let j = 0; j < W[i].length; j++) {
          mW[li][i][j] = b1 * mW[li][i][j] + (1 - b1) * gW[li][i][j]; vW[li][i][j] = b2 * vW[li][i][j] + (1 - b2) * gW[li][i][j] ** 2;
          W[i][j] -= lr * (mW[li][i][j] / c1) / (Math.sqrt(vW[li][i][j] / c2) + eps);
        }
        for (let j = 0; j < b.length; j++) {
          mb[li][j] = b1 * mb[li][j] + (1 - b1) * gb[li][j]; vb[li][j] = b2 * vb[li][j] + (1 - b2) * gb[li][j] ** 2;
          b[j] -= lr * (mb[li][j] / c1) / (Math.sqrt(vb[li][j] / c2) + eps);
        }
      }
    }
    return `mse=${loss.toExponential(2)} after ${Math.min(ep, epochs)} epochs, ${Date.now() - t0} ms`;
  }
}

module.exports = {
  name: 'fluid-mlp',
  modelFile: true,
  ACT_NAME,
  FluidMLP,
  create(cfg) {
    const hidden = (cfg.hidden && cfg.hidden.length) ? cfg.hidden : [8];
    return FluidMLP.create([cfg.nIn, ...hidden, cfg.nOut], Number(cfg.activation ?? 3), 0, 1, { epochs: cfg.epochs, lr: cfg.lr });
  },
  fromJSON(json, cfg) {
    const m = new FluidMLP(json.layers, { epochs: cfg.epochs, lr: cfg.lr });
    if (m.nIn !== cfg.nIn || m.nOut !== cfg.nOut) throw new Error(`model is ${m.nIn}->${m.nOut}, node is ${cfg.nIn}->${cfg.nOut}`);
    return m;
  },
  describe(cfg) { return `hidden=[${(cfg.hidden && cfg.hidden.length) ? cfg.hidden : [8]}] act=${ACT_NAME[Number(cfg.activation ?? 3)]}`; },
};
