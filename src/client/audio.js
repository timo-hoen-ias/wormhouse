// Kleine Soundeffekte, komplett per WebAudio synthetisiert (keine Assets nötig).
let ctx = null;
let master = null;
let muted = false;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio() { ac(); }
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.5; }
export function isMuted() { return muted; }

function noise(duration, { freq = 800, q = 1, gain = 1, type = 'lowpass', decay = duration } = {}) {
  const c = ac(); if (!c || muted) return;
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + decay);
  src.connect(f).connect(g).connect(master);
  src.start();
}

function tone(f0, f1, duration, { type = 'square', gain = 0.2 } = {}) {
  const c = ac(); if (!c || muted) return;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), c.currentTime + duration);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
  o.connect(g).connect(master);
  o.start();
  o.stop(c.currentTime + duration);
}

export const sfx = {
  boom(size = 1) {
    noise(0.9 * size + 0.3, { freq: 500, gain: 1.2, decay: 0.8 * size + 0.3 });
    tone(120, 30, 0.6, { type: 'sine', gain: 0.6 });
  },
  shoot() { noise(0.25, { freq: 1500, gain: 0.5, type: 'bandpass', q: 0.7 }); tone(300, 80, 0.2, { gain: 0.15 }); },
  beep() { tone(1800, 1750, 0.12, { type: 'square', gain: 0.12 }); },
  laser() { tone(2400, 600, 0.18, { type: 'sawtooth', gain: 0.1 }); },
  jump() { tone(300, 700, 0.15, { type: 'triangle', gain: 0.15 }); },
  splash() { noise(0.8, { freq: 900, gain: 0.6, type: 'bandpass', q: 0.5 }); },
  thud() { tone(160, 60, 0.15, { type: 'sine', gain: 0.4 }); },
  bonk() { tone(220, 90, 0.2, { type: 'square', gain: 0.25 }); noise(0.15, { freq: 1200, gain: 0.4 }); },
  turn() { tone(660, 660, 0.1, { type: 'triangle', gain: 0.15 }); setTimeout(() => tone(880, 880, 0.15, { type: 'triangle', gain: 0.15 }), 120); },
  tick() { tone(1000, 1000, 0.04, { type: 'square', gain: 0.06 }); },
  build() { tone(200, 400, 0.12, { type: 'triangle', gain: 0.2 }); },
  teleport() { tone(400, 2000, 0.3, { type: 'sine', gain: 0.15 }); },
  engine() { tone(90, 110, 0.3, { type: 'sawtooth', gain: 0.05 }); },
};
