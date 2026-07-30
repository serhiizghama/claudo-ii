// src/actors/skin.js
//
// ACTR-5 — the skin binder, `08-characters-visual.md` §3.5 steps 1-7: turns a
// part's bind-space mesh (from `geo.js`, ACTR-4) plus a bone assignment into
// per-vertex `skinIndex`/`skinWeight` (§3.4's `uint8 x 4` layout). Node-safe:
// no `three`, no DOM/browser global, no `performance.now()` anywhere in this
// file — `src/actors/` is a strict `check-imports.mjs` root (O-29, verified
// clean) and this file must stay inside that boundary so `tools/rigcheck.mjs`
// can `import` it and run headless. No `Math.random()` (rule 3) — nothing
// here needs jitter. No `Math.hypot` (banned, allocates) — every length is
// `Math.sqrt(x*x+y*y+z*z)`, matching `rig.js`/`geo.js`'s own `vLen`.
//
// This file does not import `rig.js` or `geo.js` at the top for its CORE
// binder (`bindSkin` et al. take a plain `skeleton` object and plain `part`
// records — the same "each file keeps its own math" pattern `geo.js`'s
// header describes). It DOES import both for the self-contained diagnostic
// fixtures below (`buildLimbFixture`, `buildDiagnosticScene`) — those need a
// real rig and real geometry to bind against, per the brief ("Build the test
// limb from those two rather than inventing geometry"), and importing them
// for THAT purpose is exactly the "intra-`src/actors/` sibling import" this
// subsystem already does elsewhere (e.g. `index.js` importing `pool.js`).
//
// ---------------------------------------------------------------------------
// Public shape: `bindSkin(skeleton, parts) => { results, stats }`
// ---------------------------------------------------------------------------
// `parts`: `Array<{ mesh: {p,n,uv,i}, bone?: string } | { mesh, bones:
// string[], bias: number[] }>` — a part is RIGID if it declares `bone`
// (single name), SMOOTH if it declares `bones`/`bias` (parallel arrays,
// §3.5's authored bias vector). `mesh.p` is the flat bind-space position
// array `geo.js` produces.
//
// `results[i]` (same order as `parts`): `{ skinIndex: Uint8Array(vCount*4),
// skinWeight: Uint8Array(vCount*4), vertexCount }`. This is intra-subsystem
// data — the eventual single-draw-call merge (§3.4) is a later ticket
// (ACTR-6) that concatenates `p`/`n`/`uv`/`color`/`aSurf` itself and takes
// `skinIndex`/`skinWeight` from here, part by part, in the same order it
// concatenates the geometry. No `02-api-contracts.md` row needed (rule 7 —
// intra-subsystem call, exactly like `rig.js#createSkeleton`).
//
// `stats`: `{ parts, rigidParts, smoothParts, totalVertices, clampedVertices,
// weldGroups }` — real counts, not a hollow pass (rule 12 / O-12 pattern
// this project already uses in `rig.js`/`geo.js`/`rigcheck.mjs`).
//
// ---------------------------------------------------------------------------
// Decisions this ticket made where §3.5 under-specifies — flagged here,
// restated in the report
// ---------------------------------------------------------------------------
// 1. TAIL FOR A LEAF BONE. §3.5: "`tail[c]` is the bone's end: the primary
//    child's bind position, or a 0.075 m stub along the leaf direction" but
//    never defines "leaf direction". This file reuses `rig.js`'s own
//    documented convention for a leaf's aim axis (its header, "Deriving rest
//    rotations"): parent-to-self, extended past self. Consistent with the
//    accepted rig file rather than an independent guess.
// 2. "PRIMARY CHILD" for a branching bone. Same tie-break `rig.js` already
//    uses and documents: the lowest bone index among a bone's children.
//    `computeBoneTails` below re-derives this from `skeleton.parents`
//    directly (public data) rather than reaching into `rig.js`'s private
//    table, so this file works against ANY skeleton shape, not just the
//    four `createSkeleton()` builds.
// 3. RE-PRUNE AFTER SMOOTHING, AND AFTER WELD. §3.5 lists "prune and
//    normalise" as step 3, before the step-5 smoothing and step-6 weld — but
//    step 5's Laplacian pass mixes a vertex's full candidate-bone weight
//    vector with its neighbours', which can revive an influence step 3 had
//    already zeroed (a neighbour with a different top-4 can donate a nonzero
//    value into a slot this vertex had pruned to 0), and step 6's average
//    across parts can combine two DIFFERENT already-pruned 4-influence sets
//    into up to 8 nonzero bones. Both would silently break the hard
//    "<=4 influences, sum 1" invariant the `uint8 x 4` output format cannot
//    exceed. This file re-applies the same prune-and-normalise routine
//    after smoothing (skipping joint-clamped vertices, which are already
//    exactly 0.5/0.5) and again after the weld average, immediately before
//    quantisation. Not a deviation from the spec's intent — it is the
//    obvious completion needed to keep step 3's own invariant true at the
//    point the data actually leaves this file, and it is reported here
//    loudly per the ticket's own instruction ("a checker that reports PASS
//    because it checked nothing is the failure mode here" — the mirror
//    image is a BINDER that quietly emits more than 4 influences).
// 4. RIGID PARTS STILL GO THROUGH STEP 6/7. §3.5: "Any part with `bone`
//    set... Skip steps 2-5." Read literally — steps 6 (cross-part weld) and
//    7 (quantise) are not in that skip list, so a rigid part's edge vertices
//    (e.g. a pauldron's cloth-facing rim meeting a sleeve) still participate
//    in the seam weld and still get quantised the same way as everyone else.
// 5. THE WELD GRID USES NO `Map`, PER THIS TICKET'S OWN BRIEF ("a weld grid
//    keyed by quantised position is exactly the never-repeating-key shape
//    that leaks, so build it on typed arrays or index arithmetic"). Grouping
//    below is a sort of quantised-position keys followed by a linear scan
//    for runs of equal keys — no `Map`, no string-keyed object. The per-group
//    bone-weight merge (`mergeSparseGroup`) likewise avoids `Map`, using a
//    linear `find` over a tiny array (a weld group is a handful of coincident
//    seam vertices, each contributing <=4 entries — `Map` overhead was never
//    justified here either way, but the brief's instruction is honoured to
//    the letter, not just the one literal "weld grid" phrase). Vertex
//    adjacency (`buildAdjacency`, for step 5) is build-time-only, exactly
//    like `geo.js#weldNormals`'s own `Map` (that file's header explains why
//    a build-time, call-once, never-recycled `Map` is NOT the pattern rule 6
//    bans) — but it is written here with plain arrays anyway, for the same
//    "honour the letter" reason, not because the accepted precedent was
//    wrong.
// 6. THE CANDY-WRAPPER MEASUREMENT'S "BISECTING PLANE" is read as the
//    standard pipe-miter plane: the plane through the joint whose normal is
//    the (normalised) SUM of the two bone segments' forward tangents (bind
//    tangent for the proximal segment, which does not move in this test;
//    bind or posed tangent for the distal segment, per which state is being
//    measured). This is the plane a real miter joint would be cut at to
//    join the two segments seamlessly, degenerates gracefully to the plain
//    perpendicular cross-section as the two tangents converge (a straight
//    limb), and is symmetric in exactly the way "bisecting" implies. See the
//    report for the alternative readings considered.
//
// ---------------------------------------------------------------------------
// Constants — §3.5, verbatim
// ---------------------------------------------------------------------------

export const SKIN_CONSTANTS = Object.freeze({
  K: 3.2, // inverse-distance exponent
  D_MIN: 0.012, // m, distance floor
  W_CUT: 0.06, // influences below W_CUT * w_max are dropped
  JOINT_R: 0.05, // m, radius around a shared joint where weights are forced 50/50
  SMOOTH_N: 2, // Laplacian smoothing iterations
  WELD_EPS: 0.001, // m, cross-part seam weld radius
});

/** §3.5's leaf-tail stub length, metres — "a 0.075 m stub along the leaf
 * direction". Named so it is a documented number, not a bare literal. */
const LEAF_TAIL_STUB = 0.075;

// ---------------------------------------------------------------------------
// Small vector helpers — build-time only, no `three`, no `Math.hypot`
// ---------------------------------------------------------------------------

function vAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vScale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function vDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function vCross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
/** Length via `sqrt(x*x+y*y+z*z)` — never `Math.hypot` (banned, allocates). */
function vLen(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}
function vDist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function vNorm(a) {
  const l = vLen(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
function vLerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
/** Rotates `v` around unit `axis` by `angle` radians — Rodrigues' formula,
 * the same one `geo.js#rotateAroundAxis` uses, re-derived locally (this
 * file's own header explains why files in this directory keep their own
 * copy rather than reaching across for a handful of lines). */
function rotateAroundAxis(v, axis, angle) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const term1 = vScale(v, cosA);
  const term2 = vScale(vCross(axis, v), sinA);
  const term3 = vScale(axis, vDot(axis, v) * (1 - cosA));
  return vAdd(vAdd(term1, term2), term3);
}

function vec3At(arr, i) {
  return { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] };
}

/** Closest distance from point `v` to the segment `[a,b]` — §3.5 step 2's
 * `distancePointSegment`. Standard clamped-projection form. */
export function distancePointSegment(v, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = v.x - a.x, apy = v.y - a.y, apz = v.z - a.z;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq > 1e-18 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
  t = Math.min(1, Math.max(0, t));
  const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
  const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Bone tails — §3.5 step 2's `tail[c]` for every bone in a skeleton
// ---------------------------------------------------------------------------

/**
 * `tails[i]` = the primary child's bind position (lowest-index child, same
 * tie-break `rig.js` documents), or — for a leaf — a `LEAF_TAIL_STUB`-long
 * step continuing the parent-to-self direction (see decision 1 above).
 * @param {object} skeleton a `createSkeleton()`-shaped value: `boneCount`,
 *   `parents` (Int32Array), `bindPos` (Float64Array, world, `boneCount*3`).
 * @returns {Float64Array} length `boneCount*3`.
 */
export function computeBoneTails(skeleton) {
  const n = skeleton.boneCount;
  const primaryChild = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = skeleton.parents[i];
    if (p >= 0 && primaryChild[p] === -1) primaryChild[p] = i;
  }
  const tails = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (primaryChild[i] !== -1) {
      const c = primaryChild[i];
      tails[i * 3] = skeleton.bindPos[c * 3];
      tails[i * 3 + 1] = skeleton.bindPos[c * 3 + 1];
      tails[i * 3 + 2] = skeleton.bindPos[c * 3 + 2];
      continue;
    }
    const self = vec3At(skeleton.bindPos, i);
    const parent = skeleton.parents[i];
    const dir = parent >= 0 ? vNorm(vSub(self, vec3At(skeleton.bindPos, parent))) : { x: 0, y: 1, z: 0 };
    const stub = vAdd(self, vScale(dir, LEAF_TAIL_STUB));
    tails[i * 3] = stub.x;
    tails[i * 3 + 1] = stub.y;
    tails[i * 3 + 2] = stub.z;
  }
  return tails;
}

// ---------------------------------------------------------------------------
// Vertex adjacency — from a mesh's index buffer, for step 5's smoothing
// ---------------------------------------------------------------------------

/** Plain arrays, no `Map`/`Set` (see decision 5) — build-time-only, degree
 * is tiny (a handful of neighbours per vertex on this project's loft-based
 * meshes), so a linear `includes` scan per edge insert is not a concern. */
function buildAdjacency(mesh, vCount) {
  const adjacency = new Array(vCount);
  for (let i = 0; i < vCount; i++) adjacency[i] = [];
  function addEdge(a, b) {
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
  }
  const idx = mesh.i;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    addEdge(a, b); addEdge(b, a);
    addEdge(b, c); addEdge(c, b);
    addEdge(c, a); addEdge(a, c);
  }
  return adjacency;
}

// ---------------------------------------------------------------------------
// Prune + normalise — §3.5 step 3, reused after smoothing and after weld
// (see decision 3)
// ---------------------------------------------------------------------------

/** Mutates `slice` (a dense `Float64Array`, one entry per this part's
 * declared candidate bone) in place: keeps the 4 largest, drops any below
 * `W_CUT * w_max`, renormalises the survivors to sum 1. Returns how many of
 * the originally-nonzero entries did NOT survive (falsifiability: a real
 * count, not a boolean). */
function pruneAndNormalizeDenseSlice(slice) {
  const m = slice.length;
  const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => slice[b] - slice[a]);
  const top = order.slice(0, Math.min(4, m));
  const maxW = top.length ? slice[top[0]] : 0;
  const kept = maxW > 0 ? top.filter((i) => slice[i] >= SKIN_CONSTANTS.W_CUT * maxW) : [];
  let sum = 0;
  for (const i of kept) sum += slice[i];
  const before = order.filter((i) => slice[i] > 0).length;
  const next = new Float64Array(m);
  if (sum > 0) for (const i of kept) next[i] = slice[i] / sum;
  slice.set(next);
  return before - kept.length;
}

/** Sparse-list version of the same rule, used after the weld average (which
 * works in global-bone-index space, not a part's local dense slice — see
 * `mergeSparseGroup`). `list`: `Array<{bone, w}>`, mutated-in-place style via
 * return (does not mutate `list`'s objects, returns a new pruned array). */
function pruneAndNormalizeSparse(list) {
  const sorted = list.slice().sort((a, b) => b.w - a.w);
  const top = sorted.slice(0, 4);
  const maxW = top.length ? top[0].w : 0;
  const kept = maxW > 0 ? top.filter((e) => e.w >= SKIN_CONSTANTS.W_CUT * maxW) : [];
  const sum = kept.reduce((s, e) => s + e.w, 0);
  if (sum <= 0) return [];
  return kept.map((e) => ({ bone: e.bone, w: e.w / sum }));
}

// ---------------------------------------------------------------------------
// bindPart — one part through steps 1-5 (rigid: step 1 only)
// ---------------------------------------------------------------------------

/**
 * @param {object} skeleton
 * @param {{mesh, bone?:string, bones?:string[], bias?:number[]}} part
 * @param {Float64Array} boneTails from `computeBoneTails(skeleton)`.
 * @param {Record<string,number>} nameToIndex bone name -> global index.
 * @returns {{ sparse: Array<Array<{bone:number,w:number}>>, clampedCount:
 *   number, mode: 'rigid'|'smooth', vCount: number }}
 */
function bindPart(skeleton, part, boneTails, nameToIndex) {
  const mesh = part.mesh;
  const vCount = mesh.p.length / 3;

  if (part.bone !== undefined) {
    if (part.bones !== undefined) {
      throw new Error(`bindPart: part declares both 'bone' and 'bones' — pick one`);
    }
    const b = nameToIndex[part.bone];
    if (b === undefined) throw new Error(`bindPart: unknown bone '${part.bone}'`);
    const sparse = new Array(vCount);
    for (let i = 0; i < vCount; i++) sparse[i] = [{ bone: b, w: 1 }];
    return { sparse, clampedCount: 0, mode: 'rigid', vCount };
  }

  const { bones, bias } = part;
  if (!Array.isArray(bones) || !Array.isArray(bias) || bones.length === 0 || bones.length !== bias.length) {
    throw new Error(`bindPart: a smooth part needs 'bones'/'bias' as non-empty, equal-length arrays`);
  }
  const m = bones.length;
  const boneGlobal = bones.map((name) => {
    const idx = nameToIndex[name];
    if (idx === undefined) throw new Error(`bindPart: unknown bone '${name}'`);
    return idx;
  });
  const segA = boneGlobal.map((g) => vec3At(skeleton.bindPos, g));
  const segB = boneGlobal.map((g) => vec3At(boneTails, g));

  // Step 2 — inverse-distance weights.
  const dense = new Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const v = vec3At(mesh.p, i);
    const slice = new Float64Array(m);
    for (let c = 0; c < m; c++) {
      const d = distancePointSegment(v, segA[c], segB[c]);
      slice[c] = bias[c] / Math.pow(Math.max(d, SKIN_CONSTANTS.D_MIN), SKIN_CONSTANTS.K);
    }
    dense[i] = slice;
  }

  // Step 3 — prune and normalise.
  for (let i = 0; i < vCount; i++) pruneAndNormalizeDenseSlice(dense[i]);

  // Step 4 — joint clamp: a vertex within JOINT_R of the shared endpoint of
  // two of THIS part's candidate bones, where those two are parent/child in
  // the skeleton, is forced to exactly 0.5/0.5.
  const clamped = new Uint8Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const v = vec3At(mesh.p, i);
    let bestDist = Infinity, bestCi = -1, bestCj = -1;
    for (let ci = 0; ci < m; ci++) {
      for (let cj = ci + 1; cj < m; cj++) {
        const gi = boneGlobal[ci], gj = boneGlobal[cj];
        let jointGlobal = -1;
        if (skeleton.parents[gj] === gi) jointGlobal = gj;
        else if (skeleton.parents[gi] === gj) jointGlobal = gi;
        else continue;
        const jointPos = vec3At(skeleton.bindPos, jointGlobal);
        const d = vDist(v, jointPos);
        if (d < SKIN_CONSTANTS.JOINT_R && d < bestDist) {
          bestDist = d; bestCi = ci; bestCj = cj;
        }
      }
    }
    if (bestCi >= 0) {
      const slice = dense[i];
      slice.fill(0);
      slice[bestCi] = 0.5;
      slice[bestCj] = 0.5;
      clamped[i] = 1;
    }
  }

  // Step 5 — Laplacian smoothing over the union of candidate bones, skipping
  // clamped vertices; re-prune afterwards (decision 3).
  const adjacency = buildAdjacency(mesh, vCount);
  for (let iter = 0; iter < SKIN_CONSTANTS.SMOOTH_N; iter++) {
    const next = dense.map((s) => s.slice());
    for (let i = 0; i < vCount; i++) {
      if (clamped[i]) continue;
      const neighbours = adjacency[i];
      if (neighbours.length === 0) continue;
      const mean = new Float64Array(m);
      for (const nb of neighbours) {
        const nbSlice = dense[nb];
        for (let c = 0; c < m; c++) mean[c] += nbSlice[c];
      }
      for (let c = 0; c < m; c++) mean[c] /= neighbours.length;
      const s = next[i];
      for (let c = 0; c < m; c++) s[c] = 0.5 * dense[i][c] + 0.5 * mean[c];
    }
    for (let i = 0; i < vCount; i++) dense[i] = next[i];
  }
  for (let i = 0; i < vCount; i++) {
    if (clamped[i]) continue; // already exactly 0.5/0.5, sums to 1
    pruneAndNormalizeDenseSlice(dense[i]);
  }

  const sparse = new Array(vCount);
  let clampedCount = 0;
  for (let i = 0; i < vCount; i++) {
    const slice = dense[i];
    const list = [];
    for (let c = 0; c < m; c++) if (slice[c] > 0) list.push({ bone: boneGlobal[c], w: slice[c] });
    sparse[i] = list;
    if (clamped[i]) clampedCount++;
  }
  return { sparse, clampedCount, mode: 'smooth', vCount };
}

// ---------------------------------------------------------------------------
// Cross-part seam weld — §3.5 step 6, no `Map` (decision 5)
// ---------------------------------------------------------------------------

/** Groups a flat list of `{x,y,z}` positions (one entry per global vertex,
 * across every part) into runs of coincident positions within `eps` — a
 * quantise-then-sort-then-scan grid, never a hashmap. Returns
 * `Array<number[]>`, each inner array a list of indices into `flat`. */
function buildWeldGroups(flat, eps) {
  const n = flat.length;
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    qx[i] = Math.round(flat[i].x / eps);
    qy[i] = Math.round(flat[i].y / eps);
    qz[i] = Math.round(flat[i].z / eps);
  }
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => qx[a] - qx[b] || qy[a] - qy[b] || qz[a] - qz[b]);
  const groups = [];
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && qx[order[j]] === qx[order[i]] && qy[order[j]] === qy[order[i]] && qz[order[j]] === qz[order[i]]) {
      j++;
    }
    groups.push(order.slice(i, j));
    i = j;
  }
  return groups;
}

/** Averages a weld group's per-vertex sparse weight lists (each already
 * <=4 entries from the individual part binding) and renormalises. No `Map`
 * (decision 5) — a weld group is a handful of coincident seam vertices, so a
 * linear `find` over a tiny accumulator array is the whole cost. */
function mergeSparseGroup(sparseList) {
  const acc = [];
  for (const list of sparseList) {
    for (const { bone, w } of list) {
      let entry = acc.find((e) => e.bone === bone);
      if (!entry) {
        entry = { bone, sum: 0 };
        acc.push(entry);
      }
      entry.sum += w;
    }
  }
  const count = sparseList.length;
  const merged = acc.map((e) => ({ bone: e.bone, w: e.sum / count }));
  const sum = merged.reduce((s, e) => s + e.w, 0);
  if (sum <= 0) return [];
  return merged.map((e) => ({ bone: e.bone, w: e.w / sum }));
}

// ---------------------------------------------------------------------------
// Quantise — §3.5 step 7
// ---------------------------------------------------------------------------

/** `list`: up to 4 `{bone,w}` entries summing to ~1. Returns 4-length
 * `Uint8Array`s that sum to EXACTLY 255 (residual added to the largest
 * component, per step 7 verbatim). Pads unused slots with `{bone:0, w:0}` —
 * weight 0 makes the padding bone index inert regardless of what it is. */
function quantizeSparse(list) {
  const padded = list.slice(0, 4).map((e) => ({ bone: e.bone, w: e.w }));
  while (padded.length < 4) padded.push({ bone: 0, w: 0 });

  const rounded = padded.map((e) => Math.round(e.w * 255));
  const sum = rounded.reduce((a, b) => a + b, 0);
  const residual = 255 - sum;
  let maxIdx = 0;
  for (let i = 1; i < 4; i++) if (padded[i].w > padded[maxIdx].w) maxIdx = i;
  rounded[maxIdx] += residual;

  const skinIndex = new Uint8Array(4);
  const skinWeight = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    skinIndex[i] = padded[i].bone;
    skinWeight[i] = Math.max(0, Math.min(255, rounded[i]));
  }
  return { skinIndex, skinWeight };
}

// ---------------------------------------------------------------------------
// bindSkin — the whole pipeline, one skeleton, many parts
// ---------------------------------------------------------------------------

/**
 * @param {object} skeleton a `createSkeleton()`-shaped value.
 * @param {Array<object>} parts see the file header for a part's shape.
 * @returns {{ results: Array<{skinIndex:Uint8Array, skinWeight:Uint8Array,
 *   vertexCount:number}>, stats: object }}
 */
export function bindSkin(skeleton, parts) {
  const nameToIndex = {};
  for (let i = 0; i < skeleton.boneCount; i++) nameToIndex[skeleton.names[i]] = i;
  const boneTails = computeBoneTails(skeleton);

  const partResults = parts.map((part) => bindPart(skeleton, part, boneTails, nameToIndex));

  // Flatten every part's vertices into one global list for the weld pass.
  const flat = [];
  for (let p = 0; p < parts.length; p++) {
    const mesh = parts[p].mesh;
    const vCount = mesh.p.length / 3;
    for (let i = 0; i < vCount; i++) {
      flat.push({ part: p, vertex: i, x: mesh.p[i * 3], y: mesh.p[i * 3 + 1], z: mesh.p[i * 3 + 2] });
    }
  }

  const groups = buildWeldGroups(flat, SKIN_CONSTANTS.WELD_EPS);
  let weldGroups = 0;
  for (const group of groups) {
    if (group.length < 2) continue;
    weldGroups++;
    const sparseList = group.map((gi) => partResults[flat[gi].part].sparse[flat[gi].vertex]);
    const merged = pruneAndNormalizeSparse(mergeSparseGroup(sparseList));
    for (const gi of group) {
      partResults[flat[gi].part].sparse[flat[gi].vertex] = merged.map((e) => ({ ...e }));
    }
  }

  const results = parts.map((part, p) => {
    const vCount = part.mesh.p.length / 3;
    const skinIndex = new Uint8Array(vCount * 4);
    const skinWeight = new Uint8Array(vCount * 4);
    for (let i = 0; i < vCount; i++) {
      const { skinIndex: si, skinWeight: sw } = quantizeSparse(partResults[p].sparse[i]);
      skinIndex.set(si, i * 4);
      skinWeight.set(sw, i * 4);
    }
    return { skinIndex, skinWeight, vertexCount: vCount };
  });

  const stats = {
    parts: parts.length,
    rigidParts: partResults.filter((r) => r.mode === 'rigid').length,
    smoothParts: partResults.filter((r) => r.mode === 'smooth').length,
    totalVertices: flat.length,
    clampedVertices: partResults.reduce((s, r) => s + r.clampedCount, 0),
    weldGroups,
  };

  return { results, stats };
}

// ===========================================================================
// Diagnostic fixtures — a real skinned limb, built from ACTR-3's rig and
// ACTR-4's geometry toolkit (per the brief: "Build the test limb from those
// two rather than inventing geometry"). Used by BOTH `tools/rigcheck.mjs`
// (its `SKIN_GROUPS` entries call these with no arguments, per that file's
// aggregation contract) and `tests/actors/skin.test.js`, so there is exactly
// one implementation of the candy-wrapper measurement, not two that could
// drift apart — the same discipline `rig.js#reconstructBindPos` established
// for ACTR-3/`rigcheck.mjs`.
// ===========================================================================

import { createSkeleton } from './rig.js';
import { tube, boxRound } from './geo.js';

const LIMB_RADIUS = 0.045; // m, plausible arm/leg cross-section
const LIMB_SEG = 12;
const SAMPLES_PER_SEGMENT = 5; // ring density either side of the joint

/**
 * Builds a single tapered-tube "limb" spanning `proximalName -> jointName ->
 * distalName` (three real humanoid bones), with a ring sitting EXACTLY on
 * the joint (so "the vertex ring nearest the joint" is unambiguous — it is
 * the ring built at that exact point, not one found by nearest-search).
 * Smooth-bound to `[proximalName, jointName]` with equal bias, which is
 * exactly the shape that puts the elbow/knee's joint clamp (`JOINT_R`) in
 * play at that ring.
 */
export function buildLimbFixture(rigId, proximalName, jointName, distalName) {
  const skeleton = createSkeleton(rigId);
  const nameToIndex = {};
  for (let i = 0; i < skeleton.boneCount; i++) nameToIndex[skeleton.names[i]] = i;
  const proximalIdx = nameToIndex[proximalName];
  const jointIdx = nameToIndex[jointName];
  const distalIdx = nameToIndex[distalName];
  if (proximalIdx === undefined || jointIdx === undefined || distalIdx === undefined) {
    throw new Error(`buildLimbFixture: bone not found in '${rigId}' (${proximalName}/${jointName}/${distalName})`);
  }

  const pProx = vec3At(skeleton.bindPos, proximalIdx);
  const pJoint = vec3At(skeleton.bindPos, jointIdx);
  const pDistal = vec3At(skeleton.bindPos, distalIdx);

  const points = [];
  for (let k = 0; k < SAMPLES_PER_SEGMENT; k++) points.push(vLerp(pProx, pJoint, k / (SAMPLES_PER_SEGMENT - 1)));
  const jointRingIndex = points.length - 1;
  for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) points.push(vLerp(pJoint, pDistal, k / (SAMPLES_PER_SEGMENT - 1)));

  const mesh = tube(points, () => LIMB_RADIUS, { seg: LIMB_SEG, caps: false });
  const part = { mesh, bones: [proximalName, jointName], bias: [1, 1] };

  return { skeleton, part, points, seg: LIMB_SEG, jointRingIndex, proximalIdx, jointIdx, distalIdx, nameToIndex };
}

/** Projects 3D `points` onto the plane through `planePoint` perpendicular to
 * `normal`, returning 2D coordinates in an arbitrary orthonormal basis of
 * that plane. */
function projectOntoPlane(points, planePoint, normal) {
  const n = vNorm(normal);
  const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = vNorm(vSub(ref, vScale(n, vDot(ref, n))));
  const w = vNorm(vCross(n, u));
  return points.map((p) => {
    const rel = vSub(p, planePoint);
    return { x: vDot(rel, u), y: vDot(rel, w) };
  });
}

function cross2D(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew's monotone chain — 2D convex hull, ascending x/y order. */
function convexHull2D(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const n = pts.length;
  if (n < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Convex-hull area via the shoelace formula — the validation table's exact
 * metric ("measure the convex-hull area of the vertex ring... projected onto
 * the bisecting plane"). */
export function convexHullArea2D(points) {
  const hull = convexHull2D(points);
  if (hull.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** Rotates `v` by unit quaternion `q` — optimised form, no matrix build,
 * the same formula `rig.js#quatRotateVec`/`geo.js#quatRotateVec` use,
 * re-derived locally (this file's own header explains the per-file-copy
 * pattern this directory follows). */
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

/**
 * Runs the candy-wrapper test on a `buildLimbFixture()` result: binds the
 * limb, bends the joint 90 deg about the natural hinge axis (perpendicular
 * to the plane containing both bone segments), and compares the joint
 * ring's convex-hull area, bind vs posed, each projected onto its own
 * bisecting/miter plane (decision 6 above).
 *
 * POSING METHOD — why the ASSERTED number (`loss`) is NOT plain per-vertex
 * linear-blend (LBS) position averaging, and why `lbsLoss` is reported
 * alongside it anyway. §3.5's own validation table says a 50/50-clamped
 * ring "rotates rigidly about the joint bisector and preserves its
 * cross-section" — that claim is only literally true if the two bones'
 * contributions are combined as a BLENDED ROTATION applied once about their
 * shared pivot (NLERP of the two bones' delta-quaternions relative to bind,
 * weighted, renormalised, then applied rigidly about the joint position),
 * not as a weighted AVERAGE OF ALREADY-TRANSFORMED POSITIONS (plain LBS,
 * matching Three's stock skinning chunk and `08 §2.2`'s own stated
 * skinning method). Verified numerically while building this ticket, and
 * independently re-derived and confirmed by the orchestrator: at a 90 deg
 * bend, quaternion-blend gives ~0% loss for the clamped ring (matching the
 * spec's words exactly), while plain LBS gives ~29.3% (`= 1 - cos(45 deg)`,
 * exactly the closed form for a 50/50 blend of two rigid transforms 90 deg
 * apart) — failing the 12% gate outright, and unreachable under LBS past
 * roughly a 57 deg bend (12.1% at 57 deg), which is BELOW `08 §2.2`'s own
 * stated 72 deg operating envelope (19.1% loss there). `08 §3.5` step 4 and
 * `08 §2.2` therefore describe two different skinning methods and
 * contradict each other; this ticket does not resolve that (out of scope —
 * the GPU skinning shader is a different ticket's territory, §4/§9). What
 * THIS function does about it: it asserts on the quaternion-blended value
 * (the orchestrator's accepted reading of what the criterion means), and
 * ALSO returns the plain-LBS figure (`lbsLoss`/`lbsPosedArea`) so nothing
 * downstream can read a PASS here without also seeing what the SAME weights
 * would measure if the eventual runtime skins with plain LBS instead of
 * blending rotations. THE CRITERION IS A STATEMENT ABOUT THE WEIGHTS THIS
 * BINDER PRODUCES, NOT ABOUT ANY PARTICULAR SHADER — it is only satisfiable
 * if whatever consumes these weights blends rotations, not positions.
 * `tools/rigcheck.mjs` prints both numbers on the same line for exactly
 * this reason (see that file's `SKIN.candyWrapperElbow`/`Knee` groups).
 * @returns {{ bindArea:number, posedArea:number, loss:number, lbsPosedArea:
 *   number, lbsLoss:number, ringVertexCount:number, jointName:string,
 *   clampedInRing:number }}
 */
export function measureCandyWrapper(fixture) {
  const { skeleton, part, seg, jointRingIndex, proximalIdx, jointIdx, distalIdx } = fixture;
  const { results, stats } = bindSkin(skeleton, [part]);
  const { skinIndex, skinWeight } = results[0];

  const ringStart = jointRingIndex * seg;
  const ringVerts = [];
  for (let j = 0; j < seg; j++) ringVerts.push(ringStart + j);
  const bindRing = ringVerts.map((i) => vec3At(part.mesh.p, i));

  const pProx = vec3At(skeleton.bindPos, proximalIdx);
  const pJoint = vec3At(skeleton.bindPos, jointIdx);
  const pDistal = vec3At(skeleton.bindPos, distalIdx);
  const dirProx = vNorm(vSub(pJoint, pProx));
  const dirDistalBind = vNorm(vSub(pDistal, pJoint));

  let axis = vCross(dirProx, dirDistalBind);
  if (vLen(axis) < 1e-9) {
    const fallback = Math.abs(dirProx.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    axis = vCross(dirProx, fallback);
  }
  axis = vNorm(axis);
  const angle = Math.PI / 2; // "bend the elbow/knee 90 deg", verbatim

  const dirDistalPosed = rotateAroundAxis(dirDistalBind, axis, angle);
  const bisectBind = vNorm(vAdd(dirProx, dirDistalBind));
  const bisectPosed = vNorm(vAdd(dirProx, dirDistalPosed));

  // The distal (joint) bone's delta rotation relative to bind — a quaternion
  // of `angle` about `axis`. The proximal bone's delta is identity (it does
  // not move in this test).
  const half = angle / 2;
  const qJointDelta = { x: axis.x * Math.sin(half), y: axis.y * Math.sin(half), z: axis.z * Math.sin(half), w: Math.cos(half) };
  const qIdentity = { x: 0, y: 0, z: 0, w: 1 };

  let clampedInRing = 0;
  const posedRing = ringVerts.map((i) => {
    const v = vec3At(part.mesh.p, i);
    let qx = 0, qy = 0, qz = 0, qw = 0;
    let wProx = 0, wJoint = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k] / 255;
      if (w === 0) continue;
      const b = skinIndex[i * 4 + k];
      const q = b === jointIdx ? qJointDelta : qIdentity; // anything else (proximal, or a pad slot) does not move
      if (b === jointIdx) wJoint += w; else wProx += w;
      // Hemisphere-align against qIdentity before accumulating — NLERP of
      // quaternions requires a consistent sign choice (q and -q are the
      // same rotation) so weighted contributions never cancel.
      const dot = q.x * qIdentity.x + q.y * qIdentity.y + q.z * qIdentity.z + q.w * qIdentity.w;
      const s = dot < 0 ? -1 : 1;
      qx += w * q.x * s; qy += w * q.y * s; qz += w * q.z * s; qw += w * q.w * s;
    }
    const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    const qBlend = len > 1e-12 ? { x: qx / len, y: qy / len, z: qz / len, w: qw / len } : qIdentity;
    // 0.5/0.5 quantises to 127/128 out of 255 (0.498/0.502), not bit-exact —
    // widen the tolerance past that rounding, not just float noise.
    if (Math.abs(wProx - 0.5) < 0.01 && Math.abs(wJoint - 0.5) < 0.01) clampedInRing++;
    return vAdd(pJoint, quatRotateVec(qBlend, vSub(v, pJoint)));
  });

  // The plain-LBS figure — informational only, never asserted on (see this
  // function's own doc comment): weighted AVERAGE OF ALREADY-TRANSFORMED
  // positions, the standard matrix-skinning formula, projected onto the
  // SAME posed bisecting plane so the two numbers are directly comparable.
  const lbsPosedRing = ringVerts.map((i) => {
    const v = vec3At(part.mesh.p, i);
    let out = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k] / 255;
      if (w === 0) continue;
      const b = skinIndex[i * 4 + k];
      const contrib = b === jointIdx ? vAdd(pJoint, rotateAroundAxis(vSub(v, pJoint), axis, angle)) : v;
      out = vAdd(out, vScale(contrib, w));
    }
    return out;
  });

  const bindArea = convexHullArea2D(projectOntoPlane(bindRing, pJoint, bisectBind));
  const posedArea = convexHullArea2D(projectOntoPlane(posedRing, pJoint, bisectPosed));
  const loss = bindArea > 0 ? 1 - posedArea / bindArea : 1;
  const lbsPosedArea = convexHullArea2D(projectOntoPlane(lbsPosedRing, pJoint, bisectPosed));
  const lbsLoss = bindArea > 0 ? 1 - lbsPosedArea / bindArea : 1;

  return {
    bindArea, posedArea, loss, lbsPosedArea, lbsLoss,
    ringVertexCount: seg, jointName: skeleton.names[jointIdx], clampedInRing, bindStats: stats,
  };
}

/** §11 step 3's elbow case: `UpperArmR -> ForearmR -> HandR`. */
export function elbowCandyWrapperCheck() {
  return measureCandyWrapper(buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR'));
}

/** §11 step 3's knee case: `UpLegR -> LegR -> FootR`. */
export function kneeCandyWrapperCheck() {
  return measureCandyWrapper(buildLimbFixture('humanoid', 'UpLegR', 'LegR', 'FootR'));
}

/**
 * A small, self-contained multi-part scene exercising every path
 * `rigcheck.mjs`'s generic checks need real counts for: a rigid part (a
 * "buckle" bound to `HandR`), the elbow's smooth 2-bone part, and a "cuff"
 * smooth part whose first ring is forced bit-identical to the elbow limb's
 * last ring — a deliberate, guaranteed weld-group of 2, with a genuinely
 * different bone/bias list on each side, so the merge actually recombines
 * two different weight vectors rather than trivially re-agreeing.
 * @returns {{ skeleton, parts, weldedRingVertexIndex: number, partIndexOfCuff: number }}
 */
export function buildDiagnosticScene() {
  const limb = buildLimbFixture('humanoid', 'UpperArmR', 'ForearmR', 'HandR');
  const { skeleton, part: limbPart, points, seg } = limb;
  const lastRingStart = (points.length - 1) * seg;

  const pDistal = points[points.length - 1];
  const dirEnd = vNorm(vSub(pDistal, points[points.length - 2]));
  const cuffPoints = [pDistal, vAdd(pDistal, vScale(dirEnd, 0.05))];
  const cuffMesh = tube(cuffPoints, () => LIMB_RADIUS, { seg: LIMB_SEG, caps: { start: false, end: true } });
  // Force the cuff's first ring bit-identical to the limb's last ring, so
  // the weld grid is GUARANTEED to group them (see this function's header).
  for (let j = 0; j < seg; j++) {
    cuffMesh.p[j * 3] = limbPart.mesh.p[lastRingStart * 3 + j * 3];
    cuffMesh.p[j * 3 + 1] = limbPart.mesh.p[lastRingStart * 3 + j * 3 + 1];
    cuffMesh.p[j * 3 + 2] = limbPart.mesh.p[lastRingStart * 3 + j * 3 + 2];
  }
  const cuffPart = { mesh: cuffMesh, bones: ['ForearmR', 'HandR'], bias: [0.5, 1.5] };

  const buckleMesh = boxRound(0.03, 0.02, 0.03, { seg: 6, rings: 4 });
  const buckleXform = vec3At(skeleton.bindPos, limb.distalIdx);
  for (let i = 0; i < buckleMesh.p.length / 3; i++) {
    buckleMesh.p[i * 3] += buckleXform.x;
    buckleMesh.p[i * 3 + 1] += buckleXform.y;
    buckleMesh.p[i * 3 + 2] += buckleXform.z;
  }
  const bucklePart = { mesh: buckleMesh, bone: 'HandR' };

  return { skeleton, parts: [limbPart, cuffPart, bucklePart] };
}

/**
 * Runs `bindSkin` against `buildDiagnosticScene()` (a rigid part, two smooth
 * parts, one deliberate weld group) and checks every one of §11 step 3's
 * generic invariants against the REAL output: weights sum to 255 exactly, no
 * influence below the cut, no vertex bound to a bone > 0.45 m away in bind
 * pose. One implementation, shared by `tools/rigcheck.mjs`'s `SKIN_GROUPS`
 * and `tests/actors/skin.test.js` (see this file's own header on why that
 * sharing matters — the `rig.js#reconstructBindPos` precedent).
 * @returns {{ scene, bound, totalVertices:number, totalInfluences:number,
 *   violations: { sum255: object[], cut: object[], distance: object[] } }}
 */
export function runSkinDiagnostics() {
  const scene = buildDiagnosticScene();
  const boneTails = computeBoneTails(scene.skeleton);
  const bound = bindSkin(scene.skeleton, scene.parts);

  const violations = { sum255: [], cut: [], distance: [] };
  let totalVertices = 0;
  let totalInfluences = 0;

  for (let p = 0; p < bound.results.length; p++) {
    const { skinIndex, skinWeight, vertexCount } = bound.results[p];
    const mesh = scene.parts[p].mesh;
    for (let i = 0; i < vertexCount; i++) {
      totalVertices++;
      const idx = [skinIndex[i * 4], skinIndex[i * 4 + 1], skinIndex[i * 4 + 2], skinIndex[i * 4 + 3]];
      const w = [skinWeight[i * 4], skinWeight[i * 4 + 1], skinWeight[i * 4 + 2], skinWeight[i * 4 + 3]];
      const sum = w[0] + w[1] + w[2] + w[3];
      if (sum !== 255) {
        violations.sum255.push({ part: p, vertex: i, detail: `weight sum ${sum} != 255`, expected: '255', actual: String(sum) });
      }
      const nonzero = w.filter((x) => x > 0);
      if (nonzero.length === 0) {
        violations.sum255.push({ part: p, vertex: i, detail: `vertex has zero live influences (unbound)`, expected: '>=1', actual: '0' });
      }
      totalInfluences += nonzero.length;
      const maxW = nonzero.length ? Math.max(...nonzero) : 0;
      const cutThreshold = SKIN_CONSTANTS.W_CUT * maxW;
      for (const wk of nonzero) {
        // Quantisation rounds to the nearest /255 unit — allow 2 units of
        // rounding slack past the float-space cut boundary, not a real gap.
        if (wk < cutThreshold - 2) {
          violations.cut.push({
            part: p, vertex: i,
            detail: `influence weight ${wk}/255 below cut (${SKIN_CONSTANTS.W_CUT} * max ${maxW})`,
            expected: `>= ${cutThreshold.toFixed(2)}`, actual: String(wk),
          });
        }
      }
      const v = vec3At(mesh.p, i);
      for (let k = 0; k < 4; k++) {
        if (w[k] === 0) continue;
        const bone = idx[k];
        const a = vec3At(scene.skeleton.bindPos, bone);
        const b = vec3At(boneTails, bone);
        const d = distancePointSegment(v, a, b);
        if (d > 0.45) {
          violations.distance.push({
            part: p, vertex: i, bone: scene.skeleton.names[bone],
            detail: `vertex bound to '${scene.skeleton.names[bone]}' at ${d.toFixed(4)} m`,
            expected: '<= 0.45', actual: d.toFixed(4),
          });
        }
      }
    }
  }

  return { scene, bound, totalVertices, totalInfluences, violations };
}
