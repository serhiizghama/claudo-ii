// tests/core/registry.test.js
//
// CORE-3 acceptance tests for src/core/registry.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../src/core/registry.js';

// The dependency map from IMPLEMENTATION_PLAN.md §3 / docs/spec/02-api-
// contracts.md § Init order, verbatim. `audio` and `physics` declare no
// deps and may legally float earlier than the documented reference line —
// that line is illustrative, the topo sort is the authority (same doc).
const DEP_MAP = {
  render: [],
  materials: ['render'],
  sky: ['render', 'materials'],
  physics: [],
  world: ['materials', 'physics'],
  nav: ['world'],
  actors: ['materials', 'physics'],
  combat: ['actors'],
  skills: ['actors', 'combat', 'fx'],
  items: ['materials'],
  ai: ['actors', 'nav', 'combat', 'world'],
  player: ['actors', 'nav', 'skills', 'items', 'world'],
  fx: ['render', 'materials'],
  ui: ['items', 'player'],
  audio: [],
  save: ['items', 'player'],
};

// Registration order the test uses to build a Registry from DEP_MAP. Chosen
// to differ from both the documented reference line and alphabetical order,
// so a passing test can't be an accident of a convenient input order.
const REGISTRATION_ORDER = [
  'ui', 'save', 'player', 'ai', 'items', 'skills', 'combat', 'fx',
  'actors', 'nav', 'world', 'physics', 'sky', 'materials', 'render', 'audio',
];

/** Builds a fresh stub class for `id` with the given `deps`, logging into
 * the shared `log` array on `init`/`dispose` so call order is observable. */
function makeStubClass(id, deps, log) {
  return class {
    static id = id;
    static deps = deps;
    async init(ctx) {
      log.push(`${id}.init`);
    }
    dispose() {
      log.push(`${id}.dispose`);
    }
  };
}

function buildRegistry(order, depMap, log = []) {
  const registry = new Registry();
  for (const id of order) {
    registry.add(makeStubClass(id, depMap[id], log));
  }
  return registry;
}

test('resolve(): every subsystem is ordered after all of its own deps', () => {
  const registry = buildRegistry(REGISTRATION_ORDER, DEP_MAP);
  const systems = registry.resolve();
  const order = systems.map((s) => s.constructor.id);

  assert.equal(order.length, Object.keys(DEP_MAP).length);
  assert.deepEqual([...order].sort(), Object.keys(DEP_MAP).sort()); // no dupes, none missing

  const indexOf = new Map(order.map((id, i) => [id, i]));
  for (const [id, deps] of Object.entries(DEP_MAP)) {
    for (const depId of deps) {
      assert.ok(
        indexOf.get(depId) < indexOf.get(id),
        `expected '${depId}' (idx ${indexOf.get(depId)}) before '${id}' (idx ${indexOf.get(id)}); got: ${order.join(' -> ')}`,
      );
    }
  }
});

test('resolve(): order is stable — identical registration sequence always yields the identical order', () => {
  const orderA = buildRegistry(REGISTRATION_ORDER, DEP_MAP).resolve().map((s) => s.constructor.id);
  const orderB = buildRegistry(REGISTRATION_ORDER, DEP_MAP).resolve().map((s) => s.constructor.id);
  const orderC = buildRegistry(REGISTRATION_ORDER, DEP_MAP).resolve().map((s) => s.constructor.id);
  assert.deepEqual(orderA, orderB);
  assert.deepEqual(orderB, orderC);

  // Calling resolve() again on the same registry (e.g. a second time from
  // init()) must not reshuffle or reconstruct anything.
  const registry = buildRegistry(REGISTRATION_ORDER, DEP_MAP);
  const first = registry.resolve();
  const second = registry.resolve();
  assert.deepEqual(first.map((s) => s.constructor.id), second.map((s) => s.constructor.id));
  for (let i = 0; i < first.length; i++) assert.equal(first[i], second[i]); // same instances, not rebuilt
});

test('resolve(): stabilization rule is registration order — a tied pair (no deps between them) follows add() order, and reversing add() order reverses their relative order', () => {
  const log = [];
  const registryAB = new Registry();
  registryAB.add(makeStubClass('audio', [], log));
  registryAB.add(makeStubClass('physics', [], log));
  const orderAB = registryAB.resolve().map((s) => s.constructor.id);
  assert.deepEqual(orderAB, ['audio', 'physics']);

  const registryBA = new Registry();
  registryBA.add(makeStubClass('physics', [], log));
  registryBA.add(makeStubClass('audio', [], log));
  const orderBA = registryBA.resolve().map((s) => s.constructor.id);
  assert.deepEqual(orderBA, ['physics', 'audio']);
});

test('resolve(): a dependency cycle throws at resolve(), naming the participants', () => {
  const log = [];
  const registry = new Registry();
  registry.add(makeStubClass('a', ['b'], log));
  registry.add(makeStubClass('b', ['c'], log));
  registry.add(makeStubClass('c', ['a'], log));

  assert.throws(() => registry.resolve(), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /cycle/i);
    for (const id of ['a', 'b', 'c']) {
      assert.ok(err.message.includes(id), `expected cycle error to name '${id}': ${err.message}`);
    }
    return true;
  });
});

test('resolve(): a direct self-dependency is also a cycle', () => {
  const log = [];
  const registry = new Registry();
  registry.add(makeStubClass('lonely', ['lonely'], log));
  assert.throws(() => registry.resolve(), /cycle/i);
});

test('init(): a cyclic graph throws at init(), not merely at resolve() — the acceptance criterion is "throws at init, not on first use"', async () => {
  const log = [];
  const registry = new Registry();
  registry.add(makeStubClass('a', ['b'], log));
  registry.add(makeStubClass('b', ['a'], log));

  await assert.rejects(() => registry.init({}), /cycle/i);
  // Nothing should have been initialized — the graph is invalid before any
  // subsystem's init() is allowed to run.
  assert.deepEqual(log, []);
});

test('resolve(): an unknown dependency throws, naming the missing id', () => {
  const log = [];
  const registry = new Registry();
  registry.add(makeStubClass('lonely', ['nosuch'], log));

  assert.throws(() => registry.resolve(), (err) => {
    assert.ok(err.message.includes('nosuch'));
    assert.ok(err.message.includes('lonely'));
    return true;
  });
});

test('add(): rejects a class without a static id, and a duplicate id', () => {
  const registry = new Registry();
  assert.throws(() => registry.add(class {}), /id/i);

  registry.add(makeStubClass('dup', [], []));
  assert.throws(() => registry.add(makeStubClass('dup', [], [])), /already registered/i);
});

test('init(): runs each subsystem\'s init(ctx) in resolved order, sequentially, with deps already ready', async () => {
  const log = [];
  const seenReadyDuringInit = {};
  const registry = new Registry();

  class Render {
    static id = 'render';
    static deps = [];
    async init(ctx) {
      log.push('render.init');
    }
  }
  class Materials {
    static id = 'materials';
    static deps = ['render'];
    async init(ctx) {
      // Its declared dep must already be visible; nothing declared after it
      // (e.g. 'sky') should be.
      seenReadyDuringInit.materialsSeesRender = ctx.has('render');
      seenReadyDuringInit.materialsSeesSky = ctx.has('sky');
      log.push('materials.init');
    }
  }
  class Sky {
    static id = 'sky';
    static deps = ['render', 'materials'];
    async init(ctx) {
      seenReadyDuringInit.skySeesMaterials = ctx.has('materials');
      log.push('sky.init');
    }
  }

  registry.add(Sky);
  registry.add(Render);
  registry.add(Materials);

  const ctx = { has: (id) => registry.has(id) };
  const systems = await registry.init(ctx);

  assert.deepEqual(log, ['render.init', 'materials.init', 'sky.init']);
  assert.equal(seenReadyDuringInit.materialsSeesRender, true);
  assert.equal(seenReadyDuringInit.materialsSeesSky, false);
  assert.equal(seenReadyDuringInit.skySeesMaterials, true);
  assert.deepEqual(systems.map((s) => s.constructor.id), ['render', 'materials', 'sky']);
});

test('init(): a subsystem with no init() method is simply skipped, not an error', async () => {
  const registry = new Registry();
  class NoInit {
    static id = 'noinit';
    static deps = [];
  }
  registry.add(NoInit);
  const systems = await registry.init({});
  assert.equal(systems.length, 1);
  assert.equal(registry.has('noinit'), true);
});

test('dispose(): runs in exactly the reverse of initialization order', async () => {
  const log = [];
  const registry = buildRegistry(['a', 'b', 'c'], { a: [], b: ['a'], c: ['b'] }, log);
  await registry.init({});
  log.length = 0; // drop init entries, keep only dispose

  registry.dispose();
  assert.deepEqual(log, ['c.dispose', 'b.dispose', 'a.dispose']);
});

test('dispose(): a subsystem with no dispose() method is simply skipped', async () => {
  const registry = new Registry();
  class NoDispose {
    static id = 'nodispose';
    static deps = [];
  }
  registry.add(NoDispose);
  await registry.init({});
  assert.doesNotThrow(() => registry.dispose());
});

test('get/peek/has: unregistered id', () => {
  const registry = new Registry();
  assert.equal(registry.has('ghost'), false);
  assert.equal(registry.peek('ghost'), undefined);
  assert.throws(() => registry.get('ghost'), /not a registered subsystem id/);
});

test('get/peek/has: registered but not yet initialized (resolve() ran, init() has not)', () => {
  const log = [];
  const registry = new Registry();
  registry.add(makeStubClass('render', [], log));
  registry.resolve(); // instances exist, but init() never ran

  assert.equal(registry.has('render'), false);
  assert.equal(registry.peek('render'), undefined);
  assert.throws(() => registry.get('render'), /not yet initialized/);
});

test('get/peek/has: ready after init(), and unready again after dispose()', async () => {
  const log = [];
  const registry = new Registry();
  registry.add(makeStubClass('render', [], log));
  await registry.init({});

  assert.equal(registry.has('render'), true);
  const instance = registry.get('render');
  assert.equal(instance.constructor.id, 'render');
  assert.equal(registry.peek('render'), instance);

  registry.dispose();
  assert.equal(registry.has('render'), false);
  assert.equal(registry.peek('render'), undefined);
  assert.throws(() => registry.get('render'), /not yet initialized/);
});

test('module import is Node-safe (no three, no DOM access at import time)', () => {
  assert.equal(typeof Registry, 'function');
  const registry = new Registry();
  assert.equal(registry.resolve().length, 0);
});
