// tests/combat/examples.test.js
//
// TEST-5 — the fourteen worked examples of `docs/spec/03-combat-math.md`
// §12, assembled into one file, one test per example, ids `03.E01`..`03.E14`
// (`12-testing.md` §3's assertion-identity convention: `<doc>.<id>`, zero-
// padded to two digits). Every example that is already implemented and
// independently verified (E1-E14, `combat`'s own subsystem tickets CMBT-1
// through CMBT-7) is ASSEMBLED here, not recomputed — this file's own job
// is the ids and the intermediate assertions, per `12-testing.md` §4.2:
// "a pipeline that reaches 39 by two compensating errors passes a
// total-only check and fails this one."
//
// E15 (difficulty scaling) and E16 (potion throughput) are in `03` §12 but
// NOT in this ticket's criterion (`03.E01`-`03.E14`) and have no
// implementation anywhere in M2 — skipped, not asserted as absent (O-27).
//
// ---------------------------------------------------------------------------
// How `combat` is reached — O-51's actual scope, not a blanket ban
// ---------------------------------------------------------------------------
// O-51 is about not letting a sibling import SUBSTITUTE for the runtime
// path: CMBT-2 once shipped methods that were `undefined` at runtime because
// `main.js` imports only `packet.js`, and its own tests passed only because
// they imported the sibling file directly instead of going through
// `CombatSystem`. That failure mode is guarded here by keeping every
// assertion that has a `CombatSystem` surface going through it, exactly as
// `main.js`'s own boot path does: `chanceToHit`/`blockChanceOf` (E1/E2),
// `buildAttackPacket`/`resolve` (E3/E12/E13), `effectiveResist`/`isImmune`
// (E4), `buildSpellPacket` (E5), `computeAttackInterval`/
// `computeCastInterval`/`attackInterval` (E6), `hitRecoveryTime`/`resolve`
// (E7), `resolve` (E11's live cross-check), `xpForMonster` (E10).
//
// It was never meant to stop a test from importing a sibling to EXERCISE it.
// Three examples (E8 chill, E9 rage economy, E11's four zero-knockback-chance
// rows) have no value a live `CombatSystem` call can ever surface — E8/E11's
// own accumulator/distance functions are pure math with no CombatSystem
// method wrapping them at all, and E9's rage-economy chain and E11's
// zero-`knockback%` rows are formula values by construction (a 0%-chance
// knockback roll, or a rage/s figure that is never rolled at all, can never
// be observed through a live resolve()). Those three are driven directly
// through the REAL exported functions of `src/combat/status.js`
// (`accumulateChillPoints`, `CHILL_*`), `src/combat/onhit.js`
// (`BASE_RAGE_ON_HIT`, `rageGainOnHit`) and `src/combat/reaction.js`
// (`computeKnockbackDistance`, `computeMassFactor`, `KNOCKBACK_*`) — never a
// local reimplementation of their formulas. A formula that appears in both
// the spec and the test and nowhere else is not tested; importing the
// sibling and calling ITS function is what actually pins `03 §12`'s printed
// numbers to the shipped implementation, not to this file's own arithmetic.
//
// No `Math.random()` anywhere — every RNG-driven pipeline call below goes
// through `fixtures.makeCombat()`'s deterministic stand-in
// (`fixtures.makeDeterministicRng`), never a real seeded `Rng` roll, so
// "both rolls land on their averages" / "crit does not proc" (E13) and
// "no dodge/block/crit" (E7/E11/E12) are guaranteed outcomes, not
// probabilistic ones — the same discipline this ticket's own rule 3 asks
// for ("a seeded Rng, or... the packet's range endpoints").

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CombatSystem,
  stepB1, stepB3, stepB5, stepB6,
  attributeBonusFor, classScaleFor,
  computeAttackInterval, computeCastInterval,
} from '../../src/combat/packet.js';
import { accumulateChillPoints, CHILL_DECAY_PER_SECOND, CHILL_FREEZE_THRESHOLD, CHILL_DEFAULT_MAGNITUDE } from '../../src/combat/status.js';
import { BASE_RAGE_ON_HIT, rageGainOnHit } from '../../src/combat/onhit.js';
import {
  computeKnockbackDistance, computeMassFactor,
  KNOCKBACK_MASS_REFERENCE, KNOCKBACK_MASS_DIVISOR, KNOCKBACK_MASS_FACTOR_MIN,
} from '../../src/combat/reaction.js';

import * as fixtures from '../fixtures/combat.js';

const { WEAPONS, CLASS_SCALE_TABLE } = fixtures;

const EPS = 1e-4;

function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ===========================================================================
// 03.E01 — Chance to hit (03-combat-math.md §12/E1, all 8 rows)
// ===========================================================================

test('03.E01 — chance to hit, all 8 rows', () => {
  const combat = new CombatSystem();
  for (const [ar, def, alvl, dlvl, expected] of fixtures.E1_ROWS) {
    const got = combat.chanceToHit(ar, def, alvl, dlvl);
    approx(got, expected, `03.E01 chanceToHit(${ar},${def},${alvl},${dlvl})`);
  }

  // E1.7/E1.8: the low/high clamps are genuine, not coincidental.
  const rawLow = (200 * 50 * 5) / ((50 + 900) * (5 + 30));
  assert.ok(rawLow < 5, '03.E01 E1.7: unclamped value must be below the 5% floor for this to be a real clamp');
  const rawHigh = (200 * 5000 * 30) / ((5000 + 10) * (30 + 1));
  assert.ok(rawHigh > 95, '03.E01 E1.8: unclamped value must be above the 95% ceiling for this to be a real clamp');
});

// ===========================================================================
// 03.E02 — Block chance (03-combat-math.md §12/E2, all 5 rows)
// ===========================================================================

test('03.E02 — block chance, all 5 rows', () => {
  const combat = new CombatSystem();
  for (const [blockBase, flat, dex, clvl, expected] of fixtures.E2_ROWS) {
    const actor = fixtures.makeActor({
      classId: null, level: clvl,
      attributes: { dexterity: dex },
      equipment: blockBase === null ? null : { offHand: { blockBase } },
      equipmentStats: { blockChance: flat },
    });
    const got = combat.blockChanceOf(actor);
    approx(got, expected, `03.E02 blockChanceOf(blockBase=${blockBase},flat=${flat},DEX=${dex},clvl=${clvl})`);
  }
});

// ===========================================================================
// 03.E03 — Ravager basic attack, full build pipeline (03-combat-math.md §12/E3)
// ===========================================================================

test('03.E03 — Ravager basic attack, full build pipeline', async () => {
  const { actor } = fixtures.e3();
  approx(actor.stats.strength, 48, '03.E03 fixture sanity: STR 48');
  approx(actor.stats.enhancedDamage, 40, '03.E03 fixture sanity: enhancedDamage 40');
  assert.equal(CLASS_SCALE_TABLE.ravager.meleeScale, 1.0, '03.E03 fixture sanity: Ravager meleeScale');

  const weapon = WEAPONS.axe_battle_normal;
  assert.equal(weapon.minDamage, 10);
  assert.equal(weapon.maxDamage, 22);

  // --- B1/B3/B5/B6, chained on a scratch packet through the REAL exported
  // step functions (all live in packet.js itself — no sibling import). ----
  const scratch = { physMin: 0, physMax: 0 };

  stepB1(scratch, weapon);
  approx((scratch.physMin + scratch.physMax) / 2, 16.0, '03.E03 B1 weapon average');

  stepB3(scratch, actor.stats.enhancedDamage);
  approx((scratch.physMin + scratch.physMax) / 2, 22.4, '03.E03 B3 after enhanced damage');

  const attrBonus = attributeBonusFor(weapon.handling, actor.stats.strength, actor.stats.dexterity);
  approx(attrBonus, 1.48, '03.E03 attribute bonus (1 + 48/100)');
  stepB5(scratch, attrBonus);
  approx((scratch.physMin + scratch.physMax) / 2, 33.152, '03.E03 B5 after attribute bonus');

  stepB6(scratch, classScaleFor(actor.classId).meleeScale, actor.stats.physicalDamagePercent);
  approx((scratch.physMin + scratch.physMax) / 2, 33.152, '03.E03 B6 after class melee scale');
  approx(scratch.physMin, 20.72, '03.E03 B6 physMin (roll lower bound)');
  approx(scratch.physMax, 45.584, '03.E03 B6 physMax (roll upper bound)');

  // --- buildAttackPacket end to end must land on exactly the same chain. -
  const { combat } = await fixtures.makeCombat([actor]);
  const packet = combat.buildAttackPacket(actor, 'attack', 0);
  assert.ok(packet, '03.E03 buildAttackPacket must succeed');
  approx(packet.physMin, 20.72, '03.E03 packet.physMin');
  approx(packet.physMax, 45.584, '03.E03 packet.physMax');

  // --- R6/R7a/R7c and the roll-bounds stream — downstream of B6,
  // resolve-side (03 §6.2) arithmetic. This is an EXPECTED-VALUE figure
  // ("for DPS arithmetic only... never 34.8096" — the doc's own note), not
  // something any single resolved hit computes, so it is reproduced here as
  // plain arithmetic driven ONLY by the packet's own fields — the same
  // precedent tests/combat/packet.test.js's own accepted E3 test already
  // sets for this exact row. ----------------------------------------------
  const avgB6 = (packet.physMin + packet.physMax) / 2;
  approx(avgB6, 33.152, '03.E03 avg after B6');
  const expectedCritMultiplier = (1 - packet.critChance / 100) + (packet.critChance / 100) * (packet.critMult / 100);
  approx(expectedCritMultiplier, 1.05, '03.E03 R6 expected crit multiplier (0.95 + 0.05 x 2.0)');
  const afterR6 = avgB6 * expectedCritMultiplier;
  approx(afterR6, 34.8096, '03.E03 R6 (expected value)');

  const targetFlatDR = 1;
  const targetPhysicalResist = 0;
  const afterR7a = afterR6 - targetFlatDR;
  approx(afterR7a, 33.8096, '03.E03 R7a after flat DR');
  const afterR7c = afterR7a * (1 - targetPhysicalResist / 100);
  approx(afterR7c, 33.8096, '03.E03 R7c after physical resist');

  // Roll-range stream — D-10's own trap: crit (R6) multiplies BEFORE the
  // "-1" discrete-roll adjustment, never after.
  const nonCritMinRoll = packet.physMin - 1;
  approx(nonCritMinRoll, 19.72, '03.E03 non-crit minimum roll');
  const nonCritMaxRoll = packet.physMax - 1;
  approx(nonCritMaxRoll, 44.584, '03.E03 non-crit maximum roll');

  const critMaxRoll = packet.physMax * (packet.critMult / 100) - 1;
  approx(critMaxRoll, 90.1680, '03.E03 critical maximum roll (D-10: 90.1680, not 89.1680)');

  // Negative control (D-10): the TRANSPOSED order (R7a's "-1" BEFORE R6's
  // crit multiply) gives a genuinely different number, exactly 1.0 lower —
  // proving the shipped order is load-bearing, not a coincidence.
  const transposedOrder = (packet.physMax - 1) * (packet.critMult / 100);
  approx(transposedOrder, 89.1680, '03.E03 negative control: transposed R7a-before-R6 order');
  assert.notEqual(critMaxRoll, transposedOrder, '03.E03 D-10: the two orders differ by exactly 1.0');

  combat.releasePacket(packet);
});

// ===========================================================================
// 03.E04 — Elemental damage against resistance (03-combat-math.md §12/E4,
// all 8 rows)
// ===========================================================================

test('03.E04 — elemental damage against resistance, all 8 rows', async () => {
  // "Input: rolled lightning 17.0000, critMult expectation 1.05, spellScale
  // 0.95, no pierce" — the pre-resistance figure every row starts from.
  const preResist = 17.0 * 1.05 * 0.95;
  approx(preResist, 16.9575, '03.E04 sanity: pre-resistance figure the table starts from');

  const target = fixtures.makeActor({ classId: null, kind: 'monster', team: 1 });
  const { combat } = await fixtures.makeCombat([target]);

  // The six pierce-free rows: combat.isImmune() reads the RAW target
  // resist with no pierce parameter at all (02-api-contracts.md's own
  // documented signature), so it is only meaningful when pierce=0 — E4.7
  // (pierce=30) is asserted separately below, through effectiveResist()
  // directly, matching tests/combat/resolve.test.js's own precedent
  // exactly (see that file's header on why the two methods split this way).
  const rows = [
    [0, 0, 16.9575, false], // E4.1
    [20, 0, 13.5660, false], // E4.2
    [50, 0, 8.4788, false], // E4.3
    [75, 0, 4.2394, false], // E4.4
    [90, 0, 4.2394, false], // E4.5 — cap at 75
    [100, 0, 0, true], // E4.6 — immune
    [-50, 0, 25.4363, false], // E4.8 — negative resist amplifies
  ];

  for (const [targetResist, pierce, expectedDamage, expectImmune] of rows) {
    target.stats.lightResist = targetResist;
    const immune = combat.isImmune(target, 'lightning');
    assert.equal(immune, expectImmune, `03.E04 isImmune(lightResist=${targetResist})`);
    if (immune) {
      assert.equal(expectedDamage, 0, '03.E04 an immune component deals 0');
      continue;
    }
    const effective = combat.effectiveResist(target, 'lightning', pierce);
    // R10: damage x (1 - effectiveResist/100) — 03 §6.2's own one-line
    // formula, applied to the packet-independent pre-resistance figure
    // above (this row is about the resistance mechanic in isolation, not a
    // resolved hit — see this file's own header).
    const damage = preResist * (1 - effective / 100);
    approx(damage, expectedDamage, `03.E04 damage(lightResist=${targetResist},pierce=${pierce})`);
  }

  // E4.7 — pierce breaks immunity. `isImmune()` alone would (correctly)
  // still report `true` here, since a raw 100% resist IS immune "on its
  // own, pierce or not" — the pierce only lowers the EFFECTIVE resist
  // that `effectiveResist()` reports, a genuinely different question. Both
  // are asserted explicitly so the split itself is visible.
  target.stats.lightResist = 100;
  assert.equal(combat.isImmune(target, 'lightning'), true, '03.E04 E4.7 sanity: raw 100 resist is immune on its own, pierce or not');
  const piercedEffective = combat.effectiveResist(target, 'lightning', 30);
  approx(piercedEffective, 70, '03.E04 E4.7 effectiveResist post-pierce (100 - 30, not immune)');
  const piercedDamage = preResist * (1 - piercedEffective / 100);
  approx(piercedDamage, 5.0873, '03.E04 E4.7 pierce breaks immunity — damage gets through');

  // E4.5: the 75 cap is a genuine clamp, not a coincidence.
  const uncapped = preResist * (1 - 90 / 100);
  const capped = preResist * (1 - 75 / 100);
  assert.ok(uncapped < capped, '03.E04 an uncapped 90% resist would reduce damage MORE than the capped 75%');
});

// ===========================================================================
// 03.E05 — Poison as a total (03-combat-math.md §12/E5)
// ===========================================================================

test('03.E05 — poison as a total', async () => {
  const { actor } = fixtures.e5();
  approx(actor.stats.poisonMin, 30, '03.E05 fixture sanity: poisonMin');
  approx(actor.stats.poisonMax, 54, '03.E05 fixture sanity: poisonMax');
  approx(actor.stats.poisonDuration, 2.0, '03.E05 fixture sanity: poisonDuration stat');
  assert.equal(CLASS_SCALE_TABLE.emberwright.spellScale, 1.0, '03.E05 fixture sanity: Emberwright spellScale');

  const { combat } = await fixtures.makeCombat([actor]);
  const packet = combat.buildSpellPacket(actor, 'test_poison_bolt', 1);
  assert.ok(packet, '03.E05 buildSpellPacket must succeed');
  approx(packet.poisonMin, 30.0, '03.E05 packet poisonMin');
  approx(packet.poisonMax, 54.0, '03.E05 packet poisonMax');
  approx(packet.poisonDuration, 6.0, '03.E05 Duration: 4.0 + 2.0 = 6.0 s');

  // Downstream (tick-side) arithmetic, reproduced ONLY from this packet's
  // own fields plus the example's given roll/resist — same precedent
  // tests/combat/packet.test.js's own accepted E5 test already sets.
  const roll = (packet.poisonMin + packet.poisonMax) / 2; // "roll lands on the average"
  approx(roll, 42.0, '03.E05 roll lands on the average 42');
  const poisonResist = 50;
  const appliedTotal = roll * (1 - poisonResist / 100);
  approx(appliedTotal, 21.0, '03.E05 Applied total: 42 x (1 - 0.50) = 21.0000');
  const magnitude = appliedTotal / packet.poisonDuration;
  approx(magnitude, 3.5, '03.E05 Magnitude (damage/s): 21.0 / 6.0 = 3.5000');
  const tickCount = packet.poisonDuration * 4; // 4 Hz
  assert.equal(tickCount, 24, '03.E05 Tick count at 4 Hz: 24');
  const damagePerTick = appliedTotal / tickCount;
  approx(damagePerTick, 0.8750, '03.E05 Damage per tick: 0.8750');

  combat.releasePacket(packet);
});

// ===========================================================================
// 03.E06 — Attack and cast intervals (03-combat-math.md §12/E6, all 11 rows)
// ===========================================================================

test('03.E06 — attack and cast intervals, all 11 rows', async () => {
  for (const [base, classScale, skillScale, ias, expected] of fixtures.E6_ATTACK_ROWS) {
    approx(computeAttackInterval(base, classScale, skillScale, ias), expected, `03.E06 attackInterval(base=${base},classScale=${classScale},skillScale=${skillScale},ias=${ias})`);
  }
  for (const [base, classScale, fcr, expected] of fixtures.E6_CAST_ROWS) {
    approx(computeCastInterval(base, classScale, fcr), expected, `03.E06 castInterval(base=${base},classScale=${classScale},fcr=${fcr})`);
  }

  // E6.6/E6.11: the IAS/FCR clamps are genuine.
  approx(computeAttackInterval(0.75, 0.90, 1.00, 5000), 0.2500, '03.E06 IAS beyond the cap clamps the same as exactly the cap');
  approx(computeCastInterval(0.70, 0.85, 9999), 0.1983, '03.E06 FCR beyond the cap clamps the same as exactly the cap');

  // Wiring cross-check: attackInterval(actor, skillId) through the real
  // CombatSystem method, reproducing E6.1 end to end.
  const actor = fixtures.makeActor({
    classId: 'ravager',
    equipment: { mainHand: WEAPONS.axe_battle_normal },
  });
  const { combat } = await fixtures.makeCombat([actor]);
  approx(combat.attackInterval(actor, null), 0.6750, '03.E06 attackInterval(actor) live cross-check — E6.1');
});

// ===========================================================================
// 03.E07 — Hit recovery (03-combat-math.md §12/E7, all 5 rows + threshold)
// ===========================================================================

test('03.E07 — hit recovery, all 5 rows + trigger threshold', async () => {
  const bareCombat = new CombatSystem();
  for (const [fhr, expected] of fixtures.E7_ROWS) {
    const actor = fixtures.makeActor({ classId: null, equipmentStats: { fasterHitRecovery: fhr } });
    approx(bareCombat.hitRecoveryTime(actor), expected, `03.E07 hitRecoveryTime(FHR=${fhr})`);
  }

  // Trigger threshold: "8.0 damage on 165 life does NOT trigger (4.85% <
  // 5%); 8.5 DOES (5.15%)." `03 §6.2` R13 unconditionally
  // `Math.floor()`s `result.total` (verified directly: E13's own "R13
  // total = 39.0188, floored -> 39" row) — a LIVE `combat.resolve()` call
  // can therefore never surface a fractional total like `8.5` at all,
  // which is exactly why `tests/combat/reaction.test.js`'s own accepted
  // test for this identical row hand-builds `result.total: 8.5` directly
  // rather than driving it through `resolveDamage()`. The doc's own
  // `damageThisHit > 0.05 x maxLife` trigger formula (`03` §7.11) is
  // reproduced here the same way, then cross-checked live (below) with
  // integer-safe numbers the floor cannot corrupt, to prove the real
  // wiring (not just the formula) actually reads `result.total` and enters
  // hitstun.
  const belowPercent = (8.0 / 165) * 100;
  const abovePercent = (8.5 / 165) * 100;
  approx(belowPercent, 4.8485, '03.E07 below-threshold percent, sanity');
  approx(abovePercent, 5.1515, '03.E07 above-threshold percent, sanity');

  function triggers(damageThisHit, maxLife) {
    return damageThisHit > 0.05 * maxLife;
  }
  assert.equal(triggers(8.0, 165), false, '03.E07 8.0 damage on 165 life does NOT trigger (4.85% < 5%)');
  assert.equal(triggers(8.5, 165), true, '03.E07 8.5 damage on 165 life DOES trigger (5.15% > 5%)');

  // Live cross-check, integer-safe (R13's floor cannot corrupt a whole
  // number): maxLife 100, 4 damage (4%, below) vs. 6 damage (6%, above),
  // driven end to end through combat.resolve(), the real wired pipeline
  // (packet.js only).
  const attacker = fixtures.makeActor({ kind: 'player', team: 0 });
  const target = fixtures.makeActor({ team: 1, maxLife: 100, life: 1000 });
  const { combat } = await fixtures.makeCombat([attacker, target]);

  for (const [dmg, expectedTrigger] of [[4, false], [6, true]]) {
    const packet = combat.scratchPacket();
    Object.assign(packet, {
      sourceId: attacker.id, sourceGen: attacker.generation, team: attacker.team,
      attackRating: 0, blockable: false, dodgeable: false, critChance: 0, critMult: 100,
      knockback: 0, physMin: dmg, physMax: dmg,
    });
    const result = combat.resolve(packet, target);
    assert.equal(result.outcome, 'hit', `03.E07 damage=${dmg} must land as a hit`);
    assert.equal(result.total, dmg, `03.E07 live cross-check: an integer roll survives R13's floor unchanged`);
    assert.equal(result.hitRecovery, expectedTrigger, `03.E07 live cross-check: trigger at damage=${dmg}/maxLife=100`);
    combat.releasePacket(packet);
    // Reset the immunity window between the two probes so the second one
    // is not spuriously refused by the first.
    target.hitstunImmuneUntil = 0;
    target.state = 'idle';
  }
});

// ===========================================================================
// 03.E08 — Chill accumulation to freeze (03-combat-math.md §12/E8, all 4 rows)
// ===========================================================================

test('03.E08 — chill accumulation to freeze, all 4 rows', () => {
  // Driven through the REAL src/combat/status.js#accumulateChillPoints
  // (03 §7.3) — not a local reimplementation. CHILL_DEFAULT_MAGNITUDE (30)
  // and CHILL_FREEZE_THRESHOLD (100) are that file's own exported constants,
  // sanity-checked against the doc below, then used as-is.
  approx(CHILL_DEFAULT_MAGNITUDE, 30, '03.E08 sanity: CHILL_DEFAULT_MAGNITUDE (03 §7.3)');
  approx(CHILL_DECAY_PER_SECOND, 25, '03.E08 sanity: CHILL_DECAY_PER_SECOND (03 §7.3)');
  approx(CHILL_FREEZE_THRESHOLD, 100, '03.E08 sanity: CHILL_FREEZE_THRESHOLD (03 §7.3)');

  for (const row of fixtures.E8_ROWS) {
    let chillPoints = 0;
    const got = [];
    let frozenOnHit = null;
    for (let hit = 1; hit <= row.expected.length; hit++) {
      // First hit: no prior hit at all -> full decay (dtSeconds = Infinity) —
      // accumulateChillPoints' own documented "no prior hit" contract.
      const dt = hit === 1 ? Infinity : row.intervalSeconds;
      chillPoints = accumulateChillPoints(chillPoints, CHILL_DEFAULT_MAGNITUDE, dt);
      got.push(chillPoints);
      if (frozenOnHit === null && chillPoints >= CHILL_FREEZE_THRESHOLD) {
        frozenOnHit = hit;
        chillPoints = 0; // 03 §7.3: "set chillPoints = 0" — consumed on trigger
      }
    }
    for (let i = 0; i < row.expected.length; i++) {
      approx(got[i], row.expected[i], `03.E08 ${row.name} hit #${i + 1}`);
    }
    assert.equal(frozenOnHit, row.freezeOnHit, `03.E08 ${row.name} freeze trigger`);
  }
});

// ===========================================================================
// 03.E09 — Rage economy (03-combat-math.md §12/E9, D-9 corrected)
// ===========================================================================

test('03.E09 — rage economy, D-9 corrected chain', () => {
  // D-9: "0.778146 x 6 / 0.675 = 6.9161" is arithmetically wrong for its
  // own exact inputs. The multiplier is exactly E1.1's hit chance, so the
  // input is exact; the correct value is 6.9169. Derived here from the REAL
  // functions (chanceToHit, computeAttackInterval), not pasted literals —
  // and the "+6 rage per landed hit" figure itself is the REAL
  // src/combat/onhit.js#BASE_RAGE_ON_HIT constant (via rageGainOnHit(0), no
  // gear bonus), not a restated literal.
  const combat = new CombatSystem();
  const hitChancePercent = combat.chanceToHit(235, 67, 10, 10);
  approx(hitChancePercent, 77.8146, '03.E09 sanity — E1.1, the level-10 Ravager\'s own hit chance');
  const attackInterval = computeAttackInterval(0.75, 0.90, 1.00, 0);
  approx(attackInterval, 0.6750, '03.E09 sanity — E6.1, the level-10 Ravager swing interval');

  const hitChance = hitChancePercent / 100;
  approx(hitChance, 0.778146, '03.E09 the spec\'s own "0.778146" input, reproduced from chanceToHit()');

  assert.equal(BASE_RAGE_ON_HIT, 6, '03.E09 sanity: onhit.js#BASE_RAGE_ON_HIT (03 §2.4: "+6 rage per landed hit")');
  const rageOnLandedHit = rageGainOnHit(0); // no rageOnHit gear bonus — the reference build's own case
  assert.equal(rageOnLandedHit, 6);
  const ragePerSecond = (hitChance * rageOnLandedHit) / attackInterval;

  const printedButWrong = 6.9161;
  assert.notEqual(
    Number(ragePerSecond.toFixed(4)), printedButWrong,
    '03.E09 D-9: must NOT reproduce the spec\'s own typo\'d 6.9161',
  );
  approx(ragePerSecond, 6.9169, '03.E09 D-9 corrected: rage/s = 0.778146 x 6 / 0.675');

  const cleavingStrikeEvery = 9 / ragePerSecond; // cleaving_strike costs 9 rage
  approx(cleavingStrikeEvery, 1.3012, '03.E09 D-9 corrected: cleaving_strike castable every');

  const whirlwindNet = ragePerSecond - 12; // whirlwind drains 12 rage/s
  approx(whirlwindNet, -5.0831, '03.E09 D-9 corrected: whirlwind net drain');

  const channelFromFull = 100 / Math.abs(whirlwindNet); // 100 max rage
  assert.equal(channelFromFull.toFixed(2), '19.67', '03.E09 channel duration from full 100 rage (unchanged at 2dp)');

  const outOfCombatDecay = 100 / 8; // 8 rage/s decay out of combat
  approx(outOfCombatDecay, 12.5, '03.E09 out-of-combat decay 100->0 (unchanged)');
});

// ===========================================================================
// 03.E10 — Experience awards (03-combat-math.md §12/E10, all 8 rows, exact)
// ===========================================================================

test('03.E10 — experience awards, all 8 rows (exact)', () => {
  const combat = new CombatSystem();
  for (const [mlvl, rank, baseXp, clvl, difficulty, expected] of fixtures.E10_ROWS) {
    const got = combat.xpForMonster(mlvl, rank, baseXp, clvl, difficulty);
    // E10's own rows are integers and must be exact — 03 §12's preamble.
    assert.equal(got, expected, `03.E10 xpForMonster(mlvl=${mlvl},rank=${rank},baseXp=${baseXp},clvl=${clvl},${difficulty})`);
  }
});

// ===========================================================================
// 03.E11 — Knockback distance (03-combat-math.md §12/E11, all 5 rows +
// a live cross-check)
// ===========================================================================

test('03.E11 — knockback distance, all 5 rows + live cross-check', async () => {
  // Driven through the REAL src/combat/reaction.js#computeKnockbackDistance
  // (03 §7.12) for all five rows — not a local reimplementation. Every row
  // but E11.3 uses knockback=0 (a 0%-chance roll can never actually fire
  // through a live resolve(), exactly as 03's own table frames it: "Distance
  // at knockback = 0"), so calling the real function directly, rather than
  // trying to roll it live, is the only way to pin these four to the
  // shipped code at all; E11.3 is ADDITIONALLY cross-checked live, end to
  // end, through combat.resolve() below.
  for (const [knockback, mass, expected] of fixtures.E11_ROWS) {
    approx(computeKnockbackDistance(knockback, mass), expected, `03.E11 knockback=${knockback} mass=${mass}`);
  }

  // E11.5: the mass-70 term alone goes NEGATIVE at mass 400 — the floor is
  // doing real work, not coincidence. computeMassFactor is the same real
  // export reaction.js's own applyReaction() calls internally.
  const rawMassTerm = 1 - (400 - KNOCKBACK_MASS_REFERENCE) / KNOCKBACK_MASS_DIVISOR;
  approx(rawMassTerm, -0.65, '03.E11 raw (pre-clamp) mass term at mass 400');
  assert.ok(rawMassTerm < KNOCKBACK_MASS_FACTOR_MIN, '03.E11 raw term must fall below the floor for the clamp to matter');
  approx(computeMassFactor(400), KNOCKBACK_MASS_FACTOR_MIN, '03.E11 computeMassFactor(400) is genuinely clamped to the floor');

  // Live cross-check — E11.3 (knockback 100, mass 78), driven end to end
  // through combat.resolve(), the real wired pipeline (packet.js only).
  const attacker = fixtures.makeActor({ kind: 'player', team: 0, x: -5, z: 0 });
  const target = fixtures.makeActor({ team: 1, mass: 78, x: 0, z: 0, maxLife: 100000, life: 100000 });
  // draw100 = 1 < any positive knockback% -> the roll always succeeds.
  const { combat, actorsSystem } = await fixtures.makeCombat([attacker, target], 0.01);

  const packet = combat.scratchPacket();
  Object.assign(packet, {
    sourceId: attacker.id, sourceGen: attacker.generation, team: attacker.team,
    attackRating: 0, blockable: false, dodgeable: false, critChance: 0, critMult: 100,
    physMin: 1, physMax: 1, // below the hitstun threshold, isolating knockback
    knockback: 100,
  });
  const result = combat.resolve(packet, target);
  assert.equal(result.outcome, 'hit');
  assert.equal(result.knockedBack, true, '03.E11 live cross-check: the knockback roll must succeed');
  assert.equal(actorsSystem.calls.applyImpulse.length, 1, '03.E11 exactly one applyImpulse call');
  const impulse = actorsSystem.calls.applyImpulse[0];
  const speed = Math.sqrt(impulse.dx * impulse.dx + impulse.dz * impulse.dz);
  approx(speed * impulse.seconds, 1.0560, '03.E11 live cross-check reproduces E11.3\'s 1.0560m through the real pipeline');
  combat.releasePacket(packet);
});

// ===========================================================================
// 03.E12 — Mitigation ordering (03-combat-math.md §12/E12, all 3 steps +
// the reversed-order negative control)
// ===========================================================================

test('03.E12 — mitigation ordering, all 3 steps + reversed-order negative control', async () => {
  const attacker = fixtures.makeActor({ kind: 'player', team: 0 });
  // Three targets, each carrying one more mitigation layer than the last —
  // resolving the SAME fixed 100.0000 physical roll against each reveals
  // R7a, then R7a+R7b, then R7a+R7b+R7c as genuine intermediate output of
  // the REAL combat.resolve() pipeline (packet.js only), not a call into
  // resolve.js's own stepR7a/stepR7b/stepR7c (a combat sibling).
  const targetFlatOnly = fixtures.makeActor({ team: 1, equipmentStats: { damageReduceFlat: 12 }, maxLife: 100000, life: 100000 });
  const targetFlatPercent = fixtures.makeActor({ team: 1, equipmentStats: { damageReduceFlat: 12, damageReducePercent: 25 }, maxLife: 100000, life: 100000 });
  const targetAll = fixtures.makeActor({ team: 1, equipmentStats: { damageReduceFlat: 12, damageReducePercent: 25, physicalResist: 30 }, maxLife: 100000, life: 100000 });

  const { combat } = await fixtures.makeCombat([attacker, targetFlatOnly, targetFlatPercent, targetAll]);

  function resolveFixedPhysical(target) {
    const packet = combat.scratchPacket();
    Object.assign(packet, {
      sourceId: attacker.id, sourceGen: attacker.generation, team: attacker.team,
      attackRating: 0, blockable: false, dodgeable: false, critChance: 0, critMult: 100,
      knockback: 0, physMin: 100.0, physMax: 100.0,
    });
    const result = combat.resolve(packet, target);
    combat.releasePacket(packet);
    return result;
  }

  const afterR7a = resolveFixedPhysical(targetFlatOnly);
  approx(afterR7a.physical, 88.0, '03.E12 R7a: 100 - 12');

  const afterR7b = resolveFixedPhysical(targetFlatPercent);
  approx(afterR7b.physical, 66.0, '03.E12 R7b: 88 x 0.75');

  const afterR7c = resolveFixedPhysical(targetAll);
  approx(afterR7c.physical, 46.2, '03.E12 R7c: 66 x 0.70');

  // Negative control — 03's own note: "Reversing the order would give
  // 100 x 0.70 x 0.75 - 12 = 40.5000." This can only be a hypothetical (the
  // real, correctly-ordered pipeline never produces it) — reproduced as
  // plain arithmetic, then checked to genuinely differ from the real
  // 46.2 result, proving the shipped order is load-bearing.
  const reversed = 100 * 0.70 * 0.75 - 12;
  approx(reversed, 40.5, '03.E12 negative control: reversed order (R7c/R7b before R7a)');
  assert.notEqual(afterR7c.physical, reversed, '03.E12 the real pipeline\'s 46.2 differs from the reversed-order 40.5');
});

// ===========================================================================
// 03.E13 — Full resolve, level-10 Runeblade imbued hit (03-combat-math.md
// §12/E13). 12-testing.md §4.2's own snippet: `fixtures.e13()`.
// ===========================================================================

test('03.E13 — level-10 Runeblade imbued hit', async () => {
  const { source, target } = fixtures.e13();
  // next()=0.5 -> draw100=50: hits (50 < 78.1759%), no crit (50 is not <
  // 5), no dodge/block (both stats are 0 on this target) — "both rolls
  // land on their averages... crit does not proc," exactly as 03's own
  // prose states, guaranteed by the deterministic rng, not by chance.
  const { combat } = await fixtures.makeCombat([source, target], 0.5);

  const packet = combat.buildAttackPacket(source, 'rune_strike', 5);
  assert.ok(packet, '03.E13 buildAttackPacket must succeed');

  const b1 = (WEAPONS.sword_rune_normal.minDamage + WEAPONS.sword_rune_normal.maxDamage) / 2;
  approx(b1, 12.5, '03.E13 B1 weapon average');
  const b3 = b1 * 1.35; // enhancedDamage 35
  approx(b3, 16.875, '03.E13 B3 x1.35');
  const b5 = b3 * 1.40; // STR 40, oneHandMelee -> 1 + 40/100
  approx(b5, 23.625, '03.E13 B5 x1.40');
  const b6 = b5 * 0.95; // Runeblade meleeScale
  approx(b6, 22.4438, '03.E13 B6 x0.95');
  approx((packet.physMin + packet.physMax) / 2, b6, '03.E13 packet\'s own physical average matches the B1-B6 chain exactly');

  approx((12 + 25) / 2, 18.5, '03.E13 Lightning roll (raw blade_seal flatDamage average, pre class-scale)');
  approx((packet.lightMin + packet.lightMax) / 2, 17.575, '03.E13 B6 lightning x0.95 — from the REAL pipeline (stepB6Elemental)');

  // D-16: 03's own prose says "AR 230," but its printed "Hit chance
  // 78.1759%" row is exactly E1.2's value (AR 240) — the numeric row is
  // trusted over the prose, per this ticket's brief.
  packet.attackRating = 240;
  packet.team = source.team;

  const result = combat.resolve(packet, target);

  assert.equal(result.outcome, 'hit');
  assert.equal(result.crit, false);

  approx(result.physical, 21.4438, '03.E13 R7a: 22.4438 - 1 (flatDR), no R7b/R7c (both 0)');
  approx(result.lightning, 17.575, '03.E13 R10 lightning x1.00 (resist 0)');

  const totalRaw = result.physical + result.lightning;
  approx(totalRaw, 39.0188, '03.E13 R13 total = 21.4438 + 17.5750');
  assert.equal(result.total, 39, '03.E13 R13 floored');

  const cth = combat.chanceToHit(240, 67, 10, 10);
  approx(cth, 78.1759, '03.E13 Hit chance');

  approx(result.manaReturned, 1.7155, '03.E13 manaReturned = 21.4438 x 0.08');

  // Resonance gained: +1. 12-testing.md §4.2's own illustrative snippet
  // names `result.resonanceGained`, but the accepted implementation
  // (CMBT-7, src/combat/onhit.js) credits Resonance onto the ACTOR record
  // (`source.resonance`), not onto the DamageResult — DamageResult carries
  // no such field (see tests/combat/onhit.test.js's own "Criterion #2").
  // Asserted here against the real, wired location; see this file's own
  // report for why this is a documented deviation from the snippet's own
  // (pre-implementation) illustrative field name, not a gap.
  assert.equal(source.resonance, 1, '03.E13 Resonance gained: +1 (credited to source.resonance)');

  combat.releasePacket(packet);
});

// ===========================================================================
// 03.E14 — Composed stat block, level-13 Ravager (03-combat-math.md §12/E14,
// all 11 rows)
// ===========================================================================

test('03.E14 — composed stat block, level-13 Ravager, all 11 rows', () => {
  const { actor, weaponAR, rareAffixAR } = fixtures.e14();
  assert.equal(weaponAR, 80, '03.E14 sanity: Battle Axe base AR (03 §4.6) — the mysterious "+80"');
  assert.equal(rareAffixAR, 25, '03.E14 sanity: rare affix AR');

  const s = actor.stats;
  approx(s.strength, 54, '03.E14 strength: 30 + 2x12');
  approx(s.dexterity, 32, '03.E14 dexterity: 20 + 1x12');
  approx(s.vitality, 49, '03.E14 vitality: 25 + 2x12');
  approx(s.maxLife, 210, '03.E14 maxLife: 55 + (49-25)x4.0 + 12x2.0 + 35');
  approx(s.maxMana, 16, '03.E14 maxMana: 10 + (10-10)x1.0 + 12x0.5');
  approx(s.attackRating, 260, '03.E14 attackRating: 30 + 5x(32-7) + 80 + 25');
  approx(s.defense, 218, '03.E14 defense: 210 + floor(32/4)');
  approx(s.fireResist, -22, '03.E14 fireResist: 0 + 18 - 40 (Trial)');
  approx(s.lifeRegen, 1.260, '03.E14 lifeRegen: 210 x 0.006');
  approx(s.manaRegen, 0.320, '03.E14 manaRegen: 16 x 0.020');
  approx(s.maxStamina, 121, '03.E14 maxStamina: 60 + 49 + 12');

  // The axe's +55% ED is carried on the block but must never leak into a
  // derived row — asserted both directly (it IS present) and indirectly
  // (attackRating above is exactly 260, not inflated by it).
  approx(s.enhancedDamage, 55, '03.E14 enhancedDamage (carried, not a derive() input)');
});
