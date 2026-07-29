// src/physics/cast.js
//
// PHYS-3 — casts: circleCast, rayCast, lineOfSight, overlapCircle,
// overlapCone, overlapRect, nearest (docs/spec/02-api-contracts.md §4). All
// seven rows already exist verbatim in that table (Fixed: Y, Alloc: no) —
// this ticket does not add a new API row, it fills in an existing one.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file
// (`src/physics/` is one of check-imports.mjs's `three`-only roots, O-22).
//
// ---------------------------------------------------------------------------
// Why this file reaches into `PhysicsSystem`'s and `BodyStore`'s own
// underscore-prefixed fields directly, instead of a `StaticsSource`-style
// duck-typed accessor
// ---------------------------------------------------------------------------
// `body.js` (PHYS-2) built `_staticsSource` in `index.js` specifically
// because `BodyStore` is used standalone in its own tests against a
// hand-built stub (see phys2.test.js's last test) — the duck-typed object is
// the seam that makes that possible. `CastSystem` has no such standalone use
// case (it is never meaningful without a live grid + static storage + body
// storage all belonging to the SAME zone), and this ticket's brief is
// explicit that `index.js` gets wiring only, nothing restructured. The
// cheapest, least invasive shape that respects both facts is: `CastSystem`
// keeps a reference to the whole `PhysicsSystem` instance (`this._phys`) and
// reads its fields fresh on every call — `phys._x`, `phys._bodies._x`, etc.
// This is not a new pattern: `tests/physics/phys2.test.js` itself already
// reads `phys._bodies._x`/`_floorY` directly (no getter exists for them
// either), so treating single-underscore fields as readable within the same
// `physics` subsystem, from a sibling file, is already this codebase's
// convention — `_staticsSource`'s getters exist to survive array
// *reassignment* on growth (`_ensureCapacity`), not to hide the fields.
// Reading `phys._x[slot]` fresh at call time has the identical property:
// `phys` itself never goes stale, so whatever `phys._x` currently points to
// (even after a growth-triggered reassignment) is always the live array.
// The same reasoning applies to `phys._bodies` — `index.js`'s `init()`
// reassigns it wholesale once, at boot, before any body exists; reading
// `phys._bodies` fresh (never caching the `BodyStore` reference across
// calls) means a `CastSystem` built before that reassignment still sees the
// right store afterwards.
//
// ---------------------------------------------------------------------------
// Casts are 2D — footprint `y`/`height` is ignored
// ---------------------------------------------------------------------------
// Assigned, absent from spec (this ticket's report calls this D1): neither
// `Hit` nor any cast signature carries a vertical coordinate or a caster
// height, unlike `moveBody`'s body `height` + tracked `_floorY`. So every
// cast here treats every footprint as an infinite vertical column — the
// same simplification `_aabbOf` (PHYS-1) already makes for hashing, just
// carried through to the collision test itself. A future ticket that wants
// eye-height sight checks (e.g. "can this ledge be seen over") needs a
// height parameter this ticket's contract does not have; noted in the
// report as missing from the spec, not invented here.
//
// ---------------------------------------------------------------------------
// circleCast vs box/poly: mitered corners, not rounded ones (D2)
// ---------------------------------------------------------------------------
// A swept circle against a convex polygon is exactly a ray against that
// polygon's Minkowski sum with a disk of the cast radius — whose true
// boundary is the polygon's edges pushed outward by `radius` along their
// normals, joined by quarter-circle arcs at each original vertex. This file
// computes the straight-edge part exactly (`rayVsConvexInflated` below,
// which is *exact* — no approximation — for `radius = 0`, i.e. every
// `rayCast`/`lineOfSight` call) but does NOT add the rounded-corner arcs for
// `radius > 0`: the half-plane intersection of the offset edges alone gives
// a slightly LARGER convex region than the true rounded shape (a sharp
// mitered corner sits farther from the original vertex than the radius-`r`
// arc would). Concretely, for an axis-aligned/rotated box this reduces to
// "ray vs. a bigger box (halfW+radius, halfL+radius)" — a standard, common
// simplification for gameplay-level circle/capsule casts, exact everywhere
// except a small region right at the four corners. `rayCast` (radius 0) and
// `lineOfSight` (built on the same radius-0 path) are NOT affected — this is
// purely a `circleCast`-only, `radius > 0` caveat.
//
// ---------------------------------------------------------------------------
// Bodies are not gridded — overlap/nearest/the body half of casts are O(bodies)
// ---------------------------------------------------------------------------
// PHYS-1's uniform grid only ever hashes STATIC footprints; there is no
// spatial index over bodies (actors) anywhere in `src/physics/` today. So
// every method here that can match a body (`circleCast`, `rayCast`,
// `overlapCircle`, `overlapCone`, `overlapRect`, `nearest`) does a linear
// scan over the fixed-capacity body store, bounded by `q.maxActors` (a few
// dozen to ~100), not by "actors in a cell" the way `ARCHITECTURE.md`
// describes the model in general. This is a real, documented gap (see this
// ticket's report) — not something this ticket's file list can fix, since a
// body grid would be a `body.js` change and this ticket owns `cast.js` only.
//
// ---------------------------------------------------------------------------
// Post-acceptance fix — the static gather was NOT disk-aware (O-32, found by
// the orchestrator's own probe; identical root cause to sweep.js's PHYS-5
// "Post-acceptance fix", already found and repaired there one day earlier)
// ---------------------------------------------------------------------------
// `_gatherStaticCandidatesAlongRay` (this file's original shape) walked, at
// every DDA step, the SINGLE cell the swept segment's CENTRE LINE currently
// occupies. The thing actually being swept by `circleCast`'s `radius > 0` is
// a DISK, not a zero-width line — a footprint hashed only into a cell
// adjacent to (never entered by) the centre line was invisible to a
// centre-line-only gather even when the disk plainly overlapped it (repro:
// centre line at z=1.999, a wall spanning z=[2.05, 2.55], radius=0.3 — the
// disk reaches 0.051 m into the wall's cell row, the centre line does not
// enter it at all; nudging the centre line 0.002 m across the cell boundary,
// identical geometry otherwise, flipped the result from miss to hit).
// `rayCast`/`lineOfSight` (`radius = 0`) were never affected — `k` below is
// exactly `0` there, degenerating to the original single-cell-per-step
// behaviour, bit-for-bit.
//
// Ported verbatim from `sweep.js`'s own fix (see that file's header for the
// full derivation and proof): at every cell the centre-line DDA visits, also
// test every cell within `cellsRadius = Math.ceil(radius / cellSize)` cells
// of it (a `(2*cellsRadius+1)^2` block), not just the one cell the centre
// line is in. Any cell the swept disk can touch has a closest point that
// lies on the segment itself, which sits in some cell the DDA visits; by the
// same cells-away bound `sweep.js` proves, the target cell is always inside
// the block tested at that step. No gap, regardless of where in its cell the
// centre line's crossing point happens to fall.
//
// This also folds in the fix for the capacity-overflow risk widening the
// gather makes strictly worse: the old `CAST_CANDIDATE_CAPACITY = 256`
// fixed-size buffer (gather-then-test, two passes) is gone, replaced by the
// same streaming shape `sweep.js` already proved out — narrow-phase-test
// each candidate the instant the DDA's cell-block scan finds it, updating a
// running "best so far" directly, so there is no buffer to overflow and
// therefore nothing that can be silently dropped. A 9-cell block (the
// realistic `cellsRadius = 1` case) finds roughly 9x as many raw (cell,
// handle) pairs per DDA step as the old single-cell scan — exactly the
// scenario that would have made a fixed 256-cap overflow far more likely,
// not less, had the buffer been kept.
//
// `overlapCircle`/`overlapCone`/`overlapRect`/`nearest` do not use this
// gather (or any grid query) at all — they are pure linear scans over the
// BODY store only (see this file's own header note above: "the body half of
// casts are O(bodies)", statics are never gridded for these four). They are
// unaffected by this defect and untouched by this fix.
//
// ---------------------------------------------------------------------------
// Assigned decisions absent from the spec (report calls these D3-D8)
// ---------------------------------------------------------------------------
// D3 — `(dx, dz)` given to `circleCast`/`rayCast` is treated as a direction
//      only; this file re-normalizes it internally rather than assuming the
//      caller already passed a unit vector, so `maxDist` alone controls
//      travel distance regardless of the vector's own magnitude.
// D4 — A body flagged `BODY_FLAG.NO_COLLIDE` is still fully visible to every
//      cast/overlap/nearest query. That flag is documented (`body.js`) as
//      bypassing `moveBody`'s STATIC collision resolution specifically — it
//      says nothing about detection, and a "ghosted for movement but
//      untargetable" actor is not implied anywhere in `02-api-contracts.md`.
// D5 — A body hit by `circleCast`/`rayCast` reports `surface: 'flesh'`
//      (`ARCHITECTURE.md`'s own surface list includes `flesh`/`bone`/
//      `blood` for creature-related impacts); `staticHandle` stays 0 and
//      `actorId` is the hit body's `actorId` (not its internal `bodyId`).
// D6 — `nearest`'s `excludeId` is compared against `actorId`, not the
//      internal `bodyId` — the method's own return value is an `actorId`,
//      and every other body-facing field this ticket's queries expose
//      (`overlapCircle`/`overlapCone`/`overlapRect`'s `out` arrays) is
//      `actorId` space too, so `excludeId` is assumed to live in the same
//      space a caller would naturally have on hand (its own `actorId`).
// D7 — `overlapCircle`/`overlapCone`/`overlapRect`'s `out:int[]` is a fixed,
//      caller-owned array (never `.length = 0`'d, per this project's `Map`/
//      array-truncation rules) — once `out.length` entries are written, any
//      further match is silently dropped and the returned count never
//      exceeds `out.length`. So `out[0 .. count)` is always exactly the set
//      of ids written and safe to read; a caller wanting every match passes
//      an `out` sized to its own worst case (`q.maxActors`).
// D8 — `overlapCone` tests actor DISCS against the cone's radius bound
//      (`distance <= radius + actorRadius`, matching `overlapCircle`'s own
//      leniency) but tests the ANGLE against the actor's centre only, not
//      its full disc — an exact disc-vs-cone-sector test needs the angular
//      slack a disc of radius `r` at distance `d` adds (`asin(r/d)`), which
//      this file skips to avoid a transcendental call per candidate; the
//      `Math.cos(halfAngle)` this needs is computed once per `overlapCone`
//      call, not per body.

/** Mirrors `src/physics/index.js`'s private `KIND_BOX`/`KIND_CYLINDER`/
 * `KIND_POLY` numbering — duplicated rather than imported, exactly the
 * rationale `body.js` already documents for its own copy of the same three
 * constants (both files derive them from `Footprint.kind`'s fixed spec
 * union, so they can never drift independently of a spec change either file
 * would have to follow anyway). */
const KIND_BOX = 0;
const KIND_CYLINDER = 1;
const KIND_POLY = 2;

/** Mirrors `LAYER.STATIC` (`02-api-contracts.md` §4: `STATIC: 1`) —
 * duplicated, not imported from `./index.js`, to avoid a circular import
 * (`index.js` imports `CastSystem` from this file to wire the methods onto
 * `PhysicsSystem`). */
const STATIC_LAYER = 1;

/** `Hit`/`MoveResult` records "come from a 32-deep ring" —
 * `02-api-contracts.md` §4, verbatim. `body.js` built the `MoveResult` ring
 * (`MOVE_RESULT_RING_SIZE`); this is that same contract's `Hit` ring, built
 * here because this is the first ticket that needs one. */
export const HIT_RING_SIZE = 32;

/** Safety valve on the grid-traversal (DDA) loop below — bounds the number
 * of cells visited so a pathological direction (e.g. floating-point noise
 * right at a cell boundary) cannot spin forever. Never expected to trigger
 * for this game's world sizes (`07-world-gen.md`: zones are ~100 m,
 * `CELL_SIZE` is 2 m, so even a full-map-spanning cast crosses on the order
 * of 100 cells). */
const MAX_DDA_STEPS = 20000;

/** `02-api-contracts.md` §4's `Hit` record, field for field, at its
 * documented default values. @returns {object} */
function makeHit() {
  return { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
}

/** Resets `h` (in place) to the same defaults `makeHit()` starts with — the
 * "miss" state every cast begins from before it (maybe) finds something
 * closer. @param {object} h */
function resetHit(h) {
  h.hit = false;
  h.x = 0;
  h.z = 0;
  h.nx = 0;
  h.nz = 0;
  h.distance = 0;
  h.fraction = 0;
  h.surface = 'stone';
  h.actorId = 0;
  h.staticHandle = 0;
}

// ---------------------------------------------------------------------------
// Geometry — a moving point (radius 0) or circle (radius > 0) along a ray,
// vs. one footprint shape. Every function below writes its result (the
// entry parameter `t`, `0 <= t <= maxDist`) into a caller-owned `normalOut`
// scratch object and RETURNS `t`, or returns `null` for "no hit in range" —
// the same "reused scratch object, or null" convention `body.js`'s own
// `circleVsCircle`/`circleVsConvexPolygon` use for penetration tests.
// ---------------------------------------------------------------------------

/**
 * Ray `(ox,oz) + t*(dirx,dirz)` (unit direction) vs. a circle of radius `R`
 * centred at `(cx,cz)`. Exact — standard ray/circle quadratic. An origin
 * already inside/touching the circle (`R` reached or exceeded at `t = 0`)
 * reports an immediate hit at `t = 0`, matching this file's general
 * "already overlapping counts as a hit at the start" convention (see
 * `rayVsConvexInflated`'s own comment on the same choice).
 * @returns {number | null}
 */
function rayVsCircle(ox, oz, dirx, dirz, cx, cz, R, maxDist, normalOut) {
  if (R <= 0) return null;
  const fx = ox - cx;
  const fz = oz - cz;
  const b = fx * dirx + fz * dirz;
  const c = fx * fx + fz * fz - R * R;
  if (c > 0 && b > 0) return null; // outside the circle and moving away from it
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc); // Math.sqrt, never Math.hypot — see body.js's note on why
  let t;
  if (c < 0) {
    t = 0; // already overlapping at the origin
  } else {
    t = -b - sq;
    if (t < 0) return null;
  }
  if (t > maxDist) return null;
  const px = ox + dirx * t;
  const pz = oz + dirz * t;
  let nx = px - cx;
  let nz = pz - cz;
  const nlen = Math.sqrt(nx * nx + nz * nz);
  if (nlen > 1e-9) {
    nx /= nlen;
    nz /= nlen;
  } else {
    nx = 1;
    nz = 0; // degenerate (hit exactly the centre) — arbitrary but deterministic
  }
  normalOut.nx = nx;
  normalOut.nz = nz;
  return t;
}

/**
 * Ray `(ox,oz) + t*(dirx,dirz)` (unit direction) vs. a convex polygon
 * (`pts`, flat CCW world-space `x0,z0,x1,z1,...`, `n` points), inflated
 * outward by `inflate` (0 for an exact ray, `circleCast`'s radius
 * otherwise — see this file's header, D2, for the known corner
 * approximation `inflate > 0` carries). Standard half-plane clipping
 * (Cyrus-Beck/Liang-Barsky generalised to n half-planes): each edge's
 * outward normal gives an affine constraint in `t`, and intersecting all n
 * constraints yields the entry/exit interval. Exact for `inflate = 0`.
 * @returns {number | null}
 */
function rayVsConvexInflated(ox, oz, dirx, dirz, pts, n, inflate, maxDist, normalOut) {
  let tMin = -Infinity;
  let tMax = Infinity;
  let bestNx = 0;
  let bestNz = 0;
  let haveBest = false;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i * 2];
    const z0 = pts[i * 2 + 1];
    const x1 = pts[j * 2];
    const z1 = pts[j * 2 + 1];
    const ex = x1 - x0;
    const ez = z1 - z0;
    const len = Math.sqrt(ex * ex + ez * ez); // Math.sqrt, never Math.hypot
    if (len < 1e-9) continue; // degenerate (duplicate) vertex pair — skip
    const nx = ez / len;
    const nz = -ex / len; // outward unit normal, CCW winding (same formula body.js uses)

    const c = (ox - x0) * nx + (oz - z0) * nz - inflate;
    const m = dirx * nx + dirz * nz;

    if (Math.abs(m) < 1e-12) {
      if (c > 0) return null; // parallel to this edge and already outside it forever
      continue; // parallel and inside — this edge imposes no bound on t
    }
    const tEdge = -c / m;
    if (m > 0) {
      if (tEdge < tMax) tMax = tEdge;
    } else if (tEdge > tMin) {
      tMin = tEdge;
      bestNx = nx;
      bestNz = nz;
      haveBest = true;
    }
  }

  if (tMin > tMax) return null; // the n half-planes' allowed ranges don't overlap — miss
  if (tMax < 0) return null; // the whole valid interval is behind the ray origin
  if (tMin > maxDist) return null;

  let t = tMin;
  if (t < 0) t = 0; // origin already inside/overlapping — immediate hit

  if (!haveBest) {
    // Only reachable when no edge ever became the tMin-setting constraint
    // (every edge had m >= 0) — a measure-zero direction for any real
    // convex polygon (see the header's D-notes list is silent on this
    // because it is not expected to occur in a real test; guarded so a
    // caller never sees a zero-vector normal). Point back along the ray.
    bestNx = -dirx;
    bestNz = -dirz;
  }
  normalOut.nx = bestNx;
  normalOut.nz = bestNz;
  return t;
}

/** World-space box corners, CCW, same rotation formula and corner order
 * `body.js`'s `_penetration` (KIND_BOX branch) uses — kept identical so a
 * box collides the same way against `moveBody` and against a cast.
 * Writes into `out` (a `Float64Array`, length >= 8). */
function boxCorners(x, z, halfW, halfL, facing, out) {
  const cosF = Math.cos(facing);
  const sinF = Math.sin(facing);
  out[0] = x + (halfW * cosF - halfL * sinF);
  out[1] = z + (halfW * sinF + halfL * cosF);
  out[2] = x + (-halfW * cosF - halfL * sinF);
  out[3] = z + (-halfW * sinF + halfL * cosF);
  out[4] = x + (-halfW * cosF + halfL * sinF);
  out[5] = z + (-halfW * sinF - halfL * cosF);
  out[6] = x + (halfW * cosF + halfL * sinF);
  out[7] = z + (halfW * sinF - halfL * cosF);
}

/** World-space poly corners — rotate+translate `pts` (flat local CCW,
 * `n` points) by `facing` around `(x,z)`, matching `body.js`'s KIND_POLY
 * branch exactly. Writes into `out` (`Float64Array`, length >= 2n). */
function polyCorners(x, z, facing, pts, n, out) {
  const cosF = Math.cos(facing);
  const sinF = Math.sin(facing);
  for (let i = 0; i < n; i++) {
    const lx = pts[i * 2];
    const lz = pts[i * 2 + 1];
    out[i * 2] = x + (lx * cosF - lz * sinF);
    out[i * 2 + 1] = z + (lx * sinF + lz * cosF);
  }
}

export class CastSystem {
  /** @param {import('./index.js').PhysicsSystem} phys — see this file's
   * header for why a live reference to the whole instance, read fresh per
   * call, is this ticket's chosen seam. */
  constructor(phys) {
    this._phys = phys;

    // --- The 32-deep Hit ring (02-api-contracts.md §4) ---------------------
    this._hitRing = [];
    for (let i = 0; i < HIT_RING_SIZE; i++) this._hitRing.push(makeHit());
    this._hitRingIndex = 0;

    // `lineOfSight` returns a boolean, never a `Hit` — its internal sweep
    // still needs somewhere to write, but it must be neither the public
    // ring (would perturb rayCast/circleCast callers relying on ring
    // rotation) nor a caller-supplied `out` (lineOfSight has none). A single
    // private scratch record, reused every call, same idea as `body.js`'s
    // own `_scratchPen`.
    this._scratchHit = makeHit();

    // --- Per-call static-sweep state, read/written by `_testStaticCandidate`
    // below (bound ONCE, here, never per call). Ported from `sweep.js`'s own
    // identical fields (see that file's "Post-acceptance fix" header note):
    // `_sweepStaticsInto` sets the "_cur*" fields fresh at the start of every
    // call; the "_best*" fields are the running "closest hit so far", reset
    // by `_sweep()` before each call and updated in place as candidates are
    // found — replacing the old bounded `_candidateHandles` array with an
    // unbounded streaming accumulation, so there is no capacity to overflow.
    this._curOx = 0;
    this._curOz = 0;
    this._curDirx = 0;
    this._curDirz = 0;
    this._curCastRadius = 0;
    this._curMaxDist = 0;
    this._curSightOnly = false;
    this._bestT = Infinity;
    this._bestNx = 0;
    this._bestNz = 0;
    this._bestSurface = 'stone';
    this._bestStaticHandle = 0;
    this._foundStatic = false;

    /** Bound once (not per call) — a fresh closure per call would be a
     * per-call allocation. Narrow-phase-tests a single static handle
     * immediately, updating `_best*` if it beats the running best — the
     * fix for the old fixed-capacity gather buffer: no array to fill, so
     * nothing to silently drop past a cap. */
    this._testStaticCandidate = (handle) => {
      const phys = this._phys;
      const slot = handle - 1;
      if (!phys._alive[slot]) return;
      if (this._curSightOnly && !phys._blocksSight[slot]) return;
      const bound = this._bestT < this._curMaxDist ? this._bestT : this._curMaxDist;
      const t = this._rayVsStatic(slot, this._curOx, this._curOz, this._curDirx, this._curDirz, this._curCastRadius, bound, this._scratchNormal);
      if (t === null) return;
      if (t < this._bestT) {
        this._bestT = t;
        this._bestNx = this._scratchNormal.nx;
        this._bestNz = this._scratchNormal.nz;
        this._bestSurface = phys._surface[slot];
        this._bestStaticHandle = handle;
        this._foundStatic = true;
      }
    };

    /** Reused world-space corner buffer for box (4 pts) / poly (<= 8 pts)
     * ray tests — 8 points * 2 numbers, same sizing `body.js`'s
     * `_scratchPoly` uses for the same reason. */
    this._scratchPoly = new Float64Array(16);

    /** Reused `{nx,nz}` output of every ray-vs-shape test in this file. */
    this._scratchNormal = { nx: 0, nz: 0 };
  }

  /** @private @returns {object} the next ring slot, advancing the cursor. */
  _nextRingHit() {
    const h = this._hitRing[this._hitRingIndex];
    this._hitRingIndex = (this._hitRingIndex + 1) % HIT_RING_SIZE;
    return h;
  }

  /**
   * Tests every cell within `cellsRadius` of `(cx,cz)` (a
   * `(2*cellsRadius+1)^2` block, or just `(cx,cz)` itself when `cellsRadius`
   * is 0) against the current sweep — see this file's header,
   * "Post-acceptance fix", for why a single cell is not enough once
   * `radius > 0` and for the proof this block size is sufficient. Ported
   * verbatim from `sweep.js`'s own `_testCellBlock`.
   * @private
   */
  _testCellBlock(cx, cz, cellsRadius) {
    const grid = this._phys._grid;
    if (cellsRadius === 0) {
      grid.forEachInCell(cx, cz, this._testStaticCandidate);
      return;
    }
    for (let ddx = -cellsRadius; ddx <= cellsRadius; ddx++) {
      for (let ddz = -cellsRadius; ddz <= cellsRadius; ddz++) {
        grid.forEachInCell(cx + ddx, cz + ddz, this._testStaticCandidate);
      }
    }
  }

  /**
   * Sweeps the static grid for the segment `(ox,oz) -> (ox,oz) +
   * dir*maxDist` inflated by `castRadius`, narrow-phase-testing every
   * candidate as it is found (streaming — no bounded buffer, see this
   * file's header). Leaves the result in `this._bestT`/`_bestNx`/`_bestNz`/
   * `_bestSurface`/`_bestStaticHandle`/`_foundStatic`; the caller (`_sweep`)
   * is responsible for resetting those before invoking this.
   *
   * Centre-line traversal is the standard Amanatides-Woo DDA (allocation-
   * free, visits cells in strictly increasing distance-along-the-ray
   * order) — unchanged from this file's original gather; the fix is
   * `_testCellBlock` above being called at each step instead of a single-
   * cell `forEachInCell`. Ported verbatim from `sweep.js`'s own
   * `_sweepStaticsInto`.
   * @private
   */
  _sweepStaticsInto(ox, oz, dirx, dirz, castRadius, maxDist, sightOnly) {
    this._curOx = ox;
    this._curOz = oz;
    this._curDirx = dirx;
    this._curDirz = dirz;
    this._curCastRadius = castRadius;
    this._curMaxDist = maxDist;
    this._curSightOnly = sightOnly;

    const grid = this._phys._grid;
    const cellSize = grid.cellSize;
    // See this file's header for the proof: any cell a disk of radius
    // `castRadius`, centred anywhere in a given cell, can touch lies within
    // `cellsRadius` cells of it. `radius = 0` (rayCast/lineOfSight) gives
    // `cellsRadius = 0`, degenerating to exactly the original single-cell
    // traversal.
    const cellsRadius = castRadius > 0 ? Math.ceil(castRadius / cellSize) : 0;

    let cx = grid.cellIndexX(ox);
    let cz = grid.cellIndexZ(oz);
    const stepX = dirx > 0 ? 1 : dirx < 0 ? -1 : 0;
    const stepZ = dirz > 0 ? 1 : dirz < 0 ? -1 : 0;

    let tMaxX = Infinity;
    let tDeltaX = Infinity;
    if (stepX !== 0) {
      const boundaryX = stepX > 0 ? (cx + 1) * cellSize : cx * cellSize;
      tMaxX = (boundaryX - ox) / dirx;
      tDeltaX = (cellSize / dirx) * stepX; // always positive: cellSize/dirx has the same sign as stepX
    }
    let tMaxZ = Infinity;
    let tDeltaZ = Infinity;
    if (stepZ !== 0) {
      const boundaryZ = stepZ > 0 ? (cz + 1) * cellSize : cz * cellSize;
      tMaxZ = (boundaryZ - oz) / dirz;
      tDeltaZ = (cellSize / dirz) * stepZ;
    }

    let steps = 0;
    for (;;) {
      this._testCellBlock(cx, cz, cellsRadius);
      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tNext > maxDist || steps >= MAX_DDA_STEPS) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxZ < tMaxX) {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      } else {
        // Exactly a corner crossing — advance both axes so the diagonal
        // neighbour cell is visited too (a footprint could be hashed only
        // there).
        cx += stepX;
        cz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      }
      steps++;
    }
  }

  /**
   * One static footprint's ray intersection, dispatched by shape.
   * @private
   * @returns {number | null}
   */
  _rayVsStatic(slot, ox, oz, dirx, dirz, inflate, maxDist, normalOut) {
    const phys = this._phys;
    const kind = phys._kindCode[slot];
    if (kind === KIND_CYLINDER) {
      return rayVsCircle(ox, oz, dirx, dirz, phys._x[slot], phys._z[slot], phys._radius[slot] + inflate, maxDist, normalOut);
    }
    const poly = this._scratchPoly;
    let n;
    if (kind === KIND_BOX) {
      n = 4;
      boxCorners(phys._x[slot], phys._z[slot], phys._halfW[slot], phys._halfL[slot], phys._facing[slot], poly);
    } else {
      const pts = phys._polyPoints[slot];
      if (!pts || pts.length < 6) return null; // degenerate/absent — no collider
      n = pts.length >> 1;
      polyCorners(phys._x[slot], phys._z[slot], phys._facing[slot], pts, n, poly);
    }
    return rayVsConvexInflated(ox, oz, dirx, dirz, poly, n, inflate, maxDist, normalOut);
  }

  /**
   * Shared sweep behind `circleCast`/`rayCast`/`lineOfSight` — `castRadius`
   * is 0 for a ray, `sightOnly` restricts the static test to
   * `blocksSight` footprints and skips bodies entirely (`lineOfSight`'s own
   * contract; see this file's header). Does NOT touch `stats.casts` —
   * every public entry point increments it exactly once itself.
   * @private
   * @returns {object} `out`, filled in place.
   */
  _sweep(ox, oz, dirx, dirz, castRadius, maxDist, mask, out, sightOnly) {
    resetHit(out);
    if (maxDist <= 0) return out;

    const phys = this._phys;
    let bestT = Infinity;
    let bestNx = 0;
    let bestNz = 0;
    let bestSurface = 'stone';
    let bestActorId = 0;
    let bestStaticHandle = 0;
    let found = false;

    if ((mask & STATIC_LAYER) !== 0) {
      this._bestT = Infinity;
      this._bestNx = 0;
      this._bestNz = 0;
      this._bestSurface = 'stone';
      this._bestStaticHandle = 0;
      this._foundStatic = false;
      this._sweepStaticsInto(ox, oz, dirx, dirz, castRadius, maxDist, sightOnly);
      if (this._foundStatic) {
        bestT = this._bestT;
        bestNx = this._bestNx;
        bestNz = this._bestNz;
        bestSurface = this._bestSurface;
        bestActorId = 0;
        bestStaticHandle = this._bestStaticHandle;
        found = true;
      }
    }

    if (!sightOnly && (mask & ~STATIC_LAYER) !== 0) {
      const bodies = phys._bodies;
      const cap = bodies.capacity;
      for (let slot = 0; slot < cap; slot++) {
        if (!bodies._alive[slot]) continue;
        if ((bodies._layer[slot] & mask) === 0) continue;
        const bound = bestT < maxDist ? bestT : maxDist;
        const t = rayVsCircle(ox, oz, dirx, dirz, bodies._x[slot], bodies._z[slot], bodies._radius[slot] + castRadius, bound, this._scratchNormal);
        if (t === null) continue;
        if (t < bestT) {
          bestT = t;
          bestNx = this._scratchNormal.nx;
          bestNz = this._scratchNormal.nz;
          bestSurface = 'flesh'; // D5
          bestActorId = bodies._actorId[slot];
          bestStaticHandle = 0;
          found = true;
        }
      }
    }

    if (found) {
      out.hit = true;
      out.x = ox + dirx * bestT;
      out.z = oz + dirz * bestT;
      out.nx = bestNx;
      out.nz = bestNz;
      out.distance = bestT;
      out.fraction = bestT / maxDist;
      out.surface = bestSurface;
      out.actorId = bestActorId;
      out.staticHandle = bestStaticHandle;
    }
    return out;
  }

  /** `02-api-contracts.md` §4: `circleCast(x,z,dx,dz,radius,maxDist,mask,
   * out?) => Hit`. @returns {object} */
  circleCast(x, z, dx, dz, radius, maxDist, mask, out) {
    const result = out || this._nextRingHit();
    this._phys._stats.casts++;
    const len = Math.sqrt(dx * dx + dz * dz); // Math.sqrt, never Math.hypot
    if (len < 1e-12 || maxDist <= 0) {
      resetHit(result);
      return result;
    }
    return this._sweep(x, z, dx / len, dz / len, radius, maxDist, mask, result, false);
  }

  /** `02-api-contracts.md` §4: `rayCast(x,z,dx,dz,maxDist,mask,out?) =>
   * Hit`. Identical to `circleCast` with `radius = 0` — see this file's
   * header for why that special case is exact (no D2 approximation).
   * @returns {object} */
  rayCast(x, z, dx, dz, maxDist, mask, out) {
    const result = out || this._nextRingHit();
    this._phys._stats.casts++;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-12 || maxDist <= 0) {
      resetHit(result);
      return result;
    }
    return this._sweep(x, z, dx / len, dz / len, 0, maxDist, mask, result, false);
  }

  /** `02-api-contracts.md` §4: `lineOfSight(ax,az,bx,bz,mask) => boolean`
   * — a radius-0 sweep (exact, same path `rayCast` uses) filtered to
   * `blocksSight` statics only, never bodies (this file's header). Writes
   * into its own private scratch `Hit`, never the public ring or a
   * caller's `out`. @returns {boolean} */
  lineOfSight(ax, az, bx, bz, mask) {
    this._phys._stats.casts++;
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1e-12) return true; // coincident points — trivially visible
    const hit = this._sweep(ax, az, dx / dist, dz / dist, 0, dist, mask, this._scratchHit, true);
    return !hit.hit;
  }

  /** `02-api-contracts.md` §4: `overlapCircle(x,z,radius,mask,out) => int
   * count`. See D7 for the `out`-truncation contract. @returns {number} */
  overlapCircle(x, z, radius, mask, out) {
    const phys = this._phys;
    phys._stats.casts++;
    const bodies = phys._bodies;
    const cap = bodies.capacity;
    let count = 0;
    for (let slot = 0; slot < cap; slot++) {
      if (!bodies._alive[slot]) continue;
      if ((bodies._layer[slot] & mask) === 0) continue;
      const dx = bodies._x[slot] - x;
      const dz = bodies._z[slot] - z;
      const rsum = radius + bodies._radius[slot];
      if (dx * dx + dz * dz > rsum * rsum) continue;
      if (count < out.length) out[count] = bodies._actorId[slot];
      count++;
      if (count >= out.length) count = out.length; // never report more than what fits (D7)
    }
    return count;
  }

  /** `02-api-contracts.md` §4: `overlapCone(x,z,facing,halfAngle,radius,
   * mask,out) => int`. See D8 for the disc-vs-sector simplification.
   * @returns {number} */
  overlapCone(x, z, facing, halfAngle, radius, mask, out) {
    const phys = this._phys;
    phys._stats.casts++;
    const bodies = phys._bodies;
    const cap = bodies.capacity;
    const fx = Math.cos(facing);
    const fz = Math.sin(facing);
    const cosHalf = Math.cos(halfAngle);
    let count = 0;
    for (let slot = 0; slot < cap; slot++) {
      if (!bodies._alive[slot]) continue;
      if ((bodies._layer[slot] & mask) === 0) continue;
      const dx = bodies._x[slot] - x;
      const dz = bodies._z[slot] - z;
      const rsum = radius + bodies._radius[slot];
      const distSq = dx * dx + dz * dz;
      if (distSq > rsum * rsum) continue;
      if (distSq > 1e-12) {
        const dist = Math.sqrt(distSq);
        const cosAngle = (dx * fx + dz * fz) / dist;
        if (cosAngle < cosHalf) continue;
      } // else: actor sits (almost) exactly at the apex — always inside
      if (count < out.length) out[count] = bodies._actorId[slot];
      count++;
      if (count >= out.length) count = out.length;
    }
    return count;
  }

  /** `02-api-contracts.md` §4: `overlapRect(x,z,halfW,halfL,facing,mask,
   * out) => int`. Circle-vs-rotated-box-in-local-frame test: rotate each
   * candidate into the rect's local space, clamp to the box, compare the
   * clamped point's distance to the actor's own radius. @returns {number} */
  overlapRect(x, z, halfW, halfL, facing, mask, out) {
    const phys = this._phys;
    phys._stats.casts++;
    const bodies = phys._bodies;
    const cap = bodies.capacity;
    const cosF = Math.cos(facing);
    const sinF = Math.sin(facing);
    let count = 0;
    for (let slot = 0; slot < cap; slot++) {
      if (!bodies._alive[slot]) continue;
      if ((bodies._layer[slot] & mask) === 0) continue;
      const dx = bodies._x[slot] - x;
      const dz = bodies._z[slot] - z;
      // World -> local: R^T, the transpose/inverse of the same rotation
      // `boxCorners` applies (local -> world) — rotations are orthonormal.
      const lx = dx * cosF + dz * sinF;
      const lz = -dx * sinF + dz * cosF;
      let cx = lx;
      if (cx > halfW) cx = halfW;
      else if (cx < -halfW) cx = -halfW;
      let cz = lz;
      if (cz > halfL) cz = halfL;
      else if (cz < -halfL) cz = -halfL;
      const ddx = lx - cx;
      const ddz = lz - cz;
      const r = bodies._radius[slot];
      if (ddx * ddx + ddz * ddz > r * r) continue;
      if (count < out.length) out[count] = bodies._actorId[slot];
      count++;
      if (count >= out.length) count = out.length;
    }
    return count;
  }

  /** `02-api-contracts.md` §4: `nearest(x,z,radius,mask,excludeId) => int
   * actorId | 0`. See D6 for the `excludeId`-is-`actorId` decision.
   * @returns {number} */
  nearest(x, z, radius, mask, excludeId) {
    const phys = this._phys;
    phys._stats.casts++;
    const bodies = phys._bodies;
    const cap = bodies.capacity;
    let bestActorId = 0;
    let bestDistSq = Infinity;
    for (let slot = 0; slot < cap; slot++) {
      if (!bodies._alive[slot]) continue;
      const actorId = bodies._actorId[slot];
      if (actorId === excludeId) continue;
      if ((bodies._layer[slot] & mask) === 0) continue;
      const dx = bodies._x[slot] - x;
      const dz = bodies._z[slot] - z;
      const rsum = radius + bodies._radius[slot];
      const distSq = dx * dx + dz * dz;
      if (distSq > rsum * rsum) continue;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestActorId = actorId;
      }
    }
    return bestActorId;
  }
}
