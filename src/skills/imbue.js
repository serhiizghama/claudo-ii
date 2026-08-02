// src/skills/imbue.js
//
// SKIL-13 — `blade_seal` (the Resonance imbue) and `cascade` (the three-
// empowered-hit trigger). `./index.js` owns wiring this module's output onto
// the `skills` subsystem (dispatch table, the shared `actor:damage`
// listener, `zone:teardown`, and the three `02-api-contracts.md` §10 read
// methods this ticket adds: `imbueRemaining`/`imbueElement`/
// `cascadeCharges`); this file owns the mechanics.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// (`tools/check-imports.mjs` sweeps `src/skills/` with `checkGlobals:
// true`). No `Math.random()` — nothing here draws randomness.
//
// ---------------------------------------------------------------------------
// D-44 — the backlog cites only `05` §6.2; `cascade` is §6.3, and the real
// sequencing is `11-flows.md` §5.8, which `05-skills.md` never points to
// ---------------------------------------------------------------------------
// `05-skills.md` §6.2 (L2012-2099) is `blade_seal` alone. `cascade` is its
// own §6.3 (L2100-2178) with its own twenty-level table and its own
// three-empowered-hit counter — easy to miss if the backlog's single
// citation is trusted. `11-flows.md` §5.8 (L962-1016), "Runeblade Resonance
// and the `blade_seal` imbue", is the authoritative sequencing for both: the
// imbue's arm/disarm AND cascade's counter share the same `actor:damage`
// listener (§5.8's own closing paragraph: "`cascade` (skill 23) shares the
// same `actor:damage` listener and the same counter discipline"). Nothing in
// `05-skills.md` links to it — this file follows §5.8, not a re-derivation
// from §6.2/§6.3 alone.
//
// ---------------------------------------------------------------------------
// D-05-2 — the identity this file exists to implement exactly
// ---------------------------------------------------------------------------
// "An imbue charge is consumed by a landed hit, and a landed hit is what
// grants a Resonance charge." `blade_seal` spends the WHOLE bar
// (`cost.resonance: 'all'`, `actors.spend(actor,'resonance','all')` —
// `floor(resonance)`, refused below 1) and `rune_strike` carries no extra
// Resonance charge beyond the class base (`combat/onhit.js` R14(f), already
// accepted, CMBT-8/D-51 — NOT this file's to award, see below). This file
// never calls any Resonance-granting primitive; it only spends (at cast) and
// counts (on `actor:damage`). Steady-state overflow is therefore
// `max(0, imbueCount - maxResonance) / imbueCount` — zero at the matched
// pairs 3/3, 4/4, 5/5 (`05` §12.5's own table, reproduced in this ticket's
// tests).
//
// `combat`'s own R14(f) (`src/combat/onhit.js`, not this ticket's file)
// already credits Resonance on every landed melee hit, gated on
// `outcome === 'hit' && result.total > 0 && isLikelyMeleeAttack(packet)` —
// this file does not duplicate that award (D-51's own lesson: SKIL-3 had to
// delete a duplicate).
//
// ---------------------------------------------------------------------------
// A real spec contradiction, resolved by following the ticket's named
// authority (D-44)
// ---------------------------------------------------------------------------
// `05-skills.md` §6.2's own "Consumption" row (L2066): "a charge is spent on
// a landed weapon hit only. A miss, a dodge and a block all leave the charge
// intact; a block still consumes nothing because no damage was dealt."
// `11-flows.md` §5.8 step 6 (L984): "On `actor:damage` where ... `outcome ∈
// {hit, block}`: `imbueHits--`" — i.e. a block DOES consume a charge. These
// two documents disagree outright on whether a block decrements. Per D-44,
// `11-flows.md` §5.8 is this ticket's designated authoritative sequencing —
// followed here (`outcome ∈ {hit, block}` decrements). Flagged in this
// ticket's report, not silently reconciled (D-16 precedent: say which one
// and stop). One consequence worth naming: `combat/onhit.js`'s own Resonance
// credit is gated on `outcome === 'hit'` (a block never credits — `result.
// total` is 0 for a block, per `resolve.js`), so a block CONSUMES an imbue
// charge without GRANTING a matching Resonance charge back — the D-05-2
// identity holds exactly for `hit` outcomes only; a block (rare: requires a
// shielded target and a passed roll) is a small, spec-mandated asymmetry,
// not a defect this file introduces.
//
// ---------------------------------------------------------------------------
// "sourceSkillId is a weapon attack" — what that gate actually checks
// ---------------------------------------------------------------------------
// The `actor:damage` payload (`{target, source, result}`, `src/combat/
// resolve.js`) carries `result.sourceSkillId` but not the originating
// `DamagePacket` itself, so this file cannot re-run `combat/onhit.js`'s own
// `isLikelyMeleeAttack(packet)` inference. `packet.sourceSkillId` is set by
// `combat/packet.js#stepB8` to `skillId || 'attack'` — `'attack'` for a
// basic swing, the real skill id otherwise (`01-data-model.md` §8.1: "skillId
// | attack | thorns | dot | environment"). `WEAPON_ATTACK_SKILL_IDS` below is
// the closed set of ids that carry the Runeblade's own weapon swing today:
// the basic attack and `rune_strike` (D-37/D-43: `rune_strike` is explicitly
// "a landed melee hit, NOT a projectile"). `ember_bolt` (a projectile),
// `cascade` (its own wave, `magic`, `attackRating 0` — "it cannot crit-chain
// into itself", 05 §6.3's own closing line) and `cleaving_strike` (a
// Ravager-only skill; a Runeblade can never allocate it) are all correctly
// excluded by omission — not by an "impossible" assertion (O-27/O-39). A
// future weapon-based Runeblade skill (`phase_leap`'s own "teleport plus a
// weapon strike", not cast-wired by any ticket yet) would need adding to
// this set when it lands — named here as the extension point, not silently
// assumed complete.
//
// ---------------------------------------------------------------------------
// Cold imbue's chill/freeze — already automatic, nothing to implement here
// ---------------------------------------------------------------------------
// `05` §6.2's status table: "cold imbues feed `chillPoints` at magnitude 30
// per hit." `src/combat/status.js#onActorDamageForChill` (CMBT-4, already
// accepted, wired permanently by `CombatSystem` itself — see `packet.js`'s
// own `_onActorDamageForChill`) reacts to EVERY `actor:damage` where
// `result.cold > 0`, regardless of source, at `CHILL_DEFAULT_MAGNITUDE = 30`
// (verified: `src/combat/status.js:150`) — exactly the spec's own number.
// Once this file correctly seeds `stats.coldMin`/`coldMax` for the imbue's
// duration (via `writeImbueStatPartial`, below), `combat.buildAttackPacket`'s
// own B7 step already carries it onto every landed weapon hit's packet, and
// `combat`'s own listener does the rest — freeze accrual, decay, and the
// boss `chilled`-substitution rule. This file adds NOTHING for cold beyond
// the flat `coldMin`/`coldMax` stat contribution.
//
// ---------------------------------------------------------------------------
// Fire imbue's burn — NOT automatic, and NOT safely reused from
// `./status.js#applyCoefficientRider` as-is
// ---------------------------------------------------------------------------
// `05` §6.2's status table: "`burning | fireDealt × 0.35 / 3.0 per second on
// a fire imbue | 3.0 s | default seeding, 3 stacks`" — the doc is explicit
// that the number is a RATE (divided by the 3.0 s duration). `combat/
// status.js`'s own DoT tick code confirms `magnitude` IS stored as a
// per-second rate (`rawTick = inst.magnitude * tickIntervalSeconds`,
// `src/combat/status.js:811`; poison's own seeding explicitly divides by
// duration to get there, `resolve.js:699`). `./status.js#applyCoefficientRider`
// (SKIL-6, already accepted, this ticket's sibling file) computes `magnitude
// = coefficient * dealt` for `burning`/`bleeding` WITHOUT dividing by
// duration — and `createIncinerateReaction`'s own default-burn seed
// (`DEFAULT_BURN_COEFFICIENT * detResult.fire`, no `/duration` either) does
// the same. Both read, against `03 §7.4`'s own wording ("totalFireDamageOf
// TheHit × 0.35, spread over 3.0 s" — a TOTAL, spread over time), like a
// 3x-4x over-tuned burn — a plausible real defect in already-accepted SKIL-6
// code, `src/skills/status.js`, NOT this ticket's file to edit. Reported
// here as a finding, not fixed. This file does NOT reuse
// `applyCoefficientRider` for that reason: `maybeSeedFireBurn` below builds
// its own `StatusSpec` directly (via the same exported, unedited
// `buildStatusSpec`/`applyStatusSafe` helpers `./status.js` already exports)
// with the division applied, matching `05`'s own literal formula and the
// engine's confirmed rate semantics.
//
// ---------------------------------------------------------------------------
// The stat layer — why the imbue's `fireMin`/`coldMin`/`lightMin` cannot be
// its own `setSourceLayer` call
// ---------------------------------------------------------------------------
// `actors.setSourceLayer(actor, 'skills', partial)` REPLACES the entire
// named layer (`src/actors/stats.js#setSourceLayer`: `actor.sources[layer] =
// partial`) — it does not merge. `./passive.js` (SKIL-5, not this ticket's
// file) already owns writing the SAME `'skills'` layer for the eight
// passives (`resonance_circuit`'s `maxResonance`/`manaReturnPercent`/
// `resonanceOnHit` among them). A second, independent `setSourceLayer(actor,
// 'skills', ...)` call from this file would silently erase whatever the
// passive layer just wrote (and vice versa, whichever ran second). The fix
// (in `./index.js`, this ticket's own file to wire): `writeImbueStatPartial`
// below is called from the SAME place `computePassiveLayer`'s result is
// composed (`SkillsSystem#_syncPassiveLayer`), writing `fireMin`/`fireMax`/
// `coldMin`/`coldMax`/`lightMin`/`lightMax` onto the SAME partial object
// `computePassiveLayer` returns (the actor's own persistent
// `_skillsPassiveLayer` scratch — `./passive.js`'s own header) before ONE
// `setSourceLayer` call. Six extra keys on that object are written every
// single call (never conditionally added), so its V8 hidden class settles
// after the first write and stays stable — the same "always assign every
// key" discipline `./passive.js#zeroPassiveLayer` already uses for its own
// twelve.
//
// ---------------------------------------------------------------------------
// Per-actor state survives pool recycle — generation-stamping, SKIL-2/CMBT-8's
// own precedent, reused rather than a third pattern
// ---------------------------------------------------------------------------
// `src/skills/cost.js#encodeCooldownStamp` (`generation * 2**32 + value`) and
// `src/combat/onhit.js#encodeActionRageStamp` (identical shape, for the R1
// per-action rage guard) are the two existing instances of this pattern in
// this codebase. This file follows it a THIRD time, not a fourth pattern:
// `imbueStamp[poolIndex]` packs `(actor.generation, hits*4 + (elemIdx+1))`
// (`hits` 0..5, `elemIdx` -1..2 shifted to 0..3 so the packed value stays a
// single non-negative integer), and `cascadeStamp[poolIndex]` packs
// `(actor.generation, count)` (`count` 0..2). A stamp whose decoded
// generation does not match `actor.generation` reads as "reset" (0 hits, no
// element, 0 empowered hits) without ever calling `.clear()`/`.delete()` —
// the same "absent/stale/all mean the same thing" three-way collapse
// `cost.js#cooldownRemainingSteps` already documents. `imbueMin`/`imbueMax`
// (the imbue's own flat elemental amount, computed once at arm time) are
// plain, UNSTAMPED parallel arrays — safe because every read site gates on
// `hits > 0` first (itself generation-checked), so a stale min/max value
// left over from a previous pool occupant is never read without that gate.
//
// `cascadeStamp` additionally resets on `zone:teardown` (`05` §6.3: "The
// counter is per-actor, resets on zone change, and does not decay") — a
// generation bump does NOT happen on a zone transition for an actor that
// persists across it (the player), so the stamp technique alone cannot catch
// this; `onZoneTeardown` below does a single `cascadeStamp.fill(0)`, which
// decodes as "generation 0, count 0" for every slot — for a real actor whose
// `generation` happens to be 0 this is a literal, correct zero read; for any
// other generation it is a stamp mismatch, ALSO read as zero. Either way the
// counter reads 0 immediately after — no per-actor loop needed. The imbue
// itself (`imbueStamp`) is NOT reset on zone change — `05`/`11-flows.md` name
// no such rule for it, only for the cascade counter.
//
// ---------------------------------------------------------------------------
// The buff-duration number `05-skills.md` does not give (rule 6: report, do
// not fabricate)
// ---------------------------------------------------------------------------
// `11-flows.md` §5.8 step 3 literally calls `skills.applyBuff(actor,
// 'blade_seal', level, duration)` and step 7 disarms "at `imbueHits === 0`
// (or on `duration` expiry, whichever first)" — but no document anywhere
// gives blade_seal's own buff DURATION a number. `05-skills.md`'s own
// `blade_seal` `SkillDefinition` (`data/skills.js`) sets `duration: null`
// explicitly, and `05` §6.2's own field table has no duration row at all
// (only `castTime`, the 0.25 s CAST, a different number). Decision: the
// data record's own `duration: null` is treated as authoritative over
// `11-flows`'s generic call-signature template — the imbue is disarmed
// PURELY by `imbueHits` reaching 0 (fully exercised by this ticket's
// acceptance criteria), never by a fabricated wall-clock bound.
// `hasBladeSealBuff`/`bladeSealBuffRemaining`/`removeBladeSealBuff` below
// back `SkillsSystem`'s own `hasBuff`/`buffRemaining`/`removeBuff` (added in
// `./index.js`, this ticket's file, since nothing else in this codebase
// implements them yet — verified by grep) as a VIEW over the SAME imbue
// state rather than a second, parallel buff-instance store: `hasBuff`
// mirrors `imbueRemaining(actor) > 0`, `buffRemaining` reports `Infinity`
// while active (hits-bounded, not time-bounded) and `0` otherwise. A generic
// `applyBuff(actor, buffId, level, seconds)` entry point independent of a
// real `cast()` is NOT implemented as a re-armer (it cannot correctly derive
// `imbueHits`/element/flat-damage from a bare `seconds` argument) — see
// `./index.js`'s own comment on that method.
//
// ---------------------------------------------------------------------------
// `cascade`'s own damage number — the same "gap 1" `rune_strike`/
// `cleaving_strike` already accepted, not re-litigated here
// ---------------------------------------------------------------------------
// `combat.buildAttackPacket`'s own B2 step is hard-coded to
// `BASIC_ATTACK_WEAPON_DAMAGE = 100` regardless of `skillId` (`combat/
// packet.js`'s own documented "gap 1" — no per-skill `weaponDamage%` table
// exists in `combat` yet). `impl/rune_strike.js`/`impl/cleaving_strike.js`
// (SKIL-3/SKIL-4, already accepted) both call `buildAttackPacket` and use
// the result AS-IS, without hand-applying their own skill's `weaponDamage%`
// curve — an accepted, documented gap, not a per-skill workaround. This file
// follows the same precedent for `cascade`'s `70% + 6%/L` (+ the
// `rune_strike` synergy): NOT applied here either. What IS this file's own
// job (per `05` §6.3's own DamagePacket row) is the RE-TYPING from physical
// to magic after `buildAttackPacket` returns (`packet.magicMin/Max =
// packet.physMin/Max; packet.physMin/Max = 0`) and the B8 overrides
// (`attackRating 0`, `dodgeable false`, `blockable false` — "the wave always
// hits"). `cascade`'s own damage MAGNITUDE is therefore not exact against
// `03` §8.5's table — same limitation as its two siblings, flagged again
// here rather than silently inherited. The acceptance criteria this ticket
// is graded on (Resonance overflow, the imbue/cascade COUNTERS) do not
// depend on this number.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline
// ---------------------------------------------------------------------------
// Every per-actor array below is a fixed-capacity, `poolIndex`-indexed
// `Float64Array`/`Int32Array`, grown (never shrunk) on demand — no `Map`.
// `readImbue` returns a SHARED SCRATCH OBJECT (`imbueReadScratch`), mutated
// in place — copy its fields before a second call, same convention
// `SkillsSystem`'s own `_scratchInstance`/`_scratchResult` already establish.
// `hitPayload`/`cascadeTargetsOut` are single reused objects/typed arrays,
// mutated and emitted synchronously, matching `impl/cleaving_strike.js`'s
// own `_hitRequestPayload`/`coneOut` discipline exactly.

import { computeCastPhases } from './impl/bolt.js';
import { levelValue } from './cost.js';
import { buildStatusSpec, applyStatusSafe } from './status.js';

const SKILL_ID_BLADE_SEAL = 'blade_seal';
const SKILL_ID_CASCADE = 'cascade';

const ELEMENT_NAMES = Object.freeze(['fire', 'cold', 'lightning']);
const ELEMENT_MIN_KEY = Object.freeze(['fireMin', 'coldMin', 'lightMin']);
const ELEMENT_MAX_KEY = Object.freeze(['fireMax', 'coldMax', 'lightMax']);

/** `WEAPON_ATTACK_SKILL_IDS` — see the file header. Extend here, not
 * anywhere else, the day a second weapon-based Runeblade skill is cast-wired. */
const WEAPON_ATTACK_SKILL_IDS = new Set(['attack', 'rune_strike']);

/** `src/skills/cost.js#COOLDOWN_GEN_SCALE`'s own precedent, redeclared —
 * `ARCHITECTURE.md` rule 2 forbids importing a constant across a module
 * boundary that isn't a public export meant for cross-file reuse; this one
 * (like `combat/onhit.js#ACTION_RAGE_GEN_SCALE`) is a private implementation
 * detail of its own file. */
const GEN_SCALE = 2 ** 32;

function encodeStamp(generation, value) {
  return generation * GEN_SCALE + value;
}

/** `03 §7.4` "default seeding", restated by `05` §6.2's own blade_seal row
 * with the explicit `/3.0` — see the file header's dedicated section. */
const IMBUE_BURN_COEFFICIENT = 0.35;
const IMBUE_BURN_DURATION = 3.0;
const IMBUE_BURN_STACKS = 3;

/** Comfortably above `06-monsters-ai.md`'s largest documented pack (12) —
 * same headroom precedent `impl/cleaving_strike.js#MAX_CONE_TARGETS` and
 * `status.js#MAX_DETONATION_TARGETS` already establish. */
const MAX_CASCADE_TARGETS = 32;

/** `05` §6.3 / `03` §8.5: "After 3 empowered hits ... releases a wave." */
const CASCADE_TRIGGER_HITS = 3;

/**
 * Builds ONE self-contained imbue/cascade engine — all per-actor state lives
 * in this closure (never at module scope), so two independent `SkillsSystem`
 * instances (e.g. two tests booting their own `ctx`) never alias each
 * other's `poolIndex`-keyed arrays, the same isolation
 * `createCleavingStrikeSkill()`/`createRuneStrikeSkill()` already give their
 * own state. `./index.js#init()` calls this exactly once.
 * @returns {object} see the return statement at the bottom of this file for
 *   the full shape.
 */
export function createImbueEngine() {
  // --- per-actor state, poolIndex-indexed, generation-stamped (see header) ---
  let capacity = 64;
  let imbueStamp = new Float64Array(capacity); // packs (generation, hits*4 + (elemIdx+1))
  let imbueMin = new Float64Array(capacity); // unstamped — see header, "gated on hits>0"
  let imbueMax = new Float64Array(capacity);
  let cascadeStamp = new Float64Array(capacity); // packs (generation, count)

  function ensureStateCapacity(idx) {
    if (idx < capacity) return;
    const grown = Math.max(idx + 1, capacity * 2);
    const nextImbueStamp = new Float64Array(grown);
    const nextImbueMin = new Float64Array(grown);
    const nextImbueMax = new Float64Array(grown);
    const nextCascadeStamp = new Float64Array(grown);
    nextImbueStamp.set(imbueStamp);
    nextImbueMin.set(imbueMin);
    nextImbueMax.set(imbueMax);
    nextCascadeStamp.set(cascadeStamp);
    capacity = grown;
    imbueStamp = nextImbueStamp;
    imbueMin = nextImbueMin;
    imbueMax = nextImbueMax;
    cascadeStamp = nextCascadeStamp;
  }

  /** Shared scratch — see the file header's zero-allocation section. */
  const imbueReadScratch = { hits: 0, elemIdx: -1 };

  /** @param {object} actor @returns {{hits:number, elemIdx:number}} `imbueReadScratch` */
  function readImbue(actor) {
    imbueReadScratch.hits = 0;
    imbueReadScratch.elemIdx = -1;
    const idx = actor.poolIndex;
    if (idx >= capacity) return imbueReadScratch;
    const stamp = imbueStamp[idx];
    const generation = Math.floor(stamp / GEN_SCALE);
    if (generation !== actor.generation) return imbueReadScratch;
    const packed = stamp - generation * GEN_SCALE;
    imbueReadScratch.hits = Math.floor(packed / 4);
    imbueReadScratch.elemIdx = (packed % 4) - 1;
    return imbueReadScratch;
  }

  /** @param {object} actor @param {number} hits 0..5 @param {number} elemIdx -1..2 */
  function writeImbue(actor, hits, elemIdx) {
    const idx = actor.poolIndex;
    ensureStateCapacity(idx);
    imbueStamp[idx] = encodeStamp(actor.generation, hits * 4 + (elemIdx + 1));
  }

  /** @param {object} actor @returns {number} 0..2 */
  function readCascadeCount(actor) {
    const idx = actor.poolIndex;
    if (idx >= capacity) return 0;
    const stamp = cascadeStamp[idx];
    const generation = Math.floor(stamp / GEN_SCALE);
    if (generation !== actor.generation) return 0;
    return stamp - generation * GEN_SCALE;
  }

  /** @param {object} actor @param {number} count 0..2 */
  function writeCascadeCount(actor, count) {
    const idx = actor.poolIndex;
    ensureStateCapacity(idx);
    cascadeStamp[idx] = encodeStamp(actor.generation, count);
  }

  // -------------------------------------------------------------------
  // Stat-layer contribution — see the file header, "The stat layer" section.
  // Always writes all six keys (zero when inactive), never conditionally,
  // so the caller's partial object's hidden class stays stable.
  // -------------------------------------------------------------------

  /**
   * @param {object} actor
   * @param {object} partial the SAME partial `computePassiveLayer` returned
   *   — mutated in place, six keys always written.
   */
  function writeImbueStatPartial(actor, partial) {
    const state = readImbue(actor);
    const idx = actor.poolIndex;
    for (let i = 0; i < 3; i++) {
      const active = state.hits > 0 && state.elemIdx === i;
      partial[ELEMENT_MIN_KEY[i]] = active ? imbueMin[idx] : 0;
      partial[ELEMENT_MAX_KEY[i]] = active ? imbueMax[idx] : 0;
    }
  }

  // -------------------------------------------------------------------
  // `02-api-contracts.md` §10 reads — this ticket's own three contract rows.
  // -------------------------------------------------------------------

  /** `imbueRemaining(actor) => int` — `blade_seal` hits left. */
  function imbueRemaining(actor) {
    return readImbue(actor).hits;
  }

  /** `imbueElement(actor) => 'fire'|'cold'|'lightning'|null`. */
  function imbueElement(actor) {
    const state = readImbue(actor);
    return state.hits > 0 && state.elemIdx >= 0 ? ELEMENT_NAMES[state.elemIdx] : null;
  }

  /** `cascadeCharges(actor) => int` — 0..2, the empowered-hit counter. */
  function cascadeCharges(actor) {
    return readCascadeCount(actor);
  }

  // -------------------------------------------------------------------
  // `blade_seal` — cast handler
  // -------------------------------------------------------------------

  const phasesScratch = { windup: 0, active: 0, recover: 0, baseInterval: 0 };

  // --- per-actor pending-cast scratch, poolIndex-indexed (no Map) ---------
  // Same shape as impl/bolt.js's own pending arrays — deliberately a
  // SEPARATE capacity/array set from the imbueStamp/etc. group above (a
  // pending cast and an armed imbue are different lifetimes: a pending cast
  // is cleared at its own hitframe; an armed imbue survives many hitframes).
  let pendingCapacity = 64;
  let pendingActionSeq = new Int32Array(pendingCapacity).fill(-1);
  let pendingLevel = new Int32Array(pendingCapacity);

  function ensurePendingCapacity(idx) {
    if (idx < pendingCapacity) return;
    const grown = Math.max(idx + 1, pendingCapacity * 2);
    const nextSeq = new Int32Array(grown).fill(-1);
    const nextLevel = new Int32Array(grown);
    nextSeq.set(pendingActionSeq);
    nextLevel.set(pendingLevel);
    pendingCapacity = grown;
    pendingActionSeq = nextSeq;
    pendingLevel = nextLevel;
  }

  /** `05` §6.2's own imbue-count level-threshold table
   * (`def.extra.imbueCount.tiers`, `data/skills.js`, SKIL-1 data — read, not
   * fabricated here). Picks the count of the highest tier whose `minLevel`
   * the effective level clears.
   * @param {object} def @param {number} level @returns {number} 3, 4 or 5
   */
  function imbueCountForLevel(def, level) {
    const tiers = def.extra.imbueCount.tiers;
    let count = tiers[0].count;
    for (let i = 0; i < tiers.length; i++) {
      if (level >= tiers[i].minLevel) count = tiers[i].count;
    }
    return count;
  }

  /**
   * The "Arm" step (`11-flows.md` §5.8 step 3): cycles the element, sets
   * `imbueHits` from the level-threshold table, computes the flat elemental
   * amount ONCE (`05` §6.2's own `(2+2.5/L)-(7+4.5/L)` curve — `03` §8.5
   * verbatim), and pushes the merged stat-layer partial through
   * `deps.syncSkillsLayer` (see the file header — never a second, competing
   * `setSourceLayer('skills', ...)` call).
   * @param {object} actor @param {object} def `blade_seal`'s `SkillDefinition`
   * @param {number} level @param {object} deps
   */
  function armImbue(actor, def, level, deps) {
    const idx = actor.poolIndex;
    const prev = readImbue(actor);
    const prevElemIdx = prev.elemIdx; // cycle state persists even if the previous imbue already fully expired
    const nextElemIdx = (prevElemIdx + 1) % 3; // -1 -> 0 (fire): first cast is always fire
    const hits = imbueCountForLevel(def, level);

    const fd = def.flatDamage;
    ensureStateCapacity(idx);
    imbueMin[idx] = fd.minBase + fd.minPerLevel * (level - 1);
    imbueMax[idx] = fd.maxBase + fd.maxPerLevel * (level - 1);
    writeImbue(actor, hits, nextElemIdx);

    if (deps.syncSkillsLayer) deps.syncSkillsLayer(actor);
  }

  /**
   * `SkillsSystem.cast()`'s per-skill handler. `target: 'self'` — cursor
   * ignored, no movement (`05` §6.2's own "Click-to-move" row), so
   * `targetX`/`targetZ` are unused. Spends mana AND the whole Resonance bar
   * synchronously here (matching `impl/cleaving_strike.js`/`impl/
   * rune_strike.js`/`impl/bolt.js`'s own "spend at cast time" precedent);
   * the ARM itself (setting `imbueHits`/the stat layer) is deferred to the
   * cast's own `anim:hitframe`, matching those same three siblings' own
   * "effect resolves at the entry to `active`" precedent — `castTime 0.25 s`
   * gives `blade_seal` a real windup/active/recover split exactly like
   * `ember_bolt`'s own cast, reusing `computeCastPhases` unmodified.
   * @param {object} actor @param {object} def @param {number} level
   * @param {number} targetX @param {number} targetZ
   * @param {{actors:object, combat:object, skills:object, time:object}} deps
   * @returns {boolean}
   */
  function cast(actor, def, level, targetX, targetZ, deps) {
    void targetX;
    void targetZ;
    const { actors, combat, skills, time } = deps;

    // The Resonance half of the cost — `def.cost.resonance === 'all'` (D-05-2,
    // `01` §6.1's own 'all' convention) — is NOT covered by the generic
    // `costOf()`/`canCast()` resource check (that reads `def.cost.resource`,
    // `'mana'` here, only). Checked and refused BEFORE any spend, so a
    // sub-1 bar cast is a complete no-op — see the file header's self-check
    // requirement ("a cast at 0.4 refused").
    if (!(actor.resonance >= 1)) return false;

    const cost = skills.costOf(actor, def.id); // shared scratch — read now
    const resource = cost.resource;
    const amount = cost.amount;
    if (resource && !actors.canAfford(actor, resource, amount)) return false; // defensive; canCast already checked

    if (resource && !actors.spend(actor, resource, amount)) return false;
    // `spend('all')` re-checks `>= 1` itself (`vessels.js`) — this call
    // should never fail given the guard above; defensive only.
    if (!actors.spend(actor, 'resonance', 'all')) return false;

    const castIntervalNow = combat.castInterval(actor, def.id);
    computeCastPhases(castIntervalNow, def.castTime, phasesScratch);
    const actionSeq = actors.beginAction(actor, def.id, phasesScratch.windup, phasesScratch.active, phasesScratch.recover);

    ensurePendingCapacity(actor.poolIndex);
    const idx = actor.poolIndex;
    pendingActionSeq[idx] = actionSeq;
    pendingLevel[idx] = level;

    void time; // no cooldown to start — blade_seal's cooldown is {0,0,0}
    return true;
  }

  /** Permanent listener (registered once by `./index.js`) for
   * `ARCHITECTURE.md`'s `anim:hitframe` `{actor, actionId, actionSeq}`. */
  function onHitframe(payload, deps) {
    const actor = payload.actor;
    if (payload.actionId !== SKILL_ID_BLADE_SEAL) return;
    const idx = actor.poolIndex;
    if (idx >= pendingCapacity || pendingActionSeq[idx] !== payload.actionSeq) return; // stale or foreign
    pendingActionSeq[idx] = -1; // consumed
    const level = pendingLevel[idx];
    const def = deps.skills.definition(SKILL_ID_BLADE_SEAL);
    if (def) armImbue(actor, def, level, deps);
  }

  // -------------------------------------------------------------------
  // The shared `actor:damage` reaction — imbue decrement AND cascade's
  // counter/trigger, one listener, `11-flows.md` §5.8's own instruction.
  // -------------------------------------------------------------------

  const sourceRef = { id: 0, generation: 0 }; // reused ActorRef scratch — incinerate.js's own precedent
  const cascadeTargetsOut = new Int32Array(MAX_CASCADE_TARGETS);
  const hitPayload = { source: null, target: null, packet: null };

  /**
   * The fire-imbue burn seed — see the file header's dedicated section on
   * why this is NOT `./status.js#applyCoefficientRider`.
   * @param {object} target @param {object} result @param {object} deps
   */
  function maybeSeedFireBurn(target, result, deps) {
    if (!(result.fire > 0)) return;
    const magnitude = (IMBUE_BURN_COEFFICIENT * result.fire) / IMBUE_BURN_DURATION;
    const spec = buildStatusSpec({
      status: 'burning',
      step: deps.time.step,
      sourceId: result.sourceId,
      sourceGen: result.sourceGen,
      sourceSkill: result.sourceSkillId,
      element: 'fire',
      magnitude,
      duration: IMBUE_BURN_DURATION,
      stacks: IMBUE_BURN_STACKS,
    });
    applyStatusSafe(deps.actors, target, spec);
  }

  /**
   * Fires the cascade wave — `05` §6.3's own `DamagePacket` row: built via
   * `combat.buildAttackPacket`, re-typed physical -> magic, `attackRating 0`/
   * `dodgeable false`/`blockable false` ("the wave always hits"). See the
   * file header for why the `weaponDamage%` coefficient itself is not
   * hand-applied (the same accepted "gap 1" `rune_strike`/`cleaving_strike`
   * already carry).
   * @param {object} actor @param {number} level @param {object} deps
   */
  function fireCascadeWave(actor, level, deps) {
    const { combat, physics, actors, events, skills } = deps;
    const def = skills.definition(SKILL_ID_CASCADE);
    if (!def) return;

    const radius = levelValue(def.radius, level);
    const mask = actor.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
    const count = physics.overlapCircle(actor.x, actor.z, radius, mask, cascadeTargetsOut);
    const view = cascadeTargetsOut.subarray(0, count);
    view.sort(); // "multi-target resolve in actor.id order" — 05 §14 row 3's determinism rule, applied generically

    const packet = combat.buildAttackPacket(actor, SKILL_ID_CASCADE, level);
    if (!packet) return; // pool exhausted — nothing to resolve

    packet.magicMin = packet.physMin;
    packet.magicMax = packet.physMax;
    packet.physMin = 0;
    packet.physMax = 0;
    packet.attackRating = 0;
    packet.dodgeable = false;
    packet.blockable = false;

    let fired = false;
    for (let i = 0; i < view.length; i++) {
      const targetId = view[i];
      if (targetId === actor.id) continue;
      const target = actors.byId(targetId);
      if (!target || target.dead) continue;
      hitPayload.source = actor;
      hitPayload.target = target;
      hitPayload.packet = packet;
      events.emit('combat:hit-request', hitPayload);
      fired = true;
    }
    combat.releasePacket(packet);

    if (fired && events && typeof events.emit === 'function') {
      // ARCHITECTURE.md's own event table: a passive TRIGGER (not a cast)
      // needs `skill:trigger`, not `skill:impact`, so fx/audio can tell the
      // two apart — same reasoning `status.js#createIncinerateReaction`
      // already documents for its own detonation.
      events.emit('skill:trigger', { actor, skillId: SKILL_ID_CASCADE, level });
    }
  }

  /**
   * The single `actor:damage` listener this ticket wires — imbue decrement
   * (`11-flows.md` §5.8 step 6) and cascade's counter/trigger (`05` §6.3),
   * in that order, sharing one payload read.
   * @param {{target:object, source:object|null, result:object}} payload
   * @param {{actors:object, combat:object, physics:object, events:object, time:object, skills:object, syncSkillsLayer:Function}} deps
   */
  function onActorDamage(payload, deps) {
    const result = payload.result;
    if (!result) return;

    const outcome = result.outcome;
    // "landed" — see the file header's dedicated section on the 05/11-flows
    // block contradiction: outcome ∈ {hit, block}, per 11-flows (D-44).
    if (outcome !== 'hit' && outcome !== 'block') return;
    if (!WEAPON_ATTACK_SKILL_IDS.has(result.sourceSkillId)) return;

    sourceRef.id = result.sourceId;
    sourceRef.generation = result.sourceGen;
    const source = deps.actors.resolve(sourceRef);
    if (!source || source.dead) return;

    const before = readImbue(source);
    const wasImbued = before.hits > 0;
    const activeElemIdx = before.elemIdx;

    if (wasImbued) {
      const newHits = before.hits - 1;
      writeImbue(source, newHits, activeElemIdx);
      if (newHits === 0 && deps.syncSkillsLayer) deps.syncSkillsLayer(source); // disarm — 11-flows step 7
      if (activeElemIdx === 0 && payload.target) maybeSeedFireBurn(payload.target, result, deps); // fire — see maybeSeedFireBurn's own header
      // cold: nothing to do — combat's own chill listener is already live (see file header)
      // lightning: "carries no rider on its own" (05 §6.2) — nothing to do
    }

    const cascadeLevel = deps.skills.effectiveLevel(source, SKILL_ID_CASCADE);
    if (cascadeLevel > 0 && (result.sourceSkillId === 'rune_strike' || wasImbued)) {
      const count = readCascadeCount(source) + 1;
      if (count >= CASCADE_TRIGGER_HITS) {
        writeCascadeCount(source, 0);
        fireCascadeWave(source, cascadeLevel, deps);
      } else {
        writeCascadeCount(source, count);
      }
    }
  }

  /** `zone:teardown` — see the file header's "resets on zone change" section. */
  function onZoneTeardown() {
    cascadeStamp.fill(0);
  }

  // -------------------------------------------------------------------
  // Buff-shaped view over the SAME imbue state — see the file header,
  // "The buff-duration number ... " section. `buffId !== 'blade_seal'` is a
  // documented no-op everywhere below, never an assertion that nothing else
  // exists (O-27/O-39).
  // -------------------------------------------------------------------

  function hasBladeSealBuff(actor) {
    return imbueRemaining(actor) > 0;
  }

  /** `Infinity` while active (hits-bounded, not time-bounded — `duration:
   * null`, see the file header), `0` otherwise. */
  function bladeSealBuffRemaining(actor) {
    return hasBladeSealBuff(actor) ? Infinity : 0;
  }

  // `imbueLevel` is not separately stored — `imbueMin`/`imbueMax` (the
  // per-level flat damage) already carry every number this ticket's own
  // mechanics need; the skill LEVEL itself is not persisted anywhere in this
  // file. `bladeSealBuffLevel` therefore reports 0 rather than a fabricated
  // number — see ./index.js's own `buffList` comment for why this is an
  // accepted, narrow gap (the HUD's buff strip is a later ticket's; no
  // consumer reads this field today).
  function bladeSealBuffLevel(actor) {
    void actor;
    return 0;
  }

  /** Force-disarms the imbue (does not touch the element cycle). */
  function removeBladeSealBuff(actor, deps) {
    if (!hasBladeSealBuff(actor)) return;
    const state = readImbue(actor);
    writeImbue(actor, 0, state.elemIdx);
    if (deps && deps.syncSkillsLayer) deps.syncSkillsLayer(actor);
  }

  return {
    bladeSeal: { skillId: SKILL_ID_BLADE_SEAL, cast, onHitframe },
    onActorDamage,
    onZoneTeardown,
    writeImbueStatPartial,
    imbueRemaining,
    imbueElement,
    cascadeCharges,
    hasBladeSealBuff,
    bladeSealBuffRemaining,
    bladeSealBuffLevel,
    removeBladeSealBuff,
  };
}
