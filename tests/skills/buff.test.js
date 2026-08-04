// tests/skills/buff.test.js
//
// SKIL-10 acceptance tests for `src/skills/buff.js` and its wiring in
// `src/skills/index.js` — the generalised `applyBuff`/`removeBuff`/
// `hasBuff`/`buffRemaining`/`buffList`/`absorbRemaining` engine, proven
// against `war_cry` (05 §3.3), `last_stand` (05 §3.5) and `smouldering_ward`
// (05 §5.3), per this ticket's D-37 scope. Also proves `blade_seal`'s own
// buff view (SKIL-13, `src/skills/imbue.js`, unedited) still works through
// the generalised dispatch.
//
// Built against a REAL `boot()` (`src/main.js`), one instance for the whole
// file — same "ONE boot() per file, never per test" precedent
// `tests/skills/cleaving_strike.test.js`'s own header establishes (module-
// level `poolIndex`-keyed state elsewhere in `src/actors/` does not tolerate
// two boots in one process).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const skills = ctx.get('skills');
const combat = ctx.get('combat');

let nextSpawnOffset = 0;

function spawnRavager(level = 30) {
  const originZ = (nextSpawnOffset += 200);
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 0, z: originZ, facing: 0, level });
  actors.setState(player, 'idle');
  player.attributes.strength = 50;
  player.attributes.dexterity = 50;
  player.attributes.vitality = 50;
  player.attributes.energy = 30;
  actors.stats(player);
  return player;
}

function spawnEmberwright(level = 30) {
  const originZ = (nextSpawnOffset += 200);
  const player = actors.spawn({ kind: 'player', archetypeId: 'emberwright', team: 0, x: 0, z: originZ, facing: 0, level });
  actors.setState(player, 'idle');
  player.attributes.strength = 30;
  player.attributes.dexterity = 30;
  player.attributes.vitality = 40;
  player.attributes.energy = 50;
  actors.stats(player);
  return player;
}

const EPS = 1e-6;
function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// war_cry — the self-buff (D-37 scope, engine only; the nova/cast itself is
// not wired, no impl/war_cry.js — see buff.js's own header)
// ---------------------------------------------------------------------------

test('war_cry: applyBuff contributes enhancedDamage into the "skills" stat layer, matching 05 §3.3\'s printed L1/L20 figures', () => {
  const player = spawnRavager(30);
  const before = actors.stats(player).enhancedDamage;

  ctx.time.step = 1000;
  skills.applyBuff(player, 'war_cry', 1, 12.0);
  let stats = actors.stats(player);
  approx(stats.enhancedDamage - before, 15, 'L1: enhancedDamage += 15 + 2*(1-1) = 15');

  skills.applyBuff(player, 'war_cry', 20, 12.0);
  stats = actors.stats(player);
  approx(stats.enhancedDamage - before, 53, 'L20: enhancedDamage += 15 + 2*19 = 53');

  assert.equal(skills.hasBuff(player, 'war_cry'), true);
  approx(skills.buffRemaining(player, 'war_cry'), 12.0, 'freshly applied, full 12s remaining');
});

test('war_cry: hasBuff/buffRemaining/buffList read false/0/absent once the 12s window elapses (lazy, at read time)', () => {
  const player = spawnRavager(30);
  ctx.time.step = 2000;
  skills.applyBuff(player, 'war_cry', 10, 12.0);
  assert.equal(skills.hasBuff(player, 'war_cry'), true);

  ctx.time.step = 2000 + Math.round(12.0 * 60) + 1; // just past expiry
  assert.equal(skills.hasBuff(player, 'war_cry'), false);
  assert.equal(skills.buffRemaining(player, 'war_cry'), 0);

  const out = [{ buffId: null, level: 0, remaining: 0, stacks: 0 }];
  const n = skills.buffList(player, out);
  assert.equal(n, 0, 'an expired war_cry must not appear in buffList');
});

test('war_cry: removeBuff clears it immediately (hasBuff false right away, not just at read-time expiry)', () => {
  const player = spawnRavager(30);
  ctx.time.step = 3000;
  skills.applyBuff(player, 'war_cry', 5, 12.0);
  assert.equal(skills.hasBuff(player, 'war_cry'), true);
  skills.removeBuff(player, 'war_cry');
  assert.equal(skills.hasBuff(player, 'war_cry'), false);
  approx(actors.stats(player).enhancedDamage, 0, 'stat layer resynced back to 0 on explicit removeBuff');
});

// ---------------------------------------------------------------------------
// last_stand — the automatic passive trigger
// ---------------------------------------------------------------------------

function grantLastStand(player, level) {
  for (let i = 0; i < level; i++) skills.allocate(player, 'last_stand');
  actors.stats(player);
}

test('last_stand: triggers at life <= 25% maxLife, grants +40 rage and an absorb pool matching 40 + 22*(L-1)', () => {
  const player = spawnRavager(30);
  grantLastStand(player, 10); // effectiveLevel 10 -> absorb 40 + 22*9 = 238
  player.rage = 0;
  const maxLife = actors.stats(player).maxLife;
  player.life = maxLife; // full life, no trigger yet
  ctx.time.step = 10000;

  assert.equal(skills.absorbRemaining(player), 0, 'sanity: no absorb before any low-life hit');

  const before25 = combat.applyDirect(player, maxLife * 0.50, 'physical', 0, 'test'); // life now 50% — above the 25% threshold
  void before25;
  assert.equal(skills.absorbRemaining(player), 0, 'still above 25% life -> no trigger yet');

  // One more hit that crosses the 25% threshold (50% -> 20%).
  combat.applyDirect(player, maxLife * 0.30, 'physical', 0, 'test');

  const absorb = skills.absorbRemaining(player);
  // eslint-disable-next-line no-console
  console.log(`[last_stand trigger] level=10, rage after=${player.rage}, absorb granted=${absorb} (expect 238)`);
  approx(absorb, 238, '40 + 22*(10-1)');
  approx(player.rage, 40, '+40 rage on trigger (05 §3.5, extra.trigger.rageGrant)');
  assert.equal(skills.hasBuff(player, 'last_stand'), true);
  approx(skills.buffRemaining(player, 'last_stand'), 8.0, 'last_stand\'s own absorb duration, 05 §3.5\'s printed 8.0 s');
});

test('last_stand: a second trigger inside the cooldown floor is refused — cooldown gates re-triggering, not the life threshold', () => {
  const player = spawnRavager(30);
  grantLastStand(player, 1); // L1: cooldown 90s (floor irrelevant at L1, still >> anything tested here), absorb 40
  player.rage = 0;
  const maxLife = actors.stats(player).maxLife;
  player.life = maxLife;
  ctx.time.step = 20000;

  combat.applyDirect(player, maxLife * 0.90, 'physical', 0, 'test'); // life now 10% -> triggers
  const firstAbsorb = skills.absorbRemaining(player);
  approx(firstAbsorb, 40, 'L1 absorb: 40 + 22*0');
  approx(player.rage, 40, 'first trigger grants rage');
  const cdAfterFirst = skills.cooldownRemaining(player, 'last_stand');
  assert.ok(cdAfterFirst > 49, `cooldown floor is 50s at minimum (90 - 2*(1-1) = 90, well above the 50s floor too); got ${cdAfterFirst}`);

  // Still at/below 25% life, deal ANOTHER hit that would otherwise re-trigger.
  player.rage = 0; // reset so a spurious second grant would be observable
  combat.applyDirect(player, 1, 'physical', 0, 'test');

  // eslint-disable-next-line no-console
  console.log(`[last_stand floor] cooldownRemaining after first trigger=${cdAfterFirst.toFixed(2)}s, ` +
    `rage after a second qualifying hit=${player.rage} (must stay 0 — refused)`);
  approx(player.rage, 0, 'the second trigger inside the cooldown window must be refused (no rage grant)');
});

test('last_stand: a hit larger than life + absorb still kills the actor (system-level, through the same trigger)', () => {
  const player = spawnRavager(30);
  grantLastStand(player, 1);
  const maxLife = actors.stats(player).maxLife;
  player.life = maxLife;
  ctx.time.step = 30000;

  // Bring it to exactly 25% (triggers, grants a 40-point pool), then land a
  // hit far larger than life + absorb combined.
  combat.applyDirect(player, maxLife * 0.75, 'physical', 0, 'test');
  assert.ok(skills.absorbRemaining(player) > 0, 'sanity: the trigger fired');

  const lifeBeforeKillingBlow = player.life;
  const packet = combat.buildAttackPacket(spawnRavager(1), 'attack');
  packet.physMin = lifeBeforeKillingBlow + skills.absorbRemaining(player) + 500;
  packet.physMax = packet.physMin;
  packet.team = 1;
  packet.attackRating = 0;
  // Pin the crit roll too, not just to-hit — MATL-1 registering `materials`
  // shifted every later subsystem's `ctx.rng.fork()` index, which moves
  // where this file's combat rolls land in the stream. Outcome here is
  // invariant to crit (the hit is already life+absorb+500), but pinning it
  // keeps this packet from consuming/depending on an unpinned roll anyway.
  packet.critChance = 0;
  const result = combat.resolve(packet, player);
  combat.releasePacket(packet);

  assert.equal(player.life, 0, 'life clamps to 0');
  assert.equal(result.killed, true, 'the actor dies — the absorb only delayed part of the hit, not all of it');
});

// ---------------------------------------------------------------------------
// smouldering_ward — the timed absorb buff, and re-cast refresh semantics
// ---------------------------------------------------------------------------

test('smouldering_ward: applyBuff creates an absorb pool of 45 + 25*(L-1), for the given seconds', () => {
  const player = spawnEmberwright(30);
  ctx.time.step = 40000;
  skills.applyBuff(player, 'smouldering_ward', 12, 20.0);

  approx(skills.absorbRemaining(player), 320, '45 + 25*11 = 320, matching 05 §5.3\'s L12 row');
  assert.equal(skills.hasBuff(player, 'smouldering_ward'), true);
  approx(skills.buffRemaining(player, 'smouldering_ward'), 20.0);
});

test('smouldering_ward: re-applying refreshes the pool in place, discarding the old remainder (05 §5.3, no stacking)', () => {
  const player = spawnEmberwright(30);
  ctx.time.step = 41000;
  skills.applyBuff(player, 'smouldering_ward', 1, 20.0); // 45
  // Spend some of it via a real resolve() hit.
  const attacker = spawnRavager(1);
  const packet = combat.buildAttackPacket(attacker, 'attack');
  packet.physMin = 20; packet.physMax = 20;
  packet.team = 1; packet.attackRating = 0;
  // Pin the crit roll, not just to-hit — MATL-1 registering `materials`
  // shifted every later subsystem's `ctx.rng.fork()` index, which moved
  // this hit's crit roll from false to true (40 absorbed instead of 20),
  // draining the pool to 5 instead of 25 below. attackRating=0 already
  // declares "pin to-hit"; this line pins the other roll the assertion was
  // silently depending on.
  packet.critChance = 0;
  combat.resolve(packet, player);
  combat.releasePacket(packet);
  approx(skills.absorbRemaining(player), 25, '45 - 20 spent');

  skills.applyBuff(player, 'smouldering_ward', 12, 20.0); // refresh -> 320, not 25+320
  approx(skills.absorbRemaining(player), 320, 'the old remainder is discarded, not added to the new pool');
});

test('removeBuff("smouldering_ward") clears the pool; an unknown buffId is a silent no-op (O-27)', () => {
  const player = spawnEmberwright(30);
  ctx.time.step = 42000;
  skills.applyBuff(player, 'smouldering_ward', 5, 20.0);
  assert.ok(skills.absorbRemaining(player) > 0);
  skills.removeBuff(player, 'smouldering_ward');
  assert.equal(skills.absorbRemaining(player), 0);
  assert.equal(skills.hasBuff(player, 'smouldering_ward'), false);

  // Unknown id — never throws, never asserts "nothing else exists" (O-27).
  assert.doesNotThrow(() => skills.removeBuff(player, 'totally_unknown_buff'));
  assert.equal(skills.hasBuff(player, 'totally_unknown_buff'), false);
  assert.equal(skills.buffRemaining(player, 'totally_unknown_buff'), 0);
});

test('applyBuff throws on an unknown buffId, and still refuses blade_seal (D-41 precedent, imbue.js unedited)', () => {
  const player = spawnRavager(30);
  assert.throws(() => skills.applyBuff(player, 'not_a_real_skill', 1, 1.0));
  assert.throws(() => skills.applyBuff(player, 'blade_seal', 1, 1.0));
});

// ---------------------------------------------------------------------------
// Generality — two DIFFERENT absorb buffs on one actor, oldest-first,
// aggregated correctly by absorbRemaining/buffList (not realistic for one
// class in real gameplay, but the engine must not assume it can't happen —
// O-27)
// ---------------------------------------------------------------------------

test('absorbRemaining/buffList aggregate two simultaneous absorb pools (different buffIds) correctly', () => {
  const player = spawnRavager(30);
  ctx.time.step = 50000;
  skills.applyBuff(player, 'last_stand', 1, 8.0); // 40
  skills.applyBuff(player, 'smouldering_ward', 1, 20.0); // 45

  approx(skills.absorbRemaining(player), 85, '40 + 45');

  const out = [
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
  ];
  const n = skills.buffList(player, out);
  assert.equal(n, 2);
  const ids = out.slice(0, n).map((e) => e.buffId).sort();
  assert.deepEqual(ids, ['last_stand', 'smouldering_ward']);
});

// ---------------------------------------------------------------------------
// blade_seal — still works through the generalised dispatch (SKIL-13,
// src/skills/imbue.js, unedited — a regression check only)
// ---------------------------------------------------------------------------

test('blade_seal: hasBuff/buffRemaining/buffList/removeBuff still delegate correctly to imbue.js after generalisation', () => {
  const player = spawnRavager(30);
  ctx.time.step = 60000;
  skills.allocate(player, 'blade_seal');
  player.mana = 1000;
  player.resonance = 3;
  const cast = skills.cast(player, 'blade_seal', player.x, player.z);
  assert.equal(cast, true);
  let ticks = 0;
  while (player.actionId !== null && ticks < 600) {
    ctx.time.step++;
    actors.fixedUpdate(1 / 60, ctx);
    skills.fixedUpdate(1 / 60, ctx);
    ticks++;
  }

  assert.equal(skills.hasBuff(player, 'blade_seal'), true);
  assert.equal(skills.buffRemaining(player, 'blade_seal'), Infinity, 'hits-bounded, not time-bounded — imbue.js\'s own documented behaviour');

  const out = [{ buffId: null, level: 0, remaining: 0, stacks: 0 }];
  const n = skills.buffList(player, out);
  assert.equal(n, 1);
  assert.equal(out[0].buffId, 'blade_seal');

  skills.removeBuff(player, 'blade_seal');
  assert.equal(skills.hasBuff(player, 'blade_seal'), false);
});

// ---------------------------------------------------------------------------
// Buff state survives pool recycle (SKIL-2/CMBT-8/SKIL-13's own precedent)
// ---------------------------------------------------------------------------

test('absorb pool state does not leak across a despawn/respawn into the same poolIndex slot (generation-stamped)', () => {
  const a = spawnRavager(5);
  ctx.time.step = 70000;
  skills.applyBuff(a, 'last_stand', 5, 8.0);
  assert.ok(skills.absorbRemaining(a) > 0, 'sanity: a really has an absorb pool');
  const recycledPoolIndex = a.poolIndex;

  actors.despawn(a, true);
  const b = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 0, z: 99999, level: 1 });
  actors.setState(b, 'idle');

  // eslint-disable-next-line no-console
  console.log(`[recycle] a.poolIndex=${recycledPoolIndex}, b.poolIndex=${b.poolIndex}, same slot=${recycledPoolIndex === b.poolIndex}`);

  if (b.poolIndex === recycledPoolIndex) {
    assert.equal(skills.absorbRemaining(b), 0, 'a fresh occupant of the same actor-record slot must not inherit the previous one\'s absorb pool');
  }
});
