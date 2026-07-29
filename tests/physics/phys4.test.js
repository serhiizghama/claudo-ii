// tests/physics/phys4.test.js
//
// PHYS-4 acceptance tests for src/physics/separate.js and the `separate()`
// method forwarded through src/physics/index.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// Scope: the crowd push-out pass — mass-weighted correction splitting,
// `NO_COLLIDE` exclusion (D2), the coincident-centres degenerate case (D4),
// `iterations` semantics (D5: <=0 / non-finite / fractional), zero-
// allocation (12.A01), determinism, `stats.separationMs`, and this ticket's
// own acceptance criterion: 40 bodies in a 6 m circle resolve within a
// 0.4 ms budget per call and never overlap by more than 1 cm. Statics/grid/
// bodies/moveBody/casts themselves are PHYS-1/2/3's own test files — not
// re-tested here except where a scenario needs them as fixtures (none do:
// separation never touches statics).

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsSystem, BODY_FLAG } from '../../src/physics/index.js';
import { SKIN_WIDTH } from '../../src/physics/separate.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

const BODY_HEIGHT = 1.8;
/** A resolved pair's centre distance lands at `combinedRadius + SKIN_WIDTH`
 * (see `separate.js`'s own `SKIN_WIDTH` comment) — exact contact plus the
 * tiny extra push that keeps a just-resolved pair from re-reporting as
 * overlapping next call. Assertions below check against this exact value,
 * not a guessed tolerance. */
function expectedContactDist(rsum) {
  return rsum + SKIN_WIDTH;
}

/** A minimal `ctx`, matching PHYS-1/2/3's own `makeCtx()`; `maxActors`
 * sizes the body store exactly (see `body.js`'s own `init()` comment) so a
 * test's body count and the store's `capacity` (what `separate()`'s nested
 * loop actually iterates) are the same number. */
function makeCtx(maxActors) {
  return { events: new EventBus(), config: { q: { maxActors } } };
}

async function makePhysics(maxActors) {
  const ctx = makeCtx(maxActors);
  const phys = new PhysicsSystem();
  await phys.init(ctx);
  return { phys, ctx };
}

/** Euclidean distance between two bodies read straight off the live typed
 * arrays — deliberately not going through any public API, since there is
 * no public "distance between two bodies" query and this file needs one for
 * its own assertions. */
function bodyDist(phys, idA, idB) {
  const b = phys._bodies;
  const dx = b._x[idB - 1] - b._x[idA - 1];
  const dz = b._z[idB - 1] - b._z[idA - 1];
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// Basic push-out behaviour
// ---------------------------------------------------------------------------

test('two overlapping equal-mass bodies split the correction 50/50 and end up exactly touching', async () => {
  const { phys } = await makePhysics(8);
  const a = phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  const b = phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  // Overlap: distance 0.4, combined radius 0.6.

  phys.separate(1);

  const bodies = phys._bodies;
  const ax = bodies._x[a - 1];
  const bx = bodies._x[b - 1];
  // Symmetric split around the original midpoint (x = 0), each moved by
  // the same amount in opposite directions.
  assert.ok(Math.abs(ax - -bx) < 1e-9, `expected a symmetric split, got ax=${ax}, bx=${bx}`);
  assert.ok(Math.abs(bodyDist(phys, a, b) - expectedContactDist(0.6)) < 1e-9, `expected exact contact (${expectedContactDist(0.6)} m), got ${bodyDist(phys, a, b)}`);
});

test('mass weighting: a heavier body moves less than a lighter one, and the correction still fully resolves the overlap', async () => {
  const { phys } = await makePhysics(8);
  const heavy = phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 300, 2);
  const light = phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 30, 2);

  phys.separate(1);

  const bodies = phys._bodies;
  const heavyMoved = Math.abs(bodies._x[heavy - 1] - -0.2);
  const lightMoved = Math.abs(bodies._x[light - 1] - 0.2);
  assert.ok(heavyMoved < lightMoved, `expected heavy (${heavyMoved}) to move less than light (${lightMoved})`);
  // D3's exact ratio: heavyMoved/lightMoved == lightMass/heavyMass == 30/300 == 0.1
  assert.ok(Math.abs(heavyMoved / lightMoved - 30 / 300) < 1e-6, `expected the 30:300 mass ratio to be honoured exactly, got ${heavyMoved / lightMoved}`);
  assert.ok(Math.abs(bodyDist(phys, heavy, light) - expectedContactDist(0.6)) < 1e-9, 'overlap still fully resolved');
});

test('D3 — a mass <= 0 body is treated as immovable: it does not move, the other body absorbs the whole correction', async () => {
  const { phys } = await makePhysics(8);
  const anchor = phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 0, 2); // mass 0 -> immovable
  const mover = phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 80, 2);

  phys.separate(1);

  const bodies = phys._bodies;
  assert.equal(bodies._x[anchor - 1], -0.2, 'the mass<=0 anchor must not move at all');
  assert.ok(Math.abs(bodyDist(phys, anchor, mover) - expectedContactDist(0.6)) < 1e-9, 'overlap still fully resolved by the movable body alone');
});

test('D3 — two mass <= 0 bodies overlapping resolve to nothing (no NaN, no movement, documented no-op)', async () => {
  const { phys } = await makePhysics(8);
  const a = phys.addBody(1, -0.1, 0, 0.3, BODY_HEIGHT, 0, 2);
  const b = phys.addBody(2, 0.1, 0, 0.3, BODY_HEIGHT, 0, 2);

  phys.separate(4);

  const bodies = phys._bodies;
  assert.equal(bodies._x[a - 1], -0.1);
  assert.equal(bodies._x[b - 1], 0.1);
  assert.ok(Number.isFinite(bodies._x[a - 1]) && Number.isFinite(bodies._x[b - 1]));
});

test('D4 — two bodies at exactly the same point separate deterministically along +X, never NaN', async () => {
  const { phys } = await makePhysics(8);
  const a = phys.addBody(1, 5, 5, 0.3, BODY_HEIGHT, 80, 2);
  const b = phys.addBody(2, 5, 5, 0.3, BODY_HEIGHT, 80, 2);

  phys.separate(1);

  const bodies = phys._bodies;
  assert.ok(Number.isFinite(bodies._x[a - 1]) && Number.isFinite(bodies._z[a - 1]));
  assert.ok(Number.isFinite(bodies._x[b - 1]) && Number.isFinite(bodies._z[b - 1]));
  assert.ok(bodies._x[a - 1] < 5 && bodies._x[b - 1] > 5, 'expected a deterministic +X split for coincident centres');
  assert.equal(bodies._z[a - 1], 5, 'no Z drift for a purely +X degenerate separation');
  assert.equal(bodies._z[b - 1], 5);
  assert.ok(Math.abs(bodyDist(phys, a, b) - expectedContactDist(0.6)) < 1e-9);
});

test('D2 — a NO_COLLIDE body neither pushes nor is pushed: both bodies stay put', async () => {
  const { phys } = await makePhysics(8);
  const ghost = phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  const solid = phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  phys.setBodyFlags(ghost, BODY_FLAG.NO_COLLIDE);

  phys.separate(4);

  const bodies = phys._bodies;
  assert.equal(bodies._x[ghost - 1], -0.2, 'a NO_COLLIDE body must not be pushed');
  assert.equal(bodies._x[solid - 1], 0.2, 'a NO_COLLIDE body must not push its overlap partner either');
});

test('D1 — a flying body still participates in separation against a grounded body (purely horizontal, XZ-plane push-out)', async () => {
  const { phys } = await makePhysics(8);
  const flyer = phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  const grounded = phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  phys.setBodyFlags(flyer, BODY_FLAG.FLYING);

  phys.separate(1);

  assert.ok(Math.abs(bodyDist(phys, flyer, grounded) - expectedContactDist(0.6)) < 1e-9, 'a flying body must still resolve horizontal overlap like a grounded one');
});

test('non-overlapping bodies are left untouched', async () => {
  const { phys } = await makePhysics(8);
  const a = phys.addBody(1, -5, 0, 0.3, BODY_HEIGHT, 80, 2);
  const b = phys.addBody(2, 5, 0, 0.3, BODY_HEIGHT, 80, 2);

  phys.separate(4);

  const bodies = phys._bodies;
  assert.equal(bodies._x[a - 1], -5);
  assert.equal(bodies._x[b - 1], 5);
});

// ---------------------------------------------------------------------------
// D5 — `iterations` semantics
// ---------------------------------------------------------------------------

test('D5 — iterations <= 0 (and non-finite input) is a safe no-op: positions unchanged, stats.separationMs still updated', async () => {
  const { phys } = await makePhysics(8);
  const a = phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  const b = phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 80, 2);

  for (const value of [0, -1, -100, NaN, Infinity, -Infinity]) {
    phys.separate(value);
    const bodies = phys._bodies;
    assert.equal(bodies._x[a - 1], -0.2, `iterations=${value} must not move bodies`);
    assert.equal(bodies._x[b - 1], 0.2, `iterations=${value} must not move bodies`);
    assert.ok(Number.isFinite(phys.stats.separationMs), `iterations=${value} must still leave stats.separationMs a real number`);
  }
});

test('D5 — a fractional iterations truncates toward zero (2.9 behaves exactly like 2)', async () => {
  const { phys: physA } = await makePhysics(8);
  const { phys: physB } = await makePhysics(8);
  const aA = physA.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  const bA = physA.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 30, 2);
  const aB = physB.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  const bB = physB.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 30, 2);

  physA.separate(2.9);
  physB.separate(2);

  assert.equal(physA._bodies._x[aA - 1], physB._bodies._x[aB - 1]);
  assert.equal(physA._bodies._x[bA - 1], physB._bodies._x[bB - 1]);
});

// ---------------------------------------------------------------------------
// stats.separationMs
// ---------------------------------------------------------------------------

test('stats returns the same object identity every call (Alloc: no), and separationMs is a real, non-negative number after separate()', async () => {
  const { phys } = await makePhysics(8);
  phys.addBody(1, -0.2, 0, 0.3, BODY_HEIGHT, 80, 2);
  phys.addBody(2, 0.2, 0, 0.3, BODY_HEIGHT, 80, 2);

  const s1 = phys.stats;
  phys.separate(2);
  const s2 = phys.stats;
  assert.equal(s1, s2, 'stats must be the same object identity every call');
  assert.ok(Number.isFinite(phys.stats.separationMs) && phys.stats.separationMs >= 0);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('two identical setups fed the same iterations, repeated the same number of times, produce bit-identical positions', async () => {
  const N = 24;
  const { phys: physA } = await makePhysics(N);
  const { phys: physB } = await makePhysics(N);
  const rng = new Rng(SEEDS.a);
  const specs = [];
  for (let i = 0; i < N; i++) {
    const p = rng.disc(3.0);
    specs.push({ x: p.x, z: p.z, radius: 0.25 + rng.next() * 0.15, mass: 40 + rng.next() * 80 });
  }
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    physA.addBody(i + 1, s.x, s.z, s.radius, BODY_HEIGHT, s.mass, 2);
    physB.addBody(i + 1, s.x, s.z, s.radius, BODY_HEIGHT, s.mass, 2);
  }

  for (let step = 0; step < 50; step++) {
    physA.separate(4);
    physB.separate(4);
  }

  for (let i = 0; i < N; i++) {
    assert.equal(physA._bodies._x[i], physB._bodies._x[i], `slot ${i} x diverged`);
    assert.equal(physA._bodies._z[i], physB._bodies._z[i], `slot ${i} z diverged`);
  }
});

// ---------------------------------------------------------------------------
// 12.A01 — zero allocation
// ---------------------------------------------------------------------------

test('12.A01 — separate() allocates nothing, even while actively resolving overlap every call', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc` to measure heap allocation — skipping the allocation assertion');
    return;
  }
  return (async () => {
    const N = 24;
    const { phys } = await makePhysics(N);
    const rng = new Rng(SEEDS.b);
    for (let i = 0; i < N; i++) {
      const p = rng.disc(2.0); // deliberately dense — every call has real overlap to resolve
      phys.addBody(i + 1, p.x, p.z, 0.3, BODY_HEIGHT, 40 + rng.next() * 80, 2);
    }

    const fn = () => {
      phys.separate(4);
    };

    const result = assertAllocationFree(fn, { iterations: 20_000, maxRounds: 20 });
    // eslint-disable-next-line no-console
    console.log(`[phys4] separate() (24 bodies, dense, 4 iterations): ${result.bytesPerCall.toFixed(4)} bytes/call, ${result.rounds} round(s)`);
    assert.ok(result.bytesPerCall < 1);
  })();
});

// ---------------------------------------------------------------------------
// Acceptance criterion — 40 bodies in a 6 m circle: <= 0.4 ms/call, never
// overlap by more than 1 cm.
// ---------------------------------------------------------------------------
//
// "6 m circle" is read as a 6 m DIAMETER disc (radius 3 m) — assigned,
// absent from the ticket's own wording; a 3 m-radius packing of 40 bodies
// (radius 0.25-0.40 m each) is dense enough to guarantee heavy initial
// overlap for a meaningful stress test, whereas a 6 m-RADIUS disc would be
// sparse enough that many placements would not overlap at all. See this
// ticket's report.
//
// Each scenario is timed on an ALREADY JIT-warm `separate()` (a throwaway,
// differently-seeded 40-body scene runs several thousand separate() calls
// first) but a numerically FRESH, fully-overlapping target scene — this is
// the realistic worst case (the engine has been running for a while, so
// separate()'s code is warm, but this particular batch of bodies has never
// been separated before, e.g. a monster pack just spawned on top of each
// other). Five independent seeds, 200 fixed-step calls each (1000 timed
// calls total) — see the report for the full spread (min/mean/p99/max).

const ARENA_RADIUS = 3.0; // 6 m diameter
const CROWD_SIZE = 40;
const STEP_ITERATIONS = 4;
const STEPS_PER_RUN = 200;
const WARMUP_CALLS = 3000;
const TIME_BUDGET_MS = 0.4;
const MAX_OVERLAP_M = 0.01;

function buildCrowdSpecs(seed, n) {
  const rng = new Rng(seed);
  const specs = [];
  for (let i = 0; i < n; i++) {
    const p = rng.disc(ARENA_RADIUS);
    specs.push({ x: p.x, z: p.z, radius: 0.25 + rng.next() * 0.15, mass: 40 + rng.next() * 80 });
  }
  return specs;
}

async function buildCrowdPhysics(specs) {
  const { phys } = await makePhysics(specs.length);
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    phys.addBody(i + 1, s.x, s.z, s.radius, BODY_HEIGHT, s.mass, 2);
  }
  return phys;
}

function maxPairwiseOverlap(phys, n) {
  const b = phys._bodies;
  let maxOverlap = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = b._x[j] - b._x[i];
      const dz = b._z[j] - b._z[i];
      const dist = Math.sqrt(dx * dx + dz * dz);
      const overlap = b._radius[i] + b._radius[j] - dist;
      if (overlap > maxOverlap) maxOverlap = overlap;
    }
  }
  return maxOverlap;
}

test(`acceptance — ${CROWD_SIZE} bodies in a 6 m circle: each separate() call <= ${TIME_BUDGET_MS} ms, and after simulated fixed steps no pair overlaps by more than ${MAX_OVERLAP_M * 100} cm`, async () => {
  const allTimings = [];
  const perSeedMaxOverlap = [];

  for (let seedIndex = 0; seedIndex < 5; seedIndex++) {
    const seed = 0x9000 + seedIndex;

    // Warm the JIT on a throwaway, differently-seeded scene of the same
    // shape/size, so the timed run below measures steady-state cost, not
    // one-time inline-cache setup (O-23's own lesson, applied to timing
    // rather than allocation).
    const warmSpecs = buildCrowdSpecs(seed + 0xF00, CROWD_SIZE);
    const warmPhys = await buildCrowdPhysics(warmSpecs);
    for (let i = 0; i < WARMUP_CALLS; i++) warmPhys.separate(STEP_ITERATIONS);

    const specs = buildCrowdSpecs(seed, CROWD_SIZE);
    const phys = await buildCrowdPhysics(specs);

    for (let step = 0; step < STEPS_PER_RUN; step++) {
      phys.separate(STEP_ITERATIONS);
      allTimings.push(phys.stats.separationMs);
    }

    perSeedMaxOverlap.push(maxPairwiseOverlap(phys, CROWD_SIZE));
  }

  const sorted = [...allTimings].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = allTimings.reduce((a, b) => a + b, 0) / allTimings.length;
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  // eslint-disable-next-line no-console
  console.log(
    `[phys4] acceptance: ${allTimings.length} separate() calls across 5 seeds — ` +
      `min=${min.toFixed(4)}ms mean=${mean.toFixed(4)}ms p99=${p99.toFixed(4)}ms max=${max.toFixed(4)}ms ` +
      `(budget ${TIME_BUDGET_MS} ms); per-seed max overlap: ${perSeedMaxOverlap.map((o) => o.toFixed(6)).join(', ')} m`,
  );

  assert.ok(max <= TIME_BUDGET_MS, `expected every separate() call <= ${TIME_BUDGET_MS} ms, worst was ${max.toFixed(4)} ms`);
  for (const overlap of perSeedMaxOverlap) {
    assert.ok(overlap <= MAX_OVERLAP_M, `expected max overlap <= ${MAX_OVERLAP_M} m, got ${overlap}`);
  }
});
