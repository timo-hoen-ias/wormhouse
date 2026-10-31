// Komplette Klangwelt per WebAudio synthetisiert – keine Audiodateien, keine Lizenzfragen.
// Busse: sfx (Effekte), music (prozedurale Hintergrundmusik), amb (Lagerhallen-Atmosphäre).
// Alles läuft über einen Hall (Faltung mit generierter Impulsantwort) für den Hallen-Klang.

let ctx = null;
let master, sfxBus, musicBus, ambBus, reverbIn;
let noiseBuf = null;
let brownBuf = null;

function load(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, val); } catch { /* egal */ } }

let muted = load('wh.muted', '0') === '1';
let musicOn = load('wh.music', '1') === '1';

const MASTER_VOL = 0.55;
const MUSIC_VOL = 0.16;
const AMB_VOL = 0.5;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_VOL;
    // Sanfter Limiter gegen Übersteuern bei vielen Explosionen
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6;
    comp.attack.value = 0.004; comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);

    sfxBus = ctx.createGain(); sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = musicOn ? MUSIC_VOL : 0; musicBus.connect(master);
    ambBus = ctx.createGain(); ambBus.gain.value = musicOn ? AMB_VOL : 0; ambBus.connect(master);

    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(2.6, 2.4);
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.9;
    reverbIn.connect(conv).connect(master);

    noiseBuf = makeNoise(2, false);
    brownBuf = makeNoise(4, true);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function makeNoise(seconds, brown) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}

function makeImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      // frühe Reflexionen der Hallenwände + langer Nachhall
      const t = i / len;
      const early = i < ctx.sampleRate * 0.08 && Math.random() < 0.004 ? 0.8 : 0;
      d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) + early) * 0.5;
    }
  }
  return buf;
}

export function unlockAudio() { ac(); }
export function audioReady() { return !!ctx && ctx.state === 'running'; }
export function setMuted(m) {
  muted = m; save('wh.muted', m ? '1' : '0');
  if (master) master.gain.setTargetAtTime(m ? 0 : MASTER_VOL, ctx.currentTime, 0.05);
}
export function isMuted() { return muted; }
export function setMusicOn(on) {
  musicOn = on; save('wh.music', on ? '1' : '0');
  if (!ctx) return;
  musicBus.gain.setTargetAtTime(on ? MUSIC_VOL : 0, ctx.currentTime, 0.3);
  ambBus.gain.setTargetAtTime(on ? AMB_VOL : 0, ctx.currentTime, 0.3);
}
export function isMusicOn() { return musicOn; }

// ---------- Bausteine ----------
const now = () => ctx.currentTime;
const rand = (a, b) => a + Math.random() * (b - a);
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Ausgang mit optionalem Panning und Hall-Anteil
function out(node, { dest, pan = 0, wet = 0 } = {}) {
  let n = node;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    n.connect(p); n = p;
  }
  n.connect(dest || sfxBus);
  if (wet > 0) {
    const s = ctx.createGain(); s.gain.value = wet;
    n.connect(s).connect(reverbIn);
  }
}

function envGain(t, dur, peak, attack = 0.005) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, dur));
  return g;
}

function tone(f0, f1, dur, { type = 'square', gain = 0.2, t = now(), attack = 0.005, filter = 0, q = 1, dest, pan, wet, vibrato = 0 } = {}) {
  if (!ctx || muted) return;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  if (vibrato) {
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
    const lg = ctx.createGain(); lg.gain.value = vibrato;
    lfo.connect(lg).connect(o.frequency);
    lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  let n = o;
  if (filter) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter; f.Q.value = q;
    n.connect(f); n = f;
  }
  const g = envGain(t, dur, gain, attack);
  n.connect(g);
  out(g, { dest, pan, wet });
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur, { freq = 800, f1 = freq, q = 1, gain = 0.5, type = 'lowpass', t = now(), attack = 0.003, dest, pan, wet, brown = false } = {}) {
  if (!ctx || muted) return;
  const src = ctx.createBufferSource();
  src.buffer = brown ? brownBuf : noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (f1 !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = envGain(t, dur, gain, attack);
  src.connect(f).connect(g);
  out(g, { dest, pan, wet });
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur + 0.05);
}

// Metallischer Klang (Regal, Gabel, Schraube): unharmonische Teiltöne
function metal(f, dur, { gain = 0.15, t = now(), dest, pan, wet = 0.3 } = {}) {
  [1, 2.76, 5.4, 8.93].forEach((m, i) => tone(f * m, f * m * 0.995, dur / (1 + i * 0.6), { type: 'sine', gain: gain / (1 + i), t, dest, pan, wet }));
}

// Stimme: Sägezahn durch zwei Formantfilter, gleitet von Vokal zu Vokal (z.B. „au“)
function voice(pitch, dur, vowels, { gain = 0.22, t = now(), glide = 0.8 } = {}) {
  if (!ctx || muted) return;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(pitch * 1.15, t);
  o.frequency.exponentialRampToValueAtTime(pitch * glide, t + dur);
  const g = envGain(t, dur, gain, 0.02);
  const mix = ctx.createGain();
  for (let k = 0; k < 2; k++) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(vowels[0][k], t);
    f.frequency.linearRampToValueAtTime(vowels[1][k], t + dur * 0.8);
    o.connect(f).connect(mix);
  }
  mix.connect(g);
  out(g, { wet: 0.15 });
  o.start(t); o.stop(t + dur + 0.05);
}
const VOWEL = { a: [800, 1200], u: [320, 800], o: [450, 850], e: [500, 1800], i: [300, 2300] };

// ---------- Soundeffekte ----------
export const sfx = {
  boom(size = 1) {
    const t = now();
    const s = Math.max(0.4, Math.min(1.8, size));
    tone(110, 28, 0.5 + s * 0.4, { type: 'sine', gain: 0.75, t });
    noise(0.5 + s * 0.7, { freq: 2600, f1: 140, gain: 0.9, t, wet: 0.5 });
    noise(0.15, { freq: 5000, type: 'highpass', gain: 0.35, t });
    // Trümmer prasseln nach
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.25 + Math.random() * 0.6;
      if (Math.random() < 0.5) metal(rand(900, 2200), 0.15, { gain: 0.04, t: tt });
      else noise(0.04, { freq: rand(1500, 4000), type: 'bandpass', q: 3, gain: 0.15, t: tt });
    }
  },
  shoot() { // pneumatische Paketkanone: „Fwump“
    noise(0.3, { freq: 300, f1: 1200, type: 'bandpass', q: 0.8, gain: 0.7, wet: 0.2 });
    tone(160, 55, 0.22, { type: 'sine', gain: 0.5 });
  },
  throw() { noise(0.28, { freq: 500, f1: 1800, type: 'bandpass', q: 1.5, gain: 0.35 }); },
  swing() {
    noise(0.22, { freq: 400, f1: 2000, type: 'bandpass', q: 1.2, gain: 0.4 });
    metal(310, 0.35, { gain: 0.12, t: now() + 0.05 });
  },
  beep() { tone(1800, 1800, 0.07, { type: 'square', gain: 0.1 }); tone(2400, 2400, 0.07, { type: 'square', gain: 0.1, t: now() + 0.08 }); },
  laser() { tone(2400, 500, 0.18, { type: 'sawtooth', gain: 0.08, filter: 4000 }); tone(1800, 1800, 0.05, { type: 'square', gain: 0.06 }); },
  jump() { voice(rand(170, 240), 0.16, [VOWEL.e, VOWEL.i], { gain: 0.12, glide: 1.4 }); noise(0.06, { freq: 600, gain: 0.15 }); },
  splash() {
    const t = now();
    noise(0.9, { freq: 2500, f1: 400, type: 'bandpass', q: 0.6, gain: 0.7, t, wet: 0.3 });
    for (let i = 0; i < 7; i++) tone(rand(300, 600), rand(900, 1500), 0.06, { type: 'sine', gain: 0.08, t: t + 0.2 + i * rand(0.05, 0.12) });
  },
  thud() { tone(150, 55, 0.14, { type: 'sine', gain: 0.35 }); noise(0.05, { freq: 900, gain: 0.15 }); },
  bounce() { tone(rand(180, 240), 70, 0.1, { type: 'sine', gain: 0.25 }); noise(0.04, { freq: 1500, type: 'bandpass', gain: 0.12 }); },
  bonk() { tone(220, 90, 0.2, { type: 'square', gain: 0.18, filter: 1500 }); metal(260, 0.4, { gain: 0.15 }); },
  turn() { // Schichtglocke wie aus der Lautsprecheranlage
    const t = now();
    [[659, 0], [523, 0.32]].forEach(([f, d]) => {
      tone(f, f, 0.9, { type: 'sine', gain: 0.18, t: t + d, wet: 0.4 });
      tone(f * 2, f * 2, 0.5, { type: 'sine', gain: 0.05, t: t + d });
    });
  },
  tick() { tone(1000, 1000, 0.04, { type: 'square', gain: 0.06 }); },
  fuse() { tone(2200, 2000, 0.03, { type: 'square', gain: 0.05 }); noise(0.02, { freq: 4000, type: 'highpass', gain: 0.08 }); },
  build() { // Klebeband ratschen + Karton-Plopp
    const t = now();
    for (let i = 0; i < 5; i++) noise(0.05, { freq: 2500, type: 'highpass', gain: 0.18, t: t + i * 0.035 });
    tone(140, 80, 0.12, { type: 'sine', gain: 0.3, t: t + 0.2 });
    noise(0.1, { freq: 500, gain: 0.25, t: t + 0.2 });
  },
  teleport() {
    const t = now();
    tone(300, 2400, 0.35, { type: 'sine', gain: 0.12, wet: 0.4 });
    for (let i = 0; i < 6; i++) tone(rand(1500, 3000), rand(3000, 4000), 0.08, { type: 'triangle', gain: 0.04, t: t + 0.05 * i });
  },
  engine() { tone(80, 120, 0.4, { type: 'sawtooth', gain: 0.08, filter: 500 }); },
  crane() { // Rückfahrwarner des Krans
    const t = now();
    for (let i = 0; i < 4; i++) tone(1050, 1050, 0.22, { type: 'square', gain: 0.07, t: t + i * 0.45, filter: 3000, wet: 0.3 });
  },
  whistle() { // fallende Palette
    tone(1800, 500, 1.1, { type: 'sine', gain: 0.05, vibrato: 8 });
  },
  ouch() {
    const p = rand(140, 230);
    voice(p, rand(0.22, 0.32), Math.random() < 0.5 ? [VOWEL.a, VOWEL.u] : [VOWEL.o, VOWEL.u], { gain: 0.22, glide: 0.75 });
  },
  oof() { // harte Landung
    voice(rand(110, 150), 0.18, [VOWEL.u, VOWEL.o], { gain: 0.2, glide: 0.7 });
    tone(120, 45, 0.2, { type: 'sine', gain: 0.5 });
    noise(0.12, { freq: 700, gain: 0.3 });
  },
  land() { tone(110, 55, 0.08, { type: 'sine', gain: 0.18 }); noise(0.05, { freq: 600, gain: 0.12 }); },
  step(alt = false) { noise(0.04, { freq: alt ? 520 : 420, type: 'bandpass', q: 2, gain: 0.07 }); },
  death() { // „Kündigung“: traurige Posaune
    const t = now();
    [55, 54, 53].forEach((n, i) => tone(midi(n), midi(n), 0.38, { type: 'sawtooth', gain: 0.09, t: t + i * 0.4, filter: 900, attack: 0.03, wet: 0.2 }));
    tone(midi(52), midi(51), 1.0, { type: 'sawtooth', gain: 0.09, t: t + 1.2, filter: 900, attack: 0.03, vibrato: 6, wet: 0.2 });
  },
  slurp() { // Kaffeepause
    noise(0.5, { freq: 700, f1: 1600, type: 'bandpass', q: 4, gain: 0.25 });
    voice(130, 0.4, [VOWEL.a, VOWEL.a], { gain: 0.08, t: now() + 0.6, glide: 0.9 });
  },
  win() {
    const t = now();
    [60, 64, 67, 72, 67, 72].forEach((n, i) => {
      const d = i < 4 ? 0.14 : 0.28;
      const at = t + (i < 4 ? i * 0.14 : 0.56 + (i - 4) * 0.2);
      tone(midi(n), midi(n), d + 0.15, { type: 'square', gain: 0.08, t: at, filter: 3000, wet: 0.2 });
      tone(midi(n - 12), midi(n - 12), d + 0.15, { type: 'triangle', gain: 0.12, t: at });
    });
  },
  lose() {
    const t = now();
    [64, 63, 62, 61].forEach((n, i) => tone(midi(n), midi(n), 0.4, { type: 'triangle', gain: 0.12, t: t + i * 0.35, wet: 0.3 }));
  },
};

// ---------- Dauergeräusche (Stapler-Motor, Gas-Zischen, Aufladen) ----------
const loops = {};
function loopNode(name, make) {
  if (!loops[name]) loops[name] = make();
  return loops[name];
}

export function setLoop(name, on, param = 0) {
  if (!ctx || (!on && !loops[name])) return;
  const t = now();
  if (name === 'engine') {
    const l = loopNode(name, () => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 55;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 11;
      const lg = ctx.createGain(); lg.gain.value = 8; lfo.connect(lg).connect(o.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(f).connect(g); out(g, { wet: 0.1 });
      o.start(); lfo.start();
      return { g };
    });
    l.g.gain.setTargetAtTime(on && !muted ? 0.09 : 0, t, 0.08);
  } else if (name === 'hiss') {
    const l = loopNode(name, () => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3500;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(f).connect(g); out(g);
      s.start();
      return { g };
    });
    l.g.gain.setTargetAtTime(on && !muted ? 0.035 + param * 0.05 : 0, t, 0.1);
  } else if (name === 'charge') {
    const l = loopNode(name, () => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 200;
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 201;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
      const g = ctx.createGain(); g.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.25;
      o.connect(f); o2.connect(g2).connect(f); f.connect(g); out(g);
      o.start(); o2.start();
      return { g, o, o2 };
    });
    const f = 180 + param * 620;
    l.o.frequency.setTargetAtTime(f, t, 0.03);
    l.o2.frequency.setTargetAtTime(f * 1.005, t, 0.03);
    l.g.gain.setTargetAtTime(on && !muted ? 0.07 : 0, t, on ? 0.02 : 0.05);
  }
}

// ---------- Prozedurale Hintergrundmusik ----------
// Kleiner Lookahead-Sequencer. „menu“: ruhige Lagerhallen-Lounge, „game“: Lagerfunk mit Schlagzeug.
const CHORDS = {
  Am: [57, 60, 64], F: [53, 57, 60], C: [55, 60, 64], G: [55, 59, 62], E: [56, 59, 64], Dm: [57, 62, 65],
};
const PROG = {
  menu: ['Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'E'],
  game: ['Am', 'Am', 'F', 'G', 'Am', 'C', 'Dm', 'E'],
};
const PENTA = [57, 60, 62, 64, 67, 69, 72, 74, 76];
const music = { mode: null, timer: null, next: 0, step: 0, phrases: null, seed: 1 };

function mrng() { // deterministischer Zufall für Melodien
  music.seed = (music.seed * 1664525 + 1013904223) >>> 0;
  return music.seed / 4294967296;
}

function makePhrase(mode) {
  // 4 Takte à 16 Sechzehntel: Notenliste [step, dauerInSteps, chordtonOderSkala]
  const notes = [];
  const density = mode === 'game' ? 0.42 : 0.28;
  for (let s = 0; s < 64; s += 2) {
    const strong = s % 8 === 0;
    if (mrng() < (strong ? density + 0.35 : density)) {
      const len = mrng() < 0.3 ? 4 : 2;
      notes.push({ s, len, chordTone: strong || mrng() < 0.5, pick: mrng() });
    }
  }
  return notes;
}

function newCycle() {
  const a = makePhrase(music.mode), b = makePhrase(music.mode);
  music.phrases = [a, a, b, a];
}

const mdest = () => musicBus;
function kick(t) { tone(150, 40, 0.22, { type: 'sine', gain: 0.9, t, dest: mdest() }); }
function snare(t) { noise(0.14, { freq: 1800, type: 'highpass', gain: 0.35, t, dest: mdest(), wet: 0.15 }); tone(190, 150, 0.08, { type: 'triangle', gain: 0.25, t, dest: mdest() }); }
function hat(t, open) { noise(open ? 0.12 : 0.035, { freq: 7500, type: 'highpass', gain: open ? 0.12 : 0.1, t, dest: mdest() }); }
function bass(n, t, d) { tone(midi(n), midi(n), d, { type: 'sawtooth', gain: 0.35, t, filter: 520, q: 4, dest: mdest(), attack: 0.008 }); }
function pad(chord, t, d) {
  for (const n of chord) tone(midi(n), midi(n), d, { type: 'triangle', gain: 0.06, t, attack: 0.25, dest: mdest(), wet: 0.4 });
}
function lead(n, t, d, mode) {
  if (mode === 'game') {
    tone(midi(n), midi(n), d, { type: 'square', gain: 0.07, t, filter: 2200, dest: mdest(), wet: 0.25, vibrato: 3 });
  } else {
    // Kalimba-artiges Zupfen
    tone(midi(n), midi(n), d * 1.5, { type: 'sine', gain: 0.16, t, dest: mdest(), wet: 0.4 });
    tone(midi(n + 12), midi(n + 12), 0.12, { type: 'sine', gain: 0.04, t, dest: mdest() });
  }
}

function scheduleStep(t, step) {
  const mode = music.mode;
  const bpm = mode === 'game' ? 108 : 78;
  const s16 = 60 / bpm / 4;
  const bar = Math.floor(step / 16) % 16; // 16 Takte pro Zyklus
  const inBar = step % 16;
  if (step % 256 === 0) newCycle();
  const prog = PROG[mode];
  const chordName = prog[bar % prog.length];
  const chord = CHORDS[chordName];
  const bassRoot = { Am: 45, F: 41, C: 48, G: 43, E: 40, Dm: 38 }[chordName];

  if (inBar === 0) pad(chord, t, s16 * 16);

  if (mode === 'game') {
    // Schlagzeug
    if (inBar === 0 || inBar === 8 || inBar === 10) kick(t);
    if (inBar === 4 || inBar === 12) snare(t);
    if (inBar % 2 === 0) hat(t, inBar === 14);
    if (bar % 8 === 7 && inBar >= 12) snare(t); // Fill am Phrasenende
    // Bass: Funk-Muster
    const pat = { 0: 0, 3: 0, 6: 12, 8: 0, 10: 7, 12: 0, 14: 10 };
    if (pat[inBar] != null) bass(bassRoot + pat[inBar], t, s16 * 1.6);
  } else {
    if (inBar === 0) bass(bassRoot, t, s16 * 14);
    if (inBar === 8 && bar % 2) hat(t, true);
    // Arpeggio
    if (inBar % 4 === 2) lead(chord[(inBar / 4 + bar) % 3 | 0] + 12, t, s16 * 2, 'arp');
  }

  // Melodie (in den Takten 4–15 jedes Zyklus, damit es Luft hat)
  if (bar >= 4) {
    const phrase = music.phrases[Math.floor((bar - 4) / 4)];
    const ps = ((bar - 4) % 4) * 16 + inBar;
    for (const nt of phrase) {
      if (nt.s !== ps) continue;
      let n;
      if (nt.chordTone) n = chord[Math.floor(nt.pick * 3)] + 12;
      else n = PENTA[Math.floor(nt.pick * PENTA.length)] + (mode === 'game' ? 0 : 12);
      if (chordName === 'E' && n % 12 === 0) n -= 1; // gis statt c über E-Dur
      lead(n, t, nt.len * s16 * 0.9, mode);
    }
  }
  return s16;
}

function tickMusic() {
  if (!ctx || !music.mode) return;
  if (music.next < ctx.currentTime - 0.3) music.next = ctx.currentTime + 0.05; // Tab war im Hintergrund
  while (music.next < ctx.currentTime + 0.15) {
    const d = scheduleStep(music.next, music.step);
    music.step++;
    music.next += d;
  }
}

export function setMusicMode(mode) {
  if (music.mode === mode) return;
  if (mode && !audioReady()) return; // erst nach Nutzerinteraktion
  music.mode = mode;
  if (!mode) { clearInterval(music.timer); music.timer = null; return; }
  music.step = 0;
  music.seed = (Math.random() * 1e9) >>> 0;
  music.next = ctx.currentTime + 0.2;
  newCycle();
  if (!music.timer) music.timer = setInterval(tickMusic, 30);
}
export function musicMode() { return music.mode; }

// ---------- Lagerhallen-Atmosphäre ----------
// Raumrauschen, Neonröhren-Brummen, Hafenwasser + zufällige Ereignisse in der Ferne:
// Rückfahrwarner, Stapler fährt vorbei, Regal klappert, Durchsage-Gong, Möwen.
const amb = { started: false, timer: null };

export function startAmbience() {
  if (amb.started || !ctx) return;
  amb.started = true;
  const t = now();
  // Raumton
  const room = ctx.createBufferSource(); room.buffer = brownBuf; room.loop = true;
  const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 260;
  const rg = ctx.createGain(); rg.gain.value = 0.35;
  room.connect(rf).connect(rg).connect(ambBus); room.start(t);
  // Neonröhren: 100 Hz + Obertöne, ganz leise
  for (const [f, g] of [[100, 0.012], [200, 0.006], [300, 0.003]]) {
    const o = ctx.createOscillator(); o.frequency.value = f;
    const og = ctx.createGain(); og.gain.value = g;
    o.connect(og).connect(ambBus); o.start(t);
  }
  // Wasser im Hafenbecken: gefiltertes Rauschen, langsam schwankend
  const w = ctx.createBufferSource(); w.buffer = noiseBuf; w.loop = true;
  const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 450;
  const wg = ctx.createGain(); wg.gain.value = 0.04;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.23;
  const lg = ctx.createGain(); lg.gain.value = 0.03;
  lfo.connect(lg).connect(wg.gain);
  w.connect(wf).connect(wg).connect(ambBus); w.start(t); lfo.start(t);

  const loop = () => {
    if (!musicOn || muted) { amb.timer = setTimeout(loop, 3000); return; }
    ambientEvent();
    amb.timer = setTimeout(loop, rand(3500, 9000));
  };
  amb.timer = setTimeout(loop, 2000);
}

function ambientEvent() {
  const t = now() + 0.05;
  const pan = rand(-0.9, 0.9);
  const o = { dest: ambBus, pan, wet: 0.8 };
  const r = Math.random();
  if (r < 0.22) {
    // Rückfahrwarner eines Staplers in der Ferne
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) tone(1000, 1000, 0.3, { ...o, type: 'square', gain: 0.025, t: t + i * 0.6, filter: 1600 });
  } else if (r < 0.4) {
    // Stapler fährt vorbei
    if (muted) return;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(48, t); osc.frequency.linearRampToValueAtTime(62, t + 2); osc.frequency.linearRampToValueAtTime(50, t + 4.5);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.06, t + 2); g.gain.linearRampToValueAtTime(0.0001, t + 4.5);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    osc.connect(f).connect(g);
    if (p) {
      p.pan.setValueAtTime(-pan, t); p.pan.linearRampToValueAtTime(pan, t + 4.5);
      g.connect(p).connect(ambBus);
    } else g.connect(ambBus);
    osc.start(t); osc.stop(t + 4.6);
  } else if (r < 0.58) {
    // Palette knallt aufs Regal / Metallklappern
    noise(0.12, { ...o, freq: 400, gain: 0.12, t });
    metal(rand(180, 420), 0.9, { ...o, gain: 0.05, t });
    if (Math.random() < 0.5) metal(rand(500, 900), 0.4, { ...o, gain: 0.025, t: t + 0.18 });
  } else if (r < 0.7) {
    // Rollenbahn rattert
    for (let i = 0; i < 18; i++) noise(0.03, { ...o, freq: 900, type: 'bandpass', q: 2, gain: 0.04 * Math.sin((i / 18) * Math.PI), t: t + i * 0.09 });
  } else if (r < 0.8) {
    // Durchsage-Gong
    [[784, 0], [659, 0.4], [523, 0.8]].forEach(([f, d]) => tone(f, f, 1.2, { ...o, type: 'sine', gain: 0.035, t: t + d }));
    // „Sprecher“ – unverständliches Gemurmel
    for (let i = 0; i < 6; i++) {
      if (muted) break;
      const vv = Object.values(VOWEL);
      voiceAmb(rand(120, 160), 0.18, vv[Math.floor(Math.random() * vv.length)], vv[Math.floor(Math.random() * vv.length)], t + 1.8 + i * 0.22, pan);
    }
  } else if (r < 0.9) {
    // Möwen über dem Hafen
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      tone(rand(1500, 1900), rand(1000, 1200), 0.28, { ...o, type: 'sine', gain: 0.02, t: t + i * 0.32, vibrato: 60 });
    }
  } else {
    // Hupe eines Staplers
    tone(380, 380, 0.25, { ...o, type: 'sawtooth', gain: 0.03, t, filter: 1200 });
    tone(380, 380, 0.4, { ...o, type: 'sawtooth', gain: 0.03, t: t + 0.35, filter: 1200 });
  }
}

function voiceAmb(pitch, dur, v0, v1, t, pan) {
  const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(pitch, t);
  o.frequency.linearRampToValueAtTime(pitch * rand(0.85, 1.1), t + dur);
  const g = envGain(t, dur, 0.03, 0.03);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 4;
  f.frequency.setValueAtTime(v0[0], t); f.frequency.linearRampToValueAtTime(v1[0], t + dur);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500; // Lautsprecher-Klang
  o.connect(f).connect(lp).connect(g);
  out(g, { dest: ambBus, pan, wet: 0.9 });
  o.start(t); o.stop(t + dur + 0.05);
}
