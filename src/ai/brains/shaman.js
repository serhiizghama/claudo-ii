// src/ai/brains/shaman.js
//
// AI-6 — `06-monsters-ai.md` §2.4 (`dust_shaman` datasheet) and §3.6
// (support priority). One archetype, one file, per this ticket's own
// grant. Shape follows `./melee.js` (AI-2's `bone_ranker` brain): brain
// state lives entirely in `AiSystem`'s parallel arrays, never on
// `actor.state`; `combat.scratchPacket()` is filled by hand, never
// `combat.buildAttackPacket()`, for the same reason `melee.js`'s header
// gives (a monster never gets a composed `StatBlock` this milestone).
//
// This file also owns the `haste_dust` buff STORE (`createHasteStore`),
// shared by reference with `swarm.js`/`archer.js`/`maulsmith.js`/
// `crawler.js` (wired in `../index.js`) — see "O-87 and haste_dust" below.
//
// ---------------------------------------------------------------------------
// §3.6's priority order, evaluated every decision (10 Hz, `_brains`' own
// cadence field) while not mid-cast:
//   1. raise_ranker  — guarded: `actors.resurrectableCorpses`/`actors.resurrect`
//      (`02-api-contracts.md` §16 A2, this document's own requested addition)
//      are not implemented by `ActorsSystem` yet — corpses/resurrection is
//      `06` §13 step 9, landing AFTER this ticket. Guarded exactly like
//      `perception.js`'s own `nav.raycastNav` guard: `typeof
//      actors.resurrectableCorpses === 'function'`. Until that ticket ships,
//      this branch's precondition can never be satisfied and priority always
//      falls through — a real, reported gap, not a silent stub.
//   2. haste_dust    — real: cooldown, eligibility count via
//      `actors.forEachInRadius`, and a buff grant into `createHasteStore`'s
//      shared arrays (see below).
//   3. dust_bolt     — a ranged hit, same shape as `melee.js`'s own attack.
//   4. reposition (back away to 8.0 m) — NOT `BRAIN_STATE.reposition`. That
//      state is `perception.js`'s exclusive dispatch target
//      (`../index.js`'s own loop routes ANY `reposition` brain to
//      `stepPerceptionBrain` before this file ever runs — see that file's
//      "leash return" handler, which treats every `reposition` brain as
//      "steer to the pack centre"). Re-using it here would silently reroute
//      a backing-away Shaman into leash-return the next step, the same class
//      of collision `crowd.js`'s own header documents for its doorway queue.
//      This file's back-away sub-mode is therefore internal movement inside
//      `BRAIN_STATE.chase`, never a brain-state transition — a resolved,
//      reported deviation from §3.1's literal `Brain.state` encoding table.
//   5. chase (dist > 9.0) — direct steering, no `nav` (same scope as
//      `melee.js`'s M2 slice).
//
// ---------------------------------------------------------------------------
// O-87 and `haste_dust` — what actually happens
// ---------------------------------------------------------------------------
// `haste_dust` grants `+25 increasedAttackSpeed`/`+20 movementSpeed`. Per
// O-87, `actors.moveSpeed()`/a composed `StatBlock` cannot carry this (flat
// 4.2 m/s for every actor, archetype-blind) — so this file never routes
// through it, matching `melee.js`'s own workaround. Instead `haste_dust`
// grants into `createHasteStore`'s own `hasteUntilStep`/`hasteSourceId`
// arrays, which `swarm.js`/`archer.js`/`maulsmith.js`/`crawler.js` (and this
// file, for its own `chase`/back-away movement) read directly to multiply
// their OWN hand-computed `runSpeed × FIXED_DT` displacement — the same
// bestiary-driven movement idiom every sibling brain already uses. That
// means the movement half of `haste_dust` has a REAL, live effect on five of
// six archetypes — every one this ticket can edit. It has NO effect on
// `bone_ranker`: `melee.js#moveTowards` is off-limits and reads
// `BESTIARY.bone_ranker.runSpeed` unconditionally, with no haste check.
// The `increasedAttackSpeed` half is NOT wired at all — threading an IAS
// multiplier into every sibling file's `windTicks`/`recTicks` math for a
// buff that (per O-87) has no other precedent of affecting monster combat
// speed anywhere in this codebase was judged out of this ticket's
// container: see the report for the full accounting.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()`. Draws no RNG (matches `melee.js`).

import { BESTIARY, damageMult, arMult } from '../data/bestiary.js';

export const SHAMAN_ARCHETYPES = Object.freeze(new Set(['dust_shaman']));

const FIXED_HZ = 60;
const FIXED_DT = 1 / 60;
const SHAMAN_TURN_RATE = Math.PI * 2; // rad/s — same placeholder class as melee.js's MELEE_TURN_RATE

// `06` §2.4's attack table, transcribed verbatim (bestiary.js excludes
// per-action tables on purpose — see that file's own header). `dust_bolt`'s
// own 9.0 m range coincides exactly with the hold band's upper edge
// (`HOLD_MAX_RANGE`, below) — one constant serves both, per §3.6's own text
// ("6.0 <= dist <= 9.0 ... fire dust_bolt on cooldown").
const DUST_BOLT_W = 0.50;
const DUST_BOLT_S = 0.06;
const DUST_BOLT_R = 0.42;
const DUST_BOLT_CYCLE_S = 1.60; // attackTime — bestiary.js's own `attackTime` row for dust_shaman IS this figure

const RAISE_RANGE = 8.0;
const RAISE_W = 1.05; // never scaled by IAS, per §2.4
const RAISE_S = 0.10;
const RAISE_R = 0.55;
const RAISE_COOLDOWN_S = 8.0; // Instruction

const HASTE_RADIUS = 10.0;
const HASTE_W = 0.55;
const HASTE_S = 0.08;
const HASTE_R = 0.40;
const HASTE_COOLDOWN_S = 12.0;
const HASTE_DURATION_S = 6.0;
const HASTE_MIN_ELIGIBLE = 3;
const HASTE_SPEED_MULT = 1.20; // +20 movementSpeed, applied as a multiplier (see file header)

const HOLD_MIN_RANGE = 6.0;
const HOLD_MAX_RANGE = 9.0;
// Retreat's own target range (8.0 m, §3.6 rule 4) needs no separate arrival
// snap: the band test in `decideShaman` already stops the retreat the
// instant `dist >= HOLD_MIN_RANGE`, which is the same hysteresis edge.
const RAISE_MIN_PLAYER_DIST = 5.0;

const DECISION_CADENCE_TICKS = 6; // 06 §3.2, chase/attack cadence

/** `08` §6.1's generic tick formula. `iasPercent` is always 0 in live play
 * this milestone (no monster `StatBlock` is composed — see `../index.js`'s
 * header) but every function below takes it as a real parameter so MB18/
 * MB19 can be proven at IAS 0 and at the extreme the affix/tier tables can
 * produce, per this ticket's own instruction. `Alloc: no`.
 */
function iasMult(iasPercent) {
  return 1 / (1 + iasPercent / 100);
}

/** `dust_bolt`'s ticks — the generic formula, no archetype exception.
 * Exported for MB18. */
export function dustBoltTicks(iasPercent = 0) {
  const mult = iasMult(iasPercent);
  const windTicks = Math.max(2, Math.round(DUST_BOLT_W * FIXED_HZ * mult));
  const activeTicks = Math.round(DUST_BOLT_S * FIXED_HZ);
  const recTicks = Math.max(1, Math.round(DUST_BOLT_R * FIXED_HZ * mult));
  return { windTicks, activeTicks, recTicks, hitTick: windTicks };
}

/** `raise_ranker`'s ticks — `W` is EXPLICITLY never scaled by IAS (§2.4);
 * `R` follows the generic formula. Exported for MB18. */
export function raiseRankerTicks(iasPercent = 0) {
  const mult = iasMult(iasPercent);
  const windTicks = Math.max(2, Math.round(RAISE_W * FIXED_HZ)); // never scaled
  const activeTicks = Math.round(RAISE_S * FIXED_HZ);
  const recTicks = Math.max(1, Math.round(RAISE_R * FIXED_HZ * mult));
  return { windTicks, activeTicks, recTicks, hitTick: windTicks };
}

/** `haste_dust`'s ticks — the generic formula, no archetype exception.
 * Exported for MB18. */
export function hasteDustTicks(iasPercent = 0) {
  const mult = iasMult(iasPercent);
  const windTicks = Math.max(2, Math.round(HASTE_W * FIXED_HZ * mult));
  const activeTicks = Math.round(HASTE_S * FIXED_HZ);
  const recTicks = Math.max(1, Math.round(HASTE_R * FIXED_HZ * mult));
  return { windTicks, activeTicks, recTicks, hitTick: windTicks };
}

const DUST_BOLT_CYCLE_TICKS = Math.round(DUST_BOLT_CYCLE_S * FIXED_HZ);

// Precomputed ONCE, at module load — `startCast` (the hot path, called
// every swing-start) reuses these three frozen objects rather than calling
// `dustBoltTicks(0)`/etc. inline, which would allocate a fresh
// `{windTicks,activeTicks,recTicks,hitTick}` literal on every cast. `IAS 0`
// is the only value ever live this milestone (no monster `StatBlock` is
// composed — see this file's header), same precedent `melee.js`'s own
// `WIND_TICKS`/`ACTIVE_TICKS`/`REC_TICKS` module-level constants set. The
// parametrised functions above stay exported/callable for MB18/MB19, which
// need real IAS sweeps; they are simply never called from the hot path.
const DUST_BOLT_TICKS_0 = Object.freeze(dustBoltTicks(0));
const RAISE_RANKER_TICKS_0 = Object.freeze(raiseRankerTicks(0));
const HASTE_DUST_TICKS_0 = Object.freeze(hasteDustTicks(0));

// ===========================================================================
// The shared haste-buff store — see this file's header ("O-87 and
// haste_dust"). One instance, built once by `../index.js`, passed by
// reference into every sibling brain that wants to read it. Step-stamped
// sentinel `Int32Array`s, matching this subsystem's own established idiom
// (`perception.js`'s `wakeAtStep`, `nav.js`'s `repathAtStep`) — not the
// `generation * 2**32 + value` bit-pack, which solves a different problem
// (see `crowd.js`'s own header for why that idiom does not apply to a
// poolIndex-keyed, never-despawned array like this one).
// ===========================================================================

/** @param {number} maxBrains same cap `AiSystem` sizes `_brains` to. */
export function createHasteStore(maxBrains) {
  return {
    maxBrains,
    hasteUntilStep: new Int32Array(maxBrains).fill(-1),
    hasteSourceId: new Int32Array(maxBrains),
  };
}

/** `true` while `idx`'s actor carries a live `haste_dust` buff. `Alloc: no`. */
export function isHasted(hasteStore, idx, step) {
  return !!hasteStore && idx < hasteStore.maxBrains && hasteStore.hasteUntilStep[idx] >= step;
}

/** The movement-speed multiplier `haste_dust` grants (1 when absent/expired
 * or `hasteStore` was not wired for this call site). `Alloc: no`. */
export function hasteSpeedMult(hasteStore, idx, step) {
  return isHasted(hasteStore, idx, step) ? HASTE_SPEED_MULT : 1;
}

// ===========================================================================
// Shaman's own per-actor store — cooldowns and revive credits `_brains`
// has no field for (it only carries ONE cooldown/hitTick pair, and this
// archetype needs three independent ones). `raiseReadyStep`/`hasteReadyStep`
// gate their own actions; `_brains.attackReadyStep`/`swingActive`/
// `hitTickStep` are reused for whichever action is currently mid-cast
// (never more than one at a time) — `castAction` records which.
// ===========================================================================

const CAST_NONE = 0;
const CAST_BOLT = 1;
const CAST_RAISE = 2;
const CAST_HASTE = 3;

const CORPSE_QUERY_CAP = 8; // headroom above any plausible same-radius corpse count

/** @param {number} maxBrains */
export function createShamanStore(maxBrains) {
  return {
    maxBrains,
    raiseReadyStep: new Int32Array(maxBrains),
    hasteReadyStep: new Int32Array(maxBrains),
    reviveCredits: new Uint8Array(maxBrains),
    castAction: new Int8Array(maxBrains),
    _corpseScratch: new Int32Array(CORPSE_QUERY_CAP),
  };
}

/** Called from `../index.js#spawnOne` for a freshly spawned `dust_shaman` —
 * `Brain.reviveCredits = 1` at spawn, per §2.4. `Alloc: no`. */
export function initShamanBrain(store, idx) {
  store.raiseReadyStep[idx] = 0;
  store.hasteReadyStep[idx] = 0;
  store.reviveCredits[idx] = 1;
  store.castAction[idx] = CAST_NONE;
}

// ===========================================================================
// The brain step.
// ===========================================================================

/**
 * One fixed step of the `dust_shaman` brain, called from `../index.js` for
 * a brain in `chase`/`attack`. Same call contract as
 * `melee.js#stepMeleeBrain` (returns `true` iff a decision ran this step).
 * `Alloc: no`.
 */
export function stepShamanBrain(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, hasteStore) {
  const step = ctx.time.step;

  if (brains.swingActive[idx] === 1 && brains.hitTickStep[idx] === step) {
    resolveCast(ctx, actors, actor, target, brains, idx, store, hasteStore, BRAIN_STATE);
    brains.hitTickStep[idx] = -1;
  }

  if (brains.swingActive[idx] === 1) {
    if (step >= brains.attackReadyStep[idx]) {
      brains.swingActive[idx] = 0;
      store.castAction[idx] = CAST_NONE;
    } else {
      return false; // committed mid-cast — no movement, no re-decision (matches melee.js's own gating)
    }
  }

  if (step < brains.nextDecisionStep[idx]) return false;
  brains.nextDecisionStep[idx] = step + DECISION_CADENCE_TICKS;

  decideShaman(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, hasteStore);
  return true;
}

function decideShaman(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, hasteStore) {
  const step = ctx.time.step;
  if (target.dead) return;
  const dist = actors.distance(actor, target);

  // 1 — raise_ranker (guarded: see file header).
  if (store.reviveCredits[idx] > 0 && step >= store.raiseReadyStep[idx]
    && typeof actors.resurrectableCorpses === 'function' && dist > RAISE_MIN_PLAYER_DIST) {
    const n = actors.resurrectableCorpses(actor.x, actor.z, RAISE_RANGE, store._corpseScratch);
    if (n > 0) {
      startCast(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, CAST_RAISE, RAISE_RANKER_TICKS_0);
      return;
    }
  }

  // 2 — haste_dust.
  if (step >= store.hasteReadyStep[idx]) {
    let eligible = 0;
    if (hasteStore) {
      actors.forEachInRadius(actor.x, actor.z, HASTE_RADIUS, actor.team, (other) => {
        if (other.dead) return;
        const oIdx = other.poolIndex;
        if (oIdx < hasteStore.maxBrains && !isHasted(hasteStore, oIdx, step)) eligible++;
      });
    }
    if (eligible >= HASTE_MIN_ELIGIBLE) {
      startCast(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, CAST_HASTE, HASTE_DUST_TICKS_0);
      return;
    }
  }

  // 3 — dust_bolt. Unlike raise_ranker/haste_dust (independent-cooldown
  // rituals with no idle tail), dust_bolt is an attackTime-cycled action
  // like bone_ranker's own `attack` — `attackReadyStep` uses the FULL
  // attackTime cycle (DUST_BOLT_CYCLE_TICKS, idle tail included), not the
  // anim-only wind+active+recovery sum, matching `melee.js`'s own pattern.
  if (dist >= HOLD_MIN_RANGE && dist <= HOLD_MAX_RANGE && step >= brains.attackReadyStep[idx]) {
    startCast(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, CAST_BOLT, DUST_BOLT_TICKS_0, DUST_BOLT_CYCLE_TICKS);
    return;
  }

  // 4 — back away (internal to `chase`; see file header on why not `reposition`).
  if (dist < HOLD_MIN_RANGE) {
    moveAway(actors, actor, target, hasteStore, idx, step);
    return;
  }

  // 5 — chase.
  if (dist > HOLD_MAX_RANGE) {
    moveToward(actors, actor, target, hasteStore, idx, step);
    return;
  }

  // In-band but nothing to do this tick (bolt on cooldown) — hold position, face target.
  actors.face(actor, target.x, target.z, SHAMAN_TURN_RATE);
}

function startCast(ctx, actors, actor, target, brains, idx, BRAIN_STATE, store, castAction, ticks, readyTicks) {
  const step = ctx.time.step;
  brains.state[idx] = BRAIN_STATE.attack;
  brains.swingActive[idx] = 1;
  store.castAction[idx] = castAction;
  brains.hitTickStep[idx] = step + ticks.windTicks;
  brains.attackReadyStep[idx] = step + (readyTicks ?? (ticks.windTicks + ticks.activeTicks + ticks.recTicks));
  actors.face(actor, target.x, target.z, SHAMAN_TURN_RATE);
}

function resolveCast(ctx, actors, actor, target, brains, idx, store, hasteStore, BRAIN_STATE) {
  const action = store.castAction[idx];
  if (action === CAST_BOLT) {
    emitDustBolt(ctx, actor, target);
  } else if (action === CAST_RAISE) {
    resolveRaiseRanker(ctx, actors, actor, brains, idx, store, BRAIN_STATE);
    store.raiseReadyStep[idx] = ctx.time.step + Math.round(RAISE_COOLDOWN_S * FIXED_HZ);
  } else if (action === CAST_HASTE) {
    resolveHasteDust(ctx, actors, actor, idx, store, hasteStore);
    store.hasteReadyStep[idx] = ctx.time.step + Math.round(HASTE_COOLDOWN_S * FIXED_HZ);
  }
}

/** `06` §2.0's generic packet defaults, damage/AR row from the bestiary at
 * `actor.level`, 100% of row damage (no modifier), per §2.4. */
function emitDustBolt(ctx, actor, target) {
  const combat = ctx.get('combat');
  if (!combat || typeof combat.scratchPacket !== 'function') return;
  const packet = combat.scratchPacket();
  if (!packet) return;

  const row = BESTIARY[actor.archetypeId];
  const mlvl = actor.level;

  packet.sourceId = actor.id;
  packet.sourceGen = actor.generation;
  packet.sourceSkillId = 'dust_bolt';
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

/** Real, but structurally unreachable until `ActorsSystem` forwards
 * `resurrectableCorpses`/`resurrect` (see file header) — `decideShaman`
 * never selects `CAST_RAISE` while that guard fails, so this only runs once
 * a future ticket lands the API. `actors.resurrect` spends the credit ON
 * HIT-TICK per §2.4 ("Credit spend: on hitTick, not on cast start"), and
 * only if it actually revives something — a fizzle refunds nothing because
 * nothing was ever spent. */
function resolveRaiseRanker(ctx, actors, actor, brains, idx, store, BRAIN_STATE) {
  if (typeof actors.resurrectableCorpses !== 'function' || typeof actors.resurrect !== 'function') return;
  const n = actors.resurrectableCorpses(actor.x, actor.z, RAISE_RANGE, store._corpseScratch);
  if (n <= 0) return;
  const corpse = actors.byId(store._corpseScratch[0]); // nearest-first, ascending id — the query's own documented order
  if (!corpse) return;
  const revived = actors.resurrect(corpse, 0.60);
  if (!revived) return;
  store.reviveCredits[idx] = 0;
  const rIdx = corpse.poolIndex;
  if (rIdx < brains.state.length) {
    brains.state[rIdx] = BRAIN_STATE.dormant; // the fresh Brain a future ticket's spawn/lifecycle work should own; left inert here (no MELEE_ARCHETYPES re-entry from this file, out of grant)
    brains.targetId[rIdx] = 0;
    brains.swingActive[rIdx] = 0;
    brains.hitTickStep[rIdx] = -1;
  }
}

/** `+25 IAS` is not wired (file header); `+20 movementSpeed` is granted into
 * `hasteStore` for every eligible `team===actor.team` monster within
 * `HASTE_RADIUS`, including the caster, excluding already-buffed actors. */
function resolveHasteDust(ctx, actors, actor, idx, store, hasteStore) {
  if (!hasteStore) return; // caller ran with no shared haste store wired (e.g. a narrow unit test) — cast still consumes its cooldown, nothing to grant
  const step = ctx.time.step;
  const until = step + Math.round(HASTE_DURATION_S * FIXED_HZ);
  actors.forEachInRadius(actor.x, actor.z, HASTE_RADIUS, actor.team, (other) => {
    if (other.dead) return;
    const oIdx = other.poolIndex;
    if (oIdx >= hasteStore.maxBrains) return;
    if (isHasted(hasteStore, oIdx, step)) return; // "excluding actors that already carry the buff"
    hasteStore.hasteUntilStep[oIdx] = until;
    hasteStore.hasteSourceId[oIdx] = actor.id;
  });
}

function moveToward(actors, actor, target, hasteStore, idx, step) {
  const dx = target.x - actor.x;
  const dz = target.z - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    const runSpeed = BESTIARY.dust_shaman.runSpeed * hasteSpeedMult(hasteStore, idx, step);
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, SHAMAN_TURN_RATE);
}

function moveAway(actors, actor, target, hasteStore, idx, step) {
  const dx = actor.x - target.x;
  const dz = actor.z - target.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    const runSpeed = BESTIARY.dust_shaman.runSpeed * hasteSpeedMult(hasteStore, idx, step);
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, SHAMAN_TURN_RATE);
}

export { DUST_BOLT_CYCLE_TICKS };
