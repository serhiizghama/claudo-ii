// src/ai/brains/swarm.js
//
// AI-6 — `06-monsters-ai.md` §2.2 (`carrion_swarm` datasheet) and §3.7
// (surround and scatter). Shape follows `./melee.js`: brain state lives in
// `AiSystem`'s parallel arrays, never on `actor.state`; hit packets are
// filled by hand via `combat.scratchPacket()`.
//
// ---------------------------------------------------------------------------
// "Surround" is mostly not this file's job
// ---------------------------------------------------------------------------
// §3.7's C1 ("ring slot reassigned every decision... the goal is the slot,
// never the player's centre") is `../crowd.js`'s own `CROWD_TABLE` row for
// `carrion_swarm` (AI-5 shipped it — `../index.js`'s existing dispatch seam
// already routes a registered pack member in `chase`, not yet in contact
// range, to `stepCrowdMember` INSTEAD of this file, unconditionally, for
// every archetype `CROWD_TABLE` carries). This file's own `chase`/`attack`
// handling below is therefore the FALLBACK path: a solo (non-pack) Swarm
// member, or one already inside its own contact range — direct steering,
// same shape as `melee.js`'s `moveTowards`/`startSwing`. `attack` (the bite)
// is entirely this file's own, always.
//
// This file's actual "one mechanic" is C2/C3 — the scatter. `BRAIN_STATE`
// gains `flee` (additive, matching AI-3's own `wander`/`alert`/`reposition`
// precedent) because `reposition` is `perception.js`'s exclusive dispatch
// target (see `shaman.js`'s header for the identical collision this file
// would hit if it reused that state instead).
//
// ---------------------------------------------------------------------------
// O-105 — a minimal `attack`-state avoidance nudge, here and only here
// ---------------------------------------------------------------------------
// O-105's own measured interpenetration (`docs/PROGRESS.md`) traces to
// `brains/melee.js#moveTowards` steering every `chase`-state actor dead
// straight at its target with zero avoidance, off-limits to this ticket, and
// names this file's own `moveTowards` as the place to try a mitigation for
// the same CLASS of problem where this ticket actually owns the code.
// `carrion_swarm` is where it matters most here: `06` §5.1's own pack
// minimum is 6-12, the largest sustained same-target scrum any archetype
// this ticket owns will ever form. `moveTowards` below blends a small
// `physics.overlapCircle`-sourced separation vector into the desired
// direction (guarded — a no-op with no `physics`, matching every other
// optional-`physics` call site in this subsystem). `archer`/`shaman` hold at
// range rather than crowding into contact, and `maulsmith` never packs past
// a handful, so the same nudge was judged lower-value there and was not
// added, in the interest of the time this ticket actually has — reported,
// not silently assumed unnecessary. `crushing_slam`/`detonate`'s own
// contact windows are so brief (one hit or one death) that sustained
// overlap never has time to accumulate the way a multi-second pack
// engagement does.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()`.

import { BESTIARY, damageMult, arMult } from '../data/bestiary.js';

export const SWARM_ARCHETYPES = Object.freeze(new Set(['carrion_swarm']));

const FIXED_HZ = 60;
const FIXED_DT = 1 / 60;
const SWARM_TURN_RATE = Math.PI * 2; // rad/s — same placeholder class as melee.js's MELEE_TURN_RATE

// `06` §2.2's attack table, transcribed verbatim.
const BITE_RANGE = 1.4;
const BITE_W = 0.22;
const BITE_S = 0.06;
const BITE_R = 0.26;
const BITE_CYCLE_S = 0.75; // attackTime — matches bestiary.js's own carrion_swarm.attackTime
const BITE_RANGE_HYSTERESIS = 0.4; // S9, shared default (§3.3)

const DECISION_CADENCE_TICKS = 6; // 06 §3.2

// O-105 — see file header. Small radius/weight: a nudge, not a real
// avoidance system (`crowd.js`'s own §8.3 machinery, off-limits to add to
// here — this is deliberately cheaper and narrower). `02-api-contracts.md`
// §4's `MASK.ACTORS = 14`, redeclared not imported — same precedent
// `crowd.js`'s own header sets for the identical constant.
const MASK_ACTORS = 14;
const AVOID_RADIUS = 0.9;
const AVOID_WEIGHT = 0.5;
const AVOID_SCRATCH_CAP = 12;

function iasMult(iasPercent) {
  return 1 / (1 + iasPercent / 100);
}

/** `attack`'s ticks — the generic formula, no archetype exception. Exported
 * for MB18. */
export function biteTicks(iasPercent = 0) {
  const mult = iasMult(iasPercent);
  const windTicks = Math.max(2, Math.round(BITE_W * FIXED_HZ * mult));
  const activeTicks = Math.round(BITE_S * FIXED_HZ);
  const recTicks = Math.max(1, Math.round(BITE_R * FIXED_HZ * mult));
  return { windTicks, activeTicks, recTicks, hitTick: windTicks };
}

const BITE_CYCLE_TICKS = Math.round(BITE_CYCLE_S * FIXED_HZ);
export { BITE_CYCLE_TICKS };

// Precomputed once, at module load — see `shaman.js`'s identical comment on
// its own `DUST_BOLT_TICKS_0` for why `startBite` reuses this frozen object
// rather than calling `biteTicks(0)` inline on every swing start.
const BITE_TICKS_0 = Object.freeze(biteTicks(0));

// ---------------------------------------------------------------------------
// §3.7 C2/C3 — scatter.
// ---------------------------------------------------------------------------
const SCATTER_THRESHOLD = 0.40; // Instruction; Renunciation lowers this to 0.25 (§11.3, out of this ticket's scope — no tier plumbing reaches `ai`)
const SCATTER_TICKS = 180; // 3.0 s
const SCATTER_DEST_DIST = 12.0;
const MAX_PACKS = 32; // ASSIGNED — redeclared, same precedent crowd.js/perception.js already set (no export exists; must index the SAME slot numbers perception.js's own registry assigns)
const MAX_PACK_MEMBERS = 16;

/** @param {number} maxBrains same cap `AiSystem` sizes `_brains` to. */
export function createSwarmStore(maxBrains) {
  return {
    maxBrains,
    fleeUntilStep: new Int32Array(maxBrains).fill(-1),
    fleeGoalX: new Float32Array(maxBrains),
    fleeGoalZ: new Float32Array(maxBrains),
    scatteredPack: new Uint8Array(MAX_PACKS), // "once per pack per zone visit"
    // O-105 — reused scratch for `physics.overlapCircle`'s own `out:int[]`
    // contract, never allocated per call.
    _avoidScratch: new Int32Array(AVOID_SCRATCH_CAP),
  };
}

/**
 * `actor:death` handler — wired by `../index.js#init`, same precedent
 * `perception.js`'s own `onActorDamage`/`onActorDeath` listeners already
 * establish. Evaluates C2 for every LIVE `carrion_swarm` pack the dead actor
 * belonged to (per §3.7: "evaluated on actor:death"). `nav` is optional —
 * `nav.snap` is used when available, the pack centre otherwise, and a raw
 * "away from the player" point as the last resort (no nav at all).
 */
export function onSwarmDeath(ctx, actors, nav, brains, perception, store, BRAIN_STATE, payload) {
  const dead = payload.actor;
  if (!dead || dead.archetypeId !== 'carrion_swarm') return;
  const idx = dead.poolIndex;
  if (idx == null || idx >= perception.maxBrains) return;
  const packSlot = perception.packSlot[idx];
  if (packSlot < 0 || store.scatteredPack[packSlot]) return;

  const base = packSlot * MAX_PACK_MEMBERS;
  const count = perception.packMemberCount[packSlot];
  if (count <= 0) return;

  let alive = 0;
  for (let i = 0; i < count; i++) {
    const a = actors.byId(perception.packMembers[base + i]);
    if (a && !a.dead) alive++;
  }
  if (alive / count >= SCATTER_THRESHOLD) return;

  store.scatteredPack[packSlot] = 1;
  const step = ctx.time.step;
  const player = actors.player;

  for (let i = 0; i < count; i++) {
    const a = actors.byId(perception.packMembers[base + i]);
    if (!a || a.dead) continue;
    const aIdx = a.poolIndex;
    if (aIdx >= brains.state.length) continue; // beyond MAX_BRAINS — defensive, same bound ../index.js itself enforces

    brains.state[aIdx] = BRAIN_STATE.flee;
    store.fleeUntilStep[aIdx] = step + SCATTER_TICKS;
    computeFleeGoal(nav, perception, packSlot, a, player, store, aIdx);
  }
}

function computeFleeGoal(nav, perception, packSlot, actor, player, store, idx) {
  let awayX = 1;
  let awayZ = 0;
  if (player) {
    const dx = actor.x - player.x;
    const dz = actor.z - player.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) { awayX = dx / d; awayZ = dz / d; }
  }

  let gx = (player ? player.x : actor.x) + awayX * SCATTER_DEST_DIST;
  let gz = (player ? player.z : actor.z) + awayZ * SCATTER_DEST_DIST;

  if (nav && typeof nav.snap === 'function') {
    const snapped = nav.snap(gx, gz, 3.0);
    if (snapped) { gx = snapped.x; gz = snapped.z; } else {
      gx = perception.packCenterX[packSlot];
      gz = perception.packCenterZ[packSlot];
    }
  }
  store.fleeGoalX[idx] = gx;
  store.fleeGoalZ[idx] = gz;
}

/**
 * The `flee` state's own step — called by `../index.js` for any brain whose
 * state is `BRAIN_STATE.flee` (only `carrion_swarm` ever enters it this
 * ticket). C3: `now >= fleeUntilStep` returns to `chase` (the previous
 * target, untouched by scatter, is still `brains.targetId[idx]`).
 * `Alloc: no`. @returns {boolean} true if a decision ran.
 */
export function stepSwarmFlee(ctx, actors, actor, idx, brains, store, BRAIN_STATE) {
  const step = ctx.time.step;
  if (step >= store.fleeUntilStep[idx]) {
    brains.state[idx] = BRAIN_STATE.chase;
    store.fleeUntilStep[idx] = -1;
    return true;
  }

  const dx = store.fleeGoalX[idx] - actor.x;
  const dz = store.fleeGoalZ[idx] - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    const runSpeed = BESTIARY.carrion_swarm.runSpeed;
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
    actors.face(actor, store.fleeGoalX[idx], store.fleeGoalZ[idx], SWARM_TURN_RATE);
  }
  return false; // movement only, off decision cadence — matches melee.js's own "movement is not a decision"
}

// ===========================================================================
// The fallback chase/attack step — solo members, or pack members already in
// contact range (crowd.js hands off to us exactly then). Same shape as
// `melee.js#stepMeleeBrain`.
// ===========================================================================

/** `Alloc: no`. @returns {boolean} true if a decision ran this step. */
export function stepSwarmBrain(ctx, actors, physics, actor, target, brains, idx, BRAIN_STATE, store, hasteStore) {
  const step = ctx.time.step;

  if (brains.swingActive[idx] === 1 && brains.hitTickStep[idx] === step) {
    emitBiteHit(ctx, actor, target);
    brains.hitTickStep[idx] = -1;
  }

  if (brains.swingActive[idx] === 1) {
    if (step >= brains.attackReadyStep[idx]) {
      brains.swingActive[idx] = 0;
    } else {
      return false;
    }
  }

  if (step < brains.nextDecisionStep[idx]) {
    if (brains.state[idx] === BRAIN_STATE.chase) moveTowards(physics, actors, actor, target, store, hasteStore, idx, step);
    return false;
  }
  brains.nextDecisionStep[idx] = step + DECISION_CADENCE_TICKS;

  const state = brains.state[idx];
  if (state === BRAIN_STATE.chase) {
    const canBite = !target.dead && step >= brains.attackReadyStep[idx] && actors.inRange(actor, target, BITE_RANGE);
    if (canBite) startBite(ctx, actors, actor, target, brains, idx, BRAIN_STATE);
    else moveTowards(physics, actors, actor, target, store, hasteStore, idx, step);
  } else if (state === BRAIN_STATE.attack) {
    const stillInRange = !target.dead && actors.distance(actor, target) <= BITE_RANGE + BITE_RANGE_HYSTERESIS;
    if (stillInRange && step >= brains.attackReadyStep[idx]) startBite(ctx, actors, actor, target, brains, idx, BRAIN_STATE);
    else brains.state[idx] = BRAIN_STATE.chase;
  }
  return true;
}

/** O-105 — blends a small `physics.overlapCircle`-sourced separation vector
 * into the desired direction before scaling by `runSpeed`. No-op (straight
 * steering, exactly `melee.js`'s own shape) when `physics` is absent — see
 * file header. `Alloc: no` (`store._avoidScratch` is the reused
 * `overlapCircle` output buffer). */
function moveTowards(physics, actors, actor, target, store, hasteStore, idx, step) {
  const dx = target.x - actor.x;
  const dz = target.z - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    let dirX = dx / dist;
    let dirZ = dz / dist;

    if (physics && typeof physics.overlapCircle === 'function') {
      const out = store._avoidScratch;
      const count = physics.overlapCircle(actor.x, actor.z, AVOID_RADIUS, MASK_ACTORS, out);
      let ax = 0;
      let az = 0;
      for (let i = 0; i < count; i++) {
        const other = actors.byId(out[i]);
        if (!other || other === actor || other.dead) continue;
        const ndx = actor.x - other.x;
        const ndz = actor.z - other.z;
        const nd = Math.sqrt(ndx * ndx + ndz * ndz);
        if (nd < 1e-6 || nd > AVOID_RADIUS) continue;
        const w = (AVOID_RADIUS - nd) / AVOID_RADIUS;
        ax += (ndx / nd) * w;
        az += (ndz / nd) * w;
      }
      if (ax !== 0 || az !== 0) {
        const bx = dirX + ax * AVOID_WEIGHT;
        const bz = dirZ + az * AVOID_WEIGHT;
        const blen = Math.sqrt(bx * bx + bz * bz);
        if (blen > 1e-6) { dirX = bx / blen; dirZ = bz / blen; }
      }
    }

    let runSpeed = BESTIARY.carrion_swarm.runSpeed;
    if (hasteStore) runSpeed *= hasteMultOf(hasteStore, idx, step);
    const disp = runSpeed * FIXED_DT;
    actors.moveTo(actor, dirX * disp, dirZ * disp);
  }
  actors.face(actor, target.x, target.z, SWARM_TURN_RATE);
}

/** Local re-implementation of `shaman.js#hasteSpeedMult` avoided as an
 * import to keep this file's dependency surface to `../data/bestiary.js`
 * alone, matching every sibling brain file's own "redeclare a two-line
 * helper rather than cross-import" precedent (`crowd.js`'s header on
 * `MASK_ACTORS`/`NAV_FLAG_DOORWAY` is the same call). */
function hasteMultOf(hasteStore, idx, step) {
  return idx < hasteStore.maxBrains && hasteStore.hasteUntilStep[idx] >= step ? 1.20 : 1;
}

function startBite(ctx, actors, actor, target, brains, idx, BRAIN_STATE) {
  const step = ctx.time.step;
  brains.state[idx] = BRAIN_STATE.attack;
  brains.swingActive[idx] = 1;
  brains.hitTickStep[idx] = step + BITE_TICKS_0.windTicks;
  brains.attackReadyStep[idx] = step + BITE_CYCLE_TICKS;
  actors.face(actor, target.x, target.z, SWARM_TURN_RATE);
}

/** `06` §2.2's generic packet: row damage/AR, `knockback 0` explicit. */
function emitBiteHit(ctx, actor, target) {
  const combat = ctx.get('combat');
  if (!combat || typeof combat.scratchPacket !== 'function') return;
  const packet = combat.scratchPacket();
  if (!packet) return;

  const row = BESTIARY[actor.archetypeId];
  const mlvl = actor.level;

  packet.sourceId = actor.id;
  packet.sourceGen = actor.generation;
  packet.sourceSkillId = 'attack';
  packet.sourceLevel = 0;
  packet.team = actor.team;
  packet.physMin = Math.round(row.baseMinDamage * damageMult(mlvl));
  packet.physMax = Math.round(row.baseMaxDamage * damageMult(mlvl));
  packet.attackRating = Math.round(row.baseAttackRating * arMult(mlvl));
  packet.attackerLevel = mlvl;
  packet.blockable = true;
  packet.dodgeable = true;
  packet.critChance = 5;
  packet.critMult = 200;
  packet.knockback = 0;

  ctx.events.emit('combat:hit-request', { source: actor, target, packet });
  combat.releasePacket(packet);
}

export { MAX_PACKS, MAX_PACK_MEMBERS };
