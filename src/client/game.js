// Spiellogik auf dem Client.
// Der Client des aktiven Spielers simuliert den Zug (Bewegung, Projektile, Schaden)
// und streamt Snapshots. Alle anderen Clients stellen die Snapshots dar.
import {
  WORLD_W as W, WORLD_H as H, WATER_Y, GRAVITY, WORKER_R, MAX_HP, RETREAT_TIME,
} from '../shared/constants.js';
import { WEAPON_BY_ID, PROJECTILE_TYPES } from '../shared/weapons.js';
import { findSpawns, isFree } from '../shared/terrain-gen.js';
import { Terrain } from './terrain.js';
import { fallDamage } from '../shared/fall.js';
import { sfx, setLoop } from './audio.js';

const STEP = 1 / 60;
const WIND_ACC = 160;
const SNAP_INTERVAL = 50;

const r1 = (v) => Math.round(v * 10) / 10;

export class Game {
  constructor({ renderer, net, ui }) {
    this.renderer = renderer;
    this.net = net;
    this.ui = ui;
    this.state = null;
    this.myPid = null;
    this.terrain = null;
    this.gameNo = -1;
    this.opGame = -1;
    this.opLog = [];
    this.appliedOps = 0;
    this.workers = [];
    this.projectiles = [];
    this.turnN = -1;
    this.myTurn = false;
    this.tp = 'wait'; // aim | retreat | resolve | done | wait
    this.weapon = 'paket';
    this.aimSpeed = 1.6;
    this.charge = 0;
    this.charging = false;
    this.keys = new Set();
    this.mouse = { x: W / 2, y: H / 2 };
    this.girderAngle = 0;
    this.used = [];
    this.shotsLeft = 0;
    this.acc = 0;
    this.lastSnap = 0;
    this.settleTime = 0;
    this.resolveTime = 0;
    this.retreatEnd = 0;
    this.turnLocalEnd = 0;
    this.manualCam = false;
    this.remote = { weapon: null, charge: 0 };
    this.walker = null;
    this.graves = [];
    this.lastFuse = new Map();
  }

  // ---------- Hilfen ----------
  get teams() { return this.state?.teams || []; }
  get turn() { return this.state?.turn || null; }

  activeWorker() {
    const t = this.turn;
    if (!t) return null;
    return this.workers.find((w) => w.id === t.worker) || null;
  }

  myTeamIndex() {
    return this.teams.findIndex((t) => t.pid === this.myPid);
  }

  ammoOf(id) {
    const t = this.teams[this.turn?.team];
    if (!t) return 0;
    return t.ammo[id] ?? 0;
  }

  timeLeft() {
    return Math.max(0, (this.turnLocalEnd - performance.now()) / 1000);
  }

  retreatLeft() {
    return Math.max(0, (this.retreatEnd - performance.now()) / 1000);
  }

  // ---------- Server-Nachrichten ----------
  onState(state) {
    const prevTurn = this.turnN;
    const prevPhase = this.state?.phase;
    this.state = state;

    if (state.phase === 'lobby') {
      this.myTurn = false;
      this.tp = 'wait';
      this.stopLoops();
      return;
    }

    if (this.gameNo !== state.game || !this.terrain) {
      this.newGame(state);
    }

    const t = state.turn;
    if (state.phase === 'playing' && t && t.n !== prevTurn) {
      this.beginTurn(state);
    } else if (state.phase === 'ended' && prevPhase !== 'ended') {
      this.syncWorkersFromServer(state.workers);
      this.myTurn = false;
      this.tp = 'wait';
      this.projectiles = [];
      this.stopLoops();
      const mine = this.myTeamIndex();
      if (mine >= 0 && state.winner !== mine) sfx.lose(); else sfx.win();
    }
  }

  newGame(state) {
    this.gameNo = state.game;
    this.terrain = new Terrain(state.seed);
    const spawns = findSpawns(this.terrain.mat, state.seed, state.workers.length);
    this.spawns = spawns;
    this.renderer.setTerrain(this.terrain);
    this.renderer.clearWorkers();
    this.workers = state.workers.map((sw, i) => ({
      id: sw.id, team: sw.team, name: sw.name,
      x: sw.x ?? spawns[i][0], y: sw.y ?? spawns[i][1],
      vx: 0, vy: 0, hp: sw.hp, dead: sw.dead,
      facing: (sw.x ?? spawns[i][0]) < W / 2 ? 1 : -1, aim: -0.4,
      grounded: false, walking: false, still: 0,
      shownHp: sw.hp, shownDead: sw.dead,
      airTop: null, stepT: 0, stepAlt: false,
    }));
    this.graves = [];
    for (const w of this.workers) { w.rx = w.x; w.ry = w.y; }
    this.projectiles = [];
    this.turnN = -1;
    if (this.opGame !== state.game) { this.opGame = state.game; this.opLog = []; }
    this.appliedOps = 0;
    this.applyPendingOps();
    // Gleich zu Spielbeginn auf den Boden fallen lassen (nur Optik bei Zuschauern).
    this.ui.onNewGame?.();
  }

  syncWorkersFromServer(list) {
    for (const sw of list) {
      const w = this.workers.find((x) => x.id === sw.id);
      if (!w) continue;
      if (sw.x != null) { w.x = sw.x; w.y = sw.y; }
      w.hp = sw.hp;
      w.dead = sw.dead;
      w.vx = 0; w.vy = 0;
      w.grounded = false;
      w.walking = false;
    }
  }

  beginTurn(state) {
    const t = state.turn;
    this.turnN = t.n;
    this.syncWorkersFromServer(state.workers);
    this.projectiles = [];
    this.walker = null;
    this.charge = 0;
    this.charging = false;
    this.used = [];
    this.settleTime = 0;
    this.resolveTime = 0;
    this.manualCam = false;
    this.turnLocalEnd = performance.now() + (state.turnMsLeft ?? 45000);
    this.retreatEnd = 0;
    const team = state.teams[t.team];
    this.myTurn = !!team && team.pid === this.myPid;
    this.tp = this.myTurn ? 'aim' : 'wait';
    const w = this.activeWorker();
    if (this.myTurn) {
      if ((team.ammo[this.weapon] ?? 0) === 0) this.weapon = 'paket';
      this.shotsLeft = WEAPON_BY_ID[this.weapon].shots || 1;
      this.ui.toast(`Du bist dran! ${w ? w.name : ''} wartet auf Anweisungen.`, team.color);
      sfx.turn();
    } else if (team) {
      this.ui.toast(`${team.name} ist dran${w ? ` (${w.name})` : ''}`, team.color);
    }
    this.ui.refreshWeapons();
  }

  onOps(game, from, ops) {
    if (game !== this.opGame) { this.opGame = game; this.opLog = []; }
    this.opLog.length = Math.min(this.opLog.length, from);
    for (let i = 0; i < ops.length; i++) this.opLog[from + i] = ops[i];
    if (this.terrain && this.gameNo === game && this.appliedOps > this.opLog.length) {
      // Sollte nicht passieren – zur Sicherheit Terrain neu aufbauen.
      this.newGame(this.state);
      return;
    }
    this.applyPendingOps();
  }

  onOp(game, i, op, fx) {
    if (game !== this.opGame) { this.opGame = game; this.opLog = []; }
    this.opLog[i] = op;
    const before = this.appliedOps;
    this.applyPendingOps();
    if (this.appliedOps > before) {
      if (op.k === 'boom') {
        if (fx) { this.renderer.explosion(op.x, op.y, op.r); sfx.boom(op.r / 50); }
        else this.renderer.puff(op.x, op.y, '#b98b54');
      } else if (op.k === 'girder') sfx.build();
    }
  }

  applyPendingOps() {
    if (!this.terrain || this.gameNo !== this.opGame) return;
    while (this.appliedOps < this.opLog.length && this.opLog[this.appliedOps]) {
      this.terrain.applyOp(this.opLog[this.appliedOps]);
      this.appliedOps++;
    }
  }

  onSnap(msg) {
    if (this.myTurn || !this.turn || msg.n !== this.turn.n) return;
    for (const a of msg.w) {
      const w = this.workers.find((x) => x.id === a[0]);
      if (!w) continue;
      w.x = a[1]; w.y = a[2]; w.hp = a[3]; w.dead = !!a[4];
      w.facing = a[5]; w.aim = a[6]; w.walking = !!a[7]; w.grounded = !!a[8];
    }
    this.projectiles = msg.p.map((a) => ({ type: PROJECTILE_TYPES[a[0]], x: a[1], y: a[2], rot: a[3], facing: a[4], fuse: a[5] ?? null }));
    this.remote.weapon = msg.wp;
    this.remote.charge = msg.ch;
    this.remote.aiming = !!msg.am;
    this.remote.retreat = msg.rt || 0;
    if (msg.tl != null) this.turnLocalEnd = performance.now() + msg.tl * 1000;
  }

  onFx(msg) {
    this.playFx(msg);
  }

  playFx(f) {
    switch (f.k) {
      case 'laser': this.renderer.laser(f.x1, f.y1, f.x2, f.y2); sfx.laser(); break;
      case 'puff': this.renderer.puff(f.x, f.y, f.c); break;
      case 'splash': this.renderer.splash(f.x); sfx.splash(); break;
      case 'sfx': sfx[f.s]?.(); break;
      case 'msg': this.ui.toast(f.text, f.color); break;
      case 'anim': this.renderer.workerAnim(f.id, f.a); break;
      case 'fall': {
        // Harte Landung: Staub, Schwindel, „Autsch!“
        this.renderer.dust(f.x, f.y + WORKER_R, Math.min(2, 0.6 + f.d / 25));
        this.renderer.workerLand(f.id, true);
        this.renderer.floatText(f.x, f.y - 45, f.d >= 30 ? 'AUTSCH!!' : 'Autsch!', '#ffb74d');
        sfx.oof();
        break;
      }
    }
  }

  fx(f) {
    this.playFx(f);
    this.net.send({ t: 'fx', ...f });
  }

  sendOp(op, fx = false) {
    // Lokal sofort anwenden, dann an alle anderen schicken.
    this.opLog[this.appliedOps] = op;
    this.opLog.length = this.appliedOps + 1;
    this.terrain.applyOp(op);
    this.appliedOps++;
    this.net.send({ t: 'op', n: this.turnN, op: { ...op, fx } });
  }

  // ---------- Eingabe ----------
  canAct() {
    return this.myTurn && (this.tp === 'aim' || this.tp === 'retreat');
  }

  selectWeapon(id) {
    if (!this.myTurn || this.tp !== 'aim' || this.charging) return;
    const wpn = WEAPON_BY_ID[id];
    if (!wpn || this.ammoOf(id) === 0) return;
    if (this.weapon === 'scanner' && this.shotsLeft < (WEAPON_BY_ID.scanner.shots)) return;
    this.weapon = id;
    this.shotsLeft = wpn.shots || 1;
    this.ui.refreshWeapons();
  }

  keyDown(code) {
    this.keys.add(code);
    if (!this.myTurn) return;
    const w = this.activeWorker();
    if (!w || w.dead) return;
    const wpn = WEAPON_BY_ID[this.weapon];
    if (code === 'Space') {
      if (this.walker && !this.walker.dead) { this.explodeProjectile(this.walker); return; }
      if (this.tp !== 'aim' || wpn.target) return;
      if (wpn.charge) { if (!this.charging) { this.charging = true; this.charge = 0; } }
      else this.fire(1);
    } else if (code === 'Enter' && this.canAct() && w.grounded) {
      w.vx = w.facing * 160; w.vy = -250; w.grounded = false; this.fx({ k: 'sfx', s: 'jump' });
    } else if (code === 'Backspace' && this.canAct() && w.grounded) {
      w.vx = -w.facing * 70; w.vy = -390; w.grounded = false; this.fx({ k: 'sfx', s: 'jump' }); this.fx({ k: 'anim', id: w.id, a: 'flip' });
    } else if (code === 'Tab') {
      // nichts – reserviert
    }
  }

  keyUp(code) {
    this.keys.delete(code);
    if (code === 'Space' && this.charging) this.fire(this.charge);
  }

  click(x, y) {
    if (!this.myTurn || this.tp !== 'aim') return false;
    const wpn = WEAPON_BY_ID[this.weapon];
    if (!wpn.target) return false;
    this.fire(1, { x, y });
    return true;
  }

  // ---------- Hauptschleife ----------
  update(dt) {
    if (!this.terrain || !this.state || this.state.phase === 'lobby') return;
    if (this.myTurn && this.tp !== 'done') {
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.simStep(STEP);
      }
      const now = performance.now();
      if (now - this.lastSnap > SNAP_INTERVAL) {
        this.lastSnap = now;
        this.sendSnap();
      }
    } else {
      this.acc = 0;
    }
    // Weiche Darstellung (bei Zuschauern interpoliert)
    const k = this.myTurn ? 1 : 1 - Math.exp(-dt * 18);
    for (const w of this.workers) {
      if (w.rx == null || Math.hypot(w.x - w.rx, w.y - w.ry) > 200) { w.rx = w.x; w.ry = w.y; }
      w.rx += (w.x - w.rx) * k;
      w.ry += (w.y - w.ry) * k;
      if (w.hp < w.shownHp) {
        this.renderer.floatText(w.x, w.y, `-${Math.round(w.shownHp - w.hp)}`, this.teams[w.team]?.color || '#fff');
        this.renderer.workerHurt(w.id);
        if (!w.dead) sfx.ouch();
      }
      w.shownHp = w.hp;
      if (w.dead && !w.shownDead) {
        this.renderer.puff(w.x, w.y, '#ffffff');
        if (w.y < WATER_Y) {
          this.renderer.explosion(w.x, w.y, 14);
          this.graves.push({ id: w.id, team: w.team, x: w.x, y: w.y, vy: 0, tilt: (Math.random() - 0.5) * 0.3 });
        }
        this.ui.toast(`${w.name} wurde gekündigt!`, this.teams[w.team]?.color);
        sfx.death();
      }
      w.shownDead = w.dead;
      if (!w.dead) this.trackMotion(w, dt);
    }
    this.updateGraves(dt);
    this.updateLoops();
  }

  // Landungen und Schritte aus der dargestellten Bewegung ableiten –
  // so hören und sehen auch Zuschauer alles, ohne zusätzliche Netzwerknachrichten.
  trackMotion(w, dt) {
    if (!w.grounded) {
      w.airTop = w.airTop == null ? w.y : Math.min(w.airTop, w.y);
      w.stepT = 0;
    } else if (w.airTop != null) {
      const fell = w.y - w.airTop;
      w.airTop = null;
      if (fell > 14) {
        this.renderer.workerLand(w.id, false);
        if (fell > 40) this.renderer.dust(w.x, w.y + WORKER_R, 0.3);
        sfx.land();
      }
    }
    if (w.walking && w.grounded) {
      w.stepT -= dt;
      if (w.stepT <= 0) { w.stepT = 0.17; w.stepAlt = !w.stepAlt; sfx.step(w.stepAlt); }
    } else {
      w.stepT = 0;
    }
  }

  // Grabsteine fallen mit, wenn das Gelände darunter weggesprengt wird.
  updateGraves(dt) {
    if (!this.graves.length) return;
    for (const g of this.graves) {
      if (this.terrain.hitsCircle(g.x, g.y + 1, 6)) { g.vy = 0; continue; }
      g.vy = Math.min(900, g.vy + GRAVITY * dt);
      const steps = Math.max(1, Math.ceil((g.vy * dt) / 2));
      for (let i = 0; i < steps; i++) {
        if (this.terrain.hitsCircle(g.x, g.y + 1, 6)) { g.vy = 0; break; }
        g.y += (g.vy * dt) / steps;
      }
      if (g.y > WATER_Y + 8) { g.sunk = true; this.renderer.splash(g.x); }
    }
    this.graves = this.graves.filter((g) => !g.sunk);
  }

  // Dauergeräusche: Stapler-Motor, zischende Gasflasche, Aufladeton
  updateLoops() {
    const playing = this.state?.phase === 'playing';
    setLoop('engine', playing && this.projectiles.some((p) => p.type === 'stapler' && !p.dead));
    const gas = playing && this.projectiles.find((p) => p.type === 'gas' && !p.dead);
    setLoop('hiss', !!gas, gas && gas.fuse != null ? Math.max(0, 1 - gas.fuse / 5) : 0);
    const charge = this.myTurn ? (this.charging ? this.charge : 0) : (this.remote.aiming ? this.remote.charge : 0);
    setLoop('charge', playing && charge > 0, charge);
  }

  stopLoops() {
    setLoop('engine', false); setLoop('hiss', false); setLoop('charge', false);
  }

  simStep(dt) {
    const w = this.activeWorker();
    const now = performance.now();
    if (this.tp === 'aim' && this.timeLeft() <= 0) { this.tp = 'resolve'; this.charging = false; }
    if (this.tp === 'retreat' && now >= this.retreatEnd) this.tp = 'resolve';
    if ((this.tp === 'aim' || this.tp === 'retreat') && (!w || w.dead)) this.tp = 'resolve';

    if (w && !w.dead && (this.tp === 'aim' || this.tp === 'retreat')) this.handleInput(w, dt);
    else if (w) w.walking = false;

    for (const wk of this.workers) if (!wk.dead) this.physicsWorker(wk, dt);
    for (const p of this.projectiles) this.updateProjectile(p, dt);
    this.projectiles = this.projectiles.filter((p) => !p.dead);
    if (this.walker?.dead) this.walker = null;

    if (this.tp === 'resolve') {
      this.resolveTime += dt;
      const settled = this.projectiles.length === 0 && this.workers.every((x) => x.dead || x.grounded);
      this.settleTime = settled ? this.settleTime + dt : 0;
      if (this.settleTime > 0.8 || this.resolveTime > 15) this.endTurn();
    }
  }

  handleInput(w, dt) {
    const k = this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA');
    const right = k.has('ArrowRight') || k.has('KeyD');
    const up = k.has('ArrowUp') || k.has('KeyW');
    const down = k.has('ArrowDown') || k.has('KeyS');
    const wpn = WEAPON_BY_ID[this.weapon];

    w.walking = false;
    if (left !== right && !this.charging) {
      const dir = left ? -1 : 1;
      w.facing = dir;
      if (w.grounded) { this.walk(w, dir); w.walking = true; }
    }
    if (up !== down && this.tp === 'aim') {
      if (wpn.kind === 'girder') this.girderAngle += (up ? -1 : 1) * dt * 1.5;
      else w.aim = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, w.aim + (up ? -1 : 1) * dt * this.aimSpeed));
    }
    if (this.charging) {
      this.charge = Math.min(1, this.charge + dt / 1.4);
      if (this.charge >= 1) this.fire(1);
    }
  }

  walk(w, dir) {
    const nx = w.x + dir * 1.1;
    for (let lift = 0; lift <= 7; lift++) {
      if (!this.terrain.hitsCircle(nx, w.y - lift, WORKER_R)) {
        w.x = nx;
        w.y -= lift;
        // An Gefälle haften
        let drop = 0;
        while (drop < 8 && !this.terrain.hitsCircle(w.x, w.y + 1, WORKER_R)) { w.y += 1; drop++; }
        if (drop >= 8) { w.grounded = false; w.vx = dir * 50; w.vy = 0; }
        return true;
      }
    }
    return false;
  }

  isGrounded(o, r) {
    return this.terrain.hitsCircle(o.x, o.y + 1.5, r);
  }

  // Bewegt einen Kreis mit Unterschritten, reflektiert bei Kollision.
  moveCircle(o, dt, r, e) {
    const dist = Math.hypot(o.vx, o.vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 2));
    const sx = (o.vx * dt) / steps, sy = (o.vy * dt) / steps;
    for (let i = 0; i < steps; i++) {
      const nx = o.x + sx, ny = o.y + sy;
      if (this.terrain.hitsCircle(nx, ny, r)) {
        const n = this.terrain.normalAt(nx, ny, r);
        const vn = o.vx * n.x + o.vy * n.y;
        if (vn < 0) {
          o.vx -= (1 + e) * vn * n.x;
          o.vy -= (1 + e) * vn * n.y;
          // Reibung entlang der Oberfläche
          const tx = -n.y, ty = n.x;
          const vt = o.vx * tx + o.vy * ty;
          o.vx -= vt * 0.25 * tx;
          o.vy -= vt * 0.25 * ty;
        } else {
          o.vx *= 0.5; o.vy *= 0.5;
        }
        return { hit: true, n, impact: Math.max(0, -vn) };
      }
      o.x = nx; o.y = ny;
    }
    return null;
  }

  physicsWorker(w, dt) {
    // Im Gelände steckengeblieben (z.B. Brücke drauf gebaut)? Nach oben schieben.
    if (this.terrain.hitsCircle(w.x, w.y, WORKER_R)) {
      for (let i = 0; i < 40 && this.terrain.hitsCircle(w.x, w.y, WORKER_R); i++) w.y -= 1;
    }
    if (w.grounded) {
      if (this.isGrounded(w, WORKER_R)) { w.vx = 0; w.vy = 0; return; }
      w.grounded = false;
    }
    const ox = w.x, oy = w.y;
    w.vy += GRAVITY * dt;
    const res = this.moveCircle(w, dt, WORKER_R, 0.3);
    if (res) {
      const dmg = fallDamage(res.impact);
      if (dmg > 0 && res.n.y < -0.3) this.fallHurt(w, dmg);
      if (res.n.y < -0.55 && Math.hypot(w.vx, w.vy) < 130) {
        w.grounded = true; w.vx = 0; w.vy = 0;
      }
    }
    w.still = Math.hypot(w.x - ox, w.y - oy) < 0.3 ? w.still + dt : 0;
    if (w.still > 0.4 && this.isGrounded(w, WORKER_R)) { w.grounded = true; w.vx = 0; w.vy = 0; }
    if (w.y > WATER_Y + 4) this.drown(w);
  }

  fallHurt(w, dmg) {
    if (w.dead) return;
    this.damage(w, dmg);
    this.fx({ k: 'fall', id: w.id, x: r1(w.x), y: r1(w.y), d: dmg });
    // Wie im Original: Wer sich beim eigenen Zug verletzt, beendet ihn sofort.
    if (w === this.activeWorker() && (this.tp === 'aim' || this.tp === 'retreat')) {
      this.charging = false;
      this.tp = 'resolve';
      if (!w.dead) this.fx({ k: 'msg', text: `${w.name} hat sich verhoben – Zug vorbei!`, color: '#ffb74d' });
    }
  }

  drown(w) {
    if (w.dead) return;
    w.hp = 0;
    w.dead = true;
    this.fx({ k: 'splash', x: w.x });
  }

  damage(w, amount) {
    if (w.dead || amount <= 0) return;
    w.hp = Math.max(0, w.hp - amount);
    if (w.hp <= 0) w.dead = true;
  }

  // ---------- Waffen ----------
  fire(power, target = null) {
    const w = this.activeWorker();
    if (!w || w.dead || this.tp !== 'aim') return;
    const wpn = WEAPON_BY_ID[this.weapon];
    if (this.ammoOf(wpn.id) === 0) return;
    this.charging = false;
    this.charge = 0;
    const dir = { x: Math.cos(w.aim) * w.facing, y: Math.sin(w.aim) };
    const sx = w.x + dir.x * (WORKER_R + 7), sy = w.y + dir.y * (WORKER_R + 7);
    let endTurnNow = false;
    this.manualCam = false;

    switch (wpn.kind) {
      case 'projectile': {
        const sp = 120 + power * 900;
        this.projectiles.push({ type: wpn.id, wpn, x: sx, y: sy, vx: dir.x * sp, vy: dir.y * sp, r: 3, rot: 0, facing: 1, age: 0 });
        this.fx({ k: 'sfx', s: 'shoot' });
        this.fx({ k: 'anim', id: w.id, a: 'shoot' });
        break;
      }
      case 'grenade': {
        const sp = 100 + power * 650;
        this.projectiles.push({ type: wpn.id, wpn, x: sx, y: sy, vx: dir.x * sp, vy: dir.y * sp, r: 4, rot: 0, facing: w.facing, fuse: wpn.fuse, age: 0 });
        this.fx({ k: 'sfx', s: 'throw' });
        this.fx({ k: 'anim', id: w.id, a: 'throw' });
        break;
      }
      case 'hitscan': {
        this.fx({ k: 'anim', id: w.id, a: 'shoot' });
        this.scan(w, sx, sy, dir, wpn);
        this.shotsLeft -= 1;
        if (this.shotsLeft > 0) {
          if (!this.used.includes(wpn.id)) this.used.push(wpn.id);
          return; // zweiter Schuss erlaubt
        }
        break;
      }
      case 'melee': {
        let hit = false;
        for (const o of this.workers) {
          if (o === w || o.dead) continue;
          const dx = o.x - w.x;
          if (dx * w.facing > -4 && Math.abs(dx) < 32 && Math.abs(o.y - w.y) < 22) {
            this.damage(o, wpn.damage);
            o.vx = w.facing * 480; o.vy = -330; o.grounded = false;
            hit = true;
          }
        }
        this.fx({ k: 'puff', x: w.x + w.facing * 18, y: w.y, c: '#ffcc80' });
        this.fx({ k: 'anim', id: w.id, a: 'swing' });
        this.fx({ k: 'sfx', s: 'swing' });
        if (hit) this.fx({ k: 'sfx', s: 'bonk' });
        break;
      }
      case 'walker': {
        const p = { type: 'stapler', wpn, x: w.x + w.facing * 16, y: w.y - 4, vx: w.facing * 60, vy: -80, r: 7, rot: 0, facing: w.facing, fuse: wpn.fuse, age: 0, grounded: false, stuck: 0 };
        this.projectiles.push(p);
        this.walker = p;
        this.fx({ k: 'sfx', s: 'engine' });
        this.fx({ k: 'anim', id: w.id, a: 'drop' });
        break;
      }
      case 'drop': {
        this.projectiles.push({ type: 'gas', wpn, x: w.x + w.facing * 12, y: w.y - 4, vx: w.facing * 40, vy: -60, r: 5, rot: 0, facing: 1, fuse: wpn.fuse, age: 0 });
        this.fx({ k: 'sfx', s: 'thud' });
        this.fx({ k: 'anim', id: w.id, a: 'drop' });
        break;
      }
      case 'airstrike': {
        if (!target) return;
        for (let i = 0; i < wpn.count; i++) {
          this.projectiles.push({ type: 'palette', wpn, x: target.x + (i - (wpn.count - 1) / 2) * 34, y: -40 - i * 25, vx: 0, vy: 200, r: 5, rot: 0, facing: 1, age: 0, wind: true });
        }
        this.fx({ k: 'msg', text: 'Achtung, Kranarbeiten!', color: '#ffd400' });
        this.fx({ k: 'anim', id: w.id, a: 'radio' });
        this.fx({ k: 'sfx', s: 'crane' });
        this.fx({ k: 'sfx', s: 'whistle' });
        break;
      }
      case 'teleport': {
        if (!target) return;
        if (target.y > WATER_Y - 10 || target.x < 10 || target.x > W - 10 || !isFree(this.terrain.mat, target.x, target.y, WORKER_R + 1)) {
          this.ui.toast('Da ist kein Platz im Regal.', '#ff5252');
          return;
        }
        this.fx({ k: 'puff', x: w.x, y: w.y, c: '#b388ff' });
        this.fx({ k: 'anim', id: w.id, a: 'tele' });
        w.x = target.x; w.y = target.y; w.vx = 0; w.vy = 0; w.grounded = false;
        this.fx({ k: 'puff', x: w.x, y: w.y, c: '#b388ff' });
        this.fx({ k: 'sfx', s: 'teleport' });
        endTurnNow = true;
        break;
      }
      case 'girder': {
        if (!target) return;
        if (Math.hypot(target.x - w.x, target.y - w.y) > 260) {
          this.ui.toast('Zu weit weg – so lang ist kein Arm.', '#ff5252');
          return;
        }
        this.sendOp({ k: 'girder', x: r1(target.x), y: r1(target.y), a: Math.round(this.girderAngle * 1000) / 1000 });
        this.fx({ k: 'sfx', s: 'build' });
        this.fx({ k: 'anim', id: w.id, a: 'build' });
        break;
      }
      case 'skip': {
        this.fx({ k: 'msg', text: `${w.name} macht Kaffeepause. ☕`, color: '#a1887f' });
        this.fx({ k: 'anim', id: w.id, a: 'coffee' });
        this.fx({ k: 'sfx', s: 'slurp' });
        endTurnNow = true;
        break;
      }
    }

    if (!this.used.includes(wpn.id)) this.used.push(wpn.id);
    const team = this.teams[this.turn.team];
    if (team && team.ammo[wpn.id] > 0) team.ammo[wpn.id] -= 1;
    this.ui.refreshWeapons();

    if (endTurnNow) {
      this.tp = 'resolve';
    } else {
      this.tp = 'retreat';
      this.retreatEnd = performance.now() + RETREAT_TIME * 1000;
    }
  }

  scan(w, sx, sy, dir, wpn) {
    let x = sx, y = sy;
    let hitWorker = null;
    for (let i = 0; i < 500; i++) {
      x += dir.x * 2; y += dir.y * 2;
      if (x < -50 || x > W + 50 || y < -400 || y > WATER_Y) break;
      hitWorker = this.workers.find((o) => o !== w && !o.dead && Math.hypot(o.x - x, o.y - y) < WORKER_R + 1);
      if (hitWorker) break;
      if (this.terrain.solid(x, y)) break;
    }
    this.fx({ k: 'laser', x1: r1(sx), y1: r1(sy), x2: r1(x), y2: r1(y) });
    if (hitWorker) {
      this.damage(hitWorker, wpn.damage);
      hitWorker.vx += dir.x * 160; hitWorker.vy += dir.y * 160 - 80; hitWorker.grounded = false;
      this.fx({ k: 'sfx', s: 'beep' });
    } else if (this.terrain.solid(x, y)) {
      this.sendOp({ k: 'boom', x: r1(x), y: r1(y), r: wpn.radius }, false);
      this.renderer.puff(x, y, '#b98b54');
    }
  }

  explode(x, y, radius, damage) {
    this.sendOp({ k: 'boom', x: r1(x), y: r1(y), r: radius }, true);
    this.renderer.explosion(x, y, radius);
    sfx.boom(radius / 50);
    const R = radius + WORKER_R;
    for (const w of this.workers) {
      if (w.dead) continue;
      const dx = w.x - x, dy = w.y - y;
      const d = Math.hypot(dx, dy);
      if (d >= R) continue;
      const f = 1 - d / R;
      this.damage(w, Math.round(damage * (0.3 + 0.7 * f)));
      const k = 560 * (0.35 + 0.65 * f) * Math.min(1.5, radius / 46);
      const nx = d > 0.5 ? dx / d : 0, ny = d > 0.5 ? dy / d : -1;
      w.vx += nx * k;
      w.vy += ny * k - 140 * f;
      w.grounded = false;
    }
    // Andere Projektile (z.B. Gasflaschen) wegschubsen
    for (const p of this.projectiles) {
      if (p.dead || p.type === 'palette' || p.type === 'paket') continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < R && d > 0.5) {
        p.vx += ((p.x - x) / d) * 300; p.vy += ((p.y - y) / d) * 300 - 100; p.grounded = false;
      }
    }
  }

  explodeProjectile(p) {
    if (p.dead) return;
    p.dead = true;
    const wpn = p.wpn;
    if (p.type === 'frag') {
      this.explode(p.x, p.y, 22, 18);
      return;
    }
    this.explode(p.x, p.y, wpn.radius, wpn.damage);
    if (wpn.cluster) {
      for (let i = 0; i < wpn.cluster; i++) {
        const a = -Math.PI / 2 + (i - (wpn.cluster - 1) / 2) * 0.45;
        const sp = 220 + Math.random() * 120;
        this.projectiles.push({ type: 'frag', wpn, x: p.x, y: p.y - 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2, rot: 0, facing: 1, age: 0 });
      }
    }
  }

  hitsWorker(p, extra = 0) {
    const w0 = this.activeWorker();
    return this.workers.some((w) => !w.dead && (w !== w0 || p.age > 0.25) && Math.hypot(w.x - p.x, w.y - p.y) < WORKER_R + p.r + extra);
  }

  updateProjectile(p, dt) {
    if (p.dead) return;
    p.age += dt;
    const wind = this.turn?.wind || 0;
    switch (p.type) {
      case 'paket':
      case 'palette':
      case 'frag': {
        p.vy += GRAVITY * dt;
        if (p.type === 'paket' || p.type === 'palette') p.vx += wind * WIND_ACC * dt;
        const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
        for (let i = 0; i < steps; i++) {
          p.x += (p.vx * dt) / steps;
          p.y += (p.vy * dt) / steps;
          if (this.terrain.solid(p.x, p.y) || this.hitsWorker(p)) { this.explodeProjectile(p); break; }
        }
        p.rot = p.type === 'palette' ? Math.sin(p.age * 3) * 0.2 : Math.atan2(p.vy, p.vx);
        break;
      }
      case 'folie':
      case 'kiste':
      case 'gas': {
        p.vy += GRAVITY * dt;
        const res = this.moveCircle(p, dt, p.r, p.wpn.bounce ?? 0.25);
        if (res && res.impact > 60) this.fx({ k: 'sfx', s: p.type === 'gas' ? 'thud' : 'bounce' });
        if (p.type === 'gas' && res) { p.vx *= 0.85; }
        p.rot += p.vx * dt * 0.08;
        this.fuseTick(p, dt);
        if (p.fuse <= 0) this.explodeProjectile(p);
        break;
      }
      case 'stapler': {
        this.fuseTick(p, dt);
        if (p.fuse <= 0 || (p.age > 0.5 && this.hitsWorker(p, 4))) { this.explodeProjectile(p); break; }
        if (p.grounded) {
          if (!this.terrain.hitsCircle(p.x, p.y + 1.5, p.r)) { p.grounded = false; break; }
          const nx = p.x + p.facing * 1.6;
          let moved = false;
          for (let lift = 0; lift <= 9; lift++) {
            if (!this.terrain.hitsCircle(nx, p.y - lift, p.r)) {
              p.x = nx; p.y -= lift; moved = true;
              let drop = 0;
              while (drop < 10 && !this.terrain.hitsCircle(p.x, p.y + 1, p.r)) { p.y += 1; drop++; }
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
          p.rot = 0;
        } else {
          p.vy += GRAVITY * dt;
          const res = this.moveCircle(p, dt, p.r, 0.1);
          if (res && res.n.y < -0.5) { p.grounded = true; p.vx = 0; p.vy = 0; }
        }
        break;
      }
    }
    if (!p.dead && (p.y > WATER_Y + 4 || p.x < -500 || p.x > W + 500 || p.y > H + 100)) {
      p.dead = true;
      if (p.y > WATER_Y) this.fx({ k: 'splash', x: p.x });
    }
  }

  fuseTick(p, dt) {
    const before = Math.ceil(p.fuse);
    p.fuse -= dt;
    if (Math.ceil(p.fuse) !== before && p.fuse > 0) this.fx({ k: 'sfx', s: 'fuse' });
  }

  // ---------- Netzwerk ----------
  sendSnap() {
    const w = this.activeWorker();
    this.net.send({
      t: 'snap',
      n: this.turnN,
      w: this.workers.map((x) => [x.id, r1(x.x), r1(x.y), x.hp, x.dead ? 1 : 0, x.facing, Math.round(x.aim * 100) / 100, x.walking ? 1 : 0, x.grounded ? 1 : 0]),
      p: this.projectiles.filter((p) => !p.dead).map((p) => [PROJECTILE_TYPES.indexOf(p.type), r1(p.x), r1(p.y), Math.round(p.rot * 100) / 100, p.facing, p.fuse != null ? r1(p.fuse) : null]),
      wp: this.weapon,
      ch: Math.round(this.charge * 100) / 100,
      am: this.tp === 'aim' && w && !w.dead ? 1 : 0,
      rt: Math.round(this.retreatLeft() * 10) / 10,
      tl: Math.round(this.timeLeft() * 10) / 10,
    });
  }

  endTurn() {
    if (this.tp === 'done') return;
    this.tp = 'done';
    this.sendSnap();
    this.net.send({
      t: 'turnEnd',
      n: this.turnN,
      workers: this.workers.map((w) => ({ id: w.id, x: r1(w.x), y: r1(w.y), hp: w.hp, dead: w.dead })),
      used: this.used,
    });
  }

  // ---------- Darstellung ----------
  focusPoint() {
    if (this.manualCam) return null;
    const p = this.projectiles.find((x) => !x.dead);
    if (p) return p;
    const flying = this.workers.find((w) => !w.dead && !w.grounded && Math.hypot(w.vx || 0, w.vy || 0) > 250);
    if (flying && this.myTurn) return flying;
    const a = this.activeWorker();
    return a && !a.dead ? { x: a.rx ?? a.x, y: a.ry ?? a.y } : null;
  }

  render(dt) {
    if (!this.terrain || !this.state || this.state.phase === 'lobby') return;
    const active = this.activeWorker();
    const wpnId = this.myTurn ? this.weapon : this.remote.weapon;
    const wpn = WEAPON_BY_ID[wpnId] || WEAPON_BY_ID.paket;
    const aiming = this.myTurn ? this.tp === 'aim' : this.remote.aiming;
    const playing = this.state.phase === 'playing';
    const held = playing && aiming ? { id: wpn.id, aimArm: ['projectile', 'grenade', 'hitscan'].includes(wpn.kind) } : null;
    const charge = this.myTurn ? this.charge : this.remote.charge;
    this.renderer.syncWorkers(this.workers, this.teams, playing ? active?.id : -1, held, aiming ? charge : 0, dt);
    this.renderer.setProjectiles(this.projectiles.filter((p) => !p.dead), dt);
    this.renderer.syncGraves(this.graves, this.teams);
    const showAim = !!active && !active.dead && aiming && !wpn.target && ['projectile', 'grenade', 'hitscan'].includes(wpn.kind);
    if (active) {
      this.renderer.showAim({ x: active.rx ?? active.x, y: active.ry ?? active.y }, active.aim, active.facing, this.myTurn ? this.charge : this.remote.charge, showAim);
    } else {
      this.renderer.showAim(null, 0, 1, 0, false);
    }
    if (this.myTurn && this.tp === 'aim' && wpn.target) {
      this.renderer.showTarget(wpn.kind === 'girder' ? 'girder' : 'point', this.mouse.x, this.mouse.y, this.girderAngle);
    } else {
      this.renderer.showTarget(null);
    }
    this.renderer.frame(dt, this.focusPoint());
  }
}

export { MAX_HP };
