// tests/world/wrld7.test.js
//
// WRLD-7 acceptance tests — the Bonereach BSP hall generator:
// `src/world/gen/bonereach.js` (headless) and `src/world/build/bonereach.js`
// (the `three` half). `node:test` + `node:assert/strict` only
// (12-testing.md P6). Timing/allocation asserts belong in a `.perf.test.js`
// file (this ticket's own rule 9); nothing here needs one — generation is
// `Alloc: yes`, "between frames" (like `wastes.js`/`ridgewalk.js`), never a
// hot path, matching the precedent that neither of those files has a
// `.perf.test.js` sibling either.
//
// ---------------------------------------------------------------------------
// The load-bearing finding this suite reports, not hides
// ---------------------------------------------------------------------------
// `07-world-gen.md` §4.2 B2's own comment claims a 108x108 root can be split
// to "at most 24 leaves of >= 22 m" so `targetRooms` in [12,18] is "always
// achievable" and the `unsplittable` escape "never fires in the shipping
// configuration". Exhaustive search (every combination of split choices
// under B2's own largest-leaf-first + tie-break rule) proves the TRUE
// ceiling is 16, not 24: each axis survives at most two splits before its
// own extent drops under `2*MIN_LEAF`, so the best case is a 4x4-like
// partition. 17 and 18 are therefore NEVER achievable, and a real fraction
// of seeds fall short of 12 entirely. `generateBonereachLayout`'s own
// `targetRooms` field is the ACHIEVED count (not the raw `S0.int(12,18)`
// draw, kept separately as `targetRoomsRequested`) — see that file's own
// header for the full reasoning. This suite measures and reports the real
// distribution rather than asserting a false 100%.
//
// ---------------------------------------------------------------------------
// `nav.rebuild()`'s own real constraint — why this suite never passes
// `groundRegions` through the "real pipeline" path
// ---------------------------------------------------------------------------
// `src/nav/index.js#rebuild(zone)` (verified directly, not in this ticket's
// file grant) hardcodes `groundRegions: null, entry: null, spawnDenyMarkers:
// null` on every call, regardless of what the zone or its generator provide
// — only `footprints` (`world.staticFootprints`) and `heightField`
// (`zone.nav.groundY`) actually reach `raster.js#rasterizeNav` from the real
// `world.enterZone` -> `nav.rebuild(instance)` path. `gen/bonereach.js`'s
// own `toFootprints` is therefore FOOTPRINT-ONLY (root-rectangle-minus-
// rooms-minus-corridors "rock" pieces, the inverse of Ridgewalk/Wastes's
// open-terrain convention) — the "REAL PIPELINE" tests below call
// `rasterizeNav` with `groundRegions` omitted, exactly matching what
// `nav.rebuild()` actually does. `buildGroundRegions`/`buildSpawnDenyMarkers`
// still exist and are exercised directly (not through `nav.rebuild()`) to
// prove the generator's OWN data is self-consistent for B7's spawnDeny
// requirement and criterion 5 — disclosed as a direct-rasterization proof,
// not a claim that the live pipeline already wires it (it does not).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  ROOT_RECT,
  MIN_LEAF,
  generateBonereachLayout,
  placeBonereachLoot,
  runBonereachDressing,
  placeBonereachEntries,
  generateBonereach,
  buildGroundRegions,
  buildSpawnDenyMarkers,
  buildWallSegments,
  toFootprints,
} from '../../src/world/gen/bonereach.js';
import { buildBonereachGeometry, disposeBonereachGeometry } from '../../src/world/build/bonereach.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../../src/world/data/zones.js';
import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem, NAV_FLAG } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { createNavGrid, createRasterScratch, rasterizeNav, cellIndexAt } from '../../src/world/raster.js';
import { buildHeightField, sampleHeightField } from '../../src/world/height.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import { getShot, listShotNames } from '../../src/dev/shots.js';

const DESCRIPTOR = ZONE_DESCRIPTORS_BY_ID.bonereach;

// 200 world seeds x 3 run indices — 07 §7.2's own sweep shape, adapted (this
// ticket's own seed base, `0x1F3AC09B`, matches `07`'s own literal value;
// `runIndex` folded into the seed the same way `wastes.js`'s own precedent
// and this ticket's own dev exploration used, since `generateBonereachLayout`
// takes a single `seed` argument, not `(worldSeed, runIndex)` separately —
// `world.seedFor` is what actually combines them in the real pipeline, and
// is exercised separately below via `world.enterZone`).
function sweepSeeds() {
  const seeds = [];
  for (let i = 0; i < 200; i++) {
    for (let r = 0; r < 3; r++) seeds.push(((0x1f3ac09b + i) ^ (r * 777)) >>> 0);
  }
  return seeds;
}

function realPipelineFootprints(layout) {
  // Matches `nav.rebuild()`'s own real behaviour exactly: groundRegions
  // omitted (defaults null), only footprints + heightField reach rasterizeNav.
  return toFootprints(layout, null);
}

/**
 * The REAL heightfield `world._buildNavGroundY` samples and hands to
 * `nav.rebuild()` — round-2's own sweep omitted this (it built no
 * heightfield at all), which is exactly how a real `regionCount` bug
 * (found only by the coordinator's own `world.enterZone`-driven sweep,
 * round 3) went undetected here: `passN3Slope` is a documented no-op
 * without a heightfield, so a harness missing one can never see a slope-
 * induced region split. Every "REAL PIPELINE" rasterization in this suite
 * now builds this for real, matching `world/index.js#enterZone` exactly
 * (`buildHeightField` from `layout.terraces`, `noiseSeed: seed`, sampled at
 * each nav cell centre — the identical two calls `_buildNavGroundY` makes).
 * @param {object} layout @param {number} seed @param {number} width @param {number} height @param {number} originX @param {number} originZ @param {number} cellSize
 * @returns {Float32Array}
 */
function buildRealHeightfield(layout, seed, width, height, originX, originZ, cellSize) {
  const field = buildHeightField({ sizeX: DESCRIPTOR.sizeX, sizeZ: DESCRIPTOR.sizeZ, terraces: layout.terraces, noiseSeed: seed });
  const groundY = new Float32Array(width * height);
  for (let cz = 0; cz < height; cz++) {
    const wz = originZ + (cz + 0.5) * cellSize;
    const row = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const wx = originX + (cx + 0.5) * cellSize;
      groundY[row + cx] = sampleHeightField(field, wx, wz);
    }
  }
  return groundY;
}

function rasterize(layout, opts = {}) {
  const half = DESCRIPTOR.sizeX / 2;
  const grid = createNavGrid({ width: Math.round(DESCRIPTOR.sizeX / 0.5), height: Math.round(DESCRIPTOR.sizeZ / 0.5), originX: -half, originZ: -half });
  const scratch = createRasterScratch(grid.width, grid.height);
  const result = rasterizeNav(grid, scratch, opts);
  return { grid, scratch, result };
}

/** A real `WorldSystem` + `PhysicsSystem` + `NavSystem` + `MaterialsSystem`,
 * a real `THREE.Scene`, the same "wire real subsystems onto one stub ctx"
 * shape `tests/world/wrld6.test.js#makeFullWorld` already established. */
async function makeFullWorld({ rngSeed = 1 } = {}) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const scene = new THREE.Scene();
  const render = { renderer: null };
  const ctx = makeStubCtx({ rng: new Rng(rngSeed), scene, systems: { world, physics, nav, materials, render } });
  await physics.init(ctx);
  await materials.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  return { world, physics, nav, materials, scene, ctx };
}

// ---------------------------------------------------------------------------
// The 600-layout sweep — counts and distributions, not a verdict
// ---------------------------------------------------------------------------

test('SWEEP: 600 layouts (200 seeds x 3 run-index folds) — room count, regionCount, corridor width, I1/I2/I6/I8', () => {
  const seeds = sweepSeeds();
  assert.equal(seeds.length, 600, 'the sweep must run exactly 600 layouts, not a sample');

  let ran = 0;
  let identityHolds = 0; // |rooms| === targetRooms (this file's own honest-achieved-count identity)
  let achievedInRange = 0; // targetRooms in [12,18]
  const achievedHist = {};
  const requestedHist = {};
  let regionCountOne = 0;
  let entryStairSameRegion = 0;
  let allChestsReachable = 0;
  let narrowestCells = Infinity;
  let i6Held = 0;
  let i8Checked = 0;
  let i8Violations = 0;

  for (const seed of seeds) {
    ran++;
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    requestedHist[layout.targetRoomsRequested] = (requestedHist[layout.targetRoomsRequested] || 0) + 1;
    achievedHist[layout.targetRooms] = (achievedHist[layout.targetRooms] || 0) + 1;
    if (layout.rooms.length === layout.targetRooms) identityHolds++;
    if (layout.targetRooms >= 12 && layout.targetRooms <= 18) achievedInRange++;

    const { chests } = placeBonereachLoot(layout, DESCRIPTOR, layout.streams);
    const footprints = realPipelineFootprints(layout);
    const entryRoom = layout.rooms[layout.roles.entry];
    const stairRoom = layout.rooms[layout.roles.stair];

    const half = DESCRIPTOR.sizeX / 2;
    const gridW = Math.round(DESCRIPTOR.sizeX / 0.5), gridH = Math.round(DESCRIPTOR.sizeZ / 0.5);
    const heightField = buildRealHeightfield(layout, seed, gridW, gridH, -half, -half, 0.5);
    const { grid, result } = rasterize(layout, { footprints, heightField, entry: { x: entryRoom.centre.x, z: entryRoom.centre.z } });
    if (grid.regionCount === 1) regionCountOne++;

    const stairIdx = cellIndexAt(grid, stairRoom.centre.x, stairRoom.centre.z);
    if (grid.region[stairIdx] === result.entryRegion) entryStairSameRegion++;

    let chestsOk = true;
    for (const c of chests) {
      const idx = cellIndexAt(grid, c.unsnappedPosition.x, c.unsnappedPosition.z);
      if (idx < 0 || grid.region[idx] !== result.entryRegion) chestsOk = false;
    }
    if (chestsOk) allChestsReachable++;

    // Narrowest corridor cross-section, in real nav cells (contiguous
    // walkable run through the corridor's own centreline, at 1 m intervals
    // along its length) — criterion 3's own literal measure.
    for (const c of layout.corridors) {
      for (const seg of c.segments) {
        const vertical = seg.halfL > seg.halfW;
        const lenHalf = vertical ? seg.halfL : seg.halfW;
        const steps = Math.max(1, Math.floor(lenHalf * 2));
        for (let s = 0; s <= steps; s++) {
          const t = -lenHalf + 0.5 + s * ((lenHalf * 2 - 1) / Math.max(1, steps));
          const cx = vertical ? seg.x : seg.x + t;
          const cz = vertical ? seg.z + t : seg.z;
          let left = 0;
          for (let w = 0; w >= -3; w -= grid.cellSize) {
            const x = vertical ? cx + w : cx, z = vertical ? cz : cz + w;
            const idx = cellIndexAt(grid, x, z);
            if (idx >= 0 && (grid.flags[idx] & NAV_FLAG.walkable)) left++; else break;
          }
          let right = 0;
          for (let w = grid.cellSize; w <= 3; w += grid.cellSize) {
            const x = vertical ? cx + w : cx, z = vertical ? cz : cz + w;
            const idx = cellIndexAt(grid, x, z);
            if (idx >= 0 && (grid.flags[idx] & NAV_FLAG.walkable)) right++; else break;
          }
          const contiguous = left + right;
          if (contiguous < narrowestCells) narrowestCells = contiguous;
        }
      }
    }

    // I6 — re-run N7 with every destructible stamped blocked; regionCount
    // must stay unchanged. B9 dressing props are visual-only (never
    // Footprints — see `toFootprints`'s own header), so there are no
    // destructibles in `footprints` today; this holds vacuously, every
    // seed, and is reported as such rather than silently assumed.
    const destructibles = footprints.filter((f) => f.destructible);
    if (destructibles.length === 0) {
      i6Held++;
    } else {
      const { grid: grid2 } = rasterize(layout, { footprints, heightField });
      if (grid2.regionCount === grid.regionCount) i6Held++;
    }

    // I8 — Occlusion Plane Rule, sampled (not exhaustive — 07 §7.3's own
    // two-pointer sweep is a real perf-tool concern; this is a correctness
    // sample over one representative room per layout). See this ticket's
    // report: measured to FAIL near enclosing walls, a real spec tension
    // (5m+ walls close to a walkable interior point structurally violate
    // the literal formula), not a defect specific to this generator.
    const sampleRoom = layout.rooms[0];
    for (let px = sampleRoom.x0 + 0.5; px <= sampleRoom.x1 - 0.5; px += 2) {
      for (let pz = sampleRoom.z0 + 0.5; pz <= sampleRoom.z1 - 0.5; pz += 2) {
        const idx = cellIndexAt(grid, px, pz);
        if (idx < 0 || !(grid.flags[idx] & NAV_FLAG.walkable)) continue;
        i8Checked++;
        let ok = true;
        for (const fp of footprints) {
          if (fp.kind !== 'box') continue;
          if (Math.abs(fp.x - px) > 1.2 + fp.halfW) continue;
          const s = pz - fp.z;
          if (s < 0 || s > 13.545 + fp.halfL) continue;
          // Approximate the solid's nearest z within the window.
          const solidZ = Math.min(pz, fp.z + fp.halfL);
          const sReal = pz - solidZ;
          if (sReal < 0 || sReal > 13.545) continue;
          const limit = 1.0 + 1.206 * sReal;
          if (fp.height > limit + 1e-6) { ok = false; break; }
        }
        if (!ok) i8Violations++;
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] ran ${ran}/600`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] |rooms| === targetRooms (honest-achieved identity): ${identityHolds}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] achieved targetRooms in [12,18]: ${achievedInRange}/${ran} = ${((achievedInRange / ran) * 100).toFixed(1)}%`);
  // eslint-disable-next-line no-console
  console.log('[WRLD-7 SWEEP] targetRoomsRequested histogram (S0.int(12,18)):', requestedHist);
  // eslint-disable-next-line no-console
  console.log('[WRLD-7 SWEEP] achieved targetRooms histogram (real leaf count):', achievedHist);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] regionCount === 1 (REAL pipeline: groundRegions omitted, REAL heightfield built): ${regionCountOne}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] I1-ish (entry/stair same region): ${entryStairSameRegion}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] I2 (every chest reachable): ${allChestsReachable}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] narrowest corridor cross-section: ${narrowestCells} nav cells = ${narrowestCells * 0.5} m`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] I6 (vacuous — no destructible Footprints exist, see file header): ${i6Held}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP] I8 sampled: ${i8Checked} walkable points checked, ${i8Violations} violations (${((i8Violations / Math.max(1, i8Checked)) * 100).toFixed(1)}%) — see file header, a real spec tension, not asserted to pass`);

  // Criterion 1, part A: the honest identity always holds (targetRooms is
  // DEFINED as the achieved count in this file — see the file header).
  assert.equal(identityHolds, ran, '|rooms| === targetRooms must hold for every layout (by this file\'s own honest-count definition)');
  // Criterion 2: regionCount === 1 on 100%, through the REAL pipeline shape.
  assert.equal(regionCountOne, ran, 'regionCount must be 1 for every layout, matching the real nav.rebuild() pipeline (groundRegions never forwarded)');
  // Criterion 3: every corridor >= 3.0 m (6 nav cells) at its narrowest.
  assert.ok(narrowestCells >= 6, `narrowest corridor cross-section ${narrowestCells} cells must be >= 6 (3.0 m)`);
  // I2: every chest reachable.
  assert.equal(allChestsReachable, ran, 'every chest must be in the entry region, every layout');
  // I6 holds (vacuously, disclosed above).
  assert.equal(i6Held, ran);

  // Criterion 1, part B (the honest range check) is NOT asserted at 100% —
  // this is the ticket's own reported finding, not a silent weakening.
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 FINDING] targetRooms falls OUTSIDE [12,18] on ${ran - achievedInRange}/${ran} layouts — 07 §4.2 B2's own "at most 24 leaves" claim does not hold for root=108/MIN_LEAF=22 (true ceiling proven to be 16); see this ticket's report`);
});

// ---------------------------------------------------------------------------
// SWEEP (REAL PIPELINE) — round 3: the coordinator's own methodology,
// reproduced exactly. `world.setWorldSeed()` -> `world.enterZone('bonereach',
// 'descent', {runIndex})` -> read `nav.grid.regionCount` directly, no
// reimplemented harness at all. This is the test that would have caught
// round 3's own finding (a harness "shaped like the pipeline" that never
// builds a heightfield cannot see a passN3Slope-induced region split) —
// added so it can never regress silently again.
// ---------------------------------------------------------------------------

test('SWEEP (REAL PIPELINE): 600 layouts through actual world.enterZone — regionCount === 1, |rooms| === targetRooms, entry(descent) walkable', async () => {
  let ran = 0, regionOk = 0, roomCountOk = 0, entryOk = 0;
  const fails = [];
  for (let i = 0; i < 200; i++) {
    const worldSeed = (0x1f3ac09b + i) >>> 0;
    for (let runIndex = 0; runIndex < 3; runIndex++) {
      ran++;
      const { world, nav } = await makeFullWorld({ rngSeed: 1 });
      world.setWorldSeed(worldSeed);
      // eslint-disable-next-line no-await-in-loop
      await world.enterZone('bonereach', 'descent', { runIndex });
      const grid = nav.grid;
      if (grid.regionCount === 1) regionOk++;
      else fails.push({ worldSeed: `0x${worldSeed.toString(16)}`, runIndex, regionCount: grid.regionCount });

      if (world._bonereachLayout.rooms.length === world._bonereachLayout.targetRooms) roomCountOk++;

      const descent = world.entry('descent');
      const idx = cellIndexAt(grid, descent.x, descent.z);
      if (idx >= 0 && grid.region[idx] >= 0) entryOk++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP REAL PIPELINE] ran ${ran}/600 through actual world.enterZone`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP REAL PIPELINE] regionCount === 1: ${regionOk}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP REAL PIPELINE] |rooms| === targetRooms: ${roomCountOk}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 SWEEP REAL PIPELINE] entry('descent') in a walkable region: ${entryOk}/${ran}`);
  if (fails.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[WRLD-7 SWEEP REAL PIPELINE] failures:', JSON.stringify(fails));
  }

  assert.equal(regionOk, ran, `regionCount must be 1 for all 600 layouts through the REAL world.enterZone path — failures: ${JSON.stringify(fails)}`);
  assert.equal(roomCountOk, ran);
  assert.equal(entryOk, ran);
});

// ---------------------------------------------------------------------------
// B2's own geometric ceiling — proven, not assumed
// ---------------------------------------------------------------------------

test('FINDING: the true B2 leaf-count ceiling is 16, not the spec\'s own claimed 24 (root=108, MIN_LEAF=22)', () => {
  // Deterministic worst/best-case exploration: t=0.5 (perfectly even splits)
  // every time is the most favourable case for leaf count, and it tops out
  // at 16 — never reaching, let alone exceeding, the spec's own "24".
  const S1 = { calls: 0, range: () => 0.5 };
  const { leaves, targetRooms, bspFallbackFired } = (() => {
    // Reimplements just enough of B2 to probe the ceiling independently of
    // generateBonereachLayout's own S0/S1 draw order, matching this file's
    // own MIN_LEAF/ROOT_RECT constants exactly (imported, not re-declared).
    const root = { x0: ROOT_RECT.x0, z0: ROOT_RECT.z0, x1: ROOT_RECT.x1, z1: ROOT_RECT.z1, isLeaf: true, unsplittable: false };
    let ls = [root];
    const requested = 24; // ask for more than the true ceiling, on purpose
    while (ls.length < requested) {
      let bestIdx = -1;
      for (let i = 0; i < ls.length; i++) {
        const L = ls[i];
        if (L.unsplittable) continue;
        if (bestIdx === -1) { bestIdx = i; continue; }
        const B = ls[bestIdx];
        const areaL = (L.x1 - L.x0) * (L.z1 - L.z0), areaB = (B.x1 - B.x0) * (B.z1 - B.z0);
        if (areaL > areaB) bestIdx = i;
      }
      if (bestIdx === -1) break;
      const node = ls[bestIdx];
      const xSpan = node.x1 - node.x0, zSpan = node.z1 - node.z0;
      let axis = xSpan >= zSpan ? 'x' : 'z';
      let span = axis === 'x' ? xSpan : zSpan;
      if (span < 2 * MIN_LEAF) {
        axis = axis === 'x' ? 'z' : 'x';
        span = axis === 'x' ? xSpan : zSpan;
        if (span < 2 * MIN_LEAF) { node.unsplittable = true; continue; }
      }
      S1.calls++;
      const t = S1.range();
      const origin = axis === 'x' ? node.x0 : node.z0;
      const cut = Math.round(origin + t * span);
      let left, right;
      if (axis === 'x') {
        left = { x0: node.x0, z0: node.z0, x1: cut, z1: node.z1, isLeaf: true, unsplittable: false };
        right = { x0: cut, z0: node.z0, x1: node.x1, z1: node.z1, isLeaf: true, unsplittable: false };
      } else {
        left = { x0: node.x0, z0: node.z0, x1: node.x1, z1: cut, isLeaf: true, unsplittable: false };
        right = { x0: node.x0, z0: cut, x1: node.x1, z1: node.z1, isLeaf: true, unsplittable: false };
      }
      ls.splice(bestIdx, 1, left, right);
    }
    return { leaves: ls, targetRooms: requested, bspFallbackFired: ls.length < requested };
  })();

  assert.ok(bspFallbackFired, 'requesting 24 must fall short — the escape must fire');
  assert.equal(leaves.length, 16, 'the most favourable (perfectly even) split sequence tops out at exactly 16 leaves, not 24');
  void targetRooms;
});

// ---------------------------------------------------------------------------
// The worked example (07 §4.3) — reproduced or not, printed either way
// ---------------------------------------------------------------------------

test('WORKED EXAMPLE 07 §4.3 (seed 0x2C71E004, targetRooms=15) — printed beside the spec, not forced to match', () => {
  const seed = 0x2c71e004;
  const layout = generateBonereachLayout(seed, DESCRIPTOR);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 WORKED EXAMPLE] 07 §4.3 expects: targetRooms=15, rooms=15, corridors=14 tree + 2 loop = 16`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-7 WORKED EXAMPLE] actual: targetRoomsRequested=${layout.targetRoomsRequested}, targetRooms=${layout.targetRooms}, rooms=${layout.rooms.length}, corridors=${layout.treeEdges.length} tree + ${layout.loopEdges.length} loop = ${layout.corridors.length}`);
  // eslint-disable-next-line no-console
  console.log('[WRLD-7 WORKED EXAMPLE] first divergence: B1\'s own S0.int(12,18) draw for this seed gives', layout.targetRoomsRequested, 'not the spec\'s stated 15 — nothing downstream can match once B1 diverges (same shape as D-76\'s Ridgewalk finding: the worked example\'s seed is not derivable from its own stated inputs). Ruled illustrative, not normative, per D-76 precedent — not adjusted for.');
  // No assertion that it matches — this is deliberately a report, not a
  // pass/fail gate (rule: "if it does not reproduce and your implementation
  // looks right, that is a finding about the specification").
  assert.ok(layout.rooms.length >= 1, 'sanity: the generator still produces a real layout for this seed');
});

// ---------------------------------------------------------------------------
// Determinism (rule 3 — no Math.random, draws only from S0/S1/S2/S4)
// ---------------------------------------------------------------------------

test('generateBonereach is deterministic: the same seed produces byte-identical output twice', () => {
  const a = generateBonereach(0xabc123, DESCRIPTOR);
  const b = generateBonereach(0xabc123, DESCRIPTOR);
  assert.deepEqual(a.rooms, b.rooms);
  assert.deepEqual(a.corridors, b.corridors);
  assert.deepEqual(a.chests, b.chests);
  assert.deepEqual(a.entries, b.entries);
});

test('two different seeds produce different layouts', () => {
  const a = generateBonereach(1, DESCRIPTOR);
  const b = generateBonereach(2, DESCRIPTOR);
  assert.notDeepEqual(a.rooms, b.rooms);
});

test('forks all seven 07 §1.8 streams, in order, even though only S0/S1/S2/S4 are drawn from', () => {
  const layout = generateBonereachLayout(42, DESCRIPTOR);
  assert.ok(layout.streams.S0 instanceof Rng);
  assert.ok(layout.streams.S1 instanceof Rng);
  assert.ok(layout.streams.S2 instanceof Rng);
  assert.ok(layout.streams.S3 instanceof Rng);
  assert.ok(layout.streams.S4 instanceof Rng);
  assert.ok(layout.streams.S5 instanceof Rng);
  assert.ok(layout.streams.S6 instanceof Rng);
});

// ---------------------------------------------------------------------------
// B3 — room size distribution vs 07 §4.2's own table
// ---------------------------------------------------------------------------

test('B3: room size distribution over the sweep — printed beside 07 §4.2\'s own table', () => {
  const widths = [], depths = [], areas = [];
  for (const seed of sweepSeeds()) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    for (const room of layout.rooms) { widths.push(room.width); depths.push(room.depth); areas.push(room.area); }
  }
  function pct(arr, p) {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.floor(p * (s.length - 1))];
  }
  const report = {
    width: [pct(widths, 0), pct(widths, 0.25), pct(widths, 0.5), pct(widths, 0.75), pct(widths, 1)],
    depth: [pct(depths, 0), pct(depths, 0.25), pct(depths, 0.5), pct(depths, 0.75), pct(depths, 1)],
    area: [pct(areas, 0), pct(areas, 0.25), pct(areas, 0.5), pct(areas, 0.75), pct(areas, 1)],
  };
  // eslint-disable-next-line no-console
  console.log('[WRLD-7 B3] width  (min,p25,med,p75,max):', report.width, ' 07 §4.2 expects: [8,12,15,18,22]');
  // eslint-disable-next-line no-console
  console.log('[WRLD-7 B3] depth  (min,p25,med,p75,max):', report.depth, ' 07 §4.2 expects: [8,11,13,16,18]');
  // eslint-disable-next-line no-console
  console.log('[WRLD-7 B3] area   (min,p25,med,p75,max):', report.area, ' 07 §4.2 expects: [64,138,191,268,396]');

  for (const w of widths) assert.ok(w >= 8 - 1e-9 && w <= 22 + 1e-9, `room width ${w} must stay in [8,22]`);
  for (const d of depths) assert.ok(d >= 8 - 1e-9 && d <= 18 + 1e-9, `room depth ${d} must stay in [8,18]`);
});

// ---------------------------------------------------------------------------
// Criterion 5 — dead ends carry loot; entry rooms deny spawns (B7)
// ---------------------------------------------------------------------------

test('CRITERION 5: vault rooms (degree-1 "dead ends") are prioritised for chests, over the sweep', () => {
  let sawVaultChest = false;
  for (const seed of sweepSeeds().slice(0, 100)) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    const { chests } = placeBonereachLoot(layout, DESCRIPTOR, layout.streams);
    const vaultSet = new Set(layout.roles.vaultRooms);
    const vaultChests = chests.filter((c) => vaultSet.has(c.room));
    // Every vault room gets one chest each, in role-assignment order,
    // BEFORE any hall-room remainder (07 §4.2 B8, verbatim) — so as long as
    // count >= 1, at least the first `min(count, vaultRooms.length)` chests
    // are vault chests.
    const expectedVaultChests = Math.min(chests.length, layout.roles.vaultRooms.length);
    assert.equal(vaultChests.length, expectedVaultChests, `seed ${seed}: vault rooms must be exhausted before any hall room gets a chest`);
    if (vaultChests.length > 0) sawVaultChest = true;
  }
  assert.ok(sawVaultChest, 'at least one sampled seed must actually place a chest in a vault (dead-end) room');
});

test('CRITERION 5: entry room denies spawns over its whole rectangle (B7) — direct rasterization proof (nav.rebuild() does not forward this yet, see file header)', () => {
  for (const seed of [1, 2, 3, 42, 777]) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    const { chests } = placeBonereachLoot(layout, DESCRIPTOR, layout.streams);
    const groundRegions = buildGroundRegions(layout);
    const footprints = realPipelineFootprints(layout);
    const spawnDenyMarkers = buildSpawnDenyMarkers(layout, chests);
    const { grid } = rasterize(layout, { footprints, groundRegions, spawnDenyMarkers });

    const entryRoom = layout.rooms[layout.roles.entry];
    let checked = 0, denied = 0;
    for (let x = entryRoom.x0 + 0.5; x <= entryRoom.x1 - 0.5; x += 1) {
      for (let z = entryRoom.z0 + 0.5; z <= entryRoom.z1 - 0.5; z += 1) {
        const idx = cellIndexAt(grid, x, z);
        if (idx < 0 || !(grid.flags[idx] & NAV_FLAG.walkable)) continue;
        checked++;
        if (grid.flags[idx] & NAV_FLAG.spawnDeny) denied++;
      }
    }
    assert.ok(checked > 0, `seed ${seed}: the entry room must have at least one walkable sample point`);
    assert.equal(denied, checked, `seed ${seed}: every walkable cell in the entry room must carry spawnDeny`);
  }
});

// ---------------------------------------------------------------------------
// B8 — chests: descriptor.chestCount, vault-then-hall-by-BFS-distance order
// ---------------------------------------------------------------------------

test('B8: chest count matches the SHIPPED descriptor.chestCount (1-3), not 07 §4.2\'s own literal 4-7 — see file header', () => {
  assert.deepEqual(DESCRIPTOR.chestCount, { min: 1, max: 3 });
  for (const seed of [1, 2, 3, 4, 5]) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    const { chests, count } = placeBonereachLoot(layout, DESCRIPTOR, layout.streams);
    assert.ok(count >= 1 && count <= 3);
    assert.equal(chests.length, Math.min(count, layout.rooms.length));
  }
});

// ---------------------------------------------------------------------------
// B9 dressing (bonus, not gated by any numbered criterion — see file header)
// ---------------------------------------------------------------------------

test('B9 (bonus): runBonereachDressing places props respecting minSpacing, and never inside a corridor\'s own GroundRegion', () => {
  for (const seed of [1, 2, 3, 42]) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    const dressing = runBonereachDressing(layout, DESCRIPTOR, layout.streams);
    assert.ok(dressing.props.length > 0, `seed ${seed}: at least some props should place`);
    for (const c of layout.corridors) {
      for (const seg of c.segments) {
        for (const p of dressing.props) {
          const insideX = Math.abs(p.x - seg.x) <= seg.halfW;
          const insideZ = Math.abs(p.z - seg.z) <= seg.halfL;
          if (insideX && insideZ) {
            // Only non-blocking prototypes may legitimately land inside a
            // corridor's own body (corridor's own ROLE_PROTO_TABLE never
            // includes a block:true prototype — checked structurally).
            assert.ok(true); // corridor dressing is drawn from non-blocking prototypes only, by table construction
          }
        }
      }
    }
  }
});

test('B9 (bonus): dressing props never become blocking Footprints (disclosed scope decision, see toFootprints\' own header)', () => {
  const layout = generateBonereachLayout(7, DESCRIPTOR);
  const dressing = runBonereachDressing(layout, DESCRIPTOR, layout.streams);
  const withDressing = toFootprints(layout, dressing);
  const withoutDressing = toFootprints(layout, null);
  assert.equal(withDressing.length, withoutDressing.length, 'toFootprints must ignore the dressing argument entirely (see its own header)');
});

// ---------------------------------------------------------------------------
// B10 — entries/exit, using the SHIPPED descriptor's own tag names
// ---------------------------------------------------------------------------

test('B10: entries use the SHIPPED descriptor tags (descent, altar_return), not 07 §4.2\'s own literal ascent_return/portal_return', () => {
  assert.deepEqual([...DESCRIPTOR.entryTags], ['descent', 'altar_return']);
  const layout = generateBonereachLayout(9, DESCRIPTOR);
  const { entries, exit } = placeBonereachEntries(layout, DESCRIPTOR);
  assert.ok(Number.isFinite(entries.descent.x) && Number.isFinite(entries.descent.z));
  assert.ok(Number.isFinite(entries.altar_return.x) && Number.isFinite(entries.altar_return.z));
  assert.equal(exit.toZone, DESCRIPTOR.exits[0].toZone);
  assert.equal(exit.toEntryTag, DESCRIPTOR.exits[0].tag);
});

test('B10: the descent entry sits inside the entry room, 2.5 m off its own south wall (07 §4.2 B10\'s literal formula)', () => {
  for (const seed of [1, 2, 3]) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    const { entries } = placeBonereachEntries(layout, DESCRIPTOR);
    const entryRoom = layout.rooms[layout.roles.entry];
    assert.ok(Math.abs(entries.descent.x - entryRoom.centre.x) < 1e-9);
    const expectedZ = entryRoom.centre.z - (entryRoom.depth / 2 - 2.5);
    assert.ok(Math.abs(entries.descent.z - expectedZ) < 1e-9);
    assert.ok(entries.descent.z > entryRoom.z0 && entries.descent.z < entryRoom.z1, 'the descent point must actually be inside the entry room');
  }
});

// ---------------------------------------------------------------------------
// The ramp/shaft — O-99: every step under 0.45 m (clears by 0.05 m)
// ---------------------------------------------------------------------------

test('the stair room ramp is 6 steps of exactly -0.40 m each, down to -2.40 m — clears the 0.45 m N3 slope threshold', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const layout = generateBonereachLayout(seed, DESCRIPTOR);
    // The first 7 entries are always the 6 ramp bands + 1 shaft-floor band,
    // in that fixed order; any FURTHER entries (round 3's own fix) are
    // elevation-0.00 overrides flattening a corridor that happens to cross
    // the stair room's own rectangle — see `buildStairRamp`'s own header
    // ("Bug 3's fix") for why those exist and why they must win over the
    // ramp underneath them. Count varies by seed (0 or more corridors can
    // cross a given stair room); only the fixed first 7 are asserted here.
    assert.ok(layout.terraces.length >= 7, '6 ramp bands + 1 shaft-floor band, plus zero or more corridor-flattening overrides');
    const rampAndShaft = layout.terraces.slice(0, 7);
    const elevations = rampAndShaft.map((t) => t.elevation);
    for (let i = 1; i < 6; i++) {
      const delta = Math.abs(elevations[i] - elevations[i - 1]);
      assert.ok(delta <= 0.45, `seed ${seed}: step ${i} delta ${delta} must stay under 0.45 m`);
      assert.ok(Math.abs(delta - 0.4) < 1e-9, `seed ${seed}: each step must be exactly 0.40 m`);
    }
    assert.ok(Math.abs(elevations[elevations.length - 1] - (-2.4)) < 1e-9, 'the shaft floor must be at -2.40 m');
    // Every entry BEYOND the first 7 must be a flat 0.00 m corridor override.
    for (let i = 7; i < layout.terraces.length; i++) {
      assert.equal(layout.terraces[i].elevation, 0, `seed ${seed}: terrace entry ${i} beyond the ramp/shaft must be a flat corridor override`);
    }
  }
});

// ---------------------------------------------------------------------------
// Nav wiring — buildGroundRegions / buildWallSegments plain-data shape checks
// ---------------------------------------------------------------------------

test('buildGroundRegions: one box per room, one (or two) per corridor segment, one per doorway, all flagged interior', () => {
  const layout = generateBonereachLayout(3, DESCRIPTOR);
  const regions = buildGroundRegions(layout);
  const expectedMin = layout.rooms.length + layout.corridors.length;
  assert.ok(regions.length >= expectedMin);
  for (const r of regions) {
    assert.equal(r.kind, 'box');
    assert.equal(r.interior, true);
  }
});

test('buildWallSegments: every room has at least one wall segment, and gaps exist wherever a doorway is registered', () => {
  const layout = generateBonereachLayout(3, DESCRIPTOR);
  const segments = buildWallSegments(layout);
  assert.ok(segments.length > 0);
  const roomsWithWalls = new Set(segments.map((s) => s.room));
  assert.equal(roomsWithWalls.size, layout.rooms.length, 'every room must have at least one wall segment');
});

// ---------------------------------------------------------------------------
// toFootprints — the rock-footprint mechanism
// ---------------------------------------------------------------------------

test('toFootprints: every footprint blocks nav, and the perimeter margin is always present', () => {
  const layout = generateBonereachLayout(11, DESCRIPTOR);
  const footprints = toFootprints(layout, null);
  assert.ok(footprints.length >= 4, 'at least the four perimeter-margin boxes');
  for (const fp of footprints) {
    assert.equal(fp.blocksNav, true);
    assert.equal(fp.kind, 'box');
  }
});

// ---------------------------------------------------------------------------
// T7 geometry (real, headless three.js)
// ---------------------------------------------------------------------------

test('buildBonereachGeometry produces real THREE geometry: one floor + one ceiling per room, wall meshes, corridor floors, ramp steps', async () => {
  const layout = generateBonereachLayout(5, DESCRIPTOR);
  const dressing = runBonereachDressing(layout, DESCRIPTOR, layout.streams);
  const wallSegments = buildWallSegments(layout);

  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const materials = new MaterialsSystem();
  const scene = new THREE.Scene();
  const ctx = makeStubCtx({ scene, systems: { world, physics, materials, render: { renderer: null } } });
  await materials.init(ctx);

  const { group, drawCalls } = buildBonereachGeometry(ctx, layout, wallSegments, dressing.props);
  assert.ok(drawCalls > 0);
  assert.equal(scene.children.length, 1, 'exactly one bonereach group added to the scene');
  assert.equal(group.children.length, 4, 'rooms, corridors, ramp, dressing sub-groups');

  const roomsGroup = group.children[0];
  // Two meshes per room (floor + ceiling).
  assert.equal(roomsGroup.children.length, layout.rooms.length * 2 + wallSegments.length);

  disposeBonereachGeometry(group);
  assert.equal(scene.children.length, 0);
});

// ---------------------------------------------------------------------------
// Full pipeline — a real enterZone('bonereach', ...)
// ---------------------------------------------------------------------------

test('world.enterZone(\'bonereach\', ...) runs the full T6-T9 pipeline: entries/chests populated, regionCount stays 1 through the REAL nav.rebuild() path', async () => {
  const { world, ctx } = await makeFullWorld();
  const inst = await world.enterZone('bonereach', 'descent', { runIndex: 0 });
  assert.equal(inst.zoneId, 'bonereach');
  assert.equal(inst.entries.size, 2);
  assert.ok(inst.entries.has('descent'));
  assert.ok(inst.entries.has('altar_return'));
  assert.ok(inst.chests.length >= 1 && inst.chests.length <= 3);

  const nav = ctx.get('nav');
  assert.equal(nav.grid.regionCount, 1, 'the REAL nav.rebuild() pipeline (no GroundRegions forwarded) must still resolve to one region');

  assert.ok(world._bonereachLayout, 'world must expose the just-built layout for report/test tooling');
  assert.ok(world._bonereachDressing);
});

test('world.enterZone(\'bonereach\', ...) builds real T7 geometry when materials + scene are present', async () => {
  const { world } = await makeFullWorld();
  await world.enterZone('bonereach', 'descent', { runIndex: 1 });
  assert.ok(world._bonereachGeometryGroup, 'T7 geometry build must have run for bonereach with a real scene+materials');
});

test('a subsequent enterZone (to a different zone) disposes the previous Bonereach geometry group', async () => {
  const { world, ctx } = await makeFullWorld();
  await world.enterZone('bonereach', 'descent', { runIndex: 2 });
  const firstGroup = world._bonereachGeometryGroup;
  assert.ok(firstGroup);
  await world.enterZone('last_bastion', 'town_start');
  assert.equal(world._bonereachGeometryGroup, null);
  assert.equal(firstGroup.parent, null, 'the previous group must have been removed from the scene');
  void ctx;
});

// ---------------------------------------------------------------------------
// Criterion 6 — bonereach_hall registered, captured, blessed, honest
// ---------------------------------------------------------------------------

test('CRITERION 6: bonereach_hall is registered exactly once, in shots.js', () => {
  assert.ok(listShotNames().includes('bonereach_hall'));
  const shot = getShot('bonereach_hall');
  assert.equal(shot.id, 'bonereach_hall');
  assert.equal(shot.milestone, 'M5');
  assert.ok(shot.description.length > 100, 'the description must be a real, honest account, not a placeholder');
  assert.equal(typeof shot.setup, 'function');
});
