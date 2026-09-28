'use strict';
// Where file trees come from: the GitHub API, jsDelivr as a fallback when the
// GitHub rate limit runs out, embedded snapshots, a local folder, or pasted text.
// Every source resolves to the same shape:
//   { name, title, entries: [{ path, size, type: 'blob' | 'commit' }], note, meta }

class SourceError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const Sources = (() => {
  const API = 'https://api.github.com';
  const TOKEN_KEY = 'filofon.githubToken';
  // Folders that are never part of a project's own tree.
  const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea', '.next', '.nuxt', '.turbo', '.cache', 'Thumbs.db']);
  const MAX_LOCAL_FILES = 60000;

  function parseRepo(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    s = s.replace(/^git\+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    let m = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (m) return { owner: m[1], repo: m[2], refParts: [] };
    m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/(.+))?$/i);
    if (m) {
      const refParts = m[3] ? m[3].split('/').filter(Boolean).map(decodeURIComponent) : [];
      return { owner: m[1], repo: m[2], refParts };
    }
    m = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), refParts: [] };
    // "owner~repo" is the deep-link form used in #anchors.
    m = s.match(/^([A-Za-z0-9-]{1,39})~([A-Za-z0-9._-]{1,100})$/);
    if (m) return { owner: m[1], repo: m[2], refParts: [] };
    return null;
  }

  function getToken() { return U.storage.get(TOKEN_KEY) || ''; }
  function setToken(t) { U.storage.set(TOKEN_KEY, (t || '').trim()); }

  async function gh(path, token, signal) {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(API + path, { headers, signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new SourceError('network', 'Couldn’t reach GitHub.');
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || 0;
    if (res.ok) return { data: await res.json(), remaining: remaining == null ? null : Number(remaining) };
    let body = {};
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    const msg = body.message || '';
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || /rate limit/i.test(msg))) {
      throw new SourceError('rate_limit', 'GitHub rate limit reached.', { resetAt: reset });
    }
    if (res.status === 401) throw new SourceError('bad_token', 'GitHub rejected the token. Check it or remove it.');
    if (res.status === 404) throw new SourceError('not_found', 'Repository not found. If it’s private, add a GitHub token.');
    if (res.status === 409) throw new SourceError('empty', 'The repository is empty: it has no commits yet.');
    if (res.status === 422 || res.status === 400) throw new SourceError('not_found', 'GitHub couldn’t find that branch or path.');
    throw new SourceError('http', `GitHub returned error ${res.status}${msg ? `: ${msg}` : ''}.`);
  }

  async function viaJsDelivr(owner, repo, ref, signal) {
    const refs = ref ? [ref] : ['main', 'master'];
    for (const r of refs) {
      let res;
      try {
        res = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${encodeURIComponent(r)}?structure=flat`, { signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        continue;
      }
      if (!res.ok) continue;
      const d = await res.json();
      if (!d.files || !d.files.length) continue;
      return {
        ref: r,
        entries: d.files.map((f) => ({ path: f.name.replace(/^\/+/, ''), size: f.size || 0, type: 'blob' })),
      };
    }
    return null;
  }

  async function fromGitHub(spec, { signal, onStatus } = {}) {
    const { owner, repo, refParts } = spec;
    const token = getToken();
    const full = `${owner}/${repo}`;
    onStatus && onStatus(`Fetching the ${full} tree from GitHub…`);

    const infoPromise = gh(`/repos/${owner}/${repo}`, token, signal).then((r) => r.data, (e) => e);

    // A branch name may itself contain slashes, so try the longest-plausible splits.
    const attempts = [];
    if (refParts.length) {
      for (let k = 1; k <= Math.min(refParts.length, 4); k++) {
        attempts.push({ ref: refParts.slice(0, k).join('/'), sub: refParts.slice(k).join('/') });
      }
    } else {
      attempts.push({ ref: 'HEAD', sub: '' });
    }

    let tree = null, used = null, lastErr = null;
    for (const a of attempts) {
      try {
        const refPath = a.ref.split('/').map(encodeURIComponent).join('/');
        tree = (await gh(`/repos/${owner}/${repo}/git/trees/${refPath}?recursive=1`, token, signal)).data;
        used = a;
        break;
      } catch (e) {
        lastErr = e;
        if (e.code !== 'not_found') break;
      }
    }

    let entries, note = '', truncated = false, via = 'github';
    if (tree) {
      entries = tree.tree
        .filter((t) => t.type === 'blob' || t.type === 'commit')
        .map((t) => ({ path: t.path, size: t.size || 0, type: t.type }));
      truncated = !!tree.truncated;
    } else if (lastErr && lastErr.code === 'rate_limit') {
      onStatus && onStatus('GitHub rate limit reached, trying the jsDelivr mirror…');
      const alt = await viaJsDelivr(owner, repo, refParts[0], signal);
      if (!alt) throw lastErr;
      entries = alt.entries;
      used = { ref: alt.ref, sub: refParts.slice(1).join('/') };
      via = 'jsdelivr';
      note = 'GitHub API rate limit reached, so the tree came from the jsDelivr mirror.';
    } else {
      throw lastErr || new SourceError('http', 'GitHub didn’t return a file tree.');
    }

    let info = await infoPromise;
    if (info instanceof Error) {
      if (info.code === 'not_found' && !entries.length) throw info;
      info = null;
    }

    let rootName = info ? info.full_name : full;
    if (used.sub) {
      const prefix = used.sub.replace(/\/+$/, '') + '/';
      entries = entries.filter((e) => e.path.startsWith(prefix)).map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
      if (!entries.length) throw new SourceError('not_found', `The repository has no “${used.sub}” folder.`);
      rootName = `${rootName}/${used.sub}`;
    }
    if (!entries.length) throw new SourceError('empty', 'The repository has no files.');
    if (truncated) note = 'GitHub returned a partial tree because the repository is too big. You’re hearing the part that arrived.';

    return {
      kind: via,
      name: rootName,
      title: rootName,
      repo: { owner, repo: info ? info.name : repo, full: info ? info.full_name : full },
      ref: used.ref === 'HEAD' ? (info && info.default_branch) || '' : used.ref,
      entries,
      truncated,
      note,
      meta: info ? { description: info.description || '', stars: info.stargazers_count, language: info.language } : null,
    };
  }

  function fromDemo(demo) {
    const entries = [];
    let prev = '';
    for (const line of demo.data.split('\n')) {
      const a = line.indexOf('|');
      const b = line.lastIndexOf('|');
      const shared = Number(line.slice(0, a));
      const path = prev.slice(0, shared) + line.slice(a + 1, b);
      const sizeStr = line.slice(b + 1);
      entries.push(sizeStr === '@' ? { path, size: 0, type: 'commit' } : { path, size: Number(sizeStr) || 0, type: 'blob' });
      prev = path;
    }
    const [owner, repo] = demo.repo.split('/');
    return {
      kind: 'demo',
      name: demo.repo,
      title: demo.repo,
      repo: { owner, repo, full: demo.repo },
      entries,
      truncated: demo.truncated,
      note: '',
      meta: null,
    };
  }

  // ---- .gitignore (root file only; covers the common patterns) ----
  function compileGitignore(text) {
    const rules = [];
    for (let raw of String(text).split(/\r?\n/)) {
      let line = raw.replace(/\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      let neg = false;
      if (line.startsWith('!')) { neg = true; line = line.slice(1); }
      if (line.endsWith('/')) line = line.slice(0, -1);
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      if (!line) continue;
      let re = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '*') {
          if (line[i + 1] === '*') {
            if (line[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
          } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if (c === '[') {
          const j = line.indexOf(']', i + 1);
          if (j > i) { re += line.slice(i, j + 1).replace(/^\[!/, '[^'); i = j; } else re += '\\[';
        } else if (c === '\\' && i + 1 < line.length) { re += line[i + 1].replace(/[.+^${}()|[\]\\*?]/g, '\\$&'); i += 1; }
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      try {
        rules.push({ neg, re: new RegExp((anchored ? '^' : '(?:^|/)') + re + '(?:/.*)?$') });
      } catch (e) { /* skip patterns we cannot translate */ }
    }
    return (path) => {
      let ignored = false;
      for (const r of rules) if (r.re.test(path)) ignored = !r.neg;
      return ignored;
    };
  }

  function skipName(name) { return ALWAYS_SKIP.has(name); }

  // <input type="file" webkitdirectory>
  async function fromFileList(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) throw new SourceError('empty', 'The folder is empty.');
    const rootName = (files[0].webkitRelativePath || files[0].name).split('/')[0] || 'folder';
    let ignore = null;
    const gi = files.find((f) => f.webkitRelativePath === `${rootName}/.gitignore`);
    if (gi) { try { ignore = compileGitignore(await gi.text()); } catch (e) { /* unreadable */ } }
    const entries = [];
    let skipped = 0;
    for (const f of files) {
      const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
      if (!rel) continue;
      const parts = rel.split('/');
      if (parts.some(skipName) || (ignore && ignore(rel))) { skipped++; continue; }
      entries.push({ path: rel, size: f.size, type: 'blob' });
      if (entries.length >= MAX_LOCAL_FILES) break;
    }
    if (!entries.length) throw new SourceError('empty', 'No files are left in the folder after applying .gitignore.');
    return {
      kind: 'local', name: rootName, title: rootName, repo: null, entries, truncated: entries.length >= MAX_LOCAL_FILES,
      note: skipped ? `Skipped ${U.count(skipped, 'file')} from .git, node_modules and .gitignore.` : '',
      meta: null,
    };
  }

  // Drag and drop of a folder: walk entries, skipping ignored folders before reading them.
  async function fromDataTransfer(dt) {
    const roots = [];
    for (const item of Array.from(dt.items || [])) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) roots.push(entry);
    }
    if (!roots.length) {
      if (dt.files && dt.files.length) return fromFileList(dt.files);
      throw new SourceError('empty', 'Drop the whole project folder.');
    }
    const readAll = (dirEntry) => new Promise((resolve, reject) => {
      const reader = dirEntry.createReader();
      const out = [];
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) resolve(out); else { out.push(...batch); next(); }
      }, reject);
      next();
    });
    const fileOf = (fileEntry) => new Promise((resolve, reject) => fileEntry.file(resolve, reject));

    const single = roots.length === 1 && roots[0].isDirectory;
    const rootName = single ? roots[0].name : 'folder';
    const top = single ? await readAll(roots[0]) : roots;
    let ignore = null;
    const giEntry = top.find((e) => e.isFile && e.name === '.gitignore');
    if (giEntry) { try { ignore = compileGitignore(await (await fileOf(giEntry)).text()); } catch (e) { /* unreadable */ } }

    const entries = [];
    let skipped = 0;
    async function walk(list, prefix) {
      const dirs = [];
      await Promise.all(list.map(async (e) => {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (skipName(e.name) || (ignore && ignore(path))) { skipped++; return; }
        if (e.isDirectory) dirs.push([e, path]);
        else if (e.isFile && entries.length < MAX_LOCAL_FILES) {
          let size = 0;
          try { size = (await fileOf(e)).size; } catch (err) { /* keep 0 */ }
          entries.push({ path, size, type: 'blob' });
        }
      }));
      for (const [d, path] of dirs) {
        if (entries.length >= MAX_LOCAL_FILES) return;
        await walk(await readAll(d), path);
      }
    }
    await walk(top, '');
    if (!entries.length) throw new SourceError('empty', 'No files found in the folder.');
    return {
      kind: 'local', name: rootName, title: rootName, repo: null, entries, truncated: entries.length >= MAX_LOCAL_FILES,
      note: skipped ? `Skipped ${U.count(skipped, 'item')} (.git, node_modules, .gitignore).` : '',
      meta: null,
    };
  }

  // Pasted `tree` output, or a plain list of paths (git ls-files, find . -type f).
  function fromText(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (!lines.length) throw new SourceError('empty', 'Paste the output of `git ls-files` or `tree`.');
    const treeLike = lines.some((l) => /(├─|└─|\|--|`--|\+---|\\---)/.test(l));
    const entries = [];
    let rootName = 'pasted tree';
    if (treeLike) {
      // Windows `tree /F` marks folders with ├─── and lists files by indentation only.
      const windows = lines.some((l) => /[├└]───\S/.test(l));
      const stack = [];
      const parsed = [];
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k];
        if (/^\d+ director(y|ies)(, \d+ files?)?$/.test(l.trim())) continue;
        const m = l.match(/^(.*?)(├─+\s?|└─+\s?|\|--\s|`--\s|\+---\s?|\\---\s?)(.*)$/);
        if (!m) {
          const f = windows && l.match(/^([│|\s]+)(\S.*)$/);
          if (f) {
            const depth = Math.round(Array.from(f[1]).length / 4) - 1;
            if (depth >= 0) parsed.push({ depth, name: f[2].trim(), file: true });
          } else if (!parsed.length && k === 0) rootName = l.trim().replace(/\/$/, '') || rootName;
          continue;
        }
        const depth = Math.round(Array.from(m[1]).length / 4);
        parsed.push({ depth, name: m[3].replace(/ -> .*$/, '').replace(/\/$/, ''), dir: windows });
      }
      for (let k = 0; k < parsed.length; k++) {
        const { depth, name, dir } = parsed[k];
        stack.length = depth;
        stack[depth] = name;
        const isDir = dir || (k + 1 < parsed.length && parsed[k + 1].depth > depth);
        if (!isDir) entries.push({ path: stack.slice(0, depth + 1).join('/'), size: 0, type: 'blob' });
      }
      if (rootName === '.') rootName = 'project';
    } else {
      for (let l of lines) {
        l = l.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
        if (!l || l === '.' || l.endsWith('/')) continue;
        entries.push({ path: l, size: 0, type: 'blob' });
      }
      rootName = 'project';
    }
    if (!entries.length) throw new SourceError('empty', 'Couldn’t find any files in the text.');
    return {
      kind: 'paste', name: rootName, title: rootName, repo: null, entries, truncated: false,
      note: 'File sizes are unknown, so every note has the same length.', meta: null, noSizes: true,
    };
  }

  // GET /rate_limit does not count against the limit itself.
  async function rateLimit() {
    const token = getToken();
    try {
      const res = await fetch(`${API}/rate_limit`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) return { ok: res.status !== 401, bad: res.status === 401 };
      const core = (await res.json()).resources.core;
      return { ok: true, remaining: core.remaining, limit: core.limit, reset: core.reset * 1000 };
    } catch (e) {
      return { ok: false };
    }
  }

  return { parseRepo, fromGitHub, fromDemo, fromFileList, fromDataTransfer, fromText, getToken, setToken, compileGitignore, rateLimit };
})();
