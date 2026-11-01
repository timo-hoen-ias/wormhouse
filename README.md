# 📦 WORMHOUSE – Lagerkoller im Hochregal

Rundenbasiertes Multiplayer-Artillery-Spiel im Stil der Worms-Klassiker: Teams aus **Lagerarbeitern** bekämpfen sich in einer **zerstörbaren Lagerhalle** mit allem, was das Lager hergibt. Gerendert mit **three.js**, gehostet komplett auf **Cloudflare Workers** (Static Assets + Durable Objects für die Spielräume).

## Spielen

**Einzelspieler:** Namen eingeben, **„Einzelspieler“**. Du landest in deiner eigenen Lobby mit einem KI-Team, kannst weitere KI-Teams dazunehmen, Regeln einstellen und loslegen.

**Zusammen an einem Gerät (Hotseat):** In der Lobby kann jeder Gegner-Platz statt einer KI-Stufe auf **„👤 Spieler (lokal)“** gestellt werden (oder per **„+ Spieler“** dazunehmen). Diese Teams steuert ihr abwechselnd mit derselben Tastatur und Maus; nur die 🤖-Teams spielt die KI. Geht auch in Mehrspieler-Räumen – lokale Spieler laufen dann über das Gerät der Schichtleitung.

**Mehrspieler:** **„Mehrspieler-Lobby“** öffnen und den Raumlink (**„Link kopieren“**) an bis zu 5 Kolleg:innen schicken. In der Lobby (wie bei Worms):

- Jede:r wählt **Teamname** und **Teamfarbe**, alle sehen sich gegenseitig.
- **Pausenraum-Chat** vor dem Spiel (im Spiel weiter mit **T**), inkl. Verlauf für Nachzügler.
- Die **Schichtleitung** (wer den Raum erstellt hat) stellt die **Spielregeln** ein, nimmt **KI-Teams** dazu und startet. Insgesamt bis zu 6 Teams.

Das letzte Team mit Personal gewinnt. Allein und ohne KI-Gegner geht es gegen die *Inventur-Dummies* (Zielscheiben).

### Spielregeln (Lobby)

| Regel | Optionen (Standard fett) |
|---|---|
| Zugzeit | 15 / 20 / 30 / **45** / 60 / 90 s |
| Rückzugszeit nach dem Schuss | keine / 2 / **3** / 5 s |
| Arbeiter pro Team | 1 – 6 (**3**) |
| Lebenspunkte | 50 / 75 / **100** / 150 / 200 |
| Wind (Hallenlüftung) | aus / schwach / **normal** / stark |
| Fallschaden | **an** / aus |
| Sudden Death nach | nie / 3 / 5 / 10 / **15** / 20 / 30 min |
| Sudden Death | **alle auf 1 HP + Hafenbecken steigt mit jedem Zug** / nur 1 HP |
| Waffenlager | Munition pro Waffe: ∞ / aus / 1 / 2 / 3 / 5, Vorlagen „Standard“, „Volles Lager“, „Inventur knapp“ |

Die Regeln sind in `src/shared/rules.js` als Optionslisten definiert; Lobby und Server lesen dieselbe Liste. Das Waffenlager wird aus `WEAPONS` erzeugt, neue Waffen erscheinen dort automatisch.

### Spielmodus „Rope only“ (Seil-Match)

Oben in den Spielregeln per Knopf wählbar (Einzelspieler und Mehrspieler), wie die Rope-Matches in Worms online:

- Im Lager nur **Spanngurt-Seil (∞)** und **Hubwagen-Rempler** (unser Baseballschläger), dazu Kaffeepause.
- 20 s Zugzeit, kein Fallschaden, kein Wind, Sudden Death nach 10 min mit steigendem Wasser.
- Gespielt wird auf einer Seil-Karte (Kranbahn, Hängeregale oder Zufall (Seil)).
- Schaden entsteht fast nur durchs Versenken: hinschwingen, loslassen und den Gegner im Flug rempeln, oder landen und mit dem Hubwagen ins Becken schieben.

Danach lassen sich einzelne Regeln weiter anpassen; „Standard“ setzt alles zurück. Die KI schwingt im Rope-only-Modus und auf Seil-Karten selbst am Seil: Sie simuliert Haken, Schwung und Loslass-Zeitpunkt mit derselben Seilphysik, sucht Rempler ins Wasser oder einen Landeplatz direkt neben dem Gegner und haut dann mit dem Hubwagen zu.

### KI-Gegner

| Stufe | Verhalten |
|---|---|
| 🤖 Dummy | steht nur rum (Zielscheibe, setzt aus) |
| 🤖 Azubi | Paketkanone und Granate, zielt grob, ignoriert den Wind |
| 🤖 Fachkraft | rechnet mit Wind, nutzt auch Kleinteile-Kiste, Scanner und Hubwagen |
| 🤖 Lagermeister | trifft fast immer, nutzt zusätzlich den Paletten-Abwurf |

Die KI (`src/client/ai.js`) läuft im Browser der Schichtleitung: Sie simuliert Flugbahnen mit derselben Physik wie das Spiel (Wind, springende Granaten, Laser-Sichtlinie, Luftschlag), bewertet Schaden an Gegnern gegen Eigentreffer, läuft notfalls ein Stück näher ran und bedient dann dieselbe Spiellogik wie ein Mensch. Für alle anderen sieht ein KI-Zug aus wie ein normaler Zug. Verlässt die Schichtleitung das Spiel, übernimmt der nächste Host die KI-Teams.

### Steuerung

| Taste | Aktion |
|---|---|
| ← → / A D | laufen (am Seil: schwingen, mit Rucksack: seitlich) |
| ↑ ↓ / W S | zielen (Kartonbrücke: drehen, am Seil: ein-/ausfahren, Rucksack: ↑ = Schub, Drohne: lenken) |
| Leertaste halten / loslassen | Kraft aufladen / werfen (Stapler/Drohne: zünden, Seil: Haken schießen/loslassen) |
| Enter | Sprung nach vorn |
| ⌫ Backspace | Rückwärtssalto |
| 1 – 9, 0 | Waffenfach wählen, mehrfach drücken schaltet durch das Fach (oder unten anklicken) |
| Mausklick | Ziel für Paletten-Abwurf, Panzerschrank, Sendungsverfolgung, Inventurfehler, Kartonbrücke |
| Mausrad / Ziehen | Zoom / Kamera verschieben, **C** = Kamera zurück |
| T | Chat |

### Das Arsenal

| Fach | | Waffe | Funktion | Munition |
|---|---|---|---|---|
| 1 | 📦 | Paketkanone | Bazooka, windanfällig, explodiert beim Aufprall | ∞ |
| 1 | 📡 | Sendungsverfolgung | Zielsuchrakete: Ziel anklicken, dann abfeuern | 2 |
| 2 | 🌀 | Stretchfolien-Granate | springt, 3 s Zünder | ∞ |
| 2 | 🔩 | Kleinteile-Kiste | Splittergranate mit 5 Schrauben | 2 |
| 3 | 🎁 | Retouren-Lawine | „Bananenbombe“: platzt in 5 Pakete, die beim Aufprall explodieren | 1 |
| 3 | ☢️ | Gefahrgut-Fass | riesige Explosion mit Halleluja | 1 |
| 4 | 🔫 | Barcode-Scanner | 2 Laser-Scans, schnurgerade | ∞ |
| 4 | 📎 | Elektrotacker | Dauerfeuer, 12 Klammern, nachzielen mit ↑/↓ | 2 |
| 5 | 🛒 | Hubwagen-Rempler | Nahkampf, schubst weit weg | ∞ |
| 5 | 🔨 | Stempel-Uppercut | Sprung-Schlag, schleudert Gegner nach oben | 2 |
| 6 | 🚜 | Amok-Stapler | fährt selbstständig, Leertaste zündet | 1 |
| 6 | 🛸 | Inventur-Drohne | ferngelenkt (←/→), Leertaste zündet, 8 s Akku | 1 |
| 6 | 🧯 | Propangasflasche | abstellen, wegrennen, 5 s | 1 |
| 7 | 🪵 | Paletten-Abwurf | Luftschlag mit 5 Europaletten | 1 |
| 7 | 🗄️ | Panzerschrank | fällt senkrecht und schlägt sich mit 6 Explosionen durch alles | 1 |
| 8 | ⛏️ | Bohrhammer | bohrt 3,5 s in Zielrichtung (auch senkrecht) | 2 |
| 8 | 🧱 | Kartonbrücke | baut einen Träger aus Karton | 3 |
| 9 | 🧗 | Spanngurt-Seil | Ninja-Seil (siehe unten) | ∞ |
| 9 | 🎒 | Druckluft-Rucksack | Jetpack, 6 s Druckluft | 2 |
| 9 | 🪂 | Planen-Fallschirm | öffnet im Fall, kein Fallschaden, treibt im Wind | 3 |
| 9 | ➰ | Gummi-Expander | Bungee: von der Kante springen und federn | 2 |
| 9 | 📋 | Inventurfehler | Teleport | 2 |
| 0 | ☕ | Kaffeepause | Zug aussetzen | ∞ |

**Hilfsmittel** (Seil, Rucksack, Fallschirm, Expander) beenden den Zug nicht: Danach darf noch geschossen werden – auch direkt vom Seil oder aus der Luft (Waffe wählen, Leertaste).

**Spanngurt-Seil** (verhält sich wie das Ninja-Seil aus Worms Armageddon, Physik in `src/shared/rope.js`, Selbsttest `scripts/rope-check.mjs`):
- Mit ↑/↓ zielen, Leertaste schießt den Haken blitzschnell in Zielrichtung (Gurt max. 470 px). Verfehlt er, rollt er sich wieder ein.
- Am Gurt ist man ein Pendel mit fester Länge: ←/→ geben Schwung, ↑ holt ein, ↓ fährt aus. Einholen erhält den Drehimpuls – wer im richtigen Moment einholt, wird schneller.
- Der Gurt wickelt sich um Kanten und wickelt sich beim Zurückschwingen wieder ab. Wird das Gelände am Haken weggesprengt, reißt er aus; weggesprengte Kanten geben den Gurt frei.
- Leertaste lässt los, der Schwung bleibt erhalten. In der Luft (mit ↑/↓ neu zielen, ←/→ Blickrichtung) kann man erneut schießen – bis zu 5× Einhaken pro Zug, danach erst wieder landen.
- Am Gurt gibt es keinen Fallschaden, nach dem Loslassen gilt die normale Sicherheitshöhe (~160 px).
- Vom Seil aus kann man Waffe wählen und Abwurfwaffen einsetzen (Granaten fallen mit dem eigenen Schwung, Gasflasche, Amok-Stapler) oder Zielwaffen anklicken. Danach läuft die Rückzugszeit, man hängt weiter und lässt mit Leertaste los.
- Am Seil hängend schubst man niemanden. Erst wer **loslässt** und im freien Flug in andere Arbeiter kracht, rempelt sie weg (ohne Schaden, aber gern ins Hafenbecken) – wie in Worms.

### Fallschaden

Wer tiefer als ca. 160 px (≈ 8 Arbeiter) fällt, verletzt sich: 1 HP pro 9 px/s Aufprallgeschwindigkeit über der Grenze, höchstens 50 HP. Verletzt sich der aktive Arbeiter während seines Zugs, ist der Zug sofort vorbei. Harte Landungen zeigen Staub, Schwindel-Sternchen und ein „Autsch!“.

### Ton

Alles wird live im Browser synthetisiert (WebAudio), es gibt keine Audiodateien:
Soundeffekte, prozedurale Hintergrundmusik (ruhig im Menü, Lagerfunk im Spiel, Melodien werden immer neu erzeugt) und Lagerhallen-Atmosphäre (Raumhall, Neonröhren, Hafenwasser, Rückfahrwarner, vorbeifahrende Stapler, Durchsagen, Möwen).
🎵 schaltet Musik + Atmosphäre, 🔊 den gesamten Ton. Die Einstellung wird gespeichert.

### Am Handy spielen

Auf Handys und Tablets (Touch, erkannt über `pointer: coarse`, erzwingbar mit `?touch=1` / `?touch=0`) erscheint eine eigene Steuerung (`src/client/touch.js`). Sie speist dieselben Tastencodes ins Spiel wie die Tastatur.

- **Querformat**: Beim Spielstart wechselt das Handy (Android/Chrome) ins Vollbild und sperrt die Drehung im Querformat (`screen.orientation.lock`); als installierte App reicht das Manifest. iOS kann das nicht sperren – dort erscheint im Hochformat „Bitte das Handy quer halten“. Das HUD wird auf niedrigen Bildschirmen kompakter, Notch/Home-Balken werden freigehalten.
- **Steuerkreuz links**: ◀ ▶ laufen (am Seil schwingen), ▲ ▼ zielen (am Seil einholen/ausfahren, Drohne lenken).
- **Rechts**: 🔥 halten = Kraft, loslassen = Wurf (auch Seil schießen/loslassen), ⤴ Sprung, ↶ Rückwärtssalto.
- **Unten**: **Waffen** öffnet das Waffenlager als Menü, 🎥 holt die Kamera zum Arbeiter, 💬 Chat.
- **Zielwaffen** (Panzerschrank, Paletten, Inventurfehler, Kartonbrücke …): Ziel im Lager antippen, dann 🎯 drücken. So löst Kamera-Verschieben nichts aus.
- **Kamera**: ein Finger ziehen, zwei Finger zoomen.
- **App/Vollbild & offline**: Wormhouse ist eine installierbare PWA (`public/manifest.webmanifest`, `src/client/pwa.js`). Ein Service Worker (beim Build aus `scripts/sw-template.js` erzeugt, siehe `vite.config.js`) cacht beim ersten Besuch das komplette Spiel. **Einzelspieler und Hotseat laufen danach komplett offline**: Die Raum-Logik (`src/shared/room-logic.js`) läuft dafür direkt im Browser (`src/client/localroom.js`) statt im Durable Object. Mehrspieler braucht Netz; offline sind die Knöpfe gesperrt, und eine abgerissene Verbindung verbindet sich sofort neu, wenn das Netz zurück ist. Installieren: Chrome/Edge/Android zeigen im Menü „📲 Als App installieren“, iPhone/iPad: Teilen → „Zum Home-Bildschirm“.
- **Kein iOS-Zoom**: `touch-action: manipulation` auf allen Elementen, `maximum-scale=1` (verhindert auch das Reinzoomen beim Tippen in Eingabefelder), Safari-`gesture*`-Events und ein Doppeltipp-Fänger in `pwa.js`. Das Spiel-Zoom (zwei Finger auf der Halle) läuft über Pointer-Events und bleibt.
- **Grafik**: Auf Touch-Geräten niedrigere Pixeldichte, keine Kantenglättung, einfachere Schatten (`?gfx=high` / `?gfx=low` erzwingt). Explosionen laden nur das geänderte Stück der Geländetextur hoch.
- **Handy gesperrt / App gewechselt**: Die Verbindung wird bewusst getrennt. Der Server gibt den Zug weiter und übergibt die Schichtleitung (und damit die KI-Teams) an einen anderen verbundenen Spieler. Beim Zurückkehren verbindet sich das Spiel neu.

## Technik

```
index.html, src/client/   three.js-Client (Vite)
  main.js                 Lobby (Teams, Regeln, Chat), HUD, Eingaben, Hauptschleife
  ai.js                   KI-Gegner: Zugplanung + Steuerung
  game.js                 Zuglogik, Physik, Waffen, Netzwerk-Snapshots
  render.js               Szene: Lagerhalle, Arbeiter-Modelle, Effekte, Kamera
  terrain.js              zerstörbares Gelände (Bitmaske + Canvas-Textur)
  audio.js                Soundeffekte, Musik-Sequencer, Hallen-Atmosphäre (WebAudio, keine Assets)
src/shared/               Code für Client und Server
  terrain-gen.js          deterministischer Level-Generator (Seed)
  weapons.js, constants.js
  rules.js                Spielregeln, Munitions-Vorlagen, KI-Stufen
src/server/
  worker.js               Worker: /api/room/:code/ws -> Durable Object, sonst Static Assets
  room.js                 GameRoom (Durable Object, WebSocket Hibernation API)
```

**Netzwerkmodell:** Der Durable Object ist Schiedsrichter für Lobby, Regeln, Zugreihenfolge, Zeitlimit, Wind, Munition und Sieg. Den laufenden Zug simuliert der Browser des aktiven Spielers und streamt 20 Snapshots pro Sekunde, die der Raum an alle anderen weiterreicht. Jede Geländeänderung (Explosion, Kartonbrücke) wird als Operation im Raum gespeichert; zusammen mit dem Level-Seed kann so jeder Nachzügler oder Reconnect das Gelände exakt rekonstruieren. Bricht der aktive Spieler weg, beendet ein Alarm des Durable Objects den Zug.

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

Kisten-Drops mit Bonus-Waffen, Touch-Steuerung, eigene Mützen, KI für Stapler/Gasflasche/Seil.
