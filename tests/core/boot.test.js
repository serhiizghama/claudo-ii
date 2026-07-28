// tests/core/boot.test.js
//
// CORE-9 acceptance tests for src/main.js. `node:test` + `node:assert/strict`
// only — no framework (12-testing.md P6). Every stub subsystem here follows
// the same minimal-class pattern tests/core/registry.test.js and
// tests/core/prewarm.test.js already use: a `static id`, an optional
// `static deps`, and whatever hook the test cares about.
//
// `three`'s `Scene`/`PerspectiveCamera` construct fine under Node (no
// canvas/WebGL touched by either), which is what lets this file assert on
// `ctx.scene`/`ctx.camera`/`ctx.uiScene`/`ctx.uiCamera` directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { boot } from '../../src/main.js';
import { EventBus } from '../../src/core/events.js';
import { Input } from '../../src/core/input.js';
import { Rng } from '../../src/core/rng.js';

const B_IDS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13'];

/** A canvas stand-in: just enough of `EventTarget` for `Input.attach()`. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Common options for `boot()`: a stub canvas, a deterministic seed by
 * default (so tests are not flaky on the `Math.random()` path unless they
 * opt into it explicitly), and a private `global` stand-in so no test ever
 * writes `__READY__`/`__ENGINE__`/`__PREWARM__` onto the real Node global. */
function bootOpts(overrides = {}) {
  return {
    canvas: makeCanvas(),
    deterministic: true,
    global: {},
    ...overrides,
  };
}

test('boot(): completes to the end with zero subsystems registered, and does not throw', async () => {
  const result = await boot(bootOpts());
  assert.ok(result.engine);
  assert.ok(result.ctx);
  assert.ok(Array.isArray(result.bootLog));
  assert.ok(result.config);
});

test('bootLog: stages appear in order B1..B13; ui/fx/save are absent and marked skipped', async () => {
  const { bootLog } = await boot(bootOpts());
  assert.deepEqual(bootLog.map((e) => e.id), B_IDS);

  for (const id of B_IDS) {
    const entry = bootLog.find((e) => e.id === id);
    assert.ok(entry.stage, `${id} missing 'stage'`);
    assert.ok(entry.owner, `${id} missing 'owner'`);
    assert.ok(['done', 'skipped'].includes(entry.status), `${id} has an unexpected status: ${entry.status}`);
  }

  const skippedIds = ['B7', 'B10', 'B11', 'B12']; // depend on ui / fx / save
  for (const id of skippedIds) {
    const entry = bootLog.find((e) => e.id === id);
    assert.equal(entry.status, 'skipped', `${id} should be skipped with no ui/fx/save registered`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `${id} skip needs a reason`);
  }

  for (const id of B_IDS.filter((i) => !skippedIds.includes(i))) {
    const entry = bootLog.find((e) => e.id === id);
    assert.equal(entry.status, 'done', `${id} should be done`);
  }
});

test('bootLog: B7/B10/B11/B12 complete once ui/fx/save are registered', async () => {
  const calls = [];
  class Ui {
    static id = 'ui';
    static deps = [];
    setScreen(screen) {
      calls.push(['ui.setScreen', screen]);
    }
  }
  class Fx {
    static id = 'fx';
    static deps = [];
    async prewarmMaterials() {
      calls.push(['fx.prewarmMaterials']);
    }
  }
  class Save {
    static id = 'save';
    static deps = [];
    meta() {
      return { slots: [null, null, null] }; // no character yet
    }
    settings() {
      calls.push(['save.settings']);
    }
  }

  const { bootLog } = await boot(bootOpts({ systems: [Ui, Fx, Save] }));

  for (const id of ['B7', 'B10', 'B11', 'B12']) {
    const entry = bootLog.find((e) => e.id === id);
    assert.equal(entry.status, 'done', `${id} should be done once its owner is registered`);
  }

  // B7 shows the boot veil first; B12 lands on character_create because
  // every slot is null (01-data-model.md §10.2). fx's own prewarmMaterials
  // is never called from here — B10 is fx's own responsibility (11-flows.md
  // B10) and it's also excluded from core/prewarm.js's B8 dispatch by design.
  assert.deepEqual(calls[0], ['ui.setScreen', 'boot']);
  assert.ok(calls.some((c) => c[0] === 'save.settings'));
  assert.ok(!calls.some((c) => c[0] === 'fx.prewarmMaterials'));
  assert.deepEqual(calls[calls.length - 1], ['ui.setScreen', 'character_create']);
});

test('ctx: carries every field docs/ARCHITECTURE.md promises', async () => {
  const { engine, ctx } = await boot(bootOpts());

  assert.ok(ctx.scene instanceof THREE.Scene);
  assert.ok(ctx.camera instanceof THREE.PerspectiveCamera);
  assert.ok(ctx.uiScene instanceof THREE.Scene);
  assert.ok(ctx.uiCamera instanceof THREE.PerspectiveCamera);
  assert.ok(ctx.canvas);
  assert.ok(ctx.config && typeof ctx.config === 'object');
  assert.ok(ctx.events instanceof EventBus);
  assert.ok(ctx.input instanceof Input);
  assert.ok(ctx.rng instanceof Rng);
  assert.equal(typeof ctx.get, 'function');
  assert.equal(typeof ctx.peek, 'function');
  assert.equal(typeof ctx.has, 'function');

  // `time` is engine-owned (src/core/engine.js) — same object on both.
  assert.ok(ctx.time);
  assert.equal(ctx.time, engine.time);
  for (const field of ['elapsed', 'raw', 'dt', 'fixed', 'alpha', 'scale', 'frame', 'step']) {
    assert.ok(field in ctx.time, `ctx.time missing '${field}'`);
  }

  assert.equal(ctx.has('nosuch'), false);
  assert.equal(ctx.peek('nosuch'), undefined);
  assert.throws(() => ctx.get('nosuch'));
});

test('ctx.time: exists during a subsystem\'s own init(), and is the same object as engine.time', async () => {
  let observedStep;
  let observedTimeRef;
  class Stub {
    static id = 'stub';
    static deps = [];
    async init(ctx) {
      // A real subsystem would seed a scheduled field here, e.g.
      // `nextTickStep = ctx.time.step + N` (01-data-model.md). If ctx.time
      // were undefined at this point, that would silently become NaN.
      observedStep = ctx.time && ctx.time.step;
      observedTimeRef = ctx.time;
    }
  }

  const { engine, ctx } = await boot(bootOpts({ systems: [Stub] }));

  assert.equal(typeof observedStep, 'number');
  assert.equal(Number.isNaN(observedStep), false);
  // Reference equality, not just "truthy" — the same object throughout,
  // not a copy or a later-reassigned one.
  assert.equal(observedTimeRef, engine.time);
  assert.equal(ctx.time, engine.time);
});

/** A minimal `window` stand-in: `innerWidth`/`innerHeight` plus the
 * `addEventListener`/`removeEventListener` pair `Input.attach()` requires
 * once `typeof window !== 'undefined'` (src/core/input.js's `attach()`
 * subscribes keyboard/pointer-up/blur on `window`, not just the canvas). */
function makeWindowStub(innerWidth, innerHeight) {
  return {
    innerWidth,
    innerHeight,
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Temporarily stubs `globalThis.window`, runs `fn`, then restores whatever
 * was there before (nothing, under plain Node) — used to exercise the
 * "a real window wins over the canvas" branch of `resolveSize` without a
 * real browser. */
async function withStubWindow(stub, fn) {
  const previous = globalThis.window;
  globalThis.window = stub;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test('resolveSize: a real window wins over the canvas\'s HTML5-default backing-store size (300x150)', async () => {
  const canvas = makeCanvas();
  canvas.width = 300; // what an un-attributed real <canvas> actually defaults to
  canvas.height = 150;

  await withStubWindow(makeWindowStub(1280, 720), async () => {
    const { bootLog } = await boot(bootOpts({ canvas }));
    const b3 = bootLog.find((e) => e.id === 'B3');
    assert.equal(b3.width, 1280);
    assert.equal(b3.height, 720);
  });
});

test('resolveSize: explicit opts.width/opts.height still win even with a window present', async () => {
  await withStubWindow(makeWindowStub(999, 999), async () => {
    const { bootLog } = await boot(bootOpts({ width: 1280, height: 720 }));
    const b3 = bootLog.find((e) => e.id === 'B3');
    assert.equal(b3.width, 1280);
    assert.equal(b3.height, 720);
  });
});

test('resolveSize: the computed size is stamped onto canvas.width/height as the output buffer, not read back as input', async () => {
  const canvas = makeCanvas(111, 222); // arbitrary starting values that must be overwritten
  const { bootLog } = await boot(bootOpts({ canvas, width: 640, height: 480 }));

  assert.equal(bootLog.find((e) => e.id === 'B3').width, 640);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 480);
});

test('worldSeed: deterministic=true always yields 0x5eed1234 and the same root rng stream across runs', async () => {
  const a = await boot(bootOpts({ deterministic: true }));
  const b = await boot(bootOpts({ deterministic: true }));

  const seedA = a.bootLog.find((e) => e.id === 'B3').worldSeed;
  const seedB = b.bootLog.find((e) => e.id === 'B3').worldSeed;
  assert.equal(seedA, 0x5eed1234);
  assert.equal(seedB, 0x5eed1234);

  // Same seed -> identical draws off the root stream, run to run.
  assert.equal(a.ctx.rng.u32(), b.ctx.rng.u32());
  assert.equal(a.ctx.rng.u32(), b.ctx.rng.u32());
});

test('worldSeed: deterministic=false draws Math.random() once and differs run to run', async () => {
  const a = await boot(bootOpts({ deterministic: false }));
  const b = await boot(bootOpts({ deterministic: false }));

  const seedA = a.bootLog.find((e) => e.id === 'B3').worldSeed;
  const seedB = b.bootLog.find((e) => e.id === 'B3').worldSeed;
  assert.notEqual(seedA, 0x5eed1234);
  assert.notEqual(seedA, seedB); // astronomically unlikely to collide
});

test('subsystems: init runs in topological order, not registration order', async () => {
  const initOrder = [];
  function makeStub(id, deps) {
    return class {
      static id = id;
      static deps = deps;
      async init() {
        initOrder.push(id);
      }
    };
  }
  const A = makeStub('stubA', []);
  const B = makeStub('stubB', ['stubA']);
  const C = makeStub('stubC', ['stubB']);

  // Registered out of dependency order on purpose.
  const { bootLog } = await boot(bootOpts({ systems: [C, A, B] }));

  assert.deepEqual(initOrder, ['stubA', 'stubB', 'stubC']);

  // B5's `count`/`ids` reflect the *actual* registry contents: the 3
  // injected stubs plus whatever main.js's own B4 block registers today
  // (`render`, RNDR-1) or in any future subsystem ticket. This test must
  // never hardcode that total — it grows by one every time a new
  // subsystem lands — so it derives everything from the bootLog itself.
  const b5 = bootLog.find((e) => e.id === 'B5');
  assert.ok(Array.isArray(b5.ids), 'B5 log entry should carry the resolved id list');
  assert.equal(b5.count, b5.ids.length);
  assert.ok(b5.count >= 3, 'at least the 3 injected stubs must be present');

  // The 3 stubs appear, in dependency order, as a subsequence of the full
  // resolved order — real subsystems main.js registers on its own are free
  // to interleave anywhere around them.
  const stubIds = b5.ids.filter((id) => id.startsWith('stub'));
  assert.deepEqual(stubIds, ['stubA', 'stubB', 'stubC']);
});

test('prewarm: runs between B6 and B9, and leaves ctx.rng untouched', async () => {
  let prewarmCalls = 0;
  class Stub {
    static id = 'stub';
    static deps = [];
    async prewarmMaterials() {
      prewarmCalls++;
    }
  }

  const { bootLog, ctx } = await boot(bootOpts({ systems: [Stub], deterministic: true }));

  const i6 = bootLog.findIndex((e) => e.id === 'B6');
  const i8 = bootLog.findIndex((e) => e.id === 'B8');
  const i9 = bootLog.findIndex((e) => e.id === 'B9');
  assert.ok(i6 < i8 && i8 < i9, 'B8 must sit strictly between B6 and B9');
  assert.equal(prewarmCalls, 1);

  // Nothing drew from the root stream — it must equal a fresh Rng seeded
  // with the same (deterministic) worldSeed.
  const fresh = new Rng(0x5eed1234);
  assert.equal(ctx.rng.s0, fresh.s0);
  assert.equal(ctx.rng.s1, fresh.s1);
  assert.equal(ctx.rng.s2, fresh.s2);
  assert.equal(ctx.rng.s3, fresh.s3);
});

test('B13: BOOT_FRAMES is 3, and __READY__/__ENGINE__/__PREWARM__ land on the given global stub', async () => {
  const globalStub = {};
  const { engine, bootLog } = await boot(bootOpts({ global: globalStub }));

  const b13 = bootLog.find((e) => e.id === 'B13');
  assert.equal(b13.bootFrames, 3);

  assert.equal(globalStub.__READY__, true);
  assert.equal(globalStub.__ENGINE__, engine);
  assert.ok(globalStub.__PREWARM__ && typeof globalStub.__PREWARM__ === 'object');

  // Node has no requestAnimationFrame, so boot() falls back to the lockstep
  // path and pumps exactly BOOT_FRAMES fixed steps directly through
  // engine.frame() — this is the "no explicit ?lockstep=1 needed under
  // Node" fallback described in src/main.js's header.
  assert.equal(engine.time.frame, 3);
  assert.equal(engine.time.step, 3);
});

// Waits for every currently-pending microtask to drain (Node has no real
// I/O in play anywhere in prewarm()'s call graph in these tests, so a
// single macrotask boundary — setImmediate — is enough to guarantee any
// depth of chained `await`s inside it has settled) before the assertion
// that follows runs. Used to observe the fire-and-forget `prewarm(engine)`
// the `render:context-restored` handler kicks off without main.js ever
// exposing that promise itself.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('render:context-restored: re-runs the shared prewarm dispatcher, and the subscription never grows', async () => {
  let prewarmCalls = 0;
  class Stub {
    static id = 'stub';
    static deps = [];
    async prewarmMaterials() {
      prewarmCalls++;
    }
  }

  const { ctx } = await boot(bootOpts({ systems: [Stub] }));
  assert.equal(prewarmCalls, 1); // B8, during boot() itself

  ctx.events.emit('render:context-restored', {});
  await flushMicrotasks();
  assert.equal(prewarmCalls, 2, 'one emit should trigger exactly one extra prewarm pass');

  ctx.events.emit('render:context-restored', {});
  await flushMicrotasks();
  // A third call (not a fourth) proves there is still only one subscriber —
  // a duplicated subscription would make this single emit count twice.
  assert.equal(prewarmCalls, 3, 'a second emit should trigger exactly one more pass, not two');
});

test('render:context-restored: a hook that throws during re-warm never escapes the (synchronous) emit, and does not crash the process', async () => {
  class Boom {
    static id = 'stub';
    static deps = [];
    async prewarmMaterials() {
      throw new Error('boom');
    }
  }

  const { ctx } = await boot(bootOpts({ systems: [Boom] }));

  // core/prewarm.js already catches a throwing hook internally and never
  // rejects (CORE-8's contract) — this asserts that guarantee holds
  // end-to-end through main.js's handler, and that emit() itself, which is
  // synchronous, never sees so much as a synchronous throw from it.
  assert.doesNotThrow(() => {
    ctx.events.emit('render:context-restored', {});
  });
  await flushMicrotasks(); // let the fire-and-forget pass settle before the test ends
});

test('module import is Node-safe (no window/document access at import time)', () => {
  assert.equal(typeof boot, 'function');
});
