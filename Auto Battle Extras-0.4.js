// ==UserScript==
// @name         Auto Battle Extras
// @namespace    local.autobattle.extras
// @version      0.4
// @description  Modular Auto Battle addon: Power Wishlist, Shrine Event Picker, Portrait Trial Picker, and future modules
// @match        https://demonicscans.org/occurrence_castle.php?slug=vampire_castle
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const AutoBattleExtras = (function createAutoBattleExtrasCore() {
        const STORAGE_PREFIX = 'tmAutoBattleExtras:';
        const AUTO_RESTART_KEY = STORAGE_PREFIX + 'autoBattleRestart:v1';
        const modules = [];

        let root = null;
        let content = null;
        let globalStatus = null;
        let observer = null;
        let scanTimer = null;
        let started = false;

        function clone(value) {
            return JSON.parse(JSON.stringify(value));
        }

        function isPlainObject(value) {
            return !!value && typeof value === 'object' && !Array.isArray(value);
        }

        function mergeDefaults(defaults, saved) {
            const base = clone(defaults || {});

            if (!isPlainObject(saved)) return base;

            for (const [key, value] of Object.entries(saved)) {
                if (isPlainObject(base[key]) && isPlainObject(value)) {
                    base[key] = {
                        ...base[key],
                        ...value
                    };
                } else {
                    base[key] = value;
                }
            }

            return base;
        }

        function storageKey(moduleId) {
            return STORAGE_PREFIX + moduleId + ':v1';
        }

        function readState(moduleId, defaults) {
            try {
                const saved = JSON.parse(localStorage.getItem(storageKey(moduleId)) || '{}');
                return mergeDefaults(defaults, saved);
            } catch {
                return clone(defaults || {});
            }
        }

        function saveState(moduleId, state) {
            localStorage.setItem(storageKey(moduleId), JSON.stringify(state || {}));
        }

        function normalizeText(value) {
            return String(value || '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function normalizePowerName(value) {
            return normalizeText(value)
                .replace(/\s*\((common|rare|epic|legendary)\)\s*$/i, '')
                .trim();
        }

        function powerNameKey(value) {
            return normalizePowerName(value).toLowerCase();
        }

        function uniquePowerNames(names) {
            const map = new Map();

            for (const raw of names || []) {
                const clean = normalizePowerName(raw);
                if (!clean) continue;

                const key = powerNameKey(clean);
                if (!map.has(key)) map.set(key, clean);
            }

            return Array.from(map.values());
        }

        function makePowerNameSet(names) {
            return new Set(uniquePowerNames(names).map(powerNameKey));
        }

        function parseNumberText(value) {
            const digits = String(value || '').replace(/[^\d]/g, '');
            return digits ? Number(digits) : NaN;
        }

        function getPlayerStatusText() {
            return normalizeText(document.querySelector('#playerStatusText')?.textContent || 'None');
        }

        function getPlayerHpPercent() {
            const autoPanel = document.querySelector('#autoBattlePanel');

            const fromDataset = Number(autoPanel?.dataset?.playerHpPercent);
            if (Number.isFinite(fromDataset)) return Math.max(0, Math.min(100, fromDataset));

            const hpFill = document.querySelector('#playerHpFill');
            const widthText = hpFill?.style?.width || '';
            const widthMatch = widthText.match(/([\d.]+)\s*%/);

            if (widthMatch) {
                const width = Number(widthMatch[1]);
                if (Number.isFinite(width)) return Math.max(0, Math.min(100, width));
            }

            const hpText = normalizeText(document.querySelector('#playerHpText')?.textContent || '');
            const hpMatch = hpText.match(/(.+?)\s*\/\s*(.+)/);

            if (hpMatch) {
                const current = parseNumberText(hpMatch[1]);
                const max = parseNumberText(hpMatch[2]);

                if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
                    return Math.max(0, Math.min(100, (current / max) * 100));
                }
            }

            return 100;
        }

        function readAutoBattleRestartRequest() {
            try {
                return JSON.parse(localStorage.getItem(AUTO_RESTART_KEY) || '{}');
            } catch {
                return {};
            }
        }

        function requestAutoBattleRestart(reason) {
            localStorage.setItem(AUTO_RESTART_KEY, JSON.stringify({
                requested: true,
                reason: reason || 'module action',
                requestedAt: Date.now()
            }));
        }

        function clearAutoBattleRestartRequest() {
            localStorage.removeItem(AUTO_RESTART_KEY);
        }

        function shouldAutoBattleRestart() {
            const request = readAutoBattleRestartRequest();

            if (!request.requested) return false;

            const age = Date.now() - Number(request.requestedAt || 0);

            if (age > 120000) {
                clearAutoBattleRestartRequest();
                return false;
            }

            return true;
        }

        function isNativeAutoBattleActive() {
            const autoPanel = document.querySelector('#autoBattlePanel');
            const storageKey = autoPanel?.dataset?.storageKey;

            if (!storageKey) return false;

            try {
                const state = JSON.parse(localStorage.getItem(storageKey) || '{}');
                return !!state.active;
            } catch {
                return false;
            }
        }

        function hasBattleForAutoStart() {
            const autoPanel = document.querySelector('#autoBattlePanel');

            if (autoPanel?.dataset?.hasBattle === '1') return true;

            return !!(
                document.querySelector('.monster-card') &&
                document.querySelector('form.js-attack-form')
            );
        }

        function tryStartNativeAutoBattle(reason) {
            if (!shouldAutoBattleRestart()) return false;

            if (isNativeAutoBattleActive()) {
                clearAutoBattleRestartRequest();
                return false;
            }

            if (!hasBattleForAutoStart()) return false;

            const startButton = document.querySelector('#autoStartBtn');

            if (!startButton) return false;
            if (startButton.disabled) return false;

            clearAutoBattleRestartRequest();

            setGlobalStatus('Restarting native Auto Battle' + (reason ? ': ' + reason : '') + '.');

            window.setTimeout(() => {
                startButton.click();
            }, 250);

            return true;
        }

        function submitForm(form, options = {}) {
            if (!form) return;

            const restartAutoBattle = options.restartAutoBattle !== false;

            if (restartAutoBattle) {
                requestAutoBattleRestart(options.restartReason || form.dataset.itemName || 'module action');
            }

            const button = form.querySelector('button, input[type="submit"]');

            if (typeof form.requestSubmit === 'function') {
                form.requestSubmit(button || undefined);
            } else if (button) {
                button.click();
            } else {
                form.submit();
            }
        }

        function createCheckbox(checked, onChange) {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!checked;
            input.addEventListener('change', () => onChange(input.checked));
            return input;
        }

        function createNumberInput(value, min, max, onChange) {
            const input = document.createElement('input');
            input.type = 'number';
            input.min = String(min);
            input.max = String(max);
            input.value = String(value);
            input.style.width = '70px';

            input.addEventListener('change', () => {
                const parsed = Number(input.value);
                const clean = Number.isFinite(parsed)
                ? Math.max(min, Math.min(max, Math.round(parsed)))
                : value;

                input.value = String(clean);
                onChange(clean);
            });

            return input;
        }

        function createPrioritySelect(value, maxPriority, onChange) {
            const select = document.createElement('select');

            for (let number = 1; number <= maxPriority; number += 1) {
                const option = document.createElement('option');
                option.value = String(number);
                option.textContent = String(number);
                select.appendChild(option);
            }

            select.value = String(value || 1);
            select.addEventListener('change', () => {
                onChange(Number(select.value));
                scheduleScan(100);
            });

            return select;
        }

        function setModuleStatus(moduleId, text) {
            const el = document.querySelector('#tmModuleStatus_' + moduleId);
            if (el) el.textContent = text || '';
        }

        function setGlobalStatus(text) {
            if (globalStatus) globalStatus.textContent = text || '';
        }

        function getMountPoint() {
            return (
                document.querySelector('#autoBattlePanel') ||
                document.querySelector('.castle-event-card') ||
                document.querySelector('.card') ||
                document.body
            );
        }

        function ensureRoot() {
            if (root && document.documentElement.contains(root)) return;

            const mount = getMountPoint();

            root = document.createElement('section');
            root.id = 'tmAutoBattleExtrasRoot';
            root.style.marginTop = '12px';
            root.style.padding = '12px';
            root.style.border = '1px solid rgba(255,255,255,0.25)';
            root.style.borderRadius = '12px';
            root.style.display = 'block';

            const title = document.createElement('h2');
            title.textContent = 'Tampermonkey Auto Battle Extras';
            title.style.marginTop = '0';

            const hint = document.createElement('div');
            hint.textContent = 'Modular addon panel for power choices, castle events, and future automation modules.';
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.style.marginBottom = '12px';

            content = document.createElement('div');
            content.id = 'tmAutoBattleExtrasContent';

            globalStatus = document.createElement('div');
            globalStatus.id = 'tmAutoBattleExtrasGlobalStatus';
            globalStatus.style.marginTop = '10px';
            globalStatus.style.fontSize = '12px';
            globalStatus.style.opacity = '0.85';

            root.appendChild(title);
            root.appendChild(hint);
            root.appendChild(content);
            root.appendChild(globalStatus);

            mount.appendChild(root);
        }

        function createModulePanel(module) {
            if (!content) return null;

            let panel = document.querySelector('#tmModule_' + module.id);
            if (panel) return panel;

            panel = document.createElement('section');
            panel.id = 'tmModule_' + module.id;
            panel.style.marginTop = '12px';
            panel.style.padding = '10px';
            panel.style.border = '1px solid rgba(255,255,255,0.18)';
            panel.style.borderRadius = '10px';

            const title = document.createElement('h3');
            title.textContent = module.title || module.id;
            title.style.marginTop = '0';

            const body = document.createElement('div');
            body.id = 'tmModuleBody_' + module.id;

            const status = document.createElement('div');
            status.id = 'tmModuleStatus_' + module.id;
            status.style.marginTop = '8px';
            status.style.fontSize = '12px';
            status.style.opacity = '0.85';

            panel.appendChild(title);
            panel.appendChild(body);
            panel.appendChild(status);

            content.appendChild(panel);

            return body;
        }

        function renderModules() {
            ensureRoot();

            for (const module of modules) {
                if (module.rendered) continue;

                const body = createModulePanel(module);
                if (!body) continue;

                try {
                    module.render?.(body, api);
                    module.rendered = true;
                } catch (error) {
                    console.error('[AutoBattleExtras] Render failed:', module.id, error);
                    setModuleStatus(module.id, 'Render error: ' + (error.message || error));
                }
            }
        }

        function scanModules() {
            renderModules();

            for (const module of modules) {
                try {
                    module.scan?.(api);
                } catch (error) {
                    console.error('[AutoBattleExtras] Scan failed:', module.id, error);
                    setModuleStatus(module.id, 'Scan error: ' + (error.message || error));
                }
            }
        }

        function scheduleScan(delay) {
            if (scanTimer) clearTimeout(scanTimer);

            scanTimer = window.setTimeout(() => {
                scanTimer = null;
                scanModules();
            }, Number(delay) || 200);
        }

        function startObserver() {
            if (observer) return;

            observer = new MutationObserver(() => {
                scheduleScan(200);
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }

        function registerModule(module) {
            if (!module || !module.id) {
                throw new Error('Module requires an id.');
            }

            modules.push({
                ...module,
                rendered: false
            });

            if (started) {
                renderModules();
                scheduleScan(100);
            }
        }

        function start() {
            if (started) return;

            started = true;
            renderModules();
            startObserver();
            scheduleScan(150);

            setGlobalStatus('Auto Battle Extras loaded.');
        }

        const api = {
            readState,
            saveState,
            normalizeText,
            normalizePowerName,
            powerNameKey,
            uniquePowerNames,
            makePowerNameSet,
            parseNumberText,
            getPlayerStatusText,
            getPlayerHpPercent,
            submitForm,
            requestAutoBattleRestart,
            clearAutoBattleRestartRequest,
            shouldAutoBattleRestart,
            tryStartNativeAutoBattle,
            createCheckbox,
            createNumberInput,
            createPrioritySelect,
            setModuleStatus,
            setGlobalStatus,
            scheduleScan
        };

        return {
            registerModule,
            start,
            api
        };
    })();

    window.AutoBattleExtras = AutoBattleExtras;

    AutoBattleExtras.registerModule({
        id: 'autoBattleResume',
        title: 'Auto Battle Resume',

        defaults: {
            enabled: true
        },

        read(api) {
            return api.readState(this.id, this.defaults);
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state
            });
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Auto Battle Resume enabled.' : 'Auto Battle Resume paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Restart native Auto Battle after module actions'));

            const hint = document.createElement('div');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.textContent = 'When another module buys, uses, chooses, or resolves something, this module clicks Start Auto again once a battle is available.';

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';
            scanButton.style.marginTop = '10px';

            scanButton.addEventListener('click', () => {
                const didStart = this.scan(api);

                if (!didStart) {
                    api.setModuleStatus(this.id, 'No pending Auto Battle restart or Start Auto is not available yet.');
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(hint);
            panel.appendChild(scanButton);
        },

        scan(api) {
            const state = this.read(api);
            if (!state.enabled) return false;

            if (!api.shouldAutoBattleRestart()) return false;

            const didStart = api.tryStartNativeAutoBattle('after module action');

            if (didStart) {
                api.setModuleStatus(this.id, 'Native Auto Battle restarted.');
                return true;
            }

            api.setModuleStatus(this.id, 'Waiting until Start Auto is available.');
            return false;
        }
    });

    AutoBattleExtras.registerModule({
        id: 'statusPotionAutoUse',
        title: 'Status Potion Auto Use',

        defaults: {
            enabled: false,

            useForStatuses: {
                burned: true,
                frozen: true,
                poisoned: true
            },

            onlyDuringBattle: true,
            submitDelay: 50
        },

        isUsingPotion: false,
        attackFetchGuardInstalled: false,
        fastScanInterval: null,

        read(api) {
            const state = api.readState(this.id, this.defaults);

            return {
                ...this.defaults,
                ...state,
                useForStatuses: {
                    ...this.defaults.useForStatuses,
                    ...(state.useForStatuses || {})
                }
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state,
                useForStatuses: {
                    ...this.defaults.useForStatuses,
                    ...(state.useForStatuses || {})
                }
            });
        },

        getStatusPotionForm(api) {
            const direct = Array.from(document.querySelectorAll('form[data-item-name]')).find((form) => {
                return api.normalizeText(form.dataset.itemName).toLowerCase() === 'status potion';
            });

            if (direct) return direct;

            const items = Array.from(document.querySelectorAll('.item'));

            for (const item of items) {
                const title = api.normalizeText(item.querySelector('.item-title')?.textContent || '');

                if (title.toLowerCase() !== 'status potion') continue;

                const form = item.querySelector('form');
                if (form) return form;
            }

            return null;
        },

        getStatusPotionCount(api) {
            const items = Array.from(document.querySelectorAll('.item'));

            for (const item of items) {
                const title = api.normalizeText(item.querySelector('.item-title')?.textContent || '');

                if (title.toLowerCase() !== 'status potion') continue;

                const meta = api.normalizeText(item.querySelector('.item-meta')?.textContent || '');
                const match = meta.match(/x\s*(\d+)/i);

                if (match) return Number(match[1]);
            }

            return this.getStatusPotionForm(api) ? 1 : 0;
        },

        hasActiveBattle() {
            const autoPanel = document.querySelector('#autoBattlePanel');

            if (autoPanel?.dataset?.hasBattle === '1') return true;

            return !!(
                document.querySelector('.monster-card') &&
                document.querySelector('form.js-attack-form')
            );
        },

        getMatchedStatus(api, state) {
            const statusText = api.getPlayerStatusText().toLowerCase();

            const statusMap = {
                burned: ['burned', 'burn'],
                frozen: ['frozen', 'freeze'],
                poisoned: ['poisoned', 'poison']
            };

            for (const [statusKey, aliases] of Object.entries(statusMap)) {
                if (!state.useForStatuses[statusKey]) continue;

                const matches = aliases.some((alias) => statusText.includes(alias));
                if (matches) return statusKey;
            }

            return '';
        },

        shouldUseStatusPotion(api) {
            const state = this.read(api);
            if (!state.enabled) return false;
            if (this.isUsingPotion) return false;

            if (state.onlyDuringBattle && !this.hasActiveBattle()) return false;

            const matchedStatus = this.getMatchedStatus(api, state);
            if (!matchedStatus) return false;

            const form = this.getStatusPotionForm(api);
            if (!form) {
                api.setModuleStatus(this.id, 'Status matched, but no Status Potion form was found.');
                return false;
            }

            return true;
        },

        useStatusPotion(api, reason) {
            if (this.isUsingPotion) return false;

            const state = this.read(api);
            const matchedStatus = this.getMatchedStatus(api, state);
            const form = this.getStatusPotionForm(api);

            if (!matchedStatus || !form) return false;

            this.isUsingPotion = true;

            const count = this.getStatusPotionCount(api);

            api.setModuleStatus(
                this.id,
                'Using Status Potion automatically for ' +
                matchedStatus +
                (count ? ' | available: x' + count : '') +
                (reason ? ' | reason: ' + reason : '')
            );

            window.setTimeout(() => {
                api.submitForm(form);
            }, Number(state.submitDelay) || 50);

            return true;
        },

        isAttackRequest(args) {
            const input = args[0];
            const init = args[1] || {};

            const method = String(init.method || '').toUpperCase();
            if (method !== 'POST') return false;

            const body = init.body;
            if (!(body instanceof FormData)) return false;

            const action = body.get('action');
            const attackType = body.get('attack_type');

            return action === 'attack' && ['slash', 'magic'].includes(String(attackType));
        },

        installAttackFetchGuard(api) {
            if (this.attackFetchGuardInstalled) return;

            this.attackFetchGuardInstalled = true;

            const module = this;
            const originalFetch = window.fetch;

            window.fetch = function guardedFetch(...args) {
                try {
                    if (module.isAttackRequest(args) && module.shouldUseStatusPotion(api)) {
                        const didUsePotion = module.useStatusPotion(api, 'before attack');

                        if (didUsePotion) {
                            // Keep the native attack request pending.
                            // The Status Potion form submit should navigate/reload the page.
                            // This avoids letting the native Auto Battle treat the blocked attack as an error.
                            return new Promise(() => {});
                        }
                    }
                } catch (error) {
                    console.error('[AutoBattleExtras] Status Potion attack guard failed:', error);
                }

                return originalFetch.apply(this, args);
            };
        },

        installManualSubmitGuard(api) {
            if (this.manualSubmitGuardInstalled) return;

            this.manualSubmitGuardInstalled = true;

            document.addEventListener(
                'submit',
                (event) => {
                    const form = event.target;

                    if (!(form instanceof HTMLFormElement)) return;
                    if (!form.matches('form.js-attack-form')) return;
                    if (!this.shouldUseStatusPotion(api)) return;

                    const didUsePotion = this.useStatusPotion(api, 'before manual attack');

                    if (didUsePotion) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                    }
                },
                true
            );
        },

        startFastScan(api) {
            if (this.fastScanInterval) return;

            this.fastScanInterval = window.setInterval(() => {
                const state = this.read(api);
                if (!state.enabled) return;
                if (!this.shouldUseStatusPotion(api)) return;

                this.useStatusPotion(api, 'status scan');
            }, 250);
        },

        render(panel, api) {
            const state = this.read(api);

            this.installAttackFetchGuard(api);
            this.installManualSubmitGuard(api);
            this.startFastScan(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Status Potion Auto Use enabled.' : 'Status Potion Auto Use paused.');
                api.scheduleScan(50);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically use Status Potion'));

            const statusGrid = document.createElement('div');
            statusGrid.style.display = 'grid';
            statusGrid.style.gridTemplateColumns = 'repeat(3, minmax(120px, 1fr))';
            statusGrid.style.gap = '8px';
            statusGrid.style.marginBottom = '10px';

            const statusOptions = [
                ['burned', 'Burned'],
                ['frozen', 'Frozen'],
                ['poisoned', 'Poisoned']
            ];

            for (const [key, labelText] of statusOptions) {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.gap = '6px';
                label.style.alignItems = 'center';

                const checkbox = api.createCheckbox(state.useForStatuses[key], (checked) => {
                    const latest = this.read(api);
                    latest.useForStatuses[key] = checked;
                    this.write(api, latest);

                    api.setModuleStatus(this.id, labelText + (checked ? ' enabled.' : ' disabled.'));
                    api.scheduleScan(50);
                });

                label.appendChild(checkbox);
                label.appendChild(document.createTextNode(labelText));
                statusGrid.appendChild(label);
            }

            const battleOnlyLabel = document.createElement('label');
            battleOnlyLabel.style.display = 'flex';
            battleOnlyLabel.style.gap = '8px';
            battleOnlyLabel.style.alignItems = 'center';
            battleOnlyLabel.style.marginBottom = '10px';

            const battleOnlyCheckbox = api.createCheckbox(state.onlyDuringBattle, (checked) => {
                const latest = this.read(api);
                latest.onlyDuringBattle = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Only during battle enabled.' : 'Only during battle disabled.');
                api.scheduleScan(50);
            });

            battleOnlyLabel.appendChild(battleOnlyCheckbox);
            battleOnlyLabel.appendChild(document.createTextNode('Only use during active battle'));

            const hint = document.createElement('div');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.style.marginBottom = '8px';
            hint.textContent = 'The module checks status continuously and also guards Slash/Magic attack requests before they are sent.';

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';

            scanButton.addEventListener('click', () => {
                const didUse = this.scan(api);

                if (!didUse) {
                    const status = api.getPlayerStatusText();
                    const count = this.getStatusPotionCount(api);

                    api.setModuleStatus(
                        this.id,
                        'No Status Potion used. Current status: ' + status + ' | available: x' + count
                    );
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(statusGrid);
            panel.appendChild(battleOnlyLabel);
            panel.appendChild(hint);
            panel.appendChild(scanButton);
        },

        scan(api) {
            const state = this.read(api);
            if (!state.enabled) return false;

            if (!this.shouldUseStatusPotion(api)) return false;

            return this.useStatusPotion(api, 'module scan');
        }
    });

    AutoBattleExtras.registerModule({
        id: 'powerWishlist',
        title: 'Power Wishlist',

        defaults: {
            enabled: true,
            wantedPowers: [],
            protectedPowers: [],
            protectLegendaryPowers: true,
            submitDelay: 650
        },

        isChoosing: false,

        presetPowerNames: [
            'Witchfire Core',
            'Execution Rhythm',
            'Mana Leech',
            'Blood Frenzy',
            'Crimson Vitality',
            'Blood Alchemy'
        ],

        read(api) {
            const state = api.readState(this.id, this.defaults);

            return {
                ...this.defaults,
                ...state,
                wantedPowers: api.uniquePowerNames(state.wantedPowers || []),
                protectedPowers: api.uniquePowerNames(state.protectedPowers || []),
                protectLegendaryPowers: state.protectLegendaryPowers !== false
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state,
                wantedPowers: api.uniquePowerNames(state.wantedPowers || []),
                protectedPowers: api.uniquePowerNames(state.protectedPowers || [])
            });
        },

        getCurrentPowerNames(api) {
            return api.uniquePowerNames(
                Array.from(document.querySelectorAll('.power-list .power .power-slot-head strong'))
                .map((el) => el.textContent)
            );
        },

        getPowerChoiceForms(api) {
            return Array.from(document.querySelectorAll('form.power-choice-card')).map((form) => {
                const title = form.querySelector('h3');
                const name = api.normalizePowerName(title ? title.textContent : '');
                const rarity = String(form.dataset.rarity || '').toLowerCase();

                return {
                    form,
                    name,
                    rarity
                };
            }).filter((choice) => choice.name);
        },

        parseReplacementOption(api, option) {
            const text = option ? option.textContent || '' : '';
            const match = text.match(/from\s+(.+?)\s+\((common|rare|epic|legendary)\)\s*x?\d*/i);

            if (match) {
                return {
                    name: api.normalizePowerName(match[1]),
                    rarity: String(match[2] || '').toLowerCase()
                };
            }

            return {
                name: api.normalizePowerName(text),
                rarity: ''
            };
        },

        selectSafeReplacementIfNeeded(api, form, state) {
            const select = form.querySelector('select[name="replace_id"]');

            if (!select) return true;

            const wantedSet = api.makePowerNameSet(state.wantedPowers);
            const protectedSet = api.makePowerNameSet(state.protectedPowers);

            const options = Array.from(select.options);

            const safeOption = options.find((option) => {
                const info = this.parseReplacementOption(api, option);
                const key = api.powerNameKey(info.name);

                if (!key) return false;
                if (wantedSet.has(key)) return false;
                if (protectedSet.has(key)) return false;
                if (state.protectLegendaryPowers && info.rarity === 'legendary') return false;

                return true;
            });

            if (!safeOption) {
                api.setModuleStatus(this.id, 'Wanted power found, but no safe replacement is available.');
                return false;
            }

            select.value = safeOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));

            return true;
        },

        collectKnownPowerNames(api) {
            const state = this.read(api);

            const fromCurrentPowers = this.getCurrentPowerNames(api);
            const fromChoices = this.getPowerChoiceForms(api).map((choice) => choice.name);

            return api.uniquePowerNames([
                ...this.presetPowerNames,
                ...state.wantedPowers,
                ...state.protectedPowers,
                ...fromCurrentPowers,
                ...fromChoices
            ]).sort((a, b) => a.localeCompare(b));
        },

        renderPowerList(panel, api) {
            const state = this.read(api);
            const wantedSet = api.makePowerNameSet(state.wantedPowers);
            const protectedSet = api.makePowerNameSet(state.protectedPowers);
            const knownPowerNames = this.collectKnownPowerNames(api);

            const list = panel.querySelector('#tmPowerWishlistList');
            if (!list) return;

            list.textContent = '';

            for (const powerName of knownPowerNames) {
                const key = api.powerNameKey(powerName);

                const row = document.createElement('div');
                row.style.display = 'grid';
                row.style.gridTemplateColumns = '70px 95px 1fr';
                row.style.gap = '8px';
                row.style.alignItems = 'center';
                row.style.margin = '4px 0';

                const wantedLabel = document.createElement('label');
                wantedLabel.style.display = 'flex';
                wantedLabel.style.gap = '4px';
                wantedLabel.style.alignItems = 'center';

                const wantedCheckbox = api.createCheckbox(wantedSet.has(key), (checked) => {
                    const latest = this.read(api);
                    const set = api.makePowerNameSet(latest.wantedPowers);

                    if (checked) set.add(key);
                    else set.delete(key);

                    const allNames = this.collectKnownPowerNames(api);
                    latest.wantedPowers = allNames.filter((name) => set.has(api.powerNameKey(name)));

                    this.write(api, latest);
                    api.scheduleScan(100);
                });

                wantedLabel.appendChild(wantedCheckbox);
                wantedLabel.appendChild(document.createTextNode('Want'));

                const protectedLabel = document.createElement('label');
                protectedLabel.style.display = 'flex';
                protectedLabel.style.gap = '4px';
                protectedLabel.style.alignItems = 'center';

                const protectedCheckbox = api.createCheckbox(protectedSet.has(key), (checked) => {
                    const latest = this.read(api);
                    const set = api.makePowerNameSet(latest.protectedPowers);

                    if (checked) set.add(key);
                    else set.delete(key);

                    const allNames = this.collectKnownPowerNames(api);
                    latest.protectedPowers = allNames.filter((name) => set.has(api.powerNameKey(name)));

                    this.write(api, latest);
                });

                protectedLabel.appendChild(protectedCheckbox);
                protectedLabel.appendChild(document.createTextNode('Protect'));

                const name = document.createElement('span');
                name.textContent = powerName;

                row.appendChild(wantedLabel);
                row.appendChild(protectedLabel);
                row.appendChild(name);

                list.appendChild(row);
            }
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '8px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Power Wishlist enabled.' : 'Power Wishlist paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically pick wanted powers if they do not exist yet'));

            const protectLegendaryLabel = document.createElement('label');
            protectLegendaryLabel.style.display = 'flex';
            protectLegendaryLabel.style.gap = '8px';
            protectLegendaryLabel.style.alignItems = 'center';
            protectLegendaryLabel.style.marginBottom = '8px';

            const protectLegendaryCheckbox = api.createCheckbox(state.protectLegendaryPowers, (checked) => {
                const latest = this.read(api);
                latest.protectLegendaryPowers = checked;
                this.write(api, latest);
            });

            protectLegendaryLabel.appendChild(protectLegendaryCheckbox);
            protectLegendaryLabel.appendChild(document.createTextNode('Never auto-replace legendary powers'));

            const addRow = document.createElement('div');
            addRow.style.display = 'flex';
            addRow.style.gap = '8px';
            addRow.style.marginBottom = '10px';

            const addInput = document.createElement('input');
            addInput.type = 'text';
            addInput.placeholder = 'Add power name, e.g. Witchfire Core';
            addInput.style.flex = '1';

            const addButton = document.createElement('button');
            addButton.type = 'button';
            addButton.textContent = 'Add';

            addButton.addEventListener('click', () => {
                const name = api.normalizePowerName(addInput.value);
                if (!name) return;

                const latest = this.read(api);
                latest.wantedPowers = api.uniquePowerNames([...latest.wantedPowers, name]);

                this.write(api, latest);
                addInput.value = '';

                this.renderPowerList(panel, api);
                api.scheduleScan(100);
            });

            addInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    addButton.click();
                }
            });

            addRow.appendChild(addInput);
            addRow.appendChild(addButton);

            const hint = document.createElement('div');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.style.marginBottom = '8px';
            hint.textContent = 'Want = pick automatically if offered and not owned. Protect = never auto-replace.';

            const list = document.createElement('div');
            list.id = 'tmPowerWishlistList';

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';
            scanButton.style.marginTop = '10px';

            scanButton.addEventListener('click', () => {
                const didChoose = this.scan(api);
                if (!didChoose) api.setModuleStatus(this.id, 'No matching new wanted power found.');
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(protectLegendaryLabel);
            panel.appendChild(addRow);
            panel.appendChild(hint);
            panel.appendChild(list);
            panel.appendChild(scanButton);

            this.renderPowerList(panel, api);
        },

        scan(api) {
            if (this.isChoosing) return false;

            const state = this.read(api);
            if (!state.enabled) return false;

            const currentPowerSet = api.makePowerNameSet(this.getCurrentPowerNames(api));
            const wantedPowerNames = api.uniquePowerNames(state.wantedPowers);
            const choices = this.getPowerChoiceForms(api);

            if (!wantedPowerNames.length || !choices.length) return false;

            for (const wantedName of wantedPowerNames) {
                const wantedKey = api.powerNameKey(wantedName);

                if (currentPowerSet.has(wantedKey)) continue;

                const match = choices.find((choice) => api.powerNameKey(choice.name) === wantedKey);
                if (!match) continue;

                const canReplace = this.selectSafeReplacementIfNeeded(api, match.form, state);
                if (!canReplace) continue;

                this.isChoosing = true;

                api.setModuleStatus(this.id, 'Automatically picking: ' + match.name);

                window.setTimeout(() => {
                    api.submitForm(match.form);
                }, Number(state.submitDelay) || 650);

                return true;
            }

            return false;
        }
    });

    AutoBattleExtras.registerModule({
        id: 'shrineEventPicker',
        title: 'Shrine Event Picker',

        defaults: {
            enabled: true,

            priorities: {
                cleanse: 1,
                heal: 2,
                bless: 3
            },

            cleanseEnabled: true,
            healEnabled: true,
            blessEnabled: true,

            healThreshold: 50,

            ignoredStatuses: [
                'none',
                'no status',
                'normal',
                'clean',
                'healthy',
                'blessed',
                'bless'
            ],

            submitDelay: 450
        },

        isResolving: false,

        read(api) {
            const state = api.readState(this.id, this.defaults);

            return {
                ...this.defaults,
                ...state,
                priorities: {
                    ...this.defaults.priorities,
                    ...(state.priorities || {})
                },
                ignoredStatuses: Array.isArray(state.ignoredStatuses)
                ? state.ignoredStatuses
                : this.defaults.ignoredStatuses
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state,
                priorities: {
                    ...this.defaults.priorities,
                    ...(state.priorities || {})
                }
            });
        },

        getEventCard(api) {
            const cards = Array.from(document.querySelectorAll('.castle-event-card'));

            return cards.find((card) => {
                const title = api.normalizeText(card.querySelector('.event-title')?.textContent);
                return title === 'Shrine of the Last Guest';
            }) || null;
        },

        getEventForm(api, choice) {
            const card = this.getEventCard(api);
            if (!card) return null;

            return Array.from(card.querySelectorAll('form.event-option-form')).find((form) => {
                const input = form.querySelector('input[name="choice"]');
                return input && input.value === choice;
            }) || null;
        },

        hasBadStatus(api, state) {
            const status = api.getPlayerStatusText();
            const key = api.normalizeText(status).toLowerCase();

            if (!key) return false;

            const ignored = new Set(
                (state.ignoredStatuses || [])
                .map((item) => api.normalizeText(item).toLowerCase())
                .filter(Boolean)
            );

            return !ignored.has(key);
        },

        getAvailableChoices(api) {
            return {
                heal: !!this.getEventForm(api, 'heal'),
                cleanse: !!this.getEventForm(api, 'cleanse'),
                bless: !!this.getEventForm(api, 'bless')
            };
        },

        buildDecisionList(api, state) {
            const hpPercent = api.getPlayerHpPercent();
            const badStatus = this.hasBadStatus(api, state);
            const available = this.getAvailableChoices(api);

            const candidates = [
                {
                    choice: 'cleanse',
                    label: 'Cleanse Bad Status',
                    priority: Number(state.priorities.cleanse) || 1,
                    enabled: !!state.cleanseEnabled,
                    available: available.cleanse,
                    condition: badStatus,
                    reason: 'status is: ' + api.getPlayerStatusText()
                },
                {
                    choice: 'heal',
                    label: 'Drink From The Chalice',
                    priority: Number(state.priorities.heal) || 2,
                    enabled: !!state.healEnabled,
                    available: available.heal,
                    condition: hpPercent <= Number(state.healThreshold || 50),
                    reason: 'HP is ' + Math.round(hpPercent) + '%'
                },
                {
                    choice: 'bless',
                    label: 'Bless Next Hit',
                    priority: Number(state.priorities.bless) || 3,
                    enabled: !!state.blessEnabled,
                    available: available.bless,
                    condition: true,
                    reason: 'fallback'
                }
            ];

            return candidates
                .filter((item) => item.enabled && item.available && item.condition)
                .sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return ['cleanse', 'heal', 'bless'].indexOf(a.choice) - ['cleanse', 'heal', 'bless'].indexOf(b.choice);
            });
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Shrine Event Picker enabled.' : 'Shrine Event Picker paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically resolve Shrine of the Last Guest'));

            const table = document.createElement('div');
            table.style.display = 'grid';
            table.style.gridTemplateColumns = '90px 90px 1fr';
            table.style.gap = '6px 10px';
            table.style.alignItems = 'center';

            const addRow = (choice, label, enabledKey, extraBuilder) => {
                const latest = this.read(api);

                const enabled = api.createCheckbox(latest[enabledKey], (checked) => {
                    const stateNow = this.read(api);
                    stateNow[enabledKey] = checked;
                    this.write(api, stateNow);
                    api.scheduleScan(100);
                });

                const priority = api.createPrioritySelect(latest.priorities[choice], 3, (value) => {
                    const stateNow = this.read(api);
                    stateNow.priorities[choice] = value;
                    this.write(api, stateNow);
                });

                const left = document.createElement('label');
                left.style.display = 'flex';
                left.style.gap = '5px';
                left.style.alignItems = 'center';
                left.appendChild(enabled);
                left.appendChild(document.createTextNode(label));

                const middle = document.createElement('div');
                middle.appendChild(document.createTextNode('Priority '));
                middle.appendChild(priority);

                const right = document.createElement('div');
                right.appendChild(extraBuilder());

                table.appendChild(left);
                table.appendChild(middle);
                table.appendChild(right);
            };

            addRow('cleanse', 'Cleanse', 'cleanseEnabled', () => {
                const span = document.createElement('span');
                span.textContent = 'if status is not ignored';
                return span;
            });

            addRow('heal', 'Chalice', 'healEnabled', () => {
                const wrapper = document.createElement('span');
                wrapper.appendChild(document.createTextNode('if HP ≤ '));

                const input = api.createNumberInput(state.healThreshold, 1, 99, (value) => {
                    const latest = this.read(api);
                    latest.healThreshold = value;
                    this.write(api, latest);
                    api.scheduleScan(100);
                });

                wrapper.appendChild(input);
                wrapper.appendChild(document.createTextNode('%'));

                return wrapper;
            });

            addRow('bless', 'Bless', 'blessEnabled', () => {
                const span = document.createElement('span');
                span.textContent = 'always valid fallback';
                return span;
            });

            const ignoredLabel = document.createElement('label');
            ignoredLabel.style.display = 'block';
            ignoredLabel.style.marginTop = '12px';

            const ignoredText = document.createElement('div');
            ignoredText.textContent = 'Ignored status values, comma-separated:';
            ignoredText.style.fontSize = '12px';
            ignoredText.style.opacity = '0.85';

            const ignoredInput = document.createElement('input');
            ignoredInput.type = 'text';
            ignoredInput.value = state.ignoredStatuses.join(', ');
            ignoredInput.style.width = '100%';

            ignoredInput.addEventListener('change', () => {
                const latest = this.read(api);

                latest.ignoredStatuses = ignoredInput.value
                    .split(',')
                    .map((item) => api.normalizeText(item))
                    .filter(Boolean);

                this.write(api, latest);
                api.scheduleScan(100);
            });

            ignoredLabel.appendChild(ignoredText);
            ignoredLabel.appendChild(ignoredInput);

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';
            scanButton.style.marginTop = '10px';

            scanButton.addEventListener('click', () => {
                const didResolve = this.scan(api);

                if (!didResolve) {
                    const hp = Math.round(api.getPlayerHpPercent());
                    const status = api.getPlayerStatusText();
                    api.setModuleStatus(this.id, 'Nothing selected. Current HP: ' + hp + '%, status: ' + status);
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(table);
            panel.appendChild(ignoredLabel);
            panel.appendChild(scanButton);
        },

        scan(api) {
            if (this.isResolving) return false;

            const state = this.read(api);
            if (!state.enabled) return false;

            const card = this.getEventCard(api);
            if (!card) return false;

            const decisions = this.buildDecisionList(api, state);
            const winner = decisions[0];

            if (!winner) {
                api.setModuleStatus(this.id, 'Shrine found, but no option matches the current conditions.');
                return false;
            }

            const form = this.getEventForm(api, winner.choice);
            if (!form) {
                api.setModuleStatus(this.id, 'Shrine found, but form is missing for choice: ' + winner.choice);
                return false;
            }

            this.isResolving = true;

            api.setModuleStatus(this.id, 'Choosing automatically: ' + winner.label + ' because ' + winner.reason);

            window.setTimeout(() => {
                api.submitForm(form);
            }, Number(state.submitDelay) || 450);

            return true;
        }
    });

    AutoBattleExtras.registerModule({
        id: 'portraitTrialPicker',
        title: 'Portrait Trial Picker',

        defaults: {
            enabled: true,

            // Visible answer number: 1 to 4.
            // The game internally uses choice values 0 to 3.
            defaultAnswer: 1,

            submitDelay: 450
        },

        isResolving: false,

        read(api) {
            const state = api.readState(this.id, this.defaults);

            const answer = Number(state.defaultAnswer);
            const cleanAnswer = Number.isFinite(answer)
            ? Math.max(1, Math.min(4, Math.round(answer)))
            : 1;

            return {
                ...this.defaults,
                ...state,
                defaultAnswer: cleanAnswer
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state
            });
        },

        getEventCard(api) {
            const cards = Array.from(document.querySelectorAll('.castle-event-card'));

            return cards.find((card) => {
                const title = api.normalizeText(card.querySelector('.event-title')?.textContent);
                return title === 'Portrait Trial';
            }) || null;
        },

        getQuestionText(api) {
            const card = this.getEventCard(api);
            if (!card) return '';

            return api.normalizeText(card.querySelector('.event-options strong')?.textContent || '');
        },

        getAnswerForms(api) {
            const card = this.getEventCard(api);
            if (!card) return [];

            return Array.from(card.querySelectorAll('form.event-option-form')).map((form, index) => {
                const choiceInput = form.querySelector('input[name="choice"]');
                const button = form.querySelector('button');

                return {
                    form,
                    index,
                    choiceValue: choiceInput ? choiceInput.value : String(index),
                    label: api.normalizeText(button?.textContent || '')
                };
            });
        },

        getSelectedAnswer(api, state) {
            const answers = this.getAnswerForms(api);
            const wantedIndex = Math.max(0, Math.min(3, Number(state.defaultAnswer) - 1));

            return answers[wantedIndex] || null;
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Portrait Trial Picker enabled.' : 'Portrait Trial Picker paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically answer Portrait Trial'));

            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.gap = '8px';
            row.style.alignItems = 'center';
            row.style.flexWrap = 'wrap';

            const label = document.createElement('span');
            label.textContent = 'Default answer:';

            const select = document.createElement('select');

            for (const answerNumber of [1, 2, 3, 4]) {
                const option = document.createElement('option');
                option.value = String(answerNumber);
                option.textContent = String(answerNumber);
                select.appendChild(option);
            }

            select.value = String(state.defaultAnswer);

            select.addEventListener('change', () => {
                const latest = this.read(api);
                latest.defaultAnswer = Number(select.value);
                this.write(api, latest);

                api.setModuleStatus(this.id, 'Default answer set to option ' + select.value + '.');
                api.scheduleScan(100);
            });

            const hint = document.createElement('span');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.textContent = 'Option 1 = top answer, option 4 = bottom answer.';

            row.appendChild(label);
            row.appendChild(select);
            row.appendChild(hint);

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';
            scanButton.style.marginTop = '10px';

            scanButton.addEventListener('click', () => {
                const didResolve = this.scan(api);

                if (!didResolve) {
                    api.setModuleStatus(this.id, 'No Portrait Trial found or module is paused.');
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(row);
            panel.appendChild(scanButton);
        },

        scan(api) {
            if (this.isResolving) return false;

            const state = this.read(api);
            if (!state.enabled) return false;

            const card = this.getEventCard(api);
            if (!card) return false;

            const selected = this.getSelectedAnswer(api, state);

            if (!selected || !selected.form) {
                api.setModuleStatus(this.id, 'Portrait Trial found, but answer option ' + state.defaultAnswer + ' was not found.');
                return false;
            }

            this.isResolving = true;

            const question = this.getQuestionText(api);
            const answerText = selected.label || 'Option ' + state.defaultAnswer;

            api.setModuleStatus(
                this.id,
                'Answering Portrait Trial with option ' + state.defaultAnswer + ': ' + answerText + (question ? ' | Question: ' + question : '')
            );

            window.setTimeout(() => {
                api.submitForm(selected.form);
            }, Number(state.submitDelay) || 450);

            return true;
        }
    });

    AutoBattleExtras.registerModule({
        id: 'hungryMerchantPicker',
        title: 'Hungry Merchant Picker',

        defaults: {
            enabled: true,

            buyOffers: {
                first: false,
                second: false,
                third: false,
                fourth: false
            },

            autoContinueAfterBuying: true,
            submitDelay: 450
        },

        isResolving: false,

        read(api) {
            const state = api.readState(this.id, this.defaults);

            return {
                ...this.defaults,
                ...state,
                buyOffers: {
                    ...this.defaults.buyOffers,
                    ...(state.buyOffers || {})
                }
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state,
                buyOffers: {
                    ...this.defaults.buyOffers,
                    ...(state.buyOffers || {})
                }
            });
        },

        getEventCard(api) {
            const cards = Array.from(document.querySelectorAll('.castle-event-card'));

            return cards.find((card) => {
                const title = api.normalizeText(card.querySelector('.event-title')?.textContent);
                return title === 'The Hungry Merchant';
            }) || null;
        },

        getOfferForms(api) {
            const card = this.getEventCard(api);
            if (!card) return [];

            return Array.from(card.querySelectorAll('.merchant-offers form.merchant-offer')).map((form, index) => {
                const name = api.normalizeText(form.querySelector('strong')?.textContent || '');
                const rarity =
                      form.querySelector('strong')?.className ||
                      String(form.dataset.rarity || '');

                const choiceInput = form.querySelector('input[name="choice"]');
                const logs = Array.from(form.querySelectorAll('.log')).map((el) => api.normalizeText(el.textContent));

                const costLog = logs.find((text) => /cost:/i.test(text)) || '';

                return {
                    form,
                    index,
                    positionKey: ['first', 'second', 'third', 'fourth'][index] || String(index),
                    choiceValue: choiceInput ? choiceInput.value : '',
                    name,
                    rarity,
                    costLog
                };
            });
        },

        getContinueForm(api) {
            const card = this.getEventCard(api);
            if (!card) return null;

            return Array.from(card.querySelectorAll('form.event-option-form')).find((form) => {
                const input = form.querySelector('input[name="choice"]');
                return input && input.value === 'leave';
            }) || null;
        },

        getEventSignature(api) {
            const offers = this.getOfferForms(api);

            return offers.map((offer) => {
                return [
                    offer.index,
                    offer.choiceValue,
                    offer.name,
                    offer.costLog
                ].join(':');
            }).join('|');
        },

        getProgressStorageKey(api) {
            return 'tmAutoBattleExtras:' + this.id + ':progress:v1';
        },

        readProgress(api) {
            try {
                const raw = localStorage.getItem(this.getProgressStorageKey(api));
                return JSON.parse(raw || '{}');
            } catch {
                return {};
            }
        },

        writeProgress(api, progress) {
            localStorage.setItem(this.getProgressStorageKey(api), JSON.stringify(progress || {}));
        },

        resetProgressIfNewMerchant(api) {
            const signature = this.getEventSignature(api);
            const progress = this.readProgress(api);

            if (progress.signature !== signature) {
                const next = {
                    signature,
                    boughtPositions: {}
                };

                this.writeProgress(api, next);
                return next;
            }

            return {
                signature,
                boughtPositions: progress.boughtPositions || {}
            };
        },

        getNextSelectedOffer(api, state, progress) {
            const offers = this.getOfferForms(api);

            for (const offer of offers) {
                if (!state.buyOffers[offer.positionKey]) continue;
                if (progress.boughtPositions[offer.positionKey]) continue;

                return offer;
            }

            return null;
        },

        markOfferAsBought(api, offer) {
            const progress = this.readProgress(api);

            const next = {
                signature: this.getEventSignature(api),
                boughtPositions: {
                    ...(progress.boughtPositions || {}),
                    [offer.positionKey]: true
                }
            };

            this.writeProgress(api, next);
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Hungry Merchant Picker enabled.' : 'Hungry Merchant Picker paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically handle The Hungry Merchant'));

            const offerGrid = document.createElement('div');
            offerGrid.style.display = 'grid';
            offerGrid.style.gridTemplateColumns = 'repeat(2, minmax(160px, 1fr))';
            offerGrid.style.gap = '8px';
            offerGrid.style.marginBottom = '10px';

            const offerLabels = [
                ['first', 'Buy first offer'],
                ['second', 'Buy second offer'],
                ['third', 'Buy third offer'],
                ['fourth', 'Buy fourth offer']
            ];

            for (const [key, labelText] of offerLabels) {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.gap = '6px';
                label.style.alignItems = 'center';

                const checkbox = api.createCheckbox(state.buyOffers[key], (checked) => {
                    const latest = this.read(api);
                    latest.buyOffers[key] = checked;
                    this.write(api, latest);

                    api.setModuleStatus(this.id, labelText + (checked ? ' enabled.' : ' disabled.'));
                    api.scheduleScan(100);
                });

                label.appendChild(checkbox);
                label.appendChild(document.createTextNode(labelText));
                offerGrid.appendChild(label);
            }

            const continueLabel = document.createElement('label');
            continueLabel.style.display = 'flex';
            continueLabel.style.gap = '8px';
            continueLabel.style.alignItems = 'center';
            continueLabel.style.marginBottom = '10px';

            const continueCheckbox = api.createCheckbox(state.autoContinueAfterBuying, (checked) => {
                const latest = this.read(api);
                latest.autoContinueAfterBuying = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Auto-continue enabled.' : 'Auto-continue disabled.');
                api.scheduleScan(100);
            });

            continueLabel.appendChild(continueCheckbox);
            continueLabel.appendChild(document.createTextNode('Continue automatically after selected purchases'));

            const hint = document.createElement('div');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.style.marginBottom = '8px';
            hint.textContent = 'Selected offer positions are bought from top to bottom. After that, the module clicks Continue.';

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';

            scanButton.addEventListener('click', () => {
                const didResolve = this.scan(api);

                if (!didResolve) {
                    api.setModuleStatus(this.id, 'No Hungry Merchant event found or nothing to do.');
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(offerGrid);
            panel.appendChild(continueLabel);
            panel.appendChild(hint);
            panel.appendChild(scanButton);
        },

        scan(api) {
            if (this.isResolving) return false;

            const state = this.read(api);
            if (!state.enabled) return false;

            const card = this.getEventCard(api);
            if (!card) return false;

            const progress = this.resetProgressIfNewMerchant(api);
            const nextOffer = this.getNextSelectedOffer(api, state, progress);

            if (nextOffer) {
                this.isResolving = true;
                this.markOfferAsBought(api, nextOffer);

                api.setModuleStatus(
                    this.id,
                    'Buying automatically: ' +
                    (nextOffer.positionKey || 'selected') +
                    ' offer' +
                    (nextOffer.name ? ' | ' + nextOffer.name : '') +
                    (nextOffer.costLog ? ' | ' + nextOffer.costLog : '')
                );

                window.setTimeout(() => {
                    api.submitForm(nextOffer.form);
                }, Number(state.submitDelay) || 450);

                return true;
            }

            if (state.autoContinueAfterBuying) {
                const continueForm = this.getContinueForm(api);

                if (!continueForm) {
                    api.setModuleStatus(this.id, 'All selected offers handled, but Continue form was not found.');
                    return false;
                }

                this.isResolving = true;

                api.setModuleStatus(this.id, 'All selected offers handled. Continuing automatically.');

                window.setTimeout(() => {
                    api.submitForm(continueForm);
                }, Number(state.submitDelay) || 450);

                return true;
            }

            api.setModuleStatus(this.id, 'All selected offers handled. Auto-continue is disabled.');
            return false;
        }
    });

    AutoBattleExtras.registerModule({
        id: 'cursedMirrorPicker',
        title: 'Cursed Mirror Picker',

        defaults: {
            enabled: true,

            // Options: 'fight' or 'leave'
            eventDecision: 'fight',

            // Options: 'manual' or 'auto'
            fightMode: 'auto',

            submitDelay: 450
        },

        isResolving: false,

        read(api) {
            const state = api.readState(this.id, this.defaults);

            const eventDecision = ['fight', 'leave'].includes(state.eventDecision)
            ? state.eventDecision
            : 'fight';

            const fightMode = ['manual', 'auto'].includes(state.fightMode)
            ? state.fightMode
            : 'auto';

            return {
                ...this.defaults,
                ...state,
                eventDecision,
                fightMode
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state
            });
        },

        getEventCard(api) {
            const cards = Array.from(document.querySelectorAll('.castle-event-card'));

            return cards.find((card) => {
                const title = api.normalizeText(card.querySelector('.event-title')?.textContent);
                return title === 'Cursed Mirror';
            }) || null;
        },

        getEventForm(api, choice) {
            const card = this.getEventCard(api);
            if (!card) return null;

            return Array.from(card.querySelectorAll('form.event-option-form')).find((form) => {
                const input = form.querySelector('input[name="choice"]');
                return input && input.value === choice;
            }) || null;
        },

        getMirrorMonsterCard(api) {
            const cards = Array.from(document.querySelectorAll('.monster-card'));

            return cards.find((card) => {
                const monsterText = api.normalizeText(card.querySelector('.monster')?.textContent || '');
                const imageSrc = String(card.querySelector('img.monster-art')?.getAttribute('src') || '');

                return (
                    monsterText.includes('Mirrorbound Doppelganger') ||
                    imageSrc.includes('cursed_mirror_doppelganger')
                );
            }) || null;
        },

        getMirrorFightSignature(api) {
            const card = this.getMirrorMonsterCard(api);
            if (!card) return '';

            const monsterText = api.normalizeText(card.querySelector('.monster')?.textContent || '');
            const monsterHp = api.normalizeText(document.querySelector('#monsterHpText')?.textContent || '');
            const floor = api.normalizeText(document.querySelector('#battleFloorText')?.textContent || '');
            const encounter = api.normalizeText(document.querySelector('#battleEncounterText')?.textContent || '');

            return [monsterText, monsterHp, floor, encounter].join('|');
        },

        getProgressStorageKey() {
            return 'tmAutoBattleExtras:' + this.id + ':progress:v1';
        },

        readProgress() {
            try {
                return JSON.parse(localStorage.getItem(this.getProgressStorageKey()) || '{}');
            } catch {
                return {};
            }
        },

        writeProgress(progress) {
            localStorage.setItem(this.getProgressStorageKey(), JSON.stringify(progress || {}));
        },

        getNativeAutoBattleState() {
            const autoPanel = document.querySelector('#autoBattlePanel');
            const storageKey = autoPanel?.dataset?.storageKey;

            if (!storageKey) return {};

            try {
                return JSON.parse(localStorage.getItem(storageKey) || '{}');
            } catch {
                return {};
            }
        },

        startNativeAutoBattle(api) {
            const autoPanel = document.querySelector('#autoBattlePanel');
            const startButton = document.querySelector('#autoStartBtn');

            if (!autoPanel) {
                api.setModuleStatus(this.id, 'Mirror fight detected, but Auto Battle panel was not found.');
                return false;
            }

            if (!startButton) {
                api.setModuleStatus(this.id, 'Mirror fight detected, but Start Auto button was not found.');
                return false;
            }

            const nativeAutoState = this.getNativeAutoBattleState();

            if (nativeAutoState.active) {
                api.setModuleStatus(this.id, 'Mirror fight detected. Native Auto Battle is already active.');
                return false;
            }

            if (startButton.disabled) {
                api.setModuleStatus(this.id, 'Mirror fight detected, but Start Auto button is disabled.');
                return false;
            }

            const signature = this.getMirrorFightSignature(api);
            const progress = this.readProgress();

            if (progress.startedAutoForSignature === signature) {
                api.setModuleStatus(this.id, 'Mirror fight detected. Auto Battle was already started for this fight.');
                return false;
            }

            this.writeProgress({
                ...progress,
                startedAutoForSignature: signature
            });

            api.setModuleStatus(this.id, 'Mirror fight detected. Starting native Auto Battle.');

            window.setTimeout(() => {
                startButton.click();
            }, Number(this.read(api).submitDelay) || 450);

            return true;
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Cursed Mirror Picker enabled.' : 'Cursed Mirror Picker paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically handle Cursed Mirror'));

            const decisionRow = document.createElement('div');
            decisionRow.style.display = 'flex';
            decisionRow.style.gap = '8px';
            decisionRow.style.alignItems = 'center';
            decisionRow.style.flexWrap = 'wrap';
            decisionRow.style.marginBottom = '8px';

            const decisionLabel = document.createElement('span');
            decisionLabel.textContent = 'Event decision:';

            const decisionSelect = document.createElement('select');

            const fightOption = document.createElement('option');
            fightOption.value = 'fight';
            fightOption.textContent = 'Fight Your Reflection';

            const leaveOption = document.createElement('option');
            leaveOption.value = 'leave';
            leaveOption.textContent = 'Walk Away';

            decisionSelect.appendChild(fightOption);
            decisionSelect.appendChild(leaveOption);
            decisionSelect.value = state.eventDecision;

            decisionSelect.addEventListener('change', () => {
                const latest = this.read(api);
                latest.eventDecision = decisionSelect.value;
                this.write(api, latest);

                api.setModuleStatus(this.id, 'Event decision set to: ' + decisionSelect.options[decisionSelect.selectedIndex].textContent + '.');
                api.scheduleScan(100);
            });

            decisionRow.appendChild(decisionLabel);
            decisionRow.appendChild(decisionSelect);

            const fightModeRow = document.createElement('div');
            fightModeRow.style.display = 'flex';
            fightModeRow.style.gap = '8px';
            fightModeRow.style.alignItems = 'center';
            fightModeRow.style.flexWrap = 'wrap';
            fightModeRow.style.marginBottom = '8px';

            const fightModeLabel = document.createElement('span');
            fightModeLabel.textContent = 'Fight mode:';

            const fightModeSelect = document.createElement('select');

            const manualOption = document.createElement('option');
            manualOption.value = 'manual';
            manualOption.textContent = 'Manual fight';

            const autoOption = document.createElement('option');
            autoOption.value = 'auto';
            autoOption.textContent = 'Start Auto Battle';

            fightModeSelect.appendChild(manualOption);
            fightModeSelect.appendChild(autoOption);
            fightModeSelect.value = state.fightMode;

            fightModeSelect.addEventListener('change', () => {
                const latest = this.read(api);
                latest.fightMode = fightModeSelect.value;
                this.write(api, latest);

                api.setModuleStatus(this.id, 'Fight mode set to: ' + fightModeSelect.options[fightModeSelect.selectedIndex].textContent + '.');
                api.scheduleScan(100);
            });

            fightModeRow.appendChild(fightModeLabel);
            fightModeRow.appendChild(fightModeSelect);

            const hint = document.createElement('div');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.style.marginBottom = '8px';
            hint.textContent = 'If Fight + Start Auto Battle is selected, the module starts the mirror fight and then clicks the native Start Auto button.';

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';

            scanButton.addEventListener('click', () => {
                const didResolve = this.scan(api);

                if (!didResolve) {
                    api.setModuleStatus(this.id, 'No Cursed Mirror event or mirror fight action available.');
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(decisionRow);
            panel.appendChild(fightModeRow);
            panel.appendChild(hint);
            panel.appendChild(scanButton);
        },

        scan(api) {
            if (this.isResolving) return false;

            const state = this.read(api);
            if (!state.enabled) return false;

            const eventCard = this.getEventCard(api);

            if (eventCard) {
                const form = this.getEventForm(api, state.eventDecision);

                if (!form) {
                    api.setModuleStatus(this.id, 'Cursed Mirror found, but selected form was not found: ' + state.eventDecision);
                    return false;
                }

                this.isResolving = true;

                const label = state.eventDecision === 'fight'
                ? 'Fight Your Reflection'
                : 'Walk Away';

                api.setModuleStatus(this.id, 'Choosing automatically: ' + label + '.');

                window.setTimeout(() => {
                    api.submitForm(form, {
                        restartAutoBattle: state.eventDecision !== 'fight' || state.fightMode === 'auto',
                        restartReason: 'Cursed Mirror'
                    });
                }, Number(state.submitDelay) || 450);

                return true;
            }

            if (state.eventDecision === 'fight' && state.fightMode === 'auto') {
                const mirrorMonsterCard = this.getMirrorMonsterCard(api);

                if (mirrorMonsterCard) {
                    return this.startNativeAutoBattle(api);
                }
            }

            return false;
        }
    });

    AutoBattleExtras.registerModule({
        id: 'whisperingDoorPicker',
        title: 'Whispering Door Picker',

        defaults: {
            enabled: true,

            // Options: 'black', 'crimson', 'silver'
            doorChoice: 'silver',

            submitDelay: 450
        },

        isResolving: false,

        read(api) {
            const state = api.readState(this.id, this.defaults);

            const doorChoice = ['black', 'crimson', 'silver'].includes(state.doorChoice)
            ? state.doorChoice
            : 'silver';

            return {
                ...this.defaults,
                ...state,
                doorChoice
            };
        },

        write(api, state) {
            api.saveState(this.id, {
                ...this.defaults,
                ...state
            });
        },

        getEventCard(api) {
            const cards = Array.from(document.querySelectorAll('.castle-event-card'));

            return cards.find((card) => {
                const title = api.normalizeText(card.querySelector('.event-title')?.textContent);
                return title === 'Whispering Door';
            }) || null;
        },

        getEventForm(api, choice) {
            const card = this.getEventCard(api);
            if (!card) return null;

            return Array.from(card.querySelectorAll('form.event-option-form')).find((form) => {
                const input = form.querySelector('input[name="choice"]');
                return input && input.value === choice;
            }) || null;
        },

        render(panel, api) {
            const state = this.read(api);

            const enabledLabel = document.createElement('label');
            enabledLabel.style.display = 'flex';
            enabledLabel.style.gap = '8px';
            enabledLabel.style.alignItems = 'center';
            enabledLabel.style.marginBottom = '10px';

            const enabledCheckbox = api.createCheckbox(state.enabled, (checked) => {
                const latest = this.read(api);
                latest.enabled = checked;
                this.write(api, latest);

                api.setModuleStatus(this.id, checked ? 'Whispering Door Picker enabled.' : 'Whispering Door Picker paused.');
                api.scheduleScan(100);
            });

            enabledLabel.appendChild(enabledCheckbox);
            enabledLabel.appendChild(document.createTextNode('Automatically handle Whispering Door'));

            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.gap = '8px';
            row.style.alignItems = 'center';
            row.style.flexWrap = 'wrap';
            row.style.marginBottom = '8px';

            const label = document.createElement('span');
            label.textContent = 'Door choice:';

            const select = document.createElement('select');

            const options = [
                ['black', 'Black Door'],
                ['crimson', 'Crimson Door'],
                ['silver', 'Silver Door']
            ];

            for (const [value, text] of options) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = text;
                select.appendChild(option);
            }

            select.value = state.doorChoice;

            select.addEventListener('change', () => {
                const latest = this.read(api);
                latest.doorChoice = select.value;
                this.write(api, latest);

                api.setModuleStatus(
                    this.id,
                    'Door choice set to: ' + select.options[select.selectedIndex].textContent + '.'
                );

                api.scheduleScan(100);
            });

            row.appendChild(label);
            row.appendChild(select);

            const hint = document.createElement('div');
            hint.style.fontSize = '12px';
            hint.style.opacity = '0.8';
            hint.style.marginBottom = '8px';
            hint.textContent = 'Default is Silver Door. The selected door will be chosen automatically when the event appears.';

            const scanButton = document.createElement('button');
            scanButton.type = 'button';
            scanButton.textContent = 'Check now';

            scanButton.addEventListener('click', () => {
                const didResolve = this.scan(api);

                if (!didResolve) {
                    api.setModuleStatus(this.id, 'No Whispering Door event found or module is paused.');
                }
            });

            panel.appendChild(enabledLabel);
            panel.appendChild(row);
            panel.appendChild(hint);
            panel.appendChild(scanButton);
        },

        scan(api) {
            if (this.isResolving) return false;

            const state = this.read(api);
            if (!state.enabled) return false;

            const card = this.getEventCard(api);
            if (!card) return false;

            const form = this.getEventForm(api, state.doorChoice);

            if (!form) {
                api.setModuleStatus(this.id, 'Whispering Door found, but selected door was not found: ' + state.doorChoice);
                return false;
            }

            this.isResolving = true;

            const doorLabel = {
                black: 'Black Door',
                crimson: 'Crimson Door',
                silver: 'Silver Door'
            }[state.doorChoice] || state.doorChoice;

            api.setModuleStatus(this.id, 'Choosing automatically: ' + doorLabel + '.');

            window.setTimeout(() => {
                api.submitForm(form);
            }, Number(state.submitDelay) || 450);

            return true;
        }
    });


    /*
    Add future modules here, before AutoBattleExtras.start().

    Template:

    AutoBattleExtras.registerModule({
      id: 'newModuleId',
      title: 'New Module',

      defaults: {
        enabled: true
      },

      read(api) {
        return api.readState(this.id, this.defaults);
      },

      write(api, state) {
        api.saveState(this.id, state);
      },

      render(panel, api) {
        // Build module settings UI here.
      },

      scan(api) {
        // Check the page and act if needed.
      }
    });
  */

    AutoBattleExtras.start();
})();