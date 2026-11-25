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
2. Die **Startregel v0** wird automatisch angelegt (kein Training, nur „dunkel, oval, milbengroß“).
3. **Die ersten Runs: die vier Schrauben-Fotos** IMG_5215, IMG_5221, IMG_5223, IMG_5225 (jeweils die Fotos **ohne** „_mit_Zählung“), **eines nach dem anderen**: hochladen, prüfen, abschließen, dann das nächste. Die Schrauben-Punkte sind als Milbe vorbelegt; stimmt ein Vorschlag nicht, antippen.
4. Danach IMG_5096 bis IMG_5101 und neue Fotos, ebenfalls nacheinander.
5. Andere einladen: Link zur App und den Einladungscode schicken.

## 4. So läuft ein Run

1. **Hochladen:** Die App schätzt sofort mit dem aktuellen Modell, wie viele Milben auf der Windel liegen.
2. **Ausschnitte prüfen:** Die App zeigt große Ausschnitte (7 × 7 mm) mit einem Kreis in Milbengröße, sortiert nach ihrer **Konfidenz** (wie sicher sie ist, dass dort eine Milbe liegt). Unter jedem Ausschnitt: **✓ Milbe**, **✗ Keine** oder **Offen** (wenn du unsicher bist). Liegt die Milbe nicht genau im Kreis, tipp im Bild auf die Milbe, dann wandert der Kreis dorthin. Über **▾** kannst du optional angeben, was es sonst ist (Pollen, Wachs, Propolis, Bienenteil, Sonstiges).
   - **Abfragegrenze:** Abgefragt wird alles oberhalb einer Konfidenz, unter der bisher höchstens 5 % der bestätigten Milben lagen. Am Anfang fragt die App deshalb viel, mit besserem Modell immer weniger.
   - **Stichprobe:** Am Ende kommen 20 zufällige Kacheln unterhalb der Grenze. Sie zeigen, ob dort noch Milben versteckt sind.
3. **Nachtragen (optional):** Milben antippen, die nicht abgefragt wurden.
4. **Abschluss:** Optional „Ich habe alle Milben markiert“ ankreuzen (nur dann wird der Zählfehler berechnet) und abschließen.

Danach lernt das Modell aus dem Run und schätzt das nächste Foto mit der neuen Version. Jedes Bild ist also **zuerst Test, dann Training**. Die Statistik vergleicht jede Schätzung mit dem, was beim Prüfen sicher markiert wurde.

## 5. Gute Fotos (ab jetzt: Teilaufnahmen)

- Kamera auf **4:3**, höchste Auflösung, JPEG, kein Digitalzoom
- ein **Maßband** flach auf die Windel legen, sodass es an einer Fotokante sichtbar ist
- Bildausschnitt etwa **15 cm breit**, senkrecht von oben, gleichmäßiges Licht ohne harte Schatten
- beim Hochladen „Maßstab über **Fotobreite**“ wählen, die abgelesene Kante (kurz oder lang) und ihre Länge in mm eintragen
- die App rechnet daraus die Auflösung in px/mm. Unter der **Mindestauflösung von 15 px/mm** (einstellbar in `config.js`) warnt sie und lädt nur nach ausdrücklichem „trotzdem“ hoch.
- weitere Möglichkeiten: zwei Marken am Maßband antippen oder (bei ganzer Windel) über die Windelbreite von 445 mm

## 6. Gut zu wissen

- **Kostenloser Supabase-Plan (Stand November 2026):** 500 MB Datenbank, 1 GB Dateispeicher (reicht für einige hundert Fotos à ca. 3 MB), 5 GB Datenverkehr pro Monat (jede Prüfung lädt das Foto einmal). Projekte ohne Aktivität werden nach einer Woche pausiert; im Supabase-Dashboard lässt sich das Projekt mit einem Klick wieder starten.
- **Export:** Mehr → „Export (JSON)“ speichert alle Angaben, Kandidaten und Prüfergebnisse. Damit lässt sich später ein größeres Erkennungsmodell trainieren.
- **Rollen:** Geprüfte Bilder kann nur die prüfende Person oder ein Admin ändern. Nur Admins dürfen Prüfungen zurücksetzen und Bilder löschen. Das prüft die Datenbank selbst, nicht nur die App.
- **Datenschutz:** Es werden nur Kürzel gespeichert, keine Namen oder E-Mail-Adressen. Die Fotos liegen in einem privaten Speicher, den nur Mitglieder lesen können.

## Aufbau (für später)

| Datei | Zweck |
|---|---|
| `js/detect.js` | Kandidatensuche (dunkle, kompakte Flecken in Milbengröße) und 15 Merkmale je Fleck |
| `js/model.js` | Klassifikator (logistische Regression), Abgleich mit den Prüfungen, Kennzahlen |
| `js/review.js` | Prüfablauf: Kacheln, Nachtragen, Abschluss |
| `js/stats.js` | Statistikseite |
| `js/store-supabase.js`, `js/store-local.js` | Speicher gemeinsam bzw. nur auf dem Gerät |
| `seed/` | Startdaten für die 10 vorhandenen Fotos und Startregel v0 |
| `supabase/setup.sql` | Datenbank und Zugriffsregeln |
