// tests/skills/imbue.perf.test.js
//
// SKIL-13 — allocation probes for the imbue/cascade engine
// (`src/skills/imbue.js`), O-43/O-23 methodology (N >= 1e6,
// `tests/helpers/alloc.js#assertAllocationFree`/`allocatedBytes`). Four
// probes:
//
//   1. `skills.imbueRemaining`/`imbueElement`/`cascadeCharges` — the three
//      `02-api-contracts.md` §10 rows this ticket adds, all `Alloc: no`.
//   2. The shared `actor:damage` reaction (`imbue.js#onActorDamage`) — the
//      hot path every landed weapon hit in the whole game runs through
//      (`02-api-contracts.md` §10's own Listens row). Held to the hard
//      O-43 `< 1 B/call` bar.
//   3. `skills.cast('blade_seal', ...)` itself — the synchronous action-start
//      work (spend, phase decomposition, `beginAction`, pending-cast
//      scratch). REPORTED, not gated at < 1 B/call, matching
//      `cleaving_strike.perf.test.js`'s own precedent for the analogous
//      probe (a `02-api-contracts.md` `Alloc: pool` contract, not `Alloc: no`).
//   4. The deferred arm (`onHitframe` -> `armImbue`) — same `Alloc: pool`
//      reporting-only treatment as probe 3, for the same reason.
//
// Uses the same real `boot()` (`src/main.js`) stack `tests/skills/
// rune_strike.test.js` already established — see that file's header.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { assertAllocationFree, allocatedBytes, hasGc } from '../helpers/alloc.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

async function buildCtx() {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  return ctx;
}

function spawnRuneblade(actors, skills, z) {
  const player = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 0, z, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  player.attributes.strength = 60;
  player.attributes.dexterity = 60;
  player.attributes.vitality = 40;
  player.attributes.energy = 40;
  skills.allocate(player, 'blade_seal');
  for (let i = 0; i < 20; i++) skills.allocate(player, 'rune_strike');
  for (let i = 0; i < 20; i++) skills.allocate(player, 'cascade');
  actors.stats(player);
  player.stats.manaReturnPercent = 8;
  player.mana = 1_000_000;
  player.resonance = 0;
  return player;
}

function spawnMonsterAt(actors, origin, dx, dz) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: origin.x + dx, z: origin.z + dz, level: 1 });
  actors.setState(m, 'idle');
  actors.stats(m);
  m.stats.defense = 0;
  m.life = 1_000_000_000;
  return m;
}

test('SKIL-13 perf — imbueRemaining / imbueElement / cascadeCharges are Alloc:no (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const player = spawnRuneblade(actors, skills, 30000);

  // Arm once, untimed, so the read probes below hit the REAL "armed" branch
  // (hits > 0, a real element), not just the trivial all-zero default.
  player.resonance = 3;
  skills.cast(player, 'blade_seal', player.x, player.z);
  let ticks = 0;
  while (player.actionId !== null && ticks < 600) {
    ctx.time.step++;
    actors.fixedUpdate(1 / 60, ctx);
    skills.fixedUpdate(1 / 60, ctx);
    ticks++;
  }
  assert.equal(skills.imbueRemaining(player), 3, 'sanity: armed before timing');

  let sink;
  const PROBES = [
    { name: 'skills.imbueRemaining(player)', fn: () => { sink = skills.imbueRemaining(player); } },
    { name: 'skills.imbueElement(player)', fn: () => { sink = skills.imbueElement(player); } },
    { name: 'skills.cascadeCharges(player)', fn: () => { sink = skills.cascadeCharges(player); } },
  ];

  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 40 });
    // eslint-disable-next-line no-console
    console.log(`[SKIL-13 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1000000`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
  void sink;
});

test('SKIL-13 perf — the shared actor:damage reaction, steady-state floor (no active imbue, cascade unallocated), Alloc:no (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  // This is the COMMON case in a real fight: a landed weapon hit from an
  // actor with no active `blade_seal` imbue and no points in `cascade` —
  // the vast majority of landed hits in the whole game never touch either
  // mechanic at all. The listener must still walk its own gates (outcome,
  // `WEAPON_ATTACK_SKILL_IDS`, `actors.resolve`, `readImbue`,
  // `effectiveLevel('cascade')`) at zero cost. See the next test for the
  // decrement/disarm/trigger paths, which are REPORTED rather than gated —
  // those touch OTHER subsystems' own already-documented allocation floors
  // (O-79 for `setSourceLayer`, O-59 for `combat.buildAttackPacket`), not
  // this file's own overhead.
  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const player = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 0, z: 33000, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  actors.stats(player); // no blade_seal/cascade allocated — never armed, cascade level stays 0
  const monster = spawnMonsterAt(actors, player, 1.0, 0);

  const result = {
    targetId: monster.id, targetGen: monster.generation, sourceId: player.id, sourceGen: player.generation,
    sourceSkillId: 'attack', outcome: 'hit', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 10, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 10,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false, pointX: 0, pointY: 0, pointZ: 0,
  };
  const payload = { target: monster, source: player, result };

  const fn = () => skills._onActorDamageForImbue(payload); // the exact registered listener

  const { bytesPerCall, rounds } = assertAllocationFree(fn, { iterations: 1_000_000, maxRounds: 40 });
  // eslint-disable-next-line no-console
  console.log(`[SKIL-13 perf] actor:damage reaction, steady-state floor: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1000000`);
  assert.ok(bytesPerCall < 1, `the steady-state actor:damage reaction must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
});

test('SKIL-13 perf — the actor:damage reaction with an active imbue AND cascade allocated, reported (touches O-79/O-59, not gated)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const player = spawnRuneblade(actors, skills, 34000);
  const monster = spawnMonsterAt(actors, player, 1.0, 0);

  const result = {
    targetId: monster.id, targetGen: monster.generation, sourceId: player.id, sourceGen: player.generation,
    sourceSkillId: 'rune_strike', outcome: 'hit', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 10, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 10,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false, pointX: 0, pointY: 0, pointZ: 0,
  };
  const payload = { target: monster, source: player, result };

  function rearm() {
    player.resonance = 3;
    skills.cast(player, 'blade_seal', player.x, player.z);
    let ticks = 0;
    while (player.actionId !== null && ticks < 600) {
      ctx.time.step++;
      actors.fixedUpdate(1 / 60, ctx);
      skills.fixedUpdate(1 / 60, ctx);
      ticks++;
    }
  }
  rearm();

  let n = 0;
  const fn = () => {
    if (skills.imbueRemaining(player) === 0) rearm(); // every 3rd call: disarm + re-cast
    n++;
    skills._onActorDamageForImbue(payload); // every 3rd call: also fires the cascade wave
  };

  const bytesPerCall = allocatedBytes(fn, 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`[SKIL-13 perf] actor:damage reaction, decrement+disarm+cascade-trigger mixed in: ${bytesPerCall.toFixed(4)} B/call @ N=1000000, n=${n} (NOT gated — includes setSourceLayer's O-79 floor and, on the trigger call, combat.buildAttackPacket's documented O-59 cost)`);
});

test('SKIL-13 perf — skills.cast("blade_seal") and its deferred arm, reported (Alloc: pool per 02-api-contracts.md §10)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const player = spawnRuneblade(actors, skills, 32000);

  // --- Probe: skills.cast('blade_seal') itself ----------------------------
  const castFn = () => {
    player.actionId = null; // let this iteration's cast begin a fresh action
    player.resonance = 3;
    skills.cast(player, 'blade_seal', player.x, player.z);
  };
  const bytesPerCallCast = allocatedBytes(castFn, 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`[SKIL-13 perf] skills.cast("blade_seal") — action start only, no arm: ${bytesPerCallCast.toFixed(4)} B/call @ N=1000000 (Alloc: pool — reported, not gated)`);

  // --- Probe: the deferred arm anim:hitframe triggers ---------------------
  const armFn = () => {
    player.actionId = null;
    player.resonance = 3;
    skills.cast(player, 'blade_seal', player.x, player.z);
    ctx.events.emit('anim:hitframe', { actor: player, actionId: 'blade_seal', actionSeq: player.actionSeq });
  };
  const bytesPerCallArm = allocatedBytes(armFn, 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`[SKIL-13 perf] anim:hitframe -> armImbue (writeImbueStatPartial + setSourceLayer + markDirty): ${bytesPerCallArm.toFixed(4)} B/call @ N=1000000 (Alloc: pool — reported, not gated)`);
});
