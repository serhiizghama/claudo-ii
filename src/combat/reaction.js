// src/combat/reaction.js
//
// CMBT-5 — `03-combat-math.md` §7.11 (hit recovery), §7.12 (knockback),
// §7.13 (hit-stop). Backlog correction D-14: E7 and E11 are this ticket's;
// E8 (chill accumulation) went to CMBT-4, E9 (rage) is CMBT-7's, E10 (XP) is
// CMBT-6's.
//
// O-51's assembly rule: this file exports plain functions and imports
// nothing from `./packet.js`; `packet.js` imports this file and wires
// `applyReaction` into `CombatSystem#resolve()` (see that file's own
// "CMBT-5" comment block) — the same one-way sibling-import shape
// `status.js`/`resolve.js` already established for this directory.
//
// ---------------------------------------------------------------------------
// Why the wiring lives in `packet.js#resolve()`, not inside `resolve.js`
// ---------------------------------------------------------------------------
// `resolve.js`'s own R14(g)/(h) are commented no-op seams — but `resolve.js`
// is NOT one of this ticket's three files, and `resolve()`'s `env` bag
// (built once in `CombatSystem.init()`) is the ONLY place both `packet`
// (needed for `packet.knockback`, the % chance) and the freshly-populated
// `result` (needed for `result.total`/`.crit`/`.killed`) are simultaneously
// in scope outside `resolve.js` itself. `CombatSystem#resolve(packet,
// target, out)` in `packet.js` already calls `resolveDamage(packet, target,
// env, result)` and returns its output — this ticket's only edit there is
// to capture that return value and pass it, `packet`, and `env` through
// `applyReaction` before returning, exactly the same shape CMBT-4's
// `applyStatusFromPacket`/`onActorDamageForChill` already established for
// "combat's own math needs to run after resolve.js hands back a result, but
// resolve.js itself is out of scope."
//
// `applyDirect()` (mitigation-free scripted damage) is deliberately NOT
// wired to `applyReaction` — it has no `DamagePacket` at all (no
// `packet.knockback` to roll against), and §7.11/7.12/7.13 read as
// properties of a *combat hit*, not of arbitrary scripted/DoT damage. Flagged
// in this ticket's report as a decision, not an oversight.
//
// ---------------------------------------------------------------------------
// The actors-wiring gap (pre-existing — `src/actors/index.js` is not in
// this ticket's file list, same gap CMBT-3/CMBT-4 already documented)
// ---------------------------------------------------------------------------
// `ActorsSystem` (ACTR-1/2, accepted) forwards only Lifecycle + Transform/
// motion today. `setState`/`cancelAction` (`src/actors/action.js`, ACTR-9),
// `hitStop` (no file owns it yet — `src/actors/motion.js`'s own header
// documents `applyImpulse` as unbuilt for the identical reason: it needs an
// `ActorsSystem.fixedUpdate` this milestone hasn't added) are ALL absent
// from the live `ctx.get('actors')` today. Every call this file makes into
// `env.actorsSystem` is therefore guarded — `typeof actorsSystem.X ===
// 'function'` — the same discipline `status.js`'s `tryApplyStatus` already
// established. Real, correctly-shaped calls; dormant until that wiring
// ticket lands. `applyReaction`'s own unit tests below exercise the REAL
// `src/actors/action.js` functions through a stub `actorsSystem` (mirroring
// `tests/combat/status.test.js`'s own stub), so the decision logic itself
// is proven correct independent of that gap.
//
// ---------------------------------------------------------------------------
// Zero-allocation / determinism discipline
// ---------------------------------------------------------------------------
// Every pure formula below takes plain number/boolean arguments, never an
// options object (an `{}` default parameter would allocate on every
// no-args call). `computeKnockbackDirection`'s result is a single
// module-level scratch object, mutated in place and returned by reference —
// never a fresh literal per call (same shape as `packet.js`'s
// `_sourceRefScratch`/`action.js`'s scratch `Int32Array`s). `Math.hypot` is
// never used (direction normalisation uses `Math.sqrt(x*x+z*z)`, per this
// ticket's own rule). `Map` is not used anywhere. The one RNG draw
// (knockback's % chance) goes through `env.rng` — `combat`'s existing single
// fork, never re-forked here.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file.

/** `01-data-model.md` §1: fixed simulation rate. Redeclared locally rather
 * than imported from `src/core/` — `src/actors/action.js`/`status.js`'s own
 * `FIXED_HZ` constants are the precedent for this exact situation (the one
 * engine constant a self-contained subsystem file needs). */
const FIXED_HZ = 60;

/** `01-data-model.md` §1.3's `ACTOR_KIND.player` value and §1.3's two
 * `ACTOR_RANK` values this ticket reads. Redeclared, not imported — reading
 * `src/actors/data/*.js` from `src/combat/` would be the cross-subsystem
 * import `ARCHITECTURE.md` rule 2 forbids (the same reasoning
 * `resolve.js`'s header already gives for its own `TEAM_NEUTRAL`/
 * `INVULNERABLE_FLAG_BIT` redeclarations). */
const PLAYER_KIND = 'player';
const RANK_BOSS = 'boss';
const RANK_UNIQUE = 'unique';

/** `01-data-model.md` §2.1: `ACTOR_FLAG.noKnockback = 1 << 2`. Redeclared —
 * see the constant above for why. */
const NO_KNOCKBACK_FLAG_BIT = 1 << 2;

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// ---------------------------------------------------------------------------
// §7.11 — Hit recovery (E7)
// ---------------------------------------------------------------------------

/** `03 §7.11`: "damageThisHit > 0.05 × target.maxLife" triggers hitstun. */
export const HITSTUN_TRIGGER_PERCENT = 5;

/** `03 §7.11`'s formula constants, verbatim: `clamp(0.40 / (1 + FHR/100),
 * 0.12, 0.40)`. */
export const HITSTUN_BASE_SECONDS = 0.40;
export const HITSTUN_MIN_SECONDS = 0.12;
export const HITSTUN_MAX_SECONDS = 0.40;

/** `03 §7.11`: "the 0.50 s immunity window... Bosses and uniques have
 * fasterHitRecovery = 400 and a 1.20 s immunity window" — a RANK-driven
 * immunity duration, independent of the FHR-driven clamp above. */
export const HITSTUN_IMMUNITY_SECONDS = 0.50;
export const HITSTUN_IMMUNITY_SECONDS_BOSS_UNIQUE = 1.20;

/** `03 §7.11`'s formula, verbatim. E7.1-E7.5 reproduce this to 1e-4.
 * @param {number} fasterHitRecovery `StatBlock.fasterHitRecovery`
 * @returns {number} seconds
 */
export function computeHitRecoveryTime(fasterHitRecovery) {
  const raw = HITSTUN_BASE_SECONDS / (1 + fasterHitRecovery / 100);
  return clamp(raw, HITSTUN_MIN_SECONDS, HITSTUN_MAX_SECONDS);
}

/** `03 §7.11`'s trigger test, a strict `>` (verified against the ticket's
 * own threshold note: 8.0/165 = 4.85% does NOT trigger, 8.5/165 = 5.15%
 * does — both sides of the `5%` boundary).
 * @param {number} damageThisHit
 * @param {number} maxLife
 * @returns {boolean}
 */
export function hitstunTriggers(damageThisHit, maxLife) {
  return maxLife > 0 && damageThisHit > (HITSTUN_TRIGGER_PERCENT / 100) * maxLife;
}

/** `03 §7.11`: bosses/uniques get the longer immunity window; every other
 * rank gets the base one.
 * @param {string|null} rank `ACTOR_RANK`
 * @returns {number} seconds
 */
export function hitstunImmunityWindowSeconds(rank) {
  return (rank === RANK_BOSS || rank === RANK_UNIQUE)
    ? HITSTUN_IMMUNITY_SECONDS_BOSS_UNIQUE
    : HITSTUN_IMMUNITY_SECONDS;
}

// ---------------------------------------------------------------------------
// §7.12 — Knockback (E11)
// ---------------------------------------------------------------------------

/** `03 §7.12`'s formula constants, verbatim: `0.55 × (1 + knockback/100) ×
 * clamp(1 − (mass − 70)/200, 0.25, 1.5)`. */
export const KNOCKBACK_BASE_DISTANCE = 0.55;
export const KNOCKBACK_MASS_REFERENCE = 70;
export const KNOCKBACK_MASS_DIVISOR = 200;
export const KNOCKBACK_MASS_FACTOR_MIN = 0.25;
export const KNOCKBACK_MASS_FACTOR_MAX = 1.5;

/** `03 §7.12`: "uniques take 0.25 × distance; the boss is immune." */
export const KNOCKBACK_UNIQUE_MULTIPLIER = 0.25;

/** `03 §7.12`: "Applied as a velocity impulse over 0.18 s." */
export const KNOCKBACK_IMPULSE_SECONDS = 0.18;

/** `03 §7.12`'s mass term in isolation — exercised directly by this
 * ticket's report ("prove the clamp is real"): mass 400 alone drives the
 * raw term negative (`1 - 330/200 = -0.65`) before the floor clamps it to
 * `0.25`.
 * @param {number} mass kg
 * @returns {number}
 */
export function computeMassFactor(mass) {
  return clamp(1 - (mass - KNOCKBACK_MASS_REFERENCE) / KNOCKBACK_MASS_DIVISOR, KNOCKBACK_MASS_FACTOR_MIN, KNOCKBACK_MASS_FACTOR_MAX);
}

/** `03 §7.12`'s full distance formula, plus the two override branches the
 * table text names: `noKnockback` (`ACTOR_FLAG.noKnockback`, or a caller's
 * own boss-immunity read) refuses outright (`0`, regardless of the formula
 * value); `rank === 'unique'` scales the result by `KNOCKBACK_UNIQUE_
 * MULTIPLIER`; `rank === 'boss'` is immune (`0`), same as `noKnockback`.
 * Plain positional numbers/booleans, never an options object — see the file
 * header on zero-allocation.
 * @param {number} knockback `packet.knockback`, a percent (0 in every E11
 *   row; only E11.3 is nonzero, at 100)
 * @param {number} mass kg
 * @param {boolean} [noKnockback] `ACTOR_FLAG.noKnockback` on the target
 * @param {string|null} [rank] `ACTOR_RANK`
 * @returns {number} metres
 */
export function computeKnockbackDistance(knockback, mass, noKnockback = false, rank = null) {
  if (noKnockback || rank === RANK_BOSS) return 0;
  const massFactor = computeMassFactor(mass);
  let distance = KNOCKBACK_BASE_DISTANCE * (1 + knockback / 100) * massFactor;
  if (rank === RANK_UNIQUE) distance *= KNOCKBACK_UNIQUE_MULTIPLIER;
  return distance;
}

/** Module-level scratch for `computeKnockbackDirection` — mutated in place,
 * never reallocated (see the file header). */
const _kbDirScratch = { x: 1, z: 0 };

/** Unit direction the target is pushed in: away from the attack's origin
 * (`packet.originX/Z` — populated once a real skill/projectile system
 * exists, `packet.js`'s own documented gap; today it is always `(0,0)`),
 * falling back to away-from-the-resolved-source position, falling back to
 * a fixed `+X` default for the fully degenerate case (both coincide with
 * the target, e.g. a test fixture at the origin). `Math.sqrt`, never
 * `Math.hypot` (this ticket's own rule). No E11 row exercises direction —
 * only distance magnitude — so this is a documented inference, not a
 * spec-tested value.
 * @param {object} packet
 * @param {object|null} source
 * @param {object} target
 * @returns {{x:number, z:number}} a reused scratch object
 */
export function computeKnockbackDirection(packet, source, target) {
  let dx = target.x - packet.originX;
  let dz = target.z - packet.originZ;
  if (dx === 0 && dz === 0 && source) {
    dx = target.x - source.x;
    dz = target.z - source.z;
  }
  if (dx === 0 && dz === 0) {
    dx = 1;
    dz = 0;
  }
  const len = Math.sqrt(dx * dx + dz * dz);
  _kbDirScratch.x = dx / len;
  _kbDirScratch.z = dz / len;
  return _kbDirScratch;
}

// ---------------------------------------------------------------------------
// §7.13 — Hit-stop
// ---------------------------------------------------------------------------

/** `03 §7.13`'s table, verbatim. */
export const HITSTOP_DAMAGE_PERCENT_THRESHOLD = 12;
export const HITSTOP_DAMAGE_SECONDS = 0.06;
export const HITSTOP_CRIT_SECONDS = 0.09;
export const HITSTOP_KILL_SECONDS = 0.12;
/** `03 §7.13`: "Boss phase transition | 0.20 s (boss only)." Not wired by
 * this ticket — `combat` has no boss-phase trigger of its own (`ai` emits
 * `boss:phase`, `ARCHITECTURE.md`'s event table); kept as a documented
 * constant for whichever ticket wires that event to this file's decision. */
export const HITSTOP_BOSS_PHASE_SECONDS = 0.20;

/** `03 §7.13`: "Only the *struck* actor freezes, and only if the attacker
 * is the player. Two overlapping freezes take the maximum, never the sum."
 * Plain positional numbers/booleans — see the file header.
 * @param {number} damageThisHit
 * @param {number} maxLife
 * @param {boolean} crit
 * @param {boolean} killed
 * @param {boolean} attackerIsPlayer
 * @returns {number} seconds, `0` for no freeze
 */
export function computeHitStopSeconds(damageThisHit, maxLife, crit, killed, attackerIsPlayer) {
  if (!attackerIsPlayer) return 0;
  let seconds = 0;
  if (maxLife > 0 && damageThisHit >= (HITSTOP_DAMAGE_PERCENT_THRESHOLD / 100) * maxLife) {
    seconds = Math.max(seconds, HITSTOP_DAMAGE_SECONDS);
  }
  if (crit) seconds = Math.max(seconds, HITSTOP_CRIT_SECONDS);
  if (killed) seconds = Math.max(seconds, HITSTOP_KILL_SECONDS);
  return seconds;
}

// ---------------------------------------------------------------------------
// A single `%`-space draw — same shape as `resolve.js`'s own private
// `draw100`, redeclared here rather than imported (that helper is not
// exported; see this file's header on sibling-to-sibling imports being
// fine in principle but this one function simply isn't public).
// ---------------------------------------------------------------------------

function draw100(rng) {
  return rng.next() * 100;
}

// ---------------------------------------------------------------------------
// applyReaction — the orchestrator `packet.js#resolve()` calls
// ---------------------------------------------------------------------------

/**
 * Runs R14(g) (hit recovery), R14(h) (knockback) and §7.13 (hit-stop) for
 * one already-resolved hit. Called from `CombatSystem#resolve()` in
 * `packet.js`, right after `resolveDamage()` returns — see the file header
 * for why this lives here rather than as an edit to `resolve.js`.
 *
 * No-ops entirely for a non-`'hit'` outcome (`miss`/`dodge`/`block`/
 * `immune`/`invalid` all carry `result.total === 0`, `result.crit ===
 * false`, so every threshold below would fail anyway — the explicit
 * `outcome` gate documents the decision rather than relying on that
 * coincidence, and additionally reads as "a blocked hit doesn't stagger the
 * target," a plausible but spec-silent inference flagged in this ticket's
 * report) and for a dead/missing target.
 *
 * Every side effect is a guarded call into `env.actorsSystem` — see the
 * file header, "the actors-wiring gap." `result.hitRecovery`/
 * `.knockedBack` are only set `true` when the actors-side call actually
 * reports success (an illegal `setState`/`cancelAction` transition, e.g. a
 * `windup` actor rolling knockback, correctly leaves them `false`).
 *
 * @param {object} packet a `DamagePacket` — needed for `packet.knockback`
 *   (the % chance) and `packet.originX/Z` (knockback direction)
 * @param {object} target an Actor — the struck actor; the only one ever
 *   touched by this function
 * @param {object} result the `DamageResult` `resolveDamage` just populated;
 *   mutated in place (`.hitRecovery`/`.knockedBack`)
 * @param {object} env `resolve.js`'s own env bag: `{ source, rng, step,
 *   actorsSystem, ... }` — reused, never a fresh object
 */
export function applyReaction(packet, target, result, env) {
  if (!target || target.dead || result.outcome !== 'hit') return;

  const actorsSystem = env.actorsSystem;
  const source = env.source;
  const attackerIsPlayer = !!source && source.kind === PLAYER_KIND;
  const stats = target.stats;
  const maxLife = stats ? stats.maxLife : 0;

  // --- §7.13 hit-stop — decided regardless of what follows; a killing
  // blow still gets its freeze even though it will not enter hitstun/
  // knockback below. ---------------------------------------------------
  const hitStopSeconds = computeHitStopSeconds(result.total, maxLife, result.crit, result.killed, attackerIsPlayer);
  if (hitStopSeconds > 0 && actorsSystem && typeof actorsSystem.hitStop === 'function') {
    actorsSystem.hitStop(target, hitStopSeconds);
  }

  if (result.killed || target.dead) return; // dying — no state change below

  // --- R14(g) hit recovery — 03 §7.11 -----------------------------------
  if (stats && env.step >= target.hitstunImmuneUntil && hitstunTriggers(result.total, maxLife)) {
    if (actorsSystem && typeof actorsSystem.cancelAction === 'function') {
      const entered = actorsSystem.cancelAction(target, 'hitstun');
      if (entered) {
        const durationSteps = Math.round(computeHitRecoveryTime(stats.fasterHitRecovery) * FIXED_HZ);
        const immunitySteps = Math.round(hitstunImmunityWindowSeconds(target.rank) * FIXED_HZ);
        target.hitstunUntil = env.step + durationSteps;
        target.hitstunImmuneUntil = target.hitstunUntil + immunitySteps;
        result.hitRecovery = true;
      }
    }
  }

  // --- R14(h) knockback — 03 §7.12 --------------------------------------
  if (packet.knockback > 0 && env.rng && draw100(env.rng) < packet.knockback) {
    const noKnockback = !!(target.flags & NO_KNOCKBACK_FLAG_BIT);
    const distance = computeKnockbackDistance(packet.knockback, target.mass, noKnockback, target.rank);
    if (distance > 0 && actorsSystem && typeof actorsSystem.setState === 'function') {
      const entered = actorsSystem.setState(target, 'knockback');
      if (entered) {
        result.knockedBack = true;
        if (typeof actorsSystem.applyImpulse === 'function') {
          const dir = computeKnockbackDirection(packet, source, target);
          const speed = distance / KNOCKBACK_IMPULSE_SECONDS;
          actorsSystem.applyImpulse(target, dir.x * speed, dir.z * speed, KNOCKBACK_IMPULSE_SECONDS);
        }
      }
    }
  }
}
