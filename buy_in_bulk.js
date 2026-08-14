// ==UserScript==
// @name         Damon's Shop - Buy up to 10,000
// @namespace    damon-shop
// @version      1.1
// @description  Erhöht die Mengenbegrenzung für unbegrenzte Tränke von 99 auf 10000.
// @match        https://demonicscans.org/olympus.php
// @grant        none
// @author       Myrkjartan Hrolfr
// ==/UserScript==

(function () {
  'use strict';

  const MAX_TOTAL = 10000;
  const BATCH_SIZE = 99;

  // Kleine Pause zwischen den Käufen, damit der Server nicht
  // mit 100 Requests gleichzeitig bombardiert wird.
  const DELAY_MS = 400;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function formatGold(value) {
    return new Intl.NumberFormat('de-DE').format(value);
  }

  function setStatus(message) {
    const status = document.querySelector('#damonShopStatus');

    if (status) {
      status.textContent = message;
    }

    console.log('[Damon Bulk Buy]', message);
  }

  async function sendPurchase(offer, qty) {
    const response = await fetch('/olympus_damon_buy.php', {
      method: 'POST',

      // Browser/Tampermonkey verwendet automatisch deine
      // bestehenden Login-/Cloudflare-Cookies.
      credentials: 'same-origin',

      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },

      body: new URLSearchParams({
        offer: offer,
        qty: String(qty),
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.status !== 'success') {
      throw new Error(data.message || `Server meldet Status "${data.status}"`);
    }

    return data;
  }

  async function bulkBuy(card, input, button) {
    const offer = card.dataset.offer;

    const itemName = card.querySelector('.damon-item-name')?.textContent?.trim() || offer;

    let requested = Number.parseInt(input.value, 10);

    if (!Number.isFinite(requested)) {
      return;
    }

    requested = Math.max(1, Math.min(MAX_TOTAL, requested));

    input.value = String(requested);

    if (button.dataset.running === '1') {
      button.dataset.stop = '1';
      button.textContent = 'Stoppe …';
      return;
    }

    /*
     * Kleine Schutzabfrage, damit ein versehentlicher Klick
     * nicht direkt Millionen Gold verbrennt.
     */
    if (requested > 99) {
      const ok = window.confirm(
        `${requested.toLocaleString('de-DE')} × ${itemName} kaufen?\n\n` +
          `Der Kauf wird automatisch in Pakete von maximal ${BATCH_SIZE} aufgeteilt.`,
      );

      if (!ok) {
        return;
      }
    }

    button.dataset.running = '1';
    button.dataset.stop = '0';

    input.disabled = true;

    let remaining = requested;
    let purchased = 0;
    let requestNumber = 0;

    try {
      while (remaining > 0) {
        if (button.dataset.stop === '1') {
          setStatus(
            `Gestoppt: ${purchased.toLocaleString('de-DE')} ` + `von ${requested.toLocaleString('de-DE')} gekauft.`,
          );

          break;
        }

        const batch = Math.min(BATCH_SIZE, remaining);

        requestNumber++;

        const totalRequests = Math.ceil(requested / BATCH_SIZE);

        button.textContent = `${purchased.toLocaleString('de-DE')} / ` + `${requested.toLocaleString('de-DE')}`;

        setStatus(`${itemName}: Paket ${requestNumber}/${totalRequests} ` + `(${batch} Stück) …`);

        const data = await sendPurchase(offer, batch);

        purchased += batch;
        remaining -= batch;

        /*
         * Goldanzeige anhand der echten Serverantwort
         * aktualisieren.
         */
        if (typeof data.gold === 'number') {
          const goldElement = document.querySelector('#damonShopGold');

          if (goldElement) {
            goldElement.textContent = formatGold(data.gold);
          }
        }

        setStatus(
          `${itemName}: ` + `${purchased.toLocaleString('de-DE')} / ` + `${requested.toLocaleString('de-DE')} gekauft.`,
        );

        if (remaining > 0) {
          await sleep(DELAY_MS);
        }
      }

      if (remaining === 0) {
        button.textContent = '✓ Fertig';

        setStatus(`✓ ${requested.toLocaleString('de-DE')} × ` + `${itemName} erfolgreich gekauft.`);

        setTimeout(() => {
          button.textContent = 'Bulk Buy';
        }, 2000);
      }
    } catch (error) {
      console.error('[Damon Bulk Buy]', error);

      button.textContent = 'Fehler';

      setStatus(`Kauf gestoppt nach ` + `${purchased.toLocaleString('de-DE')} Stück: ` + error.message);

      setTimeout(() => {
        button.textContent = 'Bulk Buy';
      }, 2500);
    } finally {
      button.dataset.running = '0';
      button.dataset.stop = '0';

      input.disabled = false;
    }
  }

  function enhanceCard(card) {
    if (card.dataset.bulkBuyEnhanced === '1') {
      return;
    }

    /*
     * Nur Angebote ohne Wochenlimit verändern.
     *
     * Damit bleiben Full Stamina / Large Stamina
     * mit ihrem 20er-Limit unangetastet.
     */
    const meta = card.querySelector('.damon-item-meta')?.textContent || '';

    if (!meta.includes('No weekly limit')) {
      return;
    }

    const input = card.querySelector('.damon-qty');

    const buyRow = card.querySelector('.damon-buy-row');

    if (!input || !buyRow) {
      return;
    }

    card.dataset.bulkBuyEnhanced = '1';

    /*
     * Gesamtmenge darf nun bis 10.000 eingegeben werden.
     */
    input.max = String(MAX_TOTAL);

    /*
     * Normalen Buy-Button unverändert lassen.
     * Daneben kommt unser eigener Bulk-Button.
     */
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'btn primary';
    button.textContent = 'Bulk Buy';

    button.style.marginLeft = '8px';

    button.addEventListener('click', () => {
      bulkBuy(card, input, button);
    });

    buyRow.appendChild(button);
  }

  function patchShop() {
    document.querySelectorAll('.damon-item-card').forEach(enhanceCard);
  }

  /*
   * Shop existiert eventuell beim Laden der Seite noch nicht.
   */
  patchShop();

  const observer = new MutationObserver(patchShop);

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
