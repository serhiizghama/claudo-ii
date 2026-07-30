// src/ai/brains/melee.js
//
// AI-2 — `06-monsters-ai.md` §13 step 2: "The `bone_ranker` brain — M2's
// monster." Implements the shared FSM of §3.3, restricted (per that step's
// own text) to `{dormant, chase, attack, dead}`, with `bone_ranker`'s §3.4
// melee overrides. Direct steering, no `nav` — perception (§4), leash, packs
// and flow-field integration are §13 steps 3-4, out of scope (O-27: this is
// not "those features don't exist", only "this ticket didn't build them").
//
// `maulsmith` is NOT implemented here despite being `06` §3.4's other melee
// row and despite this file's generic name (`melee.js`, the ticket's own
// choice, not mine) — its committed, unstunnable wind-up is a materially
// different, more complex mechanic than this ticket's single acceptance
// criterion (bone_ranker only) asked for. See the report.
//
// ---------------------------------------------------------------------------
// Brain state lives entirely in `AiSystem`'s own parallel typed arrays —
// never on the `Actor` record, never on `actor.state`/`actor.actionId`. `06`
// §3.1, verbatim: "`actor.state` is the animation/action machine owned by
// `actors`; `brain.state` is the decision machine owned by `ai`. They advance
// independently and neither reads the other's transition table." This file
// reads `actor.x/z/radius/team/level/archetypeId/dead` (plain reads, always
// legal) and writes only through `actors.moveTo`/`actors.face` (both
// sanctioned, exposed `ActorsSystem` methods) plus `ai`'s own arrays — it
// never touches `actor.state`, and never imports `src/actors/action.js` or
// `src/actors/stats.js`. See the report for exactly why: `ActorsSystem`
// (ACTR-1/2, `src/actors/index.js`, off-limits to this ticket) does not
// forward `setState`/`beginAction`/`canAct`/`canMove`/`composeStats`/
// `setSourceLayer` at all, and reaching past it into those sibling files
// would be a real `ARCHITECTURE.md` rule-2 violation (an ai->actors internals
// import) this ticket chose not to make. The consequence, reported plainly:
// a spawned Ranker's `actor.state` stays `'spawning'` forever — nothing here
// ever calls `setState`. Nothing in this ticket's acceptance criterion reads
// `actor.state` (`resolve.js`'s own target-validity check, R1, gates on
// `dead`/`flags`/`invulnUntil`, never on `state` — verified by reading
// `isValidTarget`), so the criterion holds regardless; this is a real gap
// for whichever ticket wires a live spawn path through the action machine.
//
// Damage numbers are never read from `actor.stats` (never composed for the
// Ranker at all — see `../index.js`'s header for why) and never
// re-declared as brain-local literals either: every hit packet is filled by
// re-deriving `BESTIARY[actor.archetypeId]` × the mlvl multipliers, at the
// moment of the hit, from `actor.archetypeId`/`actor.level` — the same
// single source of truth `ai.spawnOne` used to set `actor.life` at spawn.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()`. Schedules against `ctx.time.step` only, per `06` §14 /
// `ARCHITECTURE.md`'s determinism contract — this file draws no RNG of its
// own at all (bone_ranker's M2 slice has no `shield_guard` roll — that 20%
// draw is `attack`'s "Ranker guard" sub-mode, `06` §3.1/§3.4, explicitly
// M2-adjacent-but-not-M2: it reacts to *being hit*, which is a `combat`
// dependency this ticket's own criterion never exercises, and `ai`'s single
// `ctx.rng.fork()` — §14, "taken once in init(), never re-forked" — is owned
// by `../index.js`, not spent here).

import { BESTIARY, damageMult, arMult } from '../data/bestiary.js';

/** Archetypes this brain handles. `spawnOne` (`../index.js`) refuses any
 * other id — see that file's header. Exported so a caller/test can assert
 * the scope without duplicating the literal set. */
export const MELEE_ARCHETYPES = Object.freeze(new Set(['bone_ranker']));

const FIXED_HZ = 60;
const FIXED_DT = 1 / 60; // ARCHITECTURE.md's FIXED_DT, verbatim — a compile-time constant, not a clock read (same class of use motion.js's own FIXED_STEP_SECONDS already makes).

// `06-monsters-ai.md` §2.1's `attack` row for `bone_ranker`. `bestiary.js`
// (AI-1, not this ticket's file) deliberately excludes attack tables/ranges
// from its per-archetype rows — see that file's own header ("NONE of that is
// included below, on purpose... should be sourced from `06` §1-§2 directly at
// that point, not guessed at here"). This IS that point; kept as named
// constants, not inline magic numbers, so a reviewer can check them against
// the datasheet directly.
const RANKER_ATTACK_RANGE = 1.9; // m, surface-to-surface (desiredRange / S6 override)
const RANKER_W = 0.42; // wind-up, seconds, pre-IAS
const RANKER_S = 0.10; // active, seconds, never scaled
const RANKER_R = 0.33; // recovery, seconds, pre-IAS
const RANKER_ATTACK_TIME = 1.40; // period between attack STARTS (includes the idle tail)
const RANKER_RANGE_HYSTERESIS = 0.4; // S9's "+ 0.4 m"

// No IAS source exists for a Ranker in this ticket's scope (`actor.stats` is
// never composed for it — see the header) so `mult` is always 1; ticks below
// are therefore the un-scaled `08 §6.1` expression evaluated at IAS 0. If a
// future ticket composes real monster stats, this is the one place to plumb
// `increasedAttackSpeed` through — kept as a named `mult` rather than baking
// `1` into each Math.round so that future edit is a one-line change.
const IAS_MULT = 1;
const WIND_TICKS = Math.max(2, Math.round(RANKER_W * FIXED_HZ * IAS_MULT));
const ACTIVE_TICKS = Math.round(RANKER_S * FIXED_HZ); // never scaled — 08 §6.2
const REC_TICKS = Math.max(1, Math.round(RANKER_R * FIXED_HZ * IAS_MULT));
const ATTACK_CYCLE_TICKS = Math.round(RANKER_ATTACK_TIME * FIXED_HZ); // includes the idle tail

// `06` §3.2: decisions at 10 Hz — every 6 fixed steps — for `chase`/`attack`.
const DECISION_CADENCE_TICKS = 6;

// Placeholder: `08-characters-visual.md`'s real per-archetype turn-rate table
// is out of this ticket's assigned reading (only `06` §3.3/§3.4, §13 step 2
// and §14 were read). A generous constant (one full turn per second) keeps
// the Ranker visibly facing its target without inventing a number the spec
// would otherwise supply — flagged in the report, not silently guessed at
// as if it were real data.
const MELEE_TURN_RATE = Math.PI * 2; // rad/s

/**
 * One fixed step of the `bone_ranker` brain for a single actor/brain slot.
 * Called once per real step, per live brain, by `AiSystem.fixedUpdate`
 * (`../index.js`) — never call this more than once for the same actor in the
 * same step (the hit-tick / decision-cadence bookkeeping below assumes
 * `ctx.time.step` advances by exactly 1 between calls, per
 * `ARCHITECTURE.md`'s own `time.step` contract).
 *
 * @param {object} ctx live or stub `ctx` — `time.step`, `events`, `get`.
 * @param {object} actors `ctx.get('actors')`.
 * @param {object} actor the Ranker's `Actor` record.
 * @param {object} target the current target `Actor` record (never null —
 *   caller only invokes this once `brains.targetId[idx]` resolves).
 * @param {{state:Int32Array, targetId:Int32Array, nextDecisionStep:Int32Array,
 *   attackReadyStep:Int32Array, swingActive:Uint8Array, hitTickStep:Int32Array}} brains
 *   `AiSystem`'s own parallel arrays (built once, passed by reference every
 *   call — never allocated here).
 * @param {number} idx `actor.poolIndex` — the brain's slot.
 * @param {{dormant:number, chase:number, attack:number, dead:number}} BRAIN_STATE
 *   the state-code enum (`../index.js`'s own, passed in rather than
 *   duplicated so there is exactly one authority for the numeric codes).
 * @returns {boolean} true if a decision (state re-evaluation) ran this step.
 */
export function stepMeleeBrain(ctx, actors, actor, target, brains, idx, BRAIN_STATE) {
  const step = ctx.time.step;

  // Hit-tick check runs every step, independent of decision cadence — 06
  // §3.2: "Movement runs every step regardless of cadence," and the hit
  // itself is scheduled once, at attack-start, not re-decided.
  if (brains.swingActive[idx] === 1 && brains.hitTickStep[idx] === step) {
    emitRankerHit(ctx, actor, target);
    brains.hitTickStep[idx] = -1; // defensive — step is monotonic, this fires at most once anyway
  }

  if (brains.swingActive[idx] === 1) {
    if (step >= brains.attackReadyStep[idx]) {
      brains.swingActive[idx] = 0; // wind-up+active+recover+idle-tail elapsed — free to re-decide (S9/S10)
    } else {
      return false; // rooted mid-swing: no movement, no decision yet
    }
  }

  if (step < brains.nextDecisionStep[idx]) {
    // Off-cadence: movement still executes every step while chasing.
    if (brains.state[idx] === BRAIN_STATE.chase) moveTowards(actors, actor, target);
    return false;
  }

  brains.nextDecisionStep[idx] = step + DECISION_CADENCE_TICKS;
  const state = brains.state[idx];

  if (state === BRAIN_STATE.chase) {
    const canSwing = !target.dead && step >= brains.attackReadyStep[idx]
      && actors.inRange(actor, target, RANKER_ATTACK_RANGE); // S6
    if (canSwing) {
      startSwing(ctx, actors, actor, target, brains, idx, BRAIN_STATE);
    } else {
      moveTowards(actors, actor, target);
    }
  } else if (state === BRAIN_STATE.attack) {
    // The swing that just elapsed brought us here — S9/S10, in that order.
    const stillInRange = !target.dead
      && actors.distance(actor, target) <= RANKER_ATTACK_RANGE + RANKER_RANGE_HYSTERESIS;
    if (stillInRange && step >= brains.attackReadyStep[idx]) {
      startSwing(ctx, actors, actor, target, brains, idx, BRAIN_STATE); // S10
    } else {
      brains.state[idx] = BRAIN_STATE.chase; // S9
    }
  }

  return true;
}

/** Direct steering toward `target`, no `nav` (§13 step 2). `runSpeed` comes
 * straight off the bestiary row — never `actors.moveSpeed()`, which
 * (`src/actors/motion.js`'s own header, verified by reading it) is a
 * placeholder returning a flat 4.2 m/s for every actor regardless of
 * archetype until a real class/bestiary table is wired into it; using it
 * here would silently give a Ranker the wrong approach speed. `Math.sqrt`,
 * never `Math.hypot` (this ticket's own rule 5). */
function moveTowards(actors, actor, target) {
  const dx = target.x - actor.x;
  const dz = target.z - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    const runSpeed = BESTIARY.bone_ranker.runSpeed;
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, MELEE_TURN_RATE);
}

/** Starts a new swing: schedules `hitTickStep`/`attackReadyStep` off the
 * current step and faces the target once, at commit — 06 §3.4's Ranker has
 * "0.33 s of free facing" during recovery which this simplified brain does
 * not re-test at hit time (no `physics.overlapCone` call here — see the
 * report for why: a facing-based miss needs a cone test against a live
 * target list, an M5-adjacent, multi-target concern this ticket's
 * single-target criterion does not need to hold). */
function startSwing(ctx, actors, actor, target, brains, idx, BRAIN_STATE) {
  const step = ctx.time.step;
  brains.state[idx] = BRAIN_STATE.attack;
  brains.swingActive[idx] = 1;
  brains.hitTickStep[idx] = step + WIND_TICKS;
  brains.attackReadyStep[idx] = step + ATTACK_CYCLE_TICKS;
  actors.face(actor, target.x, target.z, MELEE_TURN_RATE);
}

/** Builds and emits the `combat:hit-request` for one landed swing. `06`
 * §2.0: "Unless a row says otherwise, a monster packet carries `attackRating`
 * = the row's AR, `attackerLevel` = `mlvl`, `critChance 5`, `critMult 200`,
 * `blockable true`, `dodgeable true`, and no `onHitStatus` riders" — applied
 * verbatim. `06` §2.0 also says "every packet is built by
 * `combat.buildAttackPacket()`" — NOT followed here; see the report for why
 * that path corrupts monster damage (it always folds in `resolveWeapon`'s
 * `WEAPONS.unarmed` 1-3 flat fallback, since a monster's `equipment` is
 * `null`, on top of whatever this function supplies). `combat.scratchPacket()`
 * — "a zeroed packet the caller must release", `02-api-contracts.md` §8's own
 * words for exactly this manual-fill use — is used instead. */
function emitRankerHit(ctx, actor, target) {
  const combat = ctx.get('combat');
  if (!combat || typeof combat.scratchPacket !== 'function') return;

  const packet = combat.scratchPacket();
  if (!packet) return; // pool exhausted — combat's own scratchPacket() already warns

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

  ctx.events.emit('combat:hit-request', { source: actor, target, packet });
  combat.releasePacket(packet);
}
