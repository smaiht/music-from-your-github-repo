'use strict';
// Web Audio playback. Plucked, struck and keyboard tones are pre-rendered
// samples (see dsp.js); pads, basses and 8-bit voices are live oscillators.
// Every style gets its own effect rack: reverb, ping-pong delay, chorus,
// tremolo, sidechain ducking, tape wow, vinyl crackle, saturation, EQ,
// glue compression and a limiter. The same code renders live and offline.

const Engine = (() => {
  let ctx = null;
  const BUSES = ['lead', 'arp', 'orn', 'comp', 'pad', 'bass', 'drums'];
  // UI layers → buses
  const LAYERS = { lead: ['lead'], arp: ['arp', 'orn'], chords: ['comp', 'pad'], bass: ['bass'], drums: ['drums'] };
  const BUS_LEVEL = { lead: 0.95, arp: 0.5, orn: 0.45, comp: 0.5, pad: 0.4, bass: 0.9, drums: 0.8 };
  // Measured so every instrument plays at a similar loudness (bright ones slightly lower).
  const INST_GAIN = {
    guitar: 1.15, rhodes: 0.54, vibes: 0.72, kalimba: 1, marimba: 1.28, musicbox: 0.9, glass: 0.96, sawpluck: 1.75,
    pulse50: 0.3, pulse25: 0.48, pulse12: 0.7, tri: 0.55,
  };
  const DRUM_GAIN = { kick: 1, snare: 0.7, clap: 0.65, rim: 0.45, hat: 0.35, ohat: 0.3, shaker: 0.3, crash: 0.35, swell: 0.4 };
  const DRUM_PAN = { hat: 0.22, ohat: 0.22, shaker: -0.3, rim: -0.12, crash: -0.15, swell: 0 };

  function context() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('This browser doesn’t support Web Audio.');
      ctx = new AC({ latencyHint: 'interactive' });
      DSP.setContext(ctx);
    }
    return ctx;
  }

  let silentEl = null;
  // Call from inside a click/tap handler.
  function unlock() {
    const c = context();
    if (c.state !== 'running') c.resume().catch(() => {});
    try {
      const b = c.createBuffer(1, 1, c.sampleRate);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) { /* ignore */ }
    // iOS routes Web Audio to the ringer channel until a media element plays.
    if (!silentEl && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
      try {
        silentEl = document.createElement('audio');
        silentEl.setAttribute('x-webkit-airplay', 'deny');
        silentEl.preload = 'auto';
        silentEl.loop = true;
        silentEl.src = silentWavUri();
        silentEl.play().catch(() => {});
      } catch (e) { /* ignore */ }
    }
    return c;
  }

  // Resolves true if sound can start without a click. Browsers keep a context created
  // before any user gesture suspended, and resume() then never settles (Chrome) or rejects.
  function canStart(timeout = 300) {
    let c;
    try { c = context(); } catch (e) { return Promise.resolve(false); }
    if (c.state === 'running') return Promise.resolve(true);
    if (navigator.getAutoplayPolicy && navigator.getAutoplayPolicy(c) === 'disallowed') return Promise.resolve(false);
    return new Promise((done) => {
      const check = () => done(c.state === 'running');
      c.resume().then(check, check);
      setTimeout(check, timeout);
    });
  }

  function silentWavUri() {
    const n = 800, sr = 8000;
    const b = new Uint8Array(44 + n);
    const v = new DataView(b.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
  }

  // ---------- building blocks ----------
  const gain = (c, v) => { const g = c.createGain(); g.gain.value = v; return g; };
  function pan(c, value) {
    if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = U.clamp(value, -1, 1); return p; }
    return c.createGain();
  }
  function filt(c, type, f, q, g) {
    const b = c.createBiquadFilter();
    b.type = type; b.frequency.value = f;
    if (q != null) b.Q.value = q;
    if (g != null) b.gain.value = g;
    return b;
  }
  function osc(c, type, f) { const o = c.createOscillator(); o.type = type; o.frequency.value = f; return o; }
  function lfo(c, rate, depth, target, rig) {
    const o = osc(c, 'sine', rate), g = gain(c, depth);
    o.connect(g).connect(target);
    o.start();
    rig.lfos.push(o);
    return o;
  }
  function tanhCurve(drive) {
    const n = 2048, curve = new Float32Array(n), norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * drive) / norm; }
    return curve;
  }

  // ---------- the rack ----------
  class Rig {
    constructor(c, styleKey, raw) {
      this.c = c;
      this.styleKey = styleKey;
      const st = Styles.get(styleKey), fx = st.fx;
      this.style = st;
      this.lfos = [];
      this.pulses = {};

      // Master: pre → EQ → [drive → wow → lowpass] → glue comp → volume → limiter
      this.pre = gain(c, 1);
      const eqLow = filt(c, 'lowshelf', 110, null, fx.eq[0]);
      const eqMid = filt(c, 'peaking', 380, 0.9, fx.eq[1]);
      const eqHigh = filt(c, 'highshelf', 7500, null, fx.eq[2]);
      this.fxIn = gain(c, 1);
      this.pre.connect(eqLow).connect(eqMid).connect(eqHigh).connect(this.fxIn);
      this.post = gain(c, 1);
      this.wet = gain(c, 1);
      this.dry = gain(c, 0);
      const shaper = c.createWaveShaper();
      shaper.curve = tanhCurve(Math.max(1.0001, fx.drive));
      shaper.oversample = '2x';
      const trim = gain(c, 1 / Math.max(1, 0.55 + 0.45 * fx.drive));
      let tail = this.fxIn.connect(shaper).connect(trim);
      if (fx.wow) {
        const wow = c.createDelay(0.05);
        wow.delayTime.value = 0.008;
        lfo(c, 0.55, 0.00022 * fx.wow, wow.delayTime, this);
        lfo(c, 6.3, 0.00004 * fx.wow, wow.delayTime, this);
        tail = tail.connect(wow);
      }
      if (fx.lowpass) tail = tail.connect(filt(c, 'lowpass', fx.lowpass, 0.5));
      tail.connect(this.wet).connect(this.post);
      this.fxIn.connect(this.dry).connect(this.post);
      this.crackleIn = gain(c, fx.crackle || 0);
      this.crackleIn.connect(this.post);

      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 8; comp.ratio.value = 2.5; comp.attack.value = 0.012; comp.release.value = 0.22;
      this.master = gain(c, 0.85);
      const lim = c.createDynamicsCompressor();
      lim.threshold.value = -2.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
      this.analyser = c.createAnalyser();
      this.analyser.fftSize = 1024;
      // raw: measurement mode without the master dynamics (used for balancing the mix)
      const last = raw ? this.post.connect(this.master) : this.post.connect(comp).connect(this.master).connect(lim);
      last.connect(this.analyser);
      last.connect(c.destination);
      this.levelBuf = new Float32Array(this.analyser.fftSize);

      // Sends: plate reverb, ping-pong delay (dotted 8th), stereo chorus.
      this.revIn = gain(c, 1);
      const rev = c.createConvolver();
      rev.buffer = DSP.impulse(fx.ir, styleKey, c.sampleRate);
      this.revIn.connect(filt(c, 'highpass', 180, 0.7)).connect(rev).connect(this.pre);

      this.dlyIn = gain(c, 1);
      this.dl = c.createDelay(3); this.dr = c.createDelay(3);
      const dlp = filt(c, 'lowpass', 3200, 0.5), dhp = filt(c, 'highpass', 300, 0.5);
      const fbA = gain(c, 0.36), fbB = gain(c, 0.36);
      this.dlyIn.connect(dhp).connect(this.dl);
      this.dl.connect(pan(c, -0.65)).connect(this.pre);
      this.dl.connect(dlp).connect(fbA).connect(this.dr);
      this.dr.connect(pan(c, 0.65)).connect(this.pre);
      this.dr.connect(fbB).connect(this.dl);

      this.choIn = gain(c, 1);
      for (const [dt, rate, p] of [[0.012, 0.31, -0.85], [0.019, 0.47, 0.85]]) {
        const d = c.createDelay(0.05);
        d.delayTime.value = dt;
        lfo(c, rate, 0.0025, d.delayTime, this);
        this.choIn.connect(d).connect(pan(c, p)).connect(this.pre);
      }

      // Buses: level/mute → (tremolo) → duck → dry + sends.
      this.bus = {};
      this.duckers = [];
      this.sendGains = [];
      this.levels = {};
      for (const b of BUSES) {
        this.levels[b] = BUS_LEVEL[b] * ((st.mix && st.mix[b]) || 1);
        const input = gain(c, this.levels[b]);
        let node = input;
        if (b === 'comp' && fx.trem) {
          const p = pan(c, 0);
          if (p.pan) lfo(c, 4.6, fx.trem, p.pan, this);
          node = node.connect(p);
        }
        const duck = gain(c, 1);
        node.connect(duck);
        duck.connect(this.pre);
        const sends = [[fx.rev[b], this.revIn], [fx.dly && fx.dly[b], this.dlyIn], [fx.cho && fx.cho[b], this.choIn]];
        for (const [amt, dest] of sends) {
          if (!amt) continue;
          const s = gain(c, amt);
          duck.connect(s).connect(dest);
          this.sendGains.push([s, amt]);
        }
        if (['pad', 'arp', 'comp', 'bass'].includes(b)) this.duckers.push(duck);
        this.bus[b] = input;
      }
      this.fxOn = true;
    }

    setTempo(bpm) {
      const d = (60 / bpm) * 0.75, t = this.c.currentTime;
      this.dl.delayTime.setTargetAtTime(d, t, 0.05);
      this.dr.delayTime.setTargetAtTime(d, t, 0.05);
    }
    setTempoNow(bpm) { this.dl.delayTime.value = this.dr.delayTime.value = (60 / bpm) * 0.75; }
    setLayer(layer, on, now) {
      const t = this.c.currentTime;
      for (const b of LAYERS[layer] || []) {
        const g = this.bus[b].gain;
        if (now) { g.value = on ? this.levels[b] : 0; continue; }
        g.cancelScheduledValues(t);
        g.setTargetAtTime(on ? this.levels[b] : 0, t, 0.03);
      }
    }
    setFx(on, now) {
      this.fxOn = on;
      const t = this.c.currentTime;
      const set = (param, v) => { if (now) param.value = v; else { param.cancelScheduledValues(t); param.setTargetAtTime(v, t, 0.04); } };
      for (const [g, amt] of this.sendGains) set(g.gain, on ? amt : 0);
      set(this.wet.gain, on ? 1 : 0);
      set(this.dry.gain, on ? 0 : 1);
      set(this.crackleIn.gain, on ? this.style.fx.crackle || 0 : 0);
    }
    setVolume(v, now) {
      if (now) this.master.gain.value = 0.85 * v;
      else this.master.gain.setTargetAtTime(0.85 * v, this.c.currentTime, 0.03);
    }
    // Sidechain: pads, arpeggio, keys and bass dip on every kick.
    duck(t) {
      const depth = this.style.fx.duck;
      if (!depth || !this.fxOn) return;
      for (const d of this.duckers) {
        d.gain.setTargetAtTime(1 - depth, t, 0.004);
        d.gain.setTargetAtTime(1, t + 0.05, 0.11);
      }
    }
    resetDuck() {
      const t = this.c.currentTime;
      for (const d of this.duckers) { d.gain.cancelScheduledValues(t); d.gain.setValueAtTime(1, t); }
    }
    pulse(duty) {
      if (this.pulses[duty]) return this.pulses[duty];
      const n = 48, re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      return (this.pulses[duty] = this.c.createPeriodicWave(re, im));
    }
    level() {
      this.analyser.getFloatTimeDomainData(this.levelBuf);
      let s = 0;
      for (let i = 0; i < this.levelBuf.length; i++) s += this.levelBuf[i] * this.levelBuf[i];
      return Math.sqrt(s / this.levelBuf.length);
    }
    dispose() {
      for (const o of this.lfos) { try { o.stop(); } catch (e) { /* done */ } }
      try { this.master.disconnect(); } catch (e) { /* done */ }
    }
  }

  // Per-playback gates: stopping a session silences every voice it started.
  class Session {
    constructor(rig) {
      this.c = rig.c;
      this.rig = rig;
      this.g = {};
      for (const b of BUSES) { const g = gain(rig.c, 1); g.connect(rig.bus[b]); this.g[b] = g; }
      if (rig.style.fx.crackle) {
        const s = rig.c.createBufferSource();
        s.buffer = DSP.crackle();
        s.loop = true;
        this.crackleGate = gain(rig.c, 1);
        s.connect(this.crackleGate).connect(rig.crackleIn);
        s.start();
        this.crackle = s;
      }
    }
    stop() {
      const t = this.c.currentTime;
      const gates = Object.values(this.g).concat(this.crackleGate ? [this.crackleGate] : []);
      for (const g of gates) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.06);
      }
      const crackle = this.crackle;
      setTimeout(() => {
        if (crackle) { try { crackle.stop(); } catch (e) { /* done */ } }
        for (const g of gates) { try { g.disconnect(); } catch (e) { /* done */ } }
      }, 300);
    }
  }

  // ---------- voices ----------
  // A pre-rendered tone: buffer → (brightness low-pass) → gain → (pan) → bus.
  function sampled(r, dest, t, e, offset = 0) {
    const c = r.c;
    const buf = DSP.note(e.inst, e.midi);
    if (offset >= buf.duration - 0.05) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const level = e.vel * (INST_GAIN[e.inst] || 1);
    const g = gain(c, level);
    const relAt = t + Math.max(0.06, (e.dur || 1) - offset);
    let stopAt = t + buf.duration - offset;
    if (relAt + 0.3 < stopAt) {
      g.gain.setValueAtTime(level, relAt);
      g.gain.setTargetAtTime(0, relAt, 0.09);
      stopAt = relAt + 0.7;
    }
    let node = src;
    if (e.bright != null && e.bright < 0.95) {
      const f = U.mtof(e.midi);
      node = node.connect(filt(c, 'lowpass', Math.min(18000, f * (2.2 + 16 * e.bright) + 700), 0.5));
    }
    node = node.connect(g);
    if (e.pan && Math.abs(e.pan) > 0.02) node = node.connect(pan(c, e.pan));
    node.connect(dest);
    src.start(t, offset);
    src.stop(stopAt);
  }

  // 8-bit voices: pulse waves with three duty cycles, and a triangle.
  function chip(r, dest, t, e) {
    const c = r.c;
    const o = c.createOscillator();
    if (e.inst === 'tri') o.type = 'triangle';
    else o.setPeriodicWave(r.pulse(e.inst === 'pulse12' ? 0.125 : e.inst === 'pulse25' ? 0.25 : 0.5));
    o.frequency.value = U.mtof(e.midi);
    const level = e.vel * (INST_GAIN[e.inst] || 0.3);
    const dur = Math.max(0.05, e.dur || 0.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.setTargetAtTime(level * 0.65, t + 0.01, 0.08);
    g.gain.setValueAtTime(level * 0.65, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    let node = o.connect(g);
    if (e.pan && Math.abs(e.pan) > 0.02) node = node.connect(pan(c, e.pan));
    node.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.06);
  }

  function tone(r, dest, t, e, offset) {
    if (DSP.isSampled(e.inst)) sampled(r, dest, t, e, offset);
    else chip(r, dest, t, e);
  }

  function chord(r, dest, t, e, offset = 0) {
    const n = e.notes.length;
    e.notes.forEach((m, j) => {
      const dt = j * (e.gap || 0) - offset;
      const ev = { inst: e.inst, midi: m, vel: e.vel * (j === 0 ? 1 : 0.85), dur: (e.dur || 1) - j * (e.gap || 0), pan: n > 1 ? (j / (n - 1) - 0.5) * 0.5 : 0, bright: 0.75 };
      if (dt >= 0) tone(r, dest, t + dt, ev, 0);
      else if (DSP.isSampled(e.inst)) sampled(r, dest, t, ev, -dt);
    });
  }

  // Live pads: detuned saws through a fixed low-pass, slow swell.
  function pad(r, dest, t, e, offset = 0) {
    const c = r.c;
    const type = r.style.pad || 'warm';
    const dur = e.dur - offset;
    if (dur <= 0.05) return;
    const cfg = {
      warm: { cut: 900 + 1400 * e.bright, atk: 0.5, rel: 0.9, voices: [['sawtooth', -6, 1], ['triangle', 5, 0.8]] },
      air: { cut: 650 + 900 * e.bright, atk: 1.4, rel: 2.2, voices: [['sawtooth', -8, 0.7], ['sawtooth', 8, 0.7], ['sine', 0, 1]] },
      supersaw: { cut: 1700 + 2400 * e.bright, atk: 0.25, rel: 0.5, voices: [['sawtooth', -13, 0.8], ['sawtooth', 0, 0.8], ['sawtooth', 13, 0.8]] },
    }[type];
    const lp = filt(c, 'lowpass', cfg.cut, 0.6);
    const a = c.createGain();
    const level = e.vel * 0.05;
    const atk = offset ? 0.12 : Math.min(cfg.atk, dur * 0.4);
    a.gain.setValueAtTime(0, t);
    a.gain.linearRampToValueAtTime(level, t + atk);
    if (e.fade) a.gain.linearRampToValueAtTime(0, t + dur + cfg.rel);
    else { a.gain.setValueAtTime(level, t + dur); a.gain.linearRampToValueAtTime(0, t + dur + cfg.rel); }
    lp.connect(a).connect(dest);
    const end = t + dur + cfg.rel + 0.05;
    for (const m of e.notes) {
      const f = U.mtof(m);
      for (const [type2, det, amt] of cfg.voices) {
        const o = osc(c, type2, f);
        o.detune.value = det;
        const g = gain(c, amt);
        o.connect(g).connect(lp);
        o.start(t); o.stop(end);
      }
    }
  }

  function bass(r, dest, t, e) {
    const c = r.c, f = U.mtof(e.midi);
    const type = r.style.bass || 'warm';
    const dur = Math.max(0.05, e.dur);
    const out = c.createGain();
    const level = e.vel * { warm: 0.25, sub: 0.28, saw: 0.19, tri: 0.28 }[type];
    const atk = type === 'warm' ? 0.012 : type === 'sub' ? 0.05 : 0.005;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(level, t + atk);
    if (type === 'warm') out.gain.setTargetAtTime(level * 0.75, t + atk, 0.25);
    out.gain.setValueAtTime(type === 'warm' ? level * 0.75 : level, t + dur);
    out.gain.linearRampToValueAtTime(0, t + dur + 0.06);
    const end = t + dur + 0.08;
    const srcs = [];
    if (type === 'tri') {
      srcs.push(osc(c, 'triangle', f));
      srcs[0].connect(out);
    } else if (type === 'saw') {
      const s = osc(c, 'sawtooth', f), sub = osc(c, 'sine', f);
      const lp = filt(c, 'lowpass', 500, 4);
      try { lp.frequency.automationRate = 'k-rate'; } catch (err) { /* stays a-rate */ }
      lp.frequency.setValueAtTime(1500, t);
      lp.frequency.setTargetAtTime(420, t, 0.06);
      s.connect(lp).connect(out);
      sub.connect(gain(c, 0.7)).connect(out);
      srcs.push(s, sub);
    } else {
      const s = osc(c, 'sine', f);
      s.connect(out);
      srcs.push(s);
      if (type === 'warm') {
        const tr = osc(c, 'triangle', f);
        tr.connect(filt(c, 'lowpass', 900, 0.7)).connect(gain(c, 0.35)).connect(out);
        srcs.push(tr);
      }
    }
    out.connect(dest);
    for (const s of srcs) { s.start(t); s.stop(end); }
  }

  function drum(r, dest, t, e) {
    const buf = DSP.drum(r.style.kit, e.k);
    if (!buf) return;
    const c = r.c;
    const src = c.createBufferSource();
    src.buffer = buf;
    let node = src.connect(gain(c, e.vel * (DRUM_GAIN[e.k] || 0.5)));
    if (DRUM_PAN[e.k]) node = node.connect(pan(c, DRUM_PAN[e.k]));
    node.connect(dest);
    src.start(Math.max(0, t));
    if (e.k === 'kick') r.duck(t);
  }

  function play(r, s, when, e, offset) {
    switch (e.k) {
      case 'lead': return tone(r, s.g.lead, when, e, offset);
      case 'arp': return tone(r, s.g.arp, when, e, offset);
      case 'orn': return tone(r, s.g.orn, when, e, offset);
      case 'strum': return chord(r, s.g.arp, when, e, offset);
      case 'comp': return chord(r, s.g.comp, when, e, offset);
      case 'pad': return pad(r, s.g.pad, when, e, offset);
      case 'bass': return bass(r, s.g.bass, when, e);
      default: return drum(r, s.g.drums, when, e);
    }
  }

  // Everything a score needs, so playback never waits on synthesis.
  function sampleJobs(score) {
    const kit = Styles.get(score.style).kit;
    const jobs = new Map();
    const addNote = (inst, m) => { if (DSP.isSampled(inst)) { const key = DSP.noteKey(inst, m); if (!jobs.has(key)) jobs.set(key, { key, make: () => DSP.note(inst, m) }); } };
    for (const e of score.events) {
      if (e.notes) { if (e.k !== 'pad') for (const m of e.notes) addNote(e.inst, m); }
      else if (e.inst) addNote(e.inst, e.midi);
      else if (e.midi == null) { const key = `d:${kit}:${e.k}`; if (!jobs.has(key)) jobs.set(key, { key, make: () => DSP.drum(kit, e.k) }); }
    }
    return Array.from(jobs.values());
  }
  function prepare(score, onProgress) { return DSP.prepare(sampleJobs(score), onProgress); }

  // Worker-driven tick keeps the scheduler alive in background tabs.
  function makeTicker(fn) {
    let worker = null, id = null;
    try {
      const src = 'var id=null;onmessage=function(e){if(e.data==="start"){if(id===null)id=setInterval(function(){postMessage(0)},25)}else{clearInterval(id);id=null}}';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = fn;
    } catch (e) { worker = null; }
    return {
      start() { if (worker) worker.postMessage('start'); else if (id === null) id = setInterval(fn, 25); },
      stop() { if (worker) worker.postMessage('stop'); else { clearInterval(id); id = null; } },
    };
  }

  // ---------- transport ----------
  class Player {
    constructor() {
      this.score = null; this.rig = null; this.session = null;
      this.playing = false; this.pos = 0; this.loop = false; this.volume = 0.8; this.fx = true;
      this.layers = { lead: true, arp: true, chords: true, bass: true, drums: true };
      this.handlers = {};
      this.ticker = makeTicker(() => this.tick());
      this.prep = Promise.resolve();
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name, ...args) { (this.handlers[name] || []).forEach((fn) => fn(...args)); }

    setScore(score, pos = 0) {
      const was = this.playing;
      if (was) { this.stopSession(); this.playing = false; }
      this.score = score;
      this.longs = score.events.filter((e) => e.k === 'pad' || e.k === 'comp' || (e.k === 'lead' && e.dur > 1));
      this.pos = U.clamp(pos, 0, score.duration);
      if (this.rig && this.rig.styleKey !== score.style) { this.rig.dispose(); this.rig = null; }
      if (this.rig) this.rig.setTempo(score.bpm);
      this.prep = prepare(score, (f) => this.emit('prep', f));
      if (was) this.play();
      this.emit('state');
    }
    ensureRig() {
      const c = unlock();
      if (!this.rig) {
        this.rig = new Rig(c, this.score.style);
        for (const k of Object.keys(LAYERS)) this.rig.setLayer(k, this.layers[k], true);
        this.rig.setFx(this.fx, true);
        this.rig.setVolume(this.volume, true);
        this.rig.setTempoNow(this.score.bpm);
      }
      return this.rig;
    }
    async play() {
      if (!this.score || this.playing) return;
      this.ensureRig();
      if (this.pos >= this.score.duration - 0.05) this.pos = 0;
      this.playing = true;
      this.emit('state');
      const score = this.score;
      await this.prep;
      if (!this.playing || this.score !== score || this.session) return;
      this.startSession();
    }
    pause() {
      if (!this.playing) return;
      this.pos = this.position();
      this.stopSession();
      this.playing = false;
      this.emit('state');
    }
    toggle() { if (this.playing) this.pause(); else this.play(); }
    seek(t) {
      if (!this.score) return;
      t = U.clamp(t, 0, this.score.duration);
      if (this.playing && this.session) { this.stopSession(); this.pos = t; this.startSession(); } else this.pos = t;
      this.emit('seek');
    }
    position() {
      if (!this.playing || !this.rig || !this.session) return this.pos;
      return Math.max(0, this.pos0 + (this.rig.c.currentTime - this.t0));
    }
    setLayer(k, on) { this.layers[k] = on; if (this.rig) this.rig.setLayer(k, on); }
    setFx(on) { this.fx = on; if (this.rig) this.rig.setFx(on); }
    setVolume(v) { this.volume = v; if (this.rig) this.rig.setVolume(v); }
    level() { return this.rig && this.playing ? this.rig.level() : 0; }

    startSession() {
      const r = this.ensureRig(), c = r.c;
      if (c.state !== 'running') c.resume().catch(() => {});
      r.resetDuck();
      this.session = new Session(r);
      this.t0 = c.currentTime + 0.08;
      this.pos0 = this.pos;
      for (const e of this.longs) {
        if (e.t >= this.pos0) break;
        if (e.t + e.dur > this.pos0 + 0.1) play(r, this.session, this.t0, e, this.pos0 - e.t);
      }
      this.idx = U.lowerBound(this.score.events, this.pos0 - 1e-6);
      this.ticker.start();
      this.tick();
    }
    stopSession() {
      this.ticker.stop();
      if (this.session) this.session.stop();
      this.session = null;
      if (this.rig) this.rig.resetDuck();
    }
    tick() {
      if (!this.playing || !this.session) return;
      const r = this.rig, now = r.c.currentTime;
      const pos = this.pos0 + (now - this.t0);
      const ahead = document.hidden ? 1.5 : 0.2;
      const ev = this.score.events;
      while (this.idx < ev.length && ev[this.idx].t < pos + ahead) {
        const e = ev[this.idx++];
        const when = this.t0 + (e.t - this.pos0);
        if (when < now - 0.04 && e.k !== 'pad' && e.k !== 'comp') continue;
        play(r, this.session, Math.max(when, now), e);
      }
      if (pos >= this.score.duration) {
        this.stopSession();
        if (this.loop) { this.pos = 0; this.startSession(); this.emit('seek'); } else { this.playing = false; this.pos = this.score.duration; this.emit('end'); this.emit('state'); }
      }
    }
  }

  // ---------- offline render (WAV export) ----------
  async function renderOffline(score, opts = {}, onProgress) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error('This browser can’t render audio to a file.');
    await prepare(score);
    const sr = 44100;
    const oc = new OAC(2, Math.ceil((score.duration + 0.25) * sr), sr);
    const rig = new Rig(oc, score.style, !!opts.raw);
    rig.setTempoNow(score.bpm);
    const layers = opts.layers || {};
    for (const k of Object.keys(LAYERS)) rig.setLayer(k, layers[k] !== false, true);
    rig.setFx(opts.fx !== false, true);
    rig.setVolume(1, true);
    const session = new Session(rig);
    const ev = score.events;
    let idx = 0;
    const upto = (tEnd) => { while (idx < ev.length && ev[idx].t < tEnd) { const e = ev[idx++]; play(rig, session, e.t, e); } };
    const CH = 4;
    let chunked = false;
    if (typeof oc.suspend === 'function') {
      try {
        upto(CH * 2);
        for (let s = CH; s < score.duration; s += CH) {
          oc.suspend(s).then(() => { upto(s + CH * 2); if (onProgress) onProgress(s / score.duration); oc.resume(); });
        }
        chunked = true;
      } catch (e) { chunked = false; }
    }
    if (!chunked) upto(Infinity);
    const buf = await oc.startRendering();
    rig.dispose();
    if (onProgress) onProgress(1);
    return buf;
  }

  return { Player, renderOffline, prepare, unlock, canStart, LAYERS, BUS_LEVEL };
})();
