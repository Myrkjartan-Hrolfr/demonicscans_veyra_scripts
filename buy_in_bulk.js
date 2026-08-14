// ==UserScript==
// @name         Damon's Shop - Buy up to 10,000
// @namespace    damon-shop
// @version      1.0
// @description  Erhöht die Mengenbegrenzung für unbegrenzte Tränke von 99 auf 10000.
// @match        https://demonicscans.org/olympus.php
// @grant        none
// @author       Myrkjartan Hrolfr
// ==/UserScript==

(function () {
  'use strict';

  const MAX_QTY = 10000;

  function patchShop() {
    const shop = document.querySelector('.damon-shop-modal');
    if (!shop) return;

    const cards = shop.querySelectorAll('.damon-item-card');

    for (const card of cards) {
      const qty = card.querySelector('input.damon-qty');
      if (!qty) continue;

      // Deaktivierte Felder sind z.B. Tränke mit ausgeschöpftem Wochenlimit.
      // Diese lassen wir absichtlich unangetastet.
      if (qty.disabled) continue;

      qty.max = String(MAX_QTY);

      // Falls die Seite später wieder max=99 setzt:
      qty.setAttribute('max', String(MAX_QTY));
    }
  }

  // Direkt versuchen
  patchShop();

  // Der Shop wird offenbar als Modal dynamisch erzeugt,
  // daher beobachten wir Änderungen am DOM.
  const observer = new MutationObserver(() => {
    patchShop();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
