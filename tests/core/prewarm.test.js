// tests/core/prewarm.test.js
//
// CORE-8 acceptance tests for src/core/prewarm.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// None of the seven real subsystems (render, materials, sky, world, actors,
// items, skills) or fx exist yet, so every test here builds stub subsystem
// classes with just a `static id` and (sometimes) a `prewarmMaterials` hook —
// the same pattern tests/core/registry.test.js uses for CORE-3. `Rng` is
// imported for real (from CORE-5's src/core/rng.js) so the rng-untouched
// assertions exercise the actual xoshiro128** state fields, not a fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prewarm } from '../../src/core/prewarm.js';
import { Rng } from '../../src/core/rng.js';

/** Builds a fresh stub subsystem class for `id`. `hook`, if given, becomes
 * its `prewarmMaterials`; omitted entirely (not just undefined) when absent,
 * so `typeof sys.prewarmMaterials === 'function'` is false the same way a
 * subsystem that simply doesn't implement the hook would be. */
function makeSubsystemClass(id, hook) {
  class Sub {
    static id = id;
  }
  if (hook) Sub.prototype.prewarmMaterials = hook;
  return Sub;
}

/** Builds a fake `Engine`-shaped object: `systems` (in the given, already-
 * "init order" array order — CORE-3's `Registry.init()` contract), `ctx`
 * (carrying a real `Rng` at `ctx.rng` and the engine's own `time` object),
 * `time` (all eight ARCHITECTURE.md fields) and `_accum`. Mirrors what
 * CORE-2's `Engine` actually exposes (`engine.ctx.time === engine.time`). */
function makeEngine(defs, { rngSeed = 0xc0ffee } = {}) {
  const rng = new Rng(rngSeed);
  const systems = defs.map(({ id, hook }) => new (makeSubsystemClass(id, hook))());
  const time = {
    elapsed: 12.5, raw: 12.5, dt: 1 / 60, fixed: 1 / 60,
    alpha: 0.37, scale: 1, frame: 91, step: 730,
  };
  const ctx = { rng, time };
  return { systems, ctx, time, _accum: 0.0083 };
}

function rngWords(rng) {
  return { s0: rng.s0, s1: rng.s1, s2: rng.s2, s3: rng.s3 };
}

test('calls prewarmMaterials on every subsystem that implements it, exactly once, and skips the rest', async () => {
  const counts = new Map();
  const bump = (id) => counts.set(id, (counts.get(id) || 0) + 1);

  const engine = makeEngine([
    { id: 'physics' }, // no hook
    { id: 'materials', hook: async () => bump('materials') },
    { id: 'render', hook: async () => bump('render') },
    { id: 'nav' }, // no hook
    { id: 'combat', hook: async () => bump('combat') },
  ]);

  const hooks = await prewarm(engine);

  assert.equal(counts.get('materials'), 1);
  assert.equal(counts.get('render'), 1);
  assert.equal(counts.get('combat'), 1);
  assert.equal(counts.has('physics'), false);
  assert.equal(counts.has('nav'), false);
  assert.deepEqual(hooks.materials, { ok: true });
  assert.deepEqual(hooks.render, { ok: true });
  assert.deepEqual(hooks.combat, { ok: true });
  assert.equal(hooks.physics, undefined);
  assert.equal(hooks.nav, undefined);
});

test('works with zero subsystems implementing the hook', async () => {
  const engine = makeEngine([{ id: 'physics' }, { id: 'nav' }]);
  const hooks = await prewarm(engine);
  assert.deepEqual(hooks, {});
});

test('works with every registered subsystem implementing the hook', async () => {
  const log = [];
  const ids = ['render', 'materials', 'sky', 'world', 'nav', 'actors', 'combat', 'items', 'skills', 'ai'];
  const engine = makeEngine(ids.map((id) => ({ id, hook: async () => log.push(id) })));

  const hooks = await prewarm(engine);

  assert.equal(log.length, ids.length);
  for (const id of ids) assert.deepEqual(hooks[id], { ok: true });
});

test('render runs first; fx is never invoked even though it implements the hook', async () => {
  const log = [];
  const engine = makeEngine([
    { id: 'skills', hook: async () => log.push('skills') },
    { id: 'fx', hook: async () => log.push('fx') }, // must never run
    { id: 'items', hook: async () => log.push('items') },
    { id: 'render', hook: async () => log.push('render') },
    { id: 'materials', hook: async () => log.push('materials') },
  ]);

  const hooks = await prewarm(engine);

  assert.equal(log[0], 'render');
  assert.ok(!log.includes('fx'));
  assert.equal(hooks.fx, undefined);
});

test('fx is excluded even when it is the only subsystem implementing the hook', async () => {
  const log = [];
  const engine = makeEngine([{ id: 'fx', hook: async () => log.push('fx') }]);
  const hooks = await prewarm(engine);
  assert.deepEqual(log, []);
  assert.deepEqual(hooks, {});
});

test('follows the 11-flows.md §1.4 priority order for the seven named subsystems; unnamed hook-implementers run afterward, in init order', async () => {
  const log = [];
  const push = (id) => async () => log.push(id);

  // Registration/init order deliberately scrambled relative to both the
  // §1.4 priority table and the 02-api-contracts.md § Init order line.
  const engine = makeEngine([
    { id: 'skills', hook: push('skills') },
    { id: 'ai', hook: push('ai') },          // not in the §1.4 table
    { id: 'items', hook: push('items') },
    { id: 'combat', hook: push('combat') },  // not in the §1.4 table
    { id: 'actors', hook: push('actors') },
    { id: 'world', hook: push('world') },
    { id: 'sky', hook: push('sky') },
    { id: 'materials', hook: push('materials') },
    { id: 'render', hook: push('render') },
  ]);

  await prewarm(engine);

  assert.deepEqual(log, [
    'render', 'materials', 'sky', 'world', 'actors', 'items', 'skills',
    'ai', 'combat',
  ]);
});

test('rng stream is unaffected even when a hook draws from ctx.rng ten times', async () => {
  const engine = makeEngine([
    {
      id: 'materials',
      hook: async (ctx) => {
        for (let i = 0; i < 10; i++) ctx.rng.u32();
      },
    },
  ]);
  const before = rngWords(engine.ctx.rng);

  await prewarm(engine);

  assert.deepEqual(rngWords(engine.ctx.rng), before);
});

test('engine.time and engine._accum are restored even when a hook corrupts them', async () => {
  const engine = makeEngine([
    {
      id: 'world',
      hook: async (ctx) => {
        ctx.time.step = 999999;
        ctx.time.elapsed = -1;
        ctx.time.frame = 0;
        ctx.time.scale = 0;
      },
    },
  ]);
  const beforeTime = { ...engine.time };
  const beforeAccum = engine._accum;

  await prewarm(engine);

  assert.deepEqual(engine.time, beforeTime);
  assert.equal(engine._accum, beforeAccum);
  assert.equal(engine.time, engine.ctx.time); // same object reference, not a replacement
});

test('a hook that draws rng, corrupts time and then throws still gets state restored, does not stop the remaining hooks, and does not make prewarm() throw', async () => {
  const log = [];
  const engine = makeEngine([
    {
      id: 'render',
      hook: async (ctx) => {
        ctx.rng.u32();
        ctx.rng.u32();
        ctx.rng.u32();
        ctx.time.step = -1;
        log.push('render');
        throw new Error('boom');
      },
    },
    { id: 'materials', hook: async () => log.push('materials') },
    { id: 'sky', hook: async () => log.push('sky') },
  ]);
  const beforeRng = rngWords(engine.ctx.rng);
  const beforeTime = { ...engine.time };

  let hooks;
  await assert.doesNotReject(async () => {
    hooks = await prewarm(engine);
  });

  assert.deepEqual(log, ['render', 'materials', 'sky']);
  assert.equal(hooks.render.ok, false);
  assert.ok(hooks.render.reason instanceof Error);
  assert.deepEqual(hooks.materials, { ok: true });
  assert.deepEqual(hooks.sky, { ok: true });
  assert.deepEqual(rngWords(engine.ctx.rng), beforeRng);
  assert.deepEqual(engine.time, beforeTime);
  assert.equal(engine.__prewarmHooks, hooks);
});

// --- render.withPrewarmTarget(fn) contract (docs/PROGRESS.md D-3) --------
//
// Invariant 1 ("a render target must be bound while compiling") is `render`'s
// responsibility, not this dispatcher's: `02-api-contracts.md` §1 forbids any
// caller but `render` from touching `setRenderTarget()`, and this file may
// not import `three` to build a `WebGLRenderTarget` anyway. So `render` (once
// RNDR-1 exists) exposes `withPrewarmTarget(fn)` — builds and binds its own
// scratch target, awaits `fn()`, restores the previous target in its own
// `finally` — and `prewarm()` runs the *entire* hook pass inside that
// callback when it's implemented, falling back to running it directly when
// it isn't (true for every subsystem today).

test('when render implements withPrewarmTarget, every hook runs inside its callback', async () => {
  const boundDuringHooks = [];
  const wrapLog = [];
  let bound = false;

  const engine = makeEngine([
    { id: 'render', hook: async () => boundDuringHooks.push(bound) },
    { id: 'materials', hook: async () => boundDuringHooks.push(bound) },
    { id: 'sky', hook: async () => boundDuringHooks.push(bound) },
  ]);
  const renderInstance = engine.systems.find((s) => s.constructor.id === 'render');
  renderInstance.withPrewarmTarget = async (fn) => {
    wrapLog.push('bind');
    bound = true;
    try {
      await fn();
    } finally {
      bound = false;
      wrapLog.push('unbind');
    }
  };

  const hooks = await prewarm(engine);

  assert.deepEqual(wrapLog, ['bind', 'unbind']);
  assert.deepEqual(boundDuringHooks, [true, true, true]);
  assert.equal(bound, false); // unbound again after the pass
  assert.deepEqual(hooks.render, { ok: true });
  assert.deepEqual(hooks.materials, { ok: true });
  assert.deepEqual(hooks.sky, { ok: true });
});

test('order (render first, fx excluded) is preserved inside withPrewarmTarget', async () => {
  const log = [];
  const wrapLog = [];
  const engine = makeEngine([
    { id: 'skills', hook: async () => log.push('skills') },
    { id: 'fx', hook: async () => log.push('fx') }, // must never run
    { id: 'items', hook: async () => log.push('items') },
    { id: 'render', hook: async () => log.push('render') },
    { id: 'materials', hook: async () => log.push('materials') },
  ]);
  const renderInstance = engine.systems.find((s) => s.constructor.id === 'render');
  renderInstance.withPrewarmTarget = async (fn) => {
    wrapLog.push('bind');
    await fn();
    wrapLog.push('unbind');
  };

  const hooks = await prewarm(engine);

  assert.deepEqual(wrapLog, ['bind', 'unbind']);
  assert.equal(log[0], 'render');
  assert.ok(!log.includes('fx'));
  assert.equal(hooks.fx, undefined);
});

test('render present but not implementing withPrewarmTarget still runs the pass and does not throw', async () => {
  const engine = makeEngine([
    { id: 'render', hook: async () => {} }, // no withPrewarmTarget at all
    { id: 'materials', hook: async () => {} },
  ]);

  let hooks;
  await assert.doesNotReject(async () => {
    hooks = await prewarm(engine);
  });

  assert.deepEqual(hooks.render, { ok: true });
  assert.deepEqual(hooks.materials, { ok: true });
});

test('degrades correctly with no render subsystem at all', async () => {
  const engine = makeEngine([{ id: 'materials', hook: async () => {} }]);
  let hooks;
  await assert.doesNotReject(async () => {
    hooks = await prewarm(engine);
  });
  assert.deepEqual(hooks.materials, { ok: true });
});

test('a withPrewarmTarget that throws before running the callback does not break rng/time/_accum restoration or make prewarm() throw', async () => {
  const engine = makeEngine([
    { id: 'render', hook: async () => {} },
    { id: 'materials', hook: async () => {} },
  ]);
  const renderInstance = engine.systems.find((s) => s.constructor.id === 'render');
  renderInstance.withPrewarmTarget = async () => {
    throw new Error('scratch target build failed');
  };
  const beforeRng = rngWords(engine.ctx.rng);
  const beforeTime = { ...engine.time };
  const beforeAccum = engine._accum;

  let hooks;
  await assert.doesNotReject(async () => {
    hooks = await prewarm(engine);
  });

  // withPrewarmTarget never called fn(), so neither hook ran this pass.
  assert.deepEqual(hooks, {});
  assert.deepEqual(rngWords(engine.ctx.rng), beforeRng);
  assert.deepEqual(engine.time, beforeTime);
  assert.equal(engine._accum, beforeAccum);
});

test('a withPrewarmTarget that runs the callback and then throws still keeps the hooks it ran, restores state, and does not make prewarm() throw', async () => {
  const log = [];
  const engine = makeEngine([
    {
      id: 'render',
      hook: async (ctx) => {
        ctx.rng.u32();
        ctx.rng.u32();
        ctx.time.step = -1;
        log.push('render');
      },
    },
    { id: 'materials', hook: async () => log.push('materials') },
  ]);
  const renderInstance = engine.systems.find((s) => s.constructor.id === 'render');
  renderInstance.withPrewarmTarget = async (fn) => {
    await fn();
    throw new Error('restore of previous target failed');
  };
  const beforeRng = rngWords(engine.ctx.rng);
  const beforeTime = { ...engine.time };

  let hooks;
  await assert.doesNotReject(async () => {
    hooks = await prewarm(engine);
  });

  assert.deepEqual(log, ['render', 'materials']);
  assert.deepEqual(hooks.render, { ok: true });
  assert.deepEqual(hooks.materials, { ok: true });
  assert.deepEqual(rngWords(engine.ctx.rng), beforeRng);
  assert.deepEqual(engine.time, beforeTime);
});

test('idempotent: calling prewarm() again behaves the same as the first call', async () => {
  const counts = new Map();
  const bump = (id) => counts.set(id, (counts.get(id) || 0) + 1);
  const engine = makeEngine([
    { id: 'render', hook: async () => bump('render') },
    { id: 'materials', hook: async () => bump('materials') },
  ]);

  const first = await prewarm(engine);
  const second = await prewarm(engine);

  assert.equal(counts.get('render'), 2);
  assert.equal(counts.get('materials'), 2);
  assert.deepEqual(first, { render: { ok: true }, materials: { ok: true } });
  assert.deepEqual(second, { render: { ok: true }, materials: { ok: true } });
  assert.equal(engine.__prewarmHooks, second);
});

test('never reads the wall clock', async () => {
  const engine = makeEngine([
    { id: 'render', hook: async () => {} },
    { id: 'materials', hook: async () => {} },
  ]);

  const realDateNow = Date.now;
  const realPerfNow = globalThis.performance && globalThis.performance.now;
  Date.now = () => { throw new Error('Date.now() read inside prewarm()'); };
  if (globalThis.performance) {
    globalThis.performance.now = () => { throw new Error('performance.now() read inside prewarm()'); };
  }
  try {
    await assert.doesNotReject(() => prewarm(engine));
  } finally {
    Date.now = realDateNow;
    if (globalThis.performance) globalThis.performance.now = realPerfNow;
  }
});

test('degrades gracefully with no engine, an empty engine, or no systems array', async () => {
  await assert.doesNotReject(() => prewarm());
  await assert.doesNotReject(() => prewarm(undefined));
  await assert.doesNotReject(() => prewarm({}));
  const hooks = await prewarm({ systems: [] });
  assert.deepEqual(hooks, {});
});
