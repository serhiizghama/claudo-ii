// tests/actors/actr15.test.js
//
// ACTR-15/O-57 acceptance tests: `ActorsSystem.stats`/`markDirty`/
// `setSourceLayer` — the thin facade this ticket wires into
// src/actors/index.js over the already-accepted pure engines in
// src/actors/stats.js (ACTR-7). `node:test` + `node:assert/strict` only,
// matching every sibling file in this directory.
//
// Scope: the wiring only. `composeStats` itself and the full E14 numeric
// fixture are ACTR-7's own gate (tests/actors/stats.test.js) and are not
// re-tested here except as much as a scenario needs `stats()` to actually
// compose something real.
//
// Every test below reaches the three methods via a live, registry-resolved
// `ctx.get('actors')` (criterion 5) — never `new ActorsSystem()` used
// directly as the surface under test — because that is how `combat`,
// `player` and `items` will actually reach them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// A real registry-resolved ctx — same wiring src/main.js does (get/peek/has
// bound off a live Registry), not a hand-rolled systems map.
// ---------------------------------------------------------------------------

async function makeRegistryCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null,
    camera: null,
    uiScene: null,
    uiCamera: null,
    canvas: null,
    config: {},
    events,
    input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  await registry.init(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. stats() — recomposes if dirty, then returns; same reference and no
//    recomposition on a clean actor.
// ---------------------------------------------------------------------------

test('actors.stats(actor) composes on a dirty actor, then returns the same reference doing no work while clean', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  assert.equal(actor.statsDirty, true, 'a freshly spawned actor starts dirty');

  const s1 = actors.stats(actor);
  assert.equal(actor.statsDirty, false, 'stats() must clear the dirty flag after composing');
  assert.ok(s1, 'stats() must return a StatBlock');

  // Sentinel: overwrite a real field with an impossible value. If a second
  // stats() call on a still-clean actor actually recomposed, composeStats'
  // zero()/derive() would overwrite it back to a real number — so it
  // surviving proves no recomposition ran, not just that the object wasn't
  // reallocated.
  s1.strength = -999999;

  const s2 = actors.stats(actor);
  assert.equal(s2, s1, 'a clean actor must return the exact same StatBlock reference');
  assert.equal(s2.strength, -999999, 'a clean actor must do no recomposition work');
});

// ---------------------------------------------------------------------------
// 2. setSourceLayer(actor, 'equipment', partial) is visible in the next
//    stats(actor) — the StatBlock actually changes.
// ---------------------------------------------------------------------------

test("actors.setSourceLayer('equipment', ...) changes the next actors.stats() result", async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  // `lifeSteal` (CAPS lo=0) rather than a primary attribute: primary
  // attributes clamp to a floor of 1 (stats.js CAPS), which would make a
  // baseline-plus-delta comparison flaky for reasons unrelated to this
  // ticket's wiring.
  const before = actors.stats(actor).lifeSteal;
  assert.equal(before, 0, 'a bare monster has no lifeSteal contribution yet');

  actors.setSourceLayer(actor, 'equipment', { lifeSteal: 50 });
  assert.equal(actor.statsDirty, true, 'setSourceLayer must mark the actor dirty');

  const after = actors.stats(actor);
  assert.equal(actor.statsDirty, false, 'the following stats() call must recompose and clear the flag');
  assert.equal(after.lifeSteal, before + 50, 'the equipment layer contribution must land in the composed StatBlock');
});

// ---------------------------------------------------------------------------
// 3. markDirty(actor) sets the flag AND emits `stats:dirty` exactly once.
// ---------------------------------------------------------------------------

test('actors.markDirty(actor) sets statsDirty and emits stats:dirty exactly once', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  actors.stats(actor); // clean it first, so markDirty's own effect is isolated
  assert.equal(actor.statsDirty, false);

  let emitCount = 0;
  let lastPayloadActor = null;
  const handler = (payload) => {
    emitCount++;
    lastPayloadActor = payload.actor;
  };
  ctx.events.on('stats:dirty', handler);

  actors.markDirty(actor);

  assert.equal(actor.statsDirty, true, 'markDirty must set the flag');
  assert.equal(emitCount, 1, 'markDirty must emit stats:dirty exactly once');
  assert.equal(lastPayloadActor, actor, 'the stats:dirty payload must carry { actor }');

  ctx.events.off('stats:dirty', handler);
});

// ---------------------------------------------------------------------------
// 4. setSourceLayer rejects 'base'/'allocated' — the facade must not
//    swallow the pure function's throw.
// ---------------------------------------------------------------------------

test("actors.setSourceLayer rejects 'base' and 'allocated' without swallowing the throw", async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  assert.throws(() => actors.setSourceLayer(actor, 'base', { strength: 1 }));
  assert.throws(() => actors.setSourceLayer(actor, 'allocated', { strength: 1 }));
});

// ---------------------------------------------------------------------------
// 5. Two actors never cross-contaminate — setSourceLayer/markDirty target
//    only the actor passed in.
// ---------------------------------------------------------------------------

test('setSourceLayer and markDirty affect only the targeted actor', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const a = actors.spawn({ kind: 'monster' });
  const b = actors.spawn({ kind: 'monster' });

  actors.stats(a);
  actors.stats(b);

  actors.setSourceLayer(a, 'equipment', { lifeSteal: 30 });
  assert.equal(a.statsDirty, true);
  assert.equal(b.statsDirty, false, 'setSourceLayer on a must not dirty b');

  const bLifeStealBefore = actors.stats(b).lifeSteal;
  const aLifeStealAfter = actors.stats(a).lifeSteal;
  assert.equal(aLifeStealAfter, bLifeStealBefore + 30);
});
