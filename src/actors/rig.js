// src/actors/rig.js
//
// ACTR-3 — bone tables for all four rigs (`08-characters-visual.md` §2.3-2.6),
// their derived local (rest-offset) transforms, and `createSkeleton()`, the
// factory ACTR-5 (skin binder) and ACTR-6+ (animator) call to get a rig's
// data. Node-safe: no `three`, no DOM/browser global, no clock read anywhere
// in this file — `src/actors/` is a strict `check-imports.mjs` root (rule
// verified clean, O-29) and this file must stay inside that boundary so
// `tools/rigcheck.mjs` can `import` it and run headless.
//
// `createSkeleton()` is NOT a row in `02-api-contracts.md` §7 — it is called
// from *inside* `src/actors/` (by the skin binder, the animator, `pool.js`'s
// spawn path once a later ticket wires it up), never reached through
// `ctx.get('actors')` by another subsystem. Per that document's own rule
// ("a public method exists only if this document lists it"), it needs no row
// there; see this ticket's report for the one place a row *was* judged
// necessary.
//
// ---------------------------------------------------------------------------
// Shape returned by createSkeleton() — plain data, built once, shared
// ---------------------------------------------------------------------------
// {
//   rigId: 'humanoid' | 'quadruped' | 'crawler' | 'boss',
//   cloak: boolean,               // humanoid/boss only; always false for the other two
//   boneCount: number,
//   names: string[],              // length boneCount
//   parents: Int32Array,          // length boneCount, -1 for the root
//   bindPos: Float64Array,        // length boneCount*3 (x,y,z) — AUTHORED world bind position, §2.3-2.6's tables verbatim
//   bindQuat: Float64Array,       // length boneCount*4 (x,y,z,w) — DERIVED world bind rotation (see "Deriving rest rotations" below)
//   localPos: Float64Array,       // length boneCount*3 — DERIVED rest offset, §2.1's formula
//   localQuat: Float64Array,      // length boneCount*4 — DERIVED rest rotation, §2.1's formula
//   boneLength: Float64Array,     // length boneCount — distance(bindPos[i], bindPos[parent]); 0 for the root only
// }
//
// This is a SHARED, frozen, read-only reference table — one instance per
// (rigId, cloak) pair, built once at module load (rule: "Bone tables are
// built once at module load, not per call") and returned by reference on
// every `createSkeleton()` call thereafter. Nothing in this file ever
// mutates a returned skeleton after construction. A caller that needs a
// per-actor mutable *pose* buffer (later tickets — the animator, the skin
// binder's per-actor bone-matrix output) copies out of this table; it never
// writes into it.
//
// ---------------------------------------------------------------------------
// Deriving rest rotations — §2.1's algorithm, and the two calls this file
// makes where the spec's tables are silent
// ---------------------------------------------------------------------------
// §2.1: "aim +Y at the primary child (or along an explicit leaf direction for
// leaves), then resolve the remaining roll from the per-bone up hint."
//
// "Primary child" is not spelled out for a bone with more than one child
// (Hips -> Spine/UpLegR/UpLegL, Chest -> Neck/ClavicleR/ClavicleL/Cloak0,
// ForearmL -> HandL/ShieldL, ...). This file uses the LOWEST bone index
// among a bone's children as its primary child — the table order in every
// one of §2.3-2.6's rows already lists the main skeletal chain (spine,
// then arms, then legs, then the cloak) before its branches, so this is not
// an arbitrary tiebreak: it reproduces the chain the tables are written in
// (Hips's lowest-index child is Spine; Chest's is Neck; ForearmL's is HandL,
// the hand, not the strapped ShieldL). Does not affect the acceptance
// criterion (`08 §11 step 1` only checks POSITION round-trip, not rotation
// values) but is load-bearing for any later ticket that reads `bindQuat`/
// `localQuat` for real (the animator, IK).
//
// A LEAF bone (WeaponR, HandL, ShieldL, Head, the feet, Cloak1/Cloak2, Maw,
// every quadruped/crawler extremity, Tome, ...) has no child to aim at.
// §2.1 says leaves get "an explicit leaf direction" but none of §2.3-2.6's
// tables carries one. This file's choice: a leaf's +Y continues the same
// direction its own bone already runs in — parent-to-self, extended past
// self. This is the standard "an end-effector points where it's already
// pointing" convention and, again, does not affect the acceptance criterion.
//
// §2.4 (quadruped) and §2.5 (crawler) carry no "up hint" column at all —
// only §2.3 (humanoid) and, by inheritance, §2.6 (boss) do. This file
// defaults every bone without an authored up hint to (0,0,1) — world
// forward — which is also the humanoid table's own overwhelming default
// (every row except the two clavicles and the two feet). The two new boss
// bones (`Cloak2`, `Tome`) get the same default for the same reason: §2.6
// gives their positions but not an up hint either.
//
// Both calls are reported loudly in this ticket's report, per the brief —
// neither is guessable from the acceptance criterion, and both are cheap to
// revisit later without touching `createSkeleton()`'s shape.
//
// ---------------------------------------------------------------------------
// Boss scale/bulk — deliberately NOT applied here
// ---------------------------------------------------------------------------
// §2.6: "Reference height 3.20 m; the humanoid rig is scaled 1.778x and
// widened bulk = 1.35." The `Cloak2`/`Tome` positions §2.6 gives (e.g.
// `Cloak2` at (0, 0.640, -0.170)) sit in the SAME ~1.8 m coordinate frame as
// the rest of the humanoid table (`Cloak1` is at (0, 1.000, -0.145) — lower,
// consistent), not already multiplied by 1.778. §2.3 says the SAME thing
// about every non-boss humanoid ("uniformly scaled by the archetype's
// `heightScale` ... (§3.3)") — scale/bulk is a per-archetype presentation
// concern applied downstream of the canonical rig, not baked into the bone
// table. §3.3 is explicitly out of this ticket's reading list. `boss`'s
// skeleton below is therefore the UNSCALED canonical rig, exactly like every
// other rig this file returns; whichever ticket assembles the boss's mesh
// applies `heightScale`/`bulk` at that point, not here.

// ---------------------------------------------------------------------------
// Small math helpers — plain objects/arrays only, no `three`. All of this
// runs exactly once, at module load, building the frozen tables above; none
// of it is a per-frame or per-actor cost (rule 5/6 — allocation here is not
// the allocation those rules are guarding against).
// ---------------------------------------------------------------------------

function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vCross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function vScale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** Length via `sqrt(x*x+y*y+z*z)` — never `Math.hypot` (banned, allocates). */
function vLen(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

function vNorm(a) {
  const l = vLen(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Builds a unit quaternion from an orthonormal right-handed basis
 * (columns `bx`,`by`,`bz` — the world-space direction each local axis
 * points). Standard trace-based matrix-to-quaternion conversion (Shepperd's
 * method), branch-free-enough and numerically stable for every basis this
 * file ever builds (all four branches are exercised across the four rigs'
 * bones — none of them sits exactly on a branch boundary in a way that
 * matters, since any branch produces a mathematically equal quaternion). */
function quatFromBasis(bx, by, bz) {
  const m00 = bx.x, m10 = bx.y, m20 = bx.z;
  const m01 = by.x, m11 = by.y, m21 = by.z;
  const m02 = bz.x, m12 = bz.y, m22 = bz.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  }
  if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  }
  const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
}

/** Hamilton product, `a` applied first then `b` (i.e. `b * a` in the usual
 * "rotate by a, then by b" reading — matches `localQuat = inverse(parent) *
 * self`'s left-to-right composition used throughout this file). */
function quatMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Inverse of a *unit* quaternion is its conjugate — true for every quaternion
 * this file builds (`quatFromBasis` is fed an orthonormal basis, always unit
 * length). */
function quatConjugate(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Rotates vector `v` by quaternion `q` — the optimized (no full matrix
 * build) form, `v + 2*w*(q_xyz x v) + 2*(q_xyz x (q_xyz x v))`. */
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

/** Builds one bone's world bind rotation from its aim direction (+Y) and its
 * up hint (resolves the twist around +Y) — §2.1's algorithm. Falls back to a
 * world axis if the up hint is (numerically) parallel to the aim direction,
 * which never actually happens for any bone in §2.3-2.6's tables but keeps
 * this function total rather than producing a NaN quaternion if a future
 * rig's data ever does line them up. */
function boneQuatFromAim(yAxisRaw, upHint) {
  const y = vNorm(yAxisRaw);
  const up = vNorm(upHint);
  let zRaw = vSub(up, vScale(y, vDot(up, y)));
  let zLen = vLen(zRaw);
  if (zLen < 1e-6) {
    const fallback = Math.abs(y.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    zRaw = vSub(fallback, vScale(y, vDot(fallback, y)));
    zLen = vLen(zRaw);
  }
  const z = vScale(zRaw, 1 / zLen);
  const x = vCross(y, z);
  return quatFromBasis(x, y, z);
}

// ---------------------------------------------------------------------------
// Raw rig definitions — §2.3-2.6's tables, transcribed. Each entry:
// { name, parent (index into this same array, -1 for the root), pos:{x,y,z},
//   up:{x,y,z} }. `up` defaults to (0,0,1) — see the file header — wherever
// the spec table gives no up-hint column at all (quadruped, crawler, and the
// two boss-only extra bones).
// ---------------------------------------------------------------------------

const FWD = Object.freeze({ x: 0, y: 0, z: 1 });
const YHINT = Object.freeze({ x: 0, y: 1, z: 0 });

// §2.3 — Humanoid, 24 rows verbatim (rows 0-21 are the "required core: 22";
// rows 22-23, Cloak0/Cloak1, are the optional cloth chain).
const HUMANOID_RAW = Object.freeze([
  { name: 'Root', parent: -1, pos: { x: 0, y: 0, z: 0 }, up: FWD },
  { name: 'Hips', parent: 0, pos: { x: 0, y: 0.955, z: 0.0 }, up: FWD },
  { name: 'Spine', parent: 1, pos: { x: 0, y: 1.105, z: -0.01 }, up: FWD },
  { name: 'Chest', parent: 2, pos: { x: 0, y: 1.3, z: 0.005 }, up: FWD },
  { name: 'Neck', parent: 3, pos: { x: 0, y: 1.455, z: -0.01 }, up: FWD },
  { name: 'Head', parent: 4, pos: { x: 0, y: 1.56, z: 0.005 }, up: FWD },
  { name: 'ClavicleR', parent: 3, pos: { x: -0.04, y: 1.415, z: 0.015 }, up: YHINT },
  { name: 'UpperArmR', parent: 6, pos: { x: -0.17, y: 1.41, z: 0.0 }, up: FWD },
  { name: 'ForearmR', parent: 7, pos: { x: -0.196, y: 1.148, z: 0.055 }, up: FWD },
  { name: 'HandR', parent: 8, pos: { x: -0.21, y: 0.925, z: 0.135 }, up: FWD },
  { name: 'WeaponR', parent: 9, pos: { x: -0.216, y: 0.86, z: 0.18 }, up: FWD },
  { name: 'ClavicleL', parent: 3, pos: { x: 0.04, y: 1.415, z: 0.015 }, up: YHINT },
  { name: 'UpperArmL', parent: 11, pos: { x: 0.17, y: 1.41, z: 0.0 }, up: FWD },
  { name: 'ForearmL', parent: 12, pos: { x: 0.196, y: 1.143, z: 0.03 }, up: FWD },
  { name: 'HandL', parent: 13, pos: { x: 0.104, y: 0.975, z: 0.172 }, up: FWD },
  { name: 'ShieldL', parent: 13, pos: { x: 0.155, y: 1.055, z: 0.105 }, up: FWD },
  { name: 'UpLegR', parent: 1, pos: { x: -0.09, y: 0.94, z: 0.0 }, up: FWD },
  { name: 'LegR', parent: 16, pos: { x: -0.095, y: 0.515, z: 0.055 }, up: FWD },
  { name: 'FootR', parent: 17, pos: { x: -0.1, y: 0.09, z: -0.015 }, up: YHINT },
  { name: 'UpLegL', parent: 1, pos: { x: 0.09, y: 0.94, z: 0.0 }, up: FWD },
  { name: 'LegL', parent: 19, pos: { x: 0.095, y: 0.515, z: 0.055 }, up: FWD },
  { name: 'FootL', parent: 20, pos: { x: 0.1, y: 0.09, z: -0.015 }, up: YHINT },
  { name: 'Cloak0', parent: 3, pos: { x: 0, y: 1.34, z: -0.105 }, up: FWD },
  { name: 'Cloak1', parent: 22, pos: { x: 0, y: 1.0, z: -0.145 }, up: FWD },
]);

const HUMANOID_REQUIRED_CORE = 22; // §2.3: "Required core: 22."

// §2.4 — Quadruped, 16 rows verbatim. No up-hint column in the spec; every
// bone defaults to FWD (see the file header).
const QUADRUPED_RAW = Object.freeze([
  { name: 'Root', parent: -1, pos: { x: 0, y: 0, z: 0 }, up: FWD },
  { name: 'Hips', parent: 0, pos: { x: 0, y: 0.5, z: -0.28 }, up: FWD },
  { name: 'Spine', parent: 1, pos: { x: 0, y: 0.52, z: -0.05 }, up: FWD },
  { name: 'Chest', parent: 2, pos: { x: 0, y: 0.53, z: 0.19 }, up: FWD },
  { name: 'Head', parent: 3, pos: { x: 0, y: 0.56, z: 0.4 }, up: FWD },
  { name: 'TailA', parent: 1, pos: { x: 0, y: 0.48, z: -0.47 }, up: FWD },
  { name: 'TailB', parent: 5, pos: { x: 0, y: 0.43, z: -0.64 }, up: FWD },
  { name: 'FRA', parent: 3, pos: { x: -0.135, y: 0.47, z: 0.29 }, up: FWD },
  { name: 'FRB', parent: 7, pos: { x: -0.15, y: 0.23, z: 0.32 }, up: FWD },
  { name: 'FLA', parent: 3, pos: { x: 0.135, y: 0.47, z: 0.29 }, up: FWD },
  { name: 'FLB', parent: 9, pos: { x: 0.15, y: 0.23, z: 0.32 }, up: FWD },
  { name: 'BRA', parent: 1, pos: { x: -0.14, y: 0.47, z: -0.33 }, up: FWD },
  { name: 'BRB', parent: 11, pos: { x: -0.155, y: 0.225, z: -0.365 }, up: FWD },
  { name: 'BLA', parent: 1, pos: { x: 0.14, y: 0.47, z: -0.33 }, up: FWD },
  { name: 'BLB', parent: 13, pos: { x: 0.155, y: 0.225, z: -0.365 }, up: FWD },
  { name: 'Maw', parent: 4, pos: { x: 0, y: 0.52, z: 0.5 }, up: FWD },
]);

// §2.5 — Crawler, 12 rows. Bones 4-9 (`LegA`..`LegF`) are "a ring of six at
// radius 0.335, y 0.300, at 0deg, 60deg, ..., 300deg from +Z" — the spec gives
// the ring's parameters, not six literal rows, so this file generates them:
// `LegA`=0deg, `LegB`=60deg, ... `LegF`=300deg (alphabetical = increasing
// angle, the only order that makes "A..F" a sequence at all), each bone's
// world position at `(radius*sin(theta), ringY, radius*cos(theta))` so 0deg
// lands on pure +Z (matching "from +Z"). This is a documented reading of an
// under-specified row, not a literal transcription — see this ticket's
// report. It does not reproduce the prose "0.35 m taper" segment length
// exactly (the ring's own radius/height numbers put each leg roughly 0.40 m
// from `Body`); the acceptance criterion only requires a nonzero bone
// length, which this satisfies.
const CRAWLER_LEG_RADIUS = 0.335;
const CRAWLER_LEG_Y = 0.3;
const CRAWLER_LEG_NAMES = ['LegA', 'LegB', 'LegC', 'LegD', 'LegE', 'LegF'];

function buildCrawlerLegs() {
  const legs = [];
  for (let i = 0; i < CRAWLER_LEG_NAMES.length; i++) {
    const angleRad = (i * 60 * Math.PI) / 180;
    legs.push({
      name: CRAWLER_LEG_NAMES[i],
      parent: 1, // Body
      pos: {
        x: CRAWLER_LEG_RADIUS * Math.sin(angleRad),
        y: CRAWLER_LEG_Y,
        z: CRAWLER_LEG_RADIUS * Math.cos(angleRad),
      },
      up: FWD,
    });
  }
  return legs;
}

const CRAWLER_RAW = Object.freeze([
  { name: 'Root', parent: -1, pos: { x: 0, y: 0, z: 0 }, up: FWD },
  { name: 'Body', parent: 0, pos: { x: 0, y: 0.52, z: 0.0 }, up: FWD },
  { name: 'Sac', parent: 1, pos: { x: 0, y: 0.64, z: -0.06 }, up: FWD },
  { name: 'Head', parent: 1, pos: { x: 0, y: 0.5, z: 0.36 }, up: FWD },
  ...buildCrawlerLegs(),
  { name: 'ArmL', parent: 1, pos: { x: 0.3, y: 0.56, z: 0.19 }, up: FWD },
  { name: 'ArmR', parent: 1, pos: { x: -0.3, y: 0.56, z: 0.19 }, up: FWD },
]);

// §2.6 — Boss = humanoid-with-cloak (24) + Cloak2 (parent Cloak1, index 23)
// + Tome (parent Chest, index 3). Built by appending to a fresh copy of
// HUMANOID_RAW so index 23 (Cloak1) and index 3 (Chest) resolve exactly as
// in the base table — see the file header for why scale/bulk are not
// applied here.
const BOSS_RAW = Object.freeze([
  ...HUMANOID_RAW,
  { name: 'Cloak2', parent: 23, pos: { x: 0, y: 0.64, z: -0.17 }, up: FWD },
  { name: 'Tome', parent: 3, pos: { x: 0.38, y: 1.48, z: 0.22 }, up: FWD },
]);

// ---------------------------------------------------------------------------
// buildRig — turns one raw bone-definition array into the full skeleton
// object §2.1 describes: derived bindQuat, then localPos/localQuat via the
// formula, then flattened into typed arrays. Runs once per raw table, at
// module load.
// ---------------------------------------------------------------------------

function buildRig(rigId, raw, cloak) {
  const n = raw.length;

  // Primary child = lowest bone index among a bone's children — see the file
  // header for why this reproduces each table's own main-chain-first order.
  const primaryChild = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = raw[i].parent;
    if (p >= 0 && primaryChild[p] === -1) primaryChild[p] = i;
  }

  const bindPos = new Array(n);
  const bindQuat = new Array(n);
  for (let i = 0; i < n; i++) bindPos[i] = raw[i].pos;

  for (let i = 0; i < n; i++) {
    const parent = raw[i].parent;
    let yAxisRaw;
    if (primaryChild[i] !== -1) {
      yAxisRaw = vSub(bindPos[primaryChild[i]], bindPos[i]);
    } else if (parent >= 0) {
      // Leaf: continue the direction the bone already runs in — see the
      // file header's "Deriving rest rotations" section.
      yAxisRaw = vSub(bindPos[i], bindPos[parent]);
    } else {
      // The root with no children at all — never happens for any of these
      // four rigs (every root's primary child is Hips/Body), kept only so
      // this function is total.
      yAxisRaw = { x: 0, y: 1, z: 0 };
    }
    bindQuat[i] = boneQuatFromAim(yAxisRaw, raw[i].up);
  }

  const localPos = new Array(n);
  const localQuat = new Array(n);
  const boneLength = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const parent = raw[i].parent;
    if (parent < 0) {
      localPos[i] = bindPos[i];
      localQuat[i] = bindQuat[i];
      boneLength[i] = 0;
    } else {
      const parentQuatInv = quatConjugate(bindQuat[parent]);
      const offset = vSub(bindPos[i], bindPos[parent]);
      localPos[i] = quatRotateVec(parentQuatInv, offset);
      localQuat[i] = quatMultiply(parentQuatInv, bindQuat[i]);
      boneLength[i] = vLen(offset);
    }
  }

  const names = raw.map((b) => b.name);
  const parents = new Int32Array(n);
  const bindPosFlat = new Float64Array(n * 3);
  const bindQuatFlat = new Float64Array(n * 4);
  const localPosFlat = new Float64Array(n * 3);
  const localQuatFlat = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    parents[i] = raw[i].parent;
    bindPosFlat[i * 3] = bindPos[i].x;
    bindPosFlat[i * 3 + 1] = bindPos[i].y;
    bindPosFlat[i * 3 + 2] = bindPos[i].z;
    bindQuatFlat[i * 4] = bindQuat[i].x;
    bindQuatFlat[i * 4 + 1] = bindQuat[i].y;
    bindQuatFlat[i * 4 + 2] = bindQuat[i].z;
    bindQuatFlat[i * 4 + 3] = bindQuat[i].w;
    localPosFlat[i * 3] = localPos[i].x;
    localPosFlat[i * 3 + 1] = localPos[i].y;
    localPosFlat[i * 3 + 2] = localPos[i].z;
    localQuatFlat[i * 4] = localQuat[i].x;
    localQuatFlat[i * 4 + 1] = localQuat[i].y;
    localQuatFlat[i * 4 + 2] = localQuat[i].z;
    localQuatFlat[i * 4 + 3] = localQuat[i].w;
  }

  return Object.freeze({
    rigId,
    cloak,
    boneCount: n,
    names: Object.freeze(names),
    parents,
    bindPos: bindPosFlat,
    bindQuat: bindQuatFlat,
    localPos: localPosFlat,
    localQuat: localQuatFlat,
    boneLength,
  });
}

// Built once, at module load (rule: "Bone tables are built once at module
// load, not per call") — createSkeleton() below only ever looks these up.
const HUMANOID_CLOAKLESS = buildRig('humanoid', HUMANOID_RAW.slice(0, HUMANOID_REQUIRED_CORE), false);
const HUMANOID_WITH_CLOAK = buildRig('humanoid', HUMANOID_RAW, true);
const QUADRUPED_SKELETON = buildRig('quadruped', QUADRUPED_RAW, false);
const CRAWLER_SKELETON = buildRig('crawler', CRAWLER_RAW, false);
const BOSS_SKELETON = buildRig('boss', BOSS_RAW, true);

/** `08 §2.7`'s bone-count summary, as constants — so `tools/rigcheck.mjs`
 * (and any other consumer) asserts against a named value instead of a bare
 * magic number, and both files can never independently drift out of sync
 * with each other while still agreeing with the acceptance criterion's own
 * literal "22/16/12/26". */
export const RIG_BONE_COUNTS = Object.freeze({
  humanoid: HUMANOID_REQUIRED_CORE, // 22 — cloakless, the default
  humanoidCloak: HUMANOID_RAW.length, // 24
  quadruped: QUADRUPED_RAW.length, // 16
  crawler: CRAWLER_RAW.length, // 12
  boss: BOSS_RAW.length, // 26
});

/**
 * `createSkeleton(rigId, opts?) => Skeleton` — looks up and returns the
 * shared, frozen skeleton descriptor for `rigId`. Intra-subsystem only (no
 * `02-api-contracts.md` row — see the file header); not `Fixed`-classified
 * either way since it is never called from `fixedUpdate` (it is a build-time
 * factory, called once per archetype load, not per frame or per actor
 * simulation step).
 *
 * @param {'humanoid'|'quadruped'|'crawler'|'boss'} rigId
 * @param {{ cloak?: boolean }} [opts] `cloak` only matters for `'humanoid'`
 *   (default `false` — the cloakless 22-bone rig every M2 archetype uses,
 *   per §2.3's "Required core: 22" and the Bone Ranker being cloakless).
 *   Pass `{ cloak: true }` for the 24-bone cloth-chain variant. Ignored for
 *   `'quadruped'`/`'crawler'` (neither has a cloak option) and for `'boss'`
 *   (always 26 — humanoid-with-cloak plus `Cloak2`/`Tome`, §2.6).
 * @returns {object} the frozen Skeleton descriptor — see the file header for
 *   its shape. Shared across every caller; never mutate it.
 */
export function createSkeleton(rigId, opts = {}) {
  switch (rigId) {
    case 'humanoid':
      return opts.cloak ? HUMANOID_WITH_CLOAK : HUMANOID_CLOAKLESS;
    case 'quadruped':
      return QUADRUPED_SKELETON;
    case 'crawler':
      return CRAWLER_SKELETON;
    case 'boss':
      return BOSS_SKELETON;
    default:
      throw new Error(`createSkeleton: unknown rigId '${rigId}' (expected 'humanoid'|'quadruped'|'crawler'|'boss')`);
  }
}

/**
 * Recomposes every bone's world bind position by walking `localPos`/
 * `localQuat` forward through `parents` — exactly `08 §2.1`'s formula run in
 * reverse (`bindPos[i] = bindPos[parent] + bindQuat[parent] . localPos[i]`,
 * `bindQuat[i] = bindQuat[parent] . localQuat[i]`). A single forward pass
 * (`i` from 0 to `boneCount-1`) is correct because every parent index is
 * strictly less than its child index (the acceptance criterion's own rule,
 * true by construction — every rig's raw table is authored in that order),
 * so a bone's parent is always already resolved by the time the loop reaches
 * it.
 *
 * This is the acceptance criterion's round-trip check, expressed once here
 * so `tools/rigcheck.mjs` and `tests/actors/rig.test.js` share exactly one
 * implementation instead of two copies that could silently drift apart.
 *
 * @param {object} skeleton a value returned by `createSkeleton()`.
 * @returns {Float64Array} length `boneCount*3`, reconstructed world bind
 *   positions — compare against `skeleton.bindPos` within tolerance.
 */
export function reconstructBindPos(skeleton) {
  const n = skeleton.boneCount;
  const out = new Float64Array(n * 3);
  // worldQuat[i] tracked alongside, needed to rotate every descendant's
  // localPos back into world space; not part of the returned value (only
  // the reconstructed position is the thing under test).
  const worldQuat = new Array(n);
  for (let i = 0; i < n; i++) {
    const parent = skeleton.parents[i];
    const lp = { x: skeleton.localPos[i * 3], y: skeleton.localPos[i * 3 + 1], z: skeleton.localPos[i * 3 + 2] };
    const lq = {
      x: skeleton.localQuat[i * 4],
      y: skeleton.localQuat[i * 4 + 1],
      z: skeleton.localQuat[i * 4 + 2],
      w: skeleton.localQuat[i * 4 + 3],
    };
    if (parent < 0) {
      out[i * 3] = lp.x;
      out[i * 3 + 1] = lp.y;
      out[i * 3 + 2] = lp.z;
      worldQuat[i] = lq;
    } else {
      const parentPos = { x: out[parent * 3], y: out[parent * 3 + 1], z: out[parent * 3 + 2] };
      const parentQuat = worldQuat[parent];
      const rotated = quatRotateVec(parentQuat, lp);
      out[i * 3] = parentPos.x + rotated.x;
      out[i * 3 + 1] = parentPos.y + rotated.y;
      out[i * 3 + 2] = parentPos.z + rotated.z;
      worldQuat[i] = quatMultiply(parentQuat, lq);
    }
  }
  return out;
}
