// src/player/progress.js
//
// PLYR-4 — resources, decay, level-up. This ticket's own file.
//
// ---------------------------------------------------------------------------
// What this file owns
// ---------------------------------------------------------------------------
// 1. `ProgressTracker` — the level-up state machine `11-flows.md` §8
//    documents in full ("combat R14(j) -> xp:gain -> player listener ->
//    experience accumulates -> player.fixedUpdate P3's while-loop ->
//    level/statPoints/skillPoints/markDirty/player:levelup, all in the SAME
//    step -> ONE STEP LATER, the deferred life/mana/stamina refill, rage and
//    Resonance untouched"). `XP_TOTAL`/`XP_TABLE` (`./data/progression.js`,
//    D-38) are the curve; this file is the machine that runs against it.
//    `11-flows.md` is not on this ticket's assigned reading list, but
//    `02-api-contracts.md` §13's `grantXp`/`xpToNextLevel` rows are, and
//    resolving their exact behaviour — in particular, that `combat`'s
//    `xpForMonster` (`src/combat/xp.js`, already landed) deliberately
//    OMITS the `(1 + experienceGain/100)` factor and leaves it for
//    `player`'s own `xp:gain` handling, by that file's own header — needed
//    `11-flows.md` §8 to resolve without guessing. Flagged in this
//    ticket's report as a read beyond the literal line-range list, the
//    same "necessary to resolve a real ambiguity" precedent
//    `src/combat/xp.js`'s own header already uses for the identical file.
//
// 2. O-83's exposure surface: `RAGE_DECAY_PER_SECOND`/
//    `RESONANCE_DECAY_PER_SECOND` (transcribed from `03-combat-math.md`
//    §2.4, matching `src/actors/vessels.js:91,93` — NOT imported, that
//    file belongs to `actors`, ARCHITECTURE.md rule 2/1 forbids reaching
//    into it) and `computeInCombat`, the same "now - max(lastDamageStep,
//    lastDealtStep) < 4.0 s" formula `vessels.js#isInCombat` implements
//    privately, transcribed here so `player.hudState()` can expose
//    `inCombat` where `09-ui.md` §16.4 says it lives. `tests/player/
//    progress.test.js` pins both the constants and the decay BEHAVIOUR
//    against the real, live `src/actors/vessels.js` decay (driven through
//    `ActorsSystem.fixedUpdate`, never imported directly) — the same
//    "copied by value, pinned by a live-behaviour test" technique
//    `docs/PROGRESS.md`'s SAVE-1 row already used for `CLASS_START_
//    ATTRIBUTES`/`CLASS_START_SKILL_POINTS`: "скопированы по значению …
//    но пришпилены тестом к живому `stats.js`". A drift on either side
//    turns that test red instead of silently desyncing the HUD.
//
// `integrateVessels` (`src/actors/vessels.js:272`, wired into
// `ActorsSystem.fixedUpdate` by ACTR-21/D-49) ALREADY runs the real
// rage/Resonance out-of-combat decay, gated on `ctx.time.step` — never the
// wall clock. This file does not reimplement that: `RAGE_DECAY_PER_SECOND`/
// `RESONANCE_DECAY_PER_SECOND`/`computeInCombat` below exist purely to make
// the numbers and the flag READABLE from `player` (O-83), not to run a
// second decay simulation. See this ticket's report.
//
// ---------------------------------------------------------------------------
// Round-2 fix — level is now single-valued (`actor.level` vs the tracker)
// ---------------------------------------------------------------------------
// `ProgressTracker#seedFromActor` (below) closes a real, player-facing
// regression the orchestrator's own live probe caught: the constructor's
// `level = 1` default was never reconciled against an already-spawned
// actor's REAL `actor.level` (`src/player/index.js`'s placeholder spawn
// omitted `level` entirely, silently inheriting `actors`'
// `SPAWN_SPEC_DEFAULTS.level === 10`, a monster-oriented default). The
// first `checkLevelUp()` call then overwrote that real 10 with this
// tracker's own uninformed count — a level-UP that SHRANK `maxLife`. See
// `seedFromActor`'s own doc comment for the full fix, and this ticket's
// report for the before/after numbers.
//
// Pure logic, one sibling import (`./data/progression.js`, same directory —
// not a cross-subsystem reach, ARCHITECTURE.md rule 2's own carve-out).
// No `three`, no `document`/`window`, no `performance.now()`,
// no `Math.random()`. Every method below takes the actor/`actors`/`events`
// it needs as plain arguments (the same `deps`-style convention
// `./cast.js#CastController.step` and `./move.js#PathFollower.step` already
// use) rather than closing over `ctx` — keeps this file Node-testable in
// isolation, with a hand-built `actors` stub, no live engine required.

import { XP_TABLE } from './data/progression.js';

/** `13-progression-lore.md` §1.7: "Attribute / skill points | No further
 * awards. 145 attribute points and 29 skill points is the whole budget" —
 * `XP_TABLE` has 29 real level-ups (1 -> 30), so the cap is exactly the
 * table's own last valid index. */
export const LEVEL_CAP = 30;

/** `11-flows.md` §8 step table, row 4: "+5 stat points, +1 skill point per
 * level". Confirmed by `13-progression-lore.md` §1.7's totals: `5 × 29 =
 * 145`, `1 × 29 = 29`. Not `XP_TOTAL`/`XP_TABLE`'s own concern (D-38 scopes
 * `data/progression.js` to the curve only) — kept here, next to the one
 * state machine that reads them. */
const STAT_POINTS_PER_LEVEL = 5;
const SKILL_POINTS_PER_LEVEL = 1;

/** Mirrors `src/core/engine.js#PHYSICS_HZ` / `src/actors/vessels.js`'s own
 * locally-redeclared `FIXED_HZ` (that file's own header explains why it
 * redeclares rather than imports: it stays a self-contained sibling of
 * `stats.js`/`motion.js`). Same reasoning applies here one layer up: this
 * file may not import `src/actors/vessels.js` (ARCHITECTURE.md rule 1/2 —
 * `actors` owns that file) or `src/core/engine.js` (rule 2 forbids reaching
 * into another subsystem's module; `core` is shared but not through a
 * static import of engine internals either). 60, restated a third time,
 * same number every time because it is the one fixed simulation rate the
 * whole engine runs at (ARCHITECTURE.md: "PHYSICS_HZ = 60"). */
const FIXED_HZ = 60;

/** O-83 — `03-combat-math.md` §2.4: "Out of combat -8 / s", matching the
 * live, private `RAGE_DECAY_PER_SECOND` at `src/actors/vessels.js:91`.
 * Transcribed, not imported (see the file header) — pinned to the live
 * value by `tests/player/progress.test.js`'s behavioural probe (drives a
 * real actor through `ActorsSystem.fixedUpdate` and checks the actual rage
 * lost matches this constant, in steps, never a timer). */
export const RAGE_DECAY_PER_SECOND = 8;

/** O-83 — `03-combat-math.md` §2.4: "Out of combat -1 per 3 s", matching
 * `src/actors/vessels.js:93`. Same transcription/pin discipline as
 * `RAGE_DECAY_PER_SECOND` above. */
export const RESONANCE_DECAY_PER_SECOND = 1 / 3;

/** `03-combat-math.md` §2.4: "'In combat' means `now - max(lastDamageStep,
 * lastDealtStep) < 4.0 s`." At 60 Hz that is exactly 240 steps — matching
 * `src/actors/vessels.js`'s own `COMBAT_WINDOW_STEPS`. */
const COMBAT_WINDOW_STEPS = 4.0 * FIXED_HZ;

/**
 * O-83 — the `inCombat` half of `09-ui.md` §16.4's `HudState` additions.
 * Same formula `src/actors/vessels.js#isInCombat` runs privately, with one
 * deliberate, narrow addition: `lastDamageStep`/`lastDealtStep` both default
 * to `-1` ("never yet", `01-data-model.md` §2 / `pool.js`'s own
 * `createActorRecord`) on a freshly spawned actor. Applying the literal
 * formula there (`step - (-1) < 240`) reads as "in combat" for the first
 * ~4 s after every spawn even though nothing has ever happened — harmless
 * to `vessels.js`'s own decay gate (rage/Resonance both start at 0, so
 * `decayOutOfCombat`'s own `v <= 0` guard makes the distinction
 * unobservable there), but directly visible on a freshly-spawned HUD, where
 * "in combat" the instant you spawn is simply wrong. Guarded here with the
 * one-line special case below; matches `tests/player/hudstate.test.js`'s
 * own already-accepted "fresh boot -> `inCombat === false`" assertion.
 * @param {{lastDamageStep:number, lastDealtStep:number}} actor
 * @param {number} step `ctx.time.step`
 * @returns {boolean}
 */
export function computeInCombat(actor, step) {
  if (!actor) return false;
  const lastDamageStep = actor.lastDamageStep;
  const lastDealtStep = actor.lastDealtStep;
  if (lastDamageStep < 0 && lastDealtStep < 0) return false; // never fought
  const lastCombatStep = lastDamageStep > lastDealtStep ? lastDamageStep : lastDealtStep;
  return step - lastCombatStep < COMBAT_WINDOW_STEPS;
}

/**
 * O-83 — the `secondaryDecay` half: `02-api-contracts.md:1209`'s own
 * comment, verbatim, "signed units/s - the rage orb's decay arrow". Mirrors
 * `src/actors/vessels.js#decayOutOfCombat`'s exact gating (`!inCombat` AND
 * `value > 0`) so the exposed rate always matches what the NEXT fixed step
 * will actually do — 0 in combat, 0 once the resource is already drained,
 * the real negative rate otherwise. Never a bare constant regardless of
 * state, which would misreport "still draining" at 0 rage/Resonance.
 * @param {'rage'|'resonance'|'mana'} secondaryKind
 * @param {number} secondaryValue
 * @param {boolean} inCombat
 * @returns {number}
 */
export function computeSecondaryDecay(secondaryKind, secondaryValue, inCombat) {
  if (inCombat || secondaryValue <= 0) return 0;
  if (secondaryKind === 'rage') return -RAGE_DECAY_PER_SECOND;
  if (secondaryKind === 'resonance') return -RESONANCE_DECAY_PER_SECOND;
  return 0; // 'mana' — no secondary resource to decay (09-ui.md §4.1.2)
}

// ---------------------------------------------------------------------------
// ProgressTracker — experience, level-up, the deferred refill
// ---------------------------------------------------------------------------

/**
 * One instance per `PlayerSystem`, owning exactly the fields
 * `02-api-contracts.md` §13's `HudState` reads back out (`level`, `xp`/
 * `xpFloor`/`xpCeiling`/`xpTotal` derived from `experience`, `statPoints`,
 * `skillPoints`). Not stored on the `Actor` record — `pool.js`'s
 * `createActorRecord` has no `experience`/`statPoints`/`skillPoints`
 * fields (only `level`, shared with monsters) and `actors` is not this
 * ticket's file to extend; `player` "owns exclusively... attribute and
 * skill point budgets" per `02-api-contracts.md` §13's own "Owns
 * exclusively" list, so keeping the budget here, off the Actor record, is
 * the contracted ownership, not a workaround. `actor.level` IS written
 * here on every level-up (a plain field `stats.js#derive` already reads
 * for `maxLife`/`maxMana` scaling), followed by `actors.markDirty(actor)`
 * so the change is picked up the documented way.
 */
export class ProgressTracker {
  constructor() {
    this.experience = 0;
    this.level = 1;
    this.statPoints = 0;
    this.skillPoints = 0;
    /** Set the step a level-up crosses a threshold; consumed (and cleared)
     * by `applyPendingRefill` the NEXT fixed step — `11-flows.md` §8 step
     * 8's own "one step of delay, imperceptible". */
    this._pendingRefill = false;
  }

  /**
   * Adopts `level` from an already-spawned actor — called exactly once,
   * from `PlayerSystem.init()`, right after the player actor is resolved
   * (a freshly spawned placeholder OR a pre-existing `actors.player`).
   *
   * `level` defaults to `1` in the constructor above ONLY because that is
   * the correct value for a brand-new character with no actor yet to read
   * — it is never meant to survive contact with a real, already-spawned
   * `Actor`. Skipping this seed step was a real regression this ticket's
   * own report covers in full: `actors.spawn()`'s merge
   * (`src/actors/index.js#spawn`) falls back to `SPAWN_SPEC_DEFAULTS.level
   * === 10` (a monster-oriented default) for any spawn call that omits
   * `level`, so an actor can easily exist at a level this tracker knows
   * nothing about. Without this method, the first `checkLevelUp()` call
   * would overwrite that real `actor.level` with this tracker's own
   * (uninformed) count, silently shrinking `maxLife`/`maxMana`
   * (`stats.js#derive` scales both off `actor.level`) — exactly backwards
   * from what a level-up is supposed to do.
   *
   * `level` is clamped to `1..LEVEL_CAP` — `actors`' own `clampLevel`
   * (`pool.js`) allows up to 40 (monsters/bosses), wider than this XP curve
   * is specified for (`13-progression-lore.md` §1.7's cap is 30); if
   * clamping actually changes the value, `actor.level` is corrected to
   * match so the two never disagree even in that edge case.
   *
   * `experience` is seeded to `XP_TABLE[level]` — the level's own floor,
   * zero progress into the band. There is no real accumulated-XP history to
   * draw from for a placeholder/no-save-yet actor (character load/save is
   * a future ticket's territory), and seeding it any other way risks a
   * negative `xpToNextLevel()`/`hudState().xp`. `statPoints`/`skillPoints`
   * are deliberately NOT backfilled for "levels already passed" — this
   * ticket has no authorised data for what a real character would have
   * spent/earned at a non-1 starting level (`CLASS_START_KIT`, D-38, stays
   * with L1/PLYR-6), so they stay at their constructor default (`0`) rather
   * than a guessed number (rule 6). Flagged in this ticket's report.
   * @param {object} actor
   */
  seedFromActor(actor) {
    if (!actor) return;
    let level = Math.trunc(actor.level);
    if (!Number.isFinite(level) || level < 1) level = 1;
    else if (level > LEVEL_CAP) level = LEVEL_CAP;
    this.level = level;
    this.experience = XP_TABLE[level];
    if (actor.level !== level) actor.level = level;
  }

  /**
   * `02-api-contracts.md` §13: `grantXp` — accumulates `amount` into
   * `experience`, clamped at `XP_TABLE[LEVEL_CAP]` (`13-progression-lore.md`
   * §1.7: "Experience accrues to the counter but `experience` is clamped at
   * `XP_TOTAL(30)`"). Does NOT itself run the level-up check — `11-flows.md`
   * §8's own sequence keeps accumulation (this method, the `xp:gain`
   * listener's job) and the threshold `while`-loop (`checkLevelUp`, run
   * once per fixed step by `PlayerSystem.fixedUpdate`) as two separate
   * steps, so multiple `xp:gain` events landing in the same fixed step (a
   * multi-kill AoE) accumulate fully before the loop ever runs.
   * `amount` here is ALREADY scaled by `(1 + experienceGain/100)` — that
   * scaling is `PlayerSystem.grantXp`'s job (it needs `actors.stats()`,
   * which this file does not reach into), not this method's.
   * @param {number} amount non-negative, already-scaled XP
   */
  grantXp(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const cap = XP_TABLE[LEVEL_CAP];
    let xp = this.experience + amount;
    if (xp > cap) xp = cap;
    this.experience = xp;
  }

  /**
   * `11-flows.md` §8 step table rows 3-6, run once per fixed step
   * (`PlayerSystem.fixedUpdate`, unconditionally — XP/level bookkeeping is
   * not gated by `_controlEnabled`). While `experience` has crossed the
   * next level's threshold and the cap is not reached: `level++`, `+5`
   * stat points, `+1` skill point, write `actor.level`, `actors.
   * markDirty(actor)` (once, after the whole loop — matching "Dirty" being
   * its own single step-6 row after the per-level step-5 loop, not
   * per-level), and emit one `player:levelup { level, statPoints,
   * skillPoints }` PER level crossed, ascending, all in this same call —
   * `11-flows.md` §8 step 5, verbatim ("A Molgrim kill... can cross two
   * thresholds. The `while` emits `player:levelup` once per level,
   * ascending, all in the same step"). Sets `_pendingRefill` when any
   * level was gained; does not itself apply the refill (`applyPending
   * Refill`'s job, one fixed step later).
   * @param {object} actor the live player Actor record
   * @param {{markDirty:(actor:object)=>void}} actors `ctx.get('actors')`
   * @param {{emit:(event:string, payload:object)=>void}} [events] `ctx.events`
   */
  checkLevelUp(actor, actors, events) {
    let leveled = false;
    while (this.level < LEVEL_CAP && this.experience >= XP_TABLE[this.level + 1]) {
      this.level++;
      this.statPoints += STAT_POINTS_PER_LEVEL;
      this.skillPoints += SKILL_POINTS_PER_LEVEL;
      leveled = true;
      if (actor) actor.level = this.level;
      if (events) {
        events.emit('player:levelup', { level: this.level, statPoints: this.statPoints, skillPoints: this.skillPoints });
      }
    }
    if (leveled) {
      if (actor && actors) actors.markDirty(actor);
      this._pendingRefill = true;
    }
  }

  /**
   * `11-flows.md` §8 step 8, verbatim: "`life = stats.maxLife`, `mana =
   * stats.maxMana`, `stamina = stats.maxStamina`. **`rage` and `resonance`
   * are not refilled** — they are combat-earned resources and a free 100
   * rage on level-up would trivialise the next pack." One-shot: clears
   * `_pendingRefill` regardless of whether `actor`/`actors` is available
   * (a level-up under a torn-down actor must not resurrect as a stale
   * refill on the next spawn). `actors.stats(actor)` recomposes if dirty
   * (`ActorsSystem#stats`'s own doc comment) — the `markDirty` call
   * `checkLevelUp` already made the step before guarantees this reads the
   * POST-level-up `StatBlock`, not a stale one, regardless of exactly when
   * `actors`' own `fixedUpdate` runs relative to this one.
   * @param {object} actor
   * @param {{stats:(actor:object)=>object}} actors
   * @returns {boolean} true if a refill was actually applied this call
   */
  applyPendingRefill(actor, actors) {
    if (!this._pendingRefill) return false;
    this._pendingRefill = false;
    if (!actor || !actors) return false;
    const s = actors.stats(actor);
    actor.life = s.maxLife;
    actor.mana = s.maxMana;
    actor.stamina = s.maxStamina;
    // rage and resonance intentionally untouched — see this method's doc.
    return true;
  }

  /**
   * `02-api-contracts.md` §13: `xpToNextLevel() => int` — remaining XP to
   * the next threshold, `0` at the level cap (13-progression-lore.md §1.7:
   * no further awards past 30).
   * @returns {number} int
   */
  xpToNextLevel() {
    if (this.level >= LEVEL_CAP) return 0;
    return XP_TABLE[this.level + 1] - this.experience;
  }
}
