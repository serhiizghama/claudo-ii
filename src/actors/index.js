// src/actors/index.js
//
// ACTR-1 — the `ActorsSystem` shell: pool sizing per quality preset, the
// public lifecycle surface (`02-api-contracts.md` §7's `spawn`/`despawn`/
// `resolve`/`ref`/`byId`/`all`/`player`/`count`/`forEachInRadius`), and the
// physics wiring `src/actors/pool.js` deliberately stays free of. Every
// method here is a thin forward into `ActorPool` — the same "index.js
// forwards, the sibling file owns the real logic" split
// `src/physics/index.js` / `src/physics/body.js` already established for
// this codebase; that pair is this ticket's explicit precedent (see the
// report).
//
/**
 * ===========================================================================
 * ACTORS — the actor record, procedural skeletons and animation, stat blocks,
 *          status effects, the health and resource vessels
 * ===========================================================================
 *
 * The single owner of the Actor pool (01-data-model.md §2). Everything that
 * exists in the world as a thing with life — the player, every monster, every
 * NPC, every summon, every breakable urn — is an Actor from this pool.
 *
 * Also the only writer of actor.x/z: movement requests go through moveTo(),
 * which drives physics.moveBody() and keeps the body and the record in step.
 *
 * PUBLIC API — const actors = ctx.get('actors')
 * This ticket (ACTR-1) implements the Lifecycle slice of the table below,
 * plus `moveTo` alone (pulled forward from ACTR-2/M1 — see `motion.js`'s
 * header for why M0 cannot close without it) — see 02-api-contracts.md §7
 * for the full API this class will grow into across ACTR-2..17. Every other
 * "Transform and motion" row (`teleport`, `face`, `moveSpeed`,
 * `applyImpulse`, `distance`, `inRange`) and everything past it (`stats()`,
 * `setState`, `applyStatus`, ...) belongs to a later ticket and is
 * deliberately absent, not stubbed (see this ticket's report).
 */
// (docs/spec/02-api-contracts.md §7, verbatim above — see that document for
// the full method table this ticket implements the Lifecycle slice of.)
//
// ---------------------------------------------------------------------------
// `static deps` — why this is `['physics']`, not `['materials', 'physics']`
// ---------------------------------------------------------------------------
// 02-api-contracts.md §7 declares `static deps = ['materials', 'physics']`.
// `materials` does not exist yet (MATL-1, M5) — nobody has ever called
// `registry.add(MaterialsSystem)`, so `src/core/registry.js#resolve()`
// throws `'actors' depends on 'materials', which is not registered` the
// instant this class is registered, before a single subsystem's `init()`
// runs — that is the whole boot, dead, for every other landed ticket too
// (this ticket's brief is explicit that breaking the boot is not
// acceptable). Declaring only the dependency that is real today is the same
// call CORE-9's boot log already makes for every not-yet-built subsystem
// (skipped stages, never a hard dependency on something absent). Once
// MATL-1 registers `materials`, this line must go back to
// `['materials', 'physics']` — nothing else in this file assumes
// `materials` is absent, this one line is the whole deviation.
//
// ---------------------------------------------------------------------------
// Physics integration is best-effort, not a hard requirement
// ---------------------------------------------------------------------------
// `spawn()` reads `physics` via `ctx.peek('physics')`, not `ctx.get()`, and
// every physics call is guarded by `this._physics` being present. Two
// reasons, both load-bearing:
//   1. The pool-capacity acceptance test (spawn up to the full 60/100/160/
//      220 per preset, NOT q.maxActors) would be impossible to satisfy if a
//      body were mandatory: `physics`'s own body store is sized to
//      `q.maxActors` (24/32/44/56 — strictly SMALLER than the actor pool,
//      by design, docs/PROGRESS.md's D-1), so it runs dry well before the
//      actor record pool does. `physics.addBody()` returning `0` (its own
//      documented "pool exhausted" contract) must not fail `actors.spawn()`
//      — it only means this particular actor has no collidable body, which
//      is exactly the D-1-reserved headroom (quest actors, corpses) doing
//      its job.
//   2. It lets `src/actors/pool.js` (and a unit test of just the pool
//      surface) stay usable with a bare stub `ctx` that never registers
//      `physics` at all — `tests/helpers/actor.js#makeStubCtx`'s default
//      `systems: {}`.
// `despawn()` mirrors this: it only calls `physics.removeBody()` when both
// `physics` is present AND this actor was actually given a body.
//
// ---------------------------------------------------------------------------
// Events — deliberately NOT emitted here
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`'s cross-subsystem event table lists `actor:spawn` /
// `actor:despawn` but attributes their emission to `ai` (spawn) and `ai`
// again (despawn) — not to `actors`. `02-api-contracts.md` §7's own event
// row for `actors` repeats the same two events under `actors`' emitter
// column, which is the one place the two documents disagree (see this
// ticket's report). Resolved by *not* emitting here: `ARCHITECTURE.md`'s
// table is the older, canonical cross-subsystem contract (it is the
// document `02`'s own header says every event table folds into), monster
// spawning is `ai`'s decision (packs, champions, `SpawnPoint` selection —
// none of which this ticket owns or has a hook into), and the player spawns
// exactly once per zone entry, a `player`/`world` concern. Emitting
// `actor:spawn` from inside the pool's own `spawn()` would also fire it for
// every non-gameplay caller of this method (a future balance harness
// spawning actors directly, for instance) without that caller asking for an
// event. If a later ticket decides `actors` should be the emitter after
// all, that is a one-line addition here plus a correction to
// `ARCHITECTURE.md`'s table in the same commit, per that document's own
// rule ("If you need an event that is not listed, add a row here").

import { ActorPool } from './pool.js';
import { moveActor, createMoveResultScratch } from './motion.js';

/** `01-data-model.md` §11.1's `Actor` row, low/medium/high/ultra — the
 * RECORD pool capacity, not `q.maxActors` (the smaller *simulation* cap;
 * see `docs/PROGRESS.md`'s D-1, and `src/core/config.js`'s own header
 * comment on `QUALITY_PRESETS.maxActors`, which cites this exact split).
 * `01` §11.1 annotates its 60/100/160/220 row `(q.maxActors)` — the project
 * owner ruled that annotation a spec typo; these four numbers are `actors`'
 * own, separate constant. Kept as a plain frozen table, not folded into
 * logic, per `ARCHITECTURE.md` rule 9 ("gameplay numbers live in data, not
 * in code") — this ticket's file list does not include a `data/`
 * directory (see the report), so the table lives here instead of at
 * `src/actors/data/pools.js`.
 */
export const POOL_CAPACITY = Object.freeze({ low: 60, medium: 100, high: 160, ultra: 220 });

/** Fallback pool capacity for a config-less `ctx` (a minimal test stub —
 * `tests/helpers/actor.js#makeStubCtx`'s default `config: {}` carries no
 * `quality`). The largest defined preset, not an arbitrary round number —
 * mirrors `src/physics/body.js`'s `DEFAULT_MAX_BODIES` choice and its own
 * stated reasoning exactly. */
const DEFAULT_POOL_CAPACITY = POOL_CAPACITY.ultra;

/** `02-api-contracts.md` §7, verbatim shape and default values — the
 * literal `SpawnSpec` sample IS the default for every field a caller
 * omits. Merged the same way `src/physics/index.js`'s `FOOTPRINT_DEFAULTS`
 * is merged into a partial `Footprint`. */
export const SPAWN_SPEC_DEFAULTS = Object.freeze({
  kind: 'monster',
  archetypeId: 'bone_ranker',
  rank: 'normal',
  level: 10,
  team: 1,
  x: 0,
  z: 0,
  facing: 0,
  packId: 0,
  ownerId: 0,
  affixes: [],
  nameOverride: null,
});

/** `team -> physics.LAYER` key, so `spawn()` can compute the right
 * collision layer without hardcoding `physics.LAYER`'s numeric values (it
 * reads them off the live `physics` instance instead — `physics` is the
 * sole owner of what those numbers are). `01-data-model.md` §1.2:
 * `TEAM.player = 0`, `TEAM.monster = 1`, everything else (`TEAM.neutral = 2`
 * and any other value) maps to `LAYER.NEUTRAL`.
 * @param {number} team
 * @param {{PLAYER:number, MONSTER:number, NEUTRAL:number}} LAYER
 */
function layerForTeam(team, LAYER) {
  if (team === 0) return LAYER.PLAYER;
  if (team === 1) return LAYER.MONSTER;
  return LAYER.NEUTRAL;
}

export class ActorsSystem {
  static id = 'actors';
  static deps = ['physics']; // see the file header — 'materials' omitted, MATL-1 not built yet

  constructor() {
    this._pool = null;
    this._physics = null;
    /** poolIndex -> physics bodyId, `0` = no body (physics absent, or its
     * own body store was exhausted — see the file header). Sized to the
     * actor pool's capacity, not `q.maxActors`; allocated once in `init()`. */
    this._bodyId = null;
    /** `moveTo`'s reused `MoveResult` scratch — see `motion.js`'s header
     * ("The returned MoveResult — a shared scratch"). Built once here,
     * never reassigned. */
    this._moveResult = createMoveResultScratch();
  }

  async init(ctx) {
    this._physics = ctx.peek('physics') ?? null;

    const quality = ctx && ctx.config && ctx.config.quality;
    const capacity = POOL_CAPACITY[quality] ?? DEFAULT_POOL_CAPACITY;

    this._pool = new ActorPool(capacity);
    this._bodyId = new Int32Array(capacity);
  }

  // ─── Transform and motion (02-api-contracts.md §7) — ACTR-2 slice ──────
  // `moveTo` only, pulled forward from M1's ACTR-2 at the project owner's
  // direction because PLYR-1 (M0) has no other legal way to move an actor
  // (`ARCHITECTURE.md` / `02` §4: never write actor.x/z directly). Every
  // other row of this section (`teleport`, `face`, `moveSpeed`,
  // `applyImpulse`, `distance`, `inRange`) is still ACTR-2's, not
  // implemented here — see `motion.js`'s own header for the full boundary.

  /** `02-api-contracts.md` §7: `moveTo(actor, dx, dz) => MoveResult` — a
   * per-step delta, not a destination. See `motion.js` for the algorithm,
   * the bodyless-actor fallback, and why the returned `MoveResult` is a
   * reused scratch (never stash it — same discipline as `physics`'s own
   * `Hit`/`MoveResult`, unlike `ActorRef`). */
  moveTo(actor, dx, dz) {
    const bodyId = actor && this._bodyId ? this._bodyId[actor.poolIndex] : 0;
    return moveActor(actor, dx, dz, this._physics, bodyId, this._moveResult);
  }

  // ─── Lifecycle (02-api-contracts.md §7) ────────────────────────────────

  /**
   * `spawn(spec) => Actor | null` — `null` when the pool is dry. Merges
   * `spec` over `SPAWN_SPEC_DEFAULTS`, acquires a record from the pool (see
   * `ActorPool#acquire` for the field-population rules), then — only if
   * `physics` is present — samples ground height for `y` and best-effort
   * registers a physics body (see the file header for why a failed
   * `addBody` does not fail this call).
   * @param {object} spec a `SpawnSpec`, any subset of fields.
   * @returns {object | null}
   */
  spawn(spec) {
    const merged = { ...SPAWN_SPEC_DEFAULTS, ...spec };
    const actor = this._pool.acquire(merged);
    if (!actor) return null;

    if (this._physics) {
      const groundY = this._physics.groundHeight(actor.x, actor.z);
      const y = Number.isFinite(groundY) ? groundY + actor.hoverY : 0;
      actor.y = y;
      actor.prevY = y;
      actor.renderY = y;

      const layer = layerForTeam(actor.team, this._physics.LAYER);
      this._bodyId[actor.poolIndex] = this._physics.addBody(
        actor.id,
        actor.x,
        actor.z,
        actor.radius,
        actor.height,
        actor.mass,
        layer,
      );
    } else {
      this._bodyId[actor.poolIndex] = 0;
    }

    return actor;
  }

  /**
   * `despawn(actor, immediate?) => void`. Releases the physics body (if
   * any) and returns the pool slot immediately regardless of `immediate` —
   * this ticket does not implement a deferred corpse-fade window (that
   * needs the action state machine, ACTR-9/10, and the `Corpse` pool's own
   * fade timing; see the report). A double-despawn or an actor this system
   * doesn't own is a safe no-op (`ActorPool#release`'s own contract).
   * @param {object} actor
   * @param {boolean} [immediate] accepted per the documented signature; see
   *   above for why it does not change behaviour today.
   */
  despawn(actor, immediate) {
    if (!actor || !actor.active) return;
    const poolIndex = actor.poolIndex;
    const bodyId = this._bodyId ? this._bodyId[poolIndex] : 0;
    if (this._physics && bodyId !== 0) this._physics.removeBody(bodyId);
    if (this._bodyId) this._bodyId[poolIndex] = 0;
    this._pool.release(actor);
  }

  /** `resolve(ref) => Actor | null`. Throws in dev if handed the pooled
   * scratch `ref()` returns when called without `out` — see
   * `src/actors/pool.js`'s header ("ref()'s no-`out` scratch"). */
  resolve(ref) {
    return this._pool.resolve(ref);
  }

  /** `ref(actor, out?) => ActorRef`. Pass your own `out` for anything you
   * intend to store or hand to `resolve()` later — see `pool.js`. */
  ref(actor, out) {
    return this._pool.ref(actor, out);
  }

  /** `byId(id) => Actor | null`. */
  byId(id) {
    return this._pool.byId(id);
  }

  /** `all` -> `Actor[]`, the live dense list, read-only. */
  get all() {
    return this._pool.all;
  }

  /** `player` -> `Actor | null`. */
  get player() {
    return this._pool.player;
  }

  /** `count` -> `int`. */
  get count() {
    return this._pool.count;
  }

  /** `forEachInRadius(x,z,radius,team,fn) => void`. `team === -1` matches
   * any team. */
  forEachInRadius(x, z, radius, team, fn) {
    this._pool.forEachInRadius(x, z, radius, team, fn);
  }

  dispose() {
    if (this._pool) this._pool.dispose();
    this._pool = null;
    this._physics = null;
    this._bodyId = null;
    this._moveResult = null;
  }
}
