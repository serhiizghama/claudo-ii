// tests/actors/actr21.test.js
//
// ACTR-21/O-67 (D-49) acceptance tests: `ActorsSystem.fixedUpdate` and the
// vessel fill on `spawn()`. `node:test` + `node:assert/strict` only,
// matching every sibling file in this directory.
//
// Scope: the wiring only. `integrateVessels`/`advanceAndEmitHitframe`/
// `expireStatuses` themselves are already gated by their own tickets'
// tests (vessels.test.js, timing.test.js, status.test.js) — this file
// checks that `ActorsSystem.fixedUpdate` actually reaches them, once per
// live actor per step, and that `spawn()` fills the vessels from the
// composed StatBlock without breaking the "freshly spawned actor starts
// dirty" contract `actr15.test.js` already asserts.
//
// Every test reaches the surface under test via a real, registry-resolved
// `ctx.get('actors')` (same pattern `actr15.test.js` uses) — never
// `new ActorsSystem()` used directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem, SPAWNING_STATE_SECONDS } from '../../src/actors/index.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

const H = 1 / 60;
const SPAWN_TICKS = Math.round(SPAWNING_STATE_SECONDS * 60);

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

/** Advances `ctx.time.step` and calls `actors.fixedUpdate` once. */
function tick(ctx, actors) {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
}

// ---------------------------------------------------------------------------
// 1. spawn() fills life/mana from the composed StatBlock; rage/resonance
//    stay at the pool's own 0 default (combat-earned, never free).
// ---------------------------------------------------------------------------

test('spawn() fills life and mana to the composed maxLife/maxMana; rage/resonance stay 0', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0 });

  const stats = actors.stats(actor);
  assert.equal(actor.life, stats.maxLife, 'life must be filled to the composed maxLife');
  assert.equal(actor.mana, stats.maxMana, 'mana must be filled to the composed maxMana');
  assert.equal(actor.rage, 0, 'rage is combat-earned — must not be filled on spawn');
  assert.equal(actor.resonance, 0, 'resonance is combat-earned — must not be filled on spawn');
  assert.ok(actor.life > 0, 'a real class composes a positive maxLife');
});

// ---------------------------------------------------------------------------
// 2. spawn() must not leave the actor clean — "a freshly spawned actor
//    starts dirty" (already asserted by actr15.test.js) must still hold
//    even though spawn() itself reads stats() internally to learn maxLife.
// ---------------------------------------------------------------------------

test('spawn() reads stats() to fill vessels but leaves statsDirty true (does not pre-empt the caller\'s own recompose)', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  assert.equal(actor.statsDirty, true, 'a freshly spawned actor must still read as dirty');

  // Mutate attributes directly, bypassing markDirty — exactly what a test
  // fixture (or a future character-creation flow) does right after spawn
  // (e.g. `tests/items/equipment.test.js` ITMS.E17's own
  // `actor.attributes.strength = 60`, right after `spawn()`).
  actor.attributes.strength = 400; // inside stats.js's CAPS.strength = [1, 600]
  const strength = actors.stats(actor).strength;
  assert.equal(strength, 400, 'the mutated attribute must be visible in the very next stats() read — ' +
    'if spawn() had left statsDirty false, this read would silently return the stale spawn-time snapshot');
});

// ---------------------------------------------------------------------------
// 3. The 'spawning' -> 'idle' transition happens after SPAWNING_STATE_SECONDS
//    of fixedUpdate ticks, never before.
// ---------------------------------------------------------------------------

test("actor.state stays 'spawning' until SPAWNING_STATE_SECONDS has elapsed, then flips to 'idle'", async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  assert.equal(actor.state, 'spawning');

  for (let i = 0; i < SPAWN_TICKS - 1; i++) tick(ctx, actors);
  assert.equal(actor.state, 'spawning', `must still be spawning one tick short of ${SPAWN_TICKS}`);

  tick(ctx, actors);
  assert.equal(actor.state, 'idle', `must be idle at exactly ${SPAWN_TICKS} ticks`);
});

// ---------------------------------------------------------------------------
// 4. Vessel integration is actually reached: life regenerates toward max
//    once damaged, across real fixedUpdate calls (not a direct
//    integrateVessels() call — this is the wiring, not the formula).
// ---------------------------------------------------------------------------

test('fixedUpdate drives real life regeneration toward maxLife across steps', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0 });
  const maxLife = actors.stats(actor).maxLife;

  actor.life = 1; // simulate damage, well below max
  for (let i = 0; i < 300; i++) tick(ctx, actors);

  assert.ok(actor.life > 1, 'life must have regenerated across real fixedUpdate steps');
  assert.ok(actor.life <= maxLife, 'life must never exceed maxLife');
});

// ---------------------------------------------------------------------------
// 5. Action advancement + anim:hitframe: beginAction, then fixedUpdate steps
//    must cross windup -> active and emit anim:hitframe exactly once.
// ---------------------------------------------------------------------------

test('fixedUpdate advances an in-progress action and emits anim:hitframe exactly once entering active', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  // Clear spawning first so the action state machine's own transitions are
  // not entangled with this test's assertions.
  for (let i = 0; i < SPAWN_TICKS; i++) tick(ctx, actors);
  assert.equal(actor.state, 'idle');

  let hitframes = 0;
  const handler = () => { hitframes++; };
  ctx.events.on('anim:hitframe', handler);

  actors.beginAction(actor, 'attack', 0.1, 0.05, 0.1); // short windup/active/recover
  for (let i = 0; i < 60; i++) tick(ctx, actors);

  assert.equal(hitframes, 1, 'anim:hitframe must fire exactly once for the one action');
  ctx.events.off('anim:hitframe', handler);
});

// ---------------------------------------------------------------------------
// 6. Status expiry: an applied status with a short duration is gone (and
//    its statusMask bit cleared) once fixedUpdate has run past its
//    expiresStep.
// ---------------------------------------------------------------------------

test('fixedUpdate expires a timed-out status and clears its statusMask bit', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  for (let i = 0; i < SPAWN_TICKS; i++) tick(ctx, actors);

  const inst = actors.applyStatus(actor, {
    status: 'slowed', step: ctx.time.step, sourceId: 1, magnitude: 30, duration: 0.5,
  });
  assert.ok(inst, 'applyStatus must succeed on a live, idle actor');
  assert.notEqual(actor.statusMask, 0, 'the status bit must be set right after applying');

  for (let i = 0; i < 40; i++) tick(ctx, actors); // 0.5s = 30 ticks, plenty of margin

  assert.equal(actor.statusMask, 0, 'the expired status bit must be cleared');
  assert.equal(actor.statuses.length, 0, 'the expired instance must be removed from the dense list');
});

// ---------------------------------------------------------------------------
// 7. Only live actors are touched: a despawned actor's slot is never
//    driven by a later fixedUpdate call (the dense-list iteration must not
//    reach it).
// ---------------------------------------------------------------------------

test('fixedUpdate only drives live actors — a despawned actor is left alone', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const gone = actors.spawn({ kind: 'monster' });
  const stillLive = actors.spawn({ kind: 'monster' });

  actors.despawn(gone);
  const lifeBefore = gone.life; // zeroed by release(), but read it anyway
  const stateTimeBefore = gone.stateTime;

  for (let i = 0; i < 5; i++) tick(ctx, actors);

  assert.equal(gone.life, lifeBefore, 'a released slot must not be touched by fixedUpdate');
  assert.equal(gone.stateTime, stateTimeBefore, 'a released slot\'s stateTime must not advance');
  assert.ok(stillLive.stateTime > 0, 'the still-live actor must have been advanced');
});

// Zero-allocation is not asserted in this file — D-11 requires a test that
// asserts an allocation to live in a `<thing>.perf.test.js` file so the
// runner isolates it, and this ticket's file list is one new test file.
// Verified with a scratch probe instead (not checked in); see the report
// for the numbers and the fix this ticket made in status.js#expireStatuses
// to get there.
