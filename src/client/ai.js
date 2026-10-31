// KI-Gegner („Bots“). Gesteuert vom Client der Schichtleitung: Der Bot plant
// seinen Zug mit einer vereinfachten Kopie der Spielphysik (Flugbahnen mit
// Wind, springende Granaten, Laser, Luftschlag) und bedient dann dieselbe
// Spiellogik wie ein Mensch – zielen, aufladen, abfeuern.
// Der Planer ist rein (nur Gelände + Arbeiterliste), damit er sich ohne
// Browser testen lässt (scripts/check.mjs).
import { WORLD_W as W, WORLD_H as H, WATER_Y, GRAVITY, WORKER_R } from '../shared/constants.js';
import { WEAPON_BY_ID } from '../shared/weapons.js';

export const PHYS = { step: 1 / 60, windAcc: 160 };

export const LEVELS = {
  1: { weapons: ['paket', 'folie'], wind: false, noiseA: 0.06, noiseP: 0.045, angles: 26, powers: 11, think: 1.6, walks: 1, sloppy: 0.35 },
  2: { weapons: ['paket', 'folie', 'kiste', 'scanner', 'hubwagen'], wind: true, noiseA: 0.014, noiseP: 0.012, angles: 38, powers: 17, think: 1.1, walks: 2, sloppy: 0.1 },
  3: { weapons: ['paket', 'folie', 'kiste', 'scanner', 'hubwagen', 'palette'], wind: true, noiseA: 0.006, noiseP: 0.008, angles: 52, powers: 23, think: 0.8, walks: 3, sloppy: 0 },
};

// Gelände-Adapter über die reine Materialmaske (für Tests ohne Canvas).
export function maskTerrain(mat) {
  const t = {
    mat,
    solid(x, y) {
      x |= 0; y |= 0;
      if (x < 0 || x >= W || y < 0) return false;
      if (y >= H) return true;
      return mat[y * W + x] !== 0;
    },
    hitsCircle(cx, cy, r) {
      if (t.solid(cx, cy)) return true;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        if (t.solid(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) return true;
      }
      return false;
    },
    normalAt(cx, cy, r) {
      let nx = 0, ny = 0;
      const rr = r + 3;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        if (t.solid(cx + dx * rr, cy + dy * rr)) { nx -= dx; ny -= dy; }
      }
      const l = Math.hypot(nx, ny);
      return l > 0 ? { x: nx / l, y: ny / l } : { x: 0, y: -1 };
    },
  };
  return t;
}

// Gleiche Kollisionsauflösung wie Game.moveCircle.
function moveCircle(terrain, o, dt, r, e) {
  const dist = Math.hypot(o.vx, o.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / 2));
  const sx = (o.vx * dt) / steps, sy = (o.vy * dt) / steps;
  for (let i = 0; i < steps; i++) {
    const nx = o.x + sx, ny = o.y + sy;
    if (terrain.hitsCircle(nx, ny, r)) {
      const n = terrain.normalAt(nx, ny, r);
      const vn = o.vx * n.x + o.vy * n.y;
      if (vn < 0) {
        o.vx -= (1 + e) * vn * n.x;
        o.vy -= (1 + e) * vn * n.y;
        const tx = -n.y, ty = n.x;
        const vt = o.vx * tx + o.vy * ty;
        o.vx -= vt * 0.25 * tx;
        o.vy -= vt * 0.25 * ty;
      } else {
        o.vx *= 0.5; o.vy *= 0.5;
      }
      return true;
    }
    o.x = nx; o.y = ny;
  }
  return false;
}

const outOfWorld = (p, waterY) => p.y > waterY + 4 || p.x < -500 || p.x > W + 500 || p.y > H + 100;

function launchPoint(self, facing, aim) {
  const dir = { x: Math.cos(aim) * facing, y: Math.sin(aim) };
  return { dir, x: self.x + dir.x * (WORKER_R + 7), y: self.y + dir.y * (WORKER_R + 7) };
}

// Paket / Palette: fliegt bis zum ersten Kontakt. Gibt Einschlagpunkt oder null.
export function simBallistic(ctx, x, y, vx, vy, r, useWind, ignoreSelfFor = 0.25) {
  const { terrain, workers, self, wind, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x, y, vx, vy };
  for (let age = 0; age < 9; age += dt) {
    p.vy += GRAVITY * dt;
    if (useWind) p.vx += wind * PHYS.windAcc * dt;
    const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
    for (let i = 0; i < steps; i++) {
      p.x += (p.vx * dt) / steps;
      p.y += (p.vy * dt) / steps;
      if (terrain.solid(p.x, p.y)) return { x: p.x, y: p.y };
      for (const w of workers) {
        if (w.dead || (w === self && age + dt <= ignoreSelfFor)) continue;
        if (Math.hypot(w.x - p.x, w.y - p.y) < WORKER_R + r) return { x: p.x, y: p.y };
      }
    }
    if (outOfWorld(p, waterY)) return null;
  }
  return null;
}

// Granate: springt, explodiert nach Ablauf des Zünders.
export function simGrenade(ctx, x, y, vx, vy, wpn) {
  const { terrain, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x, y, vx, vy };
  for (let fuse = wpn.fuse; fuse > 0; fuse -= dt) {
    p.vy += GRAVITY * dt;
    moveCircle(terrain, p, dt, 4, wpn.bounce ?? 0.25);
    if (outOfWorld(p, waterY)) return null;
  }
  return { x: p.x, y: p.y };
}

// Bewertung einer Explosion: Schaden am Gegner gut, an sich selbst/Kollegen schlecht.
export function blastScore(ctx, x, y, radius, damage, hpLeft = null) {
  const { workers, self } = ctx;
  const R = radius + WORKER_R;
  let score = 0;
  let near = Infinity;
  for (const w of workers) {
    if (w.dead) continue;
    const d = Math.hypot(w.x - x, w.y - y);
    const enemy = w.team !== self.team;
    if (enemy) near = Math.min(near, d);
    if (d >= R) continue;
    const hp = hpLeft ? hpLeft.get(w) : w.hp;
    if (hp <= 0) continue;
    const dmg = Math.round(damage * (0.3 + 0.7 * (1 - d / R)));
    const real = Math.min(dmg, hp);
    const kill = dmg >= hp;
    if (hpLeft) hpLeft.set(w, hp - real);
    if (enemy) score += real + (kill ? 25 : 0) + (w.y > ctx.waterY - 90 ? 6 : 0);
    else score -= (w === self ? 2.2 : 1.4) * real + (kill ? (w === self ? 200 : 50) : 0);
  }
  return { score, near };
}

const rank = (r) => r.score - (r.score <= 0 ? Math.min(r.near, 2000) * 0.01 : 0);

// Planer als Generator: rechnet in Häppchen, damit das Bild nicht ruckelt.
export function* planTurn(ctx, levelNo, ammoOf) {
  const L = LEVELS[levelNo] || LEVELS[2];
  const { self, workers, terrain } = ctx;
  const enemies = workers.filter((w) => !w.dead && w.team !== self.team);
  if (!enemies.length) return null;
  const planCtx = { ...ctx, wind: L.wind ? ctx.wind : 0 };
  const has = (id) => L.weapons.includes(id) && WEAPON_BY_ID[id] && ammoOf(id) !== 0;
  let best = null;
  const consider = (plan) => {
    if (!best || rank(plan) > rank(best)) best = plan;
  };
  let budget = 0;
  const tick = (n = 1) => { budget += n; return budget > 400 ? ((budget = 0), true) : false; };

  // Nahkampf
  if (has('hubwagen')) {
    for (const facing of [-1, 1]) {
      let score = 0;
      for (const o of enemies) {
        const dx = o.x - self.x;
        if (dx * facing > -4 && Math.abs(dx) < 30 && Math.abs(o.y - self.y) < 20) score += Math.min(30, o.hp) + (o.hp <= 30 ? 25 : 0) + 12;
      }
      for (const o of workers) {
        if (o === self || o.dead || o.team !== self.team) continue;
        const dx = o.x - self.x;
        if (dx * facing > -4 && Math.abs(dx) < 32 && Math.abs(o.y - self.y) < 22) score -= 45;
      }
      if (score > 0) consider({ weapon: 'hubwagen', facing, aim: 0, power: 1, score, near: 0 });
    }
  }

  // Barcode-Scanner: Sichtlinie
  if (has('scanner')) {
    for (const o of enemies) {
      const dx = o.x - self.x, dy = o.y - self.y;
      const facing = dx >= 0 ? 1 : -1;
      const aim = Math.atan2(dy, Math.abs(dx));
      if (Math.abs(aim) > Math.PI / 2) continue;
      const { dir, x: sx, y: sy } = launchPoint(self, facing, aim);
      let x = sx, y = sy, hit = null;
      for (let i = 0; i < 500 && !hit; i++) {
        x += dir.x * 2; y += dir.y * 2;
        if (x < -50 || x > W + 50 || y < -400 || y > ctx.waterY) break;
        hit = workers.find((w) => w !== self && !w.dead && Math.hypot(w.x - x, w.y - y) < WORKER_R + 1);
        if (!hit && terrain.solid(x, y)) break;
      }
      if (hit && hit.team !== self.team) {
        const dmg = Math.min(hit.hp, 36);
        consider({ weapon: 'scanner', facing, aim, power: 1, score: dmg + (hit.hp <= 36 ? 20 : 0), near: 0 });
      }
    }
    if (tick(50)) yield;
  }

  // Wurf- und Schusswaffen: Winkel × Kraft absuchen
  const sweep = [];
  if (has('paket')) sweep.push('paket');
  if (has('folie')) sweep.push('folie');
  if (has('kiste')) sweep.push('kiste');
  for (const id of sweep) {
    const wpn = WEAPON_BY_ID[id];
    const grenade = wpn.kind === 'grenade';
    for (const facing of [-1, 1]) {
      // Nur in Richtungen werfen, in denen auch Gegner stehen (Granaten dürfen beides).
      if (!grenade && !enemies.some((o) => (o.x - self.x) * facing > -40)) continue;
      for (let ai = 0; ai < L.angles; ai++) {
        const aim = -1.45 + (ai / (L.angles - 1)) * 2.6;
        for (let pi = 0; pi < L.powers; pi++) {
          const power = 0.12 + (pi / (L.powers - 1)) * 0.88;
          const { dir, x, y } = launchPoint(self, facing, aim);
          const sp = grenade ? 100 + power * 650 : 120 + power * 900;
          const hit = grenade
            ? simGrenade(planCtx, x, y, dir.x * sp, dir.y * sp, wpn)
            : simBallistic(planCtx, x, y, dir.x * sp, dir.y * sp, 3, true);
          if (hit) {
            const r = blastScore(planCtx, hit.x, hit.y, wpn.radius, wpn.damage * (wpn.cluster ? 1.4 : 1));
            consider({ weapon: id, facing, aim, power, score: r.score - (grenade ? 2 : 0), near: r.near, hit });
          }
          if (tick(grenade ? 3 : 1)) yield;
        }
      }
    }
  }

  // Paletten-Abwurf: Zielpunkt über dem Gegner absuchen
  if (has('palette')) {
    const wpn = WEAPON_BY_ID.palette;
    for (const o of enemies) {
      for (let off = -140; off <= 140; off += 20) {
        const tx = o.x + off;
        const hpLeft = new Map(workers.map((w) => [w, w.hp]));
        let score = 0, near = Infinity;
        for (let i = 0; i < wpn.count; i++) {
          const hit = simBallistic(planCtx, tx + (i - (wpn.count - 1) / 2) * 34, -40 - i * 25, 0, 200, 5, true, 0);
          if (!hit) continue;
          const r = blastScore(planCtx, hit.x, hit.y, wpn.radius, wpn.damage, hpLeft);
          score += r.score; near = Math.min(near, r.near);
        }
        // Luftschlag ist selten – nur wenn er sich richtig lohnt.
        consider({ weapon: 'palette', facing: 1, aim: 0, power: 1, target: { x: tx, y: o.y }, score: score - 18, near });
        if (tick(15)) yield;
      }
    }
  }
  return best;
}

// Ist es sicher, ein Stück in Richtung dir zu laufen (kein Absturz ins Becken)?
export function safeWalk(terrain, self, dir, dist, waterY) {
  for (let dx = 10; dx <= dist; dx += 10) {
    const x = self.x + dir * dx;
    if (x < 20 || x > W - 20) return false;
    let ground = -1;
    for (let y = self.y - 30; y < self.y + 180; y += 3) {
      if (terrain.solid(x, y + WORKER_R)) { ground = y; break; }
    }
    if (ground < 0 || ground > waterY - 20) return false;
  }
  return true;
}

const jitter = (amp) => (Math.random() * 2 - 1) * amp;

// Steuert einen KI-Zug in der laufenden Spiellogik.
export class BotController {
  constructor(game, level) {
    this.game = game;
    this.levelNo = level;
    this.L = LEVELS[level] || LEVELS[2];
    this.keys = new Set();
    this.phase = 'think';
    this.wait = this.L.think * (0.7 + Math.random() * 0.6);
    this.planner = null;
    this.plan = null;
    this.walks = 0;
    this.walkT = 0;
    this.shotT = 0;
  }

  context(w) {
    const g = this.game;
    return { terrain: g.terrain, workers: g.workers, self: w, wind: g.turn?.wind || 0, waterY: g.waterY ?? WATER_Y };
  }

  update(dt) {
    const g = this.game;
    const w = g.activeWorker();
    if (!w || w.dead) { this.keys.clear(); return; }
    if (g.tp !== 'aim') { this.keys.clear(); return; }
    const hurry = g.timeLeft() < 4;

    switch (this.phase) {
      case 'think': {
        this.wait -= dt;
        if (!this.planner) this.planner = planTurn(this.context(w), this.levelNo, (id) => g.ammoOf(id));
        const t0 = performance.now();
        let res;
        do { res = this.planner.next(); } while (!res.done && performance.now() - t0 < 6);
        if (!res.done) break;
        this.planner = null;
        const plan = res.value;
        const good = plan && plan.score >= 12;
        if (!good && this.walks < this.L.walks && !hurry && this.startWalk(w)) break;
        if (this.wait > 0 && !hurry) { this.planner = null; this.pending = plan; this.phase = 'ponder'; break; }
        this.commit(plan);
        break;
      }
      case 'ponder':
        this.wait -= dt;
        if (this.wait <= 0 || hurry) this.commit(this.pending);
        break;
      case 'walk': {
        this.walkT -= dt;
        if (this.walkT <= 0 || !w.grounded || hurry
          || !safeWalk(g.terrain, w, this.walkDir, 20, g.waterY ?? WATER_Y)) {
          this.keys.clear();
          if (w.grounded || hurry) { this.phase = 'think'; this.wait = 0.3; }
        }
        break;
      }
      case 'aim': {
        const p = this.plan;
        w.facing = p.facing;
        const d = p.aim - w.aim;
        const stepA = 1.6 * dt;
        w.aim = Math.abs(d) <= stepA ? p.aim : w.aim + Math.sign(d) * stepA;
        if (w.aim === p.aim) {
          this.wait -= dt;
          if (this.wait <= 0 || hurry) this.fire(p);
        }
        break;
      }
      case 'charge': {
        if (!g.charging) { this.phase = 'after'; break; }
        if (g.charge >= this.plan.power) g.fire(this.plan.power);
        break;
      }
      case 'after': {
        // Barcode-Scanner hat einen zweiten Schuss
        if (g.weapon === 'scanner' && g.shotsLeft > 0) {
          this.shotT += dt;
          if (this.shotT > 0.6) { this.shotT = 0; g.fire(1); }
        }
        break;
      }
    }
  }

  startWalk(w) {
    const g = this.game;
    const enemies = g.workers.filter((o) => !o.dead && o.team !== w.team);
    if (!enemies.length) return false;
    const target = enemies.reduce((a, b) => (Math.hypot(a.x - w.x, a.y - w.y) < Math.hypot(b.x - w.x, b.y - w.y) ? a : b));
    const pref = target.x >= w.x ? 1 : -1;
    for (const dir of [pref, -pref]) {
      if (safeWalk(g.terrain, w, dir, 90, g.waterY ?? WATER_Y)) {
        this.walks++;
        this.walkDir = dir;
        this.walkT = 1.0 + Math.random() * 0.8;
        this.keys.clear();
        this.keys.add(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
        this.phase = 'walk';
        return true;
      }
    }
    this.walks = this.L.walks;
    return false;
  }

  commit(plan) {
    const g = this.game;
    this.keys.clear();
    if (!plan || plan.score < -4) {
      // Nichts Vernünftiges gefunden: lieber Kaffee als Eigentor.
      plan = { weapon: 'pause', facing: g.activeWorker()?.facing || 1, aim: 0, power: 1, score: 0 };
    } else if (Math.random() < this.L.sloppy) {
      // Azubis vertun sich gern mal beim Kraftaufwand.
      plan = { ...plan, power: plan.power * (0.85 + Math.random() * 0.3) };
    }
    plan = {
      ...plan,
      aim: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, plan.aim + jitter(this.L.noiseA))),
      power: Math.max(0.05, Math.min(1, plan.power + jitter(this.L.noiseP))),
    };
    if (plan.target) plan.target = { x: plan.target.x + jitter(this.L.noiseA * 200), y: plan.target.y };
    this.plan = plan;
    g.botSelectWeapon(plan.weapon);
    this.phase = 'aim';
    this.wait = 0.35 + Math.random() * 0.4;
  }

  fire(p) {
    const g = this.game;
    const wpn = WEAPON_BY_ID[g.weapon];
    if (wpn.target) { g.fire(1, p.target); this.phase = 'after'; return; }
    if (wpn.charge) { g.charging = true; g.charge = 0; this.phase = 'charge'; return; }
    g.fire(1);
    this.phase = 'after';
  }
}
