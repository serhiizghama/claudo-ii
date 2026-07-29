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
 * ACTR-1 implemented the Lifecycle slice of the table below, plus `moveTo`
 * alone (pulled forward from ACTR-2/M1 — see `motion.js`'s header for why
 * M0 could not close without it). ACTR-2 (this ticket) adds the rest of
 * "Transform and motion" it judged in scope — `teleport`, `face`,
 * `moveSpeed`, `distance`, `inRange` — plus the dev-build write guard on
 * `actor.x`/`actor.z` (see `motion.js`'s header for the guard design and for
 * why `applyImpulse` is the one row deliberately left out). Everything past
 * "Transform and motion" (`stats()`, `setState`, `applyStatus`, ...) still
 * belongs to a later ticket and is deliberately absent, not stubbed (see
 * this ticket's report).
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
import {
  moveActor,
  createMoveResultScratch,
  teleportActor,
  faceActor,
  actorDistance,
  actorsInRange,
  computeMoveSpeed,
  installActorWriteGuard,
  beginActorWrite,
  endActorWrite,
} from './motion.js';

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
    /** `teleport`'s reused `nav.snap` `out` scratch (a `Vec3`,
     * `02-api-contracts.md`'s own shape) — same "built once, never
     * reassigned" discipline as `_moveResult`, so `teleport` stays
     * `Alloc: no` regardless of whether `nav` is present. */
    this._navSnapScratch = { x: 0, y: 0, z: 0 };
    /** Kept only for `teleport`'s `ctx.peek('nav')` lookup at call time —
     * ACTR-1 never needed to hold `ctx` past `init()`; `nav` is ticket #7/#11
     * of this milestone (this is #4) and may not be registered at all yet,
     * so the lookup has to happen per call, the same `ctx.has`/`ctx.get`
     * guarded-by-typeof pattern `src/core/engine.js` already uses for
     * `world.serviceZoneRequest()` (see `motion.js`'s "teleport" section for
     * the full reasoning). */
    this._ctx = null;
  }

  async init(ctx) {
    this._ctx = ctx;
    this._physics = ctx.peek('physics') ?? null;

    const quality = ctx && ctx.config && ctx.config.quality;
    const capacity = POOL_CAPACITY[quality] ?? DEFAULT_POOL_CAPACITY;

    this._pool = new ActorPool(capacity);
    this._bodyId = new Int32Array(capacity);
  }

  // ─── Transform and motion (02-api-contracts.md §7) ─────────────────────
  // `moveTo` was pulled forward into M0 by ACTR-1 — see `motion.js`'s own
  // header for why. This ticket (ACTR-2) adds `teleport`/`face`/`moveSpeed`/
  // `distance`/`inRange` below; `applyImpulse` is the one row deliberately
  // left out — see `motion.js`'s own "applyImpulse" section for why.

  /** `02-api-contracts.md` §7: `moveTo(actor, dx, dz) => MoveResult` — a
   * per-step delta, not a destination. See `motion.js` for the algorithm,
   * the bodyless-actor fallback, and why the returned `MoveResult` is a
   * reused scratch (never stash it — same discipline as `physics`'s own
   * `Hit`/`MoveResult`, unlike `ActorRef`). */
  moveTo(actor, dx, dz) {
    const bodyId = actor && this._bodyId ? this._bodyId[actor.poolIndex] : 0;
    return moveActor(actor, dx, dz, this._physics, bodyId, this._moveResult);
  }

  /** `02-api-contracts.md` §7: `teleport(actor, x, z) => boolean` — snaps to
   * nav, returns false if none. See `motion.js`'s "teleport" section for the
   * algorithm, `TELEPORT_SNAP_RADIUS`'s derivation, and the documented
   * degraded behaviour while `nav` (NAV-1/NAV-5, tickets #7/#11) does not
   * exist yet: `nav` is reached only at call time, via `ctx.peek('nav')`,
   * guarded by `typeof nav.snap === 'function'` — never imported. */
  teleport(actor, x, z) {
    const bodyId = actor && this._bodyId ? this._bodyId[actor.poolIndex] : 0;
    const nav = this._ctx && typeof this._ctx.peek === 'function' ? this._ctx.peek('nav') : undefined;
    return teleportActor(actor, x, z, this._physics, bodyId, nav, this._navSnapScratch);
  }

  /** `02-api-contracts.md` §7: `face(actor, targetX, targetZ, maxTurnRate)
   * => void`. See `motion.js`'s "face" section for why `maxTurnRate` is
   * radians/second despite this method reading no clock. */
  face(actor, targetX, targetZ, maxTurnRate) {
    faceActor(actor, targetX, targetZ, maxTurnRate);
  }

  /** `02-api-contracts.md` §7: `distance(a, b) => number` — surface-to-
   * surface, radii subtracted. Pure; see `motion.js`. */
  distance(a, b) {
    return actorDistance(a, b);
  }

  /** `02-api-contracts.md` §7: `inRange(a, b, range) => boolean`. Pure; see
   * `motion.js`. */
  inRange(a, b, range) {
    return actorsInRange(a, b, range);
  }

  /** `02-api-contracts.md` §7: `moveSpeed(actor) => number` — m/s after
   * stats and statuses. See `motion.js`'s "moveSpeed" section for the
   * formula and why both its real inputs are placeholders until ACTR-7/8
   * (stats) and a real class/bestiary table exist. */
  moveSpeed(actor) {
    return computeMoveSpeed(actor);
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
    // `ActorPool#acquire` writes the initial spawn placement straight into
    // `actor.x`/`actor.z` (not through `moveTo`/`teleport`) — this subsystem's
    // OWN internal lifecycle bookkeeping, not an "other subsystem" write, so
    // it runs inside the write guard's unlocked window. See motion.js's
    // "write guard" section.
    beginActorWrite();
    let actor;
    try {
      actor = this._pool.acquire(merged);
    } finally {
      endActorWrite();
    }
    if (!actor) return null;
    // Idempotent — a no-op on every spawn after this slot's very first one
    // (the guard, once installed on a pool slot's record, stays installed
    // for the life of the process; see motion.js's own header).
    installActorWriteGuard(actor);

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
    // `ActorPool#release` -> `resetActorRecord` zeroes `actor.x`/`actor.z`
    // directly — this subsystem's own pool-reset bookkeeping, same reasoning
    // as spawn()'s acquire() call above.
    beginActorWrite();
    try {
      this._pool.release(actor);
    } finally {
      endActorWrite();
    }
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
    this._navSnapScratch = null;
    this._ctx = null;
  }
}
