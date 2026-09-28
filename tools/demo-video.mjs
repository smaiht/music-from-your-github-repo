// Renders the README demo: media/demo.mp4 (with sound) and media/preview.gif.
// Not a screen recording: it steps the page's own renderer through a virtual clock,
// screenshots every frame over the Chrome DevTools Protocol, and lays over it the
// track the same engine renders offline, so picture and sound line up to the sample.
//   node tools/build.mjs && node tools/demo-video.mjs [pageUrl]
// Needs Chrome (CHROME=/path/to/chrome to override) and ffmpeg. No npm packages.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.argv[2] || `${pathToFileURL(path.join(ROOT, 'dist', 'filophone.html')).href}#smaiht~photobooth`;
const MEDIA = path.join(ROOT, 'media');
const OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'filophone-video-'));
const CHROME = process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome');
const PORT = 9333;
const W = 1280, H = 880, DPR = 1.5, FPS = 30;
// Timeline (seconds): type the link, press play, the tree turns into a wave (Stage.PHASES, 6.8 s), then it plays.
const TYPE_END = 1.5, MORPH_START = 1.9, MORPH = 6.8, PLAY = 42;
const PLAY_START = MORPH_START + MORPH;
const TOTAL = PLAY_START + PLAY;
// The README preview: the transformation and the first seconds of sound, as a silent loop.
const GIF_FROM = MORPH_START, GIF_LEN = 11, GIF_FPS = 12, GIF_W = 720;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await fs.mkdir(path.join(OUT, 'frames'), { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'profile')}`,
  '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const pg = list.find((t) => t.type === 'page');
    if (pg) wsUrl = pg.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) throw new Error('Chrome did not start');

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    const { res, rej } = pending.get(d.id);
    pending.delete(d.id);
    if (d.error) rej(new Error(d.error.message)); else res(d.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
// Load the page; reload if its scripts did not come up.
for (let attempt = 1; ; attempt++) {
  await send('Page.navigate', { url: PAGE });
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    await sleep(200);
    try { ok = await run(`typeof App === 'object' && document.readyState === 'complete'`); } catch { /* navigating */ }
  }
  if (ok) break;
  if (attempt === 3) throw new Error('page did not load');
}

// Wait for the tree to load, then take over the clock.
const info = await run(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 300; i++) { if (App.state.score && document.getElementById('loader').hidden) break; await wait(100); }
  if (!App.state.score) throw new Error('no score');
  await document.fonts.ready;
  await wait(500);
  const P = App.player, S = App.state;
  P.pause();
  const V = window.__V = { pos: 0, playing: false, level: 0 };
  P.position = () => V.pos;
  P.level = () => V.level;
  Object.defineProperty(P, 'playing', { get: () => V.playing, set() {}, configurable: true });
  S.autoplay = false; S.blocked = false; S.anim = null; S.p = 0; S.dirty = true;
  // Page chrome that only reflects this machine's state: toast, API quota, snapshot note.
  const toast = document.getElementById('toast'); toast.classList.remove('is-on'); toast.style.display = 'none';
  document.getElementById('quota').textContent = '';
  document.getElementById('repoDesc').textContent = '';
  // Fixed stage height so the piano roll (with the peak and drop marks) fits in the frame.
  document.head.append(Object.assign(document.createElement('style'), { textContent: '.stage-wrap{height:416px!important}' }));
  document.getElementById('treeScroll').scrollTop = 0;
  S.lastLine = -2;
  window.scrollTo(0, 0);

  // The track, rendered offline with the same engine the page plays live.
  const score = S.score;
  const buf = await Engine.renderOffline(score, {});
  const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.getChannelData(1);
  // Level per video frame, like the page's analyser (1024 samples), scaled for the default volume.
  const levels = [];
  for (let k = 0; k * ${1 / FPS} < ${PLAY}; k++) {
    const end = Math.round(k * ${1 / FPS} * sr), a = Math.max(0, end - 1024);
    let s = 0; for (let i = a; i < end; i++) { const m = (L[i] + R[i]) / 2; s += m * m; }
    levels.push(end > a ? Math.sqrt(s / (end - a)) * 0.8 : 0);
  }
  window.__levels = levels;
  // Audio for the video: the first PLAY seconds, faded out over the last 3.
  const n = Math.round(${PLAY} * sr), fade = Math.round(3 * sr);
  const out = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: 2 });
  for (const [ch, src] of [[0, L], [1, R]]) {
    const d = src.slice(0, n);
    for (let i = n - fade; i < n; i++) d[i] *= Math.pow((n - i) / fade, 1.5);
    out.copyToChannel(d, ch);
  }
  const bytes = new Uint8Array(await Exporters.wav(out).arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  window.__wav = btoa(bin);
  return { title: S.source.title, style: S.style, bpm: score.bpm, wavChars: window.__wav.length };
})()`);
console.log(`${info.title}, ${info.style}, ${info.bpm} BPM`);

// Pull the WAV out in slices.
let b64 = '';
for (let i = 0; i < info.wavChars; i += 4_000_000) b64 += await run(`window.__wav.slice(${i}, ${i + 4_000_000})`);
await fs.writeFile(path.join(OUT, 'audio.wav'), Buffer.from(b64, 'base64'));

// One page-side call per frame: set the virtual clock, let the page draw, then screenshot.
await run(`(() => {
  const PH = Stage.PHASES, starts = []; let tot = 0;
  for (const ph of PH) { starts.push(tot); tot += ph.dur; }
  const timeToP = (t) => { t = Math.max(0, Math.min(tot, t)); for (let k = PH.length - 1; k >= 0; k--) if (t >= starts[k]) return Math.min(5, k + (t - starts[k]) / PH[k].dur); return 0; };
  const url = 'github.com/' + (App.state.source.repo ? App.state.source.repo.full : App.state.source.title);
  const input = document.getElementById('repoInput'), go = document.getElementById('goBtn'), caption = document.getElementById('caption');
  window.__frame = async (t) => {
    const S = App.state, V = window.__V;
    caption.style.visibility = t < ${MORPH_START} ? 'hidden' : '';
    if (t < ${TYPE_END}) {
      input.focus();
      input.value = url.slice(0, Math.round(url.length * Math.min(1, t / (${TYPE_END} - 0.2))));
      S.anim = null; S.p = 0; V.pos = 0; V.playing = false;
    } else if (t < ${MORPH_START}) {
      input.value = url; input.blur();
      go.style.opacity = t < ${TYPE_END} + 0.2 ? '0.8' : '';
      S.anim = null; S.p = 0; V.pos = 0; V.playing = false;
    } else if (t < ${PLAY_START}) {
      go.style.opacity = '';
      const p = timeToP(t - ${MORPH_START});
      S.p = p; S.anim = { kind: 'tween', from: p, to: p, t0: performance.now(), dur: 1e9 };
      V.pos = 0; V.playing = false;
    } else {
      S.anim = null; S.p = 5; V.playing = true;
      V.pos = t - ${PLAY_START};
      V.level = window.__levels[Math.min(window.__levels.length - 1, Math.round(V.pos * ${FPS}))] || 0;
    }
    document.getElementById('playBtn').classList.toggle('is-playing', V.playing);
    S.dirty = true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
})()`);

const frames = Math.round(TOTAL * FPS);
const t0 = Date.now();
for (let k = 0; k < frames; k++) {
  await run(`__frame(${(k / FPS).toFixed(5)})`);
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  await fs.writeFile(path.join(OUT, 'frames', `${String(k).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
  if (k % 150 === 0) console.log(`frame ${k}/${frames} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ws.close();
chrome.kill();

const exec = (args) => new Promise((res, rej) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  p.on('exit', (code) => (code ? rej(new Error(`ffmpeg exited with ${code}`)) : res()));
});
await fs.mkdir(MEDIA, { recursive: true });
const frameGlob = path.join(OUT, 'frames', '%05d.jpg');
await exec([
  '-framerate', String(FPS), '-i', frameGlob, '-i', path.join(OUT, 'audio.wav'),
  '-filter_complex', `[0:v]scale=1280:-2:flags=lanczos,format=yuv420p[v];[1:a]adelay=${Math.round(PLAY_START * 1000)}:all=1[a]`,
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-tune', 'animation',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', path.join(MEDIA, 'demo.mp4'),
]);
await exec([
  '-framerate', String(FPS), '-start_number', String(Math.round(GIF_FROM * FPS)), '-i', frameGlob,
  '-frames:v', String(Math.round(GIF_LEN * FPS)),
  '-vf', `fps=${GIF_FPS},scale=${GIF_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  path.join(MEDIA, 'preview.gif'),
]);
await fs.rm(OUT, { recursive: true, force: true });
for (const f of ['demo.mp4', 'preview.gif']) console.log(`media/${f} ${((await fs.stat(path.join(MEDIA, f))).size / 1e6).toFixed(1)} MB`);
process.exit(0);
