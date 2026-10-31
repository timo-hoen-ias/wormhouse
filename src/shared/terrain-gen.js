// Deterministische Level-Generierung aus einem Seed.
// Materialien: 0 Luft, 1 Kartonstapel, 2 Beton, 3 Regalträger (Stahl), 4 Kartonbrücke
import { mulberry32 } from './rng.js';
import { WORLD_W as W, WORLD_H as H, WATER_Y, WORKER_R } from './constants.js';
import { DEFAULT_MAP, DEFAULT_COMPLEXITY } from './maps.js';

export const MAT = { AIR: 0, CARDBOARD: 1, CONCRETE: 2, STEEL: 3, GIRDER: 4 };

function fillRect(mat, x0, y0, w, h, m) {
  const x1 = Math.min(W, Math.round(x0 + w));
  const y1 = Math.min(H, Math.round(y0 + h));
  for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
    const row = y * W;
    for (let x = Math.max(0, Math.round(x0)); x < x1; x++) mat[row + x] = m;
  }
}

function carveEllipse(mat, cx, cy, rx, ry) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, cy + ry); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) mat[y * W + x] = 0;
    }
  }
}

// Komplexität 0–3 skaliert, wie viel Zeug in der Halle steht.
const DENSITY = [0.5, 1, 1.5, 2.1];
const ROUGH = [0.6, 1, 1.15, 1.3];

// Erste feste Zelle von oben in Spalte x (oder -1).
function groundAt(mat, x, from = 0, to = WATER_Y) {
  const xi = Math.max(0, Math.min(W - 1, Math.round(x)));
  for (let y = Math.max(0, from); y < to; y++) if (mat[y * W + xi]) return y;
  return -1;
}

// Höhenprofil aus überlagerten Sinuswellen, Ränder hochgezogen, Lücken = Wasser.
function waveHeights(rng, base, amp, gaps, { edge = true, nWaves = 5, min = 220 } = {}) {
  const waves = [];
  for (let i = 0; i < nWaves; i++) {
    waves.push({
      amp: ((40 + rng() * 90) / (i * 0.7 + 1)) * amp,
      freq: ((i + 1) * (0.7 + rng() * 0.9) * Math.PI * 2) / W,
      phase: rng() * Math.PI * 2,
    });
  }
  const heights = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let h = base;
    for (const w of waves) h += w.amp * Math.sin(w.freq * x + w.phase);
    if (edge && x < 140) h += (140 - x) * 4;
    if (edge && x > W - 140) h += (x - (W - 140)) * 4;
    for (const g of gaps) {
      const d = Math.abs(x - g.c) - g.half;
      if (d < 0) h = H + 10;
      else if (d < 50) h += (50 - d) * 5;
    }
    heights[x] = Math.max(min, Math.min(H + 10, h));
  }
  return heights;
}

function fillGround(mat, heights, depth = 120) {
  for (let x = 0; x < W; x++) {
    const top = Math.round(heights[x]);
    const concreteDepth = depth + Math.sin(x * 0.02) * 20;
    for (let y = Math.max(0, top); y < H; y++) {
      mat[y * W + x] = y - top > concreteDepth ? MAT.CONCRETE : MAT.CARDBOARD;
    }
  }
}

function addCaves(mat, rng, heights, n, { x0 = 150, x1 = W - 150, depth = 220 } = {}) {
  for (let i = 0; i < n; i++) {
    const cx = x0 + rng() * (x1 - x0);
    const cy = heights[Math.round(cx)] + 70 + rng() * depth;
    if (cy > WATER_Y - 40) continue;
    carveEllipse(mat, cx, cy, 40 + rng() * 80, 22 + rng() * 40);
  }
}

// Freischwebende Regalböden (Stahlträger) über dem Boden.
function addShelves(mat, rng, heights, n, { x0 = 80, x1 = W - 80, minY = 140 } = {}) {
  for (let i = 0; i < n; i++) {
    const w = 120 + rng() * 150;
    const x = x0 + rng() * (x1 - x0 - w);
    const ground = Math.min(heights[Math.round(x)], heights[Math.round(x + w)], WATER_Y);
    const y = Math.max(minY, ground - 130 - rng() * 230);
    fillRect(mat, x, y, w, 12, MAT.STEEL);
  }
}

// Kartonstapel auf dem, was gerade oben liegt.
function addStacks(mat, rng, n, { x0 = 120, x1 = W - 120, from = 100 } = {}) {
  for (let i = 0; i < n; i++) {
    const x = x0 + rng() * (x1 - x0);
    const sy = groundAt(mat, x, from);
    if (sy < 0) continue;
    const rows = 1 + Math.floor(rng() * 3);
    const cols = 1 + Math.floor(rng() * 2);
    for (let r = 0; r < rows; r++) {
      const c = Math.max(1, cols - (r > 0 && rng() < 0.5 ? 1 : 0));
      const off = (r % 2) * 10;
      fillRect(mat, x + off, sy - (r + 1) * 34 + 8, c * 44, 34, MAT.CARDBOARD);
    }
  }
}

const n = (base, c) => Math.round(base * DENSITY[c]);

// ---------- Karten ----------
const GENERATORS = {
  // Der Klassiker. Bei Komplexität „Normal“ identisch zur ersten Version.
  lager(rng, mat, c) {
    const amp = ROUGH[c];
    // Wellen zuerst ziehen (gleiche Zufallsreihenfolge wie früher)
    const waveRng = [];
    for (let i = 0; i < 15; i++) waveRng.push(rng());
    const base = 600 + rng() * 120;
    const gaps = [];
    const nGaps = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < nGaps; i++) gaps.push({ c: 350 + rng() * (W - 700), half: 25 + rng() * 55 });
    let k = 0;
    const heights = waveHeights(() => waveRng[k++], base, amp, gaps);
    fillGround(mat, heights);
    addCaves(mat, rng, heights, n(4 + Math.floor(rng() * 5), c));
    addShelves(mat, rng, heights, n(4 + Math.floor(rng() * 4), c));
    addStacks(mat, rng, n(6 + Math.floor(rng() * 6), c));
  },

  // Einzelne Inseln mit Hafenbecken dazwischen.
  inseln(rng, mat, c) {
    const count = [3, 4, 5, 6][c] + Math.floor(rng() * 2);
    const slot = (W - 120) / count;
    const heights = new Float32Array(W).fill(H + 10);
    for (let i = 0; i < count; i++) {
      const cx = 60 + slot * (i + 0.5) + (rng() - 0.5) * slot * 0.2;
      const half = slot * (0.27 + rng() * 0.12);
      const top = 560 + rng() * 280;
      const f = 0.01 + rng() * 0.02, ph = rng() * 6.28, a = 10 + rng() * 25 * ROUGH[c];
      for (let x = Math.max(0, Math.floor(cx - half - 60)); x < Math.min(W, cx + half + 60); x++) {
        const d = Math.abs(x - cx) / half;
        let h = top + Math.sin(x * f + ph) * a;
        if (d > 1) continue;
        if (d > 0.82) h += (d - 0.82) * 2400; // steile Kaimauer
        heights[x] = Math.min(heights[x], h);
      }
    }
    fillGround(mat, heights, 70);
    addCaves(mat, rng, heights, n(3, c), { depth: 160 });
    addShelves(mat, rng, heights.map((h) => Math.min(h, 900)), n(3, c), { minY: 260 });
    addStacks(mat, rng, n(6, c));
  },

  // Große Stahlregale mit vielen Ebenen.
  regale(rng, mat, c) {
    const heights = waveHeights(rng, 930 + rng() * 50, 0.35, [{ c: 300 + rng() * (W - 600), half: 30 + rng() * 25 }]);
    fillGround(mat, heights, 90);
    const units = [3, 4, 5, 6][c];
    const slot = (W - 200) / units;
    const boxChance = 0.35 + 0.15 * c;
    for (let u = 0; u < units; u++) {
      const w = 150 + rng() * 80;
      const x = 100 + slot * u + (slot - w) * (0.2 + rng() * 0.6);
      const g = Math.max(groundAt(mat, x), groundAt(mat, x + w));
      if (g < 0) continue;
      const top = Math.max(150, g - 380 - rng() * 340);
      fillRect(mat, x, top, 10, g - top + 30, MAT.STEEL);
      fillRect(mat, x + w - 10, top, 10, g - top + 30, MAT.STEEL);
      const step = 100 + rng() * 30 - c * 4;
      for (let y = top; y < g - 70; y += step) {
        fillRect(mat, x, y, w, 12, MAT.STEEL);
        for (let bx = x + 14; bx < x + w - 54; bx += 46) {
          if (rng() < boxChance) fillRect(mat, bx, y - 30, 40, 30, MAT.CARDBOARD);
        }
      }
      if (rng() < 0.5) fillRect(mat, x + 20, top - 34, 44, 34, MAT.CARDBOARD);
    }
    addCaves(mat, rng, heights, n(2, c), { depth: 100 });
    addStacks(mat, rng, n(4, c), { from: 860 });
  },

  // Ein großer Berg in der Mitte.
  paketberg(rng, mat, c) {
    const cx = W / 2 + (rng() - 0.5) * 300;
    const peak = 560 + rng() * 140;
    const sigma = 430 + rng() * 120;
    const flat = waveHeights(rng, 1020, 0.4 * ROUGH[c], [], { min: 120 });
    const heights = flat.map((h, x) => h - peak * Math.exp(-(((x - cx) / sigma) ** 2)));
    fillGround(mat, heights, 300);
    addCaves(mat, rng, heights, n(6, c), { x0: cx - sigma, x1: cx + sigma, depth: 320 });
    if (c >= 2) {
      // Durchgehende Stollen quer durch den Berg
      for (let t = 0; t < c - 1; t++) {
        const ty = 700 + rng() * 250;
        for (let x = cx - sigma * 1.1; x < cx + sigma * 1.1; x += 30) {
          const yy = ty + Math.sin(x * 0.01 + t) * 40;
          if (yy > heights[Math.round(Math.max(0, Math.min(W - 1, x)))] + 40) carveEllipse(mat, x, yy, 34, 24);
        }
      }
    }
    addShelves(mat, rng, heights, n(3, c));
    addStacks(mat, rng, n(6, c));
  },

  // Geschlossenes Gewölbe mit Decke.
  keller(rng, mat, c) {
    const heights = waveHeights(rng, 700 + rng() * 80, 0.6 * ROUGH[c], [{ c: 400 + rng() * (W - 800), half: 30 + rng() * 30 }]);
    fillGround(mat, heights);
    const ph = rng() * 6.28, ph2 = rng() * 6.28;
    for (let x = 0; x < W; x++) {
      const ceil = 80 + Math.sin(x * 0.004 + ph) * 30 + Math.sin(x * 0.013 + ph2) * 14;
      fillRect(mat, x, 0, 1, ceil, MAT.CONCRETE);
    }
    // Eiszapfen von der Decke
    for (let i = 0; i < n(6, c); i++) {
      const x = 100 + rng() * (W - 200);
      const len = 70 + rng() * 170, half = 14 + rng() * 22;
      const top = 60;
      for (let y = top; y < top + len + 60; y++) {
        const hw = half * (1 - (y - top) / (len + 60));
        fillRect(mat, x - hw, y, hw * 2, 1, MAT.CONCRETE);
      }
    }
    // Pfeiler mit Durchgang
    for (let i = 0; i < n(3, c) + 1; i++) {
      const x = 200 + rng() * (W - 400), w = 40 + rng() * 30;
      const g = groundAt(mat, x + w / 2, 200);
      if (g < 0) continue;
      fillRect(mat, x, 60, w, g, MAT.CONCRETE);
      carveEllipse(mat, x + w / 2, g - 30, w, 34);
    }
    addCaves(mat, rng, heights, n(5, c), { depth: 180 });
    addShelves(mat, rng, heights, n(3, c), { minY: 230 });
    addStacks(mat, rng, n(5, c), { from: 200 });
  },

  // Seil-Arena: Kranschiene unter dem Dach, hängende Lasten, kaum Boden.
  kranbahn(rng, mat, c) {
    fillRect(mat, 0, 0, W, 24, MAT.STEEL);
    fillRect(mat, 0, 0, 36, WATER_Y - 80, MAT.CONCRETE);
    fillRect(mat, W - 36, 0, 36, WATER_Y - 80, MAT.CONCRETE);
    // Hängende Lasten an Stangen
    const rods = [7, 9, 12, 15][c];
    for (let i = 0; i < rods; i++) {
      const x = 90 + ((W - 180) * (i + 0.5)) / rods + (rng() - 0.5) * 60;
      const len = 160 + rng() * 420;
      fillRect(mat, x - 3, 24, 6, len, MAT.STEEL);
      if (rng() < 0.5) fillRect(mat, x - 26, 24 + len, 52, 30, MAT.STEEL);
      else fillRect(mat, x - 30, 24 + len, 60, 44, MAT.CARDBOARD);
    }
    // Plattformen zum Stehen (Startplätze)
    const rows = 4, perRow = 4 + c;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < perRow; i++) {
        const w = 80 + rng() * 60;
        const x = 70 + ((W - 140) * (i + 0.5 + (r % 2) * 0.5)) / (perRow + 0.5) - w / 2 + (rng() - 0.5) * 80;
        const y = 380 + r * 180 + (rng() - 0.5) * 80;
        fillRect(mat, x, y, w, 12, MAT.STEEL);
        if (rng() < 0.3 + c * 0.1) fillRect(mat, x + 6 + rng() * (w - 56), y - 34, 44, 34, MAT.CARDBOARD);
      }
    }
    // Schwebende Ankerblöcke
    for (let i = 0; i < n(10, c); i++) {
      const s = 16 + rng() * 16;
      fillRect(mat, 60 + rng() * (W - 120), 140 + rng() * 780, s, s, MAT.STEEL);
    }
  },

  // Seil-Parcours: Regaltürme hängen von der Decke, unten schmale Pfeiler.
  haengeregal(rng, mat, c) {
    const ph = rng() * 6.28;
    for (let x = 0; x < W; x++) {
      const ceil = 90 + Math.sin(x * 0.006 + ph) * 30;
      fillRect(mat, x, 0, 1, ceil, MAT.CONCRETE);
    }
    fillRect(mat, 0, 0, 30, WATER_Y - 60, MAT.CONCRETE);
    fillRect(mat, W - 30, 0, 30, WATER_Y - 60, MAT.CONCRETE);
    // Hängende Türme, abwechselnd lang und kurz
    const towers = [5, 7, 9, 11][c];
    for (let i = 0; i < towers; i++) {
      const w = 34 + rng() * 26;
      const x = 120 + ((W - 240) * (i + 0.5)) / towers - w / 2 + (rng() - 0.5) * 70;
      const len = (i % 2 ? 220 : 420) + rng() * 200;
      fillRect(mat, x + w / 2 - 5, 60, 10, len, MAT.STEEL);
      for (let y = 140; y < len + 40; y += 110 + rng() * 40) {
        const bw = w + 20 + rng() * 30;
        fillRect(mat, x + w / 2 - bw / 2, y, bw, 12, MAT.STEEL);
        if (rng() < 0.55) fillRect(mat, x + w / 2 - 20, y - 30, 40, 30, MAT.CARDBOARD);
      }
    }
    // Pfeiler im Hafenbecken
    const pillars = 6 + c;
    for (let i = 0; i < pillars; i++) {
      const w = 70 + rng() * 50;
      const x = 60 + ((W - 120) * (i + 0.5)) / pillars - w / 2 + (rng() - 0.5) * 60;
      const top = 820 + rng() * 180;
      fillRect(mat, x, top, w, H - top, MAT.CONCRETE);
      fillRect(mat, x, top, w, 26, MAT.CARDBOARD);
      // Ankerblock über jedem Pfeiler, damit man von unten immer wegkommt
      fillRect(mat, x + w / 2 - 14 + (rng() - 0.5) * 120, top - 260 - rng() * 120, 28, 20, MAT.STEEL);
    }
    // Schwebende Querträger
    for (let i = 0; i < n(6, c); i++) {
      fillRect(mat, 80 + rng() * (W - 260), 450 + rng() * 380, 60 + rng() * 60, 10, MAT.GIRDER);
    }
  },
};

// map: Karten-ID aus maps.js, complexity: 0–3. Ohne Angaben = Klassiker, normal.
export function generateTerrain(seed, map = DEFAULT_MAP, complexity = DEFAULT_COMPLEXITY) {
  const rng = mulberry32(seed);
  const mat = new Uint8Array(W * H);
  const gen = GENERATORS[map] || GENERATORS[DEFAULT_MAP];
  const c = Math.max(0, Math.min(3, complexity | 0));
  gen(rng, mat, c);
  return mat;
}

export function isFree(mat, cx, cy, r) {
  for (let dy = -r; dy <= r; dy += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || x >= W || y < 0) continue;
      if (y >= H || mat[y * W + x]) return false;
    }
  }
  return true;
}

// Startpositionen: zufällige Oberflächenpunkte mit Mindestabstand.
export function findSpawns(mat, seed, n) {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const out = [];
  let tries = 0;
  while (out.length < n && tries < 6000) {
    tries++;
    const x = Math.round(60 + rng() * (W - 120));
    const surfaces = [];
    for (let y = 40; y < WATER_Y - 30; y++) {
      if (!mat[y * W + x] && mat[(y + 1) * W + x]) surfaces.push(y);
    }
    if (!surfaces.length) continue;
    const sy = surfaces[Math.floor(rng() * surfaces.length)];
    const cy = sy - WORKER_R - 1;
    if (!isFree(mat, x, cy, WORKER_R) || !isFree(mat, x, cy - 12, WORKER_R)) continue;
    const minDist = tries < 3500 ? 110 : 35;
    if (out.every(([ox, oy]) => Math.hypot(ox - x, oy - cy) > minDist)) out.push([x, cy]);
  }
  while (out.length < n) out.push([W / 2 + out.length * 20, 60]);
  return out;
}
