// src/items/mods.js
//
// ITEM-7 — `rolledMods`, `02-api-contracts.md:962`: the flat, per-affix
// structure `statsOf`'s merge (a later ticket, not built yet) destroys.
//
// ---------------------------------------------------------------------------
// Why this ticket, not a tooltip ticket, owns it — the orchestrator's grant
// ---------------------------------------------------------------------------
// No M3 backlog row lists `rolledMods`. The orchestrator assigned it here
// because `02:962` names a unique's `uniqueValues` as one of the three
// sources it must flatten (the others being `AffixInstance.values` and the
// item's own rolled numbers), and `uniqueValues` is this ticket's field. It
// lives in its own file, not `roll.js`, so the two do not collide (this
// ticket's brief, explicit).
//
// ---------------------------------------------------------------------------
// `Alloc = no` — the steady-state contract
// ---------------------------------------------------------------------------
// `rolledMods(item, out)` writes into the caller-supplied `out` array,
// reusing the entry objects already there (mutating their fields in place)
// and only pushing a fresh entry object when `out` does not yet have one at
// that index — the same "grow once, then reuse forever" shape a UI tooltip
// redraw needs, since a tooltip is redrawn every time the mouse moves over
// the item. `out.length` is never reset to 0 (that tears the backing store,
// `ARCHITECTURE.md`-adjacent perf rule, this ticket's brief) — the return
// value is the actual count, and the caller must not read past it.
//
// ---------------------------------------------------------------------------
// The three sources
// ---------------------------------------------------------------------------
// 'base'  — the item's own rolled, non-affix number(s). Only `rolls.defense`
//           qualifies today: it is the one field `01-data-model.md` §5.3
//           documents as "rolled ... in [armour.defMin, armour.defMax]" with
//           an unambiguous stat name, value and range. `rolls.superior` (a
//           5-15% roll) and `rolls.damageMin/damageMax` (copied verbatim
//           from the base, not itself a rolled range) are NOT emitted here —
//           which stat `rolls.superior` modifies, and how base weapon
//           damage should be presented alongside a unique's own flat
//           `minDamage`/`maxDamage` mods, is `03-combat-math.md` territory
//           this ticket's read range does not cover. Flagged in this
//           ticket's report rather than guessed.
// 'affix' — one entry per `AffixDefinition.mods[]` entry, for every
//           `AffixInstance` in `item.affixes`, in array order (`01` §5.2).
// 'unique' — one entry per `UniqueDefinition.mods[]` entry, in array order,
//           for a `uniqueId`'d item. `value` is `item.uniqueValues[i]` when
//           present, else the mod's own `min` — `04-items.md` §13.2's stated
//           safe default for an old save whose `uniqueValues` is absent or
//           shorter than `mods` (never read as a maximum roll).
//
// No `Map`/`Set` anywhere below (`ARCHITECTURE.md`-adjacent perf rule this
// ticket's brief restates): `AFFIXES_BY_ID`/`UNIQUES_BY_ID` are plain
// `Object.create(null)` lookup tables, built once at their own module's
// load time, not here.

import { ITEM_BASES_BY_ID } from './data/bases.js';
import { AFFIXES_BY_ID } from './data/affixes.js';
import { UNIQUES_BY_ID } from './data/uniques.js';

/**
 * Writes one flattened entry at `out[n]`, reusing the object already there
 * if `n < out.length`, otherwise pushing a fresh one (array growth — legal,
 * amortised; never happens again once `out` is warm for this call site's
 * typical entry count). Returns `n + 1`.
 * @param {Array} out
 * @param {number} n
 * @param {string} stat
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {'base'|'affix'|'unique'} source
 * @param {string|null} affixId
 * @param {string|null} kind
 * @returns {number}
 */
function writeEntry(out, n, stat, value, min, max, source, affixId, kind) {
  let e = out[n];
  if (!e) {
    e = { stat: null, value: 0, min: 0, max: 0, source: null, affixId: null, kind: null };
    out[n] = e;
  }
  e.stat = stat;
  e.value = value;
  e.min = min;
  e.max = max;
  e.source = source;
  e.affixId = affixId;
  e.kind = kind;
  return n + 1;
}

/**
 * `02-api-contracts.md:962`. Flattens `item`'s base roll(s), its
 * `AffixInstance`s and (for a unique) its `uniqueValues` into one ordered,
 * per-mod list written into `out`, reusing `out`'s existing entry objects.
 * Allocation-free once `out` is warm (see file header). Does not mutate
 * `out.length`; returns the number of entries actually written — the caller
 * must not read `out` past that index.
 *
 * @param {object} item - an `ItemInstance`.
 * @param {Array} out - reused entry buffer; grown (via `.push`) only when
 *   shorter than the count this call needs.
 * @returns {number} the count of entries written.
 */
export function rolledMods(item, out) {
  let n = 0;

  const base = ITEM_BASES_BY_ID[item.baseId];
  if (base && base.armour) {
    n = writeEntry(out, n, 'defense', item.rolls.defense, base.armour.defMin, base.armour.defMax, 'base', null, null);
  }

  const affixes = item.affixes;
  for (let i = 0; i < affixes.length; i++) {
    const inst = affixes[i];
    const def = AFFIXES_BY_ID[inst.id];
    if (!def) continue; // unknown affix id: skip rather than throw mid-tooltip
    const mods = def.mods;
    const values = inst.values;
    for (let j = 0; j < mods.length; j++) {
      n = writeEntry(out, n, mods[j].stat, values[j], mods[j].min, mods[j].max, 'affix', def.id, inst.kind);
    }
  }

  if (item.uniqueId) {
    const def = UNIQUES_BY_ID[item.uniqueId];
    if (def) {
      const mods = def.mods;
      const uv = item.uniqueValues;
      for (let i = 0; i < mods.length; i++) {
        const m = mods[i];
        // Safe default: absent/short uniqueValues (an old save) reads as
        // the mod's own minimum, never a maximum roll (04 §13.2).
        const value = (uv && i < uv.length) ? uv[i] : m.min;
        n = writeEntry(out, n, m.stat, value, m.min, m.max, 'unique', def.id, null);
      }
    }
  }

  return n;
}
