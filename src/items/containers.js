// src/items/containers.js
//
// ITEM-10 — tetris containers (inventory/stash), the belt, and the cursor
// slot. `04-items.md` §12 step 10 / `09-ui.md` §16.2's `items` row list:
// `canPlace`/`place`/`autoPlace`/`remove`/`itemAt`/`freeCells`/
// `findPlacement`/`sortContainer`/`splitStack`, plus the belt
// (`beltUse`/`beltCount`/`beltCooldown`) and the cursor
// (`cursorItem`/`takeToCursor`/`dropCursor`/`returnCursor`). Every one of
// these rows already exists, verbatim, in `02-api-contracts.md` §11 — this
// ticket does not need to request or amend any row text.
//
// ---------------------------------------------------------------------------
// Data structures — why not `Map`, per this ticket's own brief
// ---------------------------------------------------------------------------
// `Alloc = no` on every row above except `splitStack` rules out `Map` keyed
// by `uid` for occupancy (the brief calls this out by name). Chosen shape:
//   - `cells`: `Int32Array(width*height)`, row-major `y*width+x`, storing the
//     covering item's `uid` per cell, `0` = empty (`01-data-model.md` §5.4's
//     own `InventoryGrid`/`StashGrid` shape, verbatim).
//   - `list`: a fixed-length `Array(width*height)` acting as a dense,
//     index-managed bag of live `ItemInstance` refs (swap-with-last removal,
//     no `splice`, no `Map`) — `01-data-model.md`'s own `items: new Map()`
//     for this same job is deliberately NOT reproduced here; a
//     never-repeating `uid` key set is exactly the leak pattern the brief
//     warns about, and this container's population is small and bounded
//     (<= 80) so a linear scan of `list` (in `itemAt`) is cheap and zero-
//     allocation, which a `Map` lookup on a churning key set is not, at
//     scale. `01`'s doc comment describes the eventually-serialised SHAPE
//     the save file reads/writes (a later ticket's, `src/items/serialise.js`
//     / ITEM-13's, problem to produce from whatever runtime shape exists by
//     then) — it does not mandate this ticket's in-memory representation.
//
// The belt is NOT modelled as a tetris grid: every consumable is 1x1
// (`04-items.md` §8.1), so `BeltSlots.slots` (`01-data-model.md` §5.4,
// verbatim: an `ItemInstance | null` per slot) is reproduced directly —
// `belt.slots[i]` IS the item, no uid indirection, no lookup needed at all.
//
// ---------------------------------------------------------------------------
// Container resolution — why `ctx.get('actors').player`, not a `Map`/state arg
// ---------------------------------------------------------------------------
// `canPlace`/`place`/`autoPlace`/`remove`/`itemAt`/`freeCells`/
// `findPlacement`/`sortContainer` take a `container:string` — no actor
// parameter (`02-api-contracts.md` §11, verbatim). `01-data-model.md` §2's
// own actor record carries `equipment`/`inventory`/`belt` (`null` unless
// `kind === 'player'`) and its own comment marks them "items subsystem, M3 —
// not built yet" — this ticket is that subsystem, and it lazily builds the
// `InventoryGrid` the first time `'inventory'` is resolved, attaching it to
// `ctx.get('actors').player` (the getter `src/actors/index.js#player`
// already exposes, ACTR-1). `'stash'` is the one shared bank
// (`01-data-model.md` §10.1: "three character slots plus one shared
// stash") and lives on this ticket's own state bag instead, never on an
// actor. ARCHITECTURE.md rule 2 ("never import another subsystem's module")
// is why this reaches `actors` through `ctx.get`, never a static import —
// `tools/check-imports.mjs` enforces exactly that for `src/items/`.
//
// ---------------------------------------------------------------------------
// Zero allocation — the scratch objects, and why `remove()` never nulls
// `item.grid`
// ---------------------------------------------------------------------------
// `findPlacement`'s contract row (`02-api-contracts.md:995`) has an `out?`
// parameter for exactly this reason: non-mutating AND `Alloc = no` together
// mean it must write into a caller-supplied `out` (or a preallocated
// fallback scratch, `state._xyScratch`, the same "live object, not a copy"
// convention `src/player/index.js`'s `_cursorScratch`/`_hudScratch` already
// use) and return that reference, never a fresh `{x,y}` literal.
// `dropCursor`'s `{ ok, swapped }` return has no such `out` parameter in its
// contract row, so `state._dropResult` is reused and mutated in place
// instead — the same trick, applied where the contract table itself gives
// no `out` to lean on.
//
// `place()`/`remove()` reuse `item.grid` across calls rather than replacing
// it: `remove()` clears occupancy and sets `item.grid.container = null`
// (never `item.grid = null`), and `place()` mutates the existing object's
// fields when one is already there, only allocating a fresh `{container,x,y}`
// the FIRST time an item is ever placed (once per item's lifetime — the same
// "steady state after the first few calls" shape `tests/items/mods.perf.test.js`
// already measures for `rolledMods`'s `out` buffer). A caller checking
// whether an item currently has a grid location must therefore test
// `item.grid && item.grid.container`, not truthiness of `item.grid` alone —
// `01-data-model.md` §5.3's "location: exactly one of grid/slot/ground is
// non-null" is a SAVE-shape invariant (`src/items/serialise.js`, ITEM-13, not
// built yet, will need to translate this internal `container: null` sentinel
// to a literal `null` when it writes `CharacterSave`); it is not violated by
// this internal representation, only expressed differently at runtime. See
// this ticket's report for the same call made explicitly.
//
// ---------------------------------------------------------------------------
// `SLOT_ORDER` / `RARITY_ORDER` — local, frozen, not imported
// ---------------------------------------------------------------------------
// Neither constant is exported anywhere in `src/` today: `01-data-model.md`
// §1.5/§1.6 document both, but `src/items/roll.js`'s own `RARITY_ORDER` is
// module-private (that file's own header note on why `src/items/drop.js`
// keeps an independent local `RARITY_RANK` rather than importing it is the
// exact precedent followed here), and `SLOT_ORDER` has never been written as
// real code at all (`src/actors/stats.js`'s own comment: "SLOT_ORDER
// iteration itself is the items subsystem's job (not built yet, M3)").
// These are gameplay-numbers-as-data (`ARCHITECTURE.md` rule 9) that would
// ideally live in `src/items/data/`, which this ticket's file grant does not
// include — flagged in the report, same deliberate-deviation precedent
// `src/items/quality.js` already set for a frozen table it needed but could
// not place in `data/`.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import { ITEM_BASES_BY_ID } from './data/bases.js';

// ---------------------------------------------------------------------------
// Constants — 09-ui.md §6.1 (geometry) / §6.6 (matrix), 04-items.md §8.3
// ---------------------------------------------------------------------------

export const INVENTORY_W = 10;
export const INVENTORY_H = 4;
export const STASH_W = 10;
export const STASH_H = 8;
export const BELT_SLOT_COUNT = 4;
export const BELT_COOLDOWN_SECONDS = 0.5; // 04-items.md §8.3

const FIXED_DT = 1 / 60; // ARCHITECTURE.md's engine-owned constant
const BELT_COOLDOWN_STEPS = Math.round(BELT_COOLDOWN_SECONDS / FIXED_DT);

const MAX_GRID_CAPACITY = Math.max(INVENTORY_W * INVENTORY_H, STASH_W * STASH_H);

// See file header — local, not imported from ./roll.js (private there).
const SLOT_ORDER = Object.freeze([
  'head', 'chest', 'hands', 'legs', 'mainHand', 'offHand',
  'belt', 'amulet', 'ring1', 'ring2',
]);
const RARITY_ORDER = Object.freeze(['normal', 'superior', 'magic', 'rare', 'unique']);

// ---------------------------------------------------------------------------
// State — one bag per `ItemsSystem` instance, created once in `init()`
// ---------------------------------------------------------------------------

function makeGrid(width, height) {
  const capacity = width * height;
  return {
    width,
    height,
    cells: new Int32Array(capacity), // uid per cell, 0 = empty
    list: new Array(capacity).fill(null), // dense bag, index-managed (no Map)
    count: 0,
  };
}

/**
 * @param {object} ctx - the engine ctx (see `ItemsSystem.init()`).
 * @returns {object} the container state bag this whole module operates on.
 */
export function createContainerState(ctx) {
  return {
    ctx,
    stash: makeGrid(STASH_W, STASH_H),
    cursor: { item: null, originContainer: null, originX: -1, originY: -1 },
    // Preallocated scratch — see file header's "Zero allocation" section.
    _xyScratch: { x: 0, y: 0 },
    _dropResult: { ok: false, swapped: null },
    _sortItems: new Array(MAX_GRID_CAPACITY).fill(null),
    _sortCellsScratch: new Int32Array(MAX_GRID_CAPACITY),
    _sortX: new Int32Array(MAX_GRID_CAPACITY),
    _sortY: new Int32Array(MAX_GRID_CAPACITY),
  };
}

function playerActor(state) {
  const ctx = state.ctx;
  if (!ctx || typeof ctx.get !== 'function') return null;
  let actors;
  try {
    actors = ctx.get('actors');
  } catch {
    return null;
  }
  return (actors && actors.player) || null;
}

function resolveGrid(state, name) {
  if (name === 'stash') return state.stash;
  if (name === 'inventory') {
    const actor = playerActor(state);
    if (!actor) return null;
    if (!actor.inventory) actor.inventory = makeGrid(INVENTORY_W, INVENTORY_H);
    return actor.inventory;
  }
  return null; // 'belt' handled separately; 'equipment'/'vendor'/'ground' are not this ticket's
}

function ensureBelt(actor) {
  if (!actor.belt) actor.belt = { slots: [null, null, null, null] };
  if (actor.belt._cooldownUntilStep === undefined) actor.belt._cooldownUntilStep = 0;
  return actor.belt;
}

// ---------------------------------------------------------------------------
// Tetris grid primitives — 09-ui.md §6.2, verbatim
// ---------------------------------------------------------------------------

function canPlaceGrid(grid, item, x, y) {
  const base = ITEM_BASES_BY_ID[item.baseId];
  const w = base ? base.invW : 1;
  const h = base ? base.invH : 1;
  if (x < 0 || y < 0 || x + w > grid.width || y + h > grid.height) return false;
  const selfUid = item.uid;
  for (let cy = y; cy < y + h; cy++) {
    const rowBase = cy * grid.width;
    for (let cx = x; cx < x + w; cx++) {
      const u = grid.cells[rowBase + cx];
      if (u !== 0 && u !== selfUid) return false;
    }
  }
  return true;
}

/** Writes `{x,y}` into `target` on success. Never mutates `grid`. */
function findPlacementGrid(grid, item, target) {
  if (!grid) return false;
  const base = ITEM_BASES_BY_ID[item.baseId];
  const w = base ? base.invW : 1;
  const h = base ? base.invH : 1;
  if (w > grid.width || h > grid.height) return false;
  for (let y = 0; y <= grid.height - h; y++) {
    for (let x = 0; x <= grid.width - w; x++) {
      if (canPlaceGrid(grid, item, x, y)) {
        target.x = x;
        target.y = y;
        return true;
      }
    }
  }
  return false;
}

function removeFromGridCells(grid, item) {
  const base = ITEM_BASES_BY_ID[item.baseId];
  const w = base ? base.invW : 1;
  const h = base ? base.invH : 1;
  const gx = item.grid.x;
  const gy = item.grid.y;
  for (let cy = gy; cy < gy + h; cy++) {
    const rowBase = cy * grid.width;
    for (let cx = gx; cx < gx + w; cx++) {
      if (grid.cells[rowBase + cx] === item.uid) grid.cells[rowBase + cx] = 0;
    }
  }
}

function removeFromGridList(grid, item) {
  for (let i = 0; i < grid.count; i++) {
    if (grid.list[i] === item) {
      const last = grid.count - 1;
      grid.list[i] = grid.list[last];
      grid.list[last] = null;
      grid.count--;
      return true;
    }
  }
  return false;
}

function canPlaceBelt(belt, item, slotIndex) {
  if (slotIndex < 0 || slotIndex >= belt.slots.length) return false;
  const base = ITEM_BASES_BY_ID[item.baseId];
  if (!base || base.category !== 'consumable') return false;
  const occupant = belt.slots[slotIndex];
  return !occupant || occupant.uid === item.uid;
}

// ---------------------------------------------------------------------------
// Public surface — 02-api-contracts.md §11
// ---------------------------------------------------------------------------

/** `canPlace(container, item, x, y) => boolean`. `ignoreUid` always defaults
 * to `item.uid` per 09-ui.md §6.2's own pseudocode default — not a public
 * parameter (`02-api-contracts.md:979` lists four params, not five). */
export function canPlace(state, container, item, x, y) {
  if (container === 'belt') {
    const actor = playerActor(state);
    if (!actor) return false;
    if (y !== 0) return false;
    return canPlaceBelt(ensureBelt(actor), item, x);
  }
  const grid = resolveGrid(state, container);
  return grid ? canPlaceGrid(grid, item, x, y) : false;
}

/** `place(container, item, x, y) => boolean`. Total: detaches the item from
 * wherever it currently sits (any container this module manages) before
 * stamping the new rectangle/slot, so a move is atomic from the caller's
 * point of view. */
export function place(state, container, item, x, y) {
  if (container === 'belt') {
    const actor = playerActor(state);
    if (!actor) return false;
    const belt = ensureBelt(actor);
    if (y !== 0 || !canPlaceBelt(belt, item, x)) return false;
    remove(state, item);
    belt.slots[x] = item;
    if (!item.grid) item.grid = { container: 'belt', x, y: 0 };
    else {
      item.grid.container = 'belt';
      item.grid.x = x;
      item.grid.y = 0;
    }
    item.slot = null;
    item.ground = null;
    return true;
  }

  const grid = resolveGrid(state, container);
  if (!grid || !canPlaceGrid(grid, item, x, y)) return false;
  remove(state, item);
  const base = ITEM_BASES_BY_ID[item.baseId];
  const w = base ? base.invW : 1;
  const h = base ? base.invH : 1;
  const uid = item.uid;
  for (let cy = y; cy < y + h; cy++) {
    const rowBase = cy * grid.width;
    for (let cx = x; cx < x + w; cx++) grid.cells[rowBase + cx] = uid;
  }
  grid.list[grid.count++] = item;
  if (!item.grid) item.grid = { container, x, y };
  else {
    item.grid.container = container;
    item.grid.x = x;
    item.grid.y = y;
  }
  item.slot = null;
  item.ground = null;
  return true;
}

/** `autoPlace(container, item) => boolean` — first fit, row-major. */
export function autoPlace(state, container, item) {
  const target = state._xyScratch;
  if (!findPlacement(state, container, item, target)) return false;
  return place(state, container, item, target.x, target.y);
}

/** `remove(item) => boolean`. Clears occupancy; see file header for why
 * `item.grid` itself is kept (its `.container` set to `null`) rather than
 * discarded. */
export function remove(state, item) {
  if (!item || !item.grid || !item.grid.container) return false;
  if (item.grid.container === 'belt') {
    const actor = playerActor(state);
    if (!actor || !actor.belt) return false;
    const idx = item.grid.x;
    if (actor.belt.slots[idx] !== item) return false;
    actor.belt.slots[idx] = null;
    item.grid.container = null;
    return true;
  }
  const grid = resolveGrid(state, item.grid.container);
  if (!grid) return false;
  removeFromGridCells(grid, item);
  const ok = removeFromGridList(grid, item);
  if (ok) item.grid.container = null;
  return ok;
}

/** `itemAt(container, x, y) => ItemInstance | null`. */
export function itemAt(state, container, x, y) {
  if (container === 'belt') {
    const actor = playerActor(state);
    if (!actor) return null;
    const belt = ensureBelt(actor);
    if (y !== 0 || x < 0 || x >= belt.slots.length) return null;
    return belt.slots[x] || null;
  }
  const grid = resolveGrid(state, container);
  if (!grid) return null;
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  const uid = grid.cells[y * grid.width + x];
  if (uid === 0) return null;
  for (let i = 0; i < grid.count; i++) {
    if (grid.list[i].uid === uid) return grid.list[i];
  }
  return null;
}

/** `freeCells(container) => int`. */
export function freeCells(state, container) {
  if (container === 'belt') {
    const actor = playerActor(state);
    if (!actor) return 0;
    const belt = ensureBelt(actor);
    let free = 0;
    for (let i = 0; i < belt.slots.length; i++) if (!belt.slots[i]) free++;
    return free;
  }
  const grid = resolveGrid(state, container);
  if (!grid) return 0;
  let free = 0;
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === 0) free++;
  return free;
}

/** `findPlacement(container, item, out?) => {x,y} | null`. Non-mutating —
 * only reads `grid.cells`, and writes the result into `out` or the shared
 * `state._xyScratch` when `out` is omitted (never a fresh object: see file
 * header). */
export function findPlacement(state, container, item, out) {
  const target = out || state._xyScratch;
  if (container === 'belt') {
    const actor = playerActor(state);
    if (!actor) return null;
    const belt = ensureBelt(actor);
    const base = ITEM_BASES_BY_ID[item.baseId];
    if (!base || base.category !== 'consumable') return null;
    for (let i = 0; i < belt.slots.length; i++) {
      if (!belt.slots[i]) {
        target.x = i;
        target.y = 0;
        return target;
      }
    }
    return null;
  }
  const grid = resolveGrid(state, container);
  return findPlacementGrid(grid, item, target) ? target : null;
}

// ---------------------------------------------------------------------------
// Sorting — 09-ui.md §6.5
// ---------------------------------------------------------------------------

function classBucket(base) {
  if (!base) return 4;
  if (base.category === 'weapon' || base.category === 'armour') return 0;
  if (base.category === 'jewelry') return 1;
  if (base.category === 'consumable') return 2;
  if (base.category === 'quest') return 3;
  return 4;
}

/**
 * Total order for the sort. §6.5 gives three rules (class/`SLOT_ORDER`,
 * then rarity/reqLevel/baseId "within a class", then "Placement: largest
 * footprint first") that do not compose into an obviously unambiguous single
 * comparator — see this ticket's report for the ambiguity. Resolved here as:
 * footprint area DOMINATES (so "largest footprint first" is literally true
 * across the whole container, which is also what makes first-fit-decreasing
 * packing actually defragment), and the class/slot/rarity/reqLevel/baseId
 * keys break ties among same-sized items, in the order §6.5 states them.
 */
function compareItems(a, b) {
  const baseA = ITEM_BASES_BY_ID[a.baseId];
  const baseB = ITEM_BASES_BY_ID[b.baseId];
  const areaA = baseA ? baseA.invW * baseA.invH : 1;
  const areaB = baseB ? baseB.invW * baseB.invH : 1;
  if (areaA !== areaB) return areaB - areaA;

  const bucketA = classBucket(baseA);
  const bucketB = classBucket(baseB);
  if (bucketA !== bucketB) return bucketA - bucketB;

  if (bucketA === 0) {
    const slotA = baseA ? SLOT_ORDER.indexOf(baseA.slot) : SLOT_ORDER.length;
    const slotB = baseB ? SLOT_ORDER.indexOf(baseB.slot) : SLOT_ORDER.length;
    if (slotA !== slotB) return slotA - slotB;
  }

  const rarA = RARITY_ORDER.indexOf(a.rarity);
  const rarB = RARITY_ORDER.indexOf(b.rarity);
  if (rarA !== rarB) return rarB - rarA;

  const reqA = baseA ? baseA.reqLevel : 0;
  const reqB = baseB ? baseB.reqLevel : 0;
  if (reqA !== reqB) return reqB - reqA;

  if (a.baseId !== b.baseId) return a.baseId < b.baseId ? -1 : 1;
  return 0;
}

/** Stable, in-place, zero-allocation (n <= 80, so O(n^2) is cheap and never
 * risks `Array.prototype.sort`'s own internal merge-buffer allocation on
 * larger arrays). */
function insertionSort(arr, n, cmp) {
  for (let i = 1; i < n; i++) {
    const cur = arr[i];
    let j = i - 1;
    while (j >= 0 && cmp(arr[j], cur) > 0) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = cur;
  }
}

function canPlaceScratch(cells, width, x, y, w, h) {
  for (let cy = y; cy < y + h; cy++) {
    const rowBase = cy * width;
    for (let cx = x; cx < x + w; cx++) {
      if (cells[rowBase + cx] !== 0) return false;
    }
  }
  return true;
}

function stampScratch(cells, width, x, y, w, h, uid) {
  for (let cy = y; cy < y + h; cy++) {
    const rowBase = cy * width;
    for (let cx = x; cx < x + w; cx++) cells[rowBase + cx] = uid;
  }
}

/**
 * `sortContainer(container) => boolean`. Only 'inventory'/'stash' — the
 * belt has no "Sort" affordance (09-ui.md §6.5: "the inventory and stash
 * headers"). Trial-packs the sorted order into a scratch cells buffer FIRST
 * and only commits (mutating the real grid and every item's `.grid`) if
 * every item finds a cell — so a container that cannot be fully repacked is
 * left byte-identical, never partially reorganised.
 */
export function sortContainer(state, container) {
  const grid = resolveGrid(state, container);
  if (!grid) return false;
  const n = grid.count;
  if (n <= 1) return true; // 0 or 1 items: trivially sorted already

  const order = state._sortItems;
  for (let i = 0; i < n; i++) order[i] = grid.list[i];
  insertionSort(order, n, compareItems);

  const trial = state._sortCellsScratch;
  const capacity = grid.cells.length;
  for (let i = 0; i < capacity; i++) trial[i] = 0;
  const xs = state._sortX;
  const ys = state._sortY;

  for (let i = 0; i < n; i++) {
    const item = order[i];
    const base = ITEM_BASES_BY_ID[item.baseId];
    const w = base ? base.invW : 1;
    const h = base ? base.invH : 1;
    let placedX = -1;
    let placedY = -1;
    for (let y = 0; y <= grid.height - h && placedX < 0; y++) {
      for (let x = 0; x <= grid.width - w; x++) {
        if (canPlaceScratch(trial, grid.width, x, y, w, h)) {
          placedX = x;
          placedY = y;
          break;
        }
      }
    }
    if (placedX < 0) return false; // cannot repack -- real grid untouched
    stampScratch(trial, grid.width, placedX, placedY, w, h, item.uid);
    xs[i] = placedX;
    ys[i] = placedY;
  }

  // Commit.
  for (let i = 0; i < capacity; i++) grid.cells[i] = trial[i];
  for (let i = 0; i < n; i++) {
    const item = order[i];
    if (!item.grid) item.grid = { container, x: xs[i], y: ys[i] };
    else {
      item.grid.container = container;
      item.grid.x = xs[i];
      item.grid.y = ys[i];
    }
    grid.list[i] = item;
  }
  return true;
}

// ---------------------------------------------------------------------------
// splitStack — the one `Alloc: yes` row
// ---------------------------------------------------------------------------
//
// A new `uid` is needed here, and `src/items/drop.js`'s own `_nextUid`
// counter (the one the rest of the pipeline uses) is private — not
// re-exported, and `drop.js` is outside this ticket's file grant (another
// agent is live in it as this is written). Rather than risk a real
// collision by starting a second counter at 1, this counter is partitioned
// into its own high range, unreachable by ordinary gameplay (`drop.js`'s
// counter would need billions of rolled items to reach it). This is a
// stopgap, flagged in the report: the correct fix is one shared counter,
// which needs a small, additive export from `drop.js` this ticket cannot
// make itself.
let _nextSplitUid = 0x40000000;

/** Test-only reset, same role as `drop.js`'s own `resetUidCounter`. */
export function resetSplitUidCounter(start = 0x40000000) {
  _nextSplitUid = start;
}

/** `splitStack(item, count) => ItemInstance | null`. Returns an unplaced
 * clone (`grid`/`slot`/`ground` all absent) carrying `count` of the stack;
 * the caller (e.g. the split-chip flow, `09-ui.md` §6.4) is expected to
 * place it immediately (`takeToCursor`, `autoPlace`, ...) — no contract row
 * gives `splitStack` a destination to place it at. */
export function splitStack(item, count) {
  if (!item) return null;
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!Number.isInteger(item.quantity) || item.quantity <= 1) return null;
  if (count >= item.quantity) return null; // must leave >= 1 behind

  item.quantity -= count;

  return {
    uid: _nextSplitUid++,
    baseId: item.baseId,
    rarity: item.rarity,
    ilvl: item.ilvl,
    identified: item.identified,
    quantity: count,
    rolls: { ...item.rolls },
    affixes: item.affixes.map((a) => ({ id: a.id, kind: a.kind, values: a.values.slice() })),
    uniqueId: item.uniqueId,
    uniqueValues: item.uniqueValues.slice(),
    nameOverride: item.nameOverride,
    durability: item.durability,
    maxDurability: item.maxDurability,
    sockets: item.sockets.slice(),
    socketCount: item.socketCount,
    _cache: {
      stats: null,
      displayName: item._cache ? item._cache.displayName : null,
      sellValue: 0,
      iconCanvas: item._cache ? item._cache.iconCanvas : null,
      unusable: false,
    },
  };
}

// ---------------------------------------------------------------------------
// The belt — 04-items.md §8.3's 0.5s global cooldown (D-23)
// ---------------------------------------------------------------------------

/** `beltCooldown(actor) => number` — seconds left, from `ctx.time.step`
 * (never the wall clock — `ARCHITECTURE.md` rule 5 / determinism contract). */
export function beltCooldown(state, actor) {
  if (!actor) return 0;
  const belt = ensureBelt(actor);
  const step = state.ctx && state.ctx.time ? state.ctx.time.step : 0;
  const remainingSteps = belt._cooldownUntilStep - step;
  return remainingSteps > 0 ? remainingSteps * FIXED_DT : 0;
}

/** `beltCount(actor, slotIndex) => int` — the slot's stack `quantity`, `0`
 * if empty or out of range. */
export function beltCount(state, actor, slotIndex) {
  if (!actor) return 0;
  const belt = ensureBelt(actor);
  if (slotIndex < 0 || slotIndex >= belt.slots.length) return 0;
  const occupant = belt.slots[slotIndex];
  return occupant ? occupant.quantity : 0;
}

/** `beltUse(actor, slotIndex) => boolean`. Container-and-cooldown bookkeeping
 * ONLY: validates the slot holds a consumable, gates on the global 0.5s
 * cooldown, decrements/removes the stack, and arms the cooldown. It does NOT
 * apply the consumable's effect (restore_life/mana amounts, the
 * overlap-replace rule, scroll behaviours — `04-items.md` §8.3) — that
 * crosses into `combat`/`player`, is not one of this ticket's contract rows,
 * and inventing an event for it (`ARCHITECTURE.md`'s event table lists none)
 * would be exactly the "public surface invented before its ticket" mistake
 * flagged elsewhere in this ticket's brief. See the report. */
export function beltUse(state, actor, slotIndex) {
  if (!actor) return false;
  const belt = ensureBelt(actor);
  if (slotIndex < 0 || slotIndex >= belt.slots.length) return false;
  const item = belt.slots[slotIndex];
  if (!item) return false;
  const base = ITEM_BASES_BY_ID[item.baseId];
  if (!base || base.category !== 'consumable') return false;
  const step = state.ctx && state.ctx.time ? state.ctx.time.step : 0;
  if (belt._cooldownUntilStep > step) return false;

  item.quantity -= 1;
  if (item.quantity <= 0) {
    belt.slots[slotIndex] = null;
    if (item.grid && item.grid.container === 'belt') item.grid.container = null;
  }
  belt._cooldownUntilStep = step + BELT_COOLDOWN_STEPS;
  return true;
}

// ---------------------------------------------------------------------------
// The cursor slot — 09-ui.md §6.3 / §16.2
// ---------------------------------------------------------------------------

/** `cursorItem` -> `ItemInstance | null`. */
export function cursorItem(state) {
  return state.cursor.item;
}

/** `takeToCursor(item) => boolean`. Only handles items this ticket's model
 * already tracks (inventory/stash/belt) — an equipped item (`item.slot` set,
 * `item.grid` absent per `01-data-model.md` §5.3) or a ground item (a
 * different, not-yet-built ticket's `dropToGround`/picker) has no `.grid`
 * for this branch to find, so it falls through to the `else` below. Such an
 * item is still accepted onto the cursor (so the cursor is always total),
 * just with no origin to restore on cancel. */
export function takeToCursor(state, item) {
  if (!item) return false;
  if (state.cursor.item) return false; // cursor already occupied

  if (item.grid && item.grid.container) {
    state.cursor.originContainer = item.grid.container;
    state.cursor.originX = item.grid.x;
    state.cursor.originY = item.grid.y;
    remove(state, item);
  } else {
    state.cursor.originContainer = null;
    state.cursor.originX = -1;
    state.cursor.originY = -1;
  }
  state.cursor.item = item;
  return true;
}

/** `dropCursor(container, x, y) => { ok, swapped }`. Reuses
 * `state._dropResult` — see file header. */
export function dropCursor(state, container, x, y) {
  const result = state._dropResult;
  result.ok = false;
  result.swapped = null;

  const held = state.cursor.item;
  if (!held) return result;

  if (container === 'belt') {
    const actor = playerActor(state);
    if (!actor) return result;
    const belt = ensureBelt(actor);
    if (y !== 0 || x < 0 || x >= belt.slots.length) return result;
    const base = ITEM_BASES_BY_ID[held.baseId];
    if (!base || base.category !== 'consumable') return result;
    const occupant = belt.slots[x];
    if (occupant && occupant !== held) {
      remove(state, occupant);
      if (!place(state, 'belt', held, x, 0)) {
        place(state, 'belt', occupant, x, 0); // restore, defensive
        return result;
      }
      state.cursor.item = occupant;
      state.cursor.originContainer = null;
      state.cursor.originX = -1;
      state.cursor.originY = -1;
      result.ok = true;
      result.swapped = occupant;
      return result;
    }
    if (!place(state, 'belt', held, x, 0)) return result;
    state.cursor.item = null;
    state.cursor.originContainer = null;
    result.ok = true;
    return result;
  }

  const grid = resolveGrid(state, container);
  if (!grid) return result;
  const base = ITEM_BASES_BY_ID[held.baseId];
  const w = base ? base.invW : 1;
  const h = base ? base.invH : 1;
  if (x < 0 || y < 0 || x + w > grid.width || y + h > grid.height) return result;

  let overlapUid = 0;
  let distinctCount = 0;
  for (let cy = y; cy < y + h; cy++) {
    const rowBase = cy * grid.width;
    for (let cx = x; cx < x + w; cx++) {
      const u = grid.cells[rowBase + cx];
      if (u !== 0 && u !== held.uid) {
        if (overlapUid === 0) {
          overlapUid = u;
          distinctCount = 1;
        } else if (u !== overlapUid) {
          distinctCount = 2;
        }
      }
    }
  }
  if (distinctCount >= 2) return result;

  if (distinctCount === 1) {
    let overlapItem = null;
    for (let i = 0; i < grid.count; i++) {
      if (grid.list[i].uid === overlapUid) {
        overlapItem = grid.list[i];
        break;
      }
    }
    if (!overlapItem) return result;
    const ox = overlapItem.grid.x;
    const oy = overlapItem.grid.y;
    remove(state, overlapItem);
    if (!place(state, container, held, x, y)) {
      place(state, container, overlapItem, ox, oy); // restore, defensive
      return result;
    }
    state.cursor.item = overlapItem;
    state.cursor.originContainer = null;
    state.cursor.originX = -1;
    state.cursor.originY = -1;
    result.ok = true;
    result.swapped = overlapItem;
    return result;
  }

  if (!place(state, container, held, x, y)) return result;
  state.cursor.item = null;
  state.cursor.originContainer = null;
  result.ok = true;
  return result;
}

/** `returnCursor() => boolean`. `Esc` / window-blur cancellation. Restores
 * the item to its snapshot origin, auto-places within the same container if
 * the origin cell has since been filled, and otherwise leaves the item on
 * the cursor — see the report for why the ground-drop fallback 09-ui.md
 * §6.3 describes is not implemented here (`dropToGround` does not exist
 * yet and is outside this ticket's grant). Never leaves the item nowhere. */
export function returnCursor(state) {
  const held = state.cursor.item;
  if (!held) return false;

  const originContainer = state.cursor.originContainer;
  if (originContainer) {
    if (place(state, originContainer, held, state.cursor.originX, state.cursor.originY)) {
      state.cursor.item = null;
      state.cursor.originContainer = null;
      return true;
    }
    const target = state._xyScratch;
    if (findPlacement(state, originContainer, held, target) &&
        place(state, originContainer, held, target.x, target.y)) {
      state.cursor.item = null;
      state.cursor.originContainer = null;
      return true;
    }
  }
  return false;
}

/**
 * ITEM-12 round 4 — internal seam, NOT attached to `ItemsSystem` (same
 * "module export, not a public method" precedent `./roll.js`'s `degrade`/
 * `applyFloor`/`legalAffixCount` already set): clears the cursor slot when
 * it holds `item`, WITHOUT placing `item` anywhere — the one operation
 * `cursorItem`/`takeToCursor`/`dropCursor`/`returnCursor` never provided
 * (all three of the latter only ever clear `cursor.item` as a side effect
 * of a successful `place()`). `dropToGround` needs exactly this: an item
 * dragged from the cursor and released onto the ground is about to get a
 * real new location (the ground registry, a different subsystem module
 * entirely) that this file has no business placing it into itself — the
 * cursor's job here is only to let go, not to choose where next.
 * @param {object} state
 * @param {object} item
 * @returns {boolean} whether the cursor was actually holding `item` (and so
 *   was released) — `false`, a no-op, when the cursor holds something else
 *   or is already empty.
 */
export function releaseCursor(state, item) {
  if (!item || state.cursor.item !== item) return false;
  state.cursor.item = null;
  state.cursor.originContainer = null;
  state.cursor.originX = -1;
  state.cursor.originY = -1;
  return true;
}
