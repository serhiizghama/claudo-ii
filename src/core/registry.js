// src/core/registry.js
//
// CORE-3 — subsystem registration and topological init order.
//
// Scope (see docs/ARCHITECTURE.md "Subsystem interface" and
// docs/spec/02-api-contracts.md § Init order): subsystems are registered by
// class (`static id`, `static deps`), `resolve()` topo-sorts them from
// `static deps` into the flat, ordered array `src/main.js` (CORE-9) hands to
// `new Engine({ systems, ... })`, and `init(ctx)` walks that order awaiting
// each subsystem's async `init(ctx)` so a subsystem always sees its `deps`
// already initialized. `get`/`peek`/`has` implement the `ctx.get`/`ctx.peek`/
// `ctx.has` contract from ARCHITECTURE.md — `src/main.js` is expected to bind
// them onto `ctx` (e.g. `ctx.get = registry.get.bind(registry)`).
//
// A cycle or an unknown dependency throws out of `resolve()`/`init()` — i.e.
// at boot, before any subsystem's `init()` runs and before the frame loop
// ever starts — never lazily on a later `ctx.get()` call.
//
// Node-safe: no `three`, no DOM/browser global on any path reachable from
// import. Nothing here runs per-frame, so the allocations in `resolve()`
// (run once, at boot) are not a rule-6 violation.

export class Registry {
  constructor() {
    /** @type {Map<string, Function>} id -> subsystem class */
    this._classes = new Map();

    /** @type {string[]} ids, in the order `add()` was called. This is the
     * tie-break source for the topological sort — see `resolve()`. */
    this._registrationOrder = [];

    /** @type {string[] | null} cached topological order of ids, or `null`
     * until the first (successful) `resolve()` since the last `add()`. */
    this._resolvedOrder = null;

    /** @type {Map<string, object>} id -> instance, built once by `resolve()`
     * in resolved order and never rebuilt. */
    this._instances = new Map();

    /** @type {Set<string>} ids whose turn in `init(ctx)` has completed (or
     * that have no `init` method), i.e. visible to `get`/`peek`/`has`. */
    this._ready = new Set();
  }

  /**
   * Registers a subsystem by class. Construction (`new SystemClass()`) does
   * not happen here — it happens in `resolve()`, once, in topological order.
   *
   * @param {Function} SystemClass - must declare a unique, non-empty
   *   `static id` and may declare `static deps` (an array of ids that must
   *   be initialized before this one).
   * @returns {Registry} `this`, for chaining.
   */
  add(SystemClass) {
    const id = SystemClass && SystemClass.id;
    if (typeof id !== 'string' || id.length === 0) {
      const name = (SystemClass && SystemClass.name) || String(SystemClass);
      throw new Error(`Registry.add: '${name}' must declare a non-empty static 'id'`);
    }
    if (this._classes.has(id)) {
      throw new Error(`Registry.add: id '${id}' is already registered`);
    }

    this._classes.set(id, SystemClass);
    this._registrationOrder.push(id);

    // Any cache derived from the dependency graph is now stale.
    this._resolvedOrder = null;
    this._instances.clear();
    this._ready.clear();

    return this;
  }

  /**
   * Topologically sorts registered subsystems by `static deps` and
   * constructs one instance of each, in that order. Idempotent and cached:
   * later calls (including the one inside `init()`) return the same
   * instances without re-running the sort or re-constructing anything, so
   * this is safe to call more than once but is meant to run once at boot,
   * not per frame.
   *
   * Determinism: ties (subsystems with no ordering constraint between them,
   * e.g. `audio` and `physics`) are broken by registration order — the DFS
   * below visits ids in the order `add()` was called, and visits each
   * subsystem's own `deps` in the order they are listed in `static deps`.
   * The same sequence of `add()` calls therefore always yields the same
   * resolved order, every run.
   *
   * @returns {object[]} subsystem instances, in initialization order.
   * @throws if `static deps` contains an id that was never `add()`-ed, or if
   *   `static deps` forms a cycle. The error names every id involved.
   */
  resolve() {
    if (this._resolvedOrder) {
      return this._resolvedOrder.map((id) => this._instances.get(id));
    }

    const UNVISITED = 0;
    const VISITING = 1;
    const DONE = 2;
    const color = new Map();
    for (const id of this._registrationOrder) color.set(id, UNVISITED);

    const order = [];
    const stack = [];

    const visit = (id) => {
      const state = color.get(id);
      if (state === DONE) return;
      if (state === VISITING) {
        const start = stack.indexOf(id);
        const cycle = stack.slice(start).concat(id);
        throw new Error(`Registry.resolve: dependency cycle: ${cycle.join(' -> ')}`);
      }

      color.set(id, VISITING);
      stack.push(id);

      const SystemClass = this._classes.get(id);
      const deps = SystemClass.deps || [];
      for (const depId of deps) {
        if (!this._classes.has(depId)) {
          throw new Error(
            `Registry.resolve: '${id}' depends on '${depId}', which is not registered`,
          );
        }
        visit(depId);
      }

      stack.pop();
      color.set(id, DONE);
      order.push(id);
    };

    for (const id of this._registrationOrder) visit(id);

    // The graph is valid — build instances exactly once, in resolved order.
    this._instances.clear();
    for (const id of order) {
      const SystemClass = this._classes.get(id);
      this._instances.set(id, new SystemClass());
    }
    this._resolvedOrder = order;

    return order.map((id) => this._instances.get(id));
  }

  /**
   * Runs `resolve()` (throwing there on a cycle/missing dep before anything
   * is initialized), then awaits `instance.init(ctx)` for each subsystem in
   * that resolved order, sequentially. By the time subsystem N's `init` runs,
   * every one of its `deps` is already in `_ready`, so `ctx.get(depId)`
   * inside `init()` is safe. Subsystems without an `init` method are simply
   * marked ready in their turn.
   *
   * @param {object} ctx - the shared context; passed through unchanged.
   * @returns {Promise<object[]>} the same ordered instance array as
   *   `resolve()`, now fully initialized — this is what `src/main.js` hands
   *   to `new Engine({ systems, ctx, render })`.
   */
  async init(ctx) {
    const systems = this.resolve();
    const order = this._resolvedOrder;
    for (let i = 0; i < order.length; i++) {
      const instance = systems[i];
      if (typeof instance.init === 'function') {
        await instance.init(ctx);
      }
      this._ready.add(order[i]);
    }
    return systems;
  }

  /**
   * Calls `dispose()` on every initialized subsystem that implements it, in
   * the reverse of initialization order. Subsystems are removed from
   * `_ready` as they are disposed, so `get`/`peek`/`has` reflect teardown.
   */
  dispose() {
    if (!this._resolvedOrder) return;
    for (let i = this._resolvedOrder.length - 1; i >= 0; i--) {
      const id = this._resolvedOrder[i];
      const instance = this._instances.get(id);
      if (instance && typeof instance.dispose === 'function') instance.dispose();
      this._ready.delete(id);
    }
  }

  /**
   * `ctx.get(id)` — the runtime lookup hard rule 2 exists for
   * ("`const combat = ctx.get('combat')`"). Throws rather than returning
   * `undefined` because a subsystem reaching for a dependency it should be
   * able to see (per `static deps`/topological order) almost always has a
   * bug worth failing loudly on, not a case worth null-checking every time.
   *
   * @param {string} id
   * @returns {object}
   * @throws if `id` was never registered, or is registered but has not
   *   reached its turn in `init()` yet.
   */
  get(id) {
    if (this._ready.has(id)) return this._instances.get(id);
    if (this._classes.has(id)) {
      throw new Error(`Registry.get: '${id}' is registered but not yet initialized`);
    }
    throw new Error(`Registry.get: '${id}' is not a registered subsystem id`);
  }

  /**
   * `ctx.peek(id)` — like `get`, but for the genuinely-optional case (a
   * subsystem that may or may not be present, e.g. probing for `world` the
   * way `engine.js`'s C-3 hook does with `ctx.has`). Never throws.
   *
   * @param {string} id
   * @returns {object | undefined}
   */
  peek(id) {
    return this._ready.has(id) ? this._instances.get(id) : undefined;
  }

  /**
   * `ctx.has(id)` — true once `id` has completed its turn in `init(ctx)`
   * (or had no `init` method to run) and before any `dispose()` pass removes
   * it. False for an id that was never registered at all.
   *
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._ready.has(id);
  }
}
