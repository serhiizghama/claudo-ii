// tests/combat/onhit.test.js
//
// CMBT-7 acceptance tests for src/combat/onhit.js (+ packet.js's wiring of
// it into CombatSystem#resolve()).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim):
//   1. R14(d) and R14(f) credit in the documented order.
//   2. A landed hit grants exactly 1 Resonance.
//   3. E9 (rage economy) reproduces — WITH the D-9 correction (6.9169, not
//      the printed 6.9161 — see the D-9 test below for the full chain).
//
// Not this ticket's: R14(i)/(j) (death/actor:death, XP — CMBT-6), the "+8
// on a credited kill" rage row and `last_stand`'s +40 (both wait on CMBT-6/
// 05-skills.md — see onhit.js's own header), R14(g)/(h) (hit recovery/
// knockback — CMBT-5, already accepted).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_RAGE_ON_HIT,
  BASE_RAGE_ON_TAKE_HIT,
  BASE_RAGE_ON_KILL,
  RAGE_ON_LAST_STAND,
  BASE_RESONANCE_ON_HIT,
  rageGainOnHit,
  rageGainOnTakeHit,
  resonanceGainOnHit,
  computeManaReturned,
  isLikelyMeleeAttack,
  addResourceClamped,
  applyOnHitEconomy,
  shouldAwardActionRage,
  encodeActionRageStamp,
} from '../../src/combat/onhit.js';
import { CombatSystem, PacketPool, computeAttackInterval } from '../../src/combat/packet.js';
import { chanceToHit } from '../../src/combat/tohit.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

const EPS = 1e-4;

function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// Fixtures — same shape tests/combat/reaction.test.js already established:
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
  actor.kind = overrides.kind ?? 'player';
  actor.rank = overrides.rank ?? 'normal';
  actor.classId = overrides.classId ?? null;
  actor.level = overrides.level ?? 10;
  actor.team = overrides.team ?? 0;
  actor.dead = false;
  actor.attributes = overrides.attributes ?? { strength: 20, dexterity: 20, vitality: 20, energy: 20 };
  composeStats(actor);
  if (overrides.statOverrides) {
    setSourceLayer(actor, 'equipment', overrides.statOverrides);
    composeStats(actor); // re-run — setSourceLayer only marks statsDirty, does not itself recompose
  }
  if (overrides.life != null) actor.life = overrides.life;
  if (overrides.mana != null) actor.mana = overrides.mana;
  if (overrides.rage != null) actor.rage = overrides.rage;
  if (overrides.resonance != null) actor.resonance = overrides.resonance;
  return actor;
}

let packetPool = new PacketPool(64);
function makePacket(overrides = {}) {
  const p = packetPool.acquire();
  Object.assign(p, {
    sourceId: 1, sourceGen: 0, sourceSkillId: 'attack',
    attackRating: 100, physMin: 10, physMax: 10, // melee by default (isLikelyMeleeAttack)
    manaReturnPercent: 0,
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
// Pure formulas
// ---------------------------------------------------------------------------

test('rageGainOnHit/rageGainOnTakeHit/resonanceGainOnHit: base + bonus stat, base alone with no bonus', () => {
  assert.equal(BASE_RAGE_ON_HIT, 6);
  assert.equal(BASE_RAGE_ON_TAKE_HIT, 4);
  assert.equal(BASE_RESONANCE_ON_HIT, 1);
  assert.equal(BASE_RAGE_ON_KILL, 8, 'documented, NOT applied here (CMBT-6) — see the header');
  assert.equal(RAGE_ON_LAST_STAND, 40, 'documented, NOT applied here (05-skills.md) — see the header');

  assert.equal(rageGainOnHit(0), 6);
  assert.equal(rageGainOnHit(10), 16, '+6 base plus a +10 rageOnHit gear bonus');
  assert.equal(rageGainOnTakeHit(0), 4);
  assert.equal(rageGainOnTakeHit(5), 9);
  assert.equal(resonanceGainOnHit(0), 1);
  assert.equal(resonanceGainOnHit(0.5), 1.5, 'never floored on the credit side — only spend(\'all\') floors, per vessels.js');
});

test('computeManaReturned: E13\'s own figure, 21.4438 x 0.08 = 1.7155 — NOT floored', () => {
  const got = computeManaReturned(21.4438, 8);
  approx(got, 1.7155, 'E13 manaReturned');
  assert.notEqual(got, Math.floor(got), 'sanity: the correct value is genuinely fractional, proving no floor is applied');
});

test('computeManaReturned: zero physical or zero percent both yield exactly 0', () => {
  assert.equal(computeManaReturned(0, 8), 0);
  assert.equal(computeManaReturned(50, 0), 0);
});

test('isLikelyMeleeAttack: attackRating>0 with a nonzero phys range is melee; a spell (attackRating=0 or all-zero phys) is not', () => {
  assert.equal(isLikelyMeleeAttack({ attackRating: 100, physMin: 10, physMax: 20 }), true);
  assert.equal(isLikelyMeleeAttack({ attackRating: 100, physMin: 0, physMax: 0 }), false, 'AR>0 but no physical range — e.g. a targeted spell using to-hit');
  assert.equal(isLikelyMeleeAttack({ attackRating: 0, physMin: 10, physMax: 20 }), false, 'attackRating=0 always hits (spell), never counted as melee');
});

test('addResourceClamped: adds and clamps to [0, max]; a dead actor is untouched', () => {
  const actor = { rage: 95, dead: false };
  const delta = addResourceClamped(actor, 'rage', 10, 100);
  assert.equal(actor.rage, 100, 'clamped at max');
  assert.equal(delta, 5, 'returns the ACTUAL delta applied, not the requested amount');

  const dead = { rage: 50, dead: true };
  addResourceClamped(dead, 'rage', 10, 100);
  assert.equal(dead.rage, 50, 'a dead actor never gains anything');

  const zeroMax = { rage: 0, dead: false };
  addResourceClamped(zeroMax, 'rage', 6, 0);
  assert.equal(zeroMax.rage, 0, 'a class with maxRage=0 (e.g. non-Ravager) is a harmless no-op — the vessels.js precedent this file relies on');
});

// ---------------------------------------------------------------------------
// Criterion #1 — R14(d) and R14(f) credit in the documented order
// ---------------------------------------------------------------------------

test('applyOnHitEconomy: R14(d) (manaReturned) fires strictly before R14(f) (rage/resonance), printed', () => {
  const source = makeActor({ classId: 'runeblade', id: 100, mana: 20 });
  const target = makeActor({ classId: 'ravager', id: 101, team: 1 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation, manaReturnPercent: 8 });
  const result = blankResult({ outcome: 'hit', physical: 21.4438, total: 39 });
  const creditLog = [];
  const env = { source, step: 10, creditLog };

  applyOnHitEconomy(packet, target, result, env);

  // eslint-disable-next-line no-console
  console.log('R14 credit order:', creditLog.join(' -> '));

  const dIndex = creditLog.indexOf('R14(d):manaReturned');
  const fAttackerIndex = creditLog.indexOf('R14(f):rage-attacker');
  const fResonanceIndex = creditLog.indexOf('R14(f):resonance-attacker');
  const fTargetIndex = creditLog.indexOf('R14(f):rage-target');

  assert.ok(dIndex >= 0, 'R14(d) must have fired');
  assert.ok(fAttackerIndex >= 0 && fResonanceIndex >= 0 && fTargetIndex >= 0, 'every R14(f) credit must have fired');
  assert.ok(dIndex < fAttackerIndex, 'R14(d) must precede R14(f) attacker rage');
  assert.ok(dIndex < fResonanceIndex, 'R14(d) must precede R14(f) resonance');
  assert.ok(dIndex < fTargetIndex, 'R14(d) must precede R14(f) target rage');
});

test('applyOnHitEconomy: no credits at all for miss/dodge/invalid outcomes — R14 never ran for those', () => {
  for (const outcome of ['miss', 'dodge', 'invalid']) {
    const source = makeActor({ classId: 'ravager', id: 200 + (outcome.length) });
    const target = makeActor({ classId: 'ravager', id: 300 + (outcome.length) });
    const packet = makePacket({ sourceId: source.id, sourceGen: source.generation });
    const result = blankResult({ outcome, physical: 0, total: 0 });
    const creditLog = [];
    const env = { source, step: 0, creditLog };

    applyOnHitEconomy(packet, target, result, env);

    assert.deepEqual(creditLog, [], `outcome=${outcome}: no credit of any kind`);
  }
});

// ---------------------------------------------------------------------------
// Criterion #2 — a landed hit grants exactly 1 Resonance
// ---------------------------------------------------------------------------

test('applyOnHitEconomy: a landed melee hit grants the attacker EXACTLY +1 Resonance (no gear bonus)', () => {
  const source = makeActor({ classId: 'runeblade', id: 400 });
  assert.equal(source.stats.maxResonance, 3, 'sanity: a real composed Runeblade has maxResonance=3');
  assert.equal(source.resonance, 0, 'starts at 0');

  const target = makeActor({ classId: null, id: 401 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
  const env = { source, step: 0 };

  applyOnHitEconomy(packet, target, result, env);

  assert.equal(source.resonance, 1, 'exactly +1 Resonance credited on the landed hit — printed below');
  // eslint-disable-next-line no-console
  console.log(`Resonance after one landed melee hit: ${source.resonance} (expected 1)`);
});

test('applyOnHitEconomy: a NON-melee landed hit (attackRating=0, a spell) grants NO Resonance and NO attacker rage', () => {
  const source = makeActor({ classId: 'runeblade', id: 402 });
  const target = makeActor({ classId: null, id: 403 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation, attackRating: 0, physMin: 0, physMax: 0 });
  const result = blankResult({ outcome: 'hit', physical: 0, total: 20 }); // e.g. a pure elemental spell hit
  const env = { source, step: 0 };

  applyOnHitEconomy(packet, target, result, env);

  assert.equal(source.resonance, 0, 'Resonance is a MELEE-only credit — a spell hit grants none');
  assert.equal(source.rage, 0, 'rageOnHit is melee-only too (source has no rage resource anyway, but this proves the melee gate, not just the class clamp)');
});

test('applyOnHitEconomy: Resonance folds in a resonanceOnHit gear bonus, still uncapped by the credit function itself (capped by maxResonance)', () => {
  const source = makeActor({ classId: 'runeblade', id: 404, statOverrides: { resonanceOnHit: 2 } });
  const target = makeActor({ classId: null, id: 405 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
  const env = { source, step: 0 };

  applyOnHitEconomy(packet, target, result, env);

  assert.equal(source.resonance, 3, '+1 base + 2 gear = 3, clamped at maxResonance=3');
});

// ---------------------------------------------------------------------------
// R14(d) — manaReturned end to end, plus the "no class special-case" gap
// ---------------------------------------------------------------------------

test('applyOnHitEconomy: manaReturned = E13\'s 1.7155, applied to source.mana, clamped at maxMana', () => {
  const source = makeActor({ classId: 'runeblade', id: 500, mana: 20 });
  const target = makeActor({ classId: null, id: 501 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation, manaReturnPercent: 8 });
  const result = blankResult({ outcome: 'hit', physical: 21.4438, total: 39 });
  const env = { source, step: 0 };

  applyOnHitEconomy(packet, target, result, env);

  approx(result.manaReturned, 1.7155, 'result.manaReturned pinned to E13');
  approx(source.mana, 21.7155, 'source.mana += manaReturned (20 + 1.7155)');
});

test('applyOnHitEconomy: a fresh Runeblade with NO gear reads manaReturnPercent=8 from the class base (O-84/D-53, closed by SKIL-5)', () => {
  // Formerly "...reads manaReturnPercent=0 today — a documented gap, not
  // this ticket's to fix": O-84 was the finding that CLASS_TABLE
  // (src/actors/stats.js) had no manaReturnPercent row for any class, so a
  // really-composed Runeblade read 0 no matter what. SKIL-5 closed it as a
  // named micro-scope (ruling D-53): CLASS_TABLE now carries the Runeblade
  // class-base 8 `03-combat-math.md:223` states ("Base manaReturnPercent
  // for the Runeblade class is 8"), composed into StatBlock.manaReturnPercent
  // by composeStats()'s own `base` layer — no gear, no hand-set stat, no
  // skill point spent. This test is now a regression guard: if O-84 ever
  // regresses (the CLASS_TABLE row removed, or the base layer stops
  // reading it), this is the test that catches it.
  const source = makeActor({ classId: 'runeblade', id: 502 });
  assert.equal(source.stats.manaReturnPercent, 8, '03:223 / D-53: CLASS_TABLE now seeds the Runeblade base of 8, with no gear at all');
  const target = makeActor({ classId: null, id: 503 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation, manaReturnPercent: source.stats.manaReturnPercent });
  const result = blankResult({ outcome: 'hit', physical: 21.4438, total: 39 });
  applyOnHitEconomy(packet, target, result, { source, step: 0 });
  approx(result.manaReturned, 1.7155, 'the class-base 8% now actually returns mana on a landed hit: 21.4438 x 0.08 = 1.7155, same figure as E13');
});

test('applyOnHitEconomy: manaReturned clamps at maxMana, never overflowing', () => {
  const source = makeActor({ classId: 'runeblade', id: 504, mana: 0 });
  source.stats.maxMana = 1; // tiny cap
  const target = makeActor({ classId: null, id: 505 });
  const packet = makePacket({ sourceId: source.id, sourceGen: source.generation, manaReturnPercent: 100 });
  const result = blankResult({ outcome: 'hit', physical: 21.4438, total: 39 });
  applyOnHitEconomy(packet, target, result, { source, step: 0 });
  assert.equal(source.mana, 1, 'clamped at maxMana=1 even though the raw manaReturned figure is far larger');
  approx(result.manaReturned, 21.4438, 'result.manaReturned itself still reports the RAW (unclamped) figure — same precedent resolve.js already sets for lifeStolen/manaStolen');
});

// ---------------------------------------------------------------------------
// R14(f) — rage on both sides
// ---------------------------------------------------------------------------

test('applyOnHitEconomy: rage — Ravager attacker +6, Ravager defender +4, on a landed melee hit', () => {
  const attacker = makeActor({ classId: 'ravager', id: 600 });
  const defender = makeActor({ classId: 'ravager', id: 601, team: 1 });
  assert.equal(attacker.stats.maxRage, 100);
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(attacker.rage, 6, 'attacker +6 rageOnHit base');
  assert.equal(defender.rage, 4, 'defender +4 rageOnTakeHit base, on the SAME hit');
});

test('applyOnHitEconomy: rage gain folds in rageOnHit/rageOnTakeHit gear bonuses', () => {
  const attacker = makeActor({ classId: 'ravager', id: 602, statOverrides: { rageOnHit: 4 } });
  const defender = makeActor({ classId: 'ravager', id: 603, team: 1, statOverrides: { rageOnTakeHit: 6 } });
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(attacker.rage, 10, '6 base + 4 gear');
  assert.equal(defender.rage, 10, '4 base + 6 gear');
});

test('applyOnHitEconomy: defender rage taken applies regardless of attack type (a spell hit still grants rageOnTakeHit)', () => {
  const attacker = makeActor({ classId: null, id: 604 });
  const defender = makeActor({ classId: 'ravager', id: 605, team: 1 });
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation, attackRating: 0, physMin: 0, physMax: 0 });
  const result = blankResult({ outcome: 'hit', physical: 0, total: 15 });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(defender.rage, 4, '"any damage > 0" is not restricted to melee — unlike the attacker\'s own melee-gated credit');
});

test('applyOnHitEconomy: a non-Ravager attacker/defender gains no rage at all (maxRage=0 clamps it back to 0, per vessels.js\'s own precedent)', () => {
  const attacker = makeActor({ classId: 'emberwright', id: 606 });
  const defender = makeActor({ classId: 'emberwright', id: 607, team: 1 });
  assert.equal(attacker.stats.maxRage, 0);
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(attacker.rage, 0, 'clamped to maxRage=0 — a harmless no-op, not a crash');
  assert.equal(defender.rage, 0);
});

test('applyOnHitEconomy: block/immune outcomes credit nothing (result.total is always 0 for both) — a real, not coincidental, outcome', () => {
  for (const outcome of ['block', 'immune']) {
    const attacker = makeActor({ classId: 'ravager', id: 700 + outcome.length });
    const defender = makeActor({ classId: 'ravager', id: 800 + outcome.length, team: 1, mana: 10 });
    const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation, manaReturnPercent: 50 });
    const result = blankResult({ outcome, physical: 0, total: 0 });

    applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

    assert.equal(attacker.rage, 0, `outcome=${outcome}: no attacker rage`);
    assert.equal(defender.rage, 0, `outcome=${outcome}: no defender rage`);
    assert.equal(attacker.resonance, 0, `outcome=${outcome}: no resonance`);
    assert.equal(result.manaReturned, 0, `outcome=${outcome}: manaReturned is 0 (phys is always 0 for these outcomes)`);
  }
});

// ---------------------------------------------------------------------------
// D-52 — `packet.requesterOwnsRageCredit`, the R2 escape hatch (SKIL-7)
// ---------------------------------------------------------------------------

test('applyOnHitEconomy: packet.requesterOwnsRageCredit=true skips the ATTACKER\'s rage award only — Resonance and the defender\'s own rage are untouched', () => {
  const attacker = makeActor({ classId: 'ravager', id: 950 });
  attacker.stats.maxResonance = 10; // force nonzero so the Resonance assertion below is meaningful — see the R1 4-body test's own precedent
  const defender = makeActor({ classId: 'ravager', id: 951, team: 1 });
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation, requesterOwnsRageCredit: true });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(attacker.rage, 0, 'attacker rage NOT credited — the requester owns it');
  assert.equal(attacker.resonance, 1, 'Resonance still credits — D-05-2, never gated by this flag');
  assert.equal(defender.rage, 4, 'defender rage-on-take-hit still credits — this flag is attacker-only');
});

test('applyOnHitEconomy: requesterOwnsRageCredit=true suppresses the attacker\'s rage credit across MULTIPLE hits from the same packet, in the same step — the exact whirlwind scenario', () => {
  const attacker = makeActor({ classId: 'ravager', id: 952 });
  attacker.stats.maxResonance = 10; // see the note above
  const targets = [makeActor({ classId: 'ravager', id: 953, team: 1 }), makeActor({ classId: 'ravager', id: 954, team: 1 }), makeActor({ classId: 'ravager', id: 955, team: 1 })];
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation, requesterOwnsRageCredit: true });

  for (const target of targets) {
    const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
    applyOnHitEconomy(packet, target, result, { source: attacker, step: 777 });
  }

  assert.equal(attacker.rage, 0, 'zero attacker rage from combat across all 3 targets — the requester (skills) owns the credit entirely, on its own cadence');
  assert.equal(attacker.resonance, 3, 'Resonance still credits once per landed hit regardless (3 hits, +1 each)');
});

test('applyOnHitEconomy: requesterOwnsRageCredit is false by default (an omitted field never suppresses the existing behaviour)', () => {
  const attacker = makeActor({ classId: 'ravager', id: 956 });
  const defender = makeActor({ classId: 'ravager', id: 957, team: 1 });
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  assert.equal(packet.requesterOwnsRageCredit, false, 'sanity: PacketPool/resetPacketFields default it to false');
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(attacker.rage, 6, 'every existing caller (no field set) is unaffected — combat credits exactly as before');
});

test('applyOnHitEconomy: a killing blow (result.killed=true) still credits rage/resonance normally — R14(f) precedes R14(i)\'s death check', () => {
  const attacker = makeActor({ classId: 'ravager', id: 900 });
  const defender = makeActor({ classId: 'ravager', id: 901, team: 1 });
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  const result = blankResult({ outcome: 'hit', physical: 165, total: 165, killed: true });

  applyOnHitEconomy(packet, defender, result, { source: attacker, step: 0 });

  assert.equal(attacker.rage, 6, 'the landed-hit credit still fires even though this hit kills the target');
});

// ---------------------------------------------------------------------------
// CMBT-8 / D-51 — R1's per-ACTION rage guard (Defect A)
// ---------------------------------------------------------------------------

// D-52 (SKIL-7's finding, fixed here): the ORIGINAL CMBT-8/D-51 fallback
// for `actionId === null` awarded UNCONDITIONALLY on every call, with no
// bookkeeping at all — correct for a `bone_ranker`'s own single-target
// swing (one hit, one call), but wrong the instant an actionId-less
// attacker resolves more than one landed hit in the same fixed step
// (`05-skills.md` §12.1's own bug, one layer down — a channel is exactly
// such an attacker, since it structurally cannot use `beginAction`).
// Tightened to `(generation, step)`: one award per SIMULATION STEP.

test('shouldAwardActionRage: actionId === null, DIFFERENT steps — each step is its own credit (a lone swing, one per step, still always awards)', () => {
  const source = makeActor({ classId: 'ravager', id: 5000 });
  assert.equal(source.actionId, null, 'sanity: pool.js default — this actor never called beginAction');
  assert.equal(shouldAwardActionRage(source, 100), true);
  assert.equal(shouldAwardActionRage(source, 101), true, 'a new step — a fresh credit, even with no actionSeq to key on');
  assert.equal(shouldAwardActionRage(source, 102), true);
});

test('shouldAwardActionRage: actionId === null, SAME step, multiple hits — D-52\'s own fix: credited once, not once per hit (05 §12.1, one layer down)', () => {
  const source = makeActor({ classId: 'ravager', id: 5099 });
  assert.equal(source.actionId, null);
  assert.equal(shouldAwardActionRage(source, 200), true, 'first landed hit this step — credited');
  assert.equal(shouldAwardActionRage(source, 200), false, 'second landed hit, SAME step — suppressed (this is the whole point of D-52)');
  assert.equal(shouldAwardActionRage(source, 200), false, 'third landed hit, SAME step — still suppressed');
  assert.equal(shouldAwardActionRage(source, 201), true, 'the NEXT step is a fresh credit again');
});

test('shouldAwardActionRage: a real tracked action (actionId set) awards ONCE for the SAME (generation, actionSeq), suppressing every repeat', () => {
  const source = makeActor({ classId: 'ravager', id: 5001 });
  source.actionId = 'cleaving_strike'; // as if actors.beginAction() just ran
  source.actionSeq = 1;

  assert.equal(shouldAwardActionRage(source), true, 'first landed hit of this action — credited');
  assert.equal(shouldAwardActionRage(source), false, 'second target, SAME action — suppressed');
  assert.equal(shouldAwardActionRage(source), false, 'third target, SAME action — still suppressed');
});

test('shouldAwardActionRage: a NEW actionSeq (a second cast by the same actor) is credited again', () => {
  const source = makeActor({ classId: 'ravager', id: 5002 });
  source.actionId = 'cleaving_strike';
  source.actionSeq = 1;
  assert.equal(shouldAwardActionRage(source), true);
  assert.equal(shouldAwardActionRage(source), false);

  source.actionSeq = 2; // actors.beginAction() bumped it for a genuinely new cast
  assert.equal(shouldAwardActionRage(source), true, 'a new action must be credited even though actionId did not change');
});

test('shouldAwardActionRage: recycling the pool slot (generation bump) must not suppress a real award, even if the new occupant\'s actionSeq happens to repeat', () => {
  const source = makeActor({ classId: 'ravager', id: 5003 });
  source.actionId = 'cleaving_strike';
  source.actionSeq = 1;
  assert.equal(shouldAwardActionRage(source), true);
  assert.equal(shouldAwardActionRage(source), false, 'suppressed within the same (generation, actionSeq)');

  source.generation = source.generation + 1; // pool.js#resetActorRecord's own bump on recycle
  source.actionSeq = 1; // the fresh occupant's own first action can coincidentally start at 1 again
  assert.equal(shouldAwardActionRage(source), true, 'a stale stamp from the PREVIOUS generation must never suppress the new occupant');
});

test('encodeActionRageStamp: packs (generation, actionSeq) into one float, distinct for distinct pairs', () => {
  assert.notEqual(encodeActionRageStamp(0, 1), encodeActionRageStamp(1, 1), 'different generation, same actionSeq');
  assert.notEqual(encodeActionRageStamp(0, 1), encodeActionRageStamp(0, 2), 'same generation, different actionSeq');
  assert.equal(encodeActionRageStamp(0, 1), encodeActionRageStamp(0, 1));
});

test('applyOnHitEconomy: R1 — a cleaving_strike-shaped action (SAME actionId/actionSeq) resolved against 4 targets credits attacker rage EXACTLY ONCE (6, not 4x6=24), while Resonance still credits on EVERY landed hit (D-05-2)', () => {
  const attacker = makeActor({ classId: 'ravager', id: 6000 });
  attacker.stats.maxResonance = 10; // force both resources nonzero on one actor to prove both rules in a single run — addResourceClamped is class-agnostic, driven only by stats.maxRage/maxResonance (see onhit.js's own header)
  attacker.actionId = 'cleaving_strike'; // as if actors.beginAction() just ran once for this cast
  attacker.actionSeq = 1;

  const targets = [6001, 6002, 6003, 6004].map((id) => makeActor({ classId: null, id, team: 1 }));
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });

  for (const target of targets) {
    const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
    applyOnHitEconomy(packet, target, result, { source: attacker, step: 0 });
  }

  assert.equal(attacker.rage, 6, 'ONE per-action award, not the old per-target 4 x 6 = 24 bug');
  assert.equal(attacker.resonance, 4, 'Resonance credits on EVERY landed hit — 4, not 1');
});

test('applyOnHitEconomy: D-52 — an actionId-less attacker (no beginAction, e.g. a bone_ranker OR a channel with no packet flag set) resolving 4 landed hits in the SAME step credits rage EXACTLY ONCE, not 4x (05 §12.1\'s bug, one layer down, now fixed at the source)', () => {
  const attacker = makeActor({ classId: 'ravager', id: 6050 });
  attacker.stats.maxResonance = 10; // see the note above
  assert.equal(attacker.actionId, null, 'sanity: never routed through beginAction');

  const targets = [6051, 6052, 6053, 6054].map((id) => makeActor({ classId: null, id, team: 1 }));
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation }); // requesterOwnsRageCredit NOT set — the general-purpose fallback is what's under test here

  for (const target of targets) {
    const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
    applyOnHitEconomy(packet, target, result, { source: attacker, step: 42 }); // all 4 in the SAME step
  }

  assert.equal(attacker.rage, 6, 'ONE per-STEP award (D-52), not the per-target 4 x 6 = 24 bug the old unconditional fallback allowed');
  assert.equal(attacker.resonance, 4, 'Resonance still credits on every landed hit regardless');
});

test('applyOnHitEconomy: R1 — the rage award is IDENTICAL whether the action resolves against 1, 4 or 8 bodies (03-combat-math.md §12.1\'s own lock)', () => {
  function runCone(bodyCount, actionSeq) {
    const attacker = makeActor({ classId: 'ravager', id: 7000 + actionSeq });
    attacker.actionId = 'cleaving_strike';
    attacker.actionSeq = actionSeq;
    const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
    for (let i = 0; i < bodyCount; i++) {
      const target = makeActor({ classId: null, id: 7100 + actionSeq * 100 + i, team: 1 });
      const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
      applyOnHitEconomy(packet, target, result, { source: attacker, step: 0 });
    }
    return attacker.rage;
  }

  const rage1 = runCone(1, 1);
  const rage4 = runCone(4, 1); // a fresh actor per call, same actionSeq value is fine — different (poolIndex, generation)
  const rage8 = runCone(8, 1);

  assert.equal(rage1, 6);
  assert.equal(rage4, 6);
  assert.equal(rage8, 6);
  // eslint-disable-next-line no-console
  console.log(`R1 lock: rage after 1/4/8-body cleaving_strike-shaped action = ${rage1}/${rage4}/${rage8} (all must equal BASE_RAGE_ON_HIT=${BASE_RAGE_ON_HIT})`);
});

test('applyOnHitEconomy: the defender still gains its own +4 rage on EVERY hit taken, unaffected by the attacker\'s per-action guard', () => {
  const attacker = makeActor({ classId: 'ravager', id: 8000 });
  attacker.actionId = 'cleaving_strike';
  attacker.actionSeq = 1;
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });

  const targets = [8001, 8002, 8003, 8004].map((id) => makeActor({ classId: 'ravager', id, team: 1 }));
  for (const target of targets) {
    const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
    applyOnHitEconomy(packet, target, result, { source: attacker, step: 0 });
  }

  for (const target of targets) {
    assert.equal(target.rage, 4, `target #${target.id} must gain its own +4 per hit taken, independent of the attacker's guard`);
  }
});

// ---------------------------------------------------------------------------
// lastDamageStep / lastDealtStep — the combat-window bookkeeping this file
// closes (see onhit.js's own header)
// ---------------------------------------------------------------------------

test('applyOnHitEconomy: lastDamageStep (target) / lastDealtStep (attacker) are stamped on real damage, left alone otherwise', () => {
  const attacker = makeActor({ classId: 'ravager', id: 1000 });
  const target = makeActor({ classId: 'ravager', id: 1001, team: 1 });
  assert.equal(attacker.lastDealtStep, -1, 'sanity: pool.js default');
  assert.equal(target.lastDamageStep, -1, 'sanity: pool.js default');

  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  const result = blankResult({ outcome: 'hit', physical: 20, total: 20 });
  applyOnHitEconomy(packet, target, result, { source: attacker, step: 777 });

  assert.equal(target.lastDamageStep, 777);
  assert.equal(attacker.lastDealtStep, 777);
});

test('applyOnHitEconomy: a 0-damage outcome (block) does NOT stamp lastDamageStep/lastDealtStep', () => {
  const attacker = makeActor({ classId: 'ravager', id: 1002 });
  const target = makeActor({ classId: 'ravager', id: 1003, team: 1 });
  const packet = makePacket({ sourceId: attacker.id, sourceGen: attacker.generation });
  const result = blankResult({ outcome: 'block', physical: 0, total: 0 });
  applyOnHitEconomy(packet, target, result, { source: attacker, step: 777 });

  assert.equal(target.lastDamageStep, -1, 'no damage actually landed');
  assert.equal(attacker.lastDealtStep, -1);
});

// ---------------------------------------------------------------------------
// Criterion #3 — E9, rage economy, WITH the D-9 correction
// ---------------------------------------------------------------------------
//
// D-9 (recorded in this ticket's brief, independently verified by the
// orchestrator): 03-combat-math.md's own printed E9 row, "0.778146 x 6 /
// 0.675 = 6.9161", is arithmetically wrong. 0.778146 x 6 = 4.668876;
// 4.668876 / 0.675 = 6.916853..., which rounds to 6.9169, not 6.9161 — a
// digit transposition. This test asserts the RESULT OF THE FORMULA (using
// this file's own BASE_RAGE_ON_HIT and the REAL chanceToHit()/
// computeAttackInterval() functions for the level-10 reference build — E1.1
// and E6.1 respectively, both already-accepted CMBT-2/CMBT-1 numbers), not
// the printed 6.9161 — a test hard-coding 6.9161 would bake the typo into
// the suite and force a future implementation to compute wrongly to "pass".

test('D-9 / E9: rage economy reproduces the CORRECTED chain (6.9169, not the printed 6.9161), every downstream figure recomputed from it, printed', () => {
  // Level-10 reference build inputs, reproduced through the REAL engine
  // functions rather than copy-pasted literals:
  //   - E1.1: chanceToHit(attackRating=235, defense=67, alvl=10, dlvl=10) = 77.8146%
  //   - E6.1: computeAttackInterval(base=0.75 weapon, classScale=0.90 Ravager
  //     attackScale, skillScale=1.00, ias=0) = 0.6750 s
  const hitChancePercent = chanceToHit(235, 67, 10, 10);
  approx(hitChancePercent, 77.8146, 'E1.1, sanity — the level-10 reference build\'s own hit chance');
  const attackInterval = computeAttackInterval(0.75, 0.90, 1.00, 0);
  approx(attackInterval, 0.6750, 'E6.1, sanity — the level-10 Ravager swing interval');

  const hitChance = hitChancePercent / 100; // 0.778146, matching the spec's own notation
  approx(hitChance, 0.778146, 'the spec\'s own "0.778146" input, reproduced from chanceToHit(), not hard-coded');

  // --- the formula itself, using BASE_RAGE_ON_HIT (this file's own data
  // constant), not a hard-coded "6" -------------------------------------
  const ragePerSecond = hitChance * BASE_RAGE_ON_HIT / attackInterval;

  // D-9: the WRONG printed value the spec accidentally shows.
  const printedButWrong = 6.9161;
  assert.notEqual(
    Number(ragePerSecond.toFixed(4)), printedButWrong,
    'D-9: this test must NOT reproduce the spec\'s own typo\'d 6.9161',
  );

  // The corrected value.
  approx(ragePerSecond, 6.9169, 'D-9 corrected: rage/s = 0.778146 x 6 / 0.675');

  const cleavingStrikeEvery = 9 / ragePerSecond;
  approx(cleavingStrikeEvery, 1.3012, 'D-9 corrected: cleaving_strike (9 rage) castable every');

  const whirlwindNet = ragePerSecond - 12;
  approx(whirlwindNet, -5.0831, 'D-9 corrected: whirlwind (12 rage/s drain) net');

  const channelFromFull = 100 / Math.abs(whirlwindNet);
  assert.equal(channelFromFull.toFixed(2), '19.67', 'unchanged at the printed 2dp — channel duration from a full 100 rage (the ticket\'s own wording: "2 dp", not 1e-4)');

  const outOfCombatDecay = 100 / 8; // RAGE_DECAY_PER_SECOND, vessels.js
  approx(outOfCombatDecay, 12.5, 'unchanged — out-of-combat decay from 100 to 0');

  // eslint-disable-next-line no-console
  console.log([
    'E9 corrected chain (D-9 applied — see this file\'s own comment):',
    `  hit chance:                 ${hitChance} (${hitChancePercent}%)`,
    `  attack interval:             ${attackInterval} s`,
    `  rage/s = ${hitChance} x ${BASE_RAGE_ON_HIT} / ${attackInterval} = ${ragePerSecond.toFixed(4)} (spec prints ${printedButWrong}, WRONG — D-9)`,
    `  cleaving_strike every:       9 / ${ragePerSecond.toFixed(4)} = ${cleavingStrikeEvery.toFixed(4)} s`,
    `  whirlwind net drain:         ${ragePerSecond.toFixed(4)} - 12 = ${whirlwindNet.toFixed(4)} /s`,
    `  channel from full 100 rage:  100 / ${Math.abs(whirlwindNet).toFixed(4)} = ${channelFromFull.toFixed(2)} s`,
    `  out-of-combat decay 100->0:  100 / 8 = ${outOfCombatDecay.toFixed(1)} s`,
  ].join('\n'));
});

// ---------------------------------------------------------------------------
// O-51 — the module-graph regression test: import ONLY packet.js
// ---------------------------------------------------------------------------

test('packet.js alone (no onhit.js import) wires applyOnHitEconomy into CombatSystem#resolve()', async () => {
  const { CombatSystem: FreshCombatSystem } = await import('../../src/combat/packet.js');
  const combat = new FreshCombatSystem();
  assert.equal(typeof combat.resolve, 'function', 'CombatSystem#resolve must exist once packet.js alone is loaded');
});

test('CombatSystem#resolve, driven through a real init(), applies R14(d)/(f) end-to-end on real actors', async () => {
  const events = new EventBus();
  const actorsSystemStub = {
    resolve(ref) {
      return this._byId ? this._byId(ref.id) : null;
    },
  };
  const combat = new CombatSystem();
  const ctx = {
    rng: new Rng(12345),
    events,
    time: { step: 1000 },
    get(id) { if (id === 'actors') return actorsSystemStub; throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };
  await combat.init(ctx);

  const attacker = makeActor({ kind: 'player', classId: 'runeblade', id: 2000, mana: 0 });
  attacker.team = 0;
  const target = makeActor({ kind: 'monster', classId: null, id: 2001 });
  target.team = 1;
  target.stats.maxLife = 1000;
  target.life = 1000;
  actorsSystemStub._byId = (id) => (id === attacker.id ? attacker : id === target.id ? target : null);

  const packet = combat.buildAttackPacket(attacker, 'attack', 0);
  packet.team = attacker.team;
  // manaReturnPercent is NOT hand-set here any more: O-84/D-53 (SKIL-5)
  // added the Runeblade class-base 8 to CLASS_TABLE (src/actors/stats.js),
  // so makeActor()'s own composeStats() call already put 8 on
  // attacker.stats.manaReturnPercent with no gear at all — setting it again
  // here would double it (8 + 8 = 16).
  packet.manaReturnPercent = attacker.stats.manaReturnPercent;
  packet.attackRating = 0; // always hits — isolates this test from the RNG to-hit draw
  packet.blockable = false;
  packet.dodgeable = false;
  packet.critChance = 0;
  packet.critMult = 100;
  packet.physMin = 21.4438; packet.physMax = 21.4438; // pin the physical roll

  const result = combat.resolve(packet, target);

  assert.equal(result.outcome, 'hit');
  approx(result.manaReturned, 1.71550, 'manaReturned computed end-to-end through the real CombatSystem#resolve()');
  approx(attacker.mana, 1.71550, 'attacker.mana credited end-to-end');
  assert.equal(attacker.resonance, 0, 'attackRating=0 means this packet is NOT melee (isLikelyMeleeAttack) — no Resonance from a pure spell hit');
  assert.equal(target.lastDamageStep, 1000, 'combat-window bookkeeping fired end-to-end too');
  assert.equal(attacker.lastDealtStep, 1000);

  combat.releasePacket(packet);
  combat.dispose();
});
