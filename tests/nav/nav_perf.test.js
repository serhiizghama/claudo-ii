// tests/nav/nav_perf.test.js
//
// TEST-4 — the 12.P08 / 12.P09 milestone gate assertions (docs/spec/
// 12-testing.md §8's table; §11's M1 row: "12.P08 (nav.rebuild <= 3 ms),
// 12.P09 (A* <= 1 ms)"). `node:test` + `node:assert/strict` only
// (12-testing.md P6).
//
// §8's own table names `tests/nav/astar.test.js` as 12.P09's harness; this
// file keeps the `nav_perf.test.js` name instead, deliberately, because it
// carries BOTH gates (12.P08 is `nav.rebuild`, not A* at all) and because
// this ticket's brief calls it out by this name — see this ticket's report.
//
// This file is NOT a rewrite of tests/nav/nav1..5.test.js (accepted, 84
// passing tests, untouched by this ticket). It is the GATE layer those
// files don't quite carry:
//
//   - tests/nav/nav1.test.js already measures THIS EXACT nav.rebuild
//     scenario (96x96 m, ~1150 footprints) but deliberately loosens the
//     ceiling to 20 ms "to avoid CI flake (O-34)" — its own comment says
//     the real numbers belong in this ticket's report. This file restores
//     the real 3.0 ms 12.P08 budget, asserted on a PERCENTILE (never a
//     max — see tests/nav/nav4.test.js's own documented lesson) so the
//     gate is real without reintroducing the flake nav1 sidestepped.
//   - tests/nav/nav2.test.js already has its own "12.P09" test, but it
//     measures the NODE-CAP-ABORT case on purpose (a corridor that vastly
//     exceeds NODE_CAP, so `stats.refusals` increases on every single
//     solve) using a plain max over 30 solves. That is a real and useful
//     measurement, but by itself it is exactly the shape of gate this
//     ticket's brief warns about ("beware the NAV-2 trap: 12.P09 is
//     satisfiable by aborting"). This file adds the half that check alone
//     does not cover: a genuinely SOLVABLE maze, so the timing assertion
//     cannot be satisfied by giving up early — every sample below must
//     both stay under budget AND return a real, walkable path, with
//     `stats.refusals` unchanged across the whole run.
//
// Per O-34, both gates here are meant to be run with
// `--test-concurrency=1`, isolated from the rest of the suite's CPU
// contention (see package.json's `test:perf` script and this file's own
// entry in the sensitive-file list there) — a sub-millisecond/low-single-
// -digit-millisecond wall-clock read is exactly the class of measurement
// that a loaded machine's scheduler can spike past budget without any
// change to the code being measured (see tests/nav/nav4.test.js's header
// for the full argument and the measured numbers behind it).
//
// Per O-38, every grid here is built directly: 12.P08 via
// `NavSystem.rebuild(zone)` against a stub `world` (tests/nav/nav1.test.js's
// own pattern), 12.P09 by hand-assigning `nav._grid`/`nav._version`
// (tests/nav/nav2.test.js's own pattern for its hostile-maze test) — never
// through `world.enterZone`.
//
// No `Math.random()` anywhere in this file (rule 3) — every scenario below
// is built from plain deterministic index arithmetic, matching every other
// nav test file's own perf scenarios.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import { createNavGrid, createRasterScratch, passN7Regions, NAV_FLAG, RASTER } from '../../src/nav/grid.js';
import { NODE_CAP } from '../../src/nav/astar.js';
import { makeStubCtx } from '../helpers/actor.js';

// ---------------------------------------------------------------------------
// Percentile helper — the same shape tests/nav/nav4.test.js established:
// p50/p90/p99 all logged, only p99 gates. See that file's header for why a
// max is the wrong statistic for a sub-millisecond operation.
// ---------------------------------------------------------------------------

/** @param {number[]} samplesMs @returns {{p50:number,p90:number,p99:number,max:number}} */
function percentilesOf(samplesMs) {
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[sorted.length - 1] };
}

// ---------------------------------------------------------------------------
// 12.P08 — nav.rebuild() on a 96x96 m zone <= 3.0 ms.
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

/** ASSIGNED — 1150, `07-world-gen.md` §6.5's own "≈1150 footprints" Ashen-
 * Wastes figure — the same scale tests/nav/nav1.test.js's own (loosened)
 * timing test already builds against, so this gate is measured at the scale
 * the spec actually budgets for, not an arbitrary smaller one. */
const ASHEN_WASTES_FOOTPRINT_COUNT = 1150;

/** The same box/cylinder scatter tests/nav/nav1.test.js's own timing test
 * builds — deliberately identical layout, so a reader comparing the two
 * files' console output is comparing the same scenario at two different
 * ceilings (nav1's loosened 20 ms sanity check vs. this file's real 3.0 ms
 * gate), not two different mazes. @returns {object[]} */
function buildAshenWastesFootprints() {
  const footprints = [];
  for (let i = 0; i < ASHEN_WASTES_FOOTPRINT_COUNT; i++) {
    const gx = (i % 40) - 20;
    const gz = Math.floor(i / 40) - 15;
    footprints.push({
      kind: i % 2 === 0 ? 'box' : 'cylinder',
      x: gx * 2.1,
      z: gz * 2.1,
      y: 0,
      height: 2,
      halfW: 0.4,
      halfL: 0.4,
      radius: 0.4,
      facing: 0,
      blocksNav: true,
    });
  }
  return footprints;
}

function makeZone({ zoneId = 'ashen_wastes_perf', halfX = 48, halfZ = 48 } = {}) {
  // halfX/halfZ = 48 => a 96x96 m zone => 192x192 cells at the fixed 0.5 m
  // cell size — 12.P08's own literal "96x96 m zone" wording.
  return { zoneId, boundsMinX: -halfX, boundsMaxX: halfX, boundsMinZ: -halfZ, boundsMaxZ: halfZ, navVersion: 0 };
}

test('12.P08: nav.rebuild() on a 96x96 m zone (192x192 cells, 1150 footprints) — p99 <= 3.0 ms, warm steady-state', async () => {
  const footprints = buildAshenWastesFootprints();
  const world = makeStubWorld({ staticFootprints: footprints });
  const { nav, ctx } = await makeNav({ world });
  const zone = makeZone();

  let lastRebuiltPayload = null;
  ctx.events.on('nav:rebuilt', (payload) => {
    lastRebuiltPayload = payload;
  });

  // Warm-up (O-23 discipline). The FIRST call is also the one that moves
  // the grid from NavSystem's 4x4 placeholder to a real 192x192 (the only
  // time this scenario reallocates — src/nav/index.js's rebuild() reuses
  // the typed arrays on every later call at the same cell dimensions).
  // 30 calls settles that one-time allocation AND the JIT, matching
  // tests/nav/nav4.test.js's own reasoning for its 100-call warm-up on a
  // comparably-costed hot path (a smaller iteration count is enough here
  // because nav.rebuild's own cost, ~1.3 ms measured, is far higher per
  // call than flow-field's ~0.4 ms — the JIT specialises a monomorphic call
  // site in a handful of calls regardless of the per-call cost).
  const WARMUP_CALLS = 30;
  for (let i = 0; i < WARMUP_CALLS; i++) nav.rebuild(zone);

  const versionBeforeSamples = nav.version;

  // SAMPLES = 300 — matching tests/nav/nav4.test.js's own "well over the
  // 200+ after warm-up a meaningful p99 needs" reasoning; nav.rebuild's own
  // per-call cost (low single-digit ms) keeps 300 calls well within budget
  // for an N-surface test file.
  const SAMPLES = 300;
  const samples = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = process.hrtime.bigint();
    nav.rebuild(zone);
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1e6;
  }

  const { p50, p90, p99, max } = percentilesOf(samples);
  // eslint-disable-next-line no-console
  console.log(
    `[TEST-4] 12.P08 nav.rebuild() 96x96 m / ${ASHEN_WASTES_FOOTPRINT_COUNT} footprints, ${SAMPLES} samples ` +
      `(warm, ${WARMUP_CALLS}-call warm-up): p50=${p50.toFixed(4)} p90=${p90.toFixed(4)} p99=${p99.toFixed(4)} ` +
      `max=${max.toFixed(4)} ms (budget 3.0 ms, asserted on p99)`,
  );

  // The work actually happened, every single sample — not a cached or
  // early-return no-op that would read fast for the wrong reason.
  assert.equal(
    nav.version,
    versionBeforeSamples + SAMPLES,
    'nav.version must increment exactly once per rebuild() call — proves every sample really re-ran N1-N11, not a skipped/cached rebuild',
  );

  // A real PARTIAL rasterisation, not a degenerate all-blocked or
  // all-walkable grid: 1150 footprints must leave a real, substantial
  // fraction of the 192x192 grid on each side of "blocked".
  const grid = nav.grid;
  let blockedCount = 0;
  for (let i = 0; i < grid.flags.length; i++) {
    if (!(grid.flags[i] & NAV_FLAG.walkable)) blockedCount++;
  }
  assert.ok(
    blockedCount > 500 && blockedCount < grid.flags.length - 500,
    `expected a real partial rasterisation (some blocked, some open) from ${ASHEN_WASTES_FOOTPRINT_COUNT} footprints, got ${blockedCount}/${grid.flags.length} blocked`,
  );
  // A real footprint's own centre must actually read blocked — the most
  // direct possible proof that THIS rebuild's rasterisation ran against
  // THESE footprints, not stale data from an earlier call.
  assert.equal(
    nav.walkable(footprints[0].x, footprints[0].z),
    false,
    'a real footprint centre must block its own cell — proves rasterisation ran against the actual footprint list, not a no-op',
  );

  // The N11 event contract (07 §6.2/§6.7) held throughout: a real,
  // non-empty region set reported for the zone this test actually rebuilt.
  assert.ok(lastRebuiltPayload, 'nav:rebuilt must have fired at least once');
  assert.equal(lastRebuiltPayload.zoneId, zone.zoneId);
  assert.ok(lastRebuiltPayload.regionCount >= 1, 'a real rasterised grid must report at least one region');

  assert.ok(p99 <= 3.0, `12.P08: p99 nav.rebuild() time ${p99.toFixed(4)} ms must be <= 3.0 ms`);
});

// ---------------------------------------------------------------------------
// 12.P09 — a single A* solve, worst case, <= 1.0 ms, on a maze that must
// actually be SOLVED (not aborted) for the measurement to mean anything.
// ---------------------------------------------------------------------------

/** Advances `ctx.time.step` and calls `nav.fixedUpdate` — the only way a
 * pending request actually gets solved (`requestPath` itself only enqueues).
 * Same helper tests/nav/nav2.test.js/nav4.test.js already define locally.
 * @param {NavSystem} nav @param {object} ctx @param {number} [times] */
function tick(nav, ctx, times = 1) {
  for (let i = 0; i < times; i++) {
    ctx.time.step++;
    nav.fixedUpdate(1 / 60, ctx);
  }
}

/**
 * A "boustrophedon" single-width corridor — the same maze shape
 * tests/nav/nav2.test.js's own `buildSnakeMazeGrid` builds (full-width open
 * rows, each separated by a wall row with one gap, alternating ends), but
 * sized to stay UNDER `NODE_CAP` (unlike nav2's own 12.P09 test, which sizes
 * it to vastly EXCEED the cap on purpose). A path graph of degree <= 2
 * still forces A* to expand close to the corridor's full cell count (no
 * shortcuts to skip ahead on) — the worst realistic case for a solve that
 * must actually SUCCEED, as opposed to nav2's worst case for a solve that
 * gives up. Cost varies per cell (`1 + ((cx + row*3) % 30)`), matching
 * nav2's own maze, so this also stays a real cost-weighted solve, not a
 * unit-cost one.
 * @param {{width?:number, lanes?:number, cellSize?:number}} [opts]
 * @returns {{grid:object, start:{x:number,z:number}, goal:{x:number,z:number}, totalOpenCells:number}}
 */
function buildSolvableSerpentineMaze({ width = 40, lanes = 20, cellSize = 0.5 } = {}) {
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
  const cellCentre = (cx, cz) => ({ x: grid.originX + (cx + 0.5) * grid.cellSize, z: grid.originZ + (cz + 0.5) * grid.cellSize });

  return {
    grid,
    start: cellCentre(0, 0),
    goal: cellCentre(goalCol, lastLaneRow),
    totalOpenCells: lanes * width,
  };
}

async function makeBareNav() {
  const ctx = makeStubCtx({ systems: { world: makeStubWorld() } });
  const nav = new NavSystem();
  await nav.init(ctx);
  return { nav, ctx };
}

test('12.P09: worst-case single A* solve on a genuinely SOLVABLE serpentine maze — p99 <= 1.0 ms, and a real path is found every time (guards the NAV-2 abort trap)', async () => {
  // ASSIGNED — width 40, lanes 20 (800 open cells): comfortably under
  // NODE_CAP (1200, imported above so this assertion tracks the real
  // constant rather than a copied literal) with margin, so this maze is
  // guaranteed solvable regardless of how many cells this weighted search
  // happens to touch before finding the goal — unlike tests/nav/nav2.test.js's
  // own 12.P09 maze (width 192, lanes 96 — deliberately far over the cap).
  const { grid, start, goal, totalOpenCells } = buildSolvableSerpentineMaze({ width: 40, lanes: 20 });
  assert.ok(
    totalOpenCells < NODE_CAP,
    `test setup: this maze (${totalOpenCells} open cells) must stay under NODE_CAP (${NODE_CAP}) — a real solve, not an abort, is what this gate times`,
  );

  const { nav, ctx } = await makeBareNav();
  nav._grid = grid;
  nav._version = 1;
  nav.setBudget(1); // one fixedUpdate call == exactly one solve (tests/nav/nav2.test.js's own 12.P09 pattern)

  // Warm-up (O-23), each one checked to have actually solved — a warm-up
  // that silently aborted would settle the JIT against the wrong code path.
  const WARMUP_CALLS = 20;
  for (let i = 0; i < WARMUP_CALLS; i++) {
    const id = nav.requestPath(start.x, start.z, goal.x, goal.z, 1);
    assert.ok(id > 0, 'test setup: warm-up requests must be accepted');
    tick(nav, ctx, 1);
    const path = nav.pollPath(id);
    assert.ok(path, 'test setup: warm-up solves must find a real path, never abort');
    nav.releasePath(path);
  }

  const refusalsBefore = nav.stats.refusals;

  // SAMPLES = 300 — same reasoning as 12.P08 above and tests/nav/nav4.test.js.
  const SAMPLES = 300;
  const samples = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const id = nav.requestPath(start.x, start.z, goal.x, goal.z, 1);
    assert.ok(id > 0, `sample ${i}: the request pool must not be exhausted mid-measurement`);

    ctx.time.step++;
    const t0 = process.hrtime.bigint();
    nav.fixedUpdate(1 / 60, ctx);
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1e6;

    // The NAV-2 trap, guarded against directly (this ticket's brief, and
    // NAV-2's own history: "it hit the 1200-node cap and returned in
    // 0.07 ms while failing to find ordinary paths"). A fast solve here is
    // worthless if it got there by giving up instead of finding a path.
    const path = nav.pollPath(id);
    assert.ok(path, `sample ${i}: must find a REAL path, not abort — a fast-but-empty solve would satisfy the timing budget for the wrong reason`);
    assert.ok(nav.pathLength(path) >= 2, `sample ${i}: a real path must have at least 2 nodes`);
    nav.releasePath(path);
  }

  assert.equal(
    nav.stats.refusals,
    refusalsBefore,
    'stats.refusals must not increase across any of these samples — every solve here must succeed, never hit the node cap',
  );

  const { p50, p90, p99, max } = percentilesOf(samples);
  // eslint-disable-next-line no-console
  console.log(
    `[TEST-4] 12.P09 single A* solve, solvable ${grid.width}x${grid.height} serpentine maze (${totalOpenCells} open cells), ` +
      `${SAMPLES} samples: p50=${p50.toFixed(4)} p90=${p90.toFixed(4)} p99=${p99.toFixed(4)} max=${max.toFixed(4)} ms ` +
      `(budget 1.0 ms, asserted on p99)`,
  );

  assert.ok(p99 <= 1.0, `12.P09: p99 solve time ${p99.toFixed(4)} ms must be <= 1.0 ms`);
});
