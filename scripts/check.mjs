// Schneller Selbsttest ohne Browser: Level-Generator deterministisch? Spawns gültig? Waffen konsistent?
import { generateTerrain, findSpawns, isFree } from '../src/shared/terrain-gen.js';
import { WEAPONS, PROJECTILE_TYPES } from '../src/shared/weapons.js';
import { WORKER_R, WATER_Y } from '../src/shared/constants.js';

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

if (fails) { console.error(`${fails} Fehler`); process.exit(1); }
console.log('Alles gut.');
