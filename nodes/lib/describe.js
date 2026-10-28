// Descriptors for a slow control stream, after CinemaKnot's SignalDescriptorExtractor but for gestures instead of
// audio. A device parameter arrives at ~20 Hz; over a sliding time window this reports where it is (mean), how much
// it shakes (dev), how fast it moves (speed) and how far it has swung (range), all 0..1 like everything else in the
// hub; and it detects onsets: a jump larger than a threshold within hopMs, with a refractory lockout so one jump
// is one onset (CinemaKnot: energy flux + refractory window). Time is whatever the caller passes in: give it a
// monotonic clock (performance.now()) and a stepping system clock cannot stall the windows.
'use strict';

class Describer {
  constructor({ windowMs = 500, hopMs = 100, speedScale = 1, onsetThreshold = 0.1, refractoryMs = 200 } = {}) {
    this.windowMs = Math.max(1, Number(windowMs) || 500);
    this.hopMs = Math.min(this.windowMs, Math.max(1, Number(hopMs) || 100));
    this.speedScale = Number(speedScale) > 0 ? Number(speedScale) : 1;       // units per second that count as speed 1
    this.onsetThreshold = Number(onsetThreshold) >= 0 ? Number(onsetThreshold) : 0.1;   // 0 is allowed: any change is an onset
    this.refractoryMs = Math.max(this.hopMs, Number(refractoryMs) || 0);      // never shorter than the hop, or one jump gives several onsets
    this.streams = new Map();                                                 // key -> { buf: [{t, v}], lastOnset }
  }
  forget(key) { this.streams.delete(key); }

  /** add a sample; returns the descriptors of the window ending at t: { mean, dev, speed, range, min, max, slope, n, onset } */
  push(key, v, t = Date.now()) {
    let s = this.streams.get(key);
    if (!s) { s = { buf: [], lastOnset: -Infinity }; this.streams.set(key, s); }
    const buf = s.buf;
    if (buf.length && t < buf[buf.length - 1].t) { buf.length = 0; s.lastOnset = -Infinity; }   // clock went backwards: start over
    buf.push({ t, v });
    while (buf.length && t - buf[0].t > this.windowMs) buf.shift();

    const n = buf.length;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const p of buf) { sum += p.v; if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
    const mean = sum / n;
    // deviation and least-squares slope (units per second) over the window
    const t0 = buf[0].t;
    let varSum = 0, st = 0, stt = 0, stv = 0;
    for (const p of buf) { const d = p.v - mean; varSum += d * d; const tt = (p.t - t0) / 1000; st += tt; stt += tt * tt; stv += tt * p.v; }
    const den = n * stt - st * st;
    const slope = n > 1 && den > 1e-12 ? (n * stv - st * sum) / den : 0;
    const dev = Math.min(1, 2 * Math.sqrt(varSum / n));                      // a 0/1 square wave has sd 0.5: scaled so that is 1
    const speed = Math.min(1, Math.abs(slope) / this.speedScale);

    // onset: compare with the sample hopMs ago (the newest one at or before t - hopMs)
    let onset = null;
    const tref = t - this.hopMs;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t > tref) continue;
      const delta = v - buf[i].v;
      if (Math.abs(delta) > this.onsetThreshold && t - s.lastOnset >= this.refractoryMs) { s.lastOnset = t; onset = { delta, from: buf[i].v, to: v }; }
      break;
    }
    return { mean, dev, speed, range: max - min, min, max, slope, n, onset };
  }
}

module.exports = { Describer };
