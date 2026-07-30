// src/combat/status.js
//
// CMBT-4 — statuses, DoT ticking, the CC chain: `03-combat-math.md` §7 in
// full (the duration rule, §7.1-§7.10, §7.3's chill accumulation) and §6.3
// (what a DoT tick skips, the tick cadence). Backlog correction D-14: E8
// (chill accumulation, §7.3) belongs to THIS ticket, not CMBT-2.
//
// `packet.js` (O-51's assembly rule) imports this file and attaches its
// methods to `CombatSystem`; this file imports nothing from `packet.js` and
// nothing from `main.js`. It DOES import a handful of already-exported pure
// resistance helpers from its sibling `./resolve.js` (CMBT-3, accepted) —
// that is a sibling-to-sibling import within the same subsystem directory
// (`resolve.js` itself already imports from `./tohit.js` the same way), not
// a cross-subsystem import; `ARCHITECTURE.md` rule 2 is about never
// importing ANOTHER SUBSYSTEM's module (e.g. `src/actors/...`), which this
// file never does — see "The actors-wiring gap" below for the one place
// that boundary actually bites.
//
// ---------------------------------------------------------------------------
// Ownership recap (see `src/actors/status.js`'s own header, which states
// the same split from the other side)
// ---------------------------------------------------------------------------
// `actors` owns the `StatusEffectInstance` pool, the bitfield, and the four
// stacking rules (`01-data-model.md` §7, ACTR-10, accepted) — this file
// never allocates or mutates a `StatusEffectInstance` directly, it only
// calls `actorsSystem.applyStatus(actor, spec)` / `.removeStatus(...)` /
// etc., exactly as `02-api-contracts.md`'s "Status effects" section
// documents: "`combat` is the only legitimate caller of `applyStatus` /
// `removeStatus`". `combat` (this file) decides WHEN and WHY a status is
// applied: the diminishing-returns chain, the chill accumulator, the DoT
// tick loop, and folding the applied set into the `status` stat layer
// (O-48) are all combat's own math, not actors'.
//
// `actor.chillPoints` / `actor.stunChain` / `actor.stunChainAt` /
// `actor.ccImmuneUntil` are already-reserved plain fields on the shared
// `Actor` record (`01-data-model.md` §2, `src/actors/pool.js`'s own
// `createActorRecord`/`resetActorRecord` — both already zero them on
// spawn/recycle). `src/actors/status.js`'s own header says as much:
// "chill accumulation... or the stun diminishing-returns chain... are
// populated by combat/CMBT-4, per `pool.js`'s own field comment — this file
// never writes them." Reading/writing them here is plain data-field access
// on the shared record (the same category as `resolve.js` reading
// `target.statuses`/`target.stats` directly), not a module import.
//
// ---------------------------------------------------------------------------
// The actors-wiring gap (pre-existing, not caused by this ticket, not fixed
// by it — `src/actors/index.js` is not in this ticket's file list)
// ---------------------------------------------------------------------------
// `resolve.js`'s own header already documents this: `ActorsSystem`
// (`src/actors/index.js`) does not yet forward `applyStatus`/`stats`/
// `setSourceLayer`/etc. from their owning sibling files onto its own public
// class (verified again for this ticket: the file's tracked history stops
// at ACTR-6's archetype-visual escape hatch; ACTR-7/8/9/10's own methods are
// never attached). Every call this file makes into `actorsSystem` is
// therefore guarded exactly the way CMBT-3 already established —
// `typeof actorsSystem.applyStatus === 'function'` — and every one of them
// is a real, correctly-shaped call that simply no-ops until whichever
// ticket wires `src/actors/index.js` lands. This is flagged again, loudly,
// in this ticket's report: without that wiring, NONE of this file's status
// applications (frozen, the onHitStatus riders, the O-48 stat layer) have
// any observable effect in a live game today, even though every number this
// file computes is correct and independently tested against the spec's
// worked examples using a stub `actorsSystem` wired to the REAL
// `src/actors/status.js`/`src/actors/stats.js` functions — the same stub
// pattern `tests/combat/resolve.test.js` already established for the
// identical situation.
//
// ---------------------------------------------------------------------------
// `applyStatusFromPacket` — a standalone method, not a second copy of R14(b)/(c)
// ---------------------------------------------------------------------------
// `resolve.js`'s own R14(b)/(c) (accepted, CMBT-3) already seeds poison and
// applies `onHitStatus[]` riders INLINE, guarded the same way. This ticket's
// own brief lists `applyStatusFromPacket(packet, target, result) => void` as
// a public `combat` method per `02-api-contracts.md` — a DIFFERENT thing
// from resolve()'s inline seam: `resolve()` already applies its riders
// unconditionally as part of R1-R14, so calling this method again on the
// SAME packet+result after `resolve()` ran would double-apply them (a
// second RNG draw per rider, a second poison seed). This method exists for
// a caller that does NOT go through the full R1-R14 pipeline and therefore
// never got its riders applied at all — `applyDirect()` is exactly that
// caller today (`resolve.js`'s own `applyDirectDamage` computes a
// `DamageResult` but never touches `packet.onHitStatus[]`). This
// implementation is also the fully spec-compliant one (`03 §7`'s duration
// rule — ccReduction, the DR chain for `stunned`/`frozen` — none of which
// `resolve.js`'s own inline copy applies, since CMBT-3 predates this
// ticket's §7 reading window). `resolve.js` itself is not in this ticket's
// file list and is not edited to call this method instead of its own inline
// copy — that de-duplication is a future ticket's job, flagged here as a
// real, documented gap (a caller of BOTH `resolve()` and
// `applyStatusFromPacket()` on the same hit would double-apply riders;
// nothing in this codebase does that today).
//
// ---------------------------------------------------------------------------
// Chill accumulation's own timing state — combat-owned, not on the Actor record
// ---------------------------------------------------------------------------
// `03 §7.3`'s formula needs `secondsSinceLastColdHit`, a per-actor value no
// field on `01-data-model.md` §2's `Actor` record carries (verified by
// reading that section in full — `lastDamageStep` is "any damage", not
// cold-specific, and every named CC field is already claimed for the DR
// chain/immunity window). Since `pool.js` is not in this ticket's file
// list, this file keeps its OWN small side table
// (`ColdHitTracker`/`createColdHitTracker`), a growable `Float64Array`
// indexed by the already-stable `actor.poolIndex` (never `Map`, per the
// pooled-state ban), one entry per pool slot recording the LAST fixed step a
// cold hit landed on that slot, plus a parallel `generation` guard array so
// a respawned actor recycled into the same slot never inherits a stale
// timestamp from whoever occupied it before (`actor.poolIndex` is stable
// for the life of a slot, but a NEW actor's `generation` differs from the
// previous occupant's — `01`'s own `id = 1 + poolIndex + generation*capacity`
// bijection is the same invalidation signal `ActorPool#resolve` uses).
//
// `applyColdHit`'s core math takes `dtSeconds` as a plain, explicit
// parameter (not derived internally from `ctx.time.step`) so this file's
// own acceptance test can reproduce the ticket's literal worked-example
// cadences (0.675 s, 0.4675 s, 0.35 s, 2.0 s) to the arithmetic's full
// precision; none of those three numbers is an exact multiple of the fixed
// step (`1/60 s`), so quantizing them to the nearest step first (as the
// live per-hit integration below necessarily does) would silently drift the
// second decimal place away from the spec's own numbers. This mirrors every
// other "stepXX" pure function in this subsystem (`resolve.js`'s
// `stepR7a`/`stepR7b`/... take plain numbers, not a `ctx`) — the SCHEDULING
// of when a cold hit happens is `ctx.time.step`-driven (never `dt`/wall
// clock, rule 4); the ELAPSED SECONDS between two such scheduled events is
// ordinary arithmetic on two step indices, exactly like `statusRemaining`'s
// own `(expiresStep - step) / FIXED_HZ` conversion in `src/actors/status.js`.

import {
  resistAfterPierce,
  isImmuneAtResist,
  cappedEffectiveResist,
  applyResistFactor,
} from './resolve.js';

// ---------------------------------------------------------------------------
// Data — `ARCHITECTURE.md` rule 9: gameplay numbers live in data, not in
// code. This ticket's file list has no `src/combat/data/` entry (same
// situation CMBT-1's `packet.js` documented for its own combat-owned
// constants), so these live here, isolated and labelled, rather than as
// literals inside the functions below.
// ---------------------------------------------------------------------------

const FIXED_HZ = 60;

/** `03 §7.3`, verbatim. */
export const CHILL_DECAY_PER_SECOND = 25;
export const CHILL_FREEZE_THRESHOLD = 100;
/** `03 §7.1`'s default chill magnitude ("the skill's override" is a future
 * skills-table concern — see `packet.js`'s own documented gap 1 for the
 * identical "no skill table yet" situation). */
export const CHILL_DEFAULT_MAGNITUDE = 30;

/** `03 §7.2`. */
export const FROZEN_BASE_DURATION = 1.2;
export const FROZEN_CHAMPION_MULT = 0.5;
export const FROZEN_UNIQUE_MULT = 0.35;
export const FROZEN_REAPPLY_IMMUNITY_SECONDS = 3.0; // mirrors src/actors/status.js's own constant
/** `03 §7.2`: "Boss: immune; a freeze trigger instead applies `chilled` at
 * magnitude 60 for 2.0 s." */
export const BOSS_FREEZE_CONVERT_CHILL_MAGNITUDE = 60;
export const BOSS_FREEZE_CONVERT_CHILL_DURATION = 2.0;

/** `03 §7.7`/§7.2's shared diminishing-returns chain: `0.6^0 .. 0.6^3`, then
 * refusal. Four entries — a fifth application always falls through to the
 * "refused" branch below, never indexes past this array. */
export const DR_CHAIN_MULTIPLIERS = Object.freeze([1, 0.6, 0.36, 0.216]);
export const DR_CHAIN_WINDOW_SECONDS = 6.0;
export const DR_CHAIN_IMMUNITY_SECONDS = 6.0;
/** `03 §7.7`: "Boss: duration × 0.25, DR chain shared with `frozen`." */
export const STUNNED_BOSS_DURATION_MULT = 0.25;

/** `03 §6.3` / `01 §7.4`: 4 Hz (15 steps) for burning/poisoned, 2 Hz (30
 * steps) for bleeding. Only these three statuses tick. */
export const TICK_INTERVAL_STEPS = Object.freeze({ burning: 15, poisoned: 15, bleeding: 30 });

/** Which stat pair (`03 §6.3`: "applies resistance (R9, R10) and, for
 * `bleeding`, `physicalResist`") mitigates each ticking status's damage. A
 * DoT tick has no pierce stat of its own (§6.3: it skips every to-hit/rider
 * row), so pierce is always 0 here — R9/R10 still run, just with pierce
 * fixed at 0. */
const DOT_RESIST_STAT = Object.freeze({
  burning: Object.freeze({ resist: 'fireResist', max: 'maxFireResist' }),
  poisoned: Object.freeze({ resist: 'poisonResist', max: 'maxPoisonResist' }),
  bleeding: Object.freeze({ resist: 'physicalResist', max: 'maxPhysicalResist' }),
});

/** `03 §7`'s preamble: every duration is ccReduction-adjusted EXCEPT these
 * three, "whose durations are fixed by the applying skill." */
const CC_REDUCTION_EXEMPT_STATUSES = new Set(['burning', 'poisoned', 'bleeding']);

/** `03 §7.7`'s own DR chain is explicitly "shared with `frozen`" — the one
 * shared chain this file tracks via `actor.stunChain`/`stunChainAt`. */
const DR_CHAIN_STATUSES = new Set(['stunned', 'frozen']);

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** `03 §7`'s preamble formula, `(1 - clamp(ccReduction,0,75)/100)`. `0` (no
 * reduction) when `actor.stats` is not yet composed — defensive, never
 * exercised by a real actor (`composeStats` always builds a `StatBlock`). */
function ccMultiplierOf(actor) {
  const cc = actor.stats ? clamp(actor.stats.ccReduction, 0, 75) : 0;
  return 1 - cc / 100;
}

function rankMultiplierForFrozen(rank) {
  if (rank === 'champion') return FROZEN_CHAMPION_MULT;
  if (rank === 'unique') return FROZEN_UNIQUE_MULT;
  return 1;
}

// ---------------------------------------------------------------------------
// The shared diminishing-returns chain — `03 §7.7` (stunned) / §7.2 (frozen)
// ---------------------------------------------------------------------------

/**
 * One consultation of the shared CC diminishing-returns chain, for either a
 * `stunned` or a `frozen` application attempt. Mutates `actor.stunChain` /
 * `actor.stunChainAt` / `actor.ccImmuneUntil` in place (plain data fields,
 * see the file header) and returns whether this attempt is allowed and, if
 * so, what fraction of the requested duration survives.
 *
 * Rolling-window reset: if more than `DR_CHAIN_WINDOW_SECONDS` have passed
 * since the last chain entry, the chain restarts at ×1 — `03 §7.7`: "within
 * a 6.0 s window, successive stuns... scale ×1, ×0.6, ×0.36, ×0.216."
 *
 * Refusal: already inside a `ccImmuneUntil` window (set either by THIS
 * function's own previous refusal, or by `frozen`'s natural-expiry
 * reapply-block — `src/actors/status.js#expireStatuses` — both write the
 * same one field, by design: one shared "hard CC" gate, multiple writers)
 * refuses outright. The 5th attempt inside one window is also refused and
 * opens a fresh `DR_CHAIN_IMMUNITY_SECONDS` window.
 *
 * @param {object} actor
 * @param {number} step `ctx.time.step`
 * @returns {{allowed:boolean, multiplier:number, chainIndex:number}}
 */
export function rollDrChain(actor, step) {
  if (step < actor.ccImmuneUntil) return { allowed: false, multiplier: 0, chainIndex: -1 };

  const windowSteps = DR_CHAIN_WINDOW_SECONDS * FIXED_HZ;
  if (actor.stunChain > 0 && step - actor.stunChainAt > windowSteps) {
    actor.stunChain = 0;
  }

  if (actor.stunChain >= DR_CHAIN_MULTIPLIERS.length) {
    actor.ccImmuneUntil = Math.max(actor.ccImmuneUntil, step + DR_CHAIN_IMMUNITY_SECONDS * FIXED_HZ);
    actor.stunChain = 0; // the window that follows starts fresh at ×1 once immunity lapses
    return { allowed: false, multiplier: 0, chainIndex: -1 };
  }

  const chainIndex = actor.stunChain;
  const multiplier = DR_CHAIN_MULTIPLIERS[chainIndex];
  actor.stunChain = chainIndex + 1;
  actor.stunChainAt = step;
  return { allowed: true, multiplier, chainIndex };
}

// ---------------------------------------------------------------------------
// Chill accumulation → frozen — `03 §7.3`, E8
// ---------------------------------------------------------------------------

/** The pure formula, `03 §7.3` verbatim: "on a cold hit: `chillPoints =
 * max(0, chillPoints - 25 * secondsSinceLastColdHit) + magnitude`." Floors
 * at 0 (never negative) before the new magnitude is added — this is what
 * makes E8.4 (a 2.0 s cadence, where `25*2.0=50 > 30`) stable at exactly
 * 30.00 every hit rather than drifting negative.
 * @param {number} chillPointsBefore
 * @param {number} magnitude
 * @param {number} dtSeconds seconds since the previous cold hit (`Infinity`
 *   for "no previous hit" — decays the accumulator fully to 0 first)
 * @returns {number}
 */
export function accumulateChillPoints(chillPointsBefore, magnitude, dtSeconds) {
  const decayed = Math.max(0, chillPointsBefore - CHILL_DECAY_PER_SECOND * dtSeconds);
  return decayed + magnitude;
}

/**
 * The full E8 mechanic for one cold hit on `target`: accumulates
 * `target.chillPoints`, and — once it crosses `CHILL_FREEZE_THRESHOLD` —
 * attempts to freeze (or, for a boss, substitutes `chilled`), through the
 * shared DR chain, then resets the accumulator to 0 regardless of whether
 * the freeze attempt actually stuck (`03 §7.3`: "if chillPoints >= 100 ->
 * apply frozen, set chillPoints = 0" — the reset is unconditional on the
 * trigger firing, not on the application succeeding).
 *
 * `cannotBeFrozen` (`target.stats.cannotBeFrozen`) blocks the frozen
 * application itself but not the accumulation/reset (`03 §7.2`: "the chill
 * still applies").
 *
 * @param {object} target
 * @param {object} opts
 * @param {number} [opts.magnitude] default `CHILL_DEFAULT_MAGNITUDE`
 * @param {number} opts.dtSeconds seconds since target's last cold hit
 * @param {number} opts.step `ctx.time.step`
 * @param {number} [opts.sourceId]
 * @param {number} [opts.sourceGen]
 * @param {string|null} [opts.sourceSkill]
 * @param {object} opts.actorsSystem `ctx.get('actors')` — see the file
 *   header, "the actors-wiring gap"
 * @returns {{chillPointsAfterHit:number, triggered:boolean, instance:object|null}}
 *   `chillPointsAfterHit` is the raw accumulated value BEFORE any
 *   threshold-reset (E8's own printed rows show this pre-reset value).
 */
export function applyColdHit(target, opts) {
  const magnitude = opts.magnitude ?? CHILL_DEFAULT_MAGNITUDE;
  const before = target.chillPoints;
  const after = accumulateChillPoints(before, magnitude, opts.dtSeconds);
  target.chillPoints = after;

  let triggered = false;
  let instance = null;

  if (after >= CHILL_FREEZE_THRESHOLD) {
    triggered = true;
    target.chillPoints = 0; // consumed regardless of outcome — see this function's own header
    instance = tryTriggerFreeze(target, opts);
  }

  return { chillPointsAfterHit: after, triggered, instance };
}

/** Shared by `applyColdHit`'s threshold trigger and (defensively, for a
 * hypothetical future skill rider naming `frozen` directly, which no
 * documented worked example exercises today) `applyStatusFromPacket`'s
 * rider loop. `03 §7.2`: boss is immune outright and gets `chilled`(60,
 * 2.0s) instead; champion/unique scale the normal frozen duration; every
 * rank still consults the shared DR chain first — even a boss's converted
 * `chilled` application books a chain entry, since the chain is
 * documented as shared with (would-be) `frozen`, not gated by whether the
 * literal `frozen` status ends up applied.
 * @param {object} target
 * @param {object} opts see `applyColdHit`'s own `opts`
 * @returns {object|null} the applied `StatusEffectInstance`, or `null`
 */
function tryTriggerFreeze(target, opts) {
  const step = opts.step;
  const dr = rollDrChain(target, step);

  if (target.rank === 'boss') {
    // Boss: frozen never applies; the trigger substitutes a fixed chilled
    // application instead. Not itself gated on `dr.allowed` — the
    // substitute is the boss's DOCUMENTED response to a freeze trigger, not
    // a CC application the chain can refuse (see this function's header).
    return tryApplyStatus(opts.actorsSystem, target, {
      status: 'chilled',
      step,
      sourceId: opts.sourceId ?? 0,
      sourceGen: opts.sourceGen ?? 0,
      sourceSkill: opts.sourceSkill ?? 'chill_accumulation',
      element: 'cold',
      magnitude: BOSS_FREEZE_CONVERT_CHILL_MAGNITUDE,
      duration: BOSS_FREEZE_CONVERT_CHILL_DURATION * ccMultiplierOf(target),
      stacks: 1,
    });
  }

  if (target.stats && target.stats.cannotBeFrozen) return null; // "the chill still applies" — accumulator already reset by the caller
  if (!dr.allowed) return null;

  const duration = FROZEN_BASE_DURATION * rankMultiplierForFrozen(target.rank) * dr.multiplier * ccMultiplierOf(target);
  return tryApplyStatus(opts.actorsSystem, target, {
    status: 'frozen',
    step,
    sourceId: opts.sourceId ?? 0,
    sourceGen: opts.sourceGen ?? 0,
    sourceSkill: opts.sourceSkill ?? 'chill_accumulation',
    element: 'cold',
    magnitude: 0,
    duration,
    stacks: 1,
  });
}

// ---------------------------------------------------------------------------
// ColdHitTracker — combat's own per-slot "last cold hit step" side table
// ---------------------------------------------------------------------------

const NO_PRIOR_HIT = -Infinity;

/**
 * @param {number} [initialCapacity]
 * @returns {{lastStep:Float64Array, generation:Int32Array, capacity:number}}
 */
export function createColdHitTracker(initialCapacity = 256) {
  const lastStep = new Float64Array(initialCapacity).fill(NO_PRIOR_HIT);
  const generation = new Int32Array(initialCapacity).fill(-1);
  return { lastStep, generation, capacity: initialCapacity };
}

function ensureColdHitTrackerCapacity(tracker, minIndex) {
  if (minIndex < tracker.capacity) return;
  const grown = Math.max(minIndex + 1, tracker.capacity * 2);
  const nextStep = new Float64Array(grown).fill(NO_PRIOR_HIT);
  nextStep.set(tracker.lastStep);
  const nextGen = new Int32Array(grown).fill(-1);
  nextGen.set(tracker.generation);
  tracker.lastStep = nextStep;
  tracker.generation = nextGen;
  tracker.capacity = grown;
}

/** Seconds since `actor`'s last recorded cold hit, or `Infinity` if none is
 * on record for `actor`'s CURRENT `generation` (a fresh occupant of a
 * recycled pool slot never inherits the previous occupant's timestamp —
 * see the file header).
 * @param {object} tracker a `createColdHitTracker()` result
 * @param {object} actor
 * @param {number} step
 * @returns {number}
 */
export function secondsSinceLastColdHit(tracker, actor, step) {
  const idx = actor.poolIndex;
  ensureColdHitTrackerCapacity(tracker, idx);
  if (tracker.generation[idx] !== actor.generation) return Infinity;
  const last = tracker.lastStep[idx];
  return (step - last) / FIXED_HZ;
}

/** Records `step` as `actor`'s most recent cold hit.
 * @param {object} tracker
 * @param {object} actor
 * @param {number} step
 */
export function recordColdHitStep(tracker, actor, step) {
  const idx = actor.poolIndex;
  ensureColdHitTrackerCapacity(tracker, idx);
  tracker.lastStep[idx] = step;
  tracker.generation[idx] = actor.generation;
}

/** The live per-hit integration point: reacts to `actor:damage` (emitted by
 * `resolve()`/`applyDirect()`, `ARCHITECTURE.md`'s event table) and, when
 * cold damage actually landed (`result.cold > 0` — naturally excludes miss/
 * dodge/block/fully-immune, since none of those ever populate `result.cold`
 * — see this file's header), runs `applyColdHit`. This is the ONE place
 * this file listens to combat's own emitted event rather than being called
 * directly by a packet-build caller; it does not touch `resolve.js` at all
 * (subscribing to an already-documented event is the sanctioned
 * cross-subsystem-reaction mechanism, `ARCHITECTURE.md`'s "Cross-subsystem
 * events" section, not a code edit to that file).
 * @param {{target:object, source:object|null, result:object}} payload
 * @param {object} env `{ tracker, step, actorsSystem }`
 */
export function onActorDamageForChill(payload, env) {
  const { target, result } = payload;
  if (!target || target.dead || !result || !(result.cold > 0)) return;

  const dtSeconds = secondsSinceLastColdHit(env.tracker, target, env.step);
  applyColdHit(target, {
    magnitude: CHILL_DEFAULT_MAGNITUDE,
    dtSeconds,
    step: env.step,
    sourceId: result.sourceId,
    sourceGen: result.sourceGen,
    sourceSkill: result.sourceSkillId,
    actorsSystem: env.actorsSystem,
  });
  recordColdHitStep(env.tracker, target, env.step);
  rebuildStatusLayer(target, env.actorsSystem, env.events);
}

// ---------------------------------------------------------------------------
// Guarded call helpers — the actors-wiring gap (see file header)
// ---------------------------------------------------------------------------

function tryApplyStatus(actorsSystem, actor, spec) {
  if (!actorsSystem || typeof actorsSystem.applyStatus !== 'function') return null;
  return actorsSystem.applyStatus(actor, spec);
}

// ---------------------------------------------------------------------------
// O-48 — folding `instance.statMods` into the `status` StatSources layer
// ---------------------------------------------------------------------------

/**
 * `01 §4.1`'s `status` layer / `01 §7.2`'s six `statMods`-carrying statuses.
 * `composeStats` (accepted, unedited) already consumes `sources.status`
 * correctly — nothing populated it (verified by grep, `docs/PROGRESS.md`'s
 * O-48). Rebuilds the layer from every LIVE instance's own `statMods`
 * (`src/actors/status.js#buildStatMods` already computed those correctly at
 * apply/refresh time — this function only sums what is already there, it
 * never recomputes a magnitude) and calls
 * `actorsSystem.setSourceLayer(actor, 'status', partial)`, then emits
 * `stats:dirty` — this ticket's own brief, verbatim. Guarded the same way
 * as every other actors-side call (see the file header): a no-op today
 * until `ActorsSystem` forwards `setSourceLayer`.
 *
 * `poisoned`'s `lifeRegen` is a fixed 0, not additive (`01 §7.2`: "set to
 * 0", not "-= magnitude") — `buildStatMods` already encodes this per
 * instance, so a plain per-key sum is correct even when several statuses
 * both touch `lifeRegen` (only `poisoned` ever does, today).
 * @param {object} actor
 * @param {object} actorsSystem
 * @param {object} events `ctx.events`, or `null`
 */
export function rebuildStatusLayer(actor, actorsSystem, events) {
  if (!actorsSystem || typeof actorsSystem.setSourceLayer !== 'function') return;

  const partial = {};
  const list = actor.statuses;
  for (let i = 0; i < list.length; i++) {
    const mods = list[i].statMods;
    if (!mods) continue;
    for (const key in mods) {
      partial[key] = (partial[key] || 0) + mods[key];
    }
  }

  actorsSystem.setSourceLayer(actor, 'status', partial);
  if (events && typeof events.emit === 'function') events.emit('stats:dirty', { actor });
}

// ---------------------------------------------------------------------------
// applyStatusFromPacket — 02-api-contracts.md §8's own public method
// ---------------------------------------------------------------------------

/**
 * `(packet, target, result) => void`. See the file header for why this is a
 * standalone, fully spec-compliant implementation and not a second call
 * into `resolve.js`'s own inline R14(b)/(c). Applies, in the documented R14
 * order:
 *   (b) the poison DoT seed, IF `result.poison > 0` and `packet.poisonDuration > 0`
 *       — duration fixed by the packet, no ccReduction (`03 §7`'s exemption list).
 *   (c) `packet.onHitStatus[]` riders, each its own `U(0,100) < chance` draw
 *       from `env.rng` (combat's OWN forked stream, never re-forked —
 *       ARCHITECTURE.md rule 3), in array order. `stunned`/`frozen` riders
 *       go through the shared DR chain; every other rider gets a plain
 *       ccReduction-adjusted duration.
 * Folds the resulting status set into the `status` stat layer (O-48) once,
 * after both steps, if anything actually changed.
 * @param {object} packet
 * @param {object} target
 * @param {object} result a `DamageResult` (from `resolve()` or `applyDirect()`)
 * @param {object} env `{ actorsSystem, rng, step, events, statusSpec }`
 */
export function applyStatusFromPacket(packet, target, result, env) {
  if (!target || target.dead || !packet) return;
  let changed = false;

  const poisonAppliedTotal = result ? result.poison || 0 : 0;
  if (poisonAppliedTotal > 0 && packet.poisonDuration > 0) {
    const inst = tryApplyStatus(env.actorsSystem, target, {
      status: 'poisoned',
      step: env.step,
      sourceId: packet.sourceId,
      sourceGen: packet.sourceGen,
      sourceSkill: packet.sourceSkillId,
      element: 'poison',
      magnitude: poisonAppliedTotal / packet.poisonDuration,
      duration: packet.poisonDuration,
      stacks: 1,
    });
    if (inst) changed = true;
  }

  for (let i = 0; i < packet.onHitCount; i++) {
    const rider = packet.onHitStatus[i];
    if (env.rng.next() * 100 >= rider.chance) continue;
    if (applyOneRider(target, rider, packet, env)) changed = true;
  }

  if (changed) rebuildStatusLayer(target, env.actorsSystem, env.events);
}

/** One `onHitStatus[]` rider, already past its own chance roll. Returns
 * `true` iff a `StatusEffectInstance` was actually created. */
function applyOneRider(target, rider, packet, env) {
  const step = env.step;

  if (DR_CHAIN_STATUSES.has(rider.status)) {
    if (rider.status === 'frozen') {
      // See `tryTriggerFreeze`'s own header — no documented worked example
      // drives a rider naming `frozen` directly; handled the same way as
      // the chill-accumulation trigger for consistency.
      const inst = tryTriggerFreeze(target, {
        step,
        sourceId: packet.sourceId,
        sourceGen: packet.sourceGen,
        sourceSkill: packet.sourceSkillId,
        actorsSystem: env.actorsSystem,
      });
      return !!inst;
    }
    const dr = rollDrChain(target, step);
    if (!dr.allowed) return false;
    const bossMult = target.rank === 'boss' ? STUNNED_BOSS_DURATION_MULT : 1;
    const duration = rider.duration * bossMult * dr.multiplier * ccMultiplierOf(target);
    const inst = tryApplyStatus(env.actorsSystem, target, {
      status: 'stunned',
      step,
      sourceId: packet.sourceId,
      sourceGen: packet.sourceGen,
      sourceSkill: packet.sourceSkillId,
      element: null,
      magnitude: rider.magnitude,
      duration,
      stacks: rider.stacks || 1,
    });
    return !!inst;
  }

  const duration = CC_REDUCTION_EXEMPT_STATUSES.has(rider.status)
    ? rider.duration
    : rider.duration * ccMultiplierOf(target);
  const inst = tryApplyStatus(env.actorsSystem, target, {
    status: rider.status,
    step,
    sourceId: packet.sourceId,
    sourceGen: packet.sourceGen,
    sourceSkill: packet.sourceSkillId,
    element: null,
    magnitude: rider.magnitude,
    duration,
    stacks: rider.stacks || 1,
  });
  return !!inst;
}

// ---------------------------------------------------------------------------
// expireBySource — combat's own, ACROSS-ALL-ACTORS method (02-api-contracts.md
// §8) — distinct from src/actors/status.js's single-actor `expireBySource(actor, sourceId)`
// ---------------------------------------------------------------------------

/**
 * `(sourceId, sourceGen, status|null) => int expired`. "Expires every
 * `StatusEffectInstance` matching the source, optionally filtered by
 * status, emitting `actor:status` with `duration: 0` for each" —
 * `02-api-contracts.md`, verbatim. Walks every live actor
 * (`actorsSystem.all`), reading `actor.statuses` directly (plain data field,
 * same as `resolve.js`'s `shockedStacksOf`) to find matches before deciding
 * how to remove them.
 *
 * A documented gap (see the file header): `src/actors/status.js`'s own
 * `expireBySource(actor, sourceId)` filters by `sourceId` alone (no
 * `sourceGen`, no `status`). When `status` is given, this function removes
 * ONLY the matching instances by first checking whether every instance of
 * that status on that actor shares `sourceId` (`removeStatus` cannot filter
 * by source, `actors.expireBySource` cannot filter by status) — a
 * same-status instance from a DIFFERENT source on the SAME actor is left
 * alone by refusing to call either primitive for that actor at all, rather
 * than risk over-removal; this under-removes in the (currently
 * unencountered) case of a mixed-source same-status pair. `sourceGen` is
 * read for the match check but `src/actors/status.js`'s primitives
 * themselves do not verify it — flagged in this ticket's report as a real
 * API gap for whoever next touches `src/actors/status.js`.
 * @param {number} sourceId
 * @param {number} sourceGen
 * @param {string|null} status
 * @param {object} env `{ actorsSystem, events }`
 * @returns {number}
 *
 * ---------------------------------------------------------------------------
 * O-43/12.A01 repair (TEST-6, live): `Alloc: no` per this method's own
 * `02-api-contracts.md` row, measured — the original `.filter()`/`.every()`
 * version allocated a fresh array (and, for `.every()`'s inline arrow
 * capturing `status`/`sourceId`, a fresh closure) on every call, 3.4723
 * B/call over a 10-actor live set at N=1e6, well past the < 1 B/call
 * threshold. Rewritten below as plain index walks — no array method, no
 * per-call closure, no intermediate array — the same style
 * `resolve.js#shockedStacksOf` already uses for the identical reason.
 *
 * Fixed IN THE SAME PASS, found while rewriting: the original also read
 * `inst.status`/`inst.sourceId` for the emitted `actor:status` payload
 * AFTER already calling `actorsSystem.expireBySource`/`.removeStatus` —
 * both release the matched instance back to ACTR-10's pool IN PLACE
 * (`releaseInstance` zeroes `status`/`sourceId`/etc on that same object),
 * so the emitted event silently carried `status: null, source: 0` instead
 * of the real values (verified with a standalone repro before this fix).
 * Below, every matching instance's `status` is read and emitted BEFORE the
 * removal call runs; `source` uses the already-known `sourceId` parameter
 * directly (every matched instance shares it by construction), never a
 * post-release field read.
 */
export function expireBySourceAcrossActors(sourceId, sourceGen, status, env) {
  const actorsSystem = env.actorsSystem;
  if (!actorsSystem) return 0;

  let expired = 0;
  const list = actorsSystem.all;
  for (let i = 0; i < list.length; i++) {
    const actor = list[i];
    const statuses = actor.statuses;

    // One zero-alloc forward pass answers both branches below: does ANY
    // instance match (source [+status]), and — status-filtered case only —
    // does a same-status instance from a DIFFERENT source also exist on
    // this actor (the "refuse rather than over-remove" guard, unchanged
    // from before this fix; see this function's own header above).
    let matchCount = 0;
    let mixedSourceSameStatus = false;
    for (let j = 0; j < statuses.length; j++) {
      const inst = statuses[j];
      const fromThisSource = inst.sourceId === sourceId && inst.sourceGen === sourceGen;
      if (status != null && inst.status === status && !fromThisSource) mixedSourceSameStatus = true;
      if (fromThisSource && (status == null || inst.status === status)) matchCount++;
    }
    if (matchCount === 0) continue;

    if (status == null) {
      if (typeof actorsSystem.expireBySource !== 'function') continue;
      for (let j = 0; j < statuses.length; j++) {
        const inst = statuses[j];
        if (inst.sourceId === sourceId && inst.sourceGen === sourceGen) emitExpiredOne(actor, inst.status, sourceId, env);
      }
      const removed = actorsSystem.expireBySource(actor, sourceId);
      if (removed > 0) {
        expired += removed;
        rebuildStatusLayer(actor, actorsSystem, env.events);
      }
      continue;
    }

    if (mixedSourceSameStatus) continue; // refuse rather than over-remove — unchanged
    if (typeof actorsSystem.removeStatus !== 'function') continue;

    for (let j = 0; j < statuses.length; j++) {
      const inst = statuses[j];
      if (inst.status === status && inst.sourceId === sourceId && inst.sourceGen === sourceGen) emitExpiredOne(actor, status, sourceId, env);
    }
    const removed = actorsSystem.removeStatus(actor, status);
    if (removed > 0) {
      expired += removed;
      rebuildStatusLayer(actor, actorsSystem, env.events);
    }
  }
  return expired;
}

/** One reused `actor:status` scratch payload, mutated in place and emitted
 * synchronously — `EventBus#emit` (src/core/events.js, CORE-4) walks its
 * handler array by index and never stashes the payload past the call, the
 * same "never stash it" contract every scratch object in this engine
 * already carries (`motion.js`'s `MoveResult`, `resolve.js`'s
 * `damagePayload`). Module-level rather than threaded through `env`:
 * `env` (`_statusEnv`) is built once in `packet.js`'s `init()`, off-limits
 * this round, and does not carry a slot for it.
 * @type {{target:object|null, status:string|null, stacks:number, duration:number, source:number}}
 */
const EXPIRE_EVENT_SCRATCH = { target: null, status: null, stacks: 0, duration: 0, source: 0 };

function emitExpiredOne(actor, status, sourceId, env) {
  if (!env.events || typeof env.events.emit !== 'function') return;
  const p = EXPIRE_EVENT_SCRATCH;
  p.target = actor;
  p.status = status;
  p.stacks = 0;
  p.duration = 0;
  p.source = sourceId;
  env.events.emit('actor:status', p);
}

// ---------------------------------------------------------------------------
// DoT ticking — 03-combat-math.md §6.3 / 01-data-model.md §7.4
// ---------------------------------------------------------------------------

/**
 * One fixed step's DoT sweep, over every live actor. Scheduled purely
 * against `env.step` (`ctx.time.step`, never `dt`/wall clock — rule 4): an
 * instance ticks exactly on the step ACTR-10's `computeNextTickStep` chose
 * at apply time (`actor.id % 15`-phased), and this function advances that
 * same field by the status's own interval for the next tick, never
 * recomputing phase itself (no private step counter, ARCHITECTURE.md's own
 * warning against exactly that).
 * @param {object} env `{ actorsSystem, events, resultPool }`
 */
export function runDotTicks(env) {
  const actorsSystem = env.actorsSystem;
  const step = env.step;
  const list = actorsSystem.all;
  for (let i = 0; i < list.length; i++) {
    tickActorDots(list[i], step, env);
  }
}

/** `03 §6.3`: "A DoT tick is not a hit. It skips R2, R3, R4, R6, R14(c-h)
 * entirely. It applies resistance (R9, R10) and, for `bleeding`,
 * `physicalResist`, but never `damageReduceFlat` and never
 * `damageReducePercent`. It cannot crit, cannot leech, cannot proc a
 * status, cannot cause hit recovery, cannot knock back. It can kill, and it
 * credits the original `sourceId` for XP." XP crediting is CMBT-6's own
 * seam (no XP system exists yet, same documented no-op every other CMBT
 * ticket left for it) — `inst.sourceId` is carried on the emitted event so
 * a future XP system can read it there.
 * @param {object} actor
 * @param {number} step
 * @param {object} env
 */
function tickActorDots(actor, step, env) {
  if (actor.dead || !actor.stats) return;
  const list = actor.statuses;
  if (!list || list.length === 0) return;

  for (let i = 0; i < list.length; i++) {
    const inst = list[i];
    const tickIntervalSteps = TICK_INTERVAL_STEPS[inst.status];
    if (!tickIntervalSteps) continue; // not a ticking status
    if (step !== inst.nextTickStep) continue;
    if (step >= inst.expiresStep) continue; // let expiry retire it — not this file's tick to take

    applyOneDotTick(actor, inst, tickIntervalSteps, env);
    inst.nextTickStep += tickIntervalSteps;
  }
}

function applyOneDotTick(actor, inst, tickIntervalSteps, env) {
  const tickIntervalSeconds = tickIntervalSteps / FIXED_HZ;
  const rawTick = inst.magnitude * tickIntervalSeconds;

  const resistDef = DOT_RESIST_STAT[inst.status];
  const stats = actor.stats;
  const r = resistAfterPierce(stats[resistDef.resist], 0);
  let tickDamage = 0;
  let immune = false;
  if (isImmuneAtResist(r)) {
    immune = true;
  } else {
    const effective = cappedEffectiveResist(r, stats[resistDef.max]);
    tickDamage = applyResistFactor(rawTick, effective);
    if (tickDamage < 0) tickDamage = 0;
  }

  inst.totalRemaining = Math.max(0, inst.totalRemaining - rawTick);

  const lifeBefore = actor.life;
  actor.life -= tickDamage;
  if (actor.life < 0) actor.life = 0;
  const killed = actor.life <= 0 && lifeBefore > 0;

  emitDotTick(actor, inst, tickDamage, immune, killed, env);
}

function emitDotTick(actor, inst, tickDamage, immune, killed, env) {
  if (!env.events || typeof env.events.emit !== 'function' || !env.resultPool) return;
  const result = env.resultPool.acquire();
  if (!result) return;

  result.targetId = actor.id;
  result.targetGen = actor.generation;
  result.sourceId = inst.sourceId;
  result.sourceGen = inst.sourceGen;
  result.sourceSkillId = inst.sourceSkill;
  result.outcome = immune ? 'immune' : 'hit';
  result.killed = killed;
  result.total = tickDamage;
  if (inst.status === 'bleeding') result.physical = tickDamage;
  else if (inst.status === 'burning') result.fire = tickDamage;
  else if (inst.status === 'poisoned') result.poison = tickDamage;

  env.events.emit('actor:damage', { target: actor, source: null, result });
  env.resultPool.release(result);
}
