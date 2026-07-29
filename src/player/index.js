// src/player/index.js
//
// PLYR-1 — click-to-move intent and camera follow (docs/spec/11-flows.md §3,
// §2.2 position 7; docs/spec/02-api-contracts.md §13). The last M0 ticket:
// `nav`, `world`, `ui`, `skills`, `items` do not exist yet, so this file
// implements exactly one branch of §3.3's classification ladder — priority 4,
// "anything else -> hasMoveOrder = true" — and goes straight to the click
// point instead of through `nav`. Everything path-related (`nav.snap`,
// `nav.raycastNav`, `requestPath`, hold-to-move re-pathing, moving-target
// chase) is PLYR-2 (M1), not here. See this ticket's report for the full
// boundary list.
//
// ---------------------------------------------------------------------------
// PLYR-2 addendum — `moveOrder`/`stop`/`_followOrder` now wire into `./move.js`
// ---------------------------------------------------------------------------
// `nav` exists now (NAV-1..5, all accepted). The straight-line-only
// `_followOrder` PLYR-1 shipped is replaced below by a thin delegation into
// `PathFollower` (`./move.js`, this ticket's real file — see its own header
// for the full §3.4 twelve-step algorithm, the blocked-streak anti-wedge
// mechanism, the missing-`raycastNav` guard and the `PathHandle` lifetime
// argument). This file's job is unchanged in shape: `moveOrder` still just
// starts an order, `_followOrder` still runs every fixed step regardless of
// the latch, `stop`/`_cancelOrder` still cancels one — only what happens
// *inside* those three now goes through `move.js` instead of a bare
// straight-line lerp. `computeArriveRadius` moved to `./move.js` too (its
// natural home now that arrival is `move.js`'s own concern) and is
// re-exported below unchanged, so `tests/player/plyr1.test.js`'s existing
// `import { computeArriveRadius } from '../../src/player/index.js'` keeps
// working byte-for-bit. Nothing about the intent latch, the ladder dispatch,
// `groundCursor`, or the camera follow below changed at all.
//
// ---------------------------------------------------------------------------
// The latch, precisely (11-flows.md §3.1)
// ---------------------------------------------------------------------------
// `update(dt, ctx)` is the ONLY place this file reads `ctx.input` or
// `ctx.camera`. It builds the ground cursor, classifies the click and writes
// `this._intent` — bumping `intent.sequence` exactly on a fresh press edge,
// never on a hold-refresh (§3.5). `fixedUpdate(h, ctx)` never reads
// `ctx.input` at all; it only ever reads `this._intent`, the snapshot
// `update()` already wrote. Because `src/core/engine.js#frame()` runs the
// whole fixed-step loop BEFORE `update()` in the same call (engine.js phases
// 2 then 3), an intent written by frame F's `update()` is not visible to any
// `fixedUpdate` until frame F+1's fixed-step loop — exactly the "one frame
// later" `11-flows.md` §3.1 draws. `fixedUpdate` compares `intent.sequence`
// against `this._consumedSequence`; a frame that happens to run six fixed
// steps (the `MAX_SUBSTEPS` spiral guard) only sees that comparison flip once,
// so the "new order" dispatch (which calls `moveOrder()`) fires exactly once
// — the steering/`actors.moveTo()` call below it still runs every one of the
// six steps, because that is how six ticks of walking happen at all. See
// `tests/player/plyr1.test.js` for this exercised directly, across two real
// `engine.frame()` calls.
//
// ---------------------------------------------------------------------------
// Unprojecting the cursor without `three` (why, and how)
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 2 / this ticket's brief: no `three` import anywhere
// in `src/player/` — the directory must `import` cleanly under plain Node
// (`tests/player/plyr1.test.js` asserts exactly that). `ctx.camera` is a real
// `THREE.PerspectiveCamera`, built by `src/render/camera.js` (RNDR-2), but
// this file never imports that class — it only ever reads raw numbers off
// the object it is handed: `camera.matrixWorld.elements` (a flat, column-
// major 16-number array), `camera.fov`, `camera.aspect`. This is the exact
// duck-typing precedent `src/physics/index.js#_footprintFromNode` already
// established for the same reason (see that file's header, "why this file
// never imports three"). `unprojectRay`/`intersectPlaneY` below are pure,
// three-free functions built on that convention — a symmetric-frustum
// perspective unprojection (this engine never sets a camera view offset),
// mathematically equivalent to `THREE.Raycaster.setFromCamera` for this
// camera shape.
//
// ---------------------------------------------------------------------------
// `world.groundHeight` and the flat plane (this ticket's own boundary)
// ---------------------------------------------------------------------------
// `11-flows.md` §3.3 step 3 intersects the cursor ray with
// `y = world.groundHeight(px, pz)`, refined over three iterations as the
// estimate walks across terraces. `world` does not exist (M1/M5) — per this
// ticket's brief, the ground is a literal `y = GROUND_Y` (0) plane. With a
// constant ground height the exact intersection is captured on the first
// pass; a three-iteration loop against a function that always returns the
// same number would just repeat the identical arithmetic, so it is not
// written here as dead-looking padding. When `world.groundHeight` lands,
// `intersectPlaneY`'s `planeY` argument is exactly the seam to swap a
// constant for a real per-point read.
//
// ---------------------------------------------------------------------------
// The `renderX`/`renderZ` gap — a deliberate, documented deviation
// ---------------------------------------------------------------------------
// `11-flows.md` §2.2/§2.4 are explicit: the camera (and, per this ticket's
// dev-view brief, the debug capsule) must read `actor.renderX`/`renderZ`
// (interpolated by `actors`' own `update()`, position 3 in the phase table),
// never `actor.x`/`z`. But ACTR-1 (the only `actors` ticket landed so far)
// does not implement that `update()` — `src/actors/pool.js#acquire` sets
// `renderX = x` once, at spawn, and nothing ever touches it again, so
// reading `actor.renderX` today would show a capsule and a camera frozen at
// the spawn point forever, regardless of how far `actor.x`/`z` (correctly
// updated by `actors.moveTo`) actually moved — silently failing this
// ticket's own live-browser acceptance check ("the capsule walks to the
// clicked point"). This file does NOT patch that by writing
// `actor.renderX`/`renderZ` itself: `11-flows.md` §2.4 states in as many
// words that those fields are "written only in update(), only by actors",
// and `player.update()` runs at phase-7, after `actors`' future
// interpolation step at phase-3 — a second writer downstream would win the
// race and silently corrupt whatever ACTR's own interpolation ticket writes
// once it lands. Instead, `_interpolatedFocus` below computes the identical
// `lerp(prevX, x, alpha)` locally, from fields ACTR-1 already correctly
// maintains (`x`/`z`/`prevX`/`prevZ`) plus `ctx.time.alpha` (engine-owned,
// already correct) — the same number the real `renderX` will hold once it
// exists, just not persisted onto the shared `Actor` record. `src/dev/
// debugview.js` repeats the identical three-line formula for the same
// reason (it cannot reach this file's private state — see that file's own
// header). Flagged prominently in this ticket's report; the fix once ACTR-1
// (or a future ACTR-2/6) ships the real interpolation is a one-line swap to
// `actor.renderX`/`renderZ` in both places, not a redesign.
//
// ---------------------------------------------------------------------------
// No player actor exists yet either — spawned here, not by `createCharacter`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §13's `createCharacter`/`loadCharacter` are the real,
// documented way a player `Actor` comes to exist — but they need
// `startingKit`/`items` (M3+) and a character-creation UI screen (M2+),
// neither of which exists. Without SOME player actor, `player.actor` stays
// `null` forever and nothing in this ticket is observable at all. `init()`
// below spawns a minimal placeholder (`kind: 'player'`, `team: 0`, at the
// origin) only when `actors.player` is not already set — a deliberate,
// narrow stand-in for M0, not an implementation of `createCharacter`. Flagged
// in this ticket's report.
//
// ---------------------------------------------------------------------------
// Camera write — the one legal path (docs/PROGRESS.md O-17)
// ---------------------------------------------------------------------------
// `render`'s write guard (RNDR-2) throws in dev on any direct write to
// `ctx.camera.position`/`.quaternion`. The only sanctioned path is
// `ctx.get('render').cameraRig` (`{ solveOrbitLock, withCameraWrite }`,
// cached once in `init()` — `ARCHITECTURE.md` rule 2 forbids importing
// `src/render/camera.js` directly): `solveOrbitLock` is called every
// `update()` (never `fixedUpdate` — reading `ctx.time.alpha` there would be
// illegal, §2.2), and the actual write happens only inside
// `rig.withCameraWrite(camera, fn)`.
//
// ---------------------------------------------------------------------------
// The dev-only capsule/ground view — wired without touching src/main.js twice
// ---------------------------------------------------------------------------
// docs/PROGRESS.md O-12: a ticket is granted exactly two `src/main.js` lines,
// by name, in its own brief — this ticket's grant covers `PlayerSystem`
// only. `src/dev/debugview.js` (explicitly authorised by this ticket's brief
// so the acceptance criterion is checkable at all — see that file's header)
// is therefore never `registry.add()`-ed; nothing else in this codebase
// drives its `update()` for it. `init()` below dynamically `import()`s it,
// gated behind `typeof window !== 'undefined'` — a *runtime* check, so this
// module's own static import graph never mentions `three` or that file, and
// a plain Node `import` of `src/player/index.js` (this ticket's own
// `tests/player/plyr1.test.js`) never triggers it even when `init()` runs
// against a Node ctx.

// PLYR-2: the real path-following state machine. Same directory, not a
// cross-subsystem import (hard rule 2 only forbids reaching into another
// subsystem's own module) — see move.js's own header.
import { PathFollower, computeArriveRadius } from './move.js';

const DEG2RAD = Math.PI / 180;

/** `PointerEvent.button` for the primary/left button — `11-flows.md` §3
 * uses "LMB" for every click-to-move/attack/interact order; RMB (§3.2 row 5)
 * is skills, out of this ticket's scope. */
const MOVE_BUTTON = 0;

/** `src/core/input.js`'s pre-registered code for the stop order (§3.2 row 3,
 * "S"). */
const STOP_KEY_CODE = 'KeyS';

/** Raw `KeyboardEvent.code` for the modifier `11-flows.md` §3.3 calls
 * "Shift held" as a single condition — CORE-7 deliberately tracks the two
 * physical keys separately (docs/PROGRESS.md O-6: "ShiftLeft and ShiftRight
 * are two different keys, there is no generic Shift"), so a consumer must
 * check both or the modifier silently does not work on half the keyboards.
 * Read every `update()` (see `isShiftHeld`) even though, in this ticket's
 * reduced classification ladder (only priority 4, plain move), Shift changes
 * nothing yet — §3.3 only assigns Shift a meaning for priorities 2/3
 * (attack-in-place / interact-in-place), neither implemented here. Kept live
 * and tested now so the O-6 trap cannot quietly resurface once PLYR-3/4 add
 * those branches. */
const SHIFT_LEFT_CODE = 'ShiftLeft';
const SHIFT_RIGHT_CODE = 'ShiftRight';

/** Metres. `world.groundHeight` does not exist (M1/M5) — this ticket's
 * boundary is a literal flat plane. See the file header. */
const GROUND_Y = 0;

/** A ray this close to horizontal never happens at the fixed 52° camera
 * pitch; guarded anyway so a future camera-peek perturbation can never
 * divide by (near-)zero. */
const RAY_VERTICAL_EPSILON = 1e-8;

/** Metres. ASSIGNED — `11-flows.md` §2.2 names "camera follow with the dead
 * zone" but gives no number anywhere in the five spec documents this ticket
 * checked. Picked to absorb an ordinary walk-cycle's lateral sway without
 * ever nudging the camera on it (a capsule walking in a straight line only
 * drifts a few centimetres off a locked focus per fixed step), while still
 * being small enough that the camera visibly starts following well before
 * the player nears the screen edge. Revisit once real playtesting exists. */
const CAMERA_DEAD_ZONE_M = 1.5;

/** No character-creation flow exists yet (`createCharacter`,
 * `02-api-contracts.md` §13, needs `items`/M3+ and a UI screen/M2+) — see
 * the file header, "No player actor exists yet either". This is the
 * placeholder spawned in `init()` only when no player actor already exists. */
const PLACEHOLDER_ARCHETYPE_ID = 'ravager';
const PLACEHOLDER_TEAM = 0; // TEAM.player, 01-data-model.md §1.2

/**
 * `02-api-contracts.md` §13's `Intent` shape, verbatim defaults. Every field
 * this ticket does not write (`attackTargetId`, `castSkillIndex`/`castX`/
 * `castZ`, `beltSlot`, `interactId`) stays at its neutral default forever —
 * PLYR-3/4/5's job, not this ticket's (see the file header's boundary list).
 * @returns {object}
 */
function createIntent() {
  return {
    moveX: 0,
    moveZ: 0,
    hasMoveOrder: false,
    attackTargetId: 0,
    castSkillIndex: -1,
    castX: 0,
    castZ: 0,
    beltSlot: -1,
    interactId: 0,
    stopRequested: false,
    sequence: 0,
  };
}

/**
 * True if either physical Shift key is currently held. See the
 * `SHIFT_LEFT_CODE`/`SHIFT_RIGHT_CODE` comment above (docs/PROGRESS.md O-6)
 * for why both must be checked. Pure — takes CORE-7's `Input` instance (or
 * anything duck-typed the same way) and nothing else.
 * @param {{keyHeld:(code:string)=>boolean}} input
 * @returns {boolean}
 */
export function isShiftHeld(input) {
  return input.keyHeld(SHIFT_LEFT_CODE) || input.keyHeld(SHIFT_RIGHT_CODE);
}

// `computeArriveRadius` now lives in `./move.js` (PLYR-2 addendum, see this
// file's header, imported above) — re-exported here unchanged so
// `tests/player/plyr1.test.js`'s existing
// `import { computeArriveRadius } from '../../src/player/index.js'` keeps
// resolving.
export { computeArriveRadius };

/**
 * Unprojects one NDC point through `camera` into a world-space ray, without
 * ever importing `three` — see the file header. `camera` is duck-typed:
 * `.matrixWorld.elements` (16 numbers, column-major, three's own layout —
 * `src/physics/index.js#_footprintFromNode`'s exact precedent), `.fov`
 * (degrees), `.aspect`. Zero allocation: writes into the caller-owned
 * `outOrigin`/`outDir`.
 * @param {{matrixWorld:{elements:number[]}, fov:number, aspect:number}} camera
 * @param {number} ndcX -1..1, left to right
 * @param {number} ndcY -1..1, bottom to top
 * @param {{x:number,y:number,z:number}} outOrigin
 * @param {{x:number,y:number,z:number}} outDir
 */
export function unprojectRay(camera, ndcX, ndcY, outOrigin, outDir) {
  const e = camera.matrixWorld.elements;
  const rightX = e[0];
  const rightY = e[1];
  const rightZ = e[2];
  const upX = e[4];
  const upY = e[5];
  const upZ = e[6];
  // A camera looks down its own local -Z; matrixWorld's third column is
  // local +Z in world space, so "forward" is its negation.
  const fwdX = -e[8];
  const fwdY = -e[9];
  const fwdZ = -e[10];

  const halfHeight = Math.tan((camera.fov * DEG2RAD) / 2);
  const halfWidth = halfHeight * camera.aspect;
  const dx = ndcX * halfWidth;
  const dy = ndcY * halfHeight;

  let dirX = fwdX + dx * rightX + dy * upX;
  let dirY = fwdY + dx * rightY + dy * upY;
  let dirZ = fwdZ + dx * rightZ + dy * upZ;
  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  dirX /= len;
  dirY /= len;
  dirZ /= len;

  outOrigin.x = e[12];
  outOrigin.y = e[13];
  outOrigin.z = e[14];
  outDir.x = dirX;
  outDir.y = dirY;
  outDir.z = dirZ;
}

/**
 * Ray/plane-`y` intersection distance, or `null` if the ray is (near-)
 * parallel to the plane. `origin + dir * t` is the hit point.
 * @param {{y:number}} origin
 * @param {{y:number}} dir - unit length
 * @param {number} planeY
 * @returns {number | null}
 */
export function intersectPlaneY(origin, dir, planeY) {
  if (dir.y > -RAY_VERTICAL_EPSILON && dir.y < RAY_VERTICAL_EPSILON) return null;
  return (planeY - origin.y) / dir.y;
}

export class PlayerSystem {
  static id = 'player';
  // `02-api-contracts.md` §13's real deps are
  // `['actors','nav','skills','items','world']` — trimmed here to what is
  // actually registered today, the exact precedent `src/actors/index.js`
  // (ACTR-1) already set for `materials`: declaring an unregistered id
  // throws out of `Registry.resolve()` before anything boots
  // (`src/core/registry.js`). `render` is not in the contract's own deps
  // list either (this file reaches it via `ctx.get('render')` at runtime,
  // never a static import — rule 2) and does not need to be: `src/main.js`
  // registers `render` before `player` (B4's registration order), and
  // `Registry.resolve()`'s DFS ties are broken by registration order, so
  // `render` is guaranteed initialized first regardless. `nav` (PLYR-2
  // addendum) IS real and registered now (NAV-1..5, all accepted) — added
  // here as a genuine hard dependency, not a runtime-only `ctx.get`, so
  // `init()` below can cache it exactly like `this._actors`.
  static deps = ['actors', 'nav'];

  constructor() {
    this._ctx = null;
    this._actors = null;
    this._nav = null;
    this._rig = null;
    this._actor = null;

    this._controlEnabled = true;

    this._intent = createIntent();
    /** last `intent.sequence` value `fixedUpdate`'s ladder dispatch has
     * acted on — see the file header, "The latch, precisely". */
    this._consumedSequence = 0;

    /** The current move order — PLYR-2 addendum: `moveOrder()`/`stop()`/
     * `_followOrder()` below are thin wiring into this; see `./move.js`'s own
     * header for the real §3.4 state machine (destination validation,
     * requestPath/pollPath/smooth, blocked-streak repathing, arrival). One
     * instance for the lifetime of this `PlayerSystem`, reused across every
     * order — no per-order allocation. */
    this._pathFollower = new PathFollower();

    /** `groundCursor()`'s live value, recomputed once per `update()` frame
     * (§3.3) — never touched from `fixedUpdate`. */
    this._cursor = { x: 0, y: GROUND_Y, z: 0 };
    /** The scratch `groundCursor(out)` returns when called with no `out` —
     * kept separate from `_cursor` so a caller mutating its own copy can
     * never corrupt this file's next classification read. */
    this._cursorScratch = { x: 0, y: GROUND_Y, z: 0 };

    // Reused every frame by `_updateGroundCursor`/`unprojectRay` — zero
    // allocation on the hot path (ARCHITECTURE.md rule 6).
    this._rayOrigin = { x: 0, y: 0, z: 0 };
    this._rayDir = { x: 0, y: 0, z: 0 };

    /** No `overlapCircle` exists yet (`physics`, PHYS-3) — actor picking
     * (§3.3 step 5) is out of this ticket's scope (see the file header's
     * boundary table), so this never becomes anything but 0. Still exposed
     * as the contract's own property, honestly inert rather than faked. */
    this._hoverTarget = 0;

    /** The camera's own focus point — trails the actor's interpolated
     * position outside the dead zone; see `_followCamera`. */
    this._camFocus = { x: 0, y: GROUND_Y, z: 0 };
    this._camPos = { x: 0, y: 0, z: 0 };
    this._camLookAt = { x: 0, y: 0, z: 0 };

    /** See the file header's "dev-only capsule/ground view" section —
     * `null` outside a real browser session (Node tests, SSR-style
     * boot()s). */
    this._debugView = null;
  }

  async init(ctx) {
    this._ctx = ctx;
    this._actors = ctx.get('actors');
    this._nav = ctx.get('nav');
    this._rig = ctx.get('render').cameraRig;

    // See the file header, "No player actor exists yet either".
    this._actor =
      this._actors.player ||
      this._actors.spawn({
        kind: 'player',
        team: PLACEHOLDER_TEAM,
        archetypeId: PLACEHOLDER_ARCHETYPE_ID,
        x: 0,
        z: 0,
        facing: 0,
      });

    if (this._actor) {
      this._camFocus.x = this._actor.x;
      this._camFocus.z = this._actor.z;
    }

    // See the file header, "The dev-only capsule/ground view" — dynamic,
    // runtime-gated import so this module's own static graph never mentions
    // `three` or `src/dev/debugview.js`.
    if (typeof window !== 'undefined' && ctx.scene) {
      const { DebugView } = await import('../dev/debugview.js');
      this._debugView = new DebugView();
      this._debugView.init(ctx);
    }
  }

  // ─── 02-api-contracts.md §13 — the slice this ticket implements ────────

  /** `actor` -> `Actor | null`. */
  get actor() {
    return this._actor;
  }

  /** `intent` -> `Intent`, read-only by convention (`player` is the only
   * legal writer — 02-api-contracts.md §13: "Never read player.intent in
   * update() [as a caller]; it is consumed in fixedUpdate"). Returns the
   * live object, not a copy — matching every other shared-scratch
   * convention in this codebase (`MoveResult`, `groundCursor`). */
  get intent() {
    return this._intent;
  }

  /** `hoverTarget` -> `int actorId`, 0 when none. Always 0 in this ticket —
   * see the constructor comment on `_hoverTarget`. */
  get hoverTarget() {
    return this._hoverTarget;
  }

  /** `setControlEnabled(on) => void`. §3.2 ladder priority 0: a disabled
   * player drops every intent outright (a zone-transition fade, per
   * 11-flows.md §9). */
  setControlEnabled(on) {
    this._controlEnabled = !!on;
  }

  /** `moveOrder(x,z) => void` — an explicit click-to-move destination.
   * `fixedUpdate`'s ladder dispatch calls this at most once per latched
   * intent (see the file header); nothing stops another subsystem calling
   * it directly later (a future "walk here" UI affordance), which is
   * exactly why it is its own public method and not inlined into the
   * dispatch.
   *
   * PLYR-2 addendum: validation (§3.4 steps 1-2) can now DROP the order —
   * `PathFollower.beginOrder` returns `false` on an unreachable destination
   * (`nav.snap`/`nav.connected` failure). When that happens this clears
   * `intent.hasMoveOrder` right back to `false` in the same call, so a
   * dropped order never leaves the intent looking like a live one — see
   * `./move.js`'s header for why `nav.version === 0` (no real zone yet, e.g.
   * `tests/player/plyr1.test.js`'s own boot()) always succeeds unconditionally
   * instead, preserving that suite's original behaviour exactly. */
  moveOrder(x, z) {
    const accepted = this._pathFollower.beginOrder(this._nav, this._actor, x, z);
    if (!accepted) this._intent.hasMoveOrder = false;
  }

  /** `stop() => void` — §3.2 ladder priority 3. Releases the current order
   * and clears the intent's one-shot request. `actors.setState` does not
   * exist yet (ACTR-1 ships only the Lifecycle + `moveTo` slice) — guarded
   * by `typeof`, the same defensive-duck-typing convention `src/main.js`
   * already uses for every not-yet-built subsystem hook.
   *
   * Delegates to `_cancelOrder()` rather than being called by name from
   * `fixedUpdate` below: `docs/spec/02-api-contracts.md` §15 (`audio`) also
   * declares a `stop(voice, fadeSeconds)`, Fixed=N — `tools/check-fixed.mjs`
   * (TEST-2) matches Fixed=N call sites by bare method NAME across the whole
   * contract, with no per-subsystem disambiguation, so a literal
   * `this.stop()` written inside `fixedUpdate`'s own body false-positives
   * against `audio`'s unrelated row even though `player.stop` is itself
   * Fixed=Y. `_cancelOrder` is the real shared logic; both the public
   * `stop()` and the ladder dispatch call it. */
  stop() {
    this._cancelOrder();
  }

  /** @private */
  _cancelOrder() {
    // PLYR-2 addendum: releases/cancels any PathHandle/requestId the order
    // was holding — see move.js's header, "PathHandle lifetime".
    this._pathFollower.cancel(this._nav);
    this._intent.hasMoveOrder = false;
    this._intent.stopRequested = false;
    if (this._actor && typeof this._actors.setState === 'function') {
      this._actors.setState(this._actor, 'idle');
    }
  }

  /** `groundCursor(out?) => Vec3` — where the pointer met the ground plane
   * at the start of the most recent `update()` frame. `Fixed: N`: never
   * call from `fixedUpdate` (nothing here does). Returns `out` when given,
   * else the shared scratch, valid until the next call — the standard
   * `02-api-contracts.md` `out` convention. */
  groundCursor(out) {
    const dst = out || this._cursorScratch;
    dst.x = this._cursor.x;
    dst.y = this._cursor.y;
    dst.z = this._cursor.z;
    return dst;
  }

  // ─── frame ───────────────────────────────────────────────────────────

  /**
   * Presentation + the intent latch (11-flows.md §2.2 position 7). Reads
   * `ctx.input`/`ctx.camera` — the only place in this file that does.
   * @param {number} dt
   * @param {object} ctx
   */
  update(dt, ctx) {
    this._ctx = ctx;

    this._updateGroundCursor(ctx);
    this._latchIntent(ctx);
    this._followCamera(ctx);

    if (this._debugView) this._debugView.update(dt, ctx);
  }

  /**
   * The intent-consuming half of §3 — sub-step P1 of `player.fixedUpdate`.
   * Only the two branches this ticket's boundary covers: priority 3 (stop)
   * and priority 8 (move order; every branch in between needs `skills`/
   * `world`/`physics.overlapCircle`, none of which exist). Never reads
   * `ctx.input` (see the file header) — only `this._intent`, already
   * latched by a *previous* frame's `update()`.
   * @param {number} h - the fixed step, `FIXED_DT`. Never `ctx.time.dt`.
   * @param {object} ctx
   */
  fixedUpdate(h, ctx) {
    if (!this._actor || !this._actor.active) return;
    if (!this._controlEnabled) return; // ladder priority 0

    const intent = this._intent;
    if (intent.sequence !== this._consumedSequence) {
      this._consumedSequence = intent.sequence;
      if (intent.stopRequested) {
        intent.stopRequested = false; // one-shot, consumed
        this._cancelOrder(); // not `this.stop()` — see that method's own comment
      } else if (intent.hasMoveOrder) {
        this.moveOrder(intent.moveX, intent.moveZ);
      }
    }

    this._followOrder(h, ctx);
  }

  dispose() {
    if (this._debugView) {
      this._debugView.dispose();
      this._debugView = null;
    }
    // PLYR-2 addendum: release/cancel any outstanding PathHandle/requestId
    // before this instance goes away — see move.js's header, "PathHandle
    // lifetime".
    this._pathFollower.cancel(this._nav);
    this._ctx = null;
    this._actors = null;
    this._nav = null;
    this._rig = null;
    this._actor = null;
  }

  // ─── internals ───────────────────────────────────────────────────────

  /**
   * §3.3 steps 1-4: NDC from client coordinates, unproject through
   * `ctx.camera`, intersect `y = GROUND_Y` (see the file header for why a
   * constant, not `world.groundHeight`), write `this._cursor`. A no-op,
   * holding the last good cursor, when a camera/canvas/input is not present
   * (a minimal test `ctx`) or the ray is edge-on to the ground.
   * @private
   */
  _updateGroundCursor(ctx) {
    const camera = ctx.camera;
    const canvas = ctx.canvas;
    const input = ctx.input;
    if (!camera || !canvas || !input) return;

    // Guards against reading a stale matrixWorld on the very first frame,
    // before `render` has ever called `renderer.render()` (which is what
    // normally keeps it current — see the file header). Reads
    // position/quaternion, writes matrix/matrixWorld: neither of those is
    // behind RNDR-2's write guard, so this never trips it.
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld();

    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    const pointer = input.pointer;
    const ndcX = (pointer.x / width) * 2 - 1;
    const ndcY = -((pointer.y / height) * 2 - 1);

    unprojectRay(camera, ndcX, ndcY, this._rayOrigin, this._rayDir);
    const t = intersectPlaneY(this._rayOrigin, this._rayDir, GROUND_Y);
    if (t === null) return;

    this._cursor.x = this._rayOrigin.x + this._rayDir.x * t;
    this._cursor.y = GROUND_Y;
    this._cursor.z = this._rayOrigin.z + this._rayDir.z * t;
  }

  /**
   * §3.1/§3.3/§3.5: writes `this._intent` from this frame's input snapshot.
   * The whole latch lives here — `fixedUpdate` never repeats any of it.
   * @private
   */
  _latchIntent(ctx) {
    const input = ctx.input;
    if (!input) return;

    // Read, not yet acted on in this ticket's classification ladder — see
    // the `SHIFT_*_CODE` comment above.
    this._shiftHeld = isShiftHeld(input);

    const intent = this._intent;

    if (input.keyPressed(STOP_KEY_CODE)) {
      intent.stopRequested = true;
      intent.sequence++;
      return; // §3.2: stop outranks a move order latched the same frame.
    }

    const pressed = input.buttonPressed(MOVE_BUTTON);
    const held = input.buttonHeld(MOVE_BUTTON);
    if (!pressed && !held) return; // nothing new — a click's order sticks
    // until fixedUpdate's own arrival/stop logic clears it.

    // §3.3's classification ladder: priorities 1-3 need a ground-item pick,
    // `physics.overlapCircle` and `world.interactableAt` — none of which
    // exist (this ticket's boundary). Every click reaches priority 4.
    intent.hasMoveOrder = true;
    intent.moveX = this._cursor.x;
    intent.moveZ = this._cursor.z;
    if (pressed) intent.sequence++; // §3.5: only the press edge advances it.
  }

  /**
   * §2.2 position 7 / docs/PROGRESS.md O-17: camera follow, dead zone, the
   * one legal write path. No-ops without a live actor/camera/rig (a
   * minimal test `ctx`).
   * @private
   */
  _followCamera(ctx) {
    const actor = this._actor;
    const camera = ctx.camera;
    if (!actor || !camera || !this._rig || !ctx.config) return;

    const alpha = ctx.time ? ctx.time.alpha : 0;
    const focusX = actor.prevX + (actor.x - actor.prevX) * alpha;
    const focusZ = actor.prevZ + (actor.z - actor.prevZ) * alpha;

    const camFocus = this._camFocus;
    const dx = focusX - camFocus.x;
    const dz = focusZ - camFocus.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > CAMERA_DEAD_ZONE_M) {
      // Pull the focus toward the actor, leaving exactly the dead-zone
      // radius of slack — a snap-to-the-edge follow, not an elastic spring:
      // frame-rate-independent with no extra smoothing state to tune.
      const pull = (dist - CAMERA_DEAD_ZONE_M) / dist;
      camFocus.x += dx * pull;
      camFocus.z += dz * pull;
    }

    this._rig.solveOrbitLock(
      camFocus.x,
      camFocus.y,
      camFocus.z,
      ctx.config.camPitch,
      0,
      ctx.config.camDist,
      this._camPos,
      this._camLookAt,
    );

    const camPos = this._camPos;
    const camLookAt = this._camLookAt;
    this._rig.withCameraWrite(camera, () => {
      camera.position.set(camPos.x, camPos.y, camPos.z);
      camera.lookAt(camLookAt.x, camLookAt.y, camLookAt.z);
    });
  }

  /**
   * Steers toward the current order every fixed step (see the file header
   * — this is deliberately NOT gated by the sequence latch: six ticks of
   * walking need six `actors.moveTo()` calls).
   *
   * PLYR-2 addendum: the straight-line-only walk is now `PathFollower`'s
   * `MODE_DIRECT`/`nav.version===0` fallback, one branch among the full
   * §3.4 state machine — see `./move.js`'s header. This method is reduced
   * to exactly the delegation + the one bit of bookkeeping `move.js` cannot
   * do itself (it never touches `Intent`): clearing `intent.hasMoveOrder`
   * the instant the order stops being active, whether that is because it
   * arrived (step 12) or was dropped (a mid-walk repath finding the
   * destination no longer reachable).
   * @private
   */
  _followOrder(h) {
    if (!this._pathFollower.active) return;
    this._pathFollower.step(h, this._nav, this._actors, this._actor);
    if (!this._pathFollower.active) this._intent.hasMoveOrder = false;
  }
}
