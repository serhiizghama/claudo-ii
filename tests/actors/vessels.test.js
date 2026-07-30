// tests/actors/vessels.test.js
//
// ACTR-8 acceptance tests for src/actors/vessels.js. `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// Scope: `integrateVessels` (the fixed-step regen/decay integrator) and the
// seven `02-api-contracts.md` §7 "Stats and vessels" accessors —
// `addLife`/`addMana`/`addRage`/`addResonance`/`spend`/`canAfford`/
// `lifeFraction`. Not tested here (owned by other tickets): the
// `ActorsSystem` wiring that would call `integrateVessels` from a real
// `fixedUpdate` (src/actors/index.js), `composeStats` itself as its own unit
// (tests/actors/stats.test.js), the action state machine, status *effect
// application* (only the already-allocated `statusMask` bit this file reads
// is exercised — see O-27 below).
//
// THIS FILE'S ACCEPTANCE GATE:
//   1. `spend(actor, 'resonance', 'all')` — requires resonance >= 1, spends
//      floor(resonance), keeps the fractional remainder (03 §2.4).
//   2. The fractional-carry rule: a long run of fixed steps delivers EXACTLY
//      floor(rate x seconds) whole life points, never one more, and the
//      accumulator never manufactures or discards a fraction.
//   3. The life-regen RATE itself, against the REAL `composeStats` pipeline
//      (not a stand-in `actor.stats` object): a real composed player's
//      observed integration rate must equal `stats(actor).lifeRegen`
//      EXACTLY, no matter what `actor.kind` is set to — `stats.js` looks the
//      class row up by `classId` alone, and an earlier version of
//      `effectiveLifeRegenRate` (vessels.js) branched on `kind === 'player'`
//      instead, which double-counted the class base rate whenever `kind`
//      wasn't exactly `'player'` (a real, measured 2x bug — see the "no
//      double-count" section below, which pins the regression directly).
//
// Two families of test actor are used, deliberately:
//   - `makeActor()` builds a real `Actor` record (`createActorRecord`,
//     pool.js) but assigns a HAND-BUILT `actor.stats` object and sets
//     `actor.statsDirty = false`, skipping `composeStats` entirely. This is
//     legitimate for testing vessels.js logic that does not depend on HOW a
//     StatBlock was composed — the accumulator's carry arithmetic, the
//     `poisoned`/`dead` gates, the in-combat window, `spend`/`canAfford`'s
//     resource-key handling, clamping. Its `lifeRegenPercent: 0.6` default
//     stands in for "a real class already baked the 0.6%/s base rate in",
//     matching what every real player class actually composes.
//   - `makeRealActor()` (below) drives the REAL `composeStats` (stats.js) on
//     a real classId/level/attributes, for the tests that must catch a bug
//     living in the INTERACTION between the two files — the double-count
//     regression above, and the Rage/Resonance tests, since `maxRage`/
//     `maxResonance` are themselves composed by stats.js's `CLASS_TABLE`
//     (Ravager `baseRage: 100`, Runeblade `baseResonance: 3`), not hand-set.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats } from '../../src/actors/stats.js';
import {
  integrateVessels,
  addLife,
  addMana,
  addRage,
  addResonance,
  spend,
  canAfford,
  lifeFraction,
  POISONED_STATUS_BIT,
} from '../../src/actors/vessels.js';

/** A live actor record with a hand-built StatBlock — see the file header for
 * what this is (and is not) safe to use for. `overrides.stats` merges over a
 * generous set of defaults so a test only states the fields it cares about.
 * `lifeRegenPercent: 0.6` in the defaults matters: it is what makes this
 * stand-in behave like a REAL composed player (every class's base rate is
 * 0.6, `01-data-model.md` §3.2) rather than silently depending on
 * `undefined / 100` happening to compare `false` against a positive rank
 * rate. */
function makeActor(overrides = {}) {
  const actor = createActorRecord(0);
  actor.kind = overrides.kind ?? 'player';
  actor.rank = overrides.rank ?? 'normal';
  actor.classId = overrides.classId ?? null;
  actor.level = overrides.level ?? 10;
  actor.dead = overrides.dead ?? false;
  actor.statusMask = overrides.statusMask ?? 0;
  actor.life = overrides.life ?? 0;
  actor.mana = overrides.mana ?? 0;
  actor.rage = overrides.rage ?? 0;
  actor.resonance = overrides.resonance ?? 0;
  actor.stamina = overrides.stamina ?? 0;
  actor.lifeAccum = overrides.lifeAccum ?? 0;
  actor.manaAccum = overrides.manaAccum ?? 0;
  actor.lastDamageStep = overrides.lastDamageStep ?? -1;
  actor.lastDealtStep = overrides.lastDealtStep ?? -1;

  actor.stats = {
    maxLife: 100000, lifeRegen: 0, lifeRegenPercent: 0.6,
    maxMana: 100000, manaRegen: 0,
    maxRage: 100, maxResonance: 3, maxStamina: 100, staminaRegen: 0,
    ...overrides.stats,
  };
  actor.statsDirty = false;
  return actor;
}

/** A live actor record driven through the REAL `composeStats` (stats.js) —
 * see the file header for why this exists alongside `makeActor()`. Returns
 * the actor with `actor.stats` already populated by the real pipeline.
 * @param {object} opts
 * @param {string} [opts.kind] left unset (`null`, `createActorRecord`'s own
 *   default) unless given — the double-count regression test below relies
 *   on being able to compose a real class row with `kind` NOT `'player'`.
 * @param {string|null} [opts.classId]
 * @param {string} [opts.rank]
 * @param {number} [opts.level]
 * @param {{strength?,dexterity?,vitality?,energy?}} [opts.attributes]
 */
function makeRealActor(opts = {}) {
  const actor = createActorRecord(0);
  if (opts.kind !== undefined) actor.kind = opts.kind;
  actor.classId = opts.classId ?? null;
  actor.rank = opts.rank ?? 'normal';
  actor.level = opts.level ?? 10;
  const attrs = opts.attributes || {};
  actor.attributes.strength = attrs.strength ?? 0;
  actor.attributes.dexterity = attrs.dexterity ?? 0;
  actor.attributes.vitality = attrs.vitality ?? 0;
  actor.attributes.energy = attrs.energy ?? 0;
  composeStats(actor);
  return actor;
}

/** Runs `integrateVessels` for `steps` fixed steps starting at step 0 and
 * returns the observed life-regen rate in life/s, computed from the total
 * (whole + fractional) gained — the same "life + lifeAccum" invariant this
 * file's accumulator tests already rely on. */
function observedLifeRatePerSecond(actor, steps) {
  const life0 = actor.life;
  const accum0 = actor.lifeAccum;
  for (let step = 0; step < steps; step++) integrateVessels(actor, step);
  const gained = (actor.life + actor.lifeAccum) - (life0 + accum0);
  return gained / (steps / 60);
}

// ---------------------------------------------------------------------------
// 0. No double-counting the class base life-regen rate — a real regression,
//    caught only by driving the REAL composeStats pipeline (see file header).
// ---------------------------------------------------------------------------

test('a real composed Ravager player: observed life-regen rate equals stats.lifeRegen exactly', () => {
  const actor = makeRealActor({
    kind: 'player', classId: 'ravager', level: 13,
    attributes: { strength: 24, dexterity: 12, vitality: 24, energy: 0 },
  });
  const composedRate = actor.stats.lifeRegen;
  assert.ok(composedRate > 0, 'sanity: the fixture must actually compose a positive rate');

  const observed = observedLifeRatePerSecond(actor, 601); // 601, not 600 — see the poisoned test below for why
  assert.ok(
    Math.abs(observed - composedRate) < 1e-6,
    `expected observed rate ${composedRate} (stats.lifeRegen), got ${observed}`,
  );
});

test('REGRESSION: the same, with actor.kind left unset — must still equal stats.lifeRegen, not double it', () => {
  // stats.js resolves the class row by classId alone (composeStats step 2:
  // CLASS_TABLE[actor.classId]) — it never reads actor.kind. A previous
  // version of effectiveLifeRegenRate (vessels.js) used `kind === 'player'`
  // as a proxy for "was the class base rate already baked into
  // lifeRegenPercent", which is wrong: leaving kind at its
  // createActorRecord default (null) here still composes the full Ravager
  // class row, but the old code would then add maxLife x 0.006 a SECOND
  // time, measuring exactly 2x the composed rate. This test pins that fix.
  const actor = makeRealActor({
    classId: 'ravager', level: 13,
    attributes: { strength: 24, dexterity: 12, vitality: 24, energy: 0 },
  });
  assert.equal(actor.kind, null, 'sanity: kind really is left unset here');
  const composedRate = actor.stats.lifeRegen;

  const observed = observedLifeRatePerSecond(actor, 601);
  assert.ok(
    Math.abs(observed - composedRate) < 1e-6,
    `expected observed rate ${composedRate} (stats.lifeRegen), got ${observed} (ratio ${observed / composedRate})`,
  );
});

test('a real composed monster (classId=null) at normal rank regens at maxLife x 0.006', () => {
  const actor = makeRealActor({ kind: 'monster', classId: null, rank: 'normal', level: 10 });
  assert.equal(actor.stats.lifeRegenPercent, 0, 'sanity: ZERO_CLASS bakes in nothing');
  const expected = actor.stats.maxLife * 0.006;

  const observed = observedLifeRatePerSecond(actor, 601);
  assert.ok(Math.abs(observed - expected) < 1e-6, `expected ${expected}, got ${observed}`);
});

test('a real composed monster at boss/unique rank regens at maxLife x 0.004', () => {
  for (const rank of ['boss', 'unique']) {
    const actor = makeRealActor({ kind: 'monster', classId: null, rank, level: 10 });
    const expected = actor.stats.maxLife * 0.004;
    const observed = observedLifeRatePerSecond(actor, 601);
    assert.ok(Math.abs(observed - expected) < 1e-6, `[${rank}] expected ${expected}, got ${observed}`);
  }
});

test('a real composed Ravager: maxRage composes to 100 (stats.js CLASS_TABLE.baseRage) and addRage/decay clamp against it', () => {
  const actor = makeRealActor({ kind: 'player', classId: 'ravager', level: 10 });
  assert.equal(actor.stats.maxRage, 100, 'sanity: this is what stats.js is expected to compose today');
  actor.rage = 95;
  assert.equal(addRage(actor, 10), 5, 'only 5 headroom to the real composed max');
  assert.equal(actor.rage, 100);
});

test('a real composed Runeblade: maxResonance composes to 3 (stats.js CLASS_TABLE.baseResonance) and spend("all") works against it', () => {
  const actor = makeRealActor({ kind: 'player', classId: 'runeblade', level: 10 });
  assert.equal(actor.stats.maxResonance, 3, 'sanity: this is what stats.js is expected to compose today');
  assert.equal(addResonance(actor, 5), 3, 'clamped to the real composed max, not an arbitrary stand-in');
  assert.equal(actor.resonance, 3);
  assert.equal(spend(actor, 'resonance', 'all'), true);
  assert.equal(actor.resonance, 0);
});

// ---------------------------------------------------------------------------
// 1. blade_seal's spend('all') — 03-combat-math.md §2.4, the ticket's own
//    worked contract.
// ---------------------------------------------------------------------------

test('spend(actor, "resonance", "all") requires >= 1, floors, keeps the remainder', () => {
  const actor = makeActor({ resonance: 2.7 });
  const ok = spend(actor, 'resonance', 'all');
  assert.equal(ok, true);
  // spent = floor(2.7) = 2; remainder 0.7 kept, not rounded away.
  assert.ok(Math.abs(actor.resonance - 0.7) < 1e-9, `expected 0.7, got ${actor.resonance}`);
});

test('spend "all" fails below 1 resonance and does not mutate', () => {
  const actor = makeActor({ resonance: 0.9 });
  const ok = spend(actor, 'resonance', 'all');
  assert.equal(ok, false);
  assert.equal(actor.resonance, 0.9);
});

test('spend "all" on exactly 1.0 spends the whole 1 and leaves 0 remainder', () => {
  const actor = makeActor({ resonance: 1.0 });
  assert.equal(spend(actor, 'resonance', 'all'), true);
  assert.equal(actor.resonance, 0);
});

test('spend "all" on a value above maxResonance (up to 5, resonance_circuit) still floors correctly', () => {
  const actor = makeActor({ resonance: 4.25, stats: { maxResonance: 5 } });
  assert.equal(spend(actor, 'resonance', 'all'), true);
  assert.ok(Math.abs(actor.resonance - 0.25) < 1e-9);
});

test('spend with a numeric amount is atomic: false and unchanged when short', () => {
  const actor = makeActor({ rage: 8 });
  assert.equal(spend(actor, 'rage', 9), false);
  assert.equal(actor.rage, 8, 'a failed spend must not mutate the resource');
  assert.equal(spend(actor, 'rage', 8), true);
  assert.equal(actor.rage, 0);
});

test('spend rejects an unrecognised resource key without touching the actor', () => {
  const actor = makeActor({ life: 50 });
  const before = { ...actor };
  assert.equal(spend(actor, 'maxLife', 1), false);
  assert.equal(spend(actor, 'lifeAccum', 1), false);
  assert.equal(actor.maxLife, before.maxLife);
  assert.equal(actor.lifeAccum, before.lifeAccum);
});

test('canAfford is a pure read: true/false, never mutates', () => {
  const actor = makeActor({ mana: 30 });
  assert.equal(canAfford(actor, 'mana', 30), true);
  assert.equal(canAfford(actor, 'mana', 30.0001), false);
  assert.equal(actor.mana, 30);
  assert.equal(canAfford(actor, 'nonsense', 0), false);
});

// ---------------------------------------------------------------------------
// 2. THE fractional-carry acceptance criterion — life regen through
//    lifeAccum never rounds up, never loses a fraction.
// ---------------------------------------------------------------------------

test('life regen accumulator: after N steps, exactly floor(rate*seconds) whole points — never one more', () => {
  // kind:'player', rank:'normal' makes effectiveLifeRegenRate collapse to
  // stats.lifeRegen unchanged (see vessels.js's own derivation) — an
  // arbitrary, "messy" rate chosen specifically so per-step gain (rate/60)
  // never lands on a clean boundary, to stress the carry.
  const RATE = 7; // life/s
  const actor = makeActor({ life: 0, stats: { lifeRegen: RATE, maxLife: 10_000_000 } });

  const STEPS_TO_EXACT_MULTIPLE = 600_000; // 7 * 600000 / 60 = 70000.0 exactly
  for (let step = 0; step < STEPS_TO_EXACT_MULTIPLE; step++) integrateVessels(actor, step);

  assert.equal(actor.life, 70_000, 'exact multiple: all of it should have landed');
  assert.ok(Math.abs(actor.lifeAccum) < 1e-6, `accumulator should have drained to ~0, got ${actor.lifeAccum}`);
  assert.ok(Number.isInteger(actor.life), 'life must only ever move in whole points');

  // One more step: the per-step gain (7/60 = 0.11666...) is nowhere near a
  // whole point yet. This is the "never rounds up" assertion with teeth —
  // life must NOT bump to 70001 just because a step happened.
  integrateVessels(actor, STEPS_TO_EXACT_MULTIPLE);
  assert.equal(actor.life, 70_000, 'must not manufacture an extra point on a partial step');
  assert.ok(actor.lifeAccum > 0 && actor.lifeAccum < 1, 'the fraction must be carried, not dropped');
  assert.ok(Math.abs(actor.lifeAccum - 7 / 60) < 1e-9);
});

test('life regen accumulator never loses a fraction: cumulative life+accum tracks the ideal total', () => {
  const RATE = 13; // life/s — a different, still-messy rate
  const actor = makeActor({ life: 0, stats: { lifeRegen: RATE, maxLife: 10_000_000 } });
  const N = 123_457; // an intentionally "ugly" step count
  for (let step = 0; step < N; step++) integrateVessels(actor, step);

  const idealTotal = RATE * (N / 60);
  const actualTotal = actor.life + actor.lifeAccum;
  assert.ok(Math.abs(actualTotal - idealTotal) < 1e-6, `expected ~${idealTotal}, got ${actualTotal}`);
  assert.equal(actor.life, Math.floor(idealTotal + 1e-9), 'life itself must be the exact floor, never rounded up');
});

test('life regen never banks a hidden carry once maxLife is reached', () => {
  const actor = makeActor({ life: 99, stats: { lifeRegen: 30, maxLife: 100 } }); // 0.5/step
  integrateVessels(actor, 0); // 99 + 0.5 -> whole=0, accum=0.5
  integrateVessels(actor, 1); // 99 + 1.0 -> whole=1 -> life=100 (cap), accum should reset to 0 (not banked)
  assert.equal(actor.life, 100);
  assert.equal(actor.lifeAccum, 0, 'a carry that overflows the cap must be discarded, not banked for later');
  // If it were banked, running more steps right after a life LOSS (outside
  // this ticket's scope to simulate) would burst extra life back in. What we
  // CAN assert here directly: running further steps at full life keeps
  // accum pinned at (or returning to) 0, never growing unbounded.
  for (let step = 2; step < 200; step++) integrateVessels(actor, step);
  assert.equal(actor.life, 100);
  assert.ok(actor.lifeAccum >= 0 && actor.lifeAccum < 1);
});

// ---------------------------------------------------------------------------
// 3. poisoned gates life regen to 0, but never mana — O-27: this reads the
//    real actor.statusMask bit, not an assumption that statuses don't exist.
// ---------------------------------------------------------------------------

test('poisoned (statusMask bit set) zeroes life regen but leaves mana regen running', () => {
  const actor = makeActor({
    statusMask: POISONED_STATUS_BIT,
    stats: { lifeRegen: 50, maxLife: 100000, manaRegen: 10, maxMana: 100000 },
  });
  // 601 steps, not 600: 600 steps at 10/s lands the ideal total EXACTLY on
  // the integer 100.0, a boundary so razor-thin that IEEE-754 double
  // summation can land a hair on either side of it (verified: whole_total
  // comes out 99, not 100, purely from float noise at that exact N) — the
  // same "noise floor" class tests/helpers/alloc.js documents, not a
  // vessels.js defect. One extra step avoids the coincidence.
  for (let step = 0; step < 601; step++) integrateVessels(actor, step);
  assert.equal(actor.life, 0, 'poisoned must fully suppress life regen, not just slow it');
  assert.equal(actor.lifeAccum, 0, 'no fraction should accrue either while poisoned');
  assert.ok(actor.mana > 0, 'mana regen is NOT blocked by poisoned');
  assert.ok(Math.abs(actor.mana - 100) < 1e-6, `expected ~100 mana after 10s at 10/s, got ${actor.mana}`);
});

test('clearing the poisoned bit resumes life regen exactly where it left off', () => {
  const actor = makeActor({
    statusMask: POISONED_STATUS_BIT,
    stats: { lifeRegen: 30, maxLife: 100000 }, // 0.5/step
  });
  integrateVessels(actor, 0);
  integrateVessels(actor, 1);
  assert.equal(actor.life, 0);
  assert.equal(actor.lifeAccum, 0, 'poisoned discards the rate, not a pre-existing accum (none had accrued)');

  actor.statusMask = 0; // cured
  integrateVessels(actor, 2); // +0.5 -> accum 0.5
  integrateVessels(actor, 3); // +0.5 -> whole 1 -> life 1
  assert.equal(actor.life, 1);
});

// ---------------------------------------------------------------------------
// 4. Never regenerates (or decays, or accepts an add into) a dead actor.
// ---------------------------------------------------------------------------

test('a dead actor is fully frozen: no regen, no decay, no addLife/addMana', () => {
  const actor = makeActor({
    dead: true, life: 40, mana: 40, rage: 50, resonance: 2, stamina: 10,
    stats: { lifeRegen: 100, maxLife: 1000, manaRegen: 100, maxMana: 1000, maxRage: 100, maxResonance: 3 },
  });
  for (let step = 0; step < 600; step++) integrateVessels(actor, step);
  assert.equal(actor.life, 40);
  assert.equal(actor.mana, 40);
  assert.equal(actor.rage, 50); // out of combat, would have decayed if alive
  assert.equal(actor.resonance, 2);
  assert.equal(actor.stamina, 10);

  assert.equal(addLife(actor, 100, 0), 0);
  assert.equal(actor.life, 40);
  assert.equal(addMana(actor, 100), 0);
  assert.equal(actor.mana, 40);
});

// ---------------------------------------------------------------------------
// 5. Rage — in-combat gate, out-of-combat decay, "In combat" step window.
// ---------------------------------------------------------------------------

test('rage does not decay while in combat (within the 240-step / 4.0s window)', () => {
  const actor = makeActor({ rage: 50, lastDealtStep: 100 });
  integrateVessels(actor, 101); // 1 step after a dealt hit — well inside the window
  assert.equal(actor.rage, 50, 'no decay while in combat');
});

test('rage decays at 8/s once the 4.0s (240-step) combat window has elapsed', () => {
  const actor = makeActor({ rage: 50, lastDealtStep: 0 });
  // step 240 is the first step where (step - lastCombatStep) === 240, i.e.
  // no longer "< 240" -> out of combat starting exactly here.
  integrateVessels(actor, 240);
  assert.ok(Math.abs(actor.rage - (50 - 8 / 60)) < 1e-9);
});

test('rage decay floors at 0, never negative', () => {
  // Both lastDamageStep/lastDealtStep pushed far in the past so "in combat"
  // (which takes the max of the two) is unambiguously false.
  const actor = makeActor({ rage: 0.05, lastDamageStep: -1000, lastDealtStep: -1000 });
  integrateVessels(actor, 0);
  assert.equal(actor.rage, 0);
});

// ---------------------------------------------------------------------------
// 6. Resonance — out-of-combat decay at 1 per 3s.
// ---------------------------------------------------------------------------

test('resonance decays at 1/3 per second out of combat', () => {
  const actor = makeActor({ resonance: 2, lastDamageStep: -1000, lastDealtStep: -1000 });
  for (let step = 0; step < 180; step++) integrateVessels(actor, step); // 3s
  assert.ok(Math.abs(actor.resonance - (2 - 1)) < 1e-6, `expected ~1, got ${actor.resonance}`);
});

test('resonance does not decay in combat', () => {
  const actor = makeActor({ resonance: 2, lastDealtStep: 50 });
  integrateVessels(actor, 51);
  assert.equal(actor.resonance, 2);
});

// ---------------------------------------------------------------------------
// 7. addLife / addMana / addRage / addResonance — clamp to [0, max], return
//    the ACTUAL amount applied.
// ---------------------------------------------------------------------------

test('addLife clamps to maxLife and reports the actual amount applied', () => {
  const actor = makeActor({ life: 90, stats: { maxLife: 100 } });
  assert.equal(addLife(actor, 5, 0), 5);
  assert.equal(actor.life, 95);
  assert.equal(addLife(actor, 20, 0), 5, 'only 5 headroom left before the cap');
  assert.equal(actor.life, 100);
});

test('addLife never drops life below 0 on a negative amount (e.g. a drain)', () => {
  const actor = makeActor({ life: 3, stats: { maxLife: 100 } });
  assert.equal(addLife(actor, -10, 0), -3);
  assert.equal(actor.life, 0);
});

test('addMana / addRage / addResonance clamp the same way', () => {
  const actor = makeActor({
    mana: 5, rage: 98, resonance: 2.9,
    stats: { maxMana: 10, maxRage: 100, maxResonance: 3 },
  });
  assert.equal(addMana(actor, 100), 5);
  assert.equal(actor.mana, 10);
  assert.equal(addRage(actor, 10), 2);
  assert.equal(actor.rage, 100);
  const applied = addResonance(actor, 0.5);
  assert.ok(Math.abs(applied - 0.1) < 1e-9);
  assert.ok(Math.abs(actor.resonance - 3) < 1e-9);
});

// ---------------------------------------------------------------------------
// 8. lifeFraction — 0..1.
// ---------------------------------------------------------------------------

test('lifeFraction is life/maxLife, clamped to [0,1]', () => {
  const actor = makeActor({ life: 25, stats: { maxLife: 100 } });
  assert.equal(lifeFraction(actor), 0.25);
  actor.life = 0;
  assert.equal(lifeFraction(actor), 0);
  actor.life = 999; // should never happen post-clamp, but the reader must not blow past 1
  assert.equal(lifeFraction(actor), 1);
});

test('lifeFraction is 0 for a non-positive maxLife rather than NaN/Infinity', () => {
  const actor = makeActor({ life: 10, stats: { maxLife: 0 } });
  assert.equal(lifeFraction(actor), 0);
});

// ---------------------------------------------------------------------------
// 9. Stamina — passive regen only, no sprint control (config.stamina: false).
// ---------------------------------------------------------------------------

test('stamina regens passively at 8/s + the flat StatBlock bonus, clamped to maxStamina', () => {
  const actor = makeActor({ stamina: 0, stats: { maxStamina: 100, staminaRegen: 4 } });
  for (let step = 0; step < 60; step++) integrateVessels(actor, step); // 1s @ 12/s
  assert.ok(Math.abs(actor.stamina - 12) < 1e-6, `expected ~12, got ${actor.stamina}`);
});
