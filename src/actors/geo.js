// src/actors/geo.js
//
// ACTR-4 — the geometry toolkit, `08-characters-visual.md` §3.1: `loft`,
// `tube`, `revolve`, `ellipsoid`, `boxRound`, `ribbon`, `spineRow`,
// `superEllipse`, plus the post-ops `computeNormals`, `weldNormals`,
// `displace`, `warp`, `transformMesh`, `mirrorX`, `appendMesh`. Mesh records
// are plain flat arrays `{ p[], n[], uv[], i[] }` — no `three`, no GPU
// resource, built once at load time and never touched again per frame.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file — `tools/check-imports.mjs` scans `src/actors/` with
// `checkGlobals: true` (O-29, verified clean), so this module must run
// headless. No `Math.random()` (rule 3) — `displace`/`warp` take an
// injected function from the caller, never a wall-clock or engine RNG read
// directly. No `Math.hypot` anywhere (banned — allocates); every length is
// `Math.sqrt(x*x+y*y+z*z)`, matching `rig.js`'s own `vLen`.
//
// This file does NOT import `rig.js` or any sibling — the small vector/quat
// helpers below are re-derived locally (same pattern `vessels.js`'s header
// describes for `motion.js`/`stats.js`: each file in this directory that
// needs a little math keeps its own copy rather than reaching across for a
// handful of lines). `rig.js`'s own quat helpers are not exported anyway.
//
// ---------------------------------------------------------------------------
// Decisions this ticket made where §3.1/§3.2 under-specify — flagged here,
// restated in the report
// ---------------------------------------------------------------------------
// 1. NO `taper` EXPORT. The backlog's "taper" is §3.1's own wording for
//    `tube` ("tapered tube along a polyline") — see this ticket's brief.
//    `tube`'s taper is the caller-supplied `profileFn(t)` radius curve.
//
// 2. `loft`'s general triangle/vertex arithmetic — the one rule every other
//    primitive here reduces to: given `rings` closed loops of `seg` points
//    each, the body contributes `(rings-1)*seg*2` triangles (a quad, split
//    into two triangles, per edge per ring gap) and each capped end adds a
//    single fan vertex plus `seg` triangles. This is §3.2's own formula,
//    verbatim, and every body-kit part in this ticket's brief (torso/pelvis/
//    arm/leg/neck via `tube`, shoulder-cap/head via `ellipsoid`, hand/foot
//    via `boxRound`) reduces to it exactly — see `tests/actors/geo.test.js`
//    for the full reconciliation against every row of §3.2's dense column,
//    which sums to the documented 1 304.
//
// 3. `ellipsoid`'s "latitude-clamped" reading. §3.2's shoulder-cap (5x10,
//    80 tris each, uncapped) and head (8x12, 168 tris, uncapped) rows both
//    match `(rings-1)*seg*2` with NO added cap term — so this ticket reads
//    "latitude-clamped" as: `ellipsoid` never emits a literal pole vertex or
//    a cap, at any `v0`/`v1`. If `v0`/`v1` were allowed to sit exactly at the
//    poles (`0`/`1`), the first/last ring would collapse to `seg` coincident
//    points and the quad-split immediately adjacent to it would emit
//    degenerate (zero-area) triangles — exactly what this ticket's
//    acceptance criterion forbids. So `v0`/`v1` are clamped away from the
//    exact poles by a small epsilon (`1e-3` of the polar angle) before
//    building rings; the visible effect is a sub-millimetre-scale opening at
//    each pole, invisible at any of this project's part scales, in exchange
//    for a mesh that is never degenerate at any parameter. `rings`/`seg`
//    themselves are not in §3.1's abbreviated signature (`{v0, v1}` only)
//    but the part list needs different values per use (5x10 vs 8x12), so
//    they are accepted as additional optional fields on the same options
//    object — an extension, not a contradiction, of the documented shape.
//
// 4. `boxRound`'s default `rings`/`seg` (4/6) reproduce §3.2's hand/foot row
//    exactly, and both ends are capped by default (`{ n, seg, rings,
//    roundY }` — again `seg`/`rings` are an extension of the abbreviated
//    signature, for the reason above). The hand's "thumb ridge" is NOT
//    separate geometry — §3.2 says the mitten is 48 triangles total, and a
//    plain capped `boxRound(rings=4, seg=6)` already IS 48
//    (`(4-1)*6*2 + 2*6`); the thumb is a shape perturbation of that same
//    loft's ring points (a per-archetype assembly concern, §3.3, out of this
//    ticket's scope), not additional topology `geo.js` needs to know about.
//
// 5. `revolve`/`ribbon`/`spineRow` are not in §3.2's body-kit table at all —
//    they surface in §3.3 (per-archetype geometry, explicitly out of this
//    ticket's reading list). This ticket implements them to the same general
//    `loft` arithmetic wherever they reduce to a loft (`revolve`, `ribbon`),
//    and to its own documented cone arithmetic for `spineRow` (below) —
//    verified in the test file against parameters this ticket chose, not
//    against a table row (none exists to check against).
//
// 6. `spineRow(path, n, scaleFn)` — the polyline is resampled to `n`
//    evenly-arc-length-spaced points, each producing one capped tapered
//    cone (a fan of `seg` side triangles from a single apex point, plus a
//    `seg`-triangle base cap — never a degenerate loft ring collapsed to a
//    point, which is exactly the trap `ellipsoid` avoids in decision 3
//    above). Total: `n * 2 * seg` triangles. `scaleFn(i, n)` returns either a
//    bare number (uniform scale of both the base radius and the cone length)
//    or `{ radius, length }` for independent control — not specified by
//    §3.1's one-line signature, so this ticket had to pick a shape.
//
// 7. UV convention: `u`/`v` are real metres of surface — `u` is the
//    cumulative perimeter distance around each ring (metres), `v` is the
//    cumulative centre-to-centre distance between successive rings
//    (metres). §3.4 (read through line 400 only, as instructed) says the
//    stored `uv` is "metres of surface ÷ TILE" — `TILE` is defined in §3.6,
//    which this ticket was told NOT to read, so the division is left for
//    whichever ticket owns that constant (materials/the merge step) to
//    apply. `geo.js`'s own `uv` output is therefore pre-division metres, not
//    the final tiled value — flagged again in the report.
//
// 8. `tube`'s parallel-transport frame is the simple incremental-rotation
//    form (rotate the previous frame's normal by the minimal rotation that
//    takes the previous tangent to the next one — Rodrigues' formula, no
//    trig-heavy re-derivation per ring), not the more numerically-robust
//    "double reflection" method some references use. This is correct and
//    stable for every path this project's limb/spine chains describe (no
//    180-degree tangent reversal mid-polyline); documented as a known
//    narrower guarantee, not a defect, in the report.
//
// 9. `weldNormals` builds a local `Map` keyed by quantised position to group
//    coincident vertices. This is NOT the "Map leaks / .clear() allocates"
//    pattern the brief bans — that rule targets POOLED, PER-FRAME state
//    reused across many calls; this Map is created fresh inside one
//    build-time call, read once, and left to the garbage collector when the
//    function returns, exactly like `rig.js`'s own build-time-only arrays.

// ---------------------------------------------------------------------------
// Small vector/quaternion helpers — build-time only, no `three`
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

/** Rotates `v` around unit `axis` by `angle` radians — Rodrigues' formula. */
function rotateAroundAxis(v, axis, angle) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const term1 = vScale(v, cosA);
  const term2 = vScale(vCross(axis, v), sinA);
  const term3 = vScale(axis, vDot(axis, v) * (1 - cosA));
  return vAdd(vAdd(term1, term2), term3);
}

/** Rotates vector `v` by unit quaternion `q` (optimized form, no matrix
 * build) — same formula `rig.js#quatRotateVec` uses, re-derived locally
 * (see file header for why this file does not import `rig.js`). */
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

/** Picks a reference vector guaranteed not parallel to `t` (a unit vector),
 * for building a starting normal in a tangent-perpendicular frame. */
function anyPerpReference(t) {
  return Math.abs(t.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
}

// ---------------------------------------------------------------------------
// Mesh record — { p[], n[], uv[], i[] }, flat arrays, plain numbers
// ---------------------------------------------------------------------------

function newMesh() {
  return { p: [], n: [], uv: [], i: [] };
}

function pushVertex(mesh, p, nx, ny, nz, u, v) {
  const idx = mesh.p.length / 3;
  mesh.p.push(p.x, p.y, p.z);
  mesh.n.push(nx, ny, nz);
  mesh.uv.push(u, v);
  return idx;
}

/** Cumulative perimeter distance (metres) at each point of a closed ring,
 * `u[0] = 0`. Real arc length, not a `j/seg` fraction — see decision 7. */
function ringPerimeterU(ring) {
  const seg = ring.length;
  const u = new Array(seg);
  u[0] = 0;
  for (let j = 1; j < seg; j++) u[j] = u[j - 1] + vDist(ring[j - 1], ring[j]);
  return u;
}

function ringCenter(ring) {
  let cx = 0, cy = 0, cz = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  const n = ring.length;
  return { x: cx / n, y: cy / n, z: cz / n };
}

function resolveCaps(caps) {
  if (!caps) return { start: false, end: false };
  if (caps === true) return { start: true, end: true };
  return { start: !!caps.start, end: !!caps.end };
}

/** Fans `seg` triangles from a new centre vertex to every edge of `ring`
 * (a closed loop) — exactly `seg` triangles, one new vertex. `flip` reverses
 * the winding, used for the start cap so it faces outward like the end cap
 * does. */
function addFanCap(mesh, ring, ringStart, seg, v, flip) {
  const center = ringCenter(ring);
  const centerIdx = pushVertex(mesh, center, 0, 0, 0, 0.5, v);
  for (let j = 0; j < seg; j++) {
    const jn = (j + 1) % seg;
    const a = ringStart + j;
    const b = ringStart + jn;
    if (flip) mesh.i.push(centerIdx, b, a);
    else mesh.i.push(centerIdx, a, b);
  }
}

// ---------------------------------------------------------------------------
// loft(rings, opts) — the core; everything below calls it
// ---------------------------------------------------------------------------

/**
 * @param {Array<Array<{x,y,z}>>} rings - `rings.length >= 2` closed loops of
 *   `seg` points each (`seg` identical across every ring).
 * @param {{ caps?: boolean|{start,end}, uvV?: number[] }} [opts]
 * @returns {{p:number[], n:number[], uv:number[], i:number[]}}
 */
export function loft(rings, opts = {}) {
  const ringCount = rings.length;
  if (ringCount < 2) throw new Error(`loft: need at least 2 rings, got ${ringCount}`);
  const seg = rings[0].length;
  if (seg < 3) throw new Error(`loft: need at least 3 points per ring, got ${seg}`);
  for (let r = 1; r < ringCount; r++) {
    if (rings[r].length !== seg) {
      throw new Error(`loft: ring ${r} has ${rings[r].length} points, expected ${seg} (ring 0's count)`);
    }
  }

  const caps = resolveCaps(opts.caps);
  const mesh = newMesh();
  const ringIndexStart = new Array(ringCount);

  let vCoords = opts.uvV;
  if (!vCoords) {
    vCoords = new Array(ringCount);
    vCoords[0] = 0;
    let prevCenter = ringCenter(rings[0]);
    for (let r = 1; r < ringCount; r++) {
      const center = ringCenter(rings[r]);
      vCoords[r] = vCoords[r - 1] + vDist(prevCenter, center);
      prevCenter = center;
    }
  }

  for (let r = 0; r < ringCount; r++) {
    ringIndexStart[r] = mesh.p.length / 3;
    const ring = rings[r];
    const u = ringPerimeterU(ring);
    for (let j = 0; j < seg; j++) {
      pushVertex(mesh, ring[j], 0, 0, 0, u[j], vCoords[r]);
    }
  }

  for (let r = 0; r < ringCount - 1; r++) {
    const a0 = ringIndexStart[r];
    const b0 = ringIndexStart[r + 1];
    for (let j = 0; j < seg; j++) {
      const jn = (j + 1) % seg;
      const a = a0 + j, aN = a0 + jn, b = b0 + j, bN = b0 + jn;
      mesh.i.push(a, b, bN);
      mesh.i.push(a, bN, aN);
    }
  }

  if (caps.start) addFanCap(mesh, rings[0], ringIndexStart[0], seg, vCoords[0], true);
  if (caps.end) addFanCap(mesh, rings[ringCount - 1], ringIndexStart[ringCount - 1], seg, vCoords[ringCount - 1], false);

  computeNormals(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// tube(points, profileFn, opts) — parallel-transport frames along a polyline
// ---------------------------------------------------------------------------

/** One rotation-minimizing frame per point of `points` (see decision 8). */
function buildParallelTransportFrames(points) {
  const n = points.length;
  const tangents = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) tangents[i] = vNorm(vSub(points[1], points[0]));
    else if (i === n - 1) tangents[i] = vNorm(vSub(points[n - 1], points[n - 2]));
    else tangents[i] = vNorm(vSub(points[i + 1], points[i - 1]));
  }

  const ref = anyPerpReference(tangents[0]);
  let normal = vNorm(vSub(ref, vScale(tangents[0], vDot(ref, tangents[0]))));
  const frames = [{ tangent: tangents[0], normal, binormal: vNorm(vCross(tangents[0], normal)) }];

  for (let i = 1; i < n; i++) {
    const prevT = tangents[i - 1];
    const curT = tangents[i];
    const axis = vCross(prevT, curT);
    const axisLen = vLen(axis);
    let newNormal = frames[i - 1].normal;
    if (axisLen > 1e-9) {
      const axisN = vScale(axis, 1 / axisLen);
      const cosAngle = Math.min(1, Math.max(-1, vDot(prevT, curT)));
      const angle = Math.acos(cosAngle);
      newNormal = rotateAroundAxis(frames[i - 1].normal, axisN, angle);
    }
    // Re-orthogonalize against the new tangent so drift never accumulates.
    const binormal = vNorm(vCross(curT, newNormal));
    const normalOrtho = vNorm(vCross(binormal, curT));
    frames.push({ tangent: curT, normal: normalOrtho, binormal });
  }
  return frames;
}

/**
 * @param {Array<{x,y,z}>} points - the polyline; one ring per point, so
 *   `points.length` IS the loft's `rings` count.
 * @param {(t:number, idx:number) => number} profileFn - returns the ring
 *   radius at `t` in `[0,1]` (also given the raw ring index).
 * @param {{ seg?: number, caps?: boolean|{start,end}, uvV?: number[] }} [opts]
 */
export function tube(points, profileFn, opts = {}) {
  if (points.length < 2) throw new Error(`tube: need at least 2 points, got ${points.length}`);
  const seg = opts.seg ?? 8;
  const frames = buildParallelTransportFrames(points);
  const rings = points.map((pt, idx) => {
    const t = points.length === 1 ? 0 : idx / (points.length - 1);
    const radius = profileFn(t, idx);
    const { normal, binormal } = frames[idx];
    const ring = new Array(seg);
    for (let j = 0; j < seg; j++) {
      const theta = (2 * Math.PI * j) / seg;
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      ring[j] = {
        x: pt.x + radius * (cosT * normal.x + sinT * binormal.x),
        y: pt.y + radius * (cosT * normal.y + sinT * binormal.y),
        z: pt.z + radius * (cosT * normal.z + sinT * binormal.z),
      };
    }
    return ring;
  });
  return loft(rings, { caps: opts.caps, uvV: opts.uvV });
}

// ---------------------------------------------------------------------------
// revolve(profile, seg) — 2D [r, y] profile about +Y
// ---------------------------------------------------------------------------

/**
 * @param {Array<{r,y}|[number,number]>} profile - `[r, y]` pairs (or
 *   `{r,y}` objects), `rings.length = profile.length`.
 * @param {number} seg
 * @param {{ caps?: boolean|{start,end} }} [opts] - not in §3.1's abbreviated
 *   two-arg signature; an extension (see decision 5). Left `false` by
 *   default — a caller that wants a capped end must ensure that end's `r`
 *   is not 0 (a zero-radius capped ring degenerates the cap fan).
 */
export function revolve(profile, seg, opts = {}) {
  if (profile.length < 2) throw new Error(`revolve: need at least 2 profile points, got ${profile.length}`);
  const rings = profile.map((entry) => {
    const r = Array.isArray(entry) ? entry[0] : entry.r;
    const y = Array.isArray(entry) ? entry[1] : entry.y;
    const ring = new Array(seg);
    for (let j = 0; j < seg; j++) {
      const theta = (2 * Math.PI * j) / seg;
      ring[j] = { x: r * Math.cos(theta), y, z: r * Math.sin(theta) };
    }
    return ring;
  });
  return loft(rings, { caps: opts.caps });
}

// ---------------------------------------------------------------------------
// ellipsoid(rx, ry, rz, {v0, v1}) — latitude-clamped, never capped
// ---------------------------------------------------------------------------

const ELLIPSOID_POLE_EPS = 1e-3;

/**
 * @param {number} rx
 * @param {number} ry
 * @param {number} rz
 * @param {{ v0?: number, v1?: number, rings?: number, seg?: number }} [opts]
 *   `v0`/`v1` in `[0,1]` (0 = south pole, 1 = north pole), clamped away from
 *   the exact poles (see decision 3). `rings`/`seg` are an extension of
 *   §3.1's abbreviated `{v0, v1}` shape — needed because the part list uses
 *   different values per use (5x10 shoulder cap, 8x12 head).
 */
export function ellipsoid(rx, ry, rz, opts = {}) {
  const rings = opts.rings ?? 8;
  const seg = opts.seg ?? 12;
  if (rings < 2) throw new Error(`ellipsoid: need at least 2 rings, got ${rings}`);
  const v0 = Math.min(Math.max(opts.v0 ?? 0, ELLIPSOID_POLE_EPS), 1 - ELLIPSOID_POLE_EPS);
  const v1 = Math.min(Math.max(opts.v1 ?? 1, ELLIPSOID_POLE_EPS), 1 - ELLIPSOID_POLE_EPS);

  const rings_ = new Array(rings);
  for (let i = 0; i < rings; i++) {
    const t = rings === 1 ? 0 : i / (rings - 1);
    const v = v0 + (v1 - v0) * t;
    const theta = v * Math.PI;
    const y = ry * Math.cos(theta);
    const s = Math.sin(theta);
    const ring = new Array(seg);
    for (let j = 0; j < seg; j++) {
      const phi = (2 * Math.PI * j) / seg;
      ring[j] = { x: rx * s * Math.cos(phi), y, z: rz * s * Math.sin(phi) };
    }
    rings_[i] = ring;
  }
  // Never capped — see decision 3 (a real pole ring would collapse to a
  // point, producing degenerate triangles; `opts.caps` is deliberately not
  // read here at all).
  return loft(rings_, { caps: false });
}

// ---------------------------------------------------------------------------
// superEllipse(rx, rz, n, seg) — ring generator, profile source
// ---------------------------------------------------------------------------

/**
 * @param {number} rx
 * @param {number} rz
 * @param {number} n - `2` = ellipse, `>= 6` = increasingly rounded box.
 * @param {number} seg
 * @returns {Array<{x,z}>}
 */
export function superEllipse(rx, rz, n, seg) {
  const exponent = 2 / n;
  const pts = new Array(seg);
  for (let j = 0; j < seg; j++) {
    const phi = (2 * Math.PI * j) / seg;
    const c = Math.cos(phi), s = Math.sin(phi);
    const cs = c < 0 ? -1 : 1;
    const ss = s < 0 ? -1 : 1;
    pts[j] = { x: cs * Math.pow(Math.abs(c), exponent) * rx, z: ss * Math.pow(Math.abs(s), exponent) * rz };
  }
  return pts;
}

// ---------------------------------------------------------------------------
// boxRound(hx, hy, hz, {n, roundY}) — superellipse rings under a rounding
// envelope, capped both ends
// ---------------------------------------------------------------------------

/**
 * @param {number} hx
 * @param {number} hy
 * @param {number} hz
 * @param {{ n?: number, roundY?: boolean, seg?: number, rings?: number,
 *   caps?: boolean|{start,end} }} [opts] `seg`/`rings` default to 6/4 —
 *   §3.2's hand/foot row (`(4-1)*6*2 + 2*6 = 48`, decision 4).
 */
export function boxRound(hx, hy, hz, opts = {}) {
  const n = opts.n ?? 4;
  const seg = opts.seg ?? 6;
  const rings = opts.rings ?? 4;
  const roundY = opts.roundY ?? true;
  if (rings < 2) throw new Error(`boxRound: need at least 2 rings, got ${rings}`);
  const profile = superEllipse(hx, hz, n, seg);

  const ringsArr = new Array(rings);
  for (let i = 0; i < rings; i++) {
    const t = rings === 1 ? 0.5 : i / (rings - 1);
    const y = -hy + 2 * hy * t;
    let scale = 1;
    if (roundY) {
      // Cosine-based rounding envelope: 1 at the middle, pulled in (but
      // never to 0 — that would degenerate the end caps) at the ends.
      const edge = Math.min(t, 1 - t);
      scale = 0.55 + 0.45 * Math.sin(edge * Math.PI);
    }
    ringsArr[i] = profile.map((p) => ({ x: p.x * scale, y, z: p.z * scale }));
  }
  return loft(ringsArr, { caps: opts.caps ?? { start: true, end: true } });
}

// ---------------------------------------------------------------------------
// ribbon(points, w, t, {upright}) — flat extrusion along a polyline
// ---------------------------------------------------------------------------

/** Like `buildParallelTransportFrames`, but the "width" axis is always the
 * tangent-perpendicular projection of world-up rather than propagated frame
 * to frame — this is what `upright` buys: a hem/strap/sling that never
 * twists as the path bends, at the cost of a frame flip if the path ever
 * runs exactly vertical (guarded below with a fallback axis). */
function buildUprightFrames(points) {
  const n = points.length;
  const frames = new Array(n);
  const worldUp = { x: 0, y: 1, z: 0 };
  for (let i = 0; i < n; i++) {
    let t;
    if (i === 0) t = vNorm(vSub(points[1], points[0]));
    else if (i === n - 1) t = vNorm(vSub(points[n - 1], points[n - 2]));
    else t = vNorm(vSub(points[i + 1], points[i - 1]));
    let normal = vSub(worldUp, vScale(t, vDot(worldUp, t)));
    let normalLen = vLen(normal);
    if (normalLen < 1e-6) {
      normal = { x: 1, y: 0, z: 0 };
      normalLen = 1;
    }
    normal = vScale(normal, 1 / normalLen);
    frames[i] = { tangent: t, normal, binormal: vNorm(vCross(t, normal)) };
  }
  return frames;
}

/**
 * @param {Array<{x,y,z}>} points
 * @param {number} w - width
 * @param {number} t - thickness
 * @param {{ upright?: boolean, caps?: boolean|{start,end} }} [opts]
 */
export function ribbon(points, w, t, opts = {}) {
  if (points.length < 2) throw new Error(`ribbon: need at least 2 points, got ${points.length}`);
  const halfW = w / 2, halfT = t / 2;
  const frames = opts.upright ? buildUprightFrames(points) : buildParallelTransportFrames(points);
  const rings = points.map((pt, idx) => {
    const { normal, binormal } = frames[idx];
    const wN = vScale(normal, halfW);
    const tB = vScale(binormal, halfT);
    return [
      vAdd(vAdd(pt, wN), tB),
      vAdd(vSub(pt, wN), tB),
      vSub(vSub(pt, wN), tB),
      vSub(vAdd(pt, wN), tB),
    ];
  });
  return loft(rings, { caps: opts.caps ?? false });
}

// ---------------------------------------------------------------------------
// spineRow(path, n, scaleFn) — n tapered cones distributed along a path
// ---------------------------------------------------------------------------

/** Resamples a polyline to `count` evenly arc-length-spaced points, each
 * with a local tangent. `count === 1` returns the path's start point with
 * the first segment's tangent. */
function resamplePolyline(path, count) {
  if (path.length < 2) throw new Error(`resamplePolyline: need at least 2 path points, got ${path.length}`);
  const segLens = new Array(path.length - 1);
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    segLens[i] = vDist(path[i], path[i + 1]);
    total += segLens[i];
  }
  const out = new Array(count);
  for (let k = 0; k < count; k++) {
    const target = count === 1 ? 0 : (total * k) / (count - 1);
    let acc = 0;
    let segIdx = path.length - 2;
    for (let i = 0; i < segLens.length; i++) {
      if (target <= acc + segLens[i] || i === segLens.length - 1) {
        segIdx = i;
        break;
      }
      acc += segLens[i];
    }
    const segLen = segLens[segIdx];
    const localT = segLen > 1e-12 ? Math.min(1, Math.max(0, (target - acc) / segLen)) : 0;
    const a = path[segIdx], b = path[segIdx + 1];
    const pos = vAdd(a, vScale(vSub(b, a), localT));
    const tangent = vNorm(vSub(b, a));
    out[k] = { pos, tangent };
  }
  return out;
}

/** One capped tapered cone: a `seg`-triangle side fan from a single apex
 * point plus a `seg`-triangle base cap — `2*seg` triangles, `seg+2`
 * vertices. Never a degenerate loft ring (see decision 6). */
function buildCone(base, tangent, radius, length, seg) {
  const t = vNorm(tangent);
  const ref = anyPerpReference(t);
  const normal = vNorm(vSub(ref, vScale(t, vDot(ref, t))));
  const binormal = vNorm(vCross(t, normal));

  const mesh = newMesh();
  for (let j = 0; j < seg; j++) {
    const theta = (2 * Math.PI * j) / seg;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const p = {
      x: base.x + radius * (cosT * normal.x + sinT * binormal.x),
      y: base.y + radius * (cosT * normal.y + sinT * binormal.y),
      z: base.z + radius * (cosT * normal.z + sinT * binormal.z),
    };
    pushVertex(mesh, p, 0, 0, 0, j / seg, 0);
  }
  const apex = vAdd(base, vScale(t, length));
  const apexIdx = pushVertex(mesh, apex, 0, 0, 0, 0.5, 1);
  const baseCenterIdx = pushVertex(mesh, base, 0, 0, 0, 0.5, 0);

  for (let j = 0; j < seg; j++) {
    const jn = (j + 1) % seg;
    mesh.i.push(apexIdx, j, jn);
  }
  for (let j = 0; j < seg; j++) {
    const jn = (j + 1) % seg;
    mesh.i.push(baseCenterIdx, jn, j);
  }
  computeNormals(mesh);
  return mesh;
}

/**
 * @param {Array<{x,y,z}>} path - polyline, resampled to `n` cones (decision 6).
 * @param {number} n
 * @param {(i:number, n:number) => number|{radius?:number, length?:number}} [scaleFn]
 *   uniform scale, or independent radius/length scale, relative to
 *   `opts.baseRadius`/`opts.baseLength`. Optional — defaults to uniform 1.
 * @param {{ seg?: number, baseRadius?: number, baseLength?: number }} [opts]
 */
export function spineRow(path, n, scaleFn, opts = {}) {
  if (n < 1) throw new Error(`spineRow: n must be >= 1, got ${n}`);
  const seg = opts.seg ?? 6;
  const baseRadius = opts.baseRadius ?? 0.03;
  const baseLength = opts.baseLength ?? 0.08;
  const samples = resamplePolyline(path, n);

  let mesh = newMesh();
  for (let i = 0; i < n; i++) {
    const s = scaleFn ? scaleFn(i, n) : 1;
    const radiusScale = typeof s === 'number' ? s : (s.radius ?? 1);
    const lengthScale = typeof s === 'number' ? s : (s.length ?? 1);
    const cone = buildCone(samples[i].pos, samples[i].tangent, baseRadius * radiusScale, baseLength * lengthScale, seg);
    mesh = appendMesh(mesh, cone);
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// Post-ops
// ---------------------------------------------------------------------------

/** Recomputes every vertex normal from the current triangle list (area-
 * weighted, via unnormalized face-normal accumulation) and normalizes.
 * Mutates `mesh.n` in place; returns `mesh`. Safe to call again after
 * `displace`/`warp` moves positions. */
export function computeNormals(mesh) {
  const vCount = mesh.p.length / 3;
  const n = mesh.n;
  for (let k = 0; k < vCount * 3; k++) n[k] = 0;

  const idx = mesh.i;
  const p = mesh.p;
  for (let f = 0; f < idx.length; f += 3) {
    const ia = idx[f], ib = idx[f + 1], ic = idx[f + 2];
    const ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2];
    const bx = p[ib * 3], by = p[ib * 3 + 1], bz = p[ib * 3 + 2];
    const cx = p[ic * 3], cy = p[ic * 3 + 1], cz = p[ic * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    n[ia * 3] += fx; n[ia * 3 + 1] += fy; n[ia * 3 + 2] += fz;
    n[ib * 3] += fx; n[ib * 3 + 1] += fy; n[ib * 3 + 2] += fz;
    n[ic * 3] += fx; n[ic * 3 + 1] += fy; n[ic * 3 + 2] += fz;
  }

  for (let v = 0; v < vCount; v++) {
    const x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-12) {
      n[v * 3] = x / len; n[v * 3 + 1] = y / len; n[v * 3 + 2] = z / len;
    } else {
      // An isolated vertex with no contributing face (never happens for
      // anything this file builds, kept so the function is total).
      n[v * 3] = 0; n[v * 3 + 1] = 1; n[v * 3 + 2] = 0;
    }
  }
  return mesh;
}

/** Averages normals across vertices whose positions coincide within `eps`
 * (so smooth normals cross loft seams — the ring-wrap seam within one mesh,
 * or the join between two appended meshes). Mutates `mesh.n` in place. The
 * grouping `Map` is local and build-time-only (see decision 9). */
export function weldNormals(mesh, eps = 1e-4) {
  const vCount = mesh.p.length / 3;
  const groups = new Map();
  for (let i = 0; i < vCount; i++) {
    const qx = Math.round(mesh.p[i * 3] / eps);
    const qy = Math.round(mesh.p[i * 3 + 1] / eps);
    const qz = Math.round(mesh.p[i * 3 + 2] / eps);
    const key = `${qx}_${qy}_${qz}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(i);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let sx = 0, sy = 0, sz = 0;
    for (const i of g) {
      sx += mesh.n[i * 3]; sy += mesh.n[i * 3 + 1]; sz += mesh.n[i * 3 + 2];
    }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len > 1e-12) { sx /= len; sy /= len; sz /= len; } else { sx = 0; sy = 1; sz = 0; }
    for (const i of g) {
      mesh.n[i * 3] = sx; mesh.n[i * 3 + 1] = sy; mesh.n[i * 3 + 2] = sz;
    }
  }
  return mesh;
}

/**
 * Moves every vertex along its CURRENT normal by `fn(i, p, n)` (a scalar
 * offset in metres) — normal-direction noise for bone pitting and cloth
 * folds. `fn` is caller-supplied; never seed this from `Math.random()` or
 * the wall clock (rule 3) — pass an injected RNG/deterministic function.
 * Does not recompute normals afterward (the displacement may be large
 * enough that the old normals are no longer a good approximation) — call
 * `computeNormals` again if that matters for the caller's use.
 */
export function displace(mesh, fn) {
  const vCount = mesh.p.length / 3;
  for (let i = 0; i < vCount; i++) {
    const p = { x: mesh.p[i * 3], y: mesh.p[i * 3 + 1], z: mesh.p[i * 3 + 2] };
    const nrm = { x: mesh.n[i * 3], y: mesh.n[i * 3 + 1], z: mesh.n[i * 3 + 2] };
    const amount = fn(i, p, nrm);
    mesh.p[i * 3] += nrm.x * amount;
    mesh.p[i * 3 + 1] += nrm.y * amount;
    mesh.p[i * 3 + 2] += nrm.z * amount;
  }
  return mesh;
}

/** Arbitrary per-vertex position remap: `fn(i, p) => {x,y,z}`. Does not
 * touch normals — call `computeNormals` after if the warp changes shape
 * enough to matter. */
export function warp(mesh, fn) {
  const vCount = mesh.p.length / 3;
  for (let i = 0; i < vCount; i++) {
    const p = { x: mesh.p[i * 3], y: mesh.p[i * 3 + 1], z: mesh.p[i * 3 + 2] };
    const np = fn(i, p);
    mesh.p[i * 3] = np.x; mesh.p[i * 3 + 1] = np.y; mesh.p[i * 3 + 2] = np.z;
  }
  return mesh;
}

/**
 * Applies a rigid transform (uniform-or-axis scale, then rotation, then
 * translation) to every vertex position and normal. Normals are rotated
 * only, then re-normalized — exact for uniform scale, an approximation for
 * non-uniform scale (the correct inverse-transpose correction is not needed
 * by anything in this ticket's scope; flagged in the report).
 * @param {object} mesh
 * @param {{ pos?: {x,y,z}, quat?: {x,y,z,w}, scale?: number|{x,y,z} }} [xform]
 */
export function transformMesh(mesh, xform = {}) {
  const pos = xform.pos ?? { x: 0, y: 0, z: 0 };
  const quat = xform.quat ?? { x: 0, y: 0, z: 0, w: 1 };
  const scale = typeof xform.scale === 'number'
    ? { x: xform.scale, y: xform.scale, z: xform.scale }
    : (xform.scale ?? { x: 1, y: 1, z: 1 });

  const vCount = mesh.p.length / 3;
  for (let i = 0; i < vCount; i++) {
    let p = { x: mesh.p[i * 3] * scale.x, y: mesh.p[i * 3 + 1] * scale.y, z: mesh.p[i * 3 + 2] * scale.z };
    p = quatRotateVec(quat, p);
    mesh.p[i * 3] = p.x + pos.x;
    mesh.p[i * 3 + 1] = p.y + pos.y;
    mesh.p[i * 3 + 2] = p.z + pos.z;

    let nrm = { x: mesh.n[i * 3], y: mesh.n[i * 3 + 1], z: mesh.n[i * 3 + 2] };
    nrm = quatRotateVec(quat, nrm);
    const len = Math.sqrt(nrm.x * nrm.x + nrm.y * nrm.y + nrm.z * nrm.z);
    if (len > 1e-12) {
      mesh.n[i * 3] = nrm.x / len; mesh.n[i * 3 + 1] = nrm.y / len; mesh.n[i * 3 + 2] = nrm.z / len;
    }
  }
  return mesh;
}

/** Mirrors across `x = 0` — negates `x` on positions and normals, and swaps
 * each triangle's last two indices to flip winding back to outward-facing
 * (mirroring one axis inverts handedness). */
export function mirrorX(mesh) {
  const vCount = mesh.p.length / 3;
  for (let i = 0; i < vCount; i++) {
    mesh.p[i * 3] = -mesh.p[i * 3];
    mesh.n[i * 3] = -mesh.n[i * 3];
  }
  for (let f = 0; f < mesh.i.length; f += 3) {
    const tmp = mesh.i[f + 1];
    mesh.i[f + 1] = mesh.i[f + 2];
    mesh.i[f + 2] = tmp;
  }
  return mesh;
}

/** Concatenates `b` after `a`, offsetting `b`'s indices by `a`'s vertex
 * count. Non-mutating — returns a new mesh record; both inputs are left
 * untouched. */
export function appendMesh(a, b) {
  const vOffset = a.p.length / 3;
  const i = a.i.concat(b.i.map((idx) => idx + vOffset));
  return {
    p: a.p.concat(b.p),
    n: a.n.concat(b.n),
    uv: a.uv.concat(b.uv),
    i,
  };
}
