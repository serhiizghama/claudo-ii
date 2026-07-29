// src/nav/smooth.js
//
// NAV-3 — `docs/spec/02-api-contracts.md` §6's `smooth(path:PathHandle) =>
// void`: string-pull path smoothing, in place, `Fixed: Y`, `Alloc: no`.
// `src/nav/index.js` wires this in with one import and one delegating method
// (see that file's own NAV-3 addendum) — the algorithm and the segment test
// both live here, matching the astar.js/index.js split NAV-2 already
// established.
//
// ===========================================================================
// Segment-walkability test — option (a), private here, not `raycastNav`
// ===========================================================================
// `02-api-contracts.md` §6 lists `raycastNav(ax,az,bx,bz) => boolean` — "grid-
// space line of walk" — but no M1 ticket owns it yet, and this ticket's own
// brief is explicit that `src/nav/index.js` gets ONE delegating `smooth`
// method, "in the exact shape NAV-2 already used there... do not restructure"
// — there is no room in that constraint to also add a second public method.
// So the segment test below (`segmentWalkable`) is private to this file, not
// exposed on `NavSystem`. It is exported from the module (not from
// `NavSystem`) so a test can exercise it directly and so whichever ticket
// later builds `raycastNav` can import THIS function (or extract it to a
// shared location) instead of writing a second, independently-drifting line-
// of-walk rule — the exact class of defect this project has already paid for
// twice (O-32, O-35, cited by this ticket's brief).
//
// ===========================================================================
// Why the segment test needs no capsule/radius widening
// ===========================================================================
// PHYS-3/PHYS-5's cast/sweep DDA had to widen their traversal to a
// `(2*cellsRadius+1)^2` cell BLOCK per step (see `src/physics/cast.js`'s own
// "Post-acceptance fix" header) because they sweep a DISK of nonzero radius
// along the centre line — a footprint hashed only into a cell the disk
// grazes but the centre line never enters would otherwise be invisible.
// `smooth`'s string-pull tests a MATHEMATICAL, zero-width line between two
// path nodes, not a capsule sweep: `07-world-gen.md` §6.3's 0.30 m dilation
// already bakes the agent's clearance into which CELLS count as walkable (a
// cell is only walkable if its centre sits > 0.30 m from every blocker), so
// a zero-width line that never leaves walkable cells already has clearance on
// both sides — the residual 0.06 m gap between the 0.30 m dilation and the
// player's 0.36 m radius is documented (07 §6.3) as `physics.moveBody`'s
// slide to absorb, not this ticket's problem to re-solve. So the traversal
// below stays a single-cell-per-step DDA (no `cellsRadius` widening) — the
// concern this ticket exists to catch is entirely about NOT SKIPPING a cell
// the zero-width line passes through, never about testing extra cells beyond
// it.
//
// ===========================================================================
// The corner-cut concern, and why a plain Amanatides-Woo DDA is not enough
// ===========================================================================
// Between two consecutive grid-boundary crossings a line segment lies wholly
// inside one cell, so an ordinary "advance whichever axis crosses its
// boundary first" DDA already visits every cell whose INTERIOR the segment
// passes through, in order — provably complete for that case, no different
// from `src/physics/cast.js`'s own centre-line traversal.
//
// The one case that breaks this: the segment passes exactly (or, in floating
// point, near-exactly) through a LATTICE CORNER — the single point shared by
// four cells. At that instant the two ordinary "next crossing" times
// (`tMaxX`, `tMaxZ`) tie, and advancing only one axis (as `cast.js`'s DDA
// does, and as a plain fast-voxel-traversal always does) jumps straight from
// the pre-corner cell to the POST-corner diagonal cell — the segment never
// spends a nonzero-length interval inside either of the other two cells that
// also touch that corner, so their WALKABILITY never gets checked at all.
// Path nodes here are always cell centres (astar.js's `_reconstructPath`), so
// for a path segment aligned so its slope is an exact ratio of small integers
// (the common case for anything stair-stepped, including this ticket's own
// 40 m staircase acceptance scenario) this tie is not a rare edge case — it
// is the ORDINARY shape of the input.
//
// Physically, a corner where the two OTHER cells (the ones sharing only one
// axis each with the segment's start/end cell) are BOTH blocked is exactly
// astar.js's own "no corner-cutting" rule for a single diagonal step: "A
// diagonal step from cell A to cell B is only legal when BOTH orthogonal
// cells A and B share are themselves walkable" (`src/nav/astar.js`, cited
// verbatim). A zero-width line squeezing through that same single point is
// the identical geometry, just spanning many cells instead of one — so this
// file applies the identical rule at every corner-tie the DDA finds: BOTH of
// the two "L" neighbour cells at that corner must be walkable, or the whole
// segment fails. This is what makes the traversal below "supercover" for the
// one case that matters (it is not full supercover in the graphics sense —
// it does not report cells only grazed along a flat edge as "entered" — but
// no such cell can ever hide a corner-cut, since the segment's INTERIOR
// occupies it for a nonzero length and the ordinary DDA already visits it).
//
// `TIE_EPS` below is an epsilon (not exact `===`) on purpose: path-node
// coordinates are exact cell centres, but the `tMaxX`/`tMaxZ` computed from
// them go through a division, and two mathematically-equal quantities
// computed via different divisors are not guaranteed to be bit-identical —
// only close. Using exact equality here would silently fall through to
// ordinary single-axis advancement on a segment that IS geometrically a
// corner case, undoing the whole point of this section. `TIE_EPS = 1e-9` is
// ASSIGNED (no spec value) — no spec gives one; ~1e-9 is many orders above
// double-precision rounding noise on the coordinate magnitudes this game
// uses (zones up to ~100 m, cell size 0.5 m) and many orders below the
// smallest real geometric difference (any two DISTINCT non-corner crossings
// on this grid differ by a fraction of the 0.5 m cell size, not a
// billionth of it).
//
// ===========================================================================
// The string-pull algorithm
// ===========================================================================
// Classic greedy string-pull / line-of-sight simplification, run over the
// ORIGINAL path's node sequence (never a distance/angle threshold — a
// walkability test only):
//
//   anchor = 0                         // node 0 is always kept
//   i = 1
//   while i < n - 1:
//     if segmentWalkable(anchor, i + 1):
//       i += 1                         // extend the probe; do not keep i
//     else:
//       keep node i (it is the furthest point still reachable in a
//         straight line from anchor); anchor = i
//       i += 1
//   keep node n - 1                    // the goal is always kept
//
// Invariant maintained throughout (proved in this file's own tests and
// restated here because it is the crux of both correctness properties the
// ticket asks about):
//
//   segmentWalkable(anchor, i) is true at the top of every loop iteration.
//
// Base case: anchor=0, i=1 — the segment between two ADJACENT original path
// nodes, which astar.js already guarantees is a legal single grid step
// (cardinal, or a corner-safe diagonal — "no corner-cutting" above), hence
// trivially walkable end to end. Inductive step: on "extend", the segment
// just verified true (anchor, i+1) becomes the new (anchor, i) pair. On
// "commit", the new anchor is the OLD i (already true by the invariant), and
// the new i is (old i)+1 — an adjacent ORIGINAL-path pair again, walkable by
// the same base-case argument. So the invariant holds after every iteration,
// which is exactly why the final append (`keep node n-1`) never needs its
// own extra walkability check: either the loop's OWN last test already
// verified `segmentWalkable(anchor, n-1)` directly (the "i" reaches n-1 via
// a successful extend), or the last committed pair IS the original adjacent
// pair `(n-2, n-1)`, walkable by construction.
//
// ===========================================================================
// Idempotence — a direct consequence of the invariant above
// ===========================================================================
// The invariant above is not just "this run's output is internally
// consistent" — by induction on the number of `smooth()` passes, it proves
// ANY output of this function (fed a valid input, defined as: every
// consecutive node pair is straight-line walkable, which the base case
// establishes for a fresh A* path and this paragraph now establishes for a
// SMOOTHED path too) again satisfies that same property. Feed an already-
// smoothed path back in: every "extend" test this second pass runs is
// `segmentWalkable(anchor, i+1)` for an `(anchor, i+1)` pair that is EXACTLY
// one this same deterministic, pure function already tested once during the
// first pass (the smoothed output's own node sequence is a subsequence of
// the original's; every candidate extension is a segment between two nodes
// that both existed, at the same coordinates, in the first pass) — so every
// test yields the identical answer, and the second pass keeps every node the
// first pass kept, one for one. `tests/nav/nav3.test.js` proves this by
// running `smoothPath` twice and diffing the node arrays.
//
// ===========================================================================
// Determinism
// ===========================================================================
// Pure function of `(grid, path's own node coordinates)`. No RNG, no `Map`,
// no object-property iteration order, no floating-point operation whose
// result depends on anything but its own operands (`segmentWalkable` reads
// `grid.flags`/`grid.width`/`grid.height`/`grid.cellSize`/`grid.originX`/
// `grid.originZ` and the two endpoint coordinates only). Two identical
// `(grid, path)` inputs, run independently, always produce byte-identical
// output — `tests/nav/nav3.test.js` proves this the same way
// `tests/nav/nav2.test.js` proves it for A* itself.
//
// ===========================================================================
// In-place compaction — how the array shrinks without `array.length = 0`
// ===========================================================================
// `ARCHITECTURE.md`/this ticket's brief: `array.length = 0` tears a typed
// array's backing store (the next write reallocates). This file never
// touches `.length` at all — `path.nodesX/Y/Z` (`Float32Array`s sized to
// `NODE_CAP`, built once by `astar.js`'s `createRequestRecord`) are written
// in place at indices `0..newCount-1`, and the single integer field
// `path.nodeCount` is updated to the new, smaller count. Every reader of a
// `PathHandle` (`pathNode`, `pathLength`, and this file's own next call)
// already bounds every read by `nodeCount`, so the untouched, stale entries
// at indices `>= newCount` are simply never observed again — there is
// nothing to clear.
//
// The write pattern itself never overwrites data before it has been read:
// the write cursor (`outCount`, the next compacted slot to fill) is proved,
// by induction over the loop below, to never exceed the read cursor (`i`,
// the original-path index currently being examined) — see the inline
// comments in `smoothPath` for the exact invariant. Every write either
// copies a node to its own current position (a harmless no-op, when the path
// has not yet been able to shrink) or moves a node from a higher index down
// to a lower, already-read one — never the reverse, so nothing still needed
// is ever clobbered.
//
// ===========================================================================
// Endpoints, and the `nodeCount <= 2` short-circuit
// ===========================================================================
// Node 0 is written already (it never moves) and the goal (`n-1`) is always
// appended last, so both endpoints survive unconditionally, whatever the
// smoothing decides in between. `nodeCount <= 2` (covers 0, 1 and 2 exactly)
// returns immediately, before touching `nodesX/Y/Z` at all: a 1-node path has
// nothing to simplify and, unlike the >=2 case, the general loop's own
// "append the goal" step would double-write node 0 for it (there is no
// "in-between" to distinguish start from goal) — see this file's own tests
// for the exact regression this guard prevents. A 2-node path is already
// provably minimal (two points can only ever be described by at least two
// nodes) and the general loop already happens to leave it untouched even
// without this guard, but the explicit early return keeps that fact
// self-evident rather than incidental, and it is the same branch that keeps
// the 1-node case safe, so one guard serves both documented survival cases.
//
// ===========================================================================
// Constants — ASSIGNED, none from a spec table
// ===========================================================================
//   TIE_EPS = 1e-9         see "The corner-cut concern" above.
//   the DDA step cap       `grid.width + grid.height + 4` — a straight run
//                          between any two cells in a W x H grid crosses at
//                          most `(W-1)+(H-1)` cell boundaries (the DDA never
//                          revisits a cell), so that many iterations is
//                          always enough to reach the destination cell,
//                          whether crossings advance one axis at a time or,
//                          at a corner tie, both at once. `+4` is slack for
//                          the tie branch (which advances both counters by
//                          one step each, still bounded by the same total).
//                          A safety valve only, mirroring
//                          `src/physics/cast.js`'s own `MAX_DDA_STEPS` —
//                          never expected to trigger on real grid geometry;
//                          reaching it fails the segment CLOSED (treats it
//                          as blocked), the safe direction for an
//                          uncertain/pathological read (an extra kept node,
//                          never a corner-cut).
//
// Node-safe: no `three`, no DOM/browser global, no `ctx`, no
// `performance.now()` anywhere in this file (O-29).

import { NAV_FLAG } from './grid.js';

/** ASSIGNED — see this file's header, "The corner-cut concern". */
const TIE_EPS = 1e-9;

/**
 * True when the straight segment `(ax,az) -> (bx,bz)` never leaves walkable
 * grid cells, using a conservative cell-by-cell traversal that cannot skip
 * the one blocked cell at a diagonal corner (see this file's header for the
 * full argument). `Fixed: Y` (no `ctx`, no clock), `Alloc: no` (every local
 * is a primitive number; no typed array, object or closure is created).
 *
 * Exported (not a `NavSystem` method — see this file's header, "option (a)")
 * so a future `raycastNav` ticket, and this ticket's own tests, can reuse it
 * directly instead of re-deriving the same rule.
 * @param {object} grid a `NavGrid`
 * @param {number} ax @param {number} az @param {number} bx @param {number} bz
 * @returns {boolean}
 */
export function segmentWalkable(grid, ax, az, bx, bz) {
  const flags = grid.flags;
  const width = grid.width;
  const height = grid.height;
  const cellSize = grid.cellSize;
  const originX = grid.originX;
  const originZ = grid.originZ;

  let cx = Math.floor((ax - originX) / cellSize);
  let cz = Math.floor((az - originZ) / cellSize);
  const bcx = Math.floor((bx - originX) / cellSize);
  const bcz = Math.floor((bz - originZ) / cellSize);

  const dx = bx - ax;
  const dz = bz - az;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // `t` below is the fraction of THIS segment (0 at (ax,az), 1 at (bx,bz)),
  // never a world distance — no `Math.sqrt`/`Math.hypot` needed at all,
  // since the DDA only ever compares two `t`s or a `t` against 1.
  let tMaxX = Infinity;
  let tDeltaX = Infinity;
  if (stepX !== 0) {
    const boundaryX = originX + (stepX > 0 ? cx + 1 : cx) * cellSize;
    tMaxX = (boundaryX - ax) / dx;
    tDeltaX = cellSize / (dx > 0 ? dx : -dx);
  }
  let tMaxZ = Infinity;
  let tDeltaZ = Infinity;
  if (stepZ !== 0) {
    const boundaryZ = originZ + (stepZ > 0 ? cz + 1 : cz) * cellSize;
    tMaxZ = (boundaryZ - az) / dz;
    tDeltaZ = cellSize / (dz > 0 ? dz : -dz);
  }

  const stepCap = width + height + 4; // ASSIGNED — see file header.

  for (let steps = 0; ; steps++) {
    if (cx < 0 || cx >= width || cz < 0 || cz >= height) return false;
    if (!(flags[cz * width + cx] & NAV_FLAG.walkable)) return false;
    if (cx === bcx && cz === bcz) return true; // destination cell reached, and just verified walkable

    if (steps >= stepCap) return false; // pathological-input safety valve — fail closed, see file header

    if (tMaxX < tMaxZ - TIE_EPS) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxZ < tMaxX - TIE_EPS) {
      cz += stepZ;
      tMaxZ += tDeltaZ;
    } else {
      // Corner tie (exact or near-exact) — the segment passes through the
      // lattice point shared by four cells. Advancing only one axis would
      // silently skip testing the other "L" neighbour, exactly the
      // corner-cut this file exists to prevent (mirrors astar.js's own
      // diagonal no-corner-cutting rule — see file header). Both L cells
      // must be walkable or the whole segment fails here.
      const lcx = cx + stepX;
      const lcz = cz + stepZ;
      if (stepX !== 0 && (lcx < 0 || lcx >= width || !(flags[cz * width + lcx] & NAV_FLAG.walkable))) return false;
      if (stepZ !== 0 && (lcz < 0 || lcz >= height || !(flags[lcz * width + cx] & NAV_FLAG.walkable))) return false;
      cx = lcx;
      cz = lcz;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
    }
  }
}

/**
 * `02-api-contracts.md` §6: `smooth(path) => void` — string-pull in place.
 * `Fixed: Y`, `Alloc: no`. See this file's header for the algorithm, the
 * write-never-clobbers-unread-data proof, the idempotence proof and the
 * `nodeCount <= 2` short-circuit's own reasoning.
 *
 * Safe no-op on `null`/a malformed handle (this codebase's standing
 * convention for a stale/invalid `PathHandle` — `astar.js`'s own
 * `pathNode`/`pathLength`/`releasePath`), never throws.
 * @param {object} grid a `NavGrid`
 * @param {object} path a `PathHandle` (this file reads/writes its
 *   `nodesX`/`nodesY`/`nodesZ`/`nodeCount` fields directly — the exact shape
 *   `astar.js`'s own `pathNode`/`pathLength`/`_reconstructPath` already use).
 */
export function smoothPath(grid, path) {
  if (!path) return;
  const n = path.nodeCount;
  if (!Number.isInteger(n) || n <= 2) return; // see file header — both survival cases share this guard

  const nodesX = path.nodesX;
  const nodesY = path.nodesY;
  const nodesZ = path.nodesZ;

  let anchorX = nodesX[0];
  let anchorZ = nodesZ[0];
  let outCount = 1; // node 0 already sits at index 0 — nothing to write for it
  let i = 1;
  const last = n - 1;

  while (i < last) {
    const nx = nodesX[i + 1];
    const nz = nodesZ[i + 1];
    if (segmentWalkable(grid, anchorX, anchorZ, nx, nz)) {
      i++; // extend the probe forward; node i itself is not kept (yet)
      continue;
    }
    // Commit node i as the new anchor — invariant: outCount <= i here (see
    // file header), so this write only ever moves data from a
    // not-yet-needed-again higher index down to a lower one (or to itself).
    nodesX[outCount] = nodesX[i];
    nodesY[outCount] = nodesY[i];
    nodesZ[outCount] = nodesZ[i];
    anchorX = nodesX[i];
    anchorZ = nodesZ[i];
    outCount++;
    i++;
  }

  // The goal is always kept, whatever the final anchor turned out to be —
  // same invariant, outCount <= i === last here.
  nodesX[outCount] = nodesX[last];
  nodesY[outCount] = nodesY[last];
  nodesZ[outCount] = nodesZ[last];
  outCount++;

  path.nodeCount = outCount;
}
