// src/world/build/wastes.js
//
// WRLD-6 — the `three` half of the Ashen Wastes T7 "Geometry" stage
// (`07-world-gen.md` §10.2's own table). Consumes `src/world/gen/wastes.js`'s
// plain-data instancing plan (`buildInstancingPlan`) and builds one real
// `THREE.InstancedMesh` per distinct prototype id — `07` §3.4's
// `worldPropDrawCalls = |union of prototypes|`, so draw calls scale with
// prototypes, never with instances.
//
// ---------------------------------------------------------------------------
// D-72 — this is the file where `three` is legal, and the finding this
// ticket must report
// ---------------------------------------------------------------------------
// `src/world/gen/wastes.js`'s own header explains the intended split: `gen/`
// stays headless (no `three`), `build/` is where `three` is legal, so a
// gen/-side lint sweep never sees an import of it. That is true for
// `gen/wastes.js` itself. It is NOT sufficient for THIS file: measured
// directly against the shipped `tools/check-imports.mjs` (not edited here —
// out of this ticket's file grant), the `world` root
// (`{ path: 'src/world', checkThree: true, checkGlobals: true }`) has no
// `exclude` entry, and `collectFiles` walks EVERY `.js` file under `src/
// world/` recursively, INCLUDING this one — so this file is swept as a SEED
// of the existing `world` root and fails `check-imports` on its own `three`
// import, regardless of whether anything ever imports it. Reproduced with
// `node tools/check-imports.mjs --root <tmp>/src` against a synthetic
// `src/world/build/probe.js` importing `three`: `FAIL ... imports 'three'`.
//
// The fix that already exists in this exact tool for exactly this shape is
// `src/actors/archetypes/`'s (D-13/ACTR-6): the parent root
// (`src/actors`) gets `exclude: [archetypesDir]`, and a SEPARATE
// `declaredRoots` entry is added for `archetypesDir` with `checkThree:
// false`. The identical fix — `exclude: [buildDir]` on the `world` root,
// plus a new entry for `src/world/build` with `checkThree: false,
// checkGlobals: true` — would make this split real. `tools/check-imports.mjs`
// is not in this ticket's file grant (rule 1: "you own only the files
// listed... say so, do not edit it"), so this file is shipped as specified
// and this conflict is reported, not silently patched around. See this
// ticket's report for the full disclosure and the exact `npm run lint`
// failure this produces today.
//
// ---------------------------------------------------------------------------
// Placeholder geometry, on purpose — no per-prototype mesh art exists yet
// ---------------------------------------------------------------------------
// `docs/ARCHITECTURE.md`'s "No external art assets" rule means every
// prototype's real mesh must eventually be procedurally generated, the same
// way `src/actors/archetypes/` builds a skinned mesh from primitives. No
// such per-prototype generator exists anywhere in this codebase today for
// world props (`dead_tree_tall`, `ruin_arch`, `chest_iron`, …) — authoring
// 28 distinct procedural prop generators is its own ticket's scope, not
// this one's (WRLD-6 is zone LAYOUT/dressing/boundary, not prop art). This
// file builds simple, deterministic PLACEHOLDER primitives (a box scaled to
// each prototype's own `spacing`/`topY`) so the pipeline (instancing,
// draw-call count, I9, the two blessed shots) is real and provable end to
// end — but the actual rendered triangle count of a placeholder box (12) is
// not a meaningful stand-in for a real mesh's `07` §9.2 `tris` figure.
// Criterion 2's triangle accounting therefore uses the CATALOGUE's own
// `tris` value (data, `07` §9.2, verbatim) per instance — the authoritative
// budget number a future real mesh must land under — not this placeholder's
// actual (trivially low) geometry cost. Both numbers are reported; see this
// ticket's report.

import * as THREE from 'three';

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scaleVec = new THREE.Vector3();
const _posVec = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** One shared placeholder geometry per (roughly) size class, cached by a
 * `w|h|d` key so the many prototypes that happen to share a footprint don't
 * each allocate their own `BufferGeometry` — kept modest, this is a one-time
 * zone-build cost (`Alloc: yes`, "between frames" — see `07` §10.2 T7),
 * never a per-frame allocation (rule 5). */
const _geometryCache = new Map();
function boxGeometry(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let g = _geometryCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    _geometryCache.set(key, g);
  }
  return g;
}

/** `07` §9.1's nine material keys -> a plain tint colour (ASSIGNED — no
 * spec value gives an RGB; picked to read distinctly per group in a shot,
 * see this ticket's report). Built via `materials.get(key, {color})`, the
 * plain-tinted path (`src/materials/index.js`'s own `get()` doc) — never
 * `materials.makeSurface()`, whose `SURFACE_IDS` is a five-value ground-only
 * list (`stone/dirt/grass/ash/bone`) that does not cover `wood`/`metal`,
 * several of these groups' natural material. */
const GROUP_COLOR = Object.freeze({
  G1: 0x4a3f2c, // flora — dead wood
  G2: 0x8a8074, // rubble — ash rock
  G3: 0x7d7666, // ruin — worked stone
  G4: 0xd8cdb8, // bone
  G5: 0x6b4a33, // camp — cloth/wood
  G6: 0x5d5442, // container — mixed
  _boundary: 0x726a5c, // ridge_slab
});

const GROUP_MATERIAL_KEY = Object.freeze({
  G1: 'wastes_deadwood',
  G2: 'wastes_ashrock',
  G3: 'stone_ruin',
  G4: 'bone_field',
  G5: 'camp_cloth',
  G6: 'container_mixed',
  G9: 'silhouette',
  _boundary: 'ridge_slab_stone',
});

function materialFor(materials, group) {
  const key = GROUP_MATERIAL_KEY[group] || 'wastes_generic';
  return materials.get(key, { color: GROUP_COLOR[group] !== undefined ? GROUP_COLOR[group] : 0x808080 });
}

/**
 * Builds one `THREE.InstancedMesh` per distinct prototype bucket in `plan`
 * (`src/world/gen/wastes.js#buildInstancingPlan`'s output) and adds them,
 * grouped under one `THREE.Group`, to `ctx.scene`. `Alloc: yes` — this runs
 * once per `enterZone`, at T7, never per frame (rule 5's "between frames"
 * carve-out, the same one `staticFootprints`/`buildHeightField` already use).
 *
 * @param {object} ctx - the engine context (`ctx.get('materials')`, `ctx.scene`).
 * @param {ReturnType<typeof import('../gen/wastes.js').buildInstancingPlan>} plan
 * @returns {{group: THREE.Group, meshes: THREE.InstancedMesh[], drawCalls: number, triangles: number, budgetedTriangles: number}}
 */
export function buildWastesGeometry(ctx, plan) {
  const materials = ctx.get('materials');
  const group = new THREE.Group();
  group.name = 'wastes_dressing';
  const meshes = [];
  let triangles = 0;
  let budgetedTriangles = 0;

  for (const bucket of plan) {
    const count = bucket.instances.length;
    if (count === 0) continue;

    const isFar = bucket.protoId === 'far_spire' || bucket.protoId === 'far_ridge';
    const isWall = bucket.protoId === 'ridge_slab';

    const material = materialFor(materials, bucket.group);
    const geometry = boxGeometry(1, 1, 1); // unit box — real dimensions come from the instance scale matrix below
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = bucket.protoId;

    for (let i = 0; i < count; i++) {
      const inst = bucket.instances[i];
      let w, h, d;
      if (isWall) {
        w = inst.halfW * 2;
        d = inst.halfL * 2;
        h = inst.topY;
      } else {
        const footprint = Math.max(0.3, bucket.tris > 0 ? Math.sqrt(bucket.tris) / 10 : 1); // crude, deterministic size stand-in
        w = footprint * inst.scale;
        d = footprint * inst.scale;
        h = (inst.topY || 1) * inst.scale;
      }
      _scaleVec.set(w, h, d);
      _posVec.set(inst.x, inst.y + h / 2, inst.z);
      _quat.setFromAxisAngle(_up, inst.facing || 0);
      _matrix.compose(_posVec, _quat, _scaleVec);
      mesh.setMatrixAt(i, _matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    if (isFar) {
      mesh.userData.noShadow = true;
      mesh.userData.noPrepass = true;
    }

    group.add(mesh);
    meshes.push(mesh);
    triangles += 12 * count; // real placeholder geometry cost (a box) — see file header
    budgetedTriangles += bucket.tris * count; // catalogue-declared cost — the real acceptance number
  }

  ctx.scene.add(group);

  return { group, meshes, drawCalls: meshes.length, triangles, budgetedTriangles };
}

/**
 * Builds the ash berm's own single, non-instanced visual mesh — one merged
 * `BufferGeometry` covering every berm segment `runR9Boundary` returned.
 * Purely visual (no `Footprint`, no nav — `07` §3.2 R9's own text). One
 * `THREE.Mesh`, one draw call, added to the same `wastes_dressing` group.
 * @param {object} ctx
 * @param {THREE.Group} group
 * @param {object[]} bermSegments
 * @returns {THREE.Mesh|null}
 */
export function buildAshBerm(ctx, group, bermSegments) {
  if (!bermSegments || bermSegments.length === 0) return null;
  const materials = ctx.get('materials');
  const material = materials.get('wastes_ash_berm', { color: 0x3a352d });

  const positions = [];
  const indices = [];
  for (const seg of bermSegments) {
    const w = seg.halfW, l = seg.halfL, top = seg.topY;
    const base = positions.length / 3;
    // A simple sloped berm cross-section: four corners at ground level, rising to `top` on the inward edge.
    positions.push(
      seg.x - w, 0, seg.z - l,
      seg.x + w, 0, seg.z - l,
      seg.x + w, top, seg.z + l,
      seg.x - w, top, seg.z + l,
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ash_berm';
  group.add(mesh);
  return mesh;
}
