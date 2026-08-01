// src/items/icons/index.js
//
// ITEM-15 — the one import path `src/items/index.js` uses to reach this
// directory: the 192-entry LRU (`./cache.js`) plus the cached, `ItemInstance
// -> OffscreenCanvas` orchestration (`iconFor`) that `02-api-contracts.md`
// §11's `icon` row contracts (`(item:ItemInstance) => OffscreenCanvas`,
// `Fixed: N`, `Alloc: yes (first call)`). `./generate.js` is also
// re-exported directly — `tools/iconbench.mjs`'s percentile pass needs the
// NON-cached generator (see that file's own header for why: measuring
// "generation cost" against a cache that would serve every repeat call from
// memory in <1 µs is not measuring what the 1.2 ms budget is about).

import { createIconCache, cacheGet, cachePut, keyFor } from './cache.js';
import { generateIconCanvas, canGenerateIcons } from './generate.js';

export { createIconCache, generateIconCanvas, canGenerateIcons, keyFor };

/**
 * The cached lookup `ItemsSystem#icon` forwards to.
 *
 * @param {object} state - from `createIconCache()`.
 * @param {{ baseId:string, rarity?:string, socketCount?:number, rolls?:{superior?:number}, identified?:boolean, durability?:number, maxDurability?:number }} item
 * @param {object} base - the resolved `ItemBase` (`ITEM_BASES_BY_ID[item.baseId]`)
 *   — the caller resolves this (it already has `ITEM_BASES_BY_ID` imported;
 *   see `../index.js`), so this module never needs its own second lookup
 *   table on top of `./cache.js`'s own `BASE_INDEX`.
 * @returns {object|null} an `OffscreenCanvas`, or `null` for an unresolved
 *   base / no realm `OffscreenCanvas` / an unrecognised recipe — never a
 *   throw (test-form rule).
 */
export function iconFor(state, item, base) {
  if (!state || !item || !base) return null;
  const rarity = item.rarity || 'normal';
  const socketCount = item.socketCount || 0;
  // `09-ui.md` §7.1's cache-key `superior` flag: read off `rolls.superior`
  // (`01-data-model.md` §5.3: "rolled ... 5..15, only when rarity ===
  // 'superior'"), not re-derived from `rarity === 'superior'` — the two are
  // equivalent for every real rolled item today, but `rolls.superior` is the
  // field the data model actually names for this, so that is the one read
  // here. See this ticket's report for the ambiguity this resolves.
  const superior = !!(item.rolls && item.rolls.superior > 0);

  const key = keyFor(item.baseId, rarity, socketCount, superior);
  const cached = cacheGet(state, key);
  if (cached) return cached;

  const canvas = generateIconCanvas(base, {
    rarity,
    socketCount,
    superior,
    identified: item.identified !== false,
    durability: item.durability,
    maxDurability: item.maxDurability,
  });
  if (canvas && key >= 0) cachePut(state, key, canvas);
  return canvas;
}
