// Selbsttest fürs Spanngurt-Seil: Pendel, Pumpen, Wickeln, Reißen.
import { ROPE, newRope, fireHook, hookStep, ropeStep, wrappedLength } from '../src/shared/rope.js';
import { GRAVITY, WORKER_R } from '../src/shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('✗', msg); } else console.log('✓', msg); };

const W = 1600, H = 1000;
function makeTerrain() {
  const mat = new Uint8Array(W * H);
  const t = {
    mat,
    fill(x0, y0, x1, y1, v = 1) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mat[y * W + x] = v; },
    solid(x, y) { x |= 0; y |= 0; if (x < 0 || x >= W || y < 0) return false; if (y >= H) return true; return mat[y * W + x] !== 0; },
    hitsCircle(cx, cy, r) {
      if (t.solid(cx, cy)) return true;
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; if (t.solid(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) return true; }
      return false;
    },
    normalAt(cx, cy, r) {
      let nx = 0, ny = 0;
      for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a); if (t.solid(cx + dx * (r + 3), cy + dy * (r + 3))) { nx -= dx; ny -= dy; } }
      const l = Math.hypot(nx, ny); return l > 0 ? { x: nx / l, y: ny / l } : { x: 0, y: -1 };
    },
  };
  return t;
}
const bounds = { w: W, waterY: H - 20 };
const DT = 1 / 60;

function attach(t, w, ang) {
  const mv = newRope();
  fireHook(mv, w.x, w.y, Math.cos(ang), Math.sin(ang));
  let r = null;
  for (let i = 0; i < 60 && !r; i++) r = hookStep(mv, w, DT, t, bounds);
  return { mv, r };
}
const run = (t, mv, w, secs, input = {}) => {
  let broke = false;
  for (let i = 0; i < secs * 60 && !broke; i++) broke = ropeStep(mv, w, DT, { dir: 0, reel: 0, ...input }, t, GRAVITY, WORKER_R).broke;
  return broke;
};

// 1) Haken schießt nach oben an die Decke und hält
{
  const t = makeTerrain();
  t.fill(0, 0, W, 100); // Decke
  const w = { x: 800, y: 400, vx: 0, vy: 0 };
  const { mv, r } = attach(t, w, -Math.PI / 2 - 0.5);
  ok(r === 'attach' && mv.pts.length === 1 && mv.shots === 1, 'Haken hakt an der Decke ein');
  const L = mv.len;
  // Pendel: Energie bleibt grob erhalten (schwingt fast wieder auf Starthöhe)
  const y0 = w.y; let minY = Infinity, maxX = -Infinity, minX = Infinity;
  for (let i = 0; i < 240; i++) {
    ropeStep(mv, w, DT, { dir: 0, reel: 0 }, t, GRAVITY, WORKER_R);
    const d = Math.hypot(w.x - mv.pts[0].x, w.y - mv.pts[0].y);
    if (d > L + 1.5) { ok(false, `Gurt dehnt sich nicht (d=${d.toFixed(1)} > ${L.toFixed(1)})`); break; }
    if (i > 40) minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x); minX = Math.min(minX, w.x);
  }
  ok(maxX - minX > L * 0.8, `Pendel schwingt auf beide Seiten (${(maxX - minX).toFixed(0)} px)`);
  ok(minY < y0 + 25, `Pendel verliert kaum Energie (Gipfel ${(minY - y0).toFixed(1)} px unter Start)`);
}

// 2) Einholen macht schneller (Drehimpuls), Schwungtaste baut Schwung auf
{
  const t = makeTerrain();
  t.fill(0, 0, W, 100);
  const mk = () => ({ x: 800, y: 420, vx: 0, vy: 0 });
  const a = mk(), b = mk();
  const ra = attach(t, a, -Math.PI / 2), rb = attach(t, b, -Math.PI / 2);
  a.vx = b.vx = 300;
  run(t, ra.mv, a, 0.15); run(t, rb.mv, b, 0.15);
  run(t, ra.mv, a, 0.4); run(t, rb.mv, b, 0.4, { reel: -1 });
  const sa = Math.hypot(a.vx, a.vy), sb = Math.hypot(b.vx, b.vy);
  ok(sb > sa * 1.15, `Einholen beschleunigt den Schwung (${sa.toFixed(0)} → ${sb.toFixed(0)} px/s)`);
  ok(rb.mv.len < ra.mv.len - 60, 'Einholen verkürzt den Gurt');
  const c = mk(); const rc = attach(t, c, -Math.PI / 2);
  let maxX = c.x;
  for (let i = 0; i < 8 * 60; i++) {
    const dir = c.vx >= 0 ? 1 : -1; // im Takt mitschwingen
    ropeStep(rc.mv, c, DT, { dir, reel: 0 }, t, GRAVITY, WORKER_R);
    maxX = Math.max(maxX, c.x);
  }
  ok(maxX - 800 > rc.mv.len * 0.7, `←/→ schaukelt das Pendel auf (Ausschlag ${(maxX - 800).toFixed(0)} px)`);
  const d = mk(); const rd = attach(t, d, -Math.PI / 2);
  run(t, rd.mv, d, 3, { reel: 1 });
  ok(rd.mv.len <= ROPE.MAX + 0.01 && rd.mv.len > ROPE.MAX - 5, `Ausfahren endet bei der Maximallänge (${rd.mv.len.toFixed(0)})`);
}

// 3) Gurt wickelt sich um eine Kante und wieder ab
{
  const t = makeTerrain();
  t.fill(0, 0, W, 100);
  t.fill(760, 100, 800, 300); // Pfeiler unter der Decke links vom Haken
  const w = { x: 900, y: 380, vx: -700, vy: 0 };
  const { mv } = attach(t, w, -Math.PI / 2 - 0.15);
  let wrapped = 0;
  for (let i = 0; i < 90; i++) { ropeStep(mv, w, DT, { dir: 0, reel: 0 }, t, GRAVITY, WORKER_R); wrapped = Math.max(wrapped, mv.pts.length); }
  ok(wrapped >= 2, `Gurt wickelt sich um die Pfeilerkante (${wrapped - 1} Knick)`);
  ok(!t.hitsCircle(w.x, w.y, WORKER_R - 1), 'Arbeiter steckt nicht im Pfeiler');
  // zurückschwingen lassen
  let unwrapped = false;
  for (let i = 0; i < 300 && !unwrapped; i++) { ropeStep(mv, w, DT, { dir: 1, reel: 0 }, t, GRAVITY, WORKER_R); unwrapped = mv.pts.length === 1; }
  ok(unwrapped, 'Gurt wickelt sich beim Zurückschwingen wieder ab');
  ok(wrappedLength(mv) === 0, 'Ohne Knick keine gewickelte Länge');
}

// 4) Haken reißt aus, wenn das Gelände weggesprengt wird; Haken verfehlt ins Leere
{
  const t = makeTerrain();
  t.fill(700, 0, 900, 100);
  const w = { x: 800, y: 350, vx: 0, vy: 0 };
  const { mv } = attach(t, w, -Math.PI / 2);
  ok(!run(t, mv, w, 0.3), 'Haken hält, solange das Regal steht');
  t.fill(700, 0, 900, 100, 0); // weggesprengt
  ok(run(t, mv, w, 0.1) && mv.pts === null, 'Haken reißt aus, wenn das Gelände darüber weg ist');
  const w2 = { x: 300, y: 500, vx: 0, vy: 0 };
  const m2 = attach(t, w2, -Math.PI / 2);
  ok(m2.r === 'miss' && m2.mv.shots === 0, 'Haken ins Leere: nichts hakt ein, kein Versuch verbraucht');
}

// 5) Vom Boden aus: Haken schräg nach oben, Einholen hebt ab, dann schwingt man
{
  const t = makeTerrain();
  t.fill(0, 600, W, H); // Boden
  t.fill(1000, 300, 1200, 330); // Regalbrett schräg oben
  const w = { x: 800, y: 600 - WORKER_R - 1, vx: 0, vy: 0 };
  const { mv, r } = attach(t, w, Math.atan2(310 - w.y, 1050 - w.x));
  ok(r === 'attach', 'Haken hakt schräg oben am Regalbrett ein');
  const x0 = w.x;
  run(t, mv, w, 0.5, { dir: 1 });
  ok(w.x > x0 + 3, `Am Boden rutscht man mit → am Gurt entlang (${(w.x - x0).toFixed(0)} px)`);
  run(t, mv, w, 1.2, { reel: -1 });
  ok(w.y < 600 - WORKER_R - 40, `Einholen zieht den Arbeiter vom Boden hoch (y=${w.y.toFixed(0)})`);
  ok(!t.hitsCircle(w.x, w.y, WORKER_R - 1), 'Arbeiter steckt nicht im Gelände');
}

if (fails) { console.error(`${fails} Fehler (Seil)`); process.exit(1); }
console.log('Seil: alles gut.');
