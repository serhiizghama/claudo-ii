// src/actors/timing.js
//
// ACTR-14 — attack timing decomposition: `08-characters-visual.md` §6.1's
// tick maths (verbatim), §6.2 (what scales / what does not, the Maulsmith
// wind-up floor), §6.5/§6.6 (facing lock, interruption — read for context,
// not re-implemented here, see below), and §11 step 8's acceptance gate.
// `03-combat-math.md` §4.3-4.5 was read for the interval/phase-fraction
// background but is NOT the formula this file implements — see "Two
// timing models" below.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` scans `src/actors/` with
// `checkGlobals: true`). No `Math.random()`. Everything here is integer-tick
// arithmetic on plain numbers/objects — no RNG, no clock, ever.
//
// ---------------------------------------------------------------------------
// What this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: `onAttackStart(tick0, attack, ias)` — the pure §6.1 decomposition,
// with ABSOLUTE tick numbers (`hitTick`/`endTick` are real `ctx.time.step`
// values, not actor-relative), for whichever future caller (`ai`/`skills`,
// neither built yet) needs to know the exact step on which to emit
// `combat:hit-request`. Also owns `advanceAndEmitHitframe(actor, events)`,
// the "drive one tick, emit `anim:hitframe` exactly once" glue this
// ticket's criterion #3 is about.
//
// Does NOT own: wiring either function into `src/actors/index.js`'s
// `fixedUpdate` loop — that file is not in this ticket's file list (see the
// report). Does NOT own the action state machine itself (`beginAction`/
// `advanceAction`/`cancelAction`, all ACTR-9, `./action.js`, imported
// read-only here) — this file does not duplicate that logic; it decomposes
// the SAME §6.1 formula independently (see "Why a second implementation"
// below) and drives `advanceAction`'s per-tick stepping to observe the
// windup -> active transition.
//
// ---------------------------------------------------------------------------
// Why a second implementation of the same formula
// ---------------------------------------------------------------------------
// `./action.js#beginAction` already computes `windTicks`/`activeTicks`/
// `recTicks` internally — but keeps them in a module-private scratch array,
// works entirely in ACTOR-RELATIVE elapsed ticks (`actor.actionTimer`
// counted up from 0), and has no notion of an absolute `tick0`/`hitTick`/
// `endTick` at all (see that file's own header — deliberate, so neither
// `beginAction` nor `advanceAction` needs a `ctx`/`step` parameter). A
// future `ai`/`skills` caller that wants to know the exact SIMULATION STEP
// `combat:hit-request` must fire on needs the absolute-tick version of the
// same maths; `onAttackStart` below is that function, kept independent of
// `action.js`'s internal state on purpose so a caller can compute the
// schedule (e.g. for a UI cooldown readout, or a monster AI's own
// look-ahead) without needing a live `Actor` record at all.
//
// The three Ravager worked rows in this ticket's brief (17 / 11 / 6 ticks,
// `active` held at 6 across all three) were verified against
// `./action.js#beginAction`'s own internal scratch by stepping
// `advanceAction` tick-by-tick in `tests/actors/timing.test.js` — see that
// file's "agrees with ACTR-9" section. The two implementations agree
// exactly for every case that does not need the Maulsmith wind-up floor
// (`action.js` was never asked to implement that floor — it is this
// ticket's own §6.2 data, see below).
//
// ---------------------------------------------------------------------------
// The Maulsmith wind-up floor — a data field, not a special case in the code
// ---------------------------------------------------------------------------
// §6.2: "Maulsmith slam wind-up: yes, floored at 0.90 s". Read literally,
// this is "wind-up scales with IAS same as any other attack, EXCEPT the
// scaled value cannot go below 0.90 s" — i.e. a floor applied to the
// wind-up in SECONDS, after scaling, per-archetype. `onAttackStart` accepts
// this as an optional `attack.windupFloorSeconds` field (absent for every
// attack that has no such floor — rule 6/9: gameplay numbers live in data).
//
// The floor is applied in TICK space, not by re-deriving a floored
// wind-up-in-seconds and re-multiplying — `Math.max(windTicksRaw,
// Math.round(windupFloorSeconds * 60))` — specifically to avoid reordering
// the verbatim `Math.round(attack.W * 60 * mult)` expression for the common
// (no-floor) case: floating-point multiplication is not perfectly
// associative, and `Ravager +60% IAS`'s own `windTicksRaw` lands EXACTLY on
// a `.5` rounding boundary (`16.8 * 0.625 = 10.5` -> `11`). Reassociating
// that expression to make room for a floor term risks flipping a boundary
// case like this one to `10` on a different evaluation order, which is
// exactly the kind of one-tick regression this file exists to prevent. The
// no-floor path below is therefore bit-for-bit the spec's own expression;
// the floor is a separate `Math.max` term layered on top, never a rewrite.
//
// This ticket's own brief flags one worked row (`Maulsmith slam, Extra Fast
// +45%`) whose PRINTED `total` (1.727 s) does not follow from its own
// inputs by any reading of the floor — recorded as O-45. This file's tests
// assert the TICK arithmetic for that row (`windTicks === 54`, i.e.
// `0.90 * 60`, `activeTicks` unscaled, `hitTick === tick0 + 54`) and
// deliberately do NOT assert that one printed seconds figure — per the
// ticket's own instruction. The other four rows' tick-derived totals are
// asserted and printed; see the test file for the one subtlety worth
// recording here: even for those four, `sum(ticks)/60` does not always
// equal the DOC's own printed seconds column to 3 decimal places (e.g.
// `Ravager +60% IAS`: 25 ticks/60 = 0.41667 s vs. the doc's printed
// `0.413 s`). That is not a bug — the doc's `total` column is the
// CONTINUOUS algebra `(W + R)*mult + S` (verified to reproduce the printed
// figure for all four), which is a different computation from summing
// three INDEPENDENTLY ROUNDED tick counts. The simulation only ever runs on
// the tick-summed numbers (`hitTick`/`endTick`), never the continuous
// figure, so this file's acceptance criterion (#1: wind-up + active +
// recovery sum to the interval) is about the TICK identity
// `endTick - tick0 === windTicks + activeTicks + recTicks`, which holds
// exactly by construction, not about matching the doc's continuous-seconds
// column.
//
// ---------------------------------------------------------------------------
// Two timing models in the spec — which one this file implements
// ---------------------------------------------------------------------------
// `03-combat-math.md` §4.3-4.5 describes a DIFFERENT model: a single
// `attackInterval`/`castInterval` (itself IAS-scaled as a whole, clamped to
// `[0.25, 3.0]`/`[0.15, 3.0]`) split into `windup`/`active`/`recover`
// FRACTIONS of that one interval (`windupFrac` default 0.40, `activeFrac`
// default 0.15, `recover` the remainder) — under that model `active` DOES
// scale, because it is a fraction of an already-scaled interval. `08 §6.1`
// gives per-phase RAW SECONDS (`W`/`S`/`R`) and scales wind-up/recovery
// individually while leaving `S` a fixed tick count — the model this
// ticket's brief hands over verbatim as "the specification", and the one
// `./action.js#beginAction` (ACTR-9, accepted) already implements. This
// file follows `08 §6.1` throughout, per the ticket's explicit framing.
// Reconciling `03 §4.3-4.5`'s fraction model against `08 §6.1`'s per-phase
// model (are `W`/`S`/`R` meant to BE `windupFrac`/`activeFrac`/`recover` of
// some `attackInterval`, or a wholly separate table?) is a real, flagged
// ambiguity — see this ticket's report — left to whoever builds the real
// attack-table data file (`items`/`skills`/`ai`, none of which are in this
// ticket's reading window for `04`/`05`/`06`).
//
// ---------------------------------------------------------------------------
// `anim:hitframe` — exactly once, driven off the action FSM's own signal
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`'s canonical event table: `anim:hitframe` `{ actor,
// actionId, actionSeq }`, emitted by `actors`. (`08-characters-visual.md`'s
// own local §6 event list gives a different shape, `{ actor, attackId,
// tick }` — a real, pre-existing inconsistency between the two documents,
// not introduced here; ARCHITECTURE.md is the canonical table per this
// ticket's own instruction, so that is the shape emitted. Flagged in the
// report as something for whoever reconciles `08`'s local table, not fixed
// here — `08-characters-visual.md` is not one of this ticket's two files.)
//
// `advanceAndEmitHitframe(actor, events)` is the "call this once per real
// `fixedUpdate` step, per actor with an action in progress" entry point —
// the same relationship `./action.js#advanceAction` has to its own
// (unbuilt) `index.js` caller. It calls `advanceAction(actor)` and, if the
// step just crossed from `windup` into `active` (the exact tick
// `combat:hit-request` fires on, `08 §6.1`), emits `anim:hitframe`.
//
// "Exactly once" is enforced TWO ways, deliberately redundant:
//   1. Structurally: `advanceAction` itself only ever returns a
//      `{from,to}` transition on the SINGLE tick a phase boundary is
//      crossed (see that file) — calling this function every tick for the
//      life of an action naturally reports the windup->active edge once.
//   2. Defensively: a per-actor `actionSeq`-keyed scratch
//      (`lastHitframeSeq`, an `Int32Array` indexed by `poolIndex` — no
//      `Map`, matching `action.js`'s own scratch-array discipline and this
//      ticket's own "Map banned for per-actor state" rule) records the
//      `actionSeq` a hitframe was already emitted for. A second call that
//      somehow observes the same transition twice for the same actionSeq
//      (a wiring bug in whatever future code drives this, not something
//      this file's own logic can do to itself) is a no-op, not a
//      double-emit. This is what makes the "two fixed steps land in one
//      rendered frame" case in the test file provably safe: calling this
//      function twice in a row (the normal shape of a frame that runs two
//      substeps) still emits once for the whole action, whichever of the
//      two calls happens to be the one that crosses the boundary.
//
// A cancellation during `windup` (`08 §6.6`: "stun: cancels, no hit
// emitted") never reaches this function's `to === 'active'` check at all —
// `cancelAction` sets `actor.actionId = null` and resets `actionPhase` to
// `windup` BEFORE this function's next call, so `advanceAction` short-
// circuits to `null` (its own "no action in progress" no-op) and no
// transition, therefore no hitframe, is ever produced. Tested explicitly.
//
// Recycling safety needs no extra guard here either, for the same reason
// `action.js#actionProgress` needs none: `lastHitframeSeq[idx]` is only
// ever COMPARED against `actor.actionSeq`, never read as a standalone
// truth — a reused `poolIndex` slot's stale value can only ever coincide
// with a genuinely new `actionSeq` by them being numerically equal, and
// `pool.js#resetActorRecord` resets `actionSeq` to `0` on release while
// `beginAction` always increments before use, so a slot's very first real
// action in its next lifetime gets `actionSeq === 1`, which can only
// collide with a stale `lastHitframeSeq` reading of `1` — a false "already
// emitted" skip is possible ONLY if the slot's PREVIOUS occupant also
// stopped at exactly `actionSeq === 1` and never began a second action.
// This is the same class of edge `action.js`'s own header discusses for
// its schedule scratch and is left as a documented, narrow residual —
// resolving it fully would need a generation counter threaded through
// `pool.js`, which is not this ticket's file.

import { advanceAction } from './action.js';
import { ACTOR_STATE } from './data/states.js';

const FIXED_HZ = 60;

/**
 * `08 §6.1`'s tick maths, verbatim, plus the optional `08 §6.2` wind-up
 * floor (`attack.windupFloorSeconds`) as a DATA field — absent for every
 * attack that has none. `mult` is computed once, here, from the `ias`
 * passed in (the caller's job to read it at the tick the attack starts and
 * never re-read it, exactly as `./action.js#beginAction` already does for
 * the actor-relative version of this same formula).
 *
 * `tick0` and the returned `hitTick`/`endTick` are ABSOLUTE simulation
 * steps (`ctx.time.step` values) — see this file's header for why this is
 * a second, independent implementation of the formula `./action.js`
 * already has in actor-relative form.
 *
 * @param {number} tick0 the absolute step the attack starts on
 * @param {{W: number, S: number, R: number, windupFloorSeconds?: number}} attack
 *   raw base seconds — `W`/`S`/`R` match `08 §6.1`'s own symbols exactly.
 * @param {number} ias increased attack speed, percent (e.g. `60` for +60%)
 * @returns {{windTicks: number, activeTicks: number, recTicks: number, hitTick: number, endTick: number}}
 */
export function onAttackStart(tick0, attack, ias) {
  const mult = 1 / (1 + ias / 100);

  // Verbatim `08 §6.1` expression, untouched — see the header's "Maulsmith
  // wind-up floor" section for why the floor is layered on with a separate
  // `Math.max` term rather than folded into this expression.
  const windTicksRaw = Math.round(attack.W * FIXED_HZ * mult);
  const windFloorTicks = attack.windupFloorSeconds != null
    ? Math.round(attack.windupFloorSeconds * FIXED_HZ)
    : -Infinity;
  const windTicks = Math.max(2, windTicksRaw, windFloorTicks);

  const activeTicks = Math.round(attack.S * FIXED_HZ); // NEVER scaled — 08 §6.2, the whole point of this ticket
  const recTicks = Math.max(1, Math.round(attack.R * FIXED_HZ * mult));

  const hitTick = tick0 + windTicks;
  const endTick = hitTick + activeTicks + recTicks;

  return { windTicks, activeTicks, recTicks, hitTick, endTick };
}

/** `actionSeq` last seen emitting a hitframe, indexed by `poolIndex` — see
 * the header's "exactly once" section. Grown lazily, never a `Map` (this
 * ticket's own rule, matching `action.js`'s own schedule scratch). `0` is a
 * safe "never emitted" sentinel: `actor.actionSeq` starts at `0`
 * (`pool.js#createActorRecord`) and `beginAction` always increments BEFORE
 * assigning `actionId`, so a real in-progress action's `actionSeq` is
 * always `>= 1` — this array's default-zeroed `Int32Array` entries can
 * never be mistaken for "already emitted this real action". */
let scratchCapacity = 256;
let lastHitframeSeq = new Int32Array(scratchCapacity);

function ensureHitframeScratchCapacity(poolIndex) {
  if (poolIndex < scratchCapacity) return;
  const grown = Math.max(poolIndex + 1, scratchCapacity * 2);
  const next = new Int32Array(grown);
  next.set(lastHitframeSeq);
  lastHitframeSeq = next;
  scratchCapacity = grown;
}

/**
 * Advance one actor's action by exactly one tick (`./action.js#advanceAction`)
 * and emit `anim:hitframe` — `{ actor, actionId, actionSeq }`, ARCHITECTURE.md's
 * canonical shape — exactly once, on the tick the action enters `active`
 * (the same tick `08 §6.1` says `combat:hit-request` fires on). See this
 * file's header for the "exactly once" argument and the cancelled-during-
 * windup case (no transition observed, nothing emitted).
 *
 * Not a `02-api-contracts.md` row (this ticket's own brief: "your
 * decomposition is consumed from inside `src/actors/`, so it needs no
 * row") — the intended caller is `src/actors/index.js`'s `fixedUpdate`,
 * once per real step, per actor with `actionId !== null`. Not wired there
 * — that file is not in this ticket's file list; see the report.
 *
 * @param {object} actor a live `Actor` record (`pool.js`)
 * @param {{emit: (event: string, payload: object) => void}} events `ctx.events`
 * @returns {{from: string, to: string} | null} `advanceAction`'s own return value
 */
export function advanceAndEmitHitframe(actor, events) {
  const transition = advanceAction(actor);
  if (transition === null || transition.to !== ACTOR_STATE.active) return transition;

  ensureHitframeScratchCapacity(actor.poolIndex);
  const idx = actor.poolIndex;
  if (lastHitframeSeq[idx] === actor.actionSeq) return transition; // already emitted for this action — defensive, see header

  lastHitframeSeq[idx] = actor.actionSeq;
  events.emit('anim:hitframe', { actor, actionId: actor.actionId, actionSeq: actor.actionSeq });
  return transition;
}
