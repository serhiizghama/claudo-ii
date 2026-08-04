// src/ui/minimap.js
//
// UI-11 — `09 §15`'s U11 row: "Minimap and ground labels". Three features
// live here because the spec's own U11 row bundles them and they share one
// data pull (the ground-item sweep feeds both the minimap's item markers and
// the label pool):
//
//   1. the corner minimap (`09 §4.7`, 240x240 at (24,24), 2.6 px/m, north-up),
//   2. the `Tab` overlay (`09 §4.7`, 1440x860, 8.0 px/m, the whole zone),
//   3. the ground-item labels (`09 §9`, Alt-held, coloured by rarity).
//
// ---------------------------------------------------------------------------
// D-71 — the map is baked HERE, from `nav.grid`, and `nav.debugTexture()` is
// never called
// ---------------------------------------------------------------------------
// `02-api-contracts.md`:505 contracts `nav.debugTexture() => THREE.DataTexture`
// "for the minimap". That method is unimplementable as contracted: `src/nav/`
// is a `tools/check-imports.mjs` N-surface root with `checkThree: true`, so
// the file that would build a `THREE.DataTexture` may not import `three` at
// all. The ruling (D-71) is that UI-11 bakes the map on the `ui` side instead,
// reading `nav.grid`'s typed arrays — which `ui` may legitimately do at
// runtime through `ctx.get('nav')` (ARCHITECTURE.md rule 2 forbids the
// *import*, not the runtime handle) — and that the contract line is deferred
// and recorded, not faked. Nothing in this file imports anything from
// `src/nav/`, and `debugTexture` is neither called nor added.
//
// ---------------------------------------------------------------------------
// Why the bake is once per zone, and what "per frame" costs
// ---------------------------------------------------------------------------
// `09 §4.7`'s own rendering note: the nav layer is rasterised ONCE, on
// `nav:rebuilt`, into an offscreen canvas at 2 px per 0.5 m cell; the fog mask
// is stamped at 4 Hz; and per frame the minimap does one `drawImage` of the
// baked layer, one of the fog, and <= 48 marker blits. ARCHITECTURE.md rule 6
// makes that a hard requirement, not an optimisation: a minimap that rebuilds
// a texture every frame is a defect. `_bake()` is guarded on `navVersion`, so
// `zone:ready` (which always fires AFTER `nav:rebuilt` for the same zone —
// `src/world/index.js:1172` then `:1210`) can be listened to as a safety net
// without ever producing a second bake for one nav version. That is exactly
// `09 §15` U11's acceptance clause "the minimap rebakes exactly once per
// `nav:rebuilt`".
//
// The classification pass writes into `_cellClass` (one byte per nav cell) and
// the paint pass turns that into pixels. The split is not decoration: the Node
// DOM shim (`./util.js`) hands back a `<canvas>` with no `getContext`, so
// under `node --test` the paint is skipped while the classification — the part
// that carries the actual logic, and the part a test can meaningfully assert —
// still runs for real. Same "degrade gracefully under Node" discipline
// `./feedback.js` already documents for `#cl2-fx`.
//
// ---------------------------------------------------------------------------
// Rarity colour: one source, no second copy
// ---------------------------------------------------------------------------
// ARCHITECTURE.md's quality bar calls the rarity colours sacred. There are
// already three independent transcriptions of them in this repo
// (`src/materials/data/palette.js#RARITY_TABLE`, `src/ui/style.js`'s
// `--rarity-*` tokens, `src/items/icons/rarity.js#RARITY_META`) and this file
// adds a fourth over my dead body. Instead:
//
//   - every DOM surface (the label plate's seam, its text, its §12.1 mark)
//     takes its colour from `var(--rarity-<r>)` through a CSS class in
//     `./style.js` — no JS hex value is involved at all, the same mechanism
//     `./inventory.js:790` already uses for the icon frame;
//   - the canvas surfaces (the minimap's ground-item markers) need real
//     channels, so `RARITY_HEX` below PARSES them out of `./style.js`'s own
//     `TOKENS_CSS` at module load. It is a read of the single source, not a
//     copy of it: change the token and this changes with it.
//
// `tests/ui/ui11.test.js` additionally asserts the parsed values equal
// `materials.rarityColour()`'s channels, so the two subsystems' palettes are
// pinned to each other by a test rather than by hope.
//
// ---------------------------------------------------------------------------
// The two node budgets, and what they forced
// ---------------------------------------------------------------------------
// `09 §13.1` gives this ticket exactly two rows: "minimap | 6" and "ground
// labels | 48 | 16 pooled entries × 3 (plate, text, disc)". 48 is 16 × 3 with
// nothing left over, so:
//
//   - there is no wrapper node under the labels (each entry's plate and disc
//     attach straight to the layer), and
//   - §9.3's overflow chip has no nodes of its own — it BORROWS the last pool
//     entry, which is why the label budget reads 16 with no chip and 15 with
//     one. §9.3 says "the top 16 get labels", so this is a deviation, and it is
//     the only one that fits inside 48 nodes; recorded in this ticket's report.
//     §9.3's own "it does not raise the node count" is what makes borrowing the
//     right resolution rather than a 49th node.
//   - the §12.1 rarity mark is a `::before` on the text node, not a node.
//
// ---------------------------------------------------------------------------
// Live defects this file is written around (reported, not fixed here)
// ---------------------------------------------------------------------------
// - O-112: `AiSystem` is not registered in `src/main.js`, so nothing under
//   `src/ai/` runs. Monster markers are driven off `actors.forEachInRadius`
//   (the actor pool, which is registered) rather than anything in `ai`, so
//   they light up the moment monsters exist by any route.
// - O-120: `nav.rebuild()` hardcodes `groundRegions: null`, so
//   `NAV_FLAG.interior` and the doorway rects are never set. The bake
//   classifies `doorway` because `09 §4.7` names it, but the doorway colour
//   is unreachable today; nothing here *relies* on that flag.
// - O-69: `render.worldToScreen()` does not exist. Labels project through
//   `ctx.camera` directly, exactly as `./feedback.js:499` already does.
// - `player.pickUpOrder(uid)` (`02-api-contracts.md`:1172, `09 §9.5`) does not
//   exist either; the click handler calls it behind a `typeof === 'function'`
//   guard, the established pattern for consuming a not-yet-landed contract
//   method (`./feedback.js:894` does the same for `player.cameraShake`). The
//   OTHER half of §9.5 — "the click never also becomes a move order" — does
//   NOT depend on it and is live today: see `_onLabelPointerDown`.
// - `./style.js` and `./i18n.js` are both outside this ticket's file grant, so
//   this module injects its own stylesheet (above) and falls back to a literal
//   for every missing i18n key (`_tOr`). Both want folding back into their
//   owning files; reported.

import * as THREE from 'three';
import { el, setText, setStyle, setClass, place, clamp, numStr, resolveDocument } from './util.js';
import { TOKENS_CSS } from './style.js';

// ---------------------------------------------------------------------------
// This module's own stylesheet
// ---------------------------------------------------------------------------
// `./style.js` carries the design system and every widget rule shipped so far,
// but it is NOT in this ticket's file grant — and the minimap and the ground
// labels are pure CSS surfaces (a plate, a seam, a §12.1 mark, an absolutely
// positioned canvas): without rules they render as unstyled, unpositioned,
// unclickable divs. So this file injects its own `<style>`, next to the design
// system's, using the same `id`-guarded once-per-document mechanism
// `./style.js#injectStyle` uses. It goes in `<head>`, NOT under `#ui`, so it
// costs nothing against `09 §13.1`'s 700-node cap. Every colour below is a
// `var(--token)` read of `./style.js`'s own block — no hex is transcribed.
// Folding these rules back into `./style.js` is a one-move edit for whoever
// owns that file; see this ticket's report.
// ---------------------------------------------------------------------------

/** @type {string} the `<style>` element's id — one per document. */
export const MINIMAP_STYLE_ID = 'cl2-ui-minimap';

/**
 * `09 §4.7` (minimap chrome) and `09 §9.1` (label anatomy) as CSS.
 *
 * The four corner brackets are EIGHT background gradients on ONE node — the
 * same node-saving trick `09 §13.1` names for the inventory lattice and the XP
 * ticks, and the reason the minimap fits its 6-node row.
 *
 * The §12.1 rarity mark is the label text's `::before` (plus a `box-shadow` for
 * magic's second bar and unique's inner diamond), so the redundant shape
 * channel costs ZERO extra DOM nodes — which is what keeps the label pool at
 * `09 §13.1`'s 16 × 3 = 48.
 */
export const MINIMAP_CSS = `
.cl2-mm {
  position: absolute; left: 0; top: 0;
  width: 240px; height: 240px;
  pointer-events: none;
}
.cl2-mm-frame {
  position: absolute; left: -1px; top: -1px;
  width: 242px; height: 242px;
  box-sizing: border-box;
  border: var(--edge);
  background-repeat: no-repeat;
  background-image:
    linear-gradient(var(--ink-3) 0 0), linear-gradient(var(--ink-3) 0 0),
    linear-gradient(var(--ink-3) 0 0), linear-gradient(var(--ink-3) 0 0),
    linear-gradient(var(--ink-3) 0 0), linear-gradient(var(--ink-3) 0 0),
    linear-gradient(var(--ink-3) 0 0), linear-gradient(var(--ink-3) 0 0);
  background-size: 14px 2px, 2px 14px, 14px 2px, 2px 14px, 14px 2px, 2px 14px, 14px 2px, 2px 14px;
  background-position:
    left top, left top, right top, right top,
    left bottom, left bottom, right bottom, right bottom;
}
.cl2-mm-canvas { position: absolute; left: 0; top: 0; display: block; }
.cl2-mm-n, .cl2-mm-zone {
  position: absolute; left: 0; width: 240px;
  text-align: center;
  font-family: var(--ff-sans);
  font-size: var(--t-micro-size); font-weight: var(--t-micro-weight);
  line-height: var(--t-micro-lh); letter-spacing: var(--t-micro-tracking);
  text-transform: var(--t-micro-transform);
  color: var(--ink-2); text-shadow: var(--sh-o1);
}
.cl2-mm-n { top: -16px; }
.cl2-mm-zone { top: 246px; }
.cl2-mm-overlay { position: absolute; left: 0; top: 0; display: none; }

/* 09 §9.1 — the label plate. \`pointer-events: auto\` and \`data-ui-solid\`
 * (set in JS) are the two halves of §9.5's "the click never also becomes a
 * move order": the first makes the plate a real hit target, the second is
 * what O-78's \`pointerOverUi\` guard hit-tests with \`closest()\`. */
.cl2-gl {
  position: absolute; left: 0; top: 0;
  display: none;
  box-sizing: border-box;
  height: 22px; min-width: 90px; max-width: 260px;
  padding: 0 8px; border-left: 2px solid var(--rarity-normal);
  background: rgba(13, 11, 9, .78);
  -webkit-mask-image: linear-gradient(to right, #000 84%, rgba(0, 0, 0, .35) 100%);
  mask-image: linear-gradient(to right, #000 84%, rgba(0, 0, 0, .35) 100%);
  pointer-events: auto; cursor: pointer;
  overflow: visible;
}
.cl2-gl-2 { height: 44px; }
.cl2-gl-t {
  position: relative;
  padding-left: 18px;
  font-family: var(--ff-sans);
  font-size: var(--t-body-size); font-weight: var(--t-body-weight);
  line-height: 22px; letter-spacing: var(--t-body-tracking);
  color: var(--rarity-normal); text-shadow: var(--sh-o1);
  text-overflow: clip; overflow: hidden;
}
.cl2-gl-t::before { content: ''; position: absolute; left: 4px; box-sizing: border-box; }
/* §9.1's stem: a 1px line from the plate's bottom-centre down to the item's
 * projected point. Only present on a label decluttering displaced. */
.cl2-gl-stem::after {
  content: ''; position: absolute; left: 50%; top: 100%;
  width: 1px; height: var(--cl2-stem, 0px);
  background: var(--ink-3);
}
/* §9.5's 28 px-radius invisible disc at the item's own projected point. */
.cl2-gl-d {
  position: absolute; left: 0; top: 0;
  width: 56px; height: 56px; border-radius: 50%;
  display: none; pointer-events: auto; cursor: pointer;
}
/* §9.3's overflow chip — the same plate, no mark, \`--ink-2\` text. */
.cl2-gl-chip .cl2-gl-t { color: var(--ink-2); padding-left: 0; }
.cl2-gl-chip .cl2-gl-t::before { display: none; }

/* 09 §12.1's four redundant channels on one surface: the seam and the text
 * carry the (sacred, unchangeable) rarity colour, and the mark's SILHOUETTE
 * carries the same information without colour at all. */
.cl2-gl-normal { border-left-color: var(--rarity-normal); }
.cl2-gl-normal .cl2-gl-t { color: var(--rarity-normal); padding-left: 4px; }
.cl2-gl-normal .cl2-gl-t::before { display: none; }
.cl2-gl-superior { border-left-color: var(--rarity-superior); }
.cl2-gl-superior .cl2-gl-t { color: var(--rarity-superior); }
.cl2-gl-superior .cl2-gl-t::before { top: 9px; width: 8px; height: 3px; background: var(--rarity-superior); }
.cl2-gl-magic { border-left-color: var(--rarity-magic); }
.cl2-gl-magic .cl2-gl-t { color: var(--rarity-magic); }
.cl2-gl-magic .cl2-gl-t::before { top: 7px; width: 8px; height: 3px; background: var(--rarity-magic); box-shadow: 0 6px 0 0 var(--rarity-magic); }
.cl2-gl-rare { border-left-color: var(--rarity-rare); }
.cl2-gl-rare .cl2-gl-t { color: var(--rarity-rare); }
.cl2-gl-rare .cl2-gl-t::before { top: 6px; width: 10px; height: 10px; border: 2px solid var(--rarity-rare); transform: rotate(45deg); }
.cl2-gl-unique { border-left-color: var(--rarity-unique); }
.cl2-gl-unique .cl2-gl-t { color: var(--rarity-unique); }
.cl2-gl-unique .cl2-gl-t::before { top: 5px; width: 12px; height: 12px; background: var(--rarity-unique); transform: rotate(45deg); box-shadow: inset 0 0 0 3px rgba(13, 11, 9, .9); }
`;

/**
 * Injects `MINIMAP_CSS` once per document. Idempotent (`id`-guarded), exactly
 * like `./style.js#injectStyle`; and, like it, deliberately NOT removed by
 * `dispose()` — a `<style>` in `<head>` is not one of the "`#ui` nodes" rule 7
 * asks about, and a dispose/re-init cycle would otherwise re-parse it.
 * @param {object} [doc]
 * @returns {object} the `<style>` element.
 */
export function injectMinimapStyle(doc = resolveDocument()) {
  const existing = doc.getElementById(MINIMAP_STYLE_ID);
  if (existing) return existing;
  const styleEl = doc.createElement('style');
  styleEl.id = MINIMAP_STYLE_ID;
  styleEl.textContent = MINIMAP_CSS;
  const host = doc.head || doc.body;
  host.appendChild(styleEl);
  return styleEl;
}

// ---------------------------------------------------------------------------
// Palette — read out of `./style.js`, never transcribed. See the header.
// ---------------------------------------------------------------------------

/** `01-data-model.md` §1.6 / `09 §9.3`'s `RARITY_ORDER`, ascending. Local and
 * frozen, the same "local, frozen, not imported" precedent
 * `src/items/containers.js:88` documents — this is a vocabulary, not a
 * colour, so there is nothing here to drift. */
export const RARITY_ORDER = Object.freeze(['normal', 'superior', 'magic', 'rare', 'unique']);

/** Rank of each rarity, for `09 §9.3`'s `RARITY_ORDER.indexOf(rarity)` term
 * without the `indexOf` scan. */
const RARITY_RANK = Object.freeze({ normal: 0, superior: 1, magic: 2, rare: 3, unique: 4 });

/**
 * Pulls one `--token: #rrggbb;` declaration out of `TOKENS_CSS`. Runs at
 * module load, never per frame.
 * @param {string} name - the token name without the leading `--`.
 * @param {string} fallback
 * @returns {string} a `#rrggbb` string.
 */
function token(name, fallback) {
  const re = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,8})\\s*;');
  const m = re.exec(TOKENS_CSS);
  return m ? m[1] : fallback;
}

/** The five sacred rarity hexes, READ from `./style.js`'s `--rarity-*` block
 * (`09 §2.1.4`). Exported so `tests/ui/ui11.test.js` can pin them against
 * `materials.rarityColour()`. */
export const RARITY_HEX = Object.freeze({
  normal: token('rarity-normal', '#c8c8c8'),
  superior: token('rarity-superior', '#c8c8c8'),
  magic: token('rarity-magic', '#6a7bff'),
  rare: token('rarity-rare', '#ffe066'),
  unique: token('rarity-unique', '#c8973f'),
});

/** Chrome colours the marker table (`09 §4.7`) names by token. */
const C_GILT = token('gilt', '#c9a227');
const C_PROPERTY = token('property', '#7f8dff');
const C_VERDIGRIS = token('verdigris', '#3f8f7a');
const C_DANGER = token('danger', '#c8322a');
const C_EMBER = token('ember', '#e0622a');
const C_INK1 = token('ink-1', '#efe7d8');
const C_UNIQUE_MONSTER = '#c8973f'; // §4.7's champion/unique row names this hex directly

/** The baked nav layer's five fills. `walkable`/`doorway`/outline are tokens
 * (`--ash-600`/`--ash-500`/`--ash-400`); `hazard` and `water` are literals
 * `09 §4.7` gives directly and that have no token of their own. */
const C_WALKABLE = token('ash-600', '#2a241c');
const C_DOORWAY = token('ash-500', '#3a3128');
const C_HAZARD = '#4a2418';
const C_WATER = '#1a2630';
const C_OUTLINE = token('ash-400', '#4c4136');
const C_VOID = token('void', '#0a0908');

// Cell classes written into `_cellClass` by the bake. 0 is "blocked", which
// `09 §4.7` renders as transparent — so 0 also means "paint nothing".
const CLS_BLOCKED = 0;
const CLS_WALKABLE = 1;
const CLS_DOORWAY = 2;
const CLS_HAZARD = 3;
const CLS_WATER = 4;

/** `src/world/raster.js:47`'s `NAV_FLAG`, transcribed — `src/nav/` is another
 * subsystem and may not be imported (ARCHITECTURE.md rule 2). Same discipline
 * `./target.js:115` uses for `ACTOR_FLAG.boss`. */
const NAV_WALKABLE = 1 << 0;
const NAV_HAZARD = 1 << 2;
const NAV_WATER = 1 << 3;
const NAV_DOORWAY = 1 << 4;

/** `src/actors/pool.js:184`'s `TEAM.monster`, transcribed for the same
 * reason. */
const TEAM_MONSTER = 1;

// ---------------------------------------------------------------------------
// Geometry — `09 §4.7` and `09 §9`, verbatim.
// ---------------------------------------------------------------------------

const CORNER_SIZE = 240;
const CORNER_X = 24;
const CORNER_Y = 24;
const CORNER_PX_PER_M = 2.6;
const CORNER_OPACITY = 0.75; // SettingsSave.minimapOpacity default

const OVERLAY_W = 1440;
const OVERLAY_H = 860;
const OVERLAY_PX_PER_M = 8.0;
const OVERLAY_ALPHA = 0.45;

const BAKE_PX_PER_CELL = 2; // "2 px per 0.5 m cell"
const FOG_RADIUS_M = 22;
const FOG_PERIOD_S = 0.25; // 4 Hz
const FOG_UNEXPLORED_ALPHA = 0.87;

const MONSTER_REVEAL_M = 46; // "monsters ... only within 46 m"

/** `09 §4.7`'s "<= 48 marker blits" per frame, and the per-kind split that
 * makes the cap survivable on a floor with more markers than blits — see
 * `_beginMarkerPass`. The four quotas plus the reserved player blit are 48. */
const MARKER_BLIT_CAP = 48;
const MARKER_QUOTA_ITEM = 16;
const MARKER_QUOTA_ZONE = 12;
const MARKER_QUOTA_MONSTER = 12;
const MARKER_QUOTA_CUSTOM = 7;

const LABEL_BUDGET = 16;
const LABEL_H = 22;
const LABEL_RADIUS_M = 24;
const LABEL_FRESH_S = 5.0;
const LABEL_VIEWPORT_MARGIN = 60;
const POINTER_NEAR_PX = 30; // §9.2 rule 2
const LABEL_SORT_PERIOD_S = 0.10; // 10 Hz
const LABEL_STEM_THRESHOLD = 6;
const LABEL_RELAX_PASSES = 4;
const LABEL_MAX_W = 260;
const LABEL_MIN_W = 90; // §9.5's "≥ 90 px wide" hit target
const LABEL_FADE_S = 0.14;
/** The plate's non-text width: 8 px padding each side + the 2 px seam + the
 * 4 px gap + the 10 px §12.1 mark. */
const LABEL_CHROME_W = 8 + 2 + 4 + 10 + 8;
const LABEL_GLYPH_W = 7.2; // mean advance of --t-body (13 px system-ui) — ASSIGNED

const GROUND_SWEEP_CAP = 256; // preallocated `groundItemsNear` out-array
const CUSTOM_MARKER_CAP = 16; // `minimapMarker(id, x, z, kind)` slots

/** Per-rarity plate class — precomputed so a rarity change never builds a
 * class-name string at runtime (`09 §13.3`'s cached-`setClass` rule). */
const LABEL_RARITY_CLASS = Object.freeze({
  normal: 'cl2-gl-normal',
  superior: 'cl2-gl-superior',
  magic: 'cl2-gl-magic',
  rare: 'cl2-gl-rare',
  unique: 'cl2-gl-unique',
});

/** Defensive `ctx.get` — the per-module copy every `ui` file already carries
 * (`./index.js:74`, `./target.js:158`, ...). Must never throw against a bare
 * test ctx. */
function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(id); } catch { return null; }
  }
  return null;
}

/**
 * Registers `fn` as `node`'s `pointerdown` handler through the `onpointerdown`
 * IDL attribute rather than `addEventListener`. Deliberate: it is a real
 * listener registration in a browser, AND it is a plain property write on
 * `./util.js`'s Node shim (which implements no `addEventListener` at all) — so
 * `node --test` drives the exact same registration the browser does, instead of
 * silently skipping the binding the way a `typeof addEventListener` guard would.
 * @param {object} node
 * @param {((e:object) => void)|null} fn
 */
function bindPointerDown(node, fn) {
  node.onpointerdown = fn;
}

/**
 * `09 §5.1`'s name-resolution ladder, restricted to what a 22 px label shows.
 * Kept byte-for-byte equivalent to `./tooltip.js#buildTooltipModel`'s lines
 * 440-462 — that function is the original and this is deliberately NOT a
 * second opinion; it exists only because `buildTooltipModel` also builds the
 * whole stat model (and its height plan), which a label has no use for.
 * `tests/ui/ui11.test.js` asserts the two agree on a fixture set, so a
 * future edit to either cannot silently diverge.
 *
 * @param {object} item
 * @param {object|null} base - `items.base(item.baseId)`
 * @param {string|null} uniqueName - `items.unique(item.uniqueId).name`
 * @param {'en'|'ru'} lang
 * @returns {string}
 */
export function resolveGroundLabelName(item, base, uniqueName, lang) {
  const rarity = item.rarity || 'normal';
  const isUnidentified = (rarity === 'rare' || rarity === 'unique') && item.identified === false;
  const baseName = base ? base.name : (item._cache && item._cache.displayName) || item.baseId;
  if (isUnidentified) return baseName;
  if (item.uniqueId && uniqueName) return uniqueName;
  if (item.nameOverride && typeof item.nameOverride === 'object') {
    return item.nameOverride[lang === 'ru' ? 'ru' : 'en'] || item.nameOverride.en || baseName;
  }
  if (typeof item.nameOverride === 'string' && item.nameOverride) return item.nameOverride;
  return (item._cache && item._cache.displayName) || baseName;
}

/**
 * `09 §9.3`'s priority formula, verbatim:
 *   `RARITY_ORDER.indexOf(rarity) * 10000 + (unidentified ? 4000 : 0)
 *    + (freshDrop ? 2000 : 0) - distanceToPlayerMetres * 40`
 * @returns {number}
 */
export function labelPriority(rarity, unidentified, freshDrop, distanceMetres) {
  const rank = RARITY_RANK[rarity] === undefined ? 0 : RARITY_RANK[rarity];
  return rank * 10000 + (unidentified ? 4000 : 0) + (freshDrop ? 2000 : 0) - distanceMetres * 40;
}

/**
 * `09 §9.4`'s four upward relaxation passes, extracted as a pure function so
 * the decluttering can be tested without a DOM. Operates IN PLACE on
 * caller-owned typed arrays and allocates nothing.
 *
 * Rects are `[x - w/2, y - h]`-anchored (a label is centred on its item's
 * projected x and sits with its bottom edge at `y`). `order` must already be
 * the ascending-`y` order; §9.4 step 2 is the caller's, so a caller that
 * already has a sorted list does not pay for it twice.
 *
 * @param {Float64Array} x - centre x per label
 * @param {Float64Array} y - BOTTOM edge y per label (mutated)
 * @param {Float64Array} w - width per label
 * @param {Float64Array} h - height per label
 * @param {Float64Array} y0 - the pre-relaxation bottom edge, read-only; the
 *   displacement test at the end measures against it.
 * @param {Int32Array} order - indices, ascending y
 * @param {number} n - live count
 * @param {number} topLimit - the viewport's top edge (§9.4 step 4)
 * @returns {number} how many labels ended up displaced by more than
 *   `LABEL_STEM_THRESHOLD` px (i.e. how many get a stem, §9.4's last line).
 */
export function relaxLabels(x, y, w, h, y0, order, n, topLimit) {
  for (let pass = 0; pass < LABEL_RELAX_PASSES; pass++) {
    // §9.4 step 2 sorts ascending y, but step 3's own formula ("move it up by
    // `overlap + 4`") only separates two rects when the label being moved is
    // the one ABOVE the one it hit: with a bottom-edge anchor, moving the
    // upper label up by `overlap + 4` lands its bottom exactly 4 px above the
    // lower label's top — exactly the intended gap — whereas moving the LOWER
    // label up by the same amount drives it further into the upper one and
    // diverges (measured: 15 labels in a 2 m drop left 6 pairs still
    // intersecting after all four passes). So the array is sorted ascending
    // per step 2 and walked from the BOTTOM up here: the lowest label — the
    // one nearest the player — holds its position, and everything above it
    // stacks upward, which is also what step 3's "upward, because the item is
    // below the label" is describing. Recorded as this ticket's reading of
    // §9.4 in its report.
    for (let a = n - 2; a >= 0; a--) {
      const ia = order[a];
      const ax0 = x[ia] - w[ia] * 0.5;
      const ax1 = ax0 + w[ia];
      // Each label is resolved against ALL of its colliders at once, and then
      // re-checked, rather than against one collider at a time: a single move
      // that clears the highest of them can still land on another, and a
      // one-at-a-time walk leaves that unresolved (measured: 1 full 22 px
      // overlap left in the 15-item drop). `guard` bounds the walk: inserting
      // into a full stack costs at most one move per label going up, and — if
      // step 4's ceiling turns the walk around — one per label coming back
      // down, so `2n + 2` is the ceiling and anything less truncates the walk
      // mid-stack (measured: at `n`, one label stopped exactly on top of
      // another at y = 301).
      // §9.4 step 4 sends a label that would leave the top of the viewport
      // DOWN instead. Once that has happened the label may not go back up, or
      // it ping-pongs against the same ceiling forever (measured: three 22 px
      // overlaps left over at 16 labels) — it keeps descending past whatever
      // it lands on, and its stem is drawn upward.
      let forcedDown = false;
      for (let guard = 0; guard < 2 * n + 2; guard++) {
        let hit = false;
        let highestTop = Infinity;
        let lowestBottom = -Infinity;
        for (let b = a + 1; b < n; b++) {
          const ib = order[b];
          const bx0 = x[ib] - w[ib] * 0.5;
          const bx1 = bx0 + w[ib];
          if (ax1 <= bx0 || ax0 >= bx1) continue;
          // Vertical overlap of [y-h, y] against [y-h, y].
          const overlap = Math.min(y[ia], y[ib]) - Math.max(y[ia] - h[ia], y[ib] - h[ib]);
          if (overlap <= 0) continue;
          hit = true;
          const bTop = y[ib] - h[ib];
          if (bTop < highestTop) highestTop = bTop;
          if (y[ib] > lowestBottom) lowestBottom = y[ib];
        }
        if (!hit) break;
        // §9.4 step 3: move UP by `overlap + 4` — which, against the collider
        // whose top is highest, is exactly "bottom edge 4 px above that top".
        // §9.4 step 5: never sideways.
        const moved = highestTop - 4;
        // §9.4 step 4: if that would leave the top of the viewport, go DOWN
        // past the colliding GROUP instead (below its lowest bottom edge, not
        // merely below one member of it), and the stem is drawn upward.
        if (forcedDown || moved - h[ia] < topLimit) {
          forcedDown = true;
          y[ia] = lowestBottom + h[ia] + 4;
        } else {
          y[ia] = moved;
        }
      }
    }
  }
  let stems = 0;
  for (let i = 0; i < n; i++) {
    const idx = order[i];
    if (Math.abs(y[idx] - y0[idx]) > LABEL_STEM_THRESHOLD) stems++;
  }
  return stems;
}

// ---------------------------------------------------------------------------

export class Minimap {
  /**
   * @param {object} ctx
   * @param {object} container - `layers.hud` (`09 §3.4`'s z30 chrome band:
   *   "plinth, orbs, hotbar, belt, XP, target bar, minimap, tracker, buffs").
   *   The ground labels belong to §3.4's z20 `.cl2-l-world` band, which this
   *   codebase's 8-layer stack (`./style.js#LAYER_NAMES`) does not have; they
   *   are attached to the same `hud` layer, below the panels, and the
   *   deviation is recorded in this ticket's report rather than by
   *   restructuring a layer stack ten accepted modules already sit on.
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} rng - the one `ui` fork; unused here (nothing on this
   *   surface jitters) but taken for the same one-fork-per-subsystem reason
   *   every sibling module documents.
   * @param {(() => void)|null} armPointerSwallow - `./index.js`'s O-78 hook.
   *   §9.5 needs a label click to be invisible to `player`'s click-to-move;
   *   `stopPropagation()` alone only stops listeners further along the
   *   dispatch, and `player` reads a LATCHED input snapshot (`_latchIntent`,
   *   `src/player/index.js:1235`) rather than listening for the same event.
   *   So the handler also arms O-78's swallow window directly — the one
   *   mechanism `player` actually consults.
   */
  constructor(ctx, container, translate, rng, armPointerSwallow) {
    this._ctx = ctx;
    this._layer = container;
    this._t = translate || ((k) => k);
    this._rng = rng || null;
    this._armSwallow = typeof armPointerSwallow === 'function' ? armPointerSwallow : null;

    this._visible = false;
    this._cornerSuppressed = false;
    this._altHeld = false;
    this._lootLabels = false; // SettingsSave.alwaysShowLoot
    this._overlayOpen = false;
    this._lang = 'en';

    this._vw = (ctx && ctx.canvas && ctx.canvas.width) || 1280;
    this._vh = (ctx && ctx.canvas && ctx.canvas.height) || 720;
    this._dpr = 1;

    // ── the bake ────────────────────────────────────────────────────────
    this._bakedNavVersion = -1;
    this._bakeW = 0;          // in cells
    this._bakeH = 0;
    this._bakeOriginX = 0;
    this._bakeOriginZ = 0;
    this._bakeCellSize = 0.5;
    this._cellClass = null;   // Uint8Array(w*h)
    this._bakePixels = null;  // Uint8ClampedArray(pw*ph*4)
    this._bakeCanvas = null;
    this._bake2d = null;
    this._bakeCount = 0;      // how many bakes have happened — the U11 acceptance clause reads this
    this._outlineCount = 0;

    // ── the fog ─────────────────────────────────────────────────────────
    this._fog = null;         // Uint8Array(w*h), 0 unexplored / 1 explored
    this._fogCanvas = null;
    this._fog2d = null;
    this._fogAccum = 0;
    this._fogStamps = 0;
    this._exploredCells = 0;

    // ── scratch, all preallocated (ARCHITECTURE.md rule 6) ──────────────
    this._scratchVec3 = new THREE.Vector3();
    this._groundOut = new Array(GROUND_SWEEP_CAP);
    for (let i = 0; i < GROUND_SWEEP_CAP; i++) this._groundOut[i] = null;
    this._groundCount = 0;

    this._candIndex = new Int32Array(GROUND_SWEEP_CAP);
    this._candPriority = new Float64Array(GROUND_SWEEP_CAP);
    this._candCount = 0;

    this._lx = new Float64Array(LABEL_BUDGET);
    this._ly = new Float64Array(LABEL_BUDGET);
    this._lw = new Float64Array(LABEL_BUDGET);
    this._lh = new Float64Array(LABEL_BUDGET);
    this._ly0 = new Float64Array(LABEL_BUDGET); // pre-relaxation y, for the stem test
    this._lorder = new Int32Array(LABEL_BUDGET);
    this._liveCount = 0;
    this._stemCount = 0;
    this._overflowCount = 0;

    this._sortAccum = 0;
    this._pointerX = -1;
    this._pointerY = -1;
    this._chipWorldX = 0; // §9.3's chip sits at the centroid of the REMAINDER,
    this._chipWorldY = 0; // computed in world space on the 10 Hz tick and
    this._chipWorldZ = 0; //
    this._chipLive = false; // projected (once) per frame like any other label.
    this._chipRarity = 'normal';
    this._labelCap = LABEL_BUDGET; // drops to 15 while the chip borrows a slot

    // Custom markers (`02-api-contracts.md`:1302 `minimapMarker`).
    this._markerId = new Int32Array(CUSTOM_MARKER_CAP);
    this._markerX = new Float64Array(CUSTOM_MARKER_CAP);
    this._markerZ = new Float64Array(CUSTOM_MARKER_CAP);
    this._markerKind = new Array(CUSTOM_MARKER_CAP);
    this._markerUsed = new Uint8Array(CUSTOM_MARKER_CAP);
    for (let i = 0; i < CUSTOM_MARKER_CAP; i++) this._markerKind[i] = null;

    // Marker-pass state, read by the bound monster callback below.
    this._drawG = null;
    this._drawW = 0;
    this._drawH = 0;
    this._drawPxPerM = 1;
    this._drawCX = 0;
    this._drawCZ = 0;
    this._monsterMarkers = 0;
    // `09 §4.7`: "then <= 48 marker blits". A hard per-view budget, not an
    // estimate — a floor covered in 200 dropped items would otherwise blow it.
    this._passLeft = 0;
    this._markerBlits = 0;

    // Bound once, never per frame — `actors.forEachInRadius` takes a callback
    // and a fresh arrow function there would be a per-frame allocation.
    this._drawMonster = (actor) => this._drawMonsterMarker(actor);

    this._onNavRebuilt = (payload) => this._maybeBake(payload && payload.navVersion);
    this._onZoneReady = (payload) => {
      this._zoneDirty = true;
      this._maybeBake(payload && payload.navVersion);
    };
    this._onPointerMove = (e) => {
      this._pointerX = e && typeof e.clientX === 'number' ? e.clientX : this._pointerX;
      this._pointerY = e && typeof e.clientY === 'number' ? e.clientY : this._pointerY;
    };
    this._zoneDirty = true;

    this._buildDom();
    this._bindEvents(ctx);
  }

  // =====================================================================
  // DOM
  // =====================================================================

  _buildDom() {
    injectMinimapStyle(this._layer && this._layer.ownerDocument ? this._layer.ownerDocument : undefined);

    // §13.1's minimap row: "6 | canvas, frame, 4 brackets (gradient) + labels".
    // The 4 corner brackets are one node's `background` (the same node-saving
    // trick §13.1 names for the inventory lattice and the XP ticks), so the 6
    // are: container, frame, canvas, N label, zone label, overlay canvas.
    this._root = el('div', 'cl2-mm');
    setStyle(this._root, 'display', 'none');
    place(this._root, CORNER_X, CORNER_Y);
    setStyle(this._root, 'opacity', String(CORNER_OPACITY));

    this._frame = el('div', 'cl2-mm-frame');
    this._root.appendChild(this._frame);

    this._canvas = el('canvas', 'cl2-mm-canvas');
    this._canvas.width = CORNER_SIZE;
    this._canvas.height = CORNER_SIZE;
    setStyle(this._canvas, 'width', CORNER_SIZE + 'px');
    setStyle(this._canvas, 'height', CORNER_SIZE + 'px');
    this._root.appendChild(this._canvas);
    this._2d = typeof this._canvas.getContext === 'function' ? this._canvas.getContext('2d') : null;

    this._northEl = el('div', 'cl2-mm-n');
    setText(this._northEl, this._tOr('minimap.north', 'N'));
    this._root.appendChild(this._northEl);

    this._zoneEl = el('div', 'cl2-mm-zone');
    this._root.appendChild(this._zoneEl);

    this._overlay = el('canvas', 'cl2-mm-overlay');
    this._overlay.width = OVERLAY_W;
    this._overlay.height = OVERLAY_H;
    setStyle(this._overlay, 'width', OVERLAY_W + 'px');
    setStyle(this._overlay, 'height', OVERLAY_H + 'px');
    setStyle(this._overlay, 'display', 'none');
    setStyle(this._overlay, 'opacity', String(OVERLAY_ALPHA));
    this._root.appendChild(this._overlay);
    this._overlay2d = typeof this._overlay.getContext === 'function' ? this._overlay.getContext('2d') : null;

    if (this._layer && typeof this._layer.appendChild === 'function') this._layer.appendChild(this._root);

    // ── ground labels (§9) ──────────────────────────────────────────────
    // `09 §13.1`'s ground-label row is "48 | 16 pooled entries × 3 (plate,
    // text, disc)" — a HARD cap, and 48 is exactly 16 × 3 with nothing left
    // over. So there is no wrapper node (the entries attach straight to the
    // layer) and no dedicated chip subtree: §9.3's overflow chip BORROWS the
    // last pool entry. See `_assignEntries` for what that costs.
    this._entries = new Array(LABEL_BUDGET);
    for (let i = 0; i < LABEL_BUDGET; i++) {
      const plate = el('div', 'cl2-gl cl2-gl-normal');
      const text = el('div', 'cl2-gl-t');
      plate.appendChild(text);
      const disc = el('div', 'cl2-gl-d');
      // O-78 (`09 §11.4` point 1): what `pointerOverUi`'s guard hit-tests
      // with `closest('[data-ui-solid]')`. A ground label is the one
      // world-anchored solid thing in the whole overlay (`09 §9`'s opening
      // line), so it must carry the attribute the guard looks for.
      if (typeof plate.setAttribute === 'function') plate.setAttribute('data-ui-solid', '');
      if (typeof disc.setAttribute === 'function') disc.setAttribute('data-ui-solid', '');
      if (this._layer && typeof this._layer.appendChild === 'function') {
        this._layer.appendChild(plate);
        this._layer.appendChild(disc);
      }

      const entry = {
        plate, text, disc,
        item: null, uid: 0, rarity: 'normal',
        name: '', width: 0, lines: 1, slot: -1, stemPx: -1,
        fade: 0, dying: false, stem: false, shown: false, isChip: false,
      };
      // §9.5: `pointerdown` on either node picks the item up and
      // `stopPropagation()`s so the click is never ALSO a move order.
      const onDown = (e) => this._onLabelPointerDown(entry, e);
      entry.onDown = onDown;
      bindPointerDown(plate, onDown);
      bindPointerDown(disc, onDown);
      this._entries[i] = entry;
    }
  }

  /** `t()` with a literal fallback: `./i18n.js` is another ticket's file and
   * carries none of this module's keys yet, so every lookup here would render
   * as `[missing]<key>` on screen. Same `[`-sentinel test `_refreshZoneName`
   * already used for the zone name. */
  _tOr(key, fallback, params) {
    const s = this._t(key, params);
    if (typeof s !== 'string' || s.charCodeAt(0) === 91 /* '[' */) return fallback;
    return s;
  }

  _bindEvents(ctx) {
    if (ctx && ctx.events && typeof ctx.events.on === 'function') {
      ctx.events.on('nav:rebuilt', this._onNavRebuilt);
      ctx.events.on('zone:ready', this._onZoneReady);
    }
    const doc = this._root && this._root.ownerDocument;
    this._doc = doc && typeof doc.addEventListener === 'function' ? doc : null;
    if (this._doc) this._doc.addEventListener('pointermove', this._onPointerMove, true);
  }

  // =====================================================================
  // Public surface (driven from `./index.js`)
  // =====================================================================

  /** Chrome, not a modal — shown only on the `game` screen, the same gating
   * every sibling HUD module takes. */
  setVisible(on) {
    const next = !!on;
    if (this._visible === next) return;
    this._visible = next;
    setStyle(this._root, 'display', next && !this._cornerSuppressed ? 'block' : 'none');
    if (!next) this._releaseAllLabels();
  }

  /** @returns {boolean} */
  isVisible() {
    return this._visible;
  }

  /** `09 §4.7`: the corner map is "hidden while a `left`-zone panel is open" —
   * every `left` panel is anchored at (24, 24), exactly where it sits (`09
   * §3.3`'s table). Only the CORNER chrome hides: the ground labels are §9's
   * own surface, they are world-anchored, and a panel at the screen's left
   * edge is no reason to stop labelling loot. */
  setCornerSuppressed(on) {
    const next = !!on;
    if (this._cornerSuppressed === next) return;
    this._cornerSuppressed = next;
    setStyle(this._root, 'display', this._visible && !next ? 'block' : 'none');
  }

  /** `09 §11.2`'s `M` (`toggle_minimap`) — the corner map on/off. `ui` may not
   * read `ctx.input` (`09 §16.1`), so the key itself is `player`'s job; this is
   * the method it calls, through `./index.js#toggleMinimap`. */
  toggleCorner() {
    this.setVisible(!this._visible);
  }

  /** `02-api-contracts.md` §14 `setAltHeld` — §9.2 rule 3. Forces the next
   * frame to re-sort rather than waiting out the 10 Hz tick: Alt is held and
   * released inside 100 ms often enough that the lag would read as a bug. */
  setAltHeld(on) {
    const next = !!on;
    if (this._altHeld === next) return;
    this._altHeld = next;
    this._sortAccum = LABEL_SORT_PERIOD_S;
  }

  /** `02-api-contracts.md`:1289 `setLootLabels(on)` — §9.2 rule 4, the
   * settings-driven override. */
  setLootLabels(on) {
    const next = !!on;
    if (this._lootLabels === next) return;
    this._lootLabels = next;
    this._sortAccum = LABEL_SORT_PERIOD_S;
  }

  /** `02-api-contracts.md`:1301 `setMinimapOpen(on)` — `09 §4.7`'s overlay
   * mode, the `Tab` map. `ui` may not read `ctx.input` itself (`09 §16.1`),
   * so the key binding is `player`'s job; this is the method it calls. */
  setMinimapOpen(on) {
    const next = !!on;
    if (this._overlayOpen === next) return;
    this._overlayOpen = next;
    setStyle(this._overlay, 'display', next ? 'block' : 'none');
    if (next) this._placeOverlay();
  }

  /** The overlay is "centred" on the VIEWPORT (`09 §4.7`), but it is a child of
   * the corner map's root, which `place()` has already translated to (24, 24) —
   * so the centring is arithmetic, in this node's own coordinates. Computed,
   * never measured (D-B: `ui` never reads layout), and only when the viewport
   * actually changes. */
  _placeOverlay() {
    place(this._overlay, (this._vw - OVERLAY_W) * 0.5 - CORNER_X, (this._vh - OVERLAY_H) * 0.5 - CORNER_Y);
  }

  /** @returns {boolean} */
  isMinimapOpen() {
    return this._overlayOpen;
  }

  /** `02-api-contracts.md`:1302 `minimapMarker(id, x, z, kind)`. */
  minimapMarker(id, x, z, kind) {
    let slot = -1;
    for (let i = 0; i < CUSTOM_MARKER_CAP; i++) {
      if (this._markerUsed[i] && this._markerId[i] === id) { slot = i; break; }
    }
    if (slot < 0) {
      for (let i = 0; i < CUSTOM_MARKER_CAP; i++) if (!this._markerUsed[i]) { slot = i; break; }
    }
    if (slot < 0) return;
    this._markerUsed[slot] = 1;
    this._markerId[slot] = id;
    this._markerX[slot] = x;
    this._markerZ[slot] = z;
    this._markerKind[slot] = kind;
  }

  /** `02-api-contracts.md`:1303 `clearMinimapMarker(id)`. */
  clearMinimapMarker(id) {
    for (let i = 0; i < CUSTOM_MARKER_CAP; i++) {
      if (this._markerUsed[i] && this._markerId[i] === id) {
        this._markerUsed[i] = 0;
        this._markerKind[i] = null;
        return;
      }
    }
  }

  setLanguage(lang) {
    this._lang = lang === 'ru' ? 'ru' : 'en';
    this._zoneDirty = true;
    setText(this._northEl, this._tOr('minimap.north', 'N'));
    // Force the label pool to re-resolve its names on the next sort tick.
    for (let i = 0; i < LABEL_BUDGET; i++) this._entries[i].uid = 0;
  }

  // =====================================================================
  // The bake — once per `nav:rebuilt` (`09 §15` U11's acceptance clause)
  // =====================================================================

  _maybeBake(navVersion) {
    const nav = safeGet(this._ctx, 'nav');
    const grid = nav && nav.grid;
    if (!grid || !grid.flags) return false;
    const version = typeof navVersion === 'number' ? navVersion : (grid.version || 0);
    // `src/nav/index.js`: version 0 is the "never rebuilt" sentinel — the
    // all-blocked placeholder grid `NavSystem` constructs before any zone
    // exists. Baking it would put a bake on the counter that no `nav:rebuilt`
    // ever paid for, which is exactly what `09 §15` U11's acceptance clause
    // ("rebakes exactly once per `nav:rebuilt`") is counting.
    if (version === 0 || version === this._bakedNavVersion) return false;
    this._bakedNavVersion = version;
    this._bake(grid);
    return true;
  }

  /**
   * `09 §4.7` step 1: rasterise `nav.grid.flags` ONCE into an offscreen canvas
   * at 2 px per 0.5 m cell, plus the 1 px outline pass comparing each cell to
   * its right/down neighbour. Also resets the fog (§4.7 step 2) — a new zone
   * is unexplored.
   * @param {object} grid - `nav.grid`
   */
  _bake(grid) {
    const w = grid.width | 0;
    const h = grid.height | 0;
    if (w <= 0 || h <= 0) return;

    this._bakeW = w;
    this._bakeH = h;
    this._bakeOriginX = grid.originX;
    this._bakeOriginZ = grid.originZ;
    this._bakeCellSize = grid.cellSize || 0.5;

    const cells = w * h;
    if (this._cellClass === null || this._cellClass.length < cells) this._cellClass = new Uint8Array(cells);
    if (this._fog === null || this._fog.length < cells) this._fog = new Uint8Array(cells);
    this._fog.fill(0, 0, cells);
    this._exploredCells = 0;

    // Pass 1 — classify. `09 §4.7`: walkable `--ash-600`, blocked transparent,
    // doorway `--ash-500`, hazard `#4a2418`, water `#1a2630`. Precedence is
    // most-specific-first: a hazard cell that is also walkable reads as hazard.
    const flags = grid.flags;
    const cls = this._cellClass;
    for (let i = 0; i < cells; i++) {
      const f = flags[i];
      if ((f & NAV_WALKABLE) === 0) { cls[i] = CLS_BLOCKED; continue; }
      if (f & NAV_HAZARD) cls[i] = CLS_HAZARD;
      else if (f & NAV_WATER) cls[i] = CLS_WATER;
      else if (f & NAV_DOORWAY) cls[i] = CLS_DOORWAY;
      else cls[i] = CLS_WALKABLE;
    }

    this._bakeCount++;
    this._paintBake(w, h, cls);
    this._prepareFogCanvas(w, h);
  }

  /**
   * Turns `_cellClass` into pixels. Split from `_bake` because the Node DOM
   * shim's `<canvas>` has no `getContext` — under `node --test` this is a
   * no-op and the classification above is still real. See the file header.
   */
  _paintBake(w, h, cls) {
    const pw = w * BAKE_PX_PER_CELL;
    const ph = h * BAKE_PX_PER_CELL;
    if (!this._bakeCanvas) {
      this._bakeCanvas = el('canvas', 'cl2-mm-bake');
      this._bake2d = typeof this._bakeCanvas.getContext === 'function' ? this._bakeCanvas.getContext('2d') : null;
    }
    this._bakeCanvas.width = pw;
    this._bakeCanvas.height = ph;
    const g = this._bake2d;

    // The outline pass runs whether or not there is a 2D context — it is the
    // second half of the classification (`09 §4.7`: "a single pass comparing
    // each cell to its right/down neighbour") and `_outlineCount` is what a
    // headless test asserts against.
    let outline = 0;
    for (let cz = 0; cz < h; cz++) {
      for (let cx = 0; cx < w; cx++) {
        const i = cz * w + cx;
        if (cls[i] === CLS_BLOCKED) continue;
        if (cx + 1 >= w || cls[i + 1] === CLS_BLOCKED) outline++;
        if (cz + 1 >= h || cls[i + w] === CLS_BLOCKED) outline++;
      }
    }
    this._outlineCount = outline;
    if (!g || typeof g.fillRect !== 'function') return;

    g.clearRect(0, 0, pw, ph);
    // Fill by class, one `fillStyle` write per class rather than per cell.
    for (let k = CLS_WALKABLE; k <= CLS_WATER; k++) {
      g.fillStyle = k === CLS_WALKABLE ? C_WALKABLE : k === CLS_DOORWAY ? C_DOORWAY : k === CLS_HAZARD ? C_HAZARD : C_WATER;
      for (let cz = 0; cz < h; cz++) {
        for (let cx = 0; cx < w; cx++) {
          if (cls[cz * w + cx] !== k) continue;
          g.fillRect(cx * BAKE_PX_PER_CELL, cz * BAKE_PX_PER_CELL, BAKE_PX_PER_CELL, BAKE_PX_PER_CELL);
        }
      }
    }
    g.fillStyle = C_OUTLINE;
    for (let cz = 0; cz < h; cz++) {
      for (let cx = 0; cx < w; cx++) {
        const i = cz * w + cx;
        if (cls[i] === CLS_BLOCKED) continue;
        const px = cx * BAKE_PX_PER_CELL;
        const py = cz * BAKE_PX_PER_CELL;
        if (cx + 1 >= w || cls[i + 1] === CLS_BLOCKED) g.fillRect(px + BAKE_PX_PER_CELL - 1, py, 1, BAKE_PX_PER_CELL);
        if (cz + 1 >= h || cls[i + w] === CLS_BLOCKED) g.fillRect(px, py + BAKE_PX_PER_CELL - 1, BAKE_PX_PER_CELL, 1);
      }
    }
  }

  /** `09 §4.7` step 2's composited `--void` layer, as one offscreen canvas the
   * fog stamp punches holes in. */
  _prepareFogCanvas(w, h) {
    const pw = w * BAKE_PX_PER_CELL;
    const ph = h * BAKE_PX_PER_CELL;
    if (!this._fogCanvas) {
      this._fogCanvas = el('canvas', 'cl2-mm-fog');
      this._fog2d = typeof this._fogCanvas.getContext === 'function' ? this._fogCanvas.getContext('2d') : null;
    }
    this._fogCanvas.width = pw;
    this._fogCanvas.height = ph;
    const g = this._fog2d;
    if (!g || typeof g.fillRect !== 'function') return;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, pw, ph);
    g.globalAlpha = FOG_UNEXPLORED_ALPHA;
    g.fillStyle = C_VOID;
    g.fillRect(0, 0, pw, ph);
    g.globalAlpha = 1;
  }

  /**
   * `09 §4.7` step 2: at 4 Hz, stamp a filled disc of radius 22 m around the
   * player into the explored mask. Called from `update`, never per frame.
   */
  _stampFog(px, pz) {
    if (!this._cellClass || this._bakeW === 0) return;
    const cs = this._bakeCellSize;
    const w = this._bakeW;
    const h = this._bakeH;
    const cx = (px - this._bakeOriginX) / cs;
    const cz = (pz - this._bakeOriginZ) / cs;
    const rCells = FOG_RADIUS_M / cs;
    const rr = rCells * rCells;
    const x0 = Math.max(0, Math.floor(cx - rCells));
    const x1 = Math.min(w - 1, Math.ceil(cx + rCells));
    const z0 = Math.max(0, Math.floor(cz - rCells));
    const z1 = Math.min(h - 1, Math.ceil(cz + rCells));
    const fog = this._fog;
    let gained = 0;
    for (let z = z0; z <= z1; z++) {
      const dz = z + 0.5 - cz;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dz * dz > rr) continue;
        const i = z * w + x;
        if (fog[i]) continue;
        fog[i] = 1;
        gained++;
      }
    }
    this._exploredCells += gained;
    this._fogStamps++;

    const g = this._fog2d;
    if (!g || typeof g.arc !== 'function') return;
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(cx * BAKE_PX_PER_CELL, cz * BAKE_PX_PER_CELL, rCells * BAKE_PX_PER_CELL, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }

  /** @returns {boolean} whether the world cell under `(x, z)` has been seen. */
  _explored(x, z) {
    if (!this._fog || this._bakeW === 0) return false;
    const cs = this._bakeCellSize;
    const cx = Math.floor((x - this._bakeOriginX) / cs);
    const cz = Math.floor((z - this._bakeOriginZ) / cs);
    if (cx < 0 || cz < 0 || cx >= this._bakeW || cz >= this._bakeH) return false;
    return this._fog[cz * this._bakeW + cx] === 1;
  }

  // =====================================================================
  // Per-frame — `09 §4.7`: one blit, one fog blit, <= 48 marker blits.
  // =====================================================================

  update(dt, ctx) {
    if (!this._visible) return;
    const c = ctx || this._ctx;
    this._syncViewport(c);

    const playerSys = safeGet(c, 'player');
    const actor = (playerSys && playerSys.actor) || null;
    if (!actor) return;

    const px = actor.renderX || actor.x || 0;
    const pz = actor.renderZ || actor.z || 0;

    // A zone that became ready before this module existed (or a nav rebuild
    // that fired while `ui` was still booting) still gets its bake.
    if (this._bakedNavVersion < 0) this._maybeBake(undefined);

    // §4.7 step 2 — 4 Hz, not per frame.
    this._fogAccum += dt;
    if (this._fogAccum >= FOG_PERIOD_S) {
      this._fogAccum = 0;
      this._stampFog(px, pz);
    }

    // §9.3 — "Sorting runs at 10 Hz, not per frame; positions update every
    // frame." The same tick refreshes the ground sweep the minimap's item
    // markers also read.
    this._sortAccum += dt;
    if (this._sortAccum >= LABEL_SORT_PERIOD_S) {
      this._sortAccum = 0;
      this._refreshCandidates(c, px, pz);
    }

    if (this._zoneDirty) this._refreshZoneName(c);

    this._renderCorner(c, actor, px, pz);
    if (this._overlayOpen) this._renderOverlay(c, actor, px, pz);
    this._updateLabels(dt, c, px, pz);
  }

  _syncViewport(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw;
    this._vh = vh;
    this._placeOverlay();
  }

  _refreshZoneName(ctx) {
    const world = safeGet(ctx, 'world');
    const zone = world && world.current;
    if (!zone) return;
    this._zoneDirty = false;
    const key = 'zone.' + zone.zoneId;
    let name = this._t(key);
    if (name.charCodeAt(0) === 91 /* '[' — `[missing]<key>` */) {
      name = (zone.descriptor && zone.descriptor.displayName) || zone.zoneId;
    }
    setText(this._zoneEl, name);
  }

  // ── the shared map render ────────────────────────────────────────────

  /**
   * Draws one view of the map: the baked layer, the fog, then the markers.
   * Both the corner map and the `Tab` overlay call this — one code path, two
   * geometries, so the two can never disagree about what a portal looks like.
   * Allocates nothing.
   */
  _renderMap(g, canvasW, canvasH, pxPerM, centreX, centreZ, ctx, actor, px, pz, drawPlayer) {
    if (!g || typeof g.clearRect !== 'function') return;
    g.clearRect(0, 0, canvasW, canvasH);

    if (this._bakeW > 0) {
      // North-up, never rotated (`09 §4.7`). The source rect is the window
      // around `centre`, in baked pixels (4 px per metre at cellSize 0.5).
      const pxPerCell = BAKE_PX_PER_CELL;
      const bakePxPerM = pxPerCell / this._bakeCellSize;
      const sw = (canvasW / pxPerM) * bakePxPerM;
      const sh = (canvasH / pxPerM) * bakePxPerM;
      const sx = (centreX - this._bakeOriginX) * bakePxPerM - sw * 0.5;
      const sy = (centreZ - this._bakeOriginZ) * bakePxPerM - sh * 0.5;
      if (typeof g.drawImage === 'function') {
        g.drawImage(this._bakeCanvas, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
        if (this._fogCanvas) g.drawImage(this._fogCanvas, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
      }
    }

    this._drawG = g;
    this._drawW = canvasW;
    this._drawH = canvasH;
    this._drawPxPerM = pxPerM;
    this._drawCX = centreX;
    this._drawCZ = centreZ;
    // `09 §4.7`'s "<= 48 marker blits", in the table's own paint order.
    this._markerBlits = 0;

    this._beginMarkerPass(MARKER_QUOTA_ITEM);
    this._drawGroundItemMarkers();
    this._beginMarkerPass(MARKER_QUOTA_ZONE);
    this._drawZoneMarkers(ctx);
    this._monsterMarkers = 0;
    this._beginMarkerPass(MARKER_QUOTA_MONSTER);
    const actors = safeGet(ctx, 'actors');
    if (actors && typeof actors.forEachInRadius === 'function') {
      actors.forEachInRadius(px, pz, MONSTER_REVEAL_M, TEAM_MONSTER, this._drawMonster);
    }
    this._beginMarkerPass(MARKER_QUOTA_CUSTOM);
    this._drawCustomMarkers();
    if (drawPlayer) {
      this._beginMarkerPass(1); // the reserved blit — the player is never dropped
      this._drawPlayerMarker(actor, px, pz);
    }
    this._drawG = null;
  }

  _mapX(worldX) {
    return this._drawW * 0.5 + (worldX - this._drawCX) * this._drawPxPerM;
  }

  _mapY(worldZ) {
    return this._drawH * 0.5 + (worldZ - this._drawCZ) * this._drawPxPerM;
  }

  _onMap(x, y) {
    return x >= 0 && y >= 0 && x <= this._drawW && y <= this._drawH;
  }

  /**
   * Opens one marker pass with its own share of the frame's 48 blits.
   *
   * `09 §4.7` states the per-frame cost as "<= 48 marker blits" and never says
   * what to drop when a floor holds more markers than that — but a single
   * global budget claimed in paint order would let 200 dropped items starve
   * every monster and the player arrow, which is plainly not what a map is
   * for. So the cap is split per kind (`MARKER_QUOTA`, summing to 47 + the
   * reserved player blit), lowest-information kind first. ASSIGNED, and
   * flagged as an assignment in this ticket's report.
   */
  _beginMarkerPass(quota) {
    const globalLeft = MARKER_BLIT_CAP - this._markerBlits;
    this._passLeft = quota < globalLeft ? quota : globalLeft;
  }

  /** Claims one of the frame's ≤ 48 marker blits. @returns {boolean} */
  _claimBlit() {
    if (this._passLeft <= 0) return false;
    this._passLeft--;
    this._markerBlits++;
    return true;
  }

  /** §4.7's marker table, "ground item | 3 px square | its rarity colour". */
  _drawGroundItemMarkers() {
    const g = this._drawG;
    for (let i = 0; i < this._groundCount; i++) {
      const item = this._groundOut[i];
      if (!item || !item.ground) continue;
      const x = this._mapX(item.ground.x);
      const y = this._mapY(item.ground.z);
      if (!this._onMap(x, y)) continue;
      if (!this._claimBlit()) return;
      g.fillStyle = RARITY_HEX[item.rarity] || RARITY_HEX.normal;
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }

  /** Chests, portals and NPC interactables, from `world.current`. */
  _drawZoneMarkers(ctx) {
    const g = this._drawG;
    const world = safeGet(ctx, 'world');
    const zone = world && world.current;
    if (!zone) return;

    const chests = zone.chests;
    if (chests) {
      g.strokeStyle = C_GILT;
      g.lineWidth = 1;
      for (let i = 0; i < chests.length; i++) {
        const c = chests[i];
        if (c.opened) continue;
        const x = this._mapX(c.x);
        const y = this._mapY(c.z);
        if (!this._onMap(x, y)) continue;
        if (!this._claimBlit()) break;
        g.strokeRect(x - 2.5, y - 2.5, 5, 5); // 5 px square, hollow
      }
    }

    const inter = zone.interactables;
    if (!inter) return;
    for (let i = 0; i < inter.length; i++) {
      const it = inter[i];
      // A `chest` interactable duplicates `zone.chests` above, and §4.7's
      // table has no glyph for anything else — so only NPCs and portals get
      // a blit, and nothing else even claims one.
      const isNpc = !!it.npcId;
      if (!isNpc && it.kind !== 'portal' && it.kind !== 'exit') continue;
      const x = this._mapX(it.x);
      const y = this._mapY(it.z);
      if (!this._onMap(x, y)) continue;
      if (!this._claimBlit()) return;
      if (isNpc) {
        // 5 px diamond, --verdigris
        g.fillStyle = C_VERDIGRIS;
        this._diamond(g, x, y, 2.5, true);
      } else {
        // 7 px ring, --property
        g.strokeStyle = C_PROPERTY;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(x, y, 3.5, 0, Math.PI * 2);
        g.stroke();
      }
    }
  }

  /** §4.7: "Monsters are drawn only inside the explored mask and only within
   * 46 m — `ui` does not give away an unexplored pack." */
  _drawMonsterMarker(actor) {
    const g = this._drawG;
    if (!g || !actor || actor.dead) return;
    const wx = actor.renderX || actor.x || 0;
    const wz = actor.renderZ || actor.z || 0;
    if (!this._explored(wx, wz)) return;
    const x = this._mapX(wx);
    const y = this._mapY(wz);
    if (!this._onMap(x, y)) return;
    if (!this._claimBlit()) return;
    const rank = actor.rank;
    if (rank === 'boss') {
      g.fillStyle = C_DANGER;
      g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = C_DANGER; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
    } else if (rank === 'champion' || rank === 'unique') {
      const colour = rank === 'unique' ? C_UNIQUE_MONSTER : C_PROPERTY;
      g.fillStyle = colour;
      g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = colour; g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.stroke();
    } else {
      g.fillStyle = C_DANGER;
      g.beginPath(); g.arc(x, y, 2, 0, Math.PI * 2); g.fill();
    }
    this._monsterMarkers++;
  }

  /** §4.7's "quest objective | 9 px hollow diamond | --ember", plus whatever
   * else a caller registered through `minimapMarker`. */
  _drawCustomMarkers() {
    const g = this._drawG;
    for (let i = 0; i < CUSTOM_MARKER_CAP; i++) {
      if (!this._markerUsed[i]) continue;
      if (!this._claimBlit()) return;
      const x = this._mapX(this._markerX[i]);
      const y = this._mapY(this._markerZ[i]);
      const kind = this._markerKind[i];
      // §4.7: off-map quest/portal markers clamp to the inner edge.
      const cx = clamp(x, 6, this._drawW - 6);
      const cy = clamp(y, 6, this._drawH - 6);
      if (kind === 'portal') {
        g.strokeStyle = C_PROPERTY;
        g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.stroke();
      } else {
        g.strokeStyle = C_EMBER;
        g.lineWidth = 1;
        this._diamond(g, cx, cy, 4.5, false);
      }
    }
  }

  /** §4.7: "player | 9 px triangle, rotated to `actor.facing` | --ink-1". */
  _drawPlayerMarker(actor, px, pz) {
    const g = this._drawG;
    if (!this._claimBlit()) return;
    const x = this._mapX(px);
    const y = this._mapY(pz);
    const f = actor.renderFacing !== undefined ? actor.renderFacing : (actor.facing || 0);
    const r = 4.5;
    const sin = Math.sin(f);
    const cos = Math.cos(f);
    g.fillStyle = C_INK1;
    g.beginPath();
    // Nose along +facing, two tail corners at +-140 degrees.
    g.moveTo(x + sin * r, y + cos * r);
    const a1 = f + 2.443; // 140 deg
    const a2 = f - 2.443;
    g.lineTo(x + Math.sin(a1) * r, y + Math.cos(a1) * r);
    g.lineTo(x + Math.sin(a2) * r, y + Math.cos(a2) * r);
    g.closePath();
    g.fill();
  }

  _diamond(g, x, y, r, filled) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    if (filled) g.fill();
    else g.stroke();
  }

  _renderCorner(ctx, actor, px, pz) {
    this._renderMap(this._2d, CORNER_SIZE, CORNER_SIZE, CORNER_PX_PER_M, px, pz, ctx, actor, px, pz, true);
  }

  /**
   * `09 §4.7`'s overlay mode: 1440x860 at 8.0 px/m, centred on the ZONE (it
   * is the full-zone map, not a bigger follow-cam) — unless the zone is wider
   * than the window at that scale, in which case the window follows the
   * player, clamped to the zone.
   */
  _renderOverlay(ctx, actor, px, pz) {
    let cx = px;
    let cz = pz;
    if (this._bakeW > 0) {
      const cs = this._bakeCellSize;
      const zoneW = this._bakeW * cs;
      const zoneH = this._bakeH * cs;
      const viewW = OVERLAY_W / OVERLAY_PX_PER_M;
      const viewH = OVERLAY_H / OVERLAY_PX_PER_M;
      const zoneCX = this._bakeOriginX + zoneW * 0.5;
      const zoneCZ = this._bakeOriginZ + zoneH * 0.5;
      cx = zoneW <= viewW ? zoneCX : clamp(px, this._bakeOriginX + viewW * 0.5, this._bakeOriginX + zoneW - viewW * 0.5);
      cz = zoneH <= viewH ? zoneCZ : clamp(pz, this._bakeOriginZ + viewH * 0.5, this._bakeOriginZ + zoneH - viewH * 0.5);
    }
    this._renderMap(this._overlay2d, OVERLAY_W, OVERLAY_H, OVERLAY_PX_PER_M, cx, cz, ctx, actor, px, pz, true);
  }

  // =====================================================================
  // Ground labels (`09 §9`)
  // =====================================================================

  /**
   * The 10 Hz tick: one `items.groundItemsNear` sweep into a preallocated
   * array, §9.2's show rules, §9.3's priority sort, then assignment into the
   * 16-entry pool. Allocates nothing (the sweep's `out` array, the candidate
   * index/priority buffers and every pool entry are built in the constructor).
   */
  _refreshCandidates(ctx, px, pz) {
    const items = safeGet(ctx, 'items');
    this._groundCount = 0;
    this._candCount = 0;
    this._overflowCount = 0;
    this._chipLive = false;
    this._labelCap = LABEL_BUDGET;
    if (!items || typeof items.groundItemsNear !== 'function') {
      this._assignEntries(items, ctx);
      return;
    }

    // One sweep at the MINIMAP's radius; the label rules re-filter to 24 m.
    const n = items.groundItemsNear(px, pz, MONSTER_REVEAL_M, this._groundOut);
    this._groundCount = n;

    const step = (ctx && ctx.time && ctx.time.step) || 0;
    const freshSteps = LABEL_FRESH_S * 60; // FIXED_DT = 1/60 (ARCHITECTURE.md)
    const camera = ctx && ctx.camera;

    for (let i = 0; i < n; i++) {
      const item = this._groundOut[i];
      if (!item || !item.ground) continue;
      const dx = item.ground.x - px;
      const dz = item.ground.z - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > LABEL_RADIUS_M) continue; // §9.2's 24 m candidate limit

      const rarity = item.rarity || 'normal';
      const fresh = step - (item.ground.droppedAtStep || 0) < freshSteps;
      const isUnique = rarity === 'unique';
      // §9.2's five show rules. Rules 1/3/4/5 are free; rule 2 ("the pointer is
      // within 30 px of the item's projected point") costs a projection, so it
      // is tested only for items no other rule already admitted, and only on
      // this 10 Hz tick — never per frame.
      let candidate = this._altHeld || this._lootLabels || fresh || isUnique;
      if (!candidate && this._pointerX >= 0 && camera) {
        const sx = this._project(item.ground.x, (item.ground.y || 0) + 0.35, item.ground.z, camera);
        if (this._projVisible) {
          const ddx = sx - this._pointerX;
          const ddy = this._projY - this._pointerY;
          candidate = ddx * ddx + ddy * ddy <= POINTER_NEAR_PX * POINTER_NEAR_PX;
        }
      }
      if (!candidate) continue;

      // §9.2: gold and consumables are suppressed unless rule 3 or 4 applies.
      if (!this._altHeld && !this._lootLabels && this._isConsumable(items, item)) continue;

      const unidentified = item.identified === false;
      this._candIndex[this._candCount] = i;
      this._candPriority[this._candCount] = labelPriority(rarity, unidentified, fresh, dist);
      this._candCount++;
      if (this._candCount >= GROUND_SWEEP_CAP) break;
    }

    // Descending-priority insertion sort, in place over the two parallel
    // buffers. `n` here is at most a pack's drop; insertion sort is the right
    // shape and, unlike `Array#sort`, allocates nothing and needs no
    // comparator closure.
    for (let a = 1; a < this._candCount; a++) {
      const vi = this._candIndex[a];
      const vp = this._candPriority[a];
      let b = a - 1;
      while (b >= 0 && this._candPriority[b] < vp) {
        this._candIndex[b + 1] = this._candIndex[b];
        this._candPriority[b + 1] = this._candPriority[b];
        b--;
      }
      this._candIndex[b + 1] = vi;
      this._candPriority[b + 1] = vp;
    }

    // §9.3: "the top 16 get labels. If more than 16 remain, a single overflow
    // chip is placed at the centroid of the remainder". The chip cannot have
    // nodes of its own (`09 §13.1` spends all 48 on 16 × 3), so it borrows the
    // LAST pool entry the moment it appears — which is why the label cap drops
    // to 15 exactly when there is a chip, and is 16 otherwise. See the report.
    if (this._candCount > LABEL_BUDGET) {
      this._labelCap = LABEL_BUDGET - 1;
      this._overflowCount = this._candCount - this._labelCap;
    } else {
      this._labelCap = LABEL_BUDGET;
      this._overflowCount = 0;
    }
    this._computeChipCentroid();
    this._assignEntries(items, ctx);
  }

  /** §9.3's "centroid of the remainder", in WORLD space — one projection per
   * frame then buys the chip's screen position, instead of re-projecting every
   * unlabelled item. */
  _computeChipCentroid() {
    if (this._overflowCount <= 0) { this._chipLive = false; return; }
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    let best = 'normal';
    let bestRank = -1;
    for (let i = this._labelCap; i < this._candCount; i++) {
      const item = this._groundOut[this._candIndex[i]];
      if (!item || !item.ground) continue;
      sx += item.ground.x;
      sy += item.ground.y || 0;
      sz += item.ground.z;
      n++;
      const r = item.rarity || 'normal';
      const rank = RARITY_RANK[r] === undefined ? 0 : RARITY_RANK[r];
      if (rank > bestRank) { bestRank = rank; best = r; }
    }
    if (n === 0) { this._chipLive = false; return; }
    this._chipWorldX = sx / n;
    this._chipWorldY = sy / n;
    this._chipWorldZ = sz / n;
    this._chipRarity = best;
    this._chipLive = true;
  }

  _isConsumable(items, item) {
    if (!items || typeof items.base !== 'function') return false;
    const base = items.base(item.baseId);
    return !!base && base.category === 'consumable';
  }

  /** Binds the top candidates onto the pool entries, rebuilding an entry's
   * text/rarity only when the item under it actually changed. */
  _assignEntries(items, ctx) {
    const take = Math.min(this._candCount, this._labelCap);
    for (let e = 0; e < LABEL_BUDGET; e++) {
      const entry = this._entries[e];
      if (entry.isChip && (this._overflowCount <= 0 || e !== LABEL_BUDGET - 1)) {
        // The chip's borrowed slot is going back to being a label.
        setClass(entry.plate, 'cl2-gl-chip', false);
        entry.isChip = false;
        entry.uid = 0;
        entry.item = null;
        this._hideEntry(entry);
      }
      if (e >= take) {
        if (entry.item) entry.dying = true;
        continue;
      }
      const item = this._groundOut[this._candIndex[e]];
      entry.dying = false;
      if (entry.item === item && entry.uid === item.uid) continue;
      entry.item = item;
      entry.uid = item.uid;
      entry.fade = 0;
      const rarity = item.rarity || 'normal';
      if (entry.rarity !== rarity) {
        setClass(entry.plate, LABEL_RARITY_CLASS[entry.rarity] || LABEL_RARITY_CLASS.normal, false);
        setClass(entry.plate, LABEL_RARITY_CLASS[rarity] || LABEL_RARITY_CLASS.normal, true);
        entry.rarity = rarity;
      }
      const base = items && typeof items.base === 'function' ? items.base(item.baseId) : null;
      let uniqueName = null;
      if (item.uniqueId && items && typeof items.unique === 'function') {
        const def = items.unique(item.uniqueId);
        uniqueName = def ? def.name : null;
      }
      let name = resolveGroundLabelName(item, base, uniqueName, this._lang);
      if (item.quantity > 1) name = name + ' × ' + numStr(item.quantity);
      entry.name = name;
      setText(entry.text, name);
      // §9.4 step 1: "width is known — it was measured once at build". There
      // is no measurement API that works headlessly and `09 §13.4` forbids a
      // layout read per frame, so the width is COMPUTED from the label's own
      // fixed geometry (`LABEL_CHROME_W`) plus the text at the --t-body
      // advance. Deterministic, and the same number in Chromium and in
      // `node --test`.
      const wanted = LABEL_CHROME_W + name.length * LABEL_GLYPH_W;
      entry.width = Math.max(LABEL_MIN_W, Math.min(LABEL_MAX_W, wanted));
      // §9.1: never an ellipsis — an over-long name wraps to a second 22 px
      // line instead.
      entry.lines = wanted > LABEL_MAX_W ? 2 : 1;
      if (entry.lines !== 1) setClass(entry.plate, 'cl2-gl-2', true);
      else setClass(entry.plate, 'cl2-gl-2', false);
    }

    // §9.3's overflow chip, on the borrowed last entry: "`+ 7 items` in
    // `--ink-2` on an e1 plate, with the highest rarity among them as its seam
    // colour".
    if (this._overflowCount > 0 && this._chipLive) {
      const chip = this._entries[LABEL_BUDGET - 1];
      if (!chip.isChip) {
        setClass(chip.plate, 'cl2-gl-chip', true);
        chip.isChip = true;
        chip.item = null;
        chip.uid = 0;
        chip.fade = 1;
        chip.dying = false;
      }
      if (chip.rarity !== this._chipRarity) {
        setClass(chip.plate, LABEL_RARITY_CLASS[chip.rarity] || LABEL_RARITY_CLASS.normal, false);
        setClass(chip.plate, LABEL_RARITY_CLASS[this._chipRarity] || LABEL_RARITY_CLASS.normal, true);
        chip.rarity = this._chipRarity;
      }
      const text = this._tOr('label.overflow', OVERFLOW_FALLBACK(this._overflowCount), OVERFLOW_PARAMS_SET(this._overflowCount));
      if (chip.name !== text) {
        chip.name = text;
        setText(chip.text, text);
        chip.width = Math.min(LABEL_MAX_W, LABEL_CHROME_W + text.length * LABEL_GLYPH_W);
        chip.lines = 1;
      }
    }
  }

  /**
   * Per frame: project, position, declutter, fade. `09 §9.3`: "positions
   * update every frame."
   */
  _updateLabels(dt, ctx, px, pz) {
    const camera = ctx && ctx.camera;
    const n = LABEL_BUDGET;
    let live = 0;

    for (let e = 0; e < n; e++) {
      const entry = this._entries[e];
      let wx = 0;
      let wy = 0;
      let wz = 0;
      if (entry.isChip) {
        if (!this._chipLive) { this._hideEntry(entry); continue; }
        wx = this._chipWorldX;
        wy = this._chipWorldY + 0.35;
        wz = this._chipWorldZ;
      } else {
        const item = entry.item;
        if (!item || !item.ground) { this._hideEntry(entry); continue; }
        if (entry.dying) {
          entry.fade -= dt / LABEL_FADE_S;
          if (entry.fade <= 0) { this._hideEntry(entry); entry.item = null; entry.uid = 0; continue; }
        } else if (entry.fade < 1) {
          entry.fade = Math.min(1, entry.fade + dt / LABEL_FADE_S);
        }
        wx = item.ground.x;
        wy = (item.ground.y || 0) + 0.35;
        wz = item.ground.z;
      }

      const sx = this._project(wx, wy, wz, camera);
      if (!this._projVisible) { this._hideEntry(entry); continue; }
      const sy = this._projY;

      // Viewport + 60 px margin (§9.2's last line).
      if (sx < -LABEL_VIEWPORT_MARGIN || sy < -LABEL_VIEWPORT_MARGIN
        || sx > this._vw + LABEL_VIEWPORT_MARGIN || sy > this._vh + LABEL_VIEWPORT_MARGIN) {
        this._hideEntry(entry);
        continue;
      }

      this._lorder[live] = live;
      this._lx[live] = sx;
      this._ly[live] = sy - 6; // "bottom edge 6 px above" the projected point
      this._ly0[live] = sy - 6;
      this._lw[live] = entry.width;
      this._lh[live] = LABEL_H * entry.lines;
      entry.slot = live;
      entry.shown = true;
      live++;
    }
    this._liveCount = live;

    // §9.4 step 2 — ascending y, then the four relaxation passes.
    for (let a = 1; a < live; a++) {
      const v = this._lorder[a];
      let b = a - 1;
      while (b >= 0 && this._ly[this._lorder[b]] > this._ly[v]) {
        this._lorder[b + 1] = this._lorder[b];
        b--;
      }
      this._lorder[b + 1] = v;
    }
    this._stemCount = relaxLabels(this._lx, this._ly, this._lw, this._lh, this._ly0, this._lorder, live, 0);

    for (let e = 0; e < n; e++) {
      const entry = this._entries[e];
      if (!entry.shown) continue;
      const s = entry.slot;
      const drop = this._ly[s] - this._ly0[s];
      const displaced = Math.abs(drop) > LABEL_STEM_THRESHOLD;
      if (entry.stem !== displaced) {
        setClass(entry.plate, 'cl2-gl-stem', displaced);
        entry.stem = displaced;
      }
      if (displaced) {
        // The stem spans the gap the declutter opened. Quantised to whole px so
        // a settled label stops rebuilding the string (rule 6).
        const stemPx = Math.round(Math.abs(drop));
        if (entry.stemPx !== stemPx) {
          entry.stemPx = stemPx;
          setStyle(entry.plate, '--cl2-stem', stemPx + 'px');
        }
      }
      place(entry.plate, this._lx[s] - this._lw[s] * 0.5, this._ly[s] - this._lh[s]);
      setStyle(entry.plate, 'width', this._lw[s] + 'px');
      setStyle(entry.plate, 'opacity', entry.fade < 1 ? entry.fade.toFixed(2) : '1');
      setStyle(entry.plate, 'display', 'block');
      // §9.5's 28 px disc sits on the item's OWN projected point, never on the
      // decluttered plate — the chip has no item, so it has no disc.
      if (entry.isChip) {
        setStyle(entry.disc, 'display', 'none');
      } else {
        place(entry.disc, this._lx[s] - 28, this._ly0[s] + 6 - 28);
        setStyle(entry.disc, 'display', 'block');
      }
      entry.shown = false; // consumed; re-set next frame
    }
  }

  _hideEntry(entry) {
    entry.shown = false;
    setStyle(entry.plate, 'display', 'none');
    setStyle(entry.disc, 'display', 'none');
  }

  _releaseAllLabels() {
    for (let e = 0; e < LABEL_BUDGET; e++) {
      const entry = this._entries[e];
      entry.item = null;
      entry.uid = 0;
      entry.fade = 0;
      entry.dying = false;
      if (entry.isChip) {
        setClass(entry.plate, 'cl2-gl-chip', false);
        entry.isChip = false;
      }
      this._hideEntry(entry);
    }
    this._chipLive = false;
    this._overflowCount = 0;
  }

  /**
   * `render.worldToScreen()` does not exist (O-69) — this is the same
   * `ctx.camera` projection `./feedback.js:499` already runs, writing to two
   * instance fields instead of an out-object so nothing is allocated.
   * @returns {number} screen x; `_projY` / `_projVisible` carry the rest.
   */
  _project(x, y, z, camera) {
    if (!camera || typeof camera.updateMatrixWorld !== 'function' || typeof this._scratchVec3.project !== 'function') {
      this._projY = 0;
      this._projVisible = false;
      return 0;
    }
    const v = this._scratchVec3;
    v.set(x, y, z);
    v.project(camera);
    this._projY = (-v.y * 0.5 + 0.5) * this._vh;
    this._projVisible = v.z >= -1 && v.z <= 1;
    return (v.x * 0.5 + 0.5) * this._vw;
  }

  /**
   * §9.5: `pointerdown` calls `player.pickUpOrder(item.uid)` and makes sure
   * the same click is never ALSO a move order.
   *
   * Two mechanisms, because `stopPropagation()` alone is not enough here.
   * `player` does not listen for this event — it reads a latched snapshot of
   * `ctx.input` from its own `update` (`src/player/index.js#_latchIntent`), and
   * the only thing that suppresses a new order there is `ui.pointerOverUi`.
   * `stopPropagation()` covers listener-based readers; arming O-78's swallow
   * window covers the latch. The chip has no item and issues no order — but it
   * still swallows the click, or dismissing it would walk the character.
   */
  _onLabelPointerDown(entry, e) {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (this._armSwallow) this._armSwallow();
    if (!entry.item) return;
    const player = safeGet(this._ctx, 'player');
    // `pickUpOrder` is contracted (`02-api-contracts.md`:1172) but not yet
    // implemented; guarded exactly like `./feedback.js:894`'s `cameraShake`.
    if (player && typeof player.pickUpOrder === 'function') player.pickUpOrder(entry.item.uid);
    this._lastPickUpUid = entry.item.uid;
  }

  // =====================================================================
  // Teardown (ARCHITECTURE.md rule 7)
  // =====================================================================

  dispose() {
    const ctx = this._ctx;
    if (ctx && ctx.events && typeof ctx.events.off === 'function') {
      ctx.events.off('nav:rebuilt', this._onNavRebuilt);
      ctx.events.off('zone:ready', this._onZoneReady);
    }
    if (this._doc) this._doc.removeEventListener('pointermove', this._onPointerMove, true);
    this._doc = null;
    for (let e = 0; e < LABEL_BUDGET; e++) {
      const entry = this._entries[e];
      bindPointerDown(entry.plate, null);
      bindPointerDown(entry.disc, null);
      if (typeof entry.plate.remove === 'function') entry.plate.remove();
      if (typeof entry.disc.remove === 'function') entry.disc.remove();
      entry.item = null;
    }
    if (this._root && typeof this._root.remove === 'function') this._root.remove();
    // Free the offscreen rasters — nothing else holds them.
    if (this._bakeCanvas) { this._bakeCanvas.width = 0; this._bakeCanvas.height = 0; }
    if (this._fogCanvas) { this._fogCanvas.width = 0; this._fogCanvas.height = 0; }
    this._bakeCanvas = null;
    this._bake2d = null;
    this._fogCanvas = null;
    this._fog2d = null;
    this._2d = null;
    this._overlay2d = null;
    this._cellClass = null;
    this._fog = null;
    this._root = null;
  }

  // =====================================================================
  // Dev-only escape hatches — not in `02-api-contracts.md`, so not public
  // API; double-underscore, matching this codebase's convention.
  // =====================================================================

  /** @returns {number} how many times the nav layer has been rasterised —
   * `09 §15` U11's "rebakes exactly once per `nav:rebuilt`" clause. */
  __bakeCount() { return this._bakeCount; }

  /** @returns {object} the classification the bake produced, for a headless
   * assert (no 2D context exists under `node --test`). */
  __bakeInfo() {
    return {
      width: this._bakeW, height: this._bakeH,
      originX: this._bakeOriginX, originZ: this._bakeOriginZ,
      cellSize: this._bakeCellSize,
      cellClass: this._cellClass,
      outlineCount: this._outlineCount,
      navVersion: this._bakedNavVersion,
    };
  }

  /** Installs a 2D-context stand-in on the corner/overlay/bake/fog canvases so
   * the REAL draw path runs under `node --test`. The browser's rasteriser
   * cannot be measured in Node; every allocation this module's own draw code
   * could make on that path can. */
  __attachContext2d(make) {
    this._2d = make();
    this._overlay2d = make();
    if (!this._bakeCanvas) {
      this._bakeCanvas = el('canvas', 'cl2-mm-bake');
    }
    this._bake2d = make();
    if (!this._fogCanvas) this._fogCanvas = el('canvas', 'cl2-mm-fog');
    this._fog2d = make();
  }

  /** Drives the REAL `pointermove` handler §9.2 rule 2 reads. The Node shim
   * (`./util.js`) implements no `addEventListener`, so the listener installed
   * by `_bindEvents` never fires under `node --test` — same tier as
   * `./inventory.js#__simulatePointerMove`. */
  __simulatePointerMove(x, y) {
    this._onPointerMove({ clientX: x, clientY: y });
  }

  __labelEntries() { return this._entries; }
  __liveLabelCount() { return this._liveCount; }
  __overflowCount() { return this._overflowCount; }
  __stemCount() { return this._stemCount; }
  __monsterMarkerCount() { return this._monsterMarkers; }
  __markerBlits() { return this._markerBlits; }
  __exploredCells() { return this._exploredCells; }
  __lastPickUpUid() { return this._lastPickUpUid; }
  __chipEntry() { const e = this._entries[LABEL_BUDGET - 1]; return e.isChip ? e : null; }

  /**
   * The live on-screen rect of every SHOWN label, written into a caller-owned
   * out array as `[x0, y0, x1, y1]` quadruples. This is what the "15 items
   * produce 15 non-overlapping labels" clause is measured against — the same
   * numbers `place()` wrote to the DOM, not a re-derivation.
   * @param {number[]} out @returns {number} the rect count.
   */
  __labelRects(out) {
    let k = 0;
    for (let e = 0; e < LABEL_BUDGET; e++) {
      const entry = this._entries[e];
      if (entry.plate.style.display !== 'block') continue;
      const s = entry.slot;
      if (s < 0 || s >= this._liveCount) continue;
      out[k * 4] = this._lx[s] - this._lw[s] * 0.5;
      out[k * 4 + 1] = this._ly[s] - this._lh[s];
      out[k * 4 + 2] = this._lx[s] + this._lw[s] * 0.5;
      out[k * 4 + 3] = this._ly[s];
      k++;
    }
    return k;
  }
}

/** `t()` takes a params object; building one per call would allocate, so the
 * single `{n}` the overflow chip needs is written into one shared record.
 * The chip's text is only rebuilt on the 10 Hz tick, never per frame. */
const OVERFLOW_PARAMS = { n: 0 };
function OVERFLOW_PARAMS_SET(n) {
  OVERFLOW_PARAMS.n = n;
  return OVERFLOW_PARAMS;
}

/** `09 §9.3`'s literal chip text (`+ 7 items`), for when `./i18n.js` — another
 * ticket's file, and one that carries none of this module's keys yet — has no
 * `label.overflow` entry. Rebuilt only when the count changes, on the 10 Hz
 * tick, never per frame. */
function OVERFLOW_FALLBACK(n) {
  return '+ ' + numStr(n) + ' items';
}
