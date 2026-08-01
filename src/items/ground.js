// src/items/ground.js
//
// ITEM-12 — ground items: placement, the budget-capped registry, decay, and
// pickup. Owns the implementation behind `dropToGround`/`groundItemsNear`/
// `pickUp` (`02-api-contracts.md` §11, "World interaction" rows — contracted
// since that section was written, never implemented before this ticket)
// plus the `q.groundItemBudget` eviction and the 600 s hard timeout
// `04-items.md` §5.8 / `01-data-model.md` §5.3 describe.
//
// This filename is invented — no spec names it (ruling D-28,
// docs/PROGRESS.md, which also fixes the corrected spec range: `04` §5.8
// plus the §13.1 `actor:damage` event-table addition, not `04` §6/Uniques).
// `src/items/index.js` wires this module's exports onto `ItemsSystem` and
// owns the `actor:damage` subscription and the `fixedUpdate` hook this
// ticket needs for the decay sweep.
//
// ---------------------------------------------------------------------------
// D-19 — ground scatter is not this file's job
// ---------------------------------------------------------------------------
// `04-items.md` §5.8's scatterAngle/scatterRadius formula (`U(0,2*PI)` /
// `0.45 + 0.85*sqrt(U(0,1))`) is D15 of the items draw order, and D15 is
// ALREADY fully accounted for inside `./drop.js#rollDrop` — two `rng.next()`
// calls, always taken, always discarded, regardless of what the caller does
// with the produced item afterwards (ruling D-19: `02-api-contracts.md`
// L1481-1483 overrides `04:1881`'s general "a skipped draw is not consumed"
// rule for this one case, and only this one — see `drop.js`'s own header).
// `dropToGround(item, x, z)`'s own contract row
// (`02-api-contracts.md:1013`) has no `killPoint`/`Rng` parameter at all,
// only plain numbers — this file receives an ALREADY-RESOLVED ground
// position. Whoever calls it (the monster-death wiring that actually knows
// a kill point — not built yet in this tree; see this ticket's report) owns
// the real scatter-and-snap math (`nav.snap`, per `02-api-contracts.md:489`,
// "loot scatter placement" is explicitly one of its three listed callers),
// using whichever RNG stream it already owns — never the `items` stream,
// which is already spent for this exact purpose inside `rollDrop`. This
// file draws no randomness anywhere, on purpose: drawing here would be a
// second, un-budgeted D15, desynchronising every histogram
// `tools/lootsim.mjs` checks downstream of a kill.
//
// ---------------------------------------------------------------------------
// Data structure — why not `Map`, mirroring containers.js's own discipline
// ---------------------------------------------------------------------------
// The ground registry is exactly the shape this milestone's brief calls out
// by name: a monotonic, never-repeating `uid` that would tempt a `Map`.
// Instead: a dense, capacity-bounded bag of live `ItemInstance` refs
// (`state.items`, swap-with-last removal, same convention `containers.js`'s
// grid `list` already uses) plus parallel typed arrays for every per-entry
// number (`x`/`y`/`z`/`droppedAtStep`/`expiresAtStep`/`freshUntilStep`, all
// `Float64Array`, and `exempt`, a `Uint8Array` flag) — index-aligned with
// `state.items`, never boxed, never a second lookup structure. Capacity is fixed at
// `ctx.config.q.groundItemBudget` (or a safe fallback, see
// `createGroundState`) and never grows — exceeding it evicts or refuses,
// per `01-data-model.md` §11's pool contract, never `Array.push` past the
// bound.
//
// ---------------------------------------------------------------------------
// The fresh-drop "decay grace" — round 2, corrected
// ---------------------------------------------------------------------------
// `04-items.md` §5.8, read in full, is unambiguous about the BUDGET rule
// itself: "eviction by `q.groundItemBudget`, OLDEST FIRST, `rare` and
// `unique` exempt from budget eviction but not from the 600 s hard
// timeout." There is no "refuse the drop" anywhere in it. Round 1 of this
// ticket read the `actor:damage` Listens row ("resets the ground-item decay
// grace ... so an item dropped mid-fight is not evicted ... while the fight
// is still running") as a registry-wide ON/OFF switch that SUSPENDED
// eviction entirely while active. That is wrong, and it fails exactly the
// way the orchestrator described: under a long, continuous fight,
// `actor:damage` fires often enough that the switch is "on" for the whole
// fight, so EVERY new drop past the budget gets refused for the whole
// fight — loot silently stops landing, which `04` §5.8 never asks for and
// which is a materially worse game than "the oldest piece of junk makes
// way for the new drop."
//
// The corrected reading: the grace is a THIRD EXEMPTION CLASS, alongside
// `rare` and `unique` — not a gate on new drops. "An item dropped mid-fight
// is not evicted" names the DROPPED ITEM as the thing being protected, not
// the drop ATTEMPT. Eviction still runs, oldest-first, exactly as `04`
// §5.8 says; it simply skips whichever entries are currently exempt
// (rare, unique, or fresh), the same as it always skipped rare/unique.
//
// This still has to be a genuinely PER-ITEM property, not a registry-wide
// boolean, or the "loot stops landing" failure just reappears in a
// different shape: if "fresh" meant "everything currently on the ground,
// because a fight is running", a long fight would once again make the
// whole registry unevictable at once. What actually makes `04` §5.8's own
// worked outcome true ("the oldest piece of normal junk is evicted and the
// new drop lands", even mid-fight) is that only the last few seconds'
// worth of drops are ever protected — an item dropped early in a long
// fight ages out of its OWN protection and becomes ordinary evictable junk
// again, even while the same fight continues, unless combat keeps landing
// close enough together (< 5 s apart) to keep renewing it.
//
// Implemented with `state.freshUntilStep`, a `Float64Array` parallel to
// every other per-entry column (this ticket's brief explicitly leaves the
// "one registry-wide stamp or one per item" choice open, provided the
// choice and its consequence are both stated — this is the per-item half
// of a HYBRID: a single registry-wide `state.graceUntilStep` (kept for
// cheap O(1) observability/testing — "a step stamp you overwrite" — and as
// the shared target every extension writes) drives a per-item cache so an
// already-stale item is never resurrected by someone else's hit landing):
//
//   - At drop time, `freshUntilStep[i] = step + GRACE_STEPS` UNCONDITIONALLY
//     — every drop gets its own 5 s of protection, independent of whether
//     any recent `actor:damage` happened at all.
//   - `resetGrace` (the `actor:damage` handler) overwrites the shared
//     `graceUntilStep` to `step + GRACE_STEPS`, then walks the live set
//     ONCE (bounded by `state.capacity`, same cost class as `decaySweep`)
//     and extends ONLY the entries still inside their own window
//     (`step < freshUntilStep[i]`) up to that same value. An item whose
//     window had already lapsed is left alone — "reset the grace" renews
//     protection for what is still fresh, it does not un-expire what
//     is not. This is what lets `04` §5.8's own example hold during a
//     fight of any length: combat landing faster than every 5 s keeps
//     recent drops protected; anything older simply ages out on schedule.
//   - Eviction eligibility checks `!exempt[i] && freshUntilStep[i] <= step`,
//     exactly parallel to the pre-existing rare/unique check.
//
// Consequence of the hybrid: one extra O(live-count) walk per `actor:damage`
// event (only ever touching entries that are still fresh; already-stale
// entries cost one comparison and no write) — the same complexity class
// `decaySweep` already pays every fixed step, so this adds nothing new to
// the engine's cost model, just moves an equivalent amount of work onto a
// rarer event.
//
// The genuinely unresolved case `04`/`01` are both silent on: every live
// entry is exempt (rare, unique, or fresh) AND the registry is at capacity.
// `findEvictionCandidate` returns `-1`, and the new drop is refused — the
// pool "does not grow — it refuses" (`01-data-model.md` §11), the same
// documented behaviour a pool with no evictable entry already had before
// this round. This is chosen as the least-bad option, not left implicit:
// rare/unique's exemption is `04` §5.8's own explicit, unconditional rule
// and must never be overridden to make room; overriding freshness instead
// would defeat the entire point of protecting a just-dropped item for the
// one case that most needs it (a burst of several drops in the same
// instant). Both paths out of this state are bounded and automatic: a
// fresh-only jam clears within `GRACE_STEPS` of the last `actor:damage` (no
// hit landing means nothing keeps extending it); a rare/unique-only jam
// clears within the 600 s hard timeout regardless of combat, per `04` §5.8's
// own "not from the 600 s hard timeout" clause. Covered by
// `tests/items/ground.test.js`'s `ITMS.G22`.
//
// ---------------------------------------------------------------------------
// Flagged: three constants that would belong in `src/items/data/` if it
// were part of this ticket's grant
// ---------------------------------------------------------------------------
// `GRACE_STEPS` (5.0 s), `HARD_TIMEOUT_STEPS` (600 s, `04:1252`/`01:895`) and
// `DEFAULT_GROUND_ITEM_BUDGET` are gameplay numbers (`ARCHITECTURE.md` rule
// 9) that would ideally live in `data/`. `src/items/quality.js` already set
// the precedent for keeping frozen constants in the ticket's own module
// when `data/` was not granted; followed here, flagged again in this
// ticket's report.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.
// Reaches `physics.groundHeight` only through `ctx.peek('physics')`,
// guarded — `items` does not declare `physics` as a dep, and a bare test
// `ctx` (this ticket's own tests, `tests/items/quality.test.js`'s
// precedent) may have neither `peek` nor `physics` registered at all.

const FIXED_DT = 1 / 60; // ARCHITECTURE.md's engine-owned constant

export const GROUND_FRESH_GRACE_SECONDS = 5.0;
const GRACE_STEPS = Math.round(GROUND_FRESH_GRACE_SECONDS / FIXED_DT); // 300

export const GROUND_HARD_TIMEOUT_SECONDS = 600; // 04:1252, 01:895
const HARD_TIMEOUT_STEPS = Math.round(GROUND_HARD_TIMEOUT_SECONDS / FIXED_DT); // 36000

// Fallback when no real `ctx.config.q` is available (a bare test ctx) — the
// largest preset, same "overallocate rather than undersize" precedent
// `src/actors/index.js`'s own `DEFAULT_POOL_CAPACITY = POOL_CAPACITY.ultra`
// sets.
const DEFAULT_GROUND_ITEM_BUDGET = 256;

function isBudgetExempt(rarity) {
  return rarity === 'rare' || rarity === 'unique';
}

/**
 * Builds the ground registry state bag — the same "index.js forwards, a
 * sibling file owns a `state` bag over plain arrays" split every other
 * ITEM-* ticket in this directory already uses (`containers.js`'s
 * `createContainerState`, its own direct precedent).
 * @param {object} ctx - the engine ctx (see `ItemsSystem.init()`).
 */
export function createGroundState(ctx) {
  const q = ctx && ctx.config && ctx.config.q;
  const rawBudget = q && q.groundItemBudget;
  const capacity = Number.isInteger(rawBudget) && rawBudget > 0 ? rawBudget : DEFAULT_GROUND_ITEM_BUDGET;

  return {
    ctx,
    capacity,
    items: new Array(capacity).fill(null),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    z: new Float64Array(capacity),
    droppedAtStep: new Float64Array(capacity),
    expiresAtStep: new Float64Array(capacity),
    freshUntilStep: new Float64Array(capacity), // per-item grace window, see file header
    exempt: new Uint8Array(capacity),
    count: 0,
    graceUntilStep: 0, // shared "last actor:damage" reference — see file header
    // Preallocated event-payload scratch (never a fresh literal per call —
    // same "reusable payload" convention `src/combat/xp.js`'s `deathPayload`
    // already sets for `actor:death`).
    _dropPoint: { x: 0, y: 0, z: 0 },
    _dropPayload: { item: null, point: null, rarity: null },
    _pickupPayload: { item: null, actor: null },
  };
}

function currentStep(state) {
  return state.ctx && state.ctx.time ? state.ctx.time.step : 0;
}

function groundHeightAt(state, x, z) {
  const ctx = state.ctx;
  const physics = ctx && typeof ctx.peek === 'function' ? ctx.peek('physics') : undefined;
  if (!physics || typeof physics.groundHeight !== 'function') return 0;
  const y = physics.groundHeight(x, z);
  return Number.isFinite(y) ? y : 0;
}

/** Dense-index lookup — linear, bounded by `state.capacity` (<= a few
 * hundred), the same cost `containers.js#itemAt`'s list scan already
 * accepts at this population size. */
function indexOf(state, item) {
  for (let i = 0; i < state.count; i++) {
    if (state.items[i] === item) return i;
  }
  return -1;
}

/** Swap-with-last removal at a known dense index — no `splice`, no
 * allocation, mirrors `containers.js#removeFromGridList`. */
function removeAt(state, i) {
  const last = state.count - 1;
  state.items[i] = state.items[last];
  state.x[i] = state.x[last];
  state.y[i] = state.y[last];
  state.z[i] = state.z[last];
  state.droppedAtStep[i] = state.droppedAtStep[last];
  state.expiresAtStep[i] = state.expiresAtStep[last];
  state.freshUntilStep[i] = state.freshUntilStep[last];
  state.exempt[i] = state.exempt[last];

  state.items[last] = null;
  state.x[last] = 0;
  state.y[last] = 0;
  state.z[last] = 0;
  state.droppedAtStep[last] = 0;
  state.expiresAtStep[last] = 0;
  state.freshUntilStep[last] = 0;
  state.exempt[last] = 0;
  state.count--;
}

/** Oldest (`droppedAtStep`) evictable live entry, or -1 when nothing
 * qualifies — every live entry is rare, unique, or still inside its own
 * fresh-drop grace (see file header for what happens then). Linear scan,
 * bounded by `state.capacity`.
 * @param {object} state
 * @param {number} step
 */
function findEvictionCandidate(state, step) {
  let best = -1;
  let bestDropped = Infinity;
  for (let i = 0; i < state.count; i++) {
    if (state.exempt[i]) continue;
    if (step < state.freshUntilStep[i]) continue;
    const dropped = state.droppedAtStep[i];
    if (dropped < bestDropped) {
      bestDropped = dropped;
      best = i;
    }
  }
  return best;
}

/**
 * `02-api-contracts.md:1013`: `dropToGround(item, x, z) => void`. Places
 * (or re-places) `item` on the ground registry at `(x, groundHeightAt(x,z),
 * z)`, stamping `item.ground` and enforcing `q.groundItemBudget` (see file
 * header for the eviction/grace policy). The caller is responsible for
 * detaching `item` from any container/equipment slot first — see
 * `src/items/index.js#dropToGround`'s own comment for why that composition
 * lives in `index.js`, not here (this file never reaches `_containers`).
 * @param {object} state - `createGroundState`'s return value.
 * @param {object} item - an `ItemInstance`.
 * @param {number} x
 * @param {number} z
 */
export function dropToGround(state, item, x, z) {
  if (!item) return;
  const step = currentStep(state);

  let target = indexOf(state, item);
  if (target === -1) {
    if (state.count >= state.capacity) {
      // 04 §5.8: "eviction ... oldest first" — always attempted, never
      // gated on a global "is a fight running" switch (see file header for
      // why round 1's version of this gate was wrong). Refuses only when
      // truly nothing qualifies (every live entry rare, unique, or fresh).
      const victim = findEvictionCandidate(state, step);
      if (victim === -1) return; // nothing evictable — pool refuses, 01 §11 (see file header)
      const evicted = state.items[victim];
      if (evicted) evicted.ground = null;
      removeAt(state, victim);
    }
    target = state.count++;
  }

  const y = groundHeightAt(state, x, z);
  const expiresAtStep = step + HARD_TIMEOUT_STEPS;

  state.items[target] = item;
  state.x[target] = x;
  state.y[target] = y;
  state.z[target] = z;
  state.droppedAtStep[target] = step;
  state.expiresAtStep[target] = expiresAtStep;
  // Every drop gets its own fresh-grace window, unconditionally — see file
  // header: this is independent of whether `actor:damage` fired recently.
  state.freshUntilStep[target] = step + GRACE_STEPS;
  state.exempt[target] = isBudgetExempt(item.rarity) ? 1 : 0;

  // `01-data-model.md` §5.3's `ItemInstance.ground` shape, verbatim. Only
  // the FIRST placement allocates the literal (same "allocate once, mutate
  // after" convention `containers.js#place`'s own `item.grid` comment
  // documents for the identical reason).
  if (!item.ground) {
    item.ground = { x, y, z, droppedAtStep: step, expiresAtStep };
  } else {
    item.ground.x = x;
    item.ground.y = y;
    item.ground.z = z;
    item.ground.droppedAtStep = step;
    item.ground.expiresAtStep = expiresAtStep;
  }

  const events = state.ctx && state.ctx.events;
  if (events && typeof events.emit === 'function') {
    const point = state._dropPoint;
    point.x = x;
    point.y = y;
    point.z = z;
    const payload = state._dropPayload;
    payload.item = item;
    payload.point = point;
    payload.rarity = item.rarity;
    events.emit('loot:drop', payload);
  }
}

/**
 * `02-api-contracts.md:1014`: `groundItemsNear(x,z,radius,out) => int`.
 * Squared-distance ground-plane query — never `Math.hypot` (measured at
 * 5.73 B/call vs 0.34 B for the squared form, this milestone's own perf
 * brief) and never a root at all. `out` is a fixed, caller-owned array,
 * same truncation contract `physics/cast.js#overlapCircle`'s own D7
 * documents: never `.length = 0`'d, writes stop at `out.length`, the
 * returned count never exceeds it.
 * @param {object} state
 * @param {number} x
 * @param {number} z
 * @param {number} radius
 * @param {object[]} out
 * @returns {number}
 */
export function groundItemsNear(state, x, z, radius, out) {
  const r2 = radius * radius;
  let count = 0;
  for (let i = 0; i < state.count; i++) {
    const dx = state.x[i] - x;
    const dz = state.z[i] - z;
    if (dx * dx + dz * dz > r2) continue;
    if (count < out.length) out[count] = state.items[i];
    count++;
  }
  return count > out.length ? out.length : count;
}

/** Detaches `item` from the ground registry, if present, clearing
 * `item.ground`. Returns whether it was found. Used by
 * `ItemsSystem#pickUp` after a successful container placement, and by the
 * decay sweep.
 * @param {object} state
 * @param {object} item
 * @returns {boolean}
 */
export function removeFromGround(state, item) {
  const i = indexOf(state, item);
  if (i === -1) return false;
  if (item.ground) item.ground = null;
  removeAt(state, i);
  return true;
}

/**
 * `actor:damage` handler (`02-api-contracts.md` Listens row for `items`).
 * Overwrites the shared reference stamp (never accumulated), then extends
 * every currently-fresh live entry's OWN window up to that same value —
 * never resurrects an entry whose window had already lapsed. See file
 * header for why this is a hybrid (one shared stamp, one per-item cache)
 * rather than either extreme.
 * @param {object} state
 */
export function resetGrace(state) {
  const step = currentStep(state);
  const until = step + GRACE_STEPS;
  state.graceUntilStep = until;
  for (let i = 0; i < state.count; i++) {
    if (step < state.freshUntilStep[i]) state.freshUntilStep[i] = until;
  }
}

/**
 * The 600 s hard timeout (`04:1252`, `01:895`) — called from
 * `ItemsSystem#fixedUpdate`. Unconditional: rare/unique are exempt from
 * BUDGET eviction only (see file header), never from this. Swap-remove
 * during a forward walk with the index held steady across a removal (the
 * standard dense-array-in-place sweep).
 * @param {object} state
 */
export function decaySweep(state) {
  const step = currentStep(state);
  let i = 0;
  while (i < state.count) {
    if (state.expiresAtStep[i] <= step) {
      const item = state.items[i];
      if (item) item.ground = null;
      removeAt(state, i);
    } else {
      i++;
    }
  }
}
