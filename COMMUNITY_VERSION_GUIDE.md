# Veyra Automation Community Version

This userscript automates selected recurring activities on Demonicscans Veyra. The Community Version does **not** include Shadowbridge Warrens automation.

## Installation

1. Install the Tampermonkey browser extension.
2. Open the [raw userscript URL](https://raw.githubusercontent.com/Myrkjartan-Hrolfr/demonicscans_veyra_scripts/main/dist/veyra_automation_comunity_version.user.js).
3. Tampermonkey should open its installation screen automatically. Select **Install**.
4. Disable the full **Veyra - Automation** userscript if it is installed. Do not run both versions at the same time.

## Usage

1. Log in to Veyra and open any game page on `demonicscans.org`.
2. Click the floating automation button in the lower-right corner.
3. Open the settings for each activity, configure its options and loop interval, and enable only the activities you want to automate.
4. Press **Start** in the automation panel.
5. Keep the game tab open. The script will visit enabled pages when their countdown expires and return to the Home page afterward.

You can stop all scheduled automation with the **Stop** button. Individual activities can also be enabled or disabled separately.

## How the settings are organized

The script has three kinds of settings:

1. **Pages** are scheduled automations. Each page has its own enable switch, countdown and settings button.
2. **Features** are page improvements such as wave filters, loot tools and PvP information. Feature changes take effect after reloading the game page.
3. Some game pages receive their own control panel, most notably **Monster Auto Battle** and **Auto Battle Extras**.

The global **Start/Stop** button controls only the scheduler. Page features remain available while the scheduler is stopped.

## Common scheduler settings

Every entry under **Pages** has these controls:

| Setting | Explanation |
|---|---|
| Page switch | Enables or disables this scheduled activity without affecting the other pages. |
| Loop length | Minutes between completed visits. The allowed range is 1 to 1,440 minutes. |
| Stamina potions | Potions the worker may use when it needs stamina. Selected potions are tried in this fixed order: Small, Large, Full, Adventurer. |
| Healing potions | Allows a Full HP Potion where the corresponding worker supports automatic healing. |

Potion settings are stored separately for every page. A worker only consumes a selected potion when that activity needs and supports it.

### Scheduled automation overview

| Automation | Default | What it does |
|---|---:|---|
| PvP | On, 5 min | Starts available Solo PvP fights and completes them with the selected battle mode. |
| Wave 3 | On, 30 min | Attacks the four configured Wave 3 bosses up to their individual damage targets. |
| Olympus | On, 30 min | Visits the Olympus domains and attacks only the enabled heralds and gods. All Olympus bosses are initially disabled. |
| Adventurer's Guild | Off, 5 min | Pre-farms required quest monsters, accepts quests, loots the required kills and turns quests in. |
| Castle of the Fallen Prince | Off, 30 min | Finds the current dungeon instance and processes its five rooms with individual damage rules. |
| The Polyhedral Crucible | Off, 5 min | Handles enabled Crucible PvE, PvP and Shadow Army nodes. |

### PvP

**Battle mode** applies to every automated Solo PvP fight:

- **Game Auto Play** enables the game's built-in automatic combat.
- **Solo PvP skill planner** uses the script's deliberate PvP skill sequence instead.

Game Auto Play is the default.

### Wave 3

The available bosses are General Skarn, General Vessir, General Hrazz and Drakzareth. Each boss has:

- **Attack [boss]** — includes or excludes that boss.
- **Damage target** — total personal damage to deal, accepting values such as `500m` or `3b`.

Under **Attacks**, select up to three attacks. If several selected attacks are available, they are used from the most expensive to the cheapest. Class skills can still be selected in the Monster Auto Battle panel. All four bosses are enabled by default with a `3b` target; Slash is the initially selected attack.

### Olympus

The scheduler covers the outer Olympus area and the Hermes, Artemis, Poseidon, Ares, Apollo, Athena, Hera and Zeus domains. Every herald and god can be enabled separately and has its own damage target.

The eight main gods use three phases:

- **Phase 1 damage target** is the damage to deal before entering the duel.
- In Phase 2 the script clicks **Enter Phase**, completes the PvP-style duel using Power Slash while affordable and Slash as the fallback, then returns to the boss.
- **Phase 3 additional damage target** is added after Phase 2. For example, `3b` in Phase 1 and `4b` in Phase 3 means approximately `7b` total personal damage.

Up to three standard attacks can be selected for the boss phases. They are used from the most expensive to the cheapest. Olympus bosses are disabled by default and Slash is the initially selected attack, so enable only the targets you want.

### Adventurer's Guild

| Setting | Default | Explanation |
|---|---:|---|
| Monsters to farm before quest turn-ins | 95 | Total Auto Farm kills prepared before the quest cycle begins. |
| Maximum stack per quest monster | 10 | Maximum Auto Farm stack assigned to each required Olympus quest monster. |

The automation first checks whether enough eligible dead monsters already exist. If so, it skips Auto Farm. Otherwise it saves the current Auto Farm setup, resets it, configures all required quest monsters and starts farming. It then processes one quest at a time and restores the previous Auto Farm configuration when finished. Required quest monsters are protected from bulk looting during the run.

### Castle of the Fallen Prince

The current dungeon and battle IDs are discovered on every run; changing instance IDs do not need to be configured.

| Setting | Explanation |
|---|---|
| Attack skill | Skill used against all enabled dungeon monsters. |
| Attack cooldown | Delay between attacks, from 100 to 2,000 ms. |
| Attack this monster | Includes or skips the monster in that room. |
| Max damage | Attacks up to the monster's current maximum HP. |
| Kill monster | Continues until the monster dies. |
| Custom damage | Stops at the entered personal damage target. |

Separate rules are available for The Vizier's Conspiracy Hall, Hall of the Bloodbound, Room of Beasts, Room of the Dead Crown and The True Heir Throne. Live monster names are discovered and saved automatically.

Initially, all five monsters are enabled in **Max damage** mode, using Slash with a 100 ms cooldown.

### The Polyhedral Crucible

Crucible has independent sections for PvE, PvP and Shadow Army battles.

**PvE settings**

| Setting | Explanation |
|---|---|
| Enable PvE automation | Master switch for Gate Prism, Ash Lane, Crown Lens and the Apex at Zenith Lock. |
| Attack skill | Standard attack used for Crucible PvE. |
| Attack cooldown | Delay between attacks, from 100 to 2,000 ms. |
| Attack this monster | Enables an individually known monster. |
| Newly discovered monster default | Rule inherited by a monster when its live name is seen for the first time. |
| Max loot | Reads and uses the live loot damage cap. |
| Max experience | Reads and uses the live EXP damage cap. |
| Kill monster | Attacks until death. |
| Custom damage | Stops at the entered personal damage target. |

The Apex and newly revealed monsters are discovered from the live dungeon rather than relying on fixed battle IDs.

**PvP settings**

- **Enable Crucible PvP nodes** covers Ring Ward, Duel Heart and Tyrant Conclave. The fullest open match is preferred.
- A background watcher checks the match or cooldown independently of the main loop countdown. After a win it opens the completed battle in a hidden same-origin frame so the game awards the reward, then wakes Crucible when another slot is ready.

**Army settings**

| Setting | Explanation |
|---|---|
| Enable Crucible Army nodes | Enables Veil Post, Captain Spine and Abyssal Muster. |
| Minimal | Assigns one captain, verifies one hit and retreats it. |
| Kill | Assigns every available captain and continues against all captains. |
| Shadows used by the automation formation | Selects which owned special Shadows may be used. Newly discovered special Shadows appear unchecked. |

The worker may add a selected captain to a free formation slot, but it does not remove saved captains or their assigned normal Shadows. During a battle, non-selected special Shadows are retreated before targets are assigned.

When Crucible is configured for the first time, PvE, PvP and Army are all enabled inside the otherwise disabled Crucible route. PvE starts with Slash, a 100 ms cooldown and **Max loot**. Army starts in **Minimal** mode with the initially known special Shadows selected. Review these sub-settings before enabling the route.

**Diagnostics**

Enable **Crucible diagnostic logging** only while investigating a problem. It stores up to 500 sanitized local entries containing decisions, requests, node states and failures. **Refresh log**, **Copy log** and **Clear log** manage the displayed report. Disable logging again after reproducing the issue.

## Feature settings

Feature settings are found under **Features** in the automation drawer. Reload the game page after changing them.

### General

| Setting | Default | Explanation |
|---|---:|---|
| Show Auto Farm target Activate buttons | On | Adds an **Activate** button that enables one target group and disables the other groups. |
| Power Crystal Quickset | On | Adds the filterable crystal equipment manager described below. |
| Shadow Army manager | On | Replaces the long Shadow lists with compact level and star controls. |
| Better Header | On | Keeps the top bar with the page and lets it wrap on small screens. |
| Custom Navigation | On | Adds shortcuts such as Wave 3, Olympus, Arcane Wild Fringe, Shadow Army, Guild Dungeons, Black Merchant, Legendary Forge, Decraft Altar and Weekly Leaderboard. |
| Better Attack Buttons | On | Displays the stamina cost on attack buttons. |
| Use Asterion multiplier | Off | Multiplies shown and calculated stamina costs by the Asterion value. The value is detected on the Pets page. |
| Asterion multiplier | 1.5 | Multiplier used when the Asterion option is enabled. |

### Battle Pass, Guild, Inventory and Shops

| Group | Setting | Default | Explanation |
|---|---|---:|---|
| Battle Pass | Auto scroll to current level | On | Opens the reward track near the current level. |
| Battle Pass | Sync scrollbars | On | Scrolling one reward track scrolls the other track with it. |
| Guild | Guild member list sorting | On | Makes member table headers sortable. |
| Inventory | Inventory filter | On | Adds a switch for hiding selected inventory items. |
| Shops | Merchant "Buy N" buttons | On | Buys as many units as both the offer limit and available gold allow after confirmation. |
| Shops | Damon's shop bulk buy | On | Buys up to 10,000 units of an unlimited offer in batches of 99. |

### Wave filtering

| Setting | Default | Explanation |
|---|---:|---|
| Unlock the "Select visible" limit | On | Selects every visible living monster instead of at most ten. |
| Sort monsters by HP | Off | Shows the lowest-current-HP monsters first. |
| Filter monsters by HP | Off | Enables the minimum and maximum current-HP filter. |
| Minimum HP | 0 | Hides monsters below this current HP while HP filtering is enabled. |
| Maximum HP | Empty | Hides monsters above this current HP; empty means no upper limit. |
| Group monsters by name | Off | Shows one grouped row per monster type while **All monsters** is selected. |
| Hide gate info | On | Collapses the long gate description and provides a button to show it. |

### Wave page

| Setting | Default | Explanation |
|---|---:|---|
| Flash the HP bar when HP is low | On | Flashes the player HP bar below 10%. |
| Show "In battle" count | On | Counts living monsters that you have already joined. |
| Strategic attack | On | Adds **Quick Join & Attack** and an editor for the skill sequence used on selected monsters. |
| Minimum delay between strategic attacks | 1,050 ms | Minimum wait between requests made by the strategic attack sequence. |
| Stop strategy at a damage limit | Off | Stops using the remaining configured skills on a monster after the personal damage limit is reached. |
| Damage limit | 0 | Personal damage cap used when the preceding option is enabled. |

Wave pages also always receive a **Heal** button, visible Auto Farm Start/Pause/Reset buttons and direct **Join** links for living auto-summon bosses.

### Loot

| Setting | Default | Explanation |
|---|---:|---|
| Dead Monster Looter panel | On | Adds selection, filters, damage sorting, selected looting, zero-damage looting, Shadow extraction and loot-to-level tools. |
| Dead loot pages to merge | 5 | Loads up to this many dead-monster pages into the panel. Each page contains 200 monsters; `1` disables merging. |
| Show your damage on dead cards | On | Adds your personal damage to each dead monster card. |
| Faster Loot X | On | Adds a fast Loot X action using up to four parallel requests. |
| Ignore boss mobs when bulk looting | On | Keeps major wave bosses out of Loot X, zero-damage and loot-to-level actions. |
| Dungeon bulk loot buttons | On | Adds **Loot Monsters** to dungeon instances and **Loot All** to Crucible. |
| Stop dungeon looting on level up | On | Stops dungeon bulk looting when an actual level increase is detected. |

### Dungeon

| Setting | Default | Explanation |
|---|---:|---|
| Dungeon participation report | On | Adds **Generate report** and **Export CSV** with damage, EXP and loot-cap information per player. |

### PvP

| Setting | Default | Explanation |
|---|---:|---|
| Solo PvP improvements | On | Master switch for the Solo PvP battle HUD and lobby changes. |
| Show enemy class | On | Shows the class or role below enemies in Solo and Party PvP. |
| Show enemy last hit | On | Shows the latest recorded action for each enemy. |
| Show ally last hit | On | Shows the latest recorded action for each ally. |
| Show attack card | On | Displays active skills above Turn Control and highlights the card on your turn. |
| Move recent battles | On | Moves Recent Battles into the main PvP column. |
| Link recent battles | On | Makes recent battle cards open their battles; Ctrl-click or middle-click opens a new tab. |

## In-page control panels

### Power Crystal Quickset

When enabled, the Power Crystals page gains an equipment and crystal overview with:

- equipment type, set and text filters;
- every equipped crystal shown with its level and stars;
- drag and drop from available crystals onto an equipment slot;
- drag and drop from an equipment slot back to the available-crystal panel to unequip it;
- a button to remove all crystals from the currently visible equipment;
- additive level and star upgrades, limited automatically by the available resources;
- restoration of filters and scroll position after the game reloads the page following an action.

Clicking another crystal changes the current selection immediately.

### Shadow Army manager

The manager displays Elite Shadows and normal Shadows above level 1. Normal level-1 Shadows are treated as star-up sacrifices and are not listed individually. Each displayed Shadow has a **Level +** and **Stars +** control, with the available scroll and sacrifice counts shown beside the relevant action.

### Monster Auto Battle

Every normal monster battle page receives an **Auto Battle** panel for the current monster only.

| Setting | Explanation |
|---|---|
| Attack 1 | Primary selected attack. |
| Attack 2 / Attack 3 | Stamina fallbacks if the preferred attack cannot be used. |
| Attack while poisoned | Optional override used when the newest own combat-log entry reports poison. |
| Total monster damage target | Includes damage dealt before Start. `0` means unlimited. |
| Delay between attacks | Wait in milliseconds between attacks. |
| Automatic stamina/mana potions | Allows configured potions to be used when the matching resource is required. |
| Automatic health potion | Uses a selected full-health potion after defeat. |
| Stop before level-up | Stops when remaining EXP is below the configured multiple of the last EXP gain. |
| Potion priority lists | Enable potions, set supported multi-use amounts and move them up or down in usage order. |

Use **Refresh attacks and potions** after the page's available actions or inventory changes. The panel log and metrics show current damage, EXP and resources.

### Castle Event: Auto Battle Extras

On the Castle Event page, **Tampermonkey Auto Battle Extras** manages the following independent modules:

| Module | Settings and behavior |
|---|---|
| Auto Battle Resume | Restarts the game's native Auto Battle after another module buys, consumes or chooses something. Enabled by default. |
| Status Potion Auto Use | Optional automatic use for Burned, Frozen and/or Poisoned status. It can be restricted to active battles. Disabled by default; all three statuses and battle-only use are preselected. |
| Power Target List | Up to ten powers in priority order. It collects useful target stacks, upgrades lower rarities and can skip a reward when no useful selected power is offered. Enabled by default with an empty target list and automatic skipping enabled, so configure it before starting a Castle run. |
| Shrine Event Picker | Enables Cleanse, Chalice and Bless individually, assigns priorities, sets the healing HP threshold and defines status names ignored by Cleanse. Enabled by default with Cleanse → Chalice → Bless priority and a 50% healing threshold. |
| Portrait Trial Picker | Selects answer 1 through 4, counted from top to bottom. Enabled by default with answer 1. |
| Hungry Merchant Picker | Selects which of the first four offers to buy and whether to continue afterward. Offer positions are remembered even if the list changes. Enabled by default, with no offers selected. |
| Cursed Mirror Picker | Chooses Fight or Walk Away. A fight can remain manual or start native Auto Battle automatically. Enabled by default with Fight and Auto Battle selected. |
| Whispering Door Picker | Chooses the Black, Crimson or Silver Door. Enabled by default with Silver selected. |
| Small Blood Potion Auto Use | Optionally uses a potion when current HP is no greater than the last recorded monster retaliation damage. It can be restricted to battles and reset remembered damage after a kill. Disabled by default; battle-only use and reset-on-kill are preselected. |

Each module also provides **Check now** for a manual test. These Castle Event controls are separate from the main scheduler.

## Additional always-on helpers

- Adventurer's Guild quest cards are aligned for easier use.
- The battle side drawer is made scrollable and leaves room for the chat button.
- Scheduled activities return to the Home page after they finish.
- Scheduler ownership is limited to one tab. If **Another tab is controlling the scheduler** appears, close or stop the other Veyra tab and wait briefly, or reload the tab you want to use.

## Notes

- Castle of the Fallen Prince and Crucible remain available in this version.
- Shadowbridge Warrens automation, its status window and its settings are not included.
- Expedition automation and Dragoncall Coin automation are separate userscripts and are not part of this Community Version.
- Some actions consume stamina, dungeon entries, items, or other game resources. Review the settings before enabling an activity.
- Background tabs may be slowed or suspended by the browser. Keeping the tab visible prevents most delays.
- After updating the script, reload the game tab.
