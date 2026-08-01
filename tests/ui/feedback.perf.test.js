// tests/ui/feedback.perf.test.js
//
// UI-4's own `Alloc: no` gate for the steady per-frame draw/update path
// (`09-ui.md` §15 U3's acceptance row: "never allocates after the first
// frame"). Named `.perf.test.js` per D-11 — picked up by `npm run
// test:perf` (`--test-concurrency=1`, isolated) and excluded from
// `test:unit` by name. Do NOT run the full `test:perf` suite from an agent
// session that isn't the orchestrator (it serialises the whole perf stage
// and another agent may be writing elsewhere in the tree) — this file
// alone, via `node --expose-gc --test tests/ui/feedback.perf.test.js`, is
// fine and expected.
//
// O-43/O-23 methodology, verbatim — matches
// `tests/player/hudstate.perf.test.js` and `tests/combat/resolve.perf.test.js`:
// a probe below ~1M iterations is noise, not signal. Sampled at N=1e6 and
// N=4e6; judged by the MARGINAL bytes between the two TOTALS, not either
// mean alone, so warm-up settling at the smaller N cannot hide inside the
// reported number.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Feedback } from '../../src/ui/feedback.js';
import { el } from '../../src/ui/util.js';
import { Rng } from '../../src/core/rng.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import * as THREE from 'three';

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
  return { width, height, clientWidth: width, clientHeight: height, addEventListener() {}, removeEventListener() {} };
}

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

function makeDamageResult(overrides) {
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

test('12.A0x: Feedback#update(dt, ctx) steady-state draw pass allocates < 1 byte/call marginally at N=1e6..4e6 (O-43 methodology)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const canvas = makeCanvas();
  const player = { actor: makeActor(1, 0, 0, 0, 80, 100), hudState(out) { out.life = 80; out.maxLife = 100; return out; }, cameraShake() {} };
  const render = { screenImpulse() {} };
  const audio = { playUi() {} };
  const ctx = {
    canvas,
    camera: buildTestCamera(canvas.width, canvas.height),
    rng: new Rng(999),
    events: makeEventBus(),
    config: { quality: 'high' },
    peek(id) {
      if (id === 'player') return player;
      if (id === 'render') return render;
      if (id === 'audio') return audio;
      return undefined;
    },
    get() { return null; },
    has() { return false; },
  };

  const layer = el('div', 'cl2-layer');
  const fb = new Feedback(ctx, layer, (k) => k);
  fb._damageNumberMode = 'all';
  fb.setVisible(true);

  // Warm up: fill the pool with a realistic, varied population — every
  // kind, spread across the visible frustum near the origin, life 80% (so
  // the vignette/heartbeat branches are both exercised) and one player hit
  // to open (and let expire) an impulse/flash window before the timed
  // section starts (§10.1's own budget row: "the first frame allocates" is
  // expected and excluded here, same as `hudstate.perf.test.js`'s own
  // warm-up-then-measure shape).
  const monster = makeActor(2, 1, 0, 1);
  const kinds = [
    { outcome: 'hit', total: 12, physical: 12 },
    { outcome: 'hit', total: 30, crit: true, fire: 30 },
    { outcome: 'miss', total: 0 },
    { outcome: 'block', total: 0, blocked: true },
    { outcome: 'immune', total: 0 },
  ];
  let nextTargetId = 100;
  for (let i = 0; i < 40; i++) {
    const target = makeActor(nextTargetId++, (i % 9) - 4, 0, (i % 7) - 3);
    const spec = kinds[i % kinds.length];
    const result = makeDamageResult({ ...spec, targetId: target.id, sourceId: monster.id });
    ctx.events.emit('actor:damage', { target, source: monster, result });
  }
  ctx.events.emit('actor:damage', {
    target: player.actor,
    source: monster,
    result: makeDamageResult({ outcome: 'hit', total: 10, physical: 10, targetId: player.actor.id, sourceId: monster.id }),
  });

  // Run enough real frames (dt > 0, the game's own fixed step) to let the
  // §10.3 impulse window close and the initial pool fully settle — this is
  // the "let the shapes settle" warm-up `allocatedBytes`'s own doc block
  // asks for, done explicitly here rather than relying on its single
  // internal `fn()` call, matching `resolve.perf.test.js`'s own precedent.
  for (let i = 0; i < 30; i++) fb.update(1 / 60, ctx);

  // The timed closure: a steady per-frame draw/update pass with dt=0 (a
  // paused frame) — every live record's `t` stays put, nothing expires,
  // nothing (re)spawns, so this measures exactly the "no allocation per
  // frame" rule (ARCHITECTURE.md rule 6) on the presentation path itself:
  // vignette/flash/impulse-window bookkeeping, the pool's age+top-24 scan,
  // world->screen projection and (since there is no real 2D context under
  // Node — see feedback.js's own `_drawSelected`) every draw-pass branch
  // except the literal `CanvasRenderingContext2D` calls, which do not exist
  // in this harness to allocate through in the first place.
  const runOneFrame = () => { fb.update(0, ctx); };

  const atOneMillion = allocatedBytes(runOneFrame, 1_000_000);
  const atFourMillion = allocatedBytes(runOneFrame, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `Feedback#update(0, ctx) allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `Feedback#update must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});

test('12.A0x: Feedback#update stays allocation-free even with a real animating (dt>0) population, at N=1e6 (bounded life via a large pool)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const canvas = makeCanvas();
  const player = { actor: makeActor(1, 0, 0, 0, 60, 100), hudState(out) { out.life = 60; out.maxLife = 100; return out; }, cameraShake() {} };
  const ctx = {
    canvas,
    camera: buildTestCamera(canvas.width, canvas.height),
    rng: new Rng(42),
    events: makeEventBus(),
    config: { quality: 'high' },
    peek(id) { return id === 'player' ? player : undefined; },
    get() { return null; },
    has() { return false; },
  };

  const layer = el('div', 'cl2-layer');
  const fb = new Feedback(ctx, layer, (k) => k);
  fb._damageNumberMode = 'all';
  fb.setVisible(true);

  // Spawn once — `life: 1.4` ('text' kind via floatingText) so the
  // population survives many, many `dt = 1/60` frames without expiring
  // (life 1.4s / (1/60) ~= 84 frames; well past that it WOULD start
  // expiring, which is fine too — `_advanceOneRecord`'s `pool.release`
  // path is itself allocation-free, exercised by this same loop).
  for (let i = 0; i < 20; i++) fb.floatingText(i % 5, 0, Math.floor(i / 5), 'x', '#efe7d8');

  const runOneFrame = () => { fb.update(1 / 60, ctx); };

  // Same marginal-between-two-Ns judgement as the first test — a single
  // raw N=1e6 reading can still sit close to the noise floor (this
  // project's own measured 80.45 -> 0.325 B/call decay from N=10k to
  // N=4M), so this asserts on the TOTALS' marginal, not either mean alone.
  const atOneMillion = allocatedBytes(runOneFrame, 1_000_000);
  const atFourMillion = allocatedBytes(runOneFrame, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `Feedback#update(1/60, ctx) with an animating population (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `expected < 1 byte/call marginally between N=1e6 and N=4e6; got ${marginalBytesPerCall.toFixed(4)} ` +
      `(N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});
