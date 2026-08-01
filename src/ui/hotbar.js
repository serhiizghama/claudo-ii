// src/ui/hotbar.js
//
// UI-3 — `09-ui.md` §15's U2 row: "Hotbar, belt, prompts and toasts". Four
// hotbar slots with the conic cooldown sweep (§4.2), four belt slots with
// counts (§4.3), `setPrompt`/`toast`/`banner` (§4.10). Owned by `ui`,
// constructed and driven by `UiSystem` (`./index.js`) the same shape UI-2's
// `Hud` and UI-4's `Feedback` already establish: a single top-level
// container per widget group, `update(dt, ctx)` that no-ops while hidden,
// `setVisible(visible)` gating on the active screen, `dispose()`.
//
// ---------------------------------------------------------------------------
// Skills do not exist yet (`src/skills/` is M4) — what "the hotbar" can
// honestly show today
// ---------------------------------------------------------------------------
// `player.hotbar` (the `Hotbar` record, `01-data-model.md` §6.4) and
// `player.castOrder`/`player.setHotbar` (`02-api-contracts.md` §13) are not
// implemented by `src/player/index.js` yet, and `player.hudState(out)`
// unconditionally zeroes `hotbar[0..3]` and `cooldowns[0..3]` on every call
// (checked live) — there is no real source of "which skill sits in slot i"
// or "how much cooldown is left" anywhere in this tree today. Polling those
// fields (the D-A discipline UI-2/UI-4 both follow) would therefore poll a
// permanent, silent zero forever, which is not a foundation the cooldown
// sweep's own acceptance clause ("a 6s cooldown sweeps exactly once") can be
// demonstrated against.
//
// This file resolves that the same way `hud.js#debugState('combat')`
// resolved the identical problem for the resource dialects: every hotbar
// slot's cooldown clock is LOCAL state, integrated from `dt` inside this
// module's own `update()`, started only by `__debugStageCooldown` (a
// double-underscore, non-contract, dev/test-only hook — never reachable
// from real gameplay, exactly the tier `hud.js`'s `debugState`/`__hudState`
// occupy). `pressSlot(index)` — the real, always-reachable entry point for
// "1..4 was pressed" — punches the slot and rebinds the locally-tracked
// `selectedSlot` (mirroring `Hotbar.rightMouse`'s default of `0`,
// `01-data-model.md` §6.4) and forwards defensively to
// `player.castOrder`/`player.groundCursor`/`player.hoverTarget` (never
// throws if absent — the same "ask, don't assume" precedent
// `feedback.js`'s `render.screenImpulse` wiring set), but it does NOT start
// a cooldown itself: there is no real skill behind any slot to own a
// cooldown value, and inventing one on every press would be exactly the
// "mock a skill API into the production path" the ticket brief forbids.
// Once M4 lands real skills and `player.hudState().cooldowns[i]` carries a
// genuine remaining-seconds value, the natural migration is to poll that
// array the way `hud.js#update` polls `hud.life`/`hud.mana` — this file's
// own `_advanceHotbarCooldowns` is already the integration/render half of
// that; only the "where does `remaining` come from" line needs to change.
//
// ---------------------------------------------------------------------------
// The belt is real today — `items.beltCooldown`/`beltCount`/`beltUse`
// (ITEM-10) — and is wired directly, not through `player`
// ---------------------------------------------------------------------------
// Unlike the hotbar, `items.beltUse(actor, slotIndex)` (`02-api-contracts.md`
// §11's contracted row, "container/cooldown bookkeeping ONLY") is a real,
// already-landed method reachable via `ctx.get('items')`. `pressBeltSlot`
// calls it directly — the same "ui asks the owning subsystem for a
// container mutation" pattern `showTooltip`'s `items.canEquip` read and the
// inventory drag-drop flow (`items.dropCursor`/`takeToCursor`) already
// establish — and deliberately does NOT also forward to a hypothetical
// `player.useBelt(slotIndex)`: `player`'s own future keyboard-driven path
// (Q/W/E/R -> `Intent.beltSlot` -> `fixedUpdate`) will presumably call
// `items.beltUse` itself once it lands, and calling both from the same
// click would consume two stacks for one press. `pressBeltSlot` is this
// widget's own mouse-click entry point (the belt sits inside the plinth,
// `pointerEvents:auto`, exactly the carve-out `hud.js`'s plate already
// documents — "auto on the plinth only") — independent from, and not in
// conflict with, whatever real-keyboard wiring a later ticket adds.
//
// ---------------------------------------------------------------------------
// Layer placement — hotbar/belt in `hud`, prompt/toast/banner in `feedback`
// ---------------------------------------------------------------------------
// The ticket brief says the hotbar belongs in `hud` (this ticket's own
// wording). For prompt/toast/banner, `09 §3` (Layout) is out of this
// ticket's read range, but `./style.js`'s own header — written when the 8
// layers were named — already assigns the `feedback` layer to hold
// "transient feedback (damage numbers/toasts/banners)" verbatim; prompt is
// grouped with toast in the same `09 §4.10` subsection this ticket read, so
// it goes there too, as a sibling subtree of UI-4's own `Feedback`
// container (multiple modules sharing one layer is exactly what the layer
// abstraction is for; nothing here touches `Feedback`'s own nodes).
//
// ---------------------------------------------------------------------------
// Icons — placeholder glyphs, everywhere, by necessity
// ---------------------------------------------------------------------------
// `09 §15` U2's own acceptance row: "Skill icons come from a placeholder
// glyph." Belt icons have the same problem one level worse: `items` has no
// contracted accessor for a belt slot's *contents* (only `beltCount`, the
// quantity) within this ticket's read range, so this file cannot even know
// which potion sits in a slot, let alone draw its real icon (`items.icon`
// is ITEM-11/15, unimplemented). Every hotbar and belt icon is therefore the
// same generic placeholder glyph (a filled disc), never differentiated by
// skill or potion type — a later ticket that adds `items`' icon pipeline
// and `skills.describe` replaces this wholesale.

import { el, setText, setStyle, place, clamp, damp, numStr, Pool } from './util.js';

// ---------------------------------------------------------------------------
// Geometry — `09 §4.2`/`§4.3`'s literal 1920x1080 numbers, generalised to
// the actual viewport the same way `hud.js#_layoutStatic` does (inset from
// an edge/centre, not the literal pixel value) so this lands correctly at
// the 1280x720 capture resolution too.
// ---------------------------------------------------------------------------
const HOTBAR_COUNT = 4;
const BELT_COUNT = 4;
const HOTBAR_SLOT = 56;
const HOTBAR_PITCH = 64;
const HOTBAR_ICON = 48;
const HOTBAR_CY_INSET = 128; // 1080 - 952 (09 §4.2: "centred on x=960 at y=952")
const BELT_SLOT = 44;
const BELT_PITCH = 52;
const BELT_ICON = 36;
const BELT_CY_INSET = 64; // 1080 - 1016 (09 §4.3)
const HOTBAR_KEYS = ['1', '2', '3', '4'];
const BELT_KEYS = ['Q', 'W', 'E', 'R'];

// ---------------------------------------------------------------------------
// Motion constants — `09 §2.6`/§4.2/§4.3's own numbers
// ---------------------------------------------------------------------------
const PUNCH_DURATION = 0.14; // 09 §4.2: "scale = 1 + 0.12*(1-easeOutQuint(t/0.14))"
const PUNCH_SCALE = 0.12;
const DRINK_FLASH_DURATION = 0.16; // 09 §4.3: "fading over 160ms"
const DRINK_FLASH_ALPHA = 0.35;
const BELT_COOLDOWN_TOTAL = 0.5; // 04-items.md §8.3's global belt cooldown, transcribed (never imported — ARCHITECTURE.md rule 2)
const TOAST_LIFE = 4.0; // 09 §4.10
const TOAST_FADE_WINDOW = 0.5;
const TOAST_MAX = 5;
const TOAST_ROW_H = 30;
const TOAST_ROW_GAP = 4; // not spelled out by the read range; this file's own choice — see report
const TOAST_ROW_W = 320;
const TOAST_Y0 = 220;
const TOAST_X_INSET = 24; // matches --pad (09 §2.3's 6u screen margin); 1920-24-320=1576, 09 §4.10's literal x
const TOAST_STACK_RATE = 20; // 09 §4.10: "push older ones down (damp rate 20 ...)"
const PROMPT_FADE_S = 0.12; // 09 §4.10: "Fades in over 120ms"
const BANNER_IN_S = 0.30; // 09 §2.6: "banner in ... 300ms"
const BANNER_OUT_S = 0.25; // 09 §2.6: "banner out ... 250ms"

const SWEEP_RGBA = 'rgba(7,6,5,.72)'; // 09 §4.2's literal cooldown-overlay colour

// Private easing not in ./util.js's U0 export list (same precedent as
// feedback.js's own header for easeOutCubic/easeInQuad/easeOutQuint).
function easeOutQuint(t) {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** Defensive `ctx.get`/`ctx.peek` — matches `feedback.js`'s own `safeGet`,
 * duplicated rather than imported (a private module helper, not a shared
 * export any ticket brief lists). */
function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(id); } catch { return null; }
  }
  return null;
}

function formatCooldownSeconds(remaining) {
  // "1 decimal below 10s, integer above" (09 §4.2). `toFixed` only ever
  // runs on a change-guarded path (see callers) — 09 §13.3 rule.
  if (remaining < 10) return (Math.round(remaining * 10) / 10).toFixed(1);
  return numStr(Math.round(remaining));
}

function makeHotbarSlot() {
  return {
    skillId: null, // player.hotbar.slots[i] once it exists — always null today
    cdRemaining: 0, cdTotal: 0, // dev/test-only local clock — see file header
    lastAngle: -1, lastCdSeconds: null,
    punchT: PUNCH_DURATION, // >= PUNCH_DURATION means settled/idle
    lastPunchQ: 1000, // quantised scale*1000, change-guard
    lastDrawnSkillId: undefined, lastSelected: false, lastKeyCapOpacity: -1,
    dom: null,
  };
}

function makeBeltSlot() {
  return {
    count: -1, // last-seen quantity; -1 forces the first paint
    drinkT: DRINK_FLASH_DURATION, // >= DRINK_FLASH_DURATION means idle
    lastAngle: -1,
    lastBgAngle: -1, lastBgDrinkQ: -1, lastBgOccupied: -1, // change-guard for the composited background (numeric, not a concatenated string — 09 §13.3)
    dom: null,
  };
}

function makeToastRecord(poolIndex) {
  return { poolIndex, rank: 0, t: 0, life: TOAST_LIFE, text: '', colour: '#c8bda8', dispY: 0, dom: null };
}

function resetToastRecord(r) {
  r.rank = 0; r.t = 0; r.life = TOAST_LIFE; r.text = ''; r.colour = '#c8bda8';
  // r.dispY / r.dom / r.poolIndex intentionally untouched (position eases
  // toward the new rank rather than jumping, and the DOM node is reused).
}

// A tiny local free-list Pool (5 slots) — `./util.js#Pool` is generic
// enough to reuse rather than hand-rolling a second one; see hud.js/
// feedback.js's own precedent for importing it for exactly this reason.

export class Hotbar {
  /**
   * @param {object} ctx
   * @param {object} hudLayer - the `hud` `cl2-layer` node (hotbar + belt).
   * @param {object} feedbackLayer - the `feedback` `cl2-layer` node
   *   (prompt + toast + banner) — see this file's header for why.
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} [rng] - the ONE `ui`-subsystem RNG fork, shared
   *   with `Hud`/`Feedback`/`Tooltip` (ARCHITECTURE.md's Determinism
   *   contract). Unused today (nothing here needs jitter) but accepted for
   *   the same reason `tooltip.js` accepts and does not use it — a future
   *   change to this file must not need a new fork.
   */
  constructor(ctx, hudLayer, feedbackLayer, translate, rng) {
    this._ctx = ctx;
    this._hudLayer = hudLayer;
    this._feedbackLayer = feedbackLayer;
    this._t = translate || ((key) => key);
    void rng;

    this._visible = false;
    this._vw = 1920;
    this._vh = 1080;

    // Cached once (this module's own "init") — see the file header's belt
    // section: `items`/`player` are reached once here, not re-fetched via
    // `ctx.get` every frame. `ui`'s own `static deps` now includes 'items'
    // (O-61), so by the time `UiSystem.init()` constructs this module,
    // `items` has already completed its own `init()` — `ctx.get('items')`
    // is safe to call directly; the `safeGet` wrapper only exists for the
    // bare/partial `ctx` shapes this ticket's own tests construct.
    this._items = safeGet(ctx, 'items');
    this._player = safeGet(ctx, 'player');

    this._selectedSlot = 0; // 01-data-model.md §6.4: Hotbar.rightMouse default

    this._hotbar = new Array(HOTBAR_COUNT);
    for (let i = 0; i < HOTBAR_COUNT; i++) this._hotbar[i] = makeHotbarSlot();

    this._belt = new Array(BELT_COUNT);
    for (let i = 0; i < BELT_COUNT; i++) this._belt[i] = makeBeltSlot();
    this._beltCooldownRemaining = 0;

    this._prompt = {
      shown: false, key: '', text: '', sub: '',
      opacity: 0, lastOpacityQ: -1,
      lastKey: null, lastText: null, lastSub: null,
      dom: null,
    };

    this._banner = {
      active: false, title: '', subtitle: '', hold: 0, t: 0,
      lastScaleQ: -1, lastOpacityQ: -1,
      dom: null,
    };

    const records = [];
    this._toastPool = new Pool(TOAST_MAX, (i) => {
      const r = makeToastRecord(i);
      records.push(r);
      return r;
    }, resetToastRecord);
    this._toastRecords = records;
    this._toastRankScratch = (rec) => { rec.rank += 1; if (rec.rank >= TOAST_MAX) this._toastPool.release(rec, rec.poolIndex); };
    this._toastAdvance = (rec, slot) => {
      rec.t += this._toastDt;
      if (rec.t >= rec.life) { this._toastPool.release(rec, slot); return; }
      const targetY = TOAST_Y0 + rec.rank * (TOAST_ROW_H + TOAST_ROW_GAP);
      rec.dispY = damp(rec.dispY, targetY, TOAST_STACK_RATE, this._toastDt);
      const remaining = rec.life - rec.t;
      const alpha = remaining < TOAST_FADE_WINDOW ? clamp(remaining / TOAST_FADE_WINDOW, 0, 1) : 1;
      this._paintToast(rec, alpha);
    };
    this._toastDt = 0;

    this._buildDom();
    this._layoutStatic();
  }

  // -------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------

  _buildDom() {
    this._hudContainer = el('div', 'cl2-hotbar-container');
    setStyle(this._hudContainer, 'display', 'none');
    this._hudLayer.appendChild(this._hudContainer);

    for (let i = 0; i < HOTBAR_COUNT; i++) this._hotbar[i].dom = this._buildHotbarSlotDom(i);
    for (let i = 0; i < BELT_COUNT; i++) this._belt[i].dom = this._buildBeltSlotDom(i);

    this._feedbackContainer = el('div', 'cl2-hotbar-feedback');
    setStyle(this._feedbackContainer, 'display', 'none');
    this._feedbackLayer.appendChild(this._feedbackContainer);

    this._prompt.dom = this._buildPromptDom();
    this._banner.dom = this._buildBannerDom();
    for (let i = 0; i < TOAST_MAX; i++) this._toastRecords[i].dom = this._buildToastDom();
  }

  _buildHotbarSlotDom(index) {
    const slotEl = el('div', 'cl2-hb-slot');
    setStyle(slotEl, 'position', 'absolute');
    setStyle(slotEl, 'width', HOTBAR_SLOT + 'px');
    setStyle(slotEl, 'height', HOTBAR_SLOT + 'px');
    setStyle(slotEl, 'boxSizing', 'border-box');
    setStyle(slotEl, 'border', '1px solid var(--ash-500)');
    setStyle(slotEl, 'pointerEvents', 'auto'); // 09 §3.4 z30 precedent: auto on the plinth's own chrome
    this._hudContainer.appendChild(slotEl);

    const punchWrapper = el('div', 'cl2-hb-punch');
    setStyle(punchWrapper, 'position', 'absolute');
    setStyle(punchWrapper, 'left', '4px');
    setStyle(punchWrapper, 'top', '4px');
    setStyle(punchWrapper, 'width', HOTBAR_ICON + 'px');
    setStyle(punchWrapper, 'height', HOTBAR_ICON + 'px');
    setStyle(punchWrapper, 'transformOrigin', '50% 50%');
    setStyle(punchWrapper, 'pointerEvents', 'none');
    slotEl.appendChild(punchWrapper);

    const iconCanvas = el('canvas', 'cl2-hb-icon');
    iconCanvas.width = HOTBAR_ICON;
    iconCanvas.height = HOTBAR_ICON;
    setStyle(iconCanvas, 'position', 'absolute');
    setStyle(iconCanvas, 'left', '0');
    setStyle(iconCanvas, 'top', '0');
    setStyle(iconCanvas, 'width', HOTBAR_ICON + 'px');
    setStyle(iconCanvas, 'height', HOTBAR_ICON + 'px');
    punchWrapper.appendChild(iconCanvas);

    const keyCapEl = el('div', 'cl2-hb-keycap');
    setStyle(keyCapEl, 'position', 'absolute');
    setStyle(keyCapEl, 'left', '4px');
    setStyle(keyCapEl, 'bottom', '2px');
    setStyle(keyCapEl, 'fontFamily', 'var(--ff-sans)');
    setStyle(keyCapEl, 'fontSize', 'var(--t-micro-size)');
    setStyle(keyCapEl, 'fontWeight', 'var(--t-micro-weight)');
    setStyle(keyCapEl, 'letterSpacing', 'var(--t-micro-tracking)');
    setStyle(keyCapEl, 'textTransform', 'var(--t-micro-transform)');
    setStyle(keyCapEl, 'color', 'var(--ink-3)');
    setStyle(keyCapEl, 'pointerEvents', 'none');
    setText(keyCapEl, HOTBAR_KEYS[index]);
    slotEl.appendChild(keyCapEl);

    const cdTextEl = el('div', 'cl2-hb-cd');
    setStyle(cdTextEl, 'position', 'absolute');
    setStyle(cdTextEl, 'right', '4px');
    setStyle(cdTextEl, 'bottom', '2px');
    setStyle(cdTextEl, 'fontFamily', 'var(--ff-mono)');
    setStyle(cdTextEl, 'fontSize', 'var(--t-num-s-size)');
    setStyle(cdTextEl, 'fontWeight', 'var(--t-num-s-weight)');
    setStyle(cdTextEl, 'color', 'var(--ink-1)');
    setStyle(cdTextEl, 'display', 'none');
    setStyle(cdTextEl, 'pointerEvents', 'none');
    slotEl.appendChild(cdTextEl);

    const onPress = () => this.pressSlot(index);
    if (typeof slotEl.addEventListener === 'function') slotEl.addEventListener('mousedown', onPress);

    return { slotEl, punchWrapper, iconCanvas, iconCtx: typeof iconCanvas.getContext === 'function' ? iconCanvas.getContext('2d') : null, keyCapEl, cdTextEl };
  }

  _buildBeltSlotDom(index) {
    const slotEl = el('div', 'cl2-belt-slot');
    setStyle(slotEl, 'position', 'absolute');
    setStyle(slotEl, 'width', BELT_SLOT + 'px');
    setStyle(slotEl, 'height', BELT_SLOT + 'px');
    setStyle(slotEl, 'boxSizing', 'border-box');
    setStyle(slotEl, 'border', '1px solid var(--ash-500)');
    setStyle(slotEl, 'pointerEvents', 'auto');
    this._hudContainer.appendChild(slotEl);

    const iconCanvas = el('canvas', 'cl2-belt-icon');
    iconCanvas.width = BELT_ICON;
    iconCanvas.height = BELT_ICON;
    setStyle(iconCanvas, 'position', 'absolute');
    setStyle(iconCanvas, 'left', '4px');
    setStyle(iconCanvas, 'top', '4px');
    setStyle(iconCanvas, 'width', BELT_ICON + 'px');
    setStyle(iconCanvas, 'height', BELT_ICON + 'px');
    setStyle(iconCanvas, 'pointerEvents', 'none');
    slotEl.appendChild(iconCanvas);

    const keyCapEl = el('div', 'cl2-belt-keycap');
    setStyle(keyCapEl, 'position', 'absolute');
    setStyle(keyCapEl, 'left', '4px');
    setStyle(keyCapEl, 'top', '2px');
    setStyle(keyCapEl, 'fontFamily', 'var(--ff-sans)');
    setStyle(keyCapEl, 'fontSize', 'var(--t-micro-size)');
    setStyle(keyCapEl, 'fontWeight', 'var(--t-micro-weight)');
    setStyle(keyCapEl, 'color', 'var(--ink-3)');
    setStyle(keyCapEl, 'pointerEvents', 'none');
    setText(keyCapEl, BELT_KEYS[index]);
    slotEl.appendChild(keyCapEl);

    const countEl = el('div', 'cl2-belt-count');
    setStyle(countEl, 'position', 'absolute');
    setStyle(countEl, 'right', '3px');
    setStyle(countEl, 'bottom', '1px');
    setStyle(countEl, 'fontFamily', 'var(--ff-mono)');
    setStyle(countEl, 'fontSize', 'var(--t-num-s-size)');
    setStyle(countEl, 'fontWeight', 'var(--t-num-s-weight)');
    setStyle(countEl, 'color', 'var(--ink-1)');
    setStyle(countEl, 'display', 'none');
    setStyle(countEl, 'pointerEvents', 'none');
    slotEl.appendChild(countEl);

    const onPress = () => this.pressBeltSlot(index);
    if (typeof slotEl.addEventListener === 'function') slotEl.addEventListener('mousedown', onPress);

    return { slotEl, iconCanvas, iconCtx: typeof iconCanvas.getContext === 'function' ? iconCanvas.getContext('2d') : null, keyCapEl, countEl };
  }

  _buildPromptDom() {
    const wrap = el('div', 'cl2-prompt');
    setStyle(wrap, 'position', 'absolute');
    setStyle(wrap, 'display', 'none');
    setStyle(wrap, 'pointerEvents', 'none');
    setStyle(wrap, 'background', 'var(--e1-fill)');
    setStyle(wrap, 'border', 'var(--edge)');
    setStyle(wrap, 'boxShadow', 'var(--e1-shadow)');
    setStyle(wrap, 'padding', 'var(--space-2) var(--space-4)');
    setStyle(wrap, 'whiteSpace', 'nowrap');
    this._feedbackContainer.appendChild(wrap);

    const keyEl = el('span', 'cl2-prompt-key');
    setStyle(keyEl, 'fontFamily', 'var(--ff-sans)');
    setStyle(keyEl, 'fontSize', 'var(--t-label-size)');
    setStyle(keyEl, 'fontWeight', 'var(--t-label-weight)');
    setStyle(keyEl, 'color', 'var(--ember)');
    wrap.appendChild(keyEl);

    const textEl = el('span', 'cl2-prompt-text');
    setStyle(textEl, 'fontFamily', 'var(--ff-sans)');
    setStyle(textEl, 'fontSize', 'var(--t-body-em-size)');
    setStyle(textEl, 'fontWeight', 'var(--t-body-em-weight)');
    setStyle(textEl, 'color', 'var(--ink-1)');
    setStyle(textEl, 'marginLeft', 'var(--space-2)');
    wrap.appendChild(textEl);

    return { wrap, keyEl, textEl };
  }

  _buildBannerDom() {
    const wrap = el('div', 'cl2-banner');
    setStyle(wrap, 'position', 'absolute');
    setStyle(wrap, 'display', 'none');
    setStyle(wrap, 'pointerEvents', 'none');
    setStyle(wrap, 'textAlign', 'center');
    setStyle(wrap, 'transformOrigin', '50% 50%');
    this._feedbackContainer.appendChild(wrap);

    const titleEl = el('div', 'cl2-banner-title');
    setStyle(titleEl, 'fontFamily', 'var(--ff-serif)');
    setStyle(titleEl, 'fontSize', 'var(--t-display-size)');
    setStyle(titleEl, 'fontWeight', 'var(--t-display-weight)');
    setStyle(titleEl, 'letterSpacing', 'var(--t-display-tracking)');
    setStyle(titleEl, 'color', 'var(--ink-1)');
    setStyle(titleEl, 'textShadow', 'var(--sh-o2)');
    wrap.appendChild(titleEl);

    const subEl = el('div', 'cl2-banner-sub');
    setStyle(subEl, 'fontFamily', 'var(--ff-sans)');
    setStyle(subEl, 'fontSize', 'var(--t-label-size)');
    setStyle(subEl, 'letterSpacing', 'var(--t-label-tracking)');
    setStyle(subEl, 'textTransform', 'var(--t-label-transform)');
    setStyle(subEl, 'color', 'var(--ink-2)');
    wrap.appendChild(subEl);

    return { wrap, titleEl, subEl };
  }

  _buildToastDom() {
    const row = el('div', 'cl2-toast');
    setStyle(row, 'position', 'absolute');
    setStyle(row, 'left', '0');
    setStyle(row, 'top', '0');
    setStyle(row, 'display', 'none');
    setStyle(row, 'pointerEvents', 'none');
    setStyle(row, 'width', TOAST_ROW_W + 'px');
    setStyle(row, 'height', TOAST_ROW_H + 'px');
    setStyle(row, 'boxSizing', 'border-box');
    setStyle(row, 'lineHeight', TOAST_ROW_H + 'px');
    setStyle(row, 'padding', '0 ' + 'var(--space-3)');
    setStyle(row, 'whiteSpace', 'nowrap');
    setStyle(row, 'overflow', 'hidden');
    setStyle(row, 'textOverflow', 'ellipsis');
    setStyle(row, 'background', 'var(--e1-fill)');
    setStyle(row, 'borderTop', 'var(--edge)');
    setStyle(row, 'fontFamily', 'var(--ff-sans)');
    setStyle(row, 'fontSize', 'var(--t-body-size)');
    // SD-3 Ash Dissolve — "on the left edge" (09 §4.10's own literal
    // wording); a static mask, set once, never touched per frame.
    setStyle(row, 'maskImage', 'linear-gradient(to right, transparent 0%, black 12%)');
    setStyle(row, 'webkitMaskImage', 'linear-gradient(to right, transparent 0%, black 12%)');
    this._feedbackContainer.appendChild(row);
    return { row };
  }

  // -------------------------------------------------------------------
  // Layout
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
    const vw = this._vw;
    const vh = this._vh;
    const cx = vw / 2;

    const hotbarCy = vh - HOTBAR_CY_INSET;
    for (let i = 0; i < HOTBAR_COUNT; i++) {
      const centerX = cx + (i - 1.5) * HOTBAR_PITCH;
      const { slotEl } = this._hotbar[i].dom;
      setStyle(slotEl, 'left', (centerX - HOTBAR_SLOT / 2) + 'px');
      setStyle(slotEl, 'top', (hotbarCy - HOTBAR_SLOT / 2) + 'px');
    }

    const beltCy = vh - BELT_CY_INSET;
    for (let i = 0; i < BELT_COUNT; i++) {
      const centerX = cx + (i - 1.5) * BELT_PITCH;
      const { slotEl } = this._belt[i].dom;
      setStyle(slotEl, 'left', (centerX - BELT_SLOT / 2) + 'px');
      setStyle(slotEl, 'top', (beltCy - BELT_SLOT / 2) + 'px');
    }

    setStyle(this._prompt.dom.wrap, 'left', (cx - 160) + 'px');
    setStyle(this._prompt.dom.wrap, 'top', '700px'); // 09 §4.10: "centred at (960, 700)"
    setStyle(this._prompt.dom.wrap, 'width', '320px');
    setStyle(this._prompt.dom.wrap, 'textAlign', 'center');

    // Banner position: not given by the read range (§4.9 defers to §10.5,
    // out of scope) — this file's own placement choice, see report.
    setStyle(this._banner.dom.wrap, 'left', (cx - 400) + 'px');
    setStyle(this._banner.dom.wrap, 'top', (vh * 0.30) + 'px');
    setStyle(this._banner.dom.wrap, 'width', '800px');

    // `place()` owns both axes via `translate3d` (./util.js's own contract:
    // "never left/top") — only the x offset is cached here; `_paintToast`
    // supplies it alongside the per-record damped y every frame.
    this._toastLeft = vw - TOAST_X_INSET - TOAST_ROW_W;
  }

  // -------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------

  /**
   * @param {number} dt - the scaled game-clock delta (`ctx.time.dt`).
   * @param {object} ctx
   */
  update(dt, ctx) {
    if (!this._visible) return;
    this._ctx = ctx;
    this._syncViewport(ctx);

    // Self-healing cache (see the constructor's own comment): a bare-ctx
    // construction (this ticket's own tests) can leave these null even
    // though a fuller `ctx` later reaches `update()`.
    if (!this._items) this._items = safeGet(ctx, 'items');
    if (!this._player) this._player = safeGet(ctx, 'player');

    this._updateHotbarSelection();
    for (let i = 0; i < HOTBAR_COUNT; i++) this._updateHotbarSlot(this._hotbar[i], i, dt);

    this._pollBeltCooldown();
    for (let i = 0; i < BELT_COUNT; i++) this._updateBeltSlot(this._belt[i], i, dt);

    this._updatePrompt(dt);
    this._updateBanner(dt);

    this._toastDt = dt;
    this._toastPool.forEachActive(this._toastAdvance);
  }

  _updateHotbarSelection() {
    // Forward-compatible poll (see file header): once `player.hotbar` is
    // real, `rightMouse` overrides the locally-tracked selection every
    // frame; until then this is a no-op and `pressSlot` is the only writer.
    const player = this._player;
    if (player && player.hotbar && typeof player.hotbar.rightMouse === 'number') {
      this._selectedSlot = player.hotbar.rightMouse;
    }
  }

  _updateHotbarSlot(slot, index, dt) {
    // Cooldown (dev/test-only local clock — see file header).
    if (slot.cdRemaining > 0) {
      slot.cdRemaining = Math.max(0, slot.cdRemaining - dt);
      if (slot.cdRemaining <= 0) { slot.cdRemaining = 0; slot.cdTotal = 0; }
    }
    const angle = slot.cdTotal > 0 ? Math.round(360 * clamp(slot.cdRemaining / slot.cdTotal, 0, 1)) : 0;
    if (angle !== slot.lastAngle) {
      slot.lastAngle = angle;
      const base = slot.skillId ? 'var(--ash-700)' : 'var(--ash-800)';
      setStyle(slot.dom.slotEl, 'background', angle > 0
        ? `conic-gradient(from 0deg, ${SWEEP_RGBA} 0deg ${angle}deg, transparent ${angle}deg), ${base}`
        : base);
    }
    if (angle > 0) {
      const seconds = formatCooldownSeconds(slot.cdRemaining);
      if (seconds !== slot.lastCdSeconds) {
        slot.lastCdSeconds = seconds;
        setText(slot.dom.cdTextEl, seconds);
      }
      setStyle(slot.dom.cdTextEl, 'display', 'block');
    } else if (slot.lastCdSeconds !== null) {
      slot.lastCdSeconds = null;
      setStyle(slot.dom.cdTextEl, 'display', 'none');
    }

    // Selected (RMB-bound) treatment — 09 §4.2's own ember border+seam.
    const selected = index === this._selectedSlot;
    if (selected !== slot.lastSelected) {
      slot.lastSelected = selected;
      setStyle(slot.dom.slotEl, 'border', selected ? '2px solid var(--ember)' : '1px solid var(--ash-500)');
      setStyle(slot.dom.slotEl, 'boxShadow', selected ? 'inset 0 -2px 0 var(--ember)' : 'none');
    }

    // Empty/ready key-cap opacity (09 §4.2: "key cap at 30% opacity" empty).
    const keyCapOpacity = slot.skillId ? 1 : 0.3;
    if (keyCapOpacity !== slot.lastKeyCapOpacity) {
      slot.lastKeyCapOpacity = keyCapOpacity;
      setStyle(slot.dom.keyCapEl, 'opacity', String(keyCapOpacity));
    }

    // Punch (09 §4.2: "scale = 1 + 0.12*(1-easeOutQuint(t/0.14))").
    if (slot.punchT < PUNCH_DURATION) {
      slot.punchT = Math.min(PUNCH_DURATION, slot.punchT + dt);
      const u = clamp(slot.punchT / PUNCH_DURATION, 0, 1);
      const scale = 1 + PUNCH_SCALE * (1 - easeOutQuint(u));
      const scaleQ = Math.round(scale * 1000);
      if (scaleQ !== slot.lastPunchQ) {
        slot.lastPunchQ = scaleQ;
        setStyle(slot.dom.punchWrapper, 'transform', 'scale(' + (scaleQ / 1000).toFixed(3) + ')');
      }
    } else if (slot.lastPunchQ !== 1000) {
      slot.lastPunchQ = 1000;
      setStyle(slot.dom.punchWrapper, 'transform', 'scale(1)');
    }

    this._drawHotbarIcon(slot);
  }

  _drawHotbarIcon(slot) {
    const g = slot.dom.iconCtx;
    if (!g || slot.lastDrawnSkillId === slot.skillId) return;
    slot.lastDrawnSkillId = slot.skillId;
    g.clearRect(0, 0, HOTBAR_ICON, HOTBAR_ICON);
    if (!slot.skillId) return; // empty — 09 §4.2: "icon absent"
    // Placeholder glyph — see file header ("Icons — placeholder glyphs").
    g.fillStyle = '#4c4136';
    g.beginPath();
    g.arc(HOTBAR_ICON / 2, HOTBAR_ICON / 2, HOTBAR_ICON / 2 - 4, 0, Math.PI * 2);
    g.fill();
  }

  _pollBeltCooldown() {
    const items = this._items;
    const player = this._player;
    const actor = player && player.actor;
    this._beltCooldownRemaining = (items && actor && typeof items.beltCooldown === 'function')
      ? items.beltCooldown(actor)
      : 0;
  }

  _updateBeltSlot(slot, index, dt) {
    const items = this._items;
    const player = this._player;
    const actor = player && player.actor;
    const count = (items && actor && typeof items.beltCount === 'function') ? items.beltCount(actor, index) : 0;

    if (slot.drinkT < DRINK_FLASH_DURATION) slot.drinkT = Math.min(DRINK_FLASH_DURATION, slot.drinkT + dt);

    const angle = Math.round(360 * clamp(this._beltCooldownRemaining / BELT_COOLDOWN_TOTAL, 0, 1));
    slot.lastAngle = angle;
    const drinkAlpha = slot.drinkT < DRINK_FLASH_DURATION
      ? DRINK_FLASH_ALPHA * (1 - clamp(slot.drinkT / DRINK_FLASH_DURATION, 0, 1))
      : 0;
    const drinkAlphaQ = Math.round(drinkAlpha * 100);
    const occupiedFlag = count > 0 ? 1 : 0;
    if (angle !== slot.lastBgAngle || drinkAlphaQ !== slot.lastBgDrinkQ || occupiedFlag !== slot.lastBgOccupied) {
      slot.lastBgAngle = angle;
      slot.lastBgDrinkQ = drinkAlphaQ;
      slot.lastBgOccupied = occupiedFlag;
      const layers = [];
      if (drinkAlphaQ > 0) layers.push(`rgba(255,255,255,${(drinkAlphaQ / 100).toFixed(2)})`);
      if (angle > 0) layers.push(`conic-gradient(from 0deg, ${SWEEP_RGBA} 0deg ${angle}deg, transparent ${angle}deg)`);
      layers.push(occupiedFlag ? 'var(--ash-700)' : 'var(--ash-800)');
      setStyle(slot.dom.slotEl, 'background', layers.join(', '));
    }

    if (count !== slot.count) {
      slot.count = count;
      if (count <= 0) {
        setStyle(slot.dom.countEl, 'display', 'none');
        setStyle(slot.dom.keyCapEl, 'opacity', '0.3');
      } else {
        setStyle(slot.dom.keyCapEl, 'opacity', '1');
        setStyle(slot.dom.countEl, 'display', 'block');
        // "hidden at 1" is the generic item-cell default (09 §4.3); "last
        // one" is this widget's own explicit override, shown in danger-ink
        // — an ambiguity this file resolves by always showing the count
        // once occupied and letting the colour carry the warning (see
        // report).
        setText(slot.dom.countEl, '×' + numStr(count));
        setStyle(slot.dom.countEl, 'color', count === 1 ? 'var(--danger-ink)' : 'var(--ink-1)');
      }
      this._drawBeltIcon(slot, count > 0);
    }
  }

  _drawBeltIcon(slot, occupied) {
    const g = slot.dom.iconCtx;
    if (!g) return;
    g.clearRect(0, 0, BELT_ICON, BELT_ICON);
    if (!occupied) return;
    g.fillStyle = '#3f8f7a';
    g.beginPath();
    g.arc(BELT_ICON / 2, BELT_ICON / 2, BELT_ICON / 2 - 4, 0, Math.PI * 2);
    g.fill();
  }

  // -------------------------------------------------------------------
  // Prompt — 09 §4.10
  // -------------------------------------------------------------------

  _updatePrompt(dt) {
    const target = this._prompt.shown ? 1 : 0;
    // Linear ramp over PROMPT_FADE_S — matches 09 §4.10's "fades in over
    // 120ms" literally (no damp curve is named for this one, unlike most
    // of §2.6's table). Uses the passed `dt` (the scaled game clock) for
    // the ramp — the same precedent `tooltip.js`'s own fade already sets
    // for a nominally "raw clock" effect (see this file's report).
    if (this._prompt.opacity !== target) {
      const step = dt / PROMPT_FADE_S;
      this._prompt.opacity = target > this._prompt.opacity
        ? Math.min(target, this._prompt.opacity + step)
        : Math.max(target, this._prompt.opacity - step);
    }
    const opacityQ = Math.round(this._prompt.opacity * 1000);
    if (opacityQ !== this._prompt.lastOpacityQ) {
      this._prompt.lastOpacityQ = opacityQ;
      const o = opacityQ / 1000;
      setStyle(this._prompt.dom.wrap, 'opacity', String(o));
      setStyle(this._prompt.dom.wrap, 'display', o > 0.004 ? 'block' : 'none');
    }
  }

  _updateBanner(dt) {
    const b = this._banner;
    if (!b.active) return;
    b.t += dt;
    const outStart = BANNER_IN_S + b.hold;
    const total = outStart + BANNER_OUT_S;

    let scale, opacity;
    if (b.t < BANNER_IN_S) {
      const u = clamp(b.t / BANNER_IN_S, 0, 1);
      scale = 1.06 + (1.00 - 1.06) * easeOutBack(u);
      opacity = u;
    } else if (b.t < outStart) {
      scale = 1;
      opacity = 1;
    } else if (b.t < total) {
      scale = 1;
      opacity = 1 - clamp((b.t - outStart) / BANNER_OUT_S, 0, 1);
    } else {
      scale = 1;
      opacity = 0;
      b.active = false;
    }

    const scaleQ = Math.round(scale * 1000);
    if (scaleQ !== b.lastScaleQ) {
      b.lastScaleQ = scaleQ;
      setStyle(b.dom.wrap, 'transform', 'scale(' + (scaleQ / 1000).toFixed(3) + ')');
    }
    const opacityQ = Math.round(opacity * 1000);
    if (opacityQ !== b.lastOpacityQ) {
      b.lastOpacityQ = opacityQ;
      setStyle(b.dom.wrap, 'opacity', String(opacityQ / 1000));
      setStyle(b.dom.wrap, 'display', opacityQ > 4 ? 'block' : 'none');
    }
  }

  // -------------------------------------------------------------------
  // Toasts — 09 §4.10
  // -------------------------------------------------------------------

  _paintToast(rec, alpha) {
    place(rec.dom.row, this._toastLeft, Math.round(rec.dispY * 2) / 2);
    const alphaQ = Math.round(alpha * 1000);
    if (rec.lastAlphaQ !== alphaQ) {
      rec.lastAlphaQ = alphaQ;
      setStyle(rec.dom.row, 'opacity', String(alphaQ / 1000));
      setStyle(rec.dom.row, 'display', alphaQ > 4 ? 'block' : 'none');
    }
  }

  // -------------------------------------------------------------------
  // Public API — the three `02-api-contracts.md` §14 rows this ticket owns
  // -------------------------------------------------------------------

  /** `setPrompt(spec:{key,text,sub}|null) => void`. */
  setPrompt(spec) {
    const p = this._prompt;
    if (!spec) {
      p.shown = false;
      p.lastKey = null; p.lastText = null; p.lastSub = null;
      return;
    }
    const key = spec.key || '';
    const text = spec.text || '';
    const sub = spec.sub || '';
    if (key !== p.lastKey || text !== p.lastText || sub !== p.lastSub) {
      p.lastKey = key; p.lastText = text; p.lastSub = sub;
      setText(p.dom.keyEl, '[' + key + ']');
      setText(p.dom.textEl, sub ? text + ' ' + sub : text);
    }
    p.shown = true;
  }

  /** `banner(title, subtitle, seconds) => void`. */
  banner(title, subtitle, seconds) {
    const b = this._banner;
    b.active = true;
    b.t = 0;
    b.hold = Math.max(0, Number(seconds) || 0);
    b.lastScaleQ = -1; b.lastOpacityQ = -1;
    setText(b.dom.titleEl, String(title || ''));
    setText(b.dom.subEl, String(subtitle || ''));
  }

  /** `toast(text, kind) => void`. `kind==='loot'` has no rarity in this
   * signature (`02-api-contracts.md` gives `toast` no rarity parameter,
   * unlike `09 §4.10`'s prose, which assumes one) — see file header /
   * report; falls back to a fixed gold-ish tone. */
  toast(text, kind) {
    this._toastPool.forEachActive(this._toastRankScratch);
    const rec = this._toastPool.acquire();
    if (!rec) return; // pool momentarily exhausted mid-eviction — never throw
    rec.rank = 0;
    rec.t = 0;
    rec.life = TOAST_LIFE;
    rec.text = String(text || '');
    rec.colour = kind === 'warn' ? '#e35a4e' : kind === 'loot' ? '#ffe066' : '#c8bda8';
    rec.dispY = TOAST_Y0 - (TOAST_ROW_H + TOAST_ROW_GAP); // eases in from just above the top slot
    rec.lastAlphaQ = -1;
    setText(rec.dom.row, rec.text);
    setStyle(rec.dom.row, 'color', rec.colour);
  }

  // -------------------------------------------------------------------
  // Real interaction entry points
  // -------------------------------------------------------------------

  /** Punches hotbar slot `index` (0..3) and rebinds the locally-tracked
   * selection (`01-data-model.md` §6.4's `Hotbar.rightMouse`) — the real,
   * always-reachable half of `09 §4.2`'s "pressing 1-4 ... casts the skill
   * ... and rebinds RMB". Does not itself start a cooldown — see the file
   * header for why. Forwards defensively to `player`, never throwing when
   * absent (today, always). */
  pressSlot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= HOTBAR_COUNT) return;
    this._selectedSlot = index;
    this._hotbar[index].punchT = 0;

    const player = this._player;
    if (player && typeof player.castOrder === 'function') {
      let gx = 0, gz = 0;
      if (typeof player.groundCursor === 'function') {
        const c = player.groundCursor(this._groundCursorScratch || (this._groundCursorScratch = { x: 0, y: 0, z: 0 }));
        gx = c.x; gz = c.z;
      }
      const targetId = typeof player.hoverTarget === 'number' ? player.hoverTarget : 0;
      player.castOrder(index, gx, gz, targetId);
    }
  }

  /** Drinks belt slot `index` (0..3) — real today via `items.beltUse`
   * (ITEM-10). See file header for why this does not also forward to a
   * hypothetical `player.useBelt`. */
  pressBeltSlot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= BELT_COUNT) return;
    const items = this._items;
    const player = this._player;
    const actor = player && player.actor;
    if (!items || !actor || typeof items.beltUse !== 'function') return;
    if (items.beltUse(actor, index)) {
      this._belt[index].drinkT = 0;
    }
  }

  // -------------------------------------------------------------------
  // Screen gating — same principle as hud.js/feedback.js (09-ui.md:2128,
  // generalised): no draw, no per-frame work, off the `game` screen.
  // -------------------------------------------------------------------

  setVisible(visible) {
    const next = !!visible;
    if (this._visible === next) return;
    this._visible = next;
    setStyle(this._hudContainer, 'display', next ? 'block' : 'none');
    setStyle(this._feedbackContainer, 'display', next ? 'block' : 'none');
  }

  dispose() {
    if (this._hudContainer && this._hudContainer.remove) this._hudContainer.remove();
    this._hudContainer = null;
    if (this._feedbackContainer && this._feedbackContainer.remove) this._feedbackContainer.remove();
    this._feedbackContainer = null;
  }

  // -------------------------------------------------------------------
  // Dev/test-only inspection and staging — double-underscore, not part of
  // `02-api-contracts.md` (rule 7), matching hud.js/feedback.js's own
  // convention for this tier.
  // -------------------------------------------------------------------

  /** Starts a LOCAL, dev/test-only cooldown clock on hotbar slot `index` —
   * see the file header's "Skills do not exist yet" section for why this,
   * not `pressSlot`, is what the sweep's own acceptance clause exercises. */
  __debugStageCooldown(index, totalSeconds) {
    if (!Number.isInteger(index) || index < 0 || index >= HOTBAR_COUNT) return;
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const slot = this._hotbar[index];
    slot.cdTotal = seconds;
    slot.cdRemaining = seconds;
    slot.lastAngle = -1;
  }

  __hotbarAngle(index) {
    return this._hotbar[index] ? this._hotbar[index].lastAngle : -1;
  }

  __hotbarCooldown(index) {
    const s = this._hotbar[index];
    return s ? { remaining: s.cdRemaining, total: s.cdTotal } : null;
  }

  __selectedSlot() {
    return this._selectedSlot;
  }

  __beltCount(index) {
    return this._belt[index] ? this._belt[index].count : -1;
  }

  __beltAngle(index) {
    return this._belt[index] ? this._belt[index].lastAngle : -1;
  }

  __toastActiveCount() {
    return this._toastPool.activeCount;
  }

  __toastPoolCapacity() {
    return this._toastPool.capacity;
  }

  __promptOpacity() {
    return this._prompt.opacity;
  }

  __bannerState() {
    return { active: this._banner.active, t: this._banner.t };
  }
}
