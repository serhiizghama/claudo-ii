// tests/combat/tohit.test.js
//
// CMBT-2 acceptance tests for src/combat/tohit.js.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim): `chanceToHit`
// clamps to 5..95, and E1 (all eight rows) and E2 (all five rows) reproduce
// exactly, to 1e-4. Per D-14 (already applied to the ticket), E7 (hit
// recovery, CMBT-5) and E8 (chill accumulation, CMBT-4) are NOT this
// ticket's and are not tested here.
//
// Not tested here (owned by other tickets, not touched by this one):
// resolve()/the actual RNG draw and the to-hit -> dodge -> block
// short-circuit order (CMBT-3), the attackRating===0 always-hits bypass and
// packet.blockable/dodgeable/frontal-arc gating (also resolve()-side,
// CMBT-3), dodge (no dedicated public method exists — see tohit.js's own
// header), hit recovery (CMBT-5), chill accumulation (CMBT-4).

import test from 'node:test';
import assert from 'node:assert/strict';

import { chanceToHit, blockChanceOf, SHIELD_BLOCK_BASE } from '../../src/combat/tohit.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats } from '../../src/actors/stats.js';

const EPS = 1e-4;

// ---------------------------------------------------------------------------
// E1 — chance to hit, all eight rows (03-combat-math.md §5.1)
// ---------------------------------------------------------------------------

test('E1: chanceToHit reproduces all eight worked-example rows to 1e-4', () => {
  const rows = [
    // AR,    DEF,   alvl, dlvl, expected
    [235, 67, 10, 10, 77.8146], // E1.1
    [240, 67, 10, 10, 78.1759], // E1.2
    [260, 130, 13, 15, 61.9048], // E1.3
    [275, 130, 13, 15, 63.0511], // E1.4
    [199, 137, 10, 10, 59.2262], // E1.5
    [243, 137, 10, 10, 63.9474], // E1.6
    [50, 900, 5, 30, 5], // E1.7 — low clamp
    [5000, 10, 30, 1, 95], // E1.8 — high clamp
  ];

  for (const [ar, def, alvl, dlvl, expected] of rows) {
    const got = chanceToHit(ar, def, alvl, dlvl);
    assert.ok(
      Math.abs(got - expected) < EPS,
      `chanceToHit(${ar}, ${def}, ${alvl}, ${dlvl}) = ${got}, expected ${expected}`,
    );
  }
});

test('E1.7/E1.8: the low and high bounds are genuine clamps, not coincidences', () => {
  // E1.7: the unclamped formula value is well below 5 — the "5" is the
  // floor doing real work, not a formula that happens to land on 5.
  const rawLow = (200 * 50 * 5) / ((50 + 900) * (5 + 30));
  assert.ok(rawLow < 5, `unclamped E1.7 value (${rawLow}) must be below the floor for this to be a real clamp`);
  assert.equal(chanceToHit(50, 900, 5, 30), 5);

  // E1.8: the unclamped formula value is well above 95 — the "95" is the
  // ceiling doing real work.
  const rawHigh = (200 * 5000 * 30) / ((5000 + 10) * (30 + 1));
  assert.ok(rawHigh > 95, `unclamped E1.8 value (${rawHigh}) must be above the ceiling for this to be a real clamp`);
  assert.equal(chanceToHit(5000, 10, 30, 1), 95);
});

test('chanceToHit: general clamp — never returns outside [5, 95] across a spread of inputs', () => {
  const samples = [
    [0, 1000, 1, 40], // starved attacker vs a same-or-higher target
    [100000, 1, 40, 1], // absurd AR vs a trivial defender, same level
    [1, 1, 1, 1],
    [0, 0, 1, 1], // AR===0, DEF===0 — denominator guard, must not be NaN
  ];
  for (const [ar, def, alvl, dlvl] of samples) {
    const got = chanceToHit(ar, def, alvl, dlvl);
    assert.ok(Number.isFinite(got), `chanceToHit(${ar}, ${def}, ${alvl}, ${dlvl}) must be finite, got ${got}`);
    assert.ok(got >= 5 && got <= 95, `chanceToHit(${ar}, ${def}, ${alvl}, ${dlvl}) = ${got} escaped [5, 95]`);
  }
});

// ---------------------------------------------------------------------------
// E2 — block chance, all five rows (03-combat-math.md §5.3)
// ---------------------------------------------------------------------------

/** Minimal actor-shaped fixture: only the fields blockChanceOf reads
 * (`.stats.dexterity`, `.stats.blockChance`, `.level`,
 * `.equipment.offHand.blockBase`). Not run through composeStats — see the
 * "real actor" integration test below for that path. */
function fixtureActor({ blockBase, flatBlockChance, dexterity, clvl }) {
  return {
    level: clvl,
    stats: { dexterity, blockChance: flatBlockChance },
    equipment: blockBase === null ? null : { offHand: { blockBase } },
  };
}

test('E2: blockChanceOf reproduces all five worked-example rows to 1e-4', () => {
  const rows = [
    // blockBase, flat, DEX, clvl, expected
    [55, 0, 32, 13, 35.9615], // E2.1
    [55, 12, 32, 13, 47.9615], // E2.2
    [55, 0, 20, 13, 10.5769], // E2.3
    [null, 40, 32, 13, 0], // E2.4 — no shield in offHand
    [65, 30, 90, 12, 75], // E2.5 — high clamp
  ];

  for (const [blockBase, flat, dex, clvl, expected] of rows) {
    const actor = fixtureActor({ blockBase, flatBlockChance: flat, dexterity: dex, clvl });
    const got = blockChanceOf(actor);
    assert.ok(
      Math.abs(got - expected) < EPS,
      `blockChanceOf({blockBase:${blockBase}, flat:${flat}, DEX:${dex}, clvl:${clvl}}) = ${got}, expected ${expected}`,
    );
  }
});

test('E2.4: no-shield short-circuit fires BEFORE stats.blockChance is added', () => {
  // blockBase 0 would still leave a non-zero shieldTerm-plus-flat sum if the
  // short-circuit ran after the addition (0 + 40 = 40); the spec is explicit
  // the check happens first, so the true no-shield case (offHand null) must
  // return exactly 0 regardless of how large the flat bonus is.
  const noShield = fixtureActor({ blockBase: null, flatBlockChance: 40, dexterity: 32, clvl: 13 });
  assert.equal(blockChanceOf(noShield), 0);

  // A shield with blockBase 0 (hypothetically) is a DIFFERENT case from "no
  // shield at all" — it still has an offHand item, so the flat bonus alone
  // should surface once the negative shieldTerm math is applied. This is
  // not a worked-example row; it only proves the branch is "shield present
  // or not", not "blockBase truthy or not".
  const zeroBaseShield = fixtureActor({ blockBase: 0, flatBlockChance: 40, dexterity: 32, clvl: 13 });
  assert.equal(blockChanceOf(zeroBaseShield), 40);
});

test('E2.5: the 75 ceiling is a genuine clamp, not a coincidence', () => {
  const rawHigh = (65 * (90 - 15)) / (2 * 12) + 30;
  assert.ok(rawHigh > 75, `unclamped E2.5 value (${rawHigh}) must be above the ceiling for this to be a real clamp`);
  const actor = fixtureActor({ blockBase: 65, flatBlockChance: 30, dexterity: 90, clvl: 12 });
  assert.equal(blockChanceOf(actor), 75);
});

test('blockChanceOf: general clamp — never returns outside [0, 75]', () => {
  const lowDexActor = fixtureActor({ blockBase: 65, flatBlockChance: -1000, dexterity: 1, clvl: 40 });
  const got = blockChanceOf(lowDexActor);
  assert.ok(got >= 0 && got <= 75, `blockChanceOf(...) = ${got} escaped [0, 75]`);
});

test('blockChanceOf: throws a clear error when actor.stats is not composed', () => {
  assert.throws(() => blockChanceOf({ level: 10, equipment: null }), /stats is not composed/);
});

test('SHIELD_BLOCK_BASE: the four documented shield bases (03-combat-math.md §5.3)', () => {
  assert.equal(SHIELD_BLOCK_BASE.buckler, 40);
  assert.equal(SHIELD_BLOCK_BASE.targe, 50);
  assert.equal(SHIELD_BLOCK_BASE.kite_shield, 55);
  assert.equal(SHIELD_BLOCK_BASE.tower_shield, 65);
});

// ---------------------------------------------------------------------------
// Integration: a REAL composed StatBlock (src/actors/stats.js), not just a
// hand-built fixture — proves blockChanceOf reads the actual field names
// composeStats produces. Every attribute is supplied (strength/dexterity/
// vitality/energy) to avoid the documented composeStats NaN trap.
// ---------------------------------------------------------------------------

test('blockChanceOf: works against a real composeStats()-produced actor', () => {
  const actor = createActorRecord(0);
  actor.classId = 'ravager';
  actor.level = 13;
  actor.attributes = { strength: 30, dexterity: 32, vitality: 25, energy: 10 };
  composeStats(actor);

  actor.equipment = { offHand: { blockBase: SHIELD_BLOCK_BASE.kite_shield } };

  const expectedShieldTerm = (55 * (actor.stats.dexterity - 15)) / (2 * actor.level);
  const expected = Math.min(75, Math.max(0, expectedShieldTerm + actor.stats.blockChance));
  assert.ok(Math.abs(blockChanceOf(actor) - expected) < EPS);

  actor.equipment = null;
  assert.equal(blockChanceOf(actor), 0);
});

// ---------------------------------------------------------------------------
// Real-boot wiring — the regression test for the module-graph bug found in
// review: an earlier version of tohit.js imported `packet.js` and attached
// `chanceToHit`/`blockChanceOf` to `CombatSystem.prototype` as a SIDE EFFECT
// of being imported. `src/main.js` imports only `packet.js` for the
// `combat` registration (O-12's two-line wiring) — nothing in the real boot
// ever imports `tohit.js`, so that prototype extension never ran in the
// actual game, only in this test file (which imported `tohit.js` directly
// and could not see the gap). The fix: `tohit.js` exports plain pure
// functions and imports nothing; `packet.js` imports `tohit.js` and
// attaches the methods itself, so loading `packet.js` alone — exactly what
// `main.js` does — is enough.
//
// This test deliberately imports ONLY `src/combat/packet.js`, the same way
// `main.js` does, and never touches `../../src/combat/tohit.js` in its own
// import list (the static import at the top of this file, used by the pure
// tests above, is irrelevant to what this test proves — it asserts
// specifically that `packet.js`'s OWN module graph, loaded on its own,
// already carries the wiring). Expected numbers are the same literal E1.1/
// E2.1 rows from the worked examples above, spelled out again rather than
// cross-checked against `tohit.js`'s exports, so a regression in either
// packet.js's wiring OR tohit.js's formula would fail this test on its own
// terms, not by comparing two paths that could both be broken the same way.
// ---------------------------------------------------------------------------

test('packet.js alone (no tohit.js import) wires chanceToHit/blockChanceOf onto CombatSystem — the real main.js boot path', async () => {
  const { CombatSystem } = await import('../../src/combat/packet.js');
  const combat = new CombatSystem();

  assert.equal(typeof combat.chanceToHit, 'function', 'CombatSystem#chanceToHit must exist once packet.js is loaded');
  assert.equal(typeof combat.blockChanceOf, 'function', 'CombatSystem#blockChanceOf must exist once packet.js is loaded');

  // E1.1, spelled out literally — not derived from tohit.js's own export.
  const cth = combat.chanceToHit(235, 67, 10, 10);
  assert.ok(Math.abs(cth - 77.8146) < EPS, `chanceToHit(235,67,10,10) = ${cth}, expected 77.8146`);

  // E2.1, spelled out literally — not derived from tohit.js's own export.
  const blockActor = {
    level: 13,
    stats: { dexterity: 32, blockChance: 0 },
    equipment: { offHand: { blockBase: 55 } },
  };
  const block = combat.blockChanceOf(blockActor);
  assert.ok(Math.abs(block - 35.9615) < EPS, `blockChanceOf(...) = ${block}, expected 35.9615`);
});
