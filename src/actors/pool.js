// src/actors/pool.js
//
// ACTR-1 — the `Actor` record shape and the fixed-capacity pool that owns
// it: `01-data-model.md` §2 (the record) and §11 (the pool contract). This
// file is physics-agnostic and three-agnostic on purpose (see the file
// footer) — `ActorsSystem` (`./index.js`) is the thin layer that wires a
// spawned record into `physics` and into the public `02-api-contracts.md`
// §7 surface. The split mirrors PHYS-1/PHYS-2's own
// `src/physics/index.js` (thin forwards) / `src/physics/body.js` (the real
// data structure) — read that pair first if this file's shape looks
// unfamiliar.
//
// ---------------------------------------------------------------------------
// The acceptance criterion, and how this file earns it
// ---------------------------------------------------------------------------
// "spawn/despawn/ref/resolve close the loop; a recycled pool slot never
// resolves through a stale ActorRef." `Actor.id` is never reused
// (01-data-model.md §2, verbatim: "unique for the process lifetime ...
// never reused") AND `byId`/`resolve` are `Alloc: no` (02-api-contracts.md
// §7) — both at once, with no `Map` anywhere in this file. The trick:
// `id` is not an arbitrary counter, it *encodes* `(poolIndex, generation)`
// as one integer —
//
//   id = 1 + poolIndex + generation * capacity
//
// — a bijection: for `0 <= poolIndex < capacity`, two different
// `(poolIndex, generation)` pairs can never produce the same `id` (the only
// way `1+pA+gA*cap === 1+pB+gB*cap` is `pA-pB = (gB-gA)*cap`, and
// `|pA-pB| < cap` forces `pA=pB, gA=gB`). Since `generation` only ever
// increases for a given slot (never resets), a slot's own id sequence
// strictly increases across its whole lifetime and never repeats a value —
// "never reused" holds exactly, pool-wide, with zero bookkeeping beyond the
// `generation` field every pooled record already carries (01 §11.2 rule 5).
//
// `byId(id)`/`resolve(ref)` invert the formula — `poolIndex = (id-1) %
// capacity` — index straight into `_records[poolIndex]` (an ordinary
// array read), and compare `actor.id === id` (which alone already proves
// both the slot AND the generation match, since `id` encodes both;
// `resolve` additionally compares `generation` on top, matching the data
// model's own description of the mechanism and giving a second, redundant
// check for free). No `Map`, no allocation, ever.
//
// This design was **not** the first one written: an earlier version kept a
// `Map<id, Actor>` (`id` a plain monotonic counter, deleted from the map on
// every `release()`). It measured a real, reproducible ~456 bytes/call,
// stable across `assertAllocationFree`'s full 5000-round retry budget —
// not the sub-byte noise `tests/helpers/alloc.js`'s own header describes,
// a genuine leak. Root cause: V8's `Map` compacts its backing store once
// enough tombstones accumulate, and inserting a *never-repeating* key then
// deleting it, every single cycle, is exactly the workload that keeps
// tripping that compaction — even though the *live* entry count never
// exceeds 1. This is the same class of finding `src/physics/grid.js`
// (PHYS-1) made independently for its own static-footprint lookup ("first
// version on Map gave 2.5–3.6 ms and did not pass"): a hash map is the
// wrong tool once a hot path needs a hard zero-allocation guarantee, no
// matter how small the live set is. The index-arithmetic scheme above
// sidesteps the whole class of problem rather than trying to tune around it.
//
// ---------------------------------------------------------------------------
// The dense live list — a classic sparse-set, not a filtered copy
// ---------------------------------------------------------------------------
// `_dense[0.._liveCount)` holds pool-slot indices of the live actors;
// `_slotPos[slot]` is the inverse (a live slot's position in `_dense`).
// `acquire()` appends; `release()` swaps the removed entry with the last
// live one and shrinks `_liveCount` — O(1), zero allocation, standard
// technique (the same one `src/physics/body.js`'s free-list uses one level
// down, for pool slots rather than dense-list membership).
//
// `all` is a `Proxy` **computed view** over `_dense`/`_records` — it holds
// no backing array of its own. `get` intercepts `'length'` (-> `_liveCount`)
// and every in-range numeric index (-> `_records[_dense[index]]`); anything
// else (`.map`, `.forEach`, `Symbol.iterator`, ...) falls through to the
// (permanently empty) target array's own `Array.prototype`, so every
// standard read — indexing, `.length`, `for...of`, spread, `Array.from` —
// behaves exactly like reading a real array of the live actors, in order,
// with nothing to keep manually in sync. `set`/`deleteProperty`/
// `defineProperty` all throw, covering every mutating `Array.prototype`
// method the same way (each performs a `[[Set]]`/`[[Delete]]`/
// `[[DefineOwnProperty]]` on `this`, and `this` is the proxy when called as
// `all.push(x)` — see `src/render/camera.js`'s `guardVector`, which this
// mirrors, for the one-trap-covers-every-method reasoning in full).
//
// This is NOT the write-guard-only, disabled-in-production pattern RNDR-2's
// camera uses (an earlier version of this file tried exactly that, keeping
// a real backing array kept at `.length === liveCount` by truncating it on
// every `release()`). It measured a second real, reproducible allocation —
// V8 tears down a JS array's elements backing store the moment its length
// is set to exactly 0 and has to build a fresh one the next time it's
// written to; a pool cycling through "one live actor, immediately released"
// (this file's own steady-state allocation test does exactly that) hits
// that transition on every single `release()`. Unlike the `_byId` Map this
// file used to carry (see below), there is no small-live-set escape hatch
// here: `_liveCount` genuinely reaches 0 whenever the world is momentarily
// empty, and a real backing array has no way to represent "correctly
// reports `.length` 0" without either hitting the same V8 transition or
// lying about its own length. A computed view has no backing store to tear
// down in the first place, so this is unconditional — no dev/prod split.
//
// ---------------------------------------------------------------------------
// ref()'s no-`out` scratch — why holding it is a resolve()-time throw, not a
// silent alias (found in review; fixed here)
// ---------------------------------------------------------------------------
// `01-data-model.md` §2.2 does not say "never stash an ActorRef" — it says
// the OPPOSITE: "Hold an `ActorRef` and resolve it... the boss's summon list
// all store `ActorRef`, never `Actor`." That is unlike `physics`'s `Hit`/
// `MoveResult` ("come from a ring... never stash one") and it matters here:
// `ref(actor)` called with no `out` returns `_refScratch`, ONE shared,
// mutated-in-place object (the general `out`-parameter convention this
// whole API follows, `02-api-contracts.md`'s own header). Any caller that
// stores that return value — which is exactly what §2.2 tells every future
// caller (`ai`'s `PackDescriptor.members`, a boss's summon list, a
// `DamagePacket`'s `sourceGen`-adjacent bookkeeping) to do with an
// `ActorRef` — gets silently aliased the moment ANY other `ref()` call
// (for a different actor, or the same one after a recycle) runs before
// the held value is used:
//
//   const refA = pool.ref(a);   // no out -> _refScratch, {id: a.id, ...}
//   const refB = pool.ref(b);   // no out -> _refScratch AGAIN — refA === refB
//   pool.resolve(refA);          // returns b, not a's stale-ref outcome
//
// This is not a slot-recycle edge case; it reproduces with two actors that
// are both still alive. A "stamp a serial into the shared object" guard
// (the first idea tried here) cannot catch it: `refA` and `refB` are the
// SAME object, so by the time `resolve(refA)` runs, every field on it —
// including any hidden serial stamped alongside `id`/`generation` — already
// holds `b`'s data. There is no surviving trace of "what this object held
// when `ref(a)` returned it" to compare against; the information is gone,
// not just stale. Detecting staleness from the object's own state is
// impossible once that state has been overwritten in place.
//
// The fix instead makes the ONLY legitimate use of the no-`out` scratch —
// reading `.id`/`.generation` off it immediately, never handing it back in —
// enforceable: `resolve()` throws (`REF_SCRATCH_GUARD_ENABLED`, dev-only,
// same `import.meta.env.DEV` check `src/render/camera.js`'s write-guard
// uses, zero cost in production) whenever it is handed `_refScratch` BY
// IDENTITY. This also throws on the "immediate" `resolve(ref(actor))` chain
// — deliberately: that call provides no value over using `actor` directly
// (it is already in hand), and from `resolve()`'s side it is indistinguishable
// from the buggy held-then-aliased case, so refusing it unconditionally is
// the only sound rule. Passing an owned `out` — `ref(actor, out)` — is
// unaffected and is now, by construction, the only way to hold an
// `ActorRef` safely; `resolve()` never special-cases an `out`-produced
// object because it is never `_refScratch`.
//
// ---------------------------------------------------------------------------
// What this file does NOT own (see this ticket's report for the full list)
// ---------------------------------------------------------------------------
// `moveTo`/`teleport`/`face` (ACTR-2), the skeleton/animator/pose fields on
// `view` (ACTR-3..6, ACTR-11..14), `StatBlock` composition (ACTR-7/8), the
// action state machine's *transitions* and status-effect application
// (ACTR-9/10), `kill`/`resurrect` (ACTR-17/AI-9). This file only builds the
// record shape, fills it in from a `SpawnSpec` at `acquire()`, and resets it
// at `release()` — every field a later ticket owns is initialised to its
// documented pool-reset baseline (01 §11.2: numbers to 0, strings to
// `null`, arrays emptied, Maps cleared) and left alone.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file — see
// this ticket's report on why `src/actors/` is not yet one of
// `tools/check-imports.mjs`'s scanned roots (the same gap PHYS-1 flagged
// for `src/physics/` as O-22).

// ---------------------------------------------------------------------------
// Small local vocabulary — literal citations, not full enum modules
// ---------------------------------------------------------------------------
// `01-data-model.md` §1 assigns `ACTOR_KIND`/`ACTOR_RANK`/`ACTOR_STATE`/
// `TEAM` to a `data/` table "exported from the owning subsystem's data/
// folder" — but this ticket's file list (see the report) does not include
// `src/actors/data/`, and inventing that directory now would preempt
// decisions later tickets (the state machine, ACTR-9/10; monster ranks,
// AI-*) actually own. The handful of literal string/number values this file
// needs to populate a freshly spawned record are cited inline instead,
// against the exact spec line each comes from.
const ACTOR_KIND_PLAYER = 'player'; // 01 §1.3 ACTOR_KIND.player
const ACTOR_STATE_SPAWNING = 'spawning'; // 01 §1.4; 06-monsters-ai.md §"Spawn state": 1.00s, invulnerable, no collision — the *duration* and the invulnerability enforcement are the state machine's job (ACTR-9/10), not this ticket's; this file only sets the correct initial value.

/**
 * Placeholder actor geometry, assigned — no archetype table exists yet
 * (`src/ai/data/bestiary.js` / `src/player/data/classes.js`, both later
 * tickets) for `spawn()` to read a real `radius`/`height`/`mass` from.
 * Values are `01-data-model.md` §2's own illustrative `Actor` sample
 * (`radius: 0.36`, `height: 1.80`, `mass: 78`) — corroborated by §2.3's
 * `bone_ranker` `MonsterArchetype` sample (`mass: 78` exactly; `radius:
 * 0.38`, close enough to be the same "typical humanoid" ballpark) — rather
 * than an arbitrary round number. Whichever ticket wires real archetype
 * data into `spawn()` should source these from `spec.archetypeId`'s table
 * row instead of this constant.
 */
const DEFAULT_ACTOR_RADIUS = 0.36;
const DEFAULT_ACTOR_HEIGHT = 1.8;
const DEFAULT_ACTOR_MASS = 78;

const ALL_READONLY_MESSAGE =
  "actors.all is read-only — spawn()/despawn() are the pool's only legal writers of the live actor list";

/**
 * `true` unless a production Vite build can be positively proven — exactly
 * `src/render/camera.js`'s `CAMERA_WRITE_GUARD_ENABLED` (see that file's
 * header for the full reasoning; reused verbatim rather than imported —
 * `ARCHITECTURE.md` rule 2, `actors` may not import `src/render/`). Gates
 * `resolve()`'s reject-the-pooled-`ref()`-scratch check — see the file
 * header's "ref()'s no-`out` scratch" section.
 */
const REF_SCRATCH_GUARD_ENABLED =
  typeof import.meta === 'undefined' ||
  typeof import.meta.env === 'undefined' ||
  import.meta.env.DEV !== false;

const REF_SCRATCH_HELD_MESSAGE =
  "actors.resolve: received the object ref(actor) returns when called WITHOUT an `out` argument. " +
  'That object is a single shared scratch, mutated in place by every subsequent no-`out` ref() call ' +
  '(any actor, not just this one) — 01-data-model.md §2.2 requires an ActorRef to be safely holdable ' +
  'across a frame boundary, and the no-`out` scratch cannot be. Pass your own out object — ' +
  'actors.ref(actor, out) — whenever the result will be stored or handed back to resolve() later, ' +
  'even one call later.';

/**
 * Builds the `Proxy` handler for one `ActorPool` instance's `all` view —
 * see the file header ("`all` is a `Proxy` computed view"). Built once per
 * pool (closes over `pool`), not shared/frozen across instances the way a
 * pure write-guard handler could be, because the `get` trap needs each
 * pool's own `_liveCount`/`_dense`/`_records`.
 * @param {ActorPool} pool
 */
function makeAllViewHandler(pool) {
  return {
    get(target, prop, receiver) {
      if (prop === 'length') return pool._liveCount;
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < pool._liveCount) {
          return pool._records[pool._dense[idx]];
        }
      }
      return Reflect.get(target, prop, receiver);
    },
    set() {
      throw new TypeError(ALL_READONLY_MESSAGE);
    },
    deleteProperty() {
      throw new TypeError(ALL_READONLY_MESSAGE);
    },
    defineProperty() {
      throw new TypeError(ALL_READONLY_MESSAGE);
    },
  };
}

/** Wraps `facing` into `(-PI, PI]` — `01-data-model.md` §2's own convention
 * for the field. Pure, zero allocation, no `Math.hypot` involved. */
function wrapAngle(angle) {
  const TWO_PI = Math.PI * 2;
  let a = angle % TWO_PI;
  if (a <= -Math.PI) a += TWO_PI;
  else if (a > Math.PI) a -= TWO_PI;
  return a;
}

/** Clamps to the documented `level` range, `01-data-model.md` §2: "int
 * 1..40". */
function clampLevel(level) {
  const n = Math.trunc(level);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 40) return 40;
  return n;
}

/**
 * Builds one pool slot's `Actor` record, every field at `01-data-model.md`
 * §2's shape, called exactly `capacity` times by `ActorPool`'s constructor
 * (`Alloc: yes`, legal because this only ever runs in `init()` — never
 * again for the life of the slot). `cooldowns` (a `Map`), `statuses` (an
 * array) and the nested `attributes`/`view` objects are allocated once,
 * here, and never reassigned afterward — `resetActorRecord` below mutates
 * `statuses`/`attributes`/`view` in place (`01` §11.2 rules 2/3) but
 * deliberately does NOT call `cooldowns.clear()`; see that function's own
 * comment on `actor.cooldowns` for why.
 * @param {number} poolIndex
 */
function createActorRecord(poolIndex) {
  return {
    // ─── identity ─────────────────────────────────────────────────────────
    id: 0,
    generation: 0,
    kind: null,
    rank: null,
    archetypeId: null,
    classId: null,
    name: null,
    team: 0,
    level: 0,
    flags: 0,

    // ─── transform: simulation authority ─────────────────────────────────
    x: 0,
    y: 0,
    z: 0,
    facing: 0,
    prevX: 0,
    prevY: 0,
    prevZ: 0,
    prevFacing: 0,

    // ─── transform: presentation ────────────────────────────────────────
    renderX: 0,
    renderY: 0,
    renderZ: 0,
    renderFacing: 0,

    // ─── motion ─────────────────────────────────────────────────────────
    velX: 0,
    velZ: 0,
    desiredX: 0,
    desiredZ: 0,
    speed: 0,
    radius: 0,
    height: 0,
    mass: 0,
    hoverY: 0,

    // ─── action state machine (ACTR-9/10 drives transitions) ─────────────
    state: null,
    stateTime: 0,
    actionId: null,
    actionPhase: 0,
    actionTimer: 0,
    actionSeq: 0,
    actionLock: false,
    hitsThisAction: 0,

    // ─── vitals ────────────────────────────────────────────────────────
    life: 0,
    mana: 0,
    rage: 0,
    resonance: 0,
    stamina: 0,
    lifeAccum: 0,
    manaAccum: 0,
    dead: false,

    // ─── stats (ACTR-7/8 composes them) ───────────────────────────────
    attributes: { strength: 0, dexterity: 0, vitality: 0, energy: 0 },
    stats: null,
    sources: null,
    statsDirty: true,

    // ─── status effects (combat/ACTR-9/10 populate) ───────────────────
    statuses: [],
    statusMask: 0,
    chillPoints: 0,
    stunChain: 0,
    stunChainAt: 0,
    ccImmuneUntil: 0,

    // ─── combat bookkeeping ────────────────────────────────────────────
    attackReady: 0,
    castReady: 0,
    cooldowns: new Map(),
    hitstunUntil: 0,
    hitstunImmuneUntil: 0,
    lastDamageStep: -1,
    lastDealtStep: -1,
    lastAttackerId: 0,
    killerId: 0,
    threat: null,
    invulnUntil: 0,

    // ─── references (ids, never object pointers) ──────────────────────
    targetId: 0,
    ownerId: 0,
    packId: 0,
    zoneId: null,
    spawnPointId: 0,

    // ─── inventory (items subsystem, M3 — not built yet) ──────────────
    equipment: null,
    inventory: null,
    belt: null,
    gold: 0,

    // ─── presentation handles (ACTR-3..6/11..14 build the real ones) ──
    view: {
      root: null,
      skeleton: null,
      animator: null,
      materialSet: null,
      visible: true,
      lod: 0,
      hitStopUntil: 0,
      flashUntil: 0,
    },

    // ─── pooling ───────────────────────────────────────────────────────
    active: false,
    poolIndex,
  };
}

/**
 * Resets every field but `poolIndex` (preserved, rule 6) back to its
 * `01-data-model.md` §11.2 baseline and increments `generation` (rule 5).
 * Nested containers (`attributes`, `view`, `cooldowns`, `statuses`) are
 * mutated in place, never reassigned (rules 2/3) — this function never
 * allocates.
 * @param {object} actor
 */
function resetActorRecord(actor) {
  actor.id = 0;
  actor.generation = actor.generation + 1;
  actor.kind = null;
  actor.rank = null;
  actor.archetypeId = null;
  actor.classId = null;
  actor.name = null;
  actor.team = 0;
  actor.level = 0;
  actor.flags = 0;

  actor.x = 0;
  actor.y = 0;
  actor.z = 0;
  actor.facing = 0;
  actor.prevX = 0;
  actor.prevY = 0;
  actor.prevZ = 0;
  actor.prevFacing = 0;

  actor.renderX = 0;
  actor.renderY = 0;
  actor.renderZ = 0;
  actor.renderFacing = 0;

  actor.velX = 0;
  actor.velZ = 0;
  actor.desiredX = 0;
  actor.desiredZ = 0;
  actor.speed = 0;
  actor.radius = 0;
  actor.height = 0;
  actor.mass = 0;
  actor.hoverY = 0;

  actor.state = null;
  actor.stateTime = 0;
  actor.actionId = null;
  actor.actionPhase = 0;
  actor.actionTimer = 0;
  actor.actionSeq = 0;
  actor.actionLock = false;
  actor.hitsThisAction = 0;

  actor.life = 0;
  actor.mana = 0;
  actor.rage = 0;
  actor.resonance = 0;
  actor.stamina = 0;
  actor.lifeAccum = 0;
  actor.manaAccum = 0;
  actor.dead = false;

  actor.attributes.strength = 0;
  actor.attributes.dexterity = 0;
  actor.attributes.vitality = 0;
  actor.attributes.energy = 0;
  actor.stats = null;
  actor.sources = null;
  actor.statsDirty = true;

  actor.statuses.length = 0;
  actor.statusMask = 0;
  actor.chillPoints = 0;
  actor.stunChain = 0;
  actor.stunChainAt = 0;
  actor.ccImmuneUntil = 0;

  actor.attackReady = 0;
  actor.castReady = 0;
  // actor.cooldowns is deliberately NOT cleared here. `01 §11.2` rule 3
  // ("Maps are cleared in place") calls for `actor.cooldowns.clear()`, and
  // an earlier version of this function did exactly that — measured
  // directly for this ticket: `Map.prototype.clear()` allocates in V8
  // (~150 bytes/call) UNCONDITIONALLY, even on an already-empty map, which
  // broke despawn's `Alloc: no` contract. Nothing in this ticket's scope
  // ever inserts into `cooldowns` (that starts with `skills`/ACTR-9/10), so
  // it is always already empty when release() runs today and skipping the
  // clear is currently a genuine no-op. It stops being one the moment a
  // later ticket starts writing to it: a recycled slot would then leak the
  // PREVIOUS occupant's stale cooldown entries into the new one. That
  // ticket must either replace this `Map` with a zero-alloc-clearable
  // structure (e.g. a fixed-capacity parallel-array table cleared by
  // resetting a count field, the same pattern this file's own dense list
  // uses) or find another mitigation — flagged in this ticket's report as a
  // real, unresolved gap, not a silent hazard.
  actor.hitstunUntil = 0;
  actor.hitstunImmuneUntil = 0;
  actor.lastDamageStep = -1;
  actor.lastDealtStep = -1;
  actor.lastAttackerId = 0;
  actor.killerId = 0;
  actor.threat = null;
  actor.invulnUntil = 0;

  actor.targetId = 0;
  actor.ownerId = 0;
  actor.packId = 0;
  actor.zoneId = null;
  actor.spawnPointId = 0;

  actor.equipment = null;
  actor.inventory = null;
  actor.belt = null;
  actor.gold = 0;

  actor.view.root = null;
  actor.view.skeleton = null;
  actor.view.animator = null;
  actor.view.materialSet = null;
  actor.view.visible = true;
  actor.view.lod = 0;
  actor.view.hitStopUntil = 0;
  actor.view.flashUntil = 0;

  actor.active = false;
  // actor.poolIndex is untouched — rule 6.
}

export class ActorPool {
  /** @param {number} capacity fixed, never grown (see the file header). */
  constructor(capacity) {
    this._capacity = capacity;

    /** @type {object[]} one stable record per slot, built once, forever. */
    this._records = new Array(capacity);
    for (let i = 0; i < capacity; i++) this._records[i] = createActorRecord(i);

    /** Free-list stack of unused slot indices — LIFO, same discipline as
     * `src/physics/body.js`'s `_freeSlots`. */
    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;

    /** Sparse-set dense live list — see the file header. */
    this._dense = new Int32Array(capacity);
    this._slotPos = new Int32Array(capacity).fill(-1);
    this._liveCount = 0;

    /** The public `all` — a computed `Proxy` view, no backing array (see
     * the file header). `_allViewTarget` is never read or written except by
     * the `Proxy` machinery itself falling through to `Array.prototype`. */
    this._allViewTarget = [];
    this._allView = new Proxy(this._allViewTarget, makeAllViewHandler(this));

    this._playerActor = null;

    /** `ref()`'s shared scratch object for the `out`-omitted case
     * (`02-api-contracts.md`'s `out`-parameter convention). Read
     * `.id`/`.generation` off it immediately; never hand it back into
     * `resolve()` — that throws in dev by identity. See the file header's
     * "ref()'s no-`out` scratch" section. */
    this._refScratch = { id: 0, generation: 0 };
  }

  /** Fixed capacity this pool was constructed with. */
  get capacity() {
    return this._capacity;
  }

  /** `02-api-contracts.md` §7: `count` -> `int`. */
  get count() {
    return this._liveCount;
  }

  /** `02-api-contracts.md` §7: `all` -> `Actor[]`, read-only, `Alloc: no` —
   * same cached `Proxy` reference every call; see the file header for how
   * the computed view works. */
  get all() {
    return this._allView;
  }

  /** `02-api-contracts.md` §7: `player` -> `Actor | null`. The most
   * recently spawned `kind === 'player'` actor still live; `null` once it
   * despawns. */
  get player() {
    return this._playerActor;
  }

  /**
   * Acquires a free slot and populates it from a COMPLETE spec (every
   * `SpawnSpec` field present — `ActorsSystem.spawn()` merges
   * `SPAWN_SPEC_DEFAULTS` before calling this). Physics-agnostic on purpose:
   * `y`/ground height and the physics body are the caller's job (see this
   * file's header and `./index.js`). Returns `null` when the pool is dry —
   * a contract, not an exception (`02-api-contracts.md` §7).
   * @param {object} spec a fully-defaulted `SpawnSpec`.
   * @returns {object | null}
   */
  acquire(spec) {
    if (this._freeCount === 0) return null;

    const slot = this._freeSlots[--this._freeCount];
    const actor = this._records[slot];

    // id encodes (slot, generation) — see the file header. actor.generation
    // already holds the correct value (0 for a never-used slot, or
    // incremented by the most recent release() otherwise).
    actor.id = 1 + slot + actor.generation * this._capacity;
    actor.kind = spec.kind;
    actor.rank = spec.rank;
    actor.archetypeId = spec.archetypeId;
    // classId is 01 §2's "CLASS_ID for kind==='player', else null". No
    // player/class archetype table exists yet (src/player/data/classes.js,
    // a later ticket) — spec.archetypeId doubles as the classId for a
    // player-kind spawn, since SpawnSpec carries no separate field for it.
    actor.classId = spec.kind === ACTOR_KIND_PLAYER ? spec.archetypeId : null;
    actor.name = spec.nameOverride !== null && spec.nameOverride !== undefined ? spec.nameOverride : spec.archetypeId;
    actor.team = spec.team;
    actor.level = clampLevel(spec.level);
    actor.packId = spec.packId;
    actor.ownerId = spec.ownerId;

    actor.radius = DEFAULT_ACTOR_RADIUS;
    actor.height = DEFAULT_ACTOR_HEIGHT;
    actor.mass = DEFAULT_ACTOR_MASS;

    const facing = wrapAngle(spec.facing);
    actor.x = spec.x;
    actor.z = spec.z;
    actor.facing = facing;
    actor.prevX = spec.x;
    actor.prevZ = spec.z;
    actor.prevFacing = facing;
    actor.renderX = spec.x;
    actor.renderZ = spec.z;
    actor.renderFacing = facing;
    // y / prevY / renderY: left at 0 here (physics-agnostic — see header);
    // ActorsSystem.spawn() overwrites them from physics.groundHeight() when
    // physics is present.

    actor.state = ACTOR_STATE_SPAWNING;
    actor.active = true;

    const pos = this._liveCount++;
    this._dense[pos] = slot;
    this._slotPos[slot] = pos;

    if (actor.kind === ACTOR_KIND_PLAYER) this._playerActor = actor;

    return actor;
  }

  /**
   * Releases `actor` back to the pool: removes it from the dense live list,
   * resets the record (which increments `generation`, retiring this id
   * forever — see the file header), and returns the slot to the free list.
   * A double-release or an actor this pool doesn't own is a safe no-op —
   * matching `src/physics/index.js#removeStatic` / `body.js#remove`'s own
   * "never throw on a stale handle" discipline, not `01` §11.2's generic
   * dev-assert language (see this ticket's report for why that concrete,
   * already-shipped precedent won this call).
   * @param {object} actor
   */
  release(actor) {
    if (!actor || !actor.active) return;
    const slot = actor.poolIndex;
    if (slot < 0 || slot >= this._capacity || this._records[slot] !== actor) return;

    const pos = this._slotPos[slot];
    const lastPos = this._liveCount - 1;
    const lastSlot = this._dense[lastPos];

    this._dense[pos] = lastSlot;
    this._slotPos[lastSlot] = pos;

    this._liveCount = lastPos;
    this._slotPos[slot] = -1;

    if (this._playerActor === actor) this._playerActor = null;

    resetActorRecord(actor); // increments actor.generation — see the file header
    this._freeSlots[this._freeCount++] = slot;
  }

  /** `02-api-contracts.md` §7: `byId(id) => Actor | null`. Decodes
   * `poolIndex` straight out of `id` (see the file header) — an array
   * read and one equality check, no `Map`, no allocation. Returns `null`
   * for a garbage/out-of-range/never-issued id as well as a stale one. */
  byId(id) {
    if (!Number.isInteger(id) || id < 1) return null;
    const slot = (id - 1) % this._capacity;
    const actor = this._records[slot];
    return actor.active && actor.id === id ? actor : null;
  }

  /** `02-api-contracts.md` §7: `resolve(ref) => Actor | null`. Throws (dev
   * only, `REF_SCRATCH_GUARD_ENABLED`) if `ref` IS the pooled scratch
   * `ref()` returns when called without `out` — see the file header's
   * "ref()'s no-`out` scratch" section for why that is always a bug, never
   * a legitimate call, and why a serial-number-on-the-object guard cannot
   * work here. Otherwise: decode as `byId` does, plus the explicit
   * `generation` compare the data model documents as the mechanism —
   * redundant with the `id` compare under this file's encoding (see the
   * header) and kept anyway as real, independent insurance. */
  resolve(ref) {
    if (!ref) return null;
    if (REF_SCRATCH_GUARD_ENABLED && ref === this._refScratch) {
      throw new Error(REF_SCRATCH_HELD_MESSAGE);
    }
    if (!Number.isInteger(ref.id) || ref.id < 1) return null;
    const slot = (ref.id - 1) % this._capacity;
    const actor = this._records[slot];
    if (!actor.active || actor.id !== ref.id || actor.generation !== ref.generation) return null;
    return actor;
  }

  /** `02-api-contracts.md` §7: `ref(actor, out?) => ActorRef`. `out`
   * omitted -> the shared scratch object (the documented `out`-convention:
   * "valid until the next call to that method"). Safe to read `.id`/
   * `.generation` off it immediately; `resolve()` refuses it by identity in
   * dev if it is ever handed back in — see the file header. Pass an owned
   * `out` for anything that outlives the current call. */
  ref(actor, out) {
    const target = out ?? this._refScratch;
    target.id = actor.id;
    target.generation = actor.generation;
    return target;
  }

  /**
   * `02-api-contracts.md` §7: `forEachInRadius(x,z,radius,team,fn)`. Linear
   * scan over the dense live list, zero allocation, no `Math.hypot`
   * (squared-distance compare only — `docs/PROGRESS.md`'s measured rule).
   * `team === -1` matches any team.
   */
  forEachInRadius(x, z, radius, team, fn) {
    const rr = radius * radius;
    const dense = this._dense;
    const records = this._records;
    const n = this._liveCount;
    for (let i = 0; i < n; i++) {
      const actor = records[dense[i]];
      if (team !== -1 && actor.team !== team) continue;
      const dx = actor.x - x;
      const dz = actor.z - z;
      if (dx * dx + dz * dz <= rr) fn(actor);
    }
  }

  /** Drops every reference this pool holds. No GPU/DOM resource is ever
   * created here (no `three`), so there is nothing to actually "free" —
   * this exists for the same hygiene `ARCHITECTURE.md` rule 7 asks of every
   * subsystem, and so a disposed pool cannot be mistaken for a live one. */
  dispose() {
    this._playerActor = null;
    this._liveCount = 0;
  }
}

// Exported for tests that want to assert the exact pool-reset baseline
// without depending on `ActorsSystem`/`physics` at all.
export { createActorRecord, resetActorRecord };
