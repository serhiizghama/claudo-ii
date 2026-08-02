// src/skills/status.js
//
// SKIL-6 — the general skill-applied-status engine: `05-skills.md` §14 row 6
// (S9; the `onHitStatus` riders of `bloodletting`/`sunder`/`ram_charge`/
// `war_cry`/`flame_wave`/`ashen_step`/`thunder_step`, `incinerate`'s on-kill
// detonation, `essence_burn`'s mana-to-damage conversion, and `blade_seal`'s
// cold-chill accumulation), `03-combat-math.md` §7 (the ten statuses' own
// magnitudes/durations/stacking) and §12.2/§12.3/§12.7 (the three anti-
// pattern locks this ticket's acceptance bar names).
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/` with
// `checkGlobals: true`). No `Math.random()` — every chance roll here draws
// from a caller-supplied `Rng` (either `combat`'s own forked stream, reached
// indirectly through `combat.applyStatusFromPacket()`, or `skills`' own
// `ctx.rng.fork()` taken once in `SkillsSystem.init()` — see `./index.js`).
//
// ---------------------------------------------------------------------------
// Ownership recap — what already exists, and what this file actually adds
// ---------------------------------------------------------------------------
// The status ENGINE — the `StatusEffectInstance` pool, the four stacking
// rules, the diminishing-returns chain, chill accumulation, DoT ticking — is
// entirely `src/actors/status.js` (ACTR-10) and `src/combat/status.js`
// (CMBT-4), both already accepted and both outside this ticket's file list.
// This file does NOT reimplement any of that. What it adds is the piece
// neither of those owns: turning a `SkillDefinition`'s STATIC `onHitStatus`
// table (`data/skills.js`, `01-data-model.md` §6.1) into the LEVELED,
// per-application numbers those engines consume, plus the three mechanics
// `05` §12 singles out as anti-patterns (incinerate's detonation, essence
// burn's cost-is-the-pool rule, and proving the DR chain actually closes
// permanent CC).
//
// ---------------------------------------------------------------------------
// A load-bearing finding: `combat.resolve()`'s LIVE onHitStatus path does
// NOT go through the DR chain — `applyStatusFromPacket()` does, and nothing
// wires the two together
// ---------------------------------------------------------------------------
// `combat.resolve()` (the public method every `combat:hit-request` runs
// through) calls `resolveDamage()` (`src/combat/resolve.js`, CMBT-3), whose
// own inline R14(c) rider loop (verified by reading it directly) applies
// `rider.magnitude`/`rider.duration` VERBATIM — no diminishing-returns chain,
// no `ccReduction`, no boss/champion/unique rank multiplier. Those all live
// in `src/combat/status.js#applyOneRider` (CMBT-4), reachable only through
// the SEPARATE public method `combat.applyStatusFromPacket(packet, target,
// result)` — whose own header explains it exists for a caller that does NOT
// go through the R1-R14 pipeline, and warns that calling it a SECOND time on
// a packet `resolve()` already processed double-applies riders.
//
// Neither `src/combat/resolve.js` nor `src/combat/packet.js` is in this
// ticket's file list, so the fix is structural, not a patch: every function
// below that wants a rider to see the REAL DR chain/ccReduction/rank
// handling builds its packet with `onHitCount === 0` for the `resolve()`
// call (so R14(c)'s no-op loop touches nothing), reads the resulting
// `DamageResult`, and ONLY THEN populates `packet.onHitStatus[]` and calls
// `combat.applyStatusFromPacket(packet, target, result)` itself — exactly
// the sequencing that method's own header describes as its intended use,
// simply never previously exercised by any caller in this tree. This is how
// `applyOnHitStatuses` below is built. Flagged again in this ticket's
// report: `resolve.js`'s R14(c) is real, load-bearing, dead code for any
// caller that (correctly) also calls `applyStatusFromPacket()` — the two
// should eventually be unified into one call, but that edit is
// `src/combat/`'s, not this ticket's.
//
// ---------------------------------------------------------------------------
// Coefficient statuses — `bleeding` and `burning` cannot go through EITHER
// packet-rider path
// ---------------------------------------------------------------------------
// `05` §2.2/§4.2's own worked riders store `magnitude` as a COEFFICIENT
// ("physDealt × (0.08 + 0.010/L)", "45 % of the fire damage dealt") — see
// `data/skills.js`'s own comments on `bloodletting`/`flame_wave`. Both
// `resolve.js`'s inline R14(c) and `combat/status.js#applyOneRider` pass
// `rider.magnitude` straight through to `actors.applyStatus()` as the
// FINAL "damage per second" value, with no multiplication by the hit's own
// dealt damage anywhere. Precomputing a coefficient × dealt-damage number at
// packet-BUILD time is impossible — the actual dealt damage is not known
// until `resolve()` finishes rolling R5-R13. So `bleeding`/`burning` never
// touch `packet.onHitStatus[]` at all here: `applyOnHitStatuses` handles them
// as a THIRD path, reading the already-resolved `DamageResult`
// (`result.physical` / `result.fire`) directly and calling
// `actors.applyStatus()` itself, after its own `U(0,100) < chance` roll from
// `deps.rng` (this file's own forked stream — see `./index.js`). This is a
// real, load-bearing gap in the existing packet-rider mechanism (it has no
// way to express "magnitude is a function of this hit's own damage"),
// reported here rather than worked around silently.
//
// ---------------------------------------------------------------------------
// O-82 — every `StatusSpec` this file builds carries `step`, defended by
// construction
// ---------------------------------------------------------------------------
// `src/actors/status.js:501` reads `spec.step` with no fallback and no
// validation; a missing `step` produces `expiresStep = NaN`, which
// `expireStatuses`'s `<=` comparison never satisfies — permanent, unremovable
// crowd control (measured live against ACTR-21, recorded as O-82). This file
// cannot edit `src/actors/status.js` to add validation there, so the guard
// is placed at the ONE choke point every status this file ever creates
// passes through: `buildStatusSpec()` below throws immediately if `step` is
// not a finite number, rather than letting a malformed spec reach
// `applyStatus()` and silently produce `NaN`. Every call site in this file
// goes through `buildStatusSpec()` — there is no second, unguarded way to
// construct a spec here. `tests/skills/status.test.js` proves both halves:
// omitting `step` throws (never silently NaNs), and every REAL application
// this file performs (fixed riders via `applyStatusFromPacket`, coefficient
// riders, incinerate's burn-seed) ends with a finite `expiresStep` on the
// resulting `StatusEffectInstance`.
//
// This is a defence IN THIS FILE ONLY. The riders that go through
// `combat.applyStatusFromPacket()` build their `StatusSpec` inside
// `src/combat/status.js#applyOneRider`, which already unconditionally sets
// `step: env.step` (verified by reading it) — so that path was never
// actually exposed to O-82 to begin with. The exposure this file closes is
// its OWN direct `actors.applyStatus()` calls (coefficient riders, the
// incinerate burn-seed) — the ones nothing else was defending.
//
// ---------------------------------------------------------------------------
// O-48, corrected: BOTH halves are closed for the path this file uses —
// but only that path
// ---------------------------------------------------------------------------
// O-48 as recorded elsewhere says `composeStats` never folds
// `instance.statMods` into the `status` stat layer. Verified directly
// against the CURRENT tree (`src/actors/stats.js:509`:
// `applyLayer(block, sources.status)` — composeStats DOES read the layer)
// and against the write side (`src/combat/status.js#rebuildStatusLayer`,
// called from `applyStatusFromPacket()`, calls the now-forwarded
// `actorsSystem.setSourceLayer(actor, 'status', partial)` —
// `src/actors/index.js:527` confirms `setSourceLayer` IS forwarded onto
// `ActorsSystem` today). Live-tested: applying `sunder`'s `cursed` through
// `applyOnHitStatuses` and reading `actors.stats(target).defensePercent`
// afterward shows the real `-59` penalty. **O-48 is closed for any status
// applied through `combat.applyStatusFromPacket()`** — which is every
// fixed-magnitude rider this file applies.
//
// It is NOT closed for `combat.resolve()`'s own inline R14(c) (see above) —
// that copy never calls `rebuildStatusLayer` at all, so a status applied
// through THAT path (the one every OTHER caller in this tree still uses)
// still never reaches the stat block. Same root cause as the DR-chain gap
// above: `resolve.js`'s R14(c) is simpler, earlier code that predates both
// fixes. Reported precisely, not as a blanket "O-48 still open" or "O-48
// now closed" — it is genuinely both, depending on the call path.
//
// ---------------------------------------------------------------------------
// O-49, observed directly against this ticket's own statuses
// ---------------------------------------------------------------------------
// `src/actors/pool.js:523`: `resetActorRecord` does `actor.statuses.length
// = 0` — NOT a call to `releaseInstance()` per surviving entry. This drops
// the actor's own references but never returns the slot to
// `src/actors/status.js`'s module-level `freeInstanceSlots` free-list, so
// the instance pool's usable capacity shrinks by one, permanently, per
// despawn of an actor that still carried a live status. Every status this
// file applies (bleeding outliving a killed Bone Ranker, a burn seeded by
// this file's own incinerate detonation outliving ITS victim, cursed/
// slowed/blinded on a monster that dies mid-duration) is exactly the shape
// that leaks. Not this file's to fix (`src/actors/pool.js` is outside this
// ticket's grant) — reported here and in this ticket's own report.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline
// ---------------------------------------------------------------------------
// `populateFixedMagnitudeRiders` mutates the CALLER's already-pooled
// `packet.onHitStatus[i]` slot objects in place (never replaces the array or
// pushes a new object) — the same discipline `combat/packet.js`'s own
// `PacketPool` documents. `createIncinerateReaction`'s closures preallocate
// their `Int32Array` overlap-query scratch and a single reused `ActorRef`
// once, at construction, never per event. No `Map`, no `Math.hypot`, no
// template strings on any path reachable from `fixedUpdate`/an event
// listener.

import { levelValue } from './cost.js';

/** Matches `src/combat/packet.js`'s own `ONHIT_SLOT_COUNT` — the packet's
 * `onHitStatus[]` is a fixed 4-slot array for the life of the pool. */
export const ONHIT_SLOT_COUNT = 4;

/** The two statuses whose `magnitude` in `data/skills.js` is a COEFFICIENT
 * on the hit's own dealt damage, not a final value — see the file header. */
const COEFFICIENT_STATUSES = new Set(['bleeding', 'burning']);

/**
 * Which of the two coefficient statuses' `coefficient × dealt` is already
 * the per-second RATE `StatusEffectInstance.magnitude` requires (`src/
 * combat/status.js`: `rawTick = inst.magnitude * tickIntervalSeconds`), and
 * which is a TOTAL meant to be spread over the rider's own `duration` —
 * settled per-status, not per-skill, by `03-combat-math.md` §7's own table:
 *
 *   `bleeding`, §7.9: "Magnitude | damage **per second**,
 *   `physicalDamageOfTheHit × (0.08 + 0.010 × (slvl − 1))`" — the coefficient
 *   IS the rate already. Dividing by duration a second time would be wrong.
 *
 *   `burning`, §7.4: "Magnitude | damage **per second** | Default seeding |
 *   `totalFireDamageOfTheHit × 0.35`, spread over `3.0 s` | Skill override |
 *   `flame_wave` seeds `× 0.45` over `4.0 s`" — the coefficient × dealt is a
 *   TOTAL ("spread over"), and `magnitude` (the rate the engine ticks
 *   against) is that total divided by the rider's own duration.
 *
 * No field in `data/skills.js`'s `onHitStatus` rider shape (`{status,
 * chance, duration, magnitude, maxStacks?}`) carries this distinction — it
 * is a property of the STATUS itself (true for every current and future
 * `burning`/`bleeding` rider alike), not of any one skill's own row, so a
 * per-skill data field would be redundant on every entry that could ever
 * exist. This table is the explicit, commented alternative rather than
 * inventing one, per this ticket's own instruction.
 */
const COEFFICIENT_IS_TOTAL_SPREAD_OVER_DURATION = Object.freeze({
  bleeding: false, // 03 §7.9 — already a rate
  burning: true, // 03 §7.4 — a total; divide by duration to get the rate
});

// ---------------------------------------------------------------------------
// S9 — known statuses and the `01-data-model.md` §7.2 / `03-combat-math.md`
// §7 ranges every magnitude/duration this file produces must fall inside.
// A small, LOCAL table, not an import of `src/actors/data/statuses.js` —
// `src/combat/resolve.js`/`status.js` already established the precedent of
// redeclaring this exact ten-entry shape locally rather than reaching across
// a subsystem boundary for pure data (`ARCHITECTURE.md` rule 2 reads as
// "never import another subsystem's module", full stop — those two files'
// own headers say so explicitly for the identical situation).
// ---------------------------------------------------------------------------

/** `magnitude` bounds. Percent-based statuses: 0..100 (`01` §7.2's own
 * column never exceeds 100 for any of the ten, even after per-level
 * scaling — `sunder`'s cursed caps at 70, `ashen_step`'s slowed at 60).
 * `stunned`/`frozen`/`shocked` carry magnitude 0 always ("unused" per `01`
 * §7.2's own table). `bleeding`/`burning` are coefficients here (0..1), not
 * the eventual damage/s the STATUS ends up holding. */
const STATUS_MAGNITUDE_RANGE = Object.freeze({
  chilled: [0, 100], slowed: [0, 100], blinded: [0, 100], cursed: [0, 100],
  stunned: [0, 0], frozen: [0, 0], shocked: [0, 0],
  bleeding: [0, 1], burning: [0, 1],
  poisoned: [0, Infinity],
});

/** `duration` bounds, seconds. Generous upper bounds (no single skill in
 * `data/skills.js` prints a base duration above ~8 s before DR/ccReduction);
 * `30` is a sanity ceiling, not a spec-quoted number, chosen well above
 * every printed value so it only ever catches a genuine defect. */
const STATUS_DURATION_RANGE = Object.freeze({
  chilled: [0, 30], slowed: [0, 30], blinded: [0, 30], cursed: [0, 30],
  stunned: [0, 10], frozen: [0, 10], shocked: [0, 10],
  bleeding: [0, 30], burning: [0, 30], poisoned: [0, 30],
});

/** @param {string} status @returns {boolean} — S9's "no invented status id" half. */
export function isKnownStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_MAGNITUDE_RANGE, status);
}

/** @param {string} status @param {number} magnitude @returns {boolean} */
export function isValidStatusMagnitude(status, magnitude) {
  const range = STATUS_MAGNITUDE_RANGE[status];
  if (!range) return false;
  return Number.isFinite(magnitude) && magnitude >= range[0] && magnitude <= range[1];
}

/** @param {string} status @param {number} duration @returns {boolean} */
export function isValidStatusDuration(status, duration) {
  const range = STATUS_DURATION_RANGE[status];
  if (!range) return false;
  return Number.isFinite(duration) && duration >= range[0] && duration <= range[1];
}

// ---------------------------------------------------------------------------
// O-82 guard — see the file header
// ---------------------------------------------------------------------------

/**
 * The ONE place every `StatusSpec` this file constructs is built. Throws
 * immediately if `step` is not a finite number rather than letting a
 * malformed spec reach `actors.applyStatus()` and silently produce
 * `expiresStep = NaN` (O-82). Every other field is passed through verbatim.
 * @param {object} fields `{status, step, sourceId, sourceGen, sourceSkill,
 *   element, magnitude, duration, stacks}`
 * @returns {object} the same object, returned for chaining convenience
 */
export function buildStatusSpec(fields) {
  if (!Number.isFinite(fields.step)) {
    throw new Error(
      `skills/status: refusing to build a StatusSpec for '${fields.status}' with a non-finite step ` +
        `(got ${fields.step}) — this is exactly O-82 (src/actors/status.js:501, expiresStep = NaN, ` +
        'never expires). Every caller in src/skills/status.js must pass ctx.time.step.',
    );
  }
  return fields;
}

/** Guarded `actors.applyStatus()` call — degrades to a no-op, same
 * "actors-wiring gap" convention `src/combat/status.js#tryApplyStatus`
 * already established, if `actors` has not forwarded `applyStatus` onto
 * `ActorsSystem` in whatever `ctx` this runs against.
 * @param {object} actorsSystem
 * @param {object} target
 * @param {object} spec a `buildStatusSpec()` result
 * @returns {object|null}
 */
export function applyStatusSafe(actorsSystem, target, spec) {
  if (!actorsSystem || typeof actorsSystem.applyStatus !== 'function') return null;
  return actorsSystem.applyStatus(target, spec);
}

// ---------------------------------------------------------------------------
// The general engine — onHitStatus riders, leveled
// ---------------------------------------------------------------------------

/**
 * Writes every FIXED-magnitude rider of `def.onHitStatus` (i.e. every rider
 * except `bleeding`/`burning` — see the file header) into `packet`'s already-
 * pooled `onHitStatus[]` slots, leveled via `levelValue`. Mutates the slot
 * objects in place; never replaces the array, never allocates. Sets
 * `packet.onHitCount` to the number written (0..4).
 * @param {object} packet a `DamagePacket` (from `combat.buildAttackPacket`/
 *   `buildSpellPacket`/`scratchPacket`) whose damage has ALREADY been
 *   resolved with `onHitCount === 0` — see the file header for why order
 *   matters here.
 * @param {object} def `SkillDefinition`
 * @param {number} level effective skill level
 * @returns {number} riders written
 */
export function populateFixedMagnitudeRiders(packet, def, level) {
  let count = 0;
  const riders = def.onHitStatus;
  for (let i = 0; i < riders.length && count < ONHIT_SLOT_COUNT; i++) {
    const rider = riders[i];
    if (COEFFICIENT_STATUSES.has(rider.status)) continue;

    const slot = packet.onHitStatus[count];
    slot.status = rider.status;
    slot.chance = rider.chance;
    slot.duration = levelValue(rider.duration, level);
    slot.magnitude = rider.magnitude ? levelValue(rider.magnitude, level) : 0;
    slot.stacks = rider.stacks || 1;
    count++;
  }
  packet.onHitCount = count;
  return count;
}

/**
 * One coefficient rider (`bleeding`/`burning`): its own `U(0,100) < chance`
 * roll from `deps.rng` (`skills`' own forked stream — never `combat`'s;
 * these never reach `combat.applyStatusFromPacket()`, so they must roll
 * themselves), magnitude = leveled coefficient × the hit's own dealt damage
 * (`result.physical` for `bleeding`, `result.fire` for `burning`), divided
 * by `duration` first for `burning` only — see
 * `COEFFICIENT_IS_TOTAL_SPREAD_OVER_DURATION`'s own header, directly above.
 * @param {{actors:object, rng:object}} deps
 * @param {object} rider one `def.onHitStatus[i]` entry
 * @param {number} level
 * @param {object} packet source provenance (`sourceId`/`sourceGen`/`sourceSkillId`)
 * @param {object} target
 * @param {object} result the already-resolved `DamageResult`
 * @param {number} step `ctx.time.step`
 * @returns {object|null} the applied `StatusEffectInstance`, or `null`
 */
export function applyCoefficientRider(deps, rider, level, packet, target, result, step) {
  const roll = deps.rng.next() * 100;
  if (roll >= rider.chance) return null;

  const dealt = rider.status === 'bleeding' ? result.physical : result.fire;
  if (!(dealt > 0)) return null;

  const coefficient = levelValue(rider.magnitude, level);
  const duration = levelValue(rider.duration, level);
  const rawMagnitude = coefficient * dealt;
  const magnitude = COEFFICIENT_IS_TOTAL_SPREAD_OVER_DURATION[rider.status] && duration > 0
    ? rawMagnitude / duration
    : rawMagnitude;

  const spec = buildStatusSpec({
    status: rider.status,
    step,
    sourceId: packet.sourceId,
    sourceGen: packet.sourceGen,
    sourceSkill: packet.sourceSkillId,
    element: rider.status === 'burning' ? 'fire' : null,
    magnitude,
    duration,
    stacks: rider.stacks || 1,
  });
  return applyStatusSafe(deps.actors, target, spec);
}

/**
 * The main entry point: applies EVERY rider of `def.onHitStatus` to
 * `target`, having already resolved `packet` against `target` via
 * `combat.resolve(packet, target, result)` — `packet.onHitCount` MUST be 0
 * at the time `resolve()` ran (see the file header). Fixed-magnitude riders
 * go through `combat.applyStatusFromPacket()` (the real DR-chain/
 * ccReduction/rank-multiplier path); `bleeding`/`burning` are applied
 * directly. Safe to call with a `def` that has no riders at all (a no-op).
 * @param {{actors:object, combat:object, rng:object}} deps
 * @param {object} def `SkillDefinition`
 * @param {number} level
 * @param {object} packet
 * @param {object} target
 * @param {object} result
 * @param {number} step `ctx.time.step`
 */
export function applyOnHitStatuses(deps, def, level, packet, target, result, step) {
  const riders = def.onHitStatus;
  if (!riders || riders.length === 0) return;

  const fixedCount = populateFixedMagnitudeRiders(packet, def, level);
  if (fixedCount > 0 && deps.combat && typeof deps.combat.applyStatusFromPacket === 'function') {
    deps.combat.applyStatusFromPacket(packet, target, result);
  }

  for (let i = 0; i < riders.length; i++) {
    const rider = riders[i];
    if (!COEFFICIENT_STATUSES.has(rider.status)) continue;
    applyCoefficientRider(deps, rider, level, packet, target, result, step);
  }
}

// ---------------------------------------------------------------------------
// `essence_burn` — `05` §12.3: the cost is the pool, damagePerManaSpent is
// constant
// ---------------------------------------------------------------------------

/**
 * `03-combat-math.md` §8.4: "Fire damage = spentMana × (1.10 + 0.14/L)".
 * `spentMana` is whatever `actors.spend(actor, 'mana', costOf(...).amount)`
 * (`./cost.js#computeCost`'s own `'all'` path, floored at the 20-mana
 * minimum) actually took — this function does not read `cost` at all, it
 * only converts an ALREADY-SPENT amount to damage, so `manaCostReduction`
 * (which `computeCost` already documents as having no effect on this skill's
 * cost) cannot reach it either. `damagePerManaSpent` is therefore
 * `levelValue(def.extra.manaConversion, level)` — a pure function of level,
 * identical at any `spentMana` by construction (linear scaling), which is
 * exactly `05` §12.3's own assertion.
 * @param {object} def `essence_burn`'s `SkillDefinition`
 * @param {number} level
 * @param {number} spentMana
 * @returns {number} fire damage
 */
export function computeEssenceBurnDamage(def, level, spentMana) {
  const factor = levelValue(def.extra.manaConversion, level);
  return spentMana * factor;
}

/** `damagePerManaSpent` at a given level — the ratio §12.3 asserts is
 * constant across spends. Exposed separately so a test can assert the SAME
 * value at 20/100/354 mana without dividing `computeEssenceBurnDamage`'s
 * own output back out (that would trivially always be exact; dividing the
 * INDEPENDENTLY computed damage is the real check).
 * @param {object} def
 * @param {number} level
 * @returns {number}
 */
export function essenceBurnDamagePerManaSpent(def, level) {
  return levelValue(def.extra.manaConversion, level);
}

// ---------------------------------------------------------------------------
// `incinerate` — `05` §4.5 / §12.2: the detonation, and the re-entrancy guard
// ---------------------------------------------------------------------------

/** `05` §4.5's own `DamagePacket` row: `fireMin = fireMax = victim.maxLife ×
 * (25 + 3×(slvl−1) + 4×allocated(flame_wave)) / 100` — the synergy term is
 * MULTIPLICATIVE on the base percent (verified against the skill's own
 * printed 20-level table: L20 base 82, "+flame_wave 20" column 147.6 =
 * 82 × 1.8 = 82 × (1 + 4×20/100); every other row in that table checks out
 * the same way, e.g. L1: 25 × 1.8 = 45, matching the printed "45" exactly).
 * `synergyPercent` is `skills.synergyBonus(actor, 'incinerate',
 * 'detonationDamage')` — this function takes the already-computed number
 * rather than an actor, so it stays a pure function of data.
 * @param {object} def `incinerate`'s `SkillDefinition`
 * @param {number} level
 * @param {number} synergyPercent `4 × allocated(flame_wave)`, 0 if none
 * @returns {number} percent of the victim's maxLife (e.g. 82, not 0.82)
 */
export function computeIncinerateDetonationPercent(def, level, synergyPercent) {
  const base = levelValue(def.extra.onKillDetonation.percentOfMaxLife, level);
  return base * (1 + synergyPercent / 100);
}

/** `03 §7.4`'s own "default seeding" rule, verbatim — `05` §4.5's own status
 * table for `incinerate` names exactly this (no skill-specific override):
 * "the detonation seeds burning by the default rule on survivors, 3.0 s". */
const DEFAULT_BURN_COEFFICIENT = 0.35;
const DEFAULT_BURN_DURATION = 3.0;

/** Comfortably above `06-monsters-ai.md`'s largest documented pack (12) —
 * see `impl/cleaving_strike.js#MAX_CONE_TARGETS`'s identical "headroom above
 * the documented ceiling" precedent. */
const MAX_DETONATION_TARGETS = 32;

/**
 * Builds ONE `incinerate` reaction — a self-contained closure over its own
 * preallocated scratch, exactly `createCleavingStrikeSkill()`'s own shape.
 * Returns `{onActorDamage}`; `./index.js` wires `onActorDamage` onto a
 * permanent `ctx.events.on('actor:damage', ...)` listener (incinerate is a
 * passive — always live, never cast, so this is the ONE piece of this
 * ticket's engine that IS wired into real gameplay today, unlike the rider
 * engine above, which has no cast-wired skill to reach it yet — see this
 * ticket's report).
 *
 * **The re-entrancy guard (`05` §12.2's own lock, `03 §8.3`).** A detonation
 * kill's `DamagePacket.sourceSkillId` is always `'incinerate'` (set below),
 * and any `burning` it seeds inherits the same `sourceSkill` (the
 * `buildStatusSpec` call below). `onActorDamage` refuses to trigger a new
 * detonation whenever `result.sourceSkillId === 'incinerate'` — a kill
 * whose damage is TRACEABLE to a previous detonation (whether the direct
 * blast or a burn tick it seeded, on this step or a later one) can never
 * detonate again. This is provenance-based rather than a per-step flag —
 * STRICTLY stronger than "the guard is set for the whole emitting fixed
 * step" (05's own wording): it also covers a burn tick that kills on a
 * LATER step, which a step-scoped flag would miss. `tests/skills/
 * incinerate.test.js` proves the nine-monster assertion.
 * @param {{actors:object, combat:object, physics:object, events:object, time:object, skills:object}} deps
 * @returns {{onActorDamage: Function}}
 */
export function createIncinerateReaction(deps) {
  const { actors, combat, physics, events, skills } = deps;
  const targetsOut = new Int32Array(MAX_DETONATION_TARGETS);
  const killerRef = { id: 0, generation: 0 };

  function onActorDamage(payload) {
    const { target, result } = payload;
    if (!target || !result) return;
    // 05 §4.5: "the victim died to a packet whose SURVIVING fire component
    // was greater than zero. A kill by the physical half of a hybrid packet
    // does not trigger it."
    if (!result.killed || !(result.fire > 0)) return;
    if (result.sourceSkillId === 'incinerate') return; // the guard — see this function's own header
    if (!result.sourceId && result.sourceId !== 0) return;

    killerRef.id = result.sourceId;
    killerRef.generation = result.sourceGen;
    const killer = actors.resolve(killerRef);
    if (!killer || killer.dead) return;

    const level = skills.effectiveLevel(killer, 'incinerate');
    if (level <= 0) return;
    const def = skills.definition('incinerate');
    if (!def) return;

    const synergyPercent = skills.synergyBonus(killer, 'incinerate', 'detonationDamage');
    const percent = computeIncinerateDetonationPercent(def, level, synergyPercent);
    const maxLife = target.stats ? target.stats.maxLife : 0;
    const damage = (maxLife * percent) / 100;
    if (!(damage > 0)) return;

    const radius = levelValue(def.radius, level); // 2.5 m, flat across levels
    const mask = killer.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
    const count = physics.overlapCircle(target.x, target.z, radius, mask, targetsOut);

    let detonated = false;
    for (let i = 0; i < count; i++) {
      const victim = actors.byId(targetsOut[i]);
      if (!victim || victim.dead || victim.id === target.id) continue;

      const packet = combat.scratchPacket();
      if (!packet) break; // pool exhausted (O-59) — nothing more to resolve

      packet.sourceId = killer.id;
      packet.sourceGen = killer.generation;
      packet.sourceSkillId = 'incinerate';
      packet.sourceLevel = level;
      packet.team = killer.team;
      packet.fireMin = damage;
      packet.fireMax = damage;
      packet.attackRating = 0; // "always hits" — 01 §8.1
      packet.blockable = false;
      packet.dodgeable = false;
      packet.critChance = 0;
      packet.critMult = 100;

      const detResult = combat.resolve(packet, victim);
      detonated = true;

      if (detResult && detResult.fire > 0) {
        // 03 §7.4: the coefficient × dealt is a TOTAL "spread over"
        // DEFAULT_BURN_DURATION, not the rate itself — divide, same fix as
        // applyCoefficientRider's own (see COEFFICIENT_IS_TOTAL_SPREAD_OVER_DURATION's header).
        const magnitude = (DEFAULT_BURN_COEFFICIENT * detResult.fire) / DEFAULT_BURN_DURATION;
        const spec = buildStatusSpec({
          status: 'burning',
          step: deps.time.step,
          sourceId: killer.id,
          sourceGen: killer.generation,
          sourceSkill: 'incinerate', // inherited by the guard above — see this function's own header
          element: 'fire',
          magnitude,
          duration: DEFAULT_BURN_DURATION,
          stacks: 1,
        });
        applyStatusSafe(actors, victim, spec);
      }
      combat.releasePacket(packet);
    }

    if (detonated && events && typeof events.emit === 'function') {
      // `skill:trigger` — ARCHITECTURE.md's own event table names this
      // exactly for "a passive that fires... incinerate's detonation... fx
      // and audio need to tell them apart [from a cast]". `src/fx/`/
      // `src/audio/` do not exist yet (same documented gap `./index.js`'s
      // own header names for `static deps`), so the literal
      // `immolate.explode` audio hook (`05` §4.5's own visual/audio table)
      // has no subsystem to reach — this event is the substitute this
      // ticket's own tests count instead, same "gap, not mine" pattern.
      events.emit('skill:trigger', { actor: killer, skillId: 'incinerate', level });
    }
  }

  return { onActorDamage };
}
