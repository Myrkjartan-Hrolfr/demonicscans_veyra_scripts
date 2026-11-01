// ==UserScript==
// @name         Dragoncall Coin Auto Pull + Loot Tracker
// @namespace    dragoncall-local
// @version      1.0.0
// @description  100er Coin-Pulls, Rest-Pulls und dauerhaft gespeicherte Loot-Übersicht. Niemals Gem-Pulls.
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const page = new URL(location.href);
  if (page.pathname !== '/event_page.php' || page.searchParams.get('event') !== '13' || page.searchParams.get('map') !== '24') return;
  if (window.__dragoncallAutoPull) return;
  window.__dragoncallAutoPull = true;

  const COST = 100, MAX_PULLS = 100, TIMEOUT = 30000;
  let user = 'unknown';
  try { user = String(JSON.parse(document.querySelector('#ecConfig')?.textContent || '{}').userId || 'unknown'); } catch {}
  const KEY = `dragoncall-loot-v1:${location.host}:${user}`;
  const blank = () => ({ items: {}, pulls: 0, batches: 0, spent: 0, started: null });
  let stats;
  try { stats = { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || 'null') }; } catch { stats = blank(); }
  if (!stats.items || typeof stats.items !== 'object') stats.items = {};
  let running = false, stop = false, message = 'Bereit. Dragoncall Summoning öffnen und starten.';
  const save = () => localStorage.setItem(KEY, JSON.stringify(stats));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => Number(n || 0).toLocaleString('de-DE');
  const panelBody = () => document.querySelector('#ecDialogBody');
  const coinForm = () => [...document.querySelectorAll('#ecDialogBody form')].find(f =>
    [...f.querySelectorAll('button[type="submit"]')].some(b => b.textContent.trim() === 'Pull with Dragoncall Coin')
  );
  function balance() {
    const text = [...document.querySelectorAll('#ecDialogBody .ec-panel-note')].map(n => n.textContent).join(' ');
    const match = text.match(/([\d.,\s]+)\s+Dragoncall Coin\b/i);
    return match ? Number(match[1].replace(/\D/g, '')) : NaN;
  }
  function itemImages() {
    const result = {};
    for (const card of document.querySelectorAll('#ecDialogBody .ec-card')) {
      const name = card.querySelector('h3')?.textContent.trim();
      const src = card.querySelector('img')?.src;
      if (name && src) result[name] = src;
    }
    return result;
  }
  function parseReceipt(text) {
    const found = text.match(/\bReceived:\s*([^\n\r]+)/i);
    if (!found) return null;
    const items = {};
    // Format im HTML: Received: 22 x Item, 15 x Another Item.
    for (const part of found[1].replace(/\s*\.\s*$/, '').split(/,\s*/)) {
      const m = part.trim().match(/^(\d+)\s*[x×]\s*(.+)$/i);
      if (!m) return null;
      const name = m[2].trim();
      items[name] = (items[name] || 0) + Number(m[1]);
    }
    return Object.keys(items).length ? items : null;
  }
  function setMessage(text) { message = text; render(); }

  const style = document.createElement('style');
  style.textContent = `
    #dc-auto{position:fixed;z-index:2147483645;left:12px;bottom:12px;width:min(360px,calc(100vw - 24px));max-height:80vh;display:flex;flex-direction:column;background:#181b2a;color:#f4f4ff;border:1px solid #5a6187;border-radius:14px;box-shadow:0 12px 45px #000b;font:13px/1.4 system-ui,Arial,sans-serif;overflow:hidden}
    #dc-auto *{box-sizing:border-box}#dc-auto header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:#292e49}
    #dc-auto strong{font-size:15px}#dc-auto .dc-main{padding:12px;overflow:auto}#dc-auto .dc-actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
    #dc-auto button{background:#424d80;color:#fff;border:1px solid #7883af;border-radius:8px;padding:8px 10px;cursor:pointer;font-weight:700}
    #dc-auto button:disabled{opacity:.4;cursor:default}#dc-auto button.dc-danger{background:#833e48}#dc-auto button.dc-muted{background:#35384b}
    #dc-auto .dc-status{color:#cbd1ff;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0}
    #dc-auto .dc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:10px}
    #dc-auto .dc-item{background:#252a40;border:1px solid #414869;border-radius:9px;padding:8px 4px;text-align:center;min-width:0}
    #dc-auto .dc-item img{width:54px;height:54px;object-fit:contain;display:block;margin:auto auto 5px}
    #dc-auto .dc-item b{display:block;font-size:16px;color:#eecb7b}
    #dc-auto .dc-item span{display:block;font-size:11px;overflow-wrap:anywhere}
    #dc-auto .dc-small{font-size:11px;color:#abb1ca}#dc-auto.dc-collapsed .dc-main{display:none}
  `;
  document.head.appendChild(style);
  const root = document.createElement('section');
  root.id = 'dc-auto';
  root.innerHTML = `<header><strong>🐉 Dragoncall Coin Auto Pull</strong><button id="dc-fold" class="dc-muted" title="Minimieren">−</button></header><div class="dc-main"><div id="dc-summary"></div><div class="dc-actions"><button id="dc-start">▶ Start</button><button id="dc-stop" class="dc-danger" disabled>■ Stop</button><button id="dc-clear" class="dc-muted">Reset</button></div><div id="dc-message" class="dc-status"></div><div id="dc-loot" class="dc-grid"></div><p class="dc-small">Nur Dragoncall Coins · 100 pro Pull · Fortschritt wird lokal gespeichert. Tab während des Laufs geöffnet lassen.</p></div>`;
  document.body.appendChild(root);
  const $ = id => root.querySelector('#' + id);
  $('dc-fold').onclick = () => { root.classList.toggle('dc-collapsed'); $('dc-fold').textContent = root.classList.contains('dc-collapsed') ? '+' : '−'; };
  $('dc-stop').onclick = () => { stop = true; setMessage('Stop angefordert. Der aktuelle Pull wird noch ausgewertet.'); };
  $('dc-clear').onclick = () => {
    if (running || !confirm('Gespeicherte Loot-Statistik wirklich löschen?')) return;
    stats = blank(); save(); setMessage('Statistik zurückgesetzt.');
  };
  function render() {
    $('dc-start').disabled = running;
    $('dc-stop').disabled = !running;
    $('dc-clear').disabled = running;
    const coins = balance();
    $('dc-summary').textContent = `Pulls: ${fmt(stats.pulls)} · Durchgänge: ${fmt(stats.batches)} · Verbraucht: ${fmt(stats.spent)} Coins` + (Number.isFinite(coins) ? ` · Guthaben: ${fmt(coins)}` : '');
    $('dc-message').textContent = message;
    const grid = $('dc-loot');
    grid.replaceChildren();
    const entries = Object.entries(stats.items).sort((a,b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    for (const [name, data] of entries) {
      const box = document.createElement('div'); box.className = 'dc-item';
      if (data.image && /^https?:\/\//.test(data.image)) {
        const img = document.createElement('img'); img.src = data.image; img.alt = name; img.loading = 'lazy'; box.appendChild(img);
      }
      const count = document.createElement('b'); count.textContent = `× ${fmt(data.count)}`;
      const label = document.createElement('span'); label.textContent = name;
      box.append(count, label); grid.appendChild(box);
    }
  }

  // Nicht nur Erfolgstext prüfen: zusätzlich muss der Coin-Kontostand exakt
  // um die Kosten des angeforderten Batches gesunken sein.
  async function doPull(n, oldBalance) {
    const form = coinForm();
    const input = form?.querySelector('input[type="number"][min="1"][max="100"]');
    const button = [...(form?.querySelectorAll('button[type="submit"]') || [])].find(b => b.textContent.trim() === 'Pull with Dragoncall Coin');
    if (!input || !button || button.disabled) throw Error('Coin-Formular nicht verfügbar oder gesperrt.');
    const images = itemImages();
    const beforeReceipt = panelBody()?.querySelector('.ec-action-success');
    let observedFreshReceipt = false;
    let freshText = '';
    let lastReceiptNode = beforeReceipt;
    const observer = new MutationObserver(() => {
      const receipt = panelBody()?.querySelector('.ec-action-success');
      if (receipt && (receipt !== lastReceiptNode || receipt.textContent !== beforeText)) {
        observedFreshReceipt = true; freshText = receipt.textContent || '';
      }
      lastReceiptNode = receipt;
    });
    const beforeText = beforeReceipt?.textContent || '';
    observer.observe(document.querySelector('#ecDialog') || document.body, {childList:true,subtree:true,characterData:true});
    try {
      input.value = String(n);
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      form.requestSubmit(button); // Nur dieses Coin-Formular. Nie das Gem-Formular.
      const deadline = Date.now() + TIMEOUT;
      while (Date.now() < deadline) {
        const current = balance();
        const error = panelBody()?.querySelector('.ec-action-error, .ec-error');
        if (error?.textContent.trim()) throw Error(error.textContent.trim());
        if (Number.isFinite(current) && current < oldBalance - n * COST) throw Error('Coin-Kontostand hat sich unerwartet stark verändert.');
        if (observedFreshReceipt && current === oldBalance - n * COST) {
          const loot = parseReceipt(freshText);
          if (!loot) throw Error('Ergebnis konnte nicht sicher gelesen werden: ' + freshText.slice(0, 180));
          const received = Object.values(loot).reduce((a,b) => a + b, 0);
          if (received !== n) throw Error(`Ergebnis enthält ${received} statt ${n} Items. Stopp, um nichts falsch zu zählen.`);
          return {loot, images};
        }
        await sleep(150);
      }
      throw Error('Zeitüberschreitung oder keine eindeutig bestätigte Antwort. Bitte im Spiel prüfen, bevor du neu startest.');
    } finally { observer.disconnect(); }
  }

  $('dc-start').onclick = async () => {
    if (running) return;
    running = true; stop = false;
    if (!stats.started) stats.started = new Date().toISOString();
    render();
    try {
      if (!coinForm()) throw Error('Öffne zuerst Dragoncall Summoning, damit das Coin-Formular sichtbar ist.');
      while (!stop) {
        const coins = balance();
        if (!Number.isSafeInteger(coins)) throw Error('Dragoncall Coin-Kontostand nicht lesbar.');
        const n = Math.min(MAX_PULLS, Math.floor(coins / COST));
        if (n <= 0) { setMessage(`Fertig! Noch ${fmt(coins)} Coins übrig (zu wenig für einen Pull).`); break; }
        setMessage(`Ziehe ${n}× mit Coins ... (${fmt(coins)} Coins verfügbar)`);
        const {loot, images} = await doPull(n, coins);
        // Erst nach bestätigtem Coin-Abzug und vollständig geparstem Ergebnis speichern.
        for (const [name, count] of Object.entries(loot)) {
          const old = stats.items[name] || {count: 0, image: ''};
          stats.items[name] = {count: old.count + count, image: images[name] || old.image};
        }
        stats.pulls += n; stats.batches++; stats.spent += n * COST;
        save();
        setMessage(`Letzter Pull: ${n}× bestätigt. ${fmt(stats.pulls)} Pulls insgesamt.`);
        if (stop) break;
        await sleep(750); // Weniger aggressive Abfolge und Zeit für UI-Updates.
      }
      if (stop) setMessage('Gestoppt. Alle bestätigten Pulls sind gespeichert.');
    } catch (err) { setMessage('⛔ Automatisch gestoppt: ' + (err?.message || String(err))); }
    finally { running = false; render(); }
  };
  render();
})();
