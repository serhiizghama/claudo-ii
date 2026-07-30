// src/actors/action.js
//
// ACTR-9 — the action state machine: `02-api-contracts.md`'s "Action state
// machine" row (`setState`/`beginAction`/`cancelAction`/`canAct`/`canMove`/
// `actionProgress`, read-only — that file is not touched here), calibrated
// against `01-data-model.md` §1.4 (`ACTOR_STATE`, the twelve states, the
// `states.js` requirement), `08-characters-visual.md` §6.1 (the tick maths)
// and §6.6 (the interruption table), and `03-combat-math.md` §7.11 (hit
// recovery -> `hitstun`). The adjacency table itself, and the reasoning
// behind every non-obvious edge, lives in `./data/states.js` — this file
// only enforces it.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` scans `src/actors/` with
// `checkGlobals: true`). No `Math.random()` (ARCHITECTURE.md rule 4) — every
// function here is deterministic arithmetic on an already-spawned `Actor`
// record. No import from `src/core/` (matches `vessels.js`/`stats.js`'s own
// "stay exactly as self-contained as its siblings" style) — the one engine
// constant this file needs, the fixed-step rate, is redeclared locally as
// `FIXED_HZ`, same as `vessels.js#FIXED_HZ`.
//
// ---------------------------------------------------------------------------
// What this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: the six named methods above, plus one internal (non-`02`-row)
// engine function, `advanceAction(actor)`, exported for the same reason
// `vessels.js` exports `integrateVessels` beyond its own four named
// accessors — something has to drive the wind-up -> active -> recover ->
// idle progression once per fixed step, and `actor.actionTimer` (already
// allocated by `pool.js`, "ACTR-9/10 drives transitions") is the field that
// makes that possible without ever reading the wall clock or inventing a
// private step counter: `advanceAction` increments it by exactly one tick
// per CALL, and the wiring layer's contract is "call this once per real
// `fixedUpdate` step, for every active actor" — the same relationship
// `integrateVessels(actor, step)` has to its own caller, except this
// function does not even need a `step` argument, because everything it
// needs (how many ticks have elapsed in the current ACTION, not the
// current fixed step) is actor-relative, never wall-clock-relative.
// Wiring `advanceAction` into `ActorsSystem.fixedUpdate`, and emitting
// `anim:hitframe` when it reports an entry into `active`, is
// `src/actors/index.js`'s job — not touched here (see the report; that file
// is not in this ticket's file list).
//
// Does NOT own: `stats.js`'s `StatBlock` composition (only read, via
// `stats(actor).increasedAttackSpeed` — see "IAS" below), `vessels.js`'s
// resource accessors, status EFFECT APPLICATION (setting `statusMask` bits
// — combat's business, not built), or `applyImpulse` (the thing that would
// actually PUT an actor into `knockback` from the outside — `motion.js`'s
// own header already documents this as unbuilt). This file only makes
// `knockback` a legal, correctly-gated STATE; nothing here ever transitions
// an actor into it on its own.
//
// ---------------------------------------------------------------------------
// `beginAction`'s signature vs. `08 §6.1`'s `onAttackStart(tick0, attack, ias)`
// ---------------------------------------------------------------------------
// `02-api-contracts.md`: `beginAction(actor, actionId, windup, active,
// recover) => int actionSeq` — no `ias`, no `tick0`. This file reads `ias`
// itself, from `stats(actor).increasedAttackSpeed` (already composed by
// `stats.js`, ACTR-7, landed), rather than asking every future caller
// (skills/combat/ai — none built yet) to pre-multiply it in. That keeps the
// one genuinely fiddly piece of `08 §6.1` (the `mult`/rounding/floor
// arithmetic) in exactly one place, matches "`mult` is computed once, at the
// tick the attack starts" verbatim (it is read from `stats()` exactly once,
// inside this call, never re-read for the life of the action), and means
// `windup`/`active`/`recover` are the same RAW base seconds `08 §6.1` calls
// `attack.W`/`attack.S`/`attack.R` — the parameter names match those symbols
// deliberately.
//
// This ticket was explicitly told not to read `04-items.md`/`05-skills.md`,
// so it cannot know whether a CAST should read `fasterCastRate` instead of
// `increasedAttackSpeed` for its own wind-up/recovery scaling. `08 §6.1`'s
// own worked example (`onAttackStart`) is attack-flavoured, so that is what
// this file implements; a spell-specific variant is a real, flagged gap —
// see this ticket's report — for whoever builds the real caller (ACTR-14 by
// the ticket's own framing) to resolve once those docs are in scope.
//
// `tick0`/`hitTick`/`endTick` (absolute step numbers) are NOT computed here
// at all. This file works entirely in ACTOR-RELATIVE elapsed ticks
// (`actor.actionTimer`, counted up from 0 by `advanceAction`) rather than
// absolute `ctx.time.step` values, specifically so neither `beginAction` nor
// `advanceAction` ever needs `ctx`/`step` as a parameter — matching every
// one of `02-api-contracts.md`'s six listed signatures exactly, which have
// no such parameter either. `hitTick` (windup end) and `endTick` (action
// end) are the exact same MOMENTS as "`actionTimer === windTicks`" and
// "`actionTimer === windTicks+activeTicks+recTicks`" respectively; only the
// coordinate system differs (relative vs. absolute), never the tick COUNTS
// themselves, which is the part `08 §6.1` actually specifies.
//
// ---------------------------------------------------------------------------
// Per-actor schedule scratch — why not a `Map`, why not new `Actor` fields
// ---------------------------------------------------------------------------
// `beginAction` needs to remember three numbers per actor for the life of
// an action (`windTicks`/`activeTicks`/`recTicks`) so `advanceAction` knows
// when to flip phases and `actionProgress` knows the whole-action
// denominator. `pool.js`'s `Actor` record has no fields reserved for these
// (only `actionPhase`/`actionTimer`/`actionSeq`/`actionId`/`actionLock`/
// `hitsThisAction` — enough for BOOKKEEPING, not enough for the SCHEDULE
// itself), and `pool.js` is not one of this ticket's three files.
//
// This ticket's brief is explicit that a `Map` is the wrong tool for
// per-actor keyed scratch (`Map.prototype.clear()` allocates
// unconditionally, and — the sharper problem here — a `Map` keyed by
// something that survives recycling would leak the PREVIOUS occupant's
// schedule into a reused slot, exactly the hazard already flagged against
// `actor.cooldowns` in `pool.js`). So this file uses three parallel
// `Int32Array`s, indexed by `actor.poolIndex` (a small, dense, bounded
// integer — never a `Map` key), built ONCE at module load
// (`SCRATCH_CAPACITY = 256`, comfortably above `01-data-model.md`'s own
// documented `q.maxActors` ceiling of 220 — see `ensureScratchCapacity`'s
// own comment for what happens if that assumption is ever wrong).
//
// Recycling safety needs no generation/seq guard on the scratch arrays at
// all: every read of `_windTicks`/`_activeTicks`/`_recTicks` in this file is
// gated behind `actor.actionId !== null`, and `pool.js#resetActorRecord`
// already unconditionally sets `actor.actionId = null` on release
// (verified by reading that file — not edited here). A slot's stale
// schedule numbers can therefore never be READ by a new occupant: the new
// occupant's `actionId` stays `null` until ITS OWN `beginAction` call
// overwrites the same scratch slot with fresh numbers in the same breath it
// sets `actionId` non-null. No `Map`, no generation counter, no allocation
// after module load.

import { stats } from './stats.js';
import { ACTOR_STATE, ACTION_PHASE, ACTION_STATE_TRANSITIONS } from './data/states.js';
import { isActionLockedByStatus } from './status.js';

const FIXED_HZ = 60;

/** `08 §6.6`: "own input (next attack): ... accepted from 75 %" during
 * `recover`. `cancelAction(actor, 'input')` enforces this itself (see
 * below) rather than trusting every future caller to check
 * `actionProgress` first. */
const INPUT_CANCEL_PROGRESS_THRESHOLD = 0.75;

/** `cancelAction`'s `reason` union, `02-api-contracts.md`'s own row,
 * verbatim. An unrecognised reason fails safe (`false`, no mutation) rather
 * than guessing a destination state. */
const VALID_CANCEL_REASONS = new Set(['hitstun', 'death', 'interrupt', 'input']);

/** States in which `canAct`/`canMove` are false regardless of anything
 * else — `dead`/`despawning`/`spawning` (materialising, invulnerable — see
 * `states.js`'s R3) and the two involuntary hard-CC states this file owns,
 * `hitstun` and `knockback` (`motion.js`'s own header, quoting
 * `03-combat-math.md`'s knockback section: "cannot act for [the whole
 * window]"). `02-api-contracts.md`'s row text for `canAct` also names
 * "frozen, stunned" — those are STATUS EFFECTS, not FSM states, and this
 * file originally left that half undone: their `STATUS_BIT` positions lived
 * in a part of `01-data-model.md` outside this ticket's granted reading
 * window, and this file refused to guess them. ACTR-10 has since landed
 * `src/actors/status.js`, which owns `STATUS_BIT` and exports
 * `isActionLockedByStatus(actor)` for exactly this call site — `canAct`
 * below now ANDs that in, closing the gap. `HARD_LOCKED_STATES` itself
 * stays FSM-only; the status half is a separate check in `canAct`, not
 * folded into this set, so this set's own name stays accurate. */
const HARD_LOCKED_STATES = new Set([
  ACTOR_STATE.dead,
  ACTOR_STATE.despawning,
  ACTOR_STATE.spawning,
  ACTOR_STATE.hitstun,
  ACTOR_STATE.knockback,
]);

/** `canMove` additionally locks `windup`/`active`/`recover` (telegraph,
 * damage window, "post-action lock" — `01 §1.4`'s own wording for
 * `recover`) and `interact` (a menu is open). `channel` is deliberately
 * EXCLUDED from this extra set — whirlwind is `channel`'s own named example
 * (`01 §1.4`) and moves the caster, so this file does not lock movement out
 * of it. */
const MOVEMENT_LOCKED_STATES = new Set([
  ...HARD_LOCKED_STATES,
  ACTOR_STATE.windup,
  ACTOR_STATE.active,
  ACTOR_STATE.recover,
  ACTOR_STATE.interact,
]);

/** Not part of `02-api-contracts.md`'s public surface (rule 7: a public
 * method exists only if that file lists it) — a mutable toggle so a dev
 * build can opt INTO `01 §1.4`'s "`setState` throws in dev builds on an
 * illegal transition" without that ever being the default path this
 * ticket's own tests (or anything else) run against. Defaults to `false`;
 * flip `DEV_MODE.throwOnIllegalTransition = true` from a dev-only entry
 * point to get the throwing behaviour `01 §1.4` describes. */
export const DEV_MODE = { throwOnIllegalTransition: false };

/** `01-data-model.md` §1's own documented `q.maxActors` ceiling is 220
 * (`60/100/160/220`); `StatBlock`'s own pool note gives itself `+8`
 * headroom (228). 256 is comfortably above both, chosen as a round power
 * of two purely for readability, not because the arithmetic needs one.
 * `ensureScratchCapacity` grows this ONCE, lazily, only if a real
 * `poolIndex` ever exceeds it — an event that, per the ceiling above,
 * should never happen; kept as a safety net rather than a silent crash if
 * it ever does (a rare, one-off reallocation event, not a per-frame one —
 * rule 5 is about steady-state `fixedUpdate` cost, not this kind of
 * boundary-crossing growth that provably cannot occur within documented
 * limits). */
let scratchCapacity = 256;
let windTicksScratch = new Int32Array(scratchCapacity);
let activeTicksScratch = new Int32Array(scratchCapacity);
let recTicksScratch = new Int32Array(scratchCapacity);

function ensureScratchCapacity(poolIndex) {
  if (poolIndex < scratchCapacity) return;
  const grown = Math.max(poolIndex + 1, scratchCapacity * 2);
  const nextWind = new Int32Array(grown);
  const nextActive = new Int32Array(grown);
  const nextRec = new Int32Array(grown);
  nextWind.set(windTicksScratch);
  nextActive.set(activeTicksScratch);
  nextRec.set(recTicksScratch);
  windTicksScratch = nextWind;
  activeTicksScratch = nextActive;
  recTicksScratch = nextRec;
  scratchCapacity = grown;
}

function isValidState(state) {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(ACTION_STATE_TRANSITIONS, state);
}

/**
 * `02-api-contracts.md` §"Action state machine": `setState(actor, state) =>
 * boolean` — false on an illegal transition, never throws in a normal
 * build (`DEV_MODE.throwOnIllegalTransition` gates the dev-build throw `01
 * §1.4` asks for, opt-in only — see that flag's own comment).
 * `state === actor.state` is always legal (ground rule R1, `states.js`) and
 * is checked before consulting the adjacency table at all.
 * @param {object} actor
 * @param {string} state
 * @returns {boolean}
 */
export function setState(actor, state) {
  if (!isValidState(state)) return false;
  if (state === actor.state) return true;

  const allowed = ACTION_STATE_TRANSITIONS[actor.state];
  if (!allowed || !allowed.includes(state)) {
    if (DEV_MODE.throwOnIllegalTransition) {
      throw new Error(`actors: illegal state transition ${String(actor.state)} -> ${state}`);
    }
    return false;
  }

  actor.state = state;
  actor.stateTime = 0;
  if (state === ACTOR_STATE.dead) actor.dead = true;
  return true;
}

/**
 * `02-api-contracts.md` §"Action state machine": `beginAction(actor,
 * actionId, windup, active, recover) => int actionSeq`. `windup`/`active`/
 * `recover` are RAW base seconds (`08 §6.1`'s `attack.W`/`attack.S`/
 * `attack.R` — see this file's header for why no separate `ias` parameter
 * is needed). `mult` is read from `stats(actor).increasedAttackSpeed`
 * exactly once, here, and never re-read for the life of the action ("`mult`
 * is computed once, at the tick the attack starts" — `08 §6.1`, verbatim).
 * `activeTicks` is never touched by `mult` — this is the one invariant `08
 * §6.1` calls out by name as the classic bug this contract exists to
 * prevent, and it is enforced structurally here: `mult` is simply never
 * multiplied into the `active` term at all.
 *
 * Bumps `actor.actionSeq` unconditionally (the staleness contract — see
 * `cancelAction`) and attempts `setState(actor, 'windup')`. Per
 * `02-api-contracts.md` this always returns an `int`, never a
 * success/failure sentinel, so a caller MUST gate real invocations behind
 * `canAct(actor)` first (exactly what that query exists for) — calling this
 * on, say, a `dead` actor still bumps `actionSeq` and resets the action
 * bookkeeping, but `actor.state` silently stays `dead` because the
 * underlying `setState` call fails its own legality check. Documented here
 * rather than hidden.
 * @param {object} actor
 * @param {string} actionId
 * @param {number} windup seconds, pre-IAS
 * @param {number} active seconds — never scaled by IAS
 * @param {number} recover seconds, pre-IAS
 * @returns {number} the new `actionSeq`
 */
export function beginAction(actor, actionId, windup, active, recover) {
  const ias = stats(actor).increasedAttackSpeed || 0;
  const mult = 1 / (1 + ias / 100);

  const windTicks = Math.max(2, Math.round(windup * FIXED_HZ * mult));
  const activeTicks = Math.round(active * FIXED_HZ); // NEVER scaled by mult — 08 §6.1
  const recTicks = Math.max(1, Math.round(recover * FIXED_HZ * mult));

  ensureScratchCapacity(actor.poolIndex);
  windTicksScratch[actor.poolIndex] = windTicks;
  activeTicksScratch[actor.poolIndex] = activeTicks;
  recTicksScratch[actor.poolIndex] = recTicks;

  actor.actionSeq = actor.actionSeq + 1;
  actor.actionId = actionId;
  actor.actionPhase = ACTION_PHASE.windup;
  actor.actionTimer = 0;
  actor.hitsThisAction = 0;
  actor.actionLock = true;

  setState(actor, ACTOR_STATE.windup);

  return actor.actionSeq;
}

/**
 * `02-api-contracts.md` §"Action state machine": `cancelAction(actor,
 * reason) => boolean`. Always bumps `actor.actionSeq` on success — THE
 * staleness contract: anything holding an older `actionSeq` (an
 * `anim:hitframe` in flight, a `combat:hit-request` payload) compares its
 * captured value against the actor's CURRENT `actor.actionSeq` and drops
 * the work entirely on a mismatch. This file exposes no separate
 * "is-stale" helper because none is needed — `actor.actionSeq` is already a
 * plain, public field on the `Actor` record; the entire contract is
 * "compare the carried value against it," which needs no function call.
 *
 * `reason` gating, `08 §6.6`:
 *   - `'hitstun'` / `'death'`: legal from any live, non-terminal,
 *     non-invulnerable state (never `spawning`/`dead`/`despawning`).
 *   - `'input'`: only from `recover`, and only once
 *     `actionProgress(actor) >= 0.75` — "ignored" during `windup`/`active`,
 *     "accepted from 75 %" during `recover`, enforced HERE rather than
 *     trusted to the caller.
 *   - `'interrupt'`: refused during `windup`/`active`/`recover` — those
 *     three only react to `hitstun`/`death`/(`recover`'s own `input`
 *     carve-out) per `08 §6.6`; reserved for `channel`/`interact`/
 *     `knockback`/`idle`/`move` (see `states.js`'s own reasoning for why
 *     those five get a plain "return to idle" edge).
 * @param {object} actor
 * @param {'hitstun'|'death'|'interrupt'|'input'} reason
 * @returns {boolean}
 */
export function cancelAction(actor, reason) {
  if (!VALID_CANCEL_REASONS.has(reason)) return false;
  if (actor.state === ACTOR_STATE.dead
    || actor.state === ACTOR_STATE.despawning
    || actor.state === ACTOR_STATE.spawning) {
    return false;
  }

  if (reason === 'input') {
    if (actor.state !== ACTOR_STATE.recover) return false;
    if (actionProgress(actor) < INPUT_CANCEL_PROGRESS_THRESHOLD) return false;
  }
  if (reason === 'interrupt'
    && (actor.state === ACTOR_STATE.windup
      || actor.state === ACTOR_STATE.active
      || actor.state === ACTOR_STATE.recover)) {
    return false;
  }

  const nextState = reason === 'hitstun' ? ACTOR_STATE.hitstun
    : reason === 'death' ? ACTOR_STATE.dead
    : ACTOR_STATE.idle; // 'interrupt' and an accepted 'input' both hand control back to idle

  if (!setState(actor, nextState)) return false;

  actor.actionSeq = actor.actionSeq + 1;
  actor.actionId = null;
  actor.actionPhase = ACTION_PHASE.windup;
  actor.actionTimer = 0;
  actor.hitsThisAction = 0;
  actor.actionLock = false;
  return true;
}

/**
 * `02-api-contracts.md` §"Action state machine": `canAct(actor) =>
 * boolean` — "false while frozen, stunned, dead, in hitstun." The FSM half
 * (`dead`/`despawning`/`spawning`/`hitstun`/`knockback`, via
 * `HARD_LOCKED_STATES`) is this file's own; the STATUS half
 * (`frozen`/`stunned`) is `src/actors/status.js#isActionLockedByStatus`
 * (ACTR-10, accepted) — imported, never re-declared, so the bit positions
 * have exactly one authority (see this file's header note on the
 * `poisoned`-in-`vessels.js` duplication this avoids repeating).
 * @param {object} actor
 * @returns {boolean}
 */
export function canAct(actor) {
  return !actor.dead && !HARD_LOCKED_STATES.has(actor.state) && !isActionLockedByStatus(actor);
}

/**
 * `02-api-contracts.md` §"Action state machine": `canMove(actor) =>
 * boolean`. See `MOVEMENT_LOCKED_STATES`'s own comment for why `channel` is
 * excluded from the extra movement lock `canAct` does not have.
 * @param {object} actor
 * @returns {boolean}
 */
export function canMove(actor) {
  return !actor.dead && !MOVEMENT_LOCKED_STATES.has(actor.state);
}

/**
 * `02-api-contracts.md` §"Action state machine": `actionProgress(actor) =>
 * number`, `0..1` across the WHOLE action (wind-up + active + recover
 * together), not per phase. `0` when no action is in progress
 * (`actor.actionId === null`) — deliberately never reads the scratch arrays
 * in that case, which is also what makes recycling safe without a
 * generation guard (see this file's header).
 * @param {object} actor
 * @returns {number}
 */
export function actionProgress(actor) {
  if (actor.actionId === null) return 0;
  const idx = actor.poolIndex;
  if (idx >= scratchCapacity) return 0; // see ensureScratchCapacity's own comment
  const total = windTicksScratch[idx] + activeTicksScratch[idx] + recTicksScratch[idx];
  if (total <= 0) return 1; // unreachable given the floors in beginAction; defensive only
  const f = actor.actionTimer / total;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

/**
 * NOT a `02-api-contracts.md` row — see this file's header for why it
 * exists and who is expected to call it (`src/actors/index.js`'s
 * `fixedUpdate`, once per real step, per active actor with `actionId !==
 * null`; not wired here — reported, not done). Advances `actor.actionTimer`
 * by one tick and flips `windup -> active -> recover -> idle` at the
 * scheduled boundaries this same actor's own `beginAction` call computed.
 * No-op (returns `null`) when the actor has no action in progress — this is
 * also what makes it safe to call unconditionally for every actor every
 * step without checking `actor.state` first: `cancelAction` always clears
 * `actionId` before changing state out from under an in-progress action, so
 * there is nothing for this function to race with.
 * @param {object} actor
 * @returns {{from: string, to: string} | null} the transition just made, or
 *   `null` if nothing changed this call.
 */
export function advanceAction(actor) {
  if (actor.actionId === null) return null;

  actor.actionTimer = actor.actionTimer + 1;
  const idx = actor.poolIndex;
  const w = idx < scratchCapacity ? windTicksScratch[idx] : 0;
  const a = idx < scratchCapacity ? activeTicksScratch[idx] : 0;
  const r = idx < scratchCapacity ? recTicksScratch[idx] : 0;
  const t = actor.actionTimer;

  if (actor.actionPhase === ACTION_PHASE.windup && t >= w) {
    const from = actor.state;
    actor.actionPhase = ACTION_PHASE.active;
    setState(actor, ACTOR_STATE.active);
    return { from, to: actor.state };
  }
  if (actor.actionPhase === ACTION_PHASE.active && t >= w + a) {
    const from = actor.state;
    actor.actionPhase = ACTION_PHASE.recover;
    setState(actor, ACTOR_STATE.recover);
    return { from, to: actor.state };
  }
  if (actor.actionPhase === ACTION_PHASE.recover && t >= w + a + r) {
    const from = actor.state;
    actor.actionId = null;
    actor.actionPhase = ACTION_PHASE.windup;
    actor.actionTimer = 0;
    actor.actionLock = false;
    actor.hitsThisAction = 0;
    setState(actor, ACTOR_STATE.idle);
    return { from, to: actor.state };
  }
  return null;
}
