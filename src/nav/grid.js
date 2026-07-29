// src/nav/grid.js
//
// NAV-1 — the `NavGrid` and its read-only accessors: `walkable`, `flagsAt`,
// `regionAt`, `connected` (docs/spec/02-api-contracts.md §6). Every one is
// `Fixed: Y, Alloc: no` — pure reads over a pre-built grid, no allocation,
// no `ctx`.
//
// ---------------------------------------------------------------------------
// The one sanctioned cross-subsystem import lives HERE, and only here
// ---------------------------------------------------------------------------
// This ticket's brief grants a narrow, named exception: `src/world/raster.js`
// (WRLD-2) is a pure, zero-import library — the N1-N10 rasterisation passes
// as plain functions over a `NavGrid` it also knows how to allocate. It is
// not a subsystem surface (no `ctx`, no `static id`, nothing to `ctx.get()`),
// so importing it is not the "import another subsystem's module" ARCHITECTURE.md
// rule 2 forbids. To keep that exception scoped to exactly one file, only
// `src/nav/grid.js` contains `import ... from '../world/raster.js'`;
// `src/nav/index.js` (the `NavSystem` class) never imports it directly — it
// gets everything, including `NAV_FLAG` and the raster passes, through this
// file. `world` itself is still only ever reached at runtime via
// `ctx.get('world')` / `ctx.peek('world')`, never imported — see
// `src/nav/index.js`'s header.
//
// ---------------------------------------------------------------------------
// NAV_FLAG ownership — re-exported, not re-defined
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §6 says `nav` "Owns exclusively: ... NAV_FLAG", but
// `src/world/raster.js` had to transcribe the bit constants from
// `01-data-model.md` §9.3 before `src/nav/` existed (WRLD-2's own header
// flags this as nav's to re-own). Re-owning does not mean writing a second
// copy — `NAV_FLAG` below is the exact same frozen object `raster.js`
// exports, re-exported through this file so every other reader of
// `NAV_FLAG` in this codebase (this file, `src/nav/index.js`, and any test)
// resolves to one shared reference. Two independently-defined copies of the
// same bit table is exactly the class of defect this project has already
// paid for twice (O-32, O-35, cited in this ticket's brief) — see
// `tests/nav/nav1.test.js` for the identity check that proves there is only
// one definition.
export {
  NAV_FLAG,
  RASTER,
  createNavGrid,
  createRasterScratch,
  worldToCell,
  cellIndexAt,
  rasterizeNav,
  // Re-exported only so `src/nav/index.js` can build its tiny placeholder
  // grid (see that file's constructor) without itself importing
  // `../world/raster.js` — every N1-N10 pass stays reachable through this
  // one file, never duplicated.
  passN1Clear,
  passN2GroundStamp,
  passN7Regions,
} from '../world/raster.js';

import { NAV_FLAG, cellIndexAt } from '../world/raster.js';

/**
 * `02-api-contracts.md` §6: `walkable(x,z) => boolean`. Off-grid is not
 * walkable (`cellIndexAt` returns `-1` there, which never matches a real
 * flags-array index). Allocation-free: `cellIndexAt` returns a plain number.
 * @param {object} grid a `NavGrid`
 * @param {number} x @param {number} z
 * @returns {boolean}
 */
export function walkable(grid, x, z) {
  const i = cellIndexAt(grid, x, z);
  if (i < 0) return false;
  return (grid.flags[i] & NAV_FLAG.walkable) !== 0;
}

/**
 * `02-api-contracts.md` §6: `flagsAt(x,z) => int` — the `NAV_FLAG` bitfield.
 * Off-grid reads as `0` (no flags set), the same "absent means nothing is
 * true of it" convention `walkable`/`regionAt` use.
 * @param {object} grid @param {number} x @param {number} z
 * @returns {number}
 */
export function flagsAt(grid, x, z) {
  const i = cellIndexAt(grid, x, z);
  return i < 0 ? 0 : grid.flags[i];
}

/**
 * `02-api-contracts.md` §6: `regionAt(x,z) => int` — `-1` when blocked.
 * `-1` also covers off-grid, which is exactly as "not part of any walkable
 * region" as a blocked cell is — `01-data-model.md` §9.3's `region` array
 * already uses `-1` for both "blocked" and "pruned", so extending it to
 * "outside the grid entirely" is the same sentinel, not a new one.
 * @param {object} grid @param {number} x @param {number} z
 * @returns {number}
 */
export function regionAt(grid, x, z) {
  const i = cellIndexAt(grid, x, z);
  return i < 0 ? -1 : grid.region[i];
}

/**
 * `02-api-contracts.md` §6: `connected(ax,az,bx,bz) => boolean` — same
 * region. A blocked/off-grid point on EITHER side must never read as
 * "connected" to anything, including another blocked point — two cells that
 * both report `region === -1` are not thereby the same region (`-1` is
 * "not in a region", not a region id of its own). `regionAt(grid,ax,az) < 0`
 * short-circuits before the second lookup, and the final `===` can then
 * never compare two `-1`s against each other.
 * @param {object} grid @param {number} ax @param {number} az
 * @param {number} bx @param {number} bz
 * @returns {boolean}
 */
export function connected(grid, ax, az, bx, bz) {
  const ra = regionAt(grid, ax, az);
  if (ra < 0) return false;
  return ra === regionAt(grid, bx, bz);
}
