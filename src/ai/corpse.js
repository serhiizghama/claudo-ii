// src/ai/corpse.js
//
// AI-9 — corpses and resurrection. `06-monsters-ai.md` §13 row 9:
// "§10.6-10.8: `actors.resurrectableCorpses` wiring, `raise_ranker`'s fizzle
// and refund rules, the fresh brain, pack accounting."
//
// Headless by construction — no `three`, no DOM, no browser global, no
// `performance.now()`, no `Math.random()`. Every per-actor field lives in
// preallocated parallel arrays indexed by `actor.poolIndex`, the same shape
// `./index.js`'s `_brains`/`_perception`/`_spawnStore`/`_affixStore` already
// use (`ARCHITECTURE.md` rule 6). No `Map`, no `Set`, nothing allocated on a
// step.
//
// ===========================================================================
// The thing this ticket ran into first: `actors` has no corpse API at all
// ===========================================================================
// `02-api-contracts.md` §7 contracts BOTH halves on `actors`:
//
//   | `resurrect`             | `(actor, lifeFraction) => boolean`          |
//   | `resurrectableCorpses`  | `(x,z,radius, out:int[]) => int count` ...  |
//                             | "Sorted by distance, then by corpse id"     |
//
// Neither exists. `ActorsSystem` (`src/actors/index.js`) forwards neither,
// `src/actors/pool.js`'s own header records why — "`kill`/`resurrect`
// (ACTR-17/AI-9)" — and ACTR-17 (`src/actors/death.js`, BACKLOG.md:279) is
// unbuilt and is not in M5 at all. `src/actors/` is another subsystem's
// directory (`ARCHITECTURE.md` rule 1) and is not in this ticket's grant.
//
// That matters because `src/ai/brains/shaman.js` (AI-6, also outside this
// ticket's grant) gates the WHOLE `raise_ranker` branch on
// `typeof actors.resurrectableCorpses === 'function'` — its own header says
// so: "Until that ticket ships, this branch's precondition can never be
// satisfied and priority always falls through." This is that ticket. With
// the precondition still false, not one of AI-9's six acceptance criteria is
// reachable through the real pipeline: no cast starts, so nothing fizzles,
// nothing is interrupted, no credit is spent and no corpse is raised.
//
// So `installCorpseApi()` below DEFINES the two contracted methods on the
// live `ActorsSystem` instance, from `AiSystem.init()`, if and only if they
// are absent. It edits no file outside `src/ai/` and it is removed again in
// `dispose()`. It is nonetheless a reach into another subsystem's object and
// it is the one judgement call in this ticket — reported, not slipped in.
// The moment ACTR-17 lands the real pair, `installCorpseApi` sees them and
// installs nothing, so the adapter does not have to be found and deleted for
// the real implementation to take over. The alternative (implement the query
// as `ai.resurrectableCorpses`, an uncontracted method nothing calls) leaves
// the raise path structurally dead and the ticket undemonstrable, which is
// not an honest way to close it.
//
// The corpse RECORD is `ai`'s own either way. `06` §10.6 says corpse policy
// "is `08-characters-visual.md` §8's and `ai` only reads it", but no corpse
// pool, no lifetime clock and no eviction exist anywhere in `src/` (grep:
// `corpse` outside comments hits `config.q.corpseBudget` and nothing else).
// Reading a policy nobody implements returns nothing, so this file keeps the
// bookkeeping §8.3/§8.4/§8.5 describe — lifetime, budget eviction, the gib
// rules, the eligibility test — over the dead actors `actors` leaves in the
// pool, and hands it back through the contracted query. When ACTR-17 lands
// its own corpse pool this file's store becomes the thing to delete.
//
// ===========================================================================
// What §10.8 forbids, and is not done here
// ===========================================================================
// "`ai` does not despawn corpses, does not extend their lifetime, does not
// reserve them, and does not mark one as claimed." None of the four happens:
// dropping a corpse from THIS store never touches the actor (the dead record
// stays in the pool for `actors` to despawn whenever ACTR-17 exists), the
// 25.0 s clock is only ever counted down, and the query is a pure function of
// position and id, so two Shamans casting at the same corpse both pick it and
// the loser's `actors.resurrect` returns `false` — §10.8's own worked case.
//
// ===========================================================================
// Ambiguities and deviations, all of them flagged rather than picked silently
// ===========================================================================
// 1. `ARCHITECTURE.md` rule 9 wants gameplay numbers in a `data/` file. This
//    ticket's grant is exactly one production file (`src/ai/corpse.js`), so
//    `CORPSE_POLICY` below is a frozen table at the top of this file instead
//    of `src/ai/data/corpses.js`. It is exported and importable headlessly,
//    which is what rule 9's own stated reason (the balance harness) needs.
//    Reported.
// 2. §2.4's "Interruption ... refunds the credit" versus "Credit spend: on
//    `hitTick`". The credit is never debited at cast start anywhere, so a
//    refund is not a re-credit — it is the ABSENCE of the debit. This file
//    therefore cancels the cast and leaves `reviveCredits` untouched, and
//    the test measures the observable: still 1 after an interrupted cast,
//    0 after one that reached `hitTick`.
// 3. Neither §2.4 nor `08` §6.6 says whether an interrupted `raise_ranker`
//    starts its 8.0 s cooldown. §10.7 says a FIZZLE does. Read as: an
//    interruption does not (the ritual never resolved), but the action is
//    held off until the incapacitating status has expired — otherwise the
//    Shaman re-casts on the very next decision, still stunned, because
//    nothing in `brains/shaman.js` checks `canAct`. See `cancelRaiseCast`.
// 4. A stun landing on the same step as `hitTick`: this file's pre-pass runs
//    before any brain steps, so a stun that is already live at the top of
//    step S cancels a cast whose `hitTick` is S. "Before" is therefore
//    "observable at the start of the step in which `hitTick` falls".
// 5. §10.7's fizzle ("the credit IS consumed") is implemented HERE, in the
//    post-pass, because `brains/shaman.js#resolveRaiseRanker` returns
//    without spending anything when its corpse query comes back empty. That
//    file is outside this grant; the rule is §13 row 9's deliverable, so it
//    lives in this one.
// 6. §10.7's fresh brain is applied in the post-pass, AFTER the brain loop,
//    for the same reason: `resolveRaiseRanker` writes
//    `state = dormant, targetId = 0` over the revived actor's brain the
//    instant `actors.resurrect` returns, and its own comment calls that
//    placeholder ("the fresh Brain a future ticket's spawn/lifecycle work
//    should own; left inert here"). This is that work; it cannot be done
//    inside `resurrect` because the clobber happens after it returns.
// 7. `Actor` has no `resurrectCount` field (`01-data-model.md` §2 lists none
//    and `pool.js#createActorRecord` allocates none), so §8.5's condition 4
//    is enforced by `store.raiseCount[]` — a counter, per this ticket's own
//    instruction, not a flag — plus `ACTOR_FLAG.revived` on the actor as an
//    independent second gate.

import { actorHasAffix } from './rank.js';

// ===========================================================================
// The data table — `08` §8.3/§8.4/§8.5 and `06` §10.6, transcribed
// ===========================================================================

export const CORPSE_POLICY = Object.freeze({
  /** `08` §8.3 — corpse lifetime before the ash dissolve begins. */
  lifetimeSeconds: 25.0,
  /** `08` §8.3 — the dissolve itself. Visual only; `ai` never reads it for
   * eligibility (a corpse is already past §8.5's 12.0 s window by then). */
  dissolveSeconds: 1.5,
  /** `08` §8.5 condition 2 — corpse age under which it may still be raised. */
  resurrectableSeconds: 12.0,
  /** `08` §8.3 — a resurrectable corpse is exempt from eviction this long. */
  evictionExemptSeconds: 12.0,
  /** `08` §8.4 — a single killing blow at or above this fraction of
   * `maxLife` gibs instead of leaving a corpse. */
  gibLifeFraction: 0.35,
  /** `06` §2.4 / §10.7 — `actors.resurrect(handle, 0.60)`. */
  reviveLifeFraction: 0.60,
  /** `08` §8.5 condition 1 — the only archetype the Shaman raises. */
  resurrectableArchetype: 'bone_ranker',
  /** `06` §10.6 "Never a corpse". `carrion_swarm` is instanced (§2.2),
   * `blight_crawler` always detonates (§2.6), `molgrim` is §7.10's. */
  neverCorpseArchetypes: Object.freeze(['carrion_swarm', 'blight_crawler', 'molgrim']),
  /** `08` §8.4 — a `burning`-affix death gibs. `06` §10.6 names the affix
   * with `06` §6.1's own id (`src/ai/data/affixes.js`: `burning`); `08` §8.4
   * calls the same affix "Fire Enchanted". */
  gibAffixId: 'burning',
  /** Used only when `ctx.config.q` is absent (a stub `ctx`) — the `medium`
   * preset's number from `src/core/config.js`. A real boot always passes its
   * own `q.corpseBudget` (6/10/16/20 by preset, `08` §8.3). */
  defaultCorpseBudget: 10,
});

const FIXED_HZ = 60;
const LIFETIME_STEPS = Math.round(CORPSE_POLICY.lifetimeSeconds * FIXED_HZ);
const RESURRECTABLE_STEPS = Math.round(CORPSE_POLICY.resurrectableSeconds * FIXED_HZ);
const EXEMPT_STEPS = Math.round(CORPSE_POLICY.evictionExemptSeconds * FIXED_HZ);

/** `01-data-model.md` §2.1. Redeclared rather than imported: the whole
 * `ACTOR_FLAG` table is exported from nowhere in `src/`, and three shipped
 * files already do exactly this (`src/combat/resolve.js`'s
 * `ACTOR_FLAG.invulnerable`, `src/combat/reaction.js`'s `noKnockback`,
 * `src/ui/target.js`'s `ACTOR_FLAG_BOSS`). */
const ACTOR_FLAG_REVIVED = 1 << 9;
const ACTOR_FLAG_CORPSE = 1 << 8;

/** `brains/shaman.js`'s own private `CAST_RAISE`. Same redeclaration
 * problem: that file exports its cast codes to nobody and is outside this
 * ticket's grant, so the one integer is mirrored here against its source
 * line rather than the file being edited to export it. Reported. */
const CAST_RAISE = 2;
const CAST_NONE = 0;

/** How many candidates the sort holds before it starts dropping the worst.
 * `q.corpseBudget` peaks at 20 (`08` §8.3), so this can never truncate a
 * real query; it is a fixed cap so the sort allocates nothing. */
const QUERY_CAP = 32;

/** Pending raises per step. One credit per Shaman and at most a handful of
 * Shamans in a zone — 8 is headroom, not a budget. */
const PENDING_CAP = 8;

// ===========================================================================
// The store
// ===========================================================================

/**
 * One preallocated bag of parallel arrays, built once by `AiSystem` and
 * passed by reference. Indexed by `actor.poolIndex` except `slots`, which is
 * a dense list of occupied indices held in ascending death order so that
 * "oldest first" (`08` §8.3's eviction) is position 0 and needs no sort.
 *
 * @param {number} maxBrains same cap `AiSystem` sizes `_brains` to.
 * @param {number} [capacity] max simultaneous corpse records.
 */
export function createCorpseStore(maxBrains, capacity = 64) {
  return {
    maxBrains,
    capacity,

    // Per corpse, indexed by poolIndex. `deathStep < 0` means "no corpse".
    deathStep: new Int32Array(maxBrains).fill(-1),
    corpseId: new Int32Array(maxBrains),
    corpseGen: new Int32Array(maxBrains),
    // Float64, not Float32, unlike every other position cache in this
    // subsystem: this one is a SORT KEY. `actor.x` is a double, and rounding
    // it to float32 moves the distance by up to ~1e-6 m, which is enough to
    // reorder two corpses that the spec says are tied and must fall through
    // to the id tie-break.
    corpseX: new Float64Array(maxBrains),
    corpseZ: new Float64Array(maxBrains),
    gibbed: new Uint8Array(maxBrains),
    /** `08` §8.5 condition 1 + §8.3's eviction exemption: this corpse is of
     * the one raisable archetype and was not gibbed. */
    eligible: new Uint8Array(maxBrains),

    /** §8.5 condition 4, as a counter (never a resettable flag). Owned by
     * `raiseOwnerId` so a recycled pool slot cannot inherit it. */
    raiseCount: new Int32Array(maxBrains),
    raiseOwnerId: new Int32Array(maxBrains),

    /** The killing blow, for §8.4's 35 % gib test. Written by
     * `noteCorpseDamage` — see its own comment on why it can only run AFTER
     * the corpse is registered. */
    lastHitDamage: new Float32Array(maxBrains),
    lastHitStep: new Int32Array(maxBrains).fill(-1),

    /** Dense list of poolIndices with a live corpse, oldest first. */
    slots: new Int32Array(capacity),
    slotCount: 0,

    /** Shaman poolIndex -> the step its in-flight `raise_ranker` resolves
     * on, and the step one of its raises actually landed. Both are step
     * stamps, the same sentinel idiom `perception.js#wakeAtStep` uses. */
    expectStep: new Int32Array(maxBrains).fill(-1),
    pairedStep: new Int32Array(maxBrains).fill(-1),

    // This step's successful raises, drained by `stepCorpsesPost`.
    pendIdx: new Int32Array(PENDING_CAP),
    pendShaman: new Int32Array(PENDING_CAP).fill(-1),
    pendCount: 0,

    // Query scratch — the bounded insertion sort's working set.
    _candIdx: new Int32Array(QUERY_CAP),
    _candDist: new Float64Array(QUERY_CAP),
    _candId: new Int32Array(QUERY_CAP),

    /** `ai:corpse-raised` — `ARCHITECTURE.md`'s event table and
     * `02-api-contracts.md`:1119 both contract the payload as
     * `{ actor, shaman, point }`. Reused in place, same precedent as
     * `perception.js#packAlertPayload`. */
    raisedPayload: { actor: null, shaman: null, point: { x: 0, y: 0, z: 0 } },

    stats: {
      corpses: 0,       // corpse records created
      gibbed: 0,        // deaths that left no corpse under §8.4
      neverCorpse: 0,   // deaths of a §10.6 "never a corpse" archetype
      dissolved: 0,     // corpses that reached the 25.0 s lifetime
      evicted: 0,       // corpses dropped early by `q.corpseBudget`
      raised: 0,        // successful `actors.resurrect` calls
      refused: 0,       // `actors.resurrect` calls that returned false
      fizzles: 0,       // §10.7 fizzles — hitTick reached, nothing revived
      interrupts: 0,    // §2.4 interruptions during the wind-up
    },
  };
}

/** Zone-visit boundary. Corpses do not survive a zone teardown (`06` §10.5
 * despawns every actor), and neither does the raise counter — the pool slots
 * are handed to different actors on the next zone. */
export function resetCorpseStore(store) {
  store.deathStep.fill(-1);
  store.gibbed.fill(0);
  store.eligible.fill(0);
  store.raiseCount.fill(0);
  store.raiseOwnerId.fill(0);
  store.lastHitStep.fill(-1);
  store.expectStep.fill(-1);
  store.pairedStep.fill(-1);
  store.slotCount = 0;
  store.pendCount = 0;
  const s = store.stats;
  s.corpses = 0; s.gibbed = 0; s.neverCorpse = 0; s.dissolved = 0; s.evicted = 0;
  s.raised = 0; s.refused = 0; s.fizzles = 0; s.interrupts = 0;
}

// ===========================================================================
// Slot bookkeeping
// ===========================================================================

function slotPositionOf(store, idx) {
  for (let i = 0; i < store.slotCount; i++) if (store.slots[i] === idx) return i;
  return -1;
}

function dropSlotAt(store, pos) {
  const idx = store.slots[pos];
  for (let i = pos; i < store.slotCount - 1; i++) store.slots[i] = store.slots[i + 1];
  store.slotCount--;
  store.deathStep[idx] = -1;
  store.eligible[idx] = 0;
  return idx;
}

function dropCorpse(store, idx) {
  const pos = slotPositionOf(store, idx);
  if (pos >= 0) dropSlotAt(store, pos);
  else store.deathStep[idx] = -1;
}

/** `08` §8.3: "When the budget is full, the oldest corpse begins dissolving
 * immediately. Exception: a corpse that is still resurrectable is exempt from
 * eviction for its first 12 s; if every corpse is exempt, the oldest exempt
 * one is evicted anyway and marked non-resurrectable first, so the eviction
 * order stays total and deterministic." */
function evictToBudget(store, budget, step) {
  while (store.slotCount > budget && store.slotCount > 0) {
    let victim = -1;
    for (let i = 0; i < store.slotCount; i++) {
      const idx = store.slots[i];
      const exempt = store.eligible[idx] === 1 && (step - store.deathStep[idx]) < EXEMPT_STEPS;
      if (!exempt) { victim = i; break; }
    }
    if (victim < 0) {
      // Every corpse is exempt — the oldest one loses its exemption first.
      store.eligible[store.slots[0]] = 0;
      victim = 0;
    }
    dropSlotAt(store, victim);
    store.stats.evicted++;
  }
}

function corpseBudgetOf(ctx) {
  const q = ctx && ctx.config ? ctx.config.q : null;
  const n = q && typeof q.corpseBudget === 'number' ? q.corpseBudget | 0 : 0;
  return n > 0 ? n : CORPSE_POLICY.defaultCorpseBudget;
}

// ===========================================================================
// Death -> corpse (`08` §8.2/§8.4, `06` §10.6)
// ===========================================================================

function isNeverCorpse(archetypeId) {
  const list = CORPSE_POLICY.neverCorpseArchetypes;
  for (let i = 0; i < list.length; i++) if (list[i] === archetypeId) return true;
  return false;
}

/**
 * `actor:death`. Three jobs, in this order: strip the `haste_dust` a dying
 * Shaman granted (§2.4's own row), cancel any ritual the dying actor was
 * mid-way through (`08` §6.6 "death: cancels immediately"), then register the
 * corpse §8.2 would have baked.
 *
 * @param {object} env the shared environment `AiSystem` builds once.
 * @param {object} payload `{ actor, killer, point }`
 */
export function onCorpseDeath(env, payload) {
  const actor = payload && payload.actor;
  if (!actor) return;
  const store = env.store;
  const idx = actor.poolIndex;
  // `env.actors` is `ctx.peek('actors')` — see `index.js`. A `ctx` with no
  // `actors` cannot run `ai.fixedUpdate` either, so this degrades rather than
  // throwing, the same defensive `peek` precedent `fixedUpdate` uses for
  // `nav`/`physics`.
  if (idx == null || idx >= store.maxBrains || !env.actors) return; // beyond `ai`'s scratch cap — see index.js's MAX_BRAINS
  const step = env.ctx.time.step;

  if (actor.archetypeId === 'dust_shaman') stripHasteBySource(env, actor);
  if (env.shamanStore && env.shamanStore.castAction[idx] === CAST_RAISE) {
    cancelRaiseCast(env, actor, idx, step);
  }

  if (actor.kind !== 'monster') return;
  if (isNeverCorpse(actor.archetypeId)) { store.stats.neverCorpse++; return; }

  // §8.4's overkill test needs the killing blow's magnitude, and this
  // listener cannot have it: `combat` emits `actor:death` from INSIDE its own
  // `actor:damage` handler (`src/combat/xp.js#handleActorDamageForDeath`),
  // and `combat.init` runs before `ai.init`, so `ai`'s own `actor:damage`
  // listener has not seen this hit yet. The corpse is registered here and
  // `noteCorpseDamage` retracts it a moment later if the blow was an
  // overkill — the only ordering in which both numbers are known.
  const gibbed = actorHasAffix(env.affixStore, idx, CORPSE_POLICY.gibAffixId);
  registerCorpse(env, actor, idx, step, gibbed);
}

function registerCorpse(env, actor, idx, step, gibbed) {
  const store = env.store;
  dropCorpse(store, idx); // a recycled pool slot must never inherit the last tenant's corpse
  if (gibbed) { store.stats.gibbed++; return; }
  if (store.slotCount >= store.capacity) { store.stats.evicted++; return; }

  store.slots[store.slotCount++] = idx;
  store.deathStep[idx] = step;
  store.corpseId[idx] = actor.id;
  store.corpseGen[idx] = actor.generation;
  store.corpseX[idx] = actor.x;
  store.corpseZ[idx] = actor.z;
  store.gibbed[idx] = 0;
  if (store.raiseOwnerId[idx] !== actor.id) { store.raiseCount[idx] = 0; store.raiseOwnerId[idx] = actor.id; }
  store.eligible[idx] = actor.archetypeId === CORPSE_POLICY.resurrectableArchetype
    && store.raiseCount[idx] === 0
    && (actor.flags & ACTOR_FLAG_REVIVED) === 0 ? 1 : 0;
  // `ACTOR_FLAG.corpse` is deliberately NOT set here. It is `actors`' bit to
  // raise when it bakes a corpse (`08` §8.2, ACTR-17), and `ai` setting it
  // would leave a stale flag on every corpse this store later drops — §10.8's
  // "does not mark one" in spirit, and a lie to `fx`/`ui` in practice.
  store.stats.corpses++;
  evictToBudget(store, corpseBudgetOf(env.ctx), step);
}

/**
 * `actor:damage`. Records the blow, and — because of the listener ordering
 * described in `onCorpseDeath` — applies `08` §8.4's overkill rule to a
 * corpse that was registered earlier in this same emit.
 */
export function noteCorpseDamage(env, payload) {
  const target = payload && payload.target;
  const result = payload && payload.result;
  if (!target || !result) return;
  const store = env.store;
  const idx = target.poolIndex;
  if (idx == null || idx >= store.maxBrains || !env.actors) return;
  const step = env.ctx.time.step;
  store.lastHitDamage[idx] = result.total || 0;
  store.lastHitStep[idx] = step;

  if (!result.killed || store.deathStep[idx] !== step) return;
  const actors = env.actors;
  const maxLife = actors && typeof actors.stats === 'function' ? actors.stats(target).maxLife : 0;
  if (maxLife > 0 && store.lastHitDamage[idx] >= maxLife * CORPSE_POLICY.gibLifeFraction) {
    dropCorpse(store, idx);
    target.flags &= ~ACTOR_FLAG_CORPSE;
    store.stats.corpses--;
    store.stats.gibbed++;
  }
}

/** §2.4: "On the Shaman's death — every `haste_dust` instance it granted
 * expires immediately." The buff does not live in the status system on this
 * milestone (`brains/shaman.js`'s "O-87 and haste_dust": it is granted into
 * `_hasteStore`'s own arrays because `actors.moveSpeed()` cannot carry it),
 * so the strip is a sweep of that store. `combat.expireBySource` (§16 A3) is
 * still called, guarded, so the real status instances go too the day one
 * exists. */
export function stripHasteBySource(env, shaman) {
  const haste = env.hasteStore;
  let stripped = 0;
  if (haste) {
    const step = env.ctx.time.step;
    for (let i = 0; i < haste.maxBrains; i++) {
      if (haste.hasteSourceId[i] !== shaman.id) continue;
      if (haste.hasteUntilStep[i] < step) continue;
      haste.hasteUntilStep[i] = -1;
      haste.hasteSourceId[i] = 0;
      stripped++;
    }
  }
  const combat = env.ctx.peek('combat');
  if (combat && typeof combat.expireBySource === 'function') {
    combat.expireBySource(shaman.id, shaman.generation, 'haste_dust');
  }
  return stripped;
}

// ===========================================================================
// `actors.resurrectableCorpses(x, z, radius, out) => int`
// ===========================================================================

/** `08` §8.5's five conditions, minus the radius (the query applies that).
 * Condition 5's "on walkable nav" is checked in the query itself, where
 * `nav` is in hand. */
export function isResurrectableCorpse(env, idx, step) {
  const store = env.store;
  if (idx < 0 || idx >= store.maxBrains) return false;
  if (store.deathStep[idx] < 0) return false;            // no corpse, evicted, or already raised
  if (store.gibbed[idx] === 1) return false;             // §8.5 condition 3
  if (store.eligible[idx] !== 1) return false;           // §8.5 condition 1
  if (store.raiseCount[idx] > 0) return false;           // §8.5 condition 4 — the counter
  if (step - store.deathStep[idx] >= RESURRECTABLE_STEPS) return false; // condition 2
  const actor = env.actors.byId(store.corpseId[idx]);
  if (!actor || actor.generation !== store.corpseGen[idx]) return false; // slot recycled
  if (!actor.dead) return false;
  if ((actor.flags & ACTOR_FLAG_REVIVED) !== 0) return false; // the independent second gate
  return true;
}

function navBlocks(nav, x, z) {
  if (!nav || typeof nav.walkable !== 'function') return false; // no nav registered — degrade, never refuse
  if (!nav.grid) return false;                                  // no zone rasterised yet
  return !nav.walkable(x, z);
}

/**
 * `02-api-contracts.md` §7: `(x, z, radius, out:int[]) => int count`,
 * "Sorted by distance, then by corpse id". `Alloc: no` — the candidate set
 * is a bounded insertion sort over three preallocated scratch arrays.
 *
 * Distance is centre-to-centre from `(x,z)`, not `actors.distance`'s
 * surface-to-surface metric: the contract's own parameters are a point and a
 * radius, and `08` §8.5 states the eligibility radius as "within 9.0 m of the
 * Shaman", a point distance. `06` §2.4 has the Shaman querying at 8.0 m,
 * strictly inside that (§15 D-6), so both radii hold.
 *
 * @returns {number} how many ids were written into `out`
 */
export function resurrectableCorpses(env, x, z, radius, out) {
  if (!env.actors) return 0;
  const store = env.store;
  const step = env.ctx.time.step;
  const nav = env.ctx.peek('nav');
  const r2 = radius * radius;
  let m = 0;

  for (let s = 0; s < store.slotCount; s++) {
    const idx = store.slots[s];
    if (!isResurrectableCorpse(env, idx, step)) continue;
    const cx = store.corpseX[idx];
    const cz = store.corpseZ[idx];
    const dx = cx - x;
    const dz = cz - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    if (navBlocks(nav, cx, cz)) continue; // §8.5 condition 5

    const id = store.corpseId[idx];
    // Insertion by (distance, then id) — the tie-break is what makes the
    // Shaman's choice reproducible from a seed (§10.7 "Determinism").
    let p = m < QUERY_CAP ? m : QUERY_CAP - 1;
    while (p > 0 && (store._candDist[p - 1] > d2
      || (store._candDist[p - 1] === d2 && store._candId[p - 1] > id))) {
      store._candDist[p] = store._candDist[p - 1];
      store._candId[p] = store._candId[p - 1];
      store._candIdx[p] = store._candIdx[p - 1];
      p--;
    }
    store._candDist[p] = d2;
    store._candId[p] = id;
    store._candIdx[p] = idx;
    if (m < QUERY_CAP) m++;
  }

  const limit = out ? Math.min(m, out.length) : 0;
  for (let i = 0; i < limit; i++) out[i] = store._candId[i];
  if (Array.isArray(out)) out.length = limit; // a plain-array `out` reports its own count too
  return limit;
}

// ===========================================================================
// `actors.resurrect(actor, lifeFraction) => boolean`
// ===========================================================================

/**
 * The one place `ai` writes a dead actor back into the live world (§10.7).
 *
 * The contracted signature carries no caster, so the Shaman that paid for
 * this is identified here: the nearest `dust_shaman` whose `raise_ranker`
 * resolves on THIS step and whose id is lowest on a tie. Deterministic, and
 * it is the same set §10.8 describes (two Shamans casting at one corpse) —
 * the second one's call never reaches this far because `raiseCount` is
 * already 1. A caller with no such Shaman (the balance harness, a direct
 * unit call) still resurrects; the actor simply gets a fresh brain with no
 * inherited target.
 */
export function resurrectActor(env, actor, lifeFraction) {
  if (!actor || !env.actors) return false;
  const store = env.store;
  const idx = actor.poolIndex;
  const step = env.ctx.time.step;
  if (!isResurrectableCorpse(env, idx, step)) { store.stats.refused++; return false; }

  const actors = env.actors;
  const fraction = typeof lifeFraction === 'number' && lifeFraction > 0
    ? lifeFraction : CORPSE_POLICY.reviveLifeFraction;
  const maxLife = typeof actors.stats === 'function' ? actors.stats(actor).maxLife : 0;

  actor.dead = false;
  actor.life = Math.max(1, Math.round(maxLife * fraction));
  actor.killerId = 0;
  actor.flags = (actor.flags | ACTOR_FLAG_REVIVED) & ~ACTOR_FLAG_CORPSE;

  store.raiseCount[idx] += 1;
  store.raiseOwnerId[idx] = actor.id;
  dropCorpse(store, idx);
  store.stats.raised++;

  const shamanIdx = findRaisingShaman(env, actor, step);
  if (shamanIdx >= 0) {
    store.pairedStep[shamanIdx] = step;
    if (env.shamanStore) env.shamanStore.reviveCredits[shamanIdx] = 0; // §10.7's `reviveCredits -= 1`, spent on hitTick
  }
  if (store.pendCount < PENDING_CAP) {
    store.pendIdx[store.pendCount] = idx;
    store.pendShaman[store.pendCount] = shamanIdx;
    store.pendCount++;
  }
  return true;
}

function findRaisingShaman(env, corpse, step) {
  const store = env.store;
  const brains = env.brains;
  const shamanStore = env.shamanStore;
  if (!shamanStore) return -1;
  const live = env.actors.all;
  let best = -1;
  let bestD2 = Infinity;
  let bestId = 0;
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a.archetypeId !== 'dust_shaman' || a.dead) continue;
    const idx = a.poolIndex;
    if (idx >= store.maxBrains) continue;
    if (shamanStore.castAction[idx] !== CAST_RAISE) continue;
    if (brains.hitTickStep[idx] !== step && store.expectStep[idx] !== step) continue;
    if (store.pairedStep[idx] === step) continue; // already credited with a raise this step
    const dx = a.x - corpse.x;
    const dz = a.z - corpse.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2 || (d2 === bestD2 && a.id < bestId)) { best = idx; bestD2 = d2; bestId = a.id; }
  }
  return best;
}

// ===========================================================================
// The two per-step passes
// ===========================================================================

/**
 * Runs BEFORE any brain steps. Ages corpses out, and applies §2.4's
 * interruption rule to every in-flight `raise_ranker` — which must happen
 * before `stepShamanBrain` resolves a `hitTick` that falls on this step.
 */
export function stepCorpsesPre(env) {
  if (!env.actors) return;
  const store = env.store;
  const step = env.ctx.time.step;

  // §8.3's lifetime. Oldest first, so the scan stops at the first survivor.
  while (store.slotCount > 0 && (step - store.deathStep[store.slots[0]]) >= LIFETIME_STEPS) {
    dropSlotAt(store, 0);
    store.stats.dissolved++;
  }

  const shamanStore = env.shamanStore;
  if (!shamanStore) return;
  const live = env.actors.all;
  for (let i = 0; i < live.length; i++) {
    const actor = live[i];
    const idx = actor.poolIndex;
    if (idx >= store.maxBrains) continue;
    if (shamanStore.castAction[idx] !== CAST_RAISE || env.brains.swingActive[idx] !== 1) continue;

    if (isCastInterrupted(env.actors, actor)) {
      cancelRaiseCast(env, actor, idx, step);
      store.stats.interrupts++;
      continue;
    }
    // The hitTick this brain will resolve later in this same step. Recorded
    // so the post-pass can tell "resolved into a raise" from "fizzled".
    if (env.brains.hitTickStep[idx] === step) store.expectStep[idx] = step;
  }
}

/** `08` §6.6: `stun` and `death` cancel a wind-up. `frozen` is §2.4's own
 * addition to that row. */
function isCastInterrupted(actors, actor) {
  if (actor.dead) return true;
  if (typeof actors.hasStatus !== 'function') return false;
  return actors.hasStatus(actor, 'stunned') || actors.hasStatus(actor, 'frozen');
}

/**
 * Cancels the ritual without touching `reviveCredits` — which IS the refund:
 * §2.4 spends the credit on `hitTick`, so a cast that never reaches it never
 * debited anything. See this file's header, ambiguity 2.
 */
function cancelRaiseCast(env, actor, idx, step) {
  const brains = env.brains;
  const store = env.store;
  brains.swingActive[idx] = 0;
  brains.hitTickStep[idx] = -1;
  brains.attackReadyStep[idx] = step;
  env.shamanStore.castAction[idx] = CAST_NONE;
  store.expectStep[idx] = -1;
  if (actor.dead) return;
  if (brains.state[idx] === env.BRAIN_STATE.attack) brains.state[idx] = env.BRAIN_STATE.chase;
  // Hold the action off until the incapacitating status has expired.
  // `brains/shaman.js` never checks `canAct`, so without this the Shaman
  // re-casts on its next decision — still stunned — and the interruption
  // would cost it nothing at all. See this file's header, ambiguity 3.
  const actors = env.actors;
  let holdSteps = 0;
  if (typeof actors.statusRemaining === 'function') {
    const stun = actors.statusRemaining(actor, 'stunned', step) || 0;
    const frozen = actors.statusRemaining(actor, 'frozen', step) || 0;
    holdSteps = Math.ceil(Math.max(stun, frozen) * FIXED_HZ);
  }
  const until = step + holdSteps + 1;
  if (env.shamanStore.raiseReadyStep[idx] < until) env.shamanStore.raiseReadyStep[idx] = until;
  brains.nextDecisionStep[idx] = until;
}

/**
 * Runs AFTER the brain loop. Gives every actor raised this step §10.7's
 * fresh brain, settles the pack accounting, emits `ai:corpse-raised`, and
 * charges §10.7's fizzle to any Shaman whose `hitTick` came and went without
 * reviving anything.
 */
export function stepCorpsesPost(env) {
  if (!env.actors) return;
  const store = env.store;
  const step = env.ctx.time.step;

  for (let p = 0; p < store.pendCount; p++) {
    applyFreshBrain(env, store.pendIdx[p], store.pendShaman[p], step);
  }
  store.pendCount = 0;

  const shamanStore = env.shamanStore;
  if (!shamanStore) return;
  const live = env.actors.all;
  for (let i = 0; i < live.length; i++) {
    const idx = live[i].poolIndex;
    if (idx >= store.maxBrains || store.expectStep[idx] !== step) continue;
    store.expectStep[idx] = -1;
    if (store.pairedStep[idx] === step) continue; // the ritual landed

    // §10.7: "the cast fizzles, the credit is NOT refunded, cooldown starts."
    // `brains/shaman.js#resolveRaiseRanker` returns without spending anything
    // when its own hitTick re-query comes back empty; the rule is this
    // ticket's, so the debit happens here.
    if (shamanStore.reviveCredits[idx] > 0) {
      shamanStore.reviveCredits[idx] = 0;
      store.stats.fizzles++;
    }
    // A brain that was never dispatched this step (deactivated pack, dead
    // target) leaves its hitTick stamp behind — clear it so the cast cannot
    // resolve on some later step against a different corpse.
    if (env.brains.hitTickStep[idx] === step) {
      env.brains.hitTickStep[idx] = -1;
      env.brains.swingActive[idx] = 0;
      shamanStore.castAction[idx] = CAST_NONE;
    }
  }
}

/** §10.7's block, verbatim, minus the two lines its caller already did
 * (`actors.resurrect` and the credit). */
function applyFreshBrain(env, idx, shamanIdx, step) {
  const brains = env.brains;
  const actors = env.actors;
  const actor = actors.byId(env.store.corpseId[idx]) || null;
  const nav = env.ctx.peek('nav');

  brains.active[idx] = 1;
  brains.state[idx] = env.BRAIN_STATE.chase;
  brains.targetId[idx] = shamanIdx >= 0 ? brains.targetId[shamanIdx] : 0;
  brains.nextDecisionStep[idx] = step;
  brains.attackReadyStep[idx] = step;
  brains.swingActive[idx] = 0;
  brains.hitTickStep[idx] = -1;

  // A fresh brain is a brain with no history: leash dwell, wake ripple and
  // decision cadence all start from this step, not from the life it had
  // before it died.
  const perception = env.perception;
  if (perception && idx < perception.maxBrains) {
    perception.stateEnteredStep[idx] = step;
    perception.overLeashSinceStep[idx] = -1;
    perception.wakeAtStep[idx] = -1;
    perception.chaseHookNextStep[idx] = -1;
    perception.nextDecisionStep[idx] = -1;
    perception.lastSeenStep[idx] = -1;
    perception.bled[idx] = 0;
    // §10.7: `brain.packId = shaman.brain.packId`. Its own membership
    // survives death (nothing unregisters it), so this only adopts the
    // caster's pack when the corpse had none.
    if (perception.packSlot[idx] < 0 && shamanIdx >= 0) perception.packSlot[idx] = perception.packSlot[shamanIdx];
  }

  const navStore = env.navStore;
  if (navStore && idx < navStore.maxBrains) {
    navStore.pathVersion[idx] = nav ? nav.version : -1;
    navStore.useFlowField[idx] = 1;
    navStore.hasPath[idx] = 0;
    navStore.pendingRequestId[idx] = 0;
    navStore.pendingSinceStep[idx] = -1;
    navStore.repathAtStep[idx] = step;
    navStore.demotedUntilStep[idx] = -1;
  }

  if (actor) {
    bumpPackAliveCount(env, actor);
    const payload = env.store.raisedPayload;
    payload.actor = actor;
    payload.shaman = shamanIdx >= 0 ? shamanForIndex(env, shamanIdx) : null;
    payload.point.x = actor.x;
    payload.point.y = actor.y;
    payload.point.z = actor.z;
    env.ctx.events.emit('ai:corpse-raised', payload);
  }
}

function shamanForIndex(env, shamanIdx) {
  const live = env.actors.all;
  for (let i = 0; i < live.length; i++) if (live[i].poolIndex === shamanIdx) return live[i];
  return null;
}

/** §10.7's "Pack accounting: `aliveCount` increases". `PackDescriptor.members`
 * is the only mapping from an actor back to its pack that exists (`ai`
 * hardcodes `packId: 0` on every spawn — `src/world/transition.js`'s own
 * `actor:death` handler scans the same list for the decrement). */
function bumpPackAliveCount(env, actor) {
  const world = env.ctx.peek('world');
  const packs = world && world.packs;
  if (!packs) return false;
  for (let i = 0; i < packs.length; i++) {
    const members = packs[i].members;
    if (!Array.isArray(members)) continue;
    for (let j = 0; j < members.length; j++) {
      if (!members[j] || members[j].id !== actor.id) continue;
      packs[i].aliveCount = (packs[i].aliveCount | 0) + 1;
      return true;
    }
  }
  return false;
}

// ===========================================================================
// The `actors` adapter — see this file's header
// ===========================================================================

/** Defines `02-api-contracts.md` §7's two corpse rows on the live `actors`
 * instance, if and only if nothing else already has. Returns whether it
 * installed. */
export function installCorpseApi(env) {
  const actors = env.actors;
  if (!actors) return false;
  if (typeof actors.resurrectableCorpses === 'function' || typeof actors.resurrect === 'function') return false;
  env._corpseQuery = (x, z, radius, out) => resurrectableCorpses(env, x, z, radius, out);
  env._corpseRevive = (actor, lifeFraction) => resurrectActor(env, actor, lifeFraction);
  actors.resurrectableCorpses = env._corpseQuery;
  actors.resurrect = env._corpseRevive;
  return true;
}

/** Removes what `installCorpseApi` installed, and only that — a real
 * implementation that replaced it in the meantime is left alone. */
export function uninstallCorpseApi(env) {
  const actors = env && env.actors;
  if (!actors) return;
  if (actors.resurrectableCorpses === env._corpseQuery) delete actors.resurrectableCorpses;
  if (actors.resurrect === env._corpseRevive) delete actors.resurrect;
  env._corpseQuery = null;
  env._corpseRevive = null;
}
