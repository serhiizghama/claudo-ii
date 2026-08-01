// tests/items/uniques.test.js
//
// ITEM-7 acceptance tests for src/items/data/uniques.js and the D6/D12 gaps
// filled in src/items/roll.js. `node:test` + `node:assert/strict` only,
// matching every sibling test file (tests/items/roll.test.js,
// tests/items/affix_roll.test.js, ...).
//
// THIS FILE'S ACCEPTANCE GATE (ITEM-7's brief):
//   1. Exactly 8 UniqueDefinition records, matching 04 §6.1's table and
//      §6.2-§6.9's mod tables value for value.
//   2. D6 substitution: quality 'unique' + non-empty alvl<=ilvl pool draws
//      one unique W(dropWeight) and substitutes item.baseId.
//   3. ilvl 11 never produces a unique (lowest alvl/reqLevel is 12).
//   4. All 8 appear >= 30 times in a high-ilvl, high-MF sample (tools/
//      lootsim.mjs is TEST-7 and does not exist yet; this is this ticket's
//      own sampling loop, named so TEST-7 can absorb it later, matching the
//      ITEM-5/ITEM-6 B1/B2/A-set precedent).
//   5. D12: one draw per mods entry, array order, proven with a
//      draw-tagging Rng (ScriptedRng's `.log`), not inferred from a total.
//   6. rolledMods is this file's sibling, tests/items/mods.test.js.
//
// NOT tested here: rolledMods (mods.test.js/mods.perf.test.js), rare naming
// (ITEM-8), rollDrop (ITEM-9). Rule O-27: only ITEM-7's own contract is
// asserted, never "the 8 uniques are the only content" or similar.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { CountingRng } from '../../src/items/rng.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { UNIQUES, UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
import {
  degrade,
  legalAffixCount,
  setUniquePoolSource,
  uniquePoolAt,
  pickUnique,
  rollItem,
} from '../../src/items/roll.js';

// Same "scripted, tag-logging" Rng as tests/items/roll.test.js /
// affix_roll.test.js: next() pops a pre-programmed value off a queue and
// logs every value handed out; every other method is the real Rng,
// inherited unchanged — proves the actual call sequence via `.log`.
class ScriptedRng extends Rng {
  constructor(script) {
    super(1);
    this._script = script.slice();
    this.log = [];
  }
  next() {
    const v = this._script.length ? this._script.shift() : 0.999999;
    this.log.push(v);
    return v;
  }
}

test('ITMS.U00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof UNIQUES, 'object');
});

// ---------------------------------------------------------------------------
// 1. UNIQUES — exactly 8, 04 §6.1's table transcribed independently.
// ---------------------------------------------------------------------------

test('ITMS.U01 exactly 8 UniqueDefinition records, matching 04 §6.1 verbatim, in table order', () => {
  const expected = [
    ['verens_reckoning', "Veren's Reckoning", 'axe_battle_normal', 12, 10],
    ['ashen_crown', 'Ashen Crown', 'helm_coif_normal', 14, 4],
    ['long_way_back', 'The Long Way Back', 'boots_march_exceptional', 16, 8],
    ['stonecutters_grasp', "Stonecutter's Grasp", 'gloves_gauntlets_exceptional', 17, 9],
    ['kairas_ledger', "Kaira's Ledger", 'belt_plated_exceptional', 18, 9],
    ['bonereach_vestment', 'Bonereach Vestment', 'armour_plated_exceptional', 19, 7],
    ['unfinished_sentence', 'The Unfinished Sentence', 'sword_sigil_exceptional', 20, 5],
    ['last_syllable', 'The Last Syllable', 'amulet_seal', 25, 4],
  ];
  assert.equal(UNIQUES.length, 8, 'must ship exactly 8 uniques — PROGRESS D-26, do not "complete the set"');
  for (let i = 0; i < expected.length; i++) {
    const [id, name, baseId, reqLevel, dropWeight] = expected[i];
    const u = UNIQUES[i];
    assert.equal(u.id, id, `row ${i} id`);
    assert.equal(u.name, name, `row ${i} name`);
    assert.equal(u.baseId, baseId, `row ${i} baseId`);
    assert.equal(u.reqLevel, reqLevel, `row ${i} reqLevel (== 04 §6's alvl for every one of the 8 rows)`);
    assert.equal(u.dropWeight, dropWeight, `row ${i} dropWeight`);
    assert.ok(ITEM_BASES_BY_ID[u.baseId], `${id}: baseId '${u.baseId}' must resolve to a real ItemBase`);
  }
  const ids = new Set(UNIQUES.map((u) => u.id));
  assert.equal(ids.size, 8, 'no duplicate ids');
  // 04 §6.10 / §14.1 D-11 — no ring or shield unique.
  for (const u of UNIQUES) {
    const base = ITEM_BASES_BY_ID[u.baseId];
    assert.notEqual(base.slot, 'ring1', `${u.id} must not bind to a ring base`);
    assert.notEqual(base.slot, 'offHand', `${u.id} must not bind to a shield/off-hand base`);
  }
});

test('ITMS.U02 every unique mod table matches 04 §6.2-§6.9 value for value, in array order', () => {
  const expectedMods = {
    verens_reckoning: [
      ['enhancedDamage', 80, 110], ['minDamage', 6, 10], ['maxDamage', 14, 20],
      ['increasedAttackSpeed', 15, 20], ['lifeSteal', 5, 8], ['rageOnHit', 3, 5],
      ['critChance', 8, 14],
    ],
    ashen_crown: [
      ['manaCostReduction', 20, 25], ['lifePercent', -45, -35], ['fireResist', 15, 25],
      ['skillBonuses.tree', 2, 2], ['fasterCastRate', 15, 20],
    ],
    long_way_back: [
      ['movementSpeed', 30, 40], ['dodgeChance', 8, 12], ['ccReduction', 20, 30],
      ['maxStamina', 40, 60], ['cannotBeFrozen', 1, 1],
    ],
    stonecutters_grasp: [
      ['increasedAttackSpeed', 20, 30], ['minDamage', 4, 8], ['maxDamage', 9, 15],
      ['critChance', 8, 12], ['strength', 10, 15], ['thorns', 20, 35],
    ],
    kairas_ledger: [
      ['maxLife', 25, 40], ['fasterHitRecovery', 30, 45], ['damageReducePercent', 5, 8],
      ['magicFind', 20, 30], ['requirementReduction', 15, 20],
    ],
    bonereach_vestment: [
      ['defensePercent', 90, 130], ['maxLife', 40, 60], ['damageReduceFlat', 4, 7],
      ['fireResist', 12, 18], ['coldResist', 12, 18], ['lightResist', 12, 18],
      ['movementSpeed', -10, -10],
    ],
    unfinished_sentence: [
      ['enhancedDamage', 60, 85], ['manaPercent', -60, -45], ['manaReturnPercent', 14, 20],
      ['maxResonance', 2, 2], ['resonanceOnHit', 1, 1], ['fasterCastRate', 15, 25],
    ],
    last_syllable: [
      ['skillBonuses.all', 2, 2], ['physicalDamagePercent', -100, -100], ['magicMin', 20, 30],
      ['magicMax', 45, 65], ['elementalDamagePercent', 40, 60], ['manaRegenPercent', 8, 12],
    ],
  };
  assert.equal(Object.keys(expectedMods).length, 8, 'sanity: one expectation row per unique');
  for (const [id, mods] of Object.entries(expectedMods)) {
    const u = UNIQUES_BY_ID[id];
    assert.ok(u, `${id} must exist in UNIQUES_BY_ID`);
    assert.equal(u.mods.length, mods.length, `${id}: mod count`);
    for (let i = 0; i < mods.length; i++) {
      const [stat, min, max] = mods[i];
      assert.equal(u.mods[i].stat, stat, `${id}.mods[${i}].stat`);
      assert.equal(u.mods[i].min, min, `${id}.mods[${i}].min`);
      assert.equal(u.mods[i].max, max, `${id}.mods[${i}].max`);
    }
  }
});

test('ITMS.U03 ashen_crown carries 5 mods (04 §14.1 D-4), and skillBonuses.tree is fixed to the flame tree', () => {
  const u = UNIQUES_BY_ID.ashen_crown;
  assert.equal(u.mods.length, 5);
  const treeMod = u.mods.find((m) => m.stat === 'skillBonuses.tree');
  assert.ok(treeMod, 'ashen_crown must carry a skillBonuses.tree mod');
  assert.equal(treeMod.tree, 'flame', "D-4's +2 to Flame Skills must be fixed to the flame tree, not a random one");
});

// ---------------------------------------------------------------------------
// 2. uniquePoolAt / pickUnique — the D6 pool filter and weighted draw.
// ---------------------------------------------------------------------------

test('ITMS.U04 uniquePoolAt filters by reqLevel <= ilvl and ignores the base argument', () => {
  assert.deepEqual(uniquePoolAt(null, 11), [], 'ilvl 11 is below every reqLevel (lowest is 12)');
  const at12 = uniquePoolAt(null, 12);
  assert.equal(at12.length, 1);
  assert.equal(at12[0].id, 'verens_reckoning');
  const at14 = uniquePoolAt(ITEM_BASES_BY_ID.axe_battle_normal, 14);
  assert.equal(at14.length, 2, 'verens_reckoning (12) + ashen_crown (14)');
  const at24 = uniquePoolAt(null, 24);
  assert.equal(at24.length, 7, 'every unique except last_syllable (25)');
  const at25 = uniquePoolAt(null, 25);
  assert.equal(at25.length, 8, 'all 8 eligible by ilvl 25');
  // base argument must be inert — 04 §6/§9.2 never conditions the pool on it.
  assert.deepEqual(uniquePoolAt(ITEM_BASES_BY_ID.helm_coif_normal, 20), uniquePoolAt(ITEM_BASES_BY_ID.amulet_seal, 20));
});

test('ITMS.U05 pickUnique performs a two-pass W(dropWeight) scan: every eligible unique is reachable, one draw each', () => {
  const ilvl = 24; // 7 uniques eligible (all but last_syllable)
  const eligible = UNIQUES.filter((u) => u.reqLevel <= ilvl);
  assert.equal(eligible.length, 7);
  const total = eligible.reduce((s, u) => s + u.dropWeight, 0);
  let cum = 0;
  for (const u of eligible) {
    const mid = cum + u.dropWeight / 2;
    const rng = new ScriptedRng([mid / total]);
    const picked = pickUnique(ilvl, rng);
    assert.equal(picked && picked.id, u.id, `midpoint of ${u.id}'s weight band must land on ${u.id}`);
    assert.equal(rng.log.length, 1, 'pickUnique must consume exactly one draw (D6)');
    cum += u.dropWeight;
  }
  assert.ok(Math.abs(cum - total) < 1e-9, 'sanity: cumulative weight must equal total');
});

test('ITMS.U06 pickUnique returns null and consumes NO draw when the pool is empty (04:1881, a skipped draw is not consumed)', () => {
  const rng = new ScriptedRng([0.5]);
  const result = pickUnique(11, rng);
  assert.equal(result, null);
  assert.equal(rng.log.length, 0, 'an empty-pool D6 must not draw');
});

// ---------------------------------------------------------------------------
// 3. degrade — the unique -> rare branch against the REAL pool (uniquePoolAt),
//    via the per-call override so no module state is touched.
// ---------------------------------------------------------------------------

test('ITMS.U07 degrade: unique -> rare at ilvl 11 with the real pool (below every reqLevel) — acceptance clause 3', () => {
  const base = ITEM_BASES_BY_ID.axe_battle_normal;
  assert.ok(legalAffixCount(base, 11) >= 2, 'precondition: base must support a rare at this ilvl');
  assert.equal(degrade('unique', base, 11, uniquePoolAt), 'rare');
});

test('ITMS.U08 degrade: unique stays unique from ilvl 12 (verens_reckoning newly eligible) through 25 (all 8) with the real pool', () => {
  const base = ITEM_BASES_BY_ID.axe_battle_normal;
  for (const ilvl of [12, 14, 17, 20, 24, 25, 30]) {
    assert.equal(degrade('unique', base, ilvl, uniquePoolAt), 'unique', `ilvl ${ilvl}`);
  }
});

// ---------------------------------------------------------------------------
// 4. rollItem — D6 substitution + D12 positional roll, full pipeline, via
//    setUniquePoolSource (rollItem's step 4 has no per-call override, so the
//    real wiring is exercised through the module-level hook, restored in
//    `finally` per the ITEM-5-established R13/R27 precedent).
// ---------------------------------------------------------------------------

function refRollMod(m, u) {
  const step = m.step === undefined ? 1 : m.step;
  const steps = Math.floor((m.max - m.min) / step + 1e-9);
  const idx = Math.floor(u * (steps + 1));
  return m.min + step * idx;
}

test('ITMS.U09 rollItem: full D3-D6+D12 scripted sequence for a UNIQUE — substitution (D-3) and positional uniqueValues (D12)', () => {
  setUniquePoolSource(uniquePoolAt);
  try {
    const ilvl = 20, mlvl = 20;
    // D3=0.75 -> 'ring' group, D4=0.1 -> some ring base (irrelevant, gets
    // substituted); D5=0.001 -> 'unique' bucket (same fraction/params R27
    // already established land 'unique' at delta=0, mf=0, rank='normal',
    // difficulty='instruction'); D6=0.0 -> first eligible entry in UNIQUES
    // array order at ilvl 20 (verens_reckoning, weight band [0,10) of the
    // 52 total across the 7 uniques eligible at this ilvl); then one D12
    // draw per verens_reckoning's 7 mods, array order.
    const d12 = [0.0, 0.999999, 0.5, 0.25, 0.75, 0.1, 0.9];
    const script = [0.75, 0.1, 0.001, 0.0, ...d12];
    const rng = new ScriptedRng(script);
    const item = rollItem(9001, ilvl, mlvl, 'normal', 'instruction', 0, null, rng);

    assert.equal(rng.log.length, script.length, `expected exactly ${script.length} draws, got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
    assert.equal(item.rarity, 'unique');
    assert.equal(item.identified, false, 'uniques drop unidentified');
    assert.equal(item.uniqueId, 'verens_reckoning');
    assert.equal(item.baseId, 'axe_battle_normal', 'D-3: baseId must be substituted for the unique\'s own base');
    assert.deepEqual(item.affixes, [], 'uniques carry no AffixInstance');

    const def = UNIQUES_BY_ID.verens_reckoning;
    assert.equal(item.uniqueValues.length, def.mods.length);
    for (let i = 0; i < def.mods.length; i++) {
      const expected = refRollMod(def.mods[i], d12[i]);
      assert.equal(item.uniqueValues[i], expected, `uniqueValues[${i}] (stat ${def.mods[i].stat}) from D12 fraction ${d12[i]}`);
    }
    console.log(`  U09 tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D6=${script[3]} D12x7=${JSON.stringify(d12)}  uniqueValues=${JSON.stringify(item.uniqueValues)}`);
  } finally {
    setUniquePoolSource(() => []);
  }
});

test('ITMS.U10 rollItem: D6 is skipped (not consumed) once degrade already left the item non-unique at ilvl 11', () => {
  setUniquePoolSource(uniquePoolAt);
  try {
    const ilvl = 11, mlvl = 11;
    // Same D3/D4/D5 prefix and params as U09 (delta=0 so the same fraction
    // 0.001 lands the same 'unique' bucket) — but at ilvl 11 the pool is
    // empty, so degrade() downgrades to 'rare' before step 4, and step 4's
    // own `if (rarity === 'unique')` guard means pickUnique is never called
    // — no fourth draw, whatever legalAffixCount-driven cascade follows.
    const script = [0.75, 0.1, 0.001];
    const rng = new ScriptedRng(script);
    const item = rollItem(9002, ilvl, mlvl, 'normal', 'instruction', 0, null, rng);
    assert.notEqual(item.rarity, 'unique', 'ilvl 11 must never produce a unique');
    assert.equal(item.uniqueId, null);
    assert.deepEqual(item.uniqueValues, []);
  } finally {
    setUniquePoolSource(() => []);
  }
});

test('ITMS.U11 rollItem: statistical proof over many random items — the unique branch\'s draw count matches D6+D8?+D12 exactly, and ilvl < 12 never yields a unique (acceptance clause 3)', () => {
  // Non-unique branches (D9/D10/D11's exact accounting) are ITMS.R25's own
  // contract (tests/items/roll.test.js, ITEM-6) — not re-derived here, to
  // avoid duplicating/drifting from that ticket's formula. This test proves
  // its OWN ticket's addition: D6 (+ D8, which fires unconditionally on
  // `base.armour` regardless of rarity — a unique substituted onto an
  // armour base, e.g. ashen_crown -> helm_coif_normal, still rolls
  // rolls.defense) and D12.
  setUniquePoolSource(uniquePoolAt);
  try {
    const counting = new CountingRng(new Rng(0x7ea7ea));
    const N = 40000;
    let seenUnique = 0, seenBelow12 = 0;
    for (let i = 0; i < N; i++) {
      const ilvl = 1 + (i % 40); // covers below-12 and above-25 both
      const before = counting.draws;
      const item = rollItem(i, ilvl, ilvl, 'normal', 'instruction', 0, null, counting);
      const consumed = counting.draws - before;
      if (ilvl < 12) {
        seenBelow12++;
        assert.notEqual(item.rarity, 'unique', `ilvl ${ilvl} < 12 must never yield a unique (item ${i})`);
      }
      if (item.rarity === 'unique') {
        seenUnique++;
        const base = ITEM_BASES_BY_ID[item.baseId];
        const def = UNIQUES_BY_ID[item.uniqueId];
        assert.ok(def, `item ${i}: uniqueId '${item.uniqueId}' must resolve`);
        let expectedDraws = 3 + 1 + def.mods.length; // D3, D4, D5, D6, D12*mods
        if (base.armour) expectedDraws += 1; // D8 — unconditional on the substituted base
        assert.equal(consumed, expectedDraws, `item ${i} (ilvl=${ilvl}, uniqueId=${item.uniqueId}, baseId=${item.baseId}): expected ${expectedDraws} draws, got ${consumed}`);
        assert.equal(item.affixes.length, 0, 'a unique carries no AffixInstance');
        assert.equal(item.uniqueValues.length, def.mods.length);
      }
    }
    assert.ok(seenBelow12 > 0, 'sanity: must have sampled at least one ilvl < 12 item');
    assert.ok(seenUnique > 0, 'sanity: must have sampled at least one unique to exercise the D6+D12 branch');
    console.log(`  U11 over ${N} items: below-ilvl-12=${seenBelow12} unique=${seenUnique}`);
  } finally {
    setUniquePoolSource(() => []);
  }
});

// ---------------------------------------------------------------------------
// 5. Sweep — all 8 uniques reachable, >= 30 times each (acceptance clause 4).
//    Named so TEST-7's tools/lootsim.mjs can absorb it, per this ticket's
//    brief precedent (ITEM-5's B1/B2, ITEM-6's A3-A8/R3).
// ---------------------------------------------------------------------------

test('ITMS.U12 sweep — all 8 uniques appear >= 30 times at high ilvl / high magic find, and every substitution is correct', () => {
  setUniquePoolSource(uniquePoolAt);
  try {
    const rng = new Rng(0xba5eba11);
    const N = 200000;
    const counts = Object.create(null);
    for (const u of UNIQUES) counts[u.id] = 0;
    for (let i = 0; i < N; i++) {
      // ilvl 25-40 (all 8 eligible), high delta, boss rank, renunciation,
      // heavy MF: pushes P(unique) well above its 0.25% floor so the least
      // -weighted unique (weight 4 of 56 at full pool) is seen thousands of
      // times, not merely 30, at this sample size.
      const ilvl = 25 + (i % 16);
      const mlvl = Math.max(1, ilvl - 8);
      const item = rollItem(i, ilvl, mlvl, 'boss', 'renunciation', 500, null, rng);
      if (item.uniqueId) {
        counts[item.uniqueId]++;
        assert.equal(item.baseId, UNIQUES_BY_ID[item.uniqueId].baseId, `item ${i}: substituted baseId must match ${item.uniqueId}'s own base`);
        assert.equal(item.identified, false);
        assert.deepEqual(item.affixes, []);
      }
    }
    const missing = UNIQUES.map((u) => u.id).filter((id) => counts[id] < 30);
    console.log(`  U12 sweep counts: ${JSON.stringify(counts)}`);
    assert.deepEqual(missing, [], `uniques seen fewer than 30 times: ${JSON.stringify(missing.map((id) => [id, counts[id]]))}`);
  } finally {
    setUniquePoolSource(() => []);
  }
});
