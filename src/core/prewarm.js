// src/core/prewarm.js
//
// CORE-8 — the pre-warm dispatcher.
//
// Scope (docs/ARCHITECTURE.md "### Pre-warm", docs/spec/11-flows.md §1.4 "Pre-
// warm" and its B8/B10 stage-table rows, docs/spec/08-characters-visual.md
// §10.3): this module runs once, after `Registry.init(ctx)` has resolved and
// before `engine.start()`, and calls `prewarmMaterials(ctx)` on every
// subsystem that implements it — compiling every shader program the game will
// ever need before the first real frame, so nothing stalls mid-play. It is a
// *dispatcher*: the actual compiling is each subsystem's own `prewarmMaterials`
// (RNDR-1, MATL-1, SKY-1, WRLD-*, ACTR-*, ITMS-*, SKIL-* — none of which exist
// yet; this ticket ships the order and the safety invariants around them).
//
// None of the seven subsystems this dispatches to exist at the time this file
// is written. `buildPrewarmOrder` therefore has to behave correctly whether
// zero, one or all of them are present and whether or not each implements the
// hook — it walks `engine.systems` (CORE-3's resolved, already-topo-sorted
// array) and asks each instance for its own `constructor.id`, never importing
// or naming a subsystem class.
//
// Three invariants, restated in both 11-flows.md §1.4 and 08-characters-
// visual.md §10.3 as "learned expensively by the reference project":
//   1. A render target must be bound while compiling (outputColorSpace /
//      toneMapping are part of Three's program cache key and are read off the
//      *currently bound* target). `02-api-contracts.md` §1's "Forbidden for
//      callers" list names `setRenderTarget()` explicitly — nobody but
//      `render` may call it — and this file may not import `three` anyway
//      (rule 3), so it cannot build a `THREE.WebGLRenderTarget` itself.
//      Resolved (docs/PROGRESS.md D-3, owner-approved): `render` — once
//      RNDR-1 exists — exposes `withPrewarmTarget(fn)`, which builds and
//      binds its own 1×1 scratch target, awaits `fn()`, and restores the
//      previous target in *its own* `finally`. This dispatcher runs the
//      entire hook pass *inside* that callback when `render` implements it,
//      and degrades to running the pass directly (no target bound anywhere)
//      when it doesn't — e.g. today, since no subsystem exists yet.
//   2. Nothing here may draw from `ctx.rng` — `prewarm()` snapshots and
//      restores the root `ctx.rng`'s four xoshiro128** words (CORE-5's public
//      `s0..s3`) in a `finally` that wraps the `withPrewarmTarget` call too,
//      unconditionally, as a safety net (subsystem-owned forks like
//      `actors.geoRng` are a different stream and are that subsystem's own
//      responsibility, not this dispatcher's).
//   3. Nothing here may read the clock — this module contains no
//      `performance.now()` / `Date.now()` call, full stop (see the CORE-8
//      report for why the optional debug-timing idea in the ticket was
//      declined).
// `engine.time` (all eight fields) and `engine._accum` are snapshotted and
// restored the same way, for the same "a subsystem must not be able to shift
// the simulation" reason.
//
// Idempotent and never throws: a subsystem's `prewarmMaterials` throwing is
// caught per-hook, logged into the returned report under `{ ok:false, reason
// }` (11-flows.md §13.1's `engine.__prewarmHooks[id]`), and does not stop the
// remaining subsystems from being warmed or boot from proceeding. `render`'s
// `withPrewarmTarget` itself throwing (e.g. failing to build or restore its
// scratch target) is caught the same way and never escapes `prewarm()`.
// Re-invoking `prewarm()` (11-flows.md §13.4 calls it again after WebGL
// context restore) is safe — this module keeps no state of its own between
// calls.
//
// Node-safe: no `three` import, no DOM/browser global anywhere on this file's
// own code path (12-testing.md §2.1 / `tools/check-imports.mjs`, TEST-2).
// `ctx.rng` and every subsystem instance are treated as opaque duck-typed
// objects — this module never constructs a `THREE.*` instance and never
// touches `renderer.setRenderTarget()` itself.

/**
 * Subsystem ids invoked, in this exact order, ahead of everything else.
 * `render` first — verbatim from 11-flows.md §1.4: it patches every lit
 * material with the CSM/AO injection, and a program compiled off an
 * unpatched material is discarded by the first real frame. The rest follow
 * the §1.4 stage table, which is NOT the `02-api-contracts.md` § Init order
 * line (there `skills` precedes `items`; here `items` precedes `skills`) —
 * see the CORE-8 report for that discrepancy, flagged rather than resolved
 * silently.
 * @type {readonly string[]}
 */
const PREWARM_PRIORITY = Object.freeze([
  'render', 'materials', 'sky', 'world', 'actors', 'items', 'skills',
]);

/**
 * Ids never invoked by this dispatcher, no matter what they implement.
 * `fx` self-warms on frame 2 instead (11-flows.md B10): its program cache
 * key carries the *visible* point-light count, which only settles after
 * `render`'s first cull and `world`'s ballast stabilisation — compiling it
 * here would compile the wrong permutation.
 * @type {ReadonlySet<string>}
 */
const PREWARM_EXCLUDED = Object.freeze(new Set(['fx']));

/**
 * The static `id` of a resolved subsystem instance, per the "Subsystem
 * interface" in ARCHITECTURE.md (`static id = 'mysystem'`). `undefined` for
 * anything that isn't a proper subsystem instance — never throws.
 * @param {object} instance
 * @returns {string | undefined}
 */
function idOf(instance) {
  return instance && instance.constructor && typeof instance.constructor.id === 'string'
    ? instance.constructor.id
    : undefined;
}

/**
 * Builds the `{ id, sys }` invocation list, in dispatch order, from
 * `engine.systems` (CORE-3's flat, already-topo-sorted array). `render` →
 * `materials` → `sky` → `world` → `actors` → `items` → `skills` first, each
 * only if present AND implementing `prewarmMaterials`; `fx` never; every
 * other subsystem that implements the hook follows, in `engine.systems`
 * (i.e. init) order. Correct with zero, one or all subsystems present.
 * @param {object[]} systems
 * @returns {{id: string, sys: object}[]}
 */
function buildPrewarmOrder(systems) {
  const byId = new Map();
  for (const sys of systems) {
    const id = idOf(sys);
    if (id && !byId.has(id)) byId.set(id, sys);
  }

  const order = [];
  const seen = new Set();

  for (const id of PREWARM_PRIORITY) {
    if (PREWARM_EXCLUDED.has(id)) continue; // structurally impossible today, kept for clarity
    const sys = byId.get(id);
    if (sys && typeof sys.prewarmMaterials === 'function') {
      order.push({ id, sys });
      seen.add(id);
    }
  }

  for (const sys of systems) {
    const id = idOf(sys);
    if (!id || seen.has(id) || PREWARM_EXCLUDED.has(id)) continue;
    if (typeof sys.prewarmMaterials === 'function') {
      order.push({ id, sys });
      seen.add(id);
    }
  }

  return order;
}

/**
 * Snapshots the eight `time` fields (ARCHITECTURE.md's `time` contract) so
 * they can be restored verbatim in `finally`, regardless of what a
 * misbehaving `prewarmMaterials` (or `render.withPrewarmTarget`) did to them.
 * Never throws.
 * @param {object} engine
 * @returns {object | null}
 */
function snapshotTime(engine) {
  const time = engine && engine.time;
  if (!time || typeof time !== 'object') return null;
  return {
    elapsed: time.elapsed,
    raw: time.raw,
    dt: time.dt,
    fixed: time.fixed,
    alpha: time.alpha,
    scale: time.scale,
    frame: time.frame,
    step: time.step,
  };
}

/** Restores a snapshot from `snapshotTime` onto `engine.time`, in place — the
 * same object reference other systems hold onto must keep working. */
function restoreTime(engine, snapshot) {
  const time = engine && engine.time;
  if (!time || !snapshot) return;
  time.elapsed = snapshot.elapsed;
  time.raw = snapshot.raw;
  time.dt = snapshot.dt;
  time.fixed = snapshot.fixed;
  time.alpha = snapshot.alpha;
  time.scale = snapshot.scale;
  time.frame = snapshot.frame;
  time.step = snapshot.step;
}

/** Snapshots `engine._accum` (CORE-2's fixed-step accumulator) iff present. */
function snapshotAccum(engine) {
  return engine && Object.prototype.hasOwnProperty.call(engine, '_accum')
    ? { value: engine._accum }
    : null;
}

/** Restores `engine._accum` from a `snapshotAccum` result. */
function restoreAccum(engine, snapshot) {
  if (!engine || !snapshot) return;
  engine._accum = snapshot.value;
}

/**
 * Snapshots the root `ctx.rng`'s four xoshiro128** words (CORE-5's public
 * `s0..s3` — see `src/core/rng.js`). This is a safety net, not licence: every
 * subsystem's `prewarmMaterials` is contractually forbidden from drawing on
 * `ctx.rng` at all (they use their own `init()`-forked stream, e.g. `actors`'
 * `geoRng`, which this dispatcher has no visibility into and no business
 * touching).
 * @param {object} ctx
 * @returns {object | null}
 */
function snapshotRng(ctx) {
  const rng = ctx && ctx.rng;
  if (!rng || typeof rng.s0 !== 'number') return null;
  return { s0: rng.s0, s1: rng.s1, s2: rng.s2, s3: rng.s3 };
}

/** Restores a snapshot from `snapshotRng` onto `ctx.rng`, in place. */
function restoreRng(ctx, snapshot) {
  const rng = ctx && ctx.rng;
  if (!rng || !snapshot) return;
  rng.s0 = snapshot.s0;
  rng.s1 = snapshot.s1;
  rng.s2 = snapshot.s2;
  rng.s3 = snapshot.s3;
}

/** Logs a failure without ever throwing — swallowed intentionally, per
 * 11-flows.md §13.1: "A failed pre-warm must never be able to block boot." */
function warn(id, reason) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`prewarm: '${id}' threw`, reason);
  }
}

/**
 * Runs `prewarmMaterials(ctx)` on every subsystem in dispatch order (see
 * `buildPrewarmOrder`), catching and recording a per-hook failure without
 * ever throwing itself.
 * @param {object[]} systems
 * @param {object} ctx
 * @returns {Promise<Record<string, {ok: boolean, reason?: unknown}>>}
 */
async function runHooks(systems, ctx) {
  const hooks = {};
  let order;
  try {
    order = buildPrewarmOrder(systems);
  } catch (err) {
    warn('prewarm', err);
    order = [];
  }

  for (const { id, sys } of order) {
    try {
      await sys.prewarmMaterials(ctx);
      hooks[id] = { ok: true };
    } catch (reason) {
      hooks[id] = { ok: false, reason };
      warn(id, reason);
    }
  }

  return hooks;
}

/**
 * Runs pre-warm: calls `prewarmMaterials(ctx)` on every subsystem in
 * `engine.systems` that implements it, `render` first and `fx` always
 * excluded (see `PREWARM_PRIORITY` / `PREWARM_EXCLUDED`), while `ctx.rng`'s
 * four words, `engine.time` and `engine._accum` are protected and restored
 * in a `finally` regardless of whether any hook — or `render.withPrewarmTarget`
 * itself — throws.
 *
 * Invariant 1 (a render target must be bound while compiling): if `render`
 * is present and implements `withPrewarmTarget(fn)` (RNDR-1; not yet
 * documented as of this ticket — see docs/PROGRESS.md D-3), the entire hook
 * pass runs *inside* that callback, so `render.prewarmMaterials(ctx)` and
 * every other hook compile against the scratch target `render` itself binds
 * and restores. Without it (`render` absent, or present but not yet
 * implementing it — true for the whole engine today), the pass runs
 * directly: correctly degraded, never throws.
 *
 * Matches the call site in `11-flows.md` §1.1/§1.4/B8 — `await
 * prewarm(engine)`.
 *
 * Never throws. Idempotent — safe to call again (11-flows.md §13.4, after a
 * WebGL context restore).
 *
 * @param {object} [engine] - the `Engine` instance (CORE-2): reads
 *   `engine.systems` (CORE-3's resolved order), `engine.ctx`, `engine.time`
 *   and `engine._accum`. Anything missing degrades gracefully.
 * @returns {Promise<Record<string, {ok: boolean, reason?: unknown}>>} a
 *   report keyed by subsystem id, also assigned to `engine.__prewarmHooks`
 *   (11-flows.md §13.1) when `engine` is an object.
 */
export async function prewarm(engine) {
  const systems = Array.isArray(engine && engine.systems) ? engine.systems : [];
  const ctx = engine && engine.ctx;

  const timeSnapshot = snapshotTime(engine);
  const accumSnapshot = snapshotAccum(engine);
  const rngSnapshot = snapshotRng(ctx);

  let hooks = {};
  try {
    const renderSys = systems.find((sys) => idOf(sys) === 'render');
    if (renderSys && typeof renderSys.withPrewarmTarget === 'function') {
      try {
        await renderSys.withPrewarmTarget(async () => {
          hooks = await runHooks(systems, ctx);
        });
      } catch (reason) {
        // `withPrewarmTarget` itself failed (building/binding/restoring its
        // scratch target) — whatever hooks ran before that are already in
        // `hooks`; the rest are simply not warmed this pass. Boot proceeds.
        warn('render.withPrewarmTarget', reason);
      }
    } else {
      hooks = await runHooks(systems, ctx);
    }
  } finally {
    restoreRng(ctx, rngSnapshot);
    restoreTime(engine, timeSnapshot);
    restoreAccum(engine, accumSnapshot);
  }

  if (engine && typeof engine === 'object') engine.__prewarmHooks = hooks;
  return hooks;
}
