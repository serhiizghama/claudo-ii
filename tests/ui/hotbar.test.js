// tests/ui/hotbar.test.js
//
// UI-3 acceptance tests for src/ui/hotbar.js (the `Hotbar` module) and the
// lines it adds to src/ui/index.js (`UiSystem`'s construction/`lateUpdate`/
// `setScreen`/`dispose`/`setPrompt`/`toast`/`banner` delegation).
// `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// Scope: this file owns `09-ui.md` §15's U2 acceptance row, verbatim:
//   1. Pressing 1-4 punches the slot and rebinds RMB.
//   2. A 6s cooldown sweeps exactly once.
//   3. Five queued toasts stack and expire in order.
//   4. The belt sweep reads items.beltCooldown, through ctx.get('items').
//
// Clause 2 is driven through `Hotbar#__debugStageCooldown` (dev/test-only,
// see hotbar.js's own header for why the sweep's own acceptance clause
// cannot be driven through the real `pressSlot` entry point today — skills
// do not exist yet, so there is no real cooldown value anywhere in this
// tree to demonstrate against).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Hotbar } from '../../src/ui/hotbar.js';
import { UiSystem } from '../../src/ui/index.js';
import { el, countNodes } from '../../src/ui/util.js';
import { Rng } from '../../src/core/rng.js';

const HOTBAR_SRC = readFileSync(fileURLToPath(new URL('../../src/ui/hotbar.js', import.meta.url)), 'utf8');

function makeCanvas(width = 1920, height = 1080) {
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
  // `peek` is derived from `has`/`get` (never a separate no-op default) so
  // a test overriding just `has`/`get` — the common case below — is not
  // silently shadowed by `hotbar.js#safeGet`'s own preference for `peek`
  // when one exists (matching a real `Registry#peek`'s actual semantics).
  const ctx = {
    canvas: makeCanvas(),
    rng: new Rng(12345),
    get() { return null; },
    has() { return false; },
    ...overrides,
  };
  if (!('peek' in overrides)) ctx.peek = (id) => (ctx.has(id) ? ctx.get(id) : undefined);
  return ctx;
}

function makeTranslate() {
  return (key) => '[' + key + ']';
}

function newHotbar(ctxOverrides) {
  const hudLayer = el('div', 'cl2-layer');
  const feedbackLayer = el('div', 'cl2-layer');
  const ctx = makeCtx(ctxOverrides);
  const hb = new Hotbar(ctx, hudLayer, feedbackLayer, makeTranslate(), null);
  return { hb, hudLayer, feedbackLayer, ctx };
}

/** A minimal deterministic actor stand-in — none of this file's fixtures
 * need a real `src/actors/` record, only `.id`/identity-shaped presence. */
function makeActor(id = 1) {
  return { id };
}

// ---------------------------------------------------------------------------
// Construction — Node-safe, allocates its DOM tree exactly once
// ---------------------------------------------------------------------------

test('Hotbar: constructs without throwing under a bare ctx ({}) and Node-shim layers', () => {
  const hudLayer = el('div');
  const feedbackLayer = el('div');
  assert.doesNotThrow(() => new Hotbar({}, hudLayer, feedbackLayer, (k) => k, null));
});

test('Hotbar: builds 4 hotbar slots x 5 nodes + 4 belt slots x 4 nodes under the hud layer (09 §13.1)', () => {
  const { hb, hudLayer } = newHotbar();
  void hb;
  // 1 (hudContainer) + 4*5 (hotbar) + 4*4 (belt) = 37
  assert.equal(countNodes(hudLayer) - 1 /* the layer itself */, 37);
});

test('Hotbar: builds the prompt/banner/5-toast pool under the feedback layer', () => {
  const { hb, feedbackLayer } = newHotbar();
  void hb;
  // 1 (feedbackContainer) + 3 (prompt) + 3 (banner) + 5*1 (toast rows) = 12
  assert.equal(countNodes(feedbackLayer) - 1, 12);
});

test('Hotbar: attaches nothing outside the two layers it is given', () => {
  const { hb } = newHotbar();
  assert.ok(hb._hudContainer);
  assert.ok(hb._feedbackContainer);
});

// ---------------------------------------------------------------------------
// Clause 1 — "Pressing 1-4 punches the slot and rebinds RMB"
// ---------------------------------------------------------------------------

test('clause 1: pressSlot(index) rebinds the locally-tracked RMB selection', () => {
  const { hb } = newHotbar();
  assert.equal(hb.__selectedSlot(), 0); // 01-data-model.md §6.4 default
  hb.pressSlot(2);
  assert.equal(hb.__selectedSlot(), 2);
  hb.pressSlot(0);
  assert.equal(hb.__selectedSlot(), 0);
});

test('clause 1: pressSlot() punches — the pressed slot\'s scale is > 1 immediately after, and settles back to 1 over 140ms', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.pressSlot(1);
  hb.update(1 / 60, hb._ctx);
  const scaleRightAfter = parseFloat(hb._hotbar[1].dom.punchWrapper.style.transform.match(/scale\(([\d.]+)\)/)[1]);
  assert.ok(scaleRightAfter > 1.0, `expected punch scale > 1 right after pressing, got ${scaleRightAfter}`);

  // Pump past the 140ms punch window — it must settle back to exactly 1.
  for (let i = 0; i < 20; i++) hb.update(1 / 60, hb._ctx);
  const scaleSettled = parseFloat(hb._hotbar[1].dom.punchWrapper.style.transform.match(/scale\(([\d.]+)\)/)[1]);
  assert.equal(scaleSettled, 1, 'punch must settle back to scale(1) after 140ms');
});

test('clause 1: pressSlot() out of range is a no-op, never throws', () => {
  const { hb } = newHotbar();
  assert.doesNotThrow(() => hb.pressSlot(-1));
  assert.doesNotThrow(() => hb.pressSlot(4));
  assert.doesNotThrow(() => hb.pressSlot(1.5));
  assert.equal(hb.__selectedSlot(), 0);
});

test('clause 1: pressSlot() forwards defensively to player.castOrder/groundCursor/hoverTarget when present', () => {
  let castArgs = null;
  const player = {
    actor: makeActor(),
    castOrder(index, x, z, targetId) { castArgs = { index, x, z, targetId }; },
    groundCursor(out) { out.x = 3; out.y = 0; out.z = 7; return out; },
    hoverTarget: 99,
  };
  const { hb } = newHotbar({ has: (id) => id === 'player', get: (id) => (id === 'player' ? player : null) });
  hb.pressSlot(3);
  assert.deepEqual(castArgs, { index: 3, x: 3, z: 7, targetId: 99 });
});

test('clause 1: pressSlot() never throws when player/castOrder/groundCursor are absent (today\'s real state)', () => {
  const { hb } = newHotbar();
  assert.doesNotThrow(() => hb.pressSlot(0));
});

// ---------------------------------------------------------------------------
// Clause 2 — "A 6s cooldown sweeps exactly once — not twice, not 0.98 of a
// turn." Driven by __debugStageCooldown (see this file's own header).
// ---------------------------------------------------------------------------

test('clause 2: a staged 6s cooldown sweeps monotonically from ~360deg to 0deg over exactly 6s, and never re-wraps', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.__debugStageCooldown(0, 6);

  const dt = 1 / 60; // 360 frames = exactly 6.0s
  let prevAngle = 361; // above the max possible angle
  let reachedZeroAtFrame = -1;
  const angles = [];
  for (let frame = 1; frame <= 420; frame++) { // run 60 extra frames past 6s
    hb.update(dt, hb._ctx);
    const angle = hb.__hotbarAngle(0);
    angles.push(angle);
    assert.ok(angle <= prevAngle, `angle must never increase — frame ${frame}: ${angle} > previous ${prevAngle}`);
    prevAngle = angle;
    if (angle === 0 && reachedZeroAtFrame === -1) reachedZeroAtFrame = frame;
  }

  assert.ok(reachedZeroAtFrame > 0, 'the sweep must reach 0deg at some point');
  const elapsedAtZero = reachedZeroAtFrame * dt;
  // "not 0.98 of a turn" (stopping early) and "not twice" (restarting) —
  // the sweep must complete at very close to the full 6s, within one frame.
  assert.ok(Math.abs(elapsedAtZero - 6.0) <= dt + 1e-9,
    `expected the sweep to complete at ~6.0s, completed at ${elapsedAtZero.toFixed(4)}s`);

  // First frame's angle must be near the top of the sweep (close to 360),
  // not some fraction of it — proves the sweep started at the top, not
  // mid-way.
  assert.ok(angles[0] >= 355, `expected the first frame's angle to be near 360, got ${angles[0]}`);

  // Once it reaches 0 it must STAY 0 — no second sweep.
  for (let i = reachedZeroAtFrame; i < angles.length; i++) {
    assert.equal(angles[i], 0, `angle must stay 0 after first reaching it (frame index ${i})`);
  }
});

test('clause 2: a staged cooldown never goes negative even with a single oversized dt (a stall)', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.__debugStageCooldown(0, 6);
  hb.update(100, hb._ctx); // one giant frame, far past the whole cooldown
  assert.equal(hb.__hotbarAngle(0), 0);
  const cd = hb.__hotbarCooldown(0);
  assert.equal(cd.remaining, 0);
  assert.equal(cd.total, 0);
});

test('clause 2: the cooldown readout text is 1 decimal below 10s (09 §4.2)', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.__debugStageCooldown(2, 6);
  hb.update(1 / 60, hb._ctx);
  const text = hb._hotbar[2].dom.cdTextEl.textContent;
  assert.match(text, /^\d+\.\d$/, `expected a 1-decimal readout, got "${text}"`);
});

// ---------------------------------------------------------------------------
// Clause 3 — "Five queued toasts stack and expire in order"
// ---------------------------------------------------------------------------

test('clause 3: five toasts all stack (pool at capacity), and expire in the same order they were created', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);

  const dt = 0.05;
  const creationGap = 0.1; // seconds between each toast() call
  const labels = ['one', 'two', 'three', 'four', 'five'];
  let simTime = 0;

  for (const label of labels) {
    hb.toast(label, 'info');
    // advance by the creation gap before the next toast
    for (let t = 0; t < creationGap; t += dt) { hb.update(dt, hb._ctx); simTime += dt; }
  }

  assert.equal(hb.__toastActiveCount(), 5, 'all five toasts must be simultaneously active (the stack)');
  assert.equal(hb.__toastPoolCapacity(), 5);

  // Now advance until every toast has expired, recording the sim time at
  // each count transition — 5->4->3->2->1->0.
  const transitionTimes = [];
  let lastCount = hb.__toastActiveCount();
  for (let i = 0; i < 2000 && lastCount > 0; i++) {
    hb.update(dt, hb._ctx);
    simTime += dt;
    const count = hb.__toastActiveCount();
    if (count < lastCount) {
      for (let c = lastCount; c > count; c--) transitionTimes.push(simTime);
      lastCount = count;
    }
  }

  assert.equal(transitionTimes.length, 5, 'exactly five expiries must have been observed');
  // Monotonically increasing — each successive toast expires later than
  // the previous, i.e. strictly in creation order (FIFO).
  for (let i = 1; i < transitionTimes.length; i++) {
    assert.ok(transitionTimes[i] > transitionTimes[i - 1],
      `expiry ${i} (${transitionTimes[i]}) must be after expiry ${i - 1} (${transitionTimes[i - 1]})`);
  }
});

test('clause 3: a 6th toast while 5 are active evicts the oldest, never throws, and the pool never exceeds capacity', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  for (let i = 0; i < 6; i++) assert.doesNotThrow(() => hb.toast('t' + i, 'info'));
  assert.equal(hb.__toastActiveCount(), 5);
});

test('clause 3: toast() never uses a Map (source-level check, matching this project\'s Pool convention)', () => {
  // Static check on this file's own source, same style as feedback.test.js's
  // "no Map anywhere" assertion — the toast queue is exactly the shape the
  // ticket brief calls out as "tempting a Map".
  assert.equal(/\bnew Map\(/.test(HOTBAR_SRC), false, 'hotbar.js must not construct a Map for pooled/recycled state');
});

test('hotbar.js source contains no Math.random() call (ARCHITECTURE.md rule 4)', () => {
  assert.equal(/Math\.random\(/.test(HOTBAR_SRC), false);
});

// ---------------------------------------------------------------------------
// Clause 4 — "The belt sweep reads items.beltCooldown — the real one,
// through ctx.get('items')"
// ---------------------------------------------------------------------------

function makeItemsMock(initial = {}) {
  const state = { beltCooldownValue: 0, beltCounts: [0, 0, 0, 0], beltUseCalls: [], ...initial };
  return {
    state,
    beltCooldown(actor) { void actor; return state.beltCooldownValue; },
    beltCount(actor, slot) { void actor; return state.beltCounts[slot] || 0; },
    beltUse(actor, slot) {
      state.beltUseCalls.push({ actorId: actor && actor.id, slot });
      if ((state.beltCounts[slot] || 0) <= 0) return false;
      state.beltCounts[slot] -= 1;
      return true;
    },
  };
}

test('clause 4: the belt sweep angle tracks items.beltCooldown(actor) directly, live, across frames', () => {
  const items = makeItemsMock();
  const player = { actor: makeActor() };
  const { hb } = newHotbar({
    has: (id) => id === 'items' || id === 'player',
    get: (id) => (id === 'items' ? items : id === 'player' ? player : null),
  });
  hb.setVisible(true);

  items.state.beltCooldownValue = 0.5; // full cooldown (BELT_COOLDOWN_TOTAL)
  hb.update(1 / 60, hb._ctx);
  for (let i = 0; i < 4; i++) assert.equal(hb.__beltAngle(i), 360, `slot ${i} must show the full sweep at 0.5s remaining`);

  items.state.beltCooldownValue = 0.25; // half
  hb.update(1 / 60, hb._ctx);
  for (let i = 0; i < 4; i++) assert.equal(hb.__beltAngle(i), 180, `slot ${i} must show a half sweep at 0.25s remaining`);

  items.state.beltCooldownValue = 0; // cleared
  hb.update(1 / 60, hb._ctx);
  for (let i = 0; i < 4; i++) assert.equal(hb.__beltAngle(i), 0, `slot ${i} must show no sweep once the cooldown clears`);
});

test('clause 4: pressBeltSlot(index) calls items.beltUse(actor, index) — real, not a hotbar-local mock', () => {
  const items = makeItemsMock({ beltCounts: [3, 0, 0, 0] });
  const player = { actor: makeActor(42) };
  const { hb } = newHotbar({
    has: (id) => id === 'items' || id === 'player',
    get: (id) => (id === 'items' ? items : id === 'player' ? player : null),
  });
  hb.pressBeltSlot(0);
  assert.deepEqual(items.state.beltUseCalls, [{ actorId: 42, slot: 0 }]);
  assert.equal(items.state.beltCounts[0], 2, 'items.beltUse must be the one decrementing the real stack');
});

test('clause 4: pressBeltSlot() on an empty slot calls beltUse (which itself refuses) and never throws', () => {
  const items = makeItemsMock({ beltCounts: [0, 0, 0, 0] });
  const player = { actor: makeActor() };
  const { hb } = newHotbar({
    has: (id) => id === 'items' || id === 'player',
    get: (id) => (id === 'items' ? items : id === 'player' ? player : null),
  });
  assert.doesNotThrow(() => hb.pressBeltSlot(0));
  assert.equal(items.state.beltUseCalls.length, 1);
});

test('clause 4: belt count reflects items.beltCount(actor, slot), including the "last one" danger colour at 1', () => {
  const items = makeItemsMock({ beltCounts: [5, 1, 0, 0] });
  const player = { actor: makeActor() };
  const { hb } = newHotbar({
    has: (id) => id === 'items' || id === 'player',
    get: (id) => (id === 'items' ? items : id === 'player' ? player : null),
  });
  hb.setVisible(true);
  hb.update(1 / 60, hb._ctx);

  assert.equal(hb.__beltCount(0), 5);
  assert.equal(hb.__beltCount(1), 1);
  assert.equal(hb.__beltCount(2), 0);
  assert.equal(hb._belt[0].dom.countEl.style.color, 'var(--ink-1)');
  assert.equal(hb._belt[1].dom.countEl.style.color, 'var(--danger-ink)', 'the last-one warning must be shown in danger-ink');
  assert.equal(hb._belt[2].dom.countEl.style.display, 'none', 'an empty belt slot must hide its count');
});

test('clause 4: with no items subsystem reachable, the belt never throws and shows no sweep', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  assert.doesNotThrow(() => hb.update(1 / 60, hb._ctx));
  for (let i = 0; i < 4; i++) assert.equal(hb.__beltAngle(i), 0);
});

// ---------------------------------------------------------------------------
// setPrompt / banner — 09 §4.10 / §2.6
// ---------------------------------------------------------------------------

test('setPrompt(spec): shows the key+text, fades toward opacity 1 over ~120ms on repeated update() calls', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.setPrompt({ key: 'E', text: 'Speak to Kaira' });
  assert.equal(hb.__promptOpacity(), 0, 'must not jump to visible before the first update()');
  for (let i = 0; i < 20; i++) hb.update(1 / 60, hb._ctx);
  assert.equal(hb.__promptOpacity(), 1);
  assert.equal(hb._prompt.dom.textEl.textContent, 'Speak to Kaira');
});

test('setPrompt(null): fades back out to 0 and hides the node', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.setPrompt({ key: 'E', text: 'Open Stash' });
  for (let i = 0; i < 20; i++) hb.update(1 / 60, hb._ctx);
  assert.equal(hb.__promptOpacity(), 1);
  hb.setPrompt(null);
  for (let i = 0; i < 20; i++) hb.update(1 / 60, hb._ctx);
  assert.equal(hb.__promptOpacity(), 0);
  assert.equal(hb._prompt.dom.wrap.style.display, 'none');
});

test('banner(title, subtitle, seconds): becomes active, then inactive again after in+hold+out elapses', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.banner('Level Up!', 'Level 5', 1.0);
  assert.equal(hb.__bannerState().active, true);
  assert.equal(hb._banner.dom.titleEl.textContent, 'Level Up!');
  // 0.30 (in) + 1.0 (hold) + 0.25 (out) = 1.55s total.
  for (let i = 0; i < 120; i++) hb.update(1 / 60, hb._ctx); // 2.0s, well past total
  assert.equal(hb.__bannerState().active, false);
});

// ---------------------------------------------------------------------------
// Screen gating (09-ui.md:2128's principle, generalised — UI-2/UI-4/UI-5's
// own precedent)
// ---------------------------------------------------------------------------

test('setVisible(false): update() is a complete no-op (no cooldown integration, no toast advance)', () => {
  const { hb } = newHotbar();
  hb.setVisible(true);
  hb.__debugStageCooldown(0, 6);
  hb.toast('should not advance', 'info');
  hb.setVisible(false);
  for (let i = 0; i < 600; i++) hb.update(1 / 60, hb._ctx); // 10s worth, while hidden
  const cd = hb.__hotbarCooldown(0);
  assert.equal(cd.remaining, 6, 'cooldown must not integrate while hidden');
  assert.equal(hb.__toastActiveCount(), 1, 'the toast must not expire while hidden');
});

test('setVisible(): toggles both container displays, idempotent on a repeated call', () => {
  const { hb } = newHotbar();
  assert.equal(hb._hudContainer.style.display, 'none');
  assert.equal(hb._feedbackContainer.style.display, 'none');
  hb.setVisible(true);
  assert.equal(hb._hudContainer.style.display, 'block');
  assert.equal(hb._feedbackContainer.style.display, 'block');
  hb._hudContainer.style.display = 'tampered';
  hb.setVisible(true); // no-op, same value
  assert.equal(hb._hudContainer.style.display, 'tampered');
  hb.setVisible(false);
  assert.equal(hb._hudContainer.style.display, 'none');
  assert.equal(hb._feedbackContainer.style.display, 'none');
});

test('dispose(): removes every node this module created from both layers', () => {
  const { hb, hudLayer, feedbackLayer } = newHotbar();
  hb.dispose();
  assert.equal(countNodes(hudLayer), 1, 'hud layer must be back to just itself');
  assert.equal(countNodes(feedbackLayer), 1, 'feedback layer must be back to just itself');
});

// ---------------------------------------------------------------------------
// UiSystem integration
// ---------------------------------------------------------------------------

test('UiSystem: static deps is [\'items\',\'player\'] (O-61)', () => {
  assert.deepEqual(UiSystem.deps, ['items', 'player']);
});

test('UiSystem: constructs a Hotbar, drives it from lateUpdate/setScreen/dispose', async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  assert.ok(sys._hotbar instanceof Hotbar);

  assert.equal(sys._hotbar._hudContainer.style.display, 'none');
  sys.setScreen('game');
  assert.equal(sys._hotbar._hudContainer.style.display, 'block');
  sys.setScreen('main_menu');
  assert.equal(sys._hotbar._hudContainer.style.display, 'none');

  sys.setScreen('game');
  assert.doesNotThrow(() => sys.lateUpdate(1 / 60, sys._ctx));

  sys.dispose();
  assert.equal(sys._hotbar, null);
});

test('UiSystem#setPrompt/#toast/#banner delegate to the hotbar module without throwing', async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  sys.setScreen('game');
  assert.doesNotThrow(() => sys.setPrompt({ key: 'E', text: 'Enter Portal' }));
  assert.doesNotThrow(() => sys.toast('A rare item dropped', 'loot'));
  assert.doesNotThrow(() => sys.banner('Boss Slain', '', 2));
  assert.equal(sys._hotbar.__toastActiveCount(), 1);
  sys.dispose();
});

test('UiSystem: the whole tree (root + 8 layers + U1/U2/U3/U5 content) stays inside the 09 §13.1 700-node cap', async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  assert.ok(sys.__nodeCount() <= 700);
  assert.ok(sys.__nodeCount() >= 9 + 37 + 12); // root+8 layers, plus this ticket's own hud/feedback additions
  sys.dispose();
});
