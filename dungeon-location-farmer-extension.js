// ==UserScript==
// @name         Dungeon Location Farmer
// @namespace    http://tampermonkey.net/
// @version      1.0.4
// @description  Auto-farm all alive monsters on the current dungeon location
// @author       [J4F] RacletteCestLavie
// @updateURL    https://git.veyraj4fwiki.xyz/public/auto-damage/raw/branch/master/src/dungeon-location-farmer.js
// @downloadURL  https://git.veyraj4fwiki.xyz/public/auto-damage/raw/branch/master/src/dungeon-location-farmer.js
// @match        https://demonicscans.org/guild_dungeon_location.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=demonicscans.org
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_PREFIX = 'dungeon-location-farmer:';

  const MAX_RATE_RETRIES = 8;
  const MAX_FAIL_RETRIES = 3;

  const STAMINA_WAIT_MS = 30_000;
  const MAX_STAMINA_WAITS = 10;

  const MAX_STAMINA_POT_FAILURES = 3;
  const STAMINA_POTION_RECHECK_MS = 750;

  // Change this value if the game uses a different endpoint.
  const STAMINA_POTION_ENDPOINT = '/user_stamina_potion.php';

  const SKILLS = {
    slash: { id: '0', cost: 1 },
    'power slash': { id: '-1', cost: 10 },
    'heroic slash': { id: '-2', cost: 50 },
    'ultimate slash': { id: '-3', cost: 100 },
    'legendary slash': { id: '-4', cost: 200 },
  };

  // ── Settings ──────────────────────────────────────────────────────────────

  function getSetting(key, defaultValue) {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);

    if (raw === null) {
      return defaultValue;
    }

    if (typeof defaultValue === 'boolean') {
      return raw === 'true';
    }

    if (typeof defaultValue === 'number') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    }

    return raw;
  }

  function setSetting(key, value) {
    localStorage.setItem(STORAGE_PREFIX + key, String(value));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Parses numbers that may be plain ("1,234,567") or abbreviated
  // ("1.2M", "850K", "3B").
  function parseGameNumber(text) {
    if (text == null) {
      return null;
    }

    const match = String(text).match(/([\d.,]+)\s*([kKmMbB])?/);

    if (!match) {
      return null;
    }

    const number = parseFloat(match[1].replace(/,/g, ''));

    if (!Number.isFinite(number)) {
      return null;
    }

    const suffix = (match[2] || '').toLowerCase();

    const multiplier = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1;

    return Math.round(number * multiplier);
  }

  function getUserId() {
    const link = document.querySelector('a[href*="player.php?pid="]');

    if (link) {
      const match = link.href.match(/pid=(\d+)/);

      if (match) {
        return match[1];
      }
    }

    return null;
  }

  // Reads player HP from the dungeon location page.
  function getPlayerHpFromPage() {
    const container = document.querySelector('.playerhp');

    if (!container) {
      return { current: null, max: null };
    }

    const muted = container.querySelector('.muted');

    if (!muted) {
      return { current: null, max: null };
    }

    const match = muted.textContent.match(/([\d,]+)\s*\/\s*([\d,]+)/);

    if (!match) {
      return { current: null, max: null };
    }

    return {
      current: parseInt(match[1].replace(/[^\d]/g, ''), 10),
      max: parseInt(match[2].replace(/[^\d]/g, ''), 10),
    };
  }

  // ── DOM Scanning ──────────────────────────────────────────────────────────

  function getAliveMonsters() {
    const cards = document.querySelectorAll('.mon:not(.dead)');
    const monsters = [];

    for (const card of cards) {
      const link = card.querySelector("a[href*='battle.php']");

      if (!link) {
        continue;
      }

      const href = link.getAttribute('href');
      const params = new URLSearchParams(href.split('?')[1] || '');
      const dgmid = params.get('dgmid');

      if (!dgmid) {
        continue;
      }

      const nameEl =
        card.querySelector('[style*="font-weight:700"]') || card.querySelector('[style*="font-weight: 700"]');

      let name = 'Unknown';

      if (nameEl) {
        name = nameEl.textContent.trim();

        nameEl.querySelectorAll('*').forEach((element) => {
          name = name.replace(element.textContent, '').trim();
        });

        name = name.replace(/\s+/g, ' ').trim() || 'Unknown';
      }

      monsters.push({ dgmid, name });
    }

    return monsters;
  }

  // ── API Calls ─────────────────────────────────────────────────────────────

  async function getStamina() {
    try {
      const response = await fetch('/game_dash.php', {
        credentials: 'same-origin',
      });

      const html = await response.text();
      const documentCopy = new DOMParser().parseFromString(html, 'text/html');
      const staminaElement = documentCopy.querySelector('#stamina_span');

      if (!staminaElement) {
        return null;
      }

      const value = parseInt(staminaElement.textContent.replace(/[^\d]/g, ''), 10);

      return Number.isNaN(value) ? null : value;
    } catch {
      return null;
    }
  }

  async function useStaminaPot() {
    const userId = getUserId();

    if (!userId) {
      return {
        ok: false,
        msg: 'Could not find user ID',
      };
    }

    const params = new URLSearchParams();
    params.set('user_id', userId);

    try {
      const response = await fetch(STAMINA_POTION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: params.toString(),
        credentials: 'same-origin',
      });

      const raw = await response.text();

      let data = null;

      try {
        data = JSON.parse(raw);
      } catch {
        // The endpoint may return plain text instead of JSON.
      }

      const message = data?.message || raw.slice(0, 200);
      const messageLower = String(message).toLowerCase();
      const status = String(data?.status || '').toLowerCase();

      const explicitlyFailed =
        status === 'error' ||
        status === 'failed' ||
        data?.success === false ||
        messageLower.includes('no stamina potion') ||
        messageLower.includes('no potion') ||
        messageLower.includes('not enough') ||
        messageLower.includes('out of potion') ||
        messageLower.includes('failed') ||
        messageLower.includes('error');

      const explicitlySucceeded =
        status === 'success' ||
        data?.success === true ||
        messageLower.includes('stamina restored') ||
        messageLower.includes('stamina potion used') ||
        messageLower.includes('used stamina potion');

      const ok = !explicitlyFailed && (explicitlySucceeded || response.ok);

      return {
        ok,
        msg: message,
        status: response.status,
      };
    } catch (error) {
      return {
        ok: false,
        msg: String(error),
        status: 0,
      };
    }
  }

  // Fetches battle page for a monster and returns both the EXP cap and the
  // player's current damage on the leaderboard in a single fetch.
  async function getMonsterBattleData(dgmid, instanceId) {
    const userId = getUserId();

    try {
      const response = await fetch(`/battle.php?dgmid=${dgmid}&instance_id=${instanceId}`, {
        credentials: 'same-origin',
      });

      const html = await response.text();
      const documentCopy = new DOMParser().parseFromString(html, 'text/html');

      let capDamage = null;

      for (const block of documentCopy.querySelectorAll('.stat-block')) {
        const label = block.querySelector('.label');

        if (!label || label.textContent.trim() !== 'EXP Cap') {
          continue;
        }

        const noteDiv = block.querySelector(':scope > div:not(.label)');

        if (!noteDiv) {
          continue;
        }

        const match = noteDiv.textContent.match(/deal\s*~?([\d.,]+\s*[kKmMbB]?)\s*dmg/i);

        if (match) {
          capDamage = parseGameNumber(match[1]) || null;
          break;
        }
      }

      let currentDamage = 0;

      if (userId) {
        for (const row of documentCopy.querySelectorAll('.lb-list .lb-row')) {
          const link = row.querySelector('.lb-name a');

          if (!link) {
            continue;
          }

          const href = link.getAttribute('href');
          const pid = new URLSearchParams(href.split('?')[1] || '').get('pid');

          if (String(pid) === String(userId)) {
            currentDamage = parseGameNumber(row.querySelector('.lb-dmg')?.textContent) || 0;

            break;
          }
        }
      }

      return {
        capDamage,
        currentDamage,
      };
    } catch {
      return {
        capDamage: null,
        currentDamage: 0,
      };
    }
  }

  async function useHPPot() {
    const userId = getUserId();

    if (!userId) {
      return {
        ok: false,
        msg: 'Could not find user ID',
      };
    }

    const params = new URLSearchParams();
    params.set('user_id', userId);

    try {
      const response = await fetch('/user_heal_potion.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        credentials: 'same-origin',
      });

      const raw = await response.text();

      let data = null;

      if ((response.headers.get('content-type') || '').includes('application/json')) {
        try {
          data = JSON.parse(raw);
        } catch {
          // Ignore invalid JSON.
        }
      }

      const ok = response.ok || (data && data.status === 'success');

      return {
        ok,
        msg: data?.message || raw.slice(0, 200),
      };
    } catch (error) {
      return {
        ok: false,
        msg: String(error),
      };
    }
  }

  async function doJoin(dgmid, instanceId) {
    const userId = getUserId();

    if (!userId) {
      return {
        ok: false,
        msg: 'Could not find user ID',
      };
    }

    const params = new URLSearchParams();
    params.set('instance_id', instanceId);
    params.set('dgmid', dgmid);
    params.set('user_id', userId);

    try {
      const response = await fetch('/dungeon_join_battle.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        credentials: 'same-origin',
      });

      const raw = await response.text();

      let data = null;

      if ((response.headers.get('content-type') || '').includes('application/json')) {
        try {
          data = JSON.parse(raw);
        } catch {
          // Ignore invalid JSON.
        }
      }

      const ok = response.ok || (data && data.status === 'success');

      return {
        ok,
        msg: data?.message || raw.slice(0, 200),
      };
    } catch (error) {
      return {
        ok: false,
        msg: String(error),
      };
    }
  }

  async function doAttack(dgmid, skillId, staminaCost, instanceId) {
    const params = new URLSearchParams();

    params.set('instance_id', instanceId);
    params.set('dgmid', dgmid);
    params.set('skill_id', skillId);
    params.set('stamina_cost', staminaCost);

    let retryAfterMs = null;
    let response;

    try {
      response = await fetch('/damage.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        credentials: 'same-origin',
      });
    } catch (error) {
      return {
        ok: false,
        msg: String(error),
        damage: 0,
        isDead: false,
        retryAfterMs: null,
        status: 0,
        userHpAfter: null,
        damageDealt: null,
      };
    }

    const retryAfter = response.headers.get('Retry-After');

    if (retryAfter) {
      const seconds = parseInt(String(retryAfter).trim(), 10);

      if (Number.isFinite(seconds) && seconds > 0) {
        retryAfterMs = Math.min(seconds * 1000, 120_000);
      }
    }

    const raw = await response.text();

    let data = null;

    try {
      data = JSON.parse(raw);
    } catch {
      // Ignore invalid JSON.
    }

    const ok = response.ok || (data && data.status === 'success');

    let damage = 0;

    if (ok) {
      const message = data?.message || raw;
      const match = String(message).match(/<strong>([\d,]+)<\/strong>/);

      if (match) {
        damage = Number(match[1].replace(/[^\d]/g, ''));
      }
    }

    const messageText = String(data?.message || raw).toLowerCase();

    const isDead =
      data?.monster_dead === true ||
      messageText.includes('is dead') ||
      messageText.includes('defeated') ||
      messageText.includes('monster died') ||
      messageText.includes('already dead') ||
      messageText.includes('you killed') ||
      messageText.includes('has been slain') ||
      messageText.includes('0 hp');

    return {
      ok,
      msg: data?.message || raw.slice(0, 200),
      damage,
      isDead,
      retryAfterMs,
      status: response.status,
      userHpAfter: data?.retaliation?.user_hp_after ?? null,
      damageDealt: data?.totaldmgdealt ?? null,
    };
  }

  async function lootAll(instanceId, locationId) {
    const body = new URLSearchParams();

    body.set('action', 'loot_all');
    body.set('instance_id', String(instanceId));
    body.set('location_id', String(locationId));

    try {
      const response = await fetch('/dungeon_loot.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });

      return await response.json();
    } catch (error) {
      return {
        status: 'error',
        message: String(error),
      };
    }
  }

  // ── Attack Loop ───────────────────────────────────────────────────────────

  async function attackUntilTarget(dgmid, name, instanceId, settings, runState, setStatus, line) {
    let target = null;
    let baseline = 0;

    if (settings.damageMode === 'cap' || settings.damageMode === 'specific') {
      setStatus(`Checking battle data for ${name}...`);

      const { capDamage, currentDamage } = await getMonsterBattleData(dgmid, instanceId);

      baseline = currentDamage || 0;

      if (settings.damageMode === 'cap') {
        target = capDamage;

        if (target === null) {
          setStatus(`No EXP cap for ${name} - killing instead`);
        }
      } else {
        target = settings.specificDamage;
      }

      if (target !== null && baseline >= target) {
        setStatus(`${name} - already at target ` + `(${baseline.toLocaleString()} / ${target.toLocaleString()})`);

        line.update(
          `✓ ${name} - already at target ` + `(${baseline.toLocaleString()} / ${target.toLocaleString()})`,
          '#5fd07a',
        );

        return {
          reason: 'already_done',
          totalDamage: baseline,
        };
      }

      if (target !== null) {
        const remaining = target - baseline;

        setStatus(`${name}: ${baseline.toLocaleString()} already dealt, ` + `${remaining.toLocaleString()} remaining`);

        await sleep(400);
      }
    }

    const { current: initialHp, max: maximumHp } = getPlayerHpFromPage();

    let playerCurrentHp = initialHp;
    let playerMaxHp = maximumHp;

    setStatus(`Joining ${name}...`);

    const joinResult = await doJoin(dgmid, instanceId);

    if (!joinResult.ok) {
      setStatus(`Join failed for ${name}: ${joinResult.msg}`);

      line.update(`✗ ${name} - join failed: ${joinResult.msg}`, '#e06c6c');

      return {
        reason: 'join_failed',
      };
    }

    const skill = SKILLS[settings.skill] || SKILLS.slash;

    let attackCount = 0;
    let totalDamage = 0;
    let staminaWaits = 0;
    let staminaPotFailures = 0;
    let failRetries = 0;

    while (!runState.stopped) {
      const stamina = await getStamina();

      if (stamina !== null && stamina < settings.minStamina) {
        if (settings.useStaminaPots && staminaPotFailures < MAX_STAMINA_POT_FAILURES) {
          setStatus(`Low stamina (${stamina}) - using stamina potion...`);

          const staminaPotResult = await useStaminaPot();

          if (staminaPotResult.ok) {
            await sleep(STAMINA_POTION_RECHECK_MS);

            const staminaAfter = await getStamina();

            if (staminaAfter === null || staminaAfter > stamina) {
              staminaWaits = 0;
              staminaPotFailures = 0;

              if (staminaAfter === null) {
                setStatus(`Stamina potion used - resuming ${name}...`);
              } else {
                setStatus(
                  `Stamina restored ` +
                    `(${stamina.toLocaleString()} -> ` +
                    `${staminaAfter.toLocaleString()}) - ` +
                    `resuming ${name}...`,
                );
              }

              // Check stamina again before attacking.
              // This allows multiple potions if one potion is not enough.
              continue;
            }

            staminaPotFailures++;

            setStatus(
              `Potion reported success, but stamina did not increase ` +
                `(${staminaPotFailures}/${MAX_STAMINA_POT_FAILURES})`,
            );
          } else {
            staminaPotFailures++;

            setStatus(
              `Could not use stamina potion ` +
                `(${staminaPotFailures}/${MAX_STAMINA_POT_FAILURES}): ` +
                `${staminaPotResult.msg}`,
            );
          }
        }

        staminaWaits++;

        if (staminaWaits > MAX_STAMINA_WAITS) {
          setStatus('Out of stamina - stopping');

          line.update(
            `✗ ${name} - out of stamina ` + `(${(baseline + totalDamage).toLocaleString()} dmg dealt)`,
            '#e0b35c',
          );

          runState.stopped = true;

          return {
            reason: 'no_stamina',
          };
        }

        const potionHint = settings.useStaminaPots ? ' (potion unavailable or ineffective)' : '';

        setStatus(`Low stamina (${stamina})${potionHint} - waiting ` + `${STAMINA_WAIT_MS / 1000}s...`);

        await sleep(STAMINA_WAIT_MS);
        continue;
      }

      staminaWaits = 0;
      staminaPotFailures = 0;

      if (settings.useHPPots && playerMaxHp !== null && playerMaxHp > 0) {
        const isPlayerDead = playerCurrentHp !== null && playerCurrentHp <= 0;

        const hpPercentage = playerCurrentHp !== null ? Math.round((playerCurrentHp / playerMaxHp) * 100) : 100;

        if (isPlayerDead || hpPercentage <= settings.minHPPercent) {
          setStatus(`HP low ` + `(${playerCurrentHp ?? '?'}/${playerMaxHp}) - ` + `using potion...`);

          const hpPotResult = await useHPPot();

          if (hpPotResult.ok) {
            playerCurrentHp = playerMaxHp;

            setStatus(`Healed! Resuming ${name}...`);
          } else if (isPlayerDead) {
            const healButton = document.getElementById('healBtn');

            if (healButton && !healButton.disabled) {
              healButton.click();

              setStatus('Dead - clicked revive button. Waiting 3s...');

              await sleep(3_000);
            } else {
              setStatus('Dead and no pot available - stopping');

              line.update(
                `✗ ${name} - player died, no pot ` + `(${(baseline + totalDamage).toLocaleString()} dmg dealt)`,
                '#e06c6c',
              );

              runState.stopped = true;

              return {
                reason: 'player_dead',
              };
            }
          }
        }
      }

      if (runState.stopped) {
        break;
      }

      let result;

      for (let attempt = 0; attempt < MAX_RATE_RETRIES; attempt++) {
        if (runState.stopped) {
          break;
        }

        result = await doAttack(dgmid, skill.id, skill.cost, instanceId);

        if (result.status !== 200) {
          const wait = result.retryAfterMs || Math.min(20_000, 800 * Math.pow(2, attempt));

          setStatus(`Rate limited - waiting ` + `${Math.round(wait / 1000)}s... (${name})`);

          await sleep(wait);
          continue;
        }

        const messageLower = String(result.msg).toLowerCase();

        if (
          messageLower.includes('rate limit') ||
          messageLower.includes('too fast') ||
          messageLower.includes('cooling down')
        ) {
          const wait = Math.min(20_000, 800 * Math.pow(2, attempt));

          setStatus(`Rate limited - waiting ` + `${Math.round(wait / 1000)}s... (${name})`);

          await sleep(wait);
          continue;
        }

        break;
      }

      if (runState.stopped || !result) {
        break;
      }

      if (!result.ok && !result.isDead) {
        failRetries++;

        if (failRetries >= MAX_FAIL_RETRIES) {
          setStatus(`${name}: giving up after ` + `${MAX_FAIL_RETRIES} failed attacks`);

          line.update(`✗ ${name} - gave up after ` + `${MAX_FAIL_RETRIES} failed attacks`, '#e06c6c');

          return {
            reason: 'failed',
          };
        }

        setStatus(`Attack failed ` + `(${failRetries}/${MAX_FAIL_RETRIES}): ` + `${result.msg}`);

        await sleep(1_000);
        continue;
      }

      failRetries = 0;

      if (result.userHpAfter !== null) {
        playerCurrentHp = Number(result.userHpAfter);

        if (playerMaxHp === null && playerCurrentHp > 0) {
          playerMaxHp = playerCurrentHp;
        }
      }

      attackCount++;

      const returnedTotalDamage = Number(result.damageDealt);

      if (Number.isFinite(returnedTotalDamage)) {
        totalDamage = returnedTotalDamage;
      } else {
        totalDamage += Number(result.damage) || 0;
      }

      const targetLabel =
        target !== null
          ? `${totalDamage.toLocaleString()} / ` + `${target.toLocaleString()}`
          : `${totalDamage.toLocaleString()} dmg`;

      setStatus(`${name} - hit #${attackCount} ` + `(+${(result.damage || 0).toLocaleString()}) ` + `[${targetLabel}]`);

      line.update(`⚔️ ${name} - ${targetLabel} ` + `(hit #${attackCount})`);

      if (result.isDead) {
        setStatus(`${name} defeated - ` + `${totalDamage.toLocaleString()} dmg dealt`);

        line.update(`💀 ${name} - defeated ` + `(${totalDamage.toLocaleString()} dmg dealt)`, '#5fd07a');

        return {
          reason: 'dead',
          attackCount,
          totalDamage,
        };
      }

      if (target !== null && totalDamage >= target) {
        setStatus(`${name} - reached target ` + `(${totalDamage.toLocaleString()} / ` + `${target.toLocaleString()})`);

        line.update(
          `🎯 ${name} - reached target ` + `(${totalDamage.toLocaleString()} / ` + `${target.toLocaleString()})`,
          '#5fd07a',
        );

        return {
          reason: 'target_reached',
          attackCount,
          totalDamage,
        };
      }
    }

    return {
      reason: 'stopped',
      totalDamage,
    };
  }

  // ── Main Farm Loop ────────────────────────────────────────────────────────

  async function runFarm(instanceId, locationId, settings, runState, setStatus, newLogLine) {
    const monsters = getAliveMonsters();

    if (monsters.length === 0) {
      setStatus('No alive monsters found on this location');

      return;
    }

    setStatus(`Found ${monsters.length} alive monster(s) - starting...`);

    newLogLine(`▶ Starting - ${monsters.length} alive monster(s)`, '#9aa0b8');

    await sleep(400);

    let killed = 0;
    let processed = 0;

    for (let index = 0; index < monsters.length; index++) {
      if (runState.stopped) {
        break;
      }

      const { dgmid, name } = monsters[index];

      setStatus(`[${index + 1}/${monsters.length}] ${name}...`);

      const line = newLogLine(`[${index + 1}/${monsters.length}] ` + `${name} - starting...`);

      const result = await attackUntilTarget(dgmid, name, instanceId, settings, runState, setStatus, line);

      if (result.reason === 'dead') {
        killed++;
      }

      if (result.reason === 'dead' || result.reason === 'target_reached' || result.reason === 'already_done') {
        processed++;
      }

      if (result.reason === 'no_stamina' || result.reason === 'player_dead') {
        break;
      }
    }

    if (runState.stopped) {
      setStatus(`Stopped - processed ${processed}, killed ${killed}`);

      newLogLine(`■ Stopped - processed ${processed}, killed ${killed}`, '#9aa0b8');

      return;
    }

    if (killed > 0) {
      setStatus('Looting dead monsters...');

      const loot = await lootAll(instanceId, locationId);

      if (loot && loot.status === 'success') {
        const summary = loot.summary || {};

        const message =
          `Done! Killed ${killed}, hit target on ${processed}. ` +
          `EXP: ${(summary.exp || 0).toLocaleString()}, ` +
          `Gold: ${(summary.gold || 0).toLocaleString()}, ` +
          `Items: ${Array.isArray(loot.items) ? loot.items.length : 0}`;

        setStatus(message);

        newLogLine(`✓ ${message}`, '#5fd07a');
      } else {
        setStatus(`Done (loot failed). Killed ${killed}, ` + `processed ${processed}.`);

        newLogLine(`✓ Done (loot failed). Killed ${killed}, ` + `processed ${processed}.`, '#5fd07a');
      }
    } else {
      setStatus(`Done - hit target on ${processed} monster(s) ` + `(none killed)`);

      newLogLine(`✓ Done - hit target on ${processed} monster(s) ` + `(none killed)`, '#5fd07a');
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  function buildUI() {
    const urlParams = new URLSearchParams(window.location.search);

    const instanceId = urlParams.get('instance_id');

    const locationId = urlParams.get('location_id');

    if (!instanceId || !locationId) {
      return;
    }

    let monstersHeader = null;

    for (const header of document.querySelectorAll('.panel .h')) {
      if (header.textContent.includes('Monsters')) {
        monstersHeader = header;
        break;
      }
    }

    if (!monstersHeader) {
      return;
    }

    const triggerRow = document.createElement('div');

    triggerRow.style.cssText = 'margin:8px 0 12px;';

    const triggerButton = document.createElement('button');

    triggerButton.textContent = '⚔️ Farm Location';

    triggerButton.style.cssText = [
      'padding:7px 14px',
      'border-radius:10px',
      'border:1px solid #2f324d',
      'background:#24263a',
      'color:#edeff6',
      'font-size:13px',
      'font-weight:700',
      'cursor:pointer',
    ].join(';');

    triggerRow.appendChild(triggerButton);

    monstersHeader.insertAdjacentElement('afterend', triggerRow);

    const overlay = document.createElement('div');

    overlay.id = 'dlf-overlay';

    overlay.style.cssText = [
      'display:none',
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,.75)',
      'z-index:10000',
      'align-items:center',
      'justify-content:center',
      'padding:16px',
    ].join(';');

    overlay.innerHTML = `
      <div
        id="dlf-modal"
        style="
          background:#1a1b25;
          border:1px solid #2f324d;
          border-radius:16px;
          padding:20px;
          width:min(440px,96vw);
          max-height:90vh;
          overflow:auto;
          box-shadow:0 16px 48px rgba(0,0,0,.8);
          font-family:system-ui,Arial,sans-serif;
          color:#edeff6;
          font-size:13px;
        "
      >
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            margin-bottom:16px;
          "
        >
          <strong style="font-size:16px">
            ⚔️ Farm Location
          </strong>

          <button
            id="dlf-close"
            style="
              background:#24263a;
              border:1px solid #2f324d;
              color:#aaa;
              border-radius:8px;
              padding:4px 10px;
              cursor:pointer;
              font-size:12px;
            "
          >
            ✕ Close
          </button>
        </div>

        <!-- Skill -->
        <div style="margin-bottom:14px">
          <label
            style="
              display:block;
              margin-bottom:5px;
              color:#9aa0b8;
              font-weight:600;
            "
          >
            Skill
          </label>

          <select
            id="dlf-skill"
            style="
              width:100%;
              background:#12131a;
              border:1px solid #2f324d;
              color:#edeff6;
              border-radius:8px;
              padding:8px;
              font-size:13px;
            "
          >
            <option value="slash">
              Slash (1 sta)
            </option>

            <option value="power slash">
              Power Slash (10 sta)
            </option>

            <option value="heroic slash">
              Heroic Slash (50 sta)
            </option>

            <option value="ultimate slash">
              Ultimate Slash (100 sta)
            </option>

            <option value="legendary slash">
              Legendary Slash (200 sta)
            </option>
          </select>
        </div>

        <!-- Damage Mode -->
        <div style="margin-bottom:14px">
          <label
            style="
              display:block;
              margin-bottom:8px;
              color:#9aa0b8;
              font-weight:600;
            "
          >
            Damage Goal
          </label>

          <div
            style="
              display:flex;
              flex-direction:column;
              gap:8px;
            "
          >
            <label
              style="
                display:flex;
                align-items:center;
                gap:8px;
                cursor:pointer;
              "
            >
              <input
                type="radio"
                name="dlf-mode"
                id="dlf-mode-kill"
                value="kill"
                style="accent-color:#3b48ee"
              >

              <span>Kill monster</span>
            </label>

            <label
              style="
                display:flex;
                align-items:center;
                gap:8px;
                cursor:pointer;
              "
            >
              <input
                type="radio"
                name="dlf-mode"
                id="dlf-mode-cap"
                value="cap"
                style="accent-color:#3b48ee"
              >

              <span>
                EXP Cap (auto-detect per monster)
              </span>
            </label>

            <label
              style="
                display:flex;
                align-items:center;
                gap:8px;
                cursor:pointer;
              "
            >
              <input
                type="radio"
                name="dlf-mode"
                id="dlf-mode-specific"
                value="specific"
                style="accent-color:#3b48ee"
              >

              <span>Specific amount</span>
            </label>
          </div>

          <div
            id="dlf-specific-row"
            style="
              margin-top:8px;
              display:none;
            "
          >
            <input
              id="dlf-specific-dmg"
              type="number"
              min="1"
              placeholder="e.g. 1000000"
              style="
                width:100%;
                background:#12131a;
                border:1px solid #2f324d;
                color:#edeff6;
                border-radius:8px;
                padding:8px;
                font-size:13px;
                box-sizing:border-box;
              "
            >
          </div>
        </div>

        <!-- HP Potions -->
        <div
          style="
            margin-bottom:14px;
            padding:12px;
            background:#12131a;
            border:1px solid #2f324d;
            border-radius:10px;
          "
        >
          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              margin-bottom:8px;
            "
          >
            <label
              for="dlf-use-pots"
              style="
                color:#9aa0b8;
                font-weight:600;
                cursor:pointer;
              "
            >
              Use HP Potions
            </label>

            <input
              type="checkbox"
              id="dlf-use-pots"
              style="
                accent-color:#3b48ee;
                width:16px;
                height:16px;
                cursor:pointer;
              "
            >
          </div>

          <div
            id="dlf-hp-row"
            style="display:none"
          >
            <label
              style="
                display:block;
                margin-bottom:4px;
                color:#9aa0b8;
                font-size:12px;
              "
            >
              Heal when HP drops below (%)
            </label>

            <input
              id="dlf-min-hp"
              type="number"
              min="1"
              max="99"
              style="
                width:100%;
                background:#1a1b25;
                border:1px solid #2f324d;
                color:#edeff6;
                border-radius:8px;
                padding:7px;
                font-size:13px;
                box-sizing:border-box;
              "
            >
          </div>
        </div>

        <!-- Stamina Potions -->
        <div
          style="
            margin-bottom:14px;
            padding:12px;
            background:#12131a;
            border:1px solid #2f324d;
            border-radius:10px;
          "
        >
          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
            "
          >
            <label
              for="dlf-use-stamina-pots"
              style="
                color:#9aa0b8;
                font-weight:600;
                cursor:pointer;
              "
            >
              Use Stamina Potions
            </label>

            <input
              type="checkbox"
              id="dlf-use-stamina-pots"
              style="
                accent-color:#3b48ee;
                width:16px;
                height:16px;
                cursor:pointer;
              "
            >
          </div>

          <div
            style="
              margin-top:6px;
              color:#777d91;
              font-size:11px;
              line-height:1.4;
            "
          >
            Uses a stamina potion when stamina drops
            below the minimum configured below.
          </div>
        </div>

        <!-- Min Stamina -->
        <div style="margin-bottom:16px">
          <label
            style="
              display:block;
              margin-bottom:5px;
              color:#9aa0b8;
              font-weight:600;
            "
          >
            Min Stamina
          </label>

          <input
            id="dlf-min-stamina"
            type="number"
            min="0"
            max="5000"
            style="
              width:100%;
              background:#12131a;
              border:1px solid #2f324d;
              color:#edeff6;
              border-radius:8px;
              padding:8px;
              font-size:13px;
              box-sizing:border-box;
            "
          >

          <div
            style="
              margin-top:5px;
              color:#777d91;
              font-size:11px;
              line-height:1.4;
            "
          >
            Below this value, a stamina potion is used
            or the farmer pauses.
          </div>
        </div>

        <!-- Start / Stop -->
        <button
          id="dlf-start"
          style="
            width:100%;
            padding:11px;
            border-radius:10px;
            border:none;
            background:#3b48ee;
            color:#fff;
            font-weight:700;
            font-size:14px;
            cursor:pointer;
            margin-bottom:12px;
          "
        >
          Start
        </button>

        <!-- Status / Log -->
        <div
          style="
            background:#12131a;
            border:1px solid #2f324d;
            border-radius:8px;
            padding:10px;
            font-size:12px;
            color:#b9bbd1;
            line-height:1.5;
            word-break:break-word;
          "
        >
          <div
            id="dlf-live"
            style="
              font-weight:600;
              color:#edeff6;
              padding-bottom:6px;
              margin-bottom:6px;
              border-bottom:1px solid #2f324d;
            "
          >
            Ready
          </div>

          <div
            id="dlf-log"
            style="
              max-height:180px;
              overflow-y:auto;
            "
          ></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeButton = document.getElementById('dlf-close');

    const startButton = document.getElementById('dlf-start');

    const liveElement = document.getElementById('dlf-live');

    const logElement = document.getElementById('dlf-log');

    const skillSelect = document.getElementById('dlf-skill');

    const minStaminaElement = document.getElementById('dlf-min-stamina');

    const specificRow = document.getElementById('dlf-specific-row');

    const specificDamageElement = document.getElementById('dlf-specific-dmg');

    const modeRadios = document.querySelectorAll('input[name="dlf-mode"]');

    const useHpPotsElement = document.getElementById('dlf-use-pots');

    const useStaminaPotsElement = document.getElementById('dlf-use-stamina-pots');

    const hpRow = document.getElementById('dlf-hp-row');

    const minHpElement = document.getElementById('dlf-min-hp');

    // Populate settings from storage.
    skillSelect.value = getSetting('skill', 'slash');

    minStaminaElement.value = getSetting('minStamina', 10);

    specificDamageElement.value = getSetting('specificDamage', '');

    minHpElement.value = getSetting('minHPPercent', 30);

    useHpPotsElement.checked = getSetting('useHPPots', false);

    useStaminaPotsElement.checked = getSetting('useStaminaPots', false);

    const savedMode = getSetting('damageMode', 'kill');

    const savedModeRadio = document.getElementById(`dlf-mode-${savedMode}`);

    if (savedModeRadio) {
      savedModeRadio.checked = true;
    }

    specificRow.style.display = savedMode === 'specific' ? 'block' : 'none';

    hpRow.style.display = useHpPotsElement.checked ? 'block' : 'none';

    // Persist settings.
    skillSelect.addEventListener('change', () => {
      setSetting('skill', skillSelect.value);
    });

    minStaminaElement.addEventListener('change', () => {
      setSetting('minStamina', minStaminaElement.value);
    });

    specificDamageElement.addEventListener('change', () => {
      setSetting('specificDamage', specificDamageElement.value);
    });

    minHpElement.addEventListener('change', () => {
      setSetting('minHPPercent', minHpElement.value);
    });

    useHpPotsElement.addEventListener('change', () => {
      setSetting('useHPPots', useHpPotsElement.checked);

      hpRow.style.display = useHpPotsElement.checked ? 'block' : 'none';
    });

    useStaminaPotsElement.addEventListener('change', () => {
      setSetting('useStaminaPots', useStaminaPotsElement.checked);
    });

    modeRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        setSetting('damageMode', radio.value);

        specificRow.style.display = radio.value === 'specific' ? 'block' : 'none';
      });
    });

    const MAX_LOG_LINES = 500;

    function setStatus(message) {
      liveElement.textContent = message;
    }

    function newLogLine(text, color) {
      const line = document.createElement('div');

      line.textContent = text;
      line.style.padding = '1px 0';

      if (color) {
        line.style.color = color;
      }

      logElement.appendChild(line);

      while (logElement.childElementCount > MAX_LOG_LINES) {
        logElement.removeChild(logElement.firstElementChild);
      }

      logElement.scrollTop = logElement.scrollHeight;

      return {
        update(updatedText, updatedColor) {
          line.textContent = updatedText;

          if (updatedColor) {
            line.style.color = updatedColor;
          }

          logElement.scrollTop = logElement.scrollHeight;
        },
      };
    }

    let runState = {
      stopped: true,
    };

    function isRunning() {
      return !runState.stopped;
    }

    triggerButton.addEventListener('click', () => {
      overlay.style.display = 'flex';
    });

    closeButton.addEventListener('click', () => {
      if (isRunning()) {
        return;
      }

      overlay.style.display = 'none';
    });

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && !isRunning()) {
        overlay.style.display = 'none';
      }
    });

    startButton.addEventListener('click', async () => {
      if (!runState.stopped) {
        runState.stopped = true;

        startButton.textContent = 'Start';
        startButton.style.background = '#3b48ee';

        closeButton.style.opacity = '1';
        closeButton.style.pointerEvents = 'auto';

        setStatus('Stopping...');
        return;
      }

      const damageMode = document.querySelector('input[name="dlf-mode"]:checked')?.value || 'kill';

      const specificDamage = parseInt(specificDamageElement.value.replace(/[^\d]/g, ''), 10) || 0;

      if (damageMode === 'specific' && specificDamage <= 0) {
        setStatus('Enter a valid specific damage amount first.');

        return;
      }

      // Save values again before starting.
      setSetting('skill', skillSelect.value);

      setSetting('minStamina', minStaminaElement.value);

      setSetting('useHPPots', useHpPotsElement.checked);

      setSetting('useStaminaPots', useStaminaPotsElement.checked);

      setSetting('minHPPercent', minHpElement.value);

      setSetting('damageMode', damageMode);

      setSetting('specificDamage', specificDamageElement.value);

      runState = {
        stopped: false,
      };

      startButton.textContent = 'Stop';
      startButton.style.background = '#b03030';

      closeButton.style.opacity = '0.4';
      closeButton.style.pointerEvents = 'none';

      const settings = {
        skill: skillSelect.value || getSetting('skill', 'slash'),

        minStamina: Math.max(0, parseInt(minStaminaElement.value, 10) || 0),

        useHPPots: useHpPotsElement.checked,

        useStaminaPots: useStaminaPotsElement.checked,

        minHPPercent: Math.min(99, Math.max(1, parseInt(minHpElement.value, 10) || 30)),

        damageMode,
        specificDamage,
      };

      try {
        await runFarm(instanceId, locationId, settings, runState, setStatus, newLogLine);
      } catch (error) {
        const message = error?.message || String(error);

        setStatus(`Error: ${message}`);

        newLogLine(`⚠️ Error: ${message}`, '#e06c6c');

        console.error('[DLF]', error);
      }

      runState.stopped = true;

      startButton.textContent = 'Start';
      startButton.style.background = '#3b48ee';

      closeButton.style.opacity = '1';
      closeButton.style.pointerEvents = 'auto';
    });
  }

  buildUI();
})();
