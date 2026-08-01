// tests/ui/feedback.test.js
//
// UI-4 acceptance tests for src/ui/feedback.js (the `Feedback` module) and
// the lines it adds to src/ui/index.js (`UiSystem#lateUpdate`/`#setScreen`/
// `#dispose`/`#damageNumber`/`#floatingText` delegation). `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// Scope: this file owns `09-ui.md` §15's U3 acceptance row — the pool
// ceiling, ≤3-live-per-target, ≤24-drawn-per-frame, the 0.12s coalescing
// window, "200 hits over 2s never exceeds the pool", and the screen-gating
// principle (09-ui.md:2128) generalised to this layer. The allocation half
// of U3's acceptance lives in feedback.perf.test.js (uses
// tests/helpers/alloc.js, per this ticket's brief).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Feedback } from '../../src/ui/feedback.js';
import { UiSystem } from '../../src/ui/index.js';
import { el, countNodes } from '../../src/ui/util.js';
import { Rng } from '../../src/core/rng.js';
import * as THREE from 'three';

const FEEDBACK_SRC = readFileSync(fileURLToPath(new URL('../../src/ui/feedback.js', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal, deterministic on/off/emit bus — no Map, plain arrays, good
 * enough for these unit tests without pulling in core/events.js's own
 * generation-guarded machinery (this file only needs synchronous dispatch). */
function makeEventBus() {
  const handlers = new Map(); // test-only scaffolding, not production code
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    off(event, fn) {
      const list = handlers.get(event);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event, payload) {
      const list = handlers.get(event);
      if (!list) return;
      for (const fn of list.slice()) fn(payload);
    },
  };
}

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

/** A real THREE.PerspectiveCamera looking straight down at the origin from
 * height 20 — points near (0, y, 0) with small x/z offsets project reliably
 * on-screen, near the centre, without depending on the game's real
 * orbit-lock geometry (this file is self-contained; render/camera.js is not
 * imported). */
function buildTestCamera(vw, vh) {
  const camera = new THREE.PerspectiveCamera(60, vw / vh, 1, 100);
  camera.position.set(0, 20, 0.0001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function makeActor(id, x = 0, y = 0, z = 0, life = 100, maxLife = 100) {
  return { id, x, y, z, life, maxLife, stats: { maxLife } };
}

function makeCtx(overrides = {}) {
  const canvas = makeCanvas();
  return {
    canvas,
    camera: buildTestCamera(canvas.width, canvas.height),
    rng: new Rng(12345),
    events: makeEventBus(),
    config: { quality: 'high' },
    get() { return null; },
    has() { return false; },
    peek() { return undefined; },
    ...overrides,
  };
}

function makeTranslate() {
  return (key) => '[' + key + ']';
}

// `damageNumberMode` defaults to `'own'` (`_passesFilter`) and most of this
// file's tests are exercising the pool/coalescing/cap machinery itself, not
// the filter — so `newFeedback` defaults its test fixtures to `'all'`
// (bypassing the filter) unless a test explicitly asks for `'own'`. The two
// tests that DO test the filter pass `'own'` explicitly.
function newFeedback(ctxOverrides, damageNumberMode = 'all') {
  const layer = el('div', 'cl2-layer');
  const ctx = makeCtx(ctxOverrides);
  const fb = new Feedback(ctx, layer, makeTranslate());
  fb._damageNumberMode = damageNumberMode;
  return { fb, layer, ctx };
}

/** A `{target, source, result}` `actor:damage` payload — `result` matches
 * `src/combat/resolve.js#createDamageResult`'s shape closely enough for
 * this file's own logic (outcome/crit/total/targetId/sourceId/per-element
 * split); this test file never imports combat. */
function makeDamageResult(overrides = {}) {
  return {
    targetId: 0, targetGen: 0, sourceId: 0, sourceGen: 0, sourceSkillId: null,
    outcome: 'hit', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 0,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false,
    pointX: 0, pointY: 0, pointZ: 0,
    ...overrides,
  };
}

function emitHit(ctx, target, source, resultOverrides) {
  const result = makeDamageResult({
    targetId: target.id,
    sourceId: source ? source.id : 0,
    physical: resultOverrides && resultOverrides.total !== undefined ? resultOverrides.total : 10,
    total: resultOverrides && resultOverrides.total !== undefined ? resultOverrides.total : 10,
    ...resultOverrides,
  });
  ctx.events.emit('actor:damage', { target, source: source || null, result });
  return result;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('Feedback: constructs without throwing under a bare ctx ({}) and a Node-shim layer', () => {
  const layer = el('div');
  assert.doesNotThrow(() => new Feedback({}, layer, (k) => k));
});

test('Feedback: builds every node once at construction (see __nodeCount), but does not attach to the layer until first shown', () => {
  const { fb, layer } = newFeedback();
  assert.ok(fb.__nodeCount() > 1, 'every node must already exist, unattached');
  assert.equal(countNodes(layer), 1, 'the layer itself must stay empty until setVisible(true) — see feedback.js#setVisible\'s own header');
});

test('Feedback: setVisible(true) attaches the already-built container into the given layer exactly once', () => {
  const { fb, layer } = newFeedback();
  fb.setVisible(true);
  assert.ok(countNodes(layer) > 1);
  const nodeCountAfterFirstShow = fb.__nodeCount();
  fb.setVisible(false);
  fb.setVisible(true);
  assert.equal(fb.__nodeCount(), nodeCountAfterFirstShow, 'a second show must not re-attach or build anything new');
});

test('Feedback: dispose() removes every node it created from the layer, whether or not it was ever shown', () => {
  const { fb, layer } = newFeedback();
  fb.setVisible(true);
  assert.ok(countNodes(layer) > 1);
  fb.dispose();
  assert.equal(countNodes(layer), 1);
});

test('Feedback: dispose() before ever being shown does not throw (never attached)', () => {
  const { fb } = newFeedback();
  assert.doesNotThrow(() => fb.dispose());
});

test('Feedback: node count added to the layer stays well inside the 09 §13.1 700-node hard cap (ceiling, not equality — rule 12/O-27)', () => {
  const { fb } = newFeedback();
  const count = fb.__nodeCount();
  assert.ok(count > 0);
  assert.ok(count < 50, `expected a handful of nodes (container+vignette+desat+flash+canvas), got ${count}`);
});

// ---------------------------------------------------------------------------
// Screen gating — 09-ui.md:2128's principle, generalised (the trap UI-2 paid
// for): hidden must mean zero work, not just zero pixels.
// ---------------------------------------------------------------------------

test('Feedback: starts hidden', () => {
  const { fb } = newFeedback();
  assert.equal(fb._container.style.display, 'none');
});

test('Feedback: update() is a complete no-op while hidden — no player poll, no pool advance', () => {
  let hudStateCalls = 0;
  const player = { hudState(out) { hudStateCalls++; return out; }, actor: null };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.update(1 / 60, ctx);
  assert.equal(hudStateCalls, 0, 'a hidden Feedback module must not poll player.hudState');
});

test('Feedback: setVisible(true) then update() resumes polling and drawing', () => {
  let hudStateCalls = 0;
  const player = { hudState(out) { hudStateCalls++; return out; }, actor: null };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  fb.update(1 / 60, ctx);
  assert.equal(hudStateCalls, 1);
});

test('Feedback: setVisible() is idempotent — repeating the same value writes nothing twice', () => {
  const { fb } = newFeedback();
  fb.setVisible(true);
  fb._container.style.display = 'tampered';
  fb.setVisible(true);
  assert.equal(fb._container.style.display, 'tampered');
  fb.setVisible(false);
  assert.equal(fb._container.style.display, 'none');
});

test("UiSystem#setScreen('game') shows the feedback layer; every other screen keeps it hidden", async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());

  assert.equal(sys._feedback._container.style.display, 'none');
  for (const screen of ['boot', 'main_menu', 'character_create', 'death', 'reward_choice']) {
    sys.setScreen(screen);
    assert.equal(sys._feedback._container.style.display, 'none', `screen "${screen}" must not show the feedback layer`);
  }
  sys.setScreen('game');
  assert.equal(sys._feedback._container.style.display, 'block');
  sys.setScreen('main_menu');
  assert.equal(sys._feedback._container.style.display, 'none');
  sys.dispose();
});

test('UiSystem#damageNumber/#floatingText delegate to the feedback module without throwing', async () => {
  const sys = new UiSystem();
  await sys.init(makeCtx());
  assert.doesNotThrow(() => sys.damageNumber(0, 0, 0, 42, 'hit', 'physical'));
  assert.doesNotThrow(() => sys.floatingText(0, 0, 0, '+120 XP', '#c9a227'));
  assert.ok(sys._feedback.__activeCount() >= 2);
  sys.dispose();
});

// ---------------------------------------------------------------------------
// 09 §10.1 — pool ceiling by quality preset (01-data-model.md §11.1:
// 64 / 96 / 128 / 128 for low/medium/high/ultra)
// ---------------------------------------------------------------------------

test('DamageNumber pool capacity matches the quality-preset sizes 64/96/128/128', () => {
  const sizes = { low: 64, medium: 96, high: 128, ultra: 128 };
  for (const [quality, expected] of Object.entries(sizes)) {
    const { fb } = newFeedback({ config: { quality } });
    assert.equal(fb.__poolCapacity(), expected, `quality "${quality}"`);
  }
});

test('DamageNumber pool capacity defaults to 128 (high) for an unknown/missing quality', () => {
  const { fb } = newFeedback({ config: {} });
  assert.equal(fb.__poolCapacity(), 128);
});

// ---------------------------------------------------------------------------
// 09 §10.1 — coalescing at 0.12 s, integrating dt (never Date.now())
// ---------------------------------------------------------------------------

test('coalescing: two same-target same-kind hits within 0.12s merge into one live record with the summed amount', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const target = makeActor(1001);
  const source = makeActor(2001);

  emitHit(ctx, target, source, { total: 10, physical: 10 });
  assert.equal(fb.__activeCount(), 1);

  fb.update(0.05, ctx); // advance the live record's own t by 50ms — still < 0.12s window

  emitHit(ctx, target, source, { total: 7, physical: 7 });
  assert.equal(fb.__activeCount(), 1, 'a same-kind hit inside the window must merge, not spawn a second record');

  // Find the surviving record and check its summed amount/text.
  let rec = null;
  fb._pool.forEachActive((r) => { rec = r; });
  assert.equal(rec.amount, 17, '10 + 7');
  assert.equal(rec.text, '17');
});

test('coalescing: a same-target same-kind hit AFTER the window (following the pop-restart pullback) spawns a new record', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const target = makeActor(1002);
  const source = makeActor(2002);

  emitHit(ctx, target, source, { total: 10, physical: 10 }); // t=0, life=0.85, lastMergeT=0
  fb.update(0.05, ctx); // t=0.05
  emitHit(ctx, target, source, { total: 5, physical: 5 }); // merge: lastMergeT=0.05, t=min(0.05,0.085)=0.05
  fb.update(0.05, ctx); // t=0.10
  emitHit(ctx, target, source, { total: 5, physical: 5 }); // t-lastMergeT=0.10-0.05=0.05<0.12 -> merge: lastMergeT=0.10, t=min(0.10,0.085)=0.085 (pulled back)
  assert.equal(fb.__activeCount(), 1);

  fb.update(0.2, ctx); // t=0.085+0.2=0.285; t-lastMergeT=0.285-0.10=0.185 >= 0.12 -> next hit must NOT coalesce
  emitHit(ctx, target, source, { total: 3, physical: 3 });
  assert.equal(fb.__activeCount(), 2, 'past the 0.12s window (measured off the record\'s own integrated t, never the wall clock), a new number must spawn');
});

test('coalescing: a different kind on the same target does not merge (miss vs hit)', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const target = makeActor(1003);
  const source = makeActor(2003);

  emitHit(ctx, target, source, { total: 10, physical: 10, outcome: 'hit' });
  emitHit(ctx, target, source, { total: 0, outcome: 'miss' });
  assert.equal(fb.__activeCount(), 2, 'different kinds must never coalesce, even on the same target within the window');
});

test('coalescing window integrates dt, never Date.now()/performance.now() (source scan)', () => {
  assert.ok(!FEEDBACK_SRC.includes('Date.now'));
  assert.ok(!FEEDBACK_SRC.includes('performance.now'));
});

// ---------------------------------------------------------------------------
// 09 §10.1 — at most 3 live numbers per target, without a Map
// ---------------------------------------------------------------------------

test('per-target cap: a 4th distinct-kind hit on the same target within the window forces a merge into the youngest, never a 4th record', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const target = makeActor(1004);
  const source = makeActor(2004);

  emitHit(ctx, target, source, { total: 10, physical: 10, outcome: 'hit' });
  emitHit(ctx, target, source, { total: 0, outcome: 'miss' });
  emitHit(ctx, target, source, { total: 0, outcome: 'block', blocked: true });
  assert.equal(fb.__liveCountForTarget(target.id), 3);

  emitHit(ctx, target, source, { total: 0, outcome: 'immune' });
  assert.equal(fb.__liveCountForTarget(target.id), 3, 'a 4th number on the same target must merge into the youngest, not exceed 3 live');
});

test('per-target cap: does not use a Map anywhere in feedback.js (this ticket\'s own rule 6)', () => {
  assert.ok(!/\bnew Map\b/.test(FEEDBACK_SRC), 'feedback.js must not construct a Map for pooled/recycled state');
});

test('per-target cap: two different targets each get their own independent live count', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const t1 = makeActor(2101);
  const t2 = makeActor(2102);
  const source = makeActor(3001);
  for (const outcome of ['miss', 'block', 'immune']) emitHit(ctx, t1, source, { total: 0, outcome });
  for (const outcome of ['miss', 'block']) emitHit(ctx, t2, source, { total: 0, outcome });
  assert.equal(fb.__liveCountForTarget(t1.id), 3);
  assert.equal(fb.__liveCountForTarget(t2.id), 2);
});

// ---------------------------------------------------------------------------
// 09 §10.1 — no more than 24 drawn per frame; the biggest hits survive
// ---------------------------------------------------------------------------

test('draw cap: spawning 30 distinct-target hits draws at most 24, and the 24 drawn are the highest-value ones', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const source = makeActor(9001);

  for (let i = 1; i <= 30; i++) {
    const target = makeActor(9100 + i, (i % 10) - 5, 0, (Math.floor(i / 10)) - 1); // spread near the origin, all on-screen
    emitHit(ctx, target, source, { total: i, physical: i });
  }
  assert.equal(fb.__activeCount(), 30, 'nothing must be released just because it is not drawn');

  fb.update(1 / 60, ctx); // runs the draw pass
  assert.equal(fb.__lastDrawnCount(), 24, 'exactly 24 of the 30 must be selected for drawing this frame');

  // The lowest 6 values (1..6) must have been skipped, not the highest.
  let minDrawnAmount = Infinity;
  for (let i = 0; i < fb._topCount; i++) {
    const rec = fb._records[fb._topSlots[i]];
    if (rec.amount < minDrawnAmount) minDrawnAmount = rec.amount;
  }
  assert.equal(minDrawnAmount, 7, 'the 24 drawn must be values 7..30 — the lowest 6 (1..6) skipped');
});

test('draw cap: with fewer than 24 active, every one is drawn', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const source = makeActor(9201);
  for (let i = 1; i <= 5; i++) {
    const target = makeActor(9300 + i, 0, 0, 0);
    emitHit(ctx, target, source, { total: i, physical: i });
  }
  fb.update(1 / 60, ctx);
  assert.equal(fb.__lastDrawnCount(), 5);
});

// ---------------------------------------------------------------------------
// 09 §15 U3 — 200 hits over 2s never exceed the pool
// ---------------------------------------------------------------------------

test('200 hits over 2s never exceed the pool (low preset, capacity 64) and never throw', () => {
  const { fb, ctx } = newFeedback({ config: { quality: 'low' } });
  fb.setVisible(true);
  const source = makeActor(5001);
  const capacity = fb.__poolCapacity();
  assert.equal(capacity, 64);

  let maxActive = 0;
  for (let i = 0; i < 200; i++) {
    const target = makeActor(6000 + i, (i % 7) - 3, 0, (i % 5) - 2);
    assert.doesNotThrow(() => emitHit(ctx, target, source, { total: 5 + (i % 20), physical: 5 + (i % 20) }));
    fb.update(0.01, ctx); // 200 * 0.01s = 2.0s total
    maxActive = Math.max(maxActive, fb.__activeCount());
    assert.ok(fb.__activeCount() <= capacity, `active count ${fb.__activeCount()} exceeded pool capacity ${capacity} at hit ${i}`);
  }
  assert.ok(maxActive <= capacity);
});

// ---------------------------------------------------------------------------
// damageNumberMode filter ('own' default)
// ---------------------------------------------------------------------------

test("damageNumberMode 'own' (default): a hit sourced from a monster (not the player) does not spawn a number", () => {
  const playerActor = makeActor(7001);
  const player = { actor: playerActor, hudState(out) { return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) }, 'own');
  fb.setVisible(true);

  const monster = makeActor(7002);
  const target = makeActor(7003);
  emitHit(ctx, target, monster, { total: 10, physical: 10 });
  assert.equal(fb.__activeCount(), 0, "'own' mode must not draw a number whose source is not the player");
});

test("damageNumberMode 'own' (default): a hit sourced from the player DOES spawn a number", () => {
  const playerActor = makeActor(7011);
  const player = { actor: playerActor, hudState(out) { return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) }, 'own');
  fb.setVisible(true);

  const monster = makeActor(7012);
  emitHit(ctx, monster, playerActor, { total: 10, physical: 10 });
  assert.equal(fb.__activeCount(), 1);
});

// ---------------------------------------------------------------------------
// Rules: no Math.random(), no Math.hypot()
// ---------------------------------------------------------------------------

test('feedback.js source contains no Math.random() call (ARCHITECTURE.md rule 4)', () => {
  assert.ok(!FEEDBACK_SRC.includes('Math.random'));
});

test('feedback.js source contains no Math.hypot() call (this ticket\'s rule 6)', () => {
  assert.ok(!FEEDBACK_SRC.includes('Math.hypot'));
});

// ---------------------------------------------------------------------------
// §10.4 — low-life vignette + boot_clean/ui_clean safety net
// ---------------------------------------------------------------------------

test('vignette: with no player actor (maxLife=0), the vignette never becomes visible — the ui_clean/boot_clean safety net', () => {
  const player = { actor: null, hudState(out) { out.life = 0; out.maxLife = 0; return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  for (let i = 0; i < 5; i++) fb.update(1 / 60, ctx);
  assert.ok(fb.__vignetteShown() < 0.004, 'no live actor must never read as "low life"');
});

test('vignette: a placeholder actor at life=0/maxLife=73 (src/player/index.js\'s M0 stand-in, confirmed live against ui_clean) trips the NAMED O-67 suppression, not a fake "full life" reading — the exact ui_clean regression this ticket found and fixed', () => {
  const player = { actor: makeActor(8501, 0, 0, 0, 0, 73), hudState(out) { out.life = 0; out.maxLife = 73; return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  for (let i = 0; i < 60; i++) fb.update(1 / 60, ctx); // 1s — plenty for a real "low life" case to have ramped up
  assert.equal(fb.__vignetteSuppressedByO67(), true, 'life === 0 with a real actor must be read as the O-67 placeholder stand-in, not a genuine life fraction');
  assert.ok(fb.__vignetteShown() < 0.004, 'and, as a consequence of that suppression, the shown fraction stays at 0');
});

test('vignette: life at 1 out of 100 (genuinely low, not zero) does NOT trip the O-67 suppression, and DOES ramp the vignette up', () => {
  const player = { actor: makeActor(8502, 0, 0, 0, 1, 100), hudState(out) { out.life = 1; out.maxLife = 100; return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  for (let i = 0; i < 120; i++) fb.update(1 / 60, ctx);
  assert.equal(fb.__vignetteSuppressedByO67(), false, 'a genuinely low but nonzero life must never trip the O-67 stand-in');
  assert.ok(fb.__vignetteShown() > 0.5, 'a genuinely low (but nonzero) life must still trigger the vignette');
});

test('vignette: life above 35% never shows the vignette', () => {
  const playerActor = makeActor(8001, 0, 0, 0, 90, 100);
  const player = { actor: playerActor, hudState(out) { out.life = 90; out.maxLife = 100; return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  for (let i = 0; i < 60; i++) fb.update(1 / 60, ctx);
  assert.ok(fb.__vignetteShown() < 0.004);
});

test('vignette: life at 10% ramps the vignette up toward full over time (damp rate 7)', () => {
  const playerActor = makeActor(8002, 0, 0, 0, 10, 100);
  const player = { actor: playerActor, hudState(out) { out.life = 10; out.maxLife = 100; return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  for (let i = 0; i < 120; i++) fb.update(1 / 60, ctx); // 2s to settle
  assert.ok(fb.__vignetteShown() > 0.5, `expected the vignette to have ramped up at 10% life, got ${fb.__vignetteShown()}`);
});

// ---------------------------------------------------------------------------
// §10.3 — screenImpulse wiring, rate-limited to one per 120ms, max-combined
// ---------------------------------------------------------------------------

test('screenImpulse: a single player-damage hit calls render.screenImpulse and player.cameraShake once, after the 120ms window', () => {
  const playerActor = makeActor(8101, 0, 0, 0, 100, 100);
  const player = { actor: playerActor, hudState(out) { out.life = 100; out.maxLife = 100; return out; }, cameraShakeCalls: [], cameraShake(amount) { this.cameraShakeCalls.push(amount); } };
  const render = { calls: [], screenImpulse(strength, dx, dy) { this.calls.push([strength, dx, dy]); } };
  const { fb, ctx } = newFeedback({
    peek: (id) => (id === 'player' ? player : id === 'render' ? render : undefined),
  });
  fb.setVisible(true);

  const monster = makeActor(8102);
  emitHit(ctx, playerActor, monster, { total: 20, physical: 20 }); // 20% of maxLife -> strength 1.0 (0.20*100=20)

  assert.equal(render.calls.length, 0, 'must not fire immediately — rate-limited to the end of the 120ms window');
  for (let i = 0; i < 10; i++) fb.update(0.02, ctx); // 200ms, past the 120ms window
  assert.equal(render.calls.length, 1);
  assert.ok(Math.abs(render.calls[0][0] - 1.0) < 1e-6, `strength should clamp to 1.0 for a 20/100-life hit, got ${render.calls[0][0]}`);
  assert.equal(player.cameraShakeCalls.length, 1);
  assert.ok(Math.abs(player.cameraShakeCalls[0] - 0.35 * render.calls[0][0]) < 1e-6);
});

test('screenImpulse: two hits inside the same 120ms window max-combine into a single call', () => {
  const playerActor = makeActor(8111, 0, 0, 0, 100, 100);
  const player = { actor: playerActor, hudState(out) { out.life = 100; out.maxLife = 100; return out; }, cameraShake() {} };
  const render = { calls: [], screenImpulse(strength) { this.calls.push(strength); } };
  const { fb, ctx } = newFeedback({
    peek: (id) => (id === 'player' ? player : id === 'render' ? render : undefined),
  });
  fb.setVisible(true);

  const monster = makeActor(8112);
  emitHit(ctx, playerActor, monster, { total: 5, physical: 5 }); // strength 0.25
  fb.update(0.02, ctx);
  emitHit(ctx, playerActor, monster, { total: 15, physical: 15 }); // strength 0.75 — the max
  for (let i = 0; i < 10; i++) fb.update(0.02, ctx);

  assert.equal(render.calls.length, 1, 'exactly one impulse for the whole window');
  assert.ok(Math.abs(render.calls[0] - 0.75) < 1e-6, `expected the max of the two strengths (0.75), got ${render.calls[0]}`);
});

test('screenImpulse/cameraShake are called defensively — a render/player without these methods yet must never throw', () => {
  const playerActor = makeActor(8121, 0, 0, 0, 100, 100);
  const player = { actor: playerActor, hudState(out) { out.life = 100; out.maxLife = 100; return out; } }; // no cameraShake
  const render = {}; // no screenImpulse
  const { fb, ctx } = newFeedback({
    peek: (id) => (id === 'player' ? player : id === 'render' ? render : undefined),
  });
  fb.setVisible(true);
  const monster = makeActor(8122);
  emitHit(ctx, playerActor, monster, { total: 20, physical: 20 });
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i++) fb.update(0.02, ctx);
  });
});

// ---------------------------------------------------------------------------
// §10.2 — hit flash on player damage
// ---------------------------------------------------------------------------

test('hit flash: a player-damage hit sets a nonzero opacity that decays to 0 within 190ms', () => {
  const playerActor = makeActor(8201, 0, 0, 0, 100, 100);
  const player = { actor: playerActor, hudState(out) { out.life = 100; out.maxLife = 100; return out; } };
  const { fb, ctx } = newFeedback({ peek: (id) => (id === 'player' ? player : undefined) });
  fb.setVisible(true);
  const monster = makeActor(8202);
  emitHit(ctx, playerActor, monster, { total: 18, physical: 18 }); // 0.18*maxLife -> peak = 0.35+0.65*1 = 1.0
  fb.update(1 / 60, ctx);
  assert.ok(parseFloat(fb._flashEl.style.opacity) > 0);
  for (let i = 0; i < 20; i++) fb.update(1 / 60, ctx); // > 190ms
  assert.ok(parseFloat(fb._flashEl.style.opacity) <= 0.001, `flash must have decayed to ~0, got ${fb._flashEl.style.opacity}`);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('update(dt=0) does not advance any live record\'s t', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const target = makeActor(9501);
  const source = makeActor(9502);
  emitHit(ctx, target, source, { total: 10, physical: 10 });
  let rec = null;
  fb._pool.forEachActive((r) => { rec = r; });
  const before = rec.t;
  fb.update(0, ctx);
  assert.equal(rec.t, before);
});

test('a fully expired record is released back to the pool (activeCount drops)', () => {
  const { fb, ctx } = newFeedback();
  fb.setVisible(true);
  const target = makeActor(9601);
  const source = makeActor(9602);
  emitHit(ctx, target, source, { total: 10, physical: 10 }); // 'hit' life = 0.85s
  assert.equal(fb.__activeCount(), 1);
  for (let i = 0; i < 60; i++) fb.update(0.02, ctx); // 1.2s, past life
  assert.equal(fb.__activeCount(), 0);
});
