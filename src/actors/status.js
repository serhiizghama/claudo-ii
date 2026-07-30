// src/actors/status.js
//
// ACTR-10 — status effect INSTANCES and the bitfield: `01-data-model.md` §7
// (the `StatusEffectInstance` record, the ten statuses, §7.3 refresh-vs-stack,
// §7.4 tick cadence) and `02-api-contracts.md`'s "Status effects" row
// (`applyStatus`/`removeStatus`/`hasStatus`/`statusStacks`/`statusRemaining`/
// `clearStatuses`, plus this ticket's own new row, `expireBySource`).
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` scans `src/actors/` with
// `checkGlobals: true`). No `Math.random()` (ARCHITECTURE.md rule 4) — every
// function here is deterministic arithmetic on an already-spawned `Actor`
// record and an explicitly-passed step index, matching `vessels.js`/
// `action.js`'s own style (`FIXED_HZ` redeclared locally rather than
// importing `src/core/engine.js#PHYSICS_HZ` — same self-containment
// convention those two siblings already established).
//
// ---------------------------------------------------------------------------
// What this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: the seven public methods above, the `StatusEffectInstance` pool
// (`Alloc: pool` — built once, in advance, no per-application `new`), and one
// internal (non-`02`-row) engine function, `expireStatuses(actor, step)`,
// exported for the same reason `vessels.js` exports `integrateVessels` and
// `action.js` exports `advanceAction`: something has to remove an instance
// once its `expiresStep` has passed and clear its `statusMask` bit — none of
// the seven public accessors take a `step` parameter that would let them do
// this lazily on read (see "Spec gap" below), so a per-fixed-step sweep is
// the only place it can happen. Wiring `expireStatuses` into
// `ActorsSystem.fixedUpdate`, once per live actor per step, is
// `src/actors/index.js`'s job — not touched here (see the report; that file
// is not in this ticket's file list).
//
// Does NOT own: the DoT tick LOOP itself — walking every actor's ticking
// instances each step, applying `magnitude * tickInterval` damage through
// resistance, and decrementing `totalRemaining` (`01 §7.4`, `03-combat-math.md`
// §7's diminishing-returns chain) is explicitly CMBT-4's territory per this
// ticket's brief ("combat owns when and why they are applied"). This file
// only initializes `nextTickStep`/`totalRemaining` correctly at the moment an
// instance is created (see `computeNextTickStep` below) so combat's tick
// loop has correct data to walk. Also does not own: chill accumulation
// (`03 §7.3`'s `chillPoints` formula) or the stun diminishing-returns chain
// (`actor.chillPoints`/`stunChain`/`stunChainAt` are populated by
// combat/CMBT-4, per `pool.js`'s own field comment — this file never writes
// them); `cannotBeFrozen` (an item-affix flag, `04-items.md`, outside this
// ticket's reading window — combat/items must gate `applyStatus('frozen', ...)`
// on it themselves, or a later ticket adds the check here once that spec
// section is in scope); and folding `instance.statMods` into `composeStats`
// (see `data/statuses.js`'s header — `stats.js` does not consume it yet).
//
// ---------------------------------------------------------------------------
// Spec gap: `statusRemaining(actor, status) => number` has no `step` param
// ---------------------------------------------------------------------------
// `02-api-contracts.md`'s documented signature is exactly `(actor:Actor,
// status:string) => number`. But "seconds remaining" is `expiresStep - now`
// converted to seconds, and `now` is `ctx.time.step` — a value this pure,
// `ctx`-free module has no way to read on its own (ARCHITECTURE.md's own
// rule: "do not invent a private step counter"). Implementing this with
// exactly two parameters would mean either reading a private step counter
// (banned) or returning a step COUNT mislabeled as seconds (silently wrong).
// Neither is acceptable, so this file adds a third, required parameter,
// `statusRemaining(actor, status, step)`, and flags the deviation here and in
// this ticket's report rather than silently matching the table's arity. This
// is the only one of the six pre-existing rows this file's implementation
// does not match signature-for-signature; every other row matches exactly.
//
// ---------------------------------------------------------------------------
// "boss-critical statuses" (01 §7.1's overflow rule) — undefined, resolved
// ---------------------------------------------------------------------------
// "On overflow the instance with the earliest `expiresStep` among
// non-boss-critical statuses is dropped." No document in this ticket's
// reading window (or reachable from it) defines which statuses, or whose
// statuses, count as "boss-critical" — `StatusEffectInstance`'s own fields
// (transcribed verbatim in the ticket, not augmented here) carry no such
// flag, and `applyStatus`'s signature has no `ctx`/pool to resolve
// `sourceId` back to a live actor's `rank` even if it wanted to. Rather than
// invent an undocumented instance field or a pool dependency this contract
// does not grant, this file resolves the ambiguity the only way the
// ALREADY-reserved fields allow: if the actor CARRYING the status list is
// itself `rank === 'boss'`, its status list is never involuntarily evicted —
// a 25th application to a boss actor is refused outright (`applyStatus`
// returns `null`) rather than evicting anything of the boss's own. Every
// non-boss actor's overflow evicts the earliest-`expiresStep` instance
// among ALL 24 held, with no subset carved out (there being no per-instance
// property to carve one with). Flagged in the report as a real
// interpretation, not a certainty.

import { STATUS, STATUS_ORDER, STATUS_BIT, STATUS_TABLE, STACK_RULE } from './data/statuses.js';

export { STATUS, STATUS_ORDER, STATUS_BIT, STATUS_TABLE, STACK_RULE };

const FIXED_HZ = 60;

/** `01-data-model.md` §7.1, verbatim: "Maximum 24 concurrent instances per
 * actor." */
const MAX_CONCURRENT_STATUSES = 24;

/** `03-combat-math.md` §7.2: "Re-application blocked for 3.0 s after it
 * ends" — frozen's own reapply-immunity window, in fixed steps. */
const FROZEN_REAPPLY_IMMUNITY_STEPS = Math.round(3.0 * FIXED_HZ);

/** Every documented status is currently a debuff/CC effect — `01 §7.2`'s
 * table has no buff row. `clearStatuses(actor, onlyHarmful)`'s two modes are
 * therefore behaviourally IDENTICAL today; kept as a real set (rather than
 * hard-coding "always clear everything") so the distinction activates on its
 * own the day a buff-type status exists (a future skills/aura ticket), with
 * zero further change to this file. See this ticket's report. */
const HARMFUL_STATUSES = new Set(STATUS_ORDER);

// ---------------------------------------------------------------------------
// The StatusEffectInstance object pool — `Alloc: pool` for applyStatus,
// built once in advance, no `Map` anywhere (ARCHITECTURE.md's `Map`-for-
// pooled-state ban). Same array-of-preallocated-objects + `Int32Array`
// free-list + manual count shape `pool.js#ActorPool` already established for
// `Actor` records — followed here rather than invented fresh, since
// `StatusEffectInstance` (like `Actor`) carries string/nullable fields a
// pure typed-array layout cannot hold without abandoning the spec'd shape.
// ---------------------------------------------------------------------------

/** `220` is `01-data-model.md`'s own documented `q.maxActors` ceiling
 * (`action.js`'s own comment cites the same number); `24` is the per-actor
 * cap this ticket's own acceptance criterion sets. `2048` sits well below
 * the theoretical worst case (220 * 24 = 5280, every actor maxed at once,
 * which "PROGRESS.md's own max-actor tiers (60/100/160/220)" plus a full
 * status bar on every single one makes vanishingly unlikely in practice)
 * while still being generous headroom for real play — `ensureInstancePoolCapacity`
 * grows it, doubling, in the rare/defensive case it is ever exceeded, the
 * same one-off-growth pattern `action.js#ensureScratchCapacity` uses. */
let instancePoolCapacity = 2048;
let instanceRecords = new Array(instancePoolCapacity);
for (let i = 0; i < instancePoolCapacity; i++) instanceRecords[i] = createInstanceRecord(i);
let freeInstanceSlots = new Int32Array(instancePoolCapacity);
for (let i = 0; i < instancePoolCapacity; i++) freeInstanceSlots[i] = i;
let freeInstanceCount = instancePoolCapacity;

/** One pool slot's `StatusEffectInstance` shape — `01-data-model.md` §7.1,
 * verbatim field set. `poolIndex` here is THIS pool's own slot number (never
 * -1 once built — see the file's own reasoning: unlike `pool.js`'s `Actor`
 * records, whose `poolIndex` never changes across acquire/release either,
 * there is no precedent anywhere in this codebase for a pooled record's own
 * `poolIndex` ever reading -1 once constructed; the spec's illustrative
 * sample shows `-1` on an example instance with no further explanation, and
 * this file follows `pool.js`'s already-shipped convention over that
 * unexplained sample value). */
function createInstanceRecord(poolIndex) {
  return {
    status: null,
    sourceId: 0,
    sourceGen: 0,
    sourceSkill: null,
    element: null,
    magnitude: 0,
    stacks: 0,
    appliedStep: 0,
    expiresStep: 0,
    nextTickStep: 0,
    totalRemaining: 0,
    statMods: null,
    poolIndex,
  };
}

function ensureInstancePoolCapacity(minCount) {
  if (minCount < instancePoolCapacity) return;
  const grown = Math.max(minCount + 1, instancePoolCapacity * 2);
  const nextRecords = new Array(grown);
  for (let i = 0; i < instancePoolCapacity; i++) nextRecords[i] = instanceRecords[i];
  for (let i = instancePoolCapacity; i < grown; i++) nextRecords[i] = createInstanceRecord(i);
  const nextFree = new Int32Array(grown);
  nextFree.set(freeInstanceSlots);
  for (let i = instancePoolCapacity; i < grown; i++) nextFree[freeInstanceCount++] = i;
  instanceRecords = nextRecords;
  freeInstanceSlots = nextFree;
  instancePoolCapacity = grown;
}

function acquireInstance() {
  if (freeInstanceCount === 0) ensureInstancePoolCapacity(instancePoolCapacity);
  if (freeInstanceCount === 0) return null; // defensive; ensureInstancePoolCapacity always grows
  const slot = freeInstanceSlots[--freeInstanceCount];
  return instanceRecords[slot];
}

/** Resets every field but `poolIndex` (same "preserved across cycles" rule
 * `pool.js#resetActorRecord` follows) and returns the slot to the free list.
 * Never reassigns `inst` itself — no allocation. */
function releaseInstance(inst) {
  inst.status = null;
  inst.sourceId = 0;
  inst.sourceGen = 0;
  inst.sourceSkill = null;
  inst.element = null;
  inst.magnitude = 0;
  inst.stacks = 0;
  inst.appliedStep = 0;
  inst.expiresStep = 0;
  inst.nextTickStep = 0;
  inst.totalRemaining = 0;
  inst.statMods = null;
  freeInstanceSlots[freeInstanceCount++] = inst.poolIndex;
}

// ---------------------------------------------------------------------------
// Small helpers shared by every stacking rule
// ---------------------------------------------------------------------------

/** `01-data-model.md` §7.4: "an actor's tick phase is `actor.id % 15`" —
 * spreads DoT resolution cost across the 15-step (4 Hz) window instead of
 * clustering every actor's tick on the same step. `tickIntervalSteps` is 15
 * for burning/poisoned, 30 for bleeding; since 15 divides 30, the SAME phase
 * constant aligns a bleed tick to one of every two burning-phase slots. This
 * exact alignment choice is not spelled out anywhere in this ticket's
 * reading window beyond the one-sentence phase rule — see this ticket's
 * report for the ambiguity and why this is the most direct reading of it.
 * @param {object} actor
 * @param {number} appliedStep
 * @param {number} tickIntervalSteps
 * @returns {number}
 */
function computeNextTickStep(actor, appliedStep, tickIntervalSteps) {
  const phase = (actor.id % 15) % tickIntervalSteps;
  const base = appliedStep - (appliedStep % tickIntervalSteps);
  let next = base + phase;
  if (next < appliedStep) next += tickIntervalSteps;
  return next;
}

/** Builds the `statMods` partial StatBlock for a freshly-applied or
 * refreshed instance, straight off `data/statuses.js#STATUS_TABLE`'s own
 * `statMods` key list — every listed key is a negative contribution of
 * `magnitude` (a documented assumption: every current status is a
 * reduction/debuff, `01 §7.2`'s own wording — "−= magnitude" for chilled is
 * the literal spec text this generalizes). `poisoned`'s `lifeRegen` is the
 * one fixed-to-0 exception (it is not a function of `magnitude` — see
 * `01 §7.2`: "`lifeRegen` set to 0"), included for spec fidelity even though
 * nothing reads it yet (see the file header). Returns `null` when the table
 * lists no keys (burning/poisoned-without-the-fixed-field/shocked/stunned/
 * bleeding/frozen).
 * @param {string} status
 * @param {number} magnitude
 * @returns {object | null}
 */
function buildStatMods(status, magnitude) {
  if (status === STATUS.poisoned) return { lifeRegen: 0 };
  const keys = STATUS_TABLE[status].statMods;
  if (keys.length === 0) return null;
  const mods = {};
  for (const key of keys) mods[key] = -magnitude;
  return mods;
}

function recomputeStatusMask(actor) {
  let mask = 0;
  const list = actor.statuses;
  for (let i = 0; i < list.length; i++) mask |= STATUS_BIT[list[i].status];
  actor.statusMask = mask;
}

/**
 * Removes every instance for which `shouldRemove(inst)` is true, in one
 * forward pass, via write-index compaction (never `splice`, never a
 * swap-with-tail — swap-with-tail is provably unsafe for a "remove ALL
 * matching" pass: the tail element it moves into the just-vacated slot can
 * itself match and be silently skipped, since a naive backward loop never
 * revisits that slot). Preserves the surviving elements' relative order.
 * Calls `onRemoved(inst)` for each removed instance BEFORE it is released
 * back to the pool (so a caller can inspect `inst.status`/`inst.sourceId`/
 * etc. — e.g. `expireStatuses`'s frozen-immunity special case) and always
 * releases it and rebuilds `statusMask` from the survivors afterward.
 * @param {object} actor
 * @param {(inst: object) => boolean} shouldRemove
 * @param {(inst: object) => void} [onRemoved]
 * @returns {number} instances removed
 */
function compactRemove(actor, shouldRemove, onRemoved) {
  const list = actor.statuses;
  let writeIdx = 0;
  let removedCount = 0;
  for (let readIdx = 0; readIdx < list.length; readIdx++) {
    const inst = list[readIdx];
    if (shouldRemove(inst)) {
      if (onRemoved) onRemoved(inst);
      releaseInstance(inst);
      removedCount++;
    } else {
      list[writeIdx] = inst;
      writeIdx++;
    }
  }
  // Shrinks the array; only reaches exactly 0 when every instance is removed
  // at once. `pool.js#resetActorRecord` already does the identical
  // `statuses.length = 0` on this same field (an already-shipped precedent
  // for this exact array), and this is not a per-frame steady-state
  // transition for a typical actor (unlike `pool.js`'s own `_allViewTarget`
  // story) — accepted here rather than engineered around; flagged in the
  // report since this file's test is `status.test.js`, not a `.perf.test.js`
  // allocation gate (D-11).
  list.length = writeIdx;
  if (removedCount > 0) recomputeStatusMask(actor);
  return removedCount;
}

// ---------------------------------------------------------------------------
// Overflow — the 24-cap, "earliest expiresStep among non-boss-critical" rule
// ---------------------------------------------------------------------------

/** See the file header's "boss-critical" section for the interpretation
 * this implements. Returns `false` (nothing evicted, caller must refuse the
 * whole application) only when `actor.rank === 'boss'`. */
function evictForOverflow(actor) {
  if (actor.rank === 'boss') return false;
  const list = actor.statuses;
  if (list.length === 0) return false;
  let minIdx = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].expiresStep < list[minIdx].expiresStep) minIdx = i;
  }
  const evictedStatus = list[minIdx].status;
  const evicted = list[minIdx];
  const lastIdx = list.length - 1;
  list[minIdx] = list[lastIdx];
  list.length = lastIdx;
  releaseInstance(evicted);
  let stillPresent = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === evictedStatus) { stillPresent = true; break; }
  }
  if (!stillPresent) actor.statusMask &= ~STATUS_BIT[evictedStatus];
  return true;
}

/**
 * Fills a freshly-acquired pool instance's fields from `spec` and inserts it
 * into `actor.statuses`, running the 24-cap overflow check first. Returns
 * `null` (no mutation) if the pool is dry (should not happen, see
 * `ensureInstancePoolCapacity`) or if overflow eviction refuses (boss actor
 * at the cap — see the file header).
 * @param {object} actor
 * @param {object} spec a `StatusSpec` (see `applyStatus`'s own doc)
 * @param {number} now `spec.step`
 * @param {number} expiresStep
 * @param {object} table the `STATUS_TABLE[spec.status]` row
 * @param {number} stacks initial `stacks` value (1, except a caller may pass
 *   a different starting count — no current path does)
 * @returns {object | null}
 */
function insertNewInstance(actor, spec, now, expiresStep, table, stacks) {
  if (actor.statuses.length >= MAX_CONCURRENT_STATUSES) {
    if (!evictForOverflow(actor)) return null;
  }
  const inst = acquireInstance();
  if (!inst) return null;

  inst.status = spec.status;
  inst.sourceId = spec.sourceId ?? 0;
  inst.sourceGen = spec.sourceGen ?? 0;
  inst.sourceSkill = spec.sourceSkill ?? null;
  inst.element = spec.element ?? null;
  inst.magnitude = spec.magnitude ?? 0;
  inst.stacks = stacks;
  inst.appliedStep = now;
  inst.expiresStep = expiresStep;
  inst.nextTickStep = table.tickIntervalSteps > 0
    ? computeNextTickStep(actor, now, table.tickIntervalSteps)
    : 0;
  inst.totalRemaining = table.tickIntervalSteps > 0 ? inst.magnitude * (spec.duration ?? 0) : 0;
  inst.statMods = buildStatMods(spec.status, inst.magnitude);

  actor.statuses.push(inst);
  actor.statusMask |= STATUS_BIT[spec.status];
  return inst;
}

// ---------------------------------------------------------------------------
// The four stacking rules — 01 §7.3
// ---------------------------------------------------------------------------

function applyRefresh(actor, spec, table, now, expiresStep) {
  const existing = actor.statuses.find((inst) => inst.status === spec.status);
  if (!existing) return insertNewInstance(actor, spec, now, expiresStep, table, 1);

  existing.expiresStep = Math.max(existing.expiresStep, expiresStep);
  if (table.magnitudeRule === 'maxWins') {
    existing.magnitude = Math.max(existing.magnitude, spec.magnitude ?? 0);
    existing.statMods = buildStatMods(spec.status, existing.magnitude);
  }
  // Newest applier's identity wins on a refresh — a documented decision
  // (see this ticket's report): the spec does not say whether a refresh
  // should keep the ORIGINAL applier or the one that just re-triggered it,
  // and "the newest application refreshes" (01 §7.3's own wording for the
  // additive-stacks family) is the closest analogous instruction available.
  existing.sourceId = spec.sourceId ?? existing.sourceId;
  existing.sourceGen = spec.sourceGen ?? existing.sourceGen;
  existing.sourceSkill = spec.sourceSkill ?? existing.sourceSkill;
  existing.element = spec.element ?? existing.element;
  existing.appliedStep = now;
  return existing;
}

function applyIndependent(actor, spec, table, now, expiresStep) {
  const list = actor.statuses;
  let count = 0;
  let lowestIdx = -1;
  let lowestTotal = Infinity;
  for (let i = 0; i < list.length; i++) {
    if (list[i].status !== spec.status) continue;
    count++;
    if (list[i].totalRemaining < lowestTotal) {
      lowestTotal = list[i].totalRemaining;
      lowestIdx = i;
    }
  }

  if (count < table.maxStacks) return insertNewInstance(actor, spec, now, expiresStep, table, 1);

  // At the cap: replace the lowest-totalRemaining instance IN PLACE (same
  // pool slot, no release/reacquire, no array-length change) — 01 §7.3.
  const inst = list[lowestIdx];
  inst.sourceId = spec.sourceId ?? 0;
  inst.sourceGen = spec.sourceGen ?? 0;
  inst.sourceSkill = spec.sourceSkill ?? null;
  inst.element = spec.element ?? null;
  inst.magnitude = spec.magnitude ?? 0;
  inst.stacks = 1;
  inst.appliedStep = now;
  inst.expiresStep = expiresStep;
  inst.nextTickStep = computeNextTickStep(actor, now, table.tickIntervalSteps);
  inst.totalRemaining = inst.magnitude * (spec.duration ?? 0);
  inst.statMods = buildStatMods(spec.status, inst.magnitude);
  return inst;
}

function applyReplaceIfGreater(actor, spec, table, now, expiresStep) {
  const existing = actor.statuses.find((inst) => inst.status === spec.status);
  const newTotal = (spec.magnitude ?? 0) * (spec.duration ?? 0);
  if (!existing) return insertNewInstance(actor, spec, now, expiresStep, table, 1);

  if (!(newTotal > existing.totalRemaining)) return null; // discarded entirely — 01 §7.3

  existing.sourceId = spec.sourceId ?? 0;
  existing.sourceGen = spec.sourceGen ?? 0;
  existing.sourceSkill = spec.sourceSkill ?? null;
  existing.element = spec.element ?? null;
  existing.magnitude = spec.magnitude ?? 0;
  existing.stacks = 1;
  existing.appliedStep = now;
  existing.expiresStep = expiresStep;
  existing.nextTickStep = computeNextTickStep(actor, now, table.tickIntervalSteps);
  existing.totalRemaining = newTotal;
  existing.statMods = buildStatMods(spec.status, existing.magnitude);
  return existing;
}

function applyAdditiveStacks(actor, spec, table, now, expiresStep) {
  const existing = actor.statuses.find((inst) => inst.status === spec.status);
  if (!existing) return insertNewInstance(actor, spec, now, expiresStep, table, 1);

  existing.stacks = Math.min(existing.stacks + 1, table.maxStacks);
  // "every stack shares one expiresStep which the newest application
  // refreshes" (01 §7.3) — literally overwritten, not max()'d; this is the
  // one family where a reapplication can SHORTEN the remaining duration.
  existing.expiresStep = expiresStep;
  existing.magnitude = spec.magnitude ?? existing.magnitude;
  existing.sourceId = spec.sourceId ?? existing.sourceId;
  existing.sourceGen = spec.sourceGen ?? existing.sourceGen;
  existing.sourceSkill = spec.sourceSkill ?? existing.sourceSkill;
  existing.element = spec.element ?? existing.element;
  existing.appliedStep = now;
  return existing;
}

// ---------------------------------------------------------------------------
// 02-api-contracts.md §"Status effects" — the seven public methods
// ---------------------------------------------------------------------------

/**
 * `applyStatus(actor, spec) => StatusEffectInstance | null`. `Alloc: pool` —
 * draws from the module-level instance pool built above, never `new`s a
 * `StatusEffectInstance`. `spec` (a `StatusSpec`, not itself a
 * `01 §7.1 StatusEffectInstance`):
 *   `{ status, step, sourceId, sourceGen, sourceSkill, element, magnitude,
 *      duration, stacks? }`
 * `step` is the caller's `ctx.time.step` — this function never reads a
 * clock itself (rule 4). `duration` is SECONDS, already `ccReduction`-
 * adjusted by the caller (`03-combat-math.md` §7's own preamble: "every
 * duration is multiplied by (1 − ccReduction/100)... except burning,
 * poisoned and bleeding" — that multiplication is combat-math, not this
 * file's job; see the file header). Returns `null` for a dead actor, an
 * unknown `status` key, a discarded replace-if-greater application, or a
 * refused 24-cap overflow (boss actor already full — see the header).
 * @param {object} actor
 * @param {object} spec
 * @returns {object | null}
 */
export function applyStatus(actor, spec) {
  if (!actor || actor.dead) return null;
  const table = STATUS_TABLE[spec?.status];
  if (!table) return null;

  const now = spec.step;
  if (spec.status === STATUS.frozen && now < actor.ccImmuneUntil) return null; // 03 §7.2 reapply immunity

  const durationSteps = Math.round((spec.duration ?? 0) * FIXED_HZ);
  const expiresStep = now + durationSteps;

  switch (table.stackRule) {
    case STACK_RULE.refresh: return applyRefresh(actor, spec, table, now, expiresStep);
    case STACK_RULE.independent: return applyIndependent(actor, spec, table, now, expiresStep);
    case STACK_RULE.replaceIfGreater: return applyReplaceIfGreater(actor, spec, table, now, expiresStep);
    case STACK_RULE.additiveStacks: return applyAdditiveStacks(actor, spec, table, now, expiresStep);
    default: return null; // unreachable given STATUS_TABLE's own fixed shape
  }
}

/**
 * `removeStatus(actor, status) => int` — instances removed. Removes EVERY
 * instance of `status` (independent stacks included), not just one.
 * @param {object} actor
 * @param {string} status
 * @returns {number}
 */
export function removeStatus(actor, status) {
  if (!actor || !STATUS_BIT[status]) return 0;
  return compactRemove(actor, (inst) => inst.status === status);
}

/**
 * `hasStatus(actor, status) => boolean` — bitfield test. A single `&`
 * against `actor.statusMask`, no loop, no read of `actor.statuses` at all —
 * `status.test.js` proves this structurally (a `Proxy` over `actor.statuses`
 * that throws on any trap access, `hasStatus` still answers correctly).
 * @param {object} actor
 * @param {string} status
 * @returns {boolean}
 */
export function hasStatus(actor, status) {
  const bit = STATUS_BIT[status];
  if (bit === undefined) return false;
  return (actor.statusMask & bit) !== 0;
}

/**
 * `statusStacks(actor, status) => int`. Sums `instance.stacks` across every
 * instance of `status` — correct for all four stacking families:
 * independent stacks (N instances, each `stacks === 1`, sum === N),
 * additive stacks (one instance, `stacks` already the count), and
 * refresh/replace-if-greater (one instance, `stacks === 1`).
 * @param {object} actor
 * @param {string} status
 * @returns {number}
 */
export function statusStacks(actor, status) {
  const bit = STATUS_BIT[status];
  if (bit === undefined || (actor.statusMask & bit) === 0) return 0;
  let total = 0;
  const list = actor.statuses;
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === status) total += list[i].stacks;
  }
  return total;
}

/**
 * `statusRemaining(actor, status, step) => number` — seconds, 0 if absent.
 * See the file header for why this takes a third parameter the documented
 * table omits. Takes the LONGEST remaining instance when more than one
 * shares `status` (independent stacks) — "how long until every instance of
 * this status is gone" is the only reading that makes "0 if absent"
 * coherent for a multi-instance status.
 * @param {object} actor
 * @param {string} status
 * @param {number} step
 * @returns {number}
 */
export function statusRemaining(actor, status, step) {
  const bit = STATUS_BIT[status];
  if (bit === undefined || (actor.statusMask & bit) === 0) return 0;
  let maxExpires = 0;
  const list = actor.statuses;
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === status && list[i].expiresStep > maxExpires) maxExpires = list[i].expiresStep;
  }
  const remainingSteps = maxExpires - step;
  return remainingSteps > 0 ? remainingSteps / FIXED_HZ : 0;
}

/**
 * `clearStatuses(actor, onlyHarmful) => void`. See `HARMFUL_STATUSES`'s own
 * comment: every documented status is harmful today, so both modes clear
 * everything — a real, temporary equivalence, not a bug.
 * @param {object} actor
 * @param {boolean} onlyHarmful
 */
export function clearStatuses(actor, onlyHarmful) {
  if (!actor) return;
  if (onlyHarmful) {
    compactRemove(actor, (inst) => HARMFUL_STATUSES.has(inst.status));
  } else {
    compactRemove(actor, () => true);
  }
}

/**
 * `expireBySource(actor, sourceId) => int` — instances removed. THIS
 * TICKET'S NEW ROW (`02-api-contracts.md` §"Status effects", added in this
 * same change — see this ticket's report for the exact row text). Removes
 * every instance whose `sourceId` matches, regardless of `status` — a
 * same-status, DIFFERENT-source instance is untouched (see
 * `status.test.js`'s acceptance test).
 * @param {object} actor
 * @param {number} sourceId
 * @returns {number}
 */
export function expireBySource(actor, sourceId) {
  if (!actor) return 0;
  return compactRemove(actor, (inst) => inst.sourceId === sourceId);
}

// ---------------------------------------------------------------------------
// Internal engine hooks — NOT 02-api-contracts.md rows (see the file header)
// ---------------------------------------------------------------------------

/**
 * One fixed step's expiry sweep for `actor`: removes every instance whose
 * `expiresStep <= step`, clears the corresponding `statusMask` bit(s), and
 * — `frozen` only — sets `actor.ccImmuneUntil = step + 3.0s` (`03 §7.2`'s
 * reapply-immunity window; ACTR-10/combat both populate `ccImmuneUntil` per
 * `pool.js`'s own field comment). Never reads a clock; `step` is the
 * caller's `ctx.time.step`, exactly like `integrateVessels(actor, step)`.
 * NOT wired into any real `fixedUpdate` here — `src/actors/index.js` is not
 * in this ticket's file list; see the report.
 * @param {object} actor
 * @param {number} step
 * @returns {number} instances expired
 */
export function expireStatuses(actor, step) {
  if (!actor) return 0;
  let frozenExpired = false;
  const removed = compactRemove(
    actor,
    (inst) => inst.expiresStep <= step,
    (inst) => { if (inst.status === STATUS.frozen) frozenExpired = true; },
  );
  if (frozenExpired) actor.ccImmuneUntil = step + FROZEN_REAPPLY_IMMUNITY_STEPS;
  return removed;
}

/** `ACTION_LOCKING_STATUS_MASK` / `isActionLockedByStatus` close ACTR-9's
 * documented gap in `src/actors/action.js#canAct` ("frozen, stunned, dead,
 * in hitstun" — that file implements dead/hitstun via its own
 * `HARD_LOCKED_STATES` but explicitly refused to guess this file's bit
 * positions before it existed). A single `&` against the two relevant bits
 * — see this ticket's report for the exact call `canAct` should make. Not a
 * `02-api-contracts.md` row (it is a bitmask helper, not public surface
 * beyond what `hasStatus` already exposes one call at a time) — exported
 * purely for that one call site. */
export const ACTION_LOCKING_STATUS_MASK = STATUS_BIT.frozen | STATUS_BIT.stunned;

export function isActionLockedByStatus(actor) {
  return (actor.statusMask & ACTION_LOCKING_STATUS_MASK) !== 0;
}

// Exported for tests that want to assert the instance pool's own shape
// without reaching into module-private state via bracket tricks.
export { createInstanceRecord };
