// src/physics/index.js
//
// PHYS-1 — the uniform static grid, the `Footprint` record and its typed-
// array storage, and the `PhysicsSystem` shell (`LAYER`/`MASK`, `stats`,
// `groundHeight`, `setDebugDraw`). Bodies, `moveBody`, casts and `separate`
// belong to PHYS-2..5 — see this ticket's report for the exact boundary and
// why the stubs are honest zeros rather than pretend implementations.
//
// PHYS-2 addendum: `addBody`/`removeBody`/`setBody`/`moveBody`/
// `setBodyFlags` are added below. Per this ticket's brief ("index.js —
// только чтобы выставить наружу методы тел"), every one of them is a thin
// forward into `BodyStore` (`./body.js`, PHYS-2's real file) — all
// collision/slide/step logic lives there, not here. The one piece of glue
// genuinely owned by this file is `_staticsSource`, the duck-typed read-only
// view of this class's own static storage that `BodyStore.moveBody` needs
// (see `body.js`'s file header for why it's handed in rather than imported)
// — built with property GETTERS, not a snapshot, because `_ensureCapacity`
// below replaces `_x`/`_z`/etc. with new, larger typed arrays on growth
// (`addStatic` is `Alloc: yes`); a plain object literal capturing today's
// array references would silently go stale the next time a static grid
// grows mid-session.
//
/**
 * ===========================================================================
 * PHYSICS — 2.5D broadphase, casts, actor push-out, projectile sweeps
 * ===========================================================================
 *
 * There is no 3D rigid-body solver here and there will not be one. The camera
 * is fixed and the game is played on a plane: actors are circles on the XZ
 * plane with a height interval, static geometry is a set of convex footprints,
 * and the whole thing lives in a uniform grid of 2 m cells. Everything is
 * O(actors in a cell), deterministic, and runs headless in Node.
 *
 * Stepped from fixedUpdate at 60 Hz. All queries are allocation-free.
 *
 * PUBLIC API — const phys = ctx.get('physics')
 * ...
 */
// (docs/spec/02-api-contracts.md §4, verbatim above — see that document for
// the full method table this ticket implements a slice of.)
//
// ---------------------------------------------------------------------------
// Node-safety: why this file never imports `three`
// ---------------------------------------------------------------------------
// `addStaticGroup(object3D, surface)` is the one method here whose signature
// mentions `THREE.Object3D`. Importing `three` at the top of this module
// would make the whole `src/physics/` directory unloadable without the
// package resolving — survivable today (three.js itself has no DOM
// dependency and imports fine under plain Node), but two things make it the
// wrong call anyway: (1) `tools/mapgen.mjs` (M5) is specified to build the
// static grid headlessly, calling `addStatic` directly with plain
// `Footprint` objects it built itself, never touching `addStaticGroup` or a
// real `THREE.Object3D` at all — physics importing `three` would be a
// dependency this file's actual runtime uses never need; (2) this ticket's
// brief flags that `tools/check-imports.mjs` does not scan `src/physics/`
// *yet* only because no `src/physics/data/` directory exists to trigger its
// auto-discovery, not because the boundary doesn't apply here — every other
// N-adjacent, Node-must-load-headlessly directory in this codebase (combat,
// items, skills, nav, world/data) is `three`-free by the same rule, and
// physics is exactly that kind of directory (`ARCHITECTURE.md`'s "There is
// no 3D rigid-body solver" + "runs headless in Node").
//
// So `addStaticGroup` reaches into the `object3D` it is HANDED via duck
// typing only: `.geometry.computeBoundingBox()`/`.boundingBox` (a method
// the caller's real `three` object already has — calling it is not
// importing `three`, any more than calling `.push()` on an array the caller
// handed you is importing a class), `.matrixWorld.elements` (a flat
// column-major 16-number array — read as raw numbers, never wrapped in a
// `THREE.Matrix4`), `.children` (a plain array), and `.visible`. See
// `_footprintFromNode` below for the matrix decomposition math this buys.

import { UniformGrid, CELL_SIZE } from './grid.js';
import { BodyStore, BODY_FLAG, DEFAULT_MAX_BODIES } from './body.js';

/** Re-exported for convenience only — NOT part of the `ctx.get('physics')`
 * instance contract (see `body.js`'s own comment on this constant: unlike
 * `LAYER`/`MASK`, `02-api-contracts.md` §4 does not list `BODY_FLAG` as an
 * instance property, so it is never attached to `PhysicsSystem` itself).
 * A caller of `setBodyFlags` imports this the same way it would import
 * `FOOTPRINT_DEFAULTS`. */
export { BODY_FLAG };

/** `02-api-contracts.md` §4, verbatim. */
export const LAYER = Object.freeze({
  STATIC: 1,
  PLAYER: 2,
  MONSTER: 4,
  NEUTRAL: 8,
  PROJECTILE: 16,
  TRIGGER: 32,
});

/** `02-api-contracts.md` §4, verbatim. */
export const MASK = Object.freeze({
  WORLD: 1,
  ACTORS: 14,
  HOSTILE_TO_PLAYER: 4,
  HOSTILE_TO_MONSTER: 2,
  SIGHT: 1,
});

/**
 * `02-api-contracts.md` §4's `Footprint` record, field for field — nothing
 * added, nothing removed, same default values. `addStatic` spreads a
 * caller's (possibly partial) footprint over this object, so a caller may
 * omit any field it doesn't care about (exactly as `SpawnSpec` and every
 * other "plain-object type" documented across `02-api-contracts.md` is used
 * elsewhere in this codebase).
 */
export const FOOTPRINT_DEFAULTS = Object.freeze({
  kind: 'box', // 'box' | 'cylinder' | 'poly'
  x: 0,
  z: 0, // centre on the XZ plane
  y: 0, // floor height of the interval
  height: 3.0, // metres; the interval is [y, y + height)
  halfW: 1.0, // 'box': half-extents before rotation
  halfL: 1.0,
  radius: 0, // 'cylinder' only
  points: null, // 'poly' only: [x0,z0, x1,z1, …] CCW, convex, ≤ 8 points
  facing: 0, // radians, 'box' and 'poly'
  blocksNav: true, // false → physics collides, nav ignores (low rubble)
  blocksSight: true, // false → physics collides, lineOfSight passes (rails)
});

const KIND_BOX = 0;
const KIND_CYLINDER = 1;
const KIND_POLY = 2;
const KIND_CODE = { box: KIND_BOX, cylinder: KIND_CYLINDER, poly: KIND_POLY };

/** Starting capacity of the SoA static-storage arrays; doubled by
 * `_ensureCapacity` whenever `addStatic` needs more room. Chosen so the
 * 10 000-static perf case (`tests/physics/phys1.test.js`) only reallocates a
 * handful of times (1024 → 2048 → … → 16384), not once per call. */
const INITIAL_CAPACITY = 1024;

/** @param {Uint8Array} arr @param {number} capacity @returns {Uint8Array} */
function growUint8(arr, capacity) {
  const next = new Uint8Array(capacity);
  next.set(arr);
  return next;
}

/** @param {Float64Array} arr @param {number} capacity @returns {Float64Array} */
function growFloat64(arr, capacity) {
  const next = new Float64Array(capacity);
  next.set(arr);
  return next;
}

export class PhysicsSystem {
  static id = 'physics';
  static deps = [];

  constructor() {
    this._grid = new UniformGrid(CELL_SIZE);

    /** `{ minX, minZ, maxX, maxZ } | null` — captured off `zone:ready`'s
     * payload (`world.bounds()`'s own shape). `null` before the first zone
     * has loaded, which is exactly the state `groundHeight` must treat as
     * "off-map everywhere" (see that method). */
    this._bounds = null;

    // --- Static footprint storage (SoA, typed arrays) ----------------------
    // Handle `h` lives at slot `h - 1` (handles are 1-based; 0 stays
    // reserved as "no handle", matching every other `int handle` in
    // 02-api-contracts.md). `_count` is slots ever allocated (alive + dead);
    // `_aliveCount` is what `stats.statics` reports.
    this._capacity = 0;
    this._count = 0;
    this._aliveCount = 0;

    this._kindCode = new Uint8Array(0);
    this._x = new Float64Array(0);
    this._z = new Float64Array(0);
    this._y = new Float64Array(0);
    this._height = new Float64Array(0);
    this._halfW = new Float64Array(0);
    this._halfL = new Float64Array(0);
    this._radius = new Float64Array(0);
    this._facing = new Float64Array(0);
    this._blocksNav = new Uint8Array(0);
    this._blocksSight = new Uint8Array(0);
    this._alive = new Uint8Array(0);
    /** @type {(Float32Array|null)[]} 'poly' points only; index by slot.
     * Not hot-path (few footprints are 'poly'), so a plain array is fine. */
    this._polyPoints = [];
    /** @type {(string)[]} `SurfaceType` per slot; metadata, not hot-path. */
    this._surface = [];

    // Reused across `rebuild()`'s per-footprint AABB pass so hashing 10 000
    // statics does not allocate one `{minX,minZ,maxX,maxZ}` object per
    // footprint — see `_aabbOf`.
    this._scratchAabb = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

    this._debugDraw = false;

    // --- Bodies (PHYS-2) ---------------------------------------------------
    // Constructed here with the assigned fallback capacity so a minimal test
    // `ctx` (no `config`, e.g. `tests/physics/phys1.test.js`'s own
    // `makeCtx()`) never crashes; `init()` below replaces this with a store
    // sized to the real `ctx.config.q.maxActors` as soon as one is known
    // (`11-flows.md`'s boot table: "body arrays sized q.maxActors"). Safe to
    // replace wholesale in `init()` because `init()` runs once, at boot,
    // before any zone/actor exists to have added a body yet.
    this._bodies = new BodyStore(DEFAULT_MAX_BODIES);

    // The duck-typed `StaticsSource` `BodyStore.moveBody` reads — see this
    // file's header for why every field is a getter, not a captured
    // reference. Built once; reused by every `moveBody` call (no per-call
    // object).
    const self = this;
    this._staticsSource = {
      get grid() {
        return self._grid;
      },
      get kindCode() {
        return self._kindCode;
      },
      get x() {
        return self._x;
      },
      get z() {
        return self._z;
      },
      get y() {
        return self._y;
      },
      get height() {
        return self._height;
      },
      get halfW() {
        return self._halfW;
      },
      get halfL() {
        return self._halfL;
      },
      get radius() {
        return self._radius;
      },
      get facing() {
        return self._facing;
      },
      get polyPoints() {
        return self._polyPoints;
      },
      get alive() {
        return self._alive;
      },
    };

    // `stats` (Alloc: no) returns this exact object every call, mutated in
    // place — the same convention `src/render/index.js`'s `get stats()`
    // already uses for its own Alloc:no property. `bodies` is real from
    // here on (PHYS-2); `casts`/`separationMs` remain honest zeros for
    // PHYS-3/4.
    this._stats = { statics: 0, bodies: 0, cells: 0, casts: 0, separationMs: 0 };

    /** `ctx.get('physics').LAYER` / `.MASK` — the module-level frozen
     * constants, also reachable off the instance (02-api-contracts.md §4
     * lists them in the same table as the instance methods). */
    this.LAYER = LAYER;
    this.MASK = MASK;
  }

  /**
   * @param {{events: {on: Function}}} ctx
   */
  async init(ctx) {
    // No `ctx.rng.fork()` — PHYS-1/2 draw no randomness (grid hashing, AABB
    // math and collision resolution are pure arithmetic over caller-supplied
    // numbers).
    ctx.events.on('zone:ready', (payload) => this._onZoneReady(payload));

    // PHYS-2: size the body store to the real `q.maxActors` as soon as a
    // real config is available (`11-flows.md`'s boot table). A minimal test
    // `ctx` without `config` (PHYS-1's own `tests/physics/phys1.test.js`)
    // leaves the constructor's `DEFAULT_MAX_BODIES`-sized store in place.
    const maxActors = ctx && ctx.config && ctx.config.q && ctx.config.q.maxActors;
    if (Number.isInteger(maxActors) && maxActors > 0 && maxActors !== this._bodies.capacity) {
      this._bodies = new BodyStore(maxActors);
      this._stats.bodies = 0;
    }
  }

  /** `zone:ready` handler — `02-api-contracts.md` §4: "Listens: zone:ready
   * (rebuilds the static grid)". `payload.bounds` is `world.bounds()`'s own
   * `{minX,minZ,maxX,maxZ}` shape; captured here so `groundHeight` has an
   * "off-map" answer without physics needing to own terrain data itself.
   * @param {{bounds?: {minX:number,minZ:number,maxX:number,maxZ:number}}} [payload] */
  _onZoneReady(payload) {
    this._bounds = (payload && payload.bounds) || null;
    this.rebuild();
  }

  /** @param {number} minCapacity */
  _ensureCapacity(minCapacity) {
    if (minCapacity <= this._capacity) return;
    let capacity = this._capacity === 0 ? INITIAL_CAPACITY : this._capacity * 2;
    while (capacity < minCapacity) capacity *= 2;

    this._kindCode = growUint8(this._kindCode, capacity);
    this._x = growFloat64(this._x, capacity);
    this._z = growFloat64(this._z, capacity);
    this._y = growFloat64(this._y, capacity);
    this._height = growFloat64(this._height, capacity);
    this._halfW = growFloat64(this._halfW, capacity);
    this._halfL = growFloat64(this._halfL, capacity);
    this._radius = growFloat64(this._radius, capacity);
    this._facing = growFloat64(this._facing, capacity);
    this._blocksNav = growUint8(this._blocksNav, capacity);
    this._blocksSight = growUint8(this._blocksSight, capacity);
    this._alive = growUint8(this._alive, capacity);
    this._capacity = capacity;
  }

  /**
   * Registers one static footprint. Storage only — does NOT touch the grid;
   * `rebuild()` is the sole hashing pass (`02-api-contracts.md` §4:
   * "Never call addStatic after zone:ready without a matching rebuild()").
   * @param {object} footprint - a `Footprint`, any subset of fields; missing
   *   ones take `FOOTPRINT_DEFAULTS`.
   * @param {string} surface - `SurfaceType`.
   * @param {object} [opts] - reserved; no fields are defined by
   *   `02-api-contracts.md` §4 today. Accepted and currently unused — see
   *   this ticket's report.
   * @returns {number} handle, 1-based, never 0.
   */
  addStatic(footprint, surface, opts) { // eslint-disable-line no-unused-vars
    const fp = { ...FOOTPRINT_DEFAULTS, ...footprint };
    const slot = this._count;
    this._ensureCapacity(slot + 1);

    this._kindCode[slot] = KIND_CODE[fp.kind] !== undefined ? KIND_CODE[fp.kind] : KIND_BOX;
    this._x[slot] = fp.x;
    this._z[slot] = fp.z;
    this._y[slot] = fp.y;
    this._height[slot] = fp.height;
    this._halfW[slot] = fp.halfW;
    this._halfL[slot] = fp.halfL;
    this._radius[slot] = fp.radius;
    this._facing[slot] = fp.facing;
    this._blocksNav[slot] = fp.blocksNav ? 1 : 0;
    this._blocksSight[slot] = fp.blocksSight ? 1 : 0;
    this._alive[slot] = 1;
    this._polyPoints[slot] = fp.points ? Float32Array.from(fp.points) : null;
    this._surface[slot] = surface;

    this._count++;
    this._aliveCount++;
    this._stats.statics = this._aliveCount;
    return slot + 1;
  }

  /**
   * Derives one or more box `Footprint`s from a real (caller-owned)
   * `THREE.Object3D` subtree and registers each via `addStatic`. Duck-typed
   * — see this file's header for why `three` is never imported here. Walks
   * `object3D` and every descendant in `.children` array order (a
   * deterministic pre-order walk of whatever tree the caller built — no
   * randomness, no `Map`/`Set` involved), and for every visible node
   * carrying a `.geometry`, emits one axis-in-its-own-frame box footprint
   * sized from that geometry's local bounding box and `node.matrixWorld`.
   *
   * Only ever produces `kind: 'box'` footprints — a tight enclosing box is
   * always a safe conservative collider; a caller that needs a `cylinder`
   * or `poly` footprint for a specific prop calls `addStatic` directly with
   * a hand-built `Footprint` instead (this method does not preclude that).
   *
   * Assumes `object3D.matrixWorld` is already current (the caller's normal
   * scene update already ran); this method does not call
   * `updateMatrixWorld()` itself.
   *
   * @param {object} object3D - duck-typed `THREE.Object3D`.
   * @param {string} surface - `SurfaceType`, applied to every derived footprint.
   * @returns {number[]} handles, in the same pre-order the tree was walked.
   */
  addStaticGroup(object3D, surface) {
    const handles = [];
    this._collectStaticGroup(object3D, surface, handles);
    return handles;
  }

  /** @private */
  _collectStaticGroup(node, surface, handles) {
    if (!node) return;
    if (node.visible !== false && node.geometry && typeof node.geometry.computeBoundingBox === 'function') {
      const fp = this._footprintFromNode(node);
      if (fp) handles.push(this.addStatic(fp, surface));
    }
    const children = node.children;
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length; i++) this._collectStaticGroup(children[i], surface, handles);
    }
  }

  /** Duck-typed mesh -> box `Footprint`. Reads `node.geometry`'s local
   * bounding box and `node.matrixWorld.elements` (flat, column-major, three
   * r180's own layout: columns are `elements[0..3]`/`[4..7]`/`[8..11]`,
   * translation is `elements[12..14]`). Assumes the transform carries no
   * X/Z tilt (Y-axis rotation only) — consistent with this engine's fixed-
   * camera, XZ-plane-only physics model; a genuinely tilted static mesh is
   * out of scope for this ticket and for the engine as a whole.
   * @private
   * @returns {object | null} a partial `Footprint`, or `null` for a
   *   degenerate (zero-area) or matrix-less node. */
  _footprintFromNode(node) {
    const geometry = node.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb || !bb.min || !bb.max) return null;
    const min = bb.min;
    const max = bb.max;
    if (!(max.x > min.x) || !(max.z > min.z)) return null;

    const mw = node.matrixWorld;
    const e = mw && mw.elements;
    if (!e || e.length !== 16) return null;

    const scaleX = Math.hypot(e[0], e[1], e[2]);
    const scaleY = Math.hypot(e[4], e[5], e[6]);
    const scaleZ = Math.hypot(e[8], e[9], e[10]);
    const facing = Math.atan2(e[8], e[10]);

    const lcx = (min.x + max.x) / 2;
    const lcy = (min.y + max.y) / 2;
    const lcz = (min.z + max.z) / 2;

    const worldX = e[0] * lcx + e[4] * lcy + e[8] * lcz + e[12];
    const worldY = e[1] * lcx + e[5] * lcy + e[9] * lcz + e[13];
    const worldZ = e[2] * lcx + e[6] * lcy + e[10] * lcz + e[14];

    const halfW = ((max.x - min.x) / 2) * scaleX;
    const halfL = ((max.z - min.z) / 2) * scaleZ;
    const height = (max.y - min.y) * scaleY;

    return {
      kind: 'box',
      x: worldX,
      z: worldZ,
      y: worldY - height / 2,
      height,
      halfW,
      halfL,
      facing,
      blocksNav: true,
      blocksSight: true,
    };
  }

  /**
   * @param {number} handle
   */
  removeStatic(handle) {
    const slot = handle - 1;
    if (slot < 0 || slot >= this._count) return; // stale/unknown handle — safe no-op
    if (!this._alive[slot]) return; // already removed — safe no-op
    this._alive[slot] = 0;
    this._aliveCount--;
    this._stats.statics = this._aliveCount;
  }

  /** Writes footprint `slot`'s world-space AABB into `this._scratchAabb`
   * and returns it (reused across the whole `rebuild()` pass — zero
   * allocation per footprint). Never call this and hold the result past the
   * next call, same discipline as `physics`'s own `Hit`/`MoveResult` ring.
   * @private
   * @param {number} slot
   * @returns {{minX:number,minZ:number,maxX:number,maxZ:number}} */
  _aabbOf(slot) {
    const out = this._scratchAabb;
    const kind = this._kindCode[slot];
    const x = this._x[slot];
    const z = this._z[slot];

    if (kind === KIND_CYLINDER) {
      const r = this._radius[slot];
      out.minX = x - r;
      out.maxX = x + r;
      out.minZ = z - r;
      out.maxZ = z + r;
      return out;
    }

    if (kind === KIND_POLY) {
      const pts = this._polyPoints[slot];
      if (!pts || pts.length === 0) {
        out.minX = out.maxX = x;
        out.minZ = out.maxZ = z;
        return out;
      }
      const facing = this._facing[slot];
      const cosF = Math.cos(facing);
      const sinF = Math.sin(facing);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        const px = pts[i];
        const pz = pts[i + 1];
        const wx = x + (px * cosF - pz * sinF);
        const wz = z + (px * sinF + pz * cosF);
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
      }
      out.minX = minX;
      out.maxX = maxX;
      out.minZ = minZ;
      out.maxZ = maxZ;
      return out;
    }

    // 'box' (default): rotate the half-extents by `facing` and take the
    // enclosing AABB — the standard OBB -> AABB formula.
    const halfW = this._halfW[slot];
    const halfL = this._halfL[slot];
    const facing = this._facing[slot];
    const cosF = Math.cos(facing);
    const sinF = Math.sin(facing);
    const effHalfX = Math.abs(halfW * cosF) + Math.abs(halfL * sinF);
    const effHalfZ = Math.abs(halfW * sinF) + Math.abs(halfL * cosF);
    out.minX = x - effHalfX;
    out.maxX = x + effHalfX;
    out.minZ = z - effHalfZ;
    out.maxZ = z + effHalfZ;
    return out;
  }

  /**
   * The one real hashing pass: gathers every alive static's AABB, in
   * ascending-handle order, and hands them to `UniformGrid.rebuild()`. Call
   * once per zone (`02-api-contracts.md` §4) — never from `fixedUpdate`
   * (`Fixed: N`).
   */
  rebuild() {
    const n = this._count;
    const alive = this._alive;

    const handles = new Int32Array(this._aliveCount);
    const minX = new Float64Array(this._aliveCount);
    const minZ = new Float64Array(this._aliveCount);
    const maxX = new Float64Array(this._aliveCount);
    const maxZ = new Float64Array(this._aliveCount);

    let w = 0;
    for (let slot = 0; slot < n; slot++) {
      if (!alive[slot]) continue;
      const aabb = this._aabbOf(slot);
      handles[w] = slot + 1;
      minX[w] = aabb.minX;
      minZ[w] = aabb.minZ;
      maxX[w] = aabb.maxX;
      maxZ[w] = aabb.maxZ;
      w++;
    }

    this._grid.rebuild(handles, minX, minZ, maxX, maxZ);
    this._stats.cells = this._grid.cellCount;
  }

  /**
   * Metres, floor height at `(x, z)`; `-Infinity` off-map
   * (`02-api-contracts.md` §4 — `nav.snap` and spawn placement branch on
   * this exact sentinel). "Off-map" means: no zone has ever emitted
   * `zone:ready` yet, or `(x, z)` falls outside the `bounds` that event
   * carried.
   *
   * PHYS-1 owns the static grid, not a terrain heightfield — `world` (not
   * yet implemented) is what will eventually vary this across ramps and
   * terraces; until then this returns a flat `0` anywhere inside the known
   * zone bounds. See this ticket's report for why that is the documented,
   * deliberate placeholder rather than a guess at unspecified terrain data.
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  groundHeight(x, z) {
    const b = this._bounds;
    if (!b) return -Infinity;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return -Infinity;
    return 0;
  }

  /** @param {boolean} on */
  setDebugDraw(on) {
    this._debugDraw = !!on;
  }

  // ---------------------------------------------------------------------
  // Bodies (PHYS-2) — thin forwards into BodyStore; see this file's header.
  // ---------------------------------------------------------------------

  /** `02-api-contracts.md` §4: `addBody(actorId, x, z, radius, height,
   * mass, layer) => int bodyId`. `0` when the fixed-capacity body store
   * (see `body.js`) is full.
   * @returns {number} */
  addBody(actorId, x, z, radius, height, mass, layer) {
    const bodyId = this._bodies.add(actorId, x, z, radius, height, mass, layer);
    this._stats.bodies = this._bodies.aliveCount;
    return bodyId;
  }

  /** `02-api-contracts.md` §4: `removeBody(bodyId) => void`. */
  removeBody(bodyId) {
    this._bodies.remove(bodyId);
    this._stats.bodies = this._bodies.aliveCount;
  }

  /** `02-api-contracts.md` §4: `setBody(bodyId, x, z) => void`. */
  setBody(bodyId, x, z) {
    this._bodies.setBody(bodyId, x, z);
  }

  /** `02-api-contracts.md` §4: `moveBody(bodyId, dx, dz, out?) => MoveResult`
   * — slide + step against static geometry. See `body.js` for the
   * algorithm. `out`, when given, receives the write directly and the
   * 32-deep ring is left untouched (per the contract's own `out`-parameter
   * rule); omitted, the next ring slot is used.
   * @returns {{x:number,z:number,blocked:boolean,slid:boolean,hitStatic:number,hitActorId:number}} */
  moveBody(bodyId, dx, dz, out) {
    return this._bodies.moveBody(bodyId, dx, dz, this._staticsSource, out);
  }

  /** `02-api-contracts.md` §4: `setBodyFlags(bodyId, flags) => void` —
   * `flags` is the `BODY_FLAG` bitfield (`noCollide`, `flying`). */
  setBodyFlags(bodyId, flags) {
    this._bodies.setBodyFlags(bodyId, flags);
  }

  /** `{ statics, bodies, cells, casts, separationMs }` — `bodies`, `casts`,
   * `separationMs` are honest zeros here (PHYS-2/3/4 own them); `statics`
   * and `cells` are real and live-updated by `addStatic`/`removeStatic`/
   * `rebuild`. Returns the same object every call (Alloc: no) — mutate in
   * place, never reallocate, matching `render.stats`'s own convention. */
  get stats() {
    return this._stats;
  }
}
