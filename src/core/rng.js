// src/core/rng.js
//
// CORE-5 — deterministic RNG: xoshiro128** + fork(), gauss(), disc(), pick(),
// range(), int(), bool(), u32(), weighted().
//
// Scope (docs/ARCHITECTURE.md hard rule 4 and § Determinism contract,
// docs/spec/02-api-contracts.md § Determinism, docs/IMPLEMENTATION_PLAN.md
// §1): this is the only source of randomness in the whole game. No subsystem
// may call `Math.random()` — everything goes through `ctx.rng` or a
// `ctx.rng.fork()` taken once in that subsystem's `init()` and kept for its
// lifetime. Two subsystems must never share a stream, and a given seed must
// reproduce a run bit-for-bit, so every operation here is deterministic,
// allocation-free on the hot path (rule 6), and touches nothing but its own
// four words of state.
//
// Algorithm: xoshiro128** (Blackman & Vigna, http://prng.di.unimi.it/,
// public domain / CC0). State is four uint32 words; every arithmetic step is
// done with `Math.imul` and `>>> 0` so it never drifts onto JS's float
// double-precision path, which is not bit-identical to 32-bit unsigned
// wraparound on multiplication or left-shift.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

/**
 * Rotate a uint32 left by `k` bits (0 < k < 32). `x` must already be a
 * uint32 (i.e. the caller has applied `>>> 0`); the result is one too.
 * @param {number} x
 * @param {number} k
 * @returns {number}
 */
function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * One SplitMix32-style step: advances `state` by the golden-ratio increment
 * used by SplitMix64 (`0x9e3779b9`) and runs it through the MurmurHash3
 * finalizer constants (`0x85ebca6b`, `0xc2b2ae35`) to scramble the bits.
 *
 * There is no single standardised "SplitMix32" the way there is a reference
 * SplitMix64 — this is a self-authored 32-bit composition of the same two
 * well-known building blocks, used here only to expand one seed integer into
 * four well-mixed, near-certainly-non-zero state words for xoshiro128**. It
 * is NOT validated against an external SplitMix32 reference; see the CORE-5
 * report for that caveat spelled out in full.
 *
 * @param {number} state - current uint32 SplitMix state.
 * @returns {{value: number, state: number}} the mixed output word and the
 *   advanced state, both uint32.
 */
function splitMix32Step(state) {
  const nextState = (state + 0x9e3779b9) >>> 0;
  let z = nextState;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return { value: z, state: nextState };
}

/**
 * Expands one numeric seed into four uint32 xoshiro128** state words via
 * four chained SplitMix32 steps. Deterministic: the same `seed` (after
 * `>>> 0`) always yields the same four words, which is what makes
 * `new Rng(seed)` reproduce a run.
 *
 * @param {number} seed
 * @returns {[number, number, number, number]}
 */
function expandSeed(seed) {
  let state = seed >>> 0;
  const words = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const step = splitMix32Step(state);
    state = step.state;
    words[i] = step.value;
  }
  return words;
}

export class Rng {
  /**
   * @param {number | [number, number, number, number]} [seed] - either a
   *   plain numeric seed (expanded via `expandSeed`, the public entry
   *   point used by every subsystem and by `fork()`'s caller-visible
   *   contract of "a seed reproduces a run"), or — used internally by
   *   `fork()` only — a 4-word raw state array to install directly.
   */
  constructor(seed = 0) {
    let s0, s1, s2, s3;
    if (Array.isArray(seed)) {
      [s0, s1, s2, s3] = seed;
    } else {
      [s0, s1, s2, s3] = expandSeed(seed);
    }
    // Structural guard: xoshiro128** never advances out of the all-zero
    // state (every step is xor/shift of zeros), so a nonzero seed must never
    // be allowed to expand into one. `expandSeed` makes this astronomically
    // unlikely on its own; this makes it impossible rather than merely
    // unlikely, and also covers the internal fork() path.
    if (((s0 | s1 | s2 | s3) >>> 0) === 0) s0 = 1;
    this.s0 = s0 >>> 0;
    this.s1 = s1 >>> 0;
    this.s2 = s2 >>> 0;
    this.s3 = s3 >>> 0;
    // gauss() draws two uniforms per pair (Marsaglia polar method) and
    // banks the second value; these two fields are that cache, not
    // allocation — no object is created by holding two numbers.
    this._gaussSpare = 0;
    this._hasGaussSpare = false;
  }

  /**
   * The xoshiro128** primitive: advances the state by one step and returns
   * the raw output word. Every other draw on this class is built from this.
   * Allocation-free.
   * @returns {number} a uint32, i.e. an integer in `[0, 2**32)`.
   */
  u32() {
    let s0 = this.s0;
    let s1 = this.s1;
    let s2 = this.s2;
    let s3 = this.s3;

    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;

    const t = (s1 << 9) >>> 0;

    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);

    this.s0 = s0;
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;

    return result;
  }

  /**
   * Uniform float. Allocation-free.
   * @returns {number} in `[0, 1)`.
   */
  next() {
    return this.u32() / 4294967296; // 2**32; numerator maxes at 2**32 - 1
  }

  /**
   * Uniform integer, both ends inclusive. Allocation-free.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Uniform boolean coin flip.
   * @returns {boolean}
   */
  bool() {
    return this.next() < 0.5;
  }

  /**
   * Uniform float. Allocation-free.
   * @param {number} min
   * @param {number} max
   * @returns {number} in `[min, max)`.
   */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /**
   * Standard-normal draw (mean 0, variance 1) via the Marsaglia polar
   * method, which needs no `Math.sin`/`Math.cos` and consumes exactly two
   * uniforms per *pair* of outputs — every second call is free, returned
   * from `_gaussSpare`.
   * @returns {number}
   */
  gauss() {
    if (this._hasGaussSpare) {
      this._hasGaussSpare = false;
      return this._gaussSpare;
    }
    let u, v, s;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this._gaussSpare = v * mul;
    this._hasGaussSpare = true;
    return u * mul;
  }

  /**
   * A point uniformly distributed *by area* inside a disc of the given
   * radius, centred on the origin, on the ground plane (`x`, `z`). Sampling
   * `radius * next()` for the distance would cluster points near the
   * centre — the distance has to be `radius * sqrt(next())` for the density
   * to be uniform per unit area (`07-world-gen.md`'s `mapgen.mjs` checks
   * exactly this).
   *
   * @param {number} radius
   * @param {{x: number, z: number}} [out] - if given, written in place and
   *   returned (the zero-allocation path gameplay code must use per
   *   ARCHITECTURE.md rule 6); if omitted, a fresh `{x, z}` is allocated —
   *   fine for one-shot world-gen/tooling call sites, never for a hot loop.
   * @returns {{x: number, z: number}}
   */
  disc(radius, out) {
    const r = radius * Math.sqrt(this.next());
    const theta = this.next() * Math.PI * 2;
    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);
    if (out) {
      out.x = x;
      out.z = z;
      return out;
    }
    return { x, z };
  }

  /**
   * A uniformly-chosen element of `array`.
   * @template T
   * @param {T[]} array
   * @returns {T}
   */
  pick(array) {
    return array[this.int(0, array.length - 1)];
  }

  /**
   * A weighted draw. Three call forms, all used across the spec (see the
   * CORE-5 report for the exact citations) and distinguishable without a
   * flag — arity and the shape of the single argument decide it:
   *
   *   - `weighted(candidates, weights)` — two parallel arrays: `weights[i]`
   *     is the weight of `candidates[i]`. Returns an element of
   *     `candidates`. (`07-world-gen.md`'s `S0.weighted(cands, w)`.)
   *   - `weighted(entries)` — one **array**, each element carrying its own
   *     numeric `.weight` field. Returns the element itself (not just its
   *     weight or an index), because callers need the rest of the record —
   *     `04-items.md` §12.3's treasure-class rows are exactly this shape
   *     (`{ kind: 'potion', weight: 38, sub: 'tc_potion_2' }`), and
   *     `resolveTC` needs `kind`/`sub`, not a key. This is the form named
   *     literally in `IMPLEMENTATION_PLAN.md` §1: "добавить `weighted(entries)`
   *     для лут-таблиц".
   *   - `weighted(table)` — one plain **object** mapping each candidate's
   *     key to its weight (e.g. `{ pk_ranker_line: 30, pk_ranker_archer: 22,
   *     ... }`, the shape every weight row in `06-monsters-ai.md`
   *     §5.3/§5.4 and `07-world-gen.md`'s `archetypeProtoTable` already
   *     is). Returns a key (string).
   *
   * All three forms consume **exactly one** `next()` draw regardless of how
   * many entries/candidates there are, and — given the same starting state
   * and the same weights expressed in any of the three shapes — pick the
   * "same" (i.e. same-index) entry and leave the stream in the same state.
   * This matters because `04-items.md` §12.3's twelve-step loot draw order
   * (`ARCHITECTURE.md` § Determinism contract) counts each table lookup as
   * one draw; a form that looped `next()` per candidate would desync it.
   *
   * A zero-weight entry is structurally unreachable: the cumulative
   * subtraction below only crosses zero on an entry with positive weight,
   * so it can never be the one selected. An empty input or a total weight
   * of zero has no valid answer and throws immediately, *before* consuming
   * a draw — silently returning the last entry would hide a malformed loot
   * table (e.g. every weight mistyped as 0) instead of failing loudly at
   * the call site that authored it.
   *
   * @param {any[] | Record<string, number>} candidatesOrEntriesOrTable
   * @param {number[]} [weights]
   * @returns {any}
   */
  weighted(candidatesOrEntriesOrTable, weights) {
    if (weights !== undefined) {
      return this._weightedArrays(candidatesOrEntriesOrTable, weights);
    }
    if (Array.isArray(candidatesOrEntriesOrTable)) {
      return this._weightedEntries(candidatesOrEntriesOrTable);
    }
    return this._weightedTable(candidatesOrEntriesOrTable);
  }

  /** @private */
  _weightedArrays(candidates, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (!(total > 0)) {
      throw new RangeError('Rng.weighted(candidates, weights): total weight must be > 0 (got an empty list or all-zero weights)');
    }
    let r = this.next() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r < 0) return candidates[i];
    }
    // Falls through only on floating-point rounding at the very top of the
    // range; the last candidate is the correct pick in that case too.
    return candidates[candidates.length - 1];
  }

  /** @private */
  _weightedEntries(entries) {
    let total = 0;
    for (let i = 0; i < entries.length; i++) total += entries[i].weight;
    if (!(total > 0)) {
      throw new RangeError('Rng.weighted(entries): total weight must be > 0 (got an empty array or all-zero weights)');
    }
    let r = this.next() * total;
    for (let i = 0; i < entries.length; i++) {
      r -= entries[i].weight;
      if (r < 0) return entries[i];
    }
    return entries[entries.length - 1];
  }

  /** @private */
  _weightedTable(table) {
    const keys = Object.keys(table);
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += table[keys[i]];
    if (!(total > 0)) {
      throw new RangeError('Rng.weighted(table): total weight must be > 0 (got an empty object or all-zero weights)');
    }
    let r = this.next() * total;
    for (let i = 0; i < keys.length; i++) {
      r -= table[keys[i]];
      if (r < 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  /**
   * An independent stream, seeded from four fresh words drawn off this
   * stream. Deterministic (the same parent, in the same state, always forks
   * the same child) and disjoint from the parent's own future output: the
   * four words consumed to seed the child are never returned to a caller of
   * the parent, and xoshiro128**'s state transition is a bijection, so
   * child and parent walk unrelated points of the same 2**128-1 cycle from
   * here on.
   *
   * Per `ARCHITECTURE.md` § Determinism contract: call this once per
   * subsystem, in that subsystem's `init()`, and keep the result — never
   * re-fork per event, never share a stream between two subsystems.
   *
   * @returns {Rng}
   */
  fork() {
    const s0 = this.u32();
    const s1 = this.u32();
    const s2 = this.u32();
    const s3 = this.u32();
    return new Rng([s0, s1, s2, s3]);
  }
}
