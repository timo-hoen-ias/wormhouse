// Einstiegspunkt: Lobby, HUD, Eingaben und Hauptschleife.
import { Renderer } from './render.js';
import { Net } from './net.js';
import { Game } from './game.js';
import { WEAPONS, WEAPON_BY_ID, WEAPON_CATS } from '../shared/weapons.js';
import { MAX_HP, WORLD_W, WORLD_H, TEAM_COLORS } from '../shared/constants.js';
import { RULES, AMMO_OPTIONS, AMMO_PRESETS, GAME_MODES, modeRules, BOT_LEVELS, MAX_TEAMS, configurableWeapons, ammoFromRules } from '../shared/rules.js';
import { renderMapPicker } from './mappicker.js';
import { isTouch, lowGfx, setupTouch, closeWeapons } from './touch.js';
import { unlockAudio, setMuted, isMuted, setMusicOn, isMusicOn, setMusicMode, startAmbience, audioReady } from './audio.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tasten 1–9, 0 wählen ein Fach im Waffenregal, mehrfach drücken schaltet durch.
const WEAPON_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

// ---------- Identität ----------
function storage(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function store(key, val) {
  try { localStorage.setItem(key, val); } catch { /* egal */ }
}
let pid = storage('wh.pid', null);
if (!pid) { pid = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); store('wh.pid', pid); }
$('name').value = storage('wh.name', '');

const params = new URLSearchParams(location.search);
if (params.get('r')) $('code').value = params.get('r').toUpperCase();

// ---------- Rendering ----------
const renderer = new Renderer($('stage'), { low: lowGfx });
let net = null;
let room = null;
let state = null;
let myPid = null;
let solo = false;

const ui = {
  toastTimer: 0,
  toast(text, color = '#fff') {
    const el = $('toast');
    el.textContent = text;
    el.style.color = color;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  },
  refreshWeapons() { renderWeapons(); },
  onNewGame() { $('chatlog').innerHTML = ''; },
};

const game = new Game({ renderer, net: { send: (m) => net?.send(m) }, ui });
const touch = setupTouch({ game, unlockAudio, toast: (t, c) => ui.toast(t, c) });

// ---------- Lobby ----------
function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function playerName() {
  const n = $('name').value.trim() || `Aushilfe ${Math.floor(Math.random() * 90 + 10)}`;
  $('name').value = n;
  store('wh.name', n);
  return n;
}

function joinRoom(code, wantSolo = false) {
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (code.length < 3) { $('code').focus(); return; }
  unlockAudio();
  const name = playerName();
  room = code;
  solo = wantSolo;
  lobbyKeys = {};
  $('lobbychat').innerHTML = '';
  history.replaceState(null, '', wantSolo ? location.pathname : `?r=${code}`);
  net?.close();
  net = new Net(code, {
    open() {
      $('conn').classList.add('hidden');
      net.send({ t: 'join', pid, name, solo: wantSolo, botLevel: prefLevel() });
    },
    close() { $('conn').classList.remove('hidden'); },
    message: onMessage,
  });
  $('roomcode').textContent = code;
  $('menu-join').classList.add('hidden');
  $('menu-lobby').classList.remove('hidden');
  $('menupanel').classList.add('wide');
  renderSoloHead();
}

function leaveRoom() {
  net?.close();
  net = null;
  state = null;
  room = null;
  history.replaceState(null, '', location.pathname);
  $('menu-join').classList.remove('hidden');
  $('menu-lobby').classList.add('hidden');
  $('menupanel').classList.remove('wide');
  $('menu').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('conn').classList.add('hidden');
}

function renderSoloHead() {
  $('roomline').classList.toggle('hidden', solo);
  $('sololine').classList.toggle('hidden', !solo);
}

$('solo').onclick = () => joinRoom(makeCode() + 'S', true);
$('create').onclick = () => joinRoom(makeCode());
$('leave').onclick = leaveRoom;
$('join').onclick = () => joinRoom($('code').value);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('code').value); });
$('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('code').value ? joinRoom($('code').value) : joinRoom(makeCode()));
});
$('copylink').onclick = async () => {
  const url = `${location.origin}${location.pathname}?r=${room}`;
  try { await navigator.clipboard.writeText(url); $('copylink').textContent = 'Kopiert!'; } catch { prompt('Link:', url); }
  setTimeout(() => ($('copylink').textContent = 'Link kopieren'), 1500);
};
$('start').onclick = () => net?.send({ t: 'start' });
$('rematch').onclick = () => net?.send({ t: 'start' });
// KI-Stärke: zuletzt gewählte Stufe merken (Einzelspieler & neue KI-Teams)
const prefLevel = () => Math.max(1, Math.min(BOT_LEVELS.length - 1, +storage('wh.botlevel', 2) || 2));
const levelOptions = (sel, withDummy = true) => BOT_LEVELS.filter((b) => withDummy || b.level > 0)
  .map((b) => `<option value="${b.level}"${b.level === sel ? ' selected' : ''} title="${esc(b.desc)}">${esc(b.name)} – ${esc(b.desc)}</option>`).join('');
$('sololevel').innerHTML = levelOptions(prefLevel(), false);
$('botlevel').innerHTML = levelOptions(prefLevel());
$('sololevel').onchange = () => { store('wh.botlevel', $('sololevel').value); $('botlevel').value = $('sololevel').value; };
$('botlevel').onchange = () => { if (+$('botlevel').value > 0) { store('wh.botlevel', $('botlevel').value); $('sololevel').value = $('botlevel').value; } };
$('addbot').onclick = () => net?.send({ t: 'addBot', level: +$('botlevel').value });
$('addhuman').onclick = () => net?.send({ t: 'addBot', human: true, level: prefLevel() });
$('allbots').onchange = () => {
  const level = +$('allbots').value;
  if (!state || !Number.isFinite(level)) return;
  for (const b of state.bots) if (!b.human) net?.send({ t: 'bot', id: b.id, level });
  $('allbots').value = '';
};
// Während der Schicht: Schichtleitung klickt auf die Stufe eines KI-Teams, um sie zu ändern
$('teams').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-lvlteam]');
  if (!el || !state || state.hostPid !== myPid) return;
  e.stopPropagation();
  const t = state.teams[+el.dataset.lvlteam];
  if (!t || !(t.bot > 0)) return;
  const level = t.bot >= BOT_LEVELS.length - 1 ? 1 : t.bot + 1;
  net?.send({ t: 'botLevel', team: +el.dataset.lvlteam, level });
});
$('tolobby').onclick = () => net?.send({ t: 'lobby' });
function renderAudioButtons() {
  $('mute').textContent = isMuted() ? '🔇' : '🔊';
  $('music').classList.toggle('off', !isMusicOn());
}
$('mute').onclick = () => { unlockAudio(); setMuted(!isMuted()); renderAudioButtons(); };
$('music').onclick = () => { unlockAudio(); setMusicOn(!isMusicOn()); renderAudioButtons(); };
renderAudioButtons();
// Browser erlauben Ton erst nach einer Interaktion – beim ersten Klick/Tastendruck starten.
const firstGesture = () => { unlockAudio(); };
window.addEventListener('pointerdown', firstGesture, { once: true });
window.addEventListener('keydown', firstGesture, { once: true });

$('arsenal').innerHTML = WEAPONS.map((w) => `<li>${w.icon} <b>${esc(w.name)}</b>${w.ammo > 0 ? ` (${w.ammo}×)` : ''} – ${esc(w.desc)}</li>`).join('');

// ---------- Nachrichten ----------
function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      myPid = msg.pid;
      game.myPid = msg.pid;
      solo = !!msg.solo;
      renderSoloHead();
      $('lobbychat').innerHTML = '';
      for (const c of msg.chat || []) addChat(c, false);
      if (msg.spectator) ui.toast('Kein Platz mehr im Team – du schaust zu.', '#90caf9');
      break;
    case 'kicked':
      leaveRoom();
      ui.toast('Die Schichtleitung hat dich nach Hause geschickt.', '#ff8a65');
      break;
    case 'state':
      state = msg.state;
      game.onState(state);
      renderLobby();
      break;
    case 'ops': game.onOps(msg.game, msg.from, msg.ops); break;
    case 'op': game.onOp(msg.game, msg.i, msg.op, msg.fx); break;
    case 'snap': game.onSnap(msg); break;
    case 'fx': game.onFx(msg); break;
    case 'chat': addChat(msg); break;
  }
}

let lobbyKeys = {};
// Nur neu zeichnen, wenn sich der Inhalt geändert hat (sonst gehen offene Auswahllisten zu).
function changed(key, value) {
  const j = JSON.stringify(value);
  if (lobbyKeys[key] === j) return false;
  lobbyKeys[key] = j;
  return true;
}

function colorPicker(current, taken, data) {
  return `<div class="swatches">${TEAM_COLORS.map((c) => `<button class="swatch${c === current ? ' sel' : ''}" style="background:${c}"
    ${taken.has(c) && c !== current ? 'disabled' : ''} data-color="${c}" ${data} title="Farbe wählen"></button>`).join('')}</div>`;
}

function renderTeams(isHost) {
  const used = new Set([...state.players, ...state.bots].map((x) => x.color));
  if (!changed('teams', [state.players, state.bots, state.hostPid, myPid, isHost])) return;
  const focus = document.activeElement?.id === 'myteamname' ? $('myteamname').selectionStart : null;
  const rows = state.players.map((p) => {
    const mine = p.pid === myPid;
    const tags = `${p.pid === state.hostPid ? '<span class="tag host">Schichtleitung</span>' : ''}${p.connected ? '' : '<span class="tag">offline</span>'}`;
    return `<li class="team${mine ? ' mine' : ''}" style="--team:${p.color}">
      <div class="trow"><span class="dot"></span>
        ${mine ? `<input id="myteamname" maxlength="20" value="${esc(p.team || p.name)}" title="Teamname" />` : `<b>${esc(p.team || p.name)}</b>`}
        <span class="who">${esc(p.name)}${mine ? ' (du)' : ''}</span>${tags}
        ${isHost && !mine ? `<button class="small ghost" data-kick="${esc(p.pid)}" title="Nach Hause schicken">✕</button>` : ''}
      </div>
      ${mine ? colorPicker(p.color, used, 'data-own="1"') : ''}
    </li>`;
  });
  for (const b of state.bots) {
    const lvl = BOT_LEVELS[b.level] || BOT_LEVELS[2];
    // Jeder Gegner-Platz ist entweder KI oder ein lokaler Mitspieler (Hotseat am selben Gerät).
    const kind = `<option value="human"${b.human ? ' selected' : ''}>👤 Spieler (lokal)</option>`
      + BOT_LEVELS.map((x) => `<option value="${x.level}"${!b.human && x.level === b.level ? ' selected' : ''}>🤖 ${esc(x.name)}</option>`).join('');
    rows.push(`<li class="team ${b.human ? 'local' : 'bot'}" style="--team:${b.color}">
      <div class="trow"><span class="dot"></span>
        ${isHost ? `<input class="botname" data-bot="${b.id}" maxlength="20" value="${esc(b.name)}" />` : `<b>${esc(b.name)}</b>`}
        ${isHost ? `<select data-botlevel="${b.id}" title="Wer steuert dieses Team?">${kind}</select>`
          : `<span class="who">${b.human ? '👤 Spieler (lokal)' : `🤖 ${esc(lvl.name)}`}</span>`}
        ${isHost ? `<button class="small ghost" data-rmbot="${b.id}" title="Entfernen">✕</button>` : ''}
      </div>
      ${isHost ? colorPicker(b.color, used, `data-botcolor="${b.id}"`) : ''}
    </li>`);
  }
  if (state.players.length + state.bots.length < 2) {
    rows.push('<li class="team empty">Kein Gegner? Dann stehen Inventur-Dummies als Zielscheiben rum.</li>');
  }
  const el = $('teamlist');
  el.innerHTML = rows.join('');
  const own = $('myteamname');
  if (own) {
    own.onchange = () => net?.send({ t: 'team', name: own.value });
    own.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') own.blur(); };
    if (focus != null) { own.focus(); own.setSelectionRange(focus, focus); }
  }
  el.querySelectorAll('[data-own]').forEach((b) => { b.onclick = () => net?.send({ t: 'team', color: b.dataset.color }); });
  el.querySelectorAll('[data-botcolor]').forEach((b) => { b.onclick = () => net?.send({ t: 'bot', id: b.dataset.botcolor, color: b.dataset.color }); });
  el.querySelectorAll('[data-botlevel]').forEach((sel) => {
    sel.onchange = () => net?.send(sel.value === 'human'
      ? { t: 'bot', id: sel.dataset.botlevel, human: true }
      : { t: 'bot', id: sel.dataset.botlevel, human: false, level: +sel.value });
  });
  el.querySelectorAll('.botname').forEach((inp) => {
    inp.onchange = () => net?.send({ t: 'bot', id: inp.dataset.bot, name: inp.value });
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
  });
  el.querySelectorAll('[data-rmbot]').forEach((b) => { b.onclick = () => net?.send({ t: 'bot', id: b.dataset.rmbot, remove: true }); });
  el.querySelectorAll('[data-kick]').forEach((b) => { b.onclick = () => net?.send({ t: 'kick', pid: b.dataset.kick }); });
}

function sendRules(patch) {
  net?.send({ t: 'rules', rules: patch });
}

function renderRules(isHost) {
  const r = state.rules || {};
  if (!changed('rules', [r, isHost])) return;
  $('rulesnote').textContent = isHost ? '' : '(stellt die Schichtleitung ein)';
  const mode = GAME_MODES[r.mode] ? r.mode : 'standard';
  $('modes').innerHTML = Object.entries(GAME_MODES).map(([k, m]) => `<button class="small mode${k === mode ? ' sel' : ''}" data-mode="${k}" title="${esc(m.desc)}" ${isHost ? '' : 'disabled'}>${m.icon} ${esc(m.label)}</button>`).join('');
  $('modes').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => sendRules(modeRules(b.dataset.mode, state.rules)); });
  $('modedesc').textContent = GAME_MODES[mode].desc;
  $('rules').innerHTML = RULES.map((d) => `<label class="rule"><span>${esc(d.label)}</span>
    <select data-rule="${d.key}" ${isHost ? '' : 'disabled'}>${d.options.map(([v, l]) => `<option value="${v}"${v === r[d.key] ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('');
  $('rules').querySelectorAll('[data-rule]').forEach((sel) => { sel.onchange = () => sendRules({ [sel.dataset.rule]: +sel.value }); });
  // Waffenlager: Munition pro Waffe
  const ammo = ammoFromRules(r);
  $('presets').innerHTML = isHost ? Object.entries(AMMO_PRESETS).map(([k, p]) => `<button class="small" data-preset="${k}">${esc(p.label)}</button>`).join('') : '';
  $('presets').querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => sendRules({ ammo: AMMO_PRESETS[b.dataset.preset].ammo() }); });
  $('ammo').innerHTML = configurableWeapons().map((w) => `<label class="ammo${ammo[w.id] === 0 ? ' off' : ''}" title="${esc(w.desc)}">
    <span>${w.icon} ${esc(w.name)}</span>
    <select data-ammo="${w.id}" ${isHost ? '' : 'disabled'}>${AMMO_OPTIONS.map(([v, l]) => `<option value="${v}"${v === ammo[w.id] ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`).join('');
  $('ammo').querySelectorAll('[data-ammo]').forEach((sel) => {
    sel.onchange = () => sendRules({ ammo: { ...(state.rules.ammo || {}), [sel.dataset.ammo]: +sel.value } });
  });
}

function renderLobby() {
  if (!state) return;
  const isHost = state.hostPid === myPid;
  const inLobby = state.phase === 'lobby';
  $('menu').classList.toggle('hidden', !inLobby);
  $('hud').classList.toggle('hidden', inLobby);
  document.body.classList.toggle('ingame', !inLobby);
  $('gameover').classList.toggle('hidden', state.phase !== 'ended');
  if (inLobby) {
    renderTeams(isHost);
    renderRules(isHost);
    $('mapnote').textContent = isHost ? '' : '(wählt die Schichtleitung)';
    renderMapPicker($('mappicker'), { rules: state.rules, seed: state.mapSeed ?? 1, isHost, send: sendRules, reroll: () => net?.send({ t: 'reroll' }) });
    const teams = state.players.length + state.bots.length;
    $('addbotrow').classList.toggle('hidden', !isHost || teams >= MAX_TEAMS);
    $('allbotsrow').classList.toggle('hidden', !isHost || state.bots.filter((b) => !b.human).length < 2);
    if (!$('allbots').options.length) $('allbots').innerHTML = `<option value="">🤖 Alle KI-Teams auf …</option>${levelOptions(-1)}`;
    $('hostcontrols').classList.toggle('hidden', !isHost);
    $('waithost').classList.toggle('hidden', isHost);
    $('start').textContent = state.bots.length || state.players.length > 1 ? 'Schicht beginnen!' : 'Übungsschicht starten';
  }

  if (state.phase === 'ended') {
    const t = state.teams[state.winner];
    $('winner').innerHTML = t
      ? `<span style="color:${t.color}"><b>${esc(t.name)}</b></span> hat die Schicht überlebt und bekommt den Mitarbeiter-des-Monats-Parkplatz! 🏆`
      : 'Alle gekündigt. Unentschieden – der Betriebsrat ist entsetzt.';
    $('rematch').classList.toggle('hidden', !isHost);
    $('tolobby').classList.toggle('hidden', !isHost);
    $('waitrematch').classList.toggle('hidden', isHost);
  }
  if (!inLobby) lobbyKeys = {};
  renderWeapons();
}

// ---------- HUD ----------
function renderWeapons() {
  const el = $('weapons');
  const myTurn = game.myTurn && game.tp === 'aim';
  el.innerHTML = '';
  WEAPON_CATS.forEach((list, ci) => {
    const grp = document.createElement('div');
    grp.className = 'wgroup';
    list.forEach((w, j) => {
      const b = document.createElement('button');
      b.className = 'wbtn' + (game.myTurn && game.weapon === w.id ? ' sel' : '') + (w.util ? ' util' : '');
      const ammo = state?.teams?.[game.myTurn ? state.turn?.team : game.myTeamIndex()]?.ammo?.[w.id] ?? w.ammo;
      b.innerHTML = `${j === 0 ? `<span class="key">${KEY_LABELS[ci]}</span>` : ''}${w.icon}<span class="ammo">${ammo < 0 ? '∞' : ammo}</span>`;
      b.title = `${w.name} – ${w.desc}`;
      b.disabled = !myTurn || ammo === 0;
      b.onclick = () => { game.selectWeapon(w.id); if (isTouch) closeWeapons(); };
      grp.appendChild(b);
    });
    el.appendChild(grp);
  });
  const w = WEAPON_BY_ID[game.weapon];
  const touchNote = !isTouch || !w.target ? '' : w.kind === 'homing' ? ' – Empfänger antippen, dann 🔥' : ' – Ziel antippen, dann 🎯';
  $('weaponinfo').innerHTML = !game.myTurn ? '' : isTouch ? `<b>${w.icon} ${esc(w.name)}</b>${touchNote}` : `<b>${w.icon} ${esc(w.name)}</b> – ${esc(w.desc)}`;
  $('weaponinfo').classList.toggle('hidden', !game.myTurn);
}

// Kleine Stufen-Plakette hinter KI-Teams; für die Schichtleitung klickbar.
function lvlTag(t, i) {
  const lvl = BOT_LEVELS[t.bot] || BOT_LEVELS[2];
  const host = state.hostPid === myPid;
  return `<span class="lvl${host ? ' edit' : ''}" ${host ? `data-lvlteam="${i}" title="KI-Stärke ändern (gilt ab dem nächsten Zug)"` : `title="${esc(lvl.desc)}"`}>${esc(lvl.name)}</span>`;
}

let lastSecond = -1;
function updateHud() {
  if (!state || state.phase === 'lobby') return;
  touch.update(state.phase === 'playing');
  const turn = state.turn;
  const team = turn ? state.teams[turn.team] : null;
  // Teams
  $('teams').innerHTML = state.teams.map((t, i) => {
    const hp = game.workers.filter((w) => w.team === i && !w.dead).reduce((s, w) => s + w.hp, 0);
    const max = (state.rules?.workersPerTeam || 3) * (state.rules?.hp || MAX_HP);
    const conn = !t.pid || state.players.find((p) => p.pid === t.pid)?.connected;
    return `<div class="teambar ${hp <= 0 ? 'off' : ''} ${turn && turn.team === i ? 'current' : ''}">
      <span class="tname" style="color:${t.color}">${t.bot ? '🤖 ' : t.local ? '👤 ' : ''}${esc(t.name)}${conn ? '' : ' 💤'}</span>${t.bot > 0 ? lvlTag(t, i) : ''}
      <div class="bar"><div class="fill" style="width:${(hp / max) * 100}%;background:${t.color}"></div></div>
      <span>${hp}</span></div>`;
  }).join('');
  // Zug & Timer
  const w = game.activeWorker();
  $('turnname').innerHTML = team ? `<span style="color:${team.color}">${esc(team.name)}</span>${w ? ' · ' + esc(w.name) : ''}` : '';
  const timer = $('timer');
  let secs;
  const retreat = game.sim ? game.retreatLeft() : game.remote.retreat || 0;
  const inRetreat = game.sim ? game.tp === 'retreat' : retreat > 0 && !game.remote.aiming;
  if (inRetreat) secs = Math.ceil(retreat);
  else secs = Math.ceil(game.timeLeft());
  timer.textContent = state.phase === 'playing' ? secs : '–';
  timer.classList.toggle('low', !inRetreat && secs <= 5);
  timer.classList.toggle('retreat', inRetreat);
  if (game.myTurn && game.tp === 'aim' && secs <= 5 && secs !== lastSecond && secs > 0) game.fx?.call(game, { k: 'sfx', s: 'tick' });
  lastSecond = secs;
  // Sudden Death
  $('sudden').classList.toggle('hidden', !state.sudden);
  // Wind
  const wind = turn?.wind || 0;
  const fill = document.querySelector('.windfill');
  fill.style.left = wind >= 0 ? '50%' : `${50 + wind * 50}%`;
  fill.style.width = `${Math.abs(wind) * 50}%`;
}

// ---------- Chat ----------
function chatLine(m) {
  const d = document.createElement('div');
  if (m.sys) { d.className = 'sys'; d.textContent = m.text; }
  else d.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.name)}:</b> ${esc(m.text)}`;
  return d;
}
function addChat(m, inGame = true) {
  const lob = $('lobbychat');
  lob.appendChild(chatLine(m));
  while (lob.children.length > 60) lob.firstChild.remove();
  lob.scrollTop = lob.scrollHeight;
  if (!inGame) return;
  const log = $('chatlog');
  log.appendChild(chatLine(m));
  while (log.children.length > 8) log.firstChild.remove();
}
$('lobbychatinput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = e.target.value.trim();
    if (text) net?.send({ t: 'chat', text });
    e.target.value = '';
  }
});
$('chatinput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = e.target.value.trim();
    if (text) net?.send({ t: 'chat', text });
    e.target.value = '';
    e.target.blur();
  } else if (e.key === 'Escape') e.target.blur();
});

// ---------- Eingaben ----------
const GAME_KEYS = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Backspace', 'Tab']);
function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
}
window.addEventListener('keydown', (e) => {
  if (typing(e) || !state || state.phase !== 'playing') return;
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  if (e.code === 'KeyT') { e.preventDefault(); $('chatinput').focus(); return; }
  const wi = WEAPON_KEYS.indexOf(e.code);
  if (wi >= 0) { if (!e.repeat) game.selectCategory(wi); return; }
  if (e.repeat) { game.keys.add(e.code); return; }
  unlockAudio();
  game.keyDown(e.code);
});
window.addEventListener('keyup', (e) => {
  if (typing(e)) return;
  game.keyUp(e.code);
});
window.addEventListener('blur', () => {
  if (game.charging) game.keyUp('Space');
  game.keys.clear();
});

const canvas = renderer.renderer.domElement;
let drag = null;
// Touch: ein Finger zieht die Kamera, zwei Finger zoomen (Pinch), kurzer Tipp setzt das Ziel.
const touches = new Map();
let pinch = null;
let tap = null;
const clampZoom = (z) => Math.max(380, Math.min(2200, z));
const pinchDist = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
canvas.addEventListener('pointerdown', (e) => {
  unlockAudio();
  const p = renderer.screenToWorld(e.clientX, e.clientY);
  if (e.pointerType === 'touch') {
    closeWeapons();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (touches.size === 2) { pinch = { d: pinchDist(), zoom: renderer.zoom }; drag = null; tap = null; }
    else if (touches.size === 1) { drag = { x: e.clientX, y: e.clientY, moved: false }; tap = { x: e.clientX, y: e.clientY, t: performance.now() }; }
    return;
  }
  if (e.button === 0 && game.click(p.x, p.y)) return;
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) { renderer.zoom = clampZoom(pinch.zoom * pinch.d / pinchDist()); return; }
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
  } else {
    const p = renderer.screenToWorld(e.clientX, e.clientY);
    game.mouse.x = p.x; game.mouse.y = p.y;
  }
  if (drag) {
    const k = renderer.worldPerPixel();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      drag.moved = true;
      game.manualCam = true;
      renderer.camTarget.x = Math.max(-300, Math.min(WORLD_W + 300, renderer.camTarget.x - dx * k));
      renderer.camTarget.y = Math.max(0, Math.min(WORLD_H + 300, renderer.camTarget.y + dy * k));
    }
    drag.x = e.clientX; drag.y = e.clientY;
  }
});
const pointerEnd = (e) => {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) pinch = null; drag = null; tap = null; return; }
    if (tap && e.type === 'pointerup' && performance.now() - tap.t < 500) {
      const p = renderer.screenToWorld(e.clientX, e.clientY);
      game.setTouchTarget(p.x, p.y);
    }
    tap = null;
  }
  drag = null;
};
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  renderer.zoom = clampZoom(renderer.zoom * (e.deltaY > 0 ? 1.1 : 0.9));
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// Taste C: Kamera zurück zum aktiven Arbeiter
window.addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !typing(e)) game.manualCam = false; });

// Handy gesperrt / App gewechselt: JavaScript friert dort ein. Verbindung bewusst
// trennen, damit der Server den Zug weitergibt und die Schichtleitung (KI-Teams)
// an jemand anderen übergibt; beim Zurückkehren frisch verbinden.
if (isTouch) {
  const away = () => {
    game.charging = false;
    game.keys.clear();
    net?.suspend();
  };
  const back = () => net?.resume();
  document.addEventListener('visibilitychange', () => (document.hidden ? away() : back()));
  window.addEventListener('pagehide', away);
  window.addEventListener('pageshow', () => { if (!document.hidden) back(); });
}

// ---------- Hauptschleife ----------
let last = performance.now();
let menuT = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  try {
    step(dt);
  } catch (err) {
    console.error(err);
  }
}
function step(dt) {
  if (audioReady()) {
    startAmbience();
    setMusicMode(state?.phase === 'playing' ? 'game' : 'menu');
  }
  if (state && state.phase !== 'lobby' && game.terrain) {
    game.update(dt);
    game.render(dt);
    updateHud();
  } else {
    // Langsamer Kameraflug durch die Halle im Menü
    menuT += dt;
    renderer.frame(dt, { x: WORLD_W / 2 + Math.sin(menuT * 0.1) * 900, y: WORLD_H * 0.55 });
  }
}
requestAnimationFrame(loop);

// Hintergrund-Tab: requestAnimationFrame pausiert dann komplett. Simuliert dieser
// Client gerade einen Zug (eigener Zug oder KI-Zug als Schichtleitung), läuft die
// Spiellogik über einen Timer weiter – sonst warten alle anderen auf uns.
let bgLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - bgLast) / 1000;
  bgLast = now;
  if (!document.hidden || !game.sim || !state || state.phase !== 'playing' || !game.terrain) return;
  try {
    game.update(Math.min(dt, 1), 1);
  } catch (err) {
    console.error(err);
  }
}, 200);

// Für Tests/Debugging in der Konsole
window.__wh = { game, renderer, get state() { return state; } };
