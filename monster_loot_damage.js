// ==UserScript==
// @name         Monster Loot - Show Your Damage
// @namespace    tampermonkey-monster-damage
// @version      1.0
// @description  Zeigt den eigenen verursachten Schaden auf Loot-Monsterkarten an
// @match        https://demonicscans.org/active_wave.php?gate=*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  function formatNumber(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return value;
    }

    return number.toLocaleString('en-US');
  }

  function addDamageToLootCards() {
    const cards = document.querySelectorAll('.monster-card[data-dead="1"][data-userdmg]');

    cards.forEach((card) => {
      // Nicht doppelt einfügen
      if (card.querySelector('.tm-user-damage')) {
        return;
      }

      const damage = card.dataset.userdmg;

      if (!damage || Number(damage) <= 0) {
        return;
      }

      const heading = card.querySelector('h3');

      if (!heading) {
        return;
      }

      // Gleicher Aufbau wie bei der Angriffs-Karte
      const row = document.createElement('div');

      row.className = 'monster-select-row tm-user-damage';

      row.style.cssText = `
                display: flex;
                justify-content: center;
                gap: 8px;
                align-items: center;
                margin: 6px 0 2px;
            `;

      const chip = document.createElement('span');

      chip.className = 'mini-chip party-chip';
      chip.title = 'Your damage dealt';
      chip.textContent = `🩸 You: ${formatNumber(damage)}`;

      row.appendChild(chip);

      // Direkt unter dem Monsternamen einfügen
      heading.insertAdjacentElement('afterend', row);
    });
  }

  // Beim Laden ausführen
  addDamageToLootCards();

  // Falls Monsterkarten dynamisch per AJAX nachgeladen werden
  const observer = new MutationObserver(() => {
    addDamageToLootCards();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
