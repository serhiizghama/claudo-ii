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
// ACTR-2 (this ticket) — what it adds on top of the ACTR-1 slice above
// ---------------------------------------------------------------------------
// `moveTo` (above) is untouched — no real defect found in it, so per this
// ticket's brief it is not rewritten "for its own sake". Added below:
//   - `teleportActor` / `ActorsSystem.teleport` — `(actor,x,z) => boolean`.
//   - `faceActor` / `ActorsSystem.face` — `(actor,targetX,targetZ,
//     maxTurnRate) => void`.
//   - `actorDistance`/`actorsInRange` / `ActorsSystem.distance`/`.inRange`.
//   - `computeMoveSpeed` / `ActorsSystem.moveSpeed`.
//   - The dev-build write guard on `actor.x`/`actor.z` — see "The write
//     guard" section below for the full design and how it differs from
//     `src/render/camera.js`'s `Proxy` precedent.
//   - `applyImpulse` is the one "Transform and motion" row deliberately NOT
//     implemented here — see "applyImpulse — deliberately out of scope"
//     below for why, and this ticket's report.
//
// Still NOT here, on purpose:
//   - `velX`/`velZ`/`desiredX`/`desiredZ`/`speed` bookkeeping beyond what
//     `moveTo` already leaves alone. `01-data-model.md` §2 documents these
//     as motion fields, but nothing in this ticket's scope reads/writes
//     them (no animator, no steering system) — inventing a convention for
//     them now would be guessing at a later ticket's design. Left at their
//     pool-reset default (0).
//   - `y`/`prevY`/`renderY` for anything other than `teleportActor`, which
//     re-samples `physics.groundHeight` the same way `ActorsSystem.spawn()`
//     already does (see `teleportActor`'s own comment) — `moveTo` still
//     does not touch `y` (XZ-plane only, unchanged).
//   - Every `render*` field (`renderX`/`renderZ`/`renderFacing`) — `01` §2's
//     "written only in update()" presentation layer; interpolating them
//     needs `ctx.time.alpha`, categorically not a `fixedUpdate`-safe file's
//     job (this whole file is Node-safe, clock-free, per its own footer).
//
// ---------------------------------------------------------------------------
// The write guard — design, and why it is NOT camera.js's Proxy
// ---------------------------------------------------------------------------
// The acceptance criterion has two halves: `actor.x`/`actor.z` are written
// only through this subsystem's own sanctioned internal paths, AND a direct
// `actor.x = ...` from ANY OTHER subsystem is caught, in a dev build, the
// instant it happens. `src/render/camera.js` (RNDR-2) is the precedent this
// ticket was pointed at: it wraps `camera.position`/`camera.quaternion` in a
// `Proxy` whose `set` trap throws unless a `{unlocked}` lock (opened only by
// `withCameraWrite`) is open, installed via `Object.defineProperty` because
// three's `Object3D` declares those properties `writable:false`. That file's
// own journal row (docs/PROGRESS.md, RNDR-2) explains why a Proxy's
// property-set trap beats a method-by-method wrapper: three mutates a
// `Quaternion`'s private `_x/_y/_z/_w` directly from `slerp`/
// `setFromRotationMatrix`, bypassing any public method a wrapper could
// intercept — a `set` trap catches it because those are still plain
// property writes on the (proxied) object.
//
// That reasoning is ABOUT three's internals, and `src/actors/` never touches
// `three` (`ARCHITECTURE.md` rule 2 / this ticket's own file-ownership rule
// — gameplay code must not import it at all). `actor.x`/`actor.z` are plain
// numbers on a plain pooled object literal, never mutated by any private
// field a Proxy trap would be needed to intercept from underneath a public
// accessor — there is no "three mutates this behind your back" problem here
// to guard against. So this file uses the SIMPLER of the two precedents this
// codebase already has for exactly this situation: `src/actors/pool.js`'s
// own `all` getter guards a live list the same general way (deny writes
// unless you're the sanctioned mutator) via a plain accessor-property
// `Object.defineProperty` on `x`/`z` themselves (converting each from the
// object literal's plain data property into a get/set pair backed by a
// per-actor closure variable), gated by one shared REENTRANT DEPTH COUNTER
// (not a plain boolean like `camera.js`'s lock — see `_actorWriteDepth`'s own
// comment for why a nested begin/end pair needs a counter, found in review) —
// opened only for the synchronous extent of this subsystem's own sanctioned
// writers (`moveActor`, `teleportActor`, and `ActorsSystem.spawn()`/
// `despawn()`'s calls into `ActorPool#acquire`/`#release`, which is where the
// *initial* spawn placement and the pool-reset zeroing happen — neither goes
// through `moveTo`/`teleport`, but both are this subsystem's own internal
// bookkeeping, not an "other subsystem" write). A `Proxy` wrapping the whole
// actor record was
// considered and rejected: it would have to forward every OTHER field read
// (`life`, `mana`, `state`, ...) through a trap for two fields' sake, adding
// indirection to every actor property access in the whole engine (stat
// composition, the animator, AI decisions — all read `Actor` fields
// constantly) instead of only to the two that need guarding. A pair of
// per-field accessor properties costs nothing on every OTHER field and only
// a plain function-call indirection on `x`/`z` themselves.
//
// Installed lazily, once per pool slot, the first time `ActorsSystem.spawn()`
// ever hands that slot's record out (`installActorWriteGuard`, idempotent —
// tracked by a `WeakSet` rather than a marker property on the actor itself,
// so the guard's own bookkeeping never shows up in `Object.keys(actor)` /
// `JSON.stringify(actor)` / a `{...actor}` spread). Actor records are built
// once and reused forever across despawn/respawn cycles for the same slot
// (`pool.js`'s own header) — so "once per slot" really is "once, ever, for
// that JS object" for the life of the process, never per spawn.
//
// Dev-only, same `import.meta.env.DEV` literal-replacement check
// `camera.js`'s `CAMERA_WRITE_GUARD_ENABLED` uses (see that file's own
// comment for the exact reasoning): under plain Node (`import.meta.env` is
// `undefined` — no Vite transform ran) and Vite's dev server (`DEV === true`)
// this reads `true` (guard on); a real Vite PRODUCTION build statically
// folds `import.meta.env.DEV` to the literal `false`, so
// `ACTOR_WRITE_GUARD_ENABLED` folds to `false` and every guard-related call
// below (`installActorWriteGuard`, `beginActorWrite`, `endActorWrite`) becomes
// a single `if (false) ...` that a minifier can (and does, per RNDR-2's own
// verified build) eliminate — a production actor's `x`/`z` stay plain,
// unguarded data properties, and `beginActorWrite`/`endActorWrite` cost one
// `if` each, everywhere they're called (including inside `moveTo`'s hot
// path). This ticket's report records how this was checked without a live
// browser session (see that report for what RNDR-2 did have — "верифицировано
// живым браузером" — and what this ticket could/couldn't reproduce).
//
// `beginActorWrite()`/`endActorWrite()` are deliberately NOT a
// `withActorWrite(fn)`-style callback wrapper the way `camera.js`'s
// `withCameraWrite(camera, fn)` is: `camera.js` only ever calls it once per
// frame (`player.update()`), so one small closure allocation per frame is
// immaterial there. `moveTo` is called up to once per LIVE ACTOR per fixed
// step (`ARCHITECTURE.md` rule 6, "zero allocation per frame" — with up to
// 220 actors at 60 Hz that is a lot of closures a callback-wrapper shape
// would allocate for no reason). A begin/end function pair incrementing/
// decrementing one preallocated depth counter, called directly around the
// two assignment statements, needs no closure at all.
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
  // The write guard (see the file header) — unlocked only for these two
  // statements. A no-op pair of `if`s in production (ACTOR_WRITE_GUARD_ENABLED
  // folds to `false`); in dev, opens the shared lock so this sanctioned
  // writer's own assignment passes the accessor property's `set` check.
  beginActorWrite();
  try {
    actor.x = out.x;
    actor.z = out.z;
  } finally {
    endActorWrite();
  }

  return out;
}

/** A fresh `MoveResult`-shaped scratch object, `02-api-contracts.md` §4's
 * shape verbatim. `ActorsSystem` calls this exactly once, in its own
 * `init()`, and reuses the result forever — never call this per-call. */
export function createMoveResultScratch() {
  return { x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 };
}

// ===========================================================================
// The write guard on actor.x/actor.z — see the file header for the full
// design and the comparison against src/render/camera.js's Proxy precedent.
// ===========================================================================

/** Same literal-replacement check as `src/render/camera.js`'s
 * `CAMERA_WRITE_GUARD_ENABLED` (re-derived here rather than imported —
 * `ARCHITECTURE.md` rule 2 forbids `actors` importing `src/render/`, and this
 * is a one-line, unaliased `import.meta.env.DEV` read Vite's static replacer
 * needs verbatim in EACH file that wants it folded away in production). */
const ACTOR_WRITE_GUARD_ENABLED =
  typeof import.meta === 'undefined' ||
  typeof import.meta.env === 'undefined' ||
  import.meta.env.DEV !== false;

/** One shared REENTRANCY DEPTH for the whole process, not one per actor:
 * exactly one `ActorsSystem`/pool exists at a time (unlike `camera.js`,
 * which guards two independent camera instances — world + UI — each
 * needing its own lock). JS is single-threaded, so no other code ever
 * observes the window between a `beginActorWrite()`/`endActorWrite()` pair
 * (the same argument `camera.js`'s own header makes for
 * `withCameraWrite`) — but a single shared BOOLEAN was the wrong shape for
 * that window: found in review, an inner `beginActorWrite()`/
 * `endActorWrite()` pair nested inside an outer one (e.g. a future
 * `applyImpulse` calling `moveTo`, or an `actor:despawn` listener that
 * moves a different actor while `despawn()`'s own window is still open)
 * closes the OUTER window the instant the inner `endActorWrite()` runs —
 * a boolean has no memory of "how many opens are still pending", so the
 * outer sanctioned writer's own write then throws as if it were an
 * illegal external one. A depth counter fixes this by construction:
 * `begin` increments, `end` decrements, the guard is unlocked whenever
 * depth > 0 — nesting to any depth re-locks only once the OUTERMOST
 * `end` runs. Nothing in this ticket's own call graph nests today (see
 * this ticket's report), but the two sanctioned writers this file owns
 * (`moveActor`, `teleportActor`) and the two `ActorsSystem` brackets
 * (`spawn`'s `acquire`, `despawn`'s `release`) are exactly the kind of
 * calls a later ticket's event listener could legitimately nest. */
let _actorWriteDepth = 0;

/** Tracks which actor records already have the accessor-property guard
 * installed, so `installActorWriteGuard` is idempotent across a slot's many
 * despawn/respawn cycles (the same JS object, guarded once, forever). A
 * `WeakSet` keyed by the actor object itself — not a marker field ON the
 * actor — so this bookkeeping is invisible to `Object.keys`/`JSON.stringify`/
 * a `{...actor}` spread and needs no pool-reset handling (pool.js is not in
 * this ticket's file list; this file must not need it to cooperate). */
const _guardedActors = new WeakSet();

/**
 * Opens (or re-enters) the write window for the synchronous extent of a
 * sanctioned caller's own `actor.x`/`actor.z` assignment. No-op in
 * production (`ACTOR_WRITE_GUARD_ENABLED` folds to `false`) — see the file
 * header for why this is a bare begin/end pair, not a `withActorWrite(fn)`
 * callback wrapper: `moveTo` calls this up to once per live actor per fixed
 * step, and a callback shape would allocate a closure there for nothing.
 * Safe to call while already open — see `_actorWriteDepth`'s own comment.
 */
export function beginActorWrite() {
  if (ACTOR_WRITE_GUARD_ENABLED) _actorWriteDepth++;
}

/**
 * Closes one level of the write window opened by `beginActorWrite`. Always
 * pair with a `try/finally` around the guarded assignment(s) — see
 * `moveActor`/`teleportActor`/`ActorsSystem.spawn()`/`.despawn()` for the
 * pattern. Calling this at depth 0 (an `end` with no matching `begin` still
 * open) is a bracketing bug in the CALLER, not a legitimate write — it
 * throws immediately rather than silently going negative (which would make
 * one extra `begin` "pay off" a stray `end` and quietly widen the unlocked
 * window from then on, the opposite of a guard's job). This mirrors the
 * decision `pool.js`'s own `resolve()` already makes for a different
 * caller mistake (throw loudly, dev-only, rather than tolerate silently).
 */
export function endActorWrite() {
  if (!ACTOR_WRITE_GUARD_ENABLED) return;
  if (_actorWriteDepth <= 0) {
    throw new Error(
      'actors/motion: endActorWrite() called with no matching beginActorWrite() still open ' +
        '(depth already 0). This is a bracketing bug in the caller, not a legitimate write — ' +
        'every beginActorWrite() must be closed by exactly one endActorWrite(), even when nested.',
    );
  }
  _actorWriteDepth--;
}

/** The message a caught illegal write throws with — factored out so both
 * the `x` and `z` traps produce the same wording with the field name
 * substituted in. */
function illegalActorWriteMessage(field) {
  return (
    `actors/motion: illegal direct write to actor.${field}. ` +
    `02-api-contracts.md §7's own header: "the only writer of actor.x/z: ` +
    `movement requests go through moveTo(), which drives physics.moveBody() ` +
    `and keeps the body and the record in step." A subsystem that needs to ` +
    `move or place an actor calls ctx.get('actors').moveTo(actor, dx, dz) or ` +
    `.teleport(actor, x, z) — never actor.${field} = ... directly.`
  );
}

/**
 * Converts `actor.x`/`actor.z` from the plain data properties
 * `pool.js#createActorRecord` builds into a get/set accessor pair backed by
 * per-actor closure variables (initialised from the record's current values,
 * whatever they are at install time), gated by the shared reentrant
 * `_actorWriteDepth` counter (`unlocked` whenever depth > 0 — see that
 * variable's own comment for why a depth counter, not a boolean).
 * Idempotent (`_guardedActors`) and a no-op outside dev — see the file
 * header. `enumerable`/`configurable` stay `true` so `Object.keys(actor)`,
 * `JSON.stringify(actor)` and a `{...actor}` spread all behave exactly as
 * they did before the conversion; only `set` (an external, un-unlocked
 * write) changes behaviour.
 * @param {object} actor
 */
export function installActorWriteGuard(actor) {
  if (!ACTOR_WRITE_GUARD_ENABLED) return;
  if (!actor || _guardedActors.has(actor)) return;
  _guardedActors.add(actor);

  let backingX = actor.x;
  let backingZ = actor.z;

  Object.defineProperty(actor, 'x', {
    get() {
      return backingX;
    },
    set(value) {
      if (_actorWriteDepth <= 0) throw new Error(illegalActorWriteMessage('x'));
      backingX = value;
    },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(actor, 'z', {
    get() {
      return backingZ;
    },
    set(value) {
      if (_actorWriteDepth <= 0) throw new Error(illegalActorWriteMessage('z'));
      backingZ = value;
    },
    enumerable: true,
    configurable: true,
  });
}

// ===========================================================================
// teleport — 02-api-contracts.md §7: `(actor,x,z) => boolean`, "snaps to
// nav, returns false if none"
// ===========================================================================
//
// ---------------------------------------------------------------------------
// nav absent (NAV-1/NAV-5 are tickets #7/#11 of this milestone; this is #4)
// ---------------------------------------------------------------------------
// `nav.snap`'s real contract (`02-api-contracts.md` §6, restated at
// `11-flows.md` A-6): `(x,z,maxRadius,out?) => Vec3 | null`, `null` when
// nothing walkable lies within `maxRadius`. `teleportActor` reaches it only
// at call time via the `nav` parameter `ActorsSystem.teleport` passes in
// (`ctx.peek('nav')`, guarded by `typeof nav.snap === 'function'` — the
// exact `src/core/engine.js` pattern this ticket's brief points at for
// `world.serviceZoneRequest()`) — this file never imports `src/nav/`
// (`ARCHITECTURE.md` rule 2).
//
// With `nav` absent, this function does NOT fail every call — it places the
// actor at the raw `(x,z)` unconditionally and returns `true`. This mirrors
// `moveActor`'s own already-shipped precedent for a subsystem that is
// absent-by-milestone-ordering rather than absent-by-error: "no physics ->
// move directly, no collision resolution" (this file's header, "A bodyless
// actor"). The alternative — always returning `false` until NAV-1 ships —
// would make `teleport` permanently unusable for the one real call site
// already written against it (`07-world-gen.md` T11: `world.entry(entryTag)
// -> actors.teleport(player, x, z)`), even though `world.entry`'s own point
// is already guaranteed walkable by the zone generator's own invariants
// (I3: "every SpawnPoint... nav.snap(p, 0.0) returns p unchanged"). A future
// caller that has NOT already validated its point (a skill's `teleport`
// effect, say) gets exactly the validation nav.snap provides the moment
// NAV-1/NAV-5 land — no change needed here; this function's own `nav`
// parameter is the whole seam.
//
// ---------------------------------------------------------------------------
// The seam for NAV-5 (ticket #11) — leave this alone, do not pre-wire it
// ---------------------------------------------------------------------------
// NAV-5's own acceptance criterion (per this ticket's brief) is "returns
// `null` when nothing walkable is inside `maxRadius`; the three call sites
// branch on it" — `teleportActor` is almost certainly one of those three
// (the other two are the move-order validation and loot-scatter placement,
// neither owned by this file). The branch already exists here
// (`if (snapped === null) return false;`) and needs no change once a real
// `nav.snap` lands — NAV-5 only has to implement the method on its own
// `NavSystem`; nothing in this file references `src/nav/` by name or
// assumes anything about HOW `snap` finds a walkable point, only its
// documented `(x,z,maxRadius,out) => Vec3|null` shape.
//
// ---------------------------------------------------------------------------
// TELEPORT_SNAP_RADIUS — assigned, no default given by the teleport row itself
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §7's `teleport` row gives no `maxRadius` (unlike
// `nav.snap`'s own row, which takes one as a caller-supplied argument every
// time). Every real `nav.snap` call site this ticket found across the specs
// uses a small, single-digit-metre radius for "is this specific point
// walkable" checks (`11-flows.md` §3.4 step 1's move-order validation: 2.0;
// `07-world-gen.md`'s waypoint/chest snapping: 2.0-3.0) — as opposed to the
// large radii used for "find me A walkable point out there" queries. A
// teleport destination (a portal, a world-entry point, a future short-range
// skill) is conceptually the same kind of check: "is the exact point I was
// asked for good, or close enough to it" — not "find me somewhere nearby
// that works". 2.0 m matches the move-order precedent exactly and is
// generous enough to tolerate a fractional-metre placement error without
// silently snapping someone metres away from where a portal/entry meant to
// put them.
export const TELEPORT_SNAP_RADIUS = 2.0;

/**
 * `teleport(actor,x,z) => boolean` — the algorithm. `physics`/`bodyId`/`nav`
 * are duck-typed instances (or `null`/`undefined` when absent), exactly
 * `moveActor`'s own calling convention; `navSnapOut` is the caller-owned
 * `Vec3` scratch this function hands to `nav.snap` as its `out` parameter
 * (never allocates one itself — `Alloc: no`).
 * @param {object | null} actor
 * @param {number} x
 * @param {number} z
 * @param {object | null} physics `ctx.get('physics')`'s instance, or `null`.
 * @param {number} bodyId `0` = no body.
 * @param {object | null | undefined} nav `ctx.peek('nav')`'s instance, or
 *   `null`/`undefined` when nav does not exist yet.
 * @param {{x:number,y:number,z:number}} navSnapOut
 * @returns {boolean}
 */
export function teleportActor(actor, x, z, physics, bodyId, nav, navSnapOut) {
  if (!actor || !actor.active) return false;

  let tx = x;
  let tz = z;

  if (nav && typeof nav.snap === 'function') {
    const snapped = nav.snap(x, z, TELEPORT_SNAP_RADIUS, navSnapOut);
    if (snapped === null) return false;
    tx = snapped.x;
    tz = snapped.z;
  }
  // else: nav absent — degraded behaviour, see this section's own header
  // comment above ("nav absent"). The raw (x,z) is used as-is.

  if (physics) {
    // Same groundHeight/hoverY composition ActorsSystem.spawn() already
    // uses — a teleported actor needs a correct footing exactly like a
    // freshly spawned one does, not the stale y it had before the jump.
    const groundY = physics.groundHeight(tx, tz);
    const y = Number.isFinite(groundY) ? groundY + actor.hoverY : 0;
    actor.y = y;
    actor.prevY = y;
    actor.renderY = y;

    // A teleport is a jump, not a per-step delta — physics.setBody (not
    // moveBody) resets the tracked floor/footing rather than trying to
    // infer one from a slide that never happened (src/physics/body.js's own
    // `setBody` doc comment).
    if (bodyId !== 0) physics.setBody(bodyId, tx, tz);
  }

  // No interpolated glide across a teleport: prevX/prevZ snap to the SAME
  // new position (unlike moveTo, which captures the pre-move position for
  // update()'s alpha-lerp) so the render-side interpolation this ticket does
  // not itself implement (ACTR-1's own gap, this file's header) will show an
  // instant jump the moment it exists, not a slide from the old point.
  actor.prevX = tx;
  actor.prevZ = tz;
  beginActorWrite();
  try {
    actor.x = tx;
    actor.z = tz;
  } finally {
    endActorWrite();
  }

  return true;
}

// ===========================================================================
// face — 02-api-contracts.md §7: `(actor,targetX,targetZ,maxTurnRate) => void`
// ===========================================================================
//
// `maxTurnRate` units — resolved against the two real call sites this
// ticket found, both in `11-flows.md`: §3.4 step 8's
// `actors.face(actor, nx, nz, 720°/s)` and §3.6 step 6's
// `actors.face(actor, tx, tz, 9.42)` annotated "(540°/s)" (9.42 rad ≈ 540°,
// exactly). Both are a PER-SECOND rate, yet this method's own signature
// carries no `h`/`dt` parameter to scale it by — every other Fixed:Y method
// in this file receives what it needs to stay clock-free (`moveTo` takes a
// raw per-step delta, already pre-scaled by whoever computed it), so
// `face`'s missing time parameter is not an oversight, it is the tell that
// this conversion is `face`'s own job, once, using the ONE fixed cadence
// `fixedUpdate` is ever called at (`ARCHITECTURE.md`: "Simulation runs in
// fixedUpdate (60 Hz)... Fixed-step constants, also engine-owned: PHYSICS_HZ
// = 60, FIXED_DT = 1/60"). Multiplying by that fixed, compile-time constant
// is exact (every fixed step really is 1/60 s, never a variable amount) and
// is not "reading dt" in the sense rule 5 forbids (no `ctx.time.dt`, no wall
// clock) — it is the same class of engine-owned invariant `moveTo`'s own
// bodyless branch and `body.js`'s `STEP_HEIGHT_MAX` already treat as a
// given, not a runtime read.
const FIXED_STEP_SECONDS = 1 / 60; // ARCHITECTURE.md's own FIXED_DT, verbatim — see above.

const TWO_PI = Math.PI * 2;

/** Wraps `angle` into `(-PI, PI]` — `01-data-model.md` §2's own convention
 * for `facing` (`pool.js#wrapAngle` does the same thing but is private to
 * that file, which this ticket's scope does not touch). */
function wrapAngleToPi(angle) {
  let a = angle % TWO_PI;
  if (a <= -Math.PI) a += TWO_PI;
  else if (a > Math.PI) a -= TWO_PI;
  return a;
}

/**
 * `face(actor,targetX,targetZ,maxTurnRate) => void` — turns `actor.facing`
 * toward the direction of `(targetX,targetZ)` by at most `maxTurnRate`
 * radians/second (see this section's own header for why that unit, and how
 * it is converted without a clock read), taking the shortest arc. A no-op
 * when the actor is already exactly at the target point (nothing to face
 * toward) or inactive/absent.
 * @param {object | null} actor
 * @param {number} targetX
 * @param {number} targetZ
 * @param {number} maxTurnRate radians/second.
 */
export function faceActor(actor, targetX, targetZ, maxTurnRate) {
  if (!actor || !actor.active) return;

  const dx = targetX - actor.x;
  const dz = targetZ - actor.z;
  if (dx === 0 && dz === 0) return;

  // atan2(z,x): 01-data-model.md §2's own convention, "facing: 0 = +X, CCW
  // positive" — z is the second axis, matching a standard atan2(y,x) with
  // z playing the role of y on this engine's XZ ground plane.
  const targetFacing = Math.atan2(dz, dx);

  let delta = wrapAngleToPi(targetFacing - actor.facing);

  const maxStep = maxTurnRate * FIXED_STEP_SECONDS;
  if (delta > maxStep) delta = maxStep;
  else if (delta < -maxStep) delta = -maxStep;

  // facing/prevFacing are not part of this ticket's write-guard acceptance
  // criterion (x/z only) — see this ticket's report — so no lock toggle here.
  actor.prevFacing = actor.facing;
  actor.facing = wrapAngleToPi(actor.facing + delta);
}

// ===========================================================================
// distance / inRange — 02-api-contracts.md §7
// ===========================================================================

/**
 * `distance(a,b) => number` — "surface-to-surface, radii subtracted". Never
 * clamped to zero: two overlapping actors legitimately report a negative
 * number (how deep the overlap is) — nothing in `02-api-contracts.md` §7
 * says to hide that, and `inRange`/callers checking `distance <= range` want
 * an overlap to read as "very much in range", not as an arbitrary zero.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function actorDistance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const centreDistance = Math.sqrt(dx * dx + dz * dz); // never Math.hypot — rule 5
  return centreDistance - a.radius - b.radius;
}

/**
 * `inRange(a,b,range) => boolean`. Uses the SAME surface-to-surface metric
 * as `distance` — confirmed against real call sites (`11-flows.md` §3.6
 * step 3: `range = items.weaponOf(actor).weapon.range;
 * actors.inRange(actor, target, range)`, checked against a bestiary
 * `attackRange` documented as "measured surface-to-surface",
 * `01-data-model.md` §2.3) — never a bare centre-to-centre comparison.
 * @param {object} a
 * @param {object} b
 * @param {number} range
 * @returns {boolean}
 */
export function actorsInRange(a, b, range) {
  return actorDistance(a, b) <= range;
}

// ===========================================================================
// moveSpeed — 02-api-contracts.md §7: `(actor) => number`, "m/s after stats
// and statuses"
// ===========================================================================
//
// `03-combat-math.md:270`'s own formula, used verbatim:
//   moveSpeed = classRunSpeed × (1 + clamp(movementSpeed, -90, +200)/100)
//               clamped to [0.8, 12.0]
//
// Both real inputs this formula needs are unavailable today, for the same
// milestone-ordering reason `src/player/index.js`'s own `MOVE_SPEED_MPS`
// stand-in already documents:
//   - `classRunSpeed` — a per-archetype constant (`ClassArchetype.runSpeed`/
//     `MonsterArchetype.runSpeed`, `01-data-model.md` §2.3) that lives in
//     `src/player/data/classes.js` / `src/ai/data/bestiary.js`, neither of
//     which exists yet (M2+/M4+). There is no field on the `Actor` record
//     itself to read a real per-instance run speed from either.
//   - `movementSpeed` — a `StatBlock` percent, composed from equipment/
//     skills/status by `actors.stats()` (ACTR-7/8), which does not exist
//     yet either — `hasStatus`/`statusStacks` (chilled/slowed's own
//     contribution) are equally absent.
// Rather than fabricate a two-entry archetype lookup table (which would
// look like real data while silently omitting every archetype but the two
// the specs happen to give as illustrative samples — worse than an honest
// single constant), this reuses the exact SAME assigned stand-in
// `src/player/index.js`'s own `MOVE_SPEED_MPS` already uses verbatim (the
// Ravager class's own base `runSpeed`, `01-data-model.md` line ~414: 4.2)
// with `movementSpeed` at its only honestly-known value, 0 (no stat system
// to supply anything else). Until ACTR-7/8 and a real class/bestiary table
// land, this returns the same 4.2 for every actor regardless of kind/class —
// correct by the formula, not yet useful by the data. See this ticket's
// report.
const ASSIGNED_CLASS_RUN_SPEED = 4.2; // see the section header above
const MOVEMENT_SPEED_CLAMP_MIN = -90; // 03-combat-math.md:270, verbatim
const MOVEMENT_SPEED_CLAMP_MAX = 200;
const MOVE_SPEED_CLAMP_MIN = 0.8; // 03-combat-math.md:270, verbatim
const MOVE_SPEED_CLAMP_MAX = 12.0;

/**
 * `moveSpeed(actor) => number` — see this section's own header for the
 * formula and why both its real inputs are placeholders today.
 * @param {object} actor unused today (no per-actor data to read yet — see
 *   above); kept in the signature because 02-api-contracts.md §7 documents
 *   `moveSpeed` as taking one, and a future archetype/stats lookup needs it.
 * @returns {number}
 */
// eslint-disable-next-line no-unused-vars
export function computeMoveSpeed(actor) {
  const movementSpeedPercent = 0; // no StatBlock yet — see the section header
  const clampedPercent = Math.min(
    MOVEMENT_SPEED_CLAMP_MAX,
    Math.max(MOVEMENT_SPEED_CLAMP_MIN, movementSpeedPercent),
  );
  const raw = ASSIGNED_CLASS_RUN_SPEED * (1 + clampedPercent / 100);
  return Math.min(MOVE_SPEED_CLAMP_MAX, Math.max(MOVE_SPEED_CLAMP_MIN, raw));
}

// ===========================================================================
// applyImpulse — deliberately NOT implemented in this ticket
// ===========================================================================
//
// `02-api-contracts.md` §7: `applyImpulse(actor,dx,dz,seconds) => void` —
// "knockback, dashes". Unlike `distance`/`inRange` (stateless queries) or
// `teleport`/`face` (an instant write this call itself performs in full),
// `applyImpulse` is a REQUEST that something else has to carry out over
// time: `11-flows.md` §2's own frame-phase table has a dedicated step for
// this — "A5: Decay applyImpulse velocities (knockback, dashes) and apply
// them through physics.moveBody" — and `03-combat-math.md`'s knockback
// section confirms the call is a single, one-shot
// `actors.applyImpulse(target, dx, dz, 0.18)` that puts the target into a
// `knockback` STATE it "cannot act for [the whole window]" (11-flows.md
// §6.4). Implementing this honestly needs, at minimum:
//   1. A per-actor "impulse remaining" bookkeeping field this ticket's own
//      `Actor` record slice does not have reason to add on its own (`velX`/
//      `velZ` alone capture a CURRENT velocity, not "how many seconds of
//      decay are left" — a distinct piece of state).
//   2. An `ActorsSystem.fixedUpdate(h, ctx)` method — ActorsSystem HAS NONE
//      today (ACTR-1 never added one) — to be the A5 phase that decays and
//      applies it every step via `physics.moveBody`, which is itself a new
//      lifecycle hook this ticket's file list (`motion.js`, `index.js`
//      wiring-only, a test file) was not asked to add.
//   3. The `knockback` action-state transition and the "cannot act" lockout
//      — `01-data-model.md` §2's `ACTOR_STATE`/`setState`/`canAct`, which
//      belong to ACTR-9/10's action state machine (not built; `index.js`'s
//      own header already documents this as absent).
// Bolting on a version that only writes `velX`/`velZ` once and never decays
// or applies them (skipping 1-3 above) would satisfy nothing "knockback,
// dashes" actually needs and would be indistinguishable from a stub that
// silently does nothing useful — worse than not shipping the method at all,
// since a caller checking `typeof actors.applyImpulse === 'function'` would
// get a false "yes, this works" signal. Left out; `distance`/`inRange` (both
// genuinely self-contained) were implemented in its place. See this ticket's
// report.
