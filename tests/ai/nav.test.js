// tests/ai/nav.test.js
//
// AI-4 acceptance tests for `src/ai/nav.js` — the ring scheduler (§9.2), the
// flow-field-vs-A* default and hard demotion (§9.3), the flow-field rebuild
// cadence (§9.1), and `nav:rebuilt` invalidation with the `i % 45` spread
// (§9.4). `node:test` + `node:assert/strict` only.
//
// Layers, cheapest/most isolated first (same shape `tests/ai/perception.test.js`
// already established for this codebase):
//   1. `needsPath`'s four OR-conditions plus the pending-request guard this
//      ticket's own file header explains, against hand-built fakes.
//   2. The ring scheduler's budget/fairness/refusal behaviour.
//   3. §9.3's flow-field default, including the >40 hard demotion (criterion
//      3 — every active brain steered, nobody queued out).
//   4. `nav:rebuilt`'s `i % 45` spread (criterion 4, first half).
//   5. `cachedFlowDistance`'s generation-stamp invalidation (criterion 4,
//      second half — "flowVersion invalidates a cached distance").
//
// The full 25-monster MB12/MB13 simulation (real `NavSystem`/`ActorsSystem`,
// timing, allocation) lives in `tests/ai/nav.perf.test.js` per this ticket's
// own rule 9 ("Timing/allocation asserts in *.perf.test.js").
//
// Per this ticket's rule 11: no assertion here encodes "only these
// states/files exist" — every check is on real, exercised behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BRAIN_STATE } from '../../src/ai/index.js';
import {
  createNavBrainStore,
  stepNavScheduler,
  onNavRebuilt,
  cachedFlowDistance,
  HARD_DEMOTION_ACTIVE_THRESHOLD,
  FLOW_FIELD_MIN_ACTIVE,
  TIMED_DEMOTION_STEPS,
  REPATH_BASE_STEPS,
  REPATH_JITTER_MOD,
  GOAL_MOVED_THRESHOLD_SQ,
  NAV_REBUILT_SPREAD_MOD,
  RING_GRANT_LIMIT,
} from '../../src/ai/nav.js';

const MAX_BRAINS = 64;

// ---------------------------------------------------------------------------
// Fakes — a fake nav grants/refuses on command, a fake actors/brains bag
// mirrors AiSystem's own parallel-array shape.
// ---------------------------------------------------------------------------

/** @param {{refuseAfter?:number}} [opts] refuseAfter: how many accepted
 *   requests before `requestPath` starts returning 0 (budget-full). */
function makeFakeNav(opts = {}) {
  const { refuseAfter = Infinity } = opts;
  let nextId = 1;
  let accepted = 0;
  const flowDist = new Map(); // ownerId -> number, defaults to Infinity
  const solved = new Set(); // ids considered SOLVED once polled
  let buildCalls = 0;
  return {
    version: 1,
    flowVersion: 1,
    requestCalls: [],
    get buildCalls() { return buildCalls; },
    requestPath(fromX, fromZ, toX, toZ, ownerId) {
      this.requestCalls.push({ fromX, fromZ, toX, toZ, ownerId });
      if (accepted >= refuseAfter) return 0;
      accepted++;
      const id = nextId++;
      solved.add(id);
      return id;
    },
    pollPath(id) {
      return solved.has(id) ? { id, poolIndex: id } : null;
    },
    releasePath() {},
    buildFlowField() { buildCalls++; },
    flowDistance(x, z) {
      return flowDist.has(`${x},${z}`) ? flowDist.get(`${x},${z}`) : Infinity;
    },
    setFlowDistanceAt(x, z, d) { flowDist.set(`${x},${z}`, d); },
  };
}

function makeBrainsBag(n) {
  return {
    active: new Uint8Array(n).fill(1),
    state: new Int32Array(n),
    targetId: new Int32Array(n),
  };
}

function makePerceptionBag(n) {
  return {
    packSlot: new Int32Array(n).fill(-1),
    packCenterX: new Float32Array(n),
    packCenterZ: new Float32Array(n),
  };
}

function makeCtx(step) {
  return { time: { step } };
}

/** @param {number} n how many actor+brain slots to build.
 * @param {{player?:object}} [opts] */
function makeActorsFixture(n, opts = {}) {
  const live = [];
  for (let i = 0; i < n; i++) {
    live.push({ id: i + 100, poolIndex: i, x: 0, z: 0, dead: false });
  }
  const byId = new Map(live.map((a) => [a.id, a]));
  const player = opts.player ?? { id: 1, poolIndex: -1, x: 0, z: 0, dead: false };
  byId.set(player.id, player);
  return {
    all: live,
    player,
    byId(id) { return byId.get(id) ?? null; },
  };
}

// ===========================================================================
// Layer 1 — needsPath's OR-conditions and the pending-request guard
// ===========================================================================

test('needsPath: a brain with no path yet requests one; a solved, fresh, on-schedule path does not', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(4);
  const perception = makePerceptionBag(4);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  actors.all[0].x = 20; actors.all[0].z = 0; // outside the flow-field window fake (Infinity by default)
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;

  const ctx = makeCtx(1000);
  stepNavScheduler(ctx, actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.requestCalls.length, 1, 'a brain with no path yet must request one');
  assert.equal(store.pathRequests, 1);
  assert.equal(store.pendingRequestId[0], 1);

  // Poll it solved next step; a fresh, on-schedule, same-goal path must not re-request.
  const ctx2 = makeCtx(1001);
  stepNavScheduler(ctx2, actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(store.hasPath[0], 1, 'the poll must have confirmed SOLVED');
  assert.equal(store.solved, 1);
  assert.equal(nav.requestCalls.length, 1, 'a just-solved, still-fresh path must not trigger a second request');
});

test('needsPath: a stale nav.version forces a repath', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(2);
  const perception = makePerceptionBag(2);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 20;

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  stepNavScheduler(makeCtx(2), actors, nav, brains, perception, store, BRAIN_STATE, 1); // confirms solved
  assert.equal(store.hasPath[0], 1);
  const requestsBefore = nav.requestCalls.length;

  nav.version = 2; // a rebuild happened
  stepNavScheduler(makeCtx(3), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.requestCalls.length, requestsBefore + 1, 'pathVersion !== nav.version must force a fresh request');
});

test('needsPath: the goal moving > 2.5 m forces a repath; a smaller move does not', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(2);
  const perception = makePerceptionBag(2);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 20;

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  stepNavScheduler(makeCtx(2), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(store.hasPath[0], 1);
  let requestsBefore = nav.requestCalls.length;

  actors.player.x = 1.0; // moved 1.0 m — under the 2.5 m threshold
  stepNavScheduler(makeCtx(3), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.requestCalls.length, requestsBefore, 'a sub-2.5 m goal move must not force a repath');

  actors.player.x = 4.0; // now 4.0 m from the path's original goal (0,0) — over threshold
  assert.ok(4.0 * 4.0 > GOAL_MOVED_THRESHOLD_SQ);
  stepNavScheduler(makeCtx(4), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.requestCalls.length, requestsBefore + 1, 'a > 2.5 m goal move must force a repath');
});

test('needsPath: an in-flight (pending) request is never duplicated within the same step window', () => {
  const nav = makeFakeNav();
  nav.pollPath = () => null; // never resolves — simulate a still-pending solve
  const brains = makeBrainsBag(2);
  const perception = makePerceptionBag(2);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 20;

  stepNavScheduler(makeCtx(100), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.requestCalls.length, 1);
  // A few more steps, still pending — must not re-request.
  stepNavScheduler(makeCtx(101), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  stepNavScheduler(makeCtx(105), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.requestCalls.length, 1, 'a request still pending (never polled solved) must not be duplicated');
});

// ===========================================================================
// Layer 2 — the ring scheduler: budget, fairness, refusal
// ===========================================================================

test('ring scheduler: grants at most RING_GRANT_LIMIT (4) requests per step even when nav never refuses', () => {
  const nav = makeFakeNav(); // never refuses (refuseAfter: Infinity)
  const N = 10;
  const brains = makeBrainsBag(N);
  const perception = makePerceptionBag(N);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(N);
  for (let i = 0; i < N; i++) {
    brains.state[i] = BRAIN_STATE.chase;
    brains.targetId[i] = actors.player.id;
    actors.all[i].x = 20 + i; // each a distinct, off-window goal-less target position
  }

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, N);

  let granted = 0;
  for (let i = 0; i < N; i++) if (store.pendingRequestId[i] !== 0) granted++;
  assert.equal(granted, RING_GRANT_LIMIT, `exactly ${RING_GRANT_LIMIT} of ${N} candidates must be granted this step`);
  assert.equal(store.pathRequests, RING_GRANT_LIMIT, 'the scheduler must stop OFFERING once its own grant cap is hit — no 5th call at all');
  assert.equal(store.pathRefusals, 0, 'nav never refused, so this run must show zero ring refusals');
});

test('ring scheduler: a genuine nav budget-full refusal (id === 0) demotes that brain and stops offering for the step', () => {
  const nav = makeFakeNav({ refuseAfter: RING_GRANT_LIMIT - 1 }); // the 4th attempt this step is refused
  const N = 10;
  const brains = makeBrainsBag(N);
  const perception = makePerceptionBag(N);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(N);
  for (let i = 0; i < N; i++) {
    brains.state[i] = BRAIN_STATE.chase;
    brains.targetId[i] = actors.player.id;
    actors.all[i].x = 20 + i;
  }

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, N);

  let granted = 0;
  for (let i = 0; i < N; i++) if (store.pendingRequestId[i] !== 0) granted++;
  assert.equal(granted, RING_GRANT_LIMIT - 1, 'one fewer grant than the cap, since the next attempt was genuinely refused');
  assert.equal(store.pathRequests, RING_GRANT_LIMIT, `${RING_GRANT_LIMIT - 1} grants plus the one refused attempt`);
  assert.equal(store.pathRefusals, 1, 'exactly one ring-budget refusal this step');

  // The refused brain is demoted to the flow field for TIMED_DEMOTION_STEPS.
  let refusedIdx = -1;
  for (let i = 0; i < N; i++) {
    if (store.pendingRequestId[i] === 0 && store.useFlowField[i] === 1) { refusedIdx = i; break; }
  }
  assert.ok(refusedIdx >= 0, 'the refused brain must be flagged useFlowField');
  assert.equal(store.demotedUntilStep[refusedIdx], 1 + TIMED_DEMOTION_STEPS);
});

test('ring scheduler: fairness — repathCursor advances so a later step offers the brains skipped by an earlier refusal', () => {
  const nav = makeFakeNav({ refuseAfter: 2 });
  const N = 6;
  const brains = makeBrainsBag(N);
  const perception = makePerceptionBag(N);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(N);
  for (let i = 0; i < N; i++) {
    brains.state[i] = BRAIN_STATE.chase;
    brains.targetId[i] = actors.player.id;
    actors.all[i].x = 20 + i;
  }

  const cursorStart = store.repathCursor;
  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, N);
  assert.notEqual(store.repathCursor, cursorStart, 'the cursor must advance past the last brain it considered');
  assert.ok(store.pathRefusals >= 1, 'test setup: a refusal must have actually occurred this step');
});

test('06 §9.2 verbatim: repathAtStep on a grant is now + 45 + (actorId % 9)', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(1);
  const perception = makePerceptionBag(1);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  actors.all[0].id = 137; // actorId % 9 = 2
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 20;

  stepNavScheduler(makeCtx(500), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(store.repathAtStep[0], 500 + REPATH_BASE_STEPS + (137 % REPATH_JITTER_MOD));
});

// ===========================================================================
// Layer 3 — §9.3's flow-field default and the >40 hard demotion
// ===========================================================================

test('06 §9.3: a chase brain targeting the player with a finite flowDistance and activeCount >= 8 uses the flow field, not A*', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(1);
  const perception = makePerceptionBag(1);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 5;
  nav.setFlowDistanceAt(5, 0, 12.5); // finite

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, FLOW_FIELD_MIN_ACTIVE);
  assert.equal(store.useFlowField[0], 1, 'finite flowDistance + activeCount >= 8 + target=player -> flow field');
  assert.equal(nav.requestCalls.length, 0, 'a flow-field-eligible brain must never call requestPath');
  assert.equal(store.flowUsers, 1);
});

test('06 §9.3 table: flowDistance = Infinity (off-window/different region) requires A* regardless of activeCount', () => {
  const nav = makeFakeNav(); // flowDistance defaults to Infinity for any (x,z) not seeded
  const brains = makeBrainsBag(1);
  const perception = makePerceptionBag(1);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 50; // never seeded -> Infinity

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, FLOW_FIELD_MIN_ACTIVE);
  assert.equal(store.useFlowField[0], 0);
  assert.equal(nav.requestCalls.length, 1, 'an unreachable-via-field goal must fall back to a real A* request');
});

test('06 §9.3 table: activeCount < 8 requires A* even with a finite flowDistance ("a small fight gets real paths")', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(1);
  const perception = makePerceptionBag(1);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.chase;
  brains.targetId[0] = actors.player.id;
  actors.all[0].x = 5;
  nav.setFlowDistanceAt(5, 0, 3.0);

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, FLOW_FIELD_MIN_ACTIVE - 1);
  assert.equal(store.useFlowField[0], 0);
  assert.equal(nav.requestCalls.length, 1);
});

test('06 §9.3 table: reposition (leash) always requires A* — its goal is the pack centre, never the player', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(1);
  const perception = makePerceptionBag(1);
  perception.packSlot[0] = 0;
  perception.packCenterX[0] = -10;
  perception.packCenterZ[0] = -10;
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);
  brains.state[0] = BRAIN_STATE.reposition;
  actors.all[0].x = 5;
  nav.setFlowDistanceAt(5, 0, 1.0); // finite, but irrelevant — reposition's goal is not the player

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, 25);
  assert.equal(store.useFlowField[0], 0, 'reposition must never naturally qualify for the flow field');
  assert.equal(nav.requestCalls.length, 1);
  assert.deepEqual([nav.requestCalls[0].toX, nav.requestCalls[0].toZ], [-10, -10], 'the requested goal must be the pack centre');
});

test('criterion 3 — hard demotion above 40 actives: EVERY active chase brain lands on the flow field, none queued out', () => {
  const nav = makeFakeNav();
  const N = 45; // > HARD_DEMOTION_ACTIVE_THRESHOLD
  assert.ok(N > HARD_DEMOTION_ACTIVE_THRESHOLD);
  const brains = makeBrainsBag(N);
  const perception = makePerceptionBag(N);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(N);
  for (let i = 0; i < N; i++) {
    brains.state[i] = BRAIN_STATE.chase;
    brains.targetId[i] = actors.player.id;
    actors.all[i].x = 50 + i; // deliberately off-window (Infinity) — would REQUIRE A* absent demotion
  }

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, N);

  for (let i = 0; i < N; i++) {
    assert.equal(store.useFlowField[i], 1, `brain ${i} (chase, activeCount=${N}>40) must be on the flow field`);
  }
  assert.equal(store.flowUsers, N, 'every active chase brain counts as a flow user under hard demotion');
  assert.equal(nav.requestCalls.length, 0, 'no chase brain may request A* above the 40-active hard demotion');
});

test('criterion 3 continued: hard demotion does not touch reposition — flee/reposition may still request A* above 40', () => {
  const nav = makeFakeNav();
  const N = HARD_DEMOTION_ACTIVE_THRESHOLD + 1;
  const brains = makeBrainsBag(N);
  const perception = makePerceptionBag(N);
  perception.packSlot[0] = 0;
  perception.packCenterX[0] = 3;
  perception.packCenterZ[0] = 3;
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(N);
  brains.state[0] = BRAIN_STATE.reposition;
  for (let i = 1; i < N; i++) {
    brains.state[i] = BRAIN_STATE.chase;
    brains.targetId[i] = actors.player.id;
  }

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, N);
  assert.equal(store.useFlowField[0], 0, 'reposition must still be eligible for A* above the hard-demotion threshold');
  assert.ok(nav.requestCalls.some((c) => c.ownerId === actors.all[0].id), 'the reposition brain must have actually requested a path');
});

// ===========================================================================
// Layer 4 — nav:rebuilt, the i % 45 spread (06 §9.4)
// ===========================================================================

test('06 §9.4: nav:rebuilt invalidates every active brain once, spreading repathAtStep by poolIndex % 45', () => {
  const N = 50;
  const brains = makeBrainsBag(N);
  brains.state[10] = BRAIN_STATE.dead; // dead brains must be skipped
  brains.active[20] = 0; // inactive slot must be skipped
  const store = createNavBrainStore(MAX_BRAINS);
  // Seed some pre-rebuild state to prove it gets cleared.
  store.hasPath[5] = 1;
  store.pathVersion[5] = 1;
  store.useFlowField[5] = 0;

  const step = 9000;
  const ctx = makeCtx(step);
  onNavRebuilt(ctx, brains, store, BRAIN_STATE, { navVersion: 7 });

  for (let i = 0; i < N; i++) {
    if (i === 10 || i === 20) continue; // dead/inactive — must be untouched
    assert.equal(store.hasPath[i], 0, `brain ${i}: hasPath must be cleared`);
    assert.equal(store.pathVersion[i], 7, `brain ${i}: pathVersion must mirror the new navVersion`);
    assert.equal(store.useFlowField[i], 1, `brain ${i}: must fall back to the flow field immediately`);
    assert.equal(store.repathAtStep[i], step + (i % NAV_REBUILT_SPREAD_MOD), `brain ${i}: repathAtStep must spread by i % 45`);
  }

  // Prove the spread is actually non-degenerate (not every brain landing on
  // the same step) — the whole point of criterion 4's second half.
  const distinctOffsets = new Set();
  for (let i = 0; i < N; i++) if (i !== 10 && i !== 20) distinctOffsets.add(i % NAV_REBUILT_SPREAD_MOD);
  assert.ok(distinctOffsets.size > 1, 'the spread must actually vary across brains, not collapse to one step');

  assert.equal(brains.state[10], BRAIN_STATE.dead, 'a dead brain must be left alone by the rebuild walk');
});

// ===========================================================================
// Layer 5 — cachedFlowDistance: a generation stamp, invalidated by flowVersion
// ===========================================================================

test('criterion 4: flowVersion invalidates a cached distance', () => {
  let calls = 0;
  const nav = {
    flowVersion: 1,
    flowDistance(x, z) { calls++; return x + z; },
  };
  const store = createNavBrainStore(4);

  const a = cachedFlowDistance(nav, store, 0, 100, 5, 5);
  assert.equal(a, 10);
  assert.equal(calls, 1);

  // Same step, same flowVersion -> cache hit, no new call.
  const b = cachedFlowDistance(nav, store, 0, 100, 5, 5);
  assert.equal(b, 10);
  assert.equal(calls, 1, 'same (step, flowVersion) must reuse the cached value, not call nav.flowDistance again');

  // flowVersion changes (a buildFlowField() happened) -> must invalidate, even at the same step.
  nav.flowVersion = 2;
  const c = cachedFlowDistance(nav, store, 0, 100, 5, 5);
  assert.equal(c, 10);
  assert.equal(calls, 2, 'a flowVersion bump must force a fresh nav.flowDistance() read, even within the same step');

  // A later step, same flowVersion -> also invalidated (never serves a value
  // read at a different actor position without re-checking).
  const d = cachedFlowDistance(nav, store, 0, 101, 6, 6);
  assert.equal(d, 12);
  assert.equal(calls, 3);
});

// ===========================================================================
// Layer 6 — the flow-field rebuild cadence (06 §9.1), exercised via stepNavScheduler
// ===========================================================================

test('06 §9.1: the flow field rebuilds on the 12-step cadence, and sooner if the player moved > 2.0 m', () => {
  const nav = makeFakeNav();
  const brains = makeBrainsBag(1);
  const perception = makePerceptionBag(1);
  const store = createNavBrainStore(MAX_BRAINS);
  const actors = makeActorsFixture(1);

  stepNavScheduler(makeCtx(1), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.buildCalls, 1, 'the very first step must build the field (no prior build to compare against)');
  assert.equal(store.lastFieldStep, 1);

  // Steps 2..12 (11 more calls, no player movement) — cadence is "every 12
  // steps", so `step - lastFieldStep` only reaches 12 at step 13.
  for (let s = 2; s <= 12; s++) stepNavScheduler(makeCtx(s), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.buildCalls, 1, 'no rebuild yet — fewer than 12 steps have elapsed since the last one');

  stepNavScheduler(makeCtx(13), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.buildCalls, 2, 'exactly 12 steps elapsed — the cadence rebuild must fire');
  assert.equal(store.lastFieldStep, 13);

  // Well under the 12-step cadence again (2 steps), but the player moved
  // > 2.0 m since the last build — must rebuild early regardless.
  actors.player.x = 3.0;
  stepNavScheduler(makeCtx(15), actors, nav, brains, perception, store, BRAIN_STATE, 1);
  assert.equal(nav.buildCalls, 3, 'a > 2.0 m player move must trigger an early rebuild, ahead of the 12-step cadence');
});
