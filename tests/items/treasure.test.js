// tests/items/treasure.test.js
//
// ITEM-3 acceptance tests for src/items/data/treasure.js. `node:test` +
// `node:assert/strict` only, matching every sibling test file in this repo
// (tests/items/bases.test.js, tests/items/affixes.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, acceptance points 1-5):
//   1. Every non-boss class's `entries` weights sum to exactly 1000.
//   2. Every `sub` id (top-level entries and tc_boss's script) resolves to
//      a real class in TREASURE_CLASSES_BY_ID.
//   3. resolveTC('tc_humanoid', n) returns 04 §5.1's band for all n in 1..40.
//   4. The full inventory ships: 16 monster classes, tc_boss, tc_urn, three
//      chest classes, four potion sub-tables, two scroll sub-tables.
//   5. Every base id referenced by a sub-table entry (potion/scroll `id`
//      fields) resolves against the live ITEM_BASES_BY_ID (ITEM-1).
//
// NOT tested here (owned by later M3 tickets): rollDrop's draw order, PICKS/
// NODROP_SCALE rank modifiers, ground scatter. Rule O-27's own discipline:
// this file asserts ITEM-3's own contract only.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TREASURE_CLASSES, TREASURE_CLASSES_BY_ID, resolveTC } from '../../src/items/data/treasure.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';

test('ITMS.T00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.ok(Array.isArray(TREASURE_CLASSES));
});

test('ITMS.T01 the full inventory ships: 16 monster + tc_boss + tc_urn + 3 chest + 4 potion + 2 scroll = 27 classes', () => {
  assert.equal(TREASURE_CLASSES.length, 27);

  const monsterFamilies = ['tc_humanoid', 'tc_swarm', 'tc_caster', 'tc_heavy'];
  for (const family of monsterFamilies) {
    for (let band = 1; band <= 4; band++) {
      const id = `${family}_${band}`;
      assert.ok(id in TREASURE_CLASSES_BY_ID, `missing monster class ${id}`);
    }
  }
  assert.ok('tc_boss' in TREASURE_CLASSES_BY_ID);
  assert.ok('tc_urn' in TREASURE_CLASSES_BY_ID);
  for (const id of ['tc_wastes', 'tc_bonereach', 'tc_altar']) {
    assert.ok(id in TREASURE_CLASSES_BY_ID, `missing chest class ${id}`);
  }
  for (let band = 1; band <= 4; band++) {
    assert.ok(`tc_potion_${band}` in TREASURE_CLASSES_BY_ID, `missing potion sub-table tc_potion_${band}`);
  }
  assert.ok('tc_scroll' in TREASURE_CLASSES_BY_ID);
  assert.ok('tc_scroll_boss' in TREASURE_CLASSES_BY_ID);

  // 16 monster + 1 boss + 1 urn + 3 chest + 4 potion + 2 scroll = 27, exactly.
  assert.equal(monsterFamilies.length * 4 + 1 + 1 + 3 + 4 + 2, 27);
});

test('ITMS.T02 every id is unique', () => {
  const ids = TREASURE_CLASSES.map((tc) => tc.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const tc of TREASURE_CLASSES) {
    assert.equal(TREASURE_CLASSES_BY_ID[tc.id], tc);
  }
});

test('ITMS.T03 every non-boss class\'s entries weights sum to exactly 1000', () => {
  const failures = [];
  for (const tc of TREASURE_CLASSES) {
    if (tc.id === 'tc_boss') continue; // §5.5: "No nodrop, no weights. A fixed script."
    assert.ok(Array.isArray(tc.entries), `${tc.id} has no entries array`);
    const sum = tc.entries.reduce((total, entry) => {
      assert.equal(typeof entry.weight, 'number', `${tc.id} entry has non-numeric weight`);
      return total + entry.weight;
    }, 0);
    if (sum !== 1000) failures.push(`${tc.id} sums to ${sum}`);
  }
  assert.deepEqual(failures, [], `classes not summing to 1000: ${failures.join(', ')}`);
});

test('ITMS.T04 tc_boss is a fixed ten-step script, not a weighted table', () => {
  const boss = TREASURE_CLASSES_BY_ID.tc_boss;
  assert.ok(Array.isArray(boss.script));
  assert.equal(boss.script.length, 10);
  assert.equal(boss.entries, undefined);
  assert.equal(boss.script[0].step, 'uniqueGuaranteed');
  assert.equal(boss.script[1].step, 'item');
  assert.equal(boss.script[1].rarityFloor, 'rare');
  assert.equal(boss.script[9].step, 'scroll');
  assert.equal(boss.script[9].sub, 'tc_scroll_boss');
});

test('ITMS.T05 every sub id (top-level entries and tc_boss.script) resolves to a real class in the table', () => {
  const checked = [];
  for (const tc of TREASURE_CLASSES) {
    const rows = tc.entries || tc.script;
    for (const entry of rows) {
      if (entry.sub !== undefined) {
        assert.ok(entry.sub in TREASURE_CLASSES_BY_ID, `${tc.id}: sub '${entry.sub}' does not resolve`);
        checked.push(entry.sub);
      }
    }
  }
  // Sanity: this test actually exercised something — every monster class's
  // potion/scroll rows and tc_boss's scroll step all carry a sub id.
  assert.ok(checked.length >= 16 * 2 + 1, `expected at least 33 sub ids checked, saw ${checked.length}`);
});

test('ITMS.T06 every base id referenced by a sub-table entry resolves against ITEM_BASES_BY_ID', () => {
  const subTableIds = [
    'tc_potion_1', 'tc_potion_2', 'tc_potion_3', 'tc_potion_4',
    'tc_scroll', 'tc_scroll_boss',
  ];
  let checked = 0;
  for (const tcId of subTableIds) {
    const tc = TREASURE_CLASSES_BY_ID[tcId];
    assert.ok(tc, `missing sub-table ${tcId}`);
    for (const entry of tc.entries) {
      assert.ok('id' in entry, `${tcId} entry missing base id`);
      assert.ok(entry.id in ITEM_BASES_BY_ID, `${tcId}: dangling base id '${entry.id}'`);
      checked++;
    }
  }
  assert.equal(checked, 4 * 9 + 2 + 3); // four 9-row potion tables + tc_scroll(2) + tc_scroll_boss(3)
});

test('ITMS.T07 every potion sub-table sums to exactly 1000', () => {
  for (let band = 1; band <= 4; band++) {
    const tc = TREASURE_CLASSES_BY_ID[`tc_potion_${band}`];
    const sum = tc.entries.reduce((total, entry) => total + entry.weight, 0);
    assert.equal(sum, 1000, `tc_potion_${band} sums to ${sum}`);
  }
});

test('ITMS.T08 both scroll sub-tables sum to exactly 1000', () => {
  for (const id of ['tc_scroll', 'tc_scroll_boss']) {
    const tc = TREASURE_CLASSES_BY_ID[id];
    const sum = tc.entries.reduce((total, entry) => total + entry.weight, 0);
    assert.equal(sum, 1000, `${id} sums to ${sum}`);
  }
});

test("ITMS.T09 resolveTC('tc_humanoid', n) returns 04 §5.1's band for all n in 1..40", () => {
  for (let mlvl = 1; mlvl <= 40; mlvl++) {
    const expected =
      mlvl <= 9 ? 'tc_humanoid_1' :
      mlvl <= 19 ? 'tc_humanoid_2' :
      mlvl <= 29 ? 'tc_humanoid_3' :
      'tc_humanoid_4';
    assert.equal(resolveTC('tc_humanoid', mlvl), expected, `mlvl ${mlvl}`);
  }
});

test('ITMS.T10 resolveTC bands all four monster families identically at the documented boundaries', () => {
  const families = ['tc_humanoid', 'tc_swarm', 'tc_caster', 'tc_heavy'];
  const boundaries = [
    [1, 1], [9, 1], [10, 2], [19, 2], [20, 3], [29, 3], [30, 4], [40, 4],
  ];
  for (const family of families) {
    for (const [mlvl, band] of boundaries) {
      assert.equal(resolveTC(family, mlvl), `${family}_${band}`, `${family} @ mlvl ${mlvl}`);
    }
  }
});

test('ITMS.T11 the worked example from 04 §5.1: bone_ranker at mlvl 33 resolves tc_humanoid -> tc_humanoid_4', () => {
  assert.equal(resolveTC('tc_humanoid', 33), 'tc_humanoid_4');
});

test('ITMS.T12 single-class families resolve to themselves regardless of mlvl', () => {
  const singles = ['tc_boss', 'tc_urn', 'tc_wastes', 'tc_bonereach', 'tc_altar', 'tc_scroll', 'tc_scroll_boss'];
  for (const id of singles) {
    for (const mlvl of [1, 15, 40]) {
      assert.equal(resolveTC(id, mlvl), id, `${id} @ mlvl ${mlvl}`);
    }
  }
});

test('ITMS.T13 resolveTC is a pure lookup: same inputs, same output, no observable state change', () => {
  const before = JSON.stringify(TREASURE_CLASSES);
  for (let i = 0; i < 100; i++) {
    resolveTC('tc_caster', (i % 40) + 1);
  }
  const after = JSON.stringify(TREASURE_CLASSES);
  assert.equal(before, after, 'resolveTC must not mutate the treasure-class table');
});

test('ITMS.T14 tc_urn and the three chest classes carry no nodrop-family-style band assumption in their sub ids', () => {
  // This ticket's own report flags the ambiguity: tc_urn/tc_wastes/tc_bonereach/
  // tc_altar have no fixed mlvl band (§5.6's ilvl is a runtime formula), so
  // their potion/scroll entries must not carry a guessed literal sub id.
  for (const id of ['tc_urn', 'tc_wastes', 'tc_bonereach', 'tc_altar']) {
    const tc = TREASURE_CLASSES_BY_ID[id];
    for (const entry of tc.entries) {
      if (entry.kind === 'potion' || entry.kind === 'scroll') {
        assert.equal(entry.sub, undefined, `${id}.${entry.kind} entry must not bake in a guessed band`);
      }
    }
  }
});

test('ITMS.T15 rarityFloor appears only where 04 §5.5/§5.6 puts it, and nowhere else', () => {
  const floored = [];
  for (const tc of TREASURE_CLASSES) {
    const rows = tc.entries || tc.script;
    for (const entry of rows) {
      if (entry.rarityFloor !== undefined) floored.push(`${tc.id}:${entry.kind || entry.step}=${entry.rarityFloor}`);
    }
  }
  assert.deepEqual(floored.sort(), [
    'tc_boss:item=rare',
    'tc_urn:item=magic',
  ]);
});
