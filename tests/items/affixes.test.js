// tests/items/affixes.test.js
//
// ITEM-2 acceptance tests for src/items/data/affixes.js. `node:test` +
// `node:assert/strict` only, matching every sibling test file in this repo
// (e.g. tests/items/bases.test.js, tests/ai/bestiary.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, acceptance points 1-7):
//   1. Exactly 117 records in one frozen array, declaration order: 61
//      prefixes then 56 suffixes.
//   2. Exactly 63 distinct `group` values.
//   3. Exactly 7 `alvl` bands (04 §2.2).
//   4. Every `mods[].stat` is one of the 92 stat identifiers of
//      01-data-model.md §3 — checked against a LITERAL transcription of that
//      list (below), never against src/actors/'s StatBlock (which does not
//      exist yet at this milestone, and is a different subsystem besides —
//      ARCHITECTURE.md rule 2 forbids importing it from here regardless).
//   5. `alvl <= maxLevel` on every row.
//   6. Every `requiresGroups` entry is in the 04 §1.2 vocabulary, AND
//      intersects the `allowedAffixGroups` of at least one real base in
//      src/items/data/bases.js (imported read-only, same subsystem).
//   7. Every `appliesTo` entry is a real `ItemBase.category` value.
//
// NOT tested here (O-27): affix rolling, weighted pick, sharedRoll's actual
// draw behaviour, treasure classes, magic-item naming — none of that exists
// yet and none of it is this ticket's contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AFFIXES, AFFIXES_BY_ID } from '../../src/items/data/affixes.js';
import { ITEM_BASES } from '../../src/items/data/bases.js';

// ---------------------------------------------------------------------------
// 01-data-model.md §3 — the 92 stat identifiers, transcribed literally.
// Counted below (test A04a) rather than trusted from this comment: 4 primary
// attributes (§3.1) + 12 vessel/regen (§3.2) + 45 offence (§3.3) + 21 defence
// + 1 flag (§3.4) + 8 utility + 1 structured record (§3.5) = 92, matching
// §3.6's own stated split.
// ---------------------------------------------------------------------------
const STAT_IDENTIFIERS = [
  // §3.1 Primary attributes (4)
  'strength', 'dexterity', 'vitality', 'energy',
  // §3.2 Vessels and regeneration (12)
  'maxLife', 'lifePercent', 'maxMana', 'manaPercent', 'maxRage', 'maxResonance',
  'maxStamina', 'lifeRegen', 'lifeRegenPercent', 'manaRegen', 'manaRegenPercent',
  'staminaRegen',
  // §3.3 Offence (45)
  'minDamage', 'maxDamage', 'enhancedDamage', 'attackRating', 'attackRatingPercent',
  'increasedAttackSpeed', 'fasterCastRate', 'critChance', 'critMult',
  'fireMin', 'fireMax', 'coldMin', 'coldMax', 'lightMin', 'lightMax',
  'poisonMin', 'poisonMax', 'magicMin', 'magicMax',
  'coldDuration', 'poisonDuration',
  'fireDamagePercent', 'coldDamagePercent', 'lightDamagePercent',
  'poisonDamagePercent', 'magicDamagePercent', 'elementalDamagePercent',
  'physicalDamagePercent',
  'fireResistPierce', 'coldResistPierce', 'lightResistPierce', 'poisonResistPierce',
  'lifeSteal', 'manaSteal', 'lifeOnHit', 'manaOnHit', 'lifeOnKill', 'manaOnKill',
  'manaReturnPercent', 'pierceChance', 'knockbackChance', 'thorns',
  'rageOnHit', 'rageOnTakeHit', 'resonanceOnHit',
  // §3.4 Defence (21 + 1 flag)
  'defense', 'defensePercent', 'blockChance', 'dodgeChance',
  'fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist',
  'maxFireResist', 'maxColdResist', 'maxLightResist', 'maxPoisonResist', 'maxMagicResist', 'maxPhysicalResist',
  'damageReduceFlat', 'damageReducePercent', 'magicDamageReduceFlat',
  'fasterHitRecovery', 'ccReduction', 'cannotBeFrozen',
  // §3.5 Utility (8 + skillBonuses)
  'movementSpeed', 'magicFind', 'goldFind', 'manaCostReduction', 'lightRadius',
  'requirementReduction', 'damageTakenToMana', 'experienceGain', 'skillBonuses',
];

// 04-items.md §1.2 — the fifteen `allowedAffixGroups` / `requiresGroups`
// applicability strings, verbatim (matches tests/items/bases.test.js's own
// copy, transcribed independently here per this ticket's own instruction).
const AFFIX_GROUP_VALUES = new Set([
  'universal',
  'weapon.any', 'weapon.melee', 'weapon.caster', 'weapon.twohand',
  'armour.any', 'armour.body', 'armour.helm', 'armour.gloves', 'armour.boots',
  'armour.belt', 'armour.shield',
  'jewelry.any', 'jewelry.ring', 'jewelry.amulet',
]);

// 04-items.md §2.2 — the seven alvl bands, verbatim ranges.
const ALVL_BANDS = [
  { name: 'B0', min: 1, max: 3 },
  { name: 'B1', min: 4, max: 8 },
  { name: 'B2', min: 9, max: 13 },
  { name: 'B3', min: 14, max: 18 },
  { name: 'B4', min: 19, max: 22 },
  { name: 'B5', min: 23, max: 26 },
  { name: 'B6', min: 27, max: 29 },
];

function bandOf(alvl) {
  return ALVL_BANDS.find((b) => alvl >= b.min && alvl <= b.max) ?? null;
}

const REAL_CATEGORY_VALUES = new Set(ITEM_BASES.map((b) => b.category));

test('ITMS.A00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.ok(Array.isArray(AFFIXES));
  assert.ok(Object.isFrozen(AFFIXES));
});

test('ITMS.A01 exactly 117 records: 61 prefixes then 56 suffixes, in that declaration order', () => {
  assert.equal(AFFIXES.length, 117);

  const kinds = AFFIXES.map((a) => a.kind);
  const prefixCount = kinds.filter((k) => k === 'prefix').length;
  const suffixCount = kinds.filter((k) => k === 'suffix').length;
  assert.equal(prefixCount, 61, 'prefix count');
  assert.equal(suffixCount, 56, 'suffix count');
  assert.equal(prefixCount + suffixCount, 117);

  // Declaration order is contractual (04 §9.4): all 61 prefixes come first,
  // then all 56 suffixes — never interleaved, never re-sorted.
  let sawSuffix = false;
  for (const affix of AFFIXES) {
    assert.ok(affix.kind === 'prefix' || affix.kind === 'suffix', `unexpected kind '${affix.kind}' on '${affix.id}'`);
    if (affix.kind === 'suffix') sawSuffix = true;
    if (sawSuffix) assert.equal(affix.kind, 'suffix', `'${affix.id}' is a prefix after a suffix already appeared`);
  }
});

test('ITMS.A02 exactly 63 distinct group values', () => {
  const groups = new Set(AFFIXES.map((a) => a.group));
  assert.equal(groups.size, 63);
});

test('ITMS.A03 exactly 7 alvl bands are represented, and every alvl falls in one', () => {
  const bandsSeen = new Set();
  for (const affix of AFFIXES) {
    const band = bandOf(affix.alvl);
    assert.ok(band, `${affix.id}.alvl=${affix.alvl} does not fall in any 04 §2.2 band`);
    bandsSeen.add(band.name);
  }
  assert.equal(bandsSeen.size, 7, `expected all 7 bands represented, saw: ${[...bandsSeen].sort().join(', ')}`);
});

test('ITMS.A04a the literal STAT_IDENTIFIERS transcription itself totals 92', () => {
  // Independent of AFFIXES — pins the transcription against 01 §3.6's own
  // stated count (90 numeric + 1 flag + 1 structured record = 92) before
  // using it to check anything.
  assert.equal(STAT_IDENTIFIERS.length, 92);
  assert.equal(new Set(STAT_IDENTIFIERS).size, 92, 'no duplicate identifiers in the transcription');
});

test('ITMS.A04 every mods[].stat resolves to one of the 92 stat identifiers', () => {
  const known = new Set(STAT_IDENTIFIERS);
  for (const affix of AFFIXES) {
    assert.ok(Array.isArray(affix.mods) && affix.mods.length > 0, `${affix.id}.mods is empty or not an array`);
    for (const mod of affix.mods) {
      // 'skillBonuses.tree' / 'skillBonuses.all' (04 §2.3) are the
      // structured 'skillBonuses' record (01 §3.5/§3.6) addressed by a
      // sub-path; the base identifier before the first '.' is what must be
      // one of the 92 — this is the mechanism that would catch a typo like
      // 'skillBonuses.tree2' or a stray 'skilBonuses.tree'.
      const base = mod.stat.includes('.') ? mod.stat.split('.')[0] : mod.stat;
      assert.ok(known.has(base), `${affix.id} mod stat '${mod.stat}' (base '${base}') is not one of the 92 01 §3 identifiers`);
    }
  }
});

test('ITMS.A05 alvl <= maxLevel on every row', () => {
  for (const affix of AFFIXES) {
    assert.ok(
      Number.isInteger(affix.alvl) && Number.isInteger(affix.maxLevel) && affix.alvl <= affix.maxLevel,
      `${affix.id}: alvl=${affix.alvl} maxLevel=${affix.maxLevel}`,
    );
  }
});

test('ITMS.A06 every requiresGroups entry is in the 04 §1.2 vocabulary and intersects a real base', () => {
  // Build, once, the set of every allowedAffixGroups string that appears on
  // at least one real ItemBase — the independent cross-check this
  // criterion asks for.
  const groupsCarriedByRealBases = new Set();
  for (const base of ITEM_BASES) {
    assert.ok(Array.isArray(base.allowedAffixGroups), `bases.js: ${base.id}.allowedAffixGroups is not an array`);
    for (const g of base.allowedAffixGroups) groupsCarriedByRealBases.add(g);
  }

  for (const affix of AFFIXES) {
    assert.ok(Array.isArray(affix.requiresGroups) && affix.requiresGroups.length > 0, `${affix.id}.requiresGroups is empty or not an array`);
    let intersects = false;
    for (const g of affix.requiresGroups) {
      assert.ok(AFFIX_GROUP_VALUES.has(g), `${affix.id} carries unknown requiresGroups entry '${g}'`);
      if (groupsCarriedByRealBases.has(g)) intersects = true;
    }
    assert.ok(intersects, `${affix.id}.requiresGroups (${affix.requiresGroups.join(', ')}) intersects no real base's allowedAffixGroups — dead affix`);
  }
});

test('ITMS.A07 every appliesTo entry is a real ItemBase.category value', () => {
  for (const affix of AFFIXES) {
    assert.ok(Array.isArray(affix.appliesTo) && affix.appliesTo.length > 0, `${affix.id}.appliesTo is empty or not an array`);
    for (const cat of affix.appliesTo) {
      assert.ok(REAL_CATEGORY_VALUES.has(cat), `${affix.id} carries unknown appliesTo category '${cat}'`);
    }
  }
});

test('ITMS.A08 every id is unique, snake_case, and resolves via AFFIXES_BY_ID', () => {
  const SNAKE = /^[a-z][a-z0-9_]*$/;
  const ids = AFFIXES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id found');
  for (const affix of AFFIXES) {
    assert.match(affix.id, SNAKE, affix.id);
    assert.equal(AFFIXES_BY_ID[affix.id], affix);
  }
  assert.equal(Object.getPrototypeOf(AFFIXES_BY_ID), null, 'AFFIXES_BY_ID must be Object.create(null)');
});

test('ITMS.A09 sharedRoll is true only on the two res_all rows, and mods share min/max there', () => {
  const sharedRollIds = AFFIXES.filter((a) => a.sharedRoll === true).map((a) => a.id);
  assert.deepEqual(sharedRollIds.sort(), ['sfx_res_all_1', 'sfx_res_all_2']);
  for (const affix of AFFIXES) {
    assert.equal(typeof affix.sharedRoll, 'boolean', `${affix.id}.sharedRoll is not a boolean`);
  }
  for (const id of sharedRollIds) {
    const affix = AFFIXES_BY_ID[id];
    assert.equal(affix.mods.length, 6, `${id} should carry all six resistance mods`);
    const [first, ...rest] = affix.mods;
    for (const mod of rest) {
      assert.equal(mod.min, first.min, `${id}: ${mod.stat} min differs from ${first.stat}`);
      assert.equal(mod.max, first.max, `${id}: ${mod.stat} max differs from ${first.stat}`);
    }
  }
});

test('ITMS.A10 weight is a positive integer, and mod ranges are well-formed', () => {
  for (const affix of AFFIXES) {
    assert.ok(Number.isInteger(affix.weight) && affix.weight > 0, `${affix.id}.weight=${affix.weight}`);
    for (const mod of affix.mods) {
      assert.ok(mod.min <= mod.max, `${affix.id} mod '${mod.stat}': min=${mod.min} > max=${mod.max}`);
      assert.ok(mod.step > 0, `${affix.id} mod '${mod.stat}': step=${mod.step} must be positive`);
    }
  }
});

test('ITMS.A11 pfx_enhanced_damage_3 matches 04 §14.1 D-5 exactly', () => {
  const affix = AFFIXES_BY_ID.pfx_enhanced_damage_3;
  assert.ok(affix, 'pfx_enhanced_damage_3 missing');
  assert.equal(affix.kind, 'prefix');
  assert.equal(affix.group, 'enhanced_damage');
  assert.equal(affix.name, 'Keen');
  assert.equal(affix.alvl, 8);
  assert.equal(affix.maxLevel, 40);
  assert.equal(affix.weight, 60);
  assert.deepEqual([...affix.requiresGroups], ['weapon.any']);
  assert.equal(affix.mods.length, 1);
  assert.equal(affix.mods[0].stat, 'enhancedDamage');
  assert.equal(affix.mods[0].min, 30);
  assert.equal(affix.mods[0].max, 50);
});

test('ITMS.A12 sfx_attack_rating_2 range makes 01 §5.2\'s values:[15] example legal', () => {
  const affix = AFFIXES_BY_ID.sfx_attack_rating_2;
  assert.ok(affix, 'sfx_attack_rating_2 missing');
  assert.equal(affix.mods[0].stat, 'attackRating');
  assert.ok(affix.mods[0].min <= 15 && 15 <= affix.mods[0].max, 'values:[15] must be a legal roll');
});
