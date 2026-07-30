// src/actors/vessels.js
//
// ACTR-8 — the vitals: life/mana regeneration through a fractional-carry
// accumulator, Rage and Resonance in/out-of-combat drift, mana return,
// stamina's fields, and the `02-api-contracts.md` §7 "Stats and vessels"
// accessor row: `addLife`/`addMana`/`addRage`/`addResonance`/`spend`/
// `canAfford`/`lifeFraction`. `03-combat-math.md` §2.4 is this ticket's
// spec, verbatim; `01-data-model.md` §3.2 is the field vocabulary.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` scans `src/actors/` with
// `checkGlobals: true`). No `Math.random()` (ARCHITECTURE.md rule 4) — every
// function here is pure arithmetic on an already-spawned `Actor` record, no
// RNG input needed. No `three` import, no import from `src/core/` either
// (this file follows the same "zero imports beyond a sibling module" style
// `motion.js`/`stats.js` already established in this directory) — the one
// engine constant it needs, the fixed-step rate, is redeclared locally as
// `FIXED_HZ` rather than reaching into `src/core/engine.js#PHYSICS_HZ` for
// it, so this module stays exactly as self-contained as its two siblings.
//
// ---------------------------------------------------------------------------
// What this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: the seven accessor methods above, plus `integrateVessels(actor,
// step)` — the actual per-fixed-step simulation logic `11-flows.md`'s own
// frame table calls out as substep A3 ("Integrate vessels through
// `lifeAccum`/`manaAccum`: life regen, mana regen, rage decay out of combat,
// resonance decay, stamina"). `integrateVessels` is NOT one of
// `02-api-contracts.md` §7's named methods (nothing outside `actors` calls
// it — A3 is `actors`' own internal fixedUpdate substep, the same relationship
// `stats.js`'s `derive()`/`clampBlock()` have to `composeStats`, except those
// two stayed module-private because nothing outside `stats.js` needs them
// directly, whereas `integrateVessels` **does** need to be reachable from
// two places this ticket does not own: `src/actors/index.js`'s eventual
// `ActorsSystem.fixedUpdate` (A3's real call site) and this file's own test).
// It is exported for exactly that reason, the same way `stats.js` exports
// `composeStats` (also not a `02` §7 row by that exact name — `stats()` is
// the row, `composeStats()` is the engine underneath it) alongside the four
// methods that are. Wiring `integrateVessels` into `ActorsSystem.fixedUpdate`
// is `src/actors/index.js`'s job — not touched here (see the report).
//
// Does NOT own: the sprint control (speed multiplier, drain, the 0.5 s
// re-arm timer) — `03-combat-math.md` §2.4's own stamina section is "fully
// specified... `config.stamina` defaults to **false** and the sprint control
// is hidden while it is"; only the passive stamina regen path is implemented
// below (see "Stamina" section), and it needs no sprint state to exist
// (there is currently no code path that ever drains stamina, so "after 0.5 s
// without sprinting" is unconditionally true). Also does not own: the
// event-driven Rage/Resonance GAINS themselves (`+6` on a landed hit, `+4`
// on a hit taken, `+8` on a kill, `+40` on `last_stand`, `+1` on a landed
// hit for Resonance) — those are literal per-EVENT amounts `combat`/`skills`
// compute (not built yet) and hand to `addRage`/`addResonance` as a plain
// `amount`; this file only implements the two primitives themselves (add +
// clamp) and the passive OUT-OF-COMBAT DECAY, which is the one part of
// Rage/Resonance that genuinely runs every fixed step regardless of what
// combat/skills do.
//
// ---------------------------------------------------------------------------
// maxRage/maxResonance — composed by stats.js, not this file
// ---------------------------------------------------------------------------
// `03-combat-math.md` §2.4 states `maxRage` base **100** and `maxResonance`
// base **3**. `stats.js`'s `CLASS_TABLE` carries `baseRage`/`baseResonance`
// and its `composeStats` step 2 sums them into `StatBlock.maxRage`/
// `.maxResonance` like any other flat base contribution, so a real composed
// Ravager reads `maxRage === 100` and a real composed Runeblade reads
// `maxResonance === 3` (both capped 200/8 by the normal `clamp()` pass, same
// as every other stat). `addRage`/`addResonance`/`spend`/`canAfford` simply
// read `stats(actor).maxRage`/`.maxResonance` faithfully — nothing to inject
// here, unlike life regen below.

import { stats } from './stats.js';

// ---------------------------------------------------------------------------
// Constants — `03-combat-math.md` §2.4, verbatim numbers, named once
// ---------------------------------------------------------------------------

/** Fixed simulation rate. Mirrors `src/core/engine.js#PHYSICS_HZ` (also 60)
 * without importing it — see the file header for why. */
const FIXED_HZ = 60;

/** `03-combat-math.md` §2.4: "Life regeneration... maxLife × 0.006". Also
 * every player class's `CLASS_TABLE.lifeRegenRate` (`stats.js`) — the same
 * number, restated here as the default RANK rate `effectiveLifeRegenRate`
 * below needs as a bare constant (monsters have no `CLASS_TABLE` row at
 * all to read it back off of). */
const LIFE_REGEN_RATE_NORMAL = 0.006;
/** `03-combat-math.md` §2.4: "boss and unique ranks use 0.004". */
const LIFE_REGEN_RATE_BOSS_UNIQUE = 0.004;

/** Rage: "Out of combat −8 / s". */
const RAGE_DECAY_PER_SECOND = 8;
/** Resonance: "Out of combat −1 per 3 s". */
const RESONANCE_DECAY_PER_SECOND = 1 / 3;
/** Stamina: "regen = 8/s, after 0.5 s without sprinting" — the 0.5 s re-arm
 * needs a sprint state that does not exist (see the file header), so this
 * constant is applied unconditionally; see "Stamina" below. */
const STAMINA_REGEN_PER_SECOND = 8;

/** `03-combat-math.md` §2.4: "'In combat' means `now − max(lastDamageStep,
 * lastDealtStep) < 4.0 s`." At 60 Hz that is exactly 240 steps —
 * `ARCHITECTURE.md`'s own worked example for this exact window. */
const COMBAT_WINDOW_STEPS = 4.0 * FIXED_HZ;

/** `01-data-model.md` line ~1160: `STATUS_BIT.poisoned = 1 << 1`. Not yet
 * implemented anywhere in `src/` (ACTR-9/10, not landed) — restated here as
 * the one bit this file needs to test, straight off the documented,
 * stable-by-contract bit assignment, not off a not-yet-existing
 * `hasStatus()` call (`02-api-contracts.md`'s own row for that method is
 * outside this ticket's file list too). Reading `actor.statusMask` for this
 * bit is exactly "ask the status system for the state" — `actor.statusMask`
 * IS that state, already allocated by `pool.js`, defaulting to 0 and
 * changed only once something actually applies `poisoned` — never assumed
 * absent. */
const POISONED_STATUS_BIT = 1 << 1;

/** The only resource keys `spend`/`canAfford` will act on — restricts a
 * caller to the actual vitals (`01-data-model.md` §2's own `life`/`mana`/
 * `rage`/`resonance`/`stamina` fields), never an arbitrary actor property
 * (an accumulator, a max*, a stat) a typo could otherwise reach and corrupt. */
const KNOWN_RESOURCES = new Set(['life', 'mana', 'rage', 'resonance', 'stamina']);

// ---------------------------------------------------------------------------
// Life regeneration — the fractional-carry accumulator, this ticket's
// acceptance criterion
// ---------------------------------------------------------------------------

/**
 * The effective life-regen rate (life/s) for `actor`, given its already-composed
 * `statBlock`. `stats.js#derive()` already folds `lifeRegenPercent` into
 * `statBlock.lifeRegen` (`lifeRegen = Σ flat + maxLife × lifeRegenPercent/100`),
 * and `01-data-model.md` §3.2's own note is that `lifeRegenPercent` IS how the
 * class base rate (0.6 %/s) gets carried — a real class actor's composed
 * `lifeRegenPercent` is therefore never 0, it is at least the class's own
 * `0.6`, plus whatever equipment/skills/status/difficulty added on top.
 *
 * A PREVIOUS version of this function branched on `actor.kind === 'player'`
 * to decide whether that base rate was already baked in. That was wrong:
 * `stats.js` looks the class row up by `actor.classId` alone (`composeStats`
 * step 2's `CLASS_TABLE[actor.classId]`) — it does not consult `actor.kind`
 * at all. An actor with a real `classId` but `kind` left unset/non-'player'
 * still gets the class base rate baked into `lifeRegenPercent`, and the old
 * `kind`-gated logic then added `maxLife × 0.006` a SECOND time on top —
 * verified as a genuine 2x-rate bug (a Ravager composed via the real
 * `composeStats`, `kind` merely left at its `createActorRecord` default,
 * measured at exactly double the composed `stats.lifeRegen`; see this
 * ticket's report).
 *
 * The robust fix reads the ACTUAL composed `lifeRegenPercent` back off the
 * StatBlock instead of guessing from `kind`/`classId`: `alreadyBaked =
 * statBlock.lifeRegenPercent / 100`. For any actor whose class already
 * baked in at least the rank-appropriate rate (every real player class,
 * always exactly 0.006), `rankRate - alreadyBaked <= 0`, clamped to exactly
 * 0 — never subtracting, only ever topping up a shortfall — so
 * `statBlock.lifeRegen` passes through completely unchanged, equipment/skill
 * regen-percent bonuses included exactly once. For a monster (`classId ===
 * null` -> `ZERO_CLASS` -> `lifeRegenPercent === 0`), `alreadyBaked` is 0 and
 * the full rank rate (0.006 normal / 0.004 boss+unique) is injected, exactly
 * matching "monsters use the same rate; boss and unique ranks use 0.004".
 * @param {object} actor
 * @param {object} statBlock
 * @returns {number} life / s, before the `poisoned` gate.
 */
function effectiveLifeRegenRate(actor, statBlock) {
  const rankRate = actor.rank === 'boss' || actor.rank === 'unique'
    ? LIFE_REGEN_RATE_BOSS_UNIQUE
    : LIFE_REGEN_RATE_NORMAL;
  const alreadyBaked = statBlock.lifeRegenPercent / 100;
  const shortfall = rankRate - alreadyBaked;
  const injection = shortfall > 0 ? shortfall : 0; // never subtract what stats.js already gave
  return statBlock.lifeRegen + statBlock.maxLife * injection;
}

/**
 * Integrates one fixed step of a per-second `rate` into `actor[valueKey]`,
 * carrying the fractional remainder in `actor[accumKey]` — `03-combat-math.md`
 * §2.4's own instruction, named after its own example field
 * (`actor.lifeAccum`). Moves a WHOLE point out of the accumulator only once
 * one has actually accrued: `Math.floor` for a positive carry, `Math.ceil`
 * for a negative one (a draining rate, e.g. a negative `lifeRegenPercent`) —
 * both round the extracted whole *toward zero's opposite side is never
 * taken*, i.e. never `Math.round`/never a `ceil` on a positive carry —
 * so a long run delivers exactly `floor(rate × seconds)` whole points, never
 * one more. If the whole-point move would cross `0` or `maxValue`, the value
 * clamps AND the leftover accumulator is discarded rather than banked — a
 * regen tick at full life must not let a hidden fractional credit build up
 * that would burst out the instant something drops the actor below max;
 * this is the same "never manufacture points" rule applied to the boundary,
 * not just to the open interior.
 * @param {object} actor
 * @param {string} valueKey e.g. `'life'`
 * @param {string} accumKey e.g. `'lifeAccum'`
 * @param {number} perSecondRate
 * @param {number} maxValue
 */
function tickAccumulatedResource(actor, valueKey, accumKey, perSecondRate, maxValue) {
  if (perSecondRate === 0) return; // nothing to integrate; leave the accumulator untouched
  let accum = actor[accumKey] + perSecondRate / FIXED_HZ;
  let whole = 0;
  if (accum >= 1) whole = Math.floor(accum);
  else if (accum <= -1) whole = Math.ceil(accum);
  if (whole === 0) {
    actor[accumKey] = accum;
    return;
  }
  accum -= whole;
  let v = actor[valueKey] + whole;
  if (v > maxValue) {
    v = maxValue;
    accum = 0; // do not bank a carry the cap already discarded
  } else if (v < 0) {
    v = 0;
    accum = 0;
  }
  actor[valueKey] = v;
  actor[accumKey] = accum;
}

// ---------------------------------------------------------------------------
// Rage / Resonance — in-combat gate, out-of-combat decay
// ---------------------------------------------------------------------------

/** `03-combat-math.md` §2.4: "'In combat' means `now − max(lastDamageStep,
 * lastDealtStep) < 4.0 s`." Both fields are already on every `Actor` record
 * (`pool.js`, defaulting to `-1`, "never yet") — read directly, never
 * inferred from a clock. */
function isInCombat(actor, step) {
  const lastCombatStep = Math.max(actor.lastDamageStep, actor.lastDealtStep);
  return step - lastCombatStep < COMBAT_WINDOW_STEPS;
}

/**
 * Decays `actor[key]` toward 0 at `perSecondRate`, but only while `!inCombat`
 * — "no passive gain and no decay while in combat" (Rage) / the equivalent
 * Resonance rule. Neither Rage nor Resonance has a dedicated `*Accum` field
 * on the `Actor` record (unlike `life`/`mana` — only `lifeAccum`/`manaAccum`
 * are reserved in `pool.js`, and that file is not this ticket's to extend).
 * Resonance's own spec line sanctions exactly this: its `+1` gain is
 * "fractional, floored on read" — the field itself carries the fraction,
 * floored only where the spec says to (`spend('all')`, below). This
 * function extends the same treatment to Rage by the same reasoning
 * (neither field is documented as strictly integer, and no accumulator
 * exists to split the fraction out into) — see this ticket's report.
 * @param {object} actor
 * @param {string} key `'rage'` or `'resonance'`
 * @param {number} perSecondRate a positive decay rate
 * @param {boolean} inCombat
 */
function decayOutOfCombat(actor, key, perSecondRate, inCombat) {
  if (inCombat) return;
  const v = actor[key];
  if (v <= 0) return;
  const next = v - perSecondRate / FIXED_HZ;
  actor[key] = next < 0 ? 0 : next;
}

// ---------------------------------------------------------------------------
// integrateVessels — one fixed step, every vessel, `11-flows.md` A3
// ---------------------------------------------------------------------------

/**
 * One fixed step's worth of passive vessel integration for `actor`: life
 * regen (through `lifeAccum`, gated to 0 while `poisoned`, never for a dead
 * actor), mana regen (through `manaAccum`, NOT gated by `poisoned`), Rage and
 * Resonance out-of-combat decay, and stamina's passive regen (the sprint
 * drain path is not built — see the file header). Never allocates: every
 * write is a numeric field mutation on the already-live `actor` record.
 * @param {object} actor a live `Actor` record (`pool.js`'s shape).
 * @param {number} step the current simulation step (`ctx.time.step` at the
 *   real call site — never a clock read; this function takes it as a plain
 *   argument specifically so it never has to touch `ctx` at all).
 */
export function integrateVessels(actor, step) {
  if (!actor || actor.dead) return; // "Never regenerates a dead actor" (life) — extended to every vessel: a corpse is not simulated.

  const s = stats(actor);

  const poisoned = (actor.statusMask & POISONED_STATUS_BIT) !== 0;
  const lifeRate = poisoned ? 0 : effectiveLifeRegenRate(actor, s);
  tickAccumulatedResource(actor, 'life', 'lifeAccum', lifeRate, s.maxLife);

  // Mana: "Not blocked by poisoned" — no gate here.
  tickAccumulatedResource(actor, 'mana', 'manaAccum', s.manaRegen, s.maxMana);

  const inCombat = isInCombat(actor, step);
  decayOutOfCombat(actor, 'rage', RAGE_DECAY_PER_SECOND, inCombat);
  decayOutOfCombat(actor, 'resonance', RESONANCE_DECAY_PER_SECOND, inCombat);
  // Defensive re-clamp: a shrinking maxRage/maxResonance (gear swap, a future
  // ticket) must not leave a stale value above the new cap sitting around
  // between explicit addRage/addResonance calls.
  if (actor.rage > s.maxRage) actor.rage = s.maxRage;
  if (actor.resonance > s.maxResonance) actor.resonance = s.maxResonance;

  // Stamina — passive regen only (see the file header: no sprint control,
  // so there is no drain path and the "0.5 s without sprinting" condition is
  // unconditionally satisfied). `s.staminaRegen` is the StatBlock's flat
  // bonus layer (equipment/skills); `STAMINA_REGEN_PER_SECOND` is the base.
  let stamina = actor.stamina + (STAMINA_REGEN_PER_SECOND + s.staminaRegen) / FIXED_HZ;
  if (stamina > s.maxStamina) stamina = s.maxStamina;
  else if (stamina < 0) stamina = 0;
  actor.stamina = stamina;
}

// ---------------------------------------------------------------------------
// 02-api-contracts.md §7 "Stats and vessels" — the seven accessor methods
// ---------------------------------------------------------------------------

/**
 * Adds `amount` to `actor[key]`, clamped to `[0, maxValue]`, and returns the
 * ACTUAL delta applied (never the requested `amount` verbatim once a clamp
 * bites) — the shared shape behind `addLife`/`addMana`/`addRage`/
 * `addResonance`. A dead actor never gains anything through this path either
 * (mirrors `integrateVessels`'s own guard).
 * @param {object} actor
 * @param {string} key
 * @param {number} amount
 * @param {number} maxValue
 * @returns {number}
 */
function addClamped(actor, key, amount, maxValue) {
  if (!actor || actor.dead) return 0;
  const before = actor[key];
  let v = before + amount;
  if (v > maxValue) v = maxValue;
  else if (v < 0) v = 0;
  actor[key] = v;
  return v - before;
}

/** `addLife(actor, amount, sourceId) => number` — actual amount applied.
 * `sourceId` is accepted per the documented signature (a future `actor:heal`
 * event's source, `ARCHITECTURE.md`'s event table) but not read here —
 * emitting that event needs `ctx.events`, which this pure module does not
 * touch (the same split `stats.js#markDirty` documents for `stats:dirty`). */
// eslint-disable-next-line no-unused-vars
export function addLife(actor, amount, sourceId) {
  return addClamped(actor, 'life', amount, stats(actor).maxLife);
}

/** `addMana(actor, amount) => number`. */
export function addMana(actor, amount) {
  return addClamped(actor, 'mana', amount, stats(actor).maxMana);
}

/** `addRage(actor, amount) => number`. The `+6`/`+4`/`+8`/`+40` event
 * amounts (`03-combat-math.md` §2.4's own table) are `combat`/`skills`'
 * business — this is only the add-and-clamp primitive they call. */
export function addRage(actor, amount) {
  return addClamped(actor, 'rage', amount, stats(actor).maxRage);
}

/** `addResonance(actor, amount) => number`. Same split as `addRage` — the
 * literal `+1` per landed hit is combat's call site, not this function's
 * business. */
export function addResonance(actor, amount) {
  return addClamped(actor, 'resonance', amount, stats(actor).maxResonance);
}

/**
 * `canAfford(actor, resource, amount) => boolean`. Read-only; never mutates.
 * An unrecognised `resource` string fails safe (`false`) rather than reading
 * an arbitrary, possibly-unrelated actor field.
 * @param {object} actor
 * @param {string} resource
 * @param {number} amount
 * @returns {boolean}
 */
export function canAfford(actor, resource, amount) {
  if (!KNOWN_RESOURCES.has(resource)) return false;
  return actor[resource] >= amount;
}

/**
 * `spend(actor, resource, amount|'all') => boolean` — atomic; `false` and NO
 * mutation if short. `'all'` is `blade_seal`'s own contract
 * (`03-combat-math.md` §2.4, `02-api-contracts.md` §7's own row): requires
 * `resource >= 1`, reads `spent = floor(resource)`, subtracts `spent` and
 * KEEPS the fractional remainder — "the cast spends the whole bar" in
 * resource terms, never the fraction `resonanceOnHit` already banked.
 * @param {object} actor
 * @param {string} resource
 * @param {number | 'all'} amount
 * @returns {boolean}
 */
export function spend(actor, resource, amount) {
  if (!KNOWN_RESOURCES.has(resource)) return false;
  if (amount === 'all') {
    const spent = Math.floor(actor[resource]);
    if (spent < 1) return false;
    actor[resource] -= spent;
    return true;
  }
  if (!(actor[resource] >= amount)) return false;
  actor[resource] -= amount;
  return true;
}

/**
 * `lifeFraction(actor) => number` — `0..1`. Guards a non-positive `maxLife`
 * (should never happen post-composition, `01` §3.2's own `1..40000` range,
 * but a defensive `0` beats a `NaN`/`Infinity` leaking into a health bar).
 * @param {object} actor
 * @returns {number}
 */
export function lifeFraction(actor) {
  const maxLife = stats(actor).maxLife;
  if (!(maxLife > 0)) return 0;
  const f = actor.life / maxLife;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

// Exported for tests that want to poke the same bit this file reads for
// `poisoned`, without duplicating the magic number independently.
export { POISONED_STATUS_BIT };
