// src/materials/data/palette.js
//
// MATL-1 — the surface palette and sacred rarity colours. D-72: this
// directory is auto-discovered by `tools/check-imports.mjs` as a `data/`
// root and must stay fully headless — no `three`, no DOM, no
// `performance.now()`, transitively. Every value below is a plain number,
// array or object; colour math is done with bit ops on plain hex ints, never
// `THREE.Color` (that conversion happens in `../index.js`, which is allowed
// to import `three`).
//
// ---------------------------------------------------------------------------
// What is FIXED (verbatim from a spec doc) vs CHOSEN (this ticket's call)
// ---------------------------------------------------------------------------
// FIXED, taken verbatim and never re-derived:
//   - RARITY_TABLE — docs/spec/09-ui.md §2.1.4, values sourced from
//     01-data-model.md §1.6 / ARCHITECTURE.md § Quality bar. `rarityColour()`
//     returns the "Text hex" column only; frame/luminance/mark are kept here
//     too since they are the same fixed table and a future fx/ui ticket may
//     want them, but MATL-1 itself only consumes `.text`.
//   - ZONE_SURFACE_USAGE — docs/spec/07-world-gen.md §1.6, the ground/collider
//     surface lists per zone, verbatim.
//   - DETAIL_SIZE/MACRO_SIZE/DETAIL_TILE_METERS/MACRO_TILE_METERS —
//     docs/spec/07-world-gen.md §1.4 ("2 m detail tile at 1024², 64 m macro
//     variation map at 512²").
//
// CHOSEN — no document gives concrete surface colours, roughness values or a
// Palette record shape (this ticket's brief, rule 6). Every value in
// SURFACE_BASE and the two blend constants below is this ticket's own call,
// made to fit IMPLEMENTATION_PLAN.md §5's direction ("grim gothic fantasy, a
// twilight palette, readability over prettiness") and ARCHITECTURE.md's
// quality bar ("no flat/untextured surfaces... nothing perfectly straight,
// clean or repeated"). Listed verbatim in the MATL-1 report so a future
// ticket can tell FIXED from CHOSEN without re-reading this file.

/** FIXED — 09-ui.md §2.1.4, byte-for-byte. */
export const RARITY_TABLE = Object.freeze({
  normal: Object.freeze({ text: 0xc8c8c8, frame: 0xc8c8c8, luminance: 0.578, mark: 'none' }),
  superior: Object.freeze({ text: 0xc8c8c8, frame: 0xe0e0e0, luminance: 0.578, mark: 'one bar' }),
  magic: Object.freeze({ text: 0x6a7bff, frame: 0x8f9bff, luminance: 0.245, mark: 'two bars' }),
  rare: Object.freeze({ text: 0xffe066, frame: 0xffe066, luminance: 0.755, mark: 'open diamond' }),
  unique: Object.freeze({ text: 0xc8973f, frame: 0xe0b25a, luminance: 0.348, mark: 'filled double diamond' }),
});

/** FIXED order, matching the table's own row order in `09`. */
export const RARITY_ORDER = Object.freeze(['normal', 'superior', 'magic', 'rare', 'unique']);

/** The five surfaces this ticket ships. Rule 13: no sixth. `grass` is named
 * by ARCHITECTURE.md § Surface types and IMPLEMENTATION_PLAN.md §1 as one of
 * the five, but no shipped zone (07 §1.6) ever authors it — see the report. */
export const SURFACE_IDS = Object.freeze(['stone', 'dirt', 'grass', 'ash', 'bone']);

/** FIXED — 07-world-gen.md §1.4, verbatim texel budget for ground materials. */
export const DETAIL_SIZE = 1024;
export const MACRO_SIZE = 512;
export const DETAIL_TILE_METERS = 2;
export const MACRO_TILE_METERS = 64;

/** FIXED — 07-world-gen.md §1.6, verbatim ground/collider surface lists per
 * zone. Kept here (not consumed by paletteFor's own logic beyond the
 * intersection below) as the documented source `ZONE_PALETTE_SURFACES` is
 * derived from, and for any future ticket/test that wants the raw table. */
export const ZONE_SURFACE_USAGE = Object.freeze({
  last_bastion: Object.freeze({
    ground: Object.freeze(['stone', 'dirt', 'sand', 'water']),
    collider: Object.freeze(['stone', 'wood', 'metal', 'water']),
  }),
  ashen_wastes: Object.freeze({
    ground: Object.freeze(['ash', 'dirt', 'stone', 'bone']),
    collider: Object.freeze(['stone', 'wood', 'bone', 'ash']),
  }),
  bonereach: Object.freeze({
    ground: Object.freeze(['stone', 'bone', 'dirt', 'water']),
    collider: Object.freeze(['stone', 'bone', 'metal', 'wood']),
  }),
  altar_of_instruction: Object.freeze({
    ground: Object.freeze(['stone', 'ash', 'bone']),
    collider: Object.freeze(['stone', 'crystal', 'metal', 'bone']),
  }),
});

/**
 * CHOSEN — grim gothic / twilight base albedo (sRGB hex) and roughness range
 * per surface. Picked, not specified: cold desaturated stone, dark wet
 * umber dirt, a desaturated near-black moss green for grass (unused by any
 * shipped zone — see the report), pale ember-grey ash, bleached ivory bone.
 * `normalStrength` and the detail/macro tint variance are shared across all
 * five (single chosen constants below) rather than per-surface, to keep the
 * invented-number count down.
 */
export const SURFACE_BASE = Object.freeze({
  stone: Object.freeze({ base: 0x6b6f78, roughnessMin: 0.75, roughnessMax: 0.92 }),
  dirt: Object.freeze({ base: 0x4a3b2c, roughnessMin: 0.85, roughnessMax: 0.97 }),
  grass: Object.freeze({ base: 0x3c4a34, roughnessMin: 0.7, roughnessMax: 0.88 }),
  ash: Object.freeze({ base: 0x8a8478, roughnessMin: 0.55, roughnessMax: 0.78 }),
  bone: Object.freeze({ base: 0xcfc7b0, roughnessMin: 0.5, roughnessMax: 0.7 }),
});

/** CHOSEN — shared blend constants deriving edge-wear (lightened) and grime
 * (darkened, desaturated toward near-black-brown) tints from each surface's
 * own base colour, instead of five more invented hexes. */
export const EDGE_WEAR_LIGHTEN = 0.38;
export const GRIME_DARKEN = 0.62;
export const GRIME_TINT = 0x140f0a; // CHOSEN — near-black warm soot, mixed into the darkened base
export const NORMAL_STRENGTH = 1.0; // CHOSEN — full-strength Sobel normal
export const DETAIL_TINT_VARIANCE = 0.12; // CHOSEN — macro-layer tint jitter amount

/**
 * Linearly interpolates two 0xRRGGBB colours by `t` (0 = `hexA`, 1 = `hexB`),
 * returning a new 0xRRGGBB int. Pure integer/float math, no `three`.
 * @param {number} hexA
 * @param {number} hexB
 * @param {number} t - 0..1
 * @returns {number}
 */
export function mixColors(hexA, hexB, t) {
  const ar = (hexA >> 16) & 0xff, ag = (hexA >> 8) & 0xff, ab = hexA & 0xff;
  const br = (hexB >> 16) & 0xff, bg = (hexB >> 8) & 0xff, bb = hexB & 0xff;
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const b = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | b;
}

/**
 * Splits a 0xRRGGBB int into a plain `{r,g,b}` object, each channel
 * normalised 0..1 (sRGB-encoded, not linearised — see `../index.js`'s
 * `rarityColour` header for why sRGB 0..1 is this ticket's chosen unit).
 * @param {number} hex
 * @returns {{r:number,g:number,b:number}}
 */
export function hexToRgb01(hex) {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
  };
}

/**
 * Lightens (`t>0`) or darkens (`t<0`) a 0xRRGGBB colour toward white/black by
 * fraction `|t|`, returning a new 0xRRGGBB int. Pure integer/float math, no
 * `three` — this is what derives `EDGE_WEAR_LIGHTEN`/`GRIME_DARKEN` per
 * surface instead of hand-picking ten more hexes.
 * @param {number} hex
 * @param {number} t - -1..1
 * @returns {number}
 */
export function mixToward(hex, t) {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const target = t >= 0 ? 255 : 0;
  const amt = Math.min(1, Math.abs(t));
  const mr = Math.round(r + (target - r) * amt);
  const mg = Math.round(g + (target - g) * amt);
  const mb = Math.round(b + (target - b) * amt);
  return (mr << 16) | (mg << 8) | mb;
}

/** The five surfaces (intersected against `SURFACE_IDS`) a zone's ground or
 * collider list actually names, per `ZONE_SURFACE_USAGE` — the set
 * `buildPalette` below produces entries for. Surfaces this ticket does not
 * ship (`sand`, `water`, `wood`, `metal`, `crystal`) are deliberately absent
 * from every zone's palette; see the MATL-1 report for why (rule 13: no
 * sixth surface — inventing colours for surfaces `materials.makeSurface`
 * cannot produce would be exactly that).
 * @param {string} zoneId
 * @returns {string[]}
 */
export function zonePaletteSurfaces(zoneId) {
  const usage = ZONE_SURFACE_USAGE[zoneId];
  if (!usage) return [];
  const set = new Set();
  for (const s of usage.ground) if (SURFACE_IDS.includes(s)) set.add(s);
  for (const s of usage.collider) if (SURFACE_IDS.includes(s)) set.add(s);
  // Stable order: SURFACE_IDS' own order, not insertion order.
  return SURFACE_IDS.filter((s) => set.has(s));
}

/** One surface's full palette entry, derived from `SURFACE_BASE[id]` plus
 * the shared edge-wear/grime blend constants — the one place both
 * `buildPalette` and `buildDefaultPalette` compute it, so the two never
 * drift apart. */
function surfacePaletteEntry(id) {
  const def = SURFACE_BASE[id];
  const edgeHex = mixToward(def.base, EDGE_WEAR_LIGHTEN);
  const grimeHex = mixColors(def.base, GRIME_TINT, GRIME_DARKEN);
  return {
    base: hexToRgb01(def.base),
    roughnessMin: def.roughnessMin,
    roughnessMax: def.roughnessMax,
    edgeWear: hexToRgb01(edgeHex),
    grime: hexToRgb01(grimeHex),
    normalStrength: NORMAL_STRENGTH,
  };
}

/**
 * Builds one zone's `Palette` record (CHOSEN shape — see this ticket's
 * report, "Palette record shape"): `{ zoneId, surfaces: { [surfaceId]: {
 * base:{r,g,b}, roughnessMin, roughnessMax, edgeWear:{r,g,b}, grime:{r,g,b},
 * normalStrength } } }`. Pure, deterministic, no `three` — `../index.js`
 * calls this once per known zone in `init()` and caches the result so
 * `paletteFor` (Fixed=Y, Alloc=no) never builds one at call time.
 * @param {string} zoneId
 * @returns {{zoneId:string, surfaces:Object<string,object>}}
 */
export function buildPalette(zoneId) {
  const surfaces = {};
  for (const id of zonePaletteSurfaces(zoneId)) surfaces[id] = surfacePaletteEntry(id);
  return { zoneId, surfaces };
}

/** The fallback palette for an unknown/unset zoneId — all five shipped
 * surfaces at their bare `SURFACE_BASE` values, no zone-specific narrowing.
 * CHOSEN: `paletteFor` returning "something sane" beats throwing for a zone
 * id `world` hasn't registered yet (rule 11 — never assert "nothing else
 * exists yet"; a fifth zone landing later must not crash this lookup). */
export function buildDefaultPalette() {
  const surfaces = {};
  for (const id of SURFACE_IDS) surfaces[id] = surfacePaletteEntry(id);
  return { zoneId: '__default__', surfaces };
}
