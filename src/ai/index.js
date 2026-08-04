// src/ai/index.js
//
// AI-2 — the `ai` subsystem shell, M2 slice: `06-monsters-ai.md` §13 step 2's
// deliverable, "A Bone Ranker spawned by hand... walks to the player, swings
// on schedule, deals damage, dies, and awards XP." Implements exactly the
// `02-api-contracts.md` §12 rows that criterion needs — `archetype`/
// `archetypes` (AI-1's bestiary, read-only), `spawnOne`, `brainOf`,
// `setTarget`, `aliveCount`/`activeCount`, `stats`, `fixedUpdate`, `dispose`.
//
// NOT implemented here — §13 steps 3-12 territory (perception/leash/packs,
// nav integration, crowd, the other five archetypes, champions/uniques,
// corpses/resurrection, Molgrim, difficulty tiers, the balance harness),
// none of which this ticket's single-monster, no-nav criterion needs:
// `spawnPack`, `despawnAll`, `alertPack`, `rollAffixes`, `affixStats`,
// `bossPhase`/`bossPhaseProgress`/`bossActor`, `packTemplate`,
// `priorityTargets`, `setDensityBudget`, `debugStage`, `prewarmMaterials`.
// Left UNIMPLEMENTED, not stubbed with fake return values — O-27: this is
// not an assertion that those features don't exist, only that this ticket
// did not build them. `stats` (the one property partially implemented) has
// `pathRequests`/`pathRefusals`/`flowUsers` hardcoded to `0` because nav
// integration is §13 step 4, not this ticket's — this is a real gap, not
// synthetic data; see the report.
//
// ---------------------------------------------------------------------------
// AI-3 addendum — perception, aggro and leash (`06` §4 in full)
// ---------------------------------------------------------------------------
// `alertPack` is added below (a thin forward into `./perception.js`, same
// "index.js: wiring only" precedent `src/nav/index.js`'s own NAV-2/NAV-3/
// NAV-4/NAV-5 addenda already establish for this codebase). `BRAIN_STATE`
// gains `wander`/`alert`/`reposition` (additive — see that constant's own
// comment for why this does not change `spawnOne`/`brainOf`/`aliveCount`'s
// behaviour). `fixedUpdate` now dispatches `dormant`/`wander`/`alert`/
// `reposition` brains into `perception.js#stepPerceptionBrain`, and hooks
// `checkLeash`/`stepChaseHooks` into `chase`/`attack` brains BEFORE handing
// them to `stepMeleeBrain` — see `perception.js`'s own header for exactly
// why leash/de-aggro for a chasing brain has to live there rather than in
// `brains/melee.js` (AI-2's file, off-limits to this ticket). `spawnOne`,
// `brainOf` and `aliveCount` themselves are byte-for-byte unchanged.
//
// ---------------------------------------------------------------------------
// The Ranker never gets a composed `StatBlock` — on purpose
// ---------------------------------------------------------------------------
// A monster's outgoing damage numbers (`physMin/Max`, `attackRating`) are
// re-derived straight from `BESTIARY[archetypeId]` × the mlvl multipliers at
// the moment of the hit (`brains/melee.js#emitRankerHit`), not read off
// `actor.stats`. `actor.stats`/`actor.sources` are therefore left `null`
// (never composed) for every actor `spawnOne` creates. Checked, deliberately,
// against every consumer this scenario's damage/life/XP path touches:
//   - `combat.applyDirect`/`applyDirectDamage` only reads/writes
//     `target.life`/`.dead`/`.id`/`.generation` — never `.stats` (verified by
//     reading `src/combat/resolve.js`).
//   - `combat` awards XP via `awardXp(killer, victim)`, which reads
//     `victim.baseXp`/`.level`/`.rank` — never `.stats` (verified by reading
//     `src/combat/xp.js`).
//   - The Ranker is never the TARGET of `combat.resolve()`'s mitigated
//     pipeline in this ticket's scenario (only the SOURCE of one, and the
//     target of `applyDirect`, above) — so `target.stats.defense` is never
//     read off it either.
// The only reason to compose real stats here would be `setSourceLayer`/
// `composeStats` (`src/actors/stats.js`) — neither of which `ActorsSystem`
// (`src/actors/index.js`, ACTR-1/2, off-limits to this ticket) forwards on
// its public instance. Importing those module-level functions into THIS
// (production) file would be a real `ARCHITECTURE.md` rule-2 violation (an
// `ai` -> `actors` internals import); the two traps in this ticket's brief
// warn about exactly this class of shortcut. Since nothing in the
// acceptance criterion actually needs a composed `StatBlock` on the
// monster (checked above), the honest choice is not to fake one — flagged
// here, not routed around. A future ticket that DOES need
// `target.stats.defense` on a live monster (e.g. once a real player attack
// goes through `combat.resolve()` instead of a scripted `applyDirect`) will
// need `ActorsSystem` to forward `setSourceLayer`/`composeStats`/`stats`
// first; that is real, load-bearing, unfinished work, not a design choice
// this ticket is making on its behalf.
//
// `actor.life` and `actor.baseXp` ARE written directly, post-`actors.spawn()`
// — no sanctioned method exists for either (`baseXp` is not even an
// allocated field on `pool.js#createActorRecord`; `src/combat/xp.js`'s own
// header calls this "a documented, forward-compatible gap... forward
// compatible with a future ai/bestiary ticket populating it on spawn" —
// this is that ticket). This mirrors the exact pattern combat's own accepted
// tests already use for both fields (`tests/combat/xp.test.js#makeActor`).
//
// ---------------------------------------------------------------------------
// `actor.state` is never touched — see `brains/melee.js`'s header
// ---------------------------------------------------------------------------
// This subsystem never calls `setState`/`beginAction` (not forwarded by
// `ActorsSystem` either, same reasoning as above). A spawned Ranker's
// `actor.state` therefore stays `'spawning'` for its whole life. Brain state
// (`dormant`/`chase`/`attack`/`dead`) lives entirely in this file's own
// parallel typed arrays, matching `06` §3.1's "advance independently."
//
// ---------------------------------------------------------------------------
// `setTarget` bypasses perception — the M2 activation path
// ---------------------------------------------------------------------------
// `06` §3.3's S2 (`dormant -> alert`) needs perception/noise/pack-alert (§4,
// step 3 — not built). This ticket's own criterion is "a Bone Ranker spawned
// BY HAND" — no live player to perceive, no pack to wake it. `setTarget`
// (`02-api-contracts.md` §12, already a public row) is used as the
// documented, sanctioned hand-activation hook: assigning a target to a
// `dormant` brain moves it straight to `chase`, skipping `alert` entirely.
// This is a real, flagged design decision, not a hidden shortcut — a future
// perception ticket (§13 step 3) should decide whether `setTarget` on a
// `dormant` brain ought to keep doing this once real perception exists.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()` — `tools/check-imports.mjs` scans `src/ai/` with
// `checkThree: true, checkGlobals: true` (AI-1 added the root). One
// `ctx.rng.fork()` in `init()`, per `06` §14 — kept, never spent by this
// ticket's own code (no roll is needed anywhere in the M2 FSM), but taken
// here so a later ticket that DOES need the `ai` stream never accidentally
// re-forks per `06` §14's "once in init(), never re-forked."

import { BESTIARY, lifeMult } from './data/bestiary.js';
import { stepMeleeBrain, MELEE_ARCHETYPES } from './brains/melee.js';
import {
  createPerceptionStore,
  checkLeash,
  stepChaseHooks,
  stepPerceptionBrain,
  processNoiseRing,
  alertPack as alertPackImpl,
  onActorDamage,
  onActorDeath,
  onSkillImpact,
  onBossPhase,
} from './perception.js';
import { createNavBrainStore, stepNavScheduler, onNavRebuilt } from './nav.js';
import { createCrowdStore, stepCrowdMember } from './crowd.js';
import { createSwarmStore, stepSwarmBrain, stepSwarmFlee, onSwarmDeath, SWARM_ARCHETYPES } from './brains/swarm.js';
import { createArcherStore, stepArcherBrain, ARCHER_ARCHETYPES } from './brains/archer.js';
import { createShamanStore, initShamanBrain, stepShamanBrain, createHasteStore, SHAMAN_ARCHETYPES } from './brains/shaman.js';
import { stepMaulsmithBrain, MAULSMITH_ARCHETYPES } from './brains/maulsmith.js';
import { createCrawlerStore, stepCrawlerBrain, CRAWLER_ARCHETYPES } from './brains/crawler.js';

// ---------------------------------------------------------------------------
// AI-6 addendum — the remaining five archetypes (`06` §2.2-2.6, §3.4-3.8)
// ---------------------------------------------------------------------------
// Wiring only, per this ticket's own grant: five new imports (above), five
// new per-archetype stores plus the one shared `_hasteStore` (constructor),
// `spawnOne`'s accepted-archetype set widened from `MELEE_ARCHETYPES` alone
// to all six (see `spawnOne`'s own comment for why this is "wiring", not a
// behavioural change to what it returns for `bone_ranker`), one new
// `actor:death` listener (`init()`, same precedent AI-3's own perception
// listeners already set), one new `BRAIN_STATE.flee` (additive — see
// `BRAIN_STATE`'s own comment), and `fixedUpdate`'s existing per-brain loop
// dispatches `chase`/`attack` to the right archetype's step function instead
// of unconditionally calling `stepMeleeBrain` — every branch for
// `bone_ranker` is byte-for-byte what it was before this ticket.
// `spawnOne`/`brainOf`/`aliveCount` return the exact same shapes they always
// did.

// ---------------------------------------------------------------------------
// AI-4 addendum — nav integration and the A* budget (`06` §9 in full)
// ---------------------------------------------------------------------------
// Wiring only, per this ticket's own grant: a new import (above), a
// `nav:rebuilt` listener (`init()`), one call from `fixedUpdate` (after the
// existing per-brain loop), and `stats` now reading real numbers instead of
// AI-2's hardcoded zeroes for `pathRequests`/`pathRefusals`/`flowUsers`. The
// real scheduler — `needsPath`, the ring, the flow-field default, the >40
// hard demotion, the `i % 45` invalidation spread — lives entirely in
// `./nav.js`; see that file's header for the algorithm and every resolved
// ambiguity. `spawnOne`/`brainOf`/`aliveCount` are byte-for-byte unchanged.

// ---------------------------------------------------------------------------
// AI-5 addendum — crowd: ring slots, lanes, doorways (`06` §8 in full)
// ---------------------------------------------------------------------------
// Wiring only, per this ticket's own grant: a new import (above), a new
// `this._crowdStore` (constructor), and ONE new branch in `fixedUpdate`'s
// existing per-brain loop, inserted between target resolution and the
// existing `stepMeleeBrain` call — for a `chase`-state brain that is a
// registered pack member (`this._perception.packSlot[idx] >= 0`) and not
// yet within its own archetype's contact range, `stepCrowdMember`
// (`./crowd.js`) runs INSTEAD of `stepMeleeBrain` this step and performs
// real movement itself (ring slot + lane offset + avoidance + doorway-queue
// + rank rotation). Every other brain — not a pack member, in `attack`, or
// already in contact range — is dispatched exactly as before this ticket;
// see `./crowd.js`'s own header for the full reasoning on why this handoff
// exists (in short: `brains/melee.js`'s chase-state movement is
// unconditional and off-limits to edit, so this file's dispatch is the only
// lever available to let `crowd.js`'s steering actually move an actor).
// `spawnOne`/`brainOf`/`aliveCount` are byte-for-byte unchanged.

// AI-3 — perception.js's own header explains WHY leash/de-aggro for a
// chasing brain has to be hooked in here rather than inside
// `brains/melee.js` (S15/the chase-side de-aggro rule fire out of states
// `melee.js` owns, and this ticket's file list does not grant that file).
// This import and the `BRAIN_STATE` extension below are this ticket's only
// changes to this file — `spawnOne`/`brainOf`/`aliveCount` are untouched,
// per the ticket's own "wiring only" grant.

/** Matches `src/actors/action.js`/`src/actors/timing.js`'s own
 * `SCRATCH_CAPACITY = 256` precedent — comfortably above
 * `01-data-model.md`'s documented `q.maxActors` ceiling (220). Fixed, not
 * grown: this ticket's own scope (one hand-spawned monster) never stresses
 * it, and matching the sibling files' constant keeps the convention
 * consistent rather than inventing a different cap for the same reason. */
const MAX_BRAINS = 256;

/** Brain state codes. AI-2 shipped `{dormant, chase, attack, dead}` (`06`
 * §13 step 2's restricted set); AI-3 adds `wander`/`alert`/`reposition` —
 * the three more of `06` §3.3's nine states this ticket's perception/leash
 * work needs (`cast`/`flee` stay unbuilt — no shipped brain produces them
 * yet). This is the ONE place that owns the numeric encoding (passed BY
 * VALUE into `brains/melee.js` and `perception.js`, never imported by
 * either) — extending it is additive: every existing code (0-3) and every
 * existing caller of `brainOf()`/`spawnOne()`/`aliveCount` is unchanged: a
 * new state is simply a name `BRAIN_STATE_NAMES` can now also report, which
 * is what makes this ticket's wiring rather than a behavioural change to
 * any of those three protected methods. Exported so `perception.js`'s own
 * pack-registration helpers (not `02-api-contracts.md`-contracted, so not
 * `AiSystem` methods — see that file's header) and this ticket's tests can
 * share the one encoding without a second, drifting copy. */
// AI-6 adds `flee` (§3.3's ninth and last state) — `carrion_swarm`'s own
// scatter (§3.7 C2/C3), the only brain that produces it this milestone.
// Additive, same precedent AI-3's own three states already set: every
// existing code (0-6) and every existing caller of
// `brainOf()`/`spawnOne()`/`aliveCount` is unchanged.
export const BRAIN_STATE = Object.freeze({
  dormant: 0, chase: 1, attack: 2, dead: 3, wander: 4, alert: 5, reposition: 6, flee: 7,
});
const BRAIN_STATE_NAMES = Object.freeze(['dormant', 'chase', 'attack', 'dead', 'wander', 'alert', 'reposition', 'flee']);

export class AiSystem {
  static id = 'ai';

  // `02-api-contracts.md` §12, verbatim. `nav`/`world` are real, already-
  // registered subsystems (`src/nav/index.js`, `src/world/index.js`) — this
  // only fixes INIT ORDER (`ARCHITECTURE.md` rule 2: "static deps declares
  // init order only, not an import"); this ticket's own code never calls a
  // `nav`/`world` method (direct steering, no nav — §13 step 2).
  static deps = ['actors', 'nav', 'combat', 'world'];

  constructor() {
    this._ctx = null;
    this._rng = null;
    this._decisionCount = 0;

    /** One shared, preallocated bag of parallel typed arrays — `ARCHITECTURE.md`
     * rule 6 / this ticket's own rule 5: no `Map`, no per-frame allocation.
     * Indexed by `actor.poolIndex`, the same convention `action.js`/
     * `timing.js` already use for per-actor scratch. Passed BY REFERENCE
     * (same object, every call) into `stepMeleeBrain` — never rebuilt. */
    this._brains = {
      active: new Uint8Array(MAX_BRAINS),
      state: new Int32Array(MAX_BRAINS),
      targetId: new Int32Array(MAX_BRAINS),
      nextDecisionStep: new Int32Array(MAX_BRAINS),
      attackReadyStep: new Int32Array(MAX_BRAINS),
      swingActive: new Uint8Array(MAX_BRAINS),
      hitTickStep: new Int32Array(MAX_BRAINS),
    };

    /** AI-3 — `perception.js`'s own parallel-array bag (lastSeen, leash
     * dwell, wake ripple, pack registry, the noise ring). Built once, passed
     * by reference, matching `_brains`'s own convention above. Exposed as a
     * plain instance field (not a `02-api-contracts.md`-contracted public
     * method) so this ticket's tests can register a hand-placed pack
     * directly — the same "reach a private field for test setup" precedent
     * `tests/ai/melee.test.js` already uses on `ctx._systems`. */
    this._perception = createPerceptionStore(MAX_BRAINS);

    /** AI-4 — `./nav.js`'s own parallel-array bag (A* request bookkeeping,
     * flow-field eligibility, the ring cursor, the flowDistance cache). Same
     * "built once, passed by reference" convention as `_brains`/`_perception`
     * above; exposed as a plain instance field (not a `02-api-contracts.md`
     * -contracted method) so this ticket's tests can inspect scheduler state
     * directly — same "reach a private field for test setup" precedent
     * `tests/ai/melee.test.js`/`tests/ai/perception.perf.test.js` already
     * use on `ctx._systems`/`ai._perception`. */
    this._navStore = createNavBrainStore(MAX_BRAINS);

    /** AI-5 — `./crowd.js`'s own parallel-array bag (ring slot/lane index,
     * doorway-queue timer, rank-rotation clock, held avoidance vector, pack
     * formation state). Same "built once, passed by reference" convention as
     * `_brains`/`_perception`/`_navStore` above; exposed as a plain instance
     * field for the same "reach a private field for test setup" precedent. */
    this._crowdStore = createCrowdStore(MAX_BRAINS);

    /** AI-6 — one small per-archetype store per new brain file, same "built
     * once, passed by reference" convention as every store above, plus the
     * ONE shared `_hasteStore` (`brains/shaman.js#createHasteStore`) every
     * new brain file reads to apply `haste_dust`'s movement-speed grant —
     * see that file's header ("O-87 and haste_dust") for why it lives there
     * and is passed by reference rather than duplicated per file. */
    this._swarmStore = createSwarmStore(MAX_BRAINS);
    this._archerStore = createArcherStore(MAX_BRAINS);
    this._shamanStore = createShamanStore(MAX_BRAINS);
    this._crawlerStore = createCrawlerStore(MAX_BRAINS);
    this._hasteStore = createHasteStore(MAX_BRAINS);

    /** `brainOf()`'s reused scratch — same "valid until the next call, never
     * stash one" discipline `motion.js`'s `MoveResult` / `pool.js`'s no-`out`
     * `ref()` scratch already document for this codebase. */
    this._brainView = { state: 'dormant', targetId: 0 };
  }

  async init(ctx) {
    this._ctx = ctx;
    // `06` §14: "`ai` takes one `ctx.rng.fork()` in `init()` and never
    // re-forks." Not spent by this ticket's own code (no roll anywhere in
    // the restricted M2 FSM) — taken anyway so the ONE legal fork already
    // exists before any future ticket's temptation to fork per-event.
    this._rng = ctx.rng.fork();

    // AI-3 — wiring `perception.js`'s event-driven half (§4.5 noise, §4.6's
    // damage/death pack-alert triggers, S17). Draws no randomness, does not
    // touch `this._rng` — rule 3's "do not take a second fork" is about
    // `ctx.rng.fork()`, not event registration.
    ctx.events.on('actor:damage', (payload) => onActorDamage(ctx, ctx.get('actors'), this._brains, this._perception, BRAIN_STATE, payload));
    ctx.events.on('actor:death', (payload) => onActorDeath(ctx, ctx.get('actors'), this._brains, this._perception, BRAIN_STATE, payload));
    // AI-6 — `carrion_swarm`'s own scatter (§3.7 C2), evaluated on every
    // `actor:death`, same event-listener precedent as the two rows above.
    ctx.events.on('actor:death', (payload) => onSwarmDeath(ctx, ctx.get('actors'), ctx.peek('nav'), this._brains, this._perception, this._swarmStore, BRAIN_STATE, payload));
    ctx.events.on('skill:impact', (payload) => onSkillImpact(ctx, this._perception, payload));
    ctx.events.on('boss:phase', (payload) => onBossPhase(ctx, this._perception, payload));

    // AI-4 — `06` §9.4: on a zone's `nav:rebuilt`, walk every brain once and
    // spread the resulting repath demand over the next 45 steps. See
    // `./nav.js#onNavRebuilt`'s own header for the algorithm.
    ctx.events.on('nav:rebuilt', (payload) => onNavRebuilt(ctx, this._brains, this._navStore, BRAIN_STATE, payload));
  }

  // ─── Bestiary accessors (02-api-contracts.md §12) ──────────────────────

  /** `archetype(id) => MonsterArchetype | null`. */
  archetype(id) {
    return BESTIARY[id] || null;
  }

  /** `archetypes` -> `MonsterArchetype[]` — "the six plus Molgrim" (AI-1's
   * table already carries all seven). */
  get archetypes() {
    return Object.values(BESTIARY);
  }

  // ─── Spawning (02-api-contracts.md §12) ─────────────────────────────────

  /**
   * `spawnOne(archetypeId, x, z, mlvl, rank, affixes) => Actor | null`.
   * `rank`/`affixes` are accepted per the documented signature but this
   * ticket only exercises `rank: 'normal'` (no champion/unique promotion,
   * no affix rolls — §13 steps 8/M8) and `mlvl` scaling uses ONLY the pure
   * mlvl multipliers (no rank/difficulty multiplier tables — out of this
   * ticket's reading scope, `06` §2.0's own caveat).
   *
   * Never spawns through `actors.spawn()` alone and stops there — this is
   * the one sanctioned path per `02-api-contracts.md` §12's own "Forbidden
   * for callers": "Never spawn a monster through `actors.spawn()`
   * directly — a monster without a brain is a statue."
   * @param {string} archetypeId
   * @param {number} x
   * @param {number} z
   * @param {number} mlvl
   * @param {string} [rank]
   * @param {string[]} [affixes]
   * @returns {object|null}
   */
  spawnOne(archetypeId, x, z, mlvl, rank, affixes) {
    const row = BESTIARY[archetypeId];
    if (!row) return null;
    // AI-6 — widened from `MELEE_ARCHETYPES` alone (AI-2's own M2 scope) to
    // every archetype a brain now exists for: the six sets below are a
    // straight union, each owned by its own file. `molgrim` (no brain any
    // ticket through M5 builds — `06` §13 step 10) still refuses cleanly.
    // Everything AFTER this check — `actors.spawn()`, `actor.life`/
    // `actor.baseXp`, the `idx >= MAX_BRAINS` guard, `_brains`' own six
    // resets — is byte-for-byte what `bone_ranker` always got; only the
    // per-archetype store initialisation below (`initShamanBrain`) is new,
    // and it touches nothing this method already returns.
    if (!MELEE_ARCHETYPES.has(archetypeId) && !SWARM_ARCHETYPES.has(archetypeId)
      && !ARCHER_ARCHETYPES.has(archetypeId) && !SHAMAN_ARCHETYPES.has(archetypeId)
      && !MAULSMITH_ARCHETYPES.has(archetypeId) && !CRAWLER_ARCHETYPES.has(archetypeId)) {
      // No brain exists for this archetype yet — see this file's and each
      // `brains/*.js` header. Refusing cleanly (`null`) rather than spawning
      // a brainless statue or a monster whose brain silently never decides
      // anything.
      return null;
    }

    const actors = this._ctx.get('actors');
    const actor = actors.spawn({
      kind: 'monster',
      archetypeId,
      rank: rank || 'normal',
      level: mlvl,
      team: 1,
      x,
      z,
      facing: 0,
      packId: 0,
      ownerId: 0,
      affixes: affixes || [],
    });
    if (!actor) return null;

    // `06` §2.0: "every row is bestiaryValue × mlvlMult(n), evaluated at
    // full precision and rounded ONCE" — this ticket's own reading scope
    // has only the pure mlvl functions (no rank/difficulty tables), so
    // `rank`/difficulty beyond 'normal'/Instruction do not further scale
    // life here; see the header above.
    actor.life = Math.round(row.baseLife * lifeMult(mlvl));
    // `actor.baseXp` — see this file's header ("a documented,
    // forward-compatible gap... this is that ticket").
    actor.baseXp = row.baseXp;

    const idx = actor.poolIndex;
    if (idx >= MAX_BRAINS) return actor; // beyond this ticket's scratch cap — see MAX_BRAINS's own comment; actor still spawned, just brainless (flagged, not silently swallowed)

    this._brains.active[idx] = 1;
    this._brains.state[idx] = BRAIN_STATE.dormant;
    this._brains.targetId[idx] = 0;
    this._brains.nextDecisionStep[idx] = 0;
    this._brains.attackReadyStep[idx] = 0;
    this._brains.swingActive[idx] = 0;
    this._brains.hitTickStep[idx] = -1;

    // AI-6 — the one archetype that needs its own reset beyond `_brains`'
    // six fields above: `dust_shaman`'s revive credit and two independent
    // cooldowns (`brains/shaman.js`'s own header explains why `_brains`'
    // single cooldown/hitTick pair cannot carry three concurrent actions).
    // `swarm`/`archer`/`crawler`'s own stores default to all-zero, which is
    // already the correct spawn-time state (not fleeing, not retreating/
    // approaching, `chaseEnteredStep` unset) — nothing to initialise there.
    if (archetypeId === 'dust_shaman') initShamanBrain(this._shamanStore, idx);

    return actor;
  }

  /** `brainOf(actor) => Brain | null`. Returns a REUSED scratch (Fixed: Y,
   * Alloc: no, per `02-api-contracts.md` §12's own row) — read/copy
   * immediately, never stash it, same discipline as `motion.js`'s
   * `MoveResult`. `01-data-model.md` §9.6's full `Brain` record shape was
   * NOT read (out of this ticket's assigned reading — only `06` §3.3/§3.4,
   * §13 step 2 and §14) so this intentionally exposes only the two fields
   * M2's restricted FSM has: `state` (one of the four §13-step-2 names) and
   * `targetId`. A future ticket adding perception/pack fields should extend
   * this, not treat it as the final shape. */
  brainOf(actor) {
    if (!actor || actor.poolIndex >= MAX_BRAINS || this._brains.active[actor.poolIndex] !== 1) return null;
    const idx = actor.poolIndex;
    const view = this._brainView;
    view.state = BRAIN_STATE_NAMES[this._brains.state[idx]];
    view.targetId = this._brains.targetId[idx];
    return view;
  }

  /** `setTarget(actor, targetId) => void` — see this file's header,
   * "`setTarget` bypasses perception." */
  setTarget(actor, targetId) {
    if (!actor || actor.poolIndex >= MAX_BRAINS || this._brains.active[actor.poolIndex] !== 1) return;
    const idx = actor.poolIndex;
    this._brains.targetId[idx] = targetId;
    if (this._brains.state[idx] === BRAIN_STATE.dormant) {
      this._brains.state[idx] = BRAIN_STATE.chase;
      this._brains.attackReadyStep[idx] = this._ctx.time.step;
      this._brains.nextDecisionStep[idx] = this._ctx.time.step;
    }
  }

  /** `alertPack(packId, x, z) => void` — `02-api-contracts.md` §12,
   * contracted. Forwards into `perception.js#alertPack` (rule 7/O-71: a
   * contract method must be reachable as a method on the subsystem the
   * contract names, even though the logic lives in `perception.js`). Pack
   * registration itself (`registerPack`/`addPackMember`, `perception.js`) is
   * NOT contracted — `spawnPack`/`PackDescriptor` generation is `06` §13's
   * own later step, out of this ticket; see the report. */
  alertPack(packId, x, z) {
    alertPackImpl(this._ctx, this._ctx.get('actors'), this._perception, this._brains, BRAIN_STATE, packId, x, z);
  }

  /** `aliveCount` -> `int`. Brains whose actor is not dead. */
  get aliveCount() {
    return this._countBrains((actor) => !actor.dead);
  }

  /** `activeCount` -> `int` — "brains not `dormant`." */
  get activeCount() {
    return this._countBrains((actor, idx) => this._brains.state[idx] !== BRAIN_STATE.dormant);
  }

  _countBrains(predicate) {
    const actors = this._ctx.get('actors');
    const live = actors.all;
    let n = 0;
    for (let i = 0; i < live.length; i++) {
      const actor = live[i];
      const idx = actor.poolIndex;
      if (idx >= MAX_BRAINS || this._brains.active[idx] !== 1) continue;
      if (predicate(actor, idx)) n++;
    }
    return n;
  }

  /** `stats` -> `{ brains, decisions, pathRequests, pathRefusals,
   * flowUsers }`. AI-4 — `pathRequests`/`pathRefusals` are cumulative totals
   * of `./nav.js`'s own ring-scheduler counters (every `nav.requestPath()`
   * call this system made, and how many of those came back `0` — a
   * per-step budget refusal, NOT the same quantity as `nav.stats.refusals`;
   * see `./nav.js`'s header for the distinction MB12 depends on).
   * `flowUsers` is a live gauge, recomputed every `fixedUpdate` — brains
   * currently flagged `useFlowField` (`06` §13 row 4: "rises as the count
   * does"). `brains` is a live count, `decisions` a running total of
   * `stepMeleeBrain`/`stepPerceptionBrain` (AI-3) calls that actually
   * re-evaluated a transition (off-cadence steps, which only move/check
   * hit-tick/wakeAtStep, do not count). */
  get stats() {
    return {
      brains: this._countBrains(() => true),
      decisions: this._decisionCount,
      pathRequests: this._navStore.pathRequests,
      pathRefusals: this._navStore.pathRefusals,
      flowUsers: this._navStore.flowUsers,
    };
  }

  fixedUpdate(h, ctx) {
    const actors = ctx.get('actors');
    // `peek`, not `get`: `nav` is a hard dep (`static deps`) in every real
    // boot, but `tests/ai/melee.test.js` (AI-2's file, off-limits to this
    // ticket) builds a stub `ctx` that never registers it — its own Rankers
    // start in `chase` via `setTarget` and never touch a nav-dependent
    // branch, so this degrades safely rather than throwing. See the report.
    const nav = ctx.peek('nav');
    // AI-5 — same defensive `peek` precedent as `nav` above: `physics` is
    // not one of this system's `static deps`, and `crowd.js`'s local
    // avoidance (`06` §8.3) is the only thing in this file that ever reaches
    // it. A stub `ctx` that never registers `physics` degrades safely
    // (`stepCrowdMember`'s own `updateAvoidance` holds an all-zero avoidance
    // vector rather than throwing).
    const physics = ctx.peek('physics');
    const live = actors.all;

    // AI-3 — §4.5's noise ring, drained once per step before any brain
    // decides, so a same-step hit/impact can wake a dormant/wander brain in
    // time for this step's own dispatch below.
    processNoiseRing(ctx, actors, this._brains, this._perception, BRAIN_STATE);

    for (let i = 0; i < live.length; i++) {
      const actor = live[i];
      const idx = actor.poolIndex;
      if (idx >= MAX_BRAINS || this._brains.active[idx] !== 1) continue;
      if (this._brains.state[idx] === BRAIN_STATE.dead) continue;

      if (actor.dead) {
        // S1: any -> dead. "The brain is released on the death tick" (06
        // §3.2) — this ticket keeps the slot (so `brainOf`/traces can still
        // observe the terminal state) but stops all further processing.
        this._brains.state[idx] = BRAIN_STATE.dead;
        continue;
      }

      let state = this._brains.state[idx];

      // AI-3 — S15 (leash) and the chase-side de-aggro rule fire out of
      // `chase`/`attack`, states `brains/melee.js` owns; checked here,
      // unconditionally, every step (same "any state" priority class as S1
      // above), BEFORE `stepMeleeBrain` runs — see `perception.js`'s header.
      if (state === BRAIN_STATE.chase || state === BRAIN_STATE.attack) {
        checkLeash(ctx, actor, idx, this._brains, this._perception, BRAIN_STATE);
        state = this._brains.state[idx]; // may have just become `reposition`
        if (nav && (state === BRAIN_STATE.chase || state === BRAIN_STATE.attack)) {
          stepChaseHooks(ctx, actors, nav, actor, idx, this._brains, this._perception, BRAIN_STATE);
          state = this._brains.state[idx]; // may have just become `alert`
        }
      }

      // AI-6 — `flee` (carrion_swarm's own scatter, §3.7 C2/C3). Own branch,
      // ahead of the dormant/wander/alert/reposition group below: `flee` is
      // none of those four and needs no `nav`/target lookup, only this
      // archetype's own store. Any OTHER archetype should never reach this
      // state (nothing else transitions into it) — the archetype guard is
      // defensive, not load-bearing.
      if (state === BRAIN_STATE.flee) {
        if (actor.archetypeId === 'carrion_swarm'
          && stepSwarmFlee(ctx, actors, actor, idx, this._brains, this._swarmStore, BRAIN_STATE)) {
          this._decisionCount++;
        }
        continue;
      }

      if (state === BRAIN_STATE.dormant || state === BRAIN_STATE.wander
        || state === BRAIN_STATE.alert || state === BRAIN_STATE.reposition) {
        if (nav && stepPerceptionBrain(ctx, actors, nav, actor, idx, this._brains, this._perception, BRAIN_STATE)) {
          this._decisionCount++;
        }
        continue;
      }

      const targetId = this._brains.targetId[idx];
      if (!targetId) continue; // target despawned mid-transition — defensive
      const target = actors.byId(targetId);
      if (!target) continue; // target despawned/invalid

      // AI-5 — `06` §8: a chase-state, registered pack member not yet within
      // its own archetype's contact range gets its goal/steering/movement
      // entirely from `crowd.js` this step, INSTEAD of the archetype's own
      // step function — see `./crowd.js`'s own header for exactly why
      // (short version: `brains/melee.js`'s chase movement is unconditional
      // and off-limits to edit, so this dispatch swap is the only way
      // `crowd.js`'s ring slots/lane offsets/avoidance can ever actually
      // move an actor). `crowd.js`'s own `CROWD_TABLE` already covers every
      // archetype; `stepCrowdMember` itself refuses `ranged`/`support` roles
      // (`ashen_archer`/`dust_shaman`) so those two always fall through to
      // their own kiting/priority logic below even mid-pack. `state ===
      // attack`, a non-pack-member brain, or a brain already in contact
      // range all fall straight through, exactly as before this ticket.
      if (state === BRAIN_STATE.chase && nav
        && stepCrowdMember(ctx, actors, nav, physics, actor, target, idx, this._brains, this._perception, this._crowdStore, BRAIN_STATE)) {
        continue;
      }

      // AI-6 — archetype dispatch. `bone_ranker`'s own branch is
      // byte-for-byte what it was before this ticket; the other five call
      // straight into their own file, per this ticket's file grant.
      const archetypeId = actor.archetypeId;
      let decided = false;
      if (archetypeId === 'bone_ranker') {
        decided = stepMeleeBrain(ctx, actors, actor, target, this._brains, idx, BRAIN_STATE);
      } else if (archetypeId === 'carrion_swarm') {
        decided = stepSwarmBrain(ctx, actors, physics, actor, target, this._brains, idx, BRAIN_STATE, this._swarmStore, this._hasteStore);
      } else if (archetypeId === 'ashen_archer') {
        decided = stepArcherBrain(ctx, actors, physics, actor, target, this._brains, idx, BRAIN_STATE, this._archerStore, this._hasteStore);
      } else if (archetypeId === 'dust_shaman') {
        decided = stepShamanBrain(ctx, actors, actor, target, this._brains, idx, BRAIN_STATE, this._shamanStore, this._hasteStore);
      } else if (archetypeId === 'maulsmith') {
        decided = stepMaulsmithBrain(ctx, actors, actor, target, this._brains, idx, BRAIN_STATE, this._hasteStore);
      } else if (archetypeId === 'blight_crawler') {
        decided = stepCrawlerBrain(ctx, actors, physics, actor, target, this._brains, idx, BRAIN_STATE, this._crawlerStore, this._hasteStore);
      }
      if (decided) this._decisionCount++;
    }

    // AI-4 — `06` §9: the ring scheduler, flow-field default/cadence and the
    // >40 hard demotion, after the brain-state loop so a same-step state
    // transition (e.g. leash firing this step) is reflected in this step's
    // own goal/eligibility computation. `nav` guarded the same way the loop
    // above already guards it (`tests/ai/melee.test.js`'s stub `ctx` never
    // registers `nav` — see this file's own header). `this.activeCount` is
    // the existing, unchanged getter (rule: "no behavioural change to
    // spawnOne/brainOf/aliveCount" — activeCount is none of those three).
    if (nav) {
      stepNavScheduler(ctx, actors, nav, this._brains, this._perception, this._navStore, BRAIN_STATE, this.activeCount);
    }
  }

  dispose() {
    this._ctx = null;
    this._rng = null;
  }
}
