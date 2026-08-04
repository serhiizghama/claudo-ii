// src/ai/nav.js
//
// AI-4 — `06-monsters-ai.md` §9 in full: the ring scheduler (§9.2), the
// flow-field-vs-A* default (§9.3), the >40-active hard demotion, the
// 12-step/2.0 m flow-field rebuild cadence (§9.1), and `nav:rebuilt`
// invalidation with the `i % 45` spread (§9.4). `./index.js` wires this in
// (a new import, a `nav:rebuilt` listener, one call from `fixedUpdate`,
// `stats` reading real numbers instead of AI-2's hardcoded zeroes) — no
// change to `spawnOne`/`brainOf`/`aliveCount`, per this ticket's own grant.
//
// ---------------------------------------------------------------------------
// Scope: scheduling and bookkeeping, not steering — a real, flagged decision
// ---------------------------------------------------------------------------
// AI-2's `./brains/melee.js` (chase: `moveTowards`, direct steering, no nav)
// and AI-3's `./perception.js` (`stepLeashReturn`: direct steering to the
// pack centre, no nav either) are BOTH off-limits to this ticket's file
// list. Neither file is touched here, and neither is taught that this
// module exists. What this ticket actually builds is the budget/scheduler
// layer `06` §9 describes: `needsPath`, the ring, the flow-field cadence,
// the demotion rule, and version invalidation — the machinery that decides
// WHICH brains get a real `nav.requestPath()` this step and which are
// marked `useFlowField`. A `PathHandle`, once confirmed `SOLVED` (via
// `pollPath`), is released immediately (`nav.releasePath`) rather than held
// across steps and walked — there is no consumer for it in this ticket's
// file list (walking a path is steering, and steering lives in the two
// files above). This is sufficient for every acceptance criterion this
// ticket carries (MB12/MB13, the >40 demotion, `flowUsers`, the `i % 45`
// spread) — none of them requires an actor to actually move along a solved
// path — but it is real, load-bearing, unfinished work for whichever
// AI-5+ ticket teaches `melee.js`/`perception.js` to walk a `PathHandle`
// this module already knows how to obtain. Flagged here, not routed around
// — see the report.
//
// ---------------------------------------------------------------------------
// MB12's denominator — what `nav.stats.refusals` actually counts (read
// directly off `src/nav/astar.js`, not assumed)
// ---------------------------------------------------------------------------
// `nav.stats.refusals` increments in exactly one place: `AStarScheduler
// #_solveOne`, when a solve exhausts `NODE_CAP` (1200 nodes) without
// reaching the goal. It does NOT increment for:
//   - a per-step ring-budget refusal (`requestPath` returning 0 because
//     `_acceptedThisStep >= budget`, or the 64-slot request pool is dry) —
//     that is THIS file's own `pathRefusals` counter (`ai.stats.pathRefusals`,
//     a different, contracted field), not `nav.stats.refusals`;
//   - a fast-fail rejection inside `_solveOne` itself (off-grid, blocked, or
//     a different region than the goal) — freed in O(1), never touches the
//     heap, never counted anywhere;
//   - a request whose `requestVersion` no longer matches `nav.version` when
//     `runSolves` dequeues it (a rebuild happened mid-flight) — dropped
//     silently, `astar.js`'s own header: "never attempted, not a refusal."
// `nav.stats` also exposes no lifetime "solved" counter at all —
// `avgNodes`'s internal `_totalSolvesForAvg` denominator is private and
// counts refusals AND successes together, so it cannot stand in for MB12's
// "solved" term either.
//
// MB12 asks for `nav.stats.refusals / (refusals + solved)`. Since `nav`
// exposes neither a public "solved" counter nor a way to distinguish the
// three silent-failure buckets above from a genuine in-flight pending
// request, this file computes "solved" itself, the only way available to a
// caller: `store.solved` increments exactly when THIS module's own
// `pollPath` call on a request IT issued returns a real, `SOLVED` handle
// (Pass 1 below). Combined with `nav.stats.refusals` (a delta over the
// measurement window), the ratio this ticket's tests report is
// `nav.stats.refusals / (nav.stats.refusals + store.solved)` — which
// answers MB12's literal question CORRECTLY as long as `nav` has no other
// concurrent caller during the window (true for this ticket's own
// simulation: `ai` is `nav`'s only `requestPath` caller by contract, `02
// -api-contracts.md` §6's own "Forbidden for callers" list). What it does
// NOT do is account for the fast-fail/version-drop buckets above: a request
// lost that way is invisible to BOTH terms of the ratio (neither refused
// nor solved, from `nav`'s point of view). In this ticket's own 600 s
// simulation (one zone, no mid-run rebuild, every goal in the same
// connected region as its requester) neither bucket is expected to fire —
// but this is a real, reported gap in what the metric can see, not a
// silent assumption. See the report.
//
// ---------------------------------------------------------------------------
// A gap this ticket had to fill: a pending request that never resolves
// ---------------------------------------------------------------------------
// `06` §9.2's own `needsPath` pseudocode has no term for "a request is
// already in flight for this brain" — read literally, `b.path === null`
// stays true from the moment a request is ACCEPTED (only `pathRequestId`
// and `repathAtStep` are written at grant time) until it is actually
// solved, which would make the very next step's `needsPath` true again and
// re-request a SECOND path for the same brain while the first is still
// pending. This file adds the missing guard (`pendingRequestId !== 0`
// blocks `needsPath`) rather than double-book a brain every step it has an
// outstanding request — `pollPath` typically resolves within 1–3 steps
// (`02-api-contracts.md` §6's own words), so the guard's window is short.
// The complementary half: a request that is refused/dropped the silent way
// (see above) never resolves, so `pendingRequestId` would otherwise pin a
// brain out of the scheduler forever. `PENDING_TIMEOUT_STEPS` (10, well
// past nav's documented 1–3-step typical resolution) clears it so
// `needsPath` can retry. Neither of these is invented behaviour dressed up
// as spec — both are flagged here and in the report as this ticket's own,
// necessary fill of a real gap in the verbatim pseudocode.
//
// ---------------------------------------------------------------------------
// The cached `flowDistance` — a generation stamp, not a `Map`
// ---------------------------------------------------------------------------
// `cachedFlowDistance` below stamps a per-brain cached value with BOTH the
// fixed step it was read on and `nav.flowVersion` at that moment — a
// mismatch on either forces a fresh `nav.flowDistance()` read, the same
// "generation × slot, mismatch means absent" idiom this codebase already
// uses for `actor.cooldowns`/rage credit/buff slots (this ticket's brief
// names it explicitly and forbids inventing a fifth variant). Stamping on
// `step` as well as `flowVersion` is deliberate: `flowVersion` alone changes
// only once every 12 steps (the field's own rebuild cadence), while a
// brain's `(x, z)` moves every step — caching on `flowVersion` alone would
// silently serve a stale (wrong-position) distance for up to 11 steps out
// of every 12. Stamping on `step` too means the cache never serves a value
// older than the current step, so it is always correct; what the
// `flowVersion` stamp actually buys is the literal, testable guarantee this
// ticket's criterion 4 asks for ("`flowVersion` invalidates a cached
// distance") without ever being able to go stale in between. In this
// module's own call pattern there is exactly one `flowDistance` read per
// brain per step (Pass 1, chase brains targeting the player), so the
// within-step de-dup this cache would also provide never actually fires
// today — reported plainly, not silently claimed as a performance win.
//
// ---------------------------------------------------------------------------
// `i` in `nav:rebuilt`'s `i % 45` spread — `poolIndex`, not a dense re-count
// ---------------------------------------------------------------------------
// `06` §9.4's pseudocode walks "brains" with an index `i` it never defines
// precisely (a dense 0..brainCount-1 re-enumeration, or each brain's own
// stable slot?). This file uses `actor.poolIndex` directly: it is already a
// stable, spec-legal per-brain ordinal (no new counter to build or keep in
// sync), and `06` §9.4's own point — spreading a synchronous invalidation
// storm over up to 45 steps rather than letting it land on one step — holds
// exactly the same whether `i` ranges densely over live brains or sparsely
// over `poolIndex` values; both produce a flat, non-degenerate distribution
// of `repathAtStep` offsets. Flagged as a resolved ambiguity, not a silent
// guess — see the report.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()` — `src/ai/` is a headless lint root (`tools/check-imports.mjs`,
// `checkThree: true, checkGlobals: true`). Schedules against `ctx.time.step`
// only (rule 4) — this file never reads a clock. `Math.hypot` is never
// called; every distance test below is a squared comparison (goal-moved
// 2.5 m, flow-field-rebuild 2.0 m) — no `Math.sqrt` needed for either.
// Every per-brain field is a flat typed array indexed by `poolIndex`, built
// once in `createNavBrainStore` and mutated in place — no `Map`, no
// per-frame allocation, matching this ticket's rule 5/6.

/** `06` §9.3, "Hard demotion": above this many active brains, `needsPath`
 * returns false for every `chase` brain — only `flee`/`reposition` may
 * still request A*. */
export const HARD_DEMOTION_ACTIVE_THRESHOLD = 40;

/** `06` §9.3 table: "`activeCount < 8` — a small fight gets real paths." */
export const FLOW_FIELD_MIN_ACTIVE = 8;

/** `06` §9.1: flow-field rebuild cadence, "every 12 steps (5 Hz)". */
export const FIELD_REBUILD_CADENCE_STEPS = 12;

/** `06` §9.1: flow-field rebuild trigger, "the player has moved > 2.0 m". */
export const FIELD_REBUILD_MOVE_M = 2.0;

/** `06` §9.1/§9.2: a node-cap-abort OR a ring-budget refusal demotes a brain
 * to the flow field "for 30 steps". */
export const TIMED_DEMOTION_STEPS = 30;

/** `06` §9.2: `repathAtStep = now + 45 + (actorId % 9)` on a grant. */
export const REPATH_BASE_STEPS = 45;
export const REPATH_JITTER_MOD = 9;

/** `06` §9.2: "goal moved > 2.5 m" == `dist² > 6.25`. */
export const GOAL_MOVED_THRESHOLD_SQ = 6.25;

/** `06` §9.4: `nav:rebuilt` invalidation spread, `repathAtStep = now + (i % 45)`. */
export const NAV_REBUILT_SPREAD_MOD = 45;

/** `06` §9.1/§9.2's own pseudocode: `if granted === 4: break`. Mirrors
 * `astar.js#DEFAULT_BUDGET` (`nav.setBudget(4)`, "the `02` §6 default") as a
 * constant THIS file owns — there is no public getter for `nav`'s
 * currently-configured budget, and this ticket's own brief forbids calling
 * `nav.setBudget()` at all ("nav's number, not yours"). Mismatching this
 * against a future `setBudget(N)` call elsewhere would only cost one wasted
 * `requestPath` call per step (which nav's own per-step throttle would
 * refuse anyway, via `id === 0` — see the ring loop below); it is never a
 * correctness bug, only a missed micro-optimisation. */
export const RING_GRANT_LIMIT = 4;

/** ASSIGNED — no spec value for "how long to wait on a pending request
 * before giving up." `pollPath` typically resolves in 1-3 steps
 * (`02-api-contracts.md` §6); 10 is generous margin over that, chosen so a
 * request that is never coming back (refused, or silently dropped — see
 * this file's header) does not pin a brain out of the scheduler forever. */
const PENDING_TIMEOUT_STEPS = 10;

/**
 * The per-brain nav-scheduling store — one flat bag of typed arrays indexed
 * by `poolIndex`, matching `AiSystem._brains`/`createPerceptionStore`'s own
 * convention. Built once, passed by reference, never rebuilt.
 * @param {number} maxBrains same cap `AiSystem` sizes `_brains` to.
 */
export function createNavBrainStore(maxBrains) {
  return {
    maxBrains,

    // A* request/path bookkeeping.
    hasPath: new Uint8Array(maxBrains),
    pendingRequestId: new Int32Array(maxBrains),
    pendingSinceStep: new Int32Array(maxBrains).fill(-1),
    pathVersion: new Int32Array(maxBrains).fill(-1),
    pathGoalX: new Float32Array(maxBrains),
    pathGoalZ: new Float32Array(maxBrains),
    repathAtStep: new Int32Array(maxBrains).fill(-1),
    useFlowField: new Uint8Array(maxBrains),
    demotedUntilStep: new Int32Array(maxBrains).fill(-1),

    // This step's goal, filled by Pass 1, read by Pass 2 — avoids a second
    // target/pack-centre lookup for the same brain within one step.
    curGoalX: new Float32Array(maxBrains),
    curGoalZ: new Float32Array(maxBrains),
    curHaveGoal: new Uint8Array(maxBrains),

    // The generation-stamped flowDistance cache — see this file's header.
    flowDistStep: new Int32Array(maxBrains).fill(-1),
    flowDistVersion: new Int32Array(maxBrains).fill(-1),
    flowDistValue: new Float32Array(maxBrains),

    // The ring scheduler's own cursor — one global index into `actors.all`,
    // persisted across steps (`06` §9.2's `repathCursor`).
    repathCursor: 0,

    // Flow-field rebuild cadence bookkeeping (`06` §9.1).
    lastFieldStep: -1,
    lastFieldPlayerX: 0,
    lastFieldPlayerZ: 0,

    // Stats. `pathRequests`/`pathRefusals` back `ai.stats`'s own contracted
    // fields (`02-api-contracts.md` §12); `solved` is NOT contracted (no
    // public row names it — see this file's header on MB12) and is reached
    // by tests the same way `ai._perception`/`ai._brains` already are.
    pathRequests: 0,
    pathRefusals: 0,
    solved: 0,
    flowUsers: 0, // a live gauge, recomputed every stepNavScheduler() call
  };
}

/**
 * `06` §9.2's `needsPath(b)`, plus the pending-request guard this file's
 * header explains. `Alloc: no`.
 */
function needsPath(step, nav, store, idx, goalX, goalZ) {
  if (store.useFlowField[idx]) return false;
  if (store.pendingRequestId[idx] !== 0) return false;
  if (!store.hasPath[idx]) return true;
  if (store.pathVersion[idx] !== nav.version) return true;
  if (step >= store.repathAtStep[idx]) return true;
  const dx = goalX - store.pathGoalX[idx];
  const dz = goalZ - store.pathGoalZ[idx];
  return dx * dx + dz * dz > GOAL_MOVED_THRESHOLD_SQ;
}

/**
 * `nav.flowDistance(x,z)`, generation-stamped against `(step, nav.flowVersion)`
 * — see this file's header, "The cached flowDistance". `Alloc: no`.
 * @param {object} nav @param {object} store @param {number} idx
 * @param {number} step @param {number} x @param {number} z
 * @returns {number}
 */
export function cachedFlowDistance(nav, store, idx, step, x, z) {
  if (store.flowDistStep[idx] === step && store.flowDistVersion[idx] === nav.flowVersion) {
    return store.flowDistValue[idx];
  }
  const d = nav.flowDistance(x, z);
  store.flowDistStep[idx] = step;
  store.flowDistVersion[idx] = nav.flowVersion;
  store.flowDistValue[idx] = d;
  return d;
}

/**
 * `06` §9.1: rebuild the flow field toward the player every 12 steps, or
 * sooner if the player has moved > 2.0 m — whichever first. `ai` is the
 * only caller of `nav.buildFlowField()` (`02-api-contracts.md` §6). No
 * `Math.hypot`/`Math.sqrt` — a squared-distance compare against
 * `FIELD_REBUILD_MOVE_M²`. `Alloc: no`.
 */
function maybeRebuildFlowField(ctx, nav, store, player) {
  if (!player || player.dead) return;
  const step = ctx.time.step;

  let rebuild = store.lastFieldStep < 0 || step - store.lastFieldStep >= FIELD_REBUILD_CADENCE_STEPS;
  if (!rebuild) {
    const dx = player.x - store.lastFieldPlayerX;
    const dz = player.z - store.lastFieldPlayerZ;
    rebuild = dx * dx + dz * dz > FIELD_REBUILD_MOVE_M * FIELD_REBUILD_MOVE_M;
  }
  if (!rebuild) return;

  nav.buildFlowField(player.x, player.z);
  store.lastFieldStep = step;
  store.lastFieldPlayerX = player.x;
  store.lastFieldPlayerZ = player.z;
}

/**
 * The per-step nav integration: flow-field-vs-A* eligibility (§9.3) +
 * flow-field rebuild cadence (§9.1) + the ring scheduler (§9.2), in that
 * order. Called once per `AiSystem.fixedUpdate`, after the brain-state
 * loop. `Alloc: no` (every local is a primitive; `curGoalX`/`curGoalZ`/
 * `curHaveGoal` are the pre-allocated scratch declared above).
 *
 * @param {object} ctx
 * @param {object} actors `ctx.get('actors')`.
 * @param {object} nav `ctx.peek('nav')` — may be undefined in a stub-ctx
 *   test; caller must guard (see `./index.js#fixedUpdate`'s existing
 *   `ctx.peek('nav')` precedent for melee/perception).
 * @param {object} brains `AiSystem._brains`.
 * @param {object} perception `AiSystem._perception` — read only
 *   (`packSlot`/`packCenterX`/`packCenterZ`), never mutated here.
 * @param {object} store `createNavBrainStore()`'s return.
 * @param {object} BRAIN_STATE the shared state-code table (`./index.js`).
 * @param {number} activeCount `ai.activeCount` at the top of this step.
 */
export function stepNavScheduler(ctx, actors, nav, brains, perception, store, BRAIN_STATE, activeCount) {
  const step = ctx.time.step;
  const live = actors.all;
  const n = live.length;
  if (n === 0) {
    store.flowUsers = 0;
    return;
  }

  const player = actors.player;
  const hardDemoted = activeCount > HARD_DEMOTION_ACTIVE_THRESHOLD;

  // ── Pass 1 — poll in-flight requests; compute this step's flow-field
  // eligibility and goal for every chase/reposition brain. ─────────────────
  let flowUsers = 0;
  for (let i = 0; i < n; i++) {
    const actor = live[i];
    const idx = actor.poolIndex;
    if (idx >= store.maxBrains || !brains.active[idx]) continue;
    const state = brains.state[idx];
    if (state === BRAIN_STATE.dead) continue;

    const reqId = store.pendingRequestId[idx];
    if (reqId !== 0) {
      const handle = nav.pollPath(reqId);
      if (handle) {
        store.solved++;
        store.hasPath[idx] = 1;
        store.pathVersion[idx] = nav.version;
        nav.releasePath(handle); // not consumed for movement in this ticket — see file header
        store.pendingRequestId[idx] = 0;
      } else if (step - store.pendingSinceStep[idx] > PENDING_TIMEOUT_STEPS) {
        store.pendingRequestId[idx] = 0; // gave up waiting — see file header
      }
    }

    store.curHaveGoal[idx] = 0;
    if (state !== BRAIN_STATE.chase && state !== BRAIN_STATE.reposition) continue;

    let goalX = 0;
    let goalZ = 0;
    let haveGoal = false;
    let targetIsPlayer = false;

    if (state === BRAIN_STATE.chase) {
      const targetId = brains.targetId[idx];
      const target = targetId ? actors.byId(targetId) : null;
      if (target) {
        goalX = target.x;
        goalZ = target.z;
        haveGoal = true;
        targetIsPlayer = !!player && target === player;
      }
    } else {
      // reposition (leash) — 06 §9.3: destination is the pack centre.
      const packSlot = perception.packSlot[idx];
      if (packSlot >= 0) {
        goalX = perception.packCenterX[packSlot];
        goalZ = perception.packCenterZ[packSlot];
        haveGoal = true;
      }
    }

    let wantsFlow = false;
    if (state === BRAIN_STATE.chase) {
      if (targetIsPlayer && haveGoal) {
        const flowDist = cachedFlowDistance(nav, store, idx, step, actor.x, actor.z);
        if (Number.isFinite(flowDist) && activeCount >= FLOW_FIELD_MIN_ACTIVE) wantsFlow = true;
      }
      // Hard demotion (06 §9.3): forces every chase brain onto the field,
      // even one whose own goal/flowDistance would not otherwise qualify —
      // criterion 3, "nobody is queued out."
      if (hardDemoted) wantsFlow = true;
    }
    // The 30-step post-refusal/post-budget-full demotion (06 §9.1/§9.2)
    // applies regardless of state.
    if (step < store.demotedUntilStep[idx]) wantsFlow = true;

    store.useFlowField[idx] = wantsFlow ? 1 : 0;
    if (wantsFlow) flowUsers++;

    if (haveGoal) {
      store.curGoalX[idx] = goalX;
      store.curGoalZ[idx] = goalZ;
      store.curHaveGoal[idx] = 1;
    }
  }
  store.flowUsers = flowUsers;

  maybeRebuildFlowField(ctx, nav, store, player);

  // ── Pass 2 — the ring scheduler, 06 §9.2 verbatim. ───────────────────────
  let granted = 0;
  const cursorStart = n > 0 ? store.repathCursor % n : 0;
  let k = 0;
  for (; k < n; k++) {
    const i = (cursorStart + k) % n;
    const actor = live[i];
    const idx = actor.poolIndex;
    if (idx >= store.maxBrains || !brains.active[idx]) continue;
    const state = brains.state[idx];
    if (state !== BRAIN_STATE.chase && state !== BRAIN_STATE.reposition) continue;
    if (!store.curHaveGoal[idx]) continue; // no live goal this step — nothing to request

    const goalX = store.curGoalX[idx];
    const goalZ = store.curGoalZ[idx];
    if (!needsPath(step, nav, store, idx, goalX, goalZ)) continue;

    store.pathRequests++;
    const id = nav.requestPath(actor.x, actor.z, goalX, goalZ, actor.id);
    if (id === 0) {
      // Budget full for this step (06 §9.2: "id === 0 ... break") — demote
      // to the flow field for 30 steps and stop offering.
      store.pathRefusals++;
      store.useFlowField[idx] = 1;
      store.demotedUntilStep[idx] = step + TIMED_DEMOTION_STEPS;
      break;
    }

    store.pendingRequestId[idx] = id;
    store.pendingSinceStep[idx] = step;
    store.pathGoalX[idx] = goalX;
    store.pathGoalZ[idx] = goalZ;
    store.repathAtStep[idx] = step + REPATH_BASE_STEPS + (actor.id % REPATH_JITTER_MOD);
    granted++;
    if (granted >= RING_GRANT_LIMIT) break;
  }
  store.repathCursor = (cursorStart + k + 1) % n;
}

/**
 * `nav:rebuilt` listener (`06` §9.4, verbatim): walks every active brain
 * once, invalidating its path and spreading the resulting `needsPath` storm
 * over `NAV_REBUILT_SPREAD_MOD` (45) steps via `i % 45` on `poolIndex` (see
 * this file's header on that choice). `Alloc: no`.
 * @param {object} ctx @param {object} brains @param {object} store
 * @param {object} BRAIN_STATE @param {{navVersion:number}} payload
 */
export function onNavRebuilt(ctx, brains, store, BRAIN_STATE, payload) {
  const step = ctx.time.step;
  const version = payload.navVersion;
  for (let i = 0; i < store.maxBrains; i++) {
    if (!brains.active[i] || brains.state[i] === BRAIN_STATE.dead) continue;
    store.hasPath[i] = 0;
    store.pendingRequestId[i] = 0; // nav's own runSolves drops the stale-version entry later — astar.js header
    store.pathVersion[i] = version;
    store.useFlowField[i] = 1;
    store.repathAtStep[i] = step + (i % NAV_REBUILT_SPREAD_MOD);
  }
}
