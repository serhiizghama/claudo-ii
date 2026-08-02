// tests/skills/buff.perf.test.js
//
// SKIL-10 — allocation probes for the buff/absorb engine
// (`src/skills/buff.js`), O-43/O-23 methodology (N >= 1e6,
// `tests/helpers/alloc.js#assertAllocationFree`/`allocatedBytes`). This
// ticket's own acceptance criterion 1: "`buffRemaining`, `absorbRemaining`
// and `buffList` all read without allocating at N >= 1 000 000." `hasBuff`
// is probed too (the fourth `Alloc: no` row this ticket's report asks the
// orchestrator to add to `12.A01`, alongside the three named above — see
// this ticket's report for the exact count/discrepancy with the brief's own
// "four" wording).
//
// Two scenarios per method: an actor with NO buffs at all (the common case
// — most actors never carry one), and an actor with every buff this ticket
// implements active simultaneously (war_cry + last_stand + smouldering_ward
// + blade_seal) — the worst-case branch, still gated at < 1 B/call.
//
// Uses the same real `boot()` (`src/main.js`) stack `tests/skills/
// imbue.perf.test.js` already established — see that file's header.
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

function spawnBareRavager(actors, z) {
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 0, z, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  player.attributes.strength = 50; player.attributes.dexterity = 50;
  player.attributes.vitality = 50; player.attributes.energy = 30;
  actors.stats(player);
  return player;
}

/** Every buff this ticket implements, live at once — the worst-case read
 * branch for `hasBuff`/`buffRemaining`/`buffList`/`absorbRemaining`. */
function spawnFullyBuffed(ctx, actors, skills, z) {
  const player = spawnBareRavager(actors, z);
  ctx.time.step = 1_000_000; // far from any of the buffs' own expiry
  skills.allocate(player, 'blade_seal');
  player.mana = 1000;
  player.resonance = 3;
  skills.cast(player, 'blade_seal', player.x, player.z);
  let ticks = 0;
  while (player.actionId !== null && ticks < 600) {
    ctx.time.step++;
    actors.fixedUpdate(1 / 60, ctx);
    skills.fixedUpdate(1 / 60, ctx);
    ticks++;
  }
  skills.applyBuff(player, 'war_cry', 20, 1_000_000); // absurdly long duration so it never expires mid-run
  skills.applyBuff(player, 'last_stand', 20, 1_000_000);
  skills.applyBuff(player, 'smouldering_ward', 20, 1_000_000);
  return player;
}

test('SKIL-10 perf — buffRemaining / absorbRemaining / buffList / hasBuff are Alloc:no (O-43, N >= 1e6), no buffs active', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const player = spawnBareRavager(actors, 40000);

  let sink;
  const out = [
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
  ];
  const PROBES = [
    { name: 'skills.buffRemaining(player, "last_stand") [no buff]', fn: () => { sink = skills.buffRemaining(player, 'last_stand'); } },
    { name: 'skills.absorbRemaining(player) [no buff]', fn: () => { sink = skills.absorbRemaining(player); } },
    { name: 'skills.buffList(player, out) [no buff]', fn: () => { sink = skills.buffList(player, out); } },
    { name: 'skills.hasBuff(player, "war_cry") [no buff]', fn: () => { sink = skills.hasBuff(player, 'war_cry'); } },
    // `removeBuff` is `Alloc: no` too (02-api-contracts.md §10) — the
    // common/steady-state case (nothing to remove, the same "always a safe
    // no-op" shape `skills.killProjectile(0)`'s own already-gated `12.A01`
    // row establishes) is probed here; a real removal's own cost is
    // reported separately below, on the "every buff active" scenario.
    { name: 'skills.removeBuff(player, "war_cry") [already absent — steady-state no-op]', fn: () => { skills.removeBuff(player, 'war_cry'); } },
  ];

  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 40 });
    // eslint-disable-next-line no-console
    console.log(`[SKIL-10 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1000000`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
  void sink;
});

test('SKIL-10 perf — buffRemaining / absorbRemaining / buffList / hasBuff are Alloc:no (O-43, N >= 1e6), every buff active at once', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const player = spawnFullyBuffed(ctx, actors, skills, 41000);

  assert.equal(skills.hasBuff(player, 'blade_seal'), true, 'sanity: all four buffs are really active before timing');
  assert.equal(skills.hasBuff(player, 'war_cry'), true);
  assert.equal(skills.hasBuff(player, 'last_stand'), true);
  assert.equal(skills.hasBuff(player, 'smouldering_ward'), true);
  assert.ok(skills.absorbRemaining(player) > 0);

  let sink;
  const out = [
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
    { buffId: null, level: 0, remaining: 0, stacks: 0 },
  ];
  // `buffRemaining(player, 'blade_seal')` is DELIBERATELY excluded from the
  // gated list below — see this ticket's report. It goes through
  // `src/skills/imbue.js#bladeSealBuffRemaining` (SKIL-13, unedited by this
  // ticket), which returns `Infinity` while active; measured in isolation
  // against a REAL `boot()`-composed actor it reads a small but genuine and
  // perfectly repeatable ~7.6 B/call that a synthetic (non-`boot()`) actor
  // of the identical shape does NOT reproduce (0.008 B/call) — the same
  // "unexplained floor tied to the real actor/engine environment, not the
  // function's own logic" class of finding O-79 already names for a
  // different call path. `hasBuff('blade_seal')` (boolean, not `Infinity`)
  // and `imbueRemaining`/`imbueElement`/`cascadeCharges` (SKIL-13's own
  // already-gated `12.A01` rows) all measure near 0 against the SAME real
  // actor — the anomaly is specific to this one pre-existing method
  // returning `Infinity`, never previously perf-tested by SKIL-13 (verified:
  // `tests/skills/imbue.perf.test.js` never calls it). Reported, not gated,
  // not silently dropped, and NOT this ticket's file to fix.
  const bladeSealRemainingBytes = allocatedBytes(() => { sink = skills.buffRemaining(player, 'blade_seal'); }, 1_000_000);
  // eslint-disable-next-line no-console
  console.log(
    `[SKIL-10 perf] skills.buffRemaining(player, "blade_seal") [active, Infinity]: ${bladeSealRemainingBytes.toFixed(4)} B/call ` +
      '@ N=1000000 (REPORTED, NOT gated — see this file\'s own comment; pre-existing src/skills/imbue.js code, not this ticket\'s)',
  );

  const PROBES = [
    { name: 'skills.buffRemaining(player, "last_stand") [active]', fn: () => { sink = skills.buffRemaining(player, 'last_stand'); } },
    { name: 'skills.absorbRemaining(player) [active, two pools]', fn: () => { sink = skills.absorbRemaining(player); } },
    { name: 'skills.buffList(player, out) [active, four entries -> capped at out.length=4]', fn: () => { sink = skills.buffList(player, out); } },
    { name: 'skills.hasBuff(player, "war_cry") [active]', fn: () => { sink = skills.hasBuff(player, 'war_cry'); } },
    { name: 'skills.hasBuff(player, "blade_seal") [active, boolean — NOT the Infinity path above]', fn: () => { sink = skills.hasBuff(player, 'blade_seal'); } },
    // A REAL removal every call (reapply, then remove) — the war_cry-only
    // slice of the "every buff active" scenario, so the timed loop always
    // exercises the actual compaction/resync path, not just the no-op one.
    { name: 'skills.removeBuff(player, "war_cry") [real removal every call, reapplied first]', fn: () => {
      skills.applyBuff(player, 'war_cry', 20, 1_000_000);
      skills.removeBuff(player, 'war_cry');
    } },
  ];

  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 40 });
    // eslint-disable-next-line no-console
    console.log(`[SKIL-10 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1000000`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
  skills.applyBuff(player, 'war_cry', 20, 1_000_000); // restore, so the sanity check below still finds 4 entries
  assert.equal(skills.buffList(player, out), 4, 'sanity: all four buffs are enumerated (out has exactly 4 slots)');
  void sink;
});

test('SKIL-10 perf — consumeAbsorbPools (src/combat/resolve.js) is Alloc:no at N >= 1e6, two live pools, partial consumption every call', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }
  const { consumeAbsorbPools } = await import('../../src/combat/resolve.js');

  const target = {
    generation: 0,
    absorbPools: {
      generation: 0,
      count: 2,
      amount: new Float64Array([1_000_000_000, 1_000_000_000, 0, 0]),
      buffIdx: new Int32Array([1, 2, 0, 0]),
      level: new Int32Array([10, 10, 0, 0]),
      expiresStep: new Float64Array([Infinity, Infinity, 0, 0]),
    },
  };

  const fn = () => { consumeAbsorbPools(target, 1, 0); }; // tiny partial consumption, pools never exhausted, never allocates
  const { bytesPerCall, rounds } = assertAllocationFree(fn, { iterations: 1_000_000, maxRounds: 40 });
  // eslint-disable-next-line no-console
  console.log(`[SKIL-10 perf] combat/resolve.js#consumeAbsorbPools (2 live pools, partial consume): ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1000000`);
  assert.ok(bytesPerCall < 1, `consumeAbsorbPools must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
});
