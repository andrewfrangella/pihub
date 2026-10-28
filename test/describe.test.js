'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Describer } = require('../nodes/lib/describe.js');

const feed = (d, key, values, dt = 50, t0 = 1000) => { let r; values.forEach((v, i) => { r = d.push(key, v, t0 + i * dt); }); return r; };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('a steady value: mean = value, no dev, speed, range or onset', () => {
  const d = new Describer({ windowMs: 500 });
  const r = feed(d, 'tv/m', new Array(20).fill(0.3));
  near(r.mean, 0.3); near(r.dev, 0); near(r.speed, 0); near(r.range, 0); assert.equal(r.onset, null);
  assert.equal(r.n, 11);                                             // 500 ms window at 20 Hz holds 11 samples
});

test('a ramp: speed is the slope over the speed scale', () => {
  const d = new Describer({ windowMs: 1000, speedScale: 1 });
  // 0 -> 1 over 2 s: slope 0.5 / s
  const r = feed(d, 'x', Array.from({ length: 41 }, (_, i) => i / 40));
  near(r.speed, 0.5, 1e-3); near(r.slope, 0.5, 1e-3);
  const d2 = new Describer({ windowMs: 1000, speedScale: 0.25 });
  near(feed(d2, 'x', Array.from({ length: 41 }, (_, i) => i / 40)).speed, 1);   // clamped
});

test('a square wave fills the deviation and range scales', () => {
  const d = new Describer({ windowMs: 1000 });
  const r = feed(d, 'x', Array.from({ length: 40 }, (_, i) => i % 2));
  near(r.dev, 1, 0.01); near(r.range, 1); near(r.mean, 0.5, 0.03);     // 21 samples in the window: not exactly 0.5
});

test('onset: one jump, one pulse, then refractory', () => {
  const d = new Describer({ windowMs: 500, hopMs: 100, onsetThreshold: 0.1, refractoryMs: 200 });
  const vals = [...new Array(10).fill(0.1), ...new Array(10).fill(0.9)];
  const onsets = [];
  vals.forEach((v, i) => { const r = d.push('x', v, 1000 + i * 50); if (r.onset) onsets.push({ i, ...r.onset }); });
  assert.equal(onsets.length, 1);
  assert.equal(onsets[0].i, 10); near(onsets[0].delta, 0.8); near(onsets[0].from, 0.1); near(onsets[0].to, 0.9);
  // a slow sine with small noise never triggers
  const d2 = new Describer({ windowMs: 500, hopMs: 100, onsetThreshold: 0.1 });
  let count = 0;
  for (let i = 0; i < 400; i++) { const t = i * 0.05; if (d2.push('s', 0.5 + 0.4 * Math.sin(t * 0.3) + (i % 2 ? 0.01 : -0.01), 1000 + i * 50).onset) count++; }
  assert.equal(count, 0);
});

test('onset: refractory blocks a second jump inside the lockout but not after', () => {
  const d = new Describer({ windowMs: 1000, hopMs: 100, onsetThreshold: 0.2, refractoryMs: 300 });
  const hits = [];
  const series = [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1];           // jumps at i=3 (t=1150), i=6 (t=1300, inside lockout), i=12 (t=1600)
  series.forEach((v, i) => { if (d.push('x', v, 1000 + i * 50).onset) hits.push(i); });
  assert.deepEqual(hits, [3, 12]);
});

test('streams are independent and a backwards clock restarts the window', () => {
  const d = new Describer({ windowMs: 500 });
  feed(d, 'a', [0, 0, 0]); feed(d, 'b', [1, 1, 1]);
  near(d.push('a', 0, 1200).mean, 0); near(d.push('b', 1, 1200).mean, 1);
  const r = d.push('a', 0.7, 100);                                    // earlier than the last sample
  assert.equal(r.n, 1); near(r.mean, 0.7);
  d.forget('a'); assert.equal(d.streams.has('a'), false);
});

test('options are sanitised', () => {
  const d = new Describer({ windowMs: -5, hopMs: 9999, speedScale: 0, onsetThreshold: 'x', refractoryMs: -1 });
  assert.equal(d.windowMs, 1); assert.equal(d.hopMs, 1); assert.equal(d.speedScale, 1); assert.equal(d.onsetThreshold, 0.1); assert.equal(d.refractoryMs, 1);   // refractory is raised to the hop
});

test('onset: refractory is never shorter than the hop, so one jump is one onset', () => {
  const d = new Describer({ windowMs: 500, hopMs: 100, onsetThreshold: 0.1, refractoryMs: 0 });
  assert.equal(d.refractoryMs, 100);
  const vals = [...new Array(10).fill(0.1), ...new Array(10).fill(0.9)];
  let count = 0; vals.forEach((v, i) => { if (d.push('x', v, 1000 + i * 50).onset) count++; });
  assert.equal(count, 1);
});

test('onset: a clock that steps backwards does not lock the detector', () => {
  const d = new Describer({ windowMs: 500, hopMs: 100, onsetThreshold: 0.1, refractoryMs: 200 });
  let t = 100000;
  for (let i = 0; i < 10; i++) d.push('x', 0.1, t += 50);
  assert.ok(d.push('x', 0.9, t += 50).onset);                     // first jump fires and sets lastOnset
  t -= 60000;                                                     // the system clock is set back a minute
  for (let i = 0; i < 10; i++) d.push('x', 0.9, t += 50);
  assert.ok(d.push('x', 0.1, t += 50).onset, 'onset after a backwards clock step');
});

test('threshold 0 is honoured, not replaced by the default', () => {
  assert.equal(new Describer({ onsetThreshold: 0 }).onsetThreshold, 0);
  assert.equal(new Describer({ onsetThreshold: -1 }).onsetThreshold, 0.1);
});
