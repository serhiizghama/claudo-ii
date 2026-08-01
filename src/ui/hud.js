// src/ui/hud.js
//
// UI-2 — `09-ui.md` §15's U1 row: "Plinth, orbs, XP". The e1 plate, both orb
// canvases with the liquid model and all three resource dialects, resonance
// pips, the two ledgers, and the XP bar. Owned by `ui` (ARCHITECTURE.md
// ownership map: "HUD ... " under `src/ui/`), constructed and driven by
// `UiSystem` (`./index.js`) — see that file's header for the two lines that
// wire this module in.
//
// ---------------------------------------------------------------------------
// D-A — the only path a persistent value reaches this file
// ---------------------------------------------------------------------------
// Once per `lateUpdate`, `update(dt, ctx)` below calls `player.hudState(this
// ._hud)` into a preallocated `HudState` and reads only that object for the
// rest of the frame (`09 §D-A`). No event is read here for a steady-state
// value — the XP chase segment and every orb's ghost band are derived by
// comparing this frame's polled value against last frame's, never by
// subscribing to `xp:gain`/`actor:damage` (neither is in `ui`'s `Listens`
// row at `02-api-contracts.md` §14 today; U3 owns the transient feedback
// layer that does listen for those). `debugState('combat')` is the one
// documented exception — see that method's own comment — and it is a
// dev-only escape hatch structurally identical to `ai.debugStage(...)`
// (`09 §15` U4's acceptance row), never reachable from real gameplay.
//
// ---------------------------------------------------------------------------
// Canvas colour tokens are transcribed, not invented (see report)
// ---------------------------------------------------------------------------
// `09 §2`'s design tokens live in `./style.js` as CSS custom properties on
// `.cl2-ui`. A DOM node can reference them with `var(--token)` (used
// throughout this file for every text/plate colour). A `<canvas>` 2D
// context cannot — `ctx.fillStyle = 'var(--life-top)'` is simply not a
// legal canvas colour, and reading the resolved value would need
// `getComputedStyle`, which `09 §13.4` rule 1 forbids inside `lateUpdate`
// (and which the Node DOM shim `./util.js` uses under `node --test` does
// not implement at all). The `C_*` constants below are transcribed
// byte-for-byte from `style.js`'s `TOKENS_CSS` for exactly the tokens the
// orbs draw with, so they track the design system's actual values rather
// than a second, drifting copy of "roughly orange".

import { el, setText, setStyle, damp, clamp, numStr } from './util.js';

// ---------------------------------------------------------------------------
// Canvas colours — transcribed from style.js TOKENS_CSS (see header)
// ---------------------------------------------------------------------------
const C_LIFE_TOP = '#e0453a';
const C_LIFE_BOTTOM = '#7a1410';
const C_LIFE_GHOST = 'rgba(240,168,158,0.34)';
const C_MANA_TOP = '#4a7ff0';
const C_MANA_BOTTOM = '#16307a';
const C_MANA_GHOST = 'rgba(148,180,240,0.34)'; // 09 §4.1 step 2: "or the resource's ghost tint" — no separate --mana-ghost token exists in style.js today (an ambiguity this ticket resolved, see report); this lightens --mana-top the same way --life-ghost lightens --life-top.
const C_RAGE_TOP = '#f0821f';
const C_RAGE_BOTTOM = '#8a3c06';
const C_ASH_500 = '#3a3128';
const C_ASH_700 = '#1e1a15';
const C_ASH_800 = '#16130f';
const C_VOID = '#0a0908';
const C_DANGER = '#c8322a';
const C_EMBER = '#e0622a';
const C_EMBER_DIM = '#8f3d1a';
const C_RESONANCE = '#7fd8e8';

// ---------------------------------------------------------------------------
// Geometry — 09 §3.2's screen map (1920x1080, k=1), generalised to the
// actual viewport (see `_syncViewport` below): every anchor is expressed as
// an inset from an edge/centre, matching the table's own "bottom-left of
// the plinth" / "centred on x=960" language rather than the literal 1920
// numbers, so the same code lands correctly at the 1280x720 capture
// resolution (`12-testing.md` §6) as well as a real 1920x1080 frame.
// ---------------------------------------------------------------------------
const PLINTH_H = 140;
const XP_H = 8;
const ORB_SIZE = 148; // canvas CSS px, 09 §4.1
const ORB_D = 132; // liquid/rage drawing diameter, 09 §4.1/§2.5
const ORB_R = ORB_D / 2;
const ORB_INSET_X = 110; // orb centre inset from the left/right screen edge
const ORB_INSET_BOTTOM = 76; // orb centre inset from the bottom edge (1080-1004)
const LEDGER_W = 220;
const LEDGER_H = 64;
const LEDGER_INSET_X = 190; // left ledger x / right ledger's inset from the right edge
const LEDGER_TOP_OFFSET = 16; // below the plinth's own top edge (956-940)
const RESONANCE_PIP_MAX = 8; // 09 §4.1.4: preallocated at maxResonance = 8
const RESONANCE_PIP_SIZE = 14;
const RESONANCE_ARC_R = 76; // 152px arc / 2
const RESONANCE_ARC_START = 232; // degrees
const RESONANCE_ARC_SPAN = 76; // 308 - 232

// ---------------------------------------------------------------------------
// Motion constants — 09 §2.6 / §4.1's own numbers
// ---------------------------------------------------------------------------
const ORB_CHASE_RATE = 9; // /s, damp rate toward the true fraction
const GHOST_HOLD_S = 0.55;
const GHOST_DRAIN_PER_S = 0.60; // fraction of max per second
const XP_CHASE_RATE = 6;
const WAVE_AMP_1 = 1.6;
const WAVE_FREQ_1 = 5.2;
const WAVE_RATE_1 = 1.70;
const WAVE_AMP_2 = 0.9;
const WAVE_FREQ_2 = 9.1;
const WAVE_RATE_2 = 2.90;
const RAGE_IGNITE_RATE = 3.4;
const RESONANCE_FLASH_S = 0.12;
const TWO_PI = Math.PI * 2;

/** `09 §16.4`/`02-api-contracts.md:1199-1213`'s `HudState` literal,
 * transcribed verbatim — the preallocated `out` this module hands to
 * `player.hudState()` every frame (D-A) and, in debug mode, writes into
 * directly (see `debugState`). Matching `src/player/index.js`'s own
 * `_hudScratch` shape field-for-field. */
function makeHudState() {
  return {
    life: 0, maxLife: 0, mana: 0, maxMana: 0,
    secondary: 0, maxSecondary: 0, secondaryKind: 'rage',
    secondaryDecay: 0,
    level: 1, xp: 0, xpFloor: 0, xpCeiling: 50, xpTotal: 0,
    statPoints: 0, skillPoints: 0, gold: 0,
    cooldowns: [0, 0, 0, 0], hotbar: [null, null, null, null],
    belt: [0, 0, 0, 0], targetId: 0, difficulty: 'instruction',
    zoneId: 'last_bastion', questStep: 0,
    name: '', classId: 'ravager',
    inCombat: false,
  };
}

/** One orb's animation state — the liquid chase, the ghost band and the
 * wave phases (09 §2.5 SD-1 / §4.1). Built once in the constructor, mutated
 * in place every frame; never reallocated. */
function makeOrbState() {
  return {
    trueFrac: 0, shownFrac: 0, ghostFrac: 0, ghostHold: 0,
    phase1: 0, phase2: 0,
    lastValue: -1, lastMax: -1, // numeral change-guard, raw units not fraction
  };
}

/** `09 §15` U1's three staged demonstration classes for `debugState('combat')`
 * — see that method's own header for why these exist and why they are not
 * derived from a real `Actor`. Life is pinned at 412/540 for all three
 * (this ticket's own acceptance wording); `secondaryDecay` stays at the
 * `HudState` contract default `0` in every preset — O-64, never faked. */
const DEBUG_COMBAT_PRESETS = [
  { classId: 'ravager', level: 13, gold: 4820, difficulty: 'instruction', life: 412, maxLife: 540, mana: 40, maxMana: 120, secondaryKind: 'rage', secondary: 62, maxSecondary: 100 },
  { classId: 'runeblade', level: 13, gold: 4820, difficulty: 'instruction', life: 412, maxLife: 540, mana: 210, maxMana: 340, secondaryKind: 'resonance', secondary: 5, maxSecondary: 8 },
  { classId: 'emberwright', level: 13, gold: 4820, difficulty: 'instruction', life: 412, maxLife: 540, mana: 480, maxMana: 610, secondaryKind: 'mana', secondary: 0, maxSecondary: 0 },
];

export class Hud {
  /**
   * @param {object} ctx - the shared engine context (ARCHITECTURE.md).
   *   `ctx.canvas`/`ctx.get` are read defensively — under `node --test`
   *   (`tests/ui/hud.test.js`, and `UiSystem`'s own `init({})` calls in
   *   `tests/ui/ui1.test.js`) several of these are absent, and this
   *   constructor must not throw either way. `ctx.rng` is never read here
   *   — see the `rng` parameter below.
   * @param {object} layer - the `hud` `cl2-layer` DOM node
   *   (`./style.js#LAYER_NAMES`) this module attaches every node into.
   * @param {(key:string, params?:object) => string} translate - bound to
   *   `UiSystem#t`, so this module never keeps a second copy of the i18n
   *   lookup/fallback logic `./i18n.js` already owns.
   * @param {object|null} [rng] - the ONE `ui`-subsystem RNG stream,
   *   forked once by `UiSystem.init()` and shared with `./feedback.js`
   *   (`ARCHITECTURE.md`'s Determinism contract: "One `ctx.rng.fork()`
   *   per subsystem" — the SUBSYSTEM, not each of its internal modules).
   *   This file used to fork `ctx.rng` itself here; that made `ui` hold
   *   two independent streams (this one, plus `feedback.js`'s), which
   *   silently shifted every subsystem that forks `ctx.rng` later in boot
   *   order (`items`) — confirmed live, it moved `ui_clean` by 241k px
   *   when `feedback.js` added its own second fork. `null` (the default,
   *   and what every call site in `tests/ui/hud.test.js` still gets,
   *   since none of them pass a 4th argument) is a legitimate value, not
   *   an error — see the field's own comment below.
   */
  constructor(ctx, layer, translate, rng) {
    this._layer = layer;
    this._t = translate || ((key) => key);
    this._hud = makeHudState();
    this._staged = false;
    this._debugCombatIndex = -1;

    // Gated on the active screen (see `setVisible`'s own header) — starts
    // hidden, matching `UiSystem`'s own `this._screen = null` at
    // construction (neither `null` nor `'character_create'`/`'main_menu'`/
    // `'death'` is `'game'`).
    this._visible = false;

    // NOT `ctx.rng.fork()` — see the constructor's own header. Bakes the
    // rage orb's per-band irregularity table (09 §4.1.3: "a fixed
    // per-band offset table baked at init from the ui RNG fork, never
    // re-rolled") from the SHARED stream `UiSystem.init()` hands in.
    // `null` when no stream was passed (a bare Node harness, or a test
    // that constructs `Hud` directly without one) — the offsets then
    // default to 0, which is a plausible (if perfectly regular) render,
    // never a throw.
    this._rng = rng || null;
    this._rageBandOffsets = new Float32Array(10);
    for (let i = 0; i < 10; i++) this._rageBandOffsets[i] = this._rng ? this._rng.range(0, 2.4) : 0;

    this._vw = 1920;
    this._vh = 1080;

    this._life = makeOrbState();
    this._resource = makeOrbState();
    this._rageIgnitePhase = 0;
    this._resonancePrevCount = 0;
    this._resonanceFlash = new Float32Array(RESONANCE_PIP_MAX);

    this._xpFrac = 0;
    this._xpChaseFrom = 0;

    this._buildDom();
    this._layoutStatic();
  }

  // -------------------------------------------------------------------
  // Construction — every node built exactly once (ARCHITECTURE.md rule 6/7)
  // -------------------------------------------------------------------

  _buildDom() {
    const doc = this._layer.ownerDocument || null; // real DOM elements carry this; the Node shim's don't need it (el() resolves its own document)

    // A single wrapper so `setVisible()` can hide the whole plinth/orb/XP
    // group with one `display` write instead of one per node (see that
    // method's own header for why this exists: the HUD must only render on
    // `screen === 'game'`, never `main_menu`/`character_create`/`death`).
    this._container = el('div', 'cl2-hud-container');
    setStyle(this._container, 'display', 'none');
    this._layer.appendChild(this._container);

    // Plinth plate — e1 (09 §2.4's elevation table).
    this._plate = el('div', 'cl2-hud-plate');
    setStyle(this._plate, 'position', 'absolute');
    setStyle(this._plate, 'background', 'var(--e1-fill)');
    setStyle(this._plate, 'borderTop', 'var(--edge)');
    setStyle(this._plate, 'boxShadow', 'var(--e1-shadow)');
    setStyle(this._plate, 'pointerEvents', 'auto'); // 09 §3.4 z30: "auto on the plinth only"
    this._container.appendChild(this._plate);

    // XP bar — track, fill, chase, ticks (09 §4.4 / §13.1's 4-node budget).
    this._xpTrack = el('div', 'cl2-hud-xp-track');
    setStyle(this._xpTrack, 'position', 'absolute');
    setStyle(this._xpTrack, 'background', 'var(--void)');
    setStyle(this._xpTrack, 'borderTop', '1px solid var(--hair)');
    this._container.appendChild(this._xpTrack);

    this._xpFill = el('div', 'cl2-hud-xp-fill');
    setStyle(this._xpFill, 'position', 'absolute');
    setStyle(this._xpFill, 'left', '0');
    setStyle(this._xpFill, 'top', '0');
    setStyle(this._xpFill, 'height', '100%');
    setStyle(this._xpFill, 'background', 'var(--gilt)');
    setStyle(this._xpFill, 'transformOrigin', '0 0');
    this._xpTrack.appendChild(this._xpFill);

    this._xpChase = el('div', 'cl2-hud-xp-chase');
    setStyle(this._xpChase, 'position', 'absolute');
    setStyle(this._xpChase, 'top', '0');
    setStyle(this._xpChase, 'height', '100%');
    setStyle(this._xpChase, 'background', '#f2e2a0');
    this._xpTrack.appendChild(this._xpChase);

    this._xpTicks = el('div', 'cl2-hud-xp-ticks');
    setStyle(this._xpTicks, 'position', 'absolute');
    setStyle(this._xpTicks, 'left', '0');
    setStyle(this._xpTicks, 'top', '0');
    setStyle(this._xpTicks, 'width', '100%');
    setStyle(this._xpTicks, 'height', '100%');
    setStyle(this._xpTicks, 'background', 'repeating-linear-gradient(90deg, var(--hair) 0, var(--hair) 1px, transparent 1px, transparent 10%)');
    this._xpTrack.appendChild(this._xpTicks);

    // Ledgers — level/class (left), gold/difficulty (right). 09 §4's HUD
    // table: "level / class ledger" and "gold / difficulty ledger".
    this._leftLedger = this._buildLedger('cl2-hud-ledger-left');
    this._rightLedger = this._buildLedger('cl2-hud-ledger-right');
    setStyle(this._rightLedger.primary, 'color', 'var(--gilt)'); // 09 §2.1.3: --gilt is for gold counters only

    // Orbs — 2 canvases, 2 numerals, 2 bezels, 2 hover targets (09 §13.1).
    this._life.dom = this._buildOrbDom('cl2-hud-orb-life');
    this._resource.dom = this._buildOrbDom('cl2-hud-orb-resource');

    // Resonance pips — 8 preallocated (09 §4.1.4 / §13.1).
    this._pips = new Array(RESONANCE_PIP_MAX);
    for (let i = 0; i < RESONANCE_PIP_MAX; i++) {
      const pip = el('div', 'cl2-hud-pip');
      setStyle(pip, 'position', 'absolute');
      setStyle(pip, 'width', RESONANCE_PIP_SIZE + 'px');
      setStyle(pip, 'height', RESONANCE_PIP_SIZE + 'px');
      setStyle(pip, 'borderRadius', '50%');
      setStyle(pip, 'display', 'none');
      this._container.appendChild(pip);
      this._pips[i] = pip;
    }

    void doc; // reserved for a future real-DOM-only affordance; unused today
  }

  _buildLedger(className) {
    const wrap = el('div', className);
    setStyle(wrap, 'position', 'absolute');
    setStyle(wrap, 'width', LEDGER_W + 'px');
    setStyle(wrap, 'height', LEDGER_H + 'px');
    setStyle(wrap, 'textAlign', className.indexOf('right') >= 0 ? 'right' : 'left');
    this._container.appendChild(wrap);

    const primary = el('div', 'cl2-hud-ledger-primary');
    setStyle(primary, 'fontFamily', 'var(--ff-mono)');
    setStyle(primary, 'fontSize', 'var(--t-num-l-size)');
    setStyle(primary, 'fontWeight', 'var(--t-num-l-weight)');
    setStyle(primary, 'color', 'var(--ink-1)');
    setStyle(primary, 'textShadow', 'var(--sh-o1)');
    wrap.appendChild(primary);

    const secondary = el('div', 'cl2-hud-ledger-secondary');
    setStyle(secondary, 'fontFamily', 'var(--ff-sans)');
    setStyle(secondary, 'fontSize', 'var(--t-label-size)');
    setStyle(secondary, 'fontWeight', 'var(--t-label-weight)');
    setStyle(secondary, 'letterSpacing', 'var(--t-label-tracking)');
    setStyle(secondary, 'textTransform', 'uppercase');
    setStyle(secondary, 'color', 'var(--ink-3)');
    wrap.appendChild(secondary);

    return { wrap, primary, secondary, lastPrimary: null, lastSecondary: null };
  }

  _buildOrbDom(className) {
    const canvas = el('canvas', className);
    canvas.width = ORB_SIZE;
    canvas.height = ORB_SIZE;
    setStyle(canvas, 'position', 'absolute');
    setStyle(canvas, 'width', ORB_SIZE + 'px');
    setStyle(canvas, 'height', ORB_SIZE + 'px');
    this._container.appendChild(canvas);

    const numeral = el('div', 'cl2-hud-orb-num');
    setStyle(numeral, 'position', 'absolute');
    setStyle(numeral, 'fontFamily', 'var(--ff-mono)');
    setStyle(numeral, 'fontSize', 'var(--t-num-size)');
    setStyle(numeral, 'fontWeight', 'var(--t-num-weight)');
    setStyle(numeral, 'color', 'var(--ink-1)');
    setStyle(numeral, 'textShadow', 'var(--sh-o1)');
    setStyle(numeral, 'textAlign', 'center');
    this._container.appendChild(numeral);

    const bezel = el('div', 'cl2-hud-orb-bezel');
    setStyle(bezel, 'position', 'absolute');
    setStyle(bezel, 'borderRadius', '50%');
    setStyle(bezel, 'border', '4px solid var(--ash-500)');
    setStyle(bezel, 'pointerEvents', 'none');
    this._container.appendChild(bezel);

    const hover = el('div', 'cl2-hud-orb-hover');
    setStyle(hover, 'position', 'absolute');
    setStyle(hover, 'borderRadius', '50%');
    setStyle(hover, 'pointerEvents', 'auto'); // 09 §4.1 "Hover" — the target; U5 wires the tooltip content itself
    this._container.appendChild(hover);

    const c2d = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    return { canvas, ctx2d: c2d, numeral, bezel, hover, cx: 0, cy: 0 };
  }

  // -------------------------------------------------------------------
  // Layout — computed constants (D-B), recomputed only when the viewport
  // size actually changes (there is no `resize()` hook granted to this
  // ticket on `UiSystem` — see this ticket's report — so this is read
  // lazily off `ctx.canvas` on the first `update()` and cached).
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
    const plateTop = vh - PLINTH_H;

    setStyle(this._plate, 'left', '0');
    setStyle(this._plate, 'top', plateTop + 'px');
    setStyle(this._plate, 'width', vw + 'px');
    setStyle(this._plate, 'height', PLINTH_H + 'px');

    setStyle(this._xpTrack, 'left', '0');
    setStyle(this._xpTrack, 'top', (vh - XP_H) + 'px');
    setStyle(this._xpTrack, 'width', vw + 'px');
    setStyle(this._xpTrack, 'height', XP_H + 'px');

    const ledgerY = plateTop + LEDGER_TOP_OFFSET;
    setStyle(this._leftLedger.wrap, 'left', LEDGER_INSET_X + 'px');
    setStyle(this._leftLedger.wrap, 'top', ledgerY + 'px');
    setStyle(this._rightLedger.wrap, 'left', (vw - LEDGER_INSET_X - LEDGER_W) + 'px');
    setStyle(this._rightLedger.wrap, 'top', ledgerY + 'px');

    const orbCy = vh - ORB_INSET_BOTTOM;
    this._layoutOrb(this._life, ORB_INSET_X, orbCy);
    this._layoutOrb(this._resource, vw - ORB_INSET_X, orbCy);
  }

  _layoutOrb(orb, cx, cy) {
    orb.cx = cx;
    orb.cy = cy;
    const dom = orb.dom;
    const left = cx - ORB_SIZE / 2;
    const top = cy - ORB_SIZE / 2;
    setStyle(dom.canvas, 'left', left + 'px');
    setStyle(dom.canvas, 'top', top + 'px');

    setStyle(dom.bezel, 'left', (cx - ORB_R - 2) + 'px');
    setStyle(dom.bezel, 'top', (cy - ORB_R - 2) + 'px');
    setStyle(dom.bezel, 'width', (ORB_R * 2 + 4) + 'px');
    setStyle(dom.bezel, 'height', (ORB_R * 2 + 4) + 'px');

    setStyle(dom.hover, 'left', (cx - ORB_R) + 'px');
    setStyle(dom.hover, 'top', (cy - ORB_R) + 'px');
    setStyle(dom.hover, 'width', (ORB_R * 2) + 'px');
    setStyle(dom.hover, 'height', (ORB_R * 2) + 'px');

    setStyle(dom.numeral, 'left', (cx - 60) + 'px');
    setStyle(dom.numeral, 'top', (cy - ORB_R + 34 - 8) + 'px'); // 09 §4.1: "orbCentreY + 34" of the numeral's own baseline, relative to the plate top edge here
    setStyle(dom.numeral, 'width', '120px');
  }

  // -------------------------------------------------------------------
  // Frame update — lateUpdate only (rule 5 / D-D: integrates `dt`, the
  // game clock; never the wall clock, never inside fixedUpdate).
  // -------------------------------------------------------------------

  /**
   * @param {number} dt - the scaled game-clock delta (`ctx.time.dt`, via
   *   `UiSystem#lateUpdate`).
   * @param {object} ctx
   */
  update(dt, ctx) {
    if (!this._visible) return; // 09-ui.md:2128's own gating principle, generalised: no HUD chrome over a non-game screen, and no work burned computing it either.

    this._syncViewport(ctx);

    if (!this._staged) {
      const player = ctx && typeof ctx.get === 'function' && (typeof ctx.has !== 'function' || ctx.has('player')) ? ctx.get('player') : null;
      if (player && typeof player.hudState === 'function') player.hudState(this._hud);
    }

    const hud = this._hud;
    this._updateLedgers(hud);
    this._updateXpBar(dt, hud);
    this._updateOrb(this._life, dt, hud.life, hud.maxLife, false);

    const dialect = hud.secondaryKind === 'rage' ? 'rage' : 'mana';
    if (dialect === 'rage') {
      this._updateOrb(this._resource, dt, hud.secondary, hud.maxSecondary, true);
    } else {
      this._updateOrb(this._resource, dt, hud.mana, hud.maxMana, false);
    }
    this._updateResonancePips(dt, hud);
  }

  _updateLedgers(hud) {
    const left = this._leftLedger;
    if (left.lastPrimary !== hud.level) {
      left.lastPrimary = hud.level;
      setText(left.primary, this._t('hud.levelShort') + ' ' + numStr(hud.level));
    }
    if (left.lastSecondary !== hud.classId) {
      left.lastSecondary = hud.classId;
      setText(left.secondary, this._t('class.' + hud.classId + '.name'));
    }

    const right = this._rightLedger;
    if (right.lastPrimary !== hud.gold) {
      right.lastPrimary = hud.gold;
      setText(right.primary, numStr(hud.gold));
    }
    if (right.lastSecondary !== hud.difficulty) {
      right.lastSecondary = hud.difficulty;
      setText(right.secondary, this._t('difficulty.' + hud.difficulty));
    }
  }

  _updateXpBar(dt, hud) {
    const span = hud.xpCeiling - hud.xpFloor;
    const frac = span > 0 ? clamp((hud.xp - hud.xpFloor) / span, 0, 1) : 0;

    if (frac > this._xpFrac + 0.0001) {
      this._xpChaseFrom = this._xpFrac; // 09 §4.4: chase spans from the previous fill edge
    }
    this._xpFrac = frac;
    this._xpChaseFrom = damp(this._xpChaseFrom, frac, XP_CHASE_RATE, dt);

    const q = Math.round(frac * 1000) / 1000;
    if (this._xpFillQ !== q) {
      this._xpFillQ = q;
      setStyle(this._xpFill, 'transform', 'scaleX(' + q + ')');
      setStyle(this._xpFill, 'width', this._vw + 'px');
    }

    const chaseFromQ = Math.round(this._xpChaseFrom * this._vw);
    const fracPxQ = Math.round(frac * this._vw);
    if (this._xpChaseFromPx !== chaseFromQ || this._xpChaseToPx !== fracPxQ) {
      this._xpChaseFromPx = chaseFromQ;
      this._xpChaseToPx = fracPxQ;
      setStyle(this._xpChase, 'left', Math.min(chaseFromQ, fracPxQ) + 'px');
      setStyle(this._xpChase, 'width', Math.abs(fracPxQ - chaseFromQ) + 'px');
    }
  }

  /**
   * Drives one orb's chase/ghost/wave state and, when a real `<canvas>`
   * context is available (see the Node-shim guard in `_buildOrbDom`),
   * redraws it. `stepped` selects the rage 10-band stair (09 §4.1.3)
   * instead of the liquid meniscus (09 §4.1 common construction / §2.5
   * SD-1).
   * @param {object} orb
   * @param {number} dt
   * @param {number} value
   * @param {number} max
   * @param {boolean} stepped
   */
  _updateOrb(orb, dt, value, max, stepped) {
    const trueFrac = max > 0 ? clamp(value / max, 0, 1) : 0;

    if (trueFrac < orb.trueFrac - 0.0001) {
      // A drop — hold the ghost at (at least) where we just were, then let
      // it drain (09 §4.1 / §2.6: "550 ms hold ... 0.60 of maximum per
      // second").
      if (orb.ghostFrac < orb.trueFrac) orb.ghostFrac = orb.trueFrac;
      orb.ghostHold = GHOST_HOLD_S;
    }
    orb.trueFrac = trueFrac;
    orb.shownFrac = damp(orb.shownFrac, trueFrac, ORB_CHASE_RATE, dt);
    if (orb.ghostFrac < orb.shownFrac) orb.ghostFrac = orb.shownFrac;

    if (orb.ghostHold > 0) {
      orb.ghostHold -= dt;
    } else {
      orb.ghostFrac = Math.max(orb.shownFrac, orb.ghostFrac - GHOST_DRAIN_PER_S * dt);
    }

    orb.phase1 = (orb.phase1 + dt * WAVE_RATE_1) % TWO_PI;
    orb.phase2 = (orb.phase2 + dt * WAVE_RATE_2) % TWO_PI;

    // Numeral readout — the *true* discrete value, never the animated
    // liquid (09 §4.1: "format 412 / 540"). Change-guarded so a settled
    // orb allocates nothing (rule 6 / §13.3).
    const roundedValue = Math.round(value);
    const roundedMax = Math.round(max);
    if (orb.lastValue !== roundedValue || orb.lastMax !== roundedMax) {
      orb.lastValue = roundedValue;
      orb.lastMax = roundedMax;
      setText(orb.dom.numeral, numStr(roundedValue) + ' / ' + numStr(roundedMax));
    }
    const danger = roundedMax > 0 && roundedValue / roundedMax < 0.25;
    setStyle(orb.dom.numeral, 'color', danger ? 'var(--danger-ink)' : 'var(--ink-1)');

    const lowBezel = roundedMax > 0 && roundedValue / roundedMax < 0.35 && !stepped;
    setStyle(orb.dom.bezel, 'border', lowBezel
      ? '2px solid var(--danger)'
      : '4px solid var(--ash-500)');

    if (stepped) {
      this._rageIgnitePhase = (this._rageIgnitePhase + dt * RAGE_IGNITE_RATE) % TWO_PI;
    }

    if (!orb.dom.ctx2d || dt <= 0) return; // paused / no-canvas (Node shim): nothing to redraw
    if (stepped) {
      this._drawRageOrb(orb);
    } else {
      const isMana = orb === this._resource;
      this._drawLiquidOrb(orb, isMana ? C_MANA_TOP : C_LIFE_TOP, isMana ? C_MANA_BOTTOM : C_LIFE_BOTTOM, isMana ? C_MANA_GHOST : C_LIFE_GHOST);
    }
  }

  _drawLiquidOrb(orb, topColor, bottomColor, ghostColor) {
    const g = orb.dom.ctx2d;
    const left = ORB_SIZE / 2 - ORB_R;
    const top = ORB_SIZE / 2 - ORB_R;

    g.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    g.save();
    g.beginPath();
    g.arc(ORB_SIZE / 2, ORB_SIZE / 2, ORB_R, 0, TWO_PI);
    g.closePath();
    g.clip();

    g.fillStyle = C_ASH_800;
    g.fillRect(left, top, ORB_D, ORB_D);

    const surfaceY = (x, frac) => {
      const edgeDist = Math.min(x, ORB_D - x) / ORB_D;
      const waveDamp = edgeDist < 0.04 ? edgeDist / 0.04 : 1;
      const wave = waveDamp * (WAVE_AMP_1 * Math.sin(orb.phase1 + WAVE_FREQ_1 * x / ORB_D) + WAVE_AMP_2 * Math.sin(orb.phase2 + WAVE_FREQ_2 * x / ORB_D));
      return (1 - frac) * ORB_D + wave;
    };

    const fillPath = (frac, style) => {
      g.beginPath();
      g.moveTo(left, top + ORB_D);
      for (let i = 0; i <= 24; i++) {
        const x = (i / 24) * ORB_D;
        g.lineTo(left + x, top + surfaceY(x, frac));
      }
      g.lineTo(left + ORB_D, top + ORB_D);
      g.closePath();
      g.fillStyle = style;
      g.fill();
    };

    if (orb.ghostFrac > orb.shownFrac + 0.001) fillPath(orb.ghostFrac, ghostColor);

    const grad = g.createLinearGradient(0, top, 0, top + ORB_D);
    grad.addColorStop(0, topColor);
    grad.addColorStop(1, bottomColor);
    fillPath(orb.shownFrac, grad);

    g.restore();

    // Tick marks at 25/50/75% (09 §4.1 step 6).
    g.strokeStyle = 'rgba(239,231,216,0.22)';
    g.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = top + ORB_D * (1 - i * 0.25);
      g.beginPath();
      g.moveTo(left + ORB_D / 2 - 8, y);
      g.lineTo(left + ORB_D / 2 + 8, y);
      g.stroke();
    }
  }

  _drawRageOrb(orb) {
    const g = orb.dom.ctx2d;
    const left = ORB_SIZE / 2 - ORB_R;
    const top = ORB_SIZE / 2 - ORB_R;

    g.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    g.save();
    g.beginPath();
    g.arc(ORB_SIZE / 2, ORB_SIZE / 2, ORB_R, 0, TWO_PI);
    g.closePath();
    g.clip();

    g.fillStyle = C_ASH_800;
    g.fillRect(left, top, ORB_D, ORB_D);

    const bandH = ORB_D / 10;
    const filledBands = orb.shownFrac * 10;
    for (let b = 0; b < 10; b++) {
      const bandFrac = clamp(filledBands - b, 0, 1);
      if (bandFrac <= 0) continue;
      const y = top + ORB_D - (b + 1) * bandH;
      const offset = this._rageBandOffsets[b];
      const w = Math.max(0, ORB_D * bandFrac - offset);
      g.fillStyle = (b % 2 === 0) ? C_RAGE_TOP : C_RAGE_BOTTOM;
      g.fillRect(left + offset, y + 0.5, w, bandH - 1);
    }
    g.restore();

    if (orb.shownFrac >= 0.999) {
      const alpha = 0.55 + 0.25 * Math.sin(this._rageIgnitePhase);
      g.beginPath();
      g.arc(ORB_SIZE / 2, ORB_SIZE / 2, ORB_R + 2, 0, TWO_PI);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(224,98,42,' + alpha.toFixed(3) + ')';
      g.stroke();
    }
  }

  /**
   * 09 §4.1.4 — visible only for the Runeblade dialect (`secondaryKind ===
   * 'resonance'`); the ravager/emberwright dialects leave every pip
   * `display:none`. `secondary` is an int 0..`maxSecondary` (contract
   * default 8) charges.
   */
  _updateResonancePips(dt, hud) {
    const active = hud.secondaryKind === 'resonance';
    const count = active ? clamp(Math.round(hud.secondary), 0, RESONANCE_PIP_MAX) : 0;
    const total = active ? clamp(Math.round(hud.maxSecondary) || 5, 1, RESONANCE_PIP_MAX) : 0;

    if (count < this._resonancePrevCount) {
      for (let i = count; i < this._resonancePrevCount; i++) this._resonanceFlash[i] = RESONANCE_FLASH_S;
    }
    this._resonancePrevCount = count;

    const orbCx = this._resource.cx;
    const orbCy = this._resource.cy;
    const pitch = total > 1 ? RESONANCE_ARC_SPAN / (total - 1) : 0;

    for (let i = 0; i < RESONANCE_PIP_MAX; i++) {
      const pip = this._pips[i];
      if (i >= total) {
        setStyle(pip, 'display', 'none');
        continue;
      }
      setStyle(pip, 'display', 'block');
      const angleDeg = RESONANCE_ARC_START + pitch * i;
      const angle = (angleDeg * Math.PI) / 180;
      const x = orbCx + Math.cos(angle) * RESONANCE_ARC_R - RESONANCE_PIP_SIZE / 2;
      const y = orbCy + Math.sin(angle) * RESONANCE_ARC_R - RESONANCE_PIP_SIZE / 2;
      setStyle(pip, 'left', x.toFixed(1) + 'px');
      setStyle(pip, 'top', y.toFixed(1) + 'px');

      if (this._resonanceFlash[i] > 0) {
        this._resonanceFlash[i] -= dt;
        setStyle(pip, 'background', '#ffffff');
        setStyle(pip, 'border', '2px solid #ffffff');
      } else if (i < count) {
        setStyle(pip, 'background', C_RESONANCE);
        setStyle(pip, 'border', '2px solid rgba(127,216,232,0.6)');
      } else {
        setStyle(pip, 'background', C_ASH_700);
        setStyle(pip, 'border', '1px solid ' + C_ASH_500);
      }
    }
  }

  // -------------------------------------------------------------------
  // Debug staging — `ui.debugState('combat')` (09 §15 U1's acceptance row)
  // -------------------------------------------------------------------

  /**
   * Stages a synthetic `HudState` — life 412/540 plus, cycling one class
   * per call, each of the three resource dialects (09 §4.1: rage, mana,
   * resonance) — and switches `update()` off `player.hudState()` polling
   * for as long as staging is active. This is a deliberate, documented
   * exception to D-A: `09 §15`'s U1 acceptance row itself says
   * `debugState('combat')` "stages its numbers deliberately rather than
   * reading live progression", the same dev-only carve-out `09 §15` U4
   * grants `ai.debugStage('champion'|'boss')`. It is never reachable from
   * `fixedUpdate` or from any real gameplay path — only from
   * `UiSystem#debugState`, itself dev/test tooling
   * (`02-api-contracts.md` §14).
   *
   * Each call advances to the next of the three presets
   * (`DEBUG_COMBAT_PRESETS`), so three consecutive calls demonstrate all
   * three dialects — see this ticket's report for why a single no-argument
   * call cannot show all three at once (the HUD has exactly one resource
   * orb; `09`'s own screen map draws one class at a time).
   */
  debugState(mode) {
    if (mode !== 'combat') return;
    this._debugCombatIndex = (this._debugCombatIndex + 1) % DEBUG_COMBAT_PRESETS.length;
    const preset = DEBUG_COMBAT_PRESETS[this._debugCombatIndex];
    const hud = this._hud;
    hud.classId = preset.classId;
    hud.level = preset.level;
    hud.gold = preset.gold;
    hud.difficulty = preset.difficulty;
    hud.life = preset.life;
    hud.maxLife = preset.maxLife;
    hud.mana = preset.mana;
    hud.maxMana = preset.maxMana;
    hud.secondaryKind = preset.secondaryKind;
    hud.secondary = preset.secondary;
    hud.maxSecondary = preset.maxSecondary;
    hud.secondaryDecay = 0; // O-64 — never faked, even while staged
    hud.xp = 1200;
    hud.xpFloor = 1000;
    hud.xpCeiling = 1500;
    this._staged = true;
    this.setVisible(true); // dev/test tooling asking to see the combat HUD is itself the intent to show it, regardless of UiSystem's own screen state
  }

  /**
   * Gates the whole plinth/orb/XP-bar group on the active screen — `09
   * §10.4` states the same principle for the vignette ("suppressed
   * entirely while the death screen or the main menu is up") and this
   * ticket generalises it to the HUD itself: it must draw, and spend
   * per-frame work, only on `screen === 'game'`. Toggling one wrapper's
   * `display` (built in `_buildDom`) hides/shows every node in one write;
   * `update()` early-returns while hidden so no poll, no `dt` integration
   * and no canvas redraw happen either. Called from `UiSystem#setScreen`.
   * @param {boolean} visible
   */
  setVisible(visible) {
    const next = !!visible;
    if (this._visible === next) return;
    this._visible = next;
    setStyle(this._container, 'display', next ? 'block' : 'none');
  }

  /** Dev-only inspection for `tests/ui/hud.test.js` — mirrors
   * `UiSystem#__nodeCount`'s double-underscore, non-contract convention
   * (rule 7 / `02-api-contracts.md` is the only source of public API). */
  __orbDebug(which) {
    const orb = which === 'resource' ? this._resource : this._life;
    return { trueFrac: orb.trueFrac, shownFrac: orb.shownFrac, ghostFrac: orb.ghostFrac, ghostHold: orb.ghostHold };
  }

  /** @returns {object} the live `HudState` this module last polled/staged —
   * read-only inspection, not part of the public contract. */
  __hudState() {
    return this._hud;
  }

  // -------------------------------------------------------------------

  /** Removes every node this module created (ARCHITECTURE.md rule 7). Every
   * node built in `_buildDom` lives under `this._container`, so removing
   * that one wrapper from the `hud` layer takes the whole subtree with it. */
  dispose() {
    if (this._container && this._container.remove) this._container.remove();
    this._container = null;
  }
}
