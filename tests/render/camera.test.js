// tests/render/camera.test.js
//
// RNDR-2 acceptance tests. `node:test` + `node:assert/strict` only, matching
// every other suite in this repo (docs/spec/12-testing.md P6, tests/render/rndr1.test.js).
//
// Runs under plain Node — no WebGL2 context, no Vite transform. That second
// point matters here specifically: `import.meta.env` is `undefined` under
// plain Node, so `src/render/camera.js`'s `CAMERA_WRITE_GUARD_ENABLED` falls
// through to "guard on" (see that file's header) — every camera built in
// this suite is guarded, which is exactly what lets the write-guard tests
// below exercise the real thing instead of a stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  solveOrbitLock,
  withCameraWrite,
  buildWorldCamera,
  WORLD_CAMERA_FOV,
  WORLD_CAMERA_NEAR,
  WORLD_CAMERA_FAR,
} from '../../src/render/camera.js';
import { RenderSystem } from '../../src/render/index.js';
import { createConfig } from '../../src/core/config.js';
import { boot } from '../../src/main.js';

const DEG2RAD = Math.PI / 180;

/** Same stub shape as tests/render/rndr1.test.js — no `getContext`, so
 * `RenderSystem.init()` (and `boot()`) always take the degraded, no-GPU
 * path under Node. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    addEventListener() {},
    removeEventListener() {},
  };
}

// ---------------------------------------------------------------------------
// solveOrbitLock — pure math
// ---------------------------------------------------------------------------

test('solveOrbitLock: yaw 0, focus at origin matches the legacy sin/cos placement', () => {
  const pitchDeg = 52;
  const distance = 22;
  const outPosition = { x: 1, y: 1, z: 1 };
  const outLookAt = { x: 1, y: 1, z: 1 };

  const returned = solveOrbitLock(0, 0, 0, pitchDeg, 0, distance, outPosition, outLookAt);

  const pitchRad = pitchDeg * DEG2RAD;
  assert.equal(returned, outPosition, 'writes into and returns outPosition — no new object');
  assert.ok(Math.abs(outPosition.x - 0) < 1e-9);
  assert.ok(Math.abs(outPosition.y - distance * Math.sin(pitchRad)) < 1e-9);
  assert.ok(Math.abs(outPosition.z - distance * Math.cos(pitchRad)) < 1e-9);
  assert.deepEqual(outLookAt, { x: 0, y: 0, z: 0 });
});

test('solveOrbitLock: translates with a non-origin focus point', () => {
  const outPosition = {};
  const outLookAt = {};
  solveOrbitLock(10, 2, -5, 52, 0, 22, outPosition, outLookAt);

  const pitchRad = 52 * DEG2RAD;
  assert.ok(Math.abs(outPosition.x - 10) < 1e-9);
  assert.ok(Math.abs(outPosition.y - (2 + 22 * Math.sin(pitchRad))) < 1e-9);
  assert.ok(Math.abs(outPosition.z - (-5 + 22 * Math.cos(pitchRad))) < 1e-9);
  assert.deepEqual(outLookAt, { x: 10, y: 2, z: -5 });
});

test('solveOrbitLock: distance from focus to computed position is always exactly `distance`', () => {
  const outPosition = {};
  const outLookAt = {};
  for (const yawDeg of [0, 30, 90, 180, 270]) {
    solveOrbitLock(3, 0, -4, 52, yawDeg, 22, outPosition, outLookAt);
    const dx = outPosition.x - 3;
    const dy = outPosition.y - 0;
    const dz = outPosition.z - (-4);
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    assert.ok(Math.abs(dist - 22) < 1e-9, `yaw ${yawDeg}: expected distance 22, got ${dist}`);
  }
});

test('solveOrbitLock: is stateless — reusing the same out objects across calls never leaks stale fields', () => {
  const outPosition = { x: 0, y: 0, z: 0 };
  const outLookAt = { x: 0, y: 0, z: 0 };
  solveOrbitLock(0, 0, 0, 52, 0, 22, outPosition, outLookAt);
  const first = { ...outPosition };
  solveOrbitLock(100, 100, 100, 52, 0, 22, outPosition, outLookAt);
  assert.notDeepEqual(outPosition, first);
  solveOrbitLock(0, 0, 0, 52, 0, 22, outPosition, outLookAt);
  assert.deepEqual(outPosition, first, 'same inputs -> same output, no residual state from the middle call');
});

// ---------------------------------------------------------------------------
// buildWorldCamera — the acceptance criterion: FOV 35, pitch 52, distance 22
// ---------------------------------------------------------------------------

test('buildWorldCamera: FOV 35, aspect from width/height, the assigned near/far', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.ok(camera instanceof THREE.PerspectiveCamera);
  assert.equal(camera.fov, 35);
  assert.equal(WORLD_CAMERA_FOV, 35);
  assert.ok(Math.abs(camera.aspect - 1280 / 720) < 1e-9);
  assert.equal(camera.near, WORLD_CAMERA_NEAR);
  assert.equal(camera.far, WORLD_CAMERA_FAR);
  // The assigned pair itself, pinned so a future edit has to be deliberate:
  // near=1 (nothing visible is ever closer than ~18.5 m — see camera.js's
  // header derivation), far=60 (covers the ~35 m corner distance and the
  // 40 m shadow-cascade reach from IMPLEMENTATION_PLAN.md §5).
  assert.equal(WORLD_CAMERA_NEAR, 1);
  assert.equal(WORLD_CAMERA_FAR, 60);
});

test('buildWorldCamera: orbit-locked at config.camPitch / config.camDist around the origin', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  const dist = camera.position.length();
  assert.ok(Math.abs(dist - config.camDist) < 1e-6, `expected distance ${config.camDist}, got ${dist}`);

  const pitchFromPosition = Math.asin(camera.position.y / dist) / DEG2RAD;
  assert.ok(
    Math.abs(pitchFromPosition - config.camPitch) < 1e-6,
    `expected pitch ${config.camPitch}, got ${pitchFromPosition}`,
  );
});

test('buildWorldCamera: actually faces the focus point (origin)', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  const forward = camera.getWorldDirection(new THREE.Vector3());
  const toOrigin = camera.position.clone().multiplyScalar(-1).normalize();
  assert.ok(forward.distanceTo(toOrigin) < 1e-6);
});

test('buildWorldCamera: survives an aspect-ratio resize without throwing (guard does not interfere)', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.doesNotThrow(() => {
    camera.aspect = 800 / 600;
    camera.updateProjectionMatrix();
  });
  assert.ok(Math.abs(camera.aspect - 800 / 600) < 1e-9);
});

// ---------------------------------------------------------------------------
// The write guard — the other half of the acceptance criterion
// ---------------------------------------------------------------------------

test('guard: unauthorized writes to camera.position throw, by every path that matters', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.throws(() => camera.position.set(1, 2, 3), /illegal write/);
  assert.throws(() => camera.position.copy(new THREE.Vector3(1, 2, 3)), /illegal write/);
  assert.throws(() => {
    camera.position.x = 5;
  }, /illegal write/);
  assert.throws(() => camera.position.addScaledVector(new THREE.Vector3(1, 0, 0), 2), /illegal write/);
});

test('guard: unauthorized writes to camera.quaternion throw, including internal private-field writers', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.throws(() => camera.quaternion.set(0, 0, 0, 1), /illegal write/);
  assert.throws(() => camera.quaternion.copy(new THREE.Quaternion()), /illegal write/);
  assert.throws(() => camera.quaternion.identity(), /illegal write/);
  // setFromEuler/setFromAxisAngle/setFromRotationMatrix all assign the
  // private _x/_y/_z/_w fields directly, not through the public x/y/z/w
  // accessor — this is the exact case a method-list guard would miss.
  assert.throws(() => camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1), /illegal write/);
  // camera.lookAt() mutates the quaternion internally — must be blocked too.
  assert.throws(() => camera.lookAt(1, 2, 3), /illegal write/);
});

test('guard: the error message names the violated contract', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.throws(() => camera.position.set(0, 0, 0), (err) => {
    assert.match(err.message, /ctx\.camera/);
    assert.match(err.message, /player/);
    assert.match(err.message, /02-api-contracts\.md/);
    assert.match(err.message, /cameraRig\.withCameraWrite/);
    return true;
  });
});

test('guard: reads never throw, regardless of lock state', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.doesNotThrow(() => camera.position.x);
  assert.doesNotThrow(() => camera.quaternion.w);
  assert.doesNotThrow(() => camera.position.length());
  assert.doesNotThrow(() => camera.getWorldDirection(new THREE.Vector3()));
});

test('withCameraWrite: the sanctioned path opens the lock, writes land, then it re-locks', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  withCameraWrite(camera, () => {
    camera.position.set(5, 6, 7);
    camera.quaternion.set(0, 0, 0, 1);
  });

  assert.equal(camera.position.x, 5);
  assert.equal(camera.position.y, 6);
  assert.equal(camera.position.z, 7);
  assert.equal(camera.quaternion.w, 1);

  // Re-armed after the callback returns.
  assert.throws(() => camera.position.set(0, 0, 0), /illegal write/);
});

test('withCameraWrite: relocks even when fn throws, and the original error still propagates', () => {
  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);

  assert.throws(
    () =>
      withCameraWrite(camera, () => {
        camera.position.set(9, 9, 9);
        throw new Error('boom');
      }),
    /boom/,
  );

  assert.equal(camera.position.x, 9, 'the write before the throw still landed');
  assert.throws(() => camera.position.set(0, 0, 0), /illegal write/, 'lock closed again despite the throw');
});

test('withCameraWrite: a camera the guard was never installed on just runs fn (zero-cost passthrough)', () => {
  const rawCamera = new THREE.PerspectiveCamera(35, 16 / 9, 1, 60);

  assert.doesNotThrow(() => rawCamera.position.set(1, 2, 3));
  let ran = false;
  withCameraWrite(rawCamera, () => {
    ran = true;
    rawCamera.position.set(4, 5, 6);
  });
  assert.equal(ran, true);
  assert.equal(rawCamera.position.x, 4);
});

// ---------------------------------------------------------------------------
// RenderSystem.cameraRig — the ctx.get('render') handoff to `player`
// ---------------------------------------------------------------------------

test("RenderSystem.cameraRig: exposes the exact solveOrbitLock/withCameraWrite exports", async () => {
  const sys = new RenderSystem();
  await sys.init({ canvas: makeCanvas(), scene: new THREE.Scene(), uiScene: new THREE.Scene() });

  assert.equal(sys.cameraRig.solveOrbitLock, solveOrbitLock);
  assert.equal(sys.cameraRig.withCameraWrite, withCameraWrite);
  assert.equal(sys.cameraRig, sys.cameraRig, 'same object every call — cacheable by player.init()');
});

test('RenderSystem.cameraRig: player-style usage — solve, then write through the gate', async () => {
  const sys = new RenderSystem();
  await sys.init({ canvas: makeCanvas(), scene: new THREE.Scene(), uiScene: new THREE.Scene() });

  const config = createConfig({ quality: 'high', deterministic: true });
  const camera = buildWorldCamera(config, 1280, 720);
  const rig = sys.cameraRig;

  const outPosition = {};
  const outLookAt = {};
  rig.solveOrbitLock(1, 0, 1, config.camPitch, 0, config.camDist, outPosition, outLookAt);

  assert.doesNotThrow(() => {
    rig.withCameraWrite(camera, () => {
      camera.position.set(outPosition.x, outPosition.y, outPosition.z);
      camera.lookAt(outLookAt.x, outLookAt.y, outLookAt.z);
    });
  });
  assert.ok(Math.abs(camera.position.x - outPosition.x) < 1e-9);
});

// ---------------------------------------------------------------------------
// End-to-end through the real boot sequence
// ---------------------------------------------------------------------------

test('boot(): ctx.camera meets the acceptance criterion — FOV 35, pitch 52, distance 22', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });

  assert.equal(ctx.camera.fov, 35);
  const dist = ctx.camera.position.length();
  assert.ok(Math.abs(dist - ctx.config.camDist) < 1e-6);
  const pitch = Math.asin(ctx.camera.position.y / dist) / DEG2RAD;
  assert.ok(Math.abs(pitch - ctx.config.camPitch) < 1e-6);
  assert.equal(ctx.camera.near, WORLD_CAMERA_NEAR);
  assert.equal(ctx.camera.far, WORLD_CAMERA_FAR);
});

test('boot(): nobody but player can write ctx.camera — a stray write from anywhere else throws', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });

  assert.throws(() => ctx.camera.position.set(0, 0, 0), /illegal write/);
  assert.throws(() => ctx.camera.lookAt(0, 0, 0), /illegal write/);
});

test('boot(): ctx.get(\'render\').cameraRig is reachable post-boot, for PLYR-1', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });

  const render = ctx.get('render');
  assert.equal(typeof render.cameraRig.solveOrbitLock, 'function');
  assert.equal(typeof render.cameraRig.withCameraWrite, 'function');
});

test('boot(): a resized canvas still produces a correctly-aspected, still-guarded world camera', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(800, 600), deterministic: true, global: {} });

  assert.ok(Math.abs(ctx.camera.aspect - 800 / 600) < 1e-9);
  assert.throws(() => ctx.camera.position.set(0, 0, 0), /illegal write/);
});

test('boot(): three lockstep boot frames render fine with a guarded ctx.camera (no throw from the pipeline itself)', async () => {
  await assert.doesNotReject(boot({ canvas: makeCanvas(), deterministic: true, global: {} }));
});
