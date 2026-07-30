// src/combat/onhit.js
//
// CMBT-7 — the last two R14 seams `resolve.js` (CMBT-3) deliberately left
// open: the `manaReturnPercent` half of R14(d) (life/mana steal and
// lifeOnHit/manaOnHit are already implemented in `resolve.js` itself — only
// `manaReturned` was left at 0, "CMBT-7's rage/resonance economy seam"), and
// the whole of R14(f) (rage gain on both sides, resonance gain), which
// `resolve.js` never touches at all. `03-combat-math.md` §2.4 (life/mana
// regen, Rage, Resonance, mana return) is this ticket's resource math;
// §6.2's R14 lettered order is what `applyOnHitEconomy` below reproduces for
// (d)'s remainder and the whole of (f).
//
// This ticket runs BEFORE CMBT-6 on purpose (see the ticket brief): CMBT-6
// owns R14(i)/(j) (death/`actor:death`, XP) and the "+8 on a credited kill"
// rage row that logically lives at that death check — see "What this file
// does NOT do" below.
//
// O-51's assembly rule: this file exports plain functions and imports
// nothing from `./packet.js` (and nothing from `./resolve.js`/`./reaction.js`
// either, despite `status.js`'s header noting sibling-to-sibling imports
// within `src/combat/` are fine in principle — this file simply has no pure
// helper it needs from either sibling that is actually exported; see
// "isLikelyMeleeAttack" below for the one place that bites). `packet.js`
// imports this file and calls `applyOnHitEconomy` from
// `CombatSystem#resolve()`, right after `resolveDamage()` and BEFORE
// `applyReaction()` — R14(d)/(f) precede (g)/(h) in the documented order,
// and `packet.js`'s own call site is the only place `packet`, the
// freshly-populated `result` and the shared `env` are all in scope outside
// `resolve.js` itself, exactly the precedent `reaction.js`'s own header
// already established for CMBT-5.
//
// ---------------------------------------------------------------------------
// Where the four numbers actually come from — packet fields, not class IDs
// ---------------------------------------------------------------------------
// `resolve.js`'s own R14(d) code already reads `packet.lifeSteal`/
// `.manaSteal`/`.lifeOnHit`/`.manaOnHit` directly off the packet — never off
// `source.classId`. `packet.js`'s B8 step carries `packet.manaReturnPercent =
// stats.manaReturnPercent` the identical way. This file follows the same
// discipline for `manaReturned`: `packet.manaReturnPercent` (the ATTACKER's
// own composed stat, already on the packet) is read as-is, with no
// Runeblade-specific top-up here. `03-combat-math.md` §2.4's "base
// manaReturnPercent for the Runeblade class is 8" is a fact about what a
// real composed Runeblade's `StatBlock.manaReturnPercent` should read (via
// whatever class-base/item/skill layer eventually seeds it — `stats.js`'s
// own header limits its scope to the columns it lists, and
// `manaReturnPercent` is not one of them), not an instruction for `combat`
// to inject a class-keyed constant into the middle of R14. `tests/combat/
// resolve.test.js`'s own E13 fixture confirms this reading: it sets
// `manaReturnPercent: 8` directly on the equipment layer, not through a
// class special-case, and `packet.manaReturnPercent` carries it through
// untouched. See "What was missing from the API or data" in this ticket's
// report: today NO layer seeds a Runeblade's base 8 automatically — a real
// fresh Runeblade with no gear reads `manaReturnPercent === 0` until
// items/skills provide it. That gap belongs to whichever ticket owns the
// class-base/item/skill composition, not to this one.
//
// Rage/Resonance follow the identical "read the composed stat, do not
// special-case the class" rule, but via `source.stats`/`target.stats`
// directly (`rageOnHit`/`rageOnTakeHit`/`resonanceOnHit` are NOT packet
// fields at all — `01-data-model.md` §8.1's `DamagePacket` shape has no such
// slots, because `rageOnTakeHit` is a property of the DEFENDER, who never
// built the packet). `vessels.js`'s own header already establishes why no
// class check is needed for the resource CAP side: `addRage`/`addResonance`
// clamp to `stats(actor).maxRage`/`.maxResonance`, which are 0 for any class
// without that resource (`stats.js`'s `ZERO_CLASS`/non-Ravager/non-Runeblade
// rows), so crediting rage to an Emberwright or resonance to a Ravager is a
// harmless, self-correcting no-op (`before=0, amount>0, maxValue=0` clamps
// straight back to `0`) — this file relies on that same clamp rather than
// gating on `source.classId === 'ravager'` anywhere.
//
// ---------------------------------------------------------------------------
// `addResourceClamped` — a local reimplementation of `vessels.js#addClamped`
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 2 forbids importing another subsystem's module —
// `src/actors/vessels.js` is exactly that (a different subsystem,
// `src/actors/`), the same boundary `resolve.js`'s own R14(d) code already
// respects by mutating `source.life`/`source.mana` as plain data-field
// writes instead of calling `actors.addLife`/`.addMana`. This file follows
// the identical discipline for `rage`/`resonance`: `addResourceClamped`
// below is a byte-for-byte behavioural twin of `vessels.js#addClamped`
// (add, clamp to `[0, maxValue]`, dead actor is a no-op), duplicated rather
// than imported, for the same reason `resolve.js`'s header already gives.
//
// ---------------------------------------------------------------------------
// `isLikelyMeleeAttack` — duplicated from `resolve.js`'s own (unexported,
// private) inference
// ---------------------------------------------------------------------------
// `resolve.js`'s R14(e) thorns code already needs "is this packet a melee
// attack" and answers it with `packet.attackRating > 0 && (packet.physMin >
// 0 || packet.physMax > 0)` — its own header calls this out as gap 2, "no
// dedicated packet field distinguishes a melee attack from a ranged or
// spell one." That helper is not exported (it is a bare, module-private
// `function` in `resolve.js`), so it cannot be imported here without
// editing `resolve.js` (not this ticket's file) to add an `export`. The
// identical inference is redeclared below, verbatim, rather than
// duplicating a DIFFERENT heuristic that could quietly disagree with
// thorns' own melee test on the same packet.
//
// ---------------------------------------------------------------------------
// `lastDamageStep`/`lastDealtStep` — a real, load-bearing gap this ticket
// closes
// ---------------------------------------------------------------------------
// `03-combat-math.md` §2.4: "'In combat' means `now - max(lastDamageStep,
// lastDealtStep) < 4.0 s`. There is no passive gain and no decay while in
// combat." `vessels.js#isInCombat` (ACTR-8, accepted) already reads both
// fields faithfully — but nothing anywhere in `src/` ever WRITES them
// (verified: `grep -rn "lastDamageStep\|lastDealtStep" src/` outside
// `pool.js`'s own zero-init and `vessels.js`'s own read turns up nothing).
// Left unset, both fields sit at their `pool.js` default of `-1` forever,
// `isInCombat` is `false` from the first fixed step onward, and Rage/
// Resonance decay 24/7 regardless of how recently a hit landed — silently
// defeating the exact "no decay while in combat" rule this ticket exists to
// implement. `src/actors/pool.js` is not this ticket's file, but the two
// fields it already reserves are plain data on the shared `Actor` record
// (the same category `resolve.js` already writes — `target.life`,
// `source.life`/`.mana` — without owning `src/actors/`), and `combat` is the
// sole authority that ever learns "a hit landed" in the first place
// (`ARCHITECTURE.md`: "Damage is requested, never applied by the
// requester... combat is the only system that resolves it"). Setting them
// here, in the one place this economy already runs per landed hit, is the
// natural closure of the gap rather than a second, competing owner — see
// this ticket's report.
//
// ---------------------------------------------------------------------------
// What this file does NOT do (documented gaps/seams, not oversights)
// ---------------------------------------------------------------------------
// - The `+8` "kill credited" rage row (`03` §2.4's own table) is NOT applied
//   here. R14(i)'s death check/`actor:death` is CMBT-6's seam (still a
//   no-op in `resolve.js` — `out.killed` is a byproduct of R14(a) only), and
//   this ticket's own brief is explicit that it runs BEFORE CMBT-6 so the
//   on-hit credit paths settle first. `BASE_RAGE_ON_KILL` below is kept as
//   a documented constant (same discipline `reaction.js`'s own
//   `HITSTOP_BOSS_PHASE_SECONDS` already establishes for a later ticket's
//   trigger) for whichever ticket wires the kill-credit event.
// - `last_stand`'s `+40` rage trigger is NOT applied here either — no
//   `last_stand` skill/trigger exists anywhere in `src/` yet (`05-skills.md`
//   territory, explicitly out of this ticket's reading list).
//   `RAGE_ON_LAST_STAND` is kept as the same kind of documented constant.
// - `rune_strike` doubling `manaReturnPercent` for its own hit, and
//   `resonance_circuit`'s `+4 + 0.8x(slvl-1)` addition, are both
//   skill-level modifiers (`05-skills.md`, explicitly out of this ticket's
//   reading list) layered on TOP of the base formula this file implements;
//   neither is applied here. `packet.manaReturnPercent`/`source.stats.
//   resonanceOnHit` already carry whatever a real skill system eventually
//   folds in — this file is agnostic to where those numbers came from.
// - `applyDirect()` (mitigation-free scripted damage) is NOT wired to this
//   file, the same decision `reaction.js`'s own header already documents
//   for `applyReaction()`: it has no `DamagePacket` (no
//   `manaReturnPercent`/melee inference to read), and R14(d)/(f) read as
//   properties of a *combat hit*, not of arbitrary scripted/DoT damage.
// - The thorns counter-hit (`resolve.js` R14(e)) never reaches this file:
//   it calls `resolveDamage()` directly, bypassing `CombatSystem#resolve()`
//   entirely (the same reason `applyReaction()` never runs for it either).
//
// Zero-allocation: every function below takes plain primitives/objects
// already in scope and mutates existing fields; no object/array is ever
// constructed. `env.creditLog`, used ONLY by this ticket's own tests to
// observe the (d)-then-(f) firing order, is a single `if (env.creditLog)`
// check against a field the real, production `env` (`packet.js`'s
// `_resolveEnv`) never sets — zero cost, zero allocation on the real path.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file.

// ---------------------------------------------------------------------------
// Data — the literal event amounts (ARCHITECTURE.md rule 9: gameplay
// numbers live in data). `03-combat-math.md` §2.4, verbatim.
// ---------------------------------------------------------------------------

/** Rage: "Landed melee hit dealt | +6 (+ rageOnHit)". */
export const BASE_RAGE_ON_HIT = 6;
/** Rage: "Hit taken (any damage > 0) | +4 (+ rageOnTakeHit)". */
export const BASE_RAGE_ON_TAKE_HIT = 4;
/** Rage: "Kill credited | +8". NOT applied by this file — see the header,
 * "What this file does NOT do" (CMBT-6's death-check territory). */
export const BASE_RAGE_ON_KILL = 8;
/** Rage: "`last_stand` trigger | +40". NOT applied by this file — no
 * `last_stand` trigger exists yet (05-skills.md territory). */
export const RAGE_ON_LAST_STAND = 40;
/** Resonance: "Landed melee hit dealt | +1 (+ resonanceOnHit, fractional,
 * floored on read)". */
export const BASE_RESONANCE_ON_HIT = 1;

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// ---------------------------------------------------------------------------
// Pure formulas — each one independently testable, matching resolve.js's
// own granular per-step export style (stepR7a/b/c, resistAfterPierce, ...).
// ---------------------------------------------------------------------------

/** `BASE_RAGE_ON_HIT + rageOnHit` — the attacker's total rage gain for one
 * landed melee hit dealt.
 * @param {number} rageOnHitStat `StatBlock.rageOnHit`, 0 if absent.
 * @returns {number}
 */
export function rageGainOnHit(rageOnHitStat) {
  return BASE_RAGE_ON_HIT + (rageOnHitStat || 0);
}

/** `BASE_RAGE_ON_TAKE_HIT + rageOnTakeHit` — the defender's total rage gain
 * for one hit taken (any damage > 0), regardless of the attack's type.
 * @param {number} rageOnTakeHitStat `StatBlock.rageOnTakeHit`, 0 if absent.
 * @returns {number}
 */
export function rageGainOnTakeHit(rageOnTakeHitStat) {
  return BASE_RAGE_ON_TAKE_HIT + (rageOnTakeHitStat || 0);
}

/** `BASE_RESONANCE_ON_HIT + resonanceOnHit` — the attacker's total Resonance
 * gain for one landed melee hit dealt. Never floored here — "fractional,
 * floored on read" (`03` §2.4) is `spend(actor, 'resonance', 'all')`'s job
 * (`vessels.js`, already accepted), not the credit side's.
 * @param {number} resonanceOnHitStat `StatBlock.resonanceOnHit`, 0 if absent.
 * @returns {number}
 */
export function resonanceGainOnHit(resonanceOnHitStat) {
  return BASE_RESONANCE_ON_HIT + (resonanceOnHitStat || 0);
}

/** `manaReturned = physicalDamageDealt x manaReturnPercent / 100` —
 * `03-combat-math.md` §2.4, verbatim. NOT floored (E13 pins `21.4438 x 0.08
 * = 1.7155`, a fractional result, as the literal expected value) — unlike
 * life/mana steal, which R14(d)'s own wording explicitly floors.
 * @param {number} physicalDamageDealt post-mitigation physical (`result.
 *   physical`, the same figure life/mana steal already use).
 * @param {number} manaReturnPercent `packet.manaReturnPercent` (the
 *   attacker's own composed stat, already carried on the packet).
 * @returns {number}
 */
export function computeManaReturned(physicalDamageDealt, manaReturnPercent) {
  return physicalDamageDealt * (manaReturnPercent / 100);
}

/** See the file header: duplicated verbatim from `resolve.js`'s own
 * (unexported) melee inference so thorns and rage/resonance never disagree
 * about what counts as "melee" for the same packet.
 * @param {object} packet
 * @returns {boolean}
 */
export function isLikelyMeleeAttack(packet) {
  return packet.attackRating > 0 && (packet.physMin > 0 || packet.physMax > 0);
}

/** See the file header: a local twin of `vessels.js#addClamped` — adds
 * `amount` to `actor[key]`, clamped to `[0, maxValue]`. A dead actor never
 * gains anything (mirrors `vessels.js`'s own guard). Returns the actual
 * delta applied, in case a caller ever wants it (none does today).
 * @param {object} actor
 * @param {string} key
 * @param {number} amount
 * @param {number} maxValue
 * @returns {number}
 */
export function addResourceClamped(actor, key, amount, maxValue) {
  if (!actor || actor.dead) return 0;
  const before = actor[key];
  let v = before + amount;
  if (v > maxValue) v = maxValue;
  else if (v < 0) v = 0;
  actor[key] = v;
  return v - before;
}

// ---------------------------------------------------------------------------
// applyOnHitEconomy — the R14(d)-remainder + R14(f) orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the mana-return half of R14(d) and the whole of R14(f) for one
 * already-resolved hit, in that fixed order. Called from
 * `CombatSystem#resolve()` in `packet.js`, right after `resolveDamage()`
 * returns and BEFORE `applyReaction()` (R14(g)/(h)) — see the file header.
 *
 * No-ops entirely for `miss`/`dodge`/`invalid` outcomes: `resolveDamage()`
 * returns before ever calling its own `applyR14` for those three (R1's "no
 * event", R2/R3's "stop after R14's event" — read literally, R14 itself
 * never runs), so there is nothing here to credit. `block`/`immune` DO run
 * `applyR14` in `resolve.js` (thorns/riders still apply) and are NOT
 * excluded here either — `result.total` is always 0 for both, so the
 * `> 0` gates below fall through to nothing on their own, the same
 * coincidence-vs-explicit-decision tradeoff `reaction.js`'s own header
 * discusses for its `outcome !== 'hit'` gate (documented, not relied on
 * silently: see the individual gates below).
 *
 * @param {object} packet a `DamagePacket` — `packet.manaReturnPercent`
 *   (attacker's own stat, already on the packet).
 * @param {object} target an Actor — the struck actor.
 * @param {object} result the `DamageResult` `resolveDamage` just populated;
 *   mutated in place (`.manaReturned`).
 * @param {object} env `resolve.js`'s own env bag: `{ source, step, ... }` —
 *   reused, never a fresh object. `env.creditLog`, when present (test-only),
 *   receives a string per credit actually applied, in firing order.
 */
export function applyOnHitEconomy(packet, target, result, env) {
  const outcome = result.outcome;
  if (!target || outcome === 'miss' || outcome === 'dodge' || outcome === 'invalid') return;

  const source = env.source;
  const log = env.creditLog;

  // --- combat-window bookkeeping ---------------------------------------
  // Not itself a lettered R14 step, but load-bearing for THIS ticket's own
  // Rage/Resonance decay rule to mean anything at runtime — see the file
  // header, "a real, load-bearing gap this ticket closes." Gated on actual
  // damage (`> 0`), matching `lastDamageStep`'s own "drives the 4s in
  // combat window" comment and §2.4's "hit taken (any damage > 0)" wording.
  if (result.total > 0) {
    target.lastDamageStep = env.step;
    if (source) source.lastDealtStep = env.step;
    if (log) log.push('combat-window');
  }

  // --- R14(d) remainder: manaReturned -----------------------------------
  if (source && !source.dead) {
    const manaReturned = computeManaReturned(result.physical, packet.manaReturnPercent);
    result.manaReturned = manaReturned;
    if (manaReturned > 0) {
      const maxMana = source.stats ? source.stats.maxMana : Infinity;
      let mana = source.mana + manaReturned;
      if (mana > maxMana) mana = maxMana;
      source.mana = mana;
    }
    if (log) log.push('R14(d):manaReturned');
  }

  // --- R14(f): rage gain on both sides, then Resonance ------------------
  // Attacker first, then defender, then Resonance — matching the order
  // the ticket's own prose states them in ("the attacker gains +6 ... and
  // the target gains +4 ...").
  if (source && !source.dead && source.stats && outcome === 'hit' && result.total > 0 && isLikelyMeleeAttack(packet)) {
    addResourceClamped(source, 'rage', rageGainOnHit(source.stats.rageOnHit), source.stats.maxRage);
    if (log) log.push('R14(f):rage-attacker');

    addResourceClamped(source, 'resonance', resonanceGainOnHit(source.stats.resonanceOnHit), source.stats.maxResonance);
    if (log) log.push('R14(f):resonance-attacker');
  }

  if (result.total > 0 && target.stats) {
    addResourceClamped(target, 'rage', rageGainOnTakeHit(target.stats.rageOnTakeHit), target.stats.maxRage);
    if (log) log.push('R14(f):rage-target');
  }
}
