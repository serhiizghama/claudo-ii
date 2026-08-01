// src/items/rng.js
//
// ITEM-4 — RNG plumbing for `items`.
//
// The `items` fork itself — the one `ctx.rng.fork()` this subsystem is
// allowed (ARCHITECTURE.md hard rule 4 / the Determinism contract: "one
// fork per subsystem ... taken once in init(), never re-forked per event")
// — is taken in `src/items/index.js#init()`, not here. This file holds the
// one piece of RNG-adjacent infrastructure that belongs to `items` rather
// than to `src/core/rng.js` itself: `CountingRng`, a draw-counting
// decorator.
//
// Why it exists: this ticket's acceptance criterion (04-items.md §12 row 4)
// is "a counting Rng wrapper proves rollQuality consumes exactly one
// draw" — proof by instrumentation, not by reading the source. The same
// proof is needed by every later step of the loot pipeline (ITEM-5/6/8/9)
// against its own row of the draw order (04-items.md §9.2), so the counter
// lives here, once, rather than being re-invented per ticket.
//
// `CountingRng` never changes what a wrapped stream produces or how its
// state advances — every call is forwarded to the real `Rng` unchanged; the
// wrapper only also increments `draws`. Wrapping a stream in one therefore
// cannot desync a determinism check: swap the wrapper out for the raw `Rng`
// it holds and the sequence of values returned to the caller is identical.
//
// Only the primitives `04-items.md` §9.2's draw order actually uses appear
// here (`U(0,1)` -> `next()`, `Ui(a,b)` -> `int()`, `W(...)` -> `weighted()`,
// plus `u32()`/`bool()`/`range()`/`pick()` for completeness of the "one call
// == one draw" primitives `src/core/rng.js` documents). `gauss()`/`disc()`
// are world-gen-only (see that file's own header) and no `04-items.md` draw
// uses either, so they are deliberately not wrapped.

export class CountingRng {
  /** @param {import('../core/rng.js').Rng} rng - the real stream to wrap. */
  constructor(rng) {
    this._rng = rng;
    this.draws = 0;
  }

  /** @returns {number} a uint32; counts as one draw, same as the wrapped Rng. */
  u32() {
    this.draws++;
    return this._rng.u32();
  }

  /** @returns {number} in [0, 1); one draw. */
  next() {
    this.draws++;
    return this._rng.next();
  }

  /** @returns {number} uniform int, both ends inclusive; one draw. */
  int(min, max) {
    this.draws++;
    return this._rng.int(min, max);
  }

  /** @returns {boolean} one draw. */
  bool() {
    this.draws++;
    return this._rng.bool();
  }

  /** @returns {number} uniform float in [min, max); one draw. */
  range(min, max) {
    this.draws++;
    return this._rng.range(min, max);
  }

  /** @returns {*} a uniformly-chosen element; one draw (via the wrapped int()). */
  pick(array) {
    this.draws++;
    return this._rng.pick(array);
  }

  /**
   * @returns {*} `src/core/rng.js#weighted`'s own contract: exactly one
   *   `next()` draw regardless of call form or candidate count.
   */
  weighted(candidatesOrEntriesOrTable, weights) {
    this.draws++;
    return this._rng.weighted(candidatesOrEntriesOrTable, weights);
  }
}
