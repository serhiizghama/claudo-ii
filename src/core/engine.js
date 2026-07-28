// src/core/engine.js
//
// CORE-2 — the fixed-step simulation loop and `ctx.time`.
//
// Scope, deliberately narrow (see docs/ARCHITECTURE.md and
// docs/spec/02-api-contracts.md C-1/C-2/C-3): this file owns the frame loop,
// the eight `time` fields and the fixed-step constants. It does NOT own
// subsystem resolution/topo-sort (CORE-3's `src/core/registry.js`) or event
// dispatch (CORE-4's `src/core/events.js`) — those don't exist yet, so the
// engine accepts an already-ordered `systems` array from its caller instead
// of building one.
//
// Node-safe: no `three` import, no DOM/rAF touched on any path that a Node
// harness can reach. `frame(rawDt)` is the single explicit entry point and is
// what `12.D07`, `tools/capture.mjs` and every headless test drive directly.
// `start()`/`stop()` are a thin requestAnimationFrame wrapper around it and
// are the only methods that reference browser globals — and only inside
// their own function bodies, never at module-evaluation time, so importing
// this module in Node never throws.

/** Fixed simulation rate, Hz. `ARCHITECTURE.md` / 02-api-contracts.md C-2. */
export const PHYSICS_HZ = 60;

/** Seconds per fixed step. Exactly `1 / PHYSICS_HZ`. */
export const FIXED_DT = 1 / PHYSICS_HZ;

/** Spiral guard: at most this many fixed steps run inside one frame. */
export const MAX_SUBSTEPS = 6;

/**
 * `rawDt` is clamped to this many seconds before it ever reaches the
 * accumulator. `MAX_SUBSTEPS * FIXED_DT === RAW_DT_CLAMP` exactly, so a frame
 * at the clamp is fully consumed by the spiral guard and only a stall beyond
 * it sheds time (11-flows.md §12.2).
 */
const RAW_DT_CLAMP = 0.10;

export class Engine {
  /**
   * @param {object} [opts]
   * @param {object[]} [opts.systems] - subsystems, already in init order.
   *   Each may implement `fixedUpdate(h, ctx)`, `update(dt, ctx)` and/or
   *   `lateUpdate(dt, ctx)`; any missing method is simply skipped.
   * @param {object} [opts.ctx] - the shared context object. The engine adds
   *   (and is the sole writer of) `ctx.time`; every other field on it
   *   (`scene`, `events`, `input`, `rng`, `get`/`peek`/`has`, ...) is built
   *   by other tickets and is treated as opaque here.
   * @param {(ctx: object) => void} [opts.render] - called once per frame,
   *   after `lateUpdate` and the zone-request service point (phase 5,
   *   §2 of 11-flows.md). `render` itself is RNDR-1's subsystem; this is
   *   just the call site.
   */
  constructor({ systems = [], ctx = {}, render = null } = {}) {
    this.systems = systems;
    this.render = render;

    /** @type {{elapsed:number, raw:number, dt:number, fixed:number, alpha:number, scale:number, frame:number, step:number}} */
    this.time = {
      elapsed: 0,
      raw: 0,
      dt: 0,
      fixed: FIXED_DT,
      alpha: 0,
      scale: 1,
      frame: 0,
      step: 0,
    };

    this.ctx = ctx;
    this.ctx.time = this.time;

    // Fixed-step accumulator, seconds. Pumped by the SCALED dt, never rawDt
    // (11-flows.md §2: "the accumulator is topped up with the scaled dt, not
    // the raw one" — this is what makes time.scale = 0 a true pause).
    this._accum = 0;

    // rAF bookkeeping only; unused on the direct frame(rawDt) path.
    this._last = null;
    this._rafHandle = 0;
    this._running = false;
    this._rafLoop = (now) => {
      if (!this._running) return;
      if (this._last === null) this._last = now;
      const rawDt = (now - this._last) / 1000;
      this._last = now;
      this.frame(rawDt);
      this._rafHandle = requestAnimationFrame(this._rafLoop);
    };
  }

  /**
   * Runs exactly one frame: clamp → fixed-step loop → update → lateUpdate →
   * zone-request service point → render → (input.endFrame). Allocates
   * nothing. This is the method both `requestAnimationFrame` and a headless
   * harness call — the harness passes `rawDt` explicitly, `start()` derives
   * it from `now`.
   *
   * @param {number} rawDt - seconds since the previous frame, unclamped.
   * @returns {number} the number of fixed steps executed this frame.
   */
  frame(rawDt) {
    const clampedRawDt = rawDt < 0 ? 0 : rawDt > RAW_DT_CLAMP ? RAW_DT_CLAMP : rawDt;

    const time = this.time;
    time.raw += clampedRawDt;
    time.dt = clampedRawDt * time.scale;
    time.elapsed += time.dt;
    time.frame++;

    const ctx = this.ctx;
    const systems = this.systems;
    const systemCount = systems.length;

    // 1. input.beginFrame() — CORE-7's; called if present, skipped otherwise.
    const input = ctx.input;
    if (input && typeof input.beginFrame === 'function') input.beginFrame();

    // 2. Fixed-step loop, driven by the scaled dt.
    this._accum += time.dt;
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      time.step++;
      for (let i = 0; i < systemCount; i++) {
        const sys = systems[i];
        if (typeof sys.fixedUpdate === 'function') sys.fixedUpdate(FIXED_DT, ctx);
      }
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0; // shed, never spiral
    time.alpha = this._accum / FIXED_DT;

    // 3. update(dt) — presentation, interpolation. Scaled dt.
    for (let i = 0; i < systemCount; i++) {
      const sys = systems[i];
      if (typeof sys.update === 'function') sys.update(time.dt, ctx);
    }

    // 4. lateUpdate(dt) — scaled dt.
    for (let i = 0; i < systemCount; i++) {
      const sys = systems[i];
      if (typeof sys.lateUpdate === 'function') sys.lateUpdate(time.dt, ctx);
    }

    // 4b. C-3 — service a pending world.requestZone() between lateUpdate and
    // render. `world` (src/world/) is not this ticket's and does not exist
    // yet; this call site exists regardless, as a no-op until it does. See
    // this ticket's report for the exact hook `world` is expected to expose.
    if (typeof ctx.has === 'function' && ctx.has('world')) {
      const world = ctx.get('world');
      if (world && typeof world.serviceZoneRequest === 'function') {
        world.serviceZoneRequest();
      }
    }

    // 5. render
    if (typeof this.render === 'function') this.render(ctx);

    // 6. input.endFrame()
    if (input && typeof input.endFrame === 'function') input.endFrame();

    return steps;
  }

  /** Starts the `requestAnimationFrame` loop. Browser-only. */
  start() {
    if (this._running) return;
    if (typeof requestAnimationFrame !== 'function') {
      throw new Error('Engine.start() needs a browser requestAnimationFrame; call frame(rawDt) directly in Node');
    }
    this._running = true;
    this._last = null;
    this._rafHandle = requestAnimationFrame(this._rafLoop);
  }

  /** Stops the `requestAnimationFrame` loop started by `start()`. */
  stop() {
    this._running = false;
    if (typeof cancelAnimationFrame === 'function' && this._rafHandle) {
      cancelAnimationFrame(this._rafHandle);
    }
    this._rafHandle = 0;
  }
}
