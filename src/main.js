// src/main.js
//
// CORE-9 — composition root and the boot sequence (docs/spec/11-flows.md §1).
//
// ---------------------------------------------------------------------------
// Why this file builds what `11-flows.md` §1.1 draws as `Engine`'s job
// ---------------------------------------------------------------------------
// §1.1's sequence diagram narrates `new Engine({canvas, config})` building
// `scene`/`camera`/`uiScene`/`uiCamera`/`EventBus`/`Input`/the root `Rng`,
// then `engine.add() × 16` and `await engine.init()`. The real
// `src/core/engine.js` (CORE-2, locked) is not that object: it is a pure
// fixed-step loop — `new Engine({ systems, ctx, render })`, one entry point
// `frame(rawDt)` — with no `add()`, no `init()`, no scene/camera
// construction. Subsystem resolution and topological ordering live in
// `src/core/registry.js` (CORE-3, locked) instead.
//
// Decision (owner-approved, restated here because it is why this file looks
// the way it does): the composition root is `main.js`. This module builds
// `ctx` (scenes, cameras, the event bus, input, the root rng, config),
// constructs the `Engine` (which is what actually puts `time` on `ctx` — see
// "ctx.time ordering" below), then constructs a `Registry`, registers
// subsystems and awaits `registry.init(ctx)`. Handing the engine a raw
// canvas and config and letting it build the camera would put camera
// construction in `src/core/engine.js`, which collides with
// `src/render/camera.js`'s ownership (RNDR-2). The *observable* stage-by-
// stage behaviour of B1–B13 below is identical to §1.1's diagram either way
// — only which object `add()`/`init()` live on differs.
//
// ---------------------------------------------------------------------------
// ctx.time ordering
// ---------------------------------------------------------------------------
// `Engine`'s constructor is the sole writer of `ctx.time` (`this.ctx.time =
// this.time`), and `01-data-model.md` schedules nearly everything —
// `attackReady`, `nextTickStep`, `repathAtStep`, etc. — against
// `ctx.time.step`, including fields a subsystem may want to seed inside its
// own `init()`. So `ctx.time` has to exist *before* `registry.init(ctx)`
// runs, not after. `Engine`'s constructor defaults `systems` to `[]` and
// `frame()` re-reads `this.systems` fresh every call rather than closing
// over whatever was passed in, so the engine is constructed early (still at
// B3, systems-less) and `engine.systems` is assigned once
// `registry.init(ctx)` resolves at B5 — equivalent to constructing it with
// the final array, verified against the (unmodified) `src/core/engine.js`
// before relying on it.
//
// ---------------------------------------------------------------------------
// The boot log
// ---------------------------------------------------------------------------
// `boot()` returns `{ engine, ctx, bootLog, config }` and also assigns
// `engine.__boot = bootLog`. `bootLog` is a plain array, appended to in
// stage order, one entry per row of `11-flows.md` §1.2's table:
//   { id: 'B7', stage: 'Boot veil', owner: 'ui', status: 'done'|'skipped',
//     tMs: <ms since boot() started>, ...stage-specific detail fields }
// `stage`/`owner` are copied verbatim from that table so the log can be
// diffed against it directly. B7/B10/B11/B12 depend on `ui`/`fx`/`save`,
// none of which exist yet (see "What doesn't exist yet" below); those stages
// are marked `'skipped'` with a `reason`, never thrown past.
//
// ---------------------------------------------------------------------------
// Lockstep vs rAF (B9/B13)
// ---------------------------------------------------------------------------
// `config.lockstep` (`?lockstep=1`) is the harness path `tools/capture.mjs`
// (TEST-3, not yet written) is expected to drive: `engine.start()` is never
// called, and `BOOT_FRAMES` frames are pumped directly through
// `engine.frame(FIXED_DT)`, so a shot always lands at exactly engine frame 3
// regardless of how long boot took in wall-clock terms (11-flows.md §1.2,
// the paragraph under the B1–B13 table). The same fallback also fires
// whenever `requestAnimationFrame` doesn't exist at all — i.e. in Node —
// which is what makes `boot()` callable from `tests/core/boot.test.js`
// without a browser or a WebGL context: no explicit `lockstep: true` is
// required to run this module headlessly, only the absence of `rAF`.
//
// ---------------------------------------------------------------------------
// Context-restore re-warm (11-flows.md §13.4)
// ---------------------------------------------------------------------------
// `boot()` subscribes to `render:context-restored` exactly once and re-runs
// `prewarm(engine)` (fire-and-forget) on every emit — the shared shader
// pre-warm dispatcher has to run again once WebGL comes back, and `main.js`
// is the only place with both the `Engine` instance `prewarm()` needs and
// `ctx.events` to listen on. See the inline comment at the subscription
// (right after the engine is constructed, in B3) for the full reasoning.
//
// ---------------------------------------------------------------------------
// What doesn't exist yet
// ---------------------------------------------------------------------------
// Most of the sixteen subsystems are not implemented yet. B4's registration
// block below starts empty and grows by exactly two lines per landed
// ticket (an import + one `registry.add()` call) and nothing else — `render`
// (RNDR-1) is the first. Because that count only ever grows, nothing in
// this file or in `tests/core/boot.test.js` may assert a literal total
// subsystem count; B5's log entry carries `ids` (the resolved list) instead,
// exactly so a test can check *shape* (a given id is present, in the right
// relative order) without hardcoding *how many* there are in total.
// `opts.systems` lets a caller (a test, or a future dev harness) inject
// additional subsystem classes without touching the registration block.
//
// ---------------------------------------------------------------------------
// Node-safe
// ---------------------------------------------------------------------------
// `boot()` never touches `window`/`document` except through the small
// `resolveCanvas`/`pumpRafFrames` helpers, which are themselves guarded.
// The browser autostart at the bottom of this file is gated behind a
// `typeof window !== 'undefined' && typeof document !== 'undefined'` check
// so importing this module from Node (as the test does) never runs it and
// never throws.

import * as THREE from 'three';

import { Engine, FIXED_DT } from './core/engine.js';
import { Registry } from './core/registry.js';
import { EventBus } from './core/events.js';
import { Input } from './core/input.js';
import { Rng } from './core/rng.js';
import { createConfig } from './core/config.js';
import { prewarm } from './core/prewarm.js';
import { RenderSystem } from './render/index.js';
import { MaterialsSystem } from './materials/index.js';
import { buildWorldCamera as buildWorldCameraRig } from './render/camera.js';
import { PhysicsSystem } from './physics/index.js';
import { WorldSystem } from './world/index.js';
import { ActorsSystem } from './actors/index.js';
import { PlayerSystem } from './player/index.js';
import { NavSystem } from './nav/index.js';
import { CombatSystem } from './combat/packet.js';
import { SkillsSystem } from './skills/index.js';
import { UiSystem } from './ui/index.js';
import { ItemsSystem } from './items/index.js';
import { SaveSystem } from './save/index.js';

/** `11-flows.md` §1 B13: the frame count, not a rAF race, raises `__READY__`. */
const BOOT_FRAMES = 3;

/** `uiCamera` framing (the HUD paperdoll / item-preview scene). Not
 * specified either — a reasonable placeholder for a small 3D preview,
 * revisited whenever `ui`/RNDR-2 define the real paperdoll framing. */
const UI_CAMERA_FOV = 45;
const UI_CAMERA_NEAR = 0.1;
const UI_CAMERA_FAR = 50;

/** `Stage`/`Owner` columns of `11-flows.md` §1.2's table, verbatim, keyed by
 * stage id — the single source `record()` below reads from so every log
 * entry's wording matches the spec exactly. */
const STAGE_META = {
  B1: { stage: 'Document + module graph', owner: 'browser' },
  B2: { stage: 'Config', owner: 'main.js' },
  B3: { stage: 'Engine construction', owner: 'main.js' },
  B4: { stage: 'Registration', owner: 'main.js' },
  B5: { stage: 'Topological init', owner: 'engine' },
  B6: { stage: 'Input + resize', owner: 'engine' },
  B7: { stage: 'Boot veil', owner: 'ui' },
  B8: { stage: 'Shader pre-warm', owner: 'core/prewarm.js' },
  B9: { stage: 'engine.start()', owner: 'engine' },
  B10: { stage: 'fx self-warm', owner: 'fx' },
  B11: { stage: 'Save probe', owner: 'save' },
  B12: { stage: 'Menu', owner: 'ui' },
  B13: { stage: 'Harness handshake', owner: 'main.js' },
};

/** Monotonic-ish wall clock for boot-log timestamps only — never fed to
 * `ctx.rng`, `ctx.time` or any gameplay decision, so reading it here does
 * not violate the "nothing in the simulation reads the clock" rule (that
 * rule is about `fixedUpdate`; this is one-shot boot orchestration). */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Resolves the canvas `input.attach()` and the cameras' aspect ratio are
 * built from. `opts.canvas` wins (this is what makes the function callable
 * from Node — a test hands in a stub implementing `addEventListener`); else
 * `document.getElementById('game')` in a browser.
 */
function resolveCanvas(opts) {
  if (opts.canvas) return opts.canvas;
  if (typeof document !== 'undefined') {
    const el = document.getElementById('game');
    if (el) return el;
    throw new Error("main.boot: no '#game' canvas found in the document, and no opts.canvas was given");
  }
  throw new Error('main.boot: opts.canvas is required when no DOM document is present (e.g. under Node)');
}

/**
 * Picks the initial render size. Priority: an explicit `opts.width`/
 * `opts.height` (what tests, and `capture.mjs`/TEST-3, pin to exactly
 * 1280×720 per `12-testing.md` §6) always wins; else the real window's own
 * size; else the canvas's CSS-computed size (`clientWidth`/`clientHeight`,
 * for a canvas that doesn't fill the viewport); else — Node/stub-test
 * compatibility only, see below — the canvas object's own `width`/`height`
 * properties; else a fixed 1280×720 fallback.
 *
 * `window` is checked *before* the canvas's own `width`/`height`, not
 * after. A bare `<canvas>` with no `width`/`height` attributes defaults
 * those to the HTML5 spec's 300×150 — a real backing-store size, not a
 * hint about the intended render resolution — and the previous version of
 * this function read that back as the size *source*, before ever
 * considering `window`. Confirmed live (`vite preview` + headless
 * Chromium): the whole game rendered at 300×150, CSS-stretched. Every real
 * browser has a `window`, so putting it first means that 300×150 default
 * is now never reached there. `canvas.width`/`.height` remain a fallback
 * *after* `window`/`clientWidth` purely so `tests/render/rndr1.test.js`'s
 * `makeCanvas(800, 600)`-style stubs (plain objects with no `clientWidth`,
 * asserting the given size flows through end to end) keep working under
 * Node, which has no `window` to shadow them — see this ticket's report.
 * `canvas.width`/`.height` are otherwise this function's *output*
 * (stamped by the caller, `applyResize` below), never an input read back
 * as truth.
 */
function resolveSize(opts, canvas) {
  const width =
    opts.width ??
    (typeof window !== 'undefined' ? window.innerWidth : undefined) ??
    (canvas && canvas.clientWidth) ??
    (canvas && canvas.width) ??
    1280;
  const height =
    opts.height ??
    (typeof window !== 'undefined' ? window.innerHeight : undefined) ??
    (canvas && canvas.clientHeight) ??
    (canvas && canvas.height) ??
    720;
  return { width: width || 1280, height: height || 720 };
}

/** The world camera: FOV, clip planes, and the orbit-lock initial transform
 * (fixed pitch/distance off `config`) are all `src/render/camera.js`'s
 * (RNDR-2) — this stays a thin wrapper so the B3 call site below doesn't
 * change shape. RNDR-2's module builds a camera as a plain function, no live
 * `RenderSystem` required, because `ctx.camera` exists before any subsystem
 * does (see "ctx.time ordering" above). */
function buildWorldCamera(config, width, height) {
  return buildWorldCameraRig(config, width, height);
}

/** The HUD's own 3D camera (rotating item preview, character paperdoll —
 * ARCHITECTURE.md "`uiScene`/`uiCamera`"). Placeholder framing; `ui`/RNDR-2
 * own the real one. */
function buildUiCamera(width, height) {
  const camera = new THREE.PerspectiveCamera(
    UI_CAMERA_FOV,
    width / Math.max(height, 1),
    UI_CAMERA_NEAR,
    UI_CAMERA_FAR,
  );
  camera.position.set(0, 1, 3);
  camera.lookAt(0, 1, 0);
  return camera;
}

/** B6's `resize()`: stamps the computed size onto the canvas as its output
 * backing buffer, updates both cameras' aspect, calls `resize(w, h, ctx)`
 * on every initialized subsystem that implements it, then emits the
 * `resize` event ARCHITECTURE.md's event table attributes to `engine`. */
function applyResize(systems, ctx, camera, uiCamera, width, height) {
  // `canvas.width`/`.height` are this module's *output*, not a size source
  // (see `resolveSize`'s header) — stamped here from the already-computed
  // `width`/`height`, so the canvas's real backing buffer never lingers at
  // whatever it happened to default to (an un-attributed `<canvas>`'s
  // HTML5-spec 300×150).
  if (ctx.canvas) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
  }

  const aspect = width / Math.max(height, 1);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  uiCamera.aspect = aspect;
  uiCamera.updateProjectionMatrix();
  for (let i = 0; i < systems.length; i++) {
    const sys = systems[i];
    if (typeof sys.resize === 'function') sys.resize(width, height, ctx);
  }
  ctx.events.emit('resize', { width, height });
}

/** Waits for `n` real `requestAnimationFrame` callbacks. Only ever called on
 * the branch that already confirmed `requestAnimationFrame` exists. */
function pumpRafFrames(n) {
  return new Promise((resolve) => {
    let remaining = n;
    const step = () => {
      remaining--;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** The `render` callback `Engine.frame()` calls once per frame, after
 * `lateUpdate` (engine.js phase 5). `render`'s public API
 * (docs/spec/02-api-contracts.md §1) does not yet name the per-frame
 * composite entry point this call site needs — flagged in this ticket's
 * report for RNDR-1. Duck-typed and a no-op until `render` exists and
 * implements it, so every test today exercises the no-op path. */
function renderFrame(ctx) {
  const renderSys = ctx.peek('render');
  if (renderSys && typeof renderSys.render === 'function') renderSys.render(ctx);
}

/**
 * Runs the full boot sequence (`docs/spec/11-flows.md` §1, stages B1–B13)
 * and resolves once B13's harness handshake has landed. Callable from a
 * browser (the auto-run at the bottom of this file) or from Node (this
 * ticket's `tests/core/boot.test.js`) — see the module header.
 *
 * @param {object} [opts]
 * @param {HTMLCanvasElement|object} [opts.canvas] - required under Node.
 * @param {number} [opts.width] - initial render width; else window/1280 (see `resolveSize`).
 * @param {number} [opts.height] - initial render height; else window/720 (see `resolveSize`).
 * @param {'low'|'medium'|'high'|'ultra'} [opts.quality] - forwarded to `createConfig`.
 * @param {boolean} [opts.deterministic] - forwarded to `createConfig` (B2).
 * @param {Function[]} [opts.systems] - extra subsystem classes to register
 *   at B4, on top of the (today, empty) real registration block. This is
 *   how `boot.test.js` injects stub subsystems.
 * @param {object} [opts.global] - object `__READY__`/`__ENGINE__`/`__PREWARM__`
 *   are written onto at B13. Defaults to `window` in a browser, else
 *   `globalThis` — pass a stub here to keep a Node test from polluting the
 *   real Node global object.
 * @returns {Promise<{engine: Engine, ctx: object, bootLog: object[], config: object}>}
 */
export async function boot(opts = {}) {
  const t0 = now();
  const bootLog = [];
  const record = (id, status, extra) => {
    const meta = STAGE_META[id];
    bootLog.push({ id, stage: meta.stage, owner: meta.owner, status, tMs: now() - t0, ...(extra || {}) });
  };

  // --- B1: Document + module graph -----------------------------------------
  // Owned by the browser: index.html, the Vite ESM bundle and `three` are
  // all evaluated before a single line of this function runs. There is
  // nothing left for boot() to *do* for B1 — only to acknowledge that by
  // the time it's executing at all, B1 is necessarily already complete.
  record('B1', 'done', { note: 'module graph already evaluated to reach this call' });

  // --- B2: Config -----------------------------------------------------------
  // `createConfig` itself reads `?q`/`?capture`/`?lockstep`/`?prewarm`/`?seed`
  // off `location.search` (or an empty `URLSearchParams` under Node) and
  // falls back to `'high'`/`false` exactly as §1 B2 specifies — re-parsing
  // the URL here too would just duplicate config.js's own logic, so
  // `opts.quality`/`opts.deterministic` are forwarded as-is and left
  // `undefined` when not given.
  const config = createConfig({ quality: opts.quality, deterministic: opts.deterministic });
  record('B2', 'done', { quality: config.quality, deterministic: config.deterministic });

  // --- B3: "Engine construction" -> ctx scaffold -----------------------------
  // §1.1's diagram has `new Engine({canvas, config})` build these seven
  // things; the real engine doesn't, so main.js does, per the composition
  // decision in this file's header.
  const scene = new THREE.Scene();
  const uiScene = new THREE.Scene();

  const canvas = resolveCanvas(opts);
  const { width, height } = resolveSize(opts, canvas);

  const camera = buildWorldCamera(config, width, height);
  const uiCamera = buildUiCamera(width, height);

  const events = new EventBus();
  const input = new Input();

  // 11-flows.md §14.2 — the ONE non-deterministic draw in the entire game.
  // `config.deterministic` false and no explicit `?seed=` override reaches
  // the exact formula §14.2 gives: `(Math.random() * 2 ** 32) >>> 0`. This
  // is the sole call to `Math.random()` anywhere in this codebase
  // (ARCHITECTURE.md hard rule 4's one documented exception). `config.seed`
  // (parsed by config.js from `?seed=`) is honoured first when present —
  // config.js's own header comment names this exact call site as "whoever
  // [carries the flag] does" the drawing; see this ticket's report for that
  // reasoning spelled out.
  const worldSeed = config.deterministic
    ? 0x5eed1234
    : config.seed !== undefined
      ? config.seed
      : (Math.random() * 2 ** 32) >>> 0; // eslint-disable-line no-restricted-properties -- 11-flows.md §14.2, the one sanctioned call
  const rng = new Rng(worldSeed);

  const registry = new Registry();

  const ctx = {
    scene,
    camera,
    uiScene,
    uiCamera,
    canvas,
    config,
    events,
    input,
    rng,
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };

  // Engine construction proper, systems-less for now — see this file's
  // header, "ctx.time ordering". `engine.systems` is assigned once
  // `registry.init(ctx)` resolves, at B5 below.
  const engine = new Engine({ ctx, render: renderFrame });
  engine.__boot = bootLog;

  // Re-warm shaders after a WebGL context restore (11-flows.md §13.4:
  // "E->>E: prewarm(engine) again"). `render` (RNDR-3) rebuilds its own GPU
  // resources and re-emits this event, but it cannot call the shared
  // dispatcher itself: `core/prewarm.js` needs an `Engine` instance
  // (`engine.systems`, `engine.time`, `engine._accum`), and a subsystem only
  // ever sees `ctx`, which carries no engine reference — by design
  // (ARCHITECTURE.md rule 2: never import another subsystem's module, and
  // `src/core/` is off limits to `src/render/` the same way). `main.js` is
  // the one place holding both `engine` and `ctx.events`, so it's the only
  // legal call site.
  //
  // Subscribed exactly once, here, for the lifetime of this boot() call —
  // never inside the handler, never per-restore — so a page that loses and
  // regains its context repeatedly never accumulates listeners.
  //
  // Fire-and-forget by design: `EventBus.emit()` (src/core/events.js)
  // dispatches synchronously, and a handler is expected to return promptly,
  // not block that dispatch loop on prewarm's ~600ms async pass. `prewarm()`
  // never throws and its returned promise never rejects, by CORE-8's own
  // contract (`src/core/prewarm.js`'s header) — but context-restore is a
  // no-second-chances recovery path, so the `.catch` below is a second line
  // of defense against a future regression there, not a formality: it turns
  // a would-be unhandled rejection into one logged line instead of a
  // silently swallowed (or, on a stricter host, fatal) one.
  ctx.events.on('render:context-restored', () => {
    prewarm(engine).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[main] prewarm() after context restore failed:', err);
    });
  });

  record('B3', 'done', { worldSeed, width, height });

  // --- B4: Registration -------------------------------------------------------
  // `Registry.resolve()` topo-sorts on `static deps` (ARCHITECTURE.md
  // "Subsystem interface") and throws on a cycle or a missing dependency —
  // registration order below does not matter.
  //
  // Every subsystem ticket that lands adds exactly two lines to this block —
  // an import and one `registry.add(...)` call — and nothing else. `render`
  // (RNDR-1) is the first:
  registry.add(RenderSystem);
  registry.add(MaterialsSystem);
  registry.add(PhysicsSystem);
  registry.add(WorldSystem);
  registry.add(ActorsSystem);
  registry.add(PlayerSystem);
  registry.add(NavSystem);
  registry.add(CombatSystem);
  registry.add(SkillsSystem);
  registry.add(UiSystem);
  registry.add(ItemsSystem);
  registry.add(SaveSystem);
  // Next one goes directly below this line, same two-line shape. This
  // block's line count is therefore not fixed — see this file's "What
  // doesn't exist yet" header for why nothing may assert a literal total
  // subsystem count.
  //
  // `opts.systems` lets a caller (today, only tests/core/boot.test.js)
  // register additional classes without editing this block.
  const extraSystems = Array.isArray(opts.systems) ? opts.systems : [];
  for (let i = 0; i < extraSystems.length; i++) registry.add(extraSystems[i]);
  record('B4', 'done', { registered: extraSystems.length });

  // --- B5: Topological init ---------------------------------------------------
  // Throws here, before any subsystem's init() runs and before the frame
  // loop ever starts, on a cycle or an unregistered dependency
  // (registry.js's own contract). `ctx.time` is already in place (set at B3,
  // above) by the time any subsystem's `init(ctx)` runs.
  const systems = await registry.init(ctx);
  engine.systems = systems; // same array registry.init() returned, same order
  // `ids` is the resolved (topological) order by id — the shape a test
  // should check, never a hardcoded `count`, since that count grows by one
  // with every subsystem ticket that lands (see "What doesn't exist yet").
  record('B5', 'done', { count: systems.length, ids: systems.map((s) => s.constructor.id) });

  // --- B6: Input + resize ------------------------------------------------------
  input.attach(canvas);
  applyResize(systems, ctx, camera, uiCamera, width, height);
  record('B6', 'done', { width, height });

  // --- B7: Boot veil ------------------------------------------------------------
  const ui = ctx.peek('ui');
  if (ui && typeof ui.setScreen === 'function') {
    ui.setScreen('boot');
    record('B7', 'done');
  } else {
    record('B7', 'skipped', { reason: "subsystem 'ui' not registered" });
  }

  // --- B8: Shader pre-warm --------------------------------------------------------
  // `core/prewarm.js` never throws and degrades gracefully with zero
  // subsystems (see its own header). `config.prewarm` (`?prewarm=0`) is the
  // one flag config.js documents as "consulted by core/prewarm.js" but the
  // locked prewarm.js file never reads it — this call site is the only
  // place left that can honour it without editing that file.
  let warmup = {};
  if (config.prewarm) {
    warmup = await prewarm(engine);
    record('B8', 'done', { hooks: Object.keys(warmup).length });
  } else {
    record('B8', 'skipped', { reason: 'config.prewarm === false (?prewarm=0)' });
  }

  // --- B9: engine.start() ----------------------------------------------------------
  // Lockstep (explicit `?lockstep=1`, or no `requestAnimationFrame` at all —
  // i.e. Node) never starts the rAF loop; BOOT_FRAMES are pumped directly at
  // B13 instead. See this file's header for why the fallback exists.
  const canRaf = typeof requestAnimationFrame === 'function';
  const lockstep = config.lockstep === true || !canRaf;
  if (lockstep) {
    record('B9', 'done', { mode: 'lockstep', note: 'rAF loop not started; frames pumped explicitly at B13' });
  } else {
    engine.start();
    record('B9', 'done', { mode: 'raf' });
  }

  // --- B10: fx self-warm --------------------------------------------------------
  // Owned entirely by `fx` itself, on frame 2, deliberately excluded from
  // B8 (its program cache key needs the *visible* light count, which only
  // settles after render's first cull). There is nothing for main.js to
  // drive here even once `fx` exists — recorded 'done' only to reflect that
  // its owner is present, not because this file did anything.
  const fx = ctx.peek('fx');
  if (fx && typeof fx.prewarmMaterials === 'function') {
    record('B10', 'done', { note: "'fx' present; self-warm scheduling is fx's own responsibility" });
  } else {
    record('B10', 'skipped', { reason: "subsystem 'fx' not registered" });
  }

  // --- B11: Save probe -----------------------------------------------------------
  const save = ctx.peek('save');
  let slots = null;
  if (save && typeof save.meta === 'function') {
    const meta = save.meta();
    slots = (meta && meta.slots) || null;
    if (typeof save.settings === 'function') save.settings();
    record('B11', 'done');
  } else {
    record('B11', 'skipped', { reason: "subsystem 'save' not registered" });
  }

  // --- B12: Menu -------------------------------------------------------------------
  // `SaveMeta.slots` is always exactly 3 entries, `null` for an empty one
  // (01-data-model.md §10.2) — "any slot exists" means at least one is not null.
  if (ui && typeof ui.setScreen === 'function') {
    const hasSlot = Array.isArray(slots) && slots.some((s) => s !== null);
    const screen = hasSlot ? 'main_menu' : 'character_create';
    ui.setScreen(screen);
    record('B12', 'done', { screen });
  } else {
    record('B12', 'skipped', { reason: "subsystem 'ui' not registered" });
  }

  // --- B13: Harness handshake --------------------------------------------------------
  if (lockstep) {
    for (let i = 0; i < BOOT_FRAMES; i++) engine.frame(FIXED_DT);
  } else {
    await pumpRafFrames(BOOT_FRAMES);
  }

  const globalTarget = opts.global ?? (typeof window !== 'undefined' ? window : globalThis);
  globalTarget.__READY__ = true;
  globalTarget.__ENGINE__ = engine;
  globalTarget.__PREWARM__ = warmup;

  record('B13', 'done', { bootFrames: BOOT_FRAMES, mode: lockstep ? 'lockstep' : 'raf' });

  return { engine, ctx, bootLog, config };
}

// ---------------------------------------------------------------------------
// Browser autostart. Gated behind a DOM check so importing this module from
// Node (tests/core/boot.test.js) never runs it — see the module header.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[main] boot failed:', err);
  });
}
