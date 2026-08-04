// src/materials/forge.js
//
// MATL-1 — the GPU texture forge proper: procedural noise render targets,
// Sobel height→normal, and the triplanar + curvature-driven edge-wear /
// grime shader chunk that turns a plain `THREE.MeshStandardMaterial` into
// one of `docs/spec/02-api-contracts.md` §2's five surfaces. `src/materials/`
// is the one M5 directory allowed to import `three` (D-72) — this file is
// where that licence is actually spent.
//
// ---------------------------------------------------------------------------
// A spec tension this file resolves, and how (report this, per the ticket
// brief — do not silently pick a side without saying so)
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §1's "Forbidden for callers" list, under `render`,
// reads: "Never call renderer.render(), setRenderTarget(), clear(),
// setViewport() or mutate renderer.state outside render's own frame." Read
// literally and unconditionally, that forbids ANY other subsystem from ever
// rasterizing anything — which is irreconcilable with §2's own docblock for
// `materials` ("Every texture in the game is generated here on the GPU at
// load time... Nothing is fetched") and its "Owns exclusively... the
// texture-forge render targets" line. RNDR-1 ships no general-purpose "draw
// this into a target you don't own" entry point — only `withPrewarmTarget`
// (a 1x1 scratch target, compile-only, single caller `core/prewarm.js`) and
// `render(ctx)` itself (the main per-frame composite).
//
// Resolution taken here: `forge.js` calls `renderer.setRenderTarget()` /
// `renderer.render()` directly, on the shared renderer obtained via
// `ctx.get('render').renderer`, but ONLY at load time (`texture()`/`get()`'s
// first call, `makeSurface()`, `prewarmMaterials()`) — never from
// `update()`/`fixedUpdate()`, and it always restores whatever target was
// bound beforehand in a `finally`, mirroring exactly the discipline
// `RenderSystem.prewarmMaterials`/`withPrewarmTarget` use on themselves.
// Reading "outside render's own frame" as "outside render(ctx)'s per-frame
// call, i.e. not interleaved with an in-flight composite" — not as "no
// other subsystem may ever bind a target" — is the only reading under which
// §2's own docblock is implementable at all. Flagged for the orchestrator;
// not silently invented — see the MATL-1 report.
//
// ---------------------------------------------------------------------------
// Degraded path (Node / no GPU)
// ---------------------------------------------------------------------------
// Mirrors `src/render/index.js`'s own pattern exactly: every function here
// takes `renderer` as an explicit argument (never reaches for a module-level
// singleton) and, when it is `null` (headless Node, or a stub test canvas —
// see that file's header), returns a small deterministic placeholder
// `THREE.DataTexture` instead of attempting to rasterize anything. Building
// `THREE.Material`/`THREE.Texture`/`THREE.ShaderMaterial` instances never
// touches the GPU by itself — only `renderer.render()`/`compile()` do — so
// every object this file returns is real and usable (has the right
// properties, participates in `keys`/ref-counting/`dispose()`) even under
// Node; only its *pixel content* is a placeholder there.
//
// ---------------------------------------------------------------------------
// Program-count discipline (criterion 4)
// ---------------------------------------------------------------------------
// `onBeforeCompile` is assigned as ONE shared, module-level function
// reference (`surfaceOnBeforeCompile`, bottom of this file) on every surface
// material, never a fresh per-material closure. Three's own
// `Material.customProgramCacheKey()` defaults to
// `this.onBeforeCompile.toString()` — a fresh arrow function built inside a
// loop would still `toString()` identically call-to-call (same source text),
// but using one shared reference makes that invariant obvious by
// construction rather than by accident. All five surfaces share the same
// injected GLSL *structure*; only per-instance uniform values (textures,
// colours) differ, and a uniform's value never forces a new compiled
// program. This is what keeps `prewarmMaterials` cheap and keeps
// `render.stats.programs` flat afterward — see the MATL-1 report for the
// measured count.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared full-screen quad (mirrors src/render/composite.js's own pattern —
// a unit NDC quad + orthographic camera, built once and reused for every
// forge pass, never per-call).
// ---------------------------------------------------------------------------

let _quadGeometry = null;
let _quadCamera = null;

function getForgeQuad() {
  if (!_quadGeometry) {
    _quadGeometry = new THREE.BufferGeometry();
    _quadGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    _quadGeometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  }
  if (!_quadCamera) {
    _quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  return { geometry: _quadGeometry, camera: _quadCamera };
}

/**
 * Rasterizes `material` (a full-screen shader) into a fresh
 * `size x size` `THREE.WebGLRenderTarget` and returns its `.texture`. `null`
 * `renderer` (degraded/no-GPU) returns a small deterministic placeholder
 * instead — see this file's header. The caller disposes the mesh/target
 * lifecycle is scoped entirely to this call; only the returned texture (and
 * the target it lives on, kept alive via `texture.__forgeTarget` for
 * disposal bookkeeping) survives.
 * @param {THREE.WebGLRenderer|null} renderer
 * @param {THREE.ShaderMaterial} material
 * @param {number} size
 * @param {number} seed - used only for the degraded placeholder's hash.
 * @returns {THREE.Texture}
 */
export function rasterizeToTexture(renderer, material, size, seed) {
  if (!renderer) return buildPlaceholderTexture(seed);

  const target = new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  const { geometry, camera } = getForgeQuad();
  const mesh = new THREE.Mesh(geometry, material);

  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  try {
    renderer.render(mesh, camera);
  } finally {
    renderer.setRenderTarget(previous);
  }

  const texture = target.texture;
  texture.__forgeTarget = target;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A tiny (4x4), deterministic, seed-hashed flat-ish texture standing in for
 * real GPU output under Node — real shape (`THREE.DataTexture`, correct
 * wrap/format), fake pixels. `hasGpu()` on the returned texture's
 * `userData.placeholder` flag is how tests/callers can tell the two apart. */
function buildPlaceholderTexture(seed = 0) {
  const n = 4;
  const data = new Uint8Array(n * n * 4);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n * n; i++) {
    // xorshift32 — a tiny local hash, deliberately NOT ctx.rng (this must
    // work with no ctx at all, and it never feeds gameplay — rule 3's
    // "no Math.random()" is honoured; this is neither Math.random() nor a
    // gameplay draw, purely a placeholder-pixel hash).
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    const v = s & 0xff;
    data[i * 4] = v;
    data[i * 4 + 1] = (s >>> 8) & 0xff;
    data[i * 4 + 2] = (s >>> 16) & 0xff;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  tex.userData.placeholder = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Noise GLSL — a small shared hash/noise library, spliced into one of four
// per-kind fragment shaders. `uSeed` decorrelates textures at the same size
// requested with different seeds; determinism comes from `seed`, per rule 3
// ("makeSurface(surface, seed, opts) takes an explicit seed — deterministic
// forging keys off that, not off ctx.rng").
// ---------------------------------------------------------------------------

const NOISE_COMMON_GLSL = `
varying vec2 vUv;
uniform float uSeed;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + uSeed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  float n = hash21(p);
  float n2 = hash21(p + vec2(17.0, 31.0));
  return vec2(n, n2);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float gradientNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return 0.5 + mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Worley/cellular noise: nearest feature-point distance over the 3x3
// neighbourhood of cells around p.
float worleyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float minDist = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash22(i + neighbor);
      vec2 diff = neighbor + point - f;
      minDist = min(minDist, length(diff));
    }
  }
  return clamp(minDist, 0.0, 1.0);
}

// Interleaved gradient noise (Jimenez) — a cheap, deterministic
// blue-noise APPROXIMATION (not true void-and-cluster blue noise, which
// needs an offline solve; documented as an approximation in the MATL-1
// report). Good enough spectral spread for dithering a tiling seam.
float blueNoiseApprox(vec2 p) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(p + uSeed, magic.xy)));
}
`;

const NOISE_KIND_MAIN = {
  value: 'float n = valueNoise(vUv * 8.0); gl_FragColor = vec4(vec3(n), 1.0);',
  gradient: 'float n = gradientNoise(vUv * 6.0) * 0.5 + gradientNoise(vUv * 12.0) * 0.3 + gradientNoise(vUv * 24.0) * 0.2; gl_FragColor = vec4(vec3(clamp(n, 0.0, 1.0)), 1.0);',
  worley: 'float n = 1.0 - worleyNoise(vUv * 8.0); gl_FragColor = vec4(vec3(n), 1.0);',
  blue: 'float n = blueNoiseApprox(gl_FragCoord.xy); gl_FragColor = vec4(vec3(n), 1.0);',
};

export const NOISE_KINDS = Object.freeze(['value', 'gradient', 'worley', 'blue']);

const QUAD_VERTEX_GLSL = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

/**
 * Builds the `ShaderMaterial` for one noise kind. Exported (not just used
 * internally) so tests can inspect the GLSL text directly, headlessly — no
 * renderer required to construct or read a `ShaderMaterial`'s source.
 * @param {'value'|'gradient'|'worley'|'blue'} kind
 * @param {number} seed
 * @returns {THREE.ShaderMaterial}
 */
export function buildNoiseMaterial(kind, seed) {
  const main = NOISE_KIND_MAIN[kind];
  if (!main) throw new Error(`materials.noiseTexture: unknown kind '${kind}' (expected one of ${NOISE_KINDS.join(', ')})`);
  return new THREE.ShaderMaterial({
    uniforms: { uSeed: { value: (seed >>> 0) % 1000 } },
    vertexShader: QUAD_VERTEX_GLSL,
    fragmentShader: `${NOISE_COMMON_GLSL}\nvoid main() {\n  ${main}\n}\n`,
    depthTest: false,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Sobel height -> normal
// ---------------------------------------------------------------------------

const HEIGHT_TO_NORMAL_FRAGMENT_GLSL = `
varying vec2 vUv;
uniform sampler2D uHeightMap;
uniform vec2 uTexel;
uniform float uStrength;

float h(vec2 uv) { return texture2D(uHeightMap, uv).r; }

void main() {
  // 3x3 Sobel kernel over the height map — the standard GPU height->normal
  // technique (docs/ARCHITECTURE.md/§2's "Sobel height->normal").
  float tl = h(vUv + uTexel * vec2(-1.0,  1.0));
  float t  = h(vUv + uTexel * vec2( 0.0,  1.0));
  float tr = h(vUv + uTexel * vec2( 1.0,  1.0));
  float l  = h(vUv + uTexel * vec2(-1.0,  0.0));
  float r  = h(vUv + uTexel * vec2( 1.0,  0.0));
  float bl = h(vUv + uTexel * vec2(-1.0, -1.0));
  float b  = h(vUv + uTexel * vec2( 0.0, -1.0));
  float br = h(vUv + uTexel * vec2( 1.0, -1.0));

  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);

  vec3 n = normalize(vec3(-gx * uStrength, -gy * uStrength, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

/**
 * Builds the Sobel height->normal `ShaderMaterial`. Exported for the same
 * headless-inspectability reason as `buildNoiseMaterial`.
 * @param {THREE.Texture} heightTex
 * @param {number} strength
 * @param {number} size
 * @returns {THREE.ShaderMaterial}
 */
export function buildHeightToNormalMaterial(heightTex, strength, size) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightMap: { value: heightTex },
      uTexel: { value: new THREE.Vector2(1 / Math.max(1, size), 1 / Math.max(1, size)) },
      uStrength: { value: strength },
    },
    vertexShader: QUAD_VERTEX_GLSL,
    fragmentShader: HEIGHT_TO_NORMAL_FRAGMENT_GLSL,
    depthTest: false,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Triplanar + curvature edge-wear + grime — injected via onBeforeCompile
// ---------------------------------------------------------------------------

/** GLSL appended right after `#include <begin_vertex>` (world position) and
 * `#include <beginnormal_vertex>` (world normal) — both chunks exist
 * unconditionally in `THREE.ShaderLib.standard`'s vertex shader, so this
 * never depends on which defines happen to be active. */
const TRIPLANAR_VERTEX_AFTER_BEGIN_VERTEX = `
  vTriWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const TRIPLANAR_VERTEX_AFTER_BEGINNORMAL_VERTEX = `
  vTriWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
`;
const TRIPLANAR_VERTEX_VARYINGS = `
varying vec3 vTriWorldPos;
varying vec3 vTriWorldNormal;
`;

/**
 * Builds the fragment-shader chunk that replaces `#include <map_fragment>`
 * (triplanar albedo + edge-wear + grime), `#include <roughnessmap_fragment>`
 * (triplanar roughness, edge/grime-modulated) and
 * `#include <normal_fragment_maps>` (triplanar Sobel normal, whiteout-blended
 * per axis) — every uniform this declares is read inside a real `mix`/
 * `texture2D` expression below, never left as a named-but-unused decoration
 * (criterion 2). Exported as a pure string-builder so tests can assert that
 * without a GPU: `tests/materials/forge.test.js` runs this against
 * `THREE.ShaderLib.standard`'s own (real, unresolved) chunk source and greps
 * the result.
 * @returns {{uniformsGlsl:string, mapFragment:string, roughnessFragment:string, normalFragment:string}}
 */
export function buildTriplanarChunks() {
  const uniformsGlsl = `
${TRIPLANAR_VERTEX_VARYINGS}
uniform sampler2D uDetailMap;
uniform sampler2D uMacroMap;
uniform sampler2D uNormalDetailMap;
uniform vec3 uBaseColor;
uniform vec3 uEdgeWearColor;
uniform vec3 uGrimeColor;
uniform float uRoughnessMin;
uniform float uRoughnessMax;
uniform float uDetailScale;   // 1 / detailTileMeters
uniform float uMacroScale;    // 1 / macroTileMeters
uniform float uNormalStrength;

vec3 triWeights(vec3 n) {
  vec3 w = abs(n);
  w = pow(w, vec3(4.0));
  return w / max(dot(w, vec3(1.0)), 1e-5);
}

vec4 triSample(sampler2D tex, vec3 worldPos, vec3 weights, float scale) {
  vec4 xTex = texture2D(tex, worldPos.zy * scale);
  vec4 yTex = texture2D(tex, worldPos.xz * scale);
  vec4 zTex = texture2D(tex, worldPos.xy * scale);
  return xTex * weights.x + yTex * weights.y + zTex * weights.z;
}
`;

  // Replaces `#include <map_fragment>`. Computes a curvature proxy from the
  // screen-space derivative of the world normal (fwidth) — cheap, real
  // GPU curvature approximation for "edge wear": a flat face has near-zero
  // fwidth(normal), a crease/corner has a spike. Grime is the inverse:
  // where curvature is low AND the macro noise says "crevice" (macro
  // texture's own blue channel, reused as a cheap crevice mask rather than
  // forging a sixth texture just for this).
  //
  // `diffuseColor.rgb` on entry already holds `diffuse` (three's own
  // `material.color` uniform, linear) from the preceding `#include
  // <color_fragment>` — `MaterialsSystem#makeSurface` sets that to white by
  // convention and puts the real surface tone in `uBaseColor` instead, so
  // `diffuseColor.rgb *= albedo` below leaves `material.color` free to act
  // as a pure tint multiplier for `MaterialsSystem#variant()`, exactly the
  // way it already does for every plain (non-triplanar) material.
  const mapFragment = `
  vec3 triW = triWeights(vTriWorldNormal);
  vec4 detailSample = triSample(uDetailMap, vTriWorldPos, triW, uDetailScale);
  vec4 macroSample = triSample(uMacroMap, vTriWorldPos, triW, uMacroScale);

  float curvature = length(fwidth(normalize(vTriWorldNormal))) * 8.0;
  float edgeFactor = clamp(curvature, 0.0, 1.0);
  float crevice = clamp((1.0 - curvature) * (1.0 - macroSample.b) * 1.5 - 0.3, 0.0, 1.0);

  vec3 albedo = uBaseColor * (0.72 + 0.28 * detailSample.r) * (0.9 + 0.2 * macroSample.g);
  albedo = mix(albedo, uEdgeWearColor, edgeFactor * 0.6);
  albedo = mix(albedo, uGrimeColor, crevice * 0.55);

  diffuseColor.rgb *= albedo;
`;

  // Replaces `#include <roughnessmap_fragment>`. Edge wear polishes
  // (lower roughness), grime roughens (higher roughness). Centered on the
  // material's OWN `roughness` uniform (three's built-in one, in scope at
  // this include point) rather than replacing it outright — that is what
  // makes `MaterialsSystem#variant()`'s `roughDelta` (which adjusts
  // `material.roughness` on the clone) actually reach a triplanar surface's
  // rendered roughness instead of being silently ignored.
  const roughnessFragment = `
  vec3 triWR = triWeights(vTriWorldNormal);
  vec4 roughDetail = triSample(uDetailMap, vTriWorldPos, triWR, uDetailScale);
  float curvatureR = clamp(length(fwidth(normalize(vTriWorldNormal))) * 8.0, 0.0, 1.0);
  vec4 roughMacro = triSample(uMacroMap, vTriWorldPos, triWR, uMacroScale);
  float creviceR = clamp((1.0 - curvatureR) * (1.0 - roughMacro.b) * 1.5 - 0.3, 0.0, 1.0);
  float roughRange = max(0.0, uRoughnessMax - uRoughnessMin);
  float roughnessFactor = clamp(roughness + (roughDetail.r - 0.5) * roughRange, 0.0, 1.0);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.55, curvatureR * 0.6);
  roughnessFactor = mix(roughnessFactor, min(1.0, roughnessFactor * 1.35), creviceR * 0.55);
`;

  // Replaces `#include <normal_fragment_maps>`. Whiteout-style triplanar
  // normal blend: each axis samples uNormalDetailMap in its own plane and
  // perturbs the geometric normal along that plane's two tangent axes.
  const normalFragment = `
  vec3 triWN = triWeights(vTriWorldNormal);
  vec3 nx = texture2D(uNormalDetailMap, vTriWorldPos.zy * uDetailScale).rgb * 2.0 - 1.0;
  vec3 ny = texture2D(uNormalDetailMap, vTriWorldPos.xz * uDetailScale).rgb * 2.0 - 1.0;
  vec3 nz = texture2D(uNormalDetailMap, vTriWorldPos.xy * uDetailScale).rgb * 2.0 - 1.0;

  vec3 geomN = normalize(vTriWorldNormal);
  vec3 perturbed =
    (geomN + nx.x * vec3(0.0, 0.0, 1.0) * sign(vTriWorldNormal.x + 1e-5) + nx.y * vec3(0.0, 1.0, 0.0)) * triWN.x +
    (geomN + ny.x * vec3(1.0, 0.0, 0.0) + ny.y * vec3(0.0, 0.0, 1.0) * sign(vTriWorldNormal.y + 1e-5)) * triWN.y +
    (geomN + nz.x * vec3(1.0, 0.0, 0.0) + nz.y * vec3(0.0, 1.0, 0.0) * sign(vTriWorldNormal.z + 1e-5)) * triWN.z;
  normal = normalize(mix(geomN, normalize(perturbed), uNormalStrength));
`;

  return { uniformsGlsl, mapFragment, roughnessFragment, normalFragment };
}

/**
 * The ONE shared `onBeforeCompile` function reference assigned to every
 * surface material (see this file's header, "Program-count discipline").
 * Reads its configuration off `this.userData.triplanar` (set by
 * `buildSurfaceMaterial` before assignment) — `this` is the calling
 * material, per three's `material.onBeforeCompile(shader, renderer)` call
 * convention.
 * @this {THREE.MeshStandardMaterial}
 * @param {{uniforms:object, vertexShader:string, fragmentShader:string}} shader
 */
function surfaceOnBeforeCompile(shader) {
  const cfg = this.userData.triplanar;
  if (!cfg) return; // not a triplanar surface material — no-op

  const chunks = buildTriplanarChunks();

  Object.assign(shader.uniforms, {
    uDetailMap: { value: cfg.detailTexture },
    uMacroMap: { value: cfg.macroTexture },
    uNormalDetailMap: { value: cfg.normalTexture },
    uBaseColor: { value: cfg.baseColor },
    uEdgeWearColor: { value: cfg.edgeWearColor },
    uGrimeColor: { value: cfg.grimeColor },
    uRoughnessMin: { value: cfg.roughnessMin },
    uRoughnessMax: { value: cfg.roughnessMax },
    uDetailScale: { value: 1 / cfg.detailTileMeters },
    uMacroScale: { value: 1 / cfg.macroTileMeters },
    uNormalStrength: { value: cfg.normalStrength },
  });

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${chunks.uniformsGlsl}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${TRIPLANAR_VERTEX_AFTER_BEGIN_VERTEX}`)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${TRIPLANAR_VERTEX_AFTER_BEGINNORMAL_VERTEX}`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${chunks.uniformsGlsl}`)
    .replace('#include <map_fragment>', chunks.mapFragment)
    .replace('#include <roughnessmap_fragment>', chunks.roughnessFragment)
    .replace('#include <normal_fragment_maps>', chunks.normalFragment);

  // Kept for tests/debugging: the fully-injected source, readable without a
  // GPU (this hook only ever runs for real inside a browser compile, but a
  // test can call it directly with `.call(fakeMaterial, fakeShader)`).
  this.userData.__compiledVertexShader = shader.vertexShader;
  this.userData.__compiledFragmentShader = shader.fragmentShader;
}

export { surfaceOnBeforeCompile };
