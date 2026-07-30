// tests/actors/geo.test.js
//
// ACTR-4 acceptance tests for src/actors/geo.js — `08 §11 step 2`, verbatim:
// "Node self-test: no NaN, no degenerate triangle (area < 1e-9), no
// duplicate index triple, triangle counts within +-5% of §3.2." Plus §3.2's
// own dense-column reconciliation (torso/pelvis/arm/shoulder-cap/hand/
// leg/foot/neck/head, summing to 1 304) and coverage of every §3.1 function.
//
// `node:test` + `node:assert/strict` only (12-testing.md P6). This is a
// correctness test (no time/allocation/frame assertion), so it is named
// `geo.test.js`, not `geo.perf.test.js` (D-11).
//
// Falsifiability (rule 12 of this ticket's brief): the self-test below
// prints how many meshes, vertices and triangles it actually validated, so
// a hollow "0 failures" can never be mistaken for "0 checks" — mirroring
// `tools/rigcheck.mjs`'s own reporting convention (see that file).
//
// Scope: geo.js only. The actual per-archetype assembly (§3.3, which parts
// get which exact `hx`/`hy`/`hz`/rings/seg and how they connect into one
// body) is a later ticket, out of this ticket's reading list and out of
// this file's job — the part-list numbers below exist ONLY to reconcile
// this ticket's toolkit against §3.2's documented arithmetic, not to stand
// in for the real character-assembly module.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loft,
  tube,
  revolve,
  ellipsoid,
  boxRound,
  ribbon,
  spineRow,
  superEllipse,
  computeNormals,
  weldNormals,
  displace,
  warp,
  transformMesh,
  mirrorX,
  appendMesh,
} from '../../src/actors/geo.js';

// ---------------------------------------------------------------------------
// The falsifiable validator — no NaN, no degenerate triangle, no duplicate
// index triple. Returns counts, not just booleans, so a caller can print
// "how much was actually checked" per the brief's falsifiability rule.
// ---------------------------------------------------------------------------

function triangleArea(mesh, ia, ib, ic) {
  const ax = mesh.p[ia * 3], ay = mesh.p[ia * 3 + 1], az = mesh.p[ia * 3 + 2];
  const bx = mesh.p[ib * 3], by = mesh.p[ib * 3 + 1], bz = mesh.p[ib * 3 + 2];
  const cx = mesh.p[ic * 3], cy = mesh.p[ic * 3 + 1], cz = mesh.p[ic * 3 + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const fx = e1y * e2z - e1z * e2y;
  const fy = e1z * e2x - e1x * e2z;
  const fz = e1x * e2y - e1y * e2x;
  return 0.5 * Math.sqrt(fx * fx + fy * fy + fz * fz);
}

/**
 * @param {object} mesh
 * @param {string} label
 * @returns {{ label, vertCount, triCount, violations: string[] }}
 */
function validateMesh(mesh, label) {
  const violations = [];
  const vertCount = mesh.p.length / 3;
  const triCount = mesh.i.length / 3;

  // No NaN in position, normal or uv.
  for (const [arrName, arr] of [['p', mesh.p], ['n', mesh.n], ['uv', mesh.uv]]) {
    for (let k = 0; k < arr.length; k++) {
      if (!Number.isFinite(arr[k])) violations.push(`${label}: ${arrName}[${k}] is not finite (${arr[k]})`);
    }
  }

  // No degenerate triangle (area < 1e-9), no self-duplicate index within a
  // triangle, no duplicate face (same 3 indices, any order) anywhere in
  // the mesh.
  const seenFaces = new Set();
  for (let f = 0; f < mesh.i.length; f += 3) {
    const ia = mesh.i[f], ib = mesh.i[f + 1], ic = mesh.i[f + 2];
    if (ia === ib || ib === ic || ia === ic) {
      violations.push(`${label}: triangle #${f / 3} has a duplicate index triple (${ia},${ib},${ic})`);
      continue;
    }
    const area = triangleArea(mesh, ia, ib, ic);
    if (!(area >= 1e-9)) {
      violations.push(`${label}: triangle #${f / 3} (${ia},${ib},${ic}) has area ${area} < 1e-9`);
    }
    const sorted = [ia, ib, ic].sort((a, b) => a - b).join(',');
    if (seenFaces.has(sorted)) {
      violations.push(`${label}: triangle #${f / 3} (${ia},${ib},${ic}) duplicates an earlier face`);
    }
    seenFaces.add(sorted);
  }

  return { label, vertCount, triCount, violations };
}

// ---------------------------------------------------------------------------
// §3.2's dense-column body kit — reconciles this ticket's toolkit against
// the documented formula `tris = (rings-1)*seg*2 + caps*seg` for every row
// that uses `tube`/`ellipsoid`/`boxRound`, and sums to 1 304.
// ---------------------------------------------------------------------------

function flatProfile(t) {
  // A constant-radius profile — enough to exercise `tube`'s taper curve
  // without collapsing any ring (no part in §3.2's table is a point-taper).
  return 0.08 - 0.01 * Math.sin(Math.PI * t); // gentle taper, never 0
}

function straightPolyline(count, length) {
  const pts = new Array(count);
  for (let i = 0; i < count; i++) pts[i] = { x: 0, y: (length * i) / (count - 1), z: 0 };
  return pts;
}

// `count` is how many instances of that part exist in the shared humanoid
// body (torso/pelvis/neck/head are singular; arm/shoulder-cap/hand/leg/foot
// are paired, §3.2's "x2" rows). `expectTris` is the PER-INSTANCE count —
// the table's "tris" column divided by `count`.
const BODY_KIT = [
  { label: 'torso', count: 1, build: () => tube(straightPolyline(8, 0.55), flatProfile, { seg: 12 }), expectTris: 168 },
  { label: 'pelvis', count: 1, build: () => tube(straightPolyline(4, 0.2), flatProfile, { seg: 12 }), expectTris: 72 },
  { label: 'arm', count: 2, build: () => tube(straightPolyline(8, 0.5), flatProfile, { seg: 8 }), expectTris: 112 },
  { label: 'shoulder cap', count: 2, build: () => ellipsoid(0.08, 0.08, 0.08, { rings: 5, seg: 10 }), expectTris: 80 },
  { label: 'hand', count: 2, build: () => boxRound(0.05, 0.09, 0.03, { seg: 6, rings: 4 }), expectTris: 48 },
  { label: 'leg', count: 2, build: () => tube(straightPolyline(9, 0.85), flatProfile, { seg: 9 }), expectTris: 144 },
  { label: 'foot', count: 2, build: () => boxRound(0.05, 0.04, 0.12, { seg: 6, rings: 4 }), expectTris: 48 },
  { label: 'neck', count: 1, build: () => tube(straightPolyline(3, 0.1), flatProfile, { seg: 8 }), expectTris: 32 },
  { label: 'head', count: 1, build: () => ellipsoid(0.09, 0.11, 0.09, { rings: 8, seg: 12 }), expectTris: 168 },
];

test('ACTR-4 §3.2 | every body-kit part hits its EXACT documented per-instance triangle count, full body sums to 1304', () => {
  let fullTotal = 0;
  for (const part of BODY_KIT) {
    const mesh = part.build();
    const triCount = mesh.i.length / 3;
    assert.equal(triCount, part.expectTris, `${part.label}: expected ${part.expectTris} tris/instance, got ${triCount}`);
    fullTotal += triCount * part.count;
  }
  assert.equal(fullTotal, 1304, `full body total ${fullTotal} != §3.2's documented 1304`);
});

test('ACTR-4 §11 step 2 | body-kit self-test: no NaN, no degenerate triangle, no duplicate index triple, counts within ±5% of §3.2', () => {
  const results = BODY_KIT.map((part) => ({ ...part, ...validateMesh(part.build(), part.label) }));
  let totalVerts = 0, totalTris = 0, totalViolations = 0, fullBodyTotal = 0;
  for (const r of results) {
    totalVerts += r.vertCount;
    totalTris += r.triCount;
    totalViolations += r.violations.length;
    fullBodyTotal += r.triCount * r.count;
    for (const v of r.violations) console.error(`FAIL geo.test ${v}`);
  }
  console.log(
    `geo.test.js body-kit self-test  meshes=${results.length}  vertices=${totalVerts}  triangles=${totalTris}  violations=${totalViolations}`,
  );
  assert.equal(totalViolations, 0, `${totalViolations} violation(s) found — see FAIL lines above`);

  const expectedTotal = 1304;
  const pct = (Math.abs(fullBodyTotal - expectedTotal) / expectedTotal) * 100;
  console.log(`  full-body assembled total=${fullBodyTotal}  expected=${expectedTotal}  delta=${pct.toFixed(3)}%`);
  assert.ok(pct <= 5, `full-body total ${fullBodyTotal} is ${pct.toFixed(2)}% off §3.2's 1304 (limit 5%)`);
});

// ---------------------------------------------------------------------------
// revolve — the acceptance criterion names it explicitly. Not in §3.2's
// table (it belongs to §3.3's per-archetype parts, out of this ticket's
// reading list), so verified against the general loft formula instead of a
// table row: tris = (rings-1)*seg*2, no caps by default.
// ---------------------------------------------------------------------------

test('ACTR-4 §3.1 | revolve produces (rings-1)*seg*2 triangles, matching the loft formula', () => {
  const profile = [
    [0.02, 0.0],
    [0.1, 0.05],
    [0.12, 0.12],
    [0.08, 0.2],
    [0.03, 0.24],
  ];
  const seg = 14;
  const mesh = revolve(profile, seg);
  const expected = (profile.length - 1) * seg * 2;
  assert.equal(mesh.i.length / 3, expected);
  const { violations, vertCount, triCount } = validateMesh(mesh, 'revolve-helm');
  console.log(`  revolve self-test  vertices=${vertCount}  triangles=${triCount}  violations=${violations.length}`);
  assert.equal(violations.length, 0, violations.join('; '));
});

test('ACTR-4 | revolve accepts {r,y} objects as well as [r,y] pairs, identical result', () => {
  const seg = 8;
  const asArrays = revolve([[0.05, 0], [0.08, 0.1], [0.04, 0.2]], seg);
  const asObjects = revolve([{ r: 0.05, y: 0 }, { r: 0.08, y: 0.1 }, { r: 0.04, y: 0.2 }], seg);
  assert.deepEqual(asArrays.p, asObjects.p);
  assert.deepEqual(asArrays.i, asObjects.i);
});

// ---------------------------------------------------------------------------
// spineRow — also named explicitly in the acceptance criterion. Verified
// against this ticket's own documented cone arithmetic (decision 6):
// n * 2 * seg triangles, n * (seg+2) vertices.
// ---------------------------------------------------------------------------

test('ACTR-4 §3.1 | spineRow produces n*2*seg triangles (n capped cones), no degeneracy', () => {
  const path = [
    { x: 0, y: 1.0, z: -0.05 },
    { x: 0, y: 1.1, z: -0.08 },
    { x: 0, y: 1.2, z: -0.09 },
    { x: 0, y: 1.3, z: -0.07 },
  ];
  const n = 6;
  const seg = 6;
  const mesh = spineRow(path, n, (i, count) => 1 - (0.5 * i) / count, { seg });
  assert.equal(mesh.i.length / 3, n * 2 * seg);
  assert.equal(mesh.p.length / 3, n * (seg + 2));
  const { violations, vertCount, triCount } = validateMesh(mesh, 'spineRow-ribcage');
  console.log(`  spineRow self-test  vertices=${vertCount}  triangles=${triCount}  violations=${violations.length}`);
  assert.equal(violations.length, 0, violations.join('; '));
});

test('ACTR-4 | spineRow honours a bare-number scaleFn as a uniform radius+length scale', () => {
  const path = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0.2, z: 0 }];
  const mesh = spineRow(path, 1, () => 2, { seg: 6, baseRadius: 0.01, baseLength: 0.02 });
  // Apex is base + tangent*length; with n=1 the single sample sits at t=0
  // (the path start), tangent pointing +Y, length = baseLength*2 = 0.04.
  const apexIdx = 6; // seg ring vertices [0..5], apex is vertex 6
  assert.ok(Math.abs(mesh.p[apexIdx * 3 + 1] - 0.04) < 1e-9, `apex y=${mesh.p[apexIdx * 3 + 1]}, expected 0.04`);
});

// ---------------------------------------------------------------------------
// loft — direct coverage of the core, both the general (open, no-cap) case
// and the capped case, including the exact `+seg` cap contribution.
// ---------------------------------------------------------------------------

function circleRing(radius, y, seg) {
  const ring = new Array(seg);
  for (let j = 0; j < seg; j++) {
    const theta = (2 * Math.PI * j) / seg;
    ring[j] = { x: radius * Math.cos(theta), y, z: radius * Math.sin(theta) };
  }
  return ring;
}

test('ACTR-4 §3.2 | loft: (rings-1)*seg*2 uncapped, +seg per capped end', () => {
  const seg = 10;
  const rings = [circleRing(0.1, 0, seg), circleRing(0.1, 0.2, seg), circleRing(0.1, 0.4, seg)];
  const uncapped = loft(rings);
  assert.equal(uncapped.i.length / 3, (rings.length - 1) * seg * 2);

  const startOnly = loft(rings, { caps: { start: true, end: false } });
  assert.equal(startOnly.i.length / 3, (rings.length - 1) * seg * 2 + seg);

  const bothCapped = loft(rings, { caps: true });
  assert.equal(bothCapped.i.length / 3, (rings.length - 1) * seg * 2 + 2 * seg);
  assert.equal(bothCapped.p.length / 3, rings.length * seg + 2);
});

test('ACTR-4 | loft throws on fewer than 2 rings, fewer than 3 points, or mismatched ring lengths', () => {
  assert.throws(() => loft([circleRing(0.1, 0, 8)]));
  assert.throws(() => loft([[{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }]]));
  assert.throws(() => loft([circleRing(0.1, 0, 8), circleRing(0.1, 0.1, 6)]));
});

// ---------------------------------------------------------------------------
// tube — taper curve actually tapers; parallel-transport frames don't
// produce NaN on a bent polyline (not just a straight one).
// ---------------------------------------------------------------------------

test('ACTR-4 | tube: profileFn controls per-ring radius (a real taper, not a fixed cylinder)', () => {
  const points = straightPolyline(6, 0.5);
  const mesh = tube(points, (t) => 0.1 * (1 - 0.5 * t), { seg: 8 });
  // Ring 0's first vertex should sit at radius ~0.1 from the axis; the last
  // ring's at ~0.05 — i.e. genuinely different, not a uniform cylinder.
  const seg = 8;
  const r0 = Math.sqrt(mesh.p[0] ** 2 + mesh.p[2] ** 2);
  const lastRingStart = (points.length - 1) * seg;
  const rLast = Math.sqrt(mesh.p[lastRingStart * 3] ** 2 + mesh.p[lastRingStart * 3 + 2] ** 2);
  assert.ok(Math.abs(r0 - 0.1) < 1e-9, `r0=${r0}`);
  assert.ok(Math.abs(rLast - 0.05) < 1e-9, `rLast=${rLast}`);
});

test('ACTR-4 | tube: a bent polyline (parallel-transport frames) produces no NaN and no degenerate triangle', () => {
  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0.2, z: 0.05 },
    { x: 0.05, y: 0.4, z: 0.1 },
    { x: 0.15, y: 0.55, z: 0.12 },
    { x: 0.3, y: 0.6, z: 0.1 },
  ];
  const mesh = tube(points, () => 0.05, { seg: 8 });
  const { violations, vertCount, triCount } = validateMesh(mesh, 'tube-bent');
  console.log(`  tube (bent path) self-test  vertices=${vertCount}  triangles=${triCount}  violations=${violations.length}`);
  assert.equal(violations.length, 0, violations.join('; '));
});

// ---------------------------------------------------------------------------
// ellipsoid — never capped, never degenerate even with default v0/v1 (the
// exact-pole case decision 3 exists to guard against).
// ---------------------------------------------------------------------------

test('ACTR-4 | ellipsoid: default v0=0/v1=1 (a "full" sphere) is still non-degenerate — no pole collapse', () => {
  const mesh = ellipsoid(0.1, 0.12, 0.1, { rings: 6, seg: 10 });
  const { violations } = validateMesh(mesh, 'ellipsoid-full');
  assert.equal(violations.length, 0, violations.join('; '));
  assert.equal(mesh.i.length / 3, (6 - 1) * 10 * 2);
});

test('ACTR-4 | ellipsoid: a clamped latitude band (v0/v1 both interior) matches the same formula', () => {
  const mesh = ellipsoid(0.08, 0.08, 0.08, { v0: 0.2, v1: 0.8, rings: 5, seg: 10 });
  assert.equal(mesh.i.length / 3, (5 - 1) * 10 * 2);
});

// ---------------------------------------------------------------------------
// boxRound — capped both ends by default, honours the `n` roundness knob.
// ---------------------------------------------------------------------------

test('ACTR-4 | boxRound: default rings=4/seg=6, capped both ends, hits the hand/foot 48', () => {
  const mesh = boxRound(0.05, 0.09, 0.03);
  assert.equal(mesh.i.length / 3, 48);
  const { violations } = validateMesh(mesh, 'boxRound-default');
  assert.equal(violations.length, 0, violations.join('; '));
});

test('ACTR-4 | boxRound: n=2 (superellipse) gives a rounder cross-section than n=8', () => {
  const round = boxRound(0.1, 0.2, 0.1, { n: 2, seg: 12 });
  const boxy = boxRound(0.1, 0.2, 0.1, { n: 8, seg: 12 });
  // Sample the profile directly: at 45 degrees, an ellipse (n=2) sits well
  // inside the corner a rounded box (n=8) reaches toward.
  const p2 = superEllipse(0.1, 0.1, 2, 8)[1];
  const p8 = superEllipse(0.1, 0.1, 8, 8)[1];
  assert.ok(Math.abs(p8.x) >= Math.abs(p2.x) - 1e-9);
  assert.equal(round.i.length / 3, boxy.i.length / 3); // topology unaffected by `n`
});

// ---------------------------------------------------------------------------
// ribbon
// ---------------------------------------------------------------------------

test('ACTR-4 | ribbon: flat extrusion, closed rectangle cross-section, no degeneracy', () => {
  const points = straightPolyline(5, 0.4);
  const mesh = ribbon(points, 0.06, 0.01, { upright: true });
  assert.equal(mesh.i.length / 3, (points.length - 1) * 4 * 2);
  const { violations } = validateMesh(mesh, 'ribbon');
  assert.equal(violations.length, 0, violations.join('; '));
});

test('ACTR-4 | ribbon: upright frames stay perpendicular to the path even as it curves', () => {
  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 0.1, y: 0.1, z: 0 },
    { x: 0.2, y: 0.05, z: 0.1 },
  ];
  const mesh = ribbon(points, 0.05, 0.02, { upright: true });
  const { violations } = validateMesh(mesh, 'ribbon-curved');
  assert.equal(violations.length, 0, violations.join('; '));
});

// ---------------------------------------------------------------------------
// superEllipse
// ---------------------------------------------------------------------------

test('ACTR-4 | superEllipse: n=2 is a true ellipse (x/rx)^2 + (z/rz)^2 == 1', () => {
  const pts = superEllipse(0.2, 0.1, 2, 16);
  for (const p of pts) {
    const val = (p.x / 0.2) ** 2 + (p.z / 0.1) ** 2;
    assert.ok(Math.abs(val - 1) < 1e-9, `point ${JSON.stringify(p)} not on the ellipse (${val})`);
  }
});

test('ACTR-4 | superEllipse: returns exactly seg points, all finite', () => {
  const pts = superEllipse(0.15, 0.15, 6, 12);
  assert.equal(pts.length, 12);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x));
    assert.ok(Number.isFinite(p.z));
  }
});

// ---------------------------------------------------------------------------
// Post-ops
// ---------------------------------------------------------------------------

test('ACTR-4 | computeNormals: every normal is unit length after recompute', () => {
  const mesh = tube(straightPolyline(5, 0.3), () => 0.05, { seg: 8 });
  computeNormals(mesh);
  for (let i = 0; i < mesh.n.length / 3; i++) {
    const x = mesh.n[i * 3], y = mesh.n[i * 3 + 1], z = mesh.n[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    assert.ok(Math.abs(len - 1) < 1e-6, `vertex ${i} normal length ${len}`);
  }
});

test('ACTR-4 | weldNormals: coincident vertices from two appended meshes get the same averaged normal', () => {
  const segA = tube([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0.2, z: 0 }], () => 0.05, { seg: 6 });
  const segB = tube([{ x: 0, y: 0.2, z: 0 }, { x: 0, y: 0.4, z: 0 }], () => 0.05, { seg: 6 });
  const merged = appendMesh(segA, segB);
  weldNormals(merged, 1e-4);
  // segA's ring 1 (indices 6..11) and segB's ring 0 (offset by segA's vertex
  // count, same 6 indices) sit at the same positions — after welding their
  // normals must match exactly.
  const aRing1Start = 6;
  const bOffset = segA.p.length / 3;
  for (let j = 0; j < 6; j++) {
    const ai = aRing1Start + j;
    const bi = bOffset + j;
    assert.ok(Math.abs(merged.p[ai * 3] - merged.p[bi * 3]) < 1e-9, 'sanity: positions should coincide');
    assert.equal(merged.n[ai * 3], merged.n[bi * 3]);
    assert.equal(merged.n[ai * 3 + 1], merged.n[bi * 3 + 1]);
    assert.equal(merged.n[ai * 3 + 2], merged.n[bi * 3 + 2]);
  }
});

test('ACTR-4 | displace: moves each vertex along its own normal by fn(i,p,n)', () => {
  const mesh = ellipsoid(0.1, 0.1, 0.1, { rings: 4, seg: 8 });
  const before = mesh.p.slice();
  const beforeN = mesh.n.slice();
  displace(mesh, () => 0.01); // deterministic, not Math.random — rule 3
  for (let i = 0; i < mesh.p.length / 3; i++) {
    const expectedX = before[i * 3] + beforeN[i * 3] * 0.01;
    const expectedY = before[i * 3 + 1] + beforeN[i * 3 + 1] * 0.01;
    const expectedZ = before[i * 3 + 2] + beforeN[i * 3 + 2] * 0.01;
    assert.ok(Math.abs(mesh.p[i * 3] - expectedX) < 1e-12);
    assert.ok(Math.abs(mesh.p[i * 3 + 1] - expectedY) < 1e-12);
    assert.ok(Math.abs(mesh.p[i * 3 + 2] - expectedZ) < 1e-12);
  }
});

test('ACTR-4 | warp: arbitrary per-vertex remap, e.g. squashing Y to 0', () => {
  const mesh = boxRound(0.05, 0.05, 0.05, { seg: 6, rings: 4 });
  warp(mesh, (i, p) => ({ x: p.x, y: 0, z: p.z }));
  for (let i = 0; i < mesh.p.length / 3; i++) {
    assert.equal(mesh.p[i * 3 + 1], 0);
  }
});

test('ACTR-4 | transformMesh: translation moves every vertex by the same offset', () => {
  const mesh = tube(straightPolyline(3, 0.1), () => 0.02, { seg: 6 });
  const before = mesh.p.slice();
  transformMesh(mesh, { pos: { x: 1, y: 2, z: 3 } });
  for (let i = 0; i < mesh.p.length / 3; i++) {
    assert.ok(Math.abs(mesh.p[i * 3] - (before[i * 3] + 1)) < 1e-9);
    assert.ok(Math.abs(mesh.p[i * 3 + 1] - (before[i * 3 + 1] + 2)) < 1e-9);
    assert.ok(Math.abs(mesh.p[i * 3 + 2] - (before[i * 3 + 2] + 3)) < 1e-9);
  }
});

test('ACTR-4 | transformMesh: 90-degree rotation about Y maps +Z to +X', () => {
  const mesh = { p: [0, 0, 1], n: [0, 0, 1], uv: [0, 0], i: [] };
  const halfAngle = Math.PI / 4; // 90 degrees total
  const quat = { x: 0, y: Math.sin(halfAngle), z: 0, w: Math.cos(halfAngle) };
  transformMesh(mesh, { quat });
  assert.ok(Math.abs(mesh.p[0] - 1) < 1e-9, `x=${mesh.p[0]}`);
  assert.ok(Math.abs(mesh.p[2] - 0) < 1e-9, `z=${mesh.p[2]}`);
});

test('ACTR-4 | mirrorX: flips x, preserves triangle count and non-degeneracy, keeps winding outward', () => {
  const mesh = tube(straightPolyline(6, 0.3), () => 0.05, { seg: 8 });
  const triCountBefore = mesh.i.length / 3;
  const beforeX = mesh.p.filter((_, k) => k % 3 === 0);
  mirrorX(mesh);
  assert.equal(mesh.i.length / 3, triCountBefore);
  for (let i = 0; i < mesh.p.length / 3; i++) {
    assert.ok(Math.abs(mesh.p[i * 3] - -beforeX[i]) < 1e-12);
  }
  const { violations } = validateMesh(mesh, 'mirrorX');
  assert.equal(violations.length, 0, violations.join('; '));
});

test('ACTR-4 | appendMesh: vertex/triangle counts add, b\'s indices are offset by a\'s vertex count, inputs untouched', () => {
  const a = boxRound(0.05, 0.05, 0.05, { seg: 6, rings: 4 });
  const b = boxRound(0.03, 0.03, 0.03, { seg: 6, rings: 4 });
  const aVertsBefore = a.p.length / 3;
  const bVertsBefore = b.p.length / 3;
  const merged = appendMesh(a, b);
  assert.equal(merged.p.length / 3, aVertsBefore + bVertsBefore);
  assert.equal(merged.i.length / 3, a.i.length / 3 + b.i.length / 3);
  // b's first triangle's indices, offset.
  assert.equal(merged.i[a.i.length], b.i[0] + aVertsBefore);
  // Inputs are not mutated.
  assert.equal(a.p.length / 3, aVertsBefore);
  assert.equal(b.p.length / 3, bVertsBefore);
  const { violations } = validateMesh(merged, 'appendMesh');
  assert.equal(violations.length, 0, violations.join('; '));
});

// ---------------------------------------------------------------------------
// No `taper` export — the backlog's wording is `tube`'s taper curve, not a
// separate function (per this ticket's brief).
// ---------------------------------------------------------------------------

test('ACTR-4 | there is no exported `taper` function — "taper" is tube\'s profileFn, not a separate export', async () => {
  const mod = await import('../../src/actors/geo.js');
  assert.equal(mod.taper, undefined);
});
