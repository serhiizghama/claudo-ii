// tests/materials/palette.test.js
//
// MATL-1 acceptance tests for src/materials/data/palette.js — the D-72
// headless data table. `node:test` + `node:assert/strict` only
// (12-testing.md P6). No `three` import anywhere in this file, matching the
// module under test.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RARITY_TABLE,
  RARITY_ORDER,
  SURFACE_IDS,
  ZONE_SURFACE_USAGE,
  DETAIL_SIZE,
  MACRO_SIZE,
  DETAIL_TILE_METERS,
  MACRO_TILE_METERS,
  hexToRgb01,
  mixColors,
  mixToward,
  zonePaletteSurfaces,
  buildPalette,
  buildDefaultPalette,
} from '../../src/materials/data/palette.js';

// --- FIXED values, reproduced byte-for-byte from 09-ui.md §2.1.4 ----------

test('RARITY_TABLE: five rows, verbatim text hex from 09-ui.md §2.1.4', () => {
  assert.deepEqual(RARITY_ORDER, ['normal', 'superior', 'magic', 'rare', 'unique']);
  assert.equal(RARITY_TABLE.normal.text, 0xc8c8c8);
  assert.equal(RARITY_TABLE.superior.text, 0xc8c8c8);
  assert.equal(RARITY_TABLE.magic.text, 0x6a7bff);
  assert.equal(RARITY_TABLE.rare.text, 0xffe066);
  assert.equal(RARITY_TABLE.unique.text, 0xc8973f);
});

test('RARITY_TABLE: frame stroke and luminance also verbatim (kept for a future ticket)', () => {
  assert.equal(RARITY_TABLE.normal.frame, 0xc8c8c8);
  assert.equal(RARITY_TABLE.superior.frame, 0xe0e0e0);
  assert.equal(RARITY_TABLE.magic.frame, 0x8f9bff);
  assert.equal(RARITY_TABLE.rare.frame, 0xffe066);
  assert.equal(RARITY_TABLE.unique.frame, 0xe0b25a);
  assert.equal(RARITY_TABLE.magic.luminance, 0.245);
  assert.equal(RARITY_TABLE.rare.luminance, 0.755);
});

test('SURFACE_IDS: exactly the five named surfaces, no sixth (rule 13)', () => {
  assert.deepEqual(SURFACE_IDS, ['stone', 'dirt', 'grass', 'ash', 'bone']);
});

test('texture size/tile constants: verbatim from 07-world-gen.md §1.4', () => {
  assert.equal(DETAIL_SIZE, 1024);
  assert.equal(MACRO_SIZE, 512);
  assert.equal(DETAIL_TILE_METERS, 2);
  assert.equal(MACRO_TILE_METERS, 64);
});

test('ZONE_SURFACE_USAGE: verbatim from 07-world-gen.md §1.6', () => {
  assert.deepEqual(ZONE_SURFACE_USAGE.last_bastion.ground, ['stone', 'dirt', 'sand', 'water']);
  assert.deepEqual(ZONE_SURFACE_USAGE.last_bastion.collider, ['stone', 'wood', 'metal', 'water']);
  assert.deepEqual(ZONE_SURFACE_USAGE.ashen_wastes.ground, ['ash', 'dirt', 'stone', 'bone']);
  assert.deepEqual(ZONE_SURFACE_USAGE.bonereach.collider, ['stone', 'bone', 'metal', 'wood']);
  assert.deepEqual(ZONE_SURFACE_USAGE.altar_of_instruction.ground, ['stone', 'ash', 'bone']);
});

// --- Colour math -------------------------------------------------------

test('hexToRgb01: splits and normalises a 0xRRGGBB int', () => {
  assert.deepEqual(hexToRgb01(0xff0080), { r: 1, g: 0, b: 128 / 255 });
  assert.deepEqual(hexToRgb01(0x000000), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb01(0xffffff), { r: 1, g: 1, b: 1 });
});

test('mixToward: t=1 reaches pure white, t=-1 reaches pure black, t=0 is a no-op', () => {
  assert.equal(mixToward(0x336699, 1), 0xffffff);
  assert.equal(mixToward(0x336699, -1), 0x000000);
  assert.equal(mixToward(0x336699, 0), 0x336699);
});

test('mixColors: t=0 is hexA, t=1 is hexB, clamped outside 0..1', () => {
  assert.equal(mixColors(0x000000, 0xffffff, 0), 0x000000);
  assert.equal(mixColors(0x000000, 0xffffff, 1), 0xffffff);
  assert.equal(mixColors(0x000000, 0xffffff, 2), 0xffffff);
  assert.equal(mixColors(0x000000, 0xffffff, -1), 0x000000);
});

// --- Palette construction -----------------------------------------------

test('zonePaletteSurfaces: intersects each zone\'s ground+collider list against the five shipped surfaces', () => {
  assert.deepEqual(zonePaletteSurfaces('last_bastion'), ['stone', 'dirt']);
  assert.deepEqual(zonePaletteSurfaces('ashen_wastes'), ['stone', 'dirt', 'ash', 'bone']);
  assert.deepEqual(zonePaletteSurfaces('bonereach'), ['stone', 'dirt', 'bone']);
  assert.deepEqual(zonePaletteSurfaces('altar_of_instruction'), ['stone', 'ash', 'bone']);
  assert.deepEqual(zonePaletteSurfaces('no_such_zone'), []);
});

test('grass never appears in any zone\'s palette — no shipped zone authors it (07 §1.6)', () => {
  for (const zoneId of Object.keys(ZONE_SURFACE_USAGE)) {
    assert.ok(!zonePaletteSurfaces(zoneId).includes('grass'), `${zoneId} must not include grass`);
  }
});

test('buildPalette: returns a Palette record with an entry per zone surface, each with base/roughness/edgeWear/grime/normalStrength', () => {
  const p = buildPalette('ashen_wastes');
  assert.equal(p.zoneId, 'ashen_wastes');
  assert.deepEqual(Object.keys(p.surfaces).sort(), ['ash', 'bone', 'dirt', 'stone'].sort());
  for (const id of Object.keys(p.surfaces)) {
    const entry = p.surfaces[id];
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(entry.base[ch] >= 0 && entry.base[ch] <= 1);
      assert.ok(entry.edgeWear[ch] >= 0 && entry.edgeWear[ch] <= 1);
      assert.ok(entry.grime[ch] >= 0 && entry.grime[ch] <= 1);
    }
    assert.ok(entry.roughnessMin >= 0 && entry.roughnessMin <= 1);
    assert.ok(entry.roughnessMax >= entry.roughnessMin);
    assert.equal(typeof entry.normalStrength, 'number');
  }
});

test('buildPalette: pure and deterministic — same zoneId always gives the same record', () => {
  const a = buildPalette('bonereach');
  const b = buildPalette('bonereach');
  assert.deepEqual(a, b);
});

test('buildDefaultPalette: covers all five shipped surfaces, unconditionally', () => {
  const p = buildDefaultPalette();
  assert.deepEqual(Object.keys(p.surfaces).sort(), [...SURFACE_IDS].sort());
});

test('edge-wear is always lighter than or equal to base, grime always darker or equal (per-channel sum)', () => {
  const p = buildDefaultPalette();
  for (const id of SURFACE_IDS) {
    const e = p.surfaces[id];
    const sum = (c) => c.r + c.g + c.b;
    assert.ok(sum(e.edgeWear) >= sum(e.base), `${id} edgeWear must not be darker than base`);
    assert.ok(sum(e.grime) <= sum(e.base), `${id} grime must not be lighter than base`);
  }
});

// --- Headless verification (D-72) ---------------------------------------

test('module loads headless in plain Node with no browser globals, no three', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../src/materials/data/palette.js', import.meta.url), 'utf8'),
  );
  // Strip // line comments and /* */ block comments first — this file's own
  // header prose legitimately SAYS "no performance.now()"/"no three" in
  // English, which would otherwise false-positive against the real-code scan
  // below (the same reason tools/check-imports.mjs masks comments before
  // scanning; see that file's header).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  assert.ok(!/from ['"]three['"]/.test(code), 'palette.js must not import three');
  assert.ok(!/\bwindow\s*\./.test(code), 'palette.js must not reference window');
  assert.ok(!/\bdocument\s*\./.test(code), 'palette.js must not reference document');
  assert.ok(!/performance\s*\.\s*now\s*\(/.test(code), 'palette.js must not call performance.now()');
});
