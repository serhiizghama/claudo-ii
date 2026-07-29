// src/world/index.js
//
// WRLD-1 — the four `ZoneDescriptor`s load (`./data/zones.js`) and a
// minimal `enterZone` that proves the contractual emission order
// (`zone:teardown` -> `zone:enter` -> geometry built -> `physics.rebuild()`
// -> `nav.rebuild()` (guarded) -> `zone:ready`) ends with
// `world.staticFootprints` genuinely frozen. This is step 1 of 07 §12's
// twelve; the backlog's Files column is exactly `src/world/index.js` and
// `src/world/data/zones.js`, so everything the broader step 1 deliverable
// names but this ticket's two files cannot hold — `src/world/footprint.js`
// (convex distance functions), `src/world/height.js` (the terrace field) —
// is deliberately absent, not stubbed. See this ticket's report for what
// that leaves out downstream.
//
// ---------------------------------------------------------------------------
// O-35 — the `Footprint` shape emitted here is `02-api-contracts.md` §4's,
// never `07-world-gen.md` §1.7's superseded one
// ---------------------------------------------------------------------------
// `kind` is `'box' | 'cylinder' | 'poly'`, never `'circle'`/`'convex'`
// (`physics.addStatic` silently falls back to a box on an unknown `kind`
// key — no error, so the two shapes cannot be told apart by testing alone,
// only by matching the contract exactly). Vertical extent is `y`+`height`,
// never `baseY`/`topY`. Rotation is `facing`, never `rotation`. Flags are
// `blocksNav`/`blocksSight`, never `navBlock`. `surface` is NOT a field on
// the record — `physics.addStatic(footprint, surface, opts)` takes it as
// its own second argument. `id`/`destructible` are carried on the same
// record as `world`'s own bookkeeping (unknown to `physics`, which reads
// only its own named fields — O-35's explicitly sanctioned allowance).
//
// ---------------------------------------------------------------------------
// What "geometry build" means in THIS ticket
// ---------------------------------------------------------------------------
// No generator exists yet (Last Bastion's hand-authored placement list,
// Ridgewalk, the BSP hall builder and the fixed arena are 07 §12 steps
// 3/5-6/9/10, none of them this ticket's files). `enterZone` still has to
// produce *some* real footprints to prove the record shape and the freeze
// mechanic end to end, so `buildBoundaryFootprints` below emits four box
// colliders running the zone's own perimeter, sized only from
// `descriptor.sizeX`/`sizeZ` (no RNG, no per-zone content). This is an
// explicit, documented placeholder — real per-zone static geometry
// (props, terraces, halls, the arena's pillars) replaces it entirely once
// the generator tickets land. Nothing downstream should read meaning into
// these four walls beyond "world produced a non-empty, correctly-shaped
// static set."
//
// ---------------------------------------------------------------------------
// `staticFootprints` — frozen, not just "no longer handed a mutable ref"
// ---------------------------------------------------------------------------
// The acceptance criterion reads literally: a caller that pushes,
// index-assigns, or mutates a field on an already-emitted footprint must
// not succeed. `Object.freeze` is applied to every individual footprint
// record (and to a 'poly' record's `points` array, on the day one exists)
// AND to the outer array — freezing only the array would still let
// `staticFootprints[0].blocksNav = false` through silently. Every file in
// this codebase is an ES module, which is always strict mode, so a frozen
// array's `push`/index-assignment throws `TypeError` rather than failing
// silently (the non-strict "just don't do anything" behaviour the
// criterion explicitly rules out). A fresh array and fresh records are
// built on every `enterZone` call — "invalidated by the next enterZone"
// falls out of never reusing or mutating the previous zone's array, not
// from any special-case code.
//
// ---------------------------------------------------------------------------
// Why `static deps = ['physics']`, not `['materials', 'physics']`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §5 declares `static deps = ['materials','physics']`.
// `materials` does not exist yet (MATL-1, M5) — registering it as a hard
// dependency throws at boot before any subsystem's `init()` runs, for
// every ticket landed so far, not just this one. `src/actors/index.js`
// (ACTR-1) hit the identical problem and resolved it the same way: declare
// only the dependency that is real today. Once MATL-1 registers
// `materials`, this line goes back to `['materials', 'physics']` — nothing
// else here assumes `materials` is absent.
//
// ---------------------------------------------------------------------------
// Physics and nav are reached defensively, never assumed
// ---------------------------------------------------------------------------
// `physics` is looked up once, via `ctx.peek('physics')`, in `init()` —
// mirroring `src/actors/index.js`'s own reasoning: it keeps this file
// usable against a bare stub `ctx` in a unit test that never registers
// `physics` at all, while the real boot order (`render -> materials -> sky
// -> physics -> world -> ...`, `02-api-contracts.md` § Init order) always
// has it ready by the time `world.init()` runs. `nav` (NAV-1, landed this
// milestone) is never imported (hard rule 2) — it is looked up fresh on
// every `enterZone` call via `ctx.peek('nav')`, guarded by
// `typeof nav.rebuild === 'function'`, the exact pattern
// `src/core/engine.js` already uses for `world.serviceZoneRequest()` and
// `src/actors/motion.js` uses for `nav.snap`. Per O-1,
// `serviceZoneRequest`/`requestZone` are NOT implemented here — that latch
// belongs to WRLD-4 — so `enterZone` is always called directly by whoever
// is driving it (a test, or a future ticket's caller), never serviced from
// a pending request.
//
// ---------------------------------------------------------------------------
// O-38 (WRLD-3 fix) — `nav.rebuild()` is called WITH the freshly-built
// instance, only AFTER `_current`/`_staticFootprints` already point at it
// ---------------------------------------------------------------------------
// Found by the orchestrator while accepting NAV-1 (`nav` did not exist yet
// when WRLD-1 shipped this method, so nothing could observe the bug on that
// ticket's own acceptance pass). The previous version of this method called
// `nav.rebuild()` with ZERO arguments, and did so BEFORE `this._current` /
// `this._staticFootprints` were reassigned to the zone just built — both
// were still the PREVIOUS zone's values (or `null` / the initial empty
// frozen array, on a process's very first `enterZone`). `nav.rebuild(zone)`
// (`02-api-contracts.md` §6) takes the zone as its own argument AND reads
// blocker geometry off `ctx.get('world').staticFootprints` — with the old
// ordering, both inputs `nav` could reach were one call stale, so a zone
// change rasterised the wrong zone's geometry, one behind.
//
// Two things are fixed together here, because fixing only one leaves the
// other input stale:
//   1. `this._current`/`this._staticFootprints` (below) are assigned
//      BEFORE `nav.rebuild` runs, so `world.staticFootprints` already holds
//      THIS zone's frozen footprints and `world.current` already IS
//      `instance` by the time `nav` reads either.
//   2. `nav.rebuild` is called AS `nav.rebuild(instance)`, matching
//      `02-api-contracts.md` §6's real signature, instead of relying on
//      `nav`'s own `zone || world.current` fallback (which a zero-argument
//      call forced it into).
// `nav.rebuild(instance)` also mirrors its own process-global version
// counter onto `instance.navVersion` as a side effect (`src/nav/index.js`'s
// N11) — `instance.navVersion` is read again, AFTER that call, for
// `zone:ready`'s payload, rather than trusting the placeholder value the
// object literal below was constructed with. Freezing `staticFootprints`
// earlier than before does not violate WRLD-1's own criterion — it
// requires "frozen at `zone:ready`", not "not one line before it". See
// `tests/world/wrld3.test.js` for the behavioural proof: the rebuilt grid's
// dimensions and blocked cells track the zone JUST ENTERED, across a real
// zone change, not the previous one.
//
// ---------------------------------------------------------------------------
// `physics.rebuild()` is called explicitly, here, once — on top of
// `physics`'s OWN `zone:ready` listener, which ALSO rebuilds
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §5's emission order requires `physics.rebuild()`
// to run BEFORE `nav.rebuild()` and before `zone:ready` is emitted — `nav`
// needs an already-rehashed grid to build its own grid against, so this
// cannot be deferred to a `zone:ready` listener (nav's rebuild would then
// run before physics's, backwards from the contract). This method
// therefore calls `physics.rebuild()` directly, right after the
// `addStatic` loop, exactly where §5 places it.
//
// This DOES mean `physics.rebuild()` runs twice per `enterZone`: once here,
// and once more when `src/physics/index.js`'s own `zone:ready` listener
// fires (its own contract, `02-api-contracts.md` §4: "Listens: zone:ready
// (rebuilds the static grid)"). The orchestrator flagged this as a defect
// in an earlier pass of this exact ticket, then traced it with a stack
// trace and retracted the finding: the second call originates entirely
// inside `src/physics/index.js` (its `_onZoneReady` handler), a file this
// ticket does not own and may not edit. Two sections of the same contract
// — §5's "world calls physics.rebuild() before zone:ready" and §4's
// "physics listens for zone:ready and rebuilds" — are each correct in
// isolation and add up to a real double rehash once composed. That
// contradiction is recorded as an open question against the contract
// itself (not against this file) and is not this ticket's to resolve.
//
// ---------------------------------------------------------------------------
// Determinism — no `ctx.rng.fork()` in THIS ticket, on purpose
// ---------------------------------------------------------------------------
// ARCHITECTURE.md rule 4 says every subsystem takes one `ctx.rng.fork()` in
// `init()`; 07 §1.8 describes `world` doing exactly that and then never
// using the forked stream for layout (real zone layout draws from a
// separate stream built from `hash(worldSeed, zoneId, runIndex)` —
// `seedFor`, below — which is what keeps a dressing-table tweak from
// reshuffling the whole map). This ticket draws NO randomness at all: the
// placeholder perimeter-wall geometry (`buildBoundaryFootprints`) is a pure
// function of `descriptor.sizeX`/`sizeZ`, and `_worldSeed` defaults to a
// fixed, documented placeholder (`0`) rather than a drawn value — see
// `_worldSeed`'s own comment. `src/physics/index.js` (PHYS-1/2) establishes
// the precedent this follows exactly: "no ctx.rng.fork() ... PHYS-1/2 draw
// no randomness". Forking here anyway — even unused — was tried and
// reverted: `tests/core/boot.test.js`'s "prewarm: ... leaves ctx.rng
// untouched" hard-asserts the ENTIRE currently-registered subsystem set
// draws nothing from the root stream during boot, and `Rng.fork()` itself
// consumes four `u32()` draws to seed the child, so taking it in `init()`
// desyncs that test — a file this ticket may not touch. Whichever later
// ticket adds `world`'s first real use of randomness (a generator, 07 §12
// steps 5/6/9/10) takes the fork then, and updates that boot test in the
// same commit.
//
// `seedFor`'s hash function is a small self-authored FNV-1a-style mix
// (worldSeed, then every character of zoneId, then runIndex) — not
// validated against an external reference, the same documented caveat
// `src/core/rng.js`'s own `splitMix32Step` carries for its constants. It
// only has to be deterministic (same inputs -> same output, always), which
// it is; it is not a cryptographic hash and never claimed to be one.
//
// Node-safe: no `three`, no `document`/`window`/`performance.now()`
// anywhere in this file.

import { ZONE_DESCRIPTORS, ZONE_DESCRIPTORS_BY_ID, BOUNDARY_WALL_THICKNESS, BOUNDARY_WALL_HEIGHT } from './data/zones.js';

/**
 * FNV-1a 32-bit mix, folded over `worldSeed`, every char of `zoneId`, then
 * `runIndex`. Deterministic and allocation-free; not a cryptographic hash
 * (see the file header).
 * @param {number} worldSeed
 * @param {string} zoneId
 * @param {number} runIndex
 * @returns {number} uint32
 */
function hashSeed(worldSeed, zoneId, runIndex) {
  const FNV_PRIME = 0x01000193;
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis

  h = (h ^ (worldSeed >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;

  for (let i = 0; i < zoneId.length; i++) {
    h = (h ^ zoneId.charCodeAt(i)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }

  h = (h ^ (runIndex >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;

  return h >>> 0;
}

/**
 * WRLD-1's own placeholder static geometry: four box `Footprint`s running
 * the zone's perimeter, sized only from `descriptor.sizeX`/`sizeZ`. See
 * this file's header ("What 'geometry build' means in THIS ticket") for
 * why this exists instead of real generated content. Pure function of
 * `descriptor` alone — no RNG, so it is exactly as deterministic as the
 * descriptor table itself.
 * @param {object} descriptor a `ZoneDescriptor`.
 * @returns {object[]} plain `Footprint` records, `02-api-contracts.md` §4 shape.
 */
function buildBoundaryFootprints(descriptor) {
  const halfX = descriptor.sizeX / 2;
  const halfZ = descriptor.sizeZ / 2;
  const t = BOUNDARY_WALL_THICKNESS / 2;
  const h = BOUNDARY_WALL_HEIGHT;
  // First listed surface is the zone's own primary ground/collider surface
  // (07 §1.6) — a reasonable stand-in until real per-zone geometry (later
  // tickets) tags each wall by its actual material.
  const surface = descriptor.surfaces[0];

  return [
    {
      id: 0,
      kind: 'box',
      x: 0,
      z: halfZ + t,
      y: 0,
      height: h,
      halfW: halfX + t,
      halfL: t,
      facing: 0,
      blocksNav: true,
      blocksSight: true,
      surface,
      destructible: false,
    },
    {
      id: 1,
      kind: 'box',
      x: 0,
      z: -halfZ - t,
      y: 0,
      height: h,
      halfW: halfX + t,
      halfL: t,
      facing: 0,
      blocksNav: true,
      blocksSight: true,
      surface,
      destructible: false,
    },
    {
      id: 2,
      kind: 'box',
      x: halfX + t,
      z: 0,
      y: 0,
      height: h,
      halfW: t,
      halfL: halfZ + t,
      facing: 0,
      blocksNav: true,
      blocksSight: true,
      surface,
      destructible: false,
    },
    {
      id: 3,
      kind: 'box',
      x: -halfX - t,
      z: 0,
      y: 0,
      height: h,
      halfW: t,
      halfL: halfZ + t,
      facing: 0,
      blocksNav: true,
      blocksSight: true,
      surface,
      destructible: false,
    },
  ];
}

/**
 * Deep-freezes a fresh footprint list in place and returns it: every
 * individual record (and a 'poly' record's `points` array, none of which
 * this ticket's placeholder geometry ever produces, but the freeze covers
 * it anyway for the day one does), then the outer array itself. See the
 * file header, "`staticFootprints` — frozen, not just...".
 * @param {object[]} footprints
 * @returns {readonly object[]}
 */
function freezeFootprints(footprints) {
  for (let i = 0; i < footprints.length; i++) {
    const fp = footprints[i];
    if (Array.isArray(fp.points)) Object.freeze(fp.points);
    Object.freeze(fp);
  }
  return Object.freeze(footprints);
}

export class WorldSystem {
  static id = 'world';
  static deps = ['physics']; // see the file header — 'materials' omitted, MATL-1 not built yet

  constructor() {
    this._ctx = null;
    this._physics = null;
    /** Default `worldSeed` until a save calls `setWorldSeed()` (02 §5).
     * ASSIGNED — a fixed literal, not drawn from `ctx.rng` (see the file
     * header, "Determinism — no ctx.rng.fork() in THIS ticket"). `0` is an
     * arbitrary, deterministic placeholder; there is no gameplay
     * consequence to it yet since no generator (which would be the first
     * real consumer of `seedFor`'s output) exists in this ticket's scope. */
    this._worldSeed = 0;

    /** `ZoneInstance | null` — the currently loaded zone. */
    this._current = null;

    /** `readonly Footprint[]` — frozen at `zone:ready`, replaced (never
     * mutated) by the next `enterZone`. Starts as a frozen empty array so
     * the property is always the documented shape, even before the first
     * zone has loaded. */
    this._staticFootprints = Object.freeze([]);

    /** `physics` static handles for the CURRENT zone's own footprints only
     * (plain array, not a `Map` — ARCHITECTURE.md's `Map`-leak warning).
     * `physics` owns the static grid's storage and never clears it itself
     * on a zone change (`removeStatic` is per-handle); `world` is the
     * geometry's only producer, so tearing down its own previous zone's
     * statics before adding the next zone's is this subsystem's job, not
     * `physics`'s — otherwise geometry from every zone ever entered would
     * simply stack in the static grid. */
    this._physicsHandles = [];

    /** `world`'s own placeholder for `ZoneInstance.navVersion` until
     * `nav` (NAV-1, ticket #7 of this milestone) exists and takes over
     * incrementing it on its own `rebuild()`. Bumped once per successful
     * `enterZone`, purely so `zone:ready`'s payload always carries a
     * monotonically increasing integer, matching 01-data-model.md §9.2's
     * shape (`navVersion: int, +1 on every rebuild`). */
    this._navVersionCounter = 0;
  }

  /** @param {object} ctx */
  async init(ctx) {
    this._ctx = ctx;
    this._physics = (typeof ctx.peek === 'function' && ctx.peek('physics')) || null;
    // No `ctx.rng.fork()` here — see the file header, "Determinism — no
    // ctx.rng.fork() in THIS ticket, on purpose".
  }

  /** `02-api-contracts.md` §5: `setWorldSeed(seed) => void` — from the
   * save, before the first `enterZone`.
   * @param {number} seed */
  setWorldSeed(seed) {
    this._worldSeed = seed >>> 0;
  }

  /** `02-api-contracts.md` §5: `descriptor(zoneId) => ZoneDescriptor`.
   * @param {string} zoneId
   * @returns {object}
   * @throws if `zoneId` names none of the four shipping zones. */
  descriptor(zoneId) {
    const d = ZONE_DESCRIPTORS_BY_ID[zoneId];
    if (!d) throw new Error(`world.descriptor: unknown zoneId '${zoneId}'`);
    return d;
  }

  /** `02-api-contracts.md` §5: `descriptors` -> `ZoneDescriptor[]` — all
   * four, frozen (module-level constant; see `./data/zones.js`). */
  get descriptors() {
    return ZONE_DESCRIPTORS;
  }

  /** `02-api-contracts.md` §5: `current` -> `ZoneInstance | null`. */
  get current() {
    return this._current;
  }

  /** `02-api-contracts.md` §5: `seedFor(zoneId, runIndex) =>
   * hash(worldSeed, zoneId, runIndex)`.
   * @param {string} zoneId
   * @param {number} runIndex
   * @returns {number} uint32 */
  seedFor(zoneId, runIndex) {
    return hashSeed(this._worldSeed, zoneId, runIndex);
  }

  /** `02-api-contracts.md` §5: `staticFootprints` -> `readonly Footprint[]`
   * — frozen at `zone:ready`, invalidated by the next `enterZone`. Returns
   * the same frozen array every call between two zone loads (Alloc: no). */
  get staticFootprints() {
    return this._staticFootprints;
  }

  /**
   * `02-api-contracts.md` §5: `enterZone(zoneId, entryTag, opts?) =>
   * Promise<ZoneInstance>`. `Fixed: N` — never call this from
   * `fixedUpdate` (it allocates and rebuilds the static grid).
   *
   * Runs the contractual emission order in full: `zone:teardown` (if a
   * zone was already loaded — by the time `events.emit` returns, every
   * `ai`/`items`/`skills`/`fx` listener has already depopulated,
   * `EventBus.emit` being synchronous) -> this subsystem's own previous
   * static footprints are removed from `physics` -> `zone:enter` ->
   * placeholder geometry built (see file header) and registered with
   * `physics.addStatic` -> `physics.rebuild()` -> `this._current` /
   * `this._staticFootprints` reassigned to the just-built instance (O-38 —
   * see file header) -> `nav.rebuild(instance)` if `nav` is present
   * (guarded, `typeof`-checked, never imported) -> `zone:ready`.
   * `staticFootprints` is therefore already the new zone's frozen array by
   * the time `nav.rebuild` runs, not merely by the time `zone:ready` fires.
   *
   * @param {string} zoneId
   * @param {string} entryTag
   * @param {{runIndex?: number, difficulty?: string}} [opts]
   * @returns {Promise<object>} the new `ZoneInstance`.
   */
  async enterZone(zoneId, entryTag, opts = {}) {
    const descriptor = this.descriptor(zoneId); // throws on an unknown zoneId, before any event fires

    const runIndex = Number.isInteger(opts.runIndex) ? opts.runIndex : 0;
    const difficulty = opts.difficulty || 'instruction';
    const events = this._ctx.events;

    const previous = this._current;
    if (previous) {
      events.emit('zone:teardown', { zoneId: previous.zoneId });
    }
    this._clearPreviousStatics();

    const seed = this.seedFor(zoneId, runIndex);
    events.emit('zone:enter', { zoneId, seed, entry: entryTag });

    const footprints = buildBoundaryFootprints(descriptor);

    if (this._physics) {
      for (let i = 0; i < footprints.length; i++) {
        const handle = this._physics.addStatic(footprints[i], footprints[i].surface);
        this._physicsHandles.push(handle);
      }
      this._physics.rebuild();
    }

    // World's own placeholder `navVersion` counter (see the constructor's
    // field comment) — bumped here, before `instance` is built, so the
    // object literal below always has SOME value even when `nav` is absent
    // from `ctx` (a bare unit-test ctx, same reasoning as `_physics`
    // above). When `nav` IS present, `nav.rebuild(instance)` below
    // overwrites `instance.navVersion` with its own real, process-global
    // counter (`src/nav/index.js`'s N11) — this placeholder is only ever
    // the value actually used when nav is absent.
    this._navVersionCounter++;

    const halfX = descriptor.sizeX / 2;
    const halfZ = descriptor.sizeZ / 2;
    const bounds = { minX: -halfX, minZ: -halfZ, maxX: halfX, maxZ: halfZ };

    const instance = {
      descriptor,
      zoneId,
      seed,
      runIndex,
      difficulty,
      monsterLevel: descriptor.monsterLevel,
      navVersion: this._navVersionCounter,

      boundsMinX: bounds.minX,
      boundsMinZ: bounds.minZ,
      boundsMaxX: bounds.maxX,
      boundsMaxZ: bounds.maxZ,

      nav: null,
      spawnPoints: [],
      packs: [],
      portals: [],
      entries: new Map(),
      chests: [],

      cleared: false,
      bossDefeated: false,
      monstersAlive: 0,
      monstersKilled: 0,
      groundItems: [],
      createdAtStep: (this._ctx.time && this._ctx.time.step) || 0,
    };

    // O-38 fix: both assignments below MUST happen before `nav.rebuild` is
    // called — see the file header. `world.staticFootprints`/`world.current`
    // are what `nav` reads; if either still pointed at the previous zone (or
    // nothing, on a first entry) when `nav.rebuild` ran, `nav` would
    // rasterise the wrong geometry, one call behind.
    this._current = instance;
    this._staticFootprints = freezeFootprints(footprints);

    const nav = typeof this._ctx.peek === 'function' ? this._ctx.peek('nav') : undefined;
    if (nav && typeof nav.rebuild === 'function') nav.rebuild(instance);

    events.emit('zone:ready', { zoneId, bounds, navVersion: instance.navVersion });

    return instance;
  }

  /** Removes every `physics` static handle this subsystem itself added for
   * the previously loaded zone — see the `_physicsHandles` field comment
   * for why this is `world`'s job, not `physics`'s.
   * @private */
  _clearPreviousStatics() {
    if (this._physics) {
      for (let i = 0; i < this._physicsHandles.length; i++) {
        this._physics.removeStatic(this._physicsHandles[i]);
      }
    }
    this._physicsHandles = [];
  }

  dispose() {
    this._clearPreviousStatics();
    this._current = null;
    this._staticFootprints = Object.freeze([]);
    this._physics = null;
    this._ctx = null;
  }
}
