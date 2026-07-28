// src/render/index.js
//
// RNDR-1 — the one WebGLRenderer, the HDR pipeline's opaque stage, and the
// AgX composite. See docs/spec/02-api-contracts.md §1 for the full contract
// and docs/ARCHITECTURE.md "Render integration" / "### Pre-warm" for the two
// invariants this file exists to satisfy.
//
// Scope, deliberately narrow (this ticket's boundary, restated so a future
// reader doesn't wonder why so much of the docblock's own pipeline is
// missing): depth/normal prepass, shadow cascades, GTAO, bloom, the
// procedural grade LUT and SMAA are RNDR-4/5/6/7 (M8), not here. This ticket
// ships exactly: `renderer`, the HDR render target, `render(ctx)` compositing
// that target to the canvas through `composite.js`'s AgX-tonemapped quad,
// `withPrewarmTarget(fn)`, `prewarmMaterials(ctx)`, `resize`, `stats`. Every
// other row `02-api-contracts.md` §1 lists (`registerPass`, `addLight`,
// `setQuality`, `screenImpulse`, `setColourGrade`, `worldToScreen`,
// `requestEnvMap`, `depthTexture`, `setExposure`, `unregisterPass`,
// `removeLight`) is not implemented and has no stub here — it belongs to a
// later ticket.
//
// ---------------------------------------------------------------------------
// The mechanism `outputColorSpace`/`toneMapping` actually ride on
// ---------------------------------------------------------------------------
// ARCHITECTURE.md's "### Pre-warm" section says outputColorSpace/toneMapping
// "are read off the currently bound target" — true, but the actual rule in
// three r180's `WebGLPrograms.getParameters` (and the identical branch in
// `WebGLRenderer.setProgram`) is more binary than "whichever colour space
// the bound target reports":
//
//   const colorSpace = (currentRenderTarget === null)
//     ? renderer.outputColorSpace
//     : (currentRenderTarget.isXRRenderTarget ? currentRenderTarget.texture.colorSpace : LinearSRGBColorSpace);
//   let toneMapping = NoToneMapping;
//   if (material.toneMapped && (currentRenderTarget === null || currentRenderTarget.isXRRenderTarget)) {
//     toneMapping = renderer.toneMapping;
//   }
//
// In plain terms: rendering into ANY ordinary `WebGLRenderTarget` (our HDR
// target, or `withPrewarmTarget`'s scratch target — XR is irrelevant here)
// forces the compiled program to `LinearSRGBColorSpace` + `NoToneMapping`,
// full stop, regardless of what `renderer.outputColorSpace`/`toneMapping`
// are set to. Only a draw with **no** render target bound (`renderer.
// setRenderTarget(null)`, i.e. the canvas) picks up `renderer.toneMapping`/
// `outputColorSpace` at all. That is exactly what an HDR
// pipeline wants — the opaque/sky/transparent passes into the HDR buffer
// come out linear and untonemapped automatically, no per-material
// `toneMapped = false` bookkeeping required anywhere — and it is also why
// `prewarmMaterials()` below has to briefly unbind the scratch target before
// compiling `composite.js`'s quad: compiled while a target is bound, it
// would bake the wrong (linear, no-tonemap) variant, and the *real* first
// composite draw (canvas-bound) would silently recompile it — the exact
// failure this ticket's acceptance criterion is guarding against.
//
// `renderer.compile()` reads `renderer.getRenderTarget()` through the same
// `getParameters` call `render()` uses, so it can precompile the canvas
// variant without drawing a single pixel — nothing flashes on screen during
// boot.
//
// ---------------------------------------------------------------------------
// Node-safety (no GPU)
// ---------------------------------------------------------------------------
// `tests/core/boot.test.js`'s stub canvas has no `getContext` at all, and
// `src/main.js` now registers this subsystem unconditionally (its two-line
// B4 addition), so `init()` runs on every headless test in the whole suite.
// `THREE.WebGLRenderer` throws immediately if handed a canvas that can't
// yield a context, so `init()` checks for `canvas.getContext` first and, if
// absent, degrades: `this._renderer` stays `null` and every method below
// becomes a safe no-op (or, for `withPrewarmTarget`, just runs its callback)
// instead of throwing. This is the "либо деградировать, либо не вызываться"
// case the ticket brief asks for — degrading was the only option, since
// `main.js`'s registration block is unconditional and shared by every ticket.

import * as THREE from 'three';

import { createComposite } from './composite.js';
import { solveOrbitLock, withCameraWrite } from './camera.js';

// RNDR-2's `cameraRig` getter (below) hands out this exact object every
// call — a frozen constant built once at module load, never per-instance —
// so `player` may cache `ctx.get('render').cameraRig` once in its own
// init() instead of re-reading the getter every frame.
const CAMERA_RIG = Object.freeze({ solveOrbitLock, withCameraWrite });

/** Fallback render size when `ctx.canvas` reports none (matches
 * `src/main.js`'s own `resolveSize` fallback) — only used until the
 * guaranteed post-init `resize(w, h, ctx)` call (main.js B6) lands. */
const FALLBACK_WIDTH = 1280;
const FALLBACK_HEIGHT = 720;

/**
 * IMPLEMENTATION_PLAN.md §5's budget is "60 fps @1080p DPR1" — DPR is fixed
 * at 1 regardless of the display's actual `devicePixelRatio`, on purpose:
 * doubling fill-rate for retina sharpness is not in this ticket's (or any
 * shipped RNDR-* ticket's) budget. Revisit only alongside a real quality
 * pass (`setQuality`, not this ticket's).
 */
const PIXEL_RATIO = 1;

/** The HDR buffer's clear colour — a deliberate dark twilight value (not
 * `THREE.WebGLRenderTarget`'s implicit black), so an empty-scene frame
 * reaching the canvas is visibly *something*, not indistinguishable from an
 * uninitialized target. Placeholder until `sky` (SKY-1) owns the real
 * per-zone mood; picked to sit inside IMPLEMENTATION_PLAN.md §5's "sumerечная
 * palette" direction. sRGB hex — `THREE.Color`'s ColorManagement converts it
 * to the renderer's linear working space itself. */
const HDR_CLEAR_COLOR = 0x0b0e14;
const HDR_CLEAR_ALPHA = 1;

// ---------------------------------------------------------------------------
// RNDR-3 — WebGL context-loss events (docs/ARCHITECTURE.md's event table:
// `render:context-lost` / `render:context-restored`, payload `{}`; full
// sequence in docs/spec/11-flows.md §13.4).
// ---------------------------------------------------------------------------
// `render` owns the canvas listeners (it is the only subsystem that can know
// the GL context died), so this class — not `src/core/engine.js`, which is
// locked and not this ticket's — is what flips `ctx.time.scale` to 0 on loss
// and back on restore. `time.scale` is restored to whatever it held before
// the loss, not hard-coded to 1, since a hit-stop or a pause (CORE-10, M9)
// may hold it non-unity when the context dies.
//
// The two listeners are registered whenever `ctx.canvas` exposes
// `addEventListener` at all — even in the degraded/no-GPU path this file's
// header describes (Node, or a stub test canvas with no `getContext`) — so
// the whole state machine is exercisable from `tests/render/context-loss.
// test.js` without a real WebGL2 context, the same way every other test in
// this suite drives `RenderSystem` headlessly.

/** Frozen, built once — `ctx.events.emit()` must not allocate a payload
 * object per call (ARCHITECTURE.md's determinism contract / `EventBus.emit`
 * must not allocate; the payload itself is the emitter's responsibility,
 * not the bus's). Both events carry `{}` per ARCHITECTURE.md's table. */
const CONTEXT_LOST_PAYLOAD = Object.freeze({});
const CONTEXT_RESTORED_PAYLOAD = Object.freeze({});

export class RenderSystem {
  static id = 'render';
  static deps = [];

  async init(ctx) {
    this._screenSize = { width: 0, height: 0 };
    this._frameIndex = 0;
    this._stats = { drawCalls: 0, triangles: 0, programs: 0, gpuMs: 0, cpuMs: 0 };

    this._renderer = null;
    this._hdrTarget = null;
    this._prewarmTarget = null;
    this._composite = null;

    // RNDR-3 — context-loss state. `_ctx` is stashed because the two
    // listeners below fire from DOM callbacks, not from the per-frame
    // `render(ctx)`/`resize(w,h,ctx)` call sites, so they need their own
    // route to `ctx.time`/`ctx.events` — see the module header.
    this._ctx = ctx;
    this._contextLost = false;
    this._recovering = false;
    this._fatal = false;
    this._savedTimeScale = 1;
    this._contextListenerCanvas = null;
    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);

    const canvas = ctx.canvas;

    // Best-effort initial size either way — real or degraded — so
    // `screenSize` is meaningful even before the guaranteed post-init
    // `resize(w, h, ctx)` call (main.js B6) lands.
    const width = (canvas && (canvas.width | 0)) || FALLBACK_WIDTH;
    const height = (canvas && (canvas.height | 0)) || FALLBACK_HEIGHT;
    this._screenSize.width = width;
    this._screenSize.height = height;

    if (!canvas || typeof canvas.getContext !== 'function') {
      // Node / no-GPU environment — see the module header. Still register
      // the RNDR-3 listeners (a stub test canvas normally implements
      // `addEventListener`) so the whole state machine stays exercisable
      // headlessly — there is no real `THREE.WebGLRenderer` here to order
      // them against (see the real-canvas branch below for why ordering
      // matters there). Every other method below checks `this._renderer`
      // and no-ops when it is null.
      if (canvas && typeof canvas.addEventListener === 'function') {
        canvas.addEventListener('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
        this._contextListenerCanvas = canvas;
      }
      return;
    }

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA is RNDR-6's own post pass, not canvas MSAA
      alpha: false,
      depth: false, // the default framebuffer's own depth is never used —
      stencil: false, // every pass draws into a render target render owns
      powerPreference: 'high-performance',
    });

    // RNDR-3 listeners are registered AFTER `new THREE.WebGLRenderer(...)`,
    // never before it, and this order is load-bearing. `WebGLRenderer`'s own
    // constructor (three's `src/renderers/WebGLRenderer.js`) attaches its
    // OWN internal `webglcontextlost`/`webglcontextrestored` listeners on
    // this exact canvas, and a browser fires same-type listeners in
    // registration order. Three's internal `onContextRestore` is what
    // actually calls `initGLContext()` — the routine that rebuilds `state`,
    // `textures`, `programCache`, `background`, `info`, and everything else
    // three tracks internally, from scratch, against the newly-live GL
    // context. Registering our handler first (the original bug, found by
    // the orchestrator's live-browser pass: recovery reported success but
    // composited solid black) ran our rebuild — new HDR target, new
    // composite, `renderer.compile()` — through three's STILL-STALE internal
    // state, one tick before three quietly rebuilt underneath it and wiped
    // renderer-level config `initGLContext()` does not preserve (below).
    // Registering second guarantees three's own restore handler has already
    // finished by the time ours runs.
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
    this._contextListenerCanvas = canvas;

    // The load-bearing ordering this ticket exists to get right: both are
    // part of every material's program cache key (see this file's header)
    // and must be set before prewarmMaterials/render ever compiles one.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;

    renderer.setPixelRatio(PIXEL_RATIO);
    renderer.setClearColor(HDR_CLEAR_COLOR, HDR_CLEAR_ALPHA);

    // `render(ctx)` clears each pass explicitly (world → HDR target, then
    // composite → canvas, then only-depth before uiScene) — see `render()`.
    renderer.autoClear = false;
    // `render(ctx)` draws three times a frame (world, composite, uiScene);
    // accumulate `info.render` across all three instead of the default
    // per-`render()`-call reset, so `stats` reports the whole frame.
    renderer.info.autoReset = false;

    this._renderer = renderer;
    renderer.setSize(width, height);

    this._hdrTarget = this._createHdrTarget(width, height);
    this._composite = createComposite(this._hdrTarget.texture);
  }

  /** @returns {THREE.WebGLRenderer | null} `null` under Node / no GPU. */
  get renderer() {
    return this._renderer;
  }

  /** @returns {{width:number,height:number}} the same object every call —
   * mutated in place by `resize()`, never reallocated. */
  get screenSize() {
    return this._screenSize;
  }

  /** @returns {number} frames composited since boot (counts every
   * `render(ctx)` call, including degraded no-op ones under Node). */
  get frameIndex() {
    return this._frameIndex;
  }

  /**
   * RNDR-2's camera rig, the runtime path `player` reaches it through
   * (ARCHITECTURE.md rule 2 forbids `player` importing `src/render/camera.js`
   * directly). `{ solveOrbitLock, withCameraWrite }` — the pure orbit-lock
   * solver and the dev-only camera write gate. See src/render/camera.js's
   * header for the full contract; `ctx.camera` itself is built by that
   * module's `buildWorldCamera` at boot stage B3, before this class exists.
   * @returns {{solveOrbitLock:Function, withCameraWrite:Function}}
   */
  get cameraRig() {
    return CAMERA_RIG;
  }

  /** @returns {{drawCalls:number,triangles:number,programs:number,gpuMs:number,cpuMs:number}}
   * `gpuMs`/`cpuMs` are not measured by this ticket (no timer-query
   * profiling exists yet) and stay `0` — flagged in the ticket report rather
   * than fabricated. */
  get stats() {
    return this._stats;
  }

  /**
   * The one per-frame composite entry point (docs/spec/02-api-contracts.md
   * §1's docblock: "composited in render(ctx), called by the engine after
   * every lateUpdate" — `src/main.js`'s `renderFrame(ctx)` duck-types this
   * exact method name). Pipeline today: opaque world → HDR target, HDR →
   * canvas through `composite.js`'s AgX quad, uiScene over the top with a
   * cleared depth buffer. Every other stage the docblock names (prepass,
   * shadows, sky, transparent, GTAO, bloom, grade LUT, SMAA) is a later
   * RNDR-* ticket's insertion point, not missing by accident.
   * @param {object} ctx
   */
  render(ctx) {
    this._frameIndex++;

    const renderer = this._renderer;
    if (!renderer) return; // degraded — nothing to draw
    if (this._contextLost) return; // GPU resources are dead — see RNDR-3 above; frame keeps ticking, nothing composites

    renderer.info.reset();

    // 1. Opaque world -> HDR target.
    renderer.setRenderTarget(this._hdrTarget);
    renderer.clear(true, true, false);
    renderer.render(ctx.scene, ctx.camera);

    // 2. Composite: HDR -> canvas. Render target `null` here is what makes
    // three bake AgX tonemap + sRGB output colour space into the quad's
    // program — see this file's header. Nothing upstream gets tonemapped.
    renderer.setRenderTarget(null);
    renderer.clear(true, true, false);
    renderer.render(this._composite.mesh, this._composite.camera);

    // 3. uiScene, over the world, with a cleared depth buffer only
    // (ARCHITECTURE.md "uiScene / uiCamera").
    renderer.clearDepth();
    renderer.render(ctx.uiScene, ctx.uiCamera);

    const info = renderer.info;
    this._stats.drawCalls = info.render.calls;
    this._stats.triangles = info.render.triangles;
    this._stats.programs = info.programs ? info.programs.length : 0;
  }

  /**
   * Rebuilds the HDR render target at the new size and updates `screenSize`.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this._screenSize.width = width;
    this._screenSize.height = height;

    const renderer = this._renderer;
    if (!renderer) return; // degraded — nothing to resize

    renderer.setSize(width, height);

    if (this._hdrTarget) this._hdrTarget.dispose();
    this._hdrTarget = this._createHdrTarget(width, height);
    if (this._composite) this._composite.material.map = this._hdrTarget.texture;
  }

  /**
   * Binds (building, on first call, a 1x1 scratch target) a render target
   * for the duration of `fn`, then restores whatever was bound before —
   * ARCHITECTURE.md "### Pre-warm": a target must be bound while compiling,
   * and `02-api-contracts.md` §1 forbids every other subsystem from calling
   * `setRenderTarget` — this is `render`'s own frame-shaped answer to both at
   * once. `src/core/prewarm.js` (CORE-8) is the only caller, wrapping its
   * entire `prewarmMaterials(ctx)` hook pass — including this class's own
   * `prewarmMaterials`, below — inside `fn`.
   * @param {() => Promise<void>} fn
   */
  async withPrewarmTarget(fn) {
    const renderer = this._renderer;
    if (!renderer) {
      // Degraded — nothing to bind. Still honour the contract: run the pass.
      await fn();
      return;
    }

    if (!this._prewarmTarget) {
      // Pixel format is irrelevant here — the program cache key branch a
      // bound render target forces (LinearSRGBColorSpace, NoToneMapping;
      // see this file's header) does not depend on the target's own texture
      // type/format at all, only on "some ordinary target is bound".
      this._prewarmTarget = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: true,
        stencilBuffer: false,
      });
    }

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this._prewarmTarget);
    try {
      await fn();
    } finally {
      renderer.setRenderTarget(previous);
    }
  }

  /**
   * Compiles the composite quad's canvas-target program variant ahead of
   * time. Runs inside `withPrewarmTarget`'s callback (see `prewarm.js`'s
   * dispatch order — `render` is always first), so the scratch target is
   * bound on entry; briefly unbinding it (`setRenderTarget(null)`) is what
   * makes `renderer.compile()` compile the *canvas* variant instead of
   * re-compiling the scratch-target variant a lit scene material would want.
   * `compile()` never draws a pixel, so nothing flashes on the real canvas.
   * @param {object} ctx - unused; present for the `(ctx) => Promise<void>`
   *   contract every `prewarmMaterials` hook shares.
   */
  // eslint-disable-next-line no-unused-vars
  async prewarmMaterials(ctx) {
    const renderer = this._renderer;
    if (!renderer || !this._composite) return; // degraded — nothing to compile

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(null);
    try {
      renderer.compile(this._composite.mesh, this._composite.camera);
    } finally {
      renderer.setRenderTarget(previous);
    }
  }

  // ---- RNDR-3: WebGL context loss ----------------------------------------

  /**
   * `webglcontextlost` handler. `preventDefault()` first, unconditionally —
   * 11-flows.md §13.4's one load-bearing rule: without it the browser never
   * fires `webglcontextrestored` and recovery is impossible, so this line
   * runs even on a duplicate or a during-recovery loss.
   *
   * Three outcomes:
   *  - A loss while a restore is still in flight (`_recovering`) is the
   *    "second loss during recovery" case 11-flows.md §13.4 says to give up
   *    on: latch `_fatal` and stop. `ui`/`save` own the death screen and the
   *    Reload button (not this ticket's directory — see the ticket
   *    boundary); render's part is only to never attempt another rebuild
   *    and never throw. `_contextLost` is already `true` from the first
   *    loss, so `render(ctx)` was already a no-op composite and stays one.
   *  - A duplicate loss while already lost (not recovering) is a no-op —
   *    the first one already did everything there is to do.
   *  - A fresh loss: latch `_contextLost`, save whatever `ctx.time.scale`
   *    held (a hit-stop or a pause may have it non-unity — restore must
   *    return to that value, not to a hard-coded 1), zero it so the
   *    simulation freezes instead of advancing blind, and emit
   *    `render:context-lost`.
   * @param {{preventDefault?: Function}} event
   */
  _onContextLost(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    if (this._recovering) {
      this._fatal = true;
      return;
    }
    if (this._contextLost) return; // duplicate event — already handled

    this._contextLost = true;
    const ctx = this._ctx;
    this._savedTimeScale = ctx && ctx.time ? ctx.time.scale : 1;
    if (ctx && ctx.time) ctx.time.scale = 0;
    if (ctx && ctx.events) ctx.events.emit('render:context-lost', CONTEXT_LOST_PAYLOAD);
  }

  /**
   * `webglcontextrestored` handler. Rebuilds render's own GPU resources
   * (HDR target, prewarm scratch target, composite quad) and recompiles the
   * composite program, then hands `time.scale` back and emits
   * `render:context-restored` — but only if nothing went fatal while that
   * work was in flight (a second `webglcontextlost` mid-recovery sets
   * `_fatal` from `_onContextLost` above, and this bails without restoring
   * anything, leaving the simulation frozen for good).
   *
   * What this method does NOT do: re-run the cross-subsystem
   * `core/prewarm.js` dispatcher (`materials`/`sky`/`world`/`actors`/`fx`/
   * `items` rebuilding their own GPU resources). That dispatcher takes the
   * `Engine` instance, which `render` — a subsystem that only ever receives
   * `ctx` — has no reference to and cannot reach without either importing
   * `src/main.js`/`src/core/engine.js` internals or `ctx` growing an
   * `engine` field, both outside this ticket's file list. Each of those six
   * subsystems is expected to subscribe to `render:context-restored` itself
   * (per the ticket boundary — "они подпишутся на твоё событие сами");
   * re-running the *dispatcher* itself is a composition-root concern and is
   * flagged in this ticket's report as unresolved, not silently invented
   * here.
   */
  async _onContextRestored() {
    if (this._fatal) return; // already gave up — never retry
    if (!this._contextLost) return; // nothing to restore
    if (this._recovering) return; // a restore is already in flight

    this._recovering = true;
    try {
      this._rebuildAfterContextRestore();
      await this.prewarmMaterials(this._ctx);

      if (this._fatal) return; // a second loss landed while we awaited above

      this._contextLost = false;
      const ctx = this._ctx;
      if (ctx && ctx.time) ctx.time.scale = this._savedTimeScale;
      if (ctx && ctx.events) ctx.events.emit('render:context-restored', CONTEXT_RESTORED_PAYLOAD);
    } finally {
      this._recovering = false;
    }
  }

  /**
   * Rebuilds every GPU resource `render` itself owns, in place — the HDR
   * target, the prewarm scratch target (dropped and lazily rebuilt on next
   * use rather than recreated eagerly, matching `withPrewarmTarget`'s own
   * first-call-builds-it contract) and the composite quad (its material
   * holds a reference to the old, GPU-dead HDR texture and must be rebuilt
   * against the new one). No-op when degraded (no `_renderer`) — there is
   * nothing to rebuild under Node.
   *
   * Also reapplies the renderer-level config `init()` set up once, because
   * three's own `onContextRestore` (which runs before this, see the
   * listener-registration-order comment in `init()`) calls `initGLContext()`
   * — a routine that reconstructs several of `WebGLRenderer`'s internal
   * modules from scratch, `WebGLBackground` among them. Read straight from
   * `node_modules/three/src/renderers/webgl/WebGLBackground.js`: every fresh
   * instance starts `const clearColor = new Color(0x000000)` — there is no
   * persistence across instances, and `renderer.setClearColor()` is a thin
   * proxy onto whichever `WebGLBackground` instance currently exists. So the
   * clear colour silently reverts to opaque black on every context restore
   * unless something calls `setClearColor()` again afterward — which is
   * exactly what turned a *reported-successful* recovery into a solid black
   * frame (composite drawing, program compiled, HDR target sampled — just
   * cleared to black instead of `HDR_CLEAR_COLOR`). `outputColorSpace` /
   * `toneMapping` / `autoClear` are plain fields three's `initGLContext()`
   * does not touch (confirmed the same way) and survive on their own; they
   * are reapplied here anyway, at zero real cost, so this method stays
   * correct even if a future three version changes that. `info.autoReset` is
   * the one field three's own restore handler already explicitly
   * preserves (`onContextRestore` snapshots it before `initGLContext()` and
   * writes it back after) — reapplied here too, purely as a second,
   * harmless guarantee.
   */
  _rebuildAfterContextRestore() {
    const renderer = this._renderer;
    if (!renderer) return;

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.setPixelRatio(PIXEL_RATIO);
    renderer.setClearColor(HDR_CLEAR_COLOR, HDR_CLEAR_ALPHA);
    renderer.autoClear = false;
    renderer.info.autoReset = false;

    if (this._composite) {
      this._composite.dispose();
      this._composite = null;
    }
    if (this._hdrTarget) {
      this._hdrTarget.dispose();
      this._hdrTarget = null;
    }
    if (this._prewarmTarget) {
      this._prewarmTarget.dispose();
      this._prewarmTarget = null;
    }

    const { width, height } = this._screenSize;
    this._hdrTarget = this._createHdrTarget(width, height);
    this._composite = createComposite(this._hdrTarget.texture);
  }

  dispose() {
    if (this._contextListenerCanvas) {
      this._contextListenerCanvas.removeEventListener('webglcontextlost', this._onContextLost);
      this._contextListenerCanvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      this._contextListenerCanvas = null;
    }
    if (this._prewarmTarget) {
      this._prewarmTarget.dispose();
      this._prewarmTarget = null;
    }
    if (this._hdrTarget) {
      this._hdrTarget.dispose();
      this._hdrTarget = null;
    }
    if (this._composite) {
      this._composite.dispose();
      this._composite = null;
    }
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {THREE.WebGLRenderTarget}
   */
  _createHdrTarget(width, height) {
    return new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }
}
