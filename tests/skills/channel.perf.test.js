// tests/skills/channel.perf.test.js
//
// SKIL-7 perf acceptance: the three `02-api-contracts.md` §10 Casting-table
// rows this ticket adds — `interrupt` `Fixed Y / Alloc no`, `isChannelling`
// `Fixed Y / Alloc no`, `polarityStance` `Fixed Y / Alloc no` — at O-43/O-23
// methodology (N >= 1 000 000, `tests/helpers/alloc.js#assertAllocationFree`).
// Also a best-effort steady-state probe of `SkillsSystem#fixedUpdate` while
// a real `whirlwind` channel is active (`ARCHITECTURE.md` rule 6: "allocate
// nothing per frame" — not itself a `02` contract row with its own `Alloc`
// column, so no `< 1 B/call` gate is asserted on it, only reported).
//
// `*.perf.test.js` per this ticket's own rule 9. Built against a REAL
// `boot()` (`src/main.js`) — same precedent `tests/skills/
// cleaving_strike.test.js`/`channel.test.js` already established — because
// `interrupt`/`isChannelling`/`polarityStance` all read real per-actor
// engine state that only exists after a real `cast()`, and the
// `fixedUpdate` probe needs real `physics`/`combat` behind it.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { assertAllocationFree, allocatedBytes, hasGc } from '../helpers/alloc.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

test('SKIL-7 perf — interrupt / isChannelling / polarityStance allocate < 1 byte/call (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');

  function tick() {
    ctx.time.step++;
    actors.fixedUpdate(H, ctx);
    skills.fixedUpdate(H, ctx);
  }

  // A channelling Ravager (isChannelling/interrupt's own "live" case).
  const ravager = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 0, z: 0, facing: 0, level: 30 });
  actors.setState(ravager, 'idle');
  skills.allocate(ravager, 'whirlwind');
  ravager.rage = 50;
  assert.equal(skills.cast(ravager, 'whirlwind', ravager.x + 10, ravager.z, 0), true, 'sanity: the channel must actually be running for isChannelling/interrupt to probe a real "true" case');
  assert.equal(skills.isChannelling(ravager), true);

  // A non-channelling Ravager (interrupt's own "idle no-op" case — must not
  // allocate either, and must not be confused with the actor above).
  const idleRavager = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 100, z: 100, facing: 0, level: 30 });
  actors.setState(idleRavager, 'idle');

  // A Runeblade holding Storm (polarityStance's own "real stance" case).
  const runeblade = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 200, z: 200, facing: 0, level: 30 });
  actors.setState(runeblade, 'idle');
  skills.allocate(runeblade, 'polarity');
  runeblade.mana = 100;
  assert.equal(skills.cast(runeblade, 'polarity', runeblade.x, runeblade.z, 0), true);
  assert.equal(skills.polarityStance(runeblade), 'storm');

  // An actor with no points in polarity at all (polarityStance's own `null`
  // case — must resolve to a constant answer without allocating either).
  const bystander = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 300, z: 300, facing: 0, level: 30 });
  actors.setState(bystander, 'idle');
  assert.equal(skills.polarityStance(bystander), null);

  for (let i = 0; i < 5; i++) tick(); // warm up every shape once, untimed

  const PROBES = [
    { name: 'skills.isChannelling(ravager) [true]', iterations: 2_000_000, fn: () => { skills.isChannelling(ravager); } },
    { name: 'skills.isChannelling(idleRavager) [false]', iterations: 2_000_000, fn: () => { skills.isChannelling(idleRavager); } },
    { name: 'skills.polarityStance(runeblade) [storm]', iterations: 2_000_000, fn: () => { skills.polarityStance(runeblade); } },
    { name: 'skills.polarityStance(bystander) [null, unallocated]', iterations: 2_000_000, fn: () => { skills.polarityStance(bystander); } },
    { name: 'skills.interrupt(idleRavager) [no-op — actionId===null]', iterations: 1_000_000, fn: () => { skills.interrupt(idleRavager); } },
  ];

  const results = [];
  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    results.push({ name: probe.name, bytesPerCall, rounds });
    // eslint-disable-next-line no-console
    console.log(`[SKIL-7 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
  assert.equal(results.length, PROBES.length);

  // `skills.interrupt(ravager)` (the actual channel-ending path, Alloc:
  // no) is NOT probed inside the timed loop above — calling it repeatedly
  // would only exercise the SAME single teardown once (idempotent no-op
  // every call after the first), so `bytesPerCall` would trivially read 0
  // without ever exercising the real active-list removal. Proven once,
  // untimed, for correctness instead (channel.test.js's own acceptance
  // tests are where its real behaviour — and its own zero-allocation
  // discipline as an ordinary `Alloc: no` call — is exercised for real,
  // repeatedly, across five different tests).
  skills.interrupt(ravager);
  assert.equal(skills.isChannelling(ravager), false);
});

test('SKIL-7 perf — SkillsSystem#fixedUpdate with an active whirlwind channel (ARCHITECTURE.md rule 6, reported not gated)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');

  function tick() {
    ctx.time.step++;
    actors.fixedUpdate(H, ctx);
    skills.fixedUpdate(H, ctx);
  }

  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 0, z: 0, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  player.attributes.strength = 50;
  player.attributes.dexterity = 60;
  player.attributes.vitality = 50;
  skills.allocate(player, 'whirlwind');
  player.rage = 50;

  const monster = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 1.0, z: 0, level: 10 });
  actors.setState(monster, 'idle');
  actors.stats(monster);
  monster.life = 1e9; // never dies mid-probe

  assert.equal(skills.cast(player, 'whirlwind', player.x + 10, player.z, 0), true);

  for (let i = 0; i < 200; i++) tick(); // warm up several tick/income cadences, untimed

  // Rage/mana would otherwise run dry over N=1e6 timed steps (277 hours of
  // sim time) — top up between GC-measured batches via the SAME public
  // `addRage` contract row the engine itself uses, never a raw field write.
  const fn = () => {
    if (player.rage < 10) actors.addRage(player, 90);
    ctx.time.step++;
    skills.fixedUpdate(H, ctx);
  };

  // `allocatedBytes`, NOT `assertAllocationFree` — deliberately not gated
  // at < 1 B/call (see this test's own name/header): `fixedUpdate` is not
  // itself a `02-api-contracts.md` §10 contract row with an `Alloc` column,
  // and the measurement here necessarily includes `physics.overlapCircle`/
  // `combat.buildAttackPacket`/`combat.resolve()` underneath the tick/income
  // cadences — other tickets' own `Alloc: no` guarantees, not re-verified
  // here. Reported for visibility only.
  const bytesPerCall = allocatedBytes(fn, 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`[SKIL-7 perf] SkillsSystem#fixedUpdate (1 active whirlwind channel, steady state): ${bytesPerCall.toFixed(4)} B/call @ N=1e6 (reported, not gated — see header)`);
  assert.ok(Number.isFinite(bytesPerCall));

  skills.interrupt(player);
});
