// src/render/composite.js
//
// RNDR-1 — the final HDR -> canvas composite step.
//
// Scope: one full-screen triangle, sampling the HDR render target's texture,
// drawn with `renderer.render(mesh, camera)` while the canvas (render target
// `null`) is bound. That last detail is load-bearing, not incidental — see
// the header comment in `src/render/index.js` for why the *only* thing that
// turns AgX tonemapping + sRGB output on is which render target happens to
// be bound at draw time, not any flag this module sets.
//
// Built once in `RenderSystem.init()` and reused every frame — zero
// allocation on the hot path (ARCHITECTURE.md rule 6). `resize()` never
// touches this module; only the `map` texture reference is swapped when
// `RenderSystem` rebuilds its HDR target.

import * as THREE from 'three';

/**
 * A single oversized triangle covering the full NDC square, the same
 * technique `three/examples/jsm/postprocessing/Pass.js`'s `FullScreenQuad`
 * uses: one triangle instead of two avoids a diagonal seam and is one
 * vertex cheaper. Reimplemented by hand here rather than importing the
 * addon — this ticket owns no post-processing chain yet (that's RNDR-5/6/7)
 * and pulling in `three/addons/postprocessing/*` now would couple this
 * bare-bones composite to machinery those tickets may not even want to keep.
 * @returns {THREE.BufferGeometry}
 */
function buildFullscreenTriangle() {
  const geometry = new THREE.BufferGeometry();
  // Positions run past [-1, 1] on purpose (the third vertex sits at x=3,
  // y=-1) — the rasterizer clips the overhang at the viewport edge, and the
  // visible portion still interpolates UV 0..1 across the screen exactly
  // like a two-triangle quad would.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return geometry;
}

/**
 * Builds the composite draw: an orthographic camera framing exactly the NDC
 * square, a full-screen triangle, and an unlit material sampling `hdrTexture`.
 *
 * `material.toneMapped` is left at its default (`true`, every `Material`'s
 * default) deliberately — see `src/render/index.js` for why that default is
 * exactly what makes this material pick up `renderer.toneMapping` (AgX) and
 * `renderer.outputColorSpace` (sRGB) only when drawn with no render target
 * bound, and nothing else needs to change here for that to happen.
 *
 * @param {THREE.Texture} hdrTexture - the HDR render target's colour texture.
 *   `RenderSystem.resize()` swaps this reference in place on `material.map`.
 * @returns {{
 *   mesh: THREE.Mesh,
 *   camera: THREE.OrthographicCamera,
 *   geometry: THREE.BufferGeometry,
 *   material: THREE.MeshBasicMaterial,
 *   dispose: () => void,
 * }}
 */
export function createComposite(hdrTexture) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geometry = buildFullscreenTriangle();
  const material = new THREE.MeshBasicMaterial({
    map: hdrTexture,
    toneMapped: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // the ortho camera's volume is exactly the NDC
  // square this triangle already covers; culling it is never correct.
  mesh.matrixAutoUpdate = false; // it never moves — one static identity matrix

  return {
    mesh,
    camera,
    geometry,
    material,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
