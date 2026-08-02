// src/skills/impl/rune_strike.js
//
// SKIL-4 — `rune_strike`: a landed melee hit, NOT a projectile (D-43,
// settled: `05-skills.md:1942-1946` gives it `type: 'attack'`, `target:
// 'actor'`, "weapon range"; `05-skills.md:979` — "`rune_strike` carries no
// extra charge — it is a landed melee hit like any other"). Wired into the
// same `combat.buildAttackPacket` path `impl/cleaving_strike.js` (SKIL-3)
// established for a melee skill — that file is this ticket's own read-first
// precedent, and its wind-up/active/recovery decomposition
// (`computeActionPhases`/`WINDUP_FRAC`/`ACTIVE_FRAC`/`INSTANT_TURN_RATE`) is
// reused directly below rather than re-derived: `03-combat-math.md` §4.5's
// `windupFrac`/`activeFrac` defaults (0.40/0.15 for ATTACKS) are the same
// for every weapon attack, `rune_strike` included — no per-skill override
// exists for either fraction (only a MONSTER archetype's `windupFrac` is
// ever overridden, per that section's own prose), so there is nothing
// `rune_strike`-specific to add on top of `cleaving_strike`'s own
// implementation of that split.
//
// `src/skills/index.js` owns wiring this module onto the `skills`
// subsystem's dispatch table (plus the `cast()` forwarding of `targetId` and
// the generic `target: 'actor'` no-target refusal `canCast()`'s own doc
// comment already assigns to `cast()` — see that file's own header for why);
// this file owns `rune_strike`'s own mechanics only.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// (`tools/check-imports.mjs` sweeps `src/skills/` with `checkGlobals:
// true`). No `Math.random()` — nothing here draws randomness (R5/R6/R8 are
// `combat.resolve()`'s).
//
// ---------------------------------------------------------------------------
// The one thing genuinely `rune_strike`'s own: the doubled mana return
// ---------------------------------------------------------------------------
// `03-combat-math.md:223`: "Base `manaReturnPercent` for the Runeblade class
// is 8. `rune_strike` doubles it for its own hit." `src/combat/onhit.js`'s
// own header is explicit that this is NOT combat's job: "`rune_strike`
// doubling `manaReturnPercent` for its own hit... [is a] skill-level
// modifier... layered on TOP of the base formula this file implements;
// neither is applied here." So this file is the ONLY place that can apply
// it — by mutating `packet.manaReturnPercent` (a `03 §6.1` B8 rider,
// `01-data-model.md` §8.1's own packet field) AFTER `combat.buildAttackPacket`
// returns it and BEFORE the packet is handed to `combat:hit-request`, the
// exact same "read the built packet, layer a skill-specific rider on top"
// technique `src/skills/projectile.js`'s own `alwaysHits` override uses for
// `ember_bolt`. The multiplier itself is DATA (`src/skills/data/skills.js`
// `rune_strike.extra.manaReturnMultiplier = 2`, SKIL-1, accepted), read at
// CAST time and carried in this file's own per-actor pending scratch so
// `onHitframe` never has to re-reach for `def` (rule 6: the number lives in
// data, not as a literal `2` here).
//
// Resonance and rage are NOT this file's to award — `05` D-05-2: "`rune_strike`
// carries only the class-base +1 Resonance of any landed melee hit and no
// more", and CMBT-8/D-51 already credits exactly that (plus the attacker's
// per-ACTION rage) from `combat`'s own `R14(f)` the moment the emitted
// `combat:hit-request` resolves. This file never calls `addResonance`/
// `addRage`/any award primitive — the same discipline SKIL-3's own report
// states it had to REMOVE a duplicate award to reach.
//
// ---------------------------------------------------------------------------
// E13 (`03-combat-math.md` §12) and this file — read before assuming a real
// cast reproduces it
// ---------------------------------------------------------------------------
// E13's own printed steps have NO `B2` "skill coefficient" multiply at all
// (`B1 weapon average 12.5000` is followed directly by `B3 x 1.35`, never a
// `x 1.15`/`x 1.43`-shaped step for `rune_strike`'s own `weaponDamage: {base:
// 115, perLevel: 7}`), and its own `manaReturned = 21.4438 x 0.08` uses the
// Runeblade class BASE rate, not the doubled one this file applies. Both
// facts together mean E13 is not, read literally, a worked `rune_strike`
// cast — it is `03`'s own generic "a level-10 Runeblade lands a weapon hit
// while imbued" validation of the shared pipeline (`combat.buildAttackPacket`
// + `resolve()` + the `manaReturnPercent`/Resonance seams), independent of
// which skill (or a bare basic attack) produced the swing — matching
// `combat.buildAttackPacket`'s own documented gap 1 (`packet.js`'s header:
// `BASIC_ATTACK_WEAPON_DAMAGE = 100` unconditionally, regardless of the
// `skillId` argument passed in — no skill's `weaponDamage%` is applied by
// `combat` yet, for ANY skill, `cleaving_strike` included). `tests/combat/
// resolve.test.js`'s own already-accepted E13 fixture confirms this reading
// directly (it supplies `manaReturnPercent: 8` on the stats layer by hand and
// calls `buildAttackPacket(source, 'blade_seal', 5)` — a skillId whose own
// 143 %-shaped coefficient, had `combat` applied one, would ALSO have broken
// the match).
//
// This file therefore implements `rune_strike` FAITHFULLY per `05`'s own
// binding skill table (the doubled mana return, applied here) rather than
// bending it to match E13's undoubled arithmetic — per this ticket's own
// D-16 precedent ("if a number does not reconcile, say which one and stop;
// do not adjust an expected value or widen a tolerance"). A REAL cast of
// this skill will not reproduce E13's exact 1.7155 (it will return roughly
// double that, off the post-mitigation physical of whatever `combat`'s own
// still-gap-1-limited `buildAttackPacket` actually computes) — reported
// plainly in this ticket's own report, not silently reconciled here.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline — identical shape to `impl/cleaving_strike.js`
// ---------------------------------------------------------------------------
// Per-actor pending-cast scratch is `poolIndex`-indexed, fixed-capacity,
// grown (never shrunk) on demand — no `Map`. `hitRequestPayload` is one
// reused object, mutated and emitted synchronously, never stashed past its
// own dispatch.

import { computeActionPhases, INSTANT_TURN_RATE } from './cleaving_strike.js';
import { cooldownOf, startCooldown } from '../cost.js';

const SKILL_ID = 'rune_strike';

/**
 * Builds one `rune_strike` cast handler. See the file header for the full
 * reasoning.
 * @returns {{skillId:string, cast:Function, onHitframe:Function}}
 */
export function createRuneStrikeSkill() {
  const phasesScratch = { windup: 0, active: 0, recover: 0, baseInterval: 0 };
  const hitRequestPayload = { source: null, target: null, packet: null };

  // --- per-actor pending-cast scratch, poolIndex-indexed (no Map) ---------
  let capacity = 64;
  let pendingActionSeq = new Int32Array(capacity).fill(-1);
  let pendingLevel = new Int32Array(capacity);
  let pendingTargetId = new Int32Array(capacity);
  let pendingManaMult = new Float64Array(capacity);

  function ensureCapacity(poolIndex) {
    if (poolIndex < capacity) return;
    const grown = Math.max(poolIndex + 1, capacity * 2);
    const nextSeq = new Int32Array(grown).fill(-1);
    const nextLevel = new Int32Array(grown);
    const nextTargetId = new Int32Array(grown);
    const nextManaMult = new Float64Array(grown);
    nextSeq.set(pendingActionSeq);
    nextLevel.set(pendingLevel);
    nextTargetId.set(pendingTargetId);
    nextManaMult.set(pendingManaMult);
    capacity = grown;
    pendingActionSeq = nextSeq;
    pendingLevel = nextLevel;
    pendingTargetId = nextTargetId;
    pendingManaMult = nextManaMult;
  }

  /**
   * Resolves the swing at the tick the action enters `active` — a single
   * `combat:hit-request`, doubled `manaReturnPercent`, and nothing else.
   * Combat's own `R14(f)` (CMBT-8/D-51) credits Resonance and per-action
   * rage the moment this resolves; this function never touches either.
   * @param {object} actor
   * @param {{actors:object, combat:object, events:object}} deps
   */
  function resolveHit(actor, deps) {
    const { actors, combat, events } = deps;
    const idx = actor.poolIndex;
    const level = pendingLevel[idx];
    const targetId = pendingTargetId[idx];
    const manaMult = pendingManaMult[idx];
    pendingActionSeq[idx] = -1; // consumed — defensive against a duplicate hitframe for this seq

    const target = actors.byId(targetId);
    if (!target || target.dead) return; // target died/despawned between cast and hitframe

    const packet = combat.buildAttackPacket(actor, SKILL_ID, level);
    if (!packet) return; // DamagePacket pool exhausted (combat's own warn already fired)

    packet.manaReturnPercent *= manaMult; // 03 §2.4 / 05 §8.5: doubled for this hit — see file header

    hitRequestPayload.source = actor;
    hitRequestPayload.target = target;
    hitRequestPayload.packet = packet;
    events.emit('combat:hit-request', hitRequestPayload);

    combat.releasePacket(packet);
  }

  /** Permanent listener (registered once by `index.js`) for
   * `ARCHITECTURE.md`'s `anim:hitframe` `{actor, actionId, actionSeq}`. */
  function onHitframe(payload, deps) {
    const actor = payload.actor;
    if (payload.actionId !== SKILL_ID) return;
    const idx = actor.poolIndex;
    if (idx >= capacity || pendingActionSeq[idx] !== payload.actionSeq) return; // stale or foreign
    resolveHit(actor, deps);
  }

  /**
   * `SkillsSystem.cast()`'s per-skill handler. The caller (`index.js`) has
   * already run `canCast()`, resolved `level`/`def`, and — for a `target:
   * 'actor'` skill — checked that `targetId` resolves to a live target
   * (see that file's own header for why that check lives there, generic
   * across every `target: 'actor'` skill, rather than duplicated per skill).
   * @param {object} actor
   * @param {object} def `SkillDefinition` for `rune_strike`
   * @param {number} level effective level
   * @param {number} targetX
   * @param {number} targetZ
   * @param {{actors:object, combat:object, physics:object, events:object, time:object, skills:object}} deps
   * @param {number} targetId
   * @returns {boolean}
   */
  function cast(actor, def, level, targetX, targetZ, deps, targetId) {
    const { actors, combat, skills, time } = deps;

    const target = actors.byId(targetId);
    if (!target || target.dead) return false; // defensive; index.js already checked this

    const cost = skills.costOf(actor, def.id); // shared scratch — read now
    const resource = cost.resource;
    const amount = cost.amount;
    if (resource && !actors.spend(actor, resource, amount)) return false; // defensive; canCast already checked affordability

    // 05 §6.1: "Needs a hostile actor under the cursor" — face the actual
    // target, not the raw cursor coordinates (which `cleaving_strike`'s own
    // `point`-mode cast uses instead).
    actors.face(actor, target.x, target.z, INSTANT_TURN_RATE);

    const attackIntervalNow = combat.attackInterval(actor, def.id);
    const ias = actors.stats(actor).increasedAttackSpeed || 0;
    computeActionPhases(attackIntervalNow, ias, def.attackScale, phasesScratch);

    const actionSeq = actors.beginAction(actor, def.id, phasesScratch.windup, phasesScratch.active, phasesScratch.recover);

    const cooldownSeconds = cooldownOf(def, level); // 0 for rune_strike — kept for correctness if that ever changes
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    ensureCapacity(actor.poolIndex);
    const idx = actor.poolIndex;
    pendingActionSeq[idx] = actionSeq;
    pendingLevel[idx] = level;
    pendingTargetId[idx] = targetId;
    pendingManaMult[idx] = (def.extra && def.extra.manaReturnMultiplier) || 1;

    return true;
  }

  return {
    skillId: SKILL_ID,
    cast,
    onHitframe,
  };
}
