// ==UserScript==
// @name         Advanced Dead Monster Looter V1.5
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Auto-Merges, damage sorting, Loot Selected, Extract & Loot, with exact QUANTITY display
// @author       Gemini
// @match        https://demonicscans.org/active_wave.php*
// @grant        none
// ==/UserScript==
(function () {
  'use strict';

  setTimeout(async () => {
    const deadTitle = Array.from(document.querySelectorAll('.monster-section-title')).find((el) =>
      el.innerText.includes('Dead Monsters'),
    );
    if (!deadTitle) return;

    let deadCards = Array.from(document.querySelectorAll('.monster-card[data-dead="1"]'));
    if (deadCards.length === 0) return;

    const container = deadCards[0].parentElement;

    // --- 1. Inject the Custom Loot Modal ---
    const modalHtml = `
            <div id="tmLootModal" style="display:none; position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,.85); align-items:center; justify-content:center; font-family: sans-serif;">
              <div style="background:#2a2a3d; color:#fff; border-radius:12px; padding:20px; width:520px; max-width:92vw; max-height:80vh; overflow:auto; box-shadow:0 10px 35px rgba(0,0,0,.6);">
                <h2 style="margin:0 0 10px; text-align:center; font-size: 20px;" id="tmModalTitle">🎁 Loot Gained</h2>
                <div id="tmLootSummary" style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin:8px 0 14px;"></div>
                <div id="tmLootItems" style="display:flex; flex-wrap:wrap; gap:10px; justify-content:center;"></div>
                <div style="text-align:center; margin-top:14px;">
                  <button id="tmLootClose" style="background:#333; color:#fff; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; font-weight: bold;">Close & Refresh</button>
                </div>
              </div>
            </div>
        `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('tmLootClose').addEventListener('click', () => {
      document.getElementById('tmLootModal').style.display = 'none';
      window.location.reload();
    });

    // --- 2. Create the Control Panel (Initially Loading) ---
    const controlPanel = document.createElement('div');
    controlPanel.id = 'dmControlPanel';
    controlPanel.style.cssText = `
            grid-column: 1 / -1; width: 100%;
            background: #1A1B25; border: 1px solid #ce9e00; border-radius: 12px;
            padding: 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 12px;
            box-shadow: 0 8px 20px rgba(0,0,0,.6); font-family: sans-serif;
        `;

    controlPanel.innerHTML = `
            <div style="color: #FFD369; font-weight: bold; font-size: 15px;">🧟 Advanced Dead Monster Looter</div>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                <select id="dmFilter" style="background: #1e1e2e; color: #fff; border: 1px solid #2b2d44; padding: 8px; border-radius: 6px; outline: none; cursor: pointer;" disabled>
                    <option>Loading...</option>
                </select>
                <button id="dmSelectAll" style="background: #333; color: #fff; border: 1px solid #2b2d44; padding: 8px 12px; border-radius: 6px; cursor: pointer;" disabled>Select All Visible</button>
                <button id="dmSelectNone" style="background: #333; color: #fff; border: 1px solid #2b2d44; padding: 8px 12px; border-radius: 6px; cursor: pointer;" disabled>Select None</button>
                <button id="dmSortDamage" style="background: #3b1f2b; color: #ffd7e2; border: 1px solid #8f3f5b; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-weight: bold;" disabled title="Sort dead monster cards by your damage, ascending">🩸 Damage ↑</button>

                <div style="margin-left: auto; display: flex; gap: 8px; align-items: center; background: #111; padding: 4px 8px; border-radius: 8px; border: 1px solid #333;">
                    <span style="color: #cfd4ff; font-size: 12px;">Max to Loot:</span>
                    <input type="number" id="dmLimit" min="1" placeholder="All" style="background: #000; color: #0f0; border: 1px solid #444; padding: 6px; border-radius: 4px; width: 60px; text-align: center; font-weight: bold;">

                    <button id="dmLootSelected" style="background: #007e33; color: #fff; font-weight: bold; border: 1px solid #00c851; padding: 8px 12px; border-radius: 6px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.4);" disabled>💰 Loot Selected</button>

                    <button id="dmExtractSelected" style="background: linear-gradient(135deg, #2b114a 0%, #5b21b6 45%, #7c3aed 100%); color: #f6eeff; font-weight: bold; border: 1px solid #a855f7; padding: 8px 12px; border-radius: 6px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.4);" disabled title="Extract shadows from selected (Hard Capped at 5) then loot them">☠️ Extract & Loot</button>
                    <button id="dmLootToLevel" style="background: linear-gradient(135deg, #8a5a00 0%, #d39a00 50%, #ffca28 100%); color: #171000; font-weight: bold; border: 1px solid #ffe082; padding: 8px 12px; border-radius: 6px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.4);" disabled title="Lootet nacheinander die erste sichtbare Karte, bis ein Level-up erkannt wird">
    ⬆️ Loot to Level Up
</button>
                </div>
            </div>
            <div id="dmStatus" style="font-size: 12px; color: #FFD369;">Initializing...</div>
        `;

    deadTitle.after(controlPanel);

    const filterSel = document.getElementById('dmFilter');
    const btnAll = document.getElementById('dmSelectAll');
    const btnNone = document.getElementById('dmSelectNone');
    const btnSortDamage = document.getElementById('dmSortDamage');
    const btnLoot = document.getElementById('dmLootSelected');
    const btnExtract = document.getElementById('dmExtractSelected');
    const btnLevel = document.getElementById('dmLootToLevel');
    const limitInput = document.getElementById('dmLimit');
    const statusBox = document.getElementById('dmStatus');
    const modalTitle = document.getElementById('tmModalTitle');

    // --- 3. AUTO-MERGE PAGES PROTOCOL ---
    const pageMatch = document.body.innerText.match(/Dead loot page\s+\d+\s*\/\s*(\d+)/i);
    let maxPages = pageMatch ? parseInt(pageMatch[1], 10) : 1;
    maxPages = Math.min(maxPages, 5);

    const currentUrl = new URL(window.location.href);
    const currentPage = parseInt(currentUrl.searchParams.get('dead_page') || '1', 10);

    if (maxPages > 1 && currentPage === 1) {
      statusBox.innerText = `Auto-merging ${maxPages} pages to bypass the 200/page limit...`;
      for (let p = 2; p <= maxPages; p++) {
        statusBox.innerText = `Fetching page ${p} of ${maxPages}...`;
        currentUrl.searchParams.set('dead_page', p);
        try {
          let res = await fetch(currentUrl.toString(), { credentials: 'same-origin' });
          let html = await res.text();
          let doc = new DOMParser().parseFromString(html, 'text/html');
          let newCards = Array.from(doc.querySelectorAll('.monster-card[data-dead="1"]'));
          newCards.forEach((card) => {
            container.appendChild(card);
            deadCards.push(card);
          });
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 200));
      }
      Array.from(document.querySelectorAll('*')).forEach((el) => {
        if (el.childNodes.length === 1 && el.nodeType === 1 && el.innerText.match(/Dead loot page/i)) {
          const wrap = el.closest('div[style*="flex"], div[style*="grid"]') || el.parentElement;
          if (wrap) wrap.style.display = 'none';
        }
      });
    }

    // --- Damage sort toggle ---
    // Capture the final merged order so the second click can restore it exactly.
    const originalDeadCardOrder = [...deadCards];
    const originalDeadCardIndex = new Map(originalDeadCardOrder.map((card, index) => [card, index]));
    let damageSortActive = false;

    const getCardUserDamage = (card) => {
      const damage = Number.parseInt(card.dataset.userdmg || '0', 10);
      return Number.isFinite(damage) ? damage : 0;
    };

    const applyDeadCardOrder = (cards) => {
      cards.forEach((card) => container.appendChild(card));
    };

    btnSortDamage.addEventListener('click', () => {
      damageSortActive = !damageSortActive;

      if (damageSortActive) {
        const sortedCards = [...deadCards].sort((a, b) => {
          const damageDifference = getCardUserDamage(a) - getCardUserDamage(b);

          // Stable tie-breaker: preserve the original order for equal damage.
          if (damageDifference !== 0) return damageDifference;
          return originalDeadCardIndex.get(a) - originalDeadCardIndex.get(b);
        });

        applyDeadCardOrder(sortedCards);
        btnSortDamage.innerText = '↩ Original Order';
        btnSortDamage.title = 'Restore the original dead monster card order';
        btnSortDamage.style.background = '#6b263e';
        statusBox.innerHTML = '<span style="color:#ff9fbd;">🩸 Sorted by your damage: lowest → highest.</span>';
      } else {
        applyDeadCardOrder(originalDeadCardOrder);
        btnSortDamage.innerText = '🩸 Damage ↑';
        btnSortDamage.title = 'Sort dead monster cards by your damage, ascending';
        btnSortDamage.style.background = '#3b1f2b';
        statusBox.innerHTML = '<span style="color:#00c851;">Original monster order restored.</span>';
      }
    });

    // --- 4. Inject Checkboxes ---
    deadCards.forEach((card) => {
      const isEligible = card.dataset.eligible === '1';
      const cbWrap = document.createElement('div');
      cbWrap.style.cssText = `
                position: absolute; top: 12px; left: 12px; z-index: 10;
                background: rgba(10,11,18,0.8); padding: 6px; border-radius: 8px;
                border: 1px solid ${isEligible ? '#ce9e00' : '#444'}; display: flex; align-items: center; justify-content: center;
            `;
      cbWrap.innerHTML = `<input type="checkbox" class="dm-checkbox" data-id="${card.dataset.monsterId}" style="width: 18px; height: 18px; cursor: ${isEligible ? 'pointer' : 'not-allowed'};" ${isEligible ? '' : 'disabled title="Not eligible to interact"'}>`;
      card.style.position = 'relative';
      card.appendChild(cbWrap);
      if (!isEligible) card.style.opacity = '0.5';
    });

    // --- 5. Build Filter and Enable UI ---
    const uniqueNames = [...new Set(deadCards.map((c) => c.dataset.name))].sort();
    let optionsHtml = `<option value="ALL">All Monsters</option>`;
    uniqueNames.forEach((name) => {
      if (!name) return;
      const neatName = name.replace(/\b\w/g, (l) => l.toUpperCase());
      optionsHtml += `<option value="${name}">${neatName}</option>`;
    });
    filterSel.innerHTML = optionsHtml;

    filterSel.disabled = false;
    btnAll.disabled = false;
    btnNone.disabled = false;
    btnSortDamage.disabled = false;
    btnLoot.disabled = false;
    btnExtract.disabled = false;
    btnLevel.disabled = false;
    statusBox.innerHTML = `<span style="color:#00c851;">Ready! ${deadCards.length} monsters consolidated onto one screen.</span>`;

    filterSel.addEventListener('change', (e) => {
      const target = e.target.value;
      document.querySelectorAll('.monster-card[data-dead="1"]').forEach((card) => {
        if (target === 'ALL' || card.dataset.name === target) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
          const cb = card.querySelector('.dm-checkbox');
          if (cb) cb.checked = false;
        }
      });
    });

    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.dm-checkbox:not(:disabled)').forEach((cb) => {
        if (cb.closest('.monster-card').style.display !== 'none') cb.checked = true;
      });
    });

    btnNone.addEventListener('click', () => {
      document.querySelectorAll('.dm-checkbox').forEach((cb) => (cb.checked = false));
    });

    // --- Exact loot response helpers ---
    // The normal battle-page loot button reads item.QUANTITY first and then
    // item.quantity. Stacked monsters therefore return one object whose
    // QUANTITY contains the real number of acquired units.
    const parsePositiveQuantity = (value, fallback = 1) => {
      if (value === null || value === undefined || value === '') return fallback;

      if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
      }

      let normalized = String(value).trim();
      if (!normalized) return fallback;

      // Accept plain values such as "75", "75.00" and formatted integers
      // such as "1,250" without turning 75.00 into 7500.
      if (/^\d{1,3}(?:[,.]\d{3})+$/.test(normalized)) {
        normalized = normalized.replace(/[,.]/g, '');
      }

      const parsed = Number(normalized);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    };

    const parseLootQuantity = (item) => {
      if (!item || typeof item !== 'object') return 1;

      // Exact order used by the game's own Claim Loot handler.
      const exactQuantity = item.QUANTITY ?? item.quantity;
      if (exactQuantity !== null && exactQuantity !== undefined && exactQuantity !== '') {
        return parsePositiveQuantity(exactQuantity, 1);
      }

      // Compatibility fallbacks for other loot response variants.
      const quantityCandidates = [
        item.QTY,
        item.qty,
        item.AMOUNT,
        item.amount,
        item.COUNT,
        item.count,
        item.STACK,
        item.stack,
        item.stack_size,
        item.stackSize,
        item.item_count,
        item.itemCount,
        item.pivot?.QUANTITY,
        item.pivot?.quantity,
        item.pivot?.qty,
        item.meta?.QUANTITY,
        item.meta?.quantity,
        item.meta?.qty,
      ];

      for (const value of quantityCandidates) {
        const quantity = parsePositiveQuantity(value, 0);
        if (quantity > 0) return quantity;
      }

      return 1;
    };

    const getLootItemName = (item) =>
      item?.NAME || item?.name || item?.ITEM_NAME || item?.item_name || item?.title || 'Unknown Item';

    const getLootItemImage = (item) =>
      item?.IMAGE_URL ||
      item?.image_url ||
      item?.image ||
      item?.IMG ||
      item?.img ||
      'https://via.placeholder.com/64?text=Item';

    const normalizeLootPayload = (payload, source = 'normal') => {
      if (!payload) return [];

      if (Array.isArray(payload)) {
        return payload
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({ ...item, __lootSource: source }));
      }

      if (typeof payload !== 'object') return [];

      const looksLikeSingleItem = Boolean(
        payload.NAME ||
        payload.name ||
        payload.ITEM_NAME ||
        payload.item_name ||
        payload.IMAGE_URL ||
        payload.image_url ||
        payload.image,
      );

      if (looksLikeSingleItem) {
        return [{ ...payload, __lootSource: source }];
      }

      return Object.entries(payload).flatMap(([name, value]) => {
        if (value && typeof value === 'object') {
          return [{ name, ...value, __lootSource: source }];
        }

        const quantity = parsePositiveQuantity(value, 0);
        return quantity > 0 ? [{ name, QUANTITY: quantity, __lootSource: source }] : [];
      });
    };

    /*
     * Mirrors the real Claim Loot response:
     *   data.items            -> normal monster drops
     *   data.ranking_rewards  -> damage-ranking rewards
     * It also keeps compatibility with older nested response shapes.
     */
    const extractLootItems = (data) => {
      if (!data || typeof data !== 'object') return [];

      const normalPayload =
        data.items ?? data.rewards?.items ?? data.loot?.items ?? data.item ?? data.rewards?.item ?? data.loot?.item;

      const normalItems = normalizeLootPayload(normalPayload, 'normal');
      const rankingItems = normalizeLootPayload(data.ranking_rewards, 'ranking');

      return [...normalItems, ...rankingItems];
    };

    // Adds one API loot entry to the visual summary and returns its real unit count.
    const addLootItem = (itemGroups, item) => {
      const quantity = parseLootQuantity(item);
      const name = getLootItemName(item);
      const image = getLootItemImage(item);
      const source = item?.__lootSource === 'ranking' ? 'ranking' : 'normal';
      const itemId = item?.ID || item?.id || item?.item_id || item?.ITEM_ID || name;
      const groupKey = `${source}:${String(itemId)}`;

      if (!itemGroups[groupKey]) {
        itemGroups[groupKey] = {
          name,
          img: image,
          qty: 0,
          source,
        };
      }

      itemGroups[groupKey].qty += quantity;
      return quantity;
    };

    const renderSummary = (
      boxesProcessed,
      successCount,
      failCount,
      totalExp,
      totalGold,
      rawItemCount,
      itemGroups,
      titleText = '🎁 Loot Gained',
    ) => {
      modalTitle.innerText = titleText;
      const pillStyle =
        'background:#212439; color:#cdd1ea; border:1px solid #2b2e49; border-radius:999px; padding:4px 12px; font-size:13px; font-weight:bold;';
      document.getElementById('tmLootSummary').innerHTML = `
                <span style="${pillStyle}">Processed: ${boxesProcessed}</span>
                <span style="${pillStyle}">Success: ${successCount}</span>
                <span style="${pillStyle}">Fail: ${failCount}</span>
                <span style="${pillStyle}">EXP: ${totalExp.toLocaleString()}</span>
                <span style="${pillStyle}">Gold: ${totalGold.toLocaleString()}</span>
                <span style="${pillStyle}">Item units: ${rawItemCount.toLocaleString()}</span>
            `;
      const itemsContainer = document.getElementById('tmLootItems');
      const aggregatedItems = Object.values(itemGroups).sort((a, b) => b.qty - a.qty);
      if (aggregatedItems.length > 0) {
        itemsContainer.innerHTML = aggregatedItems
          .map(
            (it) => `
                    <div style="background:#1e1e2f; border:1px solid #2b2d44; border-radius:10px; width:92px; padding:8px; text-align:center; display:flex; flex-direction:column; justify-content:space-between; position:relative;">
                        ${it.qty > 1 ? `<span style="position:absolute; top:4px; right:4px; background:#111827; color:#fff; font-size:11px; font-weight:600; padding:2px 6px; border-radius:999px; border:1px solid #2b2d44; line-height:1; pointer-events:none;">x${it.qty.toLocaleString()}</span>` : ''}
                        <img src="${it.img}" style="width:64px; height:64px; object-fit:cover; border-radius:8px; display:block; margin:0 auto 6px;">
                        <small style="display:block; line-height:1.2; font-size:11px;">${it.name}</small>
                        ${it.source === 'ranking' ? '<small style="display:block; margin-top:4px; color:#ffd369; font-size:9px; font-weight:bold;">RANK REWARD</small>' : ''}
                    </div>
                `,
          )
          .join('');
      } else {
        itemsContainer.innerHTML = `<div style="color:#9aa0be; padding:10px;">Nothing acquired this run.</div>`;
      }
      document.getElementById('tmLootModal').style.display = 'flex';
    };

    // --- LOOT UNTIL NEXT LEVEL ENGINE ---

    const LEVEL_BUTTON_IDLE_BACKGROUND = 'linear-gradient(135deg, #8a5a00 0%, #d39a00 50%, #ffca28 100%)';

    let levelLootRunning = false;
    let levelLootStopRequested = false;

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const parseLevelNumber = (value) => {
      if (value === null || value === undefined || value === '') {
        return null;
      }

      const level = Number.parseInt(value, 10);
      return Number.isFinite(level) ? level : null;
    };

    /*
     * Versucht, das Spielerlevel aus der Seite zu lesen.
     *
     * Monsterkarten werden bewusst ausgeschlossen, damit nicht
     * versehentlich das Level eines Monsters erkannt wird.
     */
    const readPlayerLevel = (root = document) => {
      const levelElement = root.querySelector('.game-topbar .gtb-level, .gtb-level');

      if (!levelElement) {
        console.warn('[Loot to Level Up] .gtb-level wurde nicht gefunden.');
        return null;
      }

      const levelText = levelElement.textContent.trim();
      const match = levelText.match(/\bLV\s*([\d.,]+)/i);

      if (!match) {
        console.warn('[Loot to Level Up] Level konnte nicht gelesen werden:', levelText);
        return null;
      }

      /*
       * Entfernt Punkte und Kommas, falls das Level irgendwann
       * beispielsweise als "LV 3,154" angezeigt wird.
       */
      const level = Number.parseInt(match[1].replace(/[^\d]/g, ''), 10);

      return Number.isFinite(level) ? level : null;
    };

    /*
     * Lädt eine frische Version der Seite, um das aktuelle Spielerlevel
     * unabhängig von der möglicherweise noch nicht aktualisierten DOM
     * zu prüfen.
     */
    const fetchCurrentPlayerLevel = async () => {
      try {
        const freshUrl = new URL(window.location.href);

        /*
         * Verhindert, dass Browser oder Server eine alte Seite
         * aus dem Cache zurückgeben.
         */
        freshUrl.searchParams.set('_tm_level_check', Date.now().toString());

        const response = await fetch(freshUrl.toString(), {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
          },
        });

        if (!response.ok) {
          console.warn('[Loot to Level Up] Level-Seite konnte nicht geladen werden:', response.status);
          return null;
        }

        const html = await response.text();

        const freshDocument = new DOMParser().parseFromString(html, 'text/html');

        const freshLevel = readPlayerLevel(freshDocument);

        console.log('[Loot to Level Up] Frisch geladenes Level:', freshLevel);

        return freshLevel;
      } catch (error) {
        console.error('[Loot to Level Up] Level-Prüfung fehlgeschlagen:', error);

        return null;
      }
    };

    /*
     * Liest das Spielerlevel aus häufig verwendeten API-Feldern.
     */
    const readResponseLevel = (data) => {
      if (!data || typeof data !== 'object') {
        return null;
      }

      const possibleValues = [
        data.new_level,
        data.newLevel,
        data.current_level,
        data.currentLevel,
        data.player_level,
        data.playerLevel,
        data.user_level,
        data.userLevel,
        data.character_level,
        data.characterLevel,
        data.level,

        data.user?.level,
        data.user?.new_level,
        data.user?.newLevel,

        data.player?.level,
        data.player?.new_level,
        data.player?.newLevel,

        data.character?.level,
        data.character?.new_level,
        data.character?.newLevel,

        data.rewards?.new_level,
        data.rewards?.newLevel,
        data.rewards?.level,
      ];

      for (const value of possibleValues) {
        const level = parseLevelNumber(value);

        if (level !== null) {
          return level;
        }
      }

      return null;
    };

    const isTruthyLevelFlag = (value) => {
      return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
    };

    /*
     * Prüft:
     * 1. Explizite level_up-Felder
     * 2. Erfolgsmeldungen wie "leveled up"
     * 3. Ein höheres Level als beim Start
     */
    const detectLevelUp = (data, rawText, startingLevel) => {
      const explicitFlag = [
        data?.level_up,
        data?.levelUp,
        data?.leveled_up,
        data?.leveledUp,
        data?.did_level_up,
        data?.didLevelUp,
      ].some(isTruthyLevelFlag);

      const statusValue = String(data?.status || '').toLowerCase();

      const explicitStatus = ['level_up', 'levelup', 'leveled_up', 'levelled_up'].includes(statusValue);

      const messageText = [data?.message, data?.notification, data?.result, typeof rawText === 'string' ? rawText : '']
        .filter(Boolean)
        .join(' ');

      const negativeMessage =
        /\b(?:did\s+not|not|no)\s+level(?:ed|led)?\s*up\b/i.test(messageText) ||
        /\bkein(?:en|e)?\s+levelaufstieg\b/i.test(messageText);

      const positiveMessage =
        !negativeMessage &&
        /\b(?:level(?:ed|led)?\s*up|reached\s+(?:a\s+)?new\s+level|new\s+level\s+(?:reached|achieved)|levelaufstieg|neues\s+level|level\s+erreicht)\b/i.test(
          messageText,
        );

      const responseLevel = readResponseLevel(data);

      const numericIncrease = startingLevel !== null && responseLevel !== null && responseLevel > startingLevel;

      return {
        reached: explicitFlag || explicitStatus || positiveMessage || numericIncrease,
        level: responseLevel,
      };
    };

    const isLootSuccessResponse = (data) => {
      return (
        data?.status === 'success' ||
        data?.success === true ||
        (typeof data?.message === 'string' && data.message.toLowerCase().includes('success'))
      );
    };

    /*
     * Gibt die erste sichtbare, lootbare und in diesem Lauf noch nicht
     * versuchte Karte zurück.
     */
    const getFirstLootableCheckbox = (attemptedIds) => {
      const checkboxes = Array.from(
        document.querySelectorAll('.monster-card[data-dead="1"] .dm-checkbox:not(:disabled)'),
      );

      return (
        checkboxes.find((checkbox) => {
          const monsterId = checkbox.dataset.id;
          const card = checkbox.closest('.monster-card');

          if (!card || !monsterId) return false;
          if (attemptedIds.has(monsterId)) return false;
          if (card.style.display === 'none') return false;
          if (card.style.pointerEvents === 'none') return false;

          const opacity = Number.parseFloat(card.style.opacity || '1');

          return opacity > 0.2;
        }) || null
      );
    };

    btnLevel.addEventListener('click', async () => {
      /*
       * Wird der Button während eines laufenden Vorgangs erneut
       * angeklickt, dient er als Stopptaste.
       */
      if (levelLootRunning) {
        levelLootStopRequested = true;
        btnLevel.innerText = 'Stopping...';
        btnLevel.disabled = true;

        statusBox.innerHTML = '<span style="color:#ffbb33;">Stopping after the current request...</span>';

        return;
      }

      const initialCard = getFirstLootableCheckbox(new Set());

      if (!initialCard) {
        statusBox.innerText = 'No visible and eligible monsters are available!';
        return;
      }

      levelLootRunning = true;
      levelLootStopRequested = false;

      btnLoot.disabled = true;
      btnExtract.disabled = true;
      btnAll.disabled = true;
      btnNone.disabled = true;
      btnSortDamage.disabled = true;
      filterSel.disabled = true;
      limitInput.disabled = true;

      btnLevel.disabled = false;
      btnLevel.innerText = '⏹ Stop Level Loot';
      btnLevel.style.background = 'linear-gradient(135deg, #5c1010 0%, #a51d1d 55%, #e53935 100%)';
      btnLevel.style.color = '#fff';

      let totalExp = 0;
      let totalGold = 0;
      let successCount = 0;
      let failCount = 0;
      let rawItemCount = 0;
      let processedCount = 0;

      const itemGroups = {};
      const attemptedIds = new Set();

      const startingLevel = readPlayerLevel(document) ?? (await fetchCurrentPlayerLevel());

      let lastKnownLevel = startingLevel;
      let levelReached = false;

      console.log('[Loot to Level Up] Festes Startlevel:', startingLevel);

      if (startingLevel === null) {
        statusBox.innerHTML = `
        <span style="color:#ff4444;">
            Player-Level konnte in .gtb-level nicht gefunden werden.
        </span>
    `;

        return;
      }
      let finishReason = 'No more eligible cards are available.';

      try {
        /*
         * Falls das Level nicht direkt im vorhandenen DOM gefunden
         * wurde, einmal eine frische Seite abrufen.
         */
        if (startingLevel === null) {
          statusBox.innerText = 'Detecting current player level...';
          startingLevel = await fetchCurrentPlayerLevel();
          lastKnownLevel = startingLevel;
        }

        while (!levelLootStopRequested) {
          const checkbox = getFirstLootableCheckbox(attemptedIds);

          if (!checkbox) {
            finishReason = 'No more visible and eligible cards are available.';
            break;
          }

          const monsterId = checkbox.dataset.id;
          const card = checkbox.closest('.monster-card');

          /*
           * Fehlgeschlagene Karten werden während dieses Laufs
           * nicht endlos erneut versucht.
           */
          attemptedIds.add(monsterId);
          processedCount++;

          const levelText =
            startingLevel !== null
              ? ` Starting level: ${startingLevel}.`
              : ' Waiting for a level-up signal from the server.';

          statusBox.innerHTML = `
                        Looting first available card
                        <span style="color:#FFD369;">#${processedCount}</span>.
                        ${levelText}
                        <br>
                        <span style="color:#9aa0be;">Click the red button to stop.</span>
                    `;

          try {
            const formData = new FormData();
            formData.append('monster_id', monsterId);

            if (typeof USER_ID !== 'undefined') {
              formData.append('user_id', USER_ID);
            }

            const response = await fetch('loot.php', {
              method: 'POST',
              body: formData,
              credentials: 'same-origin',
            });

            const rawText = await response.text();

            let data = {};

            try {
              data = JSON.parse(
                String(rawText)
                  .replace(/^\uFEFF/, '')
                  .trim(),
              );
            } catch (parseError) {
              console.warn('Loot response was not valid JSON:', rawText);
            }

            const isSuccess = isLootSuccessResponse(data);

            if (!isSuccess) {
              failCount++;

              console.warn('Loot to Level Up failed for monster:', monsterId, data);

              await wait(350);
              continue;
            }

            successCount++;

            if (data.rewards) {
              totalExp += Number(data.rewards.exp || 0);
              totalGold += Number(data.rewards.gold || 0);
            } else {
              totalExp += Number(data.exp || 0);
              totalGold += Number(data.gold || 0);
            }

            const itemsArray = extractLootItems(data);

            itemsArray.forEach((item) => {
              rawItemCount += addLootItem(itemGroups, item);
            });

            /*
             * Erfolgreich gelootete Karte aus der lokalen Ansicht
             * entfernen beziehungsweise deaktivieren.
             */
            if (card) {
              card.style.opacity = '0.2';
              card.style.pointerEvents = 'none';
            }

            checkbox.checked = false;

            let levelResult = detectLevelUp(data, rawText, startingLevel);

            /*
             * Dem Server kurz Zeit geben, das neue Level zu speichern.
             */
            await wait(300);

            /*
             * Das Spielerlevel wird gezielt aus:
             *
             * <div class="gtb-level">LV 3154</div>
             *
             * auf einer frisch geladenen Seite gelesen.
             */
            let currentLevel = await fetchCurrentPlayerLevel();

            /*
             * Zweite Prüfung, falls der Server das neue Level
             * mit etwas Verzögerung speichert.
             */
            if (currentLevel === null || currentLevel <= startingLevel) {
              await wait(700);

              const secondLevelCheck = await fetchCurrentPlayerLevel();

              if (secondLevelCheck !== null) {
                currentLevel = secondLevelCheck;
              }
            }

            console.log('[Loot to Level Up] Levelvergleich:', {
              startingLevel,
              currentLevel,
              monsterId,
            });

            if (currentLevel !== null) {
              lastKnownLevel = currentLevel;
            }

            if (currentLevel !== null && currentLevel > startingLevel) {
              levelReached = true;
              finishReason = `Level ${currentLevel} erreicht.`;

              statusBox.innerHTML = `
        <span style="color:#00e676; font-weight:bold;">
            ⬆️ Level ${currentLevel} erreicht. Looting wurde gestoppt.
        </span>
    `;

              console.log('[Loot to Level Up] LEVEL-UP ERKANNT. STOP.', {
                startingLevel,
                currentLevel,
              });

              break;
            }
          } catch (error) {
            failCount++;

            console.error('Loot to Level Up request failed:', monsterId, error);
          }

          await wait(350);
        }

        if (levelLootStopRequested) {
          finishReason = 'Stopped manually.';
        }

        if (levelReached) {
          statusBox.innerHTML = `
                        <span style="color:#00e676; font-weight:bold;">
                            ⬆️ ${finishReason}
                        </span>
                    `;
        } else if (levelLootStopRequested) {
          statusBox.innerHTML = `
                        <span style="color:#ffbb33; font-weight:bold;">
                            ⏹ Loot to Level Up stopped manually.
                        </span>
                    `;
        } else {
          statusBox.innerHTML = `
                        <span style="color:#ffbb33;">
                            ${finishReason}
                        </span>
                    `;
        }

        let summaryTitle;

        if (levelReached) {
          summaryTitle = lastKnownLevel !== null ? `⬆️ Level ${lastKnownLevel} Reached` : '⬆️ Level Up Reached';
        } else if (levelLootStopRequested) {
          summaryTitle = '⏹ Level Loot Stopped';
        } else {
          summaryTitle = '🎁 Level Loot Finished';
        }

        renderSummary(
          processedCount,
          successCount,
          failCount,
          totalExp,
          totalGold,
          rawItemCount,
          itemGroups,
          summaryTitle,
        );
      } finally {
        levelLootRunning = false;
        levelLootStopRequested = false;

        btnLevel.innerText = '⬆️ Loot to Level Up';
        btnLevel.style.background = LEVEL_BUTTON_IDLE_BACKGROUND;
        btnLevel.style.color = '#171000';
        btnLevel.disabled = false;

        btnLoot.disabled = false;
        btnExtract.disabled = false;
        btnAll.disabled = false;
        btnNone.disabled = false;
        btnSortDamage.disabled = false;
        filterSel.disabled = false;
        limitInput.disabled = false;
      }
    });

    // --- 6. EXTRACTION & LOOT COMBO ENGINE ---
    btnExtract.addEventListener('click', async () => {
      const selectedBoxes = document.querySelectorAll('.dm-checkbox:checked');
      if (selectedBoxes.length === 0) {
        statusBox.innerText = 'No monsters selected for extraction!';
        return;
      }

      // Safety limit to prevent wasting attempts
      const boxesToProcess = Array.from(selectedBoxes).slice(0, 5);
      if (selectedBoxes.length > 5) {
        Array.from(selectedBoxes)
          .slice(5)
          .forEach((cb) => (cb.checked = false));
      }

      btnExtract.disabled = true;
      btnLoot.disabled = true;
      btnLevel.disabled = true;

      let successCount = 0,
        failCount = 0;
      let totalExp = 0,
        totalGold = 0,
        rawItemCount = 0;
      let itemGroups = {};

      for (let i = 0; i < boxesToProcess.length; i++) {
        const mId = boxesToProcess[i].dataset.id;
        statusBox.innerHTML = `Extracting & Looting <span style="color:#b794ff;">${i + 1} of ${boxesToProcess.length}</span>...`;

        let actionSuccess = false;

        // 1. EXTRACT SHADOW
        try {
          const fdExt = new URLSearchParams();
          fdExt.set('action', 'extract_shadow');

          const resExt = await fetch(`/battle.php?id=${mId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: fdExt.toString(),
            credentials: 'same-origin',
          });

          const textExt = await resExt.text();
          let dataExt = {};
          try {
            dataExt = JSON.parse(
              String(textExt)
                .replace(/^\uFEFF/, '')
                .trim(),
            );
          } catch (e) {}

          if (dataExt.ok || dataExt.status === 'success') {
            actionSuccess = true;

            // Parse Shadow Details
            const sName = dataExt.shadow && dataExt.shadow.name ? dataExt.shadow.name : 'Shadow Captured';
            const sImg =
              dataExt.shadow && dataExt.shadow.image
                ? dataExt.shadow.image
                : 'https://via.placeholder.com/64?text=Shadow';

            const shadowQuantity = parseLootQuantity(dataExt.shadow || {});
            const shadowKey = String(dataExt.shadow?.id || dataExt.shadow?.ID || `shadow:${sName}`);
            if (!itemGroups[shadowKey]) itemGroups[shadowKey] = { name: sName, img: sImg, qty: 0 };
            itemGroups[shadowKey].qty += shadowQuantity;
            rawItemCount += shadowQuantity;
          }
        } catch (e) {
          console.error('Extraction failed for', mId, e);
        }

        // Small buffer so the server processes the commands cleanly
        await new Promise((r) => setTimeout(r, 300));

        // 2. LOOT BODY
        try {
          const fdLoot = new FormData();
          fdLoot.append('monster_id', mId);
          if (typeof USER_ID !== 'undefined') fdLoot.append('user_id', USER_ID);

          const resLoot = await fetch('loot.php', { method: 'POST', body: fdLoot, credentials: 'same-origin' });
          const textLoot = await resLoot.text();
          let dataLoot = {};
          try {
            dataLoot = JSON.parse(
              String(textLoot)
                .replace(/^\uFEFF/, '')
                .trim(),
            );
          } catch (e) {}

          const isSuccess =
            dataLoot.status === 'success' ||
            dataLoot.success === true ||
            (typeof dataLoot.message === 'string' && dataLoot.message.toLowerCase().includes('success'));

          if (isSuccess) {
            actionSuccess = true;
            if (dataLoot.rewards) {
              totalExp += dataLoot.rewards.exp || 0;
              totalGold += dataLoot.rewards.gold || 0;
            } else if (dataLoot.exp || dataLoot.gold) {
              totalExp += dataLoot.exp || 0;
              totalGold += dataLoot.gold || 0;
            }

            const itemsArray = extractLootItems(dataLoot);

            itemsArray.forEach((item) => {
              rawItemCount += addLootItem(itemGroups, item);
            });
          }
        } catch (e) {
          console.error('Looting failed for', mId, e);
        }

        // If either extraction or looting succeeded, count it as a win and grey out the card
        if (actionSuccess) {
          successCount++;
          boxesToProcess[i].closest('.monster-card').style.opacity = '0.2';
          boxesToProcess[i].closest('.monster-card').style.pointerEvents = 'none';
          boxesToProcess[i].checked = false;
        } else {
          failCount++;
        }

        await new Promise((r) => setTimeout(r, 400));
      }

      statusBox.innerHTML = `<span style="color:#b794ff;">Extraction & Looting Complete!</span>`;
      renderSummary(
        boxesToProcess.length,
        successCount,
        failCount,
        totalExp,
        totalGold,
        rawItemCount,
        itemGroups,
        '☠️ Extracted & 🎁 Looted',
      );

      btnExtract.disabled = false;
      btnLoot.disabled = false;
      btnLevel.disabled = false;
    });

    // --- 7. Standard Loot Loop ---
    btnLoot.addEventListener('click', async () => {
      const selectedBoxes = document.querySelectorAll('.dm-checkbox:checked');
      if (selectedBoxes.length === 0) {
        statusBox.innerText = 'No monsters selected!';
        return;
      }

      const maxVal = parseInt(limitInput.value, 10);
      const limit = isNaN(maxVal) || maxVal <= 0 ? selectedBoxes.length : maxVal;
      const boxesToProcess = Array.from(selectedBoxes).slice(0, limit);

      if (limit < selectedBoxes.length)
        Array.from(selectedBoxes)
          .slice(limit)
          .forEach((cb) => (cb.checked = false));

      btnLoot.innerText = 'Looting...';
      btnLoot.disabled = true;
      btnExtract.disabled = true;
      btnLevel.disabled = true;
      let totalExp = 0,
        totalGold = 0,
        successCount = 0,
        failCount = 0,
        rawItemCount = 0;
      let itemGroups = {};

      for (let i = 0; i < boxesToProcess.length; i++) {
        const mId = boxesToProcess[i].dataset.id;
        statusBox.innerText = `Looting visible item ${i + 1} of ${boxesToProcess.length}...`;

        try {
          const fd = new FormData();
          fd.append('monster_id', mId);
          if (typeof USER_ID !== 'undefined') fd.append('user_id', USER_ID);

          const res = await fetch('loot.php', { method: 'POST', body: fd, credentials: 'same-origin' });
          const text = await res.text();
          let data = {};
          try {
            data = JSON.parse(
              String(text)
                .replace(/^\uFEFF/, '')
                .trim(),
            );
          } catch (e) {}

          const isSuccess =
            data.status === 'success' ||
            data.success === true ||
            (typeof data.message === 'string' && data.message.toLowerCase().includes('success'));

          if (isSuccess) {
            successCount++;
            if (data.rewards) {
              totalExp += data.rewards.exp || 0;
              totalGold += data.rewards.gold || 0;
            } else if (data.exp || data.gold) {
              totalExp += data.exp || 0;
              totalGold += data.gold || 0;
            }

            const itemsArray = extractLootItems(data);

            itemsArray.forEach((item) => {
              rawItemCount += addLootItem(itemGroups, item);
            });

            boxesToProcess[i].closest('.monster-card').style.opacity = '0.2';
            boxesToProcess[i].closest('.monster-card').style.pointerEvents = 'none';
            boxesToProcess[i].checked = false;
          } else {
            failCount++;
          }
        } catch (e) {
          failCount++;
        }

        await new Promise((r) => setTimeout(r, 250));
      }

      statusBox.innerHTML = `<span style="color:#00c851;">Finished!</span>`;
      renderSummary(boxesToProcess.length, successCount, failCount, totalExp, totalGold, rawItemCount, itemGroups);
      btnLoot.innerText = '💰 Loot Selected';

      btnLoot.disabled = false;
      btnExtract.disabled = false;
      btnLevel.disabled = false;
    });
  }, 1500);
})();
