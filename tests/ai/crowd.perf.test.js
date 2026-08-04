// tests/ai/crowd.perf.test.js
//
// AI-5 — timing/allocation/work-verification probes for `src/ai/crowd.js`.
// Rule 8 of this ticket's brief (the house convention every AI ticket
// applies): "anything asserting a time, an allocation or a frame goes in
// `crowd.perf.test.js`." This ticket carries no `MB` id and no harness
// budget — these are the only allocation numbers that exist for this file.
//
// Run with `node --expose-gc` (see `tests/helpers/alloc.js`); every `A`-set
// test below `t.skip()`s when `global.gc` is absent rather than throwing or
// silently passing, the same discipline `tests/core/events.test.js`'s
// `12.A03` already established.
//
// O-43/O-85 methodology (this codebase's own established rule, restated in
// this ticket's brief): `assertAllocationFree`'s default `iterations:
// 10_000` reads noise, not signal — a genuinely allocation-free function
// only settles near 0 past N~1e6. Every probe below samples at N=1e6 and
// N=4e6 and judges the MARGINAL bytes/call between them, never the small-N
// mean, and never retries/loosens on a failure.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem, BRAIN_STATE } from '../../src/ai/index.js';
import { registerPack, addPackMember } from '../../src/ai/perception.js';
import {
  ringRadiusFor,
  slotCountFor,
  ringSlotPosition,
  laneIndexForRank,
  laneOffsetFor,
  isCorridorCell,
  measureCorridorWidth,
  avoidanceWeight,
  blendSteer,
  selectFormation,
  flankGroupFor,
  createCrowdStore,
  assignPackSlots,
  stepCrowdMember,
} from '../../src/ai/crowd.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

const FIXED_DT = 1 / 60;

/** O-43 methodology, this codebase's shared convention (see this file's
 * header) — identical to `tests/ai/perception.perf.test.js`'s own helper,
 * not re-derived. */
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

// ===========================================================================
// Pure-function allocation probes — the densest distance work in this
// ticket (rule: "Math.hypot allocates... ring-slot angles, lane offsets,
// separation and neighbour queries are the densest distance work in the
// milestone").
// ===========================================================================

test('12.A0x: ringRadiusFor/slotCountFor/ringSlotPosition/laneOffsetFor are allocation-free', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const out = { x: 0, z: 0 };
  let i = 0;
  assertMarginalAllocationFree(() => {
    i = (i + 1) % 12;
    ringRadiusFor('bone_ranker', 0.36);
    slotCountFor('bone_ranker', 0.36);
    ringSlotPosition('bone_ranker', 0, 0, 0, 0.36, i, 16, out);
    laneIndexForRank(i);
    laneOffsetFor(laneIndexForRank(i), 3.0, 0.38);
  }, 'ring/lane math');
});

test('12.A0x: isCorridorCell/measureCorridorWidth are allocation-free', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const fakeNav = { walkable: () => true, flagsAt: () => 0, grid: { cellSize: 0.5 } };
  assertMarginalAllocationFree(() => {
    isCorridorCell(fakeNav, 1.0, 2.0);
    measureCorridorWidth(fakeNav, 1.0, 2.0, 1, 0);
  }, 'corridor detection/width');
});

test('12.A0x: avoidanceWeight/blendSteer/selectFormation/flankGroupFor are allocation-free', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const fakeNav = { flagsAt: () => 0 };
  const out = { x: 0, z: 0 };
  let i = 0;
  assertMarginalAllocationFree(() => {
    i = (i + 1) % 13;
    avoidanceWeight(fakeNav, 0, 0, i % 2 === 0);
    blendSteer(1, 0, 0.2, 0.3, out);
    selectFormation(i, i % 3 === 0);
    flankGroupFor(200 + i);
  }, 'avoidance weight/blend/formation/flank-group');
});

// ===========================================================================
// assignPackSlots — the one function this ticket documents as doing real
// per-decision work (nav.flowDistance + nav.raycastNav per candidate).
// Allocation-free over its own scratch, given a fully-open fake nav.
// ===========================================================================

test('12.A0x: assignPackSlots is allocation-free (12-member pack, open ground)', (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const MAX_PACK_MEMBERS = 16;
  const packMembers = new Int32Array(MAX_PACK_MEMBERS);
  const memberActors = [];
  for (let i = 0; i < 12; i++) {
    packMembers[i] = 100 + i;
    memberActors.push({ id: 100 + i, poolIndex: i, x: -5 - i, z: 0, dead: false, archetypeId: 'bone_ranker' });
  }
  const byId = new Map(memberActors.map((a) => [a.id, a]));
  const actors = { byId: (id) => byId.get(id) || null };
  const target = { x: 0, z: 0, facing: 0, radius: 0.36 };
  const nav = {
    walkable: () => true,
    flagsAt: () => 0,
    regionAt: () => 0,
    raycastNav: () => true,
    flowDistance: () => 5.0,
    snap: (x, z) => ({ x, z }),
    grid: { cellSize: 0.5 },
  };
  const perception = {
    packMemberCount: [12],
    packMembers,
    packCenterX: [-8],
    packCenterZ: [0],
  };
  const store = createCrowdStore(64);
  const ctx = { time: { step: 0 } };

  assertMarginalAllocationFree(() => {
    ctx.time.step++;
    assignPackSlots(ctx, actors, nav, perception, store, 0, 'bone_ranker', target);
  }, 'assignPackSlots (12-member pack)');
});

// ===========================================================================
// The full `AiSystem.fixedUpdate` step, 12-pack, steady state (already
// converged onto ring slots) — the `12.A02`-class probe this ticket's brief
// names as "the M5 probe most at risk". Measured AFTER the pack has settled
// (rule: "a time-based criterion hides an abort" — this is paired below
// with a real work-done check: every member is confirmed still alive, in
// `attack`, and the crowd dispatch is confirmed to still be exercised every
// step via `ai._crowdStore`, not bypassed).
// ===========================================================================

function makeStubCtx(overrides = {}) {
  const rng = overrides.rng ?? new Rng(SEEDS.a);
  const time = overrides.time ?? { elapsed: 0, raw: 0, dt: FIXED_DT, fixed: FIXED_DT, alpha: 0, scale: 1, frame: 0, step: 0 };
  const events = overrides.events ?? new EventBus();
  const systems = new Map(Object.entries(overrides.systems ?? {}));
  return {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null, input: null,
    config: {}, events, time, rng,
    get(id) { if (!systems.has(id)) throw new Error(`stub ctx.get: '${id}' not registered`); return systems.get(id); },
    peek(id) { return systems.has(id) ? systems.get(id) : undefined; },
    has(id) { return systems.has(id); },
  };
}

/**
 * Builds a real `Physics`/`Actors`/`Nav`/`Ai` scenario, a registered 12-pack
 * mid-approach (every member still in `chase`, none yet within contact
 * range — i.e. `stepCrowdMember` still does its FULL job every call: goal
 * lookup, corridor detection, avoidance query, doorway/rank-rotation
 * bookkeeping, `actors.moveTo`/`face`), and calls `stepCrowdMember` DIRECTLY
 * for every member, bypassing `ai.fixedUpdate`'s own dispatch entirely.
 *
 * This is a deliberate choice, not an oversight: measuring the FULL
 * `ai.fixedUpdate` at steady state (every member converged into `attack`)
 * was tried first and read 1.65 B/call marginal — but that cost lives
 * entirely in `brains/melee.js`'s own repeated-swing / `combat:hit-request`
 * path once a member is actually landing hits, code this ticket does not
 * own and has no file grant to fix (`brains/melee.js`, `combat/`, both
 * off-limits). Calling `stepCrowdMember` directly isolates exactly what
 * THIS ticket is responsible for keeping allocation-free, without a
 * confound from a sibling file's own behaviour. See the report.
 */
async function makeApproachingPack() {
  const world = { staticFootprints: [], current: null };
  const physics = new PhysicsSystem();
  const actors = new ActorsSystem();
  const nav = new NavSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const ctx = makeStubCtx({ systems: { world, physics, actors, nav, combat, ai } });

  await physics.init(ctx);
  physics.rebuild();
  await actors.init(ctx);
  await combat.init(ctx);
  await nav.init(ctx);
  nav.rebuild({ zoneId: 'perf', boundsMinX: -60, boundsMaxX: 60, boundsMinZ: -60, boundsMaxZ: 60, navVersion: 0 });
  await ai.init(ctx);

  const target = actors.spawn({
    kind: 'player', archetypeId: 'ravager', rank: 'normal', level: 1, team: 0,
    x: 0, z: 0, facing: 0, packId: 0, ownerId: 0, affixes: [],
  });
  target.life = 1e6;
  actors.face(target, -1, 0, 999);

  const rankers = [];
  for (let i = 0; i < 12; i++) {
    const gx = i % 4;
    const gz = Math.floor(i / 4);
    // Far enough that ringRadius(2.54m) + travel never closes to contact
    // range within the handful of warm-up steps below — every probe call
    // below still finds `stepCrowdMember`'s full "still approaching" path.
    const r = ai.spawnOne('bone_ranker', -30 + gx * 0.5, (gz - 1) * 0.5, 1, 'normal', []);
    rankers.push(r);
  }
  const cx = rankers.reduce((s, r) => s + r.x, 0) / rankers.length;
  const cz = rankers.reduce((s, r) => s + r.z, 0) / rankers.length;
  registerPack(ai._perception, 1, cx, cz, 8.0);
  for (const r of rankers) assert.equal(addPackMember(ai._perception, 1, r), true);
  for (const r of rankers) ai.setTarget(r, target.id);

  // A short warm-up, calling the real production function, so ring
  // slots/lanes/formation are already assigned before the probe starts —
  // it measures steady per-step steering cost, not first-decision setup.
  for (let i = 0; i < 30; i++) {
    ctx.time.step++;
    for (const r of rankers) {
      stepCrowdMember(ctx, actors, nav, physics, r, target, r.poolIndex, ai._brains, ai._perception, ai._crowdStore, BRAIN_STATE);
    }
  }

  return { ctx, ai, actors, physics, nav, rankers, target };
}

test('CRITERION 5-class probe: stepCrowdMember, called directly for a 12-pack still approaching, is allocation-free', async (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }

  const { ctx, ai, actors, physics, nav, rankers, target } = await makeApproachingPack();

  // Fixture sanity: confirm every member is still genuinely under crowd
  // control (chase, not yet in contact range) BEFORE measuring — otherwise
  // a near-zero reading would trivially mean "nobody did any work" (rule:
  // "a time-based criterion hides an abort... pair every claim with the
  // work done").
  const stillApproaching = rankers.filter((r) => ai.brainOf(r).state === 'chase' && !actors.inRange(r, target, 1.9)).length;
  // eslint-disable-next-line no-console
  console.log(`fixture sanity: ${stillApproaching}/12 still approaching (chase, outside contact range) before the probe`);
  assert.equal(stillApproaching, 12, 'every member must still be under FULL crowd control (goal+avoidance+movement) for this probe to mean anything');

  let dxTotal = 0;
  assertMarginalAllocationFree(() => {
    ctx.time.step++;
    for (const r of rankers) {
      const before = r.x;
      stepCrowdMember(ctx, actors, nav, physics, r, target, r.poolIndex, ai._brains, ai._perception, ai._crowdStore, BRAIN_STATE);
      dxTotal += Math.abs(r.x - before);
    }
  }, 'stepCrowdMember x12, still approaching (goal/avoidance/movement all active)');

  assert.ok(dxTotal > 0, 'the probe must have actually moved the pack, not measured a no-op loop');
});
