// src/physics/body.js
//
// PHYS-2 — bodies (actor-carrying circles on the XZ plane) and `moveBody`'s
// slide + step collision resolution against PHYS-1's static footprints.
// `docs/spec/02-api-contracts.md` §4's five body methods:
// `addBody`/`removeBody`/`setBody`/`moveBody`/`setBodyFlags`. All five are
// `Fixed: Y, Alloc: no` — this file is where that no-allocation contract is
// actually earned; `src/physics/index.js` only forwards calls into
// `BodyStore` below and keeps `stats.bodies` in sync.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file
// (`ARCHITECTURE.md`'s "runs headless in Node" — `tools/mapgen.mjs`, M5,
// exercises `physics` without ever loading `three`).
//
// ---------------------------------------------------------------------------
// Why this file never imports src/physics/index.js
// ---------------------------------------------------------------------------
// `index.js` imports `BodyStore` from here, not the other way around — a
// circular import between the two files would work in practice (ESM
// tolerates cycles as long as nothing is used before it is defined) but it
// is exactly the kind of coupling `ARCHITECTURE.md` rule 2 warns against one
// level down: "never import another subsystem's module... get it at
// runtime." `BodyStore.moveBody` needs PHYS-1's static storage (the grid and
// the per-footprint SoA arrays) to resolve a collision, so `index.js` hands
// it a small duck-typed `StaticsSource` object (see below) instead — the
// same pattern PHYS-1's own `_footprintFromNode` already uses for
// `THREE.Object3D` (duck-type what you're handed, never import the type).
// That keeps `BodyStore` reusable and independently testable (this ticket's
// own tests build a minimal `StaticsSource` stub without touching
// `PhysicsSystem` at all) and keeps the file-ownership boundary honest:
// `index.js` "only exposes the new methods", every collision behaviour
// change happens in this file.
//
// ---------------------------------------------------------------------------
// StaticsSource — the duck-typed view of PHYS-1's storage this file reads
// ---------------------------------------------------------------------------
// {
//   grid: UniformGrid,                 // PHYS-1's rebuilt static grid
//   kindCode: Uint8Array,              // KIND_BOX(0) | KIND_CYLINDER(1) | KIND_POLY(2), per slot — see the note by those constants below for why this file redeclares them instead of importing index.js's copy
//   x, z, y, height: Float64Array,     // Footprint fields, per slot (world space)
//   halfW, halfL, radius, facing: Float64Array,
//   polyPoints: (Float32Array|null)[], // 'poly' kind only
//   alive: Uint8Array,
// }
// Every array is indexed by "slot" = handle - 1, exactly PHYS-1's own
// convention (`src/physics/index.js`'s `addStatic`/`removeStatic`).
//
// ---------------------------------------------------------------------------
// The collide-and-slide algorithm, in one paragraph
// ---------------------------------------------------------------------------
// Actors move a few centimetres per fixed step (60 Hz), never metres, so a
// full continuous time-of-impact sweep is not needed to get correct-looking
// sliding — the well-known simpler technique ("move to the target, then push
// the circle out along the Minimum Translation Vector of whatever it now
// overlaps, repeat a few times") produces identical *visible* behaviour at
// these step sizes and is dramatically simpler to get right across three
// footprint shapes. The key fact that makes this "slide" rather than "stop":
// the MTV push is perpendicular to the surface, so it only ever cancels the
// *normal* component of the attempted move — the tangential (along-the-wall)
// component survives untouched. Called every fixed step, the body keeps
// making tangential progress every tick while the normal component keeps
// getting cancelled, which *is* sliding along the wall. Iterating the push
// 2-4 times per call (`MAX_RESOLVE_ITERATIONS`) is what makes an inner
// corner (two walls at once) converge toward the corner point instead of
// tunnelling through one wall while escaping the other — see the
// `MAX_RESOLVE_ITERATIONS` comment and the ticket report for the reasoning
// and the corner test this claim is checked against.
//
// ---------------------------------------------------------------------------
// The step — a body's untracked vertical "footing"
// ---------------------------------------------------------------------------
// `addBody`'s signature carries no `y` — `02-api-contracts.md` §4 gives
// bodies a `height` (the vertical extent, for the interval test against a
// `Footprint`'s own `[y, y+height)`) but no stored vertical position, and
// there is no `setBodyY`. Yet "step" only means something *relative to where
// the body currently stands* (the ticket brief: "шагнуть можно только если
// верх препятствия ниже порога шага относительно текущей опоры тела"). So
// this file tracks one number per body that the public contract never
// exposes: `_floorY`, the height of whatever the body is currently standing
// on. Assigned, absent from spec (this ticket's report calls this D1):
//   - A fresh body's floor defaults to `DEFAULT_FLOOR_Y` (0) — there is no
//     terrain heightfield yet (`PHYS-1`'s own `groundHeight` is a flat `0`
//     placeholder within zone bounds; see `index.js`), so 0 is the one
//     consistent baseline to start from.
//   - Every `moveBody` call recomputes it from scratch at the *final*
//     resolved (x, z): the tallest steppable static (see `STEP_HEIGHT_MAX`
//     below) whose footprint the body ends up over, or back to
//     `DEFAULT_FLOOR_Y` if it is over none. There is no falling/gravity
//     simulation (`ARCHITECTURE.md`: "no 3D rigid-body solver... and there
//     will not be one") — stepping down off a ledge snaps instantly rather
//     than animating a fall, which is a presentation concern for a later
//     ticket (`actors`/`ai`), not a physics one.
//   - `setBody` (a teleport-style jump, not a per-step delta) resets the
//     floor back to `DEFAULT_FLOOR_Y` — a teleport has no "coming from"
//     footing to preserve.
//
// ---------------------------------------------------------------------------
// `flying` — assigned here since the spec leaves it open (report calls this D3)
// ---------------------------------------------------------------------------
// A flying body does not use `_floorY`/step tracking at all: it cruises at a
// fixed altitude (`FLY_ALTITUDE`, assigned below) and is tested against
// statics with the *same* vertical-interval logic ground bodies use, just
// anchored at that fixed altitude instead of a tracked, updating floor. The
// concrete effect: a flying body glides over anything short enough that its
// top sits at or below `FLY_ALTITUDE + STEP_HEIGHT_MAX` (rubble, kerbs, low
// walls — exactly the kind of geometry `07-world-gen.md`'s `KERBS` describes
// as "0.45 m... below the 1.00 m free height") while a real wall (the
// default `Footprint.height` is 3.0 m) still reaches into the flying band
// and blocks it, same as it blocks a walking body. This reuses the ground
// body's own classification function with a different floor input rather
// than inventing a second code path, and deliberately does not touch
// `Footprint.blocksSight`/`blocksNav` — those fields are `world`'s and mean
// something else (line-of-sight and nav-mesh carving) that this ticket does
// not own and should not repurpose.
//
// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------
// Every SoA array here is sized ONCE, to a fixed `capacity`, in the
// `BodyStore` constructor (construction time — never inside a method the
// contract marks `Alloc: no`). `addBody` cannot grow the arrays the way
// PHYS-1's `addStatic` grows its own (that one is `Alloc: yes`, a zone-load
// operation; bodies come and go constantly during live play as monsters
// spawn/despawn — `11-flows.md`'s boot table literally says "body arrays
// sized `q.maxActors`"). Removed bodies go on a fixed-size free-list
// (`_freeSlots`, a preallocated `Int32Array` used as a stack) so `addBody`
// after a `removeBody` reuses a slot instead of needing a new one — this
// also means a `bodyId` CAN be reused after `removeBody`; nothing here adds
// a generation counter (not in the contract, and out of this ticket's
// scope) — a caller must not hold a `bodyId` across a despawn/respawn
// boundary without re-fetching it, the same discipline `02-api-contracts.md`
// already asks of an `ActorRef` (see `moveBody`'s own JSDoc and the ticket
// report). Every scratch buffer `moveBody` touches (`_candidateSlots`,
// `_candidateClass`, `_scratchPen`, `_scratchPoly`) is likewise allocated
// once here and reused by every call — see each field's own comment.

/** The one number the acceptance criterion actually gives:
 * "капсула... поднимается на уступ 0.45 м" / `docs/BACKLOG.md`'s PHYS-2 row
 * ("steps a 0.45 m ledge"). A static is climbable from a body's current
 * footing when its top sits at or below `footing + STEP_HEIGHT_MAX`. */
export const STEP_HEIGHT_MAX = 0.45;

/** Assigned, absent from spec — see the "flying" section above. A flying
 * body's fixed cruise altitude: comfortably above the height a ground body
 * can already step over unassisted (`STEP_HEIGHT_MAX`) so flying reads as a
 * genuinely different capability, and comfortably below the default
 * `Footprint.height` (3.0 m, `src/physics/index.js`'s `FOOTPRINT_DEFAULTS`)
 * so an ordinary wall still blocks a flying body exactly like it blocks a
 * walking one. */
export const FLY_ALTITUDE = 2.2;

/** Assigned, absent from spec — the baseline floor a body starts on and
 * falls back to when it is not standing over any steppable static. See the
 * "untracked vertical footing" section above. */
export const DEFAULT_FLOOR_Y = 0;

/** Assigned, absent from spec — how many times `moveBody` re-resolves
 * overlap against the (fixed, pre-classified) candidate set per call. One
 * pass handles a single wall (find the deepest overlap, push out along its
 * normal). An inner corner needs at least two: pass 1 resolves against
 * whichever of the two walls is currently deeper-penetrated, which can
 * create or deepen overlap with the *other* wall; pass 2 resolves that one.
 * A shallow, near-tangent approach into a corner can still be mid-converging
 * after two passes, so this is set to 4 for headroom — the ticket's own
 * corner test asserts the result never ends up on the wrong side of either
 * wall's surface after a `moveBody` call, which is the property that
 * actually matters (an exact corner-point solution is not required; a
 * residual sub-millimetre penetration left for the *next* fixed step to
 * finish resolving is harmless and imperceptible at 60 Hz). */
export const MAX_RESOLVE_ITERATIONS = 4;

/** Assigned, absent from spec — the extra push past exact contact after a
 * depenetration, so two shapes just resolved don't immediately re-report as
 * (barely) overlapping from float rounding on the very next penetration
 * test within the same `moveBody` call. Far smaller than anything visible
 * or gameplay-relevant. */
const SKIN_WIDTH = 1e-4;

/** Assigned, absent from spec — the minimum net displacement (start to
 * final resolved position) for a blocked `moveBody` call to also report
 * `slid: true`. Below this, the call is reported as blocked-but-not-sliding
 * (a body driven straight into a flat wall, or straight into the bisector
 * of a symmetric inner corner, legitimately makes ~zero net progress). */
const SLID_EPSILON = 1e-6;

/** Assigned, absent from spec — how far around a body's swept segment
 * (start -> attempted target) `moveBody` gathers static candidates from the
 * grid, on top of `radius` and half the segment length. Generous enough
 * that the handful of `MAX_RESOLVE_ITERATIONS` depenetration pushes (each
 * bounded by the overlap depth they're correcting, which is itself bounded
 * by body radius + how far a single fixed step moves) stays inside the
 * gathered set; see the ticket report for why re-gathering per iteration
 * was judged unnecessary at this game's step sizes. */
const GATHER_PAD = 0.5;

/** Fixed cap on how many (footprint, cell) candidate hits a single
 * `moveBody` call collects before resolving. A footprint spanning several
 * cells is counted once per cell it's hashed into (the same "entries, not
 * distinct handles" accounting `grid.js` uses for `entryCount`), so this is
 * deliberately generous relative to what a body's small gather radius
 * (`GATHER_PAD` above) realistically ever touches — a few cells' worth of
 * geometry. Assigned, absent from spec; exceeding it silently drops the
 * furthest-discovered extras rather than growing (this method is
 * `Alloc: no`), the same "budget, not a spike" philosophy `nav`'s
 * `pathsPerStep` uses elsewhere in this contract. */
const CANDIDATE_CAPACITY = 64;

/** `Hit`/`MoveResult` records "come from a 32-deep ring" —
 * `02-api-contracts.md` §4, verbatim and exact (not "assigned"). Only
 * `MoveResult` is this ticket's concern; `Hit`'s ring belongs to whichever
 * PHYS-3 cast first needs it. */
export const MOVE_RESULT_RING_SIZE = 32;

/** `setBodyFlags(bodyId, flags)`'s bitfield — `02-api-contracts.md` §4 names
 * the two flags ("noCollide, flying") but not their bit values; assigned
 * here (a plain two-bit field, `NONE` for clarity when a caller clears
 * both). Not part of the `ctx.get('physics')` instance contract (`LAYER`/
 * `MASK` are, per that same table row — `BODY_FLAG` is not listed there),
 * so this is a named export callers of `setBodyFlags` import directly,
 * exactly like `FOOTPRINT_DEFAULTS` is a named export of `index.js` without
 * being an instance property either. */
export const BODY_FLAG = Object.freeze({
  NONE: 0,
  NO_COLLIDE: 1,
  FLYING: 2,
});

/** Assigned, absent from spec — the fallback body-array capacity used when
 * no `ctx.config.q.maxActors` is available at `PhysicsSystem.init()` (e.g. a
 * minimal test `ctx`, same shape PHYS-1's own `tests/physics/phys1.test.js`
 * already uses). Set to the largest defined preset (`ultra`, 56 —
 * `src/core/config.js`) rather than an arbitrary round number, so the
 * fallback is itself a real, spec'd figure. `src/physics/index.js` replaces
 * this with the real `q.maxActors`-sized store as soon as a real `ctx` with
 * a `config` is available. */
export const DEFAULT_MAX_BODIES = 56;

/** Mirrors `src/physics/index.js`'s private `KIND_BOX`/`KIND_CYLINDER`/
 * `KIND_POLY` numbering. Not imported from there (see the file header for
 * why) — duplicated as a small, stable pair of constant tables instead: both
 * files derive them from the same source, `Footprint.kind`'s fixed
 * `'box' | 'cylinder' | 'poly'` union in `02-api-contracts.md` §4, so the
 * two numberings can never drift independently of a spec change either file
 * would have to follow anyway. */
const KIND_BOX = 0;
const KIND_CYLINDER = 1;
const KIND_POLY = 2;

// ---------------------------------------------------------------------------
// Geometry — circle vs. one footprint shape, all allocation-free
// ---------------------------------------------------------------------------
// Every test below writes its result into a caller-owned scratch object
// (`{ depth, nx, nz }`, `nx`/`nz` unit length pointing FROM the shape's
// surface TOWARD the circle centre — i.e. the direction that separates
// them) and returns that same object, or returns `null` for "no overlap".
// This is exactly PHYS-1's own `_aabbOf` convention (`src/physics/index.js`)
// applied to penetration tests instead of AABBs.

/**
 * Circle (body) vs. circle (a 'cylinder' footprint, on the XZ plane).
 * @param {number} cx @param {number} cz @param {number} radius
 * @param {number} ox @param {number} oz @param {number} oradius
 * @param {{depth:number,nx:number,nz:number}} scratch
 * @returns {{depth:number,nx:number,nz:number} | null}
 */
function circleVsCircle(cx, cz, radius, ox, oz, oradius, scratch) {
  const dx = cx - ox;
  const dz = cz - oz;
  const rsum = radius + oradius;
  const distSq = dx * dx + dz * dz;
  if (distSq >= rsum * rsum) return null;
  const dist = Math.sqrt(distSq);
  if (dist < 1e-9) {
    // Degenerate: coincident centres. Any direction separates them equally —
    // pick +X so the result is at least deterministic, never NaN.
    scratch.nx = 1;
    scratch.nz = 0;
    scratch.depth = rsum;
    return scratch;
  }
  scratch.nx = dx / dist;
  scratch.nz = dz / dist;
  scratch.depth = rsum - dist;
  return scratch;
}

/**
 * Circle vs. a convex polygon (CCW winding), on the XZ plane. Standard
 * "maximum separating edge" technique (the one Box2D's circle/polygon
 * collider uses): for a convex shape the globally closest feature to an
 * external point is always associated with the edge whose outward-normal
 * signed distance to the point is largest, whether the true closest point
 * ends up being that edge's segment interior or one of its clamped
 * endpoints — so a single pass over the edges, followed by one clamped
 * closest-point computation against just that edge, is exact (not an
 * approximation) for any convex polygon, inside or outside.
 *
 * `pts` is a flat, world-space, CCW point list (`x0,z0, x1,z1, ...`);
 * `n` is the point count (3..8 per `Footprint.points`' own limit, but this
 * function does not itself enforce that — it works for any n >= 3).
 *
 * @param {number} cx @param {number} cz @param {number} radius
 * @param {Float64Array} pts
 * @param {number} n
 * @param {{depth:number,nx:number,nz:number}} scratch
 * @returns {{depth:number,nx:number,nz:number} | null}
 */
function circleVsConvexPolygon(cx, cz, radius, pts, n, scratch) {
  let maxDist = -Infinity;
  let refI = 0;
  let refNx = 0;
  let refNz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i * 2];
    const z0 = pts[i * 2 + 1];
    const x1 = pts[j * 2];
    const z1 = pts[j * 2 + 1];
    const ex = x1 - x0;
    const ez = z1 - z0;
    // `Math.sqrt(ex*ex+ez*ez)`, not `Math.hypot` — V8's `Math.hypot` uses an
    // extended-precision summation internally that allocates on this
    // engine/Node build (confirmed empirically while chasing this ticket's
    // `12.A01` gate; see the report), which a `Fixed: Y, Alloc: no` hot path
    // cannot afford. `ex`/`ez` here are ordinary metre-scale footprint
    // coordinates, nowhere near the subnormal/overflow range `Math.hypot`'s
    // extra precision exists for, so the plain formula is exact enough.
    const len = Math.sqrt(ex * ex + ez * ez);
    if (len < 1e-9) continue; // degenerate (duplicate) vertex pair — skip
    const nx = ez / len;
    const nz = -ex / len; // outward unit normal for a CCW polygon (see module tests)
    const dist = (cx - x0) * nx + (cz - z0) * nz;
    if (dist > maxDist) {
      maxDist = dist;
      refI = i;
      refNx = nx;
      refNz = nz;
    }
  }
  if (maxDist === -Infinity) return null; // every edge degenerate — nothing to collide with
  if (maxDist > radius) return null; // SAT: separated along the best edge normal

  if (maxDist <= 0) {
    // Circle centre is inside the polygon (every edge's signed distance is
    // <= 0, and this is the largest, i.e. least-negative, one) — push out
    // along the nearest edge's outward normal by the full penetration:
    // how far inside (-maxDist) plus the full radius.
    scratch.nx = refNx;
    scratch.nz = refNz;
    scratch.depth = radius - maxDist;
    return scratch;
  }

  // Centre is outside the polygon; the true closest point is somewhere on
  // (or clamped to the ends of) the reference edge's segment.
  const j = (refI + 1) % n;
  const x0 = pts[refI * 2];
  const z0 = pts[refI * 2 + 1];
  const x1 = pts[j * 2];
  const z1 = pts[j * 2 + 1];
  const ex = x1 - x0;
  const ez = z1 - z0;
  const lenSq = ex * ex + ez * ez;
  let t = lenSq > 1e-12 ? ((cx - x0) * ex + (cz - z0) * ez) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = x0 + ex * t;
  const pz = z0 + ez * t;
  const dx = cx - px;
  const dz = cz - pz;
  const distSq = dx * dx + dz * dz;
  if (distSq >= radius * radius) return null; // clamped point is beyond radius after all
  const dist = Math.sqrt(distSq);
  if (dist < 1e-9) {
    // Centre sits exactly on the boundary — fall back to the edge normal.
    scratch.nx = refNx;
    scratch.nz = refNz;
    scratch.depth = radius;
    return scratch;
  }
  scratch.nx = dx / dist;
  scratch.nz = dz / dist;
  scratch.depth = radius - dist;
  return scratch;
}

// ---------------------------------------------------------------------------
// BodyStore
// ---------------------------------------------------------------------------

export class BodyStore {
  /** @param {number} [capacity] fixed, never grown — see the file header's
   * "Allocation" section. */
  constructor(capacity = DEFAULT_MAX_BODIES) {
    this._capacity = capacity;
    this._aliveCount = 0;
    /** Next never-yet-used slot, handed out before the free-list is ever
     * drawn from — mirrors PHYS-1's own monotonic `_count`, except capped
     * at `capacity` (bodies must recycle via `_freeSlots` past that). */
    this._nextSlot = 0;

    this._actorId = new Int32Array(capacity);
    this._x = new Float64Array(capacity);
    this._z = new Float64Array(capacity);
    this._radius = new Float64Array(capacity);
    this._height = new Float64Array(capacity);
    this._mass = new Float64Array(capacity);
    this._layer = new Int32Array(capacity);
    this._flags = new Int32Array(capacity);
    /** The untracked "current footing" — see the file header. */
    this._floorY = new Float64Array(capacity);
    this._alive = new Uint8Array(capacity);

    /** Free-list stack of reclaimed slots, preallocated to `capacity` (the
     * worst case: every body ever added is now removed). `_freeCount` is
     * the stack depth. */
    this._freeSlots = new Int32Array(capacity);
    this._freeCount = 0;

    // --- moveBody scratch state — allocated once, reused by every call ---
    /** Candidate static handles gathered from the grid this call. */
    this._candidateSlots = new Int32Array(CANDIDATE_CAPACITY);
    /** Parallel classification per candidate: 0 = ignore (dead / overhead),
     * 1 = blocking, 2 = steppable. Computed once per `moveBody` call (see
     * `_classifyCandidates`), read by both the depenetration loop and the
     * floor-update pass that follows it. */
    this._candidateClass = new Uint8Array(CANDIDATE_CAPACITY);
    this._candidateCount = 0;
    /** Bound exactly once (not per call/gather) — the `UniformGrid.
     * forEachInCell` callback. Reusing this exact function reference across
     * every call is what keeps `_gatherCandidates` allocation-free; a fresh
     * arrow function per call would be a closure allocation every
     * `moveBody`. Mutates `_candidateSlots`/`_candidateCount` directly. */
    this._collectCandidate = (handle) => {
      if (this._candidateCount < CANDIDATE_CAPACITY) {
        this._candidateSlots[this._candidateCount++] = handle;
      }
    };

    /** Reused output of every penetration test — see the geometry
     * functions' own header comment. `moveBody`'s own depenetration scan
     * (the "deepest overlap so far" accumulator) deliberately does NOT use
     * a second reused object the way this one is reused across candidates
     * within a single `_penetration` call — see `moveBody`'s own comment on
     * why that scan uses plain local numbers instead, once
     * `MAX_RESOLVE_ITERATIONS` is more than one iteration deep. */
    this._scratchPen = { depth: 0, nx: 0, nz: 0 };
    /** Reused world-space point buffer for box (4 pts) / poly (<= 8 pts)
     * penetration tests — 8 points * 2 numbers, the spec's own upper bound
     * on `Footprint.points`. */
    this._scratchPoly = new Float64Array(16);

    /** The 32-deep `MoveResult` ring, `02-api-contracts.md` §4 verbatim.
     * Preallocated once; `moveBody` never allocates a fresh record. */
    this._resultRing = [];
    for (let i = 0; i < MOVE_RESULT_RING_SIZE; i++) {
      this._resultRing.push({ x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 });
    }
    this._resultRingIndex = 0;
  }

  /** Fixed capacity this store was constructed with. */
  get capacity() {
    return this._capacity;
  }

  /** Live body count — mirrors PHYS-1's `stats.statics` convention; `index.
   * js` copies this into `stats.bodies` after every add/remove. */
  get aliveCount() {
    return this._aliveCount;
  }

  /** @private @returns {number} the next ring slot, advancing the cursor. */
  _nextRingResult() {
    const r = this._resultRing[this._resultRingIndex];
    this._resultRingIndex = (this._resultRingIndex + 1) % MOVE_RESULT_RING_SIZE;
    return r;
  }

  /**
   * `02-api-contracts.md` §4: `addBody(actorId, x, z, radius, height, mass,
   * layer) => int`. Returns `0` (the reserved "no handle" sentinel, the
   * same convention `nav.requestPath`/`world.portalAt` use elsewhere in
   * this contract) when the fixed capacity is exhausted — this method is
   * `Alloc: no`, so it cannot grow to make room.
   * @returns {number}
   */
  add(actorId, x, z, radius, height, mass, layer) {
    let slot;
    if (this._freeCount > 0) {
      slot = this._freeSlots[--this._freeCount];
    } else if (this._nextSlot < this._capacity) {
      slot = this._nextSlot++;
    } else {
      return 0; // capacity exhausted
    }

    this._actorId[slot] = actorId;
    this._x[slot] = x;
    this._z[slot] = z;
    this._radius[slot] = radius;
    this._height[slot] = height;
    this._mass[slot] = mass;
    this._layer[slot] = layer;
    this._flags[slot] = BODY_FLAG.NONE;
    this._floorY[slot] = DEFAULT_FLOOR_Y;
    this._alive[slot] = 1;

    this._aliveCount++;
    return slot + 1; // 1-based handle, PHYS-1's own convention
  }

  /** `02-api-contracts.md` §4: `removeBody(bodyId) => void`. A stale/dead/
   * unknown handle is a safe no-op — matches `removeStatic`'s own contract
   * (`tests/physics/phys1.test.js`). */
  remove(bodyId) {
    const slot = bodyId - 1;
    if (slot < 0 || slot >= this._nextSlot) return;
    if (!this._alive[slot]) return;
    this._alive[slot] = 0;
    this._freeSlots[this._freeCount++] = slot;
    this._aliveCount--;
  }

  /** `02-api-contracts.md` §4: `setBody(bodyId, x, z) => void` — a direct
   * teleport-style jump (not a per-step delta; that's `moveBody`), so it
   * resets the tracked footing rather than trying to infer one. Safe no-op
   * on a stale/dead/unknown handle. */
  setBody(bodyId, x, z) {
    const slot = bodyId - 1;
    if (slot < 0 || slot >= this._nextSlot || !this._alive[slot]) return;
    this._x[slot] = x;
    this._z[slot] = z;
    this._floorY[slot] = DEFAULT_FLOOR_Y;
  }

  /** `02-api-contracts.md` §4: `setBodyFlags(bodyId, flags) => void` —
   * `flags` is the raw `BODY_FLAG` bitfield. Safe no-op on a stale/dead/
   * unknown handle. */
  setBodyFlags(bodyId, flags) {
    const slot = bodyId - 1;
    if (slot < 0 || slot >= this._nextSlot || !this._alive[slot]) return;
    this._flags[slot] = flags;
  }

  /**
   * Gathers every static handle hashed into a cell overlapping the disc
   * `(cx, cz, radius)` into `_candidateSlots` (duplicates possible — a
   * footprint spanning several cells is collected once per cell, exactly
   * `grid.js`'s own `entryCount` accounting; harmless here, see
   * `CANDIDATE_CAPACITY`'s comment). Allocation-free: `_collectCandidate` is
   * the one callback instance, bound once in the constructor.
   * @private
   * @param {object} source `StaticsSource`
   */
  _gatherCandidates(source, cx, cz, radius) {
    this._candidateCount = 0;
    const grid = source.grid;
    const minCx = grid.cellIndexX(cx - radius);
    const maxCx = grid.cellIndexX(cx + radius);
    const minCz = grid.cellIndexZ(cz - radius);
    const maxCz = grid.cellIndexZ(cz + radius);
    for (let gx = minCx; gx <= maxCx; gx++) {
      for (let gz = minCz; gz <= maxCz; gz++) {
        grid.forEachInCell(gx, gz, this._collectCandidate);
      }
    }
  }

  /**
   * Classifies every gathered candidate exactly once per `moveBody` call
   * (the inputs — `floorY`, `bodyHeight`, `flying` — are fixed for the
   * whole call, so this never needs to re-run per depenetration iteration;
   * only the geometric penetration test, which depends on the body's
   * current x/z, needs to re-run). Writes into `_candidateClass`, parallel
   * to `_candidateSlots`.
   *
   * `0` = ignore (dead, or the static's whole vertical interval sits above
   *       the body's head — walk under it).
   * `1` = blocking (participates in `moveBody`'s depenetration loop).
   * `2` = steppable (participates in `_updateFloor`'s floor recompute, not
   *       in blocking — this is the actual "step" behaviour: a steppable
   *       static causes zero horizontal impedance).
   * @private
   * @param {object} source `StaticsSource`
   * @param {number} floorY the footing this test is relative to (a ground
   *   body's tracked `_floorY`, or `FLY_ALTITUDE` for a flying body).
   * @param {number} bodyHeight
   */
  _classifyCandidates(source, floorY, bodyHeight) {
    const n = this._candidateCount;
    const alive = source.alive;
    const y = source.y;
    const height = source.height;
    for (let i = 0; i < n; i++) {
      const slot = this._candidateSlots[i] - 1;
      let cls = 0;
      if (alive[slot]) {
        const bottom = y[slot];
        const top = bottom + height[slot];
        if (bottom >= floorY + bodyHeight) {
          cls = 0; // entirely above the body's head — walk under it
        } else {
          const climb = top - floorY;
          cls = climb <= STEP_HEIGHT_MAX ? 2 : 1;
        }
      }
      this._candidateClass[i] = cls;
    }
  }

  /**
   * One footprint's penetration against the circle `(cx, cz, radius)`,
   * dispatched by shape. Returns `this._scratchPen` (mutated) or `null`.
   * @private
   * @param {object} source `StaticsSource`
   * @param {number} slot
   */
  _penetration(source, slot, cx, cz, radius) {
    const kind = source.kindCode[slot];
    if (kind === KIND_CYLINDER) {
      return circleVsCircle(cx, cz, radius, source.x[slot], source.z[slot], source.radius[slot], this._scratchPen);
    }
    if (kind === KIND_BOX) {
      const x = source.x[slot];
      const z = source.z[slot];
      const halfW = source.halfW[slot];
      const halfL = source.halfL[slot];
      const facing = source.facing[slot];
      const cosF = Math.cos(facing);
      const sinF = Math.sin(facing);
      // CCW local corners (verified against the outward-normal formula in
      // `circleVsConvexPolygon`'s own tests): (+W,+L) -> (-W,+L) -> (-W,-L)
      // -> (+W,-L), rotated by `facing` then translated to world space —
      // the same rotation `src/physics/index.js`'s `_aabbOf` uses for its
      // own box/poly AABB pass.
      const poly = this._scratchPoly;
      poly[0] = x + (halfW * cosF - halfL * sinF);
      poly[1] = z + (halfW * sinF + halfL * cosF);
      poly[2] = x + (-halfW * cosF - halfL * sinF);
      poly[3] = z + (-halfW * sinF + halfL * cosF);
      poly[4] = x + (-halfW * cosF + halfL * sinF);
      poly[5] = z + (-halfW * sinF - halfL * cosF);
      poly[6] = x + (halfW * cosF + halfL * sinF);
      poly[7] = z + (halfW * sinF - halfL * cosF);
      return circleVsConvexPolygon(cx, cz, radius, poly, 4, this._scratchPen);
    }
    // KIND_POLY
    const pts = source.polyPoints[slot];
    if (!pts || pts.length < 6) return null; // degenerate/absent — no collider
    const n = pts.length >> 1;
    const x = source.x[slot];
    const z = source.z[slot];
    const facing = source.facing[slot];
    const cosF = Math.cos(facing);
    const sinF = Math.sin(facing);
    const poly = this._scratchPoly;
    for (let i = 0; i < n; i++) {
      const lx = pts[i * 2];
      const lz = pts[i * 2 + 1];
      poly[i * 2] = x + (lx * cosF - lz * sinF);
      poly[i * 2 + 1] = z + (lx * sinF + lz * cosF);
    }
    return circleVsConvexPolygon(cx, cz, radius, poly, n, this._scratchPen);
  }

  /**
   * Recomputes `_floorY[slot]` from the final resolved (x, z): the tallest
   * `cls === 2` (steppable) candidate whose footprint the body now overlaps
   * horizontally, or `DEFAULT_FLOOR_Y` if none. See the file header's
   * "untracked vertical footing" section.
   * @private
   */
  _updateFloor(source, slot, x, z) {
    const radius = this._radius[slot];
    let floor = DEFAULT_FLOOR_Y;
    const n = this._candidateCount;
    for (let i = 0; i < n; i++) {
      if (this._candidateClass[i] !== 2) continue;
      const handle = this._candidateSlots[i];
      const cslot = handle - 1;
      const pen = this._penetration(source, cslot, x, z, radius);
      if (!pen) continue;
      const top = source.y[cslot] + source.height[cslot];
      if (top > floor) floor = top;
    }
    this._floorY[slot] = floor;
  }

  /**
   * `02-api-contracts.md` §4: `moveBody(bodyId, dx, dz, out?) => MoveResult`
   * — slide + step. See the file header for the algorithm and the "step"/
   * "flying" sections for the vertical model. Writes into `out` if given
   * (the ring is never touched in that case, per the contract's own `out`-
   * parameter rule), otherwise into the next 32-deep ring slot.
   * @param {number} bodyId
   * @param {number} dx @param {number} dz
   * @param {object} source `StaticsSource`
   * @param {{x:number,z:number,blocked:boolean,slid:boolean,hitStatic:number,hitActorId:number}} [out]
   */
  moveBody(bodyId, dx, dz, source, out) {
    const result = out || this._nextRingResult();
    const slot = bodyId - 1;

    if (slot < 0 || slot >= this._nextSlot || !this._alive[slot]) {
      // Stale/unknown handle — a safe no-op result, same "don't throw on a
      // bad handle" discipline PHYS-1's removeStatic/etc. already use.
      result.x = 0;
      result.z = 0;
      result.blocked = false;
      result.slid = false;
      result.hitStatic = 0;
      result.hitActorId = 0;
      return result;
    }

    const flags = this._flags[slot];
    const startX = this._x[slot];
    const startZ = this._z[slot];

    if (flags & BODY_FLAG.NO_COLLIDE) {
      const x = startX + dx;
      const z = startZ + dz;
      this._x[slot] = x;
      this._z[slot] = z;
      result.x = x;
      result.z = z;
      result.blocked = false;
      result.slid = false;
      result.hitStatic = 0;
      result.hitActorId = 0;
      return result;
    }

    const radius = this._radius[slot];
    const bodyHeight = this._height[slot];
    const flying = (flags & BODY_FLAG.FLYING) !== 0;
    const floorY = flying ? FLY_ALTITUDE : this._floorY[slot];

    let x = startX + dx;
    let z = startZ + dz;

    const moveLen = Math.sqrt(dx * dx + dz * dz); // see the `Math.hypot` note in circleVsConvexPolygon above
    const midX = startX + dx * 0.5;
    const midZ = startZ + dz * 0.5;
    const gatherRadius = radius + moveLen * 0.5 + GATHER_PAD;
    this._gatherCandidates(source, midX, midZ, gatherRadius);
    this._classifyCandidates(source, floorY, bodyHeight);

    // Depenetration loop: each iteration finds the DEEPEST-overlapping
    // `cls === 1` (blocking) candidate at the body's current (x, z) and
    // pushes out along its normal — see the file header's "collide and
    // slide" section for why resolving the deepest overlap first is what
    // makes an inner corner converge instead of oscillating. This scan is
    // written inline, in plain local numbers (`bestDepth`/`bestNx`/`bestNz`/
    // `bestHandle`), rather than as a separate `_resolveDeepest(...)` method
    // returning `this._scratchPen`-style shared object. An earlier draft
    // factored it out exactly that way and it measured a real, reproducible
    // per-call heap allocation on this engine/Node build the moment this
    // outer loop ran a SECOND iteration (i.e. the same method called again
    // within one `moveBody`, its arguments depending on the previous call's
    // result) — chased down empirically for this ticket's `12.A01` gate; see
    // the report. Plain locals reproducibly measure at zero regardless of
    // iteration count.
    let blocked = false;
    let hitStatic = 0;
    for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
      let found = false;
      let bestDepth = 0;
      let bestNx = 0;
      let bestNz = 0;
      let bestHandle = 0;
      const n = this._candidateCount;
      for (let i = 0; i < n; i++) {
        if (this._candidateClass[i] !== 1) continue;
        const handle = this._candidateSlots[i];
        const pen = this._penetration(source, handle - 1, x, z, radius);
        if (!pen) continue;
        if (!found || pen.depth > bestDepth) {
          bestDepth = pen.depth;
          bestNx = pen.nx;
          bestNz = pen.nz;
          bestHandle = handle;
          found = true;
        }
      }
      if (!found) break;
      blocked = true;
      if (hitStatic === 0) hitStatic = bestHandle; // first (deepest-at-first-touch) static reported
      x += bestNx * (bestDepth + SKIN_WIDTH);
      z += bestNz * (bestDepth + SKIN_WIDTH);
    }

    let slid = false;
    if (blocked) {
      const ddx = x - startX;
      const ddz = z - startZ;
      const movedDist = Math.sqrt(ddx * ddx + ddz * ddz); // see the `Math.hypot` note above
      slid = movedDist > SLID_EPSILON;
    }

    if (!flying) this._updateFloor(source, slot, x, z);

    this._x[slot] = x;
    this._z[slot] = z;
    result.x = x;
    result.z = z;
    result.blocked = blocked;
    result.slid = slid;
    result.hitStatic = hitStatic;
    // Body-body collision is PHYS-4's `separate()`, not this ticket's
    // `moveBody` (the ticket brief is explicit: "moveBody решает
    // столкновения со статикой") — always 0 here.
    result.hitActorId = 0;
    return result;
  }
}
