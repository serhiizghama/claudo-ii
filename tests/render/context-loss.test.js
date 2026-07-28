// tests/render/context-loss.test.js
//
// RNDR-3 acceptance tests: the WebGL context-loss/restore state machine
// (docs/ARCHITECTURE.md's event table, docs/spec/11-flows.md §13.4).
//
// Node has no WebGL2 context at all (see src/render/index.js's own module
// header — `rndr1.test.js` establishes the same constraint), so every test
// here drives `RenderSystem` through its degraded, no-GPU path: a stub
// canvas implementing `addEventListener`/`removeEventListener` with real
// dispatch semantics (so the handlers `init()` registers can actually be
// fired), and a real `EventBus` + a plain `{ scale }` `ctx.time` so the
// emitted events and the time-scale freeze/restore are observed exactly the
// way a real subsystem would observe them. One test (`render(ctx) does not
// composite...`) additionally stubs `sys._renderer`/`_hdrTarget`/
// `_composite` directly, since `render(ctx)`'s dead-context guard sits
// *after* the `!renderer` degraded check and Node can never produce a real
// `THREE.WebGLRenderer` to exercise that branch honestly otherwise.
//
// Only stubs — no real browser / real `WEBGL_lose_context` extension was
// available to run this against. See the ticket report for what that means
// for confidence in the real-browser preventDefault()/recompile path.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { RenderSystem } from '../../src/render/index.js';
import { createComposite } from '../../src/render/composite.js';
import { EventBus } from '../../src/core/events.js';

/** A canvas stand-in with real `EventTarget`-shaped dispatch — deliberately
 * no `getContext`, which is what keeps `RenderSystem.init()` on its
 * degraded, no-GPU path (see `rndr1.test.js`'s `makeCanvas`). Unlike that
 * simpler stub, `addEventListener`/`removeEventListener` here actually
 * store/remove handlers so `dispatch()` can fire them, and every call is
 * logged for the dispose() test. */
function makeCanvas(width = 1280, height = 720) {
  const listeners = new Map(); // type -> Set<fn>
  const removeLog = [];
  return {
    width,
    height,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      removeLog.push(type);
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    dispatch(type, event = {}) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn(event);
    },
    listenerCount(type) {
      const set = listeners.get(type);
      return set ? set.size : 0;
    },
    removeLog,
  };
}

/** Same shape as `rndr1.test.js`'s `makeCtx`, plus a real `EventBus` (so
 * emitted events are observable) and a plain mutable `time.scale` (so the
 * freeze/restore is observable) — neither of which that file's ctx needs. */
function makeCtx(canvas, { timeScale = 1 } = {}) {
  return {
    canvas,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 500),
    uiScene: new THREE.Scene(),
    uiCamera: new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 50),
    events: new EventBus(),
    time: { scale: timeScale },
  };
}

/** Waits for however many microtask turns are needed for a chain of
 * already-settled promises (`_onContextRestored`'s `await
 * this.prewarmMaterials(...)` where `prewarmMaterials` degrades to an
 * immediately-resolving no-op) to fully drain. Two turns comfortably covers
 * `prewarmMaterials`'s own `await`-free async body plus `_onContextRestored`'s
 * continuation. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('webglcontextlost: preventDefault() is called', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  await sys.init(makeCtx(canvas));

  let called = false;
  canvas.dispatch('webglcontextlost', { preventDefault: () => { called = true; } });

  assert.equal(called, true);
});

test('webglcontextlost: emits render:context-lost exactly once, even if dispatched twice', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas);
  await sys.init(ctx);

  let count = 0;
  ctx.events.on('render:context-lost', () => count++);

  canvas.dispatch('webglcontextlost', { preventDefault() {} });
  canvas.dispatch('webglcontextlost', { preventDefault() {} }); // duplicate — must not re-emit

  assert.equal(count, 1);
});

test('webglcontextlost: sets ctx.time.scale to 0', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas, { timeScale: 1 });
  await sys.init(ctx);

  canvas.dispatch('webglcontextlost', { preventDefault() {} });

  assert.equal(ctx.time.scale, 0);
});

test('render(ctx): dead context never throws and stops compositing (does not throw when fully degraded either)', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas);
  await sys.init(ctx);

  // Fully degraded (no renderer at all) — the pre-existing RNDR-1 contract:
  // never throws, frameIndex still advances.
  assert.doesNotThrow(() => sys.render(ctx));
  assert.equal(sys.frameIndex, 1);

  canvas.dispatch('webglcontextlost', { preventDefault() {} });
  assert.doesNotThrow(() => sys.render(ctx));
  assert.equal(sys.frameIndex, 2, 'frame keeps ticking even while the context is dead');

  // Now prove the *specific* new guard (not just the pre-existing
  // `!renderer` one) actually skips compositing: stub a renderer-shaped
  // object in directly, since Node can never build a real one. Before the
  // loss it would composite (3 renderer.render() calls); while `_contextLost`
  // is true it must not touch the stub at all.
  const calls = { setRenderTarget: 0, clear: 0, clearDepth: 0, render: 0 };
  sys._renderer = {
    info: { reset() {}, render: { calls: 0, triangles: 0 }, programs: [] },
    setRenderTarget() { calls.setRenderTarget++; },
    clear() { calls.clear++; },
    clearDepth() { calls.clearDepth++; },
    render() { calls.render++; },
  };
  sys._hdrTarget = {};
  sys._composite = { mesh: {}, camera: {} };

  // Still context-lost from above — render() must not touch the stub.
  sys.render(ctx);
  assert.deepEqual(calls, { setRenderTarget: 0, clear: 0, clearDepth: 0, render: 0 });

  // Sanity check the stub itself is wired correctly: force _contextLost
  // false directly (without going through a real restore, which would
  // rebuild _hdrTarget/_composite via real THREE objects the stub renderer
  // can't handle) and confirm render() DOES drive it once healthy.
  sys._contextLost = false;
  sys.render(ctx);
  assert.equal(calls.render, 3, 'world + composite + uiScene');
});

test('webglcontextrestored: emits render:context-restored and restores the previous (non-1) time.scale', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas, { timeScale: 0.5 });
  await sys.init(ctx);

  canvas.dispatch('webglcontextlost', { preventDefault() {} });
  assert.equal(ctx.time.scale, 0);

  let restoredCount = 0;
  ctx.events.on('render:context-restored', () => restoredCount++);

  canvas.dispatch('webglcontextrestored');
  await flushMicrotasks();

  assert.equal(restoredCount, 1);
  assert.equal(ctx.time.scale, 0.5, 'restores the value scale held before the loss, not a hard-coded 1');
});

test('webglcontextrestored: calls prewarmMaterials again', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas);
  await sys.init(ctx);

  const originalPrewarm = sys.prewarmMaterials.bind(sys);
  let prewarmCalls = 0;
  sys.prewarmMaterials = async (c) => {
    prewarmCalls++;
    return originalPrewarm(c);
  };

  canvas.dispatch('webglcontextlost', { preventDefault() {} });
  canvas.dispatch('webglcontextrestored');
  await flushMicrotasks();

  assert.equal(prewarmCalls, 1);
});

// The bug the orchestrator's real-browser pass caught: recovery reported
// success (events fired, time.scale restored, prewarm ran) but the frame
// composited solid black. Root cause, confirmed by reading
// node_modules/three/src/renderers/WebGLRenderer.js and
// .../webgl/WebGLBackground.js directly: three's own internal
// `onContextRestore` calls `initGLContext()`, which constructs a BRAND NEW
// `WebGLBackground` — and every fresh instance starts at
// `new Color(0x000000)`, unconditionally. `renderer.setClearColor()` only
// ever proxies onto whichever `WebGLBackground` instance currently exists,
// so unless something calls it again *after* restore, the clear colour
// silently reverts to opaque black — invisible in the event/state-machine
// tests above, since none of them ever inspected the renderer's own
// reapplied config or the rebuilt resources' wiring. These two tests do.
// (The other half of the real fix — registering RNDR-3's own listeners
// AFTER `new THREE.WebGLRenderer(...)` so three's own restore handler runs
// first — is a real-`WebGLRenderer`, real-canvas timing concern that no
// Node stub can exercise; see the ticket report.)

test('webglcontextrestored: reapplies renderer.setClearColor/outputColorSpace/toneMapping/pixelRatio/autoClear/info.autoReset', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas);
  await sys.init(ctx);

  const setClearColorCalls = [];
  const setPixelRatioCalls = [];
  const stubRenderer = {
    outputColorSpace: null,
    toneMapping: null,
    autoClear: null,
    info: { autoReset: null, reset() {}, render: { calls: 0, triangles: 0 }, programs: [] },
    setClearColor(color, alpha) { setClearColorCalls.push([color, alpha]); },
    setPixelRatio(r) { setPixelRatioCalls.push(r); },
    getRenderTarget() { return null; },
    setRenderTarget() {},
    compile() {},
  };
  sys._renderer = stubRenderer;
  sys._hdrTarget = { dispose() {} };
  sys._composite = { mesh: {}, camera: {}, dispose() {} };
  sys._contextLost = true; // pretend a loss already happened

  canvas.dispatch('webglcontextrestored');
  await flushMicrotasks();

  assert.equal(stubRenderer.outputColorSpace, THREE.SRGBColorSpace);
  assert.equal(stubRenderer.toneMapping, THREE.AgXToneMapping);
  assert.equal(stubRenderer.autoClear, false);
  assert.equal(stubRenderer.info.autoReset, false, 'info.autoReset must stay false — RNDR-1\'s accumulated stats depend on it');
  assert.equal(setPixelRatioCalls.length, 1);
  assert.equal(setClearColorCalls.length, 1, 'setClearColor must be called again — three resets WebGLBackground to black on every context restore');
  const [, alpha] = setClearColorCalls[0];
  assert.equal(alpha, 1, 'HDR_CLEAR_ALPHA');
});

test('webglcontextrestored: rebuilds the HDR target + composite as new objects, and the composite samples the NEW target\'s texture', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas);
  await sys.init(ctx);

  const stubRenderer = {
    outputColorSpace: null,
    toneMapping: null,
    autoClear: null,
    info: { autoReset: null, reset() {}, render: { calls: 0, triangles: 0 }, programs: [] },
    setClearColor() {},
    setPixelRatio() {},
    getRenderTarget() { return null; },
    setRenderTarget() {},
    compile() {},
  };
  sys._renderer = stubRenderer;

  const oldHdrTarget = new THREE.WebGLRenderTarget(4, 4);
  const oldComposite = createComposite(oldHdrTarget.texture);
  sys._hdrTarget = oldHdrTarget;
  sys._composite = oldComposite;
  sys._contextLost = true;

  assert.equal(oldComposite.material.map, oldHdrTarget.texture, 'sanity: the old wiring was correct before the loss');

  canvas.dispatch('webglcontextrestored');
  await flushMicrotasks();

  assert.notEqual(sys._hdrTarget, oldHdrTarget, 'a brand new HDR target, not the disposed one');
  assert.notEqual(sys._composite, oldComposite, 'a brand new composite, not the disposed one');
  assert.equal(
    sys._composite.material.map,
    sys._hdrTarget.texture,
    'the composite material must sample the NEW target\'s texture — this is exactly what went stale in the reported bug',
  );
});

test('a second webglcontextlost during recovery goes fatal: no throw, no rebuild loop, stays frozen', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas, { timeScale: 1 });
  await sys.init(ctx);

  const originalPrewarm = sys.prewarmMaterials.bind(sys);
  let prewarmCalls = 0;
  sys.prewarmMaterials = async (c) => {
    prewarmCalls++;
    return originalPrewarm(c);
  };

  let restoredCount = 0;
  ctx.events.on('render:context-restored', () => restoredCount++);

  canvas.dispatch('webglcontextlost', { preventDefault() {} });
  assert.equal(ctx.time.scale, 0);

  // Fire restored (starts the async recovery — synchronously flips
  // `_recovering = true` before its first `await`) and, still inside the
  // same synchronous tick, fire a second lost. JS run-to-completion
  // guarantees `_recovering` is still true when the second dispatch runs.
  let secondLostThrew = false;
  try {
    canvas.dispatch('webglcontextrestored');
    canvas.dispatch('webglcontextlost', { preventDefault() {} });
  } catch {
    secondLostThrew = true;
  }
  assert.equal(secondLostThrew, false);

  await flushMicrotasks();
  await flushMicrotasks();

  // Recovery must have bailed: never emitted restored, time.scale never
  // came back, and prewarm's result (whether or not it ran once before the
  // fatal check) is now permanently moot — no further attempts happen.
  assert.equal(restoredCount, 0);
  assert.equal(ctx.time.scale, 0, 'stays frozen — the fatal/death state does not resume the simulation');

  // Further events must be inert: no loop, no throw, no new prewarm calls,
  // no restored emit — this is "give up", not "keep retrying".
  const prewarmCallsAfterFatal = prewarmCalls;
  assert.doesNotThrow(() => {
    canvas.dispatch('webglcontextrestored');
    canvas.dispatch('webglcontextlost', { preventDefault() {} });
  });
  assert.equal(prewarmCalls, prewarmCallsAfterFatal);
  assert.equal(restoredCount, 0);

  // And render() must still be a safe, silent no-op throughout.
  assert.doesNotThrow(() => sys.render(ctx));
});

test('dispose(): removes both context listeners; events fired after dispose() are inert', async () => {
  const sys = new RenderSystem();
  const canvas = makeCanvas();
  const ctx = makeCtx(canvas);
  await sys.init(ctx);

  assert.equal(canvas.listenerCount('webglcontextlost'), 1);
  assert.equal(canvas.listenerCount('webglcontextrestored'), 1);

  sys.dispose();

  assert.equal(canvas.listenerCount('webglcontextlost'), 0);
  assert.equal(canvas.listenerCount('webglcontextrestored'), 0);
  assert.ok(canvas.removeLog.includes('webglcontextlost'));
  assert.ok(canvas.removeLog.includes('webglcontextrestored'));

  // Dispatching after dispose() reaches no handler (removed from the stub's
  // own listener map) — confirms removal is real, not just uncounted.
  let emitted = false;
  ctx.events.on('render:context-lost', () => { emitted = true; });
  assert.doesNotThrow(() => canvas.dispatch('webglcontextlost', { preventDefault() {} }));
  assert.equal(emitted, false);
  assert.equal(ctx.time.scale, 1, 'untouched — the handler never ran');
});

test('dispose(): safe to call when init() never attached listeners (no canvas.addEventListener)', async () => {
  const sys = new RenderSystem();
  await sys.init({ canvas: null });
  assert.doesNotThrow(() => sys.dispose());
});
