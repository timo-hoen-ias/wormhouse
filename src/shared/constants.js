// Gemeinsame Konstanten für Client und Server.
// Koordinaten: Pixel, y zeigt nach UNTEN (wie im Canvas).
export const WORLD_W = 2400;
export const WORLD_H = 1200;
export const WATER_Y = 1130; // darunter: das Hafenbecken
export const TURN_TIME = 45; // Sekunden pro Zug
export const RETREAT_TIME = 3; // Sekunden Rückzug nach dem Schuss
export const TURN_GRACE_MS = 20000; // Server erzwingt Zugwechsel nach Ablauf + Gnadenfrist
export const GRAVITY = 700;
export const WORKER_R = 9;
export const MAX_HP = 100;
export const MAX_PLAYERS = 4;

export const TEAM_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835'];

export const WORKER_NAMES = [
  'Kalle', 'Jürgen', 'Gabi', 'Uwe', 'Heike', 'Detlef', 'Mandy', 'Ronny',
  'Sven', 'Bärbel', 'Horst', 'Jacqueline', 'Kevin', 'Doris', 'Olaf', 'Chantal',
  'Bernd', 'Petra', 'Ralf', 'Sabine', 'Dieter', 'Yvonne', 'Klaus', 'Manni',
];

export const BOT_TEAM_NAME = 'Inventur-Dummies';
