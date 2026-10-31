// Kartenkatalog: welche Lagerhallen es gibt und wie verwinkelt sie werden.
// Reine Metadaten (kein Generator-Code), damit Lobby, Server und Generator
// dieselbe Liste lesen. Die Generatoren selbst liegen in terrain-gen.js.

export const MAPS = [
  { id: 'lager', name: 'Hochregallager', icon: '🏭', desc: 'Der Klassiker: hügeliger Hallenboden, Höhlen, schwebende Regalböden und Kartonstapel.' },
  { id: 'inseln', name: 'Verladerampen', icon: '🚢', desc: 'Einzelne Rampen-Inseln mit Wasser dazwischen. Wer danebenspringt, geht baden.' },
  { id: 'regale', name: 'Hochregal-Gassen', icon: '🗄️', desc: 'Riesige Stahlregale mit vielen Ebenen. Kämpfe Etage für Etage.' },
  { id: 'paketberg', name: 'Paketberg', icon: '⛰️', desc: 'Ein gewaltiger Berg aus Retouren in der Mitte, voller Gänge. King of the Hill.' },
  { id: 'keller', name: 'Kühlkeller', icon: '🧊', desc: 'Geschlossenes Gewölbe mit Decke, Eiszapfen und Pfeilern. Steilschüsse prallen ab.' },
  { id: 'kranbahn', name: 'Kranbahn', icon: '🏗️', rope: true, desc: 'Seil-Arena: kaum Boden, eine Kranschiene unter dem Dach und überall hängende Lasten zum Einhaken.' },
  { id: 'haengeregal', name: 'Hängeregale', icon: '🧗', rope: true, desc: 'Seil-Parcours: Regaltürme hängen von der Decke, unten nur schmale Pfeiler im Hafenbecken.' },
];

export const MAP_BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));

// Auswahl in der Lobby: konkrete Karten plus Zufall.
export const MAP_CHOICES = [
  ...MAPS,
  { id: 'zufall', name: 'Zufall', icon: '🎲', random: true, desc: 'Bei jedem Schichtbeginn eine zufällige normale Karte.' },
  { id: 'zufall-seil', name: 'Zufall (Seil)', icon: '🎰', random: true, rope: true, desc: 'Zufällige Seil-Karte.' },
];

export const MAP_CHOICE_IDS = new Set(MAP_CHOICES.map((m) => m.id));

export const COMPLEXITY = [
  { level: 0, name: 'Schlicht', desc: 'wenig Deckung, freie Schussbahnen' },
  { level: 1, name: 'Normal', desc: 'ausgewogen' },
  { level: 2, name: 'Verwinkelt', desc: 'mehr Höhlen, Regale und Stapel' },
  { level: 3, name: 'Labyrinth', desc: 'zugestellt bis unters Dach' },
];

export const DEFAULT_MAP = 'lager';
export const DEFAULT_COMPLEXITY = 1;

// Zufallswahl am Spielstart in eine konkrete Karte auflösen (nur der Server würfelt).
export function resolveMap(choice, rnd = Math.random) {
  if (MAP_BY_ID[choice]) return choice;
  const pool = MAPS.filter((m) => !!m.rope === (choice === 'zufall-seil'));
  return pool[Math.floor(rnd() * pool.length)].id;
}

export const isRopeMap = (id) => !!MAP_BY_ID[id]?.rope;
