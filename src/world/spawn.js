// src/world/spawn.js
//
// WRLD-9 — R11 / `07-world-gen.md` §8: `SpawnPoint[]` and `PackDescriptor[]`
// for Ashen Wastes and Bonereach. D-65 consolidates the spec's own
// `gen/spawn.js` to this path (`src/world/spawn.js`), matching how D-65 also
// folded Bonereach's `gen/bsp.js` into `gen/bonereach.js`.
//
// Pure function, headless: no `ctx`, no `three`, no `document`/`window`, no
// `performance.now()`, no `Math.random()` — every draw comes from the `S3`
// `Rng` stream a caller hands in (`07` §1.8's "spawn" fork, continued from
// whichever generator built the layout, never re-forked here — O-98). This
// file may read the LIVE nav grid it is handed (`grid.flags`/`grid.region`/
// `grid.width`/etc., the plain `NavGrid` record `01` §9.3 defines) but does
// not import `src/nav/` at all — every grid-arithmetic primitive it needs
// (`NAV_FLAG`, `cellIndexAt`) already lives in `./raster.js`, `world`'s own
// file, exactly the "one sanctioned cross-subsystem import" `src/nav/grid.js`
// itself uses in the other direction.
//
// ===========================================================================
// O-102 — walkableArea is the ENTRY REGION's area, never the whole grid
// ===========================================================================
// In the Ashen Wastes up to ~40% of nominally "walkable" cells sit in a
// region disconnected from the player's own route (the band outside the
// ridge wall, sealed void pockets) — `I4`'s `walkableArea` computed over the
// WHOLE grid inflates the denominator by up to 1.5x and reads density ~40%
// low, an order of magnitude past this ticket's ±2% band. Every walkable-area
// measurement below (`measureWalkableAreas`) filters to `grid.region[i] ===
// entryRegion` — see this ticket's own report for both figures, side by
// side, on every real sweep run.
//
// `entryRegion` itself has nowhere to come from except this file: the live
// `nav.rebuild(zone)` call (`src/nav/index.js`, verified directly, not this
// ticket's file grant) hardcodes `entry: null` on every call, so nav never
// computes an entry region at all today (`grid.region` is real — N1-N10 all
// run — but nothing ever asks `passN8EntryRegion` to look one up). This file
// recomputes it itself, once per call, straight off `grid.region` at the
// entry point's own cell — a plain read, not a second implementation of N7.
//
// ===========================================================================
// spawnDeny is likewise never stamped on the live grid — computed here
// instead, geometrically
// ===========================================================================
// The same `nav.rebuild(zone)` call hardcodes `spawnDenyMarkers: null`, so
// `NAV_FLAG.spawnDeny` is never actually set by the real pipeline (matching
// `gen/bonereach.js`'s own disclosure of the identical gap for
// `groundRegions`). Step 1's "reject if flags(c) & spawnDeny" is therefore
// implemented here as a direct geometric check against the zone's own entry
// points, chest positions (`07` §8.5's own per-zone disc radius table) and,
// for Bonereach, the whole entry room — never against the (always-zero)
// live bit.
//
// ===========================================================================
// Gameplay numbers this file must co-locate — no `data/` file is in this
// ticket's grant
// ===========================================================================
// `DIFFICULTY_MLVL_OFFSET` (authority: `03-combat-math.md` §10.2, +0/+12/+22
// — NOT `07` §8.6's own stale +0/+9/+17, which `07`:2054-2058 disclaims
// itself) is `combat`-owned per the spec, but no importable module exports
// it anywhere in this tree yet, and this file may neither import `src/combat/`
// (rule 2 — another subsystem) nor hold a `ctx` to reach it at runtime (this
// file has none). `TIER_DENSITY_MUL`/`TIER_CHAMP_MUL`/`TIER_UNIQUE_MUL` are
// `world`'s own per `07` §8.6's own table, destined for
// `src/world/data/difficulty.js` — not granted to this ticket either. All
// four tables are transcribed VERBATIM below from their cited spec sections
// (never invented), and co-located here as frozen top-level consts — the
// exact precedent `gen/ridgewalk.js`'s own `ARCHETYPE_TABLE` already set for
// "data-shaped, physically co-located instead of split into its own file
// because no such file is in scope". A follow-up ticket that IS granted the
// real data files lifts these verbatim.
//
// ===========================================================================
// `OPENING_RAMP` — imported, never redefined, and inert today because it
// does not exist yet
// ===========================================================================
// This ticket's own brief requires `OPENING_RAMP` be imported from
// `src/player/data/progression.js`, "never redefined". Read in full: that
// file's own header records D-38's ruling that PLYR-4 (M4) shipped ONLY
// `XP_TOTAL`/`XP_TABLE` from it — `OPENING_RAMP` (along with
// `CLASS_START_KIT`/`QUEST_XP`) was EXPLICITLY held back for ticket
// L1/PLYR-6, scheduled for M6. `git log -- src/player/data/progression.js`
// shows exactly one commit (PLYR-4); `OPENING_RAMP` is not exported by that
// file today — confirmed by reading it in full, not by grep alone. A literal
// `import { OPENING_RAMP } from '../player/data/progression.js'` would
// therefore throw a `SyntaxError` at module link time ("the requested module
// does not provide an export named 'OPENING_RAMP'") and break the build —
// worse than not importing at all.
//
// The import below is a NAMESPACE import (`import * as PlayerProgression`)
// instead of a named one for exactly this reason: a namespace import never
// validates that a given property exists on the module's export list —
// `PlayerProgression.OPENING_RAMP` reads as `undefined` today, harmlessly,
// and every ramp-application branch below is already guarded on truthiness.
// The moment L1/PLYR-6 lands `OPENING_RAMP` in that exact file, this file
// starts using it with NO EDIT on this file's side — genuinely "imported,
// never redefined", just inert until its dependency exists. See this
// ticket's report for the full disclosure and why step 3b falls through to
// the tier formula on every pack, every zone, in this milestone.
//
// Two more structural reasons the ramp cannot fire yet even if the table
// existed: (1) `13-progression-lore.md` §1.2's own literal `OPENING_RAMP`
// shape gates on `activeWhile(q)` reading `q.word_unquenched.step` — quest
// state (`PLYR-5`) does not exist in this milestone either, so no `quest`
// object is ever available to pass in; (2) `07` §8.3's own pseudocode calls
// `OPENING_RAMP.applies(zoneId, tier, quest)`, a method `13`'s own shape
// never defines (it has `zoneId`/`tier`/`activeWhile`/`bands` fields, no
// `.applies()` method) — a second, spec-internal inconsistency. This file
// reads `13`'s actual shape (the literal code block is the more concrete of
// the two) as authoritative: ramp applies when `zoneId === ramp.zoneId &&
// tier === ramp.tier && quest && ramp.activeWhile(quest)`.
//
// ===========================================================================
// Step 5 (affix rolling) is NOT implemented — `ai`'s job, not `world`'s
// ===========================================================================
// `07` §8's own header is explicit: "`world` produces `SpawnPoint[]` and
// `PackDescriptor[]`. `ai` reads them on `zone:ready` and calls
// `ai.spawnPack()`." Step 5's own pseudocode line
// (`ai.rollAffixes(p.rank, p.mlvl, S3, p.affixes)`) literally names `ai` as
// the caller — a pure `world` file with no `ctx` cannot call into another
// subsystem (rule 2) and has no access to `src/ai/data/monster-affixes.js`
// (out of this ticket's file grant, another subsystem's data). `p.affixes`
// is therefore left at `01-data-model.md` §9.5's own default, `[]` — matching
// this ticket's own O-88 precedent ("you meet this; report, do not fix").
// One real consequence: this file's own `S3` stream position after a call
// does NOT account for step 5's draws (1 for champion, 3 for unique) — a
// future `ai` ticket that continues drawing from the SAME `streams.S3` must
// either roll affixes at exactly this point (matching the spec's per-pack
// order) or document its own resync. Reported, not silently bridged.
//
// ===========================================================================
// Wanderers (§8.4's corridor `SpawnPoint`s) are NOT implemented — a
// disclosed scope decision, not an oversight
// ===========================================================================
// Not gated by any of this ticket's six numbered criteria (the same class as
// `gen/bonereach.js`'s own B9 dressing bonus). `01-data-model.md` §9.4's own
// frozen `SpawnPoint` shape has no field to carry a wanderer's own rolled
// archetype (`packIndex: -1` excludes it from ever reading
// `PackDescriptor.archetypeId`) — a real, disclosed spec gap this file does
// not invent a fix for. Density accuracy (criterion 1) does not depend on
// wanderers existing: `targetTotal` (§8.1) is computed once against the
// FULL entry-region walkable area (rooms + corridors, exactly matching I4's
// own cell-type-agnostic literal formula) and is entirely absorbed into
// room-based packs; corridors simply receive zero packs because they carry
// zero density-cell weight (they are not in this file's own `cells` list at
// all) — consistent with §8.2's own Bonereach table row, "corridors ...
// packs: wanderers only".
//
// ===========================================================================
// Bonereach's shipped `bestiary` is `[]` — step 2's archetype draw is
// skipped, not fabricated
// ===========================================================================
// `07` §4.1's own literal descriptor names six Bonereach archetypes; the
// SHIPPED `src/world/data/zones.js` (WRLD-1, out of this ticket's grant)
// ships `bestiary: Object.freeze([])`, explicitly marked "real bestiary is
// `06-monsters-ai.md`'s data, not read for this ticket [WRLD-1]" — the exact
// same shipped-diverges-from-spec-prose situation `gen/bonereach.js`'s own
// header already discloses for `chestCount`/`propBudget`/etc., resolved the
// same way (rule 6: read the shipped descriptor, never the spec's prose
// literal). `Rng.weighted(candidates, weights)` throws on an empty candidate
// list (by design — a malformed table should fail loudly, not silently pick
// nothing), so this file GUARDS on `descriptor.bestiary.length === 0` and
// leaves `p.archetypeId = null` rather than calling `S3.weighted` at all —
// every Bonereach pack has `archetypeId: null` in this milestone, a real,
// disclosed, verified-in-the-sweep consequence of the shipped data, not a
// bug in this file's own logic.
//
// ===========================================================================
// The path-distance field is this file's OWN 4-connected BFS, matching
// `passN7Regions`'s own connectivity exactly
// ===========================================================================
// `07` §8.5 says `pathDistanceFromEntry` is "the BFS distance field computed
// once during N7" — but the SHIPPED `raster.js#passN7Regions` (N7) computes
// REGION LABELS via a 4-connected union-find (it only ever inspects the
// west/north neighbour during its single forward pass), never a distance
// field at all, and `nav`'s own flow field (NAV-4) is windowed to 32 m
// around a target, nowhere near covering a whole 96-112 m zone from a corner
// entry. This file therefore computes its own distance field
// (`buildPathDistanceField`), seeded at the entry point, over the SAME
// 4-connected topology `passN7Regions` already uses — deliberately NOT
// 8-connected, even though a diagonal-aware Dijkstra would be a tighter
// distance estimate, because an 8-connected walk could report a cell as
// "reachable" through a diagonal gap the engine's own region model (4-
// connected) would never agree is part of the entry region, desyncing this
// file's own safety-radius check from I3's `regionAt(p) === entryRegion`
// clause. Every edge is `grid.cellSize` (a plain FIFO queue suffices — equal
// edge weights mean BFS visits cells in non-decreasing distance order, no
// priority queue needed); a cell in a different N7 region, or a disconnected
// walkable pocket, is never visited and stays at `Infinity`.
//
// ===========================================================================
// `nav.snap` is reimplemented here, not imported — same reasoning as the
// distance field
// ===========================================================================
// `src/nav/snap.js` (NAV-5) is a genuinely pure function over a `NavGrid`
// (no `ctx`), but it lives under `src/nav/` and rule 2 forbids importing it.
// `snapToWalkable` below reimplements the identical published algorithm
// (`02-api-contracts.md` §6: "nearest walkable point, null when nothing
// walkable lies within maxRadius" — fast path, box search, row-major
// scan-order tie-break, winner-only edge nudge) against this file's own
// `NAV_FLAG`/`cellIndexAt` (from `./raster.js`), scoped down to `{x,z}`
// (`SpawnPoint` carries no `y` field at all — `01` §9.4 — so `groundY` is
// never read here).
//
// ===========================================================================
// MB17 / `SPAWN_PUSHED === 0` — guaranteed by construction, not measured
// after the fact
// ===========================================================================
// §8.3's own step 7 pseudocode (`pt = c + S3.disc(p.radius); pt =
// nav.snap(pt, 2.0)`) has no explicit retry for the SEPARATE, lower
// `SpawnPoint` minimum (§8.5's own table — 11.0/10.0 m, vs the pack-centre
// minimum's 16.0/14.0 m) — and the two minima are close enough (worst case,
// straight-line: `16.0 - 5.5 = 10.5 m`, under the 11.0 m `SpawnPoint`
// minimum) that a naive single scatter draw could occasionally violate it.
// This file extends the SAME "redraw once with half radius, then place at
// the pack centre" affordance the spec's own snap-failure clause already
// grants (07 §8.3, directly under step 7) to ALSO cover the `SpawnPoint`
// minimum — not a new mechanism, the existing one applied to a second
// rejection condition. The pack centre itself is always a safe final
// fallback (it already passed the LARGER pack-centre minimum in step 1, and
// the pack-centre minimum is always > the `SpawnPoint` minimum by
// construction for every zone in `SAFETY_RADIUS` below), so this retry chain
// can never fail to produce a compliant point. `SPAWN_PUSHED` counts how
// often that final fallback was actually needed — reported, expected at 0
// across the sweep, and unlike a post-hoc "scan and nudge" correction step
// (which this file does not have at all), there is structurally nowhere for
// a non-compliant `SpawnPoint` to escape into the output.
//
// ===========================================================================
// Performance
// ===========================================================================
// `Math.hypot` is never used — every distance is `Math.sqrt(dx*dx+dz*dz)`.
// No `Map` for any per-cell/per-pack bookkeeping — plain arrays/typed
// arrays. This runs once per `enterZone` (`Alloc: yes`, "between frames" —
// the same cost class as `buildHeightField`/`_buildNavGroundY`), never a
// hot per-frame path, matching `gen/ridgewalk.js`/`gen/bonereach.js`'s own
// precedent of carrying no `.perf.test.js` sibling.

import { NAV_FLAG, cellIndexAt } from './raster.js';
import { ARCHETYPE_TABLE, cellOf, cellCentre } from './gen/ridgewalk.js';
import * as PlayerProgression from '../player/data/progression.js';

// ---------------------------------------------------------------------------
// Co-located gameplay numbers — see file header for why each lives here
// ---------------------------------------------------------------------------

/** `03-combat-math.md` §10.2, verbatim. Combat-owned by spec; no importable
 * module exports it yet — see file header. */
export const DIFFICULTY_MLVL_OFFSET = Object.freeze({ instruction: 0, trial: 12, renunciation: 22 });

/** `07` §8.6's own table, `world`'s own column — destined for
 * `src/world/data/difficulty.js`, not granted to this ticket. */
export const TIER_DENSITY_MUL = Object.freeze({ instruction: 1.0, trial: 1.1, renunciation: 1.2 });
export const TIER_CHAMP_MUL = Object.freeze({ instruction: 1.0, trial: 1.35, renunciation: 1.7 });
export const TIER_UNIQUE_MUL = Object.freeze({ instruction: 1.0, trial: 1.3, renunciation: 1.6 });

/** `07` §8.5's own per-zone table. `altar_of_instruction`/`last_bastion` are
 * out of scope (no generator exists yet for either — rule 11). */
export const SAFETY_RADIUS = Object.freeze({
  ashen_wastes: Object.freeze({ packCentreMin: 16.0, spawnPointMin: 11.0, spawnDenyDisc: 8.0 }),
  bonereach: Object.freeze({ packCentreMin: 14.0, spawnPointMin: 10.0, spawnDenyDisc: 8.0 }),
});

/** `07` §8.2's own Bonereach table. `entry` is 0.00 so the entry room can
 * never draw a pack via the weighted apportion below — matching its own
 * "the whole room is spawnDeny" note redundantly, not by special-casing it. */
export const ROOM_ROLE_DENSITY_MUL = Object.freeze({ entry: 0.0, hall: 1.0, vault: 1.35, flooded: 0.7, stair: 1.2 });

const PACK_MIN_SPACING = 9.0; // 07 §8.3 step 1, literal
const PACK_MIN_SPACING_SQ = PACK_MIN_SPACING * PACK_MIN_SPACING;

// ASSIGNED — 07 §8.3 step 1's own "disc of radius `radius`" rejection names
// a variable not yet drawn at that point in the pseudocode's own FIXED step
// order (p.radius is step 6, textually and RNG-order after step 1). Read as
// a fixed placement-quality check, not literally p.radius: the midpoint of
// the eventual 3.5..5.5 m scatter-radius range, chosen so it stays
// representative of "a typical pack's footprint" without drawing from S3
// (which would disturb the documented step order) or forward-referencing a
// value that does not exist yet. See this ticket's report.
const PLACEMENT_QUALITY_RADIUS = 4.5;
const PLACEMENT_QUALITY_MIN_FRACTION = 0.7;
const PLACEMENT_TRIES = 24; // 07 §8.3 step 1: "for tries in 0..23"

const MEMBER_SNAP_RADIUS = 2.0; // 07 §8.3 step 7, literal

// ---------------------------------------------------------------------------
// Small math helpers — no Math.hypot (ARCHITECTURE.md / this ticket's rules)
// ---------------------------------------------------------------------------

function distSq(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function distXZ(ax, az, bx, bz) {
  return Math.sqrt(distSq(ax, az, bx, bz));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Grid-cell index range covering a world-space box, clamped to the grid —
 * the same shape `raster.js`'s own (unexported) `cellRangeFor` uses, kept
 * local since it is plain index arithmetic, not gameplay data.
 * @param {object} grid @param {number} minX @param {number} maxX @param {number} minZ @param {number} maxZ
 * @returns {{cx0:number,cx1:number,cz0:number,cz1:number}} */
function cellRangeFor(grid, minX, maxX, minZ, maxZ) {
  let cx0 = Math.floor((minX - grid.originX) / grid.cellSize);
  let cx1 = Math.floor((maxX - grid.originX) / grid.cellSize);
  let cz0 = Math.floor((minZ - grid.originZ) / grid.cellSize);
  let cz1 = Math.floor((maxZ - grid.originZ) / grid.cellSize);
  if (cx0 < 0) cx0 = 0;
  if (cz0 < 0) cz0 = 0;
  if (cx1 > grid.width - 1) cx1 = grid.width - 1;
  if (cz1 > grid.height - 1) cz1 = grid.height - 1;
  return { cx0, cx1, cz0, cz1 };
}

// ---------------------------------------------------------------------------
// Path-distance field — see file header
// ---------------------------------------------------------------------------

/**
 * 4-connected BFS, in metres, seeded at `(entryX, entryZ)`. `Alloc: yes` —
 * once per call, the same cost class as `buildHeightField`.
 * @param {object} grid @param {number} entryX @param {number} entryZ
 * @returns {Float32Array} distance in metres, `Infinity` where unreachable.
 */
export function buildPathDistanceField(grid, entryX, entryZ) {
  const { width, height, flags, cellSize } = grid;
  const n = width * height;
  const dist = new Float32Array(n).fill(Infinity);
  const startIdx = cellIndexAt(grid, entryX, entryZ);
  if (startIdx < 0 || !(flags[startIdx] & NAV_FLAG.walkable)) return dist;

  const queue = new Int32Array(n);
  let qHead = 0;
  let qTail = 0;
  dist[startIdx] = 0;
  queue[qTail++] = startIdx;

  while (qHead < qTail) {
    const i = queue[qHead++];
    const cx = i % width;
    const cz = (i / width) | 0;
    const d = dist[i] + cellSize;
    if (cx + 1 < width) {
      const j = i + 1;
      if (flags[j] & NAV_FLAG.walkable && d < dist[j]) { dist[j] = d; queue[qTail++] = j; }
    }
    if (cx - 1 >= 0) {
      const j = i - 1;
      if (flags[j] & NAV_FLAG.walkable && d < dist[j]) { dist[j] = d; queue[qTail++] = j; }
    }
    if (cz + 1 < height) {
      const j = i + width;
      if (flags[j] & NAV_FLAG.walkable && d < dist[j]) { dist[j] = d; queue[qTail++] = j; }
    }
    if (cz - 1 >= 0) {
      const j = i - width;
      if (flags[j] & NAV_FLAG.walkable && d < dist[j]) { dist[j] = d; queue[qTail++] = j; }
    }
  }
  return dist;
}

function pathDistanceAt(grid, distField, x, z) {
  const idx = cellIndexAt(grid, x, z);
  return idx < 0 ? Infinity : distField[idx];
}

// ---------------------------------------------------------------------------
// snap — see file header
// ---------------------------------------------------------------------------

const CELL_EDGE_EPSILON = 1e-4; // matches src/nav/snap.js's own value

/**
 * Reimplementation of `nav.snap(x,z,maxRadius)`, scoped to `{x,z}` (no
 * `groundY` — `SpawnPoint` carries no `y`). See file header.
 * @param {object} grid @param {number} x @param {number} z @param {number} maxRadius
 * @returns {{x:number,z:number}|null}
 */
function snapToWalkable(grid, x, z, maxRadius) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(maxRadius) || maxRadius < 0) return null;

  const fastIdx = cellIndexAt(grid, x, z);
  if (fastIdx >= 0 && grid.flags[fastIdx] & NAV_FLAG.walkable) return { x, z };
  if (maxRadius === 0) return null;

  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, x - maxRadius, x + maxRadius, z - maxRadius, z + maxRadius);
  const maxRadiusSq = maxRadius * maxRadius;
  const cellSize = grid.cellSize;
  const originX = grid.originX;
  const originZ = grid.originZ;
  const flags = grid.flags;
  const width = grid.width;

  let bestSq = Infinity;
  let bestX = 0;
  let bestZ = 0;
  let bestCx = -1;
  let bestCz = -1;
  let found = false;

  for (let cz = cz0; cz <= cz1; cz++) {
    const cellMinZ = originZ + cz * cellSize;
    const cellMaxZ = cellMinZ + cellSize;
    const clampedZ = z < cellMinZ ? cellMinZ : z > cellMaxZ ? cellMaxZ : z;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const idx = rowBase + cx;
      if ((flags[idx] & NAV_FLAG.walkable) === 0) continue;
      const cellMinX = originX + cx * cellSize;
      const cellMaxX = cellMinX + cellSize;
      const clampedX = x < cellMinX ? cellMinX : x > cellMaxX ? cellMaxX : x;
      const dx = clampedX - x;
      const dz = clampedZ - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxRadiusSq) continue;
      if (d2 < bestSq) {
        bestSq = d2; bestX = clampedX; bestZ = clampedZ; bestCx = cx; bestCz = cz; found = true;
      }
    }
  }
  if (!found) return null;

  const winMaxX = originX + (bestCx + 1) * cellSize;
  if (bestX === winMaxX) bestX = winMaxX - CELL_EDGE_EPSILON;
  const winMaxZ = originZ + (bestCz + 1) * cellSize;
  if (bestZ === winMaxZ) bestZ = winMaxZ - CELL_EDGE_EPSILON;
  return { x: bestX, z: bestZ };
}

// ---------------------------------------------------------------------------
// Walkable-area measurement — §8.1's walkableArea AND §8.2's per-cell
// weight(cell), in one pass. See file header (O-102) for entryRegion.
// ---------------------------------------------------------------------------

/**
 * Two passes over the grid (still `O(n)`, not `O(n * cells.length)` twice —
 * the per-cell inner scan below is bounded, see the comment on it). Pass 1
 * gets counts + the arithmetic mean position per density cell (needed for
 * §8.2's `weight(cell)` and as the TARGET the anchor below snaps toward).
 * Pass 2 finds, for each density cell, the ACTUAL walkable-and-entry-region
 * grid cell closest to that mean — the arithmetic mean itself is not safe
 * to use directly as a placement-fallback point: a concave or scattered
 * walkable shape (a real, common outcome once footprints/gates/ravines
 * carve a macro cell up) can average to a point that is NOT itself
 * walkable at all, found directly by this ticket's own sweep as a genuine
 * "Pack centre must be walkable" failure, not a hypothetical edge case.
 * @param {object} grid @param {number} entryRegion
 * @param {{bounds:{minX:number,maxX:number,minZ:number,maxZ:number}}[]} cells
 * @returns {{entryRegionWalkableCells:number, wholeGridWalkableCells:number, perCell:{count:number,centroidX:number,centroidZ:number}[], globalCentroid:{x:number,z:number}}}
 */
function measureWalkableAreas(grid, entryRegion, cells) {
  const perCellAcc = cells.map(() => ({ count: 0, sumX: 0, sumZ: 0 }));
  let entryRegionWalkableCells = 0;
  let wholeGridWalkableCells = 0;
  let globalFallback = null; // first entry-region-walkable cell centre found (row-major) — see below

  const { width, height, originX, originZ, cellSize, flags, region } = grid;
  for (let cz = 0; cz < height; cz++) {
    const wz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      if (!(flags[i] & NAV_FLAG.walkable)) continue;
      wholeGridWalkableCells++;
      if (region[i] !== entryRegion) continue;
      entryRegionWalkableCells++;
      const wx = originX + (cx + 0.5) * cellSize;
      if (!globalFallback) globalFallback = { x: wx, z: wz };
      for (let c = 0; c < cells.length; c++) {
        const b = cells[c].bounds;
        if (wx >= b.minX && wx < b.maxX && wz >= b.minZ && wz < b.maxZ) {
          const acc = perCellAcc[c];
          acc.count++; acc.sumX += wx; acc.sumZ += wz;
          break; // density-cell bounds are disjoint by construction
        }
      }
    }
  }

  // The zone's own first-found entry-region-walkable cell centre — the safe
  // fallback-of-fallback for a density cell that has NO walkable cell at
  // all inside its own bounds (a real, disclosed O-102 consequence: a
  // macro cell can be graph-"connected" per ridgewalk's own R2/R3 walk
  // while its real rasterised floor is entirely disconnected or absent —
  // found directly by this ticket's own sweep, see the report). Guaranteed
  // walkable AND in the entry region by construction (it is one of the
  // cells this very scan just counted); a density cell's own geometric
  // bounds centre is NOT guaranteed either, which is exactly the bug this
  // replaces. `null` only when the entry region itself is empty (defensive
  // — should not occur for a real generated layout; see the caller).
  const globalCentroid = globalFallback || { x: originX + (width * cellSize) / 2, z: originZ + (height * cellSize) / 2 };

  const meanOf = perCellAcc.map((acc) => (acc.count > 0 ? { x: acc.sumX / acc.count, z: acc.sumZ / acc.count } : null));
  const anchorBestSq = new Float64Array(cells.length).fill(Infinity);
  const anchorX = new Float64Array(cells.length);
  const anchorZ = new Float64Array(cells.length);

  for (let cz = 0; cz < height; cz++) {
    const wz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      if (!(flags[i] & NAV_FLAG.walkable) || region[i] !== entryRegion) continue;
      const wx = originX + (cx + 0.5) * cellSize;
      for (let c = 0; c < cells.length; c++) {
        const mean = meanOf[c];
        if (!mean) continue;
        const b = cells[c].bounds;
        if (wx < b.minX || wx >= b.maxX || wz < b.minZ || wz >= b.maxZ) continue;
        const d2 = distSq(wx, wz, mean.x, mean.z);
        if (d2 < anchorBestSq[c]) { anchorBestSq[c] = d2; anchorX[c] = wx; anchorZ[c] = wz; }
        break; // density-cell bounds are disjoint by construction
      }
    }
  }

  const perCell = perCellAcc.map((acc, i) => {
    if (acc.count > 0) return { count: acc.count, centroidX: anchorX[i], centroidZ: anchorZ[i] };
    // No walkable-and-entry-region cell at all inside this density cell's
    // own bounds — use the whole zone's own first-found entry-region
    // walkable point instead — see this function's own comment above.
    return { count: 0, centroidX: globalCentroid.x, centroidZ: globalCentroid.z };
  });

  return { entryRegionWalkableCells, wholeGridWalkableCells, perCell, globalCentroid };
}

function qualityDiscOk(grid, x, z) {
  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, x - PLACEMENT_QUALITY_RADIUS, x + PLACEMENT_QUALITY_RADIUS, z - PLACEMENT_QUALITY_RADIUS, z + PLACEMENT_QUALITY_RADIUS);
  const r2 = PLACEMENT_QUALITY_RADIUS * PLACEMENT_QUALITY_RADIUS;
  const { width, originX, originZ, cellSize, flags } = grid;
  let total = 0;
  let walkable = 0;
  for (let cz = cz0; cz <= cz1; cz++) {
    const wz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const wx = originX + (cx + 0.5) * cellSize;
      if (distSq(wx, wz, x, z) > r2) continue;
      total++;
      if (flags[rowBase + cx] & NAV_FLAG.walkable) walkable++;
    }
  }
  return total > 0 && walkable / total >= PLACEMENT_QUALITY_MIN_FRACTION;
}

/** The entry-region walkable cell with the LARGEST `pathDistanceFromEntry`
 * — the safest possible fallback centre for a density cell with no
 * walkable area of its own (see `measureWalkableAreas`'s own comment):
 * far more likely to already clear a zone's `packCentreMin` than an
 * arbitrary (e.g. row-major-first) walkable point would be. `null` only
 * when the entry region is genuinely empty (defensive; should not occur —
 * the entry point itself is walkable by construction).
 * @param {object} grid @param {number} entryRegion @param {Float32Array} distField
 * @returns {{x:number,z:number}|null} */
function findFarthestWalkablePoint(grid, entryRegion, distField) {
  const { width, height, originX, originZ, cellSize, flags, region } = grid;
  let bestD = -1;
  let bestX = 0;
  let bestZ = 0;
  let found = false;
  for (let cz = 0; cz < height; cz++) {
    const wz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      if (!(flags[i] & NAV_FLAG.walkable) || region[i] !== entryRegion) continue;
      const d = distField[i];
      if (d === Infinity || d < bestD) continue;
      if (d > bestD) { bestD = d; bestX = originX + (cx + 0.5) * cellSize; bestZ = wz; found = true; }
    }
  }
  return found ? { x: bestX, z: bestZ } : null;
}

function isSpawnDenied(x, z, denyPoints, denyRadius, denyRegions) {
  for (let i = 0; i < denyPoints.length; i++) {
    const p = denyPoints[i];
    if (distSq(x, z, p.x, p.z) <= denyRadius * denyRadius) return true;
  }
  for (let i = 0; i < denyRegions.length; i++) {
    const r = denyRegions[i];
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §8.1 — derived budget
// ---------------------------------------------------------------------------

/** 07 §8.1, verbatim, with the round-robin redistribution the spec's own
 * prose describes. @returns {number[]} length `packCount`, summing to `targetTotal`
 * whenever `packCount*min <= targetTotal <= packCount*max` (the spec's own
 * stated precondition) — reported, not silently assumed, by the caller. */
function distributeSizes(targetTotal, packCount, sizeMin, sizeMax) {
  if (packCount <= 0) return [];
  const base = Math.floor(targetTotal / packCount);
  const remainder = targetTotal - base * packCount;
  const sizes = new Array(packCount);
  for (let i = 0; i < packCount; i++) sizes[i] = clamp(base + (i < remainder ? 1 : 0), sizeMin, sizeMax);

  let sum = sizes.reduce((a, b) => a + b, 0);
  let diff = targetTotal - sum;
  let guard = 0;
  const guardMax = packCount * 4 + 4;
  while (diff !== 0 && guard < guardMax) {
    guard++;
    let moved = false;
    if (diff > 0) {
      for (let i = 0; i < packCount && diff > 0; i++) if (sizes[i] < sizeMax) { sizes[i]++; diff--; moved = true; }
    } else {
      for (let i = 0; i < packCount && diff < 0; i++) if (sizes[i] > sizeMin) { sizes[i]--; diff++; moved = true; }
    }
    if (!moved) break;
  }
  return sizes;
}

/** 07 §8.2 — largest-remainder apportionment of `packCount` packs across
 * `weights`, deterministic tie-break (lower cell index first).
 * @param {number} packCount @param {number[]} weights @returns {number[]} */
function apportionPacks(packCount, weights) {
  const n = weights.length;
  const counts = new Array(n).fill(0);
  if (packCount <= 0 || n === 0) return counts;
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (!(sumW > 0)) {
    for (let i = 0; i < packCount; i++) counts[i % n]++;
    return counts;
  }
  const raw = weights.map((w) => (packCount * w) / sumW);
  let assigned = 0;
  for (let i = 0; i < n; i++) { counts[i] = Math.floor(raw[i]); assigned += counts[i]; }
  const remaining = packCount - assigned;
  const order = raw.map((r, i) => ({ i, frac: r - counts[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remaining; k++) counts[order[k].i]++;
  return counts;
}

/** 07 §8.4's "dead-end reward" / "vault room" forcing, applied at the
 * DENSITY-CELL level: every `forced` cell gets at least one pack, taken
 * (never fabricated) from whichever other cell currently holds the most,
 * so `Σ counts` never changes except in the documented pathological branch.
 * @returns {number} how many times the pathological (no donor) branch fired. */
function forcePacksIntoRequiredCells(counts, cells) {
  let issues = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].forced || counts[i] > 0) continue;
    let donor = -1;
    for (let j = 0; j < counts.length; j++) {
      if (j === i) continue;
      const floor = cells[j].forced ? 1 : 0;
      if (counts[j] <= floor) continue;
      if (donor === -1 || counts[j] > counts[donor]) donor = j;
    }
    if (donor === -1) { counts[i] = 1; issues++; continue; }
    counts[donor]--; counts[i] = 1;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// §8.3 step 1 — pack centre placement
// ---------------------------------------------------------------------------

/**
 * @param {{x:number,z:number}} safeFallback a point already KNOWN to satisfy
 * `packCentreMin` (`findFarthestWalkablePoint`'s own result, or the last
 * resort `measureWalkableAreas` computed) — used ONLY when all
 * `PLACEMENT_TRIES` fail. `cellCentroid` (the density cell's own walkable
 * anchor) is deliberately NOT used as that fallback: measured directly by
 * this ticket's own sweep, a density cell whose entire own walkable extent
 * sits close to the entry (a real, common case — the macro cell right next
 * to the portal, say) fails EVERY try on the `packCentreMin` check alone,
 * and its own anchor point is exactly as close, which would place a pack
 * (and therefore its members) inside the safety radius with no possible
 * compliant `SpawnPoint` — the "cell's own walkable centroid" reading of
 * this fallback (07 §8.3's own literal words) is unsound for MB17
 * specifically, not merely under-specified. See file header.
 */
function placePackCentre(S3, grid, cell, distField, packCentreMin, entryRegion, placedCentres, denyPoints, denyRadius, denyRegions, safeFallback) {
  for (let t = 0; t < PLACEMENT_TRIES; t++) {
    const x = S3.range(cell.bounds.minX, cell.bounds.maxX);
    const z = S3.range(cell.bounds.minZ, cell.bounds.maxZ);
    const idx = cellIndexAt(grid, x, z);
    if (idx < 0 || !(grid.flags[idx] & NAV_FLAG.walkable)) continue;
    if (grid.region[idx] !== entryRegion) continue; // I3 — see file header (O-102)
    if (isSpawnDenied(x, z, denyPoints, denyRadius, denyRegions)) continue;
    if (pathDistanceAt(grid, distField, x, z) < packCentreMin) continue;
    let tooClose = false;
    for (let p = 0; p < placedCentres.length; p++) {
      if (distSq(x, z, placedCentres[p].x, placedCentres[p].z) < PACK_MIN_SPACING_SQ) { tooClose = true; break; }
    }
    if (tooClose) continue;
    if (!qualityDiscOk(grid, x, z)) continue;
    return { x, z, fallback: false };
  }
  return { x: safeFallback.x, z: safeFallback.z, fallback: true };
}

// ---------------------------------------------------------------------------
// §8.3 steps 2-7 + §8.4 — the rest of one pack
// ---------------------------------------------------------------------------

function computeMlvl(descriptor, tier, zoneId, quest, centreX, centreZ, grid, distField) {
  const ramp = PlayerProgression.OPENING_RAMP; // undefined today — see file header
  if (ramp && quest && zoneId === ramp.zoneId && tier === ramp.tier && typeof ramp.activeWhile === 'function') {
    let active = false;
    try { active = !!ramp.activeWhile(quest); } catch { active = false; }
    if (active && Array.isArray(ramp.bands)) {
      const pd = pathDistanceAt(grid, distField, centreX, centreZ);
      for (const band of ramp.bands) if (pd <= band.maxPathMetres) return band.mlvl;
    }
  }
  const offset = DIFFICULTY_MLVL_OFFSET[tier] ?? 0;
  return descriptor.monsterLevel + offset;
}

function tryMemberPoint(S3, grid, centre, radius, distField, spawnPointMin, entryRegion) {
  const off = S3.disc(radius);
  const x = centre.x + off.x;
  const z = centre.z + off.z;
  const snapped = snapToWalkable(grid, x, z, MEMBER_SNAP_RADIUS);
  if (!snapped) return null;
  const idx = cellIndexAt(grid, snapped.x, snapped.z);
  if (idx < 0 || grid.region[idx] !== entryRegion) return null;
  if (pathDistanceAt(grid, distField, snapped.x, snapped.z) < spawnPointMin) return null;
  return snapped;
}

// 07 §8.3 step 7's own text grants exactly one redraw ("re-drawn once with
// half the radius; if that fails, placed at the pack centre"). Measured
// directly (this ticket's own 600-layout sweep): a pack centre sitting
// close to its own `packCentreMin` (the two minima are only ~5 m apart —
// `16.0 - 11.0` Wastes, `14.0 - 10.0` Bonereach — against a scatter radius
// up to 5.5 m) makes a SINGLE entry-ward draw, even retried once, fail
// often enough that `SPAWN_PUSHED` reads well above 0 with only that one
// redraw. MB17 demands 0, not "usually 0" — this file therefore widens the
// SAME mechanism (still "redraw, never a post-hoc correction" — see file
// header) to a short ladder of progressively smaller radii before ever
// reaching the pack-centre fallback, rather than stopping at one retry.
const MEMBER_RETRY_RADII_FRACTIONS = Object.freeze([1, 1, 0.66, 0.66, 0.4, 0.4, 0.2]);

function placeMemberPoint(S3, grid, centre, radius, distField, spawnPointMin, entryRegion) {
  for (let i = 0; i < MEMBER_RETRY_RADII_FRACTIONS.length; i++) {
    const pt = tryMemberPoint(S3, grid, centre, radius * MEMBER_RETRY_RADII_FRACTIONS[i], distField, spawnPointMin, entryRegion);
    if (pt) return pt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The core placement pass — shared by Wastes and Bonereach
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @returns {{spawnPoints:object[], packs:object[], report:object}}
 */
function runSpawnCore(opts) {
  const {
    zoneId, descriptor, tier, grid, entryRegion, distField, cells,
    denyPoints, denyRadius, denyRegions, safety, S3, quest,
  } = opts;

  const { entryRegionWalkableCells, wholeGridWalkableCells, perCell, globalCentroid } = measureWalkableAreas(grid, entryRegion, cells);
  const cellArea = grid.cellSize * grid.cellSize;
  const walkableAreaEntryRegion = entryRegionWalkableCells * cellArea;
  const walkableAreaWholeGrid = wholeGridWalkableCells * cellArea;

  // The one placement-fallback point every pack that exhausts its own
  // `PLACEMENT_TRIES` (step 1) falls back to — see `placePackCentre`'s own
  // header for why the density cell's own anchor is UNSAFE to use for this
  // (a cell whose entire walkable extent sits inside `packCentreMin` fails
  // every try on distance alone, and its own anchor is exactly as close).
  // The farthest-from-entry walkable point in the WHOLE entry region is the
  // best obtainable guarantee: if the entry region reaches `packCentreMin`
  // anywhere at all, this point satisfies it. `measureWalkableAreas`'s own
  // `globalCentroid` (a real, always-walkable point) is the last-resort
  // fallback of THIS fallback, for the defensive case `findFarthestWalkablePoint`
  // finds nothing (entry region empty — should not occur for a real layout).
  const safeFallback = findFarthestWalkablePoint(grid, entryRegion, distField) || globalCentroid;

  const tierMul = TIER_DENSITY_MUL[tier] ?? 1.0;
  const targetTotal = Math.max(0, Math.round(descriptor.densityTarget * walkableAreaEntryRegion * tierMul));
  const meanPackSize = (descriptor.packSize.min + descriptor.packSize.max) / 2;
  const packCount = clamp(Math.round(targetTotal / Math.max(1e-6, meanPackSize)), descriptor.packCount.min, descriptor.packCount.max);
  const sizes = distributeSizes(targetTotal, packCount, descriptor.packSize.min, descriptor.packSize.max);
  const achievedTotal = sizes.reduce((a, b) => a + b, 0);

  const weights = cells.map((c, i) => c.densityMul * perCell[i].count * cellArea);
  const counts = apportionPacks(packCount, weights);
  const forcingIssues = forcePacksIntoRequiredCells(counts, cells);

  // Build the ordered pack->cell assignment ("cell order", per §8.3).
  const cellIndexPerPack = [];
  for (let c = 0; c < cells.length; c++) for (let k = 0; k < counts[c]; k++) cellIndexPerPack.push(c);

  // §8.4's own guarantee ("if the zone has not yet placed its unique when
  // the LAST dead-end pack is assigned, that pack is forced to unique") only
  // has somewhere to fire when a forced cell (dead-end tip / vault room)
  // exists at all. Real generated layouts sometimes have NONE (Bonereach's
  // own B7 vault-room draw can legitimately choose 0 — no degree-1 room
  // candidates outside entry/stair; found directly by this ticket's own
  // sweep). Falling back to "force the LAST pack overall" when there is no
  // forced cell is this file's own ASSIGNED extension of the spec's stated
  // intent (exactly one unique, always) to that case — see this ticket's
  // report. It never fires when a forced cell exists (the earlier check
  // always wins first, in cell order).
  const lastForcedPackIdx = (() => {
    let last = -1;
    for (let i = 0; i < cellIndexPerPack.length; i++) if (cells[cellIndexPerPack[i]].forced) last = i;
    return last;
  })();
  const lastPackIdxOverall = cellIndexPerPack.length - 1;

  const champChanceBase = descriptor.champChance * (TIER_CHAMP_MUL[tier] ?? 1.0);
  const uniqueChanceBase = descriptor.uniqueChance * (TIER_UNIQUE_MUL[tier] ?? 1.0);

  const packs = [];
  const spawnPoints = [];
  const placedCentres = [];
  let uniquePlaced = false;
  let placementFallbackCount = 0;
  let spawnPushedCount = 0;

  for (let packIdx = 0; packIdx < cellIndexPerPack.length; packIdx++) {
    const ci = cellIndexPerPack[packIdx];
    const cell = cells[ci];

    // Step 1 — centre.
    const placed = placePackCentre(S3, grid, cell, distField, safety.packCentreMin, entryRegion, placedCentres, denyPoints, denyRadius, denyRegions, safeFallback);
    if (placed.fallback) placementFallbackCount++;
    placedCentres.push({ x: placed.x, z: placed.z });

    // Step 2 — archetype. Guarded: an empty bestiary (shipped Bonereach
    // descriptor, see file header) cannot be drawn from at all.
    const archetypeId = descriptor.bestiary.length > 0 ? S3.weighted(descriptor.bestiary, descriptor.bestiary.map(() => 1)) : null;

    // Step 3 — count, from §8.1 (not drawn).
    const count = sizes[packIdx] ?? descriptor.packSize.min;

    // Step 3b — mlvl.
    const mlvl = computeMlvl(descriptor, tier, zoneId, quest, placed.x, placed.z, grid, distField);

    // Step 4 — rank.
    const u = S3.next();
    let rank = u < uniqueChanceBase ? 'unique' : u < uniqueChanceBase + champChanceBase ? 'champion' : 'normal';
    if (rank === 'unique') {
      if (uniquePlaced) rank = 'champion';
      else uniquePlaced = true;
    }
    if (cell.forced && rank === 'normal') rank = 'champion'; // §8.4 dead-end/vault reward
    if (packIdx === lastForcedPackIdx && !uniquePlaced) { rank = 'unique'; uniquePlaced = true; } // §8.4 guarantee
    else if (lastForcedPackIdx === -1 && packIdx === lastPackIdxOverall && !uniquePlaced) { rank = 'unique'; uniquePlaced = true; } // no forced cell exists at all — see lastForcedPackIdx's own comment above

    // Step 5 — affixes: NOT rolled here, see file header.
    const affixes = [];

    // Step 6 — scatter radius.
    const radius = S3.range(3.5, 5.5);
    const aggroCloud = radius + 4.5;

    const packId = packs.length;
    packs.push({
      id: packId, archetypeId, count, rank, affixes,
      centerX: placed.x, centerZ: placed.z, radius, aggroCloud, mlvl,
      members: [], spawned: false, aliveCount: 0,
    });

    // Step 7 — member spawn points, with the safety-minimum retry chain
    // (see file header, MB17).
    for (let m = 0; m < count; m++) {
      let pt = placeMemberPoint(S3, grid, { x: placed.x, z: placed.z }, radius, distField, safety.spawnPointMin, entryRegion);
      if (!pt) { pt = { x: placed.x, z: placed.z }; spawnPushedCount++; }
      const idx = cellIndexAt(grid, pt.x, pt.z);
      spawnPoints.push({
        id: 0, x: pt.x, z: pt.z, facing: S3.range(0, Math.PI * 2),
        kind: 'pack', packIndex: packId, regionId: idx >= 0 ? grid.region[idx] : -1, consumed: false,
      });
    }
  }

  for (let i = 0; i < spawnPoints.length; i++) spawnPoints[i].id = i;

  const uniqueCount = packs.filter((p) => p.rank === 'unique').length;
  const forcedCellIndices = [];
  for (let i = 0; i < cells.length; i++) if (cells[i].forced) forcedCellIndices.push(i);
  const deadEndCellsOk = forcedCellIndices.every((ci) => {
    for (let i = 0; i < cellIndexPerPack.length; i++) {
      if (cellIndexPerPack[i] === ci && (packs[i].rank === 'champion' || packs[i].rank === 'unique')) return true;
    }
    return false;
  });

  return {
    spawnPoints, packs,
    report: {
      walkableAreaEntryRegion, walkableAreaWholeGrid,
      entryRegionWalkableCells, wholeGridWalkableCells,
      targetTotal, achievedTotal, packCount, sizesSumOk: achievedTotal === targetTotal,
      uniqueCount, deadEndCellsOk, placementFallbackCount, spawnPushedCount, forcingIssues,
      densityTarget: descriptor.densityTarget * tierMul,
      achievedDensity: walkableAreaEntryRegion > 0 ? achievedTotal / walkableAreaEntryRegion : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Public — Ashen Wastes
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.descriptor `ashen_wastes` ZoneDescriptor.
 * @param {string} args.tier `instruction`|`trial`|`renunciation`.
 * @param {object} args.grid the live `NavGrid` (`ctx.peek('nav').grid`), AFTER `nav.rebuild()`.
 * @param {ReturnType<typeof import('./gen/ridgewalk.js').generateRidgewalkLayout>} args.layout
 * @param {object} args.wastesEntries `placeRidgewalkEntries`'s own return value (`{entries, exit, chests}`).
 * @param {object} [args.quest] optional — see file header on `OPENING_RAMP`.
 * @returns {{spawnPoints:object[], packs:object[], report:object}}
 */
export function planWastesSpawns({ descriptor, tier, grid, layout, wastesEntries, quest }) {
  const S3 = layout.streams.S3;
  const entryPoint = wastesEntries.entries.portal_from_town;
  const entryIdx = cellIndexAt(grid, entryPoint.x, entryPoint.z);
  const entryRegion = entryIdx >= 0 ? grid.region[entryIdx] : -1;
  const distField = buildPathDistanceField(grid, entryPoint.x, entryPoint.z);

  const half = descriptor.cellSize / 2;
  const cells = layout.connected.map((cellId) => {
    const { cx, cz } = cellOf(cellId);
    const c = cellCentre(descriptor, cx, cz);
    return {
      id: cellId,
      densityMul: ARCHETYPE_TABLE[layout.archetypeOf[cellId]].densityX,
      bounds: { minX: c.x - half, maxX: c.x + half, minZ: c.z - half, maxZ: c.z + half },
      forced: layout.deadEndTips.includes(cellId),
    };
  });

  const denyPoints = [entryPoint, wastesEntries.entries.descent_return, ...wastesEntries.chests.map((c) => c.unsnappedPosition)];
  const safety = SAFETY_RADIUS.ashen_wastes;

  return runSpawnCore({
    zoneId: 'ashen_wastes', descriptor, tier, grid, entryRegion, distField, cells,
    denyPoints, denyRadius: safety.spawnDenyDisc, denyRegions: [], safety, S3, quest,
  });
}

// ---------------------------------------------------------------------------
// Public — Bonereach
// ---------------------------------------------------------------------------

function roomRole(roomIndex, roles) {
  if (roomIndex === roles.entry) return 'entry';
  if (roomIndex === roles.stair) return 'stair';
  if (roles.vaultRooms.includes(roomIndex)) return 'vault';
  if (roomIndex === roles.floodedRoom) return 'flooded';
  return 'hall';
}

/**
 * @param {object} args
 * @param {object} args.descriptor `bonereach` ZoneDescriptor.
 * @param {string} args.tier
 * @param {object} args.grid the live `NavGrid`, AFTER `nav.rebuild()`.
 * @param {ReturnType<typeof import('./gen/bonereach.js').generateBonereachLayout>} args.layout
 * @param {object} args.bonereachEntries `placeBonereachEntries`'s own return value's `entries`.
 * @param {object[]} args.chests `placeBonereachLoot`'s own `chests`.
 * @param {object} [args.quest]
 * @returns {{spawnPoints:object[], packs:object[], report:object}}
 */
export function planBonereachSpawns({ descriptor, tier, grid, layout, bonereachEntries, chests, quest }) {
  const S3 = layout.streams.S3;
  const entryRoom = layout.rooms[layout.roles.entry];
  const entryPoint = { x: entryRoom.centre.x, z: entryRoom.centre.z };
  const entryIdx = cellIndexAt(grid, entryPoint.x, entryPoint.z);
  const entryRegion = entryIdx >= 0 ? grid.region[entryIdx] : -1;
  const distField = buildPathDistanceField(grid, entryPoint.x, entryPoint.z);

  const cells = layout.rooms.map((room) => ({
    id: room.index,
    densityMul: ROOM_ROLE_DENSITY_MUL[roomRole(room.index, layout.roles)],
    bounds: { minX: room.x0, maxX: room.x1, minZ: room.z0, maxZ: room.z1 },
    forced: layout.roles.vaultRooms.includes(room.index),
  }));

  const denyPoints = [bonereachEntries.descent, bonereachEntries.altar_return, ...chests.map((c) => c.unsnappedPosition)];
  const denyRegions = [{ minX: entryRoom.x0, maxX: entryRoom.x1, minZ: entryRoom.z0, maxZ: entryRoom.z1 }];
  const safety = SAFETY_RADIUS.bonereach;

  return runSpawnCore({
    zoneId: 'bonereach', descriptor, tier, grid, entryRegion, distField, cells,
    denyPoints, denyRadius: safety.spawnDenyDisc, denyRegions, safety, S3, quest,
  });
}
