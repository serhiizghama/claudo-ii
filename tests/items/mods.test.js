// tests/items/mods.test.js
//
// ITEM-7 acceptance tests for src/items/mods.js — `rolledMods`
// (02-api-contracts.md:962). `node:test` + `node:assert/strict` only.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, acceptance clause 6 +
// the rolledMods grant):
//   - rolledMods returns the flat per-affix structure for a magic item, a
//     rare item and a unique item.
//   - A unique's uniqueValues flatten in array order, `min`/`max` carried
//     alongside, `value` defaulting to the mod's own `min` when
//     `uniqueValues` is absent or shorter than `mods` (04 §13.2's stated
//     safe default for an old save).
//   - The `out` buffer contract: entries reused by reference across calls
//     (no per-call allocation of the entry objects themselves — the actual
//     byte-level allocation-free proof is tests/items/mods.perf.test.js,
//     named `.perf.test.js` per this project's perf/unit split), `out`
//     never truncated (`.length = 0` is never done), and the returned count
//     is what the caller must respect.
//
// NOT tested here: statsOf (a later ticket, does not exist), the item icon/
// tooltip rendering that will eventually call this (ui, later ticket).

import test from 'node:test';
import assert from 'node:assert/strict';

import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { AFFIXES_BY_ID } from '../../src/items/data/affixes.js';
import { UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
import { rolledMods } from '../../src/items/mods.js';

test('ITMS.M00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof rolledMods, 'function');
});

// ---------------------------------------------------------------------------
// Minimal ItemInstance builders — only the fields rolledMods reads
// (baseId, rolls.defense, affixes, uniqueId, uniqueValues), matching the
// `01-data-model.md` §5.3 field list; the rest of a real ItemInstance is
// irrelevant to this function and deliberately omitted.
// ---------------------------------------------------------------------------

function magicItem() {
  // pfx_enhanced_damage_3 (single mod) + sfx_attack_rating_2 (single mod),
  // real AFFIXES entries — 01 §5.2's own worked example pairing.
  return {
    baseId: 'axe_battle_normal',
    rarity: 'magic',
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [
      { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [40] },
      { id: 'sfx_attack_rating_2', kind: 'suffix', values: [15] },
    ],
    uniqueId: null,
    uniqueValues: [],
  };
}

function rareArmourItem() {
  // helm_coif_normal (has .armour) + one sharedRoll suffix (sfx_res_all_1,
  // 4 mods from ONE rolled value) + one single-mod prefix.
  return {
    baseId: 'helm_coif_normal',
    rarity: 'rare',
    rolls: { defense: 15, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [
      { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [45] },
      { id: 'sfx_res_all_1', kind: 'suffix', values: [7, 7, 7, 7, 7, 7] },
    ],
    uniqueId: null,
    uniqueValues: [],
  };
}

function uniqueItem(uniqueValues) {
  return {
    baseId: 'helm_coif_normal', // ashen_crown's own base
    rarity: 'unique',
    rolls: { defense: 12, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: 'ashen_crown',
    uniqueValues,
  };
}

// ---------------------------------------------------------------------------
// 1. Magic item — one entry per affix mod, in item.affixes order.
// ---------------------------------------------------------------------------

test('ITMS.M01 rolledMods flattens a magic item: one entry per affix mod, values/min/max/source/affixId/kind correct', () => {
  const item = magicItem();
  const out = [];
  const n = rolledMods(item, out);
  assert.equal(n, 2, 'no base-source entry — axe_battle_normal has no .armour');
  assert.equal(out[0].stat, 'enhancedDamage');
  assert.equal(out[0].value, 40);
  assert.equal(out[0].min, 30);
  assert.equal(out[0].max, 50);
  assert.equal(out[0].source, 'affix');
  assert.equal(out[0].affixId, 'pfx_enhanced_damage_3');
  assert.equal(out[0].kind, 'prefix');

  assert.equal(out[1].stat, 'attackRating');
  assert.equal(out[1].value, 15);
  assert.equal(out[1].min, 12);
  assert.equal(out[1].max, 30);
  assert.equal(out[1].source, 'affix');
  assert.equal(out[1].affixId, 'sfx_attack_rating_2');
  assert.equal(out[1].kind, 'suffix');
});

// ---------------------------------------------------------------------------
// 2. Rare item — a sharedRoll affix (4 mods, 1 rolled value already
//    replicated by rollAffixInstance) flattens into 4 separate entries, each
//    carrying the same value — this is the precondition the contract row
//    names as "the all-resistances merge".
// ---------------------------------------------------------------------------

test('ITMS.M02 rolledMods flattens a rare armour item: a base defense entry, then one entry per affix mod including a sharedRoll affix\'s 6 equal-value entries', () => {
  const item = rareArmourItem();
  const out = [];
  const n = rolledMods(item, out);
  // 1 base (defense) + 1 (enhanced damage) + 6 (all-resist, sharedRoll) = 8
  assert.equal(n, 8);

  assert.equal(out[0].source, 'base');
  assert.equal(out[0].stat, 'defense');
  assert.equal(out[0].value, 15);
  assert.equal(out[0].min, ITEM_BASES_BY_ID.helm_coif_normal.armour.defMin);
  assert.equal(out[0].max, ITEM_BASES_BY_ID.helm_coif_normal.armour.defMax);
  assert.equal(out[0].affixId, null);
  assert.equal(out[0].kind, null);

  assert.equal(out[1].source, 'affix');
  assert.equal(out[1].stat, 'enhancedDamage');
  assert.equal(out[1].value, 45);
  assert.equal(out[1].affixId, 'pfx_enhanced_damage_3');
  assert.equal(out[1].kind, 'prefix');

  const resistStats = ['fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist'];
  for (let i = 0; i < 6; i++) {
    const e = out[2 + i];
    assert.equal(e.source, 'affix');
    assert.equal(e.stat, resistStats[i]);
    assert.equal(e.value, 7, 'the ONE sharedRoll draw must be replicated across every entry');
    assert.equal(e.min, 4);
    assert.equal(e.max, 9);
    assert.equal(e.affixId, 'sfx_res_all_1');
    assert.equal(e.kind, 'suffix');
  }
});

// ---------------------------------------------------------------------------
// 3. Unique item — array-order flattening of uniqueValues, plus the
//    absent/short safe-default (04 §13.2).
// ---------------------------------------------------------------------------

test('ITMS.M03 rolledMods flattens a unique item: one entry per UniqueDefinition mod, array order, source "unique"', () => {
  const def = UNIQUES_BY_ID.ashen_crown;
  const values = def.mods.map((m, i) => m.min + i); // distinct, in-range values per mod
  const item = uniqueItem(values);
  const out = [];
  const n = rolledMods(item, out);
  // 1 base (defense, helm_coif_normal has .armour) + 5 unique mods = 6
  assert.equal(n, 6);
  assert.equal(out[0].source, 'base');
  for (let i = 0; i < def.mods.length; i++) {
    const e = out[1 + i];
    assert.equal(e.source, 'unique');
    assert.equal(e.stat, def.mods[i].stat, `entry ${i} stat`);
    assert.equal(e.value, values[i], `entry ${i} value must come from uniqueValues, in array order`);
    assert.equal(e.min, def.mods[i].min);
    assert.equal(e.max, def.mods[i].max);
    assert.equal(e.affixId, 'ashen_crown');
    assert.equal(e.kind, null);
  }
});

test('ITMS.M04 rolledMods: an absent uniqueValues defaults every entry to the mod\'s own min (04 §13.2, the safe direction — never a maximum roll)', () => {
  const def = UNIQUES_BY_ID.ashen_crown;
  const item = uniqueItem([]); // absent-equivalent: an old save's default
  const out = [];
  rolledMods(item, out);
  for (let i = 0; i < def.mods.length; i++) {
    assert.equal(out[1 + i].value, def.mods[i].min, `entry ${i} must default to min, never a higher roll`);
  }
});

test('ITMS.M05 rolledMods: a SHORT uniqueValues (fewer entries than mods) defaults only the missing tail to min', () => {
  const def = UNIQUES_BY_ID.ashen_crown; // 5 mods
  const partial = [def.mods[0].min + 1, def.mods[1].min + 1]; // first 2 provided
  const item = uniqueItem(partial);
  const out = [];
  rolledMods(item, out);
  assert.equal(out[1].value, partial[0]);
  assert.equal(out[2].value, partial[1]);
  assert.equal(out[3].value, def.mods[2].min, 'missing tail entry 2 must default to min');
  assert.equal(out[4].value, def.mods[3].min, 'missing tail entry 3 must default to min');
  assert.equal(out[5].value, def.mods[4].min, 'missing tail entry 4 must default to min');
});

// ---------------------------------------------------------------------------
// 4. The `out` buffer contract — reuse by reference, grow-only, never
//    truncated, return value is authoritative over `out.length`.
// ---------------------------------------------------------------------------

test('ITMS.M06 rolledMods reuses out\'s existing entry objects by reference across calls (no new object identity on a warm buffer)', () => {
  const out = [];
  rolledMods(magicItem(), out); // warms out to length 2
  const ref0 = out[0];
  const ref1 = out[1];
  assert.equal(out.length, 2);

  rolledMods(magicItem(), out); // same shape again — must reuse, not replace
  assert.equal(out[0], ref0, 'entry object at index 0 must be the SAME reference, mutated in place');
  assert.equal(out[1], ref1, 'entry object at index 1 must be the SAME reference, mutated in place');
  assert.equal(out.length, 2, 'no growth on a call needing the same count');
});

test('ITMS.M07 rolledMods grows out only when it is shorter than the count this call needs, and never truncates it on a smaller call', () => {
  const out = [];
  const n1 = rolledMods(rareArmourItem(), out); // needs 8
  assert.equal(n1, 8);
  assert.equal(out.length, 8);
  const ref3 = out[3];

  const n2 = rolledMods(magicItem(), out); // needs only 2
  assert.equal(n2, 2, 'return value reflects the ACTUAL count for this call');
  assert.equal(out.length, 8, 'out.length must NOT be truncated back down — tearing the backing store is forbidden');
  assert.equal(out[3], ref3, 'entries past the returned count are stale leftovers, untouched, same reference as before');

  const n3 = rolledMods(rareArmourItem(), out); // needs 8 again — must reuse, not grow further
  assert.equal(n3, 8);
  assert.equal(out.length, 8, 'no further growth once already warm at the required size');
});

test('ITMS.M08 rolledMods on a fresh empty out grows it exactly to the entry count needed, via push (amortised growth, not a per-call reallocation)', () => {
  const out = [];
  const n = rolledMods(uniqueItem(UNIQUES_BY_ID.ashen_crown.mods.map((m) => m.min)), out);
  assert.equal(n, 6);
  assert.equal(out.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(typeof out[i], 'object');
    assert.notEqual(out[i], null);
  }
});

// ---------------------------------------------------------------------------
// 5. An item with neither armour nor affixes nor a unique id — zero entries,
//    not an error.
// ---------------------------------------------------------------------------

test('ITMS.M09 rolledMods returns 0 for a plain normal weapon (no armour, no affixes, no unique)', () => {
  const item = {
    baseId: 'axe_battle_normal',
    rarity: 'normal',
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [],
    uniqueId: null,
    uniqueValues: [],
  };
  const out = [{ stat: 'stale', value: 1, min: 0, max: 0, source: 'affix', affixId: 'x', kind: 'prefix' }];
  const n = rolledMods(item, out);
  assert.equal(n, 0);
  assert.equal(out.length, 1, 'out is not truncated — the stale entry at index 0 is left as-is, past the returned count');
});

// ---------------------------------------------------------------------------
// 6. Defensive: an unknown affixId or uniqueId does not throw mid-tooltip.
// ---------------------------------------------------------------------------

test('ITMS.M10 rolledMods skips an unresolvable affixId/uniqueId rather than throwing', () => {
  const item = {
    baseId: 'axe_battle_normal',
    rarity: 'magic',
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [{ id: 'not_a_real_affix', kind: 'prefix', values: [1] }],
    uniqueId: 'not_a_real_unique',
    uniqueValues: [],
  };
  const out = [];
  let n;
  assert.doesNotThrow(() => { n = rolledMods(item, out); });
  assert.equal(n, 0);
});

test('ITMS.M11 sanity: every affixId used above resolves against the real AFFIXES_BY_ID table', () => {
  assert.ok(AFFIXES_BY_ID.pfx_enhanced_damage_3);
  assert.ok(AFFIXES_BY_ID.sfx_attack_rating_2);
  assert.ok(AFFIXES_BY_ID.sfx_res_all_1);
  assert.equal(AFFIXES_BY_ID.sfx_res_all_1.sharedRoll, true);
});
