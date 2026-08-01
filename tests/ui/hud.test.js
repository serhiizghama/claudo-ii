// tests/ui/hud.test.js
//
// UI-2 acceptance tests for src/ui/hud.js (the `Hud` module) and the two
// lines it adds to src/ui/index.js (`UiSystem#lateUpdate`/`#debugState`
// delegation). `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// Scope: this file owns `09-ui.md` §15's U1 acceptance row —
// `ui.debugState('combat')` showing life 412/540 plus mana/rage/resonance
// across the three staged classes, the ghost band under a scripted drain,
// and the DOM node budget (`09 §13.1`). The screenshot byte-identity half of
// U1's acceptance (two `tools/capture.mjs --shot ui_clean` runs) is not a
// `node:test` concern and is exercised directly in this ticket's report,
// per this suite's own file list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Hud } from '../../src/ui/hud.js';
import { UiSystem } from '../../src/ui/index.js';
import { el, countNodes } from '../../src/ui/util.js';
import { EN } from '../../src/ui/i18n.js';
import { boot } from '../../src/main.js';
import { Rng } from '../../src/core/rng.js';

function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeCtx(overrides = {}) {
  return {
    canvas: makeCanvas(),
    rng: new Rng(12345),
    get() {
      return null;
    },
    has() {
      return false;
    },
    ...overrides,
  };
}

function makeTranslate() {
  return (key, params) => {
    let str = EN[key];
    if (str === undefined) return '[missing]' + key;
    if (!params) return str;
    for (const k in params) str = str.split('{' + k + '}').join(String(params[k]));
    return str;
  };
}

function newHud(ctxOverrides) {
  const layer = el('div', 'cl2-layer');
  const hud = new Hud(makeCtx(ctxOverrides), layer, makeTranslate());
  return { hud, layer };
}

// ---------------------------------------------------------------------------
// Construction — Node-safe, allocates its DOM tree exactly once
// ---------------------------------------------------------------------------

test('Hud: constructs without throwing under a bare ctx ({}) and a Node-shim layer', () => {
  const layer = el('div');
  assert.doesNotThrow(() => new Hud({}, layer, (k) => k));
});

test('Hud: attaches every node it builds into the given layer, nothing left outside it', () => {
  const { hud, layer } = newHud();
  void hud;
  assert.ok(countNodes(layer) > 1, 'the layer must have gained descendants');
});

test('Hud: dispose() removes every node it created from the layer', () => {
  const { hud, layer } = newHud();
  const before = countNodes(layer);
  assert.ok(before > 1);
  hud.dispose();
  assert.equal(countNodes(layer), 1, 'only the layer itself remains once disposed');
});

// ---------------------------------------------------------------------------
// 09 §13.1 — DOM node budget: a ceiling, never an equality on today's tree
// (this ticket's own rule 12 — UI-3 adds more nodes to the same `hud` layer
// next).
// ---------------------------------------------------------------------------

test('Hud: node count added to the hud layer stays well inside the 09 §13.1 700-node hard cap', () => {
  const { layer } = newHud();
  const count = countNodes(layer) - 1; // exclude the layer itself
  assert.ok(count > 0, 'U1 must draw something');
  assert.ok(count < 100, `U1's own budget rows (plinth chrome 22 + orbs 8 + pips 8 + xp 4 = 42) predict well under 100; got ${count}`);
});

test('full boot(): ui.__nodeCount() stays under the 700-node cap with the plinth/orbs/XP attached', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  const count = ui.__nodeCount();
  assert.ok(count > 9, 'U1 must draw more than the bare U0 skeleton (9)');
  assert.ok(count < 700, `09 §13.1 hard cap; got ${count}`);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Screen gating — the HUD must draw, and spend work, only on screen ===
// 'game' (09-ui.md:2128's vignette-gating principle, generalised; this is
// the fix for the boot_clean/ui_clean regression the orchestrator found:
// U1's plinth was drawing over character_create/main_menu/death).
// ---------------------------------------------------------------------------

test('Hud: starts hidden (matches UiSystem\'s own screen === null at construction)', () => {
  const { hud, layer } = newHud();
  assert.equal(hud._container.style.display, 'none');
  hud.setVisible(true); // just proving the container exists and is reachable
  assert.equal(hud._container.style.display, 'block');
  void layer;
});

test('Hud: update() is a complete no-op while hidden — no ctx.get, no hudState poll, no orb/xp mutation', () => {
  let hudStateCalls = 0;
  const player = { hudState(out) { hudStateCalls++; return out; } };
  const ctx = makeCtx({ get: () => player, has: () => true });
  const { hud } = newHud();
  const before = hud.__orbDebug('life');

  hud.update(1 / 60, ctx); // still hidden — must do nothing
  assert.equal(hudStateCalls, 0, 'a hidden HUD must not even poll player.hudState (no wasted work)');
  assert.deepEqual(hud.__orbDebug('life'), before, 'no orb state may advance while hidden');

  hud.setVisible(true);
  hud.update(1 / 60, ctx);
  assert.equal(hudStateCalls, 1, 'once visible, update() resumes polling');
});

test('Hud: setVisible(false) hides the container again and update() stops burning work', () => {
  const { hud } = newHud();
  hud.debugState('combat'); // also calls setVisible(true) — see that method's own header
  hud.update(1 / 60, {});
  assert.equal(hud._container.style.display, 'block');

  hud.setVisible(false);
  assert.equal(hud._container.style.display, 'none');
  const before = hud.__orbDebug('life');
  hud.update(1 / 60, {});
  assert.deepEqual(hud.__orbDebug('life'), before, 'a hidden HUD must not integrate dt any further');
});

test('Hud: setVisible() is idempotent — repeating the same value writes nothing twice', () => {
  const { hud } = newHud();
  hud.setVisible(true);
  const el1 = hud._container;
  el1.style.display = 'tampered';
  hud.setVisible(true); // unchanged — must not overwrite
  assert.equal(el1.style.display, 'tampered');
  hud.setVisible(false);
  assert.equal(el1.style.display, 'none');
});

test("UiSystem#setScreen('game') shows the HUD; every other screen keeps it hidden", async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());

  assert.equal(sys._hud._container.style.display, 'none', 'hidden at construction (screen is still null)');

  for (const screen of ['boot', 'main_menu', 'character_create', 'death', 'reward_choice']) {
    sys.setScreen(screen);
    assert.equal(sys._hud._container.style.display, 'none', `screen "${screen}" must not show the HUD`);
  }

  sys.setScreen('game');
  assert.equal(sys._hud._container.style.display, 'block');

  sys.setScreen('main_menu');
  assert.equal(sys._hud._container.style.display, 'none', 'leaving the game screen must hide the HUD again');

  sys.dispose();
});

test("UiSystem#setScreen: an invalid screenId is ignored and does not touch HUD visibility", async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  sys.setScreen('game');
  assert.equal(sys._hud._container.style.display, 'block');
  sys.setScreen('not_a_real_screen');
  assert.equal(sys._hud._container.style.display, 'block', 'an invalid screenId must leave the previous state alone');
  sys.dispose();
});

// ---------------------------------------------------------------------------
// D-A — the only path a persistent value reaches this module, unless staged
// ---------------------------------------------------------------------------

test('Hud: update() polls player.hudState(out) when not staged, never ctx.get elsewhere', () => {
  let hudStateCalls = 0;
  const player = {
    hudState(out) {
      hudStateCalls++;
      out.life = 88;
      out.maxLife = 100;
      return out;
    },
  };
  const ctx = makeCtx({
    get(id) {
      assert.equal(id, 'player', 'the only subsystem Hud may ctx.get() is player (D-A)');
      return player;
    },
    has(id) {
      return id === 'player';
    },
  });
  const layer = el('div');
  const hud = new Hud(ctx, layer, (k) => k);
  hud.setVisible(true); // update() is a no-op while hidden (screen !== 'game') — see the gating tests below
  hud.update(1 / 60, ctx);
  assert.equal(hudStateCalls, 1);
  assert.equal(hud.__hudState().life, 88);
});

test('Hud: once staged via debugState, update() never calls ctx.get again (bypasses polling deliberately)', () => {
  const ctx = makeCtx({
    get() {
      throw new Error('ctx.get must not be called while staged');
    },
    has() {
      return true;
    },
  });
  const layer = el('div');
  const hud = new Hud(ctx, layer, makeTranslate());
  hud.debugState('combat');
  assert.doesNotThrow(() => hud.update(1 / 60, ctx));
  assert.doesNotThrow(() => hud.update(1 / 60, ctx));
});

// ---------------------------------------------------------------------------
// 09 §15 U1 acceptance — ui.debugState('combat') shows life 412/540 plus
// mana/rage/resonance across three staged classes
// ---------------------------------------------------------------------------

test("debugState('combat'): life is 412/540 on every one of the three staged classes", () => {
  const { hud } = newHud();
  for (let i = 0; i < 3; i++) {
    hud.debugState('combat');
    const s = hud.__hudState();
    assert.equal(s.life, 412);
    assert.equal(s.maxLife, 540);
  }
});

test("debugState('combat'): cycles Ravager (rage) -> Runeblade (resonance) -> Emberwright (mana), rendering each dialect", () => {
  const { hud } = newHud();

  hud.debugState('combat');
  hud.update(1 / 60, {});
  let s = hud.__hudState();
  assert.equal(s.classId, 'ravager');
  assert.equal(s.secondaryKind, 'rage');
  assert.ok(s.secondary > 0 && s.maxSecondary > 0, 'the rage dialect must carry a nonzero secondary/maxSecondary pair');

  hud.debugState('combat');
  hud.update(1 / 60, {});
  s = hud.__hudState();
  assert.equal(s.classId, 'runeblade');
  assert.equal(s.secondaryKind, 'resonance');
  assert.ok(s.secondary > 0 && s.maxSecondary > 0, 'the resonance dialect must carry a nonzero secondary/maxSecondary pair (pip count)');
  assert.ok(s.mana > 0 && s.maxMana > 0, 'the resonance dialect still draws its resource orb from mana (09 §4.1.2)');

  hud.debugState('combat');
  hud.update(1 / 60, {});
  s = hud.__hudState();
  assert.equal(s.classId, 'emberwright');
  assert.equal(s.secondaryKind, 'mana');
  assert.equal(s.secondary, 0);
  assert.equal(s.maxSecondary, 0);
  assert.ok(s.mana > 0 && s.maxMana > 0);

  // Cycles back to the start.
  hud.debugState('combat');
  assert.equal(hud.__hudState().classId, 'ravager');
});

test("debugState('combat'): secondaryDecay stays at the HudState contract default 0 on every staged class (O-64 — never faked)", () => {
  const { hud } = newHud();
  for (let i = 0; i < 4; i++) {
    hud.debugState('combat');
    assert.equal(hud.__hudState().secondaryDecay, 0);
  }
});

test("debugState('combat'): the resonance dialect shows visible pips, the rage/mana dialects hide every pip", () => {
  const { hud, layer } = newHud();
  void layer;

  hud.debugState('combat'); // ravager/rage
  hud.update(1 / 60, {});
  let visible = countVisiblePips(hud);
  assert.equal(visible, 0, 'rage dialect: no resonance pips visible');

  hud.debugState('combat'); // runeblade/resonance
  hud.update(1 / 60, {});
  visible = countVisiblePips(hud);
  assert.ok(visible > 0, 'resonance dialect: at least one pip must be visible');
  assert.ok(visible <= 8, '09 §4.1.4: preallocated at maxResonance = 8');

  hud.debugState('combat'); // emberwright/mana
  hud.update(1 / 60, {});
  visible = countVisiblePips(hud);
  assert.equal(visible, 0, 'mana-only dialect: no resonance pips visible');
});

function countVisiblePips(hud) {
  let n = 0;
  for (const pip of hud._pips) if (pip.style.display !== 'none') n++;
  return n;
}

test('an unrecognised debugState() name is ignored, never throws — matches UiSystem#setScreen\'s own contract', () => {
  const { hud } = newHud();
  assert.doesNotThrow(() => hud.debugState('nope'));
  assert.doesNotThrow(() => hud.debugState());
});

// ---------------------------------------------------------------------------
// UiSystem#debugState — the two-line delegation this ticket adds to index.js
// ---------------------------------------------------------------------------

test("UiSystem#debugState('combat'): delegates to the Hud module and is reflected in ui.__nodeCount()", async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  assert.doesNotThrow(() => sys.debugState('combat'));
  const before = sys.__nodeCount();
  sys.lateUpdate(1 / 60, makeCtx());
  assert.equal(sys.__nodeCount(), before, 'lateUpdate must not add/remove nodes, only update existing ones');
  sys.dispose();
});

test("UiSystem#debugState: an unknown mode ('inventory'/'tree'/'vendor'/'clean') is a no-op today — this ticket owns only 'combat'", async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  for (const mode of ['inventory', 'tree', 'vendor', 'clean', 'bogus']) {
    assert.doesNotThrow(() => sys.debugState(mode));
  }
  sys.dispose();
});

// ---------------------------------------------------------------------------
// 09 §15 U1 acceptance — a scripted drain shows the ghost band
// ---------------------------------------------------------------------------

test('ghost band: a scripted life drain holds the ghost above the chasing fill for 550 ms, then drains toward it', () => {
  const { hud } = newHud();
  hud.debugState('combat'); // life 412/540 -> trueFrac 0.7630...
  for (let i = 0; i < 60; i++) hud.update(1 / 60, {}); // 1s to fully settle: shown/ghost converge on 0.763

  const settled = hud.__orbDebug('life');
  assert.ok(Math.abs(settled.shownFrac - settled.trueFrac) < 0.01);
  assert.ok(Math.abs(settled.ghostFrac - settled.trueFrac) < 0.01);

  // Script a sudden drain — a hit that drops life to 100/540.
  hud.__hudState().life = 100;
  hud.update(0.1, {}); // 100 ms — inside the 550 ms hold

  const midDrain = hud.__orbDebug('life');
  assert.ok(midDrain.trueFrac < settled.trueFrac - 0.3, 'the true fraction must have dropped immediately');
  assert.ok(midDrain.shownFrac < settled.shownFrac, 'the shown (chasing) fraction must have started falling');
  assert.ok(
    midDrain.ghostFrac > midDrain.shownFrac + 0.05,
    'the ghost band must lag visibly behind the chasing fill while the 550 ms hold is still active — this is the ghost band the acceptance criterion names',
  );
  assert.ok(midDrain.ghostHold > 0, 'still inside the 550 ms hold window');

  // Advance well past the 550 ms hold, at a fixed 60 Hz step (never dt=0
  // instantaneously — matches the engine's own accumulator).
  let steps = 0;
  while (hud.__orbDebug('life').ghostHold > 0 && steps < 120) {
    hud.update(1 / 60, {});
    steps++;
  }
  assert.ok(steps < 120, 'the hold must expire on its own 550 ms schedule');

  // After the hold, the ghost drains toward the (by-then-settled) shown
  // fraction at 0.60 of maximum per second, per 09 §2.6 / §4.1.
  for (let i = 0; i < 60; i++) hud.update(1 / 60, {}); // 1 more second
  const late = hud.__orbDebug('life');
  assert.ok(
    late.ghostFrac - late.shownFrac < midDrain.ghostFrac - midDrain.shownFrac,
    'the ghost must have caught back up toward the (now-settled) shown value after draining',
  );
});

test('ghost band: with no drain (a steady value), the ghost never separates from the shown fraction', () => {
  const { hud } = newHud();
  hud.debugState('combat');
  for (let i = 0; i < 30; i++) hud.update(1 / 60, {});
  const s = hud.__orbDebug('life');
  assert.ok(Math.abs(s.ghostFrac - s.shownFrac) < 0.005);
});

// ---------------------------------------------------------------------------
// Determinism — no wall clock, dt=0 (paused) never changes state
// ---------------------------------------------------------------------------

test('update(dt=0, ...) is a no-op on every orb\'s animated fractions (a paused frame must not drift)', () => {
  const { hud } = newHud();
  hud.debugState('combat');
  hud.update(1 / 60, {});
  const before = hud.__orbDebug('life');
  hud.update(0, {});
  const after = hud.__orbDebug('life');
  assert.deepEqual(after, before);
});

test('hud.js source contains no Math.random() call (ARCHITECTURE.md rule 4)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/ui/hud.js', import.meta.url)), 'utf8');
  assert.ok(!src.includes('Math.random'), 'hud.js must draw all randomness from ctx.rng.fork(), never Math.random()');
});

test('hud.js source contains no Math.hypot() call (this ticket\'s rule 6)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/ui/hud.js', import.meta.url)), 'utf8');
  assert.ok(!src.includes('Math.hypot'));
});

// ---------------------------------------------------------------------------
// XP bar
// ---------------------------------------------------------------------------

test('XP bar: fill fraction matches (xp - xpFloor) / (xpCeiling - xpFloor), clamped to [0,1]', () => {
  const { hud } = newHud();
  hud.debugState('combat'); // stages xp=1200, xpFloor=1000, xpCeiling=1500 -> 0.4
  hud.update(1 / 60, {});
  assert.ok(Math.abs(hud._xpFrac - 0.4) < 1e-6);
});

test('XP bar: a jump in xp opens a chase segment that collapses back into the fill over time', () => {
  const { hud } = newHud();
  hud.debugState('combat');
  hud.update(1 / 60, {});
  hud.__hudState().xp = 1400; // jump from 0.4 -> 0.8
  hud.update(1 / 60, {});
  const justAfter = Math.abs(hud._xpFrac - hud._xpChaseFrom);
  assert.ok(justAfter > 0.05, 'the chase segment must open right after a jump');
  for (let i = 0; i < 60; i++) hud.update(1 / 60, {});
  const later = Math.abs(hud._xpFrac - hud._xpChaseFrom);
  assert.ok(later < justAfter, 'the chase segment must collapse back into the fill (damp rate 6)');
});

// ---------------------------------------------------------------------------
// Rage decay arrow — machinery present, dormant (O-64: secondaryDecay is
// always 0 today; this only proves the gated code path never throws and
// never fabricates a value).
// ---------------------------------------------------------------------------

test('rage dialect: secondaryDecay stays 0 through a full update cycle — the decay arrow has nothing to draw yet (O-64)', () => {
  const { hud } = newHud();
  hud.debugState('combat'); // ravager/rage
  for (let i = 0; i < 10; i++) hud.update(1 / 60, {});
  assert.equal(hud.__hudState().secondaryDecay, 0);
});
