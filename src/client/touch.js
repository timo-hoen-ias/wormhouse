// Handy-Steuerung: Erkennung, Steuerkreuz, Feuer-/Sprung-Knöpfe, Waffenmenü-Knopf,
// Vollbild und PWA-Hinweise. Die Knöpfe speisen dieselben Tastencodes in das Spiel
// ein wie die Tastatur (game.keyDown/keyUp) – an der Spiellogik ändert sich nichts.
import { WEAPON_BY_ID } from '../shared/weapons.js';

const params = new URLSearchParams(location.search);
const force = params.get('touch');

// Touch-Modus: Gerät ohne feinen Zeiger (Handy, Tablet). ?touch=1 / ?touch=0 erzwingt.
export const isTouch = force === '1' || (force !== '0' && matchMedia('(pointer: coarse)').matches);
// Grafikstufe: auf Touch-Geräten sparsamer. ?gfx=high / ?gfx=low erzwingt.
export const lowGfx = params.get('gfx') === 'low' || (params.get('gfx') !== 'high' && isTouch);

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;

const $ = (id) => document.getElementById(id);

// Halten-Knopf: drückt beim Berühren, lässt beim Loslassen/Abbrechen los.
function holdButton(el, down, up) {
  let held = false;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    held = true;
    el.classList.add('on');
    down(e);
  });
  const release = () => {
    if (!held) return;
    held = false;
    el.classList.remove('on');
    up?.();
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function setupTouch({ game, unlockAudio, toast }) {
  document.body.classList.toggle('touch', isTouch);
  setupFullscreen();
  setupInstallHints();
  if (!isTouch) return { update() {} };
  game.touchMode = true;

  // iOS: Seiten-Zoom per Zwei-Finger-Geste unterbinden (Pinch gehört dem Spiel)
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // ---- Steuerkreuz (Stick): links/rechts laufen bzw. schwingen, hoch/runter zielen bzw. Seil
  const stick = $('stick');
  const knob = stick.querySelector('.knob');
  const active = new Set();
  const setDir = (want) => {
    for (const k of active) if (!want.has(k)) { active.delete(k); game.keyUp(k); }
    for (const k of want) if (!active.has(k)) { active.add(k); game.keyDown(k); }
  };
  let stickId = null;
  const stickMove = (e) => {
    const r = stick.getBoundingClientRect();
    const rad = r.width / 2;
    let dx = e.clientX - (r.left + rad), dy = e.clientY - (r.top + rad);
    const len = Math.hypot(dx, dy);
    const want = new Set();
    const dead = rad * 0.28;
    // Achsen mit Vorrang: leicht schräg zählt noch als gerade, damit Laufen nicht ungewollt zielt
    if (Math.abs(dx) > dead && Math.abs(dx) > Math.abs(dy) * 0.55) want.add(dx < 0 ? 'ArrowLeft' : 'ArrowRight');
    if (Math.abs(dy) > dead && Math.abs(dy) > Math.abs(dx) * 0.55) want.add(dy < 0 ? 'ArrowUp' : 'ArrowDown');
    setDir(want);
    if (len > rad * 0.62) { dx *= (rad * 0.62) / len; dy *= (rad * 0.62) / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stick.dataset.dir = [...want].join(' ');
  };
  const stickEnd = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    setDir(new Set());
    knob.style.transform = '';
    stick.dataset.dir = '';
  };
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    unlockAudio();
    stickId = e.pointerId;
    stick.setPointerCapture?.(e.pointerId);
    stickMove(e);
  });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);
  stick.addEventListener('lostpointercapture', stickEnd);
  stick.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- Feuer: halten = Kraft aufladen, loslassen = Wurf. Zielwaffen: erst Ziel antippen, dann bestätigen.
  const fire = $('t-fire');
  let fireHeld = false;
  holdButton(fire, () => {
    unlockAudio();
    if (confirmMode()) {
      if (!game.confirmTouchTarget()) toast('Erst das Ziel im Lager antippen!', '#00e5ff');
      return;
    }
    fireHeld = true;
    game.keyDown('Space');
  }, () => {
    if (fireHeld) { fireHeld = false; game.keyUp('Space'); }
  });
  holdButton($('t-jump'), () => { unlockAudio(); game.keyDown('Enter'); }, () => game.keyUp('Enter'));
  holdButton($('t-flip'), () => { unlockAudio(); game.keyDown('Backspace'); }, () => game.keyUp('Backspace'));

  // ---- Leiste unten: Waffenmenü, Kamera, Chat
  $('t-weapon').onclick = () => { unlockAudio(); toggleWeapons(); };
  $('t-cam').onclick = () => { game.manualCam = false; };
  $('t-chat').onclick = () => {
    document.body.classList.add('chatopen');
    $('chatinput').focus();
  };
  $('chatinput').addEventListener('blur', () => document.body.classList.remove('chatopen'));

  function confirmMode() {
    const wpn = WEAPON_BY_ID[game.weapon];
    return !!game.myTurn && game.tp === 'aim' && !!wpn.target && !wpn.charge && !game.mv && !game.drill && !(game.walker && !game.walker.dead);
  }

  let lastKey = '';
  return {
    // Jeden Frame: Knöpfe passend zum Spielzustand zeigen/beschriften.
    update(playing) {
      const mine = playing && game.myTurn;
      const wpn = WEAPON_BY_ID[game.weapon];
      const confirm = !!(mine && confirmMode());
      const ready = !!(confirm && game.touchTargetReady());
      const aiming = !!(mine && game.tp === 'aim');
      const key = [mine, confirm, ready, aiming, game.weapon, game.charging].join('|');
      if (key === lastKey) return;
      lastKey = key;
      document.body.classList.toggle('myturn', !!mine);
      fire.classList.toggle('confirm', confirm);
      fire.classList.toggle('dim', confirm && !ready);
      fire.innerHTML = confirm ? `🎯<small>${wpn.kind === 'girder' ? 'Bauen' : 'Los!'}</small>` : `🔥<small>${wpn.charge ? 'Halten' : 'Feuer'}</small>`;
      $('t-wicon').textContent = wpn.icon;
      $('t-weapon').disabled = !aiming;
      if (!aiming) closeWeapons();
    },
  };
}

export function toggleWeapons(open) {
  const el = $('weapons');
  const want = open ?? !el.classList.contains('open');
  el.classList.toggle('open', want);
  $('t-weapon')?.classList.toggle('on', want);
}
export function closeWeapons() { toggleWeapons(false); }

// ---- Vollbild (Android/iPad/Desktop). iPhone-Safari kann das nicht – dort hilft nur die PWA.
function setupFullscreen() {
  const btn = $('fullscreen');
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  // iPhone meldet die API teils, kann aber keine Seite im Vollbild zeigen
  if (!btn || !req || standalone || /iPhone|iPod/.test(navigator.userAgent)) return;
  btn.classList.remove('hidden');
  btn.onclick = async () => {
    const cur = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (cur) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else {
        await req.call(root, { navigationUI: 'hide' });
        if (isTouch) await screen.orientation?.lock?.('landscape').catch(() => {});
      }
    } catch { /* abgelehnt – egal */ }
  };
}

// ---- „Zum Home-Bildschirm“: Android bietet einen Installieren-Dialog, iOS braucht einen Hinweis.
function setupInstallHints() {
  if (!isTouch || standalone) return;
  const hint = $('installhint');
  if (!hint) return;
  if (isIOS) {
    hint.innerHTML = '📲 Tipp fürs iPhone: <b>Teilen → „Zum Home-Bildschirm“</b> – dann läuft Wormhouse im Vollbild wie eine App.';
    hint.classList.remove('hidden');
    return;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    hint.innerHTML = '<button id="install" class="small">📲 Als App installieren (Vollbild)</button>';
    hint.classList.remove('hidden');
    $('install').onclick = async () => {
      hint.classList.add('hidden');
      e.prompt();
    };
  });
}
