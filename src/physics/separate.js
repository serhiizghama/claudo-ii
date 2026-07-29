// src/physics/separate.js
//
// PHYS-4 — separate(): the crowd push-out pass over all bodies
// (docs/spec/02-api-contracts.md §4: "one crowd push-out pass over all
// bodies", `Fixed: Y, Alloc: no`). `src/physics/index.js` only forwards the
// call into `SeparationSystem` below, per this ticket's brief ("index.js —
// wiring only") — the same narrow-forward precedent PHYS-2 used for
// `moveBody` (`body.js`) and PHYS-3 used for the seven casts (`cast.js`).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.
//
// ---------------------------------------------------------------------------
// Why this file reaches into `BodyStore`'s underscore-prefixed fields
// directly, instead of a duck-typed accessor
// ---------------------------------------------------------------------------
// `cast.js` (PHYS-3) already established the precedent this file follows:
// `CastSystem` keeps a reference to the whole `PhysicsSystem` instance and
// reads `phys._bodies._x` / `_alive` / `_layer` / `_radius` / `_actorId`
// fresh on every call rather than through a `StaticsSource`-style seam (see
// `cast.js`'s own header for the full reasoning — `BodyStore` has no
// standalone use case that would justify inventing one just for this
// ticket, and this ticket's brief is explicit that `index.js` gets wiring
// only). `SeparationSystem` extends that same convention one step further:
// it also *writes* `phys._bodies._x` / `_z` directly (the actual push-out),
// where `CastSystem` only ever reads. There is deliberately no new
// `BodyStore` method added for this (`body.js` is not in this ticket's file
// list — touching it would violate "own only the files listed above") and
// `BodyStore.setBody()` is the wrong tool for the job anyway: it is a
// teleport-style jump that resets the tracked `_floorY` footing
// (`body.js`'s own file header), and a crowd nudge mid-step must NOT reset a
// body's standing floor the way an actual teleport should — a body
// shouldered a few centimetres by a neighbour is still standing on whatever
// static it was standing on. Writing `_x`/`_z` directly, leaving `_floorY`
// alone, is the correct, minimal-side-effect operation.
//
// ---------------------------------------------------------------------------
// O-30 — the broadphase decision, measured, not guessed
// ---------------------------------------------------------------------------
// `docs/PROGRESS.md`'s O-30 entry (filed by PHYS-3 against this ticket) is
// explicit: the uniform grid (`grid.js`, PHYS-1) hashes STATICS only, there
// is no spatial index over bodies anywhere in `src/physics/`, and
// `separate()` is pairwise — a naive scan is O(bodies^2), unlike the casts'
// O(bodies) linear scan that D-1 already accepted at `q.maxActors` (24-56).
// This ticket's own acceptance criterion is 40 bodies in a 6 m circle inside
// a 0.4 ms budget, i.e. up to C(40,2) = 780 unordered pairs per pass.
//
// Decision: a plain nested loop over the fixed-capacity body array (ascending
// slot order both ways — see "Determinism" below), NOT a body-side uniform
// grid. Measured directly (see `tests/physics/phys4.test.js`'s own
// `12.A01`-style timing assertions and this ticket's report for the actual
// numbers, five runs): a full pass at `capacity = 56` (the largest
// `q.maxActors` preset) touches at most 56*55/2 = 1540 candidate pairs; at
// `capacity = 40` (this ticket's own acceptance scenario) it is 780. Both are
// plain arithmetic (a squared-distance compare, `Math.sqrt` only on the
// candidates that actually overlap) over typed arrays already resident in
// cache — no allocation, no indirection, no hashing. A body-side grid would
// only pay for itself once `q.maxActors` grows into the low hundreds or
// more, which is not this project's ceiling (`config.js`'s four presets top
// out at 56) — building one now would be speculative complexity for a
// bound this game never reaches, the same "measure before you build a grid"
// discipline `grid.js`'s own header used to justify replacing a `Map` with
// open addressing (that one WAS worth it, measured over 10 000 statics;
// this one, measured over the actual body ceiling, is not). If a later
// ticket (AI-5, per O-30's own "further" column) raises `q.maxActors` well
// past this game's four presets, that ticket re-measures and reconsiders —
// this file does not speculate on its behalf.
//
// ---------------------------------------------------------------------------
// Assigned decisions, absent from 02-api-contracts.md §4 (this ticket's
// report calls these D1-D5)
// ---------------------------------------------------------------------------
// D1 — Separation is purely horizontal (XZ-plane circle vs. circle),
//      ignoring `height`/the tracked `_floorY`/`FLY_ALTITUDE` entirely. This
//      matches `cast.js`'s own D1 exactly ("casts are 2D... every footprint
//      [and, for the body half, every body] is an infinite vertical
//      column") — the engine tracks no real per-body vertical position, only
//      an untracked "current footing" `moveBody` uses against STATICS, so
//      there is no principled vertical test to run between two BODIES that
//      the existing data model actually supports. A flying body still
//      participates in crowd separation exactly like a grounded one.
// D2 — `BODY_FLAG.NO_COLLIDE` bodies are excluded entirely — neither pushed
//      nor pushing. `moveBody` already documents `NO_COLLIDE` as "bypass
//      collision resolution"; generalising that to "does not participate in
//      the crowd pass either" is the reading consistent with the flag's own
//      name (a ghost should not shoulder other actors any more than it
//      should be blocked by a wall).
// D3 — Mass weighting: on overlap, the correction is split inversely
//      proportional to mass — a heavier body moves less, equal masses split
//      the correction 50/50 exactly (`wi = mj/(mi+mj)`, `wj = mi/(mi+mj)`).
//      A body with `mass <= 0` is treated as immovable (infinite mass) — its
//      weight contribution is 0, so a normal body pushes fully clear of it
//      and vice versa; two immovable bodies overlapping each other resolve
//      to nothing (there is no principled way to move either), which is an
//      unreachable pairing in practice (every real spawn uses a positive
//      mass) and is left as a documented no-op rather than invented
//      behaviour.
// D4 — Two bodies at (numerically) exactly the same point produce a
//      deterministic, non-NaN separation: direction `(+1, 0)`, full combined
//      radius as the depth — identical to `body.js`'s own
//      `circleVsCircle` degenerate-centres branch, so a coincident pair
//      resolves the same way here as it would against a coincident static
//      cylinder.
// D5 — `iterations`: `separate(iterations)` runs `iterations` full
//      all-pairs push-out sweeps in sequence (Gauss-Seidel — each sweep
//      reads whatever the previous sweep, or an earlier pair within the
//      SAME sweep, already wrote, so overlaps resolve progressively without
//      needing a second scratch buffer). `iterations <= 0` (including
//      non-finite input) is a safe no-op — zero sweeps, `stats.separationMs`
//      still updated to (approximately) zero. A fractional value truncates
//      toward zero (`Math.trunc`). There is no upper clamp: this method's
//      caller (`actors`, per `02-api-contracts.md` §4's "Forbidden for
//      callers" note — "actors calls it exactly once per fixed step") owns
//      the iteration count for its own step budget, and clamping here would
//      silently override a value the contract assigns to the caller, not to
//      this file.
//
// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
// Every sweep walks body slots in ascending order for both the outer and
// inner index (slot == handle - 1, so this is ascending-handle order, the
// same convention `grid.js`/`index.js` already use for statics). No `Map`,
// no object identity, no hash-dependent order anywhere. Two identical worlds
// (same body positions, same masses, same flags, same `iterations`) always
// produce byte-identical results.
//
// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------
// Every local in the hot loop is a plain number; the only object touched is
// `phys._stats` (mutated in place, never reallocated — the same convention
// every other physics stats write already uses). `performance.now()` is
// sanctioned here: `tools/check-imports.mjs`'s header documents that
// `src/physics/` is checked for the `three` import only, not the browser-
// global/`performance.now()` sweep the five gameplay N-roots get (that
// sweep exists to keep combat/items/skills/nav/world's *simulation math*
// off the wall clock; `separate()`'s own resolution math never reads the
// clock — only `stats.separationMs`, a write-only measurement, does).
// `tools/check-fixed.mjs` walks literal `fixedUpdate(...) { ... }` method
// bodies in `src/`; `PhysicsSystem` does not implement `fixedUpdate` (its
// separation call site belongs to `actors`, per the "Forbidden for callers"
// note above), so this file's `performance.now()` read is not inside any
// `fixedUpdate` body for that lint to find in the first place.

import { BODY_FLAG } from './body.js';

/** Assigned, absent from spec — the extra push past exact contact after a
 * resolution, so two bodies just separated don't immediately re-report as
 * (barely) overlapping from float rounding within the same sweep or the
 * very next one. Identical in spirit and magnitude to `body.js`'s own
 * `SKIN_WIDTH` for static depenetration. Exported (like `body.js` exports
 * its own tuning constants) so `tests/physics/phys4.test.js` can assert an
 * exact post-resolution distance instead of guessing a tolerance. */
export const SKIN_WIDTH = 1e-4;

export class SeparationSystem {
  /** @param {import('./index.js').PhysicsSystem} phys — see this file's
   * header for why a live reference to the whole instance, read fresh per
   * call, is this ticket's chosen seam (matching `CastSystem`). */
  constructor(phys) {
    this._phys = phys;
  }

  /**
   * `02-api-contracts.md` §4: `separate(iterations:int) => void` — see this
   * file's header (D5) for what `iterations` means, and O-30 above for the
   * broadphase decision. Writes `phys.stats.separationMs`.
   * @param {number} iterations
   */
  separate(iterations) {
    const phys = this._phys;
    const bodies = phys._bodies;
    const cap = bodies.capacity;

    const passes = Number.isFinite(iterations) ? Math.trunc(iterations) : 0;

    const t0 = performance.now();

    if (passes > 0) {
      const x = bodies._x;
      const z = bodies._z;
      const radius = bodies._radius;
      const mass = bodies._mass;
      const alive = bodies._alive;
      const flags = bodies._flags;

      for (let pass = 0; pass < passes; pass++) {
        for (let i = 0; i < cap; i++) {
          if (!alive[i]) continue;
          if (flags[i] & BODY_FLAG.NO_COLLIDE) continue;
          const ri = radius[i];
          const mi = mass[i];
          const iMovable = mi > 0;

          for (let j = i + 1; j < cap; j++) {
            if (!alive[j]) continue;
            if (flags[j] & BODY_FLAG.NO_COLLIDE) continue;

            const rj = radius[j];
            const rsum = ri + rj;

            const xi = x[i];
            const zi = z[i];
            const xj = x[j];
            const zj = z[j];
            const dx = xj - xi;
            const dz = zj - zi;
            const distSq = dx * dx + dz * dz;
            if (distSq >= rsum * rsum) continue;

            let nx;
            let nz;
            let dist;
            if (distSq < 1e-12) {
              // D4 — coincident centres: deterministic, non-NaN direction.
              nx = 1;
              nz = 0;
              dist = 0;
            } else {
              dist = Math.sqrt(distSq); // Math.sqrt, never Math.hypot (docs/PROGRESS.md's own rule)
              nx = dx / dist;
              nz = dz / dist;
            }
            const depth = rsum - dist + SKIN_WIDTH;

            const mj = mass[j];
            const jMovable = mj > 0;

            let wi;
            let wj;
            if (iMovable && jMovable) {
              const invSum = 1 / (mi + mj);
              wi = mj * invSum;
              wj = mi * invSum;
            } else if (iMovable && !jMovable) {
              wi = 1;
              wj = 0;
            } else if (!iMovable && jMovable) {
              wi = 0;
              wj = 1;
            } else {
              // D3 — both immovable: nothing to do, no NaN.
              continue;
            }

            // Push i back along -n, j forward along +n (n points i -> j).
            x[i] = xi - nx * depth * wi;
            z[i] = zi - nz * depth * wi;
            x[j] = xj + nx * depth * wj;
            z[j] = zj + nz * depth * wj;
          }
        }
      }
    }

    phys._stats.separationMs = performance.now() - t0;
  }
}
