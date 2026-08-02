// src/skills/buff.js
//
// SKIL-10 — the general buff/absorb/trigger engine: `05-skills.md` §14 row
// 10 / `02-api-contracts.md` §10's `applyBuff`/`removeBuff`/`hasBuff`/
// `buffRemaining`/`buffList`/`absorbRemaining`. `./index.js` owns wiring
// this module's dispatch onto `SkillsSystem`'s public surface, merging
// `writeStatPartial`'s output into the shared `'skills'` stat layer (the
// same partial `./passive.js`/`./imbue.js`/`./channel.js` already write
// into), and the `actor:damage` listener that drives `last_stand`'s own
// automatic trigger; this file owns the mechanics only.
//
// D-37 scope: proven against exactly three skills — `war_cry` (`05` §3.3,
// a 12 s self-buff), `last_stand` (`05` §3.5, a passive trigger) and
// `smouldering_ward` (`05` §5.3, a 20 s buff) — no data or level tables for
// any other skill are authored here. `blade_seal`'s own buff state
// (`src/skills/imbue.js`, SKIL-13, accepted) is NOT touched or reimplemented;
// the five generic read/write methods below GENERALISE to cover it by
// delegating to `deps.imbueEngine` (passed in by `./index.js`), never by
// duplicating its state.
//
// `war_cry`'s nova (the stun, the AOE cast) and `smouldering_ward`'s cast
// (mana spend, cast phases, the break-on-depletion-or-expiry fire nova) are
// NOT wired here — `src/skills/impl/` is not a file this ticket may touch,
// so neither skill gets a `_castHandlers` entry, exactly the same "absent,
// not stubbed" treatment O-27 already established for every other unwired
// skill in this registry (`iron_skin`, `mana_weave`, etc.). What IS
// implemented is the buff/absorb ENGINE itself — what happens when
// `skills.applyBuff(actor, 'war_cry'|'last_stand'|'smouldering_ward', level,
// seconds)` is called (by a future cast handler, or directly, as this
// ticket's own tests do) — which is the whole of what D-37 scope asks this
// ticket to prove. See this ticket's report for the two explicitly-flagged
// gaps this leaves (the nova/cast paths, and smouldering_ward's break-burst
// on pool depletion/expiry — see "Explicitly NOT implemented" below).
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/` with
// `checkGlobals: true`). No `Math.random()` — nothing here draws randomness.
//
// ---------------------------------------------------------------------------
// O-90 — why the absorb pool lives on the Actor record, not in this file's
// own closure
// ---------------------------------------------------------------------------
// `05` §3.5/§5.3: "absorb is consumed at R13, before `life -= total`" —
// `src/combat/resolve.js` is granted to this ticket as a named micro-scope
// ONLY for that R13 hook, and `ARCHITECTURE.md` rule 2 forbids `combat`
// importing anything from `src/skills/` (or vice versa) to reach it.
// `src/combat/packet.js` (which builds `resolveDamage`'s `env` bag) is NOT
// in this ticket's file list either, so there is no way to thread a
// `skills`-owned reference through `env`.
//
// The fix: `target.absorbPools` is a PLAIN field on the shared Actor record,
// written here and read/mutated directly by `resolve.js` — the exact same
// pattern `target.statuses` (`resolve.js#shockedStacksOf`) and
// `actor.skillPoints` (`./index.js`'s own header, "Storage gap") already
// establish for "reach plain Actor-record data without importing the
// subsystem that manages it". `resolve.js`'s own header cross-references
// this file for the shape; nothing here imports anything from `src/combat/`.
//
// Shape (built once per actor, in `ensureAbsorbState` below, never
// reassigned afterward — only its `count`/typed-array CONTENTS mutate):
//   { generation:number, count:number,
//     amount:Float64Array(4), buffIdx:Int32Array(4), level:Int32Array(4),
//     expiresStep:Float64Array(4) }
// Pools are stored oldest-first by ARRAY POSITION — always appended at
// `count` (never inserted), so index 0 is always the oldest still-live pool.
// `resolve.js#consumeAbsorbPools` consumes strictly in that order and
// compacts away anything exhausted/expired, preserving the invariant.
//
// ---------------------------------------------------------------------------
// Generation-stamping — the required per-actor-buff-state-survives-recycle
// pattern (SKIL-2/CMBT-8/SKIL-13/SKIL-7/SKIL-8/SKIL-9's own precedent),
// applied twice, two different ways
// ---------------------------------------------------------------------------
// `war_cry`'s state uses the exact `imbueStamp`-style packed scalar
// (`encodeStamp(generation, level)` in a `poolIndex`-indexed `Float64Array`,
// closure-scoped inside `createBuffEngine()` so two independent
// `SkillsSystem` instances never alias each other's arrays — the same
// isolation `createImbueEngine()`/`createChannelEngine()` already give their
// own state).
//
// The absorb pool cannot use that shape (it needs several PARALLEL fields —
// amount/buffIdx/level/expiresStep — for up to `MAX_ABSORB_POOLS` slots per
// actor, not one packed scalar), so it carries its OWN `generation` field
// directly on the lazily-created `actor.absorbPools` object instead of a
// packed stamp. This is the SAME technique (a write-time generation snapshot,
// checked against `actor.generation` on every read, a mismatch reads as
// "empty" without ever needing a `.clear()`/`.delete()`) — just applied to a
// small per-actor object's own field rather than a module-array slot, since
// `resolve.js` must be able to validate it directly off the Actor record
// with no access to this file's closures. Not a "seventh pattern": the
// invariant (stale generation => treated as absent) is identical; only the
// storage location differs, forced by the O-90 constraint above.
//
// This does NOT reproduce O-49 (status pool slots leaking capacity from a
// SHARED free-list on despawn) — there is no shared pool here to leak from.
// `actor.absorbPools` is one small object + three fixed 4-slot typed arrays
// INLINE on the actor record; a despawn that skips clearing it just leaves
// those arrays sitting on the (unique, per-actor) record until the next
// write, which the generation check already makes safe to read as empty.
// Reported in this ticket's report regardless, since O-49's underlying
// class of bug ("something buff-shaped on a despawned actor") is exactly
// what this file also adds.
//
// ---------------------------------------------------------------------------
// Explicitly NOT implemented (report, don't fabricate — rule 6)
// ---------------------------------------------------------------------------
// 1. `war_cry`'s `enhancedDamage` contribution to the `'skills'` stat layer
//    is only RECOMPUTED when something calls `deps.syncSkillsLayer` —
//    `applyBuff`/`removeBuff` call it immediately on grant/removal (so a
//    cast or an explicit removal is always correct right away), but nothing
//    here runs a per-step sweep purely for the 12 s TIME-based expiry the
//    way `ground.js#advanceGroundEffects` sweeps ground effects every step.
//    `hasBuff`/`buffRemaining`/`buffList` are unaffected (they check
//    `expiresStep` against the current step at READ time, so they always
//    answer truthfully) — only the STAT LAYER can go stale between the
//    buff's real expiry and the next unrelated resync trigger (allocate,
//    respec, an imbue/channel change, or another `applyBuff`/`removeBuff`
//    call). Unreachable via real gameplay today: `war_cry` has no
//    `_castHandlers` entry (see the file header), so nothing in this tree
//    can actually grant this buff outside a direct test call. Flagged for
//    whichever ticket wires `war_cry`'s cast — it needs a periodic sweep
//    (the same shape `ground.js`'s pool advance already establishes) or an
//    explicit `removeBuff` call scheduled against the buff's own expiry.
// 2. `smouldering_ward`'s break-on-pool-depletion/expiry fire nova (`05`
//    §5.3: "fires on either the pool reaching 0 or the 20 s expiry") is not
//    implemented — building it needs a caster-provenance-aware AOE burst
//    (`combat.buildAttackPacket`-shaped, centred on the ward's owner) fired
//    from EITHER `resolve.js`'s own R13 consumption (out of the granted
//    micro-scope: that file may not gain new skill-specific behaviour) or a
//    periodic sweep here that would need the same live-list machinery as
//    gap 1. `applyBuff`/`removeBuff`/the four reads and R13's absorb
//    consumption are all fully correct for `smouldering_ward` regardless —
//    only the detonation is absent. Not exercised by any acceptance
//    criterion in this ticket's brief.
// 3. `05`'s own ambiguous "including poison seeding" wording (§3.5 L1032,
//    §5.3 L1722): read as "absorb applies broadly, across every element,
//    including a hit that ALSO happens to seed a poison DoT" (i.e. absorb is
//    not exempted just because poison is involved), NOT as "the poison DoT's
//    own seed magnitude is itself reduced by absorb". `03-combat-math.md`
//    §6.2's own R13 row is explicit that poison is EXCLUDED from `total`
//    ("poison is *not* summed here — it is seeded as a DoT in R14"), and the
//    DoT seed itself happens in R14(b), which O-90 forbids touching. Under
//    the chosen reading, `resolve.js#consumeAbsorbPools` only ever reduces
//    the INSTANT `total` R13 computes — a poisoned hit's DoT seed is
//    untouched by absorb, same as before this ticket. Flagged per D-16
//    precedent ("say which one and stop"), not silently picked.

import { levelValue, cooldownOf, startCooldown, cooldownRemainingSteps } from './cost.js';

/** `src/skills/cost.js#COOLDOWN_GEN_SCALE`/`src/skills/imbue.js#GEN_SCALE`'s
 * own precedent, redeclared — a private implementation detail of this file,
 * not a cross-file import (`ARCHITECTURE.md` rule 2). */
const GEN_SCALE = 2 ** 32;

function encodeStamp(generation, value) {
  return generation * GEN_SCALE + value;
}

// ---------------------------------------------------------------------------
// Absorb pools — plain data on `actor.absorbPools`. See the file header for
// why this lives on the Actor record instead of a closure. These helpers
// hold no state of their own (everything lives on the `actor` passed in), so
// unlike `war_cry`'s arrays below they do not need to be inside
// `createBuffEngine()`'s closure — there is nothing here two independent
// engine instances could alias.
// ---------------------------------------------------------------------------

/** Comfortably above the two skills that exist today (`last_stand`,
 * `smouldering_ward`) — headroom for a future absorb-granting skill, the
 * same "comfortably above the documented ceiling" precedent
 * `impl/cleaving_strike.js#MAX_CONE_TARGETS` already establishes. */
const MAX_ABSORB_POOLS = 4;

/** `buffId -> small int` so `actor.absorbPools.buffIdx` stays a plain
 * `Int32Array` (no strings in a hot, per-actor structure). `0` is reserved
 * as "no buff" / an empty slot. */
const ABSORB_BUFF_IDX = Object.freeze({ last_stand: 1, smouldering_ward: 2 });
/** Reverse of `ABSORB_BUFF_IDX`, for `buffList`'s own `buffId` output. */
const ABSORB_BUFF_ID_BY_IDX = Object.freeze([null, 'last_stand', 'smouldering_ward']);

/**
 * Lazily creates (once per actor — the one-time cost `02-api-contracts.md`
 * §10 documents as `applyBuff`'s own `Alloc: pool` column) and returns
 * `actor.absorbPools`. A generation mismatch (a previous occupant of this
 * pool slot left pools behind) resets `count` to 0 and REUSES the existing
 * typed arrays in place — no allocation on recycle, only on an actor's
 * first-ever absorb grant.
 * @param {object} actor
 * @returns {object}
 */
function ensureAbsorbState(actor) {
  let a = actor.absorbPools;
  if (!a) {
    a = {
      generation: actor.generation,
      count: 0,
      amount: new Float64Array(MAX_ABSORB_POOLS),
      buffIdx: new Int32Array(MAX_ABSORB_POOLS),
      level: new Int32Array(MAX_ABSORB_POOLS),
      expiresStep: new Float64Array(MAX_ABSORB_POOLS),
    };
    actor.absorbPools = a;
  } else if (a.generation !== actor.generation) {
    a.generation = actor.generation;
    a.count = 0; // stale from a previous occupant of this actor-record slot
  }
  return a;
}

/**
 * Grants (or, per `05` §5.3, REFRESHES in place — "discarding the old pool
 * without detonating") one absorb pool.
 * @param {object} actor
 * @param {number} buffIdx `ABSORB_BUFF_IDX[buffId]`
 * @param {number} level
 * @param {number} amount
 * @param {number} expiresStep
 */
function addAbsorbPool(actor, buffIdx, level, amount, expiresStep) {
  const a = ensureAbsorbState(actor);
  for (let i = 0; i < a.count; i++) {
    if (a.buffIdx[i] === buffIdx) {
      // Refresh in place — the pool keeps its existing oldest-first array
      // position (see the file header's "shared pool ordering" note; a
      // refreshed pool's remaining amount is fully replaced, not stacked).
      a.amount[i] = amount;
      a.level[i] = level;
      a.expiresStep[i] = expiresStep;
      return;
    }
  }
  if (a.count >= MAX_ABSORB_POOLS) return; // dry — only two buffIds exist today; never reached
  const slot = a.count++;
  a.amount[slot] = amount;
  a.buffIdx[slot] = buffIdx;
  a.level[slot] = level;
  a.expiresStep[slot] = expiresStep;
}

/** Removes the (at most one) absorb pool matching `buffIdx`, compacting the
 * array so oldest-first ordering is preserved for whatever remains.
 * @param {object} actor @param {number} buffIdx */
function removeAbsorbPool(actor, buffIdx) {
  const a = actor.absorbPools;
  if (!a || a.generation !== actor.generation) return;
  for (let i = 0; i < a.count; i++) {
    if (a.buffIdx[i] === buffIdx) {
      for (let j = i; j < a.count - 1; j++) {
        a.amount[j] = a.amount[j + 1];
        a.buffIdx[j] = a.buffIdx[j + 1];
        a.level[j] = a.level[j + 1];
        a.expiresStep[j] = a.expiresStep[j + 1];
      }
      a.count--;
      return;
    }
  }
}

/** Seconds remaining on the (at most one) pool matching `buffIdx`, 0 if
 * absent/expired. @param {object} actor @param {number} buffIdx @param {number} step @returns {number} */
function absorbBuffRemainingSeconds(actor, buffIdx, step) {
  const a = actor.absorbPools;
  if (!a || a.generation !== actor.generation) return 0;
  for (let i = 0; i < a.count; i++) {
    if (a.buffIdx[i] === buffIdx) {
      const remain = a.expiresStep[i] - step;
      return remain > 0 ? remain / 60 : 0;
    }
  }
  return 0;
}

/** `02-api-contracts.md` §10: `absorbRemaining(actor) => number` — the
 * `smouldering_ward` / `last_stand` pool total `ui` overlays on the life
 * globe. Sums every still-live (not-yet-expired) pool. `Alloc: no` — a pure
 * read over `actor.absorbPools`'s already-existing typed arrays.
 * @param {object} actor @param {number} step `ctx.time.step` @returns {number} */
export function absorbRemaining(actor, step) {
  const a = actor.absorbPools;
  if (!a || a.generation !== actor.generation || a.count === 0) return 0;
  let total = 0;
  for (let i = 0; i < a.count; i++) {
    if (a.expiresStep[i] > step) total += a.amount[i];
  }
  return total;
}

// ---------------------------------------------------------------------------
// createBuffEngine — war_cry's own closure-scoped state (see the file
// header for why this one DOES need to be per-instance) plus the five
// generalised `02-api-contracts.md` §10 methods and the `last_stand`
// automatic trigger.
// ---------------------------------------------------------------------------

/**
 * @returns {object} `{ applyBuff, removeBuff, hasBuff, buffRemaining,
 *   buffList, absorbRemaining, writeStatPartial, onActorDamage }` — see the
 *   return statement at the bottom of this file.
 */
export function createBuffEngine() {
  // --- war_cry, poolIndex-indexed, generation-stamped (see file header) ---
  let wcCapacity = 64;
  let wcStamp = new Float64Array(wcCapacity); // packs (generation, level); level 0 = inactive
  let wcValue = new Float64Array(wcCapacity); // unstamped — the precomputed enhancedDamage %, computed once at grant time
  let wcExpiresStep = new Float64Array(wcCapacity); // unstamped

  function ensureWcCapacity(idx) {
    if (idx < wcCapacity) return;
    const grown = Math.max(idx + 1, wcCapacity * 2);
    const nextStamp = new Float64Array(grown);
    const nextValue = new Float64Array(grown);
    const nextExpires = new Float64Array(grown);
    nextStamp.set(wcStamp);
    nextValue.set(wcValue);
    nextExpires.set(wcExpiresStep);
    wcCapacity = grown;
    wcStamp = nextStamp;
    wcValue = nextValue;
    wcExpiresStep = nextExpires;
  }

  /** Shared scratch — same "shared scratch object" convention `imbue.js`'s
   * own `imbueReadScratch` establishes. */
  const wcReadScratch = { level: 0, value: 0, expiresStep: 0 };

  /** @param {object} actor @returns {{level:number, value:number, expiresStep:number}} `wcReadScratch` */
  function readWarCry(actor) {
    wcReadScratch.level = 0;
    wcReadScratch.value = 0;
    wcReadScratch.expiresStep = 0;
    const idx = actor.poolIndex;
    if (idx >= wcCapacity) return wcReadScratch;
    const stamp = wcStamp[idx];
    const generation = Math.floor(stamp / GEN_SCALE);
    if (generation !== actor.generation) return wcReadScratch;
    const level = stamp - generation * GEN_SCALE;
    if (level <= 0) return wcReadScratch;
    wcReadScratch.level = level;
    wcReadScratch.value = wcValue[idx];
    wcReadScratch.expiresStep = wcExpiresStep[idx];
    return wcReadScratch;
  }

  function writeWarCry(actor, level, value, expiresStep) {
    const idx = actor.poolIndex;
    ensureWcCapacity(idx);
    wcStamp[idx] = encodeStamp(actor.generation, level);
    wcValue[idx] = value;
    wcExpiresStep[idx] = expiresStep;
  }

  function clearWarCry(actor) {
    const idx = actor.poolIndex;
    if (idx >= wcCapacity) return;
    wcStamp[idx] = encodeStamp(actor.generation, 0);
  }

  // -------------------------------------------------------------------
  // Stat-layer contribution — merged into the SAME `'skills'` layer partial
  // `computePassiveLayer`/`imbue.js`/`channel.js` already write (see
  // `./index.js#_syncPassiveLayer`). Always writes `enhancedDamage` (0 when
  // inactive), never conditionally — same "stable hidden class" discipline
  // `imbue.js#writeImbueStatPartial`'s own header documents.
  // -------------------------------------------------------------------

  /** @param {object} actor @param {object} partial @param {number} step `ctx.time.step` */
  function writeStatPartial(actor, partial, step) {
    const s = readWarCry(actor);
    const active = s.level > 0 && s.expiresStep > step;
    partial.enhancedDamage = active ? s.value : 0;
  }

  // -------------------------------------------------------------------
  // `02-api-contracts.md` §10 — the five generalised buff methods, plus
  // `absorbRemaining` (a thin forward onto the module-level function above,
  // reading `deps.time.step`).
  // -------------------------------------------------------------------

  /** `applyBuff(actor, buffId, level, seconds) => void`. `Alloc: pool` (a
   * one-time-per-actor typed-array allocation for a NEW absorb pool; `war_cry`
   * never allocates beyond its own one-time-per-actor closure-array growth).
   * `blade_seal` still refused — see the file header. Throws on an unknown
   * `buffId` or a `buffId` this engine has no data curve for (rule 6: never
   * fabricate a number `05-skills.md` does not give).
   * @param {object} actor @param {string} buffId @param {number} level
   * @param {number} seconds @param {object} deps `{skills, time, syncSkillsLayer}` */
  function applyBuff(actor, buffId, level, seconds, deps) {
    if (buffId === 'blade_seal') {
      throw new Error(
        "skills.applyBuff('blade_seal'): still unimplemented through this generic entry point — the real " +
          'arm path is cast()->onHitframe->armImbue (src/skills/imbue.js), which needs targetX/targetZ/' +
          "resource-spend context a bare (buffId, level, seconds) call cannot supply. See imbue.js's own " +
          'header, "The buff-duration number".',
      );
    }

    const def = deps.skills.definition(buffId);
    if (!def) throw new Error(`skills.applyBuff('${buffId}'): unknown skill id.`);

    const step = deps.time.step;
    const expiresStep = step + Math.round(seconds * 60);

    if (buffId === 'war_cry') {
      const curve = def.extra && def.extra.selfBuff && def.extra.selfBuff.enhancedDamagePercent;
      if (!curve) {
        throw new Error(`skills.applyBuff('war_cry'): data/skills.js has no extra.selfBuff.enhancedDamagePercent curve.`);
      }
      const value = levelValue(curve, level);
      writeWarCry(actor, level, value, expiresStep);
      if (deps.syncSkillsLayer) deps.syncSkillsLayer(actor);
      return;
    }

    const buffIdx = ABSORB_BUFF_IDX[buffId];
    if (buffIdx) {
      const curve = buffId === 'last_stand'
        ? def.extra && def.extra.trigger && def.extra.trigger.absorb
        : def.extra && def.extra.absorb;
      if (!curve) throw new Error(`skills.applyBuff('${buffId}'): data/skills.js has no absorb curve.`);
      const amount = levelValue(curve, level);
      addAbsorbPool(actor, buffIdx, level, amount, expiresStep);
      return;
    }

    throw new Error(
      `skills.applyBuff('${buffId}'): no buff engine wired for this id — only war_cry/last_stand/` +
        'smouldering_ward (SKIL-10, D-37 scope) and blade_seal (refused above) exist today.',
    );
  }

  /** `removeBuff(actor, buffId) => void`. Unknown `buffId` is a silent
   * no-op (O-27 — never assert "nothing else exists yet").
   * @param {object} actor @param {string} buffId @param {object} deps */
  function removeBuff(actor, buffId, deps) {
    if (buffId === 'blade_seal') {
      if (deps.imbueEngine) deps.imbueEngine.removeBladeSealBuff(actor, deps);
      return;
    }
    if (buffId === 'war_cry') {
      clearWarCry(actor);
      if (deps.syncSkillsLayer) deps.syncSkillsLayer(actor);
      return;
    }
    const buffIdx = ABSORB_BUFF_IDX[buffId];
    if (!buffIdx) return;
    removeAbsorbPool(actor, buffIdx);
  }

  /** `hasBuff(actor, buffId) => boolean`.
   * @param {object} actor @param {string} buffId @param {object} deps @returns {boolean} */
  function hasBuff(actor, buffId, deps) {
    if (buffId === 'blade_seal') return deps.imbueEngine ? deps.imbueEngine.hasBladeSealBuff(actor) : false;
    const step = deps.time.step;
    if (buffId === 'war_cry') {
      const s = readWarCry(actor);
      return s.level > 0 && s.expiresStep > step;
    }
    const buffIdx = ABSORB_BUFF_IDX[buffId];
    if (!buffIdx) return false;
    return absorbBuffRemainingSeconds(actor, buffIdx, step) > 0;
  }

  /** `buffRemaining(actor, buffId) => number` seconds.
   * @param {object} actor @param {string} buffId @param {object} deps @returns {number} */
  function buffRemainingFn(actor, buffId, deps) {
    if (buffId === 'blade_seal') return deps.imbueEngine ? deps.imbueEngine.bladeSealBuffRemaining(actor) : 0;
    const step = deps.time.step;
    if (buffId === 'war_cry') {
      const s = readWarCry(actor);
      if (s.level <= 0) return 0;
      const remain = s.expiresStep - step;
      return remain > 0 ? remain / 60 : 0;
    }
    const buffIdx = ABSORB_BUFF_IDX[buffId];
    if (!buffIdx) return 0;
    return absorbBuffRemainingSeconds(actor, buffIdx, step);
  }

  /** `buffList(actor, out:Array) => int` — mutates up to `out.length`
   * EXISTING slot objects in place, never pushes/grows `out` (`Alloc: no`,
   * the same convention `./index.js`'s own header already documents for
   * this method). Order: `blade_seal`, `war_cry`, then every live absorb
   * pool oldest-first.
   * @param {object} actor @param {Array} out @param {object} deps @returns {number} */
  function buffListFn(actor, out, deps) {
    if (!out || out.length === 0) return 0;
    let n = 0;
    const step = deps.time.step;

    if (deps.imbueEngine && deps.imbueEngine.hasBladeSealBuff(actor) && n < out.length) {
      const slot = out[n];
      slot.buffId = 'blade_seal';
      slot.level = deps.imbueEngine.bladeSealBuffLevel(actor);
      slot.remaining = deps.imbueEngine.bladeSealBuffRemaining(actor);
      slot.stacks = 1;
      n++;
    }

    if (n < out.length) {
      const s = readWarCry(actor);
      if (s.level > 0 && s.expiresStep > step) {
        const slot = out[n];
        slot.buffId = 'war_cry';
        slot.level = s.level;
        slot.remaining = (s.expiresStep - step) / 60;
        slot.stacks = 1;
        n++;
      }
    }

    const a = actor.absorbPools;
    if (a && a.generation === actor.generation) {
      for (let i = 0; i < a.count && n < out.length; i++) {
        if (a.expiresStep[i] <= step) continue; // expired, not yet swept — treated as absent
        const slot = out[n];
        slot.buffId = ABSORB_BUFF_ID_BY_IDX[a.buffIdx[i]];
        slot.level = a.level[i];
        slot.remaining = (a.expiresStep[i] - step) / 60;
        slot.stacks = 1;
        n++;
      }
    }

    return n;
  }

  /** `absorbRemaining(actor) => number`. Thin forward. @param {object} actor @param {object} deps @returns {number} */
  function absorbRemainingFn(actor, deps) {
    return absorbRemaining(actor, deps.time.step);
  }

  // -------------------------------------------------------------------
  // `last_stand` — the automatic passive trigger (`05` §3.5). Never cast
  // (`target:'self'`, `type:'passive'`, no `_castHandlers` entry, matching
  // `iron_skin`/every other pure-passive skill's own precedent) — this is
  // its ENTIRE mechanical surface. Reacts to `actor:damage` because the
  // trigger condition (`life <= 0.25 x maxLife`) can only be evaluated
  // AFTER R14(a)'s `life -= total` has already run — `resolve.js`'s own
  // R14 internals are out of this ticket's granted micro-scope (O-90), so
  // this is done the same way `status.js#createIncinerateReaction` and
  // `imbue.js#onActorDamage` already react to `actor:damage` post-hoc for
  // an effect `05` describes as happening "inside" the resolve pipeline.
  // -------------------------------------------------------------------

  const LAST_STAND_ID = 'last_stand';

  /** @param {object} target @param {object} deps `{actors, skills, events, time}` */
  function maybeTriggerLastStand(target, deps) {
    if (target.dead) return;
    const level = deps.skills.effectiveLevel(target, LAST_STAND_ID);
    if (level <= 0) return;

    const maxLife = target.stats ? target.stats.maxLife : 0;
    if (!(maxLife > 0) || target.life > maxLife * 0.25) return;

    const step = deps.time.step;
    if (cooldownRemainingSteps(target, LAST_STAND_ID, step) > 0) return;

    const def = deps.skills.definition(LAST_STAND_ID);
    if (!def || !def.extra || !def.extra.trigger) return;

    const durationSeconds = levelValue(def.duration, level);
    applyBuff(target, LAST_STAND_ID, level, durationSeconds, deps);

    const rageGrant = def.extra.trigger.rageGrant || 0;
    if (rageGrant > 0 && deps.actors && typeof deps.actors.addRage === 'function') {
      deps.actors.addRage(target, rageGrant);
    }

    const cdSeconds = cooldownOf(def, level);
    startCooldown(target, LAST_STAND_ID, cdSeconds, step);

    if (deps.events && typeof deps.events.emit === 'function') {
      // `skill:trigger` — ARCHITECTURE.md's own event table, same
      // "a passive fired, fx/audio need to tell it apart from a cast"
      // precedent `status.js#createIncinerateReaction`/`imbue.js`'s cascade
      // wave already use.
      deps.events.emit('skill:trigger', { actor: target, skillId: LAST_STAND_ID, level });
    }
  }

  /** Permanent listener (registered once by `./index.js`) for `actor:damage`.
   * @param {{target:object}} payload @param {object} deps */
  function onActorDamage(payload, deps) {
    const target = payload.target;
    if (!target) return;
    maybeTriggerLastStand(target, deps);
  }

  return {
    applyBuff,
    removeBuff,
    hasBuff,
    buffRemaining: buffRemainingFn,
    buffList: buffListFn,
    absorbRemaining: absorbRemainingFn,
    writeStatPartial,
    onActorDamage,
  };
}
