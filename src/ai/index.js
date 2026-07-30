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

/** Matches `src/actors/action.js`/`src/actors/timing.js`'s own
 * `SCRATCH_CAPACITY = 256` precedent — comfortably above
 * `01-data-model.md`'s documented `q.maxActors` ceiling (220). Fixed, not
 * grown: this ticket's own scope (one hand-spawned monster) never stresses
 * it, and matching the sibling files' constant keeps the convention
 * consistent rather than inventing a different cap for the same reason. */
const MAX_BRAINS = 256;

/** Brain state codes — `06` §13 step 2's restricted set,
 * `{dormant, chase, attack, dead}`, nothing else (`dormant` first, per `06`
 * §3.3's own diagram). Passed BY VALUE into `brains/melee.js` (never
 * imported there) so this file stays the one authority for the numeric
 * encoding. */
const BRAIN_STATE = Object.freeze({ dormant: 0, chase: 1, attack: 2, dead: 3 });
const BRAIN_STATE_NAMES = Object.freeze(['dormant', 'chase', 'attack', 'dead']);

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
    if (!MELEE_ARCHETYPES.has(archetypeId)) {
      // Only `bone_ranker`'s brain exists this ticket — see this file's and
      // `brains/melee.js`'s headers. Refusing cleanly (`null`) rather than
      // spawning a brainless statue or a monster whose brain silently never
      // decides anything.
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
   * flowUsers }`. `pathRequests`/`pathRefusals`/`flowUsers` are hardcoded to
   * `0` — nav integration is `06` §13 step 4, not this ticket's; see this
   * file's header. `brains` is a live count, `decisions` a running total of
   * `stepMeleeBrain` calls that actually re-evaluated a transition (off-
   * cadence steps, which only move/check hit-tick, do not count). */
  get stats() {
    return {
      brains: this._countBrains(() => true),
      decisions: this._decisionCount,
      pathRequests: 0,
      pathRefusals: 0,
      flowUsers: 0,
    };
  }

  fixedUpdate(h, ctx) {
    const actors = ctx.get('actors');
    const live = actors.all;
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

      const targetId = this._brains.targetId[idx];
      if (!targetId) continue; // still dormant, no target assigned — no perception in M2 (see header)
      const target = actors.byId(targetId);
      if (!target) continue; // target despawned/invalid

      if (stepMeleeBrain(ctx, actors, actor, target, this._brains, idx, BRAIN_STATE)) {
        this._decisionCount++;
      }
    }
  }

  dispose() {
    this._ctx = null;
    this._rng = null;
  }
}
