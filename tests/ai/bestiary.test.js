// tests/ai/bestiary.test.js
//
// AI-1 acceptance tests for src/ai/data/bestiary.js. `node:test` +
// `node:assert/strict` only, matching every sibling test file in this repo
// (e.g. tests/combat/packet.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim):
//   1. Seven archetypes load in Node, and the module imports nothing.
//   2. Base values equal 03-combat-math.md §9.1 exactly.
// Rule 12 additionally requires asserting all ten base fields and six
// resistances per archetype against the values transcribed in the brief —
// done below via EXPECTED, a literal restatement of that table.
//
// NOT tested here (owned by later tickets, not touched by this one): the
// brain/FSM (AI-2), perception/aggro, pack templates, attack tables, corpse
// rules, Molgrim's full §7 datasheet — none of that data exists in
// bestiary.js by design (see that file's own header).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BESTIARY,
  lifeMult,
  damageMult,
  defenseMult,
  arMult,
  xpMult,
  flatDR,
} from '../../src/ai/data/bestiary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BESTIARY_FILE = join(HERE, '..', '..', 'src', 'ai', 'data', 'bestiary.js');

// `03-combat-math.md` §9.1, verbatim (this ticket's brief) — `mlvl 1`,
// `normal` rank, Instruction difficulty. `attackTime: null` for
// `blight_crawler` stands in for the table's "—": it has no repeating attack
// (06 §2.6 — "the Crawler has no ordinary attack").
const EXPECTED = {
  bone_ranker: {
    baseLife: 20, baseMinDamage: 3, baseMaxDamage: 6, baseDefense: 18,
    baseAttackRating: 45, baseXp: 7, attackTime: 1.40, runSpeed: 3.2, mass: 78,
    role: 'melee',
    resists: { fire: 0, cold: 25, lightning: 0, poison: 50, magic: 0, physical: 0 },
  },
  carrion_swarm: {
    baseLife: 9, baseMinDamage: 2, baseMaxDamage: 3, baseDefense: 12,
    baseAttackRating: 38, baseXp: 3, attackTime: 0.75, runSpeed: 5.4, mass: 22,
    role: 'swarm',
    resists: { fire: 0, cold: 0, lightning: 0, poison: 25, magic: 0, physical: 0 },
  },
  ashen_archer: {
    baseLife: 15, baseMinDamage: 3, baseMaxDamage: 7, baseDefense: 14,
    baseAttackRating: 52, baseXp: 8, attackTime: 1.70, runSpeed: 3.6, mass: 68,
    role: 'ranged',
    resists: { fire: 25, cold: 0, lightning: 0, poison: 0, magic: 0, physical: 0 },
  },
  dust_shaman: {
    baseLife: 17, baseMinDamage: 2, baseMaxDamage: 5, baseDefense: 15,
    baseAttackRating: 40, baseXp: 12, attackTime: 1.60, runSpeed: 3.4, mass: 70,
    role: 'support',
    resists: { fire: 25, cold: 25, lightning: 25, poison: 25, magic: 0, physical: 0 },
  },
  maulsmith: {
    baseLife: 42, baseMinDamage: 9, baseMaxDamage: 18, baseDefense: 26,
    baseAttackRating: 55, baseXp: 16, attackTime: 2.20, runSpeed: 2.4, mass: 140,
    role: 'heavy',
    resists: { fire: 0, cold: 0, lightning: -25, poison: 25, magic: 0, physical: 15 },
  },
  blight_crawler: {
    baseLife: 12, baseMinDamage: 8, baseMaxDamage: 14, baseDefense: 10,
    baseAttackRating: 30, baseXp: 6, attackTime: null, runSpeed: 4.6, mass: 40,
    role: 'suicide',
    resists: { fire: 0, cold: -25, lightning: 0, poison: 75, magic: 0, physical: 0 },
  },
  molgrim: {
    baseLife: 430, baseMinDamage: 16, baseMaxDamage: 30, baseDefense: 25,
    baseAttackRating: 90, baseXp: 900, attackTime: 1.80, runSpeed: 3.0, mass: 400,
    role: 'boss',
    resists: { fire: 50, cold: 50, lightning: 50, poison: 85, magic: 40, physical: 10 },
  },
};

const SEVEN_IDS = [
  'bone_ranker', 'carrion_swarm', 'ashen_archer', 'dust_shaman',
  'maulsmith', 'blight_crawler', 'molgrim',
];

test('exactly the seven archetypes documented by 06-monsters-ai.md §1/§2 are present', () => {
  assert.deepEqual(Object.keys(BESTIARY).sort(), [...SEVEN_IDS].sort());
});

test('BESTIARY and every archetype row are frozen (zero allocation per frame, rule 5)', () => {
  assert.ok(Object.isFrozen(BESTIARY));
  for (const id of SEVEN_IDS) {
    assert.ok(Object.isFrozen(BESTIARY[id]), `${id} row is not frozen`);
    assert.ok(Object.isFrozen(BESTIARY[id].resists), `${id}.resists is not frozen`);
  }
});

for (const id of SEVEN_IDS) {
  test(`${id}: ten base fields + id/role match 03-combat-math.md §9.1 exactly`, () => {
    const row = BESTIARY[id];
    const expected = EXPECTED[id];
    assert.equal(row.id, id);
    assert.equal(row.role, expected.role, 'role');
    assert.equal(row.baseLife, expected.baseLife, 'baseLife');
    assert.equal(row.baseMinDamage, expected.baseMinDamage, 'baseMinDamage');
    assert.equal(row.baseMaxDamage, expected.baseMaxDamage, 'baseMaxDamage');
    assert.equal(row.baseDefense, expected.baseDefense, 'baseDefense');
    assert.equal(row.baseAttackRating, expected.baseAttackRating, 'baseAttackRating');
    assert.equal(row.baseXp, expected.baseXp, 'baseXp');
    assert.equal(row.attackTime, expected.attackTime, 'attackTime');
    assert.equal(row.runSpeed, expected.runSpeed, 'runSpeed');
    assert.equal(row.mass, expected.mass, 'mass');
  });

  test(`${id}: six resistances match 03-combat-math.md §9.1 exactly`, () => {
    assert.deepEqual(BESTIARY[id].resists, expected(id).resists);
  });
}

function expected(id) {
  return EXPECTED[id];
}

const MLVL_EPS = 1e-9;

function closeTo(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < MLVL_EPS,
    `${label}: expected ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

test('mlvl scaling functions match 03-combat-math.md §10.1 exactly (spot-checked rows)', () => {
  // n=1: every multiplier is a no-op, flat DR 0.
  closeTo(lifeMult(1), 1, 'lifeMult(1)');
  closeTo(damageMult(1), 1, 'damageMult(1)');
  closeTo(defenseMult(1), 1, 'defenseMult(1)');
  closeTo(arMult(1), 1, 'arMult(1)');
  closeTo(xpMult(1), 1, 'xpMult(1)');
  assert.equal(flatDR(1), 0);

  // n=10: the rounding-rule worked example (`03 §10.1`: "a level-10 champion
  // has 351 life and not 352: 20 × 4.393 × 4.0 = 351.44" implies
  // lifeMult(10) = 4.393).
  closeTo(lifeMult(10), 4.393, 'lifeMult(10)');
  closeTo(damageMult(10), 3.5875, 'damageMult(10)');
  closeTo(defenseMult(10), 3.7, 'defenseMult(10)');
  closeTo(arMult(10), 4.42, 'arMult(10)');
  closeTo(xpMult(10), 5.176, 'xpMult(10)');
  assert.equal(flatDR(10), 1);

  // n=40: table row, all six columns.
  closeTo(lifeMult(40), 30.913, 'lifeMult(40)');
  closeTo(damageMult(40), 20.9875, 'damageMult(40)');
  closeTo(defenseMult(40), 12.7, 'defenseMult(40)');
  closeTo(arMult(40), 15.82, 'arMult(40)');
  closeTo(xpMult(40), 37.816, 'xpMult(40)');
  assert.equal(flatDR(40), 5);
});

test('mlvl scaling functions never round an intermediate (03 §10.1) — no scaled-value helper is exported', async () => {
  const exportsList = Object.keys(await import('../../src/ai/data/bestiary.js'));
  for (const name of exportsList) {
    assert.doesNotMatch(name, /scale|scaled/i, `${name} looks like a premature rounding helper`);
  }
});

test('the module source contains no import statement (06 §13 step 1: "imports nothing")', () => {
  const src = readFileSync(BESTIARY_FILE, 'utf8');
  // Masks line comments before checking, the same discipline
  // tools/check-imports.mjs applies, so a comment mentioning the word
  // "import" in prose (there are several above) can never trip this.
  const codeOnly = src
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
  assert.doesNotMatch(codeOnly, /\bimport\b/, 'bestiary.js must import nothing');
});

test('the module has no `three`, `document`, `window` or `performance.now()` reference', () => {
  // Masks line comments first — this file's own header prose says "all
  // three multipliers" (English "three", not the `three` package), which a
  // bare /\bthree\b/ scan over the raw source would misfire on.
  const src = readFileSync(BESTIARY_FILE, 'utf8');
  const codeOnly = src
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
  assert.doesNotMatch(codeOnly, /(^|[^\w])three(\/|['"]|$|[^\w])/);
  assert.doesNotMatch(codeOnly, /\bdocument\s*\./);
  assert.doesNotMatch(codeOnly, /\bwindow\s*\./);
  assert.doesNotMatch(codeOnly, /performance\s*\.\s*now\s*\(/);
});
