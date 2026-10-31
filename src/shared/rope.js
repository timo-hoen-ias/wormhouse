// Spanngurt-Seil (Ninja-Seil) nach Worms-Armageddon-Vorbild.
// Reine Physik ohne DOM/three.js, damit Client und Selbsttest dieselbe Logik nutzen.
// terrain: { solid(x, y), hitsCircle(x, y, r), normalAt(x, y, r) }
// mv (Seilzustand): { pts: [{x, y, side}] | null, len, hook: {...} | null, shots }
//   pts[0] = Haken, weitere Punkte = Kanten, um die sich der Gurt gewickelt hat.
//   len = freie Länge vom letzten Knickpunkt bis zum Arbeiter.

export const ROPE = {
  MAX: 470, // Gesamtlänge des Gurts inkl. gewickelter Stücke
  MIN: 14,
  SHOTS: 5, // so oft hakt der Gurt pro Zug ein (danach erst wieder landen)
  HOOK_SPEED: 2100, // Haken fliegt sehr schnell, aber sichtbar
  REEL: 240, // px/s ein-/ausfahren
  SWING: 330, // seitlicher Schwungschub (px/s²)
  MAX_SPEED: 1050,
  BOUNCE: 0.3,
  SUB: 4, // Unterschritte je Simulationsschritt
  MAX_WRAPS: 16,
};

const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

// Liegt Gelände in der Nähe? (trägt der Haken / die Kante noch)
export function nearSolid(terrain, x, y, r) {
  if (terrain.solid(x, y)) return true;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (terrain.solid(x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
  }
  return false;
}

// Länge der um Kanten gewickelten Gurtstücke
export function wrappedLength(mv) {
  let s = 0;
  for (let i = 1; i < (mv.pts?.length || 0); i++) s += dist(mv.pts[i - 1].x, mv.pts[i - 1].y, mv.pts[i].x, mv.pts[i].y);
  return s;
}

export function newRope() {
  return { kind: 'rope', pts: null, len: 0, hook: null, shots: 0 };
}

// Haken abschießen: Richtung (dx, dy) normiert, Start am Arbeiter
export function fireHook(mv, x, y, dx, dy) {
  mv.pts = null;
  mv.hook = { x, y, dx, dy, dist: 0 };
}

// Haken fliegt bis zum ersten Gelände. Rückgabe: 'attach' | 'miss' | null (fliegt noch)
export function hookStep(mv, w, dt, terrain, bounds) {
  const h = mv.hook;
  const steps = Math.ceil((ROPE.HOOK_SPEED * dt) / 2);
  for (let i = 0; i < steps; i++) {
    h.x += h.dx * 2; h.y += h.dy * 2; h.dist += 2;
    if (terrain.solid(h.x, h.y)) {
      // Ein Stück zurück, damit der Ankerpunkt frei liegt
      let ax = h.x, ay = h.y;
      for (let j = 0; j < 4 && terrain.solid(ax, ay); j++) { ax -= h.dx; ay -= h.dy; }
      mv.pts = [{ x: ax, y: ay, side: 0 }];
      mv.len = Math.max(ROPE.MIN, Math.min(ROPE.MAX, dist(w.x, w.y, ax, ay)));
      mv.hook = null;
      mv.shots++;
      return 'attach';
    }
    if (h.dist > ROPE.MAX || h.x < -20 || h.x > bounds.w + 20 || h.y < -200 || h.y > bounds.waterY) {
      mv.hook = null;
      return 'miss';
    }
  }
  return null;
}

// Kreis bewegen, an Gelände abprallen und daran entlangrutschen
function moveCircle(terrain, o, h, r, e) {
  let impact = 0, left = h;
  for (let tries = 0; tries < 3 && left > 1e-6; tries++) {
    const d = Math.hypot(o.vx, o.vy) * left;
    const steps = Math.max(1, Math.ceil(d / 1.5));
    const sx = (o.vx * left) / steps, sy = (o.vy * left) / steps;
    let hit = false;
    for (let i = 0; i < steps; i++) {
      const nx = o.x + sx, ny = o.y + sy;
      if (!terrain.hitsCircle(nx, ny, r)) { o.x = nx; o.y = ny; continue; }
      const n = terrain.normalAt(nx, ny, r);
      const vn = o.vx * n.x + o.vy * n.y;
      if (vn < 0) {
        // Abprall nur bei echten Stößen, sonst einfach an der Fläche entlang
        const k = -vn > 60 ? 1 + e : 1;
        o.vx -= k * vn * n.x;
        o.vy -= k * vn * n.y;
        const tx = -n.y, ty = n.x;
        const vt = o.vx * tx + o.vy * ty;
        const f = Math.min(1, 2.5 * h);
        o.vx -= vt * f * tx; o.vy -= vt * f * ty;
        impact = Math.max(impact, -vn);
      }
      // Den Teil des Schritts entlang der Fläche trotzdem gehen (leicht angehoben)
      const sn = sx * n.x + sy * n.y;
      const tsx = sx - sn * n.x, tsy = sy - sn * n.y;
      for (const lift of [0, 0.5, 1, 2]) {
        const cx = o.x + tsx + n.x * lift, cy = o.y + tsy + n.y * lift;
        if (!terrain.hitsCircle(cx, cy, r)) { o.x = cx; o.y = cy; break; }
      }
      left *= 1 - (i + 1) / steps;
      hit = true;
      break;
    }
    if (!hit) break;
  }
  return impact;
}

// Erster Geländepunkt auf der Strecke a -> b (ohne die Endpunkte)
function segmentHit(terrain, ax, ay, bx, by) {
  const d = dist(ax, ay, bx, by);
  if (d < 8) return null;
  const ux = (bx - ax) / d, uy = (by - ay) / d;
  for (let t = 5; t < d - 5; t += 1.5) {
    const x = ax + ux * t, y = ay + uy * t;
    if (terrain.solid(x, y)) return { x, y, ux, uy };
  }
  return null;
}

const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - by) - (by - ay) * (cx - bx);

// Gurt um Kanten wickeln bzw. wieder abwickeln
function wrap(mv, w, terrain, px, py) {
  // Abwickeln: Arbeiter ist wieder auf die andere Seite der Kante geschwungen
  while (mv.pts.length > 1) {
    const P = mv.pts[mv.pts.length - 1], A = mv.pts[mv.pts.length - 2];
    // kleine Hysterese, damit der Gurt an der Kante nicht flattert
    if ((cross(A.x, A.y, P.x, P.y, w.x, w.y) * P.side) / (dist(A.x, A.y, P.x, P.y) || 1) > -0.5) break;
    mv.pts.pop();
    mv.len += dist(A.x, A.y, P.x, P.y);
  }
  // Aufwickeln: Gelände zwischen letztem Knickpunkt und Arbeiter
  for (let n = 0; n < 3 && mv.pts.length < ROPE.MAX_WRAPS; n++) {
    const P = mv.pts[mv.pts.length - 1];
    let hit = segmentHit(terrain, P.x, P.y, w.x, w.y);
    if (!hit) return;
    // Ersten Berührpunkt zwischen alter und neuer Position suchen -> Knick sitzt genau an der Kante
    if (!segmentHit(terrain, P.x, P.y, px, py)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 10; i++) {
        const m = (lo + hi) / 2;
        if (segmentHit(terrain, P.x, P.y, px + (w.x - px) * m, py + (w.y - py) * m)) hi = m; else lo = m;
      }
      hit = segmentHit(terrain, P.x, P.y, px + (w.x - px) * hi, py + (w.y - py) * hi) || hit;
    }
    px = w.x; py = w.y;
    let kx = hit.x - hit.ux * 1.5, ky = hit.y - hit.uy * 1.5;
    const nn = terrain.normalAt(hit.x, hit.y, 2);
    for (let i = 0; i < 8 && terrain.solid(kx, ky); i++) { kx += nn.x; ky += nn.y; }
    if (terrain.solid(kx, ky)) return;
    const seg = dist(P.x, P.y, kx, ky);
    if (seg < 2 || seg >= mv.len - 1) return;
    // Wickelrichtung = Drehsinn der Bewegung um den Knickpunkt
    // (der Knick liegt fast auf der Linie, die Geometrie allein ist zu ungenau)
    let c = (kx - P.x) * w.vy - (ky - P.y) * w.vx;
    if (Math.abs(c) < 1e-6) c = cross(P.x, P.y, kx, ky, w.x, w.y);
    if (Math.abs(c) < 1e-9) return;
    mv.pts.push({ x: kx, y: ky, side: c > 0 ? 1 : -1 });
    mv.len -= seg;
  }
}

// Halten Haken und Kanten noch? Weggesprengte Kanten lösen sich, ohne Haken reißt der Gurt.
function checkSupport(mv, terrain) {
  if (!nearSolid(terrain, mv.pts[0].x, mv.pts[0].y, 5)) return false;
  for (let i = 1; i < mv.pts.length; i++) {
    if (!nearSolid(terrain, mv.pts[i].x, mv.pts[i].y, 6)) {
      while (mv.pts.length > i) {
        const P = mv.pts.pop(), A = mv.pts[mv.pts.length - 1];
        mv.len += dist(A.x, A.y, P.x, P.y);
      }
      mv.len = Math.min(mv.len, ROPE.MAX);
      break;
    }
  }
  return true;
}

// Ein Simulationsschritt am Seil.
// input: { dir: -1|0|1 (schwingen), reel: -1 einfahren | 0 | 1 ausfahren }
// Rückgabe: { broke, impact }
export function ropeStep(mv, w, dt, input, terrain, gravity, r) {
  const h = dt / ROPE.SUB;
  let impact = 0;
  for (let s = 0; s < ROPE.SUB; s++) {
    if (!checkSupport(mv, terrain)) { mv.pts = null; return { broke: true, impact }; }
    let P = mv.pts[mv.pts.length - 1];

    // Ein-/Ausfahren. Einholen erhält den Drehimpuls -> man wird schneller (Pumpen wie in WA).
    if (input.reel) {
      const maxLen = Math.max(ROPE.MIN, ROPE.MAX - wrappedLength(mv));
      const old = mv.len;
      mv.len = Math.max(ROPE.MIN, Math.min(maxLen, mv.len + input.reel * ROPE.REEL * h));
      const d = dist(P.x, P.y, w.x, w.y);
      if (mv.len !== old && d > 1 && d >= old - 1) {
        const ux = (w.x - P.x) / d, uy = (w.y - P.y) / d;
        const vr = w.vx * ux + w.vy * uy;
        const k = Math.min(1.08, old / mv.len);
        const tvx = (w.vx - vr * ux) * k, tvy = (w.vy - vr * uy) * k;
        w.vx = tvx + vr * ux; w.vy = tvy + vr * uy;
      }
    }

    // Schwerkraft und Schwungschub
    w.vy += gravity * h;
    if (input.dir) w.vx += input.dir * ROPE.SWING * h;
    const sp = Math.hypot(w.vx, w.vy);
    if (sp > ROPE.MAX_SPEED) { w.vx *= ROPE.MAX_SPEED / sp; w.vy *= ROPE.MAX_SPEED / sp; }

    const px = w.x, py = w.y;
    impact = Math.max(impact, moveCircle(terrain, w, h, r, ROPE.BOUNCE));
    wrap(mv, w, terrain, px, py);
    P = mv.pts[mv.pts.length - 1];

    // Gurt ist straff: nicht weiter weg als len (durchhängen darf er)
    const dx = w.x - P.x, dy = w.y - P.y, d = Math.hypot(dx, dy);
    if (d > mv.len && d > 0.01) {
      const ux = dx / d, uy = dy / d;
      const nx = P.x + ux * mv.len, ny = P.y + uy * mv.len;
      if (!terrain.hitsCircle(nx, ny, r)) { w.x = nx; w.y = ny; }
      else if (input.reel > 0) mv.len = d; // Ausfahren gegen den Boden: Gurt folgt nur
      const vr = w.vx * ux + w.vy * uy;
      if (vr > 0) { w.vx -= vr * ux; w.vy -= vr * uy; }
    }
  }
  return { broke: false, impact };
}
