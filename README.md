# 📦 WORMHOUSE – Lagerkoller im Hochregal

Rundenbasiertes Multiplayer-Artillery-Spiel im Stil der Worms-Klassiker: Teams aus **Lagerarbeitern** bekämpfen sich in einer **zerstörbaren Lagerhalle** mit allem, was das Lager hergibt. Gerendert mit **three.js**, gehostet komplett auf **Cloudflare Workers** (Static Assets + Durable Objects für die Spielräume).

## Spielen

1. Seite öffnen, Namen eingeben, **„Neue Schicht starten“**.
2. Den Raumlink (**„Link kopieren“**) an bis zu 3 Kolleg:innen schicken.
3. Die Schichtleitung (wer den Raum erstellt hat) wählt die Arbeiter pro Team und startet.
4. Allein? Dann geht es im Übungsmodus gegen die *Inventur-Dummies*.

Jedes Team zieht abwechselnd mit einem Arbeiter: **45 Sekunden** pro Zug, nach dem Schuss **3 Sekunden Rückzug**. Wer ins Hafenbecken fällt oder keine Lebenspunkte mehr hat, ist gekündigt. Das letzte Team mit Personal gewinnt.

### Steuerung

| Taste | Aktion |
|---|---|
| ← → / A D | laufen |
| ↑ ↓ / W S | zielen (bei der Kartonbrücke: drehen) |
| Leertaste halten / loslassen | Kraft aufladen / werfen (Amok-Stapler: zünden) |
| Enter | Sprung nach vorn |
| ⌫ Backspace | Rückwärtssalto |
| 1 – 0, ß | Waffe wählen (oder unten anklicken) |
| Mausklick | Ziel für Paletten-Abwurf, Inventurfehler, Kartonbrücke |
| Mausrad / Ziehen | Zoom / Kamera verschieben, **C** = Kamera zurück |
| T | Chat |

### Das Arsenal

| | Waffe | Funktion | Munition |
|---|---|---|---|
| 📦 | Paketkanone | Bazooka, windanfällig, explodiert beim Aufprall | ∞ |
| 🌀 | Stretchfolien-Granate | springt, 3 s Zünder | ∞ |
| 🔩 | Kleinteile-Kiste | Splittergranate mit 5 Schrauben | 2 |
| 🔫 | Barcode-Scanner | 2 Laser-Scans, schnurgerade | ∞ |
| 🛒 | Hubwagen-Rempler | Nahkampf, schubst weit weg | ∞ |
| 🚜 | Amok-Stapler | fährt selbstständig, Leertaste zündet | 1 |
| 🧯 | Propangasflasche | abstellen, wegrennen, 5 s | 1 |
| 🪵 | Paletten-Abwurf | Luftschlag mit 5 Europaletten | 1 |
| 📋 | Inventurfehler | Teleport | 2 |
| 🧱 | Kartonbrücke | baut einen Träger aus Karton | 3 |
| ☕ | Kaffeepause | Zug aussetzen | ∞ |

### Fallschaden

Wer tiefer als ca. 160 px (≈ 8 Arbeiter) fällt, verletzt sich: 1 HP pro 9 px/s Aufprallgeschwindigkeit über der Grenze, höchstens 50 HP. Verletzt sich der aktive Arbeiter während seines Zugs, ist der Zug sofort vorbei. Harte Landungen zeigen Staub, Schwindel-Sternchen und ein „Autsch!“.

### Ton

Alles wird live im Browser synthetisiert (WebAudio), es gibt keine Audiodateien:
Soundeffekte, prozedurale Hintergrundmusik (ruhig im Menü, Lagerfunk im Spiel, Melodien werden immer neu erzeugt) und Lagerhallen-Atmosphäre (Raumhall, Neonröhren, Hafenwasser, Rückfahrwarner, vorbeifahrende Stapler, Durchsagen, Möwen).
🎵 schaltet Musik + Atmosphäre, 🔊 den gesamten Ton. Die Einstellung wird gespeichert.

## Technik

```
index.html, src/client/   three.js-Client (Vite)
  main.js                 Lobby, HUD, Eingaben, Hauptschleife
  game.js                 Zuglogik, Physik, Waffen, Netzwerk-Snapshots
  render.js               Szene: Lagerhalle, Arbeiter-Modelle, Effekte, Kamera
  terrain.js              zerstörbares Gelände (Bitmaske + Canvas-Textur)
  audio.js                Soundeffekte, Musik-Sequencer, Hallen-Atmosphäre (WebAudio, keine Assets)
src/shared/               Code für Client und Server
  terrain-gen.js          deterministischer Level-Generator (Seed)
  weapons.js, constants.js
src/server/
  worker.js               Worker: /api/room/:code/ws -> Durable Object, sonst Static Assets
  room.js                 GameRoom (Durable Object, WebSocket Hibernation API)
```

**Netzwerkmodell:** Der Durable Object ist Schiedsrichter für Lobby, Zugreihenfolge, Zeitlimit, Wind, Munition und Sieg. Den laufenden Zug simuliert der Browser des aktiven Spielers und streamt 20 Snapshots pro Sekunde, die der Raum an alle anderen weiterreicht. Jede Geländeänderung (Explosion, Kartonbrücke) wird als Operation im Raum gespeichert; zusammen mit dem Level-Seed kann so jeder Nachzügler oder Reconnect das Gelände exakt rekonstruieren. Bricht der aktive Spieler weg, beendet ein Alarm des Durable Objects den Zug.

## Lokal entwickeln

Voraussetzung: Node.js 20+.

```bash
npm install
npm run dev          # baut den Client und startet wrangler dev auf http://localhost:8787
```

Mit Hot-Reload für den Client (zwei Terminals):

```bash
npm run dev:worker   # Worker + Durable Object auf :8787
npm run dev:hot      # Vite auf :5173, leitet /api an :8787 weiter
```

Zum Multiplayer-Testen einfach zwei Browserfenster öffnen. `npm run check` prüft Level-Generator und Waffenliste ohne Browser.

## Deployment auf Cloudflare

Einmalig von Hand:

```bash
npx wrangler login
npm run deploy       # vite build && wrangler deploy
```

Das Spiel läuft dann unter `https://wormhouse.<dein-subdomain>.workers.dev`. Durable Objects mit SQLite-Speicher funktionieren auch im kostenlosen Workers-Plan.

Automatisch per GitHub Actions (`.github/workflows/deploy.yml`, bei jedem Push auf `main`): im Repo unter *Settings → Secrets and variables → Actions* zwei Secrets anlegen:

- `CLOUDFLARE_API_TOKEN` – API-Token mit der Vorlage „Edit Cloudflare Workers“
- `CLOUDFLARE_ACCOUNT_ID` – steht im Cloudflare-Dashboard rechts in der Workers-Übersicht

## Ideen für später

Ninja-Seil (Spanngurt), Kisten-Drops mit Bonus-Waffen, Sudden Death (Hafenbecken steigt), Bots für den Übungsmodus, Touch-Steuerung, eigene Teamnamen und Mützen.
