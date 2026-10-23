// ==UserScript==
// @name         Veyra - Continuous Solo PvP
// @namespace    local.veyra.continuous-solo-pvp
// @version      1.1.0
// @description  Runs continuous Solo PvP or yields the full loop to Smart Battle when present.
// @match        https://demonicscans.org/pvp*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = Object.freeze({
    pageScanIntervalMs: 750,
    lobbyPollIntervalMs: 30_000,
    matchmakeRetryMs: 15_000,
    initialBattleStateDelayMs: 1_500,
    autoPlayRetryMs: 3_000,
    returnToLobbyDelayMs: 3_000,
    requestTimeoutMs: 15_000,
  });

  const SELECTORS = Object.freeze({
    soloMatchButton: '.js-matchmake[data-ladder="solo"]',
    section: 'section',
    sectionTitle: '.section-title',
    infoPill: '.info-pill',
    autoPlayButton: '#autoPlayBtn',
    matchStatus: '#matchStatusBadge',
    viewerMode: '#viewerModeBadge',
    rewardsModal: '#rewardsModal',
  });

  const state = {
    lastMatchmakeClickAt: 0,
    lastAutoPlayClickAt: 0,
    lobbyPollTimer: null,
    lobbyPollRunning: false,
    battlePageSeenAt: 0,
    returnScheduled: false,
    statusKey: '',
  };

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function ensureStatusBadge() {
    if (!document.body) {
      return null;
    }

    let badge = document.getElementById('tm-continuous-solo-pvp-status');
    if (badge) {
      return badge;
    }

    badge = document.createElement('div');
    badge.id = 'tm-continuous-solo-pvp-status';
    badge.style.position = 'fixed';
    badge.style.right = '12px';
    badge.style.bottom = '12px';
    badge.style.zIndex = '2147483647';
    badge.style.maxWidth = 'min(360px, calc(100vw - 24px))';
    badge.style.padding = '8px 11px';
    badge.style.border = '1px solid rgba(255, 255, 255, 0.22)';
    badge.style.borderRadius = '9px';
    badge.style.background = 'rgba(12, 17, 28, 0.94)';
    badge.style.boxShadow = '0 5px 18px rgba(0, 0, 0, 0.35)';
    badge.style.color = '#e8f2ff';
    badge.style.font = '600 12px/1.35 system-ui, sans-serif';
    badge.style.pointerEvents = 'none';
    badge.style.userSelect = 'none';
    document.body.appendChild(badge);

    return badge;
  }

  function setStatus(message, level = 'info') {
    const key = `${level}:${message}`;
    if (state.statusKey === key) {
      return;
    }

    state.statusKey = key;

    const badge = ensureStatusBadge();
    if (badge) {
      badge.textContent = `Solo PvP: ${message}`;
      badge.style.borderColor =
        level === 'error'
          ? 'rgba(255, 105, 105, 0.72)'
          : level === 'active'
            ? 'rgba(87, 224, 154, 0.72)'
            : 'rgba(255, 255, 255, 0.22)';
    }

    const logMethod = level === 'error' ? 'warn' : 'info';
    console[logMethod](`[Continuous Solo PvP] ${message}`);
  }

  function findSoloSection(root = document) {
    const matchButton = root.querySelector(SELECTORS.soloMatchButton);
    if (matchButton) {
      return matchButton.closest(SELECTORS.section);
    }

    return Array.from(root.querySelectorAll(SELECTORS.section)).find((section) => {
      const title = section.querySelector(SELECTORS.sectionTitle);
      return normalizeText(title?.textContent).includes('solo ladder');
    }) || null;
  }

  function readSoloTokenCount(root = document) {
    const section = findSoloSection(root);
    if (!section) {
      return null;
    }

    const tokenPill = Array.from(section.querySelectorAll(SELECTORS.infoPill)).find((pill) => {
      const label = pill.querySelector('strong');
      return normalizeText(label?.textContent).startsWith('tokens');
    });

    if (!tokenPill) {
      return null;
    }

    const valueElement = tokenPill.querySelector('span');
    const match = String(valueElement?.textContent || '').match(/\d[\d.,\s]*/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[0].replace(/\D/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function getLobbySnapshot(root = document) {
    const section = findSoloSection(root);
    const button = root.querySelector(SELECTORS.soloMatchButton);
    const tokens = readSoloTokenCount(root);

    return {
      section,
      button,
      tokens,
      canStart: Boolean(button) && Number.isFinite(tokens) && tokens > 0,
    };
  }

  function isLobbyPage() {
    return /\/pvp\.php$/i.test(window.location.pathname) || Boolean(findSoloSection());
  }

  function clearLobbyPollTimer() {
    if (state.lobbyPollTimer !== null) {
      window.clearTimeout(state.lobbyPollTimer);
      state.lobbyPollTimer = null;
    }
  }

  function scheduleLobbyPoll(delay = CONFIG.lobbyPollIntervalMs) {
    if (state.lobbyPollTimer !== null || state.lobbyPollRunning) {
      return;
    }

    state.lobbyPollTimer = window.setTimeout(() => {
      state.lobbyPollTimer = null;
      void pollLobbyForTokens();
    }, delay);
  }

  async function pollLobbyForTokens() {
    if (state.lobbyPollRunning || !isLobbyPage()) {
      return;
    }

    state.lobbyPollRunning = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

    try {
      const response = await window.fetch(window.location.href, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      const nextDocument = new DOMParser().parseFromString(html, 'text/html');
      const snapshot = getLobbySnapshot(nextDocument);

      if (!snapshot.section) {
        throw new Error('Solo ladder was not found in the lobby response.');
      }

      if (snapshot.canStart) {
        setStatus('Token verfügbar - Lobby wird aktualisiert.', 'active');
        window.location.reload();
        return;
      }

      const tokenText = snapshot.tokens === null ? 'keine verfügbaren Tokens' : `${snapshot.tokens} Token(s)`;
      setStatus(`${tokenText} - nächste Prüfung in 30 Sekunden.`);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[Continuous Solo PvP] Lobby-Prüfung fehlgeschlagen:', error);
      }
      setStatus('Lobby-Prüfung fehlgeschlagen - neuer Versuch in 30 Sekunden.', 'error');
    } finally {
      window.clearTimeout(timeout);
      state.lobbyPollRunning = false;
      scheduleLobbyPoll();
    }
  }

  function handleLobbyPage() {
    const snapshot = getLobbySnapshot();

    if (!snapshot.section) {
      setStatus('Solo-Ladder nicht gefunden - prüfe Login oder Seitenstruktur.', 'error');
      scheduleLobbyPoll();
      return;
    }

    if (!snapshot.canStart) {
      const tokenText = snapshot.tokens === null ? 'keine verfügbaren Tokens' : `${snapshot.tokens} Token(s)`;
      setStatus(`${tokenText} - warte auf Nachschub.`);
      scheduleLobbyPoll();
      return;
    }

    clearLobbyPollTimer();

    if (snapshot.button.disabled) {
      setStatus('Matchsuche läuft ...', 'active');
      return;
    }

    const now = Date.now();
    if (now - state.lastMatchmakeClickAt < CONFIG.matchmakeRetryMs) {
      return;
    }

    state.lastMatchmakeClickAt = now;
    const tokenText = snapshot.tokens === null ? 'Token verfügbar' : `${snapshot.tokens} Token(s) verfügbar`;
    setStatus(`${tokenText} - starte Matchsuche.`, 'active');

    window.setTimeout(() => {
      const currentSnapshot = getLobbySnapshot();
      if (currentSnapshot.canStart && currentSnapshot.button && !currentSnapshot.button.disabled) {
        currentSnapshot.button.click();
      }
    }, 250);
  }

  function isAutoPlayActive(button) {
    const buttonText = normalizeText(button?.textContent);
    const viewerMode = normalizeText(document.querySelector(SELECTORS.viewerMode)?.textContent);

    return Boolean(
      button?.classList.contains('active')
      || buttonText.includes('auto play on')
      || viewerMode.includes('auto play enabled'),
    );
  }

  function isBattleEnded() {
    const status = normalizeText(document.querySelector(SELECTORS.matchStatus)?.textContent);
    const rewardsModal = document.querySelector(SELECTORS.rewardsModal);

    return (
      status.includes('victory')
      || status.includes('battle ended')
      || status.includes('match ended')
      || rewardsModal?.classList.contains('show')
    );
  }

  function isSoloBattlePage() {
    const title = normalizeText(document.title);

    return Boolean(
      title.includes('solo pvp match')
      || document.getElementById('fastEnemyBtn')
      || document.querySelector('.formation--solo'),
    );
  }

  function scheduleReturnToLobby() {
    if (state.returnScheduled) {
      return;
    }

    state.returnScheduled = true;
    setStatus('Kampf beendet - zurück zur Lobby ...', 'active');

    window.setTimeout(() => {
      window.location.replace(new URL('/pvp.php', window.location.origin).href);
    }, CONFIG.returnToLobbyDelayMs);
  }

  function handleBattlePage(autoPlayButton) {
    clearLobbyPollTimer();

    if (isBattleEnded()) {
      scheduleReturnToLobby();
      return;
    }

    /*
     * The dedicated smart battle userscript owns manual combat when present.
     * Keep matchmaking/return-to-lobby active, but do not race it by turning
     * Auto Play back on every 750 ms.
     */
    if (document.documentElement.dataset.veyraSmartPvp === '1') {
      state.battlePageSeenAt = 0;
      setStatus('Smart Battle steuert den Kampf.', 'active');
      return;
    }

    if (!autoPlayButton) {
      setStatus('Auto-Play-Schalter nicht gefunden - warte auf die Kampfseite.', 'error');
      return;
    }

    if (isAutoPlayActive(autoPlayButton)) {
      setStatus('Auto Play ist aktiv.', 'active');
      return;
    }

    const now = Date.now();
    if (state.battlePageSeenAt === 0) {
      state.battlePageSeenAt = now;
      setStatus('Warte auf den initialen Kampfstatus.');
      return;
    }

    if (now - state.battlePageSeenAt < CONFIG.initialBattleStateDelayMs) {
      return;
    }

    if (autoPlayButton.disabled) {
      setStatus('Warte, bis Auto Play verfügbar ist.');
      return;
    }

    if (now - state.lastAutoPlayClickAt < CONFIG.autoPlayRetryMs) {
      return;
    }

    state.lastAutoPlayClickAt = now;
    setStatus('Aktiviere Auto Play ...', 'active');
    autoPlayButton.click();
  }

  function scanPage() {
    if (document.documentElement.dataset.veyraSmartPvpLifecycle === '1') {
      clearLobbyPollTimer();
      setStatus('Smart Battle steuert Kampf und Matchfolge.', 'active');
      return;
    }

    if (isSoloBattlePage()) {
      handleBattlePage(document.querySelector(SELECTORS.autoPlayButton));
      return;
    }

    if (isLobbyPage()) {
      handleLobbyPage();
    }
  }

  scanPage();
  window.setInterval(scanPage, CONFIG.pageScanIntervalMs);
})();
