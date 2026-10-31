// Ein Spielraum = ein Durable Object.
// Der Server ist Schiedsrichter für Lobby, Zugreihenfolge, Zeitlimit, Munition
// und Sieg. Die Physik eines Zuges simuliert der Client des aktiven Spielers
// und streamt Snapshots; Geländeänderungen werden als Operationen gespeichert,
// damit Nachzügler und Reconnects das Level exakt rekonstruieren können.
import { DurableObject } from 'cloudflare:workers';
import {
  TURN_TIME, TURN_GRACE_MS, MAX_HP, MAX_PLAYERS, TEAM_COLORS, WORKER_NAMES, BOT_TEAM_NAME,
} from '../shared/constants.js';
import { initialAmmo, WEAPON_BY_ID } from '../shared/weapons.js';

function freshState() {
  return {
    phase: 'lobby', // lobby | playing | ended
    hostPid: null,
    players: [], // {pid, name, color, connected}
    workersPerTeam: 3,
    seed: 0,
    teams: [], // {pid|null, name, color, ammo, nextWorker}
    workers: [], // {id, team, name, x, y, hp, dead}
    turn: null, // {n, team, worker, wind, endsAt}
    ops: [],
    winner: null,
    game: 0,
  };
}

const clampStr = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = freshState();
    this.lastSnapWorkers = null;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('state');
      if (saved) this.s = saved;
      // Nach einem Neustart des Objekts gilt erstmal niemand als verbunden,
      // bis seine Sockets sich wieder melden.
      const live = new Set(ctx.getWebSockets().map((ws) => ws.deserializeAttachment()?.pid));
      for (const p of this.s.players) p.connected = live.has(p.pid);
    });
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null });
    return new Response(null, { status: 101, webSocket: client });
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

  activePid() {
    const s = this.s;
    if (s.phase !== 'playing' || !s.turn) return null;
    return s.teams[s.turn.team]?.pid ?? null;
  }

  isActive(att) {
    return !!att.pid && att.pid === this.activePid();
  }

  teamAlive(i) {
    return this.s.workers.some((w) => w.team === i && !w.dead);
  }

  // ---------- Spielablauf ----------
  startGame(workersPerTeam) {
    const s = this.s;
    const humans = s.players.filter((p) => p.connected);
    if (!humans.length) return;
    s.workersPerTeam = Math.max(1, Math.min(5, Math.round(num(workersPerTeam, 3))));
    s.seed = (Math.random() * 2 ** 31) >>> 0;
    s.game += 1;
    s.teams = humans.map((p) => ({
      pid: p.pid, name: p.name, color: p.color, ammo: initialAmmo(), nextWorker: 0,
    }));
    if (s.teams.length === 1) {
      // Übungsmodus: Zielscheiben, die nie am Zug sind.
      s.teams.push({ pid: null, name: BOT_TEAM_NAME, color: '#9e9e9e', ammo: initialAmmo(), nextWorker: 0 });
    }
    const names = [...WORKER_NAMES].sort(() => Math.random() - 0.5);
    s.workers = [];
    let id = 0;
    // Abwechselnd zuteilen, damit die Spawn-Reihenfolge fair gemischt ist.
    for (let k = 0; k < s.workersPerTeam; k++) {
      for (let t = 0; t < s.teams.length; t++) {
        s.workers.push({ id: id, team: t, name: names[id % names.length], x: null, y: null, hp: MAX_HP, dead: false });
        id++;
      }
    }
    s.ops = [];
    s.winner = null;
    s.phase = 'playing';
    s.turn = { n: 0, team: Math.floor(Math.random() * humans.length), worker: -1, wind: 0, endsAt: 0 };
    s.turn.team = (s.turn.team + s.teams.length - 1) % s.teams.length; // advanceTurn geht eins weiter
    this.advanceTurn(true);
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

  advanceTurn(first = false) {
    const s = this.s;
    this.lastSnapWorkers = null;
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
      const t = s.teams[i];
      if (t.pid && alive[i] && connected.has(t.pid)) { next = i; break; }
    }
    if (next < 0) {
      // Keiner da, der ziehen kann: Zug bleibt stehen, bis jemand zurückkommt.
      next = s.turn.team;
    }
    s.turn = {
      n: s.turn.n + 1,
      team: next,
      worker: this.pickWorker(next),
      wind: Math.round((Math.random() * 2 - 1) * 100) / 100,
      endsAt: Date.now() + TURN_TIME * 1000,
    };
    this.ctx.storage.setAlarm(s.turn.endsAt + TURN_GRACE_MS);
  }

  async alarm() {
    const s = this.s;
    if (s.phase !== 'playing' || !s.turn) return;
    const activeConnected = s.players.find((p) => p.pid === this.activePid())?.connected;
    if (Date.now() >= s.turn.endsAt + TURN_GRACE_MS - 1000 || !activeConnected) {
      if (this.lastSnapWorkers) this.applyWorkers(this.lastSnapWorkers);
      this.advanceTurn();
      await this.save();
      this.broadcastState();
    } else {
      this.ctx.storage.setAlarm(s.turn.endsAt + TURN_GRACE_MS);
    }
  }

  applyWorkers(list) {
    const byId = new Map(this.s.workers.map((w) => [w.id, w]));
    for (const u of list) {
      const w = byId.get(u.id);
      if (!w) continue;
      w.x = num(u.x, w.x);
      w.y = num(u.y, w.y);
      w.hp = Math.max(0, Math.min(MAX_HP, Math.round(num(u.hp, w.hp))));
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

    switch (msg.t) {
      case 'join': {
        const pid = clampStr(msg.pid, 40) || crypto.randomUUID();
        const name = clampStr(msg.name, 16) || 'Aushilfe';
        ws.serializeAttachment({ pid });
        let p = s.players.find((x) => x.pid === pid);
        if (p) {
          p.connected = true;
          if (s.phase === 'lobby') p.name = name;
        } else if (s.phase === 'lobby' && s.players.length < MAX_PLAYERS) {
          const used = new Set(s.players.map((x) => x.color));
          p = { pid, name, color: TEAM_COLORS.find((c) => !used.has(c)) || '#ffffff', connected: true };
          s.players.push(p);
        }
        if (!s.hostPid || !s.players.some((x) => x.pid === s.hostPid && x.connected)) {
          s.hostPid = s.players.find((x) => x.connected)?.pid ?? null;
        }
        this.send(ws, { t: 'welcome', pid, spectator: !p });
        if (s.phase !== 'lobby') this.send(ws, { t: 'ops', game: s.game, from: 0, ops: s.ops });
        await this.save();
        this.broadcastState();
        // Falls gerade niemand ziehen konnte, jetzt weitermachen.
        if (s.phase === 'playing' && !s.players.find((x) => x.pid === this.activePid())?.connected) {
          this.ctx.storage.setAlarm(Date.now() + 1500);
        }
        break;
      }

      case 'start': {
        if (att.pid !== s.hostPid || s.phase === 'playing') return;
        if (s.phase === 'ended') {
          // Revanche: Spieler, die gegangen sind, aus der Lobby entfernen.
          s.players = s.players.filter((p) => p.connected);
        }
        this.startGame(msg.workersPerTeam);
        await this.save();
        this.broadcastState();
        this.broadcast({ t: 'ops', game: s.game, from: 0, ops: [] });
        break;
      }

      case 'lobby': {
        if (att.pid !== s.hostPid || s.phase !== 'ended') return;
        s.phase = 'lobby';
        s.players = s.players.filter((p) => p.connected);
        await this.save();
        this.broadcastState();
        break;
      }

      case 'snap': {
        if (!this.isActive(att) || msg.n !== s.turn.n) return;
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
        const p = s.players.find((x) => x.pid === att.pid);
        const text = clampStr(msg.text, 140);
        if (text) this.broadcast({ t: 'chat', name: p?.name || 'Zuschauer', color: p?.color || '#aaa', text });
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
    if (s.phase === 'lobby') {
      s.players = s.players.filter((p) => p.pid !== pid);
    } else {
      const p = s.players.find((x) => x.pid === pid);
      if (p) p.connected = false;
    }
    if (s.hostPid === pid) s.hostPid = s.players.find((x) => x.connected)?.pid ?? null;
    if (s.phase === 'playing' && this.activePid() === pid) {
      // Aktiver Spieler weg: nach kurzer Wartezeit weiter.
      this.ctx.storage.setAlarm(Date.now() + 8000);
    }
    await this.save();
    this.broadcastState();
  }
}
