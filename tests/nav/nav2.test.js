// tests/nav/nav2.test.js
//
// NAV-2 acceptance tests for src/nav/astar.js and the wiring it gets in
// src/nav/index.js. `node:test` + `node:assert/strict` only (12-testing.md
// P6). Per O-27, every assertion is on real solved-path behaviour — never on
// "the object exists" or an empty-stats shape.
//
// Scope: the ticket's literal criterion — `12.P09` (worst-case solve <=
// 1.0ms) and "requestPath returns 0 when the budget is full, never blocks" —
// plus the correctness/determinism/id-safety properties the ticket's brief
// says will be probed hard: no corner-cutting, cost as a real traversal
// weight (not a mask), fast-fail on an unreachable goal, the node-cap
// abort/`stats.refusals`, a version bump mid-flight, and a recycled request
// id never resolving to a different, live request (mirroring
// `tests/actors/*` ACTR-1's own `Actor.id` recycling proof and
// `src/physics/`'s `bodyId` free-list discipline — see `src/nav/astar.js`'s
// header).
//
// Per O-38, every grid here is built directly (via `NavSystem.rebuild(zone)`
// with a stub `world`, exactly `tests/nav/nav1.test.js`'s own pattern, or by
// hand-writing a `NavGrid`'s typed arrays for a scenario `rebuild()` cannot
// conveniently produce) — never through `world.enterZone`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import { createNavGrid, createRasterScratch, passN7Regions, RASTER, NAV_FLAG } from '../../src/nav/grid.js';
import { REQUEST_CAPACITY, DEFAULT_BUDGET, NODE_CAP } from '../../src/nav/astar.js';
import { makeStubCtx } from '../helpers/actor.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

// ---------------------------------------------------------------------------
// Helpers — the same shape tests/nav/nav1.test.js's own makeStubWorld/makeNav
// use, redefined here (not exported by that file) plus a hand-built-grid
// helper for the scenarios rebuild()-over-footprints can't conveniently
// produce (a forced diagonal seam, a forced cost gradient, a forced
// >1200-node corridor).
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

/** Advances `ctx.time.step` and calls `nav.fixedUpdate` — the only way
 * pending requests actually get solved (`requestPath` itself never solves).
 * @param {NavSystem} nav @param {object} ctx @param {number} [times] */
function tick(nav, ctx, times = 1) {
  for (let i = 0; i < times; i++) {
    ctx.time.step++;
    nav.fixedUpdate(1 / 60, ctx);
  }
}

/**
 * Builds a `NavGrid` directly from an ASCII layout (row 0 = z=0, first
 * character = x=0), bypassing footprint rasterisation entirely — for
 * scenarios (a forced diagonal seam, a forced cost gradient) that are
 * awkward to coax out of `passN4FootprintStamp`'s dilation geometry but
 * trivial to state as "this exact cell is/isn't walkable, at this exact
 * cost". `'#'` = blocked (cost 255); any other character is walkable, cost
 * from `costOf(cx,cz,ch)` (default 1). Regions are computed for real via
 * `passN7Regions` — never hand-assigned — so `region`/`connected` behave
 * exactly as a real rasterised grid's would.
 * @param {string[]} rows @param {{cellSize?:number, costOf?:(cx:number,cz:number,ch:string)=>number}} [opts]
 * @returns {object} a NavGrid, `version` set to 1.
 */
function buildGridFromLayout(rows, { cellSize = 0.5, costOf = () => 1 } = {}) {
  const height = rows.length;
  const width = rows[0].length;
  const grid = createNavGrid({ cellSize, width, height, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(width, height);
  for (let cz = 0; cz < height; cz++) {
    const row = rows[cz];
    for (let cx = 0; cx < width; cx++) {
      const i = cz * width + cx;
      const ch = row[cx];
      if (ch === '#') {
        grid.flags[i] = 0;
        grid.cost[i] = RASTER.COST_BLOCKED;
      } else {
        grid.flags[i] = NAV_FLAG.walkable;
        grid.cost[i] = costOf(cx, cz, ch);
      }
    }
  }
  passN7Regions(grid, scratch);
  grid.version = 1;
  return grid;
}

/** World-space centre of cell (cx,cz) on `grid`. */
function cellCentre(grid, cx, cz) {
  return { x: grid.originX + (cx + 0.5) * grid.cellSize, z: grid.originZ + (cz + 0.5) * grid.cellSize };
}

/**
 * A "boustrophedon" single-width corridor: `lanes` full-width open rows,
 * each separated from the next by a wall row that is blocked except for one
 * gap cell (alternating ends) — the classic maze shape that forces A* to
 * expand very close to the corridor's full cell count, because the corridor
 * is a path graph (degree <= 2 everywhere) with no shortcuts to skip ahead
 * on. Used both for the node-cap/refusals test and (at Ashen-Wastes scale)
 * the `12.P09` worst-case measurement. Cost varies per cell
 * (`1 + ((cx + cz*3) % 30)`) so the same grid also demonstrates cost is a
 * real traversal weight, not just a walkable/blocked mask.
 * @param {{width?:number, lanes?:number, cellSize?:number}} [opts]
 * @returns {{grid:object, start:{x:number,z:number}, goal:{x:number,z:number}}}
 */
function buildSnakeMazeGrid({ width = 60, lanes = 25, cellSize = 0.5 } = {}) {
  const height = lanes * 2 - 1;
  const grid = createNavGrid({ cellSize, width, height, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(width, height);
  grid.flags.fill(0);
  grid.cost.fill(RASTER.COST_BLOCKED);

  for (let lane = 0; lane < lanes; lane++) {
    const row = lane * 2;
    const rowBase = row * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      grid.flags[i] = NAV_FLAG.walkable;
      grid.cost[i] = 1 + ((cx + row * 3) % 30);
    }
    if (lane < lanes - 1) {
      const wallRow = row + 1;
      const gapCol = lane % 2 === 0 ? width - 1 : 0;
      const gi = wallRow * width + gapCol;
      grid.flags[gi] = NAV_FLAG.walkable;
      grid.cost[gi] = 1;
    }
  }

  passN7Regions(grid, scratch);
  grid.version = 1;

  const lastLane = lanes - 1;
  const lastLaneRow = lastLane * 2;
  const goalCol = lastLane % 2 === 0 ? width - 1 : 0;

  return {
    grid,
    start: cellCentre(grid, 0, 0),
    goal: cellCentre(grid, goalCol, lastLaneRow),
  };
}

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION, half 1 — requestPath never blocks, returns 0
// when the per-step budget is exhausted, and the caller is never made to
// wait for a solve.
// ---------------------------------------------------------------------------

test('MAIN: requestPath returns 0 on the 5th request in one step (default budget 4) and none of the first four solved inline', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));

  const t0 = process.hrtime.bigint();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(nav.requestPath(-9, -9, 9, 9, 1));
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(ids.length, 5);
  for (let i = 0; i < 4; i++) {
    assert.ok(Number.isInteger(ids[i]) && ids[i] > 0, `request ${i} must be accepted (nonzero id), got ${ids[i]}`);
  }
  assert.equal(ids[4], 0, 'the 5th request in the same step must be refused (budget full)');

  // "Never blocks" proof #1: five synchronous calls, no fixedUpdate, took a
  // trivial amount of wall time — nothing spun waiting for a solve.
  assert.ok(elapsedMs < 50, `5 requestPath calls took ${elapsedMs.toFixed(3)}ms — should be near-instant`);

  // "Never blocks" proof #2 (the stronger one): none of the four ACCEPTED
  // requests solved inline — pollPath still reports them pending, because
  // requestPath only enqueues; solving happens only in fixedUpdate.
  for (let i = 0; i < 4; i++) {
    assert.equal(nav.pollPath(ids[i]), null, `request ${i} must still be PENDING — requestPath must never solve inline`);
  }

  // Once fixedUpdate actually runs (budget 4), all four accepted requests
  // resolve to real, distinct, non-empty paths.
  tick(nav, ctx, 1);
  for (let i = 0; i < 4; i++) {
    const path = nav.pollPath(ids[i]);
    assert.ok(path, `request ${i} must be solved after one fixedUpdate at budget 4`);
    assert.ok(nav.pathLength(path) >= 2);
  }
});

test('requestPath refuses again next step once the (new, lower) budget is exhausted, and the throttle resets every step', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  nav.setBudget(2);

  const a = nav.requestPath(-9, -9, 9, 9, 1);
  const b = nav.requestPath(-9, -9, 9, 9, 1);
  const c = nav.requestPath(-9, -9, 9, 9, 1);
  assert.ok(a > 0 && b > 0);
  assert.equal(c, 0, 'budget of 2 must refuse a 3rd request in the same step');

  tick(nav, ctx, 1); // beginStep() resets the throttle for the new step
  const d = nav.requestPath(-9, -9, 9, 9, 1);
  assert.ok(d > 0, 'a new step must reset the per-step accept throttle');
});

test('requestPath returns 0 (never throws, never blocks) on non-finite input', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone());
  assert.equal(nav.requestPath(NaN, 0, 1, 1, 1), 0);
  assert.equal(nav.requestPath(0, 0, Infinity, 1, 1), 0);
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION, half 2 — 12.P09: a single A* solve, worst case,
// on a deliberately hostile grid.
// ---------------------------------------------------------------------------

// Note on this test's own O-34 exposure: this file's solve loop allocates
// nothing (verified — every scratch structure is built once, in
// `AStarScheduler`'s constructor or `_ensureScratch`, never per solve), and
// in isolation (`node --expose-gc --test tests/nav/*.test.js`, this ticket's
// own required self-check) this measures 0.07-0.13 ms — 8-14x under the
// 1.0 ms gate. Run as part of the FULL `npm test` (dozens of test files'
// worth of CPU-bound work scheduled concurrently by Node's test runner —
// the same machine-level contention `12-testing.md`'s own O-34 note
// documents for `PHYS-4`'s `separate()` budget test and
// `assertAllocationFree`), this tight sub-millisecond wall-clock read can
// spike well past budget on a loaded machine — observed up to ~4.5 ms in
// one full-suite run, alongside PHYS-4's own gate flaking in the same run.
// The assertion below is the real, un-loosened `12.P09` gate; a failure of
// THIS SPECIFIC test under a heavily loaded full-suite run, with no
// corresponding failure when run in isolation, is that same class of
// artifact — not a regression in the solver (see this file's report for the
// isolated numbers actually measured for the ticket's write-up).
test('12.P09: worst-case single A* solve time on a hostile, Ashen-Wastes-scale maze (192 wide x 191 tall, 96 lanes, cost 1..30 varied)', async () => {
  const { grid, start, goal } = buildSnakeMazeGrid({ width: 192, lanes: 96 });
  const { nav, ctx } = await makeNav();
  nav._grid = grid;
  nav._version = 1;
  nav.setBudget(1); // one fixedUpdate call == exactly one solve

  // Warm-up (O-23): more than one call before trusting a timing read.
  for (let i = 0; i < 10; i++) {
    const id = nav.requestPath(start.x, start.z, goal.x, goal.z, 1);
    assert.ok(id > 0);
    tick(nav, ctx, 1);
  }

  const iterations = 30;
  let worstMs = 0;
  for (let i = 0; i < iterations; i++) {
    const id = nav.requestPath(start.x, start.z, goal.x, goal.z, 1);
    assert.ok(id > 0, 'the request pool must not be exhausted mid-measurement');
    ctx.time.step++;
    const t0 = process.hrtime.bigint();
    nav.fixedUpdate(1 / 60, ctx);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > worstMs) worstMs = ms;
  }

  // eslint-disable-next-line no-console
  console.log(`[NAV-2] 12.P09 worst-case single A* solve over ${iterations} solves on a 192x191, 96-lane, cost-varied maze: ${worstMs.toFixed(4)} ms`);

  // This maze's true corridor length (~96*192 ≈ 18,432 cells) vastly exceeds
  // NODE_CAP (1200), so every one of these solves is the node-cap ABORT case
  // — the single most expensive outcome this solver has (the full 1200-node
  // expansion loop runs to completion before giving up), which is exactly
  // what "worst case" should mean for this gate.
  assert.ok(nav.stats.refusals >= iterations, 'every solve on this maze should hit the 1200-node cap, not find a shortcut');
  assert.ok(worstMs <= 1.0, `12.P09: worst-case solve was ${worstMs.toFixed(4)} ms, gate is <= 1.0 ms`);
});

// ---------------------------------------------------------------------------
// Correctness — determinism
// ---------------------------------------------------------------------------

test('MAIN: two independent solves over identical (grid, from, to) produce byte-identical paths, node for node', async () => {
  const layout = [
    '..........',
    '.#####....',
    '..........',
    '....#####.',
    '..........',
    '.####.....',
    '..........',
  ];
  const gridA = buildGridFromLayout(layout);
  const gridB = buildGridFromLayout(layout);

  const { nav: navA, ctx: ctxA } = await makeNav();
  navA._grid = gridA;
  navA._version = 1;
  const { nav: navB, ctx: ctxB } = await makeNav();
  navB._grid = gridB;
  navB._version = 1;

  const from = cellCentre(gridA, 0, 0);
  const to = cellCentre(gridA, 9, 6);

  const idA = navA.requestPath(from.x, from.z, to.x, to.z, 1);
  const idB = navB.requestPath(from.x, from.z, to.x, to.z, 1);
  tick(navA, ctxA, 1);
  tick(navB, ctxB, 1);

  const pathA = navA.pollPath(idA);
  const pathB = navB.pollPath(idB);
  assert.ok(pathA && pathB, 'both independent solves must succeed');

  const lenA = navA.pathLength(pathA);
  const lenB = navB.pathLength(pathB);
  assert.equal(lenA, lenB, 'identical input must produce identical path length');
  assert.ok(lenA >= 2);

  for (let i = 0; i < lenA; i++) {
    const nodeA = navA.pathNode(pathA, i, {});
    const nodeB = navB.pathNode(pathB, i, {});
    assert.equal(nodeA.x, nodeB.x, `node ${i} x must match exactly`);
    assert.equal(nodeA.y, nodeB.y, `node ${i} y must match exactly`);
    assert.equal(nodeA.z, nodeB.z, `node ${i} z must match exactly`);
  }
});

// ---------------------------------------------------------------------------
// Correctness — no corner-cutting
// ---------------------------------------------------------------------------

test('MAIN: the solver never cuts a corner between two diagonally-adjacent blockers', async () => {
  // Blocked at (1,1) and (2,2) — diagonally adjacent to each other. The
  // shortest-looking move from (1,2) to (2,1) is a single diagonal step, but
  // BOTH of its shared orthogonal neighbours ((2,2) and (1,1)) are blocked,
  // so that step must be illegal, forcing a real detour.
  const layout = ['....', '.#..', '..#.', '....'];
  const grid = buildGridFromLayout(layout);
  const { nav, ctx } = await makeNav();
  nav._grid = grid;
  nav._version = 1;

  const from = cellCentre(grid, 1, 2);
  const to = cellCentre(grid, 2, 1);
  const id = nav.requestPath(from.x, from.z, to.x, to.z, 1);
  assert.ok(id > 0);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  assert.ok(path, 'a real detour exists in this 4x4 grid — the solve must succeed');

  const len = nav.pathLength(path);
  assert.ok(len > 2, `a direct diagonal would be a 2-node path; got ${len} nodes, proving the seam was NOT cut`);
});

test('a diagonal move IS legal when both shared orthogonal neighbours are walkable', async () => {
  const layout = ['....', '....', '....', '....'];
  const grid = buildGridFromLayout(layout);
  const { nav, ctx } = await makeNav();
  nav._grid = grid;
  nav._version = 1;

  const from = cellCentre(grid, 0, 0);
  const to = cellCentre(grid, 1, 1);
  const id = nav.requestPath(from.x, from.z, to.x, to.z, 1);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  assert.ok(path);
  assert.equal(nav.pathLength(path), 2, 'an unobstructed diagonal neighbour must be reached in a single step');
});

// ---------------------------------------------------------------------------
// Correctness — cost is a traversal weight, not a mask
// ---------------------------------------------------------------------------

test('MAIN: the solver prefers a cheaper route over a shorter, expensive one — cost genuinely influences the path, not just walkable/blocked', async () => {
  // Row 1, columns 1-3 are walkable but very expensive (cost 60). Row 0 is
  // all cost-1. The direct route (0,1)->(1,1)->(2,1)->(3,1)->(4,1) crosses
  // three cost-60 cells (total cost 181); routing up into row 0 and back
  // down costs at most ~4.83 (two diagonal corner hops at cost 1*sqrt2 plus
  // two cardinal cost-1 hops) — vastly cheaper. A solver that only checked
  // walkable/blocked (never read `cost`) has no reason to ever leave row 1,
  // since every cell in it is walkable and it's the shorter route by cell
  // count. This does not assert a specific node count (a real cost-aware
  // solver may take diagonal shortcuts that keep the count low) — it
  // asserts the one thing that actually proves cost was read: no
  // INTERMEDIATE node sits in the expensive band.
  const grid = createNavGrid({ cellSize: 0.5, width: 5, height: 2, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(5, 2);
  grid.flags.fill(NAV_FLAG.walkable);
  grid.cost.fill(1);
  for (const cx of [1, 2, 3]) {
    grid.cost[1 * 5 + cx] = 60;
  }
  passN7Regions(grid, scratch);
  grid.version = 1;

  const { nav, ctx } = await makeNav();
  nav._grid = grid;
  nav._version = 1;

  const from = cellCentre(grid, 0, 1);
  const to = cellCentre(grid, 4, 1);
  const id = nav.requestPath(from.x, from.z, to.x, to.z, 1);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  assert.ok(path);
  const len = nav.pathLength(path);
  assert.ok(len >= 2);

  const expensiveRowZ = cellCentre(grid, 0, 1).z;
  for (let i = 1; i < len - 1; i++) {
    const node = nav.pathNode(path, i, {});
    assert.notEqual(node.z, expensiveRowZ, `intermediate node ${i} must avoid the expensive row entirely — cost must have been read, not just walkable/blocked`);
  }
});

// ---------------------------------------------------------------------------
// REGRESSION — expansions vs path length, not time (a time gate is satisfied
// by giving up quickly; it cannot see a solver that aborts on ordinary
// reachable paths, which is exactly what a first version of this file did —
// a single 4x4 m box on an open 96x96 m field made expansions grow roughly
// QUADRATICALLY with path length, aborting outright at 80 m. See
// `src/nav/astar.js`'s "Heuristic weighting" header section for the root
// cause (proved: on a uniform-cost region, every sequencing of an equal
// lateral correction produces the exact same true path cost, so an
// admissible heuristic cannot help A* skip the other, equally-tied
// alternatives) and the fix (`HEURISTIC_WEIGHT`, a bounded, documented
// departure from strict admissibility, plus a revised tie-break). These
// tests assert on `stats.avgNodes` directly, at several path lengths, so a
// regression back to the old growth curve fails LOUDLY here instead of
// hiding behind a still-fast-because-it-aborted `12.P09` reading.
// ---------------------------------------------------------------------------

test('MAIN: expansions stay within a small, roughly-constant multiple of path length on a sparse map (single small obstacle) — no quadratic blowup', async () => {
  const box4x4 = { kind: 'box', x: 0, z: 0, halfW: 2, halfL: 2, y: 0, height: 3, facing: 0, blocksNav: true, blocksSight: true };
  // The exact reproduction of the reported defect: lengths where the
  // original solver measured 2.9x/5.1x/6.6x/7.1x/7.5x, and aborted outright
  // at 80 m. MAX_RATIO is generous (well above every measured value below)
  // so this catches a real regression without flaking on noise, while still
  // being far tighter than "aborts" or "grows without bound".
  const MAX_RATIO = 4;
  // The reported defect's signature, precisely: ratio INCREASING with
  // length (2.9x at 10 m up to 7.5x at 60 m, then an outright abort at
  // 80 m) even though the obstacle's own size never changed. A fixed
  // obstacle should cost the search relatively LESS as the journey grows,
  // not more — so on top of the absolute MAX_RATIO ceiling, the ratio at
  // the longest length tested must not exceed the ratio at the shortest by
  // more than a small margin (a strict "ratio only grows" pattern is
  // exactly the quadratic regression this test exists to catch).
  const ratios = [];
  for (const len of [10, 20, 30, 40, 60, 80]) {
    const world = makeStubWorld({ staticFootprints: [box4x4] });
    const { nav, ctx } = await makeNav({ world });
    nav.rebuild(makeZone({ halfX: 48, halfZ: 48 }));
    const half = len / 2;
    const id = nav.requestPath(-half, 0, half, 0, 1);
    assert.ok(id > 0);
    tick(nav, ctx, 10);
    const path = nav.pollPath(id);
    assert.ok(path, `a ${len} m path around a single 4x4 m box must be found, not aborted`);
    const pathLen = nav.pathLength(path);
    const expanded = nav.stats.avgNodes;
    const ratio = expanded / pathLen;
    // eslint-disable-next-line no-console
    console.log(`[NAV-2 regression] len=${len}m pathNodes=${pathLen} expanded=${expanded.toFixed(1)} ratio=${ratio.toFixed(2)}x`);
    assert.ok(ratio <= MAX_RATIO, `len=${len}m: expanded/pathLen ratio ${ratio.toFixed(2)}x exceeds ${MAX_RATIO}x — quadratic blowup regression`);
    ratios.push(ratio);
  }
  assert.ok(
    ratios[ratios.length - 1] <= ratios[0] + 1,
    `ratio grew from ${ratios[0].toFixed(2)}x (10 m) to ${ratios[ratios.length - 1].toFixed(2)}x (80 m) — the reported quadratic-growth signature (ratio increasing with a FIXED-size obstacle) is back`,
  );
});

test('a localized cost-13 hazard patch (the 07 §6.4 Ash Wall value) and a 10-box scattered diagonal both solve without aborting', async () => {
  // These two are the exact adversarial cases that survived tie-breaking
  // alone during this fix's investigation (a full-width band or a hard
  // block responded to tie-breaking; a REALISTIC localized hazard and a
  // modest scattered-obstacle count did not, until HEURISTIC_WEIGHT was
  // added) — kept here so neither regresses silently.
  {
    const world = makeStubWorld();
    const { nav, ctx } = await makeNav({ world });
    nav.rebuild(makeZone({ halfX: 48, halfZ: 48 }));
    const g = nav.grid;
    const r = 6;
    const r2 = r * r;
    for (let cz = 0; cz < g.height; cz++) {
      for (let cx = 0; cx < g.width; cx++) {
        const x = g.originX + (cx + 0.5) * g.cellSize;
        const z = g.originZ + (cz + 0.5) * g.cellSize;
        const i = cz * g.width + cx;
        if (x * x + z * z <= r2 && g.flags[i] & NAV_FLAG.walkable) g.cost[i] = 13;
      }
    }
    const id = nav.requestPath(-30, 0, 30, 0, 1);
    tick(nav, ctx, 10);
    const path = nav.pollPath(id);
    assert.ok(path, 'a localized hazard patch on the direct line must not abort the solve');
    assert.ok(nav.stats.avgNodes < NODE_CAP, 'must not hit the node cap for a localized hazard');
  }
  {
    const boxAt = (x, z, hw, hl) => ({ kind: 'box', x, z, halfW: hw, halfL: hl, y: 0, height: 3, facing: 0, blocksNav: true, blocksSight: true });
    let s = 5;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const fps = [];
    for (let i = 0; i < 10; i++) fps.push(boxAt(rnd() * 80 - 40, rnd() * 80 - 40, 0.4 + rnd(), 0.4 + rnd()));
    const world = makeStubWorld({ staticFootprints: fps });
    const { nav, ctx } = await makeNav({ world });
    nav.rebuild(makeZone({ halfX: 48, halfZ: 48 }));
    const id = nav.requestPath(-42, -42, 42, 42, 1);
    tick(nav, ctx, 10);
    const path = nav.pollPath(id);
    assert.ok(path, 'ten small scattered boxes on an 84 m diagonal must not abort the solve — ten obstacles is not a hard map');
    assert.ok(nav.stats.avgNodes < NODE_CAP, 'must not hit the node cap for ten scattered boxes');
  }
});

// ---------------------------------------------------------------------------
// Correctness — unreachable goal fails fast (O(1) region check, no 1200-node
// expansion), and stats.refusals is NOT charged for it (it never attempted
// a solve).
// ---------------------------------------------------------------------------

test('MAIN: a goal in a different region fails fast without expanding nodes, and is never counted as a refusal', async () => {
  const rows = ['.....', '#####', '.....']; // two isolated pockets, split by a full wall
  const grid = buildGridFromLayout(rows);

  const { nav, ctx } = await makeNav();
  nav._grid = grid;
  nav._version = 1;
  const refusalsBefore = nav.stats.refusals;

  const from = cellCentre(grid, 0, 0);
  const to = cellCentre(grid, 0, 2);
  assert.notEqual(grid.region[0], grid.region[2 * grid.width], 'the two rows must be genuinely disconnected for this test to mean anything');

  const t0 = process.hrtime.bigint();
  const id = nav.requestPath(from.x, from.z, to.x, to.z, 1);
  tick(nav, ctx, 1);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.ok(id > 0);
  assert.equal(nav.pollPath(id), null, 'an unreachable goal must never resolve to a path');
  assert.equal(nav.stats.refusals, refusalsBefore, 'a fast-fail rejection must not be counted as a node-cap refusal');
  assert.ok(elapsedMs < 5, `the fast-fail path must be O(1), not a 1200-node search; took ${elapsedMs.toFixed(3)}ms`);
});

// ---------------------------------------------------------------------------
// Correctness — the node cap aborts and IS counted in stats.refusals
// ---------------------------------------------------------------------------

test('MAIN: a solve that would need far more than 1200 expanded nodes aborts and increments stats.refusals, without ever blocking', async () => {
  const { grid, start, goal } = buildSnakeMazeGrid({ width: 60, lanes: 25 }); // ~1500-cell corridor > NODE_CAP
  const { nav, ctx } = await makeNav();
  nav._grid = grid;
  nav._version = 1;

  const refusalsBefore = nav.stats.refusals;
  const id = nav.requestPath(start.x, start.z, goal.x, goal.z, 1);
  assert.ok(id > 0);
  tick(nav, ctx, 1);

  assert.equal(nav.pollPath(id), null, 'a solve that hits the node cap must never resolve to a path');
  assert.equal(nav.stats.refusals, refusalsBefore + 1, 'the abort must be counted in stats.refusals');
});

// ---------------------------------------------------------------------------
// A version bump mid-flight — a request enqueued before a rebuild is
// dropped, never solved against a grid it was not requested against, and is
// NOT counted as a node-cap refusal (it was never attempted).
// ---------------------------------------------------------------------------

test('MAIN: a request queued before a rebuild is dropped, not solved, and does not count as a refusal', async () => {
  const world = makeStubWorld();
  const { nav, ctx } = await makeNav({ world });
  nav.rebuild(makeZone({ zoneId: 'town', halfX: 10, halfZ: 10 }));

  const id = nav.requestPath(-9, -9, 9, 9, 1);
  assert.ok(id > 0, 'still PENDING at this point — not yet solved');

  const refusalsBefore = nav.stats.refusals;
  // rebuild() is Fixed:N — never called from fixedUpdate, exactly like a
  // real zone change would happen between two fixed steps.
  nav.rebuild(makeZone({ zoneId: 'wastes', halfX: 48, halfZ: 48 }));

  assert.doesNotThrow(() => tick(nav, ctx, 1));
  assert.equal(nav.pollPath(id), null, 'a request spanning a version bump must never resolve');
  assert.equal(nav.stats.refusals, refusalsBefore, 'a version-stale drop is not a node-cap refusal');
});

// ---------------------------------------------------------------------------
// Id safety — a cancelled/released id never resolves, ever again, even once
// its pool slot is recycled into a brand-new, live, different request
// (the "stale reference resolving to a live object" class of bug ACTR-1 was
// sent back once for — see src/nav/astar.js's header for the bijection).
// ---------------------------------------------------------------------------

test('MAIN: a cancelled request id never resolves later, even after its slot is recycled into a different, live, solved request', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));

  // Fill the ENTIRE request pool, respecting the per-step accept throttle
  // (DEFAULT_BUDGET per step, then a tick to solve that batch and reset the
  // throttle for the next) — every slot ends up SOLVED, none left pending,
  // and the per-step throttle is back at 0 by the time the loop ends.
  const ids = [];
  for (let round = 0; round < REQUEST_CAPACITY / DEFAULT_BUDGET; round++) {
    for (let k = 0; k < DEFAULT_BUDGET; k++) {
      const id = nav.requestPath(-9, -9, 9, 9, 1);
      assert.ok(id > 0, `slot ${round * DEFAULT_BUDGET + k} must be acquirable — pool should not be exhausted yet`);
      ids.push(id);
    }
    tick(nav, ctx, 1);
  }
  assert.equal(ids.length, REQUEST_CAPACITY);
  assert.equal(nav.requestPath(-9, -9, 9, 9, 1), 0, 'the pool must be fully exhausted at exactly REQUEST_CAPACITY');

  // Free EXACTLY one slot — the only free slot in the whole pool.
  const idFirst = ids[0];
  nav.cancelPath(idFirst);

  // The only slot available is the one idFirst just vacated — this new
  // request is GUARANTEED to reuse that exact physical slot. The per-step
  // throttle is still at 0 for "this step" (untouched since the loop's last
  // tick), so this is accepted on the throttle side too.
  const idNew = nav.requestPath(-8, -8, 8, 8, 2);
  assert.ok(idNew > 0, 'exactly one slot was freed — this request must be accepted');
  assert.notEqual(idNew, idFirst, 'the bijection must never reissue the same integer for a new generation');

  tick(nav, ctx, 4); // drain idNew itself (budget 4/step is ample for one request)

  const newPath = nav.pollPath(idNew);
  assert.ok(newPath, 'idNew must have solved into a real, live path by now');
  assert.ok(nav.pathLength(newPath) >= 2);

  // The old, cancelled id must STILL never resolve — not to null-forever by
  // coincidence, but specifically not to the brand-new, live path that now
  // genuinely occupies its old physical slot.
  assert.equal(nav.pollPath(idFirst), null, 'a cancelled id must never resolve, even once its slot is reused by a different live request');
});

test('releasePath frees a solved handle; the id never resolves again and the stale handle reads back safe defaults', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));

  const id = nav.requestPath(-9, -9, 9, 9, 1);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  assert.ok(path);
  const len = nav.pathLength(path);
  assert.ok(len >= 2);

  nav.releasePath(path);
  assert.equal(nav.pollPath(id), null, 'releasePath must make the id unresolvable');

  // Holding the stale handle object itself and reading from it afterward
  // (a caller bug, but must fail SAFE, never read garbage/a new occupant's
  // data — see astar.js's header) degrades to the documented defaults.
  assert.equal(nav.pathLength(path), 0);
  const out = nav.pathNode(path, 0, {});
  assert.deepEqual(out, { x: 0, y: 0, z: 0 });
});

test('cancelPath and releasePath are safe no-ops on an unknown/garbage id or handle', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone());
  assert.doesNotThrow(() => nav.cancelPath(0));
  assert.doesNotThrow(() => nav.cancelPath(-5));
  assert.doesNotThrow(() => nav.cancelPath(999999));
  assert.doesNotThrow(() => nav.releasePath(null));
  assert.doesNotThrow(() => nav.releasePath({ poolIndex: -1 }));
  assert.equal(nav.pollPath(0), null);
  assert.equal(nav.pollPath(-1), null);
  assert.equal(nav.pollPath(1.5), null);
});

// ---------------------------------------------------------------------------
// pathNode / pathLength — out-of-range reads are safe defaults, `out` is
// honoured, and the no-`out` scratch is shared (the documented `out`
// convention).
// ---------------------------------------------------------------------------

test('pathNode with out-of-range i returns a zeroed Vec3 rather than throwing', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const id = nav.requestPath(-9, -9, 9, 9, 1);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  assert.ok(path);
  const len = nav.pathLength(path);

  assert.deepEqual(nav.pathNode(path, -1, {}), { x: 0, y: 0, z: 0 });
  assert.deepEqual(nav.pathNode(path, len, {}), { x: 0, y: 0, z: 0 });
});

test('pathNode with no out returns the same shared scratch object every call', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const id = nav.requestPath(-9, -9, 9, 9, 1);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  const r1 = nav.pathNode(path, 0);
  const r2 = nav.pathNode(path, 1);
  assert.equal(r1, r2, 'no-out pathNode must reuse one scratch object (Alloc: no)');
});

// ---------------------------------------------------------------------------
// stats — same object every call, documented shape (already covered for the
// NAV-1 fields by nav1.test.js; here we only assert the NAV-2 fields move).
// ---------------------------------------------------------------------------

test('stats.pending tracks the live queue depth and stats object identity never changes', async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const statsRef = nav.stats;

  assert.equal(nav.stats.pending, 0);
  const id = nav.requestPath(-9, -9, 9, 9, 1);
  assert.ok(id > 0);
  assert.equal(nav.stats.pending, 1);
  tick(nav, ctx, 1);
  assert.equal(nav.stats.pending, 0, 'solved (or failed) requests are no longer pending');
  assert.equal(nav.stats, statsRef, 'stats must be the same object every call (Alloc: no)');
});

// ---------------------------------------------------------------------------
// Allocation — every Alloc:no method in this ticket's slice.
// ---------------------------------------------------------------------------

test('12.Axx pollPath/pathNode/pathLength/cancelPath are allocation-free once a path exists', { skip: !hasGc() && 'run with --expose-gc' }, async () => {
  const { nav, ctx } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const id = nav.requestPath(-9, -9, 9, 9, 1);
  tick(nav, ctx, 1);
  const path = nav.pollPath(id);
  assert.ok(path);
  const out = { x: 0, y: 0, z: 0 };

  const r1 = assertAllocationFree(() => nav.pollPath(id));
  assert.ok(r1.bytesPerCall < 1);
  const r2 = assertAllocationFree(() => nav.pathNode(path, 0, out));
  assert.ok(r2.bytesPerCall < 1);
  const r3 = assertAllocationFree(() => nav.pathLength(path));
  assert.ok(r3.bytesPerCall < 1);
  const r4 = assertAllocationFree(() => nav.cancelPath(999999)); // stale id — the common steady-state call
  assert.ok(r4.bytesPerCall < 1);
});

// Scope (that this ticket implemented only its own rows and did not stub
// its successors') is verified by the orchestrator at review time against
// `02-api-contracts.md`, not encoded here as a standing assertion — every
// later ticket in this subsystem (NAV-3's `smooth`, NAV-4, NAV-5) is
// required to falsify a "these methods are absent" check by design. See
// O-27.

test('NODE_CAP and DEFAULT_BUDGET match 06-monsters-ai.md §9.1 exactly', () => {
  assert.equal(NODE_CAP, 1200);
  assert.equal(DEFAULT_BUDGET, 4);
});
