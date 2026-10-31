import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { initThemes, normalizeTheme, storedTheme, motifPalette, THEME_STORAGE_KEY } from '../public/themes.js';

function fixture({ stored = null, embedded = false, denyStorage = false } = {}) {
  const writes = [], messages = [];
  class Button extends EventTarget {
    constructor(theme) { super(); this.dataset = { themeChoice: theme }; this.attributes = new Map(); }
    setAttribute(key, value) { this.attributes.set(key, value); }
  }
  const buttons = ['dark', 'light', 'matrix'].map(theme => new Button(theme));
  const root = { dataset: {}, style: { setProperty() {} } };
  const meta = { setAttribute(key, value) { this[key] = value; } };
  const frame = new EventTarget();
  frame.contentWindow = { postMessage: (data, origin) => messages.push({ data, origin }) };
  const doc = { documentElement: root, querySelectorAll: () => buttons,
    getElementById: id => id === 'auditFrame' && !embedded ? frame : null,
    querySelector: selector => selector === 'meta[name="theme-color"]' ? meta : null };
  const view = new EventTarget();
  view.location = { origin: 'http://127.0.0.1:8790' };
  view.parent = embedded ? {} : view;
  view.CustomEvent = CustomEvent;
  const storage = { getItem(key) { assert.equal(key, THEME_STORAGE_KEY); if (denyStorage) throw new Error('denied'); return stored; },
    setItem(key, value) { if (denyStorage) throw new Error('denied'); writes.push({ key, value }); stored = value; } };
  const controller = initThemes({ document: doc, window: view, storage });
  return { root, meta, buttons, view, frame, writes, messages, controller };
}

test('theme controls default to dark and save only a whitelisted visual preference', () => {
  assert.equal(normalizeTheme('<script>'), 'dark');
  assert.equal(normalizeTheme({ mode: 'light' }), 'dark');
  const f = fixture();
  assert.equal(f.root.dataset.theme, 'dark');
  assert.equal(f.writes.length, 0);
  f.buttons[1].dispatchEvent(new Event('click'));
  assert.equal(f.root.dataset.theme, 'light');
  assert.deepEqual(f.buttons.map(button => button.attributes.get('aria-pressed')), ['false', 'true', 'false']);
  f.buttons[2].dispatchEvent(new Event('click'));
  assert.equal(f.root.dataset.theme, 'matrix');
  assert.deepEqual(f.writes, [{ key: THEME_STORAGE_KEY, value: 'light' }, { key: THEME_STORAGE_KEY, value: 'matrix' }]);
  assert.equal(f.meta.content, '#010803');
  assert.equal(f.controller.current(), 'matrix');
});

test('stored theme restores on reload while storage denial never disables controls', () => {
  assert.equal(fixture({ stored: 'matrix' }).root.dataset.theme, 'matrix');
  assert.equal(storedTheme({ getItem() { throw new Error('denied'); } }), 'dark');
  const f = fixture({ denyStorage: true });
  f.buttons[1].dispatchEvent(new Event('click'));
  assert.equal(f.root.dataset.theme, 'light');
  assert.equal(f.writes.length, 0);
});

test('auditor receives presentation only from its exact parent and same origin', () => {
  const f = fixture({ embedded: true });
  function receive({ source = f.view.parent, origin = f.view.location.origin, theme = 'matrix' } = {}) {
    const event = new Event('message');
    Object.assign(event, { source, origin, data: { type: 'chainchat-theme', theme } });
    f.view.dispatchEvent(event);
  }
  receive({ source: {} }); receive({ origin: 'https://attacker.example' }); receive({ theme: 'not-a-theme' });
  assert.equal(f.root.dataset.theme, 'dark');
  receive();
  assert.equal(f.root.dataset.theme, 'matrix');
  assert.equal(f.writes.length, 0);
  const parent = fixture();
  parent.controller.apply('light');
  parent.frame.dispatchEvent(new Event('load'));
  assert.deepEqual(parent.messages.at(-1), { data: { type: 'chainchat-theme', theme: 'light' }, origin: 'http://127.0.0.1:8790' });
});

test('physics motifs use a distinct legible palette for each visual mode', () => {
  assert.equal(motifPalette('dark').main, '238, 238, 238');
  assert.equal(motifPalette('light').main, '23, 27, 25');
  assert.equal(motifPalette('matrix').main, '101, 255, 145');
  assert.equal(motifPalette('invalid'), motifPalette('dark'));
});

const publicFile = name => fs.readFile(new URL('../public/' + name, import.meta.url), 'utf8');
test('light and Matrix replace every existing paint token, including audit surfaces, without filters', async () => {
  const [palettes, chat, audit, html] = await Promise.all(['theme-palettes.css', 'styles.css', 'audit/styles.css', 'index.html'].map(publicFile));
  const declared = new Set([...palettes.matchAll(/(--theme-[\w-]+):/g)].map(match => match[1]));
  assert.ok(declared.size > 100);
  for (const css of [chat, audit]) {
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba\(/i, 'Paint values must participate in the selected theme.');
    assert.doesNotMatch(css, /filter\s*:\s*invert/i);
    for (const match of css.matchAll(/var\((--theme-[\w-]+)\)/g)) assert.ok(declared.has(match[1]), match[1]);
  }
  assert.match(palettes, /html\[data-theme="light"\]/);
  assert.match(palettes, /html\[data-theme="matrix"\]/);
  assert.ok(html.includes('*By using this super-intelligence tool you accept responsibility for the actions of your agents.'));
  for (const label of ['Dark mode', 'Light mode', 'Matrix']) assert.ok(html.includes('>' + label + '</button>'));
});

test('all three body palettes retain readable foreground contrast', async () => {
  const css = await publicFile('theme-palettes.css');
  const block = selector => css.slice(css.indexOf(selector)).split('}')[0];
  const paint = (body, key) => {
    const value = body.match(new RegExp(key + ': (#[\\da-f]{6});', 'i'))?.[1];
    assert.ok(value, key); return value;
  };
  function luminance(hex) {
    const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  }
  for (const selector of [':root {', 'html[data-theme="light"] {', 'html[data-theme="matrix"] {']) {
    const body = block(selector), fg = paint(body, '--theme-hex-f2f2f2'), bg = paint(body, '--theme-hex-080808');
    const a = luminance(fg), b = luminance(bg), contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(contrast >= 7, `${selector} foreground contrast ${contrast}`);
  }
});
