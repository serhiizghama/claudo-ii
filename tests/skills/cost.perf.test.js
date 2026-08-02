// tests/skills/cost.perf.test.js
//
// SKIL-2 — allocation probes for `costOf`/`cooldownRemaining`
// (`02-api-contracts.md` §10: both `Alloc: no`), O-43/O-23 methodology
// (N >= 1e6, `tests/helpers/alloc.js#assertAllocationFree`). This file is
// NOT `tests/core/alloc.test.js`'s `12.A01` sweep — that file is not granted
// to this ticket (SKIL-1 just touched it); these two rows are reported in
// this ticket's report for the orchestrator to fold in there. This file is
// this ticket's own, independent proof the two methods are allocation-free,
// so the claim does not rest on an edit nobody has made yet.
//
// Also probes the `actor.cooldowns` recycle-safe Map helpers
// (`startCooldown`/`cooldownRemainingSteps`) directly, since they are the
// mechanism `cooldownRemaining` is built on and the ticket's own acceptance
// asks for a measurement "at N >= 1 000 000" specifically for the recycle
// fix.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { makeStubCtx, makeStubActor } from '../helpers/actor.js';
import { SkillsSystem } from '../../src/skills/index.js';
import { startCooldown, cooldownRemainingSteps } from '../../src/skills/cost.js';

async function buildSkills() {
  const skills = new SkillsSystem();
  const ctx = makeStubCtx({ systems: { skills } });
  await skills.init(ctx);
  return { skills, ctx };
}

function makeActor() {
  const actor = makeStubActor();
  actor.stats = {
    skillBonuses: { all: 0, tree: {}, skill: {} },
    manaCostReduction: 20, rageOnHit: 0, rageOnTakeHit: 0, resonanceOnHit: 0, manaReturnPercent: 0,
  };
  actor.classId = 'ravager';
  actor.level = 40;
  actor.generation = 0;
  actor.cooldowns = new Map();
  return actor;
}

test('SKIL-2 perf — costOf / cooldownRemaining / cooldown Map helpers allocate < 1 byte/call (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { skills, ctx } = await buildSkills();
  const actor = makeActor();
  actor.classId = 'ravager';
  skills.allocate(actor, 'cleaving_strike'); // one real allocation, untimed — the probe below re-costs it every call

  // `cooldowns` warm-up: insert the fixed key ONCE, untimed, so every timed
  // probe below only ever WRITES an EXISTING Map key (bounded 30-key set —
  // see cost.js's file header) — the same discipline `tests/core/
  // alloc.test.js`'s SKIL-1 `allocate` probe already established.
  startCooldown(actor, 'ram_charge', 4.0, 0);

  let sink; // keeps a property-read probe from being dead-code-eliminated

  const PROBES = [
    { name: 'skills.costOf(actor, "cleaving_strike") [rage]', iterations: 2_000_000, fn: () => { sink = skills.costOf(actor, 'cleaving_strike'); } },
    { name: 'skills.cooldownRemaining(actor, "ram_charge") [set, mid-cooldown]', iterations: 2_000_000, fn: () => { skills.cooldownRemaining(actor, 'ram_charge'); } },
    { name: 'skills.cooldownRemaining(actor, "war_cry") [never set]', iterations: 2_000_000, fn: () => { skills.cooldownRemaining(actor, 'war_cry'); } },
    { name: 'cost.js: startCooldown(actor,"ram_charge",4.0,step) [existing key]', iterations: 1_000_000, fn: () => { startCooldown(actor, 'ram_charge', 4.0, ctx.time.step); } },
    { name: 'cost.js: cooldownRemainingSteps(actor,"ram_charge",step)', iterations: 2_000_000, fn: () => { cooldownRemainingSteps(actor, 'ram_charge', ctx.time.step); } },
  ];

  const results = [];
  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    results.push({ name: probe.name, bytesPerCall, rounds });
    console.log(`[SKIL-2 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }

  assert.equal(results.length, PROBES.length);
  void sink;
});
