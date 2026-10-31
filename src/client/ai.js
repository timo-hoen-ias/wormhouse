// KI-Gegner („Bots“). Gesteuert vom Client der Schichtleitung: Der Bot plant
// seinen Zug mit einer vereinfachten Kopie der Spielphysik (Flugbahnen mit
// Wind, springende Granaten, Laser, Luftschlag, Drohne, Stapler, Tresor …) und
// bedient dann dieselbe Spiellogik wie ein Mensch – zielen, aufladen, abfeuern,
// weglaufen. Hilfsmittel (Rucksack, Fallschirm, Inventurfehler) nutzt er, um
// sich in eine bessere Position zu bringen oder in Sicherheit.
// Der Planer ist rein (nur Gelände + Arbeiterliste), damit er sich ohne
// Browser testen lässt (scripts/check.mjs).
import { WORLD_W as W, WORLD_H as H, WATER_Y, GRAVITY, WORKER_R, RETREAT_TIME } from '../shared/constants.js';
import { WEAPON_BY_ID } from '../shared/weapons.js';
import { isFree } from '../shared/terrain-gen.js';

export const PHYS = { step: 1 / 60, windAcc: 160, walkSpeed: 60 };

// Waffen je Schwierigkeitsstufe. Stufe 0 (Dummy) steht nur rum.
const W_AZUBI = ['paket', 'folie', 'hubwagen', 'stempel', 'tacker', 'retoure'];
const W_FACHKRAFT = [...W_AZUBI, 'kiste', 'scanner', 'sendung', 'stapler', 'gas'];
const W_MEISTER = [...W_FACHKRAFT, 'fass', 'drohne', 'palette', 'tresor'];

export const LEVELS = {
  1: { weapons: W_AZUBI, util: [], wind: false, retreat: false, noiseA: 0.06, noiseP: 0.045, angles: 26, powers: 11, think: 1.6, walks: 1, sloppy: 0.35 },
  2: { weapons: W_FACHKRAFT, util: ['fallschirm', 'inventur'], wind: true, retreat: true, noiseA: 0.014, noiseP: 0.012, angles: 38, powers: 17, think: 1.1, walks: 2, sloppy: 0.1 },
  3: { weapons: W_MEISTER, util: ['fallschirm', 'inventur', 'rucksack'], wind: true, retreat: true, noiseA: 0.006, noiseP: 0.008, angles: 52, powers: 23, think: 0.8, walks: 3, sloppy: 0 },
};

// Grobe Planung für „Wie gut wäre es dort drüben?“ (Rucksack-Erkundung)
const SCOUT_WEAPONS = ['paket', 'folie', 'scanner', 'tacker', 'hubwagen', 'stempel'];

// Knappe Munition nicht für Kleinkram verballern: Abzug pro Einsatz, nur wenn
// die Waffe begrenzt ist.
export const AMMO_COST = {
  kiste: 3, retoure: 9, fass: 16, sendung: 6, tacker: 4, stempel: 2,
  stapler: 9, drohne: 10, gas: 9, palette: 18, tresor: 14,
};

// Kollisionsabfragen über eine beliebige solid()-Funktion (gleich wie Terrain).
function terrainFrom(solid, mat = null) {
  const t = {
    mat,
    solid,
    hitsCircle(cx, cy, r) {
      if (solid(cx, cy)) return true;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        if (solid(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) return true;
      }
      return false;
    },
    normalAt(cx, cy, r) {
      let nx = 0, ny = 0;
      const rr = r + 3;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        if (solid(cx + dx * rr, cy + dy * rr)) { nx -= dx; ny -= dy; }
      }
      const l = Math.hypot(nx, ny);
      return l > 0 ? { x: nx / l, y: ny / l } : { x: 0, y: -1 };
    },
  };
  return t;
}

// Gelände-Adapter über die reine Materialmaske (für Tests ohne Canvas).
export function maskTerrain(mat) {
  return terrainFrom((x, y) => {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0) return false;
    if (y >= H) return true;
    return mat[y * W + x] !== 0;
  }, mat);
}

// Gelände mit gedachten Löchern (für den Panzerschrank, der sich durchschlägt).
function holedTerrain(terrain, holes) {
  return terrainFrom((x, y) => {
    for (const h of holes) if ((x - h.x) ** 2 + (y - h.y) ** 2 < h.r * h.r) return false;
    return terrain.solid(x, y);
  });
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
        const px = o.x + n.x, py = o.y + n.y;
        if (!terrain.hitsCircle(px, py, r)) { o.x = px; o.y = py; }
      }
      return n;
    }
    o.x = nx; o.y = ny;
  }
  return null;
}

const outOfWorld = (p, waterY) => p.y > waterY + 4 || p.x < -500 || p.x > W + 500 || p.y > H + 100;
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

function launchPoint(self, facing, aim) {
  const dir = { x: Math.cos(aim) * facing, y: Math.sin(aim) };
  return { dir, x: self.x + dir.x * (WORKER_R + 7), y: self.y + dir.y * (WORKER_R + 7) };
}

function touchesWorker(ctx, x, y, r, age, ignoreSelfFor = 0.25) {
  for (const w of ctx.workers) {
    if (w.dead || (w === ctx.self && age <= ignoreSelfFor)) continue;
    if (Math.hypot(w.x - x, w.y - y) < WORKER_R + r) return true;
  }
  return false;
}

// Paket / Palette: fliegt bis zum ersten Kontakt. Gibt Einschlagpunkt oder null.
export function simBallistic(ctx, x, y, vx, vy, r, useWind, ignoreSelfFor = 0.25) {
  const { terrain, wind, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x, y, vx, vy };
  for (let age = 0; age < 9; age += dt) {
    p.vy += GRAVITY * dt;
    if (useWind) p.vx += wind * PHYS.windAcc * dt;
    const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
    for (let i = 0; i < steps; i++) {
      p.x += (p.vx * dt) / steps;
      p.y += (p.vy * dt) / steps;
      if (terrain.solid(p.x, p.y) || touchesWorker(ctx, p.x, p.y, r, age + dt, ignoreSelfFor)) return { x: p.x, y: p.y };
    }
    if (outOfWorld(p, waterY)) return null;
  }
  return null;
}

// Sendungsverfolgung: fliegt erst normal, peilt dann den Empfänger an.
export function simHoming(ctx, x, y, vx, vy, target) {
  const { terrain, wind, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x, y, vx, vy };
  for (let age = dt; age < 8; age += dt) {
    if (age > 0.35 && age < 3.5) {
      const want = Math.atan2(target.y - p.y, target.x - p.x);
      const cur = Math.atan2(p.vy, p.vx);
      const turn = Math.max(-1, Math.min(1, wrapAngle(want - cur))) * 5 * dt;
      const sp = Math.min(620, Math.max(380, Math.hypot(p.vx, p.vy)) + 300 * dt);
      p.vx = Math.cos(cur + turn) * sp; p.vy = Math.sin(cur + turn) * sp;
    } else {
      p.vy += GRAVITY * dt;
      p.vx += wind * PHYS.windAcc * dt * 0.5;
    }
    const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
    for (let i = 0; i < steps; i++) {
      p.x += (p.vx * dt) / steps;
      p.y += (p.vy * dt) / steps;
      if (terrain.solid(p.x, p.y) || touchesWorker(ctx, p.x, p.y, 3, age)) return { x: p.x, y: p.y };
    }
    if (outOfWorld(p, waterY)) return null;
  }
  return null;
}

// Granate (auch Gasflasche): springt, explodiert nach Ablauf des Zünders.
export function simGrenade(ctx, x, y, vx, vy, wpn, r = 4, friction = 1) {
  const { terrain, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x, y, vx, vy };
  for (let fuse = wpn.fuse; fuse > 0; fuse -= dt) {
    p.vy += GRAVITY * dt;
    if (moveCircle(terrain, p, dt, r, wpn.bounce ?? 0.25)) p.vx *= friction;
    if (outOfWorld(p, waterY)) return null;
  }
  return { x: p.x, y: p.y };
}

// Amok-Stapler: fährt stur geradeaus, klettert Stufen, kehrt an Wänden um.
// Der eigene Arbeiter läuft im Plan weg, zählt also nicht als Hindernis.
export function simWalker(ctx, self, facing) {
  const { terrain, workers, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x: self.x + facing * 16, y: self.y - 4, vx: facing * 60, vy: -80, r: 7, facing, grounded: false, stuck: 0 };
  let fuse = WEAPON_BY_ID.stapler.fuse;
  for (let age = dt; fuse > 0; age += dt, fuse -= dt) {
    if (age > 0.5 && workers.some((w) => !w.dead && w !== self && Math.hypot(w.x - p.x, w.y - p.y) < WORKER_R + p.r + 4)) return { x: p.x, y: p.y };
    if (p.grounded) {
      if (!terrain.hitsCircle(p.x, p.y + 1.5, p.r)) { p.grounded = false; continue; }
      const nx = p.x + p.facing * 1.6;
      let moved = false;
      for (let lift = 0; lift <= 9; lift++) {
        if (!terrain.hitsCircle(nx, p.y - lift, p.r)) {
          p.x = nx; p.y -= lift; moved = true;
          let drop = 0;
          while (drop < 10 && !terrain.hitsCircle(p.x, p.y + 1, p.r)) { p.y += 1; drop++; }
          if (drop >= 10) { p.grounded = false; p.vx = p.facing * 90; p.vy = 0; }
          break;
        }
      }
      if (!moved) {
        p.stuck += 1;
        p.grounded = false;
        p.vy = -300; p.vx = p.facing * 110;
        if (p.stuck > 3) { p.facing *= -1; p.stuck = 0; }
      }
    } else {
      p.vy += GRAVITY * dt;
      const n = moveCircle(terrain, p, dt, p.r, 0.1);
      if (n && n.y < -0.5) { p.grounded = true; p.vx = 0; p.vy = 0; }
    }
    if (outOfWorld(p, waterY)) return null;
  }
  return { x: p.x, y: p.y };
}

// Inventur-Drohne: steigt auf, fliegt geradeaus und lenkt ab switchAt
// Sekunden auf das Ziel zu (so wie BotController.steer es auch tut).
export const DRONE_TURN = 2.8;
export function simDrone(ctx, self, heading, switchAt, target) {
  const { terrain, waterY } = ctx;
  const dt = PHYS.step;
  const p = { x: self.x, y: self.y - 18, heading };
  let fuse = WEAPON_BY_ID.drohne.fuse;
  for (let age = 0; fuse > 0; fuse -= dt) {
    if (age >= switchAt && age >= 0.4) p.heading += droneSteer(p, target) * DRONE_TURN * dt;
    age += dt;
    if (age < 0.4) {
      if (!terrain.hitsCircle(p.x, p.y - 2, 5)) p.y -= 140 * dt;
      continue;
    }
    const vx = Math.cos(p.heading) * 240, vy = Math.sin(p.heading) * 240;
    const steps = Math.max(1, Math.ceil((240 * dt) / 2));
    for (let i = 0; i < steps; i++) {
      p.x += (vx * dt) / steps;
      p.y += (vy * dt) / steps;
      if (terrain.hitsCircle(p.x, p.y, 5) || touchesWorker(ctx, p.x, p.y, 7, age)) return { x: p.x, y: p.y };
    }
    if (p.y < -500) p.heading = Math.PI / 2;
    if (outOfWorld(p, waterY)) return null;
  }
  return { x: p.x, y: p.y };
}

// Lenkrichtung der Drohne: -1 links (gegen den Uhrzeigersinn), +1 rechts, 0 geradeaus.
export function droneSteer(p, target) {
  const da = wrapAngle(Math.atan2(target.y - p.y, target.x - p.x) - p.heading);
  return Math.abs(da) < 0.05 ? 0 : Math.sign(da);
}

// Panzerschrank: fällt senkrecht und explodiert bei jedem Aufschlag (bis zu hits×).
export function simHeavy(ctx, tx, hpLeft) {
  const wpn = WEAPON_BY_ID.tresor;
  const holes = [];
  const terrain = holedTerrain(ctx.terrain, holes);
  const dt = PHYS.step;
  const p = { x: Math.max(20, Math.min(W - 20, tx)), y: -80, vy: 380 };
  const hitOnce = new Set();
  let score = 0, near = Infinity, hits = 0;
  for (let age = 0; age < 12; age += dt) {
    p.vy = Math.min(700, p.vy + GRAVITY * dt);
    const steps = Math.max(1, Math.ceil((p.vy * dt) / 2));
    for (let i = 0; i < steps; i++) {
      p.y += (p.vy * dt) / steps;
      const workerHit = ctx.workers.some((w) => !w.dead && !hitOnce.has(w) && (w !== ctx.self || age > 0.25) && Math.hypot(w.x - p.x, w.y - p.y) < WORKER_R + 9);
      if (p.y > 0 && (terrain.hitsCircle(p.x, p.y, 9) || workerHit)) {
        hits++;
        // Getroffene fliegen weg – für weitere Einschläge nicht mehr da.
        const live = { ...ctx, workers: ctx.workers.filter((w) => !hitOnce.has(w)) };
        const r = blastScore(live, p.x, p.y + 4, wpn.radius, wpn.damage, hpLeft);
        score += r.score; near = Math.min(near, r.near);
        for (const w of ctx.workers) if (Math.hypot(w.x - p.x, w.y - p.y - 4) < wpn.radius + WORKER_R) hitOnce.add(w);
        holes.push({ x: p.x, y: p.y + 4, r: wpn.radius });
        p.vy = 160;
        if (hits >= wpn.hits) return { score, near };
        break;
      }
    }
    if (p.y > ctx.waterY + 4) break;
  }
  return { score, near };
}

// Bewertung einer Explosion: Schaden am Gegner gut, an sich selbst/Kollegen schlecht.
// selfAt: wo der eigene Arbeiter bis zur Explosion hingelaufen ist.
export function blastScore(ctx, x, y, radius, damage, hpLeft = null, selfAt = null) {
  const { workers, self } = ctx;
  const R = radius + WORKER_R;
  let score = 0;
  let near = Infinity;
  for (const w of workers) {
    if (w.dead) continue;
    const pos = w === self && selfAt ? selfAt : w;
    const d = Math.hypot(pos.x - x, pos.y - y);
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

// Wohin kann der Arbeiter in der Rückzugszeit laufen? Ein Ziel je Richtung.
export function escapeSpots(terrain, self, waterY, seconds) {
  const out = [];
  const dist = Math.floor(seconds * PHYS.walkSpeed * 0.85);
  if (dist < 10) return out;
  for (const dir of [-1, 1]) {
    let x = self.x, y = self.y;
    for (let dx = 10; dx <= dist; dx += 10) {
      const g = groundBelow(terrain, x + dir * 10, y, 30, 120);
      if (g == null || g > waterY - 20 || x + dir * 10 < 20 || x + dir * 10 > W - 20) break;
      x += dir * 10; y = g;
    }
    if (x !== self.x) out.push({ dir, x, y });
  }
  return out;
}

// Erste Standposition (Mittelpunkt) unterhalb von y unter x, oder null.
function groundBelow(terrain, x, y, up, down) {
  for (let yy = y - up; yy < y + down; yy += 3) {
    if (terrain.solid(x, yy + WORKER_R)) return terrain.hitsCircle(x, yy - 3, WORKER_R) ? null : yy;
  }
  return null;
}

// Planer als Generator: rechnet in Häppchen, damit das Bild nicht ruckelt.
// level: Stufe (1–3) oder ein eigenes Level-Objekt (Tests, Erkundung).
export function* planTurn(ctx, level, ammoOf) {
  const L = typeof level === 'object' ? level : (LEVELS[level] || LEVELS[2]);
  const { self, workers, terrain } = ctx;
  const enemies = workers.filter((w) => !w.dead && w.team !== self.team);
  if (!enemies.length) return null;
  const waterY = ctx.waterY ?? WATER_Y;
  const planCtx = { ...ctx, waterY, wind: L.wind ? ctx.wind : 0 };
  const has = (id) => L.weapons.includes(id) && WEAPON_BY_ID[id] && ammoOf(id) !== 0;
  const cost = (id) => (ammoOf(id) > 0 ? AMMO_COST[id] || 0 : 0);
  const byDist = [...enemies].sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y));
  const nearest = byDist.slice(0, 4);
  // Nach dem Wurf weglaufen (Fachkraft, Lagermeister)
  const escapes = L.retreat ? escapeSpots(terrain, self, waterY, ctx.retreatTime ?? RETREAT_TIME) : [];
  let best = null;
  const consider = (plan) => {
    plan.score -= cost(plan.weapon);
    if (!best || rank(plan) > rank(best)) best = plan;
  };
  // Explosion bewerten – stehen bleiben oder in die günstigste Richtung weglaufen.
  const blastPlan = (base, hit, radius, damage, canEscape = true) => {
    let r = blastScore(planCtx, hit.x, hit.y, radius, damage);
    let retreat = 0;
    for (const e of canEscape ? escapes : []) {
      const r2 = blastScore(planCtx, hit.x, hit.y, radius, damage, null, e);
      if (r2.score > r.score + 1) { r = r2; retreat = e.dir; }
    }
    consider({ ...base, score: r.score + (base.bonus || 0), near: r.near, hit, retreat });
  };
  let budget = 0;
  const tick = (n = 1) => { budget += n; return budget > 400 ? ((budget = 0), true) : false; };

  // Nahkampf: Hubwagen (schubst weit) und Stempel (haut hoch)
  for (const id of ['hubwagen', 'stempel']) {
    if (!has(id)) continue;
    const wpn = WEAPON_BY_ID[id];
    const inReach = id === 'hubwagen'
      ? (dx, dy) => Math.abs(dx) < 30 && Math.abs(dy) < 20
      : (dx, dy) => Math.abs(dx) < 30 && dy < 16 && dy > -60;
    for (const facing of [-1, 1]) {
      let score = 0;
      for (const o of workers) {
        if (o === self || o.dead) continue;
        const dx = o.x - self.x, dy = o.y - self.y;
        if (dx * facing <= -4 || !inReach(dx, dy)) continue;
        if (o.team !== self.team) {
          score += Math.min(wpn.damage, o.hp) + (o.hp <= wpn.damage ? 25 : 0) + 12;
          // Wer nah am Hafenbecken steht, fliegt womöglich hinein
          if (o.y > waterY - 140) score += 15;
        } else score -= 45;
      }
      if (score > 0) consider({ weapon: id, facing, aim: 0, power: 1, score, near: 0 });
    }
  }

  // Barcode-Scanner und Elektrotacker: Sichtlinie
  if (has('scanner') || has('tacker')) {
    for (const o of nearest) {
      const dx = o.x - self.x, dy = o.y - self.y;
      const facing = dx >= 0 ? 1 : -1;
      const aim = Math.atan2(dy, Math.abs(dx));
      if (Math.abs(aim) > Math.PI / 2) continue;
      const { dir, x: sx, y: sy } = launchPoint(self, facing, aim);
      let x = sx, y = sy, hit = null;
      for (let i = 0; i < 500 && !hit; i++) {
        x += dir.x * 2; y += dir.y * 2;
        if (x < -50 || x > W + 50 || y < -400 || y > waterY) break;
        hit = workers.find((w) => w !== self && !w.dead && Math.hypot(w.x - x, w.y - y) < WORKER_R + 1);
        if (!hit && terrain.solid(x, y)) break;
      }
      if (!hit || hit.team === self.team) continue;
      if (has('scanner')) {
        const dmg = Math.min(hit.hp, 36);
        consider({ weapon: 'scanner', facing, aim, power: 1, score: dmg + (hit.hp <= 36 ? 20 : 0), near: 0 });
      }
      if (has('tacker')) {
        // 12 Klammern mit Streuung: aus der Ferne trifft nur ein Teil.
        const wpn = WEAPON_BY_ID.tacker;
        const d = Math.hypot(hit.x - self.x, hit.y - self.y);
        const frac = Math.min(1, (2 * (WORKER_R + 1)) / Math.max(1, d * wpn.spread * 2));
        const dmg = Math.min(hit.hp, Math.round(wpn.shots * wpn.damage * frac));
        consider({ weapon: 'tacker', facing, aim, power: 1, score: dmg + (dmg >= hit.hp ? 20 : 0), near: 0 });
      }
    }
    if (tick(50)) yield;
  }

  // Sendungsverfolgung: Empfänger anklicken, nach oben abschießen
  if (has('sendung')) {
    const wpn = WEAPON_BY_ID.sendung;
    for (const o of nearest) {
      const target = { x: o.x, y: o.y };
      for (const facing of [-1, 1]) {
        for (const aim of [-1.35, -1.0, -0.65, -0.3, 0]) {
          for (const power of [0.5, 0.8, 1]) {
            const { dir, x, y } = launchPoint(self, facing, aim);
            const sp = 150 + power * 750;
            const hit = simHoming(planCtx, x, y, dir.x * sp, dir.y * sp, target);
            if (hit) blastPlan({ weapon: 'sendung', facing, aim, power, target }, hit, wpn.radius, wpn.damage, false);
            if (tick(6)) yield;
          }
        }
      }
    }
  }

  // Wurf- und Schusswaffen: Winkel × Kraft absuchen
  const sweep = ['paket', 'folie', 'kiste', 'retoure', 'fass'].filter(has);
  for (const id of sweep) {
    const wpn = WEAPON_BY_ID[id];
    const grenade = wpn.kind === 'grenade';
    // Seltene Granaten etwas gröber absuchen, das spart Rechenzeit.
    const coarse = grenade && id !== 'folie' ? 2 : 1;
    const dmgMul = wpn.cluster ? (wpn.clusterType ? 1.8 : 1.4) : 1;
    for (const facing of [-1, 1]) {
      // Nur in Richtungen werfen, in denen auch Gegner stehen (Granaten dürfen beides).
      if (!grenade && !enemies.some((o) => (o.x - self.x) * facing > -40)) continue;
      for (let ai = 0; ai < L.angles; ai += coarse) {
        const aim = -1.45 + (ai / (L.angles - 1)) * 2.6;
        for (let pi = 0; pi < L.powers; pi += coarse) {
          const power = 0.12 + (pi / (L.powers - 1)) * 0.88;
          const { dir, x, y } = launchPoint(self, facing, aim);
          const sp = grenade ? 100 + power * 650 : 120 + power * 900;
          const hit = grenade
            ? simGrenade(planCtx, x, y, dir.x * sp, dir.y * sp, wpn)
            : simBallistic(planCtx, x, y, dir.x * sp, dir.y * sp, 3, true);
          if (hit) {
            if (grenade) blastPlan({ weapon: id, facing, aim, power, bonus: -2 }, hit, wpn.radius, wpn.damage * dmgMul);
            else {
              const r = blastScore(planCtx, hit.x, hit.y, wpn.radius, wpn.damage);
              consider({ weapon: id, facing, aim, power, score: r.score, near: r.near, hit });
            }
          }
          if (tick(grenade ? 3 : 1)) yield;
        }
      }
    }
  }

  // Amok-Stapler: losschicken und weglaufen
  if (has('stapler')) {
    const wpn = WEAPON_BY_ID.stapler;
    for (const facing of [-1, 1]) {
      const hit = simWalker(planCtx, self, facing);
      if (hit) blastPlan({ weapon: 'stapler', facing, aim: 0, power: 1 }, hit, wpn.radius, wpn.damage);
      if (tick(40)) yield;
    }
  }

  // Propangasflasche: nur wenn der Gegner direkt daneben steht und man wegkommt
  if (has('gas') && escapes.length && nearest.some((o) => Math.hypot(o.x - self.x, o.y - self.y) < 110)) {
    const wpn = WEAPON_BY_ID.gas;
    for (const facing of [-1, 1]) {
      const hit = simGrenade(planCtx, self.x + facing * 12, self.y - 4, facing * 40, -60, wpn, 5, 0.85);
      if (hit) blastPlan({ weapon: 'gas', facing, aim: 0, power: 1 }, hit, wpn.radius, wpn.damage);
    }
    if (tick(30)) yield;
  }

  // Inventur-Drohne: losfliegen und ab einem Zeitpunkt aufs Ziel lenken
  if (has('drohne')) {
    const wpn = WEAPON_BY_ID.drohne;
    for (const o of nearest.slice(0, 3)) {
      const target = { x: o.x, y: o.y };
      for (const facing of [-1, 1]) {
        for (const aim of [-1.2, -0.75, -0.35, 0, 0.35]) {
          const heading = Math.atan2(Math.sin(aim), Math.cos(aim) * facing);
          for (const switchAt of [0.4, 0.9, 1.5, 2.3]) {
            const hit = simDrone(planCtx, self, heading, switchAt, target);
            if (hit) blastPlan({ weapon: 'drohne', facing, aim, power: 1, target, switchAt }, hit, wpn.radius, wpn.damage, false);
            if (tick(12)) yield;
          }
        }
      }
    }
  }

  // Paletten-Abwurf: Zielpunkt über dem Gegner absuchen
  if (has('palette')) {
    const wpn = WEAPON_BY_ID.palette;
    for (const o of nearest) {
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
        consider({ weapon: 'palette', facing: 1, aim: 0, power: 1, target: { x: tx, y: o.y }, score, near });
        if (tick(15)) yield;
      }
    }
  }

  // Panzerschrank: senkrecht über dem Gegner fallen lassen
  if (has('tresor')) {
    for (const o of nearest) {
      for (const off of [-20, -8, 0, 8, 20]) {
        const hpLeft = new Map(workers.map((w) => [w, w.hp]));
        const r = simHeavy(planCtx, o.x + off, hpLeft);
        consider({ weapon: 'tresor', facing: 1, aim: 0, power: 1, target: { x: o.x + off, y: o.y }, score: r.score, near: r.near });
        if (tick(25)) yield;
      }
    }
  }
  return best;
}

// Ist es sicher, ein Stück in Richtung dir zu laufen (kein Absturz ins Becken)?
// maxDrop: wie tief es höchstens runtergehen darf (mit Fallschirm deutlich mehr).
export function safeWalk(terrain, self, dir, dist, waterY, maxDrop = 180) {
  for (let dx = 10; dx <= dist; dx += 10) {
    const x = self.x + dir * dx;
    if (x < 20 || x > W - 20) return false;
    let ground = -1;
    for (let y = self.y - 30; y < self.y + maxDrop; y += 3) {
      if (terrain.solid(x, y + WORKER_R)) { ground = y; break; }
    }
    if (ground < 0 || ground > waterY - 20) return false;
  }
  return true;
}

// Alle Stellen, auf denen ein Arbeiter stehen kann (auch auf Regalböden).
export function standSpots(terrain, waterY, step = 24) {
  const out = [];
  for (let x = 24; x < W - 24; x += step) {
    let prevFree = !terrain.solid(x, 0);
    for (let y = 3; y < waterY - 24; y += 3) {
      const s = terrain.solid(x, y);
      if (s && prevFree) {
        const cy = y - WORKER_R - 2;
        if (cy > 20 && !terrain.hitsCircle(x, cy, WORKER_R) && !terrain.hitsCircle(x, cy - 14, WORKER_R)) out.push({ x, y: cy });
      }
      prevFree = !s;
    }
  }
  return out;
}

// Freie Strecke für den Druckluft-Rucksack: hoch auf Reiseflughöhe, rüber, runter.
function jetPathClear(terrain, from, to) {
  const top = Math.min(from.y, to.y) - 50;
  const legs = [[from.x, from.y - 4, from.x, top], [from.x, top, to.x, top], [to.x, top, to.x, to.y - 4]];
  for (const [ax, ay, bx, by] of legs) {
    const d = Math.hypot(bx - ax, by - ay);
    for (let t = 0; t <= d; t += 6) {
      if (terrain.hitsCircle(ax + ((bx - ax) * t) / (d || 1), ay + ((by - ay) * t) / (d || 1), WORKER_R + 2)) return false;
    }
  }
  return top > -150;
}

// Rucksack-Erkundung: An welcher erreichbaren Stelle gäbe es den besten Schuss?
export function* planMove(ctx, level, ammoOf, maxDist = 420) {
  const L = typeof level === 'object' ? level : (LEVELS[level] || LEVELS[2]);
  const { self, workers, terrain } = ctx;
  const waterY = ctx.waterY ?? WATER_Y;
  const enemies = workers.filter((w) => !w.dead && w.team !== self.team);
  if (!enemies.length) return null;
  const nearestEnemy = (p) => Math.min(...enemies.map((o) => Math.hypot(o.x - p.x, o.y - p.y)));
  let spots = standSpots(terrain, waterY).filter((s) => {
    const d = Math.hypot(s.x - self.x, s.y - self.y);
    return d > 60 && Math.abs(s.x - self.x) < maxDist && s.y < waterY - 60
      && workers.every((w) => w.dead || Math.hypot(w.x - s.x, w.y - s.y) > 26);
  });
  // Lieber erhöht und mit Abstand zum Gegner (gut zum Werfen, schlecht zum Treffen-werden)
  spots.sort((a, b) => Math.abs(nearestEnemy(a) - 230) - a.y * 0.15 - (Math.abs(nearestEnemy(b) - 230) - b.y * 0.15));
  yield;
  const quick = { ...L, weapons: L.weapons.filter((id) => SCOUT_WEAPONS.includes(id)), angles: 18, powers: 9, retreat: false };
  let best = null, checked = 0;
  for (const s of spots) {
    if (checked >= 8) break;
    if (!jetPathClear(terrain, self, s)) continue;
    checked++;
    const ghost = { ...self, x: s.x, y: s.y };
    const ghostCtx = { ...ctx, self: ghost, workers: workers.map((w) => (w === self ? ghost : w)) };
    const plan = yield* planTurn(ghostCtx, quick, ammoOf);
    if (plan && (!best || plan.score > best.score)) best = { spot: s, score: plan.score };
    yield;
  }
  return best;
}

// Inventurfehler als Notausgang: weit weg vom Gegner, hoch über dem Wasser.
export function teleportSpot(ctx) {
  const { self, workers, terrain } = ctx;
  const waterY = ctx.waterY ?? WATER_Y;
  const enemies = workers.filter((w) => !w.dead && w.team !== self.team);
  let best = null, bestScore = -Infinity;
  for (const s of standSpots(terrain, waterY, 30)) {
    if (s.y > waterY - 80 || s.x < 40 || s.x > W - 40) continue;
    if (terrain.mat && !isFree(terrain.mat, s.x, s.y, WORKER_R + 1)) continue;
    if (workers.some((w) => !w.dead && Math.hypot(w.x - s.x, w.y - s.y) < 30)) continue;
    const dEnemy = enemies.length ? Math.min(...enemies.map((o) => Math.hypot(o.x - s.x, o.y - s.y))) : 0;
    const score = Math.min(dEnemy, 700) + (waterY - s.y) * 0.3 + Math.random() * 40;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
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
    this.walkDrop = 180;
    this.shotT = 0;
    this.flew = false;
  }

  context(w) {
    const g = this.game;
    return {
      terrain: g.terrain, workers: g.workers, self: w, wind: g.turn?.wind || 0,
      waterY: g.waterY ?? WATER_Y, retreatTime: g.rules?.retreatTime ?? RETREAT_TIME,
    };
  }

  canUse(id) {
    return this.L.util.includes(id) && this.game.ammoOf(id) !== 0;
  }

  update(dt) {
    const g = this.game;
    const w = g.activeWorker();
    if (!w || w.dead) { this.keys.clear(); return; }
    if (g.tp === 'control') { this.steer(); return; }
    if (g.tp === 'retreat') { this.retreatStep(w); return; }
    if (g.tp !== 'aim') { this.keys.clear(); return; }
    const hurry = g.timeLeft() < 4;

    switch (this.phase) {
      case 'think': {
        this.wait -= dt;
        if (!this.planner) this.planner = planTurn(this.context(w), this.levelNo, (id) => g.ammoOf(id));
        const res = this.run(this.planner);
        if (!res.done) break;
        this.planner = null;
        let plan = res.value;
        const good = plan && plan.score >= 12;
        if (!good && !hurry) {
          if (this.walks < this.L.walks && this.startWalk(w)) break;
          if (!this.flew && this.canUse('rucksack') && g.timeLeft() > 14 && w.grounded) {
            this.mover = planMove(this.context(w), this.levelNo, (id) => g.ammoOf(id));
            this.fallback = plan;
            this.phase = 'scout';
            break;
          }
          if ((!plan || plan.score < 10) && this.canUse('inventur') && this.inDanger(w)) {
            const spot = teleportSpot(this.context(w));
            if (spot) plan = { weapon: 'inventur', facing: w.facing, aim: 0, power: 1, target: spot, score: 0, exact: true };
          }
        }
        if (this.wait > 0 && !hurry) { this.pending = plan; this.phase = 'ponder'; break; }
        this.commit(plan);
        break;
      }
      case 'ponder':
        this.wait -= dt;
        if (this.wait <= 0 || hurry) this.commit(this.pending);
        break;
      case 'scout': {
        if (hurry) { this.mover = null; this.commit(this.fallback); break; }
        const res = this.run(this.mover);
        if (!res.done) break;
        this.mover = null;
        this.flew = true;
        const move = res.value;
        const before = this.fallback ? this.fallback.score : 0;
        if (move && move.score >= Math.max(12, before + 8) && g.botSelectWeapon('rucksack')) {
          g.fire(1);
          if (g.mv?.kind === 'jet') { this.dest = move.spot; this.jetT = 0; this.startY = w.y; this.phase = 'jet'; break; }
        }
        this.commit(this.fallback);
        break;
      }
      case 'jet':
        this.jetStep(w, dt, hurry);
        break;
      case 'walk': {
        this.walkT -= dt;
        if (this.walkT <= 0 || !w.grounded || hurry
          || !safeWalk(g.terrain, w, this.walkDir, 20, g.waterY ?? WATER_Y, this.walkDrop)) {
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

  // Generator ein paar Millisekunden pro Bild weiterrechnen lassen.
  run(gen) {
    const t0 = performance.now();
    let res;
    do { res = gen.next(); } while (!res.done && performance.now() - t0 < 6);
    return res;
  }

  inDanger(w) {
    const g = this.game;
    const enemies = g.workers.filter((o) => !o.dead && o.team !== w.team);
    const d = enemies.length ? Math.min(...enemies.map((o) => Math.hypot(o.x - w.x, o.y - w.y))) : Infinity;
    return d < 90 || (w.hp <= 35 && d < 260) || w.y > (g.waterY ?? WATER_Y) - 60;
  }

  // Nach dem Abwurf: vom Sprengsatz weglaufen, solange der Weg sicher ist.
  retreatStep(w) {
    const g = this.game;
    const dir = this.plan?.retreat;
    this.keys.clear();
    if (!dir || !w.grounded) return;
    if (safeWalk(g.terrain, w, dir, 20, g.waterY ?? WATER_Y, 120)) this.keys.add(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
  }

  // Drohne im Flug aufs Ziel lenken.
  steer() {
    const g = this.game;
    this.keys.clear();
    const d = g.walker;
    const p = this.plan;
    if (!d || d.dead || d.type !== 'drohne' || !p?.target || d.age < (p.switchAt ?? 99)) return;
    const s = droneSteer(d, p.target);
    if (s) this.keys.add(s > 0 ? 'ArrowRight' : 'ArrowLeft');
  }

  // Druckluft-Rucksack: auf Reiseflughöhe, rüber zum Ziel, sanft landen.
  jetStep(w, dt, hurry) {
    const g = this.game;
    const T = this.dest;
    this.jetT += dt;
    this.keys.clear();
    if (!g.mv || g.mv.kind !== 'jet') {
      if (w.grounded) { this.phase = 'think'; this.wait = 0.2; }
      return;
    }
    const dx = T.x - w.x;
    const landed = w.grounded && this.jetT > 0.5;
    if (landed && (Math.abs(dx) < 40 || hurry || this.jetT > 7)) {
      g.endUtility();
      this.phase = 'think';
      this.wait = 0.2;
      return;
    }
    const cruise = Math.min(this.startY, T.y) - 50;
    const over = Math.abs(dx) < 14;
    const wantY = over ? T.y : cruise;
    const vyWant = over ? Math.max(-80, Math.min(300, (wantY - w.y) * 2)) : Math.max(-260, Math.min(160, (wantY - w.y) * 2.2));
    if (w.vy > vyWant || w.grounded) this.keys.add('ArrowUp');
    // Erst auf Höhe, dann seitwärts
    if (!over && w.y < cruise + 40) {
      const vxWant = Math.max(-240, Math.min(240, dx * 1.6));
      if (w.vx < vxWant - 15) this.keys.add('ArrowRight');
      else if (w.vx > vxWant + 15) this.keys.add('ArrowLeft');
    }
  }

  startWalk(w) {
    const g = this.game;
    const waterY = g.waterY ?? WATER_Y;
    const enemies = g.workers.filter((o) => !o.dead && o.team !== w.team);
    if (!enemies.length) return false;
    const target = enemies.reduce((a, b) => (Math.hypot(a.x - w.x, a.y - w.y) < Math.hypot(b.x - w.x, b.y - w.y) ? a : b));
    const pref = target.x >= w.x ? 1 : -1;
    for (const dir of [pref, -pref]) {
      let drop = 180;
      if (!safeWalk(g.terrain, w, dir, 90, waterY)) {
        // Mit Planen-Fallschirm darf es auch mal tiefer runtergehen
        if (dir !== pref || !this.canUse('fallschirm') || g.mv || !safeWalk(g.terrain, w, dir, 90, waterY, 700)) continue;
        if (!g.botSelectWeapon('fallschirm')) continue;
        g.fire(1);
        if (g.mv?.kind !== 'chute') continue;
        drop = 700;
      }
      this.walks++;
      this.walkDir = dir;
      this.walkDrop = drop;
      this.walkT = 1.0 + Math.random() * 0.8;
      this.keys.clear();
      this.keys.add(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
      this.phase = 'walk';
      return true;
    }
    this.walks = this.L.walks;
    return false;
  }

  commit(plan) {
    const g = this.game;
    this.keys.clear();
    // Ungeöffneter Fallschirm blockiert sonst das Zugende
    if (g.mv?.kind === 'chute' && !g.mv.open) g.endUtility();
    if (!plan || plan.score < -4) {
      // Nichts Vernünftiges gefunden: lieber Kaffee als Eigentor.
      plan = { weapon: 'pause', facing: g.activeWorker()?.facing || 1, aim: 0, power: 1, score: 0 };
    } else if (Math.random() < this.L.sloppy) {
      // Azubis vertun sich gern mal beim Kraftaufwand.
      plan = { ...plan, power: plan.power * (0.85 + Math.random() * 0.3) };
    }
    if (!plan.exact) {
      plan = {
        ...plan,
        aim: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, plan.aim + jitter(this.L.noiseA))),
        power: Math.max(0.05, Math.min(1, plan.power + jitter(this.L.noiseP))),
      };
      if (plan.target) plan.target = { x: plan.target.x + jitter(this.L.noiseA * 200), y: plan.target.y };
    }
    this.plan = plan;
    if (!g.botSelectWeapon(plan.weapon)) { this.plan = { ...plan, weapon: 'pause' }; g.botSelectWeapon('pause'); }
    this.phase = 'aim';
    this.wait = 0.35 + Math.random() * 0.4;
  }

  fire(p) {
    const g = this.game;
    const wpn = WEAPON_BY_ID[g.weapon];
    this.phase = 'after';
    if (wpn.kind === 'homing') g.homeTarget = { ...p.target };
    if (wpn.charge) { g.charging = true; g.charge = 0; this.phase = 'charge'; return; }
    if (wpn.target) g.fire(1, p.target);
    else g.fire(1);
    // Hat nicht geklappt (z.B. kein Platz zum Teleportieren)? Dann eben Kaffee.
    if (g.tp === 'aim' && wpn.kind !== 'hitscan' && g.botSelectWeapon('pause')) g.fire(1);
  }
}
