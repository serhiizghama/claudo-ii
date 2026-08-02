// tests/skills/registry.test.js
//
// SKIL-1 — registry surface: the 30-skill count and type histogram (05
// §1.7's index table, reproduced exactly — 05.S01/S1), `definition`/`all`/
// `forClass`/`forTree`/`trees` returning the SAME reference every call
// (the `Alloc: no` contract, `02-api-contracts.md` §10), and `instanceOf`/
// `effectiveLevel` basics (01 §6.2).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS } from '../../src/skills/data/skills.js';
import { SkillsSystem } from '../../src/skills/index.js';
import { makeStubCtx, makeStubActor } from '../helpers/actor.js';

// The exact histogram `05-skills.md` §1.7's index table reproduces, and
// this ticket's acceptance criterion quotes verbatim. Eight passives, one
// toggle, one channel, no auras (D-46 — the "nine of thirty" prose after
// §1.7 double-counts `last_stand` as passive AND passive-trigger; the table
// itself, counted here, is the source of truth).
const EXPECTED_HISTOGRAM = {
  attack: 2, buff: 3, channel: 1, cone: 2, ground: 2,
  mobility: 4, nova: 3, passive: 8, projectile: 3, summon: 1, toggle: 1,
};

async function buildSkills() {
  const skills = new SkillsSystem();
  const ctx = makeStubCtx({ systems: { skills } });
  await skills.init(ctx);
  return skills;
}

test('05.S01/S1 — exactly 30 SkillDefinition records load headless, with the exact type histogram', () => {
  assert.equal(SKILLS.length, 30, 'exactly 30 skills — 05 §1.7 index');

  const histogram = {};
  for (const def of SKILLS) histogram[def.type] = (histogram[def.type] || 0) + 1;
  assert.deepEqual(histogram, EXPECTED_HISTOGRAM);

  // No auras — D-46 / this ticket's trap #2.
  assert.equal(histogram.aura, undefined, 'no skill may use type "aura" — monster/unique-only enum value');

  // Ten per class, five per tree, two trees per class (01 §6.3).
  const byClass = {};
  const byTree = {};
  for (const def of SKILLS) {
    byClass[def.classId] = (byClass[def.classId] || 0) + 1;
    byTree[def.tree] = (byTree[def.tree] || 0) + 1;
  }
  assert.deepEqual(byClass, { ravager: 10, emberwright: 10, runeblade: 10 });
  for (const tree of ['carnage', 'unyielding', 'flame', 'ash', 'enchanted_blade', 'conduit']) {
    assert.equal(byTree[tree], 5, `tree '${tree}' must hold exactly 5 skills`);
  }

  // Every id unique, every classId/tree/type/target a known value.
  const ids = new Set(SKILLS.map((d) => d.id));
  assert.equal(ids.size, 30, 'every skill id must be unique');
});

test('registry: all/forClass/forTree/trees return the SAME reference every call (Alloc: no)', async () => {
  const skills = await buildSkills();

  assert.equal(skills.all, skills.all, 'all must be the same reference on repeated reads');
  assert.equal(skills.all.length, 30);

  const forClass1 = skills.forClass('ravager');
  const forClass2 = skills.forClass('ravager');
  assert.equal(forClass1, forClass2, 'forClass must return the same reference for the same classId');
  assert.equal(forClass1.length, 10);
  assert.equal(skills.forClass('unknown_class'), skills.forClass('unknown_class'), 'unknown classId still returns a stable (EMPTY) reference');
  assert.equal(skills.forClass('unknown_class').length, 0);

  const forTree1 = skills.forTree('carnage');
  const forTree2 = skills.forTree('carnage');
  assert.equal(forTree1, forTree2);
  assert.equal(forTree1.length, 5);

  const trees1 = skills.trees('ravager');
  const trees2 = skills.trees('ravager');
  assert.equal(trees1, trees2);
  assert.deepEqual([...trees1].sort(), ['carnage', 'unyielding']);
  assert.deepEqual([...skills.trees('emberwright')].sort(), ['ash', 'flame']);
  assert.deepEqual([...skills.trees('runeblade')].sort(), ['conduit', 'enchanted_blade']);
});

test('registry: definition() resolves every id in SKILLS and null for an unknown id', async () => {
  const skills = await buildSkills();
  for (const def of SKILLS) {
    assert.equal(skills.definition(def.id), def, `definition('${def.id}') must return the exact record`);
  }
  assert.equal(skills.definition('not_a_real_skill'), null);
});

test('registry: instanceOf/effectiveLevel — allocated 0 forces effectiveLevel 0 regardless of +skills', async () => {
  const skills = await buildSkills();
  const actor = makeStubActor({ level: 30, classId: 'ravager' });
  actor.stats = { skillBonuses: { all: 3, tree: { carnage: 2 }, skill: { cleaving_strike: 1 } } };

  // Not allocated — effectiveLevel forced to 0 even with +skills present (01 §6.2).
  assert.equal(skills.effectiveLevel(actor, 'cleaving_strike'), 0);
  const inst0 = skills.instanceOf(actor, 'cleaving_strike');
  assert.equal(inst0.allocated, 0);
  assert.equal(inst0.effectiveLevel, 0);

  // Allocate 5 -> effectiveLevel = 5 (allocated) + 3 (all) + 2 (tree.carnage) + 1 (skill.cleaving_strike) = 11
  for (let i = 0; i < 5; i++) assert.equal(skills.allocate(actor, 'cleaving_strike'), true);
  assert.equal(skills.effectiveLevel(actor, 'cleaving_strike'), 11);
  const inst5 = skills.instanceOf(actor, 'cleaving_strike');
  assert.equal(inst5.allocated, 5);
  assert.equal(inst5.effectiveLevel, 11);
  assert.equal(inst5.unlocked, true);

  // Unknown skill -> null / 0, never throws.
  assert.equal(skills.instanceOf(actor, 'not_a_real_skill'), null);
  assert.equal(skills.effectiveLevel(actor, 'not_a_real_skill'), 0);
});
