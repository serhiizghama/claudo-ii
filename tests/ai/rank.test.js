// tests/ai/rank.test.js
//
// AI-8 acceptance tests — `src/ai/rank.js` (champions, uniques and the nine
// affixes) plus `src/ai/index.js`'s wiring. `06-monsters-ai.md` §13 row 8:
// "§5.7, §5.8, §6 in full: promotion, minion inheritance, group draws,
// exclusions, the redraw, `immunityValue`, name generation, telegraph hooks".
//
// Assertion set is **D-64's**, not the backlog's: **MB3, MB4, MB7, MB8,
// MB10**. They are not all this file's, and the split is deliberate:
//
//   MB10  — here, in full: the 100 000-draw sweep, the weights, the three
//           violation classes. It is a property of the shipped draw code.
//   MB3/MB4/MB7/MB8 — `tools/balance.mjs --monsters` (TEST-9, D-70). Those
//           four are TTK verdicts over `03` §11.1's reference builds, and
//           that harness already owns the reference builds, the resist
//           model and §6.6's own printed cross-check table. Re-modelling
//           TTK here would be a second copy of the arithmetic to drift —
//           the exact failure O-119 is about. What this file does instead
//           is drive MB3/MB4's *inputs* through the real pipeline and
//           assert the composed champion/unique block reproduces `03`
//           §11.3's own printed numbers, so the harness's model and the
//           shipped monster are pinned to the same life and defence.
//
// ---------------------------------------------------------------------------
// O-106's rule: drive the REAL pipeline, and say which call produced the number
// ---------------------------------------------------------------------------
// Every rank/affix/name number in the pipeline section comes from
//   `world.setWorldSeed(seed)` -> `await world.enterZone(zoneId, tag, {runIndex})`
//     -> `world` emits `zone:ready`
//       -> `AiSystem`'s OWN listener rolls (§14.1) and then runs the spawn pass
//         -> read back through `ai.affixesOf` / `actors.stats` / `actor.name`
// and never from a reimplementation of that chain. The table and draw
// sections call `./rank.js`'s exports directly, which IS their real call path
// — the file's own header contracts that `tools/balance.mjs` can reach them
// with no engine alive.
//
// Node-safe: `node:test` + `node:assert/strict`. `three` is imported only by
// the real-pipeline section, which needs a `THREE.Scene` for `world`.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  DEFAULT_TIER,
  immunityValue,
  affixCountForRank,
  rankCarriesAffixes,
  isEligible,
  isExcludedPair,
  dangerPoints,
  dangerBudget,
  rollChampionAffix,
  rollUniqueAffixes,
  rollAffixes,
  rollUniqueName,
  affixStats,
  affixStatKeys,
  affixLayer,
  rankTelegraph,
  affixTelegraph,
  telegraphIsAlwaysDrawn,
  createAffixStore,
  resetAffixStore,
  setActorAffixes,
  actorAffixes,
  actorHasAffix,
  clearActorAffixes,
  rollStats,
  resetRollStats,
  MAX_AFFIXES_PER_ACTOR,
} from '../../src/ai/rank.js';
import {
  MONSTER_AFFIXES,
  AFFIX_IDS,
  AFFIX_GROUPS,
  AFFIX_GROUP_WEIGHTS,
  AFFIX_INELIGIBLE,
  AFFIX_EXCLUSIONS,
  AFFIX_COUNT_BY_RANK,
  DANGER_BUDGET,
  IMMUNITY_VALUE_BY_TIER,
  TIER_MONSTER_RESIST_BONUS,
  UNIQUE_EPITHETS,
  UNIQUE_TITLES,
  UNIQUE_NAME_COMBINATIONS,
} from '../../src/ai/data/affixes.js';
import { championCount, promotionRanks, resolveRoster, isPackTemplateId, effectivePackCount } from '../../src/ai/spawn.js';
import { BESTIARY, lifeMult, damageMult, defenseMult } from '../../src/ai/data/bestiary.js';
import { Rng } from '../../src/core/rng.js';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem } from '../../src/ai/index.js';
import { makeStubCtx } from '../helpers/actor.js';

/** `06` §6.3's own eligible archetypes — the six the bestiary spawns.
 * `molgrim` is excluded by §6.3 itself ("The boss takes no affixes"). */
const ELIGIBLE_ARCHETYPES = Object.freeze([
  'bone_ranker', 'carrion_swarm', 'ashen_archer', 'dust_shaman', 'maulsmith', 'blight_crawler',
]);

/** `03` §9.3's rank multipliers, transcribed from the spec's own table
 * (L886-L892) rather than imported from `src/actors/stats.js` — the point of
 * the pipeline section is to check the shipped composition AGAINST the
 * document, and importing the table under test would make that circular. */
const RANK_MULT_SPEC = Object.freeze({
  normal: Object.freeze({ life: 1.0, damage: 1.0, defense: 1.0, physResist: 0, elemResist: 0, affixes: 0 }),
  minion: Object.freeze({ life: 1.6, damage: 1.2, defense: 1.2, physResist: 0, elemResist: 10, affixes: 3 }),
  champion: Object.freeze({ life: 4.0, damage: 1.6, defense: 1.5, physResist: 10, elemResist: 20, affixes: 1 }),
  unique: Object.freeze({ life: 7.0, damage: 2.2, defense: 2.0, physResist: 15, elemResist: 30, affixes: 3 }),
});

/**
 * Counts DRAWS, in the unit `06` §14.1 counts them in — one `weighted` call
 * or one `int` call is one draw. Delegates to a real `Rng` so the sequence is
 * the shipped one and only the counting is added.
 */
class CountingRng {
  constructor(seed) {
    this._rng = new Rng(seed);
    this.draws = 0;
  }

  weighted(candidates, weights) {
    this.draws++;
    return this._rng.weighted(candidates, weights);
  }

  int(min, max) {
    this.draws++;
    return this._rng.int(min, max);
  }
}

// ===========================================================================
// §6.1 / §6.3 / §6.5 — the shipped table
// ===========================================================================

test('06 §6.1: nine affixes, three groups, weights sum to 100 and to the group totals 34/41/25', () => {
  assert.equal(AFFIX_IDS.length, 9, '§6.1 prints nine affixes');
  assert.deepEqual([...AFFIX_GROUPS], ['immunity', 'power', 'utility']);

  let total = 0;
  const perGroup = { immunity: 0, power: 0, utility: 0 };
  for (const id of AFFIX_IDS) {
    const a = MONSTER_AFFIXES[id];
    assert.ok(AFFIX_GROUPS.includes(a.group), `${id}: group '${a.group}' is not one of §6.1's three`);
    assert.ok(a.weight > 0, `${id}: weight must be positive or it can never be drawn`);
    total += a.weight;
    perGroup[a.group] += a.weight;
  }
  assert.equal(total, 100, '§6.1: the flat table sums to 100');
  for (const g of AFFIX_GROUPS) {
    assert.equal(perGroup[g], AFFIX_GROUP_WEIGHTS[g], `group '${g}' must sum to §6.1's own group weight`);
  }
  console.log(`  §6.1 weights: immunity ${perGroup.immunity} + power ${perGroup.power} + utility ${perGroup.utility} = ${total}`);
});

test('06 §5.7 / §6.5: affix counts and danger budgets per rank', () => {
  // §5.7: a champion pack shares ONE affix, a unique carries three and
  // "every minion inherits all three". `normal`/`boss` carry none.
  assert.equal(affixCountForRank('champion'), 1);
  assert.equal(affixCountForRank('unique'), 3);
  assert.equal(affixCountForRank('minion'), 3);
  assert.equal(affixCountForRank('normal'), 0);
  assert.equal(affixCountForRank('boss'), 0, '§6.3: "The boss takes no affixes"');
  assert.equal(affixCountForRank('nonsense'), 0, 'an unknown rank carries none rather than throwing');
  assert.deepEqual(
    Object.fromEntries(Object.entries(AFFIX_COUNT_BY_RANK)),
    { normal: 0, minion: 3, champion: 1, unique: 3, boss: 0 },
    'the table carries §9.3\'s own Affixes column for every rank, including the two zeroes',
  );

  assert.equal(rankCarriesAffixes('champion'), true);
  assert.equal(rankCarriesAffixes('unique'), true);
  assert.equal(rankCarriesAffixes('minion'), true);
  assert.equal(rankCarriesAffixes('normal'), false);
  assert.equal(rankCarriesAffixes('boss'), false);

  assert.equal(dangerBudget('champion'), 3, '§6.5: champion budget 3');
  assert.equal(dangerBudget('unique'), 7, '§6.5: unique budget 7');
  assert.equal(dangerBudget('minion'), dangerBudget('unique'), 'a minion carries the unique\'s three, so it inherits its budget too');
  assert.equal(dangerBudget('normal'), 0);
  assert.equal(DANGER_BUDGET.champion, 3);
  assert.equal(DANGER_BUDGET.unique, 7);
});

test('06 §6.5: three exclusion pairs, order-independent, and the third fires only on ashen_archer', () => {
  assert.equal(AFFIX_EXCLUSIONS.length, 3, '§6.5 prints three hard pairs');

  assert.equal(isExcludedPair('frostbound', 'swift'), true);
  assert.equal(isExcludedPair('swift', 'frostbound'), true, 'order-independent');
  assert.equal(isExcludedPair('stoneskin', 'burning'), true);
  assert.equal(isExcludedPair('burning', 'stoneskin'), true);

  // The archetype-scoped pair: `mighty + multishot` on `ashen_archer` only.
  assert.equal(isExcludedPair('mighty', 'multishot', 'ashen_archer'), true);
  assert.equal(isExcludedPair('multishot', 'mighty', 'ashen_archer'), true);
  assert.equal(isExcludedPair('mighty', 'multishot', 'bone_ranker'), false, 'the scoped pair must not leak onto another archetype');
  assert.equal(isExcludedPair('mighty', 'multishot'), false, 'nor onto the unscoped case');

  assert.equal(isExcludedPair('burning', 'swift'), false, 'a pair §6.5 does not name is legal');
});

test('06 §6.3: every group is non-empty for every eligible archetype, and survives §6.5\'s single removal', () => {
  const rows = [];
  for (const archetypeId of ELIGIBLE_ARCHETYPES) {
    for (const group of AFFIX_GROUPS) {
      const candidates = AFFIX_IDS.filter((id) => MONSTER_AFFIXES[id].group === group && isEligible(id, archetypeId));
      assert.ok(candidates.length > 0,
        `§6.3 states "every group is non-empty for every eligible archetype, so a draw can never fail" — '${archetypeId}'/'${group}' is empty`);
      rows.push(`${archetypeId}/${group}=${candidates.length}`);

      // §6.5's redraw promise: holding an affix removes at most one candidate
      // from the affected group, and a candidate always survives. A group of
      // ONE that no exclusion touches is not a violation — §6.3 names
      // `blight_crawler`'s forced `hexing` as intended.
      for (const x of AFFIX_EXCLUSIONS) {
        if (x.archetypeId !== null && x.archetypeId !== archetypeId) continue;
        for (const [held, removed] of [[x.a, x.b], [x.b, x.a]]) {
          if (MONSTER_AFFIXES[removed].group !== group) continue;
          if (!isEligible(held, archetypeId)) continue;
          const after = candidates.filter((id) => id !== removed);
          assert.ok(after.length > 0,
            `'${archetypeId}'/'${group}': holding '${held}' removes '${removed}' and empties the group — §6.5's single redraw could not succeed`);
        }
      }
    }
  }
  assert.equal(isEligible('vampiric', 'ashen_archer'), false, '§6.3 bans vampiric on the Archer');
  assert.equal(isEligible('vampiric', 'bone_ranker'), true, '§6.3\'s bone_ranker row is "all 3 / all 3 / all 3"');
  assert.equal(isEligible('vampiric'), true, 'no archetype means the unrestricted case, not "nothing is eligible"');
  assert.equal(isEligible('not_an_affix', 'bone_ranker'), false, 'an id outside the table is never eligible');
  console.log(`  §6.3 candidate counts: ${rows.join(' ')}`);
});

test('06 §6.5: no legal champion affix and no legal unique triple exceeds its danger budget', () => {
  let worstChampion = 0;
  let worstTriple = 0;
  let triples = 0;
  for (const archetypeId of ELIGIBLE_ARCHETYPES) {
    const byGroup = AFFIX_GROUPS.map((g) => AFFIX_IDS.filter((id) => MONSTER_AFFIXES[id].group === g && isEligible(id, archetypeId)));
    for (const id of byGroup.flat()) {
      const p = dangerPoints([id]);
      worstChampion = Math.max(worstChampion, p);
      assert.ok(p <= dangerBudget('champion'), `'${archetypeId}': champion affix '${id}' costs ${p} > ${dangerBudget('champion')}`);
    }
    // §6.5's unique draw is one per group, so a legal triple is exactly one
    // member of each group with no excluded pair among them.
    for (const a of byGroup[0]) for (const b of byGroup[1]) for (const c of byGroup[2]) {
      if (isExcludedPair(a, b, archetypeId) || isExcludedPair(a, c, archetypeId) || isExcludedPair(b, c, archetypeId)) continue;
      const p = dangerPoints([a, b, c]);
      triples++;
      worstTriple = Math.max(worstTriple, p);
      assert.ok(p <= dangerBudget('unique'), `'${archetypeId}': unique triple [${a},${b},${c}] costs ${p} > ${dangerBudget('unique')}`);
    }
  }
  assert.equal(dangerPoints([]), 0);
  assert.equal(dangerPoints(['not_an_affix']), 0, 'an unknown id contributes nothing rather than NaN');
  console.log(`  §6.5 danger: worst champion ${worstChampion}/3, worst of ${triples} legal unique triples ${worstTriple}/7`);
});

// ===========================================================================
// §14.1 — the draw schedule, counted
// ===========================================================================

test('06 §14.1: a champion spends exactly 2 draws, a unique 3 plus one per excluded pair, a name 2', () => {
  const out = [];

  // Row 1 — champion: "a group by group weight and then an affix within it".
  let seenTwo = 0;
  for (let seed = 0; seed < 200; seed++) {
    const rng = new CountingRng(0xc0000000 + seed);
    const n = rollAffixes('champion', 10, rng, out, 'bone_ranker');
    assert.equal(n, 1, 'a champion carries exactly one affix');
    assert.equal(rng.draws, 2, `seed ${seed}: §14.1 row 1 is two draws, got ${rng.draws}`);
    seenTwo++;
  }
  assert.equal(seenTwo, 200);

  // Row 1' — unique: three draws, plus one per §6.5 redraw.
  let withRedraw = 0;
  for (let seed = 0; seed < 400; seed++) {
    const rng = new CountingRng((0x40000000 + seed) >>> 0);
    const before = rollStats.redraws;
    const n = rollUniqueAffixes(rng, 'bone_ranker', out);
    const redraws = rollStats.redraws - before;
    assert.equal(n, 3, 'a unique always ends with three affixes');
    assert.equal(rng.draws, 3 + redraws, `seed ${seed}: §14.1 row 1' is 3 draws + 1 per redraw, got ${rng.draws} with ${redraws} redraw(s)`);
    if (redraws > 0) withRedraw++;
  }
  assert.ok(withRedraw > 0, 'the 400-seed sample must actually exercise the redraw, or this assertion proves nothing');

  // Row 2 — the name: "two draws ... taken immediately after its affixes".
  for (let seed = 0; seed < 50; seed++) {
    const rng = new CountingRng(0x9e000000 + seed);
    rollUniqueName(rng);
    assert.equal(rng.draws, 2, '§5.8 is an epithet draw and a title draw');
  }

  // A rank that takes no affixes spends NOTHING — the guard that keeps a
  // `normal` member of a champion pack from moving the stream.
  for (const rank of ['normal', 'minion', 'boss', 'nonsense']) {
    const rng = new CountingRng(0x11110000);
    out.length = 3;
    const n = rollAffixes(rank, 10, rng, out, 'bone_ranker');
    assert.equal(n, 0, `${rank}: no draw`);
    assert.equal(rng.draws, 0, `${rank}: must not touch the stream — a minion INHERITS, it does not roll (§5.7)`);
    assert.equal(out.length, 0, `${rank}: out is emptied rather than left stale`);
  }

  assert.equal(rollAffixes('champion', 10, new CountingRng(1), null, 'bone_ranker'), 0, 'no out, no draw');
});

// ===========================================================================
// MB10 — the 100 000-draw sweep
// ===========================================================================

test('MB10: ai.rollAffixes over 100 000 champion draws matches §6.1 weights within ±1.5 %, zero ineligible', () => {
  // MB10 names `ai.rollAffixes`, so the sweep goes through the CONTRACTED
  // method on `AiSystem`, not the module function it forwards to. The
  // instance is constructed but never `init()`ed — the whole point of
  // `./rank.js`'s "no ctx, no engine" contract is that this works.
  const ai = new AiSystem();
  assert.equal(typeof ai.rollAffixes, 'function', '02 §12 contracts rollAffixes on ai');

  const N = 100000;
  const rng = new Rng(0x51f3a2b1);
  const out = [];
  const counts = Object.fromEntries(AFFIX_IDS.map((id) => [id, 0]));
  let ineligible = 0;
  for (let i = 0; i < N; i++) {
    const n = ai.rollAffixes('champion', 10, rng, out, 'bone_ranker');
    assert.equal(n, 1);
    counts[out[0]]++;
    if (!isEligible(out[0], 'bone_ranker')) ineligible++;
  }
  assert.equal(ineligible, 0, 'MB10: never an ineligible affix for the archetype');

  const rows = [];
  let worst = 0;
  for (const id of AFFIX_IDS) {
    const observed = (counts[id] / N) * 100;
    const expected = MONSTER_AFFIXES[id].weight; // §6.1's weights ARE percentages: they sum to 100
    const dev = Math.abs(observed - expected);
    worst = Math.max(worst, dev);
    rows.push(`${id} ${observed.toFixed(2)}%/${expected}%`);
    assert.ok(dev <= 1.5, `MB10: '${id}' observed ${observed.toFixed(3)} % against §6.1's ${expected} % — deviation ${dev.toFixed(3)} exceeds ±1.5`);
  }
  console.log(`  MB10 champion draws (${N}, ai.rollAffixes): worst deviation ${worst.toFixed(3)} pp — ${rows.join(', ')}`);
});

test('MB10: 100 000 unique rolls — never two from one group, never an excluded pair, never an ineligible affix', () => {
  const ai = new AiSystem();
  const N = 100000;
  const out = [];
  let twoFromOneGroup = 0;
  let excluded = 0;
  let ineligible = 0;
  let wrongCount = 0;
  const perArchetype = {};

  for (let i = 0; i < N; i++) {
    // Cycle the archetypes so every §6.3 row is swept, not just the
    // unrestricted `bone_ranker` one.
    const archetypeId = ELIGIBLE_ARCHETYPES[i % ELIGIBLE_ARCHETYPES.length];
    const rng = new Rng((0x7f000000 + i) >>> 0);
    const n = ai.rollAffixes('unique', 10, rng, out, archetypeId);
    if (n !== 3) wrongCount++;

    const groups = out.map((id) => MONSTER_AFFIXES[id].group);
    if (new Set(groups).size !== groups.length) twoFromOneGroup++;
    for (const id of out) if (!isEligible(id, archetypeId)) ineligible++;
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) {
        if (isExcludedPair(out[a], out[b], archetypeId)) excluded++;
      }
    }
    const key = archetypeId + '|' + out.slice().sort().join('+');
    perArchetype[key] = (perArchetype[key] || 0) + 1;
  }

  assert.equal(wrongCount, 0, 'MB10: a unique always ends with exactly three affixes');
  assert.equal(twoFromOneGroup, 0, 'MB10: never two affixes from one group on a unique');
  assert.equal(excluded, 0, 'MB10: never an excluded pair');
  assert.equal(ineligible, 0, 'MB10: never an ineligible affix for the archetype');
  console.log(`  MB10 unique rolls (${N} over all ${ELIGIBLE_ARCHETYPES.length} eligible archetypes): 0 violations of all three classes, ${Object.keys(perArchetype).length} distinct archetype+triple combinations reached`);
});

test('MB10: the group draw itself matches §6.1\'s 34/41/25 within ±1.5 %', () => {
  // The champion sweep above measures the JOINT distribution; this measures
  // the first of §6.5's two stages on its own, so a group-weight bug that
  // happened to cancel against an affix-weight bug cannot hide.
  const N = 100000;
  const rng = new Rng(0x2c4d8e70);
  const out = [];
  const byGroup = { immunity: 0, power: 0, utility: 0 };
  for (let i = 0; i < N; i++) {
    rollChampionAffix(rng, null, out);
    byGroup[MONSTER_AFFIXES[out[0]].group]++;
  }
  for (const g of AFFIX_GROUPS) {
    const observed = (byGroup[g] / N) * 100;
    const dev = Math.abs(observed - AFFIX_GROUP_WEIGHTS[g]);
    assert.ok(dev <= 1.5, `group '${g}': ${observed.toFixed(3)} % against §6.1's ${AFFIX_GROUP_WEIGHTS[g]} % — ${dev.toFixed(3)} pp`);
  }
  console.log(`  MB10 group stage (${N}, unrestricted): immunity ${(byGroup.immunity / N * 100).toFixed(2)}%, power ${(byGroup.power / N * 100).toFixed(2)}%, utility ${(byGroup.utility / N * 100).toFixed(2)}%`);
});

test('06 §6.5: on a RESTRICTED table the two-stage draw is NOT the flat one — measured, not assumed', () => {
  // `./rank.js`'s own header promises this measurement. §6.5 says the two
  // schemes "are the same distribution", and on the full table they are
  // (`tools/balance.mjs` pins the deviation at 2.8e-17). Once §6.3 removes
  // an affix they diverge, and `blight_crawler` is the extreme case: its
  // `utility` group is `{hexing}` alone, so two-stage gives `hexing` the
  // whole 25 % group weight while a flat renormalisation over its six
  // eligible affixes would give it 9/72 = 12.5 %.
  const eligible = AFFIX_IDS.filter((id) => isEligible(id, 'blight_crawler'));
  const flatTotal = eligible.reduce((a, id) => a + MONSTER_AFFIXES[id].weight, 0);
  const flatHexing = (MONSTER_AFFIXES.hexing.weight / flatTotal) * 100;

  const N = 100000;
  const rng = new Rng(0x0b100000);
  const out = [];
  let hexing = 0;
  for (let i = 0; i < N; i++) {
    rollChampionAffix(rng, 'blight_crawler', out);
    if (out[0] === 'hexing') hexing++;
  }
  const observed = (hexing / N) * 100;

  assert.equal(eligible.length, 6, '§6.3 bans burning, vampiric and multishot on the Crawler');
  assert.equal(flatTotal, 72);
  assert.ok(Math.abs(observed - AFFIX_GROUP_WEIGHTS.utility) <= 1.5,
    `two-stage must give hexing the whole utility group weight (${AFFIX_GROUP_WEIGHTS.utility} %), measured ${observed.toFixed(3)} %`);
  assert.ok(Math.abs(observed - flatHexing) > 1.5,
    'the two readings must actually diverge here, or this test is measuring nothing');
  console.log(`  §6.5 procedure vs §6.1 renormalisation on blight_crawler/hexing: two-stage ${observed.toFixed(2)} % (spec procedure, implemented) vs flat ${flatHexing.toFixed(2)} % — a real ${(observed - flatHexing).toFixed(2)} pp divergence, reported`);
});

test('06 §6.5: a unique ends with three affixes on ALL six eligible archetypes, and the redraw is what saves it', () => {
  const out = [];
  resetRollStats();
  const perArchetype = [];
  for (const archetypeId of ELIGIBLE_ARCHETYPES) {
    let redraws = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const before = rollStats.redraws;
      const n = rollUniqueAffixes(new Rng((0x5a000000 + seed) >>> 0), archetypeId, out);
      redraws += rollStats.redraws - before;
      assert.equal(n, 3, `'${archetypeId}' seed ${seed}: a unique must always end with three affixes`);
      assert.equal(new Set(out).size, 3, `'${archetypeId}' seed ${seed}: three DISTINCT affixes`);
    }
    perArchetype.push(`${archetypeId}:${redraws}`);
  }
  assert.ok(rollStats.redraws > 0, 'the sweep must exercise the redraw at least once');
  assert.equal(rollStats.uniqueRolls, ELIGIBLE_ARCHETYPES.length * 2000, 'rollStats counts every roll');
  console.log(`  §6.5 redraws over ${ELIGIBLE_ARCHETYPES.length}x2000 unique rolls: ${perArchetype.join(' ')} (total ${rollStats.redraws})`);
  resetRollStats();
});

test('06 §6.5: the redraw fires on a HELD conflict and the pair never survives it', () => {
  // `frostbound + swift` is the pair that is reachable in group order:
  // `immunity` is drawn first, so a held `frostbound` is what removes
  // `swift` from `power`. Driven with a stacked rng rather than by luck.
  const out = [];
  const stacked = {
    _picks: ['frostbound', 'swift', 'mighty', 'hexing'],
    _i: 0,
    weighted(candidates) {
      // Take the scripted pick when it is still a candidate; otherwise fall
      // back to the first candidate, which is what the removal leaves.
      const want = this._picks[this._i++];
      return candidates.includes(want) ? want : candidates[0];
    },
  };
  resetRollStats();
  const n = rollUniqueAffixes(stacked, 'bone_ranker', out);
  assert.equal(n, 3);
  assert.equal(out[0], 'frostbound');
  assert.notEqual(out[1], 'swift', '§6.5: a held frostbound removes swift from the power group');
  assert.equal(rollStats.redraws, 1, 'exactly one redraw was taken, and it is counted');
  assert.equal(isExcludedPair(out[0], out[1]), false);
  console.log(`  §6.5 redraw driven deterministically: [${out.join(', ')}] — swift removed after frostbound was held`);
  resetRollStats();
});

// ===========================================================================
// §6.4 / §6.1 / §6.2 — the stat contribution
// ===========================================================================

test('06 §6.4: immunityValue is 85 at Instruction and 100 at Trial and Renunciation', () => {
  assert.equal(DEFAULT_TIER, 'instruction');
  assert.equal(immunityValue('instruction'), 85);
  assert.equal(immunityValue('trial'), 100);
  assert.equal(immunityValue('renunciation'), 100);
  assert.equal(immunityValue(), 85, 'no tier means Instruction — the only tier the game can be played at today (O-97)');
  assert.equal(immunityValue('nonsense'), 85, 'an unknown tier degrades to Instruction rather than returning undefined');
  assert.deepEqual({ ...IMMUNITY_VALUE_BY_TIER }, { instruction: 85, trial: 100, renunciation: 100 });

  // `03` §10.2's per-tier monster resist bonus is shipped as data and
  // deliberately NOT applied by `affixStats` — stated here rather than left
  // to a comment, because it is the input the day AI-11 (M6) lands.
  assert.deepEqual({ ...TIER_MONSTER_RESIST_BONUS }, { instruction: 0, trial: 20, renunciation: 40 });
  const trial = affixStats('burning', 10, undefined, 'trial');
  assert.equal(trial.fireResist, 100,
    'affixStats applies §6.4\'s tier gate and NOTHING else — adding §10.2\'s +20 here would double-count the day a tier system lands');
});

test('06 §6.1/§6.2: affixStats reproduces every affix\'s own stat row, and the immunity three are the only tier-gated ones', () => {
  const keys = affixStatKeys();
  assert.deepEqual([...keys], [...keys].sort(), 'the key set is sorted, so a test can compare it stably');

  const immunityAffixes = [];
  for (const id of AFFIX_IDS) {
    const a = MONSTER_AFFIXES[id];
    const layer = affixStats(id, 10);
    for (const k of keys) {
      assert.equal(typeof layer[k], 'number', `${id}: '${k}' must be present and numeric so the layer shape never varies`);
    }
    for (const [k, v] of Object.entries(a.stats)) {
      assert.equal(layer[k], v, `${id}: '${k}' must be the table's own value`);
    }
    if (a.immunityResist) {
      immunityAffixes.push(id);
      assert.equal(layer[a.immunityResist], immunityValue(DEFAULT_TIER), `${id}: the immunity resist is §6.4's gated value`);
      assert.equal(affixStats(id, 10, undefined, 'trial')[a.immunityResist], 100);
    }
  }
  assert.deepEqual(immunityAffixes, ['burning', 'charged', 'frostbound'],
    '`03` §9.4: "Immunity is granted only by burning, charged and frostbound"');

  assert.deepEqual(affixStats('not_an_affix', 10), affixStats('not_an_affix', 10),
    'an unknown id yields the zeroed layer rather than throwing');
  const zeroed = affixStats('not_an_affix', 10);
  for (const k of keys) assert.equal(zeroed[k], 0);

  // `out` is reused in place and carries no stale field from the last call.
  const out = {};
  affixStats('swift', 10, out);
  assert.equal(out.increasedAttackSpeed, 60);
  affixStats('stoneskin', 10, out);
  assert.equal(out.increasedAttackSpeed, 0, 'the reused out must be zeroed, not merged with the previous affix');
  assert.equal(out.defensePercent, 150);
  console.log(`  §6.1 affix stat keys (${keys.length}): ${keys.join(', ')}`);
});

test('06 §6.2: affixLayer sums a unique\'s three, and lifeSteal is a SET rather than an add', () => {
  const layer = affixLayer(['frostbound', 'stoneskin', 'vampiric'], 10);
  assert.equal(layer.coldResist, 85, 'frostbound\'s tier-gated resist');
  assert.equal(layer.defensePercent, 150);
  assert.equal(layer.damageReducePercent, 25);
  assert.equal(layer.lifeSteal, 30);

  const both = affixLayer(['swift', 'mighty'], 10); // structurally impossible on a unique — same group — but the merge must still be right
  assert.equal(both.increasedAttackSpeed, 60);
  assert.equal(both.enhancedDamage, 55);
  assert.equal(both.movementSpeed, 45);
  assert.equal(both.attackRatingPercent, 25);

  assert.equal(affixLayer(['vampiric', 'vampiric'], 10).lifeSteal, 30,
    '§6.2: lifeSteal is a flat SET — two sources must not stack to 60');

  const empty = affixLayer([], 10);
  for (const k of affixStatKeys()) assert.equal(empty[k], 0);
  assert.equal(affixLayer(null, 10).lifeSteal, 0, 'a null list yields the zeroed layer rather than throwing');
});

// ===========================================================================
// §5.8 — name generation
// ===========================================================================

test('06 §5.8: 16 epithets x 12 titles = 192 names, and the sweep actually reaches all of them', () => {
  assert.equal(UNIQUE_EPITHETS.length, 16);
  assert.equal(UNIQUE_TITLES.length, 12);
  assert.equal(UNIQUE_NAME_COMBINATIONS, 192);
  assert.equal(UNIQUE_EPITHETS.length * UNIQUE_TITLES.length, UNIQUE_NAME_COMBINATIONS);

  const rng = new Rng(0x4e414d45);
  const seen = new Set();
  const out = { epithet: '', title: '', titleRu: '', name: '' };
  for (let i = 0; i < 20000; i++) {
    const r = rollUniqueName(rng, out);
    assert.equal(r, out, 'the out object is reused in place, never reallocated');
    assert.equal(r.name, `${r.epithet}, ${r.title}`, '§5.8: EPITHET + ", " + TITLE');
    assert.ok(UNIQUE_EPITHETS.includes(r.epithet));
    assert.ok(r.titleRu.length > 0, 'every title carries its Russian form');
    seen.add(r.name);
  }
  assert.equal(seen.size, UNIQUE_NAME_COMBINATIONS, `all ${UNIQUE_NAME_COMBINATIONS} combinations must be reachable, saw ${seen.size}`);

  const fresh = rollUniqueName(new Rng(1));
  assert.equal(typeof fresh.name, 'string', 'no out means a fresh record rather than a throw');
  console.log(`  §5.8: ${seen.size}/192 names reached over 20 000 draws, e.g. "${fresh.name}"`);
});

// ===========================================================================
// §6.7 — telegraph hooks
// ===========================================================================

test('06 §6.7: every rank that takes affixes and every affix carries a telegraph row', () => {
  for (const rank of ['champion', 'unique', 'minion']) {
    const t = rankTelegraph(rank);
    assert.ok(t, `${rank}: §6.7 gives it a row`);
  }
  assert.equal(rankTelegraph('normal'), null, 'a normal monster has no aura');
  assert.equal(rankTelegraph('nonsense'), null);

  for (const id of AFFIX_IDS) {
    assert.ok(affixTelegraph(id), `${id}: §6.7 gives every affix a row`);
  }
  assert.equal(affixTelegraph('not_an_affix'), null);

  // §6.7: "a telegraph that blinks is a telegraph that gets crossed".
  assert.equal(telegraphIsAlwaysDrawn('frostbound'), true);
  for (const id of AFFIX_IDS.filter((x) => x !== 'frostbound')) {
    assert.equal(telegraphIsAlwaysDrawn(id), false, `${id}: only frostbound's ring is permanent`);
  }
  assert.equal(telegraphIsAlwaysDrawn('not_an_affix'), false);
});

// ===========================================================================
// The per-actor affix store
// ===========================================================================

test('the affix store records at most three ids per actor, reads them back, and clears without leaking', () => {
  assert.equal(MAX_AFFIXES_PER_ACTOR, 3, '§6.5\'s hard maximum — one per group');
  const store = createAffixStore(8);
  const out = [];

  assert.equal(setActorAffixes(store, 2, ['burning', 'swift', 'hexing']), 3);
  assert.equal(actorAffixes(store, 2, out), 3);
  assert.deepEqual([...out], ['burning', 'swift', 'hexing']);
  assert.equal(actorHasAffix(store, 2, 'swift'), true);
  assert.equal(actorHasAffix(store, 2, 'mighty'), false);
  assert.equal(actorHasAffix(store, 3, 'swift'), false, 'a neighbouring slot must not see it');

  assert.equal(setActorAffixes(store, 3, ['burning', 'swift', 'hexing', 'mighty']), 3, 'a fourth is dropped, never written past the row');
  assert.equal(setActorAffixes(store, 4, ['not_an_affix', 'swift']), 1, 'an unknown id is skipped, not stored as -1');
  assert.equal(actorAffixes(store, 4, out), 1);
  assert.deepEqual([...out], ['swift']);

  // Re-setting a slot must not leave the previous occupant's third id behind.
  assert.equal(setActorAffixes(store, 2, ['mighty']), 1);
  assert.equal(actorAffixes(store, 2, out), 1);
  assert.deepEqual([...out], ['mighty']);

  clearActorAffixes(store, 2);
  assert.equal(actorAffixes(store, 2, out), 0);
  assert.equal(actorHasAffix(store, 2, 'mighty'), false);

  // Out of range is answered, never thrown — pool indices can exceed the store.
  assert.equal(setActorAffixes(store, 99, ['swift']), 0);
  assert.equal(actorAffixes(store, 99, out), 0);
  assert.equal(actorHasAffix(store, -1, 'swift'), false);

  setActorAffixes(store, 5, ['swift']);
  resetAffixStore(store);
  assert.equal(actorAffixes(store, 5, out), 0);
  assert.equal(store.slot.every((v) => v === -1), true, 'reset returns every slot to -1, not to 0 (which is a real affix index)');
});

// ===========================================================================
// REAL PIPELINE — §5.7 promotion, §9.3 multipliers, §5.8 names
// ===========================================================================

async function bootFullEngine(rngSeed) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const actors = new ActorsSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const scene = new THREE.Scene();
  const ctx = makeStubCtx({
    rng: new Rng(rngSeed), scene,
    systems: { world, physics, nav, materials, actors, combat, ai, render: { renderer: null } },
  });
  await physics.init(ctx);
  await materials.init(ctx);
  await actors.init(ctx);
  await combat.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  await ai.init(ctx);
  return { world, physics, nav, actors, combat, ai, ctx };
}

/** `03` §10.1's product for one field, rounded ONCE — the spec's own rule. */
function expectedLife(archetypeId, mlvl, rank) {
  return Math.round(BESTIARY[archetypeId].baseLife * lifeMult(mlvl) * RANK_MULT_SPEC[rank].life);
}

test('REAL PIPELINE: 03 §9.3\'s rank multipliers reach every spawned monster\'s life, damage and defence', async () => {
  // `maxLife` is the field that can be checked on EVERY monster: none of the
  // nine affixes writes it (asserted below off `affixStatKeys()`, not
  // assumed), so the §9.3 product is the whole answer whatever a monster
  // rolled. `minDamage`/`maxDamage`/`defense` are checked exactly on the
  // affix-free monsters and as a lower bound on the rest — `mighty` and
  // `stoneskin` legitimately move them, and an assertion that ignored that
  // would be asserting the affixes are inert.
  assert.equal(affixStatKeys().includes('maxLife'), false,
    'no affix writes maxLife — the premise of the exact life assertion below');

  const seen = { normal: 0, champion: 0, unique: 0, minion: 0 };
  let exact = 0;
  let withAffixes = 0;
  for (let i = 0; i < 12; i++) {
    const { world, ai, actors } = await bootFullEngine(8100 + i);
    world.setWorldSeed((0xa1f80000 + i) >>> 0);
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });

    for (const m of actors.all.filter((a) => a.kind === 'monster')) {
      const mult = RANK_MULT_SPEC[m.rank];
      assert.ok(mult, `unexpected rank '${m.rank}'`);
      seen[m.rank]++;
      const row = BESTIARY[m.archetypeId];
      const st = actors.stats(m);
      const affixes = ai.affixesOf(m);

      assert.equal(st.maxLife, expectedLife(m.archetypeId, m.level, m.rank),
        `${m.archetypeId}/${m.rank}: §9.3 life x${mult.life}`);
      assert.equal(m.life, st.maxLife,
        `${m.archetypeId}/${m.rank}: a monster spawns at full life — and at the COMPOSED one, not a re-derivation without the rank term`);
      assert.ok(m.life > 1, 'ACTR-24: a monster is never left at life 1');

      // §5.7's own rule, read back off the actor: the ranks that carry
      // affixes are exactly the ranks §9.3's Affixes column gives them to.
      assert.equal(affixes.length, mult.affixes,
        `${m.archetypeId}/${m.rank}: §9.3's Affixes column says ${mult.affixes}`);

      const bareMin = Math.round(row.baseMinDamage * damageMult(m.level) * mult.damage);
      const bareMax = Math.round(row.baseMaxDamage * damageMult(m.level) * mult.damage);
      const bareDef = Math.round(row.baseDefense * defenseMult(m.level) * mult.defense);
      if (affixes.length === 0) {
        exact++;
        assert.equal(st.minDamage, bareMin, `${m.archetypeId}/${m.rank}: §9.3 damage x${mult.damage}`);
        assert.equal(st.maxDamage, bareMax);
        assert.equal(st.defense, bareDef, `${m.archetypeId}/${m.rank}: §9.3 defence x${mult.defense}`);
      } else {
        withAffixes++;
        assert.ok(st.minDamage >= bareMin, `${m.archetypeId}/${m.rank}: affixes only ever add — ${st.minDamage} < bare ${bareMin}`);
        assert.ok(st.defense >= bareDef, `${m.archetypeId}/${m.rank}: affixes only ever add — ${st.defense} < bare ${bareDef}`);
      }
    }
  }
  for (const rank of ['normal', 'champion', 'unique', 'minion']) {
    assert.ok(seen[rank] > 0, `the sweep must actually produce a '${rank}' or its multiplier is unmeasured`);
  }
  console.log(`  §9.3 through 12 real enterZone calls: ${Object.entries(seen).map(([k, v]) => `${k} ${v}`).join(', ')} — ${exact} affix-free monsters against the spec's exact product, ${withAffixes} carrying affixes as a lower bound`);
});

test('REAL PIPELINE: the affix layer actually lands on the composed block — stoneskin x2.5 defence, mighty +55 % damage, swift +60 IAS', async () => {
  // The lower bound above says an affix never SUBTRACTS. This says the three
  // affixes with a StatBlock effect land exactly, on a real spawned actor,
  // against the same bare champion §11.3 prints.
  const { ai, actors } = await bootFullEngine(8250);
  const bare = actors.stats(ai.spawnOne('bone_ranker', 0, 0, 10, 'champion', []));
  const bareDef = bare.defense;
  const bareMin = bare.minDamage;
  const bareIas = bare.increasedAttackSpeed;
  assert.equal(bareDef, 100, '§11.3\'s printed champion DEF, as the baseline');

  const stone = actors.stats(ai.spawnOne('bone_ranker', 2, 0, 10, 'champion', ['stoneskin']));
  assert.equal(stone.defense, Math.round(bareDef * 2.5), '§6.2: stoneskin is defence x2.5');
  assert.equal(stone.damageReducePercent, 25, '§6.2: and +25 damageReducePercent');

  // `mighty` is the one whose damage half does NOT land in the StatBlock:
  // `06` §6.2 routes it through packet build step **B4**, so the composed
  // block carries `enhancedDamage 55` and `minDamage` stays bare. Measured,
  // and asserted as measured — an assertion that `minDamage` had moved would
  // have been asserting a rule §6.2 does not state.
  const might = actors.stats(ai.spawnOne('bone_ranker', 4, 0, 10, 'champion', ['mighty']));
  assert.equal(might.enhancedDamage, 55, '§6.2: mighty is +55 % enhanced damage, applied at packet build step B4');
  assert.equal(might.minDamage, bareMin, '§6.2: and therefore NOT folded into the block\'s own minDamage');
  assert.equal(might.attackRatingPercent, 25, '§6.2: mighty is also attackRating x1.25');
  assert.equal(might.attackRating, bare.attackRating * 1.25);

  const swift = actors.stats(ai.spawnOne('bone_ranker', 6, 0, 10, 'champion', ['swift']));
  assert.equal(swift.increasedAttackSpeed, bareIas + 60, '§6.2: swift is +60 IAS');

  // §6.4 sets 85 at Instruction; `01` §3.4's 75 % resist cap then clamps it
  // on the way into the composed block. 75 is the number §6.6's own 3.20x
  // champion cell is computed from, so both halves are pinned here: the
  // layer carries 85, the actor ends at 75.
  const frost = actors.stats(ai.spawnOne('bone_ranker', 8, 0, 10, 'champion', ['frostbound']));
  assert.equal(affixLayer(['frostbound'], 10, undefined, DEFAULT_TIER).coldResist, 85, '§6.4: the layer carries the tier-gated 85');
  assert.equal(frost.coldResist, 75, '`01` §3.4: and the composed block clamps it to the 75 % cap — §6.6\'s own input');
  assert.equal(immunityValue(DEFAULT_TIER), 85);

  // The un-promoted case: a `normal` rank never receives the pack's affixes
  // even when `spawnOne` is handed them — §5.7's guard, at its call site.
  const normal = actors.stats(ai.spawnOne('bone_ranker', 10, 0, 10, 'normal', ['stoneskin']));
  assert.equal(normal.defense, Math.round(bareDef / RANK_MULT_SPEC.champion.defense * RANK_MULT_SPEC.normal.defense),
    'a normal member of a champion pack carries neither the rank multiplier nor the affix');
  console.log(`  §6.2 on real actors: bare champion def ${bareDef} -> stoneskin ${stone.defense}; minDamage ${bareMin} -> mighty ${might.minDamage}; IAS ${bareIas} -> swift ${swift.increasedAttackSpeed}; coldResist -> frostbound ${frost.coldResist}`);
});

test('REAL PIPELINE: 03 §11.3\'s printed level-10 champion and unique reproduce exactly, and the resist columns do NOT', async () => {
  // §11.3 prints champion life 351 / DEF 100 and unique life 615 / DEF 133 —
  // the inputs MB3 and MB4 are computed from. `tools/balance.mjs --monsters`
  // owns the TTK verdicts; this pins the SHIPPED monster to the same block
  // the harness models, so the two can never quietly disagree.
  const { ai, actors } = await bootFullEngine(8200);
  const rows = [];
  const measuredResists = [];
  for (const rank of ['champion', 'unique']) {
    const actor = ai.spawnOne('bone_ranker', 0, 0, 10, rank, []);
    assert.ok(actor, `${rank}: spawnOne must place it`);
    const st = actors.stats(actor);
    rows.push(`${rank}: life ${st.maxLife} def ${st.defense}`);
    assert.equal(st.maxLife, rank === 'champion' ? 351 : 615, `§11.3 prints ${rank} life`);
    assert.equal(st.defense, rank === 'champion' ? 100 : 133, `§11.3 prints ${rank} DEF`);
    measuredResists.push(`${rank}: phys ${st.physicalResist} (§9.3 says +${RANK_MULT_SPEC[rank].physResist}), fire ${st.fireResist} (§9.3 says +${RANK_MULT_SPEC[rank].elemResist})`);

    // Pinned, not skipped: `src/actors/stats.js` composes §9.3's Life/Damage/
    // Defence columns and NOT its "Phys resist +" / "Elem resists +" columns.
    // That is a real gap in `actors`, outside AI-8's grant, and it is what
    // makes a shipped champion die faster than MB3's own model predicts.
    // When it is closed, this assertion fires and forces the journal row.
    assert.equal(st.physicalResist, 0, `${rank}: §9.3's physical resist column is NOT applied by actors — reported gap`);
    assert.equal(st.fireResist, 0, `${rank}: §9.3's elemental resist column is NOT applied by actors — reported gap`);
  }
  console.log(`  §11.3 composed: ${rows.join(' | ')} — both exact`);
  console.log(`  §9.3 resist columns MISSING from the composed block: ${measuredResists.join(' | ')} — a gap in src/actors/stats.js, reported not fixed`);
});

test('REAL PIPELINE: §5.7 promotion — only the promoted members carry the pack\'s affixes', async () => {
  let championPacks = 0;
  let uniquePacks = 0;
  let normalPacks = 0;
  for (let i = 0; i < 12; i++) {
    const { world, ai, actors } = await bootFullEngine(8300 + i);
    world.setWorldSeed((0xb2c30000 + i) >>> 0);
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });

    for (const pack of world.packs) {
      const members = pack.members.map((r) => actors.resolve(r)).filter(Boolean);
      assert.equal(members.length, pack.count, `pack ${pack.id}: every member resolves`);
      const ranks = members.map((m) => m.rank);

      if (pack.rank === 'normal') {
        normalPacks++;
        assert.deepEqual([...new Set(ranks)], ['normal'], `pack ${pack.id}: a normal pack promotes nobody`);
        assert.equal(pack.affixes.length, 0, `pack ${pack.id}: §5.7 rolls nothing for a normal pack`);
        for (const m of members) assert.equal(ai.affixesOf(m).length, 0);
        continue;
      }

      if (pack.rank === 'champion') {
        championPacks++;
        const promoted = members.filter((m) => m.rank === 'champion');
        assert.equal(promoted.length, Math.min(championCount(pack.count), pack.count),
          `pack ${pack.id}: §5.7's clamp(round(count x 0.35), 2, 5)`);
        assert.equal(pack.affixes.length, 1, `pack ${pack.id}: §5.7 — a champion pack shares ONE rolled affix`);
        for (const m of members) {
          const carried = ai.affixesOf(m);
          if (m.rank === 'champion') {
            assert.deepEqual([...carried], [...pack.affixes], `pack ${pack.id}: every promoted member carries the pack's affix`);
          } else {
            assert.equal(carried.length, 0, `pack ${pack.id}: an un-promoted 'normal' member carries NONE — this is where §5.7 is enforced`);
          }
        }
        continue;
      }

      if (pack.rank === 'unique') {
        uniquePacks++;
        assert.equal(ranks.filter((r) => r === 'unique').length, 1, `pack ${pack.id}: exactly one unique`);
        assert.equal(ranks.filter((r) => r === 'minion').length, pack.count - 1, `pack ${pack.id}: everyone else is a minion`);
        assert.equal(pack.affixes.length, 3, `pack ${pack.id}: §6.5 — three affixes, one per group`);
        assert.equal(new Set(pack.affixes.map((id) => MONSTER_AFFIXES[id].group)).size, 3, `pack ${pack.id}: one per group`);
        for (const m of members) {
          assert.deepEqual([...ai.affixesOf(m)], [...pack.affixes],
            `pack ${pack.id}: §5.7 — "every minion inherits all three" of the unique's`);
        }
      }
    }
  }
  assert.ok(championPacks > 0 && uniquePacks > 0 && normalPacks > 0,
    `the sweep must reach all three pack ranks (champion ${championPacks}, unique ${uniquePacks}, normal ${normalPacks})`);
  console.log(`  §5.7 over 12 real zones: ${normalPacks} normal, ${championPacks} champion, ${uniquePacks} unique packs — promotion and inheritance hold on every one`);
});

test('REAL PIPELINE: §5.8 — the unique, and only the unique, carries a generated name', async () => {
  const names = new Set();
  let uniques = 0;
  for (let i = 0; i < 12; i++) {
    const { world, actors } = await bootFullEngine(8400 + i);
    world.setWorldSeed((0xc3d40000 + i) >>> 0);
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });

    for (const m of actors.all.filter((a) => a.kind === 'monster')) {
      if (m.rank === 'unique') {
        uniques++;
        assert.notEqual(m.name, m.archetypeId, 'a unique is renamed; pool.js seeds name with archetypeId');
        assert.match(m.name, /^.+, .+$/, '§5.8: EPITHET + ", " + TITLE');
        const [epithet] = m.name.split(', ');
        assert.ok(UNIQUE_EPITHETS.includes(epithet), `'${epithet}' is not in §5.8's epithet table`);
        names.add(m.name);
      } else {
        assert.equal(m.name, m.archetypeId, `${m.rank}: only a unique is named (§6.7's name plate row)`);
      }
    }
  }
  assert.ok(uniques > 0, 'the sweep must produce a unique');
  console.log(`  §5.8 through the real pipeline: ${uniques} uniques over 12 zones, ${names.size} distinct names, e.g. "${[...names][0]}"`);
});

test('REAL PIPELINE: the §14.1 draws are deterministic — one seed twice gives identical affixes, names and ranks', async () => {
  const run = async () => {
    const { world, ai, actors } = await bootFullEngine(8500);
    world.setWorldSeed(0xd5e60001);
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 1 });
    return {
      packs: world.packs.map((p) => `${p.id}:${p.rank}:${p.archetypeId}:[${(p.affixes || []).join(',')}]`),
      actors: actors.all.filter((a) => a.kind === 'monster')
        .map((a) => `${a.id}:${a.rank}:${a.archetypeId}:${a.name}:${a.life}:[${ai.affixesOf(a).join(',')}]`),
    };
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a.packs, b.packs, 'the same world seed must roll the same pack affixes');
  assert.deepEqual(a.actors, b.actors, 'and hand the same actors the same affixes, names and life');
  assert.ok(a.actors.length > 0);
  console.log(`  §14.1 determinism: ${a.packs.length} packs and ${a.actors.length} actors identical across two full boots of the same seed`);
});
