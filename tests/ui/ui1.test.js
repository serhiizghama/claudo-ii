// tests/ui/ui1.test.js
//
// UI-1 acceptance tests for src/ui/index.js (UiSystem), src/ui/style.js,
// src/ui/util.js and src/ui/i18n.js. `node:test` + `node:assert/strict`
// only (12-testing.md P6). Correctness only (D-11: a test asserting a time,
// an allocation or a frame goes in `<name>.perf.test.js`, not here — none of
// that is exercised in this file).
//
// This suite runs under plain Node, which has no `document` — see
// `src/ui/util.js`'s header for the Node-safe DOM shim that makes building
// and counting the `#ui` skeleton here possible without a browser. The same
// code path runs for real once `src/main.js` boots in Chromium
// (`tools/capture.mjs --shot ui_clean`) — see this ticket's report for the
// browser-side numbers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { UiSystem } from '../../src/ui/index.js';
import { LAYER_NAMES, STYLE_ID, TOKENS_CSS, injectStyle, removeStyle } from '../../src/ui/style.js';
import { el, setText, setStyle, setClass, place, countNodes, clamp, lerp, damp, easeOutQuad, easeOutBack, Pool, numStr, resolveDocument } from '../../src/ui/util.js';
import { EN, RU, pluralRule, format, missingRuKeys } from '../../src/ui/i18n.js';
import { boot } from '../../src/main.js';

// ---------------------------------------------------------------------------
// Subsystem interface
// ---------------------------------------------------------------------------

test('UiSystem: static id/deps match the subsystem interface', () => {
  assert.equal(UiSystem.id, 'ui');
  assert.ok(Array.isArray(UiSystem.deps));
  // 'items' omitted — not registered yet (see src/ui/index.js's header,
  // the same precedent src/actors/index.js set for 'materials').
  assert.deepEqual(UiSystem.deps, ['player']);
});

test('UiSystem: does not implement fixedUpdate (rule 5 / this ticket\'s brief)', () => {
  const sys = new UiSystem();
  assert.equal(typeof sys.fixedUpdate, 'undefined');
});

// ---------------------------------------------------------------------------
// U0 acceptance criterion — 09 §15's own wording
// ---------------------------------------------------------------------------

test('init(): builds #ui with exactly 9 nodes (root + 8 layers, 09 §13.1)', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.equal(sys.__nodeCount(), 9, 'root + 8 layers must be exactly 9 (09 §13.1\'s hard-cap table)');
  sys.dispose();
});

test('init(): the root element is #ui, class cl2-ui, with exactly 8 child layers named per style.js#LAYER_NAMES', async () => {
  const sys = new UiSystem();
  await sys.init({});
  const root = sys._root;
  assert.equal(root.id, 'ui');
  assert.ok(root.classList.contains('cl2-ui'));
  assert.equal(root.children.length, LAYER_NAMES.length);
  const seen = root.children.map((c) => c.getAttribute('data-cl2-layer'));
  assert.deepEqual(seen, LAYER_NAMES);
  for (const layer of root.children) {
    assert.equal(layer.children.length, 0, 'no layer may have any content yet — 09 §15 U0: nothing draws yet');
  }
  sys.dispose();
});

test("t('hud.life') returns 'Life', then 'Жизнь' after setLanguage('ru') — this ticket's exact acceptance wording", async () => {
  const sys = new UiSystem();
  await sys.init({});

  const en = sys.t('hud.life');
  assert.equal(en, 'Life');

  sys.setLanguage('ru');
  const ru = sys.t('hud.life');
  assert.equal(ru, 'Жизнь');

  // eslint-disable-next-line no-console
  console.log(`[ui1.test] node count=${sys.__nodeCount()}  t('hud.life') en="${en}" ru="${ru}"`);

  sys.dispose();
});

test('setLanguage: an unrecognised value resolves to en, never throws', async () => {
  const sys = new UiSystem();
  await sys.init({});
  sys.setLanguage('fr');
  assert.equal(sys.t('hud.life'), 'Life');
  sys.dispose();
});

test('t(): a missing key falls back to EN, then to a [missing] prefix — never throws', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.equal(sys.t('nosuch.key'), '[missing]nosuch.key');
  sys.dispose();
});

test('t(): substitutes {param} placeholders', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.equal(sys.t('hud.cooldown', { v: 6 }), '6 s');
  sys.setLanguage('ru');
  assert.equal(sys.t('hud.cooldown', { v: 6 }), '6 с');
  sys.dispose();
});

test('setScreen(): records state without adding/removing any DOM node (09 §15 U0: nothing draws)', async () => {
  const sys = new UiSystem();
  await sys.init({});
  const before = sys.__nodeCount();
  sys.setScreen('main_menu');
  assert.equal(sys._screen, 'main_menu');
  assert.equal(sys.__nodeCount(), before);
  sys.setScreen('not_a_real_screen');
  assert.equal(sys._screen, 'main_menu', 'an invalid screenId must be ignored, not throw');
  sys.dispose();
});

test('dispose(): removes every node this subsystem created', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.equal(sys.__nodeCount(), 9);
  sys.dispose();
  assert.equal(sys.__nodeCount(), 0);
});

// ---------------------------------------------------------------------------
// Boot integration — main.js registers `ui` (O-12's two-line addition)
// ---------------------------------------------------------------------------

function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    addEventListener() {},
    removeEventListener() {},
  };
}

test('boot(): registers ui; ctx.get(\'ui\') exposes a working UiSystem with node count 9', async () => {
  const { ctx, bootLog } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  assert.ok(ui instanceof UiSystem);
  assert.equal(ui.__nodeCount(), 9);
  assert.equal(ui.t('hud.life'), 'Life');

  // B7 (boot veil) and B12 (menu) now resolve 'done', not 'skipped', now
  // that `ui` is a real registered subsystem — see this ticket's report:
  // tests/core/boot.test.js's own 'ui/fx/save are absent' test (owned by
  // CORE-9, outside this ticket's file list) hardcodes the opposite
  // assumption and needs updating by whoever owns that file.
  const b7 = bootLog.find((e) => e.id === 'B7');
  const b12 = bootLog.find((e) => e.id === 'B12');
  assert.equal(b7.status, 'done');
  assert.equal(b12.status, 'done');
  assert.equal(b12.screen, 'character_create'); // no save system registered yet -> no slot

  ui.dispose(); // hygiene: don't leak this instance's #ui into later tests' shared Node doc shim
});

// ---------------------------------------------------------------------------
// style.js — the token block and layer structure
// ---------------------------------------------------------------------------

test('style.js: LAYER_NAMES has exactly 8 entries, all unique', () => {
  assert.equal(LAYER_NAMES.length, 8);
  assert.equal(new Set(LAYER_NAMES).size, 8);
});

test('style.js: TOKENS_CSS carries the token block on .cl2-ui, and the layer rule for every layer name', () => {
  assert.ok(TOKENS_CSS.includes('.cl2-ui'));
  for (const token of ['--void', '--ash-800', '--ink-1', '--ember', '--danger-ink', '--gilt', '--life-top', '--ff-serif', '--t-name-size', '--edge', '--bevel', '--e2-fill']) {
    assert.ok(TOKENS_CSS.includes(token), `TOKENS_CSS missing token ${token}`);
  }
  for (const name of LAYER_NAMES) {
    assert.ok(TOKENS_CSS.includes(`data-cl2-layer="${name}"`), `TOKENS_CSS missing layer rule for ${name}`);
  }
});

test('style.js: injectStyle is idempotent and produces exactly one <style id="cl2-ui">', () => {
  const doc = resolveDocument();
  const a = injectStyle(doc);
  const b = injectStyle(doc);
  assert.equal(a, b);
  assert.equal(doc.getElementById(STYLE_ID), a);
  removeStyle(doc);
  assert.equal(doc.getElementById(STYLE_ID), null);
});

// ---------------------------------------------------------------------------
// util.js
// ---------------------------------------------------------------------------

test('util.el/setText/setStyle/setClass: basic behaviour, Node-safe', () => {
  const node = el('div', 'foo');
  assert.equal(node.className, 'foo');
  setText(node, 'hello');
  assert.equal(node.textContent, 'hello');
  setStyle(node, 'opacity', '0.5');
  assert.equal(node.style.opacity, '0.5');
  setClass(node, 'bar', true);
  assert.ok(node.classList.contains('bar'));
  setClass(node, 'bar', false);
  assert.ok(!node.classList.contains('bar'));
});

test('util.place: writes a transform, and skips the write when (x,y) is unchanged', () => {
  const node = el('div');
  place(node, 10, 20);
  assert.equal(node.style.transform, 'translate3d(10px, 20px, 0)');
  node.style.transform = 'tampered';
  place(node, 10, 20); // unchanged -> must not overwrite
  assert.equal(node.style.transform, 'tampered');
  place(node, 11, 20);
  assert.equal(node.style.transform, 'translate3d(11px, 20px, 0)');
});

test('util.countNodes: counts root + every descendant', () => {
  const root = el('div');
  const a = el('div');
  const b = el('div');
  const c = el('div');
  root.appendChild(a);
  root.appendChild(b);
  a.appendChild(c);
  assert.equal(countNodes(root), 4);
});

test('util easing: clamp/lerp/damp/easeOutQuad/easeOutBack', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  // damp: at dt=0, current is unchanged; as dt -> large, result -> target
  assert.equal(damp(0, 10, 9, 0), 0);
  assert.ok(Math.abs(damp(0, 10, 9, 10) - 10) < 1e-3);
  assert.equal(easeOutQuad(0), 0);
  assert.equal(easeOutQuad(1), 1);
  assert.ok(Math.abs(easeOutBack(0)) < 1e-9);
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-9);
});

test('util.Pool: fixed-capacity, free-list acquire/release, no Map anywhere in its own state', () => {
  const pool = new Pool(3, (i) => ({ poolIndex: i, value: 0 }));
  assert.equal(pool.capacity, 3);
  assert.equal(pool.activeCount, 0);

  const a = pool.acquire();
  const b = pool.acquire();
  const c = pool.acquire();
  assert.ok(a && b && c);
  assert.equal(pool.activeCount, 3);
  assert.equal(pool.acquire(), null, 'a 4th acquire on a capacity-3 pool must return null, not grow');

  pool.release(b, b.poolIndex);
  assert.equal(pool.activeCount, 2);
  const reused = pool.acquire();
  assert.equal(reused, b, 'a released slot must be handed back out (free-list reuse)');

  const active = [];
  pool.forEachActive((rec) => active.push(rec.poolIndex));
  assert.equal(active.length, 3);

  // No Map anywhere in the instance's own state (ARCHITECTURE.md rule 6 /
  // this ticket's brief: "Map is banned for pooled state").
  for (const key of Object.keys(pool)) {
    assert.ok(!(pool[key] instanceof Map), `Pool.${key} must not be a Map`);
  }

  // Matches `src/combat/packet.js#PacketPool.dispose()`'s own precedent
  // (`this._freeCount = 0`): dispose() stops the pool from lending out any
  // further slot — it does not reset it to a fresh, fully-free pool.
  pool.dispose();
  assert.equal(pool.acquire(), null, 'a disposed pool must not hand out any further record');
});

test('util.numStr: the number LUT returns cached strings for small integers, falls back beyond it', () => {
  assert.equal(numStr(0), '0');
  assert.equal(numStr(42), '42');
  assert.equal(numStr(255), '255');
  assert.equal(numStr(9999), '9999'); // beyond the LUT, still correct
  assert.equal(numStr(3), numStr(3)); // same cached instance both times
});

// ---------------------------------------------------------------------------
// i18n.js
// ---------------------------------------------------------------------------

test('i18n: RU is a superset of EN for every key this ticket\'s dictionaries carry', () => {
  assert.deepEqual(missingRuKeys(), []);
  assert.ok(Object.keys(EN).length > 100, 'the U0 dictionary subset should be substantial, not a token stub');
  assert.equal(Object.keys(EN).length, Object.keys(RU).length);
});

test('i18n.format: substitutes every {key}, leaves the string alone with no params', () => {
  assert.equal(format('{cur} / {next}', { cur: 1, next: 2 }), '1 / 2');
  assert.equal(format('no params here'), 'no params here');
  assert.equal(format('{a}{a}', { a: 'x' }), 'xx');
});

test('i18n.pluralRule: en is one/other; ru selects one/few/many per CLDR', () => {
  assert.equal(pluralRule('en', 1), 'one');
  assert.equal(pluralRule('en', 2), 'other');
  assert.equal(pluralRule('ru', 1), 'one');
  assert.equal(pluralRule('ru', 21), 'one');
  assert.equal(pluralRule('ru', 2), 'few');
  assert.equal(pluralRule('ru', 22), 'few');
  assert.equal(pluralRule('ru', 5), 'many');
  assert.equal(pluralRule('ru', 11), 'many');
  assert.equal(pluralRule('ru', 0), 'many');
});

test('module import is Node-safe (no window/document access at import time)', () => {
  assert.equal(typeof UiSystem, 'function');
});
