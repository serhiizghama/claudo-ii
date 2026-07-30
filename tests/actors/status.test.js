// tests/actors/status.test.js
//
// ACTR-10 acceptance tests for src/actors/status.js + src/actors/data/statuses.js.
// `node:test` + `node:assert/strict` only (12-testing.md P6, same as every
// other `tests/actors/*.test.js`).
//
// Scope: the seven `02-api-contracts.md` "Status effects" methods
// (`applyStatus`/`removeStatus`/`hasStatus`/`statusStacks`/`statusRemaining`/
// `clearStatuses`/`expireBySource`), the four `01 §7.3` stacking rules, the
// 24-instance overflow cap, and `expireStatuses` (this file's own internal
// engine hook, the sibling of `vessels.js#integrateVessels`/
// `action.js#advanceAction`). NOT tested here (O-27 — do not assert on the
// absence of a later ticket): the real DoT tick LOOP (walking every actor
// each fixed step and applying tick damage) — that is CMBT-4's, not built;
// chill accumulation / stun diminishing-returns (combat's fields, untouched
// by this file); `ActorsSystem.fixedUpdate` actually calling
// `expireStatuses` (src/actors/index.js, not this ticket's file).
//
// THIS FILE'S ACCEPTANCE GATE (per the ticket):
//   1. `hasStatus` is a bit test, not a scan — proved STRUCTURALLY: wrapping
//      `actor.statuses` in a `Proxy` that throws on every trap still lets
//      `hasStatus` answer correctly, because it never touches the array.
//   2. `expireBySource` removes exactly the matching set — a same-status,
//      different-source instance survives.
//   3. A recycled actor slot starts with zero statuses and a zero
//      `statusMask` — inherits nothing from the previous occupant.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord, ActorPool } from '../../src/actors/pool.js';
import {
  applyStatus,
  removeStatus,
  hasStatus,
  statusStacks,
  statusRemaining,
  clearStatuses,
  expireBySource,
  expireStatuses,
  isActionLockedByStatus,
  ACTION_LOCKING_STATUS_MASK,
  STATUS,
  STATUS_ORDER,
  STATUS_BIT,
} from '../../src/actors/status.js';
import { POISONED_STATUS_BIT } from '../../src/actors/vessels.js';

let nextPoolIndex = 0;

/** A live `Actor` record, hand-built (same stand-in style
 * `vessels.test.js`/`action.test.js` already use) — status.js's logic does
 * not depend on how the actor was spawned, only on `id`/`dead`/`rank`/
 * `statuses`/`statusMask`/`ccImmuneUntil` already being the shape
 * `pool.js#createActorRecord` gives them. Each call gets a distinct `id` so
 * the `actor.id % 15` tick-phase math is exercised across different phases
 * across tests, and a distinct `poolIndex` mirroring the real pool's
 * one-slot-per-live-actor invariant.
 * @param {object} [overrides]
 */
function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex);
  actor.id = overrides.id ?? (nextPoolIndex + 1);
  nextPoolIndex++;
  actor.dead = overrides.dead ?? false;
  actor.rank = overrides.rank ?? 'normal';
  return actor;
}

function spawnSpec(overrides = {}) {
  return {
    kind: overrides.kind ?? 'monster',
    rank: overrides.rank ?? 'normal',
    archetypeId: overrides.archetypeId ?? 'test_dummy',
    nameOverride: null,
    team: overrides.team ?? 1,
    level: overrides.level ?? 10,
    packId: 0,
    ownerId: 0,
    facing: 0,
    x: 0,
    z: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. hasStatus is a bit test, not a scan — structural proof
// ---------------------------------------------------------------------------

test('hasStatus: a single & against statusMask, never touches actor.statuses (structural proof)', () => {
  const actor = makeActor();
  actor.statusMask = STATUS_BIT.burning | STATUS_BIT.chilled;

  // Any access at all — get, has, ownKeys, iteration, .length — throws.
  // If hasStatus were a scan/loop over the instance list, it would trip
  // this on its very first read.
  const guarded = new Proxy(actor.statuses, {
    get() { throw new Error('hasStatus touched actor.statuses — it must be a pure bitfield test'); },
    has() { throw new Error('hasStatus touched actor.statuses — it must be a pure bitfield test'); },
    ownKeys() { throw new Error('hasStatus touched actor.statuses — it must be a pure bitfield test'); },
  });
  actor.statuses = guarded;

  assert.equal(hasStatus(actor, 'burning'), true);
  assert.equal(hasStatus(actor, 'chilled'), true);
  assert.equal(hasStatus(actor, 'poisoned'), false);
  assert.equal(hasStatus(actor, 'cursed'), false);
});

test('hasStatus: unknown status key fails safe (false), never throws', () => {
  const actor = makeActor();
  assert.equal(hasStatus(actor, 'not_a_real_status'), false);
});

test('STATUS_BIT.poisoned matches vessels.js#POISONED_STATUS_BIT (ACTR-8 hard-codes 1<<1)', () => {
  assert.equal(STATUS_BIT.poisoned, POISONED_STATUS_BIT);
  assert.equal(STATUS_BIT.poisoned, 1 << 1);
});

test('STATUS_ORDER is the fixed DoT resolution order, not alphabetical, not STATUS_BIT declaration order', () => {
  assert.deepEqual(STATUS_ORDER, [
    'burning', 'poisoned', 'bleeding', 'shocked', 'chilled', 'frozen',
    'slowed', 'stunned', 'blinded', 'cursed',
  ]);
});

// ---------------------------------------------------------------------------
// 2. expireBySource — removes exactly the matching set
// ---------------------------------------------------------------------------

test('expireBySource: removes every instance from that source; a same-status different-source instance survives', () => {
  const actor = makeActor();
  const fromA = applyStatus(actor, {
    status: 'burning', step: 100, sourceId: 41, sourceGen: 1, sourceSkill: 'flame_wave', element: 'fire', magnitude: 5, duration: 3.0,
  });
  const fromB = applyStatus(actor, {
    status: 'burning', step: 100, sourceId: 99, sourceGen: 1, sourceSkill: 'ember', element: 'fire', magnitude: 3, duration: 3.0,
  });
  assert.ok(fromA);
  assert.ok(fromB);
  assert.equal(statusStacks(actor, 'burning'), 2, 'precondition: two independent burning stacks from two sources');

  const removed = expireBySource(actor, 41);

  assert.equal(removed, 1, 'exactly one instance (source 41) removed');
  assert.equal(statusStacks(actor, 'burning'), 1, 'source 99s burning instance survives');
  assert.equal(hasStatus(actor, 'burning'), true, 'the bit stays set — a live instance remains');
  assert.equal(actor.statuses.length, 1);
  assert.equal(actor.statuses[0].sourceId, 99);
});

test('expireBySource: clears the bit once every instance of a status is gone, but not other statuses from the same source', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 7, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'slowed', step: 0, sourceId: 7, magnitude: 30, duration: 2.0 });
  applyStatus(actor, { status: 'poisoned', step: 0, sourceId: 55, magnitude: 4, duration: 5.0 });

  const removed = expireBySource(actor, 7);

  assert.equal(removed, 2);
  assert.equal(hasStatus(actor, 'burning'), false);
  assert.equal(hasStatus(actor, 'slowed'), false);
  assert.equal(hasStatus(actor, 'poisoned'), true, 'a different sources status is untouched');
});

test('expireBySource: an unknown sourceId removes nothing', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'chilled', step: 0, sourceId: 1, magnitude: 30, duration: 2.0 });
  assert.equal(expireBySource(actor, 999), 0);
  assert.equal(hasStatus(actor, 'chilled'), true);
});

// ---------------------------------------------------------------------------
// 3. Recycled actor slot inherits nothing
// ---------------------------------------------------------------------------

test('recycled actor slot: statuses/statusMask start clean, including the proper clearStatuses-before-release path', () => {
  const pool = new ActorPool(4);
  const a = pool.acquire(spawnSpec());
  applyStatus(a, { status: 'burning', step: 0, sourceId: 1, magnitude: 5, duration: 3.0 });
  applyStatus(a, { status: 'shocked', step: 0, sourceId: 1, magnitude: 10, duration: 2.0 });
  assert.equal(a.statuses.length, 2);
  assert.notEqual(a.statusMask, 0);

  // The correct despawn sequence: release status instances back to this
  // module's own pool BEFORE the actor slot is recycled (see status.js's
  // report note — pool.js's own reset only empties actor.statuses, it does
  // not know about status.js's private instance pool).
  clearStatuses(a, false);
  assert.equal(a.statuses.length, 0);
  pool.release(a);

  const b = pool.acquire(spawnSpec({ archetypeId: 'other_dummy' }));
  assert.equal(b.poolIndex, a.poolIndex, 'precondition: the slot was actually reused');
  assert.equal(b.statuses.length, 0, 'recycled slot inherits zero statuses');
  assert.equal(b.statusMask, 0, 'recycled slot inherits a zero statusMask');
  assert.equal(hasStatus(b, 'burning'), false);
  assert.equal(hasStatus(b, 'shocked'), false);
});

test('recycled actor slot: even WITHOUT clearStatuses first, pool.js#release already guarantees zero statuses/statusMask', () => {
  const pool = new ActorPool(4);
  const a = pool.acquire(spawnSpec());
  applyStatus(a, { status: 'cursed', step: 0, sourceId: 1, magnitude: 20, duration: 4.0 });
  assert.equal(a.statuses.length, 1);
  assert.notEqual(a.statusMask, 0);

  pool.release(a); // no clearStatuses call — exercises pool.js's own reset in isolation

  const b = pool.acquire(spawnSpec());
  assert.equal(b.poolIndex, a.poolIndex, 'precondition: the slot was actually reused');
  assert.equal(b.statuses.length, 0, 'recycled slot inherits zero statuses');
  assert.equal(b.statusMask, 0, 'recycled slot inherits a zero statusMask');
  assert.equal(hasStatus(b, 'cursed'), false);
});

// ---------------------------------------------------------------------------
// Stacking rule: refresh (chilled/slowed/blinded/cursed/frozen/stunned)
// ---------------------------------------------------------------------------

test('refresh: max-wins on magnitude, duration takes the max, no new instance allocated', () => {
  const actor = makeActor();
  const first = applyStatus(actor, { status: 'chilled', step: 100, sourceId: 1, magnitude: 30, duration: 2.0 });
  assert.ok(first);
  const second = applyStatus(actor, { status: 'chilled', step: 150, sourceId: 2, magnitude: 60, duration: 1.0 });

  assert.equal(actor.statuses.length, 1, 'refresh never allocates a new instance');
  assert.equal(second, first, 'the same instance object is returned/mutated');
  assert.equal(first.magnitude, 60, 'max-wins on magnitude');
  assert.equal(first.expiresStep, Math.max(100 + 120, 150 + 60), 'expiresStep is max(existing, now+newDuration)');
  assert.equal(first.sourceId, 2, 'newest applier updates the source fields (documented decision)');
});

test('refresh: a shorter/weaker reapplication still only ever extends, never shrinks', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'slowed', step: 0, sourceId: 1, magnitude: 50, duration: 5.0 });
  applyStatus(actor, { status: 'slowed', step: 10, sourceId: 2, magnitude: 10, duration: 0.5 });

  assert.equal(actor.statuses.length, 1);
  assert.equal(actor.statuses[0].magnitude, 50, 'weaker reapplication does not lower magnitude');
  assert.equal(actor.statuses[0].expiresStep, 300, 'weaker/shorter reapplication does not shorten duration');
});

test('refresh: frozen/stunned magnitude is unused (0) regardless of what a caller passes', () => {
  const actor = makeActor();
  const inst = applyStatus(actor, { status: 'stunned', step: 0, sourceId: 1, magnitude: 0, duration: 1.0 });
  assert.equal(inst.magnitude, 0);
  assert.equal(inst.statMods, null);
});

test('frozen: reapplication is blocked for the 3.0 s immunity window after it expires', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'frozen', step: 0, sourceId: 1, magnitude: 0, duration: 1.2 });
  assert.equal(hasStatus(actor, 'frozen'), true);

  const expiredCount = expireStatuses(actor, 72); // 1.2s * 60Hz = 72 steps
  assert.equal(expiredCount, 1);
  assert.equal(hasStatus(actor, 'frozen'), false);
  assert.equal(actor.ccImmuneUntil, 72 + 180, 'ccImmuneUntil = expiry step + 3.0s (180 steps)');

  const blocked = applyStatus(actor, { status: 'frozen', step: 100, sourceId: 1, magnitude: 0, duration: 1.2 });
  assert.equal(blocked, null, 'refused while still inside the immunity window');
  assert.equal(hasStatus(actor, 'frozen'), false);

  const allowed = applyStatus(actor, { status: 'frozen', step: 260, sourceId: 1, magnitude: 0, duration: 1.2 });
  assert.ok(allowed, 'allowed once the immunity window has passed');
});

// ---------------------------------------------------------------------------
// Stacking rule: independent stacks (burning max 3, bleeding max 5)
// ---------------------------------------------------------------------------

test('independent stacks: pushes separate instances up to maxStacks, each with its own timer', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 1, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'burning', step: 10, sourceId: 2, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'burning', step: 20, sourceId: 3, magnitude: 5, duration: 3.0 });

  assert.equal(actor.statuses.length, 3);
  assert.equal(statusStacks(actor, 'burning'), 3);
  const expirySteps = actor.statuses.map((i) => i.expiresStep).sort((a, b) => a - b);
  assert.deepEqual(expirySteps, [180, 190, 200], 'three genuinely independent timers');
});

test('independent stacks: at the cap, the lowest-totalRemaining instance is replaced, the others are untouched', () => {
  const actor = makeActor();
  const a = applyStatus(actor, { status: 'burning', step: 0, sourceId: 1, magnitude: 10, duration: 5.0 }); // total 50
  const b = applyStatus(actor, { status: 'burning', step: 0, sourceId: 2, magnitude: 2, duration: 2.0 }); // total 4 (lowest)
  const c = applyStatus(actor, { status: 'burning', step: 0, sourceId: 3, magnitude: 20, duration: 5.0 }); // total 100
  assert.equal(actor.statuses.length, 3, 'precondition: at maxStacks (3)');

  const fourth = applyStatus(actor, { status: 'burning', step: 500, sourceId: 4, magnitude: 7, duration: 1.0 });

  assert.equal(actor.statuses.length, 3, 'still exactly 3 — replaced in place, not appended');
  assert.equal(fourth, b, 'the lowest-totalRemaining instance (b) was the one reused');
  assert.equal(fourth.sourceId, 4);
  assert.equal(fourth.magnitude, 7);
  assert.ok(actor.statuses.includes(a), 'instance a (highest total) is untouched');
  assert.ok(actor.statuses.includes(c), 'instance c (highest total) is untouched');
});

// ---------------------------------------------------------------------------
// Stacking rule: replace if greater total (poisoned)
// ---------------------------------------------------------------------------

test('replace if greater total: a weaker poison application is discarded entirely, no mutation', () => {
  const actor = makeActor();
  const first = applyStatus(actor, { status: 'poisoned', step: 0, sourceId: 1, magnitude: 10, duration: 5.0 }); // total 50
  const before = { ...first };

  const result = applyStatus(actor, { status: 'poisoned', step: 50, sourceId: 2, magnitude: 1, duration: 1.0 }); // total 1

  assert.equal(result, null, 'discarded — new total (1) is not greater than existing (50)');
  assert.equal(actor.statuses.length, 1);
  assert.equal(first.sourceId, before.sourceId, 'existing instance completely untouched');
  assert.equal(first.expiresStep, before.expiresStep);
  assert.equal(first.totalRemaining, before.totalRemaining);
});

test('replace if greater total: a stronger poison application replaces the existing instance', () => {
  const actor = makeActor();
  const first = applyStatus(actor, { status: 'poisoned', step: 0, sourceId: 1, magnitude: 10, duration: 5.0 }); // total 50

  const result = applyStatus(actor, { status: 'poisoned', step: 50, sourceId: 2, magnitude: 20, duration: 5.0 }); // total 100

  assert.equal(result, first, 'replaced in place — same instance object');
  assert.equal(actor.statuses.length, 1, 'still exactly one poisoned instance, never two');
  assert.equal(first.sourceId, 2);
  assert.equal(first.totalRemaining, 100);
  assert.equal(first.statMods.lifeRegen, 0);
});

// ---------------------------------------------------------------------------
// Stacking rule: additive stacks (shocked, max 3)
// ---------------------------------------------------------------------------

test('additive stacks: one instance, stacks increments to the cap and stays there', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'shocked', step: 0, sourceId: 1, magnitude: 15, duration: 3.0 });
  applyStatus(actor, { status: 'shocked', step: 5, sourceId: 1, magnitude: 15, duration: 3.0 });
  applyStatus(actor, { status: 'shocked', step: 10, sourceId: 1, magnitude: 15, duration: 3.0 });
  applyStatus(actor, { status: 'shocked', step: 15, sourceId: 1, magnitude: 15, duration: 3.0 }); // past the cap

  assert.equal(actor.statuses.length, 1, 'always one instance, never one-per-application');
  assert.equal(actor.statuses[0].stacks, 3, 'capped at maxStacks (3)');
  assert.equal(statusStacks(actor, 'shocked'), 3);
});

test('additive stacks: the newest application overwrites expiresStep (not max()) — can shorten remaining duration', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'shocked', step: 0, sourceId: 1, magnitude: 15, duration: 10.0 }); // expires at 600
  const second = applyStatus(actor, { status: 'shocked', step: 100, sourceId: 1, magnitude: 15, duration: 1.0 }); // expires at 160

  assert.equal(second.expiresStep, 160, 'overwritten by the newest application, unlike the refresh family');
});

// ---------------------------------------------------------------------------
// removeStatus / statusStacks / statusRemaining / clearStatuses
// ---------------------------------------------------------------------------

test('removeStatus: removes every instance of a status (independent stacks included) and returns the count', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 1, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 2, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'chilled', step: 0, sourceId: 1, magnitude: 30, duration: 2.0 });

  const removed = removeStatus(actor, 'burning');

  assert.equal(removed, 2);
  assert.equal(hasStatus(actor, 'burning'), false);
  assert.equal(hasStatus(actor, 'chilled'), true, 'unrelated status untouched');
  assert.equal(actor.statuses.length, 1);
});

test('statusStacks: 0 for an absent status, exact count for present ones', () => {
  const actor = makeActor();
  assert.equal(statusStacks(actor, 'burning'), 0);
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 1, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 2, magnitude: 5, duration: 3.0 });
  assert.equal(statusStacks(actor, 'burning'), 2);
});

test('statusRemaining: seconds remaining given an explicit step, 0 once expired or absent', () => {
  const actor = makeActor();
  assert.equal(statusRemaining(actor, 'slowed', 0), 0, 'absent -> 0');
  applyStatus(actor, { status: 'slowed', step: 100, sourceId: 1, magnitude: 30, duration: 2.0 }); // expiresStep 220
  assert.equal(statusRemaining(actor, 'slowed', 100), 2.0);
  assert.equal(statusRemaining(actor, 'slowed', 160), 1.0);
  assert.equal(statusRemaining(actor, 'slowed', 220), 0, 'exactly at expiry -> 0');
  assert.equal(statusRemaining(actor, 'slowed', 300), 0, 'past expiry -> 0, never negative');
});

test('clearStatuses: removes every instance and zeroes the bitfield', () => {
  const actor = makeActor();
  applyStatus(actor, { status: 'burning', step: 0, sourceId: 1, magnitude: 5, duration: 3.0 });
  applyStatus(actor, { status: 'chilled', step: 0, sourceId: 1, magnitude: 30, duration: 2.0 });
  applyStatus(actor, { status: 'shocked', step: 0, sourceId: 1, magnitude: 15, duration: 2.0 });

  clearStatuses(actor, false);

  assert.equal(actor.statuses.length, 0);
  assert.equal(actor.statusMask, 0);
});

// ---------------------------------------------------------------------------
// The 24-instance overflow cap — a documented finding, not a fabricated test
// ---------------------------------------------------------------------------
//
// `insertNewInstance` (and therefore `evictForOverflow`) only ever runs on a
// status's FIRST application, or while an independent-stack status is below
// its own `maxStacks`. With today's ten-status table that ceiling is fixed:
// 8 single-instance statuses (chilled/frozen/poisoned/shocked/stunned/
// slowed/blinded/cursed) + burning's 3 + bleeding's 5 = 16. Once all ten are
// present and both independents are maxed, every further `applyStatus` call
// — for ANY status — routes through refresh / replace-if-greater / additive
// stacks / independent-at-cap-replace, none of which grow `actor.statuses`.
// So the 24-cap can never be reached through legitimate stacking today; the
// eviction logic itself (earliest-`expiresStep`, boss-actor refusal) is
// implemented per `01 §7.1` and hand-reviewed, but genuinely unexercised —
// see this ticket's report for why forcing a synthetic 24-instance array was
// rejected (it requires either non-pool-backed filler objects, which risk
// corrupting this file's shared module-level instance pool across the rest
// of this test file, or a test-only seam added to status.js purely to
// defeat its own real cap). This test proves the 16-instance ceiling holds.

test('overflow ceiling: with all 10 statuses present and both independents maxed, no further application ever grows the array past 16', () => {
  const actor = makeActor({ rank: 'normal' });
  let src = 0;
  for (let i = 0; i < 3; i++) applyStatus(actor, { status: 'burning', step: 0, sourceId: src++, magnitude: 1, duration: 100 + i });
  for (let i = 0; i < 5; i++) applyStatus(actor, { status: 'bleeding', step: 0, sourceId: src++, magnitude: 1, duration: 100 + i });
  for (const status of ['chilled', 'frozen', 'poisoned', 'shocked', 'stunned', 'slowed', 'blinded', 'cursed']) {
    applyStatus(actor, { status, step: 0, sourceId: src++, magnitude: 10, duration: 100 });
  }
  assert.equal(actor.statuses.length, 16, "the real ceiling given today's status table");

  for (const status of STATUS_ORDER) {
    applyStatus(actor, { status, step: 1, sourceId: src++, magnitude: 5, duration: 50 });
    assert.equal(actor.statuses.length, 16, `re-applying ${status} never grows past the 16-instance ceiling`);
  }
});

// ---------------------------------------------------------------------------
// isActionLockedByStatus — closes ACTR-9's canAct gap
// ---------------------------------------------------------------------------

test('isActionLockedByStatus: true while frozen or stunned, false otherwise', () => {
  const actor = makeActor();
  assert.equal(isActionLockedByStatus(actor), false);
  applyStatus(actor, { status: 'chilled', step: 0, sourceId: 1, magnitude: 30, duration: 2.0 });
  assert.equal(isActionLockedByStatus(actor), false, 'chilled alone does not lock actions');
  applyStatus(actor, { status: 'frozen', step: 0, sourceId: 1, magnitude: 0, duration: 1.2 });
  assert.equal(isActionLockedByStatus(actor), true);
  removeStatus(actor, 'frozen');
  assert.equal(isActionLockedByStatus(actor), false);
  applyStatus(actor, { status: 'stunned', step: 0, sourceId: 1, magnitude: 0, duration: 1.0 });
  assert.equal(isActionLockedByStatus(actor), true);
  assert.equal(ACTION_LOCKING_STATUS_MASK, STATUS_BIT.frozen | STATUS_BIT.stunned);
});
