// src/skills/impl/cleaving_strike.js
//
// SKIL-3 — `cleaving_strike`: cone, multi-target. `05-skills.md` §14 row 3:
// "Cone targeting, buildAttackPacket, multi-target resolve in actor.id
// order, attackScale, the wind-up/active/recovery decomposition" — S5, S6;
// a 4-body cone produces exactly 4 `combat:hit-request` events, and the
// attacker's rage goes up by exactly ONE award (R1, `05` §1.6, `03`
// §2.4/§12.1) — credited by `combat` itself since CMBT-8/D-51, not by this
// file (see the R1 section below). `src/skills/index.js` owns wiring this
// module onto the `skills` subsystem (dispatch table + the permanent
// `anim:hitframe` listener below); this file owns the skill's own
// mechanics only.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// (`tools/check-imports.mjs` sweeps `src/skills/` with `checkGlobals:
// true`). No `Math.random()` — nothing here draws randomness (R5/R6/R8 are
// `combat.resolve()`'s, not this file's).
//
// ---------------------------------------------------------------------------
// R1 — one rage award per ACTION, never per target — now `combat`'s own job
// (CMBT-8/D-51), not this file's
// ---------------------------------------------------------------------------
// Earlier revisions of this file called `cost.js#rageForLandedAction`
// itself, once per action, gated on the first `actor:damage` this action's
// own hit-requests produced. Reported against this ticket's own findings
// (see below) and fixed under **CMBT-8/D-51**: `src/combat/onhit.js`'s
// `applyOnHitEconomy` (R14(f)) now credits the attacker's rage AT MOST ONCE
// per `(source.generation, source.actionSeq)` pair, itself — the same
// generation-stamping precedent `src/skills/cost.js#encodeCooldownStamp`
// already established for cooldowns, reused there for
// `encodeActionRageStamp`/`hasActionAlreadyCreditedRage`. `combat` now owns
// R14(f) in full: this file emits `combat:hit-request` once per body in the
// cone (a REQUEST count, never an award count — a 4-body cone is still 4
// events) and does NOT call any rage-award primitive at all. Verified
// end-to-end at 1/4/8 bodies through a real `boot()` in
// `tests/skills/cleaving_strike.test.js`: the ACTOR'S OWN `rage` delta —
// not a skill-layer call counter — is identical across all three body
// counts.
//
// Resonance stays PER LANDED HIT (unchanged by CMBT-8, by design — `05`
// D-05-2: an imbue charge is consumed by a landed hit, and a landed hit is
// what grants one, the identity §12.5's 16.1 % overflow figure depends on).
// `cleaving_strike` is a Ravager (rage-only) skill and never touches
// Resonance either way.
//
// ---------------------------------------------------------------------------
// A second `combat` defect this ticket's own perf probe found at volume,
// also fixed under CMBT-8/D-51
// ---------------------------------------------------------------------------
// `CombatSystem`'s `_onHitRequest` listener used to discard `resolve()`'s
// return value, leaking the acquired `DamageResult` (`RESULT_POOL_CAPACITY
// = 256`) on every hit resolved via the event path — 256 total hits over a
// process's life, then every further hit-request silently dropped. CMBT-8
// made the listener the sole owner of the `DamageResult` it acquires and
// releases it after dispatch (see `packet.js`'s own "pooled-object
// ownership rule" comment); packets remain the REQUESTER's own
// responsibility (`resolveHit` below still calls `combat.releasePacket()`
// itself — unchanged, and correct: a cone's one packet is legitimately
// reused across all of its targets' hit-requests). Verified: 1000
// hit-requests through the event path now resolve 1000 `actor:damage`
// events, not 256.
//
// ---------------------------------------------------------------------------
// Why resolution happens on `anim:hitframe`, not synchronously inside `cast()`
// ---------------------------------------------------------------------------
// `08-characters-visual.md` §6.1: "`combat:hit-request` is emitted by
// `ai`/`skills` on `hitTick`, in `fixedUpdate`" — the tick the action's
// FSM crosses from `windup` into `active`, not the tick the button was
// pressed. `src/actors/timing.js#advanceAndEmitHitframe` (ACTR-21, already
// wired into `ActorsSystem.fixedUpdate`) emits `ARCHITECTURE.md`'s
// `anim:hitframe` `{ actor, actionId, actionSeq }` exactly on that edge, so
// this file listens for it rather than re-deriving the same tick math a
// second time. `cast()` only STARTS the action (`actors.beginAction`) and
// records what to resolve once the hitframe for THIS `actionSeq` arrives —
// the `actionSeq` match is the staleness guard `beginAction`'s own header
// documents (a cancelled/replaced action's stale hitframe, if one could
// ever arrive, is silently dropped).
//
// ---------------------------------------------------------------------------
// The wind-up/active/recovery decomposition, and how S6 is guaranteed
// ---------------------------------------------------------------------------
// `actors.beginAction(actor, actionId, windup, active, recover)` takes RAW
// BASE seconds (pre-IAS) and applies `mult = 1/(1+ias/100)` to `windup`/
// `recover` ONLY, never to `active` (`src/actors/action.js`, ACTR-9,
// verbatim: "activeTicks is never touched by mult... enforced structurally
// here"). So THIS file's only job for S6 is to hand `beginAction` an
// `active` seconds value that does not itself depend on the actor's
// current `increasedAttackSpeed` — `computeActionPhases` below does that by
// deriving the actor's un-scaled `weapon.attackTime x class.attackScale`
// from `combat.attackInterval()`'s own (already IAS-divided) return value,
// multiplying back by `(1 + ias/100)` to undo the division, then applying
// `skill.attackScale` and the `WINDUP_FRAC`/`ACTIVE_FRAC`/`RECOVER_FRAC`
// split from `03-combat-math.md` §4.5. `baseInterval` is then explicitly
// re-clamped to `[0.25, 3.0]` (`03` §4.3's own bound) before the split, so
// S5 ("stays inside the clamp") holds STRUCTURALLY, not just empirically —
// see the quantified analysis below for the one place this can still read
// a slightly wrong (but always in-bounds) number.
//
// **The `attackScale` approximation, quantified (asked for by name, on the
// record):** `combat.attackInterval()` hard-codes `skillScale = 1.0` (that
// file's own documented gap 1 — it has no per-skill table to read a real
// scale from), so it cannot itself compute
// `clamp(weapon.attackTime x class.attackScale x skill.attackScale /
// (1+ias/100), 0.25, 3.0)` — `03` §4.3's literal formula. This file instead
// undoes `combat`'s division to recover `weapon.attackTime x
// class.attackScale` and applies `skillAttackScale` afterward, then
// re-clamps. The two approaches (scale-then-clamp vs. clamp-then-scale)
// are IDENTICAL whenever `combat.attackInterval()`'s own clamp did not
// engage — pure multiplication commutes with an unclamped division — and
// diverge only in the narrow IAS band where it did.
//
// Worked numerically for `cleaving_strike`'s own reference build (`05`
// §2.1: Battle Axe `attackTime 0.75`, Ravager `class.attackScale 0.90` —
// `weaponClassBase = 0.675`, `skillAttackScale = 1.05`):
//   - `combat.attackInterval()`'s own floor (0.25 s) engages once
//     `0.675 / (1+ias/100) < 0.25`, i.e. `ias > 170`.
//   - The textbook (scale-inside-the-division) formula does not floor until
//     `0.70875 / (1+ias/100) < 0.25`, i.e. `ias > 183.5`.
//   - For `170 < ias <= 300` (the legal cap), this file reports
//     `0.25 x 1.05 = 0.2625 s`; the textbook value ranges from `0.2625 s`
//     (continuous at `ias=170`) down to `0.25 s` at `ias=183.5` and stays at
//     `0.25 s` beyond that. The worst-case divergence is therefore
//     `0.25 x (skillAttackScale - 1) = 0.0125 s` (~5 % of the floor),
//     reached once `ias >= 183.5` — never larger, and never enough to push
//     the reported value outside `[0.25, 3.0]` (the explicit re-clamp
//     guarantees that on its own). At the ceiling side this reference
//     weapon never approaches `3.0 s` at all (its slowest legal value,
//     `ias=-75`, is `2.835 s`), so no ceiling-side divergence exists for
//     THIS build; a slower weapon/class combination whose unscaled interval
//     already sits near the `3.0 s` ceiling at `ias=-75` could see a
//     larger, symmetric divergence there, bounded the same way
//     (`3.0 x (skillAttackScale - 1) = 0.15 s` in the absolute worst case).
//   - **Conclusion: S5 does NOT break anywhere in −75..300 for this
//     reference build** — every reported value stays inside `[0.25, 3.0]`
//     — but the VALUE is measurably (up to 5 % of the floor) wrong in that
//     narrow high-IAS band, strictly because `combat.attackInterval()` has
//     no way to be told a skill's own scale. Closing that gap for real
//     (giving `combat.attackInterval(actor, skillId)` a way to read
//     `skill.attackScale`) is a `src/combat/` fix, not this file's —
//     flagged as a candidate follow-up ticket, not "papered over": the
//     bound above is exact, not hand-waved.
//
// ---------------------------------------------------------------------------
// Facing — "the cursor supplies the facing only" (05 §2.1), treated as an
// atomic snap
// ---------------------------------------------------------------------------
// `08-characters-visual.md` §6.5's turn-rate table allows the actor to turn
// during the FIRST 40 % of wind-up (540 deg/s) and locks it for the rest.
// Animating a genuine multi-tick turn needs a `fixedUpdate` presence this
// ticket's file list does not grant a natural home for (neither
// `src/actors/` nor a new `skills.fixedUpdate` polling loop is in scope for
// one cone melee skill). This file instead calls `actors.face()` ONCE, at
// cast time, with `INSTANT_TURN_RATE` — large enough that a single call
// completes any turn within one fixed step — and never calls `face()`
// again for the rest of the action. Facing lock therefore holds trivially:
// nothing in this file (or triggered by it) changes `actor.facing` again
// until the action completes. Flagged as an interpretation, not a literal
// reading of the 540 deg/s table, in this ticket's report.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline on the cast/resolve path
// ---------------------------------------------------------------------------
// Every per-action scratch below is a fixed-capacity, `poolIndex`-indexed
// parallel array (never a `Map`), matching `src/actors/action.js`'s own
// documented technique for exactly this shape of problem (see that file's
// header, "Per-actor schedule scratch"). `_coneOut` is preallocated once
// and reused for every cone query, per `overlapCone`'s own `out:int[]`
// contract (`src/physics/cast.js`'s D7). `_hitRequestPayload` is a single
// reused `{source,target,packet}` object mutated between each of the loop's
// sequential, SYNCHRONOUS emits — safe because `EventBus.emit` dispatches
// synchronously and nothing downstream is documented (or observed in this
// codebase) to hold a `combat:hit-request` payload past its own dispatch,
// the same "never stash it" discipline `physics.Hit`/`MoveResult` already
// established. `computeActionPhases` takes an optional `out` object for the
// same reason `cost.js#computeCost` does.

// `rageForLandedAction` is deliberately NOT imported here — R1's rage
// award is combat's own job now (CMBT-8/D-51, see the file header). The
// helper itself stays in `cost.js`, untouched, for SKIL-7's channel R2
// cadence (earns at `attackInterval`, not per tick — genuinely not
// combat's to schedule).
import { levelValue, cooldownOf, startCooldown } from '../cost.js';

/** `05-skills.md` §2.1 / `03-combat-math.md` §4.5 (attacks): row 1 default
 * phase split. `RECOVER_FRAC` is the documented remainder, never a fourth
 * stored constant. */
export const WINDUP_FRAC = 0.40;
export const ACTIVE_FRAC = 0.15;
export const RECOVER_FRAC = 1 - WINDUP_FRAC - ACTIVE_FRAC; // 0.45

/** 120 deg cone: `03-combat-math.md:684` ("120° cone, radius 3.2 m") and
 * `05-skills.md:243` ("Radius / shape | 3.2 m, 120° arc centred on
 * `facing`"). `overlapCone`'s own `halfAngle` parameter is HALF of the full
 * arc (`02-api-contracts.md` §4), hence `/2` here. `ARCHITECTURE.md` rule 9
 * ("gameplay numbers live in data, not in code") is not fully honoured by
 * this constant — `01-data-model.md` §6.1's `SkillDefinition` has no arc
 * field at all, a gap SKIL-1's own report already flagged (`05-skills.md`'s
 * own header, the "Cone/nova ANGLES" paragraph). Recorded again here as an
 * open question against `01-data-model.md`, not re-litigated by adding a
 * field to `data/skills.js` in this ticket (out of file-list scope). */
export const CONE_HALF_ANGLE = (120 * Math.PI / 180) / 2;

/** Preallocated `overlapCone` `out`-array capacity. `05` §1.5's own
 * pack-occupancy reference gives this exact shape 4 bodies; this is
 * generous headroom above that (and above the "8-body" comparison this
 * ticket's own acceptance script runs), the same "comfortably above the
 * documented ceiling" philosophy `src/actors/action.js#scratchCapacity`
 * uses against `q.maxActors`. */
export const MAX_CONE_TARGETS = 24;

/** rad/s. `Math.PI * 60 * 2`: at the fixed step (`1/60` s), a single
 * `actors.face()` call can turn at most `maxTurnRate / 60` radians — this
 * value's `/60` is `2*PI`, i.e. strictly more than the largest possible
 * turn (`PI`, the wrapped-shortest-arc bound), so one call always
 * completes the turn to the cursor in the same step it is issued. See the
 * file header, "Facing — treated as an atomic snap". */
export const INSTANT_TURN_RATE = Math.PI * 60 * 2;

const SKILL_ID = 'cleaving_strike';

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Wind-up/active/recovery decomposition — RAW base seconds, pre-IAS, ready
 * to hand straight to `actors.beginAction()` (see the file header for why
 * `active` never itself depends on `increasedAttackSpeed`, closing S6).
 * @param {number} attackIntervalNow `combat.attackInterval(actor, skillId)`
 *   — already IAS-divided and clamped, missing the skill's own
 *   `attackScale` (combat's own documented gap-1; see header).
 * @param {number} increasedAttackSpeed the actor's raw IAS stat, unclamped.
 * @param {number} skillAttackScale `def.attackScale` (1.05 for
 *   `cleaving_strike`).
 * @param {{windup:number,active:number,recover:number,baseInterval:number}} [out]
 * @returns {{windup:number,active:number,recover:number,baseInterval:number}}
 */
export function computeActionPhases(attackIntervalNow, increasedAttackSpeed, skillAttackScale, out) {
  if (!out) out = { windup: 0, active: 0, recover: 0, baseInterval: 0 };
  const ias = clamp(increasedAttackSpeed || 0, -75, 300);
  // Undo combat.attackInterval()'s own division — exact away from its own
  // [0.25, 3.0] clamp (see file header's quantified S5 analysis).
  const weaponClassBase = attackIntervalNow * (1 + ias / 100);
  // 03 §4.3's own clamp, applied explicitly — this is what makes S5 a
  // structural guarantee rather than an empirical one for every weapon,
  // not just the reference build the header analysis worked through.
  const baseInterval = clamp(weaponClassBase * skillAttackScale, 0.25, 3.0);

  out.windup = WINDUP_FRAC * baseInterval;
  out.active = ACTIVE_FRAC * baseInterval;
  out.recover = RECOVER_FRAC * baseInterval;
  out.baseInterval = baseInterval;
  return out;
}

/**
 * Builds one `cleaving_strike` cast handler — a self-contained closure over
 * this skill's own preallocated scratch (never shared with any other skill,
 * never rebuilt after `SkillsSystem.init()` constructs it once). See the
 * file header for the resolution/allocation discipline.
 * @returns {{skillId:string, cast:Function, onHitframe:Function}}
 */
export function createCleavingStrikeSkill() {
  const coneOut = new Int32Array(MAX_CONE_TARGETS);
  const phasesScratch = { windup: 0, active: 0, recover: 0, baseInterval: 0 };
  const hitRequestPayload = { source: null, target: null, packet: null };

  // --- per-actor pending-cast scratch, poolIndex-indexed (no Map) ---------
  let capacity = 64;
  let pendingActionSeq = new Int32Array(capacity).fill(-1);
  let pendingLevel = new Int32Array(capacity);
  let pendingFacing = new Float64Array(capacity);
  let pendingX = new Float64Array(capacity);
  let pendingZ = new Float64Array(capacity);
  let pendingRadius = new Float64Array(capacity);

  function ensureCapacity(poolIndex) {
    if (poolIndex < capacity) return;
    const grown = Math.max(poolIndex + 1, capacity * 2);
    const nextSeq = new Int32Array(grown).fill(-1);
    const nextLevel = new Int32Array(grown);
    const nextFacing = new Float64Array(grown);
    const nextX = new Float64Array(grown);
    const nextZ = new Float64Array(grown);
    const nextRadius = new Float64Array(grown);
    nextSeq.set(pendingActionSeq);
    nextLevel.set(pendingLevel);
    nextFacing.set(pendingFacing);
    nextX.set(pendingX);
    nextZ.set(pendingZ);
    nextRadius.set(pendingRadius);
    capacity = grown;
    pendingActionSeq = nextSeq;
    pendingLevel = nextLevel;
    pendingFacing = nextFacing;
    pendingX = nextX;
    pendingZ = nextZ;
    pendingRadius = nextRadius;
  }

  /**
   * Resolves the cone at the tick the action enters `active` — the cone
   * query, the multi-target resolve in ascending `actor.id` order, and the
   * `combat:hit-request` events. R1's rage award is `combat`'s own job now
   * (CMBT-8/D-51, see the file header) — this function does not touch
   * rage at all.
   * @param {object} actor
   * @param {{actors:object, combat:object, physics:object, events:object}} deps
   */
  function resolveHit(actor, deps) {
    const { physics, combat, actors, events } = deps;
    const idx = actor.poolIndex;
    const level = pendingLevel[idx];
    const facing = pendingFacing[idx];
    const x = pendingX[idx];
    const z = pendingZ[idx];
    const radius = pendingRadius[idx];
    pendingActionSeq[idx] = -1; // consumed — defensive against a duplicate hitframe for this seq

    // Player -> monsters, monster -> players. `01 §2`: team 0 is the
    // player's own layer, everything else is a monster; `physics.MASK`'s
    // own two "HOSTILE_TO_*" rows are exactly this pairing.
    const mask = actor.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
    const count = physics.overlapCone(x, z, facing, CONE_HALF_ANGLE, radius, mask, coneOut);
    const view = coneOut.subarray(0, count);
    // `05` §14 row 3: "multi-target resolve in actor.id order" — a
    // determinism requirement. TypedArray#sort defaults to numeric
    // ascending and sorts the view in place (no new array).
    view.sort();

    const packet = combat.buildAttackPacket(actor, SKILL_ID, level);
    if (!packet) return; // pool exhausted (O-59) — nothing to resolve

    for (let i = 0; i < view.length; i++) {
      const targetId = view[i];
      if (targetId === actor.id) continue;
      const target = actors.byId(targetId);
      if (!target || target.dead) continue;
      hitRequestPayload.source = actor;
      hitRequestPayload.target = target;
      hitRequestPayload.packet = packet;
      events.emit('combat:hit-request', hitRequestPayload);
    }

    // Rage: combat's own R14(f) (CMBT-8/D-51) credits the attacker at most
    // once per (generation, actionSeq) as each hit-request resolves above —
    // nothing left for this file to do.
    combat.releasePacket(packet);
  }

  /** Permanent listener (registered once by `index.js`) for
   * `ARCHITECTURE.md`'s `anim:hitframe` `{actor, actionId, actionSeq}` —
   * see the file header for why resolution is deferred to this event
   * rather than run synchronously inside `cast()`. */
  function onHitframe(payload, deps) {
    const actor = payload.actor;
    if (payload.actionId !== SKILL_ID) return;
    const idx = actor.poolIndex;
    if (idx >= capacity || pendingActionSeq[idx] !== payload.actionSeq) return; // stale or foreign
    resolveHit(actor, deps);
  }

  /**
   * `SkillsSystem.cast()`'s per-skill handler. The caller (`index.js`) has
   * already run `canCast()` and resolved `level`/`def` — this function only
   * does what is specific to `cleaving_strike`: spend, face, begin the
   * action, and record what to resolve once `anim:hitframe` arrives.
   * @param {object} actor
   * @param {object} def `SkillDefinition` for `cleaving_strike`
   * @param {number} level effective level
   * @param {number} targetX
   * @param {number} targetZ
   * @param {{actors:object, combat:object, physics:object, events:object, time:object, skills:object}} deps
   * @returns {boolean}
   */
  function cast(actor, def, level, targetX, targetZ, deps) {
    const { actors, combat, skills, time } = deps;

    const cost = skills.costOf(actor, def.id); // shared scratch — read now
    const resource = cost.resource;
    const amount = cost.amount;
    if (resource && !actors.spend(actor, resource, amount)) return false; // defensive; canCast already checked affordability

    // "the cursor supplies the facing only... it turns and swings in
    // place" (05 §2.1) — see the file header for why this is one atomic
    // snap rather than an animated multi-tick turn.
    actors.face(actor, targetX, targetZ, INSTANT_TURN_RATE);

    const attackIntervalNow = combat.attackInterval(actor, def.id);
    const ias = actors.stats(actor).increasedAttackSpeed || 0;
    computeActionPhases(attackIntervalNow, ias, def.attackScale, phasesScratch);

    const actionSeq = actors.beginAction(actor, def.id, phasesScratch.windup, phasesScratch.active, phasesScratch.recover);

    const cooldownSeconds = cooldownOf(def, level); // 0 for cleaving_strike — kept for correctness if that ever changes
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    ensureCapacity(actor.poolIndex);
    const idx = actor.poolIndex;
    pendingActionSeq[idx] = actionSeq;
    pendingLevel[idx] = level;
    pendingFacing[idx] = actor.facing;
    pendingX[idx] = actor.x;
    pendingZ[idx] = actor.z;
    pendingRadius[idx] = levelValue(def.radius, level);

    return true;
  }

  return {
    skillId: SKILL_ID,
    cast,
    onHitframe,
  };
}
