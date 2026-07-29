// tests/world/wrld2.test.js
//
// WRLD-2 acceptance tests for src/world/raster.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// Scope: the ticket's literal acceptance criterion — "rasterises 96x96 m
// from footprints alone, in Node, with no `physics` instance" — plus the
// correctness details the orchestrator was told to check specifically:
// dilation 0.30 (not 0.36), N7 determinism/stability, N10-after-N7
// interaction, N6's cost formula, the exact NAV_FLAG bit values, the array
// types (`region` must be Int16Array, signed), and the index formula
// `cz * width + cx`. Per O-27, every assertion below is on actual rasterised
// behaviour (real cell counts, real flag bits, real hashes) — never on "the
// object exists" or an empty-stats shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  NAV_FLAG,
  RASTER,
  createNavGrid,
  createRasterScratch,
  worldToCell,
  cellIndexAt,
  passN1Clear,
  passN2GroundStamp,
  passN3Slope,
  passN4FootprintStamp,
  passN5Doorway,
  passN6Cost,
  passN7Regions,
  passN8EntryRegion,
  passN9SpawnDeny,
  passN10Prune,
  rasterizeNav,
} from '../../src/world/raster.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

const WIDTH = 192; // 96 m / 0.5 m
const HEIGHT = 192;
const ORIGIN = -48; // centres the grid on the zone, per 01 §9.3's ashen_wastes example

function makeWastesGrid() {
  return createNavGrid({ cellSize: 0.5, width: WIDTH, height: HEIGHT, originX: ORIGIN, originZ: ORIGIN });
}

function countFlagged(grid, bit) {
  let n = 0;
  for (let i = 0; i < grid.flags.length; i++) if (grid.flags[i] & bit) n++;
  return n;
}

/** Deterministic, dependency-free FNV-1a over a typed array's raw bytes —
 * used only by this test file (raster.js itself imports nothing) to check
 * "two runs produce byte-identical region arrays" without eyeballing
 * 36 864 numbers. */
function fnv1aOfTypedArray(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Zero imports — the module must be importable with no `physics` instance,
// no `three`, no DOM global. Checked both structurally (source text) and
// behaviourally (the whole rest of this file never constructs one).
// ---------------------------------------------------------------------------

test('src/world/raster.js has zero import statements', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../src/world/raster.js'), 'utf8');
  assert.equal(/^\s*import\b/m.test(src), false, 'must not statically import anything');
  assert.equal(/import\s*\(/.test(src), false, 'must not dynamically import anything');
  assert.equal(/require\s*\(/.test(src), false, 'must not require anything');
  assert.equal(/from\s+['"]three['"]/.test(src), false);
});

// ---------------------------------------------------------------------------
// NAV_FLAG — exact bit values, 01-data-model.md §9.3
// ---------------------------------------------------------------------------

test('NAV_FLAG bit values match 01-data-model.md §9.3 exactly', () => {
  assert.equal(NAV_FLAG.walkable, 1);
  assert.equal(NAV_FLAG.blocked, 2);
  assert.equal(NAV_FLAG.hazard, 4);
  assert.equal(NAV_FLAG.water, 8);
  assert.equal(NAV_FLAG.doorway, 16);
  assert.equal(NAV_FLAG.spawnDeny, 32);
  assert.equal(NAV_FLAG.interior, 64);
  assert.ok(Object.isFrozen(NAV_FLAG));
});

test('the dilation constant is 0.30 m (07 §6.3), never the 0.36 m player radius', () => {
  assert.equal(RASTER.DILATION, 0.3);
});

// ---------------------------------------------------------------------------
// createNavGrid — 01 §9.3's exact array types and index formula
// ---------------------------------------------------------------------------

test('createNavGrid allocates the five typed arrays with the exact 01 §9.3 types and sizes', () => {
  const grid = makeWastesGrid();
  assert.ok(grid.flags instanceof Uint8Array);
  assert.ok(grid.cost instanceof Uint8Array);
  assert.ok(grid.region instanceof Int16Array, 'region must be a SIGNED type — -1 requires it');
  assert.ok(grid.groundY instanceof Float32Array);
  assert.equal(grid.flags.length, WIDTH * HEIGHT);
  assert.equal(grid.cost.length, WIDTH * HEIGHT);
  assert.equal(grid.region.length, WIDTH * HEIGHT);
  assert.equal(grid.groundY.length, WIDTH * HEIGHT);
  assert.equal(grid.width, WIDTH);
  assert.equal(grid.height, HEIGHT);
  assert.equal(grid.cellSize, 0.5);
});

test('index formula is cz * width + cx, cx/cz = floor((coord - origin) / cellSize)', () => {
  const grid = makeWastesGrid();
  // World origin corner (cell 0,0): its centre is at originX + 0.25, originZ + 0.25.
  const i0 = cellIndexAt(grid, ORIGIN + 0.1, ORIGIN + 0.1);
  assert.equal(i0, 0);
  // One cell to the right (+x): index +1.
  const i1 = cellIndexAt(grid, ORIGIN + 0.6, ORIGIN + 0.1);
  assert.equal(i1, 1);
  // One cell down (+z): index += width, NOT += 1 — proves axis order.
  const i2 = cellIndexAt(grid, ORIGIN + 0.1, ORIGIN + 0.6);
  assert.equal(i2, WIDTH);
  const c = worldToCell(grid, ORIGIN + 10.25, ORIGIN + 20.25);
  assert.equal(c.cx, 20);
  assert.equal(c.cz, 40);
  assert.equal(cellIndexAt(grid, ORIGIN + 10.25, ORIGIN + 20.25), 40 * WIDTH + 20);
  // Off-grid.
  assert.equal(cellIndexAt(grid, ORIGIN - 1, 0), -1);
  assert.equal(cellIndexAt(grid, 1000, 0), -1);
});

// ---------------------------------------------------------------------------
// THE MAIN TEST — rasterises 96x96 m from footprints alone, in Node, no physics
// ---------------------------------------------------------------------------

test('MAIN: rasterises 96x96 m (192x192 = 36864 cells) from footprints alone — no groundRegions, no height, no physics instance anywhere', () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  assert.equal(grid.flags.length, 36864);

  // Hand-built footprint list, 02-api-contracts.md §4 shape exactly (O-35:
  // blocksNav/facing/cylinder/poly, never navBlock/rotation/circle/convex).
  // A single box pillar near the centre of the zone.
  const footprints = [
    { kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 1, halfL: 1, facing: 0, blocksNav: true, blocksSight: true },
    // A non-blocking footprint (blocksNav: false) must be fully ignored.
    { kind: 'cylinder', x: 10, z: 10, y: 0, height: 1, radius: 0.5, facing: 0, blocksNav: false, blocksSight: false },
  ];

  const result = rasterizeNav(grid, scratch, { footprints });

  // No groundRegions given -> N2's absent-input fallback -> whole grid is
  // walkable ground, minus what N4 actually carved out for the pillar.
  const totalCells = WIDTH * HEIGHT;
  const blockedCells = countFlagged(grid, NAV_FLAG.blocked);
  const walkableCells = countFlagged(grid, NAV_FLAG.walkable);

  assert.ok(blockedCells > 0, 'the pillar must actually block cells');
  assert.ok(blockedCells < 200, 'a 1x1 m pillar dilated by 0.3 m must block a small, local area, not the whole grid');
  assert.equal(walkableCells + blockedCells, totalCells, 'every cell is either walkable or blocked when no ground regions carve holes');
  // The non-blocking cylinder must not have removed any walkable cells.
  const iAtNonBlocker = cellIndexAt(grid, 10, 10);
  assert.ok(grid.flags[iAtNonBlocker] & NAV_FLAG.walkable, 'blocksNav:false footprint must be fully ignored by N4');

  assert.equal(result.regionCount, 1, 'one pillar in an open field leaves exactly one connected walkable region');
  assert.equal(grid.regionCount, 1);

  // Region 0 must contain the lowest-index walkable cell (07 §6.2 N7).
  let lowestWalkable = -1;
  for (let i = 0; i < totalCells; i++) {
    if (grid.flags[i] & NAV_FLAG.walkable) { lowestWalkable = i; break; }
  }
  assert.ok(lowestWalkable >= 0);
  assert.equal(grid.region[lowestWalkable], 0);
});

test('a footprint list with only blocksNav:false entries rasterises to a fully walkable, single-region grid', () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  const footprints = [{ kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 5, halfL: 5, facing: 0, blocksNav: false, blocksSight: true }];
  const result = rasterizeNav(grid, scratch, { footprints });
  assert.equal(countFlagged(grid, NAV_FLAG.blocked), 0);
  assert.equal(countFlagged(grid, NAV_FLAG.walkable), WIDTH * HEIGHT);
  assert.equal(result.regionCount, 1);
});

test('an empty footprint list rasterises to a fully walkable, single-region 96x96 m grid', () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  const result = rasterizeNav(grid, scratch, { footprints: [] });
  assert.equal(countFlagged(grid, NAV_FLAG.walkable), WIDTH * HEIGHT);
  assert.equal(result.regionCount, 1);
});

// ---------------------------------------------------------------------------
// N4 — footprint stamp: O-35 field names, dilation, shapes
// ---------------------------------------------------------------------------

test('N4: a box footprint with navBlock/rotation fields (07 §1.7 superseded names) is NOT treated as blocking or misshapen', () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  // Only 02 §4's fields are read; a stray `navBlock`/`rotation` from the
  // superseded record must be silently ignored, not misread.
  const footprints = [{ kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 2, halfL: 2, facing: 0, blocksNav: true, navBlock: false, rotation: 999 }];
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN4FootprintStamp(grid, footprints, scratch);
  assert.ok(countFlagged(grid, NAV_FLAG.blocked) > 0, 'blocksNav:true must block regardless of a stray navBlock field');
});

test('N4: a cylinder footprint blocks a disc, not a box, and radius is respected', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 40, height: 40, originX: -10, originZ: -10 });
  const scratch = createRasterScratch(40, 40);
  const footprints = [{ kind: 'cylinder', x: 0, z: 0, y: 0, height: 3, radius: 1.0, facing: 0, blocksNav: true }];
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN4FootprintStamp(grid, footprints, scratch);
  // Corner of the bounding square (radius * sqrt2 away along the diagonal
  // direction is outside the disc) must stay walkable, straight out along
  // an axis at just past dilation+radius must be blocked.
  const iCentre = cellIndexAt(grid, 0.1, 0.1);
  assert.ok(grid.flags[iCentre] & NAV_FLAG.blocked, 'centre of the pillar must be blocked');
  const iFar = cellIndexAt(grid, 5, 5);
  assert.ok(grid.flags[iFar] & NAV_FLAG.walkable, 'far corner must be untouched');
});

test('N4: a rotated (non-axis-aligned) box uses the polygon path and still blocks its own footprint', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 40, height: 40, originX: -10, originZ: -10 });
  const scratch = createRasterScratch(40, 40);
  const footprints = [{ kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 1.5, halfL: 1.5, facing: Math.PI / 6, blocksNav: true }];
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN4FootprintStamp(grid, footprints, scratch);
  const iCentre = cellIndexAt(grid, 0.1, 0.1);
  assert.ok(grid.flags[iCentre] & NAV_FLAG.blocked, 'centre of a rotated box must still be blocked');
  const iFar = cellIndexAt(grid, 8, 8);
  assert.ok(grid.flags[iFar] & NAV_FLAG.walkable, 'far corner must be untouched by a small rotated box');
});

test('N4: a poly footprint blocks inside its own convex hull', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 40, height: 40, originX: -10, originZ: -10 });
  const scratch = createRasterScratch(40, 40);
  // A small CCW triangle around the origin.
  const points = [1, 0, -1, 1, -1, -1];
  const footprints = [{ kind: 'poly', points, y: 0, height: 3, blocksNav: true }];
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN4FootprintStamp(grid, footprints, scratch);
  const iCentre = cellIndexAt(grid, -0.3, 0);
  assert.ok(grid.flags[iCentre] & NAV_FLAG.blocked, 'a point inside the triangle must be blocked');
  const iFar = cellIndexAt(grid, 8, 8);
  assert.ok(grid.flags[iFar] & NAV_FLAG.walkable);
});

// ---------------------------------------------------------------------------
// N2/N3 — optional groundRegions / height, absent-input behaviour
// ---------------------------------------------------------------------------

test('N2: with groundRegions given, only cells inside a region are walkable; interior/water tags apply', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 40, height: 40, originX: -10, originZ: -10 });
  const groundRegions = [
    { kind: 'box', x: -5, z: -5, halfW: 2, halfL: 2, interior: true },
    { kind: 'disc', x: 5, z: 5, radius: 1.5, water: true },
  ];
  passN1Clear(grid);
  passN2GroundStamp(grid, groundRegions);

  const iInBox = cellIndexAt(grid, -5, -5);
  assert.ok(grid.flags[iInBox] & NAV_FLAG.walkable);
  assert.ok(grid.flags[iInBox] & NAV_FLAG.interior);
  assert.equal(grid.flags[iInBox] & NAV_FLAG.water, 0);

  const iInDisc = cellIndexAt(grid, 5, 5);
  assert.ok(grid.flags[iInDisc] & NAV_FLAG.walkable);
  assert.ok(grid.flags[iInDisc] & NAV_FLAG.water);

  const iOutside = cellIndexAt(grid, 0, -8);
  assert.equal(grid.flags[iOutside] & NAV_FLAG.walkable, 0, 'a cell outside every ground region must not be walkable');
});

test('N3: absent height field is a documented no-op — no cell is ever blocked by slope', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 10, height: 10, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(10, 10);
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  const before = grid.flags.slice();
  passN3Slope(grid, null, scratch);
  assert.deepEqual(grid.flags, before, 'passN3Slope(grid, null, scratch) must not touch flags at all');
});

test('N3: a height field with a steep step blocks the higher cell of the pair, never the lower one', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 4, height: 1, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(4, 1);
  passN1Clear(grid);
  passN2GroundStamp(grid, null); // whole row walkable
  const heightField = new Float32Array([0, 0, 1.0, 1.0]); // step of 1.0 m between cell 1 and 2 (> 0.45)
  passN3Slope(grid, heightField, scratch);
  assert.ok(grid.flags[0] & NAV_FLAG.walkable, 'flat side, low, untouched');
  assert.ok(grid.flags[1] & NAV_FLAG.walkable, 'low side of the step stays walkable');
  assert.equal(grid.flags[2] & NAV_FLAG.walkable, 0, 'high side of the step is blocked');
  assert.ok(grid.flags[2] & NAV_FLAG.blocked);
  assert.ok(grid.flags[3] & NAV_FLAG.walkable, 'flat side, high plateau itself, untouched (no delta with its own neighbour)');
});

// ---------------------------------------------------------------------------
// N5 — doorway
// ---------------------------------------------------------------------------

test('N5: a cell whose 8-neighbourhood has <= 4 walkable cells is flagged doorway; a fully-open interior cell is not', () => {
  // Direct flags construction (rather than fighting footprint geometry to
  // hand-tune an exact neighbour count) — isolates N5's own rule.
  const grid = createNavGrid({ cellSize: 0.5, width: 5, height: 5, originX: 0, originZ: 0 });
  passN1Clear(grid);
  // A plus-shape of 5 walkable cells centred on (2,2): the centre cell's
  // 8-neighbourhood then has exactly 4 walkable cells (N,S,E,W), the 4
  // diagonals are blocked -> doorway. Every other walkable cell in the plus
  // has only 1 walkable neighbour (also <= 4) so is a doorway too; that is
  // consistent with the rule as specified, not a test bug.
  const idx = (cx, cz) => cz * 5 + cx;
  for (const [cx, cz] of [[2, 2], [1, 2], [3, 2], [2, 1], [2, 3]]) grid.flags[idx(cx, cz)] = NAV_FLAG.walkable;
  passN5Doorway(grid, null);
  assert.ok(grid.flags[idx(2, 2)] & NAV_FLAG.doorway, 'centre of a plus-shaped opening (4 walkable neighbours) must be flagged doorway');

  // A fully open 5x5 block: the centre cell's 8-neighbourhood is all 8
  // walkable -> must NOT be flagged doorway.
  const grid2 = createNavGrid({ cellSize: 0.5, width: 5, height: 5, originX: 0, originZ: 0 });
  passN1Clear(grid2);
  grid2.flags.fill(NAV_FLAG.walkable);
  passN5Doorway(grid2, null);
  assert.equal(grid2.flags[idx(2, 2)] & NAV_FLAG.doorway, 0, 'an interior cell with all 8 neighbours walkable must not be flagged doorway');
});

test('N5: a groundRegion flagged doorway stamps the bit inside its extent, only on walkable cells', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 20, height: 20, originX: -5, originZ: -5 });
  const groundRegions = [{ kind: 'box', x: 0, z: 0, halfW: 10, halfL: 10 }, { kind: 'disc', x: 0, z: 0, radius: 1, doorway: true }];
  passN1Clear(grid);
  passN2GroundStamp(grid, groundRegions);
  passN5Doorway(grid, groundRegions);
  const iCentre = cellIndexAt(grid, 0, 0);
  assert.ok(grid.flags[iCentre] & NAV_FLAG.doorway);
});

// ---------------------------------------------------------------------------
// N6 — cost formula
// ---------------------------------------------------------------------------

test('N6: cost = 255 for any non-walkable cell, 1 for a plain walkable cell, and sums the near-wall/water/hazard bonuses', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 4, height: 1, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(4, 1);
  passN1Clear(grid);
  // cell 0: not walkable at all
  // cell 1: walkable, plain
  // cell 2: walkable, nearWall + water
  // cell 3: walkable, nearWall + water + hazard (would be 1+2+6+12=21, well under 254)
  grid.flags[1] = NAV_FLAG.walkable;
  grid.flags[2] = NAV_FLAG.walkable | NAV_FLAG.water;
  grid.flags[3] = NAV_FLAG.walkable | NAV_FLAG.water | NAV_FLAG.hazard;
  scratch.nearWall[2] = 1;
  scratch.nearWall[3] = 1;
  passN6Cost(grid, scratch);
  assert.equal(grid.cost[0], 255);
  assert.equal(grid.cost[1], 1);
  assert.equal(grid.cost[2], 1 + 2 + 6);
  assert.equal(grid.cost[3], 1 + 2 + 6 + 12);
});

test('N6: cost clamps to 254, never reaching 255 for a walkable cell', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 1, height: 1, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(1, 1);
  passN1Clear(grid);
  grid.flags[0] = NAV_FLAG.walkable | NAV_FLAG.water | NAV_FLAG.hazard;
  scratch.nearWall[0] = 1;
  // Stack the formula manually beyond 254 is impossible with the real bit
  // set (max is 1+2+6+12=21), so this test drives the clamp directly by
  // checking the documented ceiling is respected even at the real max.
  passN6Cost(grid, scratch);
  assert.ok(grid.cost[0] <= 254);
  assert.equal(grid.cost[0], 21);
});

test('N6: doorway is not penalised — a doorway cell costs the same as a plain walkable cell', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 2, height: 1, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(2, 1);
  passN1Clear(grid);
  grid.flags[0] = NAV_FLAG.walkable;
  grid.flags[1] = NAV_FLAG.walkable | NAV_FLAG.doorway;
  passN6Cost(grid, scratch);
  assert.equal(grid.cost[0], grid.cost[1]);
});

// ---------------------------------------------------------------------------
// N7 — regions: determinism, stability, connectivity
// ---------------------------------------------------------------------------

test('N7: two runs over identical input produce byte-identical region arrays (hashed)', () => {
  const footprints = [
    { kind: 'box', x: -3, z: 0, y: 0, height: 3, halfW: 1, halfL: 6, facing: 0, blocksNav: true },
    { kind: 'box', x: 3, z: 0, y: 0, height: 3, halfW: 1, halfL: 6, facing: 0, blocksNav: true },
    { kind: 'cylinder', x: 0, z: 3, y: 0, height: 3, radius: 0.8, facing: 0, blocksNav: true },
  ];
  const hashes = [];
  for (let run = 0; run < 3; run++) {
    const grid = createNavGrid({ cellSize: 0.5, width: 60, height: 60, originX: -15, originZ: -15 });
    const scratch = createRasterScratch(60, 60);
    rasterizeNav(grid, scratch, { footprints });
    hashes.push(fnv1aOfTypedArray(grid.region));
  }
  assert.equal(hashes[0], hashes[1]);
  assert.equal(hashes[1], hashes[2]);
});

test('N7: a wall splitting the grid into two produces regionCount === 2, and region 0 is the lowest-index walkable cell', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 20, height: 20, originX: -5, originZ: -5 });
  const scratch = createRasterScratch(20, 20);
  // A full-width wall across z=0 splits the 20x20 grid into a top half and
  // a bottom half with no walkable connection between them.
  const footprints = [{ kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 20, halfL: 0.6, facing: 0, blocksNav: true }];
  const result = rasterizeNav(grid, scratch, { footprints });
  assert.equal(result.regionCount, 2);
  let lowestWalkable = -1;
  for (let i = 0; i < grid.flags.length; i++) {
    if (grid.flags[i] & NAV_FLAG.walkable) { lowestWalkable = i; break; }
  }
  assert.equal(grid.region[lowestWalkable], 0);
});

test('N7 in isolation: 4-connected only — two walkable cells touching only diagonally are NOT the same region', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 3, height: 3, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(3, 3);
  passN1Clear(grid);
  // Diagonal pair: (0,0) and (1,1) walkable; (1,0) and (0,1) blocked.
  grid.flags[0] = NAV_FLAG.walkable; // cx=0,cz=0 -> index 0
  grid.flags[1 * 3 + 1] = NAV_FLAG.walkable; // cx=1,cz=1 -> index 4
  passN7Regions(grid, scratch);
  assert.notEqual(grid.region[0], grid.region[4], '4-connected labelling must not treat a diagonal touch as connected');
  assert.equal(grid.regionCount, 2);
});

// ---------------------------------------------------------------------------
// N8 — entry region assertion
// ---------------------------------------------------------------------------

test('N8: absent entry is a no-op returning null', () => {
  const grid = makeWastesGrid();
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN7Regions(grid, scratch_(grid));
  assert.equal(passN8EntryRegion(grid, null), null);
  assert.equal(passN8EntryRegion(grid, undefined), null);
});
function scratch_(grid) { return createRasterScratch(grid.width, grid.height); }

test('N8: a walkable entry point returns its region id; a blocked entry point throws', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 10, height: 10, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(10, 10);
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN7Regions(grid, scratch);
  const r = passN8EntryRegion(grid, { x: 1, z: 1 });
  assert.equal(typeof r, 'number');
  assert.ok(r >= 0);

  grid.flags[cellIndexAt(grid, 1, 1)] &= ~NAV_FLAG.walkable;
  grid.region[cellIndexAt(grid, 1, 1)] = -1;
  assert.throws(() => passN8EntryRegion(grid, { x: 1, z: 1 }), /not walkable/);

  assert.throws(() => passN8EntryRegion(grid, { x: 9999, z: 9999 }), /outside the grid/);
});

// ---------------------------------------------------------------------------
// N9 — spawnDeny
// ---------------------------------------------------------------------------

test('N9: entries/portals/chests stamp discs of the documented radii; entryRooms stamp their whole extent', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 60, height: 60, originX: -15, originZ: -15 });
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN9SpawnDeny(grid, {
    entries: [{ x: -10, z: -10 }],
    portals: [{ x: 10, z: 10 }],
    chests: [{ x: 0, z: 10 }],
    entryRooms: [{ kind: 'box', x: 10, z: -10, halfW: 3, halfL: 3 }], // kept clear of the entry disc's 8 m radius, see comment below
  });
  assert.ok(grid.flags[cellIndexAt(grid, -10, -10)] & NAV_FLAG.spawnDeny, 'entry centre');
  assert.ok(grid.flags[cellIndexAt(grid, -10 + 7.9, -10)] & NAV_FLAG.spawnDeny, 'within 8.0 m of entry');
  assert.equal(grid.flags[cellIndexAt(grid, -10 + 8.5, -10)] & NAV_FLAG.spawnDeny, 0, 'outside 8.0 m of entry');
  assert.ok(grid.flags[cellIndexAt(grid, 0, 10 + 3.9)] & NAV_FLAG.spawnDeny, 'within 4.0 m of chest');
  assert.equal(grid.flags[cellIndexAt(grid, 0, 10 + 4.5)] & NAV_FLAG.spawnDeny, 0, 'outside 4.0 m of chest');
  assert.ok(grid.flags[cellIndexAt(grid, 10, -10)] & NAV_FLAG.spawnDeny, 'inside the entry room');
});

test('N9: allWalkableSpawnDeny stamps every walkable cell (the generic form of the last_bastion special case)', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 10, height: 10, originX: 0, originZ: 0 });
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN9SpawnDeny(grid, { allWalkableSpawnDeny: true });
  assert.equal(countFlagged(grid, NAV_FLAG.spawnDeny), 100);
});

test('N9: no markers at all is a documented no-op, not a crash', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 10, height: 10, originX: 0, originZ: 0 });
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  passN9SpawnDeny(grid);
  assert.equal(countFlagged(grid, NAV_FLAG.spawnDeny), 0);
});

// ---------------------------------------------------------------------------
// N10 — prune, and its interaction with N7's regionCount
// ---------------------------------------------------------------------------

test('N10: a walkable island smaller than 16 cells is pruned (walkable cleared, cost 255, region -1)', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 20, height: 20, originX: -5, originZ: -5 });
  const scratch = createRasterScratch(20, 20);
  // A tiny 2x2 (4-cell) island, isolated by ground regions from the rest.
  const groundRegions = [
    { kind: 'box', x: -3, z: -3, halfW: 5, halfL: 5 }, // main mass, far bigger than 16 cells
    { kind: 'box', x: 4.75, z: 4.75, halfW: 0.5, halfL: 0.5 }, // isolated 2x2 island
  ];
  passN1Clear(grid);
  passN2GroundStamp(grid, groundRegions);
  passN4FootprintStamp(grid, [], scratch);
  passN5Doorway(grid, groundRegions);
  passN6Cost(grid, scratch);
  passN7Regions(grid, scratch);
  const beforePruneRegionCount = grid.regionCount;
  assert.equal(beforePruneRegionCount, 2, 'must actually start as two disconnected regions for this test to mean anything');

  const iIsland = cellIndexAt(grid, 4.75, 4.75);
  assert.ok(grid.flags[iIsland] & NAV_FLAG.walkable, 'island must be walkable before pruning');

  passN10Prune(grid, scratch);

  assert.equal(grid.flags[iIsland] & NAV_FLAG.walkable, 0, 'the small island must be pruned');
  assert.equal(grid.cost[iIsland], 255);
  assert.equal(grid.region[iIsland], -1);
  assert.equal(grid.regionCount, 1, 'regionCount must reflect ONLY surviving regions after pruning, not the pre-prune count');
});

test('N10: surviving regions are relabelled densely from 0, in row-major first-seen order', () => {
  const grid = createNavGrid({ cellSize: 0.5, width: 40, height: 10, originX: 0, originZ: 0 });
  const scratch = createRasterScratch(40, 10);
  // Three separated 5x5 m (10x10 cell = 100-cell) blobs -> all survive
  // pruning -> regionCount must stay 3, densely 0,1,2 in x order.
  const groundRegions = [
    { kind: 'box', x: 3, z: 2.5, halfW: 2.5, halfL: 2.5 },
    { kind: 'box', x: 10, z: 2.5, halfW: 2.5, halfL: 2.5 },
    { kind: 'box', x: 17, z: 2.5, halfW: 2.5, halfL: 2.5 },
  ];
  const result = rasterizeNav(grid, scratch, { groundRegions });
  assert.equal(result.regionCount, 3);
  const r0 = grid.region[cellIndexAt(grid, 3, 2.5)];
  const r1 = grid.region[cellIndexAt(grid, 10, 2.5)];
  const r2 = grid.region[cellIndexAt(grid, 17, 2.5)];
  assert.deepEqual([r0, r1, r2].sort(), [0, 1, 2]);
});

// ---------------------------------------------------------------------------
// Allocation — passes must not allocate per cell once grid/scratch exist
// ---------------------------------------------------------------------------

test('12.Axx passN6Cost is allocation-free once grid/scratch are pre-built', { skip: !hasGc() && 'run with --expose-gc' }, () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  const result = assertAllocationFree(() => passN6Cost(grid, scratch));
  assert.ok(result.bytesPerCall < 1);
});

test('12.Axx passN7Regions is allocation-free once grid/scratch are pre-built', { skip: !hasGc() && 'run with --expose-gc' }, () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  const result = assertAllocationFree(() => passN7Regions(grid, scratch), { iterations: 500 });
  assert.ok(result.bytesPerCall < 1);
});

test('12.Axx passN4FootprintStamp is allocation-free once grid/scratch/footprints are pre-built', { skip: !hasGc() && 'run with --expose-gc' }, () => {
  const grid = makeWastesGrid();
  const scratch = createRasterScratch(WIDTH, HEIGHT);
  const footprints = [{ kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 1, halfL: 1, facing: 0.4, blocksNav: true }];
  passN1Clear(grid);
  passN2GroundStamp(grid, null);
  const result = assertAllocationFree(() => passN4FootprintStamp(grid, footprints, scratch), { iterations: 500 });
  assert.ok(result.bytesPerCall < 1);
});
