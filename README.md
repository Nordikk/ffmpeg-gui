# FFmpeg Forge

Erster Prototyp fuer eine moderne All-in-one GUI rund um FFmpeg, jetzt mit Electron-Desktop-Huelle fuer Windows.

## Entwicklung

- `npm install`
- `npm run dev` fuer die Browser-Ansicht
- `npm run start:desktop` fuer die Desktop-App lokal

## EXE bauen

- `npm run build:desktop`
- Das fertige portable EXE liegt danach in `release/`

## Zielbild

Die App soll typische Media-Workflows unter einer Oberflaeche vereinen:

- Video-, Audio- und Bild-Konvertierung
- Lossless-Cut per `-c copy`, wenn technisch moeglich
- Stapelverarbeitung mit Presets und Queue
- FFprobe-Analyse fuer Streams, Metadaten und Keyframes
- Transparente FFmpeg-Command-Vorschau statt Black Box

## Naechste sinnvolle Schritte

1. FFmpeg/ffprobe-Binaries einbinden
2. Dateiauswahl und Job-Erstellung an Electron anbinden
3. Timeline-Editor fuer In/Out und Keyframe-Snapping bauen
4. Queue-State persistent machen
