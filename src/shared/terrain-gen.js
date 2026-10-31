// Deterministische Level-Generierung aus einem Seed.
// Materialien: 0 Luft, 1 Kartonstapel, 2 Beton, 3 Regalträger (Stahl), 4 Kartonbrücke
import { mulberry32 } from './rng.js';
import { WORLD_W as W, WORLD_H as H, WATER_Y, WORKER_R } from './constants.js';

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

export function generateTerrain(seed) {
  const rng = mulberry32(seed);
  const mat = new Uint8Array(W * H);

  // 1) Höhenprofil aus überlagerten Sinuswellen
  const waves = [];
  for (let i = 0; i < 5; i++) {
    waves.push({
      amp: (40 + rng() * 90) / (i * 0.7 + 1),
      freq: ((i + 1) * (0.7 + rng() * 0.9) * Math.PI * 2) / W,
      phase: rng() * Math.PI * 2,
    });
  }
  const base = 600 + rng() * 120;

  // 2) Lücken zwischen den Inseln (Ladegassen ins Hafenbecken)
  const gaps = [];
  const nGaps = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < nGaps; i++) {
    gaps.push({ c: 350 + rng() * (W - 700), half: 25 + rng() * 55 });
  }

  const heights = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let h = base;
    for (const w of waves) h += w.amp * Math.sin(w.freq * x + w.phase);
    if (x < 140) h += (140 - x) * 4;
    if (x > W - 140) h += (x - (W - 140)) * 4;
    for (const g of gaps) {
      const d = Math.abs(x - g.c) - g.half;
      if (d < 0) h = H + 10;
      else if (d < 50) h += (50 - d) * 5;
    }
    heights[x] = Math.max(220, Math.min(H + 10, h));
  }

  for (let x = 0; x < W; x++) {
    const top = Math.round(heights[x]);
    const concreteDepth = 120 + Math.sin(x * 0.02) * 20;
    for (let y = Math.max(0, top); y < H; y++) {
      mat[y * W + x] = y - top > concreteDepth ? 2 : 1;
    }
  }

  // 3) Höhlen
  const nCaves = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < nCaves; i++) {
    const cx = 150 + rng() * (W - 300);
    const cy = heights[Math.round(cx)] + 70 + rng() * 220;
    if (cy > WATER_Y - 40) continue;
    carveEllipse(mat, cx, cy, 40 + rng() * 80, 22 + rng() * 40);
  }

  // 4) Freischwebende Regalböden (Stahlträger)
  const nShelves = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < nShelves; i++) {
    const w = 120 + rng() * 150;
    const x = 80 + rng() * (W - 160 - w);
    const ground = Math.min(heights[Math.round(x)], heights[Math.round(x + w)], WATER_Y);
    const y = Math.max(140, ground - 130 - rng() * 230);
    fillRect(mat, x, y, w, 12, 3);
  }

  // 5) Kartonstapel auf dem Boden
  const nStacks = 6 + Math.floor(rng() * 6);
  for (let i = 0; i < nStacks; i++) {
    const x = 120 + rng() * (W - 240);
    let sy = -1;
    for (let y = 100; y < WATER_Y; y++) {
      if (mat[y * W + Math.round(x)]) { sy = y; break; }
    }
    if (sy < 0) continue;
    const rows = 1 + Math.floor(rng() * 3);
    const cols = 1 + Math.floor(rng() * 2);
    for (let r = 0; r < rows; r++) {
      const c = Math.max(1, cols - (r > 0 && rng() < 0.5 ? 1 : 0));
      const off = (r % 2) * 10;
      fillRect(mat, x + off, sy - (r + 1) * 34 + 8, c * 44, 34, 1);
    }
  }

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
