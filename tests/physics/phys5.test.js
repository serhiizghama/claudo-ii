// tests/physics/phys5.test.js
//
// PHYS-5 acceptance tests for src/physics/sweep.js and the `sweepProjectile`
// method forwarded through src/physics/index.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// Scope: the swept-circle test itself (exact contact distance against a
// box/cylinder wall, mirroring cast.js's own circleCast checks), mask/
// excludeId filtering (D6), NO_COLLIDE bodies staying visible to the query
// (D4), body hits reporting `surface:'flesh'` (D5), sharing cast.js's own
// 32-deep Hit ring rather than building a second one, zero-allocation
// (12.A01), the O-25 regression this ticket exists to fix (moveBody
// tunnels a big single-step delta through a thin wall; sweepProjectile,
// fed the identical displacement, does not), and this ticket's own
// acceptance criterion: a 30 m/s projectile at 60 Hz never tunnels a 0.2 m
// wall over 10 000 randomised trials. Statics/grid/bodies/moveBody/casts
// themselves are PHYS-1/2/3's own test files — not re-tested here except
// where a scenario needs them as fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsSystem, LAYER, MASK, BODY_FLAG } from '../../src/physics/index.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

/** A minimal `ctx`, matching PHYS-1/2/3/4's own `makeCtx()`. */
function makeCtx() {
  return { events: new EventBus() };
}

async function makePhysics() {
  const ctx = makeCtx();
  const phys = new PhysicsSystem();
  await phys.init(ctx);
  return { phys, ctx };
}

const BODY_HEIGHT = 1.8;

// ---------------------------------------------------------------------------
// Basic swept-circle behaviour against a static wall
// ---------------------------------------------------------------------------

test('sweepProjectile stops the sweep radius short of the wall face, exactly like circleCast', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();

  // (dx,dz) = (10, 0) is the full per-step DISPLACEMENT, not a pre-scaled
  // direction — see sweep.js's header. Its magnitude (10) is the distance
  // swept, matching a maxDist=10 circleCast.
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.3, MASK.WORLD, 0);
  const circ = phys.circleCast(0, 0, 1, 0, 0.3, 10, MASK.WORLD);
  assert.equal(hit.hit, true);
  assert.deepEqual(hit, circ, 'a sweepProjectile(x,z,10,0,...) must agree exactly with circleCast(x,z,1,0,...,10,...)');
});

test('sweepProjectile with radius 0 is an exact ray, matching rayCast', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0, MASK.WORLD, 0);
  const ray = phys.rayCast(0, 0, 1, 0, 10, MASK.WORLD);
  assert.deepEqual(hit, ray);
});

test('sweepProjectile against a cylinder is exact (circle vs circle, radii sum)', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'cylinder', x: 5, z: 0, radius: 0.8 }, 'dirt');
  phys.rebuild();
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.3, MASK.WORLD, 0);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.distance - 3.9) < 1e-9, `expected 3.9, got ${hit.distance}`);
  assert.equal(hit.surface, 'dirt');
});

test('a zero-length displacement is a safe miss — the documented default Hit shape, no computation attempted', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const hit = phys.sweepProjectile(0, 0, 0, 0, 0.3, MASK.WORLD, 0);
  assert.deepEqual(hit, {
    hit: false,
    x: 0,
    z: 0,
    nx: 0,
    nz: 0,
    distance: 0,
    fraction: 0,
    surface: 'stone',
    actorId: 0,
    staticHandle: 0,
  });
});

test('sweepProjectile ignores a wall entirely when mask excludes LAYER.STATIC', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.3, MASK.ACTORS, 0);
  assert.equal(hit.hit, false);
});

test('sweepProjectile ignores a body entirely when mask excludes its layer', async () => {
  const { phys } = await makePhysics();
  phys.addBody(9, 5, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.2, MASK.WORLD, 0);
  assert.equal(hit.hit, false);
});

// ---------------------------------------------------------------------------
// D5/D6 — body hits and excludeId
// ---------------------------------------------------------------------------

test('a body hit reports surface:flesh, the actorId (not bodyId), and staticHandle:0', async () => {
  const { phys } = await makePhysics();
  const bodyId = phys.addBody(42, 5, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.2, MASK.ACTORS, 0);
  assert.equal(hit.hit, true);
  assert.equal(hit.surface, 'flesh');
  assert.equal(hit.actorId, 42);
  assert.notEqual(hit.actorId, bodyId, 'the reported id must be the actorId (42), not the internal bodyId (1)');
  assert.equal(hit.staticHandle, 0);
  assert.ok(Math.abs(hit.distance - (5 - 0.3 - 0.2)) < 1e-9);
});

test('D6 — excludeId (actorId space) skips the owner\'s own body and lets a farther body be hit', async () => {
  const { phys } = await makePhysics();
  phys.addBody(7, 5, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER); // the "owner", closer
  phys.addBody(9, 8, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER); // a target, farther

  const withoutExclude = phys.sweepProjectile(0, 0, 20, 0, 0.2, MASK.ACTORS, 0);
  assert.equal(withoutExclude.actorId, 7, 'without exclusion the nearer body (the owner) is hit first');

  const withExclude = phys.sweepProjectile(0, 0, 20, 0, 0.2, MASK.ACTORS, 7);
  assert.equal(withExclude.hit, true);
  assert.equal(withExclude.actorId, 9, 'excludeId=7 must skip the owner and let the farther body be hit');
  assert.ok(Math.abs(withExclude.distance - (8 - 0.3 - 0.2)) < 1e-9);
});

test('D4 — a NO_COLLIDE body is still fully visible to sweepProjectile (a query, not a movement resolution)', async () => {
  const { phys } = await makePhysics();
  const ghost = phys.addBody(3, 5, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  phys.setBodyFlags(ghost, BODY_FLAG.NO_COLLIDE);
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.2, MASK.ACTORS, 0);
  assert.equal(hit.hit, true);
  assert.equal(hit.actorId, 3);
});

test('sweepProjectile picks the CLOSER of a static and a body when both are in range and mask', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 10, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.addBody(3, 4, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  phys.rebuild();
  const hit = phys.sweepProjectile(0, 0, 20, 0, 0, MASK.WORLD | MASK.ACTORS, 0);
  assert.equal(hit.hit, true);
  assert.equal(hit.actorId, 3);
  assert.equal(hit.staticHandle, 0);
  assert.ok(Math.abs(hit.distance - 3.7) < 1e-9, `expected the nearer body at 3.7, got ${hit.distance}`);
});

// ---------------------------------------------------------------------------
// Post-acceptance regressions — found by the orchestrator's own independent
// probe after the first round of this ticket, both deterministic (no
// randomness needed), both invisible to the 10 000-trial acceptance test
// above because that test only ever exercises radius > 0 against a SPARSE
// field of statics. See sweep.js's own header ("Post-acceptance fix") for
// the full analysis and proof of the fix.
// ---------------------------------------------------------------------------

test('Failure 1 regression: a static hashed only into a cell the centre LINE never enters, but the swept DISK reaches, must still be found', async () => {
  const { phys } = await makePhysics();
  // Grid cells are 2 m; cell row boundaries sit at z = ...,0,2,4,...
  // The centre line travels at z=1.999 (cell row 0); the wall spans
  // z=[2.05, 2.55] (cell row 1) — the centre line never enters that row, but
  // a radius=0.3 disk centred on the line comes within 0.051 m of the wall's
  // near face, well inside the radius. A centre-line-only gather (the
  // original bug) never even offers this footprint to the narrow phase.
  phys.addStatic({ kind: 'box', x: 5, z: 2.3, halfW: 3, halfL: 0.25 }, 'stone'); // spans z in [2.05, 2.55]
  phys.rebuild();

  const hit = phys.sweepProjectile(2.0, 1.999, 6, 0, 0.3, MASK.WORLD, 0);
  assert.equal(hit.hit, true, 'the disk plainly reaches the wall (0.051 m clearance vs radius 0.3) — a centre-line-only gather misses this');

  // Same physical case, nudged 0.002 m so the centre line itself crosses into
  // the wall's cell row — this must ALSO hit, and at essentially the same
  // distance, proving the result now tracks geometry rather than which cell
  // the centre line happens to occupy.
  const { phys: phys2 } = await makePhysics();
  phys2.addStatic({ kind: 'box', x: 5, z: 2.3, halfW: 3, halfL: 0.25 }, 'stone');
  phys2.rebuild();
  const control = phys2.sweepProjectile(2.0, 2.001, 6, 0, 0.3, MASK.WORLD, 0);
  assert.equal(control.hit, true);
  assert.ok(Math.abs(hit.distance - control.distance) < 0.01, `expected both centre-line phases to report essentially the same contact distance, got ${hit.distance} vs ${control.distance}`);
});

test('Failure 1 regression: radius 0 is unaffected — a centre line that truly does not reach a neighbouring-cell wall still misses', async () => {
  const { phys } = await makePhysics();
  // Same wall as above, but radius 0: the exact ray at z=1.999 truly does
  // not reach z=2.05, so this must stay a miss — the fix must not turn every
  // neighbouring cell into a false positive.
  phys.addStatic({ kind: 'box', x: 5, z: 2.3, halfW: 3, halfL: 0.25 }, 'stone');
  phys.rebuild();
  const hit = phys.sweepProjectile(2.0, 1.999, 6, 0, 0, MASK.WORLD, 0);
  assert.equal(hit.hit, false, 'a bare ray 0.051 m short of the wall must still miss it');
});

test('Failure 2 regression: a static count that would have overflowed the old fixed candidate buffer must not lose the real, more distant blocker', async () => {
  const { phys } = await makePhysics();
  // 300 harmless cylinders line up ahead of the sweep (none of them block
  // the path itself — they sit at z=1.2, off the x-axis the sweep travels
  // along), followed by the real wall added last. The old bounded gather
  // (256 entries) silently dropped the wall once the harmless statics alone
  // exceeded the cap; this must find it regardless of how many statics were
  // hashed onto the swept cells first.
  for (let i = 0; i < 300; i++) {
    phys.addStatic({ kind: 'cylinder', x: 1 + (i % 20) * 0.05, z: 1.2, radius: 0.02 }, 'stone');
  }
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.1, halfL: 4 }, 'stone'); // the real wall, added last
  phys.rebuild();

  const hit = phys.sweepProjectile(0, 0, 10, 0, 0, MASK.WORLD, 0);
  assert.equal(hit.hit, true, 'the real wall must be found even with 300+ unrelated statics hashed onto the same swept cells');
  assert.ok(Math.abs(hit.distance - 4.9) < 1e-9, `expected contact at the wall's near face (x=4.9), got distance=${hit.distance}`);
});

// ---------------------------------------------------------------------------
// The shared 32-deep Hit ring — sweepProjectile must not build a second one
// ---------------------------------------------------------------------------

test('sweepProjectile draws from the SAME 32-deep ring as rayCast/circleCast — calls interleave into one rotation', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();

  const first = phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD); // ring slot 0
  // 30 more calls, alternating method, to advance the shared cursor to slot 31.
  let last;
  for (let i = 0; i < 15; i++) {
    phys.sweepProjectile(0, 0, 1, 0, 0, MASK.WORLD, 0);
    last = phys.circleCast(0, 0, 1, 0, 0, 1, MASK.WORLD);
  }
  void last;
  // 30 calls consumed slots 1..30; one more call must land on slot 31, and
  // the call after THAT must wrap back to `first`'s own slot 0 — proving
  // sweepProjectile shares the exact same 32-slot rotation, not a second one.
  phys.sweepProjectile(0, 0, 1, 0, 0, MASK.WORLD, 0); // slot 31
  const wrapped = phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD); // slot 0 again
  assert.equal(wrapped, first, 'the ring must have wrapped back to the very first slot — sweepProjectile shares cast.js\'s ring, not a second one');
});

test('a caller-supplied `out` writes directly into it and never consumes a ring slot', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();

  const ringHits = [];
  for (let i = 0; i < 5; i++) ringHits.push(phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD));

  const out = { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
  const returned = phys.sweepProjectile(0, 0, 1, 0, 0.1, MASK.WORLD, 0, out);
  assert.equal(returned, out);

  let last;
  for (let i = 0; i < 28; i++) last = phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD);
  assert.equal(last, ringHits[0], 'the ring should have wrapped back to the very first slot — the out call did not consume one');
});

// ---------------------------------------------------------------------------
// stats.casts
// ---------------------------------------------------------------------------

test('stats.casts increments once per sweepProjectile call and stats keeps its object identity', async () => {
  const { phys } = await makePhysics();
  const s1 = phys.stats;
  assert.equal(s1.casts, 0);
  phys.sweepProjectile(0, 0, 1, 0, 0.1, MASK.WORLD, 0);
  phys.sweepProjectile(0, 0, 0, 0, 0.1, MASK.WORLD, 0); // zero-length short-circuit still counts
  const s2 = phys.stats;
  assert.equal(s1, s2, 'stats must be Alloc:no — same object identity every call');
  assert.equal(s2.casts, 2);
});

// ---------------------------------------------------------------------------
// O-25 — the defect this ticket exists to fix: moveBody tunnels a big
// single-step delta through a thin wall; sweepProjectile, fed the identical
// displacement, does not.
// ---------------------------------------------------------------------------

test('O-25 regression: moveBody tunnels through a thin wall on a big single-step delta, but sweepProjectile fed the same displacement catches it', async () => {
  const { phys } = await makePhysics();
  // A 0.2 m-thick wall spanning x in [4.9, 5.1] — the same thickness as this
  // ticket's own acceptance criterion.
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.1, halfL: 5 }, 'stone');
  phys.rebuild();

  const bodyId = phys.addBody(1, 0, 0, 0.3, BODY_HEIGHT, 80, LAYER.PLAYER);
  const move = phys.moveBody(bodyId, 10, 0); // ACTR-1's own scenario, scaled to this wall
  assert.equal(move.blocked, false, 'O-25: moveBody samples only the final position, which is clean past the wall — it must NOT see a block here (this is the documented defect, not a bug in this test)');
  assert.ok(move.x > 5.1, 'the body must have actually tunnelled through to the far side');

  // The SAME displacement, fed to sweepProjectile from the SAME start point,
  // must find the wall — this is the whole reason PHYS-5 exists.
  const hit = phys.sweepProjectile(0, 0, 10, 0, 0.3, MASK.WORLD, 0);
  assert.equal(hit.hit, true, 'sweepProjectile must catch what moveBody tunnelled through');
  assert.ok(hit.distance < 5, `expected contact at/before the wall's near face, got distance=${hit.distance}`);
});

// ---------------------------------------------------------------------------
// 12.A01 — zero allocation
// ---------------------------------------------------------------------------

test('12.A01 — sweepProjectile allocates nothing against a mixed field of box/cylinder/poly statics and a body', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 2 }, 'stone');
  phys.addStatic({ kind: 'cylinder', x: 10, z: 0, radius: 1 }, 'stone');
  phys.addStatic({ kind: 'poly', x: 15, z: 0, points: [0.5, 0, 0, 0.5, -0.5, 0, 0, -0.5] }, 'stone');
  phys.rebuild();
  phys.addBody(1, 20, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  const out = { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
  const mask = MASK.WORLD | MASK.ACTORS;

  const fn = () => {
    phys.sweepProjectile(0, 0, 0.5, 0, 0.3, mask, 0, out);
  };
  // Same O-23 "polymorphic hot path needs a longer warm-up" signature the
  // other physics 12.A01 gates hit — a long `iterations` run clears the
  // < 1 byte/call threshold in the first round; see phys3.test.js's own
  // comment on this exact dilution curve.
  const result = assertAllocationFree(fn, { iterations: 4_000_000, maxRounds: 10 });
  // eslint-disable-next-line no-console
  console.log(`[phys5] sweepProjectile (mixed shapes, out param): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — sweepProjectile allocates nothing when drawing from the shared Hit ring (no `out`)', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 2 }, 'stone');
  phys.rebuild();
  const fn = () => {
    phys.sweepProjectile(0, 0, 0.5, 0, 0.3, MASK.WORLD, 0); // no out -> shared ring path
  };
  const result = assertAllocationFree(fn, { iterations: 6_000_000, maxRounds: 10 });
  // eslint-disable-next-line no-console
  console.log(`[phys5] sweepProjectile (ring path): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

// ---------------------------------------------------------------------------
// Acceptance criterion — a 30 m/s projectile at 60 Hz never tunnels a 0.2 m
// wall over 10 000 randomised trials.
// ---------------------------------------------------------------------------
//
// Each trial fires a projectile at a fixed 30 m/s (0.5 m per 60 Hz fixed
// step — larger than the 0.2 m wall) at a randomly oriented wall, stepping
// sweepProjectile exactly the way `11-flows.md` §5.5 step 4 calls it every
// fixed step ("from the previous to the new position"), and asserts a hit
// is found before the projectile's straight-line path — which is
// constructed, by algebra, to pass exactly through the wall's centreline —
// would otherwise emerge clean on the far side. Randomised per trial,
// using the project's own deterministic RNG (never Math.random()):
//   - approach angle: the angle between the direction of travel and the
//     wall's normal (the wall's thickness always lies along world +X;
//     travel direction is rotated instead, which is equivalent and lets the
//     wall's static geometry stay simple) — swept from a near-perpendicular
//     hit (cosine ~0.17 for a very oblique approach) up to a near head-on
//     hit (0 degrees), covering both the highest-risk case (thickness
//     closes fastest per step, cos(theta) large) and shallow grazing hits.
//   - start offset along the wall: the Z coordinate the path is aimed at,
//     randomised across the wall's length.
//   - sub-cell phase of the start point: the wall's X position (and hence
//     the derived start position) is drawn from a continuous multi-metre
//     range, so the start point's offset within `CELL_SIZE`-sized (2 m)
//     grid cells varies trial to trial, exercising the DDA gather across
//     different cell-boundary alignments.
//   - projectile radius: including exactly 0 (a bare ray).

const SPEED_MPS = 30; // this ticket's own acceptance figure
const FIXED_HZ = 60; // ARCHITECTURE.md's engine-owned PHYSICS_HZ
const STEP_DIST = SPEED_MPS / FIXED_HZ; // 0.5 m/step — larger than the wall below
const WALL_HALF_THICK = 0.1; // 0.2 m wall — this ticket's own acceptance figure
const WALL_HALF_LENGTH = 6; // long enough that a +/-5 m aim point stays well clear of the mitred corners (cast.js D2)
const RADII = [0, 0.05, 0.15, 0.3, 0.5]; // "including radius 0"
const TRIALS = 10_000;

test(`acceptance: a ${SPEED_MPS} m/s projectile at ${FIXED_HZ} Hz never tunnels a ${WALL_HALF_THICK * 2} m wall over ${TRIALS} randomised trials`, async () => {
  const rng = new Rng(SEEDS.a); // fixed seed — deterministic, no Math.random()
  const failures = [];
  let maxStepsUsed = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const radius = rng.pick(RADII);
    const thetaDeg = rng.range(-80, 80); // approach angle relative to the wall's normal (world +X)
    const theta = (thetaDeg * Math.PI) / 180;
    const targetZ = rng.range(-(WALL_HALF_LENGTH - 1), WALL_HALF_LENGTH - 1); // start offset along the wall
    const wallX = rng.range(8, 14); // varies the sub-cell phase of both the wall and the derived start point
    const travelDist = rng.range(3, 9); // metres from the start point to the aim point on the wall's centreline

    const dirx = Math.cos(theta);
    const dirz = Math.sin(theta);

    const { phys } = await makePhysics();
    phys.addStatic({ kind: 'box', x: wallX, z: 0, halfW: WALL_HALF_THICK, halfL: WALL_HALF_LENGTH }, 'stone');
    phys.rebuild();

    // The aim point sits exactly on the wall's centreline (dead centre of
    // its thickness) — the path from the start point through it, extended
    // far enough past, is guaranteed to cross the wall's solid footprint.
    let x = wallX - dirx * travelDist;
    let z = targetZ - dirz * travelDist;

    const totalDist = travelDist + 5; // comfortably past the wall's far face
    const steps = Math.ceil(totalDist / STEP_DIST) + 1;
    if (steps > maxStepsUsed) maxStepsUsed = steps;

    let hitFound = false;
    for (let s = 0; s < steps; s++) {
      const dx = dirx * STEP_DIST;
      const dz = dirz * STEP_DIST;
      const hit = phys.sweepProjectile(x, z, dx, dz, radius, MASK.WORLD, 0);
      if (hit.hit) {
        hitFound = true;
        break;
      }
      x += dx;
      z += dz;
    }

    if (!hitFound) {
      failures.push({ trial, radius, thetaDeg, targetZ, wallX, travelDist });
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[phys5] acceptance: ${TRIALS} trials, ${failures.length} tunnelled (max ${maxStepsUsed} steps/trial)`);
  if (failures.length > 0) {
    const sample = failures.slice(0, 10).map((f) => JSON.stringify(f)).join('\n');
    assert.fail(`${failures.length}/${TRIALS} trials tunnelled through the wall; first ${Math.min(10, failures.length)}:\n${sample}`);
  }
});
