// tests/skills/allocate.test.js
//
// SKIL-1 — `canAllocate`/`allocate`/`respec`: tier and prerequisite gating
// (`canAllocate` only — `allocate` deliberately skips both,
// `02-api-contracts.md:918`), and the 29-point round trip this ticket's
// acceptance criterion names: "`respec()` round-trips to 29".
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillsSystem } from '../../src/skills/index.js';
import { makeStubCtx, makeStubActor } from '../helpers/actor.js';

async function buildSkills() {
  const skills = new SkillsSystem();
  const ctx = makeStubCtx({ systems: { skills } });
  await skills.init(ctx);
  return skills;
}

function ravagerActor(level) {
  const actor = makeStubActor({ level, classId: 'ravager' });
  actor.stats = { skillBonuses: { all: 0, tree: {}, skill: {} } };
  return actor;
}

test('canAllocate: tier gate refuses a skill above the actor\'s character level', async () => {
  const skills = await buildSkills();
  const actor = ravagerActor(5); // below sunder's tier 18, and below bloodletting's tier 6

  const belowTier = skills.canAllocate(actor, 'bloodletting');
  assert.equal(belowTier.ok, false);
  assert.equal(belowTier.reason, 'tier');

  actor.level = 6;
  const atTier = skills.canAllocate(actor, 'bloodletting');
  assert.equal(atTier.ok, true);
});

test('canAllocate: prereq gate refuses sunder until bloodletting >= 3, then allows it', async () => {
  const skills = await buildSkills();
  const actor = ravagerActor(30);

  const noPrereq = skills.canAllocate(actor, 'sunder');
  assert.equal(noPrereq.ok, false);
  assert.equal(noPrereq.reason, 'prereq');

  for (let i = 0; i < 2; i++) skills.allocate(actor, 'bloodletting');
  const partialPrereq = skills.canAllocate(actor, 'sunder');
  assert.equal(partialPrereq.ok, false, 'bloodletting at 2 must still refuse sunder (needs >= 3)');
  assert.equal(partialPrereq.reason, 'prereq');

  skills.allocate(actor, 'bloodletting'); // now at 3
  const met = skills.canAllocate(actor, 'sunder');
  assert.equal(met.ok, true);
});

test('canAllocate: maxLevel gate refuses a 21st point', async () => {
  const skills = await buildSkills();
  const actor = ravagerActor(30);
  for (let i = 0; i < 20; i++) assert.equal(skills.allocate(actor, 'cleaving_strike'), true);
  const maxed = skills.canAllocate(actor, 'cleaving_strike');
  assert.equal(maxed.ok, false);
  assert.equal(maxed.reason, 'maxed');
  assert.equal(skills.allocate(actor, 'cleaving_strike'), false, 'allocate() itself also refuses past maxLevel');
});

test('allocate() does NOT validate tier or prerequisites (02-api-contracts.md:918) — respec can rebuild out of order', async () => {
  const skills = await buildSkills();
  const actor = ravagerActor(1); // below every tier above 1, and no prereqs allocated

  // sunder is tier 18 and needs bloodletting >= 3 — canAllocate refuses it here...
  assert.equal(skills.canAllocate(actor, 'sunder').ok, false);
  // ...but allocate() spends the point anyway, exactly as documented.
  assert.equal(skills.allocate(actor, 'sunder'), true);
  assert.equal(skills.effectiveLevel(actor, 'sunder'), 1);
});

test('respec() round-trips to 29 points, and a raw allocate() replay (out of prereq order) reaches the same total', async () => {
  const skills = await buildSkills();
  const actor = ravagerActor(30);

  // A real, canAllocate-respecting 29-point Ravager build that exercises
  // the one prerequisite in this tree: cleaving_strike x20 + bloodletting
  // x3 + sunder x6 = 29, prereq satisfied before sunder is ever touched.
  for (let i = 0; i < 20; i++) {
    assert.equal(skills.canAllocate(actor, 'cleaving_strike').ok, true);
    assert.equal(skills.allocate(actor, 'cleaving_strike'), true);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(skills.canAllocate(actor, 'bloodletting').ok, true);
    assert.equal(skills.allocate(actor, 'bloodletting'), true);
  }
  for (let i = 0; i < 6; i++) {
    assert.equal(skills.canAllocate(actor, 'sunder').ok, true);
    assert.equal(skills.allocate(actor, 'sunder'), true);
  }

  assert.equal(skills.instanceOf(actor, 'cleaving_strike').allocated, 20);
  assert.equal(skills.instanceOf(actor, 'bloodletting').allocated, 3);
  assert.equal(skills.instanceOf(actor, 'sunder').allocated, 6);

  const refunded = skills.respec(actor);
  assert.equal(refunded, 29, 'respec() must refund exactly the 29 points spent');
  assert.equal(skills.instanceOf(actor, 'cleaving_strike').allocated, 0);
  assert.equal(skills.instanceOf(actor, 'bloodletting').allocated, 0);
  assert.equal(skills.instanceOf(actor, 'sunder').allocated, 0);
  assert.equal(skills.effectiveLevel(actor, 'cleaving_strike'), 0);

  // Rebuild in ONE pass via raw allocate() calls, deliberately in an order
  // canAllocate() would refuse (sunder before bloodletting) — this is
  // exactly the property 02-api-contracts.md:918 documents allocate()
  // enabling for the respec path.
  for (let i = 0; i < 6; i++) assert.equal(skills.allocate(actor, 'sunder'), true);
  for (let i = 0; i < 20; i++) assert.equal(skills.allocate(actor, 'cleaving_strike'), true);
  for (let i = 0; i < 3; i++) assert.equal(skills.allocate(actor, 'bloodletting'), true);

  let total = 0;
  for (const id of ['cleaving_strike', 'bloodletting', 'sunder']) total += skills.instanceOf(actor, id).allocated;
  assert.equal(total, 29, 'a raw allocate() replay must reach the same 29-point total');

  const refundedAgain = skills.respec(actor);
  assert.equal(refundedAgain, 29, 'a second respec() must again refund exactly 29');
  assert.equal(skills.respec(actor), 0, 'respec() on an already-empty actor refunds 0, not negative or NaN');
});
