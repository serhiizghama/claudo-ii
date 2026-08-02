// tests/actors/stats.test.js
//
// ACTR-7 acceptance tests for src/actors/stats.js. `node:test` +
// `node:assert/strict` only — no framework, matching every sibling test
// file in this directory (tests/actors/actr1.test.js, actr2.test.js).
//
// Scope: `composeStats`/`stats`/`markDirty`/`setSourceLayer` — the pure
// StatBlock composition engine. Not tested here (owned by other tickets,
// not touched by this one): the `ActorsSystem` wiring that would forward
// these into `ctx.get('actors')` and emit `stats:dirty` (src/actors/
// index.js), vessel/regen accessors (addLife/spend/...), the action state
// machine, status-effect application.
//
// THIS FILE'S ACCEPTANCE GATE — two parts, both required:
//   1. E14 (03-combat-math.md §12), all eleven rows, to 1e-4 — plus the
//      layer stack (each of the six source layers contributed what it
//      should) and a direct check that all ten composition steps ran.
//   2. composeStats recompose cost <= 40µs (player) / <= 6µs (monster),
//      each paired with a same-run correctness assertion (rule 12 in this
//      ticket's brief: "a fast function that skipped steps does not
//      pass" — the NAV-2 lesson).
//
// A note on where this file lives: package.json's `test:perf` script names
// an explicit, fixed file list (not a glob) and package.json is outside
// this ticket's file ownership (src/actors/stats.js + this file only) — so
// this file cannot wire itself into the `--test-concurrency=1` perf stage
// without editing a file this ticket does not own. Every assertion below —
// correctness AND timing — therefore runs under `npm run test:unit`
// (`node --test`'s default concurrency, i.e. other test files may run in
// parallel with this one). The timing assertions use a best-of-many-batches
// protocol (see `bestPerCallNs` below) specifically because that default
// concurrency exists: a single noisy batch (this process briefly sharing a
// core with another test file) must not fail the gate, only a batch that
// is fast under best-case scheduling is trusted. See this ticket's report
// for the full reasoning and the suggested fix (add this file to
// `test:perf`'s list in the same commit that touches package.json).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord } from '../../src/actors/pool.js';
import {
  composeStats,
  stats,
  markDirty,
  setSourceLayer,
  COMPOSITION_STEP_COUNT,
  DEFAULTS,
} from '../../src/actors/stats.js';

const EPS = 1e-4;

function closeTo(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${label}: expected ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

// ---------------------------------------------------------------------------
// Fixture — E14, 03-combat-math.md §12, verbatim
// ---------------------------------------------------------------------------
// Level-13 Ravager, reference allocation (2 STR / 1 DEX / 2 VIT / 0 ENE per
// level, levels 2..30 -> 12 allocations at clvl 13), rare Battle Axe (+55%
// ED, +25 AR), armour totalling defense 210, +35 life, +18 fire resist,
// difficulty Trial (-40 to each resistance). The ticket brief's own
// clarification: "Σ flat attackRating from the equipment layer = 105" (80
// from armour + 25 from the axe) — built into the fixture directly, not
// itemised piece by piece, since nothing in this ticket's scope needs a
// real ItemInstance/slot model (that's items/M3).

function makeE14Player(poolIndex = 0) {
  const actor = createActorRecord(poolIndex);
  actor.kind = 'player';
  actor.classId = 'ravager';
  actor.level = 13;
  actor.attributes.strength = 24; // 2/level x 12
  actor.attributes.dexterity = 12; // 1/level x 12
  actor.attributes.vitality = 24; // 2/level x 12
  actor.attributes.energy = 0; // 0/level x 12

  setSourceLayer(actor, 'equipment', {
    attackRating: 105, // 80 armour + 25 axe — see the ticket brief
    defense: 210,
    maxLife: 35,
    fireResist: 18,
    enhancedDamage: 55, // carried, must not leak into any derived row
  });
  setSourceLayer(actor, 'difficulty', {
    fireResist: -40, coldResist: -40, lightResist: -40,
    poisonResist: -40, magicResist: -40, physicalResist: -40,
  });
  return actor;
}

function makeMonster(poolIndex = 1, level = 10) {
  const actor = createActorRecord(poolIndex);
  actor.kind = 'monster';
  actor.classId = null; // pool.js#acquire: classId is null for kind !== 'player'
  actor.level = level;
  return actor;
}

// ---------------------------------------------------------------------------
// 1. E14 — all eleven rows, plus the layer stack and the step count
// ---------------------------------------------------------------------------

test('E14 — composed stat block, level-13 Ravager: all eleven rows reproduce to 1e-4', () => {
  const actor = makeE14Player();
  markDirty(actor);

  const stepsRan = composeStats(actor);
  assert.equal(stepsRan, COMPOSITION_STEP_COUNT, 'all ten composition steps must run, not a subset');

  const s = actor.stats;
  closeTo(s.strength, 54, 'strength');
  closeTo(s.dexterity, 32, 'dexterity');
  closeTo(s.vitality, 49, 'vitality');
  closeTo(s.maxLife, 210, 'maxLife');
  closeTo(s.maxMana, 16, 'maxMana');
  closeTo(s.attackRating, 260, 'attackRating');
  closeTo(s.defense, 218, 'defense');
  closeTo(s.fireResist, -22, 'fireResist');
  closeTo(s.lifeRegen, 1.260, 'lifeRegen');
  closeTo(s.manaRegen, 0.320, 'manaRegen');
  closeTo(s.maxStamina, 121, 'maxStamina');

  // The axe's +55% ED is carried on the block but must never leak into a
  // derived row — asserted both directly (it IS present) and indirectly
  // (attackRating above is exactly 260, not inflated by it).
  closeTo(s.enhancedDamage, 55, 'enhancedDamage (carried, not a derive() input)');
});

test('E14 — the layer stack: each of the six source layers contributed exactly what it should', () => {
  const actor = makeE14Player();
  markDirty(actor);
  composeStats(actor);

  // base — class archetype x level (03 §2.1 Ravager column: start
  // 30/20/25/10, class regen rates as percent, secondary resource base
  // maxRage 100 per §2.4). `manaReturnPercent: 0` added to this literal by
  // SKIL-5 (O-84/D-53): CLASS_TABLE now carries a manaReturnPercent row for
  // every class (Runeblade 8, Ravager/Emberwright 0 — 03:223 gives no base
  // for the other two, so D-53 gives them nothing rather than inventing a
  // number), so the base layer's own shape grew this one key. The Ravager
  // VALUE is unchanged (0); only the key's presence is new.
  assert.deepEqual(actor.sources.base, {
    strength: 30, dexterity: 20, vitality: 25, energy: 10,
    lifeRegenPercent: 0.6, manaRegenPercent: 2.0, maxRage: 100, maxResonance: 0,
    manaReturnPercent: 0,
  }, 'base layer must be exactly the Ravager class row at clvl 1, before any allocation');

  // allocated — the reference allocation's 12 level-ups.
  assert.deepEqual(actor.sources.allocated, {
    strength: 24, dexterity: 12, vitality: 24, energy: 0,
  }, 'allocated layer must be exactly actor.attributes (the spent points)');

  // equipment — the fixture's own combined partial, stored verbatim.
  assert.deepEqual(actor.sources.equipment, {
    attackRating: 105, defense: 210, maxLife: 35, fireResist: 18, enhancedDamage: 55,
  }, 'equipment layer must be exactly what setSourceLayer stored');

  // difficulty — Trial's -40 to every resistance.
  assert.deepEqual(actor.sources.difficulty, {
    fireResist: -40, coldResist: -40, lightResist: -40,
    poisonResist: -40, magicResist: -40, physicalResist: -40,
  }, 'difficulty layer must be exactly Trial\'s -40-per-resistance partial');

  // Cross-check: summing base+allocated+equipment+difficulty by hand for
  // the two attributes that matter to E14 must equal the composed value —
  // proves steps 2/3/4/7 all actually fed into the same block, not just
  // that the layers were stored (a bug that recorded sources.equipment but
  // never called applyLayer would still pass the deepEqual checks above).
  const expectedStrength = actor.sources.base.strength + actor.sources.allocated.strength;
  const expectedFireResist = actor.sources.equipment.fireResist + actor.sources.difficulty.fireResist;
  closeTo(actor.stats.strength, expectedStrength, 'strength = base + allocated (no other layer touches it here)');
  closeTo(actor.stats.fireResist, expectedFireResist, 'fireResist = equipment + difficulty (before caps, which do not bind here)');
});

test('secondary resources — base layer contributes each class\'s maxRage/maxResonance (03 §2.1/§2.4)', () => {
  // Regression for the defect ACTR-8 (vessels) hit: maxRage/maxResonance
  // both read 0 for every class because the base layer never contributed
  // them, so addRage/addResonance's clamp-to-max silently swallowed every
  // gain. E14 has no secondary-resource row, so it could not catch this —
  // this test is the direct gate instead.
  const ravager = createActorRecord(20);
  ravager.classId = 'ravager';
  ravager.level = 13;
  markDirty(ravager);
  composeStats(ravager);
  assert.equal(ravager.stats.maxRage, 100, 'a Ravager must compose maxRage = 100 (03 §2.4 base)');
  assert.equal(ravager.stats.maxResonance, 0, 'a Ravager has no Resonance — must stay 0, not inherit Rage\'s base');

  const runeblade = createActorRecord(21);
  runeblade.classId = 'runeblade';
  runeblade.level = 13;
  markDirty(runeblade);
  composeStats(runeblade);
  assert.equal(runeblade.stats.maxResonance, 3, 'a Runeblade must compose maxResonance = 3 (03 §2.4 base)');
  assert.equal(runeblade.stats.maxRage, 0, 'a Runeblade has no Rage — must stay 0');

  const emberwright = createActorRecord(22);
  emberwright.classId = 'emberwright';
  emberwright.level = 13;
  markDirty(emberwright);
  composeStats(emberwright);
  assert.equal(emberwright.stats.maxRage, 0, 'an Emberwright has neither secondary resource — maxRage must stay 0');
  assert.equal(emberwright.stats.maxResonance, 0, 'an Emberwright has neither secondary resource — maxResonance must stay 0');
});

test('setSourceLayer rejects base/allocated — those two layers are computed internally, never set externally', () => {
  const actor = createActorRecord(9);
  assert.throws(() => setSourceLayer(actor, 'base', { strength: 1 }), /must be one of/);
  assert.throws(() => setSourceLayer(actor, 'allocated', { strength: 1 }), /must be one of/);
});

// ---------------------------------------------------------------------------
// 1b. zero()'s non-zero defaults survive composition, on a BARE actor
// ---------------------------------------------------------------------------
// Regression for the defect CMBT-4 hit: `DEFAULTS` was built by seeding the
// reducer's initial accumulator with the seven non-zero overrides and then
// walking FIELD_NAMES setting every key (including those same seven) to 0 —
// clobbering the seed. `03 §6.2` R10's resistance clamp depends on
// `maxFireResist`'s default of 75 as its upper bound; with it silently at 0,
// every positive resistance collapsed to 0 (E4's whole table). This bug
// specifically does NOT show up in a test that overrides `maxFireResist`
// first (`clamp() — the dynamic resist/cap pair` below does exactly that) —
// overriding a field always sets it to something non-zero regardless of
// whether the default underneath was right, so that test could not have
// caught a wrong DEFAULT. The gate has to read the value with NOTHING
// touching it: no equipment, no status, no override, straight off zero().

test('zero() defaults — a freshly composed actor with no equipment/status/overrides reads the seven non-zero bases correctly', () => {
  const actor = createActorRecord(23);
  actor.classId = 'ravager';
  actor.level = 1; // no layer in this fixture ever touches these seven fields regardless of level
  markDirty(actor);
  composeStats(actor);

  const s = actor.stats;
  assert.equal(s.maxFireResist, 75, 'maxFireResist must default to 75 (01 §3.4), not 0');
  assert.equal(s.maxColdResist, 75, 'maxColdResist must default to 75');
  assert.equal(s.maxLightResist, 75, 'maxLightResist must default to 75');
  assert.equal(s.maxPoisonResist, 75, 'maxPoisonResist must default to 75');
  assert.equal(s.maxMagicResist, 75, 'maxMagicResist must default to 75');
  assert.equal(s.maxPhysicalResist, 75, 'maxPhysicalResist must default to 75');
  assert.equal(s.critMult, 100, 'critMult must default to 100 (no bonus), not 0');
  assert.equal(s.critChance, 0, 'critChance must default to 0 — this one WAS already 0 before the fix; asserted here so a future edit cannot flip it while "fixing" the other six');

  // The DEFAULTS table itself must agree — this is what the clobbering bug
  // actually broke (the seed, not just one call site of it).
  assert.equal(DEFAULTS.maxFireResist, 75, 'DEFAULTS.maxFireResist must be 75, not clobbered to 0');
  assert.equal(DEFAULTS.maxColdResist, 75);
  assert.equal(DEFAULTS.maxLightResist, 75);
  assert.equal(DEFAULTS.maxPoisonResist, 75);
  assert.equal(DEFAULTS.maxMagicResist, 75);
  assert.equal(DEFAULTS.maxPhysicalResist, 75);
  assert.equal(DEFAULTS.critMult, 100, 'DEFAULTS.critMult must be 100, not clobbered to 0');
});

test('zero() defaults — sibling check: every FIELD_NAMES key present in the seven-key seed reads back unclobbered; nothing besides those seven is non-zero', () => {
  // Generic version of the test above, driven off DEFAULTS itself rather
  // than a second hardcoded list — catches a future seeded-override key
  // (added the same way the seven were) that reintroduces this exact shape
  // of bug, without needing this file edited again when that happens.
  const knownSeed = {
    critMult: 100,
    maxFireResist: 75,
    maxColdResist: 75,
    maxLightResist: 75,
    maxPoisonResist: 75,
    maxMagicResist: 75,
    maxPhysicalResist: 75,
  };
  for (const key of Object.keys(DEFAULTS)) {
    if (DEFAULTS[key] !== 0) {
      assert.ok(
        key in knownSeed && DEFAULTS[key] === knownSeed[key],
        `DEFAULTS.${key} is a non-zero default (${DEFAULTS[key]}) this test does not recognise — ` +
          `if this is a deliberate new non-zero base, add it to this test's own expectation; if it is ` +
          `0 in the spec, something is clobbering/seeding it wrong the same way CMBT-4's defect did`,
      );
    }
  }
  for (const key of Object.keys(knownSeed)) {
    assert.equal(DEFAULTS[key], knownSeed[key], `DEFAULTS.${key} must equal its documented non-zero base`);
  }
});

// ---------------------------------------------------------------------------
// 2. clamp() genuinely runs — a case E14 itself never exercises
// ---------------------------------------------------------------------------
// E14's own numbers never hit a cap, so passing E14 alone would not prove
// step 9 executes. These are separate, deliberately cap-triggering fixtures.

test('clamp() — a static Cap-column field is clamped (critChance 0..75)', () => {
  const actor = createActorRecord(4);
  actor.kind = 'player';
  actor.classId = 'ravager';
  actor.level = 1;
  setSourceLayer(actor, 'status', { critChance: 1000 });
  markDirty(actor);
  composeStats(actor);
  assert.equal(actor.stats.critChance, 75, 'critChance must clamp to its Cap-column value (75), not read 1000');
});

test('clamp() — the dynamic resist/cap pair: raising maxFireResist raises fireResist\'s own ceiling', () => {
  const actor = createActorRecord(5);
  actor.kind = 'player';
  actor.classId = 'ravager';
  actor.level = 1;
  setSourceLayer(actor, 'equipment', { maxFireResist: 200, fireResist: 500 });
  markDirty(actor);
  composeStats(actor);
  // maxFireResist itself is capped to 90 first (01 §3.4: "they themselves
  // cap at 90"), then fireResist clamps to that already-clamped ceiling —
  // not the raw 200, and not the default 75.
  assert.equal(actor.stats.maxFireResist, 90, 'maxFireResist must itself clamp to 90');
  assert.equal(actor.stats.fireResist, 90, 'fireResist must clamp to the (already-clamped) maxFireResist, not to 75 or 200');
});

// ---------------------------------------------------------------------------
// 3. zero() genuinely runs — no leakage across recomposes on the same actor
// ---------------------------------------------------------------------------
// The stat block is a preallocated, mutated-in-place object (never
// reallocated across recomposes — see stats.js's own header). If zero()
// were skipped or buggy, a flat contribution from a PREVIOUS recompose
// could survive into the next one even after its layer was cleared.

test('zero() — removing an equipment bonus and recomposing drops it; no leakage from the previous recompose', () => {
  const actor = createActorRecord(6);
  actor.kind = 'player';
  actor.classId = 'ravager';
  actor.level = 1; // clvl 1 Ravager, no allocation: maxLife = 55 + 0 + 0 + flat

  setSourceLayer(actor, 'equipment', { maxLife: 999 });
  markDirty(actor);
  composeStats(actor);
  closeTo(actor.stats.maxLife, 55 + 999, 'first recompose must include the +999 flat maxLife bonus');

  setSourceLayer(actor, 'equipment', {}); // bonus removed
  composeStats(actor); // setSourceLayer already marked the actor dirty
  closeTo(actor.stats.maxLife, 55, 'second recompose must NOT retain the previous recompose\'s +999 — zero() must have reset the flat term');
});

// ---------------------------------------------------------------------------
// 4. Performance — composeStats recompose cost, paired with a correctness
//    check on the SAME actor immediately after the timed loop (rule 12).
// ---------------------------------------------------------------------------

/**
 * Best-of-many-batches per-call timing, in nanoseconds. Runs `fn` for
 * `iters` calls per batch, `batches` times, and returns the FASTEST
 * batch's average — the standard technique for a noisy-scheduler
 * micro-benchmark (a single unlucky batch, e.g. this process briefly
 * sharing a core with another `node --test` worker under this project's
 * default, non `--test-concurrency=1` unit stage, must not fail the gate;
 * only "the engine can genuinely do this fast" should).
 * @param {() => void} fn
 * @param {number} iters
 * @param {number} batches
 * @returns {number} nanoseconds/call, best batch.
 */
function bestPerCallNs(fn, iters, batches) {
  for (let i = 0; i < Math.min(2000, iters); i++) fn(); // warm up the JIT
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const elapsed = Number(process.hrtime.bigint() - start);
    const perCall = elapsed / iters;
    if (perCall < best) best = perCall;
  }
  return best;
}

test('composeStats: player recompose <= 40us, and the recomposed result is still exactly E14', () => {
  const actor = makeE14Player(7);
  let lastSteps = 0;
  const ns = bestPerCallNs(
    () => {
      markDirty(actor);
      lastSteps = composeStats(actor);
    },
    2000,
    20,
  );

  const us = ns / 1000;
  assert.ok(us <= 40, `player composeStats must be <= 40us, measured ${us.toFixed(3)}us (best of 20 batches)`);

  // Paired proof-of-work (rule 12): the timed run did not skip anything.
  assert.equal(lastSteps, COMPOSITION_STEP_COUNT, 'the timed calls must still run all ten steps');
  closeTo(actor.stats.maxLife, 210, 'post-timing maxLife must still equal E14 (210) — a fast-but-wrong result fails');
  closeTo(actor.stats.attackRating, 260, 'post-timing attackRating must still equal E14 (260)');
  closeTo(actor.stats.defense, 218, 'post-timing defense must still equal E14 (218)');
});

test('composeStats: monster recompose <= 6us, with a paired step-count/finite-result proof', () => {
  const actor = makeMonster(8, 10);
  let lastSteps = 0;
  const ns = bestPerCallNs(
    () => {
      markDirty(actor);
      lastSteps = composeStats(actor);
    },
    2000,
    20,
  );

  const us = ns / 1000;
  assert.ok(us <= 6, `monster composeStats must be <= 6us, measured ${us.toFixed(3)}us (best of 20 batches)`);

  // Paired proof-of-work: a monster has no class table (01 §4.3/03 §3 —
  // bestiary-owned, not this ticket's), so there is no E14-style expected
  // value to compare against here. What IS this ticket's business is that
  // the full ten-step pipeline still ran (not bailed early for speed) and
  // produced a finite, non-NaN result rather than silently skipping work.
  assert.equal(lastSteps, COMPOSITION_STEP_COUNT, 'the timed calls must still run all ten steps, even for a classless monster');
  for (const key of ['maxLife', 'maxMana', 'maxStamina', 'attackRating', 'defense', 'lifeRegen', 'manaRegen']) {
    assert.ok(Number.isFinite(actor.stats[key]), `derived field ${key} must be a finite number, got ${actor.stats[key]}`);
  }
  assert.ok(actor.stats.attackRating >= 0, 'attackRating must clamp to >= 0 (01 §4.3)');
  assert.ok(actor.stats.defense >= 0, 'defense must clamp to >= 0 (01 §4.3)');
});

// ---------------------------------------------------------------------------
// 5. stats() accessor — recomposes only when dirty
// ---------------------------------------------------------------------------

test('stats(actor) recomposes when dirty and returns the same preallocated block when clean', () => {
  const actor = makeE14Player(10);
  markDirty(actor);
  const first = stats(actor);
  closeTo(first.maxLife, 210, 'first stats() call must recompose (actor started dirty)');
  assert.equal(actor.statsDirty, false, 'stats() must clear the dirty flag after recomposing');

  const second = stats(actor);
  assert.equal(second, first, 'stats() must return the SAME object reference when not dirty (Alloc: no)');
});
