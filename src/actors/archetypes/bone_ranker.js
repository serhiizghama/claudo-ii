// src/actors/archetypes/bone_ranker.js
//
// ACTR-6 — "One archetype on screen": the Bone Ranker, `08-characters-visual.md`
// §3.3's row (1.70 m, heightScale 0.944, bulk 0.78, lean density, humanoid-22,
// kit: rib cage `spineRow`, skull-with-jaw, kite shield, notched blade, hip
// rags) built into exactly one `THREE.SkinnedMesh` — one shared
// `BufferGeometry`, no geometry groups, one material, one draw call (§3.4).
//
// This is the ONE file under `src/actors/` allowed to import `three` — see
// `tools/check-imports.mjs`'s `src/actors/archetypes/` entry (D-13, this
// ticket's own report) and this file's own header note below. Every other
// file in this directory stays headless; this one cannot (§3.4's draw call
// is a real `three` object; there is no way around that — D-13).
//
// ---------------------------------------------------------------------------
// What this file consumes, unmodified
// ---------------------------------------------------------------------------
// `rig.js` (ACTR-3) — `createSkeleton('humanoid')` returns the frozen,
// cloakless 22-bone skeleton (bindPos/localPos/localQuat, all Float64Array).
// `geo.js` (ACTR-4) — the loft toolkit; every body part and every kit part
// below is one of `tube`/`ellipsoid`/`boxRound`/`ribbon`/`spineRow`.
// `skin.js` (ACTR-5) — `bindSkin(skeleton, parts)`, called ONCE with every
// part in this file so the cross-part seam weld (its step 6) runs over the
// whole actor, not per-part in isolation.
//
// ---------------------------------------------------------------------------
// Coordinate frame and scale — why `heightScale`/`bulk` are a mesh-level
// `scale`, not baked into any part's geometry
// ---------------------------------------------------------------------------
// Every part below is built directly in the rig's own canonical bind-pose
// frame — the same ~1.80 m-tall coordinate system `rig.js#HUMANOID_RAW` is
// authored in (Emberwright's own `heightScale: 1.000` in `08` §3.3 confirms
// that frame IS the archetype table's height-1.80 case). Building parts and
// binding skin weights in that one shared frame keeps every distance
// `skin.js` computes (bone-tail distances, the weld grid, the joint clamp)
// meaningful and untouched by this archetype's own scale.
//
// `heightScale` (0.944) and `bulk` (0.78, "widens X and Z only") are then
// applied as a SINGLE non-uniform `THREE.Object3D.scale` on the returned
// `SkinnedMesh` itself — `mesh.scale.set(bulk, heightScale, bulk)` — not on
// the skeleton's bones and not on any part's vertex data. This is exact, not
// an approximation: a `SkinnedMesh`'s own object transform (position/
// quaternion/scale) is applied to the ALREADY-SKINNED result in the vertex
// shader (`gl_Position = ... * modelViewMatrix * (skin matrix * position)`),
// so scaling the mesh object scales the whole posed/bound result uniformly
// in Y and only in X/Z — precisely "heightScale scales the whole rig
// uniformly; bulk widens X and Z only" (`08` §3.3's own header line, verified
// against `08` L362). The alternative — anisotropically scaling the SKELETON
// itself (e.g. a non-identity `scale` on the root `THREE.Bone`) — would left-
// multiply that scale into every descendant bone's ROTATED local matrix too,
// shearing any bone whose local axes are not aligned with the scale's
// principal axes (a real, well-known non-uniform-scale-plus-rotation
// artifact). Scaling the mesh object instead sidesteps that entirely: no
// bone in this file's skeleton ever carries a non-identity `scale`.
//
// ---------------------------------------------------------------------------
// The merge — §3.4's "one geometry, one group, one draw"
// ---------------------------------------------------------------------------
// Every part (a `geo.js` mesh record `{p,n,uv,i}` plus a skin-binder
// declaration `{bone}` or `{bones,bias}`) is collected into one array, run
// through exactly one `bindSkin()` call, then concatenated in the same
// order into one set of typed arrays and handed to one `THREE.BufferGeometry`
// with no `addGroup()` call at all — an ungrouped `BufferGeometry` renders
// its whole index range as a single implicit group, which is what makes this
// one draw call, not the interleaving of the attributes. Reported deviation
// from §3.4's literal "48 bytes" wording: this file keeps each named
// attribute (`position`/`normal`/`uv`/`color`/`aSurf`/`skinIndex`/
// `skinWeight`) as its own `THREE.BufferAttribute` rather than hand-packing a
// single heterogeneous 48-byte-stride buffer (float32 and uint8 elements
// sharing one `ArrayBuffer` region needs manual `DataView` packing that three
// r180's own attribute system does not read back out again without the same
// manual unpacking on every consumer). Draw-call count and vertex data are
// identical either way — nothing downstream (a shader, `renderer.info`) can
// tell the difference — so this is flagged as a follow-up for whoever wants
// the literal memory-layout win, not a correctness gap in this ticket's own
// acceptance criterion (a pixel measurement and a draw-call count).
//
// ---------------------------------------------------------------------------
// One material — a placeholder, not the character shader
// ---------------------------------------------------------------------------
// `08` §4/§9 (MATL-3/ACTR-9, both out of this ticket's reading list) own the
// real `aSurf`-driven character material (array-texture sampling, tint/rim/
// trim/glow, `prewarmMaterials`). This ticket's acceptance criterion asks for
// "L0, static bind pose, ONE material" — satisfied here with a single
// `THREE.MeshBasicMaterial({ vertexColors: true })`, unlit, ON PURPOSE —
// `src/dev/debugview.js`'s own header documents the exact trap a physically-
// based material (`MeshStandardMaterial`/`MeshPhysicalMaterial`) is here:
// this scene carries ZERO lights (`render.addLight` is unimplemented; `sky`,
// the other plausible light source, does not exist before M8), so a lit
// material renders flat BLACK with nothing to reflect. Confirmed live on
// this ticket, the identical way PLYR-1 first found it: an earlier pass of
// this file used `MeshStandardMaterial` and rendered as a near-invisible
// black silhouette (`capture.mjs`'s own `nonBlankPixels` count barely moved).
// `MeshBasicMaterial` ignores lighting and paints exactly the `color`
// attribute — the only material type guaranteed visible in a zero-light
// scene, per that same precedent. `aSurf` is still populated and present on
// the geometry for MATL-3/ACTR-9 to read later; this file does not attempt
// to interpret it itself (no custom shader, no texture array — none of that
// exists yet). Real lighting (and the real material) arrives with
// `sky`/`RNDR-4` (M8) and MATL-3 — do not "upgrade" this before then, same
// as debugview.js's own instruction.
//
// ---------------------------------------------------------------------------
// Kit parts — §3.3's row, read literally, built with the tools §3.1 gives
// ---------------------------------------------------------------------------
// "rib cage `spineRow`" — `spineRow`'s own doc list (`geo.js`, §3.1's table)
// names "bone spikes, ribs, crowns" as its use case; used here verbatim: a
// row of tapered cone spikes along a path up the spine's front, exactly the
// primitive as accepted in ACTR-4, not a hand-rolled alternative.
// "skull-with-jaw" — the head `ellipsoid` (part of the body-kit subtotal,
// §3.2) plus one small separate `boxRound` jaw, rigid-bound to `Head`.
// "kite shield" — one `boxRound` with `roundY: true`; the cosine rounding
// envelope `geo.js#boxRound` already applies pulls the top and bottom edges
// inward, which reads as a kite/almond silhouette without a dedicated
// primitive.
// "notched blade" — one `boxRound`, oriented from `HandR` along the
// `HandR -> WeaponR` bind direction via a `THREE.Quaternion` (this file's one
// sanctioned use of `three` for a build-time convenience — no per-frame
// cost). No literal notch geometry is carved into the blade's edge — flagged
// here as a documented simplification, not a silent gap: a real notch cut
// needs a non-loft boolean/cut operation `geo.js` does not expose, and
// inventing one was judged out of scope for a single L0 static-mesh ticket.
// "hip rags" — three `ribbon` strips (`upright: true`, so they hang without
// twisting), rigid-bound to `Hips`.
//
// ---------------------------------------------------------------------------
// Bind types — rigid vs smooth, per bone
// ---------------------------------------------------------------------------
// Smooth (2-bone, equal bias — the same shape `skin.js#buildLimbFixture`'s
// own diagnostic already exercises for exactly this joint pair): torso
// (`Hips`/`Spine`/`Chest`), each arm (`UpperArm*`/`Forearm*`), each leg
// (`UpLeg*`/`Leg*`). Rigid (single bone, weight 1 — `08` §1.2's own rule for
// "helms, shields, pauldrons, weapon heads"): pelvis (`Hips`), each shoulder
// cap (`UpperArm*`), each hand (`Hand*`), each foot (`Foot*`), neck (`Neck`),
// head+jaw (`Head`), ribs (`Spine`), shield (`ShieldL` — the rig bone exists
// for exactly this), blade (`WeaponR` — likewise), hip rags (`Hips`).
//
// ---------------------------------------------------------------------------
// Public shape — intra-`src/actors/` only, no `02-api-contracts.md` row
// ---------------------------------------------------------------------------
// `buildBoneRanker()` and `spawnBoneRanker()` are called from *inside*
// `src/actors/` territory (the eventual spawn-path wiring — not this
// ticket's, see the report) and, for now, from `src/dev/shots.js`'s
// dev-only `actor_ranker` shot (the same "a dev/test harness imports an
// actors file directly" pattern `tools/rigcheck.mjs` and every
// `tests/actors/*.test.js` file already use against `rig.js`/`geo.js`/
// `skin.js` — never a runtime subsystem-to-subsystem call, so
// ARCHITECTURE.md rule 2 does not apply). Per `02-api-contracts.md`'s own
// rule ("a public method exists only if this document lists it"), neither
// function needs a row there.

import * as THREE from 'three';

import { createSkeleton } from '../rig.js';
import { tube, ellipsoid, boxRound, ribbon, spineRow, appendMesh, weldNormals } from '../geo.js';
import { bindSkin } from '../skin.js';

// ---------------------------------------------------------------------------
// `08` §3.3's Bone Ranker row, verbatim — named constants, not scattered
// literals (ARCHITECTURE.md rule 9: gameplay/visual numbers live in data).
// ---------------------------------------------------------------------------

export const BONE_RANKER_HEIGHT_M = 1.70;
export const BONE_RANKER_HEIGHT_SCALE = 0.944;
export const BONE_RANKER_BULK = 0.78;
export const BONE_RANKER_RIG_ID = 'humanoid';
export const BONE_RANKER_L0_TRIS_TARGET = 1150; // 08 §3.3 — informational only, not asserted to the byte

// ---------------------------------------------------------------------------
// Small local helpers — this file's own copy, matching the per-file-math
// convention every sibling in `src/actors/` already documents (geo.js's
// header, "each file keeps its own math rather than reaching across").
// ---------------------------------------------------------------------------

function nameToIndexMap(rig) {
  const map = {};
  for (let i = 0; i < rig.boneCount; i++) map[rig.names[i]] = i;
  return map;
}

function boneVec(rig, nameToIndex, name) {
  const i = nameToIndex[name];
  if (i === undefined) throw new Error(`bone_ranker: unknown bone '${name}'`);
  return { x: rig.bindPos[i * 3], y: rig.bindPos[i * 3 + 1], z: rig.bindPos[i * 3 + 2] };
}

function vAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vLerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** `n` evenly parameterised points from `a` to `b` (straight line — every
 * caller below feeds this either a genuinely straight bind-pose segment or a
 * segment whose real curvature is sub-centimetre, invisible at this
 * project's part scale). */
function linePoints(a, b, n) {
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = vLerp(a, b, n === 1 ? 0 : i / (n - 1));
  return pts;
}

/** Two straight segments `a->mid->b`, resampled to `n` + `m` points total
 * with `mid` counted once (used for the arm/leg tubes, which bend at the
 * elbow/knee). */
function twoSegmentPoints(a, mid, b, n, m) {
  const first = linePoints(a, mid, n);
  const second = linePoints(mid, b, m).slice(1);
  return first.concat(second);
}

function taper(rMin, rMax, idx, n) {
  const t = n <= 1 ? 0 : idx / (n - 1);
  return rMin + (rMax - rMin) * t;
}

/** Rotates `v` ({x,y,z}) by a `THREE.Quaternion` aligning +Y to `dir` — this
 * file's one build-time convenience use of `three` beyond the final mesh
 * itself (the blade's orientation). No per-frame cost: called once, at
 * archetype build time. */
function quatFromYTo(dir) {
  const from = new THREE.Vector3(0, 1, 0);
  const to = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(from, to);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function quatRotateVec(q, v) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const uvx = qy * v.z - qz * v.y;
  const uvy = qz * v.x - qx * v.z;
  const uvz = qx * v.y - qy * v.x;
  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;
  return {
    x: v.x + 2 * (qw * uvx + uuvx),
    y: v.y + 2 * (qw * uvy + uuvy),
    z: v.z + 2 * (qw * uvz + uuvz),
  };
}

/** Rigidly moves a `geo.js` mesh's positions (normals untouched — every part
 * built here is axis-aligned enough that this file's own callers never
 * rotate a part after building it, except the blade, which builds its rings
 * pre-rotated via `tube`'s own frame — see `buildBlade`). */
function translateMesh(mesh, offset) {
  const vCount = mesh.p.length / 3;
  for (let i = 0; i < vCount; i++) {
    mesh.p[i * 3] += offset.x;
    mesh.p[i * 3 + 1] += offset.y;
    mesh.p[i * 3 + 2] += offset.z;
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// Body-kit parts — §3.2's "lean" column, ring x seg values reproduced
// exactly so triangle counts match that table's per-part figures.
// ---------------------------------------------------------------------------

function buildTorso(rig, ni) {
  const hips = boneVec(rig, ni, 'Hips');
  const chest = boneVec(rig, ni, 'Chest');
  const pts = linePoints(hips, chest, 6); // lean: 6 rings
  const mesh = tube(pts, (t, idx) => taper(0.1, 0.115, idx, 6), { seg: 10, caps: false }); // 10 seg -> (6-1)*10*2=100 tris
  return { mesh, bones: ['Hips', 'Spine', 'Chest'], bias: [0.6, 1, 1] };
}

function buildPelvis(rig, ni) {
  const hips = boneVec(rig, ni, 'Hips');
  const bottom = vAdd(hips, { x: 0, y: -0.15, z: 0 });
  const pts = linePoints(bottom, hips, 3); // lean: 3 rings
  const mesh = tube(pts, (t, idx) => taper(0.1, 0.11, idx, 3), { seg: 10, caps: false }); // (3-1)*10*2=40 tris
  return { mesh, bone: 'Hips' };
}

function buildArm(rig, ni, side) {
  const shoulder = boneVec(rig, ni, `UpperArm${side}`);
  const elbow = boneVec(rig, ni, `Forearm${side}`);
  const wrist = boneVec(rig, ni, `Hand${side}`);
  const pts = twoSegmentPoints(shoulder, elbow, wrist, 3, 4); // lean: 6 rings total
  const mesh = tube(pts, (t, idx) => taper(0.042, 0.026, idx, 6), { seg: 6, caps: false }); // (6-1)*6*2=60 tris
  return { mesh, bones: [`UpperArm${side}`, `Forearm${side}`], bias: [1, 1] };
}

function buildShoulderCap(rig, ni, side) {
  const anchor = boneVec(rig, ni, `UpperArm${side}`);
  const mesh = ellipsoid(0.06, 0.055, 0.06, { rings: 4, seg: 8 }); // (4-1)*8*2=48 tris
  translateMesh(mesh, anchor);
  return { mesh, bone: `UpperArm${side}` };
}

function buildHand(rig, ni, side) {
  const anchor = boneVec(rig, ni, `Hand${side}`);
  const mesh = boxRound(0.035, 0.05, 0.025, { rings: 3, seg: 6 }); // (3-1)*6*2+2*6=36 tris
  translateMesh(mesh, anchor);
  return { mesh, bone: `Hand${side}` };
}

/** How far below the `Foot*` bone the leg tube's ankle point (and the foot
 * mesh's own anchor, so the two stay flush) sits — tall boots, not a bare
 * ankle. Also this archetype's one deliberate lever for overall standing
 * height: the rig's bone positions are fixed (not this file's to change),
 * so the two places that can legitimately extend past them are the skull
 * (above `Head`) and the boot sole (below `Foot*`) — see `buildHead`'s
 * comment for why the height budget is split between the two rather than
 * concentrated in one (an earlier pass of this file put it all in the
 * skull and it read as an oversized "bobblehead" — see this ticket's
 * report). */
const BOOT_SOLE_DROP = 0.3;

function buildLeg(rig, ni, side) {
  const hip = boneVec(rig, ni, `UpLeg${side}`);
  const knee = boneVec(rig, ni, `Leg${side}`);
  const ankle = vAdd(boneVec(rig, ni, `Foot${side}`), { x: 0, y: -BOOT_SOLE_DROP, z: 0 });
  const pts = twoSegmentPoints(hip, knee, ankle, 4, 4); // lean: 7 rings total
  const mesh = tube(pts, (t, idx) => taper(0.068, 0.034, idx, 7), { seg: 8, caps: false }); // (7-1)*8*2=96 tris
  return { mesh, bones: [`UpLeg${side}`, `Leg${side}`], bias: [1, 1] };
}

function buildFoot(rig, ni, side) {
  const anchor = vAdd(boneVec(rig, ni, `Foot${side}`), { x: 0, y: -BOOT_SOLE_DROP, z: 0.04 });
  const mesh = boxRound(0.045, 0.035, 0.13, { rings: 3, seg: 6 }); // 36 tris
  translateMesh(mesh, anchor);
  return { mesh, bone: `Foot${side}` };
}

function buildNeck(rig, ni) {
  const chest = boneVec(rig, ni, 'Chest');
  const neck = boneVec(rig, ni, 'Neck');
  const base = vAdd(chest, { x: 0, y: 0.05, z: 0 });
  const pts = linePoints(base, neck, 2); // lean: 2 rings
  const mesh = tube(pts, () => 0.045, { seg: 8, caps: false }); // (2-1)*8*2=16 tris
  return { mesh, bone: 'Neck' };
}

function buildHead(rig, ni) {
  const anchor = vAdd(boneVec(rig, ni, 'Head'), { x: 0, y: 0.35, z: 0 });
  const mesh = ellipsoid(0.09, 0.22, 0.095, { rings: 6, seg: 10 }); // (6-1)*10*2=100 tris
  translateMesh(mesh, anchor);
  return { mesh, bone: 'Head' };
}

// ---------------------------------------------------------------------------
// Kit parts — §3.3's Bone Ranker row: "rib cage spineRow, skull-with-jaw,
// kite shield, notched blade, hip rags" (none of these are in §3.2's shared
// body-kit table; see this file's header for how each reads that phrase).
// ---------------------------------------------------------------------------

function buildRibs(rig, ni) {
  const chest = vAdd(boneVec(rig, ni, 'Chest'), { x: 0, y: 0, z: 0.09 });
  const hips = vAdd(boneVec(rig, ni, 'Hips'), { x: 0, y: 0, z: 0.09 });
  const n = 8;
  const mesh = spineRow(
    [chest, hips],
    n,
    (i, count) => 0.7 + 0.5 * Math.sin((Math.PI * i) / Math.max(1, count - 1)),
    { seg: 6, baseRadius: 0.014, baseLength: 0.045 },
  ); // n * 2 * seg = 8*2*6 = 96 tris
  return { mesh, bone: 'Spine' };
}

function buildJaw(rig, ni) {
  const anchor = vAdd(boneVec(rig, ni, 'Head'), { x: 0, y: -0.06, z: 0.045 });
  const mesh = boxRound(0.045, 0.028, 0.05, { rings: 3, seg: 6 }); // 36 tris
  translateMesh(mesh, anchor);
  return { mesh, bone: 'Head' };
}

function buildShield(rig, ni) {
  const anchor = vAdd(boneVec(rig, ni, 'ShieldL'), { x: 0.22, y: 0, z: -0.06 });
  const mesh = boxRound(0.27, 0.36, 0.018, { rings: 4, seg: 8, roundY: true }); // (4-1)*8*2+2*8=64 tris
  translateMesh(mesh, anchor);
  return { mesh, bone: 'ShieldL' };
}

function buildBlade(rig, ni) {
  const hand = boneVec(rig, ni, 'HandR');
  const weapon = boneVec(rig, ni, 'WeaponR');
  const dir = (() => {
    const d = vSub(weapon, hand);
    const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    return len > 1e-9 ? { x: d.x / len, y: d.y / len, z: d.z / len } : { x: 0, y: -1, z: 0 };
  })();
  const q = quatFromYTo(dir);
  const mesh = boxRound(0.014, 0.26, 0.006, { rings: 4, seg: 6, roundY: true }); // (4-1)*6*2+2*6=48 tris
  const vCount = mesh.p.length / 3;
  const center = vAdd(weapon, { x: dir.x * 0.2, y: dir.y * 0.2, z: dir.z * 0.2 });
  for (let i = 0; i < vCount; i++) {
    const p = { x: mesh.p[i * 3], y: mesh.p[i * 3 + 1], z: mesh.p[i * 3 + 2] };
    const rotated = quatRotateVec(q, p);
    mesh.p[i * 3] = rotated.x + center.x;
    mesh.p[i * 3 + 1] = rotated.y + center.y;
    mesh.p[i * 3 + 2] = rotated.z + center.z;
    const nrm = { x: mesh.n[i * 3], y: mesh.n[i * 3 + 1], z: mesh.n[i * 3 + 2] };
    const rotatedN = quatRotateVec(q, nrm);
    mesh.n[i * 3] = rotatedN.x;
    mesh.n[i * 3 + 1] = rotatedN.y;
    mesh.n[i * 3 + 2] = rotatedN.z;
  }
  return { mesh, bone: 'WeaponR' };
}

function buildHipRags(rig, ni) {
  const hips = boneVec(rig, ni, 'Hips');
  const offsets = [
    { x: 0, z: 0.1 },
    { x: -0.08, z: 0.03 },
    { x: 0.08, z: 0.03 },
  ];
  let mesh = null;
  for (const off of offsets) {
    const top = vAdd(hips, { x: off.x, y: -0.02, z: off.z });
    const bottom = vAdd(top, { x: 0, y: -0.28, z: 0 });
    const pts = linePoints(top, bottom, 4);
    const strip = ribbon(pts, 0.05, 0.008, { upright: true, caps: false }); // (4-1)*4*2=24 tris each
    mesh = mesh ? appendMesh(mesh, strip) : strip;
  }
  return { mesh, bone: 'Hips' };
}

// ---------------------------------------------------------------------------
// Per-part surface data — placeholder `color`/`aSurf` values (§3.4's layout).
// The real character material (MATL-3/ACTR-9, §4/§9) is out of this
// ticket's scope; these are plausible, documented defaults so the
// attributes exist and are populated for that ticket to read.
// ---------------------------------------------------------------------------

const SURFACE = {
  bone: { color: [214, 204, 184], layer: 0, roughness: 200, metalness: 0 },
  leather: { color: [92, 68, 54], layer: 2, roughness: 220, metalness: 0 },
  metal: { color: [140, 138, 132], layer: 1, roughness: 90, metalness: 200 },
};

const PART_SURFACE = {
  torso: 'bone', pelvis: 'bone', armR: 'bone', armL: 'bone',
  shoulderCapR: 'bone', shoulderCapL: 'bone', handR: 'bone', handL: 'bone',
  legR: 'bone', legL: 'bone', footR: 'bone', footL: 'bone', neck: 'bone',
  head: 'bone', ribs: 'bone', jaw: 'bone',
  shield: 'metal', blade: 'metal', hipRags: 'leather',
};

// ---------------------------------------------------------------------------
// buildBoneRanker() — the whole archetype, one geometry, one material
// ---------------------------------------------------------------------------

/**
 * Builds the Bone Ranker's L0 mesh: one `THREE.SkinnedMesh`, one shared
 * `BufferGeometry` (no groups), one `THREE.Skeleton` (22 bones, cloakless
 * humanoid rig), one material. Load-time cost only — nothing here runs per
 * frame, nothing allocates in a loop this file does not itself own.
 *
 * @returns {{ mesh: THREE.SkinnedMesh, geometry: THREE.BufferGeometry,
 *   material: THREE.Material, skeleton: THREE.Skeleton, rig: object,
 *   triCount: number, vertexCount: number, partCount: number,
 *   dispose: () => void }}
 */
export function buildBoneRanker() {
  const rig = createSkeleton(BONE_RANKER_RIG_ID, { cloak: false });
  const ni = nameToIndexMap(rig);

  const named = {
    torso: buildTorso(rig, ni),
    pelvis: buildPelvis(rig, ni),
    armR: buildArm(rig, ni, 'R'),
    armL: buildArm(rig, ni, 'L'),
    shoulderCapR: buildShoulderCap(rig, ni, 'R'),
    shoulderCapL: buildShoulderCap(rig, ni, 'L'),
    handR: buildHand(rig, ni, 'R'),
    handL: buildHand(rig, ni, 'L'),
    legR: buildLeg(rig, ni, 'R'),
    legL: buildLeg(rig, ni, 'L'),
    footR: buildFoot(rig, ni, 'R'),
    footL: buildFoot(rig, ni, 'L'),
    neck: buildNeck(rig, ni),
    head: buildHead(rig, ni),
    ribs: buildRibs(rig, ni),
    jaw: buildJaw(rig, ni),
    shield: buildShield(rig, ni),
    blade: buildBlade(rig, ni),
    hipRags: buildHipRags(rig, ni),
  };

  const order = Object.keys(named);
  const parts = order.map((key) => named[key]);

  // One bindSkin() call over every part — the cross-part seam weld (skin.js
  // step 6) runs over the whole actor, not per-part.
  const { results } = bindSkin(rig, parts);

  let merged = null;
  let skinIndexParts = [];
  let skinWeightParts = [];
  let colorParts = [];
  let surfParts = [];

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const key = order[p];
    const vCount = part.mesh.p.length / 3;
    const surf = SURFACE[PART_SURFACE[key]];

    const color = new Uint8Array(vCount * 3);
    const aSurf = new Uint8Array(vCount * 4);
    for (let i = 0; i < vCount; i++) {
      color[i * 3] = surf.color[0];
      color[i * 3 + 1] = surf.color[1];
      color[i * 3 + 2] = surf.color[2];
      aSurf[i * 4] = surf.layer;
      aSurf[i * 4 + 1] = surf.roughness;
      aSurf[i * 4 + 2] = surf.metalness;
      aSurf[i * 4 + 3] = 255; // baked AO — none baked yet, full light
    }

    skinIndexParts.push(results[p].skinIndex);
    skinWeightParts.push(results[p].skinWeight);
    colorParts.push(color);
    surfParts.push(aSurf);

    merged = merged ? appendMesh(merged, part.mesh) : part.mesh;
  }

  weldNormals(merged); // smooth normals across the part-merge seams

  const totalVerts = merged.p.length / 3;
  const skinIndex = new Uint8Array(totalVerts * 4);
  const skinWeight = new Uint8Array(totalVerts * 4);
  const color = new Uint8Array(totalVerts * 3);
  const aSurf = new Uint8Array(totalVerts * 4);
  let cursor = 0;
  for (let p = 0; p < parts.length; p++) {
    const vCount = parts[p].mesh.p.length / 3;
    skinIndex.set(skinIndexParts[p], cursor * 4);
    skinWeight.set(skinWeightParts[p], cursor * 4);
    color.set(colorParts[p], cursor * 3);
    aSurf.set(surfParts[p], cursor * 4);
    cursor += vCount;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(merged.p, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(merged.n, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(merged.uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3, true));
  geometry.setAttribute('aSurf', new THREE.BufferAttribute(aSurf, 4, false));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4, false));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4, true));
  const indexArray = totalVerts > 65535 ? new Uint32Array(merged.i) : new Uint16Array(merged.i);
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  // No geometry.addGroup() call — an ungrouped BufferGeometry renders its
  // whole index range as one implicit group (08 §3.4's "no geometry groups
  // at all"), which is what makes this one draw call.

  const material = new THREE.MeshBasicMaterial({ vertexColors: true });

  const bones = new Array(rig.boneCount);
  for (let i = 0; i < rig.boneCount; i++) {
    const bone = new THREE.Bone();
    bone.name = rig.names[i];
    bone.position.set(rig.localPos[i * 3], rig.localPos[i * 3 + 1], rig.localPos[i * 3 + 2]);
    bone.quaternion.set(rig.localQuat[i * 4], rig.localQuat[i * 4 + 1], rig.localQuat[i * 4 + 2], rig.localQuat[i * 4 + 3]);
    bones[i] = bone;
  }
  for (let i = 0; i < rig.boneCount; i++) {
    const parent = rig.parents[i];
    if (parent >= 0) bones[parent].add(bones[i]);
  }
  const root = bones[0];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(root);
  mesh.bind(skeleton);

  // §3.3: heightScale scales the whole rig uniformly, bulk widens X/Z only —
  // applied here, once, as the mesh's own object-space scale (see this
  // file's header for why this is exact, not an approximation, and why it
  // is NOT applied to the skeleton's bones).
  mesh.scale.set(BONE_RANKER_BULK, BONE_RANKER_HEIGHT_SCALE, BONE_RANKER_BULK);

  // The feet's lowest bind-pose vertex sits slightly above the rig's own
  // y=0 (a boxRound foot part is centred on its bone, not flush with the
  // ground) — `groundOffsetY` is how far a caller must raise this mesh's
  // `position.y` so the feet actually touch y=0. Computed post-scale (this
  // mesh's own `position` is added AFTER `scale` in Three's T*R*S local
  // matrix, so the offset must already be in scaled units) from the RAW
  // geometry bounding box, which is exact for a static, unposed bind-pose
  // actor (no animation has run — the skinned result equals the bind-space
  // geometry exactly). Not applied to `mesh.position` here: this file only
  // builds the mesh, it does not decide where an actor stands (that is
  // `spawnBoneRanker`'s, or the eventual spawn path's, job).
  geometry.computeBoundingBox();
  const groundOffsetY = -geometry.boundingBox.min.y * BONE_RANKER_HEIGHT_SCALE;

  return {
    mesh,
    geometry,
    material,
    skeleton,
    rig,
    triCount: merged.i.length / 3,
    vertexCount: totalVerts,
    partCount: parts.length,
    groundOffsetY,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Convenience for a dev/test harness (`src/dev/shots.js`'s `actor_ranker`
 * shot — see that file): builds the Ranker and adds it to `ctx.scene` at
 * `(x, 0, z)`. NOT a spawn-path integration — `actors.spawn()`'s
 * `archetypeId -> visual` wiring does not exist yet (`src/actors/index.js`
 * is not this ticket's file — see this ticket's report). Returns a disposer
 * that also removes the mesh from the scene.
 *
 * @param {{ scene: THREE.Scene }} ctx
 * @param {{ x?: number, z?: number }} [opts]
 * @returns {{ built: ReturnType<typeof buildBoneRanker>, dispose: () => void }}
 */
export function spawnBoneRanker(ctx, opts = {}) {
  const built = buildBoneRanker();
  built.mesh.position.set(opts.x ?? 0, built.groundOffsetY, opts.z ?? 0);
  ctx.scene.add(built.mesh);
  return {
    built,
    dispose() {
      ctx.scene.remove(built.mesh);
      built.dispose();
    },
  };
}
