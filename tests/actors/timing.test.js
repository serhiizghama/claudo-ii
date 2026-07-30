// tests/actors/timing.test.js
//
// ACTR-14 acceptance tests for src/actors/timing.js.
// `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// Scope: `onAttackStart` (the absolute-tick §6.1 decomposition, plus the
// §6.2 Maulsmith wind-up floor) and `advanceAndEmitHitframe` (the
// `anim:hitframe`-exactly-once glue). NOT tested here (O-27): real
// `combat:hit-request` emission (ai/skills, not built), `index.js` wiring
// (not this ticket's file — see the report).
//
// THIS FILE'S ACCEPTANCE GATE (per the ticket):
//   1. wind-up / active / recovery sum to the interval — the tick identity
//      `endTick - tick0 === windTicks + activeTicks + recTicks` (and
//      `hitTick - tick0 === windTicks`), for every §6.2 worked case.
//   2. `active` is never scaled by IAS — held at exactly 6 ticks across
//      three different IAS values on the same attack.
//   3. `anim:hitframe` fires exactly once — normal completion, a frame that
//      runs two fixed steps, and a cancellation during wind-up (zero
//      emissions).
// Also covered: the printed numbers rule 12 asks for, and cross-checking
// three of the five cases against `./action.js#beginAction`'s own internal
// tick counts (ACTR-9, already accepted) to show the two independent
// implementations of `08 §6.1` agree.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord } from '../../src/actors/pool.js';
import { beginAction, cancelAction, advanceAction } from '../../src/actors/action.js';
import { ACTOR_STATE, ACTION_PHASE } from '../../src/actors/data/states.js';
import { onAttackStart, advanceAndEmitHitframe } from '../../src/actors/timing.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** `08 §6.3`'s attack-table rows this ticket's worked examples (`08 §6.2`)
 * use. Plain local fixtures, not a real data table — the real attack table
 * belongs to whichever subsystem owns skill/monster data (out of this
 * ticket's reading window, see `timing.js`'s header). */
const RAVAGER_1H = Object.freeze({ W: 0.28, S: 0.10, R: 0.22 });
const MAULSMITH_SLAM = Object.freeze({ W: 1.20, S: 0.14, R: 0.85 });
/** Same attack, with `08 §6.2`'s "floored at 0.90 s" wind-up as a data field. */
const MAULSMITH_SLAM_FLOORED = Object.freeze({ ...MAULSMITH_SLAM, windupFloorSeconds: 0.90 });

/** `08 §6.2`'s worked table, verbatim inputs, with the tick counts this
 * ticket derived and cross-checked (see the header comment above the test
 * below) — NOT the doc's own printed seconds `total` column, which is a
 * continuous-algebra figure (`(W+R)*mult+S`) that does not always equal
 * `sum(ticks)/60` once wind-up and recovery round independently (see
 * `timing.js`'s header, "Maulsmith wind-up floor" section). `skipTotal`
 * marks the one row (O-45) whose printed total does not follow from its own
 * inputs under any reading — this file asserts its tick arithmetic only. */
const CASES = [
  {
    name: 'Ravager 1H, base',
    attack: RAVAGER_1H, ias: 0,
    expect: { windTicks: 17, activeTicks: 6, recTicks: 13, hitTick: 17, endTick: 36 },
  },
  {
    name: 'Ravager 1H, +60% IAS',
    attack: RAVAGER_1H, ias: 60,
    expect: { windTicks: 11, activeTicks: 6, recTicks: 8, hitTick: 11, endTick: 25 },
  },
  {
    name: 'Ravager 1H, +160% IAS',
    attack: RAVAGER_1H, ias: 160,
    expect: { windTicks: 6, activeTicks: 6, recTicks: 5, hitTick: 6, endTick: 17 },
  },
  {
    name: 'Maulsmith slam, base',
    attack: MAULSMITH_SLAM, ias: 0,
    expect: { windTicks: 72, activeTicks: 8, recTicks: 51, hitTick: 72, endTick: 131 },
  },
  {
    name: 'Maulsmith slam, Extra Fast +45% (wind-up floored at 0.90 s)',
    attack: MAULSMITH_SLAM_FLOORED, ias: 45,
    expect: { windTicks: 54, activeTicks: 8, recTicks: 35, hitTick: 54, endTick: 97 },
    skipTotal: true, // O-45 — the doc's own printed seconds total for this row does not follow from its inputs
  },
];

let nextPoolIndex = 0;

/** Same stand-in style `tests/actors/action.test.js#makeActor` uses — a
 * live `Actor` record with a hand-built `StatBlock`, distinct `poolIndex`
 * per call so independent test actors never alias the same scratch slot in
 * either `action.js` or `timing.js`. */
function makeActor(ias = 0) {
  const actor = createActorRecord(nextPoolIndex++);
  actor.state = ACTOR_STATE.idle;
  actor.stats = { increasedAttackSpeed: ias };
  actor.statsDirty = false;
  return actor;
}

function makeEvents() {
  return { emitted: [], emit(event, payload) { this.emitted.push({ event, payload }); } };
}

// ---------------------------------------------------------------------------
// 1/2. §6.2's five worked cases — tick counts, the sum-to-interval identity,
//      "active never scales", and rule 12's "print the numbers"
// ---------------------------------------------------------------------------

test('08 §6.2: five worked cases — tick counts, printed numbers, sum-to-interval identity', () => {
  const tick0 = 0;
  for (const { name, attack, ias, expect, skipTotal } of CASES) {
    const result = onAttackStart(tick0, attack, ias);
    const totalSeconds = (result.endTick - tick0) / 60;

    console.log(
      `[08 §6.2] ${name}: windTicks=${result.windTicks} activeTicks=${result.activeTicks} ` +
      `recTicks=${result.recTicks} hitTick=${result.hitTick} endTick=${result.endTick} ` +
      `total=${totalSeconds.toFixed(3)}s${skipTotal ? ' (O-45: not asserted against doc total)' : ''}`,
    );

    assert.equal(result.windTicks, expect.windTicks, `${name}: windTicks`);
    assert.equal(result.activeTicks, expect.activeTicks, `${name}: activeTicks`);
    assert.equal(result.recTicks, expect.recTicks, `${name}: recTicks`);
    assert.equal(result.hitTick, expect.hitTick, `${name}: hitTick`);
    assert.equal(result.endTick, expect.endTick, `${name}: endTick`);

    // Criterion #1: wind-up / active / recovery sum to the interval.
    assert.equal(result.hitTick - tick0, result.windTicks, `${name}: hitTick - tick0 === windTicks`);
    assert.equal(
      result.endTick, result.hitTick + result.activeTicks + result.recTicks,
      `${name}: endTick === hitTick + activeTicks + recTicks`,
    );
  }
});

test('08 §6.2: activeTicks is identical across every IAS value tested on the same attack (criterion #2)', () => {
  const ticks = CASES.slice(0, 3).map(({ attack, ias }) => onAttackStart(0, attack, ias).activeTicks);
  console.log(`[08 §6.2] Ravager 1H activeTicks @ IAS 0/60/160: ${ticks.join(' / ')}`);
  assert.equal(ticks[0], 6);
  assert.equal(ticks[1], 6);
  assert.equal(ticks[2], 6);
});

test('08 §6.1: activeTicks never scales, swept across a wider IAS range on a different attack', () => {
  const iasValues = [0, 40, 100, 160, 300];
  const activeTicksSeen = iasValues.map((ias) => onAttackStart(1000, MAULSMITH_SLAM, ias).activeTicks);
  console.log(`[08 §6.1] Maulsmith activeTicks @ IAS ${iasValues.join('/')}: ${activeTicksSeen.join(' / ')}`);
  for (const a of activeTicksSeen) assert.equal(a, 8, 'S=0.14s -> round(0.14*60)=8 ticks, regardless of IAS');
});

test('08 §6.1: tick0 is honoured as an absolute step, not assumed to be 0', () => {
  const result = onAttackStart(12345, RAVAGER_1H, 0);
  assert.equal(result.hitTick, 12345 + 17);
  assert.equal(result.endTick, 12345 + 36);
});

// ---------------------------------------------------------------------------
// Agreement with ACTR-9 — `./action.js#beginAction`/`advanceAction` already
// implement `08 §6.1` internally (actor-relative ticks); step the real FSM
// and confirm it produces the same windTicks/activeTicks/recTicks this
// file's independent `onAttackStart` computes for the same inputs.
// ---------------------------------------------------------------------------

/** Steps `advanceAction` one tick at a time until the actor's action
 * completes, recording how many ticks were spent in each phase (keyed by
 * `ACTION_PHASE`). Bounded by a generous guard so a real bug here fails
 * loudly rather than hanging the test run. */
function deriveTicksViaActionFSM(actor) {
  const ticksByPhase = {};
  let phaseStartTick = 0;
  let t = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    if (actor.actionId === null) break;
    const beforePhase = actor.actionPhase;
    const transition = advanceAction(actor);
    t++;
    if (transition) {
      ticksByPhase[beforePhase] = t - phaseStartTick;
      phaseStartTick = t;
    }
    if (actor.actionId === null) break;
  }
  return ticksByPhase;
}

test('agrees with ACTR-9: action.js#beginAction produces the same tick counts as onAttackStart, for all three Ravager IAS cases', () => {
  for (const { name, ias, expect } of CASES.slice(0, 3)) {
    const actor = makeActor(ias);
    beginAction(actor, 'ravager_1h_swing', RAVAGER_1H.W, RAVAGER_1H.S, RAVAGER_1H.R);
    const viaFSM = deriveTicksViaActionFSM(actor);
    console.log(`[agrees-with-ACTR-9] ${name}: FSM windTicks=${viaFSM[ACTION_PHASE.windup]} ` +
      `activeTicks=${viaFSM[ACTION_PHASE.active]} recTicks=${viaFSM[ACTION_PHASE.recover]}`);
    assert.equal(viaFSM[ACTION_PHASE.windup], expect.windTicks, `${name}: action.js windTicks`);
    assert.equal(viaFSM[ACTION_PHASE.active], expect.activeTicks, `${name}: action.js activeTicks`);
    assert.equal(viaFSM[ACTION_PHASE.recover], expect.recTicks, `${name}: action.js recTicks`);
  }
});

// ---------------------------------------------------------------------------
// 3. `anim:hitframe` fires exactly once (criterion #3)
// ---------------------------------------------------------------------------

/** Drives `advanceAndEmitHitframe` `ticksPerCall` times per outer "frame"
 * iteration, until the actor's action fully completes — `ticksPerCall: 2`
 * models a rendered frame that runs two fixed steps (`MAX_SUBSTEPS`,
 * ARCHITECTURE.md). */
function runUntilIdle(actor, events, ticksPerCall) {
  for (let guard = 0; guard < 10_000; guard++) {
    if (actor.actionId === null) return;
    for (let i = 0; i < ticksPerCall && actor.actionId !== null; i++) {
      advanceAndEmitHitframe(actor, events);
    }
  }
  throw new Error('runUntilIdle: exceeded guard — possible infinite loop in the FSM under test');
}

test('anim:hitframe fires exactly once over a full action (one fixed step per call)', () => {
  const actor = makeActor(0);
  const events = makeEvents();
  const seq = beginAction(actor, 'ravager_1h_swing', RAVAGER_1H.W, RAVAGER_1H.S, RAVAGER_1H.R);

  runUntilIdle(actor, events, 1);

  assert.equal(events.emitted.length, 1, 'anim:hitframe must fire exactly once for the whole action');
  assert.equal(events.emitted[0].event, 'anim:hitframe');
  assert.deepEqual(events.emitted[0].payload, { actor, actionId: 'ravager_1h_swing', actionSeq: seq });
});

test('anim:hitframe fires exactly once when a frame runs two fixed steps (does not double-fire)', () => {
  const actor = makeActor(0);
  const events = makeEvents();
  beginAction(actor, 'ravager_1h_swing', RAVAGER_1H.W, RAVAGER_1H.S, RAVAGER_1H.R);

  runUntilIdle(actor, events, 2); // two advanceAndEmitHitframe calls per "frame"

  assert.equal(events.emitted.length, 1, 'two-steps-per-frame must still emit exactly one hitframe for the action');
});

test('anim:hitframe fires exactly once when the windup->active boundary lands on the second of two per-frame steps', () => {
  // windTicks floors at 2 (windup=0), so a 2-ticks-per-frame loop crosses the
  // boundary exactly on the second call of the very first "frame" — the
  // tightest version of the two-steps-in-one-frame case.
  const actor = makeActor(0);
  const events = makeEvents();
  beginAction(actor, 'instant_swing', 0, 0.10, 0.10); // windTicks=2, activeTicks=6, recTicks=6

  runUntilIdle(actor, events, 2);

  assert.equal(events.emitted.length, 1);
});

test('anim:hitframe does not fire at all when the action is cancelled during wind-up (08 §6.6)', () => {
  const actor = makeActor(0);
  const events = makeEvents();
  beginAction(actor, 'ravager_1h_swing', RAVAGER_1H.W, RAVAGER_1H.S, RAVAGER_1H.R); // windTicks=17

  for (let i = 0; i < 5; i++) advanceAndEmitHitframe(actor, events); // partway through windup, well before tick 17
  const cancelled = cancelAction(actor, 'hitstun');
  assert.equal(cancelled, true, 'precondition: cancelAction must succeed during windup');

  // Keep driving — a buggy implementation might still fire on some later
  // call if it didn't actually stop tracking the (now-defunct) action.
  for (let i = 0; i < 30; i++) advanceAndEmitHitframe(actor, events);

  assert.equal(events.emitted.length, 0, 'a stun during wind-up cancels with no hit emitted — 08 §6.6, verbatim');
});

test('anim:hitframe fires once per action — a second action on the same actor emits again, with the new actionSeq', () => {
  const actor = makeActor(0);
  const events = makeEvents();

  const seq1 = beginAction(actor, 'ravager_1h_swing', RAVAGER_1H.W, RAVAGER_1H.S, RAVAGER_1H.R);
  runUntilIdle(actor, events, 1);
  assert.equal(events.emitted.length, 1);
  assert.equal(events.emitted[0].payload.actionSeq, seq1);

  const seq2 = beginAction(actor, 'ravager_1h_swing', RAVAGER_1H.W, RAVAGER_1H.S, RAVAGER_1H.R);
  assert.notEqual(seq2, seq1, 'precondition: beginAction bumps actionSeq for the new action');
  runUntilIdle(actor, events, 1);

  assert.equal(events.emitted.length, 2, 'the second action must also emit its own hitframe, exactly once');
  assert.equal(events.emitted[1].payload.actionSeq, seq2);
});

test('anim:hitframe is a no-op on an actor with no action in progress', () => {
  const actor = makeActor(0);
  const events = makeEvents();
  assert.equal(actor.actionId, null, 'precondition: fresh actor has no action');

  const transition = advanceAndEmitHitframe(actor, events);

  assert.equal(transition, null);
  assert.equal(events.emitted.length, 0);
});
