// src/skills/summon.js
//
// SKIL-11 — summons and free-casts: `echo_blade` (`05-skills.md` §6.5,
// `visualOnly`, no threat entry) and `unity` (`05` §7.5, the landed-hit
// free-cast of `discharge`). `05` §14 row 11: "echo_blade as a visualOnly
// summon with no threat entry; unity's landed-hit hook and its three
// locks", verified by §12.4's 300% IAS allocation test. `./index.js` owns
// wiring this module's two cast handlers onto the dispatch table, the
// `actor:damage`/`actor:death`/`zone:teardown` listeners, the `fixedUpdate`
// call, and the six `02-api-contracts.md` §10 read/write methods this
// ticket touches (`summonOf`, plus special-casing `'unity'` inside the
// already-existing `applyBuff`/`removeBuff`/`hasBuff`/`buffRemaining`/
// `buffList` — see index.js's own comments at each call site); this file
// owns the mechanics only.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/`
// with `checkGlobals: true`). No `Math.random()` — nothing here draws
// randomness.
//
// ---------------------------------------------------------------------------
// A real reentrancy hazard found in already-accepted `src/combat/` code,
// and why every free-cast resolution is DEFERRED to `fixedUpdate`
// ---------------------------------------------------------------------------
// `src/combat/packet.js`'s own `_onHitRequest` listener resolves every
// `combat:hit-request` into a SINGLE shared scratch `DamageResult`
// (`this._hitRequestResultScratch`) and that file's own header says so in
// so many words: "nothing in this codebase re-emits `combat:hit-request`
// synchronously from inside an `actor:damage` handler today, so a single
// shared scratch `out` is safe. A future caller that DID would need this
// promoted the same way `resolveDamage`'s own `thornsEnv` is a second,
// separate scratch for its one legitimate nested call."
//
// `unity`'s own trigger is exactly that future caller: it reacts to
// `actor:damage` (a landed weapon hit) and needs to emit a NEW
// `combat:hit-request` per chain link. Doing that synchronously, from
// inside the `actor:damage` listener, is unsafe: `emitDamageEvent()`
// (`src/combat/resolve.js`) sets `payload.result = out` (BY REFERENCE, not
// a copy) and then calls `events.emit('actor:damage', payload)`, which
// walks every subscriber IN REGISTRATION ORDER, synchronously. If OUR
// subscriber, mid-walk, re-emits `combat:hit-request` for a free-cast link,
// the resulting NESTED `resolveDamage()` call runs `resetResultFields(out)`
// on the SAME shared object as its very first statement — wiping the
// original hit's `outcome`/`total`/every other field out from under any
// `actor:damage` subscriber registered AFTER ours that has not run yet
// (`combat/xp.js`'s XP award, for one). This is a real, load-bearing defect
// in already-accepted code, not a hypothetical — reported here (out of this
// ticket's file list; `src/combat/` is not owned by SKIL-11) and avoided
// entirely by construction: `onActorDamage()` below NEVER emits
// `combat:hit-request` itself. It only ENQUEUES `{ownerId, ownerGen,
// targetId, targetGen, level}` into a small preallocated queue; the actual
// chain (`spawnProjectile` + `combat:hit-request` + `releasePacket`, per
// link) runs from `fixedUpdate()`, called at the top level of the
// simulation step — never nested inside another event's dispatch, the same
// place `SkillsSystem#fixedUpdate` already resolves `advanceProjectiles`'
// own hits from (`./projectile.js`). One fixed step (<=16.7 ms) of
// deferral is imperceptible and does not change the rate-limiting math:
// each queued item still corresponds to exactly one landed hit, so
// criterion #1's "free-cast count equals landed hit count exactly" holds
// regardless of which step the chain actually resolves on.
//
// A second consequence of the queue's own contents: draining it CAN cause
// new `actor:damage` events (from the chain's own `combat:hit-request`
// emits) — but those carry `result.sourceSkillId === 'discharge'`, and
// `onActorDamage()` only ever enqueues on `result.sourceSkillId ===
// 'attack'` (see "landed weapon hit" below), so a free-cast's own damage
// can never recursively enqueue another free-cast. Confirmed structurally,
// not just by convention: this is what keeps the drain loop's own
// `pfcCount` from growing while it is being iterated.
//
// ---------------------------------------------------------------------------
// "landed weapon hit" — the reading adopted, and why
// ---------------------------------------------------------------------------
// `05` §7.5's own DamagePacket row: "Trigger | every landed weapon hit — a
// miss, a dodge and a block trigger nothing." `01-data-model.md`'s own
// `DamagePacket.sourceSkillId` comment gives the enum verbatim: `'skillId |
// attack | thorns | dot | environment'` — `'attack'` is the literal value
// reserved for a basic weapon attack, as opposed to a named skill. Read
// here as: `result.outcome === 'hit' && result.sourceSkillId === 'attack'`.
// This is the more conservative of two readings (the other being "any
// weapon-shaped attack, `rune_strike` included") — chosen because (a) it is
// the literal vocabulary the data model already defines for exactly this
// distinction, and (b) it is what keeps a free-cast's OWN resolved hits
// from ever re-triggering `unity` (see the reentrancy section above) — a
// broader "any melee/weapon hit" reading would have to separately re-derive
// that a `discharge` chain link is not itself a "weapon hit", which
// `sourceSkillId` already settles for free. Flagged in this ticket's report
// as a real ambiguity, not silently picked.
//
// ---------------------------------------------------------------------------
// The chain — one `Projectile` pool slot per link, `combat:hit-request`
// resolved directly by this file (D-47's own precedent, not projectile.js's
// flight sim)
// ---------------------------------------------------------------------------
// `discharge`'s own `ProjectileSpec` (`05` §7.1) is `speed: 0 (instant
// beam)` — a zero-displacement "projectile". `src/physics/sweep.js#sweepProjectile`
// returns an immediate no-hit for `maxDist < 1e-12` (verified by reading
// that file: `if (maxDist < 1e-12) return result;`, BEFORE it ever touches
// `mask`/bodies), so spawning one of these into `./projectile.js`'s pool is
// provably inert from `advanceProjectiles`' own per-step sweep — it can
// never double-resolve a hit the way a real moving projectile would. It
// exists purely so that `spawnProjectile`'s own D-47 refusal (`0` when the
// pool is dry) is the SAME mechanism that caps how many chain links can
// resolve, matching `02-api-contracts.md` §10's own text verbatim ("the
// pool cap is what keeps a Runeblade `unity` burst from allocating") and
// `05` §12.4's own wording ("all allocating projectile records"). Per link:
// `spawnProjectile` is attempted FIRST; a refusal (`0`) stops the chain
// immediately (no damage for that link or any later one) — this is what
// makes "projectileCount never exceeds the pool cap" and "the pool refuses
// rather than allocates" a single, structurally-enforced invariant instead
// of two separately-maintained ones. `./projectile.js` itself ages and
// expires these slots (`life -= h` every `fixedUpdate`, `killProjectile` at
// `life <= 0`) exactly like any other projectile — nothing here duplicates
// that bookkeeping.
//
// `discharge`'s own `DamagePacket` row: "Built by `combat.buildSpellPacket`
// ONCE; the same packet is resolved against each link with a growing
// falloff." Read as: the packet is built once (so `lightMin`/`lightMax`
// already carry B1-B7 plus `spellScale` — `runeblade.spellScale = 0.95`,
// `src/combat/data/weapons.js` — exactly the `0.95` half of `05` §1.5's
// `0.9975` reference multiplier), then MUTATED per link — `lightMin`/
// `lightMax` scaled by `0.75^k` (falloff) and by `1 +
// synergyBonus(actor,'unity','flatDamage')/100` (the incoming synergy that
// belongs to `unity`, not to a normal `discharge` cast — `unity`'s own
// record is the one carrying `synergies: [{skillId:'discharge',
// stat:'flatDamage', perLevel:6}]`, per `05` §7.5's own "receives ←" row) —
// BEFORE each `combat:hit-request` emit, restored from the captured
// pre-falloff base every iteration (never compounded). `resolveDamage`'s
// own R6 then draws a FRESH `U(scaledMin, scaledMax)` and a fresh crit roll
// per link, matching "each link draws its own U(min,max) and its own crit."
// The packet is released once, after the whole chain, per that same row.
//
// This file never calls `combat.buildAttackPacket`/computes a skill's
// damage number itself beyond the falloff/synergy multiplier it is
// documented to own (`02-api-contracts.md`: "adjust the fields they own").
//
// Chain target selection: `05` §7.1's own text — "nearest un-hit hostile
// within 6.0 m of the previous link, ties broken by ascending actor.id. A
// target is never hit twice by one cast." Implemented as a linear scan over
// `actors.all` (the read-only live dense list, `Alloc: no`) against a small
// fixed "already hit" list (8 slots — comfortably above `jumpsCap = 6` plus
// the seed target, the same "comfortably above the documented ceiling"
// style `./projectile.js#PIERCE_HIT_CAPACITY` already establishes for the
// identical shape of guard). `Math.sqrt(dx*dx+dz*dz)` only, never
// `Math.hypot` (banned in `Alloc: no` code).
//
// ---------------------------------------------------------------------------
// The 51/0.9975/2.734375/1.60 reference figure — a PURE reference
// computation, not something the live path multiplies by
// ---------------------------------------------------------------------------
// `05` §1.5's own text about the `0.9975`/expected-crit `1.05` factor is
// explicit that it is "a DPS convenience; a single resolved hit uses one
// crit draw and is never exactly this figure." The live free-cast path
// above does NOT multiply by `0.9975` anywhere — `0.95` (spellScale)
// already lives inside `combat.buildSpellPacket`'s own B6 step (accepted
// code), and the `1.05` expected-crit factor is not a real per-hit
// multiplier at all, only the LONG-RUN AVERAGE of `combat`'s own real
// (RNG-driven) crit roll. `REFERENCE_ELEMENTAL_MULTIPLIER` /
// `chainFalloffSum` below exist ONLY to reproduce `05` §7.5's own printed
// arithmetic for criterion #4 and this ticket's self-check — a standalone,
// pure verification, never consulted by `onActorDamage`/`fixedUpdate`.
//
// ---------------------------------------------------------------------------
// The `lightning.arc` 120 ms retrigger guard — a gameplay-side counter,
// because `src/audio/` does not exist yet
// ---------------------------------------------------------------------------
// `05` §12.4 / §7.5: "`lightning.arc` ... a 120 ms retrigger guard (`10`
// §4.4) — at 4 casts/s the guard is what stops the machine-gun." `10-audio.md`
// §4.4 itself only tables a per-FAMILY coalescing window (`spell impact`:
// 90 ms) — the specific 120 ms figure is `05`'s own override for this one
// cue, cited nowhere else. `src/audio/` is not a directory that exists in
// this tree yet (`ls src/` — confirmed absent), so nothing can actually
// play a sound; what THIS file can and does implement is the GUARD ITSELF,
// as a per-owner counter (`lastArcAllowedStep`) a future `audio` ticket can
// wire a real voice-request onto, the same way `skills` already emits
// `skill:cast`/`skill:trigger`/`projectile:spawn` for `fx`/`audio`
// subsystems that do not exist yet either. `120 ms` is converted to fixed
// steps as `Math.round(0.12 * 60) = 7` steps (116.7 ms, the nearest integer
// step count — `120 / (1000/60) = 7.2` is not an integer, so an exact
// reproduction is impossible under a 60 Hz fixed step; rounding down would
// read as 100 ms, up as 133.3 ms — `Math.round` picks the nearer of the
// two). Applied PER LINK (matching `05`'s own "each free cast | fx.beam(...)
// per link" framing) via `maybeAllowArcTrigger`, counting both attempted
// and allowed. Because every link of one chain resolves synchronously
// within the SAME fixed step in this implementation (no `fx` timing layer
// exists to stagger them), only the FIRST link of a given chain ever passes
// the guard — later links in the SAME chain are always within the guard's
// window of the first. `05`'s own "4 casts/s produce at most 8 voices/s"
// arithmetic assumes non-zero real timing between a chain's own links (the
// unbuilt `fx` layer's job); this file's own self-check reports and
// explains the resulting 1-per-chain figure rather than silently claiming
// the unreachable 2-per-chain number.
//
// ---------------------------------------------------------------------------
// O-88 — `untargetable`/`visualOnly`/`summoned` cannot be set on the echo
// ---------------------------------------------------------------------------
// `05` §6.5: the echo "carries `ACTOR_FLAG.summoned | ACTOR_FLAG.visualOnly`"
// and is untargetable. `02-api-contracts.md`'s `actors.spawn(spec) => Actor`
// `SpawnSpec` shape (`kind, archetypeId, rank, level, team, x, z, facing,
// packId, ownerId, affixes, nameOverride`) has NO `flags` field at all —
// not merely "no setter after spawn" (O-88's own framing) but no way to
// express it AT spawn time either. `src/actors/` is not in this ticket's
// file list (rule 1: report, do not edit). The echo below is spawned as a
// real, targetable `Actor` (`kind: 'summon'`) — correct for `summonOf`'s
// own ActorRef mechanics, incorrect for "untargetable"/"takes no damage"
// until whichever ticket owns `src/actors/` adds a `flags` field to
// `SpawnSpec` (or a `setFlags`/equivalent method). Reported here and in
// this ticket's report, exactly as SKIL-8 reported the same wall.
//
// ---------------------------------------------------------------------------
// Generation-stamping — the established per-actor-state-survives-recycle
// pattern (SKIL-2/CMBT-8/SKIL-13/SKIL-7/SKIL-8/SKIL-9/SKIL-10's own
// precedent), applied here exactly the same way `buff.js`'s own `war_cry`
// arrays do it: `encodeStamp(generation, value)` in a `poolIndex`-indexed
// typed array, closure-scoped inside `createSummonEngine()` so two
// independent `SkillsSystem` instances never alias each other's state.
// `summonOf`'s own ActorRef survives the SUMMON's own slot being recycled
// through a SEPARATE mechanism: the returned `{id, generation}` pair is
// checked against the live occupant by `actors.resolve()`/`actors.byId()`
// at read time (`id` itself encodes `(poolIndex, generation)`,
// `src/actors/pool.js`'s own header) — a stale ref naturally resolves to
// `null` once the slot's generation has moved on, with no cooperation
// needed from this file beyond storing the id/generation PAIR from the
// moment of spawn, once, and never re-deriving it.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline
// ---------------------------------------------------------------------------
// Every per-owner field is a typed array, grown (never shrunk) on demand —
// no `Map` anywhere. `Math.hypot` is never used (`Math.sqrt(x*x+z*z)`
// only). The pending-free-cast queue and the chain's own "already hit" list
// are preallocated and reused (drained to `count = 0` in place, never
// reallocated). `summonOf` returns a single shared scratch `ActorRef` (the
// same "shared scratch object, mutated in place, valid until the next
// call" convention `SkillsSystem#instanceOf`/`#canAllocate` already use).

import { computeCastPhases } from './impl/bolt.js';
import { levelValue } from './cost.js';

/** `src/skills/cost.js#COOLDOWN_GEN_SCALE`/`src/skills/imbue.js#GEN_SCALE`/
 * `src/skills/buff.js#GEN_SCALE`'s own precedent, redeclared per file
 * (`ARCHITECTURE.md` rule 2 — no cross-file import of a private constant). */
const GEN_SCALE = 2 ** 32;

function encodeStamp(generation, value) {
  return generation * GEN_SCALE + value;
}

/** `05` §1.5: "Runeblade, elemental ... x 0.9975 on the average roll" —
 * `0.95 (spellScale) x 1.05 (expected-crit convenience)`. A REFERENCE-ONLY
 * constant — see the file header's "51/0.9975/..." section. Never applied
 * by the live free-cast path. */
export const REFERENCE_ELEMENTAL_MULTIPLIER = 0.9975;

/** `05` §7.1: "link k (0-indexed) deals 0.75^k of the rolled damage." */
export const CHAIN_FALLOFF_PER_JUMP = 0.75;

/** `05` §12.4 / §7.5's own 120 ms figure, converted to fixed steps — see
 * the file header's "lightning.arc" section for the rounding. */
export const ARC_GUARD_STEPS = Math.round(0.12 * 60); // 7 (116.7 ms)

/**
 * `discharge`'s own chain-length formula, `05` §7.1, printed verbatim:
 * `jumps = min(jumpsCap, jumpsBase + floor(slvl / jumpsLevelDivisor))`.
 * @param {{jumpsBase:number, jumpsLevelDivisor:number, jumpsCap:number}} chain `def.projectile.chain`
 * @param {number} level effective `discharge` level
 * @returns {number}
 */
export function dischargeJumpsForLevel(chain, level) {
  const jumps = chain.jumpsBase + Math.floor(level / chain.jumpsLevelDivisor);
  return jumps > chain.jumpsCap ? chain.jumpsCap : jumps;
}

/**
 * Sum of `0.75^k` for `k = 0..jumps-1` — `05` §1.5's own printed figures
 * (4 links -> 2.734375, 6 links -> 3.2881). Reference-only (see the file
 * header) — the live path applies the per-link factor individually, never
 * this sum.
 * @param {number} jumps
 * @returns {number}
 */
export function chainFalloffSum(jumps) {
  let total = 0;
  let factor = 1;
  for (let i = 0; i < jumps; i++) {
    total += factor;
    factor *= CHAIN_FALLOFF_PER_JUMP;
  }
  return total;
}

/** Fixed-capacity "already hit" list for one chain resolution — see the
 * file header. Comfortably above `jumpsCap` (6) plus the seed target. */
const CHAIN_HIT_CAPACITY = 8;

/** Deterministic, RNG-free summon placement — "within 2 m of the caster"
 * (`05` §6.5) with no algorithm given for exactly where. 1.0 m along the
 * caster's own facing is the simplest defensible choice that avoids
 * drawing from any RNG stream (rule 3) and stays comfortably inside the
 * 2 m bound. Flagged in this ticket's report as a decision, not a given
 * number. */
const ECHO_SPAWN_OFFSET_M = 1.0;

/**
 * @returns {object} `{ unity, echoBlade, summonOf, applyUnity, removeUnity,
 *   hasUnity, unityRemaining, appendUnityToBuffList, onActorDamage,
 *   fixedUpdate, onActorDeath, onActorDespawn, onZoneTeardown, stats }`
 */
export function createSummonEngine() {
  // -------------------------------------------------------------------
  // Shared growable capacity — every array below is `poolIndex`-indexed
  // and grown together (see the file header, "Zero-allocation discipline").
  // -------------------------------------------------------------------
  let capacity = 64;

  // unity — pending cast (cast() -> onHitframe) scratch.
  let pendingUnityActionSeq = new Int32Array(capacity).fill(-1);
  let pendingUnityLevel = new Int32Array(capacity);
  // unity — active-buff state: encodeStamp(generation, level); level 0 = inactive.
  let unityStamp = new Float64Array(capacity);
  let unityExpiresStep = new Float64Array(capacity);

  // echo_blade — pending cast (cast() -> onHitframe) scratch.
  let pendingEchoActionSeq = new Int32Array(capacity).fill(-1);
  let pendingEchoLevel = new Int32Array(capacity);
  // echo_blade — active-summon state, owner-indexed: encodeStamp(generation,
  // activeFlag) plus the summoned Actor's own id/generation/expiry.
  let echoOwnerStamp = new Float64Array(capacity);
  let echoActorId = new Int32Array(capacity);
  let echoActorGen = new Int32Array(capacity);
  let echoExpiresStep = new Float64Array(capacity);

  // The `lightning.arc` retrigger guard — see the file header. One global
  // scalar (not per-owner): this game spawns a single player actor per
  // session (`./index.js`'s own header makes the same simplification for
  // `actor.skillPoints`) — flagged as a decision, not a given number.
  let arcLastAllowedStep = -Infinity;

  function ensureCapacity(idx) {
    if (idx < capacity) return;
    const grown = Math.max(idx + 1, capacity * 2);

    const nextPendingUnitySeq = new Int32Array(grown).fill(-1);
    const nextPendingUnityLevel = new Int32Array(grown);
    const nextUnityStamp = new Float64Array(grown);
    const nextUnityExpires = new Float64Array(grown);
    const nextPendingEchoSeq = new Int32Array(grown).fill(-1);
    const nextPendingEchoLevel = new Int32Array(grown);
    const nextEchoOwnerStamp = new Float64Array(grown);
    const nextEchoActorId = new Int32Array(grown);
    const nextEchoActorGen = new Int32Array(grown);
    const nextEchoExpires = new Float64Array(grown);

    nextPendingUnitySeq.set(pendingUnityActionSeq);
    nextPendingUnityLevel.set(pendingUnityLevel);
    nextUnityStamp.set(unityStamp);
    nextUnityExpires.set(unityExpiresStep);
    nextPendingEchoSeq.set(pendingEchoActionSeq);
    nextPendingEchoLevel.set(pendingEchoLevel);
    nextEchoOwnerStamp.set(echoOwnerStamp);
    nextEchoActorId.set(echoActorId);
    nextEchoActorGen.set(echoActorGen);
    nextEchoExpires.set(echoExpiresStep);

    capacity = grown;
    pendingUnityActionSeq = nextPendingUnitySeq;
    pendingUnityLevel = nextPendingUnityLevel;
    unityStamp = nextUnityStamp;
    unityExpiresStep = nextUnityExpires;
    pendingEchoActionSeq = nextPendingEchoSeq;
    pendingEchoLevel = nextPendingEchoLevel;
    echoOwnerStamp = nextEchoOwnerStamp;
    echoActorId = nextEchoActorId;
    echoActorGen = nextEchoActorGen;
    echoExpiresStep = nextEchoExpires;
  }

  // -------------------------------------------------------------------
  // unity — read/write helpers
  // -------------------------------------------------------------------

  const unityReadScratch = { level: 0, expiresStep: 0 };

  /** @param {object} actor @returns {{level:number, expiresStep:number}} `unityReadScratch` */
  function readUnity(actor) {
    unityReadScratch.level = 0;
    unityReadScratch.expiresStep = 0;
    const idx = actor.poolIndex;
    if (idx >= capacity) return unityReadScratch;
    const stamp = unityStamp[idx];
    const generation = Math.floor(stamp / GEN_SCALE);
    if (generation !== actor.generation) return unityReadScratch;
    const level = stamp - generation * GEN_SCALE;
    if (level <= 0) return unityReadScratch;
    unityReadScratch.level = level;
    unityReadScratch.expiresStep = unityExpiresStep[idx];
    return unityReadScratch;
  }

  /** `applyBuff(actor,'unity',level,seconds)`'s real mechanics — `05` §7.5:
   * "Buff | skills.applyBuff(actor,'unity',slvl, 8 + 0.2 x (slvl-1))".
   * @param {object} actor @param {number} level @param {number} seconds
   * @param {{time:object}} deps */
  function applyUnity(actor, level, seconds, deps) {
    const idx = actor.poolIndex;
    ensureCapacity(idx);
    const step = deps.time.step;
    unityStamp[idx] = encodeStamp(actor.generation, level);
    unityExpiresStep[idx] = step + Math.round(seconds * 60);
  }

  /** @param {object} actor */
  function removeUnity(actor) {
    const idx = actor.poolIndex;
    if (idx >= capacity) return;
    unityStamp[idx] = encodeStamp(actor.generation, 0);
  }

  /** @param {object} actor @param {number} step @returns {boolean} */
  function hasUnity(actor, step) {
    const s = readUnity(actor);
    return s.level > 0 && s.expiresStep > step;
  }

  /** @param {object} actor @param {number} step @returns {number} seconds */
  function unityRemaining(actor, step) {
    const s = readUnity(actor);
    if (s.level <= 0) return 0;
    const remain = s.expiresStep - step;
    return remain > 0 ? remain / 60 : 0;
  }

  /** Mutates `out[n]` in place (never pushes/grows `out`) if `unity` is
   * active — the same `buffList` "caller-owned array" convention
   * `./buff.js#buffListFn` already follows. See `./index.js#buffList` for
   * how this composes with `_buffEngine`'s own entries.
   * @param {object} actor @param {Array} out @param {number} n current write index @param {number} step
   * @returns {number} 0 or 1 entries written */
  function appendUnityToBuffList(actor, out, n, step) {
    if (n >= out.length) return 0;
    const s = readUnity(actor);
    if (!(s.level > 0 && s.expiresStep > step)) return 0;
    const slot = out[n];
    slot.buffId = 'unity';
    slot.level = s.level;
    slot.remaining = (s.expiresStep - step) / 60;
    slot.stacks = 1;
    return 1;
  }

  // -------------------------------------------------------------------
  // unity — cast handler (`05` §7.5: "Refused while already active with
  // reason:'active'" — `cast()`'s own bare-boolean contract has no reason
  // channel; refusing (returning `false`) is this handler's whole
  // obligation, matching `blade_seal`/`echo_blade`'s own "target:'self',
  // cursor ignored" precedent in `imbue.js`).
  // -------------------------------------------------------------------

  const unityPhasesScratch = { windup: 0, active: 0, recover: 0, baseInterval: 0 };

  /** @param {object} actor @param {object} def @param {number} level
   * @param {number} targetX @param {number} targetZ
   * @param {{actors:object, combat:object, skills:object, time:object}} deps
   * @returns {boolean} */
  function castUnity(actor, def, level, targetX, targetZ, deps) {
    void targetX; void targetZ; // target:'self' — cursor ignored
    const { actors, combat, skills, time } = deps;

    if (hasUnity(actor, time.step)) return false; // "reason:'active'"

    const cost = skills.costOf(actor, def.id);
    if (cost.resource && !actors.canAfford(actor, cost.resource, cost.amount)) return false;
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    const castIntervalNow = combat.castInterval(actor, def.id);
    computeCastPhases(castIntervalNow, def.castTime, unityPhasesScratch);
    const actionSeq = actors.beginAction(actor, def.id, unityPhasesScratch.windup, unityPhasesScratch.active, unityPhasesScratch.recover);

    const idx = actor.poolIndex;
    ensureCapacity(idx);
    pendingUnityActionSeq[idx] = actionSeq;
    pendingUnityLevel[idx] = level;

    return true; // unity's own cooldown (30 s flat) — see onHitframeUnity below
  }

  /** Permanent listener (registered once by `./index.js`) for
   * `anim:hitframe`. Arms the buff at the entry to `active`, matching
   * `imbue.js#onHitframe`'s own "effect resolves at the entry to active"
   * precedent, and starts `unity`'s own cooldown here (not in `cast()`) so
   * a refused arm (stale/foreign hitframe) never starts one.
   * @param {{actor:object, actionId:string, actionSeq:number}} payload
   * @param {{skills:object, time:object}} deps */
  function onHitframeUnity(payload, deps) {
    const actor = payload.actor;
    if (payload.actionId !== 'unity') return;
    const idx = actor.poolIndex;
    if (idx >= capacity || pendingUnityActionSeq[idx] !== payload.actionSeq) return; // stale or foreign
    pendingUnityActionSeq[idx] = -1; // consumed
    const level = pendingUnityLevel[idx];
    const def = deps.skills.definition('unity');
    if (!def) return;
    const seconds = levelValue(def.duration, level);
    applyUnity(actor, level, seconds, deps);
  }

  // -------------------------------------------------------------------
  // echo_blade — pending cast + active-summon state
  // -------------------------------------------------------------------

  const echoPhasesScratch = { windup: 0, active: 0, recover: 0, baseInterval: 0 };
  const summonRefScratch = { id: 0, generation: 0 };

  /** `05` §6.5: "Casting while an echo is alive refuses with reason:'active'."
   * SELF-HEALING when `actorsSys` is given: `ARCHITECTURE.md`'s own event
   * table contracts `actors` to emit `actor:despawn` on every despawn, but
   * `src/actors/index.js#despawn()` (already-accepted code) never actually
   * does — a real, reportable gap this ticket found (grep confirms no
   * emitter anywhere in `src/actors/`). Rather than depend on an event that
   * does not fire, this checks the tracked summon's LIVE status directly
   * via `actors.byId()` every time — `id` already encodes
   * `(poolIndex, generation)` (`src/actors/pool.js`'s own header), so a
   * mismatch (despawned by ANY path — death, a raw external
   * `actors.despawn()` call, or `zone:ready`'s own sweep) is caught here
   * with no cooperation needed from the (currently silent) event at all,
   * and the stale tracking is cleared in the same call. `onActorDeath`/
   * `onActorDespawn` below remain as a cheap eager clear for the common
   * paths; this is the correctness backstop.
   * @param {object} actor @param {object} [actorsSys] `deps.actors`
   * @returns {boolean} */
  function isEchoActive(actor, actorsSys) {
    const idx = actor.poolIndex;
    if (idx >= capacity) return false;
    const stamp = echoOwnerStamp[idx];
    const generation = Math.floor(stamp / GEN_SCALE);
    if (generation !== actor.generation) return false;
    if (stamp - generation * GEN_SCALE <= 0) return false;

    if (actorsSys) {
      const live = actorsSys.byId(echoActorId[idx]);
      if (!live || live.generation !== echoActorGen[idx]) {
        echoOwnerStamp[idx] = 0; // stale — self-heal so the next check doesn't re-pay this cost
        return false;
      }
    }
    return true;
  }

  /** `02-api-contracts.md` §10: `summonOf(actor, skillId) => ActorRef | null`
   * — never an `Actor` (the pool recycles). D-37 scope: proven against
   * `echo_blade` only; any other `skillId` is `null` (O-27: not "nothing
   * else exists", just "this engine tracks one summon skill today"). A
   * SHARED SCRATCH `ActorRef` — copy before the next call, the same
   * convention `SkillsSystem#instanceOf` already documents.
   * @param {object} actor @param {string} skillId @param {object} [actorsSys] `deps.actors` — see `isEchoActive`'s own comment
   * @returns {object|null} */
  function summonOf(actor, skillId, actorsSys) {
    if (skillId !== 'echo_blade') return null;
    if (!isEchoActive(actor, actorsSys)) return null;
    const idx = actor.poolIndex;
    summonRefScratch.id = echoActorId[idx];
    summonRefScratch.generation = echoActorGen[idx];
    return summonRefScratch;
  }

  /** @param {object} actor @param {object} def @param {number} level
   * @param {number} targetX @param {number} targetZ
   * @param {{actors:object, combat:object, skills:object, time:object}} deps
   * @returns {boolean} */
  function castEchoBlade(actor, def, level, targetX, targetZ, deps) {
    void targetX; void targetZ; // target:'self' — cursor ignored
    const { actors, combat, skills } = deps;

    if (isEchoActive(actor, actors)) return false; // "reason:'active'"

    const cost = skills.costOf(actor, def.id);
    if (cost.resource && !actors.canAfford(actor, cost.resource, cost.amount)) return false;
    if (cost.resource && !actors.spend(actor, cost.resource, cost.amount)) return false;

    const castIntervalNow = combat.castInterval(actor, def.id);
    computeCastPhases(castIntervalNow, def.castTime, echoPhasesScratch);
    const actionSeq = actors.beginAction(actor, def.id, echoPhasesScratch.windup, echoPhasesScratch.active, echoPhasesScratch.recover);

    const idx = actor.poolIndex;
    ensureCapacity(idx);
    pendingEchoActionSeq[idx] = actionSeq;
    pendingEchoLevel[idx] = level;

    return true;
  }

  /** Spawns the echo at the entry to `active` — same "effect resolves at
   * active" precedent as `onHitframeUnity` above. See the file header,
   * O-88: the spawned `Actor` cannot be marked `untargetable`/`visualOnly`/
   * `summoned` — `SpawnSpec` has no `flags` field to carry them.
   * @param {object} actor @param {number} level @param {{actors:object, skills:object, time:object}} deps */
  function spawnEcho(actor, level, deps) {
    const { actors, skills, time } = deps;
    const def = skills.definition('echo_blade');
    if (!def) return;

    const dirX = Math.cos(actor.facing);
    const dirZ = Math.sin(actor.facing);
    const echo = actors.spawn({
      kind: 'summon', archetypeId: null, level: actor.level || 1, team: actor.team,
      x: actor.x + dirX * ECHO_SPAWN_OFFSET_M, z: actor.z + dirZ * ECHO_SPAWN_OFFSET_M,
      facing: actor.facing, packId: 0, ownerId: actor.id, affixes: [], nameOverride: null,
    });
    if (!echo) return; // pool dry — a refused summon is a no-op, matching D-47's own "refuse, never error" precedent

    const idx = actor.poolIndex;
    ensureCapacity(idx);
    const durationSeconds = levelValue(def.duration, level);
    echoOwnerStamp[idx] = encodeStamp(actor.generation, 1); // active flag
    echoActorId[idx] = echo.id;
    echoActorGen[idx] = echo.generation;
    echoExpiresStep[idx] = time.step + Math.round(durationSeconds * 60);
  }

  /** Permanent listener (registered once by `./index.js`) for `anim:hitframe`.
   * @param {{actor:object, actionId:string, actionSeq:number}} payload
   * @param {{actors:object, skills:object, time:object}} deps */
  function onHitframeEcho(payload, deps) {
    const actor = payload.actor;
    if (payload.actionId !== 'echo_blade') return;
    const idx = actor.poolIndex;
    if (idx >= capacity || pendingEchoActionSeq[idx] !== payload.actionSeq) return; // stale or foreign
    pendingEchoActionSeq[idx] = -1; // consumed
    const level = pendingEchoLevel[idx];
    spawnEcho(actor, level, deps);
  }

  /** Despawns a live echo (if any) and clears this owner's tracking.
   * @param {object} owner @param {{actors:object}} deps */
  function despawnEcho(owner, deps) {
    const idx = owner.poolIndex;
    if (idx >= capacity) return;
    if (!isEchoActive(owner, deps.actors)) return;
    const echo = deps.actors.byId(echoActorId[idx]);
    if (echo) deps.actors.despawn(echo, true);
    echoOwnerStamp[idx] = encodeStamp(owner.generation, 0);
  }

  /** Clears whichever owner's tracking points at `actorId` — the shared
   * half of `onActorDeath`/`onActorDespawn` below. Scans the small tracked
   * set (bounded by `capacity`, the same cost `fixedUpdate`'s own sweep
   * already pays). @param {number} actorId */
  function clearTrackingForEchoId(actorId) {
    for (let i = 0; i < capacity; i++) {
      if (echoOwnerStamp[i] > 0 && echoActorId[i] === actorId) echoOwnerStamp[i] = 0;
    }
  }

  /** `05` §6.5: "Expiry | ... on the owner's death, or on zone change."
   * Owner death despawns the echo (below). Zone-change despawn is `actors`'
   * own `zone:ready` listener ("despawns everything not questCritical",
   * `02-api-contracts.md` §7's Lifecycle events row) — this file does not
   * need to react to it at all, because `isEchoActive`/`summonOf` are now
   * SELF-HEALING (see that function's own comment): they validate the
   * tracked summon against `actors.byId()` on every read, so a slot freed
   * by ANY path — including one this listener never hears about — is
   * caught the next time anything asks.
   * @param {object} actor the actor that died @param {{actors:object}} deps */
  function onActorDeath(actor, deps) {
    if (!actor) return;
    const idx = actor.poolIndex;
    if (idx < capacity && isEchoActive(actor, deps.actors)) despawnEcho(actor, deps);
  }

  /** `ARCHITECTURE.md`'s own event table CONTRACTS `actors` to emit
   * `actor:despawn` `{actor}` on every despawn — but `src/actors/index.js#despawn()`
   * (already-accepted code) never actually calls `ctx.events.emit(...)` for
   * it (verified: `grep -rn "'actor:despawn'" src/` finds no emitter
   * anywhere in `src/actors/`, only this file's own listener registration).
   * A real, reportable gap in accepted code, found while building this
   * ticket's own recycle test — NOT fixed here (`src/actors/` is not this
   * ticket's file). This listener is kept wired anyway (harmless no-op
   * today, forward-compatible for free the day `actors` starts emitting
   * it) but is NOT what makes `summonOf` correct after an external
   * despawn — `isEchoActive`'s own `actors.byId()` self-heal (above) is the
   * real fix, and does not depend on this event firing at all.
   * @param {object} actor the actor that was despawned */
  function onActorDespawn(actor) {
    if (!actor) return;
    clearTrackingForEchoId(actor.id);
  }

  /** `zone:teardown` — clears every tracked echo's bookkeeping so
   * `summonOf` reads `null` once `actors`' own `zone:ready` handler has
   * despawned the underlying `Actor`. Does not itself call
   * `actors.despawn` (that already-accepted listener owns it; see
   * `02-api-contracts.md` §7's Lifecycle events row). */
  function onZoneTeardown() {
    for (let i = 0; i < capacity; i++) echoOwnerStamp[i] = 0;
  }

  // -------------------------------------------------------------------
  // unity's free-cast — the landed-hit listener (enqueue only, see the
  // file header) and the deferred chain resolver (fixedUpdate only).
  // -------------------------------------------------------------------

  let pfcCapacity = 32;
  let pfcOwnerId = new Int32Array(pfcCapacity);
  let pfcOwnerGen = new Int32Array(pfcCapacity);
  let pfcTargetId = new Int32Array(pfcCapacity);
  let pfcTargetGen = new Int32Array(pfcCapacity);
  let pfcLevel = new Int32Array(pfcCapacity);
  let pfcCount = 0;

  function ensurePfcCapacity(n) {
    if (n <= pfcCapacity) return;
    const grown = Math.max(n, pfcCapacity * 2);
    const nextOwnerId = new Int32Array(grown);
    const nextOwnerGen = new Int32Array(grown);
    const nextTargetId = new Int32Array(grown);
    const nextTargetGen = new Int32Array(grown);
    const nextLevel = new Int32Array(grown);
    nextOwnerId.set(pfcOwnerId);
    nextOwnerGen.set(pfcOwnerGen);
    nextTargetId.set(pfcTargetId);
    nextTargetGen.set(pfcTargetGen);
    nextLevel.set(pfcLevel);
    pfcCapacity = grown;
    pfcOwnerId = nextOwnerId;
    pfcOwnerGen = nextOwnerGen;
    pfcTargetId = nextTargetId;
    pfcTargetGen = nextTargetGen;
    pfcLevel = nextLevel;
  }

  // Debug/self-check counters (not a `02-api-contracts.md` row — same
  // "exposed for tests/debugging" precedent `./index.js#groundEffectCount`
  // already establishes). Reset via `stats().reset()` between test phases.
  let landedHitCount = 0; // unity active + a real landed weapon hit recognised
  let freeCastEnqueued = 0; // the above, AND discharge level > 0 and a valid target — i.e. actually queued
  let freeCastResolved = 0; // drained in fixedUpdate (equals enqueued unless the owner/target despawned mid-step)
  let chainLinksResolved = 0; // total combat:hit-request emits across every resolved chain
  let poolRefusals = 0; // spawnProjectile returned 0 — a link (and the rest of that chain) was refused
  let arcAttempted = 0;
  let arcAllowed = 0;
  let devWarnLastStep = -Infinity;

  /** Permanent listener (registered once by `./index.js`) for `actor:damage`.
   * NEVER emits `combat:hit-request` (see the file header) — enqueues only.
   * @param {{target:object, result:object}} payload
   * @param {{actors:object, skills:object, time:object}} deps */
  function onActorDamage(payload, deps) {
    const { target, result } = payload;
    if (!result || result.outcome !== 'hit') return;
    if (result.sourceSkillId !== 'attack') return; // "landed weapon hit" — see the file header

    const owner = deps.actors.byId(result.sourceId);
    if (!owner || owner.dead) return;
    if (owner.generation !== result.sourceGen) return; // defensive; byId already checks this internally

    const step = deps.time.step;
    if (!hasUnity(owner, step)) return;

    landedHitCount++;

    const dischargeLevel = deps.skills.effectiveLevel(owner, 'discharge');
    if (dischargeLevel <= 0) {
      // `05` §7.5: "At discharge 0 the buff fires nothing at all and skills
      // logs a dev-build warning." Throttled the same way
      // `src/combat/packet.js#_warnPoolExhausted` throttles its own warning.
      if (step - devWarnLastStep >= 60) {
        devWarnLastStep = step;
        // eslint-disable-next-line no-console
        console.warn("[skills] unity: free-cast fired with 'discharge' at level 0 — nothing to chain");
      }
      return;
    }
    if (!target || target.dead) return;

    ensurePfcCapacity(pfcCount + 1);
    const i = pfcCount++;
    pfcOwnerId[i] = owner.id;
    pfcOwnerGen[i] = owner.generation;
    pfcTargetId[i] = target.id;
    pfcTargetGen[i] = target.generation;
    pfcLevel[i] = dischargeLevel;
    freeCastEnqueued++;
  }

  /** @param {number} step @returns {boolean} */
  function maybeAllowArcTrigger(step) {
    arcAttempted++;
    if (step - arcLastAllowedStep < ARC_GUARD_STEPS) return false;
    arcLastAllowedStep = step;
    arcAllowed++;
    return true;
  }

  const chainHitIds = new Int32Array(CHAIN_HIT_CAPACITY);

  /** Nearest still-live hostile within `range` of `(x,z)` not already in
   * `chainHitIds[0..hitCount)` — `05` §7.1's own target-selection rule,
   * ties broken by ascending `actor.id`. `Alloc: no` — a linear scan over
   * `actors.all` (the read-only live dense list).
   * @param {object} actors @param {number} x @param {number} z @param {number} range
   * @param {number} casterTeam @param {number} hitCount
   * @returns {object|null} */
  function findNearestUnhitHostile(actors, x, z, range, casterTeam, hitCount) {
    const all = actors.all;
    const n = all.length;
    let best = null;
    let bestDist = Infinity;
    let bestId = Infinity;
    for (let i = 0; i < n; i++) {
      const a = all[i];
      if (a.dead || a.team === casterTeam) continue;
      let already = false;
      for (let j = 0; j < hitCount; j++) {
        if (chainHitIds[j] === a.id) { already = true; break; }
      }
      if (already) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz); // never Math.hypot
      if (dist > range) continue;
      if (dist < bestDist || (dist === bestDist && a.id < bestId)) {
        best = a; bestDist = dist; bestId = a.id;
      }
    }
    return best;
  }

  const hitRequestPayload = { source: null, target: null, packet: null };

  /** Resolves one queued free-cast into a real `discharge` chain — see the
   * file header for the full design. Runs entirely from `fixedUpdate`,
   * never nested inside an event dispatch.
   * @param {number} i index into the pending-free-cast queue
   * @param {{actors:object, combat:object, skills:object, events:object, physics:object, time:object}} deps */
  function resolveOneFreeCast(i, deps) {
    const { actors, combat, skills, events, physics } = deps;

    const owner = actors.byId(pfcOwnerId[i]);
    if (!owner || owner.dead || owner.generation !== pfcOwnerGen[i]) return;
    let currentTarget = actors.byId(pfcTargetId[i]);
    if (!currentTarget || currentTarget.dead || currentTarget.generation !== pfcTargetGen[i]) return;
    const level = pfcLevel[i];

    const def = skills.definition('discharge');
    if (!def || !def.projectile || !def.projectile.chain) return;
    const chain = def.projectile.chain;
    const jumps = dischargeJumpsForLevel(chain, level);

    const packet = combat.buildSpellPacket(owner, 'discharge', level);
    if (!packet) return; // DamagePacket pool exhausted — combat's own warn already fired

    const synergyPercent = skills.synergyBonus(owner, 'unity', 'flatDamage');
    const synergyMult = 1 + synergyPercent / 100;
    const baseLightMin = packet.lightMin;
    const baseLightMax = packet.lightMax;

    const mask = physics
      ? (owner.team === 0 ? physics.MASK.HOSTILE_TO_PLAYER : physics.MASK.HOSTILE_TO_MONSTER) | (physics.MASK.WORLD || 0)
      : 0; // inert — every spawned "beam" has speed 0, see the file header

    chainHitIds[0] = currentTarget.id;
    let hitCount = 1;
    let resolvedThisChain = 0;

    for (let k = 0; k < jumps; k++) {
      const spawned = skills.spawnProjectile({
        x: currentTarget.x, z: currentTarget.z, dirX: 0, dirZ: 0, speed: 0,
        lifetime: def.projectile.lifetime, radius: 0, pierce: false,
        mask, sourceId: owner.id, sourceGen: owner.generation, team: owner.team,
        skillId: 'discharge', level, alwaysHits: true,
      });
      if (!spawned) { poolRefusals++; break; } // D-47 — refuse, stop the chain, never an error

      maybeAllowArcTrigger(deps.time.step);

      const falloff = CHAIN_FALLOFF_PER_JUMP ** k;
      packet.lightMin = baseLightMin * falloff * synergyMult;
      packet.lightMax = baseLightMax * falloff * synergyMult;
      packet.attackRating = 0; packet.dodgeable = false; packet.blockable = false; // B8 riders, 05 §7.1
      packet.originX = currentTarget.x; packet.originZ = currentTarget.z;

      hitRequestPayload.source = owner;
      hitRequestPayload.target = currentTarget;
      hitRequestPayload.packet = packet;
      events.emit('combat:hit-request', hitRequestPayload);
      chainLinksResolved++;
      resolvedThisChain++;

      if (k + 1 >= jumps) break;
      const next = findNearestUnhitHostile(actors, currentTarget.x, currentTarget.z, chain.range, owner.team, hitCount);
      if (!next) break; // "nowhere to jump" — 05 §7.5's own wording
      chainHitIds[hitCount++] = next.id;
      currentTarget = next;
    }

    combat.releasePacket(packet);
    if (resolvedThisChain > 0) freeCastResolved++;
  }

  /** `SkillsSystem#fixedUpdate`'s own call, every step. Ages/expires live
   * echoes, then drains the pending-free-cast queue — see the file header
   * for why this drain, not the `actor:damage` listener, is where a chain
   * actually resolves.
   * @param {{actors:object, combat:object, skills:object, events:object, physics:object, time:object}} deps */
  function fixedUpdate(deps) {
    const step = deps.time.step;
    for (let idx = 0; idx < capacity; idx++) {
      const stamp = echoOwnerStamp[idx];
      if (stamp <= 0) continue;
      if (step < echoExpiresStep[idx]) continue;
      const echo = deps.actors.byId(echoActorId[idx]);
      if (echo) deps.actors.despawn(echo, true);
      echoOwnerStamp[idx] = 0;
    }

    for (let i = 0; i < pfcCount; i++) resolveOneFreeCast(i, deps);
    pfcCount = 0; // drained — see the file header for why this never re-grows mid-drain
  }

  /** Test/debug snapshot — not a `02-api-contracts.md` row. @returns {object} */
  function stats() {
    return {
      landedHitCount, freeCastEnqueued, freeCastResolved, chainLinksResolved,
      poolRefusals, arcAttempted, arcAllowed,
      reset() {
        landedHitCount = 0; freeCastEnqueued = 0; freeCastResolved = 0; chainLinksResolved = 0;
        poolRefusals = 0; arcAttempted = 0; arcAllowed = 0; arcLastAllowedStep = -Infinity;
      },
    };
  }

  return {
    unity: { skillId: 'unity', cast: castUnity, onHitframe: onHitframeUnity },
    echoBlade: { skillId: 'echo_blade', cast: castEchoBlade, onHitframe: onHitframeEcho },
    summonOf,
    applyUnity,
    removeUnity,
    hasUnity,
    unityRemaining,
    appendUnityToBuffList,
    onActorDamage,
    fixedUpdate,
    onActorDeath,
    onActorDespawn,
    onZoneTeardown,
    stats,
  };
}
