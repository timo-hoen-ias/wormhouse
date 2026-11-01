// Zerstörbares Gelände: Materialmaske für die Physik + Canvas-Textur fürs Rendering.
import * as THREE from 'three';
import { WORLD_W as W, WORLD_H as H } from '../shared/constants.js';
import { generateTerrain, MAT } from '../shared/terrain-gen.js';
import { hash2 } from '../shared/rng.js';

const GIRDER_LEN = 130;
const GIRDER_THICK = 12;

export class Terrain {
  constructor(seed, map = null) {
    this.mat = generateTerrain(seed, map?.id, map?.complexity);
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.img = this.ctx.createImageData(W, H);
    this.paintRect(0, 0, W, H);
    this.ctx.putImageData(this.img, 0, 0);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.anisotropy = 4;
  }

  solid(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0) return false;
    if (y >= H) return true;
    return this.mat[y * W + x] !== 0;
  }

  // Kreis kollidiert mit Gelände?
  hitsCircle(cx, cy, r) {
    if (this.solid(cx, cy)) return true;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      if (this.solid(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) return true;
    }
    return false;
  }

  // Oberflächennormale (zeigt aus dem Gelände heraus).
  normalAt(cx, cy, r) {
    let nx = 0, ny = 0;
    const rr = r + 3;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      if (this.solid(cx + dx * rr, cy + dy * rr)) { nx -= dx; ny -= dy; }
    }
    const l = Math.hypot(nx, ny);
    return l > 0 ? { x: nx / l, y: ny / l } : { x: 0, y: -1 };
  }

  // ---------- Textur ----------
  colorAt(m, x, y) {
    const n = hash2(x, y);
    const mi = y * W + x;
    // Oberkante hervorheben
    const top = y > 2 && (!this.mat[mi - W] || !this.mat[mi - 2 * W]);
    let r, g, b;
    if (m === MAT.CARDBOARD || m === MAT.GIRDER) {
      const bw = 48, bh = 36;
      const row = Math.floor(y / bh);
      const bx = (x + (row % 2) * 24) % bw;
      const by = y % bh;
      const boxId = hash2(Math.floor((x + (row % 2) * 24) / bw), row);
      const shade = 0.85 + boxId * 0.25;
      r = 185 * shade; g = 138 * shade; b = 84 * shade;
      if (m === MAT.GIRDER) { r = 214; g = 170; b = 110; }
      if (bx < 2 || by < 2) { r *= 0.6; g *= 0.6; b *= 0.6; } // Kantenfuge
      else if (Math.abs(bx - 24) < 4 && m === MAT.CARDBOARD) { r = 222; g = 200; b = 150; } // Klebeband
      else if (boxId > 0.82 && bx > 8 && bx < 18 && by > 8 && by < 14) { r = 40; g = 40; b = 40; } // Etikett
      const k = 0.92 + n * 0.12;
      r *= k; g *= k; b *= k;
    } else if (m === MAT.CONCRETE) {
      const v = 95 + n * 30 + (hash2(x >> 3, y >> 3) - 0.5) * 18;
      r = v; g = v * 1.01; b = v * 1.05;
    } else {
      // Regalträger: orange mit dunkler Lochung
      r = 232; g = 102; b = 28;
      if ((x % 16) < 3 && (y % 12) > 3 && (y % 12) < 8) { r = 60; g = 30; b = 20; }
      const k = 0.92 + n * 0.1;
      r *= k; g *= k; b *= k;
    }
    if (top) {
      if (m === MAT.CONCRETE || m === MAT.CARDBOARD) {
        // Gelb-schwarze Warnmarkierung an der Oberkante
        const stripe = Math.floor((x + y) / 10) % 2 === 0;
        if (stripe) { r = 250; g = 200; b = 20; } else { r = 30; g = 30; b = 30; }
      } else { r = Math.min(255, r * 1.3); g = Math.min(255, g * 1.3); b = Math.min(255, b * 1.3); }
    }
    return [r, g, b];
  }

  paintRect(x0, y0, w, h) {
    const d = this.img.data;
    const x1 = Math.min(W, x0 + w), y1 = Math.min(H, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) {
        const i = y * W + x;
        const m = this.mat[i];
        const p = i * 4;
        if (!m) { d[p + 3] = 0; continue; }
        const [r, g, b] = this.colorAt(m, x, y);
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
  }

  flush(x0, y0, w, h) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    w = Math.min(W - x0, Math.ceil(w)); h = Math.min(H - y0, Math.ceil(h));
    if (w <= 0 || h <= 0) return;
    this.ctx.putImageData(this.img, 0, 0, x0, y0, w, h);
    // Mit Teil-Upload (Renderer setzt `dirty`) nur das geänderte Rechteck zur GPU
    // schicken – ein Komplett-Upload der 2400×1200-Textur ruckelt auf Handys.
    if (this.dirty) this.dirty.push([x0, y0, w, h]);
    else this.texture.needsUpdate = true;
  }

  // ---------- Zerstörung / Bauen ----------
  carve(cx, cy, r) {
    const d = this.img.data;
    const R = r + 6;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        const i = y * W + x;
        if (dist <= r) {
          this.mat[i] = 0;
          d[i * 4 + 3] = 0;
        } else if (dist <= R && this.mat[i]) {
          // Verkohlter Rand
          const k = 0.45 + 0.4 * ((dist - r) / 6);
          d[i * 4] *= k; d[i * 4 + 1] *= k; d[i * 4 + 2] *= k;
        }
      }
    }
    this.flush(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  girderCorners(cx, cy, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const hl = GIRDER_LEN / 2, ht = GIRDER_THICK / 2;
    return [[-hl, -ht], [hl, -ht], [hl, ht], [-hl, ht]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
  }

  addGirder(cx, cy, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const hl = GIRDER_LEN / 2, ht = GIRDER_THICK / 2;
    const ext = hl + ht;
    const x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(W - 1, Math.ceil(cx + ext));
    const y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(H - 1, Math.ceil(cy + ext));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const u = dx * c + dy * s, v = -dx * s + dy * c;
        if (Math.abs(u) <= hl && Math.abs(v) <= ht) this.mat[y * W + x] = MAT.GIRDER;
      }
    }
    // Neu einfärben (inkl. Oberkanten in der Umgebung)
    this.paintRect(x0, y0 - 2, x1 - x0 + 1, y1 - y0 + 5);
    this.flush(x0, y0 - 2, x1 - x0 + 1, y1 - y0 + 5);
  }

  applyOp(op) {
    if (op.k === 'boom') this.carve(op.x, op.y, op.r);
    else if (op.k === 'girder') this.addGirder(op.x, op.y, op.a);
  }
}

export { GIRDER_LEN, GIRDER_THICK };
