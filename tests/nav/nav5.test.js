// tests/nav/nav5.test.js
//
// NAV-5 acceptance tests for src/nav/snap.js and the one-line wiring it gets
// in src/nav/index.js (`snap`). `node:test` + `node:assert/strict` only
// (12-testing.md P6). Per O-27, every assertion is on real snapped-point
// behaviour — never on "the object exists" or an empty-shape check, and this
// file writes no "scope" test (O-27/O-39 — see this ticket's own brief).
//
// Scope: the ticket's literal acceptance criterion — `snap` returns `null`
// when nothing walkable lies within `maxRadius` — plus everything the
// ticket's brief says will be probed hard: I3 (`snap(p,0)` on an already-
// walkable `p` returns `p` unchanged, coordinate for coordinate, not a cell
// centre), a brute-force proof that the returned point really is nearest
// (not merely walkable), deterministic tie-breaking, the `out`/no-`out`
// allocation convention, degenerate input (`NaN`, negative `maxRadius`, far
// out-of-grid), that the result is genuinely walkable, and that a nearer
// point in a different, disconnected region IS returned (region is
// deliberately not filtered — see `src/nav/snap.js`'s own header).
//
// Per O-38, every grid here is built directly (hand-written `NavGrid`s) or
// via `NavSystem.rebuild(zone)` against a stub `world` (`tests/nav/
// nav1.test.js`'s own pattern) — never through `world.enterZone`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import { createNavGrid, createRasterScratch, passN7Regions, NAV_FLAG, cellIndexAt } from '../../src/nav/grid.js';
import { snapPoint } from '../../src/nav/snap.js';
import { makeStubCtx } from '../helpers/actor.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Rng } from '../../src/core/rng.js';
import { SEEDS } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// Helpers — the same shape tests/nav/nav1-4.test.js's own makeStubWorld/
// makeNav/makeZone use, redefined here (not exported by those files).
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

/**
 * Builds a `NavGrid` directly from an ASCII layout (row 0 = z=0, first
 * character = x=0) — `tests/nav/nav2.test.js`'s own `buildGridFromLayout`
 * pattern, redefined here. `'#'` = blocked; anything else = walkable, cost 1.
 * @param {string[]} rows @param {{cellSize?:number}} [opts]
 * @returns {object} a NavGrid, `version` set to 1.
 */
function buildGridFromLayout(rows, { cellSize = 0.5 } = {}) {
  const height = rows.length;
  const width = rows[0].length;
  const grid = createNavGrid({ cellSize, width, height, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(width, height);
  for (let cz = 0; cz < height; cz++) {
    const row = rows[cz];
    for (let cx = 0; cx < width; cx++) {
      const i = cz * width + cx;
      if (row[cx] === '#') {
        grid.flags[i] = 0;
      } else {
        grid.flags[i] = NAV_FLAG.walkable;
      }
    }
  }
  passN7Regions(grid, scratch);
  grid.version = 1;
  return grid;
}

/**
 * A independently-written, whole-grid brute-force nearest-walkable-point
 * scan — deliberately NOT sharing code with `src/nav/snap.js`'s own box
 * search, so this is a real cross-check rather than the same algorithm
 * asserting against itself. Scans every single cell in the grid (not a
 * radius-bounded box), which is exactly the "brute-force scan of every
 * walkable cell" this ticket's brief says the orchestrator will run.
 * @param {object} grid @param {number} x @param {number} z @param {number} maxRadius
 * @returns {{x:number,z:number,distSq:number} | null}
 */
function bruteForceNearest(grid, x, z, maxRadius) {
  const maxRadiusSq = maxRadius * maxRadius;
  let bestSq = Infinity;
  let bestX = 0;
  let bestZ = 0;
  let found = false;
  for (let cz = 0; cz < grid.height; cz++) {
    const cellMinZ = grid.originZ + cz * grid.cellSize;
    const cellMaxZ = cellMinZ + grid.cellSize;
    const clampedZ = z < cellMinZ ? cellMinZ : z > cellMaxZ ? cellMaxZ : z;
    for (let cx = 0; cx < grid.width; cx++) {
      const idx = cz * grid.width + cx;
      if ((grid.flags[idx] & NAV_FLAG.walkable) === 0) continue;
      const cellMinX = grid.originX + cx * grid.cellSize;
      const cellMaxX = cellMinX + grid.cellSize;
      const clampedX = x < cellMinX ? cellMinX : x > cellMaxX ? cellMaxX : x;
      const dx = clampedX - x;
      const dz = clampedZ - z;
      const distSq = dx * dx + dz * dz;
      if (distSq > maxRadiusSq) continue;
      if (distSq < bestSq) {
        bestSq = distSq;
        bestX = clampedX;
        bestZ = clampedZ;
        found = true;
      }
    }
  }
  return found ? { x: bestX, z: bestZ, distSq: bestSq } : null;
}

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION — null when nothing walkable is within maxRadius.
// ---------------------------------------------------------------------------

test('MAIN: snap returns null when the whole maxRadius neighbourhood is blocked', () => {
  // A 3x3 m all-blocked grid, query at the centre — no walkable cell exists
  // anywhere in the grid, let alone within maxRadius.
  const grid = buildGridFromLayout(['######', '######', '######', '######', '######', '######']);
  const result = snapPoint(grid, 1.5, 1.5, 2.0, {});
  assert.equal(result, null, 'a query whose entire neighbourhood is blocked must return null, never undefined or a sentinel point');
  assert.notEqual(result, undefined, 'null, not undefined — the two are not interchangeable for a caller doing `=== null`');
});

test('MAIN: snap(p, 0.0) on a BLOCKED point returns null, not the nearest walkable cell', () => {
  const grid = buildGridFromLayout(['.#.', '.#.', '.#.']);
  // Centre of the blocked middle column (cx=1) — walkable cells exist one
  // cell away on both sides, but maxRadius=0 gives no room to reach them.
  const result = snapPoint(grid, 0.75, 0.75, 0.0, {});
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// I3 (07-world-gen.md §7.1) — snap(p, 0.0) on an already-walkable p returns
// p UNCHANGED, coordinate for coordinate — not a cell centre, not a
// neighbour.
// ---------------------------------------------------------------------------

test('MAIN: I3 — snap(p, 0.0) on a walkable, off-centre point returns p unchanged', () => {
  const grid = buildGridFromLayout(['.....', '.....', '.....', '.....', '.....']);
  grid.groundY[2 * grid.width + 2] = 3.25; // arbitrary, non-zero, to prove y is read from the grid, not left at 0
  // A point deliberately NOT at a cell centre (cell (2,2) covers x,z in
  // [1.0,1.5)) — 0.5 would be the centre; 1.13/1.41 are not.
  const x = 1.13;
  const z = 1.41;
  const result = snapPoint(grid, x, z, 0.0, {});
  assert.notEqual(result, null, 'test setup: the query point must itself be walkable');
  assert.equal(result.x, x, 'I3: x must be returned unchanged, bit for bit');
  assert.equal(result.z, z, 'I3: z must be returned unchanged, bit for bit');
  assert.equal(result.y, 3.25, 'y must come from the grid\'s own groundY at the containing cell');
});

test('I3 holds at every maxRadius, not just 0 — a walkable point is its own nearest point regardless of search budget', () => {
  const grid = buildGridFromLayout(['.....', '.....', '.....', '.....', '.....']);
  const x = 1.13;
  const z = 1.41;
  for (const maxRadius of [0, 0.1, 1.0, 5.0]) {
    const result = snapPoint(grid, x, z, maxRadius, {});
    assert.equal(result.x, x, `maxRadius=${maxRadius}: x must stay unchanged`);
    assert.equal(result.z, z, `maxRadius=${maxRadius}: z must stay unchanged`);
  }
});

// ---------------------------------------------------------------------------
// The result must be walkable.
// ---------------------------------------------------------------------------

test('every non-null snap result lands on a walkable cell', () => {
  const grid = buildGridFromLayout(['#####', '#.#.#', '#####', '#.#.#', '#####']);
  const rng = new Rng(SEEDS.a);
  let checkedAtLeastOneHit = false;
  for (let i = 0; i < 200; i++) {
    const x = rng.range(-1, 3);
    const z = rng.range(-1, 3);
    const maxRadius = rng.range(0, 3);
    const result = snapPoint(grid, x, z, maxRadius, {});
    if (result === null) continue;
    checkedAtLeastOneHit = true;
    const cx = Math.floor((result.x - grid.originX) / grid.cellSize);
    const cz = Math.floor((result.z - grid.originZ) / grid.cellSize);
    assert.ok(cx >= 0 && cx < grid.width && cz >= 0 && cz < grid.height, `result (${result.x},${result.z}) must land inside the grid`);
    const idx = cz * grid.width + cx;
    assert.ok((grid.flags[idx] & NAV_FLAG.walkable) !== 0, `result (${result.x},${result.z}) must land on a walkable cell`);
  }
  assert.ok(checkedAtLeastOneHit, 'test setup: at least one random query must have found a real result');
});

// ---------------------------------------------------------------------------
// "Nearest really means nearest" — brute-force comparison over many random
// points, against an independently-written whole-grid scan.
// ---------------------------------------------------------------------------

test('MAIN: over many random points, snap matches an independent brute-force nearest-walkable-cell scan exactly', () => {
  const width = 30;
  const height = 30;
  const grid = createNavGrid({ cellSize: 0.5, width, height, originX: -3, originZ: -2 });
  const scratch = createRasterScratch(width, height);
  // A deterministic, scattered blocked pattern — NOT drawn from ctx.rng
  // (this is a fixed layout, not a gameplay roll), and not a rectangular
  // wall — enough irregularity that a caller returning "a" walkable cell
  // rather than THE nearest one would very likely disagree with the brute
  // force on at least a few of the 300 samples below.
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const idx = cz * width + cx;
      const blocked = (cx * 31 + cz * 17) % 6 === 0;
      grid.flags[idx] = blocked ? 0 : NAV_FLAG.walkable;
    }
  }
  passN7Regions(grid, scratch);
  grid.version = 1;

  const rng = new Rng(SEEDS.b);
  const SAMPLES = 300;
  let compared = 0;
  let bothNull = 0;
  for (let i = 0; i < SAMPLES; i++) {
    // A mix of in-grid, near-edge and genuinely out-of-grid queries.
    const x = rng.range(-5, 15);
    const z = rng.range(-5, 15);
    const maxRadius = rng.bool() ? 0 : rng.range(0, 4);

    const expected = bruteForceNearest(grid, x, z, maxRadius);
    const actual = snapPoint(grid, x, z, maxRadius, {});

    if (expected === null) {
      assert.equal(actual, null, `sample ${i}: (${x},${z}) r=${maxRadius} — brute force found nothing, snap must also return null`);
      bothNull++;
    } else {
      assert.notEqual(actual, null, `sample ${i}: (${x},${z}) r=${maxRadius} — brute force found ${JSON.stringify(expected)}, snap returned null`);
      // Tolerance a little above src/nav/snap.js's own CELL_EDGE_EPSILON
      // (1e-4): this test's own bruteForceNearest (deliberately independent
      // of snap.js) clamps to the TRUE closed-interval cell edge, while the
      // real implementation nudges a clamp-to-upper-edge result inward by up
      // to CELL_EDGE_EPSILON so it can never round into a blocked neighbour
      // (see that file's own header) — so an exact bit-for-bit match is not
      // the right check here, "within a fraction of a millimetre" is.
      assert.ok(
        Math.abs(actual.x - expected.x) < 5e-4 && Math.abs(actual.z - expected.z) < 5e-4,
        `sample ${i}: (${x},${z}) r=${maxRadius} — expected (${expected.x},${expected.z}) distSq=${expected.distSq}, got (${actual.x},${actual.z})`,
      );
    }
    compared++;
  }
  assert.equal(compared, SAMPLES, 'test setup: every sample must actually be compared');
  assert.ok(bothNull < SAMPLES, 'test setup: at least some samples must have found a real result (not every query starved)');
  assert.ok(bothNull > 0, 'test setup: at least some samples must genuinely find nothing (radius 0 on a blocked cell, or a far miss) — otherwise the null path is not exercised here');
});

// ---------------------------------------------------------------------------
// Deterministic tie-breaking.
// ---------------------------------------------------------------------------

test('tie-break rule: among equidistant walkable cells, the one earliest in row-major (cz ascending, then cx ascending) scan order wins, every time', () => {
  // Single row (cz=0), width=3: cx=0 and cx=2 walkable, cx=1 blocked. A
  // query centred exactly in cx=1's cell is equidistant (0.25 m) from both
  // neighbours' near edges — a genuine tie.
  const grid = buildGridFromLayout(['.#.']);
  const x = 0.75; // centre of cx=1's [0.5,1.0) cell
  const z = 0.25; // centre of the only row
  const maxRadius = 0.5;

  const bf = bruteForceNearest(grid, x, z, maxRadius);
  assert.notEqual(bf, null, 'test setup: both neighbours must be within maxRadius');

  for (let trial = 0; trial < 5; trial++) {
    const result = snapPoint(grid, x, z, maxRadius, {});
    // The lower-cx candidate (cx=0's right edge, near x=0.5) must win over
    // the higher-cx candidate (cx=2's left edge, x=1.0) — stated rule: first
    // encountered in ascending scan order, since neither replaces the other
    // on a merely-equal distance. Compared with a tolerance a little above
    // src/nav/snap.js's own CELL_EDGE_EPSILON (1e-4): the winning coordinate
    // is nudged inward off the true cell edge by up to that much so it can
    // never round back into the (here: blocked) neighbouring cell — see that
    // file's own header, "CELL_EDGE_EPSILON".
    assert.ok(Math.abs(result.x - 0.5) < 5e-4, `trial ${trial}: the LOWER-cx equidistant candidate must win the tie, every call — got x=${result.x}`);
    assert.ok(result.x < 1.0, `trial ${trial}: must not have picked the HIGHER-cx candidate (x near 1.0)`);
    assert.equal(result.z, z);
    assert.ok((grid.flags[cellIndexAt(grid, result.x, result.z)] & NAV_FLAG.walkable) !== 0, `trial ${trial}: the tie-break winner must itself be walkable`);
  }
});

// ---------------------------------------------------------------------------
// Region — deliberately NOT filtered. A nearer point in a different,
// disconnected region is returned in preference to a farther same-"side"
// candidate.
// ---------------------------------------------------------------------------

test('a nearer walkable point in a different, disconnected region is returned — snap does not filter by region', () => {
  // cx 0-2: region A (open block). cx=3: wall (disconnects). cx=4: a single
  // isolated walkable cell — region B.
  const grid = buildGridFromLayout(['...#.', '...#.', '...#.']);
  const regionA = grid.region[1 * grid.width + 1];
  const regionB = grid.region[1 * grid.width + 4];
  assert.ok(regionA >= 0 && regionB >= 0 && regionA !== regionB, 'test setup: region A and region B must be real, distinct, non-blocked regions');

  // Query deep in the wall cell (cx=3), 0.01 m from region B's edge and
  // 0.49 m from region A's edge — region B is unambiguously nearer.
  const x = grid.originX + 3 * grid.cellSize + 0.49;
  const z = grid.originZ + 1 * grid.cellSize + 0.25;
  const result = snapPoint(grid, x, z, 0.6, {});
  assert.notEqual(result, null);

  const resultCx = Math.floor((result.x - grid.originX) / grid.cellSize);
  const resultCz = Math.floor((result.z - grid.originZ) / grid.cellSize);
  const resultRegion = grid.region[resultCz * grid.width + resultCx];
  assert.equal(resultRegion, regionB, 'the nearer point (region B) must win even though it is disconnected from region A');
  assert.notEqual(resultRegion, regionA, 'confirms the returned point is genuinely in the OTHER region, not A');
});

// ---------------------------------------------------------------------------
// out / no-out allocation convention.
// ---------------------------------------------------------------------------

test('with out supplied, snap writes into it and returns the SAME object — never a fresh allocation', () => {
  const grid = buildGridFromLayout(['.....']);
  const out = { x: -999, y: -999, z: -999 };
  const result = snapPoint(grid, 1.13, 0.25, 0.0, out);
  assert.equal(result, out, 'the returned object must be reference-identical to the caller-supplied out');
  assert.equal(out.x, 1.13);
  assert.equal(out.z, 0.25);
});

test('a null result never writes into the caller-supplied out — no half-written buffer on failure', () => {
  const grid = buildGridFromLayout(['#####']);
  const out = { x: 111, y: 222, z: 333 };
  const result = snapPoint(grid, 1.25, 0.25, 0.0, out);
  assert.equal(result, null);
  assert.equal(out.x, 111, 'out must be untouched when snap fails to find anything');
  assert.equal(out.y, 222);
  assert.equal(out.z, 333);
});

test('through NavSystem, omitting out reuses ONE shared scratch object across calls — the next call overwrites it, matching pathNode/flowAt', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 })); // fully open placeholder-derived grid

  const first = nav.snap(1.0, 1.0, 0.0);
  assert.notEqual(first, null);
  const firstRef = first;
  assert.equal(firstRef.x, 1.0);

  const second = nav.snap(2.0, 2.0, 0.0);
  assert.equal(second, firstRef, 'no-out calls must reuse the SAME shared object every time (Alloc: no)');
  // The documented consequence of sharing: reading `first` again now sees
  // the SECOND call's values, not the first's — a caller that needs to keep
  // the first result must copy it out, exactly `pathNode`'s own convention.
  assert.equal(first.x, 2.0, 'the shared scratch has been overwritten by the second call — this is documented, not a leak');
});

test('through NavSystem, supplying out keeps results independent across two calls', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));

  const outA = { x: 0, y: 0, z: 0 };
  const outB = { x: 0, y: 0, z: 0 };
  nav.snap(1.0, 1.0, 0.0, outA);
  nav.snap(2.0, 2.0, 0.0, outB);
  assert.equal(outA.x, 1.0, 'outA must retain its own result — caller-supplied out is never shared across calls');
  assert.equal(outB.x, 2.0);
});

test('12.Axx snap is allocation-free, with and without out', { skip: !hasGc() && 'run with --expose-gc' }, () => {
  const grid = buildGridFromLayout(['.....', '.....', '.....', '.....', '.....']);
  const out = { x: 0, y: 0, z: 0 };

  const r1 = assertAllocationFree(() => snapPoint(grid, 1.13, 1.41, 0.0, out), { iterations: 10_000 });
  assert.ok(r1.bytesPerCall < 1, `snap (already-walkable fast path, with out) must not allocate, was ${r1.bytesPerCall} B/call`);

  const r2 = assertAllocationFree(() => snapPoint(grid, 1.13, 1.41, 2.0, out), { iterations: 10_000 });
  assert.ok(r2.bytesPerCall < 1, `snap (box search, with out) must not allocate, was ${r2.bytesPerCall} B/call`);
});

// ---------------------------------------------------------------------------
// Degenerate input — never throws.
// ---------------------------------------------------------------------------

test('degenerate input never throws: NaN coordinates/radius, negative radius, and far-out-of-grid points all resolve to null or a real answer, never an exception', () => {
  const grid = buildGridFromLayout(['.....', '.....', '.....', '.....', '.....']);

  assert.doesNotThrow(() => assert.equal(snapPoint(grid, NaN, 0, 1.0, {}), null, 'NaN x -> null'));
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, 0, NaN, 1.0, {}), null, 'NaN z -> null'));
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, 0, 0, NaN, {}), null, 'NaN maxRadius -> null'));
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, Infinity, 0, 1.0, {}), null, 'Infinity x -> null'));
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, 0, 0, Infinity, {}), null, 'Infinity maxRadius -> null'));
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, 1.0, 1.0, -1.0, {}), null, 'negative maxRadius -> null, even on an otherwise-walkable point (never a silent abs())'));

  // Far outside the grid, in every direction, at a variety of radii.
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, 1e9, 1e9, 1.0, {}), null, 'far positive out-of-grid -> null'));
  assert.doesNotThrow(() => assert.equal(snapPoint(grid, -1e9, -1e9, 1.0, {}), null, 'far negative out-of-grid -> null'));
  assert.doesNotThrow(() => {
    const r = snapPoint(grid, 1e9, 1e9, 1e12, {});
    assert.ok(r === null || (Number.isFinite(r.x) && Number.isFinite(r.z)), 'an enormous radius must still resolve to null or a finite point, never garbage');
  });
});

// ---------------------------------------------------------------------------
// Determinism — two independent runs over the identical grid/query agree
// exactly.
// ---------------------------------------------------------------------------

test('MAIN: two independent snap calls over an identical (grid, query) produce byte-identical results across a wide sample', () => {
  function scenario() {
    const width = 20;
    const height = 20;
    const grid = createNavGrid({ cellSize: 0.5, width, height, originX: 0, originZ: 0 });
    const scratch = createRasterScratch(width, height);
    for (let cz = 0; cz < height; cz++) {
      for (let cx = 0; cx < width; cx++) {
        const idx = cz * width + cx;
        grid.flags[idx] = (cx * 7 + cz * 5) % 4 === 0 ? 0 : NAV_FLAG.walkable;
      }
    }
    passN7Regions(grid, scratch);
    grid.version = 1;
    return grid;
  }
  const gridA = scenario();
  const gridB = scenario();

  const rng = new Rng(SEEDS.c);
  let compared = 0;
  for (let i = 0; i < 200; i++) {
    const x = rng.range(0, 10);
    const z = rng.range(0, 10);
    const maxRadius = rng.range(0, 3);
    const a = snapPoint(gridA, x, z, maxRadius, {});
    const b = snapPoint(gridB, x, z, maxRadius, {});
    if (a === null || b === null) {
      assert.equal(a, b, `sample ${i}: one run found null and the other did not`);
    } else {
      assert.equal(a.x, b.x, `sample ${i}: x must match exactly`);
      assert.equal(a.z, b.z, `sample ${i}: z must match exactly`);
    }
    compared++;
  }
  assert.ok(compared === 200);
});

// ---------------------------------------------------------------------------
// NavSystem wiring — snap forwards to the LIVE, real-rasterised grid
// (through NavSystem.rebuild(zone), never a hand-built grid this time).
// ---------------------------------------------------------------------------

test('nav.snap forwards into the real rasterised grid: a dilated pillar blocks a small radius but a large enough radius finds the nearest open ground', async () => {
  const pillar = { kind: 'cylinder', x: 0, z: 0, y: 0, height: 3, radius: 1.0, facing: 0, blocksNav: true };
  const world = makeStubWorld({ staticFootprints: [pillar] });
  const { nav } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));

  assert.equal(nav.walkable(0, 0), false, 'test setup: the pillar must actually block its own centre');

  const tooSmall = nav.snap(0, 0, 0.5, {});
  assert.equal(tooSmall, null, 'a radius that never reaches past the dilated pillar must return null');

  const bigEnough = nav.snap(0, 0, 5.0, {});
  assert.notEqual(bigEnough, null, 'a generous radius must find open ground around the pillar');
  assert.ok(nav.walkable(bigEnough.x, bigEnough.z), 'the returned point must itself be walkable on the live grid');

  // Cross-check against the same brute-force scan used above, this time
  // over nav.grid directly — proves the wiring, not just snapPoint in
  // isolation.
  const expected = bruteForceNearest(nav.grid, 0, 0, 5.0);
  // Tolerance above src/nav/snap.js's own CELL_EDGE_EPSILON (1e-4) — see the
  // brute-force comparison test above for why an exact match isn't the
  // right check against this file's independent, un-inset reference scan.
  assert.ok(Math.abs(bigEnough.x - expected.x) < 5e-4 && Math.abs(bigEnough.z - expected.z) < 5e-4, 'nav.snap must agree with a brute-force scan of the real rasterised grid');
});

test('nav.snap(x,z,maxRadius) matches ActorsSystem.teleport\'s expected seam: reads .x/.z off the result, null branches to false', async () => {
  // actors/motion.js's teleportActor reads `snapped.x`/`snapped.z` and
  // treats `snapped === null` as "no walkable point" -> teleport fails.
  // This test proves nav.snap's real shape satisfies exactly that contract
  // without importing src/actors/ (ARCHITECTURE.md rule 2) — see this
  // ticket's report for the full read-only trace through motion.js.
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 5, halfZ: 5 }));

  const navSnapOut = { x: 0, y: 0, z: 0 };
  const snapped = nav.snap(1.0, 1.0, 2.0, navSnapOut);
  assert.notEqual(snapped, null);
  assert.equal(typeof snapped.x, 'number');
  assert.equal(typeof snapped.z, 'number');

  const grid = buildGridFromLayout(['#####', '#####', '#####']);
  const failed = snapPoint(grid, 1.0, 1.0, 2.0, navSnapOut);
  assert.equal(failed, null, 'a fully-blocked grid must produce the null teleportActor branches on');
});
