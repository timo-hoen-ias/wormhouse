// Spielraum-Logik, unabhängig von der Plattform: läuft auf dem Server im Durable
// Object (src/server/room.js) und – für Einzelspieler/Hotseat, auch offline –
// direkt im Browser (src/client/localroom.js). `ctx` muss bieten:
// storage.put/setAlarm/deleteAlarm und getWebSockets(); Sockets brauchen
// send, readyState, serializeAttachment und deserializeAttachment.
//
// Ein Spielraum = ein Durable Object.
// Der Server ist Schiedsrichter für Lobby, Regeln, Zugreihenfolge, Zeitlimit,
// Munition, Sudden Death und Sieg. Die Physik eines Zuges simuliert der Client
// des aktiven Spielers und streamt Snapshots; KI-Teams werden vom Client der
// Schichtleitung (Host) gesteuert. Geländeänderungen werden als Operationen
// gespeichert, damit Nachzügler und Reconnects das Level exakt rekonstruieren.
import {
  TURN_GRACE_MS, MAX_PLAYERS, TEAM_COLORS, WORKER_NAMES, WATER_Y,
} from './constants.js';
import { WEAPON_BY_ID } from './weapons.js';

const WATCHDOG_MS = 2000; // so oft prüft der Server, ob der Zug noch lebt
const STALL_MS = 6000; // so lange ohne Snapshot = Client hängt, Zug wird beendet
import {
  defaultRules, sanitizeRules, ammoFromRules, BOT_LEVELS, BOT_TEAM_NAMES, MAX_TEAMS,
  SUDDEN_WATER_STEP, MIN_WATER_Y,
} from './rules.js';
import { resolveMap, isRopeMap, DEFAULT_MAP, DEFAULT_COMPLEXITY } from './maps.js';

const CHAT_KEEP = 40;

// crypto.randomUUID gibt es nur in sicheren Kontexten (https/localhost).
const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));

const newSeed = () => (Math.random() * 2 ** 31) >>> 0;

function freshState() {
  return {
    phase: 'lobby', // lobby | playing | ended
    hostPid: null,
    solo: false, // Einzelspieler-Raum: niemand sonst kann mitspielen
    players: [], // {pid, name, team, color, connected}
    bots: [], // {id, name, color, level, human} – human = lokaler Spieler am Gerät der Schichtleitung (Hotseat)
    rules: defaultRules(),
    seed: 0,
    mapSeed: newSeed(), // Seed der nächsten Karte (Vorschau in der Lobby)
    map: { id: DEFAULT_MAP, complexity: DEFAULT_COMPLEXITY }, // aufgelöste Karte des laufenden Spiels
    teams: [], // {pid|null, bot (Stufe, 0 = keiner), name, color, ammo, nextWorker}
    workers: [], // {id, team, name, x, y, hp, dead}
    turn: null, // {n, team, worker, wind, endsAt}
    ops: [],
    winner: null,
    game: 0,
    startedAt: 0,
    sudden: false,
    waterY: WATER_Y,
    chat: [],
  };
}

const clampStr = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

export class RoomLogic {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = freshState();
    this.lastSnapWorkers = null;
  }

  // Gespeicherten Stand übernehmen (nach Neustart des Durable Objects).
  restore(saved, livePids) {
    // Ältere Spielstände um neue Felder ergänzen.
    if (saved) this.s = { ...freshState(), ...saved, rules: sanitizeRules(saved.rules) };
    // Nach einem Neustart gilt erstmal niemand als verbunden, bis seine Sockets sich wieder melden.
    for (const p of this.s.players) p.connected = livePids.has(p.pid);
  }

  // ---------- Helfer ----------
  save() {
    return this.ctx.storage.put('state', this.s);
  }

  publicState() {
    const s = this.s;
    return {
      ...s,
      ops: undefined,
      chat: undefined,
      opCount: s.ops.length,
      turnMsLeft: s.turn ? Math.max(0, s.turn.endsAt - Date.now()) : 0,
    };
  }

  send(ws, msg) {
    try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* Socket weg */ }
  }

  broadcast(msg, except = null) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) this.send(ws, data);
    }
  }

  broadcastState() {
    this.broadcast({ t: 'state', state: this.publicState() });
  }

  chat(entry) {
    const s = this.s;
    s.chat.push(entry);
    if (s.chat.length > CHAT_KEEP) s.chat.splice(0, s.chat.length - CHAT_KEEP);
    this.broadcast({ t: 'chat', ...entry });
  }

  sys(text) {
    this.chat({ sys: true, text });
  }

  // Wer simuliert den laufenden Zug? Menschen sich selbst, KI-Teams und lokale
  // Mitspieler (Hotseat) die Schichtleitung.
  controllerOf(team) {
    if (!team) return null;
    if (team.pid) return team.pid;
    return team.bot > 0 || team.local ? this.s.hostPid : null;
  }

  activePid() {
    const s = this.s;
    if (s.phase !== 'playing' || !s.turn) return null;
    return this.controllerOf(s.teams[s.turn.team]);
  }

  isActive(att) {
    return !!att.pid && att.pid === this.activePid();
  }

  isHost(att) {
    return !!att.pid && att.pid === this.s.hostPid;
  }

  teamAlive(i) {
    return this.s.workers.some((w) => w.team === i && !w.dead);
  }

  teamCount() {
    return this.s.players.length + this.s.bots.length;
  }

  freeColor(except = null) {
    const used = new Set([...this.s.players, ...this.s.bots].filter((x) => x !== except).map((x) => x.color));
    return TEAM_COLORS.find((c) => !used.has(c)) || '#ffffff';
  }

  addBot(level = 2, human = false) {
    const s = this.s;
    if (s.phase !== 'lobby' || this.teamCount() >= MAX_TEAMS) return false;
    const usedNames = new Set([...s.players.map((p) => p.team), ...s.bots.map((b) => b.name)]);
    if (human) {
      let n = 2;
      while (usedNames.has(`Spieler ${n}`)) n++;
      s.bots.push({ id: uid().slice(0, 8), name: `Spieler ${n}`, color: this.freeColor(), level: Math.max(1, level), human: true });
      return true;
    }
    // „Inventur-Dummies“ bleibt den reinen Zielscheiben vorbehalten.
    const pool = level === 0 ? BOT_TEAM_NAMES : BOT_TEAM_NAMES.slice(1);
    const name = pool.find((n) => !usedNames.has(n)) || `KI-Team ${s.bots.length + 1}`;
    s.bots.push({ id: uid().slice(0, 8), name, color: this.freeColor(), level });
    return true;
  }

  // ---------- Spielablauf ----------
  startGame() {
    const s = this.s;
    const humans = s.players.filter((p) => p.connected);
    if (!humans.length) return false;
    const r = s.rules;
    const bots = [...s.bots];
    if (humans.length + bots.length < 2) {
      // Allein ohne Gegner: Zielscheiben aufstellen (Übungsmodus).
      bots.push({ name: BOT_TEAM_NAMES[0], color: '#9e9e9e', level: 0 });
    }
    s.seed = s.mapSeed || newSeed();
    s.mapSeed = newSeed(); // Revanche/nächste Lobby bekommt eine frische Halle
    s.map = { id: resolveMap(r.map), complexity: r.complexity };
    s.game += 1;
    const ammo = ammoFromRules(r);
    // Seil-Karten: Spanngurt unbegrenzt, sofern die Schichtleitung nichts anderes eingestellt hat.
    if (isRopeMap(s.map.id) && r.ammo?.seil == null) ammo.seil = -1;
    s.teams = [
      ...humans.map((p) => ({ pid: p.pid, bot: 0, name: p.team || p.name, color: p.color })),
      ...bots.map((b) => (b.human
        ? { pid: null, bot: 0, local: true, botId: b.id ?? null, name: b.name, color: b.color }
        : { pid: null, bot: b.level, botId: b.id ?? null, name: b.name, color: b.color })),
    ].map((t) => ({ ...t, ammo: { ...ammo }, nextWorker: 0 }));
    const names = [...WORKER_NAMES].sort(() => Math.random() - 0.5);
    s.workers = [];
    let id = 0;
    // Abwechselnd zuteilen, damit die Spawn-Reihenfolge fair gemischt ist.
    for (let k = 0; k < r.workersPerTeam; k++) {
      for (let t = 0; t < s.teams.length; t++) {
        s.workers.push({ id, team: t, name: names[id % names.length], x: null, y: null, hp: r.hp, dead: false });
        id++;
      }
    }
    s.ops = [];
    s.winner = null;
    s.sudden = false;
    s.waterY = WATER_Y;
    s.startedAt = Date.now();
    s.phase = 'playing';
    const first = Math.floor(Math.random() * s.teams.length);
    s.turn = { n: 0, team: (first + s.teams.length - 1) % s.teams.length, worker: -1, wind: 0, endsAt: 0 };
    this.advanceTurn(true); // geht eins weiter
    return true;
  }

  pickWorker(teamIdx) {
    const s = this.s;
    const team = s.teams[teamIdx];
    const mine = s.workers.filter((w) => w.team === teamIdx);
    for (let k = 0; k < mine.length; k++) {
      const w = mine[(team.nextWorker + k) % mine.length];
      if (!w.dead) {
        team.nextWorker = (mine.indexOf(w) + 1) % mine.length;
        return w.id;
      }
    }
    return -1;
  }

  // Sudden Death: alle auf 1 HP, danach steigt das Hafenbecken mit jedem Zug.
  suddenDeathTick(first) {
    const s = this.s;
    const r = s.rules;
    if (first || !r.suddenDeath) return;
    if (!s.sudden && Date.now() >= s.startedAt + r.suddenDeath * 60000) {
      s.sudden = true;
      for (const w of s.workers) if (!w.dead) w.hp = 1;
      this.sys('🚨 SUDDEN DEATH! Alle Arbeiter auf 1 HP' + (r.suddenWater ? ' – und das Hafenbecken läuft voll!' : '!'));
      return;
    }
    if (s.sudden && r.suddenWater) {
      s.waterY = Math.max(MIN_WATER_Y, s.waterY - SUDDEN_WATER_STEP);
      for (const w of s.workers) {
        if (!w.dead && w.y != null && w.y > s.waterY + 4) { w.dead = true; w.hp = 0; }
      }
    }
  }

  advanceTurn(first = false) {
    const s = this.s;
    this.lastSnapWorkers = null;
    this.suddenDeathTick(first);
    const alive = s.teams.map((_, i) => this.teamAlive(i));
    const aliveCount = alive.filter(Boolean).length;
    if (!first && aliveCount <= 1) {
      s.phase = 'ended';
      s.winner = aliveCount === 1 ? alive.indexOf(true) : -1;
      s.turn = null;
      this.ctx.storage.deleteAlarm();
      return;
    }
    const connected = new Set(s.players.filter((p) => p.connected).map((p) => p.pid));
    let next = -1;
    for (let k = 1; k <= s.teams.length; k++) {
      const i = (s.turn.team + k) % s.teams.length;
      const c = this.controllerOf(s.teams[i]);
      if (c && alive[i] && connected.has(c)) { next = i; break; }
    }
    if (next < 0) {
      // Keiner da, der ziehen kann: Zug bleibt stehen, bis jemand zurückkommt.
      next = s.turn.team;
    }
    s.turn = {
      n: s.turn.n + 1,
      team: next,
      worker: this.pickWorker(next),
      wind: Math.round((Math.random() * 2 - 1) * s.rules.wind * 100) / 100,
      endsAt: Date.now() + s.rules.turnTime * 1000,
    };
    this.lastSnapAt = Date.now();
    this.scheduleWatchdog();
  }

  anyoneCanMove() {
    const s = this.s;
    const connected = new Set(s.players.filter((p) => p.connected).map((p) => p.pid));
    return s.teams.some((t, i) => this.teamAlive(i) && connected.has(this.controllerOf(t)));
  }

  // Wachhund: Der simulierende Client schickt laufend Snapshots. Bleiben die aus
  // (Tab eingefroren, Rechner schläft, Verbindung hängt), wartet der Server nicht
  // bis zum Ende der Gnadenfrist, sondern macht nach STALL_MS weiter.
  scheduleWatchdog() {
    const s = this.s;
    if (s.phase !== 'playing' || !s.turn) return;
    this.ctx.storage.setAlarm(Math.min(s.turn.endsAt + TURN_GRACE_MS, Date.now() + WATCHDOG_MS));
  }

  async alarm() {
    const s = this.s;
    if (s.phase !== 'playing' || !s.turn) return;
    const now = Date.now();
    const activeConnected = s.players.find((p) => p.pid === this.activePid())?.connected;
    // Nach Ruhezustand (Hibernation) fehlt lastSnapAt: dann ab jetzt messen.
    if (this.lastSnapAt == null) this.lastSnapAt = now;
    const stalled = now - this.lastSnapAt > STALL_MS;
    if (!activeConnected && !this.anyoneCanMove()) return; // join() weckt uns wieder
    if (now >= s.turn.endsAt + TURN_GRACE_MS - 1000 || !activeConnected || stalled) {
      if (this.lastSnapWorkers) this.applyWorkers(this.lastSnapWorkers);
      this.advanceTurn();
      await this.save();
      this.broadcastState();
    } else {
      this.scheduleWatchdog();
    }
  }

  applyWorkers(list) {
    const byId = new Map(this.s.workers.map((w) => [w.id, w]));
    const maxHp = this.s.rules.hp;
    for (const u of list) {
      const w = byId.get(u.id);
      if (!w) continue;
      w.x = num(u.x, w.x);
      w.y = num(u.y, w.y);
      w.hp = Math.max(0, Math.min(maxHp, Math.round(num(u.hp, w.hp))));
      w.dead = !!u.dead || w.hp <= 0;
    }
  }

  // ---------- WebSocket-Ereignisse ----------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 64000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const s = this.s;
    const me = () => s.players.find((x) => x.pid === att.pid);

    switch (msg.t) {
      case 'join': {
        const pid = clampStr(msg.pid, 40) || uid();
        const name = clampStr(msg.name, 16) || 'Aushilfe';
        ws.serializeAttachment({ pid });
        const fresh = !s.players.length && s.phase === 'lobby';
        if (fresh) {
          // Erster im (leeren) Raum legt fest, ob es ein Einzelspieler-Raum ist.
          s.solo = !!msg.solo;
          s.bots = [];
          if (s.solo) this.addBot(Math.max(1, Math.min(BOT_LEVELS.length - 1, Math.round(num(msg.botLevel, 2)))));
        }
        let p = s.players.find((x) => x.pid === pid);
        let joined = false;
        if (p) {
          p.connected = true;
          if (s.phase === 'lobby') p.name = name;
        } else if (s.phase === 'lobby' && (!s.solo || fresh) && s.players.length < MAX_PLAYERS && this.teamCount() < MAX_TEAMS) {
          p = { pid, name, team: name, color: this.freeColor(), connected: true };
          s.players.push(p);
          joined = true;
        }
        if (!s.hostPid || !s.players.some((x) => x.pid === s.hostPid && x.connected)) {
          s.hostPid = s.players.find((x) => x.connected)?.pid ?? null;
        }
        this.send(ws, { t: 'welcome', pid, spectator: !p, solo: s.solo, chat: s.chat });
        if (s.phase !== 'lobby') this.send(ws, { t: 'ops', game: s.game, from: 0, ops: s.ops });
        if (joined && !s.solo) this.sys(`${name} hat eingestempelt.`);
        await this.save();
        this.broadcastState();
        // Falls gerade niemand ziehen konnte, jetzt weitermachen.
        if (s.phase === 'playing' && !s.players.find((x) => x.pid === this.activePid())?.connected) {
          this.ctx.storage.setAlarm(Date.now() + 1500);
        }
        break;
      }

      // ----- Lobby: eigenes Team -----
      case 'team': {
        const p = me();
        if (!p || s.phase !== 'lobby') return;
        if (msg.name != null) p.team = clampStr(msg.name, 20) || p.name;
        if (msg.color && TEAM_COLORS.includes(msg.color)
          && ![...s.players, ...s.bots].some((x) => x !== p && x.color === msg.color)) p.color = msg.color;
        await this.save();
        this.broadcastState();
        break;
      }

      // ----- Lobby: Schichtleitung -----
      case 'rules': {
        if (!this.isHost(att) || s.phase !== 'lobby') return;
        s.rules = sanitizeRules(msg.rules, s.rules);
        await this.save();
        this.broadcastState();
        break;
      }

      case 'reroll': {
        // Schichtleitung würfelt eine neue Halle (Vorschau = das, was gespielt wird)
        if (!this.isHost(att) || s.phase !== 'lobby') return;
        s.mapSeed = newSeed();
        await this.save();
        this.broadcastState();
        break;
      }

      case 'addBot': {
        if (!this.isHost(att)) return;
        const lvl = Math.max(0, Math.min(BOT_LEVELS.length - 1, Math.round(num(msg.level, 2))));
        if (this.addBot(lvl, !!msg.human)) { await this.save(); this.broadcastState(); }
        break;
      }

      case 'bot': {
        if (!this.isHost(att) || s.phase !== 'lobby') return;
        const b = s.bots.find((x) => x.id === msg.id);
        if (!b) return;
        if (msg.remove) s.bots = s.bots.filter((x) => x !== b);
        else {
          if (msg.human != null && !!msg.human !== !!b.human) {
            b.human = !!msg.human;
            // Standardnamen mitwechseln: aus „Spätschicht“ wird „Spieler 2“ und umgekehrt.
            const used = new Set([...s.players.map((p) => p.team), ...s.bots.filter((x) => x !== b).map((x) => x.name)]);
            if (b.human && BOT_TEAM_NAMES.includes(b.name)) {
              let n = 2;
              while (used.has(`Spieler ${n}`)) n++;
              b.name = `Spieler ${n}`;
            } else if (!b.human && /^Spieler \d+$/.test(b.name)) {
              b.name = BOT_TEAM_NAMES.slice(1).find((x) => !used.has(x)) || b.name;
            }
          }
          if (msg.level != null) b.level = Math.max(0, Math.min(BOT_LEVELS.length - 1, Math.round(num(msg.level, b.level))));
          if (msg.name != null) b.name = clampStr(msg.name, 20) || b.name;
          if (msg.color && TEAM_COLORS.includes(msg.color)
            && ![...s.players, ...s.bots].some((x) => x !== b && x.color === msg.color)) b.color = msg.color;
        }
        await this.save();
        this.broadcastState();
        break;
      }

      // KI-Stärke während der Schicht ändern (gilt ab dem nächsten Zug des Teams).
      case 'botLevel': {
        if (!this.isHost(att) || s.phase === 'lobby') return;
        const t = s.teams[Math.round(num(msg.team, -1))];
        if (!t || t.pid || !(t.bot > 0)) return;
        t.bot = Math.max(1, Math.min(BOT_LEVELS.length - 1, Math.round(num(msg.level, t.bot))));
        const b = s.bots.find((x) => x.id === t.botId);
        if (b) b.level = t.bot;
        this.sys(`🤖 ${t.name} spielt jetzt als ${BOT_LEVELS[t.bot].name}.`);
        await this.save();
        this.broadcastState();
        break;
      }

      case 'kick': {
        if (!this.isHost(att) || s.phase !== 'lobby' || msg.pid === att.pid) return;
        const p = s.players.find((x) => x.pid === msg.pid);
        if (!p) return;
        s.players = s.players.filter((x) => x !== p);
        for (const o of this.ctx.getWebSockets()) {
          if (o.deserializeAttachment()?.pid === p.pid) this.send(o, { t: 'kicked' });
        }
        this.sys(`${p.name} wurde von der Schichtleitung nach Hause geschickt.`);
        await this.save();
        this.broadcastState();
        break;
      }

      case 'start': {
        if (!this.isHost(att) || s.phase === 'playing') return;
        if (s.phase === 'ended') {
          // Revanche: Spieler, die gegangen sind, aus der Lobby entfernen.
          s.players = s.players.filter((p) => p.connected);
        }
        if (!this.startGame()) return;
        await this.save();
        this.broadcastState();
        this.broadcast({ t: 'ops', game: s.game, from: 0, ops: [] });
        break;
      }

      case 'lobby': {
        if (!this.isHost(att) || s.phase !== 'ended') return;
        s.phase = 'lobby';
        s.players = s.players.filter((p) => p.connected);
        await this.save();
        this.broadcastState();
        break;
      }

      case 'snap': {
        if (!this.isActive(att) || msg.n !== s.turn.n) return;
        this.lastSnapAt = Date.now();
        if (Array.isArray(msg.w)) {
          this.lastSnapWorkers = msg.w.map((a) => ({ id: a[0], x: a[1], y: a[2], hp: a[3], dead: a[4] }));
        }
        this.broadcast(raw, ws);
        break;
      }

      case 'fx': {
        if (!this.isActive(att)) return;
        this.broadcast(raw, ws);
        break;
      }

      case 'op': {
        if (!this.isActive(att) || msg.n !== s.turn.n || !msg.op) return;
        const o = msg.op;
        const op = o.k === 'boom'
          ? { k: 'boom', x: num(o.x), y: num(o.y), r: Math.min(120, Math.max(1, num(o.r, 10))) }
          : o.k === 'girder'
            ? { k: 'girder', x: num(o.x), y: num(o.y), a: num(o.a) }
            : null;
        if (!op) return;
        s.ops.push(op);
        this.broadcast({ t: 'op', game: s.game, i: s.ops.length - 1, op, fx: !!o.fx }, ws);
        break;
      }

      case 'turnEnd': {
        if (!this.isActive(att) || msg.n !== s.turn.n) return;
        if (Array.isArray(msg.workers)) this.applyWorkers(msg.workers);
        const team = s.teams[s.turn.team];
        for (const id of Array.isArray(msg.used) ? msg.used.slice(0, 5) : []) {
          if (WEAPON_BY_ID[id] && team.ammo[id] > 0) team.ammo[id] -= 1;
        }
        this.advanceTurn();
        await this.save();
        this.broadcastState();
        break;
      }

      case 'chat': {
        const p = me();
        const text = clampStr(msg.text, 140);
        if (!text) return;
        this.chat({ name: p?.name || 'Zuschauer', color: p?.color || '#aaa', text });
        await this.save();
        break;
      }

      case 'ping':
        this.send(ws, { t: 'pong', at: msg.at });
        break;
    }
  }

  async webSocketClose(ws) {
    await this.handleLeave(ws);
  }

  async webSocketError(ws) {
    await this.handleLeave(ws);
  }

  async handleLeave(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    const s = this.s;
    // Hat der Spieler noch eine andere offene Verbindung (z.B. zweiter Tab)?
    const stillThere = this.ctx.getWebSockets().some(
      (o) => o !== ws && o.readyState === 1 && o.deserializeAttachment()?.pid === pid,
    );
    if (stillThere) return;
    const wasActive = s.phase === 'playing' && this.activePid() === pid;
    const p = s.players.find((x) => x.pid === pid);
    if (s.phase === 'lobby') {
      s.players = s.players.filter((x) => x.pid !== pid);
      if (p && !s.solo) this.sys(`${p.name} hat ausgestempelt.`);
    } else if (p) {
      p.connected = false;
    }
    if (s.hostPid === pid) s.hostPid = s.players.find((x) => x.connected)?.pid ?? null;
    if (wasActive) {
      // Aktiver Spieler (oder Host während eines KI-Zugs) weg: nach kurzer Wartezeit weiter.
      this.ctx.storage.setAlarm(Date.now() + 8000);
    }
    await this.save();
    this.broadcastState();
  }
}
