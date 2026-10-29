# Funktionsliste – Veyra Automatisierung (Entwurf)

Grundlage: `arbeitsauftrag.txt`, die bestehenden Skripte und die Beispielseiten in `veyra_seiten.txt`.
Status-Legende: **[vorh.]** existiert schon weitgehend · **[anp.]** existiert, muss angepasst werden · **[neu]** neu zu bauen · **[?]** offene Frage

---

## 0. Übergreifend

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 0.1 | Alle Skripte laufen auf Desktop und Mobilgerät | [anp.] | Der Scheduler hat schon Mobile-CSS und bfcache-Handling. Er pausiert aber bei `document.hidden`, auf dem Handy also sobald der Tab im Hintergrund ist. |
| 0.2 | Alle Skripte inkl. UI-Texte auf Englisch | [anp.] | Der Scheduler, `solo_PvP.js`, der Profile Manager und die Gear Tools haben deutsche UI. |
| 0.3 | Gemeinsame Hilfsfunktionen: Zahlen parsen (`3M`, `3b`), Potions, Join, Attack, Retry/Rate-Limit | [neu] | Diese Logik ist heute in 4–5 Dateien kopiert. |
| 0.4 | Kommunikation Hauptskript ↔ Seitenskripte über das bestehende localStorage-Protokoll (command/status/heartbeat) | [vorh.] | `veyra:orchestrator:*` und `veyra:worker:<route>:status:v1` |
| 0.5 | Kein Seitenskript hängt von Fremd-Frameworks ab | [anp.] | `dungeon_auto_damage_fast.user.js` braucht das externe „UI Improvements“-Skript (`Storage`, `internalFetch`, …). |
| 0.6 | Tests mit `node --test tests/` für alle neuen Module | [anp.] | |

## 1. Hauptskript (Basis: `veyra_meta_scheduler.js`)

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 1.1 | Start/Stop des gesamten Ablaufs | [vorh.] | |
| 1.2 | Menü mit einer Liste aller aufrufbaren Seiten | [vorh.] | Die bestehende Seitenleiste mit Unteransicht bleibt (F12). |
| 1.3 | Pro Seite: Name, Countdown bis zum nächsten Aufruf, Toggle zum Aktivieren/Deaktivieren, Button für das Untermenü | [vorh.] | Für pvp und wave3 vorhanden, für die anderen Seiten fehlt es noch. |
| 1.4 | Countdown abgelaufen → zur Seite navigieren und Seitenskript starten | [vorh.] | |
| 1.5 | Seitenskript fertig → zur Hauptseite zurück und Countdown neu starten | [vorh.] | |
| 1.6 | Untermenü-Standardfeld: Looplänge in Minuten | [neu] | Heute fest im Code (pvp 5 min, wave3 30 min). |
| 1.7 | Untermenü-Standardauswahl: Stamina-Tränke und Heiltränke | [anp.] | Heute gibt es nur eine Checkbox für Stamina bei wave3. Bekannte Item-IDs: 30 Small, 251 Large, 35 Full, 359 Adventurer Stamina; 108 Full HP. |
| 1.8 | Hauptseite wählbar | [vorh.] | |
| 1.9 | Höchstdauer pro Besuch / Timeout, danach geordneter Rückzug | [vorh.] | `maxVisit` und Drain-Logik sind vorhanden. |
| 1.10 | Neue Routen: Olympus-Domänen, Shadowbridge, Crucible (Prince später) | [neu] | |

## 2. Wave-Seiten (Wave 3 + Olympus)

URLs: Wave 3 `active_wave.php?gate=3&wave=8`. Olympus `gate=5`: außen wave=9, Hermes 10, Artemis 11, Poseidon 12, Ares 13, Apollo 14, Athena 15, Hera 16, Zeus 17.

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 2.1 | Menü: Bossliste mit Checkbox „angreifen“ | [anp.] | wave3 hat heute vier feste Bosse ohne Checkbox. |
| 2.2 | Menü: Schadensziel pro Boss (Zahl oder `3M`/`3b`) | [vorh.] | `normalizeDamageTarget` |
| 2.3 | Menü: Stamina-Tränke auswählbar | [anp.] | |
| 2.4 | Menü: Angriff/Skill auswählbar (Slash 0, Power −1, Heroic −2, Ultimate −3, Legendary −4, evtl. −5) | [neu] | |
| 2.5 | Alle Olympus-Bosse in einem gemeinsamen Untermenü einstellbar | [neu] | Pro Domäne zwei Bosse (Herald-Mob + Gott); Olymp außen: Oceanus + Poseidon. |
| 2.6 | Skript: Prüfen, welche Bosse aktiv sind | [anp.] | `data-boss` ist immer 0, deshalb Erkennung über Namen bzw. `.auto-summon-card`. Ein lebender Gott kann einen anderen `data-name` tragen (z. B. „zeus, duelist of …“). |
| 2.7 | Skript: Eigenen Schaden prüfen (`data-userdmg`) | [vorh.] | |
| 2.8 | Skript: Beitreten, falls noch nicht beigetreten | [anp.] | POST `user_join_battle.php` mit `monster_id` und `user_id` |
| 2.9 | Skript: Angreifen, bis das Ziel erreicht ist | [anp.] | Weiter über die Bedienoberfläche von `monster_auto_battle.js` (siehe F4). Neu ist nur, dass Skill und Tränke aus dem Menü übernommen werden. |
| 2.10 | Skript: Stamina nachfüllen bzw. heilen gemäß Einstellungen | [anp.] | |

## 3. PvP

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 3.1 | Menü: Modus wählen, „autobattle“ (Auto Play des Spiels) oder „Solo_PvP“ (Skill-Planer) | [neu] | |
| 3.2 | Solo-Tokens prüfen | [vorh.] | |
| 3.3 | Gegner suchen und Kampf im gewählten Modus führen | [anp.] | `solo_PvP.js` kennt den Scheduler noch nicht. |
| 3.4 | Nach dem Kampf zurück in die Lobby, wiederholen solange Tokens da sind, dann zurück zur Hauptseite | [vorh.] | Im Smart-PvP-Worker vorhanden. |

## 4. Guild Dungeons

### 4.1 Shadowbridge Warrens

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 4.1.1 | Monsterliste aus `dungeon_auto_damage_fast.user.js` (nur Namen und Reihenfolge) | [anp.] | 18 Monster. Die festen `imposed_damage_limit`-Werte entfallen (F20). |
| 4.1.1a | „Max Loot“ liest die Lootgrenze direkt vor dem Angriff von `battle.php` (höchster „DMG req“ unter Possible Loot) | [neu] | Für normale Mobs zählt nur die Lootgrenze, die EXP-Grenze ist egal. |
| 4.1.1b | Bossraum: eigene Einstellung mit allen vier Modi: Max Loot, Max EXP, Kill, individueller Schaden | [neu] | EXP-Grenze aus „Deal ~N dmg to hit cap“ bzw. `capfraction × maxhp` |
| 4.1.2 | Reihenfolge per Drag & Drop änderbar (auch per Touch) | [neu] | |
| 4.1.3 | Active-Toggle pro Monster | [vorh.] | |
| 4.1.4 | Modus pro Monster: Max Loot / Kill / individueller Schaden mit eigenem Feld (kein Max EXP bei normalen Mobs) | [anp.] | |
| 4.1.5 | Schnelleinstellung „Clean dungeon“: alle Monster aktiv und auf Kill | [anp.] | Ähnliches gibt es als „Clear All“. |
| 4.1.6 | Skill-Auswahl, Standard Slash | [vorh.] | |
| 4.1.7 | Attack-Cooldown 100–2000 ms, Standard 100 ms | [anp.] | Heute 500–5000 ms, Standard 1050 ms. 100 ms wird erst ausprobiert, bei HTTP 429 bremst das Skript automatisch ab (F5). |
| 4.1.8 | Skript wie `dungeon_auto_damage_fast`, aber eigenständig | [anp.] | |
| 4.1.9 | Mehrere Locations (1–4) durchlaufen | [vorh.] | |

### 4.2 Castle of the Fallen Prince – vorerst zurückgestellt

### 4.3 The Polyhedral Crucible

**Ziel:** Die Teilnahme am kompletten Dungeon läuft automatisch nach den Voreinstellungen. Das Skript liest den Knotenstatus (`STATE.nodes`: available / in_progress / cleared / locked) und arbeitet jeden aktivierten Knoten seines Typs ab: PvE, PvP oder Army.

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 4.3.1 | Menü mit drei Abschnitten: PvE, PvP, Army | [neu] | |
| 4.3.2 | PvE (Prism Gate, Ash Lane, Crown of Calibration): Monsterliste mit Active-Toggle | [neu] | Locations 11, 12, 13 |
| 4.3.3 | PvE-Modi: Max Loot / Max EXP / Kill / individueller Schaden | [neu] | |
| 4.3.4 | Max Loot und Max EXP direkt vor dem Angriff auf `battle.php` auslesen | [neu] | Loot = höchster „DMG req“ unter Possible Loot. EXP = `ceil(capfraction × maxhp)` bzw. „Deal ~N dmg to hit cap“. |
| 4.3.5 | PvP: Aktivieren-Toggle | [neu] | |
| 4.3.6 | PvP-Skript, Schritt 1: Den aktiven PvP-Knoten finden (Ring Ward → Duel Heart → Tyrant Conclave) | [neu] | `STATE.nodes` mit `type=pvp` und Status `available`/`in_progress`. Lobby: `pvp_style_node.php?source=cube&instance_id&node_id` |
| 4.3.6a | Schritt 2: Wartezeit prüfen | [neu] | Wenn man schon gebunden ist, steht das in `div.warn`: „You are currently committed to match #2 for about 01:59:55 more.“ Die Zeit gibt es nur als Text, sie wird per Regex gelesen. Ist man in einem offenen Match, geht es dorthin weiter, sonst wird die Restzeit als Countdown gesetzt. Die Bindung (ca. 2 h) beginnt schon beim Belegen des Platzes. **Wichtig:** Ist der Knoten fertig und der nächste PvP-Knoten geöffnet, fällt die Wartezeit sofort auf 0. Das Skript prüft den Knotenstatus deshalb regelmäßig (`STATE.nodes`, unabhängig vom Countdown). Wird der aktuelle Knoten `cleared` und ein neuer PvP-Knoten `available`, setzt es den Countdown sofort auf 0 und belegt dort einen Platz. |
| 4.3.6b | Schritt 3: Match mit freiem Platz wählen (bevorzugt das mit den meisten belegten Plätzen) und Platz belegen | [neu] | Match-Karten `.grid > .match` mit Badge `OPEN`/`CLEARED` und `.meta` „Match #N / Slots x/5“. Ein freier Platz hat kein `.name`, der eigene trägt `.selfMark` „YOUR SLOT“. Belegen: POST `pvp_style_action.php` mit `source=cube`, `action=pick_slot`, `instance_id`, `node_id`, `match_no`, `slot_index` (1–5); kein CSRF nötig. Das Match startet automatisch, sobald 5/5 Plätze belegt sind (oder ein Officer es früher startet). |
| 4.3.6c | Schritt 4: Kampf abwarten | [neu] | Sobald das Team vollständig ist, läuft der Kampf automatisch; das Skript braucht keine Strategie. Es beobachtet den Zustand nur: GET `pvp_style_state.php` mit `room_status` (open/live/cleared/lost) und `match.ended`. |
| 4.3.6d | Schritt 5: Ende erkennen und neu planen | [neu] | `match.ended`; Sieg bei `winner_side='ally'` bzw. `room_status='cleared'`. Danach zurück zur Lobby und nächster Countdown. |
| 4.3.7 | Army: Aktivieren-Toggle und Schadensmodus (minimal / töten) | [neu] | Zeile 69 im Arbeitsauftrag sagt „PvE“, gemeint ist vermutlich Army. |
| 4.3.9 | Army-Skript, Schritt 1: Knotenseite `guild_dungeon_cube_army_enter.php?instance_id&node_id` | [neu] | Fight-Karten `.fight[data-match-no]` mit Status open / active / failed / cleared. Der Button `[data-enter-match]` heißt je nach Status „Launch Fight“ (Kampf neu starten, kann jeder), „Enter Fight“ (läuft schon) oder „Retry Fight“. API: POST `guild_dungeon_cube_army_action.php` mit `action=enter_fight`, `instance_id`, `node_id`, `match_no` → `redirect`. Man kann nur an einem Fight pro Knoten gleichzeitig teilnehmen. |
| 4.3.10 | Army-Skript, Schritt 2: Live-Kampf `shadow_army_live_battle.php` | [neu] | Wenn `state.viewer.can_join` gesetzt ist, „Join With My Army“ (`#joinBattleBtn`) auslösen. API: POST `shadow_army_live_battle.php` mit `action=join_battle` und `battle_id`. Die Armee kommt aus der gespeicherten Formation (`has_roster`). |
| 4.3.11 | Army-Skript, Schritt 3: Ziele aktiv zuweisen | [neu] | **Minimal:** Ein eigener Shadow greift einen Gegner an, danach sofort Retreat. **Kill:** Alle verfügbaren eigenen Shadows greifen alle Gegner an, bis der Kampf gewonnen ist oder alle eigenen Shadows tot sind. API: POST `shadow_army_live_battle.php` mit `action=get_state` (Zustand abfragen), `action=assign_target` (`attacker_captain_unit_id`, `defender_captain_unit_id`) und `action=retreat_captain` (`captain_unit_id`). Captain-Felder: `side`, `is_mine`, `is_dead`, `retreat_requested`, `squad_current_health`/`squad_max_health`. |
| 4.3.12 | Army-Skript, Schritt 4: Fertig, wenn `battle.status` nicht mehr `ACTIVE` ist; dann den nächsten offenen Fight bzw. den nächsten Knoten wählen | [neu] | |
| 4.3.13 | Army heilen: Vor dem Beitreten, wenn die Armee tot oder verwundet ist | [neu] | Auf `shadow_army.php` per POST (Formular), entweder `action=heal_all_units` („♡ Heal All Units“) oder einzeln `action=heal_unit`, `unit_type=special|normal`, `unit_id`. Der Heal-Button ist deaktiviert, solange nichts zu heilen ist bzw. noch nicht bereit. |

---

## 5. Eingebundene Hilfsskripte (als Module im gebündelten Skript)

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 5.1 | Dead Monster Looter (Sortierung, Loot, Extract, Loot to Level Up) | [anp.] | aus `Advanced_Dead_Monster_Looter.js` |
| 5.2 | Bulk Buy in Damon's Shop | [anp.] | aus `buy_in_bulk.js` |
| 5.3 | Auto Battle Extras (Castle-Event) | [anp.] | aus `Auto Battle Extras.user.js` |
| 5.4 | Tower-Skripte | – | bleiben eigenständig |

## 6. Adventurer's Guild Quests

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 6.1 | Eigene Route mit Countdown, Toggle und Untermenü wie die anderen Seiten | [neu] | `adventurers_guild.php` |
| 6.2 | Phase 1, vorfarmen: Auto Farm auf Olymp außen (`active_wave.php?gate=5&wave=9`) so einstellen, dass von jedem Quest-Monster mindestens 10 getötet werden, jeweils mit mindestens 5m eigenem Schaden | [neu] | Die Logik aus `auto_farm_profile__manager.js` kann wiederverwendet werden. API: `auto_farm_actions.php` mit `add_target` / `update_target` / `save_settings` / `toggle`. Die geforderten Monster und der Mindestschaden werden aus `.quest-req-text` gelesen. |
| 6.3 | Phase 2, Quests abarbeiten: Quest annehmen, 10 passende tote Monster looten, Quest abschließen, nächste Quest | [neu] | Entscheidend ist das **Looten**, nicht der Kill. Die Monster bleiben dafür ungelootet liegen (Prüfung über `data-eligible="1"` und `data-userdmg` ≥ Mindestschaden). Loot: POST `loot.php` mit `monster_id` und `user_id`. Quests stehen in `.quest-row` (Beschreibung `.quest-main-desc`, Ziel `.quest-req-text`, z. B. „Kill 10 monster(s) · Monster: Kraken · min 5m dmg“). Annehmen: POST `/adventurers_accept_quest.php` mit `quest_id`. Abschließen: POST `/adventurers_finish_quest.php` mit `quest_id`. |
| 6.3a | Bis zum Abschluss aller Quests dürfen andere Module (z. B. der Dead Monster Looter) die Quest-Monster nicht wegplündern | [neu] | |
| 6.3b | Es kann immer nur eine Quest angenommen sein. Alle verfügbaren Quests werden direkt nacheinander abgearbeitet. | [neu] | Tote Monster bleiben ca. 48 h liegen, der Quest-Cooldown beträgt ebenfalls ca. 48 h. Das Ablaufen der Monster ist damit kein Problem; das Skript prüft trotzdem `data-expire`. |
| 6.4 | Quests im Cooldown überspringen; nächster Check zum frühesten Ablauf | [neu] | `.quest-cooldown-timer[data-cooldown-ts]` (Unix-Zeit) |
| 6.5 | Niemals „Give up“ auslösen | [neu] | Eine abgebrochene Quest kann man nie wieder annehmen. |

## 7. veyra-hud (externe Skripte von [SEREPH] koenrad, MIT-Lizenz)

Die Lizenz erlaubt Bündeln und Ändern; der MIT-Copyright-Hinweis muss im Bundle-Header erhalten bleiben.

| # | Funktion | Status | Notiz |
|---|---|---|---|
| 7.1 | Core-Ersatz: Einstellungen als eigene Gruppen im Automation-Menü statt eines geklonten Quick-Set-Drawers | [neu] | Behebt: Einstellungen fehlen ohne Equipment-Preset; Schließen lädt die Seite neu; Drawer wird doppelt initialisiert. Bestehende Schlüssel `ui-improvements:*` bleiben, damit gespeicherte Einstellungen erhalten bleiben. |
| 7.2 | Gemeinsame Helfer übernehmen: User-ID ermitteln, Seiten per Fetch laden mit Cloudflare-Erkennung, Benachrichtigung, Level/EXP lesen | [neu] | Teilweise schon in `src/core` vorhanden |
| 7.3 | Better Header, eigene Navigationslinks | [anp.] | Absturz beheben, wenn der Link „Emberfall Event“ fehlt |
| 7.4 | Bessere Angriffs-Buttons und Asterion-Multiplikator (auch automatisch von `pets.php` gelesen) | [anp.] | Der Multiplikator wird auch für die Stamina-Kosten der Automatisierung genutzt. |
| 7.5 | Battle Pass: zum aktuellen Level scrollen, Scrollleisten synchron | [anp.] | |
| 7.6 | Wave-Seite: Auswahl ohne Limit, nach HP sortieren/filtern, nach Namen gruppieren, Gate-Info ausblenden | [anp.] | Doppelte IDs und den Tippfehler im Schlüssel beheben |
| 7.7 | Wave-Seite: Loot X (schnell, Boss-Blacklist), In-Battle-Zähler, Heal-Button, HP-Leiste blinkt bei wenig HP, Auto-Farm-Buttons sichtbar, Join-Links an Boss-Karten | [anp.] | Mit dem Dead Monster Looter (5.1) zu einem Loot-Modul zusammenführen; 200 parallele Requests drosseln. Die Quest-Funktion (6.3a) muss Quest-Monster vom Massen-Looten ausnehmen können. |
| 7.8 | Strategic Attack (Skill-Reihenfolge, Schadenslimit, Quick Join & Attack) | [anp.] | Nutzt den gemeinsamen Angriffs-Helfer (`core/http`, Rate-Limit) |
| 7.9 | Merchant: „Buy N“-Buttons | [anp.] | Zusammen mit Bulk Buy (5.2) zu einem Kauf-Modul |
| 7.10 | Gildenmitgliederliste sortierbar | [anp.] | |
| 7.11 | Dungeon „Loot Monsters“ / Crucible „Loot All“ mit Stopp beim Level-up | [anp.] | Fehler beheben: ohne EXP-Anzeige stoppt es nach dem ersten Monster. |
| 7.12 | PvP: Skill-Karte, Gegnerklasse, Last-Hit-Anzeigen, letzte Kämpfe verlinkt und verschoben | [anp.] | Greift auf Seitenvariablen zu; muss dafür in den Seitenkontext injiziert werden. |
| 7.13 | Dungeon Participation Check (Report + CSV) | [anp.] | Locations aus der Seite statt fest 1–4, Requests drosseln. Tabulator vom CDN durch eine eigene Tabelle ersetzen. |
| 7.14 | Inventar-Filter | [anp.] | |
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
- **F11 Crucible-PvP:** Die Beispielseiten sind ausgewertet (4.3.6–4.3.6d).
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
