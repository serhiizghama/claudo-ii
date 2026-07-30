// src/combat/tohit.js
//
// CMBT-2 — the pure to-hit/dodge/block PROBABILITY functions:
// `03-combat-math.md` §5 in full (§5.1 chance to hit, §5.2 dodge, §5.3
// block). `02-api-contracts.md` §8 lists `chanceToHit` and `blockChanceOf`
// as `CombatSystem` methods.
//
// This file exports PLAIN pure functions and imports nothing from
// `packet.js` — it does not touch `CombatSystem` at all. `packet.js` (the
// module `main.js` actually loads for the `combat` registration) is the one
// that imports this file and attaches `chanceToHit`/`blockChanceOf` to the
// class — see `packet.js`'s own header for why the dependency runs that
// direction and not this one (a `tohit.js -> packet.js` import, as an
// earlier version of this file had, would make `packet.js -> tohit.js`
// impossible without a cycle; `main.js` never imports `tohit.js` at all, so
// a `CombatSystem.prototype` extension living here would never execute in
// the real boot — caught at review, not by this file's own test suite,
// because that suite imported this file directly and never exercised the
// module graph `main.js` actually builds).
//
// ---------------------------------------------------------------------------
// Scope — what this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: `chanceToHit(attackRating, defense, alvl, dlvl)` and
// `blockChanceOf(actor)` — the only two methods `02-api-contracts.md` §8
// lists that this ticket's brief names as CMBT-2's. Both are pure
// probability arithmetic; neither draws randomness.
//
// Does NOT own (a backlog correction, D-14, already applied — the ticket
// brief is explicit E1/E2 are this ticket's, E7/E8 are not):
//   - Hit recovery (`03 §7.11`, CMBT-5) — not implemented here.
//   - Chill accumulation (`03 §7.3`, CMBT-4) — not implemented here.
//   - The actual RNG draw and the to-hit -> dodge -> block short-circuit
//     order (`03 §5`'s own opening paragraph: "resolved in this order and
//     short-circuiting on the first success. Each is a single RNG draw from
//     the `combat` stream") — that is `resolve()`, R2/R3/R4, CMBT-3's. This
//     file only computes the percentages those draws are compared against.
//   - Dodge has NO dedicated public method: `03 §5.2`'s formula is exactly
//     `clamp(stats.dodgeChance, 0, 50)`, and `stats.dodgeChance` is ALREADY
//     clamped to `[0, 50]` by `src/actors/stats.js`'s own `CAPS` table
//     (`dodgeChance: [0, 50]`) during `composeStats`'s step 9 — so the
//     formula reduces to reading the stat directly, with no additional
//     computation this file could usefully wrap. `02-api-contracts.md` §8
//     does not list a `dodgeChanceOf` method either (checked directly: the
//     table has `chanceToHit`/`blockChanceOf` and nothing dodge-shaped) —
//     rule 7 of this ticket's own brief: "A public method exists only if
//     `02-api-contracts.md` lists it... If you need a method that is not
//     listed, say so and wait." Flagged in this ticket's report; CMBT-3's
//     `resolve()` reads `actor.stats.dodgeChance` straight off the
//     already-composed `StatBlock` for its R3 dodge roll.
//   - The `attackRating === 0` "always hits" bypass (`03 §5.1`: "not a 95%
//     cap, it is an unconditional bypass") is a `resolve()`-time SKIP of the
//     to-hit roll entirely (R2 never runs `chanceToHit()` at all for such a
//     packet) — not a special return value from this file's pure function.
//     `chanceToHit(0, defense, alvl, dlvl)` still returns a clamped
//     percentage if ever called directly (see `chanceToHit`'s own doc
//     comment for the exact value), because the bypass is a caller-side
//     branch, not something a 4-number pure function can express; no worked
//     example in this ticket's E1 table exercises `attackRating === 0`, so
//     this is a documented inference, not a spec-contradicted guess.
//   - The frontal 180° arc check and `packet.blockable`/`packet.dodgeable`
//     gating (`03 §5.2`/`§5.3`) are `resolve()`-side gates on WHETHER to
//     roll at all — this file's `blockChanceOf` always computes "what the
//     block chance WOULD be", the same way `chanceToHit` always computes
//     "what the to-hit chance would be" regardless of `packet.dodgeable`.
//
// ---------------------------------------------------------------------------
// Shield `blockBase` — data, kept here (rule 6: "gameplay numbers live in
// data") because this ticket's file list is exactly `tohit.js` + its own
// test, no `src/combat/data/` entry — the identical situation `packet.js`'s
// header documents for `BASIC_ATTACK_WEAPON_DAMAGE`/`DEFAULT_CAST_TIME`
// (isolate the numbers in one clearly-labelled, exported constant rather
// than inline them in the formula). No `items` table exists yet
// (`src/items/`, M3) to own a real shield item base — `blockChanceOf` reads
// `shield.blockBase` off whatever `actor.equipment.offHand` resolves to,
// forward-compatible with a future `ItemInstance` shaped compatibly, the
// same pattern `packet.js#resolveWeapon` already uses for `mainHand`.
// ---------------------------------------------------------------------------

/** `03-combat-math.md` §5.3: "Shield blockBase values: buckler 40, targe
 * 50, kite shield 55, tower shield 65." Exported so a future `items` table
 * can source real shield bases from the same numbers instead of
 * re-guessing them. Not consumed by `blockChanceOf` itself — that function
 * only ever reads `shield.blockBase` off whatever object
 * `actor.equipment.offHand` already is (see the file header); this table is
 * the canonical source a test fixture (or the eventual `items` shield base
 * table) should build that object from. */
export const SHIELD_BLOCK_BASE = Object.freeze({
  buckler: 40,
  targe: 50,
  kite_shield: 55,
  tower_shield: 65,
});

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** `02-api-contracts.md` §8: `chanceToHit(attackRating, defense, alvl,
 * dlvl) => number` — 5..95. `03-combat-math.md` §5.1, verbatim:
 *
 *   CTH% = clamp( 200 * AR / (AR + DEF) * alvl / (alvl + dlvl), 5, 95 )
 *
 * Both ratio denominators are guarded against a literal `0/0` (`AR === 0 &&
 * defense === 0`, or a caller passing `alvl === 0 && dlvl === 0` — outside
 * `01-data-model.md`'s documented `level: 1..40` range, so never exercised
 * by a real actor, but a 4-number pure function has no actor to fall back
 * on) by treating an all-zero denominator as ratio `0` rather than
 * producing `NaN`; every worked example in this ticket's E1 table has both
 * denominators strictly positive, so this guard is defensive, not
 * spec-derived. `attackRating === 0`'s "always hits" bypass is NOT handled
 * here — see the file header.
 * @param {number} attackRating
 * @param {number} defense
 * @param {number} alvl
 * @param {number} dlvl
 * @returns {number} 5..95
 */
export function chanceToHit(attackRating, defense, alvl, dlvl) {
  const arDenom = attackRating + defense;
  const arRatio = arDenom !== 0 ? attackRating / arDenom : 0;

  const lvlDenom = alvl + dlvl;
  const lvlRatio = lvlDenom !== 0 ? alvl / lvlDenom : 0;

  const raw = 200 * arRatio * lvlRatio;
  return clamp(raw, 5, 95);
}

/** `02-api-contracts.md` §8: `blockChanceOf(actor) => number` — 0..75, 0
 * without a shield. `03-combat-math.md` §5.3, verbatim:
 *
 *   shieldTerm = shield.blockBase * (DEX - 15) / (2 * clvl)
 *   block%     = clamp( shieldTerm + stats.blockChance, 0, 75 )
 *
 * The no-shield short-circuit runs BEFORE `stats.blockChance` is ever added
 * — `03 §5.3`: "block% is 0 without a shield in offHand, regardless of
 * stats.blockChance" (E2.4 pins exactly this: `blockBase 0`, flat `40` ->
 * expected `0`, not `40`). `actor.stats` must already be composed
 * (`actors.stats(actor)` / `composeStats(actor)` — `combat` never composes
 * stats itself, `ARCHITECTURE.md` rule 2); a missing `.stats` throws a
 * clear error rather than silently computing out of `undefined` arithmetic,
 * the same discipline `packet.js#requireStats` uses.
 * @param {object} actor an Actor record with a composed `.stats` and, when
 *   armed with a shield, `.equipment.offHand` shaped `{blockBase:number}`.
 * @returns {number} 0..75
 */
export function blockChanceOf(actor) {
  const stats = actor && actor.stats;
  if (!stats) {
    throw new Error(
      'combat: blockChanceOf: actor.stats is not composed — call actors.stats(actor) ' +
        '(or composeStats(actor)) first; combat does not compose stats itself (ARCHITECTURE.md rule 2).',
    );
  }

  const shield = actor.equipment && actor.equipment.offHand;
  if (!shield) return 0;

  const shieldTerm = (shield.blockBase * (stats.dexterity - 15)) / (2 * actor.level);
  return clamp(shieldTerm + stats.blockChance, 0, 75);
}
