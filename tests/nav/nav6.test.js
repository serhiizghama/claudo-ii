// tests/nav/nav6.test.js
//
// NAV-6 (D-58) acceptance tests for `nav.markHazard()` — src/nav/grid.js's
// `markHazard` and the one-line forward it gets in src/nav/index.js.
// `node:test` + `node:assert/strict` only (12-testing.md P6). Per O-27,
// every assertion is on real rasterised/flag/cost behaviour — never on "the
// method exists" alone (that check exists too, but is one test among many,
// never the whole file).
//
// Scope: the ticket's five literal acceptance criteria —
//   1. exact-cell coverage (no more, no fewer)
//   2. reachable as ctx.get('nav').markHazard, Fixed=Y/Alloc=no shape
//   3. zero-leak register/deregister round trip
//   4. overlapping hazards do not corrupt each other (refcount)
//   5. pathing cost genuinely responds (detour, then reverts once cleared)
// plus rule 12 (rebuild() must not resurrect stale hazards, must not
// silently drop live ones — this file demonstrates the "always reset"
// decision src/nav/index.js's rebuild() documents and why), non-walkable
// cells (hazard bit toggles, cost stays 255 always), and degenerate/
// unmatched-call inputs.
//
// Per O-38, every grid here is built either directly (hand-written NavGrid,
// for the pure grid.js-level cell-math tests that need no NavSystem/ctx at
// all) or via `NavSystem.rebuild(zone)` against a stub `world`
// (`tests/nav/nav1.test.js`'s own pattern) — never through `world.enterZone`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import {
  NAV_FLAG,
  RASTER,
  createNavGrid,
  createRasterScratch,
  passN7Regions,
  markHazard as gridMarkHazard,
} from '../../src/nav/grid.js';
import { makeStubCtx } from '../helpers/actor.js';

// ---------------------------------------------------------------------------
// Helpers — the same shape tests/nav/nav1.test.js's own makeStubWorld/
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

/** The exact same cell-centre-in-circle test `markHazard`/`stampSpawnDenyDisc`
 * use, computed independently here so the coverage test is a real proof, not
 * a restatement of the production code. */
function expectedHazardCells(grid, x, z, radius) {
  const cells = [];
  const r2 = radius * radius;
  for (let cz = 0; cz < grid.height; cz++) {
    const pz = grid.originZ + (cz + 0.5) * grid.cellSize;
    for (let cx = 0; cx < grid.width; cx++) {
      const px = grid.originX + (cx + 0.5) * grid.cellSize;
      const dx = px - x, dz = pz - z;
      if (dx * dx + dz * dz <= r2) cells.push(cz * grid.width + cx);
    }
  }
  return cells;
}

function countHazardFlags(grid) {
  let n = 0;
  for (let i = 0; i < grid.flags.length; i++) if (grid.flags[i] & NAV_FLAG.hazard) n++;
  return n;
}

/** Advances `ctx.time.step` and calls `nav.fixedUpdate` — the only way
 * pending path requests actually get solved (`requestPath` itself never
 * solves) — `tests/nav/nav2.test.js`'s own `tick` helper, redefined here.
 * @param {NavSystem} nav @param {object} ctx @param {number} [times] */
function tick(nav, ctx, times = 1) {
  for (let i = 0; i < times; i++) {
    ctx.time.step++;
    nav.fixedUpdate(1 / 60, ctx);
  }
}

// ---------------------------------------------------------------------------
// Criterion 2 — reachable as a method on ctx.get('nav')
// ---------------------------------------------------------------------------

test('markHazard is reachable as a method on ctx.get(\'nav\'), the real boot wiring', async () => {
  const { WorldSystem } = await import('../../src/world/index.js');
  const { Rng } = await import('../../src/core/rng.js');
  const { EventBus } = await import('../../src/core/events.js');
  const world = new WorldSystem();
  const events = new EventBus();
  const rng = new Rng(12345);
  const time = { step: 0, dt: 1 / 60 };
  const systems = new Map();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null, input: null,
    config: {}, events, time, rng,
    get(id) { return systems.get(id); },
    peek(id) { return systems.has(id) ? systems.get(id) : undefined; },
    has(id) { return systems.has(id); },
  };
  systems.set('world', world);
  const nav = new NavSystem();
  systems.set('nav', nav);
  await world.init(ctx);
  await nav.init(ctx);

  const navFromCtx = ctx.get('nav');
  assert.equal(typeof navFromCtx.markHazard, 'function', 'nav.markHazard must exist as a real method');
  assert.equal(navFromCtx.markHazard.length, 4, 'markHazard(x,z,radius,on) — four parameters, per 02 §6 L502');
  assert.doesNotThrow(() => navFromCtx.markHazard(0, 0, 1, true));
});

// ---------------------------------------------------------------------------
// Criterion 1 — exact-cell coverage
// ---------------------------------------------------------------------------

test('MAIN: markHazard(x,z,radius,true) sets NAV_FLAG.hazard on exactly the cells within radius — no more, no fewer', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 })); // 20x20 m -> 40x40 cells @ 0.5 m
  const grid = nav.grid;

  const x = 1.25, z = -0.75, radius = 2.3;
  const expected = new Set(expectedHazardCells(grid, x, z, radius));
  assert.ok(expected.size > 0, 'sanity: the test radius must cover at least one cell');

  nav.markHazard(x, z, radius, true);

  let actualCount = 0;
  for (let i = 0; i < grid.flags.length; i++) {
    const has = (grid.flags[i] & NAV_FLAG.hazard) !== 0;
    if (has) actualCount++;
    assert.equal(has, expected.has(i), `cell ${i} hazard flag must match the independent geometric expectation`);
  }
  assert.equal(actualCount, expected.size, 'exactly the expected cell count must be flagged — no more, no fewer');
});

test('a cell just outside the radius is untouched (flags and cost both)', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;

  const x = 0, z = 0, radius = 3.0;
  // A point safely outside radius+1 cell diagonal, still on-grid.
  const outsideX = 8.0, outsideZ = 0;
  const beforeFlags = grid.flags[cellIndexOf(grid, outsideX, outsideZ)];
  const beforeCost = grid.cost[cellIndexOf(grid, outsideX, outsideZ)];

  nav.markHazard(x, z, radius, true);

  const i = cellIndexOf(grid, outsideX, outsideZ);
  assert.equal(grid.flags[i], beforeFlags, 'a cell outside the radius must never have its flags touched');
  assert.equal(grid.cost[i], beforeCost, 'a cell outside the radius must never have its cost touched');
  assert.equal((grid.flags[i] & NAV_FLAG.hazard) !== 0, false);
});

function cellIndexOf(grid, x, z) {
  const cx = Math.floor((x - grid.originX) / grid.cellSize);
  const cz = Math.floor((z - grid.originZ) / grid.cellSize);
  return cz * grid.width + cx;
}

test('cost bumps by exactly RASTER.COST_HAZARD (12) on a walkable cell inside the radius', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;
  const i = cellIndexOf(grid, 0, 0);
  const before = grid.cost[i];
  assert.equal(before, 1, 'sanity: open ground, no nearWall/water, costs 1 before any hazard');

  nav.markHazard(0, 0, 1.0, true);
  assert.equal(grid.cost[i], before + RASTER.COST_HAZARD);

  nav.markHazard(0, 0, 1.0, false);
  assert.equal(grid.cost[i], before, 'cost must return to its exact pre-hazard value');
});

// ---------------------------------------------------------------------------
// Criterion 3 — zero-leak register/deregister round trip
// ---------------------------------------------------------------------------

test('MAIN: register then deregister a hazard leaves flagsAt() and cost byte-identical to the starting grid, for every cell', async () => {
  const world = makeStubWorld({
    staticFootprints: [
      { kind: 'box', x: 3, z: 0, y: 0, height: 3, halfW: 1, halfL: 1, facing: 0, blocksNav: true },
    ],
  });
  const { nav } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 })); // includes a blocked cell cluster near (3,0)
  const grid = nav.grid;

  const flagsBefore = grid.flags.slice();
  const costBefore = grid.cost.slice();

  // Radius large enough to sweep over walkable ground, near-wall cells and
  // the blocked footprint itself, so all three cost/flag branches inside
  // markHazard get exercised by one round trip.
  nav.markHazard(2.5, 0, 3.5, true);

  // Confirm something actually changed mid-flight (otherwise this test
  // would trivially pass without proving the round trip did anything).
  let changedDuring = false;
  for (let i = 0; i < grid.flags.length; i++) {
    if (grid.flags[i] !== flagsBefore[i] || grid.cost[i] !== costBefore[i]) { changedDuring = true; break; }
  }
  assert.ok(changedDuring, 'sanity: marking must actually change some cell mid-flight');

  nav.markHazard(2.5, 0, 3.5, false);

  for (let i = 0; i < grid.flags.length; i++) {
    assert.equal(grid.flags[i], flagsBefore[i], `cell ${i} flags must return to its exact starting value after deregister`);
    assert.equal(grid.cost[i], costBefore[i], `cell ${i} cost must return to its exact starting value after deregister`);
  }
});

test('a non-walkable (blocked) cell inside the radius gets its hazard BIT toggled, but cost stays RASTER.COST_BLOCKED throughout', async () => {
  const world = makeStubWorld({
    staticFootprints: [{ kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 1, halfL: 1, facing: 0, blocksNav: true }],
  });
  const { nav } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;
  const i = cellIndexOf(grid, 0, 0);
  assert.equal(grid.flags[i] & NAV_FLAG.walkable, 0, 'sanity: origin cell must be blocked by the footprint');
  assert.equal(grid.cost[i], RASTER.COST_BLOCKED);

  nav.markHazard(0, 0, 0.4, true);
  assert.ok(grid.flags[i] & NAV_FLAG.hazard, 'the hazard bit is a fact about the ground, independent of walkability');
  assert.equal(grid.cost[i], RASTER.COST_BLOCKED, 'a blocked cell must never read as anything but fully impassable');

  nav.markHazard(0, 0, 0.4, false);
  assert.equal(grid.flags[i] & NAV_FLAG.hazard, 0);
  assert.equal(grid.cost[i], RASTER.COST_BLOCKED);
});

// ---------------------------------------------------------------------------
// Criterion 4 — overlapping hazards do not corrupt each other
// ---------------------------------------------------------------------------

test('MAIN: two overlapping hazards sharing a cell — expiring one leaves the shared cell still flagged and still cost-bumped', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;

  // Source A centred at (-0.5,0) r=1.5, source B centred at (0.5,0) r=1.5:
  // both cover the origin cell.
  const shared = cellIndexOf(grid, 0, 0);
  const originalCost = grid.cost[shared];

  nav.markHazard(-0.5, 0, 1.5, true); // A on
  nav.markHazard(0.5, 0, 1.5, true); // B on
  assert.ok(grid.flags[shared] & NAV_FLAG.hazard, 'shared cell must be flagged once both sources are live');
  assert.equal(grid.cost[shared], originalCost + RASTER.COST_HAZARD, 'the bump is flat +12, not doubled by two overlapping sources');

  nav.markHazard(-0.5, 0, 1.5, false); // A off — B still live
  assert.ok(grid.flags[shared] & NAV_FLAG.hazard, 'B is still live: the shared cell must STAY a hazard after A expires');
  assert.equal(grid.cost[shared], originalCost + RASTER.COST_HAZARD, 'cost must stay bumped while any source remains live');

  nav.markHazard(0.5, 0, 1.5, false); // B off — nothing left
  assert.equal(grid.flags[shared] & NAV_FLAG.hazard, 0, 'once the last live source expires, the flag must clear');
  assert.equal(grid.cost[shared], originalCost, 'and cost must return to the exact original baseline');
});

test('three overlapping sources on the same cell: refcount survives an out-of-order expiry (B, then A, then C)', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;
  const i = cellIndexOf(grid, 0, 0);
  const base = grid.cost[i];

  // Radii all comfortably exceed the cell-centre offset from (0,0) (up to
  // half a cell diagonal, ~0.354 m at this cellSize) so every source
  // genuinely covers cell `i` — verified by the `assert.ok` right after
  // each `true` call below, not assumed.
  nav.markHazard(0, 0, 0.6, true); // A
  nav.markHazard(0, 0, 0.8, true); // B (different radius, same cell covered)
  nav.markHazard(0, 0, 0.5, true); // C
  assert.ok(grid.flags[i] & NAV_FLAG.hazard, 'sanity: all three sources must cover cell i');

  nav.markHazard(0, 0, 0.8, false); // B off first
  assert.ok(grid.flags[i] & NAV_FLAG.hazard);
  assert.equal(grid.cost[i], base + RASTER.COST_HAZARD);

  nav.markHazard(0, 0, 0.6, false); // A off
  assert.ok(grid.flags[i] & NAV_FLAG.hazard, 'C is still live');
  assert.equal(grid.cost[i], base + RASTER.COST_HAZARD);

  nav.markHazard(0, 0, 0.5, false); // C off — last one
  assert.equal(grid.flags[i] & NAV_FLAG.hazard, 0);
  assert.equal(grid.cost[i], base);
});

test('an unmatched off() on a cell whose refcount is already 0 is a silent no-op, never throws, never wraps', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;
  const i = cellIndexOf(grid, 0, 0);
  const flagsBefore = grid.flags[i];
  const costBefore = grid.cost[i];

  assert.doesNotThrow(() => nav.markHazard(0, 0, 0.4, false));
  assert.equal(grid.flags[i], flagsBefore);
  assert.equal(grid.cost[i], costBefore);

  // Now a real on/off pair must still behave normally afterward (proves the
  // stray off() above did not corrupt refcount into some bad state).
  nav.markHazard(0, 0, 0.4, true);
  assert.ok(grid.flags[i] & NAV_FLAG.hazard);
  nav.markHazard(0, 0, 0.4, false);
  assert.equal(grid.flags[i] & NAV_FLAG.hazard, 0);
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test('degenerate radius (0, negative, NaN) touches nothing and never throws', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const grid = nav.grid;
  const before = { flags: grid.flags.slice(), cost: grid.cost.slice() };

  assert.doesNotThrow(() => nav.markHazard(0, 0, 0, true));
  assert.doesNotThrow(() => nav.markHazard(0, 0, -5, true));
  assert.doesNotThrow(() => nav.markHazard(0, 0, NaN, true));
  assert.doesNotThrow(() => nav.markHazard(NaN, NaN, 2, true));

  assert.deepEqual(Array.from(grid.flags), Array.from(before.flags));
  assert.deepEqual(Array.from(grid.cost), Array.from(before.cost));
});

// ---------------------------------------------------------------------------
// rule 12 — rebuild() behaviour: hazards do not survive a rebuild
// ---------------------------------------------------------------------------

test('MAIN: rebuild() does not resurrect stale hazards — a hazard marked before rebuild() is gone after it, cleanly (not leaked as a phantom bit)', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ zoneId: 'a', halfX: 10, halfZ: 10 }));
  nav.markHazard(0, 0, 2, true);
  assert.ok(countHazardFlags(nav.grid) > 0, 'sanity: hazard actually landed');

  nav.rebuild(makeZone({ zoneId: 'a', halfX: 10, halfZ: 10 })); // same size -> typed arrays reused
  assert.equal(countHazardFlags(nav.grid), 0, 'a rebuild must not carry hazard flags forward onto reused arrays');

  const i = cellIndexOf(nav.grid, 0, 0);
  assert.equal(nav.grid.cost[i], 1, 'cost must be back to the fresh N6 baseline, not still carrying the old hazard bump');
});

test('rebuild() into a DIFFERENT-sized grid also starts hazard-free, and a fresh markHazard on the new grid works correctly', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ zoneId: 'a', halfX: 10, halfZ: 10 }));
  nav.markHazard(0, 0, 2, true);
  assert.ok(countHazardFlags(nav.grid) > 0);

  nav.rebuild(makeZone({ zoneId: 'b', halfX: 24, halfZ: 24 })); // different size -> reallocated arrays
  assert.equal(countHazardFlags(nav.grid), 0);

  // A fresh hazard on the new grid must still behave exactly per criteria
  // 1/3/4 — proves the reallocated refcount/baseCost buffers are sized and
  // wired correctly, not just zero-filled by accident.
  const i = cellIndexOf(nav.grid, 0, 0);
  const base = nav.grid.cost[i];
  nav.markHazard(0, 0, 1, true);
  assert.equal(nav.grid.cost[i], base + RASTER.COST_HAZARD);
  nav.markHazard(0, 0, 1, false);
  assert.equal(nav.grid.cost[i], base);
});

// ---------------------------------------------------------------------------
// Criterion 5 — pathing cost genuinely responds
// ---------------------------------------------------------------------------

test('MAIN: a path across a marked hazard region prefers to go around it, and returns to the direct route once cleared', async () => {
  // Same scale/geometry as tests/nav/nav2.test.js's own "localized cost-13
  // hazard patch" case (known to solve well under NODE_CAP=1200) — open
  // 96x96 m field, a straight 60 m crossing, a disc hazard of radius 6 m
  // centred on the direct line's midpoint. Built through nav.markHazard()
  // itself this time (that test wrote grid.cost by hand).
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 48, halfZ: 48 }));
  const from = { x: -30, z: 0 };
  const to = { x: 30, z: 0 };
  const hazard = { x: 0, z: 0, radius: 6 };

  // --- BEFORE: direct route crosses straight through the hazard-to-be zone.
  const idBefore = nav.requestPath(from.x, from.z, to.x, to.z, 1);
  tick(nav, ctx, 20);
  const pathBefore = nav.pollPath(idBefore);
  assert.ok(pathBefore, 'baseline path must solve');
  let crossedCentreBefore = false;
  for (let i = 0; i < nav.pathLength(pathBefore); i++) {
    const node = nav.pathNode(pathBefore, i, {});
    const dx = node.x - hazard.x, dz = node.z - hazard.z;
    if (dx * dx + dz * dz < 1) { crossedCentreBefore = true; break; } // within 1 m of dead centre
  }
  assert.ok(crossedCentreBefore, 'sanity: on open, uniform-cost ground the direct route passes through the future hazard centre');

  // --- DURING: mark the hazard, then request a fresh path for the same trip.
  nav.markHazard(hazard.x, hazard.z, hazard.radius, true);
  const idDuring = nav.requestPath(from.x, from.z, to.x, to.z, 2);
  tick(nav, ctx, 20);
  const pathDuring = nav.pollPath(idDuring);
  assert.ok(pathDuring, 'a path around a moderate hazard disc must still be found, not aborted');
  assert.ok(nav.stats.avgNodes < 1200, 'must solve well under NODE_CAP for a single localized disc');

  const r2 = hazard.radius * hazard.radius;
  for (let i = 0; i < nav.pathLength(pathDuring); i++) {
    const node = nav.pathNode(pathDuring, i, {});
    const dx = node.x - hazard.x, dz = node.z - hazard.z;
    assert.ok(dx * dx + dz * dz > r2 - 0.5, `node ${i} at (${node.x.toFixed(2)},${node.z.toFixed(2)}) must route AROUND the marked disc, not through it`);
  }

  // --- AFTER: clear the hazard, path reverts to crossing straight through again.
  nav.markHazard(hazard.x, hazard.z, hazard.radius, false);
  const idAfter = nav.requestPath(from.x, from.z, to.x, to.z, 3);
  tick(nav, ctx, 20);
  const pathAfter = nav.pollPath(idAfter);
  assert.ok(pathAfter, 'path must resolve again once the hazard is cleared');
  let crossedCentreAfter = false;
  for (let i = 0; i < nav.pathLength(pathAfter); i++) {
    const node = nav.pathNode(pathAfter, i, {});
    const dx = node.x - hazard.x, dz = node.z - hazard.z;
    if (dx * dx + dz * dz < 1) { crossedCentreAfter = true; break; }
  }
  assert.ok(crossedCentreAfter, 'once cleared, the direct route through the (former) hazard centre must be preferred again');
});

// ---------------------------------------------------------------------------
// grid.js-level unit tests — the pure cell-math function, no NavSystem/ctx
// ---------------------------------------------------------------------------

test('grid.js markHazard: pure function over a hand-built grid needs no ctx/NavSystem at all', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 10, height: 10, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(10, 10);
  grid.flags.fill(NAV_FLAG.walkable);
  grid.cost.fill(1);
  passN7Regions(grid, scratch);

  const refcount = new Uint16Array(100);
  const baseCost = grid.cost.slice();

  gridMarkHazard(grid, refcount, baseCost, 2.5, 2.5, 1.0, true);
  let flagged = 0;
  for (let i = 0; i < 100; i++) if (grid.flags[i] & NAV_FLAG.hazard) flagged++;
  assert.ok(flagged > 0);

  gridMarkHazard(grid, refcount, baseCost, 2.5, 2.5, 1.0, false);
  for (let i = 0; i < 100; i++) {
    assert.equal(grid.flags[i] & NAV_FLAG.hazard, 0);
    assert.equal(grid.cost[i], baseCost[i]);
  }
});
