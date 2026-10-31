// Kartenwahl in der Lobby (Einzelspieler & Mehrspieler): Karten-Kacheln mit
// Vorschau, Komplexität und „neu würfeln“. Die Vorschau nutzt denselben
// Generator und Seed wie das Spiel, zeigt also genau die Halle, die kommt.
import { MAP_CHOICES, MAP_BY_ID, COMPLEXITY } from '../shared/maps.js';
import { generateTerrain } from '../shared/terrain-gen.js';
import { WORLD_W as W, WORLD_H as H, WATER_Y } from '../shared/constants.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PALETTE = [null, [196, 152, 98], [118, 120, 128], [86, 128, 190], [222, 178, 112]];
const AIR = [22, 26, 34], WATER = [32, 74, 128];

const cache = new Map(); // `${id}:${c}:${seed}` -> Uint8Array
function terrainFor(id, c, seed) {
  const key = `${id}:${c}:${seed}`;
  let mat = cache.get(key);
  if (!mat) {
    if (cache.size > 40) cache.clear();
    mat = generateTerrain(seed, id, c);
    cache.set(key, mat);
  }
  return mat;
}

function draw(canvas, mat) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const wy = Math.floor((y + 0.5) * sy);
    for (let x = 0; x < w; x++) {
      const wx = Math.floor((x + 0.5) * sx);
      // Dünne Träger nicht verschlucken: ein paar Proben pro Pixel
      let m = 0;
      for (let k = 0; k < 4 && !m; k++) {
        const yy = Math.min(H - 1, Math.floor(y * sy + (k * sy) / 4));
        m = mat[yy * W + Math.min(W - 1, Math.floor(x * sx + ((k * 3) % 4) * sx / 4))];
      }
      const c = m ? PALETTE[m] : wy > WATER_Y ? WATER : AIR;
      const p = (y * w + x) * 4;
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

let lastKey = '';
let job = 0;

// el: Container, rules: state.rules, seed: state.mapSeed, send(patch) / reroll()
export function renderMapPicker(el, { rules, seed, isHost, send, reroll }) {
  const sel = rules?.map ?? 'lager';
  const cx = rules?.complexity ?? 1;
  const key = [sel, cx, seed, isHost].join('|');
  if (key === lastKey && el.childElementCount) return;
  lastKey = key;
  const dis = isHost ? '' : 'disabled';
  const cur = MAP_CHOICES.find((m) => m.id === sel) || MAP_CHOICES[0];
  el.innerHTML = `
    <div class="mapgrid">${MAP_CHOICES.map((m) => `
      <button class="mapcard${m.id === sel ? ' sel' : ''}${m.rope ? ' rope' : ''}" data-map="${m.id}" ${dis} title="${esc(m.desc)}">
        ${m.random ? `<div class="mapdice">${m.icon}</div>` : `<canvas width="120" height="60" data-thumb="${m.id}"></canvas>`}
        <span>${m.random ? '' : `${m.icon} `}${esc(m.name)}</span>${m.rope ? '<i>Seil</i>' : ''}
      </button>`).join('')}
    </div>
    <div class="maprow">
      <span>Komplexität</span>
      <div class="seg">${COMPLEXITY.map((c) => `<button class="small${c.level === cx ? ' sel' : ''}" data-cx="${c.level}" ${dis} title="${esc(c.desc)}">${esc(c.name)}</button>`).join('')}</div>
    </div>
    <div class="mapbig">
      ${cur.random ? `<div class="mapdice big">${cur.icon}<small>wird beim Schichtbeginn ausgelost</small></div>` : '<canvas width="480" height="240" id="mapbigcanvas"></canvas>'}
      <div class="mapdesc"><b>${cur.icon} ${esc(cur.name)}</b> · ${esc(COMPLEXITY[cx]?.name || '')}<br>${esc(cur.desc)}${cur.rope ? '<br><em>Spanngurt-Seil unbegrenzt (falls im Waffenlager nicht anders eingestellt).</em>' : ''}</div>
      ${isHost && !cur.random ? '<button class="small" id="reroll">🎲 Andere Halle würfeln</button>' : ''}
    </div>`;
  el.querySelectorAll('[data-map]').forEach((b) => { b.onclick = () => send({ map: b.dataset.map }); });
  el.querySelectorAll('[data-cx]').forEach((b) => { b.onclick = () => send({ complexity: +b.dataset.cx }); });
  const rr = el.querySelector('#reroll');
  if (rr) rr.onclick = reroll;

  // Vorschauen nacheinander zeichnen, damit die Lobby nicht hakt.
  const my = ++job;
  const todo = [];
  const big = el.querySelector('#mapbigcanvas');
  if (big) todo.push([big, cur.id]);
  el.querySelectorAll('[data-thumb]').forEach((c) => todo.push([c, c.dataset.thumb]));
  const step = () => {
    if (my !== job || !todo.length) return;
    const [canvas, id] = todo.shift();
    if (MAP_BY_ID[id]) draw(canvas, terrainFor(id, cx, seed >>> 0));
    setTimeout(step, 0);
  };
  step();
}
