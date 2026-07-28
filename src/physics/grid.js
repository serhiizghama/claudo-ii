// src/physics/grid.js
//
// PHYS-1 — the uniform static grid: a fixed 2 m cell size over the XZ plane
// (docs/spec/02-api-contracts.md §4: "the whole thing lives in a uniform
// grid of 2 m cells... Everything is O(actors in a cell), deterministic").
//
// This file is pure spatial-hashing plumbing and knows nothing about
// `Footprint`, bodies, layers or masks — `src/physics/index.js` (the public
// `PhysicsSystem`) owns that. `UniformGrid` only ever sees axis-aligned
// bounding boxes and integer handles, which keeps it reusable for whatever
// PHYS-2/3/4/5 (bodies, casts, separation, projectile sweeps — same
// directory, later tickets) need to hash next.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.
//
// ---------------------------------------------------------------------------
// Why a hand-rolled open-addressing table instead of a `Map`
// ---------------------------------------------------------------------------
// The first working version of `rebuild()` used a `Map<number, number>` for
// cell-key -> slot. It was correct and simple, but measured at 2.5–3.6 ms for
// 10 000 statics spread over a town-sized area — over the ≤ 2 ms acceptance
// budget, with too little headroom to trust in CI even where it happened to
// land under 2 ms (see the PHYS-1 report for the actual samples). Profiling
// pointed at `Map` get/set overhead, not the surrounding arithmetic: cell
// keys are already small non-negative 30-bit integers (`packCellKey`), and a
// flat `Int32Array` open-addressing table over them is the standard, much
// cheaper substitute — no boxing, no hidden-class/hash-bucket machinery, and
// the exact upper bound on distinct cells (`totalEntries`, computed for free
// while sizing the output arrays anyway) lets the table be sized once, with
// no resize during a rebuild. This bought back an order of magnitude: see
// the report for before/after numbers.
//
// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
// `rebuild()` is the one place that "hashes" — it walks `handles` (and the
// four parallel AABB arrays) strictly in the order the caller gives them,
// index 0 first, and for each one scans its covered cells in ascending
// (cx, then cz) order. The open-addressing table below is only ever
// populated by that single, fixed double loop, and linear probing is itself
// a pure function of (insertion order, table capacity) — so its final
// layout is a deterministic function of the input arrays, never an
// incidental artifact of timing. `PhysicsSystem` is what makes the *input*
// order deterministic (ascending handle == ascending static-registration
// order, per its own file); this module just never disturbs it. Two calls
// to `rebuild()` with the same inputs, on two different `UniformGrid`
// instances, always produce byte-identical `_cellStart`/`_entries` arrays
// and the same table layout — see `tests/physics/phys1.test.js` for the
// cross-instance check this claim is tested against.
//
// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------
// `rebuild()` allocates (the hash table's two `Int32Array`s, a few small
// bookkeeping arrays, and the final `Int32Array`s) — that is
// `02-api-contracts.md` §4's documented `rebuild | Alloc: yes`, exercised
// once per zone load, never per frame. What it deliberately does NOT do is
// allocate per footprint: no object is created per cell visited, no
// closures inside the hot double loop, and there is exactly one full pass
// over the table-touching work (a second, cheaper pass reuses the first
// pass's recorded per-entry slot, never re-hashing). `forEachInCell` /
// `forEachCell` (queries, run any time) allocate nothing at all.

/** Fixed by the spec — do not make this configurable per zone or per call;
 * `02-api-contracts.md` §4 names 2 m as part of the contract, not a tuning
 * knob. Kept as a named export so `src/physics/index.js` and later PHYS-*
 * tickets in this directory share the one definition instead of retyping
 * the literal. */
export const CELL_SIZE = 2;

// A cell-key is packed as two 15-bit signed-ish fields (via a fixed offset)
// into one 30-bit non-negative integer, safe as an Int32 and cheap to hash.
// 15 bits per axis, with CELL_SIZE = 2 m, covers cell coordinates in
// [-16384, 16383] — i.e. a world extent of roughly ±32.7 km on each axis.
// Every zone in this game is at most on the order of 100 m (07-world-gen.md),
// so this has orders of magnitude of headroom; documented here so a future
// change of CELL_SIZE or a much larger world doesn't silently wrap without
// anyone knowing why.
const CELL_KEY_BITS = 15;
const CELL_KEY_OFFSET = 1 << (CELL_KEY_BITS - 1); // 16384
const CELL_KEY_MASK = (1 << CELL_KEY_BITS) - 1; // 0x7FFF

/**
 * Packs a (cx, cz) cell coordinate pair into one non-negative 30-bit
 * integer. Deterministic, allocation-free, pure arithmetic — no string
 * concatenation (which would allocate on every call, including inside
 * `rebuild()`'s hot loop).
 * @param {number} cx
 * @param {number} cz
 * @returns {number}
 */
export function packCellKey(cx, cz) {
  const ux = (cx + CELL_KEY_OFFSET) & CELL_KEY_MASK;
  const uz = (cz + CELL_KEY_OFFSET) & CELL_KEY_MASK;
  return (ux << CELL_KEY_BITS) | uz;
}

/**
 * The inverse of `packCellKey` — recovers the (cx, cz) pair. Only used for
 * debugging/tests today (`setDebugDraw`'s eventual consumer and
 * `tests/physics/phys1.test.js`), never on a hot path.
 * @param {number} key
 * @returns {{cx: number, cz: number}}
 */
export function unpackCellKey(key) {
  const uz = key & CELL_KEY_MASK;
  const ux = (key >>> CELL_KEY_BITS) & CELL_KEY_MASK;
  return { cx: ux - CELL_KEY_OFFSET, cz: uz - CELL_KEY_OFFSET };
}

/** Sentinel for "this hash-table slot is empty". `packCellKey` only ever
 * produces non-negative values (30-bit), so -1 can never collide with a
 * real key. */
const EMPTY_KEY = -1;

/** Fibonacci/multiplicative hashing (the same 32-bit golden-ratio family
 * `src/core/rng.js`'s SplitMix32 step uses) so that spatially-adjacent cell
 * keys — which differ by 1 in the low bits, or by `2**CELL_KEY_BITS` for a
 * one-row step — don't cluster in the table; a raw `key & mask` would.
 * `Math.imul` keeps this a 32-bit integer operation, never drifting onto
 * JS's float path. @param {number} key @param {number} mask @returns {number} */
function hashSlotIndex(key, mask) {
  return (Math.imul(key, 0x9e3779b1) >>> 0) & mask;
}

/** Smallest power of two `>= n`, minimum `16` (keeps the table's load
 * factor comfortably low even for a handful of cells, and a power-of-two
 * capacity is what makes `& mask` a valid modulo). @param {number} n @returns {number} */
function nextPow2AtLeast16(n) {
  let capacity = 16;
  while (capacity < n) capacity *= 2;
  return capacity;
}

/**
 * A uniform spatial hash over the XZ plane, cell size `CELL_SIZE`. Storage
 * is CSR-style (compressed-sparse-row): one dense `Int32Array` of handles
 * (`_entries`), sliced per occupied cell by `_cellStart` offsets, with a
 * flat open-addressing table (`_hashKeys`/`_hashSlots`) translating a cell
 * key into its slot. This is the standard "linked cell list flattened into
 * two arrays" broadphase layout — no per-cell object, no per-cell array, no
 * object identity to churn through the GC on a rebuild, and (see the module
 * header) no `Map` on the hot path either.
 */
export class UniformGrid {
  /** @param {number} [cellSize] */
  constructor(cellSize = CELL_SIZE) {
    this.cellSize = cellSize;

    // An empty table (every slot EMPTY_KEY) so every query method works
    // before the first `rebuild()` — an unbuilt grid behaves exactly like
    // an empty one.
    this._hashKeys = new Int32Array(16).fill(EMPTY_KEY);
    this._hashSlots = new Int32Array(16);
    this._hashMask = 15;
    this._cellCount = 0;

    /** @type {Int32Array} length `cellCount + 1`; `_entries.slice(
     * _cellStart[slot], _cellStart[slot+1])` is one cell's handles. */
    this._cellStart = new Int32Array(1);
    /** @type {Int32Array} every hashed (footprint, cell) pair, grouped by
     * cell slot, ascending-handle order within each group. */
    this._entries = new Int32Array(0);
  }

  /** Number of distinct occupied cells after the last `rebuild()`. */
  get cellCount() {
    return this._cellCount;
  }

  /** Total (footprint, cell) pairs after the last `rebuild()` — a footprint
   * spanning 3 cells counts 3 times here, once per `forEachInCell` visit. */
  get entryCount() {
    return this._entries.length;
  }

  /** @param {number} x @returns {number} */
  cellIndexX(x) {
    return Math.floor(x / this.cellSize);
  }

  /** @param {number} z @returns {number} */
  cellIndexZ(z) {
    return Math.floor(z / this.cellSize);
  }

  /** Linear-probes `_hashKeys`/`_hashSlots` for `key`; returns its slot, or
   * -1 if `key` was never inserted. Allocation-free.
   * @private
   * @param {number} key
   * @returns {number} */
  _findSlot(key) {
    const mask = this._hashMask;
    const keys = this._hashKeys;
    let idx = hashSlotIndex(key, mask);
    for (;;) {
      const k = keys[idx];
      if (k === EMPTY_KEY) return -1;
      if (k === key) return this._hashSlots[idx];
      idx = (idx + 1) & mask;
    }
  }

  /**
   * Rebuilds the whole grid from scratch. `handles[i]` occupies every cell
   * its AABB (`minX[i]..maxX[i]`, `minZ[i]..maxZ[i]`) overlaps, inclusive of
   * the cells the max edge falls in. All five arrays must be the same
   * length and are read in index order — see the module header for why that
   * order is what makes this deterministic. Previous contents are fully
   * discarded (this is a rebuild, not an incremental update).
   *
   * @param {ArrayLike<number>} handles
   * @param {ArrayLike<number>} minX
   * @param {ArrayLike<number>} minZ
   * @param {ArrayLike<number>} maxX
   * @param {ArrayLike<number>} maxZ
   */
  rebuild(handles, minX, minZ, maxX, maxZ) {
    const n = handles.length;
    const cellSize = this.cellSize;

    // Pass 0 — pure arithmetic, no table touched: cache each footprint's
    // cell range (both later passes need it, and `Math.floor` is cheap
    // enough that computing it once here rather than inline is purely a
    // clarity/reuse choice) and sum `totalEntries`, a safe upper bound on
    // the number of distinct cells too (a distinct cell has >= 1 entry).
    // That bound sizes the hash table once, up front, so `rebuild()` never
    // resizes mid-pass.
    const cx0 = new Int32Array(n);
    const cx1 = new Int32Array(n);
    const cz0 = new Int32Array(n);
    const cz1 = new Int32Array(n);
    let totalEntries = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(minX[i] / cellSize);
      const b = Math.floor(maxX[i] / cellSize);
      const c = Math.floor(minZ[i] / cellSize);
      const d = Math.floor(maxZ[i] / cellSize);
      cx0[i] = a;
      cx1[i] = b;
      cz0[i] = c;
      cz1[i] = d;
      totalEntries += (b - a + 1) * (d - c + 1);
    }

    // <= 50% load factor against the worst case (every pair a distinct
    // cell) — comfortable for linear probing.
    const capacity = nextPow2AtLeast16((totalEntries + 1) * 2);
    const mask = capacity - 1;
    const hashKeys = new Int32Array(capacity).fill(EMPTY_KEY);
    const hashSlots = new Int32Array(capacity);

    const countOfSlot = new Int32Array(totalEntries); // upper bound on cellCount
    /** @type {Int32Array} the slot visited at each step below, in the exact
     * order visited — lets the fill pass place every entry without
     * re-hashing (see the module header for why this exists). */
    const entrySlot = new Int32Array(totalEntries);

    // Pass 1 — the one table-touching pass. Iterates `i` ascending, then
    // `cx` ascending, then `cz` ascending: the canonical order (see module
    // header) that makes the table's final layout, and `entrySlot` itself,
    // a deterministic function of the inputs.
    let cellCount = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = cx0[i];
      const b = cx1[i];
      const c = cz0[i];
      const d = cz1[i];
      for (let cx = a; cx <= b; cx++) {
        for (let cz = c; cz <= d; cz++) {
          const key = packCellKey(cx, cz);
          let idx = hashSlotIndex(key, mask);
          while (hashKeys[idx] !== EMPTY_KEY && hashKeys[idx] !== key) idx = (idx + 1) & mask;

          let slot;
          if (hashKeys[idx] === EMPTY_KEY) {
            slot = cellCount++;
            hashKeys[idx] = key;
            hashSlots[idx] = slot;
          } else {
            slot = hashSlots[idx];
          }
          countOfSlot[slot]++;
          entrySlot[k] = slot;
          k++;
        }
      }
    }

    const cellStart = new Int32Array(cellCount + 1);
    for (let s = 0; s < cellCount; s++) cellStart[s + 1] = cellStart[s] + countOfSlot[s];

    // Fill pass — no table access at all. Re-derives each footprint's cell
    // *count* (cheap arithmetic, not a lookup) purely to know how many
    // consecutive `entrySlot` entries belong to it, then walks `entrySlot`
    // (recorded in lockstep with pass 1) to place each one. `writeCursor
    // [slot]` starts at that cell's own `cellStart` and advances one per
    // write, and because this visits footprints in the same order pass 1
    // did, each cell's entries land in ascending-handle order.
    const writeCursor = cellStart.slice(0, cellCount);
    const entries = new Int32Array(totalEntries);
    k = 0;
    for (let i = 0; i < n; i++) {
      const handle = handles[i];
      const pairCount = (cx1[i] - cx0[i] + 1) * (cz1[i] - cz0[i] + 1);
      for (let p = 0; p < pairCount; p++) {
        const slot = entrySlot[k];
        entries[writeCursor[slot]] = handle;
        writeCursor[slot]++;
        k++;
      }
    }

    this._hashKeys = hashKeys;
    this._hashSlots = hashSlots;
    this._hashMask = mask;
    this._cellCount = cellCount;
    this._cellStart = cellStart;
    this._entries = entries;
  }

  /**
   * Calls `fn(handle)` once per handle hashed into cell `(cx, cz)`, in
   * ascending-handle order. A no-op on an empty/unhashed cell. Allocation-
   * free; `fn` must not add/remove statics or call `rebuild()` while this is
   * walking (the same "don't mutate while iterating" discipline as
   * `EventBus.emit`).
   * @param {number} cx
   * @param {number} cz
   * @param {(handle: number) => void} fn
   */
  forEachInCell(cx, cz, fn) {
    const slot = this._findSlot(packCellKey(cx, cz));
    if (slot === -1) return;
    const start = this._cellStart[slot];
    const end = this._cellStart[slot + 1];
    const entries = this._entries;
    for (let i = start; i < end; i++) fn(entries[i]);
  }

  /**
   * Calls `fn(key, start, end, entries)` once per occupied cell — `entries`
   * is the shared backing array, `[start, end)` the slice belonging to this
   * cell (unpack `key` with `unpackCellKey` for the `(cx, cz)` pair).
   * Iteration order is a deterministic function of the last `rebuild()`'s
   * inputs (see the module header) but is table-slot order, not spatially
   * sorted — a debug overlay or a test that wants cell coordinates walks
   * this and calls `unpackCellKey(key)` itself. Allocation-free.
   * @param {(key: number, start: number, end: number, entries: Int32Array) => void} fn
   */
  forEachCell(fn) {
    const keys = this._hashKeys;
    const slots = this._hashSlots;
    const cellStart = this._cellStart;
    const entries = this._entries;
    for (let idx = 0; idx < keys.length; idx++) {
      const key = keys[idx];
      if (key === EMPTY_KEY) continue;
      const slot = slots[idx];
      fn(key, cellStart[slot], cellStart[slot + 1], entries);
    }
  }
}
