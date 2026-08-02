// src/skills/mobility.js
//
// SKIL-8 — Mobility: `ram_charge`, `ashen_step`, `phase_leap`, `thunder_step`
// (`05-skills.md` §14 row 8: "nav ray clipping, untargetable transit,
// arrival packets" / D-45's row-8 quote: "a charge into a wall stops at the
// wall and still detonates; a leap always lands on the target's far side").
// `src/skills/index.js` owns wiring the four cast handlers below onto the
// `skills` subsystem's dispatch table and this engine's own `fixedUpdate`
// (needed for `phase_leap`'s one-step-delayed strike) — this file owns the
// four skills' own mechanics only.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/` with
// `checkGlobals: true`). No `Math.random()` — nothing here draws randomness.
//
// ---------------------------------------------------------------------------
// O-25 — the route chosen, and why
// ---------------------------------------------------------------------------
// `physics.moveBody` is "move then push out" and tunnels through a thin
// obstacle on a multi-metre delta (proven in M1). This file never calls it
// (directly or via `actors.moveTo`) with anything but a zero displacement.
// Instead, every dash/blink below is resolved as a computed DESTINATION,
// written with `actors.teleport(actor, x, z)` — a direct position set
// (`src/actors/motion.js#teleportActor`: nav-snap, then `physics.setBody`,
// never `physics.moveBody`), which has no delta to tunnel through at all.
//
// The destination itself is computed with `physics.sweepProjectile` — route
// B of this ticket's two offered fixes. `sweepProjectile` is a genuine
// continuous sweep over the WHOLE displacement in one call (earliest time of
// impact along the segment), not a sampled/discrete probe, so it cannot skip
// past a thin wall the way a stepped sampler could if its step were chosen
// too coarse. Chosen over sub-stepped `moveTo` because these are semantically
// teleports/dashes-with-an-instant-arrival (`05`'s own "instant" wording for
// three of the four skills), not a multi-tick walk — a single authoritative
// swept query matches that shape more directly than replaying N small
// `moveTo` calls through an action state machine none of these skills use.
//
// The `nav` half of the clip (below) IS sub-stepped — see "The nav
// backward walk" section.
//
// ---------------------------------------------------------------------------
// The nav backward walk — `nav.snap`'s null contract, and 05's own
// "walks the ray backward" wording
// ---------------------------------------------------------------------------
// `ram_charge`/`ashen_step`/`thunder_step`'s own spec rows use nearly
// identical language: "clipped by nav to the last walkable cell" / "nav
// walks the ray backward to the last walkable cell". This is a RAY search
// (always along the same line, toward the caster), not `nav.snap`'s own
// radius-based nearest-point search — so this file implements it directly:
// `clipDashTravel` walks backward from the physics-clipped endpoint toward
// the caster in `NAV_BACKSTEP_M` increments, calling `nav.snap(x, z, 0,
// out)` at each sample. `maxRadius === 0` is `nav.snap`'s own documented
// "is this EXACT point walkable" fast path (`src/nav/snap.js`'s own header)
// — never a sideways-searching radius, which is what keeps every sample on
// the ray. This is simultaneously this file's OWN sub-stepping (O-25's other
// offered route) for the nav half of the clip: every sample is a cheap,
// allocation-free `nav.snap` call, never a raw multi-metre delta.
//
// If NO sample from the physics-clipped point back to the caster's own
// position is walkable (the caster's own standing point should always be
// walkable in practice, but this is not assumed), `clipDashTravel` returns
// `null` — `nav.snap`'s own null contract, propagated verbatim. Every cast
// handler below checks this BEFORE spending any resource (`05` §1.4 rule 1:
// "a refused cast never moves the character"; §5.1's own wording for
// `ashen_step`: "refuses the cast with reason:'no-path' and refunds nothing
// because nothing was spent").
//
// Why a wall still stops the dash even though nav and physics are fed the
// same geometry in production: the physics-clipped endpoint sits AT the
// wall's surface, which is normally still inside the wall's own (inflated-
// by-agent-radius) nav-blocked cell — so the backward walk is not a no-op
// even in the straightforward single-wall case; it is what actually finds
// the last cell in front of the wall.
//
// ---------------------------------------------------------------------------
// Why `physics.sweepProjectile`'s mask is `MASK.WORLD` only
// ---------------------------------------------------------------------------
// `05` §3.1: "Actors passed through during the dash are not hit — the
// charge is a reposition with a payload, not a line attack" and "the
// dashing actor carries `ACTOR_FLAG.noCollide` for the flight so it cannot
// be body-blocked". This file has no way to SET `ACTOR_FLAG.noCollide` (see
// "Gaps" below), but never needs to: the sweep's mask never includes
// `LAYER.PLAYER`/`MONSTER`/`NEUTRAL`, so another actor's body is never a
// candidate the sweep can report a `Hit` against in the first place. Same
// functional outcome, achieved structurally rather than through a flag this
// file cannot write.
//
// ---------------------------------------------------------------------------
// Arrival packets — the direct-`combat.resolve()` route, not
// `combat:hit-request`, for the two skills with onHitStatus riders
// ---------------------------------------------------------------------------
// `ram_charge` (`stunned`) and `thunder_step` (`shocked`) both carry a fixed-
// magnitude `onHitStatus` rider. `src/skills/status.js`'s own header is
// explicit that the real DR-chain/rank-multiplier path
// (`combat.applyStatusFromPacket`) is only reached correctly if the packet
// is resolved with `onHitCount === 0`, THEN the rider slots are populated,
// THEN `applyStatusFromPacket` is called — a caller going through the
// `combat:hit-request` EVENT (as `cleaving_strike`/`whirlwind` do) has no
// hook to interleave that sequence. So this file calls `combat.resolve()`
// DIRECTLY per target (matching `status.js#createIncinerateReaction`'s own
// precedent) and drives `applyOnHitStatuses` (SKIL-6, `./status.js`,
// unedited) itself — see `resolveRadiusArrival` below. `combat.resolve()`
// already runs the full R14 economy (rage, `actor:damage`) whether called
// directly or via the event, so rage crediting (CMBT-8/D-51, keyed on
// `(generation, step)` since none of these skills call `actors.beginAction`
// — see "Deliberate simplification" below) is unaffected by this choice.
//
// `phase_leap`'s strike carries NO rider, so it is "a weapon hit like any
// other" exactly as `rune_strike` is — this file reuses THAT precedent
// (`combat:hit-request`, not a direct `resolve()`), which is what lets
// `blade_seal`/`cascade`/mana-return/Resonance (SKIL-13, `imbue.js`'s own
// `actor:damage` listener) apply to it "for free", unedited.
//
// `ashen_step` deals **zero** damage at every level (`05` §5.1) — no packet
// at all. Its ash cloud is explicitly SKIL-9's ground-effect engine, not
// rebuilt here (this ticket's own brief).
//
// `combat.resolve()`'s returned `DamageResult` is never passed an `out` and
// is never explicitly released here — the SAME choice
// `status.js#createIncinerateReaction` (already accepted) already makes for
// its own direct `resolve()` calls; not a new pattern.
//
// ---------------------------------------------------------------------------
// Deliberate simplification: no `actors.beginAction` FSM for `ram_charge`
// ---------------------------------------------------------------------------
// `05` §3.1's own timing row describes 0.12 s of `attack.windup`, a
// `distance/16`-second scripted dash, and 0.20 s of `recover`, with the
// actor in `actionLock` throughout. This file resolves position + arrival
// synchronously inside `cast()` instead, the same "instant" treatment the
// other three skills get from `05` itself. Reasons: (1) the natural hook for
// a deferred hit, `anim:hitframe`, fires at the windup→active EDGE
// (`impl/cleaving_strike.js`'s own header), not at active→recover where
// `ram_charge`'s arrival actually happens, so it is the wrong tool without a
// second, bespoke edge this ticket's file list has no natural home for; (2)
// this ticket's own acceptance criteria (wall-stop-and-detonate, the four
// cooldown floors, the nav null contract, far-side landing) do not exercise
// the windup/dash/recover timing at all. Flagged here and in this ticket's
// report as a real, deliberate scope narrowing, not a silent gap — a
// follow-up ticket that wants the true multi-step dash presentation needs a
// dedicated active→recover style hook this file does not invent.
//
// ---------------------------------------------------------------------------
// Gaps this file found and does NOT paper over
// ---------------------------------------------------------------------------
// 1. **`ACTOR_FLAG.untargetable` during transit** (`05` §5.1/§6.4/§7.4's own
//    "untargetable for N s of travel/transit"): `actors` exposes no public
//    method to set/clear an `Actor`'s `flags` bitfield (`02-api-contracts.md`
//    §7 has no such row; the only writer of `actor.flags` anywhere in this
//    tree is `src/actors/pool.js`'s own reset-on-recycle). Rule 7 forbids
//    inventing a contract method on a subsystem this ticket does not own,
//    and the "never write an Actor field directly" rule forbids reaching
//    into `actor.flags` by hand even if this file could name the bit
//    correctly. NOT implemented — reported for the orchestrator to add an
//    `actors.setFlags(actor, mask, on) => void` (or similar) contract row.
//    (Functionally lower-stakes than it sounds: since the position write is
//    a single atomic `actors.teleport` — not a multi-step glide — there is
//    no multi-frame window in THIS simulation during which a homing
//    projectile could re-acquire a "mid-flight" position the way a slower,
//    animated transit would create one.)
// 2. **`ram_charge`'s `dodgeable: false` / `knockback: 0` packet overrides**
//    (`05` §3.1's own B8 row): `SkillDefinition` (`data/skills.js`, frozen,
//    not this ticket's file) carries no field for either — unlike
//    `rune_strike`'s `extra.manaReturnMultiplier`, there is no `extra` key
//    here to read a data-driven override from. Not fabricated as a bare
//    literal in this file (rule 6) — reported as a schema gap, the same
//    category `data/skills.js`'s own header already records for cone/nova
//    arc angles.
// 3. **O-87** (`actors.moveSpeed` never reads `StatBlock.movementSpeed`) does
//    not bind this file — every skill here teleports/sweeps rather than
//    scaling walk speed. Reported per the ticket brief, not re-investigated.

import { levelValue, cooldownOf, startCooldown } from './cost.js';
import { applyOnHitStatuses } from './status.js';
import { SKILLS } from './data/skills.js';

const RAM_CHARGE_ID = 'ram_charge';
const ASHEN_STEP_ID = 'ashen_step';
const PHASE_LEAP_ID = 'phase_leap';
const THUNDER_STEP_ID = 'thunder_step';

const RAM_CHARGE_DEF = SKILLS.find((d) => d.id === RAM_CHARGE_ID);
const ASHEN_STEP_DEF = SKILLS.find((d) => d.id === ASHEN_STEP_ID);
const PHASE_LEAP_DEF = SKILLS.find((d) => d.id === PHASE_LEAP_ID);
const THUNDER_STEP_DEF = SKILLS.find((d) => d.id === THUNDER_STEP_ID);

/** rad/s — large enough that one `actors.face()` call always completes a
 * turn within a single fixed step. Redeclared locally rather than imported
 * from `impl/cleaving_strike.js` (same VALUE and reasoning as that file's
 * own `INSTANT_TURN_RATE`) because `src/skills/impl/` is not this ticket's
 * to depend on structurally — a future edit there should not be able to
 * silently change this file's behaviour. */
const INSTANT_TURN_RATE = Math.PI * 60 * 2;

/** The nav backward-walk sample spacing — see file header. Comfortably
 * finer than nav's own 0.5 m cell size (twice the sample density), and far
 * finer than the thinnest wall this project's own physics tests use
 * (0.2 m). ASSIGNED — no spec number governs this internal search
 * granularity. */
const NAV_BACKSTEP_M = 0.25;

/** Headroom above the longest declared travel range among the four skills
 * (`ashen_step`'s 10 m cap) divided by `NAV_BACKSTEP_M`: `10 / 0.25 = 40`. */
const MAX_NAV_BACKSTEPS = 64;

/** `overlapCircle`'s own `out:int[]` capacity for an arrival-radius query —
 * same "comfortable headroom above the documented pack ceiling" precedent
 * `impl/cleaving_strike.js#MAX_CONE_TARGETS`/`channel.js#MAX_QUERY_TARGETS`
 * already establish. */
const MAX_ARRIVAL_TARGETS = 32;

/** `phase_leap`'s far-side landing clearance beyond the target's own radius
 * — ASSIGNED, no spec number gives this exact gap; small enough to read as
 * "just behind", large enough that the caster's own circle does not overlap
 * the target's. */
const PHASE_LEAP_LANDING_GAP_M = 0.15;

/** Matches `src/actors/motion.js#TELEPORT_SNAP_RADIUS`'s own reasoning
 * ("is this specific point walkable, or close enough") — `phase_leap`'s far-
 * side point is a single computed target, not a ray, so a small-radius
 * nearest-point search (not the backward ray walk) is the right tool here. */
const PHASE_LEAP_SNAP_RADIUS_M = 2.0;

// ===========================================================================
// Shared geometry helpers — Alloc: no, every scratch object is caller-owned
// ===========================================================================

/**
 * Unit vector from `(fromX,fromZ)` toward `(toX,toZ)`, plus the raw
 * distance. `{ux:0,uz:0,dist:0}` for a degenerate (zero-length) input —
 * never `NaN`.
 * @param {number} fromX @param {number} fromZ @param {number} toX @param {number} toZ
 * @param {{ux:number,uz:number,dist:number}} out
 * @returns {{ux:number,uz:number,dist:number}}
 */
export function unitTowards(fromX, fromZ, toX, toZ, out) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const dist = Math.sqrt(dx * dx + dz * dz); // never Math.hypot — ARCHITECTURE.md
  if (!(dist > 1e-9)) {
    out.ux = 0;
    out.uz = 0;
    out.dist = 0;
    return out;
  }
  out.ux = dx / dist;
  out.uz = dz / dist;
  out.dist = dist;
  return out;
}

/**
 * The O-25 fix, in full: clips a caster's intended `(dx,dz)` displacement to
 * (1) the earliest static-geometry impact along the whole swept path
 * (`physics.sweepProjectile`, never a raw multi-metre `moveBody`/`moveTo`),
 * then (2) the nearest still-walkable point walking BACKWARD along that same
 * ray toward the caster (`nav.snap(x,z,0,out)` sampled every
 * `NAV_BACKSTEP_M`, never a raw large delta). Returns `null` — `nav.snap`'s
 * own documented null contract, propagated verbatim — when no walkable
 * sample exists anywhere along the ray back to the caster's own position.
 * `physics`/`nav` may be `null`/absent (degraded ctx); each is skipped
 * gracefully, the same convention `src/actors/motion.js#teleportActor`
 * already uses for an absent `nav`.
 * @param {object|null} physics
 * @param {object|null} nav
 * @param {object} actor needs `.x`,`.z`,`.radius`,`.id`
 * @param {number} dx @param {number} dz
 * @param {object} hitScratch a `Hit`-shaped scratch object, owned by the caller
 * @param {object} navScratch a `{x,y,z}` scratch object, owned by the caller
 * @param {{x:number,z:number}} out
 * @returns {{x:number,z:number}|null}
 */
export function clipDashTravel(physics, nav, actor, dx, dz, hitScratch, navScratch, out) {
  const rawDist = Math.sqrt(dx * dx + dz * dz);
  if (!(rawDist > 1e-9)) {
    if (nav && typeof nav.snap === 'function') {
      const snapped = nav.snap(actor.x, actor.z, 0, navScratch);
      if (!snapped) return null;
    }
    out.x = actor.x;
    out.z = actor.z;
    return out;
  }

  let endX = actor.x + dx;
  let endZ = actor.z + dz;

  if (physics && typeof physics.sweepProjectile === 'function') {
    const hit = physics.sweepProjectile(actor.x, actor.z, dx, dz, actor.radius, physics.MASK.WORLD, actor.id, hitScratch);
    if (hit.hit) {
      endX = hit.x;
      endZ = hit.z;
    }
  }

  if (!nav || typeof nav.snap !== 'function') {
    out.x = endX;
    out.z = endZ;
    return out;
  }

  const backDx = endX - actor.x;
  const backDz = endZ - actor.z;
  const backDist = Math.sqrt(backDx * backDx + backDz * backDz);
  if (!(backDist > 1e-9)) {
    const snapped = nav.snap(actor.x, actor.z, 0, navScratch);
    if (!snapped) return null;
    out.x = actor.x;
    out.z = actor.z;
    return out;
  }

  const ux = backDx / backDist;
  const uz = backDz / backDist;
  const steps = Math.min(MAX_NAV_BACKSTEPS, Math.ceil(backDist / NAV_BACKSTEP_M));

  for (let i = 0; i <= steps; i++) {
    let t = backDist - i * NAV_BACKSTEP_M;
    if (t < 0) t = 0;
    const px = actor.x + ux * t;
    const pz = actor.z + uz * t;
    const snapped = nav.snap(px, pz, 0, navScratch);
    if (snapped) {
      out.x = snapped.x;
      out.z = snapped.z;
      return out;
    }
    if (t === 0) break;
  }
  return null;
}

// ===========================================================================
// The engine
// ===========================================================================

/**
 * Builds one mobility engine — a self-contained closure over its own
 * preallocated scratch, never shared with any other `SkillsSystem` instance
 * (mirrors `createChannelEngine()`/`createImbueEngine()`'s own "one engine
 * instance per SkillsSystem" discipline).
 * @returns {object}
 */
export function createMobilityEngine() {
  // --- shared scratch — Alloc: no, reused across every cast() call --------
  const dirScratch = { ux: 0, uz: 0, dist: 0 };
  const hitScratch = { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
  const navScratch = { x: 0, y: 0, z: 0 };
  const clipScratch = { x: 0, z: 0 };
  const landingScratch = { x: 0, z: 0 };
  const arrivalTargetsOut = new Int32Array(MAX_ARRIVAL_TARGETS);
  const strikeHitPayload = { source: null, target: null, packet: null };

  // --- phase_leap's one-step-delayed strike — poolIndex-indexed payload,
  // plus a dense active list for cheap fixedUpdate iteration (the same two-
  // part shape channel.js's own whirlwind schedule uses: per-actor scratch
  // arrays, id-encodes-generation validity via `actors.byId(id)`). ---------
  let payloadCapacity = 64;
  let pendingTargetId = new Int32Array(payloadCapacity);
  let pendingLevel = new Int32Array(payloadCapacity);
  let pendingStep = new Float64Array(payloadCapacity);

  function ensurePayloadCapacity(poolIndex) {
    if (poolIndex < payloadCapacity) return;
    const grown = Math.max(poolIndex + 1, payloadCapacity * 2);
    const nextTargetId = new Int32Array(grown);
    const nextLevel = new Int32Array(grown);
    const nextStep = new Float64Array(grown);
    nextTargetId.set(pendingTargetId);
    nextLevel.set(pendingLevel);
    nextStep.set(pendingStep);
    payloadCapacity = grown;
    pendingTargetId = nextTargetId;
    pendingLevel = nextLevel;
    pendingStep = nextStep;
  }

  let activeCapacity = 16;
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
    // A stale/duplicate entry for the same poolIndex is not expected (the
    // cooldown floor, 2.5 s minimum, is far longer than the one-step delay)
    // but is handled defensively: overwrite in place rather than growing the
    // dense list with a second row for the same slot.
    const existing = reverseSlot[poolIndex];
    if (existing !== -1) {
      activeId[existing] = id;
      return;
    }
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

  // -------------------------------------------------------------------------
  // Arrival damage — shared by ram_charge and thunder_step (both fixed-
  // magnitude riders, both resolved by radius at the arrival point). See the
  // file header, "Arrival packets", for why this calls combat.resolve()
  // directly rather than emitting combat:hit-request.
  // -------------------------------------------------------------------------
  function resolveRadiusArrival(deps, def, level, actor, x, z, radius, useSpellPacket) {
    const { physics, combat, actors, time } = deps;
    if (!physics || !combat || !actors) return;

    const mask = actor.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER;
    const count = physics.overlapCircle(x, z, radius, mask, arrivalTargetsOut);
    if (count === 0) return;

    const packet = useSpellPacket ? combat.buildSpellPacket(actor, def.id, level) : combat.buildAttackPacket(actor, def.id, level);
    if (!packet) return; // DamagePacket pool exhausted — combat's own warn already fired

    const step = time.step;
    for (let i = 0; i < count; i++) {
      const targetId = arrivalTargetsOut[i];
      if (targetId === actor.id) continue;
      const target = actors.byId(targetId);
      if (!target || target.dead) continue;

      packet.onHitCount = 0; // status.js's own contract — riders populated AFTER resolve, never before
      const result = combat.resolve(packet, target);
      if (!result) continue;
      applyOnHitStatuses(deps, def, level, packet, target, result, step);
    }

    combat.releasePacket(packet);
  }

  // -------------------------------------------------------------------------
  // ram_charge
  // -------------------------------------------------------------------------
  function castRamCharge(actor, def, level, targetX, targetZ, deps) {
    const { actors, physics, nav, skills, time } = deps;

    const dir = unitTowards(actor.x, actor.z, targetX, targetZ, dirScratch);
    const maxRange = def.extra.travel.rangeM;
    const dist = dir.dist < maxRange ? dir.dist : maxRange;
    const dx = dir.ux * dist;
    const dz = dir.uz * dist;

    const clipped = clipDashTravel(physics, nav, actor, dx, dz, hitScratch, navScratch, clipScratch);
    if (!clipped) return false; // nav.snap's null contract — refused before anything is spent

    const cost = skills.costOf(actor, def.id);
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    actors.face(actor, targetX, targetZ, INSTANT_TURN_RATE);
    actors.teleport(actor, clipped.x, clipped.z);

    const cooldownSeconds = cooldownOf(def, level);
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    resolveRadiusArrival(deps, def, level, actor, clipped.x, clipped.z, levelValue(def.radius, level), false);
    return true;
  }

  // -------------------------------------------------------------------------
  // ashen_step
  // -------------------------------------------------------------------------
  function castAshenStep(actor, def, level, targetX, targetZ, deps) {
    const { actors, physics, nav, skills, time } = deps;

    const dir = unitTowards(actor.x, actor.z, targetX, targetZ, dirScratch);
    const maxRange = levelValue(def.extra.travel.range, level); // cap 10 — levelValue's own cap support
    const dist = dir.dist < maxRange ? dir.dist : maxRange;
    const dx = dir.ux * dist;
    const dz = dir.uz * dist;

    const clipped = clipDashTravel(physics, nav, actor, dx, dz, hitScratch, navScratch, clipScratch);
    if (!clipped) return false; // "an entirely blocked ray refuses the cast... and refunds nothing" — 05 §5.1

    const cost = skills.costOf(actor, def.id);
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    actors.face(actor, targetX, targetZ, INSTANT_TURN_RATE);
    actors.teleport(actor, clipped.x, clipped.z);

    const cooldownSeconds = cooldownOf(def, level);
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    // Zero damage at every level (05 §5.1) — no arrival packet. The ash
    // cloud ground effect is SKIL-9's — not built here (see file header).
    return true;
  }

  // -------------------------------------------------------------------------
  // thunder_step
  // -------------------------------------------------------------------------
  function castThunderStep(actor, def, level, targetX, targetZ, deps) {
    const { actors, physics, nav, skills, time } = deps;

    const dir = unitTowards(actor.x, actor.z, targetX, targetZ, dirScratch);
    const maxRange = def.extra.travel.rangeM;
    const dist = dir.dist < maxRange ? dir.dist : maxRange;
    const dx = dir.ux * dist;
    const dz = dir.uz * dist;

    const clipped = clipDashTravel(physics, nav, actor, dx, dz, hitScratch, navScratch, clipScratch);
    if (!clipped) return false;

    const cost = skills.costOf(actor, def.id);
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    actors.face(actor, targetX, targetZ, INSTANT_TURN_RATE);
    actors.teleport(actor, clipped.x, clipped.z);

    const cooldownSeconds = cooldownOf(def, level);
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    resolveRadiusArrival(deps, def, level, actor, clipped.x, clipped.z, levelValue(def.radius, level), true);
    return true;
  }

  // -------------------------------------------------------------------------
  // phase_leap
  // -------------------------------------------------------------------------
  function castPhaseLeap(actor, def, level, targetX, targetZ, deps, targetId) {
    void targetX;
    void targetZ;
    const { actors, nav, skills, time } = deps;

    const target = actors.byId(targetId);
    if (!target || target.dead) return false; // defensive; index.js already checked liveness for target:'actor'

    const maxRange = def.extra.travel.teleportRangeM;
    const dir = unitTowards(actor.x, actor.z, target.x, target.z, dirScratch);
    if (dir.dist > maxRange) return false; // "refused with reason:'no-target'" beyond 10 m — 05 §6.4

    let ux = dir.ux;
    let uz = dir.uz;
    if (dir.dist < 1e-9) {
      // Degenerate: caster already occupies the target's own point. Land
      // along the caster's current facing rather than dividing by zero.
      ux = Math.cos(actor.facing);
      uz = Math.sin(actor.facing);
    }
    const offset = (target.radius || 0) + (actor.radius || 0) + PHASE_LEAP_LANDING_GAP_M;
    const farX = target.x + ux * offset;
    const farZ = target.z + uz * offset;

    if (nav && typeof nav.snap === 'function') {
      const snapped = nav.snap(farX, farZ, PHASE_LEAP_SNAP_RADIUS_M, navScratch);
      if (!snapped) return false; // nav.snap's null contract — no walkable landing spot behind the target
      landingScratch.x = snapped.x;
      landingScratch.z = snapped.z;
    } else {
      landingScratch.x = farX;
      landingScratch.z = farZ;
    }

    const cost = skills.costOf(actor, def.id);
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    actors.face(actor, target.x, target.z, INSTANT_TURN_RATE);
    actors.teleport(actor, landingScratch.x, landingScratch.z);

    const cooldownSeconds = cooldownOf(def, level);
    if (cooldownSeconds > 0) startCooldown(actor, def.id, cooldownSeconds, time.step);

    ensurePayloadCapacity(actor.poolIndex);
    const idx = actor.poolIndex;
    pendingTargetId[idx] = targetId;
    pendingLevel[idx] = level;
    pendingStep[idx] = time.step + 1; // "the strike resolves on the next fixed step" — 05 §6.4
    addActive(idx, actor.id);

    return true;
  }

  /** Driven once per real fixed step from `SkillsSystem#fixedUpdate` —
   * resolves `phase_leap`'s deferred strike exactly one step after the
   * teleport. Iterates the dense active list backward so a mid-loop swap-
   * remove never skips or double-processes an entry (same discipline
   * `channel.js#fixedUpdate` already uses). `actors.byId(id)` returns `null`
   * the instant the owning pool slot has recycled (`01-data-model.md`'s
   * `id = 1 + poolIndex + generation * capacity` bijection) — the transit
   * state's own recycle-safety, no separate generation stamp needed. */
  function fixedUpdate(deps) {
    const { actors, combat, events, time } = deps;
    if (!actors || !combat || !events) return;
    const step = time.step;

    for (let i = activeCount - 1; i >= 0; i--) {
      const id = activeId[i];
      const poolIndex = activePoolIndex[i];
      if (step < pendingStep[poolIndex]) continue; // not due yet — stays in the active list

      removeActive(poolIndex);

      const owner = actors.byId(id);
      if (!owner) continue; // pool slot recycled since cast — nothing to resolve

      const targetId = pendingTargetId[poolIndex];
      const level = pendingLevel[poolIndex];
      const target = actors.byId(targetId);
      if (!target || target.dead) continue; // target died/despawned meanwhile — rune_strike.js's own precedent

      const packet = combat.buildAttackPacket(owner, PHASE_LEAP_ID, level);
      if (!packet) continue; // DamagePacket pool exhausted

      strikeHitPayload.source = owner;
      strikeHitPayload.target = target;
      strikeHitPayload.packet = packet;
      events.emit('combat:hit-request', strikeHitPayload);

      combat.releasePacket(packet);
    }
  }

  return {
    ram_charge: { skillId: RAM_CHARGE_ID, cast: castRamCharge },
    ashen_step: { skillId: ASHEN_STEP_ID, cast: castAshenStep },
    phase_leap: { skillId: PHASE_LEAP_ID, cast: castPhaseLeap },
    thunder_step: { skillId: THUNDER_STEP_ID, cast: castThunderStep },
    fixedUpdate,
  };
}

// Re-exported for tests/report clarity — the four defs this file's own
// handlers close over, resolved once at module load (SKILLS is frozen).
export { RAM_CHARGE_DEF, ASHEN_STEP_DEF, PHASE_LEAP_DEF, THUNDER_STEP_DEF };
