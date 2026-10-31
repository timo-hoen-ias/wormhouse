// Spiellogik auf dem Client.
// Der Client des aktiven Spielers simuliert den Zug (Bewegung, Projektile, Schaden)
// und streamt Snapshots. Alle anderen Clients stellen die Snapshots dar.
import {
  WORLD_W as W, WORLD_H as H, WATER_Y, GRAVITY, WORKER_R, MAX_HP, RETREAT_TIME,
} from '../shared/constants.js';
import { BotController } from './ai.js';
import { WEAPON_BY_ID, WEAPON_CATS, PROJECTILE_TYPES, AIM_KINDS } from '../shared/weapons.js';
import { findSpawns, isFree } from '../shared/terrain-gen.js';
import { MAP_BY_ID, COMPLEXITY } from '../shared/maps.js';
import { Terrain } from './terrain.js';
import { fallDamage } from '../shared/fall.js';
import { sfx, setLoop } from './audio.js';
import { ROPE, KNOCK, knockHit, newRope, fireHook as shootHook, hookStep, ropeStep } from '../shared/rope.js';

const STEP = 1 / 60;
const RESOLVE_MAX = 10; // Sekunden: länger wartet ein Zug nie auf Ruhe
const WIND_ACC = 160;
const SNAP_INTERVAL = 50;
// Gummi-Expander
const BUNGEE_REST = 70;
const BUNGEE_K = 16;

// Was sich vom Seil aus einsetzen lässt (Abwurf- und Zielwaffen, wie in Worms)
const ROPE_WEAPON_KINDS = ['grenade', 'drop', 'walker', 'airstrike', 'heavy', 'skip'];

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
    this.myTurn = false; // ich (Mensch) bin am Zug
    this.localTurn = false; // ein lokaler Mitspieler (Hotseat) an meinem Gerät ist am Zug
    this.myWeapons = {}; // zuletzt gewählte Waffe je Team
    this.botTurn = false; // ich steuere als Schichtleitung gerade ein KI-Team
    this.sim = false; // dieser Client simuliert den laufenden Zug
    this.ai = null;
    this.waterY = WATER_Y;
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
    this.quietTime = 0;
    this.resolveTime = 0;
    this.retreatEnd = 0;
    this.turnLocalEnd = 0;
    this.manualCam = false;
    this.remote = { weapon: null, charge: 0 };
    this.walker = null;
    this.graves = [];
    this.lastFuse = new Map();
    this.mv = null; // aktives Hilfsmittel: {kind:'rope'|'jet'|'chute'|'bungee', ...}
    this.burst = null; // Elektrotacker-Dauerfeuer
    this.drill = null; // Bohrhammer
    this.homeTarget = null; // Ziel der Sendungsverfolgung
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

  // Spielen an diesem Gerät mehrere Leute abwechselnd (lokale Mitspieler)?
  hotseat(state = this.state) {
    return state?.hostPid === this.myPid && !!state?.teams?.some((t) => t.local);
  }

  ammoOf(id) {
    const t = this.teams[this.turn?.team];
    if (!t) return 0;
    return t.ammo[id] ?? 0;
  }

  timeLeft() {
    return Math.max(0, (this.turnLocalEnd - performance.now()) / 1000);
  }

  get rules() { return this.state?.rules || {}; }

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
      this.botTurn = false;
      this.sim = false;
      this.ai = null;
      this.tp = 'wait';
      this.stopLoops();
      return;
    }

    if (this.gameNo !== state.game || !this.terrain) {
      this.newGame(state);
    }

    this.setWaterLevel(state.waterY ?? WATER_Y);
    const t = state.turn;
    if (state.phase === 'playing' && t && t.n !== prevTurn) {
      this.beginTurn(state);
    } else if (state.phase === 'playing' && t && !this.sim && this.controlsTurn(state)) {
      // Schichtleitung hat gewechselt, während ein KI-Team am Zug ist: jetzt steuere ich.
      this.beginTurn(state);
    } else if (state.phase === 'ended' && prevPhase !== 'ended') {
      this.syncWorkersFromServer(state.workers);
      this.myTurn = false;
      this.botTurn = false;
      this.sim = false;
      this.ai = null;
      this.tp = 'wait';
      this.projectiles = [];
      this.stopLoops();
      const mine = this.myTeamIndex();
      // Hotseat: Gewinnt irgendein Team an diesem Gerät, gibt's die Siegesfanfare.
      const localWin = state.teams[state.winner]?.local && state.hostPid === this.myPid;
      if (mine >= 0 && state.winner !== mine && !localWin) sfx.lose(); else sfx.win();
    }
  }

  controlsTurn(state) {
    const team = state.teams[state.turn?.team];
    if (!team) return false;
    return team.pid ? team.pid === this.myPid : (team.bot > 0 || !!team.local) && state.hostPid === this.myPid;
  }

  setWaterLevel(y) {
    if (y < this.waterY - 0.5 && this.terrain) this.ui.toast?.('🌊 Das Hafenbecken steigt!', '#4fc3f7');
    this.waterY = y;
    this.renderer.setWaterLevel?.(y);
  }

  newGame(state) {
    this.gameNo = state.game;
    this.terrain = new Terrain(state.seed, state.map);
    const m = MAP_BY_ID[state.map?.id];
    this.ropeMap = !!m?.rope;
    if (m) this.ui.toast?.(`${state.rules?.mode === 'seil' ? '🧗 Rope only · ' : ''}${m.icon} ${m.name} · ${COMPLEXITY[state.map.complexity]?.name ?? ''}`, '#ffc400');
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
    this.waterY = state.waterY ?? WATER_Y;
    this.renderer.setWaterLevel?.(this.waterY, true);
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
      w.still = 0;
    }
  }

  beginTurn(state) {
    const t = state.turn;
    this.turnN = t.n;
    this.syncWorkersFromServer(state.workers);
    this.projectiles = [];
    this.walker = null;
    this.mv = null;
    this.burst = null;
    this.drill = null;
    this.homeTarget = null;
    this.remote.mv = null;
    this.charge = 0;
    this.charging = false;
    this.used = [];
    this.settleTime = 0;
    this.quietTime = 0;
    this.resolveTime = 0;
    this.manualCam = false;
    this.turnLocalEnd = performance.now() + (state.turnMsLeft ?? 45000);
    this.retreatEnd = 0;
    const team = state.teams[t.team];
    // Lokale Mitspieler (Hotseat) spielen am Gerät der Schichtleitung mit derselben Steuerung.
    this.localTurn = !!team && !team.pid && !!team.local && state.hostPid === this.myPid;
    this.myTurn = !!team && (team.pid === this.myPid || this.localTurn);
    this.botTurn = !!team && !team.pid && team.bot > 0 && state.hostPid === this.myPid;
    this.sim = this.myTurn || this.botTurn;
    this.ai = this.botTurn ? new BotController(this, team.bot) : null;
    this.tp = this.sim ? 'aim' : 'wait';
    const w = this.activeWorker();
    if (this.botTurn) {
      if ((team.ammo[this.weapon] ?? 0) === 0) this.weapon = 'paket';
      this.shotsLeft = WEAPON_BY_ID[this.weapon].shots || 1;
      this.ui.toast(`${team.name} ist dran${w ? ` (${w.name})` : ''} 🤖`, team.color);
    } else if (this.myTurn) {
      this.weapon = this.myWeapons[t.team] || this.weapon;
      if ((team.ammo[this.weapon] ?? 0) === 0) this.weapon = 'paket';
      this.shotsLeft = WEAPON_BY_ID[this.weapon].shots || 1;
      this.ui.toast(this.hotseat(state)
        ? `${team.name} ist dran! ${w ? w.name : ''} wartet auf Anweisungen.`
        : `Du bist dran! ${w ? w.name : ''} wartet auf Anweisungen.`, team.color);
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
    if (this.sim || !this.turn || msg.n !== this.turn.n) return;
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
    this.remote.mv = msg.mv || null;
    if (msg.tl != null) this.turnLocalEnd = performance.now() + msg.tl * 1000;
  }

  onFx(msg) {
    this.playFx(msg);
  }

  playFx(f) {
    switch (f.k) {
      case 'laser': this.renderer.laser(f.x1, f.y1, f.x2, f.y2, f.c); if (f.c) sfx.tack(); else sfx.laser(); break;
      case 'puff': this.renderer.puff(f.x, f.y, f.c); break;
      case 'splash': this.renderer.splash(f.x); sfx.splash(); break;
      case 'sfx': sfx[f.s]?.(); break;
      case 'msg': this.ui.toast(f.text, f.color); break;
      case 'anim': this.renderer.workerAnim(f.id, f.a); break;
      case 'float': this.renderer.floatText(f.x, f.y, f.text, f.c); break;
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
    return this.sim && (this.tp === 'aim' || this.tp === 'retreat');
  }

  selectWeapon(id) {
    if (!this.myTurn || this.tp !== 'aim' || this.charging) return;
    const wpn = WEAPON_BY_ID[id];
    if (!wpn || this.ammoOf(id) === 0) return;
    if (this.weapon === 'scanner' && this.shotsLeft < (WEAPON_BY_ID.scanner.shots)) return;
    if (this.weapon !== id) this.homeTarget = null;
    this.weapon = id;
    if (this.turn) this.myWeapons[this.turn.team] = id;
    this.shotsLeft = wpn.shots || 1;
    this.ui.refreshWeapons();
  }

  // Waffenwahl der KI (ohne die Prüfung auf menschlichen Zug).
  botSelectWeapon(id) {
    const wpn = WEAPON_BY_ID[id];
    if (!this.botTurn || !wpn || this.ammoOf(id) === 0) return false;
    this.weapon = id;
    this.shotsLeft = wpn.shots || 1;
    return true;
  }

  // Taste für ein Fach im Waffenregal: erste verfügbare Waffe, bei erneutem Drücken die nächste.
  selectCategory(ci) {
    const list = (WEAPON_CATS[ci] || []).filter((w) => this.ammoOf(w.id) !== 0);
    if (!list.length) return;
    const cur = list.findIndex((w) => w.id === this.weapon);
    this.selectWeapon(list[(cur + 1) % list.length].id);
  }

  keyDown(code) {
    this.keys.add(code);
    if (!this.myTurn) return;
    const w = this.activeWorker();
    if (!w || w.dead) return;
    const wpn = WEAPON_BY_ID[this.weapon];
    if (code === 'Space') {
      if (this.walker && !this.walker.dead) { this.explodeProjectile(this.walker); return; }
      if (this.drill) { this.stopDrill(); return; }
      // Aktives Hilfsmittel bedienen (loslassen, abschalten, neu schießen)
      if (this.mv && (wpn.kind === this.mv.kind || this.tp !== 'aim')) { this.utilityAction(w); return; }
      if (this.tp !== 'aim' || (wpn.target && !wpn.charge)) return;
      // Vom Seil wird nur abgeworfen (wie in Worms): kein Aufladen
      if (this.onRope() && !wpn.util) { this.fire(0); return; }
      if (wpn.kind === 'homing' && !this.homeTarget) { this.ui.toast('Erst den Empfänger anklicken!', '#00e5ff'); return; }
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
    if (code === 'Space' && this.charging && this.myTurn) this.fire(this.charge);
  }

  click(x, y) {
    if (!this.myTurn || this.tp !== 'aim') return false;
    const wpn = WEAPON_BY_ID[this.weapon];
    if (!wpn.target) return false;
    if (wpn.kind === 'homing') {
      this.homeTarget = { x, y };
      sfx.beep();
      this.ui.toast('Empfänger gespeichert – jetzt mit Leertaste abschicken.', '#00e5ff');
      return true;
    }
    this.fire(1, { x, y });
    return true;
  }

  // ---------- Hauptschleife ----------
  // maxCatchup: wie viel Spielzeit ein einzelner Aufruf nachholen darf
  // (im Hintergrund-Tab tickt der Browser selten, dann mehr nachholen).
  update(dt, maxCatchup = 0.1) {
    if (!this.terrain || !this.state || this.state.phase === 'lobby') return;
    if (this.sim && this.tp !== 'done') {
      this.acc += Math.min(dt, maxCatchup);
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
    const k = this.sim ? 1 : 1 - Math.exp(-dt * 18);
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
        if (w.y < this.waterY) {
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
      if (g.y > this.waterY + 8) { g.sunk = true; this.renderer.splash(g.x); }
    }
    this.graves = this.graves.filter((g) => !g.sunk);
  }

  // Dauergeräusche: Stapler-Motor, zischende Gasflasche, Aufladeton
  updateLoops() {
    const playing = this.state?.phase === 'playing';
    setLoop('engine', playing && this.projectiles.some((p) => p.type === 'stapler' && !p.dead));
    const gas = playing && this.projectiles.find((p) => p.type === 'gas' && !p.dead);
    setLoop('hiss', !!gas, gas && gas.fuse != null ? Math.max(0, 1 - gas.fuse / 5) : 0);
    const charge = this.sim ? (this.charging ? this.charge : 0) : (this.remote.aiming ? this.remote.charge : 0);
    setLoop('charge', playing && charge > 0, charge);
    setLoop('drone', playing && this.projectiles.some((p) => p.type === 'drohne' && !p.dead));
    const gear = this.sim ? this.gearState() : this.remote.mv;
    setLoop('jet', playing && !!gear && gear.k === 'jet' && !!gear.on);
  }

  stopLoops() {
    for (const l of ['engine', 'hiss', 'charge', 'drone', 'jet']) setLoop(l, false);
  }

  simStep(dt) {
    const w = this.activeWorker();
    const now = performance.now();
    if (this.tp === 'aim' && this.timeLeft() <= 0) { this.tp = 'resolve'; this.charging = false; }
    if (this.tp === 'retreat' && now >= this.retreatEnd) this.tp = 'resolve';
    if ((this.tp === 'aim' || this.tp === 'retreat' || this.tp === 'control') && (!w || w.dead)) this.tp = 'resolve';
    // „control“: Drohne fliegt, Tacker feuert, Bohrhammer bohrt – danach erst Rückzug
    if (this.tp === 'control' && !this.burst && !this.drill && !(this.walker && !this.walker.dead && this.walker.type === 'drohne')) {
      this.tp = 'retreat';
      this.retreatEnd = now + RETREAT_TIME * 1000;
    }
    // Zugende: Seil, Rucksack und Expander lösen sich (ein offener Fallschirm bleibt offen,
    // ein nie geöffneter wird weggepackt – sonst gilt der Zug nie als beendet)
    if (this.mv && (this.tp === 'resolve' || !w || w.dead) && !(this.mv.kind === 'chute' && this.mv.open && w && !w.dead)) this.endUtility();

    if (this.ai && w && !w.dead) this.ai.update(dt);
    if (w && !w.dead && (this.tp === 'aim' || this.tp === 'retreat' || this.tp === 'control')) this.handleInput(w, dt);
    else if (w) w.walking = false;
    if (this.burst && w && !w.dead) this.burstStep(w, dt);
    if (this.drill && w && !w.dead) this.drillStep(w, dt);

    for (const wk of this.workers) {
      if (wk.dead) continue;
      if (wk === w && this.drill) continue; // Bohrhammer bewegt den Arbeiter selbst
      if (wk === w && this.mv) this.utilityPhysics(wk, dt);
      else this.physicsWorker(wk, dt);
    }
    for (const p of this.projectiles) this.updateProjectile(p, dt);
    this.projectiles = this.projectiles.filter((p) => !p.dead);
    if (this.walker?.dead) this.walker = null;

    if (this.tp === 'resolve') {
      this.resolveTime += dt;
      // Ruhe = keine Geschosse, kein Hilfsmittel, alle Arbeiter gelandet bzw. reglos.
      const quiet = this.projectiles.length === 0 && !this.mv;
      const settled = quiet && this.workers.every((x) => x.dead || x.grounded || x.still > 0.5);
      this.settleTime = settled ? this.settleTime + dt : 0;
      // Notbremsen: Hängt/wackelt nur noch ein Arbeiter langsam herum (fliegt aber
      // nicht mehr), nach 2 s trotzdem weiter; insgesamt nie länger als 10 s warten.
      const calm = quiet && this.workers.every((x) => x.dead || x.grounded || Math.hypot(x.vx, x.vy) < 80);
      this.quietTime = calm ? this.quietTime + dt : 0;
      if (this.settleTime > 0.8 || this.quietTime > 2 || this.resolveTime > RESOLVE_MAX) this.endTurn();
    }
  }

  handleInput(w, dt) {
    const k = this.ai ? this.ai.keys : this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA');
    const right = k.has('ArrowRight') || k.has('KeyD');
    const up = k.has('ArrowUp') || k.has('KeyW');
    const down = k.has('ArrowDown') || k.has('KeyS');
    const wpn = WEAPON_BY_ID[this.weapon];
    w.walking = false;

    // Drohne in der Luft: Pfeiltasten lenken die Drohne, nicht den Arbeiter
    const drone = this.walker && !this.walker.dead && this.walker.type === 'drohne' ? this.walker : null;
    if (drone) {
      if (left !== right) drone.heading += (right ? 1 : -1) * dt * 2.8;
      if (up !== down) drone.heading += (down ? 1 : -1) * dt * 2.8 * (Math.cos(drone.heading) < 0 ? -1 : 1);
      return;
    }
    if (this.tp === 'control') {
      // Während Dauerfeuer nur nachzielen
      if (this.burst && up !== down) w.aim = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, w.aim + (up ? -1 : 1) * dt * this.aimSpeed * 0.6));
      return;
    }

    const mv = this.mv;
    if (left !== right && !this.charging) {
      const dir = left ? -1 : 1;
      w.facing = dir;
      if (w.grounded && !(mv && mv.kind === 'rope' && mv.pts)) { this.walk(w, dir); w.walking = true; }
    }
    // Am Seil steuern ↑/↓ die Seillänge, sonst den Zielwinkel
    if (mv?.kind === 'rope' && mv.pts) {
      // Länge wird in ropePhysics gesteuert
    } else if (mv?.kind === 'jet') {
      // ↑ ist Schub
    } else if (up !== down && this.tp === 'aim') {
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
          // Bewegt sich schon weg, steckt aber an einer Kante (z.B. unter einem
          // Überhang): ein Stück entlang der Normalen herausschieben, sonst
          // klebt das Objekt dort für immer fest.
          o.vx *= 0.5; o.vy *= 0.5;
          const px = o.x + n.x, py = o.y + n.y;
          if (!this.terrain.hitsCircle(px, py, r)) { o.x = px; o.y = py; }
        }
        return { hit: true, n, impact: Math.max(0, -vn) };
      }
      o.x = nx; o.y = ny;
    }
    return null;
  }

  // m (optional): { force(w, dt), post(w, dt), safe: kein Fallschaden, float: nie „gelandet“ }
  physicsWorker(w, dt, m = null) {
    // Im Gelände steckengeblieben (z.B. Brücke drauf gebaut)? Nach oben schieben.
    if (this.terrain.hitsCircle(w.x, w.y, WORKER_R)) {
      for (let i = 0; i < 40 && this.terrain.hitsCircle(w.x, w.y, WORKER_R); i++) w.y -= 1;
    }
    if (w.y > this.waterY + 4) { this.drown(w); return; }
    if (w.grounded) {
      if (!m?.float && this.isGrounded(w, WORKER_R)) { w.vx = 0; w.vy = 0; return; }
      w.grounded = false;
    }
    const ox = w.x, oy = w.y;
    w.vy += GRAVITY * dt;
    if (m?.force) m.force(w, dt);
    const res = this.moveCircle(w, dt, WORKER_R, m?.bounce ?? 0.3);
    if (m?.post) m.post(w, dt);
    if (res) {
      const dmg = m?.safe || this.rules.fallDamage === 0 ? 0 : fallDamage(res.impact);
      if (dmg > 0 && res.n.y < -0.3) this.fallHurt(w, dmg);
      if (!m?.float && res.n.y < -0.55 && Math.hypot(w.vx, w.vy) < 130) {
        w.grounded = true; w.vx = 0; w.vy = 0;
      }
    }
    w.still = Math.hypot(w.x - ox, w.y - oy) < 0.3 ? w.still + dt : 0;
    if (!m?.float && w.still > 0.4 && this.isGrounded(w, WORKER_R)) { w.grounded = true; w.vx = 0; w.vy = 0; }
    if (w.y > this.waterY + 4) this.drown(w);
  }

  // ---------- Hilfsmittel: Seil, Rucksack, Fallschirm, Expander ----------
  startUtility(w, wpn) {
    switch (wpn.kind) {
      case 'rope':
        this.mv = newRope();
        return this.fireHook(w);
      case 'jet':
        this.mv = { kind: 'jet', fuel: wpn.fuel, th: false };
        w.grounded = false; w.vy = Math.min(w.vy, -140);
        this.fx({ k: 'sfx', s: 'jetOn' });
        return true;
      case 'chute':
        this.mv = { kind: 'chute', open: false };
        if (!w.grounded) this.openChute(w);
        else this.ui.toast('Fallschirm bereit – öffnet sich im Fall.', '#4fc3f7');
        return true;
      case 'bungee':
        this.mv = { kind: 'bungee', anchor: null };
        if (!w.grounded) this.mv.anchor = { x: w.x, y: w.y - 2 };
        this.fx({ k: 'sfx', s: 'clank' });
        this.ui.toast('Expander eingehakt – ab über die Kante!', '#ef5350');
        return true;
    }
    return false;
  }

  // Leertaste bei aktivem Hilfsmittel
  utilityAction(w) {
    const mv = this.mv;
    if (mv.kind === 'rope') {
      if (mv.pts) { mv.pts = null; this.fx({ k: 'sfx', s: 'release' }); return; }
      if (mv.hook) return;
      if (this.tp !== 'aim') return;
      if (mv.shots >= ROPE.SHOTS) { this.ui.toast('Gurt ist ausgeleiert – erst landen.', '#ff8f00'); return; }
      this.fireHook(w);
    } else if (mv.kind === 'chute') {
      if (mv.open) this.endUtility();
      else if (!w.grounded) this.openChute(w);
    } else {
      this.endUtility();
    }
  }

  // Hängt der Arbeiter gerade am Seil?
  onRope() {
    return this.mv?.kind === 'rope' && !!this.mv.pts;
  }

  endUtility() {
    if (!this.mv) return;
    if (this.mv.kind === 'jet') this.fx({ k: 'sfx', s: 'jetOff' });
    if ((this.mv.kind === 'rope' && this.mv.pts) || (this.mv.kind === 'bungee' && this.mv.anchor)) this.fx({ k: 'sfx', s: 'release' });
    this.mv = null;
  }

  openChute(w) {
    this.mv.open = true;
    this.fx({ k: 'sfx', s: 'chute' });
    this.fx({ k: 'puff', x: r1(w.x), y: r1(w.y - 30), c: '#4fc3f7' });
  }

  fireHook(w) {
    const mv = this.mv;
    const dx = Math.cos(w.aim) * w.facing, dy = Math.sin(w.aim);
    shootHook(mv, w.x + dx * WORKER_R, w.y + dy * WORKER_R, dx, dy);
    this.fx({ k: 'sfx', s: 'rope' });
    this.fx({ k: 'anim', id: w.id, a: 'shoot' });
    return true;
  }

  // Am Seil: Pendel mit fester Maximallänge, wickelt sich um Kanten, reißt ohne Halt.
  ropePhysics(w, dt, dir, input) {
    const mv = this.mv;
    if (this.terrain.hitsCircle(w.x, w.y, WORKER_R)) {
      for (let i = 0; i < 40 && this.terrain.hitsCircle(w.x, w.y, WORKER_R); i++) w.y -= 1;
    }
    const k = this.ai ? this.ai.keys : this.keys;
    const up = k.has('ArrowUp') || k.has('KeyW');
    const down = k.has('ArrowDown') || k.has('KeyS');
    const reel = input && up !== down ? (up ? -1 : 1) : 0;
    w.grounded = false;
    const res = ropeStep(mv, w, dt, { dir, reel }, this.terrain, GRAVITY, WORKER_R);
    if (res.broke) {
      this.fx({ k: 'sfx', s: 'release' });
      this.ui.toast('Der Haken hat keinen Halt mehr!', '#ff8f00');
    }
    w.still = 0;
    if (w.y > this.waterY + 4) this.drown(w);
  }

  // Wie in Worms: Wer das Seil loslässt und im freien Flug in Kollegen kracht,
  // schubst sie weg (ohne Schaden). Am Seil hängend wird niemand geschubst.
  ropeKnock(w) {
    for (const o of this.workers) {
      if (o === w || o.dead) continue;
      const d = Math.hypot(o.x - w.x, o.y - w.y);
      if (d > WORKER_R * 2 + 2) { o.knocked = false; continue; }
      if (o.knocked) continue;
      const v = knockHit(w, o, WORKER_R);
      if (!v) continue;
      o.knocked = true;
      o.vx += v.vx; o.vy += v.vy; o.grounded = false;
      w.vx *= KNOCK.KEEP; w.vy *= KNOCK.KEEP;
      this.fx({ k: 'sfx', s: 'bonk' });
      this.fx({ k: 'puff', x: r1((o.x + w.x) / 2), y: r1((o.y + w.y) / 2), c: '#ffcc80' });
    }
  }

  utilityPhysics(w, dt) {
    const mv = this.mv;
    const k = this.ai ? this.ai.keys : this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA');
    const right = k.has('ArrowRight') || k.has('KeyD');
    const up = k.has('ArrowUp') || k.has('KeyW');
    const input = this.tp === 'aim' || this.tp === 'retreat';
    const dir = input && left !== right ? (left ? -1 : 1) : 0;
    switch (mv.kind) {
      case 'rope': {
        if (mv.hook) {
          const r = hookStep(mv, w, dt, this.terrain, { w: W, waterY: this.waterY });
          if (r === 'attach') { w.grounded = false; this.fx({ k: 'sfx', s: 'clank' }); }
          else if (r === 'miss') this.fx({ k: 'sfx', s: 'release' });
        }
        if (mv.pts) { this.ropePhysics(w, dt, dir, input); return; }
        // Losgelassen: Schwung bleibt, normaler Fallschaden über der Sicherheitshöhe.
        // Nur jetzt (freier Flug) rempelt man Kollegen um.
        this.physicsWorker(w, dt);
        if (!w.grounded && !w.dead) this.ropeKnock(w);
        if (w.grounded && !mv.hook) this.mv = null; // gelandet: Gurt wieder eingerollt
        return;
      }
      case 'jet': {
        const thrust = input && up && mv.fuel > 0;
        mv.th = thrust || (dir !== 0 && !w.grounded);
        if (thrust) w.grounded = false;
        this.physicsWorker(w, dt, {
          safe: true,
          force: (o, h) => {
            if (thrust) { o.vy -= 1180 * h; mv.fuel -= h; }
            if (dir && !o.grounded) { o.vx += dir * 520 * h; mv.fuel -= h * 0.4; }
            o.vx *= 1 - 0.9 * h;
            o.vy = Math.max(-320, Math.min(520, o.vy));
            o.vx = Math.max(-280, Math.min(280, o.vx));
          },
        });
        if (mv.fuel <= 0) { this.endUtility(); this.ui.toast('Druckluft leer!', '#90caf9'); }
        break;
      }
      case 'chute': {
        if (!mv.open && !w.grounded && w.vy > 160) this.openChute(w);
        const wind = this.turn?.wind || 0;
        this.physicsWorker(w, dt, mv.open ? {
          safe: true,
          force: (o, h) => {
            if (o.vy > 70) o.vy += (70 - o.vy) * Math.min(1, h * 6);
            const tvx = wind * 110 + dir * 70;
            o.vx += (tvx - o.vx) * Math.min(1, h * 2);
          },
        } : null);
        if (mv.open && w.grounded) this.mv = null;
        break;
      }
      case 'bungee': {
        if (!mv.anchor && !w.grounded) mv.anchor = { x: w.x, y: w.y - 2 };
        this.physicsWorker(w, dt, mv.anchor ? {
          safe: true, float: true,
          force: (o, h) => {
            const dx = o.x - mv.anchor.x, dy = o.y - mv.anchor.y, d = Math.hypot(dx, dy);
            if (d > BUNGEE_REST) {
              const f = BUNGEE_K * (d - BUNGEE_REST) * h;
              o.vx -= (dx / d) * f; o.vy -= (dy / d) * f;
              mv.taut = true;
            } else if (mv.taut && d < BUNGEE_REST * 0.7) mv.taut = false;
            o.vx *= 1 - 0.7 * h; o.vy *= 1 - 0.7 * h;
            if (dir) o.vx += dir * 200 * h;
          },
        } : null);
        // Wieder auf festem Boden (z.B. zurück auf die Kante geschnellt) -> abhaken
        if (mv.anchor && this.isGrounded(w, WORKER_R) && Math.hypot(w.vx, w.vy) < 40) { w.grounded = true; w.vx = 0; w.vy = 0; this.mv = null; }
        break;
      }
    }
  }

  // ---------- Dauerfeuer & Bohrhammer ----------
  burstStep(w, dt) {
    const b = this.burst;
    b.t -= dt;
    if (b.t > 0) return;
    b.t = 0.075;
    const wpn = WEAPON_BY_ID.tacker;
    const a = w.aim + (Math.random() - 0.5) * 2 * wpn.spread;
    const dir = { x: Math.cos(a) * w.facing, y: Math.sin(a) };
    this.scan(w, w.x + dir.x * (WORKER_R + 7), w.y + dir.y * (WORKER_R + 7), dir, wpn, '#cfd8dc');
    if (b.n % 3 === 0) this.fx({ k: 'anim', id: w.id, a: 'shoot' });
    if (--b.n <= 0) this.burst = null;
  }

  drillStep(w, dt) {
    const d = this.drill;
    d.t -= dt;
    w.vx = 0; w.vy = 0; w.grounded = true; w.walking = false;
    const dir = d.dir;
    const R = WEAPON_BY_ID.bohrer.radius;
    // Vor dem Arbeiter Material abtragen
    d.acc += dt;
    if (d.acc >= 0.11) {
      d.acc = 0;
      this.sendOp({ k: 'boom', x: r1(w.x + dir.x * 8), y: r1(w.y + dir.y * 8), r: R }, false);
      this.renderer.puff(w.x + dir.x * 14, w.y + dir.y * 14, '#b98b54');
      this.fx({ k: 'sfx', s: 'drill' });
      this.fx({ k: 'anim', id: w.id, a: 'drill' });
    }
    const nx = w.x + dir.x * 46 * dt, ny = w.y + dir.y * 46 * dt;
    if (!this.terrain.hitsCircle(nx, ny, WORKER_R - 1)) { w.x = nx; w.y = ny; }
    else if (dir.y < 0.7 && !this.terrain.hitsCircle(nx, ny - 2, WORKER_R - 1)) { w.x = nx; w.y = ny - 2; }
    if (d.t <= 0 || w.y > this.waterY - 14 || w.x < 12 || w.x > W - 12) this.stopDrill();
  }

  stopDrill() {
    this.drill = null;
    const w = this.activeWorker();
    if (w) w.grounded = false;
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
    let control = false;
    this.manualCam = false;

    // Am Seil (oder Haken in der Luft): nur Abwurf- und Zielwaffen, wie in Worms
    if (this.onRope() && !wpn.util && !ROPE_WEAPON_KINDS.includes(wpn.kind)) {
      this.ui.toast('Vom Seil aus geht nur Abwerfen (Granaten, Gas, Stapler) oder Zielwaffen.', '#ff8f00');
      return;
    }
    const roped = this.onRope();

    // Hilfsmittel: Zug läuft weiter
    if (wpn.util) {
      if (this.mv) return;
      if (!this.startUtility(w, wpn)) return;
      this.spendAmmo(wpn);
      return;
    }

    switch (wpn.kind) {
      case 'projectile': {
        const sp = 120 + power * 900;
        this.projectiles.push({ type: wpn.id, wpn, x: sx, y: sy, vx: dir.x * sp, vy: dir.y * sp, r: 3, rot: 0, facing: 1, age: 0 });
        this.fx({ k: 'sfx', s: 'shoot' });
        this.fx({ k: 'anim', id: w.id, a: 'shoot' });
        break;
      }
      case 'grenade': {
        if (roped) {
          // Abwurf vom Seil: fällt mit dem Schwung des Arbeiters
          this.projectiles.push({ type: wpn.id, wpn, x: w.x, y: w.y + WORKER_R + 5, vx: w.vx * 0.9, vy: w.vy * 0.9, r: 4, rot: 0, facing: w.facing, fuse: wpn.fuse, age: 0 });
          this.fx({ k: 'sfx', s: 'thud' });
          this.fx({ k: 'anim', id: w.id, a: 'drop' });
          break;
        }
        const sp = 100 + power * 650;
        this.projectiles.push({ type: wpn.id, wpn, x: sx, y: sy, vx: dir.x * sp, vy: dir.y * sp, r: 4, rot: 0, facing: w.facing, fuse: wpn.fuse, age: 0 });
        this.fx({ k: 'sfx', s: 'throw' });
        this.fx({ k: 'anim', id: w.id, a: 'throw' });
        break;
      }
      case 'homing': {
        if (!this.homeTarget) return;
        const sp = 150 + power * 750;
        this.projectiles.push({ type: 'sendung', wpn, x: sx, y: sy, vx: dir.x * sp, vy: dir.y * sp, r: 3, rot: 0, facing: 1, age: 0, target: { ...this.homeTarget } });
        this.homeTarget = null;
        this.fx({ k: 'sfx', s: 'shoot' });
        this.fx({ k: 'sfx', s: 'beep' });
        this.fx({ k: 'anim', id: w.id, a: 'shoot' });
        break;
      }
      case 'burst': {
        this.burst = { n: wpn.shots, t: 0 };
        control = true;
        break;
      }
      case 'drill': {
        this.drill = { t: 3.5, acc: 1, dir };
        control = true;
        break;
      }
      case 'uppercut': {
        let hit = false;
        for (const o of this.workers) {
          if (o === w || o.dead) continue;
          const dx = o.x - w.x, dy = o.y - w.y;
          if (dx * w.facing > -4 && Math.abs(dx) < 30 && dy < 16 && dy > -60) {
            this.damage(o, wpn.damage);
            o.vx = w.facing * 150; o.vy = -620; o.grounded = false;
            hit = true;
          }
        }
        w.vx = w.facing * 40; w.vy = -470; w.grounded = false;
        this.fx({ k: 'anim', id: w.id, a: 'uppercut' });
        this.fx({ k: 'sfx', s: 'swing' });
        if (hit) {
          this.fx({ k: 'sfx', s: 'stamp' });
          this.fx({ k: 'float', x: r1(w.x + w.facing * 20), y: r1(w.y - 40), text: 'ABGESTEMPELT!', c: '#e53935' });
        }
        break;
      }
      case 'drone': {
        const a = Math.atan2(dir.y, dir.x);
        const p = { type: 'drohne', wpn, x: w.x, y: w.y - 18, vx: 0, vy: 0, r: 5, rot: a, heading: a, facing: 1, fuse: wpn.fuse, age: 0 };
        this.projectiles.push(p);
        this.walker = p;
        control = true;
        this.fx({ k: 'anim', id: w.id, a: 'radio' });
        break;
      }
      case 'heavy': {
        if (!target) return;
        this.projectiles.push({ type: 'tresor', wpn, x: Math.max(20, Math.min(W - 20, target.x)), y: -80, vx: 0, vy: 380, r: 9, rot: 0, facing: 1, age: 0, hits: 0 });
        this.fx({ k: 'msg', text: 'Achtung, Schwerlast von oben!', color: '#90a4ae' });
        this.fx({ k: 'anim', id: w.id, a: 'radio' });
        this.fx({ k: 'sfx', s: 'whistle' });
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
        const p = { type: 'stapler', wpn, x: w.x + w.facing * (roped ? 4 : 16), y: w.y + (roped ? WORKER_R + 8 : -4), vx: w.facing * 60, vy: -80, r: 7, rot: 0, facing: w.facing, fuse: wpn.fuse, age: 0, grounded: false, stuck: 0 };
        this.projectiles.push(p);
        this.walker = p;
        this.fx({ k: 'sfx', s: 'engine' });
        this.fx({ k: 'anim', id: w.id, a: 'drop' });
        break;
      }
      case 'drop': {
        this.projectiles.push({ type: 'gas', wpn, x: w.x + (roped ? 0 : w.facing * 12), y: w.y + (roped ? WORKER_R + 6 : -4), vx: roped ? w.vx * 0.9 : w.facing * 40, vy: roped ? w.vy * 0.9 : -60, r: 5, rot: 0, facing: 1, fuse: wpn.fuse, age: 0 });
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
        if (target.y > this.waterY - 10 || target.x < 10 || target.x > W - 10 || !isFree(this.terrain.mat, target.x, target.y, WORKER_R + 1)) {
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

    this.spendAmmo(wpn);

    if (endTurnNow) {
      this.tp = 'resolve';
    } else if (control) {
      this.tp = 'control';
    } else {
      this.tp = 'retreat';
      this.retreatEnd = performance.now() + (this.rules.retreatTime ?? RETREAT_TIME) * 1000;
    }
  }

  spendAmmo(wpn) {
    if (!this.used.includes(wpn.id)) this.used.push(wpn.id);
    const team = this.teams[this.turn.team];
    if (team && team.ammo[wpn.id] > 0) team.ammo[wpn.id] -= 1;
    this.ui.refreshWeapons();
  }

  scan(w, sx, sy, dir, wpn, color = null) {
    let x = sx, y = sy;
    let hitWorker = null;
    for (let i = 0; i < 500; i++) {
      x += dir.x * 2; y += dir.y * 2;
      if (x < -50 || x > W + 50 || y < -400 || y > this.waterY) break;
      hitWorker = this.workers.find((o) => o !== w && !o.dead && Math.hypot(o.x - x, o.y - y) < WORKER_R + 1);
      if (hitWorker) break;
      if (this.terrain.solid(x, y)) break;
    }
    this.fx({ k: 'laser', x1: r1(sx), y1: r1(sy), x2: r1(x), y2: r1(y), ...(color ? { c: color } : {}) });
    if (hitWorker) {
      this.damage(hitWorker, wpn.damage);
      const push = wpn.push ?? 160;
      hitWorker.vx += dir.x * push; hitWorker.vy += dir.y * push - push / 2; hitWorker.grounded = false;
      if (!color) this.fx({ k: 'sfx', s: 'beep' });
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
      if (p.dead || ['palette', 'paket', 'sendung', 'tresor', 'drohne'].includes(p.type)) continue;
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
    if (p.type === 'retoure2') {
      this.explode(p.x, p.y, 36, 28);
      return;
    }
    this.explode(p.x, p.y, wpn.radius, wpn.damage);
    if (wpn.cluster) {
      const big = wpn.clusterType === 'retoure2';
      for (let i = 0; i < wpn.cluster; i++) {
        const a = -Math.PI / 2 + (i - (wpn.cluster - 1) / 2) * (big ? 0.38 : 0.45);
        const sp = big ? 280 + Math.random() * 160 : 220 + Math.random() * 120;
        this.projectiles.push({ type: big ? 'retoure2' : 'frag', wpn, x: p.x, y: p.y - 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: big ? 3 : 2, rot: 0, facing: 1, age: 0 });
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
      case 'sendung': {
        // Erst normal fliegen, dann den Empfänger anpeilen
        const homing = p.age > 0.35 && p.age < 3.5;
        if (homing) {
          const want = Math.atan2(p.target.y - p.y, p.target.x - p.x);
          const cur = Math.atan2(p.vy, p.vx);
          let da = want - cur;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          const turn = Math.max(-1, Math.min(1, da)) * 5 * dt;
          const sp = Math.min(620, Math.max(380, Math.hypot(p.vx, p.vy)) + 300 * dt);
          p.vx = Math.cos(cur + turn) * sp; p.vy = Math.sin(cur + turn) * sp;
          if (!p.locked) { p.locked = true; this.fx({ k: 'sfx', s: 'beep' }); }
        } else {
          p.vy += GRAVITY * dt;
          p.vx += wind * WIND_ACC * dt * 0.5;
        }
        const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
        for (let i = 0; i < steps; i++) {
          p.x += (p.vx * dt) / steps;
          p.y += (p.vy * dt) / steps;
          if (this.terrain.solid(p.x, p.y) || this.hitsWorker(p)) { this.explodeProjectile(p); break; }
        }
        p.rot = Math.atan2(p.vy, p.vx);
        break;
      }
      case 'drohne': {
        this.fuseTick(p, dt);
        if (p.fuse <= 0) { this.explodeProjectile(p); break; }
        if (p.age < 0.4) {
          // Abheben: erst senkrecht hoch, damit die Drohne nicht am eigenen Arbeiter zerschellt
          if (!this.terrain.hitsCircle(p.x, p.y - 2, p.r)) p.y -= 140 * dt;
          p.rot = p.heading;
          break;
        }
        const sp = 240;
        p.vx = Math.cos(p.heading) * sp; p.vy = Math.sin(p.heading) * sp;
        const steps = Math.max(1, Math.ceil((sp * dt) / 2));
        for (let i = 0; i < steps; i++) {
          p.x += (p.vx * dt) / steps;
          p.y += (p.vy * dt) / steps;
          if (this.terrain.hitsCircle(p.x, p.y, p.r) || (p.age > 0.4 && this.hitsWorker(p, 2))) { this.explodeProjectile(p); break; }
        }
        if (p.y < -500) p.heading = Math.PI / 2; // nicht aus der Halle fliegen
        p.rot = p.heading;
        break;
      }
      case 'tresor': {
        p.vy = Math.min(700, p.vy + GRAVITY * dt);
        const steps = Math.max(1, Math.ceil((p.vy * dt) / 2));
        for (let i = 0; i < steps; i++) {
          p.y += (p.vy * dt) / steps;
          if (p.y > 0 && (this.terrain.hitsCircle(p.x, p.y, p.r) || this.hitsWorker(p))) {
            p.hits++;
            this.explode(p.x, p.y + 4, p.wpn.radius, p.wpn.damage);
            this.fx({ k: 'sfx', s: 'clang' });
            p.vy = 160;
            if (p.hits >= p.wpn.hits) p.dead = true;
            break;
          }
        }
        p.rot = Math.sin(p.age * 2) * 0.08;
        break;
      }
      case 'paket':
      case 'palette':
      case 'retoure2':
      case 'frag': {
        p.vy += GRAVITY * dt;
        if (p.type === 'paket' || p.type === 'palette') p.vx += wind * WIND_ACC * dt;
        const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
        for (let i = 0; i < steps; i++) {
          p.x += (p.vx * dt) / steps;
          p.y += (p.vy * dt) / steps;
          if (this.terrain.solid(p.x, p.y) || this.hitsWorker(p)) { this.explodeProjectile(p); break; }
        }
        p.rot = p.type === 'palette' ? Math.sin(p.age * 3) * 0.2 : p.type === 'retoure2' ? p.rot + dt * 8 : Math.atan2(p.vy, p.vx);
        break;
      }
      case 'folie':
      case 'kiste':
      case 'retoure':
      case 'fass':
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
    if (!p.dead && (p.y > this.waterY + 4 || p.x < -500 || p.x > W + 500 || p.y > H + 100)) {
      p.dead = true;
      if (p.y > this.waterY) this.fx({ k: 'splash', x: p.x });
    }
  }

  fuseTick(p, dt) {
    const before = Math.ceil(p.fuse);
    p.fuse -= dt;
    if (Math.ceil(p.fuse) !== before && p.fuse > 0) this.fx({ k: 'sfx', s: 'fuse' });
    if (p.type === 'fass' && !p.sang && p.fuse < 0.9) { p.sang = true; this.fx({ k: 'sfx', s: 'choir' }); }
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
      am: (this.tp === 'aim' || this.burst) && w && !w.dead ? 1 : 0,
      rt: Math.round(this.retreatLeft() * 10) / 10,
      tl: Math.round(this.timeLeft() * 10) / 10,
      mv: this.gearState(),
    });
  }

  // Hilfsmittel kompakt für Darstellung & Snapshot: {k, on, p:[x,y,...]} (p: Anker → Knickpunkte bzw. Haken)
  gearState() {
    const mv = this.mv;
    if (this.drill) return { k: 'drill', on: 1 };
    if (!mv) return 0;
    const flat = (pts) => pts.flatMap((q) => [r1(q.x), r1(q.y)]);
    switch (mv.kind) {
      case 'rope':
        if (mv.pts) return { k: 'rope', on: 1, p: flat(mv.pts) };
        if (mv.hook) return { k: 'rope', on: 0, p: flat([mv.hook]) };
        return 0;
      case 'jet': return { k: 'jet', on: mv.th ? 1 : 0, f: Math.round(mv.fuel * 10) / 10 };
      case 'chute': return mv.open ? { k: 'chute', on: 1 } : 0;
      case 'bungee': return mv.anchor ? { k: 'bungee', on: mv.taut ? 1 : 0, p: flat([mv.anchor]) } : 0;
    }
    return 0;
  }

  endTurn() {
    if (this.tp === 'done') return;
    this.tp = 'done';
    this.sendSnap();
    this.net.send({
      t: 'turnEnd',
      n: this.turnN,
      workers: this.workers.map((w) => ({ id: w.id, x: r1(w.x), y: r1(w.y), hp: w.hp, dead: w.dead })),
      used: this.used.filter((id) => WEAPON_BY_ID[id]?.ammo > 0),
    });
  }

  // ---------- Darstellung ----------
  focusPoint() {
    if (this.manualCam) return null;
    const p = this.projectiles.find((x) => !x.dead);
    if (p) return p;
    const flying = this.workers.find((w) => !w.dead && !w.grounded && Math.hypot(w.vx || 0, w.vy || 0) > 250);
    if (flying && this.sim) return flying;
    const a = this.activeWorker();
    return a && !a.dead ? { x: a.rx ?? a.x, y: a.ry ?? a.y } : null;
  }

  render(dt) {
    if (!this.terrain || !this.state || this.state.phase === 'lobby') return;
    const active = this.activeWorker();
    const wpnId = this.sim ? this.weapon : this.remote.weapon;
    const wpn = WEAPON_BY_ID[wpnId] || WEAPON_BY_ID.paket;
    const aiming = this.sim ? this.tp === 'aim' || !!this.burst : this.remote.aiming;
    const playing = this.state.phase === 'playing';
    const gear = playing ? (this.sim ? this.gearState() : this.remote.mv) : 0;
    let held = playing && aiming ? { id: wpn.id, aimArm: AIM_KINDS.includes(wpn.kind) } : null;
    if (gear && active && gear.k !== 'drill') {
      // Hand am Gurt (zeigt zum letzten Knickpunkt), am Fallschirm nach oben
      let armAngle = gear.k === 'chute' ? Math.PI / 2 : 0.3;
      if (gear.p?.length) {
        const px = gear.p[gear.p.length - 2], py = gear.p[gear.p.length - 1];
        armAngle = -Math.atan2(py - (active.ry ?? active.y), (px - (active.rx ?? active.x)) * (active.facing < 0 ? -1 : 1));
      }
      held = { id: gear.k === 'rope' ? 'seilhand' : 'empty', armAngle };
    } else if (gear && gear.k === 'drill') held = { id: 'bohrer', aimArm: true };
    const charge = this.sim ? this.charge : this.remote.charge;
    this.renderer.syncWorkers(this.workers, this.teams, playing ? active?.id : -1, held, aiming ? charge : 0, dt);
    this.renderer.setProjectiles(this.projectiles.filter((p) => !p.dead), dt);
    this.renderer.syncGraves(this.graves, this.teams);
    const showAim = !!active && !active.dead && aiming && !(gear && gear.k === 'rope' && gear.on) && (!wpn.target || wpn.kind === 'homing') && AIM_KINDS.includes(wpn.kind);
    this.renderer.showGear(active && !active.dead && gear ? { ...gear, x: active.rx ?? active.x, y: active.ry ?? active.y, facing: active.facing } : null, dt);
    if (active) {
      this.renderer.showAim({ x: active.rx ?? active.x, y: active.ry ?? active.y }, active.aim, active.facing, this.sim ? this.charge : this.remote.charge, showAim);
    } else {
      this.renderer.showAim(null, 0, 1, 0, false);
    }
    if (this.myTurn && this.tp === 'aim' && wpn.target) {
      const t = wpn.kind === 'homing' && this.homeTarget ? this.homeTarget : this.mouse;
      this.renderer.showTarget(wpn.kind === 'girder' ? 'girder' : 'point', t.x, t.y, this.girderAngle);
    } else {
      this.renderer.showTarget(null);
    }
    this.renderer.frame(dt, this.focusPoint());
  }
}

export { MAX_HP };
