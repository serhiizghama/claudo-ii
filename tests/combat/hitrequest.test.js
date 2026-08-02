// tests/combat/hitrequest.test.js
//
// CMBT-8 / D-51 acceptance tests for Defect B: the pooled-object leak on the
// sanctioned `combat:hit-request` path (src/combat/packet.js#_onHitRequest).
//
// THIS FILE'S OWN GATE (this ticket's brief, verbatim): "400+ hit-requests
// through combat:hit-request all resolve — no silent drop at 257,
// actor:damage count equals the number of landed requests. Prove it at
// 1000." Plus the ownership rule this ticket settled on: the REQUESTER owns
// the packet (never released by `_onHitRequest`), and `_onHitRequest`
// supplies its own permanent scratch `DamageResult` to `resolve()` so this
// path never draws from `_resultPool` at all.
//
// Not this file's: everything R14(d)/(f) computes (onhit.test.js), R1-R13
// mitigation math (resolve.test.js), R14(g)/(h) (reaction.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { CombatSystem, PACKET_POOL_CAPACITY } from '../../src/combat/packet.js';
import { RESULT_POOL_CAPACITY } from '../../src/combat/resolve.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats } from '../../src/actors/stats.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

let nextPoolIndex = 0;
let nextActorId = 1;

function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex++);
  actor.id = overrides.id ?? nextActorId++;
  actor.active = true;
  actor.generation = 0;
  actor.kind = overrides.kind ?? 'player';
  actor.classId = overrides.classId ?? 'ravager';
  actor.level = overrides.level ?? 10;
  actor.team = overrides.team ?? 0;
  actor.dead = false;
  composeStats(actor);
  if (overrides.life != null) actor.life = overrides.life;
  actor.stats.maxLife = 1_000_000;
  actor.life = 1_000_000;
  return actor;
}

/** Real `CombatSystem.init()`, wired to a real `EventBus`, with a minimal
 * stub `actors` system (`resolve(ref)` — the only method `resolve()` itself
 * calls on it) — the same stub shape `tests/combat/onhit.test.js`'s own
 * end-to-end test already establishes.
 */
async function makeCombat(actorsById) {
  const events = new EventBus();
  const actorsSystemStub = { resolve(ref) { return actorsById.get(ref.id) || null; } };
  const combat = new CombatSystem();
  const ctx = {
    rng: new Rng(0xC0FFEE),
    events,
    time: { step: 0 },
    get(id) { if (id === 'actors') return actorsSystemStub; throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };
  await combat.init(ctx);
  return { combat, ctx, events };
}

/** A hit that always lands: `attackRating = 0` bypasses R2 entirely ("not a
 * 95% cap, an unconditional bypass" — tohit.js's own header), and
 * `dodgeable`/`blockable` both `false` skip R3/R4. Deterministic regardless
 * of the RNG stream, so this file's counts are exact, not probabilistic. */
function fillGuaranteedHitPacket(packet, source) {
  packet.sourceId = source.id;
  packet.sourceGen = source.generation;
  packet.team = source.team;
  packet.attackRating = 0;
  packet.attackerLevel = source.level;
  packet.blockable = false;
  packet.dodgeable = false;
  packet.critChance = 0;
  packet.critMult = 100;
  packet.physMin = 5;
  packet.physMax = 5;
}

// ---------------------------------------------------------------------------
// The core acceptance criterion — 1000 hit-requests, none silently dropped
// ---------------------------------------------------------------------------

test('combat:hit-request: 1000 requests (well past the old 256-request ceiling) all resolve — actor:damage fires exactly once per request, none silently dropped', async () => {
  const attacker = makeActor({ id: 1, team: 0 });
  const target = makeActor({ id: 2, team: 1 });
  const actorsById = new Map([[attacker.id, attacker], [target.id, target]]);
  const { combat, events } = await makeCombat(actorsById);

  let damageEvents = 0;
  events.on('actor:damage', () => { damageEvents++; });

  const N = 1000;
  for (let i = 0; i < N; i++) {
    const packet = combat.buildAttackPacket(attacker, 'attack', 0);
    assert.ok(packet, `packet pool must not be exhausted at request #${i} — the requester releases its own packet every iteration`);
    fillGuaranteedHitPacket(packet, attacker);
    events.emit('combat:hit-request', { source: attacker, target, packet });
    combat.releasePacket(packet); // the REQUESTER's job — see packet.js's ownership-rule comment
  }

  assert.equal(damageEvents, N, `every one of ${N} requests must have resolved and emitted actor:damage — the old bug silently dropped everything after #256`);
});

test('combat:hit-request: 400 requests specifically past the OLD 256-request ceiling still resolve (this ticket\'s own reproduction number)', async () => {
  const attacker = makeActor({ id: 10, team: 0 });
  const target = makeActor({ id: 11, team: 1 });
  const actorsById = new Map([[attacker.id, attacker], [target.id, target]]);
  const { combat, events } = await makeCombat(actorsById);

  let damageEvents = 0;
  events.on('actor:damage', () => { damageEvents++; });

  const N = 400;
  for (let i = 0; i < N; i++) {
    const packet = combat.buildAttackPacket(attacker, 'attack', 0);
    fillGuaranteedHitPacket(packet, attacker);
    events.emit('combat:hit-request', { source: attacker, target, packet });
    combat.releasePacket(packet);
  }

  assert.equal(damageEvents, N);
  // eslint-disable-next-line no-console
  console.log(`combat:hit-request x${N}: actor:damage events seen = ${damageEvents} (expected ${N}) — no drop at #257`);
});

// ---------------------------------------------------------------------------
// Packet ownership — the requester owns it; `_onHitRequest` never touches it
// ---------------------------------------------------------------------------

test('combat:hit-request: the listener never releases the packet — its fields survive the emit, untouched, for the requester to reuse or release itself', async () => {
  const attacker = makeActor({ id: 20, team: 0 });
  const target = makeActor({ id: 21, team: 1 });
  const actorsById = new Map([[attacker.id, attacker], [target.id, target]]);
  const { combat, events } = await makeCombat(actorsById);

  const packet = combat.buildAttackPacket(attacker, 'attack', 0);
  fillGuaranteedHitPacket(packet, attacker);
  const snapshot = { physMin: packet.physMin, physMax: packet.physMax, attackRating: packet.attackRating, sourceId: packet.sourceId };

  events.emit('combat:hit-request', { source: attacker, target, packet });

  assert.equal(packet.physMin, snapshot.physMin, 'a packet field a caller set before emit must still read back the same value after — release() would have zeroed it');
  assert.equal(packet.physMax, snapshot.physMax);
  assert.equal(packet.attackRating, snapshot.attackRating);
  assert.equal(packet.sourceId, snapshot.sourceId);

  combat.releasePacket(packet); // now the caller's own, explicit release
});

test('combat:hit-request: ONE packet reused across several requests (a cone/nova\'s own shape) resolves every target correctly — the listener never zeroes it out from under the loop', async () => {
  const attacker = makeActor({ id: 30, team: 0 });
  const targets = [31, 32, 33, 34].map((id) => makeActor({ id, team: 1 }));
  const actorsById = new Map([[attacker.id, attacker], ...targets.map((t) => [t.id, t])]);
  const { combat, events } = await makeCombat(actorsById);

  const packet = combat.buildAttackPacket(attacker, 'cleaving_strike', 1);
  fillGuaranteedHitPacket(packet, attacker);

  const lifeBefore = targets.map((t) => t.life);
  for (const t of targets) {
    events.emit('combat:hit-request', { source: attacker, target: t, packet });
  }
  combat.releasePacket(packet); // once, after the whole loop — cleaving_strike.js's own pattern

  targets.forEach((t, i) => {
    assert.ok(t.life < lifeBefore[i], `target #${t.id} must have taken real damage — a packet zeroed mid-loop would resolve every hit after the first as 0 physMin/physMax`);
  });
});

// ---------------------------------------------------------------------------
// Result ownership — the listener supplies its own scratch, never leaks
// ---------------------------------------------------------------------------

test('combat:hit-request: direct combat.resolve() calls (no `out`) still work after init() reserves one permanent scratch DamageResult for the event path', async () => {
  const attacker = makeActor({ id: 40, team: 0 });
  const target = makeActor({ id: 41, team: 1 });
  const actorsById = new Map([[attacker.id, attacker], [target.id, target]]);
  const { combat } = await makeCombat(actorsById);

  const packet = combat.buildAttackPacket(attacker, 'attack', 0);
  fillGuaranteedHitPacket(packet, attacker);
  const result = combat.resolve(packet, target); // no `out` — draws from _resultPool directly
  assert.ok(result, 'resolve() must still succeed via the pool for a direct (non-event) caller');
  assert.equal(result.outcome, 'hit');
  combat.releasePacket(packet);
});

test('RESULT_POOL_CAPACITY / PACKET_POOL_CAPACITY sanity — both still 256, matching 01-data-model.md §11.1', () => {
  assert.equal(RESULT_POOL_CAPACITY, 256);
  assert.equal(PACKET_POOL_CAPACITY, 256);
});
