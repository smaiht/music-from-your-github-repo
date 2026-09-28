'use strict';
// Turns a flat list of paths into the fully expanded tree, one line per node,
// and measures every line: name length, ink density, entropy, type, size.

const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Ink coverage of a glyph = share of its monospace cell that is painted.
// "How filled is this line compared to the most filled line possible."
const Ink = (() => {
  const PX = 32;
  const cache = new Map();
  let ctx = null, adv = PX * 0.6, maxRaw = 1;

  function raw(ch) {
    if (cache.has(ch)) return cache.get(ch);
    let v = 0;
    if (ch.trim()) {
      const w = Math.max(adv, ctx.measureText(ch).width);
      const W = Math.ceil(w) + 8, H = Math.ceil(PX * 1.6);
      ctx.clearRect(0, 0, W, H);
      ctx.fillText(ch, 4, Math.round(PX * 1.15));
      const data = ctx.getImageData(0, 0, W, H).data;
      let sum = 0;
      for (let k = 3; k < data.length; k += 4) sum += data[k];
      v = sum / 255 / (w * PX * 1.25);
    }
    cache.set(ch, v);
    return v;
  }

  function init() {
    cache.clear();
    const c = document.createElement('canvas');
    c.width = PX * 3; c.height = Math.ceil(PX * 1.6);
    ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.font = `${PX}px ${FONT_MONO}`;
    ctx.fillStyle = '#000';
    adv = ctx.measureText('M').width || PX * 0.6;
    maxRaw = 1e-6;
    for (let code = 33; code < 127; code++) maxRaw = Math.max(maxRaw, raw(String.fromCharCode(code)));
  }

  // 0..1 relative to the densest printable ASCII glyph
  function cov(ch) {
    if (!ctx) init();
    return Math.min(1, raw(ch) / maxRaw);
  }

  return { init, cov };
})();

const Model = (() => {
  // Instrument families. Order = palette slot order (see css tokens --cat-*).
  const CATS = {
    dir: { label: 'Folder', inst: 'Harp and a chord change' },
    code: { label: 'Code', inst: 'Plucked synth' },
    docs: { label: 'Docs', inst: 'Electric piano' },
    data: { label: 'Data and configs', inst: 'Marimba' },
    web: { label: 'Markup and styles', inst: 'Glass bell' },
    test: { label: 'Tests', inst: 'Music box' },
    media: { label: 'Media and binaries', inst: 'Shimmering noise' },
    tool: { label: 'Build and tooling', inst: '8-bit square' },
  };
  const CAT_ORDER = ['code', 'docs', 'data', 'web', 'test', 'media', 'tool'];

  const EXT = {};
  const addExt = (cat, list) => list.split(' ').forEach((e) => { EXT[e] = cat; });
  addExt('code', 'py pyi pyx ipynb js mjs cjs jsx ts tsx mts cts rs go c h cc cpp cxx hpp hh hxx inl java kt kts scala sc swift m mm rb php cs fs fsx vb lua dart ex exs erl hrl hs lhs ml mli clj cljs cljc edn jl r pl pm zig nim v sol asm s cu cuh glsl hlsl wgsl metal elm purs rkt scm lisp el vim tcl groovy cr d pas f90 f95 f ada coffee res resi gleam odin mojo ino');
  addExt('docs', 'md mdx markdown rst txt adoc asciidoc org tex rtf doc docx pod man 1 texi');
  addExt('data', 'json jsonc json5 jsonl ndjson yml yaml toml xml ini cfg conf env lock csv tsv properties plist sql graphql gql proto prisma mod sum snap po pot map avsc thrift tf tfvars hcl');
  addExt('web', 'html htm xhtml css scss sass less styl pcss vue svelte astro ejs hbs handlebars pug jade twig liquid njk mustache erb haml slim jinja j2 tmpl');
  addExt('media', 'png jpg jpeg gif svg ico icns webp avif bmp tif tiff psd ai sketch fig mp3 wav ogg flac m4a aac mid midi mp4 mov webm avi mkv woff woff2 ttf otf eot pdf zip gz tgz bz2 xz 7z rar tar jar war bin exe dll so dylib a o obj class wasm pt pth ckpt onnx pkl pickle npy npz h5 hdf5 safetensors parquet feather arrow db sqlite dat blend fbx glb gltf stl dds ktx');
  addExt('tool', 'sh bash zsh fish nu ps1 psm1 bat cmd mk cmake gradle nix dockerfile containerfile bazel bzl just ninja meson');
  const TOOL_NAMES = new Set(['makefile', 'dockerfile', 'containerfile', 'jenkinsfile', 'procfile', 'vagrantfile', 'gemfile', 'rakefile', 'brewfile', 'justfile', 'taskfile', 'cmakelists.txt', 'meson.build', 'build', 'build.bazel', 'workspace', 'podfile', 'fastfile', 'gruntfile.js', 'gulpfile.js', 'caddyfile', 'tiltfile', 'earthfile', 'pipfile', 'manifest.in', 'setup.cfg', 'tox.ini', 'noxfile.py']);
  const DOC_NAMES = /^(license|licence|copying|authors|contributors|changelog|changes|history|notice|readme|codeowners|security|patents|maintainers|code_of_conduct|contributing|funding|citation)(\.|$)/i;
  const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|e2e|testdata|test-data|testing|fixtures?|__snapshots__|__mocks__)(\/|$)/i;
  const TEST_FILE = /(^test_|_test\.|\.test\.|\.spec\.|_spec\.|^spec_|^tests?\.[a-z0-9]+$)/i;

  const LANG_OF = {};
  const addLang = (lang, list) => list.split(' ').forEach((e) => { LANG_OF[e] = lang; });
  addLang('Python', 'py pyi pyx ipynb'); addLang('JavaScript', 'js mjs cjs jsx'); addLang('TypeScript', 'ts tsx mts cts');
  addLang('Rust', 'rs'); addLang('Go', 'go'); addLang('C', 'c h'); addLang('C++', 'cc cpp cxx hpp hh hxx inl cu cuh');
  addLang('Java', 'java'); addLang('Kotlin', 'kt kts'); addLang('Scala', 'scala sc'); addLang('Swift', 'swift');
  addLang('Objective-C', 'm mm'); addLang('Ruby', 'rb erb'); addLang('PHP', 'php'); addLang('C#', 'cs'); addLang('F#', 'fs fsx');
  addLang('Lua', 'lua'); addLang('Dart', 'dart'); addLang('Elixir', 'ex exs'); addLang('Erlang', 'erl hrl'); addLang('Haskell', 'hs lhs');
  addLang('OCaml', 'ml mli'); addLang('Clojure', 'clj cljs cljc'); addLang('Julia', 'jl'); addLang('R', 'r'); addLang('Perl', 'pl pm');
  addLang('Zig', 'zig'); addLang('Nim', 'nim'); addLang('Solidity', 'sol'); addLang('Assembly', 'asm s');
  addLang('Shell', 'sh bash zsh fish'); addLang('Vue', 'vue'); addLang('Svelte', 'svelte'); addLang('HTML', 'html htm');
  addLang('CSS', 'css scss sass less styl'); addLang('Elm', 'elm'); addLang('Gleam', 'gleam'); addLang('Groovy', 'groovy gradle');

  function extOf(name) {
    const lower = name.toLowerCase();
    if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
    const dot = lower.lastIndexOf('.');
    if (dot <= 0 || dot === lower.length - 1) return '';
    return lower.slice(dot + 1);
  }

  function categorize(name, path, ext) {
    const lower = name.toLowerCase();
    if (TEST_DIR.test(path) || TEST_FILE.test(name)) {
      // Test data files (images, json fixtures) still count as tests: they belong to the test suite.
      return 'test';
    }
    if (TOOL_NAMES.has(lower)) return 'tool';
    if (DOC_NAMES.test(name)) return 'docs';
    if (EXT[ext]) return EXT[ext];
    if (name.startsWith('.')) return 'tool';
    if (!ext) return 'tool';
    return 'data';
  }

  // Natural, case-insensitive, deterministic order (file10 after file9).
  function natCmp(a, b) {
    const ax = a.toLowerCase(), bx = b.toLowerCase();
    const re = /(\d+|\D+)/g;
    const pa = ax.match(re) || [], pb = bx.match(re) || [];
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const x = pa[i], y = pb[i];
      if (x === y) continue;
      const nx = /^\d/.test(x), ny = /^\d/.test(y);
      if (nx && ny) {
        const d = Number(x) - Number(y);
        if (d) return d;
        if (x.length !== y.length) return x.length - y.length;
      }
      return x < y ? -1 : 1;
    }
    if (pa.length !== pb.length) return pa.length - pb.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function entropy(chars) {
    if (chars.length < 2) return 0;
    const counts = new Map();
    for (const c of chars) counts.set(c, (counts.get(c) || 0) + 1);
    let h = 0;
    for (const n of counts.values()) { const p = n / chars.length; h -= p * Math.log2(p); }
    return h / Math.log2(Math.min(chars.length, 26));
  }

  // First letter → position in the alphabet (0..1). Files are sorted by name,
  // so inside one folder this value rises and the melody climbs with it.
  function letterRank(name) {
    const s = name.toLowerCase().replace(/^[^a-z0-9а-яё]+/, '');
    const c0 = s.charCodeAt(0), c1 = s.charCodeAt(1);
    const sub = (c) => (c >= 97 && c <= 122 ? (c - 97) / 26 : c >= 48 && c <= 57 ? (c - 48) / 40 : 0.5);
    if (c0 >= 97 && c0 <= 122) return U.clamp((c0 - 97 + sub(c1)) / 26, 0, 1);
    if (c0 >= 48 && c0 <= 57) return U.clamp((c0 - 48) / 40, 0, 0.25);
    if (c0 >= 1072 && c0 <= 1103) return U.clamp((c0 - 1072) / 32, 0, 1);
    return isNaN(c0) ? 0 : (c0 % 26) / 26;
  }

  function leadChar(name) {
    const m = name.toLowerCase().match(/[a-z0-9а-яё]/);
    return m ? m[0] : name.slice(0, 1);
  }

  function build(source) {
    const root = { name: source.name, isDir: true, kids: new Map(), size: 0, type: 'tree' };
    for (const e of source.entries) {
      const parts = e.path.split('/').filter(Boolean);
      let node = root;
      for (let k = 0; k < parts.length; k++) {
        const last = k === parts.length - 1;
        const isDir = !last;
        let child = node.kids.get(parts[k]);
        if (!child) {
          child = { name: parts[k], isDir, kids: isDir ? new Map() : null, size: 0, type: isDir ? 'tree' : e.type };
          node.kids.set(parts[k], child);
        } else if (isDir && !child.isDir) {
          child.isDir = true; child.kids = new Map(); child.type = 'tree';
        }
        if (last && !child.isDir) child.size = e.size || 0;
        node = child;
      }
    }

    const byOrder = (a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : natCmp(a.name, b.name));
    const lines = [];
    const stack = [{ node: root, depth: 0, parent: -1, guides: [], last: true, sib: 0, sibCount: 1, path: '' }];
    while (stack.length) {
      const f = stack.pop();
      const n = f.node;
      const i = lines.length;
      const chars = Array.from(n.name);
      const ext = n.isDir ? '' : extOf(n.name);
      const path = f.depth === 0 ? '' : f.path;
      lines.push({
        i, name: n.name, chars, path, depth: f.depth, isDir: n.isDir, submodule: n.type === 'commit',
        size: n.size, ext, cat: n.isDir ? 'dir' : categorize(n.name, path, ext),
        parent: f.parent, sib: f.sib, sibCount: f.sibCount, last: f.last, guides: f.guides,
        len: chars.length, dens: 0, ent: entropy(chars), rank: letterRank(n.name), lead: leadChar(n.name),
        end: i + 1, files: 0, dirs: 0, bytes: 0,
      });
      if (n.isDir) {
        const kids = Array.from(n.kids.values()).sort(byOrder);
        const guides = f.depth === 0 ? [] : f.guides.concat(!f.last);
        for (let j = kids.length - 1; j >= 0; j--) {
          stack.push({
            node: kids[j], depth: f.depth + 1, parent: i, guides, last: j === kids.length - 1,
            sib: j, sibCount: kids.length, path: path ? `${path}/${kids[j].name}` : kids[j].name,
          });
        }
      }
    }

    // Subtree aggregates (children always come after their parent).
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.isDir) l.bytes = l.size;
      if (l.parent >= 0) {
        const p = lines[l.parent];
        p.bytes += l.bytes;
        if (l.isDir) { p.dirs += 1 + l.dirs; p.files += l.files; } else p.files += 1;
        p.end = Math.max(p.end, l.end);
      }
    }

    measureInk(lines);
    return { source, lines, stats: stats(lines, source) };
  }

  function measureInk(lines) {
    for (const l of lines) {
      let s = 0;
      for (const ch of l.chars) s += Ink.cov(ch);
      l.dens = l.chars.length ? s / l.chars.length : 0;
    }
  }

  function stats(lines, source) {
    const files = lines.filter((l) => !l.isDir);
    const langBytes = new Map();
    const catCount = {};
    let maxDepth = 0, bytes = 0;
    for (const l of lines) {
      catCount[l.cat] = (catCount[l.cat] || 0) + 1;
      maxDepth = Math.max(maxDepth, l.depth);
      if (l.isDir) continue;
      bytes += l.size;
      const lang = LANG_OF[l.ext];
      if (lang && l.cat !== 'media') {
        // Size when we know it, otherwise one unit per file.
        langBytes.set(lang, (langBytes.get(lang) || 0) + (source.noSizes ? 1 : Math.max(1, l.size)));
      }
    }
    let lang = null, langShare = 0, total = 0;
    for (const v of langBytes.values()) total += v;
    for (const [k, v] of langBytes) if (!lang || v > langBytes.get(lang)) lang = k;
    if (lang) langShare = langBytes.get(lang) / total;
    const lens = lines.map((l) => l.len);
    const dens = lines.map((l) => l.dens);
    return {
      lines: lines.length, files: files.length, dirs: lines.length - files.length, maxDepth, bytes, catCount,
      lang, langShare,
      medianLen: U.percentile(lens, 0.5),
      lenRef: Math.max(8, Math.ceil(U.percentile(lens, 0.98))),
      maxCols: lines.reduce((m, l) => Math.max(m, l.depth * 4 + l.len), 0),
      colsRef: Math.max(12, Math.ceil(U.percentile(lines.map((l) => l.depth * 4 + l.len), 0.99))),
      densLo: U.percentile(dens, 0.05), densHi: U.percentile(dens, 0.95),
      sizeRef: Math.max(1, U.percentile(files.map((l) => l.size), 0.95)),
    };
  }

  // `tree`-style prefix for a line: "│   ├── "
  function prefix(l) {
    if (l.depth === 0) return '';
    let s = '';
    for (const g of l.guides) s += g ? '│   ' : '    ';
    return s + (l.last ? '└── ' : '├── ');
  }

  return { build, prefix, CATS, CAT_ORDER, natCmp };
})();
