// src/nav/snap.js
//
// NAV-5 — `snap`: `docs/spec/02-api-contracts.md` §6's `snap(x,z,maxRadius,
// out?) => Vec3 | null` — "nearest walkable point, null when nothing
// walkable lies within maxRadius". `src/nav/index.js` wires this in with one
// import and a thin forward (`this._grid`, plus its own `_snapScratch` for
// the no-`out` case) — the same `astar.js`/`smooth.js`/`flow.js` split every
// earlier NAV ticket already established: the real algorithm lives here,
// index.js only forwards.
//
// ===========================================================================
// "Nearest point", not "nearest cell" — I3's own wording is the proof
// ===========================================================================
// `07-world-gen.md` §7.1 I3: "`nav.snap(p, 0.0)` returns `p` unchanged (i.e.
// it is *already* on a walkable cell, not merely near one)" — a cell-centre
// answer would fail this the moment `p` is not exactly a cell centre, which
// is true of almost every real caller (click-to-move targets, a portal's
// hand-placed point, a loot-scatter offset). So "nearest walkable point"
// here means the literal geometric nearest point of the CLOSED square
// `[cellMinX,cellMaxX] x [cellMinZ,cellMaxZ]` a walkable cell covers — found
// by clamping `(x,z)` into that square (`clampedX = clamp(x, cellMinX,
// cellMaxX)`, likewise `z`) and measuring the squared distance from the
// query point to the clamped point. When `(x,z)` is itself inside a walkable
// cell, clamping is a no-op (the point is already within its own cell's
// bounds by construction — `cellIndexAt`'s own `floor((x-originX)/cellSize)`
// formula guarantees `cellMinX <= x < cellMaxX`), so the distance is exactly
// 0 and the returned point is `(x,z)` — coordinate for coordinate, not a
// rounded neighbour. This is what makes I3 fall out of the general
// algorithm rather than needing a special case bolted onto it (see the fast
// path below, which exists for speed, not correctness — the boundary
// section further down proves the two never disagree).
//
// ===========================================================================
// The fast path: `walkable(grid,x,z)` first, before any search
// ===========================================================================
// The overwhelmingly common real call (a move order to a point already on
// open ground, `actors.teleport`'s own portal/entry destinations) needs no
// search at all: `grid.js`'s own `walkable(grid,x,z)` (the same predicate
// `nav.walkable` exposes) already answers "is this exact point on a walkable
// cell", off-grid included (`cellIndexAt` returns `-1` there, `walkable`
// reads that as false — never a crash). When it says yes, the answer is
// `(x,z)` unchanged, at every `maxRadius` including 0 — this IS I3, and it
// costs one cell lookup instead of scanning a whole neighbourhood. When it
// says no, `maxRadius === 0` has nowhere left to search (see "Why the
// maxRadius===0 shortcut is exact", below) and returns `null` immediately;
// otherwise the box search below runs.
//
// ===========================================================================
// Why the maxRadius===0 shortcut is exact, not an approximation
// ===========================================================================
// At `maxRadius = 0` the general box search's own bounds collapse to a
// single cell: `floor((x-0-originX)/cellSize)` and `floor((x+0-originX)/
// cellSize)` are the identical expression, so `minCx === maxCx` and likewise
// for `z` — the box is always exactly the query point's own cell (or empty,
// if that cell is off-grid). The fast path already tested precisely that
// cell and found it not walkable, so there is nothing left for the general
// search to find; skipping straight to `null` is not a looser check, it is
// the same answer without re-deriving it.
//
// ===========================================================================
// Tie-breaking — deterministic, total, and stated once here
// ===========================================================================
// Ties (two walkable cells producing an equal squared distance) are broken
// by SCAN ORDER: the box is walked row-major, `cz` ascending outer, `cx`
// ascending inner (lowest world-z first, then lowest world-x), and a
// candidate replaces the current best only on a STRICTLY smaller squared
// distance (`distSq < bestSq`, never `<=`). The first cell reached in that
// fixed order among however many share the minimum distance is therefore
// always kept, every time, for the same grid and the same query — the
// determinism gate this project's other tie-breaks (`astar.js`'s heap
// ordering, `flow.js`'s bucket draining) already rely on the identical
// discipline for.
//
// One genuine edge case this rule resolves rather than hides: at an EXACT
// grid-line coordinate (`x - originX` a precise multiple of `cellSize`)
// whose OWN (floor-owned) cell is blocked but whose immediate neighbour
// across that exact line is walkable, the box search finds that neighbour
// at true distance 0 (its clamped point equals the query exactly, before
// the winner-only edge nudge below runs). That clamp lands on the
// neighbour's `cellMaxX`/`cellMaxZ` — the walkability-safety nudge
// (`CELL_EDGE_EPSILON`) therefore always fires here, returning a point
// `CELL_EDGE_EPSILON` metres inside the walkable neighbour rather than the
// literal query coordinate. This is the CORRECT outcome — the query's own
// coordinate sits on a blocked cell's boundary and returning it unchanged
// would fail `walkable()` on the returned point, exactly the class of bug
// `CELL_EDGE_EPSILON` exists to prevent — at the cost of the returned point
// differing from the input by up to `1e-4` m in this one synthetic case
// (an exact multiple of `cellSize`, never a float a real gameplay position
// lands on).
//
// ===========================================================================
// Region — deliberately NOT filtered here
// ===========================================================================
// `02-api-contracts.md` §6's `snap` row says nothing about region; I3 itself
// spells out region as a SEPARATE check a caller composes on top: "every
// SpawnPoint... satisfies walkable(p), regionAt(p) === entryRegion, AND
// nav.snap(p,0.0) returns p unchanged" — three independent clauses, not one
// snap call doing all three. If snap silently refused a nearer point in a
// different region, a caller that actually wants "any walkable point,
// regardless of region" (loot scatter, say, before `items` exists to prove
// it) would have no way to ask for that, and a caller that DOES care about
// region already has `regionAt` to check the result with (exactly I3's own
// pattern). Region-aware snapping composes for free from the two existing
// primitives; baking it into `snap` would remove that composability for no
// call site this milestone actually needs it filtered.
//
// ===========================================================================
// Degenerate input — never throws
// ===========================================================================
// `NaN`/`Infinity` in `x`, `z` or `maxRadius`, and a negative `maxRadius`,
// all return `null` immediately (checked with `Number.isFinite`, which is
// false for both `NaN` and either `Infinity`) — there is no meaningful
// "nearest point" to a query that is not itself a real, bounded distance,
// and `null` is already this method's documented non-crash signal. A point
// far outside the grid entirely is not degenerate, just distant: every cell
// index below is bounds-clamped against `grid.width`/`grid.height` before
// the box loop runs, so a huge or hugely negative coordinate produces an
// empty (or grid-clamped) box and reads back `null` or a real in-grid
// answer, never an out-of-range array read.
//
// ===========================================================================
// Alloc: no — the caller-owned `out` convention, no ring needed
// ===========================================================================
// Unlike `physics`'s cast results (a single query can report several
// simultaneous hits, all needing to stay alive for the caller to read before
// the next cast overwrites them — hence that subsystem's 32-deep ring),
// `snap` produces exactly one `Vec3` per call, and this codebase already has
// a precedent for exactly that shape: `astar.js`'s `pathNode`/`flow.js`'s
// `flowAt`, both single-result methods that reuse ONE shared scratch object
// across every no-`out` call, valid until the next call to that same
// method. `src/nav/index.js` owns that scratch (`this._snapScratch`, built
// once in its constructor) and passes it here as `out` whenever its own
// caller omitted one; this function itself never allocates — it only ever
// writes into whichever object it was handed.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (O-29).

import { NAV_FLAG, cellIndexAt, walkable as gridWalkable } from './grid.js';

// ===========================================================================
// CELL_EDGE_EPSILON — a real bug this ticket found and fixed before
// submission: a naive closed-interval clamp can hand back a point that
// fails `walkable()`
// ===========================================================================
// `cellIndexAt`'s own convention (`grid.js`) is HALF-OPEN per cell:
// `floor((x-originX)/cellSize)` means a cell owns `[cellMinX, cellMaxX)` —
// its lower edge is IN the cell, its upper edge belongs to the NEXT cell
// over. A first implementation clamped `x` into the CLOSED interval
// `[cellMinX, cellMaxX]` when computing the nearest point inside a
// candidate cell — correct for distance, but when the clamped value landed
// EXACTLY on `cellMaxX` (the query point sits at or past that candidate
// cell's far edge), that coordinate is not actually owned by this cell at
// all under `cellIndexAt`'s own floor() rule; it resolves into the cell
// NEXT door, which can be blocked. Measured directly: on a 5x5 checkerboard
// grid this handed back `(1.0, z)` as "the nearest walkable point" for a
// candidate cell covering `[0.5,1.0)`, and `nav.walkable(1.0, z)` — the
// exact predicate this ticket's own brief says the result must satisfy —
// read `false`, because `1.0` floors into the NEXT cell over, which was
// blocked. Ticket rule: "The result must be walkable... check it: a snapped
// point that lands on a blocked cell defeats the entire purpose." This is
// exactly that failure, not a hypothetical.
//
// The fix: once the true nearest cell has been selected (on UNMODIFIED
// distances — see "Winner-only edge nudge" at the bottom of `snapPoint`),
// if its clamped coordinate landed exactly on that cell's `cellMaxX`/
// `cellMaxZ`, nudge it inward to `cellMaxX - CELL_EDGE_EPSILON` before
// returning, so it always floors back into the SAME cell it was computed
// against. Applying the nudge only to the already-chosen winner — never
// during the scan's own distance comparisons — matters: nudging every
// upper-bound clamp DURING the scan would silently bias a genuine tie
// between an upper-bound-clamped cell and a lower-bound-clamped cell (whose
// exact edge needs no nudge) away from pure scan-order tie-breaking, which
// is exactly the determinism rule this file documents. `CELL_EDGE_EPSILON =
// 1e-4` m (0.1 mm) — ASSIGNED, no spec table gives this: chosen far below
// the fixed `01 §9.3` cell size (0.5 m, five thousand times larger) so it
// can never visibly perturb "nearest point" for any real caller, and far
// above float64 rounding error at the coordinate magnitudes this engine's
// zones actually use (a world extent of a few hundred metres needs roughly
// `1e-13`-scale precision to lose a `1e-4` offset to rounding — nowhere
// close). The lower bound needs no such adjustment: `cellMinX` IS the
// cell's own inclusive edge under `cellIndexAt`'s convention, so clamping
// exactly to it already lands back in the same cell.
const CELL_EDGE_EPSILON = 1e-4;

/**
 * The real NAV-5 algorithm. `grid` is a `NavGrid` (`src/nav/grid.js`); `out`
 * is the `Vec3`-shaped object (`{x,y,z}`) this function writes its answer
 * into — always supplied by the caller (`src/nav/index.js`'s `snap()`,
 * itself using its own `out` argument or its shared `_snapScratch`), never
 * allocated here.
 * @param {object} grid a `NavGrid`
 * @param {number} x @param {number} z @param {number} maxRadius
 * @param {{x:number,y:number,z:number}} out
 * @returns {{x:number,y:number,z:number} | null}
 */
export function snapPoint(grid, x, z, maxRadius, out) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(maxRadius) || maxRadius < 0) {
    return null;
  }

  // Fast path / I3 — see file header. Exact, not an approximation: this is
  // the same `walkable()` predicate `nav.walkable` itself exposes.
  if (gridWalkable(grid, x, z)) {
    const idx = cellIndexAt(grid, x, z);
    out.x = x;
    out.y = grid.groundY[idx];
    out.z = z;
    return out;
  }

  // maxRadius===0 shortcut — see file header for why this is exact, not a
  // looser check, given the fast path above already failed.
  if (maxRadius === 0) return null;

  const cellSize = grid.cellSize;
  const width = grid.width;
  const height = grid.height;
  const originX = grid.originX;
  const originZ = grid.originZ;
  const flags = grid.flags;
  const groundY = grid.groundY;

  // The box of cells whose square footprint can possibly fall within
  // maxRadius of (x,z), clamped to the grid so out-of-bounds/far-away
  // queries can never read outside the typed arrays (see file header,
  // "Degenerate input").
  let minCx = Math.floor((x - maxRadius - originX) / cellSize);
  let maxCx = Math.floor((x + maxRadius - originX) / cellSize);
  let minCz = Math.floor((z - maxRadius - originZ) / cellSize);
  let maxCz = Math.floor((z + maxRadius - originZ) / cellSize);
  if (minCx < 0) minCx = 0;
  if (minCz < 0) minCz = 0;
  if (maxCx > width - 1) maxCx = width - 1;
  if (maxCz > height - 1) maxCz = height - 1;

  const maxRadiusSq = maxRadius * maxRadius;
  let bestSq = Infinity;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestCx = -1;
  let bestCz = -1;
  let found = false;

  // Row-major scan, cz ascending outer / cx ascending inner — see file
  // header, "Tie-breaking", for why this exact order is the determinism
  // contract, not an incidental detail. Selection below clamps to the TRUE
  // closed cell edge (`cellMaxX`/`cellMaxZ`, never the epsilon-inset one) —
  // tie-breaking must run on unmodified distances, so a genuine tie is
  // decided by scan order alone, never nudged one way by the walkability
  // safety margin applied afterwards (see "Winner-only edge nudge" below).
  for (let cz = minCz; cz <= maxCz; cz++) {
    const cellMinZ = originZ + cz * cellSize;
    const cellMaxZ = cellMinZ + cellSize;
    const clampedZ = z < cellMinZ ? cellMinZ : z > cellMaxZ ? cellMaxZ : z;
    const rowBase = cz * width;
    for (let cx = minCx; cx <= maxCx; cx++) {
      const idx = rowBase + cx;
      if ((flags[idx] & NAV_FLAG.walkable) === 0) continue;

      const cellMinX = originX + cx * cellSize;
      const cellMaxX = cellMinX + cellSize;
      const clampedX = x < cellMinX ? cellMinX : x > cellMaxX ? cellMaxX : x;

      const dx = clampedX - x;
      const dz = clampedZ - z;
      const distSq = dx * dx + dz * dz; // never Math.hypot — see ARCHITECTURE.md
      if (distSq > maxRadiusSq) continue;
      if (distSq < bestSq) {
        bestSq = distSq;
        bestX = clampedX;
        bestZ = clampedZ;
        bestY = groundY[idx];
        bestCx = cx;
        bestCz = cz;
        found = true;
      }
    }
  }

  if (!found) return null;

  // Winner-only edge nudge — applied exactly once, to the single already-
  // selected cell, never during the scan above (see CELL_EDGE_EPSILON's own
  // header for the walkability bug this fixes, and the comment above for why
  // doing it here, post-selection, keeps tie-breaking pure). `bestX`/`bestZ`
  // can only ever equal `cellMinX`/`cellMinZ` (already owned by `bestCx`/
  // `bestCz` under `cellIndexAt`'s convention — no nudge needed) or the
  // TRUE `cellMaxX`/`cellMaxZ` (owned by the NEXT cell over — nudge inward).
  const winMaxX = originX + (bestCx + 1) * cellSize;
  if (bestX === winMaxX) bestX = winMaxX - CELL_EDGE_EPSILON;
  const winMaxZ = originZ + (bestCz + 1) * cellSize;
  if (bestZ === winMaxZ) bestZ = winMaxZ - CELL_EDGE_EPSILON;

  out.x = bestX;
  out.y = bestY;
  out.z = bestZ;
  return out;
}
