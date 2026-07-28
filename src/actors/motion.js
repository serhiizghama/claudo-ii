// src/actors/motion.js
//
// Pulled forward from ACTR-2 (M1) at the project owner's direction, as a
// MINIMAL slice: `moveTo` only. PLYR-1 (M0, click-to-move) needs a legal
// way to move an actor and `ARCHITECTURE.md` / `02-api-contracts.md` §4
// forbid the alternative in as many words:
//
//   Never move an actor by writing `actor.x` / `actor.z` directly. Go through
//   `actors.moveTo()`, which calls `physics.moveBody()`. Direct writes desync
//   the body from the actor and actors fall through walls.
//
// `02-api-contracts.md` §7's own header names the same rule from the other
// side: "Also the only writer of actor.x/z: movement requests go through
// moveTo(), which drives physics.moveBody() and keeps the body and the
// record in step." Without this file, M0 cannot legally give PLYR-1 a
// method to call — the backlog's milestone split (this method landing in
// M1's ACTR-2) collides with M0's own requirement, and pulling the single
// method forward is the fix, not a boundary violation: everything else
// ACTR-2 owns stays out of scope, listed below.
//
// ---------------------------------------------------------------------------
// What is here: `moveTo(actor, dx, dz) => MoveResult`, `02-api-contracts.md`
// §7, verbatim signature — `(actor:Actor, dx,dz:number) => MoveResult`,
// `Fixed: Y, Alloc: no`. A per-step delta, not a destination.
//
// What is NOT here, on purpose — this file does not attempt to guess at
// scope ACTR-2 (M1) still owns in full:
//   - `teleport`, `face`, `moveSpeed`, `applyImpulse`, `distance`, `inRange`
//     — every other row of `02` §7's "Transform and motion" table.
//   - A dev-write-guard on `actor.x`/`actor.z` (the `Proxy` pattern
//     `src/render/camera.js` uses for `ctx.camera.position`). `moveTo` is
//     documented here as the ONLY sanctioned writer, but nothing in this
//     ticket's scope enforces that at runtime — a future direct write is
//     not caught. ACTR-2's job, if it wants one.
//   - `velX`/`velZ`/`desiredX`/`desiredZ`/`speed` bookkeeping. `01
//     -data-model.md` §2 documents these as motion fields, but nothing
//     reads them yet (no `moveSpeed()`, no animator) and `02`'s `moveTo`
//     signature takes a raw per-step delta, not a velocity — deriving one
//     would be inventing a convention ACTR-2 hasn't set. Left at their
//     pool-reset default (0) by this file.
//   - `y`/`prevY`/`renderY`/`facing`/`prevFacing`/`renderX`/`renderZ`/
//     `renderFacing`. `moveTo`'s own signature is XZ-plane only (`dx, dz`);
//     `y` is ground-height-derived (`ActorsSystem.spawn()`'s job today),
//     and every `render*` field is `01` §2's "written only in update()"
//     presentation layer — reading `ctx.time.alpha` to interpolate them is
//     categorically not this (or any) `fixedUpdate`-safe file's job.
//
// ---------------------------------------------------------------------------
// prevX/prevZ — whose job, and when
// ---------------------------------------------------------------------------
// `01-data-model.md` §2 groups `prevX`/`prevZ` under "transform: simulation
// authority, written only in fixedUpdate", right alongside `x`/`z`
// themselves — not under the separate "presentation, written only in
// update()" group `renderX`/`renderZ` belong to. Since `moveTo` is the sole
// writer of `x`/`z`, it is the natural (and, absent any other candidate in
// this ticket's scope, the only) writer of `prevX`/`prevZ` too: each call
// captures the position immediately before this call's own movement is
// applied. This is exactly right for the common case (one `moveTo` call per
// actor per fixed step, matching `01`'s comment "previous fixed step") and
// is an honest, documented simplification for the uncommon one (more than
// one `moveTo` call on the same actor within a single step, e.g. a knockback
// stacked on a walk order in the same tick) — this file makes no attempt at
// per-step batching, since nothing in ACTR-1/this slice's scope calls
// `moveTo` more than once per actor per step yet. Revisit here or in ACTR-2
// if that changes.
//
// ---------------------------------------------------------------------------
// A bodyless actor (bodyId === 0) — ACTR-1's own sentinel for "no physics
// body was ever registered" (physics absent at spawn time, or its body
// store was exhausted — `src/actors/index.js`'s own header, "Physics
// integration is best-effort"). Two cases share the sentinel and this file
// treats them identically: move the record directly, with NO collision
// resolution (there is nothing to resolve against — no body means no
// broadphase entry, and `physics.moveBody(0, ...)` cannot be called at all,
// since `0` is physics' own "no handle" sentinel and would silently return
// a MEANINGLESS `{x:0, z:0, ...}` no-op result, not the actor's real
// position — see `src/physics/body.js#moveBody`'s stale-handle branch).
// This matches `01-data-model.md` §11.1's own framing of the reserved
// pool headroom (D-1: actors beyond `q.maxActors` are "quest actors and
// corpses") — exactly the kind of actor that plausibly still needs a
// position update (a corpse being dragged, a quest marker relocating) but
// has no real stake in wall collision. A caller that needs a bodyless actor
// to still respect statics must wait for a real body to exist; this file
// does not invent a fallback collision path.
//
// ---------------------------------------------------------------------------
// The returned MoveResult — a shared scratch, never a per-call allocation
// ---------------------------------------------------------------------------
// `moveTo`'s own contract row carries no `out` parameter (unlike
// `physics.moveBody`), yet is `Alloc: no` — so it must return the SAME
// preallocated object every call, exactly the "shared scratch, valid until
// the next call, never stash one" discipline `02-api-contracts.md` §4
// already documents for `Hit`/`MoveResult`: "Read or copy them immediately;
// never stash one." This is NOT the same situation `pool.js`'s `ref()` had
// to be fixed for — `ActorRef` is explicitly a *holdable* type (`01` §2.2:
// "Hold an `ActorRef` and resolve it"), `MoveResult` explicitly is not.
// Returning a reused scratch here matches `MoveResult`'s own documented
// contract instead of fighting it. `moveActor()` below is handed that
// scratch as `out` and also passes it straight through as `physics.
// moveBody(bodyId, dx, dz, out)`'s own `out` — physics writes directly into
// it and its own 32-deep ring is never touched, so nothing here reads a
// ring value across a call boundary either.
//
// Node-safe: no `three`, no DOM/browser global. Pure function, no module
// state — testable without an `ActorsSystem`/`ActorPool` instance.

/**
 * Moves `actor` by a per-step delta, keeping the physics body (if any) and
 * the `Actor` record in step. The sole writer of `actor.x`/`actor.z` (and,
 * in this slice, `actor.prevX`/`actor.prevZ` — see the file header).
 *
 * @param {object | null} actor
 * @param {number} dx
 * @param {number} dz
 * @param {object | null} physics `ctx.get('physics')`'s instance, or `null`
 *   when physics is absent (see `src/actors/index.js`'s best-effort
 *   integration).
 * @param {number} bodyId `0` = no body (see the file header).
 * @param {{x:number,z:number,blocked:boolean,slid:boolean,hitStatic:number,hitActorId:number}} out
 *   the caller-owned scratch this function writes into and returns —
 *   `ActorsSystem` preallocates this once and reuses it forever.
 * @returns {typeof out}
 */
export function moveActor(actor, dx, dz, physics, bodyId, out) {
  if (!actor || !actor.active) {
    // Safe no-op on an invalid/inactive actor — matches `ActorPool#release`
    // and `physics`'s own "never throw on a bad handle" discipline. Holding
    // a stale `Actor` across a despawn is exactly what `01` §2.2 warns
    // against (`ActorRef` exists so callers don't have to); this function
    // does not reward that by mutating a recycled slot's new occupant.
    out.x = actor ? actor.x : 0;
    out.z = actor ? actor.z : 0;
    out.blocked = false;
    out.slid = false;
    out.hitStatic = 0;
    out.hitActorId = 0;
    return out;
  }

  if (physics && bodyId !== 0) {
    physics.moveBody(bodyId, dx, dz, out);
  } else {
    // No body — move directly, no collision to resolve. See the file
    // header's "A bodyless actor" section.
    out.x = actor.x + dx;
    out.z = actor.z + dz;
    out.blocked = false;
    out.slid = false;
    out.hitStatic = 0;
    out.hitActorId = 0;
  }

  actor.prevX = actor.x;
  actor.prevZ = actor.z;
  actor.x = out.x;
  actor.z = out.z;

  return out;
}

/** A fresh `MoveResult`-shaped scratch object, `02-api-contracts.md` §4's
 * shape verbatim. `ActorsSystem` calls this exactly once, in its own
 * `init()`, and reuses the result forever — never call this per-call. */
export function createMoveResultScratch() {
  return { x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 };
}
