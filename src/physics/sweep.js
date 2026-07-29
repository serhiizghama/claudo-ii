// src/physics/sweep.js
//
// PHYS-5 — sweepProjectile: the swept collision test a projectile runs every
// fixed step (docs/spec/02-api-contracts.md §4's row already exists —
// `sweepProjectile(x,z,dx,dz,radius,mask,excludeId,out?) => Hit`, this ticket
// adds no new API row) and `11-flows.md` §5.5 step 4's only consumer:
// "Sweep... from the previous to the new position — a swept test, so a
// 26 m/s bolt cannot tunnel through a 0.36 m actor at 0.43 m/step".
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file
// (`src/physics/` is one of check-imports.mjs's `three`-only roots, O-22).
//
// ---------------------------------------------------------------------------
// The reason this ticket exists — O-25
// ---------------------------------------------------------------------------
// `moveBody` (PHYS-2, `body.js`) is "move to the target, then push out of
// whatever overlaps at the final position". A delta that carries a body
// clean past a thin obstacle leaves nothing overlapping at the end, so
// `moveBody` reports `blocked: false` and the body has tunnelled — exactly
// what ACTR-1's `moveTo(a, 10, 0)` through a 2 m wall demonstrated. Ordinary
// actor movement never triggers this (4.2 m/s / 60 Hz = 0.07 m/step, far
// smaller than any wall this game places), but a projectile moves whole
// metres per step (this ticket's own acceptance case: 30 m/s / 60 Hz =
// 0.5 m/step, against a 0.2 m wall) — `moveBody`'s sample-the-endpoint
// approach is structurally unable to catch that, which is exactly why a
// second, genuinely swept method exists in the contract. This file computes
// the earliest time of impact along the whole travelled segment, not merely
// the state at its end.
//
// ---------------------------------------------------------------------------
// The interface question this ticket had to resolve, not guess at:
// `(dx, dz)` is a DISPLACEMENT, not a direction — and must NOT be normalized
// ---------------------------------------------------------------------------
// `circleCast(x,z,dx,dz,radius,maxDist,mask,out)` (cast.js, PHYS-3) treats
// `(dx,dz)` as a direction and takes `maxDist` as a separate parameter — that
// file re-normalizes `(dx,dz)` internally specifically so a caller need not
// pre-normalize (see cast.js's own D3), and `maxDist` alone controls how far
// the sweep travels.
//
// `sweepProjectile` has NO `maxDist` parameter at all. Its only documented
// caller (`11-flows.md` §5.5 step 4) sweeps "from the previous to the new
// position" — i.e. the whole point of the call is to cover the segment a
// projectile just moved along in one fixed step. There is no other number in
// scope that could tell this method how far to travel. The only reading that
// makes the method able to do its job is: `(dx, dz)` IS the full per-step
// displacement vector (`newX - prevX`, `newZ - prevZ`, whatever combination
// of unit direction × speed × `h` step 3 used to compute it), and its
// magnitude (`Math.sqrt(dx*dx + dz*dz)`, never `Math.hypot` — see the
// `Math.hypot` note below) IS the sweep distance. Re-normalizing it the way
// `circleCast` does — as an early draft of this file did, before catching
// the mistake against this ticket's own acceptance test — throws the
// distance away and turns the sweep into a fixed-length-1 probe, which
// cannot represent "from the previous to the new position" for any step size
// other than exactly 1 m. This file therefore does the opposite of
// `circleCast`: it derives its own direction by normalizing internally
// *for the ray math*, but uses the ORIGINAL vector's magnitude, not `1`, as
// the distance to travel. A zero-length `(dx, dz)` (no movement this step) is
// treated as a miss with no computation, the same convention `circleCast`/
// `rayCast` already use for a degenerate direction.
//
// ---------------------------------------------------------------------------
// Why this file duplicates cast.js's geometry primitives instead of
// exporting and importing them
// ---------------------------------------------------------------------------
// `rayVsCircle`, `rayVsConvexInflated`, `boxCorners`, `polyCorners` and the
// static-candidate DDA gather in `cast.js` are exactly the primitives this
// method also needs (a swept circle against the same three footprint shapes,
// same mitered-corner treatment for `radius > 0`), but `cast.js` is not in
// this ticket's file list — only `sweep.js`, `index.js` (wiring) and this
// ticket's own tests are. Adding exports to `cast.js` would be editing a file
// this ticket does not own; asking `index.js` to broker access would be more
// than "wiring only". So this file duplicates the primitives instead, the
// same choice `cast.js`/`body.js`/`index.js` already made for `KIND_BOX`/
// `KIND_CYLINDER`/`KIND_POLY` and `STATIC_LAYER` (see cast.js's own header):
// both files derive the same geometry from the same fixed spec facts
// (`Footprint`'s shape union, `02-api-contracts.md` §4), so the two copies
// can never drift independently of a spec change either file would have to
// follow anyway. The duplicated functions below are byte-for-byte the same
// algorithm as cast.js's (see that file for the derivation of each), only
// renamed where useful for this file's own readability.
//
// ---------------------------------------------------------------------------
// Reusing cast.js's own 32-deep Hit ring — not building a second one
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §4: "`Hit` and `MoveResult` records come from a
// 32-deep ring" — one ring for the whole `Hit` type, already built by
// `cast.js` (`HIT_RING_SIZE`, PHYS-3) since it was the first ticket that
// needed one. This file does NOT construct a second one: `SweepSystem`
// reads the live `PhysicsSystem` instance fresh per call (the same seam
// `CastSystem`/`SeparationSystem` already use) and draws its ring slot via
// `phys._casts._nextRingHit()` — the exact same rotating cursor `rayCast`/
// `circleCast` already draw from, so `sweepProjectile` calls interleave into
// the same 32-slot rotation rather than owning a parallel one. A caller-
// supplied `out` bypasses the ring entirely, exactly like every other cast.
//
// ---------------------------------------------------------------------------
// Decisions this ticket inherits verbatim from cast.js (not reinvented)
// ---------------------------------------------------------------------------
// D1 — flat/2D: `y`/`height` are not part of any `Hit`/cast signature, so
//      this sweep, like every cast in cast.js, treats every footprint (and
//      every body) as an infinite vertical column. No vertical test exists
//      here to invent one for.
// D2 — mitered corners: `radius > 0` inflates a box/poly's edges outward by
//      `radius` and clips half-planes, exactly `rayVsConvexInflated` below —
//      exact everywhere except the small region right at a corner, where the
//      mitered boundary sits slightly outside the true rounded shape. That
//      makes a corner-region false hit possible in principle, never a missed
//      one — irrelevant to (and never a cause of) this ticket's own
//      no-tunnelling acceptance criterion.
// D4 — a body flagged `BODY_FLAG.NO_COLLIDE` is still fully visible to this
//      query, unfiltered — cast.js's queries never check body flags at all,
//      and this file follows suit (no `BODY_FLAG` import here either).
// D5 — a body hit reports `surface: 'flesh'`, `staticHandle: 0`, and
//      `actorId` set to the hit body's `actorId` (not its internal slot or
//      `bodyId`).
// D6 — `excludeId` is compared against a candidate body's `actorId`, not its
//      `bodyId` — the same space `nearest`'s own `excludeId` already uses,
//      and the space a projectile's owner naturally has on hand (its own
//      `actorId`, per `11-flows.md` §5.5's `spawnProjectile({ ownerRef, ... })`
//      and step 4's own `excludeId` argument).
//
// ---------------------------------------------------------------------------
// Post-acceptance fix — the static gather was NOT disk-aware (found by the
// orchestrator's own probe, two failures, deterministic repro, no randomness
// needed; this ticket's own 10 000-trial acceptance test could not see
// either because both need radius > 0 or a static count this file's own
// tests never reached)
// ---------------------------------------------------------------------------
// FAILURE 1 — the DDA below (this file's first draft) walked, at every step,
// the SINGLE cell the swept segment's CENTRE LINE currently occupies. But
// the thing actually being swept is a DISK of `radius`, not a zero-width
// line — a footprint hashed only into a cell adjacent to (never entered by)
// the centre line is invisible to a centre-line-only DDA even when the disk
// plainly overlaps it (repro: centre line at z=1.999, a wall spanning
// z=[2.05, 2.55], radius=0.3 — the disk reaches 0.051 m into the wall's cell
// row, the centre line does not enter it at all, and the old code missed the
// wall entirely; nudging the centre line 0.002 m across the cell boundary,
// with IDENTICAL geometry otherwise, flipped the result). Note this defect
// is real in `cast.js`'s `circleCast` too (same shape of gather, same root
// cause) — that is explicitly NOT this file's to fix (PHYS-3 owns it and it
// is already accepted); it is being tracked separately by whoever owns that
// file. From here on `sweep.js`'s gather deliberately DIVERGES from
// `cast.js`'s (no longer "identical Amanatides-Woo traversal", the comment
// this file used to carry) — see `_sweepStaticsInto` below for what it does
// instead and the proof that it is sufficient.
//
// FAILURE 2 — `SWEEP_CANDIDATE_CAPACITY` (a fixed 256-entry buffer, filled
// during the gather, narrow-phase-tested in a second pass afterward) simply
// stopped accepting new handles past 256 and the second pass never saw what
// didn't fit — a real, closer blocker hashed onto cell #257 silently never
// got tested (repro: 200 harmless cylinders plus the real wall hashes 201
// entries and the wall is found; 260 cylinders plus the wall hashes 261
// entries — one past the cap — and the wall, unchanged, is no longer found).
// This is fixed below by removing the two-pass "gather into a bounded array,
// then test the array" shape entirely: the DDA below narrow-phase-tests each
// footprint the moment it is found (one bound callback, allocation-free, the
// same "bind once in the constructor" discipline the old `_collectCandidate`
// used), so there is no buffer to overflow and therefore nothing to overflow
// silently. `SWEEP_CANDIDATE_CAPACITY` is gone.
//
// The fix (`_sweepStaticsInto`/`_testCellBlock` below): at every cell the
// centre-line DDA visits, also test every cell within `cellsRadius =
// Math.ceil(radius / cellSize)` cells of it (a `(2*cellsRadius+1)^2` block),
// not just the one cell the centre line is in. This is provably sufficient
// and does not require a second, more complex swept-AABB traversal:
//
//   Claim: any cell that a disk of radius `r`, centred SOMEWHERE inside cell
//   C, can possibly touch lies within `k = ceil(r / cellSize)` cells of C
//   (in cell-index terms, each axis independently).
//   Proof sketch: the disk's centre can sit anywhere in C, including
//   arbitrarily close to one of C's edges (distance -> 0), so a cell
//   adjacent to C (offset 1) can always be reached by ANY r > 0 in the worst
//   case — that is exactly Failure 1's own repro. A cell at offset `m` (m
//   whole cells away) requires the centre-to-that-cell's-near-edge distance,
//   which is at least `(m - 1) * cellSize` (the `m-1` FULL cells strictly
//   between C and it), to be covered by `r`; that demands `r >= (m-1) *
//   cellSize`, i.e. `m <= r / cellSize + 1`. Cells beyond that can never be
//   touched regardless of where in C the centre sits. `k = ceil(r /
//   cellSize)` is chosen so the block spans exactly the offsets `0..k` that
//   satisfy `m <= r/cellSize + 1` conservatively (the `+1` slack costs at
//   most one extra ring of cells, never a missed one).
//
//   Coverage argument: the DDA visits every cell the centre-line SEGMENT
//   passes through (standard Amanatides-Woo — no cell along the segment is
//   ever skipped, corner-crossings included; see the loop below). Any cell
//   the swept DISK touches has a closest point that lies on the segment
//   itself (a disk only reaches where its centre could be, and the centre
//   only ever occupies points on the segment) — that closest point sits in
//   some cell C' that the DDA visits by the previous sentence, and the
//   target cell is, by the Claim above, within `k` cells of C'. So the
//   target cell is inside the block tested when the DDA visits C'. No gap.
//
// `radius = 0` (`k = 0`) degenerates to exactly the old single-cell-per-step
// behaviour — this file's own zero-radius tests (and `sweepProjectile`'s
// agreement with `rayCast` at radius 0) are unaffected. For realistic
// projectile radii (well under `CELL_SIZE = 2 m`), `k = 1`, a 3x3 block per
// DDA step — a bounded, small constant-factor cost, not a blowup.
// Duplicate narrow-phase tests of the same footprint across overlapping
// per-step blocks are possible and harmless (the running "best so far"
// simply never regresses) — the same "duplicates possible, harmless"
// accounting `cast.js`'s own gather already documents.

/** Mirrors `cast.js`'s own copy of `LAYER.STATIC` (`02-api-contracts.md`
 * §4: `STATIC: 1`) — duplicated for the same reason cast.js duplicates it
 * from `index.js`: importing it back out of `index.js` (which imports THIS
 * file) would be circular, and importing it from `cast.js` would reach into
 * a file this ticket does not own. */
const STATIC_LAYER = 1;

/** Mirrors `src/physics/index.js`'s private `KIND_BOX`/`KIND_CYLINDER`/
 * `KIND_POLY` numbering (also duplicated, for the same reason, by both
 * `cast.js` and `body.js` — see either file's header). */
const KIND_BOX = 0;
const KIND_CYLINDER = 1;
const KIND_POLY = 2;

/** Safety valve on the grid-traversal (DDA) loop below — identical
 * reasoning and value to `cast.js`'s own `MAX_DDA_STEPS`. Bounds the
 * centre-line step count only; it does not bound (and does not need to
 * bound) the per-step block width — see the "Post-acceptance fix" section
 * above for why there is no candidate-count cap in this file any more. */
const MAX_DDA_STEPS = 20000;

/** Resets `h` (in place) to the `Hit` record's documented "miss" default —
 * byte-identical to `cast.js`'s own private `resetHit`, duplicated here so
 * this file never reaches into `cast.js`'s unexported internals. */
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
// Geometry — duplicated from cast.js verbatim (see that file's own header
// for the full derivation of each). A moving point (radius 0) or circle
// (radius > 0) along a ray, vs. one footprint shape; every function writes
// its entry time `t` into a caller-owned `normalOut` scratch object and
// returns `t`, or `null` for "no hit in range".
// ---------------------------------------------------------------------------

/** Ray `(ox,oz) + t*(dirx,dirz)` (unit direction) vs. a circle of radius `R`
 * centred at `(cx,cz)`. Exact — standard ray/circle quadratic. See cast.js's
 * `rayVsCircle` for the full derivation; identical here.
 * @returns {number | null} */
function rayVsCircle(ox, oz, dirx, dirz, cx, cz, R, maxDist, normalOut) {
  if (R <= 0) return null;
  const fx = ox - cx;
  const fz = oz - cz;
  const b = fx * dirx + fz * dirz;
  const c = fx * fx + fz * fz - R * R;
  if (c > 0 && b > 0) return null; // outside the circle and moving away from it
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc); // Math.sqrt, never Math.hypot
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

/** Ray `(ox,oz) + t*(dirx,dirz)` (unit direction) vs. a convex polygon
 * (`pts`, flat CCW world-space, `n` points), inflated outward by `inflate`.
 * Standard half-plane clipping (Cyrus-Beck/Liang-Barsky generalised to n
 * half-planes). See cast.js's `rayVsConvexInflated` for the full derivation;
 * identical here.
 * @returns {number | null} */
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
    const nz = -ex / len; // outward unit normal, CCW winding

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
    bestNx = -dirx;
    bestNz = -dirz;
  }
  normalOut.nx = bestNx;
  normalOut.nz = bestNz;
  return t;
}

/** World-space box corners, CCW — identical formula to cast.js's/body.js's
 * own `boxCorners`/box branch. Writes into `out` (`Float64Array`, length
 * >= 8). */
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

/** World-space poly corners — identical formula to cast.js's own
 * `polyCorners`. Writes into `out` (`Float64Array`, length >= 2n). */
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

export class SweepSystem {
  /** @param {import('./index.js').PhysicsSystem} phys — read fresh per
   * call, the same seam `CastSystem`/`SeparationSystem` already use (see
   * cast.js's own header for why). */
  constructor(phys) {
    this._phys = phys;

    /** Reused world-space corner buffer for box (4 pts) / poly (<= 8 pts)
     * ray tests. */
    this._scratchPoly = new Float64Array(16);

    /** Reused `{nx,nz}` output of every ray-vs-shape test in this file. */
    this._scratchNormal = { nx: 0, nz: 0 };

    // --- Per-call static-sweep state, read/written by `_testStaticCandidate`
    // below (bound ONCE, here, never per call — see that field's own
    // comment). `_sweepStaticsInto` sets the "_cur*" fields fresh at the
    // start of every call; the "_best*" fields are the running "closest hit
    // so far" this file's narrow-phase test updates as it goes, replacing
    // the old bounded `_candidateHandles` array (see this file's header,
    // "Post-acceptance fix", Failure 2) with an unbounded streaming
    // accumulation — there is no capacity here to overflow.
    this._curOx = 0;
    this._curOz = 0;
    this._curDirx = 0;
    this._curDirz = 0;
    this._curCastRadius = 0;
    this._curMaxDist = 0;
    this._bestT = Infinity;
    this._bestNx = 0;
    this._bestNz = 0;
    this._bestSurface = 'stone';
    this._bestStaticHandle = 0;
    this._foundStatic = false;

    /** Bound once (not per call) — a fresh closure per call would be a
     * per-call allocation (the same discipline `cast.js`'s own
     * `_collectCandidate` documents). Narrow-phase-tests a single static
     * handle immediately, updating `_best*` if it beats the running best —
     * this IS the fix for Failure 2 (no array to fill, so nothing to
     * silently drop past a cap). */
    this._testStaticCandidate = (handle) => {
      const phys = this._phys;
      const slot = handle - 1;
      if (!phys._alive[slot]) return;
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
  }

  /**
   * Tests every cell within `cellsRadius` of `(cx,cz)` (a
   * `(2*cellsRadius+1)^2` block, or just `(cx,cz)` itself when
   * `cellsRadius` is 0) against the current sweep — see this file's header,
   * "Post-acceptance fix", for why a single cell is not enough once
   * `radius > 0` (Failure 1) and for the proof this block size is
   * sufficient.
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
   * `_bestSurface`/`_bestStaticHandle`/`_foundStatic`; the CALLER
   * (`sweepProjectile`) is responsible for resetting those before invoking
   * this, since the body-sweep phase that follows needs to keep improving
   * on the same running best rather than starting over.
   *
   * Centre-line traversal is the same Amanatides-Woo DDA `cast.js`'s own
   * gather uses (this file no longer shares that gather verbatim — see the
   * header); the divergence is `_testCellBlock` above being called instead
   * of a single-cell `forEachInCell`.
   * @private
   */
  _sweepStaticsInto(ox, oz, dirx, dirz, castRadius, maxDist) {
    this._curOx = ox;
    this._curOz = oz;
    this._curDirx = dirx;
    this._curDirz = dirz;
    this._curCastRadius = castRadius;
    this._curMaxDist = maxDist;

    const grid = this._phys._grid;
    const cellSize = grid.cellSize;
    // See this file's header for the proof: any cell a disk of radius
    // `castRadius`, centred anywhere in a given cell, can touch lies within
    // `cellsRadius` cells of it.
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
      tDeltaX = (cellSize / dirx) * stepX;
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
        cx += stepX;
        cz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      }
      steps++;
    }
  }

  /**
   * One static footprint's swept-circle intersection, dispatched by shape —
   * identical dispatch to `cast.js`'s own `_rayVsStatic`.
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
   * `02-api-contracts.md` §4: `sweepProjectile(x,z,dx,dz,radius,mask,
   * excludeId,out?) => Hit`. `(dx,dz)` is the full per-step DISPLACEMENT —
   * see this file's header for why, not a direction to be re-normalized.
   * `excludeId` is compared against a body's `actorId` (D6), matching
   * `nearest`'s own convention.
   * @returns {object} `out`, or the next slot of cast.js's shared Hit ring.
   */
  sweepProjectile(x, z, dx, dz, radius, mask, excludeId, out) {
    const phys = this._phys;
    const result = out || phys._casts._nextRingHit();
    phys._stats.casts++;

    resetHit(result);
    const maxDist = Math.sqrt(dx * dx + dz * dz); // Math.sqrt, never Math.hypot
    if (maxDist < 1e-12) return result; // no movement this step — nothing to sweep
    const dirx = dx / maxDist;
    const dirz = dz / maxDist;

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
      this._sweepStaticsInto(x, z, dirx, dirz, radius, maxDist);
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

    if ((mask & ~STATIC_LAYER) !== 0) {
      const bodies = phys._bodies;
      const cap = bodies.capacity;
      for (let slot = 0; slot < cap; slot++) {
        if (!bodies._alive[slot]) continue;
        if (bodies._actorId[slot] === excludeId) continue; // D6 — never hit the excluded actor (e.g. the projectile's owner)
        if ((bodies._layer[slot] & mask) === 0) continue;
        const bound = bestT < maxDist ? bestT : maxDist;
        const t = rayVsCircle(x, z, dirx, dirz, bodies._x[slot], bodies._z[slot], bodies._radius[slot] + radius, bound, this._scratchNormal);
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
      result.hit = true;
      result.x = x + dirx * bestT;
      result.z = z + dirz * bestT;
      result.nx = bestNx;
      result.nz = bestNz;
      result.distance = bestT;
      result.fraction = bestT / maxDist;
      result.surface = bestSurface;
      result.actorId = bestActorId;
      result.staticHandle = bestStaticHandle;
    }
    return result;
  }
}
