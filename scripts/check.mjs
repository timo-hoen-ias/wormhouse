// Schneller Selbsttest ohne Browser: Level-Generator deterministisch? Spawns gültig? Waffen konsistent?
import { generateTerrain, findSpawns, isFree } from '../src/shared/terrain-gen.js';
import { WEAPONS, PROJECTILE_TYPES } from '../src/shared/weapons.js';
import { WORKER_R, WATER_Y, GRAVITY } from '../src/shared/constants.js';
import { fallDamage } from '../src/shared/fall.js';

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
ok(WEAPONS.length <= 11, 'Alle Waffen haben eine Taste (1–0, ß)');
ok(['paket', 'folie', 'kiste', 'stapler', 'palette'].every((t) => PROJECTILE_TYPES.includes(t)), 'Projektiltypen vollständig');

const fallFrom = (h) => fallDamage(Math.sqrt(2 * GRAVITY * h));
ok(fallFrom(60) === 0 && fallFrom(150) === 0, 'Kleine Sprünge/Stürze (< 150 px) kosten nichts');
ok(fallFrom(250) > 0 && fallFrom(250) < 20, `Sturz aus 250 px tut etwas weh (${fallFrom(250)} HP)`);
ok(fallFrom(500) > fallFrom(250) && fallFrom(500) <= 50, `Sturz aus 500 px tut mehr weh (${fallFrom(500)} HP)`);
ok(fallFrom(5000) === 50, 'Fallschaden ist auf 50 HP gedeckelt');

if (fails) { console.error(`${fails} Fehler`); process.exit(1); }
console.log('Alles gut.');
