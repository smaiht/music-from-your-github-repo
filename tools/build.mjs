// Bundles index.html + css + js into single files. No dependencies.
//   node tools/build.mjs            → dist/filophone.html (standalone, open by double click)
//   node tools/build.mjs --artifact <out.html>
//                                   → the same page without <html>/<head>/<body> wrappers,
//                                     for hosts that add their own document skeleton.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, p) => `<style>\n${read(p)}</style>`);
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, p) => `<script>\n${read(p).replace(/<\/script/gi, '<\\/script')}</script>`);

const args = process.argv.slice(2);
const ai = args.indexOf('--artifact');
if (ai >= 0) {
  const out = resolve(args[ai + 1] || join(root, 'dist', 'artifact.html'));
  const body = html
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<html[^>]*>\s*/i, '')
    .replace(/<\/html>\s*$/i, '')
    .replace(/<head>\s*/i, '')
    .replace(/<\/head>\s*/i, '')
    .replace(/<body>\s*/i, '')
    .replace(/<\/body>\s*/i, '')
    .replace(/<meta charset="utf-8">\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  console.log(`artifact page → ${out} (${(body.length / 1024).toFixed(0)} KB)`);
} else {
  const out = join(root, 'dist', 'filophone.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`standalone page → ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}
