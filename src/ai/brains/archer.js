// src/ai/brains/archer.js
//
// AI-6 — `06-monsters-ai.md` §2.3 (`ashen_archer` datasheet) and §3.5
// (kiting). Shape follows `./melee.js`: brain state lives in `AiSystem`'s
// parallel arrays, never on `actor.state`; hit packets are filled by hand
// via `combat.scratchPacket()`.
//
// ---------------------------------------------------------------------------
// Kiting sub-modes live inside `chase`/`attack`, never `BRAIN_STATE.reposition`
// ---------------------------------------------------------------------------
// §3.1's own encoding table puts "archer retreat" inside `reposition`
// (`targetRef.id !== 0 and desiredRange === 8.0`). `reposition` is
// `perception.js`'s exclusive dispatch target — `../index.js`'s loop routes
// ANY brain in that state to `stepPerceptionBrain` before this file would
// ever see it, and that handler's only behaviour is "steer to the pack
// centre" (leash return). Setting a retreating Archer's `brains.state` to
// `reposition` would silently reroute it into leash-return the very next
// step — the same collision `crowd.js`'s own header documents for its
// doorway queue, and `shaman.js`'s header documents for its own back-away.
// This file's three bands (retreat/hold/approach, §3.5) are therefore all
// internal MOVEMENT sub-modes tracked in this file's own store while
// `brains.state` stays `chase` (moving) or `attack` (firing) — a resolved,
// reported deviation from §3.1's literal encoding, not a silent one.
//
// ---------------------------------------------------------------------------
// What this file does NOT implement — reported, not hidden
// ---------------------------------------------------------------------------
// - A1's sidestep re-test, A2's "cornered" commit, and the mid-shot ±1.2 m
//   strafe are elaborations of kiting, not the mechanic itself (retreat /
//   hold / approach with hysteresis, which this file DOES implement in
//   full). Out of this ticket's time budget; the archer never gets
//   permanently stuck without them — a failed LOS check just withholds the
//   shot and holds position, per §3.5's own text ("withheld shots do not
//   consume the cooldown").
// - `ash_shot`'s `ProjectileSpec` (flight time, lifetime, a real travelling
//   actor) is not built — no `skills`/`fx` projectile system is reachable
//   from `src/ai/`. The shot resolves INSTANTLY at `hitTick` if
//   `physics.lineOfSight` holds then (or unconditionally if `physics` is
//   absent — a stub-`ctx` fallback, same class of guard `../index.js`
//   already applies to `nav`/`physics`), matching `melee.js`'s own
//   "no cone/projectile system, direct resolution" precedent for M2.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()`.

import { BESTIARY, damageMult, arMult } from '../data/bestiary.js';

export const ARCHER_ARCHETYPES = Object.freeze(new Set(['ashen_archer']));

const FIXED_HZ = 60;
const FIXED_DT = 1 / 60;
const ARCHER_TURN_RATE = Math.PI * 2; // rad/s — same placeholder class as melee.js's MELEE_TURN_RATE
const MASK_WORLD = 1; // 02-api-contracts.md §4, verbatim — redeclared, not imported (crowd.js's own MASK_ACTORS precedent)

// `06` §2.3's attack table, transcribed verbatim. `ash_shot`'s own 14.0 m
// range coincides with the approach band's own enter edge (`APPROACH_ENTER`,
// below) — the hold band (6..14 m) is exactly the shot's own reach.
const ASH_SHOT_W = 0.66;
const ASH_SHOT_S = 0.04;
const ASH_SHOT_R = 0.40;
const ASH_SHOT_CYCLE_S = 1.70; // attackTime — matches bestiary.js's own ashen_archer.attackTime

// §3.5's bands and hysteresis edges.
const RETREAT_ENTER = 6.0;
const RETREAT_LEAVE = 8.0;
const APPROACH_ENTER = 14.0;
const APPROACH_LEAVE = 11.0;

const DECISION_CADENCE_TICKS = 6; // 06 §3.2

function iasMult(iasPercent) {
  return 1 / (1 + iasPercent / 100);
}

/** `ash_shot`'s ticks — the generic formula, no archetype exception.
 * Exported for MB18. */
export function ashShotTicks(iasPercent = 0) {
  const mult = iasMult(iasPercent);
  const windTicks = Math.max(2, Math.round(ASH_SHOT_W * FIXED_HZ * mult));
  const activeTicks = Math.round(ASH_SHOT_S * FIXED_HZ);
  const recTicks = Math.max(1, Math.round(ASH_SHOT_R * FIXED_HZ * mult));
  return { windTicks, activeTicks, recTicks, hitTick: windTicks };
}

const ASH_SHOT_CYCLE_TICKS = Math.round(ASH_SHOT_CYCLE_S * FIXED_HZ);
export { ASH_SHOT_CYCLE_TICKS };

// Precomputed once, at module load — see `shaman.js`'s identical comment on
// its own `DUST_BOLT_TICKS_0` for why `startShot` reuses this frozen object
// rather than calling `ashShotTicks(0)` inline on every shot start.
const ASH_SHOT_TICKS_0 = Object.freeze(ashShotTicks(0));

/** @param {number} maxBrains same cap `AiSystem` sizes `_brains` to. */
export function createArcherStore(maxBrains) {
  return {
    maxBrains,
    retreating: new Uint8Array(maxBrains),
    approaching: new Uint8Array(maxBrains),
  };
}

/** `Alloc: no`. @returns {boolean} true if a decision ran this step. */
export function stepArcherBrain(ctx, actors, physics, actor, target, brains, idx, BRAIN_STATE, store, hasteStore) {
  const step = ctx.time.step;

  if (brains.swingActive[idx] === 1 && brains.hitTickStep[idx] === step) {
    const fired = tryResolveShot(ctx, physics, actor, target);
    if (!fired) {
      // "Withheld shots do not consume the cooldown" — free to re-decide now.
      brains.attackReadyStep[idx] = step;
    }
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
    if (brains.state[idx] === BRAIN_STATE.chase) driveBands(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, hasteStore);
    return false;
  }
  brains.nextDecisionStep[idx] = step + DECISION_CADENCE_TICKS;

  driveBands(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, hasteStore, true);
  return true;
}

/** Evaluates the three bands with hysteresis and either moves (retreat/
 * approach) or fires on cooldown (hold). `allowFire` is false on an
 * off-cadence movement-only call (matches melee.js's "movement runs every
 * step, decisions do not"). */
function driveBands(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, hasteStore, allowFire = false) {
  if (target.dead) return;
  const step = ctx.time.step;
  const dist = actors.distance(actor, target);

  if (store.retreating[idx]) {
    if (dist >= RETREAT_LEAVE) store.retreating[idx] = 0;
  } else if (dist < RETREAT_ENTER) {
    store.retreating[idx] = 1;
  }
  if (store.retreating[idx]) {
    brains.state[idx] = BRAIN_STATE.chase;
    moveAway(actors, actor, target, hasteStore, idx, step);
    return;
  }

  if (store.approaching[idx]) {
    if (dist <= APPROACH_LEAVE) store.approaching[idx] = 0;
  } else if (dist > APPROACH_ENTER) {
    store.approaching[idx] = 1;
  }
  if (store.approaching[idx]) {
    brains.state[idx] = BRAIN_STATE.chase;
    moveToward(actors, actor, target, hasteStore, idx, step);
    return;
  }

  // Hold band — fire on cooldown.
  brains.state[idx] = BRAIN_STATE.chase;
  actors.face(actor, target.x, target.z, ARCHER_TURN_RATE);
  if (allowFire && step >= brains.attackReadyStep[idx]) {
    startShot(ctx, actors, actor, target, brains, idx, BRAIN_STATE);
  }
}

function startShot(ctx, actors, actor, target, brains, idx, BRAIN_STATE) {
  const step = ctx.time.step;
  const ticks = ASH_SHOT_TICKS_0;
  brains.state[idx] = BRAIN_STATE.attack;
  brains.swingActive[idx] = 1;
  brains.hitTickStep[idx] = step + ticks.windTicks;
  brains.attackReadyStep[idx] = step + ASH_SHOT_CYCLE_TICKS;
  actors.face(actor, target.x, target.z, ARCHER_TURN_RATE);
}

/** Resolves at `hitTick` — LOS-gated, instant (see file header). `Alloc: no`.
 * @returns {boolean} true if the shot actually fired (LOS held / `physics`
 * absent), false if withheld. */
function tryResolveShot(ctx, physics, actor, target) {
  if (target.dead) return false;
  if (physics && typeof physics.lineOfSight === 'function') {
    if (!physics.lineOfSight(actor.x, actor.z, target.x, target.z, MASK_WORLD)) return false;
  }
  emitAshShotHit(ctx, actor, target);
  return true;
}

/** `06` §2.3: 100% of row damage, row AR, generic packet defaults. */
function emitAshShotHit(ctx, actor, target) {
  const combat = ctx.get('combat');
  if (!combat || typeof combat.scratchPacket !== 'function') return;
  const packet = combat.scratchPacket();
  if (!packet) return;

  const row = BESTIARY[actor.archetypeId];
  const mlvl = actor.level;

  packet.sourceId = actor.id;
  packet.sourceGen = actor.generation;
  packet.sourceSkillId = 'ash_shot';
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

  ctx.events.emit('combat:hit-request', { source: actor, target, packet });
  combat.releasePacket(packet);
}

function moveToward(actors, actor, target, hasteStore, idx, step) {
  const dx = target.x - actor.x;
  const dz = target.z - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    let runSpeed = BESTIARY.ashen_archer.runSpeed;
    if (hasteStore) runSpeed *= hasteMultOf(hasteStore, idx, step);
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, ARCHER_TURN_RATE);
}

function moveAway(actors, actor, target, hasteStore, idx, step) {
  const dx = actor.x - target.x;
  const dz = actor.z - target.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    let runSpeed = BESTIARY.ashen_archer.runSpeed;
    if (hasteStore) runSpeed *= hasteMultOf(hasteStore, idx, step);
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, ARCHER_TURN_RATE);
}

/** Local re-implementation, see `swarm.js#hasteMultOf`'s own comment for why
 * this is redeclared rather than cross-imported. */
function hasteMultOf(hasteStore, idx, step) {
  return idx < hasteStore.maxBrains && hasteStore.hasteUntilStep[idx] >= step ? 1.20 : 1;
}
