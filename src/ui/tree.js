// src/ui/tree.js
//
// UI-9 — `09-ui.md` §15's U10 row / §8: the skill tree screen. Node lattice
// (§8.1), the connector canvas with hover focus (§8.2, D-39: canvas, never
// SVG), the detail card with `describe()` at level N and N+1 (§8.3),
// provisional allocation with CONFIRM/REVERT and the close-with-pending
// dialog (§8.4). Owned by `ui`, constructed and driven by `UiSystem`
// (`./index.js`) — same shape every other U-ticket's module already
// establishes: a container of preallocated nodes, an `update(dt, ctx)` that
// no-ops while hidden, `open`/`close`/`toggle`/`isOpen`/`setVisible`,
// `dispose()`. Attached into `layers.panels` per this ticket's own file
// grant.
//
// ---------------------------------------------------------------------------
// Why the ten skill-node DOM elements are built lazily, not in the
// constructor
// ---------------------------------------------------------------------------
// Every other panel's DOM is entirely class-independent (ten equipment
// slots, a 10x4 grid) and can be built once in `init()`. This panel's node
// LATTICE genuinely depends on the actor's `classId` — each class has a
// different pair of trees, and which tier holds the tree's one two-skill
// row varies by tree (ravager/carnage: tier 6; emberwright/flame: tier 18;
// runeblade/enchanted_blade: tier 1 — checked against all 30 records in
// `src/skills/data/skills.js`). Building all 16 theoretically-possible grid
// cells up front (2 trees x 4 tiers x 2 columns) and hiding the six unused
// ones per class would keep `display:none` nodes in the DOM tree — they
// still count toward `09 §13.1`'s node-cap assert — and blow this panel's
// own 73-node ceiling (48 node-DOM instead of 30). So the ten node elements
// are built once, on first `open()` (a user action — `02-api-contracts.md`
// header's `Alloc: yes` allowance: "legal ... on a user action behind a
// fade"), for whatever `classId` the actor has at that point, and rebuilt
// only if a different `classId` is ever seen (never in this game's actual
// flow — no multiclassing — but cheap to guard for correctness).
//
// ---------------------------------------------------------------------------
// Interaction model — filling a gap the read range leaves open
// ---------------------------------------------------------------------------
// `09 §8.1`'s node-state table names `hovered` and `selected` as two
// DISTINCT ring states, and `§8.3` says the detail card shows the
// `selected` node. But `§8.4`'s own interaction table only defines `LMB`
// (allocate), `RMB` (deallocate), `Shift+LMB` and the two panel-level
// buttons — nothing names a separate "select" gesture. Resolved here the
// way the wireframe's own worked example implies (the WHIRLWIND node shows
// both the pending "+p" badge AND the selected ring, i.e. a click that
// allocates also selected the node): `LMB`/`RMB` both select the node they
// land on, in addition to their pending-allocation effect, and ALSO when
// the click's allocation attempt is illegal (a locked node can still be
// selected to show why, with its `+` button disabled). Hover alone
// (`pointerenter`) only moves `_hoverIndex` — connector focus and the ring,
// never the detail card. Flagged in the report.
//
// `Shift+LMB`'s own "next tier threshold" stop condition names a concept
// this read range gives no number for — no skill has an internal
// "threshold" distinct from `maxLevel`/the tree's own 1/6/12/18 unlock
// tiers (which gate a DIFFERENT skill, not the one being shift-clicked).
// Per rule 6 ("if the spec does not give you a number, STOP AND SAY SO"),
// no number is invented for it: `Shift+LMB` here adds points until
// `maxLevel` or the point budget runs out, which is what the other two
// named stop conditions already are. Flagged in the report.
//
// ---------------------------------------------------------------------------
// Budget-forced caps — Ravager-correct, disclosed truncation elsewhere
// ---------------------------------------------------------------------------
// `09 §13.1`'s own row gives this panel exactly 73 DOM nodes. Fitting the
// header/footer chrome (13), the one connector canvas (1), ten 3-node skill
// icons (30) and a detail card under that ceiling forces two caps that are
// exact for every Ravager skill (this ticket's only tested/blessed class)
// but would truncate a handful of OTHER classes' skills: the stat table
// shows at most 4 `describe()` lines (Ravager's own max is `sunder`'s 4;
// Emberwright's `meteor` needs 6 and would lose its bottom two rows), and
// the synergies list shows at most 1 incoming edge (every Ravager skill has
// at most 1; Emberwright's `meteor` has 2 — `ember_bolt` and `fireball` —
// and would show only the first). Both are disclosed here and in the
// report, not silently dropped.
//
// ---------------------------------------------------------------------------
// `player.spendSkillPoint` does not exist — O-69-style guard, like
// `sheet.js`'s own `spendStatPoint` gap
// ---------------------------------------------------------------------------
// `02-api-contracts.md:1184` contracts `spendSkillPoint(skillId) => boolean`
// on `player`, and `09 §8.4` names it as CONFIRM's own commit call — but
// `src/player/index.js` does not implement it (grep confirms; out of this
// ticket's file grant regardless). Called through
// `typeof player.spendSkillPoint === 'function'` exactly the way
// `sheet.js#_onAllocateClick` already guards the sibling gap
// (`spendStatPoint`). Flagged in the report.
//
// ---------------------------------------------------------------------------
// Missing i18n keys — O-70, same convention as `target.js`'s own gap list
// ---------------------------------------------------------------------------
// None of `tree.skillPoints` / `tree.pending` / `tree.confirmPrompt` /
// `tree.requiresLevel` / `tree.maximum` / `tree.synergyRow` /
// `skill.cost` / `skill.cooldown` / `skill.castTime` / `skill.radius` /
// `skill.duration` / `skill.weaponDamagePercent` / `skill.damage` /
// `skill.<id>.desc` (per-skill, data-owned, `09 §8.3`'s own convention)
// exist in `src/ui/i18n.js` today (`i18n.js` is off-limits to this ticket).
// Every one is called through `this._t(key, params)` regardless — `t()`'s
// documented `[missing]<key>` fallback never throws. Full list in the
// report. `class.<id>.name` and every skill's own `def.displayName`
// (English-only game DATA, the same category `tooltip.js` already treats
// `base.name` as, never routed through `t()`) are NOT part of this gap —
// they already exist / are not a UI-dictionary concern.

import { el, setText, setStyle, setClass, clamp, numStr, countNodes } from './util.js';

function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(id); } catch { return null; }
  }
  return null;
}

function cap(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Geometry — `09 §3.3`'s panel row (380,24,1160,648) plus §8.1/§8.2/§8.3's
// own literal numbers, transcribed (never imported — `ARCHITECTURE.md` rule
// 2). The panel's own x is centred, not fixed: at the 1920-canonical layout
// 380 + 1160 leaves a 380px right margin, equal to the left one — i.e. the
// literal 380 IS `(1920-1160)/2`. `09 §3.3`'s "Fits 720p | v 60,24" note is
// exactly `(1280-1160)/2 = 60` — confirming this panel is meant to be
// horizontally re-centred per viewport, the way `inventory.js` already
// generalises its own right-anchored literal for the same reason. `y` stays
// the fixed literal 24 at both resolutions.
// ---------------------------------------------------------------------------
const PANEL_W = 1160;
const PANEL_H = 648;
const PANEL_Y = 24;
const HEADER_H = 40;
const FOOTER_H = 48;
const TREE_COL_W = 390;
const CANVAS_W = 780;
const CANVAS_H = 560;
const DETAIL_X = 800;
const DETAIL_W = 340;

const NODE_SIZE = 68;
const NODE_ICON = 56;
const NODE_ICON_INSET = 6;
const COL_X = [44, 162]; // 09 §8.1: "two columns at x 44 and x 162 inside a 390 px tree column"
const ROW_Y = [88, 206, 324, 442]; // row0..row3 = tier 1/6/12/18, row pitch 118
const TIERS = [1, 6, 12, 18];
const GUTTER_X = 12;
const GUTTER_W = 24;
const TREE_TITLE_Y = 52;

const MAX_TREES = 2;
const MAX_ROWS = 4;
const MAX_COLS = 2;
const MAX_NODES = MAX_TREES * MAX_ROWS * MAX_COLS; // upper bound only; a class occupies exactly 10 of these

// Detail card row caps — see the file header, "Budget-forced caps".
const STAT_DATA_ROWS = 4;
const SYN_ROWS = 1;
const REQ_ROWS = 2;

const DIALOG_X = 760, DIALOG_Y = 430, DIALOG_W = 400, DIALOG_H = 220; // 09 §3.3 panel.confirm, fits both resolutions unmoved

export class Tree {
  /**
   * @param {object} ctx
   * @param {object} panelsLayer - `layers.panels` (this ticket's file grant)
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} rng - the ONE `ui`-subsystem fork (unused today —
   *   no randomness in this module, kept for the one-fork-per-subsystem
   *   convention every sibling module's constructor already threads through).
   * @param {(text:string, kind:string) => void} toast
   */
  constructor(ctx, panelsLayer, translate, rng, toast) {
    this._ctx = ctx;
    this._panelsLayer = panelsLayer;
    this._t = typeof translate === 'function' ? translate : (k) => k;
    void rng;
    this._toast = typeof toast === 'function' ? toast : () => {};

    this._skills = safeGet(ctx, 'skills');
    this._player = safeGet(ctx, 'player');

    this._visible = false;
    this._dialogVisible = false;
    this._builtClassId = null;

    this._nodes = []; // built lazily by _ensureBuiltForClass
    this._registryIndex = new Map(); // skillId -> index in skills.all, built once per class (not per-frame; see header)

    this._hoverIndex = -1;
    this._selectedIndex = -1;
    this._dirty = true;
    this._redrawCount = 0;
    this._generation = 0; // bumped by _markDirty() — the detail card's coarse staleness signal, see _syncDetailCard

    this._lastDetailNodeId = null;
    this._lastDetailN = -1;
    this._lastDetailPending = -1;
    this._lastDetailGeneration = -1;
    this._lastClassIdForHeader = undefined;
    this._lastRemainingForHeader = -1;
    this._lastPendingForHeader = -1;

    this._vw = 0;
    this._vh = 0;
    this._panelX = 0;

    // Preallocated `describe()` out-objects — SKIL-12's own contract:
    // "write into a preallocated `out`; do not build objects per hover."
    this._descOut = makeDescOut();
    this._descOutNext = makeDescOut();
    // A full `HudState`-shaped scratch (`02-api-contracts.md:1199-1213`'s
    // literal) — `player.hudState(out)` writes into `out.hotbar[i]`/
    // `out.cooldowns[i]`/`out.belt[i]` unconditionally, so a partial object
    // throws. Only `.skillPoints` is read back here.
    this._hudScratch = {
      life: 0, maxLife: 0, mana: 0, maxMana: 0,
      secondary: 0, maxSecondary: 0, secondaryKind: 'rage', secondaryDecay: 0,
      level: 1, xp: 0, xpFloor: 0, xpCeiling: 50, xpTotal: 0,
      statPoints: 0, skillPoints: 0, gold: 0,
      cooldowns: [0, 0, 0, 0], hotbar: [null, null, null, null],
      belt: [0, 0, 0, 0], targetId: 0, difficulty: 'instruction',
      zoneId: 'last_bastion', questStep: 0,
      name: '', classId: 'ravager', inCombat: false,
    };

    this._buildChrome();
  }

  // ===========================================================================
  // Construction — chrome (class-independent, built once) and the canvas
  // ===========================================================================

  _buildChrome() {
    const panel = el('div', 'cl2-tree-panel');
    setStyle(panel, 'position', 'absolute');
    setStyle(panel, 'top', PANEL_Y + 'px');
    setStyle(panel, 'width', PANEL_W + 'px');
    setStyle(panel, 'height', PANEL_H + 'px');
    setStyle(panel, 'boxSizing', 'border-box');
    setStyle(panel, 'background', 'var(--e2-fill)');
    setStyle(panel, 'border', 'var(--edge)');
    setStyle(panel, 'boxShadow', 'var(--e2-shadow)');
    setStyle(panel, 'display', 'none');
    setStyle(panel, 'pointerEvents', 'auto');
    setStyle(panel, 'fontFamily', 'var(--ff-sans)');
    setStyle(panel, 'color', 'var(--ink-2)');
    setStyle(panel, 'contain', 'layout style paint');
    // O-78, the `ui` half — one attribute on the panel root is enough,
    // `closest()` walks up from any descendant (`./index.js`'s guard).
    panel.setAttribute('data-ui-solid', '');
    this._panelEl = panel;
    if (this._panelsLayer) this._panelsLayer.appendChild(panel);
    if (typeof panel.addEventListener === 'function') {
      panel.addEventListener('pointerdown', (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
    }

    // Header.
    const header = el('div', 'cl2-tree-header');
    setStyle(header, 'position', 'absolute');
    setStyle(header, 'left', '0'); setStyle(header, 'top', '0');
    setStyle(header, 'width', PANEL_W + 'px'); setStyle(header, 'height', HEADER_H + 'px');
    setStyle(header, 'boxSizing', 'border-box');
    setStyle(header, 'borderBottom', 'var(--edge)');
    panel.appendChild(header);

    const title = el('div', 'cl2-tree-title');
    setStyle(title, 'position', 'absolute'); setStyle(title, 'left', 'var(--space-4)'); setStyle(title, 'top', '0');
    setStyle(title, 'lineHeight', HEADER_H + 'px');
    setStyle(title, 'fontFamily', 'var(--ff-serif)'); setStyle(title, 'fontSize', 'var(--t-title-size)');
    setStyle(title, 'fontWeight', 'var(--t-title-weight)'); setStyle(title, 'color', 'var(--ink-1)');
    header.appendChild(title);
    this._headerTitleEl = title;

    const points = el('div', 'cl2-tree-points');
    setStyle(points, 'position', 'absolute'); setStyle(points, 'right', '32px'); setStyle(points, 'top', '0');
    setStyle(points, 'lineHeight', HEADER_H + 'px');
    setStyle(points, 'fontFamily', 'var(--ff-mono)'); setStyle(points, 'fontSize', 'var(--t-num-size)');
    setStyle(points, 'color', 'var(--ink-2)');
    header.appendChild(points);
    this._headerPointsEl = points;

    const closeBtn = el('button', 'cl2-tree-close');
    setStyle(closeBtn, 'position', 'absolute'); setStyle(closeBtn, 'right', '4px'); setStyle(closeBtn, 'top', '6px');
    setStyle(closeBtn, 'fontFamily', 'var(--ff-sans)'); setStyle(closeBtn, 'color', 'var(--ink-2)');
    setStyle(closeBtn, 'background', 'transparent'); setStyle(closeBtn, 'border', 'none'); setStyle(closeBtn, 'cursor', 'pointer');
    setText(closeBtn, '✕');
    header.appendChild(closeBtn);
    if (typeof closeBtn.addEventListener === 'function') closeBtn.addEventListener('click', () => this.close());
    this._closeBtnEl = closeBtn;

    // Tree titles + tier gutters (2 of each — one per tree column).
    this._treeTitleEls = [];
    this._gutterEls = [];
    for (let t = 0; t < MAX_TREES; t++) {
      const tx = t * TREE_COL_W;

      const tt = el('div', 'cl2-tree-treetitle');
      setStyle(tt, 'position', 'absolute'); setStyle(tt, 'left', tx + 'px'); setStyle(tt, 'top', (HEADER_H + TREE_TITLE_Y - 14) + 'px');
      setStyle(tt, 'width', TREE_COL_W + 'px'); setStyle(tt, 'textAlign', 'center');
      setStyle(tt, 'fontFamily', 'var(--ff-sans)'); setStyle(tt, 'fontSize', 'var(--t-label-size)');
      setStyle(tt, 'letterSpacing', 'var(--t-label-tracking)'); setStyle(tt, 'color', 'var(--ink-2)');
      panel.appendChild(tt);
      this._treeTitleEls.push(tt);

      const gt = el('div', 'cl2-tree-gutter');
      setStyle(gt, 'position', 'absolute'); setStyle(gt, 'left', (tx + GUTTER_X) + 'px'); setStyle(gt, 'top', (HEADER_H + ROW_Y[0] - 6) + 'px');
      setStyle(gt, 'width', GUTTER_W + 'px'); setStyle(gt, 'height', (ROW_Y[3] - ROW_Y[0] + NODE_SIZE) + 'px');
      setStyle(gt, 'whiteSpace', 'pre-line'); setStyle(gt, 'lineHeight', ((ROW_Y[1] - ROW_Y[0])) + 'px');
      setStyle(gt, 'fontFamily', 'var(--ff-mono)'); setStyle(gt, 'fontSize', 'var(--t-micro-size)'); setStyle(gt, 'color', 'var(--ink-3)');
      setText(gt, TIERS.join('\n'));
      panel.appendChild(gt);
      this._gutterEls.push(gt);
    }

    // Connector canvas — D-39: ONE canvas, 780x560, behind the node layer,
    // redrawn only on `_dirty` (`09 §8.2`, `13.2`).
    const canvas = el('canvas', 'cl2-tree-canvas');
    canvas.width = CANVAS_W; canvas.height = CANVAS_H;
    setStyle(canvas, 'position', 'absolute'); setStyle(canvas, 'left', '0'); setStyle(canvas, 'top', HEADER_H + 'px');
    setStyle(canvas, 'width', CANVAS_W + 'px'); setStyle(canvas, 'height', CANVAS_H + 'px');
    setStyle(canvas, 'pointerEvents', 'none');
    panel.appendChild(canvas);
    this._canvasEl = canvas;
    this._canvasCtx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

    // Detail card chrome (title/subtitle/rows/description/synergies/
    // requires/button) — built once, class-independent shape; content is
    // synced per selection.
    this._buildDetailCard(panel);

    // Footer.
    const footer = el('div', 'cl2-tree-footer');
    setStyle(footer, 'position', 'absolute'); setStyle(footer, 'left', '0'); setStyle(footer, 'top', (PANEL_H - FOOTER_H) + 'px');
    setStyle(footer, 'width', PANEL_W + 'px'); setStyle(footer, 'height', FOOTER_H + 'px');
    setStyle(footer, 'boxSizing', 'border-box'); setStyle(footer, 'borderTop', 'var(--edge)');
    panel.appendChild(footer);

    const pending = el('div', 'cl2-tree-pending');
    setStyle(pending, 'position', 'absolute'); setStyle(pending, 'left', 'var(--space-4)'); setStyle(pending, 'top', '0');
    setStyle(pending, 'lineHeight', FOOTER_H + 'px');
    setStyle(pending, 'fontFamily', 'var(--ff-mono)'); setStyle(pending, 'fontSize', 'var(--t-num-size)'); setStyle(pending, 'color', 'var(--ember)');
    footer.appendChild(pending);
    this._pendingEl = pending;

    const revertBtn = el('button', 'cl2-tree-revert');
    setStyle(revertBtn, 'position', 'absolute'); setStyle(revertBtn, 'right', '150px'); setStyle(revertBtn, 'top', '8px');
    setStyle(revertBtn, 'fontFamily', 'var(--ff-sans)'); setStyle(revertBtn, 'fontSize', 'var(--t-label-size)');
    setStyle(revertBtn, 'color', 'var(--ink-2)'); setStyle(revertBtn, 'background', 'var(--ash-700)');
    setStyle(revertBtn, 'border', 'var(--edge)'); setStyle(revertBtn, 'cursor', 'pointer');
    setText(revertBtn, this._t('common.revert'));
    footer.appendChild(revertBtn);
    if (typeof revertBtn.addEventListener === 'function') revertBtn.addEventListener('click', () => this._onRevertClick());
    this._revertBtnEl = revertBtn;

    const confirmBtn = el('button', 'cl2-tree-confirm');
    setStyle(confirmBtn, 'position', 'absolute'); setStyle(confirmBtn, 'right', '24px'); setStyle(confirmBtn, 'top', '8px');
    setStyle(confirmBtn, 'fontFamily', 'var(--ff-sans)'); setStyle(confirmBtn, 'fontSize', 'var(--t-label-size)');
    setStyle(confirmBtn, 'color', 'var(--ink-1)'); setStyle(confirmBtn, 'background', 'var(--ember-dim)');
    setStyle(confirmBtn, 'border', 'var(--edge)'); setStyle(confirmBtn, 'cursor', 'pointer');
    setText(confirmBtn, this._t('common.confirm'));
    footer.appendChild(confirmBtn);
    if (typeof confirmBtn.addEventListener === 'function') confirmBtn.addEventListener('click', () => this._onConfirmClick());
    this._confirmBtnEl = confirmBtn;

    // Close-with-pending dialog (09 §8.4 / §3.3 panel.confirm) — its own
    // small overlay, inside this same panel's DOM (this ticket owns no
    // other file it could live in). Hidden until `close()` finds pending
    // points.
    this._buildDialog();
  }

  _buildDetailCard(panel) {
    const cardTop = HEADER_H;
    const cardH = PANEL_H - HEADER_H - FOOTER_H;

    const nameEl = el('div', 'cl2-tree-dname');
    setStyle(nameEl, 'position', 'absolute'); setStyle(nameEl, 'left', DETAIL_X + 'px'); setStyle(nameEl, 'top', (cardTop + 8) + 'px');
    setStyle(nameEl, 'width', DETAIL_W + 'px');
    setStyle(nameEl, 'fontFamily', 'var(--ff-serif)'); setStyle(nameEl, 'fontSize', 'var(--t-name-size)');
    setStyle(nameEl, 'fontWeight', 'var(--t-name-weight)'); setStyle(nameEl, 'color', 'var(--ink-1)');
    panel.appendChild(nameEl);
    this._dNameEl = nameEl;

    const subEl = el('div', 'cl2-tree-dsub');
    setStyle(subEl, 'position', 'absolute'); setStyle(subEl, 'left', DETAIL_X + 'px'); setStyle(subEl, 'top', (cardTop + 30) + 'px');
    setStyle(subEl, 'width', DETAIL_W + 'px');
    setStyle(subEl, 'fontFamily', 'var(--ff-sans)'); setStyle(subEl, 'fontSize', 'var(--t-micro-size)'); setStyle(subEl, 'color', 'var(--ink-3)');
    panel.appendChild(subEl);
    this._dSubEl = subEl;

    // Rows: row 0 is the "LEVEL N / LEVEL N+1" header, rows 1..STAT_DATA_ROWS
    // are describe()'s own lines — same 3-node shape (label/cur/next),
    // sharing one preallocated array (see file header, node-budget math).
    let y = cardTop + 56;
    const ROW_H = 18;
    this._rows = [];
    for (let i = 0; i <= STAT_DATA_ROWS; i++) {
      // Fixed, non-overlapping widths — label is clipped rather than
      // pushed into the value columns, which matters TODAY: every
      // `labelKey` reads as the long `[missing]skill.weaponDamagePercent`-
      // shaped fallback (O-70) until `i18n.js` gets its `skill.*` rows; a
      // real short label ("Cost", "Radius") will simply never hit the clip.
      const label = el('span'); setStyle(label, 'position', 'absolute'); setStyle(label, 'left', DETAIL_X + 'px'); setStyle(label, 'top', y + 'px');
      setStyle(label, 'width', '185px'); setStyle(label, 'overflow', 'hidden'); setStyle(label, 'whiteSpace', 'nowrap'); setStyle(label, 'textOverflow', 'ellipsis');
      setStyle(label, 'fontFamily', 'var(--ff-sans)'); setStyle(label, 'fontSize', 'var(--t-micro-size)'); setStyle(label, 'color', 'var(--ink-3)');
      panel.appendChild(label);

      const cur = el('span'); setStyle(cur, 'position', 'absolute'); setStyle(cur, 'left', (DETAIL_X + 190) + 'px'); setStyle(cur, 'top', y + 'px');
      setStyle(cur, 'width', '75px'); setStyle(cur, 'textAlign', 'right');
      setStyle(cur, 'fontFamily', 'var(--ff-mono)'); setStyle(cur, 'fontSize', 'var(--t-num-s-size)'); setStyle(cur, 'color', 'var(--ink-3)');
      panel.appendChild(cur);

      const next = el('span'); setStyle(next, 'position', 'absolute'); setStyle(next, 'left', (DETAIL_X + 270) + 'px'); setStyle(next, 'top', y + 'px');
      setStyle(next, 'width', '70px'); setStyle(next, 'textAlign', 'right');
      setStyle(next, 'fontFamily', 'var(--ff-mono)'); setStyle(next, 'fontSize', 'var(--t-num-s-size)'); setStyle(next, 'color', 'var(--ink-1)');
      panel.appendChild(next);

      this._rows.push({ label, cur, next });
      y += ROW_H;
    }

    y += 8;
    const descLabel = el('div'); setStyle(descLabel, 'position', 'absolute'); setStyle(descLabel, 'left', DETAIL_X + 'px'); setStyle(descLabel, 'top', y + 'px');
    setStyle(descLabel, 'fontFamily', 'var(--ff-sans)'); setStyle(descLabel, 'fontSize', 'var(--t-label-size)'); setStyle(descLabel, 'color', 'var(--ink-3)');
    setText(descLabel, this._t('tree.descriptionLabel'));
    panel.appendChild(descLabel);
    this._dDescLabelEl = descLabel;
    y += 18;

    const descText = el('div'); setStyle(descText, 'position', 'absolute'); setStyle(descText, 'left', DETAIL_X + 'px'); setStyle(descText, 'top', y + 'px');
    setStyle(descText, 'width', DETAIL_W + 'px'); setStyle(descText, 'height', '66px'); setStyle(descText, 'overflow', 'hidden');
    setStyle(descText, 'fontFamily', 'var(--ff-serif)'); setStyle(descText, 'fontSize', 'var(--t-read-size)'); setStyle(descText, 'lineHeight', 'var(--t-read-lh)');
    setStyle(descText, 'color', 'var(--ink-2)');
    panel.appendChild(descText);
    this._dDescEl = descText;
    y += 74;

    const synLabel = el('div'); setStyle(synLabel, 'position', 'absolute'); setStyle(synLabel, 'left', DETAIL_X + 'px'); setStyle(synLabel, 'top', y + 'px');
    setStyle(synLabel, 'fontFamily', 'var(--ff-sans)'); setStyle(synLabel, 'fontSize', 'var(--t-label-size)'); setStyle(synLabel, 'color', 'var(--ink-3)');
    setText(synLabel, this._t('tree.synergiesLabel'));
    panel.appendChild(synLabel);
    this._dSynLabelEl = synLabel;
    y += 18;

    this._synRowEls = [];
    for (let i = 0; i < SYN_ROWS; i++) {
      const row = el('div'); setStyle(row, 'position', 'absolute'); setStyle(row, 'left', DETAIL_X + 'px'); setStyle(row, 'top', y + 'px');
      setStyle(row, 'fontFamily', 'var(--ff-sans)'); setStyle(row, 'fontSize', 'var(--t-body-size)'); setStyle(row, 'color', 'var(--verdigris)');
      panel.appendChild(row);
      this._synRowEls.push(row);
      y += 16;
    }

    y += 8;
    const reqLabel = el('div'); setStyle(reqLabel, 'position', 'absolute'); setStyle(reqLabel, 'left', DETAIL_X + 'px'); setStyle(reqLabel, 'top', y + 'px');
    setStyle(reqLabel, 'fontFamily', 'var(--ff-sans)'); setStyle(reqLabel, 'fontSize', 'var(--t-label-size)'); setStyle(reqLabel, 'color', 'var(--ink-3)');
    setText(reqLabel, this._t('tree.requiresLabel'));
    panel.appendChild(reqLabel);
    this._dReqLabelEl = reqLabel;
    y += 18;

    this._reqRowEls = [];
    for (let i = 0; i < REQ_ROWS; i++) {
      const row = el('div'); setStyle(row, 'position', 'absolute'); setStyle(row, 'left', DETAIL_X + 'px'); setStyle(row, 'top', y + 'px');
      setStyle(row, 'fontFamily', 'var(--ff-sans)'); setStyle(row, 'fontSize', 'var(--t-body-size)'); setStyle(row, 'color', 'var(--ink-2)');
      panel.appendChild(row);
      this._reqRowEls.push(row);
      y += 16;
    }

    const allocBtn = el('button', 'cl2-tree-alloc');
    setStyle(allocBtn, 'position', 'absolute'); setStyle(allocBtn, 'left', (DETAIL_X + DETAIL_W - 60) + 'px'); setStyle(allocBtn, 'top', (cardTop + cardH - 40) + 'px');
    setStyle(allocBtn, 'width', '48px'); setStyle(allocBtn, 'height', '28px');
    setStyle(allocBtn, 'fontFamily', 'var(--ff-sans)'); setStyle(allocBtn, 'color', 'var(--ink-1)'); setStyle(allocBtn, 'background', 'var(--ember-dim)');
    setStyle(allocBtn, 'border', 'var(--edge)'); setStyle(allocBtn, 'cursor', 'pointer');
    setText(allocBtn, '+');
    panel.appendChild(allocBtn);
    if (typeof allocBtn.addEventListener === 'function') allocBtn.addEventListener('click', () => this._onAllocButtonClick());
    this._allocBtnEl = allocBtn;
  }

  _buildDialog() {
    const dlg = el('div', 'cl2-tree-dialog');
    setStyle(dlg, 'position', 'absolute'); setStyle(dlg, 'left', DIALOG_X + 'px'); setStyle(dlg, 'top', DIALOG_Y + 'px');
    setStyle(dlg, 'width', DIALOG_W + 'px'); setStyle(dlg, 'height', DIALOG_H + 'px'); setStyle(dlg, 'boxSizing', 'border-box');
    setStyle(dlg, 'background', 'var(--e3-fill)'); setStyle(dlg, 'border', 'var(--edge)'); setStyle(dlg, 'boxShadow', 'var(--e3-shadow)');
    setStyle(dlg, 'display', 'none'); setStyle(dlg, 'pointerEvents', 'auto'); setStyle(dlg, 'zIndex', '2');
    setStyle(dlg, 'textAlign', 'center'); setStyle(dlg, 'color', 'var(--ink-1)'); setStyle(dlg, 'fontFamily', 'var(--ff-sans)');
    this._panelEl.appendChild(dlg);
    this._dialogEl = dlg;

    const promptEl = el('div');
    setStyle(promptEl, 'position', 'absolute'); setStyle(promptEl, 'left', '0'); setStyle(promptEl, 'top', '32px');
    setStyle(promptEl, 'width', DIALOG_W + 'px'); setStyle(promptEl, 'textAlign', 'center');
    setStyle(promptEl, 'fontFamily', 'var(--ff-sans)'); setStyle(promptEl, 'fontSize', 'var(--t-name-size)'); setStyle(promptEl, 'color', 'var(--ink-1)');
    dlg.appendChild(promptEl);
    this._dialogPromptEl = promptEl;

    const discardBtn = el('button');
    setStyle(discardBtn, 'position', 'absolute'); setStyle(discardBtn, 'left', '80px'); setStyle(discardBtn, 'top', '140px');
    setStyle(discardBtn, 'fontFamily', 'var(--ff-sans)'); setStyle(discardBtn, 'color', 'var(--danger-ink)'); setStyle(discardBtn, 'background', 'var(--ash-700)');
    setStyle(discardBtn, 'border', 'var(--edge)'); setStyle(discardBtn, 'cursor', 'pointer');
    setText(discardBtn, this._t('common.discard'));
    dlg.appendChild(discardBtn);
    if (typeof discardBtn.addEventListener === 'function') discardBtn.addEventListener('click', () => this._onDialogDiscard());
    this._dialogDiscardEl = discardBtn;

    const cancelBtn = el('button');
    setStyle(cancelBtn, 'position', 'absolute'); setStyle(cancelBtn, 'right', '80px'); setStyle(cancelBtn, 'top', '140px');
    setStyle(cancelBtn, 'fontFamily', 'var(--ff-sans)'); setStyle(cancelBtn, 'color', 'var(--ink-2)'); setStyle(cancelBtn, 'background', 'var(--ash-700)');
    setStyle(cancelBtn, 'border', 'var(--edge)'); setStyle(cancelBtn, 'cursor', 'pointer');
    setText(cancelBtn, this._t('common.cancel'));
    dlg.appendChild(cancelBtn);
    if (typeof cancelBtn.addEventListener === 'function') cancelBtn.addEventListener('click', () => this._onDialogCancel());
    this._dialogCancelEl = cancelBtn;
  }

  // ===========================================================================
  // Lazy node-lattice construction, per classId
  // ===========================================================================

  _ensureBuiltForClass(classId) {
    if (!classId || classId === this._builtClassId || !this._skills) return;

    // Tear down any previous class's nodes (never happens in real play —
    // no multiclassing — kept for correctness/tests only).
    for (const n of this._nodes) {
      if (n.dom && n.dom.wrap && typeof n.dom.wrap.remove === 'function') n.dom.wrap.remove();
    }
    this._nodes = [];

    const allDefs = this._skills.all || [];
    this._registryIndex = new Map();
    for (let i = 0; i < allDefs.length; i++) this._registryIndex.set(allDefs[i].id, i);

    const treeIds = this._skills.trees(classId) || [];
    for (let t = 0; t < treeIds.length && t < MAX_TREES; t++) {
      const defs = this._skills.forTree(treeIds[t]) || [];
      const colCountByTier = [0, 0, 0, 0];
      for (const def of defs) {
        const row = TIERS.indexOf(def.tier);
        if (row < 0) continue; // an off-spec tier value — never fabricate a slot for it
        const col = colCountByTier[row]++;
        if (col >= MAX_COLS) continue; // more than 2 skills at one tier is a data-table bug, not ours to guess a layout for
        const x = t * TREE_COL_W + COL_X[col];
        const y = HEADER_H + ROW_Y[row];
        const node = {
          id: def.id, def, x, y, treeIndex: t, colIndex: col, rowIndex: row,
          registryIndex: this._registryIndex.get(def.id) || 0,
          pending: 0,
          dom: null,
          lastVisualState: null, lastHovered: null, lastSelected: null,
          lastBadgeState: null, lastBadgeAllocated: -1, lastBadgePending: -1,
          lastIconId: null,
        };
        node.dom = this._buildNodeDom(node);
        this._nodes.push(node);
      }
    }

    this._buildEdges();
    this._builtClassId = classId;
    this._dirty = true;
  }

  _buildNodeDom(node) {
    const wrap = el('div', 'cl2-tree-node');
    setStyle(wrap, 'position', 'absolute'); setStyle(wrap, 'left', node.x + 'px'); setStyle(wrap, 'top', node.y + 'px');
    setStyle(wrap, 'width', NODE_SIZE + 'px'); setStyle(wrap, 'height', NODE_SIZE + 'px'); setStyle(wrap, 'boxSizing', 'border-box');
    setStyle(wrap, 'cursor', 'pointer'); setStyle(wrap, 'zIndex', '1');
    this._panelEl.appendChild(wrap);

    const iconCanvas = el('canvas', 'cl2-tree-icon');
    iconCanvas.width = NODE_ICON; iconCanvas.height = NODE_ICON;
    setStyle(iconCanvas, 'position', 'absolute'); setStyle(iconCanvas, 'left', NODE_ICON_INSET + 'px'); setStyle(iconCanvas, 'top', NODE_ICON_INSET + 'px');
    setStyle(iconCanvas, 'width', NODE_ICON + 'px'); setStyle(iconCanvas, 'height', NODE_ICON + 'px'); setStyle(iconCanvas, 'pointerEvents', 'none');
    wrap.appendChild(iconCanvas);

    const badge = el('div', 'cl2-tree-badge');
    setStyle(badge, 'position', 'absolute'); setStyle(badge, 'right', '0'); setStyle(badge, 'bottom', '0');
    setStyle(badge, 'minWidth', '22px'); setStyle(badge, 'height', '16px'); setStyle(badge, 'textAlign', 'center');
    setStyle(badge, 'background', 'rgba(7,6,5,.8)'); setStyle(badge, 'fontFamily', 'var(--ff-mono)'); setStyle(badge, 'fontSize', 'var(--t-num-s-size)');
    setStyle(badge, 'pointerEvents', 'none');
    wrap.appendChild(badge);

    const idx = this._nodes.length;
    if (typeof wrap.addEventListener === 'function') {
      wrap.addEventListener('pointerenter', () => this._onNodeHover(idx));
      wrap.addEventListener('pointerleave', () => this._onNodeUnhover(idx));
      wrap.addEventListener('pointerdown', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        if (e && e.button === 2) this._onNodeRightClick(idx);
        else this._onNodeClick(idx, !!(e && e.shiftKey));
      });
      wrap.addEventListener('contextmenu', (e) => { if (e && e.preventDefault) e.preventDefault(); });
    }

    return { wrap, iconCanvas, iconCtx: typeof iconCanvas.getContext === 'function' ? iconCanvas.getContext('2d') : null, badge };
  }

  _buildEdges() {
    this._edges = [];
    for (const node of this._nodes) {
      for (const req of node.def.requires) {
        this._edges.push({ kind: 'prereq', fromId: req.skillId, toId: node.id, reqLevel: req.level });
      }
      for (const syn of node.def.synergies) {
        this._edges.push({ kind: 'synergy', fromId: syn.skillId, toId: node.id, stat: syn.stat, perLevel: syn.perLevel });
      }
    }
  }

  _findNode(id) {
    for (const n of this._nodes) if (n.id === id) return n;
    return null;
  }

  // ===========================================================================
  // Actor / allocation helpers
  // ===========================================================================

  _actor() {
    return this._player ? this._player.actor : null;
  }

  /** Real allocated points on `node`, copied out of `skills.instanceOf`'s
   * shared scratch immediately (SKIL-1's own contract). */
  _allocatedReal(node) {
    const actor = this._actor();
    if (!actor || !this._skills) return 0;
    const inst = this._skills.instanceOf(actor, node.id);
    return inst ? inst.allocated : 0;
  }

  _totalPending() {
    let n = 0;
    for (const node of this._nodes) n += node.pending;
    return n;
  }

  _remainingBudget() {
    if (!this._player || typeof this._player.hudState !== 'function') return 0;
    const hud = this._player.hudState(this._hudScratch);
    return (hud.skillPoints || 0) - this._totalPending();
  }

  /** Tier + prerequisite gate only, budget-independent — this is what
   * distinguishes the `locked` node-visual state from `available`. */
  _tierPrereqOk(node) {
    const actor = this._actor();
    if (!actor) return false;
    const def = node.def;
    if (actor.classId && def.classId && actor.classId !== def.classId) return false;
    if ((actor.level || 0) < def.tier) return false;
    for (const req of def.requires) {
      const src = this._findNode(req.skillId);
      const total = src ? this._allocatedReal(src) + src.pending : 0;
      if (total < req.level) return false;
    }
    return true;
  }

  /**
   * Provisional `canAllocate`, `09 §8.4`: "re-evaluated against allocated +
   * pending on every change." `skills.canAllocate` alone cannot express
   * this (it only sees real, confirmed state) — see file header.
   */
  _canAllocateProvisional(node) {
    if (!this._tierPrereqOk(node)) return false;
    const total = this._allocatedReal(node) + node.pending;
    if (total >= node.def.maxLevel) return false;
    return true;
  }

  _nodeState(node) {
    const allocatedReal = this._allocatedReal(node);
    const total = allocatedReal + node.pending;
    if (total >= node.def.maxLevel) return 'maxed';
    if (node.pending > 0) return 'pending';
    if (allocatedReal > 0) return 'allocated';
    if (!this._tierPrereqOk(node)) return 'locked';
    return 'available';
  }

  _markDirty() {
    this._dirty = true;
    this._generation++;
  }

  _select(index) {
    if (this._selectedIndex === index) return;
    this._selectedIndex = index;
    this._markDirty();
  }

  // ===========================================================================
  // Interaction
  // ===========================================================================

  _onNodeHover(index) {
    if (this._hoverIndex === index) return;
    this._hoverIndex = index;
    this._markDirty();
  }

  _onNodeUnhover(index) {
    if (this._hoverIndex !== index) return;
    this._hoverIndex = -1;
    this._markDirty();
  }

  _onNodeClick(index, shift) {
    const node = this._nodes[index];
    if (!node) return;
    this._select(index);
    if (shift) {
      // "add points until the next tier threshold, the maximum, or the
      // budget runs out" — see file header: no numeric "tier threshold"
      // exists for a single skill in the read range, so this stops at the
      // two well-defined conditions only.
      let guard = 0;
      while (guard++ < node.def.maxLevel + 1) {
        if (this._remainingBudget() <= 0) break;
        if (!this._canAllocateProvisional(node)) break;
        node.pending++;
      }
    } else {
      if (this._remainingBudget() <= 0) return;
      if (!this._canAllocateProvisional(node)) return;
      node.pending++;
    }
    this._markDirty();
  }

  _onNodeRightClick(index) {
    const node = this._nodes[index];
    if (!node) return;
    this._select(index);
    if (node.pending > 0) {
      node.pending--;
      this._markDirty();
    }
  }

  _onAllocButtonClick() {
    if (this._selectedIndex < 0) return;
    this._onNodeClick(this._selectedIndex, false);
  }

  _onRevertClick() {
    let any = false;
    for (const n of this._nodes) { if (n.pending > 0) { n.pending = 0; any = true; } }
    if (any) this._markDirty();
  }

  _onConfirmClick() {
    const actor = this._actor();
    if (!actor) return;
    const player = this._player;
    const skills = this._skills;
    const list = this._nodes.filter((n) => n.pending > 0);
    // "ascending tier then ascending skill-registry order" (09 §8.4).
    list.sort((a, b) => (a.def.tier - b.def.tier) || (a.registryIndex - b.registryIndex));

    let spentAny = false;
    let gapReported = false;
    for (const node of list) {
      const count = node.pending;
      for (let i = 0; i < count; i++) {
        if (player && typeof player.spendSkillPoint === 'function') {
          // Never call allocate() without checking canAllocate() first
          // (02:918) — by this point in the loop every LOWER-tier pending
          // point already landed for real, so a same-pass prerequisite is
          // already satisfied and the real check passes naturally.
          if (skills && typeof skills.canAllocate === 'function' && !skills.canAllocate(actor, node.id).ok) continue;
          if (player.spendSkillPoint(node.id)) spentAny = true;
        } else {
          gapReported = true; // player.spendSkillPoint missing — see file header
        }
      }
      node.pending = 0;
    }
    this._gapReported = this._gapReported || gapReported;

    if (spentAny) {
      const audio = safeGet(this._ctx, 'audio');
      if (audio && typeof audio.playUi === 'function') audio.playUi('ui.skillpoint');
    }
    this._markDirty();
  }

  // ===========================================================================
  // Close / dialog
  // ===========================================================================

  open() {
    const actor = this._actor();
    if (actor) this._ensureBuiltForClass(actor.classId);
    this._visible = true;
    setStyle(this._panelEl, 'display', 'block');
    this._markDirty();
    this._syncAll(true);
  }

  /** @param {boolean} [force] - bypass the close-with-pending dialog
   *   (screen-change teardown; `UiSystem#setScreen`'s own convention). */
  close(force) {
    if (!this._visible) return;
    if (!force && this._totalPending() > 0) {
      this._showDialog();
      return;
    }
    this._reallyClose();
  }

  _reallyClose() {
    this._visible = false;
    setStyle(this._panelEl, 'display', 'none');
    this._hideDialog();
    for (const n of this._nodes) n.pending = 0;
    this._selectedIndex = -1;
    this._hoverIndex = -1;
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
    else this.close(true);
  }

  _showDialog() {
    this._dialogVisible = true;
    // `setText` would clear the dialog's element children (`util.js#setText`
    // sets `textContent`, which drops any child nodes) — the prompt text is
    // written onto its own child span instead of the dialog root, so the
    // (already-appended, built once in `_buildDialog`) Discard/Cancel
    // buttons are never re-parented or duplicated.
    setText(this._dialogPromptEl, this._t('tree.confirmPrompt', { n: numStr(this._totalPending()) }));
    setStyle(this._dialogEl, 'display', 'block');
  }

  _hideDialog() {
    this._dialogVisible = false;
    setStyle(this._dialogEl, 'display', 'none');
  }

  _onDialogDiscard() {
    this._hideDialog();
    this._reallyClose();
  }

  _onDialogCancel() {
    this._hideDialog();
  }

  // ===========================================================================
  // Per-frame sync — presentation only (rule 5), no CSS transition
  // anywhere (this ticket's own trap #1).
  // ===========================================================================

  update(dt, ctx) {
    void dt;
    if (!this._visible) return;
    const actor = this._actor();
    if (actor) this._ensureBuiltForClass(actor.classId);
    this._layoutStatic(ctx);
    this._syncAll(false);
  }

  _layoutStatic(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw || 1920;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw; this._vh = vh;
    const x = Math.round((vw - PANEL_W) / 2);
    this._panelX = x;
    setStyle(this._panelEl, 'left', x + 'px');
  }

  _syncAll(force) {
    this._syncHeader();
    this._syncNodes();
    this._syncDetailCard();
    if (this._dirty || force) {
      this._redrawCanvas();
      this._dirty = false;
    }
  }

  /**
   * The change-guard compares PRIMITIVE inputs first (numbers, existing
   * string references) and only reaches a `this._t(...)`/concatenation
   * string BUILD when one actually changed — `sheet.perf.test.js`'s own
   * header names this exact discipline: "unlike a plain `setText` ... the
   * STRING BUILD itself has to be skipped in steady state, not just the DOM
   * write." Comparing the already-built string (as a first cut of this
   * method did) still allocates that string every call before the compare
   * can reject it, which is exactly the steady-state cost this method
   * exists to avoid.
   */
  _syncHeader() {
    const actor = this._actor();
    const classId = actor ? actor.classId : null;
    if (this._lastClassIdForHeader !== classId) {
      this._lastClassIdForHeader = classId;
      const className = classId ? this._t('class.' + classId + '.name') : '';
      const titleText = this._t('panel.skills').toUpperCase() + (className ? ' — ' + className.toUpperCase() : '');
      setText(this._headerTitleEl, titleText);

      const treeIds = (this._skills && classId) ? this._skills.trees(classId) : [];
      for (let t = 0; t < this._treeTitleEls.length; t++) {
        setText(this._treeTitleEls[t], treeIds[t] ? cap(treeIds[t]).toUpperCase() : '');
      }
    }

    const remaining = Math.max(0, this._remainingBudget());
    if (this._lastRemainingForHeader !== remaining) {
      this._lastRemainingForHeader = remaining;
      setText(this._headerPointsEl, this._t('tree.skillPoints', { n: numStr(remaining) }));
    }

    const totalPending = this._totalPending();
    if (this._lastPendingForHeader !== totalPending) {
      this._lastPendingForHeader = totalPending;
      setText(this._pendingEl, totalPending > 0 ? this._t('tree.pending', { n: numStr(totalPending) }) : '');
    }
  }

  _syncNodes() {
    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      const state = this._nodeState(node);
      const hovered = i === this._hoverIndex;
      const selected = i === this._selectedIndex;
      if (node.lastVisualState !== state || node.lastHovered !== hovered || node.lastSelected !== selected) {
        node.lastVisualState = state; node.lastHovered = hovered; node.lastSelected = selected;
        applyNodeStyle(node.dom.wrap, state, hovered, selected);
      }

      const allocatedReal = this._allocatedReal(node);
      if (node.lastBadgeState !== state || node.lastBadgeAllocated !== allocatedReal || node.lastBadgePending !== node.pending) {
        node.lastBadgeState = state; node.lastBadgeAllocated = allocatedReal; node.lastBadgePending = node.pending;
        setText(node.dom.badge, badgeTextFor(state, allocatedReal, node.pending, node.def.maxLevel));
        setStyle(node.dom.badge, 'color', badgeColorFor(state));
      }

      if (node.lastIconId !== node.id) {
        node.lastIconId = node.id;
        drawNodeIcon(node.dom.iconCtx, node.def);
      }
    }
  }

  /**
   * Same discipline as `_syncHeader`: the guard runs on primitive inputs
   * (`node.id`, `N`, `node.pending`, `this._generation`) BEFORE any
   * `this._t(...)`/`describe()`-line formatting, so an idle frame with a
   * node selected costs one string-free comparison, not a full rebuild.
   * `this._generation` (bumped by `_markDirty()`) is what catches the
   * requires-row / synergy-row case where the CARD's own inputs
   * (`node.id`/`N`/`node.pending`) didn't change but a DIFFERENT node's
   * pending/allocated count did (e.g. hovering sunder while clicking
   * bloodletting) — those rows read other nodes' state, not just the
   * selected one's.
   */
  _syncDetailCard() {
    const idx = this._selectedIndex;
    const node = idx >= 0 ? this._nodes[idx] : null;
    const actor = this._actor();

    if (!node || !actor || !this._skills) {
      if (this._lastDetailNodeId !== null) {
        this._lastDetailNodeId = null;
        setText(this._dNameEl, ''); setText(this._dSubEl, '');
        for (const row of this._rows) { setText(row.label, ''); setText(row.cur, ''); setText(row.next, ''); }
        setText(this._dDescEl, '');
        for (const row of this._synRowEls) setText(row, '');
        for (const row of this._reqRowEls) setText(row, '');
        setStyle(this._allocBtnEl, 'opacity', '0.4');
        this._allocBtnEl.disabled = true;
      }
      return;
    }

    const def = node.def;
    const N = this._skills.effectiveLevel(actor, def.id);
    if (this._lastDetailNodeId === node.id && this._lastDetailN === N && this._lastDetailPending === node.pending && this._lastDetailGeneration === this._generation) {
      return; // nothing this card reads has changed since the last sync
    }
    this._lastDetailNodeId = node.id; this._lastDetailN = N; this._lastDetailPending = node.pending; this._lastDetailGeneration = this._generation;

    setText(this._dNameEl, def.displayName.toUpperCase());
    setText(this._dSubEl, cap(def.tree) + ' · ' + cap(def.type) + ' · ' + cap(def.element));

    this._skills.describe(actor, def.id, N, this._descOut);
    const atMax = N >= def.maxLevel;
    if (!atMax) this._skills.describe(actor, def.id, N + 1, this._descOutNext);

    const headerRow = this._rows[0];
    setText(headerRow.label, '');
    setText(headerRow.cur, this._t('tree.level', { n: numStr(N) }));
    setText(headerRow.next, atMax ? this._t('tree.maximum') : this._t('tree.level', { n: numStr(N + 1) }));
    setStyle(headerRow.next, 'color', atMax ? 'var(--gilt)' : 'var(--ink-1)');

    const lineCount = Math.min(this._descOut.lineCount, STAT_DATA_ROWS);
    for (let i = 0; i < STAT_DATA_ROWS; i++) {
      const row = this._rows[i + 1];
      if (i >= lineCount) { setText(row.label, ''); setText(row.cur, ''); setText(row.next, ''); continue; }
      const curLine = this._descOut.lines[i];
      const nextLine = atMax ? null : this._descOutNext.lines[i];
      setText(row.label, this._t(curLine.labelKey));
      setText(row.cur, formatLine(curLine, this._t));
      if (atMax) { setText(row.next, ''); }
      else {
        setText(row.next, formatLine(nextLine, this._t));
        const changed = nextLine.value !== curLine.value;
        setStyle(row.next, 'color', changed ? 'var(--ink-1)' : 'var(--ink-3)');
      }
    }

    // Description: skill.<id>.desc — see file header, "missing i18n keys".
    // Params keyed off describe()'s own output, so a landed key can pull
    // whichever of these it needs.
    setText(this._dDescEl, this._t('skill.' + def.id + '.desc', {
      cost: numStr(Math.round(this._descOut.costAmount)),
      cooldown: numStr(Math.round(this._descOut.cooldown)),
      radius: numStr(Math.round(this._descOut.radius)),
      duration: numStr(Math.round(this._descOut.duration)),
    }));

    // Synergies (incoming, this skill as target) — capped SYN_ROWS, see
    // file header.
    for (let i = 0; i < SYN_ROWS; i++) {
      const syn = def.synergies[i];
      if (!syn) { setText(this._synRowEls[i], ''); continue; }
      const srcNode = this._findNode(syn.skillId);
      const srcDef = this._skills.definition(syn.skillId);
      const srcAllocated = srcNode ? this._allocatedReal(srcNode) : 0;
      const pct = syn.perLevel * srcAllocated;
      setText(this._synRowEls[i], this._t('tree.synergyRow', {
        name: srcDef ? srcDef.displayName : syn.skillId,
        level: numStr(srcAllocated),
        pct: numStr(Math.round(pct)),
      }));
    }

    // Requires — row 0 is always the character-level gate; row 1 (if any)
    // is the skill's own single `requires[]` entry (never more than one
    // across all 30 records — see file header).
    const levelOk = (actor.level || 0) >= def.tier;
    setText(this._reqRowEls[0], this._t('tree.requiresLevel', { n: numStr(def.tier) }) + (levelOk ? ' ✓' : ' ✕'));
    setStyle(this._reqRowEls[0], 'color', levelOk ? 'var(--ink-2)' : 'var(--danger-ink)');
    for (let i = 1; i < REQ_ROWS; i++) {
      const req = def.requires[i - 1];
      if (!req) { setText(this._reqRowEls[i], ''); continue; }
      const srcNode = this._findNode(req.skillId);
      const srcDef = this._skills.definition(req.skillId);
      const total = srcNode ? this._allocatedReal(srcNode) + srcNode.pending : 0;
      const ok = total >= req.level;
      setText(this._reqRowEls[i], (srcDef ? srcDef.displayName : req.skillId) + ' ' + numStr(req.level) + (ok ? ' ✓' : ' ✕'));
      setStyle(this._reqRowEls[i], 'color', ok ? 'var(--ink-2)' : 'var(--danger-ink)');
    }

    const canAlloc = this._canAllocateProvisional(node) && this._remainingBudget() > 0;
    this._allocBtnEl.disabled = !canAlloc;
    setStyle(this._allocBtnEl, 'opacity', canAlloc ? '1' : '0.4');
  }

  // ===========================================================================
  // Connector canvas — redrawn ONLY on `_dirty` (proved by `__redrawCount()`).
  // ===========================================================================

  _redrawCanvas() {
    this._redrawCount++;
    const g = this._canvasCtx;
    if (!g) return; // Node shim — no real 2D context; count still proves the gate fired.
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const anyHover = this._hoverIndex >= 0;
    const hoveredId = anyHover ? this._nodes[this._hoverIndex].id : null;

    // Tier-chain rails — always drawn, behind everything, one per occupied
    // column.
    g.strokeStyle = 'rgba(239,231,216,.10)';
    g.lineWidth = 1;
    for (let t = 0; t < MAX_TREES; t++) {
      for (let c = 0; c < MAX_COLS; c++) {
        const colNodes = this._nodes.filter((n) => n.treeIndex === t && n.colIndex === c);
        if (colNodes.length === 0) continue;
        const cx = t * TREE_COL_W + COL_X[c] + NODE_SIZE / 2;
        const topY = Math.min(...colNodes.map((n) => n.y - HEADER_H)) + NODE_SIZE / 2;
        const botY = Math.max(...colNodes.map((n) => n.y - HEADER_H)) + NODE_SIZE / 2;
        g.beginPath(); g.moveTo(cx, topY); g.lineTo(cx, botY); g.stroke();
      }
    }

    for (const edge of this._edges) {
      const from = this._findNode(edge.fromId);
      const to = this._findNode(edge.toId);
      if (!from || !to) continue;
      const focused = anyHover && (edge.fromId === hoveredId || edge.toId === hoveredId);
      const dimmed = anyHover && !focused;
      const alphaBase = edge.kind === 'prereq' ? 1 : 0.24;
      const alpha = focused ? 1 : (dimmed ? 0.12 : alphaBase);
      const lineWidth = (edge.kind === 'prereq' ? 2 : 1) + (focused ? 1 : 0);

      const fx = from.x, fy = from.y - HEADER_H;
      const tx = to.x, ty = to.y - HEADER_H;

      if (edge.kind === 'prereq') {
        const satisfied = this._allocatedReal(from) + from.pending >= edge.reqLevel;
        g.globalAlpha = alpha;
        // Canvas 2D cannot resolve `var(--token)` — literal hex, matching
        // `--ember-dim`/`--ash-500` from `style.js` exactly.
        g.strokeStyle = satisfied ? '#8f3d1a' : '#3a3128';
        g.lineWidth = lineWidth;
        if (!satisfied) g.setLineDash([4, 4]); else g.setLineDash([]);
        const sx = fx + NODE_SIZE / 2, sy = fy + NODE_SIZE;
        const ex = tx + NODE_SIZE / 2, ey = ty;
        g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.stroke();
        g.setLineDash([]);
      } else {
        g.globalAlpha = alpha;
        g.strokeStyle = '#3f8f7a';
        g.lineWidth = lineWidth;
        g.setLineDash([2, 4]);
        const sx = fx + NODE_SIZE, sy = fy + NODE_SIZE / 2;
        const ex = tx, ey = ty + NODE_SIZE / 2;
        const cx = (sx + ex) / 2 + 40, cy = (sy + ey) / 2;
        g.beginPath(); g.moveTo(sx, sy); g.quadraticCurveTo(cx, cy, ex, ey); g.stroke();
        g.setLineDash([]);
      }
      g.globalAlpha = 1;
    }
  }

  // ===========================================================================
  // Dispose
  // ===========================================================================

  dispose() {
    if (this._panelEl && typeof this._panelEl.remove === 'function') this._panelEl.remove();
    this._panelEl = null;
    this._nodes = [];
  }

  // ===========================================================================
  // Dev/test-only escape hatches (double-underscore, `src/actors/index.js`'s
  // `__archetypeVisuals` convention) — not in `02-api-contracts.md`.
  // ===========================================================================

  /** @returns {number} this panel's own DOM subtree node count — `09 §13.1`'s
   *  73-node row, the same `__nodeCountRoot()` convention `sheet.js` uses
   *  against its own 104-node row. */
  __nodeCountRoot() {
    return this._panelEl;
  }

  __redrawCount() {
    return this._redrawCount;
  }

  __hoverNode(skillId) {
    const idx = this._nodes.findIndex((n) => n.id === skillId);
    if (idx >= 0) this._onNodeHover(idx);
  }

  __unhoverAll() {
    this._hoverIndex = -1;
    this._markDirty();
  }

  __clickNode(skillId, opts) {
    const idx = this._nodes.findIndex((n) => n.id === skillId);
    if (idx >= 0) this._onNodeClick(idx, !!(opts && opts.shift));
  }

  __rightClickNode(skillId) {
    const idx = this._nodes.findIndex((n) => n.id === skillId);
    if (idx >= 0) this._onNodeRightClick(idx);
  }

  __confirm() {
    this._onConfirmClick();
  }

  __revert() {
    this._onRevertClick();
  }

  __dialogVisible() {
    return this._dialogVisible;
  }

  __focusedEdges() {
    if (this._hoverIndex < 0) return [];
    const hoveredId = this._nodes[this._hoverIndex].id;
    return this._edges.filter((e) => e.fromId === hoveredId || e.toId === hoveredId).map((e) => ({ kind: e.kind, from: e.fromId, to: e.toId }));
  }

  __pendingOf(skillId) {
    const n = this._findNode(skillId);
    return n ? n.pending : 0;
  }

  __select(skillId) {
    const idx = this._nodes.findIndex((n) => n.id === skillId);
    if (idx >= 0) this._select(idx);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function makeDescOut() {
  const lines = new Array(8);
  for (let i = 0; i < 8; i++) lines[i] = { labelKey: null, value: 0, unit: null, format: null };
  return {
    lineCount: 0, lines,
    costResource: null, costAmount: 0,
    cooldown: 0, castTime: 0, radius: 0, range: 0, duration: 0,
    damageMin: 0, damageMax: 0,
  };
}

// A cost line's `unit` is a resource id ('rage'/'mana'/'resonance') — every
// one of those already has a real `hud.<id>` key (`src/ui/i18n.js`, UI-1),
// so it is translated here instead of joining the raw internal id onto the
// number (which would be the same category of silent-English-leak O-70
// flags for everything else in this file). 's'/'m' stay bare unit
// notation, the same convention `hud.cooldown`'s own `'{v} s'` and every
// other numeric-with-unit string in this codebase already uses.
const RESOURCE_UNITS = new Set(['life', 'mana', 'rage', 'resonance', 'stamina']);

function formatLine(line, t) {
  if (!line) return '';
  if (line.format === 'percent') return Math.round(line.value) + '%';
  if (line.format === 'range') return Math.round(line.value) + '';
  const v = Math.round(line.value * 10) / 10;
  let unit = '';
  if (line.unit === 's' || line.unit === 'm') unit = ' ' + line.unit;
  else if (line.unit && RESOURCE_UNITS.has(line.unit)) unit = ' ' + (typeof t === 'function' ? t('hud.' + line.unit) : line.unit);
  else if (line.unit) unit = ' ' + line.unit;
  return v + unit;
}

function badgeTextFor(state, allocatedReal, pending, maxLevel) {
  if (state === 'locked') return '—';
  if (state === 'available') return '·';
  if (state === 'maxed') return numStr(maxLevel);
  if (state === 'pending') return numStr(allocatedReal) + '+' + numStr(pending);
  return numStr(allocatedReal);
}

function badgeColorFor(state) {
  if (state === 'locked') return 'var(--ink-4)';
  if (state === 'available') return 'var(--ink-3)';
  if (state === 'maxed') return 'var(--gilt)';
  if (state === 'pending') return 'var(--ember)';
  return 'var(--ink-1)';
}

/** `09 §8.1`'s node-state table, applied as inline styles (no new CSS
 * class — this ticket does not touch `style.js`). */
function applyNodeStyle(wrap, state, hovered, selected) {
  let border, fill, iconOpacity;
  if (state === 'locked') { border = '1px solid #3a3128'; fill = '#16130f'; iconOpacity = '0.22'; }
  else if (state === 'available') { border = '1px solid #4c4136'; fill = '#1e1a15'; iconOpacity = '0.70'; }
  else if (state === 'allocated') { border = '1px solid #8f3d1a'; fill = '#1e1a15'; iconOpacity = '1'; }
  else if (state === 'pending') { border = '2px solid #e0622a'; fill = '#2a241c'; iconOpacity = '1'; }
  else { border = '2px solid #c9a227'; fill = '#2a241c'; iconOpacity = '1'; } // maxed

  setStyle(wrap, 'border', border);
  setStyle(wrap, 'background', fill);
  const iconEl = wrap.children && wrap.children[0];
  if (iconEl) setStyle(iconEl, 'opacity', iconOpacity);

  if (selected) setStyle(wrap, 'outline', '2px solid var(--ember)');
  else if (hovered) setStyle(wrap, 'outline', '2px solid var(--ink-1)');
  else setStyle(wrap, 'outline', 'none');
  setStyle(wrap, 'outlineOffset', '1px');
}

/** Placeholder glyph, same tier as `hotbar.js`'s own disc — see file header
 * ("Icons — placeholder glyphs" precedent). A flat tint plus the skill's
 * own first two initials, drawn once per node (cached by `lastIconId`). */
function drawNodeIcon(g, def) {
  if (!g) return;
  g.clearRect(0, 0, NODE_ICON, NODE_ICON);
  g.fillStyle = '#4c4136';
  g.beginPath();
  g.arc(NODE_ICON / 2, NODE_ICON / 2, NODE_ICON / 2 - 3, 0, Math.PI * 2);
  g.fill();
  const initials = (def.displayName || '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  g.fillStyle = '#efe7d8';
  g.font = '600 18px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(initials, NODE_ICON / 2, NODE_ICON / 2 + 1);
}
