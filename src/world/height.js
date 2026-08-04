// src/world/height.js
//
// WRLD-4 (round 2 — the coordinator's widened grant) — `07-world-gen.md`
// §1.3's terrace field: `world.groundHeight(x, z)` is `terrace(x, z) +
// noise(x, z)`, an analytic function built from
//   1. a small set of TERRACES — closed regions on the build lattice, each
//      one constant elevation. No generator (WRLD-5..8) authors real ones
//      yet — see `index.js`'s own `DEFAULT_TERRACES` for the honest,
//      documented placeholder this ticket uses instead (one boundless
//      terrace at 0.00 m, exactly what §1.3 says the town has).
//   2. a COSMETIC DISPLACEMENT of amplitude ±0.12 m, sampled on a 2 m
//      lattice with a 3-octave value-noise function and bilinearly
//      interpolated to any query point (§1.3's own pseudocode, reproduced
//      exactly by `sampleHeightField` below).
//
// ---------------------------------------------------------------------------
// The lattice table is built ONCE PER ZONE, not sampled fresh per query
// ---------------------------------------------------------------------------
// `buildHeightField` evaluates the 3-octave noise at every one of the
// `(sizeX/2 + 1) * (sizeZ/2 + 1)` 2 m-lattice points a single time — called
// from `index.js`'s `enterZone`, between frames, the same "allocate once at
// the zone transition, read-only and allocation-free after that" shape
// `staticFootprints` already uses — and stores the result in a
// `Float32Array`. `sampleHeightField` (what `world.groundHeight` forwards
// into) then does ONLY a bilinear lookup into that table — no octave
// computation at query time — which is what keeps it `Fixed: Y, Alloc: no`
// even though the underlying noise function itself is not cheap.
//
// ---------------------------------------------------------------------------
// The noise seed — the `S1 shape` stream does not exist yet
// ---------------------------------------------------------------------------
// `07` §1.3 says the cosmetic displacement is "seeded from the S1 shape
// stream" (`07` §1.8's seven-stream layout). This ticket's first pass
// declined to build that stream set — there is no generator yet to consume
// S0-S6 either, and `index.js`'s own header already documents "no
// `ctx.rng.fork()` in THIS ticket, on purpose" (still true; nothing here
// forks `ctx.rng`). `buildHeightField` therefore takes `noiseSeed` as a
// plain parameter; `index.js` passes it the zone's own
// `seedFor(zoneId, runIndex)` value (already computed every `enterZone`,
// already deterministic, already used for `zone:enter`'s own payload) as
// the interim source. A future ticket that builds the real `07` §1.8 stream
// set swaps that one call site to pass `S1`'s own draw instead — nothing
// in this file needs to change for that.
//
// ---------------------------------------------------------------------------
// The hash / noise functions are self-authored, like `index.js`'s `hashSeed`
// ---------------------------------------------------------------------------
// `latticeHash01` and the value-noise octave stack below are not validated
// against an external reference implementation — the same documented
// caveat `index.js`'s own `hashSeed` and `src/core/rng.js`'s
// `splitMix32Step` carry. They only have to be deterministic (same inputs
// -> same output, always, which is what the 400-point brute-force test in
// `tests/world/wrld4.test.js` checks) and to actually vary smoothly enough
// to read as terrain-scale noise; no downstream contract depends on
// matching a specific noise algorithm bit-for-bit.
//
// Node-safe: no `three`, no `document`/`window`/`performance.now()`
// anywhere in this file.

const LATTICE_CELL_SIZE = 2.0; // metres — 07 §1.3, fixed
const NOISE_AMPLITUDE = 0.24; // metres, peak-to-peak (±0.12 m — 07 §1.3)

/**
 * The terrace elevation at `(x, z)`. `terraces` is a list of
 * `{ elevation: number, bounds?: {minX,minZ,maxX,maxZ} }` — a terrace with
 * no `bounds` covers the whole zone (the base/fallback layer, what every
 * zone gets today — see `index.js`'s `DEFAULT_TERRACES`). Later entries win
 * over earlier ones inside their own bounds, so a future generator can
 * layer a small terrace (a dais, a sunken room) on top of a larger one
 * without this function changing. Node-safe, allocation-free.
 * @param {ReadonlyArray<{elevation:number, bounds?:{minX:number,minZ:number,maxX:number,maxZ:number}}>} terraces
 * @param {number} x
 * @param {number} z
 * @returns {number} metres
 */
export function terraceElevationAt(terraces, x, z) {
  let elevation = 0; // documented fallback if `terraces` is empty — never hit today, every zone always gets DEFAULT_TERRACES
  for (let i = 0; i < terraces.length; i++) {
    const t = terraces[i];
    const b = t.bounds;
    if (!b || (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)) {
      elevation = t.elevation;
    }
  }
  return elevation;
}

/**
 * Deterministic 2D integer lattice hash -> `[0, 1)`. Self-authored (see the
 * file header). `ix`/`iz` are integer lattice coordinates; `seed` is folded
 * in as a third axis so different octaves/zones never share a pattern.
 * @param {number} ix
 * @param {number} iz
 * @param {number} seed
 * @returns {number} `[0, 1)`
 */
function latticeHash01(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

/** Cubic smoothstep, `3t^2 - 2t^3` — the standard value-noise interpolant
 * (continuous first derivative at cell boundaries, unlike a plain lerp).
 * @param {number} t
 * @returns {number} */
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * One octave of value noise at world coordinates `(x, z)`, lattice pitch
 * `cellSize`. Four corner hashes, smoothstep-interpolated. `[0, 1)`-valued.
 * @param {number} x
 * @param {number} z
 * @param {number} cellSize
 * @param {number} seed
 * @returns {number}
 */
function valueNoiseOctave(x, z, cellSize, seed) {
  const gx = x / cellSize;
  const gz = z / cellSize;
  const ix0 = Math.floor(gx);
  const iz0 = Math.floor(gz);
  const fx = smoothstep(gx - ix0);
  const fz = smoothstep(gz - iz0);

  const v00 = latticeHash01(ix0, iz0, seed);
  const v10 = latticeHash01(ix0 + 1, iz0, seed);
  const v01 = latticeHash01(ix0, iz0 + 1, seed);
  const v11 = latticeHash01(ix0 + 1, iz0 + 1, seed);

  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}

/**
 * `07` §1.3: "a 3-octave value-noise function". Base cell 8 m, halving each
 * octave down to 2 m (the lattice's own pitch), weights 4:2:1 (summing to
 * 1, so the result stays in `[0, 1)`). Each octave draws from a distinct
 * `seed + n` so the three layers never simply scale one another.
 * @param {number} x
 * @param {number} z
 * @param {number} seed
 * @returns {number} `[0, 1)`
 */
function valueNoise3Octave(x, z, seed) {
  const n0 = valueNoiseOctave(x, z, 8, seed);
  const n1 = valueNoiseOctave(x, z, 4, seed + 1);
  const n2 = valueNoiseOctave(x, z, 2, seed + 2);
  return n0 * (4 / 7) + n1 * (2 / 7) + n2 * (1 / 7);
}

/**
 * Builds one zone's height field: the terrace list (kept as given, never
 * copied/mutated) plus a precomputed `(sizeX/2+1) x (sizeZ/2+1)` table of
 * 3-octave value noise, one sample per 2 m lattice point. `Alloc: yes` —
 * called once per `enterZone`, between frames (see the file header),
 * mirroring `staticFootprints`'s own build-once-per-zone shape.
 * @param {{sizeX:number, sizeZ:number, terraces:ReadonlyArray<object>, noiseSeed:number}} opts
 * @returns {{
 *   terraces: ReadonlyArray<object>,
 *   cellSize: number,
 *   latticeWidth: number,
 *   latticeHeight: number,
 *   originX: number,
 *   originZ: number,
 *   table: Float32Array,
 * }}
 */
export function buildHeightField({ sizeX, sizeZ, terraces, noiseSeed }) {
  const cellSize = LATTICE_CELL_SIZE;
  const latticeWidth = Math.round(sizeX / cellSize) + 1;
  const latticeHeight = Math.round(sizeZ / cellSize) + 1;
  const originX = -sizeX / 2;
  const originZ = -sizeZ / 2;

  const table = new Float32Array(latticeWidth * latticeHeight);
  for (let iz = 0; iz < latticeHeight; iz++) {
    const worldZ = originZ + iz * cellSize;
    const row = iz * latticeWidth;
    for (let ix = 0; ix < latticeWidth; ix++) {
      const worldX = originX + ix * cellSize;
      table[row + ix] = valueNoise3Octave(worldX, worldZ, noiseSeed);
    }
  }

  return { terraces, cellSize, latticeWidth, latticeHeight, originX, originZ, table };
}

/**
 * `07` §1.3's `groundHeight(x, z)`, exactly the pseudocode: terrace
 * elevation plus a bilinearly-interpolated read of the precomputed noise
 * table, scaled to ±0.12 m. `Fixed: Y, Alloc: no` — only arithmetic and
 * typed-array reads; no octave computation happens here (that already ran
 * once, in `buildHeightField`).
 * @param {ReturnType<typeof buildHeightField>} field
 * @param {number} x
 * @param {number} z
 * @returns {number} metres
 */
export function sampleHeightField(field, x, z) {
  const t = terraceElevationAt(field.terraces, x, z);

  let u = (x - field.originX) / field.cellSize;
  let v = (z - field.originZ) / field.cellSize;
  const maxU = field.latticeWidth - 1;
  const maxV = field.latticeHeight - 1;
  if (u < 0) u = 0;
  else if (u > maxU) u = maxU;
  if (v < 0) v = 0;
  else if (v > maxV) v = maxV;

  let ix0 = Math.floor(u);
  let iz0 = Math.floor(v);
  if (ix0 > field.latticeWidth - 2) ix0 = field.latticeWidth - 2;
  if (iz0 > field.latticeHeight - 2) iz0 = field.latticeHeight - 2;
  if (ix0 < 0) ix0 = 0;
  if (iz0 < 0) iz0 = 0;

  const fx = u - ix0;
  const fz = v - iz0;
  const w = field.latticeWidth;
  const table = field.table;

  const n00 = table[iz0 * w + ix0];
  const n10 = table[iz0 * w + ix0 + 1];
  const n01 = table[(iz0 + 1) * w + ix0];
  const n11 = table[(iz0 + 1) * w + ix0 + 1];

  const a = n00 + (n10 - n00) * fx;
  const b = n01 + (n11 - n01) * fx;
  const n = a + (b - a) * fz;

  return t + (n - 0.5) * NOISE_AMPLITUDE;
}
