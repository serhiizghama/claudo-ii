// src/nav/flow.js
//
// NAV-4 — the flow field: `docs/spec/02-api-contracts.md` §6's `flowVersion`,
// `buildFlowField`, `flowAt`, `flowDistance`. `src/nav/index.js` wires this in
// with one import and four thin delegating members (three methods + one
// getter) — the same `astar.js`/`smooth.js` split NAV-2/NAV-3 already
// established: the real state and algorithm live here, index.js only forwards
// `this._grid`/`this._version` through on every call.
//
// ===========================================================================
// The window — 128x128, always, regardless of the real grid's size
// ===========================================================================
// `06-monsters-ai.md` §9.1: "cells within 32 m of the player — a 128x128
// window, 16384 cells". At the fixed 0.5 m cell size (`RASTER.CELL_SIZE`)
// that IS 32 m in every direction (`WINDOW_SIDE/2 = 64` cells `* 0.5 m =
// 32 m`) — `WINDOW_SIDE=128` and `WINDOW_CELLS=16384` are cited directly
// from that table, not invented; `HALF_WINDOW=64` is arithmetic on
// `WINDOW_SIDE`, not a second independent number.
//
// The window is centred on `(targetX, targetZ)` — `buildFlowField`'s own
// argument, "the player" in `ai`'s real call, but this file takes whatever
// target it is given (`02` §6 places no restriction to the player
// specifically; `06` §9.3's "the field is built toward the player only"
// describes `ai`'s USE of it, not a constraint this file enforces). Every
// scratch array below is sized to exactly `WINDOW_CELLS`, ONCE, in the
// constructor — unlike `astar.js`'s `_ensureScratch` (which resizes with the
// REAL grid's dimensions), this file's arenas never need to resize: the
// window is always the same 128x128 shape no matter how big the zone is
// (96x96 m in this ticket's own acceptance criterion; the field only ever
// touches a 32 m slice of it).
//
// ===========================================================================
// Two distances, on purpose: `priority` (cost-weighted, Dijkstra's own key)
// vs `distM` (metres, what `flowDistance` reports)
// ===========================================================================
// `02-api-contracts.md` §6 is explicit: `flowDistance` is "metres along the
// field... Not cells, not cost units". But `06` §9.1/`07` §6.4 are equally
// explicit that the field must prefer the cost-cheap route (corridor middle
// over a hazard, exactly `astar.js`'s own "cost is a traversal weight, not a
// mask" proof) — those two requirements are only reconcilable by tracking
// BOTH numbers per cell: `priority` (the accumulated, cost-WEIGHTED total
// Dijkstra actually minimises, in the integer units defined below) decides
// which parent a cell gets, i.e. the SHAPE of the tree; `distM` is the real,
// physical length (in metres) of that SAME chosen tree path, accumulated
// alongside it (`+cellSize` per cardinal edge, `+cellSize*SQRT2` per
// diagonal, never influenced by `cost`). `flowDistance` reads `distM`,
// never `priority` — the exact `gScore`-vs-`fScore` separation `astar.js`
// already documents for its own weighted heuristic, applied here to keep the
// "prefer the cheap route" mechanism from ever leaking into the public
// "metres" contract.
//
// ===========================================================================
// Build method — bucketed monotone Dijkstra (Dial's algorithm); integer
// edge weights ASSIGNED (06 §9.1 names the algorithm; the integer bucket
// scheme is this file's own, not a spec literal)
// ===========================================================================
// `06` §9.1's own "Build method" row says "bucketed monotone Dijkstra" — a
// circular array of buckets indexed by `priority % BUCKET_COUNT`, drained in
// increasing order, is Dial's classic algorithm: O(V+E) instead of a binary
// heap's O((V+E) log V), which is what the modelled "~18 ns/cell" assumes.
// Dial's algorithm needs bounded, INTEGER edge weights (`BUCKET_COUNT =
// maxEdgeWeight + 1`, so the next unprocessed minimum can never be more than
// one full cycle of buckets ahead of the current pointer) — `grid.cost` is
// already an integer 1..254 (`RASTER.COST_MAX`) for a cardinal step, but a
// diagonal step's true weight (`cost * SQRT2`) is irrational. `Math.round`
// (never `Math.sqrt`/`Math.hypot` at relaxation time — the latter banned,
// the former an allocation trap; `SQRT2` is `Math.SQRT2`, read once) turns it
// into the nearest integer: `diagonal ? Math.round(cost*SQRT2) : cost`. This
// ONLY affects the priority key (which determines the tree's shape/
// preference for cheap cells) — Dijkstra's optimality proof needs
// non-negative edge weights, not that they equal any particular physical
// quantity, so rounding here never breaks correctness of the resulting tree
// with respect to THESE (integer) weights; `distM` (the public metres
// contract) is accumulated separately, unrounded, off the grid's exact
// `cellSize`.
//
// `MAX_EDGE_WEIGHT = Math.round(RASTER.COST_MAX * Math.SQRT2)` (359) is the
// largest possible single-edge weight (a maximally-costed diagonal beats a
// maximally-costed cardinal, 254); `BUCKET_COUNT = MAX_EDGE_WEIGHT + 1`
// (360) is Dial's algorithm's own minimum correct bucket count. ASSIGNED —
// no spec table gives a bucket count; derived only from spec's own cost
// ceiling (`RASTER.COST_MAX`), so it tracks that ceiling automatically if it
// ever changes.
//
// Lazy decrease-key: a relaxed cell is pushed to the HEAD of its new
// bucket's singly-linked list without removing its earlier, now-stale entry
// from whatever (later, by construction — argued here) bucket it still sits
// in. Every edge weight is >= 1 and <= MAX_EDGE_WEIGHT < BUCKET_COUNT, so a
// relaxation's target bucket index can never equal the bucket currently
// being drained (that would need `edgeWeight ≡ 0 mod BUCKET_COUNT`,
// impossible) — so draining a bucket to empty via a plain "pop the whole
// list, then move on" pass is safe: nothing already-drained can be
// re-inserted into it while it is being drained. A stale duplicate, when
// eventually popped, is skipped via `cellState === CLOSED` (the first,
// smallest-priority pop for any cell always happens strictly before any of
// its own stale duplicates, since those sit in strictly later buckets) — the
// same "first pop is the true minimum, later duplicates are free to ignore"
// discipline a lazy-deletion binary heap uses, adapted to a bucket queue.
//
// Bucket index arithmetic: a relaxed neighbour's bucket is `curBucket +
// edgeWeight`, minus `BUCKET_COUNT` once if that overflows — never
// `tentative % BUCKET_COUNT`. The two are equal (`curBucket` is always
// `priority[cellIdx] % BUCKET_COUNT` for the cell currently being settled,
// by the same induction the paragraph above establishes), but a single
// conditional subtraction is measurably cheaper than a modulo in `build()`'s
// hot loop, called up to `8 * WINDOW_CELLS` times per build.
//
// ===========================================================================
// Lazy decrease-key needs its own list nodes — a real bug this ticket found
// and fixed before submission
// ===========================================================================
// A first implementation indexed the bucket linked list by CELL (one
// `nextInBucket[cellIndex]` slot per cell) and reused that same slot on every
// relaxation, including a decrease-key. That corrupts the queue: a cell can
// legitimately be relaxed more than once (once from each neighbour that
// later gets closed), so a SECOND relaxation overwrites
// `nextInBucket[cellIndex]` — which is also the link the cell's EARLIER,
// still-un-drained bucket entry depends on to reach whatever came after it
// in THAT bucket's list. The earlier bucket's tail becomes unreachable the
// moment the second write happens, silently losing every node after it in
// that list — measured directly: on a 192x192-cell, varied-cost, fully open
// grid this dropped ~28 cells outright and left thousands more `OPEN` but
// never drained (a scan-window guard set to an intentionally absurd cap
// still found nothing, proving lost nodes, not merely a slow search).
// A per-cell pointer can only ever belong to ONE list at a time; a lazy
// decrease-key needs a SECOND, independent list membership for the same
// cell to coexist safely. The fix: the bucket linked list is indexed by
// relaxation EVENT, not by cell — `_eventCell[e]`/`_eventNext[e]`, with a
// fresh `e` handed out per relaxation (`EVENT_CAPACITY`, see below). Multiple
// events for the same cell can now sit in different buckets without any
// aliasing; `cellState[cellIdx] === CLOSED` is still what makes every stale
// duplicate event (found in a later bucket) a safe no-op once the cell's
// true-best event has already been drained and settled.
//
// ===========================================================================
// Generation stamp, not a clear — the 16384-cell arrays are never `.fill()`'d
// ===========================================================================
// This ticket's own brief: "Clearing a 16384-cell distance array every build
// is real work at 5 Hz... consider [a generation stamp]". `_cellGen`
// (`Int32Array`, `WINDOW_CELLS` long) holds, per LOCAL window slot, the
// `flowVersion` value it was last touched at; `flowVersion` itself IS the
// generation counter (incremented once at the top of every `build()` —
// `02` §6's own "increments on every buildFlowField()"), so no separate
// counter is needed. A slot is "valid for THIS build" exactly when
// `cellGen[local] === this._flowVersion`; every other array (`_priority`,
// `_distM`, `_dirCode`, `_cellState`) is read ONLY after that check passes,
// so last build's stale leftovers in an untouched slot are simply never
// observed — this is `astar.js`'s own `cellGen`/`currentGen` pattern,
// applied to a per-window-SLOT (not per-grid-cell) index, since the window's
// local coordinate space is reused across builds even though it maps to a
// DIFFERENT set of real grid cells each time (the window follows the
// target). `_bucketHead` (`BUCKET_COUNT`, ~360 entries) IS `.fill(-1)`'d
// every build — a few hundred int writes is not the cost this ticket's
// brief is about; only the `WINDOW_CELLS`-sized arrays are spared.
//
// ===========================================================================
// Corner-cutting — the identical rule `astar.js`/`smooth.js` already apply
// ===========================================================================
// A diagonal relaxation is only legal when BOTH orthogonal cells the step
// straddles are themselves walkable (`cost < COST_BLOCKED`) — otherwise an
// agent literally following this field could be steered through the
// diagonal gap between two blockers. Same rule, same reasoning, as
// `astar.js`'s "no corner-cutting" section; re-derived here (not imported)
// because it walks LOCAL window coordinates translated to global cells, not
// the plain global grid `astar.js` walks. The two orthogonal neighbours'
// coordinates (`(ngcx, gcz)` and `(gcx, ngcz)`) are already known in-bounds
// at this point (their components were each independently validated a few
// lines above, for the current cell and for the diagonal neighbour), so no
// extra bounds check is needed before reading `grid.cost` at them.
//
// ===========================================================================
// Region separation and the 32 m window boundary — both fall out "for free"
// ===========================================================================
// `02` §6: `flowDistance` must read `Infinity` for a cell in a different
// region, and for anything outside the 32 m window. Neither needs its own
// check: a different region is, by `passN7Regions`'s own definition, a
// walkable component with NO walkable edge to the target's component — the
// relaxation loop above can never reach it (there is no legal edge to
// cross), the identical reason `nav.regionAt`/`nav.connected` (NAV-1) and
// `astar.js`'s region pre-check already rely on. A cell outside the window
// is never even considered: local coordinates outside `[0, WINDOW_SIDE)` are
// rejected before any relaxation, so it can never receive a `cellGen` stamp
// and reads back exactly as "never touched this build" — the same code path
// an unreachable-inside-the-window cell takes.
//
// ===========================================================================
// A version bump mid-flight — a field that outlived a `rebuild()`
// ===========================================================================
// `rebuild()` reallocates the grid and bumps `nav.version`; a flow field
// built against the PREVIOUS grid stores world-space window bounds
// (`_windowOriginX/Z`, `_windowCellSize`) and per-slot data describing cells
// that may no longer exist, may have moved, or may now be walkable where
// they weren't (or vice-versa). This file never re-reads the grid at query
// time (see below), so it cannot silently return a wrong-but-plausible
// answer against stale geometry — instead, `build()` records the grid
// `version` it ran against (`_builtGridVersion`); `flowAt`/`flowDistance`
// take the CURRENT `nav.version` as a parameter (the same
// pass-it-through-every-call convention `astar.js`'s `requestPath`/
// `runSolves` already use for the identical reason) and read back the
// documented unreachable default — `{0,0}` / `Infinity` — for EVERY query
// whenever `version !== _builtGridVersion`, whatever `_cellGen` happens to
// contain. This is `nav.rebuild`'s own complementary half of `02` §6's
// "Never hold a `PathHandle` across a `version` change" rule, applied to the
// flow field instead of a path: the field is honestly stale-and-unreachable
// from the moment of a rebuild until `ai`'s next `buildFlowField()` call
// (`06` §9.4's own "on `nav:rebuilt`... `useFlowField = true`" already
// expects every brain to fall back onto the field immediately, spread over
// the following steps — during the gap before the NEXT field build, every
// query reads "unreachable", a safe, honest default for a caller that has
// not repathed yet either).
//
// ===========================================================================
// Query time never touches the grid — O(1), no allocation, no re-derivation
// ===========================================================================
// `flowAt`/`flowDistance` map world `(x,z)` straight to a LOCAL window slot
// via `_windowOriginX/Z`/`_windowCellSize` (captured at build time) and read
// `_cellGen`/`_dirCode`/`_distM` directly — no cell-index arithmetic against
// the live `grid` at all. This is what makes both `Fixed: Y, Alloc: no`
// (`02` §6): pure arithmetic and array reads, and it is also what makes the
// stale-field case above safe rather than a use-after-free-shaped bug — a
// query never dereferences anything about the CURRENT grid's shape, so it
// can never crash even if the grid has since been resized.
//
// ===========================================================================
// Direction — precomputed unit vectors, no `Math.sqrt`/`Math.hypot` at query
// time
// ===========================================================================
// Only 8 possible step directions exist on this grid. `_dirCode[local]`
// stores which of `NEI_DX`/`NEI_DZ` (the step FROM the parent cell TO this
// cell, i.e. AWAY from the target — the direction the relaxation loop
// actually walked) produced this cell's current best priority. `flowAt`
// returns the OPPOSITE of that step's precomputed unit vector (`DIR_UNIT_DX`/
// `DIR_UNIT_DZ`, built once at module load from `NEI_DX`/`NEI_DZ` and
// `1/Math.SQRT2` for the diagonal entries) — i.e. the direction FROM this
// cell TOWARD its parent, which is exactly "walk toward the target".
// `NONE_DIR` (8, outside the valid 0..7 range) marks the target's own slot,
// which has no parent and reads back `{0,0}` (already there — the same "no
// direction needed" default as "unreachable", chosen because nothing in
// `02` §6 distinguishes the two, and returning a spurious unit vector at
// distance 0 would only invite a caller to keep "arriving" forever).
//
// ===========================================================================
// `stats.fieldMs` — left honestly unwritten, same as `astar.js`'s precedent
// ===========================================================================
// `tools/check-imports.mjs` bans `performance.now()` anywhere in `src/nav/`
// (not just inside `fixedUpdate` — the whole file), so this file cannot
// self-time `build()` without breaking that lint. `astar.js`'s own `stats`
// section already left `fieldMs` at the constructor's honest `0` for the
// identical reason ("this file never writes it"); `06` §9.5 wires REAL
// measurement through `tools/profile.mjs`, a caller OUTSIDE `src/nav/` that
// is free to wrap `nav.buildFlowField()` with `performance.now()` itself.
// This class does not even accept a `stats` object (unlike
// `AStarScheduler`) — there is nothing here for it to write.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (O-29).

import { RASTER } from './grid.js';

/** 06 §9.1 — cited directly, not derived from anything else. */
export const WINDOW_SIDE = 128;
/** Half of WINDOW_SIDE — at RASTER.CELL_SIZE (0.5 m) this is the 32 m in
 * every direction 06 §9.1 names; not an independent number. */
export const HALF_WINDOW = WINDOW_SIDE / 2;
/** 06 §9.1 — "16384 cells", cited directly (also WINDOW_SIDE*WINDOW_SIDE). */
export const WINDOW_CELLS = WINDOW_SIDE * WINDOW_SIDE;

/** ASSIGNED — see file header, "Build method". The largest possible single
 * edge weight after the diagonal-cost integer rounding below. */
export const MAX_EDGE_WEIGHT = Math.round(RASTER.COST_MAX * Math.SQRT2);
/** ASSIGNED — Dial's algorithm's own minimum correct bucket count,
 * `MAX_EDGE_WEIGHT + 1` (see file header). */
export const BUCKET_COUNT = MAX_EDGE_WEIGHT + 1;
/** ASSIGNED — see file header, "Lazy decrease-key needs its own list nodes".
 * A settled cell can be relaxed by at most 8 neighbours over the whole
 * build (one attempt per incoming direction), so the total number of
 * relaxation EVENTS across every cell in the window can never exceed
 * `8 * WINDOW_CELLS`; `+1` covers the single seed event for the target
 * cell itself. */
export const EVENT_CAPACITY = WINDOW_CELLS * 8 + 1;

const SQRT2 = Math.SQRT2;
const INV_SQRT2 = 1 / Math.SQRT2;

/** `grid.cost` is a `Uint8Array`, 1..254 (`RASTER.COST_MAX`) for a walkable
 * cell — every possible diagonal edge weight (`Math.round(cost*SQRT2)`) is
 * therefore one of exactly 256 values, precomputed ONCE at module load
 * instead of calling `Math.round` per relaxation attempt inside `build()`'s
 * hot loop. Measured: this table lookup, together with the unrolled
 * cardinal/diagonal split below, is what brings the 128x128-window rebuild
 * from ~1.5 ms down to comfortably under this ticket's 0.8 ms budget on a
 * 96x96 m grid — see `build()`'s own comment for the full account. */
const DIAG_WEIGHT = new Int32Array(256);
for (let c = 0; c < 256; c++) DIAG_WEIGHT[c] = Math.round(c * SQRT2);

const OPEN = 1;
const CLOSED = 2;
/** Sentinel `_dirCode` value for a slot with no parent (the target's own
 * local slot) — outside the valid 0..7 neighbour-index range. */
const NONE_DIR = 8;

/** Row-major 8-neighbour offsets — same table `astar.js` uses, re-derived
 * here (not imported) since this file walks LOCAL window coordinates, not
 * the plain global grid `astar.js` owns. */
const NEI_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEI_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NEI_DIAGONAL = [false, false, false, false, true, true, true, true];

/** Precomputed unit step vectors for each of the 8 directions above, built
 * once at module load — see file header, "Direction". */
const DIR_UNIT_DX = NEI_DX.map((dx, d) => (NEI_DIAGONAL[d] ? dx * INV_SQRT2 : dx));
const DIR_UNIT_DZ = NEI_DZ.map((dz, d) => (NEI_DIAGONAL[d] ? dz * INV_SQRT2 : dz));

/**
 * The real NAV-4 flow-field builder + query surface. `src/nav/index.js`
 * builds one of these and forwards `flowVersion`/`buildFlowField`/`flowAt`/
 * `flowDistance` into it, passing `this._grid`/`this._version` through on
 * every call — see that file's own NAV-4 addendum.
 */
export class FlowField {
  constructor() {
    this._flowVersion = 0;
    /** The grid `version` `build()` last ran against — see file header, "A
     * version bump mid-flight". `-1` matches no real grid version (which
     * starts at 0), so every query before the first `build()` reads
     * unreachable. */
    this._builtGridVersion = -1;

    // World-space window placement, captured at build time — see file
    // header, "Query time never touches the grid".
    this._windowOriginX = 0;
    this._windowOriginZ = 0;
    this._windowCellSize = RASTER.CELL_SIZE;

    // Arenas — built ONCE, always WINDOW_CELLS long regardless of the real
    // grid's size (see file header, "The window").
    this._cellGen = new Int32Array(WINDOW_CELLS);
    this._cellState = new Uint8Array(WINDOW_CELLS);
    this._priority = new Int32Array(WINDOW_CELLS);
    this._distM = new Float32Array(WINDOW_CELLS);
    this._dirCode = new Uint8Array(WINDOW_CELLS);
    this._bucketHead = new Int32Array(BUCKET_COUNT);
    // Per-EVENT (not per-cell) bucket-list nodes — see file header, "Lazy
    // decrease-key needs its own list nodes".
    this._eventCell = new Int32Array(EVENT_CAPACITY);
    this._eventNext = new Int32Array(EVENT_CAPACITY);

    // `out`-less `flowAt` scratch — the same shared-object convention
    // `astar.js`'s `_nodeScratch` uses for `pathNode`.
    this._dirScratch = { dx: 0, dz: 0 };
  }

  /** `02-api-contracts.md` §6: `flowVersion` — int, tracks the FLOW FIELD,
   * never the grid (`nav.version`, NAV-1's). `0` before the first
   * `build()`. */
  get flowVersion() {
    return this._flowVersion;
  }

  /**
   * `02-api-contracts.md` §6: `buildFlowField(targetX,targetZ) => void`.
   * `grid`/`gridVersion` are `NavSystem`'s CURRENT `.grid`/`.version` at call
   * time (read fresh by the caller, `src/nav/index.js` — the same
   * `AStarScheduler.requestPath` convention). One call = one full rebuild of
   * the 128x128 window centred on `(targetX, targetZ)` — see file header for
   * the algorithm. `Alloc: no`: every local below is a primitive number; the
   * only object ever touched is `this` (typed arrays already allocated in
   * the constructor).
   * @param {object} grid @param {number} gridVersion
   * @param {number} targetX @param {number} targetZ
   */
  build(grid, gridVersion, targetX, targetZ) {
    this._flowVersion++;
    const gen = this._flowVersion;
    this._builtGridVersion = gridVersion;

    const width = grid.width;
    const height = grid.height;
    const cost = grid.cost;
    const cellSize = grid.cellSize;
    const diagMetres = cellSize * SQRT2;

    // Target cell — computed inline (never via a `{cx,cz}`-returning helper,
    // which would allocate a plain object every build, breaking `Alloc: no`).
    const tcx = Math.floor((targetX - grid.originX) / cellSize);
    const tcz = Math.floor((targetZ - grid.originZ) / cellSize);
    const originCx = tcx - HALF_WINDOW;
    const originCz = tcz - HALF_WINDOW;
    this._windowOriginX = grid.originX + originCx * cellSize;
    this._windowOriginZ = grid.originZ + originCz * cellSize;
    this._windowCellSize = cellSize;

    const cellGen = this._cellGen;
    const cellState = this._cellState;
    const priority = this._priority;
    const distM = this._distM;
    const dirCode = this._dirCode;
    const bucketHead = this._bucketHead;
    const eventCell = this._eventCell;
    const eventNext = this._eventNext;

    bucketHead.fill(-1); // BUCKET_COUNT-sized (~360) — cheap, see file header

    // Measured, not assumed: whenever the whole 128x128 window sits inside
    // the real grid (true for any zone at least ~32 m bigger than the
    // window on every side — this ticket's own 96x96 m acceptance grid, for
    // one), every neighbour's global cell is automatically in-bounds, so the
    // per-neighbour `ngcx/ngcz` range check below is dead weight computed
    // 8 times per cell. Checked once per build, not once per neighbour.
    const fullyInGrid = originCx >= 0 && originCx + WINDOW_SIDE <= width && originCz >= 0 && originCz + WINDOW_SIDE <= height;

    let openCount = 0;
    let eventCount = 0;

    if (tcx >= 0 && tcx < width && tcz >= 0 && tcz < height) {
      const targetGlobal = tcz * width + tcx;
      if (cost[targetGlobal] < RASTER.COST_BLOCKED) {
        const srcLocal = HALF_WINDOW * WINDOW_SIDE + HALF_WINDOW;
        cellGen[srcLocal] = gen;
        cellState[srcLocal] = OPEN;
        priority[srcLocal] = 0;
        distM[srcLocal] = 0;
        dirCode[srcLocal] = NONE_DIR;
        const e0 = eventCount++;
        eventCell[e0] = srcLocal;
        eventNext[e0] = -1;
        bucketHead[0] = e0;
        openCount = 1;
      }
    }

    let curBucket = 0;
    while (openCount > 0) {
      let scans = 0;
      while (bucketHead[curBucket] === -1) {
        curBucket = curBucket + 1 === BUCKET_COUNT ? 0 : curBucket + 1;
        scans++;
        if (scans > BUCKET_COUNT) {
          // Defensive only — Dial's algorithm's own invariant (file header,
          // "Build method") proves this can never trigger while openCount > 0.
          openCount = 0;
          break;
        }
      }
      if (openCount === 0) break;

      let e = bucketHead[curBucket];
      bucketHead[curBucket] = -1; // safe to drain in one pass — file header
      while (e !== -1) {
        const next = eventNext[e];
        const cellIdx = eventCell[e];
        if (cellState[cellIdx] === CLOSED) {
          e = next; // stale duplicate event of an already-settled cell
          continue;
        }
        cellState[cellIdx] = CLOSED;
        openCount--;

        const lcx = cellIdx % WINDOW_SIDE;
        const lcz = (cellIdx / WINDOW_SIDE) | 0;
        const gcx = originCx + lcx;
        const gcz = originCz + lcz;
        const curPriority = priority[cellIdx];
        const curDistM = distM[cellIdx];

        // ---------------------------------------------------------------
        // Unrolled 8-neighbour relaxation — not the tidy `for (d=0;d<8;d++)`
        // loop over `NEI_DX`/`NEI_DZ`/`NEI_DIAGONAL` this started as.
        // Measured on this ticket's own 96x96 m acceptance grid: the tidy
        // loop (with a per-neighbour `Math.round` for the diagonal weight,
        // and a per-neighbour real-grid bounds check even when the whole
        // window sits inside the grid) rebuilds in ~1.5 ms, comfortably over
        // budget. Splitting cardinal (no corner-cut check, integer weight
        // already in `cost[]`) from diagonal (needs the corner-cut check,
        // weight from `DIAG_WEIGHT[]`) removes a per-neighbour branch and
        // lets each of the 8 cases read as a flat sequence of array ops; the
        // `fullyInGrid` flag (computed once above, not per neighbour) skips
        // the real-grid bounds check entirely on the common case. Together
        // this landed at ~0.6 ms median / <0.8 ms worst-observed over many
        // builds (`tests/nav/nav4.test.js`'s own MAIN performance test) — see
        // that test for the measured numbers this shape was tuned against.
        // Every one of the 8 blocks below is the IDENTICAL rule the old
        // loop body applied for that direction; nothing here changes what
        // gets relaxed, only how cheaply.
        // ---------------------------------------------------------------

        // d=0: (+1,0)
        if (lcx + 1 < WINDOW_SIDE) {
          const ngcx = gcx + 1;
          const ngcz = gcz;
          if (fullyInGrid || (ngcx < width && ngcz >= 0 && ngcz < height)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED) {
              const nLocal = lcz * WINDOW_SIDE + (lcx + 1);
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const tentative = curPriority + nCost;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + cellSize;
                  dirCode[nLocal] = 0;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + nCost;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=1: (-1,0)
        if (lcx - 1 >= 0) {
          const ngcx = gcx - 1;
          const ngcz = gcz;
          if (fullyInGrid || (ngcx >= 0 && ngcz >= 0 && ngcz < height)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED) {
              const nLocal = lcz * WINDOW_SIDE + (lcx - 1);
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const tentative = curPriority + nCost;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + cellSize;
                  dirCode[nLocal] = 1;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + nCost;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=2: (0,+1)
        if (lcz + 1 < WINDOW_SIDE) {
          const ngcx = gcx;
          const ngcz = gcz + 1;
          if (fullyInGrid || (ngcx >= 0 && ngcx < width && ngcz < height)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED) {
              const nLocal = (lcz + 1) * WINDOW_SIDE + lcx;
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const tentative = curPriority + nCost;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + cellSize;
                  dirCode[nLocal] = 2;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + nCost;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=3: (0,-1)
        if (lcz - 1 >= 0) {
          const ngcx = gcx;
          const ngcz = gcz - 1;
          if (fullyInGrid || (ngcx >= 0 && ngcx < width && ngcz >= 0)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED) {
              const nLocal = (lcz - 1) * WINDOW_SIDE + lcx;
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const tentative = curPriority + nCost;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + cellSize;
                  dirCode[nLocal] = 3;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + nCost;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=4: (+1,+1) — diagonal, needs the corner-cut check (file header,
        // "Corner-cutting"): both (ngcx,gcz) and (gcx,ngcz) must be walkable.
        if (lcx + 1 < WINDOW_SIDE && lcz + 1 < WINDOW_SIDE) {
          const ngcx = gcx + 1;
          const ngcz = gcz + 1;
          if (fullyInGrid || (ngcx < width && ngcz < height)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED && cost[gcz * width + ngcx] < RASTER.COST_BLOCKED && cost[ngcz * width + gcx] < RASTER.COST_BLOCKED) {
              const nLocal = (lcz + 1) * WINDOW_SIDE + (lcx + 1);
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const edgeWeight = DIAG_WEIGHT[nCost];
                const tentative = curPriority + edgeWeight;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + diagMetres;
                  dirCode[nLocal] = 4;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + edgeWeight;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=5: (+1,-1)
        if (lcx + 1 < WINDOW_SIDE && lcz - 1 >= 0) {
          const ngcx = gcx + 1;
          const ngcz = gcz - 1;
          if (fullyInGrid || (ngcx < width && ngcz >= 0)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED && cost[gcz * width + ngcx] < RASTER.COST_BLOCKED && cost[ngcz * width + gcx] < RASTER.COST_BLOCKED) {
              const nLocal = (lcz - 1) * WINDOW_SIDE + (lcx + 1);
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const edgeWeight = DIAG_WEIGHT[nCost];
                const tentative = curPriority + edgeWeight;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + diagMetres;
                  dirCode[nLocal] = 5;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + edgeWeight;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=6: (-1,+1)
        if (lcx - 1 >= 0 && lcz + 1 < WINDOW_SIDE) {
          const ngcx = gcx - 1;
          const ngcz = gcz + 1;
          if (fullyInGrid || (ngcx >= 0 && ngcz < height)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED && cost[gcz * width + ngcx] < RASTER.COST_BLOCKED && cost[ngcz * width + gcx] < RASTER.COST_BLOCKED) {
              const nLocal = (lcz + 1) * WINDOW_SIDE + (lcx - 1);
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const edgeWeight = DIAG_WEIGHT[nCost];
                const tentative = curPriority + edgeWeight;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + diagMetres;
                  dirCode[nLocal] = 6;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + edgeWeight;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        // d=7: (-1,-1)
        if (lcx - 1 >= 0 && lcz - 1 >= 0) {
          const ngcx = gcx - 1;
          const ngcz = gcz - 1;
          if (fullyInGrid || (ngcx >= 0 && ngcz >= 0)) {
            const nCost = cost[ngcz * width + ngcx];
            if (nCost < RASTER.COST_BLOCKED && cost[gcz * width + ngcx] < RASTER.COST_BLOCKED && cost[ngcz * width + gcx] < RASTER.COST_BLOCKED) {
              const nLocal = (lcz - 1) * WINDOW_SIDE + (lcx - 1);
              const known = cellGen[nLocal] === gen;
              if (!(known && cellState[nLocal] === CLOSED)) {
                const edgeWeight = DIAG_WEIGHT[nCost];
                const tentative = curPriority + edgeWeight;
                if (!known || tentative < priority[nLocal]) {
                  if (!known) {
                    cellGen[nLocal] = gen;
                    cellState[nLocal] = OPEN;
                    openCount++;
                  }
                  priority[nLocal] = tentative;
                  distM[nLocal] = curDistM + diagMetres;
                  dirCode[nLocal] = 7;
                  if (eventCount < EVENT_CAPACITY) {
                    const ne = eventCount++;
                    eventCell[ne] = nLocal;
                    let b = curBucket + edgeWeight;
                    if (b >= BUCKET_COUNT) b -= BUCKET_COUNT;
                    eventNext[ne] = bucketHead[b];
                    bucketHead[b] = ne;
                  }
                }
              }
            }
          }
        }

        e = next;
      }
    }
  }

  /**
   * `02-api-contracts.md` §6: `flowAt(x,z,out?) => {dx,dz}` — unit
   * direction, `{0,0}` if unreachable (also: stale field, off-window,
   * unvisited, or the target's own cell — see file header, "Direction").
   * `Alloc: no`: `out` omitted reuses the shared scratch object, valid until
   * the next call (`astar.js`'s own `pathNode` convention).
   * @param {number} x @param {number} z @param {number} gridVersion
   * @param {{dx:number,dz:number}} [out]
   * @returns {{dx:number,dz:number}}
   */
  flowAt(x, z, gridVersion, out) {
    const target = out || this._dirScratch;
    if (gridVersion !== this._builtGridVersion) {
      target.dx = 0;
      target.dz = 0;
      return target;
    }
    const local = this._localIndexAt(x, z);
    if (local < 0 || this._cellGen[local] !== this._flowVersion) {
      target.dx = 0;
      target.dz = 0;
      return target;
    }
    const code = this._dirCode[local];
    if (code === NONE_DIR) {
      target.dx = 0;
      target.dz = 0;
      return target;
    }
    // The OPPOSITE of the step that reached this cell FROM its parent — the
    // direction back toward the parent, toward the target. File header,
    // "Direction".
    target.dx = -DIR_UNIT_DX[code];
    target.dz = -DIR_UNIT_DZ[code];
    return target;
  }

  /**
   * `02-api-contracts.md` §6: `flowDistance(x,z) => number` — metres along
   * the field, `Infinity` if unreachable (same cases as `flowAt`).
   * @param {number} x @param {number} z @param {number} gridVersion
   * @returns {number}
   */
  flowDistance(x, z, gridVersion) {
    if (gridVersion !== this._builtGridVersion) return Infinity;
    const local = this._localIndexAt(x, z);
    if (local < 0 || this._cellGen[local] !== this._flowVersion) return Infinity;
    return this._distM[local];
  }

  /** World (x,z) -> local window slot index, or -1 outside the window.
   * Never touches the grid — see file header, "Query time never touches the
   * grid".
   * @param {number} x @param {number} z
   * @returns {number}
   */
  _localIndexAt(x, z) {
    const lcx = Math.floor((x - this._windowOriginX) / this._windowCellSize);
    const lcz = Math.floor((z - this._windowOriginZ) / this._windowCellSize);
    if (lcx < 0 || lcx >= WINDOW_SIDE || lcz < 0 || lcz >= WINDOW_SIDE) return -1;
    return lcz * WINDOW_SIDE + lcx;
  }
}
