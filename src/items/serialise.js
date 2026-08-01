// src/items/serialise.js
//
// ITEM-16 — save round-trip. Two functions, one pair:
//   - `serialiseItem(item)` writes exactly the field list
//     `01-data-model.md` §5.3 (L888-891) names, plus `uniqueValues`
//     (`04-items.md` §12 step 13's own line — that field is SERIALISED per
//     §5.3's own field comment at L857-864, the L888-891 sentence simply
//     predates it in the same document).
//   - `rebuildCache(item)` is `02-api-contracts.md:973`'s contracted row —
//     the only method this ticket attaches to `ItemsSystem` (see
//     `./index.js`'s wiring block). It restores everything §5.3 marks
//     "cached, never serialised" on an item that just came off a
//     `JSON.parse` (a `SavedItem`, already carrying every field
//     `serialiseItem` wrote, assigned onto it directly — no expansion
//     needed for `grid`/`slot`/`sockets`, which are already in their final
//     runtime shape) or that was just re-identified.
//
// `src/save/` (SAVE-1) does not exist in this tree yet — it is the intended
// caller of both, per this ticket's own file grant (only `serialise.js`,
// the `index.js` wiring block, and this file's own test). Per the test-form
// rule, this file's tests assert that both functions ROUTE correctly and
// produce well-formed output on real, `rollItem`-produced fixtures — they
// do not assert anything about `src/save/`'s absence.
//
// ---------------------------------------------------------------------------
// Ruling D-33 — `nameOverride` serialises as TWO INTEGERS
// ---------------------------------------------------------------------------
// `roll.js`'s own D13 call site (see that file's comment next to
// `item.nameOverride = rollRareName(rng)`) already explains why a rolled
// item's `nameOverride` is `{ headIndex, tailIndex, code, en, ru }`, not the
// bare string `01-data-model.md` §5.3 types it as: `items` has no active-
// language parameter and may not import `src/ui/i18n.js`
// (`ARCHITECTURE.md` hard rule 2), so baking in one language at roll time
// would silently discard the other forever. The orchestrator's ruling:
// the SAVE carries only `headIndex`/`tailIndex` — two integers, zero drift,
// the same "derived, non-serialised, rebuilt on load" treatment `01` §5
// already prescribes for `_cache`. `rebuildCache` below recomposes `en`/`ru`
// (and `code`) via `composeRareName`, drawing no RNG and touching no ring
// state — see this ticket's report for the zero-draw proof.
//
// ---------------------------------------------------------------------------
// ITEM-10's flagged deviation — `item.grid` is never nulled by `remove()`
// ---------------------------------------------------------------------------
// `./containers.js#remove` keeps the `{container, x, y}` object alive and
// only clears `.container`, on purpose (allocation-free steady state; see
// that file's own header). Its report named this ticket as the owner of
// translating that into a literal `grid: null` at serialise time — a stale
// `{container: null, x: 3, y: 7}` must never reach the save file. Handled
// below: `grid` is written only when `item.grid && item.grid.container` is
// truthy AND the item is not equipped; otherwise `null`.
//
// ---------------------------------------------------------------------------
// ITEM-11's flagged gap — `_cache.weapon`
// ---------------------------------------------------------------------------
// `./equipment.js`'s own header flags: "rebuildCache will need to populate
// `_cache.weapon` too, for a save-loaded item that gets equipped without
// going through `equip()` first." Its writer, `refreshWeaponCache`, was a
// private, unexported function local to `equipment.js` — the orchestrator's
// round-2 ruling granted this ticket a one-line, `export`-keyword-only edit
// to that file (see its own header comment on the export line) rather than
// let a second, independently-maintained copy of `_cache.weapon`'s write
// logic exist: `combat`'s `resolveWeapon` reads this exact cache for a
// geared player's damage, and two copies drifting apart is O-55 — a loaded
// save silently falling back to `unarmed` damage — returning as a stale-
// cache defect. `rebuildCache` below calls the SAME function `equip()`
// calls, imported, not reproduced.
//
// ---------------------------------------------------------------------------
// Ruling — an older save without `uniqueValues` defaults to the MINIMUM
// ---------------------------------------------------------------------------
// This ticket's brief: "never the maximum — a load path that rolls higher
// than the save recorded is item duplication by another name", matching
// `./mods.js#rolledMods`'s existing fallback for the identical case. Handled
// in `rebuildCache`: when `item.uniqueId` is set but `item.uniqueValues` is
// missing or empty, it is filled with one `mods[i].min` per entry of the
// `UniqueDefinition`'s `mods` array — the safe direction, never a re-roll
// (no RNG is touched either way).

import { composeRareName } from './names.js';
import { RARE_TAIL } from './data/names.js';
import { ITEM_BASES_BY_ID } from './data/bases.js';
import { UNIQUES_BY_ID } from './data/uniques.js';
// ITEM-11's own write path for `_cache.weapon` (`./equipment.js#equip`'s
// call site), imported rather than duplicated — see this file's own header
// on the ITEM-11 gap, and `./equipment.js`'s export line for the round-2
// grant. Same-subsystem import (`items` -> `items`), not a cross-subsystem
// one — ARCHITECTURE.md hard rule 2 does not apply within one directory.
import { refreshWeaponCache } from './equipment.js';

const RARE_TAIL_COUNT = RARE_TAIL.length;

/**
 * `01-data-model.md` §5.3 (L888-891) plus `uniqueValues` (§5.3's own field
 * comment, L857-864). Every nested field is copied, never referenced, so
 * the result shares no array/object with the live `item` — safe to
 * `JSON.stringify` later without it mutating under a concurrent roll/equip.
 *
 * `grid`/`slot` — exactly one is non-null in the output (mirrors
 * `01-data-model.md` §5.3's own runtime comment: "location — exactly one of
 * these is non-null"). `ground` is dropped entirely: a ground item is never
 * part of a character/stash save — `./ground.js`'s own decay/eviction
 * policy is the source of truth for what is on the floor, not `save`. A
 * item that is neither equipped nor in any container (e.g. mid-drag, on the
 * cursor) serialises as `{ grid: null, slot: null }` — an explicit,
 * well-formed "nowhere" rather than a throw; returning it to its origin
 * container before a real save write is `src/save/`'s own job (the cursor
 * is exactly why `02-api-contracts.md:1000`'s `cursorItem` exists).
 *
 * @param {object} item - an `ItemInstance`.
 * @returns {object} a plain, JSON-safe `SavedItem`.
 */
export function serialiseItem(item) {
  const equipped = !!item.slot;
  const inContainer = !equipped && !!(item.grid && item.grid.container);

  return {
    uid: item.uid,
    baseId: item.baseId,
    rarity: item.rarity,
    ilvl: item.ilvl,
    identified: item.identified,
    quantity: item.quantity,
    rolls: {
      defense: item.rolls.defense,
      superior: item.rolls.superior,
      damageMin: item.rolls.damageMin,
      damageMax: item.rolls.damageMax,
    },
    affixes: item.affixes.map((a) => ({ id: a.id, kind: a.kind, values: a.values.slice() })),
    uniqueId: item.uniqueId,
    uniqueValues: item.uniqueValues.slice(),
    nameOverride: item.nameOverride
      ? { headIndex: item.nameOverride.headIndex, tailIndex: item.nameOverride.tailIndex }
      : null,
    durability: item.durability,
    maxDurability: item.maxDurability,
    sockets: item.sockets.slice(),
    socketCount: item.socketCount,
    grid: inContainer
      ? { container: item.grid.container, x: item.grid.x, y: item.grid.y }
      : null,
    slot: equipped ? item.slot : null,
  };
}

/**
 * `02-api-contracts.md:973`: `rebuildCache(item) => void` — "after load or
 * identify". Mutates `item` in place; every field `serialiseItem` wrote is
 * already in its final runtime shape (`grid`/`slot`/`sockets`/`rolls`/
 * `affixes` need no further construction), so this function's only job is
 * the fields `01-data-model.md` §5.3 marks "cached, never serialised":
 * `_cache` itself, plus `nameOverride`'s `en`/`ru`/`code` (ruling D-33) and
 * a pre-M9-save's missing `uniqueValues` (the min-fallback ruling above).
 *
 * Draws NOTHING from any `Rng` — no `Rng`/`CountingRng` is imported by this
 * module and no function called below takes one. A load must not desync
 * `tools/lootsim.mjs`; see this ticket's report for the instrumented proof.
 *
 * @param {object} item - an `ItemInstance` (or a freshly-parsed `SavedItem`
 *   about to become one via a direct field assignment `src/save/` performs).
 */
export function rebuildCache(item) {
  if (!item) return;

  if (!item._cache) {
    item._cache = { stats: null, displayName: null, sellValue: 0, iconCanvas: null, unusable: false };
  }

  // Ruling D-33 — recompose the two display strings (and `code`, for full
  // parity with `rollRareName`'s own shape, `./names.js`) from the stored
  // indices. Never a ring push/lookup: that would both consume a draw
  // and mutate shared module state on every load, neither of which this
  // function may do for an already-accepted name.
  if (item.nameOverride && typeof item.nameOverride.headIndex === 'number') {
    const { headIndex, tailIndex } = item.nameOverride;
    const { en, ru } = composeRareName(headIndex, tailIndex);
    item.nameOverride = { headIndex, tailIndex, code: headIndex * RARE_TAIL_COUNT + tailIndex, en, ru };
  }

  // An older save whose `uniqueValues` is absent, short, or empty defaults
  // the missing entries to the mods' MINIMUM — the safe direction, matching
  // `./mods.js#rolledMods`'s existing per-index fallback for the identical
  // case (`(uv && i < uv.length) ? uv[i] : m.min`) verbatim. Not a re-roll:
  // no `Rng` is touched.
  if (item.uniqueId) {
    const def = UNIQUES_BY_ID[item.uniqueId];
    if (def) {
      const uv = item.uniqueValues;
      const n = def.mods.length;
      if (!uv || uv.length < n) {
        const values = new Array(n);
        for (let i = 0; i < n; i++) values[i] = (uv && i < uv.length) ? uv[i] : def.mods[i].min;
        item.uniqueValues = values;
      }
    }
  }

  // ITEM-11's flagged gap (O-55): `_cache.weapon` for a save-loaded weapon
  // that gets equipped without going through `equip()` first. The SAME
  // function `./equipment.js#equip` calls at its own `mainHand` write site
  // — imported, not reproduced (see this file's header, and `./equipment.js`
  // itself for the guard: a no-op for a non-weapon or unresolved `baseId`).
  const base = ITEM_BASES_BY_ID[item.baseId];
  refreshWeaponCache(item, base);
}
