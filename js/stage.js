'use strict';
// The stage: the fully expanded tree, its morph into a waveform, and the piano roll.
//
// Morph parameter p runs 0 → 5:
//   0–1 unfold   lines appear and the camera pulls back until the whole tree fits
//   1–2 align    names slide left to one baseline, tree guides fade
//   2–3 ink      letters turn into blocks whose opacity is their ink coverage
//   3–4 rotate   the figure turns 90° counter-clockwise: top of tree = start of track
//   4–5 mirror   bars reflect below the baseline and become a waveform

const Stage = (() => {
  const PHASES = [
    { key: 'unfold', short: 'Unfold', label: 'Unfolding the whole tree, line by line', dur: 2.2 },
    { key: 'align', short: 'Align', label: 'Pushing the names to one baseline on the left', dur: 1.0 },
    { key: 'ink', short: 'Ink', label: 'Letters turn into blocks: the more ink a character has, the denser its block', dur: 1.0 },
    { key: 'rotate', short: 'Rotate', label: 'Turning 90°: lines become time', dur: 1.6 },
    { key: 'mirror', short: 'Mirror', label: 'Mirroring downwards: here’s the wave', dur: 1.0 },
  ];
  const CAT_KEYS = ['dir', 'code', 'docs', 'data', 'web', 'test', 'media', 'tool'];
  const DIM = 0.55;
  const ROLL_TOP = 16, ROLL_BOTTOM = 18;

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Rect batches keyed by colour and quantised alpha → a few fill() calls per frame.
  class Batch {
    constructor() { this.b = new Map(); }
    add(ci, alpha, x, y, w, h) {
      const a = Math.round(U.clamp(alpha, 0, 1) * 12);
      if (a <= 0) return;
      const key = ci * 16 + a;
      let arr = this.b.get(key);
      if (!arr) this.b.set(key, (arr = []));
      arr.push(x, y, w, h);
    }
    flush(ctx, colors) {
      for (const [key, arr] of this.b) {
        ctx.fillStyle = colors[key >> 4];
        ctx.globalAlpha = (key & 15) / 12;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 4) ctx.rect(arr[k], arr[k + 1], arr[k + 2], arr[k + 3]);
        ctx.fill();
      }
      this.b.clear();
      ctx.globalAlpha = 1;
    }
  }

  class View {
    constructor(canvas, roll) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.rc = roll; this.rctx = roll.getContext('2d');
      this.model = null; this.score = null;
      this.batch = new Batch();
      this.bins = new Map();
      this.caches = {};
      this.readTheme();
    }

    readTheme() {
      const t = {
        sheet: cssVar('--sheet') || '#fbfbf8', ground: cssVar('--ground') || '#eef0ec',
        ink: cssVar('--ink') || '#151816', ink2: cssVar('--ink-2') || '#4b524e', ink3: cssVar('--ink-3') || '#858c88',
        gridFine: cssVar('--grid-fine') || 'rgba(214,110,50,.1)', gridMajor: cssVar('--grid-major') || 'rgba(214,110,50,.22)',
        band: cssVar('--band') || 'rgba(0,0,0,.035)', hl: cssVar('--hl') || 'rgba(255,200,0,.25)',
      };
      t.cats = CAT_KEYS.map((k) => (k === 'dir' ? t.ink : cssVar(`--cat-${k}`) || '#888'));
      this.theme = t;
      this.colors = t.cats;
      this.invalidate();
    }

    invalidate() { this.caches = {}; }

    setData(model, score) {
      this.model = model;
      this.score = score;
      const L = model.lines, N = L.length, st = model.stats;
      this.N = N;
      this.ci = new Uint8Array(N);
      this.pre = new Float32Array(N);
      this.len = new Float32Array(N);
      this.alpha = new Float32Array(N);
      const dLo = st.densLo, dSpan = Math.max(1e-3, st.densHi - st.densLo);
      for (let i = 0; i < N; i++) {
        const l = L[i];
        this.ci[i] = CAT_KEYS.indexOf(l.cat);
        this.pre[i] = l.depth * 4;
        this.len[i] = Math.max(1, l.len);
        this.alpha[i] = 0.3 + 0.7 * U.clamp((l.dens - dLo) / dSpan, 0, 1);
      }
      // Per-character ink blocks for small trees.
      this.blocks = null;
      if (N <= 1500) {
        this.blocks = L.map((l) => l.chars.map((ch) => Ink.cov(ch)));
      }
      this.bins.clear();
      this.env = null;
      this.layout();
    }

    setScore(score) { this.score = score; this.env = null; this.caches = {}; }

    layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = this.cv.clientWidth, H = this.cv.clientHeight;
      const RH = this.rc.clientHeight;
      if (!W || !H) return;
      this.dpr = dpr; this.W = W; this.H = H; this.RH = RH;
      this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr);
      this.rc.width = Math.round(W * dpr); this.rc.height = Math.round(RH * dpr);
      if (!this.model) return;
      const narrow = W < 560;
      const L = narrow ? 14 : 22, R = narrow ? 14 : 22, T = narrow ? 14 : 20, B = narrow ? 14 : 20;
      const iw = W - L - R, ih = H - T - B;
      const N = this.N, st = this.model.stats;
      const lhR = narrow ? 15 : 17;
      const fsR = lhR * 0.78;
      const cwR = fsR * 0.6;
      const fits = N * lhR <= ih;
      const lhF = Math.min(lhR, ih / N);
      const cols = Math.max(12, st.colsRef);
      const cwF = fits ? Math.min(cwR, (iw * 0.95) / cols) : U.clamp((iw * 0.72) / cols, lhF * 0.48, cwR);
      const lenRef = st.lenRef;
      // Once names sit on the baseline and text is too small to read, widen the
      // silhouette so the shape fills the sheet before it turns.
      const cwB = lhF >= 5.5 ? cwF : U.clamp((iw * 0.46) / lenRef, cwF, cwF * 5);
      const g = {
        L, R, T, B, iw, ih, lhR, fsR, cwR, lhF, cwF, cwB, lenRef,
        bw: iw / N,
        ah: ((ih / 2) * 0.9) / lenRef,
        midY: T + ih / 2,
        cx: W / 2, cy: H / 2,
        uA: lenRef / 2, vA: N / 2,
        R0: Math.min(N, Math.max(8, Math.floor((ih / lhR) * 0.7))),
        dipK: 0,
      };
      // Mid-turn the figure is diagonal and larger than either end state:
      // pull the camera back just enough to keep it on the sheet.
      const su = U.lerpLog(cwB, g.ah, 0.5), sv = U.lerpLog(lhF, g.bw, 0.5);
      const diag = (lenRef * su + N * sv) * Math.SQRT1_2;
      g.dipK = U.clamp(1 - (Math.min(W, H) * 0.94) / diag, 0, 0.6);
      this.g = g;
      this.invalidate();
    }

    // ---------- geometry helpers ----------
    camera(p) {
      const g = this.g, N = this.N;
      if (p >= 1) return { lh: g.lhF, cw: U.lerpLog(g.cwF, g.cwB, U.easeInOut(U.clamp(p - 1, 0, 1))), R: N };
      const a = U.clamp(p, 0, 1);
      let R;
      if (N <= g.R0) R = N * Math.pow(a, 0.85);
      else if (a < 0.22) R = g.R0 * (a / 0.22);
      else R = g.R0 * Math.pow(N / g.R0, U.easeInOut((a - 0.22) / 0.78));
      const lh = U.clamp(g.ih / Math.max(R, g.ih / g.lhR), g.lhF, g.lhR);
      const z = g.lhR === g.lhF ? 1 : U.clamp(Math.log(g.lhR / lh) / Math.log(g.lhR / g.lhF), 0, 1);
      return { lh, cw: U.lerpLog(g.cwR, g.cwF, z), R };
    }

    // Affine map from local (u = character column, v = line index) to CSS pixels.
    matrix(eRot, lh, cw) {
      const g = this.g;
      const th = (-Math.PI / 2) * eRot;
      const arc = Math.sin(Math.PI * eRot);
      const dip = 1 - g.dipK * arc;
      const su = U.lerpLog(cw, g.ah, eRot) * dip, sv = U.lerpLog(lh, g.bw, eRot) * dip;
      const cx = U.lerp(U.lerp(g.L + g.uA * cw, g.L + g.vA * g.bw, eRot), g.cx, arc);
      const cy = U.lerp(U.lerp(g.T + g.vA * lh, g.midY - g.uA * g.ah, eRot), g.cy, arc);
      const cos = Math.cos(th), sin = Math.sin(th);
      const a = cos * su, b = sin * su, c = -sin * sv, d = cos * sv;
      return { a, b, c, d, e: cx - (a * g.uA + c * g.vA), f: cy - (b * g.uA + d * g.vA), su, sv };
    }

    getBins(k) {
      if (k <= 1) return null;
      if (this.bins.has(k)) return this.bins.get(k);
      const N = this.N, n = Math.ceil(N / k);
      const bin = { k, n, ci: new Uint8Array(n), pre: new Float32Array(n), len: new Float32Array(n), alpha: new Float32Array(n) };
      for (let b = 0; b < n; b++) {
        let best = -1, pre = 1e9, len = 0, al = 0, cnt = 0;
        for (let i = b * k; i < Math.min(N, (b + 1) * k); i++) {
          if (best < 0 || this.len[i] > this.len[best]) best = i;
          pre = Math.min(pre, this.pre[i]);
          len = Math.max(len, this.len[i]);
          al += this.alpha[i]; cnt++;
        }
        bin.ci[b] = this.ci[best]; bin.pre[b] = pre; bin.len[b] = len; bin.alpha[b] = al / cnt;
      }
      this.bins.set(k, bin);
      return bin;
    }

    envelope() {
      if (this.env) return this.env;
      const N = this.N;
      const w = Math.max(3, Math.round(Math.max(this.score.rate * 4, N / 48)));
      // Two box passes ≈ a triangular window: smooth, but still follows the shape.
      const blur = (src) => {
        const pre = new Float64Array(N + 1);
        for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + src[i];
        const out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const a = Math.max(0, i - (w >> 1)), b = Math.min(N, i + (w >> 1) + 1);
          out[i] = (pre[b] - pre[a]) / (b - a);
        }
        return out;
      };
      this.env = blur(blur(this.score.amp));
      return this.env;
    }

    timeX(t) {
      const g = this.g;
      return g.L + U.clamp(t / this.score.linesEnd, 0, 1) * g.iw;
    }
    xToLine(x) {
      const g = this.g;
      return U.clamp(Math.floor((x - g.L) / g.bw), 0, this.N - 1);
    }
    yToLine(y, p) {
      const { lh } = this.camera(p);
      return U.clamp(Math.floor((y - this.g.T) / lh), 0, this.N - 1);
    }

    // ---------- background ----------
    background() {
      if (this.caches.bg) return this.caches.bg;
      const c = document.createElement('canvas');
      c.width = this.cv.width; c.height = this.cv.height;
      const x = c.getContext('2d');
      const dpr = this.dpr, t = this.theme;
      x.fillStyle = t.sheet;
      x.fillRect(0, 0, c.width, c.height);
      const step = 8;
      x.lineWidth = 1;
      for (const [every, color] of [[1, t.gridFine], [5, t.gridMajor]]) {
        x.strokeStyle = color;
        x.beginPath();
        for (let k = 0, px = 0; px <= this.W; k++, px += step) {
          if (every === 1 && k % 5 === 0) continue;
          if (every === 5 && k % 5 !== 0) continue;
          const X = Math.round(px * dpr) + 0.5;
          x.moveTo(X, 0); x.lineTo(X, c.height);
        }
        for (let k = 0, py = 0; py <= this.H; k++, py += step) {
          if (every === 1 && k % 5 === 0) continue;
          if (every === 5 && k % 5 !== 0) continue;
          const Y = Math.round(py * dpr) + 0.5;
          x.moveTo(0, Y); x.lineTo(c.width, Y);
        }
        x.stroke();
      }
      this.caches.bg = c;
      return c;
    }

    // ---------- the morph ----------
    drawBars(ctx, p, cur, playLine) {
      const g = this.g, N = this.N, dpr = this.dpr;
      const eB = U.easeInOut(U.clamp(p - 1, 0, 1));
      const eC = U.easeInOut(U.clamp(p - 2, 0, 1));
      const eD = U.easeInOut(U.clamp(p - 3, 0, 1));
      const eE = U.easeOut(U.clamp(p - 4, 0, 1));
      const cam = this.camera(p);
      const M = this.matrix(eD, cam.lh, cam.cw);
      ctx.setTransform(M.a * dpr, M.b * dpr, M.c * dpr, M.d * dpr, M.e * dpr, M.f * dpr);

      const textVis = p < 3 ? U.smooth(U.clamp((cam.lh - 5.5) / 2.5, 0, 1)) : 0;
      const blocksOK = !!this.blocks && M.su * 1 >= 1.4;
      let wText, wBlock, wBar;
      if (p < 2) { wText = textVis; wBlock = 0; wBar = 1 - textVis; }
      else if (p < 3) { wText = textVis * (1 - eC); wBlock = blocksOK ? eC : 0; wBar = blocksOK ? (1 - textVis) * (1 - eC) : 1 - wText; }
      else if (p < 4) { wText = 0; wBlock = blocksOK ? 1 : 0; wBar = blocksOK ? 0 : 1; }
      else { wText = 0; wBlock = blocksOK ? 1 - eE : 0; wBar = blocksOK ? eE : 1; }

      // Visible v range in tree space (only matters before rotation starts).
      let v0 = 0, v1 = N;
      if (eD === 0) {
        v0 = Math.max(0, Math.floor(-g.T / cam.lh) - 1);
        v1 = Math.min(N, Math.ceil((this.H - g.T) / cam.lh) + 1);
      }
      v1 = Math.min(v1, Math.ceil(cam.R));
      const th = U.lerp(0.62, g.bw >= 3 ? 0.72 : 1, eD);
      const lenCap = g.lenRef * 1.04;
      const dimAfter = playLine;
      const unplayed = U.lerp(1, DIM, eE);
      const B = this.batch;

      // Current-line highlight (tree or wave).
      if (cur >= 0 && cur < N) {
        ctx.fillStyle = this.theme.hl;
        const u0 = this.pre[cur] * (1 - eB);
        const len = U.lerp(this.len[cur], Math.min(this.len[cur], lenCap), eD);
        if (eD < 0.5) ctx.fillRect(-0.6, cur, Math.max(g.lenRef, u0 + len) + 1.2, 1);
        else ctx.fillRect(-len * eE - 0.8, cur - 0.6, len * (1 + eE) + 1.6, 2.2);
      }

      if (wBar > 0.001) {
        const sv = M.sv;
        const k = sv < 0.5 ? Math.pow(2, Math.ceil(Math.log2(0.5 / sv))) : 1;
        const bin = this.getBins(k);
        const n = bin ? bin.n : N;
        const b0 = bin ? Math.floor(v0 / k) : v0, b1 = bin ? Math.ceil(v1 / k) : v1;
        for (let b = b0; b < Math.min(n, b1); b++) {
          const i = bin ? b * k : b;
          const pre = bin ? bin.pre[b] : this.pre[b];
          const len0 = bin ? bin.len[b] : this.len[b];
          const ci = bin ? bin.ci[b] : this.ci[b];
          const al = bin ? bin.alpha[b] : this.alpha[b];
          const reveal = U.clamp(cam.R - i, 0, 1);
          const len = U.lerp(len0, Math.min(len0, lenCap), eD);
          const u0 = pre * (1 - eB);
          const vv = bin ? b * k : b, hh = bin ? k : 1;
          const a = wBar * reveal * al * (i >= dimAfter ? unplayed : 1);
          B.add(ci, a, u0 - len * eE, vv + (hh * (1 - th)) / 2, len * (1 + eE), hh * th);
        }
      }
      if (wBlock > 0.001) {
        for (let i = v0; i < v1; i++) {
          const cov = this.blocks[i];
          const reveal = U.clamp(cam.R - i, 0, 1);
          const ci = this.ci[i];
          const u0 = this.pre[i] * (1 - eB);
          const mul = wBlock * reveal * (i >= dimAfter ? unplayed : 1);
          const maxJ = eD > 0 ? Math.min(cov.length, Math.ceil(U.lerp(cov.length, lenCap, eD))) : cov.length;
          for (let j = 0; j < maxJ; j++) {
            if (cov[j] > 0.02) B.add(ci, mul * (0.25 + 0.75 * cov[j]), u0 + j + 0.1, i + (1 - th) / 2, 0.8, th);
          }
        }
      }
      B.flush(ctx, this.colors);
      return { cam, M, wText, eB, eD, eE, v0, v1 };
    }

    drawText(ctx, st, cur) {
      const { cam, wText, eB, v0, v1 } = st;
      if (wText <= 0.01) return;
      const g = this.g, dpr = this.dpr, L = this.model.lines;
      const fs = Math.min(cam.lh * 0.8, g.fsR);
      const sx = cam.cw / (0.6 * fs);
      ctx.textBaseline = 'middle';
      // Tree guides as vector strokes, so they stay crisp at every zoom.
      const gAlpha = wText * (1 - eB);
      if (gAlpha > 0.01) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = this.theme.ink3;
        ctx.lineWidth = 1;
        ctx.globalAlpha = gAlpha * 0.9;
        ctx.beginPath();
        for (let i = Math.max(1, v0); i < v1; i++) {
          const l = L[i];
          if (cam.R - i <= 0) break;
          const y = g.T + i * cam.lh;
          for (let k = 0; k < l.guides.length; k++) {
            if (!l.guides[k]) continue;
            const x = Math.round(g.L + (k * 4 + 0.5) * cam.cw) + 0.5;
            ctx.moveTo(x, y); ctx.lineTo(x, y + cam.lh);
          }
          const x = Math.round(g.L + ((l.depth - 1) * 4 + 0.5) * cam.cw) + 0.5;
          const ym = Math.round(y + cam.lh / 2) + 0.5;
          ctx.moveTo(x, y); ctx.lineTo(x, l.last ? ym : y + cam.lh);
          ctx.moveTo(x, ym); ctx.lineTo(g.L + ((l.depth - 1) * 4 + 3.1) * cam.cw, ym);
        }
        ctx.stroke();
      }
      for (const bold of [true, false]) {
        ctx.font = `${bold ? 700 : 400} ${fs}px ${FONT_MONO}`;
        for (let i = v0; i < v1; i++) {
          const l = L[i];
          if (l.isDir !== bold) continue;
          const reveal = U.clamp(cam.R - i, 0, 1);
          if (reveal <= 0) continue;
          const x = g.L + this.pre[i] * (1 - eB) * cam.cw;
          const y = g.T + (i + 0.5) * cam.lh;
          ctx.setTransform(dpr * sx, 0, 0, dpr, dpr * x, dpr * y);
          ctx.globalAlpha = wText * reveal;
          ctx.fillStyle = i === cur ? this.theme.ink : this.colors[this.ci[i]];
          ctx.fillText(l.name, 0, 0);
        }
      }
      ctx.globalAlpha = 1;
    }

    drawEnvelope(ctx, alpha) {
      if (alpha <= 0.01) return;
      const g = this.g, dpr = this.dpr, N = this.N;
      const env = this.envelope();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = this.theme.ink2;
      ctx.lineWidth = 1.1;
      ctx.lineJoin = 'round';
      const step = Math.max(1, Math.floor(N / (g.iw * 1.5)));
      for (const sign of [-1, 1]) {
        ctx.beginPath();
        for (let i = 0; i < N; i += step) {
          const x = g.L + (i + 0.5) * g.bw;
          const y = g.midY + sign * env[i] * g.lenRef * g.ah;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Pre-rendered final waveform: unplayed (dim) and played (lit) versions.
    waveCaches() {
      if (this.caches.wave) return this.caches.wave;
      const mk = () => { const c = document.createElement('canvas'); c.width = this.cv.width; c.height = this.cv.height; return c; };
      const dim = mk(), lit = mk();
      for (const [cv, played] of [[dim, false], [lit, true]]) {
        const x = cv.getContext('2d');
        this.drawBars(x, 5, -1, played ? Infinity : -1);
        this.drawEnvelope(x, 1);
        this.drawLeadMarks(x, played ? 1 : 0.5);
      }
      this.caches.wave = { dim, lit };
      return this.caches.wave;
    }

    // Melody notes sit on the silhouette's peaks: mark them above their bars.
    drawLeadMarks(ctx, alpha) {
      const g = this.g, dpr = this.dpr, notes = this.score.notes;
      const r = g.bw >= 4 ? 2.4 : 1.6;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.theme.ink;
      ctx.beginPath();
      for (let i = 0; i < this.N; i++) {
        if (!notes[i] || notes[i].role !== 'lead') continue;
        const x = g.L + (i + 0.5) * g.bw;
        const y = g.midY - Math.min(this.len[i], g.lenRef * 1.04) * g.ah - r - 3;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    frame(p, pos, hover, level) {
      if (!this.model || !this.g) return;
      const ctx = this.ctx, dpr = this.dpr, g = this.g, score = this.score;
      const cur = pos > 0 && pos < score.linesEnd ? score.lineAt(pos) : -1;
      const playLine = pos > 0 ? Math.min(this.N, Math.floor(pos / score.lineDur)) : 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.background(), 0, 0);

      if (p >= 5) {
        const { dim, lit } = this.waveCaches();
        ctx.drawImage(dim, 0, 0);
        const px = this.timeX(pos);
        if (pos > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, Math.round(px * dpr), this.cv.height);
          ctx.clip();
          ctx.drawImage(lit, 0, 0);
          ctx.restore();
        }
        if (cur >= 0) this.drawCurrentBar(ctx, cur, level);
      } else {
        const st = this.drawBars(ctx, p, cur, playLine);
        this.drawText(ctx, st, cur);
        this.drawEnvelope(ctx, U.clamp(p - 4, 0, 1));
      }

      // Playhead (only once the time axis exists).
      const pa = U.clamp((p - 4) * 2, 0, 1);
      if (pa > 0 && (pos > 0 || p >= 5)) {
        const x = this.timeX(pos);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = pa;
        ctx.fillStyle = this.theme.ink;
        ctx.fillRect(Math.round(x) - 0.75, g.T - 6, 1.5, g.ih + 12);
        ctx.beginPath();
        ctx.moveTo(x - 5, g.T - 8); ctx.lineTo(x + 5, g.T - 8); ctx.lineTo(x, g.T - 2); ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (hover >= 0 && p >= 4.5) {
        const x = g.L + (hover + 0.5) * g.bw;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = this.theme.ink2;
        ctx.fillRect(Math.round(x) - 0.5, g.T, 1, g.ih);
        ctx.globalAlpha = 1;
      }
    }

    drawCurrentBar(ctx, i, level) {
      const g = this.g, dpr = this.dpr;
      const len = Math.min(this.len[i], g.lenRef * 1.04);
      const h = len * g.ah;
      const x = g.L + i * g.bw;
      const w = Math.max(2, g.bw * (g.bw >= 3 ? 0.72 : 1));
      const cx = g.bw >= 3 ? x + g.bw * 0.14 : x + g.bw / 2 - w / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = this.theme.hl;
      ctx.fillRect(cx - 3, g.midY - h - 4, w + 6, 2 * h + 8);
      ctx.shadowColor = this.colors[this.ci[i]];
      ctx.shadowBlur = 6 + Math.min(18, level * 90);
      ctx.fillStyle = this.colors[this.ci[i]];
      ctx.fillRect(cx, g.midY - h, w, 2 * h);
      ctx.shadowBlur = 0;
    }

    // ---------- piano roll ----------
    rollCaches() {
      if (this.caches.roll) return this.caches.roll;
      const dpr = this.dpr, W = this.W, H = this.RH, g = this.g, score = this.score, t = this.theme;
      const L = this.model.lines;
      const mk = () => { const c = document.createElement('canvas'); c.width = this.rc.width; c.height = this.rc.height; return c; };
      const dim = mk(), lit = mk();
      const top = ROLL_TOP, bottom = H - ROLL_BOTTOM, nh = bottom - top;
      let lo = 127, hi = 0;
      for (const n of score.notes) if (n && n.midi != null) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
      if (lo > hi) { lo = 48; hi = 84; }
      lo -= 2; hi += 2;
      const yOf = (m) => top + (1 - (m - lo) / (hi - lo)) * nh;
      const X = (tt) => this.timeX(tt);
      const noteW = Math.max(1, (score.lineDur / score.linesEnd) * g.iw * 0.85);

      for (const [cv, played] of [[dim, false], [lit, true]]) {
        const x = cv.getContext('2d');
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        x.fillStyle = t.sheet;
        x.fillRect(0, 0, W, H);
        // chord bands
        score.chords.forEach((c, k) => {
          if (c.coda) return;
          const x0 = X(c.t), x1 = X(c.t + c.dur);
          if (k % 2 === 0) { x.fillStyle = t.band; x.fillRect(x0, top, x1 - x0, nh); }
        });
        // notes: accompaniment thin and faint, melody bold, ornaments as dots
        const hScale = played ? 1 : DIM;
        const pxs = g.iw / score.linesEnd;
        for (const role of ['arp', 'lead']) {
          for (let i = 0; i < score.notes.length; i++) {
            const n = score.notes[i];
            if (!n || n.role !== role || n.midi == null) continue;
            x.fillStyle = this.colors[this.ci[i]];
            if (role === 'arp') {
              x.globalAlpha = 0.4 * hScale;
              x.fillRect(X(score.timeOf(i)), yOf(n.midi) - 1, Math.max(1, noteW), 2);
            } else {
              x.globalAlpha = 0.95 * hScale;
              const w = Math.max(3, Math.min(n.dur, score.beat * 2) * pxs - 1);
              x.fillRect(X(score.timeOf(i)), yOf(n.midi) - 2, w, 4);
            }
          }
        }
        for (let i = 0; i < score.notes.length; i++) {
          const n = score.notes[i];
          if (!n || !n.orn) continue;
          x.globalAlpha = 0.8 * hScale;
          x.fillStyle = this.colors[this.ci[i]];
          x.beginPath();
          x.arc(X(score.timeOf(i)) + 1, yOf(n.orn.midi), 1.8, 0, Math.PI * 2);
          x.fill();
        }
        x.globalAlpha = 1;
        // folder gestures as ticks along the bottom edge of the note area
        x.fillStyle = t.ink;
        x.globalAlpha = played ? 0.75 : 0.35;
        for (let i = 0; i < L.length; i++) {
          const n = score.notes[i];
          if (n && n.hit) x.fillRect(X(score.timeOf(i)), bottom - 5, Math.max(1, noteW * 0.8), 5);
        }
        x.globalAlpha = 1;
        // chord names
        x.font = `500 10px ${FONT_MONO}`;
        x.textBaseline = 'top';
        x.fillStyle = t.ink3;
        let lastRight = -1e9;
        for (const c of score.chords) {
          if (c.coda) continue;
          const x0 = X(c.t) + 3;
          const w = x.measureText(c.name).width;
          if (x0 > lastRight + 6 && X(c.t + c.dur) - x0 >= Math.min(w, 26)) {
            x.fillText(c.name, x0, top + 2);
            lastRight = x0 + w;
          }
        }
        // sections along the top strip
        x.font = `500 10px ${FONT_MONO}`;
        x.textBaseline = 'middle';
        lastRight = -1e9;
        for (const sec of score.sections) {
          const x0 = X(sec.bar * score.barDur);
          x.fillStyle = t.ink3;
          x.fillRect(Math.round(x0), 2, 1, top - 2);
          const w = x.measureText(sec.label).width;
          if (x0 + 4 > lastRight + 8 && x0 + 4 + w < W) {
            x.fillStyle = t.ink2;
            x.fillText(sec.label, x0 + 4, top / 2 + 1);
            lastRight = x0 + 4 + w;
          }
        }
        // time ruler
        const total = score.linesEnd;
        const pxPerSec = g.iw / total;
        const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
        const every = steps.find((s) => s * pxPerSec >= 64) || 600;
        x.fillStyle = t.ink3;
        x.textBaseline = 'alphabetic';
        x.font = `400 10px ${FONT_MONO}`;
        for (let s = 0; s <= total + 1e-6; s += every) {
          const xx = X(s);
          x.fillRect(Math.round(xx), bottom, 1, 4);
          const label = U.fmtTime(s);
          const w = x.measureText(label).width;
          x.fillText(label, U.clamp(xx - w / 2, 0, W - w), H - 3);
        }
      }
      this.caches.roll = { dim, lit };
      return this.caches.roll;
    }

    rollFrame(pos, hover, visible) {
      if (!this.model || !this.g || !this.RH) return;
      const ctx = this.rctx, dpr = this.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = visible;
      ctx.clearRect(0, 0, this.rc.width, this.rc.height);
      if (visible <= 0.001) return;
      const { dim, lit } = this.rollCaches();
      ctx.drawImage(dim, 0, 0);
      const px = this.timeX(pos);
      if (pos > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, Math.round(px * dpr), this.rc.height);
        ctx.clip();
        ctx.drawImage(lit, 0, 0);
        ctx.restore();
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = visible;
      ctx.fillStyle = this.theme.ink;
      if (pos > 0) ctx.fillRect(Math.round(px) - 0.75, 0, 1.5, this.RH - ROLL_BOTTOM + 4);
      if (hover >= 0) {
        const x = this.g.L + (hover + 0.5) * this.g.bw;
        ctx.globalAlpha = 0.5 * visible;
        ctx.fillStyle = this.theme.ink2;
        ctx.fillRect(Math.round(x) - 0.5, 0, 1, this.RH - ROLL_BOTTOM);
      }
      ctx.globalAlpha = 1;
    }
  }

  return { View, PHASES };
})();
