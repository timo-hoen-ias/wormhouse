// Das Lager-Arsenal. ammo: -1 = unbegrenzt, sonst Anzahl pro Team und Spiel.
// cat: Fach im Waffenregal (Taste 1–9, 0). Mehrfach drücken schaltet durch das Fach.
// util: Hilfsmittel – beendet den Zug nicht, danach darf noch geschossen werden.
export const WEAPONS = [
  // Fach 1: Geschütze
  {
    id: 'paket', name: 'Paketkanone', icon: '📦', kind: 'projectile', charge: true, wind: true, cat: 1,
    radius: 46, damage: 50, ammo: -1,
    desc: 'Ein Expresspaket mit Wucht. Windanfällig, explodiert beim Aufprall.',
  },
  {
    id: 'sendung', name: 'Sendungsverfolgung', icon: '📡', kind: 'homing', charge: true, target: true, cat: 1,
    radius: 42, damage: 45, ammo: 2,
    desc: 'Erst Ziel anklicken, dann abfeuern: Das Paket findet seinen Empfänger selbst.',
  },
  // Fach 2: Granaten
  {
    id: 'folie', name: 'Stretchfolien-Granate', icon: '🌀', kind: 'grenade', charge: true, cat: 2,
    fuse: 3, bounce: 0.5, radius: 46, damage: 45, ammo: -1,
    desc: 'Straff gewickelt, springt herum und platzt nach 3 Sekunden.',
  },
  {
    id: 'kiste', name: 'Kleinteile-Kiste', icon: '🔩', kind: 'grenade', charge: true, cat: 2,
    fuse: 3, bounce: 0.4, radius: 34, damage: 30, cluster: 5, ammo: 2,
    desc: 'Sichtlagerkasten voller Schrauben. Zerplatzt in Splitter.',
  },
  // Fach 3: Schwere Granaten
  {
    id: 'retoure', name: 'Retouren-Lawine', icon: '🎁', kind: 'grenade', charge: true, cat: 3,
    fuse: 3, bounce: 0.45, radius: 40, damage: 40, cluster: 5, clusterType: 'retoure2', ammo: 1,
    desc: 'Ein Paket voller Rücksendungen. Platzt und verteilt fünf Pakete, die beim Aufprall hochgehen.',
  },
  {
    id: 'fass', name: 'Gefahrgut-Fass', icon: '☢️', kind: 'grenade', charge: true, cat: 3,
    fuse: 3, bounce: 0.15, radius: 100, damage: 90, ammo: 1,
    desc: 'Klasse 1, ganz unten im Regal. Schwer, rollt kaum – und dann: Halleluja.',
  },
  // Fach 4: Schusswaffen
  {
    id: 'scanner', name: 'Barcode-Scanner', icon: '🔫', kind: 'hitscan', shots: 2, cat: 4,
    radius: 12, damage: 20, ammo: -1,
    desc: 'Zwei Laser-Scans. Piep! Kein Wind, keine Schwerkraft.',
  },
  {
    id: 'tacker', name: 'Elektrotacker', icon: '📎', kind: 'burst', shots: 12, cat: 4,
    radius: 5, damage: 4, push: 45, spread: 0.07, ammo: 2,
    desc: '12 Klammern im Dauerfeuer. Während des Feuerns mit ↑/↓ nachzielen.',
  },
  // Fach 5: Nahkampf
  {
    id: 'hubwagen', name: 'Hubwagen-Rempler', icon: '🛒', kind: 'melee', cat: 5,
    damage: 30, ammo: -1,
    desc: 'Volle Kanne mit dem Handhubwagen. Schubst Kollegen weit weg.',
  },
  {
    id: 'stempel', name: 'Stempel-Uppercut', icon: '🔨', kind: 'uppercut', cat: 5,
    damage: 30, ammo: 2,
    desc: 'ABGESTEMPELT! Springt hoch und haut alles davor in die Luft.',
  },
  // Fach 6: Ferngesteuertes
  {
    id: 'stapler', name: 'Amok-Stapler', icon: '🚜', kind: 'walker', cat: 6,
    fuse: 7, radius: 70, damage: 70, ammo: 1,
    desc: 'Führerloser Gabelstapler. Fährt los, Leertaste zündet (sonst nach 7 s).',
  },
  {
    id: 'drohne', name: 'Inventur-Drohne', icon: '🛸', kind: 'drone', cat: 6,
    fuse: 8, radius: 60, damage: 60, ammo: 1,
    desc: 'Fliegt geradeaus, ←/→ lenken, Leertaste zündet. Akku hält 8 Sekunden.',
  },
  {
    id: 'gas', name: 'Propangasflasche', icon: '🧯', kind: 'drop', cat: 6,
    fuse: 5, radius: 75, damage: 75, ammo: 1,
    desc: 'Staplergas. Abstellen, weglaufen, 5 Sekunden.',
  },
  // Fach 7: Von oben
  {
    id: 'palette', name: 'Paletten-Abwurf', icon: '🪵', kind: 'airstrike', target: true, cat: 7,
    count: 5, radius: 36, damage: 30, ammo: 1,
    desc: 'Der Kran lässt fünf Europaletten fallen. Ziel anklicken.',
  },
  {
    id: 'tresor', name: 'Panzerschrank', icon: '🗄️', kind: 'heavy', target: true, cat: 7,
    radius: 48, damage: 40, hits: 6, ammo: 1,
    desc: 'Der Lohnbüro-Tresor fällt senkrecht und schlägt sich durch alles durch. Ziel anklicken.',
  },
  // Fach 8: Werkzeug
  {
    id: 'bohrer', name: 'Bohrhammer', icon: '⛏️', kind: 'drill', cat: 8,
    radius: 13, ammo: 2,
    desc: '3,5 Sekunden in Zielrichtung bohren (auch senkrecht nach unten). Leertaste stoppt.',
  },
  {
    id: 'karton', name: 'Kartonbrücke', icon: '🧱', kind: 'girder', target: true, cat: 8,
    ammo: 3,
    desc: 'Zusammengeklebte Kartons als Brücke. Drehen mit ↑/↓, klicken zum Bauen.',
  },
  // Fach 9: Bewegung (Hilfsmittel, Zug geht danach weiter)
  {
    id: 'seil', name: 'Spanngurt-Seil', icon: '🧗', kind: 'rope', util: true, cat: 9,
    ammo: -1,
    desc: 'Ninja-Seil wie in Worms: ↑/↓ zielen, Leertaste schießt den Haken. Am Gurt ←/→ schwingen, ↑/↓ einholen (macht schneller) / ausfahren. Leertaste lässt los, Schwung bleibt; in der Luft neu schießen (5× einhaken). Vom Seil Granaten, Gas & Stapler abwerfen.',
  },
  {
    id: 'rucksack', name: 'Druckluft-Rucksack', icon: '🎒', kind: 'jet', util: true, cat: 9,
    fuel: 6, ammo: 2,
    desc: 'Jetpack: ↑ Schub, ←/→ seitlich, Leertaste schaltet ab. 6 Sekunden Druckluft.',
  },
  {
    id: 'fallschirm', name: 'Planen-Fallschirm', icon: '🪂', kind: 'chute', util: true, cat: 9,
    ammo: 3,
    desc: 'Öffnet im Fall automatisch (oder Leertaste in der Luft). Kein Fallschaden, der Wind treibt.',
  },
  {
    id: 'expander', name: 'Gummi-Expander', icon: '➰', kind: 'bungee', util: true, cat: 9,
    ammo: 2,
    desc: 'Bungee: Einhaken, von der Kante springen, federn. Leertaste lässt los.',
  },
  {
    id: 'inventur', name: 'Inventurfehler', icon: '📋', kind: 'teleport', target: true, cat: 9,
    ammo: 2,
    desc: 'Laut System stehst du ganz woanders. Zielort anklicken.',
  },
  // Fach 0: Pause
  {
    id: 'pause', name: 'Kaffeepause', icon: '☕', kind: 'skip', cat: 10, ammo: -1,
    desc: "Zug aussetzen. Erstmal 'nen Kaffee.",
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

// Fächer in Tastenreihenfolge (1–9, 0)
export const WEAPON_CATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => WEAPONS.filter((w) => w.cat === c));

export function initialAmmo() {
  return Object.fromEntries(WEAPONS.map((w) => [w.id, w.ammo]));
}

// Kompakte Kennung für Projektiltypen in Netzwerk-Snapshots (nur hinten anfügen!).
export const PROJECTILE_TYPES = [
  'paket', 'folie', 'kiste', 'frag', 'stapler', 'gas', 'palette',
  'sendung', 'retoure', 'retoure2', 'fass', 'drohne', 'tresor',
];

// Waffen-Arten, bei denen der Arbeiter mit dem Arm zielt (Fadenkreuz)
export const AIM_KINDS = ['projectile', 'grenade', 'hitscan', 'homing', 'burst', 'rope', 'drill', 'drone'];
