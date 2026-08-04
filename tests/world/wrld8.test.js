// tests/world/wrld8.test.js
//
// WRLD-8 — the Altar of Instruction (`07-world-gen.md` §5).
//
// ---------------------------------------------------------------------------
// The acceptance is `07` §12 row 10, NOT the backlog's "G1-G3 hold"
// ---------------------------------------------------------------------------
// D-67: `07` §5.3's `G1`-`G6` are Molgrim's combat-space guarantees and
// Molgrim is `AI-10`, milestone M6. The real gate is §12 row 10: **I5 and I7
// on 600/600 layouts**, plus a 4.2 m/s traverse of the six bisectors landing
// with >= 1.5 s of margin, plus the `altar_tablet` interactable present and
// inert. (`07` also reuses `G1`-`G6` for §9.2's prop instancing groups — a
// different thing again.)
//
// ---------------------------------------------------------------------------
// O-106 — every count below comes from a REAL `world.enterZone` call
// ---------------------------------------------------------------------------
// WRLD-7 shipped a harness "in the exact shape of the real pipeline" that
// reported 600/600 while the orchestrator's own probe through
// `world.setWorldSeed()` -> `world.enterZone()` -> `nav.grid` got 56/60,
// because the lookalike never built the heightfield and so never ran
// `passN3Slope`. This suite therefore has NO reimplemented rasterisation
// path at all: the sweep constructs a real `WorldSystem` + `PhysicsSystem` +
// `NavSystem` + `MaterialsSystem`, calls `world.setWorldSeed(...)` and
// `await world.enterZone('altar_of_instruction', 'altar_entry', {runIndex})`,
// and reads `nav.grid` — the live grid, heightfield and all.
//
// ---------------------------------------------------------------------------
// I7's literal number is NOT reachable, and this suite says so out loud
// ---------------------------------------------------------------------------
// I7 asserts "blocked cells inside r = 16.0 m = 114 +/- 6", derived in §5.4 as
// `6 x ceil(pi * (0.9 + 0.3)^2 / 0.25)`. That is an AREA estimate;
// `passN4FootprintStamp` blocks a cell when its CENTRE falls within
// `radius + dilation`, and at the six specified pillar bearings every pillar
// lands in the 16-cell alignment, so the true count is 96 on every layout.
// The test below asserts the INTENT ("the only blockers inside r = 16.0 m are
// the six pillars", exactly, 600/600) and reports the literal shortfall
// rather than asserting a number that cannot be produced. See this ticket's
// report.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  ARENA_RADIUS,
  PILLARS,
  PILLAR_RADIUS,
  PILLAR_RING_RADIUS,
  SUMMON_ANCHORS,
  SUMMON_ANCHOR_RADIUS,
  TELEPORT_ANCHORS,
  TELEPORT_INNER_RADIUS,
  TELEPORT_OUTER_RADIUS,
  BISECTOR_ANGLES_DEG,
  BOSS_START,
  PLAYER_ENTRY,
  PORTAL_PAD,
  TABLET,
  RING,
  TRAVERSE_SPEED,
  TRAVERSE_MIN_MARGIN,
  computeBisectorTraverse,
  generateAltarLayout,
  runAltarDressing,
  toFootprints as altarToFootprints,
  walkableHalfWidthAt,
  buildTerraces,
} from '../../src/world/gen/altar.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../../src/world/data/zones.js';
import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { NAV_FLAG, RASTER, cellIndexAt } from '../../src/world/raster.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';

const DESCRIPTOR = ZONE_DESCRIPTORS_BY_ID.altar_of_instruction;
const I7_RADIUS = 16.0; // m — I7's own circle
const DILATION = RASTER.DILATION; // 0.30 m

/** A real `WorldSystem` + `PhysicsSystem` + `NavSystem` + `MaterialsSystem`
 * on one stub ctx — the shape `tests/world/wrld6.test.js`/`wrld7.test.js`
 * already established. Nothing here is a stand-in for the pipeline; it IS
 * the pipeline. */
async function makeFullWorld({ rngSeed = 1 } = {}) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const scene = new THREE.Scene();
  const ctx = makeStubCtx({ rng: new Rng(rngSeed), scene, systems: { world, physics, nav, materials, render: { renderer: null } } });
  await physics.init(ctx);
  await materials.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  return { world, physics, nav, materials, scene, ctx };
}

function walkableAt(grid, x, z) {
  const i = cellIndexAt(grid, x, z);
  return i >= 0 && (grid.flags[i] & NAV_FLAG.walkable) !== 0;
}

function regionAt(grid, x, z) {
  const i = cellIndexAt(grid, x, z);
  return i < 0 ? -1 : grid.region[i];
}

/** Blocked cells whose centre lies inside `r = 16.0 m`, split into the ones
 * a pillar accounts for and the ones nothing does. */
function countBlockedInsideI7(grid) {
  let pillar = 0;
  let other = 0;
  for (let cz = 0; cz < grid.height; cz++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const x = grid.originX + (cx + 0.5) * grid.cellSize;
      const z = grid.originZ + (cz + 0.5) * grid.cellSize;
      if (x * x + z * z >= I7_RADIUS * I7_RADIUS) continue;
      if (grid.flags[cz * grid.width + cx] & NAV_FLAG.walkable) continue;
      let byPillar = false;
      for (const p of PILLARS) {
        const dx = x - p.x, dz = z - p.z;
        if (Math.sqrt(dx * dx + dz * dz) <= p.radius + DILATION + 1e-9) { byPillar = true; break; }
      }
      if (byPillar) pillar++; else other++;
    }
  }
  return { pillar, other, total: pillar + other };
}

// ---------------------------------------------------------------------------
// The fixed tables — §5.2 / §5.3, read straight off the spec
// ---------------------------------------------------------------------------

test('§5.3 G4: exactly 12 teleport anchors — 6 at r=8.0 on the pillar bearings, 6 at r=14.0 on the bisectors', () => {
  assert.equal(TELEPORT_ANCHORS.length, 12);
  const inner = TELEPORT_ANCHORS.slice(0, 6);
  const outer = TELEPORT_ANCHORS.slice(6);
  assert.deepEqual(inner.map((a) => a.angleDeg), [0, 60, 120, 180, 240, 300]);
  assert.deepEqual(outer.map((a) => a.angleDeg), [...BISECTOR_ANGLES_DEG]);
  for (const a of inner) assert.ok(Math.abs(Math.sqrt(a.x * a.x + a.z * a.z) - TELEPORT_INNER_RADIUS) < 1e-9);
  for (const a of outer) assert.ok(Math.abs(Math.sqrt(a.x * a.x + a.z * a.z) - TELEPORT_OUTER_RADIUS) < 1e-9);

  // §5.3 G4: "every anchor is >= 2.60 m from the nearest pillar surface".
  for (const a of TELEPORT_ANCHORS) {
    let nearest = Infinity;
    for (const p of PILLARS) {
      const dx = a.x - p.x, dz = a.z - p.z;
      nearest = Math.min(nearest, Math.sqrt(dx * dx + dz * dz) - p.radius);
    }
    assert.ok(nearest >= 2.60 - 1e-9, `teleport anchor ${a.angleDeg}deg is ${nearest.toFixed(3)} m from a pillar surface, must be >= 2.60`);
  }
  // ...and the rim at 17.0 m clears the outer ring by 3.0 m.
  assert.equal(ARENA_RADIUS - TELEPORT_OUTER_RADIUS, 3.0);
});

test('§5.3 G2: exactly 8 summon anchors at r=7.0, 45deg apart starting at 22.5deg, mutually 5.36 m apart and on open floor', () => {
  assert.equal(SUMMON_ANCHORS.length, 8);
  assert.deepEqual(SUMMON_ANCHORS.map((a) => a.angleDeg), [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]);
  for (const a of SUMMON_ANCHORS) assert.ok(Math.abs(Math.sqrt(a.x * a.x + a.z * a.z) - SUMMON_ANCHOR_RADIUS) < 1e-9);
  for (let i = 0; i < 8; i++) {
    const a = SUMMON_ANCHORS[i], b = SUMMON_ANCHORS[(i + 1) % 8];
    const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
    assert.ok(Math.abs(d - 5.36) < 0.01, `adjacent summon anchors are ${d.toFixed(3)} m apart, §5.3 G2 says 5.36`);
  }
  // §5.3 G2's own clearance argument: 7.0 + 0.9 < 10.6.
  assert.ok(SUMMON_ANCHOR_RADIUS + PILLAR_RADIUS < PILLAR_RING_RADIUS - PILLAR_RADIUS);
});

test('§5.2: six pillars, radius 0.90 m, at r=11.5 m on 60deg bearings', () => {
  assert.equal(PILLARS.length, 6);
  for (const p of PILLARS) {
    assert.equal(p.radius, PILLAR_RADIUS);
    assert.ok(Math.abs(Math.sqrt(p.x * p.x + p.z * p.z) - PILLAR_RING_RADIUS) < 1e-9);
  }
  assert.deepEqual(PILLARS.map((p) => p.angleDeg).sort((a, b) => a - b), [0, 60, 120, 180, 240, 300]);
});

// ---------------------------------------------------------------------------
// The tablet — acceptance item 3
// ---------------------------------------------------------------------------

test('ACCEPTANCE 3: the altar_tablet interactable is present, kind "altar", at (0,+18.2) r=2.0, and INERT', async () => {
  const { world } = await makeFullWorld();
  const inst = await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  assert.equal(inst.interactables.length, 1);
  const t = inst.interactables[0];
  assert.equal(t.kind, 'altar'); // §9.3's own SpawnPoint/Interactable enum
  assert.equal(t.x, TABLET.x);
  assert.equal(t.z, TABLET.z);
  assert.equal(t.radius, TABLET.radius);
  assert.equal(t.enabled, false, 'inert this milestone — §5.2\'s "sealed prompt", the same mechanism as the exit portal pad');
  assert.equal(t.toZone, null);
  assert.equal(t.chestId, 0);
  assert.equal(t.portalId, 0);
});

test('the exit portal pad at (0,-13) is emitted CLOSED, targeting last_bastion/from_wastes (§5.4)', async () => {
  const { world } = await makeFullWorld();
  const inst = await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  assert.equal(inst.portals.length, 1);
  assert.deepEqual(
    { x: inst.portals[0].x, z: inst.portals[0].z, toZone: inst.portals[0].toZone, toEntryTag: inst.portals[0].toEntryTag, open: inst.portals[0].open },
    { x: PORTAL_PAD.x, z: PORTAL_PAD.z, toZone: 'last_bastion', toEntryTag: 'from_wastes', open: false },
  );
});

// ---------------------------------------------------------------------------
// "The layout is fixed" — enforced, not merely intended
// ---------------------------------------------------------------------------

test('§5: the layout is FIXED — two different world seeds produce byte-identical static footprints, entries, anchors and terraces', async () => {
  const a = await makeFullWorld();
  const b = await makeFullWorld();
  a.world.setWorldSeed(0x1f3ac09b);
  b.world.setWorldSeed(0x77c1a030);
  const ia = await a.world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  const ib = await b.world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 2 });
  assert.notEqual(ia.seed, ib.seed, 'the two layouts must genuinely be on different seeds');
  assert.equal(JSON.stringify(a.world.staticFootprints), JSON.stringify(b.world.staticFootprints));
  assert.equal(JSON.stringify([...ia.entries]), JSON.stringify([...ib.entries]));
  assert.equal(JSON.stringify(a.world._altarLayout.terraces), JSON.stringify(b.world._altarLayout.terraces));
  // ...and the nav grid itself is identical, flags for flags.
  assert.equal(Buffer.from(a.nav.grid.flags).toString('hex'), Buffer.from(b.nav.grid.flags).toString('hex'));
});

test('§5.4: the seed DOES move the dressing (E1/E2/E4/E5) — and no prop it emits can ever block nav', async () => {
  const a = await makeFullWorld();
  const b = await makeFullWorld();
  a.world.setWorldSeed(0x1f3ac09b);
  b.world.setWorldSeed(0x77c1a030);
  await a.world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  await b.world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 2 });
  const pa = a.world._altarDressing.props;
  const pb = b.world._altarDressing.props;
  assert.equal(pa.length, 44 + 96, '44 corridor props (E2) + 96 arena rubble props (E4)');
  assert.equal(a.world._altarDressing.alcoves.length, 6, 'E1 — six corridor wall alcoves');
  assert.notEqual(JSON.stringify(pa), JSON.stringify(pb), 'the dressing must actually vary with the seed');
  for (const p of pa) assert.equal(p.blocksNav, false, '§5.4 E4: "nothing inside the arena blocks navigation"');

  // E4's own two clearances, measured.
  const rubble = pa.filter((p) => p.stage === 'E4');
  assert.equal(rubble.length, 96);
  for (const p of rubble) {
    const r = Math.sqrt(p.x * p.x + p.z * p.z);
    assert.ok(r >= 4.0 - 1e-9 && r < 16.0, `E4 prop at r=${r.toFixed(2)} must be in [4.0, 16.0)`);
    for (const pil of PILLARS) {
      const d = Math.sqrt((p.x - pil.x) ** 2 + (p.z - pil.z) ** 2);
      assert.ok(d >= pil.radius + 2.0 - 1e-9, `E4 prop is ${d.toFixed(2)} m from a pillar centre, must clear its surface by 2.0 m`);
    }
  }
});

test('toFootprints takes no dressing argument at all — §5.4\'s "navBlock: false" is structural, not conventional', () => {
  assert.equal(altarToFootprints.length, 1, 'toFootprints(layout) — one parameter, so no caller can hand it props');
  const layout = generateAltarLayout(1);
  const fps = altarToFootprints(layout);
  assert.ok(fps.every((f) => f.blocksNav === true), 'every emitted footprint is real blocking geometry');
  const cyl = fps.filter((f) => f.kind === 'cylinder');
  assert.equal(cyl.length, 6, 'the six pillars are the only cylinders');
  // O-35 field names, not `07` §1.7's superseded record.
  for (const f of fps) {
    assert.ok(f.kind === 'box' || f.kind === 'cylinder');
    assert.equal(typeof f.height, 'number');
    assert.equal(f.navBlock, undefined);
    assert.equal(f.topY, undefined);
    assert.equal(f.rotation, undefined);
  }
});

// ---------------------------------------------------------------------------
// The terrace field vs passN3Slope — why I5 is seed-independent
// ---------------------------------------------------------------------------

test('the three §5.1 terraces are built as per-nav-row treads, so no walkable pair ever exceeds N3\'s 0.45 m threshold', async () => {
  const { world, nav } = await makeFullWorld();
  world.setWorldSeed(0x1f3ac09b);
  await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  const grid = nav.grid;
  const gy = world.current.nav.groundY;
  let maxDelta = 0;
  for (let cz = 0; cz < grid.height; cz++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const i = cz * grid.width + cx;
      if (!(grid.flags[i] & NAV_FLAG.walkable)) continue;
      if (cx + 1 < grid.width && (grid.flags[i + 1] & NAV_FLAG.walkable)) maxDelta = Math.max(maxDelta, Math.abs(gy[i] - gy[i + 1]));
      if (cz + 1 < grid.height && (grid.flags[i + grid.width] & NAV_FLAG.walkable)) maxDelta = Math.max(maxDelta, Math.abs(gy[i] - gy[i + grid.width]));
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[WRLD-8] max adjacent walkable ground delta ${maxDelta.toFixed(4)} m (N3 blocks above ${RASTER.SLOPE_MAX_DELTA})`);
  assert.ok(maxDelta <= RASTER.SLOPE_MAX_DELTA, `max walkable-pair ground delta ${maxDelta} must stay under N3's ${RASTER.SLOPE_MAX_DELTA} m`);

  const elevations = buildTerraces().map((t) => t.elevation);
  assert.ok(elevations.includes(-0.60), '§5.1 approach terrace');
  assert.ok(elevations.includes(0), '§5.1 arena floor');
  assert.ok(elevations.includes(0.90), '§5.1 altar dais');
});

test('walkableHalfWidthAt reproduces §5.2\'s plan: the disc, the 6 m corridor, the 4 m stair and the 7 m alcove', () => {
  assert.ok(Math.abs(walkableHalfWidthAt(0) - ARENA_RADIUS) < 1e-9);
  assert.ok(Math.abs(walkableHalfWidthAt(-21) - 3.0) < 1e-9, 'approach corridor is 6 m wide');
  assert.ok(Math.abs(walkableHalfWidthAt(17.25) - 2.0) < 1e-9, 'alcove stair is 4 m wide');
  assert.ok(Math.abs(walkableHalfWidthAt(19.0) - 3.5) < 1e-9, 'altar alcove is 7 m wide');
  assert.equal(walkableHalfWidthAt(23.0), 0, 'nothing walkable beyond the alcove');
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2 — the bisector traverse
// ---------------------------------------------------------------------------

test('ACCEPTANCE 2: a 4.2 m/s traverse of all six bisectors clears the ring window with >= 1.5 s of margin, entirely on walkable floor', async () => {
  const { world, nav } = await makeFullWorld();
  world.setWorldSeed(0x1f3ac09b);
  await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  const grid = nav.grid;

  let offFloor = 0;
  const results = computeBisectorTraverse((x, z) => { if (!walkableAt(grid, x, z)) offFloor++; });
  assert.equal(results.length, 6);
  assert.equal(offFloor, 0, 'every sampled point of every bisector traverse must be on walkable arena floor');

  let minMargin = Infinity;
  for (const r of results) minMargin = Math.min(minMargin, r.margin);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-8] bisector traverse: arc ${results[0].arcLength.toFixed(3)} m at ${TRAVERSE_SPEED} m/s = ${results[0].seconds.toFixed(4)} s against a ${RING.lifetime.toFixed(4)} s ring window -> margin ${minMargin.toFixed(4)} s`);
  assert.ok(minMargin >= TRAVERSE_MIN_MARGIN, `worst bisector margin ${minMargin.toFixed(4)} s must be >= ${TRAVERSE_MIN_MARGIN} s`);
  assert.ok(Math.abs(RING.lifetime - 4.375) < 1e-9, '§5.3 G3: ringLifetime = (17.00 - 3.00) / 3.20');
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 1 — I5 and I7 on 600 layouts, through the REAL pipeline
// ---------------------------------------------------------------------------

test('SWEEP (REAL PIPELINE): 600 layouts through actual world.enterZone — I5 and I7', async () => {
  let ran = 0;
  let i5 = 0;
  let i7Literal = 0;
  let i7Intent = 0;
  let regionOne = 0;
  let traverseOk = 0;
  const i7Counts = new Map();
  const fails = [];

  for (let i = 0; i < 200; i++) {
    const worldSeed = (0x1f3ac09b + i) >>> 0; // §7.2's own sweep base
    for (let runIndex = 0; runIndex < 3; runIndex++) {
      ran++;
      // eslint-disable-next-line no-await-in-loop
      const { world, nav } = await makeFullWorld();
      world.setWorldSeed(worldSeed);
      // eslint-disable-next-line no-await-in-loop
      await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex });
      const grid = nav.grid;

      // --- I5: the boss is reachable and the arena is intact.
      const entry = world.entry('altar_entry');
      const entryRegion = regionAt(grid, entry.x, entry.z);
      let anchorsWalkable = 0;
      for (const a of TELEPORT_ANCHORS) if (walkableAt(grid, a.x, a.z)) anchorsWalkable++;
      for (const a of SUMMON_ANCHORS) if (walkableAt(grid, a.x, a.z)) anchorsWalkable++;
      const i5ok = entryRegion >= 0
        && regionAt(grid, BOSS_START.x, BOSS_START.z) === entryRegion
        && regionAt(grid, PORTAL_PAD.x, PORTAL_PAD.z) === entryRegion
        && anchorsWalkable === 20;
      if (i5ok) i5++;
      else if (fails.length < 8) {
        fails.push({ worldSeed: `0x${worldSeed.toString(16)}`, runIndex, entryRegion, boss: regionAt(grid, BOSS_START.x, BOSS_START.z), pad: regionAt(grid, PORTAL_PAD.x, PORTAL_PAD.z), anchorsWalkable });
      }

      // --- I7: the arena floor is open.
      const { total, other } = countBlockedInsideI7(grid);
      i7Counts.set(total, (i7Counts.get(total) || 0) + 1);
      if (total >= 108 && total <= 120) i7Literal++;
      if (other === 0 && total === 6 * 16) i7Intent++;

      if (grid.regionCount === 1) regionOne++;

      let offFloor = 0;
      computeBisectorTraverse((x, z) => { if (!walkableAt(grid, x, z)) offFloor++; });
      if (offFloor === 0) traverseOk++;
    }
  }

  /* eslint-disable no-console */
  console.log(`[WRLD-8 SWEEP REAL PIPELINE] ran ${ran}/600 through actual world.enterZone`);
  console.log(`[WRLD-8 SWEEP REAL PIPELINE] I5 (boss + portal pad in the entry region, 12 teleport + 8 summon anchors walkable): ${i5}/${ran}`);
  console.log(`[WRLD-8 SWEEP REAL PIPELINE] I7 intent (only the six pillars block inside r=16.0 m, 96 cells): ${i7Intent}/${ran}`);
  console.log(`[WRLD-8 SWEEP REAL PIPELINE] I7 literal (114 +/- 6): ${i7Literal}/${ran} — measured counts ${JSON.stringify([...i7Counts.entries()])}`);
  console.log(`[WRLD-8 SWEEP REAL PIPELINE] regionCount === 1: ${regionOne}/${ran}`);
  console.log(`[WRLD-8 SWEEP REAL PIPELINE] bisector traverse fully on walkable floor: ${traverseOk}/${ran}`);
  if (fails.length) console.log('[WRLD-8 SWEEP REAL PIPELINE] I5 failures:', JSON.stringify(fails));
  /* eslint-enable no-console */

  assert.equal(ran, 600, 'the sweep must run exactly 600 layouts, not a sample');
  assert.equal(i5, ran, `I5 must hold on every layout — failures: ${JSON.stringify(fails)}`);
  assert.equal(i7Intent, ran, 'the only blockers inside r = 16.0 m must be the six pillars, on every layout');
  assert.equal(regionOne, ran, 'the whole arena, approach and alcove must resolve to one nav region');
  assert.equal(traverseOk, ran, 'the bisector traverse must run on walkable floor on every layout');

  // The literal I7 number is NOT asserted — see this file's header and this
  // ticket's report. Reported as a finding, not silently weakened.
  // eslint-disable-next-line no-console
  console.log(`[WRLD-8 FINDING] I7's literal "114 +/- 6" is unreachable: cell-CENTRE rasterisation of a r=1.20 m dilated pillar at the six specified bearings yields 16 cells each (6 x 16 = 96), where §5.4's own area estimate assumes 19. I7's intent holds exactly on ${i7Intent}/${ran}; the literal count on ${i7Literal}/${ran}.`);
});

// ---------------------------------------------------------------------------
// The live surface — entry, descriptor divergence, and re-entry
// ---------------------------------------------------------------------------

test('world.entry(\'altar_entry\') is §5.2\'s gate position, faces +pi/2, and stands on walkable floor', async () => {
  const { world, nav } = await makeFullWorld();
  await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  const e = world.entry('altar_entry');
  assert.equal(e.x, PLAYER_ENTRY.x);
  assert.equal(e.z, PLAYER_ENTRY.z);
  assert.equal(e.facing, PLAYER_ENTRY.facing);
  assert.ok(walkableAt(nav.grid, e.x, e.z));
  // The SHIPPED descriptor declares exactly one tag; §5.1's own literal
  // ('gate', 'portal_return') is NOT what world.entry accepts — disclosed.
  assert.deepEqual([...DESCRIPTOR.entryTags], ['altar_entry']);
  assert.throws(() => world.entry('gate'), /unknown entryTag/);
});

test('re-entering the altar tears down cleanly and reproduces an identical grid', async () => {
  const { world, nav } = await makeFullWorld();
  world.setWorldSeed(0x00000001); // §7.4's trivial pinned seed
  await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  const first = Buffer.from(nav.grid.flags).toString('hex');
  await world.enterZone('last_bastion', 'town_start');
  await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  assert.equal(Buffer.from(nav.grid.flags).toString('hex'), first);
  assert.equal(world._altarLayout.seed, world.seedFor('altar_of_instruction', 0));
});

test('the altar generator stays headless — no three, no DOM, no Math.random in src/world/gen/altar.js', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../../src/world/gen/altar.js', import.meta.url), 'utf8');
  // Comment lines are stripped first — the file's own header discusses all
  // four of these by name, and `npm run lint:imports` is the real gate; this
  // is the cheap in-suite guard against a regression in the CODE.
  const src = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/from\s+['"]three['"]/.test(src), false);
  assert.equal(/Math\s*\.\s*random/.test(src), false);
  assert.equal(/\b(document|window)\s*\./.test(src), false);
  assert.equal(/performance\s*\.\s*now/.test(src), false);
});

test('runAltarDressing continues the layout\'s own streams — the same seed reproduces the same dressing exactly', () => {
  const l1 = generateAltarLayout(0x2c71e004, DESCRIPTOR);
  const l2 = generateAltarLayout(0x2c71e004, DESCRIPTOR);
  const d1 = runAltarDressing(l1);
  const d2 = runAltarDressing(l2);
  assert.equal(JSON.stringify(d1), JSON.stringify(d2));
});
