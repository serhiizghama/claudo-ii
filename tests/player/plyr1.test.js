// tests/player/plyr1.test.js
//
// PLYR-1 acceptance tests for src/player/index.js (PlayerSystem) and
// src/dev/debugview.js (DebugView). `node:test` + `node:assert/strict` only
// — no framework (12-testing.md P6).
//
// Scope: click-to-move intent + the latch, straight-line movement through
// `actors.moveTo`, arrival, camera follow through the guarded rig. `nav`,
// `world`, `ui`, `skills`, `items` do not exist — every test below drives
// the real `boot()` sequence (render + physics + actors + player, exactly
// what `src/main.js` now registers) so the intent latch, the fixed-step
// loop and the camera guard are exercised through the real engine, not a
// hand-rolled substitute.
//
// `three` IS used in this file (a real `THREE.PerspectiveCamera`/`Scene`,
// same as tests/render/camera.test.js) — only `src/player/index.js` itself
// is required to stay `three`-free; see the "module loads in Node" test at
// the bottom for that asserted directly against the source text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { boot } from '../../src/main.js';
import { FIXED_DT, MAX_SUBSTEPS } from '../../src/core/engine.js';
import {
  PlayerSystem,
  isShiftHeld,
  computeArriveRadius,
  unprojectRay,
  intersectPlaneY,
} from '../../src/player/index.js';
import { Input } from '../../src/core/input.js';
import * as THREE from 'three';
import { DebugView } from '../../src/dev/debugview.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Matches tests/render/camera.test.js's own stub — a canvas shaped enough
 * for `RenderSystem.init()`'s degraded (no-GPU/Node) path and for
 * `player`'s own `clientWidth`/`clientHeight` reads. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Boots the real engine (render + physics + actors + player) with a stub
 * canvas, in lockstep (no rAF under Node — `boot()`'s own fallback). */
async function bootGame(opts = {}) {
  return boot({ canvas: makeCanvas(), deterministic: true, global: {}, ...opts });
}

/** Fires a full click (down then up) at client coordinates `(cx, cy)` on
 * `input` — landing both edges in the same raw buffer before the next
 * `beginFrame()`, exactly like a fast real click: the next frame's snapshot
 * sees `pressed: true, held: false`, and every frame after that sees
 * neither. This is what makes an order "stick" cleanly across frames
 * without the continuing-hold branch (§3.5) refreshing it — see
 * src/player/index.js's header for why that distinction matters. */
function clickAt(input, cx, cy) {
  input._onPointerDown({ clientX: cx, clientY: cy, button: 0 });
  input._onPointerUp({ clientX: cx, clientY: cy, button: 0 });
}

// ---------------------------------------------------------------------------
// Spawn — a player actor exists without a character-creation flow
// ---------------------------------------------------------------------------

test('boot(): a player-kind actor exists after init, team 0, at the origin', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  assert.ok(actor, 'player.actor must not be null');
  assert.equal(actor.kind, 'player');
  assert.equal(actor.team, 0);
  assert.equal(actor.x, 0);
  assert.equal(actor.z, 0);
  assert.equal(ctx.get('actors').player, actor, 'actors.player must be the same record');
});

// ---------------------------------------------------------------------------
// The latch: one order per frame, regardless of fixed-step count
// ---------------------------------------------------------------------------

test('Intent.sequence advances exactly once on a click, not once per fixed step', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const sequenceBefore = player.intent.sequence;

  // A click at screen centre unprojects to (0,0,0) with the camera looking
  // straight at the origin-centred focus — see the "groundCursor" test
  // below for that verified directly. Aim off-centre here purely so the
  // resulting move order is far enough away that six fixed steps do not
  // reach arrival mid-test (that path is covered separately below).
  clickAt(ctx.input, 900, 200);

  // Frame A: engine.frame() runs fixedUpdate BEFORE update() (src/core/
  // engine.js phases 2 then 3) — this frame's fixedUpdate calls still see
  // the OLD intent; update(), at the end of this same call, is what latches
  // the click just fired above.
  engine.frame(FIXED_DT);
  assert.equal(player.intent.sequence, sequenceBefore + 1, 'update() must latch exactly one new sequence value');
  assert.equal(player.intent.hasMoveOrder, true);

  const sequenceAfterLatch = player.intent.sequence;

  let moveOrderCalls = 0;
  const realMoveOrder = player.moveOrder.bind(player);
  player.moveOrder = (x, z) => {
    moveOrderCalls++;
    realMoveOrder(x, z);
  };

  // Frame B: a huge rawDt clamps to the engine's own RAW_DT_CLAMP, which is
  // exactly MAX_SUBSTEPS * FIXED_DT — deterministically six fixed steps.
  const steps = engine.frame(10);
  assert.equal(steps, MAX_SUBSTEPS, 'this frame must run the full six-step spiral-guard clamp');
  assert.equal(moveOrderCalls, 1, 'six fixed steps in one frame must issue exactly one order');
  assert.equal(player.intent.sequence, sequenceAfterLatch, 'no new press landed — sequence must not move again');
});

test('a moving order still steps the actor every one of the six fixed steps', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  clickAt(ctx.input, 900, 200);
  engine.frame(FIXED_DT); // latch
  const xBeforeWalk = actor.x;
  const zBeforeWalk = actor.z;

  engine.frame(10); // six fixed steps, one latched order

  const moved = Math.sqrt((actor.x - xBeforeWalk) ** 2 + (actor.z - zBeforeWalk) ** 2);
  assert.ok(moved > 0, 'the actor must have moved across the six-step frame');
});

test('fixedUpdate never reads ctx.input — a frame with ctx.input reading forbidden still walks fine', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  clickAt(ctx.input, 900, 200);
  engine.frame(FIXED_DT); // legitimate latch, through update() — allowed to read ctx.input

  const guardedCtx = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'input') {
        throw new Error('player.fixedUpdate must never read ctx.input');
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const xBefore = actor.x;
  assert.doesNotThrow(() => {
    for (let i = 0; i < MAX_SUBSTEPS; i++) player.fixedUpdate(FIXED_DT, guardedCtx);
  });
  assert.notEqual(actor.x, xBefore, 'movement must still happen with ctx.input access forbidden');
});

// ---------------------------------------------------------------------------
// Classification: a plain click writes hasMoveOrder + coordinates
// ---------------------------------------------------------------------------

test('a click at screen centre latches a move order at the camera focus (origin)', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const canvas = ctx.canvas;

  clickAt(ctx.input, canvas.clientWidth / 2, canvas.clientHeight / 2);
  engine.frame(FIXED_DT);

  assert.equal(player.intent.hasMoveOrder, true);
  assert.ok(Math.abs(player.intent.moveX) < 1e-6, `moveX should land on the origin, got ${player.intent.moveX}`);
  assert.ok(Math.abs(player.intent.moveZ) < 1e-6, `moveZ should land on the origin, got ${player.intent.moveZ}`);
});

test('a click right of centre lands further along +X than a click at centre', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const canvas = ctx.canvas;

  clickAt(ctx.input, canvas.clientWidth * 0.9, canvas.clientHeight / 2);
  engine.frame(FIXED_DT);

  assert.ok(player.intent.moveX > 0.5, `expected a clearly positive-X cursor, got ${player.intent.moveX}`);
});

// ---------------------------------------------------------------------------
// Arrival: reaches the target and stops without oscillating
// ---------------------------------------------------------------------------

test('the actor arrives at a clicked point and stops — no overshoot, no oscillation', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  const targetX = 2;
  const targetZ = 0;
  // Aim the click straight along +X so the exact ground point is
  // predictable without depending on the unprojection test above.
  player.moveOrder(targetX, targetZ);
  // Force the intent's own latch path too, so this exercises the real
  // fixedUpdate ladder rather than only the direct moveOrder() call —
  // hasMoveOrder must reflect the resulting walk.
  player.intent.hasMoveOrder = true;
  player.intent.moveX = targetX;
  player.intent.moveZ = targetZ;
  player.intent.sequence++;

  let steps = 0;
  const maxSteps = 600; // generous — 2 m / 4.2 m/s ≈ 29 steps at 60 Hz
  while (player.intent.hasMoveOrder && steps < maxSteps) {
    engine.frame(FIXED_DT);
    steps++;
  }

  assert.ok(steps < maxSteps, 'the order must clear well before the generous step budget runs out');
  const arriveRadius = computeArriveRadius(actor);
  const dist = Math.sqrt((actor.x - targetX) ** 2 + (actor.z - targetZ) ** 2);
  assert.ok(dist <= arriveRadius + 1e-6, `actor should be within arriveRadius (${arriveRadius}), was ${dist}`);

  const xAtArrival = actor.x;
  const zAtArrival = actor.z;
  for (let i = 0; i < 20; i++) engine.frame(FIXED_DT);
  assert.ok(Math.abs(actor.x - xAtArrival) < 1e-9, 'actor must not drift/oscillate after arrival');
  assert.ok(Math.abs(actor.z - zAtArrival) < 1e-9, 'actor must not drift/oscillate after arrival');
});

test('movement goes through actors.moveTo, never a direct actor.x/z write', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const actor = player.actor;

  let moveToCalls = 0;
  const realMoveTo = actors.moveTo.bind(actors);
  actors.moveTo = (a, dx, dz) => {
    moveToCalls++;
    return realMoveTo(a, dx, dz);
  };

  clickAt(ctx.input, 900, 200);
  engine.frame(FIXED_DT); // latch
  for (let i = 0; i < 5; i++) engine.frame(FIXED_DT);

  assert.ok(moveToCalls > 0, 'actors.moveTo must be the thing driving movement');
  assert.ok(actor.x !== 0 || actor.z !== 0, 'the actor must actually have moved');
});

test('stop (S key) cancels the current order', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');

  clickAt(ctx.input, 900, 200);
  engine.frame(FIXED_DT);
  engine.frame(FIXED_DT); // one real step of walking
  assert.equal(player.intent.hasMoveOrder, true);

  ctx.input._onKeyDown({ code: 'KeyS', repeat: false });
  ctx.input._onKeyUp({ code: 'KeyS' });
  engine.frame(FIXED_DT); // latch the stop request
  engine.frame(FIXED_DT); // consume it

  assert.equal(player.intent.hasMoveOrder, false, 'stop must clear the move order');
  assert.equal(player.intent.stopRequested, false, 'the one-shot stop request must be consumed');
});

// ---------------------------------------------------------------------------
// Shift — both physical keys (docs/PROGRESS.md O-6)
// ---------------------------------------------------------------------------

test('isShiftHeld recognises ShiftLeft alone', () => {
  const input = new Input();
  input._onKeyDown({ code: 'ShiftLeft', repeat: false });
  input.beginFrame();
  assert.equal(isShiftHeld(input), true);
});

test('isShiftHeld recognises ShiftRight alone', () => {
  const input = new Input();
  input._onKeyDown({ code: 'ShiftRight', repeat: false });
  input.beginFrame();
  assert.equal(isShiftHeld(input), true);
});

test('isShiftHeld is false when neither Shift key is held', () => {
  const input = new Input();
  input.beginFrame();
  assert.equal(isShiftHeld(input), false);
});

test('a click while Shift is held still latches a plain move order (priority 4 is unaffected)', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');

  ctx.input._onKeyDown({ code: 'ShiftRight', repeat: false });
  clickAt(ctx.input, 900, 200);
  engine.frame(FIXED_DT);

  assert.equal(player.intent.hasMoveOrder, true, 'Shift must not suppress the only classification branch in scope');
});

// ---------------------------------------------------------------------------
// Camera: follows the player, only ever writes through withCameraWrite
// ---------------------------------------------------------------------------

test('nobody but player can write ctx.camera (the guard still holds after boot)', async () => {
  const { ctx } = await bootGame();
  assert.throws(() => ctx.camera.position.set(0, 0, 0), /illegal write/);
});

test('the camera follows the player once it drifts past the dead zone', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const camBefore = { x: ctx.camera.position.x, y: ctx.camera.position.y, z: ctx.camera.position.z };

  player.moveOrder(5, 0);
  player.intent.hasMoveOrder = true;
  player.intent.moveX = 5;
  player.intent.moveZ = 0;
  player.intent.sequence++;

  for (let i = 0; i < 90; i++) engine.frame(FIXED_DT); // well past the 1.5 m dead zone at 4.2 m/s

  const dx = ctx.camera.position.x - camBefore.x;
  const dz = ctx.camera.position.z - camBefore.z;
  const camMoved = Math.sqrt(dx * dx + dz * dz);
  assert.ok(camMoved > 0.1, `camera should have followed the player, moved ${camMoved}`);
});

test('a sub-dead-zone walk does not move the camera at all', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');

  // 0.5 m is comfortably past the 0.25 m arriveRadius (so the actor
  // actually walks several steps, not an instant no-op arrival) yet
  // comfortably under the 1.5 m camera dead zone for the whole walk.
  player.moveOrder(0.5, 0);
  player.intent.hasMoveOrder = true;
  player.intent.moveX = 0.5;
  player.intent.moveZ = 0;
  player.intent.sequence++;

  engine.frame(FIXED_DT); // latch
  const camBefore = { x: ctx.camera.position.x, z: ctx.camera.position.z };
  const actor = player.actor;
  for (let i = 0; i < 15 && player.intent.hasMoveOrder; i++) engine.frame(FIXED_DT);

  assert.ok(actor.x > 0, 'the actor must actually have walked toward the target');
  assert.ok(actor.x <= 0.5 + 1e-6, 'the actor must not have overshot the 0.5 m target');
  assert.equal(ctx.camera.position.x, camBefore.x, 'a sub-dead-zone walk must not nudge the camera');
  assert.equal(ctx.camera.position.z, camBefore.z, 'a sub-dead-zone walk must not nudge the camera');
});

// ---------------------------------------------------------------------------
// Pure helpers — unprojectRay / intersectPlaneY / computeArriveRadius
// ---------------------------------------------------------------------------

test('unprojectRay + intersectPlaneY: a camera looking straight down at the origin hits (0,0,0)', () => {
  // Not this project's fixed-pitch rig transform — a hand-built, valid
  // orthonormal camera basis, chosen so the maths is checkable by hand.
  // three's matrixWorld is column-major, four contiguous floats per column:
  // col0 (0-2) = right, col1 (4-6) = up, col2 (8-10) = local +Z (a camera
  // looks down its own -Z, so unprojectRay negates this column to get
  // "forward"), col3 (12-14) = world-space translation.
  //   right   = (1, 0, 0)
  //   up      = (0, 0,-1)
  //   local+Z = (0, 1, 0)  =>  forward = -(0,1,0) = (0,-1,0), straight down
  //   translation = (0, 10, 0) — 10 m up, over the origin
  const camera = {
    matrixWorld: {
      elements: [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 10, 0, 1,
      ],
    },
    fov: 60,
    aspect: 1,
  };

  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 0 };
  unprojectRay(camera, 0, 0, origin, dir);

  assert.ok(Math.abs(origin.y - 10) < 1e-9);
  assert.ok(Math.abs(dir.x) < 1e-9);
  assert.ok(Math.abs(dir.z) < 1e-9);
  assert.ok(dir.y < 0, 'a screen-centre ray must point straight down');

  const t = intersectPlaneY(origin, dir, 0);
  assert.ok(t !== null);
  const hitX = origin.x + dir.x * t;
  const hitY = origin.y + dir.y * t;
  const hitZ = origin.z + dir.z * t;
  assert.ok(Math.abs(hitX) < 1e-9);
  assert.ok(Math.abs(hitY) < 1e-9);
  assert.ok(Math.abs(hitZ) < 1e-9);
});

test('intersectPlaneY returns null for a ray parallel to the ground', () => {
  const origin = { x: 0, y: 5, z: 0 };
  const dir = { x: 1, y: 0, z: 0 };
  assert.equal(intersectPlaneY(origin, dir, 0), null);
});

test('computeArriveRadius: 11-flows.md §3.4 step 12 formula, verbatim', () => {
  assert.equal(computeArriveRadius({ radius: 0.36 }), 0.25); // 0.36*0.6=0.216 -> floor 0.25
  assert.equal(computeArriveRadius({ radius: 1.0 }), 0.6); // 1.0*0.6=0.6 -> above the floor
});

// ---------------------------------------------------------------------------
// src/dev/debugview.js — the temporary M0 capsule/ground view
// ---------------------------------------------------------------------------

function makeDebugViewCtx(actorOverrides = {}) {
  const scene = new THREE.Scene();
  const actor = { radius: 0.36, height: 1.8, x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, ...actorOverrides };
  return {
    ctx: {
      scene,
      time: { alpha: 0 },
      get(id) {
        if (id === 'actors') return { player: actor };
        throw new Error(`stub: '${id}' not available`);
      },
    },
    scene,
    actor,
  };
}

test('DebugView.init: adds a ground plane and a capsule sized off the player actor', () => {
  const { ctx, scene, actor } = makeDebugViewCtx({ radius: 0.5, height: 2 });
  const view = new DebugView();
  view.init(ctx);

  assert.equal(scene.children.length, 2, 'exactly the ground plane and the capsule');
  const capsule = scene.children.find((m) => m.geometry.type === 'CapsuleGeometry');
  const ground = scene.children.find((m) => m.geometry.type === 'PlaneGeometry');
  assert.ok(capsule, 'capsule mesh must be present');
  assert.ok(ground, 'ground mesh must be present');
  assert.equal(capsule.position.y, actor.y + actor.height / 2);

  view.dispose();
});

test('DebugView.update: follows the actor across fixed steps (zero allocation, mutates in place)', () => {
  const { ctx, actor } = makeDebugViewCtx();
  const view = new DebugView();
  view.init(ctx);

  const capsule = view._capsuleMesh;
  actor.prevX = 0;
  actor.x = 2;
  ctx.time.alpha = 0.5;
  view.update(0, ctx);

  assert.ok(Math.abs(capsule.position.x - 1) < 1e-9, 'must read the interpolated (alpha-lerped) position');

  view.dispose();
});

test('DebugView.dispose: removes meshes from the scene and frees GPU resources', () => {
  const { ctx, scene } = makeDebugViewCtx();
  const view = new DebugView();
  view.init(ctx);

  const capsuleGeometry = view._capsuleGeometry;
  const groundGeometry = view._groundGeometry;
  let capsuleDisposed = false;
  let groundDisposed = false;
  capsuleGeometry.dispose = () => {
    capsuleDisposed = true;
  };
  groundGeometry.dispose = () => {
    groundDisposed = true;
  };

  view.dispose();

  assert.equal(scene.children.length, 0, 'both meshes must be removed from the scene');
  assert.equal(capsuleDisposed, true);
  assert.equal(groundDisposed, true);
  assert.doesNotThrow(() => view.dispose(), 'a second dispose() must be a safe no-op');
});

// ---------------------------------------------------------------------------
// Module hygiene: src/player/ stays Node/three-free; src/dev/debugview.js
// stays out of its static import graph.
// ---------------------------------------------------------------------------

test('src/player/index.js has no static three or debugview import (source scan)', () => {
  const source = readFileSync(join(__dirname, '../../src/player/index.js'), 'utf8');
  // Blank only comments (never string/template contents — the positive
  // dynamic-import assertion below needs the real string back) so a mention
  // inside a comment (this file has several) never trips the negative
  // checks.
  const commentsMasked = source.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(commentsMasked, /^\s*import[^(]*from\s+["']three["']/m, 'no static three import');
  assert.doesNotMatch(
    commentsMasked,
    /^\s*import\s+["']\.\.\/dev\/debugview\.js["']/m,
    'no static bare debugview import',
  );
  // The one sanctioned dynamic import must be a plain call expression, not a
  // top-level static import declaration.
  assert.match(commentsMasked, /await import\(["']\.\.\/dev\/debugview\.js["']\)/);
});

test('PlayerSystem itself is importable and constructible under plain Node (this file never touched jsdom/three for it)', () => {
  const sys = new PlayerSystem();
  assert.equal(PlayerSystem.id, 'player');
  assert.ok(Array.isArray(PlayerSystem.deps));
  assert.equal(typeof sys.moveOrder, 'function');
  assert.equal(typeof sys.groundCursor, 'function');
});
