// tests/actors/rig.test.js
//
// ACTR-3 acceptance tests for src/actors/rig.js — createSkeleton() and the
// bone tables for all four rigs. `node:test` + `node:assert/strict` only
// (12-testing.md P6). This file mirrors, in-process, exactly what
// tools/rigcheck.mjs checks headlessly (`08 §11 step 1`): 22/16/12/26 bones;
// every world bind position round-trips through the local transforms within
// 1e-6 m; no bone length is 0; every `*R` bone has x < 0; every parent index
// is less than its child index. Keeping both makes rigcheck's own report
// re-derivable from a plain `node --test` run, not just from running the
// tool by hand.
//
// Scope: rig.js only. Skin binding (ACTR-5), geometry (ACTR-4) and animation
// (ACTR-6+) do not exist yet and are not exercised here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkeleton, reconstructBindPos, RIG_BONE_COUNTS } from '../../src/actors/rig.js';

const RIGS = [
  { rigId: 'humanoid', opts: {}, expectedCount: 22 },
  { rigId: 'humanoid', opts: { cloak: true }, expectedCount: 24 },
  { rigId: 'quadruped', opts: {}, expectedCount: 16 },
  { rigId: 'crawler', opts: {}, expectedCount: 12 },
  { rigId: 'boss', opts: {}, expectedCount: 26 },
];

function vec3At(arr, i) {
  return { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] };
}

// ---------------------------------------------------------------------------
// 08 §11 step 1 — the acceptance criterion, one rig at a time
// ---------------------------------------------------------------------------

for (const { rigId, opts, expectedCount } of RIGS) {
  const label = opts.cloak ? `${rigId} (cloak)` : rigId;

  test(`ACTR-3 rigcheck | ${label} | bone count`, () => {
    const skeleton = createSkeleton(rigId, opts);
    assert.equal(skeleton.boneCount, expectedCount);
    assert.equal(skeleton.names.length, expectedCount);
    assert.equal(skeleton.parents.length, expectedCount);
  });

  test(`ACTR-3 rigcheck | ${label} | every world bind position round-trips within 1e-6 m`, () => {
    const skeleton = createSkeleton(rigId, opts);
    const reconstructed = reconstructBindPos(skeleton);
    for (let i = 0; i < skeleton.boneCount; i++) {
      const original = vec3At(skeleton.bindPos, i);
      const rebuilt = vec3At(reconstructed, i);
      const dx = rebuilt.x - original.x;
      const dy = rebuilt.y - original.y;
      const dz = rebuilt.z - original.z;
      const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
      assert.ok(err < 1e-6, `${skeleton.names[i]} (#${i}) round-trip error ${err} >= 1e-6`);
    }
  });

  test(`ACTR-3 rigcheck | ${label} | no bone length is 0`, () => {
    const skeleton = createSkeleton(rigId, opts);
    for (let i = 0; i < skeleton.boneCount; i++) {
      if (skeleton.parents[i] < 0) continue; // the root is not a bone segment
      assert.ok(skeleton.boneLength[i] > 0, `${skeleton.names[i]} (#${i}) has zero length`);
    }
  });

  test(`ACTR-3 rigcheck | ${label} | every *R bone has x < 0`, () => {
    const skeleton = createSkeleton(rigId, opts);
    let checked = 0;
    for (let i = 0; i < skeleton.boneCount; i++) {
      if (!skeleton.names[i].endsWith('R')) continue;
      checked++;
      const x = skeleton.bindPos[i * 3];
      assert.ok(x < 0, `${skeleton.names[i]} (#${i}) has x=${x}, expected < 0`);
    }
    // `quadruped` (§2.4) is the one rig with no bone literally named *R —
    // its right-side bones are `FRA`/`FRB`/`BRA`/`BRB` (an "R" for "right"
    // inside the name, not as the last character), so 0 here is correct,
    // not a vacuous check — see this ticket's report.
    if (rigId !== 'quadruped') {
      assert.ok(checked > 0, `${label}: expected at least one *R bone to check`);
    } else {
      assert.equal(checked, 0, `${label}: expected no bone literally named *R`);
    }
  });

  test(`ACTR-3 rigcheck | ${label} | every parent index is less than its child index`, () => {
    const skeleton = createSkeleton(rigId, opts);
    for (let i = 0; i < skeleton.boneCount; i++) {
      assert.ok(skeleton.parents[i] < i, `${skeleton.names[i]} (#${i}) has parent index ${skeleton.parents[i]} >= ${i}`);
    }
  });
}

// ---------------------------------------------------------------------------
// createSkeleton() contract — shared, frozen, plain data
// ---------------------------------------------------------------------------

test('ACTR-3 | createSkeleton returns the same shared reference every call (no per-call allocation of the table itself)', () => {
  assert.equal(createSkeleton('humanoid'), createSkeleton('humanoid'));
  assert.equal(createSkeleton('humanoid', { cloak: true }), createSkeleton('humanoid', { cloak: true }));
  assert.equal(createSkeleton('quadruped'), createSkeleton('quadruped'));
  assert.equal(createSkeleton('crawler'), createSkeleton('crawler'));
  assert.equal(createSkeleton('boss'), createSkeleton('boss'));
});

test('ACTR-3 | createSkeleton default is cloakless humanoid (the Bone Ranker, M2\'s only archetype)', () => {
  const withOpts = createSkeleton('humanoid', {});
  const noOpts = createSkeleton('humanoid');
  assert.equal(withOpts, noOpts);
  assert.equal(noOpts.boneCount, 22);
  assert.equal(noOpts.cloak, false);
});

test('ACTR-3 | createSkeleton throws on an unknown rigId', () => {
  assert.throws(() => createSkeleton('nope'), /unknown rigId/);
});

test('ACTR-3 | returned skeleton is frozen — cannot be mutated by a caller', () => {
  const skeleton = createSkeleton('humanoid');
  assert.throws(() => {
    skeleton.boneCount = 999;
  });
});

test('ACTR-3 | RIG_BONE_COUNTS matches 08 §11 step 1 verbatim (22/16/12/26)', () => {
  assert.equal(RIG_BONE_COUNTS.humanoid, 22);
  assert.equal(RIG_BONE_COUNTS.humanoidCloak, 24);
  assert.equal(RIG_BONE_COUNTS.quadruped, 16);
  assert.equal(RIG_BONE_COUNTS.crawler, 12);
  assert.equal(RIG_BONE_COUNTS.boss, 26);
});

// ---------------------------------------------------------------------------
// A few named bones, spot-checked against 08 §2.3-2.6's tables directly —
// catches a transcription slip that the structural checks above would not
// (e.g. a swapped x/z, a mistyped parent that still happens to satisfy
// "parent < child").
// ---------------------------------------------------------------------------

test('ACTR-3 | humanoid — Hips is bone 1, parented to Root, at the authored bind position', () => {
  const skeleton = createSkeleton('humanoid');
  assert.equal(skeleton.names[1], 'Hips');
  assert.equal(skeleton.parents[1], 0);
  const pos = vec3At(skeleton.bindPos, 1);
  assert.equal(pos.x, 0);
  assert.equal(pos.y, 0.955);
  assert.equal(pos.z, 0.0);
});

test('ACTR-3 | humanoid — ForearmL has two children (HandL, ShieldL); ShieldL is not the primary child', () => {
  const skeleton = createSkeleton('humanoid');
  const handLIdx = skeleton.names.indexOf('HandL');
  const shieldLIdx = skeleton.names.indexOf('ShieldL');
  const forearmLIdx = skeleton.names.indexOf('ForearmL');
  assert.equal(skeleton.parents[handLIdx], forearmLIdx);
  assert.equal(skeleton.parents[shieldLIdx], forearmLIdx);
});

test('ACTR-3 | quadruped — Maw is the leaf child of Head, Head child of Chest', () => {
  const skeleton = createSkeleton('quadruped');
  const headIdx = skeleton.names.indexOf('Head');
  const mawIdx = skeleton.names.indexOf('Maw');
  const chestIdx = skeleton.names.indexOf('Chest');
  assert.equal(skeleton.parents[headIdx], chestIdx);
  assert.equal(skeleton.parents[mawIdx], headIdx);
});

test('ACTR-3 | crawler — six legs are parented directly to Body and evenly spaced', () => {
  const skeleton = createSkeleton('crawler');
  const bodyIdx = skeleton.names.indexOf('Body');
  const legNames = ['LegA', 'LegB', 'LegC', 'LegD', 'LegE', 'LegF'];
  const angles = [];
  for (const name of legNames) {
    const idx = skeleton.names.indexOf(name);
    assert.equal(skeleton.parents[idx], bodyIdx);
    const pos = vec3At(skeleton.bindPos, idx);
    const radius = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
    assert.ok(Math.abs(radius - 0.335) < 1e-9, `${name} radius ${radius} != 0.335`);
    angles.push(Math.atan2(pos.x, pos.z));
  }
  // Six angles, 60 degrees (pi/3) apart, starting at 0.
  for (let i = 0; i < angles.length; i++) {
    const expected = (i * Math.PI) / 3;
    const wrapped = ((angles[i] % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const expectedWrapped = ((expected % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(Math.abs(wrapped - expectedWrapped) < 1e-9, `${legNames[i]} angle mismatch`);
  }
});

test('ACTR-3 | boss — Cloak2 parents to Cloak1 and Tome parents to Chest, both after the base 24', () => {
  const skeleton = createSkeleton('boss');
  assert.equal(skeleton.boneCount, 26);
  const cloak1Idx = skeleton.names.indexOf('Cloak1');
  const cloak2Idx = skeleton.names.indexOf('Cloak2');
  const chestIdx = skeleton.names.indexOf('Chest');
  const tomeIdx = skeleton.names.indexOf('Tome');
  assert.equal(cloak1Idx, 23);
  assert.equal(cloak2Idx, 24);
  assert.equal(tomeIdx, 25);
  assert.equal(skeleton.parents[cloak2Idx], cloak1Idx);
  assert.equal(skeleton.parents[tomeIdx], chestIdx);
  // Unscaled — same ~1.8 m frame as the rest of the humanoid table, not
  // multiplied by the boss's 1.778x heightScale (see rig.js's file header).
  const tomePos = vec3At(skeleton.bindPos, tomeIdx);
  assert.equal(tomePos.x, 0.38);
  assert.equal(tomePos.y, 1.48);
  assert.equal(tomePos.z, 0.22);
});

test('ACTR-3 | boss shares its first 24 bones\' derivation with the plain cloak humanoid', () => {
  const boss = createSkeleton('boss');
  const humanoidCloak = createSkeleton('humanoid', { cloak: true });
  for (let i = 0; i < 24; i++) {
    assert.equal(boss.names[i], humanoidCloak.names[i]);
    assert.equal(boss.parents[i], humanoidCloak.parents[i]);
    for (let k = 0; k < 3; k++) assert.equal(boss.bindPos[i * 3 + k], humanoidCloak.bindPos[i * 3 + k]);
    for (let k = 0; k < 3; k++) assert.equal(boss.localPos[i * 3 + k], humanoidCloak.localPos[i * 3 + k]);
  }
});
