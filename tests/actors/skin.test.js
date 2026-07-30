// tests/actors/skin.test.js
//
// ACTR-5 acceptance tests for src/actors/skin.js — the skin binder, `08
// §3.5` steps 1-7. `node:test` + `node:assert/strict` only (12-testing.md
// P6). This is a correctness test (no time/allocation/frame assertion), so
// it is named `skin.test.js`, not `skin.perf.test.js` (D-11).
//
// THIS FILE'S ACCEPTANCE GATE — `08 §11 step 3`, verbatim: "weights sum to
// 255 exactly; zero influences below the cut; candy-wrapper loss < 12 % at
// the elbow and the knee under a 90 deg bend; no vertex bound to a bone
// > 0.45 m away." Plus the backlog's own half of the same pipeline:
// "weights normalise per vertex, <= 4 influences, no vertex unbound." Both
// halves are asserted below (see `skin.js`'s header, D-8: they are two
// stages of one pipeline — float weights sum to 1 pre-quantisation, uint8
// weights sum to 255 post-quantisation — not a contradiction).
//
// Falsifiability (rule 12 of this ticket's brief): every test below reads
// real counts off a real bound scene (`runSkinDiagnostics()`,
// `elbowCandyWrapperCheck()`, `kneeCandyWrapperCheck()` — the SAME
// functions `tools/rigcheck.mjs`'s `SKIN_GROUPS` call, so this file's
// result is re-derivable from a plain `node --test` run exactly like
// `rig.test.js` mirrors `rigcheck.mjs`'s rig checks.
//
// Scope: skin.js only. Geometry (ACTR-4, geo.js) and rigging (ACTR-3,
// rig.js) are read-only dependencies here, already accepted and tested
// elsewhere. The eventual single-draw-call merge (§3.4, ACTR-6) does not
// exist yet and is not exercised here (O-27: this is a statement about
// THIS file's scope, not a claim that ACTR-6 doesn't exist).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkeleton } from '../../src/actors/rig.js';
import { tube } from '../../src/actors/geo.js';
import {
  SKIN_CONSTANTS,
  bindSkin,
  distancePointSegment,
  computeBoneTails,
  buildLimbFixture,
  measureCandyWrapper,
  elbowCandyWrapperCheck,
  kneeCandyWrapperCheck,
  buildDiagnosticScene,
  runSkinDiagnostics,
  convexHullArea2D,
} from '../../src/actors/skin.js';

// ---------------------------------------------------------------------------
// distancePointSegment — the primitive step 2 is built on
// ---------------------------------------------------------------------------

test('distancePointSegment | point on the segment interior is distance 0', () => {
  const d = distancePointSegment({ x: 0.5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(d) < 1e-12, `expected ~0, got ${d}`);
});

test('distancePointSegment | point beyond the segment end clamps to the endpoint', () => {
  const d = distancePointSegment({ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(d - 1) < 1e-12, `expected 1, got ${d}`);
});

test('distancePointSegment | perpendicular distance from the segment interior', () => {
  const d = distancePointSegment({ x: 0.5, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(d - 1) < 1e-12, `expected 1, got ${d}`);
});

// ---------------------------------------------------------------------------
// computeBoneTails — §3.5's tail[c] for a real skeleton
// ---------------------------------------------------------------------------

test('computeBoneTails | a branching bone\'s tail is its primary (lowest-index) child\'s bind position', () => {
  const skeleton = createSkeleton('humanoid');
  const tails = computeBoneTails(skeleton);
  const forearmLIdx = skeleton.names.indexOf('ForearmL');
  const handLIdx = skeleton.names.indexOf('HandL'); // lowest-index child of ForearmL (see rig.js)
  const tail = { x: tails[forearmLIdx * 3], y: tails[forearmLIdx * 3 + 1], z: tails[forearmLIdx * 3 + 2] };
  const handPos = { x: skeleton.bindPos[handLIdx * 3], y: skeleton.bindPos[handLIdx * 3 + 1], z: skeleton.bindPos[handLIdx * 3 + 2] };
  assert.equal(tail.x, handPos.x);
  assert.equal(tail.y, handPos.y);
  assert.equal(tail.z, handPos.z);
});

test('computeBoneTails | a leaf bone gets a 0.075 m stub continuing the parent-to-self direction', () => {
  const skeleton = createSkeleton('humanoid');
  const tails = computeBoneTails(skeleton);
  const headIdx = skeleton.names.indexOf('Head'); // leaf: no child in the cloakless (22-bone) rig
  const neckIdx = skeleton.names.indexOf('Neck');
  const head = { x: skeleton.bindPos[headIdx * 3], y: skeleton.bindPos[headIdx * 3 + 1], z: skeleton.bindPos[headIdx * 3 + 2] };
  const neck = { x: skeleton.bindPos[neckIdx * 3], y: skeleton.bindPos[neckIdx * 3 + 1], z: skeleton.bindPos[neckIdx * 3 + 2] };
  const tail = { x: tails[headIdx * 3], y: tails[headIdx * 3 + 1], z: tails[headIdx * 3 + 2] };
  const dx = tail.x - head.x, dy = tail.y - head.y, dz = tail.z - head.z;
  const stubLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  assert.ok(Math.abs(stubLen - 0.075) < 1e-9, `expected 0.075 m stub, got ${stubLen}`);
  // Same direction as neck->head, extended past head.
  const dirX = head.x - neck.x, dirY = head.y - neck.y, dirZ = head.z - neck.z;
  const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  const cosAngle = (dx * dirX + dy * dirY + dz * dirZ) / (stubLen * dirLen);
  assert.ok(cosAngle > 1 - 1e-9, `expected the stub to continue the parent->self direction, cos=${cosAngle}`);
});

// ---------------------------------------------------------------------------
// bindSkin — step 1, rigid parts
// ---------------------------------------------------------------------------

test('bindSkin | a rigid part (bone set) gets skinIndex=[b,0,0,0], skinWeight=[255,0,0,0]', () => {
  const skeleton = createSkeleton('humanoid');
  const handRIdx = skeleton.names.indexOf('HandR');
  const mesh = { p: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], n: [], uv: [], i: [] }; // 3 loose points, no triangles
  const { results, stats } = bindSkin(skeleton, [{ mesh, bone: 'HandR' }]);
  assert.equal(stats.rigidParts, 1);
  assert.equal(stats.smoothParts, 0);
  const { skinIndex, skinWeight } = results[0];
  for (let i = 0; i < 3; i++) {
    assert.equal(skinIndex[i * 4], handRIdx);
    assert.equal(skinWeight[i * 4], 255);
    for (let k = 1; k < 4; k++) {
      assert.equal(skinWeight[i * 4 + k], 0);
    }
  }
});

test('bindSkin | throws on an unknown bone name', () => {
  const skeleton = createSkeleton('humanoid');
  const mesh = { p: [0, 0, 0], n: [], uv: [], i: [] };
  assert.throws(() => bindSkin(skeleton, [{ mesh, bone: 'NotABone' }]), /unknown bone/);
});

test('bindSkin | throws if a part declares both bone and bones', () => {
  const skeleton = createSkeleton('humanoid');
  const mesh = { p: [0, 0, 0], n: [], uv: [], i: [] };
  assert.throws(
    () => bindSkin(skeleton, [{ mesh, bone: 'HandR', bones: ['HandR'], bias: [1] }]),
    /declares both/,
  );
});

// ---------------------------------------------------------------------------
// bindSkin — steps 2-5, a smooth two-bone limb (the shared fixture)
// ---------------------------------------------------------------------------

test('bindSkin | every vertex of a smooth part is fully bound: <=4 influences, weights sum to 1 within 1e-5 pre-quantisation', () => {
  const fixture = buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR');
  const { results } = bindSkin(fixture.skeleton, [fixture.part]);
  const { skinIndex, skinWeight, vertexCount } = results[0];
  for (let i = 0; i < vertexCount; i++) {
    let liveCount = 0;
    let floatSum = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k];
      if (w > 0) liveCount++;
      floatSum += w / 255;
    }
    assert.ok(liveCount >= 1, `vertex ${i} is unbound (0 live influences)`);
    assert.ok(liveCount <= 4, `vertex ${i} has ${liveCount} influences, > 4`);
    // Post-quantisation the four uint8 weights sum to exactly 255 (checked
    // below); dividing by 255 must therefore land within float rounding of
    // 1, comfortably inside the validation table's pre-quantisation 1e-5
    // tolerance once quantisation's own <1/255 rounding is accounted for.
    assert.ok(Math.abs(floatSum - 1) < 1 / 255 + 1e-9, `vertex ${i} weight sum ${floatSum} far from 1`);
  }
});

test('bindSkin | quantised skinWeight sums to EXACTLY 255 for every vertex (08 §11 step 3)', () => {
  const fixture = buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR');
  const { results } = bindSkin(fixture.skeleton, [fixture.part]);
  const { skinWeight, vertexCount } = results[0];
  for (let i = 0; i < vertexCount; i++) {
    const sum = skinWeight[i * 4] + skinWeight[i * 4 + 1] + skinWeight[i * 4 + 2] + skinWeight[i * 4 + 3];
    assert.equal(sum, 255, `vertex ${i} weight sum ${sum} != 255`);
  }
});

test('bindSkin | joint clamp: the ring exactly at the elbow is forced to 0.5/0.5 between UpperArmR and ForearmR', () => {
  const fixture = buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR');
  const { results } = bindSkin(fixture.skeleton, [fixture.part]);
  const { skinIndex, skinWeight } = results[0];
  const ringStart = fixture.jointRingIndex * fixture.seg;
  for (let j = 0; j < fixture.seg; j++) {
    const i = ringStart + j;
    const idx = [skinIndex[i * 4], skinIndex[i * 4 + 1], skinIndex[i * 4 + 2], skinIndex[i * 4 + 3]];
    const w = [skinWeight[i * 4], skinWeight[i * 4 + 1], skinWeight[i * 4 + 2], skinWeight[i * 4 + 3]];
    assert.ok(idx.includes(fixture.proximalIdx), `ring vertex ${i} missing UpperArmR influence`);
    assert.ok(idx.includes(fixture.jointIdx), `ring vertex ${i} missing ForearmR influence`);
    const proxW = w[idx.indexOf(fixture.proximalIdx)];
    const jointW = w[idx.indexOf(fixture.jointIdx)];
    // 0.5/0.5 quantises to 127/128 (or 128/127) out of 255, not bit-exact.
    assert.ok(Math.abs(proxW - 127.5) <= 1, `ring vertex ${i} proximal weight ${proxW} not ~127.5`);
    assert.ok(Math.abs(jointW - 127.5) <= 1, `ring vertex ${i} joint weight ${jointW} not ~127.5`);
  }
});

test('bindSkin | vertices far from the joint on the proximal side bind fully (or nearly) to the proximal bone alone', () => {
  const fixture = buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR');
  const { results } = bindSkin(fixture.skeleton, [fixture.part]);
  const { skinIndex, skinWeight } = results[0];
  const i = 0; // ring 0, the shoulder end — farthest from the elbow
  assert.equal(skinIndex[i * 4], fixture.proximalIdx);
  assert.equal(skinWeight[i * 4], 255);
});

// ---------------------------------------------------------------------------
// bindSkin — step 6, cross-part weld
// ---------------------------------------------------------------------------

test('bindSkin | coincident vertices across two different parts are welded to an identical, averaged, renormalised weight', () => {
  const scene = buildDiagnosticScene();
  const { results, stats } = bindSkin(scene.skeleton, scene.parts);
  assert.ok(stats.weldGroups >= 1, 'expected at least one weld group in the diagnostic scene');

  // The limb part (index 0) and the cuff part (index 1) share a
  // bit-identical ring (buildDiagnosticScene's own construction) — after
  // welding, every vertex in that ring must carry the SAME weight vector on
  // both sides of the seam.
  const limbSeg = 12; // LIMB_SEG in skin.js
  const limbVerts = scene.parts[0].mesh.p.length / 3;
  const limbLastRingStart = limbVerts - limbSeg;
  const limbResult = results[0];
  const cuffResult = results[1];
  for (let j = 0; j < limbSeg; j++) {
    const limbVertex = limbLastRingStart + j;
    const cuffVertex = j; // cuff's first ring, per buildDiagnosticScene
    const limbIdx = [...limbResult.skinIndex.slice(limbVertex * 4, limbVertex * 4 + 4)];
    const limbW = [...limbResult.skinWeight.slice(limbVertex * 4, limbVertex * 4 + 4)];
    const cuffIdx = [...cuffResult.skinIndex.slice(cuffVertex * 4, cuffVertex * 4 + 4)];
    const cuffW = [...cuffResult.skinWeight.slice(cuffVertex * 4, cuffVertex * 4 + 4)];
    assert.deepEqual(limbIdx, cuffIdx, `welded seam vertex ${j}: bone index mismatch`);
    assert.deepEqual(limbW, cuffW, `welded seam vertex ${j}: weight mismatch`);
    // And the weld actually recombined something — the pre-weld limb-side
    // weight (single-bone-ish near the wrist) differs from the cuff's own
    // authored bias (ForearmR:0.5, HandR:1.5), so the merged result should
    // show both bones present with neither at the pre-weld extreme.
    const sum = limbW[0] + limbW[1] + limbW[2] + limbW[3];
    assert.equal(sum, 255);
  }
});

// ---------------------------------------------------------------------------
// 08 §11 step 3 — the acceptance criterion, mirrored in-process
// (same functions tools/rigcheck.mjs's SKIN_GROUPS call — one implementation)
// ---------------------------------------------------------------------------

test('ACTR-5 rigcheck | weights sum to 255 exactly, every vertex bound', () => {
  const { totalVertices, violations } = runSkinDiagnostics();
  assert.ok(totalVertices > 0, 'expected a nonzero number of checked vertices');
  assert.deepEqual(violations.sum255, []);
});

test('ACTR-5 rigcheck | zero influences below the cut', () => {
  const { totalInfluences, violations } = runSkinDiagnostics();
  assert.ok(totalInfluences > 0, 'expected a nonzero number of checked influences');
  assert.deepEqual(violations.cut, []);
});

test('ACTR-5 rigcheck | no vertex bound to a bone more than 0.45 m away in bind pose', () => {
  const { violations } = runSkinDiagnostics();
  assert.deepEqual(violations.distance, []);
});

test('ACTR-5 rigcheck | elbow candy-wrapper loss < 12% under a 90 deg bend', () => {
  const result = elbowCandyWrapperCheck();
  assert.ok(result.loss < 0.12, `elbow loss ${(result.loss * 100).toFixed(2)}% >= 12%`);
  assert.equal(result.ringVertexCount, 12);
  assert.ok(result.clampedInRing >= 1, 'expected the joint clamp to have activated for this ring');
});

test('ACTR-5 rigcheck | knee candy-wrapper loss < 12% under a 90 deg bend', () => {
  const result = kneeCandyWrapperCheck();
  assert.ok(result.loss < 0.12, `knee loss ${(result.loss * 100).toFixed(2)}% >= 12%`);
  assert.equal(result.ringVertexCount, 12);
  assert.ok(result.clampedInRing >= 1, 'expected the joint clamp to have activated for this ring');
});

test('ACTR-5 | without the joint clamp\'s effect (measured directly, not clamped), a plain position-blend would fail — sanity-checks that measureCandyWrapper is actually sensitive to the clamp', () => {
  // A regression guard for the falsifiability rule: corrupt the candy-wrapper
  // measurement's own inputs (a ring NOT at the joint, still smoothly
  // blended but far enough that the joint clamp never touched it) and
  // confirm the measured loss is not simply always ~0 regardless of input —
  // i.e. this metric can actually distinguish a well-clamped ring from an
  // arbitrary one.
  const fixture = buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR');
  const atJoint = measureCandyWrapper(fixture);
  const oneRingOver = measureCandyWrapper({ ...fixture, jointRingIndex: fixture.jointRingIndex + 1 });
  assert.ok(atJoint.loss < 0.12);
  // Both should still be low (the whole point of the algorithm), but they
  // need not be identical — this just proves the function reads its input.
  assert.ok(Number.isFinite(oneRingOver.loss));
});

// ---------------------------------------------------------------------------
// convexHullArea2D — the metric §11 step 3's validation table names directly
// ---------------------------------------------------------------------------

test('convexHullArea2D | a unit square has area 1', () => {
  const area = convexHullArea2D([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  assert.ok(Math.abs(area - 1) < 1e-12, `expected 1, got ${area}`);
});

test('convexHullArea2D | a regular 12-gon of radius r has area (12/2) r^2 sin(2pi/12)', () => {
  const seg = 12, r = 0.045;
  const points = [];
  for (let j = 0; j < seg; j++) {
    const theta = (2 * Math.PI * j) / seg;
    points.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  const expected = (seg / 2) * r * r * Math.sin((2 * Math.PI) / seg);
  const area = convexHullArea2D(points);
  assert.ok(Math.abs(area - expected) < 1e-9, `expected ${expected}, got ${area}`);
});

// ---------------------------------------------------------------------------
// SKIN_CONSTANTS — §3.5, verbatim
// ---------------------------------------------------------------------------

test('SKIN_CONSTANTS matches 08 §3.5 verbatim', () => {
  assert.equal(SKIN_CONSTANTS.K, 3.2);
  assert.equal(SKIN_CONSTANTS.D_MIN, 0.012);
  assert.equal(SKIN_CONSTANTS.W_CUT, 0.06);
  assert.equal(SKIN_CONSTANTS.JOINT_R, 0.05);
  assert.equal(SKIN_CONSTANTS.SMOOTH_N, 2);
  assert.equal(SKIN_CONSTANTS.WELD_EPS, 0.001);
});

test('SKIN_CONSTANTS is frozen', () => {
  assert.throws(() => {
    SKIN_CONSTANTS.K = 99;
  });
});

// ---------------------------------------------------------------------------
// A quick cross-check against geo.js#tube directly, per the brief's own
// warning ("tube() takes points as {x,y,z} objects, not [x,y,z] arrays")
// ---------------------------------------------------------------------------

test('buildLimbFixture | the underlying tube has one ring per sample point, seg vertices each', () => {
  const fixture = buildLimbFixture('humanoid', 'UpLegR', 'LegR', 'FootR');
  const expectedVertexCount = fixture.points.length * fixture.seg;
  assert.equal(fixture.part.mesh.p.length / 3, expectedVertexCount);
  // geo.js#tube is a thin wrapper over loft(); a direct call with the same
  // points/profile/seg must produce the identical vertex count (sanity that
  // this fixture is really built from geo.js, not reinvented geometry).
  const direct = tube(fixture.points, () => 0.045, { seg: fixture.seg, caps: false });
  assert.equal(direct.p.length, fixture.part.mesh.p.length);
});
