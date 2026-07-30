// src/ui/style.js
//
// UI-1 — `09 §2`'s design system: the full token block, injected once as a
// single `<style id="cl2-ui">` element (`09 §2`: "exactly as the reference
// project does, with the token block on `.cl2-ui`. No preprocessor, no
// external stylesheet, no `@import`, no `@font-face`."), plus the U0 layer
// structure `09 §15`'s U0 row asks for.
//
// ---------------------------------------------------------------------------
// The 8 layers — an ambiguity this ticket resolved (see the report)
// ---------------------------------------------------------------------------
// `09 §13.1`'s DOM node budget states the total ("root + 8 layers | 9") but
// this ticket was scoped to read `09 §2` (design system) and `§13.1`
// (budget), not `§3` (Layout) — so the 8 layers' names are not given in what
// this ticket read. The 8 below are this ticket's own forward-compatible
// stacking design, derived from the budget table's own region list
// (`§13.1`): persistent HUD chrome at the bottom, then panels, dialogue,
// tooltips (must sit above an open panel), transient feedback (damage
// numbers/toasts/banners), full-screen modal screens, the cursor/drag-ghost
// layer, and a topmost fade-to-black layer (`fadeTo`/`fadeLevel`, `02
// §14`, must be able to obscure literally everything, including the drag
// cursor). Nothing draws into any of them yet — U1-U14 populate one layer
// each as their own widgets land; this ticket only fixes the 8 names and
// their z-order so later tickets don't have to renegotiate the stack.

import { resolveDocument } from './util.js';

export const STYLE_ID = 'cl2-ui';

/** The 8 layers, bottom to top. `09 §13.1`'s "root + 8 layers | 9" — see
 * this file's header for how the set and order were chosen. */
export const LAYER_NAMES = ['hud', 'panels', 'dialogue', 'tooltip', 'feedback', 'screen', 'cursor', 'fade'];

/**
 * The full token block, `09 §2`, on `.cl2-ui` (the root element's class —
 * see `./index.js`'s `buildSkeleton`). `--k` is the interface scale factor
 * (`options.uiScale`, `01-data-model.md` §10.2 via `SettingsSave`
 * `uiScale`); U0 fixes it at `1` — reading the real saved value is a later
 * ticket's job; nothing here depends on it changing yet.
 */
export const TOKENS_CSS = `
.cl2-ui {
  /* 2.3 Spacing */
  --k: 1;
  --u: calc(4px * var(--k));
  --space-1: calc(1 * var(--u));
  --space-2: calc(2 * var(--u));
  --space-3: calc(3 * var(--u));
  --space-4: calc(4 * var(--u));
  --space-5: calc(5 * var(--u));
  --space-6: calc(6 * var(--u));
  --space-8: calc(8 * var(--u));
  --space-10: calc(10 * var(--u));
  --space-12: calc(12 * var(--u));
  --pad: var(--space-6);

  /* 2.1.1 Substrate — warm blacks and ash */
  --void: #0a0908;
  --ash-900: #100e0c;
  --ash-800: #16130f;
  --ash-700: #1e1a15;
  --ash-600: #2a241c;
  --ash-500: #3a3128;
  --ash-400: #4c4136;

  /* 2.1.2 Ink — bone */
  --ink-1: #efe7d8;
  --ink-2: #c8bda8;
  --ink-3: #8c8375;
  --ink-4: #5a5349;
  --hair: rgba(239, 231, 216, .10);
  --hair-lit: rgba(239, 231, 216, .20);

  /* 2.1.3 Accent and semantic */
  --ember: #e0622a;
  --ember-dim: #8f3d1a;
  --verdigris: #3f8f7a;
  --danger: #c8322a;
  --danger-ink: #e35a4e;
  --good-ink: #7fb069;
  --property: #7f8dff;
  --gilt: #c9a227;

  /* 2.1.4 Rarity — sacred, reproduced exactly */
  --rarity-normal: #c8c8c8;
  --rarity-normal-frame: #c8c8c8;
  --rarity-superior: #c8c8c8;
  --rarity-superior-frame: #e0e0e0;
  --rarity-magic: #6a7bff;
  --rarity-magic-frame: #8f9bff;
  --rarity-rare: #ffe066;
  --rarity-rare-frame: #ffe066;
  --rarity-unique: #c8973f;
  --rarity-unique-frame: #e0b25a;

  /* 2.1.5 Resource fills */
  --life-top: #e0453a;
  --life-bottom: #7a1410;
  --life-ghost: rgba(240, 168, 158, .34);
  --mana-top: #4a7ff0;
  --mana-bottom: #16307a;
  --rage-top: #f0821f;
  --rage-bottom: #8a3c06;
  --resonance: #7fd8e8;
  --stamina-top: #a8b070;
  --stamina-bottom: #5a6030;

  /* 2.1.6 Damage element colours */
  --element-physical: #e8e2d4;
  --element-physical-crit: #ffffff;
  --element-fire: #ff7a2f;
  --element-fire-crit: #ffa15c;
  --element-cold: #7fd0ff;
  --element-cold-crit: #b6e6ff;
  --element-lightning: #f2d84a;
  --element-lightning-crit: #fff3a0;
  --element-poison: #8fd14f;
  --element-poison-crit: #bbe888;
  --element-magic: #c78fff;
  --element-magic-crit: #deb9ff;
  --element-heal: #7fd88f;
  --element-immune: #8c8375;

  /* 2.2 Typography — stacks */
  --ff-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --ff-serif: "Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", "Iowan Old Style", Georgia, "Times New Roman", serif;
  --ff-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Roboto Mono", monospace;

  /* 2.2 Typography — per-token scale (px @ k=1, multiplied by --k below) */
  --t-micro-size: calc(11px * var(--k)); --t-micro-weight: 600; --t-micro-lh: calc(13px * var(--k)); --t-micro-tracking: .14em; --t-micro-transform: uppercase;
  --t-label-size: calc(12px * var(--k)); --t-label-weight: 600; --t-label-lh: calc(15px * var(--k)); --t-label-tracking: .16em; --t-label-transform: uppercase;
  --t-body-size: calc(13px * var(--k)); --t-body-weight: 400; --t-body-lh: calc(18px * var(--k)); --t-body-tracking: .01em; --t-body-transform: none;
  --t-body-em-size: calc(13px * var(--k)); --t-body-em-weight: 600; --t-body-em-lh: calc(18px * var(--k)); --t-body-em-tracking: .01em; --t-body-em-transform: none;
  --t-read-size: calc(15px * var(--k)); --t-read-weight: 400; --t-read-lh: calc(22px * var(--k)); --t-read-tracking: 0em; --t-read-transform: none;
  --t-name-size: calc(18px * var(--k)); --t-name-weight: 600; --t-name-lh: calc(23px * var(--k)); --t-name-tracking: .02em; --t-name-transform: none;
  --t-title-size: calc(22px * var(--k)); --t-title-weight: 600; --t-title-lh: calc(27px * var(--k)); --t-title-tracking: .05em; --t-title-transform: none;
  --t-display-size: calc(34px * var(--k)); --t-display-weight: 700; --t-display-lh: calc(38px * var(--k)); --t-display-tracking: .07em; --t-display-transform: none;
  --t-hero-size: calc(54px * var(--k)); --t-hero-weight: 700; --t-hero-lh: calc(58px * var(--k)); --t-hero-tracking: .10em; --t-hero-transform: none;
  --t-num-s-size: calc(12px * var(--k)); --t-num-s-weight: 500; --t-num-s-lh: calc(14px * var(--k)); --t-num-s-tracking: .02em; --t-num-s-transform: none;
  --t-num-size: calc(15px * var(--k)); --t-num-weight: 600; --t-num-lh: calc(17px * var(--k)); --t-num-tracking: .02em; --t-num-transform: none;
  --t-num-l-size: calc(26px * var(--k)); --t-num-l-weight: 700; --t-num-l-lh: calc(28px * var(--k)); --t-num-l-tracking: .01em; --t-num-l-transform: none;

  /* 2.2 The outline, not the shadow */
  --oc: #070605;
  --o1:
    calc(1.5px * var(--k)) 0 0 var(--oc), calc(-1.5px * var(--k)) 0 0 var(--oc),
    0 calc(1.5px * var(--k)) 0 var(--oc), 0 calc(-1.5px * var(--k)) 0 var(--oc),
    calc(1.1px * var(--k)) calc(1.1px * var(--k)) 0 var(--oc), calc(-1.1px * var(--k)) calc(1.1px * var(--k)) 0 var(--oc),
    calc(1.1px * var(--k)) calc(-1.1px * var(--k)) 0 var(--oc), calc(-1.1px * var(--k)) calc(-1.1px * var(--k)) 0 var(--oc);
  --o2:
    calc(2.0px * var(--k)) 0 0 var(--oc), calc(-2.0px * var(--k)) 0 0 var(--oc),
    0 calc(2.0px * var(--k)) 0 var(--oc), 0 calc(-2.0px * var(--k)) 0 var(--oc),
    calc(1.45px * var(--k)) calc(1.45px * var(--k)) 0 var(--oc), calc(-1.45px * var(--k)) calc(1.45px * var(--k)) 0 var(--oc),
    calc(1.45px * var(--k)) calc(-1.45px * var(--k)) 0 var(--oc), calc(-1.45px * var(--k)) calc(-1.45px * var(--k)) 0 var(--oc);
  --sh-o1: var(--o1), 0 0 4px rgba(7, 6, 5, .80);
  --sh-o2: var(--o2), 0 0 5px rgba(7, 6, 5, .85);
  --sh-panel: 0 1px 1px rgba(0, 0, 0, .85);

  /* 2.4 Border, bevel and elevation */
  --edge: 1px solid var(--ash-500);
  --bevel:
    inset 0 1px 0 rgba(239, 231, 216, .07),
    inset 0 -1px 0 rgba(0, 0, 0, .60),
    inset 1px 0 0 rgba(239, 231, 216, .04),
    inset -1px 0 0 rgba(0, 0, 0, .45);
  --well:
    inset 0 1px 3px rgba(0, 0, 0, .70),
    inset 0 0 0 1px rgba(0, 0, 0, .55);

  --e1-fill: rgba(18, 15, 12, .84);
  --e1-shadow: 0 -2px 10px rgba(0, 0, 0, .45);
  --e2-fill: rgba(22, 19, 15, .96);
  --e2-shadow: 0 8px 28px rgba(0, 0, 0, .55);
  --e3-fill: rgba(16, 14, 12, .98);
  --e3-shadow: 0 10px 34px rgba(0, 0, 0, .70);
  --e4-fill: rgba(10, 9, 8, .62);
}

/* ---------------------------------------------------------------------
 * Layer structure (09 §15 U0) — see this file's header for how the 8
 * names/order were chosen. #ui is the sole overlay root (02-api-contracts
 * §14: "Owns exclusively: every DOM node under #ui"); every layer is a
 * full-viewport, pointer-events:none pane so an empty layer never blocks a
 * click — a widget that needs hit-testing turns pointer-events:auto on
 * itself once it exists (U1+), never on the layer.
 * --------------------------------------------------------------------- */
#ui {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 1000;
}

.cl2-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
${LAYER_NAMES.map((name, i) => `.cl2-layer[data-cl2-layer="${name}"] { z-index: ${i + 1}; }`).join('\n')}
`;

/**
 * Injects `TOKENS_CSS` as a single `<style id="cl2-ui">`, idempotently (a
 * second call is a no-op — this codebase's `Registry` never constructs two
 * `UiSystem`s, but idempotency costs nothing and matches `resolveDocument`'s
 * own "safe to call more than once" spirit).
 * @param {object} [doc] - defaults to `resolveDocument()`.
 * @returns {object} the `<style>` element.
 */
export function injectStyle(doc = resolveDocument()) {
  const existing = doc.getElementById(STYLE_ID);
  if (existing) return existing;
  const styleEl = doc.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = TOKENS_CSS;
  const host = doc.head || doc.body;
  host.appendChild(styleEl);
  return styleEl;
}

/** Removes the injected `<style>`, if present. Part of `UiSystem.dispose()`. */
export function removeStyle(doc = resolveDocument()) {
  const existing = doc.getElementById(STYLE_ID);
  if (existing) existing.remove();
}
