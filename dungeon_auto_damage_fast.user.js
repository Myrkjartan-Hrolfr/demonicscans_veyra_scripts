// ==UserScript==
// @name         Dungeon Auto-Damage (Fast)
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Faster auto-damage with cached state, fewer page requests, and optimized dungeon scanning
// @author       Myrkjartan Hrolfr based on work of [J4F] RacletteCestLavie + performance refactor
// @require      https://raw.githubusercontent.com/koenrad/veyra-hud/refs/heads/main/src/veyra-hud-core.js
// @match        https://demonicscans.org/guild_dungeon_instance.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=demonicscans.org
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    "use strict";

    const MAX_RATE_RETRIES = 5;
    const DASH_VERIFY_EVERY = 5;
    const BATTLE_VERIFY_EVERY = 20;
    const SCAN_CACHE_MS = 30_000;

    const MONSTER_CONFIG = Object.freeze({
        // High demand monsters
        "Talla Flint-Stem": { imposed_damage_limit: 9_000_000, demand: "high" },
        "Gribble Junk-Magus": { imposed_damage_limit: 1_000_000, demand: "high" },
        "Pip Tanglefoot": { imposed_damage_limit: 10_000_000, demand: "high" },
        "Rukka The Wolf Raider": {
            imposed_damage_limit: 10_000_000,
            demand: "high",
        },
        "Gorvash the Stone-Ram": {
            imposed_damage_limit: 10_000_000,
            demand: "high",
        },

        // Medium demand monsters
        "Droknar Night-Blade": { imposed_damage_limit: 4_000_000 },
        "Nib Wickfingers": { imposed_damage_limit: 6_000_000 },
        "Shagra Bone-Singer": { imposed_damage_limit: 4_000_000 },
        "Vorga Ash-Shaman": { imposed_damage_limit: 4_000_000 },

        // Low demand monsters
        "Brog Skull": { imposed_damage_limit: 3_000_000 },
        "Hruk Forge-Eater": { imposed_damage_limit: 3_000_000 },
        "Krak One-Horn": { imposed_damage_limit: 3_000_000 },
        "Makra the Mireborn": { imposed_damage_limit: 3_000_000 },
        "Orc Stone-Rend ": { imposed_damage_limit: 3_000_000 },
        "Skrit Gear": { imposed_damage_limit: 3_000_000 },
        "Tharka Blood-Howl": { imposed_damage_limit: 3_000_000 },
        "Urzul Iron-Tusks": { imposed_damage_limit: 3_000_000 },
        "Zorgra Frost-Vein": { imposed_damage_limit: 3_000_000 },
    });

    const Skills = Object.freeze({
        slash: { id: "0", cost: 1, name: "Slash" },
        "power slash": { id: "-1", cost: 10, name: "Power Slash" },
        "heroic slash": { id: "-2", cost: 50, name: "Heroic Slash" },
        "ultimate slash": { id: "-3", cost: 100, name: "Ultimate Slash" },
        "legendary slash": { id: "-4", cost: 200, name: "Legendary Slash" },
    });

    const JOIN_URL = "/dungeon_join_battle.php";
    const ATTACK_URL = "/damage.php";
    const SESSION_KEY = "dungeon-auto-damage:activeSession";

    let autoResuming = false;
    let cachedUserIdPromise = null;
    let dungeonScanCache = {
        instanceId: null,
        timestamp: 0,
        monsterTypes: null,
    };

    function normalizeMonsterName(name) {
        return (name || "").toLowerCase().trim();
    }

    function parseNumber(value) {
        if (value === null || value === undefined) return null;

        const parsed = Number(
            String(value).replace(/[^\d]/g, ""),
        );

        return Number.isFinite(parsed) ? parsed : null;
    }

    function toFiniteNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function parseStatPair(text) {
        const match = String(text || "").match(
            /([\d,]+)\s*\/\s*([\d,]+)/,
        );

        if (!match) {
            return {
                current: null,
                max: null,
            };
        }

        return {
            current: parseNumber(match[1]),
            max: parseNumber(match[2]),
        };
    }

    function formatNumber(num) {
        if (num === null || num === undefined) return "0";
        return Number(num).toLocaleString("en-US");
    }

    function escapeHtml(value) {
        if (!value) return "";

        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function getCachedUserId() {
        if (!cachedUserIdPromise) {
            cachedUserIdPromise = Promise.resolve(getUserId())
                .then((id) => {
                    if (!id) {
                        cachedUserIdPromise = null;
                    }

                    return id;
                })
                .catch((error) => {
                    cachedUserIdPromise = null;
                    throw error;
                });
        }

        return cachedUserIdPromise;
    }

    async function waitUntil(timestamp) {
        const remaining = timestamp - performance.now();

        if (remaining > 0) {
            await sleep(remaining);
        }
    }

    async function mapWithConcurrency(items, limit, mapper) {
        const results = new Array(items.length);
        let nextIndex = 0;

        async function worker() {
            while (true) {
                const index = nextIndex++;

                if (index >= items.length) {
                    return;
                }

                results[index] = await mapper(
                    items[index],
                    index,
                );
            }
        }

        const workerCount = Math.min(
            Math.max(1, limit),
            items.length,
        );

        await Promise.all(
            Array.from(
                { length: workerCount },
                () => worker(),
            ),
        );

        return results;
    }

    function getSelectedSkill() {
        const useAsterion = Storage.get(
            "ui-improvements:useAsterion",
            false,
        );

        const asterionMultiplier = parseFloat(
            Storage.get(
                "ui-improvements:asterionValue",
                1.5,
            ),
        );

        const skillKey = Storage.get(
            "dungeon-auto-damage:skill",
            "slash",
        );

        const skill = Skills[skillKey] ?? Skills.slash;

        const staminaCost = useAsterion
            ? Math.ceil(skill.cost * asterionMultiplier)
            : skill.cost;

        return {
            skill,
            staminaCost,
        };
    }

    const DEFAULT_DAMAGE_BY_MONSTER = new Map(
        Object.entries(MONSTER_CONFIG)
            .filter(([, cfg]) => cfg.imposed_damage_limit > 0)
            .map(([name, cfg]) => [
                normalizeMonsterName(name),
                cfg.imposed_damage_limit,
            ]),
    );

    const MONSTER_CONFIG_ORDER = new Map(
        Object.keys(MONSTER_CONFIG).map(
            (name, index) => [
                normalizeMonsterName(name),
                index,
            ],
        ),
    );

    const HIGH_DEMAND_MONSTERS = new Set(
        Object.entries(MONSTER_CONFIG)
            .filter(([, cfg]) => cfg.demand === "high")
            .map(([name]) => normalizeMonsterName(name)),
    );

    // ---------------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------------

    const {
        container: enableAutoDamageToggle,
    } = createSettingsInput({
        key: "dungeon-auto-damage:enabled",
        label: "Enable Auto-Damage",
        defaultValue: false,
        type: "checkbox",
        inputProps: {
            slider: true,
        },
    });

    const {
        container: attackCooldownContainer,
    } = createSettingsInput({
        key: "dungeon-auto-damage:attackCooldown",
        label: "Attack Cooldown (ms)",
        defaultValue: 1050,
        type: "number",
        inputProps: {
            min: 500,
            max: 5000,
            style: {
                width: "100px",
            },
        },
    });

    const {
        container: stopOnLevelUpToggle,
    } = createSettingsInput({
        key: "dungeon-auto-damage:stopOnLevelUp",
        label: "Stop On Level Up",
        defaultValue: true,
        type: "checkbox",
        inputProps: {
            slider: true,
        },
    });

    const {
        container: respectStaminaToggle,
    } = createSettingsInput({
        key: "dungeon-auto-damage:respectStamina",
        label: "Respect Stamina Limit",
        defaultValue: true,
        type: "checkbox",
        inputProps: {
            slider: true,
        },
    });

    const {
        container: minStaminaContainer,
    } = createSettingsInput({
        key: "dungeon-auto-damage:minStamina",
        label: "Min Stamina To Continue",
        defaultValue: 50,
        type: "number",
        inputProps: {
            min: 0,
            max: 1000,
            style: {
                width: "100px",
            },
        },
        containerProps: {
            style: {
                display: Storage.get(
                    "dungeon-auto-damage:respectStamina",
                    true,
                )
                    ? "flex"
                    : "none",
            },
        },
    });

    const {
        container: useHPPotsToggle,
    } = createSettingsInput({
        key: "dungeon-auto-damage:useHPPots",
        label: "Use HP Pots When Low",
        defaultValue: true,
        type: "checkbox",
        inputProps: {
            slider: true,
        },
    });

    const {
        container: minHPContainer,
    } = createSettingsInput({
        key: "dungeon-auto-damage:minHPPercent",
        label: "Min HP % to Use Pot",
        defaultValue: 10,
        type: "number",
        inputProps: {
            min: 0,
            max: 50,
            style: {
                width: "100px",
            },
        },
        containerProps: {
            style: {
                display: Storage.get(
                    "dungeon-auto-damage:useHPPots",
                    true,
                )
                    ? "flex"
                    : "none",
            },
        },
    });

    useHPPotsToggle.addEventListener(
        "change",
        (event) => {
            minHPContainer.style.display =
                event.target.checked
                    ? "flex"
                    : "none";
        },
    );

    respectStaminaToggle.addEventListener(
        "change",
        (event) => {
            minStaminaContainer.style.display =
                event.target.checked
                    ? "flex"
                    : "none";
        },
    );

    const {
        container: skillSelectContainer,
    } = createSettingsInput({
        key: "dungeon-auto-damage:skill",
        label: "Attack Skill",
        defaultValue: "slash",
        type: "select",
        options: Object.entries(Skills).map(
            ([key, skill]) => ({
                value: key,
                label: `${skill.name} (${skill.cost} stamina)`,
            }),
        ),
    });

    const {
        container: enableClearAllToggle,
    } = createSettingsInput({
        key: "dungeon-auto-damage:enableClearAll",
        label: "Enable Clear All Monsters Button",
        defaultValue: false,
        type: "checkbox",
        inputProps: {
            slider: true,
        },
    });

    addSettingsGroup(
        "dungeon-auto-damage",
        "Auto-Damage Settings",
        "Automatically attack dungeon monsters until damage targets are reached",
        [
            enableAutoDamageToggle,
            enableClearAllToggle,
            skillSelectContainer,
            attackCooldownContainer,
            stopOnLevelUpToggle,
            respectStaminaToggle,
            minStaminaContainer,
            useHPPotsToggle,
            minHPContainer,
        ],
    );

    // ---------------------------------------------------------------------------
    // Network and page parsing
    // ---------------------------------------------------------------------------

    async function getGameDashData() {
        const doc = await internalFetch(
            "/game_dash.php",
        );

        const stamina = parseNumber(
            doc.querySelector("#stamina_span")
                ?.textContent,
        );

        let expToLevel = null;

        const expText = doc.querySelector(
            ".gtb-exp-top span:last-child",
        )?.textContent;

        const expMatch = String(
            expText || "",
        ).match(
            /([\d,]+)\s*\/\s*([\d,]+)/,
        );

        if (expMatch) {
            const current = parseNumber(
                expMatch[1],
            );

            const total = parseNumber(
                expMatch[2],
            );

            if (
                current !== null &&
                total !== null
            ) {
                expToLevel = Math.max(
                    0,
                    total - current,
                );
            }
        }

        return {
            stamina,
            expToLevel,
        };
    }

    async function useHPPot() {
        const userId = await getCachedUserId();

        if (!userId) {
            return {
                ok: false,
                msg: "Missing userId",
            };
        }

        const params = new URLSearchParams();
        params.set("user_id", userId);

        try {
            const res = await fetch(
                "/user_heal_potion.php",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/x-www-form-urlencoded",
                    },
                    body: params.toString(),
                    credentials: "same-origin",
                },
            );

            const raw = await res.text();
            let data = null;

            try {
                data = JSON.parse(raw);
            } catch {
                // Non-JSON response is allowed.
            }

            const ok =
                res.ok ||
                data?.status === "success";

            const msg =
                data?.message ||
                raw.slice(0, 200) ||
                (
                    ok
                        ? "Healed"
                        : `HTTP ${res.status}`
                );

            if (ok) {
                showNotification(
                    "❤️ Used HP Pot!",
                    "success",
                );
            } else {
                showNotification(
                    `HP Pot failed: ${msg}`,
                    "error",
                );
            }

            return {
                ok,
                msg,
                data,
                raw,
            };
        } catch (error) {
            return {
                ok: false,
                msg: error.message,
            };
        }
    }

    async function checkAndUseHPPotIfNeeded(
        settings,
        result,
        currentHp = null,
        maxHp = null,
    ) {
        const usePots = Boolean(
            settings.useHPPots,
        );

        const minHP = toFiniteNumber(
            settings.minHPPercent,
            10,
        );

        if (
            !usePots ||
            currentHp === null
        ) {
            return true;
        }

        if (currentHp <= 0) {
            return false;
        }

        const hpPercent =
            maxHp > 0
                ? Math.round(
                    (currentHp / maxHp) * 100,
                )
                : 100;

        if (hpPercent > minHP) {
            return true;
        }

        const potResult = await useHPPot();

        if (potResult.ok) {
            if (result) {
                result.hpPotsUsed++;
            }

            return true;
        }

        const healBtn =
            document.getElementById("healBtn");

        if (!healBtn) {
            return false;
        }

        try {
            healBtn.click();
            return true;
        } catch {
            return false;
        }
    }

    function getInstanceId() {
        const urlParams =
            new URLSearchParams(
                window.location.search,
            );

        const urlId =
            urlParams.get("id");

        if (urlId) {
            return urlId;
        }

        const titleMatch =
            document.title.match(
                /Instance #(\d+)/,
            );

        if (titleMatch) {
            return titleMatch[1];
        }

        const locLink =
            document.querySelector(
                "a[href*='guild_dungeon_location.php']",
            );

        if (!locLink) {
            return null;
        }

        const href =
            locLink.getAttribute("href") || "";

        const query =
            href.includes("?")
                ? href.split("?")[1]
                : "";

        return new URLSearchParams(
            query,
        ).get("instance_id");
    }

    function parseMonsterCards(
        locationPage,
        location,
    ) {
        const monsters = [];

        for (
            const card of
            locationPage.querySelectorAll(".mon")
        ) {
            const nameEl =
                card.querySelector(
                    ".monster-name, .name",
                ) ||
                card.querySelector(
                    '[style*="font-weight:700"]',
                ) ||
                card.querySelector(
                    '[style*="font-weight: 700"]',
                );

            const link =
                card.querySelector(
                    "a[href*='battle.php'], a[href*='dgmid']",
                );

            if (!nameEl || !link) {
                continue;
            }

            let name =
                nameEl.textContent.trim();

            for (
                const child of
                nameEl.querySelectorAll("*")
            ) {
                name = name
                    .replace(
                        child.textContent,
                        "",
                    )
                    .trim();
            }

            name = name
                .replace(/\s+/g, " ")
                .trim();

            if (!name) {
                name =
                    card.querySelector("img")
                        ?.alt?.trim() || "";
            }

            if (!name) {
                continue;
            }

            const href =
                link.getAttribute("href") || "";

            const query =
                href.includes("?")
                    ? href.split("?")[1]
                    : "";

            const monsterId =
                new URLSearchParams(
                    query,
                ).get("dgmid");

            if (!monsterId) {
                continue;
            }

            monsters.push({
                id: monsterId,
                location,
                href,
                name,
            });
        }

        return monsters;
    }

    async function getDungeonMonsterTypes(
        instanceId,
        options = {},
    ) {
        const force =
            Boolean(options.force);

        const cacheIsFresh =
            !force &&
            dungeonScanCache.instanceId ===
            instanceId &&
            dungeonScanCache.monsterTypes &&
            Date.now() -
            dungeonScanCache.timestamp <
            SCAN_CACHE_MS;

        if (cacheIsFresh) {
            return dungeonScanCache.monsterTypes;
        }

        let locations = [];

        try {
            const instancePage =
                await internalFetch(
                    `/guild_dungeon_instance.php?id=${instanceId}`,
                );

            locations = Array.from(
                instancePage.querySelectorAll(
                    `a[href*='guild_dungeon_location.php?instance_id=${instanceId}']`,
                ),
            )
                .map((link) => {
                    const href =
                        link.getAttribute("href") ||
                        "";

                    const query =
                        href.includes("?")
                            ? href.split("?")[1]
                            : "";

                    return new URLSearchParams(
                        query,
                    ).get("location_id");
                })
                .filter(Boolean);
        } catch (error) {
            console.warn(
                "[Auto-Damage] Could not scan instance page for locations:",
                error,
            );
        }

        if (locations.length === 0) {
            locations = [
                "1",
                "2",
                "3",
                "4",
            ];
        }

        locations = [
            ...new Set(locations),
        ];

        const locationResults =
            await Promise.allSettled(
                locations.map(
                    async (location) => {
                        const page =
                            await internalFetch(
                                `/guild_dungeon_location.php?instance_id=${instanceId}&location_id=${location}`,
                            );

                        return {
                            location,
                            page,
                        };
                    },
                ),
            );

        const monsterTypes = new Map();

        for (
            const locationResult of
            locationResults
        ) {
            if (
                locationResult.status !==
                "fulfilled"
            ) {
                console.error(
                    "[Auto-Damage] Error scanning dungeon location:",
                    locationResult.reason,
                );

                continue;
            }

            const {
                location,
                page,
            } = locationResult.value;

            const monsters =
                parseMonsterCards(
                    page,
                    location,
                );

            console.log(
                `[Auto-Damage] Scanned location ${location}: found ${monsters.length} monsters`,
            );

            for (const monster of monsters) {
                const normalized =
                    normalizeMonsterName(
                        monster.name,
                    );

                if (
                    !monsterTypes.has(
                        normalized,
                    )
                ) {
                    monsterTypes.set(
                        normalized,
                        {
                            name: monster.name,
                            normalized,
                            count: 0,
                            monsters: [],
                        },
                    );
                }

                const typeData =
                    monsterTypes.get(
                        normalized,
                    );

                typeData.count++;
                typeData.monsters.push(
                    monster,
                );
            }
        }

        const result = Array.from(
            monsterTypes.values(),
        );

        dungeonScanCache = {
            instanceId,
            timestamp: Date.now(),
            monsterTypes: result,
        };

        return result;
    }

    async function getMonsterCapDamage(
        monsterId,
        instanceId,
    ) {
        try {
            const battlePage =
                await internalFetch(
                    `/battle.php?dgmid=${monsterId}&instance_id=${instanceId}`,
                );

            for (
                const block of
                battlePage.querySelectorAll(
                    ".stat-block",
                )
            ) {
                const label =
                    block.querySelector(
                        ".label",
                    );

                if (
                    !label ||
                    label.textContent.trim() !==
                    "EXP Cap"
                ) {
                    continue;
                }

                const noteDiv =
                    block.querySelector(
                        ":scope > div:not(.label)",
                    );

                const match =
                    noteDiv?.textContent.match(
                        /deal\s*~?([\d,]+)\s*dmg/i,
                    );

                if (match) {
                    return parseNumber(
                        match[1],
                    );
                }
            }
        } catch (error) {
            console.error(
                `[Auto-Damage] Error getting cap damage for monster ${monsterId}:`,
                error,
            );
        }

        return null;
    }

    async function getBattleSnapshot(
        instanceId,
        monsterId,
        userId = null,
    ) {
        const page =
            await internalFetch(
                `/battle.php?dgmid=${monsterId}&instance_id=${instanceId}`,
            );

        const card =
            page.querySelector(
                `[data-monster-id="${monsterId}"]`,
            );

        const monsterHp =
            parseStatPair(
                page.querySelector(
                    ".monster-hp .stat-value",
                )?.textContent,
            );

        const userHp =
            parseStatPair(
                page.querySelector(
                    "#pHpText",
                )?.textContent,
            );

        let currentDamage = 0;

        if (
            userId !== null &&
            userId !== undefined
        ) {
            for (
                const row of
                page.querySelectorAll(
                    ".lb-list .lb-row",
                )
            ) {
                const link =
                    row.querySelector(
                        ".lb-name a",
                    );

                if (!link) {
                    continue;
                }

                const href =
                    link.getAttribute("href") ||
                    "";

                const query =
                    href.includes("?")
                        ? href.split("?")[1]
                        : "";

                const pid =
                    new URLSearchParams(
                        query,
                    ).get("pid");

                if (
                    String(pid) !==
                    String(userId)
                ) {
                    continue;
                }

                currentDamage =
                    parseNumber(
                        row.querySelector(
                            ".lb-dmg",
                        )?.textContent,
                    ) || 0;

                break;
            }
        }

        return {
            joined:
                card?.dataset.joined === "1",
            currentDamage,
            monsterHp:
                monsterHp.current,
            monsterMaxHp:
                monsterHp.max,
            userHp:
                userHp.current,
            userMaxHp:
                userHp.max,
        };
    }

    async function doJoin(
        monsterId,
        instanceId,
    ) {
        const userId =
            await getCachedUserId();

        if (!userId) {
            return {
                ok: false,
                msg: "Missing userId",
            };
        }

        const params =
            new URLSearchParams();

        params.set(
            "instance_id",
            instanceId,
        );

        params.set(
            "dgmid",
            monsterId,
        );

        params.set(
            "user_id",
            userId,
        );

        const res = await fetch(
            JOIN_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },
                body: params.toString(),
                credentials: "same-origin",
            },
        );

        const raw = await res.text();
        let data = null;

        try {
            data = JSON.parse(raw);
        } catch {
            // Non-JSON response is allowed.
        }

        const ok =
            res.ok ||
            data?.status === "success";

        const msg =
            data?.message ||
            raw.slice(0, 200) ||
            (
                ok
                    ? "Joined"
                    : `HTTP ${res.status}`
            );

        return {
            ok,
            msg,
            data,
            raw,
            status: res.status,
        };
    }

    async function doAttack(
        monsterId,
        skillId,
        staminaCost,
        instanceId,
    ) {
        const params =
            new URLSearchParams();

        params.set(
            "instance_id",
            instanceId,
        );

        params.set(
            "dgmid",
            monsterId,
        );

        params.set(
            "skill_id",
            skillId,
        );

        params.set(
            "stamina_cost",
            staminaCost,
        );

        const res = await fetch(
            ATTACK_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },
                body: params.toString(),
                credentials: "same-origin",
            },
        );

        let retryAfterMs = null;

        const retryAfter =
            res.headers.get(
                "Retry-After",
            );

        if (retryAfter) {
            const seconds =
                Number.parseInt(
                    retryAfter,
                    10,
                );

            if (
                Number.isFinite(seconds) &&
                seconds > 0
            ) {
                retryAfterMs = Math.min(
                    seconds * 1000,
                    120_000,
                );
            } else {
                const retryDate =
                    Date.parse(retryAfter);

                if (
                    Number.isFinite(retryDate)
                ) {
                    retryAfterMs = Math.min(
                        Math.max(
                            0,
                            retryDate - Date.now(),
                        ),
                        120_000,
                    );
                }
            }
        }

        const raw = await res.text();
        let data = null;

        try {
            data = JSON.parse(raw);
        } catch {
            // Non-JSON response is allowed.
        }

        const ok =
            res.ok ||
            data?.status === "success";

        let damageDealt = 0;

        if (ok) {
            const message = String(
                data?.message ||
                raw ||
                "",
            );

            const strongMatch =
                message.match(
                    /<strong>\s*([\d,]+)\s*<\/strong>/i,
                );

            const plainMatch =
                message.match(
                    /(?:deal(?:t)?|damage)\D{0,20}([\d,]+)/i,
                );

            damageDealt =
                parseNumber(
                    strongMatch?.[1] ||
                    plainMatch?.[1],
                ) || 0;
        }

        return {
            ok,
            msg:
                data?.message ||
                raw.slice(0, 200),
            data,
            raw,
            damage: damageDealt,
            userHpAfter:
                parseNumber(
                    data?.retaliation
                        ?.user_hp_after,
                ),
            retryAfterMs,
            status: res.status,
        };
    }

    function isRateLimited(res) {
        if (
            res?.status === 429 ||
            res?.status === 503
        ) {
            return true;
        }

        const blob = [
            res?.msg || "",
            res?.raw || "",
            res?.data
                ? JSON.stringify(res.data)
                : "",
        ]
            .join(" ")
            .toLowerCase();

        return /rate[\s_-]?limit|too fast|too many requests|throttl|slow down|too quickly|attacking too quickly|cooling down|not ready|please wait\s+\d+/i.test(
            blob,
        );
    }

    function backoffMs(
        attemptIndex,
    ) {
        const base = 800;
        const cap = 20_000;

        return Math.min(
            cap,
            base * 2 ** attemptIndex,
        );
    }

    function isMonsterDead(res) {
        const haystack =
            `${res?.msg || ""} ` +
            `${res?.raw || ""}`;

        return /monster is already dead|monster already dead|already defeated|has been defeated/i.test(
            haystack,
        );
    }

    async function attackMonsterOnce(
        monsterId,
        skillId,
        staminaCost,
        instanceId,
    ) {
        for (
            let attempt = 0;
            attempt <
            MAX_RATE_RETRIES;
            attempt++
        ) {
            const res =
                await doAttack(
                    monsterId,
                    skillId,
                    staminaCost,
                    instanceId,
                );

            if (res.ok) {
                return res;
            }

            if (isMonsterDead(res)) {
                return {
                    ...res,
                    monsterDead: true,
                };
            }

            if (
                isRateLimited(res) &&
                attempt <
                MAX_RATE_RETRIES - 1
            ) {
                const waitMs =
                    res.retryAfterMs ||
                    backoffMs(attempt);

                console.log(
                    `[Auto-Damage] Rate limited, retrying in ${waitMs} ms`,
                );

                await sleep(waitMs);
                continue;
            }

            if (
                !isRateLimited(res) &&
                attempt <
                MAX_RATE_RETRIES - 1
            ) {
                console.log(
                    `[Auto-Damage] Attack failed, rejoining before retry: ${res.msg}`,
                );

                const joinRes =
                    await doJoin(
                        monsterId,
                        instanceId,
                    );

                if (
                    isMonsterDead(joinRes)
                ) {
                    return {
                        ...res,
                        monsterDead: true,
                        damage: 0,
                    };
                }

                if (!joinRes.ok) {
                    return res;
                }

                continue;
            }

            return res;
        }

        return {
            ok: false,
            msg: "Max retries exceeded",
            damage: 0,
            status: 0,
        };
    }

    async function waitIfPaused(
        runState,
    ) {
        while (
            runState.paused &&
            !runState.stopped
        ) {
            await sleep(300);
        }

        return !runState.stopped;
    }

    // ---------------------------------------------------------------------------
    // Optimized attack loops
    // ---------------------------------------------------------------------------

    async function autoDamageMonster(
        monster,
        targetDamage,
        instanceId,
        settings,
        runState,
    ) {
        const {
            id: monsterId,
            name,
        } = monster;

        const {
            skill,
            staminaCost,
        } = getSelectedSkill();

        const attackCooldown =
            Number(
                settings.attackCooldown,
            ) || 1050;

        const minStamina =
            Number(
                settings.minStamina,
            ) || 0;

        const respectStamina =
            Boolean(
                settings.respectStamina,
            );

        const stopOnLevelUp =
            Boolean(
                settings.stopOnLevelUp,
            );

        const userId =
            await getCachedUserId();

        const result = {
            monsterId,
            name,
            targetDamage,
            initialDamage: 0,
            finalDamage: 0,
            damageDealt: 0,
            attacks: 0,
            staminaUsed: 0,
            hpPotsUsed: 0,
            completed: false,
            msg: "",
        };

        let battleState =
            await getBattleSnapshot(
                instanceId,
                monsterId,
                userId,
            );

        let currentDamage =
            battleState.currentDamage ||
            0;

        let remainingDamage =
            targetDamage -
            currentDamage;

        result.initialDamage =
            currentDamage;

        result.finalDamage =
            currentDamage;

        if (
            remainingDamage <= 0
        ) {
            result.completed = true;

            result.msg =
                `Already at target ` +
                `(${formatNumber(currentDamage)})`;

            return result;
        }

        if (
            battleState.monsterHp !==
            null &&
            battleState.monsterHp <= 0
        ) {
            result.completed = true;
            result.skipDash = true;
            result.msg =
                "Monster already dead";

            return result;
        }

        if (!battleState.joined) {
            const joinRes =
                await doJoin(
                    monsterId,
                    instanceId,
                );

            if (
                isMonsterDead(joinRes)
            ) {
                result.completed = true;
                result.skipDash = true;
                result.msg =
                    "Monster already dead";

                return result;
            }

            if (!joinRes.ok) {
                result.msg =
                    `Join failed: ` +
                    `${joinRes.msg}`;

                return result;
            }
        }

        let trackedStamina = null;
        let expToLevel = null;
        let attacksSinceDashCheck = 0;
        let lastHpAfter =
            battleState.userHp;
        let lastMaxHp =
            battleState.userMaxHp;
        let consecutive400s = 0;
        let consecutiveZeroDamage = 0;
        let resolved = false;

        async function refreshDashboard() {
            const dashboard =
                await getGameDashData();

            trackedStamina =
                dashboard.stamina;

            expToLevel =
                dashboard.expToLevel;

            attacksSinceDashCheck = 0;
        }

        if (
            respectStamina ||
            stopOnLevelUp
        ) {
            await refreshDashboard();
        }

        while (
            remainingDamage > 0 &&
            !runState.stopped
        ) {
            const wasPaused =
                runState.paused;

            if (
                !(await waitIfPaused(
                    runState,
                ))
            ) {
                result.msg =
                    "Stopped by user";

                resolved = true;
                break;
            }

            if (wasPaused) {
                runState.onResume?.();

                if (
                    respectStamina ||
                    stopOnLevelUp
                ) {
                    await refreshDashboard();
                }
            }

            const hpPercent =
                lastHpAfter !== null &&
                    lastMaxHp > 0
                    ? Math.round(
                        (
                            lastHpAfter /
                            lastMaxHp
                        ) * 100,
                    )
                    : null;

            const potWasNeeded =
                Boolean(
                    settings.useHPPots,
                ) &&
                hpPercent !== null &&
                hpPercent <=
                toFiniteNumber(
                    settings.minHPPercent,
                    10,
                );

            const hpOk =
                await checkAndUseHPPotIfNeeded(
                    settings,
                    result,
                    lastHpAfter,
                    lastMaxHp,
                );

            if (!hpOk) {
                result.msg =
                    "Stopped: No HP pots available";

                resolved = true;
                break;
            }

            if (potWasNeeded) {
                lastHpAfter = null;
            }

            if (
                stopOnLevelUp &&
                attacksSinceDashCheck >=
                DASH_VERIFY_EVERY
            ) {
                await refreshDashboard();
            }

            if (
                stopOnLevelUp &&
                expToLevel === 0
            ) {
                result.msg =
                    "Stopped: Level up detected";

                resolved = true;
                break;
            }

            if (
                respectStamina &&
                trackedStamina !== null
            ) {
                if (
                    trackedStamina <=
                    minStamina
                ) {
                    result.msg =
                        `Paused: Low stamina ` +
                        `(${trackedStamina})`;

                    showNotification(
                        `Low stamina (${trackedStamina}), paused - refill and resume.`,
                        "warning",
                    );

                    runState.paused = true;
                    runState.onPause?.();

                    continue;
                }

                if (
                    trackedStamina <
                    staminaCost
                ) {
                    result.msg =
                        `Paused: Not enough stamina ` +
                        `(need ${staminaCost}, have ${trackedStamina})`;

                    showNotification(
                        `Not enough stamina (${trackedStamina}/${staminaCost}), paused - refill and resume.`,
                        "warning",
                    );

                    runState.paused = true;
                    runState.onPause?.();

                    continue;
                }
            }

            const attackRes =
                await attackMonsterOnce(
                    monsterId,
                    skill.id,
                    staminaCost,
                    instanceId,
                );

            const cooldownUntil =
                performance.now() +
                attackCooldown;

            if (
                attackRes.monsterDead
            ) {
                result.msg =
                    "Monster already dead";

                result.completed = true;
                result.skipDash = true;
                resolved = true;

                break;
            }

            if (!attackRes.ok) {
                if (
                    attackRes.status === 400
                ) {
                    consecutive400s++;

                    if (
                        consecutive400s >= 3
                    ) {
                        result.msg =
                            "Attack failed: too many 400 errors";

                        resolved = true;
                        break;
                    }

                    await waitUntil(
                        cooldownUntil,
                    );

                    continue;
                }

                result.msg =
                    `Attack failed: ` +
                    `${attackRes.msg}`;

                resolved = true;
                break;
            }

            consecutive400s = 0;

            const damageDealt =
                Number(
                    attackRes.damage,
                ) || 0;

            result.damageDealt +=
                damageDealt;

            result.attacks++;

            result.staminaUsed +=
                staminaCost;

            currentDamage +=
                damageDealt;

            remainingDamage =
                targetDamage -
                currentDamage;

            result.finalDamage =
                currentDamage;

            if (
                attackRes.userHpAfter !==
                null
            ) {
                lastHpAfter =
                    attackRes.userHpAfter;
            }

            if (
                trackedStamina !== null
            ) {
                trackedStamina =
                    Math.max(
                        0,
                        trackedStamina -
                        staminaCost,
                    );
            }

            attacksSinceDashCheck++;

            consecutiveZeroDamage =
                damageDealt <= 0
                    ? consecutiveZeroDamage + 1
                    : 0;

            if (
                remainingDamage <= 0
            ) {
                result.completed = true;

                result.msg =
                    `Target reached ` +
                    `(${formatNumber(result.finalDamage)})`;

                resolved = true;
                break;
            }

            const shouldVerifyBattle =
                damageDealt <= 0 ||
                result.attacks %
                BATTLE_VERIFY_EVERY ===
                0;

            if (shouldVerifyBattle) {
                try {
                    battleState =
                        await getBattleSnapshot(
                            instanceId,
                            monsterId,
                            userId,
                        );

                    lastHpAfter =
                        battleState.userHp ??
                        lastHpAfter;

                    lastMaxHp =
                        battleState.userMaxHp ??
                        lastMaxHp;

                    if (
                        battleState.currentDamage >
                        currentDamage
                    ) {
                        currentDamage =
                            battleState.currentDamage;

                        remainingDamage =
                            targetDamage -
                            currentDamage;

                        result.finalDamage =
                            currentDamage;

                        result.damageDealt =
                            currentDamage -
                            result.initialDamage;

                        consecutiveZeroDamage = 0;
                    }

                    if (
                        battleState.monsterHp !==
                        null &&
                        battleState.monsterHp <= 0
                    ) {
                        result.completed = true;
                        result.skipDash = true;
                        result.msg =
                            "Monster defeated";

                        resolved = true;
                        break;
                    }

                    if (
                        remainingDamage <= 0
                    ) {
                        result.completed = true;

                        result.msg =
                            `Target reached ` +
                            `(${formatNumber(currentDamage)})`;

                        resolved = true;
                        break;
                    }
                } catch (error) {
                    console.warn(
                        `[Auto-Damage] Battle verification failed for ${monsterId}:`,
                        error,
                    );
                }
            }

            if (
                consecutiveZeroDamage >= 3
            ) {
                result.msg =
                    "Stopped: attack damage could not be determined";

                resolved = true;
                break;
            }

            await waitUntil(
                cooldownUntil,
            );
        }

        if (
            !resolved &&
            runState.stopped
        ) {
            result.msg =
                "Stopped by user";
        } else if (
            !resolved &&
            remainingDamage <= 0
        ) {
            result.completed = true;

            result.msg =
                `Target reached ` +
                `(${formatNumber(result.finalDamage)})`;
        }

        return result;
    }

    async function clearAllMonsters(
        instanceId,
        runState,
        allMonsters,
    ) {
        const settings = {
            useHPPots: Storage.get(
                "dungeon-auto-damage:useHPPots",
                true,
            ),
            minHPPercent: Storage.get(
                "dungeon-auto-damage:minHPPercent",
                10,
            ),
            attackCooldown: Storage.get(
                "dungeon-auto-damage:attackCooldown",
                1050,
            ),
            respectStamina: Storage.get(
                "dungeon-auto-damage:respectStamina",
                true,
            ),
            minStamina: Storage.get(
                "dungeon-auto-damage:minStamina",
                50,
            ),
        };

        const {
            skill,
            staminaCost,
        } = getSelectedSkill();

        const attackCooldown =
            Number(
                settings.attackCooldown,
            ) || 1050;

        const minStamina =
            Number(
                settings.minStamina,
            ) || 0;

        const userId =
            await getCachedUserId();

        const statusEl =
            document.getElementById(
                "clearAllStatus",
            );

        let trackedStamina = null;
        let attacksSinceDashCheck = 0;

        async function refreshDashboard() {
            const dashboard =
                await getGameDashData();

            trackedStamina =
                dashboard.stamina;

            attacksSinceDashCheck = 0;
        }

        if (
            settings.respectStamina
        ) {
            await refreshDashboard();
        }

        showNotification(
            `Clearing ${allMonsters.length} monsters...`,
            "info",
        );

        for (
            let monIndex = 0;
            monIndex <
            allMonsters.length;
            monIndex++
        ) {
            if (
                runState.stopped ||
                !(await waitIfPaused(
                    runState,
                ))
            ) {
                break;
            }

            const monster =
                allMonsters[monIndex];

            if (statusEl) {
                statusEl.textContent =
                    `Attacking: ${monster.name} ` +
                    `(${monIndex + 1}/${allMonsters.length})...`;
            }

            try {
                let snapshot =
                    await getBattleSnapshot(
                        instanceId,
                        monster.id,
                        userId,
                    );

                if (
                    snapshot.monsterHp !==
                    null &&
                    snapshot.monsterHp <= 0
                ) {
                    continue;
                }

                if (!snapshot.joined) {
                    const joinRes =
                        await doJoin(
                            monster.id,
                            instanceId,
                        );

                    if (
                        isMonsterDead(joinRes)
                    ) {
                        continue;
                    }

                    if (!joinRes.ok) {
                        console.warn(
                            `[Auto-Damage] Join failed for ${monster.name}: ${joinRes.msg}`,
                        );

                        continue;
                    }
                }

                let isDead = false;

                let lastHpAfter =
                    snapshot.userHp;

                let lastMaxHp =
                    snapshot.userMaxHp;

                let trackedDamage =
                    snapshot.currentDamage ||
                    0;

                let attacksOnMonster = 0;
                let consecutive400s = 0;
                let consecutiveZeroDamage = 0;

                while (
                    !runState.stopped &&
                    !isDead
                ) {
                    const wasPaused =
                        runState.paused;

                    if (
                        !(await waitIfPaused(
                            runState,
                        ))
                    ) {
                        break;
                    }

                    if (wasPaused) {
                        runState.onResume?.();

                        if (
                            settings.respectStamina
                        ) {
                            await refreshDashboard();
                        }
                    }

                    const hpPercent =
                        lastHpAfter !== null &&
                            lastMaxHp > 0
                            ? Math.round(
                                (
                                    lastHpAfter /
                                    lastMaxHp
                                ) * 100,
                            )
                            : null;

                    const potWasNeeded =
                        settings.useHPPots &&
                        hpPercent !== null &&
                        hpPercent <=
                        toFiniteNumber(
                            settings.minHPPercent,
                            10,
                        );

                    const hpOk =
                        await checkAndUseHPPotIfNeeded(
                            settings,
                            null,
                            lastHpAfter,
                            lastMaxHp,
                        );

                    if (!hpOk) {
                        showNotification(
                            "No HP pots available, stopping clear",
                            "error",
                        );

                        runState.stopped = true;
                        break;
                    }

                    if (potWasNeeded) {
                        lastHpAfter = null;
                    }

                    if (
                        settings.respectStamina &&
                        attacksSinceDashCheck >=
                        DASH_VERIFY_EVERY
                    ) {
                        await refreshDashboard();
                    }

                    if (
                        settings.respectStamina &&
                        trackedStamina !== null
                    ) {
                        if (
                            trackedStamina <=
                            minStamina
                        ) {
                            showNotification(
                                `Low stamina (${trackedStamina}), paused - refill and resume.`,
                                "warning",
                            );

                            runState.paused = true;
                            runState.onPause?.();

                            continue;
                        }

                        if (
                            trackedStamina <
                            staminaCost
                        ) {
                            showNotification(
                                `Not enough stamina (${trackedStamina}/${staminaCost}), paused - refill and resume.`,
                                "warning",
                            );

                            runState.paused = true;
                            runState.onPause?.();

                            continue;
                        }
                    }

                    const attackRes =
                        await attackMonsterOnce(
                            monster.id,
                            skill.id,
                            staminaCost,
                            instanceId,
                        );

                    const cooldownUntil =
                        performance.now() +
                        attackCooldown;

                    if (
                        attackRes.monsterDead
                    ) {
                        isDead = true;
                        break;
                    }

                    if (!attackRes.ok) {
                        if (
                            attackRes.status ===
                            400
                        ) {
                            consecutive400s++;

                            if (
                                consecutive400s >= 3
                            ) {
                                break;
                            }

                            await waitUntil(
                                cooldownUntil,
                            );

                            continue;
                        }

                        console.warn(
                            `[Auto-Damage] Attack failed for ${monster.name}: ${attackRes.msg}`,
                        );

                        break;
                    }

                    consecutive400s = 0;
                    attacksOnMonster++;
                    attacksSinceDashCheck++;

                    if (
                        trackedStamina !== null
                    ) {
                        trackedStamina =
                            Math.max(
                                0,
                                trackedStamina -
                                staminaCost,
                            );
                    }

                    if (
                        attackRes.userHpAfter !==
                        null
                    ) {
                        lastHpAfter =
                            attackRes.userHpAfter;
                    }

                    trackedDamage +=
                        Number(
                            attackRes.damage,
                        ) || 0;

                    consecutiveZeroDamage =
                        attackRes.damage <= 0
                            ? consecutiveZeroDamage +
                            1
                            : 0;

                    const shouldVerifyBattle =
                        attackRes.damage <= 0 ||
                        attacksOnMonster %
                        BATTLE_VERIFY_EVERY ===
                        0;

                    if (
                        shouldVerifyBattle
                    ) {
                        try {
                            snapshot =
                                await getBattleSnapshot(
                                    instanceId,
                                    monster.id,
                                    userId,
                                );

                            lastHpAfter =
                                snapshot.userHp ??
                                lastHpAfter;

                            lastMaxHp =
                                snapshot.userMaxHp ??
                                lastMaxHp;

                            if (
                                snapshot.currentDamage >
                                trackedDamage
                            ) {
                                trackedDamage =
                                    snapshot.currentDamage;

                                consecutiveZeroDamage = 0;
                            }

                            if (
                                snapshot.monsterHp !==
                                null &&
                                snapshot.monsterHp <=
                                0
                            ) {
                                isDead = true;
                                break;
                            }
                        } catch (error) {
                            console.warn(
                                `[Auto-Damage] Battle verification failed for ${monster.id}:`,
                                error,
                            );
                        }
                    }

                    if (
                        consecutiveZeroDamage >=
                        3
                    ) {
                        console.warn(
                            `[Auto-Damage] Could not determine damage for ${monster.name}, skipping`,
                        );

                        break;
                    }

                    await waitUntil(
                        cooldownUntil,
                    );
                }
            } catch (error) {
                console.error(
                    `[Auto-Damage] Error clearing ${monster.name}:`,
                    error,
                );
            }
        }

        if (statusEl) {
            statusEl.textContent =
                runState.stopped
                    ? "Stopped."
                    : "Complete!";
        }

        if (!runState.stopped) {
            showNotification(
                "Clear all monsters complete",
                "success",
            );
        }
    }

    // ---------------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------------

    GM_addStyle(`
    .auto-damage-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      z-index: 99999;
      align-items: center;
      justify-content: center;
    }

    .auto-damage-modal.open {
      display: flex;
    }

    .auto-damage-content {
      background: #1a1b25;
      border-radius: 16px;
      padding: 24px;
      width: 90%;
      max-width: 600px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
      border: 1px solid #2b2d44;
    }

    .auto-damage-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .auto-damage-title {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
    }

    .auto-damage-close {
      background: none;
      border: none;
      color: #9aa0be;
      font-size: 24px;
      cursor: pointer;
      padding: 4px 8px;
    }

    .auto-damage-close:hover {
      color: #fff;
    }

    .monster-type-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 20px;
    }

    .monster-type-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: #24263a;
      border-radius: 10px;
      border: 1px solid #2b2d44;
    }

    .monster-type-info {
      flex: 1;
    }

    .monster-type-name {
      font-weight: 600;
      color: #e6e8ff;
      font-size: 14px;
    }

    .monster-type-count {
      font-size: 12px;
      color: #9aa0be;
    }

    .monster-type-input {
      width: 120px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid #2b2d44;
      background: #1e1e2f;
      color: #e6e8ff;
      font-size: 14px;
    }

    .auto-damage-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .btn-auto-damage {
      padding: 10px 20px;
      border-radius: 10px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-size: 14px;
    }

    .btn-auto-damage-primary {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      color: #fff;
    }

    .btn-auto-damage-secondary {
      background: #2b2d44;
      color: #e6e8ff;
    }

    .btn-auto-damage-danger {
      background: linear-gradient(135deg, #dc2626, #ef4444);
      color: #fff;
    }

    .btn-auto-damage-warning {
      background: linear-gradient(135deg, #d97706, #f59e0b);
      color: #fff;
    }

    .progress-container {
      margin-top: 16px;
      padding: 16px;
      background: #1e1e2f;
      border-radius: 10px;
      border: 1px solid #2b2d44;
      display: none;
    }

    .progress-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid #2b2d44;
      font-size: 13px;
    }

    .progress-item:last-child {
      border-bottom: none;
    }

    .progress-divider {
      border: none;
      border-top: 1px solid #2b2d44;
      margin: 8px 0;
    }

    .progress-label {
      color: #9aa0be;
    }

    .progress-value {
      color: #e6e8ff;
      font-weight: 600;
      text-align: right;
    }

    .progress-value.success {
      color: #2ecc71;
    }

    .progress-value.warning {
      color: #facc15;
    }

    .progress-value.error {
      color: #e74c3c;
    }
  `);

    function createMonsterTypeRow(
        typeData,
        onChange,
        onToggle,
        onCapToggle,
        savedValue = 0,
        enabled = true,
        isCapEnabled = false,
    ) {
        const div =
            document.createElement("div");

        div.className =
            "monster-type-item";

        if (!enabled) {
            div.style.opacity = "0.45";
        }

        div.innerHTML = `
      <input
        type="checkbox"
        class="monster-type-enabled"
        data-normalized="${escapeHtml(typeData.normalized)}"
        ${enabled ? "checked" : ""}
        style="width:16px;height:16px;cursor:pointer;flex-shrink:0;"
      >

      <div class="monster-type-info">
        <div class="monster-type-name">${escapeHtml(typeData.name)}</div>
        <div class="monster-type-count">${typeData.count} monster${typeData.count > 1 ? "s" : ""}</div>
      </div>

      <input
        type="number"
        class="monster-type-input"
        data-normalized="${escapeHtml(typeData.normalized)}"
        placeholder="Target damage"
        min="0"
        step="1000"
        value="${Number(savedValue) || 0}"
        ${enabled && !isCapEnabled ? "" : "disabled"}
        ${isCapEnabled ? 'style="opacity:0.45;"' : ""}
      >

      <label style="display:flex;align-items:center;gap:4px;flex-shrink:0;cursor:pointer;user-select:none;">
        <input
          type="checkbox"
          class="monster-type-cap"
          data-normalized="${escapeHtml(typeData.normalized)}"
          ${isCapEnabled ? "checked" : ""}
          style="width:14px;height:14px;cursor:pointer;"
        >
        <span style="font-size:12px;color:#c084fc;font-weight:600;">Cap</span>
      </label>
    `;

        const checkbox =
            div.querySelector(
                ".monster-type-enabled",
            );

        const input =
            div.querySelector(
                ".monster-type-input",
            );

        const capCheckbox =
            div.querySelector(
                ".monster-type-cap",
            );

        let capActive =
            isCapEnabled;

        capCheckbox.addEventListener(
            "change",
            () => {
                capActive =
                    capCheckbox.checked;

                input.disabled =
                    capActive ||
                    !checkbox.checked;

                input.style.opacity =
                    capActive ||
                        !checkbox.checked
                        ? "0.45"
                        : "1";

                onCapToggle(
                    typeData.normalized,
                    capActive,
                );
            },
        );

        checkbox.addEventListener(
            "change",
            () => {
                const isEnabled =
                    checkbox.checked;

                div.style.opacity =
                    isEnabled
                        ? "1"
                        : "0.45";

                input.disabled =
                    capActive ||
                    !isEnabled;

                input.style.opacity =
                    capActive ||
                        !isEnabled
                        ? "0.45"
                        : "1";

                onToggle(
                    typeData.normalized,
                    isEnabled,
                );
            },
        );

        input.addEventListener(
            "change",
            () => {
                onChange(
                    typeData.normalized,
                    Number.parseInt(
                        input.value,
                        10,
                    ) || 0,
                );
            },
        );

        return div;
    }

    function createProgressDisplay() {
        const div =
            document.createElement("div");

        div.className =
            "progress-container";

        div.id =
            "autoDamageProgress";

        div.innerHTML = `
      <div style="font-weight:600;color:#e6e8ff;margin-bottom:12px;">Progress</div>
      <div id="progressList"></div>
    `;

        return div;
    }

    function updateProgress(results) {
        const progressList =
            document.getElementById(
                "progressList",
            );

        if (!progressList) {
            return;
        }

        const completed =
            results.filter(
                (result) =>
                    result.completed,
            ).length;

        const totalDamage =
            results.reduce(
                (sum, result) =>
                    sum +
                    result.damageDealt,
                0,
            );

        const totalAttacks =
            results.reduce(
                (sum, result) =>
                    sum +
                    result.attacks,
                0,
            );

        const totalStamina =
            results.reduce(
                (sum, result) =>
                    sum +
                    result.staminaUsed,
                0,
            );

        const totalHPPots =
            results.reduce(
                (sum, result) =>
                    sum +
                    (
                        result.hpPotsUsed ||
                        0
                    ),
                0,
            );

        progressList.innerHTML = `
      <div class="progress-item">
        <span class="progress-label">Completed</span>
        <span class="progress-value">${completed}/${results.length}</span>
      </div>

      <div class="progress-item">
        <span class="progress-label">Total Damage Dealt</span>
        <span class="progress-value">${formatNumber(totalDamage)}</span>
      </div>

      <div class="progress-item">
        <span class="progress-label">Total Attacks</span>
        <span class="progress-value">${totalAttacks}</span>
      </div>

      <div class="progress-item">
        <span class="progress-label">Total Stamina Used</span>
        <span class="progress-value">${totalStamina}</span>
      </div>

      <div class="progress-item">
        <span class="progress-label">HP Pots Used</span>
        <span class="progress-value">${totalHPPots}</span>
      </div>

      <hr class="progress-divider">
    `;

        for (
            const result of results
        ) {
            const statusClass =
                result.completed
                    ? "success"
                    : result.damageDealt >
                        0
                        ? "warning"
                        : "error";

            const row =
                document.createElement(
                    "div",
                );

            row.className =
                "progress-item";

            row.innerHTML = `
        <span class="progress-label">
          ${escapeHtml(result.name)} (${formatNumber(result.targetDamage)})
          ${result.msg
                    ? `<br><span style="font-size:11px;color:#9aa0be;font-weight:400;">${escapeHtml(result.msg)}</span>`
                    : ""
                }
        </span>

        <span class="progress-value ${statusClass}">${formatNumber(result.finalDamage)}</span>
      `;

            progressList.appendChild(
                row,
            );
        }
    }

    function createRunOverlay({
        id,
        title,
        withProgress = true,
    }) {
        const overlay =
            document.createElement("div");

        overlay.id = id;

        overlay.className =
            "auto-damage-modal open";

        const content =
            document.createElement("div");

        content.className =
            "auto-damage-content";

        const header =
            document.createElement("div");

        header.className =
            "auto-damage-header";

        const titleEl =
            document.createElement("div");

        titleEl.className =
            "auto-damage-title";

        titleEl.textContent =
            title;

        const closeBtn =
            document.createElement(
                "button",
            );

        closeBtn.className =
            "auto-damage-close";

        closeBtn.innerHTML =
            "&times;";

        const runState = {
            paused: false,
            stopped: false,
        };

        closeBtn.addEventListener(
            "click",
            () => {
                runState.stopped = true;
                runState.paused = false;
                overlay.remove();
            },
        );

        header.appendChild(
            titleEl,
        );

        header.appendChild(
            closeBtn,
        );

        const actions =
            document.createElement("div");

        actions.className =
            "auto-damage-actions";

        const pauseBtn =
            document.createElement(
                "button",
            );

        pauseBtn.className =
            "btn-auto-damage btn-auto-damage-warning";

        pauseBtn.textContent =
            "⏸ Pause";

        const stopBtn =
            document.createElement(
                "button",
            );

        stopBtn.className =
            "btn-auto-damage btn-auto-damage-danger";

        stopBtn.textContent =
            "⏹ Stop";

        actions.appendChild(
            pauseBtn,
        );

        actions.appendChild(
            stopBtn,
        );

        content.appendChild(
            header,
        );

        content.appendChild(
            actions,
        );

        let progressContainer =
            null;

        if (withProgress) {
            progressContainer =
                createProgressDisplay();

            progressContainer.style.display =
                "block";

            content.appendChild(
                progressContainer,
            );
        }

        overlay.appendChild(
            content,
        );

        document.body.appendChild(
            overlay,
        );

        runState.onPause = () => {
            pauseBtn.textContent =
                "▶ Resume";
        };

        runState.onResume = () => {
            pauseBtn.textContent =
                "⏸ Pause";
        };

        pauseBtn.addEventListener(
            "click",
            () => {
                runState.paused =
                    !runState.paused;

                if (runState.paused) {
                    runState.onPause();
                } else {
                    runState.onResume();
                }
            },
        );

        stopBtn.addEventListener(
            "click",
            () => {
                runState.stopped = true;
                runState.paused = false;
            },
        );

        return {
            overlay,
            content,
            runState,
            pauseBtn,
            stopBtn,
            progressContainer,
        };
    }

    function createModal(
        monsterTypes,
    ) {
        if (
            document.getElementById(
                "autoDamageModal",
            )
        ) {
            return null;
        }

        const overlay =
            document.createElement("div");

        overlay.id =
            "autoDamageModal";

        overlay.className =
            "auto-damage-modal open";

        const content =
            document.createElement("div");

        content.className =
            "auto-damage-content";

        const header =
            document.createElement("div");

        header.className =
            "auto-damage-header";

        const title =
            document.createElement("div");

        title.className =
            "auto-damage-title";

        title.textContent =
            "⚙️ Configure Auto-Damage";

        const closeBtn =
            document.createElement(
                "button",
            );

        closeBtn.className =
            "auto-damage-close";

        closeBtn.innerHTML =
            "&times;";

        closeBtn.addEventListener(
            "click",
            () => overlay.remove(),
        );

        header.appendChild(
            title,
        );

        header.appendChild(
            closeBtn,
        );

        const description =
            document.createElement("div");

        description.style.color =
            "#9aa0be";

        description.style.fontSize =
            "13px";

        description.style.marginBottom =
            "16px";

        description.textContent =
            "Set damage targets for each monster type. Changes are saved automatically.";

        const list =
            document.createElement("div");

        list.className =
            "monster-type-list";

        const damageTargets = {
            ...Storage.get(
                "dungeon-auto-damage:damageTargets",
                {},
            ),
        };

        const enabledMonsters = {
            ...Storage.get(
                "dungeon-auto-damage:enabledMonsters",
                {},
            ),
        };

        const capByMonster = {
            ...Storage.get(
                "dungeon-auto-damage:useCapDamageByMonster",
                {},
            ),
        };

        const sortedTypes = [
            ...monsterTypes,
        ].sort((a, b) => {
            const aIndex =
                MONSTER_CONFIG_ORDER.get(
                    a.normalized,
                ) ?? Infinity;

            const bIndex =
                MONSTER_CONFIG_ORDER.get(
                    b.normalized,
                ) ?? Infinity;

            return aIndex - bIndex;
        });

        for (
            const type of sortedTypes
        ) {
            const savedValue =
                damageTargets[
                type.normalized
                ] ??
                DEFAULT_DAMAGE_BY_MONSTER.get(
                    type.normalized,
                ) ??
                0;

            const isEnabled =
                enabledMonsters[
                type.normalized
                ] ?? true;

            const isCapEnabled =
                capByMonster[
                type.normalized
                ] ?? false;

            list.appendChild(
                createMonsterTypeRow(
                    type,
                    (
                        normalized,
                        value,
                    ) => {
                        damageTargets[
                            normalized
                        ] = value;

                        Storage.set(
                            "dungeon-auto-damage:damageTargets",
                            damageTargets,
                        );
                    },
                    (
                        normalized,
                        value,
                    ) => {
                        enabledMonsters[
                            normalized
                        ] = value;

                        Storage.set(
                            "dungeon-auto-damage:enabledMonsters",
                            enabledMonsters,
                        );
                    },
                    (
                        normalized,
                        value,
                    ) => {
                        capByMonster[
                            normalized
                        ] = value;

                        Storage.set(
                            "dungeon-auto-damage:useCapDamageByMonster",
                            capByMonster,
                        );
                    },
                    savedValue,
                    isEnabled,
                    isCapEnabled,
                ),
            );
        }

        const actions =
            document.createElement("div");

        actions.className =
            "auto-damage-actions";

        const closeAction =
            document.createElement(
                "button",
            );

        closeAction.className =
            "btn-auto-damage btn-auto-damage-secondary";

        closeAction.textContent =
            "Close";

        closeAction.addEventListener(
            "click",
            () => overlay.remove(),
        );

        const saveBtn =
            document.createElement(
                "button",
            );

        saveBtn.className =
            "btn-auto-damage btn-auto-damage-primary";

        saveBtn.textContent =
            "Save & Close";

        saveBtn.addEventListener(
            "click",
            () => overlay.remove(),
        );

        actions.appendChild(
            closeAction,
        );

        actions.appendChild(
            saveBtn,
        );

        content.appendChild(
            header,
        );

        content.appendChild(
            description,
        );

        content.appendChild(
            list,
        );

        content.appendChild(
            actions,
        );

        overlay.appendChild(
            content,
        );

        document.body.appendChild(
            overlay,
        );

        return overlay;
    }

    async function executeAttackLoop({
        instanceId,
        monstersToAttack,
        startIndex,
        settings,
        runState,
    }) {
        const results = [];

        for (
            let index = startIndex;
            index <
            monstersToAttack.length;
            index++
        ) {
            Storage.set(
                SESSION_KEY,
                {
                    instanceId,
                    monstersToAttack,
                    currentIndex: index,
                    settings,
                },
            );

            if (
                runState.stopped ||
                !(await waitIfPaused(
                    runState,
                ))
            ) {
                break;
            }

            const monster =
                monstersToAttack[index];

            updateProgress(
                results,
            );

            try {
                const result =
                    await autoDamageMonster(
                        monster,
                        monster.targetDamage,
                        instanceId,
                        settings,
                        runState,
                    );

                results.push(
                    result,
                );

                updateProgress(
                    results,
                );

                if (
                    /Level up detected/i.test(
                        result.msg,
                    )
                ) {
                    showNotification(
                        "Level up detected! Stopping...",
                        "info",
                    );

                    break;
                }
            } catch (error) {
                console.error(
                    `[Auto-Damage] Error attacking monster ${monster.id}:`,
                    error,
                );

                results.push({
                    monsterId:
                        monster.id,
                    name:
                        monster.name,
                    targetDamage:
                        monster.targetDamage,
                    initialDamage: 0,
                    finalDamage: 0,
                    damageDealt: 0,
                    attacks: 0,
                    staminaUsed: 0,
                    hpPotsUsed: 0,
                    completed: false,
                    msg:
                        `Error: ` +
                        `${error.message}`,
                });

                updateProgress(
                    results,
                );
            }
        }

        Storage.set(
            SESSION_KEY,
            null,
        );

        updateProgress(
            results,
        );

        const completed =
            results.filter(
                (result) =>
                    result.completed,
            ).length;

        showNotification(
            `Auto-Damage complete: ${completed}/${results.length} targets reached`,
            completed ===
                results.length
                ? "success"
                : "info",
        );
    }

    async function buildAttackList(
        instanceId,
        monsterTypes,
    ) {
        const savedTargets =
            Storage.get(
                "dungeon-auto-damage:damageTargets",
                {},
            );

        const savedEnabled =
            Storage.get(
                "dungeon-auto-damage:enabledMonsters",
                {},
            );

        const capByMonster =
            Storage.get(
                "dungeon-auto-damage:useCapDamageByMonster",
                {},
            );

        const capTypes =
            monsterTypes.filter(
                (type) =>
                    capByMonster[
                    type.normalized
                    ] &&
                    type.monsters.length >
                    0,
            );

        const capEntries =
            await mapWithConcurrency(
                capTypes,
                4,
                async (type) => [
                    type.normalized,
                    await getMonsterCapDamage(
                        type.monsters[0].id,
                        instanceId,
                    ),
                ],
            );

        const capTargets =
            new Map(capEntries);

        const monstersToAttack =
            [];

        for (
            const type of monsterTypes
        ) {
            if (
                !(
                    savedEnabled[
                    type.normalized
                    ] ?? true
                )
            ) {
                continue;
            }

            const manualTarget =
                savedTargets[
                type.normalized
                ] ??
                DEFAULT_DAMAGE_BY_MONSTER.get(
                    type.normalized,
                ) ??
                0;

            const target =
                capByMonster[
                    type.normalized
                ]
                    ? capTargets.get(
                        type.normalized,
                    ) ?? manualTarget
                    : manualTarget;

            if (target <= 0) {
                continue;
            }

            for (
                const monster of
                type.monsters
            ) {
                monstersToAttack.push({
                    ...monster,
                    targetDamage:
                        target,
                });
            }
        }

        return monstersToAttack;
    }

    function getRunSettings() {
        return {
            attackCooldown:
                Storage.get(
                    "dungeon-auto-damage:attackCooldown",
                    1050,
                ),

            stopOnLevelUp:
                Storage.get(
                    "dungeon-auto-damage:stopOnLevelUp",
                    true,
                ),

            respectStamina:
                Storage.get(
                    "dungeon-auto-damage:respectStamina",
                    true,
                ),

            minStamina:
                Storage.get(
                    "dungeon-auto-damage:minStamina",
                    50,
                ),

            useHPPots:
                Storage.get(
                    "dungeon-auto-damage:useHPPots",
                    true,
                ),

            minHPPercent:
                Storage.get(
                    "dungeon-auto-damage:minHPPercent",
                    10,
                ),
        };
    }

    async function startAutoDamage(
        instanceId,
    ) {
        if (
            document.getElementById(
                "autoDamageRunOverlay",
            )
        ) {
            return;
        }

        const ui =
            createRunOverlay({
                id: "autoDamageRunOverlay",
                title:
                    "▶ Auto-Damage Running",
                withProgress: true,
            });

        const monsterTypes =
            await getDungeonMonsterTypes(
                instanceId,
            );

        const monstersToAttack =
            await buildAttackList(
                instanceId,
                monsterTypes,
            );

        if (
            monstersToAttack.length ===
            0
        ) {
            showNotification(
                "No damage targets set - configure targets first",
                "error",
            );

            ui.overlay.remove();
            return;
        }

        await executeAttackLoop({
            instanceId,
            monstersToAttack,
            startIndex: 0,
            settings:
                getRunSettings(),
            runState:
                ui.runState,
        });

        ui.pauseBtn.style.display =
            "none";

        ui.stopBtn.style.display =
            "none";
    }

    async function resumeAutoDamage(
        instanceId,
        session,
    ) {
        if (
            !session ||
            document.getElementById(
                "autoDamageRunOverlay",
            )
        ) {
            return;
        }

        const ui =
            createRunOverlay({
                id: "autoDamageRunOverlay",
                title:
                    "🔄 Resuming Auto-Damage",
                withProgress: true,
            });

        await executeAttackLoop({
            instanceId,
            monstersToAttack:
                session.monstersToAttack,
            startIndex:
                session.currentIndex ||
                0,
            settings:
                session.settings ||
                getRunSettings(),
            runState:
                ui.runState,
        });

        ui.pauseBtn.style.display =
            "none";

        ui.stopBtn.style.display =
            "none";
    }

    async function chooseMonstersToClear(
        monsterTypes,
    ) {
        return new Promise(
            (resolve) => {
                const overlay =
                    document.createElement(
                        "div",
                    );

                overlay.id =
                    "autoDamageClearConfirm";

                overlay.className =
                    "auto-damage-modal open";

                const content =
                    document.createElement(
                        "div",
                    );

                content.className =
                    "auto-damage-content";

                const header =
                    document.createElement(
                        "div",
                    );

                header.className =
                    "auto-damage-header";

                const title =
                    document.createElement(
                        "div",
                    );

                title.className =
                    "auto-damage-title";

                title.textContent =
                    "💀 Select Monsters to Clear";

                const closeBtn =
                    document.createElement(
                        "button",
                    );

                closeBtn.className =
                    "auto-damage-close";

                closeBtn.innerHTML =
                    "&times;";

                const finish = (
                    value,
                ) => {
                    if (
                        overlay.isConnected
                    ) {
                        overlay.remove();
                    }

                    resolve(value);
                };

                closeBtn.addEventListener(
                    "click",
                    () => finish(null),
                );

                header.appendChild(
                    title,
                );

                header.appendChild(
                    closeBtn,
                );

                const sortedTypes = [
                    ...monsterTypes,
                ].sort((a, b) => {
                    const aHigh =
                        HIGH_DEMAND_MONSTERS.has(
                            a.normalized,
                        )
                            ? 1
                            : 0;

                    const bHigh =
                        HIGH_DEMAND_MONSTERS.has(
                            b.normalized,
                        )
                            ? 1
                            : 0;

                    if (
                        aHigh !== bHigh
                    ) {
                        return aHigh -
                            bHigh;
                    }

                    const aIndex =
                        MONSTER_CONFIG_ORDER.get(
                            a.normalized,
                        ) ?? Infinity;

                    const bIndex =
                        MONSTER_CONFIG_ORDER.get(
                            b.normalized,
                        ) ?? Infinity;

                    return aIndex -
                        bIndex;
                });

                const enabledByType =
                    new Map(
                        sortedTypes.map(
                            (type) => [
                                type.normalized,
                                !HIGH_DEMAND_MONSTERS.has(
                                    type.normalized,
                                ),
                            ],
                        ),
                    );

                const list =
                    document.createElement(
                        "div",
                    );

                list.className =
                    "monster-type-list";

                list.style.marginBottom =
                    "16px";

                for (
                    const type of
                    sortedTypes
                ) {
                    const isEnabled =
                        enabledByType.get(
                            type.normalized,
                        );

                    const row =
                        document.createElement(
                            "div",
                        );

                    row.className =
                        "monster-type-item";

                    if (!isEnabled) {
                        row.style.opacity =
                            "0.45";
                    }

                    row.innerHTML = `
            <input
              type="checkbox"
              ${isEnabled ? "checked" : ""}
              style="width:16px;height:16px;cursor:pointer;flex-shrink:0;"
            >

            <div class="monster-type-info">
              <div class="monster-type-name">${escapeHtml(type.name)}</div>
              <div class="monster-type-count">${type.count} monster${type.count > 1 ? "s" : ""}</div>
            </div>
          `;

                    const checkbox =
                        row.querySelector(
                            "input[type=checkbox]",
                        );

                    checkbox.addEventListener(
                        "change",
                        () => {
                            enabledByType.set(
                                type.normalized,
                                checkbox.checked,
                            );

                            row.style.opacity =
                                checkbox.checked
                                    ? "1"
                                    : "0.45";
                        },
                    );

                    list.appendChild(
                        row,
                    );
                }

                const actions =
                    document.createElement(
                        "div",
                    );

                actions.className =
                    "auto-damage-actions";

                const cancelBtn =
                    document.createElement(
                        "button",
                    );

                cancelBtn.className =
                    "btn-auto-damage btn-auto-damage-secondary";

                cancelBtn.textContent =
                    "Cancel";

                cancelBtn.addEventListener(
                    "click",
                    () => finish(null),
                );

                const proceedBtn =
                    document.createElement(
                        "button",
                    );

                proceedBtn.className =
                    "btn-auto-damage btn-auto-damage-danger";

                proceedBtn.textContent =
                    "💀 Clear Selected";

                proceedBtn.addEventListener(
                    "click",
                    () => {
                        const selected =
                            sortedTypes
                                .filter(
                                    (type) =>
                                        enabledByType.get(
                                            type.normalized,
                                        ),
                                )
                                .flatMap(
                                    (type) =>
                                        type.monsters,
                                );

                        finish(
                            selected.length >
                                0
                                ? selected
                                : null,
                        );
                    },
                );

                actions.appendChild(
                    cancelBtn,
                );

                actions.appendChild(
                    proceedBtn,
                );

                content.appendChild(
                    header,
                );

                content.appendChild(
                    list,
                );

                content.appendChild(
                    actions,
                );

                overlay.appendChild(
                    content,
                );

                document.body.appendChild(
                    overlay,
                );

                overlay.addEventListener(
                    "click",
                    (event) => {
                        if (
                            event.target ===
                            overlay
                        ) {
                            finish(null);
                        }
                    },
                );
            },
        );
    }

    function injectAutoDamageButton(
        instanceId,
    ) {
        if (
            document.getElementById(
                "autoDamageConfigBtn",
            )
        ) {
            return;
        }

        const row =
            document.querySelector(
                ".row > .row",
            );

        if (!row) {
            return;
        }

        const configBtn =
            document.createElement(
                "div",
            );

        configBtn.id =
            "autoDamageConfigBtn";

        configBtn.className =
            "btn";

        configBtn.textContent =
            "⚙️ Configure";

        configBtn.title =
            "Configure damage targets per monster type";

        configBtn.addEventListener(
            "click",
            async () => {
                if (
                    !Storage.get(
                        "dungeon-auto-damage:enabled",
                        true,
                    )
                ) {
                    showNotification(
                        "Auto-Damage is disabled in settings",
                        "error",
                    );

                    return;
                }

                configBtn.textContent =
                    "🔍 Scanning...";

                configBtn.setAttribute(
                    "disabled",
                    true,
                );

                try {
                    const monsterTypes =
                        await getDungeonMonsterTypes(
                            instanceId,
                        );

                    if (
                        monsterTypes.length ===
                        0
                    ) {
                        showNotification(
                            "No monsters found in this dungeon",
                            "error",
                        );
                    } else {
                        createModal(
                            monsterTypes,
                        );
                    }
                } catch (error) {
                    console.error(
                        "[Auto-Damage] Error scanning dungeon:",
                        error,
                    );

                    showNotification(
                        `Error scanning dungeon: ${error.message}`,
                        "error",
                    );
                } finally {
                    configBtn.textContent =
                        "⚙️ Configure";

                    configBtn.removeAttribute(
                        "disabled",
                    );
                }
            },
        );

        const startBtn =
            document.createElement(
                "div",
            );

        startBtn.id =
            "autoDamageStartBtn";

        startBtn.className =
            "btn";

        startBtn.style.marginLeft =
            "8px";

        const savedSession =
            Storage.get(
                SESSION_KEY,
                null,
            );

        const hasSession =
            savedSession &&
            savedSession.instanceId ===
            instanceId;

        startBtn.textContent =
            hasSession
                ? "🔄 Resume"
                : "▶ Start";

        startBtn.title =
            hasSession
                ? "Resume previous auto-damage session"
                : "Start auto-damage with configured targets";

        const clearSessionBtn =
            document.createElement(
                "div",
            );

        clearSessionBtn.id =
            "autoDamageClearBtn";

        clearSessionBtn.className =
            "btn";

        clearSessionBtn.textContent =
            "🗑️ Clear";

        clearSessionBtn.title =
            "Discard the saved session";

        clearSessionBtn.style.marginLeft =
            "4px";

        if (!hasSession) {
            clearSessionBtn.style.display =
                "none";
        }

        clearSessionBtn.addEventListener(
            "click",
            () => {
                Storage.set(
                    SESSION_KEY,
                    null,
                );

                clearSessionBtn.style.display =
                    "none";

                startBtn.textContent =
                    "▶ Start";

                startBtn.title =
                    "Start auto-damage with configured targets";

                showNotification(
                    "Session cleared",
                    "info",
                );
            },
        );

        let isRunning = false;

        startBtn.addEventListener(
            "click",
            async () => {
                if (
                    isRunning ||
                    autoResuming
                ) {
                    return;
                }

                if (
                    !Storage.get(
                        "dungeon-auto-damage:enabled",
                        true,
                    )
                ) {
                    showNotification(
                        "Auto-Damage is disabled in settings",
                        "error",
                    );

                    return;
                }

                isRunning = true;

                startBtn.setAttribute(
                    "disabled",
                    true,
                );

                clearSessionBtn.style.display =
                    "none";

                try {
                    const currentSession =
                        Storage.get(
                            SESSION_KEY,
                            null,
                        );

                    if (
                        currentSession &&
                        currentSession.instanceId ===
                        instanceId
                    ) {
                        startBtn.textContent =
                            "⏳ Resuming...";

                        await resumeAutoDamage(
                            instanceId,
                            currentSession,
                        );
                    } else {
                        startBtn.textContent =
                            "⏳ Starting...";

                        await startAutoDamage(
                            instanceId,
                        );
                    }
                } finally {
                    const sessionAfter =
                        Storage.get(
                            SESSION_KEY,
                            null,
                        );

                    if (
                        sessionAfter &&
                        sessionAfter.instanceId ===
                        instanceId
                    ) {
                        startBtn.textContent =
                            "🔄 Resume";

                        startBtn.title =
                            "Resume previous auto-damage session";

                        clearSessionBtn.style.display =
                            "";
                    } else {
                        startBtn.textContent =
                            "▶ Start";

                        startBtn.title =
                            "Start auto-damage with configured targets";

                        clearSessionBtn.style.display =
                            "none";
                    }

                    startBtn.removeAttribute(
                        "disabled",
                    );

                    isRunning = false;
                }
            },
        );

        row.insertBefore(
            startBtn,
            row.children[1],
        );

        row.insertBefore(
            configBtn,
            startBtn,
        );

        row.insertBefore(
            clearSessionBtn,
            startBtn.nextSibling,
        );

        if (
            Storage.get(
                "dungeon-auto-damage:enableClearAll",
                false,
            )
        ) {
            const clearBtn =
                document.createElement(
                    "div",
                );

            clearBtn.className =
                "btn";

            clearBtn.textContent =
                "💀 Clear All Monsters";

            clearBtn.title =
                "Clear all remaining monsters in the dungeon";

            clearBtn.style.marginLeft =
                "8px";

            clearBtn.addEventListener(
                "click",
                async () => {
                    if (
                        document.getElementById(
                            "autoDamageClearOverlay",
                        ) ||
                        document.getElementById(
                            "autoDamageClearConfirm",
                        )
                    ) {
                        return;
                    }

                    clearBtn.textContent =
                        "🔍 Scanning...";

                    clearBtn.setAttribute(
                        "disabled",
                        true,
                    );

                    let monsterTypes;

                    try {
                        monsterTypes =
                            await getDungeonMonsterTypes(
                                instanceId,
                                {
                                    force: true,
                                },
                            );
                    } catch (error) {
                        showNotification(
                            `Error scanning dungeon: ${error.message}`,
                            "error",
                        );

                        clearBtn.textContent =
                            "💀 Clear All Monsters";

                        clearBtn.removeAttribute(
                            "disabled",
                        );

                        return;
                    }

                    clearBtn.textContent =
                        "💀 Clear All Monsters";

                    clearBtn.removeAttribute(
                        "disabled",
                    );

                    const allMonsters =
                        monsterTypes.flatMap(
                            (type) =>
                                type.monsters,
                        );

                    if (
                        allMonsters.length ===
                        0
                    ) {
                        showNotification(
                            "No monsters found to clear",
                            "error",
                        );

                        return;
                    }

                    const monstersToTarget =
                        await chooseMonstersToClear(
                            monsterTypes,
                        );

                    if (!monstersToTarget) {
                        return;
                    }

                    const ui =
                        createRunOverlay({
                            id: "autoDamageClearOverlay",
                            title:
                                "💀 Clearing All Monsters",
                            withProgress: false,
                        });

                    const statusDiv =
                        document.createElement(
                            "div",
                        );

                    statusDiv.id =
                        "clearAllStatus";

                    statusDiv.style.cssText =
                        "padding:12px 0;color:#e6e8ff;font-size:14px;min-height:24px;";

                    statusDiv.textContent =
                        "Starting...";

                    ui.content.appendChild(
                        statusDiv,
                    );

                    try {
                        await clearAllMonsters(
                            instanceId,
                            ui.runState,
                            monstersToTarget,
                        );

                        ui.pauseBtn.style.display =
                            "none";

                        ui.stopBtn.style.display =
                            "none";
                    } catch (error) {
                        console.error(
                            "[Auto-Damage] Error clearing monsters:",
                            error,
                        );

                        showNotification(
                            `Error clearing monsters: ${error.message}`,
                            "error",
                        );

                        ui.overlay.remove();
                    }
                },
            );

            row.insertBefore(
                clearBtn,
                clearSessionBtn.nextSibling,
            );
        }
    }

    // ---------------------------------------------------------------------------
    // Startup
    // ---------------------------------------------------------------------------

    (async function main() {
        const instanceId =
            getInstanceId();

        if (!instanceId) {
            console.warn(
                "[dungeon-auto-damage] Could not find instance ID",
            );

            return;
        }

        injectAutoDamageButton(
            instanceId,
        );

        if (
            !Storage.get(
                "dungeon-auto-damage:enabled",
                true,
            )
        ) {
            return;
        }

        const session =
            Storage.get(
                SESSION_KEY,
                null,
            );

        if (
            !session ||
            session.instanceId !==
            instanceId
        ) {
            return;
        }

        autoResuming = true;

        const startBtn =
            document.getElementById(
                "autoDamageStartBtn",
            );

        const clearBtn =
            document.getElementById(
                "autoDamageClearBtn",
            );

        startBtn?.setAttribute(
            "disabled",
            true,
        );

        if (clearBtn) {
            clearBtn.style.display =
                "none";
        }

        showNotification(
            "Auto-resuming previous session...",
            "info",
        );

        try {
            await resumeAutoDamage(
                instanceId,
                session,
            );
        } finally {
            autoResuming = false;

            if (startBtn) {
                const sessionAfter =
                    Storage.get(
                        SESSION_KEY,
                        null,
                    );

                if (
                    sessionAfter &&
                    sessionAfter.instanceId ===
                    instanceId
                ) {
                    startBtn.textContent =
                        "🔄 Resume";

                    startBtn.title =
                        "Resume previous auto-damage session";

                    if (clearBtn) {
                        clearBtn.style.display =
                            "";
                    }
                } else {
                    startBtn.textContent =
                        "▶ Start";

                    startBtn.title =
                        "Start auto-damage with configured targets";

                    if (clearBtn) {
                        clearBtn.style.display =
                            "none";
                    }
                }

                startBtn.removeAttribute(
                    "disabled",
                );
            }
        }
    })();
})();