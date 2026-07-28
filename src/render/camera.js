// src/render/camera.js
//
// RNDR-2 — the camera rig: a pure orbit-lock solver, the world camera
// builder, and a dev-only guard against illegal writes to `ctx.camera`.
//
// ---------------------------------------------------------------------------
// Scope boundary — read this before adding anything here
// ---------------------------------------------------------------------------
// ARCHITECTURE.md: "The camera is orbit-locked: fixed pitch (config.camPitch,
// default 52°), fixed yaw, distance from config.camDist, smoothly following
// the player. Nothing else may write to it — ask player." That sentence
// splits ownership in two:
//
//   - `render` (this file) owns the RIG: given a focus point and fixed
//     pitch/yaw/distance, what position and orientation does the camera
//     take? That is pure trigonometry and belongs here.
//   - `player` (PLYR-1) owns the MOVEMENT: smoothing the focus point toward
//     the player with a dead zone, cursor peek, and `cameraShake` decay
//     (11-flows.md §2.2 position 7; 02-api-contracts.md §13's `cameraShake`/
//     `setCameraPeek`). None of that lives here — `solveOrbitLock` below
//     takes an already-decided focus point and nothing else.
//
// `solveOrbitLock` is deliberately stateless and reads no clock: it is
// called once per frame from player.update() and must produce the same
// output for the same input every time, with zero allocation (ARCHITECTURE.md
// rule 6) — it writes into caller-owned `out` objects, plain `{x,y,z}`
// numbers, never a `THREE.Vector3` (02-api-contracts.md's `out` convention:
// gameplay-adjacent data crossing a subsystem boundary must stay readable
// without `three`).
//
// ---------------------------------------------------------------------------
// The write guard — what it catches and how
// ---------------------------------------------------------------------------
// `installCameraWriteGuard` replaces `camera.position` and `camera.quaternion`
// with a `Proxy` whose `set` trap throws unless the write happens inside
// `withCameraWrite`. This is a per-property-write intercept, not a
// method-by-method wrapper (`.set()`, `.copy()`, `.setFromEuler()`, ...) —
// deliberately, because three r180's `Quaternion` mutates through private
// `_x/_y/_z/_w` fields internally (`setFromRotationMatrix`, `slerp`,
// `premultiply`, ... all assign those directly, not through the public `x`
// accessor), so wrapping only the public accessor would miss most real
// writes. A `Proxy`'s `set` trap fires for *any* property assignment on the
// wrapped object, including those private-looking fields, and — because a
// method called as `proxy.method(...)` runs with `this === proxy` — it also
// fires for every `this.<field> = value` a prototype method performs
// internally. One trap, comprehensive coverage, no method list to keep in
// sync with three's internals release to release.
//
// `withCameraWrite(camera, fn)` is the one sanctioned bypass — it flips the
// guard's lock open for the synchronous extent of `fn`, then closes it in a
// `finally`. Safe because JS is single-threaded and every subsystem's
// update()/fixedUpdate() runs to completion before the next one starts, so
// no other code can observe the unlocked window. `player` reaches it through
// `ctx.get('render').cameraRig.withCameraWrite` (src/render/index.js exposes
// the getter; ARCHITECTURE.md rule 2 forbids `player` importing this module
// directly).
//
// Cost: one `Proxy` indirection per position/quaternion field write, dev
// only. `camera.position.x` reads (the hot path — `updateMatrixWorld` reads
// position/quaternion every frame to compose the matrix) go through the
// Proxy's default `get` trap, which is a plain pass-through — no branch, no
// allocation. Outside dev the guard is never installed at all: `buildWorldCamera`
// checks `import.meta.env.DEV` (see `CAMERA_WRITE_GUARD_ENABLED` below) and a
// production camera's `position`/`quaternion` stay the plain, un-proxied
// `THREE.Vector3`/`Quaternion` instances — zero indirection, zero cost.
//
// ---------------------------------------------------------------------------
// Near/far — assigned, not derived from any spec number
// ---------------------------------------------------------------------------
// See WORLD_CAMERA_NEAR/WORLD_CAMERA_FAR below for the full derivation. No
// docs/spec/*.md file gives a near/far pair for the world camera (checked);
// CORE-9 left 0.1/500 as an explicit placeholder for this ticket to replace.

import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// The pure orbit-lock solver
// ---------------------------------------------------------------------------

/**
 * Given a focus point and fixed pitch/yaw/distance, computes the camera's
 * world position and the point it should look at. Pure, stateless, zero
 * allocation — writes into `outPosition`/`outLookAt` (plain `{x,y,z}`
 * objects the caller owns and reuses every frame) and returns `outPosition`.
 *
 * No smoothing, no dead zone, no clock read, no THREE types in or out — see
 * this file's header for why (PLYR-1 owns all of that on top of this).
 *
 * Convention: yaw 0 puts the camera behind the focus point along +Z (the
 * same placement CORE-9's placeholder `buildWorldCamera` used with
 * focus = origin); yaw rotates that offset around +Y, sin/cos on X/Z. The
 * game has no config knob for yaw (ARCHITECTURE.md: "fixed yaw") — the
 * parameter exists for a complete, testable, general solver, and every real
 * caller today passes 0.
 *
 * @param {number} focusX
 * @param {number} focusY
 * @param {number} focusZ
 * @param {number} pitchDeg - degrees below horizontal (config.camPitch)
 * @param {number} yawDeg - degrees around +Y (no config knob today; pass 0)
 * @param {number} distance - metres from focus to camera (config.camDist)
 * @param {{x:number,y:number,z:number}} outPosition - written in place
 * @param {{x:number,y:number,z:number}} outLookAt - written in place (today
 *   always equal to the focus point — kept as a separate output so a future
 *   eye-level offset only has to change here, not every caller)
 * @returns {{x:number,y:number,z:number}} outPosition
 */
export function solveOrbitLock(focusX, focusY, focusZ, pitchDeg, yawDeg, distance, outPosition, outLookAt) {
  const pitchRad = pitchDeg * DEG2RAD;
  const yawRad = yawDeg * DEG2RAD;

  const horizontal = distance * Math.cos(pitchRad);
  const height = distance * Math.sin(pitchRad);

  outPosition.x = focusX + horizontal * Math.sin(yawRad);
  outPosition.y = focusY + height;
  outPosition.z = focusZ + horizontal * Math.cos(yawRad);

  outLookAt.x = focusX;
  outLookAt.y = focusY;
  outLookAt.z = focusZ;

  return outPosition;
}

// ---------------------------------------------------------------------------
// Dev-only write guard
// ---------------------------------------------------------------------------

/**
 * `true` unless we can positively prove a Vite production build
 * (`import.meta.env.DEV === false`, which Vite replaces with a literal at
 * build time — the exact `import.meta.env.DEV` expression has to appear
 * unaliased for that static replacement to fire, so don't hoist it into a
 * variable). Plain Node (this project's test runner: `import.meta.env` is
 * `undefined`, no Vite transform ever ran) and Vite's dev server
 * (`DEV === true`) both fall through to "guard on" — the safe default
 * whenever production can't be proven. `typeof import.meta.env ===
 * 'undefined'` short-circuits the `||` before the third clause ever touches
 * `.DEV`, so this never throws under plain Node.
 */
const CAMERA_WRITE_GUARD_ENABLED =
  typeof import.meta === 'undefined' ||
  typeof import.meta.env === 'undefined' ||
  import.meta.env.DEV !== false;

/** camera -> { unlocked: boolean }. A camera with no entry here never had
 * the guard installed (production, or a caller that built its own plain
 * THREE.Camera) — `withCameraWrite` degrades to a bare `fn()` call for it,
 * at zero extra cost. WeakMap keys are GC'd with the camera; nothing to
 * release in a `dispose()`. */
const cameraLocks = new WeakMap();

/**
 * Wraps `target` (a `THREE.Vector3` or `THREE.Quaternion` instance — never
 * the class prototype) in a `Proxy` whose `set` trap throws unless `lock`
 * is open. See this file's header for why a property-set trap, not a
 * method-list, is what catches every real write.
 * @param {object} target
 * @param {{unlocked:boolean}} lock
 * @param {string} label - 'position' | 'quaternion', for the error message
 */
function guardVector(target, lock, label) {
  return new Proxy(target, {
    set(obj, prop, value, receiver) {
      if (!lock.unlocked) {
        throw new Error(
          `render/camera: illegal write to ctx.camera.${label}.${String(prop)}. ` +
            `Only 'player' may write the camera transform ` +
            `(docs/spec/02-api-contracts.md §13, player: "Never write ctx.camera. Ask player."). ` +
            `Legal writers go through ctx.get('render').cameraRig.withCameraWrite(camera, fn).`,
        );
      }
      return Reflect.set(obj, prop, value, receiver);
    },
  });
}

/**
 * Installs the write guard on `camera.position`/`camera.quaternion` and
 * registers its lock in `cameraLocks`. Only called from `buildWorldCamera`,
 * and only when `CAMERA_WRITE_GUARD_ENABLED`.
 *
 * `Object.defineProperty`, not a plain `camera.position = ...` assignment:
 * three r180's `Object3D` constructor defines `position`/`quaternion` as
 * own properties with `writable: false` (`configurable: true` — see
 * three's own source; a plain reassignment throws
 * `TypeError: Cannot assign to read only property` in strict mode, which
 * ESM always is). Redefining with `configurable: true` preserved keeps
 * that same shape — nothing downstream that reads `Object.getOwnPropertyDescriptor`
 * sees a difference — while swapping the value for the guarded Proxy.
 * @param {THREE.Camera} camera
 */
function installCameraWriteGuard(camera) {
  const lock = { unlocked: false };
  Object.defineProperty(camera, 'position', {
    value: guardVector(camera.position, lock, 'position'),
    writable: false,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(camera, 'quaternion', {
    value: guardVector(camera.quaternion, lock, 'quaternion'),
    writable: false,
    enumerable: true,
    configurable: true,
  });
  cameraLocks.set(camera, lock);
}

/**
 * The one sanctioned path to write a guarded camera's transform
 * (02-api-contracts.md §13's exception for `player`). Opens the lock for
 * the synchronous extent of `fn`, always closes it again afterward — even
 * if `fn` throws, in which case that exception still propagates out of
 * this call.
 *
 * Safe to call on any camera, guarded or not: a camera the guard was never
 * installed on (production, or a plain `THREE.Camera` built outside this
 * module) has no entry in `cameraLocks`, so this degrades to a bare `fn()`
 * call — `player` does not need to branch on dev vs. prod itself.
 *
 * Reached at runtime via `ctx.get('render').cameraRig.withCameraWrite`
 * (ARCHITECTURE.md rule 2 — `player` cannot import this module).
 * @param {THREE.Camera} camera
 * @param {() => void} fn
 */
export function withCameraWrite(camera, fn) {
  const lock = cameraLocks.get(camera);
  if (!lock) {
    fn();
    return;
  }
  lock.unlocked = true;
  try {
    fn();
  } finally {
    lock.unlocked = false;
  }
}

// ---------------------------------------------------------------------------
// The world camera
// ---------------------------------------------------------------------------

/** FOV, per 11-flows.md §1 B3 / IMPLEMENTATION_PLAN.md §5 ("FOV 35°"). */
export const WORLD_CAMERA_FOV = 35;

/**
 * Clip planes. No `docs/spec/*.md` file gives numbers for these (checked) —
 * CORE-9 shipped `0.1/500` as an explicit placeholder for this ticket.
 * Assigned here from the rig's own fixed geometry, not derived from any
 * spec citation:
 *
 * At pitch 52°/distance 22 m (config.camPitch/camDist) and FOV 35°
 * (half-angle 17.5°), the closest ground point the bottom screen edge can
 * ever show is
 *   cameraHeight / sin(pitch + halfFov) = (22·sin52°) / sin(69.5°) ≈ 18.5 m
 * and the farthest the top edge shows is
 *   cameraHeight / sin(pitch − halfFov) = (22·sin52°) / sin(34.5°) ≈ 30.6 m,
 * stretching to roughly 35 m at the screen corners once the wide-aspect
 * horizontal FOV is folded in. That lands close to
 * IMPLEMENTATION_PLAN.md §5's shadow-cascade reach ("2–3 каскада, дистанция
 * 40 м") — the rig's own visible-ground geometry and the planned shadow
 * distance agree almost exactly, which is the actual basis for FAR below,
 * not the 96×96 m zone size (irrelevant here: this is a fixed local rig
 * that always frames a ring around the player, never the whole zone,
 * regardless of how big the zone is).
 *
 *   NEAR = 1  — nothing the frustum can ever show is closer than ~18.5 m;
 *               1 m leaves an 18x margin for PLYR-1's camera peek/shake
 *               (small perturbations on top of the rig's base transform)
 *               without clipping, while keeping the near plane far enough
 *               from 0 that depth-buffer precision — most sensitive near
 *               the near plane on a standard (non-reversed) depth buffer —
 *               isn't starved the way a near of 0.1 would starve it.
 *   FAR  = 60  — covers the ~35 m corner distance and the 40 m shadow reach
 *               with margin for terrain/props above the ground plane.
 *               far/near = 60, versus the 500/0.1 = 5000 the placeholder
 *               shipped with — roughly 80x less depth range to spread the
 *               same precision across.
 *
 * Not verified against real shadow-cascade code (RNDR-4, not written yet)
 * or a sky dome (SKY-1, not written yet) — flagged in this ticket's report:
 * if `sky` draws literal dome geometry rather than a depth-independent
 * technique, that geometry must stay under ~55 m radius or switch technique,
 * since it would otherwise clip against this FAR.
 */
export const WORLD_CAMERA_NEAR = 1;
export const WORLD_CAMERA_FAR = 60;

const _buildPosition = { x: 0, y: 0, z: 0 };
const _buildLookAt = { x: 0, y: 0, z: 0 };

/**
 * Builds the world camera: FOV 35, orbit-locked at `config.camPitch`/
 * `config.camDist` around the origin, aspect from `width`/`height`. A
 * plain function — no live `RenderSystem` instance required — because
 * `ctx.camera` is built at boot stage B3, before any subsystem (including
 * `render`) has been constructed (`src/main.js`'s header, "ctx.time
 * ordering"). `src/main.js` calls this directly (the composition root is
 * not a subsystem — ARCHITECTURE.md rule 2 is about subsystem-to-subsystem
 * imports).
 *
 * In dev (`CAMERA_WRITE_GUARD_ENABLED`), the returned camera's `position`/
 * `quaternion` are guarded — see this file's header. `player` is the only
 * legal writer, reached via `ctx.get('render').cameraRig.withCameraWrite`.
 *
 * @param {object} config - `createConfig()`'s object; reads `camPitch`,
 *   `camDist`. Never hardcode those here — CORE-6 owns the numbers.
 * @param {number} width
 * @param {number} height
 * @returns {THREE.PerspectiveCamera}
 */
export function buildWorldCamera(config, width, height) {
  const camera = new THREE.PerspectiveCamera(
    WORLD_CAMERA_FOV,
    width / Math.max(height, 1),
    WORLD_CAMERA_NEAR,
    WORLD_CAMERA_FAR,
  );

  // Focus is the origin at build time — the initial transform only.
  // Following the player (moving the focus point every frame) is PLYR-1's
  // job, through the same solveOrbitLock this call uses.
  solveOrbitLock(0, 0, 0, config.camPitch, 0, config.camDist, _buildPosition, _buildLookAt);
  camera.position.set(_buildPosition.x, _buildPosition.y, _buildPosition.z);
  camera.lookAt(_buildLookAt.x, _buildLookAt.y, _buildLookAt.z);

  if (CAMERA_WRITE_GUARD_ENABLED) installCameraWriteGuard(camera);

  return camera;
}
