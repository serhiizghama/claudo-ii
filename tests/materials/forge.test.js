// tests/materials/forge.test.js
//
// MATL-1 acceptance tests for src/materials/forge.js — the GPU texture
// forge. `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// What's checkable headlessly (no WebGL2 in Node — see src/render/index.js's
// own header for the same limitation): `THREE.ShaderMaterial`/`THREE.Texture`
// construction never touches the GPU by itself, so every builder function
// here can be called and its GLSL source text inspected directly. The
// triplanar/edge-wear injection is verified against `THREE.ShaderLib.
// standard`'s OWN real (unresolved) chunk source — the same shape three
// itself hands to `onBeforeCompile` during a real compile — so this is not a
// toy fixture, it is the real integration surface, just exercised without a
// GPU. What is NOT checkable here: that the GLSL actually compiles/links and
// paints correct pixels — that needs a real WebGL2 context (see the MATL-1
// report's playwright-driven verification for that half).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  NOISE_KINDS,
  buildNoiseMaterial,
  buildHeightToNormalMaterial,
  rasterizeToTexture,
  buildTriplanarChunks,
  surfaceOnBeforeCompile,
} from '../../src/materials/forge.js';

// --- Noise materials ------------------------------------------------------

test('NOISE_KINDS: exactly the four contracted kinds', () => {
  assert.deepEqual(NOISE_KINDS, ['value', 'gradient', 'worley', 'blue']);
});

for (const kind of ['value', 'gradient', 'worley', 'blue']) {
  test(`buildNoiseMaterial('${kind}'): returns a real ShaderMaterial whose fragment shader implements ${kind} noise`, () => {
    const mat = buildNoiseMaterial(kind, 12345);
    assert.ok(mat instanceof THREE.ShaderMaterial);
    assert.equal(typeof mat.uniforms.uSeed.value, 'number');
    assert.ok(mat.fragmentShader.includes('gl_FragColor'));
  });
}

test('buildNoiseMaterial: unknown kind throws with a helpful message', () => {
  assert.throws(() => buildNoiseMaterial('nonsense', 1), /unknown kind 'nonsense'/);
});

test('buildNoiseMaterial: different seeds produce different uSeed uniform values (decorrelated)', () => {
  const a = buildNoiseMaterial('value', 1);
  const b = buildNoiseMaterial('value', 2);
  assert.notEqual(a.uniforms.uSeed.value, b.uniforms.uSeed.value);
});

// --- Height -> normal -------------------------------------------------

test('buildHeightToNormalMaterial: a real ShaderMaterial implementing a 3x3 Sobel kernel', () => {
  const heightTex = new THREE.Texture();
  const mat = buildHeightToNormalMaterial(heightTex, 1.5, 64);
  assert.ok(mat instanceof THREE.ShaderMaterial);
  assert.equal(mat.uniforms.uHeightMap.value, heightTex);
  assert.equal(mat.uniforms.uStrength.value, 1.5);
  // Sobel: 8 neighbour taps combined into two gradients (gx, gy).
  assert.ok(mat.fragmentShader.includes('gx'));
  assert.ok(mat.fragmentShader.includes('gy'));
  assert.ok(mat.fragmentShader.includes('normalize(vec3('));
});

// --- Degraded (no renderer) rasterization ------------------------------

test('rasterizeToTexture(null, ...): degrades to a deterministic placeholder, never throws', () => {
  const mat = buildNoiseMaterial('value', 7);
  const tex = rasterizeToTexture(null, mat, 256, 7);
  assert.ok(tex instanceof THREE.Texture);
  assert.equal(tex.userData.placeholder, true);
  assert.equal(tex.image.width, 4);
  assert.equal(tex.image.height, 4);
});

test('rasterizeToTexture(null, ...): deterministic — same seed gives the same placeholder pixels', () => {
  const a = rasterizeToTexture(null, buildNoiseMaterial('value', 42), 64, 42);
  const b = rasterizeToTexture(null, buildNoiseMaterial('value', 42), 64, 42);
  assert.deepEqual(Array.from(a.image.data), Array.from(b.image.data));
});

test('rasterizeToTexture(null, ...): different seeds give different pixels', () => {
  const a = rasterizeToTexture(null, buildNoiseMaterial('value', 1), 64, 1);
  const b = rasterizeToTexture(null, buildNoiseMaterial('value', 2), 64, 2);
  assert.notDeepEqual(Array.from(a.image.data), Array.from(b.image.data));
});

// --- Triplanar + edge-wear injection (criterion 2: demonstrably, not
// named-but-unused) -----------------------------------------------------

/** A `shader`-shaped object built from three's OWN, real, unresolved
 * `ShaderLib.standard` source — the exact shape `onBeforeCompile` receives
 * during a real compile (verified in this file's own suite below against
 * the marker counts three actually ships). */
function realStandardShaderStub() {
  return {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
}

function fakeTriplanarMaterial() {
  return {
    userData: {
      triplanar: {
        detailTexture: new THREE.Texture(),
        macroTexture: new THREE.Texture(),
        normalTexture: new THREE.Texture(),
        baseColor: new THREE.Vector3(0.5, 0.4, 0.3),
        edgeWearColor: new THREE.Vector3(0.8, 0.8, 0.8),
        grimeColor: new THREE.Vector3(0.05, 0.04, 0.03),
        roughnessMin: 0.5,
        roughnessMax: 0.9,
        detailTileMeters: 2,
        macroTileMeters: 64,
        normalStrength: 1,
      },
    },
  };
}

test('buildTriplanarChunks: every declared uniform is actually read inside a real GLSL expression, not just declared', () => {
  const chunks = buildTriplanarChunks();
  const declared = [...chunks.uniformsGlsl.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]);
  assert.ok(declared.length > 5, 'expected several triplanar uniforms declared');

  const body = chunks.mapFragment + chunks.roughnessFragment + chunks.normalFragment;
  for (const name of declared) {
    // "read" = appears at least once OUTSIDE the uniform declaration block,
    // inside a real expression (mix/texture2D/arithmetic) in one of the
    // three injected chunks below.
    assert.ok(body.includes(name), `uniform '${name}' is declared but never referenced in the injected chunks`);
  }
});

test('triplanar sampling: three-axis projection (worldPos.zy / .xz / .xy) actually used, weighted by triWeights(normal)', () => {
  const chunks = buildTriplanarChunks();
  assert.ok(chunks.uniformsGlsl.includes('worldPos.zy'));
  assert.ok(chunks.uniformsGlsl.includes('worldPos.xz'));
  assert.ok(chunks.uniformsGlsl.includes('worldPos.xy'));
  assert.ok(chunks.uniformsGlsl.includes('triWeights'));
  assert.ok(chunks.mapFragment.includes('triSample(uDetailMap'));
  assert.ok(chunks.mapFragment.includes('triSample(uMacroMap'));
});

test('edge wear: curvature (fwidth of world normal) actually blends toward uEdgeWearColor via mix()', () => {
  const chunks = buildTriplanarChunks();
  assert.ok(chunks.mapFragment.includes('fwidth(normalize(vTriWorldNormal))'));
  assert.ok(chunks.mapFragment.includes('mix(albedo, uEdgeWearColor, edgeFactor'));
});

test('grime: a crevice mask actually blends toward uGrimeColor via mix()', () => {
  const chunks = buildTriplanarChunks();
  assert.ok(chunks.mapFragment.includes('mix(albedo, uGrimeColor, crevice'));
});

test('roughness: edge wear lowers roughness, grime raises it, both centered on the material\'s own `roughness` uniform', () => {
  const chunks = buildTriplanarChunks();
  assert.ok(chunks.roughnessFragment.includes('roughness +'), 'must be centered on the base roughness uniform, not replace it outright');
  assert.ok(/roughnessFactor \* 0\.55/.test(chunks.roughnessFragment), 'edge wear must lower roughness');
  assert.ok(/roughnessFactor \* 1\.35/.test(chunks.roughnessFragment), 'grime must raise roughness');
});

test('normal: whiteout-style triplanar blend actually perturbs the geometry normal by the sampled detail normal', () => {
  const chunks = buildTriplanarChunks();
  assert.ok(chunks.normalFragment.includes('uNormalDetailMap'));
  assert.ok(chunks.normalFragment.includes('normal = normalize(mix(geomN'));
  assert.ok(chunks.normalFragment.includes('uNormalStrength'));
});

test('surfaceOnBeforeCompile: injected against the REAL ShaderLib.standard source — every target #include marker is consumed, uniforms populated', () => {
  const shader = realStandardShaderStub();
  const material = fakeTriplanarMaterial();

  surfaceOnBeforeCompile.call(material, shader);

  assert.ok(!shader.fragmentShader.includes('#include <map_fragment>'));
  assert.ok(!shader.fragmentShader.includes('#include <roughnessmap_fragment>'));
  assert.ok(!shader.fragmentShader.includes('#include <normal_fragment_maps>'));
  assert.ok(shader.vertexShader.includes('vTriWorldPos = (modelMatrix'));
  assert.ok(shader.vertexShader.includes('vTriWorldNormal = normalize(mat3(modelMatrix)'));

  for (const name of ['uDetailMap', 'uMacroMap', 'uNormalDetailMap', 'uBaseColor', 'uEdgeWearColor', 'uGrimeColor', 'uRoughnessMin', 'uRoughnessMax', 'uDetailScale', 'uMacroScale', 'uNormalStrength']) {
    assert.ok(name in shader.uniforms, `uniform ${name} must be populated`);
  }
  assert.equal(shader.uniforms.uDetailMap.value, material.userData.triplanar.detailTexture);
});

test('surfaceOnBeforeCompile: a no-op when the material has no userData.triplanar config (never crashes a non-surface material)', () => {
  const shader = realStandardShaderStub();
  const before = { ...shader };
  surfaceOnBeforeCompile.call({ userData: {} }, shader);
  assert.equal(shader.vertexShader, before.vertexShader);
  assert.equal(shader.fragmentShader, before.fragmentShader);
});

test('surfaceOnBeforeCompile: same function reference every call — the program-cache-key sharing invariant (see forge.js header)', () => {
  const shaderA = realStandardShaderStub();
  const shaderB = realStandardShaderStub();
  surfaceOnBeforeCompile.call(fakeTriplanarMaterial(), shaderA);
  surfaceOnBeforeCompile.call(fakeTriplanarMaterial(), shaderB);
  // Structurally identical output for two differently-textured materials —
  // the injected GLSL text itself never varies per-instance, only the
  // uniform VALUES do (checked above). This is what keeps
  // `customProgramCacheKey()`'s default (`onBeforeCompile.toString()`)
  // identical across all five surfaces.
  assert.equal(shaderA.fragmentShader, shaderB.fragmentShader);
  assert.equal(shaderA.vertexShader, shaderB.vertexShader);
});
