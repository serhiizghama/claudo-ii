#!/usr/bin/env node
// tools/mapgen.mjs
//
// TEST-9 — the M5 map-generation validation harness, `07-world-gen.md` §7.1's
// nine invariants `I1`-`I9` plus §7.1's two warnings `W1`/`W2`, swept over
// every layout the tree can actually generate.
//
// ---------------------------------------------------------------------------
// O-106 — this file drives the REAL pipeline, not a lookalike
// ---------------------------------------------------------------------------
// WRLD-7 was accepted on a harness "in the exact shape of the real pipeline"
// that reported `regionCount === 1` on 600/600; the orchestrator's own probe
// through `world.setWorldSeed()` -> `world.enterZone()` -> `nav.grid` got
// 56/60, because the lookalike never built a heightfield and so never ran
// `passN3Slope`, the pass that was breaking the grid. A harness shaped like
// the pipeline is not the pipeline.
//
// Every number this file prints therefore comes from exactly one call chain,
// and it is named here so a reader never has to guess:
//
//   world.setWorldSeed(worldSeed)
//   await world.enterZone(zoneId, entryTag, { runIndex })
//   -> nav.grid            (flags / region / regionCount / groundY)
//   -> world.entry(tag)    (I1)
//   -> world.current.chests(I2)
//   -> world.packs / world.spawnPoints / world._spawnReport  (I3, I4)
//   -> world.staticFootprints (I6, I8)
//   -> nav.regionAt / nav.walkable  (I5)
//   -> world._altarLayout   (I5's boss start, exit portal pad and anchor
//                            tables; I7's pillar centres — all read off the
//                            layout `enterZone` actually published, never
//                            re-imported as constants)
//   -> world._wastesBoundary / _wastesLayout / _bonereachLayout / _bonereachExit
//
// Nothing below re-implements a generator stage, a rasteriser pass or a
// spawn solve. The one place this file rasterises anything itself is `I6`'s
// second flood fill, which is `src/world/raster.js#rasterizeNav` — the
// shipped function `nav.rebuild()` itself calls — re-run on a footprint list
// with the destructibles removed. That is disclosed at the check.
//
// ---------------------------------------------------------------------------
// Consequence: this file imports `three`, and `07` §7.2 says it must not
// ---------------------------------------------------------------------------
// `07` §7.2 requires "No browser, no `three`, no DOM... `src/world/build/*.js`,
// which is the only part that touches `three`, is never imported."
// `src/world/index.js` imports `./build/wastes.js` and `./build/bonereach.js`
// unconditionally at module scope, so `world.enterZone` cannot be reached
// without `three` in the module graph. O-106's rule and §7.2's rule are in
// direct conflict and only one of them can be satisfied; O-106 is the one
// that was paid for in bugs, so it wins here and §7.2's constraint is
// reported as a finding rather than honoured by building a second lookalike.
// `three` runs headless in Node (no renderer, no GPU, no DOM) exactly as
// `tests/world/wrld7.test.js` and `wrld9.test.js` already do.
//
// ---------------------------------------------------------------------------
// Ruling D-48 — follow the shipped tools, not `12` §5.1's prose
// ---------------------------------------------------------------------------
// `tools/lootsim.mjs` and `tools/balance.mjs` are the two accepted harnesses
// and they diverge from `12` §5.1's "common CLI contract" in the same four
// ways, which survived two gates. This file copies them:
//   - `=`-form flags (`--seed=0x…`, `--zones=…`, `--seeds=200`)
//   - `--json` is a BOOLEAN SWITCH printing to stdout, not a path
//   - exit `0` all pass / `1` an invariant failed / `2` could not run or a
//     bad flag / `3` non-determinism between two runs at one seed
//   - ONE flat `checks[]` array of `{id, severity, scope, status, lines}`
//     that both the human report and `--json` render from
//   - `NOTE`/`SKIP` findings are counted and printed loudly and NEVER change
//     the exit code (O-58's precedent: a coverage list that quietly lost a
//     method read as full while it was not).
//
// ---------------------------------------------------------------------------
// The sweep size: 1 800 layouts, not 5 400
// ---------------------------------------------------------------------------
// `12` §5.5 says "5 400 layouts — three zones x 200 world seeds x three run
// indices". 3 x 200 x 3 = 1 800. The missing factor of three is `07` §7.1's
// own preamble, "for every generated zone and every difficulty tier", and
// §7.2's "600 layouts per zone per difficulty" — i.e. 5 400 = 3 zones x 200
// seeds x 3 runIndex x 3 tiers.
//
// There is no difficulty-tier system in the tree (`AI-11`, milestone M6 —
// finding O-97 in `docs/PROGRESS.md`: `difficultyMult` has nowhere to live
// because an actor carries no tier field). `world.enterZone`'s `difficulty`
// option exists and defaults to `'instruction'`, and `src/world/spawn.js`'s
// `DIFFICULTY_MLVL_OFFSET`/`tierDensityMul` read it, but nothing selects a
// tier and no tier is reachable from a run. Inventing one is out of scope, so
// `--difficulty=` exits 2 naming its owning ticket rather than faking a 3x.
//
// All three zones are built (`WRLD-8` landed `src/world/gen/altar.js`), so
// this file runs 3 x 200 x 3 = **1 800 layouts**. Both the run header and the
// `--json` body derive that arithmetic from `zoneIsBuilt()` — the same
// filesystem probe `ZONE_PLAN` uses — so the accounting line can never
// disagree with what was actually swept. If a generator file is removed the
// header re-states the reduced product and the missing zone's invariants come
// back as loud counted SKIPs; nothing about the accounting is a literal.
//
// ---------------------------------------------------------------------------
// The seven rulings that SCOPE the invariants (read them, do not re-litigate)
// ---------------------------------------------------------------------------
// D-77  `|connected| in [9,14]` is a DISTRIBUTION property, not an
//       invariant; 100% is unreachable (structural range is [6,16]). It is
//       not one of `I1`-`I9`, so this file reports the measured histogram as
//       a NOTE and asserts nothing.
// D-80  "prop count within 5% of propBudget" is unreachable — `07` R7's
//       props/cell and §9.2's minSpacing are mutually incompatible, and R8's
//       own `reservedBoundary(150)` caps dressing at 83.3% of the budget
//       before any rejection. `propBudget` reads as a CEILING. This file
//       asserts `props <= propBudget` and PRINTS the achieved fraction.
// D-82  `targetRooms in [12,18]` is unreachable above 16 (the true BSP leaf
//       ceiling for root=108/MIN_LEAF=22 is 16, not §4.2 B2's claimed 24).
//       `layout.targetRooms` is the ACHIEVED count; this file asserts
//       `|rooms| === targetRooms` and prints the achieved histogram.
// D-83  `I8` is structurally impossible inside Bonereach rooms: `I8` needs
//       `s >= (topY - 1.00) / 1.206` of clearance south of a wall, and
//       Bonereach rooms are 8-18 m deep. At B3's own 5.0 m walls that is
//       3.32 m and 18-41% of every room's floor violates it by construction;
//       the SHIPPED `toFootprints` emits rock pieces at topY 8.0 m, which
//       moves the bound to 5.80 m and makes it worse. `I8` is marked
//       "Applies to: all", so this file implements it honestly everywhere and
//       reports Bonereach as a LOUD COUNTED NOTE carrying the measured
//       violating fraction — never a silent pass, never a weakened threshold.
//       D-83's own remedy (exclude `NAV_FLAG.interior` cells) is ALSO
//       measured and printed, and it is currently a no-op: `nav.rebuild()`
//       passes `groundRegions: null`, so no cell is ever flagged `interior`
//       through the real pipeline. That count is printed, not assumed.
// D-84  `I4` on `ashen_wastes` is unreachable in ANY band while the
//       descriptor's own floor binds (`packCount.min 9 x packSize.min 5 = 45`
//       monsters needs `>= 45 / 0.0125 = 3 600 m2` of ENTRY-REGION area, which
//       the generator does not guarantee). Accepted criterion, implemented
//       verbatim below: check `I4` only where the floor is satisfiable
//       (`densityTarget x entryArea >= packCount.min x packSize.min`), hold
//       it there in `I4`'s own native +-20% band, and print EVERY
//       floor-bound layout in a separate list tagged `FLOOR-CLAMPED` with its
//       achieved density. Bonereach stays at its own band and 600/600.
// D-90  `I8` on `altar_of_instruction` is a counted NOTE, not a FAIL. `07`
//       §5.3's guarantee **G6** ("Cover and line of sight") spends three
//       bullets ACCEPTING the occlusion: "The six pillars are ... 0.90 m
//       radius, 7.0 m tall ... Against the Occlusion Plane at `s = 0` they
//       are far over 1.00 m, so a pillar *does* occlude a player standing
//       immediately north of it. **That is accepted and deliberate**", and it
//       sizes the band itself — `s <= (7.0 - 1.0) / 1.206 = 4.98 m`, "six of
//       them, 53.9 m2 total = 5.9 % of the arena", floor-marked with an
//       authored scorch decal so it is not a surprise. The occlusion is
//       DESIGNED. Treated exactly as Bonereach is under D-83: honest
//       measurement, threshold untouched, loud counted NOTE carrying the
//       measured fraction and G6's own arithmetic beside it. The `wastes`
//       `I8` stays a FAIL — nothing in `07` licenses that one.
// D-91  `I7`'s literal band `114 +- 6` is unreachable by the SHIPPED
//       geometry, which measures **96** blocked cells on 600/600. §5.4
//       derives 114 as `6 x ceil(pi * (0.9 + 0.3)^2 / 0.25) = 6 x 19`, an
//       AREA estimate; `passN4FootprintStamp` blocks a cell when its CENTRE
//       falls within `radius + dilation`, and cell-centre sampling of a
//       r = 1.20 m disc yields 16..21 cells depending on the phase of the
//       centre against the lattice. The six spec-mandated pillar bearings
//       (r = 11.5 m at 0/60/…/300 degrees) all land in the 16-cell alignment
//       on a grid whose centres are odd multiples of 0.25 m, so 6 x 16 = 96,
//       deterministically. So `I7` is implemented as its INTENT — §5.4's own
//       "the only blockers inside `r = 17.0 m` are the six pillars": every
//       blocked cell inside `r = 16.0 m` must be attributable to a pillar
//       under the stamp's own rule, and all six pillars must actually be
//       present. That is ASSERTED. The literal `114 +- 6` shortfall is
//       carried beside it as a counted NOTE with the measured number and the
//       arithmetic — never asserted (the shipped geometry cannot produce it)
//       and never silently dropped.
//
// ---------------------------------------------------------------------------
// Determinism (`12.D02`, `ARCHITECTURE.md` rule 4)
// ---------------------------------------------------------------------------
// No `Math.random()` anywhere in this file, and nothing reads the wall clock
// into a result: `process.hrtime.bigint()` is read only to print a duration,
// which `--json` emits under `seconds` and which the determinism comparison
// in `tests/tools/mapgen.test.js` explicitly excludes. Every layout carries
// an FNV-1a-64 hash over its own grid + geometry + placements, and the run
// carries an aggregate `layoutHash` folded from them in sweep order.
// `12.D02` is additionally checked INSIDE this tool: the pinned fixture
// seeds of `07` §7.4 are each generated twice and their hashes compared, and
// a mismatch exits **3**, not 1 — a determinism break invalidates every other
// number in the same run (`12` §5.1's own reasoning for keeping 3 separate).

import * as THREE from 'three';

import { WorldSystem } from '../src/world/index.js';
import { PhysicsSystem } from '../src/physics/index.js';
import { NavSystem } from '../src/nav/index.js';
import { MaterialsSystem } from '../src/materials/index.js';
import { Rng } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../src/world/data/zones.js';
import { NAV_FLAG, RASTER, createNavGrid, createRasterScratch, rasterizeNav, cellIndexAt } from '../src/world/raster.js';

// ---------------------------------------------------------------------------
// Constants — every one of them quoted from a spec line, none invented
// ---------------------------------------------------------------------------

/** `07` §7.2, verbatim: `worldSeed = 0x1F3AC09B + i` for `i in 0..199`. */
const DEFAULT_BASE_SEED = 0x1f3ac09b;
/** `07` §7.2: `--seeds 200`. */
const DEFAULT_SEED_COUNT = 200;
/** `07` §7.2: "`runIndex` is swept `0..2`". */
const DEFAULT_RUN_COUNT = 3;

/** `07` §7.1 I8 / §7.3 — the occlusion plane's own three numbers. */
const I8_EYE_HEIGHT = 1.00;
const I8_SLOPE = 1.206;
const I8_WINDOW_DEPTH = 13.545;
const I8_HALF_WIDTH = 1.2;

/** `07` §7.3 I9 — the camera trapezoid's own three numbers. */
const I9_FAR_DEPTH = 11.68;
const I9_FAR_HALF_WIDTH = 17.16;
const I9_INTERIOR_MARGIN = 2.0;

/** `07` §7.1 I4 — "within +-20 % of target". */
const I4_BAND = 0.20;
/** D-84 point 3 — Bonereach's own tighter WRLD-9 band, reported alongside. */
const I4_TIGHT_BAND = 0.02;

/** `07` §7.1 W1/W2 thresholds, verbatim. */
const W1_THRESHOLD = 0.02;
const W2_THRESHOLD = 0.001;

/** `07` §7.4's eleven pinned fixture seeds. `'all'` means the seed is pinned
 * for every zone that exists. These always run regardless of `--seeds`, and
 * each is generated TWICE for `12.D02`. */
const FIXTURE_SEEDS = Object.freeze([
  Object.freeze({ seed: 0x00000b27, zone: 'ashen_wastes', exercises: 'R1 forced-fallback exit column' }),
  Object.freeze({ seed: 0x1d40c6a2, zone: 'ashen_wastes', exercises: 'PROTO_CAP prototype-cap trim' }),
  Object.freeze({ seed: 0x4b90117e, zone: 'ashen_wastes', exercises: 'R2 backtracking >= 3 deep' }),
  Object.freeze({ seed: 0x77c1a030, zone: 'ashen_wastes', exercises: 'maximum connected = 14 cells' }),
  Object.freeze({ seed: 0xa0031c55, zone: 'ashen_wastes', exercises: 'minimum connected = 9 cells' }),
  Object.freeze({ seed: 0xc17f2200, zone: 'ashen_wastes', exercises: 'two warcamp cells adjacent on the spine' }),
  Object.freeze({ seed: 0x2c71e004, zone: 'bonereach', exercises: '15 rooms, flooded room on the critical path' }),
  Object.freeze({ seed: 0x9e44b071, zone: 'bonereach', exercises: 'targetRooms = 12 (minimum) with 4 vaults' }),
  Object.freeze({ seed: 0xe0a73318, zone: 'bonereach', exercises: 'targetRooms = 18 (maximum); prop budget clamp fires' }),
  Object.freeze({ seed: 0x5512c88d, zone: 'bonereach', exercises: 'B6 corridor re-route on >= 3 corridors' }),
  Object.freeze({ seed: 0x00000001, zone: 'all', exercises: 'the trivial seed' }),
]);

/** The three zones `07` §7.1/§7.2 sweep, and what exists behind each.
 *
 * `built` is resolved from the filesystem, never hardcoded. The first cut of
 * this file pinned `altar_of_instruction` to `built: false` because
 * `src/world/gen/altar.js` did not exist when it was written — and it kept
 * reporting SKIP for three altar invariants after WRLD-8 landed them. A
 * harness that snapshots what exists is the same defect class as O-106: it
 * was not measuring the tree, it was quoting a moment. Ask the disk. */
import { existsSync } from 'node:fs';
const ZONE_GENERATOR_FILES = Object.freeze({
  ashen_wastes: ['src/world/gen/ridgewalk.js', 'src/world/gen/wastes.js'],
  bonereach: ['src/world/gen/bonereach.js'],
  altar_of_instruction: ['src/world/gen/altar.js'],
});
function zoneIsBuilt(zoneId) {
  const files = ZONE_GENERATOR_FILES[zoneId] || [];
  return files.length > 0 && files.every((f) => existsSync(new URL(`../${f}`, import.meta.url)));
}
const ZONE_PLAN = Object.freeze([
  Object.freeze({ id: 'ashen_wastes', entryTag: 'portal_from_town', built: zoneIsBuilt('ashen_wastes'), generator: 'src/world/gen/ridgewalk.js + wastes.js' }),
  Object.freeze({ id: 'bonereach', entryTag: 'descent', built: zoneIsBuilt('bonereach'), generator: 'src/world/gen/bonereach.js' }),
  Object.freeze({ id: 'altar_of_instruction', entryTag: 'altar_entry', built: zoneIsBuilt('altar_of_instruction'), generator: 'src/world/gen/altar.js (WRLD-8)' }),
]);

// ---------------------------------------------------------------------------
// FNV-1a 64 — the layout hash (12.D02)
// ---------------------------------------------------------------------------
// BigInt-free: two 32-bit halves, mixed the standard way. Values are folded
// as bytes, so a Float64 goes in through a shared 8-byte view — no string
// formatting anywhere in the hot path, and no locale/precision dependence.

const HASH_SCRATCH = new ArrayBuffer(8);
const HASH_F64 = new Float64Array(HASH_SCRATCH);
const HASH_BYTES = new Uint8Array(HASH_SCRATCH);

function newHash() {
  return { lo: 0x84222325 >>> 0, hi: 0xcbf29ce4 >>> 0 };
}

function hashByte(h, b) {
  // Integer-exact throughout (`Math.imul` + `>>> 0`), so the result is the
  // same on every platform and every run — the whole point of `12.D02`.
  h.lo = Math.imul((h.lo ^ (b & 0xff)) >>> 0, 0x01000193) >>> 0;
  h.hi = Math.imul((h.hi ^ h.lo) >>> 0, 0x85ebca6b) >>> 0;
  h.hi = (h.hi ^ (h.hi >>> 13)) >>> 0;
  return h;
}

function hashNumber(h, v) {
  HASH_F64[0] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  for (let i = 0; i < 8; i++) hashByte(h, HASH_BYTES[i]);
  return h;
}

function hashString(h, s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    hashByte(h, c & 0xff);
    hashByte(h, (c >>> 8) & 0xff);
  }
  return h;
}

function hashTypedArray(h, arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < bytes.length; i++) hashByte(h, bytes[i]);
  return h;
}

function hashHex(h) {
  return (h.hi >>> 0).toString(16).padStart(8, '0') + (h.lo >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// The real engine, booted headless — the ONLY way a layout is produced here
// ---------------------------------------------------------------------------
// Deliberately NOT `tests/helpers/actor.js#makeStubCtx`: `tools/` must not
// depend on `tests/`. The ctx below is the same shape that helper builds
// (`ARCHITECTURE.md`'s own ctx list), with `time.step` frozen at 0 — nothing
// in `enterZone` advances or reads a clock, and freezing it keeps the run
// reproducible by construction rather than by luck.

function makeCtx(scene, systems) {
  const map = new Map(Object.entries(systems));
  return {
    scene,
    camera: null,
    uiScene: null,
    uiCamera: null,
    canvas: null,
    input: null,
    config: {},
    events: new EventBus(),
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    // `ARCHITECTURE.md` rule 4 — a seeded `Rng`, never `Math.random()`. No
    // generator actually draws from `ctx.rng` (every zone stream is forked
    // from `world.seedFor(zoneId, runIndex)`), but the field must exist and
    // must be seeded.
    rng: new Rng(1),
    get(id) {
      if (!map.has(id)) throw new Error(`mapgen ctx.get: '${id}' is not registered`);
      return map.get(id);
    },
    peek(id) { return map.get(id); },
    has(id) { return map.has(id); },
  };
}

/**
 * A fresh engine per layout — the same discipline `tests/world/wrld7.test.js`
 * and `wrld9.test.js` use for their own REAL PIPELINE sweeps. Re-entering a
 * zone on a reused `WorldSystem` is legal, but a fresh instance is what those
 * two suites measured, and matching them exactly is worth more here than the
 * ~4 ms it costs.
 * @param {boolean} withGeometry build the `three` half too (T7)?
 */
async function bootEngine(withGeometry) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const systems = { world, physics, nav, render: { renderer: null } };
  let scene = null;
  if (withGeometry) {
    const materials = new MaterialsSystem();
    systems.materials = materials;
    scene = new THREE.Scene();
  }
  const ctx = makeCtx(scene, systems);
  await physics.init(ctx);
  if (withGeometry) await systems.materials.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  return { world, physics, nav, ctx };
}

// ---------------------------------------------------------------------------
// Footprint geometry helpers — AABB and north face, for I8/I6/I9
// ---------------------------------------------------------------------------

/** World-space AABB of a `Footprint` (`02-api-contracts.md` §4 shape), plus
 * its `topY`. Boxes are rotated by `facing` and the AABB is taken over the
 * four rotated corners — conservative and correct for any angle, which the
 * wastes dressing pass really does produce. */
function footprintBox(fp) {
  const topY = (fp.y || 0) + (fp.height || 0);
  if (fp.kind === 'cylinder' || fp.kind === 'disc') {
    const r = fp.radius || 0;
    return { minX: fp.x - r, maxX: fp.x + r, minZ: fp.z - r, maxZ: fp.z + r, topY };
  }
  if (fp.kind === 'poly' && Array.isArray(fp.points) && fp.points.length >= 2) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i + 1 < fp.points.length; i += 2) {
      const px = fp.points[i], pz = fp.points[i + 1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
    return { minX, maxX, minZ, maxZ, topY };
  }
  const hw = fp.halfW || 0, hl = fp.halfL || 0;
  const c = Math.cos(fp.facing || 0), s = Math.sin(fp.facing || 0);
  const ex = Math.abs(hw * c) + Math.abs(hl * s);
  const ez = Math.abs(hw * s) + Math.abs(hl * c);
  return { minX: fp.x - ex, maxX: fp.x + ex, minZ: fp.z - ez, maxZ: fp.z + ez, topY };
}

// ---------------------------------------------------------------------------
// I8 — the Occlusion Plane Rule, `07` §7.1 / §7.3
// ---------------------------------------------------------------------------
// `07` §7.3's own algorithm, implemented as written: a sweep over X-slabs,
// two-pointer over (walkable cells sorted by z, solids sorted by their north
// face z1), window `z1 in [P.z - 13.545, P.z]`. Only the solid's NEAREST face
// is tested, which for a plane sloping away to the south is its maximum z.
//
// The assertion `topY <= 1.00 + 1.206 * (P.z - z1)` is rearranged to
// `topY + 1.206 * z1 <= 1.00 + 1.206 * P.z` so the window's worst offender is
// a sliding-window MAXIMUM of a value that does not depend on P — a monotonic
// deque, O(cells + solids) per slab, exactly §7.3's own complexity claim.
//
// Returns the violating-cell count and the worst offender, per zone. Nothing
// is excluded and no threshold is softened (D-83): Bonereach's fraction is
// REPORTED, not hidden.
// `07` §7.1 says "every static solid". `sightOnly` re-runs the same sweep over
// only the footprints that actually carry `blocksSight`, which is the
// semantically narrower reading an occlusion rule invites. The literal
// reading is the one asserted; the narrower number is printed beside it so a
// reader can see the failure is not an artefact of including see-through
// props. Neither number is used to soften the other.
function checkI8(grid, footprints, sightOnly = false) {
  const { width, height, cellSize, originX, originZ, flags } = grid;
  const slabOf = (x) => Math.floor((x - originX) / cellSize);

  // Bucket solids by the slab range their x-extent + I8's own +-1.2 m
  // half-width can reach. A solid is relevant to cell P when
  // |x - P.x| <= 1.2 for some x it occupies, i.e. when [minX-1.2, maxX+1.2]
  // contains P.x.
  const buckets = new Array(width);
  const solids = [];
  for (let i = 0; i < footprints.length; i++) {
    const fp = footprints[i];
    if (sightOnly ? fp.blocksSight !== true : (fp.blocksNav === false && fp.blocksSight === false)) continue;
    const b = footprintBox(fp);
    solids.push({ idx: i, z1: b.maxZ, key: b.topY + I8_SLOPE * b.maxZ, topY: b.topY, minX: b.minX, maxX: b.maxX });
    const s0 = Math.max(0, slabOf(b.minX - I8_HALF_WIDTH));
    const s1 = Math.min(width - 1, slabOf(b.maxX + I8_HALF_WIDTH));
    for (let s = s0; s <= s1; s++) {
      if (!buckets[s]) buckets[s] = [];
      buckets[s].push(solids.length - 1);
    }
  }

  let walkable = 0;
  let violating = 0;
  let interiorWalkable = 0;
  let interiorViolating = 0;
  let worst = null;

  const deque = new Int32Array(Math.max(16, solids.length));

  for (let cx = 0; cx < width; cx++) {
    const bucket = buckets[cx];
    if (!bucket || bucket.length === 0) {
      for (let cz = 0; cz < height; cz++) {
        if (flags[cz * width + cx] & NAV_FLAG.walkable) {
          walkable++;
          if (flags[cz * width + cx] & NAV_FLAG.interior) interiorWalkable++;
        }
      }
      continue;
    }
    // Sorted by z1 ascending — §7.3's own "sorted by z ascending".
    const list = bucket.map((k) => solids[k]).sort((a, b) => (a.z1 - b.z1) || (a.idx - b.idx));

    let head = 0, tail = 0; // monotonic-decreasing deque of indices into `list`
    let added = 0;
    let dropped = 0;
    for (let cz = 0; cz < height; cz++) {
      const i = cz * width + cx;
      if (!(flags[i] & NAV_FLAG.walkable)) continue;
      walkable++;
      const isInterior = (flags[i] & NAV_FLAG.interior) !== 0;
      if (isInterior) interiorWalkable++;
      const pz = originZ + (cz + 0.5) * cellSize;

      // Grow the window's north end: every solid whose north face is at or
      // south of P.
      while (added < list.length && list[added].z1 <= pz) {
        const key = list[added].key;
        while (tail > head && list[deque[tail - 1]].key <= key) tail--;
        deque[tail++] = added;
        added++;
      }
      // Shrink the window's south end: solids further than 13.545 m south.
      const southLimit = pz - I8_WINDOW_DEPTH;
      while (dropped < added && list[dropped].z1 < southLimit) {
        if (tail > head && deque[head] === dropped) head++;
        dropped++;
      }
      if (tail === head) continue;

      const worstKey = list[deque[head]].key;
      const limit = I8_EYE_HEIGHT + I8_SLOPE * pz;
      if (worstKey > limit + 1e-9) {
        violating++;
        if (isInterior) interiorViolating++;
        const over = worstKey - limit;
        if (!worst || over > worst.over) {
          const s = list[deque[head]];
          worst = { over, px: originX + (cx + 0.5) * cellSize, pz, solidTopY: s.topY, solidZ1: s.z1, allowed: I8_EYE_HEIGHT + I8_SLOPE * (pz - s.z1) };
        }
      }
    }
  }

  return { walkable, violating, interiorWalkable, interiorViolating, worst };
}

// ---------------------------------------------------------------------------
// I9 — the world edge is never visible, `07` §7.1 / §7.3
// ---------------------------------------------------------------------------
// §7.3's own sweep. For every walkable cell `P`: `farZ = P.z + 11.68`; skip
// when `farZ <= boundsMaxZ - 2.0` (interior, trivially covered); otherwise
// every `(x, farZ)` with `|x - P.x| <= 17.16` must be inside bounds, or
// covered by ridge wall / berm / silhouette, or under `>= 0.98` fog opacity.
//
// THE FOG DISJUNCT CANNOT BE EVALUATED. §7.3 says `fogOpacityAt` is read from
// `src/sky/data/presets.js`; **`src/sky/` does not exist** in the tree (no SKY
// ticket has landed). §7.3 also states its own arithmetic for it — the far
// edge is always 30.61 m from the fixed camera, where the `wastes` preset is
// at 0.994, i.e. ALWAYS above the 0.98 threshold — which would make the third
// disjunct unconditionally true and the whole invariant vacuous. §7.3 then
// says the check "therefore reduces to ridge coverage, which is the thing
// that can actually be wrong". This file implements that reduction: the fog
// disjunct is dropped (the strictly harder reading), the geometric coverage
// is measured for real, and the result is reported as a counted finding
// naming the missing module — never a fake pass and never a fake failure.
//
// The work is done per z-row, not per cell: coverage of `(x, farZ)` depends
// only on `x` and `farZ`, so each far row is evaluated once into a 0/1 array
// and a prefix sum answers every cell in that row in O(1).
function checkI9(grid, bounds, coverage) {
  const { width, height, cellSize, originX, originZ, flags } = grid;
  const farThreshold = bounds.maxZ - I9_INTERIOR_MARGIN;

  // Sample columns span the trapezoid's own reach beyond the bounds.
  const sampleStep = cellSize;
  const sampleMinX = originX - I9_FAR_HALF_WIDTH - sampleStep;
  const sampleCount = Math.ceil((width * cellSize + 2 * (I9_FAR_HALF_WIDTH + sampleStep)) / sampleStep);
  const uncoveredPrefix = new Int32Array(sampleCount + 1);

  let checked = 0;
  let violating = 0;
  let interior = 0;
  let worst = null;
  const rowCache = new Map();

  for (let cz = 0; cz < height; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const farZ = pz + I9_FAR_DEPTH;
    let rowUncovered = null;
    for (let cx = 0; cx < width; cx++) {
      const i = cz * width + cx;
      if (!(flags[i] & NAV_FLAG.walkable)) continue;
      if (farZ <= farThreshold) { interior++; continue; }
      checked++;
      if (rowUncovered === null) {
        rowUncovered = rowCache.get(cz);
        if (!rowUncovered) {
          rowUncovered = new Uint8Array(sampleCount);
          for (let s = 0; s < sampleCount; s++) {
            const x = sampleMinX + (s + 0.5) * sampleStep;
            const insideBounds = x >= bounds.minX && x <= bounds.maxX && farZ >= bounds.minZ && farZ <= bounds.maxZ;
            rowUncovered[s] = insideBounds || coverage(x, farZ) ? 0 : 1;
          }
          rowCache.set(cz, rowUncovered);
        }
        uncoveredPrefix[0] = 0;
        for (let s = 0; s < sampleCount; s++) uncoveredPrefix[s + 1] = uncoveredPrefix[s] + rowUncovered[s];
      }
      const px = originX + (cx + 0.5) * cellSize;
      let s0 = Math.max(0, Math.floor((px - I9_FAR_HALF_WIDTH - sampleMinX) / sampleStep));
      let s1 = Math.min(sampleCount - 1, Math.ceil((px + I9_FAR_HALF_WIDTH - sampleMinX) / sampleStep));
      if (s1 < s0) continue;
      const bad = uncoveredPrefix[s1 + 1] - uncoveredPrefix[s0];
      if (bad > 0) {
        violating++;
        if (!worst || bad > worst.uncoveredSamples) worst = { px, pz, farZ, uncoveredSamples: bad, spanSamples: s1 - s0 + 1 };
      }
    }
  }

  return { checked, violating, interior, worst };
}

// ---------------------------------------------------------------------------
// I9's coverage predicate for `ashen_wastes`
// ---------------------------------------------------------------------------
// "covered by ridge wall, berm, silhouette ring". All three come straight off
// `world._wastesBoundary` (`runR9Boundary`'s own return value) — the ridge
// wall as `Footprint`s (they are also in `staticFootprints`), the berm as
// `{x,z,halfW,halfL,topY}` rects, the silhouette as point instances on the
// r in [62,78] ring. The silhouette prototypes carry no footprint, so their
// own catalogue `spacing` (8.0 m for `far_spire`, `07` §9.1) is read as the
// instance's plan-view extent — half of it as a radius. That reading is
// disclosed rather than assumed correct.
const SILHOUETTE_PLAN_RADIUS = 4.0; // half of far_spire's own 8.0 m spacing (07 §9.1)

function makeWastesCoverage(boundary) {
  if (!boundary) return () => false;
  const rects = [];
  for (const w of boundary.ridgeWall) {
    const b = footprintBox(w);
    rects.push(b);
  }
  for (const b of boundary.berm) {
    rects.push({ minX: b.x - b.halfW, maxX: b.x + b.halfW, minZ: b.z - b.halfL, maxZ: b.z + b.halfL });
  }
  const discs = boundary.silhouette.map((s) => ({ x: s.x, z: s.z, r2: SILHOUETTE_PLAN_RADIUS * SILHOUETTE_PLAN_RADIUS }));
  return function covered(x, z) {
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
    }
    for (let i = 0; i < discs.length; i++) {
      const d = discs[i];
      const dx = x - d.x, dz = z - d.z;
      if (dx * dx + dz * dz <= d.r2) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// I6 — no destructible can seal a region, `07` §7.1
// ---------------------------------------------------------------------------
// Two halves, and the first one needed a reading before it could mean
// anything. §7.1 says "Re-running N7 with every destructible stamped blocked
// leaves `regionCount` unchanged". In the SHIPPED tree every destructible
// footprint already carries `blocksNav: true` (verified on the wastes
// dressing pass: 84 of 216 footprints on the reference layout), so the live
// grid IS the "every destructible stamped blocked" grid and re-running N7
// against it is a literal no-op that can only ever pass. That is a vacuous
// green, which O-58 says is worse than a red.
//
// The invariant's INTENT is the other direction: a destructible is breakable,
// so the region structure must not DEPEND on it. This file therefore
// rasterises the same zone with the destructibles REMOVED and asserts the
// region count does not go down — i.e. no region exists only because a
// destructible walled it off. Both readings are reported; the literal one is
// flagged as structurally vacuous rather than counted as a pass.
//
// The second half — "no destructible sits on a `doorway` cell" — is a real
// check on the live grid and is asserted as written.
function checkI6(grid, zone, footprints) {
  const destructibles = [];
  const survivors = [];
  for (const fp of footprints) {
    if (fp.destructible) destructibles.push(fp);
    else survivors.push(fp);
  }

  // Half 2 — doorway occupancy, on the live grid.
  let onDoorway = 0;
  let firstDoorway = null;
  for (const fp of destructibles) {
    const idx = cellIndexAt(grid, fp.x, fp.z);
    if (idx >= 0 && (grid.flags[idx] & NAV_FLAG.doorway)) {
      onDoorway++;
      if (!firstDoorway) firstDoorway = { id: fp.id, x: fp.x, z: fp.z };
    }
  }

  if (destructibles.length === 0) {
    return { destructibles: 0, vacuous: true, regionCountWith: grid.regionCount, regionCountWithout: grid.regionCount, sealed: false, onDoorway, firstDoorway };
  }

  // Half 1 — the same `rasterizeNav` `nav.rebuild()` itself calls, with the
  // same inputs `nav.rebuild()` passes (`groundRegions: null`, `entry: null`,
  // `spawnDenyMarkers: null`, the zone's own `groundY` heightfield), on the
  // survivor footprints only.
  const g = createNavGrid({ cellSize: grid.cellSize, width: grid.width, height: grid.height, originX: grid.originX, originZ: grid.originZ });
  const scratch = createRasterScratch(grid.width, grid.height);
  const heightField = zone && zone.nav && zone.nav.groundY instanceof Float32Array ? zone.nav.groundY : null;
  const res = rasterizeNav(g, scratch, { footprints: survivors, groundRegions: null, heightField, entry: null, spawnDenyMarkers: null });

  return {
    destructibles: destructibles.length,
    vacuous: false,
    regionCountWith: grid.regionCount,
    regionCountWithout: res.regionCount,
    sealed: grid.regionCount > res.regionCount,
    onDoorway,
    firstDoorway,
  };
}

// ---------------------------------------------------------------------------
// I5 — the boss is reachable and the arena is intact, `07` §7.1
// ---------------------------------------------------------------------------
// §7.1, verbatim: "In the Altar: `regionAt(0, +5) === regionAt(entry)`, the
// exit portal pad is in the same region, and all 12 teleport anchors and 8
// summon anchors are walkable."
//
// Every position comes off `world._altarLayout` — the object
// `world.enterZone` itself built and published (`bossStart`, `portalPad`,
// `teleportAnchors`, `summonAnchors`), not a re-import of the module's
// constants. The literal `(0, +5)` is checked TOO, as an equality against
// `layout.bossStart`: if the shipped boss start ever drifts off §5.2's number
// the row says so instead of quietly following it.
//
// `regionAt` and `walkable` are `nav`'s own accessors over the live grid.
// The three clauses are asserted exactly as written; the anchors' region
// membership is MEASURED beside the walkability clause and printed, because
// "walkable" and "in the entry region" are not the same statement and §7.1
// only asks for the first.
function checkI5(nav, layout, entryRegion) {
  const boss = layout.bossStart;
  const pad = layout.portalPad;

  const bossRegion = nav.regionAt(boss.x, boss.z);
  const padRegion = nav.regionAt(pad.x, pad.z);

  const anchors = [];
  for (let i = 0; i < layout.teleportAnchors.length; i++) {
    const a = layout.teleportAnchors[i];
    anchors.push({ kind: 'teleport', index: i, x: a.x, z: a.z, radius: a.radius, angleDeg: a.angleDeg });
  }
  for (let i = 0; i < layout.summonAnchors.length; i++) {
    const a = layout.summonAnchors[i];
    anchors.push({ kind: 'summon', index: i, x: a.x, z: a.z, radius: a.radius, angleDeg: a.angleDeg });
  }

  const badAnchors = [];
  let anchorsOffRegion = 0;
  for (const a of anchors) {
    a.walkable = nav.walkable(a.x, a.z);
    a.region = nav.regionAt(a.x, a.z);
    if (a.region !== entryRegion) anchorsOffRegion++;
    if (!a.walkable) badAnchors.push(a);
  }

  return {
    // §5.2's own literal, checked rather than assumed.
    bossStartIsSpecLiteral: boss.x === 0 && boss.z === 5.0,
    bossX: boss.x, bossZ: boss.z,
    bossRegion,
    bossOk: bossRegion >= 0 && bossRegion === entryRegion,
    padX: pad.x, padZ: pad.z,
    padRegion,
    padOk: padRegion >= 0 && padRegion === entryRegion,
    teleportCount: layout.teleportAnchors.length,
    summonCount: layout.summonAnchors.length,
    anchorCount: anchors.length,
    badAnchors,
    anchorsOffRegion,
    ok: bossRegion >= 0 && bossRegion === entryRegion && padRegion >= 0 && padRegion === entryRegion
      && badAnchors.length === 0
      && layout.teleportAnchors.length === 12 && layout.summonAnchors.length === 8,
  };
}

/** `07` §7.1 I7 / §5.4 E4 — the arena floor is open. */
const I7_RADIUS = 16.0; // m — §7.1 "inside r = 16.0 m of the Altar centre"
const I7_LITERAL = 114; // §5.4: 6 x ceil(pi * (0.9 + 0.3)^2 / 0.25) = 6 x 19
const I7_LITERAL_BAND = 6; // §7.1 "= 114 +- 6"

// ---------------------------------------------------------------------------
// I7 — the arena floor is open, `07` §7.1 / §5.4 E4  (ruling D-91)
// ---------------------------------------------------------------------------
// The disc is centred on the ARENA centre `(0, 0)` — §5.2's "Arena floor:
// disc, centre (0, 0), radius 17.0 m" and §5.4 E4's "96 props inside
// `r < 16.0 m`" are the same disc, and the pillar ring at 11.5 m only lies
// inside it under that reading. (The "Altar BLOCK" is a different object, at
// `(0, +19.6)`, well outside the arena; reading I7's "Altar centre" as the
// block would put the whole disc inside the rim and the alcove and measure
// nothing. Disclosed, not assumed.)
//
// Two numbers, and only one of them is asserted (D-91):
//
//   INTENT (asserted) — §5.4's own sentence, "the only blockers inside
//   `r = 17.0 m` are the six pillars". Every blocked cell inside the disc
//   must be attributable to a pillar under `passN4FootprintStamp`'s OWN rule
//   (cell centre within `pillar.radius + RASTER.DILATION`), and all six
//   pillars must actually contribute cells — an arena that lost its pillars
//   would otherwise pass a "nothing else blocks" test trivially.
//
//   LITERAL (measured, reported, never asserted) — the `114 +- 6` count.
//
// `NAV_FLAG.blocked` and "not walkable" are counted separately: `raster.js`
// documents that a cell can be neither (outside every ground region), so
// collapsing them would hide a third state if one ever appeared inside the
// arena.
function checkI7(grid, layout) {
  const { width, height, cellSize, originX, originZ, flags } = grid;
  const pillars = layout.pillars;
  const r2 = I7_RADIUS * I7_RADIUS;

  let blocked = 0;
  let notWalkable = 0;
  let unattributed = 0;
  const perPillar = new Int32Array(pillars.length);
  let firstUnattributed = null;

  for (let cz = 0; cz < height; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    if (Math.abs(pz) > I7_RADIUS) continue;
    for (let cx = 0; cx < width; cx++) {
      const px = originX + (cx + 0.5) * cellSize;
      if (px * px + pz * pz > r2) continue;
      const i = cz * width + cx;
      const isBlocked = (flags[i] & NAV_FLAG.blocked) !== 0;
      if (!(flags[i] & NAV_FLAG.walkable)) notWalkable++;
      if (!isBlocked) continue;
      blocked++;
      // The stamp's own predicate, re-applied: `passN4FootprintStamp` blocks
      // a cell whose CENTRE lies within `radius + DILATION` of the cylinder.
      let owner = -1;
      for (let k = 0; k < pillars.length; k++) {
        const dx = px - pillars[k].x, dz = pz - pillars[k].z;
        const rr = pillars[k].radius + RASTER.DILATION;
        if (dx * dx + dz * dz <= rr * rr + 1e-9) { owner = k; break; }
      }
      if (owner < 0) {
        unattributed++;
        if (!firstUnattributed) firstUnattributed = { x: px, z: pz };
      } else {
        perPillar[owner]++;
      }
    }
  }

  const pillarsWithCells = [...perPillar].filter((c) => c > 0).length;
  return {
    blocked,
    notWalkable,
    unattributed,
    firstUnattributed,
    perPillar: [...perPillar],
    pillarCount: pillars.length,
    pillarRadius: pillars.length ? pillars[0].radius : 0,
    stampRadius: (pillars.length ? pillars[0].radius : 0) + RASTER.DILATION,
    pillarsWithCells,
    // D-91's ASSERTED clause.
    intentOk: unattributed === 0 && pillarsWithCells === pillars.length && pillars.length === 6,
    // D-91's REPORTED clause.
    literalOk: Math.abs(blocked - I7_LITERAL) <= I7_LITERAL_BAND,
  };
}

// ---------------------------------------------------------------------------
// One layout, measured end to end
// ---------------------------------------------------------------------------
// Everything below reads off a world that has ALREADY been through
// `world.enterZone`. No stage is re-run, nothing is recomputed from a seed.

function evaluateLayout(world, nav, plan, worldSeed, runIndex) {
  const grid = nav.grid;
  const zone = world.current;
  const descriptor = zone.descriptor;
  const footprints = world.staticFootprints;
  const bounds = { minX: zone.boundsMinX, maxX: zone.boundsMaxX, minZ: zone.boundsMinZ, maxZ: zone.boundsMaxZ };
  const isWastes = plan.id === 'ashen_wastes';
  const isAltar = plan.id === 'altar_of_instruction';

  const entryPoint = world.entry(plan.entryTag);
  const entryRegion = nav.regionAt(entryPoint.x, entryPoint.z);

  const out = {
    worldSeed, runIndex, zoneId: plan.id, seed: zone.seed,
    regionCount: grid.regionCount,
    entryRegion,
  };

  // --- I1 — entry -> exit is always walkable -------------------------------
  // "For every entry tag and every exit trigger,
  // `nav.regionAt(entry) === nav.regionAt(exit)` and both are `>= 0`."
  //
  // `world` exposes every entry tag through `entry(tag)`. It exposes the
  // Bonereach exit trigger (`world._bonereachExit.trigger`), but NOT the
  // Ashen Wastes one — `enterZone` drops `placeRidgewalkEntries(...).exit` on
  // the floor (its own source comment even names the gap). The Wastes exit
  // trigger centre is however IDENTICAL to the `descent_return` entry point
  // by construction: R10 builds the trigger at `exitCentre.z + 8.0 - 2 - 1`
  // and `descent_return` at `exitCentre.z + 8.0 - 3.0`, the same x and the
  // same z. So the Wastes exit trigger IS covered here, through the entry tag
  // that coincides with it — disclosed, not glossed. See this ticket's report
  // (defect: `world` never publishes the Wastes exit).
  const points = [];
  for (const tag of zone.entries.keys()) {
    const p = world.entry(tag);
    points.push({ kind: 'entry', tag, x: p.x, z: p.z });
  }
  if (!isWastes && world._bonereachExit && world._bonereachExit.trigger) {
    const t = world._bonereachExit.trigger;
    points.push({ kind: 'exit', tag: 'exit-trigger', x: t.x, z: t.z, rect: t });
  }
  out.i1 = { total: points.length, bad: [], rectRescued: 0 };
  for (const p of points) {
    const r = nav.regionAt(p.x, p.z);
    if (r < 0 || r !== entryRegion) {
      // I1 is written against a POINT (`regionAt(exit)`), but an exit trigger
      // is a rect (`{x, z, width, depth}`). The centre of a 5 x 2 m rect
      // routinely lands exactly on a 0.5 m nav-cell boundary, so the literal
      // point test can read -1 while the trigger rect itself sits on walkable
      // ground. The point test is what is ASSERTED (it is what I1 says);
      // `rectTouchesEntry` is measured beside it so a reader can tell a
      // genuinely sealed exit from a boundary artefact. Both are printed.
      let rectTouchesEntry = false;
      if (p.rect) {
        const hw = p.rect.width / 2, hd = p.rect.depth / 2;
        for (let dx = -hw; dx <= hw && !rectTouchesEntry; dx += grid.cellSize) {
          for (let dz = -hd; dz <= hd && !rectTouchesEntry; dz += grid.cellSize) {
            if (nav.regionAt(p.x + dx, p.z + dz) === entryRegion) rectTouchesEntry = true;
          }
        }
      }
      if (rectTouchesEntry) out.i1.rectRescued++;
      out.i1.bad.push({ kind: p.kind, tag: p.tag, x: p.x, z: p.z, region: r, rectTouchesEntry });
    }
  }

  // --- I2 — every chest is reachable ---------------------------------------
  // `ZoneInstance.chests[i]` carries `unsnappedPosition` and nothing else
  // positional: `07` §3.2 R10 explicitly returns chests UNSNAPPED for "a
  // later stage — the one that already has a live NavGrid — to snap", and no
  // stage ever does. Both readings are measured: the literal shipped position
  // (which is what any consumer would read today) and the position after
  // `nav.snap(p, 2.0)` (what R10 asked for). The literal one is the assertion.
  out.i2 = { total: zone.chests.length, bad: [], badSnapped: 0 };
  for (let i = 0; i < zone.chests.length; i++) {
    const c = zone.chests[i];
    const p = c.unsnappedPosition || c.position || c;
    const r = nav.regionAt(p.x, p.z);
    if (r !== entryRegion) {
      out.i2.bad.push({ index: i, x: p.x, z: p.z, region: r });
      const s = nav.snap(p.x, p.z, 2.0);
      if (!s || nav.regionAt(s.x, s.z) !== entryRegion) out.i2.badSnapped++;
    }
  }

  // --- I3 — every pack and spawn point is reachable and outside geometry ----
  // "`walkable(p)`, `regionAt(p) === entryRegion`, and `nav.snap(p, 0.0)`
  // returns `p` unchanged (i.e. it is ALREADY on a walkable cell)".
  out.i3 = { total: 0, bad: [] };
  const i3Points = [];
  for (let i = 0; i < world.packs.length; i++) {
    const p = world.packs[i];
    i3Points.push({ kind: 'pack', index: i, x: p.centerX, z: p.centerZ });
  }
  for (let i = 0; i < world.spawnPoints.length; i++) {
    const s = world.spawnPoints[i];
    i3Points.push({ kind: 'spawn', index: i, x: s.x, z: s.z });
  }
  out.i3.total = i3Points.length;
  for (const p of i3Points) {
    const walk = nav.walkable(p.x, p.z);
    const region = nav.regionAt(p.x, p.z);
    const snapped = nav.snap(p.x, p.z, 0.0);
    const identity = snapped !== null && snapped.x === p.x && snapped.z === p.z;
    if (!walk || region !== entryRegion || !identity) {
      out.i3.bad.push({ ...p, walkable: walk, region, snapIdentity: identity });
    }
  }

  // --- I4 — monster density within +-20 % of target -------------------------
  // `world._spawnReport` is `src/world/spawn.js`'s own report, produced by the
  // real spawn solve inside `enterZone`. `densityTarget` there is already
  // `descriptor.densityTarget x tierDensityMul`, which is exactly what §8.1's
  // `targetTotal` is computed from — the same field `tests/world/wrld9.test.js`
  // reads for the same purpose.
  const report = world._spawnReport;
  out.i4 = { evaluated: false };
  if (report) {
    const floorMonsters = descriptor.packCount.min * descriptor.packSize.min;
    const floorSatisfiable = report.densityTarget * report.walkableAreaEntryRegion >= floorMonsters;
    const dev = report.densityTarget > 0 ? (report.achievedDensity - report.densityTarget) / report.densityTarget : 0;
    out.i4 = {
      evaluated: true,
      floorSatisfiable,
      floorMonsters,
      dev,
      achievedDensity: report.achievedDensity,
      densityTarget: report.densityTarget,
      entryArea: report.walkableAreaEntryRegion,
      targetTotal: report.targetTotal,
      achievedTotal: report.achievedTotal,
    };
  }

  // --- I5 / I7 — altar only, per §7.1's "Applies to: altar" ----------------
  // `world._altarLayout` is the layout object `enterZone` itself built and
  // kept; it is `null` for every other zone. If WRLD-8 is ever unshipped this
  // reads `null` and the rows come back as SKIPs rather than as silence.
  if (isAltar && world._altarLayout) {
    out.i5 = checkI5(nav, world._altarLayout, entryRegion);
    out.i7 = checkI7(grid, world._altarLayout);
  }

  // --- I6 — no destructible can seal a region ------------------------------
  out.i6 = checkI6(grid, zone, footprints);

  // --- I8 — the Occlusion Plane Rule ---------------------------------------
  out.i8 = checkI8(grid, footprints);
  const i8Sight = checkI8(grid, footprints, true);
  out.i8.sightViolating = i8Sight.violating;

  // --- I9 — the world edge is never visible (wastes only, per §7.1) --------
  if (isWastes) out.i9 = checkI9(grid, bounds, makeWastesCoverage(world._wastesBoundary));

  // --- W1/W2 and the three scoped distribution metrics ---------------------
  if (isWastes) {
    const L = world._wastesLayout;
    const d = world._wastesDressing;
    const b = world._wastesBoundary;
    out.w1 = { fallback: L.w1FallbackCount, eligible: L.w1Eligible };
    out.w2 = { fallbackUsed: L.fallbackUsed === true };
    out.connected = L.connected.length; // D-77
    out.props = { // D-80
      dressed: d.props.length,
      total: d.props.length + b.ridgeWall.length + b.silhouette.length,
      budget: descriptor.propBudget,
    };
  } else if (plan.id === 'altar_of_instruction') {
    // The Altar has no procedural layout to score: `07` §5 says in as many
    // words "the layout is fixed. The seed drives only the dressing", so
    // `rooms` (D-82) and the connected-cell spread (D-77) have no meaning
    // here and there is no `_bonereachLayout` to read. Saying so beats
    // falling into the Bonereach branch, which is what this file did before
    // WRLD-8 landed and `built` started being resolved from disk.
    out.fixedLayout = true;
  } else {
    const L = world._bonereachLayout;
    out.rooms = { achieved: L.rooms.length, target: L.targetRooms, requested: L.targetRoomsRequested }; // D-82
    out.props = {
      dressed: world._bonereachDressing.props.length,
      total: world._bonereachDressing.props.length,
      budget: descriptor.propBudget,
    };
  }

  // --- the layout hash (12.D02) --------------------------------------------
  const h = newHash();
  hashString(h, plan.id);
  hashNumber(h, worldSeed);
  hashNumber(h, runIndex);
  hashNumber(h, zone.seed);
  hashTypedArray(h, grid.flags);
  hashTypedArray(h, grid.region);
  hashNumber(h, grid.regionCount);
  for (const fp of footprints) {
    hashNumber(h, fp.x); hashNumber(h, fp.z); hashNumber(h, fp.y);
    hashNumber(h, fp.height); hashNumber(h, fp.halfW || 0); hashNumber(h, fp.halfL || 0);
    hashNumber(h, fp.radius || 0); hashNumber(h, fp.facing || 0);
  }
  for (const p of points) { hashString(h, p.tag); hashNumber(h, p.x); hashNumber(h, p.z); }
  for (const c of zone.chests) { hashNumber(h, c.unsnappedPosition.x); hashNumber(h, c.unsnappedPosition.z); }
  for (const p of world.packs) { hashNumber(h, p.centerX); hashNumber(h, p.centerZ); hashNumber(h, p.count); }
  for (const s of world.spawnPoints) { hashNumber(h, s.x); hashNumber(h, s.z); }
  out.hash = hashHex(h);

  return out;
}

// ---------------------------------------------------------------------------
// checks[] — ONE flat array, rendered by both the human report and --json
// ---------------------------------------------------------------------------
// `{id, severity, scope, status, lines}`, lootsim/balance's own shape.
//   severity 'fail' — a red gate; flips the exit code to 1
//   severity 'warn' — `07` §7.1's W1/W2; printed, never flips the exit code
//   severity 'note' — counted, printed loudly, never flips the exit code
//   severity 'skip' — cannot run; counted, printed loudly, never a fake pass
// `status` is the verdict actually reached ('pass' | 'fail' | 'warn' | 'note'
// | 'skip'); a `severity:'fail'` check that passed has `status:'pass'`.

function makeCheck(id, severity, scope, status, detail, lines = []) {
  return { id, severity, scope, status, detail, lines };
}

function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(2)} %` : 'n/a'; }
function hex(n) { return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; }
function label(r) { return `worldSeed=${hex(r.worldSeed)} runIndex=${r.runIndex} seed=${hex(r.seed)}`; }

/** Cap the per-check failure listing so one systemic failure cannot bury the
 * report. The count is always exact; only the listing is truncated, and the
 * truncation says so. */
const MAX_LISTED = 12;
function listing(rows, render) {
  const out = [];
  for (let i = 0; i < Math.min(rows.length, MAX_LISTED); i++) out.push(render(rows[i]));
  if (rows.length > MAX_LISTED) out.push(`… and ${rows.length - MAX_LISTED} more (count above is exact)`);
  return out;
}

function buildZoneChecks(zoneId, results, checks) {
  const n = results.length;

  // --- I1 ------------------------------------------------------------------
  const i1Bad = results.filter((r) => r.i1.bad.length > 0);
  const i1Rescued = results.reduce((a, r) => a + r.i1.rectRescued, 0);
  const i1Sealed = i1Bad.filter((r) => r.i1.bad.some((b) => !b.rectTouchesEntry));
  checks.push(makeCheck('I1', 'fail', zoneId, i1Bad.length === 0 ? 'pass' : 'fail',
    `entry->exit walkable ${n - i1Bad.length}/${n}`,
    [
      ...(i1Rescued > 0 ? [
        `${i1Rescued} of the failing points are EXIT TRIGGERS whose rect does touch the entry region — I1 tests the rect's CENTRE (regionAt(exit)) and a 5 x 2 m rect's centre routinely lands exactly on a 0.5 m nav-cell boundary. Genuinely disconnected layouts: ${i1Sealed.length}/${n}.`,
      ] : []),
      ...listing(i1Bad, (r) => `${label(r)}  ${r.i1.bad.map((b) => `${b.kind}:${b.tag}@(${b.x.toFixed(2)},${b.z.toFixed(2)}) region=${b.region}${b.rectTouchesEntry ? ' [rect touches entry region]' : ''}`).join('  ')}  entryRegion=${r.entryRegion}`),
    ]));

  // --- I2 ------------------------------------------------------------------
  const i2Bad = results.filter((r) => r.i2.bad.length > 0);
  const i2BadChests = results.reduce((a, r) => a + r.i2.bad.length, 0);
  const i2Chests = results.reduce((a, r) => a + r.i2.total, 0);
  const i2StillBadSnapped = results.reduce((a, r) => a + r.i2.badSnapped, 0);
  checks.push(makeCheck('I2', 'fail', zoneId, i2Bad.length === 0 ? 'pass' : 'fail',
    `chests reachable ${n - i2Bad.length}/${n} layouts (${i2Chests - i2BadChests}/${i2Chests} chests)`,
    i2Bad.length === 0 ? [] : [
      `${i2BadChests} of ${i2Chests} chests are not in the entry region at their SHIPPED position`,
      `of those, ${i2StillBadSnapped} are still unreachable after nav.snap(p, 2.0) — the remaining ${i2BadChests - i2StillBadSnapped} would pass if anyone snapped them`,
      '07 §3.2 R10 returns chests UNSNAPPED for "a later stage... to snap"; no stage does (see this ticket\'s report)',
      ...listing(i2Bad, (r) => `${label(r)}  ${r.i2.bad.map((b) => `chest[${b.index}]@(${b.x.toFixed(2)},${b.z.toFixed(2)}) region=${b.region}`).join('  ')}  entryRegion=${r.entryRegion}`),
    ]));

  // --- I3 ------------------------------------------------------------------
  const i3Bad = results.filter((r) => r.i3.bad.length > 0);
  const i3Points = results.reduce((a, r) => a + r.i3.total, 0);
  const i3BadPoints = results.reduce((a, r) => a + r.i3.bad.length, 0);
  checks.push(makeCheck('I3', 'fail', zoneId, i3Bad.length === 0 ? 'pass' : 'fail',
    `packs+spawns walkable, in region, snap-identity ${n - i3Bad.length}/${n} layouts (${i3Points - i3BadPoints}/${i3Points} points)`,
    listing(i3Bad, (r) => `${label(r)}  ${r.i3.bad.slice(0, 3).map((b) => `${b.kind}[${b.index}]@(${b.x.toFixed(2)},${b.z.toFixed(2)}) walkable=${b.walkable} region=${b.region} snapIdentity=${b.snapIdentity}`).join('  ')}`)));

  // --- I4 (D-84) -----------------------------------------------------------
  const withReport = results.filter((r) => r.i4.evaluated);
  const clamped = withReport.filter((r) => !r.i4.floorSatisfiable);
  const checkable = withReport.filter((r) => r.i4.floorSatisfiable);
  const i4Bad = checkable.filter((r) => Math.abs(r.i4.dev) > I4_BAND);
  const tightBad = checkable.filter((r) => Math.abs(r.i4.dev) > I4_TIGHT_BAND);
  const devs = checkable.map((r) => r.i4.dev);
  const devRange = devs.length ? `[${(Math.min(...devs) * 100).toFixed(1)} %, ${(Math.max(...devs) * 100).toFixed(1)} %]` : 'n/a';
  if (withReport.length === 0) {
    checks.push(makeCheck('I4', 'skip', zoneId, 'skip', 'no spawn report — this zone has no spawn pass in enterZone', []));
  } else {
    checks.push(makeCheck('I4', 'fail', zoneId, i4Bad.length === 0 ? 'pass' : 'fail',
      `density within +-20 % ${checkable.length - i4Bad.length}/${checkable.length} floor-satisfiable layouts  ${devRange}`,
      [
        `+-2 % (the tighter WRLD-9 band, D-84 point 3): ${checkable.length - tightBad.length}/${checkable.length}`,
        ...listing(i4Bad, (r) => `${label(r)}  dev=${(r.i4.dev * 100).toFixed(2)} %  achieved=${r.i4.achievedDensity.toFixed(6)} target=${r.i4.densityTarget.toFixed(6)} entryArea=${r.i4.entryArea.toFixed(1)} m2`),
      ]));
    // D-84 point 2 — the FLOOR-CLAMPED list. Never silently excluded.
    checks.push(makeCheck('I4-FLOOR-CLAMPED', 'note', zoneId, clamped.length === 0 ? 'pass' : 'note',
      `${clamped.length}/${withReport.length} layouts where the descriptor floor binds (packCount.min x packSize.min monsters cannot fit at densityTarget)`,
      clamped.length === 0 ? [] : [
        `floor = ${withReport[0].i4.floorMonsters} monsters; needs entryArea >= ${(withReport[0].i4.floorMonsters / withReport[0].i4.densityTarget).toFixed(0)} m2 at densityTarget ${withReport[0].i4.densityTarget}`,
        'D-84: I4 is not evaluated on these; they are listed here with their achieved density instead',
        ...listing(clamped, (r) => `FLOOR-CLAMPED  ${label(r)}  entryArea=${r.i4.entryArea.toFixed(1)} m2  achievedDensity=${r.i4.achievedDensity.toFixed(6)}  target=${r.i4.densityTarget.toFixed(6)}  dev=${(r.i4.dev * 100).toFixed(2)} %  achievedTotal=${r.i4.achievedTotal}`),
      ]));
  }

  // --- I5 (altar only) -----------------------------------------------------
  if (results[0] && results[0].i5) {
    const i5Bad = results.filter((r) => !r.i5.ok);
    const bossBad = results.filter((r) => !r.i5.bossOk);
    const padBad = results.filter((r) => !r.i5.padOk);
    const anchorBad = results.filter((r) => r.i5.badAnchors.length > 0);
    const anchorsTotal = results.reduce((a, r) => a + r.i5.anchorCount, 0);
    const anchorsBadTotal = results.reduce((a, r) => a + r.i5.badAnchors.length, 0);
    const offRegion = results.reduce((a, r) => a + r.i5.anchorsOffRegion, 0);
    const driftedBossStart = results.filter((r) => !r.i5.bossStartIsSpecLiteral).length;
    const s = results[0].i5;
    checks.push(makeCheck('I5', 'fail', zoneId, i5Bad.length === 0 ? 'pass' : 'fail',
      `boss reachable + arena intact ${n - i5Bad.length}/${n} (${s.teleportCount} teleport + ${s.summonCount} summon anchors walkable: ${anchorsTotal - anchorsBadTotal}/${anchorsTotal})`,
      [
        `07 §7.1: regionAt(0, +5) === regionAt(entry) — held on ${n - bossBad.length}/${n}; the boss start world._altarLayout published is (${s.bossX.toFixed(2)}, ${s.bossZ.toFixed(2)}), regionAt = ${s.bossRegion}, entryRegion = ${results[0].entryRegion}`,
        `exit portal pad (${s.padX.toFixed(2)}, ${s.padZ.toFixed(2)}) in the entry region — held on ${n - padBad.length}/${n}`,
        `all ${s.anchorCount} anchors walkable (nav.walkable off the live grid) — held on ${n - anchorBad.length}/${n} layouts`,
        `MEASURED beside the assertion: anchors NOT in the entry region = ${offRegion}/${anchorsTotal}. §7.1 only asks that the anchors be walkable, so this is printed, not asserted.`,
        ...(driftedBossStart > 0 ? [`WARNING: on ${driftedBossStart}/${n} layouts the published boss start is not §5.2's literal (0, +5.0)`] : []),
        ...listing(i5Bad, (r) => `${label(r)}  bossRegion=${r.i5.bossRegion} padRegion=${r.i5.padRegion} entryRegion=${r.entryRegion}  ${r.i5.badAnchors.map((a) => `${a.kind}[${a.index}]@(${a.x.toFixed(2)},${a.z.toFixed(2)}) r=${a.radius} ${a.angleDeg}deg walkable=${a.walkable} region=${a.region}`).join('  ')}`),
      ]));
  }

  // --- I6 ------------------------------------------------------------------
  const anyDestructible = results.some((r) => r.i6.destructibles > 0);
  const sealed = results.filter((r) => r.i6.sealed);
  const onDoorway = results.filter((r) => r.i6.onDoorway > 0);
  if (!anyDestructible) {
    checks.push(makeCheck('I6', 'note', zoneId, 'note',
      'VACUOUS — this zone emits zero destructible footprints, so nothing can seal anything',
      ['`07` §7.1 I6 has no subject here; reported rather than counted as a pass']));
  } else {
    checks.push(makeCheck('I6', 'fail', zoneId, sealed.length === 0 && onDoorway.length === 0 ? 'pass' : 'fail',
      `destructibles cannot seal ${n - sealed.length}/${n}; none on a doorway cell ${n - onDoorway.length}/${n}`,
      [
        'READING (see this file\'s header): every destructible already carries blocksNav:true, so §7.1\'s literal "re-run N7 with every destructible stamped blocked" is a no-op that cannot fail. Measured instead: rasterizeNav WITHOUT the destructibles, asserting regionCount does not drop.',
        ...listing(sealed, (r) => `${label(r)}  regionCount with=${r.i6.regionCountWith} without=${r.i6.regionCountWithout} destructibles=${r.i6.destructibles}`),
        ...listing(onDoorway, (r) => `${label(r)}  ${r.i6.onDoorway} destructible(s) on a doorway cell, first at (${r.i6.firstDoorway.x.toFixed(2)}, ${r.i6.firstDoorway.z.toFixed(2)})`),
      ]));
  }

  // --- I7 (altar only, ruling D-91) ----------------------------------------
  if (results[0] && results[0].i7) {
    const intentBad = results.filter((r) => !r.i7.intentOk);
    const literalBad = results.filter((r) => !r.i7.literalOk);
    const unattributed = results.reduce((a, r) => a + r.i7.unattributed, 0);
    const counts = new Map();
    for (const r of results) counts.set(r.i7.blocked, (counts.get(r.i7.blocked) || 0) + 1);
    const keys = [...counts.keys()].sort((a, b) => a - b);
    const nwCounts = new Set(results.map((r) => r.i7.notWalkable));
    const s = results[0].i7;
    const firstBadCell = (results.find((r) => r.i7.firstUnattributed) || { i7: {} }).i7.firstUnattributed;

    checks.push(makeCheck('I7', 'fail', zoneId, intentBad.length === 0 ? 'pass' : 'fail',
      `arena floor open — only the six pillars block inside r = ${I7_RADIUS.toFixed(1)} m, on ${n - intentBad.length}/${n}`,
      [
        `ASSERTED (D-91, the INTENT): §5.4 E4's own sentence — "the only blockers inside r = 17.0 m are the six pillars". Every blocked cell inside the disc is attributed by re-applying passN4FootprintStamp's own predicate: cell centre within pillar.radius + RASTER.DILATION = ${s.pillarRadius.toFixed(2)} + ${RASTER.DILATION.toFixed(2)} = ${s.stampRadius.toFixed(2)} m.`,
        `unattributable blocked cells across ${n} layouts: ${unattributed}${firstBadCell ? ` (first at (${firstBadCell.x.toFixed(2)}, ${firstBadCell.z.toFixed(2)}))` : ''}`,
        `all ${s.pillarCount} pillars actually contribute cells on ${results.filter((r) => r.i7.pillarsWithCells === r.i7.pillarCount).length}/${n} — per-pillar counts on the first layout: ${s.perPillar.join(' ')}`,
        `E4's 96 arena rubble props are all navBlock:false, and the sweep confirms it: nothing but the pillars is blocked inside the disc.`,
        `cells inside the disc that are not walkable: ${[...nwCounts].sort((a, b) => a - b).join('/')} (raster.js documents a third state — neither walkable nor blocked — so the two are counted separately, and here they agree)`,
        ...listing(intentBad, (r) => `${label(r)}  blocked=${r.i7.blocked} unattributed=${r.i7.unattributed} pillarsWithCells=${r.i7.pillarsWithCells}/${r.i7.pillarCount}`),
      ]));

    // D-91 — the literal band, measured and carried, never asserted.
    checks.push(makeCheck('I7-LITERAL', 'note', zoneId, literalBad.length === 0 ? 'pass' : 'note',
      `07 §7.1's literal "blocked cells inside r = 16.0 m = ${I7_LITERAL} +- ${I7_LITERAL_BAND}" holds on ${n - literalBad.length}/${n} — MEASURED ${keys.length === 1 ? keys[0] : `[${keys[0]}..${keys[keys.length - 1]}]`}`,
      [
        `histogram of blocked cells inside r = ${I7_RADIUS.toFixed(1)} m: ${keys.map((k) => `${k}:${counts.get(k)}`).join(' ')}`,
        `D-91: ${I7_LITERAL} is an AREA estimate — §5.4 derives it as 6 x ceil(pi * (0.9 + 0.3)^2 / 0.25) = 6 x 19. passN4FootprintStamp does not integrate area: it blocks a cell when the cell CENTRE falls within radius + dilation (0.90 + 0.30 = 1.20 m).`,
        `Cell-centre sampling of a r = 1.20 m disc yields 16..21 cells depending on how the centre sits on the lattice. The six pillar bearings §5.2 mandates (r = 11.5 m at 0/60/120/180/240/300 degrees) all land in the 16-cell alignment on a grid whose cell centres are the odd multiples of 0.25 m, so the count is 6 x 16 = 96 on every layout, deterministically.`,
        `Shortfall against the literal: ${I7_LITERAL - keys[0]} cells (${I7_LITERAL} - ${keys[0]}); the measured count is ${(keys[0] / I7_LITERAL * 100).toFixed(1)} % of the spec's number, and ${I7_LITERAL - I7_LITERAL_BAND} is the bottom of the band. Closing it needs a different pillar radius, a different dilation or different bearings — none of which this tool may invent, and all three are 07 §5.2/§6.3 numbers.`,
        `The INTENT clause above IS asserted and holds; only this literal is reported. Never asserted (the shipped geometry cannot produce it), never silently dropped (O-58).`,
      ]));
  }

  // --- I8 (D-83) -----------------------------------------------------------
  const i8Cells = results.reduce((a, r) => a + r.i8.walkable, 0);
  const i8Bad = results.reduce((a, r) => a + r.i8.violating, 0);
  const i8Layouts = results.filter((r) => r.i8.violating > 0);
  const i8Interior = results.reduce((a, r) => a + r.i8.interiorWalkable, 0);
  const i8InteriorBad = results.reduce((a, r) => a + r.i8.interiorViolating, 0);
  const i8SightBad = results.reduce((a, r) => a + r.i8.sightViolating, 0);
  const worst = results.reduce((w, r) => (r.i8.worst && (!w || r.i8.worst.over > w.over) ? r.i8.worst : w), null);
  const i8Detail = `occlusion plane ${n - i8Layouts.length}/${n} layouts clean; ${i8Cells - i8Bad}/${i8Cells} walkable cells (${pct(i8Bad, i8Cells)} violating)`;
  const i8SightLine = `restricted to blocksSight footprints only (the narrower reading of "static solid"): ${pct(i8SightBad, i8Cells)} violating — the failure is not an artefact of counting see-through props`;
  if (zoneId === 'bonereach') {
    // D-83 — structurally impossible inside rooms. LOUD, COUNTED NOTE with
    // the measured fraction. Never a silent pass, never a weakened threshold.
    checks.push(makeCheck('I8', 'note', zoneId, 'note', i8Detail, [
      'D-83: structurally impossible here. I8 needs s >= (topY - 1.00) / 1.206 of clearance south of a wall.',
      'B3 room walls are 5.0 m -> s >= 3.32 m; the SHIPPED toFootprints emits rock at topY 8.0 m -> s >= 5.80 m.',
      'Bonereach rooms are 8-18 m deep, so a fixed band of every room floor violates it by construction.',
      `MEASURED violating fraction: ${pct(i8Bad, i8Cells)} of walkable cells (${i8Bad} of ${i8Cells}) across ${n} layouts`,
      i8SightLine,
      `D-83's own remedy (exclude NAV_FLAG.interior cells) is currently a NO-OP: interior-flagged walkable cells = ${i8Interior} (violating: ${i8InteriorBad}). nav.rebuild() passes groundRegions:null, so nothing is ever flagged interior.`,
      worst ? `worst offender: cell (${worst.px.toFixed(2)}, ${worst.pz.toFixed(2)}) sees a solid topY ${worst.solidTopY.toFixed(2)} m with north face z1 ${worst.solidZ1.toFixed(2)}; allowed ${worst.allowed.toFixed(2)} m, over by ${worst.over.toFixed(2)} m` : '',
    ].filter(Boolean)));
  } else if (zoneId === 'altar_of_instruction') {
    // D-90 — the occlusion here is DESIGNED, and `07` §5.3's guarantee G6
    // says so in as many words. Same treatment as Bonereach under D-83:
    // honest measurement, threshold untouched, loud counted NOTE.
    checks.push(makeCheck('I8', 'note', zoneId, 'note', i8Detail, [
      'D-90: 07 §5.3 G6 ("Cover and line of sight") ACCEPTS this occlusion rather than forbidding it.',
      'G6, verbatim: the six pillars are "0.90 m radius, 7.0 m tall, at radius 11.5 m. Against the Occlusion Plane at s = 0 they are far over 1.00 m, so a pillar *does* occlude a player standing immediately north of it. That is accepted and deliberate."',
      'G6 sizes the band itself: s <= (7.0 - 1.0) / 1.206 = 4.98 m north of each pillar, "a 1.8 x 5.0 m rectangle, six of them, 53.9 m2 total = 5.9 % of the arena", and marks each one on the floor with an authored scorched fan decal so the trade is legible.',
      'Standing in the occluded band is the player\'s own choice — G6 calls it "the only place the player is safe from a ranged phase-III meteor lock". Cover that does not occlude is not cover.',
      `MEASURED violating fraction: ${pct(i8Bad, i8Cells)} of walkable cells (${i8Bad} of ${i8Cells}) across ${n} layouts`,
      `G6's own 5.9 % is the ARENA's share; the fraction above is over the whole zone's walkable set (arena disc + approach corridor + alcove), and it counts the rim, the gate arch and the altar block as well as the six pillars — every static solid, which is what I8 says.`,
      i8SightLine,
      `interior-flagged walkable cells: ${i8Interior} (violating: ${i8InteriorBad}); nav.rebuild() passes groundRegions:null, so nothing is ever flagged interior through the real pipeline — 07 §5.2 asks for the arena floor to be walkable+interior and it is not.`,
      worst ? `worst offender: cell (${worst.px.toFixed(2)}, ${worst.pz.toFixed(2)}) sees a solid topY ${worst.solidTopY.toFixed(2)} m with north face z1 ${worst.solidZ1.toFixed(2)}; allowed ${worst.allowed.toFixed(2)} m, over by ${worst.over.toFixed(2)} m` : '',
      'Threshold untouched, nothing excluded, and this row never moves the exit code. The wastes I8 stays a FAIL — nothing in 07 licenses that one.',
    ].filter(Boolean)));
  } else {
    checks.push(makeCheck('I8', 'fail', zoneId, i8Bad === 0 ? 'pass' : 'fail', i8Detail, [
      i8SightLine,
      `D-83's arithmetic is not Bonereach-specific: a solid of height h needs (h - 1.00) / 1.206 m of clear ground north of it, so ANY tall prop in the open violates I8 for the band immediately behind it. The wastes dressing pass (07 §3.2 R8) has no occlusion-plane rejection term.`,
      `interior-flagged walkable cells: ${i8Interior} (nothing is flagged interior through the real pipeline — nav.rebuild passes groundRegions:null)`,
      ...(i8Bad > 0 && worst ? [`worst offender: cell (${worst.px.toFixed(2)}, ${worst.pz.toFixed(2)}) vs solid topY ${worst.solidTopY.toFixed(2)} m, north face z1 ${worst.solidZ1.toFixed(2)}; allowed ${worst.allowed.toFixed(2)} m, over by ${worst.over.toFixed(2)} m`] : []),
      ...listing(i8Layouts, (r) => `${label(r)}  ${r.i8.violating}/${r.i8.walkable} cells violating`),
    ]));
  }

  // --- I9 (wastes only, per §7.1's "Applies to") ---------------------------
  if (results[0] && results[0].i9) {
    const i9Checked = results.reduce((a, r) => a + r.i9.checked, 0);
    const i9Bad = results.reduce((a, r) => a + r.i9.violating, 0);
    const i9Layouts = results.filter((r) => r.i9.violating > 0);
    const i9Worst = results.reduce((w, r) => (r.i9.worst && (!w || r.i9.worst.uncoveredSamples > w.uncoveredSamples) ? r.i9.worst : w), null);
    checks.push(makeCheck('I9', 'note', zoneId, i9Bad === 0 ? 'pass' : 'note',
      `world edge not visible — ${i9Checked - i9Bad}/${i9Checked} near-edge cells covered by ridge/berm/silhouette (${n - i9Layouts.length}/${n} layouts clean)`,
      [
        'BLOCKED as a pass/fail: §7.3 gives I9 three disjuncts (inside bounds / ridge-berm-silhouette / fog >= 0.98 opacity).',
        'The fog disjunct reads `fogOpacityAt` from src/sky/data/presets.js — src/sky/ DOES NOT EXIST in this tree (no SKY ticket has landed).',
        '§7.3 also states its own arithmetic for it: the far edge is always 30.61 m from the fixed camera, where the wastes preset is at 0.994 — always over the 0.98 threshold, which would make the invariant unconditionally true and vacuous.',
        '§7.3 then says the check "reduces to ridge coverage, which is the thing that can actually be wrong". This row implements exactly that reduction (the strictly harder reading), and reports the number rather than converting it into a verdict the spec does not support.',
        `silhouette instances carry no footprint; their plan-view extent is read as half of far_spire's own 8.0 m catalogue spacing (${SILHOUETTE_PLAN_RADIUS} m radius) — a disclosed reading, not a spec number`,
        i9Worst ? `worst: cell (${i9Worst.px.toFixed(2)}, ${i9Worst.pz.toFixed(2)}) far edge z=${i9Worst.farZ.toFixed(2)}, ${i9Worst.uncoveredSamples}/${i9Worst.spanSamples} samples of the 34.32 m span uncovered` : '',
      ].filter(Boolean)));
  }

  // --- W1 / W2 (07 §7.1's two warnings) ------------------------------------
  if (results[0] && results[0].w1) {
    const fb = results.reduce((a, r) => a + r.w1.fallback, 0);
    const el = results.reduce((a, r) => a + r.w1.eligible, 0);
    const rate = el > 0 ? fb / el : 0;
    checks.push(makeCheck('W1', 'warn', zoneId, rate > W1_THRESHOLD ? 'warn' : 'pass',
      `archetype fallback rate ${(rate * 100).toFixed(2)} % (threshold ${(W1_THRESHOLD * 100).toFixed(0)} %) — ${fb}/${el} eligible cells`, []));
    const w2 = results.filter((r) => r.w2.fallbackUsed).length;
    const w2rate = w2 / n;
    checks.push(makeCheck('W2', 'warn', zoneId, w2rate > W2_THRESHOLD ? 'warn' : 'pass',
      `R2 L-path fallback rate ${(w2rate * 100).toFixed(3)} % (threshold ${(W2_THRESHOLD * 100).toFixed(1)} %) — ${w2}/${n} layouts`, []));
  }

  // --- D-77 / D-80 / D-82 — scoped, measured, printed, never asserted ------
  if (results[0] && results[0].connected !== undefined) {
    const hist = new Map();
    for (const r of results) hist.set(r.connected, (hist.get(r.connected) || 0) + 1);
    const inBand = results.filter((r) => r.connected >= 9 && r.connected <= 14).length;
    const keys = [...hist.keys()].sort((a, b) => a - b);
    checks.push(makeCheck('D-77', 'note', zoneId, 'note',
      `|connected| in [9,14] on ${inBand}/${n} (${pct(inBand, n)}) — a DISTRIBUTION property, not an invariant; not asserted`,
      [`histogram: ${keys.map((k) => `${k}:${hist.get(k)}`).join(' ')}`, `structural range measured: [${keys[0]}, ${keys[keys.length - 1]}]`]));
  }
  if (results[0] && results[0].rooms) {
    const hist = new Map();
    let identity = 0;
    let inBand = 0;
    for (const r of results) {
      hist.set(r.rooms.achieved, (hist.get(r.rooms.achieved) || 0) + 1);
      if (r.rooms.achieved === r.rooms.target) identity++;
      if (r.rooms.achieved >= 12 && r.rooms.achieved <= 18) inBand++;
    }
    const keys = [...hist.keys()].sort((a, b) => a - b);
    checks.push(makeCheck('D-82', 'fail', zoneId, identity === n ? 'pass' : 'fail',
      `|rooms| === targetRooms (the ACHIEVED count) ${identity}/${n}`,
      [`targetRooms in [12,18] on ${inBand}/${n} (${pct(inBand, n)}) — unreachable above 16 per D-82, reported not asserted`,
        `histogram: ${keys.map((k) => `${k}:${hist.get(k)}`).join(' ')}`]));
  }
  if (results[0] && results[0].props) {
    const over = results.filter((r) => r.props.total > r.props.budget);
    const fracs = results.map((r) => r.props.total / r.props.budget);
    checks.push(makeCheck('D-80', 'fail', zoneId, over.length === 0 ? 'pass' : 'fail',
      `prop count <= propBudget (${results[0].props.budget}) on ${n - over.length}/${n}`,
      [`achieved fraction of budget: min ${(Math.min(...fracs) * 100).toFixed(1)} % / mean ${((fracs.reduce((a, b) => a + b, 0) / n) * 100).toFixed(1)} % / max ${(Math.max(...fracs) * 100).toFixed(1)} %`,
        'D-80: propBudget reads as a CEILING, not a target; the "+-5 %" band is unreachable and is not asserted']));
  }

  // --- regionCount, printed because it is what O-106 was about -------------
  const rcHist = new Map();
  for (const r of results) rcHist.set(r.regionCount, (rcHist.get(r.regionCount) || 0) + 1);
  const rcKeys = [...rcHist.keys()].sort((a, b) => a - b);
  checks.push(makeCheck('REGIONS', 'note', zoneId, 'note',
    `nav.grid.regionCount distribution over ${n} layouts, read off the live grid after world.enterZone`,
    [`histogram: ${rcKeys.map((k) => `${k}:${rcHist.get(k)}`).join(' ')}`]));
}

// ---------------------------------------------------------------------------
// CLI — `=`-form flags, `--json` a boolean switch (D-48)
// ---------------------------------------------------------------------------

const HELP_TEXT = `mapgen — 07-world-gen.md §7.1's invariants I1-I9 over the real world.enterZone pipeline

  node tools/mapgen.mjs                     full sweep, human report
  node tools/mapgen.mjs --json              the same run as JSON on stdout
  node tools/mapgen.mjs --zone=bonereach    one zone
  node tools/mapgen.mjs --seeds=20          fewer world seeds (fixtures always run)
  node tools/mapgen.mjs --runs=1            fewer runIndex values

Flags (=-form, per ruling D-48 — the shipped lootsim/balance shape, not 12 §5.1's prose):
  --seed=0xHEX      base worldSeed (default 0x1F3AC09B, 07 §7.2)
  --seeds=N         world seed count (default 200, 07 §7.2)
  --runs=N          runIndex values swept, 0..N-1 (default 3, 07 §7.2)
  --zones=a,b       zones to sweep (default all built ones)
  --zone=a          alias for --zones with one entry
  --no-fixtures     skip 07 §7.4's pinned seeds and the in-tool 12.D02 check
  --no-geometry     skip the three geometry build (T7); nav/footprints are identical
  --json            machine-readable report on stdout (boolean switch)
  --verbose         print every check's detail lines, including passing ones
  --help

Exit codes: 0 all pass | 1 an invariant failed | 2 could not run / bad flag | 3 non-determinism`;

function parseArgs(argv) {
  const args = { seed: DEFAULT_BASE_SEED, seeds: DEFAULT_SEED_COUNT, runs: DEFAULT_RUN_COUNT, zones: null, fixtures: true, geometry: true, json: false, verbose: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--verbose') { args.verbose = true; continue; }
    if (a === '--no-fixtures') { args.fixtures = false; continue; }
    if (a === '--no-geometry') { args.geometry = false; continue; }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const val = eq >= 0 ? a.slice(eq + 1) : null;
    if (key === '--difficulty') {
      throw new Error("--difficulty is not implemented: there is no difficulty-tier system in the tree (AI-11, milestone M6 — finding O-97). 12 §5.5's 5400 = 3 zones x 200 seeds x 3 runIndex x 3 tiers; the tier factor is unreachable, so this tool runs and prints what it actually evaluated instead of faking a 3x.");
    }
    if (val === null) throw new Error(`unknown flag '${a}' (=-form flags only, per D-48 — see --help)`);
    switch (key) {
      case '--seed': {
        const n = Number(val);
        if (!Number.isFinite(n)) throw new Error(`--seed: '${val}' is not a number`);
        args.seed = n >>> 0; break;
      }
      case '--seeds': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--seeds: '${val}' is not a non-negative integer`);
        args.seeds = n; break;
      }
      case '--runs': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--runs: '${val}' is not a positive integer`);
        args.runs = n; break;
      }
      case '--zones':
      case '--zone':
        args.zones = val === 'all' ? null : val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      default:
        throw new Error(`unknown flag '${key}' (see --help)`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** One layout, start to finish, through the real pipeline. This function is
 * the ONLY producer of a layout anywhere in this file. */
async function runOne(plan, worldSeed, runIndex, withGeometry) {
  const { world, nav } = await bootEngine(withGeometry);
  world.setWorldSeed(worldSeed);
  await world.enterZone(plan.id, plan.entryTag, { runIndex });
  return evaluateLayout(world, nav, plan, worldSeed, runIndex);
}

function renderHuman(report, verbose) {
  const L = [];
  L.push(`mapgen  zones=[${report.zones.join(', ')}]  seeds=${report.seeds}  runIndex=0..${report.runs - 1}  sweep=${report.layoutsSweep}  +fixtures=${report.layoutsFixtures}  total=${report.layouts}`);
  L.push(`        evaluated ${report.layouts} layouts (${report.layoutsSweep} sweep + ${report.layoutsFixtures} fixture regenerations for 12.D02). 12 §5.5 names 5400 = 3 zones x 200 seeds x 3 runIndex x 3 difficulty tiers.`);
  L.push(`        ${ZONE_PLAN.length} x 200 x 3 = ${ZONE_PLAN.length * 200 * 3}, not 5400: the missing factor is the tier sweep, and NO difficulty-tier system exists (AI-11 / M6, finding O-97).`);
  L.push(`        ${report.accounting}`);
  L.push(`        Every number below came from: world.setWorldSeed(s) -> await world.enterZone(zone, tag, {runIndex}) -> nav.grid / world.* (O-106).`);
  L.push('');

  for (const zoneId of report.zones) {
    const zoneChecks = report.checks.filter((c) => c.scope === zoneId);
    const seconds = report.perZone[zoneId] ? report.perZone[zoneId].seconds : 0;
    const layouts = report.perZone[zoneId] ? report.perZone[zoneId].layouts : 0;
    L.push(`${zoneId.padEnd(44)} ${String(layouts).padStart(5)} layouts   ${seconds.toFixed(2)} s`);
    for (const c of zoneChecks) {
      const tag = c.status === 'pass' ? 'ok' : c.status.toUpperCase();
      L.push(`  ${c.id.padEnd(18)} ${c.detail}`.padEnd(112) + `  ${tag}`);
      if (verbose || c.status !== 'pass') for (const line of c.lines) L.push(`      ${line}`);
    }
    L.push('');
  }

  // Anything not scoped to a zone that was actually swept. That is `run`-wide
  // rows plus, when a generator is missing from disk, that zone's SKIPs — the
  // old spelling special-cased `altar_of_instruction` by name and printed the
  // whole altar block a second time the moment WRLD-8 landed.
  const global = report.checks.filter((c) => !report.zones.includes(c.scope));
  if (global.length) {
    L.push('run-wide');
    for (const c of global) {
      const tag = c.status === 'pass' ? 'ok' : c.status.toUpperCase();
      L.push(`  ${c.id.padEnd(18)} ${c.detail}`.padEnd(112) + `  ${tag}`);
      if (verbose || c.status !== 'pass') for (const line of c.lines) L.push(`      ${line}`);
    }
    L.push('');
  }

  L.push(`layoutHash ${report.layoutHash}`);
  L.push(`${report.passed} pass · ${report.failed} fail · ${report.warned} warn · ${report.notes} notes · ${report.skipped} skip`);
  L.push(`layouts evaluated: ${report.layouts}   runtime: ${report.seconds.toFixed(2)} s (12 §5.5 budget 25 s)`);
  L.push(`RESULT: ${report.failed > 0 ? 'FAIL' : 'PASS'}  exit ${report.exitCode}`);
  return L.join('\n');
}

function renderJson(report) {
  return JSON.stringify(report, null, 2);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`mapgen: ${err.message}`);
    process.exit(2);
  }
  if (args.help) { console.log(HELP_TEXT); process.exit(0); }

  const t0 = process.hrtime.bigint();

  const requested = args.zones || ZONE_PLAN.map((z) => z.id);
  const unknown = requested.filter((z) => !ZONE_PLAN.some((p) => p.id === z));
  if (unknown.length) {
    console.error(`mapgen: unknown zone(s) ${unknown.join(', ')} — known: ${ZONE_PLAN.map((z) => z.id).join(', ')}`);
    process.exit(2);
  }
  const plans = ZONE_PLAN.filter((p) => requested.includes(p.id));
  const builtPlans = plans.filter((p) => p.built);

  // --- the accounting line, DERIVED — never a literal ----------------------
  // It reads the same `zoneIsBuilt()` result `ZONE_PLAN` does, so it cannot
  // disagree with what was actually swept. The first cut of this file printed
  // "altar_of_instruction has no generator … so 1800 -> 1200" as a fixed
  // string and kept printing it after WRLD-8 landed.
  const unbuiltAll = ZONE_PLAN.filter((p) => !p.built);
  const fullSweep = ZONE_PLAN.length * DEFAULT_SEED_COUNT * DEFAULT_RUN_COUNT;
  const builtSweep = ZONE_PLAN.filter((p) => p.built).length * DEFAULT_SEED_COUNT * DEFAULT_RUN_COUNT;
  const accounting = unbuiltAll.length === 0
    ? `All ${ZONE_PLAN.length} zones have a generator on disk (zoneIsBuilt() over ZONE_GENERATOR_FILES), so the full ${fullSweep} is reachable; this run swept ${builtPlans.length} zone(s) x ${args.seeds} seeds x ${args.runs} runIndex.`
    : `Of the ${ZONE_PLAN.length} zones, ${unbuiltAll.map((p) => `${p.id} (${ZONE_GENERATOR_FILES[p.id].join(', ')})`).join('; ')} has no generator on disk, so ${fullSweep} -> ${builtSweep}; this run swept ${builtPlans.length} zone(s) x ${args.seeds} seeds x ${args.runs} runIndex.`;

  const checks = [];
  const perZone = {};
  const runHash = newHash();
  let layouts = 0;
  let fixtureLayouts = 0;

  // --- the unbuilt zone: loud, counted SKIPs, never quietly dropped --------
  for (const p of plans.filter((z) => !z.built)) {
    const ids = p.id === 'altar_of_instruction' ? ['I1', 'I2', 'I3', 'I5', 'I7', 'I8'] : ['I1', 'I2', 'I3', 'I8'];
    for (const id of ids) {
      checks.push(makeCheck(id, 'skip', p.id, 'skip',
        `SKIP — ${p.generator} is not on disk (${ZONE_GENERATOR_FILES[p.id].join(', ')})`,
        [
          `07 §7.1 lists ${id} as applying to this zone; there is no generator to run it against.`,
          `world.enterZone('${p.id}', …) falls through to buildBoundaryFootprints (WRLD-1's four placeholder perimeter walls): no rooms, no arena, no teleport/summon anchors, no packs, no chests.`,
          id === 'I5' ? 'I5 needs the boss arena, the exit portal pad, 12 teleport anchors and 8 summon anchors. None exist.' : '',
          id === 'I7' ? 'I7 needs the arena floor (blocked cells within r = 16.0 m of the Altar centre = 114 +- 6). No arena exists.' : '',
          'Reported as a SKIP, not a pass (O-58: a coverage list that quietly loses a member reads as full while it is not).',
        ].filter(Boolean)));
    }
  }

  // --- the sweep ------------------------------------------------------------
  for (const plan of builtPlans) {
    const zt0 = process.hrtime.bigint();
    const results = [];
    for (let i = 0; i < args.seeds; i++) {
      const worldSeed = (args.seed + i) >>> 0;
      for (let runIndex = 0; runIndex < args.runs; runIndex++) {
        // eslint-disable-next-line no-await-in-loop
        const r = await runOne(plan, worldSeed, runIndex, args.geometry);
        results.push(r);
        hashString(runHash, r.hash);
        layouts++;
      }
    }
    perZone[plan.id] = { layouts: results.length, seconds: Number(process.hrtime.bigint() - zt0) / 1e9 };
    if (results.length === 0) {
      checks.push(makeCheck('SWEEP', 'skip', plan.id, 'skip', 'no layouts requested (--seeds=0)', []));
    } else {
      buildZoneChecks(plan.id, results, checks);
    }
  }

  // --- 07 §7.4's pinned fixture seeds + the in-tool 12.D02 check ------------
  if (args.fixtures && builtPlans.length > 0) {
    const pinned = [];
    for (const f of FIXTURE_SEEDS) {
      for (const plan of builtPlans) {
        if (f.zone !== 'all' && f.zone !== plan.id) continue;
        pinned.push({ ...f, plan });
      }
    }
    const mismatches = [];
    const hashes = [];
    for (const p of pinned) {
      // eslint-disable-next-line no-await-in-loop
      const a = await runOne(p.plan, p.seed, 0, args.geometry);
      // eslint-disable-next-line no-await-in-loop
      const b = await runOne(p.plan, p.seed, 0, args.geometry);
      hashes.push({ seed: hex(p.seed), zone: p.plan.id, exercises: p.exercises, hash: a.hash });
      if (a.hash !== b.hash) mismatches.push({ seed: hex(p.seed), zone: p.plan.id, a: a.hash, b: b.hash });
      fixtureLayouts += 2;
    }
    checks.push(makeCheck('12.D02', 'fail', 'run', mismatches.length === 0 ? 'pass' : 'fail',
      `two runs at one seed produce identical layout hashes — ${pinned.length - mismatches.length}/${pinned.length} pinned fixture runs (07 §7.4's eleven seeds; 0x00000001 is pinned for every zone)`,
      mismatches.length === 0
        ? hashes.map((h) => `${h.seed}  ${h.zone.padEnd(14)} ${h.hash}  (${h.exercises})`)
        : mismatches.map((m) => `MISMATCH ${m.seed} ${m.zone}: ${m.a} != ${m.b}`)));
    checks.push(makeCheck('FIXTURES', 'skip', 'run', 'skip',
      `07 §7.4's golden layout hashes cannot be compared — tests/fixtures/mapgen/hashes.json does not exist`,
      [
        '12 §6 lists `mapgen/ hashes.json  11 layout hashes` as a required fixture. It has never been blessed.',
        `That count is 07 §7.4's ELEVEN pinned seeds; the pinned set expands to ${pinned.length} layout hashes because 0x00000001 is pinned for every zone and ${builtPlans.length} zones are built. When WRLD-8 landed src/world/gen/altar.js the set grew from 12 to 13 — the altar's own 0x00000001 row below.`,
        'This ticket\'s file grant is tools/mapgen.mjs and tests/tools/mapgen.test.js only, so it cannot create it.',
        `The ${hashes.length} hashes measured this run are printed under 12.D02 above and are ready to be blessed by whoever owns tests/fixtures/.`,
        ...hashes.map((h) => `${h.seed}  ${h.zone.padEnd(14)} ${h.hash}  (${h.exercises})`),
      ]));
  }

  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const nonDeterministic = checks.some((c) => c.id === '12.D02' && c.status === 'fail');
  const report = {
    tool: 'mapgen',
    zones: builtPlans.map((p) => p.id),
    zonesRequested: requested,
    seeds: args.seeds,
    runs: args.runs,
    baseSeed: hex(args.seed),
    layouts: layouts + fixtureLayouts,
    layoutsSweep: layouts,
    layoutsFixtures: fixtureLayouts,
    layoutsSpecClaims: 5400,
    layoutsSpecArithmetic: fullSweep,
    layoutsBuiltZones: builtSweep,
    zonesUnbuilt: unbuiltAll.map((p) => p.id),
    accounting,
    layoutsUnreachableReason: [
      'no difficulty-tier system exists (AI-11 / M6, O-97), so 5400 -> 1800',
      ...(unbuiltAll.length ? [`${unbuiltAll.map((p) => p.id).join(', ')} has no generator on disk, so ${fullSweep} -> ${builtSweep}`] : []),
    ].join('; '),
    pipeline: 'world.setWorldSeed(seed) -> await world.enterZone(zoneId, entryTag, {runIndex}) -> nav.grid / world.entry / world.current.chests / world.packs / world.spawnPoints / world._spawnReport / world.staticFootprints',
    layoutHash: hashHex(runHash),
    perZone,
    passed: checks.filter((c) => c.status === 'pass').length,
    failed,
    warned: checks.filter((c) => c.status === 'warn').length,
    notes: checks.filter((c) => c.status === 'note').length,
    skipped: checks.filter((c) => c.status === 'skip').length,
    exitCode: nonDeterministic ? 3 : failed > 0 ? 1 : 0,
    seconds,
    checks,
  };

  console.log(args.json ? renderJson(report) : renderHuman(report, args.verbose));
  // `process.exitCode`, never `process.exit(N)` — the report can exceed the
  // 64 KB OS pipe buffer and `process.exit()` truncates a pending write
  // (balance.mjs's own note, same reasoning).
  process.exitCode = report.exitCode;
}

main().catch((err) => {
  console.error(`mapgen: could not run — ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
