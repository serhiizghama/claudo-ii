// src/items/icons/cache.js
//
// ITEM-15 — the icon LRU (`09-ui.md` §7.1: "cache | LRU, 192 entries;
// eviction disposes the canvas"). This milestone's own performance
// constraints name the icon cache BY NAME as one of "the four structures
// that tempt exactly this mistake" — a `Map` keyed by a per-call string —
// and separately name "icon cache keys" as the textbook template-string
// allocation trap. Both traps are avoided here:
//
//   - No `Map`. The cache is `capacity` (192) parallel `Int32Array`s
//     (`slotKey`, `prev`, `next`) plus a plain `canvases` array of canvas
//     refs, forming a classic doubly-linked-list LRU over FIXED slots —
//     `head` is the MRU slot, `tail` is the LRU slot, both O(1) to touch or
//     evict. Nothing here is resized or reallocated after `createIconCache`.
//   - No template-string key. `04-items.md` §11.2 / this ticket's own
//     acceptance criterion says the cache key is the four-field tuple
//     `(baseId, rarity, socketCount, superior)` (`09` §7.1's literal
//     `` `${baseId}|${rarity}|${socketCount}|${superior?1:0}` ``) — but that
//     literal template string is exactly the allocation this milestone
//     flags. `keyFor` below encodes the SAME four fields as one integer via
//     index arithmetic instead: `baseId` maps to a small dense integer via
//     `BASE_INDEX` (built once, at module load, off the 75-entry
//     `ITEM_BASES` table — not per call), `rarity` via a 5-entry local
//     table, `socketCount` is already an int (0..6, `01-data-model.md` §5.3:
//     `sockets.length === socketCount`, `socketMax` 0..6), and `superior` is
//     already a 0/1 flag. The result is a single `Int32Array` lookup with
//     zero allocation per call — see `keyFor`'s own comment for the exact
//     packing and why a DIRECT-MAPPED array (not a generic hash table) is
//     sufficient here: the keyspace (75 x 5 x 7 x 2 = 5250) is small and
//     bounded, so there is no collision case to handle at all.
//
// Node-safe: no `three`, no `document`/`window`, no `performance.now()`.

import { ITEM_BASES } from '../data/bases.js';

/** `09-ui.md` §7.4's five rarities, in the same order `04-items.md`'s
 * `RARITY_ORDER` uses — a local, frozen copy, not an import: matches the
 * "local, frozen, not imported" precedent `src/items/containers.js:88`
 * already sets for this exact five-value list. */
const RARITIES = Object.freeze(['normal', 'superior', 'magic', 'rare', 'unique']);
const RARITY_INDEX = Object.freeze(
  RARITIES.reduce((m, r, i) => { m[r] = i; return m; }, Object.create(null)),
);

/** `baseId -> small dense integer`, built once at module load from the
 * live 75-entry catalogue — never rebuilt per call, never a `Map` keyed by
 * a churning key set (there are only 75 keys, ever, for the life of the
 * process). */
const BASE_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < ITEM_BASES.length; i++) m[ITEM_BASES[i].id] = i;
  return m;
})();

const NUM_BASES = ITEM_BASES.length;
const NUM_RARITIES = RARITIES.length;
const SOCKET_SLOTS = 7; // 0..6, 01-data-model.md §5.3's socketCount range
const SUPERIOR_SLOTS = 2;
export const KEYSPACE = NUM_BASES * NUM_RARITIES * SOCKET_SLOTS * SUPERIOR_SLOTS;

/**
 * Packs the four-field cache key into one non-negative integer. Returns
 * `-1` for an unresolvable `baseId` (unknown to `ITEM_BASES`) — an explicit
 * "no key", never a throw, so a caller can refuse cleanly (test-form rule).
 * @param {string} baseId
 * @param {string} rarity
 * @param {number} socketCount
 * @param {boolean} superior
 * @returns {number}
 */
export function keyFor(baseId, rarity, socketCount, superior) {
  const bi = BASE_INDEX[baseId];
  if (bi === undefined) return -1;
  const ri = RARITY_INDEX[rarity];
  if (ri === undefined) return -1;
  let sc = socketCount | 0;
  if (sc < 0) sc = 0;
  if (sc > 6) sc = 6;
  const sup = superior ? 1 : 0;
  return ((bi * NUM_RARITIES + ri) * SOCKET_SLOTS + sc) * SUPERIOR_SLOTS + sup;
}

/**
 * @param {number} [capacity]
 * @returns {object} opaque cache state — pass to `cacheGet`/`cachePut`.
 */
export function createIconCache(capacity = 192) {
  const lookup = new Int32Array(KEYSPACE).fill(-1); // key -> slot, or -1
  return {
    capacity,
    lookup,
    slotKey: new Int32Array(capacity).fill(-1),
    canvases: new Array(capacity).fill(null),
    prev: new Int32Array(capacity).fill(-1),
    next: new Int32Array(capacity).fill(-1),
    head: -1, // MRU slot
    tail: -1, // LRU slot
    size: 0,
    freeCount: capacity,
    freeSlots: (() => { const a = new Int32Array(capacity); for (let i = 0; i < capacity; i++) a[i] = i; return a; })(),
  };
}

function unlink(state, slot) {
  const p = state.prev[slot], n = state.next[slot];
  if (p !== -1) state.next[p] = n; else state.head = n;
  if (n !== -1) state.prev[n] = p; else state.tail = p;
  state.prev[slot] = -1;
  state.next[slot] = -1;
}

function pushFront(state, slot) {
  state.prev[slot] = -1;
  state.next[slot] = state.head;
  if (state.head !== -1) state.prev[state.head] = slot;
  state.head = slot;
  if (state.tail === -1) state.tail = slot;
}

/**
 * @param {object} state
 * @param {number} key - from `keyFor`; `-1` always misses.
 * @returns {*} the cached canvas, or `null` on a miss.
 */
export function cacheGet(state, key) {
  if (key < 0) return null;
  const slot = state.lookup[key];
  if (slot === -1) return null;
  if (state.head !== slot) {
    unlink(state, slot);
    pushFront(state, slot);
  }
  return state.canvases[slot];
}

/**
 * Inserts `canvas` under `key`, evicting the LRU tail if the cache is full.
 * A no-op (returns `false`) for `key < 0` — never throws.
 * @returns {boolean} whether the insert happened.
 */
export function cachePut(state, key, canvas) {
  if (key < 0) return false;
  if (state.lookup[key] !== -1) {
    // Already present (a racing regenerate of the same key) — overwrite in
    // place, no slot churn.
    const slot = state.lookup[key];
    state.canvases[slot] = canvas;
    if (state.head !== slot) { unlink(state, slot); pushFront(state, slot); }
    return true;
  }
  let slot;
  if (state.freeCount > 0) {
    state.freeCount--;
    slot = state.freeSlots[state.freeCount];
    state.size++;
  } else {
    // Full: evict the LRU tail. `09` §7.1: "eviction disposes the canvas" —
    // an `OffscreenCanvas` has no explicit `.dispose()`/`.close()` of its
    // own (unlike a `three` texture); dropping the last reference is the
    // correct disposal here, so this just clears the slot's bookkeeping.
    slot = state.tail;
    unlink(state, slot);
    state.lookup[state.slotKey[slot]] = -1;
    state.canvases[slot] = null;
  }
  state.slotKey[slot] = key;
  state.canvases[slot] = canvas;
  state.lookup[key] = slot;
  pushFront(state, slot);
  return true;
}
