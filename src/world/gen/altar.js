// src/world/gen/altar.js
//
// WRLD-8 — the Altar of Instruction, `07-world-gen.md` §5: a FIXED arena.
// Pure and headless — no `three`, no `document`/`window`, no
// `performance.now()`, no `Math.random()` — so `tools/mapgen.mjs` can sweep
// it in Node. D-78 grants `src/world/build/` a narrow `three` exception;
// `src/world/gen/` gets none, and this file takes none.
//
// D-65 (binding): where the backlog's Files column and `07` §12's prose
// disagree about paths, the backlog governs. §12 row 10 names
// `src/world/gen/arena.js` + `src/world/build/altar.js`; the backlog names
// exactly one file, `src/world/gen/altar.js`. This is that file, named for
// the zone the way `gen/ridgewalk.js`/`gen/wastes.js`/`gen/bonereach.js`
// already are. **There is therefore no `src/world/build/altar.js` in this
// ticket and the arena has no visible geometry** — see this ticket's report;
// that is a disclosed gap, not an oversight.
//
// ---------------------------------------------------------------------------
// What "fixed" means here, and what the seed actually moves
// ---------------------------------------------------------------------------
// `07` §5's own sentence: "The layout is fixed. The seed drives only the
// entrance dressing, the rubble scatter, the prop rotations and the two
// guard packs in the approach corridor." Everything this file returns from
// `generateAltarLayout` is therefore a pure function of the DESCRIPTOR
// alone — the seed is not read by it at all beyond forking the seven `07`
// §1.8 streams for its callers. `runAltarDressing` (E1/E2/E4/E5) is the
// only seeded stage, and every prop it emits is `blocksNav: false`, so no
// draw it makes can ever move a nav cell. That is `07` §5.4's "E4's
// `navBlock: false` is load-bearing", enforced structurally rather than by
// convention: `toFootprints` below never even looks at the dressing list.
//
// E3 (2-3 guard packs in the approach corridor) is NOT implemented here.
// `SpawnPoint[]`/`PackDescriptor[]` are `src/world/spawn.js`'s (WRLD-9)
// surface and that file has no altar path; adding one would be a second
// ticket's file. Reported, not stubbed.
//
// ---------------------------------------------------------------------------
// The nav model: footprint negative-space, because that is all nav reads
// ---------------------------------------------------------------------------
// `src/nav/index.js#rebuild(zone)` hardcodes `groundRegions: null, entry:
// null, spawnDenyMarkers: null` on every call (verified directly; not in
// this ticket's file grant). Only `footprints` (`world.staticFootprints`)
// and `heightField` (`zone.nav.groundY`) reach `raster.js#rasterizeNav` from
// the live `world.enterZone -> nav.rebuild(instance)` path, and
// `passN2GroundStamp` with no ground regions stamps EVERY cell walkable.
// So, exactly as `gen/bonereach.js` (WRLD-7) already had to conclude, this
// generator must BLOCK everything that is not arena floor, approach
// corridor, alcove stair or altar alcove — via `Footprint`s alone. That is
// what `buildRimFootprints` does: it walks the nav grid's own 0.5 m rows,
// computes the walkable x-span of each row analytically, complements it
// inside the zone bounds, and merges vertically-identical runs into as few
// boxes as possible. The result follows the r = 17.0 m disc to within one
// cell without ever intruding inside it (each row's span is evaluated at
// the ROW CENTRE, where the circle is at its narrowest for the half of the
// row nearer the pole — so the decomposition always under-blocks slightly
// rather than eating into the floor, which is the safe direction for I7).
//
// ---------------------------------------------------------------------------
// The three terraces and `passN3Slope` — the one place this file DEVIATES
// ---------------------------------------------------------------------------
// `07` §5.1: approach `y = -0.60`, arena floor `y = 0.00`, altar dais
// `y = +0.90`. `passN3Slope` (`src/world/raster.js`) clears `walkable` on
// the higher of any two adjacent walkable cells whose ground heights differ
// by more than `0.45 m`, and `src/world/height.js` adds a +/-0.12 m cosmetic
// displacement on top of the terrace field, so a step must clear 0.45 m with
// real margin, not touch it. Both transitions are therefore built as
// per-nav-row ramps in `buildTerraces`:
//
//   * Approach: `07` §5.2 already asks for the corridor to be "ramped over
//     its last 3 m" (z in [-20, -17]). Six 0.5 m treads of 0.10 m each.
//     Implemented exactly as specified.
//   * Alcove stair: `07` §5.2 asks for "3 steps of 0.30 m" inside
//     `z in [+17.0, +17.5]`. Three 0.30 m steps IS what this file builds —
//     but 0.5 m of depth cannot hold three nav-visible treads (the nav cell
//     is 0.5 m, so all three would collapse into one 0.90 m jump and N3
//     would sever the alcove from the arena on every seed). The tread depth
//     is therefore 0.5 m each, so the stair occupies `z in [+17.0, +18.0]`
//     and the third step lands ON the dais. That extension runs INTO the
//     alcove (`z in [+17.5, +21.0]`), never into the arena, so the arena
//     disc, I7's r = 16.0 m count and every anchor are untouched. The cost
//     is that the alcove's own southernmost 0.5 m sits at +0.60 m instead of
//     +0.90 m. DISCLOSED DEVIATION — see this ticket's report.
//
// Resulting per-row ground deltas are 0.10 m (approach) and 0.30 m (stair)
// against N3's 0.45 m threshold, with the noise field able to contribute at
// most ~0.06 m between adjacent cells (0.24 m peak-to-peak over a 2 m
// lattice, bilinear => <= 0.25 * 0.24 per 0.5 m). Both clear it on every
// seed, which is why I5 is seed-independent.
//
// ---------------------------------------------------------------------------
// The SHIPPED descriptor governs, not `07` §5.1's own literal
// ---------------------------------------------------------------------------
// Same disclosure `gen/bonereach.js` already carries. `07` §5.1 declares
// `packCount {2,3}`, `packSize {4,7}`, `densityTarget 0.0075`, `champChance
// 0.35`, `bestiary ['bone_ranker','ashen_archer']`, `lightingPreset
// 'altar_ember'`, `exits [{toZone:'last_bastion', tag:'from_wastes'}]`,
// `entryTags ['gate','portal_return']`, `chestCount {1,1}`, `propBudget
// 380`. The shipped `src/world/data/zones.js` (WRLD-1, outside this
// ticket's grant) has `packCount {1,1}`, `packSize {1,6}`, `densityTarget
// 0`, `champChance 0`, `bestiary []`, `lightingPreset 'altar_instruction'`,
// `exits []`, `entryTags ['altar_entry']`, `chestCount {0,0}`, `propBudget
// 300`. This file follows the SHIPPED values:
//   * the single entry is published under the tag `altar_entry` (the only
//     tag `world.entry()` will accept for this zone), at `07` §5.2's own
//     gate position `(0, -19.0)` facing `+pi/2`;
//   * NO chest is emitted (`chestCount {0,0}`), so `07` §5.2's chest at
//     `(0, +14.0)` is absent;
//   * the exit portal pad at `(0, -13.0)` IS emitted as a `ZoneInstance
//     .portals[]` record (closed), because `07` §5.4 makes it structural
//     and its target `last_bastion` / `from_wastes` is a real shipped entry
//     tag — even though the shipped descriptor's `exits` array is empty.
// All reported, none silently reconciled.
//
// ---------------------------------------------------------------------------
// I7 — measured, and it does not reach `07` §5.4's own number
// ---------------------------------------------------------------------------
// I7 asserts "blocked cells inside r = 16.0 m of the Altar centre = 114 +/- 6",
// derived in §5.4 as `6 x ceil(pi * (0.9 + 0.3)^2 / 0.25) = 6 x 19`. That is
// an AREA estimate. `passN4FootprintStamp` blocks a cell when its CENTRE
// lies within `radius + 0.30` of the cylinder, and cell-centre sampling of a
// r = 1.20 m disc yields 16..21 cells depending on how the centre sits on
// the lattice. The six pillar centres (r = 11.5 m at 0/60/.../300 degrees,
// on a grid whose cell centres are the odd multiples of 0.25 m) all land in
// the 16-cell alignment, so the true count is **6 x 16 = 96**, on every
// layout, deterministically. The INTENT of I7 — "the arena floor is open;
// the only blockers inside r = 17.0 m are the six pillars" — holds exactly.
// The literal 114 +/- 6 is unreachable without changing the pillar radius,
// the dilation, or the pillar bearings, none of which this ticket may
// invent. Reported as a structural gap in the same class as D-80/D-82/D-83.

import { Rng } from '../../core/rng.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../data/zones.js';
import { PROTOTYPE_CATALOG } from './wastes.js';
import { RASTER } from '../raster.js';

// ---------------------------------------------------------------------------
// §5.1 / §5.2 geometry — every number below is verbatim from the spec unless
// marked ASSIGNED.
// ---------------------------------------------------------------------------

export const ARENA_RADIUS = 17.0; // m — §5.2 "Arena floor: disc, centre (0,0), radius 17.0"
export const RIM_THICKNESS = 2.5; // m — §5.2 "Arena rim: annular wall, inner radius 17.0, thickness 2.5"
export const RIM_TOP_Y = 6.5; // m — §5.2

export const PILLAR_RADIUS = 0.90; // m — §5.2 / §5.3 G6
export const PILLAR_RING_RADIUS = 11.5; // m — §5.2
export const PILLAR_TOP_Y = 7.0; // m — §5.3 G6
/** §5.2, verbatim: "angles 60, 120, 180, 240, 300, 0 (measured CCW from +X)". */
export const PILLAR_ANGLES_DEG = Object.freeze([60, 120, 180, 240, 300, 0]);

export const CORRIDOR_HALF_WIDTH = 3.0; // m — §5.2 "Rect x in [-3,+3]"
export const CORRIDOR_Z0 = -24.0; // m — §5.2
export const CORRIDOR_Z1 = -17.0; // m — §5.2
export const APPROACH_Y = -0.60; // m — §5.1
export const APPROACH_RAMP_LENGTH = 3.0; // m — §5.2 "ramped over its last 3 m"

export const GATE_Z = -17.0; // m — §5.2 "Gate arch ... at z = -17"
export const GATE_DEPTH = 1.5; // m — §5.2 "6 x 1.5 m"
export const GATE_WIDTH = 6.0; // m — §5.2
export const GATE_OPENING = 5.0; // m — §5.2 "blocked except the 5 m opening"
export const GATE_TOP_Y = 7.0; // m — §5.2

export const ALCOVE_HALF_WIDTH = 3.5; // m — §5.2 "Rect x in [-3.5,+3.5]"
export const ALCOVE_Z0 = 17.5; // m — §5.2
export const ALCOVE_Z1 = 21.0; // m — §5.2
export const DAIS_Y = 0.90; // m — §5.1

export const STAIR_HALF_WIDTH = 2.0; // m — §5.2 "4.0 m wide, x in [-2,+2]"
export const STAIR_Z0 = 17.0; // m — §5.2
export const STAIR_STEP_RISE = 0.30; // m — §5.2 "3 steps of 0.30 m"
export const STAIR_STEPS = 3; // §5.2
/** ASSIGNED — one nav cell per tread. §5.2's own `z in [17.0, 17.5]` gives
 * 0.167 m treads, which no nav row can resolve; see the file header's
 * "DISCLOSED DEVIATION". */
export const STAIR_TREAD_DEPTH = RASTER.CELL_SIZE;
export const STAIR_Z1 = STAIR_Z0 + STAIR_STEPS * STAIR_TREAD_DEPTH; // 18.5 m; the third tread IS the dais

export const ALTAR_BLOCK_HALF_W = 2.5; // m — §5.2 "Rect 5.0 x 2.0 m"
export const ALTAR_BLOCK_HALF_L = 1.0; // m — §5.2
export const ALTAR_BLOCK_Z = 19.6; // m — §5.2 "centred (0, +19.6)"
export const ALTAR_BLOCK_TOP_Y = 2.30; // m — §5.2

export const PORTAL_PAD = Object.freeze({ x: 0, z: -13.0, radius: 2.0 }); // §5.2
export const TABLET = Object.freeze({ x: 0, z: 18.2, radius: 2.0 }); // §5.2
export const BOSS_START = Object.freeze({ x: 0, z: 5.0, facing: -Math.PI / 2 }); // §5.2
export const PLAYER_ENTRY = Object.freeze({ x: 0, z: -19.0, facing: Math.PI / 2 }); // §5.2

// ---------------------------------------------------------------------------
// §5.3's fixed anchor tables — the numbers `ai` (AI-10, M6) reads.
// ---------------------------------------------------------------------------

export const SUMMON_ANCHOR_RADIUS = 7.0; // m — §5.3 G2
export const TELEPORT_INNER_RADIUS = 8.0; // m — §5.3 G4
export const TELEPORT_OUTER_RADIUS = 14.0; // m — §5.3 G4
/** §5.3 G3.2/G3.5 — the six inter-pillar bisectors. */
export const BISECTOR_ANGLES_DEG = Object.freeze([30, 90, 150, 210, 270, 330]);

function polar(radius, degrees) {
  const t = (degrees * Math.PI) / 180;
  return Object.freeze({ x: radius * Math.cos(t), z: radius * Math.sin(t), radius, angleDeg: degrees });
}

/** §5.3 G2: "eight fixed summon anchors at radius 7.0 m, at 45 intervals
 * starting at 22.5". */
export const SUMMON_ANCHORS = Object.freeze(
  Array.from({ length: 8 }, (_, i) => polar(SUMMON_ANCHOR_RADIUS, 22.5 + i * 45)),
);

/** §5.3 G4: "twelve fixed teleport anchors — six at radius 8.0 m (angles 0,
 * 60, ..., 300) and six at radius 14.0 m (on the bisectors)". Inner ring
 * first, in ascending angle, then the outer ring. */
export const TELEPORT_ANCHORS = Object.freeze([
  ...Array.from({ length: 6 }, (_, i) => polar(TELEPORT_INNER_RADIUS, i * 60)),
  ...BISECTOR_ANGLES_DEG.map((a) => polar(TELEPORT_OUTER_RADIUS, a)),
]);

export const PILLARS = Object.freeze(
  PILLAR_ANGLES_DEG.map((a, i) => {
    const p = polar(PILLAR_RING_RADIUS, a);
    return Object.freeze({ id: `P${i + 1}`, x: p.x, z: p.z, radius: PILLAR_RADIUS, topY: PILLAR_TOP_Y, angleDeg: a });
  }),
);

// ---------------------------------------------------------------------------
// §5.3 G3 — the expanding fire rings. Data only; `ai` owns the mechanic.
// ---------------------------------------------------------------------------

export const RING = Object.freeze({
  gapWidth: 4.00, // m — §5.3 G3
  spawnRadius: 3.00, // m
  deathRadius: 17.00, // m
  speed: 3.20, // m/s
  lifetime: (17.00 - 3.00) / 3.20, // 4.375 s — §5.3 G3, restated so it cannot drift
  interval: 1.55, // s
});

/** m/s — `07` §12 row 10's own traverse speed ("a 4.2 m/s agent"). */
export const TRAVERSE_SPEED = 4.2;
/** s — `07` §12 row 10's own acceptance margin. */
export const TRAVERSE_MIN_MARGIN = 1.5;

/**
 * `07` §12 row 10's scripted check, as pure geometry: for each of the six
 * bisectors, an agent starts at `r = RING.spawnRadius` diametrically
 * opposite the gap and runs the half-circumference arc to the gap.
 * §5.3 G3.3 fixes both the distance ("Arc to travel = pi * 3.0 = 9.42 m")
 * and the window (the ring's own `lifetime`), so this reproduces that model
 * rather than inventing a second one.
 *
 * `sample(x, z)` is optional: when given, every sampled point along the arc
 * is handed to it, so a caller holding a live `NavGrid` can assert the whole
 * traverse runs on walkable floor instead of trusting the geometry alone.
 * @param {(x:number, z:number, index:number)=>void} [sample]
 * @param {number} [samples] points per arc — ASSIGNED, 0.05 m resolution
 * @returns {{angleDeg:number, arcLength:number, seconds:number, margin:number}[]}
 */
export function computeBisectorTraverse(sample, samples = 200) {
  const r = RING.spawnRadius;
  const out = [];
  for (const angleDeg of BISECTOR_ANGLES_DEG) {
    const gapT = (angleDeg * Math.PI) / 180;
    const startT = gapT + Math.PI;
    if (sample) {
      for (let i = 0; i <= samples; i++) {
        // Sweep from the start angle back to the gap the short way round the
        // half-circle (either direction is the same length; -1 keeps the
        // path inside the arena regardless of which quadrant the gap is in).
        const t = startT - (Math.PI * i) / samples;
        sample(r * Math.cos(t), r * Math.sin(t), i);
      }
    }
    const arcLength = Math.PI * r;
    const seconds = arcLength / TRAVERSE_SPEED;
    out.push({ angleDeg, arcLength, seconds, margin: RING.lifetime - seconds });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terraces — `src/world/height.js`'s `{ elevation, bounds }` shape.
// ---------------------------------------------------------------------------

function terrace(elevation, minX, minZ, maxX, maxZ) {
  return Object.freeze({ elevation, bounds: Object.freeze({ minX, minZ, maxX, maxZ }) });
}

/**
 * `07` §5.1's three terraces, expanded into the per-nav-row treads N3 needs
 * (see the file header). Later entries win inside their own bounds, which is
 * `terraceElevationAt`'s documented layering rule — so the base 0.00 m layer
 * is first and every raised/sunken piece is appended after it.
 *
 * The approach terraces are cut 0.5 m wider than the corridor on each side so
 * the corridor's own edge cells cannot pick up the arena's 0.00 m by
 * accident; those cells are blocked geometry either way.
 * @returns {ReadonlyArray<{elevation:number, bounds?:object}>}
 */
export function buildTerraces() {
  const t = [Object.freeze({ elevation: 0 })]; // arena floor, boundless base — §5.1 "arena floor y = 0.00"
  const hw = CORRIDOR_HALF_WIDTH + 0.5;

  // Approach, flat part: z in [-24, -20] at -0.60.
  const rampZ0 = CORRIDOR_Z1 - APPROACH_RAMP_LENGTH; // -20.0
  t.push(terrace(APPROACH_Y, -hw, CORRIDOR_Z0, hw, rampZ0));

  // Approach ramp: six 0.5 m treads, -0.50 .. 0.00 (0.10 m per tread).
  const treads = Math.round(APPROACH_RAMP_LENGTH / RASTER.CELL_SIZE); // 6
  const rise = -APPROACH_Y / treads; // 0.10 m
  for (let i = 0; i < treads; i++) {
    const z0 = rampZ0 + i * RASTER.CELL_SIZE;
    t.push(terrace(APPROACH_Y + (i + 1) * rise, -hw, z0, hw, z0 + RASTER.CELL_SIZE));
  }

  // Alcove stair, steps 1 and 2. Step 1 is the stair block's own width
  // (x in [-2,+2]); step 2 spans the full alcove so the alcove never carries
  // two elevations across one row.
  t.push(terrace(STAIR_STEP_RISE, -STAIR_HALF_WIDTH, STAIR_Z0, STAIR_HALF_WIDTH, STAIR_Z0 + STAIR_TREAD_DEPTH));
  t.push(terrace(2 * STAIR_STEP_RISE, -ALCOVE_HALF_WIDTH, STAIR_Z0 + STAIR_TREAD_DEPTH, ALCOVE_HALF_WIDTH, STAIR_Z0 + 2 * STAIR_TREAD_DEPTH));

  // Dais — step 3 and everything north of it, at +0.90.
  t.push(terrace(DAIS_Y, -ALCOVE_HALF_WIDTH, STAIR_Z0 + 2 * STAIR_TREAD_DEPTH, ALCOVE_HALF_WIDTH, ALCOVE_Z1));

  return Object.freeze(t);
}

// ---------------------------------------------------------------------------
// The walkable-span solver and the rim/rock decomposition.
// ---------------------------------------------------------------------------

/**
 * Half-width of the walkable floor on the row through `z`, as the union of
 * the arena disc, the approach corridor, the alcove stair and the altar
 * alcove. Every one of those is symmetric about `x = 0` and every one
 * contains `x = 0`, so their union is a single interval `[-h, +h]` and the
 * union reduces to a maximum. Returns `0` when the row holds no floor at all.
 * @param {number} z
 * @returns {number}
 */
export function walkableHalfWidthAt(z) {
  let h = 0;
  if (Math.abs(z) < ARENA_RADIUS) h = Math.sqrt(ARENA_RADIUS * ARENA_RADIUS - z * z);
  if (z >= CORRIDOR_Z0 && z <= CORRIDOR_Z1 && CORRIDOR_HALF_WIDTH > h) h = CORRIDOR_HALF_WIDTH;
  if (z >= STAIR_Z0 && z <= STAIR_Z0 + STAIR_TREAD_DEPTH && STAIR_HALF_WIDTH > h) h = STAIR_HALF_WIDTH;
  if (z >= ALCOVE_Z0 && z <= ALCOVE_Z1 && ALCOVE_HALF_WIDTH > h) h = ALCOVE_HALF_WIDTH;
  return h;
}

/**
 * True when the row through `z` crosses the gate arch's 1.5 m depth.
 *
 * `07` §5.2 gives the arch as "6 x 1.5 m ... at z = -17" without saying
 * which side of `z = -17` the 1.5 m is spent on. It is spent entirely on
 * the APPROACH side (`z in [-18.5, -17.0]`), for two reasons: the arch is
 * the opening through the rim wall, whose own inner face is exactly
 * `z = -17` on this bearing, so a jamb north of that line would be a free-
 * standing block on arena floor; and measured through the live grid, an
 * arch centred on `z = -17` puts two dilated jamb cells at `(+/-2.75,
 * -15.75)`, `r = 15.99 m` — inside I7's own `r = 16.0 m` circle, which
 * would make the count depend on the gate rather than only on the six
 * pillars. Three nav rows, 1.5 m, exactly as specified.
 */
function inGateBand(z) {
  return z >= GATE_Z - GATE_DEPTH && z <= GATE_Z;
}

const EPS = 1e-9;

/** Subtracts `[lo, hi]` from a sorted, disjoint flat interval list.
 * @param {number[]} intervals flat `[lo0,hi0,lo1,hi1,...]` @param {number} lo @param {number} hi
 * @returns {number[]} */
function subtractInterval(intervals, lo, hi) {
  const out = [];
  for (let i = 0; i < intervals.length; i += 2) {
    const a = intervals[i], b = intervals[i + 1];
    if (hi <= a + EPS || lo >= b - EPS) { out.push(a, b); continue; } // no overlap
    if (a < lo - EPS) out.push(a, lo);
    if (hi < b - EPS) out.push(hi, b);
  }
  return out;
}

/** Complement of a sorted, disjoint flat interval list inside `[-half, half]`.
 * @param {number[]} intervals @param {number} half @returns {number[]} */
function complementInterval(intervals, half) {
  const out = [];
  let cursor = -half;
  for (let i = 0; i < intervals.length; i += 2) {
    if (intervals[i] > cursor + EPS) out.push(cursor, intervals[i]);
    cursor = Math.max(cursor, intervals[i + 1]);
  }
  if (half > cursor + EPS) out.push(cursor, half);
  return out;
}

/**
 * The blocked x-intervals on the row through `z`, inside `[-half, +half]`:
 * the complement of `walkableHalfWidthAt` after the gate arch's two jambs
 * have been cut out of it (`07` §5.2: a 6 m arch "blocked except the 5 m
 * opening"). Returned as a flat `[lo0, hi0, lo1, hi1, ...]` array so a run
 * of rows can be compared for equality cheaply.
 * @param {number} z @param {number} half zone half-extent, metres
 * @returns {number[]}
 */
function blockedIntervalsAt(z, half) {
  const h = walkableHalfWidthAt(z);
  let walk = h > 0 ? [-h, h] : [];
  if (inGateBand(z)) {
    const openHalf = GATE_OPENING / 2; // 2.5
    const archHalf = GATE_WIDTH / 2; // 3.0
    walk = subtractInterval(walk, -archHalf, -openHalf);
    walk = subtractInterval(walk, openHalf, archHalf);
  }
  return complementInterval(walk, half);
}

function sameIntervals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}

/**
 * The arena rim and the solid rock behind it, as axis-aligned box
 * `Footprint`s. One pass over the nav grid's own 0.5 m rows (see the file
 * header for why this is a row scan and not an analytic annulus), then a
 * vertical merge of consecutive rows whose blocked spans are identical — so
 * the straight parts (the corridor's two flanks, the far corners) collapse
 * into a handful of large boxes and only the curved rim stays per-row.
 * @param {object} descriptor
 * @returns {{x:number,z:number,halfW:number,halfL:number,topY:number}[]}
 */
export function buildRimFootprints(descriptor = ZONE_DESCRIPTORS_BY_ID.altar_of_instruction) {
  const cs = RASTER.CELL_SIZE;
  const halfX = descriptor.sizeX / 2;
  const halfZ = descriptor.sizeZ / 2;
  const rows = Math.round(descriptor.sizeZ / cs);

  const out = [];
  let runStart = 0;
  let runIntervals = blockedIntervalsAt(-halfZ + 0.5 * cs, halfX);

  const flush = (endRow) => {
    const z0 = -halfZ + runStart * cs;
    const z1 = -halfZ + endRow * cs;
    for (let k = 0; k < runIntervals.length; k += 2) {
      const lo = runIntervals[k];
      const hi = runIntervals[k + 1];
      out.push({ x: (lo + hi) / 2, z: (z0 + z1) / 2, halfW: (hi - lo) / 2, halfL: (z1 - z0) / 2, topY: RIM_TOP_Y });
    }
  };

  for (let r = 1; r < rows; r++) {
    const iv = blockedIntervalsAt(-halfZ + (r + 0.5) * cs, halfX);
    if (!sameIntervals(iv, runIntervals)) {
      flush(r);
      runStart = r;
      runIntervals = iv;
    }
  }
  flush(rows);
  return out;
}

// ---------------------------------------------------------------------------
// The layout (fixed) — `generateAltarLayout`
// ---------------------------------------------------------------------------

/**
 * `07` §5 in full, minus the seeded dressing. Forks all seven `07` §1.8
 * streams in order and hands them back live in `.streams`, the same
 * contract `gen/ridgewalk.js` established, so `runAltarDressing` continues
 * the SAME streams instead of re-forking (O-98).
 *
 * The layout itself draws NOTHING — `07` §5's "the layout is fixed" is
 * enforced by construction, not by discipline: no `Rng` is touched between
 * the seven forks and the return.
 * @param {number} seed
 * @param {object} [descriptor]
 * @returns {object}
 */
export function generateAltarLayout(seed, descriptor = ZONE_DESCRIPTORS_BY_ID.altar_of_instruction) {
  const zoneRng = new Rng(seed);
  const S0 = zoneRng.fork(); // macro   — nothing to draw: the layout is fixed
  const S1 = zoneRng.fork(); // shape   — E1 (corridor wall relief)
  const S2 = zoneRng.fork(); // dress   — E2 / E4
  const S3 = zoneRng.fork(); // spawn   — E3, not implemented here (see the file header)
  const S4 = zoneRng.fork(); // loot    — no chest (shipped chestCount {0,0})
  const S5 = zoneRng.fork(); // light   — not drawn here
  const S6 = zoneRng.fork(); // material— E5 (per-instance tint and wear)

  return {
    descriptor,
    seed,
    streams: { S0, S1, S2, S3, S4, S5, S6 },
    terraces: buildTerraces(),
    pillars: PILLARS,
    rim: buildRimFootprints(descriptor),
    summonAnchors: SUMMON_ANCHORS,
    teleportAnchors: TELEPORT_ANCHORS,
    bossStart: BOSS_START,
    portalPad: PORTAL_PAD,
    // `world.entry()` only accepts a tag the shipped descriptor declares —
    // `altar_entry` here, not §5.1's own `gate`/`portal_return`.
    entries: { altar_entry: Object.freeze({ x: PLAYER_ENTRY.x, z: PLAYER_ENTRY.z, facing: PLAYER_ENTRY.facing }) },
    portals: [
      // §5.4: "created closed and is opened by `world` on `actor:death` when
      // `actor.flags & ACTOR_FLAG.boss`". Nothing in this milestone opens it.
      { id: 0, x: PORTAL_PAD.x, z: PORTAL_PAD.z, toZone: 'last_bastion', toEntryTag: 'from_wastes', open: false },
    ],
    chests: [], // shipped `chestCount {min:0,max:0}` — see the file header
    interactables: [
      // §5.2/§9.3. Inert this milestone: `enabled: false` is exactly the
      // "sealed prompt before then" state §5.2 describes, on the same
      // mechanism as the exit portal pad.
      {
        id: 0,
        kind: 'altar',
        x: TABLET.x,
        z: TABLET.z,
        radius: TABLET.radius,
        npcId: null,
        chestId: 0,
        portalId: 0,
        toZone: null,
        toEntryTag: null,
        enabled: false,
        promptKey: 'ui.altar.sealed',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// E1/E2/E4/E5 — the only seeded stages. Every prop is `blocksNav: false`.
// ---------------------------------------------------------------------------

/** ASSIGNED prototype pools, drawn from the already-shipped
 * `PROTOTYPE_CATALOG` (rule 13 — no new game content). Only groups whose
 * `zones` column includes `altar` (G2 rubble, G3 ruin, G4 bone, G6
 * container, G7 crypt) are eligible. */
export const CORRIDOR_PROTOS = Object.freeze(['ash_drift', 'bone_shard_field', 'banner_tattered', 'skull_pile', 'rubble_interior', 'urn_clay']);
export const ARENA_RUBBLE_PROTOS = Object.freeze(['ash_drift', 'slag_shard', 'column_drum', 'flagstone_patch', 'bone_shard_field', 'rubble_interior']);
export const ALCOVE_PROTO = 'alcove_skeleton'; // §5.4 E2 "one skeletal supplicant per alcove"

export const CORRIDOR_ALCOVE_COUNT = 6; // §5.4 E1
export const CORRIDOR_PROP_COUNT = 44; // §5.4 E2
export const ARENA_RUBBLE_COUNT = 96; // §5.4 E4
export const ARENA_RUBBLE_MAX_RADIUS = 16.0; // m — §5.4 E4 "inside r < 16.0 m"
export const ARENA_RUBBLE_PILLAR_CLEARANCE = 2.0; // m — §5.4 E4
export const ARENA_RUBBLE_CENTRE_CLEARANCE = 4.0; // m — §5.4 E4
const RUBBLE_MAX_TRIES = 64; // ASSIGNED — rejection-sampling cap, see below

/**
 * `07` §5.4's E1-E5. Continues `layout.streams`; never re-forks.
 *
 * E1 draws on `S1`, E2/E4 on `S2`, E5 on `S6` — the stage-to-stream mapping
 * §5.4's own table gives. E3 (`S3`, guard packs) is deliberately absent; the
 * stream is still handed through untouched so a later spawn ticket picks it
 * up in the right state.
 * @param {ReturnType<typeof generateAltarLayout>} layout
 * @param {object} [descriptor]
 * @param {object} [streams]
 * @returns {{alcoves:object[], props:object[], rubbleRejects:number}}
 */
export function runAltarDressing(layout, descriptor = layout.descriptor, streams = layout.streams) {
  const { S1, S2, S6 } = streams;
  const alcoves = [];
  const props = [];
  let id = 0;

  // ---- E1 (S1): six alcoves in the corridor's two walls, depth
  // range(0.6, 1.2), z jittered +/-0.8 m off a 2.4 m rhythm. ASSIGNED: three
  // per side (6 total, §5.4's own count) starting 1.4 m inside the mouth.
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < CORRIDOR_ALCOVE_COUNT / 2; i++) {
      const depth = S1.range(0.6, 1.2);
      const z = CORRIDOR_Z0 + 1.4 + i * 2.4 + S1.range(-0.8, 0.8);
      alcoves.push({ side, x: side * CORRIDOR_HALF_WIDTH, z, depth });
    }
  }

  // ---- E2 (S2): 44 corridor props, one skeletal supplicant per alcove.
  for (const a of alcoves) {
    props.push({ id: id++, proto: ALCOVE_PROTO, x: a.x - a.side * (a.depth / 2), z: a.z, facing: a.side < 0 ? 0 : Math.PI, scale: 1, stage: 'E2' });
  }
  while (props.length < CORRIDOR_PROP_COUNT) {
    const proto = S2.pick(CORRIDOR_PROTOS);
    props.push({
      id: id++,
      proto,
      x: S2.range(-CORRIDOR_HALF_WIDTH + 0.4, CORRIDOR_HALF_WIDTH - 0.4),
      z: S2.range(CORRIDOR_Z0 + 0.4, CORRIDOR_Z1 - 0.4),
      facing: S2.range(0, Math.PI * 2),
      scale: S2.range(0.85, 1.15),
      stage: 'E2',
    });
  }

  // ---- E4 (S2): 96 arena rubble props. Rejection sampling against the two
  // clearances §5.4 states; a draw that never clears them after
  // RUBBLE_MAX_TRIES is counted and skipped rather than nudged, so the
  // reject count is reportable instead of hidden.
  let rubbleRejects = 0;
  const target = props.length + ARENA_RUBBLE_COUNT;
  while (props.length < target) {
    let placed = false;
    for (let attempt = 0; attempt < RUBBLE_MAX_TRIES && !placed; attempt++) {
      // sqrt-weighted radius keeps the scatter uniform over the disc.
      const r = ARENA_RUBBLE_CENTRE_CLEARANCE
        + (ARENA_RUBBLE_MAX_RADIUS - ARENA_RUBBLE_CENTRE_CLEARANCE) * Math.sqrt(S2.range(0, 1));
      const t = S2.range(0, Math.PI * 2);
      const x = r * Math.cos(t);
      const z = r * Math.sin(t);
      let ok = true;
      for (const p of PILLARS) {
        const dx = x - p.x, dz = z - p.z;
        if (Math.sqrt(dx * dx + dz * dz) < p.radius + ARENA_RUBBLE_PILLAR_CLEARANCE) { ok = false; break; }
      }
      if (!ok) { rubbleRejects++; continue; }
      props.push({ id: id++, proto: S2.pick(ARENA_RUBBLE_PROTOS), x, z, facing: S2.range(0, Math.PI * 2), scale: S2.range(0.8, 1.2), stage: 'E4' });
      placed = true;
    }
    if (!placed) { rubbleRejects++; break; }
  }

  // ---- E5 (S6): per-instance tint and wear across everything above.
  for (const p of props) {
    p.tint = S6.range(0.82, 1.08);
    p.wear = S6.range(0, 1);
    p.blocksNav = false; // §5.4 E4 — load-bearing, and true of E2 as well
    p.topY = PROTOTYPE_CATALOG[p.proto] ? PROTOTYPE_CATALOG[p.proto].topY : 0.5;
  }

  void descriptor;
  return { alcoves, props, rubbleRejects };
}

// ---------------------------------------------------------------------------
// Footprints — the only geometry that reaches nav and physics.
// ---------------------------------------------------------------------------

/** `07` §1.6 surface tags for this zone's own static geometry. */
const SURFACE_RIM = 'stone';
const SURFACE_ALTAR = 'crystal'; // §5.2 — the altar block's own surface

/**
 * `02-api-contracts.md` §4's `Footprint` shape (O-35: `blocksNav`, never
 * `navBlock`; `y`+`height`, never `baseY`/`topY`; `facing`, never
 * `rotation`; `'cylinder'`, never `'circle'`).
 *
 * DRESSING IS NOT ACCEPTED HERE, BY DESIGN — this function takes no props
 * argument at all, so `07` §5.4's "nothing inside the arena blocks
 * navigation" cannot be violated by a later caller passing the wrong list.
 * @param {ReturnType<typeof generateAltarLayout>} layout
 * @returns {object[]}
 */
export function toFootprints(layout) {
  const out = [];
  let id = 0;

  for (const r of layout.rim) {
    out.push({
      id: id++, kind: 'box', x: r.x, z: r.z, y: 0, height: r.topY,
      halfW: r.halfW, halfL: r.halfL, facing: 0,
      blocksNav: true, blocksSight: true, surface: SURFACE_RIM, destructible: false,
    });
  }

  // The gate arch's own jambs are already part of the row scan above (they
  // are blocked spans on the rows the arch occupies), so nothing is added
  // here for them — one source for that geometry, not two.

  for (const p of layout.pillars) {
    out.push({
      id: id++, kind: 'cylinder', x: p.x, z: p.z, y: 0, height: p.topY,
      radius: p.radius, facing: 0,
      blocksNav: true, blocksSight: true, surface: SURFACE_RIM, destructible: false,
    });
  }

  out.push({
    id: id++, kind: 'box', x: 0, z: ALTAR_BLOCK_Z, y: DAIS_Y, height: ALTAR_BLOCK_TOP_Y - DAIS_Y,
    halfW: ALTAR_BLOCK_HALF_W, halfL: ALTAR_BLOCK_HALF_L, facing: 0,
    blocksNav: true, blocksSight: true, surface: SURFACE_ALTAR, destructible: false,
  });

  return out;
}
