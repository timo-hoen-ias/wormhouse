// App-Funktionen: Service Worker (offline spielbar), Installieren-Knopf bzw.
// iOS-Hinweis, Offline-Anzeige und Schutz vor dem iOS-Doppeltipp-Zoom.
import { isTouch, standalone } from './touch.js';

const $ = (id) => document.getElementById(id);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isOnline = () => navigator.onLine !== false;

export function setupPwa({ toast, isMultiplayer }) {
  registerServiceWorker();
  setupInstall();
  setupOffline(toast, isMultiplayer);
  if (isIOS) preventIosZoom();
}

// ---- Service Worker: legt beim ersten Besuch das komplette Spiel in den Cache.
function registerServiceWorker() {
  // Im Vite-Dev-Server (Hot-Reload) stört ein Cache nur.
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service Worker:', err));
  });
}

// ---- Installieren: Chrome/Edge/Android liefern einen Dialog, iOS braucht einen Hinweis.
function setupInstall() {
  const hint = $('installhint');
  if (!hint || standalone) return;
  if (isIOS) {
    hint.innerHTML = '📲 Als App fürs ' + (/iPad/.test(navigator.userAgent) || !/iPhone|iPod/.test(navigator.userAgent) ? 'iPad' : 'iPhone')
      + ': <b>Teilen <span class="ios-share">⎋</span> → „Zum Home-Bildschirm“</b> – dann läuft Wormhouse im Vollbild und auch offline.';
    hint.classList.remove('hidden');
    return;
  }
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    hint.innerHTML = `<button id="install" class="small">📲 Als App installieren${isTouch ? ' (Vollbild)' : ''}</button> <span>– startet wie ein Spiel und läuft auch offline.</span>`;
    hint.classList.remove('hidden');
    $('install').onclick = async () => {
      if (!deferred) return;
      deferred.prompt();
      const { outcome } = await deferred.userChoice.catch(() => ({}));
      deferred = null;
      if (outcome === 'accepted') hint.classList.add('hidden');
    };
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    hint.classList.add('hidden');
  });
}

// ---- Offline: Einzelspieler/Hotseat geht weiter, Mehrspieler-Knöpfe werden gesperrt.
function setupOffline(toast, isMultiplayer) {
  const note = $('offlinenote');
  const render = () => {
    const off = !isOnline();
    document.body.classList.toggle('offline', off);
    note?.classList.toggle('hidden', !off);
    for (const id of ['create', 'join']) {
      const el = $(id);
      if (el) el.disabled = off;
    }
  };
  window.addEventListener('online', () => {
    render();
    if (isMultiplayer()) toast('📶 Wieder online – verbinde neu …', '#a5d6a7');
  });
  window.addEventListener('offline', () => {
    render();
    if (isMultiplayer()) toast('📴 Verbindung weg – Mehrspieler wartet auf Netz.', '#ffb74d');
  });
  render();
}

// ---- iOS: Doppeltipp-Zoom und Seiten-Pinch abstellen. Das Spiel zoomt selbst
// (Pointer-Events auf dem Canvas), daher stören diese Browser-Gesten nur.
// Hauptschutz ist `touch-action: manipulation` (style.css); das hier fängt die
// Fälle ab, in denen Safari das ignoriert (ältere iOS-Versionen, Text-Elemente).
function preventIosZoom() {
  const stop = (e) => e.preventDefault();
  // Safari-eigene Pinch-Gesten (gesture*) – blockiert nicht die Pointer-Events fürs Spiel-Zoom.
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
  document.addEventListener('dblclick', stop, { passive: false });
  // Zweiter Tipp kurz nach dem ersten: Standardaktion (= Zoom) verhindern. Damit
  // schnelle Doppeltipps auf Knöpfe (z.B. Waffenfach durchschalten) trotzdem
  // zählen, wird der Klick selbst ausgelöst.
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = e.timeStamp || performance.now();
    const quick = now - lastEnd < 350;
    lastEnd = now;
    if (!quick || e.touches.length) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    let c = t;
    while (c && !(c.onclick || c.matches('button, a, label, summary'))) c = c.parentElement;
    if (c && !c.disabled) c.click();
  }, { passive: false });
}
