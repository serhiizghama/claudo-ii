// src/skills/channel.js
//
// SKIL-7 — Channels and toggles (`05-skills.md` §14 row 7): `whirlwind`'s
// channel state (0.55 s ticking, 70 % movement, hit-recovery immunity) and
// `polarity`'s toggle (the switch, its 10-mana cost, the 1.5 s lockout).
// `src/skills/index.js` owns wiring this module onto the `skills`
// subsystem's cast dispatch table, `fixedUpdate`, and the three contract
// methods (`interrupt`, `isChannelling`, `polarityStance`) — this file owns
// the mechanics only. D-37 scope: `whirlwind`/`polarity` only, nothing else.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// (`tools/check-imports.mjs` sweeps `src/skills/` with `checkGlobals:
// true`). No `Math.random()` — nothing here draws randomness.
//
// ---------------------------------------------------------------------------
// Why the channel never calls `actors.beginAction` — states.js's own,
// already-accepted design
// ---------------------------------------------------------------------------
// `src/actors/data/states.js` (ACTR-9, accepted) is explicit: `channel` is
// reachable ONLY from `idle`/`move` via a bare `setState()`, never through
// `beginAction`'s windup/active/recover pipeline ("channelled skills are
// not staged through the beginAction wind/active/recover pipeline in this
// ticket's model"). Two independent reasons confirm this is not optional:
//   1. `beginAction` unconditionally calls `setState(actor, 'windup')` —
//      `windup -> channel` is not a legal edge, so a follow-up
//      `setState(actor,'channel')` would fail and strand the actor in
//      `windup`, which IS movement-locked (`MOVEMENT_LOCKED_STATES`),
//      directly contradicting "the actor moves toward the cursor... for as
//      long as it is held" (05 §2.3). `channel` is deliberately EXCLUDED
//      from that lock (states.js's own comment) — only reachable by never
//      routing through `windup` at all.
//   2. `src/actors/index.js`'s `fixedUpdate` drives `advanceAction` for
//      every actor with `actionId !== null`, which auto-completes
//      windup+active+recover and force-`setState`s back to `idle` once its
//      own tick budget elapses — incompatible with a channel whose duration
//      is open-ended (held until released/out of rage/dead/stunned/frozen).
// So this file never touches `actor.actionId` for `whirlwind` at all — the
// channel is driven entirely by this engine's own `fixedUpdate`, gated on
// its OWN per-actor schedule, never on the action-state machine's.
//
// ---------------------------------------------------------------------------
// The hardest part: R2's cadence vs. CMBT-8/D-51's per-action rage guard —
// fixed at the source (D-52), not worked around here
// ---------------------------------------------------------------------------
// `src/combat/onhit.js#shouldAwardActionRage` gates the ATTACKER's
// automatic rage credit on `(source.generation, source.actionSeq)` — but
// ONLY when `source.actionId !== null`. Since (per the section above) this
// file NEVER sets `actor.actionId`, `source.actionId === null` holds for
// the entire channel. Under the ORIGINAL CMBT-8/D-51 guard, that branch
// awarded UNCONDITIONALLY, every call, no bookkeeping at all — that file's
// own report had already flagged the channel case as an open question and
// left it unresolved. An earlier revision of THIS file worked around it
// with a before/after `actor.rage` snapshot around each hit-request,
// reversing whatever combat credited. The orchestrator correctly rejected
// that: reversing another subsystem's economy from outside it silently
// discards any OTHER legitimate rage change landing in the same window
// (gear-granted `rageOnHit` triggers, a future on-hit source) and breaks
// the instant anything else touches rage between the two snapshots.
//
// The real fix landed in `src/combat/onhit.js` itself (D-52, a named
// micro-scope grant — see that file's own header for the full reasoning):
//   1. The `actionId === null` fallback is tightened from "award
//      unconditionally" to "one award per `(generation, step)`" — a
//      `bone_ranker`'s own single-target swing is unaffected (one hit, one
//      step, one award); any actionId-less attacker landing MULTIPLE hits
//      in the SAME step (a channel's own tick, or any future case) now
//      credits once per step, never once per hit.
//   2. That alone still does not give a channel R2's actual cadence
//      (`attackInterval`, neither per-hit nor per-step) — so `onhit.js`
//      also grew `packet.requesterOwnsRageCredit` (default `false`,
//      documented in that file's own header): when a caller sets it,
//      `applyOnHitEconomy` skips the attacker's rage credit for every hit
//      that packet produces, in full, and the caller (here) owns it
//      outright. `doDamageTick` below sets it on `whirlwind`'s own packet
//      right after building it — combat therefore credits the attacker
//      NOTHING for any `whirlwind` hit, ever, and `doRageIncome` is the
//      SOLE source of this channel's rage income, on its own schedule
//      (`combat.attackInterval`, never the 0.55 s tick period), completely
//      decoupled from how many targets the tick loop actually resolved.
//      Resonance and the defender's own rage are untouched by the flag —
//      see `onhit.js`'s header for why.
//
// ---------------------------------------------------------------------------
// R2's own income number — a deliberately NOT fabricated hit chance
// ---------------------------------------------------------------------------
// `03-combat-math.md` §2.4's own worked figure (`0.778146 x 6 / 0.675 =
// 6.9161`, corrected to 6.9169 by the already-accepted D-9 finding —
// `tests/combat/onhit.test.js`) is a SINGLE-target reference build's
// `chanceToHit()`. `whirlwind` has no single canonical target — it is a
// 360 deg AoE that may find 0, 1, 3 or 8 bodies in radius, each with its
// own attack-rating/defense pair. Rule 6 forbids inventing a stand-in
// number for that, so `doRageIncome` below computes a REAL, non-fabricated
// hit chance via `combat.chanceToHit()` against whichever target the AoE
// query actually finds (lowest `actor.id`, for determinism) — using live,
// already-composed stats, never an invented constant. For a homogeneous
// target set (same monster archetype/level at every body count — exactly
// how 05 §12.1's own 1/3/8-target comparison is structured) this reproduces
// an IDENTICAL hit chance regardless of target count, which is what makes
// the income identical too; a mixed-composition pack would not, and that
// divergence is real and expected, not a bug — R1/R2 only ever promised
// "not scaling with target COUNT", never "independent of which bodies are
// present". If NO target is in radius, the award is 0 for that boundary —
// nothing to land on, nothing earned, matching R1's own "credited on the
// first landed hit" framing generalised to "nothing lands, nothing pays".
//
// ---------------------------------------------------------------------------
// Movement cap — modelled as a `movementSpeed` stat contribution, the same
// mechanism `chilled`/`slowed` already use
// ---------------------------------------------------------------------------
// `03-combat-math.md` §3: "`chilled` and `slowed` contribute NEGATIVE
// `movementSpeed` through the status layer, so all slows stack
// ADDITIVELY." `actors.moveSpeed(actor)` is the only public read of the
// composed number (`classRunSpeed x (1 + movementSpeed/100)`), and it has
// no separate "channel cap" input — so `writeStatPartial` below contributes
// `movementSpeed: -(100 - moveSpeedPercent)` (`-30` for `whirlwind`'s data-
// driven `70`) through the SAME 'skills' source layer `_syncPassiveLayer`
// already merges. At `movementSpeed === 0` from every other source this
// reproduces "70 % of moveSpeed" exactly; stacked with another additive
// modifier (gear, a buff) it is the same additive-stacking approximation
// the engine already applies to `chilled`/`slowed`, not a new one this file
// invents. Read `moveSpeedPercent` from `def.extra.channel` — never
// hard-coded — per this ticket's own brief.
//
// ---------------------------------------------------------------------------
// Hit-recovery immunity — SIMULATION-level immunity is what this file can
// give; FSM-level immunity is a `src/combat/`/`src/actors/` change, flagged
// ---------------------------------------------------------------------------
// `03-combat-math.md` §8.1 / `05` §2.3: hit recovery does NOT interrupt
// `whirlwind`. `src/combat/reaction.js#applyReaction` calls
// `actors.cancelAction(target, 'hitstun')` unconditionally whenever
// `hitstunTriggers()` fires and the target is outside its own
// `hitstunImmuneUntil` window — with NO carve-out for `actor.state ===
// 'channel'`, and `states.js`'s own adjacency table (ACTR-9, accepted)
// deliberately allows `channel -> hitstun` ("a continuous channel is
// exactly the kind of state a hard CC or death should be able to cut
// short" — written without `whirlwind`'s own, later-specified exception in
// view). Neither file is in this ticket's list to change, and
// `hitstunImmuneUntil` is a combat-owned field this file has no method to
// write (rule: never write an Actor field directly).
//
// What this file CAN and DOES guarantee: the channel's SIMULATION —
// damage ticks, rage drain, rage income, the movement cap — is driven
// entirely by this engine's own per-actor bookkeeping (`fixedUpdate`
// below), gated ONLY on death / `stunned` / `frozen` / running out of rage,
// NEVER on `actor.state` or `actors.canAct()`. A hit that forces
// `actor.state` to `'hitstun'` therefore does NOT stop a single tick, does
// NOT pause the drain, and does NOT lift the movement cap — verified in
// this ticket's own test by calling `actors.cancelAction(actor,'hitstun')`
// directly (mirroring exactly what `reaction.js` does) and observing the
// channel keep ticking. What it does NOT fix: `actor.state` itself still
// flips to `'hitstun'` for the FSM/presentation layer, and nothing today
// restores it to `'channel'` afterward (nothing in `src/` currently clears
// `hitstun` back to `idle` on `hitstunUntil` elapsing either — a pre-
// existing, unrelated gap). Closing the FSM-level half for real needs
// either `reaction.js` to skip the `cancelAction` call for a channelling
// target, or `states.js` to special-case `whirlwind` specifically (not
// `channel` generally, since `ash_wall` placement — the OTHER documented
// `channel` user — has no such exemption in the spec). Flagged, not
// patched, per this ticket's own instruction not to monkey-patch the
// engine to make a test pass.
//
// ---------------------------------------------------------------------------
// Per-actor state survives pool recycle — id-encodes-generation, the same
// precedent `cost.js#encodeCooldownStamp` / `onhit.js#encodeActionRageStamp`
// / `imbue.js` already established
// ---------------------------------------------------------------------------
// `src/actors/pool.js`'s own header: `actor.id = 1 + poolIndex + generation
// x capacity` is a BIJECTION — two different `(poolIndex, generation)`
// pairs can never produce the same `id`. So a plain `actor.id` stamp per
// `poolIndex` slot is already generation-safe on its own (no separate
// packed-stamp arithmetic needed, unlike a value that must ALSO carry a
// payload number): `stanceId[poolIndex] === actor.id` is `false` for any
// actor other than the exact one that last wrote that slot, INCLUDING a
// same-slot successor from a later generation. `whirlwind`'s own active-
// channel bookkeeping uses the identical technique via the dense list's own
// `activeId[]` (`actors.byId(activeId[slot])` returns `null` the instant
// that slot's occupant has recycled, which is the ONLY validity check the
// fixedUpdate loop needs).
//
// ---------------------------------------------------------------------------
// Deliberately not modelled — read before extending
// ---------------------------------------------------------------------------
// - `whirlwind`'s own "entry costs one attack.windup" (05 §2.3 prose) is
//   NOT implemented — see the first section above for why (it needs a
//   `windup -> channel` FSM edge that does not exist and should not: it
//   would re-lock movement for the whole windup, contradicting the
//   channel's own defining property). The channel begins on the SAME
//   fixed step `cast()` succeeds.
// - The "exit is 0.15 s of recover" (05 §2.3) is implemented as a plain
//   0.15 s `whirlwind`-only re-cast cooldown (`startCooldown`, reusing
//   SKIL-2's existing machinery) rather than a real FSM `recover` state,
//   for the same reason. `EXIT_RECOVER_SECONDS` below is hard-coded from
//   that prose line — `data/skills.js` (SKIL-1, frozen, not this ticket's
//   file) has no field for it, the same documented gap
//   `impl/cleaving_strike.js#CONE_HALF_ANGLE` already carries for its own
//   angle constant.
// - `actors.face()` is never called for `whirlwind` — the skill is
//   self-centred/360 deg, so facing has no gameplay effect; a facing
//   animation cue during the channel is a presentation gap, not fixed here.
// - `packet.requesterOwnsRageCredit` does NOT touch Resonance — combat's
//   own per-hit Resonance credit (D-05-2's "per landed hit, never per-
//   action" rule, deliberately not gated by either `shouldAwardActionRage`
//   or this flag) still fires on every `whirlwind` hit. `whirlwind` is a
//   Ravager (rage-only) skill and never reads `actor.resonance`, so this is
//   harmless noise on a field nothing Ravager-side ever consumes — flagged,
//   not suppressed (suppressing it would need a second, Resonance-specific
//   flag `onhit.js` was not asked to add).

import { levelValue, cooldownOf, startCooldown, rageForLandedAction } from './cost.js';
import { SKILLS } from './data/skills.js';

const FIXED_HZ = 60;

const WHIRLWIND_ID = 'whirlwind';
const POLARITY_ID = 'polarity';

const WHIRLWIND_DEF = SKILLS.find((d) => d.id === WHIRLWIND_ID);
const POLARITY_DEF = SKILLS.find((d) => d.id === POLARITY_ID);

/** 05 §2.3: "exit is 0.15 s of recover" — see the file header's "Deliberately
 * not modelled" section for why this is a hard-coded constant, not a
 * `data/skills.js` field. */
const EXIT_RECOVER_SECONDS = 0.15;

/** `100 - moveSpeedPercent`, read from data once — D-05-1 / this ticket's
 * own brief: "read from the data, do not hard-code either number." */
const MOVE_SPEED_REDUCTION_PERCENT = 100 - WHIRLWIND_DEF.extra.channel.moveSpeedPercent;

/** `overlapCircle`'s own `out:int[]` capacity. 05 §1.5's pack-occupancy
 * model gives `whirlwind` 3 bodies typically; this ticket's own 1/3/8
 * comparison tops out at 8. Comfortable headroom above both, matching
 * `impl/cleaving_strike.js#MAX_CONE_TARGETS`'s own precedent. */
const MAX_QUERY_TARGETS = 32;

function clampInt(v, lo) {
  return v < lo ? lo : v;
}

/**
 * Builds one channel/toggle engine — a self-contained closure over its own
 * preallocated scratch, never shared with any other `SkillsSystem`
 * instance (mirrors `createImbueEngine()`'s own "one engine instance per
 * SkillsSystem, never module-scope state" discipline).
 * @param {(actor:object, skillId:string) => number} effectiveLevelFn bound
 *   `SkillsSystem#effectiveLevel` — the SAME stable callback `index.js`
 *   already builds for `computePassiveLayer`.
 * @returns {object}
 */
export function createChannelEngine(effectiveLevelFn) {
  // =========================================================================
  // `whirlwind` — per-actor channel schedule, poolIndex-indexed, growable
  // =========================================================================
  let wwCapacity = 64;
  let wwLevel = new Int32Array(wwCapacity);
  let wwTickIntervalSteps = new Int32Array(wwCapacity);
  let wwNextTickStep = new Float64Array(wwCapacity);
  let wwRageIntervalSteps = new Int32Array(wwCapacity);
  let wwNextRageStep = new Float64Array(wwCapacity);

  function ensureWwCapacity(poolIndex) {
    if (poolIndex < wwCapacity) return;
    const grown = Math.max(poolIndex + 1, wwCapacity * 2);
    const nextLevel = new Int32Array(grown);
    const nextTickInt = new Int32Array(grown);
    const nextTickStep = new Float64Array(grown);
    const nextRageInt = new Int32Array(grown);
    const nextRageStep = new Float64Array(grown);
    nextLevel.set(wwLevel);
    nextTickInt.set(wwTickIntervalSteps);
    nextTickStep.set(wwNextTickStep);
    nextRageInt.set(wwRageIntervalSteps);
    nextRageStep.set(wwNextRageStep);
    wwCapacity = grown;
    wwLevel = nextLevel;
    wwTickIntervalSteps = nextTickInt;
    wwNextTickStep = nextTickStep;
    wwRageIntervalSteps = nextRageInt;
    wwNextRageStep = nextRageStep;
  }

  // --- dense active list — cheap fixedUpdate iteration without scanning
  // every possible poolIndex. `activeId[slot]` is the id-encodes-generation
  // stamp (see file header); `reverseSlot[poolIndex]` is the O(1) removal
  // index, `-1` when that poolIndex has no active channel. ---------------
  let activeCapacity = 64;
  let activeId = new Int32Array(activeCapacity);
  let activePoolIndex = new Int32Array(activeCapacity);
  let activeCount = 0;
  let reverseCapacity = 64;
  let reverseSlot = new Int32Array(reverseCapacity).fill(-1);

  function ensureActiveCapacity() {
    if (activeCount < activeCapacity) return;
    const grown = activeCapacity * 2;
    const nextId = new Int32Array(grown);
    const nextPoolIndex = new Int32Array(grown);
    nextId.set(activeId);
    nextPoolIndex.set(activePoolIndex);
    activeCapacity = grown;
    activeId = nextId;
    activePoolIndex = nextPoolIndex;
  }

  function ensureReverseCapacity(poolIndex) {
    if (poolIndex < reverseCapacity) return;
    const grown = Math.max(poolIndex + 1, reverseCapacity * 2);
    const next = new Int32Array(grown).fill(-1);
    next.set(reverseSlot);
    reverseCapacity = grown;
    reverseSlot = next;
  }

  function addActive(poolIndex, id) {
    ensureActiveCapacity();
    ensureReverseCapacity(poolIndex);
    const slot = activeCount++;
    activeId[slot] = id;
    activePoolIndex[slot] = poolIndex;
    reverseSlot[poolIndex] = slot;
  }

  function removeActive(poolIndex) {
    if (poolIndex >= reverseCapacity) return;
    const slot = reverseSlot[poolIndex];
    if (slot === -1) return;
    const last = activeCount - 1;
    const lastPoolIndex = activePoolIndex[last];
    activeId[slot] = activeId[last];
    activePoolIndex[slot] = lastPoolIndex;
    reverseSlot[lastPoolIndex] = slot;
    reverseSlot[poolIndex] = -1;
    activeCount--;
  }

  /** `isChannelling(actor) => boolean` — see the file header's "id-encodes-
   * generation" section for why comparing `actor.id` alone is sufficient. */
  function isChannellingInternal(actor) {
    if (!actor || actor.poolIndex >= reverseCapacity) return false;
    const slot = reverseSlot[actor.poolIndex];
    return slot !== -1 && activeId[slot] === actor.id;
  }

  // =========================================================================
  // `polarity` — per-actor stance, poolIndex-indexed, growable. No dense
  // list needed (no fixedUpdate work), just a generation-safe read/write.
  // =========================================================================
  let stCapacity = 64;
  let stanceId = new Int32Array(stCapacity);
  let stanceValue = new Int8Array(stCapacity); // 0 = blade, 1 = storm

  function ensureStanceCapacity(poolIndex) {
    if (poolIndex < stCapacity) return;
    const grown = Math.max(poolIndex + 1, stCapacity * 2);
    const nextId = new Int32Array(grown);
    const nextVal = new Int8Array(grown);
    nextId.set(stanceId);
    nextVal.set(stanceValue);
    stCapacity = grown;
    stanceId = nextId;
    stanceValue = nextVal;
  }

  /** 'blade' is the documented default — "Neither stance is off... starting
   * in Blade" (05 §7.3) — for any actor that has never toggled (or whose
   * slot's stance write belongs to a previous generation). */
  function readStance(actor) {
    const idx = actor.poolIndex;
    if (idx >= stCapacity || stanceId[idx] !== actor.id) return 'blade';
    return stanceValue[idx] === 1 ? 'storm' : 'blade';
  }

  // =========================================================================
  // Scratch — reused every call, never reallocated
  // =========================================================================
  const queryOut = new Int32Array(MAX_QUERY_TARGETS);
  const hitPayload = { source: null, target: null, packet: null };
  const channelEventPayload = { actor: null, skillId: WHIRLWIND_ID, active: false };

  // =========================================================================
  // whirlwind — damage tick (0.55 s, D-05-1) and R2's income cadence
  // =========================================================================

  function maskFor(physics, actor) {
    return actor.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
  }

  /** Damage: builds ONE packet per tick (05 §2.3's own "once per tick, not
   * once per channel"), marks it `requesterOwnsRageCredit` so combat awards
   * the attacker nothing for it (D-52, `src/combat/onhit.js`), and resolves
   * every body in radius in ascending `actor.id` order (05's own
   * multi-target convention) — see the file header's central section. */
  function doDamageTick(actor, poolIndex, deps) {
    const { physics, combat, actors, events } = deps;
    const level = wwLevel[poolIndex];
    const radius = levelValue(WHIRLWIND_DEF.radius, level);
    const count = physics.overlapCircle(actor.x, actor.z, radius, maskFor(physics, actor), queryOut);
    if (count === 0) return;
    const view = queryOut.subarray(0, count);
    view.sort();

    const packet = combat.buildAttackPacket(actor, WHIRLWIND_ID, level);
    if (!packet) return; // pool exhausted (O-59) — nothing to resolve this tick
    // D-52 (src/combat/onhit.js) — skills owns R2's cadence outright; tell
    // combat not to award the attacker's rage for any hit this packet
    // produces at all (see that file's own header for the field's full
    // semantics). Caller-adjustable per that same header's whitelist note.
    packet.requesterOwnsRageCredit = true;

    for (let i = 0; i < view.length; i++) {
      const targetId = view[i];
      if (targetId === actor.id) continue;
      const target = actors.byId(targetId);
      if (!target || target.dead) continue;

      hitPayload.source = actor;
      hitPayload.target = target;
      hitPayload.packet = packet;
      events.emit('combat:hit-request', hitPayload);
    }

    combat.releasePacket(packet);
  }

  /** R2: one award, at `combat.attackInterval` cadence, using a REAL
   * (non-fabricated) hit chance against whichever target the AoE actually
   * finds — see the file header's own dedicated section. */
  function doRageIncome(actor, poolIndex, deps) {
    const { physics, combat, actors } = deps;
    const level = wwLevel[poolIndex];
    const radius = levelValue(WHIRLWIND_DEF.radius, level);
    const count = physics.overlapCircle(actor.x, actor.z, radius, maskFor(physics, actor), queryOut);
    if (count === 0) return; // nothing in radius -> nothing lands -> nothing earned
    const view = queryOut.subarray(0, count);
    view.sort();

    let targetId = -1;
    for (let i = 0; i < view.length; i++) {
      if (view[i] !== actor.id) { targetId = view[i]; break; }
    }
    if (targetId === -1) return;
    const target = actors.byId(targetId);
    if (!target || target.dead) return;

    const aStats = actors.stats(actor);
    const tStats = actors.stats(target);
    const hitChancePercent = combat.chanceToHit(aStats.attackRating, tStats.defense, actor.level, target.level);
    const award = (hitChancePercent / 100) * rageForLandedAction(actor);
    if (award > 0) actors.addRage(actor, award);
  }

  /** Ends one actor's `whirlwind` channel — release, out of rage, death,
   * `stunned`, `frozen` (05 §2.3's own four enders; hit recovery is
   * deliberately absent — see the file header). Safe to call with a `null`
   * `actor` (already-recycled slot) — only the active-list bookkeeping runs. */
  function endWhirlwind(poolIndex, actor, deps) {
    removeActive(poolIndex);
    if (!actor) return;

    if (!actor.dead) {
      deps.actors.cancelAction(actor, 'interrupt'); // channel -> idle (states.js)
      startCooldown(actor, WHIRLWIND_ID, EXIT_RECOVER_SECONDS, deps.time.step);
    }
    if (deps.syncSkillsLayer) deps.syncSkillsLayer(actor); // drops the movementSpeed contribution
    if (deps.events) {
      channelEventPayload.actor = actor;
      channelEventPayload.skillId = WHIRLWIND_ID;
      channelEventPayload.active = false;
      deps.events.emit('skill:channel', channelEventPayload);
    }
  }

  /** `SkillsSystem#cast()`'s per-skill handler for `whirlwind`. */
  function castWhirlwind(actor, def, level, targetX, targetZ, deps) {
    void targetX; void targetZ; // self-centred (05 §2.3) — no target coordinates needed
    const { actors, combat, time } = deps;

    if (isChannellingInternal(actor)) return false; // already channelling — refuse a duplicate entry, never double-track one actor

    if (!actors.setState(actor, 'channel')) return false; // idle/move -> channel only

    const idx = actor.poolIndex;
    ensureWwCapacity(idx);
    wwLevel[idx] = level;

    const tickPeriodS = def.extra.channel.tickPeriodS; // D-05-1: 0.55 — read from data, never hard-coded
    wwTickIntervalSteps[idx] = clampInt(Math.round(tickPeriodS * FIXED_HZ), 1);

    const attackIntervalSeconds = combat.attackInterval(actor, def.id); // R2: cadence, not tick period
    wwRageIntervalSteps[idx] = clampInt(Math.round(attackIntervalSeconds * FIXED_HZ), 1);

    const step = time.step;
    wwNextTickStep[idx] = step + wwTickIntervalSteps[idx];
    wwNextRageStep[idx] = step + wwRageIntervalSteps[idx];

    addActive(idx, actor.id);
    if (deps.syncSkillsLayer) deps.syncSkillsLayer(actor); // applies the 70% movement cap now
    if (deps.events) {
      channelEventPayload.actor = actor;
      channelEventPayload.skillId = WHIRLWIND_ID;
      channelEventPayload.active = true;
      deps.events.emit('skill:channel', channelEventPayload);
    }
    return true;
  }

  /** Driven once per real fixed step from `SkillsSystem#fixedUpdate`.
   * Iterates the dense active list backwards so a mid-loop swap-remove
   * (the standard technique) never skips or double-processes an entry. */
  function fixedUpdate(deps) {
    const { actors, physics, combat, skills, time } = deps;
    if (!actors || !physics || !combat || !skills) return;
    const step = time.step;

    for (let i = activeCount - 1; i >= 0; i--) {
      const id = activeId[i];
      const poolIndex = activePoolIndex[i];
      const actor = actors.byId(id); // null the instant this poolIndex's occupant has recycled

      if (!actor || actor.dead) { endWhirlwind(poolIndex, actor, deps); continue; }
      if (actors.hasStatus(actor, 'stunned') || actors.hasStatus(actor, 'frozen')) {
        endWhirlwind(poolIndex, actor, deps);
        continue;
      }

      // --- drain: fractional, every fixed step (05 §2.3: "never in whole
      // points") --------------------------------------------------------
      const cost = skills.costOf(actor, WHIRLWIND_ID);
      const perStep = cost.resource === 'rage' ? cost.amount / FIXED_HZ : 0;
      if (perStep > 0 && !actors.spend(actor, 'rage', perStep)) {
        endWhirlwind(poolIndex, actor, deps); // out of rage
        continue;
      }

      // --- damage tick ----------------------------------------------------
      if (step >= wwNextTickStep[poolIndex]) {
        doDamageTick(actor, poolIndex, deps);
        wwNextTickStep[poolIndex] += wwTickIntervalSteps[poolIndex];
      }

      // --- R2 income cadence ----------------------------------------------
      if (step >= wwNextRageStep[poolIndex]) {
        doRageIncome(actor, poolIndex, deps);
        wwNextRageStep[poolIndex] += wwRageIntervalSteps[poolIndex];
      }
    }
  }

  /** `interrupt(actor) => void` — "cancels a cast or a channel"
   * (`02-api-contracts.md` §10). For `whirlwind` this is the ONLY release
   * path (05 §2.3: "Releasing ends the channel"); for any other in-progress
   * action this is a best-effort forward onto `actors.cancelAction`, which
   * itself refuses `'interrupt'` during windup/active/recover (`action.js`'s
   * own, already-accepted gating) — this file does not second-guess that. */
  function interrupt(actor, deps) {
    if (!actor) return;
    if (isChannellingInternal(actor)) {
      endWhirlwind(actor.poolIndex, actor, deps);
      return;
    }
    if (actor.actionId !== null && deps.actors) deps.actors.cancelAction(actor, 'interrupt');
  }

  // =========================================================================
  // polarity — toggle
  // =========================================================================

  /** `SkillsSystem#cast()`'s per-skill handler for `polarity`. `canCast()`
   * (index.js, unmodified) already enforces the 1.5 s lockout generically
   * via `cooldownRemainingSteps`/`polarity`'s own `cooldown` data row — this
   * handler only does the switch itself. */
  function castPolarity(actor, def, level, targetX, targetZ, deps) {
    void targetX; void targetZ; // target: 'self' — no coordinates needed
    const { actors, time, skills } = deps;

    const cost = skills.costOf(actor, def.id); // 10 mana, flat at every level
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    const idx = actor.poolIndex;
    ensureStanceCapacity(idx);
    const current = stanceId[idx] === actor.id ? stanceValue[idx] : 0; // 0 = blade default
    stanceId[idx] = actor.id;
    stanceValue[idx] = current === 0 ? 1 : 0; // the only two stances — always flips

    const cooldownSeconds = cooldownOf(def, level); // 1.5 s flat (data: base 1.5, minimum 1.5)
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    if (deps.syncSkillsLayer) deps.syncSkillsLayer(actor); // 05 §7.3: "emits stats:dirty on every switch"
    return true;
  }

  /** `polarityStance(actor) => 'blade'|'storm'|null` — `null` for an actor
   * with no points in `polarity` (the stance mechanism does not exist for
   * them at all). */
  function polarityStance(actor) {
    if (effectiveLevelFn(actor, POLARITY_ID) < 1) return null;
    return readStance(actor);
  }

  /** Merged into `_syncPassiveLayer`'s partial (`index.js`) — `polarity`'s
   * two stat keys (always written, 0 when unallocated — SKIL-5's own
   * "always assign every key" discipline) and `whirlwind`'s movement-cap
   * contribution (0 when not channelling). Both writers are THIS file, so
   * there is no risk of two independent `setSourceLayer('skills', ...)`
   * calls racing (the SAME failure mode `imbue.js`'s own header already
   * documents and avoids for its six keys).
   * @param {object} actor
   * @param {object} partial the SAME object `computePassiveLayer` /
   *   `writeImbueStatPartial` already wrote into.
   */
  function writeStatPartial(actor, partial) {
    const polLevel = effectiveLevelFn(actor, POLARITY_ID);
    if (polLevel < 1) {
      partial.physicalDamagePercent = 0;
      partial.elementalDamagePercent = 0;
    } else {
      const stance = readStance(actor);
      const table = POLARITY_DEF.extra.stances[stance];
      if (stance === 'blade') {
        partial.physicalDamagePercent = levelValue(table.physicalDamagePercent, polLevel);
        partial.elementalDamagePercent = table.elementalDamagePercent; // flat -15
      } else {
        partial.elementalDamagePercent = levelValue(table.elementalDamagePercent, polLevel);
        partial.physicalDamagePercent = table.physicalDamagePercent; // flat -15
      }
    }

    partial.movementSpeed = isChannellingInternal(actor) ? -MOVE_SPEED_REDUCTION_PERCENT : 0;
  }

  return {
    whirlwind: { skillId: WHIRLWIND_ID, cast: castWhirlwind },
    polarity: { skillId: POLARITY_ID, cast: castPolarity },
    fixedUpdate,
    interrupt,
    isChannelling: isChannellingInternal,
    polarityStance,
    writeStatPartial,
  };
}
