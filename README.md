# Filophone

**Live: [ne.so.gl/gitmusic](https://ne.so.gl/gitmusic/)**

A web page that turns a GitHub repository's file tree into music.
The tree is fully expanded, names are pushed to the left edge, letters become
blocks by ink density, and the figure turns 90° and mirrors downwards.
The result is a waveform, and it plays.

[**Watch the demo with sound**]
https://github.com/user-attachments/assets/92109122-3fe5-4d71-986f-0b1b5dac2933

It is not a screen recording: `tools/demo-video.mjs` steps the page's own renderer through a
virtual clock frame by frame, and lays over it the track rendered offline by the same engine,
so picture and sound line up to the sample.

## Running it

No build step needed.

- Open `index.html` with a double click. Everything works straight from disk, including GitHub requests.
- Or bundle it into one file: `node tools/build.mjs` → `dist/filophone.html`. You can send it
  to anyone or put it on GitHub Pages.
- For development any static server will do: `python3 -m http.server`.

## Publishing

The live site is a clone of this repo on the server: the web folder `/var/www/html/gitmusic`
is the working tree, and its git directory lives outside the web root
(`/var/lib/git/gitmusic.git`), so nothing but the site is served. Nginx serves `index.html`,
`css/` and `js/` directly, no build needed. To publish:

```
git push && tools/deploy.sh
```

`deploy.sh` checks that your `HEAD` is on GitHub, then fast-forwards the server with `git pull`.

To re-render the demo video (needs Chrome and ffmpeg): `node tools/build.mjs && node tools/demo-video.mjs`.

## Where the tree comes from

| Source | How |
|---|---|
| GitHub | A link like `github.com/owner/repo`, `owner/repo`, or `github.com/owner/repo/tree/branch/path` (only that folder plays). Two API requests: repo info and the recursive tree. |
| Rate limit hit | Falls back to the jsDelivr mirror automatically, and to a saved snapshot for the built-in examples. |
| Private repo | A read-only GitHub token under "GitHub token". Stored in this browser's `localStorage`. |
| Local folder | The "Pick a folder" button or drag and drop. The root `.gitignore` is respected, `.git` and `node_modules` are skipped. Only names and sizes are read. |
| Text | Output of `git ls-files`, `find . -type f` or `tree`. |

Six examples (nanoGPT, fzf, express, flask, ripgrep, react) are built into `js/demos.js`
and play without a network. To refresh them or add your own: `python3 tools/make_demos.py owner/repo …`.

## Playback

The page opens with a repo in the **synthwave** style and starts playing on its own once the
transformation finishes, if the browser allows sound without a click. Most browsers block that
on a first visit; then the page shows a play button over the wave and waits. Play, position,
the file that is sounding right now, loop and volume sit in a bar under the repo title that
sticks to the top of the window while you scroll.

Under the wave, **Why it sounds like this** lists what this particular tree is made of and
what each trait became. The peak and the drop are marked on the piano roll; click their cards
to jump there.

## How the tree becomes music

Play the tree's silhouette directly as a waveform and you get clicks and hum. So the
tree drives notes inside a musical frame instead.

| Tree property | What you hear |
|---|---|
| Line number, top to bottom | Time. One line = one grid step, a track lasts 20 seconds to 3 minutes |
| Top-level folder | Section: its own 4-bar chord progression and lead instrument, A A B A form for long ones |
| Silhouette peaks (longest name in each half-bar) | Melody: the melody's rhythm follows the shape of the tree |
| Other lines | A soft arpeggio over the chord, volume by name length |
| Folder name | Melody motif; entering a subfolder raises the melody, leaving lowers it |
| Silhouette over 4-bar phrases | Arrangement: intro, groove, full band, climax |
| File type | The section's instrument; files of other types add quiet ornaments |
| Letter density (share of inked pixels) | Note brightness |
| File size | How long a melody note rings |
| Position among siblings | Arpeggio stereo |
| Dominant language | Mode (Python is Dorian, JavaScript Mixolydian, Rust minor …) |
| Repository name | Key |
| Median name length | Tempo within the style |
| Numbered files (frame-1, frame-2 …) | The arpeggio climbs one chord tone per file |

The whole repo also sets the character of the track:

| Repo trait | What you hear |
|---|---|
| Variety of file types | Chord colour: plain triads, added ninths or sevenths |
| Share of tests | A shaker or tambourine joins in (from 5% tests; from 20% it starts early) |
| Share of docs | How present the pads are |
| Share of config and tooling (30%+) | Hi-hats go to sixteenths a level early |
| Total size | Length of the reverb, from a small room to a hall |
| Deepest file after the intro | The peak: its phrase plays at full strength, with a high sparkle |
| Biggest file | The drop: a sub boom and a cymbal on the next beat |

Styles: **synthwave** (the default: poly synth lead with glide, supersaw pads, gated 80s snare,
electronic toms, saw bass, arpeggiator, risers, sub drops, sidechain, a filtered intro),
**lo-fi** (electric piano, nylon guitar, soft drums, vinyl and tape), **ambient** (pads, bells,
long reverb), **chiptune** (8-bit squares, harmonies and noise drums).

Sound is synthesised in the browser. Guitar, electric piano, vibraphone, kalimba, marimba,
music box and bells are pre-rendered from a model of a string or bar (every overtone decays
at its own rate); the lead, brass, pads and basses are live analogue-style oscillators with
filter envelopes; drums are built like those of the 808/909 drum machines. Effects: plate
reverb, ping-pong delay, chorus, tremolo, sidechain, tape, vinyl, saturation, EQ, compressor
and limiter. Levels are balanced by K-weighted loudness, and no style clips. The result is
deterministic: one repo in one style always sounds the same. You can download a WAV, and a
MIDI file with one track per part.

## Code layout

```
index.html          markup
css/style.css       styles, light and dark themes
js/util.js          shared helpers
js/demos.js         built-in tree snapshots (generated by tools/make_demos.py)
js/sources.js       GitHub API, jsDelivr, folder, pasted text, .gitignore
js/model.js         tree → lines: depth, length, ink density, type, size
js/dsp.js           sample synthesis: instruments, drums, vinyl, reverb impulse
js/styles.js        styles: tempo, instruments, grooves, effects, balance
js/composer.js      lines → score: repo character, sections, chords, melody, arpeggio, bass, drums, landmarks
js/engine.js        live voices, effects, mix, playback scheduler, offline render, autoplay check
js/exporters.js     WAV, MIDI, ZIP
js/stage.js         canvas: the tree turning into a wave, and the piano roll
js/treepanel.js     side panel with the tree
js/app.js           wires it all together
tools/build.mjs     bundles everything into one HTML file
tools/deploy.sh     publishes: git pull on the server
tools/demo-video.mjs  renders media/demo.mp4 and media/preview.gif frame by frame
media/              the demo video and its preview
```

Keys: Space plays/pauses, ← → skip 5 seconds, Home goes back to the start.
