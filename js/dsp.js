'use strict';
// Offline synthesis of instrument and drum samples in plain JS.
// Every tone is rendered once (additive partials with their own decays, like a
// real plucked string or struck bar), cached, and played back as an AudioBuffer.
// That sounds far richer than raw oscillators and costs almost nothing at playback.

const DSP = (() => {
  const SR = 48000;
  const MAX_CACHED = 240;
  const cache = new Map();
  let fallbackCtx = null;

  function setContext(ctx) { fallbackCtx = ctx; }

  function toBuffer(channels, rate = SR) {
    const len = channels[0].length;
    let b;
    try {
      b = new AudioBuffer({ length: len, sampleRate: rate, numberOfChannels: channels.length });
    } catch (e) {
      if (!fallbackCtx) throw e;
      b = fallbackCtx.createBuffer(channels.length, len, rate);
    }
    channels.forEach((d, i) => b.copyToChannel(d, i));
    return b;
  }

  function cached(key, make) {
    let b = cache.get(key);
    if (b) { cache.delete(key); cache.set(key, b); return b; }
    b = make();
    cache.set(key, b);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return b;
  }
  const has = (key) => cache.has(key);

  // xorshift noise in [-1, 1)
  function noise(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
  }

  // RBJ biquad, per-sample closure.
  function biquad(type, f, q = 0.707) {
    const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2;
    const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => {
      const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    };
  }

  // Sum of decaying partials. p = { r: ratio, a: amplitude, d: seconds to -60 dB }
  function additive(f, dur, partials, attack, seed) {
    const n = Math.ceil(dur * SR);
    const out = new Float32Array(n);
    const nyq = SR * 0.45;
    const rnd = noise(seed);
    const atk = Math.max(1, Math.round(attack * SR));
    for (const p of partials) {
      const fr = f * p.r;
      if (fr >= nyq || p.a <= 1e-4) continue;
      const w = (2 * Math.PI * fr) / SR;
      const c = Math.cos(w), s = Math.sin(w);
      const ph = rnd() * Math.PI;
      let re = Math.cos(ph), im = Math.sin(ph);
      const g = Math.exp(Math.log(0.001) / (Math.max(0.004, p.d) * SR));
      let a = p.a;
      const lim = Math.min(n, Math.ceil(Math.log(1e-5 / a) / Math.log(g)) + 1);
      for (let i = 0; i < lim; i++) {
        out[i] += a * im * (i < atk ? i / atk : 1);
        const nr = re * c - im * s;
        im = re * s + im * c;
        re = nr;
        a *= g;
        if ((i & 4095) === 4095) { const m = Math.hypot(re, im); re /= m; im /= m; }
      }
    }
    return out;
  }

  // Short filtered noise burst: pick, mallet or hammer contact.
  function addTransient(out, amp, decay, cutoff, seed) {
    const rnd = noise(seed);
    const lp = biquad('lp', cutoff, 0.7);
    const k = Math.exp(-1 / (decay * SR));
    const n = Math.min(out.length, Math.ceil(decay * 10 * SR));
    let env = amp;
    for (let i = 0; i < n; i++) { out[i] += lp(rnd()) * env; env *= k; }
  }

  function peakOf(d) {
    let m = 1e-9;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    return m;
  }

  // Normalise, trim the silent tail, fade the last few ms.
  function finish(out, peak) {
    const k = peak / peakOf(out);
    let last = out.length - 1;
    while (last > 0 && Math.abs(out[last] * k) < 2e-4) last--;
    const n = Math.min(out.length, last + Math.round(0.02 * SR));
    const res = out.subarray(0, n);
    const fade = Math.min(n, Math.round(0.012 * SR));
    for (let i = 0; i < n; i++) res[i] *= k;
    for (let i = 0; i < fade; i++) res[n - 1 - i] *= i / fade;
    return res;
  }

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---------- pitched instruments ----------
  const INSTRUMENTS = {
    // nylon-string guitar: plucked string, pick position notch, slight stiffness
    guitar(f, seed) {
      const P = [], beta = 0.18, B = 0.00005, sc = Math.pow(196 / f, 0.35);
      for (let k = 1; k <= 30; k++) {
        const a = (Math.abs(Math.sin(Math.PI * k * beta)) / Math.pow(k, 1.25)) * Math.exp(-0.07 * k);
        P.push({ r: k * Math.sqrt(1 + B * k * k), a, d: (2.6 * sc) / (1 + 0.24 * k) });
      }
      const out = additive(f, 2.8, P, 0.0012, seed);
      addTransient(out, 0.09, 0.003, 3200, seed + 11);
      return finish(out, 0.8);
    },
    // tine electric piano: strong fundamental, soft bell partials, pickup warmth
    rhodes(f, seed) {
      const sc = Math.pow(262 / f, 0.3);
      const P = [
        { r: 1, a: 1, d: 3.4 * sc }, { r: 2, a: 0.36, d: 1.7 * sc }, { r: 3, a: 0.12, d: 0.9 * sc },
        { r: 4, a: 0.07, d: 0.55 * sc }, { r: 5, a: 0.03, d: 0.35 }, { r: 6, a: 0.018, d: 0.25 },
        { r: 7.03, a: 0.05, d: 0.14 }, { r: 14.05, a: 0.04, d: 0.05 },
      ];
      const out = additive(f, 3.6, P, 0.0025, seed);
      const k = 1 / peakOf(out), drive = 1.7, norm = Math.tanh(drive);
      for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * k * drive) / norm;
      return finish(out, 0.8);
    },
    // vibraphone: long bar ring with the motor tremolo
    vibes(f, seed) {
      const P = [{ r: 1, a: 1, d: 3.6 }, { r: 4, a: 0.24, d: 0.7 }, { r: 10, a: 0.06, d: 0.16 }];
      const out = additive(f, 3.6, P, 0.0015, seed);
      addTransient(out, 0.04, 0.002, 4000, seed + 3);
      for (let i = 0; i < out.length; i++) out[i] *= 1 - 0.2 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 5.2 * i) / SR));
      return finish(out, 0.8);
    },
    kalimba(f, seed) {
      const P = [{ r: 1, a: 1, d: 1.7 }, { r: 2, a: 0.04, d: 0.5 }, { r: 5.93, a: 0.24, d: 0.22 }, { r: 13.1, a: 0.05, d: 0.04 }];
      const out = additive(f, 1.9, P, 0.0008, seed);
      addTransient(out, 0.07, 0.0015, 5000, seed + 5);
      return finish(out, 0.8);
    },
    marimba(f, seed) {
      const sc = Math.pow(440 / f, 0.5);
      const P = [{ r: 1, a: 1, d: 1.0 * sc }, { r: 3.93, a: 0.3, d: 0.16 * sc }, { r: 9.6, a: 0.08, d: 0.05 }];
      const out = additive(f, 1.6, P, 0.0012, seed);
      addTransient(out, 0.06, 0.003, 2400, seed + 7);
      return finish(out, 0.8);
    },
    musicbox(f, seed) {
      const P = [{ r: 1, a: 1, d: 2.0 }, { r: 2, a: 0.05, d: 0.6 }, { r: 6.27, a: 0.2, d: 0.28 }, { r: 17.55, a: 0.05, d: 0.06 }];
      const out = additive(f, 2.1, P, 0.0006, seed);
      addTransient(out, 0.03, 0.001, 7000, seed + 13);
      return finish(out, 0.8);
    },
    // glassy bell / celesta
    glass(f, seed) {
      const P = [{ r: 1, a: 1, d: 2.4 }, { r: 2.76, a: 0.34, d: 0.9 }, { r: 5.4, a: 0.15, d: 0.4 }, { r: 8.93, a: 0.06, d: 0.18 }];
      const out = additive(f, 2.6, P, 0.001, seed);
      return finish(out, 0.8);
    },
    // analogue-style saw pluck: upper harmonics die first, like a closing filter
    sawpluck(f, seed) {
      const P = [];
      for (let k = 1; k <= 60; k++) {
        const d = 0.9 / (1 + 0.42 * k);
        P.push({ r: k, a: 1 / k, d }, { r: k * 1.0058, a: 0.55 / k, d });
      }
      const out = additive(f, 1.5, P, 0.002, seed);
      return finish(out, 0.8);
    },
  };

  function note(inst, midi) {
    const key = `n:${inst}:${midi}`;
    return cached(key, () => toBuffer([(INSTRUMENTS[inst] || INSTRUMENTS.guitar)(mtof(midi), midi * 131 + inst.length)]));
  }
  const noteKey = (inst, midi) => `n:${inst}:${midi}`;
  const isSampled = (inst) => !!INSTRUMENTS[inst];

  // ---------- drums ----------
  function kick(o, seed) {
    const n = Math.ceil(o.len * SR), out = new Float32Array(n), rnd = noise(seed);
    const hp = biquad('hp', 1800, 0.7);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.pd);
      ph += (2 * Math.PI * f) / SR;
      let y = (o.square ? Math.sign(Math.sin(ph)) * 0.6 : Math.sin(ph)) * Math.min(1, t / 0.0008) * Math.exp(-t / o.ad);
      y += hp(rnd()) * o.click * Math.exp(-t / 0.0025);
      out[i] = Math.tanh(y * o.drive) / Math.tanh(o.drive);
    }
    if (o.lp) { const lp = biquad('lp', o.lp, 0.7); for (let i = 0; i < n; i++) out[i] = lp(out[i]); }
    return finish(out, 0.95);
  }

  function snare(o, seed) {
    const n = Math.ceil(o.len * SR), out = new Float32Array(n), rnd = noise(seed);
    const hp = biquad('hp', o.hp, 0.7), lp = biquad('lp', o.lp, 0.7);
    let p1 = 0, p2 = 0, hold = 0, held = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const bend = 1 + 0.35 * Math.exp(-t / 0.012);
      p1 += (2 * Math.PI * o.t1 * bend) / SR;
      p2 += (2 * Math.PI * o.t2 * bend) / SR;
      const tone = (Math.sin(p1) * 0.65 + Math.sin(p2) * 0.35) * Math.exp(-t / o.td);
      let x = rnd();
      if (o.crush) { if (hold-- <= 0) { held = x; hold = o.crush; } x = held; }
      const nz = lp(hp(x)) * Math.exp(-t / o.nd);
      out[i] = (tone * o.mix + nz * (1 - o.mix) * 2) * Math.min(1, t / 0.0006);
    }
    return finish(out, 0.9);
  }

  function clap(o, seed) {
    const n = Math.ceil(o.len * SR), out = new Float32Array(n), rnd = noise(seed);
    const bp = biquad('bp', 1250, 1.1), hp = biquad('hp', 500, 0.7);
    const bursts = [0, 0.011, 0.023, 0.036];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let env = 0;
      for (const b of bursts) if (t >= b) env += Math.exp(-(t - b) / 0.004);
      if (t >= 0.036) env += 0.7 * Math.exp(-(t - 0.036) / o.tail);
      out[i] = hp(bp(rnd())) * env;
    }
    return finish(out, 0.85);
  }

  function rim(o, seed) {
    const n = Math.ceil(0.12 * SR), out = new Float32Array(n), rnd = noise(seed);
    const hp = biquad('hp', 2500, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = (Math.sin(2 * Math.PI * 1720 * t) * 0.6 + Math.sin(2 * Math.PI * 830 * t) * 0.4) * Math.exp(-t / o.decay) + hp(rnd()) * 0.5 * Math.exp(-t / 0.003);
    }
    return finish(out, 0.8);
  }

  // 808-style metallic hats: six detuned square waves, high-passed.
  function metal(o, seed) {
    const n = Math.ceil((o.decay * 5 + 0.02) * SR), out = new Float32Array(n), rnd = noise(seed);
    const fr = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].map((x) => x * (o.tune || 1));
    const ph = new Float64Array(6);
    const hp1 = biquad('hp', o.hp, 0.9), hp2 = biquad('hp', o.hp, 0.9);
    let hold = 0, held = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let s = 0;
      for (let j = 0; j < 6; j++) { ph[j] += fr[j] / SR; s += ph[j] % 1 < 0.5 ? 1 : -1; }
      let x = s / 6 * (1 - o.noise) + rnd() * o.noise;
      if (o.crush) { if (hold-- <= 0) { held = x; hold = o.crush; } x = held; }
      out[i] = hp2(hp1(x)) * Math.min(1, t / (o.attack || 0.0004)) * Math.exp(-t / o.decay);
    }
    return finish(out, o.peak || 0.75);
  }

  function shaker(o, seed) {
    const n = Math.ceil(0.25 * SR), out = new Float32Array(n), rnd = noise(seed);
    const hp = biquad('hp', 5200, 0.8), lp = biquad('lp', 11000, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = lp(hp(rnd())) * Math.min(1, t / 0.008) * Math.exp(-t / 0.045);
    }
    return finish(out, 0.6);
  }

  const KITS = {
    lofi: {
      kick: () => kick({ f0: 118, f1: 46, pd: 0.03, ad: 0.19, click: 0.1, drive: 1.7, len: 0.55, lp: 3200 }, 1),
      snare: () => snare({ t1: 188, t2: 342, td: 0.07, nd: 0.15, hp: 900, lp: 6500, mix: 0.36, len: 0.34 }, 2),
      rim: () => rim({ decay: 0.022 }, 3),
      hat: () => metal({ decay: 0.042, hp: 6800, noise: 0.45, tune: 1, peak: 0.6 }, 4),
      ohat: () => metal({ decay: 0.24, hp: 6500, noise: 0.45, tune: 1, peak: 0.55 }, 5),
      shaker: () => shaker({}, 6),
      crash: () => metal({ decay: 0.9, hp: 3500, noise: 0.6, tune: 1.4, peak: 0.6 }, 7),
    },
    synth: {
      kick: () => kick({ f0: 165, f1: 49, pd: 0.036, ad: 0.3, click: 0.3, drive: 2.4, len: 0.65 }, 11),
      snare: () => snare({ t1: 180, t2: 330, td: 0.09, nd: 0.2, hp: 1400, lp: 11000, mix: 0.4, len: 0.4 }, 12),
      clap: () => clap({ len: 0.4, tail: 0.13 }, 13),
      hat: () => metal({ decay: 0.035, hp: 7600, noise: 0.25, tune: 1.05, peak: 0.6 }, 14),
      ohat: () => metal({ decay: 0.3, hp: 7400, noise: 0.25, tune: 1.05, peak: 0.55 }, 15),
      crash: () => metal({ decay: 1.3, hp: 3200, noise: 0.5, tune: 1.35, peak: 0.65 }, 16),
    },
    chip: {
      kick: () => kick({ f0: 230, f1: 52, pd: 0.022, ad: 0.11, click: 0, drive: 3, len: 0.25, square: true }, 21),
      snare: () => snare({ t1: 240, t2: 420, td: 0.03, nd: 0.1, hp: 1500, lp: 9000, mix: 0.2, len: 0.2, crush: 6 }, 22),
      hat: () => metal({ decay: 0.022, hp: 8000, noise: 0.9, tune: 1, crush: 3, peak: 0.55 }, 23),
      ohat: () => metal({ decay: 0.12, hp: 7500, noise: 0.9, tune: 1, crush: 3, peak: 0.5 }, 24),
      crash: () => metal({ decay: 0.6, hp: 4000, noise: 0.95, tune: 1, crush: 4, peak: 0.55 }, 25),
    },
    ambient: {
      kick: () => kick({ f0: 90, f1: 42, pd: 0.05, ad: 0.35, click: 0.02, drive: 1.2, len: 0.8, lp: 900 }, 31),
      rim: () => rim({ decay: 0.03 }, 32),
      shaker: () => shaker({}, 33),
      crash: () => metal({ decay: 1.8, hp: 5000, noise: 0.7, tune: 1.5, attack: 0.02, peak: 0.5 }, 34),
    },
  };

  function drum(kit, name) {
    const k = KITS[kit] || KITS.lofi;
    if (name === 'swell') {
      return cached(`d:${kit}:swell`, () => {
        const src = (k.crash || KITS.lofi.crash)().slice(0, Math.round(1.4 * SR));
        src.reverse();
        const n = src.length;
        for (let i = 0; i < n; i++) src[i] *= Math.pow(i / n, 1.6);
        return toBuffer([finish(src, 0.6)]);
      });
    }
    const make = k[name] || KITS.lofi[name];
    if (!make) return null;
    return cached(`d:${kit}:${name}`, () => toBuffer([make()]));
  }

  // ---------- atmosphere ----------
  // Vinyl: soft hiss, rare pops and a little rumble. Loops seamlessly (it is noise).
  function crackle() {
    return cached('fx:crackle', () => {
      const n = 5 * SR, out = new Float32Array(n), rnd = noise(99), u = noise(123);
      const hp = biquad('hp', 900, 0.7), lp = biquad('lp', 6500, 0.7), rum = biquad('lp', 40, 0.7);
      for (let i = 0; i < n; i++) {
        let x = rnd() * 0.02;
        if ((u() + 1) / 2 < 11 / SR) x += Math.pow((u() + 1) / 2, 3) * (u() > 0 ? 1 : -1) * 0.9;
        out[i] = lp(hp(x)) + rum(rnd()) * 0.4;
      }
      return toBuffer([finish(out, 0.3)]);
    });
  }

  // Stereo plate-like impulse response: early reflections plus a darkening tail.
  // Rendered at the context's own rate: ConvolverNode refuses to resample.
  function impulse(seconds, key, rate = SR) {
    return cached(`fx:ir:${key}:${seconds}:${rate}`, () => {
      const n = Math.ceil(seconds * rate), pre = Math.round(0.012 * rate);
      const chans = [new Float32Array(n), new Float32Array(n)];
      chans.forEach((d, ch) => {
        const rnd = noise(1000 + ch * 77);
        [7, 11, 17, 23, 31, 41].forEach((ms, j) => {
          const i = pre + Math.round((ms + ch * 1.7) * rate / 1000);
          if (i < n) d[i] += (ch ? -1 : 1) * 0.5 * Math.pow(0.8, j);
        });
        let lp = 0;
        for (let i = pre; i < n; i++) {
          const x = (i - pre) / (n - pre);
          lp += (rnd() - lp) * (0.08 + 0.75 * Math.pow(1 - x, 2));
          d[i] += lp * Math.exp(-x * 6.9) * 0.9;
        }
      });
      const m = Math.max(peakOf(chans[0]), peakOf(chans[1]));
      chans.forEach((d) => { for (let i = 0; i < n; i++) d[i] /= m; });
      return toBuffer(chans, rate);
    });
  }

  // Render any missing samples in small slices so the page stays responsive.
  async function prepare(keys, onProgress) {
    const todo = keys.filter((k) => !cache.has(k.key));
    let t0 = performance.now();
    for (let i = 0; i < todo.length; i++) {
      todo[i].make();
      if (performance.now() - t0 > 24) {
        if (onProgress) onProgress(i / todo.length);
        await new Promise((r) => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
    if (onProgress) onProgress(1);
  }

  return { SR, note, noteKey, isSampled, drum, crackle, impulse, prepare, has, setContext, INSTRUMENTS: Object.keys(INSTRUMENTS) };
})();
