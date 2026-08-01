// src/items/icons/ramps.js
//
// ITEM-15 — the material ramp table (`09-ui.md` §7.2's "Material shading"
// table) plus a small HSL helper used to apply the per-icon tint band
// (`04-items.md` §11.2 / `09-ui.md` §7.3: "hue ±14°, value ±8%, derived from
// iconSeed"). Pure data + pure math, no canvas calls, no RNG stream of its
// own — `./generate.js` draws the one `Rng` fork (from `ItemBase.iconSeed`)
// that decides the shift amount and passes the resulting numbers in here.
//
// Only the three named tones (`dark`/`mid`/`light`) are modelled; the "Extra"
// column of `09` §7.2 (specular streaks, grain lines, hairline cracks) is a
// per-primitive judgment call left to `./primitives.js` — see this ticket's
// report for what was simplified and why (scope: 61 bases' worth of hand
// authored `04` §11.1 parameter deltas was not transcribed; recipes are
// driven generically by `surface`/`tier`/`iconSeed` instead).

export const SURFACE_RAMPS = Object.freeze({
  metal: Object.freeze({ dark: '#3a4048', mid: '#7d8790', light: '#cdd6dd' }),
  bone: Object.freeze({ dark: '#5a5344', mid: '#9a917c', light: '#ded6c2' }),
  wood: Object.freeze({ dark: '#3a2a1c', mid: '#6b4c30', light: '#a17b52' }),
  stone: Object.freeze({ dark: '#2e2c28', mid: '#5c584f', light: '#8d887c' }),
  crystal: Object.freeze({ dark: '#2a3a52', mid: '#5a7fb0', light: '#b8d8ff' }),
  flesh: Object.freeze({ dark: '#4a2020', mid: '#8a3c3c', light: '#c47a70' }),
  ash: Object.freeze({ dark: '#241f1a', mid: '#4a4038', light: '#7a6d60' }),
});

/** Fallback ramp for an unrecognised `ItemBase.surface` — never throws on a
 * bad/missing surface value (test-form rule: a malformed base yields a
 * well-formed grey icon, not a crash). */
const FALLBACK_RAMP = Object.freeze({ dark: '#3a3a3a', mid: '#787878', light: '#c8c8c8' });

/** @param {string} surface @returns {{dark:string,mid:string,light:string}} */
export function rampFor(surface) {
  return SURFACE_RAMPS[surface] || FALLBACK_RAMP;
}

/** `#rrggbb` -> `[r,g,b]` each 0..255. No allocation-sensitivity here — this
 * runs at most a handful of times per icon generation (`Fixed: N`, `Alloc:
 * yes (first call)` per `02-api-contracts.md:1028`), never in a fixed step. */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `[r,g,b]` (0..255) -> `[h,s,l]` (h in 0..360, s/l in 0..1). */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = h / 360;
  return [
    hue2rgb(p, q, hh + 1 / 3) * 255,
    hue2rgb(p, q, hh) * 255,
    hue2rgb(p, q, hh - 1 / 3) * 255,
  ];
}

/**
 * Shifts one `#rrggbb` colour by `hueDeg` degrees of hue and `valMul` as a
 * multiplicative shift on lightness (`1 + valMul`, matching "value ±8%" read
 * as a relative, not absolute, delta — see this ticket's report for that
 * call). Pure function, deterministic for the same inputs.
 * @param {string} hex
 * @param {number} hueDeg
 * @param {number} valMul
 * @returns {string}
 */
export function tintHex(hex, hueDeg, valMul) {
  const [r, g, b] = hexToRgb(hex);
  let [h, s, l] = rgbToHsl(r, g, b);
  h = (h + hueDeg + 360) % 360;
  l = Math.max(0, Math.min(1, l * (1 + valMul)));
  const [tr, tg, tb] = hslToRgb(h, s, l);
  return rgbToHex(tr, tg, tb);
}

/**
 * Applies `tintHex` to all three tones of a ramp, returning a fresh object
 * (never mutates the frozen `SURFACE_RAMPS` entries).
 * @param {{dark:string,mid:string,light:string}} ramp
 * @param {number} hueDeg
 * @param {number} valMul
 */
export function tintRamp(ramp, hueDeg, valMul) {
  return {
    dark: tintHex(ramp.dark, hueDeg, valMul),
    mid: tintHex(ramp.mid, hueDeg, valMul),
    light: tintHex(ramp.light, hueDeg, valMul),
  };
}
