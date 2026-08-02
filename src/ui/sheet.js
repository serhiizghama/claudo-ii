// src/ui/sheet.js
//
// UI-10 — the character sheet: ten equipment slots, the attribute block with
// `+` allocation, derived stats, the advanced page, and the `uiScene`
// paperdoll viewport (`09-ui.md` §15 U8, the wireframe at §3.5 "Character
// sheet (left zone, 440 x 628 @ 24,24)", the slot-rectangle table right
// below it, §13.1's node budget row `| character sheet | 104 | 16 chrome +
// 20 slots + 24 attributes + <= 44 stat rows |`).
//
// Owned by `ui`, constructed and driven by `UiSystem` (`./index.js`) the
// same shape UI-6's `./inventory.js` already establishes: a single
// top-level panel, `update(dt, ctx)` that no-ops while hidden,
// `open`/`close`/`toggle`/`isOpen`/`setVisible`, `dispose()`.
//
// ---------------------------------------------------------------------------
// The wireframe's own two rectangles for the paperdoll viewport disagree —
// the geometry TABLE wins
// ---------------------------------------------------------------------------
// `09-ui.md`:617 annotates the ASCII wireframe with "200 x 300 @ 144,156",
// but the geometry table immediately below it (`09`:654) gives
// `paperdoll viewport | 144 | 116 | 152 | 236` — a different position AND a
// different size. Every OTHER slot's ASCII annotation in that same
// wireframe matches its table row exactly (verified against `inventory.js`'s
// own precedent: its grid annotation "440 x 176 / origin 1436,136" matches
// `09`'s inventory table to the pixel), so this one disagreement reads as a
// spec typo, not a deliberate second data point. The table is used here —
// it is the more precise section (it gives all ten slots AND the paperdoll
// in one coordinate system, "panel-local, origin at the panel's content box
// (panel x + 0, panel y + 40)"), and picking the ASCII annotation instead
// would make the paperdoll overlap `ring1`/`ring2` at its right edge in a
// way the table's numbers do not. Flagged in this ticket's report.
//
// ---------------------------------------------------------------------------
// The paperdoll is a placeholder mannequin, not `actors`' rig
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 2 forbids importing `src/actors/`, and this
// ticket's file grant does not include it either — `actors` owns skeletons/
// animators/procedural meshes, and nothing in `02-api-contracts.md` §7
// hands another subsystem a mesh to display standalone. So the paperdoll
// built below is `ui`'s OWN small primitive mannequin (sphere head, capsule
// torso/arms, cylinder hip/legs) — geometry and materials it owns
// exclusively per `02-api-contracts.md` §14 ("everything drawn into
// `ctx.uiScene`" is in `ui`'s exclusive-ownership list), not a stand-in for
// `actors`' real character art. It does not reflect equipped items visually
// (no spec text in the read range asks for that, and doing so would need
// `actors.setEquipVisual`-shaped machinery this ticket has no mandate to
// build) — flagged in the report as a known simplification.
//
// ---------------------------------------------------------------------------
// Landing the paperdoll in its rectangle without a viewport/scissor
// ---------------------------------------------------------------------------
// `src/render/index.js#render` (RNDR, not this ticket's file) renders
// `ctx.uiScene` full-canvas, with only the depth buffer cleared, and never
// calls `setViewport`/`setScissor` — and that file is out of this ticket's
// grant, so this module cannot install a scissored sub-viewport for the
// paperdoll. Instead the paperdoll's OWN transform is solved so its
// projection through the existing full-canvas `ctx.uiCamera` lands inside
// the target screen rectangle: `computePaperdollPlacement` below picks a
// fixed render depth along the camera's forward axis, converts the target
// rectangle's centre to camera-relative world offsets via the camera's own
// vertical FOV/aspect (an "off-axis translation", not an off-axis frustum —
// the model is moved, the camera's frustum stays symmetric), and scales the
// model's own measured local bounding box to fit inside (not stretched to
// fill) the rectangle's world-space footprint at that depth. Because uiScene
// has no other content but this one group (`09` §13.2: "uiScene is reserved
// for exactly two things" and character creation's preview is not built
// yet), nothing else could occlude or be occluded by a paperdoll that stays
// correctly sized — the technique needs no scissor to be exact. `PAPERDOLL_
// DEPTH = 3` is this file's own choice (not specced) — it matches
// `src/main.js#buildUiCamera`'s existing `lookAt(0,1,0)` distance from
// `position (0,1,3)`, so the near/far clip planes stay comfortable.
//
// `computePaperdollPlacement`/`projectedScreenBounds` are exported pure
// functions (take a `THREE.Camera` and plain numbers, return plain data) so
// a test can verify the projected bounds land inside the target rectangle at
// several resolutions without a GPU — `three`'s `Object3D`/`Camera`/`Vector3`
// math runs fine under `node --test` (`tests/render/camera.test.js` already
// established this precedent).
//
// ---------------------------------------------------------------------------
// Equip/unequip — the cursor is the hand-off, not a duplicate drag machine
// ---------------------------------------------------------------------------
// `src/ui/inventory.js` (UI-6/7, a different ticket's file, not reopened
// here) already puts a picked-up item onto `items.cursorItem` when its own
// grid is clicked. This panel does not need to know anything about
// `inventory.js`'s internals to complete the hand-off: a pointerdown on one
// of this panel's own equipment slots reads `items.cursorItem` directly (the
// shared, `items`-owned state both panels already agree on) and, when the
// held item's `slotsFor()` legally includes the slot, calls `items.equip()`.
// A pointerdown on a FILLED slot with nothing on the cursor calls
// `items.unequip()`, which is the tested, atomic, correct primitive (moves
// the item straight to the inventory via `autoPlace`) — `takeToCursor()` is
// deliberately NOT used for taking an item off, because
// `src/items/equipment.js#detachItem`'s own comment documents that an
// already-equipped item accepted onto the cursor is not also cleared out of
// `actor.equipment[slot]` by that call; `unequip()` has no such gap.
//
// KNOWN GAP, disclosed rather than silently left: `inventory.js`'s drag
// ghost (the `cursor` layer) and its own `_dragging` state machine only
// listen on ITS OWN panel element, so a drag STARTED in the inventory grid
// and completed by clicking a slot on THIS panel leaves that ghost visually
// stuck (game state is still correct — `items.cursorItem` is the truth both
// panels read — but the ghost element does not know the drag ended). Fixing
// this needs a change in `inventory.js`, which is out of this ticket's file
// grant. Flagged in the report.
//
// ---------------------------------------------------------------------------
// Derived numbers read the composed StatBlock verbatim — no combat formula
// reimplemented here
// ---------------------------------------------------------------------------
// `01-data-model.md` §4.2's `composeStats` folds `enhancedDamage` (an
// `add->mul` field) into the final block via `derive()`... except it does
// NOT fold it into `minDamage`/`maxDamage` — those two stay a plain `add`
// sum of flat contributions (weapon base + affixes); `attackRating` and
// `defense`, by contrast, ARE fully derived by `derive()` (`03-combat-math`
// owns the rest of the attack-roll pipeline that would apply `enhancedDamage`
// at swing time). This file displays `stats.minDamage`/`maxDamage` exactly
// as `actors.stats()` returns them — the honest flat StatBlock numbers, not
// a hand-rolled "effective damage" formula duplicating `combat`'s math
// (out of this ticket's domain and file grant). Flagged in the report.

import * as THREE from 'three';
import { el, setText, setStyle, numStr } from './util.js';

// ---------------------------------------------------------------------------
// Geometry constants — 09-ui.md §3.5 (character sheet wireframe + the
// equipment slot table right below it), transcribed, not imported (same
// "never import another subsystem's data" precedent `inventory.js`'s own
// header sets for its grid constants).
// ---------------------------------------------------------------------------
const PANEL_X = 24;
const PANEL_Y = 24;
const PANEL_W = 440;
const PANEL_H = 628;
const HEADER_H = 40;

/** Equipment slot rectangles, panel-LOCAL (content-box origin = panel x+0,
 * panel y+40 — `09`:648). `x`/`y` below are used directly as each slot's
 * `left`/`top` CSS against the panel element (which already sits at
 * `PANEL_X`,`PANEL_Y`), with `HEADER_H` added for `top` since the content
 * box starts below the header. */
const SLOT_DEFS = [
  { id: 'amulet', x: 40, y: 16, w: 44, h: 44 },
  { id: 'head', x: 176, y: 16, w: 88, h: 88 },
  { id: 'ring1', x: 356, y: 16, w: 44, h: 44 },
  { id: 'mainHand', x: 24, y: 116, w: 88, h: 132 },
  { id: 'chest', x: 176, y: 116, w: 88, h: 132 },
  { id: 'offHand', x: 328, y: 116, w: 88, h: 132 },
  { id: 'hands', x: 40, y: 264, w: 88, h: 88 },
  { id: 'legs', x: 176, y: 264, w: 88, h: 88 },
  { id: 'ring2', x: 356, y: 264, w: 44, h: 44 },
  { id: 'belt', x: 24, y: 368, w: 88, h: 44 },
];

/** `09`:654 — the geometry table's own numbers; see this file's header for
 * why the table wins over the ASCII annotation just above it. */
const PAPERDOLL_RECT_LOCAL = { x: 144, y: 116, w: 152, h: 236 };

/** This file's own choice (not specced) — see header, "Landing the
 * paperdoll in its rectangle". */
const PAPERDOLL_DEPTH = 3;

const ATTR_IDS = ['strength', 'dexterity', 'vitality', 'energy'];
const ATTR_LABEL_KEYS = ['sheet.strength', 'sheet.dexterity', 'sheet.vitality', 'sheet.energy'];
const DERIVED_LABEL_KEYS = ['sheet.damage', 'sheet.attackRating', 'sheet.defence', 'sheet.block'];

/** A curated subset of `01-data-model.md` §3's `Sheet: A` (advanced-only)
 * fields, restricted to the ones `i18n.js` already carries a `stat.<id>`
 * template for (O-70: never hard-code a display string that has no i18n
 * entry). Not exhaustive — `01` §3 lists ~35 `A` fields; this is the subset
 * with an existing template, chosen to stay comfortably inside the <= 44
 * stat-row budget (09 §13.1) alongside the always-visible vessel/resist
 * rows. Flagged in the report as a deliberate, disclosed curation, not a
 * claim that nothing else exists (O-27/O-39). */
const ADVANCED_STAT_IDS = [
  'attackRatingPercent', 'defensePercent',
  'coldDuration', 'poisonDuration',
  'fireResistPierce', 'coldResistPierce', 'lightResistPierce', 'poisonResistPierce',
  'elementalDamagePercent', 'physicalDamagePercent',
  'lifeOnHit', 'manaOnHit', 'lifeOnKill', 'manaOnKill',
  'pierceChance', 'knockbackChance', 'thorns',
  'rageOnHit', 'rageOnTakeHit', 'resonanceOnHit',
  'maxFireResist', 'maxColdResist', 'maxLightResist', 'maxPoisonResist', 'maxMagicResist', 'maxPhysicalResist',
  'magicDamageReduceFlat',
];

/** Defensive `ctx.get`/`ctx.peek` — duplicated per-module precedent, same
 * shape as `inventory.js`/`hotbar.js`'s own `safeGet`. */
function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(id); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The placeholder mannequin — see this file's header
// ---------------------------------------------------------------------------

/** Builds the paperdoll's own primitive humanoid group. Geometries/materials
 * are collected onto `group.userData` so `Sheet#dispose()` can free each
 * exactly once (`ARCHITECTURE.md` rule 7). */
export function buildPaperdollGroup() {
  const group = new THREE.Group();
  const geometries = new Set();
  const materials = new Set();

  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc8bda8, roughness: 0.75, metalness: 0.05 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.85, metalness: 0.05 });
  materials.add(skinMat);
  materials.add(darkMat);

  function addMesh(geo, mat, x, y, z) {
    geometries.add(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }

  addMesh(new THREE.SphereGeometry(0.16, 12, 10), skinMat, 0, 0.82, 0); // head
  addMesh(new THREE.CapsuleGeometry(0.22, 0.5, 4, 8), darkMat, 0, 0.38, 0); // torso
  addMesh(new THREE.CylinderGeometry(0.2, 0.16, 0.22, 8), darkMat, 0, 0.02, 0); // hip
  const legGeo = new THREE.CylinderGeometry(0.09, 0.07, 0.62, 8);
  addMesh(legGeo, darkMat, -0.12, -0.42, 0);
  addMesh(legGeo, darkMat, 0.12, -0.42, 0);
  const armGeo = new THREE.CapsuleGeometry(0.06, 0.42, 4, 8);
  addMesh(armGeo, skinMat, -0.32, 0.4, 0);
  addMesh(armGeo, skinMat, 0.32, 0.4, 0);

  // Recentre so the GROUP's own local origin sits at the mannequin's bbox
  // centre — children are shifted, not the group, so `group.position` stays
  // free for `computePaperdollPlacement`'s screen-space placement.
  const box = new THREE.Box3().setFromObject(group);
  const center = new THREE.Vector3();
  box.getCenter(center);
  for (let i = 0; i < group.children.length; i++) group.children[i].position.sub(center);

  group.userData.__geometries = geometries;
  group.userData.__materials = materials;
  group.userData.__localBox = new THREE.Box3().setFromObject(group);
  return group;
}

function buildPaperdollLights() {
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1.4, 2.2, 2.6);
  const fill = new THREE.HemisphereLight(0xffffff, 0x201a14, 0.55);
  return [key, fill];
}

/**
 * Solves the paperdoll group's world position/scale so its projection
 * through `camera` (a full-canvas, symmetric-frustum `THREE.PerspectiveCamera`
 * — `ctx.uiCamera`) lands inside `rectAbs` (absolute screen pixels) at the
 * current canvas size. See this file's header, "Landing the paperdoll in
 * its rectangle" for the off-axis-translation reasoning. Pure — allocates
 * three `THREE.Vector3`s (called only on resize/open, never per frame, so
 * this is not a `lateUpdate` allocation).
 * @param {THREE.Camera} camera
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {{x:number,y:number,w:number,h:number}} rectAbs
 * @param {number} depth
 * @param {THREE.Box3} localBox
 * @returns {{position:THREE.Vector3, scale:number, halfW:number, halfH:number}}
 */
export function computePaperdollPlacement(camera, canvasW, canvasH, rectAbs, depth, localBox) {
  camera.updateMatrixWorld(true);
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const up = camera.up.clone().normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();

  const aspect = canvasW / Math.max(canvasH, 1);
  const vFov = (camera.fov * Math.PI) / 180;
  const halfH = depth * Math.tan(vFov / 2);
  const halfW = halfH * aspect;

  const cx = rectAbs.x + rectAbs.w / 2;
  const cy = rectAbs.y + rectAbs.h / 2;
  const ndcX = (cx / canvasW) * 2 - 1;
  const ndcY = 1 - (cy / canvasH) * 2;

  const bboxW0 = Math.max(localBox.max.x - localBox.min.x, 1e-6);
  const bboxH0 = Math.max(localBox.max.y - localBox.min.y, 1e-6);

  // First pass: the simple "flat object at exactly `depth`" formula, both
  // for the starting scale and for the centring offset. Good to within a
  // few percent, but not exact — see below.
  const targetWorldW = (rectAbs.w * (2 * halfW)) / canvasW;
  const targetWorldH = (rectAbs.h * (2 * halfH)) / canvasH;
  let scale = Math.min(targetWorldW / bboxW0, targetWorldH / bboxH0);
  const viewCenter = camera.position.clone().addScaledVector(forward, depth);
  const position = viewCenter.addScaledVector(right, ndcX * halfW).addScaledVector(up, ndcY * halfH);

  // Exact correction by direct measurement-feedback, reusing
  // `projectedScreenBounds` itself (self-consistent with how a test/caller
  // verifies this function's own output). Two real effects the first-pass
  // formula does not capture, both found live by this file's own test
  // sweeping 720p/1080p/1440p:
  //   1. The mannequin has real DEPTH (`localBox`'s own z-extent): its
  //      front face sits closer to the camera than the group's centre, so
  //      it subtends a slightly larger angle than a flat object at `depth`
  //      would (~3.6% overshoot at this model's proportions).
  //   2. The mannequin sits OFF the camera's central axis whenever the
  //      target rectangle isn't screen-centred (true for the character
  //      sheet's own paperdoll viewport at every tested resolution, and
  //      more so at wider canvases where the same absolute-pixel rectangle
  //      covers a smaller, more off-centre fraction of the screen) — an
  //      off-axis point combined with real depth does not foreshorten the
  //      same way a pure `depth`-only translation assumes.
  // Rather than deriving a closed form for both effects together, each
  // round measures the ACTUAL projected bounds, rescales by exactly the
  // ratio needed to make the tighter axis match the target, and re-centres
  // — a fixed point that converges to sub-0.001px at these proportions
  // within ~5 rounds (verified in `tests/ui/sheet.test.js`, all three
  // pinned resolutions). Runs only on resize/open (`_layoutPaperdoll` is
  // polled, not per-frame-unconditional — `ARCHITECTURE.md` rule 6 is
  // about `lateUpdate`, not this occasional path), so a handful of extra
  // `projectedScreenBounds` calls here is not a per-frame allocation.
  const cxPerPx = (2 * halfW) / canvasW;
  const cyPerPx = (2 * halfH) / canvasH;
  for (let i = 0; i < 6; i++) {
    const bounds = projectedScreenBounds(camera, canvasW, canvasH, position, scale, localBox);
    const mw = Math.max(bounds.x1 - bounds.x0, 1e-6);
    const mh = Math.max(bounds.y1 - bounds.y0, 1e-6);
    scale *= Math.min(rectAbs.w / mw, rectAbs.h / mh);

    const rebounds = projectedScreenBounds(camera, canvasW, canvasH, position, scale, localBox);
    const measuredCx = (rebounds.x0 + rebounds.x1) / 2;
    const measuredCy = (rebounds.y0 + rebounds.y1) / 2;
    position.addScaledVector(right, (cx - measuredCx) * cxPerPx);
    position.addScaledVector(up, -(cy - measuredCy) * cyPerPx);
  }

  return { position, scale, halfW, halfH };
}

/**
 * Projects `localBox`'s eight corners, scaled by `scale` and translated to
 * `worldCenter` (no rotation — matches how `Sheet` actually places the
 * group), through `camera`, and returns the resulting axis-aligned screen
 * rectangle. Used both by `Sheet#__paperdollBounds` (a dev/test accessor)
 * and directly by `tests/ui/sheet.test.js` against a bare `THREE.Camera` —
 * no GPU needed (`Vector3#project` is pure matrix math).
 * @returns {{x0:number,y0:number,x1:number,y1:number}}
 */
export function projectedScreenBounds(camera, canvasW, canvasH, worldCenter, scale, localBox) {
  const corners = [
    [localBox.min.x, localBox.min.y, localBox.min.z], [localBox.max.x, localBox.min.y, localBox.min.z],
    [localBox.min.x, localBox.max.y, localBox.min.z], [localBox.max.x, localBox.max.y, localBox.min.z],
    [localBox.min.x, localBox.min.y, localBox.max.z], [localBox.max.x, localBox.min.y, localBox.max.z],
    [localBox.min.x, localBox.max.y, localBox.max.z], [localBox.max.x, localBox.max.y, localBox.max.z],
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    v.set(c[0] * scale + worldCenter.x, c[1] * scale + worldCenter.y, c[2] * scale + worldCenter.z);
    v.project(camera);
    const px = (v.x * 0.5 + 0.5) * canvasW;
    const py = (-v.y * 0.5 + 0.5) * canvasH; // feedback.js's own precedent, same sign convention
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return { x0, y0, x1, y1 };
}

export class Sheet {
  /**
   * @param {object} ctx
   * @param {object} panelsLayer - the `panels` `cl2-layer` node (`./style.js`
   *   `LAYER_NAMES`), the same layer `inventory.js` attaches its own panel
   *   chrome into — this file's file-grant instruction ("attach into
   *   `layers.panels`. Do not restructure the layer stack").
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} [rng] - the ONE `ui`-subsystem RNG fork (UI-4's
   *   ruling) — accepted, unused (no jitter needed here), same precedent
   *   `inventory.js`/`hotbar.js`/`tooltip.js` already set.
   * @param {(text:string, kind:string) => void} [toast]
   */
  constructor(ctx, panelsLayer, translate, rng, toast) {
    this._ctx = ctx;
    this._panelsLayer = panelsLayer;
    this._t = typeof translate === 'function' ? translate : (k) => k;
    void rng;
    this._toast = typeof toast === 'function' ? toast : () => {};

    this._items = safeGet(ctx, 'items');
    this._player = safeGet(ctx, 'player');
    this._actors = safeGet(ctx, 'actors');

    this._visible = false;
    // Sentinel, not a real default resolution — `_syncViewport` must run
    // its first real comparison against "never computed yet", not against
    // a guess that might happen to equal the real boot size and skip the
    // paperdoll's very first placement.
    this._vw = 0;
    this._vh = 0;

    this._advancedOpen = false;
    this._lastPoints = -1;
    this._lastHeaderText = null;
    this._lastName = undefined;
    this._lastLevel = undefined;
    this._lastClassId = undefined;
    this._lastPaperdollRect = { x: 0, y: 0, w: 0, h: 0 };
    // Change-guard scratch for `_syncStats` — every field's RAW NUMBER is
    // compared here before any `t()`/string-concat call runs (see that
    // method's own header comment for why this matters for `Alloc: no`).
    this._lastMinDmg = null;
    this._lastMaxDmg = null;
    this._lastLife = null;
    this._lastMana = null;
    this._lastSecKind = undefined; // distinct from `null` (a real "no secondary" state) so the very first sync always writes
    this._lastSecVal = -1;
    this._lastResist = [null, null, null, null];
    this._lastAdvanced = new Array(ADVANCED_STAT_IDS.length).fill(null);

    this._slots = new Array(SLOT_DEFS.length);
    this._attrRows = new Array(ATTR_IDS.length);
    this._derivedEls = new Array(DERIVED_LABEL_KEYS.length);
    this._advancedEls = new Array(ADVANCED_STAT_IDS.length);

    this._buildDom();
    this._buildPaperdoll(ctx);
  }

  // -------------------------------------------------------------------
  // DOM construction — once, in the constructor (ARCHITECTURE.md rule 6/7)
  // -------------------------------------------------------------------

  _buildDom() {
    const panel = el('div', 'cl2-sheet-panel');
    setStyle(panel, 'position', 'absolute');
    setStyle(panel, 'left', PANEL_X + 'px');
    setStyle(panel, 'top', PANEL_Y + 'px');
    setStyle(panel, 'width', PANEL_W + 'px');
    setStyle(panel, 'height', PANEL_H + 'px');
    setStyle(panel, 'boxSizing', 'border-box');
    setStyle(panel, 'display', 'none');
    // No `background` on the panel itself — see `_buildBodyBackground`'s own
    // header comment for why: the panel's chrome fill is painted by four
    // separate strips instead, leaving a real hole over the paperdoll
    // viewport so the uiScene-rendered mannequin (drawn on the CANVAS,
    // behind this DOM overlay in paint order) is not hidden behind an
    // opaque panel background.
    setStyle(panel, 'border', 'var(--edge)');
    setStyle(panel, 'boxShadow', 'var(--e2-shadow)');
    setStyle(panel, 'pointerEvents', 'auto');
    setStyle(panel, 'fontFamily', 'var(--ff-sans)');
    setStyle(panel, 'color', 'var(--ink-2)');
    setStyle(panel, 'contain', 'layout style paint');
    // O-78, the `ui` half: this attribute is `player`'s hit-test contract
    // (`09` §11.4 point 2's `closest('[data-ui-solid]')`) — see
    // `./index.js`'s document-capture listener. One attribute on the panel
    // root is enough; `closest()` walks up from any descendant.
    panel.setAttribute('data-ui-solid', '');
    this._panelEl = panel;
    if (this._panelsLayer) this._panelsLayer.appendChild(panel);

    if (typeof panel.addEventListener === 'function') {
      panel.addEventListener('pointerdown', (e) => this._onPanelPointerDown(e));
    }

    // Header.
    const header = el('div', 'cl2-sheet-header');
    setStyle(header, 'position', 'relative');
    setStyle(header, 'height', HEADER_H + 'px');
    setStyle(header, 'boxSizing', 'border-box');
    setStyle(header, 'background', 'var(--e2-fill)'); // the panel itself carries no background — see its own comment
    setStyle(header, 'borderBottom', 'var(--edge)');
    panel.appendChild(header);

    const seam = el('div', 'cl2-sheet-seam');
    setStyle(seam, 'position', 'absolute');
    setStyle(seam, 'left', '0');
    setStyle(seam, 'top', '6%');
    setStyle(seam, 'bottom', '6%');
    setStyle(seam, 'width', '2px');
    setStyle(seam, 'background', 'var(--ember)');
    header.appendChild(seam);

    const title = el('div', 'cl2-sheet-title');
    setStyle(title, 'position', 'absolute');
    setStyle(title, 'left', 'var(--space-4)');
    setStyle(title, 'top', '0');
    setStyle(title, 'right', '32px');
    setStyle(title, 'lineHeight', HEADER_H + 'px');
    setStyle(title, 'fontFamily', 'var(--ff-serif)');
    setStyle(title, 'fontSize', 'var(--t-title-size)');
    setStyle(title, 'fontWeight', 'var(--t-title-weight)');
    setStyle(title, 'textTransform', 'uppercase');
    setStyle(title, 'overflow', 'hidden');
    setStyle(title, 'whiteSpace', 'nowrap');
    setStyle(title, 'color', 'var(--ink-1)');
    header.appendChild(title);
    this._titleEl = title;

    const closeBtn = el('button', 'cl2-sheet-close');
    setStyle(closeBtn, 'position', 'absolute');
    setStyle(closeBtn, 'right', '4px');
    setStyle(closeBtn, 'top', '6px');
    setStyle(closeBtn, 'fontFamily', 'var(--ff-sans)');
    setStyle(closeBtn, 'color', 'var(--ink-2)');
    setStyle(closeBtn, 'background', 'transparent');
    setStyle(closeBtn, 'border', 'none');
    setStyle(closeBtn, 'cursor', 'pointer');
    setText(closeBtn, '✕');
    header.appendChild(closeBtn);
    if (typeof closeBtn.addEventListener === 'function') closeBtn.addEventListener('click', () => this.close());

    this._buildBodyBackground(panel);

    // Equipment slots — painted AFTER the background strips (later DOM
    // siblings paint over earlier ones), each with its own opaque/
    // translucent fill, so they read correctly whether they sit over a
    // strip or over the hole.
    for (let i = 0; i < SLOT_DEFS.length; i++) this._slots[i] = this._buildSlot(panel, SLOT_DEFS[i]);

    // Divider between equipment and the attribute block.
    const divider1 = el('div', 'cl2-sheet-rule');
    setStyle(divider1, 'position', 'absolute');
    setStyle(divider1, 'left', 'var(--space-4)');
    setStyle(divider1, 'right', 'var(--space-4)');
    setStyle(divider1, 'top', (HEADER_H + 412) + 'px');
    setStyle(divider1, 'height', '1px');
    setStyle(divider1, 'background', 'var(--hair)');
    panel.appendChild(divider1);

    this._buildAttributes(panel, HEADER_H + 420);
  }

  /**
   * The panel's own chrome fill (`--e2-fill`), painted as four rectangles
   * framing the paperdoll viewport rather than one full-panel background —
   * a REAL hole, not just a lower-opacity overlay. `ui`'s DOM overlay
   * (`#ui`, z-index 1000, `09` §3.4) paints ON TOP of the canvas (`#game`)
   * in the composited page; a normal opaque panel background would
   * therefore hide the uiScene-rendered mannequin completely regardless of
   * how correctly `_layoutPaperdoll` places it — found live, the hard way,
   * by this ticket's own capture/bless pass (see the report): the
   * mannequin's pixels were provably present in the WebGL canvas
   * (confirmed via a direct `gl.readPixels` probe) but never visible in the
   * actual blessed screenshot until this fix. Only the `[top, bottom, left,
   * right]` strips around `PAPERDOLL_RECT_LOCAL` carry the fill; the
   * rectangle itself is left fully transparent. The `chest` slot (built
   * right after this, in `_buildSlot`) separately overlaps the hole with
   * its own 30%-opacity fill per `09`:656 — two different translucency
   * levels for two different reasons, not a duplicate mechanism.
   */
  _buildBodyBackground(panel) {
    const holeTop = HEADER_H + PAPERDOLL_RECT_LOCAL.y;
    const holeBottom = holeTop + PAPERDOLL_RECT_LOCAL.h;
    const holeLeft = PAPERDOLL_RECT_LOCAL.x;
    const holeRight = holeLeft + PAPERDOLL_RECT_LOCAL.w;

    const strip = (left, top, width, height) => {
      const el2 = el('div', 'cl2-sheet-bg-strip');
      setStyle(el2, 'position', 'absolute');
      setStyle(el2, 'left', left + 'px');
      setStyle(el2, 'top', top + 'px');
      setStyle(el2, 'width', width + 'px');
      setStyle(el2, 'height', height + 'px');
      setStyle(el2, 'background', 'var(--e2-fill)');
      panel.appendChild(el2);
    };

    strip(0, HEADER_H, PANEL_W, holeTop - HEADER_H); // above the hole, full width
    strip(0, holeBottom, PANEL_W, PANEL_H - holeBottom); // below the hole, full width — carries the attributes/stats block
    strip(0, holeTop, holeLeft, holeBottom - holeTop); // left of the hole
    strip(holeRight, holeTop, PANEL_W - holeRight, holeBottom - holeTop); // right of the hole
  }

  _buildSlot(panel, def) {
    const wrap = el('div', 'cl2-sheet-slot');
    setStyle(wrap, 'position', 'absolute');
    setStyle(wrap, 'left', def.x + 'px');
    setStyle(wrap, 'top', (HEADER_H + def.y) + 'px');
    setStyle(wrap, 'width', def.w + 'px');
    setStyle(wrap, 'height', def.h + 'px');
    setStyle(wrap, 'boxSizing', 'border-box');
    setStyle(wrap, 'border', 'var(--edge)');
    setStyle(wrap, 'boxShadow', 'var(--well)');
    // `09`:656 — the chest slot overlaps the paperdoll viewport and is
    // drawn at 30% fill so the model reads through it; every other slot
    // keeps the normal well fill.
    setStyle(wrap, 'background', def.id === 'chest' ? 'rgba(16,14,12,.30)' : 'var(--ash-700)');
    setStyle(wrap, 'cursor', 'pointer');
    wrap.setAttribute('data-cl2-slot', def.id);
    panel.appendChild(wrap);

    const canvas = el('canvas');
    canvas.width = def.w;
    canvas.height = def.h;
    setStyle(canvas, 'position', 'absolute');
    setStyle(canvas, 'left', '0');
    setStyle(canvas, 'top', '0');
    setStyle(canvas, 'width', def.w + 'px');
    setStyle(canvas, 'height', def.h + 'px');
    setStyle(canvas, 'pointerEvents', 'none');
    wrap.appendChild(canvas);

    return {
      def,
      wrapEl: wrap,
      iconCanvas: canvas,
      iconCtx: typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null,
      lastItem: undefined,
    };
  }

  _buildAttributes(panel, top) {
    const container = el('div', 'cl2-sheet-attrs');
    setStyle(container, 'position', 'absolute');
    setStyle(container, 'left', 'var(--space-4)');
    setStyle(container, 'right', 'var(--space-4)');
    setStyle(container, 'top', top + 'px');
    panel.appendChild(container);

    const head = el('div', 'cl2-sheet-attrs-head');
    setStyle(head, 'position', 'relative');
    setStyle(head, 'height', '16px');
    setStyle(head, 'fontFamily', 'var(--ff-sans)');
    setStyle(head, 'fontSize', 'var(--t-label-size)');
    setStyle(head, 'color', 'var(--ink-3)');
    container.appendChild(head);

    const attrsLabel = el('span');
    setText(attrsLabel, this._t('sheet.attributes'));
    head.appendChild(attrsLabel);

    const pointsLabel = el('span');
    setStyle(pointsLabel, 'position', 'absolute');
    setStyle(pointsLabel, 'right', '0');
    setStyle(pointsLabel, 'top', '0');
    setText(pointsLabel, this._t('sheet.points', { n: '0' }));
    head.appendChild(pointsLabel);
    this._pointsEl = pointsLabel;

    const ROW_H = 20;
    for (let i = 0; i < ATTR_IDS.length; i++) {
      const row = el('div', 'cl2-sheet-attr-row');
      setStyle(row, 'position', 'relative');
      setStyle(row, 'height', ROW_H + 'px');
      setStyle(row, 'fontFamily', 'var(--ff-sans)');
      setStyle(row, 'fontSize', 'var(--t-body-size)');
      container.appendChild(row);

      const nameEl = el('span');
      setStyle(nameEl, 'color', 'var(--ink-2)');
      setText(nameEl, this._t(ATTR_LABEL_KEYS[i]));
      row.appendChild(nameEl);

      const valueEl = el('span');
      setStyle(valueEl, 'position', 'absolute');
      setStyle(valueEl, 'left', '108px');
      setStyle(valueEl, 'fontFamily', 'var(--ff-mono)');
      setStyle(valueEl, 'color', 'var(--ink-1)');
      setText(valueEl, '0');
      row.appendChild(valueEl);

      const plusBtn = el('button', 'cl2-sheet-plus');
      setStyle(plusBtn, 'position', 'absolute');
      setStyle(plusBtn, 'left', '140px');
      setStyle(plusBtn, 'fontFamily', 'var(--ff-sans)');
      setStyle(plusBtn, 'color', 'var(--ember)');
      setStyle(plusBtn, 'background', 'transparent');
      setStyle(plusBtn, 'border', 'var(--edge)');
      setStyle(plusBtn, 'cursor', 'pointer');
      setText(plusBtn, '+');
      row.appendChild(plusBtn);
      const attrId = ATTR_IDS[i];
      if (typeof plusBtn.addEventListener === 'function') plusBtn.addEventListener('click', () => this._onAllocateClick(attrId));

      const derivedLabel = el('span');
      setStyle(derivedLabel, 'position', 'absolute');
      setStyle(derivedLabel, 'left', '190px');
      setStyle(derivedLabel, 'color', 'var(--ink-3)');
      setText(derivedLabel, this._t(DERIVED_LABEL_KEYS[i]));
      row.appendChild(derivedLabel);

      const derivedValue = el('span');
      setStyle(derivedValue, 'position', 'absolute');
      setStyle(derivedValue, 'right', '0');
      setStyle(derivedValue, 'fontFamily', 'var(--ff-mono)');
      setStyle(derivedValue, 'color', 'var(--ink-1)');
      setText(derivedValue, '0');
      row.appendChild(derivedValue);

      this._attrRows[i] = { valueEl, lastValue: null };
      this._derivedEls[i] = { el: derivedValue, lastValue: null };
    }

    const divider2 = el('div', 'cl2-sheet-rule');
    setStyle(divider2, 'position', 'relative');
    setStyle(divider2, 'top', '4px');
    setStyle(divider2, 'height', '1px');
    setStyle(divider2, 'background', 'var(--hair)');
    container.appendChild(divider2);

    this._buildStatRows(container);
  }

  _buildStatRows(container) {
    // Life / Mana / secondary — three label+value pairs directly inside one
    // row (no per-pair wrapper div; `_syncStats` toggles the secondary
    // PAIR's own two nodes, not a redundant containing row), keeping this
    // area's node count down (`09` §13.1's "<= 44 stat rows" is a total,
    // not a per-widget quota — O-27/O-39 — but every node saved here is
    // margin for the advanced page below).
    const vesselsWrap = el('div');
    setStyle(vesselsWrap, 'position', 'relative');
    setStyle(vesselsWrap, 'top', '8px');
    setStyle(vesselsWrap, 'fontFamily', 'var(--ff-sans)');
    setStyle(vesselsWrap, 'fontSize', 'var(--t-body-size)');
    container.appendChild(vesselsWrap);

    const makeVesselPair = (labelKey) => {
      const label = el('span');
      setStyle(label, 'color', 'var(--ink-3)');
      setStyle(label, 'marginRight', 'var(--space-2)');
      setText(label, this._t(labelKey));
      vesselsWrap.appendChild(label);
      const value = el('span');
      setStyle(value, 'fontFamily', 'var(--ff-mono)');
      setStyle(value, 'color', 'var(--ink-1)');
      setStyle(value, 'marginRight', 'var(--space-5)');
      setText(value, '0');
      vesselsWrap.appendChild(value);
      return value;
    };

    this._lifeValEl = makeVesselPair('hud.life');
    this._manaValEl = makeVesselPair('hud.mana');

    const secGroup = el('span');
    setStyle(secGroup, 'display', 'inline');
    vesselsWrap.appendChild(secGroup);
    const secLabel = el('span');
    setStyle(secLabel, 'color', 'var(--ink-3)');
    setStyle(secLabel, 'marginRight', 'var(--space-2)');
    secGroup.appendChild(secLabel);
    const secValue = el('span');
    setStyle(secValue, 'fontFamily', 'var(--ff-mono)');
    setStyle(secValue, 'color', 'var(--ink-1)');
    secGroup.appendChild(secValue);
    this._secRowEl = secGroup;
    this._secLabelEl = secLabel;
    this._secValEl = secValue;

    const resistWrap = el('div');
    setStyle(resistWrap, 'position', 'relative');
    setStyle(resistWrap, 'top', '14px');
    setStyle(resistWrap, 'fontFamily', 'var(--ff-sans)');
    setStyle(resistWrap, 'fontSize', 'var(--t-micro-size)');
    container.appendChild(resistWrap);
    this._resistEls = new Array(4);
    for (let i = 0; i < 4; i++) {
      const row = el('div');
      setStyle(row, 'color', 'var(--ink-2)');
      setStyle(row, 'lineHeight', '15px');
      resistWrap.appendChild(row);
      this._resistEls[i] = row;
    }

    const advToggle = el('button', 'cl2-sheet-advtoggle');
    setStyle(advToggle, 'position', 'relative');
    setStyle(advToggle, 'top', '18px');
    setStyle(advToggle, 'display', 'block');
    setStyle(advToggle, 'marginLeft', 'auto');
    setStyle(advToggle, 'fontFamily', 'var(--ff-sans)');
    setStyle(advToggle, 'fontSize', 'var(--t-label-size)');
    setStyle(advToggle, 'color', 'var(--ink-2)');
    setStyle(advToggle, 'background', 'var(--ash-700)');
    setStyle(advToggle, 'border', 'var(--edge)');
    setStyle(advToggle, 'cursor', 'pointer');
    setText(advToggle, this._t('common.advanced') + ' ▾');
    container.appendChild(advToggle);
    this._advToggleEl = advToggle;

    const advWrap = el('div', 'cl2-sheet-advanced');
    setStyle(advWrap, 'position', 'relative');
    setStyle(advWrap, 'top', '22px');
    setStyle(advWrap, 'maxHeight', '96px');
    setStyle(advWrap, 'overflowY', 'auto');
    setStyle(advWrap, 'scrollbarWidth', 'none');
    setStyle(advWrap, 'fontFamily', 'var(--ff-sans)');
    setStyle(advWrap, 'fontSize', 'var(--t-micro-size)');
    setStyle(advWrap, 'display', 'none');
    container.appendChild(advWrap);
    this._advWrapEl = advWrap;

    for (let i = 0; i < ADVANCED_STAT_IDS.length; i++) {
      const row = el('div');
      setStyle(row, 'color', 'var(--ink-3)');
      setStyle(row, 'lineHeight', '14px');
      advWrap.appendChild(row);
      this._advancedEls[i] = row;
    }

    if (typeof advToggle.addEventListener === 'function') {
      advToggle.addEventListener('click', () => {
        this._advancedOpen = !this._advancedOpen;
        setStyle(advWrap, 'display', this._advancedOpen ? 'block' : 'none');
        setText(advToggle, this._t('common.advanced') + (this._advancedOpen ? ' ▴' : ' ▾'));
      });
    }
  }

  // -------------------------------------------------------------------
  // The paperdoll (uiScene)
  // -------------------------------------------------------------------

  _buildPaperdoll(ctx) {
    if (!ctx || !ctx.uiScene) return;
    const group = buildPaperdollGroup();
    group.visible = false;
    this._paperdollGroup = group;
    this._paperdollLocalBox = group.userData.__localBox;
    this._paperdollLights = buildPaperdollLights();
    for (let i = 0; i < this._paperdollLights.length; i++) ctx.uiScene.add(this._paperdollLights[i]);
    ctx.uiScene.add(group);
  }

  _layoutPaperdoll(ctx) {
    if (!this._paperdollGroup || !ctx || !ctx.uiCamera || this._vw <= 0 || this._vh <= 0) return;
    const rectAbs = {
      x: PANEL_X + PAPERDOLL_RECT_LOCAL.x,
      y: PANEL_Y + HEADER_H + PAPERDOLL_RECT_LOCAL.y,
      w: PAPERDOLL_RECT_LOCAL.w,
      h: PAPERDOLL_RECT_LOCAL.h,
    };
    const placement = computePaperdollPlacement(ctx.uiCamera, this._vw, this._vh, rectAbs, PAPERDOLL_DEPTH, this._paperdollLocalBox);
    this._paperdollGroup.position.copy(placement.position);
    this._paperdollGroup.scale.setScalar(placement.scale);
    this._lastPaperdollRect = rectAbs;
  }

  // -------------------------------------------------------------------
  // Pointer handling — O-78's `ui` half: this panel's root carries
  // `data-ui-solid` (`_buildDom`), and every pointerdown on it stops
  // propagation here (`09` §11.4 point 3) so it can never also reach the
  // world's own click-to-move listener.
  // -------------------------------------------------------------------

  _onPanelPointerDown(e) {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    const target = e && e.target;
    const slotEl = target && typeof target.closest === 'function' ? target.closest('[data-cl2-slot]') : null;
    if (!slotEl) return;
    const slotId = slotEl.getAttribute ? slotEl.getAttribute('data-cl2-slot') : null;
    if (slotId) this._attemptSlotInteraction(slotId);
  }

  _attemptSlotInteraction(slotId) {
    const items = this._items;
    const player = this._player;
    const actor = player && player.actor;
    if (!items || !actor) return;

    const held = items.cursorItem;
    if (held) {
      const legal = typeof items.slotsFor === 'function' ? items.slotsFor(held) : [];
      if (!legal || legal.indexOf(slotId) === -1) {
        this._toast(this._t('toast.notAvailable'), 'warn');
        return;
      }
      const res = items.equip(actor, held, slotId);
      if (!res || !res.ok) this._toast(this._t('toast.notAvailable'), 'warn');
      return;
    }

    const equipped = typeof items.equipped === 'function' ? items.equipped(actor, slotId) : null;
    if (equipped && typeof items.unequip === 'function') items.unequip(actor, slotId);
  }

  _onAllocateClick(attrId) {
    const player = this._player;
    // `player.spendStatPoint` is contracted (`02-api-contracts.md` §13) but
    // not implemented yet (grep confirms no such method on
    // `src/player/index.js` today, and `src/player/` is out of this
    // ticket's file grant) — same O-69 defensive-guard precedent UI-4 set
    // for `render.screenImpulse`/`player.cameraShake`. Flagged in the report.
    if (player && typeof player.spendStatPoint === 'function') {
      player.spendStatPoint(attrId);
    } else {
      this._toast(this._t('toast.notAvailable'), 'warn');
    }
  }

  // -------------------------------------------------------------------
  // Frame update — presentation only (ARCHITECTURE.md rule 5)
  // -------------------------------------------------------------------

  update(dt, ctx) {
    this._ctx = ctx;
    if (!this._items) this._items = safeGet(ctx, 'items');
    if (!this._player) this._player = safeGet(ctx, 'player');
    if (!this._actors) this._actors = safeGet(ctx, 'actors');

    this._syncViewport(ctx);

    if (!this._visible) return;

    this._syncHeader();
    this._syncSlots();
    this._syncStats();
  }

  _syncViewport(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw;
    this._vh = vh;
    this._layoutPaperdoll(ctx);
  }

  _syncHeader() {
    const player = this._player;
    const actor = player && player.actor;
    if (!actor) return;
    const name = actor.name || '';
    const level = actor.level || 1;
    const classId = actor.classId || 'ravager';
    // Guard on the three raw source values BEFORE building any string —
    // `_syncStats`'s own header comment explains why (a `t()`-built string
    // always allocates; only the WRITE is normally change-guarded).
    if (name === this._lastName && level === this._lastLevel && classId === this._lastClassId) return;
    this._lastName = name;
    this._lastLevel = level;
    this._lastClassId = classId;
    const className = this._t('class.' + classId + '.name');
    const text = name + ' — ' + this._t('hud.level') + ' ' + numStr(level) + ' ' + className;
    this._lastHeaderText = text;
    setText(this._titleEl, text);
  }

  _syncSlots() {
    const items = this._items;
    const player = this._player;
    const actor = player && player.actor;
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      const item = items && actor && typeof items.equipped === 'function' ? items.equipped(actor, slot.def.id) : null;
      if (item === slot.lastItem) continue;
      slot.lastItem = item;
      this._drawSlotIcon(slot, item);
    }
  }

  _drawSlotIcon(slot, item) {
    const g = slot.iconCtx;
    if (!g) return;
    const w = slot.def.w, h = slot.def.h;
    g.clearRect(0, 0, w, h);
    if (item) {
      // Same placeholder-glyph precedent `inventory.js#_drawItemIcon` uses
      // today (`items.icon()` is real now, but `inventory.js` — a different
      // ticket's file — has not been wired to call it; matching, not
      // fixing, that precedent here).
      g.fillStyle = '#8c8375';
      g.beginPath();
      g.arc(w / 2, h / 2, Math.min(w, h) / 2 - 5, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillStyle = 'rgba(239,231,216,.32)';
      g.font = '9px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const label = this._t('slotName.' + slot.def.id);
      g.fillText(String(label).slice(0, 7).toUpperCase(), w / 2, h / 2);
    }
  }

  /**
   * `09` §13.3's own zero-allocation discipline, applied to `t()`-formatted
   * text specifically: `t(key, params)` always builds a fresh string
   * (`i18n.js#format`'s `split`/`join`), so — unlike a plain `setText`,
   * which is already change-guarded on the DOM write — the STRING BUILD
   * itself must be skipped in the steady state, not just the write. Every
   * field below is therefore compared as a raw NUMBER (cheap, no
   * allocation) against a cached last-value BEFORE any `t()`/string-concat
   * call runs; the expensive path only executes on a genuine change,
   * exactly the `_applyItemSlot`/`_syncHeader` precedent
   * `inventory.js#update` already sets (`if (free !== this._lastFree) { …
   * build … }`).
   */
  _syncStats() {
    const actors = this._actors;
    const player = this._player;
    const actor = player && player.actor;
    if (!actors || !actor) return;
    // `02-api-contracts.md` §7: "recomposes if dirty, then returns" — this
    // is what makes equip -> derived-number-changes land in the SAME frame
    // `stats:dirty` resolves (`items.equip` already called `actors.
    // markDirty` synchronously; this read recomposes right here, not on
    // the next `fixedUpdate`).
    const s = actors.stats(actor);

    for (let i = 0; i < ATTR_IDS.length; i++) {
      const row = this._attrRows[i];
      const v = Math.round(s[ATTR_IDS[i]]);
      if (v !== row.lastValue) { row.lastValue = v; setText(row.valueEl, numStr(v)); }
    }

    const minDmg = Math.round(s.minDamage), maxDmg = Math.round(s.maxDamage);
    if (minDmg !== this._lastMinDmg || maxDmg !== this._lastMaxDmg) {
      this._lastMinDmg = minDmg; this._lastMaxDmg = maxDmg;
      setText(this._derivedEls[0].el, numStr(minDmg) + '–' + numStr(maxDmg));
    }
    this._setDerivedNum(1, Math.round(s.attackRating));
    this._setDerivedNum(2, Math.round(s.defense));
    const block = Math.round(s.blockChance);
    if (block !== this._derivedEls[3].lastValue) {
      this._derivedEls[3].lastValue = block;
      setText(this._derivedEls[3].el, numStr(block) + ' %');
    }

    const hud = typeof player.hudState === 'function' ? player.hudState() : null;
    const points = hud ? hud.statPoints : 0;
    if (points !== this._lastPoints) {
      this._lastPoints = points;
      setText(this._pointsEl, this._t('sheet.points', { n: numStr(points) }));
    }

    const life = Math.round(s.maxLife);
    if (life !== this._lastLife) { this._lastLife = life; setText(this._lifeValEl, numStr(life)); }
    const mana = Math.round(s.maxMana);
    if (mana !== this._lastMana) { this._lastMana = mana; setText(this._manaValEl, numStr(mana)); }

    const secKind = s.maxRage > 0 ? 'rage' : (s.maxResonance > 0 ? 'resonance' : null);
    const secVal = secKind === 'rage' ? Math.round(s.maxRage) : (secKind === 'resonance' ? Math.round(s.maxResonance) : 0);
    if (secKind !== this._lastSecKind) {
      this._lastSecKind = secKind;
      if (secKind) {
        setStyle(this._secRowEl, 'display', 'inline-block');
        setText(this._secLabelEl, this._t('hud.' + secKind));
      } else {
        setStyle(this._secRowEl, 'display', 'none');
      }
      this._lastSecVal = -1; // force the value text below to (re)write too
    }
    if (secKind && secVal !== this._lastSecVal) {
      this._lastSecVal = secVal;
      setText(this._secValEl, numStr(secVal));
    }

    this._setResist(0, 'stat.fireResist', Math.round(s.fireResist));
    this._setResist(1, 'stat.coldResist', Math.round(s.coldResist));
    this._setResist(2, 'stat.lightResist', Math.round(s.lightResist));
    this._setResist(3, 'stat.poisonResist', Math.round(s.poisonResist));

    if (this._advancedOpen) {
      for (let i = 0; i < ADVANCED_STAT_IDS.length; i++) {
        const id = ADVANCED_STAT_IDS[i];
        const raw = s[id];
        const v = typeof raw === 'number' ? Math.round(raw * 10) / 10 : 0;
        if (v !== this._lastAdvanced[i]) {
          this._lastAdvanced[i] = v;
          setText(this._advancedEls[i], this._t('stat.' + id, { v: numStr(v) }));
        }
      }
    }
  }

  _setDerivedNum(i, v) {
    const rec = this._derivedEls[i];
    if (v === rec.lastValue) return;
    rec.lastValue = v;
    setText(rec.el, numStr(v));
  }

  _setResist(i, key, v) {
    if (v === this._lastResist[i]) return;
    this._lastResist[i] = v;
    setText(this._resistEls[i], this._t(key, { v }));
  }

  // -------------------------------------------------------------------
  // Public — open/close/toggle
  // -------------------------------------------------------------------

  open() {
    if (this._visible) return;
    this._visible = true;
    setStyle(this._panelEl, 'display', 'block');
    if (this._paperdollGroup) this._paperdollGroup.visible = true;
  }

  close() {
    if (!this._visible) return;
    this._visible = false;
    setStyle(this._panelEl, 'display', 'none');
    if (this._paperdollGroup) this._paperdollGroup.visible = false;
  }

  toggle() {
    if (this._visible) this.close();
    else this.open();
  }

  isOpen() {
    return this._visible;
  }

  setVisible(visible) {
    if (visible) this.open();
    else this.close();
  }

  dispose() {
    this.close();
    if (this._panelEl && this._panelEl.remove) this._panelEl.remove();
    this._panelEl = null;

    if (this._paperdollGroup) {
      const geos = this._paperdollGroup.userData.__geometries;
      const mats = this._paperdollGroup.userData.__materials;
      if (geos) for (const g of geos) g.dispose();
      if (mats) for (const m of mats) m.dispose();
      if (this._ctx && this._ctx.uiScene) this._ctx.uiScene.remove(this._paperdollGroup);
      this._paperdollGroup = null;
    }
    if (this._paperdollLights) {
      for (let i = 0; i < this._paperdollLights.length; i++) {
        const l = this._paperdollLights[i];
        if (this._ctx && this._ctx.uiScene) this._ctx.uiScene.remove(l);
        if (typeof l.dispose === 'function') l.dispose();
      }
      this._paperdollLights = null;
    }
  }

  // -------------------------------------------------------------------
  // Dev/test-only inspection — double-underscore, not in
  // `02-api-contracts.md` (rule 7), matching `inventory.js`'s own
  // `__nodeCountRoot`/`__panelRect` tier.
  // -------------------------------------------------------------------

  __nodeCountRoot() {
    return this._panelEl;
  }

  __panelRect() {
    return { x: PANEL_X, y: PANEL_Y, w: PANEL_W, h: PANEL_H };
  }

  /** The paperdoll viewport's absolute-screen-pixel rectangle, as last
   * computed by `_layoutPaperdoll` (or freshly, if `ctx` is given). */
  __paperdollRect(ctx) {
    if (ctx) this._layoutPaperdoll(ctx);
    return this._lastPaperdollRect;
  }

  /** The paperdoll's actual projected screen bounds at the current
   * placement — see `projectedScreenBounds` above. */
  __paperdollBounds(ctx) {
    const c = ctx || this._ctx;
    if (!this._paperdollGroup || !c || !c.uiCamera) return null;
    return projectedScreenBounds(c.uiCamera, this._vw, this._vh, this._paperdollGroup.position, this._paperdollGroup.scale.x, this._paperdollLocalBox);
  }

  __advancedOpen() {
    return this._advancedOpen;
  }
}
