// src/skills/cost.js
//
// SKIL-2 — costs, cooldowns and the three resources (`05-skills.md` §14 row
// 2 / `05.S03`, `05.S04`, §11's three simulations). Pure functions only: no
// `ctx`, no `actors`/`combat` import (`ARCHITECTURE.md` rule 2 — cross-
// subsystem calls happen through `ctx.get()` at a real call site, never a
// module-level `import` of another subsystem's file; `src/actors/vessels.js`
// already owns `addRage`/`addResonance`/`spend`/`canAfford`/`integrateVessels`
// — ACTR-8, shipped in M2 — and is not reached from here). Everything below
// operates on a `SkillDefinition` (`./data/skills.js`) and plain reads off an
// `Actor`-shaped object (`actor.stats`, `actor.mana`, `actor.generation`,
// `actor.cooldowns`) — never a mutation of `actor` outside the two functions
// that are explicitly documented as writing `actor.cooldowns`
// (`startCooldown`) below.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/` with
// `checkGlobals: true`). No `Math.random()` — nothing here needs randomness.
//
// ---------------------------------------------------------------------------
// What this file owns, and what it deliberately does not (D-37 scope)
// ---------------------------------------------------------------------------
// Owns: `costOf`/`cooldownRemaining`'s pure engines (wired onto
// `SkillsSystem` in `./index.js`, the only two rows `02-api-contracts.md`
// §10's Casting table marks `Fixed: Y` for this ticket), the cooldown Map's
// recycle-safe read/write helpers, and the RAGE/MANA/RESONANCE EVENT-AMOUNT
// formulas (`rageForLandedAction`, `rageForHitTaken`, `resonanceForLandedHit`,
// `manaReturnedFromHit`) that `03-combat-math.md` §2.4 states as "combat/
// skills' business" (`src/actors/vessels.js`'s own file header, verbatim: the
// primitives `addRage`/`addResonance`/`spend` exist there already; the literal
// `+6`/`+4`/`+8`/`+1` EVENT amounts — including the R1/R2 readings that decide
// how many times an amount is awarded per action — do not, anywhere, until
// this file).
//
// Does NOT own: decay (`src/actors/vessels.js#integrateVessels`, ACTR-8,
// already ships `03 §2.4`'s rage/resonance out-of-combat drift exactly —
// re-implementing it here would be a second, divergent copy of the same
// rule), casting, packets, projectiles, passive-stat composition (`05` §14
// step 5 — `mana_weave`'s `maxMana`/`manaRegen`, `resonance_circuit`'s
// `resonanceOnHit`/`manaReturnPercent` bonuses land on `StatBlock` through
// `actors/stats.js`'s source layers, not through anything in this file).
// This file only ever READS `actor.stats.<field>` — already composed, per
// `ARCHITECTURE.md`'s "Stat recomputation is lazy" rule — never recomposes
// it.
//
// ---------------------------------------------------------------------------
// The mana-only reduction rule (`05` §1.3, `03` §8 intro, S3)
// ---------------------------------------------------------------------------
// `manaCostReduction` reduces MANA costs only, floored at 1 after reduction.
// Rage and Resonance costs are read verbatim — `costOf` never applies
// `manaCostReduction` to a `rage`/`resonance` primary resource, matching
// `05-skills.md` §1.3's line stated twice for emphasis ("Rage and Resonance
// costs are not reduced by manaCostReduction").
//
// ---------------------------------------------------------------------------
// `essence_burn` — the cost is the pool, not a number (`05` §12.3)
// ---------------------------------------------------------------------------
// `cost.base === 'all'` (only `essence_burn`, `01-data-model.md`'s own
// established convention for the field, extended from `cost.resonance`'s
// `'all'`) means: spend everything currently held, with `cost.minimum` (20)
// read as a FLOOR ON WHAT MAY BE SPENT, not a cap and not a per-level-scaled
// number. `manaCostReduction` has NO EFFECT on this path at all — not even
// the usual floor-at-1 rule, because there is no per-level formula for it to
// apply to. `costOf` returns `max(actor.mana, cost.minimum)`: at
// `actor.mana >= minimum` this is exactly `actor.mana` (spend it all); below
// `minimum` it reports an amount the actor cannot afford, so
// `actors.canAfford()` correctly refuses the cast rather than letting a
// sub-floor mana pool spend a partial amount. `damagePerManaSpent` (the fire
// damage this cost pays for, `extra.manaConversion`) is therefore constant
// per level regardless of how much mana was actually spent — the assertion
// `05` §12.3 asks for, and `tests/skills/cost.test.js` checks it at spends of
// 20, 100 and 354.
//
// ---------------------------------------------------------------------------
// `actor.cooldowns` — the recycle hazard and its generation-stamp fix
// ---------------------------------------------------------------------------
// `01-data-model.md:311` contracts the field as `Map<string skillId, int
// stepIndex>`, preallocated once per pool slot by `src/actors/pool.js`
// (`createActorRecord`) and, per that same file's own comment,
// `resetActorRecord` deliberately never calls `cooldowns.clear()` — `Map.
// prototype.clear()` allocates even on an empty map (measured in this
// project, `ARCHITECTURE.md`'s allocation discipline), so clearing on every
// recycle is not available. Left unaddressed, a monster spawning into a
// pool slot whose PREVIOUS occupant used `ram_charge` two seconds ago would
// read a stale, still-live cooldown entry for a skill it may not even have.
//
// The fix here is generation-stamping, folded into the SAME integer the Map
// contract already promises rather than widening the value to a `{step,
// generation}` tuple (which would break the documented `int stepIndex`
// shape): `encodeCooldownStamp(generation, readyStep) = generation *
// COOLDOWN_GEN_SCALE + readyStep`. Reading back checks the decoded
// generation against `actor.generation` (bumped by `pool.js#release()` on
// every recycle, `01` §11.2 rule 5) and treats a mismatch as "no cooldown" —
// exactly the same outcome an absent Map entry produces, with no `.delete()`
// and no `.clear()` involved. `COOLDOWN_GEN_SCALE = 2**32` gives `readyStep`
// a safe range up to ~4.29 billion steps (~2.27 years of unbroken 60 Hz
// simulation — the field is a step COUNT, not a duration, and the game does
// not persist it across a reload) and `generation` a safe range up to
// `Number.MAX_SAFE_INTEGER / 2**32 ≈ 2.1 million` recycles of a SINGLE pool
// slot before two encoded stamps could collide — a monster pack respawning
// through one specific slot roughly once a second, nonstop, for over three
// weeks straight. Both bounds are generous past any plausible session; see
// this ticket's report for the arithmetic and why a smaller scale (favouring
// more generations) was rejected — `readyStep` genuinely needs the larger
// share, since it is compared directly against `ctx.time.step`, a quantity
// that only grows for the life of the process.
//
// `Map.get`/`Map.set` on an ALREADY-PRESENT key never allocates (V8); the
// only genuine allocation is the first time a given `skillId` is inserted
// for a given actor — bounded at 30 (the fixed skill roster), the same
// "bounded key set, not a leak" argument `01-data-model.md`'s own comment on
// the field makes. `tests/skills/cost.perf.test.js` measures both
// `startCooldown`/`cooldownRemainingSteps` at N >= 1e6 after that one-time
// warm-up and finds 0 B/call.

/** @typedef {{base:number, perLevel:number, cap?:number}} LevelCurve */

/**
 * Evaluates a `{base, perLevel, cap?}` level curve at effective level `L`:
 * `base + perLevel × (L − 1)`, per `05-skills.md` §1.3 ("row 1 is always the
 * bare base"). `cap`, where present, is always an upper bound on a growing
 * curve (every `cap` in `src/skills/data/skills.js` pairs with a
 * non-negative `perLevel`) — `Math.min` unconditionally.
 * @param {LevelCurve|null} curve
 * @param {number} level effective skill level, `slvl`
 * @returns {number} 0 if `curve` is `null` (a skill with no such number)
 */
export function levelValue(curve, level) {
  if (!curve) return 0;
  let v = curve.base + curve.perLevel * (level - 1);
  if (curve.cap !== undefined && curve.cap !== null && v > curve.cap) v = curve.cap;
  return v;
}

// ===========================================================================
// Cost — `02-api-contracts.md` §10 `costOf`, `11-flows.md` §5.3 step 1
// ===========================================================================

/**
 * Cost computation. `SkillsSystem#costOf` (`./index.js`) passes its own
 * shared scratch object as `out` (`02-api-contracts.md` §10: `Alloc: no`) —
 * omit `out` for a standalone/test call and a fresh `{resource, amount}` is
 * allocated once for that call only.
 * @param {object} def `SkillDefinition`
 * @param {number} effectiveLevel
 * @param {object} actor needs `actor.mana` (only for the `'all'` path) and
 *   `actor.stats.manaCostReduction` (only for `resource === 'mana'`)
 * @param {{resource: string|null, amount: number}} [out]
 * @returns {{resource: string|null, amount: number}}
 */
export function computeCost(def, effectiveLevel, actor, out) {
  if (!out) out = { resource: null, amount: 0 };
  const c = def.cost;
  if (!c.resource) { out.resource = null; out.amount = 0; return out; }

  // essence_burn only — see the file header. Bypasses the base+perLevel
  // formula and `manaCostReduction` entirely; "the cost is not a number, it
  // is the pool" (05 §12.3).
  if (c.base === 'all') {
    const current = (actor && actor.mana) || 0;
    const minimum = c.minimum || 0;
    out.resource = c.resource;
    out.amount = Math.max(current, minimum);
    return out;
  }

  let amount = c.base + c.perLevel * (effectiveLevel - 1);
  if (c.minimum !== null && c.minimum !== undefined && amount < c.minimum) amount = c.minimum;

  if (c.resource === 'mana') {
    const mcr = (actor && actor.stats && actor.stats.manaCostReduction) || 0;
    amount = amount * (1 - mcr / 100);
    if (amount < 1) amount = 1; // "floored at 1" — 05 §1.3
  }
  // Rage and Resonance: no manaCostReduction, no floor-at-1 — read verbatim
  // once the per-level `minimum` (if any) has been applied above.

  out.resource = c.resource;
  out.amount = amount;
  return out;
}

// ===========================================================================
// Cooldown — `02-api-contracts.md` §10 `cooldownRemaining`, S4
// ===========================================================================

/**
 * Pure cooldown-seconds computation for a given effective level — the S4
 * floors (`ram_charge` 4.0, `ashen_step` 1.8, `phase_leap` 2.5,
 * `thunder_step` 3.0, `last_stand` 50) fall out of `cooldown.minimum`
 * exactly the way `cost.minimum` does above.
 * @param {object} def `SkillDefinition`
 * @param {number} effectiveLevel
 * @returns {number} seconds, >= 0
 */
export function cooldownOf(def, effectiveLevel) {
  const cd = def.cooldown;
  let seconds = cd.base + cd.perLevel * (effectiveLevel - 1);
  if (cd.minimum !== null && cd.minimum !== undefined && seconds < cd.minimum) seconds = cd.minimum;
  return seconds;
}

/** See the file header's "recycle hazard" section. `readyStep` must stay
 * well under this for the packed value to round-trip exactly in a float64 —
 * `Number.isSafeInteger` on the full stamp is asserted in the perf test's
 * warm-up, not on every call (that WOULD allocate a diagnostic string on
 * failure, which is fine off the hot path but not something to pay for every
 * `startCooldown`). */
export const COOLDOWN_GEN_SCALE = 2 ** 32;

/**
 * Packs `(generation, readyStep)` into the single integer
 * `actor.cooldowns` stores per skill, preserving the documented `Map<string,
 * int>` shape (`01-data-model.md:311`).
 * @param {number} generation `actor.generation` at write time
 * @param {number} readyStep `ctx.time.step` at which the skill becomes usable
 * @returns {number}
 */
export function encodeCooldownStamp(generation, readyStep) {
  return generation * COOLDOWN_GEN_SCALE + readyStep;
}

/**
 * Writes a cooldown. Not a `02-api-contracts.md` §10 row itself — `cast()`
 * (`05` §14 step 3+, a later ticket, `11-flows.md` §5.3 step 4:
 * `actor.cooldowns.set(skillId, now + round(cooldown × 60))`) is the real
 * call site; this function IS that write, extracted here so it carries the
 * generation stamp from day one and so this ticket's own tests can exercise
 * `cooldownRemainingSteps` without needing `cast()` to exist yet.
 * @param {object} actor
 * @param {string} skillId
 * @param {number} seconds
 * @param {number} currentStep `ctx.time.step`
 */
export function startCooldown(actor, skillId, seconds, currentStep) {
  const readyStep = currentStep + Math.round(seconds * 60);
  actor.cooldowns.set(skillId, encodeCooldownStamp(actor.generation, readyStep));
}

/**
 * Reads `actor.cooldowns`, generation-checked. Returns `0` for "no cooldown"
 * — an absent key, a stamp from a previous generation (the recycle hazard,
 * treated as absent without ever calling `.clear()`/`.delete()`), or a
 * `readyStep` already in the past — exactly the three cases that must all
 * mean "usable now".
 * @param {object} actor
 * @param {string} skillId
 * @param {number} currentStep `ctx.time.step`
 * @returns {number} steps remaining, >= 0
 */
export function cooldownRemainingSteps(actor, skillId, currentStep) {
  const cds = actor.cooldowns;
  if (!cds) return 0;
  const stamp = cds.get(skillId);
  if (stamp === undefined) return 0;

  const generation = Math.floor(stamp / COOLDOWN_GEN_SCALE);
  if (generation !== actor.generation) return 0; // previous occupant's stale entry

  const readyStep = stamp - generation * COOLDOWN_GEN_SCALE;
  const remaining = readyStep - currentStep;
  return remaining > 0 ? remaining : 0;
}

// ===========================================================================
// Rage / mana / Resonance accounting — the R1/R2 readings, manaReturnPercent,
// resonanceOnHit (`05` §1.6, `03` §2.4)
// ===========================================================================
//
// These are the literal per-EVENT amounts `src/actors/vessels.js`'s own file
// header names as "combat/skills' business" — the two clamp-and-add
// primitives (`addRage`/`addResonance`) already live there (ACTR-8); the
// amount handed to them, and the RULE for how many times per action it is
// handed over, lives here.
//
// R1 (05 §1.6): one rage award per ACTION, credited on the first landed
// hit, regardless of how many targets the action's shape resolved against.
// **Enforced by API shape, not by a runtime guard**: there is deliberately
// no `targetCount` parameter anywhere below — `rageForLandedAction` returns
// the SAME amount whether the caller's action hit one body or eight, so the
// per-target-award bug 05 §12.1 describes (`whirlwind` funding itself at
// `6 × 3 / 0.55 = 32.7 rage/s`) is structurally unreachable through this
// function's signature; there is no argument slot for a caller to multiply
// by. The "once per action, not once per landed hit within the action" half
// of the discipline still depends on the CALLER (SKIL-3/SKIL-7's
// `combat:hit-request`/`actor:damage` handling) invoking this exactly once
// per action — this file cannot see how many hits the caller resolved, only
// that it was never handed a count to multiply by in the first place.
//
// R2 (05 §1.6): a channel earns at the actor's `attackInterval` cadence, not
// its own tick cadence. `whirlwind` ticks damage every 0.55 s (D-05-1) but
// must only call `rageForLandedAction` at the cadence `combat.attackInterval`
// reports for the actor's weapon — passing that interval (not the channel's
// tick period) into `rageIncomeRate` below is what reproduces `03` §2.4's
// `0.778146 × 6 / 0.675 = 6.9161 rage/s` and the resulting `−5.0839 rage/s`
// net during a channel.

/** `03-combat-math.md` §2.4: "Landed melee hit dealt +6 (+ rageOnHit)". */
export const RAGE_PER_LANDED_ACTION = 6;
/** "Hit taken (any damage > 0) +4 (+ rageOnTakeHit)". */
export const RAGE_PER_HIT_TAKEN = 4;
/** "Kill credited +8". */
export const RAGE_PER_KILL = 8;
/** "`last_stand` trigger +40". */
export const RAGE_LAST_STAND_GRANT = 40;
/** "Landed melee hit dealt +1 (+ resonanceOnHit, fractional, floored on read)". */
export const RESONANCE_PER_LANDED_HIT = 1;

/**
 * Rage for ONE landed action — R1. Call exactly once per action that landed
 * at least one hit, never once per target.
 * @param {object} actor needs `actor.stats.rageOnHit` (0 if absent/unset)
 * @returns {number}
 */
export function rageForLandedAction(actor) {
  const bonus = (actor && actor.stats && actor.stats.rageOnHit) || 0;
  return RAGE_PER_LANDED_ACTION + bonus;
}

/** @param {object} actor needs `actor.stats.rageOnTakeHit` @returns {number} */
export function rageForHitTaken(actor) {
  const bonus = (actor && actor.stats && actor.stats.rageOnTakeHit) || 0;
  return RAGE_PER_HIT_TAKEN + bonus;
}

/**
 * Resonance for ONE landed hit. `rune_strike` grants no extra charge beyond
 * this (`extra.manaReturnMultiplier` only touches mana return, D-05-2) —
 * every landed melee hit, `rune_strike` included, grants exactly this.
 * @param {object} actor needs `actor.stats.resonanceOnHit` (fractional; the
 *   caller floors on read, per `03` §2.4 — this function does not floor,
 *   so the fractional carry survives in `actor.resonance` across hits)
 * @returns {number}
 */
export function resonanceForLandedHit(actor) {
  const bonus = (actor && actor.stats && actor.stats.resonanceOnHit) || 0;
  return RESONANCE_PER_LANDED_HIT + bonus;
}

/**
 * `03-combat-math.md` §2.4: `manaReturned = physicalDamageDealt ×
 * manaReturnPercent / 100`. `rune_strike` doubles it for its own hit
 * (`extra.manaReturnMultiplier` on that record, D-05-2) — pass `2` as
 * `multiplier` for that one call site, `1` for every other landed weapon hit.
 * @param {number} physicalDamageDealt post-mitigation
 * @param {object} actor needs `actor.stats.manaReturnPercent`
 * @param {number} [multiplier]
 * @returns {number}
 */
export function manaReturnedFromHit(physicalDamageDealt, actor, multiplier = 1) {
  const pct = (actor && actor.stats && actor.stats.manaReturnPercent) || 0;
  return physicalDamageDealt * (pct / 100) * multiplier;
}

/**
 * Steady-state rage income, `hitChance × rageForLandedAction(actor) /
 * actionIntervalSeconds` — `03` §2.4's own worked formula
 * (`0.778146 × 6 / 0.675 = 6.9161`). A balance/verification utility, not a
 * per-step simulation primitive: `actionIntervalSeconds` is the actor's
 * `attackInterval` for both a normal attack AND, per R2, for a channel —
 * NEVER the channel's own tick period. Used by
 * `tests/skills/cost.test.js` and this ticket's §11 simulation scripts.
 * @param {object} actor
 * @param {number} hitChance 0..1
 * @param {number} actionIntervalSeconds
 * @returns {number} rage/s
 */
export function rageIncomeRate(actor, hitChance, actionIntervalSeconds) {
  if (!(actionIntervalSeconds > 0)) return 0;
  return (hitChance * rageForLandedAction(actor)) / actionIntervalSeconds;
}
