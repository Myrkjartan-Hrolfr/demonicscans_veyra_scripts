# Funktionsliste – Veyra Automatisierung

Grundlage: `arbeitsauftrag.txt`, die bestehenden Skripte und die Beispielseiten in `veyra_seiten.txt`.
Status-Legende: **[vorh.]** existiert schon weitgehend · **[anp.]** existiert, muss angepasst werden · **[neu]** neu zu bauen · **[?]** offene Frage

Aktueller Stand: Alle beauftragten Punkte sind umgesetzt. Nur die ausdrücklich ausgeschlossenen bzw. zurückgestellten Punkte 4.2, 5.4, 7.15 und 7.16 bleiben unverändert.

---

## 0. Übergreifend

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 0.1 | Alle Skripte laufen auf Desktop und Mobilgerät | [vorh.] | Mobile-CSS, Touch-Bedienung und bfcache-Handling sind vorhanden. Der Scheduler pausiert nicht absichtlich bei `document.hidden`; durch den Browser verzögerte Aktionen werden beim Fortsetzen nachgeholt. |
| 0.2 | Alle Skripte inkl. UI-Texte auf Englisch | [vorh.] | Die UI des gebündelten Userscripts und der übernommenen Module ist Englisch. Die ausdrücklich eigenständig bleibenden Tower-Skripte gehören nicht zum Bundle. |
| 0.3 | Gemeinsame Hilfsfunktionen: Zahlen parsen (`3M`, `3b`), Potions, Join, Attack, Retry/Rate-Limit | [vorh.] | Zahlen, Potions, HTTP-Retry/Backoff und gemeinsame Angriffs-/Loot-Helfer liegen in `src/core` bzw. `src/features/shared`; seitenspezifische Schemas bleiben in kleinen Parsern gekapselt. |
| 0.4 | Kommunikation Hauptskript ↔ Seitenskripte über das bestehende localStorage-Protokoll (command/status/heartbeat) | [vorh.] | `veyra:orchestrator:*` und `veyra:worker:<route>:status:v1` |
| 0.5 | Kein Seitenskript hängt von Fremd-Frameworks ab | [vorh.] | Das Bundle ist eigenständig. Die benötigte Shadowbridge-Logik wurde ohne `Storage`, `internalFetch` oder andere Teile des alten externen „UI Improvements“-Skripts neu umgesetzt. |
| 0.6 | Tests mit `node --test tests/*.test.js` für alle neuen Module | [vorh.] | Unter Node 26 wird das Verzeichnis nicht direkt aufgelöst; deshalb den Glob verwenden. |

## 1. Hauptskript (Basis: `veyra_meta_scheduler.js`)

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 1.1 | Start/Stop des gesamten Ablaufs | [vorh.] | |
| 1.2 | Menü mit einer Liste aller aufrufbaren Seiten | [vorh.] | Die bestehende Seitenleiste mit Unteransicht bleibt (F12). |
| 1.3 | Pro Seite: Name, Countdown bis zum nächsten Aufruf, Toggle zum Aktivieren/Deaktivieren, Button für das Untermenü | [vorh.] | Für PvP, Wave 3, Olympus, Adventurer's Guild, Shadowbridge und Crucible vorhanden. |
| 1.4 | Countdown abgelaufen → zur Seite navigieren und Seitenskript starten | [vorh.] | |
| 1.5 | Seitenskript fertig → zur Hauptseite zurück und Countdown neu starten | [vorh.] | |
| 1.6 | Untermenü-Standardfeld: Looplänge in Minuten | [vorh.] | Jede Route hat ein eigenes editierbares Minutenfeld (1–1440); eine Verkürzung zieht einen laufenden Countdown sofort vor. |
| 1.7 | Untermenü-Standardauswahl: Stamina-Tränke und Heiltränke | [vorh.] | Pro Route getrennte Auswahl für 30 Small, 251 Large, 35 Full, 359 Adventurer Stamina und 108 Full HP. |
| 1.8 | Hauptseite wählbar | [vorh.] | |
| 1.9 | Höchstdauer pro Besuch / Timeout, danach geordneter Rückzug | [vorh.] | `maxVisit` und Drain-Logik sind vorhanden. |
| 1.10 | Neue Routen: Olympus-Domänen, Shadowbridge, Crucible (Prince später) | [vorh.] | Prince bleibt wie beauftragt zurückgestellt. Shadowbridge und Crucible sind nach einem Update sicherheitshalber zunächst deaktiviert. |

## 2. Wave-Seiten (Wave 3 + Olympus)

URLs: Wave 3 `active_wave.php?gate=3&wave=8`. Olympus `gate=5`: außen wave=9, Hermes 10, Artemis 11, Poseidon 12, Ares 13, Apollo 14, Athena 15, Hera 16, Zeus 17.

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 2.1 | Menü: Bossliste mit Checkbox „angreifen“ | [vorh.] | Jeder Wave-3- und Olympus-Boss hat einen eigenen Active-Toggle. |
| 2.2 | Menü: Schadensziel pro Boss (Zahl oder `3M`/`3b`) | [vorh.] | `normalizeDamageTarget` |
| 2.3 | Menü: Stamina-Tränke auswählbar | [vorh.] | Nutzt die gemeinsame routenspezifische Trankauswahl. |
| 2.4 | Menü: Angriff/Skill auswählbar (Slash 0, Power −1, Heroic −2, Ultimate −3, Legendary −4, evtl. −5) | [vorh.] | Bis zu drei Skills; alle sechs IDs sind auswählbar und werden immer vom teuersten zum billigsten Angriff priorisiert. Das gilt auch für Monster Auto Battle und Strategic Attack. |
| 2.5 | Alle Olympus-Bosse in einem gemeinsamen Untermenü einstellbar | [vorh.] | Neun Domänen mit je zwei Zielen werden in einem Olympus-Untermenü konfiguriert und in einem Besuch nacheinander abgearbeitet. |
| 2.6 | Skript: Prüfen, welche Bosse aktiv sind | [vorh.] | Erkennung über kanonische Namen/Aliasse und `.auto-summon-card`, nicht über das unzuverlässige `data-boss`. |
| 2.7 | Skript: Eigenen Schaden prüfen (`data-userdmg`) | [vorh.] | |
| 2.8 | Skript: Beitreten, falls noch nicht beigetreten | [vorh.] | POST `user_join_battle.php` mit `monster_id` und `user_id`, mit sicherem Fallback auf die Join-Schaltfläche der Battle-Seite. |
| 2.9 | Skript: Angreifen, bis das Ziel erreicht ist | [vorh.] | Der schedulerfähige Worker steuert das ins Bundle portierte Monster Auto Battle und prüft danach den erreichten Eigenschaden. |
| 2.10 | Skript: Stamina nachfüllen bzw. heilen gemäß Einstellungen | [vorh.] | Monster Auto Battle erhält die pro Route ausgewählten Stamina- und Heiltränke. |

## 3. PvP

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 3.1 | Menü: Modus wählen, „autobattle“ (Auto Play des Spiels) oder „Solo_PvP“ (Skill-Planer) | [vorh.] | Im PvP-Untermenü als „Game Auto Play“ und „Solo PvP skill planner“. |
| 3.2 | Solo-Tokens prüfen | [vorh.] | |
| 3.3 | Gegner suchen und Kampf im gewählten Modus führen | [vorh.] | Schedulerfähiger Worker im Bundle; übernimmt die bewährte Skill-Planer-Logik. |
| 3.4 | Nach dem Kampf zurück in die Lobby, wiederholen solange Tokens da sind, dann zurück zur Hauptseite | [vorh.] | Im Smart-PvP-Worker vorhanden. |

## 4. Guild Dungeons

### 4.1 Shadowbridge Warrens

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 4.1.1 | Monsterliste aus `dungeon_auto_damage_fast.user.js` (nur Namen und Reihenfolge) | [vorh.] | 18 Monster. Die festen `imposed_damage_limit`-Werte entfallen (F20). |
| 4.1.1a | „Max Loot“ liest die Lootgrenze direkt vor dem Angriff von `battle.php` (höchster „DMG req“ unter Possible Loot) | [vorh.] | Für normale Mobs zählt nur die Lootgrenze, die EXP-Grenze ist egal. |
| 4.1.1b | Bossraum: eigene Einstellung mit allen vier Modi: Max Loot, Max EXP, Kill, individueller Schaden | [vorh.] | EXP-Grenze aus „Deal ~N dmg to hit cap“ bzw. `capfraction × maxhp` |
| 4.1.2 | Reihenfolge per Drag & Drop änderbar (auch per Touch) | [vorh.] | Zusätzlich gibt es touchfreundliche Hoch-/Runter-Schaltflächen. |
| 4.1.3 | Active-Toggle pro Monster | [vorh.] | |
| 4.1.4 | Modus pro Monster: Max Loot / Kill / individueller Schaden mit eigenem Feld (kein Max EXP bei normalen Mobs) | [vorh.] | |
| 4.1.5 | Schnelleinstellung „Clean dungeon“: alle Monster aktiv und auf Kill | [vorh.] | |
| 4.1.6 | Skill-Auswahl, Standard Slash | [vorh.] | |
| 4.1.7 | Attack-Cooldown 100–2000 ms, Standard 100 ms | [vorh.] | Bei HTTP 429/503 bremst das Skript automatisch ab und prüft vor jedem Retry erneut Scheduler-Lease und Deadline. |
| 4.1.8 | Skript wie `dungeon_auto_damage_fast`, aber eigenständig | [vorh.] | Keine Abhängigkeit vom externen UI-Improvements-Skript. |
| 4.1.9 | Mehrere Locations (1–4) durchlaufen | [vorh.] | |
| 4.1.10 | Live-Statusfenster während Shadowbridge-Angriffen | [vorh.] | Ein einklappbares, mobil angepasstes Fenster listet alle Ziele des aktuellen Besuchs in Angriffsreihenfolge. Es markiert wartend / aktiv / erledigt / Fehler und zeigt bei Schadenszielen den eigenen Schaden gegen die live gelesene Zielgrenze, im Kill-Modus die verbleibenden Monster-HP sowie jeweils die Angriffsanzahl. |

### 4.2 Castle of the Fallen Prince – vorerst zurückgestellt

### 4.3 The Polyhedral Crucible

**Ziel:** Die Teilnahme am kompletten Dungeon läuft automatisch nach den Voreinstellungen. Das Skript liest den Knotenstatus (`STATE.nodes`: available / in_progress / cleared / locked) und arbeitet jeden aktivierten Knoten seines Typs ab: PvE, PvP oder Army.

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 4.3.1 | Menü mit drei Abschnitten: PvE, PvP, Army | [vorh.] | Englische, mobil bedienbare Einstellungen. |
| 4.3.2 | PvE (Prism Gate, Ash Lane, Crown of Calibration): Monsterliste mit Active-Toggle | [vorh.] | Locations 11, 12, 13. Verdeckte bzw. neue Monsternamen werden live entdeckt und danach einzeln gespeichert. Der Apex ist separat unter 4.3.14 ergänzt. |
| 4.3.3 | PvE-Modi: Max Loot / Max EXP / Kill / individueller Schaden | [vorh.] | |
| 4.3.4 | Max Loot und Max EXP direkt vor dem Angriff auf `battle.php` auslesen | [vorh.] | Loot = höchster „DMG req“ unter Possible Loot. EXP = `ceil(capfraction × maxhp)` bzw. „Deal ~N dmg to hit cap“. Ohne eindeutige eigene Leaderboard-Zeile wird sicher abgebrochen. |
| 4.3.5 | PvP: Aktivieren-Toggle | [vorh.] | |
| 4.3.6 | PvP-Skript, Schritt 1: Den aktiven PvP-Knoten finden (Ring Ward → Duel Heart → Tyrant Conclave) | [vorh.] | `STATE.nodes` mit `type=pvp` und Status `available`/`in_progress`. Lobby: `pvp_style_node.php?source=cube&instance_id&node_id` |
| 4.3.6a | Schritt 2: Wartezeit prüfen | [vorh.] | Wenn man schon gebunden ist, steht das in `div.warn`: „You are currently committed to match #2 for about 01:59:55 more.“ Die Zeit gibt es nur als Text, sie wird per Regex gelesen. Ist man in einem offenen Match, geht es dorthin weiter, sonst wird die Restzeit als Countdown gesetzt. Die Bindung (ca. 2 h) beginnt schon beim Belegen des Platzes. **Wichtig:** Ist der Knoten fertig und der nächste PvP-Knoten geöffnet, fällt die Wartezeit sofort auf 0. Das Skript prüft den Knotenstatus deshalb spätestens alle fünf Minuten (`STATE.nodes`, unabhängig vom langen Bindungs-Countdown). |
| 4.3.6b | Schritt 3: Match mit freiem Platz wählen (bevorzugt das mit den meisten belegten Plätzen) und Platz belegen | [vorh.] | Match-Karten `.grid > .match` mit Badge `OPEN`/`CLEARED` und `.meta` „Match #N / Slots x/5“. Ein freier Platz hat kein `.name`, der eigene trägt `.selfMark` „YOUR SLOT“. Belegen: POST `pvp_style_action.php` mit `source=cube`, `action=pick_slot`, `instance_id`, `node_id`, `match_no`, `slot_index` (1–5); kein CSRF nötig. Das Match startet automatisch, sobald 5/5 Plätze belegt sind (oder ein Officer es früher startet). |
| 4.3.6c | Schritt 4: Kampf abwarten | [vorh.] | Sobald das Team vollständig ist, läuft der Kampf automatisch. Ein globaler Hintergrund-Wächter prüft das Match unabhängig vom normalen Crucible-Loop per GET `pvp_style_state.php` mit `room_status` und `match.ended`. Diese Prüfungen verursachen keinen Seitenwechsel und blockieren Army/PvE nicht; ein regulärer Besuch nach 30 Minuten bleibt nur als Fallback bestehen. |
| 4.3.6d | Schritt 5: Ende erkennen und neu planen | [vorh.] | Bei `match.ended` (Sieg: `winner_side='ally'` bzw. `room_status='cleared'`) setzt der Hintergrund-Wächter Crucible sofort fällig. Auch eine bekannte PvP-Bindungswartezeit sowie volle Lobbys werden direkt per HTTP nachgeprüft; erst ein verfügbarer Slot löst einen Seitenbesuch aus. |
| 4.3.6e | Schritt 6: Siegesbelohnung automatisch einsammeln | [vorh.] | Es gibt keinen Collect-Button. Erst nach `match.ended`, Alliierter-Sieg und bestätigter eigener Teilnahme öffnet der Hintergrund-Wächter die zugehörige `pvp_style_battle.php?source=cube&instance_id&node_id&match_no` als unsichtbares Same-Origin-Dokument. Ein bloßer `fetch()` reicht nicht, weil er das Seiten-JavaScript (`tick()` → `pvp_style_state.php`) nicht ausführt. `PVP_REWARD_ITEMS` ist bereits vor dem Kampf gefüllt und beweist keine Vergabe; Erfolg gilt erst bei passenden `SOURCE_PARAMS`, `ROOM_STATUS='cleared'` und sichtbar geschaltetem `#rewardsModal` im versteckten Dokument. Der Haupttab wechselt dabei nicht die Seite; bei einem normalen Crucible-Besuch dient derselbe Ablauf als Fallback. |
| 4.3.7 | Army: Aktivieren-Toggle und Schadensmodus (minimal / töten) | [vorh.] | Zeile 69 im Arbeitsauftrag sagt „PvE“, gemeint ist anhand des Kontexts Army. |
| 4.3.8 | Army: Auflistung und Auswahl der verfügbaren eigenen Shadows | [vorh.] | Eigene Special Shadows werden anhand von `specialUnits`/`shadow_id` sowie `window.FormationData` entdeckt. Vor dem Kampf prüft der Worker `shadow_army_formation.php`; fehlt ein ausgewählter Captain und ist ein Platz frei, wird er per `set_captain` gespeichert und die Formation anschließend erneut verifiziert. Bestehende Captains und zugewiesene normale Shadows werden nicht gelöscht. Im Live-Kampf bleiben nur ausgewählte Captains aktiv; nicht ausgewählte werden vor der Zielzuweisung zurückgezogen. Neu entdeckte Shadows bleiben zunächst abgewählt. |
| 4.3.9 | Army-Skript, Schritt 1: Knotenseite `guild_dungeon_cube_army_enter.php?instance_id&node_id` | [vorh.] | Fight-Karten `.fight[data-match-no]` mit Status open / active / failed / cleared. API: POST `guild_dungeon_cube_army_action.php` mit `action=enter_fight`, `instance_id`, `node_id`, `match_no` → gleich-origin-validierter `redirect`. |
| 4.3.10 | Army-Skript, Schritt 2: Live-Kampf `shadow_army_live_battle.php` | [vorh.] | Bei `state.viewer.can_join=true` wird die vorher verifizierte gespeicherte Formation per `action=join_battle`, leerem `csrf`-Feld und `battle_id` eingesetzt. Wie die originale Spieloberfläche hat `can_join` Vorrang, weil reale States gleichzeitig `has_roster=false` und `can_join=true` liefern. Nur wenn kein Join erlaubt ist und der Roster fehlt, wird einmal per `get_state` aktualisiert. Auch `assign_target` und `retreat_captain` senden das erwartete leere `csrf`-Feld. |
| 4.3.11 | Army-Skript, Schritt 3: Ziele aktiv zuweisen | [vorh.] | **Minimal:** Erst ein über `turns_acted` plus Ziel-HP verifizierter eigener Treffer, dann Retreat; der Beitrag wird pro `battleId` gespeichert und nicht wiederholt. **Kill:** Alle verfügbaren eigenen Captains werden zugewiesen, bis der Kampf endet oder die Formation fällt. |
| 4.3.12 | Army-Skript, Schritt 4: Fertig, wenn `battle.status` nicht mehr `ACTIVE` ist; dann den nächsten offenen Fight bzw. den nächsten Knoten wählen | [vorh.] | |
| 4.3.13 | Army heilen: Vor dem Beitreten, wenn die Armee tot oder verwundet ist | [vorh.] | `heal_all_units` wird nur bei aktivem Button gesendet und danach durch erneutes Lesen der Seite bestätigt. Fehlt der Heal-Button bei gleichzeitig erfolgreich gelesenen eigenen Shadows, gilt korrekt: aktuell nichts heilbar. |
| 4.3.14 | Apex-Boss „Zenith Lock“ (`type=boss`, Location 14) | [vorh.] | Eigener Apex-Einstellungsblock mit Active-Toggle und Max Loot / Max EXP / Kill / individuellem Schaden. Der Live-Bossname wird beim Öffnen entdeckt; der Eintritt erfolgt über `enter_node` und einen gleich-origin-validierten Location-14-Redirect. |

---

## 5. Eingebundene Hilfsskripte (als Module im gebündelten Skript)

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 5.1 | Dead Monster Looter (Sortierung, Loot, Extract, Loot to Level Up) | [vorh.] | Als gedrosseltes gemeinsames Wave-Loot-Modul portiert; respektiert die Quest-Loot-Sperre. |
| 5.2 | Bulk Buy in Damon's Shop | [vorh.] | Als eigenständiges Shop-Feature mit Batches bis 99 und Sicherheitsbestätigung portiert. |
| 5.3 | Auto Battle Extras (Castle-Event) | [vorh.] | Die vollständige modulare Implementierung aus `Auto Battle Extras.user.js` wird beim Build als isoliertes `occurrence_castle.php`-Feature eingebettet. |
| 5.4 | Tower-Skripte | – | bleiben eigenständig |

## 6. Adventurer's Guild Quests

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 6.1 | Eigene Route mit Countdown, Toggle und Untermenü wie die anderen Seiten | [vorh.] | Route `adventurers` auf `adventurers_guild.php`; wegen der mutierenden Aktionen bei bestehenden Konfigurationen zunächst deaktiviert. |
| 6.2 | Phase 1, vorfarmen: Auto Farm auf Olymp außen (`active_wave.php?gate=5&wave=9`) so einstellen, dass von jedem Quest-Monster mindestens 10 getötet werden, jeweils mit mindestens 5m eigenem Schaden | [vorh.] | Anforderungen werden live aus `.quest-req-text` gelesen und bei gleichen Monstern addiert. Auto Farm wird über `add_target`, `update_target`, `save_settings` und `toggle` konfiguriert; die vorige Konfiguration wird gesichert und nach dem Lauf wiederhergestellt. |
| 6.3 | Phase 2, Quests abarbeiten: Quest annehmen, 10 passende tote Monster looten, Quest abschließen, nächste Quest | [vorh.] | Prüft `data-eligible`, Eigenschaden und `data-expire`, lootet sequenziell über `loot.php` und bestätigt den Fortschritt nach jedem Loot vor dem Finish. |
| 6.3a | Bis zum Abschluss aller Quests dürfen andere Module (z. B. der Dead Monster Looter) die Quest-Monster nicht wegplündern | [vorh.] | Gemeinsame persistente Sperre `veyra:loot-guard:v1`; alle Wave-Massen-Loot-Wege filtern geschützte Namen. |
| 6.3b | Es kann immer nur eine Quest angenommen sein. Alle verfügbaren Quests werden direkt nacheinander abgearbeitet. | [vorh.] | Der Worker sucht immer zuerst die aktive Quest und nimmt erst nach deren Finish die nächste verfügbare an. |
| 6.4 | Quests im Cooldown überspringen; nächster Check zum frühesten Ablauf | [vorh.] | Liest `.quest-cooldown-timer[data-cooldown-ts]` und veröffentlicht den frühesten Ablauf als Scheduler-`retryAt`. |
| 6.5 | Niemals „Give up“ auslösen | [vorh.] | Der Worker kennt ausschließlich Accept-, Loot- und Finish-Mutationen; ein Give-up-Endpunkt ist nicht implementiert und wird im Ablauf-Test ausgeschlossen. |

## 7. veyra-hud (externe Skripte von [SEREPH] koenrad, MIT-Lizenz)

Die Lizenz erlaubt Bündeln und Ändern; der MIT-Copyright-Hinweis muss im Bundle-Header erhalten bleiben.

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 7.1 | Core-Ersatz: Einstellungen als eigene Gruppen im Automation-Menü statt eines geklonten Quick-Set-Drawers | [vorh.] | Feature-Einstellungen werden nach General/Wave/Loot/Dungeon/PvP gruppiert; bestehende `ui-improvements:*`-Schlüssel bleiben kompatibel. |
| 7.2 | Gemeinsame Helfer übernehmen: User-ID ermitteln, Seiten per Fetch laden mit Cloudflare-Erkennung, Benachrichtigung, Level/EXP lesen | [vorh.] | In `src/core/game.js`, `http.js`, `numbers.js`, `storage.js` und `time.js` zentralisiert. |
| 7.3 | Better Header, eigene Navigationslinks | [vorh.] | Null-sicher; fehlende Event-Links und bereits vorhandene Ziele werden berücksichtigt. |
| 7.4 | Bessere Angriffs-Buttons und Asterion-Multiplikator (auch automatisch von `pets.php` gelesen) | [vorh.] | Multiplikator wird erkannt, gespeichert und für Anzeigen sowie Stamina-Prüfungen verwendet; an `damage.php` geht weiterhin der Basiswert. |
| 7.5 | Battle Pass: zum aktuellen Level scrollen, Scrollleisten synchron | [vorh.] | |
| 7.6 | Wave-Seite: Auswahl ohne Limit, nach HP sortieren/filtern, nach Namen gruppieren, Gate-Info ausblenden | [vorh.] | Eindeutige IDs und kompatible Korrektur des alten Tippfehler-Schlüssels. |
| 7.7 | Wave-Seite: Loot X (schnell, Boss-Blacklist), In-Battle-Zähler, Heal-Button, HP-Leiste blinkt bei wenig HP, Auto-Farm-Buttons sichtbar, Join-Links an Boss-Karten | [vorh.] | Mit 5.1 zusammengeführt, höchstens vier parallele Loot-Requests und vollständige Quest-Loot-Sperre. |
| 7.8 | Strategic Attack (Skill-Reihenfolge, Schadenslimit, Quick Join & Attack) | [vorh.] | Gemeinsame Rate-Limit-/Retry-Logik und Asterion-korrekte Stamina-Prüfung. |
| 7.9 | Merchant: „Buy N“-Buttons | [vorh.] | Shop-Kaufmodule teilen sich konsistente Mengen- und Sicherheitslogik. |
| 7.10 | Gildenmitgliederliste sortierbar | [vorh.] | Rollen, Zahlen, Daten und Text werden stabil sortiert. |
| 7.11 | Dungeon „Loot Monsters“ / Crucible „Loot All“ mit Stopp beim Level-up | [vorh.] | EXP-unabhängige Level-up-Signale, gedrosselte Requests und sicherer Fallback auf Einzel-Loot. |
| 7.12 | PvP: Skill-Karte, Gegnerklasse, Last-Hit-Anzeigen, letzte Kämpfe verlinkt und verschoben | [vorh.] | Benötigte Seitenvariablen und Skill-Aufrufe werden gezielt in den Seitenkontext injiziert. |
| 7.13 | Dungeon Participation Check (Report + CSV) | [vorh.] | Locations dynamisch, vier Requests parallel, eigene mobile/sortierbare Tabelle ohne Tabulator/CDN. |
| 7.14 | Inventar-Filter | [vorh.] | |
| 7.15 | Debug-Konsole | – | Entfällt (F19) |
| 7.16 | Gamba Enhanced (Event 7) und Equipment Presets | – | Entfallen (F19) |

---

## Entscheidungen

- **F2 Struktur:** Ein gebündeltes Userscript. Im Repo liegen die Module trotzdem als einzelne Quelldateien und werden zu einer `.user.js` zusammengebaut.
- **F3 PvP-Modi:** „autobattle“ ist das Auto Play des Spiels (Verhalten wie `solo_PvP.js`). „Solo_PvP“ ist der Skill-Planer aus `activate_auto_battle_target.js`.
- **F4 Wave-Angriff:** Weiter über die Bedienoberfläche von `monster_auto_battle.js`, das dafür als Modul ins Bündel kommt. Skillwahl und Tränke aus dem Menü setzen die Felder `#mabAttack1-3` und `#mabAutoStamina`.
- **F5 Cooldown:** Erst 100 ms ausprobieren. Bei HTTP 429 oder `Retry-After` bremst das Skript automatisch ab.
- **F6 Eigene Bosse:** Gemeint waren die Special Shadows aus der Shadow Army. Die Liste entfällt aber (F13).
- **F7 Hilfsskripte:** Looter, Bulk Buy und Auto Battle Extras kommen ins Bündel, die Tower-Skripte nicht.
- **F8 Aufräumen:** `veyra_ui_chatgpt_version.js` und `Advanced_Dead_Monster_Looter_v1.9…txt` sind gelöscht.
- **F9 Hintergrund:** Nicht mehr pausieren, wenn der Tab verdeckt ist. Fällige Aktionen werden beim Zurückkehren sofort nachgeholt.
- **F1 Crucible:** Die Teilnahme am ganzen Dungeon soll automatisch nach den Voreinstellungen laufen (siehe 4.3).
- **F10 Army:** Ablauf ist geklärt: Launch Fight bzw. Enter Fight → Join With My Army → Live-Kampf (siehe 4.3.9–4.3.12).
- **F11 Crucible-PvP:** Die Beispielseiten sind ausgewertet (4.3.6–4.3.6e).
- **F12 Menü:** Die Seitenleiste bleibt, kein Akkordeon (1.2).
- **F14 Army-Kampf:** Das Skript weist aktiv Ziele zu. Minimal heißt: ein Shadow greift an, dann sofort Retreat. Kill heißt: alle Shadows auf alle Gegner, bis der Kampf gewonnen ist oder alle eigenen Shadows tot sind (4.3.11). Heilen gehört dazu (4.3.13).
- **F15 Quests:** Für den Questfortschritt zählt das Looten. Erst alle nötigen Monster töten, dann die Quests nacheinander abarbeiten (6.2, 6.3).

- **F13 Special Shadows:** Die Liste entfällt.
- **F16 Quests:** Es geht immer nur eine Quest gleichzeitig; alle werden direkt nacheinander abgearbeitet. Monster und Cooldown halten beide ca. 48 h (6.3b).
- **F17 Match-Wahl:** Bevorzugt das Match mit den meisten belegten Plätzen (4.3.6b).
- **F18 Crucible-PvP-Kampf:** Der Kampf läuft automatisch, sobald das Team voll ist; es braucht keine Strategie. Wird ein Knoten fertig, fällt die Wartezeit auf 0 und das Skript geht sofort zum nächsten Knoten (4.3.6a).

- **F19 veyra-hud:** Alles kommt ins Bundle außer Debug-Konsole, Gamba Enhanced und Equipment Presets (Abschnitt 7).
- **F20 Shadowbridge-Grenzen:** Die Lootgrenze wird live von der Battle-Seite gelesen; die EXP-Grenze spielt bei Mobs keine Rolle. Im Bossraum sind alle vier Modi möglich (4.1.1a, 4.1.1b).

- **F22 Wave/Olympus:** Die Bosse werden weiter über Monster Auto Battle angegriffen; MAB ist dafür ins Bundle portiert und wird über `src/features/battle/mab-bridge.js` gesteuert. Olympus ist eine einzige Seite im Menü, deren Besuch nacheinander alle Domänen mit aktivierten Bossen abläuft.
- **F21 Asterion:** An `damage.php` gehen immer die Basis-Staminakosten (1/10/50/100/200). Asterion wirkt nur auf die Anzeige und auf Stamina-Prüfungen, nicht auf `stamina_cost`. Das gilt auch für die neue Shadowbridge-Logik (4.1); `dungeon_auto_damage_fast` hatte hier multipliziert.

## Offene Fragen

Keine.
