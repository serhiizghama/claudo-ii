// tests/combat/xp.test.js
//
// CMBT-6 acceptance tests for src/combat/xp.js (+ packet.js's wiring of it
// into CombatSystem via a second `actor:damage` listener).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim):
//   1. `actor:death` is emitted ONLY here — see this ticket's report for
//      the `grep -rn "actor:death" src/` proof; the "no other emitter"
//      exclusivity criterion itself is asserted below as "this file's own
//      handler is reachable and firing", not as "nothing else exists yet"
//      (O-27's carve-out, this ticket's own brief).
//   2. `xpForMonster` reproduces `03 §10.5`, and E10's eight rows reproduce
//      exactly (D-11: arithmetic, `xp.test.js`, not `.perf.test.js`).
//
// Not this ticket's: E4/E12/E13 (resolve.js, CMBT-3), E7/E11 (reaction.js,
// CMBT-5), E8 (status.js, CMBT-4), E9 (onhit.js, CMBT-7) — all already
// covered by their own ticket's test file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  XP_MULT_LINEAR,
  XP_MULT_QUADRATIC,
  RANK_XP_MULT,
  DIFFICULTY_XP_MULT,
  DEFAULT_DIFFICULTY,
  LEVEL_PENALTY_FREE_DELTA,
  LEVEL_PENALTY_PER_LEVEL,
  LEVEL_PENALTY_FLOOR,
  xpMultOf,
  levelPenaltyOf,
  rawXpFor,
  xpForMonster,
  awardXp,
  handleActorDamageForDeath,
} from '../../src/combat/xp.js';
import { BASE_RAGE_ON_KILL } from '../../src/combat/onhit.js';
import { CombatSystem, PacketPool } from '../../src/combat/packet.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

const EPS = 1e-9; // integers throughout — 03 §12's 1e-4 tolerance does not apply here (ticket's own note)

function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// Fixtures — same shape tests/combat/onhit.test.js/reaction.test.js already
// established: a real Actor record via createActorRecord + composeStats
// (the NaN trap: composeStats yields NaN in eleven fields if any of
// strength/dexterity/vitality/energy is missing from actor.attributes).
// ---------------------------------------------------------------------------

let nextPoolIndex = 0;
function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex);
  actor.id = overrides.id ?? (nextPoolIndex + 1);
  actor.generation = 0;
  nextPoolIndex++;
  actor.kind = overrides.kind ?? 'monster';
  actor.rank = overrides.rank ?? 'normal';
  actor.classId = overrides.classId ?? null;
  actor.level = overrides.level ?? 10;
  actor.team = overrides.team ?? 1;
  actor.dead = false;
  actor.x = overrides.x ?? 0; actor.y = overrides.y ?? 0; actor.z = overrides.z ?? 0;
  actor.attributes = overrides.attributes ?? { strength: 20, dexterity: 20, vitality: 20, energy: 20 };
  composeStats(actor);
  if (overrides.statOverrides) {
    setSourceLayer(actor, 'equipment', overrides.statOverrides);
    composeStats(actor);
  }
  if (overrides.life != null) actor.life = overrides.life;
  if (overrides.rage != null) actor.rage = overrides.rage;
  if (overrides.baseXp != null) actor.baseXp = overrides.baseXp; // forward-compat field — see xp.js's header
  return actor;
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

function makeEnv(overrides = {}) {
  return {
    actorsSystem: null, world: null, events: null,
    deathPayload: { actor: null, killer: null, point: { x: 0, y: 0, z: 0 } },
    xpGainPayload: { actor: null, amount: 0, source: null },
    ...overrides,
  };
}

function makeActorsSystemStub(actors) {
  return { byId(id) { return actors.find((a) => a.id === id) || null; } };
}

// ---------------------------------------------------------------------------
// Criterion #2 — E10, all eight rows, exact, with raw pre-round values
// printed (rule 12: "make the floor/penalty branches observable")
// ---------------------------------------------------------------------------

test('xpMultOf: 03 §10.1 curve, xpMult(1) = 1.0 (n-1 = 0 collapses both terms)', () => {
  approx(xpMultOf(1), 1.0, 'xpMult(1)');
  approx(xpMultOf(10), 5.176, 'xpMult(10) = 1 + 0.32x9 + 0.016x81');
});

test('levelPenaltyOf: no penalty at or under Δ=4, floor at 0.05, exact 03 §10.5 formula otherwise', () => {
  approx(levelPenaltyOf(10, 10), 1.0, 'Δ=0');
  approx(levelPenaltyOf(14, 10), 1.0, 'Δ=4, still free');
  approx(levelPenaltyOf(16, 6), 0.46, 'Δ=10: 1 - 0.09x6 = 0.46 (E10.4)');
  approx(levelPenaltyOf(30, 1), 0.05, 'Δ=29: 1-0.09x25=-1.25, floored to 0.05 (E10.8)');
  assert.equal(LEVEL_PENALTY_FREE_DELTA, 4);
  assert.equal(LEVEL_PENALTY_PER_LEVEL, 0.09);
  assert.equal(LEVEL_PENALTY_FLOOR, 0.05);
});

test('RANK_XP_MULT / DIFFICULTY_XP_MULT — 03 §10.5/§10.2 tables, verbatim, as data not literals', () => {
  assert.deepEqual(RANK_XP_MULT, { normal: 1.0, minion: 1.5, champion: 3.0, unique: 6.0, boss: 1.0 });
  assert.deepEqual(DIFFICULTY_XP_MULT, { instruction: 1.00, trial: 1.20, renunciation: 1.45 });
  assert.equal(DEFAULT_DIFFICULTY, 'instruction');
});

test('E10: all eight rows reproduce exactly — max(1, round(...)) floor and level-penalty-before-round both visible as real branches', () => {
  const rows = [
    { name: 'E10.1 Bone Ranker mlvl10 normal clvl10 Instruction', mlvl: 10, rank: 'normal', baseXp: 7, clvl: 10, difficulty: 'instruction', expected: 36 },
    { name: 'E10.2 Bone Ranker mlvl10 champion clvl10 Instruction', mlvl: 10, rank: 'champion', baseXp: 7, clvl: 10, difficulty: 'instruction', expected: 109 },
    { name: 'E10.3 Bone Ranker mlvl10 unique clvl10 Instruction', mlvl: 10, rank: 'unique', baseXp: 7, clvl: 10, difficulty: 'instruction', expected: 217 },
    { name: 'E10.4 Bone Ranker mlvl6 normal clvl16 Instruction (penalty 0.46, BEFORE round)', mlvl: 6, rank: 'normal', baseXp: 7, clvl: 16, difficulty: 'instruction', expected: 10 },
    { name: 'E10.5 Molgrim mlvl15 boss clvl13 Instruction', mlvl: 15, rank: 'boss', baseXp: 900, clvl: 13, difficulty: 'instruction', expected: 7754 },
    { name: 'E10.6 Molgrim mlvl27 boss clvl24 Trial', mlvl: 27, rank: 'boss', baseXp: 900, clvl: 24, difficulty: 'trial', expected: 21747 },
    { name: 'E10.7 Molgrim mlvl37 boss clvl30 Renunciation', mlvl: 37, rank: 'boss', baseXp: 900, clvl: 30, difficulty: 'renunciation', expected: 43399 },
    { name: 'E10.8 Bone Ranker mlvl1 normal clvl30 Instruction (max(1,...) floor, raw << 1)', mlvl: 1, rank: 'normal', baseXp: 7, clvl: 30, difficulty: 'instruction', expected: 1 },
  ];

  const lines = ['E10 rows (raw pre-round/pre-floor -> final):'];
  for (const row of rows) {
    const raw = rawXpFor(row.mlvl, row.rank, row.baseXp, row.clvl, row.difficulty);
    const final = xpForMonster(row.mlvl, row.rank, row.baseXp, row.clvl, row.difficulty);
    lines.push(`  ${row.name}: raw=${raw} -> round=${Math.round(raw)} -> max(1,...)=${final} (expected ${row.expected})`);
    assert.equal(final, row.expected, row.name);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));

  // Dedicated branch assertions, per the brief's "must be asserted as such":
  const raw4 = rawXpFor(6, 'normal', 7, 16, 'instruction');
  approx(raw4, 9.66, 'E10.4 raw = 7 x xpMult(6)=3.0 x 0.46 penalty = 9.66');
  assert.equal(Math.round(raw4), 10, 'E10.4: round(9.66) = 10 — the penalty already folded in BEFORE rounding, not after');

  const raw8 = rawXpFor(1, 'normal', 7, 30, 'instruction');
  assert.ok(raw8 < 1, `E10.8: raw (${raw8}) must be < 1 for the max(1,...) floor to be a REAL branch, not a coincidence`);
  approx(raw8, 0.35, 'E10.8 raw = 7 x xpMult(1)=1.0 x 0.05 penalty = 0.35');
  assert.equal(xpForMonster(1, 'normal', 7, 30, 'instruction'), 1, 'E10.8: max(1, round(0.35)=0) = 1 — the floor actually fires');
});

test('xpForMonster: unknown rank/difficulty default to x1.0 rather than throwing/NaN', () => {
  const known = xpForMonster(10, 'normal', 7, 10, 'instruction');
  const unknownRank = xpForMonster(10, 'not-a-rank', 7, 10, 'instruction');
  const unknownDiff = xpForMonster(10, 'normal', 7, 10, 'not-a-difficulty');
  assert.equal(unknownRank, known, 'unknown rank falls back to rankMult=1.0, same as normal');
  assert.equal(unknownDiff, known, 'unknown difficulty falls back to diffMult=1.0, same as instruction');
});

// ---------------------------------------------------------------------------
// Criterion #1 — actor:death / xp:gain, this file's own handler
// ---------------------------------------------------------------------------

test('handleActorDamageForDeath: no-op unless result.killed is true', () => {
  const events = new EventBus();
  let deathCount = 0;
  events.on('actor:death', () => { deathCount++; });
  const target = makeActor({ id: 10 });
  const env = makeEnv({ events, actorsSystem: makeActorsSystemStub([target]) });

  handleActorDamageForDeath({ target, source: null, result: blankResult({ killed: false }) }, env);
  assert.equal(deathCount, 0);
  assert.equal(target.dead, false);
});

test('handleActorDamageForDeath: a genuine kill sets dead/killerId, emits actor:death with { actor, killer, point } once', () => {
  const events = new EventBus();
  const deaths = [];
  events.on('actor:death', (p) => deaths.push({ actor: p.actor, killer: p.killer, x: p.point.x, y: p.point.y, z: p.point.z }));

  const killer = makeActor({ id: 20, kind: 'player', classId: 'ravager', level: 12 });
  const target = makeActor({ id: 21, level: 10, rank: 'normal', baseXp: 7, x: 1, y: 2, z: 3 });
  const env = makeEnv({ events, actorsSystem: makeActorsSystemStub([killer, target]) });

  const result = blankResult({ killed: true, sourceId: killer.id, sourceGen: killer.generation });
  handleActorDamageForDeath({ target, source: killer, result }, env);

  assert.equal(target.dead, true);
  assert.equal(target.killerId, killer.id);
  assert.equal(deaths.length, 1, 'exactly one actor:death emitted');
  assert.equal(deaths[0].actor, target);
  assert.equal(deaths[0].killer, killer);
  assert.equal(deaths[0].x, 1); assert.equal(deaths[0].y, 2); assert.equal(deaths[0].z, 3);
});

test('handleActorDamageForDeath: credits BASE_RAGE_ON_KILL (+8) to the killer, clamped to maxRage', () => {
  const events = new EventBus();
  const killer = makeActor({ id: 30, kind: 'player', classId: 'ravager', level: 10, rage: 0 });
  const target = makeActor({ id: 31, level: 10, rank: 'normal', baseXp: 7 });
  const env = makeEnv({ events, actorsSystem: makeActorsSystemStub([killer, target]) });

  const result = blankResult({ killed: true, sourceId: killer.id });
  handleActorDamageForDeath({ target, source: killer, result }, env);

  assert.equal(killer.rage, Math.min(BASE_RAGE_ON_KILL, killer.stats.maxRage), 'kill-credited rage, clamped to maxRage exactly like onhit.js\'s own addResourceClamped');
  assert.equal(BASE_RAGE_ON_KILL, 8, '03 §2.4: "Kill credited | +8"');
});

test('handleActorDamageForDeath: a non-rage class (maxRage=0) gets a harmless no-op credit, same clamp precedent as onhit.js', () => {
  const events = new EventBus();
  const killer = makeActor({ id: 32, kind: 'player', classId: null, level: 10 }); // ZERO_CLASS -> maxRage 0
  const target = makeActor({ id: 33, level: 10, rank: 'normal', baseXp: 7 });
  const env = makeEnv({ events, actorsSystem: makeActorsSystemStub([killer, target]) });

  assert.equal(killer.stats.maxRage, 0, 'sanity: non-Ravager has maxRage 0');
  handleActorDamageForDeath({ target, source: killer, result: blankResult({ killed: true, sourceId: killer.id }) }, env);
  assert.equal(killer.rage, 0, 'clamped straight back to 0 — no class check needed, per onhit.js\'s own precedent');
});

test('handleActorDamageForDeath: emits xp:gain { actor: killer, amount, source: victim } through awardXp, using env.world.current.difficulty', () => {
  const events = new EventBus();
  const gains = [];
  events.on('xp:gain', (p) => gains.push({ actor: p.actor, amount: p.amount, source: p.source }));

  const killer = makeActor({ id: 40, kind: 'player', level: 10 });
  const target = makeActor({ id: 41, level: 10, rank: 'champion', baseXp: 7 });
  const world = { current: { difficulty: 'instruction' } };
  const env = makeEnv({ events, world, actorsSystem: makeActorsSystemStub([killer, target]) });

  handleActorDamageForDeath({ target, source: killer, result: blankResult({ killed: true, sourceId: killer.id }) }, env);

  assert.equal(gains.length, 1);
  assert.equal(gains[0].actor, killer);
  assert.equal(gains[0].source, target);
  assert.equal(gains[0].amount, xpForMonster(10, 'champion', 7, 10, 'instruction'));
  assert.equal(gains[0].amount, 109, 'E10.2\'s own value, reached through the full death-handler path');
});

test('handleActorDamageForDeath: no resolvable killer (sourceId 0 / unknown) still emits actor:death with killer=null, but no xp:gain', () => {
  const events = new EventBus();
  let deathCount = 0; let xpCount = 0;
  events.on('actor:death', (p) => { deathCount++; assert.equal(p.killer, null); });
  events.on('xp:gain', () => { xpCount++; });

  const target = makeActor({ id: 50, level: 10 });
  const env = makeEnv({ events, actorsSystem: makeActorsSystemStub([target]) }); // no killer in the roster

  handleActorDamageForDeath({ target, source: null, result: blankResult({ killed: true, sourceId: 0 }) }, env);

  assert.equal(deathCount, 1, 'death still happened — environmental/unattributed kills are real deaths');
  assert.equal(xpCount, 0, 'no killer to credit -> no xp:gain (cannot compute clvl without one)');
  assert.equal(target.killerId, 0);
});

// ---------------------------------------------------------------------------
// The double-fire guard — this ticket's own explicit test requirement:
// "an actor already at or below 0 life that takes another hit must not
// emit a second actor:death."
// ---------------------------------------------------------------------------

test('handleActorDamageForDeath: a second "killed" event on an already-dead actor does NOT emit a second actor:death (unit level)', () => {
  const events = new EventBus();
  let deathCount = 0;
  events.on('actor:death', () => { deathCount++; });

  const killer = makeActor({ id: 60, kind: 'player', level: 10 });
  const target = makeActor({ id: 61, level: 10, rank: 'normal', baseXp: 7 });
  const env = makeEnv({ events, actorsSystem: makeActorsSystemStub([killer, target]) });

  handleActorDamageForDeath({ target, source: killer, result: blankResult({ killed: true, sourceId: killer.id }) }, env);
  assert.equal(deathCount, 1);

  // Same target, a second "killed" damage event (e.g. a multi-hit skill's
  // second pellet landing on the same fixed step) — target.dead is already
  // true from the first call.
  handleActorDamageForDeath({ target, source: killer, result: blankResult({ killed: true, sourceId: killer.id }) }, env);
  assert.equal(deathCount, 1, 'no second actor:death for an already-dead target');
});

test('awardXp: killer/victim null -> 0, no throw; missing victim.baseXp defaults to 0 (documented bestiary gap)', () => {
  assert.equal(awardXp(null, makeActor({ id: 70 }), 'instruction', null, null), 0);
  assert.equal(awardXp(makeActor({ id: 71 }), null, 'instruction', null, null), 0);

  const killer = makeActor({ id: 72, level: 10 });
  const victimNoBaseXp = makeActor({ id: 73, level: 10, rank: 'normal' }); // no .baseXp set
  const amount = awardXp(killer, victimNoBaseXp, 'instruction', null, null);
  assert.equal(amount, 1, 'baseXp defaults to 0 -> raw 0 -> max(1, round(0)) floor — see xp.js\'s header on the missing bestiary gap');
});

// ---------------------------------------------------------------------------
// O-51 — the module-graph regression test: import ONLY packet.js
// ---------------------------------------------------------------------------

test('packet.js alone (no xp.js import) wires xpForMonster/awardXp onto CombatSystem, and a real init()-driven kill fires actor:death exactly once end to end', async () => {
  const { CombatSystem: FreshCombatSystem } = await import('../../src/combat/packet.js');
  const combat = new FreshCombatSystem();
  assert.equal(typeof combat.xpForMonster, 'function', 'CombatSystem#xpForMonster must exist once packet.js alone is loaded');
  assert.equal(typeof combat.awardXp, 'function', 'CombatSystem#awardXp must exist once packet.js alone is loaded');

  assert.equal(combat.xpForMonster(10, 'normal', 7, 10, 'instruction'), 36, 'E10.1 through the class method');

  const events = new EventBus();
  const killer = makeActor({ id: 900, kind: 'player', level: 10, team: 0 });
  const target = makeActor({ id: 901, level: 10, rank: 'normal', baseXp: 7 });
  const actorsSystem = makeActorsSystemStub([killer, target]);
  actorsSystem.resolve = (ref) => (ref.id === killer.id ? killer : ref.id === target.id ? target : null);

  const ctx = {
    rng: new Rng(12345),
    events,
    time: { step: 42 },
    get(id) { if (id === 'actors') return actorsSystem; throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };
  await combat.init(ctx);

  const deaths = [];
  const gains = [];
  events.on('actor:death', (p) => deaths.push(p.actor));
  events.on('xp:gain', (p) => gains.push(p.amount));

  const packet = combat.buildAttackPacket(killer, 'attack', 0);
  packet.team = killer.team;
  packet.attackRating = 0; packet.blockable = false; packet.dodgeable = false;
  packet.critChance = 0; packet.critMult = 100;
  packet.physMin = 500; packet.physMax = 500; // a guaranteed overkill

  target.stats.maxLife = 100;
  target.life = 100;

  const result = combat.resolve(packet, target);
  assert.equal(result.outcome, 'hit');
  assert.equal(result.killed, true, 'sanity: this hit actually kills the target');
  assert.equal(target.dead, true);
  assert.equal(deaths.length, 1, 'exactly one actor:death through the real, boot-wired CombatSystem');
  assert.equal(deaths[0], target);
  assert.equal(gains.length, 1, 'exactly one xp:gain');
  assert.equal(gains[0], 36, 'E10.1\'s own value — DEFAULT_DIFFICULTY (no world registered) is instruction');

  // The acceptance criterion's own explicit case: a SECOND hit-request on
  // the now-dead target must not emit a second actor:death. R1's own
  // isValidTarget (resolve.js, already accepted) refuses a `dead` target
  // outright — outcome 'invalid', no event at all — so this proves the
  // guard end to end, not just at the unit level above.
  const packet2 = combat.buildAttackPacket(killer, 'attack', 0);
  packet2.team = killer.team;
  packet2.attackRating = 0; packet2.blockable = false; packet2.dodgeable = false;
  packet2.critChance = 0; packet2.critMult = 100;
  packet2.physMin = 500; packet2.physMax = 500;

  const result2 = combat.resolve(packet2, target);
  assert.equal(result2.outcome, 'invalid', 'R1 refuses a dead target — no second hit resolves at all');
  assert.equal(deaths.length, 1, 'still exactly one actor:death — no double-fire on a second hit against a corpse');
  assert.equal(gains.length, 1, 'still exactly one xp:gain — no double XP on a double kill (the ticket\'s own named failure mode)');

  combat.releasePacket(packet);
  combat.releasePacket(packet2);
  combat.dispose();
});

test('CombatSystem#awardXp, driven through a real init(), resolves difficulty off ctx.peek(\'world\') and defaults to instruction when world is absent', async () => {
  const events = new EventBus();
  const killer = makeActor({ id: 950, kind: 'player', level: 24 });
  const target = makeActor({ id: 951, level: 27, rank: 'boss', baseXp: 900 });
  const actorsSystem = makeActorsSystemStub([killer, target]);

  const ctxNoWorld = {
    rng: new Rng(1), events, time: { step: 0 },
    get(id) { if (id === 'actors') return actorsSystem; throw new Error(`no ${id}`); },
    peek() { return undefined; },
    has() { return false; },
  };

  const worldInstruction = xpForMonster(27, 'boss', 900, 24, 'instruction');
  const combatB = new CombatSystem();
  await combatB.init(ctxNoWorld);
  assert.equal(combatB.awardXp(killer, target), worldInstruction, 'no world registered -> DEFAULT_DIFFICULTY (instruction)');
  combatB.dispose();

  const worldTrial = { current: { difficulty: 'trial' } };
  const ctxWithWorld = {
    rng: new Rng(1), events: new EventBus(), time: { step: 0 },
    get(id) { if (id === 'actors') return actorsSystem; if (id === 'world') return worldTrial; throw new Error(`no ${id}`); },
    peek(id) { return id === 'world' ? worldTrial : undefined; },
    has(id) { return id === 'world'; },
  };
  const combatC = new CombatSystem();
  await combatC.init(ctxWithWorld);
  assert.equal(combatC.awardXp(killer, target), 21747, 'world.current.difficulty = trial -> E10.6\'s own value');
  assert.equal(combatC.awardXp(killer, target), xpForMonster(27, 'boss', 900, 24, 'trial'));
  combatC.dispose();
});
