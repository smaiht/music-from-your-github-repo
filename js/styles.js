'use strict';
// Arrangement styles. The tree decides the notes; a style decides how they are
// played: tempo range, swing, instruments, grooves per arrangement level, effects.
//
// Arrangement levels (0–3) come from the silhouette, one per 4-bar phrase:
//   0 — intro / breakdown, 1 — groove starts, 2 — full band, 3 — peak.
// Patterns are 16 steps per bar. Bass values: 1 root, 5 fifth, 8 octave.
//
// Optional production moves, each switched on per style:
//   testPerc  extra percussion that joins when the repo has tests
//   fills     drum fills before a new section ('snare3', 'snare16', 'toms'), picked per section
//   riser     noise sweep into a loud section;  impact  sub drop on big downbeats
//   harmony   a chord tone under the melody at the peak;  glide  legato melody notes slide
//   color     chord colour (triad → add9 → seventh) follows how varied the file types are
//   introSweep  the whole mix opens from a low-pass over the first phrase

const Styles = (() => {
  const LIST = {
    lofi: {
      mix: { lead: 0.7, arp: 1.12, orn: 1, comp: 1.37, pad: 2.6, bass: 0.44, drums: 0.44 },
      drumMix: { snare: 1.3, rim: 3.5, hat: 4.5, ohat: 4, shaker: 4.5 },
      name: 'Lo-fi',
      hint: 'electric piano, guitar, soft drums, vinyl',
      bpm: [74, 90], swing: 0.58, humanize: 0.008, kit: 'lofi',
      melWindow: 2, melSecond: true, leadTones: 'seventh', double: false,
      arpPerBeat: 2, arpPattern: [0, 2, 1, 3, 2, 4, 3, 1], arpTones: 'seventh', arpInst: 'guitar', arpBase: 48, arpLen: 2.4,
      comp: 'rhodes', chordType: 'rootless9', compRehit: true,
      pad: 'warm', padMinLevel: 2, padGain: 0.55,
      bass: 'warm', bassMinLevel: 1,
      bassPat: [null,
        [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 5, 0, 0, 1, 0, 0, 0, 8, 0]],
      drumMinLevel: 1,
      grooves: [null,
        { kick: 'x.........x.....', rim: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'x......x..x..x..', snare: '....x.......x..x', hat: 'x.xxx.xxx.xxx.xx', shaker: '..x...x...x...x.' }],
      fills: ['snare3'], sectionHit: 'swell', dirHit: 'strum', introSweep: true,
      testPerc: { kind: 'shaker', pat: 'x.x.x.x.x.x.x.x.' },
      leadMap: { code: 'vibes', docs: 'rhodes', data: 'marimba', web: 'glass', test: 'kalimba', media: 'musicbox', tool: 'guitar' },
      fx: {
        ir: 1.9,
        rev: { lead: 0.26, arp: 0.2, orn: 0.3, comp: 0.2, pad: 0.35, bass: 0, drums: 0.07 },
        dly: { lead: 0.14, orn: 0.2 },
        cho: { comp: 0.35, pad: 0.4, arp: 0.18 },
        trem: 0.28, crackle: 0.1, wow: 1, lowpass: 9000, drive: 1.8, eq: [2.5, -2, -3], duck: 0.12,
      },
    },
    ambient: {
      mix: { lead: 0.97, arp: 1.02, orn: 1, comp: 1.6, pad: 1.6, bass: 0.56, drums: 1 },
      drumMix: { rim: 3, shaker: 3.5 },
      name: 'Ambient',
      hint: 'pads, bells, long reverb, hardly any drums',
      bpm: [62, 74], swing: 0.5, humanize: 0.004, kit: 'ambient',
      melWindow: 4, melSecond: false, leadTones: 'seventh', double: false,
      arpPerBeat: 1, arpPattern: [0, 2, 4, 3, 1, 4], arpTones: 'open', arpInst: 'glass', arpBase: 60, arpLen: 3.5,
      comp: null, chordType: 'open', compRehit: false,
      pad: 'air', padMinLevel: 0, padGain: 1,
      bass: 'sub', bassMinLevel: 1,
      bassPat: [null,
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]],
      drumMinLevel: 2,
      grooves: [null, null,
        { shaker: '..x...x...x...x.' },
        { kick: 'x.........x.....', shaker: '..x...x...x...x.', rim: '............x...' }],
      fills: [], sectionHit: 'swell', dirHit: 'bell',
      testPerc: { kind: 'shaker', pat: '..x...x...x...x.' },
      leadMap: { code: 'vibes', docs: 'rhodes', data: 'marimba', web: 'glass', test: 'musicbox', media: 'glass', tool: 'kalimba' },
      fx: {
        ir: 4.5,
        rev: { lead: 0.5, arp: 0.55, orn: 0.6, comp: 0.5, pad: 0.6, bass: 0.1, drums: 0.3 },
        dly: { lead: 0.3, arp: 0.24, orn: 0.3 },
        cho: { pad: 0.5, arp: 0.3 },
        trem: 0, crackle: 0, wow: 0.35, lowpass: 12000, drive: 1.1, eq: [1, -1, -1], duck: 0,
      },
    },
    synth: {
      mix: { lead: 1.25, arp: 2.3, orn: 1.5, comp: 4.5, pad: 5.6, bass: 0.86, drums: 0.33 },
      // Per-drum trims (K-weighted): a big gated snare level with the kick, hats well under it.
      drumMix: { gsnare: 2.5, clap: 2.2, snare: 1.8, hat: 4.2, ohat: 4.2, tamb: 5, crash: 2.5, tom1: 1.25, tom2: 1.25, tom3: 1.25, impact: 1.25 },
      name: 'Synthwave',
      hint: 'poly synth lead, supersaw pads, gated snare, saw bass, sidechain',
      bpm: [100, 116], swing: 0.5, humanize: 0.002, kit: 'synth',
      melWindow: 2, melSecond: true, leadTones: 'triad', double: false, harmony: true, glide: true, color: true,
      arpPerBeat: 4, arpPattern: [0, 1, 2, 3, 2, 1], arpTones: 'triad', arpInst: 'sawpluck', arpBase: 55, arpLen: 1.4,
      comp: null, chordType: 'triad8', compRehit: false,
      pad: 'supersaw', padMinLevel: 0, padGain: 1,
      bass: 'saw', bassMinLevel: 1,
      bassPat: [null,
        [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        [1, 0, 8, 0, 1, 0, 8, 0, 1, 0, 8, 0, 1, 0, 8, 0],
        [1, 0, 8, 0, 1, 0, 8, 0, 1, 0, 8, 0, 1, 0, 8, 5]],
      drumMinLevel: 1,
      grooves: [null,
        { kick: 'x...x...x...x...', hat: '..x...x...x...x.' },
        { kick: 'x...x...x...x...', gsnare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'x...x...x...x...', gsnare: '....x.......x...', clap: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx', ohat: '..x...x...x...x.' }],
      fills: ['toms', 'snare16'], sectionHit: 'crash', dirHit: 'brass', riser: true, impact: true, introSweep: true,
      testPerc: { kind: 'tamb', pat: '..x...x...x...x.' },
      leadMap: { code: 'polylead', docs: 'rhodes', data: 'sawpluck', web: 'glass', test: 'musicbox', media: 'vibes', tool: 'pulse25' },
      fx: {
        ir: 2.4,
        rev: { lead: 0.22, arp: 0.15, orn: 0.25, comp: 0.2, pad: 0.3, bass: 0, drums: 0.06 },
        dly: { lead: 0.22, arp: 0.2, orn: 0.2 },
        cho: { pad: 0.5, lead: 0.15 },
        trem: 0, crackle: 0, wow: 0, lowpass: 0, drive: 1.3, eq: [2, -2, 2], duck: 0.55,
      },
    },
    chip: {
      mix: { lead: 0.73, arp: 2.14, orn: 1.3, comp: 1, pad: 1, bass: 0.65, drums: 0.42 },
      drumMix: { snare: 1.6, hat: 4, ohat: 3.5, crash: 2 },
      name: 'Chiptune',
      hint: '8-bit squares, fast arpeggios, noise drums',
      bpm: [124, 142], swing: 0.5, humanize: 0, kit: 'chip',
      melWindow: 1, melSecond: false, leadTones: 'triad', double: false,
      arpPerBeat: 4, arpPattern: [0, 1, 2], arpTones: 'triad', arpInst: 'pulse12', arpBase: 60, arpLen: 0.9,
      comp: null, chordType: 'triad', compRehit: false,
      pad: null, padMinLevel: 9, padGain: 0,
      bass: 'tri', bassMinLevel: 0,
      bassPat: [
        [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        [1, 0, 5, 0, 8, 0, 5, 0, 1, 0, 5, 0, 8, 0, 5, 0],
        [1, 0, 5, 0, 8, 0, 5, 0, 1, 0, 5, 0, 8, 0, 5, 0],
        [1, 0, 5, 0, 8, 0, 5, 0, 1, 0, 5, 0, 8, 5, 8, 5]],
      drumMinLevel: 1,
      grooves: [null,
        { kick: 'x.......x.......', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'x.....x.x.....x.', snare: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx' }],
      fills: ['snare16'], sectionHit: 'crash', dirHit: 'blip', harmony: true,
      leadMap: { code: 'pulse50', docs: 'pulse25', data: 'tri', web: 'pulse25', test: 'pulse12', media: 'pulse12', tool: 'pulse50' },
      fx: {
        ir: 0.9,
        rev: { lead: 0.08, arp: 0.05, orn: 0.08, comp: 0, pad: 0, bass: 0, drums: 0 },
        dly: { lead: 0.16 },
        cho: {},
        trem: 0, crackle: 0, wow: 0, lowpass: 0, drive: 1, eq: [0, 0, 1], duck: 0,
      },
    },
  };
  const KEYS = Object.keys(LIST);
  const DEFAULT = 'synth';
  const INST_NAMES = {
    guitar: 'nylon guitar', rhodes: 'electric piano', vibes: 'vibraphone', kalimba: 'kalimba', marimba: 'marimba',
    musicbox: 'music box', glass: 'glass bell', sawpluck: 'synth pluck',
    pulse50: 'square 50%', pulse25: 'square 25%', pulse12: 'narrow square 12%', tri: 'triangle',
    polylead: 'poly synth lead', brass: 'synth brass',
  };
  const LEVEL_NAMES = ['intro', 'groove', 'full band', 'climax'];

  function get(key) { return LIST[key] || LIST[DEFAULT]; }
  const instName = (k) => INST_NAMES[k] || k;

  return { LIST, KEYS, DEFAULT, get, instName, LEVEL_NAMES };
})();
