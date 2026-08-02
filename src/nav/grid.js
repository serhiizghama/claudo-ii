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
  // one file, never duplicated. `passN6Cost` joins this list as of NAV-6:
  // the placeholder grid now runs N6 too (see that file's constructor for
  // why — `markHazard`'s cost bookkeeping needs a real base cost, not N1's
  // raw 255-everywhere clear value, even before the first `rebuild()`).
  passN1Clear,
  passN2GroundStamp,
  passN6Cost,
  passN7Regions,
} from '../world/raster.js';

import { NAV_FLAG, RASTER, cellIndexAt } from '../world/raster.js';

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

// ---------------------------------------------------------------------------
// markHazard — NAV-6 (D-58). The only writer of NAV_FLAG.hazard.
// ---------------------------------------------------------------------------
//
// `02-api-contracts.md:502`: `markHazard(x,z,radius:number, on:boolean) =>
// void` — "the only writer of `NAV_FLAG.hazard`", `Fixed: Y`, `Alloc: no`.
// `07-world-gen.md` §6.6 restates it dynamically: it sets the bit AND bumps
// `cost` by `RASTER.COST_HAZARD` (12) on the covered cells; clearing it
// undoes both; it never touches `walkable`, never touches `region`.
//
// WHY THIS LIVES IN `grid.js`, NOT `index.js` — the ticket's own question.
// Every other flag-facing function in this file (`walkable`, `flagsAt`,
// `regionAt`, `connected`) is a pure read over a bare `NavGrid`, no `ctx`,
// no subsystem state. `markHazard` is the write-side of exactly that same
// surface — it belongs next to them for the same reason N1-N10 belong in
// `raster.js` and not in `index.js`: it is grid-cell arithmetic, testable
// against a hand-built `NavGrid` with no `ctx`/`NavSystem` in the loop at
// all (see `tests/nav/nav6.test.js`'s cell-math tests, which do exactly
// that). What it is NOT allowed to own is the two per-cell bookkeeping
// buffers below (`refcount`/`baseCost`) — `rule 5` requires those
// preallocated once, sized to the grid, and a pure `grid.js` function has
// no allocation site of its own to do that in (every other function here
// already gets its scratch, when it needs one, handed in by the caller —
// this is the same convention, not a new one). `NavSystem` (`index.js`)
// owns and preallocates both, in its constructor and every `rebuild()`
// (see that file's own comment for why a rebuild always resets them), and
// passes them into this function on every call — this function itself
// allocates nothing, ever.
//
// OVERLAPPING HAZARDS — the ticket's acceptance criterion 4. Two hazard
// sources (e.g. two `ash_wall` casts) covering the same cell, then one
// expires: that cell must STAY a hazard. A naive "set the bit on `on`,
// clear it on `off`" breaks this the moment a second source's `off` call
// clears a bit a still-live first source needs — exactly the "leaked
// hazard flag, invisible until M5" failure the project has already paid
// for twice, run in reverse (here the leak is a flag disappearing too
// early, not surviving too long). The fix is a REFCOUNT, not a re-
// derivation from scratch on every call (re-deriving `hazard` at markHazard
// time would need every live hazard source's own (x,z,radius) kept
// somewhere — a growing, unbounded list `skills`' own ground-effect pool
// already owns; duplicating it here is exactly the kind of second copy of
// one fact O-32/O-35 already flagged as a defect class). `refcount[i]`
// counts live sources touching cell `i`; the flag and the cost term only
// ever change on a genuine 0<->1 transition, so N overlapping sources
// converge on the same state N=1 would produce, no matter what order they
// register/deregister in.
//
// COST — cached, not incremented. `cost[i]` after N6 is
// `clamp(1 + nearWall*2 + water*6, 254)` (hazard is always 0 there — no
// raster pass writes it). A flat `cost[i] += 12` / `cost[i] -= 12` pair is
// unsound the moment N6's clamp already fired: a cell at the clamp ceiling
// (254) before a hazard lands would "gain" cost on removal (254-12=242,
// when the true pre-hazard value might have been, say, 250) — the same
// silent-corruption shape as the refcount bug above, in the cost field
// instead of the flag. `baseCost[i]` is `cost[i]` captured ONCE, right
// after N6 runs (by `NavSystem`, before any hazard has ever touched the
// grid) — `markHazard` always recomputes FROM that cached value
// (`baseCost[i] + RASTER.COST_HAZARD`, clamped), never by mutating
// `cost[i]` incrementally, so the round trip is exact regardless of how
// close to the clamp ceiling a cell already sat.
//
// A non-walkable cell still gets its hazard BIT toggled (the flag is a
// fact about the ground itself, independent of current walkability, and
// "cells within radius" — acceptance criterion 1 — does not say "walkable
// cells within radius"), but its `cost` is left at `RASTER.COST_BLOCKED`
// always, per `passN6Cost`'s own unconditional rule ("`cost = 255` if not
// walkable") — never adjusted by the hazard term, on activation or
// deactivation.
//
// CELL SELECTION — cell-CENTRE-in-circle, the same disc test N9's own
// `stampSpawnDenyDisc` already uses in `raster.js`, so "the cells within
// `radius` of `(x,z)`" means the same thing here it does everywhere else
// in this codebase: no separate geometry convention invented for this one
// function.
//
// UNMATCHED `off` — a cell whose `refcount` is already 0 when `on=false`
// is a silent no-op, not an underflow. This function has no way to tell a
// genuine double-clear (a caller bug) apart from, say, a `rebuild()` that
// already reset every count to 0 out from under a source that thinks it is
// still live (`skills`' `zone:teardown` handler and `nav.rebuild()` are two
// independent call paths with no ordering guarantee between them) — see
// `NavSystem.rebuild()`'s own comment. Silently ignoring it is safer than
// letting a `Uint16Array` wrap from 0 to 65535.
/**
 * @param {object} grid a `NavGrid`
 * @param {Uint16Array} refcount live-hazard-source count per cell —
 *   `NavSystem`-owned, sized to `grid.width*grid.height`
 * @param {Uint8Array} baseCost `grid.cost` as N6 left it (hazard term
 *   always 0) — `NavSystem`-owned, same sizing, refreshed every `rebuild()`
 * @param {number} x @param {number} z @param {number} radius
 * @param {boolean} on
 */
export function markHazard(grid, refcount, baseCost, x, z, radius, on) {
  const { flags, cost, width, height, cellSize, originX, originZ } = grid;
  if (!(radius > 0)) return; // NaN / 0 / negative radius touches nothing

  let cx0 = Math.floor((x - radius - originX) / cellSize);
  let cx1 = Math.floor((x + radius - originX) / cellSize);
  let cz0 = Math.floor((z - radius - originZ) / cellSize);
  let cz1 = Math.floor((z + radius - originZ) / cellSize);
  if (cx0 < 0) cx0 = 0;
  if (cx1 > width - 1) cx1 = width - 1;
  if (cz0 < 0) cz0 = 0;
  if (cz1 > height - 1) cz1 = height - 1;

  const r2 = radius * radius;
  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = originZ + (cz + 0.5) * cellSize;
    const dz = pz - z;
    const dz2 = dz * dz;
    const rowBase = cz * width;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = originX + (cx + 0.5) * cellSize;
      const dx = px - x;
      if (dx * dx + dz2 > r2) continue;

      const i = rowBase + cx;
      if (on) {
        if (refcount[i] === 0) {
          flags[i] |= NAV_FLAG.hazard;
          if (flags[i] & NAV_FLAG.walkable) {
            let c = baseCost[i] + RASTER.COST_HAZARD;
            if (c > RASTER.COST_MAX) c = RASTER.COST_MAX;
            cost[i] = c;
          }
        }
        refcount[i]++;
      } else if (refcount[i] > 0) {
        refcount[i]--;
        if (refcount[i] === 0) {
          flags[i] &= ~NAV_FLAG.hazard;
          if (flags[i] & NAV_FLAG.walkable) {
            cost[i] = baseCost[i];
          }
        }
      }
    }
  }
}
