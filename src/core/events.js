// src/core/events.js
//
// CORE-4 — the allocation-free EventBus behind `ctx.events`. Reached by
// every subsystem via `ctx.events.on/off/emit` (docs/ARCHITECTURE.md
// "Emit and listen via `ctx.events`"); the canonical event/payload table
// lives in that document's "Cross-subsystem events" section.
//
// Node-safe: no `three` import, no DOM access anywhere in this file.
//
// --- The allocation contract (02-api-contracts.md C-4) -------------------
//
// `emit` must not allocate. The naive `for (const fn of [...set])` copies
// the handler set on every dispatch; at `actor:damage` rates in a
// 25-monster fight that is a per-frame allocation (ARCHITECTURE.md rule 6,
// Determinism contract). Instead each event's handlers live in a dense
// array (`Bucket.fns`) and `emit` walks it by numeric index — no spread,
// no `Array.from`/`slice`, no closures, no template strings, no `Map`
// iteration, on the hot path.
//
// A plain index walk over a live array breaks the moment a handler calls
// `on()`/`off()` on the very event being dispatched — a real pattern (a
// handler that unsubscribes itself, or subscribes a follow-up handler).
// Two rules, together, make that safe without allocating:
//
//   1. **Generation guard.** `emit` snapshots `boundary = fns.length`
//      before calling the first handler and never walks past it. `on()`
//      always appends, so a handler subscribed mid-emit lands at an index
//      >= boundary and is simply not visited by the emit in progress — it
//      is included starting with the *next* emit of that event, never as
//      a side effect of the one that added it. This is the "generation":
//      the array's length at walk-start *is* the generation number, and
//      every slot at or past `boundary` belongs to a later generation.
//   2. **Tombstoned removal.** `off()` never splices — shifting elements
//      would move a not-yet-visited handler into an already-visited index
//      (skipping it) or vice versa (double-calling it), for every walk
//      currently in progress over that bucket, including a re-entrant one.
//      It writes `undefined` into the slot instead; `emit` skips holes.
//      Holes are only physically compacted out of the array once every
//      walk over that bucket (outermost emit plus any it re-entrantly
//      triggered) has finished — `Bucket.depth` tracks that.
//
// Re-entrancy (02-api-contracts.md "Event discipline": handlers run
// synchronously, a handler may `emit` again, keep chains at most two
// deep): a nested `emit` call — same event or a different one — gets its
// own local `boundary`/loop-index on its own call frame, so it neither
// disturbs an outer walk in progress nor allocates.
//
// A handler that throws is caught and logged, and does not stop the
// remaining handlers for that emit (02-api-contracts.md "Event
// discipline").

/** Per-event handler storage: a dense array with tombstoned holes. */
class Bucket {
  constructor() {
    /** @type {Array<Function|undefined>} subscription order; a removed
     * slot is tombstoned to `undefined` rather than spliced out. */
    this.fns = [];
    /** Live (non-hole) handler count — lets `emit` skip an all-removed
     * bucket without walking it. */
    this.size = 0;
    /** Re-entrancy depth: >0 while some `emit` (outermost or nested) is
     * walking this bucket. Compaction and hole-reuse are only safe at 0. */
    this.depth = 0;
    /** Set when `off()` tombstones a slot; tells the walk that is about
     * to unwind back to depth 0 whether compaction is worth doing. */
    this.holey = false;
  }
}

/** Squeezes tombstoned holes out of `bucket.fns` in place (two-pointer
 * compaction, no new array). Only ever called at `depth === 0` — doing it
 * while a walk is in progress would shift indices out from under it. */
function compact(bucket) {
  const fns = bucket.fns;
  let write = 0;
  for (let read = 0; read < fns.length; read++) {
    const fn = fns[read];
    if (fn !== undefined) fns[write++] = fn;
  }
  fns.length = write;
  bucket.holey = false;
}

export class EventBus {
  constructor() {
    /** @type {Map<string, Bucket>} */
    this._buckets = new Map();
  }

  /**
   * Subscribe `fn` to `event`. Subscription order is call order and is
   * the order `emit` invokes handlers in.
   *
   * Calling `on()` from inside a handler during an `emit` of the same
   * event is safe: the new handler is appended past that emit's
   * generation guard, so it is excluded from the emit currently running
   * and included starting with the next one.
   */
  on(event, fn) {
    let bucket = this._buckets.get(event);
    if (bucket === undefined) {
      bucket = new Bucket();
      this._buckets.set(event, bucket);
    }
    bucket.fns.push(fn);
    bucket.size++;
  }

  /**
   * Unsubscribe `fn` from `event`. A no-op — never a throw — if `event`
   * has no such handler (unknown event, or `fn` was never subscribed, or
   * already removed).
   *
   * Safe to call from inside a handler, including a handler removing
   * itself: the slot is tombstoned, not spliced, so an in-progress walk
   * (this emit or an outer one re-entered into) skips it without
   * shifting any other handler's index.
   */
  off(event, fn) {
    const bucket = this._buckets.get(event);
    if (bucket === undefined) return;
    const fns = bucket.fns;
    for (let i = 0; i < fns.length; i++) {
      if (fns[i] === fn) {
        fns[i] = undefined;
        bucket.size--;
        bucket.holey = true;
        if (bucket.depth === 0) compact(bucket);
        return;
      }
    }
  }

  /**
   * Call every handler currently subscribed to `event`, synchronously,
   * in subscription order, with `payload`. Allocates nothing — see the
   * module header. Emitting an event with no subscribers is cheap (one
   * `Map.get` and a size check) and never throws.
   */
  emit(event, payload) {
    const bucket = this._buckets.get(event);
    if (bucket === undefined || bucket.size === 0) return;

    const fns = bucket.fns;
    const boundary = fns.length; // the generation guard for this walk
    bucket.depth++;
    for (let i = 0; i < boundary; i++) {
      const fn = fns[i];
      if (fn === undefined) continue; // tombstoned by off() mid-walk
      try {
        fn(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[events] handler for '${event}' threw:`, err);
      }
    }
    bucket.depth--;
    if (bucket.depth === 0 && bucket.holey) compact(bucket);
  }
}
