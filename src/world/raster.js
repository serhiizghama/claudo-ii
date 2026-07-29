// src/world/raster.js
//
// WRLD-2 — the headless nav rasteriser: passes N1-N10 of 07-world-gen.md
// §6.2 as pure functions over (footprints, groundRegions, height). Backlog
// Files column names this path `src/world/raster.js` (07 §12 step 2's own
// prose says `src/nav/raster.js` — the backlog governs; a WRLD ticket must
// not write into `src/nav/`, NAV-1's directory).
//
// ZERO IMPORTS, ON PURPOSE. Not one `import` line, not `three`, not a Node
// built-in, not another subsystem module. That is what makes this
// importable and fully exercisable in a bare Node process with no
// `PhysicsSystem`, no DOM global, nothing — the ticket's literal acceptance
// criterion. It also keeps the file trivially relocatable the day an owner
// rules it belongs under `src/nav/` instead.
//
// ---------------------------------------------------------------------------
// O-35 — field names are `02-api-contracts.md` §4's, never `07` §1.7's
// ---------------------------------------------------------------------------
// `07-world-gen.md` §6.3's own `stampFootprint` pseudocode is written
// against the superseded `Footprint` record (`fp.navBlock`, `fp.rotation`,
// `'circle'`). `07` §13 says that record was folded into `02` §4 and is
// "kept as rationale, not as a request". This file reads `fp.blocksNav`
// (never `navBlock`), `fp.facing` (never `rotation`), `'cylinder'` (never
// `'circle'`), `'poly'` (never `'convex'`), and `fp.y`/`fp.height` (never
// `baseY`/`topY`) — the exact shape `src/world/index.js` (WRLD-1) already
// emits and `physics.addStatic` already consumes. The pseudocode's
// ALGORITHM is followed; every field name in it is translated.
//
// `Math.hypot` is never used (measured 5.73 B/call vs 0.34 B/call for
// `Math.sqrt(x*x+z*z)` on this build of Node — see ARCHITECTURE.md-adjacent
// project history). Every distance below is `Math.sqrt(dx*dx + dz*dz)`.
//
// ---------------------------------------------------------------------------
// NAV_FLAG — option (a): transcribed locally, not taken as a parameter
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §6 says `nav` "Owns exclusively: ... NAV_FLAG", but
// `NAV_FLAG` is *defined* in `01-data-model.md` §9.3 and this file's pure
// functions must write those exact bits, today, before `src/nav/` exists
// (NAV-1 is the next ticket). Option (b) — take the flags as a parameter —
// would make every call site thread a constants object that never varies,
// for no real flexibility (the bit values are a wire format other systems
// read directly; they cannot vary per call without breaking every reader).
// Option (a) is chosen: the bits are transcribed below, verbatim, from `01`
// §9.3, clearly marked, so NAV-1 can re-export or re-own this exact object
// (import it from here, or copy it — either is a one-line change) without
// this file ever having imported anything.
export const NAV_FLAG = Object.freeze({
  walkable: 1 << 0,
  blocked: 1 << 1,
  hazard: 1 << 2,
  water: 1 << 3,
  doorway: 1 << 4,
  spawnDeny: 1 << 5,
  interior: 1 << 6,
});

// ---------------------------------------------------------------------------
// Constants this file must assign because no spec table gives a literal —
// each cited beside its source, per this ticket's rule 6.
// ---------------------------------------------------------------------------
export const RASTER = Object.freeze({
  CELL_SIZE: 0.5, // 01 §9.3 — fixed across all zones
  DILATION: 0.3, // 07 §6.3 — agent dilation; NOT the 0.36 m player radius (see §6.3's own reasoning)
  NEAR_WALL_MARGIN: 0.3536, // 07 §6.3 — "half a cell diagonal"
  PRUNE_MIN_CELLS: 16, // 07 §6.2 N10 — "fewer than 16 cells (4 sq m)"
  COST_BLOCKED: 255, // 07 §6.4
  COST_MAX: 254, // 07 §6.4 — "clamped to 254"
  COST_NEAR_WALL: 2, // 07 §6.4
  COST_WATER: 6, // 07 §6.4
  COST_HAZARD: 12, // 07 §6.4
  DOORWAY_MAX_WALKABLE_NEIGHBOURS: 4, // 07 §6.2 N5 — "8-neighbourhood contains <= 4 walkable cells"
  SLOPE_MAX_DELTA: 0.45, // 07 §6.2 N3 — "|delta height| > 0.45 m"
  ENTRY_SPAWN_DENY_RADIUS: 8.0, // 07 §6.2 N9
  PORTAL_SPAWN_DENY_RADIUS: 8.0, // 07 §6.2 N9
  CHEST_SPAWN_DENY_RADIUS: 4.0, // 07 §6.2 N9
});

const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------
// groundRegions / height — OPTIONAL inputs, and what "absent" means
// ---------------------------------------------------------------------------
// WRLD-1's scope did not build `src/world/height.js` or a ground-region
// emitter (07 §12 step 1's own two-file rule). The acceptance criterion
// reads "from footprints alone", so both are accepted as optional and each
// pass documents its own absent-input fallback (passN2GroundStamp,
// passN3Slope below). No `GroundRegion` type is defined anywhere in the
// read spec files (checked: 07-world-gen.md only ever describes one in
// prose — "a terrace rect/disc, a room, a corridor, a gate" — 01/02 name no
// record for it). The shape used here is this file's own minimal,
// documented invention, built only from vocabulary the spec already uses
// elsewhere (box/cylinder-style kind, `facing`, `interior`/`water`/
// `doorway` — the same names `NAV_FLAG` and `Footprint` already use):
//
//   GroundRegion = {
//     kind: 'box' | 'disc',
//     x, z,                 // centre
//     halfW, halfL,         // 'box' only
//     radius,                // 'disc' only
//     facing: 0,             // radians, 'box' only, optional
//     interior: false,       // N2: stamp NAV_FLAG.interior
//     water: false,          // N2: stamp NAV_FLAG.water
//     doorway: false,        // N5 only: stamp NAV_FLAG.doorway (07 §6.2 N5's
//                            // "footprint-emitted doorway rect" clause)
//   }
//
// Whichever later ticket builds the real ground-region emitter either
// adopts this shape or this file's readers get updated in the same commit
// as that emitter — nothing here is a public contract, since (rule 7) this
// module is internal and not a `ctx.get()` surface.

/**
 * True when `facing` is within floating-point epsilon of a multiple of
 * pi/2 — 07 §6.3's `fp.rotation % (pi/2) === 0` check, translated off exact
 * modulo (never safe for radians) onto a tolerance.
 * @param {number} facing
 * @returns {boolean}
 */
function isAxisAlignedFacing(facing) {
  const EPS = 1e-6;
  const m = ((facing % HALF_PI) + HALF_PI) % HALF_PI;
  return m < EPS || HALF_PI - m < EPS;
}

/**
 * Nearest quadrant (0..3, i.e. 0/90/180/270 degrees) for an axis-aligned
 * `facing` — odd quadrants swap a box's halfW/halfL for AABB purposes.
 * @param {number} facing
 * @returns {number}
 */
function quadrantOf(facing) {
  let q = Math.round(facing / HALF_PI) % 4;
  if (q < 0) q += 4;
  return q;
}

/**
 * Writes a box's four corners (world space, CCW) into `out` (a
 * length-8 scratch buffer, reused across calls — no per-call allocation).
 * CCW winding verified by shoelace sign against a unit square at facing=0;
 * `convexPolyDistance`'s inside/outside sign convention depends on it.
 * @param {number} cx @param {number} cz @param {number} halfW @param {number} halfL
 * @param {number} facing @param {Float64Array} out
 */
function boxCorners(cx, cz, halfW, halfL, facing, out) {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  const lx0 = halfW, lz0 = halfL;
  const lx1 = -halfW, lz1 = halfL;
  const lx2 = -halfW, lz2 = -halfL;
  const lx3 = halfW, lz3 = -halfL;
  out[0] = cx + lx0 * c - lz0 * s; out[1] = cz + lx0 * s + lz0 * c;
  out[2] = cx + lx1 * c - lz1 * s; out[3] = cz + lx1 * s + lz1 * c;
  out[4] = cx + lx2 * c - lz2 * s; out[5] = cz + lx2 * s + lz2 * c;
  out[6] = cx + lx3 * c - lz3 * s; out[7] = cz + lx3 * s + lz3 * c;
}

/**
 * Signed distance from (px,pz) to a convex, CCW polygon given as a flat
 * [x0,z0,x1,z1,...] array (`count` vertices) — negative inside, positive
 * outside. Standard nearest-edge-with-inside-test SDF (Inigo Quilez's
 * sdPolygon, the well-known form); one `Math.sqrt` per call, never
 * `Math.hypot` (see file header). Allocation-free: reads `points` in place,
 * no array/object created.
 * @param {number} px @param {number} pz @param {ArrayLike<number>} points @param {number} count
 * @returns {number}
 */
function convexPolyDistance(px, pz, points, count) {
  let minDistSq = Infinity;
  let inside = true;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = points[i * 2], az = points[i * 2 + 1];
    const bx = points[j * 2], bz = points[j * 2 + 1];
    const ex = bx - ax, ez = bz - az;
    const wx = px - ax, wz = pz - az;
    const edgeLenSq = ex * ex + ez * ez;
    let t = edgeLenSq > 0 ? (wx * ex + wz * ez) / edgeLenSq : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const nx = ax + ex * t, nz = az + ez * t;
    const dx = px - nx, dz = pz - nz;
    const distSq = dx * dx + dz * dz;
    if (distSq < minDistSq) minDistSq = distSq;
    const cross = ex * wz - ez * wx;
    if (cross < 0) inside = false;
  }
  const dist = Math.sqrt(minDistSq);
  return inside ? -dist : dist;
}

/**
 * Point-in-groundRegion test (box, with optional rotation, or disc). Used
 * by N2 (ground stamp) and N5 (doorway-rect clause), and by N9's
 * `entryRooms`.
 * @param {number} px @param {number} pz @param {object} region
 * @returns {boolean}
 */
function pointInGroundRegion(px, pz, region) {
  if (region.kind === 'disc') {
    const dx = px - region.x, dz = pz - region.z;
    const r = region.radius;
    return dx * dx + dz * dz <= r * r;
  }
  // 'box'
  const facing = region.facing || 0;
  let lx, lz;
  if (facing === 0) {
    lx = px - region.x;
    lz = pz - region.z;
  } else {
    const c = Math.cos(-facing), s = Math.sin(-facing);
    const dx = px - region.x, dz = pz - region.z;
    lx = dx * c - dz * s;
    lz = dx * s + dz * c;
  }
  return Math.abs(lx) <= region.halfW && Math.abs(lz) <= region.halfL;
}

/**
 * World (x,z) -> cell (cx,cz), unclamped. 01-data-model.md §9.3's formula,
 * axis order verified against this ticket's own instructions: `cx = floor((x
 * - originX) / cellSize)`, likewise for z.
 * @param {object} grid @param {number} x @param {number} z
 * @returns {{cx: number, cz: number}}
 */
export function worldToCell(grid, x, z) {
  return {
    cx: Math.floor((x - grid.originX) / grid.cellSize),
    cz: Math.floor((z - grid.originZ) / grid.cellSize),
  };
}

/**
 * World (x,z) -> flat cell index (`cz * width + cx`), or -1 when the point
 * falls outside the grid. Allocation-free (no intermediate object).
 * @param {object} grid @param {number} x @param {number} z
 * @returns {number}
 */
export function cellIndexAt(grid, x, z) {
  const cx = Math.floor((x - grid.originX) / grid.cellSize);
  const cz = Math.floor((z - grid.originZ) / grid.cellSize);
  if (cx < 0 || cx >= grid.width || cz < 0 || cz >= grid.height) return -1;
  return cz * grid.width + cx;
}

/**
 * Allocates a fresh `NavGrid` — 01-data-model.md §9.3's exact five typed
 * arrays and shape. Rule 5: this is the one-time allocation; the per-pass
 * functions below never allocate per cell.
 * @param {{cellSize?: number, width: number, height: number, originX: number, originZ: number}} opts
 * @returns {object}
 */
export function createNavGrid({ cellSize = RASTER.CELL_SIZE, width, height, originX, originZ }) {
  const n = width * height;
  return {
    cellSize,
    width,
    height,
    originX,
    originZ,
    flags: new Uint8Array(n),
    cost: new Uint8Array(n),
    region: new Int16Array(n), // signed — -1 means blocked (01 §9.3)
    groundY: new Float32Array(n),
    regionCount: 0,
    version: 0, // N11 (nav's own ticket) owns bumping this; never written here
  };
}

/**
 * Allocates the scratch buffers every pass below reuses, sized once to
 * `width*height` (a safe upper bound for every quantity they hold — label
 * counts, region counts and remap tables can never exceed the cell count).
 * Build once per grid lifetime, pass into every `passN*` call; no `passN*`
 * function allocates one of these itself.
 * @param {number} width @param {number} height
 * @returns {object}
 */
export function createRasterScratch(width, height) {
  const n = width * height;
  return {
    nearWall: new Uint8Array(n), // N4 scratch, consumed by N6 (07 §6.3)
    walkableSnapshot: new Uint8Array(n), // N3 scratch — pre-mutation snapshot, see passN3Slope
    labelOf: new Int32Array(n), // N7 scratch — provisional/resolved union-find label per cell
    unionParent: new Int32Array(n), // N7 scratch — union-find parent, indexed by provisional label id
    unionRank: new Uint8Array(n), // N7 scratch — union-find rank
    rootToRegion: new Int32Array(n), // N7 scratch — resolved root -> dense region id
    regionSize: new Int32Array(n), // N10 scratch — cell count per region id (post-N7)
    oldToNewRegion: new Int32Array(n), // N10 scratch — region id remap after pruning
    boxCorners: new Float64Array(8), // N4 scratch — rotated-box corner buffer, reused per footprint
  };
}

// ---------------------------------------------------------------------------
// N1 — Clear
// ---------------------------------------------------------------------------

/** 07 §6.2 N1: `flags = 0`, `cost = 255`, `region = -1` — three `fill()` calls.
 * @param {object} grid */
export function passN1Clear(grid) {
  grid.flags.fill(0);
  grid.cost.fill(RASTER.COST_BLOCKED);
  grid.region.fill(-1);
  grid.regionCount = 0;
}

// ---------------------------------------------------------------------------
// N2 — Ground stamp
// ---------------------------------------------------------------------------

/**
 * 07 §6.2 N2: scanline over each ground region, stamping `walkable`,
 * `interior`, `water`.
 *
 * ABSENT-INPUT DECISION (no ground-region emitter exists yet — see file
 * header): when `groundRegions` is `null`/`undefined`/empty, every cell is
 * stamped walkable (no `interior`, no `water`). This is what makes
 * "rasterise from footprints alone" possible at all — N4 (footprint stamp)
 * is what then carves the actually-blocked cells out of this all-walkable
 * base. A caller that DOES have ground regions gets the real, precise
 * scanline instead; the two modes never mix (regions given -> per-region
 * scanline is the only source of `walkable`; regions absent -> the
 * whole-grid fallback is the only source).
 * @param {object} grid @param {object[]|null|undefined} groundRegions
 */
export function passN2GroundStamp(grid, groundRegions) {
  const { flags, width, height } = grid;
  if (!groundRegions || groundRegions.length === 0) {
    flags.fill(NAV_FLAG.walkable);
    return;
  }
  for (let r = 0; r < groundRegions.length; r++) {
    stampGroundRegionWalkable(grid, groundRegions[r]);
  }
  void width; void height; // kept for symmetry with other passes' destructuring
}

function regionAabb(region) {
  if (region.kind === 'disc') {
    return { minX: region.x - region.radius, maxX: region.x + region.radius, minZ: region.z - region.radius, maxZ: region.z + region.radius };
  }
  const facing = region.facing || 0;
  if (facing === 0) {
    return { minX: region.x - region.halfW, maxX: region.x + region.halfW, minZ: region.z - region.halfL, maxZ: region.z + region.halfL };
  }
  // Conservative rotated-box AABB via the diagonal — cheap and correct
  // (never under-covers); exactness is not required for a scan bound.
  const diag = Math.sqrt(region.halfW * region.halfW + region.halfL * region.halfL);
  return { minX: region.x - diag, maxX: region.x + diag, minZ: region.z - diag, maxZ: region.z + diag };
}

function cellRangeFor(grid, minX, maxX, minZ, maxZ) {
  let cx0 = Math.floor((minX - grid.originX) / grid.cellSize);
  let cx1 = Math.floor((maxX - grid.originX) / grid.cellSize);
  let cz0 = Math.floor((minZ - grid.originZ) / grid.cellSize);
  let cz1 = Math.floor((maxZ - grid.originZ) / grid.cellSize);
  if (cx0 < 0) cx0 = 0;
  if (cx1 > grid.width - 1) cx1 = grid.width - 1;
  if (cz0 < 0) cz0 = 0;
  if (cz1 > grid.height - 1) cz1 = grid.height - 1;
  return { cx0, cx1, cz0, cz1 };
}

function stampGroundRegionWalkable(grid, region) {
  const { flags, width, cellSize, originX, originZ } = grid;
  const { minX, maxX, minZ, maxZ } = regionAabb(region);
  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, minX, maxX, minZ, maxZ);
  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = originX + (cx + 0.5) * cellSize;
      if (!pointInGroundRegion(px, pz, region)) continue;
      const i = rowBase + cx;
      flags[i] |= NAV_FLAG.walkable;
      if (region.interior) flags[i] |= NAV_FLAG.interior;
      if (region.water) flags[i] |= NAV_FLAG.water;
    }
  }
}

// ---------------------------------------------------------------------------
// N3 — Slope
// ---------------------------------------------------------------------------

/**
 * 07 §6.2 N3: for each walkable cell, if a 4-neighbour is walkable and
 * `|delta height| > 0.45 m`, clear `walkable` and set `blocked` on the
 * HIGHER of the two. Runs over a snapshot of N2's walkable output (per the
 * spec: "so the result does not depend on iteration order") — every
 * undirected edge (right, down) is visited exactly once, and both cells'
 * heights are read from the snapshot, never from a value this same pass
 * may already have mutated.
 *
 * ABSENT-INPUT DECISION: `src/world/height.js` does not exist yet (WRLD-1's
 * documented gap). When `heightField` is `null`/`undefined` this pass is a
 * no-op — there is no elevation data to compare, so nothing CAN be blocked
 * by slope, which is the only honest behaviour (fabricating a flat height
 * field of all-zeros would produce the identical no-op result anyway, since
 * every delta would read 0). A later ticket supplies a real `Float32Array`
 * of length `width*height`, cell-indexed exactly like `grid.groundY`.
 * @param {object} grid @param {Float32Array|null|undefined} heightField @param {object} scratch
 */
export function passN3Slope(grid, heightField, scratch) {
  if (!heightField) return;
  const { flags, width, height } = grid;
  const n = width * height;
  const snapshot = scratch.walkableSnapshot;
  for (let i = 0; i < n; i++) snapshot[i] = flags[i] & NAV_FLAG.walkable ? 1 : 0;

  for (let cz = 0; cz < height; cz++) {
    const rowBase = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      if (!snapshot[i]) continue;
      const hi = heightField[i];
      if (cx + 1 < width) {
        const j = i + 1;
        if (snapshot[j] && Math.abs(hi - heightField[j]) > RASTER.SLOPE_MAX_DELTA) {
          const target = hi > heightField[j] ? i : j;
          flags[target] |= NAV_FLAG.blocked;
          flags[target] &= ~NAV_FLAG.walkable;
        }
      }
      if (cz + 1 < height) {
        const j = i + width;
        if (snapshot[j] && Math.abs(hi - heightField[j]) > RASTER.SLOPE_MAX_DELTA) {
          const target = hi > heightField[j] ? i : j;
          flags[target] |= NAV_FLAG.blocked;
          flags[target] &= ~NAV_FLAG.walkable;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// N4 — Footprint stamp (07 §6.3)
// ---------------------------------------------------------------------------

/**
 * 07 §6.3's `stampFootprint`, algorithm preserved, every field name
 * translated to `02` §4's live `Footprint` (see file header, O-35).
 *
 * DEVIATION FROM THE LITERAL PSEUDOCODE, documented: §6.3 says "box = aabb(fp)
 * expanded by d" for the SCAN-RANGE bound, using only the dilation `d`
 * (0.30), not `d + NEAR_WALL_MARGIN` (0.3536). Worked through by hand: with
 * footprint edges landing on 0.5 m cell boundaries (§1.2) and cells sampled
 * at their centres, a scan range expanded by `d` alone can, for some grid
 * alignments (e.g. a rotated box's corner region, or a cylinder), fail to
 * reach a cell whose centre sits in the true near-wall band `(d, d +
 * 0.3536]` — that band is real geometry, not an iteration artefact, and
 * clipping it would silently under-report `nearWall` depending on grid
 * alignment. This implementation expands the scan range by `d +
 * NEAR_WALL_MARGIN` instead, so every cell that could possibly qualify for
 * either bucket is always visited. The cost is a handful of extra cells
 * scanned per footprint (worth well under the §6.5 budget) in exchange for
 * an alignment-independent result.
 * @param {object} grid @param {object[]} footprints @param {object} scratch
 */
export function passN4FootprintStamp(grid, footprints, scratch) {
  scratch.nearWall.fill(0);
  if (!footprints || footprints.length === 0) return;
  for (let f = 0; f < footprints.length; f++) {
    const fp = footprints[f];
    if (!fp.blocksNav) continue; // O-35: blocksNav, never navBlock
    stampOneFootprint(grid, fp, scratch);
  }
}

function stampOneFootprint(grid, fp, scratch) {
  const { flags, cost, width, cellSize, originX, originZ } = grid;
  const nearWall = scratch.nearWall;
  const corners = scratch.boxCorners;
  const D = RASTER.DILATION;
  const MARGIN = RASTER.NEAR_WALL_MARGIN;

  let minX, maxX, minZ, maxZ;
  let mode; // 'axisBox' | 'polyBox' | 'cylinder' | 'poly'
  let effHalfW = 0, effHalfL = 0;

  if (fp.kind === 'box') {
    const facing = fp.facing || 0;
    if (isAxisAlignedFacing(facing)) {
      mode = 'axisBox';
      const q = quadrantOf(facing);
      if (q === 1 || q === 3) { effHalfW = fp.halfL; effHalfL = fp.halfW; } else { effHalfW = fp.halfW; effHalfL = fp.halfL; }
      minX = fp.x - effHalfW; maxX = fp.x + effHalfW;
      minZ = fp.z - effHalfL; maxZ = fp.z + effHalfL;
    } else {
      mode = 'polyBox';
      boxCorners(fp.x, fp.z, fp.halfW, fp.halfL, facing, corners);
      minX = Math.min(corners[0], corners[2], corners[4], corners[6]);
      maxX = Math.max(corners[0], corners[2], corners[4], corners[6]);
      minZ = Math.min(corners[1], corners[3], corners[5], corners[7]);
      maxZ = Math.max(corners[1], corners[3], corners[5], corners[7]);
    }
  } else if (fp.kind === 'cylinder') {
    mode = 'cylinder';
    minX = fp.x - fp.radius; maxX = fp.x + fp.radius;
    minZ = fp.z - fp.radius; maxZ = fp.z + fp.radius;
  } else if (fp.kind === 'poly') {
    mode = 'poly';
    const pts = fp.points;
    minX = Infinity; maxX = -Infinity; minZ = Infinity; maxZ = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const px = pts[k], pz = pts[k + 1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
  } else {
    return; // O-35: never 'circle'/'convex' — defensively ignore an unknown kind
  }

  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, minX - D - MARGIN, maxX + D + MARGIN, minZ - D - MARGIN, maxZ + D + MARGIN);

  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = originX + (cx + 0.5) * cellSize;
      let dist;
      if (mode === 'axisBox') {
        const qx = Math.abs(px - fp.x) - effHalfW;
        const qz = Math.abs(pz - fp.z) - effHalfL;
        const ax = qx > 0 ? qx : 0;
        const az = qz > 0 ? qz : 0;
        const outside = Math.sqrt(ax * ax + az * az);
        const inside = Math.min(Math.max(qx, qz), 0);
        dist = outside + inside;
      } else if (mode === 'cylinder') {
        const dx = px - fp.x, dz = pz - fp.z;
        dist = Math.sqrt(dx * dx + dz * dz) - fp.radius;
      } else if (mode === 'polyBox') {
        dist = convexPolyDistance(px, pz, corners, 4);
      } else {
        dist = convexPolyDistance(px, pz, fp.points, fp.points.length / 2);
      }

      const i = rowBase + cx;
      if (dist <= D) {
        flags[i] |= NAV_FLAG.blocked;
        flags[i] &= ~NAV_FLAG.walkable;
        cost[i] = RASTER.COST_BLOCKED;
      } else if (dist <= D + MARGIN) {
        nearWall[i] = 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// N5 — Doorway
// ---------------------------------------------------------------------------

/**
 * 07 §6.2 N5: a walkable cell whose 8-neighbourhood has <= 4 walkable
 * cells, OR that lies inside a ground-region flagged `doorway` (the
 * "footprint-emitted doorway rect" clause — see the `GroundRegion` shape in
 * the file header; restricted to already-walkable cells, since a doorway
 * marker over solid rock is meaningless). Reads the FINAL walkable set (post
 * N4), per the pass ordering in `07` §6.2's table.
 * @param {object} grid @param {object[]|null|undefined} groundRegions
 */
export function passN5Doorway(grid, groundRegions) {
  const { flags, width, height } = grid;
  for (let cz = 0; cz < height; cz++) {
    const rowBase = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      if (!(flags[i] & NAV_FLAG.walkable)) continue;
      let walkableNeighbours = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const nz = cz + dz;
        if (nz < 0 || nz >= height) continue;
        const nRowBase = nz * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= width) continue;
          if (flags[nRowBase + nx] & NAV_FLAG.walkable) walkableNeighbours++;
        }
      }
      if (walkableNeighbours <= RASTER.DOORWAY_MAX_WALKABLE_NEIGHBOURS) flags[i] |= NAV_FLAG.doorway;
    }
  }

  if (!groundRegions) return;
  for (let r = 0; r < groundRegions.length; r++) {
    const region = groundRegions[r];
    if (!region.doorway) continue;
    stampDoorwayRegion(grid, region);
  }
}

function stampDoorwayRegion(grid, region) {
  const { flags, width, cellSize, originX, originZ } = grid;
  const { minX, maxX, minZ, maxZ } = regionAabb(region);
  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, minX, maxX, minZ, maxZ);
  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const i = rowBase + cx;
      if (!(flags[i] & NAV_FLAG.walkable)) continue;
      const px = originX + (cx + 0.5) * cellSize;
      if (pointInGroundRegion(px, pz, region)) flags[i] |= NAV_FLAG.doorway;
    }
  }
}

// ---------------------------------------------------------------------------
// N6 — Cost
// ---------------------------------------------------------------------------

/**
 * 07 §6.4: `cost = 255` if not walkable, else `1 + (nearWall?2:0) +
 * (water?6:0) + (hazard?12:0)`, clamped to 254. Doorways are NOT penalised
 * (the `+0` term in §6.4 is intentionally absent from the arithmetic below,
 * not merely zero).
 *
 * "blocked" in §6.4's `cost = 255 if blocked` is read here as "not
 * walkable", not literally "the `NAV_FLAG.blocked` bit is set" — a cell can
 * be neither walkable nor blocked (e.g. outside every ground region, when
 * ground regions are given), and such a cell must be exactly as impassable
 * to A* as one the footprint pass explicitly blocked. This also matches
 * N1's own default (`cost = 255` for every cell, before anything runs),
 * so an untouched cell's cost never needs a separate code path.
 * @param {object} grid @param {object} scratch
 */
export function passN6Cost(grid, scratch) {
  const { flags, cost, width, height } = grid;
  const n = width * height;
  const nearWall = scratch.nearWall;
  for (let i = 0; i < n; i++) {
    if (!(flags[i] & NAV_FLAG.walkable)) {
      cost[i] = RASTER.COST_BLOCKED;
      continue;
    }
    let c = 1;
    if (nearWall[i]) c += RASTER.COST_NEAR_WALL;
    if (flags[i] & NAV_FLAG.water) c += RASTER.COST_WATER;
    if (flags[i] & NAV_FLAG.hazard) c += RASTER.COST_HAZARD;
    if (c > RASTER.COST_MAX) c = RASTER.COST_MAX;
    cost[i] = c;
  }
}

// ---------------------------------------------------------------------------
// N7 — Regions (2-pass union-find connected-component labelling)
// ---------------------------------------------------------------------------

function ufFind(parent, x) {
  let root = x;
  while (parent[root] !== root) root = parent[root];
  while (parent[x] !== root) {
    const next = parent[x];
    parent[x] = root;
    x = next;
  }
  return root;
}

function ufUnion(parent, rank, a, b) {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra === rb) return ra;
  if (rank[ra] < rank[rb]) {
    parent[ra] = rb;
    return rb;
  }
  if (rank[ra] > rank[rb]) {
    parent[rb] = ra;
    return ra;
  }
  parent[rb] = ra;
  rank[ra]++;
  return ra;
}

/**
 * 07 §6.2 N7: 4-connected two-pass labelling with union-find over
 * `walkable` cells. Scanned row-major; labels are assigned in SCAN order
 * (pass 3 below), which is what guarantees region 0 always contains the
 * lowest-index walkable cell and that two runs over identical input produce
 * byte-identical `region` arrays (no `Map` anywhere — ARCHITECTURE.md's
 * `Map`-leak warning — every scratch structure is a parallel typed array,
 * indexed by provisional label id, sized once in `createRasterScratch`).
 *
 * Pass 1 walks row-major, unioning each walkable cell with its already-
 * visited left/up walkable neighbours and recording a provisional label.
 * Pass 2 resolves every provisional label to its final union-find root.
 * Pass 3 re-scans row-major and assigns dense region ids in FIRST-SEEN
 * order, so "region 0 = lowest-index walkable cell" falls out of the scan
 * order rather than being special-cased.
 * @param {object} grid @param {object} scratch
 */
export function passN7Regions(grid, scratch) {
  const { flags, region, width, height } = grid;
  const n = width * height;
  const labelOf = scratch.labelOf;
  const parent = scratch.unionParent;
  const rank = scratch.unionRank;
  rank.fill(0, 0, n);

  let nextLabel = 0;
  // Pass 1 — provisional labels + unions.
  for (let cz = 0; cz < height; cz++) {
    const rowBase = cz * width;
    for (let cx = 0; cx < width; cx++) {
      const i = rowBase + cx;
      if (!(flags[i] & NAV_FLAG.walkable)) {
        labelOf[i] = -1;
        continue;
      }
      const leftOk = cx > 0 && (flags[i - 1] & NAV_FLAG.walkable);
      const upOk = cz > 0 && (flags[i - width] & NAV_FLAG.walkable);
      if (!leftOk && !upOk) {
        const label = nextLabel++;
        parent[label] = label;
        labelOf[i] = label;
      } else if (leftOk && !upOk) {
        labelOf[i] = ufFind(parent, labelOf[i - 1]);
      } else if (!leftOk && upOk) {
        labelOf[i] = ufFind(parent, labelOf[i - width]);
      } else {
        labelOf[i] = ufUnion(parent, rank, labelOf[i - 1], labelOf[i - width]);
      }
    }
  }

  // Pass 2 — resolve every provisional label to its final root.
  for (let i = 0; i < n; i++) {
    if (labelOf[i] !== -1) labelOf[i] = ufFind(parent, labelOf[i]);
  }

  // Pass 3 — dense region ids, assigned in row-major first-seen order.
  const rootToRegion = scratch.rootToRegion;
  rootToRegion.fill(-1, 0, nextLabel);
  let regionCount = 0;
  for (let i = 0; i < n; i++) {
    const root = labelOf[i];
    if (root === -1) {
      region[i] = -1;
      continue;
    }
    let regionId = rootToRegion[root];
    if (regionId === -1) {
      regionId = regionCount++;
      rootToRegion[root] = regionId;
    }
    region[i] = regionId;
  }
  grid.regionCount = regionCount;
}

// ---------------------------------------------------------------------------
// N8 — Entry region (assertion only; writes nothing)
// ---------------------------------------------------------------------------

/**
 * 07 §6.2 N8: assert `region[entryCell] !== -1`. `entry` is optional (no
 * generator exists yet to supply a real entry point — see file header); a
 * caller that has one passes `{x, z}` and gets the region id back, or a
 * thrown error if the entry cell isn't walkable. `null`/`undefined`
 * `entry` is a no-op returning `null`, not a silent "everything is fine".
 * @param {object} grid @param {{x:number,z:number}|null|undefined} entry
 * @returns {number|null}
 */
export function passN8EntryRegion(grid, entry) {
  if (!entry) return null;
  const i = cellIndexAt(grid, entry.x, entry.z);
  if (i < 0) throw new Error('passN8EntryRegion: entry point lies outside the grid');
  const r = grid.region[i];
  if (r === -1) throw new Error('passN8EntryRegion: entry cell is not walkable (region === -1)');
  return r;
}

// ---------------------------------------------------------------------------
// N9 — spawnDeny
// ---------------------------------------------------------------------------

function stampSpawnDenyDisc(grid, x, z, radius) {
  const { flags, width, cellSize, originX, originZ } = grid;
  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, x - radius, x + radius, z - radius, z + radius);
  const r2 = radius * radius;
  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = originX + (cx + 0.5) * cellSize;
      const dx = px - x, dz = pz - z;
      if (dx * dx + dz * dz <= r2) flags[rowBase + cx] |= NAV_FLAG.spawnDeny;
    }
  }
}

function stampSpawnDenyRegion(grid, region) {
  const { flags, width, cellSize, originX, originZ } = grid;
  const { minX, maxX, minZ, maxZ } = regionAabb(region);
  const { cx0, cx1, cz0, cz1 } = cellRangeFor(grid, minX, maxX, minZ, maxZ);
  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = originX + (cx + 0.5) * cellSize;
      if (pointInGroundRegion(px, pz, region)) flags[rowBase + cx] |= NAV_FLAG.spawnDeny;
    }
  }
}

/**
 * 07 §6.2 N9: stamp `spawnDeny` discs — 8.0 m around every entry, 8.0 m
 * around every portal pad, 4.0 m around every chest, and the whole of any
 * room flagged `entry`. All four marker lists are optional (no spawner/
 * generator ticket has landed yet — see file header); every list defaults
 * to empty, so calling this with no `markers` at all is a documented no-op,
 * not a crash.
 *
 * `last_bastion`'s "every walkable cell" special case (§6.2 N9) is
 * zone-KIND-specific, and this file takes no zone-kind input (a pure
 * function over geometry, never a `ZoneDescriptor`) — the generic mechanism
 * is `allWalkableSpawnDeny`, which a caller that knows it is rasterising
 * `last_bastion` passes as `true`. That decision belongs to whichever
 * ticket wires `nav.rebuild(zone)` to this file (07 §6.1's table names that
 * `nav`, not `world`).
 * @param {object} grid
 * @param {{entries?:{x:number,z:number}[], portals?:{x:number,z:number}[], chests?:{x:number,z:number}[], entryRooms?:object[], allWalkableSpawnDeny?:boolean}} [markers]
 */
export function passN9SpawnDeny(grid, markers = {}) {
  const { entries = [], portals = [], chests = [], entryRooms = [], allWalkableSpawnDeny = false } = markers;

  if (allWalkableSpawnDeny) {
    const { flags, width, height } = grid;
    const n = width * height;
    for (let i = 0; i < n; i++) {
      if (flags[i] & NAV_FLAG.walkable) flags[i] |= NAV_FLAG.spawnDeny;
    }
    return;
  }

  for (let e = 0; e < entries.length; e++) stampSpawnDenyDisc(grid, entries[e].x, entries[e].z, RASTER.ENTRY_SPAWN_DENY_RADIUS);
  for (let p = 0; p < portals.length; p++) stampSpawnDenyDisc(grid, portals[p].x, portals[p].z, RASTER.PORTAL_SPAWN_DENY_RADIUS);
  for (let c = 0; c < chests.length; c++) stampSpawnDenyDisc(grid, chests[c].x, chests[c].z, RASTER.CHEST_SPAWN_DENY_RADIUS);
  for (let r = 0; r < entryRooms.length; r++) stampSpawnDenyRegion(grid, entryRooms[r]);
}

// ---------------------------------------------------------------------------
// N10 — Prune
// ---------------------------------------------------------------------------

/**
 * 07 §6.2 N10: any walkable component of fewer than 16 cells (4 sq m) is
 * deleted — `walkable` cleared, `cost` set to 255, `region` set to -1.
 *
 * N10-AFTER-N7 INTERACTION (the ticket's own question): pruning removes
 * whole regions, which would otherwise leave `grid.regionCount` counting
 * dead ids (a region whose every cell was just cleared to -1, but whose id
 * was never reused) and would break "two runs produce byte-identical region
 * arrays" the moment pruning ran — a region array with gaps in its id space
 * is still deterministic, but no longer matches what a fresh N7 run over
 * the SAME final walkable set would produce, which is a real, checkable
 * inconsistency. This function fixes both problems the same way N7 itself
 * gets its determinism: surviving regions are RELABELLED to a dense
 * `0..newCount-1` range, assigned in the same row-major first-seen order
 * N7 used, so region 0 is still the lowest-index walkable cell among
 * survivors and `grid.regionCount` becomes the true post-prune count.
 * @param {object} grid @param {object} scratch
 */
export function passN10Prune(grid, scratch) {
  const { flags, cost, region, width, height } = grid;
  const n = width * height;
  const oldRegionCount = grid.regionCount;
  if (oldRegionCount === 0) return;

  const regionSize = scratch.regionSize;
  regionSize.fill(0, 0, oldRegionCount);
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r >= 0) regionSize[r]++;
  }

  const oldToNew = scratch.oldToNewRegion;
  oldToNew.fill(-2, 0, oldRegionCount); // -2 = "not yet decided"; -1 = "pruned"
  let newCount = 0;
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r < 0) continue;
    if (oldToNew[r] === -2) {
      oldToNew[r] = regionSize[r] < RASTER.PRUNE_MIN_CELLS ? -1 : newCount++;
    }
    const mapped = oldToNew[r];
    if (mapped === -1) {
      flags[i] &= ~NAV_FLAG.walkable;
      cost[i] = RASTER.COST_BLOCKED;
      region[i] = -1;
    } else {
      region[i] = mapped;
    }
  }
  grid.regionCount = newCount;
}

// ---------------------------------------------------------------------------
// Convenience — runs N1..N10 in the spec's fixed order
// ---------------------------------------------------------------------------

/**
 * Runs passes N1 through N10, in 07 §6.2's fixed order, over a pre-allocated
 * `grid`/`scratch` pair (see `createNavGrid`/`createRasterScratch`). N11
 * (version bump, `zone.navVersion` mirror, `nav:rebuilt` emission) is
 * explicitly NOT run here — it needs the process-global `navVersionCounter`
 * and the event bus, neither of which a pure function may hold (see file
 * header, "Scope").
 *
 * `entryRegion` in the returned object is read from `grid.region` AFTER
 * N10 has run (not the value `passN8EntryRegion` saw immediately after N7),
 * because N10 can renumber region ids — see `passN10Prune`'s own doc for
 * why. `passN8EntryRegion` is still called, in its §6.2 table position, so
 * its ASSERTION (entry cell must be walkable) fires at the spec's specified
 * point, before N9/N10 run.
 * @param {object} grid @param {object} scratch
 * @param {{footprints?: object[], groundRegions?: object[]|null, heightField?: Float32Array|null, entry?: {x:number,z:number}|null, spawnDenyMarkers?: object|null}} [opts]
 * @returns {{entryRegion: number|null, regionCount: number}}
 */
export function rasterizeNav(grid, scratch, opts = {}) {
  const { footprints = [], groundRegions = null, heightField = null, entry = null, spawnDenyMarkers = null } = opts;

  passN1Clear(grid);
  passN2GroundStamp(grid, groundRegions);
  passN3Slope(grid, heightField, scratch);
  passN4FootprintStamp(grid, footprints, scratch);
  passN5Doorway(grid, groundRegions);
  passN6Cost(grid, scratch);
  passN7Regions(grid, scratch);
  if (entry) passN8EntryRegion(grid, entry); // assertion only; result recomputed below, post-prune
  if (spawnDenyMarkers) passN9SpawnDeny(grid, spawnDenyMarkers);
  passN10Prune(grid, scratch);

  const entryRegion = entry ? grid.region[cellIndexAt(grid, entry.x, entry.z)] : null;
  return { entryRegion, regionCount: grid.regionCount };
}
