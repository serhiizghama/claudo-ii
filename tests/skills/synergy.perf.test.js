// tests/skills/synergy.perf.test.js
//
// SKIL-12 — the ticket's own load-bearing perf claim: "`describe()` returns
// level N and N+1 without allocating." UI-9 calls `describe` TWICE PER
// HOVERED NODE (level N, then N+1) to render its detail card — a per-call
// allocation here becomes a per-hover allocation in the UI. O-43/O-23
// methodology: N >= 1 000 000, never the spec's bare 10 000
// (`tests/helpers/alloc.js#assertAllocationFree`).
//
// O-85 is a CLASS, not one file: allocation assertions in the unit stage
// flake under concurrency (four prior files, four different agents). This
// file already lives in the isolated `--test-concurrency=1` perf stage by
// its own `*.perf.test.js` name (D-11) — if it ever flakes, re-run it in
// isolation before concluding anything, per this ticket's brief.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { makeStubCtx, makeStubActor } from '../helpers/actor.js';
import { SkillsSystem } from '../../src/skills/index.js';

async function buildSkills() {
  const skills = new SkillsSystem();
  const ctx = makeStubCtx({ systems: { skills } });
  await skills.init(ctx);
  return skills;
}

function makeActor() {
  const actor = makeStubActor();
  actor.stats = { skillBonuses: { all: 0, tree: {}, skill: {} }, manaCostReduction: 0 };
  actor.generation = 0;
  actor.cooldowns = new Map();
  actor.mana = 500;
  return actor;
}

/** The caller-owned `SkillDescription`, preallocated once — exactly the
 * shape `02-api-contracts.md`'s own comment requires ("Preallocated; `ui`
 * renders it and never recomputes a skill number"). One `out` per level
 * (N and N+1), reused every call, never rebuilt inside the probe. */
function makeSkillDescriptionOut() {
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push({ labelKey: null, value: 0, unit: null, format: null });
  return {
    lineCount: 0, lines,
    costResource: null, costAmount: 0,
    cooldown: 0, castTime: 0, radius: 0, range: 0, duration: 0,
    damageMin: 0, damageMax: 0,
  };
}

test('SKIL-12 perf — describe() at level N and N+1 allocates < 1 byte/call (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const skills = await buildSkills();
  const actor = makeActor();
  // A real, non-trivial synergy source so the probe exercises the
  // flatDamage x-multiplier path (meteor), not just the empty-synergy
  // fast path.
  for (let i = 0; i < 20; i++) skills.allocate(actor, 'ember_bolt');
  for (let i = 0; i < 20; i++) skills.allocate(actor, 'fireball');

  const outN = makeSkillDescriptionOut();
  const outN1 = makeSkillDescriptionOut();

  const PROBES = [
    // UI-9's own call shape: describe() for level N, then level N+1, for
    // the SAME hovered node, per hover. Measured both as one combined
    // "per hover" probe and as two separate probes (a regression that only
    // shows up on the SECOND call — e.g. a level-dependent branch that
    // allocates on its first miss — would hide inside a combined probe's
    // averaged bytes/call, so both are measured).
    {
      name: 'skills.describe(actor,"meteor",5,outN) + describe(actor,"meteor",6,outN1) [one hover, N then N+1]',
      iterations: 1_000_000,
      fn: () => { skills.describe(actor, 'meteor', 5, outN); skills.describe(actor, 'meteor', 6, outN1); },
    },
    { name: 'skills.describe(actor,"meteor",5,outN) [level N alone]', iterations: 1_000_000, fn: () => { skills.describe(actor, 'meteor', 5, outN); } },
    { name: 'skills.describe(actor,"meteor",6,outN1) [level N+1 alone]', iterations: 1_000_000, fn: () => { skills.describe(actor, 'meteor', 6, outN1); } },
    // A weaponDamage-shaped skill too — different branch inside
    // buildSkillDescription (percent line, not a damage-range line).
    { name: 'skills.describe(actor,"whirlwind",5,outN) [weaponDamage branch]', iterations: 1_000_000, fn: () => { skills.describe(actor, 'whirlwind', 5, outN); } },
    // An unknown skillId — the resetSkillDescription fail-closed path.
    { name: 'skills.describe(actor,"not_a_skill",5,outN) [unknown id, fail-closed]', iterations: 1_000_000, fn: () => { skills.describe(actor, 'not_a_skill', 5, outN); } },
  ];

  const results = [];
  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    results.push({ name: probe.name, bytesPerCall, rounds });
    console.log(`[SKIL-12 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }

  // Print the actual N/N+1 numbers once, untimed, so the report shows real
  // output alongside the allocation proof, not just "0 bytes."
  skills.describe(actor, 'meteor', 5, outN);
  skills.describe(actor, 'meteor', 6, outN1);
  console.log(`[SKIL-12 perf] meteor L5: damage=${outN.damageMin.toFixed(2)}-${outN.damageMax.toFixed(2)}`);
  console.log(`[SKIL-12 perf] meteor L6: damage=${outN1.damageMin.toFixed(2)}-${outN1.damageMax.toFixed(2)}`);

  assert.equal(results.length, PROBES.length);
});
