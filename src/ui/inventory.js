// src/ui/inventory.js
//
// UI-6 — `09-ui.md` §15's U7 row: the inventory panel and drag/drop (§6 in
// full — §6.1 geometry, §6.2 placement, §6.3 drag/drop, §6.4 modifier
// moves, §6.5 sorting, §6.6 the container matrix), plus §3.5's wireframe
// geometry. Owned by `ui`, constructed and driven by `UiSystem` (`./index.js`)
// the same shape UI-2/UI-3/UI-4/UI-5's modules already establish: a single
// top-level container, `update(dt, ctx)` that no-ops while hidden,
// `setVisible`/`open`/`close`/`toggle`, `dispose()`.
//
// ---------------------------------------------------------------------------
// `items` owns the whole placement/cursor model — this file only drives it
// ---------------------------------------------------------------------------
// `09 §16.2`/`02-api-contracts.md` §11: `canPlace`/`place`/`autoPlace`/
// `remove`/`itemAt`/`freeCells`/`findPlacement`/`sortContainer`/`splitStack`,
// the belt (`beltCooldown`/`beltCount`/`beltUse`) and the cursor
// (`cursorItem`/`takeToCursor`/`dropCursor`/`returnCursor`) are ITEM-10's,
// already landed on `ItemsSystem` (`src/items/containers.js`). This file
// reaches every one of them through `ctx.get('items')`, cached once here
// (never imports `src/items/` — `ARCHITECTURE.md` hard rule 2). The tetris
// geometry constants below (`GRID_W`/`GRID_H`/`BELT_COUNT`) are `09 §6.1`'s
// own literal numbers, TRANSCRIBED, not imported from
// `src/items/containers.js#INVENTORY_W` etc. — same "never imported" rule
// `hotbar.js`'s `BELT_COOLDOWN_SECONDS` already sets the precedent for.
//
// ---------------------------------------------------------------------------
// What does NOT exist yet, and how this file degrades — read before editing
// ---------------------------------------------------------------------------
// `items.equip` / `unequip` / `canEquip` / `slotsFor` (equipment.js),
// `vendorSell` / `vendorBuy` / `currentStock` (the vendor economy),
// `dropToGround` / `pickUp` / `groundItemsNear` (world/ground), and
// `consume` (the potion/scroll effect) are ALL contracted in
// `02-api-contracts.md` §11 but NOT implemented on `ItemsSystem` today —
// only the container/belt/cursor group (ITEM-10) landed. `items.icon()`
// likewise does not exist (ITEM-15, the last loot ticket, has not landed) —
// item cells draw a placeholder glyph, never a mocked icon.
//
// Every branch below that would need one of these calls it defensively
// (`typeof items.X === 'function'`) and, when absent, REFUSES the move —
// the item is left exactly where it was (still on the cursor for a
// drag/RMB/quick-move attempt, untouched in its container for anything that
// never left it) and a `toast.notAvailable` is shown. This is not a
// production gap this file invented: `09 §6.6`'s own container matrix
// requires `equip`/`vendorSell`/`vendorBuy`/`dropToGround`/`pickUp` for a
// majority of its legal cells, and none of those five methods exist in this
// tree yet. See this ticket's report for the full accounting of which
// matrix cells are exercised by a genuine pointer sequence against this
// panel's own DOM today, versus which are exercised only at the
// resolver/data level (`CONTAINER_MATRIX`/`matrixAction` below) because
// their SOURCE or DESTINATION panel (stash, equipment, vendor, ground) does
// not exist anywhere in this codebase yet — building one would be scope
// creep into another, not-yet-landed ticket.
//
// ---------------------------------------------------------------------------
// The interaction model: click-to-carry, not press-and-hold-only
// ---------------------------------------------------------------------------
// `09 §6.3` labels the two phases "Pick up — pointerdown" / "Drop —
// pointerup", which reads like a classic press-drag-release gesture. But
// its own drop table says an INVALID drop "stays on the cursor" — which
// only makes sense if the item can also be carried by click-move-click
// (release the button, move the free mouse, click again), the classic
// Diablo-likes' actual interaction model. This file supports BOTH: a
// pointerdown while nothing is on the cursor picks an item up; a
// pointerdown OR a pointerup while something IS already on the cursor is
// treated as "attempt to drop here" (never as "pick up a second item" —
// only one item can be on the cursor at a time). An invalid attempt leaves
// `_dragging` true and the ghost/highlight following the pointer for the
// next attempt, matching the spec's own wording; a valid attempt ends the
// gesture. See `_attemptDropAt`.
//
// ---------------------------------------------------------------------------
// Geometry — computed, never measured (D-B / `09 §13.4`)
// ---------------------------------------------------------------------------
// `09 §3.5`'s wireframe gives the panel at `(1416, 24)` and the grid origin
// at `(1436, 136)` — both at the canonical 1920x1080 layout. This file keeps
// the panel inset from the viewport's top-right corner (`vw - PANEL_MARGIN -
// PANEL_W`, `PANEL_MARGIN`) the same way `hotbar.js#_layoutStatic`
// generalises its own literal 1920x1080 numbers, so this lands correctly at
// the 1280x720 capture resolution too. `GRID_INSET_X`/`GRID_INSET_Y` (the
// grid's offset from the panel's own top-left) ARE the wireframe's literal
// numbers (`1436-1416=20`, `136-24=112`) — not a guess. The belt row's exact
// vertical position is NOT given by the read range (`09 §3.5`'s wireframe
// only shows it below the grid, no pixel figure) — this file's own choice,
// flagged in the report, matching `hotbar.js`'s own precedent for the same
// situation (its `TOAST_ROW_GAP` comment).

import { el, setText, setStyle, place, clamp, damp, numStr } from './util.js';

// ---------------------------------------------------------------------------
// Geometry constants — 09-ui.md §6.1 / §3.5, transcribed (never imported —
// see file header)
// ---------------------------------------------------------------------------
const CELL = 44;
const GRID_W = 10;
const GRID_H = 4;
const GRID_PX_W = GRID_W * CELL; // 440
const GRID_PX_H = GRID_H * CELL; // 176
const MAX_INV_CELLS = GRID_W * GRID_H; // 40

const BELT_COUNT = 4;
const BELT_SLOT = 44;
const BELT_PITCH = 52; // matches hotbar.js's own BELT_PITCH precedent
const BELT_LABEL_W = 56; // this file's own choice — see file header
const BELT_ROW_GAP = 20; // this file's own choice — see file header

const PANEL_W = 480;
const PANEL_H = 420;
const PANEL_MARGIN = 24; // 09 §2.3's 6u screen margin (--pad)
const HEADER_H = 40;
const GOLDROW_H = 28;
const GRID_INSET_X = 20; // 09 §3.5 wireframe: 1436 - 1416
const GRID_INSET_Y = 112; // 09 §3.5 wireframe: 136 - 24

const GHOST_DAMP_RATE = 40; // 09 §2.6: "drag ghost follow ... rate 40/s"
const GHOST_OPACITY = 0.72; // 09 §6.3
const DOUBLE_CLICK_WINDOW = 0.4; // seconds, this file's own choice (not specced)
const SORT_UNDO_SECONDS = 5.0; // 09 §6.5: "undoable for 5s"

/** Defensive `ctx.get`/`ctx.peek` — duplicated per-module precedent, matches
 * `hotbar.js`/`feedback.js`'s own `safeGet`. */
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
// 09-ui.md §6.6 — the container matrix, transcribed verbatim. A blank cell
// (no entry) is forbidden. Exported as data (not a hardcoded pair list) so a
// test iterating CONTAINERS x CONTAINERS against this table fails loudly if
// a cell is added later and nobody covers it.
// ---------------------------------------------------------------------------
export const CONTAINERS = Object.freeze(['inventory', 'stash', 'belt', 'equipment', 'vendor', 'ground']);

export const CONTAINER_MATRIX = Object.freeze({
  inventory: Object.freeze({ inventory: 'place', stash: 'place', belt: 'place', equipment: 'equip', vendor: 'vendorSell', ground: 'dropToGround' }),
  stash: Object.freeze({ inventory: 'place', stash: 'place', belt: 'place', equipment: 'equip' }),
  belt: Object.freeze({ inventory: 'place', stash: 'place', belt: 'place', vendor: 'vendorSell' }),
  equipment: Object.freeze({ inventory: 'unequip', equipment: 'equip', vendor: 'vendorSell' }),
  vendor: Object.freeze({ inventory: 'vendorBuy', belt: 'vendorBuy' }),
  ground: Object.freeze({ inventory: 'pickUp' }),
});

/** `matrixAction(from, to) => string|null` — the pure lookup every drop
 * (real drag or a test's direct invocation) is dispatched through. */
export function matrixAction(from, to) {
  const row = CONTAINER_MATRIX[from];
  return (row && row[to]) || null;
}

function makeItemSlot() {
  return {
    wrapEl: null, iconCanvas: null, iconCtx: null, stackEl: null,
    item: null, lastDrawnBaseId: undefined, lastVisible: false,
  };
}

function makeBeltSlot() {
  return { wrapEl: null, iconCanvas: null, iconCtx: null, countEl: null, lastCount: -1, lastDrawnBaseId: undefined };
}

export class Inventory {
  /**
   * @param {object} ctx
   * @param {object} panelsLayer - the `panels` `cl2-layer` node (the panel
   *   chrome, grid, belt mirror, split chip).
   * @param {object} cursorLayer - the `cursor` `cl2-layer` node (the drag
   *   ghost — `09 §6.3`: "the drag ghost is created at layer 60").
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} [rng] - the ONE `ui`-subsystem RNG fork, shared
   *   with the other modules; unused here (no jitter needed) — accepted for
   *   the same reason `hotbar.js`/`tooltip.js` accept and do not use it.
   * @param {(text:string, kind:string) => void} [toast] - `UiSystem#toast`,
   *   bound — this module's only path to the toast column (`hotbar.js`
   *   owns the widget; a closed ticket, not reopened here).
   */
  constructor(ctx, panelsLayer, cursorLayer, translate, rng, toast) {
    this._ctx = ctx;
    this._panelsLayer = panelsLayer;
    this._cursorLayer = cursorLayer;
    this._t = translate || ((key) => key);
    void rng;
    this._toast = typeof toast === 'function' ? toast : () => {};

    this._items = safeGet(ctx, 'items');
    this._player = safeGet(ctx, 'player');

    this._visible = false;
    this._vw = 1920;
    this._vh = 1080;
    this._panelX = 0;
    this._panelY = 0;
    this._gridX = 0;
    this._gridY = 0;
    this._beltX = 0;
    this._beltY = 0;
    this._beltSlotRects = new Array(BELT_COUNT);
    for (let i = 0; i < BELT_COUNT; i++) this._beltSlotRects[i] = { x: 0, y: 0, w: BELT_SLOT, h: BELT_SLOT };

    this._clock = 0; // dt-integrated, never wall-clock — see file header

    // Drag/cursor state.
    this._dragging = false;
    this._dragItem = null;
    this._dragFromContainer = null;
    this._grabOffX = 0;
    this._grabOffY = 0;
    this._pointerId = null;
    this._ghostDispX = 0;
    this._ghostDispY = 0;
    this._ghostTargetX = 0;
    this._ghostTargetY = 0;
    this._pendingMove = false;
    this._pendingX = 0;
    this._pendingY = 0;
    this._lastPointerX = 0;
    this._lastPointerY = 0;

    // Round 3 (UI-7's finding) — hover-tooltip tracking. `_ui` is resolved
    // lazily in `update()`, same self-healing-cache precedent `_items`/
    // `_player` already use, because `ctx.get('ui')`/`ctx.peek('ui')`
    // cannot resolve yet while `UiSystem.init()` is still constructing this
    // module (the registry only marks an id "ready" after its OWN `init()`
    // returns — see `src/core/registry.js#get`). `_hoverItem` is the
    // change-guard: `showTooltip`/`hideTooltip` are only called on a
    // genuine transition, never every frame (§5.7 — see `_updateHover`).
    this._ui = null;
    this._hoverItem = null;
    this._pendingHoverMove = false;
    this._pendingHoverX = 0;
    this._pendingHoverY = 0;

    // Highlight state (change-guarded paint).
    this._hlLastKind = null;
    this._hlLastX = null;
    this._hlLastY = null;
    this._hlLastW = null;
    this._hlLastH = null;

    // Double-click tracking.
    this._lastClickItem = null;
    this._lastClickClock = -1000;

    // Sort/undo.
    this._sortSnapshot = new Array(MAX_INV_CELLS);
    for (let i = 0; i < MAX_INV_CELLS; i++) this._sortSnapshot[i] = { item: null, x: 0, y: 0 };
    this._sortSnapshotCount = 0;
    this._undoRemaining = 0;

    // Split chip.
    this._splitChip = { open: false, item: null, max: 1, value: 1 };

    // Preallocated scratch — zero allocation on the interaction hot paths.
    this._xyScratch = { x: 0, y: 0 };
    this._regionScratch = { region: 'outside', container: null, cellX: 0, cellY: 0 };
    this._currentItems = new Array(MAX_INV_CELLS).fill(null);
    this._currentCount = 0;
    this._lastFree = -1;
    this._lastGold = -1;

    this._itemSlots = new Array(MAX_INV_CELLS);
    for (let i = 0; i < MAX_INV_CELLS; i++) this._itemSlots[i] = makeItemSlot();
    this._beltSlots = new Array(BELT_COUNT);
    for (let i = 0; i < BELT_COUNT; i++) this._beltSlots[i] = makeBeltSlot();

    this._buildDom();
    this._layoutStatic();
    this._bindEvents();
  }

  // -------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------

  _buildDom() {
    const panel = el('div', 'cl2-inv-panel');
    setStyle(panel, 'position', 'absolute');
    setStyle(panel, 'width', PANEL_W + 'px');
    setStyle(panel, 'height', PANEL_H + 'px');
    setStyle(panel, 'boxSizing', 'border-box');
    setStyle(panel, 'background', 'var(--e2-fill)');
    setStyle(panel, 'border', 'var(--edge)');
    setStyle(panel, 'boxShadow', 'var(--e2-shadow)');
    setStyle(panel, 'display', 'none');
    setStyle(panel, 'pointerEvents', 'auto');
    this._panelsLayer.appendChild(panel);
    this._panelEl = panel;

    // Header — SD-2 ember seam, title, sort, undo (hidden until a sort
    // succeeds), close.
    const header = el('div', 'cl2-inv-header');
    setStyle(header, 'position', 'absolute');
    setStyle(header, 'left', '0');
    setStyle(header, 'top', '0');
    setStyle(header, 'width', PANEL_W + 'px');
    setStyle(header, 'height', HEADER_H + 'px');
    setStyle(header, 'boxSizing', 'border-box');
    setStyle(header, 'borderBottom', 'var(--edge)');
    panel.appendChild(header);

    const seam = el('div', 'cl2-inv-seam');
    setStyle(seam, 'position', 'absolute');
    setStyle(seam, 'left', '0');
    setStyle(seam, 'top', '6%');
    setStyle(seam, 'bottom', '6%');
    setStyle(seam, 'width', '2px');
    setStyle(seam, 'background', 'var(--ember)');
    header.appendChild(seam);

    const title = el('div', 'cl2-inv-title');
    setStyle(title, 'position', 'absolute');
    setStyle(title, 'left', 'var(--space-4)');
    setStyle(title, 'top', '0');
    setStyle(title, 'lineHeight', HEADER_H + 'px');
    setStyle(title, 'fontFamily', 'var(--ff-serif)');
    setStyle(title, 'fontSize', 'var(--t-title-size)');
    setStyle(title, 'fontWeight', 'var(--t-title-weight)');
    setStyle(title, 'color', 'var(--ink-1)');
    setText(title, this._t('panel.inventory'));
    header.appendChild(title);

    const sortBtn = el('button', 'cl2-inv-sort');
    setStyle(sortBtn, 'position', 'absolute');
    setStyle(sortBtn, 'right', '96px');
    setStyle(sortBtn, 'top', '6px');
    setStyle(sortBtn, 'fontFamily', 'var(--ff-sans)');
    setStyle(sortBtn, 'fontSize', 'var(--t-label-size)');
    setStyle(sortBtn, 'color', 'var(--ink-2)');
    setStyle(sortBtn, 'background', 'var(--ash-700)');
    setStyle(sortBtn, 'border', 'var(--edge)');
    setStyle(sortBtn, 'cursor', 'pointer');
    setText(sortBtn, this._t('common.sort'));
    header.appendChild(sortBtn);
    if (typeof sortBtn.addEventListener === 'function') sortBtn.addEventListener('click', () => this._onSortClick());

    const undoBtn = el('button', 'cl2-inv-undo');
    setStyle(undoBtn, 'position', 'absolute');
    setStyle(undoBtn, 'right', '32px');
    setStyle(undoBtn, 'top', '6px');
    setStyle(undoBtn, 'fontFamily', 'var(--ff-sans)');
    setStyle(undoBtn, 'fontSize', 'var(--t-label-size)');
    setStyle(undoBtn, 'color', 'var(--property)');
    setStyle(undoBtn, 'background', 'var(--ash-700)');
    setStyle(undoBtn, 'border', 'var(--edge)');
    setStyle(undoBtn, 'cursor', 'pointer');
    setStyle(undoBtn, 'display', 'none');
    setText(undoBtn, this._t('common.undo'));
    header.appendChild(undoBtn);
    if (typeof undoBtn.addEventListener === 'function') undoBtn.addEventListener('click', () => this._onUndoClick());
    this._undoBtnEl = undoBtn;

    const closeBtn = el('button', 'cl2-inv-close');
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

    // Gold + capacity row.
    const goldRow = el('div', 'cl2-inv-goldrow');
    setStyle(goldRow, 'position', 'absolute');
    setStyle(goldRow, 'left', '0');
    setStyle(goldRow, 'top', HEADER_H + 'px');
    setStyle(goldRow, 'width', PANEL_W + 'px');
    setStyle(goldRow, 'height', GOLDROW_H + 'px');
    setStyle(goldRow, 'boxSizing', 'border-box');
    panel.appendChild(goldRow);

    const goldText = el('span', 'cl2-inv-gold');
    setStyle(goldText, 'position', 'absolute');
    setStyle(goldText, 'left', 'var(--space-4)');
    setStyle(goldText, 'top', '4px');
    setStyle(goldText, 'fontFamily', 'var(--ff-mono)');
    setStyle(goldText, 'fontSize', 'var(--t-num-size)');
    setStyle(goldText, 'color', 'var(--gilt)');
    goldRow.appendChild(goldText);
    this._goldTextEl = goldText;

    const capText = el('span', 'cl2-inv-cap');
    setStyle(capText, 'position', 'absolute');
    setStyle(capText, 'right', 'var(--space-4)');
    setStyle(capText, 'top', '4px');
    setStyle(capText, 'fontFamily', 'var(--ff-sans)');
    setStyle(capText, 'fontSize', 'var(--t-body-size)');
    setStyle(capText, 'color', 'var(--ink-3)');
    goldRow.appendChild(capText);
    this._capTextEl = capText;

    // Grid — one background node (09 §6.1's own literal CSS, ./style.js).
    const grid = el('div', 'cl2-inv-grid');
    setStyle(grid, 'width', GRID_PX_W + 'px');
    setStyle(grid, 'height', GRID_PX_H + 'px');
    panel.appendChild(grid);
    this._gridEl = grid;

    const highlight = el('div', 'cl2-inv-highlight');
    setStyle(highlight, 'position', 'absolute');
    setStyle(highlight, 'display', 'none');
    setStyle(highlight, 'pointerEvents', 'none');
    setStyle(highlight, 'boxSizing', 'border-box');
    grid.appendChild(highlight);
    this._highlightEl = highlight;

    for (let i = 0; i < MAX_INV_CELLS; i++) this._itemSlots[i] = this._buildItemSlotDom(grid);

    // Belt mirror row (09 §3.5's wireframe: "BELT [Q][W][E][R]").
    const beltLabel = el('div', 'cl2-inv-belt-label');
    setStyle(beltLabel, 'position', 'absolute');
    setStyle(beltLabel, 'fontFamily', 'var(--ff-sans)');
    setStyle(beltLabel, 'fontSize', 'var(--t-label-size)');
    setStyle(beltLabel, 'color', 'var(--ink-3)');
    setText(beltLabel, 'BELT');
    panel.appendChild(beltLabel);
    setStyle(beltLabel, 'left', GRID_INSET_X + 'px');
    setStyle(beltLabel, 'top', (GRID_INSET_Y + GRID_PX_H + BELT_ROW_GAP + 14) + 'px');

    for (let i = 0; i < BELT_COUNT; i++) this._beltSlots[i] = this._buildBeltSlotDom(panel, i);

    // Split chip (09 §6.4: "120x44 e3 popup at the cursor").
    const chip = el('div', 'cl2-inv-chip');
    setStyle(chip, 'position', 'absolute');
    setStyle(chip, 'display', 'none');
    setStyle(chip, 'width', '120px');
    setStyle(chip, 'height', '44px');
    setStyle(chip, 'boxSizing', 'border-box');
    setStyle(chip, 'background', 'var(--e3-fill)');
    setStyle(chip, 'border', 'var(--edge)');
    setStyle(chip, 'boxShadow', 'var(--e3-shadow)');
    setStyle(chip, 'padding', '4px 8px');
    setStyle(chip, 'pointerEvents', 'auto');
    this._panelsLayer.appendChild(chip);

    const range = el('input', 'cl2-inv-chip-range');
    range.setAttribute && range.setAttribute('type', 'range');
    setStyle(range, 'width', '72px');
    chip.appendChild(range);
    if (typeof range.addEventListener === 'function') {
      range.addEventListener('input', () => this._onSplitRangeInput());
    }

    const readout = el('span', 'cl2-inv-chip-readout');
    setStyle(readout, 'fontFamily', 'var(--ff-mono)');
    setStyle(readout, 'fontSize', 'var(--t-num-s-size)');
    setStyle(readout, 'color', 'var(--ink-1)');
    setStyle(readout, 'marginLeft', '6px');
    chip.appendChild(readout);

    this._chipEl = chip;
    this._chipRangeEl = range;
    this._chipReadoutEl = readout;

    // Drag ghost — layer 60 (`09 §6.3`), the only thing at that layer.
    const ghost = el('div', 'cl2-inv-ghost');
    setStyle(ghost, 'position', 'absolute');
    setStyle(ghost, 'left', '0');
    setStyle(ghost, 'top', '0');
    setStyle(ghost, 'width', CELL + 'px');
    setStyle(ghost, 'height', CELL + 'px');
    setStyle(ghost, 'display', 'none');
    setStyle(ghost, 'pointerEvents', 'none');
    setStyle(ghost, 'opacity', String(GHOST_OPACITY));
    this._cursorLayer.appendChild(ghost);
    const ghostCanvas = el('canvas', 'cl2-inv-ghost-icon');
    ghostCanvas.width = CELL;
    ghostCanvas.height = CELL;
    setStyle(ghostCanvas, 'width', CELL + 'px');
    setStyle(ghostCanvas, 'height', CELL + 'px');
    ghost.appendChild(ghostCanvas);
    this._ghostEl = ghost;
    this._ghostCanvas = ghostCanvas;
    this._ghostCtx = typeof ghostCanvas.getContext === 'function' ? ghostCanvas.getContext('2d') : null;
  }

  _buildItemSlotDom(grid) {
    const slot = makeItemSlot();
    const wrap = el('div', 'cl2-inv-item');
    setStyle(wrap, 'position', 'absolute');
    setStyle(wrap, 'display', 'none');
    setStyle(wrap, 'boxSizing', 'border-box');
    grid.appendChild(wrap);

    const canvas = el('canvas', 'cl2-inv-item-icon');
    canvas.width = CELL;
    canvas.height = CELL;
    setStyle(canvas, 'position', 'absolute');
    setStyle(canvas, 'left', '2px');
    setStyle(canvas, 'top', '2px');
    setStyle(canvas, 'pointerEvents', 'none');
    wrap.appendChild(canvas);

    const stack = el('div', 'cl2-inv-item-stack');
    setStyle(stack, 'position', 'absolute');
    setStyle(stack, 'right', '2px');
    setStyle(stack, 'bottom', '1px');
    setStyle(stack, 'display', 'none');
    setStyle(stack, 'fontFamily', 'var(--ff-mono)');
    setStyle(stack, 'fontSize', 'var(--t-num-s-size)');
    setStyle(stack, 'color', 'var(--ink-1)');
    setStyle(stack, 'pointerEvents', 'none');
    wrap.appendChild(stack);

    slot.wrapEl = wrap;
    slot.iconCanvas = canvas;
    slot.iconCtx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    slot.stackEl = stack;
    return slot;
  }

  _buildBeltSlotDom(panel, index) {
    const slot = makeBeltSlot();
    const wrap = el('div', 'cl2-inv-belt-slot');
    setStyle(wrap, 'position', 'absolute');
    setStyle(wrap, 'width', BELT_SLOT + 'px');
    setStyle(wrap, 'height', BELT_SLOT + 'px');
    setStyle(wrap, 'boxSizing', 'border-box');
    setStyle(wrap, 'border', '1px solid var(--ash-500)');
    setStyle(wrap, 'background', 'var(--ash-700)');
    panel.appendChild(wrap);

    const canvas = el('canvas', 'cl2-inv-belt-icon');
    canvas.width = BELT_SLOT;
    canvas.height = BELT_SLOT;
    setStyle(canvas, 'position', 'absolute');
    setStyle(canvas, 'left', '0');
    setStyle(canvas, 'top', '0');
    setStyle(canvas, 'pointerEvents', 'none');
    wrap.appendChild(canvas);

    const count = el('div', 'cl2-inv-belt-count');
    setStyle(count, 'position', 'absolute');
    setStyle(count, 'right', '2px');
    setStyle(count, 'bottom', '1px');
    setStyle(count, 'display', 'none');
    setStyle(count, 'fontFamily', 'var(--ff-mono)');
    setStyle(count, 'fontSize', 'var(--t-num-s-size)');
    setStyle(count, 'color', 'var(--ink-1)');
    setStyle(count, 'pointerEvents', 'none');
    wrap.appendChild(count);

    slot.wrapEl = wrap;
    slot.iconCanvas = canvas;
    slot.iconCtx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    slot.countEl = count;
    void index;
    return slot;
  }

  // -------------------------------------------------------------------
  // Layout — computed, never measured
  // -------------------------------------------------------------------

  _syncViewport(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw;
    this._vh = vh;
    this._layoutStatic();
  }

  _layoutStatic() {
    this._panelX = this._vw - PANEL_MARGIN - PANEL_W;
    this._panelY = PANEL_MARGIN;
    setStyle(this._panelEl, 'left', this._panelX + 'px');
    setStyle(this._panelEl, 'top', this._panelY + 'px');

    setStyle(this._gridEl, 'position', 'absolute');
    setStyle(this._gridEl, 'left', GRID_INSET_X + 'px');
    setStyle(this._gridEl, 'top', GRID_INSET_Y + 'px');
    this._gridX = this._panelX + GRID_INSET_X;
    this._gridY = this._panelY + GRID_INSET_Y;

    const beltOriginXRel = GRID_INSET_X + BELT_LABEL_W;
    const beltOriginYRel = GRID_INSET_Y + GRID_PX_H + BELT_ROW_GAP;
    this._beltX = this._panelX + beltOriginXRel;
    this._beltY = this._panelY + beltOriginYRel;
    for (let i = 0; i < BELT_COUNT; i++) {
      const slot = this._beltSlots[i];
      const xRel = beltOriginXRel + i * BELT_PITCH;
      setStyle(slot.wrapEl, 'left', xRel + 'px');
      setStyle(slot.wrapEl, 'top', beltOriginYRel + 'px');
      const rect = this._beltSlotRects[i];
      rect.x = this._panelX + xRel;
      rect.y = this._beltY;
    }
  }

  // -------------------------------------------------------------------
  // Events — pointerdown/move/up on the panel root (captured), keydown for
  // Esc/Enter, window blur cancels a drag same as Esc.
  // -------------------------------------------------------------------

  _bindEvents() {
    const panel = this._panelEl;
    if (typeof panel.addEventListener === 'function') {
      panel.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      panel.addEventListener('pointermove', (e) => this._onPointerMove(e));
      panel.addEventListener('pointerup', (e) => this._onPointerUp(e));
      panel.addEventListener('contextmenu', (e) => { if (e.preventDefault) e.preventDefault(); });
    }
    const doc = (this._ctx && this._ctx.doc) || (typeof document !== 'undefined' ? document : null);
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', (e) => this._onKeyDown(e));
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('blur', () => this._cancelDrag());
    }
  }

  // -------------------------------------------------------------------
  // Region resolution — computed from known geometry, never measured.
  // Returns the shared scratch object (zero allocation).
  // -------------------------------------------------------------------

  _resolveRegion(clientX, clientY) {
    const out = this._regionScratch;
    if (clientX >= this._gridX && clientX < this._gridX + GRID_PX_W &&
        clientY >= this._gridY && clientY < this._gridY + GRID_PX_H) {
      out.region = 'grid';
      out.container = 'inventory';
      out.cellX = Math.floor((clientX - this._gridX) / CELL);
      out.cellY = Math.floor((clientY - this._gridY) / CELL);
      return out;
    }
    for (let i = 0; i < BELT_COUNT; i++) {
      const r = this._beltSlotRects[i];
      if (clientX >= r.x && clientX < r.x + r.w && clientY >= r.y && clientY < r.y + r.h) {
        out.region = 'belt';
        out.container = 'belt';
        out.cellX = i;
        out.cellY = 0;
        return out;
      }
    }
    if (clientX >= this._panelX && clientX < this._panelX + PANEL_W &&
        clientY >= this._panelY && clientY < this._panelY + PANEL_H) {
      out.region = 'panel';
      out.container = null;
      return out;
    }
    out.region = 'outside';
    out.container = null;
    return out;
  }

  // -------------------------------------------------------------------
  // Pointer handling
  // -------------------------------------------------------------------

  _onPointerDown(e) {
    if (!this._visible) return;
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;

    if (this._dragging) {
      // A second click while already carrying an item is always "attempt to
      // drop here" — see file header's interaction-model note.
      this._attemptDropAt(e.clientX, e.clientY);
      return;
    }

    const btn = e.button || 0;
    const region = this._resolveRegion(e.clientX, e.clientY);
    if (region.region !== 'grid' && region.region !== 'belt') {
      this._resetClickTracking();
      return;
    }
    const item = this._items ? this._items.itemAt(region.container, region.cellX, region.cellY) : null;
    if (!item) {
      this._resetClickTracking();
      return;
    }

    if (btn === 2) {
      this._resetClickTracking();
      this._handleRmb(item);
      if (e.preventDefault) e.preventDefault();
      return;
    }
    if (btn !== 0) return;

    if (!e.ctrlKey && !e.shiftKey) {
      const isDouble = this._lastClickItem === item && (this._clock - this._lastClickClock) < DOUBLE_CLICK_WINDOW;
      if (isDouble) {
        this._resetClickTracking();
        this._useConsumable(item);
        return;
      }
      this._lastClickItem = item;
      this._lastClickClock = this._clock;
    } else {
      this._resetClickTracking();
    }

    if (e.shiftKey) {
      this._handleShiftLmb(item);
      return;
    }
    if (e.ctrlKey) {
      this._quickMove(item, region.container);
      return;
    }

    this._beginDrag(item, region.container, e.clientX, e.clientY, e.pointerId);
  }

  _onPointerMove(e) {
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
    if (this._dragging) {
      // "updated on pointermove, at most once per frame" (09 §6.3) — store
      // the latest position; `update()` consumes it once per lateUpdate.
      this._pendingMove = true;
      this._pendingX = e.clientX;
      this._pendingY = e.clientY;
      return;
    }
    // Round 3 (UI-7's finding) — hover-tooltip tracking, same "store the
    // latest position, resolve once per frame" discipline as the drag
    // preview above (§5.7 also wants this: an anchor within 2px of the
    // last one must not re-trigger placement, and `_updateHover` below
    // only calls `showTooltip` on a genuine item CHANGE, never every
    // frame — see that method's own header).
    this._pendingHoverMove = true;
    this._pendingHoverX = e.clientX;
    this._pendingHoverY = e.clientY;
  }

  _onPointerUp(e) {
    if (!this._dragging) return;
    this._attemptDropAt(e.clientX, e.clientY);
  }

  _resetClickTracking() {
    this._lastClickItem = null;
    this._lastClickClock = -1000;
  }

  // -------------------------------------------------------------------
  // Drag lifecycle
  // -------------------------------------------------------------------

  _beginDrag(item, fromContainer, clientX, clientY, pointerId) {
    if (!this._items) return false;
    const base = this._items.base(item.baseId);
    const w = base ? base.invW : 1;
    const h = base ? base.invH : 1;
    const origX = item.grid ? item.grid.x : 0;
    const origY = item.grid ? item.grid.y : 0;

    if (fromContainer === 'belt') {
      this._grabOffX = 0;
      this._grabOffY = 0;
    } else {
      const originX = this._gridX + origX * CELL;
      const originY = this._gridY + origY * CELL;
      this._grabOffX = clamp(Math.floor((clientX - originX) / CELL), 0, w - 1);
      this._grabOffY = clamp(Math.floor((clientY - originY) / CELL), 0, h - 1);
    }

    if (!this._items.takeToCursor(item)) return false;

    this._dragging = true;
    this._dragItem = item;
    this._dragFromContainer = fromContainer;
    this._pointerId = pointerId;

    if (typeof this._panelEl.setPointerCapture === 'function' && pointerId !== undefined) {
      try { this._panelEl.setPointerCapture(pointerId); } catch { /* Node-shim/no-op */ }
    }

    this._ghostDispX = clientX - this._grabOffX * CELL - CELL / 2;
    this._ghostDispY = clientY - this._grabOffY * CELL - CELL / 2;
    this._ghostTargetX = this._ghostDispX;
    this._ghostTargetY = this._ghostDispY;
    this._drawGhostIcon(item, base);
    setStyle(this._ghostEl, 'width', (CELL * w) + 'px');
    setStyle(this._ghostEl, 'height', (CELL * h) + 'px');
    const rarity = item.rarity || 'normal';
    setStyle(this._ghostEl, 'boxShadow', 'inset 0 0 0 2px var(--rarity-' + rarity + '-frame)');
    setStyle(this._ghostEl, 'display', 'block');
    place(this._ghostEl, Math.round(this._ghostDispX * 2) / 2, Math.round(this._ghostDispY * 2) / 2);

    this._updateDragPreview(clientX, clientY);
    this._playAudio('ui.inv.pickup');
    // Round 3 (UI-7's finding, clause 4): never show a tooltip for the item
    // now on the cursor — the drag ghost already represents it.
    this._clearHover();
    return true;
  }

  /** Test-only entry point: simulates a pickup from a container this build
   * has no widget for yet (stash/equipment/vendor/ground — see file
   * header). Performs exactly what `_beginDrag` does at the `items` level
   * (`takeToCursor` + remember the origin string), so the DROP half
   * (`_attemptDropAt`/`_executeMove`) exercised afterwards is real
   * production code, not a second mock. */
  __debugBeginDrag(item, fromContainer) {
    if (!this._items || !this._items.takeToCursor(item)) return false;
    this._dragging = true;
    this._dragItem = item;
    this._dragFromContainer = fromContainer;
    this._grabOffX = 0;
    this._grabOffY = 0;
    const base = this._items.base(item.baseId);
    this._drawGhostIcon(item, base);
    setStyle(this._ghostEl, 'display', 'block');
    this._clearHover();
    return true;
  }

  // -------------------------------------------------------------------
  // Hover tooltip — round 3 (UI-7's finding). `09 §5.7`'s anchor rule for
  // a container cell: "the anchor is the cell's top-right corner
  // (computed, never measured — the grid geometry is known)". The anchor
  // used here is the top-right corner of the HOVERED ITEM's own rectangle
  // (its `invW`/`invH` footprint, not just the single 44px cell the
  // pointer happens to sit over) — that is what stays byte-identical while
  // the pointer wanders within one multi-cell item, which is what makes
  // the change-guard below (`item === this._hoverItem`) actually hold
  // still instead of re-triggering `showTooltip` on every sub-cell.
  // `ui.showTooltip`/`hideTooltip` are only called on a genuine hovered-
  // item TRANSITION — `tooltip.js` itself (UI-5/UI-7, closed, not touched
  // here) additionally recomputes placement only when the anchor moves
  // more than 2px (`ANCHOR_MOVE_EPS`, §5.7), so passing the SAME stable
  // anchor every frame for the same item is inert on that side too.
  // -------------------------------------------------------------------

  /** Resolves the hovered item (if any) from raw pointer coordinates and
   * calls `ui.showTooltip`/`hideTooltip` only on a change. Never called
   * while dragging (`update()` gates on `!this._dragging`) — clause 4. */
  _updateHover(clientX, clientY) {
    if (!this._visible || !this._items) { this._clearHover(); return; }

    const region = this._resolveRegion(clientX, clientY);
    let item = null;
    let anchorX = 0;
    let anchorY = 0;

    if (region.region === 'grid') {
      const candidate = this._items.itemAt('inventory', region.cellX, region.cellY);
      if (candidate && candidate.grid && candidate.grid.container === 'inventory') {
        const base = this._items.base(candidate.baseId);
        const w = base ? base.invW : 1;
        item = candidate;
        anchorX = this._gridX + (candidate.grid.x + w) * CELL;
        anchorY = this._gridY + candidate.grid.y * CELL;
      }
    } else if (region.region === 'belt') {
      const candidate = this._items.itemAt('belt', region.cellX, 0);
      if (candidate) {
        const r = this._beltSlotRects[region.cellX];
        item = candidate;
        anchorX = r.x + BELT_SLOT;
        anchorY = r.y;
      }
    }

    if (item === this._hoverItem) return; // unchanged — no call, no placement thrash
    this._hoverItem = item;
    if (!this._ui) this._ui = safeGet(this._ctx, 'ui');
    if (!this._ui) return;
    if (item) {
      if (typeof this._ui.showTooltip === 'function') this._ui.showTooltip(item, anchorX, anchorY, false);
    } else if (typeof this._ui.hideTooltip === 'function') {
      this._ui.hideTooltip();
    }
  }

  /** Hides the hover tooltip if one is currently shown — drag start, panel
   * close, and dispose all route through this (clause 2/4). */
  _clearHover() {
    if (this._hoverItem === null) return;
    this._hoverItem = null;
    if (!this._ui) this._ui = safeGet(this._ctx, 'ui');
    if (this._ui && typeof this._ui.hideTooltip === 'function') this._ui.hideTooltip();
  }

  _updateDragPreview(clientX, clientY) {
    if (!this._dragging || !this._items) return;
    this._ghostTargetX = clientX - this._grabOffX * CELL - CELL / 2;
    this._ghostTargetY = clientY - this._grabOffY * CELL - CELL / 2;

    const region = this._resolveRegion(clientX, clientY);
    if (region.region === 'grid') {
      const item = this._dragItem;
      const base = this._items.base(item.baseId);
      const w = base ? base.invW : 1;
      const h = base ? base.invH : 1;
      const cellX = region.cellX - this._grabOffX;
      const cellY = region.cellY - this._grabOffY;
      this._paintGridHighlight(cellX, cellY, w, h);
    } else if (region.region === 'belt') {
      this._paintBeltHighlight(region.cellX);
    } else {
      this._hideHighlight();
    }
  }

  _scanOverlap(container, x, y, w, h) {
    // Returns 0 (empty), 1 (exactly one distinct item), 2 (2+ distinct).
    let distinct = 0;
    let seenUid = 0;
    for (let cy = y; cy < y + h; cy++) {
      for (let cx = x; cx < x + w; cx++) {
        const it = this._items.itemAt(container, cx, cy);
        if (!it) continue;
        if (distinct === 0) { distinct = 1; seenUid = it.uid; } else if (it.uid !== seenUid) { distinct = 2; }
      }
    }
    return distinct;
  }

  _paintGridHighlight(cellX, cellY, w, h) {
    let kind;
    if (cellX < 0 || cellY < 0 || cellX + w > GRID_W || cellY + h > GRID_H) {
      kind = 'invalid';
    } else {
      const overlap = this._scanOverlap('inventory', cellX, cellY, w, h);
      kind = overlap === 0 ? 'valid' : overlap === 1 ? 'swap' : 'invalid';
    }
    const x = cellX * CELL;
    const y = cellY * CELL;
    const pw = w * CELL;
    const ph = h * CELL;
    if (kind === this._hlLastKind && x === this._hlLastX && y === this._hlLastY && pw === this._hlLastW && ph === this._hlLastH) return;
    this._hlLastKind = kind;
    this._hlLastX = x; this._hlLastY = y; this._hlLastW = pw; this._hlLastH = ph;
    setStyle(this._highlightEl, 'display', 'block');
    setStyle(this._highlightEl, 'left', x + 'px');
    setStyle(this._highlightEl, 'top', y + 'px');
    setStyle(this._highlightEl, 'width', pw + 'px');
    setStyle(this._highlightEl, 'height', ph + 'px');
    this._applyHighlightColour(kind);
  }

  _paintBeltHighlight(index) {
    const item = this._dragItem;
    const base = this._items.base(item.baseId);
    const isConsumable = !!(base && base.category === 'consumable');
    const occupant = this._items.itemAt('belt', index, 0);
    let kind;
    if (!isConsumable) kind = 'invalid';
    else kind = (!occupant || occupant.uid === item.uid) ? 'valid' : 'swap';
    if (kind === this._hlLastKind && this._hlLastX === 'belt' + index) return;
    this._hlLastKind = kind;
    this._hlLastX = 'belt' + index; this._hlLastY = null; this._hlLastW = null; this._hlLastH = null;
    setStyle(this._highlightEl, 'display', 'none'); // the belt mirror has no highlight box in this build; the slot's own border communicates state (see report)
    void kind;
  }

  _hideHighlight() {
    if (this._hlLastKind === null && this._hlLastX === null) return;
    this._hlLastKind = null; this._hlLastX = null; this._hlLastY = null; this._hlLastW = null; this._hlLastH = null;
    setStyle(this._highlightEl, 'display', 'none');
  }

  _applyHighlightColour(kind) {
    if (kind === 'valid') {
      setStyle(this._highlightEl, 'background', 'rgba(63,143,122,.22)');
      setStyle(this._highlightEl, 'border', '1px solid var(--verdigris)');
    } else if (kind === 'swap') {
      setStyle(this._highlightEl, 'background', 'rgba(224,98,42,.20)');
      setStyle(this._highlightEl, 'border', '1px solid var(--ember)');
    } else {
      setStyle(this._highlightEl, 'background', 'rgba(200,50,42,.20)');
      setStyle(this._highlightEl, 'border', '1px solid var(--danger)');
    }
  }

  /** `09 §6.3`'s drop table + `09 §6.6`'s matrix, dispatched through
   * `matrixAction`. Real for `place` (any container `items.containers.js`
   * already models); guarded-refuse for the five methods `items` does not
   * implement yet (`equip`/`unequip`/`vendorSell`/`vendorBuy`/
   * `dropToGround`/`pickUp`) — see file header.
   * @returns {{ended:boolean}}
   */
  _executeMove(item, fromContainer, toContainer, x, y) {
    if (!this._items || !toContainer) {
      this._playAudio('ui.inv.invalid');
      return { ended: false };
    }
    const action = matrixAction(fromContainer, toContainer);
    if (!action) {
      this._playAudio('ui.inv.invalid');
      return { ended: false };
    }

    switch (action) {
      case 'place': {
        const result = this._items.dropCursor(toContainer, x, y);
        if (result && result.ok) {
          this._playAudio('ui.inv.place');
          if (result.swapped) {
            // 09 §6.3: "the swapped item goes onto the cursor and the drag
            // continues, so a player can chain swaps." The ORIGINAL item
            // was placed successfully; the drag is not over.
            this._dragItem = result.swapped;
            this._dragFromContainer = toContainer;
            return { ended: false };
          }
          return { ended: true };
        }
        this._playAudio('ui.inv.invalid');
        return { ended: false };
      }
      case 'equip':
      case 'unequip':
      case 'vendorSell':
      case 'vendorBuy': {
        if (typeof this._items[action] === 'function') {
          // Real call, forward-compatible — not implemented by `items`
          // today (see file header), so this branch is currently dead in
          // practice but is the correct call the moment it lands.
          const actor = this._player && this._player.actor;
          const ok = action === 'equip' || action === 'unequip'
            ? this._items[action](actor, item, toContainer === 'equipment' ? (item.slot || null) : null)
            : this._items[action](actor, item, 'npc');
          if (ok === true || (ok && ok.ok)) return { ended: true };
        }
        this._toast(this._t('toast.notAvailable'), 'warn');
        return { ended: false };
      }
      case 'dropToGround': {
        if (typeof this._items.dropToGround === 'function') {
          const px = this._player && this._player.actor ? this._player.actor.x : 0;
          const pz = this._player && this._player.actor ? this._player.actor.z : 0;
          this._items.dropToGround(item, px, pz);
          return { ended: true };
        }
        this._toast(this._t('toast.notAvailable'), 'warn');
        return { ended: false };
      }
      case 'pickUp': {
        if (typeof this._items.pickUp === 'function') {
          const actor = this._player && this._player.actor;
          if (this._items.pickUp(actor, item)) return { ended: true };
        }
        this._toast(this._t('toast.notAvailable'), 'warn');
        return { ended: false };
      }
      default:
        this._playAudio('ui.inv.invalid');
        return { ended: false };
    }
  }

  _attemptDropAt(clientX, clientY) {
    const item = this._dragItem;
    const from = this._dragFromContainer;
    const region = this._resolveRegion(clientX, clientY);
    let toContainer = null;
    let x = 0;
    let y = 0;
    if (region.region === 'grid') {
      toContainer = 'inventory';
      x = region.cellX - this._grabOffX;
      y = region.cellY - this._grabOffY;
    } else if (region.region === 'belt') {
      toContainer = 'belt';
      x = region.cellX;
      y = 0;
    } else if (region.region === 'outside') {
      toContainer = 'ground';
    }

    const result = this._executeMove(item, from, toContainer, x, y);
    if (result.ended) {
      this._endDrag();
    } else {
      this._updateDragPreview(clientX, clientY);
    }
  }

  /** Test-only: invokes the same `_executeMove` a real drop would, for a
   * `toContainer` this build has no destination widget for (stash/
   * equipment/vendor — see file header). */
  __debugAttemptDrop(toContainer, x, y) {
    if (!this._dragging) return null;
    const result = this._executeMove(this._dragItem, this._dragFromContainer, toContainer, x, y);
    if (result.ended) this._endDrag();
    return result;
  }

  _endDrag() {
    this._dragging = false;
    this._dragItem = null;
    this._dragFromContainer = null;
    if (typeof this._panelEl.releasePointerCapture === 'function' && this._pointerId !== undefined && this._pointerId !== null) {
      try { this._panelEl.releasePointerCapture(this._pointerId); } catch { /* no-op */ }
    }
    this._pointerId = null;
    setStyle(this._ghostEl, 'display', 'none');
    this._hideHighlight();
  }

  /** `Esc` — `items.returnCursor()`, per `09 §6.3`. Also used by window
   * blur. Returns whether an item was actually returned. */
  _cancelDrag() {
    if (!this._dragging) return false;
    const ok = this._items ? this._items.returnCursor() : false;
    this._endDrag();
    return ok;
  }

  // -------------------------------------------------------------------
  // Modifier moves — 09 §6.4
  // -------------------------------------------------------------------

  _handleRmb(item) {
    if (!this._items) return;
    const base = this._items.base(item.baseId);
    if (base && base.category === 'consumable') {
      this._useConsumable(item);
      return;
    }
    if (typeof this._items.equip === 'function' && typeof this._items.slotsFor === 'function') {
      const actor = this._player && this._player.actor;
      const slots = this._items.slotsFor(item) || [];
      for (let i = 0; i < slots.length; i++) {
        const result = this._items.equip(actor, item, slots[i]);
        if (result && result.ok) return;
      }
    }
    this._toast(this._t('toast.notAvailable'), 'warn');
  }

  _useConsumable(item) {
    if (!this._items) return;
    if (typeof this._items.consume === 'function') {
      this._items.consume(item, 1);
      return;
    }
    this._toast(this._t('toast.notAvailable'), 'warn');
  }

  _quickMove(item, fromContainer) {
    if (!this._items) return;
    if (fromContainer !== 'inventory' && fromContainer !== 'belt') return;
    if (!this._items.takeToCursor(item)) return;
    const target = this._items.findPlacement('stash', item, this._xyScratch);
    const result = target ? this._items.dropCursor('stash', target.x, target.y) : null;
    if (result && result.ok) {
      this._playAudio('ui.inv.place');
      return;
    }
    this._items.returnCursor();
    this._toast(this._t('toast.inventoryFull'), 'warn');
  }

  _handleShiftLmb(item) {
    if (!item || !Number.isInteger(item.quantity) || item.quantity <= 1) return;
    this._openSplitChip(item);
  }

  _openSplitChip(item) {
    this._splitChip.open = true;
    this._splitChip.item = item;
    this._splitChip.max = item.quantity - 1;
    this._splitChip.value = clamp(Math.floor(item.quantity / 2), 1, this._splitChip.max);
    if (this._chipRangeEl.setAttribute) {
      this._chipRangeEl.setAttribute('min', '1');
      this._chipRangeEl.setAttribute('max', String(this._splitChip.max));
    }
    this._chipRangeEl.value = String(this._splitChip.value);
    setText(this._chipReadoutEl, numStr(this._splitChip.value));
    setStyle(this._chipEl, 'display', 'block');
    place(this._chipEl, this._lastPointerX, this._lastPointerY);
  }

  _onSplitRangeInput() {
    if (!this._splitChip.open) return;
    const v = clamp(parseInt(this._chipRangeEl.value, 10) || 1, 1, this._splitChip.max);
    this._splitChip.value = v;
    setText(this._chipReadoutEl, numStr(v));
  }

  _confirmSplitChip() {
    const { item, value } = this._splitChip;
    this._closeSplitChip();
    if (!this._items) return;
    const clone = this._items.splitStack(item, value);
    if (clone && this._items.takeToCursor(clone)) {
      this._dragging = true;
      this._dragItem = clone;
      // A freshly split stack has no origin CELL (`items.splitStack` never
      // sets `.grid` on the clone), but it was split off an inventory
      // stack, so the matrix action it should resolve against is the same
      // as any other inventory-sourced drag (09 §6.4's split-chip flow is
      // scoped to "a stack" in the inventory grid, never the belt/stash).
      this._dragFromContainer = 'inventory';
      this._grabOffX = 0;
      this._grabOffY = 0;
      const base = this._items.base(clone.baseId);
      this._drawGhostIcon(clone, base);
      this._ghostDispX = this._lastPointerX - CELL / 2;
      this._ghostDispY = this._lastPointerY - CELL / 2;
      this._ghostTargetX = this._ghostDispX;
      this._ghostTargetY = this._ghostDispY;
      setStyle(this._ghostEl, 'width', CELL + 'px');
      setStyle(this._ghostEl, 'height', CELL + 'px');
      setStyle(this._ghostEl, 'display', 'block');
      place(this._ghostEl, Math.round(this._ghostDispX * 2) / 2, Math.round(this._ghostDispY * 2) / 2);
    }
  }

  _closeSplitChip() {
    this._splitChip.open = false;
    this._splitChip.item = null;
    setStyle(this._chipEl, 'display', 'none');
  }

  // -------------------------------------------------------------------
  // Sorting — 09 §6.5, undoable for 5s
  // -------------------------------------------------------------------

  _onSortClick() {
    if (!this._items) return;
    let n = 0;
    for (let i = 0; i < this._currentCount; i++) {
      const it = this._currentItems[i];
      if (!it || !it.grid) continue;
      const snap = this._sortSnapshot[n++];
      snap.item = it;
      snap.x = it.grid.x;
      snap.y = it.grid.y;
    }
    const ok = this._items.sortContainer('inventory');
    if (ok) {
      this._sortSnapshotCount = n;
      this._undoRemaining = SORT_UNDO_SECONDS;
      setStyle(this._undoBtnEl, 'display', 'inline-block');
      this._toast(this._t('toast.sorted'), 'info');
    } else {
      this._sortSnapshotCount = 0;
    }
  }

  _onUndoClick() {
    if (this._undoRemaining <= 0 || this._sortSnapshotCount === 0 || !this._items) return;
    const n = this._sortSnapshotCount;
    for (let i = 0; i < n; i++) this._items.remove(this._sortSnapshot[i].item);
    for (let i = 0; i < n; i++) {
      const s = this._sortSnapshot[i];
      this._items.place('inventory', s.item, s.x, s.y);
    }
    this._sortSnapshotCount = 0;
    this._undoRemaining = 0;
    setStyle(this._undoBtnEl, 'display', 'none');
  }

  // -------------------------------------------------------------------
  // Keyboard — Esc (cancel drag / close chip / close panel), Enter (confirm
  // split chip). Native listener, not a poll of `ctx.input` (see file
  // header note on `02-api-contracts.md` §14's "ui may not read ctx.input
  // to discover the key press itself" — that rule is about REBINDABLE
  // actions `player` owns; Esc-cancels-a-drag is this widget's own modal
  // state, the same tier `hotbar.js`'s direct `mousedown` listeners are).
  // -------------------------------------------------------------------

  _onKeyDown(e) {
    if (!this._visible) return;
    const code = e.code || e.key;
    if (code === 'Escape' || code === 'Esc') {
      if (this._splitChip.open) {
        this._closeSplitChip();
        if (e.preventDefault) e.preventDefault();
        return;
      }
      if (this._dragging) {
        this._cancelDrag();
        if (e.preventDefault) e.preventDefault();
        return;
      }
      this.close();
      return;
    }
    if ((code === 'Enter' || code === 'NumpadEnter') && this._splitChip.open) {
      this._confirmSplitChip();
      if (e.preventDefault) e.preventDefault();
    }
  }

  // -------------------------------------------------------------------
  // Icon placeholders — `items.icon()` does not exist yet (ITEM-15). Same
  // placeholder-glyph precedent `hotbar.js` sets for skill/potion icons.
  // -------------------------------------------------------------------

  _drawItemIcon(slot, item, base) {
    const g = slot.iconCtx;
    if (!g || slot.lastDrawnBaseId === item.baseId) return;
    slot.lastDrawnBaseId = item.baseId;
    const w = base ? base.invW : 1;
    const h = base ? base.invH : 1;
    g.clearRect(0, 0, CELL * w, CELL * h);
    g.fillStyle = '#4c4136';
    g.beginPath();
    g.arc((CELL * w) / 2, (CELL * h) / 2, Math.min(CELL * w, CELL * h) / 2 - 4, 0, Math.PI * 2);
    g.fill();
  }

  _drawGhostIcon(item, base) {
    const g = this._ghostCtx;
    if (!g) return;
    const w = base ? base.invW : 1;
    const h = base ? base.invH : 1;
    this._ghostCanvas.width = CELL * w;
    this._ghostCanvas.height = CELL * h;
    setStyle(this._ghostCanvas, 'width', (CELL * w) + 'px');
    setStyle(this._ghostCanvas, 'height', (CELL * h) + 'px');
    g.clearRect(0, 0, CELL * w, CELL * h);
    g.fillStyle = '#4c4136';
    g.beginPath();
    g.arc((CELL * w) / 2, (CELL * h) / 2, Math.min(CELL * w, CELL * h) / 2 - 4, 0, Math.PI * 2);
    g.fill();
    void item;
  }

  _drawBeltIcon(slot, occupied) {
    const g = slot.iconCtx;
    if (!g) return;
    g.clearRect(0, 0, BELT_SLOT, BELT_SLOT);
    if (!occupied) return;
    g.fillStyle = '#3f8f7a';
    g.beginPath();
    g.arc(BELT_SLOT / 2, BELT_SLOT / 2, BELT_SLOT / 2 - 4, 0, Math.PI * 2);
    g.fill();
  }

  _playAudio(id) {
    const audio = safeGet(this._ctx, 'audio');
    if (audio && typeof audio.playUi === 'function') audio.playUi(id);
  }

  // -------------------------------------------------------------------
  // Frame update — presentation only (`ARCHITECTURE.md` rule 5).
  // -------------------------------------------------------------------

  /**
   * @param {number} dt - the scaled game-clock delta (`ctx.time.dt`).
   * @param {object} ctx
   */
  update(dt, ctx) {
    this._ctx = ctx;
    this._clock += dt;
    this._syncViewport(ctx);
    if (!this._items) this._items = safeGet(ctx, 'items');
    if (!this._player) this._player = safeGet(ctx, 'player');
    if (!this._ui) this._ui = safeGet(ctx, 'ui');

    if (this._undoRemaining > 0) {
      this._undoRemaining = Math.max(0, this._undoRemaining - dt);
      if (this._undoRemaining === 0) setStyle(this._undoBtnEl, 'display', 'none');
    }

    if (!this._visible) return;

    this._syncHeader();
    this._syncGridItems();
    this._syncBeltItems();

    if (this._dragging) {
      if (this._pendingMove) {
        this._pendingMove = false;
        this._updateDragPreview(this._pendingX, this._pendingY);
      }
      // `09 §2.6`: drag ghost follow, rate 40, raw clock — this codebase's
      // own precedent (`tooltip.js`'s fade, `hotbar.js`'s own note) treats
      // the passed `dt` as this ticket's stand-in for the raw clock, since
      // `UiSystem#lateUpdate` only threads the scaled `dt` to child modules.
      this._ghostDispX = damp(this._ghostDispX, this._ghostTargetX, GHOST_DAMP_RATE, dt);
      this._ghostDispY = damp(this._ghostDispY, this._ghostTargetY, GHOST_DAMP_RATE, dt);
      place(this._ghostEl, Math.round(this._ghostDispX * 2) / 2, Math.round(this._ghostDispY * 2) / 2);
    } else if (this._pendingHoverMove) {
      // Round 3 — "updated on pointermove, at most once per frame", the
      // same discipline the drag preview above already follows.
      this._pendingHoverMove = false;
      this._updateHover(this._pendingHoverX, this._pendingHoverY);
    }
  }

  _syncHeader() {
    const free = this._items ? this._items.freeCells('inventory') : 0;
    if (free !== this._lastFree) {
      this._lastFree = free;
      setText(this._capTextEl, numStr(free) + ' / ' + numStr(GRID_W * GRID_H) + ' ' + this._t('inv.free'));
    }
    // `hudState(out)` writes every `HudState` field unconditionally,
    // including the fixed-length `cooldowns`/`hotbar`/`belt` arrays
    // (`01-data-model.md` §13's literal) — a minimal `{gold}` scratch
    // crashes it. Calling with no argument falls back to `player`'s own
    // preallocated `_hudScratch` (`02-api-contracts.md:1189`'s documented
    // no-`out` form), which already carries the full shape; this file only
    // ever reads `.gold` off the result, never retains the reference.
    const gold = (this._player && typeof this._player.hudState === 'function')
      ? this._player.hudState().gold
      : 0;
    if (gold !== this._lastGold) {
      this._lastGold = gold;
      setText(this._goldTextEl, this._t('hud.gold') + ' ' + numStr(gold));
    }
  }

  _syncGridItems() {
    if (!this._items) return;
    let count = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const it = this._items.itemAt('inventory', x, y);
        if (!it || !it.grid || it.grid.x !== x || it.grid.y !== y) continue;
        if (count < MAX_INV_CELLS) this._currentItems[count++] = it;
      }
    }
    this._currentCount = count;

    for (let i = 0; i < MAX_INV_CELLS; i++) {
      const slot = this._itemSlots[i];
      const item = i < count ? this._currentItems[i] : null;
      this._applyItemSlot(slot, item);
    }
  }

  _applyItemSlot(slot, item) {
    if (!item) {
      if (slot.lastVisible) {
        slot.lastVisible = false;
        setStyle(slot.wrapEl, 'display', 'none');
      }
      slot.item = null;
      return;
    }
    const base = this._items.base(item.baseId);
    const w = base ? base.invW : 1;
    const h = base ? base.invH : 1;
    setStyle(slot.wrapEl, 'left', (item.grid.x * CELL) + 'px');
    setStyle(slot.wrapEl, 'top', (item.grid.y * CELL) + 'px');
    setStyle(slot.wrapEl, 'width', (w * CELL) + 'px');
    setStyle(slot.wrapEl, 'height', (h * CELL) + 'px');
    const rarity = item.rarity || 'normal';
    setStyle(slot.wrapEl, 'boxShadow', 'inset 0 0 0 1px var(--rarity-' + rarity + '-frame)');
    if (!slot.lastVisible) {
      slot.lastVisible = true;
      setStyle(slot.wrapEl, 'display', 'block');
    }
    if (item.quantity > 1) {
      setText(slot.stackEl, numStr(item.quantity));
      setStyle(slot.stackEl, 'display', 'block');
    } else {
      setStyle(slot.stackEl, 'display', 'none');
    }
    this._drawItemIcon(slot, item, base);
    slot.item = item;
  }

  _syncBeltItems() {
    if (!this._items) return;
    for (let i = 0; i < BELT_COUNT; i++) {
      const slot = this._beltSlots[i];
      const item = this._items.itemAt('belt', i, 0);
      const count = item ? item.quantity : 0;
      if (count === slot.lastCount) continue;
      slot.lastCount = count;
      if (count <= 0) {
        setStyle(slot.countEl, 'display', 'none');
      } else {
        setText(slot.countEl, '×' + numStr(count));
        setStyle(slot.countEl, 'display', 'block');
      }
      slot.lastDrawnBaseId = item ? undefined : slot.lastDrawnBaseId; // force redraw on occupant change
      this._drawBeltIcon(slot, count > 0);
    }
  }

  // -------------------------------------------------------------------
  // Public — open/close/toggle (02-api-contracts.md §14)
  // -------------------------------------------------------------------

  open() {
    if (this._visible) return;
    this._visible = true;
    setStyle(this._panelEl, 'display', 'block');
  }

  close() {
    if (!this._visible) return;
    this._cancelDrag();
    this._closeSplitChip();
    this._clearHover(); // round 3 (UI-7's finding, clause 2): the panel closing hides it too
    this._visible = false;
    setStyle(this._panelEl, 'display', 'none');
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
    if (this._chipEl && this._chipEl.remove) this._chipEl.remove();
    this._chipEl = null;
    if (this._ghostEl && this._ghostEl.remove) this._ghostEl.remove();
    this._ghostEl = null;
  }

  // -------------------------------------------------------------------
  // Dev/test-only inspection — double-underscore, not part of
  // `02-api-contracts.md` (rule 7), matching hud.js/hotbar.js's own
  // convention for this tier.
  // -------------------------------------------------------------------

  /** Test-only: builds a plain event-like object and calls the exact
   * production handler `_onPointerDown` uses — the Node DOM shim
   * (`./util.js#resolveDocument`) does not implement `addEventListener`, so
   * a real `PointerEvent` cannot be dispatched under `node --test`; this is
   * the same "real code path, synthetic trigger" precedent
   * `hotbar.js#pressSlot`/`pressBeltSlot` already set for their own
   * dev/test-only entry points. `opts`: `{button, ctrlKey, shiftKey,
   * altKey, pointerId}`. */
  __simulatePointerDown(clientX, clientY, opts = {}) {
    this._onPointerDown({
      clientX, clientY,
      button: opts.button || 0,
      ctrlKey: !!opts.ctrlKey,
      shiftKey: !!opts.shiftKey,
      altKey: !!opts.altKey,
      pointerId: opts.pointerId === undefined ? 1 : opts.pointerId,
      preventDefault() {},
    });
  }

  __simulatePointerMove(clientX, clientY) {
    this._onPointerMove({ clientX, clientY, preventDefault() {} });
  }

  __simulatePointerUp(clientX, clientY, opts = {}) {
    this._onPointerUp({
      clientX, clientY,
      button: opts.button || 0,
      pointerId: opts.pointerId === undefined ? 1 : opts.pointerId,
      preventDefault() {},
    });
  }

  __simulateKeyDown(code) {
    this._onKeyDown({ code, preventDefault() {} });
  }

  __isDragging() {
    return this._dragging;
  }

  /** Round 3 — the item the hover-tooltip machinery currently believes is
   * hovered (`null` when none). */
  __hoverItem() {
    return this._hoverItem;
  }

  __dragItem() {
    return this._dragItem;
  }

  __highlight() {
    return { kind: this._hlLastKind, x: this._hlLastX, y: this._hlLastY, w: this._hlLastW, h: this._hlLastH };
  }

  __gridOrigin() {
    return { x: this._gridX, y: this._gridY };
  }

  __beltSlotRect(index) {
    return this._beltSlotRects[index];
  }

  __panelRect() {
    return { x: this._panelX, y: this._panelY, w: PANEL_W, h: PANEL_H };
  }

  __undoRemaining() {
    return this._undoRemaining;
  }

  __splitChipState() {
    return { open: this._splitChip.open, value: this._splitChip.value, max: this._splitChip.max };
  }

  __nodeCountRoot() {
    return this._panelEl;
  }
}
