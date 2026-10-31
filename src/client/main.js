// Einstiegspunkt: Lobby, HUD, Eingaben und Hauptschleife.
import { Renderer } from './render.js';
import { Net } from './net.js';
import { Game } from './game.js';
import { WEAPONS, WEAPON_BY_ID } from '../shared/weapons.js';
import { MAX_HP, WORLD_W, WORLD_H } from '../shared/constants.js';
import { unlockAudio, setMuted, isMuted, setMusicOn, isMusicOn, setMusicMode, startAmbience, audioReady } from './audio.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WEAPON_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus'];
const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'ß'];

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
const renderer = new Renderer($('stage'));
let net = null;
let room = null;
let state = null;
let myPid = null;

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

function joinRoom(code) {
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (code.length < 3) { $('code').focus(); return; }
  unlockAudio();
  const name = playerName();
  room = code;
  history.replaceState(null, '', `?r=${code}`);
  net?.close();
  net = new Net(code, {
    open() {
      $('conn').classList.add('hidden');
      net.send({ t: 'join', pid, name });
    },
    close() { $('conn').classList.remove('hidden'); },
    message: onMessage,
  });
  $('roomcode').textContent = code;
  $('menu-join').classList.add('hidden');
  $('menu-lobby').classList.remove('hidden');
}

$('create').onclick = () => joinRoom(makeCode());
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
$('start').onclick = () => net?.send({ t: 'start', workersPerTeam: +$('wpt').value });
$('rematch').onclick = () => net?.send({ t: 'start', workersPerTeam: state?.workersPerTeam || 3 });
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
      if (msg.spectator) ui.toast('Spiel läuft schon – du schaust zu.', '#90caf9');
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
    case 'chat': addChat(msg.name, msg.color, msg.text); break;
  }
}

function renderLobby() {
  if (!state) return;
  const isHost = state.hostPid === myPid;
  const inLobby = state.phase === 'lobby';
  $('menu').classList.toggle('hidden', !inLobby);
  $('hud').classList.toggle('hidden', inLobby);
  $('gameover').classList.toggle('hidden', state.phase !== 'ended');
  $('playerlist').innerHTML = state.players.map((p) => `
    <li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}
    <span class="tag">${p.pid === state.hostPid ? 'Schichtleitung' : ''}${p.pid === myPid ? ' (du)' : ''}${p.connected ? '' : ' offline'}</span></li>`).join('');
  $('hostcontrols').classList.toggle('hidden', !isHost);
  $('waithost').classList.toggle('hidden', isHost);
  $('start').textContent = state.players.length > 1 ? 'Schicht beginnen!' : 'Übungsschicht starten';

  if (state.phase === 'ended') {
    const t = state.teams[state.winner];
    $('winner').innerHTML = t
      ? `<span style="color:${t.color}"><b>${esc(t.name)}</b></span> hat die Schicht überlebt und bekommt den Mitarbeiter-des-Monats-Parkplatz! 🏆`
      : 'Alle gekündigt. Unentschieden – der Betriebsrat ist entsetzt.';
    $('rematch').classList.toggle('hidden', !isHost);
    $('tolobby').classList.toggle('hidden', !isHost);
    $('waitrematch').classList.toggle('hidden', isHost);
  }
  renderWeapons();
}

// ---------- HUD ----------
function renderWeapons() {
  const el = $('weapons');
  const myTurn = game.myTurn && game.tp === 'aim';
  el.innerHTML = '';
  WEAPONS.forEach((w, i) => {
    const b = document.createElement('button');
    b.className = 'wbtn' + (game.weapon === w.id ? ' sel' : '');
    const ammo = state?.teams?.[game.myTeamIndex()]?.ammo?.[w.id] ?? w.ammo;
    b.innerHTML = `<span class="key">${KEY_LABELS[i]}</span>${w.icon}<span class="ammo">${ammo < 0 ? '∞' : ammo}</span>`;
    b.title = `${w.name} – ${w.desc}`;
    b.disabled = !myTurn || ammo === 0;
    b.onclick = () => { game.selectWeapon(w.id); };
    el.appendChild(b);
  });
  const w = WEAPON_BY_ID[game.weapon];
  $('weaponinfo').innerHTML = game.myTurn ? `<b>${w.icon} ${esc(w.name)}</b> – ${esc(w.desc)}` : '';
  $('weaponinfo').classList.toggle('hidden', !game.myTurn);
}

let lastSecond = -1;
function updateHud() {
  if (!state || state.phase === 'lobby') return;
  const turn = state.turn;
  const team = turn ? state.teams[turn.team] : null;
  // Teams
  $('teams').innerHTML = state.teams.map((t, i) => {
    const hp = game.workers.filter((w) => w.team === i && !w.dead).reduce((s, w) => s + w.hp, 0);
    const max = state.workersPerTeam * MAX_HP;
    const conn = !t.pid || state.players.find((p) => p.pid === t.pid)?.connected;
    return `<div class="teambar ${hp <= 0 ? 'off' : ''} ${turn && turn.team === i ? 'current' : ''}">
      <span class="tname" style="color:${t.color}">${esc(t.name)}${conn ? '' : ' 💤'}</span>
      <div class="bar"><div class="fill" style="width:${(hp / max) * 100}%;background:${t.color}"></div></div>
      <span>${hp}</span></div>`;
  }).join('');
  // Zug & Timer
  const w = game.activeWorker();
  $('turnname').innerHTML = team ? `<span style="color:${team.color}">${esc(team.name)}</span>${w ? ' · ' + esc(w.name) : ''}` : '';
  const timer = $('timer');
  let secs;
  const retreat = game.myTurn ? game.retreatLeft() : game.remote.retreat || 0;
  const inRetreat = game.myTurn ? game.tp === 'retreat' : retreat > 0 && !game.remote.aiming;
  if (inRetreat) secs = Math.ceil(retreat);
  else secs = Math.ceil(game.timeLeft());
  timer.textContent = state.phase === 'playing' ? secs : '–';
  timer.classList.toggle('low', !inRetreat && secs <= 5);
  timer.classList.toggle('retreat', inRetreat);
  if (game.myTurn && game.tp === 'aim' && secs <= 5 && secs !== lastSecond && secs > 0) game.fx?.call(game, { k: 'sfx', s: 'tick' });
  lastSecond = secs;
  // Wind
  const wind = turn?.wind || 0;
  const fill = document.querySelector('.windfill');
  fill.style.left = wind >= 0 ? '50%' : `${50 + wind * 50}%`;
  fill.style.width = `${Math.abs(wind) * 50}%`;
}

// ---------- Chat ----------
function addChat(name, color, text) {
  const log = $('chatlog');
  const d = document.createElement('div');
  d.innerHTML = `<b style="color:${esc(color)}">${esc(name)}:</b> ${esc(text)}`;
  log.appendChild(d);
  while (log.children.length > 8) log.firstChild.remove();
}
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
  if (wi >= 0 && WEAPONS[wi]) { game.selectWeapon(WEAPONS[wi].id); return; }
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
canvas.addEventListener('pointerdown', (e) => {
  unlockAudio();
  const p = renderer.screenToWorld(e.clientX, e.clientY);
  if (e.button === 0 && game.click(p.x, p.y)) return;
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const p = renderer.screenToWorld(e.clientX, e.clientY);
  game.mouse.x = p.x; game.mouse.y = p.y;
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
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  renderer.zoom = Math.max(380, Math.min(2200, renderer.zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// Taste C: Kamera zurück zum aktiven Arbeiter
window.addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !typing(e)) game.manualCam = false; });

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

// Für Tests/Debugging in der Konsole
window.__wh = { game, renderer, get state() { return state; } };
