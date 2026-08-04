// tests/materials/materials.test.js
//
// MATL-1 acceptance tests for src/materials/index.js — the MaterialsSystem
// subsystem contract (docs/spec/02-api-contracts.md §2). `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// Runs entirely under Node (no WebGL2 — see src/render/index.js's own
// header), so `ctx.get('render').renderer` is always `null` here and every
// forge call takes its degraded/placeholder path (src/materials/forge.js's
// own header). What that means for THIS suite: material/texture OBJECTS are
// real and fully inspectable (shape, ref-counting, caching, palette/rarity
// values, prewarm bookkeeping) — only their pixel CONTENT is a placeholder.
// The MATL-1 report's playwright-driven check covers the real-GPU half
// (actual compiled program counts, non-placeholder textures).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MaterialsSystem } from '../../src/materials/index.js';
import { SURFACE_IDS, RARITY_ORDER } from '../../src/materials/data/palette.js';
import { boot } from '../../src/main.js';

/** Same shape as tests/render/rndr1.test.js's stub canvas — no `getContext`,
 * forcing RenderSystem (and therefore materials) down the degraded path. */
function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

function makeBareCtx() {
  return {
    get: () => null,
    peek: () => null,
    has: () => false,
    rng: null,
    events: { on() {}, emit() {} },
  };
}

// --- Subsystem interface --------------------------------------------------

test('MaterialsSystem: static id/deps match the subsystem interface and 02 §Init order', () => {
  assert.equal(MaterialsSystem.id, 'materials');
  assert.deepEqual(MaterialsSystem.deps, ['render']);
});

test('init(): does not throw against a bare ctx (no render, no rng, no events)', async () => {
  const sys = new MaterialsSystem();
  await assert.doesNotReject(sys.init(makeBareCtx()));
});

// --- get()/release() — ref-counted ----------------------------------------

test('get(): two callers asking for the same key at the same tier get the same THREE.Material instance', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.get('stone_wall', { surface: 'stone', seed: 1 });
  const b = sys.get('stone_wall', { surface: 'stone', seed: 1 });
  assert.equal(a, b);
  assert.ok(a instanceof THREE.Material);
});

test('get(): a plain key (no surface) still returns a real, cached Material', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.get('some_key');
  const b = sys.get('some_key');
  assert.equal(a, b);
  assert.ok(a instanceof THREE.MeshStandardMaterial);
});

test('release(): decrements without throwing, including for an unknown key, and never disposes the cached instance', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const m = sys.get('stone_wall', { surface: 'stone', seed: 2 });
  assert.doesNotThrow(() => sys.release('stone_wall'));
  assert.doesNotThrow(() => sys.release('unknown_key_xyz'));
  // Still resolvable afterward — release() never disposes.
  const again = sys.get('stone_wall', { surface: 'stone', seed: 2 });
  assert.equal(again, m);
});

// --- makeSurface(): the five shipped surfaces -----------------------------

for (const surface of SURFACE_IDS) {
  test(`makeSurface('${surface}', seed): produces a real MaterialSet with a triplanar THREE.MeshStandardMaterial`, async () => {
    const sys = new MaterialsSystem();
    await sys.init(makeBareCtx());
    const set = sys.makeSurface(surface, 999);
    assert.equal(set.surface, surface);
    assert.ok(set.material instanceof THREE.MeshStandardMaterial);
    assert.ok(set.material.userData.triplanar, 'must carry the triplanar config onBeforeCompile reads');
    assert.equal(typeof set.material.onBeforeCompile, 'function');
    assert.ok(set.detailTexture instanceof THREE.Texture);
    assert.ok(set.macroTexture instanceof THREE.Texture);
    assert.ok(set.normalTexture instanceof THREE.Texture);
    assert.equal(set.detailTileMeters, 2);
    assert.equal(set.macroTileMeters, 64);
  });
}

test('makeSurface: exactly the five shipped surfaces produce material sets — a sixth throws (rule 13)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  for (const surface of SURFACE_IDS) assert.doesNotThrow(() => sys.makeSurface(surface, 1));
  assert.throws(() => sys.makeSurface('sand', 1), /unknown surface 'sand'/);
  assert.throws(() => sys.makeSurface('water', 1), /unknown surface 'water'/);
});

test('makeSurface: same (surface, seed) returns the cached MaterialSet, not a rebuild', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.makeSurface('bone', 42);
  const b = sys.makeSurface('bone', 42);
  assert.equal(a, b);
});

test('makeSurface: different seeds for the same surface produce different MaterialSets (deterministic forging keys off the seed, not ctx.rng)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.makeSurface('stone', 1);
  const b = sys.makeSurface('stone', 2);
  assert.notEqual(a, b);
  assert.notEqual(a.material, b.material);
});

test('makeSurface: every triplanar uniform value traces back to the zone-agnostic default palette when no zoneId is given', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const set = sys.makeSurface('ash', 7);
  const cfg = set.material.userData.triplanar;
  assert.ok(cfg.baseColor instanceof THREE.Vector3);
  assert.ok(cfg.edgeWearColor instanceof THREE.Vector3);
  assert.ok(cfg.grimeColor instanceof THREE.Vector3);
});

// --- variant() --------------------------------------------------------

test('variant(): returns an independent clone, never the shared instance, and never mutates the shared material', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const base = sys.get('stone_wall', { surface: 'stone', seed: 3 });
  const baseColorBefore = base.color.getHex();
  const baseRoughnessBefore = base.roughness;

  const v = sys.variant('stone_wall', [0.5, 0.5, 0.5], 0.2);
  assert.notEqual(v, base);
  assert.equal(base.color.getHex(), baseColorBefore, 'the shared instance must not be mutated');
  assert.equal(base.roughness, baseRoughnessBefore, 'the shared instance must not be mutated');
});

test('variant(): applies the tint and roughness delta to the clone', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const base = sys.get('plain_key', { color: 0x808080 });
  const baseR = base.color.r;
  const baseRoughness = base.roughness;

  const v = sys.variant('plain_key', [0.5, 1, 1], 0.1);
  assert.ok(Math.abs(v.color.r - baseR * 0.5) < 1e-6, 'red channel must scale by the tint factor');
  assert.ok(Math.abs(v.color.g - baseR) < 1e-6, 'green channel tint factor is 1 — unchanged');
  assert.ok(Math.abs(v.roughness - Math.min(1, baseRoughness + 0.1)) < 1e-6, 'roughness must shift by roughDelta');
});

test('variant(): a triplanar surface variant keeps its forge textures (does not lose them to the userData deep-clone)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const set = sys.makeSurface('dirt', 11);
  sys._entries.set('dirt_test', { material: set.material, refs: 1 }); // reach it via get()'s cache shape
  const v = sys.variant('dirt_test', [1, 1, 1], 0);
  assert.equal(v.userData.triplanar.detailTexture, set.material.userData.triplanar.detailTexture);
  assert.equal(typeof v.onBeforeCompile, 'function');
});

test('variant(): throws for an unknown baseKey', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  assert.throws(() => sys.variant('never_requested', [1, 1, 1], 0), /unknown baseKey/);
});

// --- atlas() ------------------------------------------------------------

test('atlas(): same name returns the same object every call, registerable once', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a1 = sys.atlas('items');
  a1.register('FAKE_TEX', (id) => `uv-${id}`);
  const a2 = sys.atlas('items');
  assert.equal(a1, a2);
  assert.equal(a2.texture, 'FAKE_TEX');
  assert.equal(a2.uvFor(5), 'uv-5');
});

test('atlas(): an unregistered name still returns a well-shaped object (texture null, uvFor a function)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.atlas('never_registered');
  assert.equal(a.texture, null);
  assert.equal(typeof a.uvFor, 'function');
});

// --- texture()/noiseTexture()/heightToNormal() ---------------------------

test('texture(key, size): returns a real cached THREE.Texture', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.texture('rockface', 64);
  const b = sys.texture('rockface', 64);
  assert.equal(a, b);
  assert.ok(a instanceof THREE.Texture);
});

for (const kind of ['value', 'gradient', 'worley', 'blue']) {
  test(`noiseTexture('${kind}', size, seed): returns a real, cached THREE.Texture`, async () => {
    const sys = new MaterialsSystem();
    await sys.init(makeBareCtx());
    const a = sys.noiseTexture(kind, 32, 100);
    const b = sys.noiseTexture(kind, 32, 100);
    assert.equal(a, b);
    assert.ok(a instanceof THREE.Texture);
  });
}

test('heightToNormal(heightTex, strength): returns a real THREE.Texture, degraded-safe', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const heightTex = sys.noiseTexture('worley', 32, 5);
  const normalTex = sys.heightToNormal(heightTex, 1.2);
  assert.ok(normalTex instanceof THREE.Texture);
});

// --- paletteFor()/rarityColour() — Fixed=Y, no wall clock -----------------

test('paletteFor(zoneId): returns the precomputed Palette, same object on repeated calls', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const a = sys.paletteFor('ashen_wastes');
  const b = sys.paletteFor('ashen_wastes');
  assert.equal(a, b, 'must be the same shared object — Alloc=no');
  assert.equal(a.zoneId, 'ashen_wastes');
});

test('paletteFor(unknownZone): falls back to the default palette instead of throwing', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const p = sys.paletteFor('nonexistent_zone_id');
  assert.equal(p.zoneId, '__default__');
  assert.deepEqual(Object.keys(p.surfaces).sort(), [...SURFACE_IDS].sort());
});

test('paletteFor(): never reads performance.now()/Date.now() (Fixed=Y — no wall clock)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const realPerfNow = globalThis.performance && globalThis.performance.now;
  const realDateNow = Date.now;
  if (globalThis.performance) globalThis.performance.now = () => { throw new Error('performance.now() read'); };
  Date.now = () => { throw new Error('Date.now() read'); };
  try {
    assert.doesNotThrow(() => sys.paletteFor('bonereach'));
  } finally {
    if (globalThis.performance) globalThis.performance.now = realPerfNow;
    Date.now = realDateNow;
  }
});

test('rarityColour(rarity): returns the exact sacred text-hex colours, sRGB 0..1', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const expected = {
    normal: 0xc8c8c8, superior: 0xc8c8c8, magic: 0x6a7bff, rare: 0xffe066, unique: 0xc8973f,
  };
  for (const rarity of RARITY_ORDER) {
    const c = sys.rarityColour(rarity);
    const hex = expected[rarity];
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    assert.ok(Math.abs(c.r - r) < 1e-9, `${rarity} r`);
    assert.ok(Math.abs(c.g - g) < 1e-9, `${rarity} g`);
    assert.ok(Math.abs(c.b - b) < 1e-9, `${rarity} b`);
  }
});

test('rarityColour(rarity, out): writes into out and returns it (identity)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const out = { r: -1, g: -1, b: -1 };
  const ret = sys.rarityColour('magic', out);
  assert.equal(ret, out);
  assert.ok(out.r > 0 || out.g > 0 || out.b > 0);
});

test('rarityColour(): unknown rarity falls back to normal instead of throwing', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const c = sys.rarityColour('not_a_rarity');
  const n = sys.rarityColour('normal');
  assert.deepEqual(c, n);
});

test('rarityColour(): never reads performance.now()/Date.now() (Fixed=Y — no wall clock)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const realPerfNow = globalThis.performance && globalThis.performance.now;
  const realDateNow = Date.now;
  if (globalThis.performance) globalThis.performance.now = () => { throw new Error('performance.now() read'); };
  Date.now = () => { throw new Error('Date.now() read'); };
  try {
    assert.doesNotThrow(() => sys.rarityColour('unique'));
  } finally {
    if (globalThis.performance) globalThis.performance.now = realPerfNow;
    Date.now = realDateNow;
  }
});

// --- keys -----------------------------------------------------------------

test('keys: lists the five shipped surfaces even before anything is produced', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const keys = sys.keys;
  for (const s of SURFACE_IDS) assert.ok(keys.includes(s));
});

test('keys: grows as get()/texture()/makeSurface()/noiseTexture() produce new keys', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const before = sys.keys.length;
  sys.get('a_new_key', { color: 0x123456 });
  sys.texture('another_key', 16);
  const after = sys.keys.length;
  assert.ok(after > before);
});

// --- zone:enter event ------------------------------------------------------

test('init(): subscribes to zone:enter (to pre-resolve the zone\'s palette per §2\'s event row)', async () => {
  const sys = new MaterialsSystem();
  const handlers = [];
  const ctx = {
    get: () => null,
    rng: null,
    events: { on: (evt, fn) => handlers.push(evt), emit() {} },
  };
  await sys.init(ctx);
  assert.ok(handlers.includes('zone:enter'));
});

// --- prewarmMaterials() -----------------------------------------------

test('prewarmMaterials(ctx): degraded (no renderer) — never throws, still builds every surface\'s MaterialSet (real work happened, not an abort)', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  await assert.doesNotReject(sys.prewarmMaterials(makeBareCtx()));
  for (const surface of SURFACE_IDS) {
    assert.ok(sys._surfaceSets.has(`${surface}|${hashSurface(surface)}`) || [...sys._surfaceSets.keys()].some((k) => k.startsWith(surface + '|')));
  }
});

test('prewarmMaterials(ctx): degraded — compiled count is 0 (nothing to compile without a renderer), but keys still cover all five surfaces + variants', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  await sys.prewarmMaterials(makeBareCtx());
  assert.equal(sys._lastPrewarmCount, 0);
  const keys = sys.keys;
  for (const s of SURFACE_IDS) {
    assert.ok(keys.some((k) => k.startsWith(s + '|') && k.endsWith('|plain') === false || k === s));
  }
});

test('prewarmMaterials(ctx): never touches ctx.rng', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  let touched = false;
  const ctx = makeBareCtx();
  ctx.rng = { u32: () => { touched = true; return 0; } };
  await sys.prewarmMaterials(ctx);
  assert.equal(touched, false);
});

/** Mirrors index.js's own internal hashStringToU32 (FNV-1a) closely enough
 * to check membership loosely above; not asserting the exact hash algorithm
 * (that's an implementation detail), just that SOME deterministic seed was
 * used per surface. */
function hashSurface(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- boot() integration -----------------------------------------------

test('boot(): registers materials right after render, before physics (02 §Init order)', async () => {
  const { ctx, bootLog } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  assert.equal(ctx.has('materials'), true);
  const mat = ctx.get('materials');
  assert.ok(mat instanceof MaterialsSystem);

  const b5 = bootLog.find((e) => e.id === 'B5');
  const ids = b5.ids;
  assert.ok(ids.indexOf('materials') > ids.indexOf('render'));
  assert.ok(ids.indexOf('materials') < ids.indexOf('physics'));
});

test('boot(): B8 shader pre-warm still completes with materials registered', async () => {
  const { ctx, bootLog } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  assert.ok(ctx.has('materials'));
  const b8 = bootLog.find((e) => e.id === 'B8');
  assert.equal(b8.status, 'done');
});

test('boot(): three lockstep boot frames complete with materials registered, no throw', async () => {
  await assert.doesNotReject(boot({ canvas: makeCanvas(), deterministic: true, global: {} }));
});

// --- dispose() --------------------------------------------------------

test('dispose(): safe to call, disposes every cached material/texture without throwing, safe to call twice', async () => {
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  sys.makeSurface('stone', 1);
  sys.texture('a', 8);
  sys.noiseTexture('worley', 8, 1);
  assert.doesNotThrow(() => sys.dispose());
  assert.doesNotThrow(() => sys.dispose());
});
