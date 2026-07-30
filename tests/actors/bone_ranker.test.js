// tests/actors/bone_ranker.test.js
//
// ACTR-6 acceptance tests for src/actors/archetypes/bone_ranker.js — the Bone
// Ranker's L0 mesh. `node:test` + `node:assert/strict` only (12-testing.md
// P6). This file asserts STRUCTURE (geometry shape, skinning invariants,
// scale, disposal) — it never reads a clock, never measures elapsed time or
// allocation, and never drives a real frame through `capture.mjs`, so per
// D-11 it stays plain `bone_ranker.test.js`, not `.perf.test.js`.
//
// The pixel-measurement half of `08 §11 step 4`'s acceptance criterion
// ("40 ± 3 px wide x 81 ± 4 px tall, 1 draw call") is NOT re-derived here —
// see this ticket's report for why that half cannot be exercised inside this
// repo today (`tools/capture.mjs` never invokes a shot's `setup`, so the
// registered `actor_ranker` dev shot cannot put the Ranker into a captured
// frame yet; that is a `tools/`-owned gap, out of this ticket's file list).
// What IS testable headlessly, and is tested below: the geometry this mesh
// is built from has no groups and one material (the actual mechanism a real
// capture's draw-call count would depend on), and the skeleton/skin data
// feeding it is internally consistent.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from 'three';

import {
  buildBoneRanker,
  spawnBoneRanker,
  BONE_RANKER_HEIGHT_SCALE,
  BONE_RANKER_BULK,
} from '../../src/actors/archetypes/bone_ranker.js';

// ---------------------------------------------------------------------------
// Shape and one-draw-call mechanics (08 §3.4)
// ---------------------------------------------------------------------------

test('ACTR-6 bone_ranker | buildBoneRanker() returns a THREE.SkinnedMesh with one geometry and one material', () => {
  const built = buildBoneRanker();
  try {
    assert.ok(built.mesh instanceof THREE.SkinnedMesh);
    assert.ok(built.geometry instanceof THREE.BufferGeometry);
    assert.equal(built.mesh.geometry, built.geometry);
    assert.equal(Array.isArray(built.mesh.material), false, 'a material array would mean >1 draw call');
    assert.equal(built.mesh.material, built.material);
  } finally {
    built.dispose();
  }
});

test('ACTR-6 bone_ranker | geometry has no groups — an ungrouped geometry is one implicit group, one draw call', () => {
  const built = buildBoneRanker();
  try {
    assert.equal(built.geometry.groups.length, 0);
  } finally {
    built.dispose();
  }
});

test('ACTR-6 bone_ranker | every named attribute is present with the same vertex count', () => {
  const built = buildBoneRanker();
  try {
    const names = ['position', 'normal', 'uv', 'color', 'aSurf', 'skinIndex', 'skinWeight'];
    for (const name of names) {
      const attr = built.geometry.getAttribute(name);
      assert.ok(attr, `missing attribute '${name}'`);
      assert.equal(attr.count, built.vertexCount, `attribute '${name}' count mismatch`);
    }
    assert.ok(built.geometry.index, 'geometry must be indexed');
  } finally {
    built.dispose();
  }
});

test('ACTR-6 bone_ranker | triangle count is a real, falsifiable number, in the right ballpark', () => {
  const built = buildBoneRanker();
  try {
    assert.equal(built.triCount, built.geometry.index.count / 3);
    assert.ok(built.triCount > 0);
    // 08 §3.3's Bone Ranker row: L0 tris 1150 — informational tolerance, not
    // a byte-exact gate (this ticket's own acceptance criterion is the pixel
    // measurement and the draw-call count, not this figure).
    assert.ok(Math.abs(built.triCount - 1150) / 1150 < 0.15, `triCount ${built.triCount} far from the 1150 target`);
  } finally {
    built.dispose();
  }
});

// ---------------------------------------------------------------------------
// No NaN, no degenerate data reaching the GPU-bound buffers
// ---------------------------------------------------------------------------

test('ACTR-6 bone_ranker | no NaN in position or normal', () => {
  const built = buildBoneRanker();
  try {
    const p = built.geometry.getAttribute('position').array;
    const n = built.geometry.getAttribute('normal').array;
    for (let i = 0; i < p.length; i++) assert.ok(Number.isFinite(p[i]), `position[${i}] is not finite`);
    for (let i = 0; i < n.length; i++) assert.ok(Number.isFinite(n[i]), `normal[${i}] is not finite`);
  } finally {
    built.dispose();
  }
});

// ---------------------------------------------------------------------------
// Skinning invariants — mirrors skin.js's own contract (uint8x4, sum 255)
// ---------------------------------------------------------------------------

test('ACTR-6 bone_ranker | every vertex\'s skinWeight sums to exactly 255', () => {
  const built = buildBoneRanker();
  try {
    const sw = built.geometry.getAttribute('skinWeight').array;
    let violations = 0;
    for (let i = 0; i < built.vertexCount; i++) {
      const sum = sw[i * 4] + sw[i * 4 + 1] + sw[i * 4 + 2] + sw[i * 4 + 3];
      if (sum !== 255) violations++;
    }
    assert.equal(violations, 0, `${violations} vertices had a skinWeight sum != 255`);
  } finally {
    built.dispose();
  }
});

test('ACTR-6 bone_ranker | every skinIndex references a real bone of the 22-bone cloakless rig', () => {
  const built = buildBoneRanker();
  try {
    assert.equal(built.skeleton.bones.length, 22);
    assert.equal(built.rig.boneCount, 22);
    const si = built.geometry.getAttribute('skinIndex').array;
    for (let i = 0; i < si.length; i++) {
      assert.ok(si[i] >= 0 && si[i] < 22, `skinIndex ${si[i]} out of range`);
    }
  } finally {
    built.dispose();
  }
});

// ---------------------------------------------------------------------------
// Archetype scale (08 §3.3) — applied to the mesh object, never the bones
// ---------------------------------------------------------------------------

test('ACTR-6 bone_ranker | heightScale/bulk are the mesh\'s own object scale, not baked into any bone', () => {
  const built = buildBoneRanker();
  try {
    assert.equal(built.mesh.scale.x, BONE_RANKER_BULK);
    assert.equal(built.mesh.scale.y, BONE_RANKER_HEIGHT_SCALE);
    assert.equal(built.mesh.scale.z, BONE_RANKER_BULK);
    for (const bone of built.skeleton.bones) {
      assert.equal(bone.scale.x, 1);
      assert.equal(bone.scale.y, 1);
      assert.equal(bone.scale.z, 1);
    }
  } finally {
    built.dispose();
  }
});

test('ACTR-6 bone_ranker | groundOffsetY places the feet at y=0', () => {
  const built = buildBoneRanker();
  try {
    built.mesh.position.set(0, built.groundOffsetY, 0);
    built.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(built.mesh);
    assert.ok(Math.abs(box.min.y) < 1e-6, `feet not grounded: min.y=${box.min.y}`);
  } finally {
    built.dispose();
  }
});

// ---------------------------------------------------------------------------
// Disposal (ARCHITECTURE.md rule 7)
// ---------------------------------------------------------------------------

test('ACTR-6 bone_ranker | dispose() frees the geometry and material', () => {
  const built = buildBoneRanker();
  let geomDisposed = false;
  let matDisposed = false;
  built.geometry.addEventListener('dispose', () => { geomDisposed = true; });
  built.material.addEventListener('dispose', () => { matDisposed = true; });
  built.dispose();
  assert.equal(geomDisposed, true);
  assert.equal(matDisposed, true);
});

// ---------------------------------------------------------------------------
// spawnBoneRanker() — the dev/test convenience, not the spawn-path wiring
// ---------------------------------------------------------------------------

test('ACTR-6 bone_ranker | spawnBoneRanker() adds the mesh to ctx.scene and its dispose() removes it', () => {
  const scene = new THREE.Scene();
  const ctx = { scene };
  const spawned = spawnBoneRanker(ctx, { x: 1, z: -2 });
  try {
    assert.equal(scene.children.includes(spawned.built.mesh), true);
    assert.equal(spawned.built.mesh.position.x, 1);
    assert.equal(spawned.built.mesh.position.z, -2);
  } finally {
    spawned.dispose();
  }
  assert.equal(scene.children.includes(spawned.built.mesh), false);
});
