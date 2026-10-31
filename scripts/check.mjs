// Schneller Selbsttest ohne Browser: Level-Generator deterministisch? Spawns gültig? Waffen konsistent?
import { generateTerrain, findSpawns, isFree } from '../src/shared/terrain-gen.js';
import { WEAPONS, WEAPON_CATS, PROJECTILE_TYPES } from '../src/shared/weapons.js';
import { WORKER_R, WATER_Y, GRAVITY } from '../src/shared/constants.js';
import { fallDamage } from '../src/shared/fall.js';
import { sanitizeRules, defaultRules, ammoFromRules, configurableWeapons, AMMO_PRESETS } from '../src/shared/rules.js';
import { planTurn, planMove, teleportSpot, maskTerrain, LEVELS } from '../src/client/ai.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('✗', msg); } else console.log('✓', msg); };

for (const seed of [1, 42, 123456, 987654321]) {
  const a = generateTerrain(seed), b = generateTerrain(seed);
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i += 97) same = a[i] === b[i];
  ok(same, `Seed ${seed}: Level ist deterministisch`);
  const spawns = findSpawns(a, seed, 20);
  ok(spawns.every(([x, y]) => isFree(a, x, y, WORKER_R) && y < WATER_Y), `Seed ${seed}: 20 Startplätze frei und über Wasser`);
}
ok(new Set(WEAPONS.map((w) => w.id)).size === WEAPONS.length, 'Waffen-IDs eindeutig');
ok(WEAPON_CATS.flat().length === WEAPONS.length, 'Jede Waffe liegt in einem Fach (Tasten 1–0)');
ok(WEAPON_CATS.every((c) => c.length > 0 && c.length <= 5), 'Kein Fach leer oder überfüllt');
ok(['paket', 'folie', 'kiste', 'stapler', 'palette', 'sendung', 'retoure', 'retoure2', 'fass', 'drohne', 'tresor'].every((t) => PROJECTILE_TYPES.includes(t)), 'Projektiltypen vollständig');
ok(PROJECTILE_TYPES.slice(0, 7).join() === 'paket,folie,kiste,frag,stapler,gas,palette', 'Alte Projektil-Kennungen unverändert');
ok(WEAPONS.filter((w) => w.util).every((w) => ['rope', 'jet', 'chute', 'bungee'].includes(w.kind)), 'Hilfsmittel haben eine Bewegungsart');

const fallFrom = (h) => fallDamage(Math.sqrt(2 * GRAVITY * h));
ok(fallFrom(60) === 0 && fallFrom(150) === 0, 'Kleine Sprünge/Stürze (< 150 px) kosten nichts');
ok(fallFrom(250) > 0 && fallFrom(250) < 20, `Sturz aus 250 px tut etwas weh (${fallFrom(250)} HP)`);
ok(fallFrom(500) > fallFrom(250) && fallFrom(500) <= 50, `Sturz aus 500 px tut mehr weh (${fallFrom(500)} HP)`);
ok(fallFrom(5000) === 50, 'Fallschaden ist auf 50 HP gedeckelt');

// Spielregeln
const def = defaultRules();
const bad = sanitizeRules({ turnTime: 9999, hp: 'viel', wind: 0.5, ammo: { paket: 3, gibtsnicht: 2, folie: 77 } });
ok(bad.turnTime === def.turnTime && bad.hp === def.hp && bad.wind === 0.5, 'Regeln: ungültige Werte werden verworfen, gültige übernommen');
ok(bad.ammo.paket === 3 && !('gibtsnicht' in bad.ammo) && !('folie' in bad.ammo), 'Regeln: Munition wird geprüft');
const am = ammoFromRules(bad);
ok(am.paket === 3 && am.folie === WEAPONS.find((w) => w.id === 'folie').ammo && am.pause === -1, 'Startmunition folgt den Regeln');
ok(configurableWeapons().every((w) => AMMO_PRESETS.voll.ammo()[w.id] === -1), 'Preset „Volles Lager“ deckt alle Waffen ab');
{
  const a = generateTerrain(7);
  const sp = findSpawns(a, 7, 36);
  ok(sp.every(([x, y]) => y < WATER_Y), '36 Startplätze (6 Teams × 6 Arbeiter) über Wasser');
}

// KI: findet auf echten Leveln brauchbare Schüsse
for (const lvl of [1, 3]) {
  let tries = 0, good = 0;
  const t0 = Date.now();
  for (const seed of [11, 222, 3333, 44444]) {
    const mat = generateTerrain(seed);
    const terrain = maskTerrain(mat);
    const sp = findSpawns(mat, seed, 8);
    for (let i = 0; i + 1 < sp.length; i += 2) {
      const self = { id: 0, team: 0, x: sp[i][0], y: sp[i][1], hp: 100, dead: false };
      const foe = { id: 1, team: 1, x: sp[i + 1][0], y: sp[i + 1][1], hp: 100, dead: false };
      const ctx = { terrain, workers: [self, foe], self, wind: 0.3, waterY: WATER_Y };
      const it = planTurn(ctx, lvl, () => -1);
      let r; do { r = it.next(); } while (!r.done);
      tries++;
      if (r.value && r.value.score > 0) good++;
    }
  }
  const ms = (Date.now() - t0) / tries;
  ok(good / tries >= (lvl === 3 ? 0.6 : 0.3), `KI Stufe ${lvl}: findet in ${good}/${tries} Lagen einen Treffer (${ms.toFixed(0)} ms je Planung)`);
}

// KI: jede neue Waffe wird vom Planer auch wirklich eingesetzt
{
  const run = (it) => { let r; do { r = it.next(); } while (!r.done); return r.value; };
  const setups = [];
  for (const seed of [11, 222, 3333, 44444]) {
    const mat = generateTerrain(seed);
    const terrain = maskTerrain(mat);
    const sp = findSpawns(mat, seed, 9);
    for (let i = 0; i + 2 < sp.length; i += 3) {
      const self = { id: 0, team: 0, x: sp[i][0], y: sp[i][1], hp: 100, dead: false };
      const foe = { id: 1, team: 1, x: sp[i + 1][0], y: sp[i + 1][1], hp: 100, dead: false };
      const foe2 = { id: 2, team: 1, x: sp[i + 2][0], y: sp[i + 2][1], hp: 60, dead: false };
      setups.push({ terrain, mat, workers: [self, foe, foe2], self, wind: 0.3, waterY: WATER_Y, retreatTime: 3 });
    }
  }
  for (const id of ['sendung', 'retoure', 'fass', 'tacker', 'stapler', 'drohne', 'tresor']) {
    const good = setups.filter((ctx) => run(planTurn(ctx, { ...LEVELS[3], weapons: [id] }, () => -1))?.score > 0).length;
    ok(good >= (['tacker', 'stapler'].includes(id) ? 1 : 2), `KI setzt ${id} ein (${good}/${setups.length} Lagen)`);
  }
  // Nahkampf & Gasflasche: Gegner steht direkt daneben
  let melee = 0, gas = 0;
  for (const ctx of setups) {
    const foe = { ...ctx.workers[1], x: ctx.self.x + 18, y: ctx.self.y };
    const c2 = { ...ctx, workers: [ctx.self, foe] };
    if (run(planTurn(c2, { ...LEVELS[3], weapons: ['stempel'] }, () => -1))?.weapon === 'stempel') melee++;
    const g = run(planTurn(c2, { ...LEVELS[3], weapons: ['gas'] }, () => -1));
    if (g?.weapon === 'gas' && g.score > 0 && g.retreat) gas++;
  }
  ok(melee === setups.length, `KI haut mit dem Stempel zu (${melee}/${setups.length})`);
  ok(gas >= 2, `KI stellt Gasflasche ab und läuft weg (${gas}/${setups.length})`);
  const moves = setups.slice(0, 4).filter((ctx) => run(planMove(ctx, 3, () => -1))).length;
  ok(moves >= 2, `KI findet Rucksack-Ziele (${moves}/4)`);
  const tp = setups.map((ctx) => teleportSpot(ctx));
  ok(tp.every((s, i) => s && isFree(setups[i].mat, s.x, s.y, WORKER_R + 1) && s.y < WATER_Y - 60), 'Inventurfehler-Ziele sind frei und trocken');
  const lvlW = (n) => LEVELS[n].weapons.length + LEVELS[n].util.length;
  ok(lvlW(1) < lvlW(2) && lvlW(2) < lvlW(3), 'Höhere KI-Stufen nutzen mehr vom Lager');
}

if (fails) { console.error(`${fails} Fehler`); process.exit(1); }
console.log('Alles gut.');
