'use strict';
// Wires sources → model → score → stage/player, and all the controls.

const App = (() => {
  const $ = (id) => document.getElementById(id);
  // Opens with this repo: fetched live from GitHub, the embedded snapshot covers rate limits and sandboxes.
  const DEFAULT_REPO = 'smaiht/photobooth';
  const SPEEDS = [0.25, 0.5, 1, 2, 4];
  // Renamed with the synthwave default, so earlier visitors start on the new default once.
  const STYLE_KEY = 'filophone.style';
  const PH = Stage.PHASES;
  const PH_START = [];
  let PH_TOTAL = 0;
  for (const ph of PH) { PH_START.push(PH_TOTAL); PH_TOTAL += ph.dur; }

  const state = {
    model: null, score: null, source: null, demoId: null,
    p: 0, anim: null, autoplay: false, blocked: false,
    speed: 1, bpm: 0, style: Styles.LIST[U.storage.get(STYLE_KEY)] ? U.storage.get(STYLE_KEY) : Styles.DEFAULT,
    hover: -1, lastLine: -2, dirty: true, loadSeq: 0,
  };
  const ui = { timeNow: '', phase: -1, morphDragging: false, seekDragging: false, seekVal: -1, playing: null, ask: false };
  const player = new Engine.Player();
  let view = null, panel = null;

  // ---------- morph timeline ----------
  const pToTime = (p) => {
    p = U.clamp(p, 0, 5);
    const k = Math.min(4, Math.floor(p));
    return PH_START[k] + (p - k) * PH[k].dur;
  };
  const timeToP = (t) => {
    t = U.clamp(t, 0, PH_TOTAL);
    for (let k = 4; k >= 0; k--) if (t >= PH_START[k]) return Math.min(5, k + (t - PH_START[k]) / PH[k].dur);
    return 0;
  };
  function playMorph(from) {
    if (U.prefersReducedMotion()) { state.p = 5; state.anim = null; morphDone(); return; }
    state.anim = { kind: 'phases', t0: performance.now() - pToTime(from) * 1000 };
    state.dirty = true;
  }
  function tweenTo(target, ms) {
    if (U.prefersReducedMotion()) { state.p = target; state.anim = null; state.dirty = true; if (target >= 5) morphDone(); return; }
    state.anim = { kind: 'tween', from: state.p, to: target, t0: performance.now(), dur: ms || 700 };
  }
  function advance(now) {
    const a = state.anim;
    if (!a) return;
    if (a.kind === 'phases') {
      state.p = timeToP((now - a.t0) / 1000);
      if (state.p >= 5) { state.p = 5; state.anim = null; morphDone(); }
    } else {
      const k = U.clamp((now - a.t0) / a.dur, 0, 1);
      state.p = U.lerp(a.from, a.to, U.easeInOut(k));
      if (k >= 1) { state.anim = null; if (state.p >= 5) morphDone(); }
    }
    state.dirty = true;
  }
  function morphDone() {
    state.dirty = true;
    ui.phase = -1;
    if (state.autoplay) { state.autoplay = false; autoplay(); return; }
    nudgePlay();
  }
  function nudgePlay() {
    const b = $('playBtn');
    if (player.playing) return;
    b.classList.remove('is-ready');
    void b.offsetWidth;
    b.classList.add('is-ready');
  }
  // Plays on its own when the browser allows sound without a click; otherwise asks for one.
  async function autoplay() {
    const seq = state.loadSeq;
    const ok = await Engine.canStart();
    if (seq !== state.loadSeq || player.playing) return;
    if (ok) { player.play(); return; }
    state.blocked = true;
    state.dirty = true;
    nudgePlay();
  }

  // ---------- render loop ----------
  function loop(now) {
    requestAnimationFrame(loop);
    advance(now);
    if (!state.score) return;
    if (!state.dirty && !player.playing) return;
    state.dirty = false;
    const pos = player.position();
    view.frame(state.p, pos, state.hover, player.level());
    view.rollFrame(pos, state.hover, U.clamp((state.p - 4.2) / 0.8, 0, 1));
    syncUi(pos);
  }

  function syncUi(pos) {
    const s = state.score;
    const t = U.fmtTime(Math.min(pos, s.duration));
    if (t !== ui.timeNow) { $('timeNow').textContent = t; ui.timeNow = t; }
    if (!ui.morphDragging && ui.morphVal !== state.p) { setRange($('morphRange'), state.p); ui.morphVal = state.p; }
    const sv = Math.round(Math.min(pos, s.duration) * 10) / 10;
    if (!ui.seekDragging && sv !== ui.seekVal) { setRange($('seekRange'), sv); ui.seekVal = sv; }
    const ask = state.blocked && !player.playing && !state.anim;
    if (ask !== ui.ask) { $('stagePlay').hidden = !ask; $('playBtn').classList.toggle('is-waiting', ask); ui.ask = ask; }
    const phase = state.p >= 5 ? 5 : Math.floor(state.p);
    if (phase !== ui.phase || ui.playing !== player.playing) {
      ui.phase = phase;
      ui.playing = player.playing;
      renderSteps(phase);
      $('caption').textContent = phase < 5 && state.anim ? `${phase + 1} of 5 · ${PH[phase].label}` : captionIdle();
    }
    let line;
    if (pos >= s.linesEnd) line = -1;
    else line = pos > 0 ? s.lineAt(pos) : 0;
    if (line !== state.lastLine) {
      state.lastLine = line;
      renderReadout(line, pos);
      renderNowPlaying(line, pos);
      panel.setCurrent(pos > 0 || player.playing ? line : -1, player.playing || state.follow);
      state.follow = false;
    }
  }

  // Range inputs paint their filled part from --p.
  function fillRange(el) {
    const lo = Number(el.min) || 0, hi = Number(el.max) || 1;
    el.style.setProperty('--p', `${U.clamp(((Number(el.value) - lo) / (hi - lo || 1)) * 100, 0, 100)}%`);
  }
  function setRange(el, v) { el.value = String(v); fillRange(el); }

  // The sticky bar: which file is sounding, over which chord and section.
  function renderNowPlaying(i, pos) {
    const s = state.score, path = $('npPath');
    path.textContent = '';
    if (i < 0) {
      path.append(U.el('span', { class: 'np-file', text: 'coda' }));
      $('npMeta').textContent = `${s.chords[s.chords.length - 1].name} · home`;
      return;
    }
    const l = state.model.lines[i];
    const dirs = l.path ? l.path.split('/') : [];
    const name = dirs.pop() || l.name;
    if (dirs.length) path.append(U.el('span', { class: 'np-dir', text: `${dirs.join('/')}/` }));
    path.append(U.el('span', { class: 'np-file', text: l.isDir && l.depth > 0 ? `${name}/` : name }));
    path.title = l.path || l.name;
    const tt = pos > 0 ? pos : s.timeOf(i);
    const sec = s.sections[s.notes[i] && s.notes[i].sec != null ? s.notes[i].sec : 0];
    $('npMeta').textContent = `${s.chordAt(tt).name} · ${sec.label}`;
  }

  function captionIdle() {
    if (player.playing) return '';
    if (state.p < 5) return state.p <= 0.001 ? 'The whole tree. Drag the “Tree ↔ wave” slider or press ▶' : '';
    if (player.position() >= state.score.duration - 0.05) return 'The end. Press ▶ to listen again';
    return player.position() > 0 ? 'Paused' : 'The wave is ready. Press ▶ or Space';
  }

  // ---------- header, facts, legend ----------
  function renderHeader() {
    const src = state.source;
    $('repoTitle').textContent = src.title;
    document.title = `${src.title} · Filophone`;
    let desc = '';
    if (src.meta && src.meta.description) desc = src.meta.description;
    else if (src.kind === 'demo') desc = 'Built-in tree snapshot: loads instantly and doesn’t use up your GitHub rate limit.';
    else if (src.kind === 'local') desc = 'Local folder. Files never leave your computer: only names and sizes are read.';
    else if (src.kind === 'paste') desc = 'Pasted file list.';
    $('repoDesc').textContent = desc;
    const n = state.model.lines.length;
    $('treeCount').textContent = U.count(n, 'line');
  }

  function renderFacts() {
    const s = state.score, st = state.model.stats;
    const dl = $('repoFacts');
    dl.textContent = '';
    const add = (k, v, title) => {
      const d = U.el('div', title ? { title } : null, U.el('dt', { text: k }), U.el('dd', { text: v }));
      dl.append(d);
    };
    add('Files', U.fmtInt(st.files), `${U.count(st.lines, 'line')} in the expanded tree`);
    add('Folders', U.fmtInt(st.dirs));
    add('Sections', String(s.sections.length), s.sections.map((x) => x.label).join(', '));
    add('Key', `${s.key.rootName} ${s.key.modeName}`);
    add('Tempo', `${s.bpm} BPM`);
    add('Length', U.fmtTime(s.duration));
  }

  // "Why it sounds like this": each trait of the tree next to what it became.
  function renderTraits() {
    const s = state.score, st = state.model.stats, ch = s.character, src = state.source;
    const style = Styles.get(state.style);
    const ul = $('traits');
    ul.textContent = '';
    const pct = (x) => `${Math.round(x * 100)}%`;
    const add = (k, v, why, opts = {}) => {
      const head = U.el('span', { class: 'trait-k' }, opts.cat ? U.el('span', { class: `dot cat-${opts.cat}` }) : null, k, opts.seek != null ? U.el('span', { class: 'go', text: `${U.fmtTime(opts.seek)} ↗` }) : null);
      const body = [head, U.el('span', { class: 'trait-v', text: v }), U.el('span', { class: 'trait-why', text: why })];
      const off = opts.off ? ' is-off' : '';
      const node = opts.seek != null
        ? U.el('button', { type: 'button', class: `trait${off}`, title: `Jump to ${U.fmtTime(opts.seek)}`, onclick: () => { Engine.unlock(); if (state.anim) { state.anim = null; state.p = 5; } seekTo(opts.seek); } }, ...body)
        : U.el('div', { class: `trait${off}` }, ...body);
      ul.append(U.el('li', null, node));
    };
    add('Key', s.key.rootName, `hashed from the name ${src.repo ? src.repo.full : src.name}`);
    add('Mode', s.key.modeName, s.key.fromLang ? `${st.lang} is ${pct(st.langShare)} of the code` : 'no dominant language, so it comes from the name', { cat: 'code' });
    add('Tempo', `${s.bpm} BPM`, state.bpm ? 'set by hand' : `names are ${Math.round(st.medianLen)} characters long (median)`);
    if (ch.color) {
      const kinds = Model.CAT_ORDER.filter((k) => st.catCount[k]).length;
      add('Chord colour', { triad: 'plain triads', add9: 'added ninths', seventh: 'seventh chords' }[ch.color], `${kinds} kinds of files, variety ${pct(ch.entropy)}`);
    }
    if (style.testPerc) {
      const on = ch.tests >= 0.05;
      add('Percussion', on ? `${style.testPerc.kind === 'tamb' ? 'tambourine' : 'shaker'}${ch.tests >= 0.2 ? ', early' : ''}` : 'none', `${pct(ch.tests)} of the files are tests`, { cat: 'test', off: !on });
    }
    add('Hi-hats', ch.busyHats ? 'busy sixteenths' : 'steady', `${pct(ch.config)} config and tooling`, { cat: 'tool', off: !ch.busyHats });
    if (style.pad) {
      const db = 20 * Math.log10(ch.padMul);
      add('Pads', `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`, `${pct(ch.docs)} of the files are docs`, { cat: 'docs' });
    }
    add('Room', `${ch.room.toFixed(1)} s of reverb`, src.noSizes || !st.bytes ? `${U.count(st.files, 'file')} in total` : `${U.fmtBytes(st.bytes)} in total`, { cat: 'media' });
    add('Runs', ch.runs ? U.count(ch.runs, 'climbing note') : 'none', ch.runs ? 'numbered files like 01, 02, 03' : 'no numbered files in a row', { off: !ch.runs });
    for (const m of s.landmarks) {
      const l = state.model.lines[m.line];
      if (m.kind === 'peak') add('The peak', l.name, `the deepest file after the intro, ${l.depth} folders down`, { seek: m.t, cat: l.cat });
      else add('The drop', l.name, `the biggest file, ${U.fmtBytes(l.size)}`, { seek: m.t, cat: l.cat });
    }
  }

  function renderLegend() {
    const ul = $('legend');
    ul.textContent = '';
    const counts = state.model ? state.model.stats.catCount : {};
    const st = Styles.get(state.style);
    for (const key of ['dir', ...Model.CAT_ORDER]) {
      const c = Model.CATS[key];
      const n = counts[key] || 0;
      const inst = key === 'dir' ? 'a new arpeggio pattern and a chord hit' : Styles.instName(st.leadMap[key]);
      const li = U.el('li', null,
        U.el('span', { class: `swatch cat-${key}` }),
        U.el('span', { class: 'lg-name', text: `${c.label}: ${inst}` }),
        U.el('span', { class: 'lg-meta', text: state.model ? `${U.count(n, 'line')} in this tree` : '' }),
      );
      ul.append(li);
    }
  }

  function renderSpeedOptions() {
    const sel = $('speedSel');
    sel.textContent = '';
    const frac = { 0.25: '¼', 0.5: '½' };
    for (const m of SPEEDS) {
      const r = state.score.baseRate * m;
      const label = `${frac[r] || r}${m === 1 ? ' (auto)' : ''}`;
      sel.append(U.el('option', { value: String(m), text: label, selected: m === state.speed }));
    }
  }

  function renderBpm() {
    const s = state.score;
    setRange($('bpmRange'), s.bpm);
    $('bpmOut').textContent = `${s.bpm}${state.bpm ? '' : ' · auto'}`;
    $('bpmAuto').disabled = !state.bpm;
  }

  function updateTotal() {
    $('timeTotal').textContent = U.fmtTime(state.score.duration);
    $('seekRange').max = String(state.score.duration);
    fillRange($('seekRange'));
    ui.timeNow = ''; ui.seekVal = -1;
  }

  function renderSteps(phase) {
    const ol = $('steps');
    if (!ol.children.length) {
      PH.forEach((ph, k) => {
        const btn = U.el('button', { type: 'button', 'data-k': String(k), title: ph.label },
          U.el('span', { class: 'num', text: String(k + 1) }), U.el('span', { class: 'lbl', text: ph.short }));
        btn.addEventListener('click', () => tweenTo(k + 1, 900));
        ol.append(U.el('li', null, btn));
      });
    }
    Array.from(ol.querySelectorAll('button')).forEach((b, k) => {
      b.classList.toggle('is-done', k < phase);
      if (k === phase) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
  }

  // ---------- readout ----------
  function panLabel(p) {
    if (Math.abs(p) < 0.05) return 'center';
    return `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? 'left' : 'right'}`;
  }
  function firstLetter(name) {
    const m = name.match(/[A-Za-z0-9А-Яа-яЁё]/);
    return m ? m[0].toLowerCase() : name[0];
  }

  const ROLE_TEXT = {
    lead: 'melody: the longest name in its half-bar',
    arp: 'accompaniment: an arpeggio note over the current chord',
    group: 'grouped: the grid is very dense, so the longest name plays for the whole group',
    dir: 'folder: the arpeggio starts over',
  };

  function renderReadout(i, pos) {
    const s = state.score, m = state.model;
    const dl = $('readoutParams');
    const pathEl = $('readoutPath');
    dl.textContent = '';
    pathEl.textContent = '';
    const add = (k, v, cat) => {
      const dd = U.el('dd');
      if (cat) dd.append(U.el('span', { class: `swatch cat-${cat}` }));
      const parts = String(v).split(' → ');
      parts.forEach((p, j) => {
        if (j) dd.append(U.el('span', { class: 'arrow', text: ' → ' }));
        dd.append(document.createTextNode(p));
      });
      dl.append(U.el('div', null, U.el('dt', { text: k }), dd));
    };
    if (i < 0) {
      $('readoutLabel').textContent = 'Finale';
      pathEl.textContent = 'coda after the last line';
      const c = s.chords[s.chords.length - 1];
      add('Chord', `tonic → ${c.name} (I)`);
      add('Playing', 'the last melody note, bass and a fading chord');
      return;
    }
    const l = m.lines[i];
    const n = s.notes[i] || {};
    const sec = s.sections[n.sec != null ? n.sec : 0];
    $('readoutLabel').textContent = player.playing ? `Playing line ${U.fmtInt(i + 1)}` : pos > 0 ? `Paused on line ${U.fmtInt(i + 1)}` : 'First line';
    const dirs = l.path ? l.path.split('/') : [];
    const name = dirs.pop() || l.name;
    if (dirs.length) pathEl.append(document.createTextNode(`${dirs.join('/')}/`));
    pathEl.append(U.el('b', { text: l.isDir && l.depth > 0 ? `${name}/` : name }));

    const role = n.hit ? 'top-level folder: the arpeggio restarts with a chord hit' : ROLE_TEXT[n.role] || ROLE_TEXT.group;
    add('Role', role, n.role === 'lead' || n.role === 'arp' ? l.cat : l.isDir ? 'dir' : null);
    const lvl = s.levelAt(s.timeOf(i));
    const c = s.chordAt(s.timeOf(i));
    add('Section', `${sec.label} → ${c.name} (${c.roman}), ${Styles.LEVEL_NAMES[lvl]}`);
    if (n.role === 'lead') {
      add('Note', `folder motif, level ${l.depth} → ${s.noteName(n.midi)}`);
      add('Instrument', `section is mostly “${Model.CATS[sec.cat].label.toLowerCase()}” → ${Styles.instName(n.inst)}`);
      add('Volume', `${U.count(l.len, 'character')} → ${Math.round(n.vel * 100)}%`);
      add('Brightness', `letter density ${l.dens.toFixed(2)} → ${Math.round(s.densN[i] * 100)}%`);
      add('Length', `${state.source.noSizes ? 'size unknown' : U.fmtBytes(l.size)} → ${n.dur.toFixed(2)} s`);
    } else if (n.role === 'arp') {
      add('Note', `${s.noteName(n.midi)} · ${Styles.instName(n.inst)}`);
      add('Volume', `${U.count(l.len, 'character')} → ${Math.round(n.vel * 100)}%`);
      add('Brightness', `letter density ${l.dens.toFixed(2)} → ${Math.round(s.densN[i] * 100)}%`);
      add('Pan', `${l.sib + 1} of ${l.sibCount} → ${l.sibCount > 1 ? panLabel(((l.sib / (l.sibCount - 1)) * 2 - 1) * 0.35) : 'center'}`);
      if (n.run) add('Run', `file ${n.run} of a numbered run → climbs the chord`);
      if (n.orn) add('Ornament', `type “${Model.CATS[l.cat].label.toLowerCase()}” ≠ section → ${Styles.instName(n.orn.inst)} ${s.noteName(n.orn.midi)}`, l.cat);
    } else if (l.isDir) {
      add('Contains', `${U.count(l.files, 'file')}, ${U.count(l.dirs, 'folder')}`);
      if (!state.source.noSizes) add('Size', U.fmtBytes(l.bytes));
      add('Depth', l.depth === 0 ? 'root' : `level ${l.depth}`);
    } else {
      add('Volume', `${U.count(l.len, 'character')} → shapes the envelope`);
    }
  }

  // ---------- tooltip ----------
  function showTooltip(i, clientX, clientY) {
    const tip = $('tooltip');
    if (i < 0) { tip.hidden = true; return; }
    const l = state.model.lines[i], n = state.score.notes[i] || {};
    tip.textContent = '';
    tip.append(U.el('b', { text: l.depth === 0 ? l.name : l.isDir ? `${l.path}/` : l.path }));
    tip.append(U.el('br'));
    const s = state.score;
    const roleName = { lead: 'melody', arp: 'arpeggio', dir: 'folder', group: 'grouped' }[n.role] || '';
    const info = l.isDir
      ? `folder · ${U.count(l.files, 'file')} · ${s.chordAt(s.timeOf(i)).name}`
      : `${roleName}${n.midi != null ? ` · ${s.noteName(n.midi)} · ${Styles.instName(n.inst)}` : ''}${state.source.noSizes ? '' : ` · ${U.fmtBytes(l.size)}`}`;
    tip.append(U.el('span', { class: 'tt-dim', text: `${info} · ${U.fmtTime(state.score.timeOf(i))}` }));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const x = U.clamp(clientX + 14, 8, window.innerWidth - r.width - 8);
    const y = clientY + 18 + r.height > window.innerHeight - 8 ? clientY - r.height - 12 : clientY + 18;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  // ---------- loading ----------
  // Messages appear as a toast: notes fade after a while, errors stay a little longer.
  let toastTimer = 0;
  function setStatus(text, isError) {
    const toast = $('toast');
    clearTimeout(toastTimer);
    $('status').textContent = text || '';
    toast.classList.toggle('is-error', !!isError);
    toast.classList.toggle('is-on', !!text);
    if (text) toastTimer = setTimeout(() => toast.classList.remove('is-on'), isError ? 12000 : 6000);
  }
  function showLoader(on, text) {
    $('loader').hidden = !on;
    if (text) $('loaderText').textContent = text;
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function describeError(e) {
    if (e.code === 'rate_limit') {
      const t = e.resetAt ? new Date(e.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `GitHub rate limit reached: without a token it’s 60 requests an hour${t ? `, and the counter resets at ${t}` : ''}. Add a token or pick a built-in example.`;
    }
    if (e.code === 'network') {
      return 'Couldn’t reach GitHub. If the page runs in a sandbox (as an artifact, for example), outside requests are blocked there. Open index.html locally or on your own site, or pick an example, a folder or a file list.';
    }
    return e.message || 'Something went wrong.';
  }

  async function load(getSource, opts = {}) {
    const seq = ++state.loadSeq;
    showLoader(true, 'Loading the tree…');
    setStatus('');
    player.pause();
    state.blocked = false;
    try {
      const source = await getSource((msg) => { if (seq === state.loadSeq) $('loaderText').textContent = msg; });
      if (seq !== state.loadSeq) return;
      $('loaderText').textContent = 'Measuring letter density and composing…';
      await nextFrame();
      const model = Model.build(source);
      state.speed = 1; state.bpm = 0;
      const score = Composer.compose(model, { style: state.style });
      if (seq !== state.loadSeq) return;
      Object.assign(state, { model, score, source, demoId: opts.demoId || null, lastLine: -2, hover: -1 });
      player.setScore(score, 0);
      view.setData(model, score);
      panel.setModel(model);
      renderHeader(); renderFacts(); renderTraits(); renderSpeedOptions(); renderBpm(); renderLegend(); updateTotal(); markDemoChip();
      setStatus(source.note || '');
      updateDeepLink(source);
      if (source.kind === 'github' || source.kind === 'jsdelivr') refreshQuota();
      state.autoplay = !!opts.autoplay;
      state.p = 0;
      playMorph(0);
    } catch (e) {
      if (seq !== state.loadSeq || e.name === 'AbortError') return;
      if (!(e instanceof SourceError)) console.error(e);
      setStatus(describeError(e), true);
      if (e.code === 'network' || e.code === 'rate_limit') refreshQuota();
    } finally {
      if (seq === state.loadSeq) showLoader(false);
    }
  }

  const findDemo = (spec) => spec && DEMOS.find((d) => d.repo.toLowerCase() === `${spec.owner}/${spec.repo}`.toLowerCase());

  function loadDemo(demo, opts) {
    return load(async () => Sources.fromDemo(demo), { ...opts, demoId: demo.repo });
  }

  function loadGitHub(spec, opts) {
    $('repoInput').value = `github.com/${spec.owner}/${spec.repo}${spec.refParts.length ? `/tree/${spec.refParts.join('/')}` : ''}`;
    const demo = !spec.refParts.length && findDemo(spec);
    return load(async (onStatus) => {
      try {
        return await Sources.fromGitHub(spec, { onStatus, mirror: !demo });
      } catch (e) {
        if (demo && (e.code === 'network' || e.code === 'rate_limit')) {
          const src = Sources.fromDemo(demo);
          src.note = 'GitHub is unavailable right now, so you’re hearing a saved snapshot of this tree.';
          return src;
        }
        throw e;
      }
    }, opts);
  }

  async function refreshQuota() {
    const q = await Sources.rateLimit();
    const el = $('quota');
    el.classList.toggle('is-off', !q.ok);
    const show = (text, title) => { el.textContent = text; el.title = title; };
    if (q.bad) show('Token rejected', 'GitHub rejected the saved token. Update or remove it.');
    else if (!q.ok) show('GitHub offline', 'GitHub isn’t reachable from here (sandbox or no network). Examples, your own folder and file lists still work.');
    else if (q.remaining != null) {
      const at = new Date(q.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      show(`API ${q.remaining}/${q.limit}`, `GitHub API: ${q.remaining} of ${q.limit} requests left${q.remaining < q.limit ? `, resets at ${at}` : ''}. One repo uses two.`);
    } else show('', '');
  }

  function markDemoChip() {
    for (const b of $('demoChips').querySelectorAll('.chip')) {
      b.setAttribute('aria-current', state.demoId === b.dataset.repo ? 'true' : 'false');
    }
  }

  function updateDeepLink(src) {
    if (!src.repo) return;
    try { history.replaceState(null, '', `#${src.repo.owner}~${src.repo.repo}`); } catch (e) { /* sandboxed */ }
  }
  function readDeepLink() {
    try {
      const q = new URLSearchParams(location.search).get('repo');
      if (q) return Sources.parseRepo(q);
      const h = decodeURIComponent(location.hash.replace(/^#/, '')).replace(/^repo=/, '');
      if (h) return Sources.parseRepo(h);
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---------- re-composition ----------
  function recompose() {
    const old = state.score, pos = player.position();
    const score = Composer.compose(state.model, { style: state.style, speed: state.speed, bpm: state.bpm || 0 });
    let np;
    if (pos < old.linesEnd) np = (pos / old.lineDur) * score.lineDur;
    else np = score.codaStart + (pos - old.codaStart) * (score.beat / old.beat);
    state.score = score;
    player.setScore(score, np);
    view.setScore(score);
    renderFacts(); renderTraits(); renderSpeedOptions(); renderBpm(); renderLegend(); renderStyles(); updateTotal();
    state.lastLine = -2;
    state.dirty = true;
  }

  function renderStyles() {
    for (const b of $('styleSeg').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', b.dataset.style === state.style ? 'true' : 'false');
      b.title = Styles.get(b.dataset.style).hint;
    }
    $('styleHint').textContent = Styles.get(state.style).hint;
  }

  function buildStyles() {
    const box = $('styleSeg');
    for (const key of Styles.KEYS) {
      const b = U.el('button', { type: 'button', class: 'seg', 'data-style': key, 'aria-pressed': 'false', text: Styles.get(key).name });
      b.addEventListener('click', () => {
        Engine.unlock();
        if (state.style === key) return;
        state.style = key;
        U.storage.set(STYLE_KEY, key);
        state.bpm = 0;
        if (state.model) recompose(); else renderStyles();
      });
      box.append(b);
    }
    renderStyles();
  }

  // ---------- exports ----------
  function fileBase() {
    const src = state.source;
    const base = src.repo ? `${src.repo.owner}-${src.repo.repo}` : src.name;
    return `${base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'tree'}-filophone`;
  }
  async function exportWav() {
    const btn = $('wavBtn');
    if (btn.disabled || !state.score) return;
    btn.disabled = true;
    const label = btn.innerHTML;
    try {
      setStatus('Rendering the audio to a file…');
      const buf = await Engine.renderOffline(state.score, { layers: player.layers, fx: player.fx }, (f) => { btn.textContent = `Rendering ${Math.round(f * 100)}%`; });
      const how = await Exporters.save(`${fileBase()}.wav`, Exporters.wav(buf));
      setStatus(how === 'zip' ? 'Done. Only ZIP downloads are allowed here, so the WAV is inside the archive.' : 'WAV saved.');
    } catch (e) {
      setStatus(saveError(e, 'WAV'), true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
  async function exportMidi() {
    if (!state.score) return;
    try {
      const how = await Exporters.save(`${fileBase()}.mid`, Exporters.midi(state.score, state.source.title));
      setStatus(how === 'zip' ? 'Done. The MIDI file is inside a ZIP archive.' : 'MIDI saved, with one track per instrument.');
    } catch (e) {
      setStatus(saveError(e, 'MIDI'), true);
    }
  }
  function saveError(e, what) {
    if (e && e.code === 'declined') return `Saving the ${what} was cancelled.`;
    if (e && (e.code === 'unavailable' || e.code === 'not_granted')) return `Files can’t be saved here. Open the page on its own to download the ${what}.`;
    return `Couldn’t save the ${what}: ${(e && e.message) || e}`;
  }
  async function share() {
    const src = state.source;
    if (!src || !src.repo) { setStatus('Only a GitHub repo can be shared as a link.'); return; }
    let url = `https://github.com/${src.repo.owner}/${src.repo.repo}`;
    try {
      const u = new URL(location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') { u.search = ''; u.hash = `${src.repo.owner}~${src.repo.repo}`; url = u.toString(); }
    } catch (e) { /* keep the GitHub link */ }
    try {
      await navigator.clipboard.writeText(url);
      setStatus(`Link copied: ${url}`);
    } catch (e) {
      setStatus(`Link: ${url}`);
    }
  }

  // ---------- interaction ----------
  function seekLine(i) {
    if (state.score) seekTo(state.score.timeOf(i) + 1e-4);
  }
  function seekTo(t) {
    if (!state.score) return;
    player.seek(t);
    state.lastLine = -2;
    state.follow = true;
    state.dirty = true;
  }

  function lineAtStage(ev) {
    const r = $('stage').getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (!view.g) return -1;
    if (state.p >= 4.5) return x >= view.g.L && x <= view.g.L + view.g.iw ? view.xToLine(x) : -1;
    if (state.p <= 2.5) {
      const i = view.yToLine(y, state.p);
      return y >= view.g.T && i < state.model.lines.length ? i : -1;
    }
    return -1;
  }
  function lineAtRoll(ev) {
    const r = $('roll').getBoundingClientRect();
    const x = ev.clientX - r.left;
    if (!view.g || state.p < 4.2) return -1;
    return x >= view.g.L && x <= view.g.L + view.g.iw ? view.xToLine(x) : -1;
  }

  function bindScrub(el, pick) {
    let dragging = false, lastSeek = 0;
    el.addEventListener('pointerdown', (ev) => {
      if (!state.score) return;
      const i = pick(ev);
      if (i < 0) return;
      dragging = true;
      el.setPointerCapture(ev.pointerId);
      seekLine(i);
      lastSeek = performance.now();
    });
    el.addEventListener('pointermove', (ev) => {
      if (!state.score) return;
      const i = pick(ev);
      if (dragging) {
        if (i >= 0 && performance.now() - lastSeek > 90) { seekLine(i); lastSeek = performance.now(); }
        return;
      }
      if (ev.pointerType === 'touch') return;
      if (i !== state.hover) { state.hover = i; state.dirty = true; }
      showTooltip(i, ev.clientX, ev.clientY);
    });
    const end = (ev) => {
      if (dragging) {
        dragging = false;
        const i = pick(ev);
        if (i >= 0) seekLine(i);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { dragging = false; });
    el.addEventListener('pointerleave', () => {
      if (state.hover !== -1) { state.hover = -1; state.dirty = true; }
      $('tooltip').hidden = true;
    });
  }

  function onPlayState() {
    const b = $('playBtn');
    b.classList.toggle('is-playing', player.playing);
    b.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    if (player.playing) { b.classList.remove('is-ready'); state.blocked = false; }
    state.dirty = true;
  }

  function wire() {
    player.on('state', onPlayState);
    player.on('seek', () => { state.dirty = true; state.lastLine = -2; });
    player.on('end', () => { state.dirty = true; });
    player.on('prep', (f) => {
      if (player.playing && !player.session && f < 1) showLoader(true, `Preparing instruments… ${Math.round(f * 100)}%`);
      else if (f >= 1 && $('loaderText').textContent.startsWith('Preparing')) showLoader(false);
    });

    $('repoForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      Engine.unlock();
      const spec = Sources.parseRepo($('repoInput').value);
      if (!spec) { setStatus('Couldn’t read that link. Use github.com/owner/repo or just owner/repo.', true); $('repoInput').focus(); return; }
      loadGitHub(spec, { autoplay: true });
    });

    $('playBtn').addEventListener('click', () => {
      Engine.unlock();
      if (!state.score) return;
      if (state.anim && !player.playing) { state.anim = null; state.p = 5; state.autoplay = false; state.dirty = true; }
      player.toggle();
    });
    $('stagePlay').addEventListener('click', () => $('playBtn').click());
    $('restartBtn').addEventListener('click', () => { player.seek(0); state.dirty = true; });

    const sk = $('seekRange');
    let lastSeek = 0;
    sk.addEventListener('input', () => {
      ui.seekDragging = true;
      fillRange(sk);
      if (performance.now() - lastSeek > 90) { seekTo(Number(sk.value)); lastSeek = performance.now(); }
    });
    sk.addEventListener('change', () => { seekTo(Number(sk.value)); ui.seekDragging = false; });
    $('replayBtn').addEventListener('click', () => { state.autoplay = false; playMorph(0); });

    const toggleBtn = (btn, on) => { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); };
    $('loopBtn').addEventListener('click', (ev) => { player.loop = !player.loop; toggleBtn(ev.currentTarget, player.loop); });
    for (const b of document.querySelectorAll('[data-layer]')) {
      b.addEventListener('click', () => {
        const k = b.dataset.layer;
        if (k === 'fx') { player.setFx(!player.fx); toggleBtn(b, player.fx); return; }
        const on = !player.layers[k];
        player.setLayer(k, on);
        toggleBtn(b, on);
      });
    }

    $('speedSel').addEventListener('change', (ev) => { state.speed = Number(ev.target.value); recompose(); });
    $('bpmRange').addEventListener('input', (ev) => { $('bpmOut').textContent = ev.target.value; fillRange(ev.target); });
    $('bpmRange').addEventListener('change', (ev) => { state.bpm = Number(ev.target.value); recompose(); });
    $('bpmAuto').addEventListener('click', () => { state.bpm = 0; recompose(); });
    $('volRange').addEventListener('input', (ev) => { player.setVolume(Number(ev.target.value) / 100); fillRange(ev.target); });
    fillRange($('volRange'));
    $('toastClose').addEventListener('click', () => { clearTimeout(toastTimer); $('toast').classList.remove('is-on'); });

    const mr = $('morphRange');
    mr.addEventListener('pointerdown', () => { ui.morphDragging = true; });
    mr.addEventListener('input', () => { state.anim = null; state.autoplay = false; state.p = Number(mr.value); state.dirty = true; fillRange(mr); });
    const endDrag = () => { ui.morphDragging = false; state.dirty = true; };
    mr.addEventListener('change', endDrag);
    mr.addEventListener('pointerup', endDrag);

    $('wavBtn').addEventListener('click', exportWav);
    $('midiBtn').addEventListener('click', exportMidi);
    $('shareBtn').addEventListener('click', share);

    // alternative sources
    $('folderBtn').addEventListener('click', () => Engine.unlock());
    $('folderInput').addEventListener('change', (ev) => {
      const files = ev.target.files;
      if (files && files.length) load(async () => Sources.fromFileList(files), { autoplay: true });
      ev.target.value = '';
    });
    const drawer = (btnId, panelId) => {
      $(btnId).addEventListener('click', () => {
        const p = $(panelId);
        p.hidden = !p.hidden;
        $(btnId).setAttribute('aria-expanded', p.hidden ? 'false' : 'true');
        if (!p.hidden) { const f = p.querySelector('textarea, input'); if (f) f.focus(); }
      });
    };
    drawer('pasteToggle', 'pastePanel');
    drawer('tokenToggle', 'tokenPanel');
    $('pasteGo').addEventListener('click', () => {
      Engine.unlock();
      const text = $('pasteInput').value;
      load(async () => Sources.fromText(text), { autoplay: true });
    });
    $('tokenInput').value = Sources.getToken() ? '••••••••' : '';
    $('tokenPanel').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = $('tokenInput').value.trim();
      if (!v || /^•+$/.test(v)) { setStatus('Paste a token into the field.'); return; }
      Sources.setToken(v);
      $('tokenInput').value = '••••••••';
      setStatus('Token saved in this browser.');
      refreshQuota();
    });
    $('tokenClear').addEventListener('click', () => { Sources.setToken(''); $('tokenInput').value = ''; setStatus('Token removed.'); refreshQuota(); });

    // drag and drop a folder anywhere
    let dragDepth = 0;
    const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (ev) => { if (!hasFiles(ev)) return; dragDepth++; $('dropOverlay').hidden = false; });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
    window.addEventListener('dragover', (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
    window.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth = 0;
      $('dropOverlay').hidden = true;
      Engine.unlock();
      const dt = ev.dataTransfer;
      load(async () => Sources.fromDataTransfer(dt), { autoplay: true });
    });

    bindScrub($('stage'), lineAtStage);
    bindScrub($('roll'), lineAtRoll);

    document.addEventListener('keydown', (ev) => {
      const t = ev.target;
      const tag = t && t.tagName;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (ev.key === ' ' || ev.key === 'k') {
        if (tag === 'BUTTON' || tag === 'A' || tag === 'LABEL') return;
        ev.preventDefault();
        $('playBtn').click();
      } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        if (!state.score) return;
        ev.preventDefault();
        player.seek(player.position() + (ev.key === 'ArrowRight' ? 5 : -5));
        state.dirty = true;
      } else if (ev.key === 'Home') {
        player.seek(0); state.dirty = true;
      }
    });

    const ro = new ResizeObserver(() => { view.layout(); state.dirty = true; });
    ro.observe($('stageWrap'));
    const themeChanged = () => { view.readTheme(); state.dirty = true; };
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', themeChanged);
    }
    new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    document.addEventListener('visibilitychange', () => { state.dirty = true; });
  }

  function buildChips() {
    const box = $('demoChips');
    for (const d of DEMOS) {
      const files = d.data.split('\n').length;
      const [owner, name] = d.repo.split('/');
      const b = U.el('button', { class: 'chip', type: 'button', 'data-repo': d.repo, 'aria-current': 'false', title: `${U.count(files, 'file')} · built-in snapshot, plays without any GitHub requests` },
        U.el('span', { class: 'own', text: `${owner}/` }),
        U.el('span', { text: name }));
      b.addEventListener('click', () => {
        Engine.unlock();
        $('repoInput').value = `github.com/${d.repo}`;
        loadDemo(d, { autoplay: true });
      });
      box.append(b);
    }
  }

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const wait = Promise.all([
      document.fonts.load(`32px ${FONT_MONO}`, 'aA'),
      document.fonts.load(`700 16px ${FONT_MONO}`, 'aA'),
      document.fonts.load(`16px ${FONT_MONO}`, '│├└─'),
    ]).catch(() => {});
    return Promise.race([wait, new Promise((r) => setTimeout(r, 2500))]);
  }

  async function init() {
    view = new Stage.View($('stage'), $('roll'));
    panel = new TreePanel($('treeScroll'), $('treeInner'), (i) => seekLine(i));
    buildChips();
    buildStyles();
    renderSteps(0);
    renderLegend();
    wire();
    Exporters.initHost();
    refreshQuota();
    requestAnimationFrame(loop);
    await fontsReady();
    Ink.init();
    // Links and the default repo load live; embedded snapshots step in if GitHub is unreachable.
    // Autoplay only goes ahead if the browser allows sound before a click (see autoplay()).
    loadGitHub(readDeepLink() || Sources.parseRepo(DEFAULT_REPO), { autoplay: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { state, player };
})();
