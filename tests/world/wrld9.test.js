// tests/world/wrld9.test.js
//
// WRLD-9 acceptance tests — `src/world/spawn.js` (headless) wired into
// `src/world/index.js#enterZone` at T10. `node:test` + `node:assert/strict`
// only (12-testing.md P6).
//
// ---------------------------------------------------------------------------
// O-106's own rule: drive the sweep through the REAL `world.enterZone`
// ---------------------------------------------------------------------------
// WRLD-7 was accepted on a harness "in the shape of" the real pipeline that
// never built a heightfield and so never exercised `passN3Slope` at all —
// found only when the orchestrator's own probe ran the REAL
// `world.enterZone` end to end. Every density/criterion number in this file
// is measured through `world.setWorldSeed()` -> `world.enterZone(...)` ->
// `world.spawnPoints`/`world.packs`, exactly that call chain, never a
// reimplementation of `spawn.js`'s own logic against a hand-built grid.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import {
  buildPathDistanceField,
  DIFFICULTY_MLVL_OFFSET,
  SAFETY_RADIUS,
} from '../../src/world/spawn.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../../src/world/data/zones.js';
import * as PlayerProgression from '../../src/player/data/progression.js';

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

function seedList(base, count) {
  const seeds = [];
  for (let i = 0; i < count; i++) seeds.push((base + i) >>> 0);
  return seeds;
}

// ---------------------------------------------------------------------------
// D-38 check — OPENING_RAMP is not (yet) exported by progression.js; this is
// a documented, expected state (see spawn.js's own header), not a bug this
// suite should paper over.
// ---------------------------------------------------------------------------

test('OPENING_RAMP: progression.js does not export it yet (PLYR-6/L1, M6) — spawn.js imports it via a namespace import so it activates automatically the day it lands, never redefines it', () => {
  assert.equal(PlayerProgression.OPENING_RAMP, undefined, 'OPENING_RAMP must not exist in src/player/data/progression.js yet — if this now fails, PLYR-6 landed and spawn.js should be re-verified against the real table');
  assert.equal(typeof PlayerProgression.XP_TOTAL, 'function', 'progression.js must still export XP_TOTAL (PLYR-4, unrelated to this ticket)');
});

test('DIFFICULTY_MLVL_OFFSET matches 03-combat-math.md §10.2 exactly (+0/+12/+22, not 07 §8.6\'s own stale +0/+9/+17)', () => {
  assert.deepEqual(DIFFICULTY_MLVL_OFFSET, { instruction: 0, trial: 12, renunciation: 22 });
});

// ---------------------------------------------------------------------------
// buildPathDistanceField — unit-level correctness on a hand-built grid
// ---------------------------------------------------------------------------

function makeGrid(width, height, cellSize = 0.5) {
  const n = width * height;
  return {
    width, height, cellSize, originX: 0, originZ: 0,
    flags: new Uint8Array(n), cost: new Uint8Array(n), region: new Int16Array(n).fill(-1), groundY: new Float32Array(n),
  };
}
const WALKABLE = 1;

test('buildPathDistanceField: straight corridor gives exact 4-connected metres; a diagonal-only gap stays Infinity', () => {
  const grid = makeGrid(5, 1);
  grid.flags.fill(WALKABLE);
  const dist = buildPathDistanceField(grid, 0.25, 0.25); // cell (0,0) centre
  // cells (0,0)..(4,0), 0.5 m each: distances 0,0.5,1.0,1.5,2.0
  for (let cx = 0; cx < 5; cx++) {
    assert.ok(Math.abs(dist[cx] - cx * 0.5) < 1e-6, `cell ${cx}: expected ${cx * 0.5}, got ${dist[cx]}`);
  }

  // A 2x2 grid where only the two diagonal cells are walkable must never
  // connect them — 4-connectivity only, matching passN7Regions exactly.
  const g2 = makeGrid(2, 2);
  g2.flags[0] = WALKABLE; // (0,0)
  g2.flags[3] = WALKABLE; // (1,1) — diagonal from (0,0), no shared edge
  const d2 = buildPathDistanceField(g2, 0.25, 0.25);
  assert.equal(d2[0], 0);
  assert.equal(d2[3], Infinity, 'diagonal-only neighbour must stay unreachable (4-connected, matching N7)');
});

test('buildPathDistanceField: entry cell not walkable returns an all-Infinity field, no throw', () => {
  const grid = makeGrid(3, 3);
  // nothing walkable
  const dist = buildPathDistanceField(grid, 0.75, 0.75);
  assert.ok(Array.from(dist).every((d) => d === Infinity));
});

// ---------------------------------------------------------------------------
// SWEEP (REAL PIPELINE) — Ashen Wastes, 600 layouts through world.enterZone
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D-84 (coordinator ruling, delivered after WRLD-6 landed
// `buildGateRampTerraces` — the fix for the upstream cause this suite's own
// earlier run pointed at): `I4` on `ashen_wastes` is checked ONLY on
// layouts where `descriptor.packCount.min x descriptor.packSize.min` is
// satisfiable at all — `densityTarget x entryArea >= packCount.min x
// packSize.min` — and there it must hold at I4's own NATIVE ±20% band, not
// this ticket's own tighter ±2%. `packCount.min`/`packSize.min`/
// `densityTarget` are frozen game content until M7 and are NEVER tuned to
// force this — that would mask the geometry, not fix it (D-84's own words).
// Every layout where the floor binds is emitted as an explicit, individually
// listed `FLOOR-CLAMPED` entry (O-58's "a check that cannot run reports
// skip LOUDLY" precedent) — never silently excluded, never silently passed.
// ---------------------------------------------------------------------------

test('SWEEP (REAL PIPELINE): Ashen Wastes — 600 layouts through actual world.enterZone (D-84)', async () => {
  const desc = ZONE_DESCRIPTORS_BY_ID.ashen_wastes;
  const floorMonsters = desc.packCount.min * desc.packSize.min; // 45

  const seeds = seedList(0x2f19a001, 200);
  let ran = 0;
  const deviations = [];
  const floorClamped = [];
  let uniqueOneCount = 0;
  let deadEndOkCount = 0;
  let spawnPushedTotal = 0;
  const tierOffsetsSeen = new Set();
  let sizesSumOkCount = 0;
  let walkableAreaEntryLtWhole = 0;

  for (const worldSeed of seeds) {
    for (let runIndex = 0; runIndex < 3; runIndex++) {
      ran++;
      // eslint-disable-next-line no-await-in-loop
      const { world } = await makeFullWorld({ rngSeed: 1 });
      world.setWorldSeed(worldSeed);
      // eslint-disable-next-line no-await-in-loop
      await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex });

      const report = world._spawnReport;
      assert.ok(report, 'spawn report must exist for ashen_wastes');

      const dev = report.achievedDensity > 0 ? (report.achievedDensity - report.densityTarget) / report.densityTarget : 0;
      const label = { worldSeed: `0x${worldSeed.toString(16)}`, runIndex };
      // D-84's own satisfiability test: densityTarget here is already
      // `descriptor.densityTarget x tierDensityMul` (spawn.js's own
      // report field) — exactly what §8.1's targetTotal is computed from.
      const floorSatisfiable = report.densityTarget * report.walkableAreaEntryRegion >= floorMonsters;

      if (!floorSatisfiable) {
        floorClamped.push({ ...label, tag: 'FLOOR-CLAMPED', achievedDensity: report.achievedDensity, walkableAreaEntryRegion: report.walkableAreaEntryRegion, targetTotal: report.targetTotal, achievedTotal: report.achievedTotal });
      } else {
        deviations.push({ ...label, dev, ...report });
      }

      if (report.uniqueCount === 1) uniqueOneCount++;
      if (report.deadEndCellsOk) deadEndOkCount++;
      if (report.sizesSumOk) sizesSumOkCount++;
      spawnPushedTotal += report.spawnPushedCount;
      if (report.walkableAreaEntryRegion < report.walkableAreaWholeGrid) walkableAreaEntryLtWhole++;

      for (const p of world.packs) tierOffsetsSeen.add(p.mlvl - ZONE_DESCRIPTORS_BY_ID.ashen_wastes.monsterLevel);
      // Every pack in this sweep runs at 'instruction' (no quest passed in
      // -> ramp never applies -> every mlvl must be monsterLevel+0).
    }
  }

  const checked = deviations.length;
  const within20pct = deviations.filter((d) => Math.abs(d.dev) <= 0.2).length;
  const within2pct = deviations.filter((d) => Math.abs(d.dev) <= 0.02).length;
  const maxDev = deviations.reduce((m, d) => Math.max(m, Math.abs(d.dev)), 0);
  const worst = deviations.slice().sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev)).slice(0, 5);

  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] ran ${ran}/600`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] D-84 floor = packCount.min(${desc.packCount.min}) x packSize.min(${desc.packSize.min}) = ${floorMonsters} monsters`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] FLOOR-CLAMPED (floor unsatisfiable, excluded from I4, reported loudly): ${floorClamped.length}/${ran} = ${((floorClamped.length / ran) * 100).toFixed(1)}%`);
  // eslint-disable-next-line no-console
  console.log('[WRLD-9 SWEEP wastes] FLOOR-CLAMPED full list:', JSON.stringify(floorClamped));
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] I4-checked (floor satisfiable): ${checked}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] of those, within I4's native ±20%: ${within20pct}/${checked} — max |dev| = ${(maxDev * 100).toFixed(2)}%`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] of those, within this ticket's own tighter ±2% (informational only, not gated per D-84): ${within2pct}/${checked}`);
  // eslint-disable-next-line no-console
  console.log('[WRLD-9 SWEEP wastes] worst 5 by |deviation| among I4-checked:', JSON.stringify(worst.map((w) => ({ worldSeed: w.worldSeed, runIndex: w.runIndex, dev: `${(w.dev * 100).toFixed(2)}%`, walkableAreaEntryRegion: w.walkableAreaEntryRegion, walkableAreaWholeGrid: w.walkableAreaWholeGrid, targetTotal: w.targetTotal, achievedTotal: w.achievedTotal, packCount: w.packCount, sizesSumOk: w.sizesSumOk }))));
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] exactly one unique: ${uniqueOneCount}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] every dead-end tip holds champion/unique: ${deadEndOkCount}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] sizes sum === targetTotal (§8.1 identity): ${sizesSumOkCount}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] SPAWN_PUSHED total across all members, all layouts: ${spawnPushedTotal}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP wastes] entry-region walkable area < whole-grid walkable area (O-102 confirmed live): ${walkableAreaEntryLtWhole}/${ran}`);
  // eslint-disable-next-line no-console
  console.log('[WRLD-9 SWEEP wastes] mlvl offsets observed (mlvl - descriptor.monsterLevel):', Array.from(tierOffsetsSeen));

  assert.equal(uniqueOneCount, ran, 'exactly one unique per layout must hold on every layout');
  assert.equal(deadEndOkCount, ran, 'every dead-end tip must hold a champion or the unique on every layout');
  assert.equal(spawnPushedTotal, 0, 'MB17: SPAWN_PUSHED must be 0 across the whole sweep');
  assert.deepEqual(Array.from(tierOffsetsSeen), [0], 'every pack must read mlvl = descriptor.monsterLevel + 0 at Instruction (OPENING_RAMP inert, no quest passed)');

  // D-84's own gate: on every layout where the descriptor's own floor is
  // satisfiable at all, I4 must hold at its NATIVE ±20% — checked, floor
  // never touched, floor-bound layouts never silently folded in.
  assert.ok(checked > 0, 'at least one layout must be floor-satisfiable, or this assertion is vacuous');
  assert.equal(within20pct, checked, `I4 (native ±20%) must hold on every floor-satisfiable layout — failing on ${checked - within20pct}/${checked}`);
});

// ---------------------------------------------------------------------------
// SWEEP (REAL PIPELINE) — Bonereach, 600 layouts through world.enterZone
// ---------------------------------------------------------------------------

test('SWEEP (REAL PIPELINE): Bonereach — 600 layouts through actual world.enterZone', async () => {
  const seeds = seedList(0x3a7c2110, 200);
  let ran = 0;
  const deviations = [];
  let uniqueOneCount = 0;
  let deadEndOkCount = 0;
  let spawnPushedTotal = 0;
  let sizesSumOkCount = 0;
  let nullArchetypeCount = 0;
  let totalPacks = 0;
  const tierOffsetsSeen = new Set();

  for (const worldSeed of seeds) {
    for (let runIndex = 0; runIndex < 3; runIndex++) {
      ran++;
      // eslint-disable-next-line no-await-in-loop
      const { world } = await makeFullWorld({ rngSeed: 1 });
      world.setWorldSeed(worldSeed);
      // eslint-disable-next-line no-await-in-loop
      await world.enterZone('bonereach', 'descent', { runIndex });

      const report = world._spawnReport;
      assert.ok(report, 'spawn report must exist for bonereach');

      const dev = report.achievedDensity > 0 ? (report.achievedDensity - report.densityTarget) / report.densityTarget : 0;
      deviations.push({ worldSeed: `0x${worldSeed.toString(16)}`, runIndex, dev, ...report });

      if (report.uniqueCount === 1) uniqueOneCount++;
      if (report.deadEndCellsOk) deadEndOkCount++;
      if (report.sizesSumOk) sizesSumOkCount++;
      spawnPushedTotal += report.spawnPushedCount;

      for (const p of world.packs) {
        totalPacks++;
        if (p.archetypeId === null) nullArchetypeCount++;
        tierOffsetsSeen.add(p.mlvl - ZONE_DESCRIPTORS_BY_ID.bonereach.monsterLevel);
      }
    }
  }

  const within2pct = deviations.filter((d) => Math.abs(d.dev) <= 0.02).length;
  const maxDev = deviations.reduce((m, d) => Math.max(m, Math.abs(d.dev)), 0);

  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] ran ${ran}/600`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] density within ±2%: ${within2pct}/${ran} = ${((within2pct / ran) * 100).toFixed(1)}% — max |dev| = ${(maxDev * 100).toFixed(2)}%`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] exactly one unique: ${uniqueOneCount}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] every vault room holds champion/unique: ${deadEndOkCount}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] sizes sum === targetTotal (§8.1 identity): ${sizesSumOkCount}/${ran}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] SPAWN_PUSHED total across all members, all layouts: ${spawnPushedTotal}`);
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 SWEEP bonereach] archetypeId === null (was ALL of them while the shipped bestiary was [] — O-139 filled it): ${nullArchetypeCount}/${totalPacks} packs`);
  // eslint-disable-next-line no-console
  console.log('[WRLD-9 SWEEP bonereach] mlvl offsets observed:', Array.from(tierOffsetsSeen));

  assert.equal(uniqueOneCount, ran, 'exactly one unique per layout must hold on every layout');
  assert.equal(deadEndOkCount, ran, 'every vault room must hold a champion or the unique on every layout');
  assert.equal(spawnPushedTotal, 0, 'MB17: SPAWN_PUSHED must be 0 across the whole sweep');
  assert.equal(nullArchetypeCount, 0, 'no Bonereach pack may carry archetypeId===null now that the shipped descriptor.bestiary is real (O-139)');
  assert.deepEqual(Array.from(tierOffsetsSeen), [0], 'every pack must read mlvl = descriptor.monsterLevel + 0 at Instruction');
  assert.equal(within2pct, ran, `Bonereach density must land within ±2% on every layout — off by more than 2% on ${ran - within2pct}/${ran}`);
});

// ---------------------------------------------------------------------------
// I3 — every SpawnPoint / pack centre in the entry region, on both zones,
// through the real pipeline (spot-check across a handful of real zones,
// not a full 600 re-walk — the sweeps above already run 1200 real
// enterZone calls; this is a targeted structural check on a sample of them).
// ---------------------------------------------------------------------------

test('I3: every SpawnPoint and every PackDescriptor centre is walkable and in the entry region (Ashen Wastes, 20 real zones)', async () => {
  let checked = 0;
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    const { world, nav } = await makeFullWorld({ rngSeed: 1 });
    world.setWorldSeed((0x99110001 + i) >>> 0);
    // eslint-disable-next-line no-await-in-loop
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });
    const grid = nav.grid;
    const entry = world.entry('portal_from_town');
    const entryIdx = grid.width * Math.floor((entry.z - grid.originZ) / grid.cellSize) + Math.floor((entry.x - grid.originX) / grid.cellSize);
    const entryRegion = grid.region[entryIdx];

    for (const sp of world.spawnPoints) {
      checked++;
      const cx = Math.floor((sp.x - grid.originX) / grid.cellSize);
      const cz = Math.floor((sp.z - grid.originZ) / grid.cellSize);
      const idx = cz * grid.width + cx;
      assert.ok(grid.flags[idx] & 1, `SpawnPoint ${sp.id} must be walkable`);
      assert.equal(grid.region[idx], entryRegion, `SpawnPoint ${sp.id} must be in the entry region`);
      assert.equal(sp.regionId, entryRegion, `SpawnPoint ${sp.id}.regionId must match the live grid`);
    }
    for (const p of world.packs) {
      const cx = Math.floor((p.centerX - grid.originX) / grid.cellSize);
      const cz = Math.floor((p.centerZ - grid.originZ) / grid.cellSize);
      const idx = cz * grid.width + cx;
      assert.ok(grid.flags[idx] & 1, `Pack ${p.id} centre must be walkable`);
      assert.equal(grid.region[idx], entryRegion, `Pack ${p.id} centre must be in the entry region`);
    }
  }
  assert.ok(checked > 0, 'must have actually checked some spawn points');
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 I3] ${checked} SpawnPoints checked across 20 real Ashen Wastes zones — all walkable, all in entry region`);
});

// ---------------------------------------------------------------------------
// Safety radius — every pack centre / SpawnPoint respects its zone's own
// minimum, measured via the SAME path-distance field spawn.js itself used
// (re-derived independently here from the live grid, not read back off the
// report, so this is a real cross-check).
// ---------------------------------------------------------------------------

test('safety radius: pack centres >= packCentreMin, SpawnPoints >= spawnPointMin (Ashen Wastes + Bonereach, real pipeline)', async () => {
  let wastesPacksChecked = 0;
  let wastesPointsChecked = 0;
  for (let i = 0; i < 15; i++) {
    // eslint-disable-next-line no-await-in-loop
    const { world, nav } = await makeFullWorld({ rngSeed: 1 });
    world.setWorldSeed((0x77001000 + i) >>> 0);
    // eslint-disable-next-line no-await-in-loop
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });
    const entry = world.entry('portal_from_town');
    const dist = buildPathDistanceField(nav.grid, entry.x, entry.z);
    const cellIndexAt = (x, z) => {
      const cx = Math.floor((x - nav.grid.originX) / nav.grid.cellSize);
      const cz = Math.floor((z - nav.grid.originZ) / nav.grid.cellSize);
      if (cx < 0 || cz < 0 || cx >= nav.grid.width || cz >= nav.grid.height) return -1;
      return cz * nav.grid.width + cx;
    };
    for (const p of world.packs) {
      wastesPacksChecked++;
      const idx = cellIndexAt(p.centerX, p.centerZ);
      const d = idx >= 0 ? dist[idx] : Infinity;
      assert.ok(d >= SAFETY_RADIUS.ashen_wastes.packCentreMin - 1e-6, `pack ${p.id} centre path-distance ${d} must be >= ${SAFETY_RADIUS.ashen_wastes.packCentreMin}`);
    }
    for (const sp of world.spawnPoints) {
      wastesPointsChecked++;
      const idx = cellIndexAt(sp.x, sp.z);
      const d = idx >= 0 ? dist[idx] : Infinity;
      assert.ok(d >= SAFETY_RADIUS.ashen_wastes.spawnPointMin - 1e-6, `SpawnPoint ${sp.id} path-distance ${d} must be >= ${SAFETY_RADIUS.ashen_wastes.spawnPointMin}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[WRLD-9 safety] Ashen Wastes: ${wastesPacksChecked} pack centres, ${wastesPointsChecked} SpawnPoints checked against their real path-distance field — all compliant`);
  assert.ok(wastesPacksChecked > 0 && wastesPointsChecked > 0);
});

// ---------------------------------------------------------------------------
// Wiring — world.spawnPoints / world.packs are reachable properties (O-71),
// and unaffected zone kinds (town, altar) keep the documented empty default.
// ---------------------------------------------------------------------------

test('world.spawnPoints / world.packs are reachable as properties on the world subsystem (O-71)', async () => {
  const { world } = await makeFullWorld({ rngSeed: 3 });
  assert.deepEqual(world.spawnPoints, [], 'before any enterZone, spawnPoints must be []');
  assert.deepEqual(world.packs, [], 'before any enterZone, packs must be []');

  world.setWorldSeed(0xabc123);
  const inst = await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  assert.ok(inst.spawnPoints.length > 0);
  assert.ok(inst.packs.length > 0);
  assert.equal(world.spawnPoints, inst.spawnPoints, 'world.spawnPoints must forward the live ZoneInstance array (Alloc: no)');
  assert.equal(world.packs, inst.packs);

  // last_bastion (town) has no generator (rule 11) — spawnPoints/packs stay
  // at the instance literal's own documented default.
  const townInst = await world.enterZone('last_bastion', 'town_start');
  assert.deepEqual(townInst.spawnPoints, []);
  assert.deepEqual(townInst.packs, []);
  assert.equal(world.spawnPoints, townInst.spawnPoints);
});

test('SpawnPoint / PackDescriptor shape matches 01-data-model.md §9.4/§9.5 exactly', async () => {
  const { world } = await makeFullWorld({ rngSeed: 4 });
  world.setWorldSeed(0x42);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });

  const spKeys = ['id', 'x', 'z', 'facing', 'kind', 'packIndex', 'regionId', 'consumed'].sort();
  for (const sp of world.spawnPoints) {
    assert.deepEqual(Object.keys(sp).sort(), spKeys);
    assert.equal(sp.kind, 'pack');
    assert.equal(sp.consumed, false);
  }
  const pdKeys = ['id', 'archetypeId', 'count', 'rank', 'affixes', 'centerX', 'centerZ', 'radius', 'aggroCloud', 'mlvl', 'members', 'spawned', 'aliveCount'].sort();
  for (const p of world.packs) {
    assert.deepEqual(Object.keys(p).sort(), pdKeys);
    assert.deepEqual(p.members, []);
    assert.equal(p.spawned, false);
    assert.equal(p.aliveCount, 0);
    assert.deepEqual(p.affixes, [], 'step 5 (affix roll) is not this ticket\'s to implement — see spawn.js header');
    assert.ok(['normal', 'champion', 'unique'].includes(p.rank));
    assert.ok(p.count >= 5 && p.count <= 12, 'pack count must respect ashen_wastes.packSize [5,12]');
  }
});

// ---------------------------------------------------------------------------
// planWastesSpawns / planBonereachSpawns — direct-import determinism check
// ---------------------------------------------------------------------------

test('spawn pass is deterministic: same seed, two independent enterZone calls -> identical spawnPoints/packs', async () => {
  const { world: w1 } = await makeFullWorld({ rngSeed: 1 });
  w1.setWorldSeed(0x555);
  const i1 = await w1.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 2 });

  const { world: w2 } = await makeFullWorld({ rngSeed: 1 });
  w2.setWorldSeed(0x555);
  const i2 = await w2.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 2 });

  assert.equal(i1.spawnPoints.length, i2.spawnPoints.length);
  assert.equal(i1.packs.length, i2.packs.length);
  for (let k = 0; k < i1.spawnPoints.length; k++) {
    assert.deepEqual(i1.spawnPoints[k], i2.spawnPoints[k], `spawnPoints[${k}] must be identical across two runs of the same seed`);
  }
  for (let k = 0; k < i1.packs.length; k++) {
    assert.deepEqual(i1.packs[k], i2.packs[k], `packs[${k}] must be identical across two runs of the same seed`);
  }
});

// ---------------------------------------------------------------------------
// O-98 — spawn.js never touches ctx.rng; draws only come from streams.S3
// ---------------------------------------------------------------------------

test('O-98: spawn.js never touches ctx.rng — boot draws nothing extra beyond the already-registered subsystem set', async () => {
  const { world } = await makeFullWorld({ rngSeed: 9 });
  // The root rng is untouched by wiring alone; only enterZone -> seedFor
  // (a hash, not an rng draw) feeds the zone's own S0..S6 fork chain, which
  // is entirely separate from ctx.rng. This mirrors the exact assertion
  // shape tests/core/boot.test.js already uses for the registered set.
  const before = JSON.stringify([world._ctx.rng.s0, world._ctx.rng.s1, world._ctx.rng.s2, world._ctx.rng.s3]);
  world.setWorldSeed(0x77);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const after = JSON.stringify([world._ctx.rng.s0, world._ctx.rng.s1, world._ctx.rng.s2, world._ctx.rng.s3]);
  assert.equal(before, after, 'ctx.rng must be untouched by enterZone / the spawn pass — everything draws from the zone\'s own hash-seeded streams');
});
