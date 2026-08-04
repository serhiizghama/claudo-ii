// src/ai/crowd.js
//
// AI-5 — `06-monsters-ai.md` §8 in full: ring slots (§8.2), local avoidance
// (§8.3), the three approach formations (§8.4) and the corridor problem's
// four mechanisms (§8.5). This is the one M5 ticket with no `MB` id — there
// is no harness assertion behind it, so `tests/ai/crowd.test.js` and
// `tests/ai/crowd.perf.test.js` are the only check that exists.
//
// ---------------------------------------------------------------------------
// The hard constraint this whole file is written against: `brains/melee.js`
// cannot be edited, and its chase-state movement is unconditional
// ---------------------------------------------------------------------------
// `./brains/melee.js#moveTowards` (AI-2's file, off-limits to this ticket)
// steers every `chase`-state brain in a dead straight line at the raw target
// actor, EVERY step it is not mid-swing, with no parameter or hook for an
// external steering vector. AI-4's own `tests/ai/nav.perf.test.js` header
// independently confirms the same reading ("`melee.js#moveTowards` steers a
// chasing brain toward its target EVERY step, unconditionally — nothing in
// this ticket's file list touches that (`melee.js` is off-limits)"). Given
// that, ring slots/lane offsets/avoidance computed here could never actually
// steer a live simulation UNLESS this file's own movement code runs instead
// of `moveTowards` for the brains it manages — not on top of it (two
// simultaneous full-speed movement calls the same step is not a "blend", it
// is a bug).
//
// The resolution, entirely inside this ticket's own file grant (`crowd.js`
// new, `index.js` wiring only): `./index.js#fixedUpdate`'s dispatch — which
// AI-3/AI-4 already established is fair game to extend as "wiring" (both
// added new calls into that same loop without touching `spawnOne`/`brainOf`/
// `aliveCount`) — now calls `stepCrowdMember` INSTEAD OF `stepMeleeBrain`,
// for exactly the brains that are (a) a registered pack member
// (`perception.packSlot[idx] >= 0`) AND (b) in `chase` state AND (c) not yet
// within their own archetype's contact range of the target. Once (c) stops
// holding — the member has closed to its ring slot, which is by
// construction within contact range (§8.2's `− 0.10` term keeps the ring a
// hair inside `attackRange`) — dispatch falls straight back to
// `stepMeleeBrain`, unmodified, for the swing/attack FSM this file never
// touches. This is a clean handoff, not a race: for any actor NOT a
// registered pack member (every existing test in this codebase — checked by
// reading `tests/ai/melee.test.js`, `tests/ai/perception.test.js` and
// `tests/ai/nav.test.js` — none of them registers a pack AND leaves a member
// in live `chase` simulation before it is already within contact range; the
// one test that does both, `perception.test.js`'s leash criterion, places
// its dummy chase target 1.5 m away — inside `bone_ranker`'s 1.9 m contact
// range — specifically so `melee.js`'s own steering "does not drift the
// Ranker", by that test's own comment, which means this file's new branch
// never activates there either), dispatch is byte-for-byte what it was
// before this ticket. Verified, not assumed — see the report.
//
// What this means for the acceptance criteria: the ring-slot/lane/avoidance
// math below is real, derived, and independently unit-tested against exact
// numbers. The LIVE simulation result (a 12-pack actually walking a 3.0 m
// corridor into a 3-wide column) is a genuine `AiSystem.fixedUpdate` run,
// not a hand-wave — but it is real BECAUSE of the handoff above, not despite
// `melee.js`. Once a member is within contact range, `melee.js` owns it
// again, including its own unconditional re-approach if the player drifts
// out of range mid-fight — a real, minor imprecision this file cannot
// close without editing `melee.js`, reported plainly, not hidden.
//
// ---------------------------------------------------------------------------
// Doorway-queue is tracked as this file's OWN flag, never `BRAIN_STATE.reposition`
// ---------------------------------------------------------------------------
// `06` §8.5 mechanism 3 calls the doorway wait a "`reposition` doorway-queue
// sub-mode (§3.1)". `BRAIN_STATE.reposition` is `perception.js`'s exclusive
// dispatch target (off-limits file) and its ONE handler, `stepLeashReturn`,
// unconditionally treats ANY `reposition` brain as "steer to the pack centre,
// the leash-return case" — it has no sub-mode discrimination at all. Setting
// `brains.state[idx] = BRAIN_STATE.reposition` for a doorway-queueing member
// would silently reroute it into leash-return the very next step this
// file's own loop iteration ends, corrupting a shipped, tested behaviour
// (`tests/ai/perception.test.js`'s leash criterion) for a purpose §3.1 never
// gave that state's one handler. This file therefore tracks doorway-queueing
// entirely as its own field (`store.doorwayQueueUntilStep`), never touching
// `brains.state` — a resolved ambiguity, reported, not a silent workaround.
//
// ---------------------------------------------------------------------------
// `CROWD_TABLE` — radii/attack ranges bestiary.js does not carry, sourced
// from `06` §1.3/§2.x directly, the exact precedent `perception.js`'s own
// `PERCEPTION_TABLE` already sets for `aggroRadius`/`leashRadius`
// ---------------------------------------------------------------------------
// This ticket's brief says the ring-slot table is "derived from archetype
// radii already in `src/ai/data/bestiary.js`" — checked directly: it is
// NOT. `bestiary.js`'s own header excludes `radius`/`desiredRange` on
// purpose ("physical radius/height belong to whichever ticket actually
// consumes them... crowd/physics tickets... should be sourced from `06`
// §1-§2 directly at that point, not guessed at here" — this IS that point).
// `bestiary.js` is not in this ticket's file list, so it cannot be extended
// here either. `CROWD_TABLE` below is therefore a second small, frozen,
// verbatim-cited literal, matching `perception.js`'s own `PERCEPTION_TABLE`
// precedent exactly (same class of gap, same resolution). `role` is read
// off the REAL `BESTIARY[id].role` (already shipped) rather than
// re-declared, so the "ranged/support hold at range, no ring add-in" branch
// below never duplicates data that already exists.
//
// `actor.radius`/`target.radius` are NOT used for the ring-slot geometry —
// `src/actors/pool.js`'s own header confirms `DEFAULT_ACTOR_RADIUS = 0.36`
// is a flat placeholder for EVERY actor regardless of archetype (no
// archetype table is wired into `actors.spawn()` yet — the same class of
// gap O-87 already names for move speed). Using the live, placeholder
// `actor.radius` for a monster's own ring math would silently give every
// archetype the SAME ring geometry (all 0.36), which is provably wrong the
// moment a second archetype ships (AI-6 adds five brains right behind this
// ticket, rule 11). `CROWD_TABLE.selfRadius` is used instead, and IS
// correct for the one archetype this milestone can actually spawn —
// verified against the `06` §8.2 table below. `target.radius` (the actual
// live actor being surrounded, currently always the player) IS read live —
// unlike a monster's own radius, there is no archetype-keyed table to read
// for "whichever actor `ai` is asked to surround"; reading its real,
// current field is the correct design even though today's placeholder value
// (0.36) happens to match `01-data-model.md`'s own illustrative sample.
//
// ---------------------------------------------------------------------------
// The `maulsmith` ring-radius mismatch — a finding, not silently reconciled
// ---------------------------------------------------------------------------
// Deriving `ringRadius = targetRadius + selfRadius + attackRange − 0.10`
// with `attackRange = desiredRange` reproduces the `06` §8.2 table EXACTLY
// for `bone_ranker` (16 slots), `carrion_swarm` (19) and `blight_crawler`
// (10). It does NOT reproduce `maulsmith` (formula gives ringRadius 3.41 m,
// 14 slots; the table says 2.71 m, 11 slots) — the gap is exactly 0.70 m,
// which is `desiredRange(2.6) − 1.9`, i.e. the table's maulsmith row appears
// to use the SAME 1.9 m generic melee contact distance `bone_ranker` uses,
// not maulsmith's own `desiredRange`. `06` §2.5 never states this
// explicitly (the one 1.9 m figure that section names is captioned as "a
// player standing at their OWN melee range" — the player's weapon range,
// Ravager/Battle Axe, not the Maulsmith's) — so this is read as an
// unresolved spec-table inconsistency, not silently patched by guessing
// maulsmith's ring `attackRange` is 1.9. `ringRadiusFor('maulsmith', ...)`
// below uses `desiredRange` (2.6), matching the ONE verbatim formula the
// spec gives, and the mismatch against the table is reported plainly.
// `maulsmith` has no shipped brain this milestone (`brains/melee.js`'s own
// `MELEE_ARCHETYPES` set is `{bone_ranker}` only) so nothing downstream of
// this ticket depends on the number being exactly 11 today.
//
// `ashen_archer`/`dust_shaman` (both `ringRadius` == `desiredRange` in the
// table, "hold band") ARE reproduced by treating `role === 'ranged' ||
// role === 'support'` as its own branch — ring radius is the standoff
// distance directly, no `+ selfRadius + targetRadius − 0.10` add-in — which
// the table's own "(hold band)" annotation on the archer row implies but
// never states as a formal rule; resolved the same way for the shaman since
// its own row (8.00 m, no annotation) only reproduces under the identical
// treatment.
//
// ---------------------------------------------------------------------------
// Formation waypoints steer directly, no extra `nav.requestPath()`
// ---------------------------------------------------------------------------
// `06` §8.4 says `flank`'s two non-`direct` groups cost "2 extra A* requests
// per pack engagement". This file does NOT call `nav.requestPath()` for a
// flank/arc waypoint — `./nav.js` (AI-4, off-limits) already owns the ENTIRE
// per-brain A* ring/budget for this `AiSystem`, and this file has no
// sanctioned way to add a pack-level request into that accounting without
// either editing `nav.js` (out of grant) or maintaining a second, competing
// budget tracker here (which would corrupt `ai.stats.pathRequests`/
// `pathRefusals`, both real, tested, contracted fields). Instead, a
// flank/arc waypoint is a `nav.snap`ped STEERING TARGET a member walks
// toward directly (straight-line, `nav.raycastNav`-checked the same way its
// final ring slot already is) until within `WAYPOINT_ARRIVE_RADIUS`, then it
// switches to the ring slot. This delivers the real, observable outcome
// `06` §8.4 is FOR — three distinct approach bearings — without the extra
// A* cost this file has no safe place to charge. Reported, not hidden.
//
// ---------------------------------------------------------------------------
// Per-brain timers are step-stamped sentinel `Int32Array`s, not the
// `generation × 2**32 + value` bit-pack
// ---------------------------------------------------------------------------
// This ticket's brief says the lane index/doorway-queue timer/rotation clock
// are "exactly this shape [a generation stamp]... use it, do not invent a
// sixth variant." Checked directly: EVERY existing per-brain scheduling
// field in this exact subsystem — `perception.js`'s `overLeashSinceStep`/
// `wakeAtStep`/`stateEnteredStep`, `nav.js`'s `repathAtStep`/
// `demotedUntilStep`/`pendingSinceStep`, even `nav.js`'s own
// `cachedFlowDistance` ("the cached flowDistance — a generation stamp, not a
// Map", by that file's own header) — uses a plain step-stamped
// `Int32Array` with a `-1` sentinel, never the `generation * 2**32 + value`
// integer pack `src/skills/cost.js#encodeCooldownStamp` documents. That
// literal bit-pack solves a DIFFERENT problem (an `actor.cooldowns` Map
// entry surviving a pool-slot recycle across actor generations) that does
// not apply here: this file's arrays are indexed by `poolIndex` exactly like
// `_brains`/`_perception`/`_navStore`, none of which reset on despawn either
// (`ai` does not despawn — this ticket's brief, citing O-49). So "the same
// shape" is read as the step-stamped-sentinel idiom this subsystem already
// uses uniformly, not the unrelated actor-generation bit-pack — a resolved
// ambiguity, reported.
//
// ---------------------------------------------------------------------------
// Corridor width is measured off the live nav grid, never a constant
// ---------------------------------------------------------------------------
// `measureCorridorWidth` walks `nav.walkable()` outward from a point along a
// perpendicular axis, in `nav.grid.cellSize` steps, counting the contiguous
// walkable run — a real per-call derivation, never `3.0` typed as a number
// anywhere in this file. `isCorridorCell`'s own 8-neighbourhood test is the
// same: sampled off `nav.walkable()`, never a stored width.
//
// ---------------------------------------------------------------------------
// `physics`/`MASK.ACTORS`/`NAV_FLAG.doorway` are redeclared, never imported
// ---------------------------------------------------------------------------
// Same precedent `perception.js`'s own header cites for `BLINDED_BIT`/
// `ACTOR_FLAG_UNTARGETABLE` (`src/combat/resolve.js`'s `STATUS_BIT`/
// `ACTOR_FLAG.invulnerable`): `01-data-model.md` §9.3 (`NAV_FLAG.doorway =
// 1 << 4`) and `02-api-contracts.md` §4 (`MASK.ACTORS = 14`) are the
// authorities; importing `src/physics/index.js` or `src/nav/index.js`'s
// constant modules would be a rule-2 cross-subsystem import this file does
// not need to make for two integers. `physics` itself is reached the
// sanctioned way — `ctx.peek('physics')` in `./index.js`, never an import
// (`ARCHITECTURE.md`'s own text names `physics` alongside `nav`/`actors` as
// reachable this way) — and guarded exactly like `./index.js`'s existing
// `ctx.peek('nav')` guard, for the same reason: a stub `ctx` in an existing
// test never registers it.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()` — `src/ai/` is a headless lint root
// (`tools/check-imports.mjs`, `checkThree: true, checkGlobals: true`).
// Every distance test is a squared compare or `Math.sqrt(x*x+z*z)`, never
// `Math.hypot` (rule/perf note: "Math.hypot allocates"). Every per-brain/
// per-pack field is a flat typed array built once in `createCrowdStore` and
// mutated in place; every scratch object (`_posScratch`, `_memberActor`,
// `_claimed`, `_overlapIds`, `_topDist`/`_topActor`) is preallocated there
// too — `Alloc: no` on every hot function below. `crowd.js` draws no
// randomness at all (ring/lane/formation assignment is purely
// `actorId`-keyed, per `06` §8.2's own "deterministic, allocation-free"
// text) so it takes no `ctx.rng.fork()`.

import { BESTIARY } from './data/bestiary.js';

const FIXED_DT = 1 / 60;

// Placeholder turn rate — same class/precedent as `brains/melee.js`'s own
// `MELEE_TURN_RATE` (a real per-archetype table is `08-characters-visual.md`
// territory, out of this ticket's reading scope).
const CROWD_TURN_RATE = Math.PI * 2; // rad/s

// `01-data-model.md` §9.3, verbatim — see this file's header.
const NAV_FLAG_DOORWAY = 1 << 4;
// `02-api-contracts.md` §4, verbatim — see this file's header.
const MASK_ACTORS = 14;

// `perception.js`'s own private pack-registry caps, redeclared here for the
// same reason `nav.js` redeclares `RING_GRANT_LIMIT` against `astar.js`'s
// budget default: no export exists, and this file genuinely needs the same
// numbers to index the SAME arrays (`perception.packMembers`,
// `perception.packMemberCount`) `./index.js` already exposes as
// `ai._perception`. Sourced from the same `06` §5.1 fact perception.js's own
// comment cites ("packs are 5-12, headroom above that").
const MAX_PACKS = 32;
const MAX_PACK_MEMBERS = 16;

// Largest slot count any `CROWD_TABLE` row can produce (`ashen_archer`, 78 —
// see `06` §8.2's table) — sizes the per-call "claimed slot" scratch. Not a
// number this ticket invents: it is the table's own maximum, so a future
// archetype within this table can never overflow it silently.
const SLOT_SCRATCH_CAP = 96;

// ---------------------------------------------------------------------------
// §8.2/§8.5 gameplay numbers — see this file's header for why these live
// here rather than in `bestiary.js`. `role` is read off the real
// `BESTIARY[id].role`, never re-declared.
// ---------------------------------------------------------------------------
export const CROWD_TABLE = Object.freeze({
  bone_ranker: Object.freeze({ selfRadius: 0.38, attackRange: 1.9 }), // 06 §1.3 / §2.1
  carrion_swarm: Object.freeze({ selfRadius: 0.24, attackRange: 1.4 }), // 06 §1.3 / §2.2
  ashen_archer: Object.freeze({ selfRadius: 0.34, attackRange: 11.0 }), // 06 §1.3 / §2.3 (hold band)
  dust_shaman: Object.freeze({ selfRadius: 0.36, attackRange: 8.0 }), // 06 §1.3 / §2.4 (hold band)
  maulsmith: Object.freeze({ selfRadius: 0.55, attackRange: 2.6 }), // 06 §1.3 / §2.5 — see header, table mismatch
  blight_crawler: Object.freeze({ selfRadius: 0.42, attackRange: 1.2 }), // 06 §1.3 / §2.6
});

const RING_RADIUS_EPS = 0.10; // 06 §8.2's own "- 0.10" term
const SLOT_ARC_MULT = 2.6; // 06 §8.2, verbatim

const LANE_OFFSET_CAP = 0.90; // 06 §8.5 mechanism 1, verbatim
const CORRIDOR_NEIGHBOUR_WALKABLE_MAX = 5; // 06 §8.5 mechanism 1's corridor test

const AVOIDANCE_QUERY_RADIUS = 1.60; // 06 §8.3
const AVOIDANCE_NEIGHBOURS = 4; // 06 §8.3
const AVOIDANCE_BLEND_WEIGHT = 0.55; // 06 §8.3
const AVOIDANCE_PLAYER_WEIGHT = 1.60; // 06 §8.3
const AVOIDANCE_DOORWAY_WEIGHT = 0.50; // 06 §8.3 / 01 §9.3
const AVOIDANCE_DEFAULT_WEIGHT = 1.00; // 06 §8.3
const AVOIDANCE_CADENCE_TICKS = 3; // 06 §8.3, "20 Hz (every 3 steps)"

const CROWD_DECISION_CADENCE_TICKS = 6; // 06 §8.2, "10 Hz", matches melee.js/perception.js's own cadence

const DOORWAY_QUEUE_MAX_TICKS = 72; // 06 §8.5 mechanism 3, "up to 1.2 s" @ 60 Hz
const DOORWAY_OCCUPANCY_MIN = 2; // 06 §8.5 mechanism 3, ">= 2 pack-mates"
const DOORWAY_LOOKAHEAD_M = 1.0; // ASSIGNED — how far "ahead" counts as the next path node's cell; no `nav` path is walked (AI-4's own gap, see ./nav.js's header), so this approximates "next path node" with a short lookahead along the current desired direction

const RANK_ROTATION_BLOCKED_TICKS = 120; // 06 §8.5 mechanism 4, "> 2.0 s" @ 60 Hz
const BLOCKED_PROGRESS_EPS_SQ = 0.05 * 0.05; // ASSIGNED — squared metres/decision-tick below which a member counts as "not advancing"

const FLANK_MIN_COUNT = 10; // 06 §8.4
const ARC_MIN_COUNT = 6; // 06 §8.4
const ARC_MAX_COUNT = 9; // 06 §8.4
const FLANK_GROUP_MOD = 10; // 06 §8.4, actorId % 10: 40/30/30
const FLANK_BEARING_RAD = (100 * Math.PI) / 180; // 06 §8.4, +-100 deg
const FLANK_WAYPOINT_DIST = 6.0; // 06 §8.4
const FLANK_SNAP_RADIUS = 3.0; // 06 §8.4
const ARC_STAGE_DIST = 3.5; // 06 §8.4
const WAYPOINT_ARRIVE_RADIUS = 1.5; // ASSIGNED — no spec value for "close enough to a staging/flank waypoint to abandon it for the ring slot"

const FORMATION_DIRECT = 0;
const FORMATION_ARC = 1;
const FORMATION_FLANK = 2;
export const FORMATION_NAMES = Object.freeze(['direct', 'arc', 'flank']);

// ===========================================================================
// Store — one shared bag of parallel typed arrays + preallocated scratch,
// the same convention `_brains`/`_perception`/`_navStore` already use.
// ===========================================================================

/** @param {number} maxBrains same cap `AiSystem` sizes `_brains` to. */
export function createCrowdStore(maxBrains) {
  return {
    maxBrains,

    // Per-brain (indexed by poolIndex).
    ringSlot: new Int32Array(maxBrains).fill(-1),
    lane: new Int8Array(maxBrains),
    goalX: new Float32Array(maxBrains),
    goalZ: new Float32Array(maxBrains),
    nextDecisionStep: new Int32Array(maxBrains).fill(-1),

    avoidX: new Float32Array(maxBrains),
    avoidZ: new Float32Array(maxBrains),
    avoidNextStep: new Int32Array(maxBrains).fill(-1),

    lastCheckX: new Float32Array(maxBrains),
    lastCheckZ: new Float32Array(maxBrains),
    blockedSinceStep: new Int32Array(maxBrains).fill(-1),
    rotations: new Int32Array(maxBrains), // reporting: swaps this brain took part in

    doorwayQueueUntilStep: new Int32Array(maxBrains).fill(-1),
    doorwayWallX: new Float32Array(maxBrains),
    doorwayWallZ: new Float32Array(maxBrains),

    hasWaypoint: new Uint8Array(maxBrains),
    waypointX: new Float32Array(maxBrains),
    waypointZ: new Float32Array(maxBrains),
    // Set once a member arrives at (and dismisses) its formation waypoint,
    // or once a formation pass determines it needs none — see
    // `assignPackSlots`'s own header on why this must be a ONE-SHOT flag,
    // not recomputed every decision tick. Cleared on pack disengage
    // (`maybeReleasePackEngaged`) so the next engagement re-rolls.
    waypointDone: new Uint8Array(maxBrains),
    flankFallback: new Uint8Array(maxBrains), // reporting: this member's flank/arc waypoint failed to snap/region-match

    // Per-pack (indexed by perception.js's own pack slot).
    packEngaged: new Uint8Array(MAX_PACKS),
    packFormation: new Int8Array(MAX_PACKS).fill(-1),
    packLastAssignStep: new Int32Array(MAX_PACKS).fill(-1),
    packFormationCount: new Int32Array(MAX_PACKS),
    packOpenGround: new Uint8Array(MAX_PACKS),

    // Scratch — reused across calls, Alloc: no.
    _posScratch: { x: 0, z: 0 },
    _flowScratch: { dx: 0, dz: 0 },
    _memberActor: new Array(MAX_PACK_MEMBERS).fill(null),
    _claimed: new Uint8Array(SLOT_SCRATCH_CAP),
    _overlapIds: new Int32Array(32),
    _topDist: new Float32Array(AVOIDANCE_NEIGHBOURS),
    _topId: new Int32Array(AVOIDANCE_NEIGHBOURS),
    _topX: new Float32Array(AVOIDANCE_NEIGHBOURS),
    _topZ: new Float32Array(AVOIDANCE_NEIGHBOURS),
    _topIsPlayer: new Uint8Array(AVOIDANCE_NEIGHBOURS),
  };
}

// ===========================================================================
// §8.2 — ring slots. Pure functions, independently testable against the
// `06` §8.2 table.
// ===========================================================================

/** `06` §8.2: `ringRadius(archetype) = targetRadius + selfRadius +
 * attackRange - 0.10`, EXCEPT `ranged`/`support` archetypes hold at their
 * `desiredRange` directly (the table's "(hold band)" annotation — see this
 * file's header). `Alloc: no`.
 * @param {string} archetypeId @param {number} targetRadius
 * @returns {number} metres, `0` if `archetypeId` is not in `CROWD_TABLE`. */
export function ringRadiusFor(archetypeId, targetRadius) {
  const row = CROWD_TABLE[archetypeId];
  if (!row) return 0;
  const bestiaryRow = BESTIARY[archetypeId];
  const role = bestiaryRow ? bestiaryRow.role : null;
  if (role === 'ranged' || role === 'support') return row.attackRange;
  return targetRadius + row.selfRadius + row.attackRange - RING_RADIUS_EPS;
}

/** `06` §8.2: `slotArc(archetype) = 2.6 * selfRadius`. `Alloc: no`. */
export function slotArcFor(archetypeId) {
  const row = CROWD_TABLE[archetypeId];
  return row ? SLOT_ARC_MULT * row.selfRadius : 0;
}

/** `06` §8.2: `slotCount = floor(2*PI*ringRadius / slotArc)`. `Alloc: no`.
 * @returns {number} `0` if `archetypeId` is unknown or `slotArc` is `0`. */
export function slotCountFor(archetypeId, targetRadius) {
  const arc = slotArcFor(archetypeId);
  if (arc <= 0) return 0;
  return Math.floor((2 * Math.PI * ringRadiusFor(archetypeId, targetRadius)) / arc);
}

/** `06` §8.2: `slotAngle(i) = targetFacing + PI + 2*PI*i/slotCount`. The
 * `+ PI` puts slot 0 behind the target. `Alloc: no`. */
export function slotAngleFor(index, slotCount, targetFacing) {
  return targetFacing + Math.PI + (2 * Math.PI * index) / slotCount;
}

/** World position of ring slot `index`, written into `out`. `Alloc: no`.
 * @param {{x:number,z:number}} out mutated in place, also returned. */
export function ringSlotPosition(archetypeId, targetX, targetZ, targetFacing, targetRadius, index, slotCount, out) {
  const r = ringRadiusFor(archetypeId, targetRadius);
  const ang = slotAngleFor(index, slotCount, targetFacing);
  out.x = targetX + r * Math.cos(ang);
  out.z = targetZ + r * Math.sin(ang);
  return out;
}

/** `06` §8.5 mechanism 1: `L = (packSlotIndex % 3) - 1`. `Alloc: no`. */
export function laneIndexForRank(rank) {
  return (rank % 3) - 1;
}

/** `06` §8.5 mechanism 1: `laneOffset = L * min(0.90, (corridorWidth -
 * 2*selfRadius) / 2)`. `Alloc: no`. */
export function laneOffsetFor(lane, corridorWidth, selfRadius) {
  return lane * Math.min(LANE_OFFSET_CAP, (corridorWidth - 2 * selfRadius) / 2);
}

// ===========================================================================
// §8.5 mechanism 1 — corridor detection + width, off the live nav grid.
// ===========================================================================

const NEI_DX = Object.freeze([-1, 0, 1, -1, 1, -1, 0, 1]);
const NEI_DZ = Object.freeze([-1, -1, -1, 0, 0, 1, 1, 1]);

/** `06` §8.5: "detected as `nav.flagsAt(self) & NAV_FLAG.doorway`, or a cell
 * whose 8-neighbourhood has <= 5 walkable cells." `Alloc: no`. */
export function isCorridorCell(nav, x, z) {
  if ((nav.flagsAt(x, z) & NAV_FLAG_DOORWAY) !== 0) return true;
  const cs = nav.grid && nav.grid.cellSize ? nav.grid.cellSize : 0.5;
  let walkable = 0;
  for (let i = 0; i < 8; i++) {
    if (nav.walkable(x + NEI_DX[i] * cs, z + NEI_DZ[i] * cs)) walkable++;
  }
  return walkable <= CORRIDOR_NEIGHBOUR_WALKABLE_MAX;
}

/** Measures the walkable span perpendicular to `(perpX,perpZ)` (a UNIT
 * vector) through `(x,z)`, in `nav.grid.cellSize` steps — a real
 * measurement off the live grid, never a stored constant (rule: "the
 * corridor width your code detects must come from the nav grid"). `Alloc:
 * no`.
 * @param {number} maxSteps cap per side (default 12 = 6 m at 0.5 m cells).
 * @returns {number} metres. */
export function measureCorridorWidth(nav, x, z, perpX, perpZ, maxSteps = 12) {
  const cs = nav.grid && nav.grid.cellSize ? nav.grid.cellSize : 0.5;
  let posSteps = 0;
  for (let i = 1; i <= maxSteps; i++) {
    if (!nav.walkable(x + perpX * cs * i, z + perpZ * cs * i)) break;
    posSteps = i;
  }
  let negSteps = 0;
  for (let i = 1; i <= maxSteps; i++) {
    if (!nav.walkable(x - perpX * cs * i, z - perpZ * cs * i)) break;
    negSteps = i;
  }
  return (posSteps + negSteps + 1) * cs;
}

// ===========================================================================
// §8.3 — local avoidance.
// ===========================================================================

/** `06` §8.3's weight table: player neighbour always 1.60; otherwise 0.50 in
 * a doorway cell (SELF's own cell, per the formula's `flagsAt(self)`), else
 * 1.00. `Alloc: no`. */
export function avoidanceWeight(nav, selfX, selfZ, otherIsPlayer) {
  if (otherIsPlayer) return AVOIDANCE_PLAYER_WEIGHT;
  if ((nav.flagsAt(selfX, selfZ) & NAV_FLAG_DOORWAY) !== 0) return AVOIDANCE_DOORWAY_WEIGHT;
  return AVOIDANCE_DEFAULT_WEIGHT;
}

/** `06` §8.3: `steer = normalize(desired*1.00 + avoid*0.55)`, written into
 * `out`. Falls back to `desired` alone if the blended vector is
 * (near-)zero. `Alloc: no`. */
export function blendSteer(desiredX, desiredZ, avoidX, avoidZ, out) {
  let sx = desiredX * 1.0 + avoidX * AVOIDANCE_BLEND_WEIGHT;
  let sz = desiredZ * 1.0 + avoidZ * AVOIDANCE_BLEND_WEIGHT;
  let len = Math.sqrt(sx * sx + sz * sz);
  if (len < 1e-6) {
    sx = desiredX;
    sz = desiredZ;
    len = Math.sqrt(sx * sx + sz * sz);
  }
  if (len > 1e-6) {
    out.x = sx / len;
    out.z = sz / len;
  } else {
    out.x = 0;
    out.z = 0;
  }
  return out;
}

/** Recomputes and HOLDS `store.avoidX/avoidZ[idx]` — `06` §8.3's own "the
 * vector is held between updates" at 20 Hz (every 3 steps, phase
 * `actorId % 3`). Queries `physics.overlapCircle` (1.60 m, `MASK.ACTORS`),
 * takes the first 4 by (distance, actorId) — a total order, per §8.3 — and
 * sums `normalize(self-other) * weight * (1.60-d)/1.60`. `Alloc: no`
 * (`store._overlapIds`/`_topDist`/`_topId`/`_topX`/`_topZ`/`_topIsPlayer`
 * are the reused scratch). No-op (holds the previous vector) if `physics`
 * is absent (stub-ctx tests) or off cadence. */
export function updateAvoidance(ctx, actors, nav, physics, store, idx, actor, player) {
  const step = ctx.time.step;
  if (store.avoidNextStep[idx] >= 0 && step < store.avoidNextStep[idx]) return;
  store.avoidNextStep[idx] = step + AVOIDANCE_CADENCE_TICKS;

  if (!physics) {
    store.avoidX[idx] = 0;
    store.avoidZ[idx] = 0;
    return;
  }

  const out = store._overlapIds;
  const count = physics.overlapCircle(actor.x, actor.z, AVOIDANCE_QUERY_RADIUS, MASK_ACTORS, out);

  const topDist = store._topDist;
  const topId = store._topId;
  const topX = store._topX;
  const topZ = store._topZ;
  const topIsPlayer = store._topIsPlayer;
  let topN = 0;

  for (let i = 0; i < count; i++) {
    const id = out[i];
    if (id === actor.id) continue;
    const other = actors.byId(id);
    if (!other || other.dead) continue;
    const dx = other.x - actor.x;
    const dz = other.z - actor.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > AVOIDANCE_QUERY_RADIUS) continue;
    const isPlayer = player ? other.id === player.id : false;

    // Insertion into the top-4 by (distance, actorId) — a fixed 4-slot
    // scratch, never a sort allocation.
    let slot = topN < AVOIDANCE_NEIGHBOURS ? topN : -1;
    if (slot === -1) {
      // Full — replace the current worst if this candidate ranks better.
      let worst = 0;
      for (let k = 1; k < AVOIDANCE_NEIGHBOURS; k++) {
        if (topDist[k] > topDist[worst] || (topDist[k] === topDist[worst] && topId[k] > topId[worst])) worst = k;
      }
      if (d < topDist[worst] || (d === topDist[worst] && id < topId[worst])) slot = worst;
    } else {
      topN++;
    }
    if (slot === -1) continue;
    topDist[slot] = d;
    topId[slot] = id;
    topX[slot] = other.x;
    topZ[slot] = other.z;
    topIsPlayer[slot] = isPlayer ? 1 : 0;
  }

  let ax = 0;
  let az = 0;
  for (let k = 0; k < topN; k++) {
    const dx = actor.x - topX[k];
    const dz = actor.z - topZ[k];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) continue;
    const w = avoidanceWeight(nav, actor.x, actor.z, topIsPlayer[k] === 1);
    const falloff = (AVOIDANCE_QUERY_RADIUS - d) / AVOIDANCE_QUERY_RADIUS;
    ax += (dx / d) * w * falloff;
    az += (dz / d) * w * falloff;
  }
  store.avoidX[idx] = ax;
  store.avoidZ[idx] = az;
}

// ===========================================================================
// §8.4 — approach formations.
// ===========================================================================

/** `06` §8.4's table, read literally, contradicts its own worked example:
 * the table's three rows say `direct` fires on "count<=5 OR open macro
 * cell" and `flank` fires on "count>=10" — read as independent conditions,
 * a 12-pack in the open would match BOTH rows. But §8.5's own worked
 * example is explicit: "In open ground the same 12 arrive on 16 ring slots
 * in `flank` formation" — a large pack in the open is `flank`, never
 * `direct`. Resolved by precedence, checked FIRST-match-wins in the order
 * that keeps every worked example true: `flank` (count>=10) is decided
 * before "open macro cell" is even consulted; `direct`'s "or open macro
 * cell" clause only has room to matter for the `arc` band (6-9), downgrading
 * an open-ground medium pack from `arc` to `direct` (a pack that size in
 * open ground does not need two staging wings to avoid a single mass — the
 * corridor problem `arc`/`flank` exist for). This is a resolved spec
 * ambiguity, reported, not a silent guess. The Renunciation-difficulty
 * OR-condition on `flank` is not evaluated here — difficulty tiers are not
 * built this milestone (`06` §11.3 out of this ticket's reading scope);
 * flagged, not silently assumed absent (rule 11). `Alloc: no`. */
export function selectFormation(count, isOpenGround) {
  if (count >= FLANK_MIN_COUNT) return FORMATION_FLANK;
  if (count <= ARC_MIN_COUNT - 1) return FORMATION_DIRECT;
  if (isOpenGround) return FORMATION_DIRECT;
  return FORMATION_ARC;
}

/** `06` §8.4 `flank`: `actorId % 10` — 0-3 (40%) direct, 4-6 (30%) +100 deg,
 * 7-9 (30%) -100 deg. `Alloc: no`. @returns {0|1|2} */
export function flankGroupFor(actorId) {
  const m = actorId % FLANK_GROUP_MOD;
  if (m < 4) return 0; // direct
  if (m < 7) return 1; // +100 deg
  return 2; // -100 deg
}

/** `06` §8.4 `arc`: two wings by `actorId` parity. `Alloc: no`.
 * @returns {0|1} */
export function arcWingFor(actorId) {
  return actorId % 2;
}

/** Rotates `(dx,dz)` by `angleRad` in the XZ plane, into `out`. `Alloc: no`. */
export function rotateXZ(dx, dz, angleRad, out) {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}

// ===========================================================================
// Pack-level bookkeeping — formation selection on the alert->chase
// transition, held for the engagement (06 §8.4).
// ===========================================================================

/** Selects (once) and holds a pack's formation for the current engagement.
 * `06` §8.4: "selected once when a pack transitions from alert to chase and
 * held for the engagement." This subsystem tracks per-MEMBER state, not a
 * pack-level one, so "the pack transitions" is read here as: the first live
 * member of the pack reaches `chase`/`attack` while the pack was not
 * already marked engaged. Reset when no member is left in `chase`/`attack`,
 * so the next engagement re-rolls — a resolved ambiguity, reported.
 * `Alloc: no`. */
export function ensurePackEngaged(ctx, actors, nav, perception, store, packSlot, archetypeId, memberIsEngaging, target) {
  if (store.packEngaged[packSlot]) return;
  if (!memberIsEngaging) return;
  const count = perception.packMemberCount[packSlot];
  const isOpen = !isCorridorCell(nav, target.x, target.z);
  store.packEngaged[packSlot] = 1;
  store.packFormation[packSlot] = selectFormation(count, isOpen);
  store.packFormationCount[packSlot] = count;
  store.packOpenGround[packSlot] = isOpen ? 1 : 0;
}

// ===========================================================================
// Slot/lane/waypoint assignment — one pass per pack, per decision, so the
// "next free slot in index order" fallback (06 §8.2) has the whole pack's
// claims visible, not a per-member race.
// ===========================================================================

/**
 * Assigns `store.ringSlot`/`store.lane`/`store.goalX`/`store.goalZ`/
 * `store.hasWaypoint`/`store.waypointX`/`store.waypointZ` for every live
 * member of `packSlot`, once. Ascending `actorId` into ascending slot index
 * (`packMembers` is already actorId-ascending, per `perception.js#addPackMember`'s
 * own header). A slot whose `nav.flowDistance` is infinite or whose
 * `nav.raycastNav` fails is skipped for "next free slot in index order"; a
 * member with NO reachable slot at all holds its last-assigned goal (or the
 * ring's slot 0 position as a last resort) and is re-tested next call.
 * `Alloc: no` — `store._memberActor`/`_claimed`/`_posScratch`
 * are the reused scratch.
 */
export function assignPackSlots(ctx, actors, nav, perception, store, packSlot, archetypeId, target) {
  const base = packSlot * MAX_PACK_MEMBERS;
  const count = perception.packMemberCount[packSlot];
  const slotCount = slotCountFor(archetypeId, target.radius);
  if (slotCount <= 0) return;

  const memberActor = store._memberActor;
  let n = 0;
  for (let i = 0; i < count && n < MAX_PACK_MEMBERS; i++) {
    const a = actors.byId(perception.packMembers[base + i]);
    if (!a || a.dead) continue;
    memberActor[n++] = a;
  }

  const claimed = store._claimed;
  const cap = Math.min(slotCount, SLOT_SCRATCH_CAP);
  claimed.fill(0, 0, cap);

  const isOpen = !store.packEngaged[packSlot] ? !isCorridorCell(nav, target.x, target.z) : store.packOpenGround[packSlot] === 1;
  const formation = store.packFormation[packSlot];

  for (let r = 0; r < n; r++) {
    const a = memberActor[r];
    const idx = a.poolIndex;
    const want = r % slotCount;
    let assigned = -1;
    for (let attempt = 0; attempt < cap; attempt++) {
      const cand = (want + attempt) % cap;
      if (claimed[cand]) continue;
      const pos = ringSlotPosition(archetypeId, target.x, target.z, target.facing, target.radius, cand, slotCount, store._posScratch);
      const reachable = Number.isFinite(nav.flowDistance(pos.x, pos.z)) && nav.raycastNav(a.x, a.z, pos.x, pos.z);
      if (!reachable) continue;
      assigned = cand;
      claimed[cand] = 1;
      store.ringSlot[idx] = cand;
      store.goalX[idx] = pos.x;
      store.goalZ[idx] = pos.z;
      break;
    }
    if (assigned === -1) {
      // Nothing reachable this pass — hold the last-known goal (or slot 0's
      // position as a first-ever fallback) and re-test next decision, per
      // 06 §8.2's own "holds at the last reachable point" text.
      if (store.ringSlot[idx] < 0) {
        const pos = ringSlotPosition(archetypeId, target.x, target.z, target.facing, target.radius, want, slotCount, store._posScratch);
        store.goalX[idx] = pos.x;
        store.goalZ[idx] = pos.z;
      }
    }

    store.lane[idx] = laneIndexForRank(r);

    // Formation waypoints (06 §8.4) — computed ONCE per engagement, not
    // recomputed every decision tick. A real bug this ticket's own live
    // integration test caught: recomputing the waypoint unconditionally on
    // every pack-wide reassignment pass (every ~6 ticks, or sooner — any
    // member's own cadence expiry triggers a pack-wide pass) reset an
    // already-arrived member's `hasWaypoint` back to a FRESH waypoint
    // 6-11 m away, over and over, before it could ever finish closing the
    // gap to its ring slot — an infinite "arrive, get reset, re-approach"
    // oscillation that never converges (see the report for the measured
    // trace). `store.waypointDone` is the one-shot latch that prevents
    // this: a waypoint is computed at most once per engagement, and
    // `stepCrowdMember` sets it when the member actually arrives.
    if (!store.waypointDone[idx] && !store.hasWaypoint[idx]) {
      if (formation === FORMATION_ARC) {
        const wing = arcWingFor(a.id);
        const sign = wing === 0 ? -1 : 1;
        assignArcOrFlankWaypoint(nav, perception, store, packSlot, idx, target, sign, 0);
        if (!store.hasWaypoint[idx]) store.waypointDone[idx] = 1; // snap/region fallback — no waypoint this engagement
      } else if (formation === FORMATION_FLANK) {
        const group = flankGroupFor(a.id);
        if (group !== 0) {
          const sign = group === 1 ? 1 : -1;
          assignArcOrFlankWaypoint(nav, perception, store, packSlot, idx, target, sign, 1);
          if (!store.hasWaypoint[idx]) store.waypointDone[idx] = 1;
        } else {
          store.waypointDone[idx] = 1; // direct wing — never had one
        }
      } else {
        store.waypointDone[idx] = 1; // direct/no formation waypoint concept
      }
    }
  }
}

/** Shared arc/flank waypoint math — a staging point `ARC_STAGE_DIST`
 * (arc) or `FLANK_WAYPOINT_DIST` at `+-100 deg` (flank) from the
 * pack-centre -> target bearing, `nav.snap`ped. Falls back to "no waypoint"
 * (direct to the ring slot) if the snap fails or lands in a different
 * region than the target's — `06` §8.4's own fallback rule — counted in
 * `store.flankFallback` for reporting. `Alloc: no`. */
function assignArcOrFlankWaypoint(nav, perception, store, packSlot, idx, target, sign, mode) {
  const cx = perception.packCenterX[packSlot];
  const cz = perception.packCenterZ[packSlot];
  let bx = target.x - cx;
  let bz = target.z - cz;
  const blen = Math.sqrt(bx * bx + bz * bz);
  if (blen < 1e-6) {
    bx = 1;
    bz = 0;
  } else {
    bx /= blen;
    bz /= blen;
  }

  const pos = store._posScratch;
  if (mode === 0) {
    // arc: perpendicular staging point, left/right of the target.
    const perpX = -bz;
    const perpZ = bx;
    pos.x = target.x + sign * ARC_STAGE_DIST * perpX;
    pos.z = target.z + sign * ARC_STAGE_DIST * perpZ;
  } else {
    // flank: waypoint at target + 6.0 m on bearing +-100 deg from pack->target.
    rotateXZ(bx, bz, sign * FLANK_BEARING_RAD, pos);
    const rx = pos.x;
    const rz = pos.z;
    pos.x = target.x + FLANK_WAYPOINT_DIST * rx;
    pos.z = target.z + FLANK_WAYPOINT_DIST * rz;
  }

  const snapped = nav.snap(pos.x, pos.z, FLANK_SNAP_RADIUS);
  const targetRegion = nav.regionAt(target.x, target.z);
  if (!snapped || nav.regionAt(snapped.x, snapped.z) !== targetRegion || targetRegion < 0) {
    store.flankFallback[idx] = 1;
    store.hasWaypoint[idx] = 0;
    return;
  }
  store.flankFallback[idx] = 0;
  store.hasWaypoint[idx] = 1;
  store.waypointX[idx] = snapped.x;
  store.waypointZ[idx] = snapped.z;
}

// ===========================================================================
// §8.5 mechanism 3 — doorway-queue. See this file's header for why this is
// tracked as its own flag, never `BRAIN_STATE.reposition`.
// ===========================================================================

/** Counts LIVE pack-mates within `DOORWAY_LOOKAHEAD_M` of `(x,z)` — the
 * "next path node is a doorway cell already occupied by >= 2 pack-mates"
 * occupancy test, approximated over the pack's own member list (bounded,
 * `MAX_PACK_MEMBERS`) since no `PathHandle` is walked for movement (`./nav.js`'s
 * own gap — see this file's header). `Alloc: no`. */
function countPackmatesNear(actors, perception, packSlot, x, z, excludeId) {
  const base = packSlot * MAX_PACK_MEMBERS;
  const count = perception.packMemberCount[packSlot];
  let n = 0;
  const r2 = DOORWAY_LOOKAHEAD_M * DOORWAY_LOOKAHEAD_M;
  for (let i = 0; i < count; i++) {
    const id = perception.packMembers[base + i];
    if (id === excludeId) continue;
    const a = actors.byId(id);
    if (!a || a.dead) continue;
    const dx = a.x - x;
    const dz = a.z - z;
    if (dx * dx + dz * dz <= r2) n++;
  }
  return n;
}

/** `06` §8.5 mechanism 3: a member whose short lookahead point (approximating
 * "next path node", see this file's header) is a doorway cell already
 * occupied by >= 2 pack-mates enters an up-to-1.2 s queue: steer to a wall
 * lane and hold. `Alloc: no`. @returns {boolean} true while queueing. */
export function updateDoorwayQueue(ctx, actors, nav, perception, store, idx, actor, packSlot, desiredX, desiredZ) {
  const step = ctx.time.step;
  if (step < store.doorwayQueueUntilStep[idx]) return true; // already queueing, still inside the 1.2s window

  const lookX = actor.x + desiredX * DOORWAY_LOOKAHEAD_M;
  const lookZ = actor.z + desiredZ * DOORWAY_LOOKAHEAD_M;
  const isDoorwayAhead = (nav.flagsAt(lookX, lookZ) & NAV_FLAG_DOORWAY) !== 0;
  if (!isDoorwayAhead) return false;

  const occ = countPackmatesNear(actors, perception, packSlot, lookX, lookZ, actor.id);
  if (occ < DOORWAY_OCCUPANCY_MIN) return false;

  store.doorwayQueueUntilStep[idx] = step + DOORWAY_QUEUE_MAX_TICKS;
  // Wall lane: perpendicular to the approach direction, toward whichever
  // side has more clearance — approximated as a fixed perpendicular offset
  // (ASSIGNED: no spec formula for "which wall"), held for the wait.
  const perpX = -desiredZ;
  const perpZ = desiredX;
  store.doorwayWallX[idx] = actor.x + perpX * 0.6;
  store.doorwayWallZ[idx] = actor.z + perpZ * 0.6;
  return true;
}

// ===========================================================================
// §8.5 mechanism 4 — rank rotation.
// ===========================================================================

/** `06` §8.5 mechanism 4: a member blocked on its own lane by a pack-mate
 * for > 2.0 s swaps lane index with the front-rank member on an adjacent
 * lane, initiated by the lower `actorId`, both indices exchanged in one
 * operation. "Blocked" is measured as near-zero displacement since the last
 * decision tick. `Alloc: no`. @returns {boolean} true if a swap happened. */
export function updateRankRotation(ctx, actors, perception, store, brains, BRAIN_STATE, idx, actor, packSlot) {
  const step = ctx.time.step;
  const dx = actor.x - store.lastCheckX[idx];
  const dz = actor.z - store.lastCheckZ[idx];
  const moved2 = dx * dx + dz * dz;
  store.lastCheckX[idx] = actor.x;
  store.lastCheckZ[idx] = actor.z;

  if (moved2 > BLOCKED_PROGRESS_EPS_SQ) {
    store.blockedSinceStep[idx] = -1;
    return false;
  }
  if (store.blockedSinceStep[idx] < 0) store.blockedSinceStep[idx] = step;
  if (step - store.blockedSinceStep[idx] < RANK_ROTATION_BLOCKED_TICKS) return false;

  // Only the lower actorId initiates (06 §8.5: "the swap is initiated by
  // the lower actorId") — find a live pack-mate on an adjacent lane whose
  // ring slot is CLOSER to the target (front-rank) than this member's own.
  const base = packSlot * MAX_PACK_MEMBERS;
  const count = perception.packMemberCount[packSlot];
  const myLane = store.lane[idx];
  const mySlot = store.ringSlot[idx];
  for (let i = 0; i < count; i++) {
    const otherId = perception.packMembers[base + i];
    if (otherId >= actor.id) continue; // only the lower actorId initiates
    const other = actors.byId(otherId);
    if (!other || other.dead) continue;
    if (brains.state[other.poolIndex] === BRAIN_STATE.dead) continue;
    const oIdx = other.poolIndex;
    const otherLane = store.lane[oIdx];
    if (Math.abs(otherLane - myLane) !== 1) continue; // adjacent lane only
    if (store.ringSlot[oIdx] < 0 || mySlot < 0 || store.ringSlot[oIdx] >= mySlot) continue; // must be front-rank

    const tmp = store.lane[idx];
    store.lane[idx] = store.lane[oIdx];
    store.lane[oIdx] = tmp;
    store.rotations[idx]++;
    store.rotations[oIdx]++;
    store.blockedSinceStep[idx] = -1;
    store.blockedSinceStep[oIdx] = -1;
    return true;
  }
  return false;
}

// ===========================================================================
// Per-brain entry point — called from `./index.js#fixedUpdate` INSTEAD OF
// `stepMeleeBrain` for a chase-state, registered-pack-member brain not yet
// within its own contact range. See this file's header for the full
// architectural reasoning.
// ===========================================================================

/** `Alloc: no`. @returns {boolean} true if this call actually steered the
 * brain THIS STEP (the caller must NOT also call `stepMeleeBrain` this
 * step, regardless of whether this happened to be a 10 Hz decision tick or
 * an off-cadence movement-only step — both apply a real `actors.moveTo`
 * this function issues itself); false means "not this file's concern this
 * step" (not our archetype, not a pack member, no live target, or already
 * in contact range) — caller should fall back to `stepMeleeBrain` exactly
 * as before this ticket. This is a DIFFERENT question from "was a decision
 * re-evaluated" (`stepMeleeBrain`/`stepPerceptionBrain`'s own return
 * contract, feeding `ai.stats.decisions`) — conflating the two would make
 * `index.js` call `stepMeleeBrain` a second time on this file's own
 * off-cadence movement steps, double-moving the actor. */
export function stepCrowdMember(ctx, actors, nav, physics, actor, target, idx, brains, perception, store, BRAIN_STATE) {
  const row = CROWD_TABLE[actor.archetypeId];
  if (!row) return false;
  const bestiaryRow = BESTIARY[actor.archetypeId];
  if (bestiaryRow && (bestiaryRow.role === 'ranged' || bestiaryRow.role === 'support')) return false; // 06 §8.5 mechanism 2 — never queues; not our archetype set this milestone anyway

  const packSlot = perception.packSlot[idx];
  if (packSlot < 0) return false;
  if (!target || target.dead) return false;
  if (actors.inRange(actor, target, row.attackRange)) return false; // already at contact range — hand off to melee.js

  const step = ctx.time.step;
  ensurePackEngaged(ctx, actors, nav, perception, store, packSlot, actor.archetypeId, true, target);

  if (step >= store.nextDecisionStep[idx] || store.ringSlot[idx] < 0) {
    // One pack-wide assignment pass per pack per step, not one per member —
    // members that share a decision cadence (the common case: a pack that
    // entered `chase` together) would otherwise redundantly recompute the
    // same slot claims up to N times this step. `packLastAssignStep` dedupes
    // that without changing the result (`assignPackSlots` is idempotent
    // against unchanged nav/target state within one step).
    if (store.packLastAssignStep[packSlot] !== step) {
      assignPackSlots(ctx, actors, nav, perception, store, packSlot, actor.archetypeId, target);
      store.packLastAssignStep[packSlot] = step;
    }
    store.nextDecisionStep[idx] = step + CROWD_DECISION_CADENCE_TICKS;
  }

  // ---- desired direction toward this step's goal (waypoint, then ring slot) ----
  let goalX = store.goalX[idx];
  let goalZ = store.goalZ[idx];
  if (store.hasWaypoint[idx]) {
    const wx = store.waypointX[idx];
    const wz = store.waypointZ[idx];
    const wdx = wx - actor.x;
    const wdz = wz - actor.z;
    if (wdx * wdx + wdz * wdz > WAYPOINT_ARRIVE_RADIUS * WAYPOINT_ARRIVE_RADIUS) {
      goalX = wx;
      goalZ = wz;
    } else {
      store.hasWaypoint[idx] = 0; // arrived — switch to the ring slot
      store.waypointDone[idx] = 1; // one-shot latch — never recomputed again this engagement
    }
  }

  // "Consuming a solved path or flow vector for movement" — AI-4's own
  // report explicitly left this to this ticket (see this file's header).
  // A straight line to a ring slot/waypoint on the FAR SIDE of a doorway or
  // corridor corner is exactly the case a pure straight-line desired
  // direction cannot handle (a real bug this ticket's own corridor
  // integration test caught: a member stalled right at a doorway threshold,
  // steering straight at a now-unreachable-by-line goal and pinning itself
  // against the door frame instead of walking through). When
  // `nav.raycastNav` reports the direct line is blocked, steer off
  // `nav.flowAt()` (the flow field already built toward this same target by
  // `./nav.js`'s own scheduler, `06` §9.1) instead — it already routes
  // around exactly this geometry. Falls back to the straight line if the
  // field has nothing for this cell (not yet built, or genuinely
  // unreachable) — better than not moving at all.
  let dx = goalX - actor.x;
  let dz = goalZ - actor.z;
  let dlen = Math.sqrt(dx * dx + dz * dz);
  if (dlen > 1e-6) {
    dx /= dlen;
    dz /= dlen;
  } else {
    dx = 0;
    dz = 0;
  }
  if (dlen > 1e-6 && !nav.raycastNav(actor.x, actor.z, goalX, goalZ)) {
    const flow = nav.flowAt(actor.x, actor.z, store._flowScratch);
    if (flow && (flow.dx !== 0 || flow.dz !== 0)) {
      dx = flow.dx;
      dz = flow.dz;
    }
  }

  // ---- lane offset in a detected corridor (06 §8.5 mechanism 1) ----
  if (isCorridorCell(nav, actor.x, actor.z)) {
    const perpX = -dz;
    const perpZ = dx;
    const width = measureCorridorWidth(nav, actor.x, actor.z, perpX, perpZ);
    const offset = laneOffsetFor(store.lane[idx], width, row.selfRadius);
    const laneGoalX = goalX + perpX * offset;
    const laneGoalZ = goalZ + perpZ * offset;
    dx = laneGoalX - actor.x;
    dz = laneGoalZ - actor.z;
    dlen = Math.sqrt(dx * dx + dz * dz);
    if (dlen > 1e-6) {
      dx /= dlen;
      dz /= dlen;
    } else {
      dx = 0;
      dz = 0;
    }
  }

  // ---- doorway-queue (06 §8.5 mechanism 3) ----
  const queueing = updateDoorwayQueue(ctx, actors, nav, perception, store, idx, actor, packSlot, dx, dz);

  // ---- rank rotation (06 §8.5 mechanism 4) — every step, not decision-cadence
  // gated: it measures continuous lack of progress toward a 2.0s threshold,
  // the same "checked every step" class as checkLeash/stepChaseHooks'
  // own "any state" priority checks elsewhere in this subsystem. Skipped
  // while queueing at a doorway — a queueing member is deliberately
  // motionless, not "blocked" in the rank-rotation sense.
  if (!queueing) {
    updateRankRotation(ctx, actors, perception, store, brains, BRAIN_STATE, idx, actor, packSlot);
  }

  // ---- local avoidance blend (06 §8.3), 20 Hz held vector ----
  updateAvoidance(ctx, actors, nav, physics, store, idx, actor, target);

  const steer = store._posScratch;
  if (queueing) {
    let wdx = store.doorwayWallX[idx] - actor.x;
    let wdz = store.doorwayWallZ[idx] - actor.z;
    const wlen = Math.sqrt(wdx * wdx + wdz * wdz);
    if (wlen > 1e-6) {
      wdx /= wlen;
      wdz /= wlen;
    }
    blendSteer(wdx, wdz, store.avoidX[idx], store.avoidZ[idx], steer);
  } else {
    blendSteer(dx, dz, store.avoidX[idx], store.avoidZ[idx], steer);
  }

  // O-87 workaround, same precedent `brains/melee.js#moveTowards` and
  // `perception.js#stepLeashReturn` already establish: `actors.moveSpeed()`
  // is a flat 4.2 m/s for every actor (`src/actors/motion.js`'s own header),
  // so real archetype speed is read straight off the bestiary row and
  // applied directly through `actors.moveTo`, never through `moveSpeed()`.
  const runSpeed = bestiaryRow ? bestiaryRow.runSpeed : 0;
  const moveMult = queueing ? 0 : 1; // a queueing member holds its wall lane rather than advancing
  const disp = runSpeed * FIXED_DT * moveMult;
  actors.moveTo(actor, steer.x * disp, steer.z * disp);
  actors.face(actor, goalX, goalZ, CROWD_TURN_RATE);

  // Release the pack's engaged flag once nothing is left chasing, so the
  // NEXT engagement re-selects a formation (06 §8.4: "held for the
  // engagement", implying it ends). Cheap: bounded by MAX_PACK_MEMBERS.
  maybeReleasePackEngaged(actors, perception, brains, BRAIN_STATE, store, packSlot);

  return true; // this call steered the brain this step — see this function's own doc comment on why this is NOT "was a decision re-evaluated"
}

/** Clears `store.packEngaged`/`packFormation` once no live pack member is
 * still `chase`/`attack` — bounded scan, `MAX_PACK_MEMBERS` per call.
 * `Alloc: no`. */
function maybeReleasePackEngaged(actors, perception, brains, BRAIN_STATE, store, packSlot) {
  if (!store.packEngaged[packSlot]) return;
  const base = packSlot * MAX_PACK_MEMBERS;
  const count = perception.packMemberCount[packSlot];
  for (let i = 0; i < count; i++) {
    const a = actors.byId(perception.packMembers[base + i]);
    if (!a || a.dead) continue;
    const st = brains.state[a.poolIndex];
    if (st === BRAIN_STATE.chase || st === BRAIN_STATE.attack) return; // still engaged
  }
  store.packEngaged[packSlot] = 0;
  store.packFormation[packSlot] = -1;
  // A future re-engagement must be free to re-roll formation waypoints —
  // clear every member's one-shot latch, not just the pack-level flags.
  for (let i = 0; i < count; i++) {
    const a = actors.byId(perception.packMembers[base + i]);
    if (!a) continue;
    store.waypointDone[a.poolIndex] = 0;
    store.hasWaypoint[a.poolIndex] = 0;
  }
}

export { MAX_PACKS, MAX_PACK_MEMBERS };
