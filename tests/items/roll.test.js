// tests/items/roll.test.js
//
// ITEM-5 acceptance tests for src/items/roll.js (the `rollItem` skeleton).
// `node:test` + `node:assert/strict` only, matching every sibling test file
// in this repo (tests/items/bases.test.js, tests/items/affixes.test.js,
// tests/items/treasure.test.js, tests/items/quality.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief):
//   1. The recorded draw sequence matches 04 §9.2 for D3/D4/D5/D7/D8, in
//      order, with the right conditionality (D7 only on superior, D8 only
//      on armour, a skipped draw is not consumed) — 12.D08. Proven with a
//      counting/tagging Rng wrapper, not by reading the code.
//   2. `degrade` covers all five branches of §9.5, each exercised by a
//      test, including superior -> normal on jewelry and the two branches
//      that depend on legalAffixCount.
//   3. B1 and B2, direct assertions (tools/lootsim.mjs is TEST-7 and does
//      not exist yet — these are NOT a lootsim run, they are this ticket's
//      own sampling loop asserting the same two properties, named B1/B2 so
//      TEST-7 can subsume them later).
//
// EXTENDED TWICE SINCE, both times for the same reason (a test whose
// expected value was computed from the subset of the pipeline that existed
// on the day it was written — this project's O-27/O-39):
//   - ITEM-6 grew R25's draw-count formula for D9/D10/D11 once the affix
//     count model / picking / value rolling landed.
//   - ITEM-7 grew it a second time for D6/D12 (ITMS.R11/R13/R25) once the 8
//     real `UniqueDefinition` records landed and `roll.js`'s module-level
//     unique-pool default stopped being an empty stub. This is the THIRD
//     recorded time R25 specifically has needed this repair.
//
// Full unique-substitution acceptance (the 8 records match `04` §6, the D6
// weighted pool mechanics, the sweep count, the positional D12 roll) is
// still ITEM-7's own file, tests/items/uniques.test.js — R11/R13/R25 here
// only cover what they always covered (degrade's branch coverage, the
// setUniquePoolSource injection point, and rollItem's per-item draw-count
// invariant), now correctly accounting for the unique branch existing.
//
// NOT tested here (owned by later M3 tickets, deliberately absent from
// roll.js by design — see that file's own header): rare naming (D13,
// ITEM-8), rollDrop itself (D1/D2/D14/D15, ITEM-9). Rule O-27: this file
// asserts ITEM-5's own contract (as extended) only, never "items has no
// affixes yet" or similar as a positive assertion of absence.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { CountingRng } from '../../src/items/rng.js';
import { ITEM_BASES, ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { AFFIXES } from '../../src/items/data/affixes.js';
import { UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
// ITEM-8, round 2 — ITMS.R25 now rolls real rares through D13, so the
// 64-entry ring's state must be reset for a deterministic, reproducible
// run, independent of whatever else ran earlier in this file/process.
import { resetRareRing } from '../../src/items/names.js';
import {
  BASE_GROUPS,
  GROUP_BASES,
  rollBaseGroup,
  rollBaseInGroup,
  applyFloor,
  degrade,
  legalAffixCount,
  setUniquePoolSource,
  uniquePoolAt,
  rollSuperiorAmount,
  rollDefenseAmount,
  rollItem,
} from '../../src/items/roll.js';

// ---------------------------------------------------------------------------
// A scripted Rng: `next()` pops a pre-programmed value off a queue (falling
// back to 0.999999 once exhausted) and logs every value it hands out. Every
// other Rng method (`int`, `weighted`, `bool`, `range`, `pick`) is the REAL
// `Rng` implementation, inherited unchanged — only the underlying uniform
// draw is scripted, so this proves rollItem's actual call sequence (via
// `.log`), not an assumption about it. Used to force a specific, known
// outcome (a specific group, a specific base, a specific rarity) so the
// literal draw sequence can be read off deterministically, matching the
// same "fixedRng" pattern tests/items/quality.test.js already uses, just
// extended to a queue instead of one constant value.
class ScriptedRng extends Rng {
  constructor(script) {
    super(1); // dummy seed — next() is overridden below, real state unused
    this._script = script.slice();
    this.log = [];
  }
  next() {
    const v = this._script.length ? this._script.shift() : 0.999999;
    this.log.push(v);
    return v;
  }
}

test('ITMS.R00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof rollItem, 'function');
});

// ---------------------------------------------------------------------------
// 1. BASE_GROUPS / GROUP_BASES — 04 §1.3, transcribed verbatim, and D-2's
//    "two draws: group then base" own precondition (every real base is in
//    exactly one group, no base is in zero groups except the two excluded
//    pseudo-rows).
// ---------------------------------------------------------------------------

test('ITMS.R01 BASE_GROUPS matches 04 §1.3 verbatim: nine rows, weights sum to 1000', () => {
  const expected = [
    ['weapon', 300], ['chest', 120], ['helm', 110], ['gloves', 95],
    ['boots', 95], ['ring', 90], ['belt', 85], ['shield', 65], ['amulet', 40],
  ];
  assert.equal(BASE_GROUPS.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(BASE_GROUPS[i].id, expected[i][0], `row ${i} id`);
    assert.equal(BASE_GROUPS[i].weight, expected[i][1], `row ${i} weight`);
  }
  const total = BASE_GROUPS.reduce((s, g) => s + g.weight, 0);
  assert.equal(total, 1000);
});

test('ITMS.R02 GROUP_BASES covers exactly the 61 equipment bases, split as 04 §1.4-§1.6 documents', () => {
  const expectedCounts = {
    weapon: 26, chest: 8, helm: 5, gloves: 4, boots: 4, ring: 3, belt: 4, shield: 4, amulet: 3,
  };
  let total = 0;
  for (const g of BASE_GROUPS) {
    const bases = GROUP_BASES[g.id];
    assert.equal(bases.length, expectedCounts[g.id], `group '${g.id}' base count`);
    total += bases.length;
    for (const b of bases) assert.ok(b.dropWeight > 0, `${b.id} must have dropWeight > 0 to be in a group list`);
  }
  assert.equal(total, 61, 'group lists must cover exactly the 61 equipment bases, no more, no fewer');

  // unarmed and quest_first_tablet (dropWeight 0) must appear in NO group.
  const grouped = new Set();
  for (const g of BASE_GROUPS) for (const b of GROUP_BASES[g.id]) grouped.add(b.id);
  assert.ok(!grouped.has('unarmed'), 'unarmed must never be a group-draw candidate');
  assert.ok(!grouped.has('quest_first_tablet'), 'quest_first_tablet must never be a group-draw candidate');

  // Every one of the 61 equipment bases (independently re-derived from
  // ITEM_BASES, not from GROUP_BASES itself) must appear in exactly one group.
  const equipmentIds = ITEM_BASES
    .filter((b) => b.dropWeight > 0 && (b.category === 'weapon' || b.category === 'armour' || b.category === 'jewelry'))
    .map((b) => b.id);
  assert.equal(equipmentIds.length, 61, 'independent count of equipment bases must also be 61');
  for (const id of equipmentIds) assert.ok(grouped.has(id), `${id} must be reachable through some group`);
});

// ---------------------------------------------------------------------------
// 2. rollBaseGroup / rollBaseInGroup — D3/D4 draw-count and eligibility
//    behaviour, exercised with a real seeded Rng (not scripted) for the
//    "throws when nothing is eligible" edge and with CountingRng for the
//    one-draw-per-call contract.
// ---------------------------------------------------------------------------

test('ITMS.R03 rollBaseGroup consumes exactly one draw, at every ilvl from 1 to 40', () => {
  const counting = new CountingRng(new Rng(0xf00d));
  for (let ilvl = 1; ilvl <= 40; ilvl++) {
    const before = counting.draws;
    const group = rollBaseGroup(ilvl, counting);
    assert.equal(counting.draws - before, 1, `ilvl ${ilvl}: rollBaseGroup must consume exactly one draw`);
    assert.ok(BASE_GROUPS.some((g) => g.id === group), `ilvl ${ilvl}: '${group}' must be a real group id`);
  }
});

test('ITMS.R04 rollBaseInGroup consumes exactly one draw and only returns reqLevel <= ilvl bases', () => {
  const counting = new CountingRng(new Rng(0xbeef));
  for (const g of BASE_GROUPS) {
    for (let ilvl = 1; ilvl <= 40; ilvl++) {
      const bases = GROUP_BASES[g.id].filter((b) => b.reqLevel <= ilvl);
      if (bases.length === 0) continue; // group not eligible yet at this ilvl
      const before = counting.draws;
      const base = rollBaseInGroup(g.id, ilvl, counting);
      assert.equal(counting.draws - before, 1, `group ${g.id} ilvl ${ilvl}: must consume exactly one draw`);
      assert.ok(base.reqLevel <= ilvl, `group ${g.id} ilvl ${ilvl}: picked ${base.id} has reqLevel ${base.reqLevel} > ${ilvl}`);
      assert.equal(GROUP_BASES[g.id].includes(base), true, `picked base must belong to the requested group`);
    }
  }
});

test('ITMS.R05 rollBaseGroup / rollBaseInGroup throw (not silently pick) when nothing is eligible, without consuming a draw', () => {
  const counting = new CountingRng(new Rng(1));
  // ilvl 0 is below every base's reqLevel (minimum authored reqLevel is 1).
  assert.throws(() => rollBaseGroup(0, counting), RangeError);
  assert.equal(counting.draws, 0, 'a rejected group draw must not consume a draw');
  assert.throws(() => rollBaseInGroup('shield', 0, counting), RangeError);
  assert.equal(counting.draws, 0, 'a rejected base draw must not consume a draw');
  assert.throws(() => rollBaseInGroup('not_a_group', 30, counting), RangeError);
  assert.equal(counting.draws, 0);
});

// ---------------------------------------------------------------------------
// 3. applyFloor — 04 §9.5, verbatim.
// ---------------------------------------------------------------------------

test('ITMS.R06 applyFloor: null/absent floor never changes rarity', () => {
  for (const r of ['normal', 'superior', 'magic', 'rare', 'unique']) {
    assert.equal(applyFloor(r, null), r);
    assert.equal(applyFloor(r, undefined), r);
  }
});

test("ITMS.R07 applyFloor('magic') raises normal/superior to magic, leaves magic/rare/unique alone", () => {
  assert.equal(applyFloor('normal', 'magic'), 'magic');
  assert.equal(applyFloor('superior', 'magic'), 'magic');
  assert.equal(applyFloor('magic', 'magic'), 'magic');
  assert.equal(applyFloor('rare', 'magic'), 'rare');
  assert.equal(applyFloor('unique', 'magic'), 'unique');
});

test("ITMS.R08 applyFloor('rare') raises everything below rare, leaves rare/unique alone", () => {
  assert.equal(applyFloor('normal', 'rare'), 'rare');
  assert.equal(applyFloor('superior', 'rare'), 'rare');
  assert.equal(applyFloor('magic', 'rare'), 'rare');
  assert.equal(applyFloor('rare', 'rare'), 'rare');
  assert.equal(applyFloor('unique', 'rare'), 'unique');
});

// ---------------------------------------------------------------------------
// 4. legalAffixCount — cross-checked against an INDEPENDENTLY written
//    reference implementation of 04 §9.4 rules 1/2/4/5, over real data.
// ---------------------------------------------------------------------------

function referenceLegalAffixCount(base, ilvl) {
  let n = 0;
  for (const affix of AFFIXES) {
    if (ilvl < affix.alvl) continue;
    if (ilvl > affix.maxLevel) continue;
    if (!affix.appliesTo.includes(base.category)) continue;
    const intersects = affix.requiresGroups.some((g) => base.allowedAffixGroups.includes(g));
    if (!intersects) continue;
    n++;
  }
  return n;
}

test('ITMS.R09 legalAffixCount matches an independently written reference filter over real bases/ilvls', () => {
  const sampleIlvls = [1, 4, 8, 12, 16, 20, 24, 28, 32, 40];
  let checked = 0;
  for (const base of ITEM_BASES) {
    if (base.category !== 'weapon' && base.category !== 'armour' && base.category !== 'jewelry') continue;
    for (const ilvl of sampleIlvls) {
      const expected = referenceLegalAffixCount(base, ilvl);
      const actual = legalAffixCount(base, ilvl);
      assert.equal(actual, expected, `${base.id} @ ilvl ${ilvl}`);
      checked++;
    }
  }
  assert.ok(checked > 500, `sanity: expected a large cross-check sample, got ${checked}`);
});

test('ITMS.R10 legalAffixCount is 0 for a base with no allowedAffixGroups (quest_first_tablet), at every ilvl', () => {
  const base = ITEM_BASES_BY_ID.quest_first_tablet;
  for (const ilvl of [1, 10, 20, 30, 40]) {
    assert.equal(legalAffixCount(base, ilvl), 0);
  }
});

// ---------------------------------------------------------------------------
// 5. degrade — all five 04 §9.5 branches.
// ---------------------------------------------------------------------------

test('ITMS.R11 degrade: unique -> rare with an EXPLICIT empty pool override; the LIVE default at ilvl 20 no longer degrades (ITEM-7 real uniques exist)', () => {
  const base = ITEM_BASES_BY_ID.axe_battle_normal;
  const ilvl = 20;
  // Precondition, asserted rather than assumed: plenty of legal affixes at
  // this (base, ilvl), so an empty-pool cascade stops at 'rare' and does not
  // fall further to 'magic'/'superior'.
  assert.ok(legalAffixCount(base, ilvl) >= 2, 'test precondition: base must support a rare at this ilvl');
  // The branch itself, 04 §9.5's unique -> rare cascade — exercised with an
  // EXPLICIT empty-pool override, not the ambient default. The default
  // stopped being empty the moment ITEM-7's real UniqueDefinition table
  // landed (src/items/roll.js: `let uniquePoolSource = uniquePoolAt;`), so
  // this branch would otherwise go untested by accident of which pool
  // happens to be wired in at the moment this file runs.
  assert.equal(degrade('unique', base, ilvl, () => []), 'rare', 'an explicitly empty pool must still degrade unique -> rare');
  // Pinned, not merely left unasserted: this is exactly the behaviour that
  // changed when ITEM-7 landed. At ilvl 20 the LIVE default pool has 7 of
  // the 8 uniques eligible (reqLevel 12 through 20) — a regression back to
  // an empty default pool must fail this line.
  assert.equal(degrade('unique', base, ilvl), 'unique', 'the shipped default pool is non-empty at ilvl 20 and must NOT degrade a unique');
});

test('ITMS.R12 degrade: unique stays unique when an injected pool is non-empty', () => {
  const base = ITEM_BASES_BY_ID.axe_battle_normal;
  const ilvl = 20;
  const nonEmptyPool = () => [{ id: 'test_only_unique' }];
  assert.equal(degrade('unique', base, ilvl, nonEmptyPool), 'unique');
});

test('ITMS.R13 setUniquePoolSource repoints the default source used when degrade is called with no override, round-tripped in BOTH directions in one test', () => {
  const base = ITEM_BASES_BY_ID.axe_battle_normal;
  const ilvl = 20;
  // Self-contained: sets its own starting state rather than assuming
  // whatever the ambient default happens to be when this test runs, so it
  // can never pass by accident of module ordering (this test IS the test
  // for setUniquePoolSource — it must prove the repoint itself, in both
  // directions, not just observe one side of it).
  setUniquePoolSource(() => []);
  try {
    assert.equal(degrade('unique', base, ilvl), 'rare', 'after setUniquePoolSource(() => []), the forced-empty source must be used');
  } finally {
    // Restore to the REAL shipped default — ITEM-7's uniquePoolAt, not an
    // empty stub — so later tests in this file see the actual production
    // wiring, not a leftover test fixture.
    setUniquePoolSource(uniquePoolAt);
  }
  assert.equal(degrade('unique', base, ilvl), 'unique', 'after setUniquePoolSource(uniquePoolAt), the real pool must be used again — proven in the SAME test as the empty-source case above, not left to the next test to assume');
});

test('ITMS.R14 degrade: rare -> magic when legalAffixCount < 2 (synthetic zero-affix base)', () => {
  // A minimal, non-shipped mock object — not game content, just the pure
  // function's own contract in isolation, matching quality.test.js's
  // fixedRng() pattern for testing rollQuality's ladder math without
  // depending on a real profile's exact numbers. `weapon: {}` is present
  // (like every real category:'weapon' base) so the cascade stops at
  // 'superior' rather than falling through to the jewelry-style
  // superior->normal branch too — that branch is tested separately, on a
  // real ring, in ITMS.R16.
  const noAffixBase = Object.freeze({ id: 'test_no_affix_base', category: 'weapon', allowedAffixGroups: Object.freeze([]), weapon: Object.freeze({}) });
  assert.equal(legalAffixCount(noAffixBase, 20), 0, 'precondition: this mock must have zero legal affixes');
  assert.equal(degrade('rare', noAffixBase, 20), 'superior', 'rare cascades through magic (also < 1) straight to superior');
});

test('ITMS.R15 degrade: magic -> superior when legalAffixCount < 1 (synthetic zero-affix base)', () => {
  const noAffixBase = Object.freeze({ id: 'test_no_affix_base', category: 'weapon', allowedAffixGroups: Object.freeze([]), weapon: Object.freeze({}) });
  assert.equal(degrade('magic', noAffixBase, 20), 'superior');
});

test('ITMS.R16 degrade: superior -> normal on jewelry (nothing on a ring for +5..15% to apply to)', () => {
  const ring = ITEM_BASES_BY_ID.ring_iron;
  assert.equal(ring.weapon, undefined);
  assert.equal(ring.armour, undefined);
  assert.equal(degrade('superior', ring, 20), 'normal');
});

test('ITMS.R17 degrade: superior stays superior on a real weapon or armour base', () => {
  assert.equal(degrade('superior', ITEM_BASES_BY_ID.axe_battle_normal, 20), 'superior');
  assert.equal(degrade('superior', ITEM_BASES_BY_ID.shield_buckler_normal, 20), 'superior');
});

test('ITMS.R18 degrade: normal and magic-with-affixes and rare-with-affixes pass through untouched', () => {
  const base = ITEM_BASES_BY_ID.axe_battle_normal; // plenty of legal affixes at ilvl 20
  assert.equal(degrade('normal', base, 20), 'normal');
  assert.equal(degrade('magic', base, 20), 'magic');
  assert.equal(degrade('rare', base, 20), 'rare');
});

// ---------------------------------------------------------------------------
// 6. rollSuperiorAmount / rollDefenseAmount — D7/D8's own range.
// ---------------------------------------------------------------------------

test('ITMS.R19 rollSuperiorAmount always lands in [5, 15]', () => {
  const rng = new Rng(42);
  for (let i = 0; i < 2000; i++) {
    const v = rollSuperiorAmount(rng);
    assert.ok(Number.isInteger(v) && v >= 5 && v <= 15, `got ${v}`);
  }
});

test('ITMS.R20 rollDefenseAmount always lands in [defMin, defMax]', () => {
  const rng = new Rng(43);
  const base = ITEM_BASES_BY_ID.armour_scale_normal; // defMin 35, defMax 58
  for (let i = 0; i < 2000; i++) {
    const v = rollDefenseAmount(base, rng);
    assert.ok(Number.isInteger(v) && v >= base.armour.defMin && v <= base.armour.defMax, `got ${v}`);
  }
});

// ---------------------------------------------------------------------------
// 7. rollItem — the draw-order proof (12.D08 / this ticket's acceptance
//    criterion 1), via ScriptedRng, plus the full ItemInstance shape.
// ---------------------------------------------------------------------------

test('ITMS.R21 rollItem: draw sequence for a NORMAL ARMOUR item — D3, D4, D5, D8 (no D7)', () => {
  // Script: D3 -> 'chest' (bucket [300,420) of 1000 at ilvl>=27, so 0.35*1000=350);
  //         D4 -> armour_rags (first, lowest-weight candidate in the chest
  //               group, weight 30 of 517 total; 0.01*517=5.17 lands in it);
  //         D5 -> 'normal' (profile-a-style ladder, cumulative top is 0.3805
  //               at ilvl==mlvl/normal/instruction/mf0; 0.9 is past it);
  //         D8 -> any value, armour_rags has an .armour field so this must fire.
  const script = [0.35, 0.01, 0.9, 0.5];
  const rng = new ScriptedRng(script);
  const ilvl = 30, mlvl = 30;
  const item = rollItem(7, ilvl, mlvl, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 4, `expected exactly 4 draws (D3,D4,D5,D8), got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'armour_rags');
  assert.equal(item.rarity, 'normal');
  assert.equal(item.rolls.superior, 0, 'D7 must not fire for a non-superior item');
  assert.ok(item.rolls.defense >= ITEM_BASES_BY_ID.armour_rags.armour.defMin, 'D8 must have fired for an armour base');
  assert.ok(item.rolls.defense <= ITEM_BASES_BY_ID.armour_rags.armour.defMax);

  console.log(`  R21 normal armour tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D8=${script[3]}  (raw log: ${JSON.stringify(rng.log)})`);
});

test('ITMS.R22 rollItem: draw sequence for a SUPERIOR WEAPON item — D3, D4, D5, D7 (no D8)', () => {
  // Script: D3 -> 'weapon' (bucket [0,300); 0.0*1000=0);
  //         D4 -> axe_hand_normal (unarmed is first in the weapon group's
  //               ITEM_BASES order but was excluded from GROUP_BASES —
  //               ITMS.R02 already proves that — so axe_hand_normal, weight
  //               90, is the actual first candidate; 0.0*total lands in it);
  //         D5 -> 'superior' (cumulative band [0.2005, 0.3805); 0.3 lands in it);
  //         D7 -> any value, axe_hand_normal has no .armour field so D8 must not fire.
  const script = [0.0, 0.0, 0.3, 0.5];
  const rng = new ScriptedRng(script);
  const ilvl = 30, mlvl = 30;
  const item = rollItem(11, ilvl, mlvl, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 4, `expected exactly 4 draws (D3,D4,D5,D7), got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'axe_hand_normal');
  assert.equal(item.rarity, 'superior');
  assert.ok(item.rolls.superior >= 5 && item.rolls.superior <= 15, 'D7 must have fired');
  assert.equal(item.rolls.defense, 0, 'D8 must not fire for a weapon (no .armour field)');
  assert.equal(item.rolls.damageMin, ITEM_BASES_BY_ID.axe_hand_normal.weapon.minDamage);
  assert.equal(item.rolls.damageMax, ITEM_BASES_BY_ID.axe_hand_normal.weapon.maxDamage);

  console.log(`  R22 superior weapon tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D7=${script[3]}  (raw log: ${JSON.stringify(rng.log)})`);
});

test('ITMS.R23 rollItem: draw sequence for a JEWELRY item — D3, D4, D5 only (no D7, no D8)', () => {
  // Script: D3 -> 'ring' (bucket [720,810); 0.75*1000=750);
  //         D4 -> ring_iron (first/lowest-reqLevel of the 3 ring bases,
  //               weight 100 of 212 total at ilvl>=22; 0.1*212=21.2 lands in it);
  //         D5 -> 'normal' (same profile as R21, 0.9 is past the 0.3805 top).
  const script = [0.75, 0.1, 0.9];
  const rng = new ScriptedRng(script);
  const ilvl = 30, mlvl = 30;
  const item = rollItem(13, ilvl, mlvl, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 3, `expected exactly 3 draws (D3,D4,D5 — a skipped draw is not consumed), got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'ring_iron');
  assert.equal(item.rarity, 'normal');
  assert.equal(item.rolls.superior, 0);
  assert.equal(item.rolls.defense, 0);
  assert.equal(item.rolls.damageMin, 0);
  assert.equal(item.rolls.damageMax, 0);

  console.log(`  R23 jewelry item tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]}  (raw log: ${JSON.stringify(rng.log)})`);
});

test('ITMS.R24 rollItem: a superior ARMOUR item consumes all five draws — D3,D4,D5,D7,D8', () => {
  // Script: D3 -> 'chest' (0.35); D4 -> armour_rags (0.01); D5 -> 'superior'
  // (0.3, same band as R22); D7 -> superior amount; D8 -> defense amount.
  const script = [0.35, 0.01, 0.3, 0.5, 0.5];
  const rng = new ScriptedRng(script);
  const item = rollItem(17, 30, 30, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 5, `expected exactly 5 draws, got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'armour_rags');
  assert.equal(item.rarity, 'superior');
  assert.ok(item.rolls.superior >= 5 && item.rolls.superior <= 15);
  assert.ok(item.rolls.defense >= ITEM_BASES_BY_ID.armour_rags.armour.defMin);
  assert.ok(item.rolls.defense <= ITEM_BASES_BY_ID.armour_rags.armour.defMax);

  console.log(`  R24 superior armour tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D7=${script[3]} D8=${script[4]}  (raw log: ${JSON.stringify(rng.log)})`);
});

// ITEM-6 extended this ITEM-5 test once already: it was written before
// steps 7-9 existed, so its draw formula only covered D3/D4/D5/D7/D8. Now
// that magic/rare items really roll affixes, the formula grows D9 (1 draw
// for magic's D9a, 2 for rare's D9b+D9c) + one D10 draw per affix that
// actually landed in item.affixes (a pick whose pool was empty consumed no
// draw and left no trace, so `item.affixes.length` — not `nPre+nSuf`, which
// isn't visible from outside rollItem — is the right count) + one D11 draw
// per affix (sharedRoll affixes: 1; everything else: mods.length).
//
// ITEM-7 extends it a second time, for the same underlying reason (a test
// whose expected value was computed from the subset of the pipeline that
// existed on the day it was written, O-27/O-39): the formula never
// accounted for the unique branch, because before ITEM-7 the module-level
// default could never actually produce one. It now can (the default is
// `uniquePoolAt`, not an empty stub), so this statistical sample genuinely
// draws uniques — +1 for D6 when a unique was substituted, and
// +def.mods.length for D12, exactly the arithmetic ITMS.U11
// (tests/items/uniques.test.js) already uses for the same purpose.
//
// ITEM-8 extends it a THIRD time, same root cause — this is now the third
// recorded instance of this exact test needing exactly this repair, which
// is a finding about this test's design (a formula re-derived from "the
// subset of the pipeline that existed on the day it was written"), not
// about any of the three tickets that hit it. D13 (rare naming) adds real
// draws to every rare item, and — unlike D9a (always 1) or D6 (always 1) —
// D13's count is NOT constant: `src/items/names.js`'s ring can force 0, 1,
// 2 or 3 redraws, so a rare item consumes 2, 4, 6 or 8 draws at D13, never
// a fixed number. Hard-coding "+2" would be wrong on every item that hit a
// redraw and would silently pass by accident on every item that didn't.
//
// The fix (matching the "strengthen, never weaken" rule): a `TaggingRng`
// records not just a draw COUNT but every `int(min,max)` call's arguments
// and result, so the actual D13 draws for a given item can be located and
// verified STRUCTURALLY — the tail of that item's draw log, past the
// already-independently-verified D3-D12 count, must be an even-length run
// of alternating `int(0,55)` / `int(0,47)` pairs (2/4/6/8 long, never
// anything else), and the FINAL such pair must equal `item.nameOverride`'s
// own `headIndex`/`tailIndex`. This is read from what the item actually
// did, per item, not asserted as a constant — and it is strictly more
// assertions than before, not fewer: the old test only checked a total;
// this one additionally checks the SHAPE of the extra draws and
// cross-validates them against the stored `nameOverride`.
const AFFIXES_BY_ID = Object.create(null);
for (const a of AFFIXES) AFFIXES_BY_ID[a.id] = a;

/**
 * Wraps a real `Rng`, forwarding every call unchanged (so the sequence of
 * values returned to the caller — and hence the whole simulation — is
 * bit-identical to the unwrapped stream), while also logging every `int()`
 * call's arguments and result. This is `CountingRng` (`src/items/rng.js`)
 * plus per-call shape, needed here (and only here) to locate D13's draws
 * inside a real, unscripted `rollItem` call rather than merely counting
 * them.
 */
class TaggingRng {
  constructor(rng) {
    this._rng = rng;
    this.log = [];
  }
  get draws() {
    return this.log.length;
  }
  u32() {
    const r = this._rng.u32();
    this.log.push({ m: 'u32', args: [], r });
    return r;
  }
  next() {
    const r = this._rng.next();
    this.log.push({ m: 'next', args: [], r });
    return r;
  }
  int(min, max) {
    const r = this._rng.int(min, max);
    this.log.push({ m: 'int', args: [min, max], r });
    return r;
  }
  bool() {
    const r = this._rng.bool();
    this.log.push({ m: 'bool', args: [], r });
    return r;
  }
  range(min, max) {
    const r = this._rng.range(min, max);
    this.log.push({ m: 'range', args: [min, max], r });
    return r;
  }
  pick(array) {
    const r = this._rng.pick(array);
    this.log.push({ m: 'pick', args: [], r });
    return r;
  }
  weighted(a, b) {
    const r = this._rng.weighted(a, b);
    this.log.push({ m: 'weighted', args: [], r });
    return r;
  }
}

test('ITMS.R25 rollItem draw count matches conditionality across many real random items (statistical, not scripted)', () => {
  resetRareRing(); // deterministic regardless of what ran earlier in this file/process
  const rng = new TaggingRng(new Rng(0x51de51de));
  const N = 20000;
  let checkedSuperiorArmour = 0, checkedSuperiorWeapon = 0, checkedNormalArmour = 0, checkedNormalJewelry = 0;
  let checkedMagic = 0, checkedRare = 0, checkedUnique = 0;
  const d13Tally = Object.create(null); // { 2: n, 4: n, 6: n, 8: n } — observed, not assumed
  for (let i = 0; i < N; i++) {
    const ilvl = 1 + (i % 40);
    const before = rng.draws;
    const item = rollItem(i, ilvl, ilvl, 'normal', 'instruction', 0, null, rng);
    const itemLog = rng.log.slice(before);
    const consumed = itemLog.length;
    const base = ITEM_BASES_BY_ID[item.baseId];
    let expectedNonD13 = 3 + (item.rarity === 'superior' ? 1 : 0) + (base.armour ? 1 : 0);
    if (item.rarity === 'magic') expectedNonD13 += 1; // D9a
    if (item.rarity === 'rare') expectedNonD13 += 2; // D9b + D9c
    if (item.rarity === 'unique') {
      const def = UNIQUES_BY_ID[item.uniqueId];
      assert.ok(def, `item ${i}: uniqueId '${item.uniqueId}' must resolve against UNIQUES_BY_ID`);
      expectedNonD13 += 1; // D6 — the unique substitution draw
      expectedNonD13 += def.mods.length; // D12 — one draw per uniqueValues entry
    }
    for (const inst of item.affixes) {
      expectedNonD13 += 1; // D10 — this affix's own successful pick draw
      const def = AFFIXES_BY_ID[inst.id];
      expectedNonD13 += def.sharedRoll ? 1 : def.mods.length; // D11
    }

    // D13 — reconstructed from the tagged log's tail, per item, never
    // hard-coded (see this test's own header comment).
    const d13Log = itemLog.slice(expectedNonD13);
    if (item.rarity === 'rare') {
      assert.ok(
        d13Log.length >= 2 && d13Log.length <= 8 && d13Log.length % 2 === 0,
        `item ${i}: D13 draw count must be 2, 4, 6 or 8, got ${d13Log.length}`,
      );
      for (let p = 0; p < d13Log.length; p += 2) {
        assert.equal(d13Log[p].m, 'int', `item ${i}: D13 draw ${p} must be an int() call`);
        assert.deepEqual(d13Log[p].args, [0, 55], `item ${i}: D13 draw ${p} must be Ui(0,55) (head index)`);
        assert.equal(d13Log[p + 1].m, 'int', `item ${i}: D13 draw ${p + 1} must be an int() call`);
        assert.deepEqual(d13Log[p + 1].args, [0, 47], `item ${i}: D13 draw ${p + 1} must be Ui(0,47) (tail index)`);
      }
      const lastHead = d13Log[d13Log.length - 2].r;
      const lastTail = d13Log[d13Log.length - 1].r;
      assert.ok(item.nameOverride, `item ${i}: a rare item must carry a nameOverride`);
      assert.equal(item.nameOverride.headIndex, lastHead, `item ${i}: nameOverride.headIndex must be the FINAL accepted D13 draw, not an earlier redraw`);
      assert.equal(item.nameOverride.tailIndex, lastTail, `item ${i}: nameOverride.tailIndex must be the FINAL accepted D13 draw`);
      assert.equal(item.nameOverride.code, lastHead * 48 + lastTail, `item ${i}: nameOverride.code must equal headIndex*48+tailIndex`);
      assert.equal(typeof item.nameOverride.en, 'string');
      assert.ok(item.nameOverride.en.length > 0, `item ${i}: nameOverride.en must be non-empty`);
      assert.equal(typeof item.nameOverride.ru, 'string');
      assert.ok(item.nameOverride.ru.length > 0, `item ${i}: nameOverride.ru must be non-empty`);
      d13Tally[d13Log.length] = (d13Tally[d13Log.length] || 0) + 1;
    } else {
      assert.equal(d13Log.length, 0, `item ${i} (rarity=${item.rarity}): a non-rare item must consume ZERO draws at D13`);
      assert.equal(item.nameOverride, null, `item ${i} (rarity=${item.rarity}): nameOverride must stay null`);
    }

    const expected = expectedNonD13 + d13Log.length;
    assert.equal(consumed, expected, `item ${i} (baseId=${item.baseId}, rarity=${item.rarity}, affixes=${item.affixes.length}): expected ${expected} draws, got ${consumed}`);
    if (item.rarity === 'superior' && base.armour) checkedSuperiorArmour++;
    if (item.rarity === 'superior' && base.weapon) checkedSuperiorWeapon++;
    if (item.rarity === 'normal' && base.armour) checkedNormalArmour++;
    if (item.rarity === 'normal' && base.category === 'jewelry') checkedNormalJewelry++;
    if (item.rarity === 'magic') checkedMagic++;
    if (item.rarity === 'unique') checkedUnique++;
    if (item.rarity === 'rare') checkedRare++;
  }
  // Sanity: over 20000 draws at MF 0 (superior baseline 20%), every
  // conditionality branch must actually have been exercised at least once,
  // or this test would be vacuously true.
  assert.ok(checkedSuperiorArmour > 0, 'must have seen at least one superior armour item');
  assert.ok(checkedSuperiorWeapon > 0, 'must have seen at least one superior weapon item');
  assert.ok(checkedNormalArmour > 0, 'must have seen at least one normal armour item');
  assert.ok(checkedNormalJewelry > 0, 'must have seen at least one normal jewelry item');
  assert.ok(checkedMagic > 0, 'must have seen at least one magic item');
  assert.ok(checkedRare > 0, 'must have seen at least one rare item');
  assert.ok(checkedUnique > 0, 'must have seen at least one unique item — otherwise the D6/D12 branch of this formula is untested and this test is green for the wrong reason');
  assert.ok(
    (d13Tally[4] || 0) + (d13Tally[6] || 0) + (d13Tally[8] || 0) > 0,
    'must have seen at least one D13 ring redraw (>2 draws) — otherwise the redraw branch of this formula is untested and this test is green for the wrong reason',
  );
  console.log(`  R25 branch coverage over ${N} items: superiorArmour=${checkedSuperiorArmour} superiorWeapon=${checkedSuperiorWeapon} normalArmour=${checkedNormalArmour} normalJewelry=${checkedNormalJewelry} magic=${checkedMagic} rare=${checkedRare} unique=${checkedUnique}`);
  console.log(`  R25 D13 draw-count distribution over ${checkedRare} rares: ${JSON.stringify(d13Tally)}`);
});

test('ITMS.R26 rollItem: ItemInstance shape matches 01-data-model.md §5.3 step-5 field list exactly', () => {
  const rng = new Rng(9);
  const item = rollItem(1, 20, 20, 'normal', 'instruction', 0, null, rng);
  const expectedKeys = [
    'uid', 'baseId', 'rarity', 'ilvl', 'identified', 'quantity', 'rolls',
    'affixes', 'uniqueId', 'uniqueValues', 'nameOverride', 'durability',
    'maxDurability', 'sockets', 'socketCount',
  ].sort();
  assert.deepEqual(Object.keys(item).sort(), expectedKeys);
  assert.deepEqual(Object.keys(item.rolls).sort(), ['damageMax', 'damageMin', 'defense', 'superior'].sort());
  assert.deepEqual(item.affixes, []);
  assert.equal(item.uniqueId, null);
  assert.deepEqual(item.uniqueValues, []);
  assert.equal(item.nameOverride, null);
  assert.deepEqual(item.sockets, []);
  assert.equal(item.socketCount, 0);
  assert.equal(item.quantity, 1);
  assert.equal(item.uid, 1);
  assert.equal(item.ilvl, 20);
});

test('ITMS.R27 rollItem: identified is false only for rare/unique', () => {
  const rng = new Rng(5);
  // rare, via rarityFloor forced (avoids depending on a rare's own low base
  // odds to land one within a small sample).
  const rareItem = rollItem(1, 20, 20, 'normal', 'instruction', 0, 'rare', rng);
  assert.equal(rareItem.rarity, 'rare');
  assert.equal(rareItem.identified, false);

  const normalItem = rollItem(2, 20, 20, 'normal', 'instruction', 0, null, new ScriptedRng([0.75, 0.1, 0.99]));
  assert.equal(normalItem.rarity, 'normal');
  assert.equal(normalItem.identified, true);

  // 'unique' only reaches step 5 with a non-empty injected pool (see
  // ITMS.R12/R13) — exercised here through the module-level default so the
  // full rollItem pipeline (not just degrade in isolation) is proven for
  // this branch too. Restored in `finally` so later tests are unaffected.
  setUniquePoolSource(() => [{ id: 'test_only_unique' }]);
  try {
    // 0.001 lands rollQuality in the 'unique' bucket of the profile-a-style
    // ladder used throughout this file (cumulative top for unique: 0.0025).
    const uniqueItem = rollItem(3, 20, 20, 'normal', 'instruction', 0, null, new ScriptedRng([0.75, 0.1, 0.001]));
    assert.equal(uniqueItem.rarity, 'unique');
    assert.equal(uniqueItem.identified, false);
  } finally {
    setUniquePoolSource(() => []);
  }
});

// ---------------------------------------------------------------------------
// 8. B1 / B2 — direct assertions of the two lootsim properties this
//    ticket's brief names (tools/lootsim.mjs is TEST-7 and does not exist).
// ---------------------------------------------------------------------------

test('ITMS.R28 B1 — every one of the 61 equipment bases appears at least 40 times in a sweep-like sample', () => {
  const rng = new Rng(0x4c00751);
  const N = 200000;
  const counts = Object.create(null);
  for (const b of ITEM_BASES) {
    if (b.dropWeight > 0 && (b.category === 'weapon' || b.category === 'armour' || b.category === 'jewelry')) {
      counts[b.id] = 0;
    }
  }
  const expectedIds = Object.keys(counts);
  assert.equal(expectedIds.length, 61, 'sanity: 61 equipment bases expected');

  for (let i = 0; i < N; i++) {
    const ilvl = 1 + (i % 40); // "1..40, uniform" per 04 §10.1's sweep profile
    const item = rollItem(i, ilvl, ilvl, 'normal', 'instruction', 0, null, rng);
    counts[item.baseId]++;
  }

  const missing = expectedIds.filter((id) => counts[id] < 40);
  if (missing.length > 0) {
    console.log('  B1 FAIL — bases seen fewer than 40 times:');
    for (const id of missing) console.log(`    ${id}: ${counts[id]}`);
  } else {
    console.log(`  B1 PASS — all 61 equipment bases appeared >= 40 times in ${N} rolls (min observed: ${Math.min(...expectedIds.map((id) => counts[id]))})`);
  }
  assert.deepEqual(missing, [], `bases seen fewer than 40 times: ${JSON.stringify(missing.map((id) => [id, counts[id]]))}`);
});

test('ITMS.R29 B2 — base-group shares at ilvl >= 27 match 04 §1.3 within +-1.0pp (warn-grade, reported either way)', () => {
  // 04 §1.3, transcribed independently of BASE_GROUPS (which is the code
  // under test) so this is a real cross-check, not a tautology.
  const expectedPct = {
    weapon: 30.0, chest: 12.0, helm: 11.0, gloves: 9.5, boots: 9.5,
    ring: 9.0, belt: 8.5, shield: 6.5, amulet: 4.0,
  };
  const rng = new Rng(0x1a2b3c);
  const N = 200000;
  const counts = Object.create(null);
  for (const g of BASE_GROUPS) counts[g.id] = 0;
  for (let i = 0; i < N; i++) {
    const ilvl = 27 + (i % 14); // 27..40 — "ilvl >= 27" per this ticket's brief; by 27 every group is nonempty (04's own "by ilvl 12, all nine groups eligible")
    counts[rollBaseGroup(ilvl, rng)]++;
  }

  console.log('  B2 base-group shares (04 §10.2 grades this warn, not fail):');
  let worstDev = 0;
  for (const g of BASE_GROUPS) {
    const observed = (counts[g.id] / N) * 100;
    const dev = Math.abs(observed - expectedPct[g.id]);
    worstDev = Math.max(worstDev, dev);
    console.log(`    ${g.id.padEnd(8)} expected ${expectedPct[g.id].toFixed(1)}%  observed ${observed.toFixed(3)}%  dev ${dev.toFixed(3)}pp`);
    assert.ok(dev <= 1.0, `group '${g.id}': deviation ${dev.toFixed(3)}pp exceeds the ±1.0pp tolerance`);
  }
  console.log(`  B2 worst deviation: ${worstDev.toFixed(3)}pp (tolerance ±1.0pp)`);
});
