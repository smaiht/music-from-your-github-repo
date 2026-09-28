'use strict';
// WAV and MIDI files, plus a tiny ZIP writer for hosts that only allow .zip downloads.

const Exporters = (() => {
  function wav(buffer) {
    const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
    const data = [];
    let peak = 1e-6;
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      data.push(d);
      for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    const norm = Math.min(4, 0.89 / peak); // peak at -1 dBFS
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * ch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i] * norm));
        out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // ---- Standard MIDI File, format 1: one track per part and instrument ----
  const PROGRAM = {
    guitar: 24, rhodes: 4, vibes: 11, kalimba: 108, marimba: 12, musicbox: 10, glass: 8, sawpluck: 81,
    pulse50: 80, pulse25: 80, pulse12: 80, tri: 80, polylead: 81, brass: 62,
  };
  const PAD_PROGRAM = { warm: 89, air: 94, supersaw: 90 };
  const BASS_PROGRAM = { warm: 32, sub: 38, saw: 38, tri: 38 };
  const PART = { lead: 'Melody', arp: 'Arpeggio', orn: 'Ornaments', strum: 'Folders', comp: 'Keys', pad: 'Pad', bass: 'Bass' };
  const DRUM_KEY = {
    kick: 36, snare: 38, gsnare: 40, clap: 39, rim: 37, hat: 42, ohat: 46, shaker: 70, tamb: 54, crash: 49,
    tom1: 50, tom2: 47, tom3: 43, impact: 35,
  };

  function vlq(n) {
    const bytes = [n & 0x7f];
    while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
    return bytes;
  }
  function textBytes(s) { return Array.from(new TextEncoder().encode(s)); }

  function midi(score, title) {
    const PPQ = 480;
    const st = Styles.get(score.style);
    const tick = (t) => Math.max(0, Math.round((t / score.beat) * PPQ));
    const vel = (v) => U.clamp(Math.round(v * 127), 1, 127);
    const tracks = new Map();
    const trackFor = (key, name, prog, drums) => {
      if (!tracks.has(key)) tracks.set(key, { name, prog, drums, evs: [] });
      return tracks.get(key);
    };
    const add = (tr, t, dur, note, v) => {
      const on = tick(t), off = Math.max(on + 1, tick(t + dur));
      tr.evs.push({ tick: on, order: 1, note, v: vel(v), on: true });
      tr.evs.push({ tick: off, order: 0, note, on: false });
    };
    for (const e of score.events) {
      if (DRUM_KEY[e.k]) { add(trackFor('drums', 'Drums', -1, true), e.t, 0.1, DRUM_KEY[e.k], e.vel); continue; }
      if (e.k === 'pad') { const tr = trackFor('pad', 'Pad', PAD_PROGRAM[st.pad] || 89); for (const m of e.notes) add(tr, e.t, e.dur, m, 0.35 + 0.3 * e.vel); continue; }
      if (e.k === 'bass') { add(trackFor('bass', 'Bass', BASS_PROGRAM[st.bass] || 33), e.t, e.dur, e.midi, e.vel); continue; }
      if (!PART[e.k] || !e.inst) continue;
      const tr = trackFor(`${e.k}:${e.inst}`, `${PART[e.k]} (${e.inst})`, PROGRAM[e.inst] ?? 0);
      if (e.notes) e.notes.forEach((m, j) => add(tr, e.t + j * (e.gap || 0), Math.max(0.1, (e.dur || 1) - j * (e.gap || 0)), m, e.vel));
      else add(tr, e.t, Math.max(0.08, e.dur || 0.3), e.midi, Math.min(1, e.vel * 1.1));
    }
    const chunks = [];
    const tempo = Math.round(60000000 / score.bpm);
    chunks.push(track([
      { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(textBytes(title).length), ...textBytes(title)] },
      { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
      { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
    ]));
    let ch = 0;
    for (const tr of tracks.values()) {
      let c = 9;
      if (!tr.drums) { if (ch === 9) ch++; c = ch % 16 === 9 ? 10 : ch % 16; ch++; }
      const name = textBytes(tr.name);
      const evs = [{ tick: 0, order: -2, bytes: [0xff, 0x03, ...vlq(name.length), ...name] }];
      if (tr.prog >= 0) evs.push({ tick: 0, order: -1, bytes: [0xc0 | c, tr.prog] });
      for (const e of tr.evs) evs.push({ tick: e.tick, order: e.order, bytes: e.on ? [0x90 | c, e.note, e.v] : [0x80 | c, e.note, 0] });
      chunks.push(track(evs));
    }
    const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, (PPQ >> 8) & 255, PPQ & 255];
    return new Blob([new Uint8Array(header), ...chunks], { type: 'audio/midi' });
  }

  function track(events) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const bytes = [];
    let last = 0;
    for (const e of events) {
      bytes.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    bytes.push(0, 0xff, 0x2f, 0x00);
    const len = bytes.length;
    return new Uint8Array([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...bytes]);
  }

  // ---- ZIP (stored, no compression) ----
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = new TextEncoder().encode(f.name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // Inside the claude.ai viewer, downloads go through the `downloads` capability
  // (its allowlist has .zip but not .wav/.mid). Elsewhere a plain link works.
  let hostDownloads;
  function initHost() {
    if (hostDownloads !== undefined) return hostDownloads;
    const c = window.claude;
    hostDownloads = c && typeof c.use === 'function' ? c.use('downloads').catch(() => null) : Promise.resolve(null);
    return hostDownloads;
  }

  async function save(filename, blob) {
    const dl = await initHost();
    if (dl) {
      const z = await zip([{ name: filename, blob }]);
      await dl.save({ filename: filename.replace(/\.[^.]+$/, '') + '.zip', data: z });
      return 'zip';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'file';
  }

  return { wav, midi, zip, save, initHost };
})();
