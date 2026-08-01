// src/items/economy.js
//
// ITEM-14 — Economy: value, repair (`04-items.md` §7.2 item value, §7.3
// buying/selling and the 4x spread, §7.4 durability/repair). Ruling D-28:
// the ticket is split across two files — this one is pure item-value/repair
// arithmetic with no RNG and no vendor-panel state; `./vendor.js` owns
// vendor stock and buyback.
//
// ---------------------------------------------------------------------------
// Ruling C-7 — `base.baseValue` is the authored integer, never the formula
// ---------------------------------------------------------------------------
// `04` §14.2 C-7: `01-data-model.md` §5.1's authored `baseValue` integers
// always win; `Math.round(k * reqLevel ** 1.9)` is documentation of how the
// table was generated, never something the runtime evaluates. ITEM-1's own
// header on `./data/bases.js` records eighteen one-to-five-gold
// disagreements between the two (`axe_battle_normal` 220 vs 221 is the one
// C-7 names). Every formula below reads `base.baseValue` off
// `ITEM_BASES_BY_ID` — the frozen, already-accepted table — and never
// computes a `reqLevel`-driven value anywhere. This is why this file's
// §7.3 worked-table reproduction matches the spec's table exactly, gold for
// gold, rather than being "off by one or two" the way a formula-evaluating
// implementation would be (see this ticket's report for the full row-by-row
// proof).
//
// ---------------------------------------------------------------------------
// RARITY_VALUE — flagged: belongs in data/, not granted to this ticket
// ---------------------------------------------------------------------------
// `04` §7.2's rarity-value table is a gameplay number
// (`ARCHITECTURE.md` rule 9: "gameplay numbers live in data, not code").
// This ticket's file grant has no `src/items/data/` entry to give it a real
// home — the same situation `./quality.js` (`QUALITY_BASE` etc.),
// `./containers.js` (`SLOT_ORDER`/`RARITY_ORDER`), `./ground.js` (the three
// timing constants) and `./state.js` (the four durability-loss rates) each
// hit and resolved identically: a frozen constant local to the owning
// module, flagged as a deviation in the report rather than silently
// worked around.
//
// ---------------------------------------------------------------------------
// What this file deliberately does NOT build
// ---------------------------------------------------------------------------
// `vendorBuy`/`vendorSell`/`repair` (the single-item form)/`damageDurability`/
// `addGold`/`spendGold`/`goldCap`/`stashGold` are all real
// `02-api-contracts.md` §11 rows, but none of them was named in this
// ticket's brief as a row to build, and several depend on machinery this
// ticket's file grant does not reach (a real `spendGold` needs `goldCap`'s
// cap-aware add/refuse semantics; `vendorBuy`/`vendorSell` need the
// container moves `./vendor.js` does not own either). `repairAll` below
// spends gold directly by reading/writing `actor.gold` — a plain field on
// the actor record (`01-data-model.md` §2, `gold: 0, // int`) — the same
// "write a field directly onto the object we were handed, never import the
// owning subsystem's module" precedent `./state.js`'s own header already
// sets for `actor._durHit`/`actor._durGen` (ARCHITECTURE.md rule 2 forbids
// importing another subsystem's *module*, not reading/writing a field on an
// object reference already in hand).
//
// `damageDurability` — NOT needed here. `./state.js`'s own header records
// that ITEM-13 built durability *loss* as a private `applyLoss` helper
// rather than the contracted `damageDurability(item, amount) => boolean`
// row, and this ticket's brief explicitly says "do not duplicate that
// logic ... do not reach into state.js." Repair is the LOSS operation's
// inverse, not a caller of it — restoring durability needs none of
// `applyLoss`'s clamp-at-0/mark-unusable/emit-once bookkeeping, only its
// mirror image (raise to max, clear `unusable`, mark dirty on the 0->full
// crossing) — so this file does not import `./state.js` at all and never
// needed `damageDurability` exposed. See this ticket's report.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import { ITEM_BASES_BY_ID } from './data/bases.js';

/** `04` §7.2's rarity multiplier table — see the file header for why this
 * is a local frozen constant rather than a `data/` table. */
export const RARITY_VALUE = Object.freeze({
  normal: 1.00,
  superior: 1.35,
  magic: 2.20,
  rare: 3.60,
  unique: 6.00,
});

/** `01-data-model.md` §1.5's `SLOT_ORDER`, verbatim — local, not imported.
 * Same duplication precedent `./state.js`/`./equipment.js`/
 * `./containers.js` already each set for this exact table (no file in the
 * tree exports it, and this ticket's grant has no `data/` file to give it a
 * shared home either). */
const SLOT_ORDER = Object.freeze([
  'head', 'chest', 'hands', 'legs', 'mainHand', 'offHand',
  'belt', 'amulet', 'ring1', 'ring2',
]);

function rarityValueOf(rarity) {
  const v = RARITY_VALUE[rarity];
  return v === undefined ? RARITY_VALUE.normal : v;
}

/**
 * `02-api-contracts.md` §11: `itemValue(item) => int`. `04` §7.2, verbatim:
 *
 *   itemValue(item) = max(1, floor(
 *         base.baseValue
 *       × RARITY_VALUE[item.rarity]
 *       × (1 + 0.16 × item.affixes.length)
 *       × durabilityFactor(item)
 *       × superiorFactor(item) ))
 *
 * An unidentified rare or unique is valued as if it were magic with no
 * affixes ("the vendor cannot see what he is not shown", §7.2's own text) —
 * `magic` itself is NOT special-cased when unidentified, matching the
 * spec's literal wording ("An unidentified rare or unique..."), only rare
 * and unique.
 * @param {object} item - an `ItemInstance`.
 * @returns {number}
 */
export function itemValue(item) {
  if (!item) return 1;
  const base = ITEM_BASES_BY_ID[item.baseId];
  const baseValue = base ? base.baseValue : 0; // C-7: read off the record, never computed
  const rarity = item.rarity;
  const hidden = !item.identified && (rarity === 'rare' || rarity === 'unique');
  const rv = hidden ? RARITY_VALUE.magic : rarityValueOf(rarity);
  const affixCount = hidden ? 0 : (item.affixes ? item.affixes.length : 0);
  const durFactor = !item.maxDurability
    ? 1.0
    : 0.35 + 0.65 * (item.durability / item.maxDurability);
  const superiorFactor = (!hidden && rarity === 'superior')
    ? 1 + ((item.rolls && item.rolls.superior) || 0) / 100
    : 1.0;
  const raw = baseValue * rv * (1 + 0.16 * affixCount) * durFactor * superiorFactor;
  return Math.max(1, Math.floor(raw));
}

/** `02-api-contracts.md` §11: `sellValue(item) => int`. `04` §7.3:
 * `playerReceives(item) = max(1, min(25000, floor(itemValue(item) × 0.25)))`
 * — the 4x spread's sell half, capped so a lucky unique cannot fund the
 * rest of the difficulty. */
export function sellValue(item) {
  return Math.max(1, Math.min(25000, Math.floor(itemValue(item) * 0.25)));
}

/** `02-api-contracts.md` §11: `buyValue(item) => int`. `04` §7.3:
 * `playerPays(item) = max(1, itemValue(item))` — the 4x spread's buy half.
 * `itemValue` already floors at 1, so the outer `max(1, ...)` is a no-op in
 * practice; kept to mirror the spec formula verbatim rather than relying on
 * that fact silently. */
export function buyValue(item) {
  return Math.max(1, itemValue(item));
}

/**
 * `02-api-contracts.md` §11: `repairCost(item) => int`. `04` §7.4:
 *
 *   repairCost(item) = max(1, ceil(
 *         0.30 × base.baseValue × RARITY_VALUE[item.rarity]
 *              × (1 − durability / maxDurability) ))
 *
 * Two cases the formula's literal text does not cover, both judgment calls
 * flagged in this ticket's report:
 *   - `maxDurability === 0` (indestructible — jewelry, quest, consumables,
 *     `04` §7.4's own "exempt from all of the above" line) — 0, not
 *     `max(1, ...)`, since there is nothing to repair and no durability to
 *     divide by.
 *   - `durability === maxDurability` (already at full) — 0. The bare
 *     formula's `(1 − d/max)` term is 0 here too, but `max(1, ceil(0))` = 1
 *     read literally, i.e. a nominal 1-gold charge to "repair" a pristine
 *     item. The `max(1, ...)` floor exists to keep a *damaged* item's cost
 *     from rounding down to 0 (a 1%-damaged item should still cost
 *     something), not to charge for repairing nothing — so this function
 *     special-cases "nothing to repair" to 0 before that floor applies.
 * @param {object} item - an `ItemInstance`.
 * @returns {number}
 */
export function repairCost(item) {
  if (!item) return 0;
  if (!item.maxDurability || item.maxDurability <= 0) return 0; // indestructible
  if (item.durability >= item.maxDurability) return 0; // already full — see doc above
  const base = ITEM_BASES_BY_ID[item.baseId];
  const baseValue = base ? base.baseValue : 0; // C-7: read off the record, never computed
  const rv = rarityValueOf(item.rarity);
  const raw = 0.30 * baseValue * rv * (1 - item.durability / item.maxDurability);
  return Math.max(1, Math.ceil(raw));
}

/** Walks `actor.equipment` (by `SLOT_ORDER`), `actor.inventory.list` and
 * `actor.belt.slots`, summing `repairCost` — `04` §7.4's own "Σ repairCost
 * over equipment + inventory + belt" (stash is NOT included, matching that
 * formula's literal three terms). `repairAll` below inlines the identical
 * three-container walk itself rather than calling this with a callback:
 * `repairAllCost`/`repairAll` are both contracted `Alloc: no`
 * (`02-api-contracts.md` §11), and an arrow function passed as a callback
 * argument is itself a fresh allocation on every call.
 * @param {object} actor
 * @returns {number}
 */
function forEachRepairableCost(actor) {
  let total = 0;
  if (!actor) return total;
  const equip = actor.equipment;
  if (equip) {
    for (let i = 0; i < SLOT_ORDER.length; i++) {
      const it = equip[SLOT_ORDER[i]];
      if (it) total += repairCost(it);
    }
  }
  const inv = actor.inventory;
  if (inv && inv.list) {
    const list = inv.list;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it) total += repairCost(it);
    }
  }
  const belt = actor.belt;
  if (belt && belt.slots) {
    const slots = belt.slots;
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i];
      if (it) total += repairCost(it);
    }
  }
  return total;
}

/** `02-api-contracts.md` §11: `repairAllCost(actor) => int`. `04` §7.4:
 * `repairAllCost(actor) = Σ repairCost over equipment + inventory + belt`.
 * `0` for a missing actor or an actor with nothing damaged — never a throw.
 * @param {object} actor
 * @returns {number}
 */
export function repairAllCost(actor) {
  return forEachRepairableCost(actor);
}

/** Resolves `ctx.get('actors')` defensively — `null` when unavailable or
 * when it does not actually expose `markDirty`. Same guarded-resolution
 * shape `./state.js#getActors`/`./equipment.js#getActors` already use for
 * the identical problem (duplicated, not imported — `./state.js` is
 * explicitly out of this ticket's grant, see file header). */
function getActors(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  let actors;
  try {
    actors = ctx.get('actors');
  } catch {
    return null;
  }
  if (!actors || typeof actors.markDirty !== 'function') return null;
  return actors;
}

/** Lazily attaches `_cache` in the `01-data-model.md` §5.3 shape — mirrors
 * `./state.js#ensureCache`'s own precedent (duplicated, not imported, same
 * reason as `getActors` above). */
function ensureCache(item) {
  if (!item._cache) item._cache = { stats: null, displayName: null, sellValue: 0, iconCanvas: null, unusable: false };
  return item._cache;
}

/**
 * `02-api-contracts.md` §11: `repairAll(actor) => int` — gold spent.
 *
 * Atomic, by judgment call (flagged in this ticket's report): `04`'s read
 * range says nothing about what happens when `actor.gold` is short of
 * `repairAllCost(actor)`, but `02-api-contracts.md` §11 already documents
 * `spendGold(actor, amount) => boolean` as "atomic" for the identical
 * problem (paying for something in this economy) — `repairAll` mirrors
 * that: either `actor.gold` covers the full cost and every repairable item
 * is restored to full durability in one call, or nothing happens at all
 * and `0` is returned (an explicit refusal, never a throw, never a partial
 * repair).
 *
 * `stats:dirty` is emitted at most once per call, only when at least one
 * repaired item had crossed to `durability === 0` (mirroring
 * `./state.js#applyLoss`'s "exactly on the crossing call" rule for the loss
 * direction) — an item that was merely scuffed, never unusable, changes no
 * equipped stat contribution by being topped up.
 *
 * @param {object} state - `createEconomyState`'s return value.
 * @param {object} actor
 * @returns {number} gold spent (0 on refusal or when there is nothing to
 *   repair).
 */
export function repairAll(state, actor) {
  const cost = forEachRepairableCost(actor);
  if (cost <= 0) return 0;
  if (!actor || !(actor.gold >= cost)) return 0; // insufficient funds — explicit refusal

  actor.gold -= cost;

  let crossedZero = false;

  const equip = actor.equipment;
  if (equip) {
    for (let i = 0; i < SLOT_ORDER.length; i++) {
      const it = equip[SLOT_ORDER[i]];
      if (it && it.maxDurability > 0 && it.durability < it.maxDurability) {
        if (it.durability <= 0) crossedZero = true;
        it.durability = it.maxDurability;
        const cache = ensureCache(it);
        if (cache.unusable) cache.unusable = false;
      }
    }
  }
  const inv = actor.inventory;
  if (inv && inv.list) {
    const list = inv.list;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it && it.maxDurability > 0 && it.durability < it.maxDurability) {
        it.durability = it.maxDurability;
        const cache = ensureCache(it);
        if (cache.unusable) cache.unusable = false;
      }
    }
  }
  const belt = actor.belt;
  if (belt && belt.slots) {
    const slots = belt.slots;
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i];
      if (it && it.maxDurability > 0 && it.durability < it.maxDurability) {
        it.durability = it.maxDurability;
        const cache = ensureCache(it);
        if (cache.unusable) cache.unusable = false;
      }
    }
  }

  if (crossedZero) {
    const actors = getActors(state && state.ctx);
    if (actors) actors.markDirty(actor);
  }

  return cost;
}

/** Builds the economy state bag — `{ ctx }` only; `repairAll`'s
 * `stats:dirty` emit is the one operation here that needs `ctx` at all.
 * Same "index.js forwards, a sibling file owns a small state bag" shape
 * every other `ITEM-*` file in this directory already uses.
 * @param {object} ctx
 * @returns {object}
 */
export function createEconomyState(ctx) {
  return { ctx };
}
