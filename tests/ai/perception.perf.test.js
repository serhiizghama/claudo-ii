// tests/ai/perception.perf.test.js
//
// AI-3 — timing/allocation/work-verification probes for `src/ai/perception.js`.
// Rule 8 of this ticket's brief: "anything asserting a time, an allocation
// or a frame goes in `perception.perf.test.js`." Rule (M1's lesson,
// restated in the brief): "a time-based criterion hides an abort — pair a
// cost assertion with a criterion on work actually done."
//
// Run with `node --expose-gc` (see `tests/helpers/alloc.js`); every `A`-set
// test below `t.skip()`s when `global.gc` is absent rather than throwing or
// silently passing (same discipline `tests/core/events.test.js`'s `12.A03`
// already established).

import test from 'node:test';
import assert from 'node:assert/strict';

import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem, BRAIN_STATE } from '../../src/ai/index.js';
import {
  createPerceptionStore,
  sees,
  checkLeash,
  processNoiseRing,
  emitNoise,
  registerPack,
  addPackMember,
} from '../../src/ai/perception.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

/** O-43 methodology (this ticket's own rule, `tests/combat/resolve.perf.test.js`'s
 * established precedent): `tests/helpers/alloc.js#assertAllocationFree`'s
 * default `iterations: 10_000` is exactly the noise regime O-43 says is
 * unusable (a genuinely allocation-free method can read tens of bytes/call
 * at N=10k and settle near 0 only past N~1e6). Samples `allocatedBytes`
 * directly at N=1e6 and N=4e6 and judges by the MARGINAL bytes/call between
 * them (never the small-N mean, never a retry loop — O-85: "never retry,
 * never loosen"). */
function assertMarginalAllocationFree(fn, label) {
  const atOne = allocatedBytes(fn, 1_000_000);
  const atFour = allocatedBytes(fn, 4_000_000);
  const totalOne = atOne * 1_000_000;
  const totalFour = atFour * 4_000_000;
  const marginal = (totalFour - totalOne) / (4_000_000 - 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`${label}: N=1e6 ${atOne.toFixed(4)} B/call, N=4e6 ${atFour.toFixed(4)} B/call, marginal ${marginal.toFixed(4)} B/call`);
  assert.ok(marginal < 1, `${label} must allocate < 1 byte/call marginally between N=1e6 and N=4e6 — got ${marginal.toFixed(4)}`);
}

const FIXED_DT = 1 / 60;

function makeCtx() {
  const systems = new Map();
  return {
    config: {},
    events: new EventBus(),
    time: { elapsed: 0, raw: 0, dt: FIXED_DT, fixed: FIXED_DT, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(SEEDS.deterministic),
    get(id) {
      if (!systems.has(id)) throw new Error(`stub ctx.get: '${id}' not registered`);
      return systems.get(id);
    },
    peek(id) { return systems.get(id); },
    has(id) { return systems.has(id); },
    _systems: systems,
  };
}

/** A counting wrapper around `nav.raycastNav` — real `nav.raycastNav` does
 * not exist yet (see perception.js's own header), so this is the one way to
 * measure "raycastNav calls per decision" as the spec literally states it,
 * forward-compatible with the day a real NAV ticket adds the method (this
 * wrapper's shape — a `raycastNav(ax,az,bx,bz) => boolean` function — is
 * exactly what `navLineOfWalk`'s `typeof nav.raycastNav === 'function'`
 * guard picks up automatically). */
function makeCountingNav(realNav) {
  let calls = 0;
  let fieldBuilds = 0;
  let nextReqId = 1;
  return {
    walkable: (x, z) => realNav.walkable(x, z),
    get grid() { return realNav.grid; },
    raycastNav(ax, az, bx, bz) {
      calls++;
      // Delegate to this ticket's own fallback algorithm for a REAL answer
      // (not a stub `true`) — see perception.js's `fallbackLineOfWalk`;
      // reimplemented inline here only because that function is private
      // (not exported) and this wrapper's whole point is counting calls TO
      // the public `raycastNav` surface, not reusing its body.
      const dx = bx - ax, dz = bz - az;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 1e-6) return realNav.walkable(ax, az);
      const step = realNav.grid && realNav.grid.cellSize ? realNav.grid.cellSize * 0.5 : 0.25;
      const n = Math.max(1, Math.ceil(dist / step));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        if (!realNav.walkable(ax + dx * t, az + dz * t)) return false;
      }
      return true;
    },
    get callCount() { return calls; },
    resetCallCount() { calls = 0; },
    // AI-4 — `AiSystem.fixedUpdate` now runs `src/ai/nav.js`'s ring
    // scheduler every step, which is a real, genuine consumer of the rest
    // of the `nav` surface, not just `raycastNav`/`walkable`. This fake grew
    // the methods that surface now calls (`buildFlowField`, `flowDistance`,
    // `flowVersion`, `version`, `requestPath`/`pollPath`/`releasePath`) —
    // `buildFlowField` counts its calls for the same "count work actually
    // done" reason `raycastNav` already does; the rest are honest, simple
    // stand-ins (an always-unreachable flow field, an always-granted,
    // immediately-solved path request) since this test's own subject is
    // perception/dormant-brain behaviour, not pathfinding.
    buildFlowField() { fieldBuilds++; },
    get flowFieldBuildCount() { return fieldBuilds; },
    flowVersion: 1,
    version: 1,
    flowDistance: () => Infinity, // no real window here — matches the honest "unreachable" default
    requestPath: () => nextReqId++, // never refuses
    pollPath: (id) => ({ id }), // resolves immediately as SOLVED
    releasePath() {},
  };
}

/** An open, always-walkable fake nav — no obstacles, so every `sees()` call
 * that clears radius/cone actually reaches the raycastNav call (the case
 * this probe wants to count, not an early-out). */
function makeOpenCountingNav() {
  return makeCountingNav({ walkable: () => true, grid: { cellSize: 0.5 } });
}

test('WORK CHECK: raycastNav is called at most once per decision per brain (25 monsters, dormant, a live player)', async () => {
  const ctx = makeCtx();
  const actors = new ActorsSystem();
  await actors.init(ctx);
  ctx._systems.set('actors', actors);
  const combat = new CombatSystem();
  await combat.init(ctx);
  ctx._systems.set('combat', combat);
  const ai = new AiSystem();
  const nav = makeOpenCountingNav();
  ctx._systems.set('nav', nav);
  await ai.init(ctx);
  ctx._systems.set('ai', ai);

  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 1, team: 0, x: 0, z: 0 });
  assert.ok(player, 'fixture sanity: player spawned');

  const N = 25;
  const rankers = [];
  for (let i = 0; i < N; i++) {
    // Spread widely so most are outside aggroRadius most of the time —
    // realistic mixed dormant/alert population, not a synchronized crowd.
    const r = ai.spawnOne('bone_ranker', (i - N / 2) * 2, (i % 5) * 3, 1, 'normal', []);
    assert.ok(r, `fixture sanity: Ranker ${i} spawned`);
    rankers.push(r);
  }

  const decisionsBefore = ai.stats.decisions;
  nav.resetCallCount();
  const STEPS = 600; // 10 s — several full 30-tick dormant cadences per brain
  let totalRaycastCalls = 0;
  for (let i = 0; i < STEPS; i++) {
    ctx.time.step++;
    ctx.time.frame++;
    nav.resetCallCount();
    ai.fixedUpdate(FIXED_DT, ctx);
    totalRaycastCalls += nav.callCount;
  }
  const decisionsAfter = ai.stats.decisions;
  const decisions = decisionsAfter - decisionsBefore;

  // eslint-disable-next-line no-console
  console.log(
    `\n=== AI-3 raycastNav work check ===\n` +
    `${N} monsters, ${STEPS} steps (${(STEPS / 60).toFixed(1)}s): ${decisions} total decisions, ` +
    `${totalRaycastCalls} total raycastNav calls (avg ${(totalRaycastCalls / STEPS).toFixed(3)}/step vs 06 §4.2's own 4.17/step figure at 25 monsters)\n` +
    `=== end work check ===\n`,
  );

  assert.ok(decisions > 0, 'fixture sanity: real decisions actually ran (a 0-decision pass would hide an abort, not prove the bound — 12-testing.md/this ticket\'s own rule)');
  assert.ok(
    totalRaycastCalls <= decisions,
    `raycastNav must be called AT MOST once per decision per brain — ${totalRaycastCalls} calls over ${decisions} decisions`,
  );
  // AI-4 sanity: the ring scheduler's flow-field cadence must have actually
  // run over this 600-step window (~50 builds expected at 1-in-12), not
  // silently no-op'd — see this file's `buildFlowField` header note above.
  assert.ok(nav.flowFieldBuildCount > 0, 'nav.buildFlowField() must have been called at least once over 600 steps');
});

test('WORK CHECK: a single sees() call performs at most one navLineOfWalk/raycastNav call', () => {
  const nav = makeOpenCountingNav();
  const store = createPerceptionStore(4);
  const self = { x: 0, z: 0, facing: 0, statusMask: 0, archetypeId: 'bone_ranker', poolIndex: 0 };
  const target = { x: 5, z: 0 };
  nav.resetCallCount();
  sees(nav, self, 0, target, store);
  assert.equal(nav.callCount, 1, 'exactly one raycastNav call for a target that clears the radius/cone gates');

  nav.resetCallCount();
  const farTarget = { x: 500, z: 0 }; // outside aggroRadius — the radius early-out must skip raycastNav entirely
  sees(nav, self, 0, farTarget, store);
  assert.equal(nav.callCount, 0, 'a target outside aggroRadius never reaches raycastNav at all — the early-out this ticket\'s brief calls out by name');
});

// ===========================================================================
// Allocation — rule 5/6, "zero allocation per frame", measured the O-43 way
// (see `assertMarginalAllocationFree` above): NOT this repo's
// `tests/helpers/alloc.js#assertAllocationFree` retry loop, whose default
// `iterations: 10_000` is below O-43's own usable floor and whose bounded
// retry (up to 5000 rounds) turns a genuinely non-converging measurement
// into an extremely slow test rather than a fast, honest failure — found
// directly while writing this file (a first draft using it against a real
// 25-monster `AiSystem.fixedUpdate` did not return in over three minutes).
// A full-system, milestone-scale `AiSystem.fixedUpdate` probe at O-43's
// required N (1e6-4e6 calls of a function that does real O(25)-actor work
// per call) is a `12.A02`/MB13-class milestone benchmark in its own right,
// not this ticket's own three functions — left out, flagged here, not
// silently attempted at a resolution too coarse to trust (O-43's own
// warning) or slow enough to risk `npm test`'s runtime.
// ===========================================================================

test('12.Axx: sees() allocation, O-43 methodology (N=1e6, N=4e6)', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const nav = { walkable: () => true, grid: { cellSize: 0.5 } };
  const store = createPerceptionStore(4);
  const self = { x: 0, z: 0, facing: 0.3, statusMask: 0, archetypeId: 'bone_ranker', poolIndex: 0 };
  const target = { x: 10, z: 2 };
  assertMarginalAllocationFree(() => { sees(nav, self, 0, target, store); }, 'sees()');
});

test('12.Axx: checkLeash allocation, O-43 methodology (N=1e6, N=4e6)', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const ctx = { time: { step: 1000 } };
  const store = createPerceptionStore(4);
  const brains = { state: new Int32Array(4), targetId: new Int32Array(4) };
  registerPack(store, 1, 0, 0, 8.0);
  const actor = { x: 1, z: 1, poolIndex: 0, archetypeId: 'bone_ranker', id: 1, lastDamageStep: -1 };
  addPackMember(store, 1, actor);
  brains.state[0] = BRAIN_STATE.chase;
  assertMarginalAllocationFree(() => { checkLeash(ctx, actor, 0, brains, store, BRAIN_STATE); }, 'checkLeash()');
});

test('12.Axx: emitNoise + processNoiseRing allocation, O-43 methodology (N=1e6, N=4e6)', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const store = createPerceptionStore(8);
  const brains = {
    active: new Uint8Array(8).fill(1),
    state: new Int32Array(8).fill(BRAIN_STATE.dormant),
  };
  const live = [];
  for (let i = 0; i < 8; i++) live.push({ x: i, z: 0, poolIndex: i, archetypeId: 'bone_ranker' });
  const actors = { all: live };
  let step = 0;
  const ctx = { time: { get step() { return step; } } };
  assertMarginalAllocationFree(() => {
    step++;
    emitNoise(store, 0, 0, 8.0, step);
    processNoiseRing(ctx, actors, brains, store, BRAIN_STATE);
    for (let i = 0; i < 8; i++) brains.state[i] = BRAIN_STATE.dormant; // reset for the next iteration
  }, 'emitNoise+processNoiseRing()');
});
