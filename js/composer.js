'use strict';
// Musical mapping. The tree drives everything, inside a musical frame:
//
//   line order                 -> time (one line per grid slot)
//   top-level folder           -> section: its own 4-bar chord loop and lead instrument
//   longest name per half-bar  -> melody note (the silhouette's peaks sing)
//   every other line           -> soft arpeggio through the current chord
//   folder name                -> melodic motif; going deeper lifts the melody
//   silhouette per 4-bar phrase-> arrangement level: which parts and drums play
//   file type                  -> section lead instrument; other types add ornaments
//   ink density of the name    -> brightness of the note
//   file size                  -> how long a melody note rings
//   place among siblings       -> stereo position of the arpeggio
//   language -> mode, repo name -> key, median name length -> tempo
//
// Deterministic: the same tree and style always give the same score.

const Composer = (() => {
  const MODES = {
    ionian: { name: 'major (Ionian)', steps: [0, 2, 4, 5, 7, 9, 11] },
    dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
    phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
    lydian: { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
    mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
    aeolian: { name: 'minor (Aeolian)', steps: [0, 2, 3, 5, 7, 8, 10] },
  };
  const MODE_KEYS = Object.keys(MODES);
  const MINOR = new Set(['dorian', 'aeolian', 'phrygian']);
  const LANG_MODE = {
    Python: 'dorian', Julia: 'dorian', R: 'dorian', Elixir: 'dorian', Erlang: 'dorian', Gleam: 'dorian',
    JavaScript: 'mixolydian', PHP: 'mixolydian', Shell: 'mixolydian', Lua: 'mixolydian', Perl: 'mixolydian',
    TypeScript: 'lydian', Swift: 'lydian', Dart: 'lydian', Vue: 'lydian', Svelte: 'lydian', HTML: 'lydian', CSS: 'lydian', Elm: 'lydian',
    Go: 'ionian', Java: 'ionian', Kotlin: 'ionian', 'C#': 'ionian', 'F#': 'ionian', Scala: 'ionian', Ruby: 'ionian', Groovy: 'ionian',
    Rust: 'aeolian', C: 'aeolian', Zig: 'aeolian', Haskell: 'aeolian', OCaml: 'aeolian', Clojure: 'aeolian', Nim: 'aeolian',
    'C++': 'phrygian', 'Objective-C': 'phrygian', Assembly: 'phrygian', Solidity: 'phrygian',
  };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  // Spell notes the way the key signature does: F minor has D♭, not C♯.
  const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MODE_OFFSET = { ionian: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, aeolian: 9 };
  const FLAT_MAJORS = new Set([5, 10, 3, 8, 1]);

  // Four-chord loops that are known to work, as scale degrees (0 = I).
  const PROGS = {
    major: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [3, 0, 4, 5], [0, 3, 5, 4], [1, 4, 0, 5], [0, 3, 1, 4], [3, 4, 2, 5]],
    minor: [[0, 5, 2, 6], [0, 3, 6, 2], [0, 6, 5, 6], [0, 3, 4, 0], [5, 6, 0, 0], [0, 2, 6, 5], [0, 5, 3, 4], [3, 4, 0, 0]],
  };
  const MODE_PROGS = {
    dorian: [[0, 3, 0, 3], [0, 3, 6, 0]], mixolydian: [[0, 6, 3, 0], [0, 6, 3, 3]],
    lydian: [[0, 1, 0, 1], [0, 1, 4, 0]], phrygian: [[0, 1, 0, 6], [0, 1, 2, 1]], ionian: [], aeolian: [],
  };
  const CADENCE = { major: [3, 4, 0, 0], minor: [5, 6, 0, 0] };
  // Short melodic cells in scale steps. Each folder gets one and keeps repeating it.
  const MOTIFS = [[1, 1, -2], [2, -1, -1], [-1, -1, 3], [2, 1, -1, -2], [0, 2, -1], [3, -1, -1, -1], [-2, 1, 1], [1, -1, 2, -2], [2, 2, -3], [-1, 2, -1, 1]];
  const LVL = [0.8, 0.9, 1, 1.08];

  function autoRate(n, beat) {
    if (n <= 60) return 1;
    let r = 2;
    while ((n / r) * beat > 200 && r < 256) r *= 2;
    return r;
  }

  function compose(model, opts = {}) {
    const { lines, stats, source } = model;
    const N = lines.length;
    const styleKey = Styles.LIST[opts.style] ? opts.style : Styles.DEFAULT;
    const style = Styles.get(styleKey);
    const seedName = (source.repo ? source.repo.full : source.name).toLowerCase();
    const seed = U.hash32(seedName);
    const rng = U.rng(seed ^ 0x5bd1e995);

    // ---------- key ----------
    const modeKey = LANG_MODE[stats.lang] || MODE_KEYS[seed % MODE_KEYS.length];
    const steps = MODES[modeKey].steps;
    const family = MINOR.has(modeKey) ? 'minor' : 'major';
    const root = (seed >>> 8) % 12;
    const names = FLAT_MAJORS.has((root - MODE_OFFSET[modeKey] + 12) % 12) ? FLATS : SHARPS;
    const pcName = (pc) => names[((pc % 12) + 12) % 12];
    const noteName = (m) => pcName(m) + (Math.floor(m / 12) - 1);
    const melTonic = 57 + ((root - 9 + 12) % 12); // A3 .. G#4

    // ---------- time grid ----------
    const [bLo, bHi] = style.bpm;
    const autoBpm = Math.round(bHi - U.clamp((stats.medianLen - 6) / 16, 0, 1) * (bHi - bLo));
    const bpm = opts.bpm || autoBpm;
    const beat = 60 / bpm, barDur = beat * 4, stepDur = beat / 4;
    const baseRate = autoRate(N, beat);
    const rate = baseRate * (opts.speed || 1);
    const lineDur = beat / rate;
    const linesEnd = N * lineDur;
    const nBars = Math.max(1, Math.ceil(linesEnd / barDur - 1e-9));
    const codaStart = nBars * barDur;
    const timeOf = (i) => i * lineDur;
    const lineAt = (t) => U.clamp(Math.floor(t / lineDur + 1e-9), 0, N - 1);
    const barOf = (t) => U.clamp(Math.floor(t / barDur + 1e-9), 0, nBars - 1);

    // ---------- per-line signals ----------
    const amp = new Float32Array(N), densN = new Float32Array(N), sizeN = new Float32Array(N);
    const dLo = stats.densLo, dSpan = Math.max(1e-3, stats.densHi - stats.densLo);
    const logRef = Math.log1p(stats.sizeRef);
    for (let i = 0; i < N; i++) {
      const l = lines[i];
      amp[i] = Math.min(1, l.len / stats.lenRef);
      densN[i] = U.clamp((l.dens - dLo) / dSpan, 0, 1);
      sizeN[i] = source.noSizes ? 0.4 : U.clamp(Math.log1p(l.isDir ? 0 : l.size) / logRef, 0, 1);
    }
    // Envelope: name lengths smoothed over one bar, stretched to this repo's range.
    const energy = new Float32Array(N);
    {
      const w = Math.max(3, Math.round(4 * rate));
      const pre = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + amp[i];
      const raw = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = Math.max(0, i - (w >> 1)), b = Math.min(N, a + w);
        raw[i] = (pre[b] - pre[a]) / (b - a);
      }
      const lo = U.percentile(raw, 0.1), hi = U.percentile(raw, 0.9);
      for (let i = 0; i < N; i++) energy[i] = U.clamp((raw[i] - lo) / Math.max(1e-3, hi - lo), 0, 1);
    }

    // ---------- harmony helpers ----------
    const isDim = (d) => (steps[(d + 4) % 7] - steps[d] + 12) % 12 === 6;
    const fixDeg = (d) => (isDim(d) ? (d + 5) % 7 : d);
    const pcsOf = (d) => [0, 2, 4, 6].map((k) => (steps[(d + k) % 7] + root) % 12);
    const ninthOf = (d) => ((steps[(d + 1) % 7] - steps[d] + 12) % 12 === 1 ? null : (steps[(d + 1) % 7] + root) % 12);
    const chordName = (d) => {
      const p = pcsOf(d);
      const third = (p[1] - p[0] + 12) % 12, fifth = (p[2] - p[0] + 12) % 12, sev = (p[3] - p[0] + 12) % 12;
      const triadOnly = style.leadTones === 'triad';
      if (fifth === 6) return pcName(p[0]) + 'm7♭5';
      const q = third === 3 ? 'm' : '';
      if (triadOnly) return pcName(p[0]) + q;
      return pcName(p[0]) + q + (sev === 11 ? 'maj7' : '7');
    };
    const romanOf = (d) => {
      const p = pcsOf(d);
      return (p[1] - p[0] + 12) % 12 === 3 ? ROMAN[d].toLowerCase() : ROMAN[d];
    };
    const tonesOf = (d, kind) => {
      const p = pcsOf(d);
      if (kind === 'triad') return [p[0], p[1], p[2]];
      if (kind === 'open') { const n9 = ninthOf(d); return [p[0], p[2], n9 == null ? p[1] : n9]; }
      return p;
    };

    // ---------- sections: one per top-level entry ----------
    const starts = [];
    for (let i = 1; i < N; i++) {
      const l = lines[i];
      if (l.depth !== 1) continue;
      if (l.isDir) starts.push({ line: i, key: l.name, label: `${l.name}/`, kind: 'dir' });
      else if (!starts.length || starts[starts.length - 1].kind !== 'files') starts.push({ line: i, key: '__files__', label: 'root files', kind: 'files' });
    }
    // Folders that start within the same bar share one section, named after the biggest of them.
    starts.forEach((s, k) => { s.size = (k + 1 < starts.length ? starts[k + 1].line : N) - s.line; });
    const sections = [];
    for (const s of starts) {
      const prev = sections[sections.length - 1];
      const bar = prev ? Math.round(timeOf(s.line) / barDur) : 0;
      if (prev && (bar <= prev.bar || bar >= nBars)) {
        if (s.size > prev.size) Object.assign(prev, { key: s.key, label: s.label, kind: s.kind, size: s.size });
        continue;
      }
      sections.push({ ...s, line: prev ? s.line : 0, bar });
    }
    if (!sections.length) sections.push({ line: 0, key: '__root__', label: lines[0].name, kind: 'dir', bar: 0 });
    const secOfLine = new Int32Array(N);
    const secOfBar = new Int32Array(nBars);
    sections.forEach((s, k) => {
      const next = sections[k + 1];
      s.endBar = next ? next.bar : nBars;
      s.first = k === 0 ? 0 : s.line;
      s.last = (next ? next.line : N) - 1;
      for (let i = s.first; i <= s.last; i++) secOfLine[i] = k;
      for (let b = s.bar; b < s.endBar; b++) secOfBar[b] = k;
      const h = U.hash32(`${seedName}:${s.key}`);
      const pool = PROGS[family].concat(MODE_PROGS[modeKey] || []);
      const fromHome = pool.filter((p) => p[0] === 0);
      if (s.kind === 'files' && k === sections.length - 1 && sections.length > 1) s.prog = CADENCE[family];
      else if (k === 0) s.prog = fromHome[h % fromHome.length];
      else s.prog = pool[h % pool.length];
      s.progB = pool[(h >>> 5) % pool.length];
      const counts = {};
      for (let i = s.first; i <= s.last; i++) if (!lines[i].isDir) counts[lines[i].cat] = (counts[lines[i].cat] || 0) + 1;
      s.cat = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'code';
      s.inst = style.leadMap[s.cat] || style.leadMap.code;
    });

    // Chord for every bar: the section loop; long sections switch to a second loop in their 3rd block of 8 bars (A A B A).
    const barDeg = new Int8Array(nBars);
    for (const s of sections) {
      for (let b = s.bar; b < s.endBar; b++) {
        const k = b - s.bar;
        const prog = s.endBar - s.bar > 16 && Math.floor(k / 8) % 4 === 2 ? s.progB : s.prog;
        barDeg[b] = fixDeg(prog[k % prog.length]);
      }
    }
    const chordAtBar = (b) => barDeg[U.clamp(b, 0, nBars - 1)];

    // ---------- arrangement levels per 4-bar phrase ----------
    const barEnergy = new Float32Array(nBars);
    for (let b = 0; b < nBars; b++) {
      const a = lineAt(b * barDur), z = Math.max(a + 1, Math.min(N, Math.ceil(((b + 1) * barDur) / lineDur - 1e-9)));
      let e = 0;
      for (let i = a; i < z; i++) e += energy[i];
      barEnergy[b] = e / (z - a);
    }
    const phrases = [];
    for (const s of sections) {
      for (let b = s.bar; b < s.endBar; b += 4) {
        const z = Math.min(s.endBar, b + 4);
        let e = 0;
        for (let k = b; k < z; k++) e += barEnergy[k];
        phrases.push({ b, z, e: e / (z - b) });
      }
    }
    const pe = phrases.map((p) => p.e);
    const q1 = U.percentile(pe, 0.15), q2 = U.percentile(pe, 0.45), q3 = U.percentile(pe, 0.8);
    const barLevel = new Int8Array(nBars);
    phrases.forEach((p, k) => {
      let lvl = (p.e >= q1 ? 1 : 0) + (p.e >= q2 ? 1 : 0) + (p.e >= q3 && q3 > q2 ? 1 : 0);
      if (phrases.length > 1 && k === 0) lvl = Math.min(lvl, 1);
      if (phrases.length > 4 && k === 1) lvl = Math.min(lvl, 2);
      if (k > 0) lvl = U.clamp(lvl, phrases[k - 1].lvl - 2, phrases[k - 1].lvl + 2);
      if (secOfBar[p.b] !== (k ? secOfBar[phrases[k - 1].b] : -1)) lvl = Math.max(lvl, k === 0 ? 0 : 1);
      p.lvl = lvl;
      for (let b = p.b; b < p.z; b++) barLevel[b] = lvl;
    });
    const levelAt = (t) => barLevel[barOf(t)];

    // Swing the off-beat 16ths.
    const swingAmt = (style.swing - 0.5) * 2 * stepDur;
    const swing = (t) => {
      if (swingAmt <= 0) return t;
      const q = t / stepDur, r = Math.round(q);
      return Math.abs(q - r) < 1e-4 && r % 2 === 1 ? t + swingAmt : t;
    };
    const human = (t) => t + (rng() - 0.5) * style.humanize;
    const onBeat = (t) => { const q = t / beat; return Math.abs(q - Math.round(q)) < 1e-4; };

    const events = [];
    const notes = new Array(N);
    for (let i = 0; i < N; i++) notes[i] = { role: lines[i].isDir ? 'dir' : 'group', sec: secOfLine[i] };

    // ---------- melody: the longest name in each window ----------
    const win = style.melWindow * beat;
    const introEnd = nBars >= 12 ? 2 * barDur : 0;
    const leadLines = [];
    for (let w = 0; w * win < linesEnd; w++) {
      const a = Math.ceil((w * win) / lineDur - 1e-9), z = Math.min(N, Math.ceil(((w + 1) * win) / lineDur - 1e-9));
      let best = -1;
      for (let i = a; i < z; i++) if (!lines[i].isDir && (best < 0 || lines[i].len > lines[best].len)) best = i;
      if (best < 0 || timeOf(best) < introEnd) continue;
      leadLines.push(best);
      if (style.melSecond && levelAt(timeOf(best)) >= 2) {
        let second = -1;
        for (let i = a; i < z; i++) {
          if (i === best || lines[i].isDir || Math.abs(i - best) * lineDur < beat * 0.99) continue;
          if (lines[i].len >= lines[best].len * 0.8 && (second < 0 || lines[i].len > lines[second].len)) second = i;
        }
        if (second >= 0) leadLines.push(second);
      }
    }
    leadLines.sort((x, y) => x - y);

    const degMidi = (d) => melTonic + 12 * Math.floor(d / 7) + steps[((d % 7) + 7) % 7];
    const degOf = (m) => {
      let best = 0, bd = 1e9;
      for (let d = -3; d <= 16; d++) { const x = Math.abs(degMidi(d) - m); if (x < bd) { bd = x; best = d; } }
      return best;
    };
    const nearestTone = (midi, pcs) => {
      for (let d = 0; d <= 6; d++) {
        if (pcs.includes((((midi + d) % 12) + 12) % 12)) return midi + d;
        if (pcs.includes((((midi - d) % 12) + 12) % 12)) return midi - d;
      }
      return midi;
    };
    const motifOf = (line) => MOTIFS[U.hash32(`${seedName}/${lines[line].path || lines[line].name}`) % MOTIFS.length];

    let cur = 4, prevDepth = 1, prevSec = -1;
    const motifPos = new Map();
    let lastLead = null;
    leadLines.forEach((i, k) => {
      const l = lines[i], t = timeOf(i), s = secOfLine[i];
      const d = chordAtBar(barOf(t));
      if (s !== prevSec) {
        cur = degOf(nearestTone(degMidi(4), tonesOf(d, style.leadTones)));
        prevSec = s;
      } else {
        const m = motifOf(l.parent);
        const pos = motifPos.get(l.parent) || 0;
        motifPos.set(l.parent, pos + 1);
        cur += m[pos % m.length] + U.clamp(l.depth - prevDepth, -2, 2) * 2;
      }
      if (cur > 11) cur = 22 - cur;
      if (cur < 0) cur = -cur;
      cur = U.clamp(cur, 0, 11);
      let midi = degMidi(cur);
      if (onBeat(t) || style.leadTones === 'triad') { midi = nearestTone(midi, tonesOf(d, style.leadTones)); cur = degOf(midi); }
      prevDepth = l.depth;
      const next = k + 1 < leadLines.length ? timeOf(leadLines[k + 1]) : codaStart;
      const gap = Math.max(beat * 0.25, next - t);
      const dur = U.clamp(gap * (0.55 + 0.45 * sizeN[i]), beat * 0.3, barDur * 2);
      const lvl = levelAt(t);
      const vel = (0.72 + 0.28 * amp[i]) * LVL[lvl];
      const inst = sections[s].inst;
      const ev = { t: swing(t), k: 'lead', inst, midi, vel, dur, pan: 0, bright: 0.45 + 0.55 * densN[i], line: i };
      events.push(ev);
      if (style.double && lvl >= 3) events.push({ ...ev, midi: midi + 12, vel: vel * 0.32, k: 'orn' });
      notes[i] = { role: 'lead', midi, vel, dur, inst, sec: s, lvl };
      lastLead = ev;
    });

    // ---------- arpeggio: every line (grouped when the grid is very fast) ----------
    const arpK = Math.max(1, Math.ceil(rate / style.arpPerBeat));
    const arpCache = new Map();
    const arpNotes = (d) => {
      if (arpCache.has(d)) return arpCache.get(d);
      const tones = tonesOf(d, style.arpTones);
      let r0 = style.arpBase;
      while ((((r0 % 12) + 12) % 12) !== tones[0]) r0++;
      const out = [];
      for (let m = r0; m < r0 + 24; m++) if (tones.includes(((m % 12) + 12) % 12)) out.push(m);
      arpCache.set(d, out);
      return out;
    };
    let patPos = 0, prevParent = -2, lastOrn = -1e9;
    for (let a = 0; a < N; a += arpK) {
      const z = Math.min(N, a + arpK);
      let rep = -1;
      for (let i = a; i < z; i++) {
        if (lines[i].isDir || notes[i].role === 'lead') continue;
        if (rep < 0 || lines[i].len > lines[rep].len) rep = i;
      }
      if (rep < 0) continue;
      const t = timeOf(a), l = lines[rep];
      if (l.parent !== prevParent) { patPos = 0; prevParent = l.parent; }
      const d = chordAtBar(barOf(t));
      const list = arpNotes(d);
      let midi = list[style.arpPattern[patPos % style.arpPattern.length] % list.length];
      patPos++;
      if (l.depth >= 3) midi += 12;
      const lvl = levelAt(t);
      const vel = (0.3 + 0.24 * amp[rep]) * LVL[lvl];
      const pan = l.sibCount > 1 ? ((l.sib / (l.sibCount - 1)) * 2 - 1) * 0.35 : 0;
      events.push({ t: swing(t), k: 'arp', inst: style.arpInst, midi, vel, dur: arpK * lineDur * style.arpLen, pan, bright: 0.3 + 0.7 * densN[rep], line: rep });
      notes[rep] = { role: 'arp', midi, vel, inst: style.arpInst, sec: secOfLine[rep], lvl };
      // A file of another type than its section's lead family adds a quiet ornament.
      const s = sections[secOfLine[rep]];
      if (l.cat !== s.cat && lvl >= 1 && t - lastOrn >= beat * 0.99) {
        const inst = style.leadMap[l.cat] || s.inst;
        const om = nearestTone(midi + 12 > 88 ? midi : midi + 12, tonesOf(d, 'triad'));
        events.push({ t: swing(t), k: 'orn', inst, midi: om, vel: (0.26 + 0.16 * amp[rep]) * LVL[lvl], dur: beat, pan: -pan, bright: 0.5 + 0.5 * densN[rep], line: rep });
        notes[rep].orn = { inst, midi: om };
        lastOrn = t;
      }
    }

    // ---------- folders: a small chord gesture ----------
    let lastHit = -1e9;
    for (let i = 1; i < N; i++) {
      const l = lines[i];
      if (!l.isDir || l.depth > 2) continue;
      const t = timeOf(i);
      if (t - lastHit < barDur * 0.99) continue;
      lastHit = t;
      const d = chordAtBar(barOf(t)), lvl = levelAt(t);
      const tones = arpNotes(d);
      if (style.dirHit === 'blip') {
        events.push({ t, k: 'strum', inst: 'pulse12', notes: tones.slice(0, 4), gap: stepDur / 2, vel: 0.28 * LVL[lvl], dur: stepDur, line: i });
      } else {
        const inst = { strum: 'guitar', stab: 'sawpluck', bell: 'glass' }[style.dirHit] || 'glass';
        const gap = style.dirHit === 'stab' ? 0.004 : style.dirHit === 'bell' ? 0.06 : 0.018;
        events.push({ t, k: 'strum', inst, notes: tones.slice(0, 5), gap, vel: (0.24 + 0.2 * amp[i]) * LVL[lvl], dur: barDur, line: i });
      }
      notes[i] = { role: 'dir', hit: true, sec: secOfLine[i], lvl };
    }

    // ---------- chords: comping, pad, bass, drums ----------
    const chords = [];
    let prevVoicing = null;
    for (let b = 0; b < nBars; b++) {
      const d = barDeg[b];
      const lastC = chords[chords.length - 1];
      if (lastC && lastC.deg === d && lastC.sec === secOfBar[b]) { lastC.dur += barDur; lastC.bars++; continue; }
      const voicing = voiceFor(d, style.chordType, prevVoicing);
      prevVoicing = voicing;
      chords.push({ t: b * barDur, dur: barDur, bars: 1, bar: b, deg: d, pcs: pcsOf(d), name: chordName(d), roman: romanOf(d), voicing, sec: secOfBar[b] });
    }
    const chordOfBar = new Array(nBars);
    for (const c of chords) for (let k = 0; k < c.bars; k++) chordOfBar[c.bar + k] = c;

    for (let b = 0; b < nBars; b++) {
      const c = chordOfBar[b], lvl = barLevel[b], t0 = b * barDur;
      if (style.comp) {
        events.push({ t: t0, k: 'comp', inst: style.comp, notes: c.voicing, gap: 0.014, vel: 0.42 * LVL[lvl], dur: lvl >= 2 && style.compRehit ? beat * 1.4 : barDur * 0.95 });
        if (lvl >= 2 && style.compRehit) events.push({ t: swing(t0 + beat * 1.5), k: 'comp', inst: style.comp, notes: c.voicing, gap: 0.01, vel: 0.3 * LVL[lvl], dur: beat * 2.3 });
      }
    }
    if (style.pad) {
      let open = null;
      for (let b = 0; b <= nBars; b++) {
        const on = b < nBars && barLevel[b] >= style.padMinLevel;
        const c = b < nBars ? chordOfBar[b] : null;
        if (open && (!on || c !== open.c)) { events.push(open.ev); open = null; }
        if (on && !open) {
          let dens = 0, n = 0;
          for (let i = lineAt(c.t); i < Math.min(N, lineAt(c.t + c.dur) + 1); i++) { dens += densN[i]; n++; }
          open = { c, ev: { t: b * barDur, k: 'pad', notes: c.voicing, vel: (0.5 + 0.12 * barLevel[b]) * style.padGain, dur: 0, bright: n ? dens / n : 0.5 } };
        }
        if (open) open.ev.dur += barDur;
      }
    }

    const bassOf = (pc) => 33 + ((pc - 9 + 12) % 12);
    for (let b = 0; b < nBars; b++) {
      const lvl = barLevel[b];
      if (lvl < style.bassMinLevel || !style.bassPat[lvl]) continue;
      const pat = style.bassPat[lvl], c = chordOfBar[b];
      const r0 = bassOf(c.pcs[0]);
      for (let p = 0; p < 16; p++) {
        const v = pat[p];
        if (!v) continue;
        let len = 1;
        while (p + len < 16 && !pat[p + len]) len++;
        const t = b * barDur + p * stepDur;
        events.push({ t: swing(t), k: 'bass', midi: r0 + (v === 5 ? 7 : v === 8 ? 12 : 0), vel: (0.8 + 0.06 * lvl), dur: len * stepDur * 0.92 });
      }
    }

    const ACC = {
      kick: (p) => (p === 0 ? 1 : 0.86), snare: (p) => (p === 4 || p === 12 ? 1 : 0.45), clap: () => 0.9, rim: () => 0.7,
      hat: (p) => (p % 4 === 0 ? 0.8 : p % 2 === 0 ? 0.6 : 0.42), ohat: () => 0.6, shaker: () => 0.5,
    };
    for (let b = 0; b < nBars; b++) {
      const lvl = barLevel[b], g = style.grooves[lvl];
      const t0 = b * barDur;
      const newSec = b > 0 && secOfBar[b] !== secOfBar[b - 1];
      if (newSec && lvl >= 1) {
        if (style.sectionHit === 'crash') events.push({ t: t0, k: 'crash', vel: 0.55 });
        else if (style.sectionHit === 'swell') events.push({ t: Math.max(0, t0 - 1.35), k: 'swell', vel: 0.45 });
      }
      if (lvl < style.drumMinLevel || !g) continue;
      const hits = {};
      for (const kind of Object.keys(g)) {
        const pat = g[kind];
        for (let p = 0; p < 16; p++) if (pat[p] === 'x') (hits[kind] = hits[kind] || new Float32Array(16))[p] = ACC[kind] ? ACC[kind](p) : 0.7;
      }
      const nextNew = b + 1 < nBars && secOfBar[b + 1] !== secOfBar[b];
      if (nextNew && style.fill && lvl >= 1) {
        const from = style.fill === 'snare3' ? 13 : lvl >= 2 ? 8 : 12;
        hits.snare = hits.snare || new Float32Array(16);
        for (let p = from; p < 16; p++) {
          hits.snare[p] = 0.3 + (0.5 * (p - from + 1)) / (16 - from);
          if (hits.hat) hits.hat[p] = 0;
          if (hits.ohat) hits.ohat[p] = 0;
        }
      }
      for (const kind of Object.keys(hits)) {
        const h = hits[kind];
        for (let p = 0; p < 16; p++) {
          if (!h[p]) continue;
          if (kind === 'hat' && hits.ohat && hits.ohat[p]) continue;
          const t = t0 + p * stepDur;
          events.push({ t: Math.max(0, human(swing(t))), k: kind, vel: h[p] * (0.9 + 0.2 * rng()) * (0.85 + 0.05 * lvl) });
        }
      }
    }

    // ---------- coda: home to the tonic ----------
    const codaDur = barDur * 2;
    const homeVoicing = voiceFor(0, style.chordType, prevVoicing);
    const homeTones = arpNotes(0);
    const hitInst = { strum: 'guitar', stab: 'sawpluck', bell: 'glass', blip: 'pulse12' }[style.dirHit] || 'glass';
    events.push({ t: codaStart, k: 'strum', inst: hitInst, notes: homeTones.slice(0, 5), gap: 0.03, vel: 0.5, dur: codaDur });
    if (style.comp) events.push({ t: codaStart, k: 'comp', inst: style.comp, notes: homeVoicing, gap: 0.03, vel: 0.45, dur: codaDur });
    if (style.pad) events.push({ t: codaStart, k: 'pad', notes: homeVoicing, vel: 0.6 * style.padGain, dur: codaDur, bright: 0.5, fade: true });
    const lastSec = sections[sections.length - 1];
    events.push({ t: codaStart, k: 'lead', inst: lastSec.inst, midi: nearestTone(degMidi(lastLead ? degOf(lastLead.midi) : 7), [root]), vel: 0.8, dur: codaDur * 0.8, pan: 0, bright: 0.6, line: -1 });
    events.push({ t: codaStart, k: 'bass', midi: bassOf(root), vel: 0.85, dur: barDur * 1.5 });
    if (barLevel[nBars - 1] >= 1) {
      events.push({ t: codaStart, k: 'kick', vel: 0.9 });
      events.push({ t: codaStart, k: style.sectionHit === 'crash' ? 'crash' : 'swell', vel: 0.45, ...(style.sectionHit === 'crash' ? {} : { t: codaStart - 1.35 }) });
    }
    chords.push({ t: codaStart, dur: codaDur, bars: 2, deg: 0, pcs: pcsOf(0), name: chordName(0), roman: romanOf(0), voicing: homeVoicing, coda: true, sec: sections.length - 1 });

    const ORDER = { pad: 0, comp: 1, bass: 2, kick: 3, snare: 4, clap: 4, rim: 5, hat: 6, ohat: 6, shaker: 6, crash: 7, swell: 7, strum: 8, arp: 9, orn: 10, lead: 11 };
    events.sort((x, y) => x.t - y.t || (ORDER[x.k] || 0) - (ORDER[y.k] || 0));

    return {
      style: styleKey, styleName: style.name,
      N, bpm, autoBpm, beat, rate, baseRate, speed: opts.speed || 1, lineDur, stepDur, barDur, nBars,
      linesEnd, codaStart, duration: codaStart + codaDur + 2.5,
      key: { root, rootName: pcName(root), modeKey, modeName: MODES[modeKey].name, fromLang: !!LANG_MODE[stats.lang] },
      lang: stats.lang, noteName,
      events, chords, notes, sections, barLevel, energy, amp, densN, sizeN,
      timeOf, lineAt,
      chordAt: (t) => chordOfBar[barOf(t)],
      levelAt,
    };

    function voiceFor(d, type, prev) {
      const p = pcsOf(d), n9 = ninthOf(d);
      if (type === 'rootless9') return voiceLead([p[1], p[2], p[3], n9 == null ? p[0] : n9], prev, 52, 74);
      if (type === 'open') return voiceLead([p[0], p[2], n9 == null ? p[1] : n9, p[1]], prev, 48, 76, 24);
      const v = voiceLead([p[0], p[1], p[2]], prev && prev.slice(0, 3), 55, 74);
      return type === 'triad8' ? v.concat(v[0] + 12) : v;
    }
  }

  // Choose octaves for each chord tone so the chord moves as little as possible.
  function voiceLead(pcs, prev, lo, hi, maxSpan = 17) {
    const options = pcs.map((pc) => {
      const out = [];
      for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc) out.push(m);
      return out;
    });
    let best = null, bestCost = Infinity;
    const pick = (k, acc) => {
      if (k === options.length) {
        const v = acc.slice().sort((a, b) => a - b);
        const span = v[v.length - 1] - v[0];
        if (span > maxSpan || span < 5) return;
        let cost = 0;
        if (prev && prev.length === v.length) for (let j = 0; j < v.length; j++) cost += Math.abs(v[j] - prev[j]);
        else cost = Math.abs((v[0] + v[v.length - 1]) / 2 - (lo + hi) / 2) * 2;
        if (v[1] - v[0] < 3) cost += 6;
        if (cost < bestCost) { bestCost = cost; best = v; }
        return;
      }
      for (const m of options[k]) pick(k + 1, acc.concat(m));
    };
    pick(0, []);
    return best || pcs.map((pc) => lo + ((pc - (lo % 12) + 12) % 12)).sort((a, b) => a - b);
  }

  return { compose, MODES };
})();
