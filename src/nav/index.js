// src/nav/index.js
//
// NAV-1 — `NavSystem`: the grid/version half of `docs/spec/02-api-contracts.md`
// §6 (`grid`, `version`, `rebuild`, `walkable`, `flagsAt`, `regionAt`,
// `connected`, `stats`) and N11 (`07-world-gen.md` §6.2/§6.7 — version
// bump, `zone.navVersion` mirror, `nav:rebuilt` emission). A* (NAV-2),
// smoothing (NAV-3), flow fields (NAV-4) and `snap` (NAV-5) are later
// tickets' additions to this same file — left out entirely, not stubbed
// (see this ticket's report for the exact list).
//
// NAV-2 addendum: `requestPath`/`pollPath`/`cancelPath`/`releasePath`/
// `pathNode`/`pathLength`/`setBudget` and `fixedUpdate` are added below.
// Same "index.js: wiring only" precedent `src/physics/index.js`'s PHYS-2/4/5
// addenda establish — every one of these is a thin forward into
// `AStarScheduler` (`./astar.js`, NAV-2's real file); the solver, the
// request pool/ring and the budget bookkeeping all live there, not here.
// `fixedUpdate` itself is two lines (`beginStep()` then `runSolves()`) for
// the same reason. See `astar.js`'s own header for the algorithm, the id
// bijection (mirroring `src/actors/pool.js`'s `Actor.id` scheme), the
// per-step accept throttle, and every documented ambiguity this ticket
// resolved (a version bump mid-flight, holding a `PathHandle`, what each
// `stats` field counts).
//
// NAV-4 addendum: `flowVersion` (a getter, alongside `version`) and
// `buildFlowField`/`flowAt`/`flowDistance` are added below — same shape
// again, every one a thin forward into `FlowField` (`./flow.js`, NAV-4's
// real file), passing `this._grid`/`this._version` through on every call
// exactly like NAV-2's `requestPath`/`runSolves` already do. See `flow.js`'s
// own header for the algorithm (bucketed monotone Dijkstra), the window
// definition, the cost-weighted-priority-vs-metres-distance split, the
// generation-stamp reuse and the stale-after-`rebuild()` handling.
//
// NAV-5 addendum: `snap` is added below — again a thin forward, this time
// into `snapPoint` (`./snap.js`, NAV-5's real file), passing `this._grid`
// through and either the caller's own `out` or this file's own
// `this._snapScratch` (built once in the constructor, the same shared-
// scratch convention `astar.js`'s `_nodeScratch` / `flow.js`'s
// `_dirScratch` already use for their own single-`Vec3`-per-call methods).
// See `snap.js`'s own header for the algorithm (clamp-into-cell nearest
// point, never a cell centre — that is what makes I3 hold), the tie-break
// rule, the `maxRadius===0` fast path, and why region is deliberately not
// filtered here.
//
// NAV-7 (D-74) addendum: `raycastNav` is added below — a direct forward
// into `./smooth.js`'s already-exported `segmentWalkable`, not a new
// algorithm. `smooth.js`'s own NAV-3 header built that function private-but-
// exported for exactly this — see its "Segment-walkability test — option
// (a)" section — so this ticket is the "later ticket" it names, importing
// rather than re-deriving the same line-of-walk rule (the O-32/O-35 defect
// class). `player/move.js`'s and `ai/perception.js`'s existing `typeof
// nav.raycastNav === 'function'` guards light up with no edit on their side.
//
// ---------------------------------------------------------------------------
// Imports — `raster.js` reached only through `./grid.js`
// ---------------------------------------------------------------------------
// `src/nav/grid.js`'s header explains the one sanctioned cross-subsystem
// import (`src/world/raster.js`, a pure library, not a subsystem) and why it
// lives in exactly one file. This file never imports `../world/raster.js`
// directly — everything it needs (`NAV_FLAG`, `createNavGrid`,
// `createRasterScratch`, `rasterizeNav`, and the four grid accessors) comes
// through `./grid.js`. `world` the SUBSYSTEM is reached only at runtime, via
// `ctx.get('world')` (a hard dependency: `static deps = ['world']`), never
// imported — ARCHITECTURE.md rule 2.
//
// ---------------------------------------------------------------------------
// N11 — `navVersionCounter` is process-global, not per-instance
// ---------------------------------------------------------------------------
// `07-world-gen.md` §6.2 N11 / §6.7, verbatim: "`navVersionCounter` is a
// process-global monotonic integer, not per-zone" — a town -> wastes -> town
// cycle produces versions 1, 2, 3 and never repeats one, which is what makes
// `brain.pathVersion !== nav.version` a sound staleness test across a zone
// change (`02-api-contracts.md` §6: "Never hold a `PathHandle` across a
// `version` change"). A counter stored on `this` would reset to 0 the moment
// a second `NavSystem` were ever constructed (a test building two, or a
// future save-slot switch tearing down and rebuilding the whole engine) —
// a bare module-level `let` is what makes it genuinely process-wide, exactly
// matching the spec's own wording, and it is never reset by `dispose()`.

import {
  NAV_FLAG,
  RASTER,
  createNavGrid,
  createRasterScratch,
  rasterizeNav,
  passN1Clear,
  passN2GroundStamp,
  passN6Cost,
  passN7Regions,
  walkable as gridWalkable,
  flagsAt as gridFlagsAt,
  regionAt as gridRegionAt,
  connected as gridConnected,
  markHazard as gridMarkHazard,
} from './grid.js';
import { AStarScheduler } from './astar.js';
import { smoothPath, segmentWalkable } from './smooth.js';
import { FlowField } from './flow.js';
import { snapPoint } from './snap.js';

let navVersionCounter = 0;

/** Re-export — `02-api-contracts.md` §6's `NAV_FLAG`, so a caller that wants
 * the bit constants can `import { NAV_FLAG } from '../nav/index.js'`
 * (`ctx.get('nav')` gives the instance, not the module) without reaching
 * into `./grid.js` itself. Same object as `src/world/raster.js`'s — see
 * `grid.js`'s header. */
export { NAV_FLAG };

/** ASSIGNED — cells per side of the tiny grid this file builds in two
 * documented "there is no real zone geometry to build against" situations:
 * (1) a fresh `NavSystem`, before its first `rebuild()` call, so `.grid` /
 * `.walkable()` / etc. are always safe to read (never `null`); (2)
 * `rebuild(zone)` invoked with no usable geometry at all — see
 * `resolveGridGeometry`'s own comment for exactly when that happens (it is
 * a real, observed call site: `src/world/index.js`'s `enterZone` calls
 * `nav.rebuild()` with zero arguments — see this ticket's report). `4` cells
 * at the fixed 0.5 m cell size is a 2x2 m grid: large enough to exercise
 * N1/N2/N7 meaningfully (a real, non-degenerate single region), small
 * enough to cost nothing. Not a spec value — no spec table gives a size for
 * "no zone yet".
 */
const PLACEHOLDER_CELLS = 4;

/**
 * Resolves the `{width, height, originX, originZ, cellSize, heightField}`
 * a `rebuild()` call should rasterise against, from whatever `zone` (or
 * `zone`-shaped fallback) is available. Three cases, tried in order:
 *
 * 1. `zone.nav` already carries a real, world-built `NavGrid` shell
 *    (`07-world-gen.md` §6.1's table: "Allocate the NavGrid | world |
 *    cellSize, width, height, originX, originZ"). This is the FUTURE,
 *    correct path once a later ticket makes `world` actually build one and
 *    attach it to `ZoneInstance.nav` — today `src/world/index.js` (WRLD-1)
 *    always sets `nav: null` and never updates it, so this branch is
 *    forward-compatible, documented, but not yet exercised by any real
 *    caller (this file's own tests exercise it directly).
 *
 *    Terrain-height naming note: `07` §6.1's prose says `nav.rebuild(zone)`
 *    reads "`zone.nav.height`", but `01-data-model.md` §9.3's actual
 *    `NavGrid` record types `height` as the grid's own INTEGER cell count
 *    (`height: 192, // int cells`) and names the terrain sample array
 *    `groundY` (`Float32Array`) instead — the same kind of `07`-prose-vs-
 *    `01`-record naming drift `src/world/raster.js`'s O-35 note already
 *    resolved for `Footprint`. Resolved the same way, in `01`'s favour
 *    (the canonical data-model authority this ticket was told to read):
 *    this function reads `zone.nav.groundY` as the terrain heightfield,
 *    never `zone.nav.height` (which stays exclusively the cell-count int,
 *    so it is never mistaken for a `Float32Array`).
 *
 * 2. `zone.boundsMinX/boundsMaxX/boundsMinZ/boundsMaxZ` — `src/world/index.js`
 *    (WRLD-1)'s REAL, actual `ZoneInstance` shape today. `cellSize` is the
 *    fixed `01` §9.3 constant (`RASTER.CELL_SIZE`, 0.5 m); width/height in
 *    cells are derived from the bounds. No height field (no generator
 *    exists yet to sample one) — `null`, which is `passN3Slope`'s own
 *    documented no-op input.
 *
 * 3. Neither is available (`zone` is `null`/`undefined` AND has none of the
 *    above fields) — `PLACEHOLDER_CELLS` square, at the world origin. This
 *    is the exact situation `src/world/index.js`'s own `enterZone` produces
 *    on its very FIRST call in a process: it invokes `nav.rebuild()` with
 *    zero arguments, and does so BEFORE `this._current`/`this._staticFootprints`
 *    are updated to the new zone (`world.current` is still `null` at that
 *    point) — see this ticket's report for the full trace. `rebuild()` must
 *    not throw out from under that call site, so this is the documented,
 *    honest "there is nothing to build against yet" answer, not a guess at
 *    unknown geometry.
 * @param {object|null|undefined} zone
 * @returns {{width:number, height:number, originX:number, originZ:number, cellSize:number, heightField: Float32Array|null}}
 */
function resolveGridGeometry(zone) {
  const cellSize = RASTER.CELL_SIZE;

  if (
    zone &&
    zone.nav &&
    Number.isFinite(zone.nav.width) &&
    Number.isFinite(zone.nav.height) &&
    Number.isFinite(zone.nav.originX) &&
    Number.isFinite(zone.nav.originZ)
  ) {
    return {
      width: zone.nav.width,
      height: zone.nav.height,
      originX: zone.nav.originX,
      originZ: zone.nav.originZ,
      cellSize: Number.isFinite(zone.nav.cellSize) ? zone.nav.cellSize : cellSize,
      heightField: zone.nav.groundY instanceof Float32Array ? zone.nav.groundY : null,
    };
  }

  if (
    zone &&
    Number.isFinite(zone.boundsMinX) &&
    Number.isFinite(zone.boundsMaxX) &&
    Number.isFinite(zone.boundsMinZ) &&
    Number.isFinite(zone.boundsMaxZ)
  ) {
    const width = Math.max(1, Math.round((zone.boundsMaxX - zone.boundsMinX) / cellSize));
    const height = Math.max(1, Math.round((zone.boundsMaxZ - zone.boundsMinZ) / cellSize));
    return {
      width,
      height,
      originX: zone.boundsMinX,
      originZ: zone.boundsMinZ,
      cellSize,
      heightField: null,
    };
  }

  return {
    width: PLACEHOLDER_CELLS,
    height: PLACEHOLDER_CELLS,
    originX: 0,
    originZ: 0,
    cellSize,
    heightField: null,
  };
}

export class NavSystem {
  static id = 'nav';
  static deps = ['world'];

  constructor() {
    this._ctx = null;

    // Placeholder grid so `.grid`/`.walkable()`/`.flagsAt()`/`.regionAt()`/
    // `.connected()` are always safe to call, even before the first real
    // `rebuild()` — see `PLACEHOLDER_CELLS`'s own comment. All-walkable,
    // single region, version 0 (0 = "never rebuilt", a sentinel every
    // `brain.pathVersion !== nav.version` staleness check treats as
    // immediately stale, per `07` §6.7).
    this._gridWidth = PLACEHOLDER_CELLS;
    this._gridHeight = PLACEHOLDER_CELLS;
    this._grid = createNavGrid({
      cellSize: RASTER.CELL_SIZE,
      width: this._gridWidth,
      height: this._gridHeight,
      originX: 0,
      originZ: 0,
    });
    this._scratch = createRasterScratch(this._gridWidth, this._gridHeight);
    passN1Clear(this._grid);
    passN2GroundStamp(this._grid, null); // absent-input fallback: whole grid walkable
    // NAV-6 — N6 now runs even on the placeholder: `markHazard` (below)
    // needs a real `cost` baseline (`this._hazardBaseCost`, next) to
    // recompute from, and N1 alone leaves `grid.cost` at 255 everywhere
    // (impassable) despite N2 having just marked every cell walkable — a
    // pre-existing mismatch this ticket is the first caller to actually
    // depend on being correct. `this._scratch.nearWall` is all-zero here
    // (never touched without a real `passN4FootprintStamp` call), so this
    // computes the honest, only-possible answer for an untouched
    // placeholder: cost 1 everywhere.
    passN6Cost(this._grid, this._scratch);
    passN7Regions(this._grid, this._scratch); // single region, id 0
    this._grid.version = 0;
    this._version = 0;

    // NAV-6 (D-58) — `markHazard`'s own bookkeeping. `refcount[i]` is the
    // live-hazard-source count per cell (what makes overlapping hazards not
    // corrupt each other — see `./grid.js`'s `markHazard` header for the
    // full reasoning); `baseCost[i]` is `grid.cost[i]` as N6 left it, with
    // the hazard term always 0, captured once so the cost bump/undo is
    // always a recompute from a cached value, never an incremental
    // `+=`/`-=` that N6's `clamp(..., 254)` would make unsound. Both are
    // preallocated here and in every `rebuild()` (rule 5 — `Alloc: no` on
    // `markHazard` itself), sized to the grid's current cell count, and
    // both are reset whenever the grid is rebuilt — see `rebuild()`'s own
    // comment for why that reset is the correct call, not a leak.
    this._hazardRefcount = new Uint16Array(this._gridWidth * this._gridHeight);
    this._hazardBaseCost = new Uint8Array(this._gridWidth * this._gridHeight);
    this._hazardBaseCost.set(this._grid.cost);

    // `stats` — Alloc: no, mutated in place, same object every call (the
    // `src/physics/index.js` `get stats()` convention). Every field here
    // belongs to NAV-2's A*/path-request budget (`pending`,
    // `solvedThisSecond`, `avgNodes`, `refusals`) or NAV-4's flow field
    // (`fieldMs`) — neither exists yet, so all five sit at their honest
    // zero/never-measured value. `stats` itself IS this ticket's to expose
    // (see the ticket's "Yours" list); the fields' real values are not.
    this._stats = { pending: 0, solvedThisSecond: 0, avgNodes: 0, fieldMs: 0, refusals: 0 };

    // NAV-2 — the A* solver + request ring. Mutates `this._stats` in place
    // (same object, Alloc: no) — see ./astar.js for everything it owns.
    this._astar = new AStarScheduler(this._stats);

    // NAV-4 — the flow field. Owns its own generation counter
    // (`flowVersion`), never `this._version`'s — see ./flow.js's header,
    // "Two distances" / "A version bump mid-flight". Never touches
    // `this._stats` (`stats.fieldMs` stays the constructor's honest 0 — see
    // that file's own header, "stats.fieldMs").
    this._flowField = new FlowField();

    // NAV-5 — `snap`'s reused `Vec3` scratch for the no-`out` case. Same
    // "one shared object, valid until the next call" convention as
    // `AStarScheduler._nodeScratch`/`FlowField._dirScratch` — see
    // ./snap.js's header, "Alloc: no".
    this._snapScratch = { x: 0, y: 0, z: 0 };
  }

  /** @param {object} ctx */
  async init(ctx) {
    this._ctx = ctx;
    // No `ctx.rng.fork()` — nav draws no randomness in this ticket's scope
    // (rasterisation is pure geometry over caller-supplied footprints; A*'s
    // tie-breaking, if it ever needs one, is NAV-2's decision to make). Same
    // "don't fork an unused stream" precedent as PHYS-1/2, WRLD-1, ACTR-1 —
    // and the same reason: `tests/core/boot.test.js` asserts the whole
    // registered subsystem set draws nothing from the root `ctx.rng` during
    // boot, and `Rng.fork()` itself consumes four draws.
  }

  /** `02-api-contracts.md` §6: `grid` -> `NavGrid` (read-only). Same object
   * across calls between two `rebuild()`s (Alloc: no) — callers must never
   * write to `.flags`/`.cost` (see that doc's "Forbidden for callers"). */
  get grid() {
    return this._grid;
  }

  /** `02-api-contracts.md` §6: `version` -> `int`, tracking the GRID (never
   * the flow field — see `NavSystem`'s own header on why `flowVersion`,
   * NAV-4, is not implemented here). `0` before the first `rebuild()`. */
  get version() {
    return this._version;
  }

  /** `02-api-contracts.md` §6: `flowVersion` -> `int`, tracking the FLOW
   * FIELD — a completely different cadence from `version` (the grid's own
   * counter, above). See `./flow.js`'s header, "Two distances", for why the
   * two can never stand in for one another. `0` before the first
   * `buildFlowField()`. */
  get flowVersion() {
    return this._flowField.flowVersion;
  }

  /**
   * `02-api-contracts.md` §6: `rebuild(zone: ZoneInstance) => void`. `Fixed:
   * N` — never call this from `fixedUpdate`. Runs N1-N10 (`src/world/raster.js`,
   * WRLD-2) over `world.staticFootprints` (read via `ctx.get('world')` — a
   * hard dependency, `static deps = ['world']`, never imported) and N11
   * (this file: version bump, `zone.navVersion` mirror, `nav:rebuilt`
   * emission). Never queries `physics`; runs identically in Node.
   *
   * Reallocates the grid/scratch only when the resolved cell dimensions
   * actually change (re-entering the same zone kind, e.g. town -> wastes ->
   * town, reuses the previous typed arrays — `rebuild` is documented
   * `Alloc: yes`, but there is no reason to pay for it on every call when
   * the shape didn't move).
   *
   * NAV-6 (D-58) — every `rebuild()` unconditionally RESETS
   * `this._hazardRefcount` to all-zero and recaptures `this._hazardBaseCost`
   * from the freshly-rasterised `grid.cost` (which N1 always clears to
   * hazard-free first). This is the documented answer to the ticket's rule
   * 12 ("must not resurrect stale hazards, must not silently drop live
   * ones"): dropping is the correct call here, not a leak in disguise,
   * because `rebuild()` only ever runs on a full zone transition
   * (`02-api-contracts.md` §6: "called by `world` only") — `07-world-gen.md`
   * §6.6's own table says the nav grid is otherwise immutable except for
   * this bit, so a rebuild always means "new geometry, N1 clears `flags`
   * to 0". Every live hazard source is a ground effect owned by `skills`,
   * and `skills`' own `zone:teardown` listener already tears down every
   * ground effect on the same zone transition that triggers this rebuild
   * (`02-api-contracts.md` §10, "Listens: ... `zone:teardown` (clears
   * projectiles and ground effects)") — so by the time a rebuilt grid is
   * ever queried again, no source claiming a hazard on the OLD grid still
   * exists to re-register on the new one. There is no "live" hazard to
   * drop across this boundary; carrying `refcount`/`baseCost` across it
   * instead would be the actual bug — stale counts from a torn-down zone's
   * cell layout silently misapplied to a same-sized new zone's cells.
   *
   * @param {object} [zone] a `ZoneInstance`. See `resolveGridGeometry` for
   *   what happens when this is omitted or lacks grid geometry — including
   *   the documented, real call site (`src/world/index.js`'s own
   *   `enterZone`) that always omits it.
   */
  rebuild(zone) {
    const ctx = this._ctx;
    const world = ctx.get('world'); // hard dep (static deps=['world']) — always registered

    const zoneForGeometry = zone || world.current || null;
    const geo = resolveGridGeometry(zoneForGeometry);

    if (geo.width !== this._gridWidth || geo.height !== this._gridHeight) {
      this._grid = createNavGrid({
        cellSize: geo.cellSize,
        width: geo.width,
        height: geo.height,
        originX: geo.originX,
        originZ: geo.originZ,
      });
      this._scratch = createRasterScratch(geo.width, geo.height);
      this._gridWidth = geo.width;
      this._gridHeight = geo.height;
      // NAV-6 — resized, so `markHazard`'s buffers must be too (rule 5:
      // preallocated, never grown/rebuilt per-call).
      this._hazardRefcount = new Uint16Array(geo.width * geo.height);
      this._hazardBaseCost = new Uint8Array(geo.width * geo.height);
    } else {
      // Same cell dimensions — reuse the typed arrays, just refresh the
      // scalar placement fields (a same-sized zone can still sit at a
      // different world origin).
      this._grid.cellSize = geo.cellSize;
      this._grid.originX = geo.originX;
      this._grid.originZ = geo.originZ;
    }

    const footprints = world.staticFootprints || [];

    const result = rasterizeNav(this._grid, this._scratch, {
      footprints,
      groundRegions: null, // no ground-region emitter exists yet (see raster.js's own header)
      heightField: geo.heightField,
      entry: null, // no generator-supplied entry point exists yet (07 §6.2 N8's own optional-input path)
      spawnDenyMarkers: null, // no spawner/generator ticket has landed yet
    });

    // NAV-6 — see this method's own header. `rasterizeNav` (N1-N10) never
    // writes NAV_FLAG.hazard itself, so `grid.cost` here is always the
    // correct, hazard-free baseline `markHazard` recomputes from; the
    // refcount array is reset to all-zero for the same reason (no
    // survivor to preserve across a zone transition).
    this._hazardRefcount.fill(0);
    this._hazardBaseCost.set(this._grid.cost);

    // N11 (07 §6.2 / §6.7): process-global monotonic bump, mirrored onto
    // both the grid and the zone, then the event.
    navVersionCounter++;
    this._version = navVersionCounter;
    this._grid.version = navVersionCounter;
    if (zoneForGeometry) zoneForGeometry.navVersion = navVersionCounter;

    ctx.events.emit('nav:rebuilt', {
      zoneId: zoneForGeometry ? zoneForGeometry.zoneId : null,
      navVersion: navVersionCounter,
      regionCount: result.regionCount,
    });
  }

  /** `02-api-contracts.md` §6: `walkable(x,z) => boolean`. */
  walkable(x, z) {
    return gridWalkable(this._grid, x, z);
  }

  /** `02-api-contracts.md` §6: `flagsAt(x,z) => int` — `NAV_FLAG` bitfield. */
  flagsAt(x, z) {
    return gridFlagsAt(this._grid, x, z);
  }

  /** `02-api-contracts.md` §6: `regionAt(x,z) => int` — `-1` when blocked
   * (also off-grid — see `./grid.js`'s own comment). */
  regionAt(x, z) {
    return gridRegionAt(this._grid, x, z);
  }

  /** `02-api-contracts.md` §6: `connected(ax,az,bx,bz) => boolean` — same
   * region. */
  connected(ax, az, bx, bz) {
    return gridConnected(this._grid, ax, az, bx, bz);
  }

  /** `02-api-contracts.md` §6: `snap(x,z,maxRadius,out?) => Vec3 | null` —
   * nearest walkable point, `null` when nothing walkable lies within
   * `maxRadius`. See `./snap.js` for the algorithm (clamp-into-cell nearest
   * point, the `maxRadius===0`/I3 fast path, the tie-break rule, the
   * degenerate-input handling and why region is deliberately not filtered
   * here). `out` omitted -> this file's own shared `_snapScratch` (Alloc:
   * no — same convention `pathNode`/`flowAt` already use). */
  snap(x, z, maxRadius, out) {
    return snapPoint(this._grid, x, z, maxRadius, out || this._snapScratch);
  }

  /** `02-api-contracts.md` §6 / D-58 (NAV-6): `markHazard(x,z,radius,on) =>
   * void` — the only writer of `NAV_FLAG.hazard`; `skills` is its only
   * legitimate caller (§6 "Forbidden for callers", restated in §10's own
   * "Forbidden for callers" for `skills`). Sets/clears the bit and the
   * `RASTER.COST_HAZARD` cost bump on exactly the cells whose centre lies
   * within `radius` of `(x,z)`, never touching `walkable` or `region` — see
   * `./grid.js`'s own `markHazard` for the algorithm: refcounted overlap
   * safety (criterion 4 — two hazards sharing a cell, one expiring, must
   * leave the cell still marked) and a cached-baseline cost recompute
   * (never an incremental `+=`/`-=`, which `passN6Cost`'s clamp would make
   * unsound). This method itself owns nothing but forwarding — the two
   * buffers that make it `Alloc: no` (`this._hazardRefcount`,
   * `this._hazardBaseCost`) are preallocated in the constructor and reset
   * every `rebuild()` (see that method's own comment for why a rebuild
   * always resets them rather than carrying hazards across a zone change).
   * @param {number} x @param {number} z @param {number} radius
   * @param {boolean} on */
  markHazard(x, z, radius, on) {
    gridMarkHazard(this._grid, this._hazardRefcount, this._hazardBaseCost, x, z, radius, on);
  }

  /** `02-api-contracts.md` §6: `stats` -> `{ pending, solvedThisSecond,
   * avgNodes, fieldMs, refusals }`. Same object every call (Alloc: no); see
   * the constructor's comment for why every field is honestly zero today. */
  get stats() {
    return this._stats;
  }

  /** `docs/ARCHITECTURE.md` subsystem interface: 60 Hz, deterministic. Two
   * lines, both forwards into `AStarScheduler` (`./astar.js`) — see that
   * file for the per-step accept throttle (`beginStep`) and the solve loop
   * (`runSolves`, up to `setBudget`'s count, against the CURRENT grid and
   * version, never a cached one). Never reads `ctx.time.dt`/`performance.now()`
   * (O-29) — only `ctx.time.step`, for the `stats.solvedThisSecond` window.
   * @param {number} h @param {object} ctx */
  fixedUpdate(h, ctx) {
    this._astar.beginStep();
    this._astar.runSolves(this._grid, this._version, ctx.time.step);
  }

  /** `02-api-contracts.md` §6: `requestPath(fromX,fromZ,toX,toZ,ownerId) =>
   * int requestId | 0`. Never solves inline, never blocks — see
   * `./astar.js`'s header. */
  requestPath(fromX, fromZ, toX, toZ, ownerId) {
    return this._astar.requestPath(this._grid, fromX, fromZ, toX, toZ, ownerId, this._version);
  }

  /** `02-api-contracts.md` §6: `pollPath(requestId) => PathHandle | null`. */
  pollPath(requestId) {
    return this._astar.pollPath(requestId);
  }

  /** `02-api-contracts.md` §6: `cancelPath(requestId) => void`. */
  cancelPath(requestId) {
    this._astar.cancelPath(requestId);
  }

  /** `02-api-contracts.md` §6: `releasePath(path) => void`. */
  releasePath(path) {
    this._astar.releasePath(path);
  }

  /** `02-api-contracts.md` §6: `pathNode(path,i,out?) => Vec3`. */
  pathNode(path, i, out) {
    return this._astar.pathNode(path, i, out);
  }

  /** `02-api-contracts.md` §6: `pathLength(path) => int` — node count. */
  pathLength(path) {
    return this._astar.pathLength(path);
  }

  /** `02-api-contracts.md` §6: `setBudget(pathsPerStep) => void`, default 4. */
  setBudget(pathsPerStep) {
    this._astar.setBudget(pathsPerStep);
  }

  /** `02-api-contracts.md` §6: `raycastNav(ax,az,bx,bz) => boolean` —
   * "grid-space line of walk". `Fixed: Y`, `Alloc: no`. NAV-7 (D-74): this
   * is a direct forward into `./smooth.js`'s `segmentWalkable` — the exact
   * same supercover-DDA-with-corner-tie-check that file's NAV-3 header
   * always said a later `raycastNav` ticket should reuse rather than
   * re-derive (see that file's own header, "Segment-walkability test —
   * option (a)"). No new algorithm here; `player/move.js`'s and
   * `ai/perception.js`'s `typeof nav.raycastNav === 'function'` guards pick
   * this up with no edit on their side. */
  raycastNav(ax, az, bx, bz) {
    return segmentWalkable(this._grid, ax, az, bx, bz);
  }

  /** `02-api-contracts.md` §6: `smooth(path) => void` — string-pull in
   * place. See `./smooth.js` (NAV-3) for the algorithm, the segment-
   * walkability test and every proof (in-place compaction, idempotence,
   * determinism, no corner-cutting). */
  smooth(path) {
    smoothPath(this._grid, path);
  }

  /** `02-api-contracts.md` §6: `buildFlowField(targetX,targetZ) => void` —
   * "one per fixed step, at most" (that scheduling is `ai`'s business, never
   * this file's — see `./flow.js`'s header). Passes the CURRENT grid/version
   * through on every call, the same `AStarScheduler.requestPath` convention. */
  buildFlowField(targetX, targetZ) {
    this._flowField.build(this._grid, this._version, targetX, targetZ);
  }

  /** `02-api-contracts.md` §6: `flowAt(x,z,out?) => {dx,dz}` — unit
   * direction, `{0,0}` if unreachable. See `./flow.js` for every case that
   * counts as unreachable (off-window, unvisited, the target's own cell, or
   * a field that has outlived a `rebuild()`). */
  flowAt(x, z, out) {
    return this._flowField.flowAt(x, z, this._version, out);
  }

  /** `02-api-contracts.md` §6: `flowDistance(x,z) => number` — metres along
   * the field, `Infinity` if unreachable. */
  flowDistance(x, z) {
    return this._flowField.flowDistance(x, z, this._version);
  }

  dispose() {
    this._ctx = null;
    this._astar = null;
    this._flowField = null;
  }
}
