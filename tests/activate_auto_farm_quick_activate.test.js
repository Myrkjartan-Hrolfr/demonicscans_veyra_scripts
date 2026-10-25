'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptSource = fs.readFileSync(
  path.resolve(__dirname, '../activate_auto_battle_target.js'),
  'utf8',
);

class EventStub {
  constructor(type, options = {}) {
    this.type = String(type);
    this.bubbles = options.bubbles === true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.target = null;
    this.currentTarget = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

function dataAttributeToProperty(name) {
  return String(name).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSimpleSelector(element, selector) {
  let remainder = String(selector || '').trim();
  if (!remainder || remainder === '*') return Boolean(remainder);
  if (remainder.includes(':')) return false;

  const tag = remainder.match(/^[a-z][\w-]*/i);
  if (tag) {
    if (element.tagName !== tag[0].toUpperCase()) return false;
    remainder = remainder.slice(tag[0].length);
  }

  const ids = [...remainder.matchAll(/#([\w-]+)/g)].map((match) => match[1]);
  if (ids.some((id) => element.id !== id)) return false;
  remainder = remainder.replace(/#[\w-]+/g, '');

  const classes = [...remainder.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  if (classes.some((className) => !element.classList.contains(className))) return false;
  remainder = remainder.replace(/\.[\w-]+/g, '');

  const attributes = [...remainder.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
  for (const [, name, expected] of attributes) {
    const actual = element.getAttribute(name);
    if (actual === null || (expected !== undefined && actual !== expected)) return false;
  }
  remainder = remainder.replace(/\[[^\]]+\]/g, '');

  return remainder.trim() === '';
}

function matchesSelector(element, selector) {
  return String(selector || '')
    .split(',')
    .some((candidate) => {
      const parts = candidate.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || !matchesSimpleSelector(element, parts.at(-1))) return false;

      let ancestor = element.parentElement;
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        while (ancestor && !matchesSimpleSelector(ancestor, parts[index])) {
          ancestor = ancestor.parentElement;
        }
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }

      return true;
    });
}

class ElementStub {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.disabled = false;
    this.clickCount = 0;
    this.dispatchedEvents = [];
    this.attributes = new Map();
    this._classes = new Set();

    this.classList = {
      add: (...classNames) => {
        for (const className of classNames) this._classes.add(String(className));
      },
      remove: (...classNames) => {
        for (const className of classNames) this._classes.delete(String(className));
      },
      contains: (className) => this._classes.has(String(className)),
    };
  }

  get id() {
    return this.attributes.get('id') || '';
  }

  set id(value) {
    const id = String(value || '');
    if (id) this.attributes.set('id', id);
    else this.attributes.delete('id');
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current === this.ownerDocument?.documentElement) return true;
      current = current.parentElement;
    }
    return false;
  }

  setAttribute(name, value) {
    const stringName = String(name);
    const stringValue = String(value);
    if (stringName === 'id') {
      this.id = stringValue;
      return;
    }
    if (stringName === 'class') {
      this.className = stringValue;
      return;
    }
    if (stringName.startsWith('data-')) {
      this.dataset[dataAttributeToProperty(stringName.slice(5))] = stringValue;
    }
    this.attributes.set(stringName, stringValue);
  }

  getAttribute(name) {
    const stringName = String(name);
    if (stringName === 'id') return this.id || null;
    if (stringName === 'class') return this.className || null;
    if (stringName.startsWith('data-')) {
      const value = this.dataset[dataAttributeToProperty(stringName.slice(5))];
      return value === undefined ? null : String(value);
    }
    return this.attributes.has(stringName) ? this.attributes.get(stringName) : null;
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentElement) child.parentElement.removeChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('child was not found');
    this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const directChild = String(selector).match(/^:scope\s*>\s*(.+)$/);
    if (directChild) {
      return this.children.filter((child) => matchesSelector(child, directChild[1]));
    }

    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    this.dispatchedEvents.push({ type: event.type, bubbles: event.bubbles });
    if (event.bubbles) this.ownerDocument?.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  click() {
    this.clickCount += 1;
    const event = new EventStub('click', { bubbles: true });
    event.target = this;
    this.ownerDocument?.dispatchEvent(event);
    return event;
  }
}

class DocumentStub {
  constructor() {
    this.listeners = new Map();
    this.documentElement = new ElementStub('html', this);
    this.head = new ElementStub('head', this);
    this.body = new ElementStub('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new ElementStub(tagName, this);
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  querySelectorAll(selector) {
    const matches = matchesSelector(this.documentElement, selector) ? [this.documentElement] : [];
    return matches.concat(this.documentElement.querySelectorAll(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return !event.defaultPrevented;
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

function createSchedulers() {
  let nextId = 1;
  const timeouts = [];
  const intervals = [];
  const animationFrames = [];

  const api = {
    setTimeout(callback, delay) {
      const entry = { id: nextId++, callback, delay, cleared: false };
      timeouts.push(entry);
      return entry.id;
    },
    clearTimeout(id) {
      const entry = timeouts.find((candidate) => candidate.id === id);
      if (entry) entry.cleared = true;
    },
    setInterval(callback, delay) {
      const entry = { id: nextId++, callback, delay, cleared: false };
      intervals.push(entry);
      return entry.id;
    },
    clearInterval(id) {
      const entry = intervals.find((candidate) => candidate.id === id);
      if (entry) entry.cleared = true;
    },
    requestAnimationFrame(callback) {
      const entry = { id: nextId++, callback, cleared: false };
      animationFrames.push(entry);
      return entry.id;
    },
    cancelAnimationFrame(id) {
      const entry = animationFrames.find((candidate) => candidate.id === id);
      if (entry) entry.cleared = true;
    },
  };

  return {
    api,
    runTimeouts(delay) {
      for (const entry of timeouts.filter(
        (candidate) => !candidate.cleared && candidate.delay === delay,
      )) {
        entry.cleared = true;
        entry.callback();
      }
    },
    runAnimationFrames() {
      let safety = 20;
      while (animationFrames.some((entry) => !entry.cleared)) {
        assert.ok(safety-- > 0, 'animation-frame queue did not settle');
        const pending = animationFrames.filter((entry) => !entry.cleared);
        for (const entry of pending) {
          entry.cleared = true;
          entry.callback(0);
        }
      }
    },
  };
}

function createGroupRow(document, enabledValue, label = 'Target') {
  const row = document.createElement('div');
  row.className = 'af-group-row';

  const enabled = document.createElement('select');
  enabled.className = 'af-group-input grp-enabled';
  enabled.value = String(enabledValue);

  const names = document.createElement('div');
  names.className = 'af-group-names';
  names.textContent = label;
  names.title = label;

  const actions = document.createElement('div');
  actions.className = 'btn-group-actions';

  const expand = document.createElement('button');
  expand.className = 'btn grp-expand';
  expand.textContent = 'Show Mobs';

  const save = document.createElement('button');
  save.className = 'btn grp-save';
  save.textContent = 'Save';

  const deleteButton = document.createElement('button');
  deleteButton.className = 'btn grp-del-all';
  deleteButton.textContent = 'Delete';

  actions.appendChild(expand);
  actions.appendChild(save);
  actions.appendChild(deleteButton);
  row.appendChild(enabled);
  row.appendChild(names);
  row.appendChild(actions);

  return { actions, deleteButton, enabled, expand, row, save };
}

function createFixture(enabledValues = []) {
  const document = new DocumentStub();
  const targets = document.createElement('div');
  targets.className = 'af-targets';
  document.body.appendChild(targets);

  const rows = enabledValues.map((value, index) => {
    const row = createGroupRow(document, value, `Target ${index + 1}`);
    targets.appendChild(row.row);
    return row;
  });

  return { document, rows, targets };
}

function runUserscript(document) {
  const schedulers = createSchedulers();
  const observers = [];
  const url = new URL('https://demonicscans.org/active_wave.php?gate=1&wave=1');

  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.observations = [];
      observers.push(this);
    }

    observe(target, options) {
      this.observations.push({ target, options: { ...options } });
    }

    disconnect() {}
  }

  const window = {
    ...schedulers.api,
    Event: EventStub,
    addEventListener() {},
    fetch() {
      throw new Error('unexpected fetch');
    },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    location: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      replace() {},
      reload() {},
    },
  };

  vm.runInNewContext(scriptSource, {
    AbortController,
    DOMParser: class DOMParserStub {},
    Event: EventStub,
    MutationObserver: MutationObserverStub,
    URL,
    console: { info() {}, warn() {}, error() {} },
    document,
    requestAnimationFrame: schedulers.api.requestAnimationFrame,
    cancelAnimationFrame: schedulers.api.cancelAnimationFrame,
    window,
  });

  const flushBoot = () => {
    schedulers.runAnimationFrames();
    schedulers.runTimeouts(40);
    schedulers.runAnimationFrames();
  };

  return { flushBoot, observers, schedulers, window };
}

function activateButton(row) {
  return row.actions.querySelector('button.btn.af-exclusive-activate-btn');
}

function autoFarmObserver(observers) {
  return observers.find((observer) =>
    observer.observations.some(
      ({ options }) => options.childList === true && options.subtree === true && options.attributes !== true,
    ),
  );
}

test('boot adds one exclusive Activate button per grouped Auto-Farm row only', () => {
  const fixture = createFixture(['1', '0']);
  const outside = createGroupRow(fixture.document, '1', 'Outside Auto Farm');
  fixture.document.body.appendChild(outside.row);

  const runtime = runUserscript(fixture.document);
  runtime.flushBoot();

  for (const row of fixture.rows) {
    const buttons = row.actions.querySelectorAll('button.btn.af-exclusive-activate-btn');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].textContent, '⚡ Activate');
    assert.equal(buttons[0].type, 'button');

    const deleteIndex = row.actions.children.indexOf(row.deleteButton);
    assert.equal(row.actions.children[deleteIndex - 1], buttons[0]);
  }

  assert.equal(outside.row.querySelector('.af-exclusive-activate-btn'), null);

  const observer = autoFarmObserver(runtime.observers);
  assert.ok(observer, 'expected a dedicated child-list observer for Auto-Farm rows');
  observer.callback([{ type: 'childList', target: fixture.targets }], observer);
  runtime.schedulers.runAnimationFrames();

  for (const row of fixture.rows) {
    assert.equal(row.actions.querySelectorAll('.af-exclusive-activate-btn').length, 1);
  }
});

test('Activate enables its row, disables the others, dispatches events, and saves changed rows plus target', () => {
  const fixture = createFixture(['1', '0', '0']);
  const runtime = runUserscript(fixture.document);
  runtime.flushBoot();

  const event = activateButton(fixture.rows[1]).click();

  assert.deepEqual(
    fixture.rows.map(({ enabled }) => enabled.value),
    ['0', '1', '0'],
  );
  assert.deepEqual(fixture.rows[0].enabled.dispatchedEvents, [
    { type: 'input', bubbles: true },
    { type: 'change', bubbles: true },
  ]);
  assert.deepEqual(fixture.rows[1].enabled.dispatchedEvents, [
    { type: 'input', bubbles: true },
    { type: 'change', bubbles: true },
  ]);
  assert.deepEqual(fixture.rows[2].enabled.dispatchedEvents, []);
  assert.deepEqual(
    fixture.rows.map(({ save }) => save.clickCount),
    [1, 1, 0],
  );
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test('Activate saves the selected row even when that row was already enabled', () => {
  const fixture = createFixture(['1', '1', '0']);
  const runtime = runUserscript(fixture.document);
  runtime.flushBoot();

  activateButton(fixture.rows[0]).click();

  assert.deepEqual(
    fixture.rows.map(({ enabled }) => enabled.value),
    ['1', '0', '0'],
  );
  assert.deepEqual(fixture.rows[0].enabled.dispatchedEvents, []);
  assert.deepEqual(fixture.rows[1].enabled.dispatchedEvents, [
    { type: 'input', bubbles: true },
    { type: 'change', bubbles: true },
  ]);
  assert.deepEqual(
    fixture.rows.map(({ save }) => save.clickCount),
    [1, 1, 0],
  );
});

test('foreign buttons and grouped rows outside .af-targets are never handled', () => {
  const fixture = createFixture(['1', '0']);
  const outside = createGroupRow(fixture.document, '1', 'Outside Auto Farm');
  const lookalike = fixture.document.createElement('button');
  lookalike.className = 'btn af-exclusive-activate-btn';
  lookalike.textContent = '⚡ Activate';
  outside.actions.insertBefore(lookalike, outside.deleteButton);
  fixture.document.body.appendChild(outside.row);

  const runtime = runUserscript(fixture.document);
  runtime.flushBoot();

  const unrelated = fixture.rows[0].expand.click();
  const outsideClick = lookalike.click();

  assert.deepEqual(
    fixture.rows.map(({ enabled }) => enabled.value),
    ['1', '0'],
  );
  assert.deepEqual(
    fixture.rows.map(({ save }) => save.clickCount),
    [0, 0],
  );
  assert.equal(outside.enabled.value, '1');
  assert.equal(outside.save.clickCount, 0);
  assert.equal(unrelated.defaultPrevented, false);
  assert.equal(unrelated.propagationStopped, false);
  assert.equal(outsideClick.defaultPrevented, false);
  assert.equal(outsideClick.propagationStopped, false);
});

test('the dedicated child-list observer decorates dynamically rendered rows idempotently', () => {
  const fixture = createFixture(['1']);
  const runtime = runUserscript(fixture.document);
  runtime.flushBoot();

  const dynamic = createGroupRow(fixture.document, '0', 'Dynamic Target');
  fixture.targets.appendChild(dynamic.row);
  assert.equal(activateButton(dynamic), null);

  const observer = autoFarmObserver(runtime.observers);
  assert.ok(observer, 'expected a dedicated child-list observer for Auto-Farm rows');
  observer.callback(
    [{ type: 'childList', target: fixture.targets, addedNodes: [dynamic.row] }],
    observer,
  );
  runtime.schedulers.runAnimationFrames();

  assert.ok(activateButton(dynamic));
  assert.equal(dynamic.actions.querySelectorAll('.af-exclusive-activate-btn').length, 1);

  observer.callback(
    [{ type: 'childList', target: fixture.targets, addedNodes: [dynamic.row] }],
    observer,
  );
  runtime.schedulers.runAnimationFrames();
  assert.equal(dynamic.actions.querySelectorAll('.af-exclusive-activate-btn').length, 1);
});
