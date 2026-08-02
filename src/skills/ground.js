// src/skills/ground.js
//
// SKIL-9 — Ground effects and hazards (`05-skills.md` §14 row 9):
// `addGroundEffect`/`removeGroundEffect` (`02-api-contracts.md` §10),
// `nav.markHazard()` registration AND deregistration on all three exit
// paths (expiry, `zone:teardown`, owner death), `meteor`'s pool,
// `ash_wall`'s line + projectile absorption, `ashen_step`'s explicitly
// NON-hazard cloud. `src/skills/index.js` owns wiring the two contract
// methods, the `fixedUpdate` advance call, the `zone:teardown`/`actor:death`
// listeners, and augmenting `ashen_step`'s already-wired cast (SKIL-8,
// `./mobility.js`, not edited here) to also spawn its cloud at the
// departure point — this file owns the ground-effect ENGINE only.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/`
// with `checkGlobals: true`). No `Math.random()` — nothing here draws
// randomness of its own; `applyCoefficientRider` (ash_wall's `burning`
// seed) draws from `deps.rng`, the SAME forked stream `SkillsSystem.init()`
// already took for SKIL-6 (see `./status.js`'s own header) — no new fork.
//
// ---------------------------------------------------------------------------
// D-37 scope, and why meteor/ash_wall have no `cast()` handler here
// ---------------------------------------------------------------------------
// `meteor` and `ash_wall` are NOT among the ten skills `src/skills/index.js`
// dispatches a real `cast()` to (D-37's own list: cleaving_strike,
// ember_bolt, rune_strike, blade_seal, whirlwind, polarity, ram_charge,
// ashen_step, phase_leap, thunder_step). Writing their own cast handlers
// would mean a new `src/skills/impl/meteor.js` / `impl/ash_wall.js` file,
// and `impl/*` is explicitly on this ticket's "do not edit/create" list.
// So this ticket builds the ENGINE — the pool, the tick/field-application
// logic, the hazard register/deregister discipline, the projectile
// absorption — and PROVES it against hand-built `GroundEffectSpawn` specs
// (`buildMeteorPoolSpec`/`buildAshWallSpec` below, used directly by this
// ticket's own tests), exactly the same shape `./status.js`'s own header
// documents for its onHitStatus rider engine: "no cast-wired skill among
// its ten to reach it from yet." `ashen_step` IS cast-wired (SKIL-8), and
// its cloud is a real, reachable acceptance criterion (#3) — so
// `SkillsSystem#cast()` (`./index.js`) is augmented, generically over
// `skillId === 'ashen_step'`, to call `buildAshenStepCloudSpec` + this
// file's `addGroundEffect` right after a successful teleport. See
// `index.js`'s own diff for exactly where.
//
// ---------------------------------------------------------------------------
// A load-bearing finding: `nav.markHazard()` does not exist anywhere in
// this tree
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §6 lists `markHazard | (x,z,radius,on:boolean) =>
// void — the only writer of NAV_FLAG.hazard | Y | no`, and this ticket's own
// brief quotes it verbatim. `src/nav/index.js` (NAV-1..NAV-5, all already
// accepted) implements `grid`/`version`/`rebuild`/`walkable`/`flagsAt`/
// `regionAt`/`connected`/`snap`/`requestPath`/`pollPath`/`cancelPath`/
// `releasePath`/`pathNode`/`pathLength`/`setBudget`/`smooth`/
// `buildFlowField`/`flowAt`/`flowDistance`/`fixedUpdate`/`dispose` — no
// `markHazard`, verified by reading the file in full and by `grep -rn
// "markHazard" src/` returning nothing anywhere in the tree before this
// ticket. `NAV_FLAG.hazard` itself (`src/world/raster.js:50`, bit 2) and its
// cost contribution (`raster.js:645`) DO exist — only the write method is
// missing. This is `src/nav/`'s file, not this ticket's grant (rule 1: "if
// you need someone else's file, say so — do not edit it").
//
// The fix here is NOT to fabricate the method on `nav` (that would be
// editing a file outside this grant) and NOT to skip calling it (that would
// silently fail acceptance criterion #1 the moment `nav` DOES implement it,
// with nothing here ever exercising the real call). Every call site below
// feature-detects it — `nav && typeof nav.markHazard === 'function'` — the
// SAME "peek/degrade against a missing dependency" convention this
// subsystem already uses everywhere (`./index.js`'s own `ctx.peek('nav') ??
// null`, `./mobility.js`'s `physics && typeof physics.sweepProjectile ===
// 'function'`). Once `nav` ships `markHazard`, this file's calls activate
// with no further change. Until then, hazard registration against the REAL
// `ctx.get('nav')` is a documented no-op — reported prominently in this
// ticket's report, not buried here. This file's OWN register/deregister
// DISCIPLINE (call exactly once per spawn, exactly once per exit path, with
// the exact same `(x,z,radius)` tuples both ways) is proven by
// `tests/skills/ground.test.js` against an INJECTED `nav` stub that
// implements `markHazard` for the test — the same "build a test double for
// a dependency this ticket does not own" precedent
// `tests/skills/mobility.test.js` already establishes for `nav.snap`
// (except there, the real implementation already exists; here, this
// ticket's tests are what is left to prove the calling code is correct
// ahead of nav shipping the write side).
//
// ---------------------------------------------------------------------------
// The `GroundEffectSpawn` shape — consolidated, not one of the spec's own
// inline examples verbatim
// ---------------------------------------------------------------------------
// `05-skills.md`'s own inline pseudocode for `addGroundEffect(...)` differs
// per skill: meteor's uses `{preset, radius, seconds, dps}`, ashen_step's
// `{preset, radius, seconds, statuses}`, ash_wall's `{preset, shape, length,
// thickness, seconds}` — three incompatible shapes for one contract method.
// `11-flows.md` §5.7 gives a fourth, more complete list: `{skillId, level,
// x, z, radius, seconds, tickSteps, ownerRef}`. None of the four is a
// complete, implementable `GroundEffectSpawn` on its own (none carries a
// LINE's orientation/length/thickness AND a circle's radius AND the hazard
// flag AND the projectile-blocking flag in one shape). This file's own
// `GroundEffectSpawn` (documented at `addGroundEffect`'s own doc comment,
// below) is the consolidated superset every field of every skill's own row
// actually needs — an ASSIGNED shape, not a spec transcription, exactly the
// same category of decision `./projectile.js`'s own D-47 header documents
// for the identical "the spec's own prose examples conflict" situation.
// Reported in this ticket's report for the orchestrator to fold back into
// `02-api-contracts.md`/`05-skills.md` if it wants one canonical shape
// recorded there.
//
// ---------------------------------------------------------------------------
// `ash_wall`'s projectile absorption — reaching into `ProjectilePool`'s own
// internal typed arrays, read-only
// ---------------------------------------------------------------------------
// `ProjectilePool` (`./projectile.js`, accepted, not edited here) exposes
// no enumeration API — only `spawnProjectile`/`killProjectile`/`count`
// (`02-api-contracts.md` §10's three contracted rows). Absorbing an enemy
// projectile on contact with the wall needs to know EVERY live projectile's
// position and team every step, which no public method answers. This file
// reads `pool._active`/`_x`/`_z`/`_team`/`_radius` directly off the SAME
// `ProjectilePool` instance `SkillsSystem` already owns (passed through
// `deps.projectilePool`, wired in `./index.js`) — never through a NEW
// public method (rule 7 forbids inventing one not listed in
// `02-api-contracts.md`) and never by editing `projectile.js`. This is not
// a new pattern: `src/physics/cast.js`'s own header documents the identical
// choice for reading `PhysicsSystem`'s/`BodyStore`'s own underscore-
// prefixed fields from a sibling file in the SAME subsystem ("treating
// single-underscore fields as readable within the same physics subsystem,
// from a sibling file, is already this codebase's convention") — the same
// reasoning applies here, one directory over, for `skills`. The actual KILL
// still goes through the one legitimate public method,
// `skills.killProjectile(id)` — only the READ (position/team/active) reaches into
// the pool's internals; the WRITE stays on the public contract. Reported as
// a gap: a future ticket adding a `projectilesInRect`/`forEachProjectile`-
// style enumeration row to `02-api-contracts.md` would let this file drop
// the internal read entirely.
//
// ---------------------------------------------------------------------------
// Line-shaped hazards — `nav.markHazard`'s circle-only signature, sampled
// along the wall
// ---------------------------------------------------------------------------
// `nav.markHazard(x,z,radius,on)` has no line/rect variant. `05` §5.4's own
// wording — "`nav.markHazard()` along the line" — reads as exactly this:
// several circle registrations chained along the wall's own length axis,
// not one call. This file samples every `HAZARD_SAMPLE_SPACING_M` (0.5 m —
// `ARCHITECTURE.md`'s own nav grid cell size, so consecutive samples always
// overlap by at least half a cell, leaving no gap) from one end of the
// line to the other, each with `radius = thicknessM/2`, and stores the
// EXACT sample list per effect slot so deregistration calls
// `nav.markHazard(..., false)` on the IDENTICAL tuples registration used —
// never a recomputed approximation that could drift. A circle-shaped
// effect (`meteor`'s pool, and `ashen_step`'s cloud if it were a hazard,
// which it is deliberately not) is the same mechanism degenerated to
// exactly one sample.
//
// ---------------------------------------------------------------------------
// The `overlapRect`/line local-frame convention, and why `facing` is the
// caster->cursor ray, not the wall's own length axis
// ---------------------------------------------------------------------------
// Read directly out of `src/physics/cast.js#overlapRect` (not edited here):
// `lx = dx*cosF + dz*sinF` (the FACING-axis component, bounded by `halfW`)
// and `lz = -dx*sinF + dz*cosF` (the PERPENDICULAR-axis component, bounded
// by `halfL`) — i.e. `halfW` runs ALONG `facing`, `halfL` runs
// PERPENDICULAR to it. `05` §5.4: the wall's 6.0 m LENGTH runs perpendicular
// to the caster->cursor ray, and its 0.8 m damage proximity (== half its own
// 1.6 m thickness) runs ALONG that ray. So `facing` passed to `overlapRect`
// (and to this file's own matching hand-rolled check for projectile
// absorption, same math, commented at its own call site) is the RAY ANGLE
// itself (`Math.atan2(cursorZ-casterZ, cursorX-casterX)`), `halfW =
// thicknessM/2`, `halfL = lengthM/2` — no extra 90 degree rotation needed;
// the axis convention already lines the ray up with the thin dimension.
//
// ---------------------------------------------------------------------------
// Damage tick packets — built via `combat.buildSpellPacket`, then this
// SKILL's own tick numbers substituted, mirroring `./projectile.js`'s own
// `alwaysHits` precedent
// ---------------------------------------------------------------------------
// `combat.buildSpellPacket(source, skillId, level)` populates crit/resist-
// pierce/life-mana-steal riders correctly off the caster's real stats, but
// its `fireMin`/`fireMax` are NOT the ground effect's own per-TICK number
// (there is no way to ask it for that — a skill's `data/skills.js` record
// carries at most one `flatDamage` curve, and for `meteor` that curve is the
// IMPACT damage, not the pool's; `ash_wall`'s own `flatDamage` IS its tick
// number, degenerate-range-encoded per that file's own comment). This file
// overrides `fireMin`/`fireMax`/`physMin`/`physMax`/`attackRating`/
// `dodgeable`/`blockable` on the packet AFTER `buildSpellPacket` returns it
// — beyond `02-api-contracts.md`'s own documented "caller-adjustable" list
// (`radius`, `pierceIndex`, `onHitStatus`, `knockback`, `originX/Y/Z`,
// `requesterOwnsRageCredit`), but the EXACT same category of "skill-specific
// packet customisation done in THIS file" `./projectile.js`'s own header
// already establishes and ships as accepted code for its `alwaysHits` rider
// (`attackRating`/`dodgeable`/`blockable`, verbatim). Extended here to the
// damage range itself, for the same reason: no contract method exists to
// ask `combat` for "this skill's OWN per-tick number" instead of its
// printed base curve.
//
// `ashen_step`'s packet is additionally force-zeroed on EVERY damage field
// (`fireMin=fireMax=physMin=physMax=0`) rather than trusting
// `buildSpellPacket`'s own `stats.fireMin/fireMax` composition — `05` §5.1
// is explicit ("Produces no damage packet at all — deals zero damage at
// every level") and `stats.fireMin/fireMax` is the actor's GENERAL composed
// fire-damage total (gear, other skills), which could read nonzero for
// reasons that have nothing to do with this skill. Forcing zero is what
// actually guarantees the spec's own absolute claim rather than merely
// "usually zero."
//
// ---------------------------------------------------------------------------
// Riders driven, not re-authored (this ticket's own trap #5)
// ---------------------------------------------------------------------------
// `ashen_step`'s `slowed`/`blinded` field application calls
// `applyOnHitStatuses(deps, ASHEN_STEP_DEF, level, packet, target, result,
// step)` (`./status.js`, SKIL-6, unedited) against `ASHEN_STEP_DEF`'s OWN
// `onHitStatus` table (already carrying both riders, written by SKIL-8's
// `data/skills.js` record) — this file does not reconstruct the magnitude/
// duration formulas by hand. `ash_wall`'s `burning` seed calls
// `applyCoefficientRider` (same file) with a LOCAL rider literal
// (`{status:'burning', chance:100, duration:{base:3,perLevel:0},
// magnitude:{base:0.35,perLevel:0}}`) matching `03-combat-math.md` §7.4's
// own "default seeding" rule verbatim — `status.js`'s own
// `DEFAULT_BURN_COEFFICIENT`/`DEFAULT_BURN_DURATION` constants are NOT
// exported (module-private), so this file redeclares the same two spec-
// quoted numbers locally rather than reaching into that file's internals —
// the identical "redeclare a spec-quoted constant locally rather than couple
// to a non-contract detail" precedent `./mobility.js`'s own
// `INSTANT_TURN_RATE` comment documents for the same situation.
//
// ---------------------------------------------------------------------------
// Overflow policy — `01-data-model.md:1702`'s "oldest non-player effect
// expires" (EVICT), reconciled with this ticket's own self-check wording
// ("addGroundEffect returns 0 rather than allocating")
// ---------------------------------------------------------------------------
// Unlike `./projectile.js`'s D-47 (which found the `Projectile` row's own
// "oldest expires early" language in direct conflict with its acceptance
// criterion and chose pure REFUSE), the `GroundEffect` row's policy and
// this ticket's self-check wording are NOT in conflict: `addGroundEffect`
// first tries to evict the OLDEST effect owned by a NON-PLAYER actor
// (`ownerTeam !== 0`) — by `_spawnOrder`, a monotonic per-pool counter, not
// wall-clock — freeing exactly one slot; only when NO evictable (non-player)
// effect exists (the practical case today, since only the player's own
// Emberwright casts any of these three skills) does it refuse and return
// `0`, "rather than allocating." Both halves are exercised by
// `tests/skills/ground.test.js`: an all-player-owned full pool refuses: a
// pool with at least one non-player-owned effect evicts it and succeeds.
//
// ---------------------------------------------------------------------------
// Per-effect state survives pool recycle
// ---------------------------------------------------------------------------
// `_ownerId` stores `actor.id` (never `poolIndex`) — `01-data-model.md`'s
// own `id = 1 + poolIndex + generation * capacity` bijection (verified
// precedent: `./mobility.js`'s `fixedUpdate`, phase_leap) means
// `actors.byId(ownerId)` alone, with no separate generation field, already
// returns `null` the instant the owning actor slot recycles — the SAME
// "actors.byId() identity check" pattern this ticket's brief names among
// the five sanctioned techniques (SKIL-2/CMBT-8/SKIL-13/SKIL-7/SKIL-8). No
// sixth pattern invented.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline
// ---------------------------------------------------------------------------
// Every per-slot field is a typed array (or, for `_skillId`, a plain
// `Array` of INTERNED STRING REFERENCES set once per spawn — the identical
// "not a violation of the no-allocation rule" reasoning `./projectile.js`'s
// own header gives for its own `_skillId` field). `advanceGroundEffects`
// and every tick handler reuse module-scope scratch (`tickTargetsOut`,
// packet fields mutated on the ALREADY-POOLED packet `combat.
// buildSpellPacket` returns) — never allocated per call. No `Map`
// anywhere. `Math.hypot` is never used. No template strings on any path
// reachable from `fixedUpdate`.

import { levelValue } from './cost.js';
import { applyOnHitStatuses, applyCoefficientRider } from './status.js';
import { SKILLS } from './data/skills.js';

const METEOR_DEF = SKILLS.find((d) => d.id === 'meteor');
const ASH_WALL_DEF = SKILLS.find((d) => d.id === 'ash_wall');
const ASHEN_STEP_DEF = SKILLS.find((d) => d.id === 'ashen_step');

/** `01-data-model.md:1702`, the four LOD tiers verbatim — same shape
 * `./projectile.js`'s own `PROJECTILE_POOL_SIZE_BY_QUALITY` establishes for
 * the identical "table lives here, no `data/` file for it" situation. */
export const GROUND_EFFECT_POOL_SIZE_BY_QUALITY = Object.freeze({
  low: 24, medium: 32, high: 48, ultra: 64,
});

/** Fallback for a config-less test `ctx` — the LARGEST tier, mirroring
 * `./projectile.js`'s own `DEFAULT_PROJECTILE_POOL_CAPACITY` choice. */
export const DEFAULT_GROUND_EFFECT_POOL_CAPACITY = GROUND_EFFECT_POOL_SIZE_BY_QUALITY.ultra;

/** @param {object} ctx @returns {number} */
export function groundEffectPoolCapacityFor(ctx) {
  const quality = ctx && ctx.config && ctx.config.quality;
  return GROUND_EFFECT_POOL_SIZE_BY_QUALITY[quality] ?? DEFAULT_GROUND_EFFECT_POOL_CAPACITY;
}

/** `ARCHITECTURE.md`'s own nav grid cell size — see the file header, "Line-
 * shaped hazards". */
const HAZARD_SAMPLE_SPACING_M = 0.5;

/** Headroom above ash_wall's own 6.0 m length at the 0.5 m spacing above
 * (`ceil(6/0.5)+1 = 13`) — same "comfortable headroom above the documented
 * ceiling" precedent `./mobility.js#MAX_ARRIVAL_TARGETS` establishes. */
const MAX_HAZARD_SAMPLES = 16;

/** `05` §4.4 / §5.4: both meteor's pool and ash_wall's line tick at 4 Hz —
 * `11-flows.md` §5.7's own "default 15 = 4 Hz" row, in fixed steps at 60 Hz. */
const TICK_STEPS_4HZ = 15;
/** `05` §5.1: "every 0.5 s the field re-applies" — 30 fixed steps at 60 Hz. */
const TICK_STEPS_ASHEN_STEP = 30;

/** `03-combat-math.md` §7.4's own "default seeding" rule, verbatim — see
 * the file header, "Riders driven, not re-authored". */
const DEFAULT_BURN_COEFFICIENT = 0.35;
const DEFAULT_BURN_DURATION = 3.0;
const ASH_WALL_BURN_RIDER = Object.freeze({
  status: 'burning', chance: 100,
  duration: { base: DEFAULT_BURN_DURATION, perLevel: 0 },
  magnitude: { base: DEFAULT_BURN_COEFFICIENT, perLevel: 0 },
});

/** `physics.overlapCircle`/`overlapRect`'s own `out:int[]` capacity for a
 * ground-effect tick query — same headroom precedent as
 * `./mobility.js#MAX_ARRIVAL_TARGETS` / `./status.js#MAX_DETONATION_TARGETS`. */
const MAX_TICK_TARGETS = 32;
const tickTargetsOut = new Int32Array(MAX_TICK_TARGETS);

// ===========================================================================
// The pool
// ===========================================================================

function resetSlotFields(pool, slot) {
  pool._active[slot] = 0;
  pool._shape[slot] = 0;
  pool._x[slot] = 0; pool._z[slot] = 0;
  pool._radius[slot] = 0;
  pool._facing[slot] = 0;
  pool._halfLength[slot] = 0;
  pool._halfThickness[slot] = 0;
  pool._life[slot] = 0;
  pool._tickIntervalSteps[slot] = 0;
  pool._nextTickStep[slot] = 0;
  pool._hazard[slot] = 0;
  pool._blocksProjectiles[slot] = 0;
  pool._ownerId[slot] = 0;
  pool._team[slot] = 0;
  pool._level[slot] = 0;
  pool._tickDamage[slot] = 0;
  pool._skillId[slot] = null;
  pool._spawnOrder[slot] = 0;
  const base = slot * MAX_HAZARD_SAMPLES;
  for (let i = 0; i < MAX_HAZARD_SAMPLES; i++) {
    pool._sampleX[base + i] = 0; pool._sampleZ[base + i] = 0; pool._sampleR[base + i] = 0;
  }
  pool._hazardSampleCount[slot] = 0;
}

/** Fixed-capacity `GroundEffect` pool (`01-data-model.md:1702`). Pure
 * bookkeeping only — no `nav`/`combat`/`physics` call lives on the class
 * itself; every deps-needing side effect (hazard register/deregister, tick
 * damage, projectile absorption) is a free function below, mirroring
 * `./projectile.js`'s own `ProjectilePool` + `advanceProjectiles` split. */
export class GroundEffectPool {
  /** @param {number} capacity */
  constructor(capacity) {
    this._capacity = capacity;
    this._active = new Uint8Array(capacity);
    this._shape = new Uint8Array(capacity); // 0 = circle, 1 = line
    this._x = new Float64Array(capacity);
    this._z = new Float64Array(capacity);
    this._radius = new Float64Array(capacity); // circle only
    this._facing = new Float64Array(capacity); // line only — the caster->cursor ray angle
    this._halfLength = new Float64Array(capacity); // line only
    this._halfThickness = new Float64Array(capacity); // line only
    this._life = new Float64Array(capacity); // seconds remaining
    this._tickIntervalSteps = new Int32Array(capacity);
    this._nextTickStep = new Float64Array(capacity);
    this._hazard = new Uint8Array(capacity);
    this._blocksProjectiles = new Uint8Array(capacity);
    this._ownerId = new Int32Array(capacity); // actor.id — generation-bijective, see file header
    this._team = new Int32Array(capacity);
    this._level = new Int32Array(capacity);
    this._tickDamage = new Float64Array(capacity);
    /** Plain `Array` of interned string references — see file header. */
    this._skillId = new Array(capacity).fill(null);
    this._spawnOrder = new Float64Array(capacity);
    this._spawnCounter = 0;

    this._sampleX = new Float64Array(capacity * MAX_HAZARD_SAMPLES);
    this._sampleZ = new Float64Array(capacity * MAX_HAZARD_SAMPLES);
    this._sampleR = new Float64Array(capacity * MAX_HAZARD_SAMPLES);
    this._hazardSampleCount = new Int32Array(capacity);

    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;
  }

  get capacity() { return this._capacity; }

  /** `02-api-contracts.md` §10: implicit count, exposed for tests/debugging
   * (not a contract row itself). */
  get count() { return this._capacity - this._freeCount; }

  dispose() {
    this._freeCount = 0;
  }
}

// ===========================================================================
// Hazard sample computation — see file header, "Line-shaped hazards"
// ===========================================================================

/** Circle: exactly one sample. Line: evenly spaced samples every
 * `HAZARD_SAMPLE_SPACING_M`, capped at `MAX_HAZARD_SAMPLES`, along the
 * PERPENDICULAR axis to `facing` (unit vector `(-sinF, cosF)` — see file
 * header for the `overlapRect` axis derivation), each with
 * `radius = halfThickness`.
 * @param {GroundEffectPool} pool @param {number} slot
 * @returns {number} samples written
 */
function computeHazardSamples(pool, slot) {
  const base = slot * MAX_HAZARD_SAMPLES;
  if (pool._shape[slot] === 0) {
    pool._sampleX[base] = pool._x[slot];
    pool._sampleZ[base] = pool._z[slot];
    pool._sampleR[base] = pool._radius[slot];
    return 1;
  }

  const halfLength = pool._halfLength[slot];
  const halfThickness = pool._halfThickness[slot];
  const facing = pool._facing[slot];
  const perpX = -Math.sin(facing);
  const perpZ = Math.cos(facing);
  const length = halfLength * 2;
  let count = Math.min(MAX_HAZARD_SAMPLES, Math.ceil(length / HAZARD_SAMPLE_SPACING_M) + 1);
  if (count < 1) count = 1;

  const x = pool._x[slot];
  const z = pool._z[slot];
  for (let i = 0; i < count; i++) {
    // Evenly spaced across [-halfLength, +halfLength], inclusive of both ends.
    const t = count === 1 ? 0 : -halfLength + (i * length) / (count - 1);
    pool._sampleX[base + i] = x + perpX * t;
    pool._sampleZ[base + i] = z + perpZ * t;
    pool._sampleR[base + i] = halfThickness;
  }
  return count;
}

/** Calls `nav.markHazard(x,z,radius,on)` for every stored sample of `slot`
 * — feature-detected (see file header, the `nav.markHazard` gap). A no-op
 * against a `nav` that has not shipped the method yet, or a non-hazard
 * effect (`_hazard[slot] === 0`, e.g. `ashen_step`'s cloud — never called
 * at all for those, see `addGroundEffect`/`releaseSlot` below).
 * @param {GroundEffectPool} pool @param {number} slot @param {object} nav
 * @param {boolean} on */
function setHazardSamples(pool, slot, nav, on) {
  if (!pool._hazard[slot]) return;
  if (!nav || typeof nav.markHazard !== 'function') return;
  const base = slot * MAX_HAZARD_SAMPLES;
  const count = pool._hazardSampleCount[slot];
  for (let i = 0; i < count; i++) {
    nav.markHazard(pool._sampleX[base + i], pool._sampleZ[base + i], pool._sampleR[base + i], on);
  }
}

/** The ONE place a slot is torn down — expiry, manual `removeGroundEffect`,
 * `zone:teardown` and owner-death all funnel through this, so the hazard
 * deregistration discipline is identical on every exit path by
 * construction (acceptance criterion #1).
 * @param {GroundEffectPool} pool @param {number} slot @param {{nav:object}} deps */
function releaseSlot(pool, slot, deps) {
  setHazardSamples(pool, slot, deps.nav, false);
  resetSlotFields(pool, slot);
  pool._freeSlots[pool._freeCount++] = slot;
}

/** @param {GroundEffectPool} pool @returns {number} slot index, or -1 */
function findOldestNonPlayerSlot(pool) {
  let best = -1;
  let bestOrder = Infinity;
  for (let slot = 0; slot < pool._capacity; slot++) {
    if (!pool._active[slot]) continue;
    if (pool._team[slot] === 0) continue; // player-owned — never evicted, see file header
    if (pool._spawnOrder[slot] < bestOrder) { bestOrder = pool._spawnOrder[slot]; best = slot; }
  }
  return best;
}

// ===========================================================================
// `02-api-contracts.md` §10: addGroundEffect / removeGroundEffect
// ===========================================================================

/**
 * @typedef {object} GroundEffectSpawn
 * @property {string} skillId 'meteor' | 'ash_wall' | 'ashen_step' — dispatches the tick handler
 * @property {number} level effective skill level
 * @property {number} x @property {number} z circle centre, or line midpoint
 * @property {'circle'|'line'} [shape] default 'circle'
 * @property {number} [radius] circle only
 * @property {number} [facing] line only — the caster->cursor ray angle, radians
 * @property {number} [lengthM] line only — full length
 * @property {number} [thicknessM] line only — full thickness
 * @property {number} seconds effect lifetime
 * @property {number} tickSteps reapplication cadence, in FIXED STEPS
 * @property {number} [tickDamage] precomputed per-tick fire damage (0 for a no-damage field)
 * @property {boolean} hazard whether this effect registers NAV_FLAG.hazard
 * @property {boolean} [blocksProjectiles] ash_wall only
 * @property {number} ownerId `actor.id`
 * @property {number} team the owner's team
 */

/**
 * `02-api-contracts.md` §10: `addGroundEffect(spec) => int id | 0`. See the
 * file header for the overflow policy (evict oldest non-player, else
 * refuse) and the hazard-registration discipline.
 * @param {GroundEffectPool} pool
 * @param {GroundEffectSpawn} spec
 * @param {{nav:object, time:object}} deps
 * @returns {number}
 */
export function addGroundEffect(pool, spec, deps) {
  let slot;
  if (pool._freeCount > 0) {
    slot = pool._freeSlots[--pool._freeCount];
  } else {
    const victim = findOldestNonPlayerSlot(pool);
    if (victim === -1) return 0; // full of unevictable (player) effects — refuse, never allocate
    releaseSlot(pool, victim, deps);
    slot = pool._freeSlots[--pool._freeCount];
  }

  pool._active[slot] = 1;
  pool._skillId[slot] = spec.skillId;
  pool._level[slot] = spec.level;
  pool._x[slot] = spec.x;
  pool._z[slot] = spec.z;
  pool._shape[slot] = spec.shape === 'line' ? 1 : 0;
  pool._radius[slot] = spec.radius || 0;
  pool._facing[slot] = spec.facing || 0;
  pool._halfLength[slot] = spec.lengthM ? spec.lengthM / 2 : 0;
  pool._halfThickness[slot] = spec.thicknessM ? spec.thicknessM / 2 : 0;
  pool._life[slot] = spec.seconds;
  pool._tickIntervalSteps[slot] = spec.tickSteps;
  pool._nextTickStep[slot] = deps.time.step + spec.tickSteps;
  pool._hazard[slot] = spec.hazard ? 1 : 0;
  pool._blocksProjectiles[slot] = spec.blocksProjectiles ? 1 : 0;
  pool._ownerId[slot] = spec.ownerId;
  pool._team[slot] = spec.team;
  pool._tickDamage[slot] = spec.tickDamage || 0;
  pool._spawnOrder[slot] = pool._spawnCounter++;

  const sampleCount = spec.hazard ? computeHazardSamples(pool, slot) : 0;
  pool._hazardSampleCount[slot] = sampleCount;
  setHazardSamples(pool, slot, deps.nav, true);

  return slot + 1;
}

/**
 * `02-api-contracts.md` §10: `removeGroundEffect(id) => void`. Safe no-op
 * on a stale/already-removed id, matching `./projectile.js#killProjectile`'s
 * own precedent.
 * @param {GroundEffectPool} pool @param {number} id @param {object} deps
 */
export function removeGroundEffect(pool, id, deps) {
  const slot = id - 1;
  if (slot < 0 || slot >= pool._capacity) return;
  if (!pool._active[slot]) return;
  releaseSlot(pool, slot, deps);
}

/** `zone:teardown` exit path — every active effect torn down through the
 * same `releaseSlot`.
 * @param {GroundEffectPool} pool @param {object} deps */
export function onZoneTeardown(pool, deps) {
  for (let slot = 0; slot < pool._capacity; slot++) {
    if (pool._active[slot]) releaseSlot(pool, slot, deps);
  }
}

/** Owner-death exit path — every active effect owned by `deadActorId` torn
 * down (there can be more than one, e.g. two overlapping meteor pools from
 * the same caster).
 * @param {GroundEffectPool} pool @param {object} deps @param {number} deadActorId */
export function onActorDeath(pool, deps, deadActorId) {
  for (let slot = 0; slot < pool._capacity; slot++) {
    if (pool._active[slot] && pool._ownerId[slot] === deadActorId) releaseSlot(pool, slot, deps);
  }
}

// ===========================================================================
// Field application / tick handlers — one per skill, see file header
// ===========================================================================

/** `meteor`'s pool — 05 §4.4: 4 Hz, `attackRating=0`/`dodgeable=false`
 * packets, "hits, not DoT ticks — they can crit and can proc", no status. */
function tickMeteorPool(pool, slot, deps) {
  const { physics, combat, actors } = deps;
  if (!physics || !combat || !actors) return;
  const owner = actors.byId(pool._ownerId[slot]);
  if (!owner) return;

  const mask = pool._team[slot] === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
  const count = physics.overlapCircle(pool._x[slot], pool._z[slot], pool._radius[slot], mask, tickTargetsOut);
  if (count === 0) return;

  const packet = combat.buildSpellPacket(owner, 'meteor', pool._level[slot]);
  if (!packet) return; // DamagePacket pool exhausted

  const tickDamage = pool._tickDamage[slot];
  for (let i = 0; i < count; i++) {
    const target = actors.byId(tickTargetsOut[i]);
    if (!target || target.dead) continue;
    packet.fireMin = tickDamage; packet.fireMax = tickDamage;
    packet.physMin = 0; packet.physMax = 0;
    packet.attackRating = 0; packet.dodgeable = false; packet.blockable = false;
    packet.onHitCount = 0; // 05 §4.4: "the pool applies no status" — never populated
    combat.resolve(packet, target);
  }
  combat.releasePacket(packet);
}

/** `ash_wall`'s line — 05 §5.4: 4 Hz, `attackRating=0` packets within
 * 0.8 m of the line, seeding `burning` at the default rule every tick. */
function tickAshWall(pool, slot, deps) {
  const { physics, combat, actors, time } = deps;
  if (!physics || !combat || !actors) return;
  const owner = actors.byId(pool._ownerId[slot]);
  if (!owner) return;

  const mask = pool._team[slot] === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
  const count = physics.overlapRect(
    pool._x[slot], pool._z[slot], pool._halfThickness[slot], pool._halfLength[slot], pool._facing[slot], mask, tickTargetsOut,
  );
  if (count === 0) return;

  const packet = combat.buildSpellPacket(owner, 'ash_wall', pool._level[slot]);
  if (!packet) return;

  const tickDamage = pool._tickDamage[slot];
  const level = pool._level[slot];
  const step = time.step;
  for (let i = 0; i < count; i++) {
    const target = actors.byId(tickTargetsOut[i]);
    if (!target || target.dead) continue;
    packet.fireMin = tickDamage; packet.fireMax = tickDamage;
    packet.physMin = 0; packet.physMax = 0;
    packet.attackRating = 0; packet.dodgeable = false; packet.blockable = false;
    packet.onHitCount = 0; // reset before EACH resolve — status.js's own contract
    const result = combat.resolve(packet, target);
    if (result) applyCoefficientRider(deps, ASH_WALL_BURN_RIDER, level, packet, target, result, step);
  }
  combat.releasePacket(packet);
}

/** `ashen_step`'s cloud — 05 §5.1: 0.5 s cadence, zero-damage
 * `attackRating=0` packets, `slowed`/`blinded` riders driven from
 * `ASHEN_STEP_DEF.onHitStatus` (SKIL-6's engine, not re-authored here). */
function tickAshenStepCloud(pool, slot, deps) {
  const { physics, combat, actors, time } = deps;
  if (!physics || !combat || !actors) return;
  const owner = actors.byId(pool._ownerId[slot]);
  if (!owner) return;

  const mask = pool._team[slot] === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
  const count = physics.overlapCircle(pool._x[slot], pool._z[slot], pool._radius[slot], mask, tickTargetsOut);
  if (count === 0) return;

  const packet = combat.buildSpellPacket(owner, 'ashen_step', pool._level[slot]);
  if (!packet) return;

  const level = pool._level[slot];
  const step = time.step;
  for (let i = 0; i < count; i++) {
    const target = actors.byId(tickTargetsOut[i]);
    if (!target || target.dead) continue;
    // Zero damage, forced — see file header ("ashen_step's packet is
    // additionally force-zeroed").
    packet.fireMin = 0; packet.fireMax = 0; packet.physMin = 0; packet.physMax = 0;
    packet.attackRating = 0; packet.dodgeable = false; packet.blockable = false;
    packet.onHitCount = 0;
    const result = combat.resolve(packet, target);
    if (result) applyOnHitStatuses(deps, ASHEN_STEP_DEF, level, packet, target, result, step);
  }
  combat.releasePacket(packet);
}

const GROUND_TICK_HANDLERS = Object.freeze({
  meteor: tickMeteorPool,
  ash_wall: tickAshWall,
  ashen_step: tickAshenStepCloud,
});

// ===========================================================================
// `ash_wall` projectile absorption — see file header
// ===========================================================================

/** Kills every ACTIVE, ENEMY-team (relative to the wall's own owner) live
 * projectile currently overlapping the wall's rect — same disk-vs-box math
 * as `src/physics/cast.js#overlapRect` (cited, not imported — see file
 * header). Player projectiles (same team as the wall) pass through
 * untouched, per 05 §5.4.
 * @param {GroundEffectPool} pool @param {number} slot @param {object} deps */
function absorbProjectiles(pool, slot, deps) {
  const projPool = deps.projectilePool;
  const skills = deps.skills;
  if (!projPool || !skills) return; // no pool wired — degrade, don't crash (see file header, the internal-field-read gap)

  const wallTeam = pool._team[slot];
  const x = pool._x[slot];
  const z = pool._z[slot];
  const facing = pool._facing[slot];
  const halfThickness = pool._halfThickness[slot];
  const halfLength = pool._halfLength[slot];
  const cosF = Math.cos(facing);
  const sinF = Math.sin(facing);
  const cap = projPool.capacity;

  for (let s = 0; s < cap; s++) {
    if (!projPool._active[s]) continue;
    if (projPool._team[s] === wallTeam) continue; // "player projectiles pass through freely" — generalised to same-team

    const dx = projPool._x[s] - x;
    const dz = projPool._z[s] - z;
    const lx = dx * cosF + dz * sinF; // facing-axis — bounded by halfThickness
    const lz = -dx * sinF + dz * cosF; // perpendicular-axis — bounded by halfLength
    let cx = lx; if (cx > halfThickness) cx = halfThickness; else if (cx < -halfThickness) cx = -halfThickness;
    let cz = lz; if (cz > halfLength) cz = halfLength; else if (cz < -halfLength) cz = -halfLength;
    const ddx = lx - cx;
    const ddz = lz - cz;
    const r = projPool._radius[s];
    if (ddx * ddx + ddz * ddz > r * r) continue;

    skills.killProjectile(s + 1); // ProjectilePool's own slot+1 id convention — the public, contracted write
  }
}

// ===========================================================================
// `fixedUpdate` — the main per-step advance
// ===========================================================================

/** Advances every live ground effect one fixed step: lifetime (expiry ->
 * `releaseSlot`, the SAME deregistration every other exit path uses),
 * per-step projectile absorption for any wall-shaped, projectile-blocking
 * effect, and the `tickSteps`-cadenced field application. Called from
 * `SkillsSystem#fixedUpdate` — never reads `dt`/wall clock itself, `h` is
 * the caller's own fixed step; the tick cadence is scheduled against
 * `deps.time.step` (rule 4), never timed.
 * @param {GroundEffectPool} pool @param {number} h @param {object} deps */
export function advanceGroundEffects(pool, h, deps) {
  const step = deps.time.step;
  for (let slot = 0; slot < pool._capacity; slot++) {
    if (!pool._active[slot]) continue;

    pool._life[slot] -= h;
    if (pool._life[slot] <= 0) {
      releaseSlot(pool, slot, deps); // expiry — same deregistration as every other exit path
      continue;
    }

    if (pool._blocksProjectiles[slot]) absorbProjectiles(pool, slot, deps);

    if (step >= pool._nextTickStep[slot]) {
      const handler = GROUND_TICK_HANDLERS[pool._skillId[slot]];
      if (handler) handler(pool, slot, deps);
      pool._nextTickStep[slot] += pool._tickIntervalSteps[slot];
    }
  }
}

// ===========================================================================
// Spec builders — used by index.js (ashen_step wiring) and this ticket's
// own tests (meteor / ash_wall, not cast-wired — see file header)
// ===========================================================================

/**
 * `meteor`'s pool, as it would exist the instant the 1.20 s fall (mobility/
 * cast concern, not this file's) lands. `x,z` is the frozen impact point.
 * @param {object} actor @param {number} level @param {number} x @param {number} z
 * @returns {GroundEffectSpawn}
 */
export function buildMeteorPoolSpec(actor, level, x, z) {
  const tickFirePerSec = levelValue(METEOR_DEF.extra.groundPool.tickFire, level);
  return {
    skillId: 'meteor', level, x, z, shape: 'circle',
    radius: METEOR_DEF.extra.groundPool.radiusM, // flat 3.2 m, no per-level term — 05 §4.4
    seconds: levelValue(METEOR_DEF.duration, level),
    tickSteps: TICK_STEPS_4HZ,
    tickDamage: tickFirePerSec * (TICK_STEPS_4HZ / 60),
    hazard: true,
    ownerId: actor.id, team: actor.team,
  };
}

/**
 * `ash_wall`'s line, oriented perpendicular to the caster->cursor ray. `x,z`
 * is the wall's own centre (the click point, per 05 §5.4). No 20-source
 * synergy applied to `tickDamage` — out of this ticket's D-37 scope (engine
 * only), see file header.
 * @param {object} actor @param {number} level @param {number} x @param {number} z
 * @param {number} facing the caster->cursor ray angle, radians
 * @returns {GroundEffectSpawn}
 */
export function buildAshWallSpec(actor, level, x, z, facing) {
  const fd = ASH_WALL_DEF.flatDamage; // degenerate range — see data/skills.js's own comment
  const tickFirePerSec = fd.minBase + fd.minPerLevel * (level - 1);
  return {
    skillId: 'ash_wall', level, x, z, shape: 'line', facing,
    lengthM: levelValue(ASH_WALL_DEF.radius, level), // "wall LENGTH, not a circle" — data/skills.js's own comment
    thicknessM: ASH_WALL_DEF.extra.thicknessM, // flat 1.6 m
    seconds: levelValue(ASH_WALL_DEF.duration, level),
    tickSteps: TICK_STEPS_4HZ,
    tickDamage: tickFirePerSec * (TICK_STEPS_4HZ / 60),
    hazard: true, blocksProjectiles: true,
    ownerId: actor.id, team: actor.team,
  };
}

/**
 * `ashen_step`'s cloud, at the DEPARTURE point (05 §5.1) — `x,z` is the
 * actor's position BEFORE the teleport, which the caller (`./index.js
 * #cast`) must capture before invoking the mobility engine's own handler.
 * Explicitly `hazard:false` — acceptance criterion #3.
 * @param {object} actor @param {number} level @param {number} x @param {number} z
 * @returns {GroundEffectSpawn}
 */
export function buildAshenStepCloudSpec(actor, level, x, z) {
  return {
    skillId: 'ashen_step', level, x, z, shape: 'circle',
    radius: levelValue(ASHEN_STEP_DEF.radius, level),
    seconds: levelValue(ASHEN_STEP_DEF.duration, level),
    tickSteps: TICK_STEPS_ASHEN_STEP,
    tickDamage: 0,
    hazard: false, // 05 §5.1 / §12.6: "the cloud is deliberately not a nav hazard"
    ownerId: actor.id, team: actor.team,
  };
}

export { METEOR_DEF, ASH_WALL_DEF, ASHEN_STEP_DEF };
