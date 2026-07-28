// tests/physics/phys2.test.js
//
// PHYS-2 acceptance tests for src/physics/body.js and the five body methods
// forwarded through src/physics/index.js. `node:test` + `node:assert/strict`
// only — no framework (12-testing.md P6).
//
// Scope: addBody/removeBody/setBody/moveBody/setBodyFlags, the slide + step
// collision resolution against all three Footprint shapes, the 32-deep
// MoveResult ring, blocked/slid/hitStatic/hitActorId semantics, noCollide/
// flying, zero-allocation (12.A01) and determinism. Statics/grid behaviour
// itself is PHYS-1's tests/physics/phys1.test.js — not re-tested here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsSystem, BODY_FLAG } from '../../src/physics/index.js';
import { STEP_HEIGHT_MAX, MOVE_RESULT_RING_SIZE, BodyStore } from '../../src/physics/body.js';
import { EventBus } from '../../src/core/events.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

/** A minimal `ctx`: only what `PhysicsSystem.init()` touches, matching
 * PHYS-1's own `phys1.test.js` `makeCtx()` — no `config`, so bodies fall
 * back to `DEFAULT_MAX_BODIES` (56). */
function makeCtx() {
  return { events: new EventBus() };
}

async function makePhysics() {
  const ctx = makeCtx();
  const phys = new PhysicsSystem();
  await phys.init(ctx);
  return { phys, ctx };
}

/** A `ctx` carrying a real `config.q.maxActors`, for the capacity-sizing
 * test. */
function makeCtxWithMaxActors(maxActors) {
  return { events: new EventBus(), config: { q: { maxActors } } };
}

const BODY_HEIGHT = 1.8; // a plausible humanoid capsule height for these tests
const BODY_RADIUS = 0.3;

// ---------------------------------------------------------------------------
// Constants — exact, per 02-api-contracts.md §4 and this ticket's brief
// ---------------------------------------------------------------------------

test('STEP_HEIGHT_MAX is exactly 0.45 m, the acceptance criterion\'s own number', () => {
  assert.equal(STEP_HEIGHT_MAX, 0.45);
});

test('MOVE_RESULT_RING_SIZE is exactly 32, per 02-api-contracts.md §4 ("a 32-deep ring")', () => {
  assert.equal(MOVE_RESULT_RING_SIZE, 32);
});

test('BODY_FLAG carries NO_COLLIDE and FLYING as distinct, non-zero bits, and is frozen', () => {
  assert.equal(BODY_FLAG.NONE, 0);
  assert.notEqual(BODY_FLAG.NO_COLLIDE, 0);
  assert.notEqual(BODY_FLAG.FLYING, 0);
  assert.notEqual(BODY_FLAG.NO_COLLIDE, BODY_FLAG.FLYING);
  assert.ok(Object.isFrozen(BODY_FLAG));
});

// ---------------------------------------------------------------------------
// addBody / removeBody / setBody / stats.bodies
// ---------------------------------------------------------------------------

test('addBody returns increasing 1-based handles and updates stats.bodies', async () => {
  const { phys } = await makePhysics();
  assert.equal(phys.stats.bodies, 0);
  const a = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const b = phys.addBody(2, 5, 5, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.equal(phys.stats.bodies, 2);
});

test('stats returns the same object identity every call (Alloc: no), bodies included', async () => {
  const { phys } = await makePhysics();
  const s1 = phys.stats;
  phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const s2 = phys.stats;
  assert.equal(s1, s2);
  assert.equal(s2.bodies, 1);
});

test('removeBody decrements stats.bodies; double-remove and an unknown handle are safe no-ops', async () => {
  const { phys } = await makePhysics();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  phys.addBody(2, 1, 1, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  assert.equal(phys.stats.bodies, 2);

  phys.removeBody(id);
  assert.equal(phys.stats.bodies, 1);

  assert.doesNotThrow(() => phys.removeBody(id)); // already removed
  assert.equal(phys.stats.bodies, 1);
  assert.doesNotThrow(() => phys.removeBody(999));
  assert.doesNotThrow(() => phys.removeBody(0));
  assert.doesNotThrow(() => phys.removeBody(-1));
  assert.equal(phys.stats.bodies, 1);
});

test('a freed slot is reused by a later addBody, so capacity never runs out under add/remove churn', async () => {
  const { phys } = await makePhysics();
  const capacity = phys._bodies.capacity;
  for (let i = 0; i < capacity * 3; i++) {
    const id = phys.addBody(i, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
    assert.notEqual(id, 0, `addBody should never fail while every previous body was removed (i=${i})`);
    phys.removeBody(id);
  }
  assert.equal(phys.stats.bodies, 0);
});

test('addBody returns 0 (capacity exhausted) once the fixed store is full, without throwing', async () => {
  const { phys } = await makePhysics();
  const capacity = phys._bodies.capacity;
  const ids = [];
  for (let i = 0; i < capacity; i++) {
    ids.push(phys.addBody(i, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2));
  }
  assert.ok(ids.every((id) => id !== 0));
  let overflow;
  assert.doesNotThrow(() => {
    overflow = phys.addBody(999, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  });
  assert.equal(overflow, 0);
  assert.equal(phys.stats.bodies, capacity);
});

test('init() sizes the body store to ctx.config.q.maxActors ("11-flows.md": body arrays sized q.maxActors)', async () => {
  const ctx = makeCtxWithMaxActors(7);
  const phys = new PhysicsSystem();
  await phys.init(ctx);
  assert.equal(phys._bodies.capacity, 7);
});

test('init() without a config falls back to a sane default and does not throw (matches PHYS-1\'s own minimal ctx)', async () => {
  const { phys } = await makePhysics();
  assert.ok(phys._bodies.capacity > 0);
});

test('setBody moves a body directly (teleport), bypassing collision', async () => {
  const { phys } = await makePhysics();
  const wall = phys.addStatic({ kind: 'box', x: 2, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  // setBody is a direct jump, not a per-step delta — it is legal to place a
  // body wherever the caller says, even inside a wall's footprint (physics
  // does not second-guess a teleport; the next moveBody call resolves
  // whatever state that leaves behind).
  phys.setBody(id, 1.5, 0);
  assert.equal(phys._bodies._x[id - 1], 1.5);
  assert.equal(phys._bodies._z[id - 1], 0);
  void wall;
});

test('setBody on an unknown/stale handle is a safe no-op', async () => {
  const { phys } = await makePhysics();
  assert.doesNotThrow(() => phys.setBody(999, 1, 1));
  assert.doesNotThrow(() => phys.setBodyFlags(999, BODY_FLAG.FLYING));
});

// ---------------------------------------------------------------------------
// moveBody in open space — no candidates, no collision
// ---------------------------------------------------------------------------

test('moveBody in open space (no statics) moves freely: blocked=false, slid=false', async () => {
  const { phys } = await makePhysics();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const r = phys.moveBody(id, 1.5, -0.7);
  assert.ok(Math.abs(r.x - 1.5) < 1e-9);
  assert.ok(Math.abs(r.z - (-0.7)) < 1e-9);
  assert.equal(r.blocked, false);
  assert.equal(r.slid, false);
  assert.equal(r.hitStatic, 0);
  assert.equal(r.hitActorId, 0);
});

test('moveBody on an unknown/stale bodyId returns a harmless zeroed result, never throws', async () => {
  const { phys } = await makePhysics();
  assert.doesNotThrow(() => phys.moveBody(999, 1, 1));
  const r = phys.moveBody(999, 1, 1);
  assert.equal(r.blocked, false);
  assert.equal(r.hitStatic, 0);
});

// ---------------------------------------------------------------------------
// Slide along a flat wall
// ---------------------------------------------------------------------------

test('a capsule moving diagonally into a wall keeps sliding along it — tangential distance travelled is > 0, and it never crosses the wall face', async () => {
  const { phys } = await makePhysics();
  // A long wall parallel to Z, world face at x = 4.5 (halfW=0.5 around
  // centre x=5), spanning z in [-50, 50] — long enough that 60 diagonal
  // steps of 0.05 never run off its end.
  const wallFaceX = 4.5;
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 50 }, 'stone');
  phys.rebuild();

  const id = phys.addBody(1, 3, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let lastResult;
  for (let i = 0; i < 60; i++) {
    lastResult = phys.moveBody(id, 0.05, 0.05);
    // Never tunnels through the wall face, at any point along the way.
    assert.ok(lastResult.x <= wallFaceX - BODY_RADIUS + 1e-6, `step ${i}: x=${lastResult.x} crossed the wall face`);
  }

  assert.equal(lastResult.blocked, true);
  assert.equal(lastResult.slid, true);
  assert.equal(lastResult.hitStatic, 1); // the one static registered
  // Tangential (Z) progress was preserved despite being blocked in X:
  // 60 steps of dz=0.05 attempted = 3.0 m; the wall has zero Z extent to
  // impede this, so z should have travelled (almost) the full distance.
  assert.ok(lastResult.z > 2.5, `expected substantial tangential travel, got z=${lastResult.z}`);
  // And X settled at the wall face, not somewhere in open space.
  assert.ok(lastResult.x > wallFaceX - BODY_RADIUS - 0.5, `x=${lastResult.x} settled too far from the wall`);
});

test('a capsule driven straight (head-on, no tangential component) into a flat wall is blocked but does not report slid', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 50 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 4, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let r;
  for (let i = 0; i < 20; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.blocked, true);
  assert.equal(r.slid, false);
});

// ---------------------------------------------------------------------------
// Inner corner — two walls at once
// ---------------------------------------------------------------------------

test('an inner corner of two walls neither pushes the body through geometry nor fully jams it', async () => {
  const { phys } = await makePhysics();
  // Wall A: blocks +X, world face at x = 4.5.
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 50 }, 'stone');
  // Wall B: blocks +Z, world face at z = 4.5.
  phys.addStatic({ kind: 'box', x: 0, z: 5, halfW: 50, halfL: 0.5 }, 'stone');
  phys.rebuild();

  const wallFaceX = 4.5;
  const wallFaceZ = 4.5;
  const id = phys.addBody(1, 0, 3, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let sawSlide = false;
  let last;
  for (let i = 0; i < 80; i++) {
    last = phys.moveBody(id, 0.08, 0.05); // asymmetric approach, not the bisector
    assert.ok(last.x <= wallFaceX - BODY_RADIUS + 1e-6, `step ${i}: tunnelled through wall A, x=${last.x}`);
    assert.ok(last.z <= wallFaceZ - BODY_RADIUS + 1e-6, `step ${i}: tunnelled through wall B, z=${last.z}`);
    if (last.slid) sawSlide = true;
  }
  // "не заклинивает" — some progress was made before the corner was
  // reached; the body was not frozen from the very first contact.
  assert.ok(sawSlide, 'body should have made sliding progress at least once before wedging into the corner');
  assert.ok(last.x > 0.2, `expected real progress toward the corner, x=${last.x}`);
});

// ---------------------------------------------------------------------------
// Step — 0.45 m passes, taller blocks
// ---------------------------------------------------------------------------

test('a ledge exactly at STEP_HEIGHT_MAX (0.45 m) is crossed, not blocked, and the body\'s tracked floor rises onto it while standing over it', async () => {
  const { phys } = await makePhysics();
  // Footprint spans x in [2, 4] (centre 3, halfW 1).
  const ledge = phys.addStatic({ kind: 'box', x: 3, z: 0, y: 0, height: STEP_HEIGHT_MAX, halfW: 1, halfL: 1 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  // 25 steps of 0.1 = x=2.5, inside the ledge's footprint [2, 4] — the body
  // is standing ON the ledge at this point, not past it.
  let r;
  for (let i = 0; i < 25; i++) {
    r = phys.moveBody(id, 0.1, 0);
    assert.equal(r.blocked, false, `a step-height ledge must not impede horizontal movement (step ${i})`);
  }
  assert.ok(Math.abs(phys._bodies._floorY[id - 1] - STEP_HEIGHT_MAX) < 1e-9, 'floor should have risen onto the ledge while standing over it');

  // Keep walking until well past the ledge (x > 4): still never blocked,
  // and the floor falls back to the baseline once no longer over it.
  for (let i = 0; i < 35; i++) {
    r = phys.moveBody(id, 0.1, 0);
    assert.equal(r.blocked, false, `a step-height ledge must not impede horizontal movement (step ${25 + i})`);
  }
  assert.ok(r.x > 4, `expected the body to walk past the ledge, x=${r.x}`);
  assert.equal(phys._bodies._floorY[id - 1], 0, 'floor should fall back to the baseline once clear of the ledge');
  void ledge;
});

test('an obstacle noticeably taller than STEP_HEIGHT_MAX blocks the body outright', async () => {
  const { phys } = await makePhysics();
  const wallFaceX = 2; // centre x=3, halfW=1 -> face at x=2
  phys.addStatic({ kind: 'box', x: 3, z: 0, y: 0, height: 0.9, halfW: 1, halfL: 1 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let r;
  for (let i = 0; i < 40; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.blocked, true);
  assert.ok(r.x <= wallFaceX - BODY_RADIUS + 1e-6, `should not cross the tall obstacle, x=${r.x}`);
});

// ---------------------------------------------------------------------------
// hitStatic / hitActorId
// ---------------------------------------------------------------------------

test('hitStatic reports the colliding static\'s handle when blocked, 0 when free', async () => {
  const { phys } = await makePhysics();
  const handle = phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  const free = phys.moveBody(id, 0.1, 0);
  assert.equal(free.hitStatic, 0);

  let r;
  for (let i = 0; i < 60; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.hitStatic, handle);
});

test('hitActorId is always 0 — body-body collision is out of this ticket\'s scope (PHYS-4 separate())', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const a = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const b = phys.addBody(2, 0, 0.1, BODY_RADIUS, BODY_HEIGHT, 80, 2); // overlapping body, ignored
  for (let i = 0; i < 60; i++) {
    const r = phys.moveBody(a, 0.1, 0);
    assert.equal(r.hitActorId, 0);
  }
  void b;
});

// ---------------------------------------------------------------------------
// Shape coverage — box (rotated), cylinder, poly all block
// ---------------------------------------------------------------------------

test('a rotated box (facing = 90 deg, swapping its effective world half-extents) blocks at the rotated face, not the unrotated one', async () => {
  const { phys } = await makePhysics();
  // halfW=2, halfL=0.3 locally; facing=PI/2 swaps them in world space, so
  // the world-space face the body meets (approaching along +X at z=0) is
  // at x = 5 - 0.3 = 4.7, NOT at the unrotated x = 5 - 2 = 3 a rotation bug
  // would produce — the two predictions are far enough apart (4.4ish vs
  // 2.7ish once the body radius is subtracted) to tell them apart cleanly.
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 2, halfL: 0.3, facing: Math.PI / 2 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let r;
  for (let i = 0; i < 60; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.blocked, true);
  assert.ok(r.x > 4.0 && r.x < 4.6, `expected the rotated face (~4.4), got x=${r.x}`);
});

test('a cylinder footprint blocks a straight-on approach', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'cylinder', x: 5, z: 0, radius: 0.8 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let r;
  for (let i = 0; i < 60; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.blocked, true);
  // Expected contact ~ 5 - 0.8 - 0.3 = 3.9.
  assert.ok(r.x > 3.6 && r.x < 4.1, `expected contact near 3.9, got x=${r.x}`);
});

test('a poly (diamond) footprint blocks a straight-on approach', async () => {
  const { phys } = await makePhysics();
  // Same diamond shape phys1.test.js uses: CCW, convex, 4 points.
  phys.addStatic({ kind: 'poly', x: 5, z: 0, points: [0.5, 0, 0, 0.5, -0.5, 0, 0, -0.5], facing: 0 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  let r;
  for (let i = 0; i < 60; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.blocked, true);
  assert.ok(r.x < 5, `poly should have stopped the body before its centre, got x=${r.x}`);
  assert.ok(r.x > 3.5, `poly stopped the body implausibly far away, got x=${r.x}`);
});

// ---------------------------------------------------------------------------
// setBodyFlags — noCollide, flying
// ---------------------------------------------------------------------------

test('noCollide passes straight through statics with blocked always false', async () => {
  const { phys } = await makePhysics();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 5 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  phys.setBodyFlags(id, BODY_FLAG.NO_COLLIDE);

  let r;
  for (let i = 0; i < 100; i++) r = phys.moveBody(id, 0.1, 0);
  assert.equal(r.blocked, false);
  assert.ok(Math.abs(r.x - 10) < 1e-6); // 100 * 0.1, moved exactly as requested
});

test('flying glides over an obstacle short enough to stay under the cruise altitude, but a real wall still blocks it exactly like a ground body', async () => {
  const { phys } = await makePhysics();
  // Short obstacle: with the default 0-based floor, a ground body would be
  // blocked (climb = 1.0 > STEP_HEIGHT_MAX from floorY=0), but its top
  // (1.0 m) sits well under a flying body's cruise band (FLY_ALTITUDE =
  // 2.2 m, tolerance 0.45 m -> anything topping out at <= 2.65 m clears).
  phys.addStatic({ kind: 'box', x: 5, z: 0, y: 0, height: 1.0, halfW: 1, halfL: 1 }, 'stone');
  // A real wall (default height 3.0 m) further along the same line — tall
  // enough to reach into the flying band too.
  phys.addStatic({ kind: 'box', x: 12, z: 0, halfW: 1, halfL: 1 }, 'stone');
  phys.rebuild();

  // Both bodies share the same (x, z) line — fine since body-body overlap
  // is out of this ticket's scope (hitActorId is always 0; see the
  // dedicated test for that) and both obstacles above sit on z=0 too.
  const groundId = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const flyId = phys.addBody(2, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  phys.setBodyFlags(flyId, BODY_FLAG.FLYING);

  let groundR;
  let flyR;
  for (let i = 0; i < 60; i++) {
    groundR = phys.moveBody(groundId, 0.1, 0);
    flyR = phys.moveBody(flyId, 0.1, 0);
  }
  assert.equal(groundR.blocked, true, 'a ground body must be blocked by the short obstacle');
  assert.equal(flyR.blocked, false, 'a flying body should glide over the same short obstacle');
  assert.ok(flyR.x > 5, `flying body should have passed x=5, got x=${flyR.x}`);

  // Now both continue toward the real wall at x=12.
  for (let i = 0; i < 60; i++) {
    flyR = phys.moveBody(flyId, 0.1, 0);
  }
  assert.equal(flyR.blocked, true, 'a flying body must still be blocked by a real wall');
  assert.ok(flyR.x < 12, `flying body should not tunnel through the wall, got x=${flyR.x}`);
});

// ---------------------------------------------------------------------------
// The 32-deep MoveResult ring
// ---------------------------------------------------------------------------

test('MoveResult comes from a 32-deep ring: 32 calls give 32 distinct records, the 33rd reuses the 1st', async () => {
  const { phys } = await makePhysics();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  const results = [];
  for (let i = 0; i < 33; i++) {
    results.push(phys.moveBody(id, 0.01, 0));
  }
  const first32 = results.slice(0, 32);
  assert.equal(new Set(first32).size, 32, 'all 32 ring slots must be distinct object identities');
  assert.equal(results[32], results[0], 'the 33rd call must reuse the 1st ring slot');
});

test('a caller-supplied `out` writes directly into it and never consumes a ring slot', async () => {
  const { phys } = await makePhysics();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);

  // 5 ring-consuming calls: ring[0..4], cursor now at 5.
  const ringResults = [];
  for (let i = 0; i < 5; i++) ringResults.push(phys.moveBody(id, 0.01, 0));

  // An `out` call must write into and return `out` itself, and must NOT
  // advance the ring cursor.
  const out = { x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 };
  const returned = phys.moveBody(id, 0.01, 0, out);
  assert.equal(returned, out, 'moveBody must write into and return the exact `out` object given');

  // 28 more ring-consuming calls: 5 + 28 = 33 total ring-consuming calls
  // since the ring was last empty, which is exactly enough to wrap once
  // (32) plus reuse ring[0] again (the 33rd) — proving the `out` call in
  // between did not eat a slot: if it had, this loop would land on ring[31]
  // instead of wrapping back to ring[0].
  let last;
  for (let i = 0; i < 28; i++) last = phys.moveBody(id, 0.01, 0);
  assert.equal(last, ringResults[0], 'the out call must not have consumed a ring slot — the ring should have wrapped back to the very first slot');
});

// ---------------------------------------------------------------------------
// Zero allocations (12.A01) — moveBody, and the other four Alloc:no methods
// ---------------------------------------------------------------------------

test('12.A01 — moveBody allocates nothing, even while actively resolving an inner-corner collision every call', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc` to measure heap allocation — skipping the allocation assertion');
    return;
  }
  const phys = new PhysicsSystem();
  // init() is async; a synchronous-looking construction is fine here since
  // this store never depends on ctx beyond the zone:ready listener, but
  // stay consistent with the rest of the file and just build it directly
  // via the constructor + a manual, synchronous zone:ready-free setup.
  phys.addStatic({ kind: 'box', x: 1, z: 0, halfW: 0.5, halfL: 50 }, 'stone'); // face at x=0.5
  phys.addStatic({ kind: 'box', x: 0, z: 1, halfW: 50, halfL: 0.5 }, 'stone'); // face at z=0.5
  phys.rebuild();

  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const out = { x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 };
  // Wedges into the corner within the first couple of calls and then keeps
  // re-resolving the same corner every subsequent call — the worst case for
  // this method (candidates gathered, classified, MAX_RESOLVE_ITERATIONS
  // depenetration passes against TWO distinct blocking statics) runs on
  // essentially every one of the sampled calls, not just the first.
  const fn = () => {
    phys.moveBody(id, 0.05, 0.05, out);
  };

  // A much larger `iterations` than this file's other 12.A01 tests:
  // resolving two DISTINCT static shapes in one scan (as opposed to one
  // wall, or one wall hashed into several duplicate cell entries) makes V8
  // stabilize more inline caches over the first many thousand calls, on
  // this engine build. That one-time cost is real but bounded and dilutes
  // away as the sample grows — `allocatedBytes(fn, n)` measured for this
  // exact scenario during this ticket's investigation: ~21 bytes/call at
  // n=100 000, ~4.3 at n=300 000, ~6.2 (noisy) around n=300 000 in the
  // in-suite run, ~1.5 at n=1 000 000, ~0.43 at n=2 000 000, ~0.16 at
  // n=5 000 000 — a strictly *decreasing* curve as `n` grows, which is the
  // signature of a fixed one-time cost being diluted, not a genuine
  // per-call allocation (a real per-call leak reads the same bytes/call at
  // any `n`; this ticket's own actually-broken first draft of this code
  // measured a rock-solid constant ~1052 bytes/call regardless of `n` —
  // see the report). `iterations: 2_000_000` reliably clears the `< 1`
  // threshold within the first round (~2 s); `maxRounds` stays generous as
  // a safety margin, not because more rounds are expected to be needed.
  const result = assertAllocationFree(fn, { iterations: 2_000_000, maxRounds: 10 });
  // eslint-disable-next-line no-console
  console.log(`[phys2] moveBody (corner-resolving, out param): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — moveBody allocates nothing when it has to draw from the MoveResult ring (no `out`)', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 50 }, 'stone');
  phys.rebuild();
  const id = phys.addBody(1, 3, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const fn = () => {
    phys.moveBody(id, 0.05, 0.05); // no out -> ring path
  };
  const result = assertAllocationFree(fn, { iterations: 2000, maxRounds: 300 });
  // eslint-disable-next-line no-console
  console.log(`[phys2] moveBody (ring path): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — addBody/removeBody churn (slot recycling) allocates nothing', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  const fn = () => {
    const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
    phys.removeBody(id);
  };
  const result = assertAllocationFree(fn, { iterations: 2000, maxRounds: 300 });
  // eslint-disable-next-line no-console
  console.log(`[phys2] addBody+removeBody churn: ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

test('12.A01 — setBody and setBodyFlags allocate nothing', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const phys = new PhysicsSystem();
  const id = phys.addBody(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  const fn = () => {
    phys.setBody(id, 1, 1);
    phys.setBodyFlags(id, BODY_FLAG.FLYING);
    phys.setBodyFlags(id, BODY_FLAG.NONE);
  };
  const result = assertAllocationFree(fn, { iterations: 2000, maxRounds: 300 });
  // eslint-disable-next-line no-console
  console.log(`[phys2] setBody+setBodyFlags: ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
  assert.ok(result.bytesPerCall < 1);
});

// ---------------------------------------------------------------------------
// Determinism — the same call sequence gives the same results
// ---------------------------------------------------------------------------

test('two independently built PhysicsSystem instances fed an identical setup and call sequence produce identical MoveResults at every step', async () => {
  async function build() {
    const { phys } = await makePhysics();
    phys.addStatic({ kind: 'box', x: 5, z: 0, halfW: 0.5, halfL: 50 }, 'stone');
    phys.addStatic({ kind: 'box', x: 0, z: 5, halfW: 50, halfL: 0.5 }, 'stone');
    phys.addStatic({ kind: 'box', x: 3, z: -3, y: 0, height: STEP_HEIGHT_MAX, halfW: 1, halfL: 1 }, 'stone');
    phys.rebuild();
    const id = phys.addBody(1, 0, -3, BODY_RADIUS, BODY_HEIGHT, 80, 2);
    return { phys, id };
  }

  const A = await build();
  const B = await build();

  for (let i = 0; i < 100; i++) {
    const rA = A.phys.moveBody(A.id, 0.06, 0.04);
    const rB = B.phys.moveBody(B.id, 0.06, 0.04);
    assert.equal(rA.x, rB.x, `step ${i}: x diverged`);
    assert.equal(rA.z, rB.z, `step ${i}: z diverged`);
    assert.equal(rA.blocked, rB.blocked, `step ${i}: blocked diverged`);
    assert.equal(rA.slid, rB.slid, `step ${i}: slid diverged`);
    assert.equal(rA.hitStatic, rB.hitStatic, `step ${i}: hitStatic diverged`);
  }
});

// ---------------------------------------------------------------------------
// BodyStore is independently usable (decoupled from PhysicsSystem/index.js)
// ---------------------------------------------------------------------------

test('BodyStore is usable standalone against a hand-built StaticsSource stub, with no PhysicsSystem involved', () => {
  // Proves body.js never reaches into src/physics/index.js — a minimal
  // duck-typed StaticsSource with zero statics is enough for BodyStore to
  // function (this is also, incidentally, the "no candidates" fast path).
  const store = new BodyStore(4);
  const stubGrid = {
    cellIndexX: (x) => Math.floor(x / 2),
    cellIndexZ: (z) => Math.floor(z / 2),
    forEachInCell() {}, // nothing hashed — always empty
  };
  const source = {
    grid: stubGrid,
    kindCode: new Uint8Array(0),
    x: new Float64Array(0),
    z: new Float64Array(0),
    y: new Float64Array(0),
    height: new Float64Array(0),
    halfW: new Float64Array(0),
    halfL: new Float64Array(0),
    radius: new Float64Array(0),
    facing: new Float64Array(0),
    polyPoints: [],
    alive: new Uint8Array(0),
  };
  const id = store.add(1, 0, 0, BODY_RADIUS, BODY_HEIGHT, 80, 2);
  assert.equal(id, 1);
  const r = store.moveBody(id, 1, 1, source);
  assert.equal(r.blocked, false);
  assert.equal(r.x, 1);
  assert.equal(r.z, 1);
});
