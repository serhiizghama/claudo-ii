// tests/actors/action.test.js
//
// ACTR-9 acceptance tests for src/actors/action.js + src/actors/data/states.js.
// `node:test` + `node:assert/strict` only (12-testing.md P6, same as every
// other `tests/actors/*.test.js`).
//
// Scope: the six `02-api-contracts.md` "Action state machine" methods
// (`setState`/`beginAction`/`cancelAction`/`canAct`/`canMove`/
// `actionProgress`) plus the internal `advanceAction` engine this file's
// sibling exports for `src/actors/index.js`'s eventual `fixedUpdate` wiring
// (not built — ACTR-9's own file list does not include `index.js`; see the
// report). `canAct`'s `frozen`/`stunned` STATUS-bit half was originally a
// documented, flagged gap (this ticket's granted reading window did not
// cover `01-data-model.md`'s `STATUS_BIT` table) — ACTR-10 has since landed
// `src/actors/status.js#isActionLockedByStatus`, `canAct` now imports and
// ANDs it in, and the "both halves" test below covers it. NOT tested here
// (O-27 — do not assert on the absence of a later ticket): real
// `anim:hitframe`/`combat:hit-request` emission (combat/skills, not built),
// `applyImpulse` actually driving an actor into `knockback` (motion.js,
// not built either).
//
// THIS FILE'S ACCEPTANCE GATE (per the ticket):
//   1. `setState` returns `false` (never throws) on an illegal transition
//      in a normal build, and the dev-throw is opt-in only.
//   2. The `actionSeq` staleness contract: a hit carrying a captured,
//      now-stale `actionSeq` is dropped; one carrying the current value is
//      accepted. There is no dedicated "is-stale" export — the contract is
//      the raw `actor.actionSeq === capturedSeq` comparison any future
//      caller (combat) will make directly; this file's tests perform that
//      same comparison themselves rather than inventing a helper this
//      ticket has no `02-api-contracts.md` row for.
// Also covered, since the ticket asks for the tick maths and the adjacency
// table to be demonstrated, not just asserted: the `08 §6.1` tick formula
// (including "active is never scaled by IAS"), the full wind-up -> active
// -> recover -> idle progression via `advanceAction`, and the `recover`
// "accepted from 75 %" input-cancel carve-out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord } from '../../src/actors/pool.js';
import {
  setState,
  beginAction,
  cancelAction,
  canAct,
  canMove,
  actionProgress,
  advanceAction,
  DEV_MODE,
} from '../../src/actors/action.js';
import { ACTOR_STATE } from '../../src/actors/data/states.js';
import { STATUS_BIT } from '../../src/actors/status.js';

let nextPoolIndex = 0;

/** A live `Actor` record with a hand-built, already-composed `StatBlock` —
 * same stand-in style `tests/actors/vessels.test.js#makeActor` uses, for
 * the same reason: this file's logic does not depend on HOW a `StatBlock`
 * was composed, only on `increasedAttackSpeed` being readable off it. Each
 * call gets a distinct `poolIndex` (mirroring the real pool's own
 * one-slot-per-live-actor invariant) so independent test actors never
 * alias the same schedule-scratch slot in `action.js`.
 * @param {object} [overrides]
 */
function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex++);
  actor.state = overrides.state ?? ACTOR_STATE.idle;
  actor.dead = overrides.dead ?? false;
  actor.stats = { increasedAttackSpeed: overrides.ias ?? 0 };
  actor.statsDirty = false;
  return actor;
}

// ---------------------------------------------------------------------------
// 1. setState — legal/illegal transitions, false-not-throw, dev-throw opt-in
// ---------------------------------------------------------------------------

test('setState: spawning -> idle is the only legal exit from spawning', () => {
  const actor = makeActor({ state: ACTOR_STATE.spawning });
  assert.equal(setState(actor, ACTOR_STATE.hitstun), false);
  assert.equal(actor.state, ACTOR_STATE.spawning); // rejected transition left state untouched
  assert.equal(setState(actor, ACTOR_STATE.idle), true);
  assert.equal(actor.state, ACTOR_STATE.idle);
});

test('setState: illegal transition returns false in a normal build, never throws', () => {
  const actor = makeActor({ state: ACTOR_STATE.dead });
  assert.equal(DEV_MODE.throwOnIllegalTransition, false, 'precondition: dev-throw must default off');
  assert.doesNotThrow(() => {
    const ok = setState(actor, ACTOR_STATE.idle);
    assert.equal(ok, false);
  });
  assert.equal(actor.state, ACTOR_STATE.dead, '"dead" is terminal except for -> despawning');
});

test('setState: dead is terminal — only despawning is a legal exit', () => {
  const actor = makeActor({ state: ACTOR_STATE.dead });
  assert.equal(setState(actor, ACTOR_STATE.spawning), false);
  assert.equal(setState(actor, ACTOR_STATE.idle), false);
  assert.equal(setState(actor, ACTOR_STATE.despawning), true);
  assert.equal(actor.state, ACTOR_STATE.despawning);
});

test('setState: despawning has zero legal setState exits', () => {
  const actor = makeActor({ state: ACTOR_STATE.despawning });
  for (const s of Object.values(ACTOR_STATE)) {
    if (s === ACTOR_STATE.despawning) continue;
    assert.equal(setState(actor, s), false, `despawning -> ${s} must be illegal`);
  }
});

test('setState: windup is cancellable by hitstun only — not by knockback', () => {
  const actor = makeActor({ state: ACTOR_STATE.windup });
  assert.equal(setState(actor, ACTOR_STATE.knockback), false, '01 §1.4: windup cancellable by hitstun only');
  assert.equal(setState(actor, ACTOR_STATE.recover), false, 'must progress through active first');
  assert.equal(setState(actor, ACTOR_STATE.hitstun), true);
});

test('setState: windup -> dead is legal (death is a universal override, not a §6.6 combat interrupt)', () => {
  const actor = makeActor({ state: ACTOR_STATE.windup });
  assert.equal(setState(actor, ACTOR_STATE.dead), true);
  assert.equal(actor.dead, true, 'setState syncs the actor.dead boolean on entering dead');
});

test('setState: active can be truncated by knockback (symmetry with hitstun)', () => {
  const actor = makeActor({ state: ACTOR_STATE.active });
  assert.equal(setState(actor, ACTOR_STATE.knockback), true);
});

test('setState: channel excluded from movement lock is a canMove concern, not adjacency — channel still reachable from idle/move only', () => {
  const fromIdle = makeActor({ state: ACTOR_STATE.idle });
  assert.equal(setState(fromIdle, ACTOR_STATE.channel), true);
  const fromWindup = makeActor({ state: ACTOR_STATE.windup });
  assert.equal(setState(fromWindup, ACTOR_STATE.channel), false);
});

test('setState: reflexive same-state transition is always legal, including for terminal states', () => {
  for (const s of Object.values(ACTOR_STATE)) {
    const actor = makeActor({ state: s });
    assert.equal(setState(actor, s), true, `${s} -> ${s} must be a legal no-op`);
  }
});

test('setState: an unrecognised state string is rejected, not crashed on', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle });
  assert.equal(setState(actor, 'not-a-real-state'), false);
});

test('setState: DEV_MODE.throwOnIllegalTransition is a genuine opt-in, off by default', () => {
  assert.equal(DEV_MODE.throwOnIllegalTransition, false);
  const actor = makeActor({ state: ACTOR_STATE.dead });
  try {
    DEV_MODE.throwOnIllegalTransition = true;
    assert.throws(() => setState(actor, ACTOR_STATE.idle));
  } finally {
    DEV_MODE.throwOnIllegalTransition = false; // never leak dev-mode across tests
  }
  assert.equal(setState(actor, ACTOR_STATE.idle), false, 'still false, not throwing, once toggled back off');
});

// ---------------------------------------------------------------------------
// 2. actionSeq staleness — the acceptance criterion, verbatim scenario
// ---------------------------------------------------------------------------

test('actionSeq: a hit carrying a stale actionSeq is dropped; one carrying the current value is accepted', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle });

  const seq1 = beginAction(actor, 'slash', 0.30, 0.10, 0.30);
  assert.equal(actor.state, ACTOR_STATE.windup);

  // What a future combat resolver would do with a captured actionSeq: compare
  // it against the actor's LIVE actionSeq. No helper needed — see file header.
  const isHitAccepted = (hitSeq) => actor.actionSeq === hitSeq;
  assert.equal(isHitAccepted(seq1), true, 'current seq accepted while the action is still live');

  assert.equal(cancelAction(actor, 'hitstun'), true);
  assert.equal(actor.state, ACTOR_STATE.hitstun);
  assert.notEqual(actor.actionSeq, seq1, 'cancelAction must bump actionSeq');

  assert.equal(isHitAccepted(seq1), false, 'stale hit (captured before the cancel) is dropped');

  // Recover, begin a second action — its hit should be accepted; the first
  // action's stale seq must still never validate again.
  setState(actor, ACTOR_STATE.idle);
  const seq2 = beginAction(actor, 'slash', 0.30, 0.10, 0.30);
  assert.notEqual(seq2, seq1);
  assert.equal(isHitAccepted(seq2), true, 'current seq (from the new action) accepted');
  assert.equal(isHitAccepted(seq1), false, 'old seq remains permanently stale');
});

test('cancelAction: reason is validated — an unknown reason is refused, no mutation', () => {
  const actor = makeActor({ state: ACTOR_STATE.windup });
  const before = actor.actionSeq;
  assert.equal(cancelAction(actor, 'not-a-real-reason'), false);
  assert.equal(actor.actionSeq, before);
  assert.equal(actor.state, ACTOR_STATE.windup);
});

test('cancelAction: reason "interrupt" is refused during windup/active/recover (08 §6.6 only names hitstun/death/input there)', () => {
  for (const state of [ACTOR_STATE.windup, ACTOR_STATE.active, ACTOR_STATE.recover]) {
    const actor = makeActor({ state });
    assert.equal(cancelAction(actor, 'interrupt'), false, `interrupt must be refused during ${state}`);
  }
  const channelling = makeActor({ state: ACTOR_STATE.channel });
  assert.equal(cancelAction(channelling, 'interrupt'), true, 'interrupt is exactly what breaks a channel early');
  assert.equal(channelling.state, ACTOR_STATE.idle);
});

test('cancelAction: reason "input" is ignored during windup and active', () => {
  const duringWindup = makeActor({ state: ACTOR_STATE.windup });
  assert.equal(cancelAction(duringWindup, 'input'), false);
  const duringActive = makeActor({ state: ACTOR_STATE.active });
  assert.equal(cancelAction(duringActive, 'input'), false);
});

test('cancelAction: already-dead/despawning/spawning actors cannot be cancelled further', () => {
  for (const state of [ACTOR_STATE.dead, ACTOR_STATE.despawning, ACTOR_STATE.spawning]) {
    const actor = makeActor({ state });
    assert.equal(cancelAction(actor, 'hitstun'), false, `cancelAction must refuse from ${state}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Tick maths (08 §6.1) — mult computed once, active never scaled
// ---------------------------------------------------------------------------

test('beginAction: tick maths at 0 IAS matches 08 §6.1 exactly', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle, ias: 0 });
  beginAction(actor, 'slash', 1.0, 0.5, 0.5);
  // windTicks = max(2, round(1.0*60*1)) = 60; activeTicks = round(0.5*60) = 30;
  // recTicks = max(1, round(0.5*60*1)) = 30. Verified indirectly via
  // actionProgress's denominator (60+30+30 = 120) since the tick counts are
  // not directly exposed — actionProgress is the documented public window
  // onto them.
  actor.actionTimer = 120;
  assert.equal(actionProgress(actor), 1, 'total = windTicks+activeTicks+recTicks = 120');
});

test('beginAction: active is NEVER scaled by IAS, even at +100% IAS', () => {
  const zero = makeActor({ state: ACTOR_STATE.idle, ias: 0 });
  beginAction(zero, 'slash', 1.0, 0.5, 0.5);
  const hundred = makeActor({ state: ACTOR_STATE.idle, ias: 100 });
  beginAction(hundred, 'slash', 1.0, 0.5, 0.5);

  // mult(ias=100) = 1/(1+1) = 0.5, so windTicks 60->30, recTicks 30->15,
  // but activeTicks stays 30 in both — total: 120 vs 30+30+15=75.
  zero.actionTimer = 120;
  hundred.actionTimer = 75;
  assert.equal(actionProgress(zero), 1);
  assert.equal(actionProgress(hundred), 1);

  // Isolate the claim precisely: advance both by exactly 30 ticks (one full
  // activeTicks' worth) from the start of their respective active phases and
  // confirm active alone still spans 30 ticks regardless of IAS.
  const trackWindup = makeActor({ state: ACTOR_STATE.idle, ias: 100 });
  beginAction(trackWindup, 'slash', 1.0, 0.5, 0.5); // windTicks=30, activeTicks=30, recTicks=15
  for (let i = 0; i < 30; i++) advanceAction(trackWindup); // consume windup exactly
  assert.equal(trackWindup.state, ACTOR_STATE.active, 'windup (mult-scaled) ended at tick 30 as expected');
  for (let i = 0; i < 29; i++) advanceAction(trackWindup); // 29 more ticks, still inside active
  assert.equal(trackWindup.state, ACTOR_STATE.active, 'activeTicks=30 is untouched by ias=100 — one more tick needed');
  advanceAction(trackWindup); // the 30th active tick
  assert.equal(trackWindup.state, ACTOR_STATE.recover, 'active phase lasted exactly 30 ticks, not 15');
});

test('beginAction: windTicks floors at 2, recTicks floors at 1, for a near-zero phase', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle, ias: 0 });
  beginAction(actor, 'tap', 0.001, 0, 0.001);
  // windTicks = max(2, round(0.06)) = max(2,0) = 2; activeTicks = round(0) = 0;
  // recTicks = max(1, round(0.06)) = max(1,0) = 1. total = 3.
  actor.actionTimer = 3;
  assert.equal(actionProgress(actor), 1);
});

// ---------------------------------------------------------------------------
// 4. canAct / canMove across all twelve states
// ---------------------------------------------------------------------------

test('canAct / canMove: matrix across all twelve states', () => {
  const expected = {
    [ACTOR_STATE.spawning]:   { act: false, move: false },
    [ACTOR_STATE.idle]:       { act: true,  move: true },
    [ACTOR_STATE.move]:       { act: true,  move: true },
    [ACTOR_STATE.windup]:     { act: true,  move: false },
    [ACTOR_STATE.active]:     { act: true,  move: false },
    [ACTOR_STATE.recover]:    { act: true,  move: false },
    [ACTOR_STATE.channel]:    { act: true,  move: true },
    [ACTOR_STATE.hitstun]:    { act: false, move: false },
    [ACTOR_STATE.knockback]:  { act: false, move: false },
    [ACTOR_STATE.interact]:   { act: true,  move: false },
    [ACTOR_STATE.dead]:       { act: false, move: false },
    [ACTOR_STATE.despawning]: { act: false, move: false },
  };
  for (const [state, want] of Object.entries(expected)) {
    const actor = makeActor({ state });
    assert.equal(canAct(actor), want.act, `canAct(${state})`);
    assert.equal(canMove(actor), want.move, `canMove(${state})`);
  }
});

test('canAct / canMove: a dead actor is always locked out regardless of a stale state field', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle, dead: true });
  assert.equal(canAct(actor), false);
  assert.equal(canMove(actor), false);
});

test('canAct: frozen and stunned each lock out an otherwise fully actionable actor, via status.js — not a re-declared bit', () => {
  // idle, not dead, no hitstun/knockback/spawning/despawning: canAct's FSM
  // half alone would say true here. Only the STATUS half (ACTR-10's
  // isActionLockedByStatus, imported — see action.js's own header on why
  // this must never become a second hard-coded copy of STATUS_BIT) should
  // flip it to false.
  const frozen = makeActor({ state: ACTOR_STATE.idle });
  assert.equal(canAct(frozen), true, 'precondition: otherwise fully actionable');
  frozen.statusMask |= STATUS_BIT.frozen;
  assert.equal(canAct(frozen), false, 'frozen locks out canAct');
  frozen.statusMask &= ~STATUS_BIT.frozen;
  assert.equal(canAct(frozen), true, 'clearing the status restores true');

  const stunned = makeActor({ state: ACTOR_STATE.idle });
  assert.equal(canAct(stunned), true, 'precondition: otherwise fully actionable');
  stunned.statusMask |= STATUS_BIT.stunned;
  assert.equal(canAct(stunned), false, 'stunned locks out canAct');
  stunned.statusMask &= ~STATUS_BIT.stunned;
  assert.equal(canAct(stunned), true, 'clearing the status restores true');
});

// ---------------------------------------------------------------------------
// 5. advanceAction — the full wind-up -> active -> recover -> idle lifecycle
// ---------------------------------------------------------------------------

test('advanceAction: full lifecycle, tick by tick, actionProgress rising monotonically', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle, ias: 0 });
  // windup=2/60, active=3/60, recover=1/60 -> windTicks=2, activeTicks=3, recTicks=1, total=6.
  const seq = beginAction(actor, 'jab', 2 / 60, 3 / 60, 1 / 60);
  assert.equal(actor.state, ACTOR_STATE.windup);
  assert.equal(actionProgress(actor), 0);

  assert.equal(advanceAction(actor), null, 't=1, still inside windTicks=2');
  assert.equal(actor.state, ACTOR_STATE.windup);
  assert.equal(actionProgress(actor), 1 / 6);

  assert.deepEqual(advanceAction(actor), { from: ACTOR_STATE.windup, to: ACTOR_STATE.active });
  assert.equal(actionProgress(actor), 2 / 6);

  assert.equal(advanceAction(actor), null, 't=3, inside activeTicks window (ends at 5)');
  assert.equal(advanceAction(actor), null, 't=4, still inside activeTicks window');
  assert.equal(actor.state, ACTOR_STATE.active);
  assert.equal(actionProgress(actor), 4 / 6);

  assert.deepEqual(advanceAction(actor), { from: ACTOR_STATE.active, to: ACTOR_STATE.recover });
  assert.equal(actionProgress(actor), 5 / 6);

  assert.deepEqual(advanceAction(actor), { from: ACTOR_STATE.recover, to: ACTOR_STATE.idle });
  assert.equal(actor.actionId, null, 'action bookkeeping cleared on natural completion');
  assert.equal(actionProgress(actor), 0, 'no action in progress once complete');
  assert.equal(actor.actionSeq, seq, 'natural completion does not bump actionSeq — only cancelAction does');
});

test('advanceAction: no-op when the actor has no action in progress', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle });
  assert.equal(actor.actionId, null);
  assert.equal(advanceAction(actor), null);
  assert.equal(actor.state, ACTOR_STATE.idle);
});

// ---------------------------------------------------------------------------
// 6. recover -> windup: "accepted from 75 %" (08 §6.6)
// ---------------------------------------------------------------------------

test('cancelAction("input"): refused below 75% of the whole action, accepted at/after it', () => {
  const actor = makeActor({ state: ACTOR_STATE.idle, ias: 0 });
  // windup=10/60, active=2/60, recover=8/60 -> windTicks=10, activeTicks=2,
  // recTicks=8, total=20. recover begins at t=12 (progress 0.60) and the
  // 0.75 threshold (t=15) falls INSIDE the recover phase, not at its edge —
  // this exercises the threshold itself, not just "recover has started".
  beginAction(actor, 'heavy-swing', 10 / 60, 2 / 60, 8 / 60);
  for (let i = 0; i < 14; i++) advanceAction(actor);
  assert.equal(actor.state, ACTOR_STATE.recover);
  assert.equal(actionProgress(actor), 14 / 20);
  assert.equal(cancelAction(actor, 'input'), false, '0.70 < 0.75 — next attack still ignored');

  advanceAction(actor); // t=15, progress exactly 0.75
  assert.equal(actionProgress(actor), 15 / 20);
  assert.equal(cancelAction(actor, 'input'), true, '>= 0.75 — next attack accepted');
  assert.equal(actor.state, ACTOR_STATE.idle, 'accepted input hands control to idle; caller\'s own beginAction moves to windup');
  assert.equal(actor.actionId, null);
});
