// tests/world/wrld6.test.js
//
// WRLD-6 acceptance tests — the Ashen Wastes dressing (R8) and boundary
// treatment (R9): `src/world/gen/wastes.js` (headless) and
// `src/world/build/wastes.js` (the `three` half). `node:test` +
// `node:assert/strict` only (12-testing.md P6). Any timing/allocation/frame
// assertion belongs in a `.perf.test.js` file instead (this ticket's own
// rule 9) — nothing here needs one: generation is `Alloc: yes`, "between
// frames" (07 §10.2 T6/T7), never a hot path.
//
// ---------------------------------------------------------------------------
// A real, measured finding: R8's own formula does not reach propBudget —
// round 2 diagnosis, per the coordinator's own D-79 request
// ---------------------------------------------------------------------------
// Criterion 3 asks for "prop count within 5% of descriptor.propBudget
// (900)" (855-945). Two questions, answered with numbers, not a guess:
//
// Q1 — total prop count including R9's OWN boundary instances (16 ridge-wall
// segments + 66 silhouette instances is typical), since `reservedBoundary
// (150)` in R8's formula is presumably budget set aside for exactly that:
//   `wastes_seed_a` (10/16 connected): 486 dressed + 16 wall + 66 silhouette
//     = 568 total = 63.1% of 900.
//   `wastes_seed_b` (14/16 connected): 638 dressed + 16 wall + 66 silhouette
//     = 720 total = 80.0% of 900.
//   16-seed sample average: 562.8 total = 62.5% of 900.
// Even counting EVERYTHING R9 places, neither seed nor the sample average
// reaches 855 (95% of 900). `reservedBoundary`'s own 150 is itself only
// ~1.8x a typical seed's real boundary instance count (~81), so even a
// "spend all of reservedBoundary on boundary content" reading does not
// close the gap on its own.
//
// Q2 — is a per-clause rejection breakdown (`rejectionStats`, added this
// round; see `runR8Dressing`) a bug (a walkable-mask regression from THIS
// ticket's own O-99 change) or a spec-density finding? Measured directly,
// aggregated over the 16-seed sample (12,588 total tries):
//   accepted 12.4%, spacing 80.0%, spawnDeny 5.0%, terraceInset 1.9%, gate 0.7%.
// `terraceInset` — the ONE clause O-99's `groundY`/terrace-real change could
// plausibly have inflated — is 1.9% of all tries, nowhere near dominant.
// `minSpacing` dominates overwhelmingly: R7's own per-cell prop targets
// (26-110 depending on archetype) are simply denser than `07` §9.2's
// `protoSpec.minSpacing` values (1.0-4.5 m) permit inside one 24x24 m cell
// once a handful of props have already claimed the ground — a real quota-
// vs-spacing mismatch in the generator's own numbers, not a defect this
// ticket introduced. The test below asserts BOTH findings as measured facts
// (not a false "within 5%" pass): total prop count (dressed + boundary)
// against 900, and that `terraceInset` rejection stays a small minority of
// all tries across the sample.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { generateRidgewalkLayout, placeRidgewalkEntries } from '../../src/world/gen/ridgewalk.js';
import {
  INSTANCING_GROUPS,
  PROTOTYPE_CATALOG,
  ARCHETYPE_PROTO_TABLE,
  RESERVED_BOUNDARY,
  MAX_RESIDENT_PROTOTYPES,
  SILHOUETTE_RING_MIN,
  runR8Dressing,
  runR9Boundary,
  toFootprints,
  buildInstancingPlan,
} from '../../src/world/gen/wastes.js';
import { buildWastesGeometry, buildAshBerm } from '../../src/world/build/wastes.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../../src/world/data/zones.js';
import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem, NAV_FLAG } from '../../src/nav/index.js';
import { createNavGrid, createRasterScratch, rasterizeNav, cellIndexAt } from '../../src/world/raster.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { WORLD_CAMERA_FOV } from '../../src/render/camera.js';
import { createConfig } from '../../src/core/config.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import { cellOf, cellCentre } from '../../src/world/gen/ridgewalk.js';

const DESCRIPTOR = ZONE_DESCRIPTORS_BY_ID.ashen_wastes;
const SAMPLE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 42, 777, 12345, 123456, 999999, 2026, 0xc7a123d4, 0xbfa1173c];

function generateAll(seed) {
  const layout = generateRidgewalkLayout(seed, DESCRIPTOR);
  const dress = runR8Dressing(layout, DESCRIPTOR, layout.streams);
  const boundary = runR9Boundary(layout, DESCRIPTOR, layout.streams);
  return { layout, dress, boundary };
}

/** A real `WorldSystem` + `PhysicsSystem` + `NavSystem` + `MaterialsSystem`,
 * a real `THREE.Scene` for `ctx.scene` — the same "wire real subsystems onto
 * one stub ctx" shape `tests/world/wrld4.test.js`'s own `makeWorldWithNav`
 * uses, extended with `materials`/`scene` so T7's geometry build actually
 * runs (never stubbed). `render` is a bare `{renderer: null}` — `materials
 * .get(key, {color})` (the plain-tinted path this ticket's `build/wastes.js`
 * uses) never calls `_renderer()`, so a real `THREE.WebGLRenderer` is not
 * needed for this suite (`materials.test.js`'s own documented degraded-path
 * precedent). */
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
// Criterion 1 — the catalogue: nine groups, forty-two prototypes
// ---------------------------------------------------------------------------

test('CRITERION 1: INSTANCING_GROUPS has exactly nine rows (07 §9.1)', () => {
  assert.equal(INSTANCING_GROUPS.length, 9);
  assert.deepEqual(INSTANCING_GROUPS.map((g) => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9']);
});

test('CRITERION 1: PROTOTYPE_CATALOG has exactly forty-two prototypes (07 §9.2)', () => {
  assert.equal(Object.keys(PROTOTYPE_CATALOG).length, 42);
});

test('every ARCHETYPE_PROTO_TABLE entry length matches R7\'s own "draw-call cost" column', () => {
  assert.equal(ARCHETYPE_PROTO_TABLE.ash_flats.length, 4);
  assert.equal(ARCHETYPE_PROTO_TABLE.dead_grove.length, 6);
  assert.equal(ARCHETYPE_PROTO_TABLE.ruin_field.length, 6);
  assert.equal(ARCHETYPE_PROTO_TABLE.bone_yard.length, 5);
  assert.equal(ARCHETYPE_PROTO_TABLE.ravine.length, 5);
  assert.equal(ARCHETYPE_PROTO_TABLE.warcamp.length, 7);
});

test('every G6 container prototype is used by at least one archetype (no unreachable prototype)', () => {
  const used = new Set(Object.values(ARCHETYPE_PROTO_TABLE).flat());
  for (const [id, spec] of Object.entries(PROTOTYPE_CATALOG)) {
    if (spec.group === 'G6') assert.ok(used.has(id), `${id} is never drawn from by any archetype`);
  }
});

// ---------------------------------------------------------------------------
// Determinism (rule 3 — no Math.random, draws from S1/S2/S6 only)
// ---------------------------------------------------------------------------

test('runR8Dressing + runR9Boundary are deterministic: the same seed produces byte-identical output twice', () => {
  const a = generateAll(0xabc123);
  const b = generateAll(0xabc123);
  assert.deepEqual(a.dress.props, b.dress.props);
  assert.deepEqual(a.boundary.ridgeWall, b.boundary.ridgeWall);
  assert.deepEqual(a.boundary.silhouette, b.boundary.silhouette);
});

test('two different seeds produce different layouts (the generator is not a constant)', () => {
  const a = generateAll(1);
  const b = generateAll(2);
  assert.notDeepEqual(a.dress.props, b.dress.props);
});

// ---------------------------------------------------------------------------
// R8 — spacing, gate exclusion, terrace inset, sixteen-tries-then-give-up
// ---------------------------------------------------------------------------

test('R8: every prop, AT PLACEMENT TIME, respects its own prototype\'s minSpacing against every EARLIER-placed prop', () => {
  // 07 §3.2 R8's own pseudocode: "reject if dist(p, nearest already-placed
  // prop) < protoSpec.minSpacing" — `protoSpec` is the CANDIDATE's own spec,
  // checked only against props placed BEFORE it. This is deliberately not a
  // symmetric, order-independent invariant: a later prop with a SMALLER
  // spacing may legally land closer to an earlier, larger-spacing prop than
  // that earlier prop's own spacing would have allowed for itself — `dress.
  // props` preserves placement order, so this test replays it faithfully
  // instead of asserting the stronger (and not-actually-promised) symmetric
  // property.
  for (const seed of SAMPLE_SEEDS) {
    const { dress } = generateAll(seed);
    for (let i = 0; i < dress.props.length; i++) {
      const p = dress.props[i];
      const minSpacing = PROTOTYPE_CATALOG[p.protoId].spacing;
      for (let j = 0; j < i; j++) {
        const q = dress.props[j];
        const d = Math.sqrt((p.x - q.x) ** 2 + (p.z - q.z) ** 2);
        assert.ok(d >= minSpacing - 1e-9, `seed ${seed}: prop ${i} (${p.protoId}) landed ${d.toFixed(3)}m from earlier prop ${j}, under its own ${minSpacing}m spacing`);
      }
    }
  }
});

test('R8: sixteen tries and give up — attempted count is always >= placedRaw (a miss never retries past 16)', () => {
  for (const seed of SAMPLE_SEEDS) {
    const { dress } = generateAll(seed);
    assert.ok(dress.attempted >= dress.placedRaw);
    assert.ok(dress.attempted <= dress.placedRaw * 16 || dress.placedRaw === 0);
  }
});

test('R8: PROTO_CAP — resident prototype count never exceeds 18, and firing is reported honestly', () => {
  let sawFire = false;
  for (const seed of SAMPLE_SEEDS) {
    const { dress } = generateAll(seed);
    const distinct = new Set(dress.props.map((p) => p.protoId));
    assert.ok(distinct.size <= MAX_RESIDENT_PROTOTYPES, `seed ${seed}: ${distinct.size} resident prototypes exceeds the cap`);
    if (dress.protoCapFired) {
      sawFire = true;
      assert.ok(dress.droppedPrototypes.length > 0);
      for (const id of dress.droppedPrototypes) assert.ok(!distinct.has(id), 'a dropped prototype must not remain resident');
    }
  }
  assert.ok(sawFire, 'PROTO_CAP is expected to fire on at least one of the sampled seeds (07 §3.4 documents it as a real, exercised path)');
});

// ---------------------------------------------------------------------------
// Criterion 3 — prop count vs. descriptor.propBudget: the real, measured
// finding (see this file's own header)
// ---------------------------------------------------------------------------

test('CRITERION 3 (measured, not forced): prop count never exceeds propBudget - reservedBoundary, and does NOT land within 5% of propBudget for the sampled seeds', () => {
  const withinFivePercent = [];
  for (const seed of SAMPLE_SEEDS) {
    const { dress } = generateAll(seed);
    assert.ok(dress.props.length <= DESCRIPTOR.propBudget - RESERVED_BOUNDARY, `seed ${seed}: ${dress.props.length} props exceeds the reserved-adjusted budget`);
    const pct = dress.props.length / DESCRIPTOR.propBudget;
    if (pct >= 0.95) withinFivePercent.push(seed);
  }
  // Documented finding, not a bug fix: with R8's literal formula, none of
  // the sampled seeds land within 5% of propBudget=900 — see this file's
  // header. If a future generator change makes this start passing, this
  // assertion should be replaced with a positive one; it is deliberately
  // an honest negative today.
  assert.equal(withinFivePercent.length, 0, 'if this starts failing, R8 is now reaching propBudget - update this test to assert the positive case');
});

test('CRITERION 3, question 1 (D-79): total prop count INCLUDING R9\'s own boundary instances (ridge wall + silhouette), against propBudget', () => {
  // Answers the coordinator's own question with numbers: even crediting
  // every ridge-wall segment and every silhouette instance toward the
  // "prop count" (the most generous reading of what `reservedBoundary`
  // might be for), the total still does not reach 855 (95% of 900) on the
  // sampled seeds.
  let totalAll = 0;
  let withinFivePercentTotal = 0;
  for (const seed of SAMPLE_SEEDS) {
    const { dress, boundary } = generateAll(seed);
    const total = dress.props.length + boundary.ridgeWall.length + boundary.silhouette.length;
    totalAll += total;
    if (total / DESCRIPTOR.propBudget >= 0.95) withinFivePercentTotal++;
    assert.ok(total < DESCRIPTOR.propBudget, `seed ${seed}: total ${total} (dressed+boundary) must stay under propBudget`);
  }
  const avgPct = totalAll / SAMPLE_SEEDS.length / DESCRIPTOR.propBudget;
  // eslint-disable-next-line no-console
  console.log(`[WRLD-6] total prop count (dressed + R9 boundary) averages ${(avgPct * 100).toFixed(1)}% of propBudget=900 over ${SAMPLE_SEEDS.length} seeds`);
  assert.equal(withinFivePercentTotal, 0, 'even counting R9 boundary instances, no sampled seed reaches within 5% of propBudget — a measured finding, not tuned toward');
});

test('CRITERION 3, question 2 (D-79): the dominant R8 rejection clause is minSpacing, NOT the O-99 walkable/terrace-inset check', () => {
  // Distinguishes "this ticket's O-99 change (real groundY / real terraces)
  // shrank the walkable area and that is why the prop count is low" (a real
  // defect, if true) from "the quota is simply denser than minSpacing
  // permits at 24x24 m" (a spec-density finding). Aggregated over the full
  // sample: terraceInset stays a small minority of all tries; minSpacing
  // dominates overwhelmingly.
  const agg = { terraceInset: 0, spacing: 0, gate: 0, spawnDeny: 0, accepted: 0 };
  for (const seed of SAMPLE_SEEDS) {
    const { dress } = generateAll(seed);
    for (const key of Object.keys(agg)) agg[key] += dress.rejectionStats[key];
  }
  const totalTries = Object.values(agg).reduce((a, b) => a + b, 0);
  const pct = (key) => agg[key] / totalTries;
  // eslint-disable-next-line no-console
  console.log('[WRLD-6] R8 rejection breakdown over', SAMPLE_SEEDS.length, 'seeds:', Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, `${(v / totalTries * 100).toFixed(1)}%`])));

  assert.ok(pct('terraceInset') < 0.10, `terraceInset rejection ${(pct('terraceInset') * 100).toFixed(1)}% must stay a small minority — a large share here would mean O-99's real groundY/terraces shrank the walkable area, which is NOT what is measured`);
  assert.ok(pct('spacing') > pct('terraceInset') + pct('gate') + pct('spawnDeny'), 'minSpacing must be the dominant rejection clause, not the walkable/gate/spawnDeny checks combined');
});

// ---------------------------------------------------------------------------
// Criterion 2 — draw calls <= 27, triangles <= 320000 (measured, headless:
// three.js's pure-JS object model works under plain Node — no WebGL needed
// to build InstancedMesh/BufferGeometry and count them)
// ---------------------------------------------------------------------------

test('CRITERION 2: draw calls <= 27 and budgeted triangles <= 320000 across sampled seeds', () => {
  for (const seed of SAMPLE_SEEDS) {
    const { dress, boundary } = generateAll(seed);
    const plan = buildInstancingPlan(dress.props, boundary.ridgeWall, boundary.silhouette);
    const drawCallsFromProps = plan.length;
    const ashBermDrawCall = boundary.berm.length > 0 ? 1 : 0;
    const totalDrawCalls = drawCallsFromProps + ashBermDrawCall;
    const budgetedTriangles = plan.reduce((sum, b) => sum + b.tris * b.instances.length, 0);

    assert.ok(totalDrawCalls <= 27, `seed ${seed}: ${totalDrawCalls} draw calls exceeds 27`);
    assert.ok(budgetedTriangles <= 320000, `seed ${seed}: ${budgetedTriangles} triangles exceeds 320000`);
    // Rule 12 — "a harness meeting a budget by doing less work does not
    // pass": a real, non-trivial amount of geometry must actually exist.
    assert.ok(totalDrawCalls >= 3, `seed ${seed}: only ${totalDrawCalls} draw calls — suspiciously little geometry`);
    assert.ok(budgetedTriangles >= 10000, `seed ${seed}: only ${budgetedTriangles} triangles — suspiciously little geometry`);
  }
});

test('CRITERION 2 (real geometry, headless three.js): buildWastesGeometry produces the same draw-call count as the plan', async () => {
  const { world, ctx } = await makeFullWorld();
  const inst = await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  assert.equal(inst.zoneId, 'ashen_wastes');
  const result = world._wastesGeometryResult;
  assert.ok(result, 'T7 geometry build must have run for ashen_wastes with a real scene+materials');
  assert.ok(result.drawCalls + 1 <= 27, 'meshes + the ash berm mesh must stay within the 27 draw-call budget'); // +1 = buildAshBerm's own separate mesh
  assert.ok(result.budgetedTriangles <= 320000);
  assert.equal(ctx.scene.children.length, 1, 'exactly one wastes_dressing group is added to the scene');
});

// ---------------------------------------------------------------------------
// Criterion 4 — I9: the world edge is never visible (a camera-frustum
// property, verified from the REAL rig config — camPitch/camDist/FOV — not
// hardcoded against the spec's own prose numbers)
// ---------------------------------------------------------------------------

test('CRITERION 4 (I9): the camera\'s farthest visible ground point from any walkable position stays short of the silhouette ring', () => {
  const config = createConfig();
  const halfFovRad = (WORLD_CAMERA_FOV / 2) * (Math.PI / 180);
  const pitchRad = config.camPitch * (Math.PI / 180);
  const cameraHeight = config.camDist * Math.sin(pitchRad);
  const cameraSetback = config.camDist * Math.cos(pitchRad);

  // Farthest ground point the TOP screen edge shows, measured from the
  // camera's own foot point (directly below it) — the shallower angle,
  // pitch - halfFov, is what reaches furthest.
  const farAngle = pitchRad - halfFovRad;
  const farFromCameraFoot = cameraHeight / Math.tan(farAngle);
  const farAheadOfPlayer = farFromCameraFoot - cameraSetback;

  // Sanity check against 07 §3.2 R9's own stated arithmetic (25.22 m ahead
  // of the camera, 11.68 m ahead of the player) — reproduced, not trusted
  // blindly (this is the point of a "camera-frustum property" test).
  assert.ok(Math.abs(farFromCameraFoot - 25.22) < 0.05, `farFromCameraFoot=${farFromCameraFoot.toFixed(3)}, expected ~25.22`);
  assert.ok(Math.abs(farAheadOfPlayer - 11.68) < 0.05, `farAheadOfPlayer=${farAheadOfPlayer.toFixed(3)}, expected ~11.68`);

  const maxWalkableRadius = DESCRIPTOR.sizeX / 2; // 48 m — 07 §3.2 R9's own stated bound
  const worstCaseVisibleReach = maxWalkableRadius + farAheadOfPlayer; // ~59.7 m

  assert.ok(
    worstCaseVisibleReach < SILHOUETTE_RING_MIN,
    `worst-case visible reach ${worstCaseVisibleReach.toFixed(2)}m must stay short of the silhouette ring's own inner radius ${SILHOUETTE_RING_MIN}m`,
  );
});

test('CRITERION 4 (I9): every connected-to-void / connected-to-outside edge gets a ridge wall, and none sits on a gated edge', () => {
  for (const seed of SAMPLE_SEEDS) {
    const { layout, boundary } = generateAll(seed);
    // Count expected wall edges directly from the grid, independent of
    // runR9Boundary's own internals.
    let expectedWalls = 0;
    for (const cell of layout.connected) {
      const { cx, cz } = cellOf(cell);
      const neighbours = [
        [cx, cz + 1], [cx, cz - 1], [cx + 1, cz], [cx - 1, cz],
      ];
      for (const [ncx, ncz] of neighbours) {
        const outOfGrid = ncx < 0 || ncx > 3 || ncz < 0 || ncz > 3;
        const neighbourConnected = !outOfGrid && layout.connectedFlag[ncz * 4 + ncx];
        if (outOfGrid || !neighbourConnected) expectedWalls++;
      }
    }
    assert.equal(boundary.ridgeWall.length, expectedWalls, `seed ${seed}: ridge wall count mismatch`);
  }
});

// ---------------------------------------------------------------------------
// Criterion 6 — O-99: NavGrid.groundY populated, passN3Slope actually
// running, a ravine lip genuinely blocks a scripted agent
// ---------------------------------------------------------------------------

test('CRITERION 6 (O-99): ZoneInstance.nav.groundY is populated (not the permanent all-zero array) after a real enterZone', async () => {
  const { world } = await makeFullWorld();
  const inst = await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  assert.ok(inst.nav, 'world must populate ZoneInstance.nav (was always null before this ticket)');
  assert.ok(inst.nav.groundY instanceof Float32Array);
  let sawNonZero = false;
  for (let i = 0; i < inst.nav.groundY.length; i++) {
    if (inst.nav.groundY[i] !== 0) { sawNonZero = true; break; }
  }
  assert.ok(sawNonZero, 'a zone with a real ravine/shelf terrace must have at least one non-zero groundY sample');
});

test('CRITERION 6 (O-99): a scripted agent is blocked at a real ravine lip — passN3Slope actually runs, not a permanent no-op (isolated from prop/wall confounds)', async () => {
  // runIndex 0 (world seed 0xc7a123d4 — the same seed `wastes_seed_a` uses)
  // is confirmed (by direct inspection) to produce a ravine cell at macro
  // index 11. This is the honest, literal "walk a scripted agent to a
  // ravine lip and show it is blocked" proof this ticket's brief asks for
  // — not merely `groundY[0] !== 0`.
  //
  // ISOLATION, and why: cell 11 sits on the outer ring of the 4x4 grid, so
  // its own east edge also carries a ridge-wall footprint (R9), and R8's
  // dressing can legally place a `navBlock` prop anywhere in the cell —
  // both would ALSO set `NAV_FLAG.blocked`, confounding a raw `nav.
  // walkable()`/`nav.flagsAt()` scan (verified directly: scanning through
  // real `world`/`nav` state finds blocked cells even after zeroing
  // `groundY`, because the wall/props are still there). To isolate the ONE
  // mechanism this ticket's O-99 fix is actually about, this test re-runs
  // `src/world/raster.js`'s own `rasterizeNav` directly against `world`'s
  // real, populated `instance.nav.groundY` (not a synthetic one) WITH NO
  // FOOTPRINTS AT ALL — proving the height-field-driven slope block in
  // isolation, then re-running the identical call with `groundY` zeroed
  // (the exact pre-fix state: `nav: null` always meant `heightField: null`,
  // `passN3Slope`'s own documented no-op input) to show blocking vanishes
  // without it. This is still `world`'s real, generator-derived elevation
  // data (`layout.terraces`, WRLD-5's actual -2.20 m ravine) run through
  // `nav`'s real rasteriser — nothing here is synthetic except the
  // DELIBERATE removal of props/walls to isolate the claim.
  const { world } = await makeFullWorld();
  const inst = await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const layout = world._wastesLayout;

  let ravineCell = -1;
  for (const cell of layout.connected) {
    if (layout.elevationOf[cell] < -1) { ravineCell = cell; break; }
  }
  assert.notEqual(ravineCell, -1, 'this fixed seed is expected to produce a ravine cell (verified by direct inspection)');

  const { cx, cz } = cellOf(ravineCell);
  const centre = cellCentre(DESCRIPTOR, cx, cz);

  function rasterizeIsolated(heightField) {
    const grid = createNavGrid({ width: inst.nav.width, height: inst.nav.height, originX: inst.nav.originX, originZ: inst.nav.originZ, cellSize: inst.nav.cellSize });
    const scratch = createRasterScratch(inst.nav.width, inst.nav.height);
    rasterizeNav(grid, scratch, { footprints: [], heightField });
    return grid;
  }
  function isBlocked(grid, x, z) {
    return !!(grid.flags[cellIndexAt(grid, x, z)] & NAV_FLAG.blocked);
  }

  const withFix = rasterizeIsolated(inst.nav.groundY);
  let sawWalkableFloor = false;
  let sawBlockedLip = false;
  for (let dx = 0; dx <= 11.9; dx += 0.25) {
    const x = centre.x + dx, z = centre.z;
    const blocked = isBlocked(withFix, x, z);
    if (!blocked && dx < 9) sawWalkableFloor = true;
    if (blocked && dx >= 9.5) sawBlockedLip = true;
  }
  assert.ok(sawWalkableFloor, 'the ravine floor itself must not be slope-blocked');
  assert.ok(sawBlockedLip, "the ravine's own lip (N3's slope check, |delta height| > 0.45m) must block the higher cell — passN3Slope is not a no-op");

  // The pre-fix state: `groundY` all zero (what `nav: null` always produced
  // before this ticket) — no elevation delta anywhere, so N3 CANNOT block
  // anything, by its own documented no-op contract.
  const zeroed = new Float32Array(inst.nav.groundY.length);
  const withoutFix = rasterizeIsolated(zeroed);
  let anyBlockedWithoutFix = false;
  for (let dx = 0; dx <= 11.9; dx += 0.25) {
    if (isBlocked(withoutFix, centre.x + dx, centre.z)) { anyBlockedWithoutFix = true; break; }
  }
  assert.equal(anyBlockedWithoutFix, false, 'with a zeroed groundY (the pre-fix state), N3 slope blocking cannot occur anywhere along this scan');
});

// ---------------------------------------------------------------------------
// toFootprints / buildInstancingPlan — plain data shape checks
// ---------------------------------------------------------------------------

test('toFootprints: only block:true prototypes emit a Footprint; ridge wall footprints are always included', () => {
  const { dress, boundary } = generateAll(5);
  const footprints = toFootprints(dress.props, boundary.ridgeWall);
  const propFootprintCount = footprints.length - boundary.ridgeWall.length;
  const expectedBlocking = dress.props.filter((p) => PROTOTYPE_CATALOG[p.protoId].block).length;
  assert.equal(propFootprintCount, expectedBlocking);
  for (const fp of footprints) {
    assert.ok(fp.blocksNav === true);
    assert.ok(['box', 'cylinder'].includes(fp.kind));
  }
});

test('buildAshBerm builds exactly one mesh when berm segments exist, null otherwise', () => {
  const group = new THREE.Group();
  const mesh = buildAshBerm({ get: () => ({ get: () => new THREE.MeshBasicMaterial() }) }, group, [{ x: 0, z: 48, halfW: 12, halfL: 3, topY: 3 }]);
  assert.ok(mesh instanceof THREE.Mesh);
  assert.equal(group.children.length, 1);
  const none = buildAshBerm({ get: () => ({ get: () => new THREE.MeshBasicMaterial() }) }, new THREE.Group(), []);
  assert.equal(none, null);
});
