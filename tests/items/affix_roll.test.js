// tests/items/affix_roll.test.js
//
// ITEM-6 acceptance tests for src/items/roll.js's steps 7-9 (04 §9.3): the
// affix-count model (D9a/D9b/D9c), picking (D10, §9.4 rules 3/6 layered on
// top of ITEM-5's legalAffixCount), and value rolling (D11, sharedRoll).
//
// `node:test` + `node:assert/strict` only, matching every sibling test file.
// tools/lootsim.mjs is TEST-7 and does not exist yet — the A3-A8 and R3
// checks below are this ticket's OWN sampling loop, named so TEST-7 can
// subsume them later (same discipline tests/items/roll.test.js's B1/B2
// already established for ITEM-5).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief):
//   1. sharedRoll consumes exactly ONE draw regardless of mods.length, both
//      in isolation (AF01) and inside the real rollItem pipeline (AF02).
//   2. D9a is one draw; D9b/D9c are two INDEPENDENT draws (PROGRESS D-19) —
//      proven with a scripted/tagging Rng recording the literal draw
//      sequence through a real rollItem call, not by reading the source
//      (AF03/AF04), matching the exact ScriptedRng technique
//      tests/items/roll.test.js's own R21-R24 already established and were
//      accepted under.
//   3. One group never appears twice on an item (A3) — zero tolerance.
//   4. The full A3-A8 + R3 assertion set over real rollItem output.
//
// NOT tested here (owned by later M3 tickets): unique substitution (D6/D12,
// ITEM-7), rollDrop itself (ITEM-9), A1/A2 (both need the `sweep` profile's
// ilvl 1-40 span with natural, unfloored rarities — that is TEST-7's
// `tools/lootsim.mjs`, not this ticket's per-file sampling loop). Rule O-27:
// no positive assertion of "nothing else exists yet".
//
// ITEM-8, round 2 update: rare naming (D13) now exists and AF04's item is
// `rarity === 'rare'`, so `rollItem` really draws D13 for it. AF04 was
// repaired (not weakened — see its own comment) to script D13's two draws
// and assert `nameOverride`'s shape; the ring's own redraw/collision
// behaviour is `tests/items/names.test.js`'s job (ITMS.N06-N09), not this
// file's — this file only proves D13 is drawn in the right place, with the
// right shape, inside a real `rollItem` call alongside D9b/D9c/D10/D11.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { CountingRng } from '../../src/items/rng.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { AFFIXES } from '../../src/items/data/affixes.js';
import {
  rollItem,
  rollMagicAffixMode,
  rollAffixCount,
  pickAffix,
  rollMod,
  rollAffixInstance,
} from '../../src/items/roll.js';
// ITEM-8, round 2 — AF04 now rolls a real rare through D13; reset the
// 64-entry ring first so the scripted (collision-free) case is
// deterministic regardless of what ran earlier in this file/process.
import { resetRareRing } from '../../src/items/names.js';

const AFFIXES_BY_ID = Object.create(null);
for (const a of AFFIXES) AFFIXES_BY_ID[a.id] = a;

// Same scripted-Rng technique as tests/items/roll.test.js (ITEM-5, already
// accepted): `next()` pops a pre-programmed value off a queue and logs
// every value handed out; every other Rng method is the real implementation
// inherited unchanged, so this proves the actual call sequence via `.log`,
// not an assumption about it.
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

test('ITMS.AF00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof pickAffix, 'function');
});

// ---------------------------------------------------------------------------
// 1. sharedRoll — the SIX-identical-values-from-ONE-draw proof (criterion 1).
// ---------------------------------------------------------------------------

test('ITMS.AF01 sharedRoll: rollAffixInstance(sfx_res_all_1) consumes exactly ONE draw and produces six equal values', () => {
  const def = AFFIXES_BY_ID.sfx_res_all_1;
  assert.equal(def.sharedRoll, true, 'precondition: sfx_res_all_1 must be sharedRoll');
  assert.equal(def.mods.length, 6, 'precondition: sfx_res_all_1 must ship six mods');

  const counting = new CountingRng(new Rng(0x5e57));
  for (let i = 0; i < 5000; i++) {
    const before = counting.draws;
    const inst = rollAffixInstance(def, counting);
    const consumed = counting.draws - before;
    assert.equal(consumed, 1, `trial ${i}: sharedRoll must consume exactly one draw, got ${consumed}`);
    assert.equal(inst.values.length, 6);
    const v0 = inst.values[0];
    for (const v of inst.values) assert.equal(v, v0, 'all six values must be identical');
    assert.ok(v0 >= 4 && v0 <= 9, `value ${v0} out of sfx_res_all_1's [4,9] range`);
  }
  console.log('  AF01 PASS — 5000 trials, sharedRoll always exactly 1 draw, values always six-of-a-kind');
});

test('ITMS.AF02 sharedRoll inside the real rollItem pipeline: sfx_res_all_1 lands with SIX equal values from a scripted single D11 draw', () => {
  // amulet_cord, ilvl 20: D3=0.97 -> 'amulet' group (bucket [960,1000) of
  // 1000, all nine groups eligible by ilvl 12); D4=0.0 -> amulet_cord (first
  // eligible, weight 100 of 165 at ilvl<=20); D5=0.1 -> 'magic' (band
  // [0.0205,0.1805) at ilvl===mlvl, rank normal, instruction, mf 0); D9a=0.3
  // -> 'suffixOnly' (band [25,50) of 100) so nPre=0, nSuf=1 — no prefix
  // draws at all; D10=0.6 lands sfx_res_all_1 (its cumulative weight window
  // in amulet_cord's eligible-suffix pool at ilvl 20 is (752,778) of 1274
  // total, independently verified against AFFIXES/bases.js at test-authoring
  // time, not re-derived from the code under test); D11=0.5 is the ONE
  // sharedRoll draw for all six mods (range 4-9, step 1: floor(0.5*6)=3 ->
  // 4+3=7).
  const script = [0.97, 0.0, 0.1, 0.3, 0.6, 0.5];
  const rng = new ScriptedRng(script);
  const item = rollItem(1, 20, 20, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 6, `expected exactly 6 draws (D3,D4,D5,D9a,D10,D11), got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'amulet_cord');
  assert.equal(item.rarity, 'magic');
  assert.equal(item.affixes.length, 1);
  assert.equal(item.affixes[0].id, 'sfx_res_all_1');
  assert.equal(item.affixes[0].kind, 'suffix');
  assert.equal(item.affixes[0].values.length, 6);
  const v0 = item.affixes[0].values[0];
  assert.deepEqual(item.affixes[0].values, [v0, v0, v0, v0, v0, v0]);
  assert.equal(v0, 7, 'D11=0.5 against [4,9] step 1 must land exactly 7');

  console.log(`  AF02 tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D9a=${script[3]} D10=${script[4]} D11(shared,x1 draw)=${script[5]}  (raw log: ${JSON.stringify(rng.log)})`);
  console.log(`  AF02 sfx_res_all_1 values from that ONE draw: ${JSON.stringify(item.affixes[0].values)}`);
});

// ---------------------------------------------------------------------------
// 2. D9a one draw / D9b+D9c two independent draws (PROGRESS D-19) — the
//    literal tag sequence through a real rollItem call, magic then rare.
// ---------------------------------------------------------------------------

test('ITMS.AF03 MAGIC item: full draw tag sequence, D9a is exactly one draw, both prefix and suffix picked', () => {
  // axe_hand_normal, ilvl 30 (same D3/D4 script as tests/items/roll.test.js
  // ITMS.R22, already-accepted proof that 0.0/0.0 lands weapon/axe_hand_normal
  // at ilvl 30): D5=0.1 -> 'magic' (band [0.0205,0.1805)); D9a=0.9 -> 'both'
  // (band [50,100) of 100) so nPre=1, nSuf=1; D10(prefix)=0.0 -> the FIRST
  // eligible prefix in AFFIXES order for (axe_hand_normal, ilvl 30), which is
  // pfx_enhanced_damage_3 (verified independently against the live data at
  // test-authoring time — its own alvl<=30<=maxLevel and weapon.any group
  // membership put it first); D10(suffix)=0.0 -> the first eligible suffix,
  // sfx_attack_rating_2; D11(prefix)=0.5 -> enhancedDamage in [30,50] step 1,
  // floor(0.5*21)=10 -> 40; D11(suffix)=0.5 -> attackRating in [12,30] step
  // 1, floor(0.5*19)=9 -> 21.
  const script = [0.0, 0.0, 0.1, 0.9, 0.0, 0.0, 0.5, 0.5];
  const rng = new ScriptedRng(script);
  const item = rollItem(2, 30, 30, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 8, `expected exactly 8 draws (D3,D4,D5,D9a,D10x2,D11x2), got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'axe_hand_normal');
  assert.equal(item.rarity, 'magic');
  assert.equal(item.affixes.length, 2, 'mode=both must pick one prefix and one suffix');
  assert.equal(item.affixes[0].id, 'pfx_enhanced_damage_3');
  assert.equal(item.affixes[0].kind, 'prefix');
  assert.deepEqual(item.affixes[0].values, [40]);
  assert.equal(item.affixes[1].id, 'sfx_attack_rating_2');
  assert.equal(item.affixes[1].kind, 'suffix');
  assert.deepEqual(item.affixes[1].values, [21]);

  console.log(`  AF03 MAGIC tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D9a=${script[3]}(->both, ONE draw) D10pre=${script[4]} D10suf=${script[5]} D11pre=${script[6]} D11suf=${script[7]}  (raw log: ${JSON.stringify(rng.log)})`);
});

test('ITMS.AF04 RARE item: full draw tag sequence, D9b and D9c are two INDEPENDENT draws with different outcomes (PROGRESS D-19)', () => {
  // ITEM-8, round 2: this item is `rarity === 'rare'`, so it now also draws
  // D13 (rare naming, `src/items/names.js`) — this test predates D13 and
  // originally stopped scripting at D11, expecting exactly 11 draws total.
  // The two extra script entries below (head index 20, tail index 15,
  // deliberately distinct from anything used elsewhere in this file) supply
  // D13's `Ui(0,55)` then `Ui(0,47)`; `resetRareRing()` guarantees the ring
  // is empty first so this stays a clean, collision-free (2-draw) case —
  // deterministic and reproducible, not "whatever the ring happened to hold
  // from an earlier test". D13's redraw behaviour under a collision is
  // ITMS.N08's job (tests/items/names.test.js), not this file's.
  //
  // Same base/ilvl as AF03. D5=0.01 -> 'rare' (band [0.0025,0.0205)).
  // legalAffixCount(axe_hand_normal,30) = 31 (>=2), so degrade leaves it
  // rare. D9b=0.1 -> r=10 of total 100 (w1=25,w2=40,w3=35 at ilvl30) -> 1
  // (band [0,25)); D9c=0.5 -> r=50, past w1=25 but inside w1+w2=65 -> 2
  // (band [25,65)). Two SEPARATE draws producing two DIFFERENT counts
  // (1 vs 2) is the direct proof they are independent, not one draw reused.
  // Picks: prefix (nPre=1) then suffix x2 (nSuf=2), all with D10=0.0 (first
  // eligible each time, usedGroups excluding what came before): prefix ->
  // pfx_enhanced_damage_3 (group enhanced_damage); suffix #1 ->
  // sfx_attack_rating_2 (group attack_rating); suffix #2, excluding
  // attack_rating -> sfx_ias_2 (group ias) — all independently verified
  // against the live data at test-authoring time. D11 values: prefix 0.5 ->
  // 40 (as AF03); suffix#1 0.5 -> 21 (as AF03); suffix#2 0.5 ->
  // increasedAttackSpeed in [14,30] step 1, floor(0.5*17)=8 -> 22. D13:
  // 20.5/56 -> int(0,55)=20 (head); 15.5/48 -> int(0,47)=15 (tail).
  resetRareRing();
  const script = [0.0, 0.0, 0.01, 0.1, 0.5, 0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 20.5 / 56, 15.5 / 48];
  const rng = new ScriptedRng(script);
  const item = rollItem(3, 30, 30, 'normal', 'instruction', 0, null, rng);

  assert.equal(rng.log.length, 13, `expected exactly 13 draws (D3,D4,D5,D9b,D9c,D10x3,D11x3,D13x2), got ${rng.log.length}: ${JSON.stringify(rng.log)}`);
  assert.equal(item.baseId, 'axe_hand_normal');
  assert.equal(item.rarity, 'rare');
  assert.equal(item.affixes.length, 3, 'nPre=1 (D9b) + nSuf=2 (D9c) must total 3 picked affixes');
  assert.equal(item.affixes[0].id, 'pfx_enhanced_damage_3');
  assert.equal(item.affixes[0].kind, 'prefix');
  assert.equal(item.affixes[1].id, 'sfx_attack_rating_2');
  assert.equal(item.affixes[2].id, 'sfx_ias_2');
  assert.equal(item.affixes[1].kind, 'suffix');
  assert.equal(item.affixes[2].kind, 'suffix');
  assert.deepEqual(item.affixes[2].values, [22]);
  // Group exclusion (A3), directly on this one item: three distinct groups.
  const groups = item.affixes.map((a) => AFFIXES_BY_ID[a.id].group);
  assert.equal(new Set(groups).size, 3, 'no two of the three picked affixes may share a group');

  // D13 — the scripted, collision-free case: exactly the two draws above,
  // no ring redraw, and `nameOverride` carries the exact indices drawn.
  assert.ok(item.nameOverride, 'a rare item must carry a nameOverride');
  assert.equal(item.nameOverride.headIndex, 20);
  assert.equal(item.nameOverride.tailIndex, 15);
  assert.equal(item.nameOverride.code, 20 * 48 + 15);
  assert.equal(typeof item.nameOverride.en, 'string');
  assert.ok(item.nameOverride.en.length > 0);
  assert.equal(typeof item.nameOverride.ru, 'string');
  assert.ok(item.nameOverride.ru.length > 0);

  console.log(`  AF04 RARE tag sequence: D3=${script[0]} D4=${script[1]} D5=${script[2]} D9b=${script[3]}(->nPre=1) D9c=${script[4]}(->nSuf=2, DIFFERENT from D9b -> independent draws) D10x3=${script.slice(5, 8)} D11x3=${script.slice(8, 11)} D13x2=${script.slice(11, 13)}(->head=20,tail=15, no collision)  (raw log: ${JSON.stringify(rng.log)})`);
});

test('ITMS.AF05 rollMagicAffixMode / rollAffixCount are each exactly one draw, in isolation, over many trials', () => {
  const counting = new CountingRng(new Rng(0xa11a));
  for (let i = 0; i < 5000; i++) {
    const before = counting.draws;
    const mode = rollMagicAffixMode(counting);
    assert.equal(counting.draws - before, 1, 'rollMagicAffixMode (D9a) must consume exactly one draw');
    assert.ok(mode === 'prefixOnly' || mode === 'suffixOnly' || mode === 'both', `unexpected mode '${mode}'`);
  }
  for (let ilvl = 1; ilvl <= 40; ilvl++) {
    for (let i = 0; i < 200; i++) {
      const before = counting.draws;
      const n = rollAffixCount(ilvl, counting);
      assert.equal(counting.draws - before, 1, 'rollAffixCount (D9b/D9c) must consume exactly one draw');
      assert.ok(n === 1 || n === 2 || n === 3, `unexpected count ${n} at ilvl ${ilvl}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. A3-A8 — direct sampling assertions over real rollItem output.
//    rarityFloor: 'rare' forces every roll to at least 'rare' (degrade may
//    still pull an affix-poor (base,ilvl) back down to 'magic'/'superior'/
//    'normal' — that is correct §9.5 behaviour, not suppressed here) so the
//    sample is affix-dense enough to actually exercise A3-A8, not just
//    trivially pass on empty affixes[] arrays.
// ---------------------------------------------------------------------------

test('ITMS.AF06 A3-A8 over 200000 rarity-floored rolls: group exclusion, alvl/maxLevel gates, values shape, value range+lattice, sharedRoll equality — all zero violations', () => {
  const rng = new Rng(0x0405ffff);
  const N = 200000;
  let a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0, a8 = 0;
  let totalAffixInstances = 0;
  let itemsWithAffixes = 0;

  for (let i = 0; i < N; i++) {
    const ilvl = 1 + (i % 40);
    const item = rollItem(i, ilvl, ilvl, 'normal', 'instruction', 0, 'rare', rng);
    if (item.affixes.length === 0) continue;
    itemsWithAffixes++;

    const seenGroups = new Set();
    for (const inst of item.affixes) {
      totalAffixInstances++;
      const def = AFFIXES_BY_ID[inst.id];
      assert.ok(def, `unknown affix id '${inst.id}' rolled onto item ${i}`);

      // A3 — group exclusion.
      if (seenGroups.has(def.group)) a3++;
      seenGroups.add(def.group);

      // A4 — alvl gate.
      if (def.alvl > item.ilvl) a4++;

      // A5 — maxLevel gate.
      if (def.maxLevel < item.ilvl) a5++;

      // A6 — values.length === mods.length.
      if (inst.values.length !== def.mods.length) a6++;

      // A7 — every value inside [min,max] and on the step lattice.
      for (let k = 0; k < def.mods.length; k++) {
        const m = def.mods[k];
        const v = inst.values[k];
        const step = m.step === undefined ? 1 : m.step;
        const inRange = v >= m.min - 1e-9 && v <= m.max + 1e-9;
        const onLattice = Math.abs((v - m.min) / step - Math.round((v - m.min) / step)) < 1e-6;
        if (!inRange || !onLattice) a7++;
      }

      // A8 — sharedRoll affixes have all values equal.
      if (def.sharedRoll) {
        const v0 = inst.values[0];
        for (const v of inst.values) if (v !== v0) { a8++; break; }
      }
    }
  }

  console.log(`  AF06 sampled ${N} items, ${itemsWithAffixes} with >=1 affix, ${totalAffixInstances} AffixInstances total`);
  console.log(`  AF06 A3=${a3} A4=${a4} A5=${a5} A6=${a6} A7=${a7} A8=${a8} (all must be 0)`);
  assert.ok(totalAffixInstances > 100000, `sanity: expected a large affix sample, got ${totalAffixInstances}`);
  assert.equal(a3, 0, 'A3 group exclusion violated');
  assert.equal(a4, 0, 'A4 alvl gate violated');
  assert.equal(a5, 0, 'A5 maxLevel gate violated');
  assert.equal(a6, 0, 'A6 values.length !== mods.length');
  assert.equal(a7, 0, 'A7 value out of range or off the step lattice');
  assert.equal(a8, 0, 'A8 sharedRoll values not all equal');
});

// ---------------------------------------------------------------------------
// 4. R3 — the 04 §9.6 count-model histogram, at ilvl 20, 1,000,000 samples.
//    Sampled directly off rollAffixCount (the count MODEL itself, per §9.6's
//    own framing: a property of the weight formula alone) rather than off
//    rollItem's item.affixes.length, which would additionally depend on
//    pool availability at whatever base got drawn — a confound R3 is not
//    about.
// ---------------------------------------------------------------------------

test('ITMS.R3 affix-count histogram at ilvl 20 matches 04 §9.6 within +-1.0pp per bucket, 1000000 samples', () => {
  const rng = new Rng(0x9600);
  const N = 1000000;
  const counts = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let i = 0; i < N; i++) {
    const nPre = rollAffixCount(20, rng); // D9b
    const nSuf = rollAffixCount(20, rng); // D9c
    counts[nPre + nSuf]++;
  }
  const expectedPct = { 2: 11.56, 3: 25.84, 4: 33.48, 5: 21.28, 6: 7.84 };
  console.log('  R3 04 §9.6 histogram at ilvl 20 (1,000,000 samples):');
  let worstDev = 0;
  for (const bucket of [2, 3, 4, 5, 6]) {
    const observed = (counts[bucket] / N) * 100;
    const dev = Math.abs(observed - expectedPct[bucket]);
    worstDev = Math.max(worstDev, dev);
    console.log(`    total=${bucket}  expected ${expectedPct[bucket].toFixed(2)}%  observed ${observed.toFixed(3)}%  dev ${dev.toFixed(3)}pp`);
    assert.ok(dev <= 1.0, `bucket ${bucket}: deviation ${dev.toFixed(3)}pp exceeds the +-1.0pp R3 tolerance`);
  }
  console.log(`  R3 worst deviation: ${worstDev.toFixed(3)}pp (tolerance +-1.0pp)`);
});

// ---------------------------------------------------------------------------
// 5. pickAffix's own contract: zero draws on an empty pool, one draw when
//    non-empty, and it honours usedGroups (rule 6) on top of legalAffixCount's
//    rules 1/2/4/5 (rule 3 is the `kind` argument itself).
// ---------------------------------------------------------------------------

test('ITMS.AF07 pickAffix consumes zero draws when the filtered pool is empty (rule 3/6 can empty it even when legalAffixCount is nonzero)', () => {
  // quest_first_tablet has no allowedAffixGroups at all (ITMS.R10's own
  // precondition) — every rule-5 intersection fails, so both kind pools are
  // empty at any ilvl.
  const base = ITEM_BASES_BY_ID.quest_first_tablet;
  const counting = new CountingRng(new Rng(7));
  const before = counting.draws;
  const pre = pickAffix('prefix', base, 20, [], counting);
  const suf = pickAffix('suffix', base, 20, [], counting);
  assert.equal(pre, null);
  assert.equal(suf, null);
  assert.equal(counting.draws - before, 0, 'a pick against an empty pool must not consume a draw');
});

test('ITMS.AF08 pickAffix excludes an already-used group (rule 6) even when the affix would otherwise be legal', () => {
  const base = ITEM_BASES_BY_ID.axe_hand_normal;
  const rng = new Rng(11);
  const first = pickAffix('prefix', base, 30, [], rng);
  assert.ok(first, 'precondition: at least one legal prefix must exist');
  // Force the same group to be excluded on the next pick and confirm the
  // same affix (or any affix sharing its group) never comes back.
  for (let i = 0; i < 500; i++) {
    const next = pickAffix('prefix', base, 30, [first.group], new Rng(100 + i));
    if (next) assert.notEqual(next.group, first.group, `pick must never return the excluded group '${first.group}'`);
  }
});

test('ITMS.AF09 rollMod: every draw lands in [min,max] and on the step lattice, including sfx_life_regen_1\'s documented quirk (2.6 never drops)', () => {
  const rng = new Rng(2626);
  const lifeRegenMod = AFFIXES_BY_ID.sfx_life_regen_1.mods[0]; // {min:0.4,max:2.6,step:1}
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rollMod(lifeRegenMod, rng);
    seen.add(Math.round(v * 10) / 10);
    assert.ok(v >= 0.4 && v <= 2.6, `${v} out of [0.4,2.6]`);
  }
  const sorted = [...seen].sort((a, b) => a - b);
  assert.deepEqual(sorted, [0.4, 1.4, 2.4], 'documented quirk: only these three values are reachable, 2.6 never drops');

  const resonanceMod = AFFIXES_BY_ID.sfx_resonance_1.mods[0]; // {min:0.2,max:0.8,step:0.1}
  const seenRes = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rollMod(resonanceMod, rng);
    seenRes.add(Math.round(v * 10) / 10);
    assert.ok(v >= 0.2 - 1e-9 && v <= 0.8 + 1e-9, `${v} out of [0.2,0.8]`);
  }
  assert.deepEqual([...seenRes].sort((a, b) => a - b), [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  console.log(`  AF09 sfx_life_regen_1 reachable values: ${JSON.stringify(sorted)} (2.6 excluded, as documented)`);
  console.log(`  AF09 sfx_resonance_1 reachable values: ${JSON.stringify([...seenRes].sort((a, b) => a - b))}`);
});
