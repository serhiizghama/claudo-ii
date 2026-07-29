// src/player/move.js
//
// PLYR-2 — path following and re-pathing (docs/spec/11-flows.md §3.4, the
// twelve-step "move order -> arrival" table; §3.7's failure table for the
// cases that overlap). `src/player/index.js` (PLYR-1) owns the intent latch,
// the ladder dispatch and the camera; this file owns everything downstream
// of "an order has a destination" — validating it, requesting/following a
// nav path, recovering from a blocked step, and clearing the order on
// arrival. `PlayerSystem.moveOrder`/`_followOrder`/`stop` are thin wiring
// into the `PathFollower` class below (see index.js's own PLYR-2 addendum
// for exactly what changed there).
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file — `src/player/` is not (yet) one of
// `tools/check-imports.mjs`'s N-surface roots (checked directly: it is not
// in that file's `declaredRoots` today, despite this ticket's brief saying
// otherwise — see this ticket's report), but PLYR-1's own file already holds
// itself to that bar voluntarily and there is no reason for this file to be
// the one that breaks it first.
//
// ---------------------------------------------------------------------------
// The nav.version === 0 gate — how this stays compatible with PLYR-1's own,
// already-accepted test suite
// ---------------------------------------------------------------------------
// `tests/player/plyr1.test.js` is not in this ticket's file list and must
// not be touched, yet it drives the real `boot()` (render+physics+actors+
// player) and expects the EXACT old PLYR-1 behaviour: an unconditional,
// unvalidated straight-line walk to wherever `moveOrder(x,z)` was called
// with. `boot()` never calls `world.enterZone()` (see `src/main.js`'s own
// B1-B13 stages — nothing there rasterises a real zone), so for that whole
// suite `nav.version` stays at its documented "never rebuilt" sentinel, `0`
// (`src/nav/index.js`'s own header). `NavSystem` itself is still registered
// and constructed (a real instance, not absent) — but its grid is the tiny
// `PLACEHOLDER_CELLS` (4x4 cells @ 0.5 m) box at the origin, not a real
// zone's geometry, and validating a click against it would `nav.snap()`-fail
// or `nav.connected()`-fail unpredictably depending on where the click
// happened to land, silently breaking that already-accepted suite.
//
// `nav.version === 0` is the one honest, already-documented signal for
// "nothing real has been rasterised yet" (as opposed to "nav is absent",
// which does not apply here — nav always exists once registered). Gating
// the whole snap/connected/requestPath pipeline behind `nav.version > 0` and
// falling back to the exact old unconditional-direct-move behaviour when it
// is still `0` is what makes `tests/player/plyr1.test.js` keep passing
// byte-for-bit while a real zone (this ticket's own tests, which call
// `nav.rebuild()` against the test map first) gets the full §3.4 pipeline.
// This is not a spec-mandated gate — it is how this ticket avoided
// regressing an already-accepted ticket's tests it has no permission to
// edit. Flagged in the report as the resolved ambiguity it is.
//
// ---------------------------------------------------------------------------
// The missing nav.raycastNav — guarded, not faked
// ---------------------------------------------------------------------------
// `11-flows.md` §3.4 step 3 and §3.5's "cheap branch" both lean on
// `nav.raycastNav(ax,az,bx,bz)`, listed in `02-api-contracts.md` §6 but never
// implemented by any landed NAV ticket (NAV-3 built the equivalent privately
// as `segmentWalkable` in `src/nav/smooth.js`, but that is `nav`'s own
// internal helper — hard rule 2 forbids importing it, or anything else
// under `src/nav/`, directly). `_tryFastPath` below is a `typeof
// nav.raycastNav === 'function'` guard: when a future NAV ticket adds it,
// this file picks it up automatically, with no edit here. Until then every
// order falls through to `_requestFreshPath` — a full path is requested
// even for a one-metre click. Skipping the optimisation only ever costs a
// few extra A* solves (well inside the 4/step budget for a single player);
// pretending an unverified line is clear is what would actually risk a
// wedge. See the report for this called out explicitly.
//
// ---------------------------------------------------------------------------
// The mode state machine
// ---------------------------------------------------------------------------
// One `PathFollower` per `PlayerSystem`, constructed once, reused for every
// order — no per-order allocation (every scratch `Vec3` is a constructor
// field, rule 5/6). Four modes, exactly the branches §3.4 describes:
//
//   MODE_DIRECT       straight-line steering with no path at all. Reached by
//                      the (currently dark) raycastNav fast path, by the
//                      nav.version===0 fallback above, and permanently once
//                      a budget-refused order exhausts its 12 retries (step
//                      5's "after 12 refusals, keep steering").
//   MODE_PENDING      a `requestPath` id is outstanding; polling every step.
//   MODE_FOLLOWING    a solved, smoothed `PathHandle` is held; steering node
//                      by node.
//   MODE_BUDGET_RETRY requestPath returned 0 (the 4/step budget was full);
//                      steering straight while retrying, per step 5.
//
// `step()` is the only per-fixed-step entry point and dispatches on the
// current mode; every mode's own `_step*` method both steers the actor AND
// decides whether to transition (pending -> following, budget-retry ->
// pending, any mode's blocked-streak -> a fresh request, following's stale
// version -> a fresh request, either terminal mode's arrival -> idle).
//
// ---------------------------------------------------------------------------
// Blocked-streak repathing — the primary anti-wedge mechanism (step 10)
// ---------------------------------------------------------------------------
// `actors.moveTo` returns `MoveResult.blocked` whenever `physics.moveBody`'s
// depenetration loop had to push the body out along a static normal that
// step — which includes ordinary sliding contact along a wall the actor is
// walking parallel to, not only a dead stop (see `src/physics/body.js`'s own
// `moveBody`: `blocked` and `slid` can both be true in the same result). The
// spec's own criterion checks `.blocked` alone ("moveTo returns
// MoveResult.blocked. Three consecutive blocked steps -> repath"), so this
// file does too — a spurious repath triggered by three steps of ordinary
// wall-hugging is cheap (one more A* solve) and never wrong; a wedge that
// this mechanism fails to catch is the actual failure mode `docs/BACKLOG.md`
// names this ticket against. Tracked with ONE shared counter across every
// mode (not per-mode) — a corner-stick grinding against geometry is exactly
// as real whether the actor got there via a solved path, a budget-retry
// straight line, or the (dark) direct fast path.
//
// The repath itself (`_repathFromCurrent`) does two things a plain
// `requestPath(actor.x, actor.z, ...)` would not:
//   1. Snaps the FROM point (`nav.snap`, small radius — see
//      `REPATH_FROM_CURRENT_SNAP_RADIUS_M`'s own comment) before requesting.
//      A body that was just pushed out of geometry by `moveBody`'s
//      depenetration loop is guaranteed clear of the PHYSICS collider, but
//      nav's own walkability grid is a coarser, independently-dilated 0.5 m
//      raster — a point a few centimetres clear of the wall by the physics
//      engine's math can still round into a `COST_BLOCKED` cell at grid
//      quantisation. `astar.js#_solveOne` fast-fails (frees the request slot
//      without ever solving) when the START cell itself is blocked, which
//      would otherwise make `pollPath` return `null` forever for exactly the
//      corner-stick case this mechanism exists to fix. Snapping the FROM
//      point first is what keeps that from happening.
//   2. Re-checks `nav.connected` before requesting — if the grid changed out
//      from under a long-running order (a version bump) badly enough that
//      the destination is no longer reachable at all, this drops the order
//      (§3.7's own "destination in another region -> unreachable") instead
//      of looping a repath forever against an impossible goal.
//
// ---------------------------------------------------------------------------
// PathHandle lifetime — why nothing here can leak one
// ---------------------------------------------------------------------------
// Every place this file stops holding a `PathHandle` or an outstanding
// `requestId` funnels through `_releaseNavResources`, and every place a NEW
// one is about to be held calls it FIRST:
//   - `beginOrder` — a fresh order supersedes whatever the previous one held.
//   - `_repathFromCurrent` — the blocked-streak/stale-version/pending-timeout
//     repath, all three call sites.
//   - `_onArrive` — step 12's own `nav.releasePath(path)`.
//   - `cancel` — `stop()`/a dropped order/`PlayerSystem.dispose()`.
// `_releasePath`/`cancelPath` are both documented safe no-ops on an
// already-released/cancelled or stale handle (`src/nav/astar.js`'s own
// header), so calling `_releaseNavResources` from a mode that holds neither
// (e.g. `MODE_DIRECT`, which holds nothing) costs nothing and is never
// wrong. There is no code path that assigns `this._path`/`this._requestId`
// without a `_releaseNavResources()` call immediately before it in the same
// function.
//
// ---------------------------------------------------------------------------
// Numbers — every one cited (rule 6: gameplay numbers live in data / are
// named and marked ASSIGNED)
// ---------------------------------------------------------------------------
// `DESTINATION_SNAP_RADIUS_M` (2.0), `WAYPOINT_ADVANCE_RADIUS_M` (0.35),
// `FACE_TURN_RATE_DEG_PER_SEC` (720), `BUDGET_RETRY_MAX_STEPS` (12),
// `BLOCKED_STREAK_REPATH_THRESHOLD` (3) are all verbatim from
// `11-flows.md` §3.4 (cited on each constant below). `ARRIVE_RADIUS_MIN_M` /
// `ARRIVE_RADIUS_FACTOR` are §3.4 step 12's formula, moved here from
// `src/player/index.js` (re-exported from there unchanged — see that file's
// PLYR-2 addendum) because `computeArriveRadius` is now this file's own
// concern. `REPATH_FROM_CURRENT_SNAP_RADIUS_M` and
// `PENDING_SOLVE_TIMEOUT_STEPS` are ASSIGNED — no spec table gives either;
// see their own comments for the reasoning.

const DEG2RAD = Math.PI / 180;

/** Metres. `11-flows.md` §3.4 step 1, verbatim: `nav.snap(moveX, moveZ, 2.0,
 * out)`. */
export const DESTINATION_SNAP_RADIUS_M = 2.0;

/** Metres. `11-flows.md` §3.4 step 8: "advance i when within 0.35 m". */
export const WAYPOINT_ADVANCE_RADIUS_M = 0.35;

/** Degrees/second. `11-flows.md` §3.4 step 8: `actors.face(actor, nx, nz,
 * 720°/s)`. Converted to radians/second once at module load —
 * `actors.face`'s real signature takes radians/second (see
 * `src/actors/motion.js`'s own "face" section). */
export const FACE_TURN_RATE_DEG_PER_SEC = 720;
const FACE_TURN_RATE_RAD_PER_SEC = FACE_TURN_RATE_DEG_PER_SEC * DEG2RAD;

/** Steps. `11-flows.md` §3.4 step 5: "Retry every step for 12 steps (0.2 s)
 * ... after 12 refusals, keep steering." */
export const BUDGET_RETRY_MAX_STEPS = 12;

/** Consecutive `MoveResult.blocked` steps. `11-flows.md` §3.4 step 10:
 * "Three consecutive blocked steps -> repath once from the current
 * position." See the file header, "Blocked-streak repathing", for why this
 * counter is shared across every mode rather than reset per-mode. */
export const BLOCKED_STREAK_REPATH_THRESHOLD = 3;

/** Metres. ASSIGNED — no spec value exists for "how far to search for a
 * walkable point around the actor's OWN current position when repathing
 * after a blocked streak". Deliberately smaller than the destination snap
 * radius (2.0 m, step 1): that one validates an arbitrary raw click; this
 * one recovers a point the actor was already standing on or immediately
 * adjacent to a moment ago (it was walking normally right up until the
 * blocked streak began), so a small radius is both sufficient and safer —
 * a large one risks silently restarting the path from somewhere the player
 * never actually stood. See the file header's "Blocked-streak repathing"
 * section for why the FROM point needs snapping at all. */
export const REPATH_FROM_CURRENT_SNAP_RADIUS_M = 1.0;

/** Steps. ASSIGNED — no spec value exists for "how long to wait on a
 * `pollPath` before giving up and retrying". `02-api-contracts.md` §6
 * documents the normal turnaround as "typically 1-3 steps"; this is
 * comfortably past that (5x the documented worst case) while still being
 * far short of anything a player could perceive as a stall (15 steps =
 * 0.25 s at 60 Hz) or long enough to look like a corner-stick's "sustained
 * window of no progress" in this ticket's own 200-run harness. Exists only
 * to recover from the one case a normal poll never resolves at all: a
 * `nav:rebuilt` version bump lands between `requestPath` and the solve,
 * which makes `astar.js#runSolves` silently drop the request
 * (`rec.requestVersion !== version`) without ever marking it `SOLVED` — see
 * that file's own comment at the drop site. */
export const PENDING_SOLVE_TIMEOUT_STEPS = 15;

/** Metres. `11-flows.md` §3.4 step 12, verbatim formula:
 * `arriveRadius = max(0.25, actor.radius * 0.6)`. Moved here from
 * `src/player/index.js` (PLYR-1) — see that file's PLYR-2 addendum; it
 * re-exports `computeArriveRadius` from here unchanged so
 * `tests/player/plyr1.test.js`'s own import keeps working. */
export const ARRIVE_RADIUS_MIN_M = 0.25;
export const ARRIVE_RADIUS_FACTOR = 0.6;

/**
 * `11-flows.md` §3.4 step 12's arrival-radius formula. See
 * `ARRIVE_RADIUS_MIN_M`'s own comment for why this lives here now.
 * @param {{radius:number}} actor
 * @returns {number}
 */
export function computeArriveRadius(actor) {
  const scaled = actor.radius * ARRIVE_RADIUS_FACTOR;
  return scaled > ARRIVE_RADIUS_MIN_M ? scaled : ARRIVE_RADIUS_MIN_M;
}

const MODE_NONE = 0;
const MODE_DIRECT = 1;
const MODE_PENDING = 2;
const MODE_FOLLOWING = 3;
const MODE_BUDGET_RETRY = 4;

/**
 * One per `PlayerSystem`. Every method takes `nav`/`actors`/`actor` as plain
 * duck-typed arguments (never `ctx`) — the same convention
 * `src/actors/motion.js` already established, and what keeps this file
 * testable in isolation with hand-built fakes (see `tests/player/plyr2.test.js`).
 */
export class PathFollower {
  constructor() {
    this._active = false;
    this._mode = MODE_NONE;

    this._destX = 0;
    this._destZ = 0;

    this._requestId = 0;
    this._path = null;
    this._pathIndex = 0;
    this._pathVersionAtSolve = -1;

    this._blockedStreak = 0;
    this._budgetRefusalStreak = 0;
    this._pendingWaitSteps = 0;

    // Zero-allocation scratch (rule 5/6) — built once, reused by every call.
    this._destSnapScratch = { x: 0, y: 0, z: 0 };
    this._fromSnapScratch = { x: 0, y: 0, z: 0 };
    this._nodeScratch = { x: 0, y: 0, z: 0 };
  }

  /** `true` while an order is in flight (requested, pending, following, or
   * steering direct/budget-retry) — `false` once arrived, dropped as
   * unreachable, or explicitly cancelled. */
  get active() {
    return this._active;
  }

  /**
   * Begins a brand-new order toward `(rawX, rawZ)`. Releases/cancels
   * whatever the PREVIOUS order was holding first (a new order always
   * supersedes, never leaks — see the file header). Returns `false` when the
   * order was dropped (§3.4 steps 1-2 / §3.7: unreachable), in which case
   * `active` is left `false` and the caller (`PlayerSystem.moveOrder`) should
   * treat the order as never having started.
   * @param {object} nav `ctx.get('nav')`'s instance.
   * @param {object} actor the live player `Actor`.
   * @param {number} rawX @param {number} rawZ
   * @returns {boolean}
   */
  beginOrder(nav, actor, rawX, rawZ) {
    this._releaseNavResources(nav);
    this._blockedStreak = 0;
    this._budgetRefusalStreak = 0;
    this._pendingWaitSteps = 0;

    // See the file header, "The nav.version === 0 gate".
    if (!nav || nav.version === 0) {
      this._active = true;
      this._mode = MODE_DIRECT;
      this._destX = rawX;
      this._destZ = rawZ;
      return true;
    }

    // Step 1: validate the destination.
    const snapped = nav.snap(rawX, rawZ, DESTINATION_SNAP_RADIUS_M, this._destSnapScratch);
    if (snapped === null) {
      this._active = false;
      this._mode = MODE_NONE;
      return false;
    }

    // Step 2: reject an unreachable destination.
    if (!nav.connected(actor.x, actor.z, snapped.x, snapped.z)) {
      this._active = false;
      this._mode = MODE_NONE;
      return false;
    }

    this._destX = snapped.x;
    this._destZ = snapped.z;
    this._active = true;
    this._pathVersionAtSolve = -1;
    this._startTowardDest(nav, actor);
    return true;
  }

  /** Cancels the current order (§3.2 priority 3 / `stop()`), releasing any
   * nav resources it held. A safe no-op with no order active. */
  cancel(nav) {
    this._releaseNavResources(nav);
    this._active = false;
    this._mode = MODE_NONE;
  }

  /**
   * Advances the current order by one fixed step. No-op when `!active`.
   * @param {number} h the fixed step (`FIXED_DT`) — never `ctx.time.dt`.
   * @param {object} nav
   * @param {object} actors `ctx.get('actors')`'s instance.
   * @param {object} actor
   */
  step(h, nav, actors, actor) {
    if (!this._active) return;

    // §3.7: "Dead -> order cleared". `actor.dead` is always `false` today —
    // no combat/status system exists yet to ever set it — kept so a future
    // ticket's landing engages this automatically, matching the `typeof`
    // guards `src/player/index.js` (PLYR-1) already uses for the same
    // not-yet-built-subsystem reason.
    if (actor.dead) {
      this.cancel(nav);
      return;
    }
    // §3.7: "Frozen or stunned -> actors.canMove -> false. The order is
    // KEPT, not cancelled." `actors.canMove` does not exist yet (ACTR-9/10);
    // guarded the same way.
    if (typeof actors.canMove === 'function' && !actors.canMove(actor)) return;

    // Step 11: never hold a PathHandle across a version bump.
    if (this._mode === MODE_FOLLOWING && this._pathVersionAtSolve !== nav.version) {
      this._repathFromCurrent(nav, actor);
      if (!this._active) return; // repath found the order no longer reachable
    }

    switch (this._mode) {
      case MODE_PENDING:
        this._stepPending(nav, actor);
        return;
      case MODE_BUDGET_RETRY:
        this._stepBudgetRetry(h, nav, actors, actor);
        return;
      case MODE_FOLLOWING:
        this._stepFollowing(h, nav, actors, actor);
        return;
      case MODE_DIRECT:
        this._stepDirect(h, nav, actors, actor);
        return;
      default:
        return;
    }
  }

  // ─── internals ───────────────────────────────────────────────────────

  /** Step 3 (guarded — see the file header) then step 4: try the fast path,
   * else request a fresh solve from the actor's own current position.
   * @private
   */
  _startTowardDest(nav, actor) {
    if (typeof nav.raycastNav === 'function' && nav.raycastNav(actor.x, actor.z, this._destX, this._destZ)) {
      this._mode = MODE_DIRECT;
      return;
    }
    this._requestFreshPath(nav, actor.x, actor.z, actor.id);
  }

  /** Step 4/5: request a path from `(fromX, fromZ)` to the current
   * destination. `0` (budget full) enters the retry mode; a real id enters
   * pending. Never blocks either way.
   * @private
   */
  _requestFreshPath(nav, fromX, fromZ, ownerId) {
    const id = nav.requestPath(fromX, fromZ, this._destX, this._destZ, ownerId);
    if (id === 0) {
      this._mode = MODE_BUDGET_RETRY;
      this._budgetRefusalStreak = 1;
    } else {
      this._mode = MODE_PENDING;
      this._requestId = id;
      this._pendingWaitSteps = 0;
    }
  }

  /** Step 6: poll. Resolves into `MODE_FOLLOWING` (smoothing once, per step
   * 7) or waits, with `PENDING_SOLVE_TIMEOUT_STEPS`'s own safety net against
   * a request the solver silently dropped (see that constant's comment).
   * Deliberately does not steer while pending — the normal 1-3 step wait is
   * imperceptible at 60 Hz and steering blind into an unresolved path risks
   * exactly the false blocked-streak this file otherwise avoids.
   * @private
   */
  _stepPending(nav, actor) {
    const path = nav.pollPath(this._requestId);
    if (path) {
      this._requestId = 0;
      this._path = path;
      this._pathIndex = 0;
      this._pathVersionAtSolve = nav.version;
      this._blockedStreak = 0;
      nav.smooth(path); // step 7
      this._mode = MODE_FOLLOWING;
      return;
    }

    this._pendingWaitSteps++;
    if (this._pendingWaitSteps > PENDING_SOLVE_TIMEOUT_STEPS) {
      this._pendingWaitSteps = 0;
      // Shares `_repathFromCurrent`'s own snap-then-connect logic (see that
      // method's own comment) rather than repeating a naive
      // `nav.connected(actor.x, actor.z, ...)` here — the actor's raw
      // position is exactly as likely to round into a blocked nav cell in
      // this branch as in the blocked-streak one.
      this._repathFromCurrent(nav, actor);
    }
  }

  /** Step 5's retry loop: try the request again every step, up to
   * `BUDGET_RETRY_MAX_STEPS`; steer straight at the (already-validated)
   * destination meanwhile, every step, budget or no budget. After the cap,
   * stops calling `requestPath` (the spec's own "keep steering", not
   * "keep retrying forever") but a later blocked-streak can still trigger a
   * fresh attempt via `_repathFromCurrent`, which is not subject to this cap.
   * @private
   */
  _stepBudgetRetry(h, nav, actors, actor) {
    // `<`, not `<=`: `_budgetRefusalStreak` already counts the FIRST refused
    // attempt (set to 1 by `_requestFreshPath`), so this allows exactly
    // `BUDGET_RETRY_MAX_STEPS` total requestPath calls before stopping — the
    // literal "retry every step for 12 steps" the spec asks for, not 13.
    if (this._budgetRefusalStreak < BUDGET_RETRY_MAX_STEPS) {
      const id = nav.requestPath(actor.x, actor.z, this._destX, this._destZ, actor.id);
      if (id !== 0) {
        this._mode = MODE_PENDING;
        this._requestId = id;
        this._pendingWaitSteps = 0;
        this._budgetRefusalStreak = 0;
      } else {
        this._budgetRefusalStreak++;
      }
    }
    this._steerDirectStep(h, nav, actors, actor);
  }

  /** The (currently dark, see the file header) raycastNav fast path, and the
   * permanent fallback once budget retries are exhausted: straight-line
   * steering with no path at all.
   * @private
   */
  _stepDirect(h, nav, actors, actor) {
    this._steerDirectStep(h, nav, actors, actor);
  }

  /** Shared by `MODE_DIRECT` and `MODE_BUDGET_RETRY`: arrival check against
   * the destination directly (there is no path node to arrive at), else one
   * step of straight-line movement, tracked for the blocked-streak repath.
   * @private
   */
  _steerDirectStep(h, nav, actors, actor) {
    const arriveR = computeArriveRadius(actor);
    const dx = this._destX - actor.x;
    const dz = this._destZ - actor.z;
    const dist = Math.sqrt(dx * dx + dz * dz); // rule 5: never Math.hypot
    if (dist <= arriveR) {
      this._onArrive(nav, actors, actor);
      return;
    }
    const result = moveOneStep(h, actors, actor, this._destX, this._destZ, dist);
    this._trackBlocked(result ? result.blocked : false, nav, actor);
  }

  /** Steps 7-10: follow the smoothed path node by node, advancing at
   * `WAYPOINT_ADVANCE_RADIUS_M` and arriving (step 12) at `arriveRadius` of
   * the FINAL node — not of the raw destination; see the file header's
   * citation for `computeArriveRadius`'s own role here vs step 8's separate
   * 0.35 m advance threshold.
   * @private
   */
  _stepFollowing(h, nav, actors, actor) {
    const path = this._path;
    const len = nav.pathLength(path);
    if (len === 0) {
      // The handle was invalidated out from under us (freed/stale) without
      // the version-bump check above catching it — not a documented case,
      // but "never a stall" applies here too. See the report.
      this._repathFromCurrent(nav, actor);
      return;
    }

    while (this._pathIndex < len - 1) {
      nav.pathNode(path, this._pathIndex, this._nodeScratch);
      const dx = this._nodeScratch.x - actor.x;
      const dz = this._nodeScratch.z - actor.z;
      if (Math.sqrt(dx * dx + dz * dz) <= WAYPOINT_ADVANCE_RADIUS_M) {
        this._pathIndex++;
      } else {
        break;
      }
    }

    const isLast = this._pathIndex >= len - 1;
    nav.pathNode(path, this._pathIndex, this._nodeScratch);
    const nodeX = this._nodeScratch.x;
    const nodeZ = this._nodeScratch.z;

    if (isLast) {
      const arriveR = computeArriveRadius(actor);
      const dx = nodeX - actor.x;
      const dz = nodeZ - actor.z;
      if (Math.sqrt(dx * dx + dz * dz) <= arriveR) {
        this._onArrive(nav, actors, actor);
        return;
      }
    }

    const dx = nodeX - actor.x;
    const dz = nodeZ - actor.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const result = moveOneStep(h, actors, actor, nodeX, nodeZ, dist);
    this._trackBlocked(result ? result.blocked : false, nav, actor);
  }

  /** Step 10's counter, shared across every mode — see the file header. On
   * threshold, repaths once and resets to zero regardless of outcome (a
   * fresh streak starts counting from the new mode).
   * @private
   */
  _trackBlocked(blocked, nav, actor) {
    if (!blocked) {
      this._blockedStreak = 0;
      return;
    }
    this._blockedStreak++;
    if (this._blockedStreak >= BLOCKED_STREAK_REPATH_THRESHOLD) {
      this._blockedStreak = 0;
      this._repathFromCurrent(nav, actor);
    }
  }

  /** The anti-wedge repath: release whatever is held, snap the FROM point,
   * re-validate reachability FROM THAT SNAPPED POINT, request fresh. Drops
   * the order if the destination is no longer reachable at all rather than
   * looping forever. Used by the blocked-streak trigger, the stale-version
   * trigger (step 11), and the pending-timeout safety net.
   *
   * Snap BEFORE checking connectivity, never the other way around — found
   * in testing (this ticket's 200-run harness, before this fix): a body
   * `moveBody` just pushed out of a wall is guaranteed clear by the PHYSICS
   * collider's own math, but can still land in a cell nav's coarser,
   * independently-dilated 0.5 m raster calls blocked (`nav.walkable`
   * false, `nav.regionAt` -1 — see this file's header, "Blocked-streak
   * repathing", point 1). `nav.connected(rawX, rawZ, ...)` against a point
   * with `regionAt === -1` is trivially false — it can never equal any real
   * region — so checking connectivity from the RAW position drops a
   * perfectly reachable order as "unreachable" the instant the actor is
   * standing a few centimetres inside a wall's dilation band, which is
   * exactly when this repath is being asked to help. Snapping first gives
   * `connected` a point nav itself considers walkable to reason from.
   * @private
   */
  _repathFromCurrent(nav, actor) {
    this._releaseNavResources(nav);

    if (nav.version === 0) {
      // Should not happen once a real order has reached this point (the
      // version-0 gate keeps such orders in MODE_DIRECT forever, which never
      // calls this) — guarded anyway rather than assumed.
      this._mode = MODE_DIRECT;
      return;
    }

    const snapped = nav.snap(actor.x, actor.z, REPATH_FROM_CURRENT_SNAP_RADIUS_M, this._fromSnapScratch);
    const fromX = snapped !== null ? snapped.x : actor.x;
    const fromZ = snapped !== null ? snapped.z : actor.z;

    if (!nav.connected(fromX, fromZ, this._destX, this._destZ)) {
      this._active = false;
      this._mode = MODE_NONE;
      return;
    }

    this._requestFreshPath(nav, fromX, fromZ, actor.id);
  }

  /** Step 12: release, clear, idle. See the file header, "PathHandle
   * lifetime", for why this is always reached through this one method.
   * @private
   */
  _onArrive(nav, actors, actor) {
    this._releaseNavResources(nav);
    this._active = false;
    this._mode = MODE_NONE;
    // `actors.setState` does not exist yet (no ACTR ticket has shipped the
    // action state machine) — guarded exactly like `src/player/index.js`
    // (PLYR-1) already guards the same call.
    if (typeof actors.setState === 'function') actors.setState(actor, 'idle');
  }

  /** Releases/cancels whatever nav resources this instance currently holds.
   * Always safe to call (both `cancelPath`/`releasePath` are documented
   * no-ops on a stale/absent/already-freed handle — `src/nav/astar.js`'s own
   * header) and always called before this instance starts holding a new
   * one — see the file header, "PathHandle lifetime".
   * @private
   */
  _releaseNavResources(nav) {
    if (nav) {
      if (this._requestId) nav.cancelPath(this._requestId);
      if (this._path) nav.releasePath(this._path);
    }
    this._requestId = 0;
    this._path = null;
    this._pathIndex = 0;
  }
}

/**
 * One step of straight-line movement toward `(targetX, targetZ)`, clamped so
 * it never overshoots (no orbiting/oscillation around a waypoint — the same
 * discipline PLYR-1's own original `_followOrder` already established).
 * Turns via `actors.face` (step 8's 720°/s) before moving. Returns `null`
 * (no `moveTo` call at all) when already at the target, so a caller never
 * has to special-case a zero-length move.
 * @param {number} h
 * @param {object} actors
 * @param {object} actor
 * @param {number} targetX @param {number} targetZ
 * @param {number} dist precomputed distance to `(targetX, targetZ)` — every
 *   call site already has it for its own arrival check, so this never
 *   recomputes it.
 * @returns {{blocked:boolean}|null}
 */
function moveOneStep(h, actors, actor, targetX, targetZ, dist) {
  if (dist <= 1e-9) return null;

  actors.face(actor, targetX, targetZ, FACE_TURN_RATE_RAD_PER_SEC);

  const speed = actors.moveSpeed(actor); // step 9
  const stepDist = speed * h;
  const moveDist = stepDist < dist ? stepDist : dist;
  const inv = 1 / dist;
  return actors.moveTo(actor, (targetX - actor.x) * inv * moveDist, (targetZ - actor.z) * inv * moveDist);
}
