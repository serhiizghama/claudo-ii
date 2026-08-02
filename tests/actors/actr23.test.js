// tests/actors/actr23.test.js
//
// ACTR-23/D-56/O-57 acceptance tests: the eight remaining `02-api-
// contracts.md` §7 rows across "Action state machine" (`cancelAction`,
// `actionProgress`) and "Status effects" (`removeStatus`, `hasStatus`,
// `statusStacks`, `statusRemaining`, `clearStatuses`, `expireBySource`) —
// wired as thin forwards on `ActorsSystem` over the already-accepted pure
// engines in `src/actors/action.js` and `src/actors/status.js`. `node:test`
// + `node:assert/strict` only, matching every sibling file in this
// directory.
//
// Scope: the wiring only. Each pure function's own numeric behaviour
// (stacking rules, the state adjacency table, the 0.75 input-cancel
// threshold) is already gated by `tests/actors/action.test.js` and
// `tests/actors/status.test.js` and is not re-tested here except as much as
// a scenario needs the forwarded method to actually do something real.
//
// Every test below reaches the eight methods via a live, registry-resolved
// `ctx.get('actors')` — never `new ActorsSystem()` used directly as the
// surface under test — the same discipline `tests/actors/actr22.test.js`
// established for the previous instalment of this same debt (O-57).
// `advanceAction` (action.js's own internal, non-`02`-row engine function)
// is imported directly here only to drive ticks forward in a scenario —
// it is not part of this ticket's forward surface (see the report).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { advanceAction } from '../../src/actors/action.js';
import { STATUS } from '../../src/actors/status.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// A real registry-resolved ctx — same wiring src/main.js does.
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
// 1. cancelAction — legal reasons succeed and mutate state; illegal ones
//    fail safe with zero mutation.
// ---------------------------------------------------------------------------

test('actors.cancelAction(actor, reason) refuses an unrecognised reason, no mutation', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  const seqBefore = actor.actionSeq;

  assert.equal(actors.cancelAction(actor, 'not-a-real-reason'), false);
  assert.equal(actor.actionSeq, seqBefore, 'an invalid reason must not bump actionSeq');
});

test("actors.cancelAction(actor, 'hitstun') cancels an in-progress action from windup", async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  actors.setState(actor, 'idle');
  actors.beginAction(actor, 'melee', 1, 1, 1);
  assert.equal(actor.state, 'windup');

  assert.equal(actors.cancelAction(actor, 'hitstun'), true);
  assert.equal(actor.state, 'hitstun');
  assert.equal(actor.actionId, null, 'a successful cancel clears the in-progress actionId');
});

test("actors.cancelAction(actor, 'interrupt') is refused during windup (08 §6.6)", async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  actors.setState(actor, 'idle');
  actors.beginAction(actor, 'melee', 1, 1, 1);

  assert.equal(actors.cancelAction(actor, 'interrupt'), false, 'interrupt must be refused during windup');
  assert.equal(actor.state, 'windup', 'the refused cancel must not mutate state');
});

// ---------------------------------------------------------------------------
// 2. actionProgress — 0..1 across the whole action, 0 when idle.
// ---------------------------------------------------------------------------

test('actors.actionProgress(actor) reads 0 with no action in progress, rises monotonically once one starts', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  actors.setState(actor, 'idle');

  assert.equal(actors.actionProgress(actor), 0);

  actors.beginAction(actor, 'melee', 1, 1, 1); // 60/60/60 ticks at 100% speed, total 180
  assert.equal(actors.actionProgress(actor), 0);

  for (let i = 0; i < 90; i++) advanceAction(actor);
  const half = actors.actionProgress(actor);
  assert.ok(Math.abs(half - 0.5) < 1e-9, `expected ~0.5, got ${half}`);

  for (let i = 0; i < 90; i++) advanceAction(actor);
  assert.equal(actors.actionProgress(actor), 0, 'progress resets to 0 once the action completes naturally');
});

// ---------------------------------------------------------------------------
// 3. Status effects — applyStatus (already forwarded) plus the six rows
//    this ticket adds.
// ---------------------------------------------------------------------------

test('actors.hasStatus / statusStacks / statusRemaining reflect an applied status', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  assert.equal(actors.hasStatus(actor, STATUS.slowed), false);
  assert.equal(actors.statusStacks(actor, STATUS.slowed), 0);
  assert.equal(actors.statusRemaining(actor, STATUS.slowed, 0), 0);

  actors.applyStatus(actor, { status: STATUS.slowed, step: 0, sourceId: 7, magnitude: 20, duration: 5 });

  assert.equal(actors.hasStatus(actor, STATUS.slowed), true);
  assert.equal(actors.statusStacks(actor, STATUS.slowed), 1);
  const remaining = actors.statusRemaining(actor, STATUS.slowed, 0);
  assert.ok(Math.abs(remaining - 5) < 1e-9, `expected 5s remaining at step 0, got ${remaining}`);

  const remainingLater = actors.statusRemaining(actor, STATUS.slowed, 60); // 1s later
  assert.ok(Math.abs(remainingLater - 4) < 1e-9, `expected 4s remaining 60 steps later, got ${remainingLater}`);
});

test('actors.removeStatus(actor, status) removes every instance and returns the count', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  actors.applyStatus(actor, { status: STATUS.burning, step: 0, sourceId: 1, magnitude: 10, duration: 5 });
  actors.applyStatus(actor, { status: STATUS.burning, step: 0, sourceId: 2, magnitude: 10, duration: 5 });
  assert.equal(actors.statusStacks(actor, STATUS.burning), 2, 'burning is independent-stack, two sources = two instances');

  const removed = actors.removeStatus(actor, STATUS.burning);
  assert.equal(removed, 2);
  assert.equal(actors.hasStatus(actor, STATUS.burning), false);
  assert.equal(actors.removeStatus(actor, STATUS.burning), 0, 'removing an absent status returns 0');
});

test('actors.clearStatuses(actor, onlyHarmful) clears every held status', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  actors.applyStatus(actor, { status: STATUS.chilled, step: 0, sourceId: 1, magnitude: 5, duration: 5 });
  actors.applyStatus(actor, { status: STATUS.cursed, step: 0, sourceId: 1, magnitude: 5, duration: 5 });
  assert.equal(actors.hasStatus(actor, STATUS.chilled), true);
  assert.equal(actors.hasStatus(actor, STATUS.cursed), true);

  actors.clearStatuses(actor, true);
  assert.equal(actors.hasStatus(actor, STATUS.chilled), false);
  assert.equal(actors.hasStatus(actor, STATUS.cursed), false);
});

test('actors.expireBySource(actor, sourceId) removes only instances from that source', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  actors.applyStatus(actor, { status: STATUS.burning, step: 0, sourceId: 11, magnitude: 10, duration: 5 });
  actors.applyStatus(actor, { status: STATUS.burning, step: 0, sourceId: 22, magnitude: 10, duration: 5 });
  assert.equal(actors.statusStacks(actor, STATUS.burning), 2);

  const removed = actors.expireBySource(actor, 11);
  assert.equal(removed, 1);
  assert.equal(actors.statusStacks(actor, STATUS.burning), 1, 'the sourceId=22 instance must survive');
});

// ---------------------------------------------------------------------------
// 4. Two actors never cross-contaminate.
// ---------------------------------------------------------------------------

test('the eight forwards affect only the targeted actor', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const a = actors.spawn({ kind: 'monster' });
  const b = actors.spawn({ kind: 'monster' });

  actors.applyStatus(a, { status: STATUS.slowed, step: 0, sourceId: 1, magnitude: 20, duration: 5 });
  actors.setState(a, 'idle');
  actors.beginAction(a, 'melee', 1, 1, 1);

  assert.equal(actors.hasStatus(b, STATUS.slowed), false, 'applyStatus on a must not touch b');
  assert.equal(actors.actionProgress(b), 0, 'beginAction on a must not touch b');
  assert.equal(actors.cancelAction(b, 'hitstun'), false, 'b has nothing to cancel and is not mid-action');
});
