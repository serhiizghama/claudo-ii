// tests/items/bases.test.js
//
// ITEM-1 acceptance tests for src/items/data/bases.js. `node:test` +
// `node:assert/strict` only, matching every sibling test file in this repo
// (e.g. tests/ai/bestiary.test.js, tests/combat/examples.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, acceptance points 2-7):
//   2. Exactly 75 ItemBase records, with the documented 26/29/6+1/1/12 split.
//   3. Every `id` unique. Every `iconSeed` unique.
//   4. `invW in 1..2`, `invH in 1..4`, `reqLevel <= 30` on every record.
//   5. Every `surface` is one of ARCHITECTURE.md's SURFACE vocabulary.
//   6. Every `allowedAffixGroups` entry is in the 04 §1.2 vocabulary.
//   7. The seven `03-combat-math.md` §4.6 reference weapons match exactly.
//
// NOT tested here (owned by later M3 tickets, none of it exists in
// bases.js by design — see that file's own header): affix rolling, treasure
// classes, uniques, rare naming, containers/equipment, icons, economy. Rule
// O-27: this file asserts ITEM-1's own contract only, never "items has no
// rollDrop yet" or similar.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ITEM_BASES, ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';

// ARCHITECTURE.md "Surface types" — the shared vocabulary, verbatim.
const SURFACE_VALUES = new Set([
  'stone', 'dirt', 'grass', 'sand', 'ash', 'wood', 'metal', 'water', 'bone',
  'flesh', 'blood', 'crystal',
]);

// 04-items.md §1.2 — the fifteen `allowedAffixGroups` / `requiresGroups`
// applicability strings, verbatim.
const AFFIX_GROUP_VALUES = new Set([
  'universal',
  'weapon.any', 'weapon.melee', 'weapon.caster', 'weapon.twohand',
  'armour.any', 'armour.body', 'armour.helm', 'armour.gloves', 'armour.boots',
  'armour.belt', 'armour.shield',
  'jewelry.any', 'jewelry.ring', 'jewelry.amulet',
]);

// 03-combat-math.md §4.6, verbatim — the seven reference weapons every
// calibration figure in that document's §11 depends on. Reproduced here as
// the independent cross-check this ticket's criterion 7 asks for (NOT
// derived from src/combat/data/weapons.js — ARCHITECTURE.md rule 2 forbids
// importing a sibling subsystem's module, and a copy-paste-and-compare
// against the same source both were transcribed from is the actual test).
const REFERENCE_WEAPONS = [
  { id: 'unarmed', minDamage: 1, maxDamage: 3, attackTime: 0.60, attackRating: 0, reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1 },
  { id: 'axe_hand_normal', minDamage: 4, maxDamage: 9, attackTime: 0.80, attackRating: 40, reqLevel: 1, reqStr: 18, reqDex: 0, invW: 1, invH: 3 },
  { id: 'axe_battle_normal', minDamage: 10, maxDamage: 22, attackTime: 0.75, attackRating: 80, reqLevel: 9, reqStr: 40, reqDex: 0, invW: 2, invH: 3 },
  { id: 'sword_rune_normal', minDamage: 8, maxDamage: 17, attackTime: 0.65, attackRating: 80, reqLevel: 8, reqStr: 30, reqDex: 25, invW: 1, invH: 3 },
  { id: 'maul_great_normal', minDamage: 22, maxDamage: 46, attackTime: 1.25, attackRating: 60, reqLevel: 12, reqStr: 62, reqDex: 0, invW: 2, invH: 4 },
  { id: 'wand_ember_normal', minDamage: 3, maxDamage: 7, attackTime: 0.60, attackRating: 10, reqLevel: 1, reqStr: 12, reqDex: 0, invW: 1, invH: 2 },
  { id: 'staff_ash_normal', minDamage: 6, maxDamage: 14, attackTime: 0.95, attackRating: 20, reqLevel: 10, reqStr: 20, reqDex: 0, invW: 1, invH: 4 },
];
// `unarmed`'s invW/invH is a placeholder (it has no authored grid, "—" in
// 04 §1.4 — see bases.js's own header); not part of this cross-check.

test('ITMS.B00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.ok(Array.isArray(ITEM_BASES));
});

test('ITMS.B01 exactly 75 ItemBase records, with the documented category split', () => {
  assert.equal(ITEM_BASES.length, 75);

  const byCategory = { weapon: 0, armour: 0, jewelry: 0, quest: 0, consumable: 0 };
  for (const base of ITEM_BASES) {
    assert.ok(base.category in byCategory, `unexpected category '${base.category}' on '${base.id}'`);
    byCategory[base.category]++;
  }
  // 26 named weapons + unarmed = 27; 29 armour; 6 jewelry; 1 quest; 12 consumables.
  assert.equal(byCategory.weapon, 27, 'weapon count (26 named + unarmed)');
  assert.equal(byCategory.armour, 29, 'armour count');
  assert.equal(byCategory.jewelry, 6, 'jewelry count');
  assert.equal(byCategory.quest, 1, 'quest count');
  assert.equal(byCategory.consumable, 12, 'consumable count');
  assert.equal(
    byCategory.weapon + byCategory.armour + byCategory.jewelry + byCategory.quest + byCategory.consumable,
    75,
  );
});

test('ITMS.B02 every id is unique', () => {
  const ids = ITEM_BASES.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  // ITEM_BASES_BY_ID must resolve every one of them back to its own record.
  for (const base of ITEM_BASES) {
    assert.equal(ITEM_BASES_BY_ID[base.id], base);
  }
});

test('ITMS.B03 every iconSeed is unique', () => {
  const seeds = ITEM_BASES.map((b) => b.iconSeed);
  for (const seed of seeds) {
    assert.equal(typeof seed, 'number');
  }
  assert.equal(new Set(seeds).size, seeds.length);
});

test('ITMS.B04 invW in 1..2, invH in 1..4, reqLevel <= 30 on every record', () => {
  for (const base of ITEM_BASES) {
    assert.ok(Number.isInteger(base.invW) && base.invW >= 1 && base.invW <= 2, `${base.id}.invW=${base.invW}`);
    assert.ok(Number.isInteger(base.invH) && base.invH >= 1 && base.invH <= 4, `${base.id}.invH=${base.invH}`);
    assert.ok(Number.isInteger(base.reqLevel) && base.reqLevel >= 1 && base.reqLevel <= 30, `${base.id}.reqLevel=${base.reqLevel}`);
  }
});

test('ITMS.B05 every surface is in the ARCHITECTURE.md SURFACE vocabulary', () => {
  for (const base of ITEM_BASES) {
    assert.ok(SURFACE_VALUES.has(base.surface), `${base.id}.surface='${base.surface}' not in SURFACE`);
  }
});

test('ITMS.B06 every allowedAffixGroups entry is in the 04 §1.2 vocabulary', () => {
  for (const base of ITEM_BASES) {
    assert.ok(Array.isArray(base.allowedAffixGroups), `${base.id}.allowedAffixGroups is not an array`);
    for (const group of base.allowedAffixGroups) {
      assert.ok(AFFIX_GROUP_VALUES.has(group), `${base.id} carries unknown affix group '${group}'`);
    }
  }
});

test('ITMS.B07 the seven 03-combat-math.md §4.6 reference weapons match exactly', () => {
  for (const ref of REFERENCE_WEAPONS) {
    const base = ITEM_BASES_BY_ID[ref.id];
    assert.ok(base, `reference weapon '${ref.id}' missing from the catalogue`);
    assert.equal(base.category, 'weapon', ref.id);
    assert.equal(base.reqLevel, ref.reqLevel, `${ref.id}.reqLevel`);
    assert.equal(base.reqStr, ref.reqStr, `${ref.id}.reqStr`);
    assert.equal(base.reqDex, ref.reqDex, `${ref.id}.reqDex`);
    assert.ok(base.weapon, `${ref.id}.weapon missing`);
    assert.equal(base.weapon.minDamage, ref.minDamage, `${ref.id}.weapon.minDamage`);
    assert.equal(base.weapon.maxDamage, ref.maxDamage, `${ref.id}.weapon.maxDamage`);
    assert.equal(base.weapon.attackTime, ref.attackTime, `${ref.id}.weapon.attackTime`);
    assert.equal(base.weapon.attackRating, ref.attackRating, `${ref.id}.weapon.attackRating`);
  }
  // Grid is fixed for the six real weapons (unarmed has none — see above).
  for (const ref of REFERENCE_WEAPONS) {
    if (ref.id === 'unarmed') continue;
    const base = ITEM_BASES_BY_ID[ref.id];
    assert.equal(base.invW, ref.invW, `${ref.id}.invW`);
    assert.equal(base.invH, ref.invH, `${ref.id}.invH`);
  }
  // staff_ash_normal is 1x4, deliberately (04 §14.2 C-6) — not "fixed" to
  // match the 09-ui.md §7.3 icon recipe's 2x4.
  assert.equal(ITEM_BASES_BY_ID.staff_ash_normal.invW, 1);
  assert.equal(ITEM_BASES_BY_ID.staff_ash_normal.invH, 4);
});

test('ITMS.B08 axe_battle_normal.baseValue is the authored 220 (04 §14.2 C-7)', () => {
  // The §1.1 formula (3.4 * 9^1.9, rounded) yields 221; the table carries
  // the authored integer, and this pins that decision to the data.
  assert.equal(ITEM_BASES_BY_ID.axe_battle_normal.baseValue, 220);
});

test('ITMS.B09 every id is snake_case and matches its own record key', () => {
  const SNAKE = /^[a-z][a-z0-9_]*$/;
  for (const base of ITEM_BASES) {
    assert.match(base.id, SNAKE, base.id);
  }
});
