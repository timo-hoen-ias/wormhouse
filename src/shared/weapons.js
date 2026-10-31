// Das Lager-Arsenal. ammo: -1 = unbegrenzt, sonst Anzahl pro Team und Spiel.
export const WEAPONS = [
  {
    id: 'paket', name: 'Paketkanone', icon: '📦', kind: 'projectile', charge: true, wind: true,
    radius: 46, damage: 50, ammo: -1,
    desc: 'Ein Expresspaket mit Wucht. Windanfällig, explodiert beim Aufprall.',
  },
  {
    id: 'folie', name: 'Stretchfolien-Granate', icon: '🌀', kind: 'grenade', charge: true,
    fuse: 3, bounce: 0.5, radius: 46, damage: 45, ammo: -1,
    desc: 'Straff gewickelt, springt herum und platzt nach 3 Sekunden.',
  },
  {
    id: 'kiste', name: 'Kleinteile-Kiste', icon: '🔩', kind: 'grenade', charge: true,
    fuse: 3, bounce: 0.4, radius: 34, damage: 30, cluster: 5, ammo: 2,
    desc: 'Sichtlagerkasten voller Schrauben. Zerplatzt in Splitter.',
  },
  {
    id: 'scanner', name: 'Barcode-Scanner', icon: '🔫', kind: 'hitscan', shots: 2,
    radius: 12, damage: 20, ammo: -1,
    desc: 'Zwei Laser-Scans. Piep! Kein Wind, keine Schwerkraft.',
  },
  {
    id: 'hubwagen', name: 'Hubwagen-Rempler', icon: '🛒', kind: 'melee',
    damage: 30, ammo: -1,
    desc: 'Volle Kanne mit dem Handhubwagen. Schubst Kollegen weit weg.',
  },
  {
    id: 'stapler', name: 'Amok-Stapler', icon: '🚜', kind: 'walker',
    fuse: 7, radius: 70, damage: 70, ammo: 1,
    desc: 'Führerloser Gabelstapler. Fährt los, Leertaste zündet (sonst nach 7 s).',
  },
  {
    id: 'gas', name: 'Propangasflasche', icon: '🧯', kind: 'drop',
    fuse: 5, radius: 75, damage: 75, ammo: 1,
    desc: 'Staplergas. Abstellen, weglaufen, 5 Sekunden.',
  },
  {
    id: 'palette', name: 'Paletten-Abwurf', icon: '🪵', kind: 'airstrike', target: true,
    count: 5, radius: 36, damage: 30, ammo: 1,
    desc: 'Der Kran lässt fünf Europaletten fallen. Ziel anklicken.',
  },
  {
    id: 'inventur', name: 'Inventurfehler', icon: '📋', kind: 'teleport', target: true,
    ammo: 2,
    desc: 'Laut System stehst du ganz woanders. Zielort anklicken.',
  },
  {
    id: 'karton', name: 'Kartonbrücke', icon: '🧱', kind: 'girder', target: true,
    ammo: 3,
    desc: 'Zusammengeklebte Kartons als Brücke. Drehen mit ↑/↓, klicken zum Bauen.',
  },
  {
    id: 'pause', name: 'Kaffeepause', icon: '☕', kind: 'skip', ammo: -1,
    desc: "Zug aussetzen. Erstmal 'nen Kaffee.",
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

export function initialAmmo() {
  return Object.fromEntries(WEAPONS.map((w) => [w.id, w.ammo]));
}

// Kompakte Kennung für Projektiltypen in Netzwerk-Snapshots.
export const PROJECTILE_TYPES = ['paket', 'folie', 'kiste', 'frag', 'stapler', 'gas', 'palette'];
