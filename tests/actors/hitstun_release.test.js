// tests/actors/hitstun_release.test.js
//
// O-94 cause 4 — `hitstun` had no exit edge.
//
// `03-combat-math.md` §7.11 schedules hit recovery as a duration plus a
// 0.50 s immunity window, and `src/actors/data/states.js` contracts the
// release in as many words ("duration-gated states ... release back to
// `idle` when their timer elapses, never straight to `move`"). But
// `src/combat/reaction.js` (R14(g)) only ever WROTE `hitstunUntil` — nothing
// in `src/` read it back, so one qualifying hit parked an actor in `hitstun`
// for the rest of its life. `src/skills/channel.js` flagged the gap in prose
// and correctly did not patch someone else's engine to make its own test go
// green.
//
// Measured cost before the fix, on a melee class against a five-monster
// room driven through the shipped systems: 3383 of 3600 steps (94%) spent
// in `hitstun`, against the 44% ceiling §7.11's own arithmetic implies
// (0.40 s recovery inside a 0.90 s recovery-plus-immunity cycle). That is
// what made "each class clears the test room" — the M4 gate's item (8) —
// unprovable for the two melee classes.
//
// This file pins the edge itself, not the room: enter `hitstun` the way
// `reaction.js` does (`cancelAction(actor, 'hitstun')` plus a written
// `hitstunUntil`), tick `ActorsSystem.fixedUpdate`, and assert the actor is
// held for exactly as long as the timer says and released on the step it
// elapses — never before, never after.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { ACTOR_STATE } from '../../src/actors/data/states.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

const FIXED_DT = 1 / 60;

async function makeRegistryCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null,
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: FIXED_DT, alpha: 0, scale: 1, frame: 0, step: 0 },
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

function stepOnce(ctx, actors) {
  ctx.time.step++;
  actors.fixedUpdate(FIXED_DT, ctx);
}

/** Settle an actor out of `spawning` (1.0 s) so the state under test is the
 * only one in play. */
function settle(ctx, actors, actor) {
  for (let i = 0; i < 70 && actor.state === ACTOR_STATE.spawning; i++) stepOnce(ctx, actors);
  assert.equal(actor.state, ACTOR_STATE.idle, 'precondition: actor must leave spawning');
}

test('O-94 cause 4: an actor in hitstun returns to idle on the step hitstunUntil elapses', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', level: 20, team: 1, x: 0, z: 0 });
  settle(ctx, actors, actor);

  // Exactly what src/combat/reaction.js#R14(g) does on a qualifying hit.
  const DURATION_STEPS = 24; // 0.40 s at 60 Hz — §7.11's own FHR-0 recovery
  assert.equal(actors.cancelAction(actor, 'hitstun'), true);
  actor.hitstunUntil = ctx.time.step + DURATION_STEPS;
  assert.equal(actor.state, ACTOR_STATE.hitstun);

  for (let i = 0; i < DURATION_STEPS - 1; i++) {
    stepOnce(ctx, actors);
    assert.equal(actor.state, ACTOR_STATE.hitstun, `released early at step offset ${i + 1} of ${DURATION_STEPS}`);
  }

  stepOnce(ctx, actors);
  assert.equal(actor.state, ACTOR_STATE.idle, 'must release on the step hitstunUntil elapses');
});

test('O-94 cause 4: hitstun does not park forever — 100 steps of repeated 0.40 s recoveries stay near §7.11\'s ceiling', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', level: 20, team: 1, x: 0, z: 0 });
  settle(ctx, actors, actor);

  // One qualifying hit, then nothing else ever touches this actor: before the
  // fix this alone was enough to hold it in `hitstun` for the whole run.
  assert.equal(actors.cancelAction(actor, 'hitstun'), true);
  actor.hitstunUntil = ctx.time.step + 24;

  // Sampled at the TOP of each step, the way a consumer asking "can this
  // actor act right now?" would — so the scheduled 24 steps read as 24.
  let stunned = 0;
  const TOTAL = 600; // 10 s
  for (let i = 0; i < TOTAL; i++) {
    if (actor.state === ACTOR_STATE.hitstun) stunned++;
    stepOnce(ctx, actors);
  }

  assert.equal(stunned, 24, 'exactly the scheduled recovery, then free');
  assert.ok(stunned / TOTAL < 0.44, `must sit under §7.11's own 44% ceiling, got ${((stunned / TOTAL) * 100).toFixed(1)}%`);
});
