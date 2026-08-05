// src/nav/astar.js
//
// NAV-2 — the A* solver and the request ring (`docs/spec/02-api-contracts.md`
// §6's `requestPath`/`pollPath`/`cancelPath`/`releasePath`/`pathNode`/
// `pathLength`/`setBudget`/`stats`; `06-monsters-ai.md` §9.1/§9.2's budget and
// ring scheduler). `src/nav/index.js` (NAV-1) wires these onto `NavSystem` —
// this file is the real solver, Node-safe, no `ctx`, no `three`, no
// `performance.now()` (O-29). Exactly the `PhysicsSystem`/`body.js` split.
//
// ===========================================================================
// The numbers — every one cited, none invented (rule 6)
// ===========================================================================
//   DEFAULT_BUDGET = 4     06 §9.1 table ("A* solves per fixed step"), and
//                          02 §6's own prose ("pathsPerStep = 4").
//   NODE_CAP = 1200        06 §9.1 table ("Node cap per solve"). Spent PER
//                          SOLVE SLOT PER STEP, not per request — see "A solve
//                          spans steps" below.
//   SOLVE_NODE_LIMIT       ASSIGNED — see its own comment.
//   REQUEST_CAPACITY = 64  ASSIGNED — no spec table gives a total in-flight
//                          request count. `pathsPerStep` bounds how many NEW
//                          requests this file will ACCEPT in a single step
//                          (see "The per-step accept throttle" below), so the
//                          only way the pool can fill up is a caller holding
//                          many `SOLVED` handles without releasing them, or a
//                          multi-step backlog. 64 is 16x the per-step budget
//                          and comfortably covers 06 §9.3's "above 40 active
//                          monsters" ceiling (flee/reposition/leash paths
//                          stay requestable above that count) with margin to
//                          spare. Exceeding it is not a crash: `requestPath`
//                          returns 0, the same non-blocking signal a
//                          per-step-budget refusal gives.
//
// ===========================================================================
// A solve spans steps — NODE_CAP is a per-frame budget, not a correctness
// bound (M5 gate ⑦)
// ===========================================================================
// Until M5's walkability gate, `_solveOne` ran one request to completion
// inside one fixed step and ABANDONED it (counting a refusal) the moment it
// had expanded NODE_CAP cells. That made 06 §9.1's per-frame number decide
// which paths EXIST, and it is why a Bonereach traversal was impossible:
// measured on the real `boot()` -> `world.enterZone('bonereach', ...)`
// pipeline, entry -> exit needs 2 118 - 12 624 expansions (8 layouts), and
// the open Ashen Wastes needs up to 2 337 (5 layouts) — every one of them
// over the cap, so every one of them refused, forever, on every retry. The
// player travelled 0.00 m.
//
// The fix keeps the budget and drops the false bound: a search that reaches
// its allowance is SUSPENDED, not abandoned, and resumes on the next step
// where it left off. Per step the solver still expands at most
// `budget * NODE_CAP` cells (4 x 1200 by default) — the exact ceiling it had
// before, so 12.P08/12.P09 and the frame budget are untouched — but a long
// path now costs several steps of latency instead of never resolving. The
// Bonereach worst case above resolves in ceil(12624 / 4800) = 3 steps
// (~50 ms), well inside `src/player/move.js`'s own 15-step pending timeout.
//
// Only ONE request may be mid-search at a time: the A* scratch (`_cellGen`/
// `_gScore`/`_fScore`/`_cameFrom`/`_cellState`/`_heapCells`/`_heapPos`) is a
// single shared set of grid-sized arrays, and a second search would clobber
// a suspended one's heap and generation stamps. `_activeId` names the holder;
// `runSolves` resumes it before dequeuing anything new, so a long search
// delays other requests by at most the handful of steps it takes to finish
// (they queue; `requestPath` keeps accepting, and a caller that is refused
// gets the same non-blocking 0 it always did). The alternative — a second
// full scratch set, ~1.4 MB at 224x224 — buys parallelism no measured case
// needs.
//
// What is still a refusal: a search whose open set empties without reaching
// the goal (impossible after the same-region pre-check, kept defensively), a
// path longer than `PATH_NODE_CAP` nodes, and `SOLVE_NODE_LIMIT` — 06 §9.1's
// "the abort is counted in refusals" survives intact for the cases that are
// genuinely a give-up. Suspension is not a refusal: nothing was given up on.
//
// ===========================================================================
// The id scheme — the SAME bijection ACTR-1/PHYS-2 use, for the same reason
// ===========================================================================
// "A released or cancelled request id must not resolve later" (this ticket's
// brief) is the literal guarantee `ActorPool` (`src/actors/pool.js`) built
// for `Actor.id` and `PhysicsSystem`'s `bodyId` free list gives for bodies:
//
//   requestId = 1 + poolIndex + generation * REQUEST_CAPACITY
//
// A bijection for `0 <= poolIndex < REQUEST_CAPACITY` — two different
// `(poolIndex, generation)` pairs can never collide (same proof as
// `pool.js`'s header: `|pA-pB| < capacity` forces `pA=pB, gA=gB`). Since
// `generation` only ever increases for a slot, a slot's own id sequence
// strictly increases and never repeats. `pollPath`/`cancelPath`/`releasePath`
// decode `poolIndex = (id-1) % REQUEST_CAPACITY` and compare the record's
// CURRENT `generation`/`id` against what was decoded — a stale id, once its
// slot has been freed (even if immediately reallocated to a brand new
// request), can never again compare equal, so it can never resolve to
// whatever now occupies that slot. No `Map`, zero allocation, same reasoning
// `pool.js`'s header gives for why a `Map<id, record>` measured a real,
// reproducible leak (V8 compaction on a never-repeating-key insert/delete
// cycle) even with the live count pinned at one.
//
// ===========================================================================
// Holding a PathHandle: hold the id, not the object (an ambiguity resolved)
// ===========================================================================
// `01-data-model.md` §9.6's `Brain.path` field literally stores "PathHandle
// from nav, or null" — read at face value, that asks a caller to hold the
// OBJECT `pollPath` returns across many fixed steps while it walks
// `pathIndex` along it. That is safe as long as nothing else in this file
// ever mutates a `SOLVED` record's fields out from under a live holder — and
// nothing does: a slot's data changes only when ITS OWN owner calls
// `cancelPath`/`releasePath` on that exact id (freeing it) or when a NEW
// `requestPath` reuses the freed slot afterward. Holding the raw handle is
// therefore sound UNTIL the caller itself releases it — the "recycled
// id/handle must not resolve to a live but unrelated object" guarantee is
// about a THIRD party's id/handle never aliasing yours, not about using your
// own handle after you already freed it (a use-after-free is exactly as
// undefined here as reading an `Actor` after calling `despawn()` on it
// directly instead of resolving an `ActorRef` — a caller-discipline problem,
// not a pool-design one). This file still adds one cheap net: `pathNode`/
// `pathLength`/`releasePath` check `record.state === SOLVED` before reading,
// so a handle used strictly after ITS OWN release (before any reuse)
// degrades to the documented safe default (an empty/zeroed read) rather than
// silently reading whatever the pool happens to hold in that slot.
//
// Practical recommendation (for whichever AI-* ticket wires `ai` to this):
// prefer re-deriving the handle via `pollPath(requestId)` right before each
// read rather than stashing the object across many steps — it costs nothing
// extra (pollPath is `Alloc: no`, O(1)) and it is what makes a version-bump
// or an accidental double-release fail safe instead of silently stale. This
// file supports EITHER style; it does not mandate one.
//
// ===========================================================================
// The per-step accept throttle — why requestPath's "0 = budget full" is a
// step-scoped counter, not a total-in-flight cap
// ===========================================================================
// 06 §9.2's ring-scheduler pseudocode calls `nav.requestPath` in a loop and
// treats `id === 0` as "budget full for THIS STEP", breaking out and retrying
// next step. That only makes sense if `requestPath` itself is counting
// ACCEPTS within the current step, independent of how many older requests
// are still queued waiting to be solved. `beginStep()` (called once, at the
// top of `NavSystem.fixedUpdate`) resets an `_acceptedThisStep` counter to 0;
// `requestPath` refuses (returns 0) once that counter reaches `_budget`,
// without ever touching the solve queue or the pool. This is exactly what
// this ticket's own acceptance demonstration needs: call `requestPath` 5
// times back-to-back with no `fixedUpdate` in between and the default
// budget of 4 — the first four succeed, the fifth returns 0, none of them
// ever ran a solve or blocked.
//
// Solving (draining the FIFO of accepted-but-not-yet-solved requests) is a
// SEPARATE budget, `runSolves`, also capped at `_budget` per call — this is
// the "4 solves per fixed step" half of 06 §9.1. The two counters happen to
// share one configured number (`setBudget` sets both), matching 02 §6's
// single `pathsPerStep` knob, but they are tracked independently: accepting
// a request this step never itself counts against next step's solve budget,
// and vice versa.
//
// ===========================================================================
// Never blocks — requestPath enqueues, fixedUpdate solves
// ===========================================================================
// `requestPath` never touches the open-set/heap machinery. It is index
// arithmetic and a ring-buffer push, always O(1), always returns
// synchronously. The actual A* run happens only inside `runSolves`, called
// from `NavSystem.fixedUpdate` — `Fixed: Y` on `requestPath` in 02 §6 is
// exactly this: safe to call from `fixedUpdate` because it can never itself
// become the thing that blows the frame budget.
//
// ===========================================================================
// Heuristic — octile distance, admissible against a cost-weighted grid
// ===========================================================================
// 8-directional movement's standard admissible heuristic is octile distance
// with unit cardinal cost 1 and unit diagonal cost sqrt(2):
//
//   h = dmax + (SQRT2 - 1) * dmin,   dmin/dmax = min/max(|dcx|, |dcz|)
//
// (the equivalent, more common form `(dx+dz) + (SQRT2-2)*min(dx,dz)` — both
// reduce to the same value; see either form's derivation in any A* text).
// `SQRT2` is `Math.SQRT2`, a constant read once, never a per-call
// `Math.sqrt`/`Math.hypot` (the latter measured to allocate — banned,
// ARCHITECTURE.md / this ticket's brief).
//
// This grid is cost-WEIGHTED (`grid.cost` 1..254, 255 impassable — WRLD-2's
// N6), not unit-cost, so the raw octile distance is not automatically a
// valid lower bound on the true minimum path cost. It still is one here,
// because `passN6Cost` never emits a cost below 1 for a walkable cell — the
// true cost of any edge is at least `1 * (cardinal ? 1 : SQRT2)`, i.e. at
// least the pure geometric unit cost octile distance already assumes. Since
// every real edge cost is >= the unit cost the heuristic charges for it, the
// heuristic's total is always <= the true cheapest path cost: admissible,
// by construction, for exactly this grid's cost floor.
//
// ===========================================================================
// Heuristic weighting — a deliberate, bounded departure from admissibility
// ===========================================================================
// The octile heuristic above is admissible (proven). Pure admissible A* on
// this grid, using it unweighted, is NOT enough to keep expansions close to
// linear in path length — this was found and reported as a real defect
// after this ticket's first submission: a single 4x4 m box on an otherwise
// open 96x96 m field made expansions grow roughly QUADRATICALLY with path
// length (61 nodes for a 10 m detour, 912 for 60 m, a full 1200-node ABORT
// at 80 m), and a single localized cost-13 hazard patch (the exact `07`
// §6.4 "Ash Wall" case) or as few as 10 small boxes scattered on an 84 m
// diagonal aborted outright — well inside what 06 §9.1's own "~6x slack
// over straight-line node count" budget assumes is already a hard map.
//
// Root cause, proved directly rather than guessed at: on a uniform-cost
// region, EVERY sequencing of "which cells absorb the diagonal correction,
// and when" that covers the same total (dcx, dcz) offset produces the
// EXACT SAME true path cost. Worked example — correcting a 4-cell lateral
// offset over a long straight run, comparing a cell A that has ALREADY made
// its 4 diagonal corrections against a cell B at the same x that has made
// none yet (dxUsed + dxRemaining == the total straight-line distance,
// constant):
//
//   g(A) = 4*SQRT2 + (dxUsed - 4)      h(A) = dxRemaining
//   g(B) = dxUsed                      h(B) = dxRemaining + 4*(SQRT2 - 1)
//   f(A) = f(B) = dxUsed + dxRemaining + 4*(SQRT2 - 1)   -- IDENTICAL, always
//
// A consistent, admissible heuristic cannot break this tie — it is not
// wrong to call A and B equally good, because they genuinely are. The
// practical effect: every cell in the whole rectangle spanned by "how much
// of the correction could I have already made by this x" is an equally
// valid node to expand, and an admissible search must expand very close to
// all of them before it can PROVE any single one is optimal. This is a
// well-known property of octile/uniform-cost grid search (it is the reason
// Jump Point Search exists), not a bug in the relaxation/heap/corner-cut
// logic — and it was verified that tie-break DIRECTION alone cannot fix it:
// the best admissible tie-break found (prefer higher `g` — see
// `_heapLess`) still hit the 1200-node cap on a localized 6 m-radius hazard
// patch and on a 10-box scattered diagonal, both far short of a "hard" map.
//
// The fix is the standard, well-documented answer to exactly this class of
// problem: WEIGHTED A* (`f = g + HEURISTIC_WEIGHT * h`, `HEURISTIC_WEIGHT`
// > 1). This is a DELIBERATE, DOCUMENTED departure from strict
// admissibility, not a silent one, and it is bounded: weighted A* is
// provably suboptimal by at most a factor of `HEURISTIC_WEIGHT` (a standard
// result — see Pohl 1970, "Heuristic Search Viewed as Path Finding in a
// Graph"). `HEURISTIC_WEIGHT = 1.5` is ASSIGNED, chosen empirically as the
// smallest of {1.0, 1.2, 1.3, 1.5} tested that keeps every adversarial case
// measured for this fix (a full-width cost-13 band, up to 120 scattered
// boxes, the single-box table above) safely under the 1200-node cap with
// real margin, not barely under it — 1.3 solved the hazard-band case at
// 1178/1200 nodes, too close to the cliff to trust across map variation;
// 1.5 solved the identical case at 696/1200.
//
// Measured impact on actual path QUALITY, the question that matters given a
// bounded-suboptimality trade-off: every case checked (the single-box
// table's geometric path length, `HEURISTIC_WEIGHT` at 1.0/1.2/1.3/1.5 side
// by side) returned the IDENTICAL path, node for node. This is exactly what
// the proof above predicts — since so many cells are EXACTLY tied in true
// cost, biasing which one gets expanded first essentially never changes
// which path is ultimately found; it only stops the search from
// wastefully expanding the other, equally-costed alternatives too. The
// 1.5x bound is real and worst-case-honest (a pathological map could in
// principle make the solver settle for a 1.5x-longer route), but it was
// never observed to actually produce a worse path anywhere this was tested.
//
// `gScore` — the true, exact accumulated cost — is never touched by
// `HEURISTIC_WEIGHT`. `_reconstructPath`, `pathLength` and every cost
// figure this file reports come from `gScore`/reconstructed node positions,
// not from the (weighted) `fScore`. `HEURISTIC_WEIGHT` only inflates the
// PRIORITY key used to pick which frontier cell is expanded next; nothing
// external ever reads `fScore`.
//
// ===========================================================================
// Edge cost — destination-cell cost is the traversal weight, never a mask
// ===========================================================================
// Moving into neighbour cell `n`: `edgeCost = grid.cost[n] * (diagonal ?
// SQRT2 : 1)`. `grid.cost` already encodes `255 = impassable`, `1 = open
// floor`, `+2` near a wall, `+6` in water, `+12` in a hazard (WRLD-2 §6.4) —
// weighting by the DESTINATION cell's cost (rather than masking on
// `NAV_FLAG.walkable` alone) is what makes the solver prefer the middle of a
// corridor over scraping a wall, per `06-monsters-ai.md` §6.4's own worked
// example — a solver that only checked `walkable` would find *a* path but
// never a good one.
//
// ===========================================================================
// No corner-cutting
// ===========================================================================
// A diagonal step from cell A to cell B is only legal when BOTH orthogonal
// cells A and B share (the (dx,0) and (0,dz) neighbours) are themselves
// walkable (`cost < 255`). Skipping this check lets a path slip through the
// gap between two diagonally-adjacent blockers — exactly the seam PLYR-2's
// "zero corner sticks" criterion later measures against.
//
// ===========================================================================
// Determinism — total tie-break, generation-stamped scratch, no Map
// ===========================================================================
// The open set is a binary min-heap over `(f, g, cellIndex)`, compared in
// that fixed lexicographic order — `f` first (standard A* priority, and
// `HEURISTIC_WEIGHT`-inflated — see "Heuristic weighting" above), then the
// HIGHER `g` (revised from this ticket's original "lower g" suggestion —
// measured directly: preferring the node that has already paid MORE of its
// true cost, i.e. relies LESS on the remaining heuristic, resolves the
// "many exactly-tied paths" degeneracy the "Heuristic weighting" section
// proves; "lower g" does not, and was measured to leave the pathological
// quadratic-expansion behaviour almost completely intact on its own), then
// the lower flat cell index (row-major, a total order with no ties possible
// once two cells differ at all). Every comparison reads straight off
// `fScore`/`gScore`/the cell index itself — insertion order and expansion
// history never participate. Two solves over identical `(grid, from, to)`
// therefore always pop nodes in the identical order and reconstruct the
// identical path, node for node; `tests/nav/nav2.test.js` hashes two
// independent solves and asserts byte-for-byte equality.
//
// `cellGen`/`gScore`/`fScore`/`cameFrom`/`cellState` are `width*height`-sized
// typed arrays, allocated once per grid size (`ensureScratch`, reallocated
// only when the grid's own dimensions change — the same rare event
// `NavSystem.rebuild` already reallocates the grid itself for) and NEVER
// cleared between solves. Instead, `cellGen[i] === currentGen` is what marks
// a cell "touched this solve" — a generation stamp, the exact fix this
// ticket's brief names for the "clearing 36,864 cells every solve, four
// times a step, is real work" cost. `currentGen` is a plain incrementing
// number (not a fixed-width typed array field), so it never wraps in any
// realistic session length.
//
// ===========================================================================
// Unreachable goal — fail fast via NavGrid.region, never expand 1200 nodes
// ===========================================================================
// Before touching the heap at all: if the start or goal cell is off-grid or
// impassable (`cost >= 255`), or `grid.region[start] !== grid.region[goal]`
// (either `-1`, or simply a different id), the solve fails in O(1). This is
// the exact O(1) answer `nav.regionAt`/`nav.connected` (NAV-1) already give —
// reimplemented here as a direct array read (this file only ever receives a
// `grid`, never a `NavSystem` instance to call `ctx.get('nav')` through; see
// `grid.js`'s own `regionAt`/`connected`, which read the identical field the
// same way) so a rejected request never pays for a single node expansion.
//
// ===========================================================================
// A version bump mid-flight — what happens to a request that spans a rebuild
// ===========================================================================
// `rebuild()` is `Fixed: N` (never called from `fixedUpdate`) and can only
// run BETWEEN fixed steps, never while `runSolves` is mid-loop. A request
// enqueued before a rebuild but not yet solved carries the `version` it was
// requested under (`requestVersion`); `runSolves` compares that against the
// CURRENT version at the top of each dequeue and, on a mismatch, drops the
// request (frees its slot, does not solve it, does not count it as a
// refusal — it was never attempted, so counting it alongside a genuine
// node-cap abort would misreport why solves are failing) rather than run A*
// against arrays sized for a grid that may no longer be the one `nav._grid`
// points at. `02-api-contracts.md` §6 already puts the complementary half of
// this on the caller ("Never hold a `PathHandle` across a `version` change.
// Compare `brain.pathVersion !== nav.version` and repath") — this is the
// solver-side mirror of that rule for requests that were still PENDING when
// the version changed underneath them.
//
// ===========================================================================
// `stats` — what each field means here (all five are NAV-2's to maintain)
// ===========================================================================
//   pending          - requests currently queued, not yet solved (Alloc: no,
//                       read off the ring buffer's live count), plus the one
//                       mid-search request that is no longer in the queue but
//                       has not resolved either.
//   solvedThisSecond - solves that SUCCEEDED (found a real path) in the most
//                       recently finished 60-step window, latched every 60
//                       steps against `ctx.time.step` (never wall-clock —
//                       ARCHITECTURE.md rule 4/5). A node-cap abort or a
//                       fast-fail rejection is not a "solved" path, so
//                       neither counts here — `refusals` is where the abort
//                       case is visible instead.
//   avgNodes         - a running lifetime mean of expanded-node count, over
//                       the same "actually ran the search" solves above.
//   refusals         - solves genuinely GIVEN UP on: `SOLVE_NODE_LIMIT`
//                       exhausted, a path too long for `PATH_NODE_CAP`, or
//                       (as a should-never-happen defensive fallback given
//                       the region pre-check above) an emptied open set —
//                       06 §9.1's literal "the abort is counted in
//                       refusals". A search suspended at `NODE_CAP` for the
//                       step is NOT one of these (see the header, "A solve
//                       spans steps"). Fast-fail rejections
//                       (off-grid/blocked/different-region/stale-version) are
//                       NOT counted here — they never attempted a solve.
//   fieldMs          - NAV-4's flow field. Left at the constructor's honest
//                       0; this file never writes it.

import { RASTER, cellIndexAt } from './grid.js';

/** 06 §9.1. */
export const DEFAULT_BUDGET = 4;
/** 06 §9.1 — expansions one solve slot may spend in ONE fixed step. A search
 * that reaches it is suspended and resumed next step, never abandoned; see
 * this file's header, "A solve spans steps". */
export const NODE_CAP = 1200;
/** ASSIGNED — total expansions ONE request may spend across every step it
 * spans. A* never reopens a closed cell, so a search can never expand more
 * cells than the grid has; the largest shipped zone is 112x112 m = 224x224 =
 * 50 176 cells (`src/world/data/zones.js`), and the same-region pre-check in
 * `_beginSolve` already guarantees the goal is reachable — so on shipped
 * content this ceiling is unreachable and no real path is ever refused for
 * hitting it. It exists so a grid larger than anything M5 ships cannot
 * monopolise the single A* scratch indefinitely; that abort IS a refusal
 * (06 §9.1). At the default budget it bounds one request to
 * 65536 / (4 * 1200) = 14 fixed steps. */
export const SOLVE_NODE_LIMIT = 65536;
/** Nodes one `PathHandle` can hold — sized to `NODE_CAP` as it always was
 * (600 m of 0.5 m grid steps; the longest path measured on a shipped zone is
 * 325 nodes). Since a search may now expand far past `NODE_CAP`, a path that
 * would not fit is refused rather than truncated — see `_reconstructPath`. */
export const PATH_NODE_CAP = NODE_CAP;
/** ASSIGNED — see this file's header. */
export const REQUEST_CAPACITY = 64;
/** ASSIGNED — see this file's header, "Heuristic weighting". Weighted-A*
 * multiplier on the octile heuristic; > 1 is a deliberate, bounded,
 * documented departure from strict admissibility (path cost is guaranteed
 * within `HEURISTIC_WEIGHT`x of optimal), chosen empirically as the
 * smallest tested value that keeps every measured adversarial map safely
 * under `NODE_CAP` with real margin. Never applied to `gScore`. */
export const HEURISTIC_WEIGHT = 1.5;

const STATE_FREE = 0;
const STATE_PENDING = 1;
const STATE_SOLVED = 2;

/** How often (in fixed steps) `solvedThisSecond` is latched. 60 steps @
 * 60 Hz = 1 simulated second (`ARCHITECTURE.md`'s `PHYSICS_HZ`) — scheduled
 * against `ctx.time.step`, never a wall-clock timer. */
const STATS_WINDOW_STEPS = 60;

const SQRT2 = Math.SQRT2;

/** Row-major 8-neighbour offsets: 4 cardinal, then 4 diagonal (the split
 * matters — diagonals need the corner-cut check, cardinals never do). */
const NEI_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEI_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const NEI_DIAGONAL = [false, false, false, false, true, true, true, true];

/**
 * Octile distance in CELL units — see this file's header for the
 * admissibility argument against a cost-weighted grid whose floor is 1.
 * Pure arithmetic, no `Math.sqrt`/`Math.hypot` at call time.
 * @param {number} cx0 @param {number} cz0 @param {number} cx1 @param {number} cz1
 * @returns {number}
 */
function octileHeuristic(cx0, cz0, cx1, cz1) {
  const dx = cx1 > cx0 ? cx1 - cx0 : cx0 - cx1;
  const dz = cz1 > cz0 ? cz1 - cz0 : cz0 - cz1;
  const dmin = dx < dz ? dx : dz;
  const dmax = dx < dz ? dz : dx;
  return dmax + (SQRT2 - 1) * dmin;
}

/** One request-pool slot. Built once (`REQUEST_CAPACITY` times), reused
 * forever — `path` node storage is sized to `PATH_NODE_CAP` up front. Alloc:
 * pool, exactly matching `requestPath`'s documented `Alloc: pool`.
 * @param {number} poolIndex
 * @returns {object}
 */
function createRequestRecord(poolIndex) {
  return {
    poolIndex,
    id: 0,
    generation: 0,
    state: STATE_FREE,
    ownerId: 0,
    fromX: 0,
    fromZ: 0,
    toX: 0,
    toZ: 0,
    requestVersion: -1,
    nodeCount: 0,
    nodesX: new Float32Array(PATH_NODE_CAP),
    nodesY: new Float32Array(PATH_NODE_CAP),
    nodesZ: new Float32Array(PATH_NODE_CAP),
  };
}

/**
 * Fixed-capacity slot pool + FIFO ring of accepted-but-unsolved request ids —
 * the "pool the request records and the path storage" half of `requestPath`'s
 * `Alloc: pool` contract. See this file's header for the id bijection and the
 * "why the FIFO can never overflow" argument (an accepted request always
 * holds exactly one acquired slot until it is dequeued-and-solved,
 * dequeued-and-failed, or explicitly cancelled/released — the ring's fixed
 * size, `REQUEST_CAPACITY`, is never exceeded because a slot can only ever be
 * acquired when the free list is non-empty).
 */
class RequestPool {
  constructor(capacity) {
    this.capacity = capacity;
    this.records = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.records[i] = createRequestRecord(i);

    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;

    this._queue = new Int32Array(capacity);
    this._queueHead = 0;
    this._queueCount = 0;
  }

  get freeCount() {
    return this._freeCount;
  }

  get pendingCount() {
    return this._queueCount;
  }

  /** @returns {number} a free pool slot index. Caller must check `freeCount > 0` first. */
  acquireSlot() {
    return this._freeSlots[--this._freeCount];
  }

  /** Returns `slot` to the free list, bumps its generation (retiring every
   * id ever issued for it), and clears the fields a stale reader could
   * otherwise misread. */
  freeSlot(slot) {
    const rec = this.records[slot];
    rec.state = STATE_FREE;
    rec.id = 0;
    rec.generation = rec.generation + 1;
    rec.nodeCount = 0;
    this._freeSlots[this._freeCount++] = slot;
  }

  /** @param {number} id */
  enqueuePending(id) {
    // Defensive only — see this file's header on why REQUEST_CAPACITY can
    // never actually be exceeded here; never silently overwrite an
    // un-dequeued slot if some future change breaks that invariant.
    if (this._queueCount >= this.capacity) return;
    const tail = (this._queueHead + this._queueCount) % this.capacity;
    this._queue[tail] = id;
    this._queueCount++;
  }

  /** @returns {number} the next pending request id, or 0 if the queue is empty. */
  dequeuePending() {
    if (this._queueCount === 0) return 0;
    const id = this._queue[this._queueHead];
    this._queueHead = (this._queueHead + 1) % this.capacity;
    this._queueCount--;
    return id;
  }
}

/**
 * The real NAV-2 solver + scheduler. `src/nav/index.js` builds one of these
 * in `NavSystem`'s constructor and forwards every `02-api-contracts.md` §6
 * path-request method into it — see that file for the thin wiring.
 */
export class AStarScheduler {
  /** @param {{pending:number, solvedThisSecond:number, avgNodes:number, fieldMs:number, refusals:number}} stats
   *   `NavSystem`'s own `_stats` object — mutated in place (Alloc: no,
   *   same-object-every-call, matching `nav.stats`'s own contract). */
  constructor(stats) {
    this._stats = stats;
    this._pool = new RequestPool(REQUEST_CAPACITY);
    this._budget = DEFAULT_BUDGET;
    this._acceptedThisStep = 0;

    // A* scratch — lazily (re)built to the grid's own `width*height` by
    // `_ensureScratch`; -1/-1 guarantees the very first call always builds.
    this._scratchWidth = -1;
    this._scratchHeight = -1;
    this._cellGen = null; // Float64Array — generation stamp, see file header
    this._gScore = null; // Float32Array
    this._fScore = null; // Float32Array
    this._cameFrom = null; // Int32Array, -1 = no parent
    this._cellState = null; // Uint8Array — meaningful only if cellGen[i] === currentGen
    this._heapCells = null; // Int32Array — binary min-heap, cell indices
    this._heapPos = null; // Int32Array — cellIndex -> heap position (open cells only, this gen)
    this._scratchCellPath = new Int32Array(PATH_NODE_CAP); // reused per solve, backward-walk buffer
    this._currentGen = 0; // plain number, monotonic, never reset — see file header

    // The suspended search that currently owns the scratch above, if any —
    // see the file header, "A solve spans steps". `_activeId` 0 means free.
    this._activeId = 0;
    this._activeGen = 0;
    this._activeHeapSize = 0;
    this._activeExpanded = 0;
    this._activeStartIdx = -1;
    this._activeGoalIdx = -1;

    // stats bookkeeping — see file header for exactly what each counts.
    this._solvesThisWindow = 0;
    this._totalNodesForAvg = 0;
    this._totalSolvesForAvg = 0;

    // `Vec3` shared scratch for `pathNode`'s no-`out` case — the same
    // convention `ActorPool._refScratch` / `Hit`/`MoveResult` rings use
    // (02-api-contracts.md's own `out`-parameter rule).
    this._nodeScratch = { x: 0, y: 0, z: 0 };
  }

  /** `02-api-contracts.md` §6: `setBudget(pathsPerStep) => void`, default 4. */
  setBudget(pathsPerStep) {
    const n = pathsPerStep | 0;
    this._budget = n > 0 ? n : 0;
  }

  /** Called once, at the very top of `NavSystem.fixedUpdate` — resets the
   * per-step accept throttle (see this file's header). */
  beginStep() {
    this._acceptedThisStep = 0;
  }

  /** @param {number} width @param {number} height */
  _ensureScratch(width, height) {
    if (this._scratchWidth === width && this._scratchHeight === height) return;
    // Rebuilding the arrays destroys any suspended search in them. A resize
    // implies a rebuild, so `runSolves` has already dropped it on the version
    // check — defensive only, and it must free the slot rather than leak it.
    if (this._activeId !== 0) {
      this._pool.freeSlot((this._activeId - 1) % this._pool.capacity);
      this._activeId = 0;
    }
    const n = width * height;
    this._cellGen = new Float64Array(n);
    this._gScore = new Float32Array(n);
    this._fScore = new Float32Array(n);
    this._cameFrom = new Int32Array(n);
    this._cellState = new Uint8Array(n);
    this._heapCells = new Int32Array(n);
    this._heapPos = new Int32Array(n);
    this._scratchWidth = width;
    this._scratchHeight = height;
  }

  // -------------------------------------------------------------------------
  // Binary min-heap over (fScore, gScore, cellIndex) — see file header for
  // the determinism argument. All four operations are index arithmetic over
  // the scratch typed arrays; no allocation, no recursion.
  // -------------------------------------------------------------------------

  _heapLess(a, b) {
    const fScore = this._fScore;
    const fa = fScore[a];
    const fb = fScore[b];
    if (fa !== fb) return fa < fb;
    // Tie-break: prefer the HIGHER g (lower remaining h) — see the file
    // header's "Heuristic weighting" section for why this direction, not
    // "lower g", is what actually resolves the many-exactly-tied-paths
    // degeneracy this ticket's second review found.
    const gScore = this._gScore;
    const ga = gScore[a];
    const gb = gScore[b];
    if (ga !== gb) return ga > gb;
    return a < b;
  }

  _heapSwap(i, j) {
    const heapCells = this._heapCells;
    const heapPos = this._heapPos;
    const ci = heapCells[i];
    const cj = heapCells[j];
    heapCells[i] = cj;
    heapCells[j] = ci;
    heapPos[cj] = i;
    heapPos[ci] = j;
  }

  _heapPush(size, cell) {
    const heapCells = this._heapCells;
    const heapPos = this._heapPos;
    let i = size;
    heapCells[i] = cell;
    heapPos[cell] = i;
    size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._heapLess(heapCells[i], heapCells[parent])) {
        this._heapSwap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
    return size;
  }

  _heapSiftDown(size, start) {
    const heapCells = this._heapCells;
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < size && this._heapLess(heapCells[l], heapCells[smallest])) smallest = l;
      if (r < size && this._heapLess(heapCells[r], heapCells[smallest])) smallest = r;
      if (smallest === i) break;
      this._heapSwap(i, smallest);
      i = smallest;
    }
  }

  _heapPop(size) {
    const heapCells = this._heapCells;
    const heapPos = this._heapPos;
    const top = heapCells[0];
    const last = heapCells[size - 1];
    heapCells[0] = last;
    heapPos[last] = 0;
    this._heapSiftDown(size - 1, 0);
    return top;
  }

  _heapDecreaseKey(cell) {
    const heapPos = this._heapPos;
    let i = heapPos[cell];
    while (i > 0) {
      const heapCells = this._heapCells;
      const parent = (i - 1) >> 1;
      if (this._heapLess(heapCells[i], heapCells[parent])) {
        this._heapSwap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API — thin enough for src/nav/index.js to forward 1:1, but the
  // real logic (unlike index.js's OWN methods) lives here, not there.
  // -------------------------------------------------------------------------

  /**
   * `02-api-contracts.md` §6: `requestPath(fromX,fromZ,toX,toZ,ownerId) => int
   * requestId | 0`. Never solves, never blocks — see file header. `grid` and
   * `version` are `NavSystem`'s CURRENT `.grid`/`.version` at call time
   * (read fresh, not cached, by the caller — `src/nav/index.js` passes
   * `this._grid`/`this._version` through on every call).
   * @returns {number}
   */
  requestPath(grid, fromX, fromZ, toX, toZ, ownerId, version) {
    if (
      !Number.isFinite(fromX) ||
      !Number.isFinite(fromZ) ||
      !Number.isFinite(toX) ||
      !Number.isFinite(toZ)
    ) {
      return 0;
    }
    if (this._acceptedThisStep >= this._budget) return 0; // per-step accept throttle — file header
    if (this._pool.freeCount === 0) return 0; // pool exhausted — same non-blocking signal

    const slot = this._pool.acquireSlot();
    const rec = this._pool.records[slot];
    rec.state = STATE_PENDING;
    rec.ownerId = ownerId | 0;
    rec.fromX = fromX;
    rec.fromZ = fromZ;
    rec.toX = toX;
    rec.toZ = toZ;
    rec.requestVersion = version;
    rec.nodeCount = 0;

    const id = 1 + slot + rec.generation * this._pool.capacity;
    rec.id = id;
    this._pool.enqueuePending(id);
    this._acceptedThisStep++;
    this._stats.pending = this._pendingTotal();
    return id;
  }

  /**
   * Spends up to `_budget` solve slots of at most `NODE_CAP` expansions each
   * against the CURRENT `grid`, called once per fixed step from
   * `NavSystem.fixedUpdate`. A slot resumes the suspended search first, if
   * there is one — see the file header, "A solve spans steps".
   * @param {object} grid @param {number} version @param {number} stepIndex
   */
  runSolves(grid, version, stepIndex) {
    this._dropActiveIfStale(version);
    this._ensureScratch(grid.width, grid.height);

    let solvesUsed = 0;
    while (solvesUsed < this._budget) {
      let rec = this._activeRecord();

      if (rec === null) {
        const id = this._pool.dequeuePending();
        if (id === 0) break;

        const slot = (id - 1) % this._pool.capacity;
        const candidate = this._pool.records[slot];
        if (candidate.state !== STATE_PENDING || candidate.id !== id) continue; // stale queue entry — cancelled meanwhile

        if (candidate.requestVersion !== version) {
          // A rebuild happened while this request was queued — see file
          // header. Dropped silently: never attempted, not a refusal.
          this._pool.freeSlot(slot);
          continue;
        }

        solvesUsed++;
        if (!this._beginSolve(grid, candidate)) continue; // fast-failed, slot already freed
        rec = candidate;
      } else {
        solvesUsed++;
      }

      this._advanceSolve(grid, rec, NODE_CAP);
    }

    this._stats.pending = this._pendingTotal();

    if (stepIndex % STATS_WINDOW_STEPS === 0) {
      this._stats.solvedThisSecond = this._solvesThisWindow;
      this._solvesThisWindow = 0;
    }
  }

  /** Queued requests plus the one mid-search request, which the queue no
   * longer holds — `stats.pending`'s own contract. @returns {number} */
  _pendingTotal() {
    return this._pool.pendingCount + (this._activeId !== 0 ? 1 : 0);
  }

  /** The record of the suspended search, or `null` if there is none.
   * @returns {object|null} */
  _activeRecord() {
    if (this._activeId === 0) return null;
    return this._pool.records[(this._activeId - 1) % this._pool.capacity];
  }

  /** Releases the scratch if the suspended search was cancelled underneath
   * us, or was requested against a grid version that no longer exists (the
   * same version-stale drop a queued request gets, and equally not a
   * refusal). @param {number} version */
  _dropActiveIfStale(version) {
    if (this._activeId === 0) return;
    const slot = (this._activeId - 1) % this._pool.capacity;
    const rec = this._pool.records[slot];
    if (rec.id !== this._activeId || rec.state !== STATE_PENDING) {
      this._activeId = 0;
      return;
    }
    if (rec.requestVersion !== version) {
      this._pool.freeSlot(slot);
      this._activeId = 0;
    }
  }

  /**
   * Fast-fails or seeds the A* scratch for `rec` and takes ownership of it.
   * @param {object} grid @param {object} rec a PENDING record, version-checked already.
   * @returns {boolean} `false` if the request fast-failed (slot already freed).
   */
  _beginSolve(grid, rec) {
    const width = grid.width;
    const cost = grid.cost;
    const region = grid.region;

    const startIdx = cellIndexAt(grid, rec.fromX, rec.fromZ);
    const goalIdx = cellIndexAt(grid, rec.toX, rec.toZ);

    if (startIdx < 0 || goalIdx < 0 || cost[startIdx] >= RASTER.COST_BLOCKED || cost[goalIdx] >= RASTER.COST_BLOCKED) {
      this._pool.freeSlot(rec.poolIndex);
      return false;
    }
    const startRegion = region[startIdx];
    if (startRegion < 0 || startRegion !== region[goalIdx]) {
      // Unreachable goal — O(1) fast-fail, never expands a node. File header.
      this._pool.freeSlot(rec.poolIndex);
      return false;
    }

    this._currentGen++;
    const gen = this._currentGen;

    this._cellGen[startIdx] = gen;
    this._gScore[startIdx] = 0;
    this._cameFrom[startIdx] = -1;
    this._cellState[startIdx] = 1; // OPEN
    // HEURISTIC_WEIGHT-inflated priority key — see file header, "Heuristic
    // weighting". gScore (0 here) stays exact/unweighted.
    this._fScore[startIdx] = HEURISTIC_WEIGHT
      * octileHeuristic(startIdx % width, (startIdx / width) | 0, goalIdx % width, (goalIdx / width) | 0);

    this._activeId = rec.id;
    this._activeGen = gen;
    this._activeHeapSize = this._heapPush(0, startIdx);
    this._activeExpanded = 0;
    this._activeStartIdx = startIdx;
    this._activeGoalIdx = goalIdx;
    return true;
  }

  /**
   * Runs at most `allowance` expansions of the search `_beginSolve` seeded.
   * Resolves the request (SOLVED, or refused), or leaves it suspended for the
   * next step — see the file header, "A solve spans steps".
   * @param {object} grid @param {object} rec @param {number} allowance
   */
  _advanceSolve(grid, rec, allowance) {
    const width = grid.width;
    const height = grid.height;
    const cost = grid.cost;

    const gen = this._activeGen;
    const cellGen = this._cellGen;
    const gScore = this._gScore;
    const fScore = this._fScore;
    const cameFrom = this._cameFrom;
    const cellState = this._cellState;

    const startIdx = this._activeStartIdx;
    const goalIdx = this._activeGoalIdx;
    const goalCx = goalIdx % width;
    const goalCz = (goalIdx / width) | 0;

    // Whichever runs out first: this step's slot allowance, or what is left
    // of the request's lifetime ceiling.
    const budgetLeft = SOLVE_NODE_LIMIT - this._activeExpanded;
    const limit = allowance < budgetLeft ? allowance : budgetLeft;

    let heapSize = this._activeHeapSize;
    let expanded = 0;
    let foundGoal = false;

    while (heapSize > 0 && expanded < limit) {
      const current = this._heapPop(heapSize);
      heapSize--;
      cellState[current] = 2; // CLOSED
      expanded++;

      if (current === goalIdx) {
        foundGoal = true;
        break;
      }

      const ccx = current % width;
      const ccz = (current / width) | 0;

      for (let d = 0; d < 8; d++) {
        const nx = ccx + NEI_DX[d];
        const nz = ccz + NEI_DZ[d];
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        const nIdx = nz * width + nx;
        const nCost = cost[nIdx];
        if (nCost >= RASTER.COST_BLOCKED) continue;

        if (NEI_DIAGONAL[d]) {
          // No corner-cutting — both orthogonal neighbours shared by
          // (ccx,ccz) and (nx,nz) must themselves be walkable. File header.
          const orthoA = ccz * width + nx; // (nx, ccz)
          const orthoB = nz * width + ccx; // (ccx, nz)
          if (cost[orthoA] >= RASTER.COST_BLOCKED || cost[orthoB] >= RASTER.COST_BLOCKED) continue;
        }

        const known = cellGen[nIdx] === gen;
        if (known && cellState[nIdx] === 2) continue; // already CLOSED — consistent heuristic, never reopen

        const edgeCost = NEI_DIAGONAL[d] ? nCost * SQRT2 : nCost;
        const tentativeG = gScore[current] + edgeCost;

        if (!known || tentativeG < gScore[nIdx]) {
          cellGen[nIdx] = gen;
          gScore[nIdx] = tentativeG;
          cameFrom[nIdx] = current;
          // Same HEURISTIC_WEIGHT inflation as the start node above; tentativeG
          // (the real, exact cost) is unaffected.
          fScore[nIdx] = tentativeG + HEURISTIC_WEIGHT * octileHeuristic(nx, nz, goalCx, goalCz);
          if (!known || cellState[nIdx] !== 1) {
            cellState[nIdx] = 1; // OPEN
            heapSize = this._heapPush(heapSize, nIdx);
          } else {
            this._heapDecreaseKey(nIdx);
          }
        }
      }
    }

    this._activeHeapSize = heapSize;
    this._activeExpanded += expanded;

    if (!foundGoal) {
      // Out of THIS step's allowance but still searching: suspend, keep the
      // scratch, resume next step. Not a refusal — see the file header.
      if (heapSize > 0 && this._activeExpanded < SOLVE_NODE_LIMIT) return;
      this._finishSolve(rec, false);
      return;
    }

    if (!this._reconstructPath(grid, rec, cameFrom, startIdx, goalIdx, width)) {
      this._finishSolve(rec, false); // path longer than PATH_NODE_CAP — see there
      return;
    }
    this._finishSolve(rec, true);
  }

  /** Retires the active search: books its total expansion count into
   * `avgNodes`, releases the scratch, and either publishes the path or counts
   * the refusal 06 §9.1 asks for.
   * @param {object} rec @param {boolean} solved */
  _finishSolve(rec, solved) {
    this._totalNodesForAvg += this._activeExpanded;
    this._totalSolvesForAvg++;
    this._stats.avgNodes = this._totalNodesForAvg / this._totalSolvesForAvg;
    this._activeId = 0;

    if (solved) {
      this._solvesThisWindow++;
      rec.state = STATE_SOLVED;
      return;
    }
    this._stats.refusals++;
    this._pool.freeSlot(rec.poolIndex);
  }

  /** Walks `cameFrom` backward from `goalIdx` to `startIdx` into the shared
   * scratch buffer, then writes it forward (start -> goal) as world-space
   * `Vec3`s into `rec`'s own storage — baked in now so `pathNode` never
   * needs the grid again afterward (safe to read even past a later
   * `rebuild()`, per this file's header).
   * @returns {boolean} `false` if the path needs more than `PATH_NODE_CAP`
   *   nodes to write — a search may now expand past that (see the header),
   *   and a truncated path is worse than none. `rec` is left untouched. */
  _reconstructPath(grid, rec, cameFrom, startIdx, goalIdx, width) {
    const scratch = this._scratchCellPath;
    let idx = goalIdx;
    let count = 0;
    for (;;) {
      if (count >= PATH_NODE_CAP) return false;
      scratch[count++] = idx;
      if (idx === startIdx) break;
      idx = cameFrom[idx];
    }

    const originX = grid.originX;
    const originZ = grid.originZ;
    const cellSize = grid.cellSize;
    const groundY = grid.groundY;
    const nodesX = rec.nodesX;
    const nodesY = rec.nodesY;
    const nodesZ = rec.nodesZ;

    for (let k = 0; k < count; k++) {
      const cellIdx = scratch[count - 1 - k];
      const cx = cellIdx % width;
      const cz = (cellIdx / width) | 0;
      nodesX[k] = originX + (cx + 0.5) * cellSize;
      nodesZ[k] = originZ + (cz + 0.5) * cellSize;
      nodesY[k] = groundY[cellIdx];
    }
    rec.nodeCount = count;
    return true;
  }

  /** `02-api-contracts.md` §6: `pollPath(requestId) => PathHandle | null`. */
  pollPath(requestId) {
    if (!Number.isInteger(requestId) || requestId < 1) return null;
    const slot = (requestId - 1) % this._pool.capacity;
    const rec = this._pool.records[slot];
    if (rec.id !== requestId) return null; // stale/garbage id — file header bijection
    return rec.state === STATE_SOLVED ? rec : null;
  }

  /** `02-api-contracts.md` §6: `cancelPath(requestId) => void`. Safe no-op
   * on a stale/unknown/already-freed id (same discipline as
   * `physics.removeStatic`/`removeBody`). */
  cancelPath(requestId) {
    if (!Number.isInteger(requestId) || requestId < 1) return;
    const slot = (requestId - 1) % this._pool.capacity;
    const rec = this._pool.records[slot];
    if (rec.id !== requestId || rec.state === STATE_FREE) return;
    if (this._activeId === requestId) this._activeId = 0; // frees the A* scratch for the next search
    this._pool.freeSlot(slot);
    this._stats.pending = this._pendingTotal();
  }

  /** `02-api-contracts.md` §6: `releasePath(path) => void`. Safe no-op on a
   * handle this pool doesn't own, or one that is not currently `SOLVED`
   * (pending: use `cancelPath`; already released: a safe double-release
   * no-op, same as `ActorPool.release`/`removeStatic`). */
  releasePath(path) {
    if (!path) return;
    const slot = path.poolIndex;
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._pool.capacity) return;
    if (this._pool.records[slot] !== path) return;
    if (path.state !== STATE_SOLVED) return;
    this._pool.freeSlot(slot);
  }

  /** `02-api-contracts.md` §6: `pathNode(path,i,out?) => Vec3`. Out-of-range
   * `i` or a non-`SOLVED` handle reads back a zeroed `Vec3` rather than
   * throwing — matching this codebase's "stale handle -> safe default"
   * convention. `out` omitted -> the shared scratch (`02` §6's own `out`
   * convention: valid until the next call to THIS method). */
  pathNode(path, i, out) {
    const target = out || this._nodeScratch;
    if (!path || path.state !== STATE_SOLVED || !Number.isInteger(i) || i < 0 || i >= path.nodeCount) {
      target.x = 0;
      target.y = 0;
      target.z = 0;
      return target;
    }
    target.x = path.nodesX[i];
    target.y = path.nodesY[i];
    target.z = path.nodesZ[i];
    return target;
  }

  /** `02-api-contracts.md` §6: `pathLength(path) => int` — node count. `0`
   * for a missing/not-`SOLVED` handle. */
  pathLength(path) {
    if (!path || path.state !== STATE_SOLVED) return 0;
    return path.nodeCount;
  }
}
