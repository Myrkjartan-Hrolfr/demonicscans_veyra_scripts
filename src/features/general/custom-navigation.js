'use strict';

// From veyra-hud ui-improvements ("Custom Navigation"): extra side menu
// links. Changes against the original:
//  - links that already exist (same label or same target) are skipped
//  - a missing anchor item (e.g. "Emberfall Event" after the event ended)
//    falls back to the next anchor instead of throwing
//  - no "Veyra-Hud Settings" link and no event link rewrite

const { textOf } = require('./dom');

const BASE_URL = 'https://demonicscans.org/';

// `after` lists anchor labels in order of preference.
const NAV_LINKS = Object.freeze([
  { label: 'Olympus', href: '/active_wave.php?gate=5&wave=9', icon: '🏛️', after: ['Home'] },
  { label: 'Wave 3', href: '/active_wave.php?gate=3&wave=8', icon: '🌊', after: ['Olympus', 'Home'] },
  {
    label: 'Arcane Wild Fringe',
    href: '/active_wave.php?event=8&wave=101',
    icon: '🌊',
    after: ['Emberfall Event', 'Wave 3', 'Olympus', 'Home'],
  },
  { label: 'Shadow Army', href: '/shadow_army.php', icon: '☠', after: ['Inventory'] },
  { label: 'Guild Dungeons', href: '/guild_dungeon.php', icon: '🕳️', after: ['Guild'] },
  { label: 'Black Merchant', href: '/black_merchant.php', icon: '💀', after: ['Merchant'] },
  { label: 'Legendary Forge', href: '/legendary_forge.php', icon: '🔥', after: ['Blacksmith'] },
  { label: 'Decraft Altar', href: '/legendary_decraft.php', icon: '🛕', after: ['Legendary Forge', 'Blacksmith'] },
  { label: 'Weekly Leaderboard', href: '/weekly.php', icon: '🏆', after: ['Battle Pass'] },
]);

// "/a.php?b=2&a=1" and "https://host/a.php?a=1&b=2" compare equal.
function normalizeNavHref(href, base = BASE_URL) {
  if (!href) return null;
  try {
    const url = new URL(String(href), base);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = new URLSearchParams(params).toString();
    return `${url.pathname.toLowerCase()}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

const normalizeLabel = (label) => String(label ?? '').trim().toLowerCase();

// existing: [{ label, href }] in menu order. Returns the links to insert as
// [{ link, after }] in insertion order; `after` is the label of the item the
// link goes behind (which may be a link inserted earlier in the plan).
function planNavLinks(existing, links = NAV_LINKS) {
  const labels = (existing || []).map((item) => normalizeLabel(item.label));
  const hrefs = new Set((existing || []).map((item) => normalizeNavHref(item.href)).filter(Boolean));
  const plan = [];

  for (const link of links) {
    if (labels.includes(normalizeLabel(link.label)) || hrefs.has(normalizeNavHref(link.href))) continue;
    const anchor = link.after.find((candidate) => labels.includes(normalizeLabel(candidate)));
    if (!anchor) continue;
    labels.splice(labels.indexOf(normalizeLabel(anchor)) + 1, 0, normalizeLabel(link.label));
    hrefs.add(normalizeNavHref(link.href));
    plan.push({ link, after: anchor });
  }
  return plan;
}

function navItems(doc) {
  return [...(doc.querySelectorAll?.('.side-nav-item') || [])];
}

function findNavItem(doc, label) {
  const wanted = normalizeLabel(label);
  return navItems(doc).find((item) => normalizeLabel(textOf(item.querySelector?.('.side-label'))) === wanted) || null;
}

function createNavItem(doc, link, currentHref) {
  const anchor = doc.createElement('a');
  anchor.className = 'side-nav-item';
  anchor.href = link.href;
  anchor.dataset.veyraNav = '1';
  if (normalizeNavHref(link.href) === normalizeNavHref(currentHref)) anchor.classList.add('active');

  const icon = doc.createElement('span');
  icon.className = 'side-icon';
  icon.textContent = link.icon;
  const label = doc.createElement('span');
  label.className = 'side-label';
  label.textContent = link.label;
  anchor.append(icon, label);
  return anchor;
}

module.exports = Object.freeze({
  id: 'custom-navigation',
  group: 'General',
  settings: [
    {
      key: 'ui-improvements:useCustomNavigation',
      label: 'Custom Navigation',
      type: 'checkbox',
      default: true,
      hint: 'Adds Wave 3, Olympus, Black Merchant, Legendary Forge and more to the side menu.',
    },
  ],
  enabledBy: 'ui-improvements:useCustomNavigation',
  NAV_LINKS,
  normalizeNavHref,
  planNavLinks,

  matches() {
    return true;
  },

  run({ doc, url }) {
    const existing = navItems(doc).map((item) => ({
      label: textOf(item.querySelector?.('.side-label')),
      href: item.getAttribute?.('href'),
    }));
    if (existing.length === 0) return;

    for (const { link, after } of planNavLinks(existing)) {
      const anchorItem = findNavItem(doc, after);
      if (!anchorItem) continue;
      anchorItem.insertAdjacentElement('afterend', createNavItem(doc, link, url?.href));
    }
  },
});
