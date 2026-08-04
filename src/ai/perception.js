// src/ai/perception.js
//
// AI-3 — `06-monsters-ai.md` §4 in full: the perception test (§4.2),
// `blindFactor` (§4.3), leash and de-aggro (§4.4), the noise ring (§4.5),
// `ai.alertPack` and its wake ripple plus cross-pack bleed (§4.6). Also adds
// the `dormant`/`wander`/`alert`/`reposition` states to the shared FSM
// (`06` §3.3) that AI-2's `{dormant, chase, attack, dead}` subset (`./index.js`,
// `./brains/melee.js`) did not need yet.
//
// ---------------------------------------------------------------------------
// Why this file, not `./brains/melee.js`, owns leash/de-aggro for a chasing
// brain
// ---------------------------------------------------------------------------
// S15 ("chase/attack/reposition -> reposition, leash") and the chase-side
// de-aggro rule (`06` §4.4 prose: "a brain in chase whose lastSeenStep is
// older than 8.0s... falls to alert") both fire out of `chase`/`attack` —
// states `./brains/melee.js` owns and this ticket's file list does not grant
// (`AI-2`'s file, not `AI-3`'s). Those two checks are exported below
// (`checkLeash`, `stepChaseHooks`) as free functions `./index.js` calls
// UNCONDITIONALLY, every step, for `chase`/`attack` brains, BEFORE deciding
// whether to still hand the step to `stepMeleeBrain` — the same "checked
// every step, not gated by decision cadence" precedent `./index.js` already
// applies to S1 (`actor.dead`) in its own loop. `./brains/melee.js` itself is
// never touched and never learns leash/de-aggro exist; it just stops being
// called the step its `brains.state[idx]` no longer reads `chase`/`attack`.
//
// ---------------------------------------------------------------------------
// The missing `nav.raycastNav` — guarded, not faked (same precedent as
// `src/player/move.js`'s PLYR-2)
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §6 lists `raycastNav(ax,az,bx,bz) => boolean` but no
// landed NAV ticket implements it (`src/nav/index.js` has no such method;
// `src/nav/smooth.js` built the equivalent privately as `segmentWalkable`
// and its own header says a future `raycastNav` ticket may import THAT
// function — this ticket does not, because doing so would import a module
// under `src/nav/` directly, `ARCHITECTURE.md` rule 2). `navLineOfWalk`
// below is a `typeof nav.raycastNav === 'function'` guard: once a NAV ticket
// adds the real method, every caller here picks it up with no edit. Until
// then it falls back to a conservative fixed-step sample walk over the
// PUBLIC `nav.walkable(x,z)` accessor (never `nav.grid.flags` directly) —
// this is not the exact supercover/corner-tie algorithm `smooth.js`
// documents for its own private test, but it is the same CONTRACT ("a
// nav-grid line of walk... cannot see over a kerb it cannot walk over"),
// independently implemented against nav's public surface. See the report
// for MB16's measured mismatch rate against `physics.lineOfSight` using
// this fallback.

import { BESTIARY } from './data/bestiary.js';

const FIXED_DT = 1 / 60;
const TURN_RATE = Math.PI * 2; // rad/s — same placeholder class as melee.js's MELEE_TURN_RATE (08's real per-archetype table is out of scope)

// ---------------------------------------------------------------------------
// §4.1 — the perception table, verbatim. Gameplay numbers, kept as one plain
// frozen literal (ARCHITECTURE.md rule 9) even though it lives inside this
// file rather than under `src/ai/data/` — see the report: `aggroRadius`/
// `leashRadius` are NOT actually present on `src/ai/data/bestiary.js`'s
// `MonsterArchetype` records today (checked directly; AI-1's own header
// explains why it left them out — "should be sourced from 06 §1-§2 directly
// at THAT POINT", i.e. this ticket), so this table carries all five §4.1
// columns rather than re-declaring only three against a source that isn't
// there. `bestiary.js` itself is not in this ticket's file list, so it is
// read, never edited. `molgrim`'s `leashRadius: Infinity` is §4.4's own
// "Boss: leashRadius = ∞; Molgrim never leashes."
// ---------------------------------------------------------------------------
const PERCEPTION_TABLE = Object.freeze({
  bone_ranker:    Object.freeze({ aggroRadius: 13.0, halfAngleDeg: 75,  proximityRadius: 4.0, hearingRadius: 9.0,  leashRadius: 34.0 }),
  carrion_swarm:  Object.freeze({ aggroRadius: 15.0, halfAngleDeg: 110, proximityRadius: 5.0, hearingRadius: 12.0, leashRadius: 40.0 }),
  ashen_archer:   Object.freeze({ aggroRadius: 18.0, halfAngleDeg: 60,  proximityRadius: 4.0, hearingRadius: 10.0, leashRadius: 38.0 }),
  dust_shaman:    Object.freeze({ aggroRadius: 16.0, halfAngleDeg: 70,  proximityRadius: 4.0, hearingRadius: 11.0, leashRadius: 36.0 }),
  maulsmith:      Object.freeze({ aggroRadius: 12.0, halfAngleDeg: 55,  proximityRadius: 3.5, hearingRadius: 8.0,  leashRadius: 30.0 }),
  blight_crawler: Object.freeze({ aggroRadius: 17.0, halfAngleDeg: 130, proximityRadius: 6.0, hearingRadius: 14.0, leashRadius: 44.0 }),
  molgrim:        Object.freeze({ aggroRadius: 26.0, halfAngleDeg: 180, proximityRadius: 26.0, hearingRadius: 26.0, leashRadius: Infinity }),
});

/** Fixed archetype -> integer index, resolved once per brain (cached in
 * `store.archIndex`, never re-looked-up by string per decision — the perf
 * rule: "archetype dispatch keyed on a string id... resolve to an integer
 * index once"). Order is arbitrary, fixed at module load. */
const ARCHETYPE_IDS = Object.freeze(Object.keys(PERCEPTION_TABLE));
export const ARCHETYPE_INDEX = Object.freeze(
  Object.fromEntries(ARCHETYPE_IDS.map((id, i) => [id, i])),
);
const N_ARCH = ARCHETYPE_IDS.length;

const AGGRO_RADIUS = new Float32Array(N_ARCH);
const COS_HALF_ANGLE = new Float32Array(N_ARCH);
const PROXIMITY_RADIUS = new Float32Array(N_ARCH);
const HEARING_RADIUS = new Float32Array(N_ARCH);
const LEASH_RADIUS = new Float32Array(N_ARCH);
const RUN_SPEED = new Float32Array(N_ARCH);

for (let i = 0; i < N_ARCH; i++) {
  const id = ARCHETYPE_IDS[i];
  const row = PERCEPTION_TABLE[id];
  AGGRO_RADIUS[i] = row.aggroRadius;
  COS_HALF_ANGLE[i] = Math.cos((row.halfAngleDeg * Math.PI) / 180);
  PROXIMITY_RADIUS[i] = row.proximityRadius;
  HEARING_RADIUS[i] = row.hearingRadius;
  LEASH_RADIUS[i] = row.leashRadius; // Infinity for molgrim, a legal Float32Array value
  const bestiaryRow = BESTIARY[id];
  RUN_SPEED[i] = bestiaryRow ? bestiaryRow.runSpeed : 0;
}

// ---------------------------------------------------------------------------
// Cross-subsystem constants, redeclared not imported — same precedent
// `src/combat/resolve.js`'s own local `STATUS_BIT`/`ACTOR_FLAG.invulnerable`
// and `src/player/cast.js`'s `ACTOR_FLAG_UNTARGETABLE` already establish
// (01-data-model.md is the source of truth; importing `src/actors/`'s
// internal data module would be a rule-2 violation for a cross-subsystem
// read this small).
// ---------------------------------------------------------------------------
const BLINDED_BIT = 1 << 8; // 01-data-model.md §7.2 STATUS_BIT.blinded
const ACTOR_FLAG_UNTARGETABLE = 1 << 1; // 01-data-model.md §2.1

const BLIND_FACTOR = 0.35; // §4.3, verbatim

// §4.4/§4.6 timers, all in fixed steps (60 Hz) per this ticket's rule 4 —
// never derived from dt/wall clock.
const LEASH_DWELL_TICKS = 60; // 1.0 s continuously over leashRadius
const LEASH_DAMAGE_GRACE_TICKS = 180; // 3.0 s since last damage
const LEASH_ARRIVE_RADIUS = 2.0; // m
const LEASH_RETURN_SPEED_MULT = 1.25;
const ALERT_DEAGGRO_TICKS = 360; // 6.0 s, alert -> wander (S4)
const CHASE_DEAGGRO_STALE_TICKS = 480; // 8.0 s, chase -> alert
const CHASE_DEAGGRO_RADIUS = 2.0; // m, "within 2.0 m of lastSeenX/Z"
const RECENT_DAMAGE_CONFIRM_TICKS = 60; // 1.0 s, S3's "damage in the last 1.0 s"
const WAKE_DELAY_CAP_TICKS = 30; // §4.6, min(30, ...)
const WAKE_DELAY_COEFF = 12; // §4.6, round(12 * d / aggroCloud)
const BLEED_RADIUS = 6.0; // m, cross-pack bleed

const DORMANT_WANDER_CADENCE_TICKS = 30; // §3.2 table
const ALERT_CADENCE_TICKS = 6; // §3.2 table
const CHASE_HOOK_CADENCE_TICKS = 6; // this file's own leash/de-aggro hook, matches chase's own cadence

const NOISE_RING_CAP = 4; // §4.5 throttle
const MELEE_HIT_LOUDNESS = 8.0;
const IMPACT_RADIUS_THRESHOLD = 2.0;
const IMPACT_SMALL_LOUDNESS = 10.0;
const IMPACT_LARGE_LOUDNESS = 14.0;
const NAMED_SKILL_LOUDNESS = 18.0;
const DEATH_LOUDNESS = 12.0;
const MOLGRIM_PHASE_LOUDNESS = 40.0;
const NAMED_LOUD_SKILLS = Object.freeze(
  new Set(['meteor', 'essence_burn', 'war_cry', 'thunder_step', 'crushing_slam', 'detonate']),
);

const MAX_PACKS = 32; // ASSIGNED — no spec cap on live packs; generous headroom, matches this project's fixed-cap convention
const MAX_PACK_MEMBERS = 16; // ASSIGNED — 06 §5.1 packs are 5-12; headroom above that

// ===========================================================================
// The perception store — a shared bag of parallel typed arrays, one slot per
// `poolIndex`, same convention `AiSystem`'s own `_brains` bag uses. Built
// once (`createPerceptionStore`), passed by reference into every function
// below, never rebuilt. Rule 5/6: zero allocation once built.
// ===========================================================================

/**
 * @param {number} maxBrains same cap `AiSystem` sizes its own `_brains` to.
 */
export function createPerceptionStore(maxBrains) {
  return {
    maxBrains,

    archIndex: new Int8Array(maxBrains).fill(-1),
    lastSeenX: new Float32Array(maxBrains),
    lastSeenZ: new Float32Array(maxBrains),
    lastSeenStep: new Int32Array(maxBrains).fill(-1),
    stateEnteredStep: new Int32Array(maxBrains).fill(-1),
    overLeashSinceStep: new Int32Array(maxBrains).fill(-1),
    wakeAtStep: new Int32Array(maxBrains).fill(-1),
    bled: new Uint8Array(maxBrains),
    packSlot: new Int32Array(maxBrains).fill(-1),
    nextDecisionStep: new Int32Array(maxBrains).fill(-1),
    chaseHookNextStep: new Int32Array(maxBrains).fill(-1),

    // Pack registry — small, bounded cardinality, mutated only at pack
    // registration (a rare, non-per-frame event), read from the hot path.
    packUsed: new Uint8Array(MAX_PACKS),
    packIdOfSlot: new Int32Array(MAX_PACKS).fill(-1),
    packCenterX: new Float32Array(MAX_PACKS),
    packCenterZ: new Float32Array(MAX_PACKS),
    packAggroCloud: new Float32Array(MAX_PACKS),
    packMemberCount: new Int32Array(MAX_PACKS),
    packMembers: new Int32Array(MAX_PACKS * MAX_PACK_MEMBERS), // holds actor IDs, ascending
    /** packId -> slot. Registration-time only (rare); every per-step read
     * goes through `packSlot`/`packIdOfSlot` (typed arrays), never this. */
    packIdToSlot: new Map(),

    // The 4-deep noise ring (§4.5).
    noiseX: new Float32Array(NOISE_RING_CAP),
    noiseZ: new Float32Array(NOISE_RING_CAP),
    noiseL: new Float32Array(NOISE_RING_CAP),
    noiseCount: 0,
    noiseRingStep: -1,

    /** `ai:pack-alert`'s payload — reused, mutated in place (`alertPack`'s
     * own contract row, `02-api-contracts.md` §12: `Alloc: no`). A fresh
     * object literal per call, the obvious implementation, would allocate
     * on every pack alert — the same class of bug `ARCHITECTURE.md`'s own
     * `EventBus.emit` section calls out. Matches `src/combat/resolve.js`'s
     * `env.damagePayload` / `env.deathPayload` precedent for a contracted,
     * `Alloc: no` event emission. */
    packAlertPayload: { packId: 0, x: 0, z: 0, memberCount: 0 },
  };
}

function ensureArchIndex(store, idx, actor) {
  if (store.archIndex[idx] !== -1) return;
  const i = ARCHETYPE_INDEX[actor.archetypeId];
  store.archIndex[idx] = i === undefined ? -1 : i;
}

// ===========================================================================
// Pack registration — not a `02-api-contracts.md`-contracted method (only
// `alertPack` is), so this is exported free functions, not an `AiSystem`
// method (rule 7: "a public method exists only if `02-api-contracts.md`
// lists it"). `./index.js` exposes the store as `ai._perception` for a test
// to call these directly, the same "reach into a private field for test
// setup" precedent `tests/ai/melee.test.js` already uses on `ctx._systems`.
// A real `spawnPack`/`PackDescriptor` pipeline is `06` §13's own later step,
// out of this ticket's scope — see the report.
// ===========================================================================

export function registerPack(store, packId, centerX, centerZ, aggroCloud) {
  let slot = store.packIdToSlot.get(packId);
  if (slot === undefined) {
    slot = -1;
    for (let i = 0; i < MAX_PACKS; i++) {
      if (!store.packUsed[i]) { slot = i; break; }
    }
    if (slot === -1) return -1; // capacity exceeded
    store.packUsed[slot] = 1;
    store.packMemberCount[slot] = 0;
    store.packIdOfSlot[slot] = packId;
    store.packIdToSlot.set(packId, slot);
  }
  store.packCenterX[slot] = centerX;
  store.packCenterZ[slot] = centerZ;
  store.packAggroCloud[slot] = aggroCloud;
  return slot;
}

/** Assigns `actor` to a registered pack: writes `actor.packId` (`ai` owns
 * pack bookkeeping — same "ai writes a plain Actor field directly" precedent
 * `./index.js#spawnOne` already sets for `actor.life`/`actor.baseXp`), and
 * inserts its id into the pack's member list in ascending order (§4.6's own
 * "in ascending actorId"). */
export function addPackMember(store, packId, actor) {
  const slot = store.packIdToSlot.get(packId);
  if (slot === undefined) return false;
  const count = store.packMemberCount[slot];
  if (count >= MAX_PACK_MEMBERS) return false;
  const base = slot * MAX_PACK_MEMBERS;
  let i = count;
  while (i > 0 && store.packMembers[base + i - 1] > actor.id) {
    store.packMembers[base + i] = store.packMembers[base + i - 1];
    i--;
  }
  store.packMembers[base + i] = actor.id;
  store.packMemberCount[slot] = count + 1;
  store.packSlot[actor.poolIndex] = slot;
  actor.packId = packId;
  return true;
}

// ===========================================================================
// §4.2 — the perception test, and §4.2's nav.raycastNav guard
// ===========================================================================

/** `nav`-grid line of walk, guarded for the not-yet-landed real method —
 * see this file's header. `Alloc: no`. */
export function navLineOfWalk(nav, ax, az, bx, bz) {
  if (typeof nav.raycastNav === 'function') return nav.raycastNav(ax, az, bx, bz);
  return fallbackLineOfWalk(nav, ax, az, bx, bz);
}

/** Conservative fixed-step sample walk over the PUBLIC `nav.walkable(x,z)`
 * — never `nav.grid.flags` directly. Step size is half the grid's own cell
 * size (or 0.25 m if the grid is unavailable) so no cell along the segment
 * can be skipped entirely. Not `smooth.js`'s exact corner-tie-safe
 * supercover DDA (that algorithm is private to `nav`, rule 2 forbids
 * importing it) — an independent, honestly-simpler implementation of the
 * same CONTRACT. `Alloc: no` — every local is a primitive number. */
function fallbackLineOfWalk(nav, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-6) return nav.walkable(ax, az);
  const grid = nav.grid;
  const step = grid && grid.cellSize ? grid.cellSize * 0.5 : 0.25;
  const n = Math.max(1, Math.ceil(dist / step));
  const invN = 1 / n;
  for (let i = 0; i <= n; i++) {
    const t = i * invN;
    if (!nav.walkable(ax + dx * t, az + dz * t)) return false;
  }
  return true;
}

function isUntargetable(actor) {
  return (actor.flags & ACTOR_FLAG_UNTARGETABLE) !== 0;
}

/**
 * §4.2, verbatim. `self`/`target` are `Actor` records; `selfIdx` is
 * `self.poolIndex` (for the cached `archIndex`). `target` is always the
 * player in this build (§4.7: no threat table, one hostile target) — the
 * caller is responsible for skipping `isUntargetable(target)` first.
 * `Fixed: Y`, `Alloc: no`. At most one `navLineOfWalk` call.
 */
export function sees(nav, self, selfIdx, target, store) {
  ensureArchIndex(store, selfIdx, self);
  const archIdx = store.archIndex[selfIdx];
  if (archIdx < 0) return false;

  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const d2 = dx * dx + dz * dz;

  const blind = (self.statusMask & BLINDED_BIT) !== 0;
  const r = AGGRO_RADIUS[archIdx] * (blind ? BLIND_FACTOR : 1.0);
  if (d2 > r * r) return false;

  const proxR = PROXIMITY_RADIUS[archIdx];
  if (d2 > proxR * proxR) {
    const dist = Math.sqrt(d2);
    const fx = Math.cos(self.facing);
    const fz = Math.sin(self.facing);
    const vx = dx / dist;
    const vz = dz / dist;
    const dot = fx * vx + fz * vz;
    if (dot < COS_HALF_ANGLE[archIdx]) return false;
  }

  return navLineOfWalk(nav, self.x, self.z, target.x, target.z);
}

// ===========================================================================
// §4.4 — leash. Called by `./index.js`, unconditionally, every step, for a
// brain currently in `chase`/`attack` (S15 is a top-priority "any but dead"
// edge, same class as S1/S17 — not decision-cadence gated).
// ===========================================================================

/** @returns {boolean} true if the leash fired this step (state is now
 * `reposition`). */
export function checkLeash(ctx, actor, idx, brains, store, BRAIN_STATE) {
  const packSlot = store.packSlot[idx];
  if (packSlot < 0) return false; // no pack context — nothing to leash home to

  ensureArchIndex(store, idx, actor);
  const archIdx = store.archIndex[idx];
  if (archIdx < 0) return false;
  const leashRadius = LEASH_RADIUS[archIdx];
  if (!Number.isFinite(leashRadius)) { store.overLeashSinceStep[idx] = -1; return false; } // §4.4 Boss row — molgrim never leashes

  const dx = actor.x - store.packCenterX[packSlot];
  const dz = actor.z - store.packCenterZ[packSlot];
  const d2 = dx * dx + dz * dz;
  const step = ctx.time.step;

  if (d2 <= leashRadius * leashRadius) {
    store.overLeashSinceStep[idx] = -1;
    return false;
  }
  if (store.overLeashSinceStep[idx] < 0) store.overLeashSinceStep[idx] = step;
  if (step - store.overLeashSinceStep[idx] < LEASH_DWELL_TICKS) return false;
  // `lastDamageStep` defaults to -1 ("never damaged") — treat that as
  // outside the grace window, never inside it (a monster that has never
  // been hit is not "recently damaged"; naively computing `step - (-1)`
  // would otherwise hold every never-damaged brain inside grace for the
  // sim's first 180 steps after boot).
  if (actor.lastDamageStep >= 0 && (step - actor.lastDamageStep) <= LEASH_DAMAGE_GRACE_TICKS) return false;

  brains.state[idx] = BRAIN_STATE.reposition;
  brains.targetId[idx] = 0;
  store.overLeashSinceStep[idx] = -1;
  store.stateEnteredStep[idx] = step;
  return true;
}

/**
 * The chase-side de-aggro rule (§4.4 prose, unnumbered): "a brain in chase
 * whose `lastSeenStep` is older than 8.0 s and whose position is within
 * 2.0 m of `lastSeenX/Z` falls to `alert`." Also the only place that keeps
 * `lastSeenX/Z/Step` current while chasing (melee.js's direct steering never
 * touches them). Own cadence (`chaseHookNextStep`), separate from
 * `brains.nextDecisionStep` (melee.js's own field — never shared, see file
 * header). Call AFTER `checkLeash` and only if the brain is still
 * `chase`/`attack` (leash may have just changed it).
 */
export function stepChaseHooks(ctx, actors, nav, actor, idx, brains, store, BRAIN_STATE) {
  const step = ctx.time.step;
  if (step < store.chaseHookNextStep[idx]) return;
  store.chaseHookNextStep[idx] = step + CHASE_HOOK_CADENCE_TICKS;

  const player = actors.player;
  if (!player || player.dead) return;

  if (navLineOfWalk(nav, actor.x, actor.z, player.x, player.z)) {
    store.lastSeenX[idx] = player.x;
    store.lastSeenZ[idx] = player.z;
    store.lastSeenStep[idx] = step;
    return;
  }

  if (brains.state[idx] !== BRAIN_STATE.chase) return; // the stale-position fall is defined for `chase` only
  if (store.lastSeenStep[idx] < 0) return;
  if (step - store.lastSeenStep[idx] < CHASE_DEAGGRO_STALE_TICKS) return;
  const dx = actor.x - store.lastSeenX[idx];
  const dz = actor.z - store.lastSeenZ[idx];
  if (dx * dx + dz * dz > CHASE_DEAGGRO_RADIUS * CHASE_DEAGGRO_RADIUS) return;

  brains.state[idx] = BRAIN_STATE.alert;
  brains.targetId[idx] = 0;
  store.stateEnteredStep[idx] = step;
}

// ===========================================================================
// §4.6 — aggro propagation. `alertPack` is the one `02-api-contracts.md`
// §12-contracted method this file backs (`ai.alertPack` forwards here).
// ===========================================================================

/** `ai.alertPack(packId, x, z)`, verbatim §4.6 ripple. Cross-pack bleed
 * (§4.6) is NOT performed here — it fires when each rippling member actually
 * WAKES (its own position, at that moment), not at the trigger's position —
 * see `wakeToAlert`/`bleedCrossPack` below and this file's report notes.
 * Emits `ai:pack-alert` exactly once per call (never per member — R1, broke
 * twice in M4). `Fixed: Y`, `Alloc: no`. */
export function alertPack(ctx, actors, store, brains, BRAIN_STATE, packId, x, z) {
  const slot = store.packIdToSlot.get(packId);
  if (slot === undefined) return;

  const step = ctx.time.step;
  const memberCount = store.packMemberCount[slot];
  const aggroCloud = store.packAggroCloud[slot];
  const base = slot * MAX_PACK_MEMBERS;

  for (let i = 0; i < memberCount; i++) {
    const actor = actors.byId(store.packMembers[base + i]);
    if (!actor || actor.dead) continue;
    const idx = actor.poolIndex;
    if (!brains.active[idx]) continue;
    const st = brains.state[idx];
    if (st !== BRAIN_STATE.dormant && st !== BRAIN_STATE.wander) continue;

    const dx = actor.x - x;
    const dz = actor.z - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const delay = Math.min(WAKE_DELAY_CAP_TICKS, Math.round((WAKE_DELAY_COEFF * d) / aggroCloud));
    store.wakeAtStep[idx] = step + delay;
  }

  const payload = store.packAlertPayload;
  payload.packId = packId;
  payload.x = x;
  payload.z = z;
  payload.memberCount = memberCount;
  ctx.events.emit('ai:pack-alert', payload);
}

/** A brain reaching `alert` — either because its own `wakeAtStep` arrived
 * (a ripple member, `allowBleed = true`) or because it perceived the player
 * directly (S2/S5, `allowBleed = false` — the direct-perception member's own
 * pack gets a full `alertPack` ripple instead, from the caller). */
function wakeToAlert(ctx, actors, store, brains, BRAIN_STATE, actor, idx, allowBleed) {
  const step = ctx.time.step;
  brains.state[idx] = BRAIN_STATE.alert;
  store.stateEnteredStep[idx] = step;
  if (allowBleed) bleedCrossPack(ctx, actors, store, brains, BRAIN_STATE, actor.x, actor.z, store.packSlot[idx]);
}

/** §4.6 "Cross-pack bleed": any DIFFERENT pack's dormant/wander, not-yet-
 * bled member within 6.0 m of `(x,z)` wakes immediately, flagged so it
 * cannot re-trigger (depth 1 — a bled member's OWN later wake never bleeds
 * again, see its `wakeToAlert(..., false)` call site). The flag resets when
 * the member returns to `dormant` (leash arrival), so a fresh encounter can
 * bleed it again. */
function bleedCrossPack(ctx, actors, store, brains, BRAIN_STATE, x, z, originSlot) {
  const step = ctx.time.step;
  for (let p = 0; p < MAX_PACKS; p++) {
    if (p === originSlot || !store.packUsed[p]) continue;
    const mc = store.packMemberCount[p];
    const base = p * MAX_PACK_MEMBERS;
    for (let i = 0; i < mc; i++) {
      const actor = actors.byId(store.packMembers[base + i]);
      if (!actor || actor.dead) continue;
      const idx = actor.poolIndex;
      if (store.bled[idx]) continue;
      const st = brains.state[idx];
      if (st !== BRAIN_STATE.dormant && st !== BRAIN_STATE.wander) continue;
      const dx = actor.x - x;
      const dz = actor.z - z;
      if (dx * dx + dz * dz > BLEED_RADIUS * BLEED_RADIUS) continue;
      store.bled[idx] = 1;
      store.wakeAtStep[idx] = step; // picked up by the unconditional wakeAtStep check next step
    }
  }
}

// ===========================================================================
// §4.5 — noise. `emitNoise` is called by the event listeners below;
// `processNoiseRing` is called once per `AiSystem.fixedUpdate`, before the
// brain loop.
// ===========================================================================

/** Appends one noise event to the 4-deep ring, throttled (§4.5: "a fifth in
 * the same step is dropped"). The ring is keyed to `step` so it self-resets
 * across a step boundary regardless of whether `emit` or `process` runs
 * first that step (subsystems fire in `static deps` order, not a fixed
 * relationship to `ai`). `Alloc: no`. */
export function emitNoise(store, x, z, L, step) {
  if (store.noiseRingStep !== step) {
    store.noiseRingStep = step;
    store.noiseCount = 0;
  }
  if (store.noiseCount >= NOISE_RING_CAP) return;
  const i = store.noiseCount++;
  store.noiseX[i] = x;
  store.noiseZ[i] = z;
  store.noiseL[i] = L;
}

/** §4.5's `onNoise`, applied to every accepted ring event this step against
 * every dormant/wander brain. `Alloc: no`. */
export function processNoiseRing(ctx, actors, brains, store, BRAIN_STATE) {
  const step = ctx.time.step;
  if (store.noiseRingStep !== step || store.noiseCount === 0) return;

  const live = actors.all;
  for (let e = 0; e < store.noiseCount; e++) {
    const ex = store.noiseX[e];
    const ez = store.noiseZ[e];
    const eL = store.noiseL[e];
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      const idx = a.poolIndex;
      if (idx >= store.maxBrains || !brains.active[idx]) continue;
      const st = brains.state[idx];
      if (st !== BRAIN_STATE.dormant && st !== BRAIN_STATE.wander) continue;

      ensureArchIndex(store, idx, a);
      const archIdx = store.archIndex[idx];
      if (archIdx < 0) continue;
      const r = Math.min(HEARING_RADIUS[archIdx], eL);
      const dx = a.x - ex;
      const dz = a.z - ez;
      if (dx * dx + dz * dz > r * r) continue;

      brains.state[idx] = BRAIN_STATE.alert;
      store.lastSeenX[idx] = ex;
      store.lastSeenZ[idx] = ez;
      store.lastSeenStep[idx] = step;
      store.stateEnteredStep[idx] = step;
      // targetRef is NOT set (§4.5: "the brain must still confirm by sight, S3") — brains.targetId[idx] untouched.
    }
  }
  store.noiseCount = 0;
}

// ===========================================================================
// Event listener bodies — wired by `./index.js#init` (`ctx.events.on(...)`).
// Real payload shapes, verified by reading the emitting code (`combat/
// resolve.js`, `combat/xp.js`), not ARCHITECTURE.md's summary table, which
// drifts from them (`actor:damage`'s `result` carries flat `pointX/Y/Z`,
// never a `.point` object; `actor:death`'s `point` IS an `{x,y,z}` object —
// two different shapes for the same word, checked directly, not assumed).
// ===========================================================================

/** `actor:damage` — §4.5 row 1 (melee-hit noise), §4.6's damage trigger, and
 * S17 (damage from a visible source overrides everything but dead). */
export function onActorDamage(ctx, actors, brains, store, BRAIN_STATE, payload) {
  const { target, source, result } = payload;
  if (!target || !result) return;
  const idx = target.poolIndex;
  if (idx == null || idx >= store.maxBrains || !brains.active[idx]) return;
  if (brains.state[idx] === BRAIN_STATE.dead) return;

  // §4.5 row 1 — a landed melee hit is a weapon action, loudness 8.0 m at
  // the impact point. `sourceSkillId === 'attack'` matches the only weapon-
  // action id any shipped brain emits today (`./brains/melee.js`'s
  // `emitRankerHit`) — see the report: `melee.js` never sets
  // `packet.originX/Y/Z`, so `result.pointX/Y/Z` is (0,0,0) for a Ranker's
  // own hit today, a pre-existing gap in a file this ticket cannot edit.
  if (result.total > 0 && result.sourceSkillId === 'attack') {
    emitNoise(store, result.pointX, result.pointZ, MELEE_HIT_LOUDNESS, ctx.time.step);
  }

  const packSlot = store.packSlot[idx];
  if (packSlot >= 0) {
    alertPack(ctx, actors, store, brains, BRAIN_STATE, store.packIdOfSlot[packSlot], target.x, target.z);
  }

  // S17 — "any but dead", damage from a visible source overrides S4/S15.
  // §4.7/O-88: never assign an `ACTOR_FLAG.untargetable` source as a target
  // (e.g. `echo_blade`, which `03-combat-math.md` §8.5 says "deals damage,
  // takes none" — a real, reachable damage source this check must skip).
  if (source && !source.dead && !isUntargetable(source)) {
    const nav = ctx.get('nav');
    if (navLineOfWalk(nav, target.x, target.z, source.x, source.z)) {
      brains.state[idx] = BRAIN_STATE.chase;
      brains.targetId[idx] = source.id;
      brains.attackReadyStep[idx] = ctx.time.step;
      brains.nextDecisionStep[idx] = ctx.time.step;
      store.overLeashSinceStep[idx] = -1;
      store.stateEnteredStep[idx] = ctx.time.step;
    }
  }
}

/** `actor:death` — §4.5 row 5 (12 m) and §4.6's death trigger. */
export function onActorDeath(ctx, actors, brains, store, BRAIN_STATE, payload) {
  const dead = payload.actor;
  if (!dead) return;
  const point = payload.point;
  const x = point ? point.x : dead.x;
  const z = point ? point.z : dead.z;
  emitNoise(store, x, z, DEATH_LOUDNESS, ctx.time.step);

  const idx = dead.poolIndex;
  if (idx == null || idx >= store.maxBrains || !brains.active[idx]) return;
  const packSlot = store.packSlot[idx];
  if (packSlot >= 0) {
    alertPack(ctx, actors, store, brains, BRAIN_STATE, store.packIdOfSlot[packSlot], x, z);
  }
}

/** `skill:impact` — §4.5 rows 2-4. No landed `skills` ticket emits this
 * event yet (checked: `grep -rn "events.emit('skill:impact'" src/skills/`
 * has zero hits) — wired defensively so it activates the moment one does;
 * exercised in this ticket's own tests via a synthetic emit. */
export function onSkillImpact(ctx, store, payload) {
  const point = payload.point;
  if (!point) return;
  const loud = NAMED_LOUD_SKILLS.has(payload.skillId)
    ? NAMED_SKILL_LOUDNESS
    : (payload.radius >= IMPACT_RADIUS_THRESHOLD ? IMPACT_LARGE_LOUDNESS : IMPACT_SMALL_LOUDNESS);
  emitNoise(store, point.x, point.z, loud, ctx.time.step);
}

/** `boss:phase` — §4.5's Molgrim phase-transition row (40 m). No boss
 * ticket has landed (`ai.spawnBoss` is unimplemented, per `./index.js`'s own
 * header), so this is equally unexercised by real gameplay today — same
 * "wired, defensive, tested synthetically" status as `onSkillImpact`. */
export function onBossPhase(ctx, store, payload) {
  const actor = payload.actor;
  if (!actor) return;
  emitNoise(store, actor.x, actor.z, MOLGRIM_PHASE_LOUDNESS, ctx.time.step);
}

// ===========================================================================
// The per-brain step — dormant / wander / alert / reposition. Called by
// `./index.js#fixedUpdate` for any brain whose `state` is one of these four.
// `chase`/`attack` never reach here (`./brains/melee.js`'s territory, hooked
// separately via `checkLeash`/`stepChaseHooks` above).
// ===========================================================================

function confirmChase(ctx, brains, idx, target, BRAIN_STATE) {
  const step = ctx.time.step;
  brains.targetId[idx] = target.id;
  brains.state[idx] = BRAIN_STATE.chase;
  brains.attackReadyStep[idx] = step;
  brains.nextDecisionStep[idx] = step;
}

/**
 * @returns {boolean} true if a real decision ran this step (matches
 * `stepMeleeBrain`'s own return contract, feeding `AiSystem.stats.decisions`).
 */
export function stepPerceptionBrain(ctx, actors, nav, actor, idx, brains, store, BRAIN_STATE) {
  const step = ctx.time.step;
  ensureArchIndex(store, idx, actor);
  const state = brains.state[idx];

  if (state === BRAIN_STATE.reposition) {
    return stepLeashReturn(ctx, actors, actor, idx, brains, store, BRAIN_STATE);
  }

  // Pack-ripple wake — unconditional, every step (S2's "pack activated"
  // path), not decision-cadence gated, same class as S1/S17.
  if (store.wakeAtStep[idx] >= 0 && step >= store.wakeAtStep[idx]) {
    const allowBleed = store.bled[idx] === 0;
    store.wakeAtStep[idx] = -1;
    wakeToAlert(ctx, actors, store, brains, BRAIN_STATE, actor, idx, allowBleed);
    return true;
  }

  const player = actors.player;

  if (state === BRAIN_STATE.alert) {
    if (step < store.nextDecisionStep[idx]) return false;
    store.nextDecisionStep[idx] = step + ALERT_CADENCE_TICKS;

    if (player && !player.dead && !isUntargetable(player)) {
      const recentDamage = actor.lastDamageStep >= 0 && (step - actor.lastDamageStep) <= RECENT_DAMAGE_CONFIRM_TICKS;
      if (recentDamage || sees(nav, actor, idx, player, store)) {
        confirmChase(ctx, brains, idx, player, BRAIN_STATE);
        return true;
      }
    }
    if (step - store.stateEnteredStep[idx] >= ALERT_DEAGGRO_TICKS) { // S4
      brains.state[idx] = BRAIN_STATE.wander;
      store.stateEnteredStep[idx] = step;
    }
    return true;
  }

  // dormant or wander — S2/S5, identical shape.
  if (step < store.nextDecisionStep[idx]) return false;
  store.nextDecisionStep[idx] = step + DORMANT_WANDER_CADENCE_TICKS;

  if (player && !player.dead && !isUntargetable(player) && sees(nav, actor, idx, player, store)) {
    wakeToAlert(ctx, actors, store, brains, BRAIN_STATE, actor, idx, false); // this pack gets a full ripple below, not a bleed
    store.lastSeenX[idx] = player.x;
    store.lastSeenZ[idx] = player.z;
    store.lastSeenStep[idx] = step;
    const packSlot = store.packSlot[idx];
    if (packSlot >= 0) {
      alertPack(ctx, actors, store, brains, BRAIN_STATE, store.packIdOfSlot[packSlot], actor.x, actor.z);
    }
  }
  return true;
}

/** §4.4's leash-return submode (`targetRef.id === 0 && desiredRange === 0`).
 * Direct steering at pack centre, no `nav` path — same "direct steering, no
 * nav" scope `./brains/melee.js` already established for M2; full A*-ring
 * leash routing is `06` §13's nav-integration step, out of this ticket (see
 * the report). Movement every step (never cadence-gated — "movement runs
 * every step regardless of cadence", §3.2). Return-speed multiplier
 * (`runSpeed × 1.25`) is applied directly to the manual displacement below,
 * NEVER through `actors.moveSpeed()` — see the report on O-87:
 * `computeMoveSpeed` ignores archetype/StatBlock entirely and returns a flat
 * 4.2 m/s for everyone, so routing through it would silently discard both
 * the archetype's real `runSpeed` AND this 1.25× multiplier. `./brains/
 * melee.js#moveTowards` already avoids it for the same reason — this
 * function matches that established pattern, not `actors.moveSpeed()`. */
function stepLeashReturn(ctx, actors, actor, idx, brains, store, BRAIN_STATE) {
  const packSlot = store.packSlot[idx];
  if (packSlot < 0) {
    brains.state[idx] = BRAIN_STATE.dormant; // no pack context to leash home to — fail safe in place
    return true;
  }

  const cx = store.packCenterX[packSlot];
  const cz = store.packCenterZ[packSlot];
  const dx = cx - actor.x;
  const dz = cz - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist <= LEASH_ARRIVE_RADIUS) {
    brains.state[idx] = BRAIN_STATE.dormant;
    store.wakeAtStep[idx] = -1;
    store.bled[idx] = 0; // §4.6 depth-1 flag resets — a fresh encounter can bleed this member again
    store.overLeashSinceStep[idx] = -1;
    store.nextDecisionStep[idx] = -1;
    store.stateEnteredStep[idx] = ctx.time.step;
    return true;
  }

  const archIdx = store.archIndex[idx];
  const runSpeed = archIdx >= 0 ? RUN_SPEED[archIdx] : 0;
  const speed = runSpeed * LEASH_RETURN_SPEED_MULT;
  if (dist > 1e-6) {
    const inv = (speed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, cx, cz, TURN_RATE);
  return false; // movement only — matches melee.js's own "off-cadence movement is not a decision"
}
