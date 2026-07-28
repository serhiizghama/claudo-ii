// tests/core/engine.test.js
//
// CORE-2 acceptance tests for src/core/engine.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, PHYSICS_HZ, FIXED_DT, MAX_SUBSTEPS } from '../../src/core/engine.js';

test('fixed-step constants', () => {
  assert.equal(PHYSICS_HZ, 60);
  assert.equal(FIXED_DT, 1 / 60);
  assert.equal(MAX_SUBSTEPS, 6);
});

test('rawDt is clamped to 0.10s before accumulation', () => {
  const engine = new Engine();
  const steps = engine.frame(5.0); // wildly over the clamp
  // 0.10 / (1/60) === 6 exactly: the clamp is fully consumed, never more.
  assert.equal(steps, 6);
  assert.equal(engine.time.step, 6);
  assert.equal(engine._accum, 0); // spiral guard forces it to zero
});

test('time.step advances by exactly the fixed steps run; time.frame advances by 1 per frame regardless', () => {
  const engine = new Engine();

  // A frame under one fixed step runs zero steps but still counts as a frame.
  let steps = engine.frame(FIXED_DT / 2);
  assert.equal(steps, 0);
  assert.equal(engine.time.step, 0);
  assert.equal(engine.time.frame, 1);

  // Two fixed steps' worth in one frame.
  steps = engine.frame(FIXED_DT * 2);
  assert.equal(steps, 2);
  assert.equal(engine.time.step, 2);
  assert.equal(engine.time.frame, 2);

  // Six is the ceiling even when more time is queued (half a step was
  // already banked by the first call above).
  steps = engine.frame(FIXED_DT * 8);
  assert.ok(steps <= MAX_SUBSTEPS);
  assert.equal(engine.time.frame, 3);
});

test('time.step is never derived from the wall clock', () => {
  const engine = new Engine();

  // Poison every wall-clock source frame() could read. If frame() ever
  // touches one of these, the test fails loudly instead of silently
  // depending on real elapsed time.
  const realDateNow = Date.now;
  const realPerfNow = globalThis.performance && globalThis.performance.now;
  Date.now = () => { throw new Error('Date.now() read inside frame()'); };
  if (globalThis.performance) {
    globalThis.performance.now = () => { throw new Error('performance.now() read inside frame()'); };
  }

  try {
    const a = engine.frame(FIXED_DT * 3);
    const b = engine.frame(FIXED_DT * 3);
    assert.equal(a, 3);
    assert.equal(b, 3);
  } finally {
    Date.now = realDateNow;
    if (globalThis.performance) globalThis.performance.now = realPerfNow;
  }

  // Same rawDt fed twice in a row must produce the same step increment.
  const engineA = new Engine();
  const engineB = new Engine();
  const seq = [FIXED_DT * 0.5, FIXED_DT * 1.3, FIXED_DT * 4, FIXED_DT * 0.1];
  const stepsA = seq.map((dt) => engineA.frame(dt));
  const stepsB = seq.map((dt) => engineB.frame(dt));
  assert.deepEqual(stepsA, stepsB);
  assert.equal(engineA.time.step, engineB.time.step);
});

test('time.alpha stays in [0, 1)', () => {
  const engine = new Engine();
  const samples = [0, FIXED_DT * 0.3, FIXED_DT * 1.7, FIXED_DT * 5.9, 1, 0.001];
  for (const dt of samples) {
    engine.frame(dt);
    assert.ok(engine.time.alpha >= 0, `alpha ${engine.time.alpha} < 0`);
    assert.ok(engine.time.alpha < 1, `alpha ${engine.time.alpha} >= 1`);
  }
});

test('time.scale = 0 halts the accumulator but frame()/time.frame still advance', () => {
  const engine = new Engine();
  engine.time.scale = 0;
  const steps = engine.frame(FIXED_DT * 3);
  assert.equal(steps, 0);
  assert.equal(engine.time.step, 0);
  assert.equal(engine.time.dt, 0);
  assert.equal(engine.time.frame, 1);
});

test('fixedUpdate/update/lateUpdate run in system order, once per fixed step / once per frame', () => {
  const log = [];
  const makeSystem = (id) => ({
    fixedUpdate: () => log.push(`${id}.fixedUpdate`),
    update: () => log.push(`${id}.update`),
    lateUpdate: () => log.push(`${id}.lateUpdate`),
  });
  const engine = new Engine({ systems: [makeSystem('a'), makeSystem('b')] });

  engine.frame(FIXED_DT * 2);

  assert.deepEqual(log, [
    'a.fixedUpdate', 'b.fixedUpdate', // step 1
    'a.fixedUpdate', 'b.fixedUpdate', // step 2
    'a.update', 'b.update',
    'a.lateUpdate', 'b.lateUpdate',
  ]);
});

test('12.D07 — 600 fixed steps produce the same state whether run as 600x1, 300x2 or 100x6 substeps', () => {
  // A deterministic dummy subsystem: integrates its position against `h`
  // (the fixed step), never against the frame's `dt`. A system that
  // mistakenly used `dt` instead would diverge across these three
  // schedules — that's exactly the bug 12.D07 exists to catch
  // (docs/spec/12-testing.md §7).
  function makeDummySystem() {
    const state = { pos: 0, ticks: 0 };
    return {
      state,
      fixedUpdate(h) {
        state.pos += 3.25 * h;
        state.ticks += 1;
      },
    };
  }

  function run(frameCount, rawDt) {
    const dummy = makeDummySystem();
    const engine = new Engine({ systems: [dummy] });
    for (let i = 0; i < frameCount; i++) engine.frame(rawDt);
    return { pos: dummy.state.pos, ticks: dummy.state.ticks, step: engine.time.step };
  }

  const a = run(600, FIXED_DT * 1); // 600 frames x 1 step
  const b = run(300, FIXED_DT * 2); // 300 frames x 2 steps
  const c = run(100, FIXED_DT * 6); // 100 frames x 6 steps (exactly the clamp)

  assert.equal(a.step, 600);
  assert.equal(b.step, 600);
  assert.equal(c.step, 600);

  assert.equal(a.ticks, 600);
  assert.equal(b.ticks, 600);
  assert.equal(c.ticks, 600);

  assert.equal(a.pos, b.pos);
  assert.equal(b.pos, c.pos);
});

test('module import is Node-safe (no three, no DOM/rAF access at import time)', () => {
  // If this file's top-level import threw, none of the tests above would
  // have run at all; this test just documents the guarantee explicitly and
  // checks that constructing/using the engine never touches globals absent
  // from Node.
  assert.equal(typeof Engine, 'function');
  const engine = new Engine();
  assert.doesNotThrow(() => engine.frame(FIXED_DT));
});
