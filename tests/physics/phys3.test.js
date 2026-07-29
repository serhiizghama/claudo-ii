// tests/physics/phys3.test.js
//
// PHYS-3 acceptance tests for src/physics/cast.js and the seven cast methods
// forwarded through src/physics/index.js. `node:test` + `node:assert/strict`
// only — no framework (12-testing.md P6).
//
// Scope: circleCast/rayCast/lineOfSight/overlapCircle/overlapCone/
// overlapRect/nearest — the Hit record shape, the 32-deep Hit ring, mask/
// layer filtering, the blocksSight-only distinction lineOfSight makes that
// rayCast does not, zero-allocation (12.A01), and the ticket's own
// acceptance criterion: lineOfSight agrees with rayCast on 10 000 random
// pairs. Statics/grid/bodies/moveBody themselves are PHYS-1/2's own test
// files — not re-tested here except where a cast needs them as fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsSystem, LAYER, MASK } from '../../src/physics/index.js';
import { HIT_RING_SIZE } from '../../src/physics/cast.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

/** A minimal `ctx`, matching PHYS-1/2's own `makeCtx()`. */
function makeCtx() {
  return { events: new EventBus() };
}

async function makePhysics() {
  const ctx = makeCtx();
  const phys = new PhysicsSystem();
  await phys.init(ctx);
  return { phys, ctx };
}

const BODY_RADIUS = 0.3;
const BODY_HEIGHT = 1.8;

// ---------------------------------------------------------------------------
// Constants and the Hit record's default shape
// ---------------------------------------------------------------------------

test('HIT_RING_SIZE is exactly 32, per 02-api-contracts.md §4 ("a 32-deep ring")', () => {
  assert.equal(HIT_RING_SIZE, 32);
});

test('a miss reports the Hit record\'s exact documented default shape, field for field', async () => {
  const { phys } = await makePhysics();
  // No statics, no bodies registered — every mask misses everything.
  const hit = phys.rayCast(0, 0, 1, 0, 10, MASK.WORLD | MASK.ACTORS);
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

// ---------------------------------------------------------------------------
// rayCast — exact hits against all three footprint shapes
// ---------------------------------------------------------------------------

test('rayCast hits a box footprint at its face, with the correct outward normal, distance and fraction', async () => {
  const { phys } = await makePhysics();
  const handle = phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();

  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.WORLD);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.x - 4.5) < 1e-9, `expected face at x=4.5, got ${hit.x}`);
  assert.equal(hit.z, 0);
  assert.ok(Math.abs(hit.nx - -1) < 1e-9);
  assert.ok(Math.abs(hit.nz) < 1e-9);
  assert.ok(Math.abs(hit.distance - 4.5) < 1e-9);
  assert.ok(Math.abs(hit.fraction - 4.5 / 20) < 1e-9);
  assert.equal(hit.surface, 'stone');
  assert.equal(hit.staticHandle, handle);
  assert.equal(hit.actorId, 0);
});

test('rayCast hits a cylinder footprint at its circular boundary', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'cylinder', x: 5, z: 0, radius: 0.8 }, 'dirt');
  phys.rebuild();

  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.WORLD);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.x - 4.2) < 1e-9, `expected contact at x=4.2, got ${hit.x}`);
  assert.equal(hit.surface, 'dirt');
});

test('rayCast hits a poly (diamond) footprint before its centre', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'poly', x: 5, z: 0, points: [0.5, 0, 0, 0.5, -0.5, 0, 0, -0.5], facing: 0 }, 'stone');
  phys.rebuild();

  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.WORLD);
  assert.equal(hit.hit, true);
  assert.ok(hit.x < 5 && hit.x > 4.4, `expected contact just short of x=5, got ${hit.x}`);
});

test('rayCast misses when maxDist falls short of the obstacle', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const hit = phys.rayCast(0, 0, 1, 0, 4, MASK.WORLD); // wall face at 4.5, budget only 4
  assert.equal(hit.hit, false);
});

test('rayCast against a static ignores it entirely when mask excludes LAYER.STATIC', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.ACTORS); // no STATIC bit
  assert.equal(hit.hit, false);
});

test('a fired direction vector need not be pre-normalized — only maxDist controls travel distance (D3)', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  // (10, 0) is the same direction as (1, 0) but 10x the magnitude.
  const hit = phys.rayCast(0, 0, 10, 0, 20, MASK.WORLD);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.x - 4.5) < 1e-9);
  assert.ok(Math.abs(hit.distance - 4.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// circleCast — a swept circle stops earlier than a bare ray, by ~radius
// ---------------------------------------------------------------------------

test('circleCast stops the sweep radius short of where rayCast would', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();

  const ray = phys.rayCast(0, 0, 1, 0, 20, MASK.WORLD);
  const circ = phys.circleCast(0, 0, 1, 0, 0.3, 20, MASK.WORLD);
  assert.equal(ray.hit, true);
  assert.equal(circ.hit, true);
  assert.ok(Math.abs(circ.distance - (ray.distance - 0.3)) < 1e-9, `expected circleCast to stop 0.3 short of rayCast, ray=${ray.distance} circ=${circ.distance}`);
});

test('circleCast against a cylinder is exact (circle vs circle, radii sum)', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'cylinder', x: 5, z: 0, radius: 0.8 }, 'stone');
  phys.rebuild();
  const circ = phys.circleCast(0, 0, 1, 0, 0.3, 20, MASK.WORLD);
  assert.equal(circ.hit, true);
  // Contact when the swept circle's edge reaches the cylinder's edge:
  // distance = 5 - 0.8 - 0.3 = 3.9.
  assert.ok(Math.abs(circ.distance - 3.9) < 1e-9, `expected 3.9, got ${circ.distance}`);
});

test('circleCast against a body hits at the sum of both radii', async () => {
  const { phys } = await makePhysics();
  const bodyId = phys.addBody(7, 5, 0, 0.4, BODY_HEIGHT, 80, LAYER.MONSTER);
  const hit = phys.circleCast(0, 0, 1, 0, 0.2, 20, MASK.ACTORS);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.distance - (5 - 0.4 - 0.2)) < 1e-9);
  assert.equal(hit.actorId, 7);
  assert.equal(hit.staticHandle, 0);
  assert.equal(hit.surface, 'flesh');
  void bodyId;
});

test('circleCast/rayCast pick the CLOSER of a static and a body when both are in range and mask', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 10, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.addBody(3, 4, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  phys.rebuild();
  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.WORLD | MASK.ACTORS);
  assert.equal(hit.hit, true);
  assert.equal(hit.actorId, 3);
  assert.equal(hit.staticHandle, 0);
  assert.ok(Math.abs(hit.distance - 3.7) < 1e-9, `expected the nearer body at 3.7, got ${hit.distance}`);
});

// ---------------------------------------------------------------------------
// O-32 regression — the candidate gather walked the ray LINE, not the swept
// DISK. Identical root cause to (and one day behind) sweep.js's own
// PHYS-5 "Post-acceptance fix" — see cast.js's own header for the full
// derivation and proof of the fix (a `(2*cellsRadius+1)^2` cell block per
// DDA step instead of a single cell, `cellsRadius = ceil(radius/cellSize)`).
// ---------------------------------------------------------------------------

test('O-32 regression: circleCast finds a static hashed only into a cell the centre LINE never enters, but the swept DISK reaches', async () => {
  const { phys } = await makePhysics();
  // Grid cells are 2 m; cell row boundaries sit at z = ...,0,2,4,...
  // The centre line travels at z=1.999 (cell row 0); the wall spans
  // z=[2.05, 2.55] (cell row 1) — the centre line never enters that row, but
  // a radius=0.3 disk centred on the line comes within 0.051 m of the wall's
  // near face, well inside the radius. A centre-line-only gather (the
  // original bug) never even offers this footprint to the narrow phase.
  phys.addStatic({ kind: 'box', x: 5, z: 2.3, halfW: 3, halfL: 0.25 }, 'stone'); // spans z in [2.05, 2.55]
  phys.rebuild();

  const hit = phys.circleCast(2.0, 1.999, 6, 0, 0.3, 6, MASK.WORLD);
  assert.equal(hit.hit, true, 'the disk plainly reaches the wall (0.051 m clearance vs radius 0.3) — a centre-line-only gather misses this');

  // Same physical case, nudged 0.002 m so the centre line itself crosses into
  // the wall's cell row — this must ALSO hit, at essentially the same
  // distance, proving the result now tracks geometry rather than which cell
  // the centre line happens to occupy.
  const { phys: phys2 } = await makePhysics();
  phys2.addStatic({ kind: 'box', x: 5, z: 2.3, halfW: 3, halfL: 0.25 }, 'stone');
  phys2.rebuild();
  const control = phys2.circleCast(2.0, 2.001, 6, 0, 0.3, 6, MASK.WORLD);
  assert.equal(control.hit, true);
  assert.ok(Math.abs(hit.distance - control.distance) < 0.01, `expected both centre-line phases to report essentially the same contact distance, got ${hit.distance} vs ${control.distance}`);
});

test('O-32 regression: radius 0 is unaffected — a centre line that truly does not reach a neighbouring-cell wall still misses (rayCast AND circleCast(radius=0))', async () => {
  const { phys } = await makePhysics();
  // Same wall as above, but radius 0: the exact ray/circle at z=1.999 truly
  // does not reach z=2.05, so this must stay a miss — the fix must not turn
  // every neighbouring cell into a false positive.
  phys.addStatic({ kind: 'box', x: 5, z: 2.3, halfW: 3, halfL: 0.25 }, 'stone');
  phys.rebuild();
  const ray = phys.rayCast(2.0, 1.999, 6, 0, 6, MASK.WORLD);
  assert.equal(ray.hit, false, 'a bare ray 0.051 m short of the wall must still miss it');
  const circ = phys.circleCast(2.0, 1.999, 6, 0, 0, 6, MASK.WORLD);
  assert.equal(circ.hit, false, 'circleCast at radius=0 must behave exactly like rayCast — still a miss');
});

test('O-32 regression: a static count that would have overflowed the old fixed candidate buffer must not lose the real, more distant blocker', async () => {
  const { phys } = await makePhysics();
  // 300 harmless cylinders line up ahead of the sweep (none of them block
  // the path itself — they sit at z=1.2, off the x-axis the sweep travels
  // along), followed by the real wall added last. The old bounded gather
  // (256 entries) silently dropped the wall once the harmless statics alone
  // exceeded the cap, and widening the traversal to a 9-cell block only made
  // that overflow likelier — this must find the wall regardless of how many
  // statics were hashed onto the swept cells first, because the fix removes
  // the buffer entirely (streaming narrow-phase, see cast.js's header).
  for (let i = 0; i < 300; i++) {
    phys.addStatic({ kind: 'cylinder', x: 1 + (i % 20) * 0.05, z: 1.2, radius: 0.02 }, 'stone');
  }
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.1, halfL: 4 }, 'stone'); // the real wall, added last
  phys.rebuild();

  const hit = phys.circleCast(0, 0, 10, 0, 0.05, 10, MASK.WORLD);
  assert.equal(hit.hit, true, 'the real wall must be found even with 300+ unrelated statics hashed onto the same swept cells');
  assert.ok(Math.abs(hit.distance - (4.9 - 0.05)) < 1e-9, `expected contact 0.05 short of the wall's near face (x=4.9), got distance=${hit.distance}`);
});

// ---------------------------------------------------------------------------
// lineOfSight — agrees with rayCast, except it alone honours blocksSight
// ---------------------------------------------------------------------------

test('lineOfSight is blocked by a default (blocksSight: true) wall, exactly matching rayCast', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.SIGHT);
  const los = phys.lineOfSight(0, 0, 20, 0, MASK.SIGHT);
  assert.equal(hit.hit, true);
  assert.equal(los, false);
});

test('lineOfSight is clear when nothing is in the way, exactly matching rayCast', async () => {
  const { phys } = await makePhysics();
  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.SIGHT);
  const los = phys.lineOfSight(0, 0, 20, 0, MASK.SIGHT);
  assert.equal(hit.hit, false);
  assert.equal(los, true);
});

test('a blocksSight:false rail physically blocks rayCast/circleCast but lineOfSight passes straight through it', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5, blocksSight: false }, 'metal');
  phys.rebuild();

  const hit = phys.rayCast(0, 0, 1, 0, 20, MASK.WORLD);
  assert.equal(hit.hit, true, 'a rail is still a physical obstacle for rayCast');

  const los = phys.lineOfSight(0, 0, 20, 0, MASK.SIGHT);
  assert.equal(los, true, 'lineOfSight must ignore blocksSight:false geometry entirely');
});

test('lineOfSight of a point to itself is trivially true', async () => {
  const { phys } = await makePhysics();
  assert.equal(phys.lineOfSight(3, 4, 3, 4, MASK.SIGHT), true);
});

// ---------------------------------------------------------------------------
// overlapCircle / overlapCone / overlapRect — actor ids, layer/mask filtering
// ---------------------------------------------------------------------------

test('overlapCircle finds only bodies within radius+actorRadius AND matching the mask\'s layer bits', async () => {
  const { phys } = await makePhysics();
  phys.addBody(1, 1, 0, 0.3, BODY_HEIGHT, 80, LAYER.PLAYER);
  phys.addBody(2, 1.2, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  phys.addBody(3, 50, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER); // far away

  const out = new Array(8).fill(-1);
  const allActors = phys.overlapCircle(0, 0, 2, MASK.ACTORS, out);
  assert.equal(allActors, 2);
  assert.deepEqual(new Set(out.slice(0, allActors)), new Set([1, 2]));

  const monstersOnly = phys.overlapCircle(0, 0, 2, MASK.HOSTILE_TO_PLAYER, out);
  assert.equal(monstersOnly, 1);
  assert.equal(out[0], 2);
});

test('overlapCircle never writes past out.length and never reports more than out.length (D7)', async () => {
  const { phys } = await makePhysics();
  for (let i = 0; i < 6; i++) phys.addBody(100 + i, 0.1 * i, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  const out = [0, 0, 0]; // room for 3, but 6 bodies match
  const count = phys.overlapCircle(0, 0, 5, MASK.ACTORS, out);
  assert.equal(count, 3);
  assert.equal(out.length, 3, 'out must never be truncated/grown');
  assert.ok(out.every((id) => id >= 100 && id < 106));
});

test('overlapCone finds a body inside the arc and excludes one outside it', async () => {
  const { phys } = await makePhysics();
  phys.addBody(1, 3, 0, 0.2, BODY_HEIGHT, 80, LAYER.MONSTER); // straight ahead (facing 0 = +X)
  phys.addBody(2, 0, 3, 0.2, BODY_HEIGHT, 80, LAYER.MONSTER); // to the side (+Z), outside a narrow cone
  const out = new Array(4).fill(-1);
  const count = phys.overlapCone(0, 0, 0, Math.PI / 8, 10, MASK.ACTORS, out);
  assert.equal(count, 1);
  assert.equal(out[0], 1);
});

test('overlapCone excludes a body beyond its radius even if the angle matches', async () => {
  const { phys } = await makePhysics();
  phys.addBody(1, 50, 0, 0.2, BODY_HEIGHT, 80, LAYER.MONSTER);
  const out = new Array(4).fill(-1);
  const count = phys.overlapCone(0, 0, 0, Math.PI / 4, 5, MASK.ACTORS, out);
  assert.equal(count, 0);
});

test('overlapRect finds a body inside a rotated rectangle and excludes one outside it', async () => {
  const { phys } = await makePhysics();
  // Rect centred at origin, halfW=1, halfL=3, rotated 90 degrees — its long
  // axis now runs along X instead of Z.
  phys.addBody(1, 2.5, 0, 0.2, BODY_HEIGHT, 80, LAYER.NEUTRAL); // inside the rotated long axis
  phys.addBody(2, 0, 2.5, 0.2, BODY_HEIGHT, 80, LAYER.NEUTRAL); // would be inside if NOT rotated
  const out = new Array(4).fill(-1);
  const count = phys.overlapRect(0, 0, 1, 3, Math.PI / 2, MASK.ACTORS, out);
  assert.equal(count, 1);
  assert.equal(out[0], 1);
});

// ---------------------------------------------------------------------------
// nearest
// ---------------------------------------------------------------------------

test('nearest returns the closest matching body, 0 when none match, and honours excludeId', async () => {
  const { phys } = await makePhysics();
  phys.addBody(1, 5, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  phys.addBody(2, 2, 0, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
  phys.addBody(3, 2, 0, 0.3, BODY_HEIGHT, 80, LAYER.PLAYER); // same spot, different layer

  assert.equal(phys.nearest(0, 0, 10, MASK.HOSTILE_TO_PLAYER, 0), 2);
  assert.equal(phys.nearest(0, 0, 10, MASK.HOSTILE_TO_PLAYER, 2), 1, 'excludeId=2 (actorId) should skip the closer monster');
  assert.equal(phys.nearest(0, 0, 1, MASK.ACTORS, 0), 0, 'nothing within radius=1');
  assert.equal(phys.nearest(0, 0, 10, LAYER.TRIGGER, 0), 0, 'no body carries a layer this mask matches');
});

// ---------------------------------------------------------------------------
// The 32-deep Hit ring
// ---------------------------------------------------------------------------

test('Hit comes from a 32-deep ring: 32 calls give 32 distinct records, the 33rd reuses the 1st', async () => {
  const { phys } = await makePhysics();
  const hits = [];
  for (let i = 0; i < 33; i++) hits.push(phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD));
  const first32 = hits.slice(0, 32);
  assert.equal(new Set(first32).size, 32, 'all 32 ring slots must be distinct object identities');
  assert.equal(hits[32], hits[0], 'the 33rd call must reuse the 1st ring slot');
});

test('a caller-supplied `out` writes directly into it and never consumes a ring slot', async () => {
  const { phys } = await makePhysics();
  const ringHits = [];
  for (let i = 0; i < 5; i++) ringHits.push(phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD));

  const out = { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
  const returned = phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD, out);
  assert.equal(returned, out);

  let last;
  for (let i = 0; i < 28; i++) last = phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD);
  assert.equal(last, ringHits[0], 'the ring should have wrapped back to the very first slot — the out call did not consume one');
});

// ---------------------------------------------------------------------------
// stats.casts
// ---------------------------------------------------------------------------

test('stats.casts increments once per call, across every one of the seven methods, and stats keeps its object identity', async () => {
  const { phys } = await makePhysics();
  const s1 = phys.stats;
  assert.equal(s1.casts, 0);
  const out = [0, 0];
  phys.rayCast(0, 0, 1, 0, 1, MASK.WORLD);
  phys.circleCast(0, 0, 1, 0, 0.1, 1, MASK.WORLD);
  phys.lineOfSight(0, 0, 1, 0, MASK.SIGHT);
  phys.overlapCircle(0, 0, 1, MASK.ACTORS, out);
  phys.overlapCone(0, 0, 0, 0.5, 1, MASK.ACTORS, out);
  phys.overlapRect(0, 0, 1, 1, 0, MASK.ACTORS, out);
  phys.nearest(0, 0, 1, MASK.ACTORS, 0);
  const s2 = phys.stats;
  assert.equal(s1, s2, 'stats must be Alloc:no — same object identity every call');
  assert.equal(s2.casts, 7);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('two independently built PhysicsSystem instances fed identical statics/bodies produce identical Hit/overlap results', async () => {
  async function build() {
    const { phys } = await makePhysics();
    phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
    phys.addStatic({ kind: 'cylinder', x: -5, z: 0, radius: 1 }, 'stone');
    phys.rebuild();
    phys.addBody(1, 2, 2, 0.3, BODY_HEIGHT, 80, LAYER.MONSTER);
    phys.addBody(2, -2, -2, 0.3, BODY_HEIGHT, 80, LAYER.PLAYER);
    return phys;
  }
  const A = await build();
  const B = await build();

  const rA = A.rayCast(0, 0, 1, 0, 20, MASK.WORLD | MASK.ACTORS);
  const rB = B.rayCast(0, 0, 1, 0, 20, MASK.WORLD | MASK.ACTORS);
  assert.deepEqual(rA, rB);

  const outA = new Array(4).fill(-1);
  const outB = new Array(4).fill(-1);
  const nA = A.overlapCircle(0, 0, 10, MASK.ACTORS, outA);
  const nB = B.overlapCircle(0, 0, 10, MASK.ACTORS, outB);
  assert.equal(nA, nB);
  assert.deepEqual(outA, outB);
});

// ---------------------------------------------------------------------------
// The ticket's own acceptance criterion: lineOfSight agrees with rayCast on
// 10 000 random pairs.
// ---------------------------------------------------------------------------

test('acceptance: lineOfSight agrees with rayCast on 10 000 random point pairs against random static geometry', async () => {
  const { phys } = await makePhysics();
  const rng = new Rng(SEEDS.a); // fixed seed — deterministic, no Math.random()

  // A field of ~40 random statics (box/cylinder/poly, all default
  // blocksSight: true) spread over a 60x60 m area — dense enough that most
  // random pairs actually cross something, not just a trivial "always
  // clear" degenerate case.
  const HALF_FIELD = 30;
  const kinds = ['box', 'cylinder', 'poly'];
  for (let i = 0; i < 40; i++) {
    const kind = kinds[rng.int(0, 2)];
    const x = rng.range(-HALF_FIELD, HALF_FIELD);
    const z = rng.range(-HALF_FIELD, HALF_FIELD);
    const facing = rng.range(0, Math.PI * 2);
    if (kind === 'cylinder') {
      phys.addStatic({ kind, x, z, radius: rng.range(0.3, 2) }, 'stone');
    } else if (kind === 'box') {
      phys.addStatic({ kind, x, z, facing, halfW: rng.range(0.3, 2), halfL: rng.range(0.3, 2) }, 'stone');
    } else {
      phys.addStatic({ kind, x, z, facing, points: [0.6, 0, 0, 0.6, -0.6, 0, 0, -0.6] }, 'stone');
    }
  }
  phys.rebuild();

  const N = 10_000;
  let agreements = 0;
  for (let i = 0; i < N; i++) {
    const ax = rng.range(-HALF_FIELD - 5, HALF_FIELD + 5);
    const az = rng.range(-HALF_FIELD - 5, HALF_FIELD + 5);
    const bx = rng.range(-HALF_FIELD - 5, HALF_FIELD + 5);
    const bz = rng.range(-HALF_FIELD - 5, HALF_FIELD + 5);

    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const los = phys.lineOfSight(ax, az, bx, bz, MASK.SIGHT);
    if (dist < 1e-9) {
      assert.equal(los, true, `pair ${i}: coincident points must be trivially visible`);
      agreements++;
      continue;
    }
    const hit = phys.rayCast(ax, az, dx / dist, dz / dist, dist, MASK.SIGHT);
    assert.equal(los, !hit.hit, `pair ${i}: lineOfSight(${ax},${az},${bx},${bz})=${los} disagreed with rayCast hit=${hit.hit}`);
    agreements++;
  }
  assert.equal(agreements, N);
});

// ---------------------------------------------------------------------------
// Zero allocations (12.A01) — every Alloc:no cast method
// ---------------------------------------------------------------------------

test('12.A01 — rayCast/circleCast allocate nothing against a mixed field of box/cylinder/poly statics and bodies', (t) => {
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
    phys.rayCast(0, 0, 1, 0, 30, mask, out);
    phys.circleCast(0, 0, 1, 0, 0.3, 30, mask, out);
  };
  // Polymorphic across 3 static shapes + a body test on essentially every
  // call — same "inline caches need a longer warm-up to settle" fact O-23
  // found on moveBody, reproduced here: measured while writing this test,
  // this exact scenario read 0.51 bytes/call at iterations=2_000_000 and
  // 0.089 at 4_000_000 while TOTAL bytes stayed flat around 1.2-1.6 MB
  // across that range (the O-23 signature of dilution, not a leak — a real
  // leak holds bytes/call constant as N grows, which this does not).
  // iterations=4_000_000 clears the < 1 threshold within the first round.
  const result = assertAllocationFree(fn, { iterations: 4_000_000, maxRounds: 10 });
  // eslint-disable-next-line no-console
  console.log(`[phys3] rayCast+circleCast (mixed shapes, out param): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — rayCast allocates nothing when drawing from the Hit ring (no `out`)', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 2 }, 'stone');
  phys.rebuild();
  const fn = () => {
    phys.rayCast(0, 0, 1, 0, 30, MASK.WORLD); // no out -> ring path
  };
  // Same O-23 dilution curve as above (measured while writing this test:
  // 162/24.5/6.1/1.3/0.62/0.04 bytes/call at N=10k/50k/200k/1M/3M/5M, TOTAL
  // bytes flat around 1.2-1.9 MB throughout) — iterations=6_000_000 clears
  // < 1 with headroom in the first round.
  const result = assertAllocationFree(fn, { iterations: 6_000_000, maxRounds: 10 });
  // eslint-disable-next-line no-console
  console.log(`[phys3] rayCast (ring path): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — lineOfSight allocates nothing', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 2, blocksSight: false }, 'stone');
  phys.addStatic({ kind: 'cylinder', x: 10, z: 0, radius: 1 }, 'stone');
  phys.rebuild();
  const fn = () => {
    phys.lineOfSight(0, 0, 30, 0, MASK.SIGHT);
  };
  const result = assertAllocationFree(fn, { iterations: 100_000, maxRounds: 20 });
  // eslint-disable-next-line no-console
  console.log(`[phys3] lineOfSight: ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — overlapCircle/overlapCone/overlapRect/nearest allocate nothing', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  for (let i = 0; i < 10; i++) {
    phys.addBody(100 + i, i * 0.5, 0, 0.3, BODY_HEIGHT, 80, i % 2 === 0 ? LAYER.MONSTER : LAYER.PLAYER);
  }
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  const fn = () => {
    phys.overlapCircle(0, 0, 5, MASK.ACTORS, out);
    phys.overlapCone(0, 0, 0, Math.PI / 3, 5, MASK.ACTORS, out);
    phys.overlapRect(0, 0, 3, 3, 0, MASK.ACTORS, out);
    phys.nearest(0, 0, 5, MASK.ACTORS, 0);
  };
  // Same O-23 dilution curve (measured: 1.32/0.48/0.13 bytes/call at
  // N=1M/3M/6M) — iterations=6_000_000 clears < 1 in the first round.
  const result = assertAllocationFree(fn, { iterations: 6_000_000, maxRounds: 10 });
  // eslint-disable-next-line no-console
  console.log(`[phys3] overlapCircle+overlapCone+overlapRect+nearest: ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});
