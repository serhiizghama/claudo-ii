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
// WRLD-4 round 2 — the coordinator widened the grant to include `bounds`,
// `surfaceAt`, `entry`, `isTown`, `groundHeight` and the new
// `./height.js` (the terrace field `07` §1.3 describes; see that file's own
// header for the algorithm). `src/world/footprint.js` remains out of scope
// — nothing here needed convex distance functions.
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
// O-61 (WRLD-4) — `static deps` is `['materials','physics']`, matching `02`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §5 declares `static deps = ['materials','physics']`.
// From WRLD-1 until MATL-1 landed, `materials` did not exist yet and this
// line declared only `['physics']` — registering a dependency that isn't
// real yet throws at boot before any subsystem's `init()` runs
// (`src/actors/index.js`/ACTR-1 hit the identical problem and resolved it
// the same way at the time). MATL-1 has now registered `materials` in
// `src/main.js` (right after `RenderSystem`, ahead of `world` in boot
// order), so that workaround no longer applies: this line is restored to
// the real contract below. Nothing else in this file ever assumed
// `materials` was absent — `init()` never reaches into it (WRLD-4 does not
// touch geometry/material resolution; that is later tickets', per the
// "What 'geometry build' means in THIS ticket" section above).
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
// WRLD-4 (D-66) — the `requestZone` latch and the between-frame service
// point live in `./zone.js`, not here; these three are thin forwards wired
// onto `WorldSystem` below (`requestZone`/`serviceZoneRequest` methods and
// the `_zoneRequest` field), the same "index.js: wiring only" shape
// `src/nav/index.js`'s NAV-2/4/5 addenda already use. See `./zone.js`'s own
// header for why this is not a second `enterZone`.
import { createZoneRequestState, requestZoneLatch, serviceZoneRequestOnce } from './zone.js';
// WRLD-4 round 2 — the terrace field (`07` §1.3) `groundHeight`/`entry`
// read from. See `./height.js`'s own header for the algorithm and for why
// `enterZone` passes it `seed`, not a real `S1 shape` fork.
import { buildHeightField, sampleHeightField } from './height.js';
// WRLD-6 — O-99's `RASTER.CELL_SIZE`, matching `src/nav/index.js`'s own
// grid-geometry formula exactly (see `_buildNavGroundY`'s own comment).
import { RASTER } from './raster.js';
// WRLD-6 — T6 (Layout): the Ashen Wastes generator. `generateRidgewalkLayout`
// (WRLD-5, R1-R7) plus this ticket's own R8/R9 (`./gen/wastes.js`) and R10
// (`placeRidgewalkEntries`, WRLD-5) — see this file's own `enterZone` for how
// they compose and why only `zoneId === 'ashen_wastes'` takes this path
// (no other zone's generator exists yet — WRLD-7/8/9/10 land behind this
// ticket, rule 11).
import { generateRidgewalkLayout, placeRidgewalkEntries } from './gen/ridgewalk.js';
import { runR8Dressing, runR9Boundary, toFootprints, buildInstancingPlan } from './gen/wastes.js';
// WRLD-6 — T7 (Geometry), `three`-legal. See `./build/wastes.js`'s own
// header for the D-72 lint-root finding this import is inseparable from
// (this ticket's report has the full disclosure; `tools/check-imports.mjs`
// is not in this ticket's file grant).
import { buildWastesGeometry, buildAshBerm } from './build/wastes.js';
// WRLD-7 — the Bonereach BSP hall generator (`07` §4, B1-B10). Aliased
// `toFootprints`/`toFootprints` collide by name with Wastes's own export of
// the same name — `bonereachToFootprints` disambiguates the call site
// below. See `./gen/bonereach.js`'s own header for why this file's
// `toFootprints` is footprint-ONLY (no `GroundRegion`s): `nav.rebuild()`
// (src/nav/index.js, not this ticket's file grant) hardcodes
// `groundRegions: null` on every call, so a room generator's blocking
// geometry must reach nav entirely through `Footprint`s.
import {
  generateBonereachLayout,
  placeBonereachLoot,
  runBonereachDressing,
  placeBonereachEntries,
  buildWallSegments as buildBonereachWallSegments,
  toFootprints as bonereachToFootprints,
} from './gen/bonereach.js';
import { buildBonereachGeometry, disposeBonereachGeometry } from './build/bonereach.js';
// WRLD-8 — the Altar of Instruction's fixed arena (`07` §5). Headless, no
// `three` (D-78 grants `src/world/build/` a `three` exception; `gen/` gets
// none), and the backlog's Files column names exactly one file for this
// ticket, so there is no `./build/altar.js` to import — the arena has nav
// and physics geometry but no visible mesh yet. `toFootprints` collides by
// name with both Wastes's and Bonereach's, hence the alias.
import {
  generateAltarLayout,
  runAltarDressing,
  toFootprints as altarToFootprints,
} from './gen/altar.js';
// WRLD-9 — R11 (`07` §8): spawn points and pack descriptors. Pure, headless
// (no `ctx`) — see `./spawn.js`'s own header. Wired in below at T10, strictly
// AFTER `nav.rebuild(instance)` (the live grid it reads must already carry
// THIS zone's real walkable/region data), and only for the two zones with a
// real generator (`isWastes`/`isBonereach` — rule 11, no other exists yet).
import { planWastesSpawns, planBonereachSpawns } from './spawn.js';

/** WRLD-4 round 2 (`07` §1.3) — the honest current terrace set: ONE
 * terrace, boundless (`bounds` omitted, so it covers the whole zone),
 * elevation `0.00` m — exactly what §1.3 says the town has, extended to
 * every zone since no generator (WRLD-5..8) authors real terrace regions
 * yet ("Scope honesty", this ticket's own report). ASSIGNED. Replaced
 * wholesale (never mutated) the day a generator hands `enterZone` a real
 * terrace list for a given zone. */
const DEFAULT_TERRACES = Object.freeze([Object.freeze({ elevation: 0 })]);

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
  static deps = ['materials', 'physics']; // O-61 (WRLD-4) — see the file header

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

    /** WRLD-4 (D-66) — the `requestZone` latch's own state, including its
     * reused `enterZone` `opts` scratch object. Built once here, never
     * per-call (rule 5 / `requestZone`'s `Alloc: no`) — see `./zone.js`'s
     * header for the full contract. */
    this._zoneRequest = createZoneRequestState();

    /** WRLD-4 round 2 — this zone's precomputed terrace/noise table (see
     * `./height.js`). `null` until the first `enterZone`; `groundHeight`
     * documents (and this file's methods enforce) that querying before any
     * zone is loaded is a caller error. Rebuilt wholesale, once, on every
     * `enterZone` — never mutated in place. */
    this._heightField = null;

    /** `02-api-contracts.md` §5's `bounds(out?)` — the shared scratch
     * object returned when a caller omits `out`, so the no-`out` call is
     * exactly as `Alloc: no` as the with-`out` one (the same convention
     * `src/nav/index.js`'s `snap`/`this._snapScratch` already uses). The
     * caller must treat it as invalidated by the next no-`out` `bounds()`
     * call, same as any reused scratch. */
    this._boundsScratch = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

    /** `02-api-contracts.md` §5 / `07` §13 A4's `entry(entryTag, out?)` —
     * the shared scratch object for the no-`out` call, same convention as
     * `_boundsScratch` above. */
    this._entryScratch = { x: 0, y: 0, z: 0, facing: 0 };

    /** WRLD-6 — the current zone's Ashen Wastes dressing/boundary plan
     * (`null` for every other zone kind — no other generator exists yet).
     * Kept for the T7 geometry build immediately below it in `enterZone`
     * and for tests/report tooling to inspect the just-generated zone
     * without re-running the generator. Replaced wholesale, never mutated,
     * on every `enterZone` (same discipline as `_staticFootprints`). */
    this._wastesDressing = null;
    this._wastesBoundary = null;
    this._wastesLayout = null;

    /** WRLD-6 (T7) — the `THREE.Group` the wastes dressing/boundary
     * geometry was added to `ctx.scene` under, so the NEXT `enterZone` can
     * remove and dispose it before building the next zone's own geometry
     * (T3's own "dispose every geometry... of the outgoing zone" — a
     * narrow slice of it, scoped to exactly what this ticket adds; a full
     * T3 teardown of every subsystem's geometry is not this ticket's file
     * grant). `null` when nothing has been built yet, or the current zone
     * is not `ashen_wastes`. */
    this._wastesGeometryGroup = null;

    /** WRLD-6 — `buildWastesGeometry`'s own return value for the current
     * zone (`{group, meshes, drawCalls, triangles, budgetedTriangles}`),
     * `null` when nothing was built (no `materials`/`ctx.scene`, or a
     * non-wastes zone). Report/test-only convenience — nothing reads this
     * back for gameplay. */
    this._wastesGeometryResult = null;

    /** WRLD-7 — the current zone's Bonereach layout/dressing plan (`null`
     * for every other zone kind), and the `THREE.Group` its T7 geometry
     * build added to `ctx.scene`, so the NEXT `enterZone` can dispose it —
     * same discipline as `_wastesLayout`/`_wastesGeometryGroup` above. */
    this._bonereachLayout = null;
    this._bonereachDressing = null;
    this._bonereachExit = null;
    this._bonereachGeometryGroup = null;

    /** WRLD-9 — `./spawn.js`'s own `report` object for the current zone
     * (`null` before the first `enterZone`, or for a zone kind with no
     * spawn pass — rule 11). Report/test-only, not a gameplay-facing field;
     * `spawnPoints`/`packs` below are the contracted surface (O-71). */
    this._spawnReport = null;

    /** WRLD-8 — the current zone's Altar layout/dressing (`null` for every
     * other zone kind). Report/test-only, same discipline as
     * `_wastesLayout`/`_bonereachLayout` above. */
    this._altarLayout = null;
    this._altarDressing = null;
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

  /** `02-api-contracts.md` §5 / `11-flows.md` A-2: `requestZone(zoneId,
   * entryTag, opts?) => boolean`. `Fixed: Y, Alloc: no` — safe to call from
   * `player`'s `fixedUpdate`. Thin forward into `./zone.js`'s latch (WRLD-4,
   * D-66 — the latch itself lives there, not here).
   * @param {string} zoneId
   * @param {string} entryTag
   * @param {{runIndex?: number, difficulty?: string}} [opts]
   * @returns {boolean} `false` when a request is already pending. */
  requestZone(zoneId, entryTag, opts) {
    return requestZoneLatch(this._zoneRequest, zoneId, entryTag, opts);
  }

  /** The service point `src/core/engine.js` phase 4b already calls, by
   * name, between `lateUpdate` and `render` (O-1 — contracted nowhere in
   * `02-api-contracts.md`; the name is settled by that shipped call site,
   * not by this ticket). Thin forward into `./zone.js` (WRLD-4, D-66),
   * which drives the real `enterZone` when a request is pending — see that
   * file's header for why that is the whole T5->T8->T9->T12 emission, not a
   * second implementation of it. */
  serviceZoneRequest() {
    serviceZoneRequestOnce(this._zoneRequest, this);
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

  /** `02-api-contracts.md` §5: `isTown` -> `boolean`. `false` before any
   * zone is loaded — a plain flag, not a "no sensible answer" case (unlike
   * `bounds`/`groundHeight`/`surfaceAt`/`entry` below), so this never
   * throws (see this ticket's report for why those four do). */
  get isTown() {
    return this._current ? this._current.descriptor.kind === 'town' : false;
  }

  /** `02-api-contracts.md` §5: `bounds(out?) => Bounds`. `Fixed: Y, Alloc:
   * no` in both branches — `out`, when given, is written and returned;
   * omitted, this returns `this._boundsScratch` (see the constructor's own
   * field comment), never a fresh object.
   * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} [out]
   * @returns {{minX:number,minZ:number,maxX:number,maxZ:number}}
   * @throws if no zone is currently loaded — there is no sensible bounds to
   *   report, and a caller asking before the first `enterZone` is a bug
   *   this should surface loudly, not paper over with a fake zero-size
   *   zone (see this ticket's report). */
  bounds(out) {
    const inst = this._current;
    if (!inst) throw new Error('world.bounds: no zone is currently loaded');
    const target = out || this._boundsScratch;
    target.minX = inst.boundsMinX;
    target.minZ = inst.boundsMinZ;
    target.maxX = inst.boundsMaxX;
    target.maxZ = inst.boundsMaxZ;
    return target;
  }

  /** `02-api-contracts.md` §5: `surfaceAt(x, z) => SurfaceType`. ASSIGNED
   * placeholder (see this ticket's report, "Scope honesty"): no per-cell
   * ground-surface region generator exists yet (that is generator work,
   * WRLD-5..8), so every point in the zone reads as the same value —
   * `descriptor.surfaces[0]`, the zone's own primary ground surface (`07`
   * §1.6), the exact same "first listed surface" convention
   * `buildBoundaryFootprints` already uses for the placeholder wall
   * colliders. `x`/`z` are accepted (the real contract signature) but
   * unused until real per-position data exists.
   * @param {number} x
   * @param {number} z
   * @returns {string} a `SURFACE` value.
   * @throws if no zone is currently loaded. */
  surfaceAt(x, z) {
    void x;
    void z;
    const inst = this._current;
    if (!inst) throw new Error('world.surfaceAt: no zone is currently loaded');
    return inst.descriptor.surfaces[0];
  }

  /** `02-api-contracts.md` §5 / `07` §13 A4: `entry(entryTag, out?) =>
   * {x,y,z,facing}`. Reads `ZoneInstance.entries` (`01` §9.2) first — real,
   * generator-authored data, forward-compatible with the day one exists —
   * and falls back to the zone's own centre, facing `0`, ONLY because that
   * map is always empty today (no generator populates it yet; see this
   * ticket's report). `y` is never stored (`01` §9.2 only carries `x, z,
   * facing`) — always `this.groundHeight(x, z)`, matching `07` §1.3's own
   * `Actor.y = world.groundHeight(x, z) + hoverY` rule.
   *
   * A4: when `out` is given but has no `facing` key, `facing` is left
   * untouched on it (the exact old `Vec3` — `x, y, z` only — behaviour);
   * `out` otherwise gets all four fields. Omitting `out` returns
   * `this._entryScratch` (see the constructor's own field comment),
   * always with `facing` set.
   * @param {string} entryTag
   * @param {{x?:number,y?:number,z?:number,facing?:number}} [out]
   * @returns {{x:number,y:number,z:number,facing?:number}}
   * @throws if no zone is loaded, or `entryTag` is not one of the current
   *   zone's own declared `entryTags` (`01` §9.1). */
  entry(entryTag, out) {
    const inst = this._current;
    if (!inst) throw new Error('world.entry: no zone is currently loaded');
    if (!inst.descriptor.entryTags.includes(entryTag)) {
      throw new Error(`world.entry: unknown entryTag '${entryTag}' for zone '${inst.zoneId}'`);
    }

    const stored = inst.entries.get(entryTag); // real data path — always undefined today, see the file header
    const x = stored ? stored.x : 0; // ASSIGNED placeholder: zone centre — no generator has populated real entries yet
    const z = stored ? stored.z : 0;
    const facing = stored ? stored.facing : 0;
    const y = this.groundHeight(x, z);

    const target = out || this._entryScratch;
    target.x = x;
    target.y = y;
    target.z = z;
    if (!out || 'facing' in out) target.facing = facing; // A4 — old Vec3 form when out lacks facing
    return target;
  }

  /** `02-api-contracts.md` §5 / `07` §1.3: `groundHeight(x, z) => number`
   * — `terrace(x, z) + noise(x, z)`, the analytic function. `Fixed: Y,
   * Alloc: no` — a thin forward into `./height.js`'s `sampleHeightField`
   * against this zone's own precomputed table (built once per `enterZone`
   * — see that call site's own comment).
   * @param {number} x
   * @param {number} z
   * @returns {number} metres
   * @throws if no zone is currently loaded. */
  groundHeight(x, z) {
    if (!this._heightField) throw new Error('world.groundHeight: no zone is currently loaded');
    return sampleHeightField(this._heightField, x, z);
  }

  /** `02-api-contracts.md` §5: `staticFootprints` -> `readonly Footprint[]`
   * — frozen at `zone:ready`, invalidated by the next `enterZone`. Returns
   * the same frozen array every call between two zone loads (Alloc: no). */
  get staticFootprints() {
    return this._staticFootprints;
  }

  /** `02-api-contracts.md` §5: `spawnPoints` -> `SpawnPoint[]` (O-71 — a
   * contracted property on `world` itself, not only reachable through
   * `world.current.spawnPoints`). WRLD-9's own T10 pass populates
   * `this._current.spawnPoints`; this just forwards it, `[]` before any
   * zone has loaded (matching `ZoneInstance`'s own literal default). */
  get spawnPoints() {
    return this._current ? this._current.spawnPoints : [];
  }

  /** `02-api-contracts.md` §5: `packs` -> `PackDescriptor[]` — same
   * forwarding convention as `spawnPoints` above (O-71). */
  get packs() {
    return this._current ? this._current.packs : [];
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
    this._disposeWastesGeometry(); // WRLD-6 — see the field's own comment
    this._disposeBonereachGeometry(); // WRLD-7 — see the field's own comment

    const seed = this.seedFor(zoneId, runIndex);
    const isWastes = zoneId === 'ashen_wastes'; // WRLD-6 — no other generator exists yet (rule 11)
    const isBonereach = zoneId === 'bonereach'; // WRLD-7 — WRLD-8/9/10 land behind this ticket (rule 11)
    const isAltar = zoneId === 'altar_of_instruction'; // WRLD-8

    // WRLD-6 (T6 — Layout): the pure generator. `07` §3.2's own emission
    // order is "R1..R10 (pure, no three) -> geometry build -> physics.rebuild()
    // -> nav.rebuild() -> R11 -> zone:ready", and R9 (this ticket's boundary
    // treatment) draws from the SAME live `S1`/`S2` `generateRidgewalkLayout`
    // hands back, continued (not re-forked) by `placeRidgewalkEntries`
    // (R10) afterward — see `src/world/gen/ridgewalk.js`'s own header,
    // "so a later caller... continues the SAME streams", and this ticket's
    // report for why R9 runs strictly between R7 and R10.
    let wastesLayout = null;
    let wastesDressing = null;
    let wastesBoundary = null;
    let wastesEntries = null;
    let terraces = DEFAULT_TERRACES;

    if (isWastes) {
      wastesLayout = generateRidgewalkLayout(seed, descriptor);
      wastesDressing = runR8Dressing(wastesLayout, descriptor, wastesLayout.streams);
      wastesBoundary = runR9Boundary(wastesLayout, descriptor, wastesLayout.streams);
      wastesEntries = placeRidgewalkEntries(wastesLayout, descriptor, wastesLayout.streams);
      // O-99's own trigger: WRLD-5's R5 emits real -2.20 m ravines / +1.20 m
      // shelves in `wastesLayout.terraces` — using those (instead of
      // `DEFAULT_TERRACES`'s single flat 0.00 m layer) is what makes the
      // height field, and therefore `nav.groundY` below, carry real
      // elevation for this zone. See this file's header note on this
      // ticket's own O-99 fix.
      if (wastesLayout.terraces.length > 0) terraces = wastesLayout.terraces;
    }
    this._wastesLayout = wastesLayout;
    this._wastesDressing = wastesDressing;
    this._wastesBoundary = wastesBoundary;

    // WRLD-7 (T6 — Layout): the Bonereach BSP hall generator. B1-B10 all run
    // headless off ONE `generateBonereachLayout` call (D-65 consolidates the
    // spec's own `gen/bsp.js` + dressing split into this one layout file —
    // see `./gen/bonereach.js`'s own header); B8 (chests) and B9 (dressing,
    // a bonus — not gated by any of this ticket's numbered criteria) are
    // separate calls continuing the SAME `layout.streams`, and B10
    // (entries/exits) is pure geometry, no draw at all.
    let bonereachLayout = null;
    let bonereachDressing = null;
    let bonereachChests = [];
    let bonereachEntries = null;
    let bonereachExit = null;

    if (isBonereach) {
      bonereachLayout = generateBonereachLayout(seed, descriptor);
      const loot = placeBonereachLoot(bonereachLayout, descriptor, bonereachLayout.streams);
      bonereachChests = loot.chests;
      bonereachDressing = runBonereachDressing(bonereachLayout, descriptor, bonereachLayout.streams);
      const placed = placeBonereachEntries(bonereachLayout, descriptor);
      bonereachEntries = placed.entries;
      bonereachExit = placed.exit;
      // The stair room's 6-step ramp down to -2.40 m (07 §4.1) — real
      // terraces, the same "replace DEFAULT_TERRACES wholesale" mechanism
      // O-99 already established for Ridgewalk's ravines/shelves, so
      // `nav.groundY` below carries Bonereach's own real elevation too.
      if (bonereachLayout.terraces.length > 0) terraces = bonereachLayout.terraces;
    }
    // WRLD-8 (T6 — Layout): the fixed arena. `generateAltarLayout` draws
    // nothing (`07` §5: "the layout is fixed"); `runAltarDressing` is the
    // only seeded stage and every prop it emits is `blocksNav: false`, so
    // the dressing list is deliberately NOT passed to `altarToFootprints`.
    let altarLayout = null;
    let altarDressing = null;
    if (isAltar) {
      altarLayout = generateAltarLayout(seed, descriptor);
      altarDressing = runAltarDressing(altarLayout, descriptor, altarLayout.streams);
      terraces = altarLayout.terraces; // the three §5.1 terraces, per-nav-row — see ./gen/altar.js
    }
    this._altarLayout = altarLayout;
    this._altarDressing = altarDressing;

    this._bonereachLayout = bonereachLayout;
    this._bonereachDressing = bonereachDressing;
    this._bonereachExit = bonereachExit; // report/test-only — no portal-wiring ticket consumes this yet (same gap wastesEntries.exit already has)

    // WRLD-4 round 2 — this zone's terrace/noise table (`./height.js`),
    // built here so it is already ready for anything a `zone:enter`
    // listener might synchronously query, and so every `groundHeight`/
    // `entry` read after this point is `Alloc: no` (the `staticFootprints`
    // precedent — allocate once, between frames, at the transition).
    // `seed` (not a real `S1 shape` fork, which does not exist yet — see
    // this file's header) is the documented interim noise seed.
    this._heightField = buildHeightField({
      sizeX: descriptor.sizeX,
      sizeZ: descriptor.sizeZ,
      terraces,
      noiseSeed: seed,
    });

    events.emit('zone:enter', { zoneId, seed, entry: entryTag });

    // WRLD-6/7 (T7 — Geometry, `three`-legal, see `./build/wastes.js`'s own
    // header for the D-72 lint finding this import carries). Runs BEFORE T8
    // physics/T9 nav, per `07` §10.2's own table ordering — geometry build
    // only ever reads the plain-data plan T6 already produced.
    const footprints = isWastes
      ? toFootprints(wastesDressing.props, wastesBoundary.ridgeWall)
      : isBonereach
        ? bonereachToFootprints(bonereachLayout, bonereachDressing)
        : isAltar
          ? altarToFootprints(altarLayout)
          : buildBoundaryFootprints(descriptor);

    const materialsSys = typeof this._ctx.peek === 'function' ? this._ctx.peek('materials') : null;
    if (isWastes && materialsSys && this._ctx.scene) {
      const plan = buildInstancingPlan(wastesDressing.props, wastesBoundary.ridgeWall, wastesBoundary.silhouette);
      const geomResult = buildWastesGeometry(this._ctx, plan);
      buildAshBerm(this._ctx, geomResult.group, wastesBoundary.berm);
      this._wastesGeometryGroup = geomResult.group;
      this._wastesGeometryResult = geomResult;
    } else {
      this._wastesGeometryResult = null;
    }

    if (isBonereach && materialsSys && this._ctx.scene) {
      // Visual walls come from `buildWallSegments` (real doorway gaps),
      // NOT from `footprints` — the rock pieces `bonereachToFootprints`
      // emits are the nav/physics blocking geometry, a different (coarser)
      // shape than an individual room's own four walls. See
      // `./gen/bonereach.js`'s own header for the full disclosure on why
      // nav blocking and visual walls are built from two different data
      // shapes here.
      const wallSegments = buildBonereachWallSegments(bonereachLayout);
      const geomResult = buildBonereachGeometry(this._ctx, bonereachLayout, wallSegments, bonereachDressing.props);
      this._bonereachGeometryGroup = geomResult.group;
    }

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

    const entries = new Map();
    const chests = [];
    // WRLD-8 — `07` §9.3's `Interactable[]`. `01` §9.2's `ZoneInstance` has
    // no such field; `world.interactableAt` (`02` §5) has no other possible
    // producer, so the array is added here and left `[]` for every zone that
    // has none. Reported as an extension to the record, not a silent one.
    const interactables = [];
    const portals = [];
    if (isAltar) {
      entries.set('altar_entry', altarLayout.entries.altar_entry);
      for (const p of altarLayout.portals) portals.push(p);
      for (const it of altarLayout.interactables) interactables.push(it);
    }
    if (isWastes) {
      entries.set('portal_from_town', wastesEntries.entries.portal_from_town);
      entries.set('descent_return', wastesEntries.entries.descent_return);
      for (const c of wastesEntries.chests) chests.push(c);
    }
    if (isBonereach) {
      // `descriptor.entryTags` (SHIPPED zones.js: ['descent','altar_return'])
      // — see `./gen/bonereach.js`'s own header for the full spec-vs-shipped
      // disclosure on why these tag names differ from `07` §4.2 B10's own
      // literal ('descent'/'ascent_return'/'portal_return').
      entries.set('descent', bonereachEntries.descent);
      entries.set('altar_return', bonereachEntries.altar_return);
      for (const c of bonereachChests) chests.push(c);
    }

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

      // O-99 — populated below, before `nav.rebuild(instance)` runs, so
      // `passN3Slope` (`src/world/raster.js`) receives a real heightfield
      // instead of the permanent no-op `nav: null` left it at. See this
      // file's header and `_buildNavGroundY`'s own comment.
      nav: this._buildNavGroundY(bounds),
      spawnPoints: [],
      packs: [],
      portals,
      entries,
      chests,
      interactables,

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

    // WRLD-9 (T10 — Spawning, R11 / `07` §8): runs strictly after
    // `nav.rebuild(instance)` above — `spawn.js` reads `nav.grid`'s real,
    // just-rasterised walkable/region data for THIS zone (O-102: `nav`
    // never computes an entry region itself, `spawn.js` does). Only the two
    // zones with a real generator take this path (rule 11); every other
    // zone keeps `spawnPoints`/`packs` at the instance literal's own `[]`.
    this._spawnReport = null;
    if (nav && typeof nav.rebuild === 'function' && nav.grid) {
      if (isWastes) {
        const result = planWastesSpawns({ descriptor, tier: difficulty, grid: nav.grid, layout: wastesLayout, wastesEntries });
        instance.spawnPoints = result.spawnPoints;
        instance.packs = result.packs;
        this._spawnReport = result.report;
      } else if (isBonereach) {
        const result = planBonereachSpawns({ descriptor, tier: difficulty, grid: nav.grid, layout: bonereachLayout, bonereachEntries, chests: bonereachChests });
        instance.spawnPoints = result.spawnPoints;
        instance.packs = result.packs;
        this._spawnReport = result.report;
      }
    }

    events.emit('zone:ready', { zoneId, bounds, navVersion: instance.navVersion });

    return instance;
  }

  /**
   * O-99 — builds `ZoneInstance.nav`'s grid-geometry shell + `groundY`
   * heightfield, sampled from `this._heightField` (already built, above,
   * for THIS zone) at exactly the cell centres `src/nav/index.js`'s own
   * `resolveGridGeometry` derives from `zone.boundsMinX/../boundsMaxZ`
   * (`RASTER.CELL_SIZE`, `Math.round((max-min)/cellSize)`) — matched here
   * verbatim so this shell agrees with what `nav` would have computed on
   * its own from the bounds alone, just now WITH a real `groundY` instead
   * of the `null` that branch leaves `passN3Slope` a permanent no-op on.
   * Runs for every zone (not only Ashen Wastes) — this is a general nav
   * correctness fix, not a wastes-specific one; only `ashen_wastes` has any
   * non-flat terrain yet (WRLD-5's ravines/shelves), so it is the only zone
   * where this actually changes `passN3Slope`'s behaviour today.
   * `Alloc: yes` — same "once per enterZone, between frames" cost class as
   * `buildHeightField` itself.
   * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} bounds
   * @returns {{width:number,height:number,originX:number,originZ:number,cellSize:number,groundY:Float32Array}}
   * @private
   */
  _buildNavGroundY(bounds) {
    const cellSize = RASTER.CELL_SIZE;
    const width = Math.max(1, Math.round((bounds.maxX - bounds.minX) / cellSize));
    const height = Math.max(1, Math.round((bounds.maxZ - bounds.minZ) / cellSize));
    const originX = bounds.minX;
    const originZ = bounds.minZ;
    const groundY = new Float32Array(width * height);
    for (let cz = 0; cz < height; cz++) {
      const wz = originZ + (cz + 0.5) * cellSize;
      const row = cz * width;
      for (let cx = 0; cx < width; cx++) {
        const wx = originX + (cx + 0.5) * cellSize;
        groundY[row + cx] = sampleHeightField(this._heightField, wx, wz);
      }
    }
    return { width, height, originX, originZ, cellSize, groundY };
  }

  /** WRLD-6 — removes and disposes the previous zone's wastes dressing
   * geometry (the `THREE.Group` `_wastesGeometryGroup` points at), if any.
   * A narrow slice of T3's "dispose every geometry... of the outgoing
   * zone" — scoped to exactly what this ticket adds, not a full T3
   * teardown (out of this ticket's file grant). Safe to call even when
   * nothing was ever built (bare unit-test `ctx`, non-wastes zones).
   * @private */
  _disposeWastesGeometry() {
    const g = this._wastesGeometryGroup;
    if (!g) return;
    if (g.parent) g.parent.remove(g);
    for (const mesh of g.children) {
      if (mesh.geometry && typeof mesh.geometry.dispose === 'function') mesh.geometry.dispose();
    }
    this._wastesGeometryGroup = null;
    this._wastesGeometryResult = null;
  }

  /** WRLD-7 — same discipline as `_disposeWastesGeometry`, for Bonereach's
   * own geometry group. `disposeBonereachGeometry` (`./build/bonereach.js`)
   * does the actual removal/traversal; this just clears the field.
   * @private */
  _disposeBonereachGeometry() {
    if (!this._bonereachGeometryGroup) return;
    disposeBonereachGeometry(this._bonereachGeometryGroup);
    this._bonereachGeometryGroup = null;
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
