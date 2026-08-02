// src/combat/resolve.js
//
// CMBT-3 — the defender-side resolve pipeline: `03-combat-math.md` §6.2
// (R1-R14) and §6.3/§6.4 (what R14(b) seeds, what heal() is). `resolve`,
// `applyDirect`, `heal`, `effectiveResist`, `isImmune` are the five
// `02-api-contracts.md` §8 methods this ticket adds; `packet.js` (CMBT-1,
// already accepted) imports this file and attaches them to `CombatSystem` —
// see that file's own header for the one-way sibling-import rule this file
// follows (exports plain functions, imports nothing from `packet.js`).
//
// Backlog correction D-14 (already applied): this ticket is E4/E12/E13, not
// "E9-E13" — E9 (rage, CMBT-7), E10 (XP, CMBT-6) and E11 (knockback,
// CMBT-5) are NOT implemented here. R14's fixed order still names all of
// (a)-(k); this file implements (a) life, (b) poison seed, (c) onHitStatus
// riders, (d) life/mana steal + lifeOnHit/manaOnHit, (e) thorns and (k) the
// event — (f) rage, (g) hit recovery, (h) knockback, (i) death/actor:death,
// (j) XP are left as documented no-op seams, called in order, doing nothing.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline (12.A05: 12-target flame_wave, resolve() < 1
// byte/call)
// ---------------------------------------------------------------------------
// `resolveDamage` itself never allocates: every per-hit scratch value is a
// local primitive (JS numbers/booleans on the stack, never boxed), the five
// elemental components are unrolled rather than looped over a per-call
// array, and `out` (the pooled `DamageResult`) doubles as scratch storage
// for the fire/cold/lightning/magic running totals so no extra object is
// needed. Every object this pipeline touches beyond `packet`/`target`/`out`
// — the `env` bag, its nested `env.thornsEnv`, `env.statusSpec`,
// `env.damagePayload`, the `ActorRef` scratch `packet.js` builds — is
// constructed exactly once, in `CombatSystem.init()`, and mutated in place
// on every call (the same discipline `packet.js`'s own `PacketPool`/
// `motion.js`'s `_moveResult` already establish). The one path that still
// touches a pool is R14(e) thorns, and it only ever *acquires* (never
// `new`s) a `DamagePacket`/`DamageResult` — `02-api-contracts.md`'s own
// `Alloc: pool` column for `resolve`.
//
// `Map` is not used anywhere in this file (pooled state ban). `Math.hypot`
// is not used (frontal-arc check uses `Math.atan2`, which does not
// allocate). `array.length = 0` is never done to a pooled array.
//
// ---------------------------------------------------------------------------
// Cross-subsystem gaps this ticket ran into
// ---------------------------------------------------------------------------
// 1. `ActorsSystem` (`src/actors/index.js`) does not yet forward
//    `applyStatus`/`stats`/`addLife`/`addMana` from their sibling files
//    (`status.js`/`stats.js`/`vessels.js`) onto its own public class — each
//    of those files' own header says wiring them in is a later ticket's job,
//    and none of ACTR-7/8/10 touched `index.js`. That means R14(b) (seed the
//    poison DoT) and R14(c) (apply onHitStatus riders) cannot actually
//    create a `StatusEffectInstance` today: there is no `applyStatus` method
//    reachable through `ctx.get('actors')`. Both steps are structured as a
//    guarded call — `typeof env.actorsSystem.applyStatus === 'function'` —
//    the same `ctx.peek('nav')` / `typeof nav.snap === 'function'` pattern
//    `src/actors/motion.js`'s `teleport()` already uses for a sibling
//    subsystem that may not exist yet. The call sites are real and in the
//    documented R14 order; they simply no-op until `actors` wires the method
//    in. Flagged again in this ticket's report.
// 2. No dedicated packet field distinguishes a melee attack from a ranged
//    or spell one (`01-data-model.md` §8.1's `DamagePacket` has no such
//    flag). R14(e) ("thorns back at a MELEE attacker") infers melee-ness as
//    "a weapon-based physical attack": `packet.attackRating > 0` AND a
//    nonzero `physMin`/`physMax` range. This is a documented inference, not
//    a spec-stated rule — see this ticket's report.
// 3. `ARCHITECTURE.md`'s cross-subsystem event table makes `combat` the sole
//    listener of `combat:hit-request`; nothing in `packet.js` (CMBT-1)
//    subscribed to it yet. `packet.js`'s wiring change (see that file) adds
//    one `ctx.events.on('combat:hit-request', ...)` in `init()`, calling
//    straight into `resolve()`.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file.
//
// ---------------------------------------------------------------------------
// CMBT-9 (D-55) addendum — R14(c) now imports from `./status.js`
// ---------------------------------------------------------------------------
// Defect B: this file's own R14(c) rider loop applied `rider.magnitude`/
// `rider.duration` verbatim — no diminishing-returns chain, no ccReduction,
// no rank multiplier — so a status applied through THIS file's default
// `resolve()` path (a monster's attack, any caller that never routes through
// `combat.applyStatusFromPacket()`) skipped the CC lock entirely. Fixed by
// importing `rollDrChain`/`STUNNED_BOSS_DURATION_MULT` — `./status.js`'s
// (CMBT-4) own EXPORTED public surface — rather than re-implementing the
// stateful chain a second time; see the R14(c) block below and its own
// `DR_CHAIN_STATUSES` comment for what could and could not be shared given
// `status.js` is not in this ticket's file list (its `ccMultiplierOf`/
// `CC_REDUCTION_EXEMPT_STATUSES`/`DR_CHAIN_STATUSES` are module-private,
// duplicated here as the small fixed spec-literal constants they are).
//
// This makes `resolve.js` <-> `status.js` a genuine two-way sibling import
// (`status.js` already imports `resistAfterPierce`/`isImmuneAtResist`/
// `cappedEffectiveResist`/`applyResistFactor` from this file) — a real
// tension with this file's own "one-way sibling import" precedent (line 8,
// about `packet.js`). Verified safe in practice: neither file calls into the
// other at module-evaluation time (only inside function bodies, invoked well
// after both modules finish loading), so Node's ESM loader resolves the
// cycle with live bindings and no TDZ error — confirmed by `npm run build`
// and the full test suite (see this ticket's report). Flagged here rather
// than silently introduced.
//
// ---------------------------------------------------------------------------
// SKIL-10/O-90 addendum — R13 gains one hook: absorb pool consumption
// ---------------------------------------------------------------------------
// `05-skills.md` §3.5/§5.3: "absorb is consumed at R13, before `life -=
// total`... It is not a resistance and is not affected by `physicalResist`"
// and "a single hit larger than `life + absorb` still kills. The absorb is
// not a death save." `src/combat/resolve.js` is granted to SKIL-10 as a
// named micro-scope for exactly this hook (precedent D-38/PLYR-4) — R14, the
// DR chain, the rider loop and `requesterOwnsRageCredit` are untouched.
//
// `consumeAbsorbPools` below is the ONLY change this addendum makes: one
// call, inserted after R13 finishes computing `out.total`/`out.outcome` and
// before `applyR14()` runs, so `applyR14`'s own `(a) life -= total` (and its
// `overkill` calculation, which reads the same `out.total`) sees the
// ALREADY-absorbed figure. `combat` never imports anything from
// `src/skills/` to do this (`ARCHITECTURE.md` rule 2) — `target.absorbPools`
// is plain data on the shared Actor record, written by
// `src/skills/buff.js` and read/mutated here exactly the way
// `shockedStacksOf()` above already reads `target.statuses` directly. See
// `buff.js`'s own header for the full shape and the generation-stamping
// rationale (recycle safety with no shared pool to leak from — O-49).
//
// A hit that ends outcome `'block'` (all damage already 0, R13's `total`
// computation never runs for it) or that returns early at R1-R4 never
// reaches this hook — matching exactly where R13 itself sits in the
// pipeline; nothing to absorb on those paths regardless.
//
// Ambiguity resolved (rule per D-16, "say which one and stop"): `05`'s
// "including poison seeding" phrase is read as "absorb is not exempted just
// because a poison-flavoured component is present", NOT as "the poison DoT
// seed (R14(b), which this hook may not touch) is itself reduced by
// absorb" — `03` §6.2's own R13 row already excludes poison from `total`
// ("poison is *not* summed here"), so a poison DoT seeded by an absorbed hit
// is unaffected by this change, same as before. See `buff.js`'s header,
// "Explicitly NOT implemented" item 3, for the fuller reasoning.

import { chanceToHit, blockChanceOf } from './tohit.js';
import { rollDrChain, STUNNED_BOSS_DURATION_MULT } from './status.js';

// ---------------------------------------------------------------------------
// Small local constants — redeclared rather than imported, matching the
// precedent `src/actors/vessels.js`'s `POISONED_STATUS_BIT` and
// `src/actors/status.js`'s own header already set for exactly this
// situation (a spec-fixed bit position/enum value, needed by a sibling
// subsystem that may not export it yet).
// ---------------------------------------------------------------------------

/** `01-data-model.md` §1.2, verbatim: `TEAM.neutral = 2`. Not exported
 * anywhere in `src/actors/` today. */
const TEAM_NEUTRAL = 2;

/** `01-data-model.md` §2.1: `ACTOR_FLAG.invulnerable = 1 << 0`. Not exported
 * anywhere in `src/actors/` today (the whole `ACTOR_FLAG` table is
 * documented but has no `export const` yet). */
const INVULNERABLE_FLAG_BIT = 1 << 0;

/** `01-data-model.md` §7.2, verbatim bit table — only `shocked`'s and
 * `poisoned`'s bits are actually consumed here (R12's amplification and
 * R14(b)/(c)'s `result.statusApplied` bitfield), but the full table is kept
 * so a status rider of any kind can set the right bit. */
const STATUS_BIT = Object.freeze({
  burning: 1 << 0, poisoned: 1 << 1, bleeding: 1 << 2, shocked: 1 << 3, chilled: 1 << 4,
  frozen: 1 << 5, slowed: 1 << 6, stunned: 1 << 7, blinded: 1 << 8, cursed: 1 << 9,
});

/** `03-combat-math.md` §7.6: "12 (% extra damage taken) per stack." */
const SHOCKED_PERCENT_PER_STACK = 12;

// ---------------------------------------------------------------------------
// CMBT-9/D-55, defect B — R14(c)'s riders now consult the same
// diminishing-returns chain `combat.applyStatusFromPacket()` (CMBT-4, this
// file's sibling `./status.js`) uses, instead of applying `rider.magnitude`/
// `rider.duration` verbatim. `rollDrChain` and `STUNNED_BOSS_DURATION_MULT`
// are imported (that file's actual EXPORTED public surface) rather than
// re-implemented — the stateful chain itself (`actor.stunChain`/
// `stunChainAt`/`ccImmuneUntil`) is the one piece that must never have two
// independent implementations, or the two paths could disagree about how
// many "slots" an actor has used. `status.js`'s own `ccMultiplierOf` and
// `CC_REDUCTION_EXEMPT_STATUSES`/`DR_CHAIN_STATUSES` are module-private
// (not exported) and `status.js` itself is not in this ticket's file list
// (see this ticket's report) — those three are duplicated below as the
// one-line spec formula / two small fixed sets they are, not as logic that
// could silently drift independently of the `03 §7` preamble text both
// files already quote verbatim.
// ---------------------------------------------------------------------------

/** `03 §7.7`'s DR chain is shared by `stunned` and `frozen` — the same
 * two-item set `status.js`'s own (private) `DR_CHAIN_STATUSES` names.
 *
 * Known, documented divergence for `frozen`: `status.js#applyOneRider`'s own
 * `frozen` branch does not use this generic path at all — it calls the
 * module-private `tryTriggerFreeze` (not exported), which IGNORES
 * `rider.magnitude`/`rider.duration` entirely and substitutes the fixed
 * `03 §7.2` formula (`FROZEN_BASE_DURATION × rank multiplier × dr.multiplier
 * × ccMultiplierOf`, or a boss's `chilled`(60, 2.0s) substitution). That
 * function is not reachable from here without either exporting it (out of
 * this ticket's file list — `status.js` is not touchable, see the report)
 * or duplicating its boss-substitution/`cannotBeFrozen`/champion-unique-rank
 * branches wholesale. `status.js`'s own header already calls a direct
 * `frozen` `onHitStatus` rider speculative ("no documented worked example
 * exercises today") — no skill/monster data uses one. A `frozen` rider
 * reaching THIS loop below is therefore handled through the generic
 * DR-chain-gated branch (consulting the shared chain, so it still cannot
 * bypass the CC lock or double-book a chain slot), but with `rider.duration`
 * scaled by `dr.multiplier × ccMultiplierOf` rather than the boss/rank
 * substitution `applyStatusFromPacket` would use. Flagged here rather than
 * silently guessed at; see this ticket's report. */
const DR_CHAIN_STATUSES = new Set(['stunned', 'frozen']);

/** `03 §7`'s preamble: every duration is ccReduction-adjusted EXCEPT these
 * three, "whose durations are fixed by the applying skill" — the same
 * three-item set `status.js`'s own (private) `CC_REDUCTION_EXEMPT_STATUSES`
 * names. */
const CC_REDUCTION_EXEMPT_STATUSES = new Set(['burning', 'poisoned', 'bleeding']);

/** `03 §7`'s preamble formula, verbatim: `(1 − clamp(ccReduction,0,75)/100)`.
 * `0` (no reduction) when `target.stats` is not yet composed — same
 * defensive default `status.js`'s own (private) `ccMultiplierOf` uses.
 * @param {object} actor
 * @returns {number}
 */
function ccMultiplierOf(actor) {
  const cc = actor.stats ? clamp(actor.stats.ccReduction, 0, 75) : 0;
  return 1 - cc / 100;
}

/** `01-data-model.md` §11.1: `DamageResult | combat | 256` — same capacity
 * as `packet.js`'s `PACKET_POOL_CAPACITY`. */
export const RESULT_POOL_CAPACITY = 256;

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// ---------------------------------------------------------------------------
// DamageResult — shape, pool, reset (`01-data-model.md` §8.2)
// ---------------------------------------------------------------------------

function createDamageResult(poolIndex) {
  return {
    targetId: 0, targetGen: 0, sourceId: 0, sourceGen: 0, sourceSkillId: null,

    outcome: 'invalid', crit: false, blocked: false, killed: false, overkill: 0,

    physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 0,

    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,

    statusApplied: 0, hitRecovery: false, knockedBack: false,

    pointX: 0, pointY: 0, pointZ: 0,
    poolIndex,
  };
}

/** Resets every field but `poolIndex` — mirrors `packet.js`'s
 * `resetPacketFields` discipline exactly (`01` §11.2 rule 6). */
export function resetResultFields(r) {
  r.targetId = 0; r.targetGen = 0; r.sourceId = 0; r.sourceGen = 0; r.sourceSkillId = null;

  r.outcome = 'invalid'; r.crit = false; r.blocked = false; r.killed = false; r.overkill = 0;

  r.physical = 0; r.fire = 0; r.cold = 0; r.lightning = 0; r.poison = 0; r.magic = 0; r.total = 0;

  r.lifeStolen = 0; r.manaStolen = 0; r.manaReturned = 0; r.thornsDealt = 0;

  r.statusApplied = 0; r.hitRecovery = false; r.knockedBack = false;

  r.pointX = 0; r.pointY = 0; r.pointZ = 0;
  // r.poolIndex untouched.
}

/** Same free-list-of-indices shape as `packet.js`'s `PacketPool` — no `Map`
 * anywhere, liveness in a private `Uint8Array`, double-release a safe no-op. */
export class DamageResultPool {
  constructor(capacity) {
    this._capacity = capacity;
    this._records = new Array(capacity);
    for (let i = 0; i < capacity; i++) this._records[i] = createDamageResult(i);

    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;

    this._inUse = new Uint8Array(capacity);
  }

  get capacity() {
    return this._capacity;
  }

  acquire() {
    if (this._freeCount === 0) return null;
    const slot = this._freeSlots[--this._freeCount];
    const r = this._records[slot];
    resetResultFields(r);
    this._inUse[slot] = 1;
    return r;
  }

  release(r) {
    if (!r) return;
    const slot = r.poolIndex;
    if (slot < 0 || slot >= this._capacity || this._records[slot] !== r) return;
    if (!this._inUse[slot]) return;
    resetResultFields(r);
    this._inUse[slot] = 0;
    this._freeSlots[this._freeCount++] = slot;
  }

  dispose() {
    this._freeCount = 0;
  }
}

// ---------------------------------------------------------------------------
// R1 — validity
// ---------------------------------------------------------------------------

/** `01-data-model.md` §1.2's hostility test, verbatim:
 * `a.team !== b.team && a.team !== TEAM.neutral && b.team !== TEAM.neutral`.
 * @param {number} teamA
 * @param {number} teamB
 * @returns {boolean}
 */
export function isHostile(teamA, teamB) {
  return teamA !== teamB && teamA !== TEAM_NEUTRAL && teamB !== TEAM_NEUTRAL;
}

/** R1: target exists, `!dead`, hostile to the packet's team, not
 * invulnerable, `now >= invulnUntil`.
 * @param {object} packet
 * @param {object|null} target
 * @param {number} step
 * @returns {boolean}
 */
export function isValidTarget(packet, target, step) {
  if (!target) return false;
  if (target.dead) return false;
  if (!isHostile(packet.team, target.team)) return false;
  if ((target.flags & INVULNERABLE_FLAG_BIT) !== 0) return false;
  if (step < target.invulnUntil) return false;
  return true;
}

// ---------------------------------------------------------------------------
// R2-R4 — to-hit, dodge, block. One `U(0,100)` draw each, short-circuiting.
// ---------------------------------------------------------------------------

/** A single `%`-space draw — `rng.next() * 100`, `[0, 100)`. Every R2/R3/R4/
 * R6/R14(c) roll goes through this one helper so "one RNG draw" is visibly
 * true at every call site. */
function draw100(rng) {
  return rng.next() * 100;
}

function wrapAnglePi(a) {
  return ((a % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
}

/** R4's "frontal 180° arc" gate: is `originX/originZ` within the defender's
 * forward hemisphere? `facing`'s own convention (`01-data-model.md` §2):
 * `0 = +X, CCW positive`, i.e. forward = `(cos(facing), sin(facing))` in the
 * `(x, z)` plane (`src/actors/motion.js`'s own `atan2(z, x)` note). Origin
 * coincident with the target (a degenerate 0-length vector — an
 * environmental/self-origin packet) is treated as frontal, defensively.
 * @param {object} target
 * @param {number} originX
 * @param {number} originZ
 * @returns {boolean}
 */
export function isFrontalHit(target, originX, originZ) {
  const dx = originX - target.x;
  const dz = originZ - target.z;
  if (dx === 0 && dz === 0) return true;
  const angleToSource = Math.atan2(dz, dx);
  const delta = wrapAnglePi(angleToSource - target.facing);
  return Math.abs(delta) <= Math.PI / 2;
}

// ---------------------------------------------------------------------------
// R5/R6 — physical roll, crit
// ---------------------------------------------------------------------------

function rollUniform(rng, min, max) {
  return rng.range(min, max);
}

/** R6: one `U(0,100) < critChance` draw for the whole hit. */
function rollCrit(rng, critChance) {
  return draw100(rng) < critChance;
}

// ---------------------------------------------------------------------------
// R7 — physical mitigation, in order. Three separate steps so a test can
// assert E12's own R7a/R7b/R7c labels directly.
// ---------------------------------------------------------------------------

/** R7a: `phys -= damageReduceFlat`. */
export function stepR7a(phys, damageReduceFlat) {
  return phys - damageReduceFlat;
}

/** R7b: `phys *= (1 - clamp(damageReducePercent, 0, 50) / 100)`. The clamp
 * is defensive — `composeStats` already caps `damageReducePercent` to
 * `[0, 50]` before combat ever sees it. */
export function stepR7b(phys, damageReducePercent) {
  const pct = clamp(damageReducePercent, 0, 50);
  return phys * (1 - pct / 100);
}

/** R7c: `phys *= (1 - effectiveResist(physical)/100)`. `physicalResist` is
 * already clamped to `[-200, maxPhysicalResist]` by `composeStats`'s own
 * step 9, so no re-clamp here (unlike R10, which re-derives its own clamp
 * after subtracting pierce — physical has no pierce stat). Result is NOT
 * clamped `>= 0` here — that final clamp is the caller's job (R7's own
 * closing "Clamp phys >= 0").
 */
export function stepR7c(phys, physicalResist) {
  return phys * (1 - physicalResist / 100);
}

// ---------------------------------------------------------------------------
// R9/R10 — pierce, immunity, resistance application. Pure scalar functions,
// each one E4's own row maps onto directly.
// ---------------------------------------------------------------------------

/** R9's `r = targetResist - packetPierce`. */
export function resistAfterPierce(targetResist, pierce) {
  return targetResist - pierce;
}

/** R9: `r >= 100` is immune. Checked on the PRE-cap `r` — pierce can lower
 * `r` below 100 and break an immunity (E4.7); it can never raise it. */
export function isImmuneAtResist(r) {
  return r >= 100;
}

/** R10's `effective = clamp(r, -200, maxResistForElement)`. */
export function cappedEffectiveResist(r, maxResistForElement) {
  return clamp(r, -200, maxResistForElement);
}

/** R10's `dmg *= (1 - effective/100)`. */
export function applyResistFactor(dmg, effectiveResistPercent) {
  return dmg * (1 - effectiveResistPercent / 100);
}

// ---------------------------------------------------------------------------
// R13 — sum and floor
// ---------------------------------------------------------------------------

/** R13's conditional floor: "if any component was greater than 0 before
 * mitigation and total < 1, set total = 1." `anyPositiveNonImmune` must
 * already exclude any component that ended up fully immune (03's own note:
 * "a hit fully absorbed by immunity stays 0"). */
export function applyTotalFloor(total, anyPositiveNonImmune) {
  if (anyPositiveNonImmune && total < 1) return 1;
  return total;
}

// ---------------------------------------------------------------------------
// SKIL-10/O-90 — absorb pool consumption, R13. See this file's header
// addendum above for the full reasoning.
// ---------------------------------------------------------------------------

/**
 * `target.absorbPools`, when present, has the shape `{ generation:number,
 * count:number, amount:Float64Array, buffIdx:Int32Array, level:Int32Array,
 * expiresStep:Float64Array }` — built and owned by `src/skills/buff.js`; see
 * that file's own header for why this lives on the Actor record instead of
 * a `skills`-owned closure. Pools are stored oldest-first by array position
 * (index 0 is always the oldest still-live pool); this function consumes
 * strictly in that order, mutating `amount[]` in place, and compacts away
 * any pool that is exhausted (`amount <= 0`) or has expired
 * (`expiresStep <= step`) so the "index 0 is oldest SURVIVING pool"
 * invariant holds after every call. A stale `generation` (a previous
 * occupant of this actor-record slot left pools behind) reads as "no
 * absorb", matching the same generation-stamp discipline used everywhere
 * else in this codebase. Never allocates.
 * @param {object} target an Actor
 * @param {number} total R13's post-floor `total`, pre-absorb
 * @param {number} step `ctx.time.step` (`env.step`)
 * @returns {number} `total`, reduced by whatever absorb consumed — never
 *   negative, never more than `total` itself. "Not a death save": if `total`
 *   exceeds every pool's remaining amount combined, the unabsorbed remainder
 *   is returned and still reaches R14(a)'s `life -= total`.
 */
export function consumeAbsorbPools(target, total, step) {
  const a = target.absorbPools;
  if (!a || a.generation !== target.generation || a.count === 0 || !(total > 0)) return total;

  let remaining = total;
  let w = 0;
  for (let r = 0; r < a.count; r++) {
    const expired = a.expiresStep[r] <= step;
    if (!expired && remaining > 0 && a.amount[r] > 0) {
      const absorbed = remaining < a.amount[r] ? remaining : a.amount[r];
      a.amount[r] -= absorbed;
      remaining -= absorbed;
    }
    const exhausted = a.amount[r] <= 0;
    if (!expired && !exhausted) {
      if (w !== r) {
        a.amount[w] = a.amount[r];
        a.buffIdx[w] = a.buffIdx[r];
        a.level[w] = a.level[r];
        a.expiresStep[w] = a.expiresStep[r];
      }
      w++;
    }
  }
  a.count = w;
  return remaining;
}

// ---------------------------------------------------------------------------
// effectiveResist / isImmune — 02-api-contracts.md §8 public utilities
// ---------------------------------------------------------------------------

/** element -> { statResist, statMaxResist, statPierce (or null) }. Fixed
 * order fire, cold, lightning, poison, magic (03's own "ELEMENT_ORDER"), plus
 * `physical` (no pierce stat, no immunity concept — `effectiveResist` still
 * answers "what % reduction", `isImmune` always false for it). Frozen,
 * module-level — iterating/indexing it never allocates. */
const ELEMENT_DEFS = Object.freeze([
  Object.freeze({ key: 'fire', packetPrefix: 'fire', statResist: 'fireResist', statMaxResist: 'maxFireResist', statPierce: 'fireResistPierce', resultKey: 'fire' }),
  Object.freeze({ key: 'cold', packetPrefix: 'cold', statResist: 'coldResist', statMaxResist: 'maxColdResist', statPierce: 'coldResistPierce', resultKey: 'cold' }),
  Object.freeze({ key: 'lightning', packetPrefix: 'light', statResist: 'lightResist', statMaxResist: 'maxLightResist', statPierce: 'lightResistPierce', resultKey: 'lightning' }),
  Object.freeze({ key: 'poison', packetPrefix: 'poison', statResist: 'poisonResist', statMaxResist: 'maxPoisonResist', statPierce: 'poisonResistPierce', resultKey: 'poison' }),
  Object.freeze({ key: 'magic', packetPrefix: 'magic', statResist: 'magicResist', statMaxResist: 'maxMagicResist', statPierce: null, resultKey: 'magic' }),
]);

const PHYSICAL_DEF = Object.freeze({ key: 'physical', statResist: 'physicalResist', statMaxResist: 'maxPhysicalResist', statPierce: null });

export const ELEMENT_ORDER = Object.freeze(ELEMENT_DEFS.map((d) => d.key));

function defForElement(element) {
  if (element === 'physical') return PHYSICAL_DEF;
  for (let i = 0; i < ELEMENT_DEFS.length; i++) {
    if (ELEMENT_DEFS[i].key === element) return ELEMENT_DEFS[i];
  }
  return null;
}

/** `02-api-contracts.md` §8: `effectiveResist(target, element, pierce) =>
 * number` — post-cap, post-pierce. Unknown `element` throws (a typo should
 * not silently read `undefined` arithmetic). */
export function effectiveResistOf(target, element, pierce) {
  const def = defForElement(element);
  if (!def) throw new Error(`combat: effectiveResist: unknown element '${element}'`);
  const stats = target.stats;
  const r = resistAfterPierce(stats[def.statResist], pierce || 0);
  return cappedEffectiveResist(r, stats[def.statMaxResist]);
}

/** `02-api-contracts.md` §8: `isImmune(target, element) => boolean`. No
 * `pierce` in this method's own documented signature — this answers "is the
 * target immune in its own right" (a general query, e.g. for AI target
 * selection), checked on the RAW resist (pre-cap, no pierce subtracted).
 * `resolve()`'s own R9 gate takes the packet's pierce into account itself
 * (`resistAfterPierce` + `isImmuneAtResist`) rather than calling this. */
export function isImmuneOf(target, element) {
  const def = defForElement(element);
  if (!def) throw new Error(`combat: isImmune: unknown element '${element}'`);
  if (def.key === 'physical') return false; // no immunity concept for physical
  return isImmuneAtResist(target.stats[def.statResist]);
}

// ---------------------------------------------------------------------------
// shocked stacks — read straight off the plain Actor record (`actor.statuses`
// is a data field on the shared record, same as `actor.stats`; reading it
// directly is not an import of `src/actors/status.js`, the same distinction
// `packet.js#requireStats` already relies on for `source.stats`).
// ---------------------------------------------------------------------------

function shockedStacksOf(target) {
  const list = target.statuses;
  if (!list || list.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === 'shocked') total += list[i].stacks;
  }
  return total;
}

// ---------------------------------------------------------------------------
// R14(e) — thorns. No dedicated melee/ranged packet field exists yet (see
// the file header, gap 2); this is the documented inference.
// ---------------------------------------------------------------------------

function isLikelyMeleeAttack(packet) {
  return packet.attackRating > 0 && (packet.physMin > 0 || packet.physMax > 0);
}

// ---------------------------------------------------------------------------
// resolveDamage — the R1-R14 orchestrator
// ---------------------------------------------------------------------------

/**
 * `env` — every field below is built ONCE by `CombatSystem` (see
 * `packet.js`'s wiring) and mutated in place before each call; nothing here
 * is ever constructed by `resolveDamage` itself.
 *
 *   source:        resolved attacker Actor, or null if stale/despawned
 *   rng:           combat's own forked Rng stream
 *   step:          ctx.time.step
 *   actorsSystem:  ctx.get('actors') — for the applyStatus seam (gap 1)
 *   events:        ctx.events
 *   packetPool:    CombatSystem's DamagePacket pool (thorns' counter-packet)
 *   resultPool:    this file's DamageResultPool (thorns' counter-result)
 *   statusSpec:    reusable StatusSpec scratch for applyStatus calls
 *   damagePayload: reusable { target, source, result } scratch for the
 *                  actor:damage emit
 *   thornsEnv:     a second `env`-shaped scratch, for the ONE nested call
 *                  R14(e) may make; never reused for anything else
 *   isThornsCounter: true only on that nested call — hard-stops a second
 *                  bounce regardless of the counter-target's own thorns stat
 *
 * @param {object} packet a DamagePacket
 * @param {object} target an Actor
 * @param {object} env see above
 * @param {object} out a DamageResult to populate in place
 * @returns {object} out
 */
export function resolveDamage(packet, target, env, out) {
  resetResultFields(out);
  out.sourceId = packet.sourceId;
  out.sourceGen = packet.sourceGen;
  out.sourceSkillId = packet.sourceSkillId;
  out.targetId = target ? target.id : 0;
  out.targetGen = target ? target.generation : 0;
  out.pointX = packet.originX; out.pointY = packet.originY; out.pointZ = packet.originZ;

  // R1 -----------------------------------------------------------------
  if (!isValidTarget(packet, target, env.step)) {
    out.outcome = 'invalid';
    return out; // "no event" — R1's own wording.
  }

  const rng = env.rng;
  const stats = target.stats;

  // R2 -----------------------------------------------------------------
  if (packet.attackRating > 0) {
    const cth = chanceToHit(packet.attackRating, stats.defense, packet.attackerLevel, target.level);
    if (draw100(rng) >= cth) {
      out.outcome = 'miss';
      emitDamageEvent(target, env, out);
      return out;
    }
  }

  // R3 -----------------------------------------------------------------
  if (packet.dodgeable) {
    const dodgeChance = clamp(stats.dodgeChance, 0, 50);
    if (draw100(rng) < dodgeChance) {
      out.outcome = 'dodge';
      emitDamageEvent(target, env, out);
      return out;
    }
  }

  // R4 -----------------------------------------------------------------
  const hasShield = !!(target.equipment && target.equipment.offHand);
  let blocked = false;
  if (packet.blockable && hasShield && isFrontalHit(target, packet.originX, packet.originZ)) {
    const blockChance = blockChanceOf(target);
    if (draw100(rng) < blockChance) blocked = true;
  }

  if (blocked) {
    out.outcome = 'block';
    out.blocked = true;
    // total stays 0; R14 still runs for thorns/riders — §5.3.
    applyR14(packet, target, env, out, 0, 0);
    return out;
  }

  // R5 -----------------------------------------------------------------
  let phys = rollUniform(rng, packet.physMin, packet.physMax);
  const rawPhys = phys;

  // R6 -----------------------------------------------------------------
  const crit = rollCrit(rng, packet.critChance);
  out.crit = crit;
  const critFactor = crit ? packet.critMult / 100 : 1;
  phys *= critFactor;

  // R7 -----------------------------------------------------------------
  phys = stepR7a(phys, stats.damageReduceFlat);
  phys = stepR7b(phys, stats.damageReducePercent);
  phys = stepR7c(phys, stats.physicalResist);
  if (phys < 0) phys = 0;

  let anyPositiveNonImmune = rawPhys > 0;

  // R8/R9/R10 — fire, cold, lightning, poison, magic, in that fixed order.
  // `out.fire`/`out.cold`/`out.lightning`/`out.magic` double as scratch for
  // the running per-element value through R11/R12; `poisonWorking` is a
  // local (poison is never summed into `out.poison` at the end — R13/R14b).
  let poisonWorking = 0;

  const fireRaw = rollUniform(rng, packet.fireMin, packet.fireMax) * critFactor;
  out.fire = resolveElementAfterResist(fireRaw, stats.fireResist, packet.fireResistPierce, stats.maxFireResist);
  if (fireRaw > 0 && !isImmuneAtResist(resistAfterPierce(stats.fireResist, packet.fireResistPierce))) anyPositiveNonImmune = true;

  const coldRaw = rollUniform(rng, packet.coldMin, packet.coldMax) * critFactor;
  out.cold = resolveElementAfterResist(coldRaw, stats.coldResist, packet.coldResistPierce, stats.maxColdResist);
  if (coldRaw > 0 && !isImmuneAtResist(resistAfterPierce(stats.coldResist, packet.coldResistPierce))) anyPositiveNonImmune = true;

  const lightRaw = rollUniform(rng, packet.lightMin, packet.lightMax) * critFactor;
  out.lightning = resolveElementAfterResist(lightRaw, stats.lightResist, packet.lightResistPierce, stats.maxLightResist);
  if (lightRaw > 0 && !isImmuneAtResist(resistAfterPierce(stats.lightResist, packet.lightResistPierce))) anyPositiveNonImmune = true;

  const poisonRaw = rollUniform(rng, packet.poisonMin, packet.poisonMax) * critFactor;
  poisonWorking = resolveElementAfterResist(poisonRaw, stats.poisonResist, packet.poisonResistPierce, stats.maxPoisonResist);
  if (poisonRaw > 0 && !isImmuneAtResist(resistAfterPierce(stats.poisonResist, packet.poisonResistPierce))) anyPositiveNonImmune = true;

  const magicRaw = rollUniform(rng, packet.magicMin, packet.magicMax) * critFactor;
  out.magic = resolveElementAfterResist(magicRaw, stats.magicResist, 0, stats.maxMagicResist);
  if (magicRaw > 0 && !isImmuneAtResist(stats.magicResist)) anyPositiveNonImmune = true;

  // Track whether ANY raw component was positive but fully immuned — the
  // single-component "outcome = 'immune'" case (R9's own note).
  const anyImmunedPositive =
    (rawPhys === 0) && !anyPositiveNonImmune && (fireRaw > 0 || coldRaw > 0 || lightRaw > 0 || poisonRaw > 0 || magicRaw > 0);

  // R11 — magicDamageReduceFlat, proportional across fire/cold/lightning/
  // poison/magic, clamped at 0. --------------------------------------
  const magicDamageReduceFlat = stats.magicDamageReduceFlat;
  if (magicDamageReduceFlat > 0) {
    const nonPhysicalSum = out.fire + out.cold + out.lightning + poisonWorking + out.magic;
    if (nonPhysicalSum > 0) {
      const reduced = nonPhysicalSum - magicDamageReduceFlat;
      const factor = reduced > 0 ? reduced / nonPhysicalSum : 0;
      out.fire *= factor; out.cold *= factor; out.lightning *= factor; poisonWorking *= factor; out.magic *= factor;
    }
  }

  // R12 — shocked amplification, every component, phys included. -------
  const shockedFactor = 1 + (SHOCKED_PERCENT_PER_STACK / 100) * shockedStacksOf(target);
  if (shockedFactor !== 1) {
    phys *= shockedFactor;
    out.fire *= shockedFactor; out.cold *= shockedFactor; out.lightning *= shockedFactor;
    poisonWorking *= shockedFactor; out.magic *= shockedFactor;
  }

  // R13 — sum, conditional floor, floor(). -------------------------------
  let total = phys + out.fire + out.cold + out.lightning + out.magic;
  total = applyTotalFloor(total, anyPositiveNonImmune);
  total = Math.floor(total);

  out.physical = phys;
  out.total = total;
  out.outcome = total === 0 && anyImmunedPositive ? 'immune' : 'hit';

  // SKIL-10/O-90 — R13's absorb hook, strictly before R14(a)'s `life -=
  // total`. See this file's header addendum and `consumeAbsorbPools`'s own
  // doc comment above.
  out.total = consumeAbsorbPools(target, out.total, env.step);

  applyR14(packet, target, env, out, phys, poisonWorking);
  return out;
}

/** R9+R10 for one element, given its raw rolled damage. */
function resolveElementAfterResist(rawDmg, targetResist, pierce, maxResistForElement) {
  const r = resistAfterPierce(targetResist, pierce);
  if (isImmuneAtResist(r)) return 0;
  const effective = cappedEffectiveResist(r, maxResistForElement);
  return applyResistFactor(rawDmg, effective);
}

/** R14(a)-(k), minus the seams (f)(g)(h)(i)(j), which are documented no-ops. */
function applyR14(packet, target, env, out, phys, poisonAppliedTotal) {
  // (a) life -= total
  const lifeBefore = target.life;
  target.life -= out.total;
  if (target.life < 0) target.life = 0;
  out.overkill = out.total > lifeBefore ? out.total - lifeBefore : 0;
  out.killed = target.life <= 0; // (i)'s own death-check/actor:death is CMBT-6's — this flag is a plain byproduct of (a), nothing more.

  // (b) seed the poison DoT if poison survived
  if (poisonAppliedTotal > 0 && packet.poisonDuration > 0) {
    const spec = env.statusSpec;
    spec.status = 'poisoned';
    spec.step = env.step;
    spec.sourceId = packet.sourceId;
    spec.sourceGen = packet.sourceGen;
    spec.sourceSkill = packet.sourceSkillId;
    spec.element = 'poison';
    spec.magnitude = poisonAppliedTotal / packet.poisonDuration;
    spec.duration = packet.poisonDuration;
    spec.stacks = 1;
    if (env.actorsSystem && typeof env.actorsSystem.applyStatus === 'function') {
      const inst = env.actorsSystem.applyStatus(target, spec);
      if (inst) out.statusApplied |= STATUS_BIT.poisoned;
    }
  }
  out.poison = 0; // "the instalment applied THIS step (0 for the DoT seed)" — 01 §8.2.

  // (c) onHitStatus[] riders, in array order, each its own U(0,100)<chance
  // draw. `stunned`/`frozen` riders consult the shared diminishing-returns
  // chain (`rollDrChain`, see this file's own header — CMBT-9/D-55, defect
  // B: this loop used to apply `rider.magnitude`/`rider.duration` verbatim,
  // which let a status applied through THIS default path skip the CC lock
  // `05 §12.7` relies on entirely). Every non-DR-chain, non-exempt rider
  // still gets `03 §7`'s preamble ccReduction adjustment, which this loop
  // never applied at all before this fix either.
  for (let i = 0; i < packet.onHitCount; i++) {
    const rider = packet.onHitStatus[i];
    if (draw100(env.rng) >= rider.chance) continue;

    let duration = rider.duration;
    if (DR_CHAIN_STATUSES.has(rider.status)) {
      const dr = rollDrChain(target, env.step);
      if (!dr.allowed) continue; // refused outright — no spec built, no applyStatus call
      const bossMult = rider.status === 'stunned' && target.rank === 'boss' ? STUNNED_BOSS_DURATION_MULT : 1;
      duration = rider.duration * bossMult * dr.multiplier * ccMultiplierOf(target);
    } else if (!CC_REDUCTION_EXEMPT_STATUSES.has(rider.status)) {
      duration = rider.duration * ccMultiplierOf(target);
    }

    const spec = env.statusSpec;
    spec.status = rider.status;
    spec.step = env.step;
    spec.sourceId = packet.sourceId;
    spec.sourceGen = packet.sourceGen;
    spec.sourceSkill = packet.sourceSkillId;
    spec.element = null;
    spec.magnitude = rider.magnitude;
    spec.duration = duration;
    spec.stacks = rider.stacks || 1;
    if (env.actorsSystem && typeof env.actorsSystem.applyStatus === 'function') {
      const inst = env.actorsSystem.applyStatus(target, spec);
      if (inst) out.statusApplied |= STATUS_BIT[rider.status] || 0;
    }
  }

  // (d) life steal / mana steal (post-mitigation physical), lifeOnHit,
  // manaOnHit. manaReturnPercent -> manaReturned is CMBT-7's rage/resonance
  // economy seam (see the file header) — left at 0, not computed.
  const lifeStolen = Math.floor(phys * packet.lifeSteal / 100);
  const manaStolen = Math.floor(phys * packet.manaSteal / 100);
  out.lifeStolen = lifeStolen;
  out.manaStolen = manaStolen;
  const source = env.source;
  if (source && !source.dead) {
    const lifeGain = lifeStolen + packet.lifeOnHit;
    if (lifeGain > 0) {
      const maxLife = source.stats ? source.stats.maxLife : Infinity;
      let life = source.life + lifeGain;
      if (life > maxLife) life = maxLife;
      source.life = life;
    }
    const manaGain = manaStolen + packet.manaOnHit;
    if (manaGain > 0) {
      const maxMana = source.stats ? source.stats.maxMana : Infinity;
      let mana = source.mana + manaGain;
      if (mana > maxMana) mana = maxMana;
      source.mana = mana;
    }
  }
  // out.manaReturned stays 0 — seam, see above.

  // (e) thorns — a separate attackRating=0 packet, which never recurses.
  if (!env.isThornsCounter) {
    const thornsAmount = target.stats ? target.stats.thorns : 0;
    if (thornsAmount > 0 && source && !source.dead && isLikelyMeleeAttack(packet) && env.packetPool && env.resultPool) {
      const thornsPacket = env.packetPool.acquire();
      if (thornsPacket) {
        thornsPacket.sourceId = target.id;
        thornsPacket.sourceGen = target.generation;
        thornsPacket.sourceSkillId = 'thorns';
        thornsPacket.team = target.team;
        thornsPacket.physMin = thornsAmount;
        thornsPacket.physMax = thornsAmount;
        thornsPacket.attackerLevel = target.level;
        thornsPacket.attackRating = 0; // always hits — 03 §5.1
        thornsPacket.blockable = false;
        thornsPacket.dodgeable = false;
        thornsPacket.critChance = 0;
        thornsPacket.critMult = 100;

        const thornsResult = env.resultPool.acquire();
        if (thornsResult) {
          const thornsEnv = env.thornsEnv;
          thornsEnv.source = target;
          thornsEnv.rng = env.rng;
          thornsEnv.step = env.step;
          thornsEnv.actorsSystem = env.actorsSystem;
          thornsEnv.events = env.events;
          thornsEnv.packetPool = env.packetPool;
          thornsEnv.resultPool = env.resultPool;
          thornsEnv.statusSpec = env.statusSpec;
          thornsEnv.damagePayload = env.damagePayload;
          thornsEnv.isThornsCounter = true;

          resolveDamage(thornsPacket, source, thornsEnv, thornsResult);
          out.thornsDealt = thornsResult.total;
          env.resultPool.release(thornsResult);
        }
        env.packetPool.release(thornsPacket);
      }
    }
  }

  // (f) rage gain — CMBT-7's seam, no-op.
  // (g) hit recovery — CMBT-5's seam, no-op.
  // (h) knockback — CMBT-5's seam, no-op.
  // (i) death check / actor:death — CMBT-6's seam, no-op (see out.killed above).
  // (j) XP award — CMBT-6's seam, no-op.

  // (k) emit actor:damage
  emitDamageEvent(target, env, out);
}

function emitDamageEvent(target, env, out) {
  if (!env.events || typeof env.events.emit !== 'function') return;
  const payload = env.damagePayload;
  payload.target = target;
  payload.source = env.source || null;
  payload.result = out;
  env.events.emit('actor:damage', payload);
}

// ---------------------------------------------------------------------------
// applyDirect — mitigation-free scripted damage (02-api-contracts.md §8)
// ---------------------------------------------------------------------------

/** `applyDirect(target, amount, element, sourceId, skillId) => DamageResult`
 * — no to-hit, no resistance, no crit, no riders: straight life subtraction
 * for one element. Still emits `actor:damage` (the event table does not
 * distinguish `resolve()`/`applyDirect()` as different emitters).
 * @param {object} target
 * @param {number} amount
 * @param {string} element one of physical/fire/cold/lightning/poison/magic
 * @param {number} sourceId
 * @param {string} skillId
 * @param {object} env same shape `resolveDamage` takes; `env.source` should
 *   already be resolved from `sourceId` by the caller (`CombatSystem`).
 * @param {object} out a DamageResult to populate in place
 * @returns {object} out
 */
export function applyDirectDamage(target, amount, element, sourceId, skillId, env, out) {
  resetResultFields(out);
  out.sourceId = sourceId;
  out.sourceSkillId = skillId || 'environment';
  out.targetId = target ? target.id : 0;
  out.targetGen = target ? target.generation : 0;

  if (!target || target.dead) {
    out.outcome = 'invalid';
    return out;
  }

  const resultKey = element === 'physical' ? 'physical' : element;
  const lifeBefore = target.life;
  target.life -= amount;
  if (target.life < 0) target.life = 0;

  out[resultKey] = amount;
  out.total = amount;
  out.outcome = 'hit';
  out.overkill = amount > lifeBefore ? amount - lifeBefore : 0;
  out.killed = target.life <= 0;

  emitDamageEvent(target, env, out);
  return out;
}

// ---------------------------------------------------------------------------
// heal — 03-combat-math.md §6.4 / 02-api-contracts.md §8
// ---------------------------------------------------------------------------

/** `heal(target, amount) => number` — `applied = clamp(amount, 0, maxLife -
 * life)`; returns the actual amount applied. Never heals a dead actor. This
 * is the same primitive `src/actors/vessels.js#addLife` implements for
 * `actors`' own accessor row — duplicated here (not imported, per
 * `ARCHITECTURE.md` rule 2) because `heal` is `combat`'s own documented
 * method, not `actors`'.
 * @param {object} target
 * @param {number} amount
 * @returns {number}
 */
export function healTarget(target, amount) {
  if (!target || target.dead) return 0;
  const maxLife = target.stats ? target.stats.maxLife : target.life;
  const applied = clamp(amount, 0, maxLife - target.life);
  target.life += applied;
  return applied;
}
