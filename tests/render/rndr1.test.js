// tests/render/rndr1.test.js
//
// RNDR-1 acceptance tests. `node:test` + `node:assert/strict` only, matching
// every other suite in this repo (docs/spec/12-testing.md P6).
//
// What can and cannot be checked from here: this file runs under plain
// Node, which has no WebGL2 context at all (no `canvas`/`gl` npm package is
// installed — see package.json). So `RenderSystem.init()` always takes its
// degraded path here (see src/render/index.js's module header), and nothing
// in this file can observe an actual drawn pixel, a compiled GLSL program,
// or the `outputColorSpace`/`toneMapping` values actually landing on a real
// `THREE.WebGLRenderer`. What IS checked: the degraded path never throws and
// leaves every public property in a sane, documented shape; `composite.js`'s
// pure-`three`-object construction (no GPU touched by any of it); and that
// registering the real `RenderSystem` into `src/main.js`'s boot sequence
// (this ticket's two-line addition) does not break `boot()` for any of the
// existing subsystem-less / stub-only paths CORE-9's own suite exercises.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { RenderSystem } from '../../src/render/index.js';
import { createComposite } from '../../src/render/composite.js';
import { boot } from '../../src/main.js';

/** Same shape as tests/core/boot.test.js's stub: enough of `EventTarget` for
 * `Input.attach()`, deliberately no `getContext` — this is what forces
 * `RenderSystem.init()` down its degraded, no-GPU path. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A minimal `ctx` for exercising `RenderSystem` directly, without going
 * through the whole `boot()` sequence. Only the fields `render`'s own
 * methods actually touch. */
function makeCtx(canvas) {
  return {
    canvas,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 500),
    uiScene: new THREE.Scene(),
    uiCamera: new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 50),
  };
}

test('RenderSystem: static id/deps match the subsystem interface', () => {
  assert.equal(RenderSystem.id, 'render');
  assert.ok(Array.isArray(RenderSystem.deps));
  assert.deepEqual(RenderSystem.deps, []);
});

test('init(): degrades without throwing when the canvas has no getContext (Node / no GPU)', async () => {
  const sys = new RenderSystem();
  const ctx = makeCtx(makeCanvas());
  await assert.doesNotReject(sys.init(ctx));

  assert.equal(sys.renderer, null);
  assert.deepEqual(sys.screenSize, { width: 1280, height: 720 });
  assert.equal(sys.frameIndex, 0);
  assert.deepEqual(sys.stats, { drawCalls: 0, triangles: 0, programs: 0, gpuMs: 0, cpuMs: 0 });
});

test('init(): falls back to 1280x720 when the canvas reports no size', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas(0, 0);
  await sys.init(makeCtx(canvas));
  assert.deepEqual(sys.screenSize, { width: 1280, height: 720 });
});

test('render(ctx): degraded — never throws, still counts frameIndex', async () => {
  const sys = new RenderSystem();
  const ctx = makeCtx(makeCanvas());
  await sys.init(ctx);

  assert.equal(sys.frameIndex, 0);
  sys.render(ctx);
  sys.render(ctx);
  sys.render(ctx);
  assert.equal(sys.frameIndex, 3);
});

test('resize(): degraded — updates screenSize in place (same object) without throwing', async () => {
  const sys = new RenderSystem();
  const ctx = makeCtx(makeCanvas());
  await sys.init(ctx);

  const sizeRef = sys.screenSize;
  sys.resize(640, 480, ctx);
  assert.equal(sys.screenSize, sizeRef, 'screenSize must be the same object, mutated in place');
  assert.deepEqual(sys.screenSize, { width: 640, height: 480 });
});

test('withPrewarmTarget(): degraded — runs fn exactly once, awaits it, and propagates its result', async () => {
  const sys = new RenderSystem();
  await sys.init(makeCtx(makeCanvas()));

  let calls = 0;
  let ran = false;
  await sys.withPrewarmTarget(async () => {
    calls++;
    await Promise.resolve();
    ran = true;
  });

  assert.equal(calls, 1);
  assert.equal(ran, true);
});

test('withPrewarmTarget(): a throwing fn still rejects (contract: caller sees the failure)', async () => {
  const sys = new RenderSystem();
  await sys.init(makeCtx(makeCanvas()));

  await assert.rejects(
    sys.withPrewarmTarget(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});

test('prewarmMaterials(ctx): degraded — resolves without throwing', async () => {
  const sys = new RenderSystem();
  const ctx = makeCtx(makeCanvas());
  await sys.init(ctx);
  await assert.doesNotReject(sys.prewarmMaterials(ctx));
});

test('dispose(): safe to call after a degraded init, and safe to call twice', async () => {
  const sys = new RenderSystem();
  await sys.init(makeCtx(makeCanvas()));
  assert.doesNotThrow(() => sys.dispose());
  assert.doesNotThrow(() => sys.dispose());
});

// --- composite.js — pure `three` object construction, no GPU involved -----

test('composite.js: createComposite() builds a reusable full-screen draw, zero GPU touched', () => {
  const hdrTexture = new THREE.Texture();
  const composite = createComposite(hdrTexture);

  assert.ok(composite.mesh instanceof THREE.Mesh);
  assert.ok(composite.camera instanceof THREE.OrthographicCamera);
  assert.ok(composite.geometry instanceof THREE.BufferGeometry);
  assert.ok(composite.material instanceof THREE.MeshBasicMaterial);

  assert.equal(composite.material.map, hdrTexture);
  assert.equal(composite.material.toneMapped, true);
  assert.equal(composite.material.depthTest, false);
  assert.equal(composite.material.depthWrite, false);
  assert.equal(composite.mesh.frustumCulled, false);

  assert.doesNotThrow(() => composite.dispose());
});

test('composite.js: the ortho camera frames exactly the NDC square', () => {
  const composite = createComposite(new THREE.Texture());
  const cam = composite.camera;
  assert.equal(cam.left, -1);
  assert.equal(cam.right, 1);
  assert.equal(cam.top, 1);
  assert.equal(cam.bottom, -1);
});

// --- integration through the real boot sequence ----------------------------

test('boot(): registers the real render subsystem and completes without throwing (Node, no GPU)', async () => {
  const { ctx, bootLog } = await boot({
    canvas: makeCanvas(),
    deterministic: true,
    global: {},
  });

  assert.equal(ctx.has('render'), true);
  const render = ctx.get('render');
  assert.ok(render instanceof RenderSystem);
  assert.equal(render.renderer, null, 'degraded under Node — no real WebGLRenderer');

  // B8 (shader pre-warm) must still complete: `render` implements both
  // `withPrewarmTarget` and `prewarmMaterials`, and neither may throw when
  // degraded (core/prewarm.js swallows a throw per-hook, but a healthy
  // RNDR-1 shouldn't need that safety net at all).
  const b8 = bootLog.find((e) => e.id === 'B8');
  assert.equal(b8.status, 'done');
});

test('boot(): render.resize ran during B6 and left a real screenSize on the instance', async () => {
  const { ctx } = await boot({
    canvas: makeCanvas(800, 600),
    deterministic: true,
    global: {},
  });

  const render = ctx.get('render');
  assert.deepEqual(render.screenSize, { width: 800, height: 600 });
});

test('boot(): three lockstep boot frames all reach render(ctx) without throwing', async () => {
  const { ctx } = await boot({
    canvas: makeCanvas(),
    deterministic: true,
    global: {},
  });

  const render = ctx.get('render');
  // B13 pumps BOOT_FRAMES (3) frames through engine.frame(), each of which
  // calls render(ctx) once (src/core/engine.js phase 5) — frameIndex is the
  // observable proof render(ctx) actually ran every time, not just at init.
  assert.equal(render.frameIndex, 3);
});
