// tests/combat/status.test.js
//
// CMBT-4 acceptance tests for src/combat/status.js (+ the wiring it gets in
// src/combat/packet.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim):
//   1. Diminishing returns ×1/0.6/0.36/0.216, then immunity.
//   2. 4 Hz DoT cadence — every 15 fixed steps, bleeding every 30 —
//      scheduled purely against `ctx.time.step`, never a wall clock.
//   3. E8 (chill accumulation to freeze) reproduces exactly — all four rows.
// Plus O-51's own regression test (import ONLY packet.js) and O-48 (the
// `status` StatSources layer actually gets populated).
//
// Not this ticket's (see status.js's own header): the actual runtime
// wiring of `ActorsSystem.applyStatus`/`.setSourceLayer`/etc onto
// `ctx.get('actors')` — `src/actors/index.js` does not forward them yet
// (verified: its tracked history stops at ACTR-6). Every test below that
// needs a working `applyStatus`/`setSourceLayer` builds a stub
// `actorsSystem` wired to the REAL `src/actors/status.js`/
// `src/actors/stats.js` functions — the exact same precedent
// `tests/combat/resolve.test.js` already established for the identical
// situation (see that file's own `actorsSystem = { applyStatus(...) {...} }`
// stub).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rollDrChain,
  accumulateChillPoints,
  applyColdHit,
  createColdHitTracker,
  secondsSinceLastColdHit,
  recordColdHitStep,
  onActorDamageForChill,
  rebuildStatusLayer,
  applyStatusFromPacket,
  expireBySourceAcrossActors,
  runDotTicks,
  DR_CHAIN_MULTIPLIERS,
  DR_CHAIN_WINDOW_SECONDS,
  DR_CHAIN_IMMUNITY_SECONDS,
  CHILL_DECAY_PER_SECOND,
  CHILL_FREEZE_THRESHOLD,
  CHILL_DEFAULT_MAGNITUDE,
  FROZEN_BASE_DURATION,
  FROZEN_CHAMPION_MULT,
  FROZEN_UNIQUE_MULT,
  TICK_INTERVAL_STEPS,
} from '../../src/combat/status.js';
import { CombatSystem, PacketPool } from '../../src/combat/packet.js';
import { DamageResultPool, RESULT_POOL_CAPACITY } from '../../src/combat/resolve.js';
import { createActorRecord } from '../../src/actors/pool.js';
import {
  applyStatus, removeStatus, hasStatus, statusStacks, statusRemaining,
  clearStatuses, expireBySource, STATUS,
} from '../../src/actors/status.js';
import { composeStats, setSourceLayer, stats as recomposeStats } from '../../src/actors/stats.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

const EPS = 1e-4;
const FIXED_HZ = 60;

function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

/** `applyStatus` stores duration as an INTEGER step count
 * (`Math.round(duration*60)`) — round-tripping a seconds value through it
 * and back out via `statusRemaining` loses up to ~1/120 s to that
 * quantization. Expected values compared against a real applied instance's
 * `statusRemaining` must be run through the same quantization, or a
 * true-to-the-formula duration (e.g. 0.72s) will spuriously fail against an
 * exact-seconds `approx` check (43/60 = 0.71667, not 0.72). */
function stepQuantized(seconds) {
  return Math.round(seconds * FIXED_HZ) / FIXED_HZ;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextPoolIndex = 0;
/** A live `Actor` record (same stand-in style `tests/actors/status.test.js`
 * already uses for this exact sibling file). `classId: null` + all four
 * attributes present avoids the NaN trap (`composeStats` yields NaN in
 * eleven fields if any of strength/dexterity/vitality/energy is missing). */
function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex);
  actor.id = overrides.id ?? (nextPoolIndex + 1);
  actor.generation = overrides.generation ?? 0;
  nextPoolIndex++;
  actor.dead = overrides.dead ?? false;
  actor.rank = overrides.rank ?? 'normal';
  actor.classId = null;
  actor.level = overrides.level ?? 10;
  actor.attributes = { strength: 20, dexterity: 20, vitality: 20, energy: 20 };
  composeStats(actor);
  if (overrides.statOverrides) {
    setSourceLayer(actor, 'equipment', overrides.statOverrides);
  }
  return actor;
}

/** A stub `actorsSystem` wired to the REAL, accepted src/actors/status.js +
 * src/actors/stats.js functions — mirrors resolve.test.js's own stub for
 * the identical "ActorsSystem doesn't forward these yet" gap. `all` is a
 * live array the test can push spawned actors into. */
function makeActorsSystemStub() {
  const all = [];
  return {
    all,
    applyStatus,
    removeStatus,
    hasStatus,
    statusStacks,
    statusRemaining,
    clearStatuses,
    expireBySource,
    setSourceLayer,
    stats: (actor) => recomposeStats(actor),
    byId(id) { return all.find((a) => a.id === id) || null; },
  };
}

function makeMockRng(nextValue = 0.01) {
  return { next() { return nextValue; }, range(min, max) { return (min + max) / 2; } };
}

let packetPool = new PacketPool(64);
function makePacket(overrides = {}) {
  const p = packetPool.acquire();
  Object.assign(p, {
    sourceId: 1, sourceGen: 0, sourceSkillId: 'test_skill', poisonDuration: 0,
    onHitCount: 0,
    ...overrides,
  });
  return p;
}

// ---------------------------------------------------------------------------
// 1. The diminishing-returns chain — ×1 / 0.6 / 0.36 / 0.216, then immunity
// ---------------------------------------------------------------------------

test('DR chain: four consecutive rolls land at x1, x0.6, x0.36, x0.216, printed', () => {
  const actor = makeActor();
  const expected = [1, 0.6, 0.36, 0.216];
  const got = [];
  let step = 0;
  for (let i = 0; i < 4; i++) {
    const r = rollDrChain(actor, step);
    assert.equal(r.allowed, true, `application #${i + 1} must be allowed`);
    got.push(r.multiplier);
    step += 10; // well inside the 6.0s (360-step) window
  }
  // eslint-disable-next-line no-console
  console.log('DR chain multipliers (applications 1-4):', got.map((v) => v.toFixed(3)).join(', '));
  for (let i = 0; i < 4; i++) approx(got[i], expected[i], `application #${i + 1}`);
  assert.deepEqual(DR_CHAIN_MULTIPLIERS.slice(), expected);
});

test('DR chain: the fifth application within the window is refused and opens a 6.0s immunity window', () => {
  const actor = makeActor();
  let step = 0;
  for (let i = 0; i < 4; i++) {
    const r = rollDrChain(actor, step);
    assert.equal(r.allowed, true);
    step += 5;
  }
  const fifth = rollDrChain(actor, step);
  assert.equal(fifth.allowed, false, 'the 5th application must be refused');
  assert.equal(fifth.multiplier, 0);
  approx(actor.ccImmuneUntil - step, DR_CHAIN_IMMUNITY_SECONDS * FIXED_HZ, 'ccImmuneUntil window');

  // Refused again while still inside the immunity window.
  const stillImmune = rollDrChain(actor, step + 1);
  assert.equal(stillImmune.allowed, false);
});

test('DR chain: after the 6.0s immunity window lapses, the chain restarts fresh at x1', () => {
  const actor = makeActor();
  let step = 0;
  for (let i = 0; i < 5; i++) { rollDrChain(actor, step); step += 1; } // burn through to refusal
  assert.ok(actor.ccImmuneUntil > step);

  const afterImmunity = actor.ccImmuneUntil + 1;
  const r = rollDrChain(actor, afterImmunity);
  assert.equal(r.allowed, true);
  approx(r.multiplier, 1, 'chain restarts at x1 once immunity lapses');
});

test('DR chain: the rolling 6.0s window resets the chain to x1 even without a refusal', () => {
  const actor = makeActor();
  const first = rollDrChain(actor, 0);
  approx(first.multiplier, 1, 'first application');
  const windowSteps = DR_CHAIN_WINDOW_SECONDS * FIXED_HZ;
  const second = rollDrChain(actor, windowSteps + 1); // just past the window
  assert.equal(second.allowed, true);
  approx(second.multiplier, 1, 'chain reset by the elapsed window, not a 2nd-tier application');
});

test('DR chain measured as actual stunned durations (rider path), printed', () => {
  const actor = makeActor();
  const rng = makeMockRng(0.01); // always beats any chance > 1
  const events = new EventBus();
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const env = { actorsSystem, rng, step: 0, events };

  const baseDuration = 2.0;
  const measured = [];
  for (let i = 0; i < 5; i++) {
    const packet = makePacket({
      onHitCount: 1,
      onHitStatus: [{ status: 'stunned', chance: 100, duration: baseDuration, magnitude: 0, stacks: 1 }],
    });
    env.step = i * 10;
    applyStatusFromPacket(packet, actor, null, env);
    const remaining = statusRemaining(actor, 'stunned', env.step);
    measured.push(remaining);
    packetPool.release(packet);
    // `stunned` stacks by REFRESH (max-wins on remaining time, 01 §7.3) —
    // clear the still-live instance between applications so each new
    // application's OWN (DR-chain-shrunk) duration is directly observable,
    // instead of being masked by max-wins against the still-longer
    // previous instance. The DR chain's own counter/window (stunChain/
    // stunChainAt/ccImmuneUntil) lives on the actor record, not on the
    // instance, so clearing the instance does not reset the chain.
    removeStatus(actor, 'stunned');
  }
  // eslint-disable-next-line no-console
  console.log('DR chain — measured stunned durations (base 2.0s):', measured.map((v) => v.toFixed(4)).join(', '));
  approx(measured[0], stepQuantized(baseDuration * 1), 'application 1');
  approx(measured[1], stepQuantized(baseDuration * 0.6), 'application 2');
  approx(measured[2], stepQuantized(baseDuration * 0.36), 'application 3');
  approx(measured[3], stepQuantized(baseDuration * 0.216), 'application 4');
  approx(measured[4], 0, 'application 5 refused — no instance, statusRemaining reads 0');
});

// ---------------------------------------------------------------------------
// 2. E8 — chill accumulation to freeze, all four rows, printed
// ---------------------------------------------------------------------------

// `expected` holds FULL PRECISION values (25 x 0.675 = 16.875, not the
// rounded 16.88 the spec table displays) — the ticket's own worked
// arithmetic for E8.1 ("30 -> 30 - 25x0.675 + 30 = 43.125 -> 43.13") makes
// clear the *printed* row is rounded to 2 decimals for display but the
// underlying accumulator carries full precision into the next hit. Each
// test below still PRINTS the 2-decimal-rounded values, which match the
// spec table's own rows exactly.
const E8_ROWS = [
  { name: 'E8.1', intervalSeconds: 0.675, expected: [30, 43.125, 56.25, 69.375, 82.5, 95.625, 108.75], freezeOnHit: 7 },
  { name: 'E8.2', intervalSeconds: 0.4675, expected: [30, 48.3125, 66.625, 84.9375, 103.25], freezeOnHit: 5 },
  { name: 'E8.3', intervalSeconds: 0.350, expected: [30, 51.25, 72.5, 93.75, 115], freezeOnHit: 5 },
  { name: 'E8.4', intervalSeconds: 2.000, expected: [30, 30, 30, 30, 30], freezeOnHit: null },
];

for (const row of E8_ROWS) {
  test(`E8 chill accumulation — ${row.name}: interval ${row.intervalSeconds}s`, () => {
    let chillPoints = 0;
    const got = [];
    let frozenOnHit = null;
    for (let hit = 1; hit <= row.expected.length; hit++) {
      // First hit: no prior hit at all -> full decay (dtSeconds = Infinity),
      // matching applyColdHit's own "no prior hit" contract.
      const dt = hit === 1 ? Infinity : row.intervalSeconds;
      chillPoints = accumulateChillPoints(chillPoints, CHILL_DEFAULT_MAGNITUDE, dt);
      got.push(chillPoints);
      if (frozenOnHit === null && chillPoints >= CHILL_FREEZE_THRESHOLD) {
        frozenOnHit = hit;
        chillPoints = 0; // 03 §7.3: "set chillPoints = 0" — consumed on trigger
      }
    }
    // eslint-disable-next-line no-console
    console.log(`${row.name} chillPoints after each hit:`, got.map((v) => v.toFixed(2)).join(', '), '| frozen on hit:', frozenOnHit);
    for (let i = 0; i < row.expected.length; i++) approx(got[i], row.expected[i], `${row.name} hit #${i + 1}`);
    assert.equal(frozenOnHit, row.freezeOnHit, `${row.name} freeze trigger`);
  });
}

test('E8 end-to-end through applyColdHit + a real applyStatus, using a live ColdHitTracker (E8.1 cadence)', () => {
  const actor = makeActor();
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const tracker = createColdHitTracker(4);

  let step = 0;
  const stepsPerHit = Math.round(0.675 * 60); // ~ nearest whole-step cadence for the live integration path
  let frozenInstance = null;
  for (let hit = 1; hit <= 7; hit++) {
    const dt = secondsSinceLastColdHit(tracker, actor, step);
    const result = applyColdHit(actor, { dtSeconds: dt, step, sourceId: 5, sourceGen: 0, sourceSkill: 'attack', actorsSystem });
    recordColdHitStep(tracker, actor, step);
    if (result.triggered && result.instance) frozenInstance = result.instance;
    step += stepsPerHit;
  }
  assert.ok(frozenInstance, 'frozen must actually have been applied through a real applyStatus call by hit 7');
  assert.equal(frozenInstance.status, 'frozen');
  assert.equal(hasStatus(actor, 'frozen'), true);
  approx(frozenInstance.duration ?? 0, 0, 'sanity: instance has no .duration field (it is expiresStep-based)'); // documents the shape, not a real assertion target
});

test('E8: cannotBeFrozen blocks the frozen application but the accumulator still resets to 0', () => {
  const actor = makeActor();
  setSourceLayer(actor, 'equipment', { cannotBeFrozen: true });
  recomposeStats(actor); // setSourceLayer only marks dirty — force the recompose so .stats.cannotBeFrozen is live
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);

  let chillPoints = 0;
  let step = 0;
  let triggered = false;
  for (let hit = 1; hit <= 7; hit++) {
    const dt = hit === 1 ? Infinity : 0.675;
    const before = actor.chillPoints;
    const result = applyColdHit(actor, { dtSeconds: dt, step, actorsSystem });
    chillPoints = result.chillPointsAfterHit;
    if (result.triggered) triggered = true;
    step += 41;
  }
  assert.equal(triggered, true, 'the accumulator must still cross the threshold and fire the attempt');
  assert.equal(hasStatus(actor, 'frozen'), false, 'cannotBeFrozen must block the actual application');
  assert.equal(actor.chillPoints, 0, 'the accumulator resets to 0 regardless of the block');
});

test('E8: a boss never freezes — the trigger substitutes chilled(60, 2.0s) instead', () => {
  const actor = makeActor({ rank: 'boss' });
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);

  let step = 0;
  let result;
  for (let hit = 1; hit <= 7; hit++) {
    result = applyColdHit(actor, { dtSeconds: hit === 1 ? Infinity : 0.675, step, actorsSystem });
    step += 41;
  }
  assert.equal(result.triggered, true);
  assert.equal(hasStatus(actor, 'frozen'), false, 'boss is immune to frozen outright');
  assert.equal(hasStatus(actor, 'chilled'), true, 'the substitute chilled application landed instead');
  assert.equal(result.instance.status, 'chilled');
  assert.equal(result.instance.magnitude, 60);
});

test('E8: champion/unique scale frozen duration by 0.50 / 0.35 respectively', () => {
  for (const [rank, mult] of [['champion', FROZEN_CHAMPION_MULT], ['unique', FROZEN_UNIQUE_MULT]]) {
    const actor = makeActor({ rank });
    const actorsSystem = makeActorsSystemStub();
    actorsSystem.all.push(actor);
    let step = 0;
    let result;
    let freezeStep = 0;
    for (let hit = 1; hit <= 7; hit++) {
      result = applyColdHit(actor, { dtSeconds: hit === 1 ? Infinity : 0.675, step, actorsSystem });
      if (result.triggered) freezeStep = step; // capture BEFORE the trailing increment below
      step += 41;
    }
    assert.ok(result.instance, `${rank} must still freeze`);
    const remaining = statusRemaining(actor, 'frozen', freezeStep);
    approx(remaining, stepQuantized(FROZEN_BASE_DURATION * mult), `${rank} frozen duration`);
  }
});

// ---------------------------------------------------------------------------
// 3. 4 Hz / 2 Hz DoT cadence — scheduled on ctx.time.step, phase actor.id % 15
// ---------------------------------------------------------------------------

test('DoT cadence: burning/poisoned tick exactly every 15 steps, bleeding every 30, phase-offset by actor.id % 15', () => {
  const actor = makeActor({ id: 23 }); // 23 % 15 = 8
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);

  const spec = { status: 'burning', step: 0, sourceId: 1, sourceGen: 0, sourceSkill: 'test', element: 'fire', magnitude: 12, duration: 3.0, stacks: 1 };
  const inst = applyStatus(actor, spec);
  assert.ok(inst);
  assert.equal(TICK_INTERVAL_STEPS.burning, 15);
  assert.equal(TICK_INTERVAL_STEPS.bleeding, 30);

  const events = new EventBus();
  const resultPool = new DamageResultPool(RESULT_POOL_CAPACITY);
  let tickCount = 0;
  events.on('actor:damage', () => { tickCount++; });

  const env = { actorsSystem, events, resultPool, step: 0 };
  const tickSteps = [];
  for (let step = 0; step <= 200; step++) {
    env.step = step;
    const before = tickCount;
    runDotTicks(env);
    if (tickCount > before) tickSteps.push(step);
  }

  // eslint-disable-next-line no-console
  console.log('burning tick steps (actor.id=23, phase 23%15=8):', tickSteps.join(', '));
  assert.ok(tickSteps.length >= 3, 'must have ticked at least a few times over 200 steps');
  for (let i = 1; i < tickSteps.length; i++) {
    assert.equal(tickSteps[i] - tickSteps[i - 1], 15, 'every consecutive tick is exactly 15 steps apart');
  }
  assert.equal(tickSteps[0], 8, 'first tick lands on actor.id % 15 = 8, per computeNextTickStep (01 §7.4)');
});

test('DoT cadence: bleeding ticks every 30 steps', () => {
  const actor = makeActor({ id: 4 });
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  applyStatus(actor, { status: 'bleeding', step: 0, sourceId: 1, sourceGen: 0, sourceSkill: 'test', element: null, magnitude: 8, duration: 5.0, stacks: 1 });

  const events = new EventBus();
  const resultPool = new DamageResultPool(RESULT_POOL_CAPACITY);
  const tickSteps = [];
  events.on('actor:damage', (payload) => { tickSteps.push(payload); });
  const env = { actorsSystem, events, resultPool, step: 0 };
  const steps = [];
  for (let step = 0; step <= 200; step++) {
    env.step = step;
    const before = tickSteps.length;
    runDotTicks(env);
    if (tickSteps.length > before) steps.push(step);
  }
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i] - steps[i - 1], 30);
});

test('DoT cadence never reads dt/wall clock — src/combat/status.js has no performance.now()/Date.now()/Math.random() anywhere', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/combat/status.js', import.meta.url), 'utf8');
  assert.equal(/performance\.now\(|Date\.now\(|Math\.random\(/.test(src), false);
});

test('DoT tick: tickDamage = magnitude x tickInterval, resistance-mitigated, no crit/leech/hit-recovery/knockback', () => {
  const actor = makeActor({ id: 7 });
  // NOTE: `maxFireResist` must be set explicitly alongside `fireResist` —
  // src/actors/stats.js's own `DEFAULTS` table has a real, pre-existing
  // defect (found while writing this test, reported to the orchestrator,
  // NOT fixed here — stats.js is not this ticket's file): its
  // `FIELD_NAMES.reduce((acc,key)=>{acc[key]=0;...}, {critMult:100,
  // maxFireResist:75,...})` seeds the accumulator with the documented
  // special defaults but then the reducer callback unconditionally does
  // `acc[key]=0` for EVERY key in FIELD_NAMES — including `critMult` and
  // all six `max*Resist` fields, which ARE themselves entries in
  // `FIELD_NAMES` — clobbering the seeded 100/75 straight back to 0. A
  // fresh actor's `stats.maxFireResist`/`stats.critMult` are 0 today, not
  // the documented 75/100, until a later ticket fixes stats.js's own
  // `DEFAULTS` construction. Working around it here, not depending on it.
  setSourceLayer(actor, 'equipment', { fireResist: 50, maxFireResist: 75 });
  recomposeStats(actor); // setSourceLayer only marks dirty — force the recompose
  actor.life = 1000;
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 9, sourceGen: 0, sourceSkill: 's', element: 'fire', magnitude: 20, duration: 3.0, stacks: 1 });

  const events = new EventBus();
  const resultPool = new DamageResultPool(RESULT_POOL_CAPACITY);
  let seenResult = null;
  events.on('actor:damage', ({ result }) => { seenResult = { ...result }; });
  const env = { actorsSystem, events, resultPool, step: 0 };

  const lifeBefore = actor.life;
  let ticked = false;
  for (let step = 0; step <= 20; step++) {
    env.step = step;
    runDotTicks(env);
    if (seenResult) { ticked = true; break; }
  }
  assert.ok(ticked, 'must have ticked within the first 15-20 steps');
  const rawTick = 20 * (15 / 60); // magnitude x tickInterval = 20 x 0.25 = 5
  const expectedTick = rawTick * (1 - 50 / 100); // 50% fire resist
  approx(lifeBefore - actor.life, expectedTick, 'life lost matches resisted tick damage');
  assert.equal(seenResult.crit, false);
  assert.equal(seenResult.blocked, false);
  assert.equal(seenResult.lifeStolen, 0);
  assert.equal(seenResult.knockedBack, false);
  assert.equal(seenResult.hitRecovery, false);
});

// ---------------------------------------------------------------------------
// O-48 — the `status` StatSources layer actually gets populated
// ---------------------------------------------------------------------------

test('O-48: chilled reaches composeStats through the status layer (movementSpeed/IAS/FCR)', () => {
  const actor = makeActor();
  const before = actor.stats.movementSpeed;
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const events = new EventBus();

  applyStatus(actor, { status: 'chilled', step: 0, sourceId: 1, sourceGen: 0, sourceSkill: 'attack', element: 'cold', magnitude: 30, duration: 2.0, stacks: 1 });
  rebuildStatusLayer(actor, actorsSystem, events);
  recomposeStats(actor);

  approx(actor.stats.movementSpeed, before - 30, 'chilled reduces movementSpeed by its magnitude, via the status layer');
  approx(actor.stats.increasedAttackSpeed, -30, 'and increasedAttackSpeed');
  approx(actor.stats.fasterCastRate, -30, 'and fasterCastRate');
});

test('O-48: the status layer clears back out once the status is removed', () => {
  const actor = makeActor();
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const events = new EventBus();

  applyStatus(actor, { status: 'slowed', step: 0, sourceId: 1, sourceGen: 0, sourceSkill: 'x', element: null, magnitude: 40, duration: 2.0, stacks: 1 });
  rebuildStatusLayer(actor, actorsSystem, events);
  recomposeStats(actor);
  approx(actor.stats.movementSpeed, -40, 'slowed applied');

  removeStatus(actor, 'slowed');
  rebuildStatusLayer(actor, actorsSystem, events);
  recomposeStats(actor);
  approx(actor.stats.movementSpeed, 0, 'status layer cleared once the status is gone');
});

// ---------------------------------------------------------------------------
// applyStatusFromPacket — poison seed, onHitStatus riders, ccReduction
// ---------------------------------------------------------------------------

test('applyStatusFromPacket: seeds the poison DoT from result.poison, duration NOT ccReduction-adjusted', () => {
  const actor = makeActor();
  setSourceLayer(actor, 'equipment', { ccReduction: 50 });
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const env = { actorsSystem, rng: makeMockRng(0.01), step: 0, events: new EventBus() };

  const packet = makePacket({ poisonDuration: 6.0 });
  const result = { poison: 54 };
  applyStatusFromPacket(packet, actor, result, env);

  assert.equal(hasStatus(actor, 'poisoned'), true);
  approx(statusRemaining(actor, 'poisoned', 0), 6.0, 'poison duration is NOT ccReduction-adjusted');
  packetPool.release(packet);
});

test('applyStatusFromPacket: onHitStatus riders roll independently and ccReduction shrinks non-exempt durations', () => {
  const actor = makeActor();
  setSourceLayer(actor, 'equipment', { ccReduction: 25 });
  recomposeStats(actor); // setSourceLayer only marks dirty — force the recompose
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const env = { actorsSystem, rng: makeMockRng(0.01), step: 0, events: new EventBus() };

  const packet = makePacket({
    onHitCount: 1,
    onHitStatus: [{ status: 'blinded', chance: 100, duration: 3.0, magnitude: 60, stacks: 1 }],
  });
  applyStatusFromPacket(packet, actor, null, env);

  assert.equal(hasStatus(actor, 'blinded'), true);
  approx(statusRemaining(actor, 'blinded', 0), 3.0 * (1 - 25 / 100), 'blinded IS ccReduction-adjusted');
  packetPool.release(packet);
});

test('applyStatusFromPacket: a rider below its chance roll does not apply', () => {
  const actor = makeActor();
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(actor);
  const env = { actorsSystem, rng: makeMockRng(99.9), step: 0, events: new EventBus() };

  const packet = makePacket({
    onHitCount: 1,
    onHitStatus: [{ status: 'cursed', chance: 10, duration: 6.0, magnitude: 40, stacks: 1 }],
  });
  applyStatusFromPacket(packet, actor, null, env);
  assert.equal(hasStatus(actor, 'cursed'), false);
  packetPool.release(packet);
});

// ---------------------------------------------------------------------------
// expireBySourceAcrossActors
// ---------------------------------------------------------------------------

test('expireBySourceAcrossActors: strips every instance from that source across all live actors, same-status different-source survives', () => {
  const a1 = makeActor();
  const a2 = makeActor();
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(a1, a2);
  const events = new EventBus();
  const seen = [];
  // The emitted payload is a REUSED scratch object (see status.js's own
  // `EXPIRE_EVENT_SCRATCH`) — copy it immediately, never stash the raw
  // reference, the same rule every other pooled/scratch payload in this
  // engine already requires (MoveResult, resolve.js's damagePayload).
  events.on('actor:status', (p) => seen.push({ ...p }));

  applyStatus(a1, { status: 'cursed', step: 0, sourceId: 99, sourceGen: 0, sourceSkill: 'haste_dust', element: null, magnitude: 10, duration: 10, stacks: 1 });
  applyStatus(a2, { status: 'cursed', step: 0, sourceId: 99, sourceGen: 0, sourceSkill: 'haste_dust', element: null, magnitude: 10, duration: 10, stacks: 1 });
  applyStatus(a2, { status: 'shocked', step: 0, sourceId: 42, sourceGen: 0, sourceSkill: 'other', element: null, magnitude: 12, duration: 4, stacks: 1 });

  const env = { actorsSystem, events };
  const expired = expireBySourceAcrossActors(99, 0, null, env);

  assert.equal(expired, 2);
  assert.equal(hasStatus(a1, 'cursed'), false);
  assert.equal(hasStatus(a2, 'cursed'), false);
  assert.equal(hasStatus(a2, 'shocked'), true, 'a different source on the same actor survives');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].duration, 0);
  // Regression coverage for the bug fixed alongside the allocation repair:
  // emission used to read the instance's fields AFTER the pool had already
  // released (zeroed) them, so `status`/`source` silently came back
  // `null`/`0` instead of the real values.
  assert.equal(seen[0].status, 'cursed', 'emitted status must be the real value, not a post-release null');
  assert.equal(seen[0].source, 99, 'emitted source must be the real sourceId, not a post-release 0');
  assert.equal(seen[1].status, 'cursed');
  assert.equal(seen[1].source, 99);
});

test('expireBySourceAcrossActors: status-filtered call emits the correct status/source too', () => {
  const a1 = makeActor();
  const actorsSystem = makeActorsSystemStub();
  actorsSystem.all.push(a1);
  const events = new EventBus();
  const seen = [];
  events.on('actor:status', (p) => seen.push({ ...p }));

  applyStatus(a1, { status: 'shocked', step: 0, sourceId: 77, sourceGen: 0, sourceSkill: 'thunder_step', element: null, magnitude: 12, duration: 4, stacks: 1 });

  const env = { actorsSystem, events };
  const expired = expireBySourceAcrossActors(77, 0, 'shocked', env);

  assert.equal(expired, 1);
  assert.equal(hasStatus(a1, 'shocked'), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'shocked');
  assert.equal(seen[0].source, 77);
  assert.equal(seen[0].duration, 0);
});

// ---------------------------------------------------------------------------
// 12.A01 — expireBySource must allocate < 1 byte/call (TEST-6 finding, fixed)
// ---------------------------------------------------------------------------
//
// O-43 methodology, verbatim (see tests/combat/resolve.perf.test.js's own
// header for the same reasoning, applied there to `resolve()`): a probe
// below ~1M iterations is noise, not signal — this project's own measured
// floor is 80 B/call at N=10k vs. 0.33 B/call at N=4M on an actually
// allocation-free function. Sampled at N=1e6 and N=4e6; judged by TOTAL
// bytes growing between the two (not either mean alone), printed rather
// than reduced to a bare boolean. Left in this file (not split into a
// `.perf.test.js`) per this round's own instruction — `src/combat/packet.js`
// is off-limits and only this file may change.
//
// The original defect (TEST-6's finding, live): `expireBySourceAcrossActors`
// built two `.filter()` arrays per live actor per call, plus an `.every()`
// closure capturing `status`/`sourceId` for the status-filtered branch — all
// three allocate every single call, independent of how many (if any)
// instances actually match. The scenario below reproduces exactly that
// "scan, nothing matches" cold path at scale (10 live actors, each carrying
// unrelated statuses from OTHER sources) — the overwhelmingly common real
// case for a hit-or-miss `expireBySource(sourceId, ...)` call, and the one
// the original `.filter()` allocated on regardless.

test('12.A01: expireBySource allocates < 1 byte/call at N >= 1e6 (O-43 methodology)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ACTOR_COUNT = 10;
  const actorsSystemPerf = makeActorsSystemStub();
  for (let i = 0; i < ACTOR_COUNT; i++) {
    const a = makeActor();
    applyStatus(a, { status: 'shocked', step: 0, sourceId: 100 + i, sourceGen: 0, sourceSkill: 'x', element: null, magnitude: 12, duration: 1e9, stacks: 1 });
    applyStatus(a, { status: 'cursed', step: 0, sourceId: 200 + i, sourceGen: 0, sourceSkill: 'y', element: null, magnitude: 10, duration: 1e9, stacks: 1 });
    actorsSystemPerf.all.push(a);
  }
  // A silent events object — `hasStatus`/removal aren't exercised on this
  // path at all (sourceId 999999 never matches anything above), but a real
  // `EventBus` is used anyway so the measurement includes the actual guard
  // checks `expireBySourceAcrossActors` runs against `env.events`.
  const env = { actorsSystem: actorsSystemPerf, events: new EventBus() };

  const runOneCall = () => { expireBySourceAcrossActors(999999, 0, null, env); };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `expireBySource allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `expireBySource must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});

// ---------------------------------------------------------------------------
// O-51 — the module-graph regression test: import ONLY packet.js
// ---------------------------------------------------------------------------

test('packet.js alone (no status.js import) wires applyStatusFromPacket/expireBySource/fixedUpdate onto CombatSystem', async () => {
  const { CombatSystem: FreshCombatSystem } = await import('../../src/combat/packet.js');
  const combat = new FreshCombatSystem();

  assert.equal(typeof combat.applyStatusFromPacket, 'function', 'CombatSystem#applyStatusFromPacket must exist once packet.js is loaded');
  assert.equal(typeof combat.expireBySource, 'function', 'CombatSystem#expireBySource must exist once packet.js is loaded');
  assert.equal(typeof combat.fixedUpdate, 'function', 'CombatSystem#fixedUpdate must exist once packet.js is loaded');
});

test('CombatSystem.fixedUpdate actually runs the DoT tick loop end-to-end through a real init()', async () => {
  const combat = new CombatSystem();
  const events = new EventBus();
  const actorsSystem = makeActorsSystemStub();
  const actor = makeActor({ id: 5 });
  actorsSystem.all.push(actor);
  actor.life = 1000;
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 1, sourceGen: 0, sourceSkill: 'test', element: 'fire', magnitude: 20, duration: 3.0, stacks: 1 });

  const ctx = {
    rng: new Rng(12345),
    events,
    time: { step: 0 },
    get(id) { if (id === 'actors') return actorsSystem; throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };
  await combat.init(ctx);

  let ticked = false;
  events.on('actor:damage', () => { ticked = true; });
  for (let step = 0; step <= 20; step++) {
    ctx.time.step = step;
    combat.fixedUpdate(1 / 60, ctx);
    if (ticked) break;
  }
  assert.ok(ticked, 'fixedUpdate must drive a real DoT tick through init()-built state');
  combat.dispose();
});
