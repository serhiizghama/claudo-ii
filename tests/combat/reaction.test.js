// tests/combat/reaction.test.js
//
// CMBT-5 acceptance tests for src/combat/reaction.js (+ packet.js's wiring
// of it into CombatSystem#resolve()).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim):
//   1. Hitstun `0.4 / (1 + FHR/100)` — all five rows of E7, plus its
//      trigger-threshold note (both sides of the 5% boundary).
//   2. Hit-stop freezes only the struck actor.
//   3. E11 (knockback distance) reproduces exactly — all five rows, plus
//      the noKnockback override tested as its own branch.
//
// Not this ticket's (D-14, already applied): E8 (chill, CMBT-4), E9 (rage,
// CMBT-7), E10 (XP, CMBT-6).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HITSTUN_TRIGGER_PERCENT,
  HITSTUN_MIN_SECONDS,
  HITSTUN_MAX_SECONDS,
  HITSTUN_IMMUNITY_SECONDS,
  HITSTUN_IMMUNITY_SECONDS_BOSS_UNIQUE,
  computeHitRecoveryTime,
  hitstunTriggers,
  hitstunImmunityWindowSeconds,
  KNOCKBACK_BASE_DISTANCE,
  KNOCKBACK_MASS_FACTOR_MIN,
  KNOCKBACK_UNIQUE_MULTIPLIER,
  KNOCKBACK_IMPULSE_SECONDS,
  computeMassFactor,
  computeKnockbackDistance,
  computeKnockbackDirection,
  HITSTOP_DAMAGE_SECONDS,
  HITSTOP_CRIT_SECONDS,
  HITSTOP_KILL_SECONDS,
  computeHitStopSeconds,
  applyReaction,
} from '../../src/combat/reaction.js';
import { CombatSystem, PacketPool } from '../../src/combat/packet.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { setState, cancelAction } from '../../src/actors/action.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

const EPS = 1e-4;
const FIXED_HZ = 60;

function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// Fixtures — same shape tests/combat/status.test.js already established:
// a real Actor record via createActorRecord + composeStats (the NaN trap:
// composeStats yields NaN in eleven fields if any of strength/dexterity/
// vitality/energy is missing from actor.attributes).
// ---------------------------------------------------------------------------

let nextPoolIndex = 0;
function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex);
  actor.id = overrides.id ?? (nextPoolIndex + 1);
  actor.generation = 0;
  nextPoolIndex++;
  actor.kind = overrides.kind ?? 'monster';
  actor.rank = overrides.rank ?? 'normal';
  actor.classId = null;
  actor.level = overrides.level ?? 10;
  actor.state = overrides.state ?? 'idle';
  actor.mass = overrides.mass ?? 78;
  actor.flags = overrides.flags ?? 0;
  actor.x = overrides.x ?? 0;
  actor.z = overrides.z ?? 0;
  actor.dead = false;
  actor.attributes = { strength: 20, dexterity: 20, vitality: 20, energy: 20 };
  composeStats(actor);
  if (overrides.statOverrides) setSourceLayer(actor, 'equipment', overrides.statOverrides);
  return actor;
}

/** A stub `actorsSystem` wired to the REAL, accepted src/actors/action.js
 * functions (setState/cancelAction) — same "ActorsSystem doesn't forward
 * these yet" gap resolve.test.js/status.test.js already stub around — plus
 * plain recorder stand-ins for hitStop/applyImpulse (neither exists
 * anywhere in src/actors/ yet; see reaction.js's own header). `calls`
 * records every invocation so a test can assert exactly which actor was
 * touched. */
function makeActorsSystemStub() {
  const calls = { hitStop: [], applyImpulse: [], setState: [], cancelAction: [] };
  return {
    calls,
    setState(actor, state) {
      const r = setState(actor, state);
      calls.setState.push({ actor, state, result: r });
      return r;
    },
    cancelAction(actor, reason) {
      const r = cancelAction(actor, reason);
      calls.cancelAction.push({ actor, reason, result: r });
      return r;
    },
    hitStop(actor, seconds) {
      calls.hitStop.push({ actor, seconds });
    },
    applyImpulse(actor, dx, dz, seconds) {
      calls.applyImpulse.push({ actor, dx, dz, seconds });
    },
  };
}

function makeMockRng(nextValue = 0.01) {
  return { next() { return nextValue; }, range(min, max) { return (min + max) / 2; } };
}

let packetPool = new PacketPool(64);
function makePacket(overrides = {}) {
  const p = packetPool.acquire();
  Object.assign(p, {
    sourceId: 1, sourceGen: 0, sourceSkillId: 'test_skill', knockback: 0,
    originX: 0, originY: 0, originZ: 0,
    ...overrides,
  });
  return p;
}

function blankResult(overrides = {}) {
  return {
    targetId: 0, targetGen: 0, sourceId: 0, sourceGen: 0, sourceSkillId: null,
    outcome: 'hit', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 0,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false,
    pointX: 0, pointY: 0, pointZ: 0, poolIndex: -1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E7 — hit recovery, all five rows + the trigger threshold (both sides)
// ---------------------------------------------------------------------------

test('E7: computeHitRecoveryTime reproduces all five rows to 1e-4, printed', () => {
  const rows = [
    { fhr: 0, expected: 0.4000 },
    { fhr: 30, expected: 0.3077 },
    { fhr: 60, expected: 0.2500 },
    { fhr: 120, expected: 0.1818 },
    { fhr: 400, expected: 0.1200 },
  ];
  const printed = [];
  for (const row of rows) {
    const got = computeHitRecoveryTime(row.fhr);
    printed.push(`FHR ${row.fhr}: ${got.toFixed(4)} (expected ${row.expected.toFixed(4)})`);
    approx(got, row.expected, `FHR ${row.fhr}`);
  }
  // eslint-disable-next-line no-console
  console.log('E7 rows:\n' + printed.join('\n'));
});

test('E7.5: 400 FHR is genuinely CLAMPED at the floor, not coincidentally 0.12 — the raw value is 0.08', () => {
  const raw = 0.40 / (1 + 400 / 100);
  approx(raw, 0.08, 'raw (pre-clamp) value at FHR 400');
  assert.ok(raw < HITSTUN_MIN_SECONDS, 'the raw value must fall below the floor for the clamp to be doing real work');
  approx(computeHitRecoveryTime(400), HITSTUN_MIN_SECONDS, 'clamped result');
});

test('E7: the clamp bounds are exactly [0.12, 0.40] — extreme FHR values still land on the documented floor/ceiling', () => {
  approx(computeHitRecoveryTime(100000), HITSTUN_MIN_SECONDS, 'absurdly high FHR floors at 0.12');
  approx(computeHitRecoveryTime(-75), HITSTUN_MAX_SECONDS, 'the lowest legal FHR (-75 cap) still cannot exceed the 0.40 ceiling');
});

test('E7 trigger threshold: 8.0 dmg / 165 life does NOT trigger (4.85% < 5%), 8.5 DOES (5.15%) — both sides asserted', () => {
  const belowPercent = (8.0 / 165) * 100;
  const abovePercent = (8.5 / 165) * 100;
  approx(belowPercent, 4.8485, 'below-threshold percent, sanity');
  approx(abovePercent, 5.1515, 'above-threshold percent, sanity');
  assert.ok(belowPercent < HITSTUN_TRIGGER_PERCENT, 'the ticket\'s own 8.0 case must be below 5%');
  assert.ok(abovePercent > HITSTUN_TRIGGER_PERCENT, 'the ticket\'s own 8.5 case must be above 5%');

  assert.equal(hitstunTriggers(8.0, 165), false, '8.0 damage on 165 life must NOT trigger');
  assert.equal(hitstunTriggers(8.5, 165), true, '8.5 damage on 165 life MUST trigger');

  // The threshold itself, both sides, at the exact boundary value too.
  assert.equal(hitstunTriggers(8.25, 165), false, 'exactly 5% is NOT > 5% (strict inequality)');
  assert.equal(hitstunTriggers(8.26, 165), true, 'just past exactly 5% must trigger');
});

test('hitstunImmunityWindowSeconds: normal/champion/minion get 0.50s, boss/unique get 1.20s', () => {
  approx(hitstunImmunityWindowSeconds('normal'), HITSTUN_IMMUNITY_SECONDS, 'normal');
  approx(hitstunImmunityWindowSeconds('champion'), HITSTUN_IMMUNITY_SECONDS, 'champion');
  approx(hitstunImmunityWindowSeconds('minion'), HITSTUN_IMMUNITY_SECONDS, 'minion');
  approx(hitstunImmunityWindowSeconds(null), HITSTUN_IMMUNITY_SECONDS, 'no rank (defensive default)');
  approx(hitstunImmunityWindowSeconds('boss'), HITSTUN_IMMUNITY_SECONDS_BOSS_UNIQUE, 'boss');
  approx(hitstunImmunityWindowSeconds('unique'), HITSTUN_IMMUNITY_SECONDS_BOSS_UNIQUE, 'unique');
});

// ---------------------------------------------------------------------------
// E11 — knockback distance, all five rows + the noKnockback override
// ---------------------------------------------------------------------------

test('E11: computeKnockbackDistance reproduces all five rows to 1e-4, printed', () => {
  const rows = [
    { knockback: 0, mass: 78, expected: 0.5280 },
    { knockback: 0, mass: 22, expected: 0.6820 },
    { knockback: 100, mass: 78, expected: 1.0560 },
    { knockback: 0, mass: 140, expected: 0.3575 },
    { knockback: 0, mass: 400, expected: 0.1375 },
  ];
  const printed = [];
  for (const row of rows) {
    const got = computeKnockbackDistance(row.knockback, row.mass);
    printed.push(`knockback ${row.knockback}, mass ${row.mass}: ${got.toFixed(4)} (expected ${row.expected.toFixed(4)})`);
    approx(got, row.expected, `knockback=${row.knockback} mass=${row.mass}`);
  }
  // eslint-disable-next-line no-console
  console.log('E11 rows:\n' + printed.join('\n'));
});

test('E11.5: the mass-70 term alone goes NEGATIVE at mass 400 — the 0.25 floor is doing real work, not coincidence', () => {
  const rawMassTerm = 1 - (400 - 70) / 200;
  approx(rawMassTerm, -0.65, 'raw (pre-clamp) mass term at mass 400');
  assert.ok(rawMassTerm < KNOCKBACK_MASS_FACTOR_MIN, 'raw term must fall below the floor for the clamp to matter');
  approx(computeMassFactor(400), KNOCKBACK_MASS_FACTOR_MIN, 'clamped mass factor');
  approx(KNOCKBACK_BASE_DISTANCE * (1 + 0 / 100) * KNOCKBACK_MASS_FACTOR_MIN, 0.1375, 'E11.5 formula value, spelled out');
});

test('E11.5: two assertions in one row — the formula yields 0.1375, AND a noKnockback actor is pushed 0 regardless', () => {
  const formulaValue = computeKnockbackDistance(0, 400, false);
  approx(formulaValue, 0.1375, 'E11.5 formula half');

  const noKnockbackValue = computeKnockbackDistance(0, 400, true);
  assert.equal(noKnockbackValue, 0, 'E11.5 noKnockback half — Molgrim is pushed 0 regardless of the formula value above');

  // A naive "always return the formula" implementation would pass the first
  // assertion above but fail this one — proving the branch is real, not
  // coincidentally near-zero.
  assert.notEqual(formulaValue, noKnockbackValue);
});

test('computeKnockbackDistance: unique rank scales by 0.25x, boss rank is immune — both real branches', () => {
  const normal = computeKnockbackDistance(0, 78, false, 'normal');
  const unique = computeKnockbackDistance(0, 78, false, 'unique');
  const boss = computeKnockbackDistance(0, 78, false, 'boss');
  approx(normal, 0.5280, 'normal rank, sanity (same as E11.1)');
  approx(unique, normal * KNOCKBACK_UNIQUE_MULTIPLIER, 'unique rank scales the SAME formula value by 0.25x');
  assert.equal(boss, 0, 'boss rank is immune outright');
});

test('computeMassFactor: mass 70 is neutral (factor 1.0), matching the table header "at mass 70 kg"', () => {
  approx(computeMassFactor(70), 1.0, 'mass 70 is the reference point');
});

test('computeKnockbackDirection: points away from the source, normalised, no allocation per call (same object returned)', () => {
  const packet = makePacket({ originX: 0, originZ: 0 });
  const source = { x: -5, z: 0 };
  const target = { x: 0, z: 0 };
  const a = computeKnockbackDirection(packet, source, target);
  approx(a.x, 1, 'pushed away from source along +X');
  approx(a.z, 0, 'no Z component here');
  approx(Math.sqrt(a.x * a.x + a.z * a.z), 1, 'direction is a unit vector');

  const b = computeKnockbackDirection(packet, source, target);
  assert.equal(a, b, 'the SAME scratch object is returned every call — zero allocation');
});

// ---------------------------------------------------------------------------
// Hit-stop — the decision function, plus the wiring proof (criterion #2)
// ---------------------------------------------------------------------------

test('computeHitStopSeconds: 0 unless the attacker is the player, regardless of how big the hit is', () => {
  assert.equal(computeHitStopSeconds(10000, 100, true, true, false), 0, 'a monster-on-monster kill-crit still freezes nothing');
  assert.equal(computeHitStopSeconds(0, 100, false, false, true), 0, 'a 0-damage player hit freezes nothing');
});

test('computeHitStopSeconds: the three thresholds, and "take the max, never the sum"', () => {
  approx(computeHitStopSeconds(12, 100, false, false, true), HITSTOP_DAMAGE_SECONDS, '12% damage alone');
  approx(computeHitStopSeconds(11.999, 100, false, false, true), 0, 'just under 12% triggers nothing');
  approx(computeHitStopSeconds(0, 100, true, false, true), HITSTOP_CRIT_SECONDS, 'crit alone');
  approx(computeHitStopSeconds(0, 100, false, true, true), HITSTOP_KILL_SECONDS, 'killing blow alone');
  // All three at once: MAX (0.12), never the sum (0.06+0.09+0.12=0.27).
  approx(computeHitStopSeconds(50, 100, true, true, true), HITSTOP_KILL_SECONDS, 'all three overlapping take the max, not the sum');
});

test('applyReaction: hit-stop touches ONLY the struck actor — a second, unstruck actor is left completely untouched', () => {
  const attacker = makeActor({ kind: 'player', id: 10 });
  const struck = makeActor({ id: 11 });
  const bystander = makeActor({ id: 12 }); // never passed to applyReaction at all

  const bystanderSnapshot = {
    state: bystander.state, life: bystander.life, hitstunUntil: bystander.hitstunUntil,
    hitstunImmuneUntil: bystander.hitstunImmuneUntil, x: bystander.x, z: bystander.z,
  };

  const actorsSystem = makeActorsSystemStub();
  const rng = makeMockRng(99); // 99*100=9900 >> any packet.knockback percent — no knockback roll succeeds
  const packet = makePacket({ knockback: 0 });
  const result = blankResult({ total: 40, crit: false, killed: false }); // 40/100 = 40% >> 12% threshold
  struck.stats.maxLife = 100;
  const env = { source: attacker, rng, step: 0, actorsSystem };

  applyReaction(packet, struck, result, env);

  assert.equal(actorsSystem.calls.hitStop.length, 1, 'exactly one hitStop call must fire');
  assert.equal(actorsSystem.calls.hitStop[0].actor, struck, 'hitStop must target the struck actor');
  approx(actorsSystem.calls.hitStop[0].seconds, HITSTOP_DAMAGE_SECONDS, 'hit-stop duration for a 40%-of-maxLife hit');

  // The bystander was never even passed in — but assert its recorded state
  // is bit-for-bit identical, proving nothing global (no ctx.time.scale
  // equivalent, no engine-wide freeze) touched it as a side effect.
  assert.deepEqual(
    { state: bystander.state, life: bystander.life, hitstunUntil: bystander.hitstunUntil, hitstunImmuneUntil: bystander.hitstunImmuneUntil, x: bystander.x, z: bystander.z },
    bystanderSnapshot,
    'a second, unstruck actor must be completely untouched by applyReaction',
  );
  assert.equal(actorsSystem.calls.hitStop.some((c) => c.actor === bystander), false);
  assert.equal(actorsSystem.calls.hitStop.some((c) => c.actor === attacker), false, 'the ATTACKER never freezes either — only the struck actor');
});

test('applyReaction: no hit-stop when the attacker is a monster, even on a big hit', () => {
  const attacker = makeActor({ kind: 'monster', id: 20 });
  const struck = makeActor({ id: 21 });
  struck.stats.maxLife = 100;
  const actorsSystem = makeActorsSystemStub();
  const env = { source: attacker, rng: makeMockRng(99), step: 0, actorsSystem };
  const packet = makePacket({ knockback: 0 });
  const result = blankResult({ total: 90 });

  applyReaction(packet, struck, result, env);

  assert.equal(actorsSystem.calls.hitStop.length, 0, 'a monster attacker must never trigger hit-stop');
});

// ---------------------------------------------------------------------------
// applyReaction — hit recovery end-to-end (real action.js state machine)
// ---------------------------------------------------------------------------

test('applyReaction: a triggering hit puts the target into hitstun via the REAL action.js state machine, schedules hitstunUntil/hitstunImmuneUntil in STEPS', () => {
  const attacker = makeActor({ kind: 'player', id: 30 });
  const target = makeActor({ id: 31, state: 'idle' });
  target.stats.maxLife = 165;
  target.stats.fasterHitRecovery = 0;
  const actorsSystem = makeActorsSystemStub();
  const step = 1000;
  const env = { source: attacker, rng: makeMockRng(99), step, actorsSystem };
  const packet = makePacket({ knockback: 0 });
  const result = blankResult({ total: 8.5 }); // 5.15% of 165 — triggers, per the ticket's own threshold note

  applyReaction(packet, target, result, env);

  assert.equal(target.state, 'hitstun', 'target must actually enter the hitstun STATE via the real state machine');
  assert.equal(result.hitRecovery, true);
  assert.equal(target.hitstunUntil, step + Math.round(0.40 * FIXED_HZ), 'hitstunUntil scheduled in STEPS, against ctx.time.step — FHR=0 gives the 0.40s base duration');
  assert.equal(target.hitstunImmuneUntil, target.hitstunUntil + Math.round(HITSTUN_IMMUNITY_SECONDS * FIXED_HZ), 'hitstunImmuneUntil = hitstunUntil + the 0.50s immunity window, in steps');
});

test('applyReaction: a sub-threshold hit does NOT enter hitstun (8.0/165, below the 5% line)', () => {
  const attacker = makeActor({ kind: 'player', id: 32 });
  const target = makeActor({ id: 33, state: 'idle' });
  target.stats.maxLife = 165;
  const actorsSystem = makeActorsSystemStub();
  const env = { source: attacker, rng: makeMockRng(99), step: 0, actorsSystem };
  const packet = makePacket({ knockback: 0 });
  const result = blankResult({ total: 8.0 });

  applyReaction(packet, target, result, env);

  assert.equal(target.state, 'idle', 'must remain idle — no trigger');
  assert.equal(result.hitRecovery, false);
  assert.equal(actorsSystem.calls.cancelAction.length, 0, 'cancelAction must not even be attempted below threshold');
});

test('applyReaction: respects hitstunImmuneUntil — a second triggering hit inside the immunity window is refused', () => {
  const attacker = makeActor({ kind: 'player', id: 34 });
  const target = makeActor({ id: 35, state: 'idle' });
  target.stats.maxLife = 165;
  target.stats.fasterHitRecovery = 0;
  const actorsSystem = makeActorsSystemStub();
  const packet = makePacket({ knockback: 0 });

  const env1 = { source: attacker, rng: makeMockRng(99), step: 0, actorsSystem };
  applyReaction(packet, target, blankResult({ total: 8.5 }), env1);
  assert.equal(target.state, 'hitstun');
  const immuneUntil = target.hitstunImmuneUntil;

  // A second big hit, one step later — still inside the immunity window.
  target.state = 'idle'; // pretend the FSM already released it, isolating the immunity check
  const env2 = { source: attacker, rng: makeMockRng(99), step: 1, actorsSystem };
  const result2 = blankResult({ total: 8.5 });
  applyReaction(packet, target, result2, env2);
  assert.equal(result2.hitRecovery, false, 'refused — still inside hitstunImmuneUntil');
  assert.ok(1 < immuneUntil, 'sanity: step 1 really is inside the immunity window');

  // Once past the window, the same hit triggers again.
  const env3 = { source: attacker, rng: makeMockRng(99), step: immuneUntil, actorsSystem };
  const result3 = blankResult({ total: 8.5 });
  applyReaction(packet, target, result3, env3);
  assert.equal(result3.hitRecovery, true, 'allowed again once step >= hitstunImmuneUntil');
});

test('applyReaction: a killing blow gets its hit-stop but does NOT enter hitstun/knockback', () => {
  const attacker = makeActor({ kind: 'player', id: 36 });
  const target = makeActor({ id: 37, state: 'idle' });
  target.stats.maxLife = 165;
  const actorsSystem = makeActorsSystemStub();
  const env = { source: attacker, rng: makeMockRng(0.01), step: 0, actorsSystem };
  const packet = makePacket({ knockback: 100 });
  const result = blankResult({ total: 165, killed: true });

  applyReaction(packet, target, result, env);

  approx(actorsSystem.calls.hitStop[0].seconds, HITSTOP_KILL_SECONDS, 'killing blow still gets its freeze');
  assert.equal(target.state, 'idle', 'a dying actor does not also transition into hitstun/knockback');
  assert.equal(result.hitRecovery, false);
  assert.equal(result.knockedBack, false);
});

test('applyReaction: a non-hit outcome (miss/dodge/block/immune) is a total no-op', () => {
  for (const outcome of ['miss', 'dodge', 'block', 'immune', 'invalid']) {
    const attacker = makeActor({ kind: 'player', id: 38 });
    const target = makeActor({ id: 39, state: 'idle' });
    target.stats.maxLife = 165;
    const actorsSystem = makeActorsSystemStub();
    const env = { source: attacker, rng: makeMockRng(0.01), step: 0, actorsSystem };
    const packet = makePacket({ knockback: 100 });
    const result = blankResult({ outcome, total: 0 });

    applyReaction(packet, target, result, env);

    assert.equal(target.state, 'idle', `outcome=${outcome}: no state change`);
    assert.equal(actorsSystem.calls.hitStop.length, 0, `outcome=${outcome}: no hit-stop`);
  }
});

// ---------------------------------------------------------------------------
// applyReaction — knockback end-to-end (real action.js state machine)
// ---------------------------------------------------------------------------

test('applyReaction: a successful knockback roll transitions to the REAL "knockback" state and calls applyImpulse with the E11 distance', () => {
  const attacker = makeActor({ kind: 'player', id: 40, x: -5, z: 0 });
  const target = makeActor({ id: 41, state: 'idle', mass: 78, x: 0, z: 0 });
  target.stats.maxLife = 100000; // large — isolates knockback from the (unrelated) hitstun check
  const actorsSystem = makeActorsSystemStub();
  const rng = makeMockRng(0.01); // 0.01*100=1 < any positive knockback%
  const env = { source: attacker, rng, step: 0, actorsSystem };
  const packet = makePacket({ knockback: 100 }); // E11.3's own knockback value
  const result = blankResult({ total: 1 }); // below hitstun threshold on purpose, isolating knockback

  applyReaction(packet, target, result, env);

  assert.equal(target.state, 'knockback');
  assert.equal(result.knockedBack, true);
  assert.equal(actorsSystem.calls.applyImpulse.length, 1);
  const impulse = actorsSystem.calls.applyImpulse[0];
  assert.equal(impulse.actor, target);
  approx(impulse.seconds, KNOCKBACK_IMPULSE_SECONDS, 'impulse duration is the documented 0.18s window');
  const speed = Math.sqrt(impulse.dx * impulse.dx + impulse.dz * impulse.dz);
  approx(speed * KNOCKBACK_IMPULSE_SECONDS, 1.0560, 'speed * duration reproduces E11.3\'s 1.0560m distance');
  assert.ok(impulse.dx > 0, 'pushed AWAY from the attacker (attacker is at -X, target at origin)');
});

test('applyReaction: a failed knockback roll (rng above the % chance) never calls setState/applyImpulse', () => {
  const attacker = makeActor({ kind: 'player', id: 42 });
  const target = makeActor({ id: 43, state: 'idle' });
  target.stats.maxLife = 100000;
  const actorsSystem = makeActorsSystemStub();
  const rng = makeMockRng(0.99); // 99% >> a 10% knockback chance
  const env = { source: attacker, rng, step: 0, actorsSystem };
  const packet = makePacket({ knockback: 10 });
  const result = blankResult({ total: 1 });

  applyReaction(packet, target, result, env);

  assert.equal(target.state, 'idle');
  assert.equal(result.knockedBack, false);
  assert.equal(actorsSystem.calls.applyImpulse.length, 0);
});

test('applyReaction: ACTOR_FLAG.noKnockback (bit 2) refuses the state change even on a successful roll', () => {
  const attacker = makeActor({ kind: 'player', id: 44 });
  const target = makeActor({ id: 45, state: 'idle', flags: 1 << 2 }); // 01-data-model.md §2.1 ACTOR_FLAG.noKnockback
  target.stats.maxLife = 100000;
  const actorsSystem = makeActorsSystemStub();
  const rng = makeMockRng(0.01);
  const env = { source: attacker, rng, step: 0, actorsSystem };
  const packet = makePacket({ knockback: 100 });
  const result = blankResult({ total: 1 });

  applyReaction(packet, target, result, env);

  assert.equal(target.state, 'idle', 'flag refuses the knockback outright');
  assert.equal(result.knockedBack, false);
  assert.equal(actorsSystem.calls.setState.length, 0, 'setState is never even attempted once distance resolves to 0');
});

test('applyReaction: windup -> knockback is an illegal transition (states.js\'s own adjacency table) — setState fails, knockedBack stays false', () => {
  const attacker = makeActor({ kind: 'player', id: 46 });
  const target = makeActor({ id: 47, state: 'windup' });
  target.stats.maxLife = 100000;
  const actorsSystem = makeActorsSystemStub();
  const rng = makeMockRng(0.01);
  const env = { source: attacker, rng, step: 0, actorsSystem };
  const packet = makePacket({ knockback: 100 });
  const result = blankResult({ total: 1 });

  applyReaction(packet, target, result, env);

  assert.equal(target.state, 'windup', 'illegal transition must leave state untouched');
  assert.equal(result.knockedBack, false, 'an illegal setState() must not be reported as success');
});

// ---------------------------------------------------------------------------
// O-51 — the module-graph regression test: import ONLY packet.js
// ---------------------------------------------------------------------------

test('packet.js alone (no reaction.js import) wires hitRecoveryTime onto CombatSystem, and resolve() calls through to it', async () => {
  const { CombatSystem: FreshCombatSystem } = await import('../../src/combat/packet.js');
  const combat = new FreshCombatSystem();
  assert.equal(typeof combat.hitRecoveryTime, 'function', 'CombatSystem#hitRecoveryTime must exist once packet.js alone is loaded');
  assert.equal(typeof combat.resolve, 'function');
});

test('CombatSystem#hitRecoveryTime, driven through a real init(), reproduces E7.1 (FHR 0 -> 0.40s)', async () => {
  const combat = new CombatSystem();
  const events = new EventBus();
  const ctx = {
    rng: new Rng(12345),
    events,
    time: { step: 0 },
    get(id) { if (id === 'actors') return makeActorsSystemStub(); throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };
  await combat.init(ctx);

  const actor = makeActor({ id: 50 });
  actor.stats.fasterHitRecovery = 0;
  approx(combat.hitRecoveryTime(actor), 0.4000, 'E7.1 through the real, boot-wired CombatSystem');
  combat.dispose();
});

test('CombatSystem#resolve, driven through a real init(), calls applyReaction end-to-end (hit-stop + hitstun observed on the live pipeline)', async () => {
  const events = new EventBus();
  const actorsSystem = makeActorsSystemStub();
  const combat = new CombatSystem();
  const ctx = {
    rng: new Rng(12345),
    events,
    time: { step: 500 },
    get(id) { if (id === 'actors') return actorsSystem; throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };
  await combat.init(ctx);

  const attacker = makeActor({ kind: 'player', id: 60 });
  attacker.team = 0; // TEAM.player
  const target = makeActor({ id: 61, state: 'idle' });
  target.team = 1; // TEAM.monster — must be hostile to the attacker for isValidTarget/isHostile to pass
  target.stats.maxLife = 100;
  target.life = 100;

  const packet = makePacket({
    sourceId: attacker.id, sourceGen: attacker.generation, knockback: 0,
    team: attacker.team,
    attackRating: 0, blockable: false, dodgeable: false, critChance: 0, critMult: 100,
    physMin: 40, physMax: 40,
  });

  // resolve() needs actorsSystem.resolve(ref) to find the attacker.
  actorsSystem.resolve = (ref) => (ref.id === attacker.id ? attacker : ref.id === target.id ? target : null);

  const result = combat.resolve(packet, target);

  assert.equal(result.outcome, 'hit');
  approx(result.total, 40, 'physical roll, no crit/mitigation in this fixture');
  assert.equal(target.state, 'hitstun', 'the full CombatSystem#resolve() pipeline actually drives reaction.js\'s applyReaction');
  assert.equal(result.hitRecovery, true);
  assert.equal(actorsSystem.calls.hitStop.length, 1);
  assert.equal(actorsSystem.calls.hitStop[0].actor, target);

  combat.releasePacket(packet);
  combat.dispose();
});
