'use strict';
// Small shared helpers. Every module is a classic script sharing one global scope,
// so the page also works when opened straight from disk (file://).

const U = {
  clamp: (x, a, b) => (x < a ? a : x > b ? b : x),
  lerp: (a, b, t) => a + (b - a) * t,
  lerpLog: (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t),
  smooth: (t) => t * t * (3 - 2 * t),
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOut: (t) => 1 - Math.pow(1 - t, 3),

  // FNV-1a, 32 bit. Deterministic across browsers, so one repo always gives one song.
  hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  },

  // mulberry32 PRNG
  rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  percentile(values, q) {
    if (!values.length) return 0;
    const s = Float64Array.from(values).sort();
    const pos = U.clamp(q, 0, 1) * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(s.length - 1, lo + 1);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  },

  lowerBound(arr, t, key = (x) => x.t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (key(arr[mid]) < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  },

  fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  },

  fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  // count(3, 'file') → '3 files'. Pass the plural when it isn't just +s.
  count(n, one, many = `${one}s`) {
    return `${U.fmtInt(n)} ${n === 1 ? one : many}`;
  },

  NOTE_NAMES: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'],
  midiName(m) {
    return U.NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  },
  mtof: (m) => 440 * Math.pow(2, (m - 69) / 12),

  storage: {
    get(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try {
        if (value == null || value === '') window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch (e) { /* storage blocked: the setting just won't persist */ }
    },
  },

  el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  },

  prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  },
};
