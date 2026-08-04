// src/ai/brains/maulsmith.js
//
// AI-6 — `06-monsters-ai.md` §2.5 (`maulsmith` datasheet) and §3.4's
// `maulsmith` column (committed telegraph). `./melee.js`'s own header
// explicitly disclaims this archetype ("`maulsmith` is NOT implemented
// here... its committed, unstunnable wind-up is a materially different,
// more complex mechanic than [AI-2's] single acceptance criterion") — this
// file is that mechanic, on its own.
//
// Shape otherwise follows `./melee.js`: brain state lives in `AiSystem`'s
// parallel arrays, never on `actor.state`; the hit packet is filled by hand
// via `combat.scratchPacket()`.
//
// ---------------------------------------------------------------------------
// The commitment IS `melee.js`'s own `swingActive` gating — nothing extra
// needed
// ---------------------------------------------------------------------------
// §3.4: "while `actor.state === 'windup'`... the brain's transition table is
// reduced to `{S1, S17-suppressed}`. There is no code path from a committed
// slam to any state but `dead` or `hitstun`." `melee.js#stepMeleeBrain`'s
// own `swingActive` gate already refuses EVERY decision — movement
// included — for the whole wind-up + active + recovery window, which is
// STRICTER than spec's own "reduced cadence to 12 ticks" prose (that prose
// exists because a windowed re-decision, even a rare one, still finds
// nothing legal to do — see §3.4's own next sentence). This file reuses
// that exact gate unmodified; no 12-tick partial cadence is implemented
// because it would produce byte-identical behaviour to full commitment.
//
// ---------------------------------------------------------------------------
// D-81 — the S6 trigger range is 2.6 m, not the spec table's wrong 1.9 m row
// ---------------------------------------------------------------------------
// `06` §3.4's own override table gives "S6 range: 2.6 m" for `maulsmith`
// (the Maulsmith's real `desiredRange`) — this file uses that, matching
// `crowd.js`'s own D-81 finding that §8.2's ring-slot ROW was computed with
// the WRONG 1.9 m (bone_ranker's) figure while the ring-slot FORMULA (which
// this file has nothing to do with) is normative and uses 2.6 m correctly.
//
// ---------------------------------------------------------------------------
// What this file does NOT implement — the true AoE, reported not hidden
// ---------------------------------------------------------------------------
// `crushing_slam`'s 3.2 m damage radius is a real AoE (`03` §9.2, and §2.5's
// own "escape margin" analysis) — this file resolves against the SINGLE
// current target only, at the SAME 2.6 m range used to trigger the slam,
// never widening the hit test to the full 3.2 m disc at `hitTick`. This is
// the same simplification `melee.js`'s own header makes for `bone_ranker`
// ("no `physics.overlapCone` call... an M5-adjacent, multi-target concern
// this ticket's single-target criterion does not need to hold") — extended
// here rather than re-litigated, since nothing in MB2/MB18/MB19 exercises a
// second target inside the blast. A player who steps to just outside 2.6 m
// but still inside 3.2 m would, in this implementation, wrongly escape a
// slam the real spec would still land — a real, minor gap.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()`.

import { BESTIARY, damageMult, arMult } from '../data/bestiary.js';

export const MAULSMITH_ARCHETYPES = Object.freeze(new Set(['maulsmith']));

const FIXED_HZ = 60;
const FIXED_DT = 1 / 60;
const MAULSMITH_TURN_RATE = Math.PI * 2; // rad/s — same placeholder class as melee.js's MELEE_TURN_RATE

// `06` §2.5 / §3.4, transcribed verbatim.
const SLAM_RANGE = 2.6; // S6 override, D-81
const SLAM_W = 1.20;
const SLAM_S = 0.14;
const SLAM_R = 0.85;
const SLAM_DAMAGE_MULT = 2.20; // 220%
const SLAM_KNOCKBACK = 100; // percent, packet.knockback's own unit (see melee.js's packet fields)
const WINDUP_FLOOR_S = 0.90; // never falls below this, at any IAS — MB19

const DECISION_CADENCE_TICKS = 6; // 06 §3.2 — reached only outside a committed swing (see file header)

function iasMult(iasPercent) {
  return 1 / (1 + iasPercent / 100);
}

/** `crushing_slam`'s ticks. `windTicks` applies the 0.90 s floor to the
 * SECONDS value before converting to ticks (§2.5's own worked derivation:
 * "1.20 × 0.625 = 0.75 s -> floored to 0.90 s"), matching the exact
 * arithmetic the datasheet shows, not a floor on the tick COUNT (which
 * would round differently). `activeTicks` never scales (generic rule).
 * `recTicks` follows the generic formula — UNFLOORED (§2.5's own swift row:
 * "R = 0.85 × 0.625 = 0.53 s", no floor language at all). Exported for
 * MB18/MB19. */
export function crushingSlamTicks(iasPercent = 0) {
  const mult = iasMult(iasPercent);
  const windSeconds = Math.max(WINDUP_FLOOR_S, SLAM_W * mult);
  const windTicks = Math.max(2, Math.round(windSeconds * FIXED_HZ));
  const activeTicks = Math.round(SLAM_S * FIXED_HZ);
  const recTicks = Math.max(1, Math.round(SLAM_R * FIXED_HZ * mult));
  return { windTicks, activeTicks, recTicks, hitTick: windTicks };
}

// Precomputed once, at module load — see `shaman.js`'s identical comment on
// its own `DUST_BOLT_TICKS_0` for why `startSlam` reuses this frozen object
// rather than calling `crushingSlamTicks(0)` inline on every slam start.
const CRUSHING_SLAM_TICKS_0 = Object.freeze(crushingSlamTicks(0));

/**
 * One fixed step of the `maulsmith` brain. Same call contract as
 * `melee.js#stepMeleeBrain`. `Alloc: no`.
 */
export function stepMaulsmithBrain(ctx, actors, actor, target, brains, idx, BRAIN_STATE, hasteStore) {
  const step = ctx.time.step;

  if (brains.swingActive[idx] === 1 && brains.hitTickStep[idx] === step) {
    emitSlamHit(ctx, actor, target);
    brains.hitTickStep[idx] = -1;
  }

  if (brains.swingActive[idx] === 1) {
    if (step >= brains.attackReadyStep[idx]) {
      brains.swingActive[idx] = 0;
    } else {
      return false; // committed — see file header
    }
  }

  if (step < brains.nextDecisionStep[idx]) {
    if (brains.state[idx] === BRAIN_STATE.chase) moveTowards(actors, actor, target, hasteStore, idx, step);
    return false;
  }
  brains.nextDecisionStep[idx] = step + DECISION_CADENCE_TICKS;

  const state = brains.state[idx];
  if (state === BRAIN_STATE.chase) {
    const canSlam = !target.dead && step >= brains.attackReadyStep[idx] && actors.inRange(actor, target, SLAM_RANGE);
    if (canSlam) startSlam(ctx, actors, actor, target, brains, idx, BRAIN_STATE);
    else moveTowards(actors, actor, target, hasteStore, idx, step);
  } else if (state === BRAIN_STATE.attack) {
    // S9/S10 — the 0.01 s idle tail is "effectively continuous" per §3.4,
    // so this file re-enters the same anim-only cycle rather than a
    // separately-tracked full-`attackTime` cycle (see `startSlam`).
    const stillInRange = !target.dead && actors.inRange(actor, target, SLAM_RANGE);
    if (stillInRange && step >= brains.attackReadyStep[idx]) startSlam(ctx, actors, actor, target, brains, idx, BRAIN_STATE);
    else brains.state[idx] = BRAIN_STATE.chase;
  }
  return true;
}

function moveTowards(actors, actor, target, hasteStore, idx, step) {
  const dx = target.x - actor.x;
  const dz = target.z - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    let runSpeed = BESTIARY.maulsmith.runSpeed;
    if (hasteStore) runSpeed *= hasteMultOf(hasteStore, idx, step);
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, MAULSMITH_TURN_RATE);
}

/** Local re-implementation, see `swarm.js#hasteMultOf`'s own comment. */
function hasteMultOf(hasteStore, idx, step) {
  return idx < hasteStore.maxBrains && hasteStore.hasteUntilStep[idx] >= step ? 1.20 : 1;
}

function startSlam(ctx, actors, actor, target, brains, idx, BRAIN_STATE) {
  const step = ctx.time.step;
  const ticks = CRUSHING_SLAM_TICKS_0;
  brains.state[idx] = BRAIN_STATE.attack;
  brains.swingActive[idx] = 1;
  brains.hitTickStep[idx] = step + ticks.windTicks;
  brains.attackReadyStep[idx] = step + ticks.windTicks + ticks.activeTicks + ticks.recTicks;
  actors.face(actor, target.x, target.z, MAULSMITH_TURN_RATE);
}

/** `06` §2.5: 220% of row damage, row AR, `knockback 100`. */
function emitSlamHit(ctx, actor, target) {
  const combat = ctx.get('combat');
  if (!combat || typeof combat.scratchPacket !== 'function') return;
  const packet = combat.scratchPacket();
  if (!packet) return;

  const row = BESTIARY[actor.archetypeId];
  const mlvl = actor.level;

  packet.sourceId = actor.id;
  packet.sourceGen = actor.generation;
  packet.sourceSkillId = 'crushing_slam';
  packet.sourceLevel = 0;
  packet.team = actor.team;
  packet.physMin = Math.round(row.baseMinDamage * SLAM_DAMAGE_MULT * damageMult(mlvl));
  packet.physMax = Math.round(row.baseMaxDamage * SLAM_DAMAGE_MULT * damageMult(mlvl));
  packet.attackRating = Math.round(row.baseAttackRating * arMult(mlvl));
  packet.attackerLevel = mlvl;
  packet.blockable = true;
  packet.dodgeable = true;
  packet.critChance = 5;
  packet.critMult = 200;
  packet.knockback = SLAM_KNOCKBACK;

  ctx.events.emit('combat:hit-request', { source: actor, target, packet });
  combat.releasePacket(packet);
}
