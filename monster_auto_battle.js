// ==UserScript==
// @name         Monster Auto Battle - 3 Attack Fallback
// @namespace    http://tampermonkey.net/
// @version      1.3.3
// @description  Auto-battle for the current monster with three attacks, potion priorities, target damage, and level-up protection.
// @match        https://demonicscans.org/battle.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const ID = 'tm-monster-auto-battle';
    const STORE_KEY =
        `${ID}:settings:v4:${location.host}:${location.pathname}`;
    const RESUME_KEY =
        `${ID}:potion-resume:v1:${location.host}:${location.pathname}`;
    const SEL = {
        monsterCard: '.battle-card.monster-card',
        attack: 'button.attack-btn',
        damage: '#yourDamageValue',
        monsterHp: '#hpText',

        // Exact selectors from the current game layout.
        stamina: '#stamina_span',
        playerHp: '#pHpText',
        playerMana: '#pManaText',
        exp:
            '.game-topbar .gtb-exp ' +
            '.gtb-exp-top span:last-child',

        potion: '.potion-use-btn',
        potionCard: '.potion-card',
    };

    const defaults = {
        attackKeys: ['', '', ''],

        autoStamina: false,
        autoMana: false,
        autoHealth: false,

        stopBeforeLevelUp: false,
        levelMultiplier: 2,

        targetDamage: '0',
        delayMs: 1200,
        collapsed: false,

        potionEnabled: {},

        potionOrder: {
            stamina: [],
            mana: [],
            health: [],
        },
    };

    const state = {
        card: null,
        panel: null,

        running: false,
        expectingPotionRefresh: false,
        monsterKey: '',

        attacks: [],
        attackSignature: '',

        potions: [],
        settings: loadSettings(),

        sessionDamage: 0,
        lastDamage: 0,
        lastExperienceGain: null,
        noDamageCount: 0,
        /*
         * Used when the server reports insufficient stamina.
         * The script then proceeds to the next selected attack.
         */
        forcedAttackIndex: 0,

        timers: {},
    };

    function loadSettings() {
        try {
            const saved = JSON.parse(
                localStorage.getItem(STORE_KEY) || '{}',
            );

            return {
                ...defaults,
                ...saved,

                attackKeys: Array.isArray(saved.attackKeys)
                    ? saved.attackKeys.slice(0, 3)
                    : ['', '', ''],

                potionEnabled: {
                    ...(saved.potionEnabled || {}),
                },

                potionOrder: {
                    stamina:
                        saved.potionOrder?.stamina || [],

                    mana:
                        saved.potionOrder?.mana || [],

                    health:
                        saved.potionOrder?.health || [],
                },
            };
        } catch (error) {
            console.warn(
                '[Monster Auto Battle] ' +
                'Could not load settings.',
                error,
            );

            return JSON.parse(
                JSON.stringify(defaults),
            );
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(
                STORE_KEY,
                JSON.stringify(state.settings),
            );
        } catch (error) {
            console.warn(
                '[Monster Auto Battle] ' +
                'Could not save settings.',
                error,
            );
        }
    }

    function savePotionResumeState() {
        if (!state.running) {
            return;
        }

        const resumeData = {
            savedAt: Date.now(),

            monsterKey:
                state.monsterKey ||
                getMonsterKey(),

            sessionDamage:
                state.sessionDamage,

            lastDamage:
                state.lastDamage,

            lastExperienceGain:
                state.lastExperienceGain,

            noDamageCount:
                state.noDamageCount,
        };

        try {
            sessionStorage.setItem(
                RESUME_KEY,
                JSON.stringify(resumeData),
            );
        } catch (error) {
            console.warn(
                '[Monster Auto Battle] ' +
                'Could not store the potion resume state.',
                error,
            );
        }
    }

    function loadPotionResumeState() {
        try {
            const raw =
                sessionStorage.getItem(
                    RESUME_KEY,
                );

            if (!raw) {
                return null;
            }

            const resumeData =
                JSON.parse(raw);

            /*
             * Do not resume an old battle session.
             * The token exists only to survive the
             * short reload caused by potion use.
             */
            if (
                !resumeData?.savedAt ||
                Date.now() -
                resumeData.savedAt >
                30000
            ) {
                clearPotionResumeState();

                return null;
            }

            return resumeData;
        } catch (error) {
            console.warn(
                '[Monster Auto Battle] ' +
                'Could not read the potion resume state.',
                error,
            );

            clearPotionResumeState();

            return null;
        }
    }

    function clearPotionResumeState() {
        try {
            sessionStorage.removeItem(
                RESUME_KEY,
            );
        } catch (error) {
            console.warn(
                '[Monster Auto Battle] ' +
                'Could not clear the potion resume state.',
                error,
            );
        }
    }

    async function resumeAfterPotionReload() {
        if (
            state.running ||
            !state.card
        ) {
            return;
        }

        const resumeData =
            loadPotionResumeState();

        if (!resumeData) {
            return;
        }

        const currentMonsterKey =
            getMonsterKey();

        if (
            currentMonsterKey !==
            resumeData.monsterKey
        ) {
            clearPotionResumeState();

            setStatus(
                'Auto-battle was not resumed because the monster changed.',
            );

            return;
        }

        setStatus(
            'Potion use completed. Resuming auto-battle...',
            'running',
        );

        log(
            'A potion page refresh was detected. Auto-battle will resume automatically.',
        );

        /*
         * Give the refreshed battle page a moment
         * to finish binding its own click handlers.
         */
        await sleep(500);

        if (!state.running) {
            void runAutoBattle(
                resumeData,
            );
        }
    }

    const sleep = milliseconds =>
        new Promise(resolve => {
            setTimeout(resolve, milliseconds);
        });

    const queryAll = (
        selector,
        root = document,
    ) => [
            ...root.querySelectorAll(selector),
        ];

    function formatNumber(value) {
        return Number.isFinite(value)
            ? new Intl.NumberFormat(
                'en-US',
                {
                    maximumFractionDigits: 0,
                },
            ).format(value)
            : '—';
    }

    function parseInteger(value) {
        const match = String(value ?? '').match(
            /-?\d{1,3}(?:[.,\s]\d{3})+|-?\d+/,
        );

        if (!match) {
            return null;
        }

        const number = Number(
            match[0].replace(/\D/g, ''),
        );

        if (!Number.isFinite(number)) {
            return null;
        }

        return match[0]
            .trim()
            .startsWith('-')
            ? -number
            : number;
    }

    function parseFraction(text) {
        const match = String(text ?? '').match(
            /(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*\/\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+)/,
        );

        if (!match) {
            return null;
        }

        const current =
            parseInteger(match[1]);

        const maximum =
            parseInteger(match[2]);

        if (
            !Number.isFinite(current) ||
            !Number.isFinite(maximum)
        ) {
            return null;
        }

        return {
            current,
            maximum,
        };
    }

    function parseTarget(value) {
        const raw = String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '');

        if (!raw) {
            return 0;
        }

        const match = raw.match(
            /^([\d.,]+)([kmbtq])?$/,
        );

        if (!match) {
            return NaN;
        }

        const suffix =
            match[2] || '';

        const factors = {
            '': 1,
            k: 1e3,
            m: 1e6,
            b: 1e9,
            t: 1e12,
            q: 1e15,
        };

        let numberText = match[1];

        if (suffix) {
            if (
                numberText.includes('.') &&
                numberText.includes(',')
            ) {
                const decimalSeparator =
                    numberText.lastIndexOf(',') >
                        numberText.lastIndexOf('.')
                        ? ','
                        : '.';

                const thousandsSeparator =
                    decimalSeparator === ','
                        ? '.'
                        : ',';

                numberText = numberText
                    .split(thousandsSeparator)
                    .join('')
                    .replace(
                        decimalSeparator,
                        '.',
                    );
            } else {
                numberText =
                    numberText.replace(',', '.');
            }
        } else {
            numberText =
                numberText.replace(/\D/g, '');
        }

        const result =
            Number(numberText) *
            factors[suffix];

        return Number.isFinite(result)
            ? result
            : NaN;
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function findMonsterCard() {
        return (
            queryAll(SEL.monsterCard).find(
                card =>
                    card.querySelector(SEL.attack),
            ) || null
        );
    }

    function getMonsterKey(
        card = state.card,
    ) {
        const title =
            card
                ?.querySelector('.card-title')
                ?.textContent
                ?.trim() ||
            'monster';

        const image =
            card
                ?.querySelector(
                    '#monsterImage, .monster_image',
                )
                ?.getAttribute('src') ||
            '';

        /*
         * nextDieMs normally identifies the current
         * monster instance more precisely than its
         * title and image alone.
         */
        const monsterInstance =
            window.AUTO_DIE_CFG
                ?.nextDieMs ??
            '';

        return [
            location.pathname,
            title,
            image,
            monsterInstance,
        ].join('|');
    }

    function getCurrentDamage() {
        return parseInteger(
            state.card
                ?.querySelector(SEL.damage)
                ?.textContent,
        );
    }

    function getCurrentStamina() {
        return parseInteger(
            document
                .querySelector(SEL.stamina)
                ?.textContent,
        );
    }

    function getCurrentHealth() {
        return (
            parseFraction(
                document
                    .querySelector(SEL.playerHp)
                    ?.textContent,
            )?.current ??
            null
        );
    }

    function getCurrentMana() {
        return (
            parseFraction(
                document
                    .querySelector(
                        SEL.playerMana,
                    )
                    ?.textContent,
            )?.current ??
            null
        );
    }

    function getExperienceProgress() {
        const experience = parseFraction(
            document
                .querySelector(SEL.exp)
                ?.textContent,
        );

        if (!experience) {
            return null;
        }

        return {
            current: experience.current,
            maximum: experience.maximum,

            remaining: Math.max(
                0,
                experience.maximum -
                experience.current,
            ),
        };
    }

    function getRemainingExperience() {
        return (
            getExperienceProgress()
                ?.remaining ??
            null
        );
    }

    /*
     * Calculates the EXP gained between two header states.
     *
     * Normal example:
     * Before: 25,706,330
     * After:  25,706,900
     * Gain:          570
     *
     * It also handles a single level rollover:
     * Before: 52,598,800 / 52,598,856
     * After:         200 / new maximum
     * Gain:          256
     */
    function calculateExperienceGain(
        before,
        after,
    ) {
        if (!before || !after) {
            return null;
        }

        /*
         * Normal EXP increase without a level-up.
         */
        if (
            after.maximum === before.maximum &&
            after.current >= before.current
        ) {
            return (
                after.current -
                before.current
            );
        }

        /*
         * The EXP counter rolled over because
         * a level-up occurred.
         */
        if (
            after.maximum !== before.maximum ||
            after.current < before.current
        ) {
            return Math.max(
                0,
                (
                    before.maximum -
                    before.current
                ) +
                after.current,
            );
        }

        return null;
    }

    /*
     * The battle response and the topbar EXP update
     * may not happen at exactly the same moment.
     * Therefore, wait briefly for the EXP value to change.
     */
    async function waitForExperienceUpdate(
        before,
        timeoutMs = 3000,
    ) {
        if (!before) {
            return null;
        }

        const startedAt = Date.now();

        while (
            state.running &&
            Date.now() - startedAt <
            timeoutMs
        ) {
            const current =
                getExperienceProgress();

            if (
                current &&
                (
                    current.current !==
                    before.current ||
                    current.maximum !==
                    before.maximum
                )
            ) {
                return current;
            }

            await sleep(100);
        }

        return getExperienceProgress();
    }

    function isMonsterDead() {
        const currentHp =
            parseFraction(
                state.card
                    ?.querySelector(
                        SEL.monsterHp,
                    )
                    ?.textContent,
            )?.current;

        return (
            currentHp === 0 ||
            Boolean(
                state.card
                    ?.classList
                    .contains('dead'),
            )
        );
    }

    function getAttackCosts(button) {
        const text = [
            button.dataset.skillName || '',
            button.textContent || '',
            button
                .querySelector('.skill-cost')
                ?.textContent ||
            '',
        ].join(' ');

        const staminaMatch =
            text.match(
                /(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*(?:stam|stamina)\b/i,
            );

        const manaMatch =
            text.match(
                /(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*(?:mp|mana)\b/i,
            );

        let stamina =
            staminaMatch
                ? parseInteger(
                    staminaMatch[1],
                )
                : null;

        const mana =
            manaMatch
                ? parseInteger(
                    manaMatch[1],
                )
                : 0;

        /*
         * Standard attacks often contain the real
         * stamina cost only in the visible button text.
         *
         * Example:
         * Power Slash (10)
         */
        if (
            !Number.isFinite(stamina) ||
            stamina <= 1
        ) {
            const ending =
                button.textContent?.match(
                    /\((\d{1,3}(?:[.,\s]\d{3})+|\d+)\)\s*$/,
                );

            const visibleCost =
                ending
                    ? parseInteger(ending[1])
                    : null;

            const dataCost =
                parseInteger(
                    button.dataset.stamCost,
                );

            stamina =
                Number.isFinite(visibleCost)
                    ? visibleCost
                    : dataCost ?? 0;
        }

        return {
            stamina: stamina || 0,
            mana: mana || 0,
        };
    }

    function attackFromButton(button) {
        const name =
            button.dataset.skillName?.trim() ||
            button
                .querySelector('.skill-name')
                ?.textContent
                ?.trim() ||
            button.textContent?.trim() ||
            'Unnamed Attack';

        const skillId =
            button.dataset.skillId ?? '';

        return {
            key: `${skillId}|${name}`,
            name,

            group:
                button.closest(
                    '.class-skill-bar',
                )
                    ? 'Class Attacks'
                    : 'Standard Attacks',

            costs:
                getAttackCosts(button),
        };
    }

    /*
     * The available attacks are always read
     * directly from the current monster card.
     */
    function discoverAttacks() {
        const attacks =
            state.card
                ? queryAll(
                    SEL.attack,
                    state.card,
                ).map(attackFromButton)
                : [];

        const signature = attacks
            .map(attack => {
                return [
                    attack.key,
                    attack.costs.stamina,
                    attack.costs.mana,
                ].join(':');
            })
            .join('||');

        const changed =
            signature !==
            state.attackSignature;

        state.attackSignature =
            signature;

        state.attacks =
            attacks;

        const keys =
            Array.isArray(
                state.settings.attackKeys,
            )
                ? state.settings.attackKeys
                    .slice(0, 3)
                : ['', '', ''];

        /*
         * When a saved attack is not available
         * on the new monster, choose an attack
         * that actually exists.
         */
        for (
            let index = 0;
            index < 3;
            index += 1
        ) {
            if (
                attacks.some(
                    attack =>
                        attack.key ===
                        keys[index],
                )
            ) {
                continue;
            }

            keys[index] =
                attacks.find(
                    attack =>
                        !keys.includes(
                            attack.key,
                        ),
                )?.key ||
                attacks[index]?.key ||
                attacks[0]?.key ||
                '';
        }

        state.settings.attackKeys =
            keys;

        saveSettings();

        return changed;
    }

    function getSelectedAttack(index) {
        return (
            state.attacks.find(
                attack =>
                    attack.key ===
                    state.settings
                        .attackKeys[index],
            ) || null
        );
    }

    function findLiveAttackButton(key) {
        if (!state.card) {
            return null;
        }

        return (
            queryAll(
                SEL.attack,
                state.card,
            ).find(
                button =>
                    attackFromButton(button).key ===
                    key,
            ) || null
        );
    }

    function getPotionType(
        name,
        description,
    ) {
        const text = [
            name,
            description,
        ]
            .join(' ')
            .toLowerCase();

        if (text.includes('stamina')) {
            return 'stamina';
        }

        if (text.includes('mana')) {
            return 'mana';
        }

        if (
            /\bhp\b|health|heal/.test(text)
        ) {
            return 'health';
        }

        return 'other';
    }

    function potionFromButton(button) {
        const card =
            button.closest(
                SEL.potionCard,
            );

        const name =
            button.dataset.name?.trim() ||
            card
                ?.querySelector(
                    '.potion-name span',
                )
                ?.textContent
                ?.trim() ||
            button.textContent?.trim() ||
            'Unknown Potion';

        const description =
            card
                ?.querySelector(
                    '.potion-desc',
                )
                ?.textContent
                ?.trim() ||
            '';

        const itemId =
            button.dataset.item ||
            card?.dataset.itemId ||
            name;

        /*
         * Drawer potions use .potion-qty-left.
         * Quick-use potions use .ds-potion-count.
         */
        const quantitySources = [
            card
                ?.querySelector(
                    '.potion-qty-left',
                )
                ?.textContent,

            button
                .querySelector(
                    '.ds-potion-count',
                )
                ?.textContent,

            button.dataset.max,
        ];

        const quantity =
            quantitySources
                .map(parseInteger)
                .find(Number.isFinite) ??
            0;

        return {
            key: `${itemId}|${name}`,
            name,
            description,

            type:
                getPotionType(
                    name,
                    description,
                ),

            quantity,
        };
    }

    function discoverPotions() {
        const unique =
            new Map();

        const discovered =
            queryAll(SEL.potion)
                .map(potionFromButton)
                .filter(
                    potion =>
                        potion.type !== 'other',
                );

        /*
         * A potion can appear in both the drawer
         * and the quick-use bar. Keep one entry.
         */
        for (const potion of discovered) {
            const existing =
                unique.get(potion.key);

            if (
                !existing ||
                potion.quantity >
                existing.quantity
            ) {
                unique.set(
                    potion.key,
                    potion,
                );
            }
        }

        state.potions = [
            ...unique.values(),
        ];

        for (
            const type
            of [
                'stamina',
                'mana',
                'health',
            ]
        ) {
            const available =
                state.potions
                    .filter(
                        potion =>
                            potion.type === type,
                    )
                    .map(
                        potion => potion.key,
                    );

            const previousOrder =
                state.settings
                    .potionOrder[type] ||
                [];

            state.settings
                .potionOrder[type] = [
                    ...previousOrder.filter(
                        key =>
                            available.includes(key),
                    ),

                    ...available.filter(
                        key =>
                            !previousOrder.includes(
                                key,
                            ),
                    ),
                ];

            for (const key of available) {
                if (
                    !(
                        key in
                        state.settings
                            .potionEnabled
                    )
                ) {
                    state.settings
                        .potionEnabled[key] =
                        true;
                }
            }
        }

        saveSettings();
    }

    function findLivePotionButton(
        potion,
    ) {
        const matches =
            queryAll(SEL.potion)
                .filter(button => {
                    return (
                        potionFromButton(button)
                            .key ===
                        potion.key
                    );
                });

        /*
         * Prefer a visible quick-use button,
         * then any enabled matching button.
         */
        return (
            matches.find(
                button =>
                    !button.disabled &&
                    button.offsetParent !== null,
            ) ||
            matches.find(
                button =>
                    !button.disabled,
            ) ||
            matches[0] ||
            null
        );
    }

    function isElementVisible(element) {
        if (!element || !element.isConnected) {
            return false;
        }

        const style = getComputedStyle(element);
        const rectangle =
            element.getBoundingClientRect();

        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0 &&
            rectangle.width > 0 &&
            rectangle.height > 0
        );
    }

    /*
     * Finds confirmation buttons inside common modal systems.
     *
     * Supported examples:
     * - SweetAlert / SweetAlert2
     * - Bootstrap modals
     * - Native-looking custom dialogs
     * - Generic role="dialog" popups
     */
    function findPotionConfirmationButton() {
        const directSelectors = [
            '.swal2-container .swal2-confirm',
            '.swal-modal .swal-button--confirm',
            '.modal.show .btn-confirm',
            '.modal.show [data-confirm="true"]',
            '.modal.show button.btn-primary',
            '[role="dialog"][aria-modal="true"] .confirm',
            '[role="dialog"][aria-modal="true"] [data-confirm]',
            '[role="dialog"][aria-modal="true"] button[type="submit"]',
            '.dialog.open .confirm',
            '.popup.open .confirm',
        ];

        for (const selector of directSelectors) {
            const button =
                queryAll(selector).find(
                    element =>
                        isElementVisible(element) &&
                        !element.disabled,
                );

            if (button) {
                return button;
            }
        }

        /*
         * Fallback for dialogs without useful classes.
         * Only buttons inside visible dialog containers are considered.
         */
        const dialogSelectors = [
            '.swal2-container',
            '.swal-overlay',
            '.modal.show',
            '[role="dialog"][aria-modal="true"]',
            '.dialog.open',
            '.popup.open',
            '.modal.active',
        ];

        const acceptedButtonTexts = [
            /^confirm$/i,
            /^yes$/i,
            /^ok$/i,
            /^okay$/i,
            /^use$/i,
            /^continue$/i,
            /^accept$/i,
            /^confirm use$/i,
            /^use potion$/i,
            /^confirm potion$/i,
        ];

        for (const dialogSelector of dialogSelectors) {
            for (
                const dialog
                of queryAll(dialogSelector)
            ) {
                if (!isElementVisible(dialog)) {
                    continue;
                }

                const buttons =
                    queryAll(
                        'button, input[type="button"], input[type="submit"]',
                        dialog,
                    );

                for (const button of buttons) {
                    if (
                        button.disabled ||
                        !isElementVisible(button)
                    ) {
                        continue;
                    }

                    const text = String(
                        button.textContent ||
                        button.value ||
                        button.getAttribute('aria-label') ||
                        '',
                    ).trim();

                    if (
                        acceptedButtonTexts.some(
                            pattern => pattern.test(text),
                        )
                    ) {
                        return button;
                    }
                }
            }
        }

        return null;
    }

    /*
     * Watches briefly for a custom confirmation modal
     * and confirms it automatically.
     */
    async function watchForPotionConfirmation(
        timeoutMs = 6000,
    ) {
        const startedAt = Date.now();

        while (
            state.running &&
            Date.now() - startedAt < timeoutMs
        ) {
            const confirmButton =
                findPotionConfirmationButton();

            if (confirmButton) {
                log(
                    'Potion confirmation detected and accepted automatically.',
                );

                confirmButton.click();

                return true;
            }

            await sleep(75);
        }

        return false;
    }

    /*
     * Temporarily accepts native JavaScript confirm() dialogs.
     *
     * The override exists only around the potion click and is
     * restored immediately afterwards.
     */
    function installTemporaryNativeConfirm() {
        const originalConfirm =
            window.confirm;

        let installed = false;

        try {
            window.confirm = message => {
                log(
                    `Potion confirmation accepted: ${String(message || 'Confirm')
                    }`,
                );

                return true;
            };

            installed = true;
        } catch (error) {
            console.warn(
                '[Monster Auto Battle] ' +
                'Could not temporarily override window.confirm.',
                error,
            );
        }

        return () => {
            if (!installed) {
                return;
            }

            try {
                window.confirm =
                    originalConfirm;
            } catch (error) {
                console.warn(
                    '[Monster Auto Battle] ' +
                    'Could not restore window.confirm.',
                    error,
                );
            }
        };
    }

    /*
     * Clicks a potion and handles both native and custom confirmations.
     */
    function clickPotionWithAutoConfirmation(
        button,
    ) {
        const restoreNativeConfirm =
            installTemporaryNativeConfirm();

        /*
         * Start watching before clicking because the modal
         * may be inserted into the DOM immediately.
         */
        void watchForPotionConfirmation(
            6000,
        );

        try {
            button.click();
        } finally {
            /*
             * Native confirm() runs synchronously during button.click().
             * A short delay also covers click handlers that use setTimeout().
             */
            setTimeout(
                restoreNativeConfirm,
                1000,
            );
        }
    }

    async function usePotion(type) {
        discoverPotions();

        const potion =
            (
                state.settings
                    .potionOrder[type] ||
                []
            )
                .map(key => {
                    return state.potions.find(
                        item =>
                            item.key === key,
                    );
                })
                .find(item => {
                    return (
                        item &&
                        item.quantity > 0 &&
                        state.settings
                            .potionEnabled[
                        item.key
                        ] !== false
                    );
                });

        if (!potion) {
            setStatus(
                `No enabled ${type} potion is available.`,
                'error',
            );

            log(
                `No ${type} potion is available.`,
            );

            return false;
        }

        const button =
            findLivePotionButton(
                potion,
            );

        if (!button) {
            log(
                `${potion.name} could not be found on the page.`,
            );

            return false;
        }

        const beforeQuantity =
            potion.quantity;

        const beforeResource =
            type === 'stamina'
                ? getCurrentStamina()
                : type === 'mana'
                    ? getCurrentMana()
                    : getCurrentHealth();

        /*
         * Use only one potion per click.
         */
        const input =
            button
                .closest('.potion-actions')
                ?.querySelector(
                    'input[type="number"]',
                );

        if (
            input &&
            !input.readOnly
        ) {
            input.value = '1';

            input.dispatchEvent(
                new Event(
                    'input',
                    {
                        bubbles: true,
                    },
                ),
            );

            input.dispatchEvent(
                new Event(
                    'change',
                    {
                        bubbles: true,
                    },
                ),
            );
        }

        log(
            `Using ${potion.name}. ` +
            `Stock before use: ` +
            `${formatNumber(
                beforeQuantity,
            )}.`,
        );

        /*
         * Store the active battle before clicking the
         * potion. This allows the script to continue
         * after a partial DOM refresh or full page reload.
         */
        state.expectingPotionRefresh =
            true;

        savePotionResumeState();

        try {
            clickPotionWithAutoConfirmation(
                button,
            );
        } catch (error) {
            state.expectingPotionRefresh =
                false;

            clearPotionResumeState();

            throw error;
        }

        const startedAt =
            Date.now();

        /*
         * Wait until the resource increases
         * or the potion quantity decreases.
         */
        while (
            state.running &&
            Date.now() - startedAt <
            7000
        ) {
            await sleep(120);

            discoverPotions();

            const refreshedPotion =
                state.potions.find(
                    item =>
                        item.key ===
                        potion.key,
                );

            const afterResource =
                type === 'stamina'
                    ? getCurrentStamina()
                    : type === 'mana'
                        ? getCurrentMana()
                        : getCurrentHealth();

            const quantityChanged =
                refreshedPotion &&
                refreshedPotion.quantity <
                beforeQuantity;

            const resourceChanged =
                Number.isFinite(
                    beforeResource,
                ) &&
                Number.isFinite(
                    afterResource,
                ) &&
                afterResource >
                beforeResource;

            if (
                quantityChanged ||
                resourceChanged
            ) {
                state.expectingPotionRefresh =
                    false;

                /*
                 * Do not clear the resume token yet.
                 * Some potion actions update the DOM first
                 * and reload the page a fraction later.
                 *
                 * The token is cleared after the next
                 * successful attack or when battle stops.
                 */
                log(
                    `${potion.name} was used successfully. Auto-battle will continue automatically.`,
                );

                renderPotionLists();
                updateMetrics();

                return true;
            }
        }

        state.expectingPotionRefresh =
            false;

        clearPotionResumeState();

        renderPotionLists();

        log(
            `${potion.name} was clicked, ` +
            `but no resource or quantity change was detected.`,
        );

        return false;
    }

    function getFeedbackText() {
        const selectors = [
            '.toast',
            '.toast-message',
            '.notification',
            '.alert',
            '.message',
            '.swal2-popup',
            '.swal2-html-container',
            '[role="alert"]',
        ];

        return selectors
            .flatMap(selector => {
                return queryAll(selector);
            })
            .filter(element => {
                return !element.closest(
                    `#${ID}`,
                );
            })
            .slice(-12)
            .map(element => {
                return element
                    .textContent
                    ?.trim();
            })
            .filter(Boolean)
            .join(' | ')
            .toLowerCase();
    }

    function classifyFeedback(text) {
        if (!text) {
            return null;
        }

        if (
            /you are dead|you died|you have died|knocked out|cannot attack.*dead|dead.*cannot attack/.test(
                text,
            )
        ) {
            return 'dead';
        }

        if (
            /not enough\s+stamina|insufficient\s+stamina|out of\s+stamina|stamina\s+(?:is\s+)?(?:empty|too low|depleted)/.test(
                text,
            )
        ) {
            return 'stamina';
        }

        if (
            /not enough\s+mana|insufficient\s+mana|out of\s+mana|mana\s+(?:is\s+)?(?:empty|too low|depleted)/.test(
                text,
            )
        ) {
            return 'mana';
        }

        if (
            /cooldown|too fast|please wait|wait before|rate limit/.test(
                text,
            )
        ) {
            return 'cooldown';
        }

        return null;
    }

    async function waitForAttackOutcome(
        beforeDamage,
        beforeFeedback,
    ) {
        const startedAt =
            Date.now();

        while (
            state.running &&
            Date.now() - startedAt <
            6500
        ) {
            await sleep(110);

            if (isMonsterDead()) {
                return {
                    type: 'monster-dead',
                };
            }

            const damage =
                getCurrentDamage();

            if (
                Number.isFinite(
                    beforeDamage,
                ) &&
                Number.isFinite(damage) &&
                damage > beforeDamage
            ) {
                return {
                    type: 'damage',

                    damage:
                        damage -
                        beforeDamage,
                };
            }

            const feedback =
                getFeedbackText();

            if (
                feedback &&
                feedback !==
                beforeFeedback
            ) {
                const type =
                    classifyFeedback(
                        feedback,
                    );

                if (type) {
                    return { type };
                }
            }
        }

        const finalFeedback =
            getFeedbackText();

        return {
            type:
                finalFeedback !==
                    beforeFeedback
                    ? classifyFeedback(
                        finalFeedback,
                    ) ||
                    'timeout'
                    : 'timeout',
        };
    }

    async function ensurePlayerIsAlive() {
        const health =
            getCurrentHealth();

        /*
         * Only an explicitly detected value
         * of zero is treated as defeat.
         */
        if (health !== 0) {
            return true;
        }

        if (
            !state.settings.autoHealth
        ) {
            stop(
                'Your health is 0 and automatic health potions are disabled.',
            );

            return false;
        }

        const used =
            await usePotion('health');

        if (!used) {
            stop(
                'You are defeated and no enabled health potion is available.',
                'error',
            );

            return false;
        }

        await sleep(650);

        return true;
    }

    /*
     * Attack priority:
     *
     * 1. Use Attack 1 whenever possible.
     * 2. If Attack 1 lacks mana, use a mana potion.
     * 3. If Attack 1 lacks stamina and stamina is not zero,
     *    try Attack 2.
     * 4. If Attack 2 also costs too much stamina,
     *    try Attack 3.
     * 5. If Attack 3 also costs too much stamina,
     *    use a stamina potion.
     */
    async function prepareNextAttack() {
        const attacksChanged =
            discoverAttacks();

        if (attacksChanged) {
            renderAttackOptions();
        }

        const attacks = [
            getSelectedAttack(0),
            getSelectedAttack(1),
            getSelectedAttack(2),
        ];

        const primary =
            attacks[0];

        if (!primary) {
            stop(
                'Attack 1 is not available on the current monster card.',
                'error',
            );

            return null;
        }

        const stamina =
            getCurrentStamina();

        const mana =
            getCurrentMana();

        /*
         * This branch is used after the server
         * reported insufficient stamina.
         */
        if (
            state.forcedAttackIndex > 0
        ) {
            let fallbackBlockedByMana =
                false;

            for (
                let index =
                    state.forcedAttackIndex;

                index < 3;

                index += 1
            ) {
                const attack =
                    attacks[index];

                if (!attack) {
                    continue;
                }

                if (
                    Number.isFinite(stamina) &&
                    stamina <
                    attack.costs.stamina
                ) {
                    continue;
                }

                if (
                    Number.isFinite(mana) &&
                    mana <
                    attack.costs.mana
                ) {
                    fallbackBlockedByMana =
                        true;

                    if (
                        !state.settings.autoMana
                    ) {
                        continue;
                    }

                    const used =
                        await usePotion('mana');

                    if (!used) {
                        stop(
                            `Attack ${index + 1} requires mana, but no enabled mana potion is available.`,
                            'error',
                        );

                        return null;
                    }

                    state.forcedAttackIndex =
                        index;

                    return {
                        retry: true,
                    };
                }

                return {
                    attack,
                    index,
                };
            }

            if (
                fallbackBlockedByMana
            ) {
                stop(
                    'A fallback attack has enough stamina but requires more mana. Enable automatic mana potions or select another fallback attack.',
                );

                return null;
            }

            if (
                !state.settings.autoStamina
            ) {
                stop(
                    'Attack 2 and Attack 3 also require more stamina. Automatic stamina potions are disabled.',
                );

                return null;
            }

            const used =
                await usePotion(
                    'stamina',
                );

            if (!used) {
                stop(
                    'No enabled stamina potion is available.',
                    'error',
                );

                return null;
            }

            state.forcedAttackIndex = 0;

            return {
                retry: true,
            };
        }

        /*
         * Attack 1 always has priority.
         * Mana is restored before switching
         * away from Attack 1.
         */
        if (
            Number.isFinite(mana) &&
            mana < primary.costs.mana
        ) {
            if (
                !state.settings.autoMana
            ) {
                stop(
                    `Attack 1 requires ` +
                    `${formatNumber(
                        primary.costs.mana,
                    )} mana, but only ` +
                    `${formatNumber(
                        mana,
                    )} is available.`,
                );

                return null;
            }

            const used =
                await usePotion('mana');

            if (!used) {
                stop(
                    'Attack 1 requires mana, but no enabled mana potion is available.',
                    'error',
                );

                return null;
            }

            return {
                retry: true,
            };
        }

        /*
         * When stamina cannot be read,
         * attempt Attack 1 and rely on
         * the server response if necessary.
         */
        if (
            !Number.isFinite(stamina) ||
            stamina >=
            primary.costs.stamina
        ) {
            return {
                attack: primary,
                index: 0,
            };
        }

        let fallbackBlockedByMana =
            false;

        /*
         * Attack 2 and Attack 3 are checked
         * only while stamina is above zero.
         */
        if (stamina > 0) {
            for (
                let index = 1;
                index <= 2;
                index += 1
            ) {
                const attack =
                    attacks[index];

                if (!attack) {
                    continue;
                }

                if (
                    stamina <
                    attack.costs.stamina
                ) {
                    continue;
                }

                if (
                    Number.isFinite(mana) &&
                    mana <
                    attack.costs.mana
                ) {
                    fallbackBlockedByMana =
                        true;

                    if (
                        !state.settings.autoMana
                    ) {
                        continue;
                    }

                    const used =
                        await usePotion('mana');

                    if (!used) {
                        stop(
                            `Attack ${index + 1} has enough stamina but requires mana, and no enabled mana potion is available.`,
                            'error',
                        );

                        return null;
                    }

                    state.forcedAttackIndex =
                        index;

                    return {
                        retry: true,
                    };
                }

                log(
                    `Attack 1 is too expensive. ` +
                    `Using Attack ${index + 1}: ` +
                    `${attack.name}.`,
                );

                return {
                    attack,
                    index,
                };
            }
        }

        if (
            fallbackBlockedByMana
        ) {
            stop(
                'A fallback attack has enough stamina but requires more mana. Enable automatic mana potions or select another fallback attack.',
            );

            return null;
        }

        /*
         * Only after all three attacks fail
         * because of stamina is a stamina
         * potion used.
         */
        if (
            !state.settings.autoStamina
        ) {
            stop(
                `Current stamina ` +
                `(${formatNumber(
                    stamina,
                )}) is not enough for any selected attack, and automatic stamina potions are disabled.`,
            );

            return null;
        }

        const used =
            await usePotion('stamina');

        if (!used) {
            stop(
                'Stamina is too low and no enabled stamina potion is available.',
                'error',
            );

            return null;
        }

        state.forcedAttackIndex = 0;

        return {
            retry: true,
        };
    }

    async function handleFailedAttack(
        outcome,
        attackIndex,
    ) {
        if (
            outcome.type ===
            'monster-dead'
        ) {
            stop(
                'Monster defeated.',
                'success',
            );

            return;
        }

        if (
            outcome.type === 'dead'
        ) {
            if (
                !state.settings.autoHealth
            ) {
                stop(
                    'You are defeated and automatic health potions are disabled.',
                );

                return;
            }

            const used =
                await usePotion(
                    'health',
                );

            if (!used) {
                stop(
                    'No enabled health potion is available.',
                    'error',
                );
            } else {
                await sleep(650);
            }

            return;
        }

        if (
            outcome.type === 'mana'
        ) {
            if (
                !state.settings.autoMana
            ) {
                stop(
                    'Not enough mana and automatic mana potions are disabled.',
                );

                return;
            }

            const used =
                await usePotion('mana');

            if (!used) {
                stop(
                    'No enabled mana potion is available.',
                    'error',
                );
            } else {
                state.forcedAttackIndex =
                    attackIndex;

                await sleep(650);
            }

            return;
        }

        if (
            outcome.type === 'stamina'
        ) {
            const stamina =
                getCurrentStamina();

            const nextAttack =
                attackIndex < 2
                    ? getSelectedAttack(
                        attackIndex + 1,
                    )
                    : null;

            /*
             * If stamina is not explicitly zero,
             * try the next fallback attack first.
             */
            if (
                stamina !== 0 &&
                nextAttack
            ) {
                state.forcedAttackIndex =
                    attackIndex + 1;

                log(
                    `Attack ${attackIndex + 1} failed because of stamina. ` +
                    `Trying Attack ${attackIndex + 2}.`,
                );

                return;
            }

            if (
                !state.settings.autoStamina
            ) {
                stop(
                    'Not enough stamina and automatic stamina potions are disabled.',
                );

                return;
            }

            const used =
                await usePotion(
                    'stamina',
                );

            if (!used) {
                stop(
                    'No enabled stamina potion is available.',
                    'error',
                );
            } else {
                state.forcedAttackIndex =
                    0;

                await sleep(650);
            }

            return;
        }

        if (
            outcome.type === 'cooldown'
        ) {
            log(
                'The server reported a cooldown. Waiting longer.',
            );

            await sleep(
                Math.max(
                    1600,
                    state.settings.delayMs,
                ),
            );

            return;
        }

        state.noDamageCount += 1;

        if (
            state.noDamageCount >= 2
        ) {
            stop(
                'No damage was detected twice. Safety stop activated.',
                'error',
            );
        } else {
            log(
                'No damage was detected. One retry will be attempted.',
            );

            await sleep(
                Math.max(
                    1200,
                    state.settings.delayMs,
                ),
            );
        }
    }

    function readForm() {
        if (!state.panel) {
            return;
        }

        state.settings.attackKeys = [
            1,
            2,
            3,
        ].map(
            (number, index) => {
                return (
                    state.panel
                        .querySelector(
                            `#mabAttack${number}`,
                        )
                        ?.value ||
                    state.settings
                        .attackKeys[index] ||
                    ''
                );
            },
        );

        state.settings.targetDamage =
            state.panel
                .querySelector('#mabTarget')
                ?.value
                .trim() ||
            '0';

        state.settings.delayMs =
            Math.max(
                600,

                Number(
                    state.panel
                        .querySelector(
                            '#mabDelay',
                        )
                        ?.value,
                ) ||
                1200,
            );

        state.settings.autoStamina =
            state.panel
                .querySelector(
                    '#mabAutoStamina',
                )
                .checked;

        state.settings.autoMana =
            state.panel
                .querySelector(
                    '#mabAutoMana',
                )
                .checked;

        state.settings.autoHealth =
            state.panel
                .querySelector(
                    '#mabAutoHealth',
                )
                .checked;

        state.settings
            .stopBeforeLevelUp =
            state.panel
                .querySelector(
                    '#mabLevelGuard',
                )
                .checked;

        state.settings.levelMultiplier =
            Number(
                state.panel
                    .querySelector(
                        '#mabMultiplier',
                    )
                    .value,
            ) ||
            2;

        saveSettings();
    }

    function validateSettings() {
        const target =
            parseTarget(
                state.settings
                    .targetDamage,
            );

        if (
            !Number.isFinite(target) ||
            target < 0
        ) {
            setStatus(
                'Invalid target damage. Examples: 5m, 5b, or 5,000,000.',
                'error',
            );

            return false;
        }

        if (
            !(
                state.settings
                    .levelMultiplier > 0
            )
        ) {
            setStatus(
                'The level-up multiplier must be greater than 0.',
                'error',
            );

            return false;
        }

        for (
            let index = 0;
            index < 3;
            index += 1
        ) {
            const attack =
                getSelectedAttack(index);

            if (
                !attack ||
                !findLiveAttackButton(
                    attack.key,
                )
            ) {
                setStatus(
                    `Please select a valid Attack ${index + 1}.`,
                    'error',
                );

                return false;
            }
        }

        return true;
    }

    async function runAutoBattle(resumeData = null,) {
        /*
 * A click event may be passed when the function
 * is used directly as an event listener.
 */
        if (resumeData instanceof Event) {
            resumeData = null;
        }
        if (state.running) {
            return;
        }

        readForm();
        discoverAttacks();
        discoverPotions();

        renderAttackOptions();
        renderPotionLists();

        if (!validateSettings()) {
            return;
        }

        const currentMonsterKey =
            getMonsterKey();

        if (
            resumeData?.monsterKey &&
            resumeData.monsterKey !==
            currentMonsterKey
        ) {
            clearPotionResumeState();

            setStatus(
                'Auto-battle could not resume because the monster changed.',
                'error',
            );

            return;
        }

        state.monsterKey =
            currentMonsterKey;

        if (resumeData) {
            state.sessionDamage =
                Number.isFinite(
                    Number(
                        resumeData.sessionDamage,
                    ),
                )
                    ? Number(
                        resumeData.sessionDamage,
                    )
                    : 0;

            state.lastDamage =
                Number.isFinite(
                    Number(
                        resumeData.lastDamage,
                    ),
                )
                    ? Number(
                        resumeData.lastDamage,
                    )
                    : 0;

            state.lastExperienceGain =
                resumeData
                    .lastExperienceGain == null
                    ? null
                    : Number.isFinite(
                        Number(
                            resumeData
                                .lastExperienceGain,
                        ),
                    )
                        ? Number(
                            resumeData
                                .lastExperienceGain,
                        )
                        : null;

            state.noDamageCount = 0;
            state.forcedAttackIndex = 0;
        } else {
            /*
             * A manually started battle must not inherit
             * an old potion-resume token.
             */
            clearPotionResumeState();

            state.sessionDamage = 0;
            state.lastDamage = 0;
            state.lastExperienceGain = null;
            state.noDamageCount = 0;
            state.forcedAttackIndex = 0;
        }

        state.running = true;

        updateButtons();
        updateMetrics();

        setStatus(
            resumeData
                ? 'Auto-battle resumed after potion use.'
                : 'Auto-battle is running.',
            'running',
        );

        log(
            `Started with ` +
            `${formatNumber(
                getCurrentDamage() || 0,
            )} damage already dealt.`,
        );

        try {
            while (state.running) {
                /*
                 * The automation applies only
                 * to the monster it was started on.
                 */
                if (
                    !state.card
                        ?.isConnected ||
                    getMonsterKey() !==
                    state.monsterKey
                ) {
                    stop(
                        'The monster card changed. Auto-battle was stopped.',
                    );

                    break;
                }

                if (isMonsterDead()) {
                    stop(
                        'Monster defeated.',
                        'success',
                    );

                    break;
                }

                const target =
                    parseTarget(
                        state.settings
                            .targetDamage,
                    );

                if (
                    target > 0 &&
                    state.sessionDamage >=
                    target
                ) {
                    stop(
                        `Target damage of ` +
                        `${formatNumber(
                            target,
                        )} was reached.`,
                        'success',
                    );

                    break;
                }

                /*
                 * Level-up protection uses:
                 *
                 * remaining EXP <
                 * last damage × multiplier
                 */
                if (
                    state.settings
                        .stopBeforeLevelUp &&
                    Number.isFinite(
                        state.lastExperienceGain,
                    ) &&
                    state.lastExperienceGain > 0
                ) {
                    const remaining =
                        getRemainingExperience();

                    if (
                        !Number.isFinite(
                            remaining,
                        )
                    ) {
                        stop(
                            'Remaining EXP could not be read. Level-up protection stopped the script for safety.',
                            'error',
                        );

                        break;
                    }

                    /*
                     * Stop threshold:
                     *
                     * EXP gained by the last attack
                     * multiplied by the configured factor.
                     */
                    const stopThreshold =
                        state.lastExperienceGain *
                        state.settings
                            .levelMultiplier;

                    if (
                        remaining <
                        stopThreshold
                    ) {
                        stop(
                            `Level-up protection: ` +
                            `${formatNumber(
                                remaining,
                            )} EXP remains. ` +
                            `The last attack granted ` +
                            `${formatNumber(
                                state.lastExperienceGain,
                            )} EXP, resulting in a stop threshold of ` +
                            `${formatNumber(
                                stopThreshold,
                            )} EXP.`,
                            'success',
                        );

                        break;
                    }
                }

                if (
                    !await ensurePlayerIsAlive()
                ) {
                    break;
                }

                const prepared =
                    await prepareNextAttack();

                if (
                    !state.running ||
                    !prepared
                ) {
                    break;
                }

                /*
                 * After using a potion,
                 * read all resources and
                 * attack choices again.
                 */
                if (prepared.retry) {
                    await sleep(500);

                    continue;
                }

                const button =
                    findLiveAttackButton(
                        prepared.attack.key,
                    );

                if (!button) {
                    stop(
                        `Attack ${prepared.index + 1} is no longer available.`,
                        'error',
                    );

                    break;
                }

                if (
                    button.disabled ||
                    button.getAttribute(
                        'aria-disabled',
                    ) === 'true'
                ) {
                    state.noDamageCount += 1;

                    if (
                        state.noDamageCount >= 3
                    ) {
                        stop(
                            'The selected attack button remained disabled.',
                            'error',
                        );

                        break;
                    }

                    log(
                        `Attack ${prepared.index + 1} is disabled. Waiting briefly.`,
                    );

                    await sleep(
                        Math.max(
                            1200,
                            state.settings.delayMs,
                        ),
                    );

                    continue;
                }

                const beforeDamage =
                    getCurrentDamage();

                /*
                 * Save the current EXP immediately before
                 * clicking the attack button.
                 */
                const beforeExperience =
                    getExperienceProgress();

                const beforeFeedback =
                    getFeedbackText();

                log(
                    `Attack ${prepared.index + 1}: ` +
                    `${prepared.attack.name}.`,
                );

                button.click();

                const outcome =
                    await waitForAttackOutcome(
                        beforeDamage,
                        beforeFeedback,
                    );

                if (!state.running) {
                    break;
                }

                if (
                    outcome.type ===
                    'damage'
                ) {
                    /*
                     * The battle successfully continued after
                     * the potion. The reload token is no longer needed.
                     */
                    clearPotionResumeState();

                    state.expectingPotionRefresh =
                        false;

                    state.noDamageCount = 0;
                    state.forcedAttackIndex = 0;

                    state.lastDamage =
                        Math.max(
                            0,
                            outcome.damage || 0,
                        );

                    state.sessionDamage +=
                        state.lastDamage;

                    /*
                     * Wait for the EXP value in the topbar
                     * to update after the successful attack.
                     */
                    const afterExperience =
                        await waitForExperienceUpdate(
                            beforeExperience,
                        );

                    state.lastExperienceGain =
                        calculateExperienceGain(
                            beforeExperience,
                            afterExperience,
                        );

                    if (
                        Number.isFinite(
                            state.lastExperienceGain,
                        )
                    ) {
                        log(
                            `Hit dealt ` +
                            `${formatNumber(
                                state.lastDamage,
                            )} damage and granted ` +
                            `${formatNumber(
                                state.lastExperienceGain,
                            )} EXP.`,
                        );
                    } else {
                        log(
                            `Hit dealt ` +
                            `${formatNumber(
                                state.lastDamage,
                            )} damage, but the EXP gain ` +
                            `could not be determined.`,
                        );

                        /*
                         * The level-up guard cannot safely continue
                         * without knowing the last EXP gain.
                         */
                        if (
                            state.settings
                                .stopBeforeLevelUp
                        ) {
                            stop(
                                'The EXP gain from the last attack could not be determined. Level-up protection stopped the script for safety.',
                                'error',
                            );

                            break;
                        }
                    }

                    updateMetrics();
                } else {
                    await handleFailedAttack(
                        outcome,
                        prepared.index,
                    );
                }

                if (state.running) {
                    await sleep(
                        Math.max(
                            600,
                            state.settings.delayMs,
                        ),
                    );
                }
            }
        } catch (error) {
            console.error(
                '[Monster Auto Battle]',
                error,
            );

            stop(
                `Error: ` +
                `${error?.message || error}`,
                'error',
            );
        } finally {
            state.running = false;

            updateButtons();
            updateMetrics();
        }
    }

    function stop(
        message = 'Stopped manually.',
        tone = 'idle',
    ) {
        state.running = false;

        state.expectingPotionRefresh =
            false;

        /*
         * Manual stops, errors, target completion and
         * monster deaths must cancel automatic resuming.
         */
        clearPotionResumeState();

        setStatus(
            message,
            tone,
        );

        log(message);
        updateButtons();
    }

    function injectStyles() {
        if (
            document.getElementById(
                `${ID}-style`,
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                'style',
            );

        style.id =
            `${ID}-style`;

        style.textContent = `
      #${ID} {
        margin-top: 14px;
        color: #dfe6ff;
        font-family: inherit;
      }

      #${ID} * {
        box-sizing: border-box;
      }

      #${ID} details.mab-main {
        overflow: hidden;
        border: 1px solid #384063;
        border-radius: 14px;
        background: #111322;
        box-shadow: 0 10px 28px rgba(0,0,0,.4);
      }

      #${ID} .mab-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 14px;
        cursor: pointer;
        list-style: none;
        background: #1d2138;
        font-weight: 800;
        user-select: none;
      }

      #${ID} .mab-header::-webkit-details-marker {
        display: none;
      }

      #${ID} .mab-note {
        color: #9aa7d7;
        font-size: 10px;
        text-transform: uppercase;
      }

      #${ID} .mab-body {
        padding: 13px;
      }

      #${ID} .mab-grid,
      #${ID} .mab-priority-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }

      #${ID} .mab-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
        color: #cfd6f7;
        font-size: 12px;
        font-weight: 700;
      }

      #${ID} small {
        color: #8f99c2;
      }

      #${ID} select,
      #${ID} input[type="text"],
      #${ID} input[type="number"] {
        width: 100%;
        min-height: 36px;
        padding: 7px 9px;
        border: 1px solid #3a4163;
        border-radius: 9px;
        outline: none;
        background: #0e1020;
        color: #eef1ff;
      }

      #${ID} select:focus,
      #${ID} input:focus {
        border-color: #7488ff;
        box-shadow:
          0 0 0 2px
          rgba(116,136,255,.16);
      }

      #${ID} .mab-options,
      #${ID} .mab-level-guard {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 15px;
        margin: 12px 0;
        padding: 10px;
        border: 1px solid #2e3452;
        border-radius: 10px;
        background: #14172a;
        font-size: 12px;
      }

      #${ID} .mab-level-guard {
        border-color: #594c2f;
        background: #211d16;
      }

      #${ID} .mab-level-guard input[type="number"] {
        width: 80px;
        min-height: 30px;
      }

      #${ID} input[type="checkbox"] {
        accent-color: #7185ff;
      }

      #${ID} fieldset,
      #${ID} .mab-health-box {
        min-width: 0;
        margin: 0;
        padding: 9px;
        border: 1px solid #2f3554;
        border-radius: 10px;
        background: #121526;
      }

      #${ID} .mab-health-box {
        margin-top: 10px;
      }

      #${ID} legend,
      #${ID} .mab-health-box > strong {
        color: #bfc8f5;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
      }

      #${ID} .mab-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 7px;
      }

      #${ID} .mab-potion-row {
        display: grid;
        grid-template-columns:
          auto
          minmax(0,1fr)
          auto
          auto;
        align-items: center;
        gap: 6px;
        padding: 5px 6px;
        border: 1px solid #2a304c;
        border-radius: 8px;
        background: #191c30;
      }

      #${ID} .mab-potion-name {
        overflow: hidden;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${ID} .mab-quantity {
        color: #98a4d2;
        font-size: 10px;
        font-variant-numeric:
          tabular-nums;
      }

      #${ID} .mab-moves {
        display: flex;
        gap: 4px;
      }

      #${ID} .mab-move {
        width: 25px;
        height: 25px;
        padding: 0;
        border: 1px solid #3a4267;
        border-radius: 6px;
        background: #242943;
        color: #e3e8ff;
        cursor: pointer;
      }

      #${ID} .mab-move:disabled {
        opacity: .35;
        cursor: default;
      }

      #${ID} .mab-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      #${ID} .mab-button {
        padding: 8px 12px;
        border: 1px solid transparent;
        border-radius: 9px;
        color: #fff;
        font-weight: 800;
        cursor: pointer;
      }

      #${ID} .mab-button:disabled {
        opacity: .45;
        cursor: default;
      }

      #${ID} .mab-start {
        border-color: #35845e;
        background: #245d42;
      }

      #${ID} .mab-stop {
        border-color: #9a3b45;
        background: #6e2930;
      }

      #${ID} .mab-secondary {
        border-color: #3b4267;
        background: #252a43;
      }

      #${ID} .mab-status {
        margin-top: 10px;
        padding: 9px 10px;
        border: 1px solid #343a59;
        border-radius: 9px;
        background: #171a2b;
        font-size: 12px;
        font-weight: 700;
      }

      #${ID} .mab-status-running {
        border-color: #3d765d;
        background: #17271f;
        color: #b8f0cf;
      }

      #${ID} .mab-status-success {
        border-color: #476d85;
        background: #16242d;
        color: #c8ebff;
      }

      #${ID} .mab-status-error {
        border-color: #7e3b45;
        background: #2a171b;
        color: #ffc5cb;
      }

      #${ID} .mab-metrics {
        display: grid;
        grid-template-columns:
          repeat(
            4,
            minmax(0,1fr)
          );
        gap: 7px;
        margin-top: 10px;
      }

      #${ID} .mab-metrics > div {
        padding: 8px;
        border: 1px solid #2d3350;
        border-radius: 9px;
        background: #111423;
      }

      #${ID} .mab-metrics span {
        display: block;
        color: #8792bd;
        font-size: 9px;
        text-transform: uppercase;
      }

      #${ID} .mab-metrics strong {
        display: block;
        margin-top: 3px;
        font-size: 12px;
        font-variant-numeric:
          tabular-nums;
      }

      #${ID} .mab-log {
        max-height: 145px;
        overflow: auto;
        margin-top: 6px;
        padding: 7px;
        border: 1px solid #292f4b;
        border-radius: 8px;
        background: #0d0f1b;
        color: #aeb8df;
        font:
          11px
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Consolas,
          monospace;
      }

      #${ID} .mab-log > div + div {
        margin-top: 4px;
      }

      #${ID} .mab-empty,
      #${ID} .mab-hint {
        color: #7883aa;
        font-size: 10px;
        line-height: 1.45;
      }

      #${ID} .mab-hint {
        margin-top: 9px;
      }

      @media (max-width: 760px) {
        #${ID} .mab-grid,
        #${ID} .mab-priority-grid,
        #${ID} .mab-metrics {
          grid-template-columns: 1fr;
        }
      }
    `;

        document.head.appendChild(
            style,
        );
    }

    function createPanel() {
        const panel =
            document.createElement(
                'section',
            );

        panel.id = ID;

        panel.innerHTML = `
      <details
        class="mab-main"
        ${state.settings.collapsed
                ? ''
                : 'open'}
      >
        <summary class="mab-header">
          <span>🤖 Auto Battle</span>

          <span class="mab-note">
            Current monster only
          </span>
        </summary>

        <div class="mab-body">
          <div class="mab-grid">
            <label class="mab-field">
              <span>
                Attack 1
                <small>
                  Primary attack
                </small>
              </span>

              <select
                id="mabAttack1"
              ></select>
            </label>

            <label class="mab-field">
              <span>
                Attack 2
                <small>
                  First stamina fallback
                </small>
              </span>

              <select
                id="mabAttack2"
              ></select>
            </label>

            <label class="mab-field">
              <span>
                Attack 3
                <small>
                  Second stamina fallback
                </small>
              </span>

              <select
                id="mabAttack3"
              ></select>
            </label>

            <label class="mab-field">
              <span>
                Target damage
                <small>
                  0 means unlimited
                </small>
              </span>

              <input
                id="mabTarget"
                type="text"
                value="${escapeHtml(
                    state.settings
                        .targetDamage,
                )}"
                placeholder="5b or 5,000,000,000"
              >
            </label>

            <label class="mab-field">
              <span>
                Delay between attacks in ms
              </span>

              <input
                id="mabDelay"
                type="number"
                min="600"
                step="100"
                value="${state.settings.delayMs}"
              >
            </label>
          </div>

          <div class="mab-options">
            <label>
              <input
                id="mabAutoStamina"
                type="checkbox"
                ${state.settings.autoStamina
                ? 'checked'
                : ''}
              >

              Use stamina potions automatically
            </label>

            <label>
              <input
                id="mabAutoMana"
                type="checkbox"
                ${state.settings.autoMana
                ? 'checked'
                : ''}
              >

              Use mana potions automatically
            </label>

            <label>
              <input
                id="mabAutoHealth"
                type="checkbox"
                ${state.settings.autoHealth
                ? 'checked'
                : ''}
              >

              Use a full health potion when defeated
            </label>
          </div>

          <div class="mab-level-guard">
            <label>
              <input
                id="mabLevelGuard"
                type="checkbox"
                ${state.settings.stopBeforeLevelUp
                ? 'checked'
                : ''}
              >

              Stop before level-up
            </label>

            <span>
              when remaining EXP is lower than
            </span>

            <input
              id="mabMultiplier"
              type="number"
              min="0.1"
              step="0.1"
              value="${state.settings.levelMultiplier}"
            >

            <span>
              × the last damage
            </span>
          </div>

          <div class="mab-priority-grid">
            <fieldset>
              <legend>
                Stamina potion priority
              </legend>

              <div
                id="mabStaminaList"
                class="mab-list"
              ></div>
            </fieldset>

            <fieldset>
              <legend>
                Mana potion priority
              </legend>

              <div
                id="mabManaList"
                class="mab-list"
              ></div>
            </fieldset>
          </div>

          <div class="mab-health-box">
            <strong>
              Health potions
            </strong>

            <div
              id="mabHealthList"
              class="mab-list"
            ></div>
          </div>

          <div class="mab-controls">
            <button
              id="mabStart"
              class="mab-button mab-start"
              type="button"
            >
              ▶ Start
            </button>

            <button
              id="mabStop"
              class="mab-button mab-stop"
              type="button"
              disabled
            >
              ■ Stop
            </button>

            <button
              id="mabRefresh"
              class="mab-button mab-secondary"
              type="button"
            >
              ↻ Refresh attacks and potions
            </button>
          </div>

          <div
            id="mabStatus"
            class="mab-status"
          >
            Ready.
          </div>

          <div class="mab-metrics">
            <div>
              <span>
                Session damage
              </span>

              <strong
                id="mabSession"
              >
                0
              </strong>
            </div>

            <div>
              <span>
                 Last EXP gain
              </span>

              <strong
                id="mabLast"
              >
                0
              </strong>
            </div>

            <div>
              <span>
                Remaining EXP
              </span>

              <strong
                id="mabExp"
              >
                —
              </strong>
            </div>

            <div>
              <span>
                Stamina / Mana / HP
              </span>

              <strong
                id="mabResources"
              >
                — / — / —
              </strong>
            </div>
          </div>

          <details>
            <summary>
              Log
            </summary>

            <div
              id="mabLog"
              class="mab-log"
            ></div>
          </details>

          <div class="mab-hint">
            Attack choices are re-read from the current
            monster card before every attack. Attack 2
            and Attack 3 are stamina fallbacks.
          </div>
        </div>
      </details>
    `;

        return panel;
    }

    function renderAttackOptions() {
        if (!state.panel) {
            return;
        }

        for (
            let index = 0;
            index < 3;
            index += 1
        ) {
            const select =
                state.panel.querySelector(
                    `#mabAttack${index + 1}`,
                );

            if (!select) {
                continue;
            }

            select.replaceChildren();

            for (
                const groupName
                of [
                    'Standard Attacks',
                    'Class Attacks',
                ]
            ) {
                const attacks =
                    state.attacks.filter(
                        attack =>
                            attack.group ===
                            groupName,
                    );

                if (!attacks.length) {
                    continue;
                }

                const group =
                    document.createElement(
                        'optgroup',
                    );

                group.label =
                    groupName;

                for (
                    const attack
                    of attacks
                ) {
                    const option =
                        document.createElement(
                            'option',
                        );

                    const costs = [];

                    if (
                        attack.costs.stamina
                    ) {
                        costs.push(
                            `${formatNumber(
                                attack.costs
                                    .stamina,
                            )} STA`,
                        );
                    }

                    if (
                        attack.costs.mana
                    ) {
                        costs.push(
                            `${formatNumber(
                                attack.costs.mana,
                            )} MP`,
                        );
                    }

                    option.value =
                        attack.key;

                    option.textContent =
                        costs.length
                            ? `${attack.name} · ` +
                            costs.join(' / ')
                            : attack.name;

                    option.selected =
                        attack.key ===
                        state.settings
                            .attackKeys[index];

                    group.appendChild(
                        option,
                    );
                }

                select.appendChild(
                    group,
                );
            }
        }
    }

    function renderPotionLists() {
        if (!state.panel) {
            return;
        }

        discoverPotions();

        renderPotionList(
            'stamina',
            '#mabStaminaList',
        );

        renderPotionList(
            'mana',
            '#mabManaList',
        );

        renderPotionList(
            'health',
            '#mabHealthList',
        );
    }

    function renderPotionList(
        type,
        selector,
    ) {
        const container =
            state.panel
                .querySelector(selector);

        if (!container) {
            return;
        }

        container.replaceChildren();

        const potions =
            (
                state.settings
                    .potionOrder[type] ||
                []
            )
                .map(key => {
                    return state.potions.find(
                        potion =>
                            potion.key === key,
                    );
                })
                .filter(Boolean);

        if (!potions.length) {
            const empty =
                document.createElement(
                    'div',
                );

            empty.className =
                'mab-empty';

            empty.textContent =
                'No matching potion was found.';

            container.appendChild(
                empty,
            );

            return;
        }

        potions.forEach(
            (potion, index) => {
                const row =
                    document.createElement(
                        'div',
                    );

                row.className =
                    'mab-potion-row';

                const enabled =
                    document.createElement(
                        'input',
                    );

                enabled.type =
                    'checkbox';

                enabled.checked =
                    state.settings
                        .potionEnabled[
                    potion.key
                    ] !== false;

                enabled.title =
                    'Allow this potion';

                enabled.addEventListener(
                    'change',
                    () => {
                        state.settings
                            .potionEnabled[
                            potion.key
                        ] =
                            enabled.checked;

                        saveSettings();
                    },
                );

                const name =
                    document.createElement(
                        'div',
                    );

                name.className =
                    'mab-potion-name';

                name.textContent =
                    potion.name;

                name.title =
                    potion.description;

                const quantity =
                    document.createElement(
                        'div',
                    );

                quantity.className =
                    'mab-quantity';

                quantity.textContent =
                    `×${formatNumber(
                        potion.quantity,
                    )}`;

                const moves =
                    document.createElement(
                        'div',
                    );

                moves.className =
                    'mab-moves';

                const up =
                    document.createElement(
                        'button',
                    );

                const down =
                    document.createElement(
                        'button',
                    );

                for (
                    const button
                    of [up, down]
                ) {
                    button.type =
                        'button';

                    button.className =
                        'mab-move';
                }

                up.textContent = '↑';
                up.title =
                    'Increase priority';

                up.disabled =
                    index === 0;

                down.textContent = '↓';
                down.title =
                    'Decrease priority';

                down.disabled =
                    index ===
                    potions.length - 1;

                up.addEventListener(
                    'click',
                    () => {
                        movePotion(
                            type,
                            index,
                            -1,
                        );
                    },
                );

                down.addEventListener(
                    'click',
                    () => {
                        movePotion(
                            type,
                            index,
                            1,
                        );
                    },
                );

                moves.append(
                    up,
                    down,
                );

                row.append(
                    enabled,
                    name,
                    quantity,
                    moves,
                );

                container.appendChild(
                    row,
                );
            },
        );
    }

    function movePotion(
        type,
        index,
        direction,
    ) {
        const order =
            state.settings
                .potionOrder[type];

        const target =
            index + direction;

        if (
            !order ||
            target < 0 ||
            target >= order.length
        ) {
            return;
        }

        [
            order[index],
            order[target],
        ] = [
                order[target],
                order[index],
            ];

        saveSettings();
        renderPotionLists();
    }

    function setStatus(
        message,
        tone = 'idle',
    ) {
        const element =
            state.panel
                ?.querySelector(
                    '#mabStatus',
                );

        if (!element) {
            return;
        }

        element.textContent =
            message;

        element.className =
            `mab-status ` +
            `mab-status-${tone}`;
    }

    function log(message) {
        const container =
            state.panel
                ?.querySelector(
                    '#mabLog',
                );

        if (!container) {
            return;
        }

        const line =
            document.createElement(
                'div',
            );

        line.textContent =
            `[${new Date()
                .toLocaleTimeString(
                    'en-GB',
                )}] ${message}`;

        container.prepend(line);

        while (
            container.children.length >
            60
        ) {
            container
                .lastElementChild
                ?.remove();
        }
    }

    function updateButtons() {
        if (!state.panel) {
            return;
        }

        state.panel
            .querySelector(
                '#mabStart',
            )
            .disabled =
            state.running;

        state.panel
            .querySelector(
                '#mabStop',
            )
            .disabled =
            !state.running;
    }

    function updateMetrics() {
        if (!state.panel) {
            return;
        }

        state.panel
            .querySelector(
                '#mabSession',
            )
            .textContent =
            formatNumber(
                state.sessionDamage,
            );

        state.panel
            .querySelector(
                '#mabLast',
            )
            .textContent =
            Number.isFinite(
                state.lastExperienceGain,
            )
                ? formatNumber(
                    state.lastExperienceGain,
                )
                : '—';

        const remainingExperience =
            getRemainingExperience();

        state.panel
            .querySelector('#mabExp')
            .textContent =
            Number.isFinite(
                remainingExperience,
            )
                ? formatNumber(
                    remainingExperience,
                )
                : '—';

        const stamina =
            getCurrentStamina();

        const mana =
            getCurrentMana();

        const health =
            getCurrentHealth();

        state.panel
            .querySelector(
                '#mabResources',
            )
            .textContent = [
                stamina,
                mana,
                health,
            ]
                .map(value => {
                    return Number.isFinite(
                        value,
                    )
                        ? formatNumber(value)
                        : '—';
                })
                .join(' / ');
    }

    function bindEvents() {
        const details =
            state.panel
                .querySelector(
                    '.mab-main',
                );

        details.addEventListener(
            'toggle',
            () => {
                state.settings.collapsed =
                    !details.open;

                saveSettings();
            },
        );

        state.panel
            .querySelector(
                '#mabStart',
            )
            .addEventListener(
                'click',
                () => {
                    void runAutoBattle();
                },
            );

        state.panel
            .querySelector(
                '#mabStop',
            )
            .addEventListener(
                'click',
                () => {
                    stop();
                },
            );

        state.panel
            .querySelector(
                '#mabRefresh',
            )
            .addEventListener(
                'click',
                () => {
                    discoverAttacks();
                    discoverPotions();

                    renderAttackOptions();
                    renderPotionLists();
                    updateMetrics();

                    setStatus(
                        'Attacks and potions were refreshed.',
                        'success',
                    );
                },
            );

        const formSelectors = [
            '#mabAttack1',
            '#mabAttack2',
            '#mabAttack3',
            '#mabTarget',
            '#mabDelay',
            '#mabAutoStamina',
            '#mabAutoMana',
            '#mabAutoHealth',
            '#mabLevelGuard',
            '#mabMultiplier',
        ];

        for (
            const selector
            of formSelectors
        ) {
            const element =
                state.panel.querySelector(
                    selector,
                );

            element.addEventListener(
                'change',
                readForm,
            );

            if (
                element.matches(
                    'input[type="text"], ' +
                    'input[type="number"]',
                )
            ) {
                element.addEventListener(
                    'input',
                    readForm,
                );
            }
        }
    }

    function mount() {
        const card =
            findMonsterCard();

        if (!card) {
            return;
        }

        if (
            state.panel?.isConnected &&
            state.card === card
        ) {
            return;
        }

        const incomingMonsterKey =
            getMonsterKey(card);

        const sameRunningMonster =
            state.running &&
            state.monsterKey &&
            incomingMonsterKey ===
            state.monsterKey;

        /*
         * A potion may rebuild the monster card.
         * Continue when it is still the same monster.
         */
        if (
            state.running &&
            !sameRunningMonster
        ) {
            stop(
                'The monster changed. Auto-battle was stopped.',
            );
        }

        document
            .getElementById(ID)
            ?.remove();

        state.card = card;
        state.attackSignature = '';

        discoverAttacks();
        discoverPotions();
        injectStyles();

        state.panel =
            createPanel();

        /*
         * Append the controller to the bottom
         * of the current monster card.
         */
        card.appendChild(
            state.panel,
        );

        bindEvents();
        renderAttackOptions();
        renderPotionLists();
        updateButtons();
        updateMetrics();

        if (sameRunningMonster) {
            setStatus(
                'Battle card refreshed after potion use. Auto-battle is continuing.',
                'running',
            );

            log(
                'The battle card was refreshed, but the same monster is still active. Continuing automatically.',
            );
        } else {
            setStatus(
                'Ready. This configuration applies only to the currently visible monster.',
            );
        }

        /*
         * After a full page reload, state.running is false,
         * but the sessionStorage resume token still exists.
         */
        if (!state.running) {
            clearTimeout(
                state.timers.resume,
            );

            state.timers.resume =
                setTimeout(
                    () => {
                        void resumeAfterPotionReload();
                    },
                    400,
                );
        }
    }

    const observer =
        new MutationObserver(
            mutations => {
                /*
                 * Re-mount if the battle card
                 * has been replaced.
                 */
                if (
                    !document.getElementById(ID)
                ) {
                    clearTimeout(
                        state.timers.mount,
                    );

                    state.timers.mount =
                        setTimeout(
                            mount,
                            150,
                        );
                }

                /*
                 * Refresh attacks when the
                 * current monster card changes.
                 */
                const attacksChanged =
                    mutations.some(
                        mutation => {
                            const target =
                                mutation.target
                                    instanceof Element
                                    ? mutation.target
                                    : mutation.target
                                        .parentElement;

                            if (
                                target?.closest?.(
                                    `#${ID}`,
                                )
                            ) {
                                return false;
                            }

                            if (
                                target?.closest?.(
                                    `${SEL.monsterCard} ${SEL.attack}`,
                                )
                            ) {
                                return true;
                            }

                            return [
                                ...mutation.addedNodes,
                                ...mutation.removedNodes,
                            ].some(node => {
                                return (
                                    node
                                    instanceof Element &&
                                    (
                                        node.matches?.(
                                            SEL.attack,
                                        ) ||
                                        node.querySelector?.(
                                            SEL.attack,
                                        )
                                    )
                                );
                            });
                        },
                    );

                if (
                    attacksChanged &&
                    state.panel
                ) {
                    clearTimeout(
                        state.timers.attacks,
                    );

                    state.timers.attacks =
                        setTimeout(
                            () => {
                                if (
                                    discoverAttacks()
                                ) {
                                    renderAttackOptions();

                                    setStatus(
                                        'The current monster card attacks were refreshed.',
                                        'success',
                                    );
                                }
                            },
                            180,
                        );
                }

                /*
                 * Refresh potion quantities from
                 * both the drawer and quick-use bar.
                 */
                const potionsChanged =
                    mutations.some(
                        mutation => {
                            const target =
                                mutation.target
                                    instanceof Element
                                    ? mutation.target
                                    : mutation.target
                                        .parentElement;

                            return target
                                ?.closest?.(
                                    [
                                        '#battleDrawer',
                                        '#ds-combat-potion-quick-use',
                                        '.potion-card',
                                        '.potion-qty-left',
                                        '.ds-potion-count',
                                    ].join(', '),
                                );
                        },
                    );

                if (
                    potionsChanged &&
                    state.panel
                ) {
                    clearTimeout(
                        state.timers.potions,
                    );

                    state.timers.potions =
                        setTimeout(
                            () => {
                                renderPotionLists();
                                updateMetrics();
                            },
                            250,
                        );
                }

                /*
                 * Update displayed stamina,
                 * mana, health and EXP.
                 */
                const resourcesChanged =
                    mutations.some(
                        mutation => {
                            const target =
                                mutation.target
                                    instanceof Element
                                    ? mutation.target
                                    : mutation.target
                                        .parentElement;

                            return target
                                ?.closest?.(
                                    [
                                        SEL.stamina,
                                        SEL.playerHp,
                                        SEL.playerMana,
                                        '.gtb-exp',
                                    ].join(', '),
                                );
                        },
                    );

                if (
                    resourcesChanged &&
                    state.panel
                ) {
                    clearTimeout(
                        state.timers.metrics,
                    );

                    state.timers.metrics =
                        setTimeout(
                            updateMetrics,
                            100,
                        );
                }
            },
        );

    observer.observe(
        document.documentElement,
        {
            childList: true,
            subtree: true,
            characterData: true,
        },
    );

    mount();
})();