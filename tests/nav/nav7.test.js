// tests/nav/nav7.test.js
//
// NAV-7 (D-74, a micro-ticket, not in the backlog) — `nav.raycastNav(ax,az,
// bx,bz) => boolean`, `02-api-contracts.md:499`: `Fixed: Y`, `Alloc: no`,
// "grid-space line of walk". `node:test` + `node:assert/strict` only
// (12-testing.md P6). Per O-27/O-39, every assertion here is on real
// behaviour — never on "the method doesn't exist" (rule 11).
//
// This ticket is a pure WIRE-UP, not a new algorithm: `src/nav/smooth.js`'s
// own NAV-3 header built `segmentWalkable` private-but-exported specifically
// so a later `raycastNav` ticket could import it rather than re-derive the
// same line-of-walk rule (the O-32/O-35 defect class already paid for
// twice). `src/nav/index.js`'s new `raycastNav` method is a one-line
// forward: `segmentWalkable(this._grid, ax, az, bx, bz)`. So this file's
// job is not to re-prove the algorithm (nav3.test.js already does that,
// exhaustively, against `segmentWalkable` directly) — it is to prove:
//
//   1. `nav.raycastNav` exists as a real INSTANCE method (not a module
//      export) and behaves correctly through the real subsystem plumbing
//      (real `rebuild()`, real rasterised grid) — never a hand-poked one.
//   2. It agrees with `segmentWalkable` on a large random sample over that
//      real grid (proving the wiring — right grid object, right argument
//      order — not just "the algorithm is right", which nav3 already owns).
//   3. It is allocation-free at O-43/O-23 scale (see nav7.perf.test.js).
//   4. `src/player/move.js`'s `raycastNav` fast path, dark since M1, now
//      actually fires — and demonstrably changes what happens (skips the
//      A* request entirely for a direct, walkable order).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_DT } from '../../src/core/engine.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { segmentWalkable } from '../../src/nav/smooth.js';
import { PathFollower } from '../../src/player/move.js';
import {
  TESTMAP_BOUNDS,
  TESTMAP_FOOTPRINTS,
  TESTMAP_FAR_CORNERS,
} from '../../src/world/testmap.js';
import { makeStubCtx } from '../helpers/actor.js';
import { SEEDS } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// Shared helpers — same "real subsystems, stub ctx, never enterZone()" shape
// tests/nav/nav3.test.js / tests/nav/nav6.test.js / tests/player/plyr2.test.js
// already established.
// ---------------------------------------------------------------------------

function makeStubWorld({ staticFootprints = [], current = null } = {}) {
  return { staticFootprints, current };
}

async function makeNav({ world = makeStubWorld() } = {}) {
  const ctx = makeStubCtx({ systems: { world } });
  const nav = new NavSystem();
  await nav.init(ctx);
  return { nav, ctx, world };
}

function makeZone({ zoneId = 'test_zone', halfX = 10, halfZ = 10 } = {}) {
  return { zoneId, boundsMinX: -halfX, boundsMaxX: halfX, boundsMinZ: -halfZ, boundsMaxZ: halfZ, navVersion: 0 };
}

/** Wires real Physics/Actors/Nav onto one stub ctx against the real,
 * already-adjudicated test map (`tests/player/plyr2.test.js`'s own
 * `makeIntegrationCtx`, trimmed to what this file needs — no `player`/
 * `render` in the loop, since the fast-path demonstration drives
 * `PathFollower` directly, exactly like plyr2's own Layer 3). */
async function makeIntegrationCtx() {
  const world = { staticFootprints: TESTMAP_FOOTPRINTS, current: null };
  const physics = new PhysicsSystem();
  const actors = new ActorsSystem();
  const nav = new NavSystem();

  const ctx = makeStubCtx({
    rng: new Rng(SEEDS.a),
    systems: { world, physics, actors, nav },
  });

  await physics.init(ctx);
  for (const fp of TESTMAP_FOOTPRINTS) physics.addStatic(fp, fp.surface);
  physics.rebuild();

  await actors.init(ctx);

  await nav.init(ctx);
  nav.rebuild({
    zoneId: 'testmap',
    boundsMinX: TESTMAP_BOUNDS.minX,
    boundsMaxX: TESTMAP_BOUNDS.maxX,
    boundsMinZ: TESTMAP_BOUNDS.minZ,
    boundsMaxZ: TESTMAP_BOUNDS.maxZ,
    navVersion: 0,
  });

  return { ctx, physics, actors, nav };
}

// ===========================================================================
// 1. `raycastNav` exists as an instance method and behaves correctly
// ===========================================================================

test('nav.raycastNav is a real instance method (through real rebuild()) and agrees with the ground truth on an open field', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 })); // no footprints -> fully open, one region

  assert.equal(typeof nav.raycastNav, 'function', 'raycastNav must be callable directly on the NavSystem instance');

  // A clean straight line across an open field must read walkable.
  assert.equal(nav.raycastNav(-8, -8, 8, 8), true, 'an open-field diagonal must be a clear line of walk');
  // Off-grid on either end must fail, same convention as walkable()/segmentWalkable.
  assert.equal(nav.raycastNav(-8, -8, 9999, 9999), false, 'an off-grid endpoint must fail');
  assert.equal(nav.raycastNav(-9999, -9999, 0, 0), false, 'an off-grid origin must fail');
});

test('nav.raycastNav correctly rejects a line blocked by a real, rasterised footprint (not a hand-poked grid)', async () => {
  const world = makeStubWorld({
    staticFootprints: [
      Object.freeze({
        id: 0,
        kind: 'box',
        x: 0,
        z: 0,
        y: 0,
        height: 3,
        halfW: 3,
        halfL: 0.5,
        facing: 0,
        blocksNav: true,
        blocksSight: true,
        surface: 'stone',
        destructible: false,
      }),
    ],
  });
  const { nav } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));

  // A wall spanning x in [-3,3], z in [-0.5,0.5] (before dilation) sits
  // squarely across a straight vertical line through the origin.
  assert.equal(nav.raycastNav(0, -8, 0, 8), false, 'a wall dead-centre on the line must block it');
  // The same start/goal pair offset well clear of the wall must be open.
  assert.equal(nav.raycastNav(8, -8, 8, 8), true, 'a parallel line well clear of the wall must stay walkable');
});

// ===========================================================================
// 2. Agreement with `segmentWalkable` — the wiring proof
// ===========================================================================
//
// `nav.raycastNav` IS `segmentWalkable(this._grid, ax, az, bx, bz)` — see
// `src/nav/index.js`'s own NAV-7 addendum. This is not re-testing the
// algorithm (nav3.test.js already exhaustively does that against
// `segmentWalkable` directly); it is proving the WIRING is exactly that
// forward, over a real, cluttered, rasterised grid (the test map: a
// doorway, a pillar, a concave pocket, a diagonal-corner crate pair) and a
// large random sample — the class of bug this checks for is "wrong grid
// object passed", "swapped argument order", "stale grid reference held
// across a rebuild", none of which nav3's own tests (which never go through
// `NavSystem` at all for this specific check) could ever catch.

test('MAIN: nav.raycastNav agrees with segmentWalkable(nav.grid, ...) on 200,000 random pairs over the real, cluttered test map', async () => {
  const { nav } = await makeIntegrationCtx();
  assert.ok(nav.version > 0, 'test setup: must be running against a real rebuilt grid, not the version-0 placeholder');

  const rng = new Rng(SEEDS.b); // this TEST's own seeded generator (rule 3) — never Math.random(), never a subsystem fork
  const N = 200_000;
  const marginX = 2; // sample a little outside TESTMAP_BOUNDS too, to exercise the off-grid path
  const marginZ = 2;

  let trueCount = 0;
  let falseCount = 0;
  let mismatches = 0;
  const mismatchDetails = [];

  for (let i = 0; i < N; i++) {
    const ax = rng.range(TESTMAP_BOUNDS.minX - marginX, TESTMAP_BOUNDS.maxX + marginX);
    const az = rng.range(TESTMAP_BOUNDS.minZ - marginZ, TESTMAP_BOUNDS.maxZ + marginZ);
    const bx = rng.range(TESTMAP_BOUNDS.minX - marginX, TESTMAP_BOUNDS.maxX + marginX);
    const bz = rng.range(TESTMAP_BOUNDS.minZ - marginZ, TESTMAP_BOUNDS.maxZ + marginZ);

    const viaMethod = nav.raycastNav(ax, az, bx, bz);
    const viaDirect = segmentWalkable(nav.grid, ax, az, bx, bz);

    if (viaMethod === viaDirect) {
      if (viaMethod) trueCount++;
      else falseCount++;
    } else {
      mismatches++;
      if (mismatchDetails.length < 10) mismatchDetails.push({ ax, az, bx, bz, viaMethod, viaDirect });
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[NAV-7] agreement sweep: N=${N}, true=${trueCount}, false=${falseCount}, mismatches=${mismatches}` +
      (mismatches > 0 ? `, first mismatches: ${JSON.stringify(mismatchDetails)}` : ''),
  );

  assert.ok(trueCount > 0, 'test setup: the sweep must actually hit some walkable pairs, or this proves nothing');
  assert.ok(falseCount > 0, 'test setup: the sweep must actually hit some blocked/off-grid pairs, or this proves nothing');
  assert.equal(mismatches, 0, `nav.raycastNav must never disagree with segmentWalkable(nav.grid, ...): ${mismatches}/${N} mismatched`);
});

/**
 * Independent-of-`segmentWalkable` ground truth: dense-samples `steps + 1`
 * points along the segment (both endpoints included) against the PUBLIC
 * `nav.walkable(x,z)` — never `nav.grid.flags` directly, and never
 * `segmentWalkable`/`nav.raycastNav` themselves, so it cannot share a bug
 * with either. Not corner-tie-aware (a plain dense sample can straddle a
 * lattice corner without ever landing exactly on it), so this is a coarser
 * check than `segmentWalkable`'s own supercover DDA — good enough to catch
 * "raycastNav says true but the line obviously crosses a blocked region",
 * the actual thing this cross-check exists to catch.
 */
function denseSampleWalkable(nav, ax, az, bx, bz, steps = 400) {
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    if (!nav.walkable(x, z)) return false;
  }
  return true;
}

test('nav.raycastNav cross-checked against an independent dense-sample walkability test (not segmentWalkable) on 2,000 random pairs', async () => {
  const { nav } = await makeIntegrationCtx();
  const rng = new Rng(SEEDS.c);
  const N = 2000;
  let trueCount = 0;
  let falseCount = 0;
  let disagreements = 0;

  for (let i = 0; i < N; i++) {
    const ax = rng.range(TESTMAP_BOUNDS.minX, TESTMAP_BOUNDS.maxX);
    const az = rng.range(TESTMAP_BOUNDS.minZ, TESTMAP_BOUNDS.maxZ);
    const bx = rng.range(TESTMAP_BOUNDS.minX, TESTMAP_BOUNDS.maxX);
    const bz = rng.range(TESTMAP_BOUNDS.minZ, TESTMAP_BOUNDS.maxZ);

    const viaMethod = nav.raycastNav(ax, az, bx, bz);
    const dense = denseSampleWalkable(nav, ax, az, bx, bz);

    if (viaMethod) trueCount++;
    else falseCount++;

    // `raycastNav===true` must imply the dense sample also sees every
    // sampled point walkable (the direction that would matter for a
    // consumer: a false "clear" is the dangerous one). The converse does
    // not have to hold as tightly — a dense sample can, in principle, miss
    // a thin blocked sliver a corner-safe DDA correctly refuses (that is
    // NAV-3's whole "corner-cut" reasoning) — so only this direction is
    // asserted per-pair; both directions are still reported.
    if (viaMethod && !dense) disagreements++;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[NAV-7] independent dense-sample cross-check: N=${N}, raycastNav true=${trueCount}, false=${falseCount}, ` +
      `raycastNav=true-but-dense-sample-blocked=${disagreements}`,
  );

  assert.ok(trueCount > 0 && falseCount > 0, 'test setup: sweep must hit both outcomes');
  assert.equal(disagreements, 0, `raycastNav must never report "walkable" for a line the independent dense sample finds blocked: ${disagreements}/${N}`);
});

test('nav.raycastNav correctly refuses the diagonal-corner-crate seam (ids 10/11) the test map was built to test corner-cutting against', async () => {
  const { nav } = await makeIntegrationCtx();
  // Crate A: x in [4,6], z in [-6,-4]. Crate B: x in [6,8], z in [-4,-2].
  // They touch at exactly (6,-4). A straight line from deep inside crate A's
  // footprint area to deep inside crate B's would, if corner-cutting were
  // legal, thread exactly that single touching point.
  const straightThroughSeam = nav.raycastNav(4.5, -5.5, 7.5, -2.5);
  assert.equal(straightThroughSeam, false, 'a line threading the two crates\' single touching corner must be rejected, not corner-cut');
  // Ground truth via the same file's own independent dense sampler.
  assert.equal(denseSampleWalkable(nav, 4.5, -5.5, 7.5, -2.5), false, 'test setup: the independent dense sampler must also see this line as blocked');
});

// ===========================================================================
// 3. player/move.js's fast path — dark since M1, must now light up
// ===========================================================================
//
// `PathFollower._startTowardDest` (src/player/move.js:390) has read `typeof
// nav.raycastNav === 'function'` since PLYR-2 and never once found it true
// until now. This section proves two things together (rule: "pair a timing
// with a count of work actually done" applies just as much to "did the
// fast path fire" as it does to a clock reading):
//
//   (a) with the REAL nav.raycastNav present, a straight, unobstructed
//       order NEVER calls nav.requestPath at all — the whole A* ring is
//       skipped, `MODE_DIRECT` is entered straight from `beginOrder`.
//   (b) reproducing the PRE-ticket "absent" state (a thin wrapper around
//       the same real nav instance with `raycastNav` omitted — the exact
//       shape `typeof nav.raycastNav === 'function'` sees for any nav that
//       predates this ticket) makes the IDENTICAL order call
//       `nav.requestPath` at least once, for the same start/goal, against
//       the same grid. That contrast is the "lights up" proof: the only
//       variable that changed is whether `raycastNav` exists.
//
// The clear straight-line pair below ((12,9) -> (18,9)) sits in Room B,
// well clear of the pillar (centre (10,5), radius 1.5 + 0.3 m dilation),
// the diagonal crates (both near z in [-6,-2]) and every wall (nearest
// perimeter wall at z=12, more than 2.9 m away) — verified directly below
// via nav.raycastNav itself before it is relied on for the demonstration.

/** Counts calls to `requestPath`/`raycastNav` while forwarding everything
 * else straight to the real `NavSystem` instance. `hideRaycast: true`
 * reproduces the exact `typeof nav.raycastNav === 'function' -> false`
 * state every nav instance was in before this ticket landed. */
function makeCountingNavProxy(nav, { hideRaycast = false } = {}) {
  const counts = { requestPath: 0, raycastNav: 0 };
  const proxy = {
    get version() {
      return nav.version;
    },
    snap: (...a) => nav.snap(...a),
    connected: (...a) => nav.connected(...a),
    requestPath: (...a) => {
      counts.requestPath++;
      return nav.requestPath(...a);
    },
    pollPath: (...a) => nav.pollPath(...a),
    cancelPath: (...a) => nav.cancelPath(...a),
    releasePath: (...a) => nav.releasePath(...a),
    pathNode: (...a) => nav.pathNode(...a),
    pathLength: (...a) => nav.pathLength(...a),
    smooth: (...a) => nav.smooth(...a),
    counts,
  };
  if (!hideRaycast) {
    proxy.raycastNav = (...a) => {
      counts.raycastNav++;
      return nav.raycastNav(...a);
    };
  }
  return proxy;
}

/** Drives a `PathFollower` order to completion against real `nav`/`actors`,
 * stepping both subsystems' `fixedUpdate` every step (there is no real
 * Engine in this harness — same discipline `plyr2.test.js`'s own
 * `runScriptedOrder` uses). `navForFollower` is whatever the follower
 * itself should see (the real instance, or a counting proxy); `realNav` is
 * always stepped for real A* solving regardless of which proxy is used. */
function driveFollowerOrder(ctx, realNav, actors, navForFollower, follower, actor, gx, gz, stepBudget = 2000) {
  const accepted = follower.beginOrder(navForFollower, actor, gx, gz);
  if (!accepted) return { accepted: false, arrived: false, steps: 0 };
  let steps = 0;
  for (; steps < stepBudget; steps++) {
    if (!follower.active) break;
    realNav.fixedUpdate(FIXED_DT, ctx);
    actors.fixedUpdate(FIXED_DT, ctx);
    follower.step(FIXED_DT, navForFollower, actors, actor);
    ctx.time.step++;
  }
  return { accepted: true, arrived: !follower.active, steps };
}

test('WORK CHECK: nav.raycastNav(12,9,18,9) is genuinely clear on the real test map (test setup, not the demonstration itself)', async () => {
  const { nav } = await makeIntegrationCtx();
  assert.equal(nav.raycastNav(12, 9, 18, 9), true, 'test setup: the chosen direct-order pair must actually be a clear line of walk');
  assert.equal(nav.connected(12, 9, 18, 9), true, 'test setup: the pair must also be in the same connected region');
});

test('WORK CHECK: player/move.js fast path lights up — a direct order skips nav.requestPath entirely with real raycastNav present', async () => {
  const { ctx, actors, nav } = await makeIntegrationCtx();
  const actor = actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: 12, z: 9, facing: 0 });

  // Carry the actor out of its spawning window before the order starts, so
  // this test measures the fast path, not the spawn-window guard.
  for (let i = 0; i < 90; i++) {
    actors.fixedUpdate(FIXED_DT, ctx);
    ctx.time.step++;
  }

  const withRaycast = makeCountingNavProxy(nav, { hideRaycast: false });
  const follower = new PathFollower();
  const result = driveFollowerOrder(ctx, nav, actors, withRaycast, follower, actor, 18, 9);

  // eslint-disable-next-line no-console
  console.log(
    `[NAV-7] fast-path lit: arrived=${result.arrived} steps=${result.steps} ` +
      `requestPath calls=${withRaycast.counts.requestPath} raycastNav calls=${withRaycast.counts.raycastNav}`,
  );

  assert.ok(result.arrived, `must arrive at the direct-order destination (took ${result.steps} steps)`);
  assert.ok(withRaycast.counts.raycastNav >= 1, 'the fast-path guard must actually have called nav.raycastNav');
  assert.equal(
    withRaycast.counts.requestPath,
    0,
    `a clear direct order must never call nav.requestPath once the fast path is available; got ${withRaycast.counts.requestPath} call(s)`,
  );
});

test('WORK CHECK: the SAME order, with raycastNav reproduced as absent (the pre-NAV-7 state), DOES call nav.requestPath — the contrast that proves the fast path is what changed', async () => {
  const { ctx, actors, nav } = await makeIntegrationCtx();
  const actor = actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: 12, z: 9, facing: 0 });
  for (let i = 0; i < 90; i++) {
    actors.fixedUpdate(FIXED_DT, ctx);
    ctx.time.step++;
  }

  const withoutRaycast = makeCountingNavProxy(nav, { hideRaycast: true });
  assert.equal(typeof withoutRaycast.raycastNav, 'undefined', 'test setup: this proxy must reproduce the exact pre-ticket "absent" shape');

  const follower = new PathFollower();
  const result = driveFollowerOrder(ctx, nav, actors, withoutRaycast, follower, actor, 18, 9);

  // eslint-disable-next-line no-console
  console.log(
    `[NAV-7] dark-guard contrast: arrived=${result.arrived} steps=${result.steps} ` +
      `requestPath calls=${withoutRaycast.counts.requestPath}`,
  );

  assert.ok(result.arrived, `must still arrive via the ordinary A* path (took ${result.steps} steps)`);
  assert.ok(
    withoutRaycast.counts.requestPath >= 1,
    `without raycastNav (the pre-ticket state), the identical order must fall through to nav.requestPath; got ${withoutRaycast.counts.requestPath} call(s)`,
  );
});
