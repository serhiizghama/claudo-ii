// src/items/icons/generate.js
//
// ITEM-15 — the pure, non-cached icon generator. `./index.js`'s `iconFor`
// wraps this with the LRU (`./cache.js`); this file owns drawing only.
//
// ---------------------------------------------------------------------------
// Ruling D-24 — `OffscreenCanvas`, no fallback, no `performance.now()`
// ---------------------------------------------------------------------------
// `09-ui.md:1625` fixes the icon surface as `OffscreenCanvas` with a `2d`
// context, full stop — no `document.createElement('canvas')` fallback is
// added (none is sanctioned; see D-24's own text). In a browser this
// constructor exists unconditionally. In bare Node (`node --test`, this
// ticket's own unit tests) it does not — `typeof OffscreenCanvas ===
// 'undefined'` there, and this function returns `null` in that case: an
// EXPLICIT REFUSAL, never a `ReferenceError`, satisfying the ticket's
// test-form rule ("a success or an explicit refusal, never a throw"). The
// real render/timing/distinctness proof runs in headless Chromium
// (`tools/iconbench.mjs`, `tools/capture.mjs`'s `ui_icons` shot), where
// `OffscreenCanvas` is real — see this ticket's report for both runs' output.
//
// No `performance.now()` anywhere in this file or anything it imports —
// timing is measured from OUTSIDE `src/items/` entirely, by
// `tools/iconbench.mjs`, using the calling page's own clock (D-24's
// `src/nav/flow.js`/`tools/profile.mjs` pattern, applied here).
//
// ---------------------------------------------------------------------------
// Determinism — zero draws from `ctx.rng`/`this.rng` (proven, not assumed)
// ---------------------------------------------------------------------------
// The only `Rng` touched anywhere in this module is `new Rng(base.iconSeed)`
// below — a value seeded from static `ItemBase` data, never from any
// subsystem's fork. `tools/lootsim.mjs` never calls `items.icon()` (grep
// confirms), so this is moot for that harness in practice, but the design
// itself is what makes it moot: even if a caller mixed `icon()` calls into a
// loot-rolling session, the `items` stream (`ctx.rng.fork()`, taken once in
// `ItemsSystem#init`) is never read here, so `tools/lootsim.mjs`'s draw
// counts and histograms cannot be affected either way.

import { Rng } from '../../core/rng.js';
import { rampFor, tintRamp } from './ramps.js';
import { selectRecipe, RECIPES } from './recipes.js';
import { applyRarityFrame, applyOverlays } from './rarity.js';
import { wear, grime, rim } from './primitives.js';

/** `09-ui.md` §7.3: "Each recipe draws into the icon's content box with a
 * 4 px margin." */
const MARGIN = 4;

/** @returns {boolean} whether this realm can actually construct an icon
 * (see the D-24 note above). Exported so a caller (or a test) can check
 * before calling, without relying on a thrown error to find out. */
export function canGenerateIcons() {
  return typeof OffscreenCanvas !== 'undefined';
}

/**
 * Builds one icon bitmap from scratch — no cache lookup, no cache write.
 * `null` (never a throw) when: `base` is falsy, `base` selects no recipe
 * (`04-items.md` §11.3's `unarmed`/anything unmatched), the realm has no
 * `OffscreenCanvas`, or `getContext('2d')` itself returns falsy.
 *
 * @param {object} base - an `ItemBase`.
 * @param {{ rarity?:string, socketCount?:number, superior?:boolean, identified?:boolean, durability?:number, maxDurability?:number }} [opts]
 * @returns {object|null} an `OffscreenCanvas`, or `null`.
 */
export function generateIconCanvas(base, opts) {
  if (!base) return null;
  const recipeId = selectRecipe(base);
  const draw = recipeId ? RECIPES[recipeId] : null;
  if (!draw) return null;
  if (!canGenerateIcons()) return null;

  const o = opts || {};
  const w = Math.max(1, base.invW || 1) * 64;
  const h = Math.max(1, base.invH || 1) * 64;
  // `OffscreenCanvas` is a real global in every realm this ever actually
  // runs in (guarded by canGenerateIcons() above; there is no eslint in
  // this project — tools/check-imports.mjs's own regex only forbids
  // `document.`/`window.`/`performance.now()`, none of which this is).
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  if (!g) return null;
  if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';

  // Fresh per call, seeded only from static data — see file header.
  const rng = new Rng((base.iconSeed >>> 0) || 1);
  const ramp = tintRamp(rampFor(base.surface), rng.range(-14, 14), rng.range(-0.08, 0.08));

  const bx = MARGIN, by = MARGIN, bw = Math.max(1, w - MARGIN * 2), bh = Math.max(1, h - MARGIN * 2);
  draw(g, rng, { bx, by, bw, bh, cx: bx + bw / 2, cy: by + bh / 2, ramp, tier: base.tier, base });

  // 04-items.md §11.2: "Every icon ends with wear(0.4), grime(0.35),
  // rim('#070605', 1) in that order. A delta above that raises wear
  // replaces the 0.4, it does not add a second pass." This ticket does not
  // transcribe 04 §11.1's 61 per-base deltas (see recipes.js's own header),
  // so the "raise" is approximated generically off `tier`/`surface`
  // instead of a per-base authored number.
  const wearStrength = base.tier === 'elite' ? 0.55 : base.tier === 'exceptional' ? 0.48 : 0.4;
  const grimeStrength = base.surface === 'ash' ? 0.55 : 0.35;
  const box = { bx, by, bw, bh, ramp };
  wear(g, rng, { ...box, strength: wearStrength });
  grime(g, rng, { ...box, strength: grimeStrength });
  rim(g, rng, { ...box, colour: '#070605', width: 1 });

  applyRarityFrame(g, o.rarity || 'normal', w, h);
  applyOverlays(g, {
    socketCount: o.socketCount || 0,
    identified: o.identified !== false,
    durability: o.durability,
    maxDurability: o.maxDurability,
  }, w, h);

  return canvas;
}
