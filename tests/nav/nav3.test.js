// tests/nav/nav3.test.js
//
// NAV-3 acceptance tests for src/nav/smooth.js and the one-line wiring it
// gets in src/nav/index.js. `node:test` + `node:assert/strict` only
// (12-testing.md P6). Per O-27, every assertion is on real smoothed-path
// behaviour — never on "the object exists" or an empty-shape check.
//
// Scope: the ticket's literal acceptance criterion — a 40 m+ staircase path
// collapses to <= 6 nodes AND every resulting segment stays walkable end to
// end, dense-sampled independently of this file's own `segmentWalkable`
// import (see `MAIN: 40 m open-field staircase...` below) — plus the
// correctness properties the ticket's brief says will be probed hard: no
// corner-cutting (mirroring `tests/nav/nav2.test.js`'s own A* no-corner-
// cutting proof, at the segment-test level and at the full-smooth level),
// endpoint preservation, in-place compaction without reading past the node
// array end, idempotence, determinism and zero allocation.
//
// Per O-38, every grid here is built directly (via a hand-written `NavGrid`,
// `tests/nav/nav2.test.js`'s own `buildGridFromLayout` pattern redefined
// here, or `NavSystem.rebuild(zone)` against a stub `world`) — never through
// `world.enterZone`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import { createNavGrid, createRasterScratch, passN7Regions, RASTER, NAV_FLAG } from '../../src/nav/grid.js';
import { segmentWalkable, smoothPath } from '../../src/nav/smooth.js';
import { makeStubCtx } from '../helpers/actor.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

// ---------------------------------------------------------------------------
// Helpers
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

function tick(nav, ctx, times = 1) {
  for (let i = 0; i < times; i++) {
    ctx.time.step++;
    nav.fixedUpdate(1 / 60, ctx);
  }
}

/** Same pattern as tests/nav/nav2.test.js's own `buildGridFromLayout` —
 * redefined here (not exported by that file), for scenarios trivial to state
 * as an exact ASCII grid. */
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

/** A fully open WxH grid, one region, every cell cost 1 — the "nothing to
 * avoid" baseline several tests below start from before poking in specific
 * blocked cells. */
function buildOpenGrid(width, height, cellSize = 0.5) {
  const grid = createNavGrid({ cellSize, width, height, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(width, height);
  grid.flags.fill(NAV_FLAG.walkable);
  grid.cost.fill(1);
  passN7Regions(grid, scratch);
  grid.version = 1;
  return grid;
}

function blockCell(grid, cx, cz) {
  const i = cz * grid.width + cx;
  grid.flags[i] = 0;
  grid.cost[i] = RASTER.COST_BLOCKED;
}

/**
 * A hand-built `PathHandle`-shaped object — exactly the fields
 * `astar.js`'s own records carry (`nodesX/Y/Z: Float32Array`, `nodeCount`) —
 * so `smoothPath`/`nav.smooth` can operate on it without a real A* solve.
 * `capacity` (default: a few slots of headroom beyond `nodes.length`) lets a
 * test plant sentinel values past `nodeCount` to prove nothing is read or
 * written beyond it.
 * @param {{x:number,z:number,y?:number}[]} nodes
 * @param {number} [capacity]
 */
function makePathHandle(nodes, capacity = nodes.length + 4) {
  const nodesX = new Float32Array(capacity);
  const nodesY = new Float32Array(capacity);
  const nodesZ = new Float32Array(capacity);
  for (let i = 0; i < nodes.length; i++) {
    nodesX[i] = nodes[i].x;
    nodesY[i] = nodes[i].y ?? 0;
    nodesZ[i] = nodes[i].z;
  }
  return { nodesX, nodesY, nodesZ, nodeCount: nodes.length };
}

/** Reads node `i` off a `PathHandle`-shaped object as a plain `{x,y,z}`. */
function readNode(path, i) {
  return { x: path.nodesX[i], y: path.nodesY[i], z: path.nodesZ[i] };
}

/**
 * Independent dense-sampling walkability check — deliberately NOT built on
 * `segmentWalkable` (this file's own import), so it cannot share a bug with
 * the implementation under test. Samples `steps + 1` points along the
 * segment (including both endpoints) and asserts every one lands on a
 * walkable cell via the plain `flags` array — the same "every point along
 * every resulting segment" wording the ticket's acceptance criterion uses,
 * checked at a resolution far finer than the grid cell size.
 * @param {object} grid @param {number} ax @param {number} az @param {number} bx @param {number} bz @param {number} [steps]
 * @returns {boolean}
 */
function denseSampleWalkable(grid, ax, az, bx, bz, steps = 400) {
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const cx = Math.floor((x - grid.originX) / grid.cellSize);
    const cz = Math.floor((z - grid.originZ) / grid.cellSize);
    if (cx < 0 || cx >= grid.width || cz < 0 || cz >= grid.height) return false;
    if (!(grid.flags[cz * grid.width + cx] & NAV_FLAG.walkable)) return false;
  }
  return true;
}

/** Asserts every consecutive pair of nodes in a solved/smoothed `path` is
 * dense-sample walkable end to end, via `nav`'s own public `pathNode`/
 * `pathLength` (never reaching into the handle's raw fields) — the
 * "independent of this file's own segmentWalkable" check the ticket's
 * self-check demands. */
function assertPathDenseWalkable(nav, path, label) {
  const len = nav.pathLength(path);
  for (let i = 0; i < len - 1; i++) {
    const a = nav.pathNode(path, i, {});
    const b = nav.pathNode(path, i + 1, {});
    assert.ok(
      denseSampleWalkable(nav.grid, a.x, a.z, b.x, b.z),
      `${label}: segment ${i}->${i + 1} ((${a.x.toFixed(2)},${a.z.toFixed(2)}) -> (${b.x.toFixed(2)},${b.z.toFixed(2)})) must be walkable end to end`,
    );
  }
}

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION, half 1 & 2 together — a genuine 40 m+ staircase
// path collapses to <= 6 nodes and stays walkable end to end (dense-sampled,
// independently of segmentWalkable).
// ---------------------------------------------------------------------------

test('MAIN: a real 40 m+ open-field staircase path (non-cardinal, non-45-degree bearing) collapses to <= 6 nodes, endpoints preserved, every resulting segment dense-sampled walkable', async () => {
  // An open field (no obstacles) forces A* to approximate a bearing that
  // isn't a pure cardinal/45-degree direction with a real zigzag "staircase"
  // of many short grid-aligned steps, even though nothing blocks a straight
  // line — exactly the shape this ticket's acceptance criterion names.
  const world = makeStubWorld();
  const { nav, ctx } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 30, halfZ: 20 })); // 60x40 m zone, plenty of margin

  const fromX = -20, fromZ = -6;
  const toX = 20, toZ = 9; // dx=40, dz=15 -> ~42.7 m, bearing ~20.6 degrees off-axis
  const dist = Math.sqrt((toX - fromX) ** 2 + (toZ - fromZ) ** 2);
  assert.ok(dist > 40, `test setup: path must be over 40 m, was ${dist.toFixed(2)} m`);

  const id = nav.requestPath(fromX, fromZ, toX, toZ, 1);
  assert.ok(id > 0);
  tick(nav, ctx, 5);
  const path = nav.pollPath(id);
  assert.ok(path, 'a straight-line-reachable 40+ m path in an open field must solve');

  const before = nav.pathLength(path);
  // eslint-disable-next-line no-console
  console.log(`[NAV-3] MAIN open-field staircase: before=${before} nodes over ${dist.toFixed(2)} m`);
  assert.ok(before > 6, `test setup: the raw A* output must actually BE a multi-node staircase (was only ${before} nodes) for this test to mean anything`);

  const first = nav.pathNode(path, 0, {});
  const last = nav.pathNode(path, before - 1, {});

  nav.smooth(path);

  const after = nav.pathLength(path);
  // eslint-disable-next-line no-console
  console.log(`[NAV-3] MAIN open-field staircase: after=${after} nodes`);
  assert.ok(after <= 6, `smoothed staircase must collapse to <= 6 nodes, got ${after}`);
  assert.ok(after >= 2, 'a real, nontrivial path must never collapse to fewer than 2 nodes');
  assert.ok(after <= before, 'smoothing must never increase node count');

  const firstAfter = nav.pathNode(path, 0, {});
  const lastAfter = nav.pathNode(path, after - 1, {});
  assert.equal(firstAfter.x, first.x);
  assert.equal(firstAfter.z, first.z);
  assert.equal(lastAfter.x, last.x);
  assert.equal(lastAfter.z, last.z);

  assertPathDenseWalkable(nav, path, 'open-field staircase');
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION under a real obstacle — a 40 m+ staircase with a
// genuine diagonal corner trap planted directly on the naive shortcut line:
// collapses substantially, but the resulting segments must dense-sample
// walkable, and the specific trap corner must independently prove rejected.
// ---------------------------------------------------------------------------

test('MAIN: a 40 m+ staircase with one diagonal corner trap on the direct line collapses hard but never cuts the corner', async () => {
  // 90x90 cells @ 0.5 m = 45x45 m. Start/goal sit on the exact k=k diagonal
  // (cell centres (0,0) and (79,79)) so the DIRECT candidate segment tested
  // by smoothPath ties at every grid boundary crossing (dx === dz exactly) —
  // see src/nav/smooth.js's header, "The corner-cut concern". A single
  // blocked cell at (40,41) is one of the two "L" neighbours of the diagonal
  // step from (40,40) to (41,41): astar.js's own no-corner-cut rule, and this
  // file's segmentWalkable, both require BOTH L neighbours walkable for that
  // diagonal to be legal, so one blocked L cell is enough to make the whole
  // direct shortcut illegal.
  const width = 90, height = 90;
  const grid = buildOpenGrid(width, height);
  blockCell(grid, 40, 41);

  // The fake "staircase" input: alternating right/up single-cell steps,
  // tracing (0,0) -> (1,0) -> (1,1) -> (2,1) -> (2,2) -> ... -> (79,79).
  // Every step is a single legal cardinal move (never touches (40,41), which
  // this pattern never visits — it always lands on (k+1,k) then (k+1,k+1),
  // the OTHER L-neighbour family), so the base "every original adjacent pair
  // is walkable" precondition genuinely holds, exactly as a real A* path
  // would guarantee.
  const nodes = [];
  for (let k = 0; k < width - 1; k++) {
    const c1 = cellCentre(grid, k, k);
    if (nodes.length === 0) nodes.push(c1);
    const c2 = cellCentre(grid, k + 1, k);
    nodes.push(c2);
    const c3 = cellCentre(grid, k + 1, k + 1);
    nodes.push(c3);
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const dist = Math.sqrt((last.x - first.x) ** 2 + (last.z - first.z) ** 2);
  assert.ok(dist > 40, `test setup: staircase must span over 40 m, was ${dist.toFixed(2)} m`);

  // Direct proof: the naive full-length shortcut IS illegal (the corner trap
  // actually bites) — otherwise this test would prove nothing.
  assert.equal(
    segmentWalkable(grid, first.x, first.z, last.x, last.z),
    false,
    'test setup: the direct start->goal shortcut must be rejected by the planted corner trap',
  );
  // And the isolated single-step diagonal it stands in for is illegal too —
  // the minimal, easy-to-verify-by-hand version of the same fact.
  const d0 = cellCentre(grid, 40, 40);
  const d1 = cellCentre(grid, 41, 41);
  assert.equal(segmentWalkable(grid, d0.x, d0.z, d1.x, d1.z), false, 'the single diagonal step straddling the blocked L-cell must be illegal');

  const path = makePathHandle(nodes);
  const before = path.nodeCount;
  smoothPath(grid, path);
  const after = path.nodeCount;
  // eslint-disable-next-line no-console
  console.log(`[NAV-3] MAIN corner-trap staircase: before=${before} after=${after} over ${dist.toFixed(2)} m`);

  assert.ok(after < before, 'smoothing must still collapse most of the redundant zigzag');
  assert.ok(after <= 10, `expected a handful of anchors given only one obstacle, got ${after}`);
  assert.equal(path.nodesX[0], nodes[0].x);
  assert.equal(path.nodesZ[0], nodes[0].z);
  assert.equal(path.nodesX[after - 1], last.x);
  assert.equal(path.nodesZ[after - 1], last.z);

  for (let i = 0; i < after - 1; i++) {
    const a = readNode(path, i);
    const b = readNode(path, i + 1);
    assert.ok(
      denseSampleWalkable(grid, a.x, a.z, b.x, b.z),
      `segment ${i}->${i + 1} must be walkable end to end (no corner cut through the (40,41) trap)`,
    );
  }
});

// ---------------------------------------------------------------------------
// segmentWalkable — isolated, minimal proofs
// ---------------------------------------------------------------------------

test('segmentWalkable: rejects a straight line that would cut through two diagonally-blocked cells (the classic corner-cut)', () => {
  // Identical geometry to tests/nav/nav2.test.js's own A* no-corner-cut proof
  // ("Blocked at (1,1) and (2,2)... the shortest-looking move from (1,2) to
  // (2,1) is a single diagonal step... BOTH shared orthogonal neighbours
  // ((2,2) and (1,1)) are blocked").
  const layout = ['....', '.#..', '..#.', '....'];
  const grid = buildGridFromLayout(layout);
  const from = cellCentre(grid, 1, 2);
  const to = cellCentre(grid, 2, 1);
  assert.equal(segmentWalkable(grid, from.x, from.z, to.x, to.z), false);
});

test('segmentWalkable: a diagonal IS legal when both shared orthogonal neighbours are walkable', () => {
  const layout = ['....', '....', '....', '....'];
  const grid = buildGridFromLayout(layout);
  const from = cellCentre(grid, 0, 0);
  const to = cellCentre(grid, 1, 1);
  assert.equal(segmentWalkable(grid, from.x, from.z, to.x, to.z), true);
});

test('segmentWalkable: a long straight cardinal line correctly detects a single blocked cell anywhere along it (not just at endpoints)', () => {
  const grid = buildOpenGrid(60, 3);
  const from = cellCentre(grid, 0, 1);
  const to = cellCentre(grid, 59, 1);
  assert.equal(segmentWalkable(grid, from.x, from.z, to.x, to.z), true, 'fully open row must be walkable end to end');

  blockCell(grid, 37, 1); // deep in the middle, far from either sampled endpoint
  assert.equal(segmentWalkable(grid, from.x, from.z, to.x, to.z), false, 'a single blocked cell anywhere along the line must be caught, not skipped');
});

test('segmentWalkable: false when either endpoint is off-grid or itself blocked', () => {
  const grid = buildOpenGrid(10, 10);
  const inside = cellCentre(grid, 5, 5);
  assert.equal(segmentWalkable(grid, inside.x, inside.z, 9999, 9999), false, 'off-grid endpoint must fail');
  assert.equal(segmentWalkable(grid, -9999, -9999, inside.x, inside.z), false, 'off-grid origin must fail');

  blockCell(grid, 5, 5);
  const other = cellCentre(grid, 6, 6);
  assert.equal(segmentWalkable(grid, inside.x, inside.z, other.x, other.z), false, 'a blocked origin cell must fail immediately');
});

test('segmentWalkable: a zero-length segment (same point) reads off the single occupied cell', () => {
  const grid = buildOpenGrid(10, 10);
  const p = cellCentre(grid, 3, 3);
  assert.equal(segmentWalkable(grid, p.x, p.z, p.x, p.z), true);
  blockCell(grid, 3, 3);
  assert.equal(segmentWalkable(grid, p.x, p.z, p.x, p.z), false);
});

// ---------------------------------------------------------------------------
// smoothPath — endpoints, straight-path no-gain, 1/2-node survival
// ---------------------------------------------------------------------------

test('smoothPath: first and last node are always preserved exactly, whatever the middle collapses to', () => {
  const grid = buildOpenGrid(40, 40);
  const nodes = [];
  for (let k = 0; k <= 30; k++) nodes.push(cellCentre(grid, k, 0)); // a long straight open row
  const path = makePathHandle(nodes);
  smoothPath(grid, path);
  assert.equal(path.nodesX[0], nodes[0].x);
  assert.equal(path.nodesZ[0], nodes[0].z);
  assert.equal(path.nodesX[path.nodeCount - 1], nodes[nodes.length - 1].x);
  assert.equal(path.nodesZ[path.nodeCount - 1], nodes[nodes.length - 1].z);
});

test('smoothPath: an already-straight path must not gain nodes (a fully open straight row collapses to exactly 2)', () => {
  const grid = buildOpenGrid(40, 40);
  const nodes = [];
  for (let k = 0; k <= 30; k++) nodes.push(cellCentre(grid, k, 0));
  const path = makePathHandle(nodes);
  const before = path.nodeCount;
  smoothPath(grid, path);
  assert.ok(path.nodeCount <= before);
  assert.equal(path.nodeCount, 2, 'a fully unobstructed straight line must collapse all the way to its two endpoints');
});

test('smoothPath: a 2-node path survives unchanged, never reading past index 1', () => {
  const grid = buildOpenGrid(10, 10);
  const a = cellCentre(grid, 1, 1);
  const b = cellCentre(grid, 8, 8);
  const path = makePathHandle([a, b], 6);
  path.nodesX[2] = 999; path.nodesY[2] = 999; path.nodesZ[2] = 999; // sentinel past nodeCount
  smoothPath(grid, path);
  assert.equal(path.nodeCount, 2);
  assert.equal(path.nodesX[0], a.x);
  assert.equal(path.nodesZ[0], a.z);
  assert.equal(path.nodesX[1], b.x);
  assert.equal(path.nodesZ[1], b.z);
  assert.equal(path.nodesX[2], 999, 'must never touch anything past nodeCount');
});

test('smoothPath: a 1-node path survives unchanged, never double-writing node 0', () => {
  const grid = buildOpenGrid(10, 10);
  const a = cellCentre(grid, 4, 4);
  const path = makePathHandle([a], 6);
  path.nodesX[1] = 777; path.nodesY[1] = 777; path.nodesZ[1] = 777; // sentinel past nodeCount
  smoothPath(grid, path);
  assert.equal(path.nodeCount, 1, 'a single-node path must stay a single node, never become 2 via a spurious re-append');
  assert.equal(path.nodesX[0], a.x);
  assert.equal(path.nodesZ[0], a.z);
  assert.equal(path.nodesX[1], 777, 'must never touch anything past nodeCount');
});

test('smoothPath: a 0-node path is a safe no-op', () => {
  const grid = buildOpenGrid(10, 10);
  const path = { nodesX: new Float32Array(4), nodesY: new Float32Array(4), nodesZ: new Float32Array(4), nodeCount: 0 };
  assert.doesNotThrow(() => smoothPath(grid, path));
  assert.equal(path.nodeCount, 0);
});

test('smoothPath and nav.smooth are safe no-ops on null/malformed handles', async () => {
  const grid = buildOpenGrid(10, 10);
  assert.doesNotThrow(() => smoothPath(grid, null));
  assert.doesNotThrow(() => smoothPath(grid, undefined));
  assert.doesNotThrow(() => smoothPath(grid, {}));

  const { nav } = await makeNav();
  nav.rebuild(makeZone());
  assert.doesNotThrow(() => nav.smooth(null));
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test('MAIN: smoothing an already-smoothed path a second time changes nothing', () => {
  const width = 90, height = 90;
  const grid = buildOpenGrid(width, height);
  blockCell(grid, 40, 41);

  const nodes = [];
  for (let k = 0; k < width - 1; k++) {
    const c1 = cellCentre(grid, k, k);
    if (nodes.length === 0) nodes.push(c1);
    nodes.push(cellCentre(grid, k + 1, k));
    nodes.push(cellCentre(grid, k + 1, k + 1));
  }

  const path = makePathHandle(nodes);
  smoothPath(grid, path);
  const afterFirst = path.nodeCount;
  const snapshot = [];
  for (let i = 0; i < afterFirst; i++) snapshot.push(readNode(path, i));

  smoothPath(grid, path);
  const afterSecond = path.nodeCount;

  assert.equal(afterSecond, afterFirst, 'a second smoothing pass must not change the node count');
  for (let i = 0; i < afterSecond; i++) {
    const n = readNode(path, i);
    assert.equal(n.x, snapshot[i].x, `node ${i} x must be unchanged by a second pass`);
    assert.equal(n.z, snapshot[i].z, `node ${i} z must be unchanged by a second pass`);
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('MAIN: two independently-built, identical (grid, path) inputs smooth to byte-identical output, node for node', () => {
  function buildScenario() {
    const grid = buildOpenGrid(90, 90);
    blockCell(grid, 40, 41);
    const nodes = [];
    for (let k = 0; k < 89; k++) {
      if (nodes.length === 0) nodes.push(cellCentre(grid, k, k));
      nodes.push(cellCentre(grid, k + 1, k));
      nodes.push(cellCentre(grid, k + 1, k + 1));
    }
    return { grid, path: makePathHandle(nodes) };
  }

  const a = buildScenario();
  const b = buildScenario();
  smoothPath(a.grid, a.path);
  smoothPath(b.grid, b.path);

  assert.equal(a.path.nodeCount, b.path.nodeCount);
  for (let i = 0; i < a.path.nodeCount; i++) {
    assert.equal(a.path.nodesX[i], b.path.nodesX[i], `node ${i} x must match exactly`);
    assert.equal(a.path.nodesY[i], b.path.nodesY[i], `node ${i} y must match exactly`);
    assert.equal(a.path.nodesZ[i], b.path.nodesZ[i], `node ${i} z must match exactly`);
  }
});

// ---------------------------------------------------------------------------
// Wiring — nav.smooth(path) mutates the exact handle pollPath returned, and
// the public pathNode/pathLength API reflects the smoothed state.
// ---------------------------------------------------------------------------

test('nav.smooth(path) mutates the same handle in place; pathLength/pathNode reflect the smoothed result afterward', async () => {
  const world = makeStubWorld();
  const { nav, ctx } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 30, halfZ: 20 }));

  const id = nav.requestPath(-20, -6, 20, 9, 1);
  tick(nav, ctx, 5);
  const path = nav.pollPath(id);
  assert.ok(path);
  const before = nav.pathLength(path);

  nav.smooth(path);

  assert.equal(nav.pollPath(id), path, 'the same requestId must still resolve to the SAME object after smoothing (in place, no new handle)');
  const after = nav.pathLength(path);
  assert.ok(after <= before);
  assert.ok(after >= 2);
});

// ---------------------------------------------------------------------------
// Allocation — smooth is Alloc: no.
// ---------------------------------------------------------------------------

test('12.Axx segmentWalkable and smoothPath are allocation-free', { skip: !hasGc() && 'run with --expose-gc' }, () => {
  const grid = buildOpenGrid(60, 60);
  blockCell(grid, 20, 21);
  const a = cellCentre(grid, 0, 0);
  const b = cellCentre(grid, 59, 59);

  const r1 = assertAllocationFree(() => segmentWalkable(grid, a.x, a.z, b.x, b.z));
  assert.ok(r1.bytesPerCall < 1);

  // smoothPath mutates a handle's own node count — a repeatedly-called
  // allocation probe needs a stable, unaffected-by-shrinkage input, so it
  // is rebuilt as an ALREADY-STRAIGHT 2-node path (the cheapest, most common
  // steady-state call: smooth() on a path that needs no work) each round.
  // `allocatedBytes`'s own warm-up call is folded into that same closure.
  const path = makePathHandle([a, b]);
  const r2 = assertAllocationFree(() => {
    path.nodeCount = 2;
    smoothPath(grid, path);
  });
  assert.ok(r2.bytesPerCall < 1);
});

// Scope (that this ticket implemented only its own row and did not stub any
// successor's) is verified by the orchestrator at review time against
// docs/spec/02-api-contracts.md, not encoded here as a standing assertion —
// every later ticket in this same subsystem is required to falsify a "these
// methods don't exist yet" check like the one that used to live here (O-27),
// which is exactly what happened the moment NAV-4 landed `buildFlowField`
// (O-39).
