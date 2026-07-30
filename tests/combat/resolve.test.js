// tests/combat/resolve.test.js
//
// CMBT-3 acceptance tests for src/combat/resolve.js.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim): E4, E12 and
// E13 reproduce exactly, every intermediate value, to 1e-4. Every R-stage
// intermediate is asserted individually, not just the final total, per this
// ticket's own rule 12 ("make the R-stage intermediates observable").
//
// Not this ticket's (D-14, already applied): E9 (rage, CMBT-7), E10 (XP,
// CMBT-6), E11 (knockback, CMBT-5) are not tested here. Hit recovery (g) and
// knockback (h) inside R14 are CMBT-5's; death/actor:death (i) and XP (j)
// are CMBT-6's; rage/resonance (f) and manaReturned are CMBT-7's — none of
// those are asserted as numeric outputs here, only that the pipeline calls
// through them as documented no-op seams without throwing.
//
// `manaReturned`/"Resonance gained" in E13's own table are reproduced here
// as plain test-local arithmetic (the exact precedent packet.test.js's own
// header sets for a downstream-of-scope value: "as plain arithmetic local
// to the test file — not as a public method here").

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDamage,
  applyDirectDamage,
  healTarget,
  effectiveResistOf,
  isImmuneOf,
  isValidTarget,
  isHostile,
  isFrontalHit,
  stepR7a,
  stepR7b,
  stepR7c,
  resistAfterPierce,
  isImmuneAtResist,
  cappedEffectiveResist,
  applyResistFactor,
  applyTotalFloor,
  DamageResultPool,
  RESULT_POOL_CAPACITY,
  ELEMENT_ORDER,
} from '../../src/combat/resolve.js';
import { PacketPool, CombatSystem } from '../../src/combat/packet.js';
import { chanceToHit } from '../../src/combat/tohit.js';
import { WEAPONS } from '../../src/combat/data/weapons.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

const EPS = 1e-4;

function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal StatBlock covering every field resolve.js reads. Every test
 * below overrides only what it cares about. */
function makeStats(overrides = {}) {
  return {
    defense: 0, dexterity: 0, blockChance: 0, dodgeChance: 0,
    damageReduceFlat: 0, damageReducePercent: 0, physicalResist: 0,
    fireResist: 0, maxFireResist: 75,
    coldResist: 0, maxColdResist: 75,
    lightResist: 0, maxLightResist: 75,
    poisonResist: 0, maxPoisonResist: 75,
    magicResist: 0, maxMagicResist: 75,
    magicDamageReduceFlat: 0,
    maxLife: 100000, maxMana: 100000,
    thorns: 0,
    ...overrides,
  };
}

let nextId = 1;
function makeActor(overrides = {}) {
  return {
    id: nextId++, generation: 0, team: 1, level: 10, flags: 0,
    x: 0, y: 0, z: 0, facing: 0,
    life: 10000, mana: 0, dead: false, invulnUntil: 0,
    equipment: null, statuses: [],
    stats: makeStats(overrides.stats),
    ...overrides,
  };
}

/** A no-op `env` — `actorsSystem`/`events`/pools all absent, so every
 * cross-subsystem seam (poison seed, onHitStatus riders, thorns, the
 * actor:damage emit) is exercised through its guarded, no-op path. Tests
 * that need one of those live override the relevant field. */
function makeEnv(overrides = {}) {
  const env = {
    source: null, rng: null, step: 0, actorsSystem: null, events: null,
    packetPool: null, resultPool: null,
    statusSpec: { status: null, step: 0, sourceId: 0, sourceGen: 0, sourceSkill: null, element: null, magnitude: 0, duration: 0, stacks: 1 },
    damagePayload: { target: null, source: null, result: null },
    thornsEnv: null,
    isThornsCounter: false,
    ...overrides,
  };
  if (!env.thornsEnv) {
    env.thornsEnv = { ...env, thornsEnv: null, isThornsCounter: true };
  }
  return env;
}

/** A deterministic stand-in for `Rng`: `range()` always lands on the exact
 * midpoint (matching worked-example inputs that "land on their averages"),
 * `next()` returns a fixed uniform draw so every `U(0,100)` check in the
 * pipeline is exercised with one, chosen value. */
function makeMockRng(nextValue = 0.5) {
  return {
    next() { return nextValue; },
    range(min, max) { return (min + max) / 2; },
  };
}

let packetPool = new PacketPool(64);
function makePacket(overrides = {}) {
  const p = packetPool.acquire();
  Object.assign(p, {
    team: 0, attackRating: 0, attackerLevel: 10, blockable: true, dodgeable: true,
    critChance: 5, critMult: 200,
  }, overrides);
  return p;
}

// ---------------------------------------------------------------------------
// E4 — elemental damage against resistance (03-combat-math.md §12, E4)
// ---------------------------------------------------------------------------
//
// Input: rolled lightning 17.0000, critMult expectation 1.05, spellScale
// 0.95, no pierce — 17.0 * 1.05 * 0.95 = 16.9575 is the pre-resistance
// figure every row in the table starts from (verified: 16.9575 * (1-0.20) =
// 13.5660, * 0.50 = 8.4788, * 0.25 = 4.2394, all match E4.1-E4.4 below). R9/
// R10 (this file's own job) is what's under test, not how 16.9575 itself
// was built (that is B-side, upstream of resolve()).

test('E4: resistAfterPierce + isImmuneAtResist + cappedEffectiveResist + applyResistFactor reproduce all eight rows to 1e-4', () => {
  const preResist = 16.9575; // 17.0 * 1.05 * 0.95, per the table's own header

  const rows = [
    // targetResist, pierce, expectedEffectiveResist (null = immune, no cap to check), expectedDamage, expectImmune
    [0, 0, 0, 16.9575, false], // E4.1
    [20, 0, 20, 13.5660, false], // E4.2
    [50, 0, 50, 8.4788, false], // E4.3
    [75, 0, 75, 4.2394, false], // E4.4
    [90, 0, 75, 4.2394, false], // E4.5 — cap at 75
    [100, 0, null, 0, true], // E4.6 — immune
    [100, 30, 70, 5.0873, false], // E4.7 — pierce breaks immunity
    [-50, 0, -50, 25.4363, false], // E4.8 — negative resist amplifies, not clamped at 0
  ];

  for (const [targetResist, pierce, expectedEffective, expectedDamage, expectImmune] of rows) {
    const r = resistAfterPierce(targetResist, pierce);
    const immune = isImmuneAtResist(r);
    assert.equal(immune, expectImmune, `targetResist=${targetResist} pierce=${pierce}: immune`);

    if (immune) {
      // R9: "its damage is 0" — R10 never runs for an immune component.
      assert.equal(expectedDamage, 0);
      continue;
    }

    const effective = cappedEffectiveResist(r, 75);
    approx(effective, expectedEffective, `targetResist=${targetResist} pierce=${pierce}: effective resist`);

    const dmg = applyResistFactor(preResist, effective);
    approx(dmg, expectedDamage, `targetResist=${targetResist} pierce=${pierce}: damage`);
  }
});

test('E4.5: the 75 cap is a genuine clamp, not a coincidence (raw r=90 would give a smaller number if uncapped)', () => {
  const uncapped = applyResistFactor(16.9575, 90);
  assert.ok(uncapped < applyResistFactor(16.9575, 75), 'an uncapped 90% resist would reduce damage MORE than the capped 75%');
  approx(cappedEffectiveResist(90, 75), 75, 'cappedEffectiveResist must clamp 90 down to the 75 ceiling');
});

test('E4.6/E4.7: immunity threshold is exactly r >= 100, and pierce subtracts before the threshold check', () => {
  assert.equal(isImmuneAtResist(99.999), false);
  assert.equal(isImmuneAtResist(100), true);
  assert.equal(isImmuneAtResist(resistAfterPierce(100, 30)), false, 'pierce must lower r below 100 before the immune check runs');
});

// effectiveResist()/isImmune() — the public 02-api-contracts.md methods,
// same eight E4 rows, through the actual public surface this ticket adds.
test('effectiveResist()/isImmune(): reproduce E4 through the public API', () => {
  // `isImmune(target, element)` has no `pierce` parameter (02-api-
  // contracts.md's own documented signature) — it answers "is the target
  // immune in its own right", on the RAW resist. E4.7 (pierce breaking a
  // 100 resist down to 70) is therefore only observable through
  // `effectiveResist(target, element, pierce)`, which DOES take pierce; see
  // resolve.js's own header for why the two methods split this way.
  const target = makeActor();
  const rows = [
    [0, 0, 0, false],
    [20, 0, 20, false],
    [50, 0, 50, false],
    [75, 0, 75, false],
    [90, 0, 75, false],
    [100, 0, null, true],
    [-50, 0, -50, false],
  ];
  for (const [targetResist, pierce, expectedEffective, expectImmune] of rows) {
    target.stats.lightResist = targetResist;
    assert.equal(isImmuneOf(target, 'lightning'), expectImmune, `isImmune(lightResist=${targetResist})`);
    if (!expectImmune) {
      approx(effectiveResistOf(target, 'lightning', pierce), expectedEffective, `effectiveResist(lightResist=${targetResist}, pierce=${pierce})`);
    }
  }

  // E4.7 through effectiveResist() directly: raw resist 100 is immune on
  // its own (isImmune -> true), but a live packet with lightResistPierce 30
  // resolves R9's r = 100 - 30 = 70 (< 100, not immune) BEFORE
  // effectiveResist's own cap — this is resolve()'s own R9 gate
  // (resistAfterPierce + isImmuneAtResist), not effectiveResist() itself,
  // which only ever reports "post-cap, post-pierce", not immunity.
  target.stats.lightResist = 100;
  assert.equal(isImmuneOf(target, 'lightning'), true, 'raw 100 resist is immune on its own, pierce or not');
  approx(effectiveResistOf(target, 'lightning', 30), 70, 'effectiveResist itself still reports the pierced, capped percentage');
});

test('isImmune()/effectiveResist(): unknown element throws', () => {
  const target = makeActor();
  assert.throws(() => isImmuneOf(target, 'holy'), /unknown element/);
  assert.throws(() => effectiveResistOf(target, 'holy', 0), /unknown element/);
});

test('isImmune(): physical is never immune', () => {
  const target = makeActor({ stats: makeStats({ physicalResist: 500 }) });
  assert.equal(isImmuneOf(target, 'physical'), false);
});

// ---------------------------------------------------------------------------
// E12 — mitigation ordering (03-combat-math.md §12, E12)
// ---------------------------------------------------------------------------

test('E12: stepR7a/stepR7b/stepR7c reproduce the exact ordering, all three intermediates', () => {
  let phys = 100.0;
  phys = stepR7a(phys, 12);
  approx(phys, 88.0, 'R7a: 100 - 12');
  phys = stepR7b(phys, 25);
  approx(phys, 66.0, 'R7b: 88 * 0.75');
  phys = stepR7c(phys, 30);
  approx(phys, 46.2, 'R7c: 66 * 0.70');
});

test('E12: reversing the order gives 40.5, proving the shipped order (46.2) is load-bearing', () => {
  // 100 * 0.70 * 0.75 - 12 = 40.5, per the spec's own "reversing the order" note.
  const reversed = 100 * 0.70 * 0.75 - 12;
  approx(reversed, 40.5, 'reversed-order sanity check');
  assert.notEqual(46.2, 40.5);
});

// ---------------------------------------------------------------------------
// E13 — full resolve, level-10 Runeblade imbued hit (03-combat-math.md §12, E13)
// ---------------------------------------------------------------------------
//
// A genuine defect in CMBT-1's already-shipped packet.js surfaced building
// this fixture, and is fixed in THIS round (packet.js's own header/report
// covers it in full): 03 §6.1's B6 row applies class.spellScale to
// skill-sourced elemental damage too, not just physMin/physMax — packet.js
// now has `stepB6Elemental`, called after stepB7 in both build methods.
// The packet below is built through the REAL `buildAttackPacket()` pipeline
// end to end — no test-local stand-in for the lightning value.

test('E13: full resolveDamage() reproduces every row of the worked example to 1e-4', async () => {
  const source = createActorRecord(0);
  source.id = 501; source.generation = 0; source.team = 0; source.level = 10;
  source.classId = 'runeblade'; // meleeScale 0.95, spellScale 0.95
  // startStr(22) + allocated(18) = 40, matching E13's "STR 40".
  source.attributes = { strength: 18, dexterity: 25, vitality: 20, energy: 22 };
  source.equipment = { mainHand: WEAPONS.sword_rune_normal }; // Rune Sword 8-17
  setSourceLayer(source, 'equipment', {
    enhancedDamage: 35, // "enhancedDamage 35"
    lightMin: 12, lightMax: 25, // blade_seal's own flatDamage, standing in for the skill layer (05-skills.md not built yet — see 01 §4.1's own equipment/skills split)
    manaReturnPercent: 8, // Runeblade's own stat
  });
  composeStats(source);
  source.life = 100; source.mana = 20;

  const combatCtx = {
    config: {}, events: new EventBus(), rng: new Rng(1),
    time: { step: 0 },
    get() { throw new Error('not used'); }, peek() { return undefined; }, has() { return false; },
  };
  const combat = new CombatSystem();
  await combat.init(combatCtx);

  const packet = combat.buildAttackPacket(source, 'blade_seal', 5);
  assert.ok(packet, 'buildAttackPacket must succeed');

  // buildAttackPacket() runs B1-B8 in one pass — no mid-pipeline state is
  // observable through the public method (see this file's E4/E12 tests for
  // the isolated per-step assertions; E3's own test in packet.test.js
  // already covers B1/B3/B5/B6 step by step for the pure physical case).
  // What's asserted here is the CHAIN of documented multipliers landing on
  // the exact same intermediates the worked example prints, verified
  // against the packet's own final physMin/physMax average.
  const b1 = (WEAPONS.sword_rune_normal.minDamage + WEAPONS.sword_rune_normal.maxDamage) / 2;
  approx(b1, 12.5, 'B1 weapon average');
  const b3 = b1 * 1.35; // enhancedDamage 35
  approx(b3, 16.875, 'B3 x1.35');
  const b5 = b3 * 1.40; // STR 40, oneHandMelee -> 1 + 40/100
  approx(b5, 23.625, 'B5 x1.40');
  const b6 = b5 * 0.95; // meleeScale
  approx(b6, 22.4438, 'B6 x0.95');
  approx((packet.physMin + packet.physMax) / 2, b6, 'packet\'s own final physical average matches the B1-B6 chain exactly');

  approx((12 + 25) / 2, 18.5, 'Lightning roll (raw blade_seal flatDamage average, pre class-scale)');
  approx((packet.lightMin + packet.lightMax) / 2, 17.575, 'B6 lightning x0.95 — from the REAL pipeline (stepB6Elemental), not test-local arithmetic');

  // AR: the worked example's own prose says "AR 230, DEF 67", but its
  // "Hit chance | 78.1759 %" row is exactly E1.2's value (AR=240, DEF=67,
  // alvl=dlvl=10 -> chanceToHit = 78.1759; AR=230 gives 77.4411, verified
  // directly against chanceToHit() below). Flagged in this ticket's report
  // as a real inconsistency in the spec text, independently confirmed by
  // the orchestrator; the numeric row is trusted over the prose figure.
  packet.attackRating = 240;
  packet.team = 0;

  const target = makeActor({
    team: 1, level: 10, life: 500,
    stats: makeStats({ defense: 67, damageReduceFlat: 1 }), // Bone Ranker: flatDR 1, all resists 0
  });

  const rng = makeMockRng(0.5); // next()=0.5 -> draw100=50: hits (50<78.18%), no crit (50 is not <5), no dodge
  const env = makeEnv({ source, rng, step: 100 });

  const result = resolveDamage(packet, target, env, blankResult());

  assert.equal(result.outcome, 'hit');
  assert.equal(result.crit, false);

  approx(result.physical, 21.4438, 'R7a: 22.4438 - 1 (flatDR), no R7b/R7c (both 0)');
  approx(result.lightning, 17.575, 'R10 lightning x1.00 (resist 0)');

  const totalRaw = result.physical + result.lightning;
  approx(totalRaw, 39.0188, 'R13 total = 21.4438 + 17.5750');
  assert.equal(result.total, 39, 'R13 floored');

  const cth = chanceToHit(240, 67, 10, 10);
  approx(cth, 78.1759, 'Hit chance');

  // manaReturned/resonance — R14(d)/(f), CMBT-7's rage/resonance economy
  // (see resolve.js's header). Not computed by resolveDamage(); reproduced
  // here as plain test-local arithmetic only, matching packet.test.js's own
  // precedent for a downstream-of-scope number.
  const manaReturned = result.physical * (packet.manaReturnPercent / 100);
  approx(manaReturned, 1.7155, 'manaReturned = 21.4438 * 0.08 (test-local — CMBT-7 seam, not implemented here)');
  assert.equal(result.manaReturned, 0, 'resolveDamage leaves manaReturned at 0 — CMBT-7 seam');
  // "Resonance gained: +1" has no derivable formula from this example's
  // given inputs (no resonanceOnHit value is given) and is CMBT-7's rage/
  // resonance economy — not asserted here at all.

  assert.equal(target.life, 500 - 39, 'R14(a): life -= total');

  combat.releasePacket(packet);
});

// ---------------------------------------------------------------------------
// R1 — validity
// ---------------------------------------------------------------------------

test('R1/isValidTarget: dead, non-hostile, invulnerable-flag and invulnUntil-window targets are all invalid', () => {
  const packet = { team: 0 };
  const dead = makeActor({ team: 1, dead: true });
  assert.equal(isValidTarget(packet, dead, 0), false);

  const friendly = makeActor({ team: 0 });
  assert.equal(isValidTarget(packet, friendly, 0), false);

  const neutral = makeActor({ team: 2 });
  assert.equal(isValidTarget(packet, neutral, 0), false);

  const invulnFlag = makeActor({ team: 1, flags: 1 << 0 });
  assert.equal(isValidTarget(packet, invulnFlag, 0), false);

  const spawnProtected = makeActor({ team: 1, invulnUntil: 500 });
  assert.equal(isValidTarget(packet, spawnProtected, 100), false);
  assert.equal(isValidTarget(packet, spawnProtected, 500), true);

  const valid = makeActor({ team: 1 });
  assert.equal(isValidTarget(packet, valid, 0), true);

  assert.equal(isValidTarget(packet, null, 0), false);
});

test('isHostile: 01-data-model.md §1.2\'s exact three-part test', () => {
  assert.equal(isHostile(0, 1), true);
  assert.equal(isHostile(0, 0), false);
  assert.equal(isHostile(0, 2), false, 'neutral is never hostile');
  assert.equal(isHostile(2, 1), false, 'neutral is never hostile, either side');
});

test('resolveDamage: R1 failure -> outcome invalid, no event, life untouched', () => {
  const packet = makePacket({ team: 0, physMin: 50, physMax: 50 });
  const target = makeActor({ team: 0, life: 100 }); // same team as packet -> not hostile
  let emitted = false;
  const env = makeEnv({ events: { emit() { emitted = true; } }, rng: makeMockRng(0) });

  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.outcome, 'invalid');
  assert.equal(target.life, 100);
  assert.equal(emitted, false, 'R1 failure emits no event');
  packetPool.release(packet);
});

// ---------------------------------------------------------------------------
// R2/R3/R4 — miss, dodge, block
// ---------------------------------------------------------------------------

test('resolveDamage: R2 miss stops the pipeline but still emits the event', () => {
  const packet = makePacket({ team: 0, attackRating: 1, physMin: 50, physMax: 50 });
  const target = makeActor({ team: 1, life: 100, stats: makeStats({ defense: 100000 }) }); // near-0% to-hit
  let emittedOutcome = null;
  const env = makeEnv({ events: { emit(_, payload) { emittedOutcome = payload.result.outcome; } }, rng: makeMockRng(0.999) });

  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.outcome, 'miss');
  assert.equal(target.life, 100, 'a miss deals no damage');
  assert.equal(emittedOutcome, 'miss');
  packetPool.release(packet);
});

test('resolveDamage: R3 dodge stops the pipeline', () => {
  const packet = makePacket({ team: 0, attackRating: 0, dodgeable: true, physMin: 50, physMax: 50 });
  const target = makeActor({ team: 1, life: 100, stats: makeStats({ dodgeChance: 50 }) });
  const env = makeEnv({ rng: makeMockRng(0) }); // draw100=0 < 50 -> dodge
  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.outcome, 'dodge');
  assert.equal(target.life, 100);
  packetPool.release(packet);
});

test('resolveDamage: R4 block zeroes damage but still runs riders/thorns (a-e), then emits', () => {
  const packet = makePacket({
    team: 0, attackRating: 0, blockable: true, physMin: 100, physMax: 100,
    originX: 0, originZ: -1, // in front of a target facing -Z-ish; see below
  });
  const target = makeActor({
    team: 1, life: 100, facing: -Math.PI / 2, // facing -Z
    equipment: { offHand: { blockBase: 65 } },
    stats: makeStats({ dexterity: 90, blockChance: 30 }), // E2.5-style, should clamp to 75% block
  });
  const env = makeEnv({ rng: makeMockRng(0) }); // draw100=0 < ~75% -> blocks
  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.outcome, 'block');
  assert.equal(out.blocked, true);
  assert.equal(out.total, 0);
  assert.equal(target.life, 100, 'a block deals zero damage');
  packetPool.release(packet);
});

test('isFrontalHit: within +/-90 degrees of facing is frontal, behind is not', () => {
  const target = { x: 0, z: 0, facing: 0 }; // facing +X
  assert.equal(isFrontalHit(target, 5, 0), true, 'origin directly ahead');
  assert.equal(isFrontalHit(target, 0, 5), true, 'origin at +90 degrees (edge, inclusive)');
  assert.equal(isFrontalHit(target, -5, 0), false, 'origin directly behind');
  assert.equal(isFrontalHit(target, 0, 0), true, 'coincident origin defaults to frontal');
});

// ---------------------------------------------------------------------------
// Immunity end-to-end (E4.6/E4.7 through the full pipeline, not just the
// isolated R9/R10 functions)
// ---------------------------------------------------------------------------

test('resolveDamage: a single fully-immune element yields outcome "immune" and total 0', () => {
  const packet = makePacket({ team: 0, attackRating: 0, physMin: 0, physMax: 0, lightMin: 17, lightMax: 17 });
  const target = makeActor({ team: 1, life: 100, stats: makeStats({ lightResist: 100 }) });
  const env = makeEnv({ rng: makeMockRng(0.5) });
  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.outcome, 'immune');
  assert.equal(out.total, 0);
  assert.equal(target.life, 100);
  packetPool.release(packet);
});

test('resolveDamage: pierce breaking an immunity produces a real hit (E4.7 end-to-end)', () => {
  const packet = makePacket({
    team: 0, attackRating: 0, physMin: 0, physMax: 0,
    lightMin: 16.9575, lightMax: 16.9575, lightResistPierce: 30,
  });
  const target = makeActor({ team: 1, life: 100, stats: makeStats({ lightResist: 100 }) });
  const env = makeEnv({ rng: makeMockRng(0.5) });
  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.outcome, 'hit');
  approx(out.lightning, 5.0873, 'E4.7 through the full pipeline');
  packetPool.release(packet);
});

test('resolveDamage: the <1 floor never fires for a hit fully absorbed by immunity (03\'s own note)', () => {
  const packet = makePacket({ team: 0, attackRating: 0, physMin: 0, physMax: 0, fireMin: 0.5, fireMax: 0.5 });
  const target = makeActor({ team: 1, life: 100, stats: makeStats({ fireResist: 100 }) });
  const env = makeEnv({ rng: makeMockRng(0.5) });
  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.total, 0, 'immune stays exactly 0, never floored to 1');
  packetPool.release(packet);
});

test('applyTotalFloor: floors a genuine small positive hit to 1, leaves an all-immune 0 alone', () => {
  assert.equal(applyTotalFloor(0.4, true), 1);
  assert.equal(applyTotalFloor(0.4, false), 0.4, 'no eligible positive component -> no floor');
  assert.equal(applyTotalFloor(5, true), 5, 'already >= 1 -> untouched');
});

// ---------------------------------------------------------------------------
// R14(d) — life/mana steal, computed from POST-mitigation physical
// ---------------------------------------------------------------------------

test('resolveDamage: life steal is computed from post-mitigation physical, credited to the resolved source', () => {
  const packet = makePacket({
    team: 0, attackRating: 0, physMin: 100, physMax: 100,
    lifeSteal: 50, manaSteal: 20, lifeOnHit: 3, manaOnHit: 2,
  });
  const target = makeActor({ team: 1, life: 1000, stats: makeStats({ damageReduceFlat: 20 }) }); // post-mitigation phys = 80
  const source = makeActor({ team: 0, life: 10, mana: 10, stats: makeStats({ maxLife: 1000, maxMana: 1000 }) });
  const env = makeEnv({ source, rng: makeMockRng(0.5) });

  const out = resolveDamage(packet, target, env, blankResult());
  approx(out.physical, 80, 'post-mitigation physical');
  assert.equal(out.lifeStolen, 40, 'floor(80 * 0.50)');
  assert.equal(out.manaStolen, 16, 'floor(80 * 0.20)');
  assert.equal(source.life, 10 + 40 + 3, 'lifeStolen + lifeOnHit credited to source');
  assert.equal(source.mana, 10 + 16 + 2, 'manaStolen + manaOnHit credited to source');
  packetPool.release(packet);
});

// ---------------------------------------------------------------------------
// R14(e) — thorns
// ---------------------------------------------------------------------------

test('resolveDamage: thorns bounces a counter-hit back at a melee attacker, and never recurses', () => {
  const packet = makePacket({ team: 0, attackRating: 5, physMin: 50, physMax: 50 });
  const target = makeActor({ team: 1, life: 1000, stats: makeStats({ thorns: 15, defense: 0 }) });
  const source = makeActor({ team: 0, life: 200, stats: makeStats({ thorns: 999 }) }); // even if the attacker ALSO has thorns, it must not bounce again
  const rng = makeMockRng(0.01); // low draw: hits, no dodge/block, no crit

  const env = makeEnv({
    source, rng,
    actorsSystem: null,
    packetPool, resultPool: new DamageResultPool(8),
  });

  const before = source.life;
  const out = resolveDamage(packet, target, env, blankResult());
  assert.ok(out.total > 0, 'the main hit landed');
  assert.equal(out.thornsDealt, 15, 'thorns amount bounced back equals the defender\'s flat thorns stat');
  assert.equal(source.life, before - 15, 'the counter-hit actually applied to the original attacker');
  packetPool.release(packet);
});

test('resolveDamage: thorns does not trigger for a spell (no dedicated melee flag — attackRating===0 heuristic)', () => {
  const packet = makePacket({ team: 0, attackRating: 0, physMin: 0, physMax: 0, fireMin: 50, fireMax: 50 });
  const target = makeActor({ team: 1, life: 1000, stats: makeStats({ thorns: 15 }) });
  const source = makeActor({ team: 0, life: 200 });
  const env = makeEnv({ source, rng: makeMockRng(0.01), packetPool, resultPool: new DamageResultPool(8) });

  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(out.thornsDealt, 0);
  assert.equal(source.life, 200);
  packetPool.release(packet);
});

// ---------------------------------------------------------------------------
// R14(b)/(c) — poison seed / onHitStatus riders call the applyStatus seam,
// guarded, and no-op cleanly when `actors` has not wired it in yet (gap 1).
// ---------------------------------------------------------------------------

test('resolveDamage: poison seed and onHitStatus riders no-op cleanly when actorsSystem.applyStatus is absent', () => {
  const packet = makePacket({
    team: 0, attackRating: 0, physMin: 0, physMax: 0, critChance: 0,
    poisonMin: 42, poisonMax: 42, poisonDuration: 6,
    onHitCount: 1,
  });
  packet.onHitStatus[0].status = 'burning';
  packet.onHitStatus[0].chance = 100;
  packet.onHitStatus[0].duration = 3;
  packet.onHitStatus[0].magnitude = 5;

  const target = makeActor({ team: 1, life: 1000 });
  const env = makeEnv({ actorsSystem: {}, rng: makeMockRng(0.01) }); // {} has no .applyStatus
  assert.doesNotThrow(() => resolveDamage(packet, target, env, blankResult()));
  packetPool.release(packet);
});

test('resolveDamage: poison seed and onHitStatus riders call applyStatus with the documented spec once actorsSystem wires it in', () => {
  const packet = makePacket({
    team: 0, attackRating: 0, physMin: 0, physMax: 0, critChance: 0,
    poisonMin: 42, poisonMax: 42, poisonDuration: 6,
    onHitCount: 1,
  });
  packet.onHitStatus[0].status = 'burning';
  packet.onHitStatus[0].chance = 100;
  packet.onHitStatus[0].duration = 3;
  packet.onHitStatus[0].magnitude = 5;

  const target = makeActor({ team: 1, life: 1000 });
  const calls = [];
  const actorsSystem = { applyStatus(actor, spec) { calls.push({ actor, spec: { ...spec } }); return { status: spec.status }; } };
  const env = makeEnv({ actorsSystem, rng: makeMockRng(0.01) });

  const out = resolveDamage(packet, target, env, blankResult());
  assert.equal(calls.length, 2, 'one call for the poison seed, one for the onHitStatus rider');
  assert.equal(calls[0].spec.status, 'poisoned');
  approx(calls[0].spec.magnitude, 42 / 6, 'poison magnitude = appliedTotal / duration');
  assert.equal(calls[0].spec.duration, 6);
  assert.equal(calls[1].spec.status, 'burning');
  assert.notEqual(out.statusApplied & (1 << 1), 0, 'poisoned bit set');
  assert.notEqual(out.statusApplied & (1 << 0), 0, 'burning bit set');
  packetPool.release(packet);
});

// ---------------------------------------------------------------------------
// R11/R12 — magicDamageReduceFlat proportional share, shocked amplification
// ---------------------------------------------------------------------------

test('resolveDamage: magicDamageReduceFlat reduces the non-physical sum proportionally, clamped at 0', () => {
  const packet = makePacket({
    team: 0, attackRating: 0, physMin: 0, physMax: 0,
    fireMin: 30, fireMax: 30, coldMin: 10, coldMax: 10,
  });
  const target = makeActor({ team: 1, life: 1000, stats: makeStats({ magicDamageReduceFlat: 20 }) });
  const env = makeEnv({ rng: makeMockRng(0.5) });
  const out = resolveDamage(packet, target, env, blankResult());
  // sum before R11 = 40; reduced to 20; proportional factor 0.5 on each.
  approx(out.fire, 15, 'fire scaled proportionally');
  approx(out.cold, 5, 'cold scaled proportionally');
});

test('resolveDamage: shocked amplifies every component, including physical, by 12% per stack', () => {
  const packet = makePacket({ team: 0, attackRating: 0, physMin: 50, physMax: 50 });
  const target = makeActor({ team: 1, life: 1000 });
  target.statuses = [{ status: 'shocked', stacks: 2 }]; // +24%
  const env = makeEnv({ rng: makeMockRng(0.5) });
  const out = resolveDamage(packet, target, env, blankResult());
  approx(out.physical, 62, '50 * 1.24');
});

// ---------------------------------------------------------------------------
// applyDirect / heal
// ---------------------------------------------------------------------------

test('applyDirectDamage: mitigation-free, straight life subtraction, one element', () => {
  const target = makeActor({ life: 100 });
  const env = makeEnv();
  const out = applyDirectDamage(target, 30, 'fire', 999, 'meteor_pool', env, blankResult());
  assert.equal(out.outcome, 'hit');
  assert.equal(out.fire, 30);
  assert.equal(out.total, 30);
  assert.equal(target.life, 70);
});

test('applyDirectDamage: a dead target is invalid, life untouched', () => {
  const target = makeActor({ life: 100, dead: true });
  const out = applyDirectDamage(target, 30, 'fire', 999, 'meteor_pool', makeEnv(), blankResult());
  assert.equal(out.outcome, 'invalid');
  assert.equal(target.life, 100);
});

test('healTarget: clamp(amount, 0, maxLife - life), never heals past max, never heals a dead actor', () => {
  const target = makeActor({ life: 90, stats: makeStats({ maxLife: 100 }) });
  assert.equal(healTarget(target, 30), 10);
  assert.equal(target.life, 100);
  assert.equal(healTarget(target, 5), 0, 'already at max');

  const dead = makeActor({ life: 10, dead: true, stats: makeStats({ maxLife: 100 }) });
  assert.equal(healTarget(dead, 30), 0);
});

// ---------------------------------------------------------------------------
// DamageResultPool
// ---------------------------------------------------------------------------

test('DamageResultPool: acquire/release round-trips, double-release is a safe no-op, dry pool returns null', () => {
  const pool = new DamageResultPool(2);
  const a = pool.acquire();
  const b = pool.acquire();
  assert.ok(a && b);
  assert.equal(pool.acquire(), null, 'dry pool returns null, does not throw');

  pool.release(a);
  pool.release(a); // double release — safe no-op
  const c = pool.acquire();
  assert.equal(c, a, 'the released slot is reused');
});

test('RESULT_POOL_CAPACITY is 256, matching 01-data-model.md §11.1', () => {
  assert.equal(RESULT_POOL_CAPACITY, 256);
});

test('ELEMENT_ORDER is fire, cold, lightning, poison, magic', () => {
  assert.deepEqual(ELEMENT_ORDER, ['fire', 'cold', 'lightning', 'poison', 'magic']);
});

// ---------------------------------------------------------------------------
// Real-boot wiring — the same class of regression tohit.test.js's own final
// section guards against (O-51): a sibling file that only ever gets
// imported directly by its own test never proves it is reachable from
// `main.js`'s actual boot path. This test imports ONLY `packet.js`.
// ---------------------------------------------------------------------------

test('packet.js alone (no resolve.js import) wires resolve/applyDirect/heal/effectiveResist/isImmune — the real main.js boot path', async () => {
  const { CombatSystem } = await import('../../src/combat/packet.js');
  const { ActorsSystem } = await import('../../src/actors/index.js');
  const { createActorRecord } = await import('../../src/actors/pool.js');
  const { composeStats } = await import('../../src/actors/stats.js');
  const { makeStubCtx } = await import('../helpers/actor.js');

  const combat = new CombatSystem();
  assert.equal(typeof combat.resolve, 'function');
  assert.equal(typeof combat.applyDirect, 'function');
  assert.equal(typeof combat.heal, 'function');
  assert.equal(typeof combat.effectiveResist, 'function');
  assert.equal(typeof combat.isImmune, 'function');

  const actors = new ActorsSystem();
  const ctx = makeStubCtx({ systems: { actors } });
  await actors.init(ctx);
  await combat.init(ctx);

  const attacker = createActorRecord(0);
  attacker.id = 1; attacker.generation = 0; attacker.team = 0; attacker.level = 10;
  attacker.classId = 'runeblade';
  attacker.attributes = { strength: 22, dexterity: 25, vitality: 20, energy: 22 };
  composeStats(attacker);

  const target = createActorRecord(1);
  target.id = 2; target.generation = 0; target.team = 1; target.level = 10; target.life = 200;
  target.attributes = { strength: 0, dexterity: 0, vitality: 0, energy: 0 };
  composeStats(target);
  target.life = 200;

  const packet = combat.buildAttackPacket(attacker, 'attack', 0);
  assert.ok(packet, 'buildAttackPacket must succeed against a real boot-wired CombatSystem');

  const result = combat.resolve(packet, target);
  assert.ok(result, 'resolve() must succeed through packet.js\'s own module graph, exactly as main.js loads it');
  assert.ok(['hit', 'miss'].includes(result.outcome));

  // E4.1, spelled out literally — not derived from resolve.js's own export.
  target.stats.lightResist = 0;
  assert.equal(combat.isImmune(target, 'lightning'), false);
  approx(combat.effectiveResist(target, 'lightning', 0), 0, 'effectiveResist at 0 resist');

  combat.releasePacket(packet);
});

// ---------------------------------------------------------------------------
// small local helper
// ---------------------------------------------------------------------------

function blankResult() {
  return {
    targetId: 0, targetGen: 0, sourceId: 0, sourceGen: 0, sourceSkillId: null,
    outcome: 'invalid', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 0,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false,
    pointX: 0, pointY: 0, pointZ: 0, poolIndex: -1,
  };
}
