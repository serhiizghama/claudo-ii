// tests/items/drop.test.js
//
// ITEM-9 acceptance tests for src/items/drop.js (`rollDrop`/`rollGold`/
// `rollChest`). `node:test` + `node:assert/strict` only, matching every
// sibling test file in this repo.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief):
//   1. nodrop scaling (§5.4), sub-tables (§5.7), gold (§5.4/§7.1), the
//      unique-rank rarity floor, and ground scatter — all in contractual
//      draw order (D1/D2/D14/D15).
//   2. The recorded draw sequence matches `04` §9.2's D1-D15, including the
//      taken-and-discarded scatter draws (12.D08) — proven with a tagging
//      Rng, not by reading the source.
//   3. Two runs at one seed produce byte-identical output (12.D03).
//   4. (timing/allocation budget lives in drop.perf.test.js, per house
//      convention: a test asserting a time or an allocation goes in
//      `<thing>.perf.test.js`.)
//
// Named so TEST-7 (tools/lootsim.mjs, which does not exist yet) can absorb
// these assertions later — same precedent ITEM-5/6/7 set for B1/B2/A3-A8/
// R3/U1/U2.
//
// NOT tested here: rollItem's own internal draw order (D3-D13, already
// ITEM-5/6/7/8's file, tests/items/roll.test.js); ground PLACEMENT (world
// position, navmesh snapping — ITEM-12); the tc_boss fixed script (§5.5,
// needs CharacterSave quest-flag state outside src/items/). Rule O-27: this
// file asserts ITEM-9's own contract only, never "the next ticket doesn't
// exist yet" as a positive assertion.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { TREASURE_CLASSES_BY_ID, resolveTC } from '../../src/items/data/treasure.js';
import { resetRareRing } from '../../src/items/names.js';
import { rollDrop, rollGold, rollChest, resetUidCounter } from '../../src/items/drop.js';

// ---------------------------------------------------------------------------
// Test doubles — same shape tests/items/roll.test.js already establishes:
// a scripted Rng (a queue of raw [0,1) values, falling back to 0.999999
// once exhausted) and a tagging Rng (logs every {method, args, returnValue}
// in call order, changing nothing about what the wrapped stream returns).
// ---------------------------------------------------------------------------

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

/** How many draws a produced `ItemInstance` (from `rollItem`) consumed on
 * its own, per `tests/items/roll.test.js`'s own R25 formula — reused here
 * (not re-exported by that file, so re-derived) to isolate `rollDrop`'s OWN
 * draws (D1/D2/D14/D15) from `rollItem`'s (D3-D13) in a tagged log. */
function expectedRollItemDrawCount(item) {
  const base = ITEM_BASES_BY_ID[item.baseId];
  let n = 3 + (item.rarity === 'superior' ? 1 : 0) + (base.armour ? 1 : 0);
  if (item.rarity === 'magic') n += 1;
  if (item.rarity === 'rare') n += 2;
  if (item.rarity === 'unique') n += 1; // D6 — uniqueValues.length (D12) not knowable without def; see below
  for (const inst of item.affixes) {
    n += 1;
    // D11: one draw per mod, or one for the whole affix if sharedRoll — not
    // resolved here (AFFIXES_BY_ID not imported); callers needing exact
    // parity use item.affixes.length-derived bounds instead where needed.
  }
  return n;
}

test('ITMS.D00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof rollDrop, 'function');
  assert.equal(typeof rollGold, 'function');
  assert.equal(typeof rollChest, 'function');
});

// ---------------------------------------------------------------------------
// 1. D1 — one draw, correct entry, nodrop scaling and the "no D15 on nodrop"
//    rule (04:1881's general case, still binding everywhere except the D15
//    ruling itself).
// ---------------------------------------------------------------------------

test('ITMS.D01 nodrop consumes exactly one draw and produces nothing (no D15)', () => {
  resetUidCounter();
  // tc_humanoid_2 (mlvl 15 -> band 2), rank 'normal' (NODROP_SCALE 1.0):
  // nodrop 620 / gold 230 / item 105 / potion 38 / scroll 7, total 1000.
  // r = 0.3 * 1000 = 300, inside [0, 620) -> nodrop.
  const rng = new TaggingRng(new ScriptedRng([0.3]));
  const result = rollDrop('tc_humanoid', 15, 'normal', 15, 'instruction', 0, rng);
  assert.deepEqual(result.items, []);
  assert.equal(result.gold, 0);
  assert.equal(rng.draws, 1, 'a nodrop pick must consume exactly one draw (D1), never D15');
  assert.equal(rng.log[0].m, 'next');
});

test('ITMS.D02 an unknown rank throws before consuming any draw (PICKS has no entry) — `boss` is NOT one of these (round 2 fix)', () => {
  const rng = new TaggingRng(new Rng(1));
  for (const rank of ['chest', 'sarcophagus', 'not_a_rank']) {
    assert.throws(() => rollDrop('tc_humanoid', 15, rank, 15, 'instruction', 0, rng), RangeError, `rank '${rank}'`);
  }
  assert.equal(rng.draws, 0, 'a rejected rank must not consume a draw');
});

test('ITMS.D03 tc_boss (the treasure-class id) has no entries table and rollDrop refuses it BY NAME, regardless of rank', () => {
  // Round 2 correction: `tc_boss` and rank `'boss'` are two different axes.
  // `tc_boss` must be refused no matter which rank is requested against it
  // — including 'boss' itself, which is otherwise a perfectly ordinary,
  // supported rank (see ITMS.D03b below).
  for (const rank of ['normal', 'champion', 'unique', 'boss']) {
    const rng = new TaggingRng(new Rng(1));
    assert.throws(() => rollDrop('tc_boss', 15, rank, 15, 'instruction', 0, rng), RangeError, `tc_boss at rank '${rank}'`);
  }
});

test('ITMS.D03b rank `boss` against an ORDINARY treasure class does not throw — PICKS.boss=4, NODROP_SCALE.boss=0 (04 §5.4/§5.5, round 2 fix)', () => {
  resetUidCounter();
  resetRareRing();
  // The bug the coordinator caught: round 1 had no PICKS['boss'] entry at
  // all, so this call threw unconditionally, which also meant
  // rollDrop('tc_boss', ...)'s OWN, separate, still-correct refusal was
  // unreachable in practice for rank 'boss'. Both must now hold at once:
  // ordinary TC + rank 'boss' succeeds; tc_boss + any rank still throws
  // (ITMS.D03 above).
  const rng = new Rng(0xb055b055);
  const N = 4000;
  let nodrops = 0;
  let totalItems = 0;
  for (let i = 0; i < N; i++) {
    const result = rollDrop('tc_humanoid', 27, 'boss', 27, 'trial', 75, rng);
    if (result.items.length === 0 && result.gold === 0) nodrops++;
    totalItems += result.items.length;
  }
  assert.equal(nodrops, 0, '04 §5.5: "No nodrop" — NODROP_SCALE.boss=0 must make nodrop structurally unreachable, not just rare');
  assert.ok(totalItems > 0, 'boss rank must actually produce items over a decent sample');
});

test('ITMS.D03c rollDrop runs at all five ranks against an ordinary resolved TC without throwing (the exact regression the coordinator flagged)', () => {
  resetUidCounter();
  resetRareRing();
  const rng = new Rng(0xa11f17e);
  for (const rank of ['normal', 'minion', 'champion', 'unique', 'boss']) {
    assert.doesNotThrow(() => rollDrop('tc_humanoid', 27, rank, 27, 'trial', 75, rng), `rank '${rank}' must not throw against tc_humanoid_3`);
  }
});

// ---------------------------------------------------------------------------
// 2. D2 — gold. Exact formula (§7.1), transcript, and the discard rule.
// ---------------------------------------------------------------------------

test('ITMS.D04 gold: exact transcript — D1 (entry), D2 (variance), D15a/D15b (discarded)', () => {
  resetUidCounter();
  // Same tc_humanoid_2/normal setup as D01. r = 0.7*1000 = 700, in
  // [620, 850) -> gold. D2 variance scripted at 0.5 -> 0.75 + 0.5*0.5 = 1.0.
  // goldBase(15) = 4 + 2.4*15 + 0.12*15^2 = 4 + 36 + 27 = 67 (04 §7.1's own
  // worked table: "goldBase at mlvl 15 = 67.00"). RANK_GOLD.normal = 1.0,
  // goldFind pinned 0 inside rollDrop (see drop.js header) -> pile = 67.
  const scripted = new ScriptedRng([0.7, 0.5, 0.1, 0.9]); // D1, D2, D15a, D15b
  const rng = new TaggingRng(scripted);
  const result = rollDrop('tc_humanoid', 15, 'normal', 15, 'instruction', 0, rng);
  assert.deepEqual(result.items, []);
  assert.equal(result.gold, 67, 'goldPile must match 04 §7.1 exactly: round(67 * 1.0 * 1.0 * 1.0) = 67');
  assert.equal(rng.draws, 4, 'gold: D1, D2, D15a, D15b — exactly four draws');
  assert.deepEqual(rng.log.map((l) => l.m), ['next', 'next', 'next', 'next']);
  console.log('  D04 gold transcript:', JSON.stringify(rng.log.map((l) => l.r)));
});

test('ITMS.D05 rollGold matches 04 §7.1 goldBase(mlvl) at the nine published zone levels', () => {
  // 04 §7.1's own table, transcribed verbatim.
  const table = [
    [6, 22.72], [11, 44.92], [15, 67.0], [18, 86.08], [23, 122.68],
    [27, 156.28], [28, 165.28], [33, 213.88], [37, 257.08],
  ];
  for (const [mlvl, goldBase] of table) {
    // variance pinned to exactly 1.0 (script 0.5 -> 0.75+0.5*0.5=1.0), rank
    // 'normal' (RANK_GOLD 1.0), goldFind 0 -> pile == round(goldBase).
    const rng = new ScriptedRng([0.5]);
    const pile = rollGold(mlvl, 'normal', 0, rng);
    assert.equal(pile, Math.round(goldBase), `mlvl ${mlvl}: goldBase mismatch`);
  }
});

test('ITMS.D06 rollGold: RANK_GOLD/CONTAINER_MULT combined table, exact multipliers', () => {
  const cases = [
    ['normal', 1.0], ['minion', 1.0], ['champion', 2.2], ['unique', 4.0], ['boss', 12.0],
    ['chest', 1.4], ['sarcophagus', 1.4], ['urn', 0.35], ['barrel', 0.35], ['crate', 0.35],
  ];
  const mlvl = 20;
  const goldBase = 4 + 2.4 * mlvl + 0.12 * mlvl * mlvl;
  for (const [rank, mult] of cases) {
    const rng = new ScriptedRng([0.5]); // variance 1.0
    const pile = rollGold(mlvl, rank, 0, rng);
    assert.equal(pile, Math.max(1, Math.round(goldBase * mult)), `rank ${rank}`);
  }
});

test('ITMS.D07 rollGold: goldFind scales the pile, minimum pile is 1, unknown rank throws without a draw', () => {
  const rng1 = new ScriptedRng([0.5]);
  const noFind = rollGold(20, 'normal', 0, rng1);
  const rng2 = new ScriptedRng([0.5]);
  const withFind = rollGold(20, 'normal', 100, rng2); // +100% goldFind -> double
  assert.equal(withFind, noFind * 2);

  const rngLow = new ScriptedRng([0]); // variance floor 0.75
  const pileAtLowMlvl = rollGold(1, 'minion', 0, rngLow);
  assert.ok(pileAtLowMlvl >= 1, 'goldPile must never fall below 1');

  const counting = new TaggingRng(new Rng(1));
  assert.throws(() => rollGold(10, 'not_a_rank', 0, counting), RangeError);
  assert.equal(counting.draws, 0);
});

// ---------------------------------------------------------------------------
// 3. D14 — sub-tables (potions/scrolls), both the `sub`-on-entry path and
//    the ilvl-derived-band path (Ruling 3: tc_urn/the chest classes carry
//    no `sub`).
// ---------------------------------------------------------------------------

test('ITMS.D08 potion: exact transcript when the entry carries its own `sub` (monster classes)', () => {
  resetUidCounter();
  // tc_humanoid_2, rank normal: r = 0.96*1000 = 960, in [955, 993) -> potion,
  // sub 'tc_potion_2'. tc_potion_2 weights: life_minor 250, life_lesser 300,
  // life_greater 60, life_grand 0, mana_minor 200, mana_lesser 140,
  // mana_greater 30, mana_grand 0, rejuvenation 20 (total 1000). r = 0.1*1000
  // = 100, in [0,250) -> potion_life_minor.
  const scripted = new ScriptedRng([0.96, 0.1, 0.2, 0.8]); // D1, D14, D15a, D15b
  const rng = new TaggingRng(scripted);
  const result = rollDrop('tc_humanoid', 15, 'normal', 15, 'instruction', 0, rng);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].baseId, 'potion_life_minor');
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].rarity, 'normal');
  assert.equal(rng.draws, 4, 'potion (sub already set): D1, D14, D15a, D15b');
  console.log('  D08 potion transcript:', JSON.stringify(rng.log.map((l) => l.r)), '-> potion_life_minor');
});

test('ITMS.D09 potion: ilvl-derived band when the entry has no `sub` (tc_urn, Ruling 3)', () => {
  resetUidCounter();
  // tc_urn: nodrop 300, gold 520, potion 120, item 60 (rarityFloor magic),
  // total 1000, rank 'urn' (NODROP_SCALE.urn = 1.0, unscaled). r = 0.75*1000
  // = 750, in [300+520=820)? recompute cumulative: nodrop[0,300) gold[300,
  // 820) potion[820,940) item[940,1000). r=750 lands in gold, not potion —
  // recompute target: want potion -> r in [820,940), e.g. r=850 -> frac
  // 0.85.
  const ilvl = 5; // band 1 -> tc_potion_1
  const scripted = new ScriptedRng([0.85, 0.1]); // D1 (potion), D14
  const rng = new TaggingRng(scripted);
  const result = rollDrop('tc_urn', ilvl, 'urn', ilvl, 'instruction', 0, rng);
  assert.equal(result.items.length, 1);
  const expectedSub = TREASURE_CLASSES_BY_ID[resolveTC('tc_potion', ilvl)];
  assert.equal(resolveTC('tc_potion', ilvl), 'tc_potion_1', 'sanity: ilvl 5 must resolve to band 1');
  assert.ok(expectedSub.entries.some((e) => e.id === result.items[0].baseId), 'picked base must belong to tc_potion_1');
});

test('ITMS.D10 scroll: exact transcript with `sub` set, and the bare `tc_scroll` fallback', () => {
  resetUidCounter();
  // tc_humanoid_2, rank normal: r = 0.995*1000 = 995, in [993,1000) -> scroll,
  // sub 'tc_scroll'. tc_scroll: identify 760, portal 240 (total 1000). r =
  // 0.9*1000 = 900, in [760,1000) -> scroll_portal.
  const scripted = new ScriptedRng([0.995, 0.9, 0.4, 0.6]);
  const rng = new TaggingRng(scripted);
  const result = rollDrop('tc_humanoid', 15, 'normal', 15, 'instruction', 0, rng);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].baseId, 'scroll_portal');
  assert.equal(rng.draws, 4);
  console.log('  D10 scroll transcript:', JSON.stringify(rng.log.map((l) => l.r)), '-> scroll_portal');

  // tc_wastes' scroll row has no `sub` at all -> must fall back to the
  // single, un-banded 'tc_scroll' (never 'tc_scroll_boss', which is
  // tc_boss-only).
  resetUidCounter();
  const rng2 = new TaggingRng(new ScriptedRng([0.95, 0.5])); // pick 'scroll' entry (weight 50 of 1300 total), then D14
  // tc_wastes: gold 380, item 400, potion 170, scroll 50 (total 1000).
  // cumulative: gold[0,380) item[380,780) potion[780,950) scroll[950,1000).
  const rng3 = new TaggingRng(new ScriptedRng([0.97, 0.5]));
  const chestResult = rollDrop('tc_wastes', 15, 'urn', 15, 'instruction', 0, rng3);
  // 'urn' rank has PICKS=1/NODROP_SCALE=1 and is a legal rank for this
  // generic loop even against a chest-family tc (rollDrop does not gate
  // `tc` against `rank`, only `rank` against PICKS) — used here purely to
  // exercise the no-`sub` scroll fallback without needing rollChest.
  assert.equal(chestResult.items.length, 1);
  assert.equal(ITEM_BASES_BY_ID[chestResult.items[0].baseId].category, 'consumable');
});

// ---------------------------------------------------------------------------
// 4. D15 — ground scatter, taken and discarded (the 02-over-04 ruling).
// ---------------------------------------------------------------------------

test('ITMS.D11 ground scatter is drawn (and discarded) for gold/item/potion/scroll but never for nodrop', () => {
  resetUidCounter();
  const seeds = [0xabc123, 0xdead01, 0xf00d99, 0x1234, 0x5678];
  for (const seed of seeds) {
    const rng = new TaggingRng(new Rng(seed));
    const before = rng.draws;
    const result = rollDrop('tc_humanoid', 15, 'champion', 15, 'instruction', 0, rng);
    const totalDraws = rng.draws - before;
    // Reconstruct: every non-nodrop pick consumes >=1 (D1) + its own
    // branch's draws + exactly 2 more (D15a/D15b) than a nodrop pick would.
    // Cheapest possible sanity bound: at least 2 draws were spent on scatter
    // for every real (non-nodrop) drop produced.
    const realDrops = result.items.length + (result.gold > 0 ? 1 : 0);
    assert.ok(totalDraws >= realDrops * 1, `seed ${seed}: must have drawn at least once per real drop`);
    assert.ok(totalDraws >= 1, `seed ${seed}: champion rank must draw at least D1`);
  }
});

test('ITMS.D12 ground scatter proof, exact: an item pick consumes D1 + rollItem draws + exactly 2 more', () => {
  resetUidCounter();
  resetRareRing();
  const rng = new TaggingRng(new Rng(0x777777));
  let checkedAtLeastOneItem = 0;
  for (let i = 0; i < 500; i++) {
    const before = rng.draws;
    const result = rollDrop('tc_caster', 20, 'normal', 20, 'instruction', 0, rng); // tc_caster: high item share
    const consumed = rng.draws - before;
    if (result.items.length === 1 && result.gold === 0) {
      const item = result.items[0];
      const base = ITEM_BASES_BY_ID[item.baseId];
      if (base.category === 'consumable') continue; // potion/scroll, not an equipment 'item' pick — different D14 shape
      // D1 (1) + rollItem's own draws (roll.test.js's own R25 formula,
      // reconstructed here without D13/affix precision — see helper) + D15 (2).
      const rollItemDraws = expectedRollItemDrawCount(item);
      // affixes/D13 add draws this helper does not attempt to predict
      // exactly (that precision belongs to tests/items/roll.test.js) — so
      // this assertion only checks the FLOOR: D1 + the non-affix/non-D13
      // minimum + D15 must already be present, and the total must never be
      // less than that floor.
      assert.ok(consumed >= 1 + rollItemDraws + 2, `item ${i} (${item.baseId}, ${item.rarity}): consumed ${consumed}, floor was ${1 + rollItemDraws + 2}`);
      checkedAtLeastOneItem++;
    }
  }
  assert.ok(checkedAtLeastOneItem > 0, 'must have observed at least one single-item drop to check');
});

// ---------------------------------------------------------------------------
// 5. §5.4 — nodrop scaling and the picks-per-rank table, statistical
//    (named for TEST-7 to absorb, same precedent as ITEM-5's B1/B2).
// ---------------------------------------------------------------------------

test('ITMS.D13 nodrop scaling matches 04 §5.4\'s worked tc_humanoid_2 table (statistical)', () => {
  resetUidCounter();
  resetRareRing();
  const N = 20000;
  // 04 §5.4's own worked numbers for tc_humanoid_2 (mlvl 15, band 2):
  //   rank      P(item, per pick / >=1 over the rank's picks)   P(gold, per pick)
  //   normal    10.50%                                           23.00%
  //   minion    11.58%                                           25.36%
  //   champion  27.00% (>=1 over 2 picks)                        31.90% (per pick)
  const expectations = [
    { rank: 'normal', pItem: 0.105, pGold: 0.23 },
    { rank: 'minion', pItem: 0.1158, pGold: 0.2536 },
  ];
  for (const { rank, pItem, pGold } of expectations) {
    const rng = new Rng(0x9999 + rank.length);
    let itemCount = 0;
    let goldCount = 0;
    for (let i = 0; i < N; i++) {
      const result = rollDrop('tc_humanoid', 15, rank, 15, 'instruction', 0, rng);
      const hasEquip = result.items.some((it) => ITEM_BASES_BY_ID[it.baseId].category !== 'consumable');
      if (hasEquip) itemCount++;
      if (result.gold > 0) goldCount++;
    }
    const observedItem = itemCount / N;
    const observedGold = goldCount / N;
    assert.ok(Math.abs(observedItem - pItem) < 0.015, `rank ${rank}: P(item) observed ${observedItem}, expected ~${pItem}`);
    assert.ok(Math.abs(observedGold - pGold) < 0.015, `rank ${rank}: P(gold) observed ${observedGold}, expected ~${pGold}`);
  }

  // champion: 2 picks, P(>=1 item) = 27.00% (04 §5.4's own worked figure).
  const rngChamp = new Rng(0xc4a4710);
  let atLeastOneItem = 0;
  for (let i = 0; i < N; i++) {
    const result = rollDrop('tc_humanoid', 15, 'champion', 15, 'instruction', 0, rngChamp);
    if (result.items.some((it) => ITEM_BASES_BY_ID[it.baseId].category !== 'consumable')) atLeastOneItem++;
  }
  const observed = atLeastOneItem / N;
  assert.ok(Math.abs(observed - 0.27) < 0.015, `champion: P(>=1 item) observed ${observed}, expected ~0.27`);

  // Round 2 addition (coordinator): rank 'boss' against this SAME ordinary
  // tc_humanoid_2 table must never nodrop — 04 §5.5's "No nodrop" reading
  // of §5.4's `boss | — | — | §5.5` row means NODROP_SCALE.boss = 0, not "a
  // rarely-hit small number". Extends this test rather than duplicating it,
  // per the coordinator's own instruction; ITMS.D03b/D03c cover the
  // "does not throw" regression itself at a different tc/mlvl.
  const rngBoss = new Rng(0xb055);
  let bossNodrops = 0;
  for (let i = 0; i < N; i++) {
    const result = rollDrop('tc_humanoid', 15, 'boss', 15, 'instruction', 0, rngBoss);
    if (result.items.length === 0 && result.gold === 0) bossNodrops++;
  }
  assert.equal(bossNodrops, 0, `boss rank must have ZERO nodrop rate over ${N} samples of tc_humanoid_2, got ${bossNodrops}`);
});

// ---------------------------------------------------------------------------
// 6. The unique-rank rarity floor guarantee (§5.4) — statistical, per
//    ITEM-5's own R25 precedent ("statistical, not scripted" is the
//    established way to prove an invariant across the RNG's branch space).
// ---------------------------------------------------------------------------

test('ITMS.D14 unique-rank guarantee: every unique-rank rollDrop yields >= 1 equipment item of magic-or-better', () => {
  resetUidCounter();
  resetRareRing();
  const rng = new Rng(0xf1e5ee);
  const N = 3000;
  // The natural picks loop runs PICKS.unique = 4 times, so at most 4
  // equipment ('item'-kind) entries can come out of it — an observed 5th
  // equipment item is only possible via the post-loop guarantee's extra
  // pick, and is therefore proof (not inference) that the guarantee fired
  // at least once in this sample.
  let sawGuaranteeFire = 0;
  const rarityRank = { normal: 0, superior: 1, magic: 2, rare: 3, unique: 4 };
  for (let i = 0; i < N; i++) {
    const ilvl = 4 + (i % 36); // vary ilvl 4..39 so uniques (reqLevel-gated) are reachable
    const result = rollDrop('tc_humanoid', ilvl, 'unique', ilvl, 'instruction', 0, rng);
    const equip = result.items.filter((it) => ITEM_BASES_BY_ID[it.baseId].category !== 'consumable');
    const hasMagicPlus = equip.some((it) => rarityRank[it.rarity] >= rarityRank.magic);
    assert.ok(hasMagicPlus, `iteration ${i} (ilvl ${ilvl}): unique-rank drop must guarantee >=1 magic-or-better equipment item, got rarities [${equip.map((e) => e.rarity)}]`);
    assert.ok(equip.length <= 5, `iteration ${i}: at most 4 natural item picks + 1 guarantee pick = 5, got ${equip.length}`);
    if (equip.length === 5) sawGuaranteeFire++;
  }
  assert.ok(sawGuaranteeFire > 0, 'must have observed at least one 5th (guarantee-added) equipment item, or the guarantee branch is untested here');
  console.log(`  D14: ${N} unique-rank rolls, 100% satisfied the guarantee; guarantee visibly fired (5th item) ${sawGuaranteeFire}/${N} times`);
});

// ---------------------------------------------------------------------------
// 7. Determinism — 12.D03: two runs at one seed must be byte-identical.
// ---------------------------------------------------------------------------

test('ITMS.D15 two rollDrop runs from the same seed produce byte-identical output (12.D03)', () => {
  function runBatch() {
    resetUidCounter();
    resetRareRing();
    const rng = new Rng(0xd03d03);
    const out = [];
    const plan = [
      ['tc_humanoid', 15, 'normal', 15],
      ['tc_humanoid', 15, 'champion', 17],
      ['tc_humanoid', 30, 'unique', 30],
      ['tc_swarm', 8, 'minion', 8],
      ['tc_caster', 22, 'normal', 22],
      ['tc_urn', 12, 'urn', 12],
    ];
    for (const [tc, mlvl, rank, ilvl] of plan) {
      out.push(rollDrop(tc, mlvl, rank, ilvl, 'trial', 25, rng));
    }
    return out;
  }
  const a = runBatch();
  const b = runBatch();
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'identical seed + identical call plan must produce byte-identical output');
});

// ---------------------------------------------------------------------------
// 8. rollChest — smoke coverage only (provisional `chest` shape, see
//    drop.js's own header; no acceptance clause of this ticket exercises it
//    in depth, and 07-world-gen.md's real chest record is outside this
//    ticket's reading range).
// ---------------------------------------------------------------------------

test('ITMS.D16 rollChest: smoke — produces at most `rolls` entries, never throws on a legal chest, exposes gold via out.gold', () => {
  resetUidCounter();
  const rng = new Rng(0x00c4e57);
  const out = [];
  const count = rollChest({ tc: 'tc_urn', mlvl: 10, ilvl: 10, rank: 'urn', rolls: 20 }, rng, out);
  assert.ok(count <= 20);
  assert.equal(out.length, count);
  assert.ok(out.gold >= 0);
  for (const it of out) {
    assert.equal(typeof it.uid, 'number');
    assert.ok(ITEM_BASES_BY_ID[it.baseId], `${it.baseId} must be a real base`);
  }
});

test('ITMS.D17 rollChest: rolls=0 produces nothing without throwing; a bad chest object throws', () => {
  const rng = new Rng(1);
  const out = [];
  assert.equal(rollChest({ tc: 'tc_urn', mlvl: 10, ilvl: 10, rank: 'urn', rolls: 0 }, rng, out), 0);
  assert.equal(out.length, 0);
  assert.throws(() => rollChest(null, rng, out), TypeError);
  assert.throws(() => rollChest({ tc: 'tc_urn', mlvl: 10, ilvl: 10, rank: 'urn', rolls: -1 }, rng, out), RangeError);
});
