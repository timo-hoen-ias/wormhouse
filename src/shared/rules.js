// Spielregeln, die die Schichtleitung in der Lobby einstellen kann.
// Alles ist generisch über Optionslisten definiert: Lobby-UI und Server-Prüfung
// lesen dieselben Definitionen. Waffen-Munition wird aus der Waffenliste
// abgeleitet, neue Waffen tauchen also automatisch in den Einstellungen auf.
import { WEAPONS } from './weapons.js';
import { MAP_CHOICE_IDS, MAP_BY_ID, COMPLEXITY, DEFAULT_MAP, DEFAULT_COMPLEXITY } from './maps.js';

export const RULES = [
  { key: 'turnTime', label: 'Zugzeit', def: 45,
    options: [[15, '15 s'], [20, '20 s'], [30, '30 s'], [45, '45 s'], [60, '60 s'], [90, '90 s']] },
  { key: 'retreatTime', label: 'Rückzugszeit', def: 3,
    options: [[0, 'keine'], [2, '2 s'], [3, '3 s'], [5, '5 s']] },
  { key: 'workersPerTeam', label: 'Arbeiter pro Team', def: 3,
    options: [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']] },
  { key: 'hp', label: 'Lebenspunkte', def: 100,
    options: [[50, '50'], [75, '75'], [100, '100'], [150, '150'], [200, '200']] },
  { key: 'wind', label: 'Wind (Hallenlüftung)', def: 1,
    options: [[0, 'aus'], [0.5, 'schwach'], [1, 'normal'], [1.6, 'stark']] },
  { key: 'fallDamage', label: 'Fallschaden', def: 1,
    options: [[1, 'an'], [0, 'aus']] },
  { key: 'suddenDeath', label: 'Sudden Death nach', def: 15,
    options: [[0, 'nie'], [3, '3 min'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [20, '20 min'], [30, '30 min']] },
  { key: 'suddenWater', label: 'Sudden Death', def: 1,
    options: [[1, 'alle auf 1 HP + Wasser steigt'], [0, 'nur alle auf 1 HP']] },
];

export const RULE_BY_KEY = Object.fromEntries(RULES.map((r) => [r.key, r]));

// Munitionsoptionen in den Einstellungen. -1 = unbegrenzt, 0 = nicht im Lager.
export const AMMO_OPTIONS = [[-1, '∞'], [0, 'aus'], [1, '1'], [2, '2'], [3, '3'], [5, '5']];

// Waffen, deren Munition einstellbar ist (Zug aussetzen bleibt immer verfügbar).
export function configurableWeapons() {
  return WEAPONS.filter((w) => w.kind !== 'skip');
}

export const AMMO_PRESETS = {
  standard: { label: 'Standard', ammo: () => ({}) },
  voll: { label: 'Volles Lager (alles ∞)', ammo: () => Object.fromEntries(configurableWeapons().map((w) => [w.id, -1])) },
  knapp: { label: 'Inventur knapp (alles 1×)', ammo: () => Object.fromEntries(configurableWeapons().map((w) => [w.id, w.ammo < 0 && w.id === 'paket' ? -1 : 1])) },
};

// Spielmodi: komplette Regel-Vorlagen (Regeln + Waffenlager + Karte).
// „Rope only“ wie die Rope-Matches in Worms: nur Seil und Schläger (bei uns der
// Hubwagen), Schaden entsteht fast nur durchs Wegschubsen ins Hafenbecken.
export const MODE_WEAPONS = { seil: ['seil', 'hubwagen'] };
export const GAME_MODES = {
  standard: {
    label: 'Standard', icon: '📦',
    desc: 'Volles Lager mit allen Waffen, normale Regeln.',
    apply: (cur) => ({ ...Object.fromEntries(RULES.map((d) => [d.key, d.def])), ammo: {}, map: MAP_BY_ID[cur.map]?.rope || cur.map === 'zufall-seil' ? DEFAULT_MAP : cur.map }),
  },
  seil: {
    label: 'Rope only', icon: '🧗',
    desc: 'Seil-Match wie online in Worms: nur Spanngurt-Seil (∞) und Hubwagen. Kurze Züge, kein Fallschaden – wer ins Wasser geschubst wird, ist raus. Schubsen geht nur im freien Flug nach dem Loslassen.',
    apply: (cur) => ({
      turnTime: 20, retreatTime: 3, hp: 100, wind: 0, fallDamage: 0, suddenDeath: 10, suddenWater: 1,
      ammo: Object.fromEntries(configurableWeapons().map((w) => [w.id, MODE_WEAPONS.seil.includes(w.id) ? -1 : 0])),
      map: MAP_BY_ID[cur.map]?.rope || cur.map === 'zufall-seil' ? cur.map : 'zufall-seil',
    }),
  },
};

// Regeln für einen Spielmodus (ausgehend von den aktuellen Regeln, z.B. für die Karte).
export function modeRules(mode, cur = defaultRules()) {
  const m = GAME_MODES[mode] || GAME_MODES.standard;
  return { ...m.apply(cur), mode: GAME_MODES[mode] ? mode : 'standard' };
}

export function defaultRules() {
  const r = Object.fromEntries(RULES.map((d) => [d.key, d.def]));
  r.ammo = {};
  r.mode = 'standard';
  r.map = DEFAULT_MAP; // Karten-ID aus maps.js oder 'zufall' / 'zufall-seil'
  r.complexity = DEFAULT_COMPLEXITY;
  return r;
}

// Nimmt beliebige (Client-)Eingaben und gibt gültige Regeln zurück.
export function sanitizeRules(input, base = defaultRules()) {
  const def = defaultRules();
  const out = { ...def, ...base, ammo: { ...(base.ammo || {}) } };
  if (!MAP_CHOICE_IDS.has(out.map)) out.map = def.map;
  if (!COMPLEXITY.some((c) => c.level === out.complexity)) out.complexity = def.complexity;
  if (!GAME_MODES[out.mode]) out.mode = def.mode;
  if (!input || typeof input !== 'object') return out;
  if ('mode' in input && GAME_MODES[input.mode]) out.mode = input.mode;
  if ('map' in input && MAP_CHOICE_IDS.has(input.map)) out.map = input.map;
  if ('complexity' in input && COMPLEXITY.some((c) => c.level === +input.complexity)) out.complexity = +input.complexity;
  for (const d of RULES) {
    if (!(d.key in input)) continue;
    const v = +input[d.key];
    if (d.options.some(([o]) => o === v)) out[d.key] = v;
  }
  if (input.ammo && typeof input.ammo === 'object') {
    const allowed = new Set(AMMO_OPTIONS.map(([o]) => o));
    const ids = new Set(configurableWeapons().map((w) => w.id));
    out.ammo = {};
    for (const [id, n] of Object.entries(input.ammo)) {
      if (ids.has(id) && allowed.has(+n)) out.ammo[id] = +n;
    }
  }
  return out;
}

// Startmunition eines Teams nach den Regeln (Standard = Wert aus der Waffenliste).
export function ammoFromRules(rules) {
  const over = rules?.ammo || {};
  return Object.fromEntries(WEAPONS.map((w) => [w.id, w.kind === 'skip' ? -1 : (over[w.id] ?? w.ammo)]));
}

// KI-Gegner
export const BOT_LEVELS = [
  { level: 0, name: 'Dummy', desc: 'steht nur rum (Zielscheibe)' },
  { level: 1, name: 'Azubi', desc: 'zielt grob, ignoriert den Wind, wenige Waffen' },
  { level: 2, name: 'Fachkraft', desc: 'rechnet mit Wind, Stapler & Sendungsverfolgung, läuft nach dem Wurf weg' },
  { level: 3, name: 'Lagermeister', desc: 'trifft fast immer, nutzt das ganze Lager inkl. Drohne, Tresor & Rucksack' },
];

export const BOT_TEAM_NAMES = [
  'Inventur-Dummies', 'Spätschicht', 'Leiharbeiter', 'Retourenabteilung', 'Qualitätssicherung',
  'Betriebsrat', 'Nachtschicht', 'Kommissionierer', 'Wareneingang', 'Controlling',
];

export const MAX_TEAMS = 6;
export const SUDDEN_WATER_STEP = 22; // so viele Pixel steigt das Hafenbecken pro Zug
export const MIN_WATER_Y = 260;
