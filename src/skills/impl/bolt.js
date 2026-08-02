// src/skills/impl/bolt.js
//
// SKIL-4 — `ember_bolt`: a single fire projectile, `05-skills.md` §4.1
// (L1068-1157). Cast-side timing follows `impl/cleaving_strike.js`'s own
// wind-up/active/recovery precedent, but as a CAST (`03-combat-math.md`
// §4.5's `windupFrac 0.65`/`activeFrac 0.15` for casts, not the 0.40/0.15
// pair attacks use) — matching `05` §4.1's own "The projectile spawns at the
// entry to `active`, i.e. 0.65 of the interval in". The projectile itself
// (flight, the pool, pierce, damage) is `../projectile.js`'s; this file only
// owns the cast -> spawn hand-off.
//
// `src/skills/index.js` owns wiring this module onto the `skills`
// subsystem's dispatch table and the `Projectile` pool it spawns into; this
// file owns `ember_bolt`'s own cast mechanics only.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// (`tools/check-imports.mjs` sweeps `src/skills/` with `checkGlobals:
// true`). No `Math.random()`.
//
// ---------------------------------------------------------------------------
// `combat.castInterval`'s own gap 4, and the same "undo and rescale"
// technique `cleaving_strike.js` already established for `attackInterval`'s
// gap 1
// ---------------------------------------------------------------------------
// `src/combat/packet.js`'s own header, gap 4: `castInterval(actor, skillId)`
// has no per-skill `castTime` table to read from yet, so it ALWAYS computes
// against `DEFAULT_CAST_TIME = 0.60` (a documented placeholder, "chosen to
// match `unarmed`'s attack time as a neutral standby value, nothing more"),
// regardless of which `skillId` is passed — `ember_bolt`'s own real
// `castTime` is `0.55` (`05` §4.1's own table; `data/skills.js`'s record).
// `cleaving_strike.js` hit the exact same shape of gap for `attackInterval`
// (BASIC_SKILL_SCALE fixed at 1.0 instead of the real `skill.attackScale`)
// and fixed it by UNDOING `combat`'s own division/multiplication to recover
// the class/weapon-only term, then re-applying the skill's real number. This
// file does the identical thing for the BASE `castTime` term instead of a
// scale term: `combat.castInterval()` computes `clamp(DEFAULT_CAST_TIME x
// castScale / (1+fcr/100), 0.15, 3.0)`; undoing the division recovers
// `DEFAULT_CAST_TIME x castScale x (1+fcr/100)`'s OWN clamp-affected value,
// and multiplying by `(realCastTime / DEFAULT_CAST_TIME)` substitutes the
// real base in its place before re-clamping. Exact away from
// `castInterval`'s own `[0.15, 3.0]` clamp engaging (identical caveat
// `cleaving_strike.js`'s own header quantifies for its case: the two
// orderings — scale-then-clamp vs. clamp-then-scale — commute exactly off
// the clamp boundary and diverge only inside it, never enough to push the
// result outside the clamp itself, since the explicit re-clamp below
// guarantees that structurally). Flagged in this ticket's report as the
// same class of gap, fixed the same way, for a second field.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline — identical shape to `impl/cleaving_strike.js`/
// `impl/rune_strike.js`
// ---------------------------------------------------------------------------
// Per-actor pending-cast scratch is `poolIndex`-indexed, fixed-capacity,
// grown (never shrunk) on demand — no `Map`. Direction is computed with
// `Math.sqrt(dx*dx+dz*dz)`, never `Math.hypot` (banned in `Alloc: no` code —
// this ticket's own brief measures `Math.hypot` at 5.73 B/call vs. 0.34 for
// the manual form).

import { INSTANT_TURN_RATE } from './cleaving_strike.js';

/** Mirrors `src/combat/packet.js`'s own exported `DEFAULT_CAST_TIME`
 * (0.60 s) — NOT imported (`ARCHITECTURE.md` rule 2: "never import another
 * subsystem's module"; `combat` is a different subsystem from `skills`).
 * Redeclared here, the exact same discipline `src/combat/onhit.js`'s own
 * `ACTION_RAGE_GEN_SCALE` already establishes for the identical situation
 * in the opposite direction (that file needs a `skills/cost.js` constant
 * and redeclares it rather than importing it). If `packet.js`'s own value
 * ever changes, this one has to be updated by hand — the same tradeoff
 * that precedent already accepts. */
const DEFAULT_CAST_TIME = 0.60;

const SKILL_ID = 'ember_bolt';

/** `03-combat-math.md` §4.5: casts default to `windupFrac 0.65`,
 * `activeFrac 0.15` — the projectile spawns at the entry to `active`, i.e.
 * 0.65 of the interval in (`05` §4.1's own wording, verbatim). */
export const CAST_WINDUP_FRAC = 0.65;
export const CAST_ACTIVE_FRAC = 0.15;
export const CAST_RECOVER_FRAC = 1 - CAST_WINDUP_FRAC - CAST_ACTIVE_FRAC; // 0.20

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Cast-phase decomposition for `ember_bolt`, correcting `combat.castInterval`'s
 * own gap-4 placeholder base — see the file header.
 * @param {number} castIntervalNow `combat.castInterval(actor, 'ember_bolt')`
 *   — already FCR-divided and clamped against the WRONG (placeholder) base.
 * @param {number} realCastTime `def.castTime` (0.55 for `ember_bolt`).
 * @param {{windup:number,active:number,recover:number,baseInterval:number}} [out]
 * @returns {{windup:number,active:number,recover:number,baseInterval:number}}
 */
export function computeCastPhases(castIntervalNow, realCastTime, out) {
  if (!out) out = { windup: 0, active: 0, recover: 0, baseInterval: 0 };
  // Undo combat.castInterval()'s own division against the placeholder base,
  // then substitute the real one — see the file header's quantified caveat.
  const scaleFactor = realCastTime / DEFAULT_CAST_TIME;
  const baseInterval = clamp(castIntervalNow * scaleFactor, 0.15, 3.0);

  out.windup = CAST_WINDUP_FRAC * baseInterval;
  out.active = CAST_ACTIVE_FRAC * baseInterval;
  out.recover = CAST_RECOVER_FRAC * baseInterval;
  out.baseInterval = baseInterval;
  return out;
}

/**
 * Builds one `ember_bolt` cast handler.
 * @returns {{skillId:string, cast:Function, onHitframe:Function}}
 */
export function createEmberBoltSkill() {
  const phasesScratch = { windup: 0, active: 0, recover: 0, baseInterval: 0 };

  // --- per-actor pending-cast scratch, poolIndex-indexed (no Map) ---------
  let capacity = 64;
  let pendingActionSeq = new Int32Array(capacity).fill(-1);
  let pendingLevel = new Int32Array(capacity);
  let pendingTargetX = new Float64Array(capacity);
  let pendingTargetZ = new Float64Array(capacity);

  function ensureCapacity(poolIndex) {
    if (poolIndex < capacity) return;
    const grown = Math.max(poolIndex + 1, capacity * 2);
    const nextSeq = new Int32Array(grown).fill(-1);
    const nextLevel = new Int32Array(grown);
    const nextTargetX = new Float64Array(grown);
    const nextTargetZ = new Float64Array(grown);
    nextSeq.set(pendingActionSeq);
    nextLevel.set(pendingLevel);
    nextTargetX.set(pendingTargetX);
    nextTargetZ.set(pendingTargetZ);
    capacity = grown;
    pendingActionSeq = nextSeq;
    pendingLevel = nextLevel;
    pendingTargetX = nextTargetX;
    pendingTargetZ = nextTargetZ;
  }

  /**
   * Spawns the actual projectile at the tick the cast enters `active`.
   * @param {object} actor
   * @param {{physics:object, skills:object}} deps
   */
  function spawnBolt(actor, deps, def) {
    const { physics, skills } = deps;
    const idx = actor.poolIndex;
    const level = pendingLevel[idx];
    const targetX = pendingTargetX[idx];
    const targetZ = pendingTargetZ[idx];
    pendingActionSeq[idx] = -1; // consumed

    const dx = targetX - actor.x;
    const dz = targetZ - actor.z;
    const dist = Math.sqrt(dx * dx + dz * dz); // Math.sqrt, never Math.hypot
    let dirX, dirZ;
    if (dist < 1e-6) {
      // Degenerate (cast on top of self) — fire along current facing rather
      // than a zero-length/undefined direction.
      dirX = Math.cos(actor.facing);
      dirZ = Math.sin(actor.facing);
    } else {
      dirX = dx / dist;
      dirZ = dz / dist;
    }

    const mask = (actor.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER) | physics.MASK.WORLD;

    const pierceFromLevel = def.projectile.pierce && def.projectile.pierce.fromLevel;
    const pierce = pierceFromLevel != null && level >= pierceFromLevel;

    skills.spawnProjectile({
      x: actor.x, z: actor.z,
      dirX, dirZ,
      speed: def.projectile.speed,
      lifetime: def.projectile.lifetime,
      radius: def.projectile.radius,
      pierce,
      mask,
      sourceId: actor.id, sourceGen: actor.generation, team: actor.team,
      skillId: SKILL_ID, level,
      // 05 §4.1 DamagePacket row: "attackRating = 0 -> always hits (03
      // §5.1, R2 skipped). dodgeable false, blockable false" — see
      // ../projectile.js's own header for why this is applied as a
      // post-build packet rider rather than by editing combat.
      alwaysHits: true,
    });
  }

  /** Permanent listener (registered once by `index.js`) for
   * `ARCHITECTURE.md`'s `anim:hitframe` `{actor, actionId, actionSeq}`. */
  function onHitframe(payload, deps) {
    const actor = payload.actor;
    if (payload.actionId !== SKILL_ID) return;
    const idx = actor.poolIndex;
    if (idx >= capacity || pendingActionSeq[idx] !== payload.actionSeq) return; // stale or foreign
    spawnBolt(actor, deps, deps.skills.definition(SKILL_ID));
  }

  /**
   * `SkillsSystem.cast()`'s per-skill handler. `target: 'point'` — no
   * target-actor resolution needed (`05` §4.1: "Fires at the cursor's
   * ground point. No line of sight test and no walk-into-range").
   * @param {object} actor
   * @param {object} def `SkillDefinition` for `ember_bolt`
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

    // 05 §4.1: "casts from wherever it stands" — the cursor supplies the
    // target point only, but the actor still turns to face it.
    actors.face(actor, targetX, targetZ, INSTANT_TURN_RATE);

    const castIntervalNow = combat.castInterval(actor, def.id);
    computeCastPhases(castIntervalNow, def.castTime, phasesScratch);

    const actionSeq = actors.beginAction(actor, def.id, phasesScratch.windup, phasesScratch.active, phasesScratch.recover);

    ensureCapacity(actor.poolIndex);
    const idx = actor.poolIndex;
    pendingActionSeq[idx] = actionSeq;
    pendingLevel[idx] = level;
    pendingTargetX[idx] = targetX;
    pendingTargetZ[idx] = targetZ;

    void time; // no cooldown to start — ember_bolt's cooldown is {0,0,0}

    return true;
  }

  return {
    skillId: SKILL_ID,
    cast,
    onHitframe,
  };
}
