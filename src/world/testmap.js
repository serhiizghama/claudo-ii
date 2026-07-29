// src/world/testmap.js
//
// WRLD-3 — a hand-authored, non-generated test layout. `docs/BACKLOG.md`'s
// own row for PLYR-2 (M1, `src/player/move.js`, not yet built) reads "200
// scripted runs across the test map: zero wedges, zero corner sticks" — this
// file is that map. No spec section dictates its geometry (07-world-gen.md's
// R1-R10/B1-B10/E1-E5 guarantees are for the REAL generators — Ridgewalk,
// the BSP hall builder, the fixed arena — never for a hand-placed set), so
// every dimension below is ASSIGNED and chosen only to exercise the specific
// failure modes PLYR-2 checks for.
//
// ---------------------------------------------------------------------------
// Why this is not a fifth ZoneDescriptor
// ---------------------------------------------------------------------------
// This ticket's Files column is `src/world/index.js` + `src/world/testmap.js`
// only — `src/world/data/zones.js` (WRLD-1's file) is deliberately untouched.
// So this map is never registered with `world.descriptor()`/`enterZone()`;
// it is a standalone data module a caller feeds directly to `nav`, the exact
// "stub world" shape `tests/nav/nav1.test.js`'s own `makeStubWorld` already
// established and this ticket's own `tests/world/wrld3.test.js` exercises:
// `nav.rebuild()` only ever reads footprints off `ctx.get('world').static
// Footprints` and grid geometry off a `zone`-shaped bounds object — neither
// has to come from a real `WorldSystem.enterZone()` call. A future PLYR-2
// (or this ticket's own tests) hands `TESTMAP_FOOTPRINTS` to a stub
// `{ staticFootprints, current }` and `TESTMAP_BOUNDS` to `nav.rebuild()`
// exactly the way `nav1.test.js`'s `makeZone()` already does for its own
// synthetic geometry.
//
// ---------------------------------------------------------------------------
// O-35 — `Footprint` field names are `02-api-contracts.md` §4's, never
// `07-world-gen.md` §1.7's superseded ones
// ---------------------------------------------------------------------------
// `kind` is `'box' | 'cylinder' | 'poly'`, never `'circle'`/`'convex'`.
// Vertical extent is `y` + `height`, never `baseY`/`topY`. Rotation is
// `facing`, never `rotation`. Flags are `blocksNav`/`blocksSight`, never
// `navBlock`. `physics.addStatic` silently falls back to a box on an
// unrecognised `kind` — a wrong name here would produce no error and a wrong
// collider, so every footprint below is checked against this list by hand.
// `id`/`surface`/`destructible` ride on the same records as `world`'s own
// bookkeeping (unknown to `physics`/`nav`, which read only their own named
// fields) — the exact allowance `src/world/index.js`'s own
// `buildBoundaryFootprints` already uses for its perimeter walls.
//
// Node-safe: zero imports, exactly like `src/world/data/zones.js` and
// `src/world/raster.js` — no `three`, no DOM/browser global and no
// wall-clock read of any kind anywhere in this file (O-29).
//
// ---------------------------------------------------------------------------
// Layout reasoning
// ---------------------------------------------------------------------------
// A 40 x 24 m rectangle (ASSIGNED — big enough to need real pathing, small
// enough that 200 scripted runs and this ticket's own tests stay fast),
// split into two rooms by an interior wall with a single doorway, so a run
// is FORCED through a chokepoint rather than free-roaming an open box:
//
//   - Room A (x < 0): the concave pocket (the wedge trap) and the diagonal-
//     corner obstacle pair both live in open rooms — see below.
//   - Doorway at x=0, z in roughly (-0.7, 0.7) after dilation (2.0 m clear
//     opening before the 0.3 m agent dilation erodes each face — `01
//     -data-model.md`'s player collision radius is 0.36 m, so a ~1.4 m clear
//     gap is "narrow enough to matter" without being a puzzle).
//   - Room B (x > 0): a free-standing cylindrical pillar forces a detour
//     around open ground, and the two crates test the diagonal seam.
//
// Four required features (this ticket's brief), each with its own footprint
// group below:
//   1. Doorway — the two dividing-wall segments (ids 4, 5), gap at x=0.
//   2. Interior obstacle to path around — the pillar (id 6), alone in open
//      ground so there is no path OTHER than around it.
//   3. Concave pocket / wedge trap — ids 7-9, a U-shaped nook (back wall +
//      two arms) open toward the room's interior. A run that clips the
//      inner corners while cutting toward the nook's mouth is exactly the
//      "wedge" PLYR-2's criterion polices; the nook is a dead end (not on
//      any shortest path between the two far corners), so it is only
//      exercised by scripted runs that specifically probe it.
//   4. Diagonal corner (corner-stick case) — ids 10-11, two 2x2 m crates
//      whose corners touch at exactly one point and nowhere else, the same
//      construction `docs/PROGRESS.md` records NAV-2's own test already
//      using ("two 2x2m boxes touching only at a diagonal corner"). Placed
//      in open ground, off any shortest route, so it never disconnects
//      anything — it exists purely so a path solver or smoother that would
//      cut the seam has something to cut.
//
// Every wall/obstacle is placed with a wide margin from every other one
// (checked by hand below and re-checked behaviourally by
// `tests/world/wrld3.test.js`'s connectivity/path assertions) so the whole
// map stays ONE connected walkable region — PLYR-2 cannot script a run
// between two points nav reports as unreachable from each other.

/** Perimeter/interior wall dimensions — ASSIGNED, no spec value exists for a
 * hand-authored test map. Matches `src/world/data/zones.js`'s own
 * `BOUNDARY_WALL_THICKNESS`/`BOUNDARY_WALL_HEIGHT` values by coincidence,
 * not by import (this file has zero imports, on purpose — see file header). */
const WALL_THICKNESS = 0.5; // metres — ASSIGNED
const WALL_HEIGHT = 4.0; // metres — ASSIGNED
const T = WALL_THICKNESS / 2; // 0.25 — half-thickness, matches WRLD-1's own `t` convention

/** Outer half-extents — ASSIGNED. A 40 x 24 m rectangle. */
const HALF_X = 20;
const HALF_Z = 12;

/** `02-api-contracts.md` §5's `bounds()` shape — the exact fields
 * `resolveGridGeometry` (`src/nav/index.js`) reads off a `zone`-shaped
 * object when no real `ZoneInstance` exists. */
export const TESTMAP_BOUNDS = Object.freeze({
  minX: -HALF_X,
  minZ: -HALF_Z,
  maxX: HALF_X,
  maxZ: HALF_Z,
});

/** Two walkable points as far apart as the map allows (opposite corners,
 * ~41 m apart), clear of every wall's dilation band and every interior
 * obstacle — for a connectivity/path smoke test to anchor on without
 * hand-deriving safe coordinates at every call site. ASSIGNED. */
export const TESTMAP_FAR_CORNERS = Object.freeze({
  a: Object.freeze({ x: -18, z: 10 }), // room A, far from the pocket
  b: Object.freeze({ x: 18, z: -10 }), // room B, far from the pillar/crates
});

/** The doorway's centre — the single chokepoint between room A and room B. */
export const TESTMAP_DOORWAY = Object.freeze({ x: 0, z: 0 });

/**
 * The full static set, `02-api-contracts.md` §4's `Footprint` shape,
 * O-35-checked (see file header). Twelve footprints: 4 perimeter walls, 2
 * dividing-wall segments (the doorway's jambs), 1 pillar, 3 pocket walls,
 * 2 corner-touching crates.
 */
export const TESTMAP_FOOTPRINTS = Object.freeze([
  // --- Perimeter (4) — same shape as WRLD-1's buildBoundaryFootprints, hand-
  // computed here since this file imports nothing. --------------------------
  Object.freeze({
    id: 0,
    kind: 'box',
    x: 0,
    z: HALF_Z + T,
    y: 0,
    height: WALL_HEIGHT,
    halfW: HALF_X + T,
    halfL: T,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),
  Object.freeze({
    id: 1,
    kind: 'box',
    x: 0,
    z: -(HALF_Z + T),
    y: 0,
    height: WALL_HEIGHT,
    halfW: HALF_X + T,
    halfL: T,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),
  Object.freeze({
    id: 2,
    kind: 'box',
    x: HALF_X + T,
    z: 0,
    y: 0,
    height: WALL_HEIGHT,
    halfW: T,
    halfL: HALF_Z + T,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),
  Object.freeze({
    id: 3,
    kind: 'box',
    x: -(HALF_X + T),
    z: 0,
    y: 0,
    height: WALL_HEIGHT,
    halfW: T,
    halfL: HALF_Z + T,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),

  // --- Dividing wall, doorway gap at z in (-1, 1) (2.0 m clear) -------------
  Object.freeze({
    id: 4, // south segment: z in [-12, -1]
    kind: 'box',
    x: 0,
    z: -6.5,
    y: 0,
    height: WALL_HEIGHT,
    halfW: T,
    halfL: 5.5,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),
  Object.freeze({
    id: 5, // north segment: z in [1, 12]
    kind: 'box',
    x: 0,
    z: 6.5,
    y: 0,
    height: WALL_HEIGHT,
    halfW: T,
    halfL: 5.5,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),

  // --- Interior obstacle: a free-standing pillar in room B ------------------
  Object.freeze({
    id: 6,
    kind: 'cylinder',
    x: 10,
    z: 5,
    y: 0,
    height: 3.0,
    radius: 1.5,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),

  // --- Concave pocket / wedge trap, room A: a U-shaped nook whose mouth
  // opens east (toward +x, into the room). Back wall closes the west end;
  // the two arms run north/south of the opening. ----------------------------
  Object.freeze({
    id: 7, // north arm: x in [-18.25, -13.75], z in [-6.5, -6.0]
    kind: 'box',
    x: -16,
    z: -6.25,
    y: 0,
    height: WALL_HEIGHT,
    halfW: 2.25,
    halfL: 0.25,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),
  Object.freeze({
    id: 8, // south arm: x in [-18.25, -13.75], z in [-10.0, -9.5]
    kind: 'box',
    x: -16,
    z: -9.75,
    y: 0,
    height: WALL_HEIGHT,
    halfW: 2.25,
    halfL: 0.25,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),
  Object.freeze({
    id: 9, // back wall: x in [-18.75, -18.25], z in [-10.0, -6.0]
    kind: 'box',
    x: -18.5,
    z: -8,
    y: 0,
    height: WALL_HEIGHT,
    halfW: 0.25,
    halfL: 2.0,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'stone',
    destructible: false,
  }),

  // --- Diagonal corner pair, room B: two 2x2 m crates touching at exactly
  // one point, (6, -4) — crate A's NE corner is crate B's SW corner. Placed
  // in open ground, off the shortest route between the two far corners, so
  // it is a pure corner-stick probe, never a connectivity hazard. -----------
  Object.freeze({
    id: 10, // spans x [4,6], z [-6,-4]
    kind: 'box',
    x: 5,
    z: -5,
    y: 0,
    height: 2.0,
    halfW: 1.0,
    halfL: 1.0,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'wood',
    destructible: false,
  }),
  Object.freeze({
    id: 11, // spans x [6,8], z [-4,-2]
    kind: 'box',
    x: 7,
    z: -3,
    y: 0,
    height: 2.0,
    halfW: 1.0,
    halfL: 1.0,
    facing: 0,
    blocksNav: true,
    blocksSight: true,
    surface: 'wood',
    destructible: false,
  }),
]);
