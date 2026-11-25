# Varroa-Kalibrierung - Einrichtung und Bedienung

Die App sammelt geprüfte Windelfotos und misst, ob die automatische Milbenzählung mit mehr Daten besser wird. Sie läuft als PWA (Web-App, die man wie eine App auf dem Handy installieren kann) auf GitHub Pages. Die Daten liegen in einer gemeinsamen Supabase-Datenbank.

Ausprobieren geht auch ohne Server: Beim ersten Öffnen „Nur auf diesem Gerät“ wählen.

---

## 1. Supabase-Projekt anlegen (ca. 10 Minuten, einmalig)

1. Auf https://supabase.com ein kostenloses Konto anlegen und **New project** wählen.
   - Region: **Central EU (Frankfurt)**, damit die Daten in der EU liegen.
   - Das Datenbank-Passwort brauchst du für die App nicht, aber gut aufheben.
2. **Anonyme Anmeldung einschalten:** Authentication → Sign In / Providers → „Allow anonymous sign-ins“ aktivieren und speichern.
   (Mitwirkende brauchen damit kein Konto und keine E-Mail-Adresse. Zugang gibt es nur mit dem Einladungscode.)
3. **Datenbank einrichten:** SQL Editor → New query → den Inhalt von `supabase/setup.sql` einfügen.
   - In den Zeilen mit `HIER-EINLADUNGSCODE` und `HIER-ADMINCODE` zwei eigene Codes eintragen (z. B. `windel-2026` und einen langen, geheimen Admin-Code).
   - **Run** drücken. Es sollte „Success“ erscheinen.
4. **Verbindungsdaten kopieren:** Project Settings → API (bzw. „Data API“ / „API Keys“):
   - Project URL (z. B. `https://abcdefgh.supabase.co`)
   - `anon` `public` Key

Codes später ändern: im SQL Editor
`update public.app_config set invite_code = 'neu', admin_code = 'neu-geheim';`

## 2. App auf GitHub Pages veröffentlichen

1. In `config.js` die Project URL und den anon Key eintragen. Der anon Key darf öffentlich sein, die Daten schützt der Einladungscode.
2. Auf GitHub ein neues Repository anlegen (z. B. `varroa-kalibrierung`, öffentlich).
3. „uploading an existing file“ → den **Inhalt** dieses Ordners hineinziehen (index.html muss ganz oben liegen, die Unterordner `js`, `css`, `icons`, `seed`, `supabase` mit hochladen) → Commit.
4. Settings → Pages → Source: „Deploy from a branch“, Branch `main`, Ordner `/ (root)` → Save.
5. Nach 1-2 Minuten läuft die App unter `https://<dein-github-name>.github.io/varroa-kalibrierung/`.
6. Am Handy öffnen und über das Browser-Menü „Zum Startbildschirm hinzufügen“ bzw. „App installieren“ wählen.

## 3. Erster Start

1. App öffnen, mit dem **Admin-Code** und deinem Kürzel beitreten. Damit bist du Admin.
2. Die Startversion des Zählmodells (v1) wird automatisch angelegt.
3. Die 10 vorhandenen Fotos hochladen (die Fotos **ohne** „_mit_Zählung“):
   - IMG_5096 bis IMG_5101 und IMG_5215, IMG_5221, IMG_5223, IMG_5225.
   - Die App erkennt diese Fotos und übernimmt Windel-Ecken, Windelbreite (445 mm) und bei den vier Schrauben-Fotos die Schrauben-Markierungen als Vorschläge.
   - IMG_5097, IMG_5100 und IMG_5101 sind als **Testbilder** festgelegt, die übrigen sind Trainingsbilder.
4. **Zuerst die Testbilder prüfen.** Erst dann zeigt die Statistik etwas.
5. Andere einladen: Link zur App und den Einladungscode schicken.

## 4. So läuft eine Prüfung

1. **Kacheln:** Die App zeigt Ausschnitte (5 × 5 mm) um verdächtige Flecken, die wahrscheinlichsten zuerst. Antippen = Milbe. Lang drücken oder ⓘ = größerer Ausschnitt, „unsicher“ und optional der Verwechsler (Pollen, Wachs, Propolis, Bienenteil, Sonstiges), nur wenn er eindeutig ist. Alles nicht Markierte gilt als „keine Milbe“.
   Wenn 40 Kacheln hintereinander keine Milbe enthalten, schlägt die App vor, zum Nachtragen weiterzugehen.
2. **Nachtragen:** Die ganze Windel mit zwei Fingern absuchen und übersehene Milben antippen.
3. **Abschluss:** Mitglieder schließen ab, eine **zweite Person** bestätigt. Beim Admin zählt die eigene Prüfung direkt.
   Erst bestätigte Bilder zählen für Statistik und Training.

Nach jedem bestätigten **Trainingsbild** rechnet die App automatisch eine neue Modellversion. **Testbilder** werden nie zum Lernen verwendet, nur zum Messen.

## 5. Gute Fotos

- ganze Windel im Bild, senkrecht von oben
- gleichmäßiges Licht, keine harten Schatten
- höchste Kamera-Auflösung, Format JPEG (am iPhone: Einstellungen → Kamera → Formate → „Maximale Kompatibilität“)
- **Maßstab:** Die App rechnet mit Millimetern und braucht deshalb einen Maßstab. Dafür trägst du die Windelbreite in Rähmchenrichtung ein (bei euch 445 mm; die App merkt sich den Wert) und wählst, ob diese Breite im Foto von oben nach unten oder von links nach rechts verläuft. Dann ziehst du die vier Ecken auf die Windelecken.
- **Länge:** Sie ist optional. Ist die Windel seitlich abgeschnitten, setzt du die Punkte dort an den Bildrand. Die beiden Kanten in Breitenrichtung (gestrichelt markiert) müssen aber ganz im Bild sein.

## 6. Gut zu wissen

- **Kostenloser Supabase-Plan (Stand November 2026):** 500 MB Datenbank, 1 GB Dateispeicher (reicht für einige hundert Fotos à ca. 3 MB), 5 GB Datenverkehr pro Monat (jede Prüfung lädt das Foto einmal). Projekte ohne Aktivität werden nach einer Woche pausiert; im Supabase-Dashboard lässt sich das Projekt mit einem Klick wieder starten.
- **Export:** Mehr → „Export (JSON)“ speichert alle Angaben, Kandidaten und Prüfergebnisse. Damit lässt sich später ein größeres Erkennungsmodell trainieren.
- **Rollen:** Nur Admins dürfen Test/Training tauschen, Prüfungen zurücksetzen, bestätigte Bilder ändern und Bilder löschen. Das prüft die Datenbank selbst, nicht nur die App.
- **Datenschutz:** Es werden nur Kürzel gespeichert, keine Namen oder E-Mail-Adressen. Die Fotos liegen in einem privaten Speicher, den nur Mitglieder lesen können.

## Aufbau (für später)

| Datei | Zweck |
|---|---|
| `js/detect.js` | Kandidatensuche (dunkle, kompakte Flecken in Milbengröße) und 15 Merkmale je Fleck |
| `js/model.js` | Klassifikator (logistische Regression), Abgleich mit den Prüfungen, Kennzahlen |
| `js/review.js` | Prüfablauf: Kacheln, Nachtragen, Abschluss |
| `js/stats.js` | Statistikseite |
| `js/store-supabase.js`, `js/store-local.js` | Speicher gemeinsam bzw. nur auf dem Gerät |
| `seed/` | Startdaten für die 10 vorhandenen Fotos und Startmodell v1 |
| `supabase/setup.sql` | Datenbank, Zugriffsregeln, Regeln für die Zweitprüfung |
