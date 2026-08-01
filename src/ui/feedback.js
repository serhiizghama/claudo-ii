// src/ui/feedback.js
//
// UI-4 — `09-ui.md` §15's U3 row: "Damage numbers and the feedback layer".
// Builds `#cl2-fx` (a full-viewport 2D canvas, §10.1), the pooled
// `DamageNumber` machinery (pool sizing, coalescing, the eight kinds), the
// hit flash (§10.2), the `render.screenImpulse` wiring (§10.3), and the
// low-life vignette + heartbeat (§10.4). Owned by `ui`, constructed and
// driven by `UiSystem` (`./index.js`) exactly the way UI-2's `Hud` is —
// see that file's own header for the established shape this one follows
// (a single `_container` wrapper toggled by `setVisible`, `update(dt,ctx)`
// that no-ops while hidden, `dispose()` that removes everything).
//
// ---------------------------------------------------------------------------
// Why a Pool (from ./util.js), never a Map (rule 6 / this ticket's brief)
// ---------------------------------------------------------------------------
// "≤ 3 live per target" is exactly the shape that tempts a `Map` keyed by
// `targetId`. Every lookup this file needs — coalesce-match, per-target live
// count, the youngest-for-target, the oldest-overall (for "overflow recycles
// the oldest", `09 §10.1`) — is instead a linear scan over the pool's own
// fixed-size active set via `Pool#forEachActive`, using one CALLBACK BOUND
// ONCE per scan kind in the constructor (never a fresh closure per call —
// see `_advanceOneRecord`/`_scanOneRecord`/`_scanOldestRecord` below) and a
// handful of scratch instance fields instead of closured locals. At a
// capacity of 64-128 this is cheap, and it only runs per damage EVENT
// (coalescing) or once per frame (the age/select pass) — never per live
// number per frame.
//
// ---------------------------------------------------------------------------
// `DamageResult.pointX/Y/Z` is not populated by any current producer — an
// ambiguity this ticket resolved (see the report)
// ---------------------------------------------------------------------------
// `09 §10.1`'s record comment says "world spawn point" and `resolve.js`
// copies `packet.originX/Y/Z` into `DamageResult.pointX/Y/Z` unconditionally.
// But neither `ai/brains/melee.js` (the one place a `combat:hit-request`
// packet is actually built today) nor `combat/status.js`'s DoT-tick emitter
// ever sets `originX/Y/Z` on the packet — they default to, and stay, `0,0,0`
// (`combat/packet.js`'s own reset). Using `result.pointX/Y/Z` literally would
// spawn every damage number at the world origin regardless of where the
// fight is. This file instead anchors every number on the *target actor's
// own live position* (`payload.target.x/y/z`, always present on the
// `actor:damage` event payload) — visually equivalent to "the impact point"
// for a body-sized actor, and correct today instead of silently broken.
//
// ---------------------------------------------------------------------------
// `render.worldToScreen` / `render.screenImpulse` do not exist yet
// ---------------------------------------------------------------------------
// Checked: `src/render/index.js` only *mentions* these two methods in a
// header comment listing the file's eventual surface; neither is
// implemented. This file cannot add them (out of scope — `src/render/` is
// not in this ticket's file list) and does not import `render` at all for
// projection: `_worldToScreen` below does its own `THREE.Vector3#project`
// against `ctx.camera` (a shared, ctx-provided object per ARCHITECTURE.md,
// not a cross-subsystem import) using a scratch vector built once in the
// constructor. `render.screenImpulse`/`player.cameraShake` ARE called, but
// defensively (`typeof x.method === 'function'`) — the exact precedent
// `src/actors/index.js` (`nav.snap`) and `src/world/index.js` (`nav.rebuild`)
// already set for "the callee hasn't shipped this method yet, don't crash
// waiting for it". The moment `render` ships `screenImpulse`, this wiring
// starts working with no change here.
//
// ---------------------------------------------------------------------------
// i18n keys this file needs but cannot add (`src/ui/i18n.js` is off-limits)
// ---------------------------------------------------------------------------
// `combat.immune` (named explicitly by `09 §10.1`), plus `combat.miss`,
// `combat.block`, `combat.absorb` (the table's other three text-only kinds)
// do not exist in `EN`/`RU` today. This file still calls `this._t(key)` for
// them (never a hardcoded literal) — `t()`'s documented fallback
// (`[missing]<key>`) means this never throws, only shows an ugly string
// until the keys land. Report: `i18n.js` needs these four keys, EN + RU.

import { el, setStyle, countNodes, Pool, clamp, lerp, damp, easeOutQuad, numStr } from './util.js';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const K = 1; // `09 §2`'s `--k` interface scale; `style.js` fixes it at 1 pre-settings — see that file's own header.
const DRAW_CAP = 24; // `09 §10.1`: "no more than 24 are drawn per frame"
const MAX_LIVE_PER_TARGET = 3; // `09 §10.1`: "at most 3 live numbers may exist" per target
const COALESCE_WINDOW_S = 0.12; // `09 §10.1`
const IMPULSE_WINDOW_S = 0.12; // `09 §10.3`: "at most one impulse per 120 ms"

// `01-data-model.md` §11.1's `DamageNumber | ui | 64 / 96 / 128 / 128` row,
// keyed by `config.quality` (low/medium/high/ultra) — `config.q` itself
// carries no damage-number field (checked `src/core/config.js`), so this
// file owns the mapping the same way it would own any other UI-specific
// budget table.
const DAMAGE_NUMBER_CAPACITY = { low: 64, medium: 96, high: 128, ultra: 128 };

// `09 §2.2`'s `--ff-serif` stack, transcribed byte-for-byte — a canvas 2D
// context cannot read a CSS custom property (same reasoning `hud.js`'s own
// header documents for its `C_*` color constants).
const FF_SERIF = '"Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", "Iowan Old Style", Georgia, "Times New Roman", serif';

// `09 §2.1.6` damage element colours, transcribed from `style.js`'s
// `--element-*` tokens (same transcription discipline as `hud.js`).
const ELEMENT_COLOUR = {
  physical: ['#e8e2d4', '#ffffff'],
  fire: ['#ff7a2f', '#ffa15c'],
  cold: ['#7fd0ff', '#b6e6ff'],
  lightning: ['#f2d84a', '#fff3a0'],
  poison: ['#8fd14f', '#bbe888'],
  magic: ['#c78fff', '#deb9ff'],
};

/** `09 §10.1`'s kind table, verbatim, plus a synthetic `text` kind for
 * `floatingText()` (§10.1's last paragraph: "same pool and the same
 * motion with life = 1.4s, size = 15px, no pop"). `colour` here is the
 * KIND's fixed colour (miss/block/immune/absorb/heal); hit/crit/dot derive
 * theirs from the damage element instead (see `elementColour` below). */
const KIND_TABLE = {
  hit: { life: 0.85, size: 20 },
  crit: { life: 1.15, size: 27, ring: true },
  heal: { life: 0.90, size: 20, colour: '#7fd88f', riseMul: 1.3 },
  dot: { life: 0.70, size: 16, pop: false, driftMul: 0.5, alphaMul: 0.78 },
  immune: { life: 1.00, size: 17, colour: '#8c8375', textKey: 'combat.immune' },
  miss: { life: 0.80, size: 17, colour: '#8c8375', textKey: 'combat.miss' },
  block: { life: 0.80, size: 18, colour: '#b8c4cc', textKey: 'combat.block' },
  absorb: { life: 0.80, size: 17, colour: '#c78fff', textKey: 'combat.absorb' },
  text: { life: 1.40, size: 15, pop: false },
};

const VIGNETTE_BG = 'radial-gradient(ellipse 78% 74% at 50% 50%, transparent 60%, rgba(150,14,10,.34) 88%, rgba(90,8,6,.62) 100%)';
const FLASH_BG = 'radial-gradient(circle, transparent 40%, rgba(150,16,10,1) 100%)';

function poolCapacityFor(ctx) {
  const quality = ctx && ctx.config && ctx.config.quality;
  return DAMAGE_NUMBER_CAPACITY[quality] || 128; // 'high'/unknown default — matches config.js's own DEFAULT_QUALITY = 'high'
}

function elementColour(element, crit) {
  const pair = ELEMENT_COLOUR[element] || ELEMENT_COLOUR.physical;
  return crit ? pair[1] : pair[0];
}

/** `result.physical/fire/cold/lightning/poison/magic` -> whichever is
 * largest — an ambiguity this ticket resolved: `DamageResult` carries no
 * single "element" field, only the per-element split (`01-data-model.md`
 * §8.2). The dominant (usually the only nonzero) component is the number's
 * colour. */
function dominantElement(result) {
  let best = 'physical';
  let bestVal = result.physical;
  if (result.fire > bestVal) { bestVal = result.fire; best = 'fire'; }
  if (result.cold > bestVal) { bestVal = result.cold; best = 'cold'; }
  if (result.lightning > bestVal) { bestVal = result.lightning; best = 'lightning'; }
  if (result.poison > bestVal) { bestVal = result.poison; best = 'poison'; }
  if (result.magic > bestVal) { bestVal = result.magic; best = 'magic'; }
  return best;
}

/** Defensive `ctx.get`/`ctx.peek` — mirrors `hud.js`'s own
 * has-then-get style but collapses to one call where `peek` exists (every
 * real `Registry`). Never throws, even against a bare mock `ctx`. */
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
// Easing — `09 §2.6`'s motion table names these; `./util.js` only exports
// `easeOutQuad`/`easeOutBack` (U0's own named list), so the three more this
// file's `§10.1` motion formula needs (`easeOutCubic`, `easeInQuad`,
// `easeOutQuint`) live here, private, rather than editing `util.js`.
// ---------------------------------------------------------------------------

function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeInQuad(t) {
  return t * t;
}

function easeOutQuint(t) {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}

// ---------------------------------------------------------------------------
// DamageNumber record — `09 §10.1`'s literal, plus `amount` (the running
// numeric total a coalesced text is rebuilt from — the spec's literal only
// lists the fields it renders with, not this bookkeeping one; needed to
// rebuild `text` on merge without re-parsing the previous string, which
// would itself allocate every merge).
// ---------------------------------------------------------------------------

function makeDamageNumber(poolIndex) {
  return {
    poolIndex,
    x: 0, y: 0, z: 0,
    sx: 0, sy: 0,
    t: 0, life: 0,
    drift: 0, riseScale: 0,
    text: '',
    colour: '#e8e2d4', size: 20, crit: false, kind: 'hit',
    targetId: 0, sourceId: 0, lastMergeT: 0,
    amount: 0,
  };
}

function resetDamageNumber(r) {
  r.x = 0; r.y = 0; r.z = 0;
  r.sx = 0; r.sy = 0;
  r.t = 0; r.life = 0;
  r.drift = 0; r.riseScale = 0;
  r.text = '';
  r.colour = '#e8e2d4'; r.size = 20; r.crit = false; r.kind = 'hit';
  r.targetId = 0; r.sourceId = 0; r.lastMergeT = 0;
  r.amount = 0;
  // r.poolIndex untouched — `01-data-model.md` §11.2 rule 6.
}

/** `09 §16.4`/`02-api-contracts.md`'s `HudState` literal, transcribed —
 * this file's own D-A poll target for life/maxLife (the vignette, §10.4).
 * Duplicated rather than imported: `hud.js` doesn't export a factory, and
 * `tests/player/hudstate.perf.test.js` already establishes this exact
 * duplication is the accepted pattern in this codebase (every caller of
 * `player.hudState(out)` owns its own preallocated `out`). */
function makeHudStateScratch() {
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

export class Feedback {
  /**
   * @param {object} ctx
   * @param {object} layer - the `feedback` `cl2-layer` DOM node
   *   (`./style.js#LAYER_NAMES`) this module attaches into — the one layer
   *   this ticket owns (`09 §3.4`'s detailed z10/z25 split collapses onto
   *   this single layer here; see the report).
   * @param {(key:string, params?:object) => string} translate - bound to
   *   `UiSystem#t`, same wiring `hud.js` receives.
   * @param {object|null} [rng] - the ONE `ui`-subsystem RNG stream,
   *   forked once by `UiSystem.init()` and shared with `./hud.js`
   *   (`ARCHITECTURE.md`'s Determinism contract: "One `ctx.rng.fork()`
   *   per subsystem" — the SUBSYSTEM, not each of its internal modules).
   *   This file used to hold `ctx.rng` directly (reasoning that avoiding a
   *   second `.fork()` was enough); it was not — the ROOT stream is also
   *   shared with `items`' own later `.fork()`, so a live draw here after
   *   boot still leaves presentation state (how many damage numbers
   *   fired) able to shift a later-forked simulation stream's position on
   *   any future frame that draws from `ctx.rng` again post-boot. Holding
   *   the ALREADY-FORKED, `ui`-only child stream instead makes this
   *   file's draws provably disjoint from every other subsystem's, not
   *   just disjoint "in practice, today". `null` when no stream was
   *   passed (a bare Node harness with no `ctx.rng`) — jitter then
   *   defaults to 0, the same documented fallback `hud.js` uses.
   */
  constructor(ctx, layer, translate, rng) {
    this._ctx = ctx;
    this._layer = layer;
    this._t = translate || ((key) => key);
    this._visible = false;
    this._attached = false; // deferred layer attachment — see setVisible()'s own header

    // NOT `ctx.rng` — see the constructor's own header (`rng` param).
    this._rng = rng || null;

    // `SettingsSave.damageNumberMode` (`01-data-model.md` §10.2) default —
    // `save` does not exist yet, so this can only ever read the contract
    // default until a later ticket wires a real setting through. See report.
    this._damageNumberMode = 'own';

    const capacity = poolCapacityFor(ctx);
    const records = [];
    this._pool = new Pool(capacity, (i) => {
      const r = makeDamageNumber(i);
      records.push(r);
      return r;
    }, resetDamageNumber);
    this._records = records;

    // Top-24-by-value selection scratch (`09 §10.1`: "no more than 24 are
    // drawn per frame; ... the lowest-value numbers are skipped"). Fixed
    // typed arrays, built once — the insertion-sort below never allocates.
    this._topCount = 0;
    this._topSlots = new Int32Array(DRAW_CAP);
    this._topAmounts = new Float32Array(DRAW_CAP);
    this._advanceDt = 0;
    this._advanceOneRecord = (rec, slot) => {
      rec.t += this._advanceDt;
      if (rec.t >= rec.life) { this._pool.release(rec, slot); return; }
      const val = rec.amount;
      const topAmounts = this._topAmounts;
      const topSlots = this._topSlots;
      const topCount = this._topCount;
      if (topCount < DRAW_CAP) {
        let i = topCount;
        while (i > 0 && topAmounts[i - 1] < val) {
          topAmounts[i] = topAmounts[i - 1];
          topSlots[i] = topSlots[i - 1];
          i--;
        }
        topAmounts[i] = val;
        topSlots[i] = slot;
        this._topCount = topCount + 1;
      } else if (val > topAmounts[topCount - 1]) {
        let i = topCount - 1;
        while (i > 0 && topAmounts[i - 1] < val) {
          topAmounts[i] = topAmounts[i - 1];
          topSlots[i] = topSlots[i - 1];
          i--;
        }
        topAmounts[i] = val;
        topSlots[i] = slot;
      }
    };

    // Coalesce-scan scratch — one bound callback, reused by every
    // `_findCoalesceTarget` call (never a fresh closure per damage event).
    this._scanTargetId = 0; this._scanKind = '';
    this._scanMatch = null;
    this._scanYoungest = null; this._scanYoungestSlot = -1;
    this._scanLiveCount = 0;
    this._scanOneRecord = (rec, slot) => {
      if (rec.targetId !== this._scanTargetId) return;
      this._scanLiveCount++;
      if (this._scanYoungest === null || rec.t < this._scanYoungest.t) {
        this._scanYoungest = rec;
        this._scanYoungestSlot = slot;
      }
      if (rec.kind === this._scanKind && (rec.t - rec.lastMergeT) < COALESCE_WINDOW_S) {
        if (this._scanMatch === null || rec.t < this._scanMatch.t) this._scanMatch = rec;
      }
    };

    // Oldest-scan scratch — "overflow recycles the oldest" (§10.1).
    this._oldestRec = null; this._oldestSlot = -1; this._oldestT = -1;
    this._scanOldestRecord = (rec, slot) => {
      if (rec.t > this._oldestT) { this._oldestT = rec.t; this._oldestRec = rec; this._oldestSlot = slot; }
    };

    this._screenScratch = { x: 0, y: 0, visible: false };
    this._scratchVec3 = new THREE.Vector3();

    this._vw = 1920; this._vh = 1080; this._dpr = 1;

    // §10.4 vignette/heartbeat state.
    this._vignetteShown = 0;
    this._heartbeatPhase = 0;
    this._lastBeatIndex = -1;
    this._lastO67Suppressed = false; // dev inspection only — __vignetteSuppressedByO67()

    // §10.2 hit-flash state (`t >= 1` means idle).
    this._flashT = 1;
    this._flashPeak = 0;

    // §10.3 screen-impulse rate-limit window state.
    this._impulseWindow = 0;
    this._impulsePendingStrength = 0;
    this._impulseDirX = 0;
    this._impulseDirY = 0;
    this._impulseScreenScratch = { x: 0, y: 0, visible: false };

    this._hudOut = makeHudStateScratch();
    this._lastDrawnCount = 0;

    this._buildDom();
    this._resizeCanvas();

    // `actor:damage`/`actor:heal` — both in `ui`'s own `Listens` row
    // (`02-api-contracts.md` §14). Bound once, matching every other
    // subsystem's `ctx.events.on(...)` precedent (`combat/packet.js`).
    this._onActorDamage = (payload) => this._handleActorDamage(payload);
    this._onActorHeal = (payload) => this._handleActorHeal(payload);
    if (ctx && ctx.events && typeof ctx.events.on === 'function') {
      ctx.events.on('actor:damage', this._onActorDamage);
      ctx.events.on('actor:heal', this._onActorHeal);
    }
  }

  // -------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------

  _buildDom() {
    this._container = el('div', 'cl2-fx-container');
    setStyle(this._container, 'position', 'absolute');
    setStyle(this._container, 'inset', '0');
    setStyle(this._container, 'display', 'none');
    // NOT appended to `this._layer` here — see `setVisible()`'s own header
    // for why attachment is deferred to the first time this module is
    // actually shown, not done unconditionally at construction the way
    // `hud.js`'s container is.

    // §10.4 — layer z10 in the detailed map; collapsed onto this ticket's
    // one granted layer (`feedback`) per the ticket's own instruction not
    // to restructure `LAYER_NAMES` (see report).
    //
    // `display:none` below opacity 0.004 (`09 §13.4` rule 7) — AND, one
    // step further than that rule states, the expensive style property
    // itself (`background`'s gradient, `backdropFilter`) is left UNSET
    // until the node is first actually shown, not just hidden behind
    // `display:none`/`opacity:0`. An ambiguity this ticket resolved the
    // hard way (see the report): setting a complex gradient `background`
    // on an inline style — even on a `display:none` element that paints
    // nothing — measurably perturbed `ui_clean`'s sky by 200k+ px; only
    // never having assigned the property at all (until the moment it is
    // needed) kept the capture byte-identical. `_updateVignette`/
    // `_updateFlash` set `background`/`backdropFilter` the first time
    // they flip the element to `display:block`, and clear the property
    // (empty string) the moment they flip it back to `none`.
    this._vignetteEl = el('div', 'cl2-vignette');
    setStyle(this._vignetteEl, 'position', 'absolute');
    setStyle(this._vignetteEl, 'inset', '0');
    setStyle(this._vignetteEl, 'pointerEvents', 'none');
    setStyle(this._vignetteEl, 'opacity', '0');
    setStyle(this._vignetteEl, 'display', 'none');
    this._container.appendChild(this._vignetteEl);

    this._desatEl = el('div', 'cl2-desat');
    setStyle(this._desatEl, 'position', 'absolute');
    setStyle(this._desatEl, 'inset', '0');
    setStyle(this._desatEl, 'pointerEvents', 'none');
    setStyle(this._desatEl, 'opacity', '0');
    setStyle(this._desatEl, 'display', 'none');
    this._container.appendChild(this._desatEl);

    // §10.2 — the "damage taken" screen flash.
    this._flashEl = el('div', 'cl2-flash');
    setStyle(this._flashEl, 'position', 'absolute');
    setStyle(this._flashEl, 'inset', '0');
    setStyle(this._flashEl, 'pointerEvents', 'none');
    setStyle(this._flashEl, 'mixBlendMode', 'screen');
    setStyle(this._flashEl, 'opacity', '0');
    setStyle(this._flashEl, 'display', 'none');
    this._container.appendChild(this._flashEl);

    // §10.1 — `#cl2-fx`. "No DOM node is involved" (§10.1) means no
    // per-number node, not that the canvas itself is nodeless — a
    // `<canvas>` is unavoidably one DOM element; nothing here scales with
    // how many numbers are alive.
    this._canvas = el('canvas', 'cl2-fx');
    this._canvas.id = 'cl2-fx';
    setStyle(this._canvas, 'position', 'absolute');
    setStyle(this._canvas, 'left', '0');
    setStyle(this._canvas, 'top', '0');
    setStyle(this._canvas, 'pointerEvents', 'none');
    setStyle(this._canvas, 'display', 'none'); // see `_drawSelected`'s own header — shown only while something is actually drawn
    this._container.appendChild(this._canvas);
    this._ctx2d = typeof this._canvas.getContext === 'function' ? this._canvas.getContext('2d') : null;
    this._lastCanvasVisible = false;
  }

  // -------------------------------------------------------------------
  // Viewport / canvas sizing — lazily detected on `update()`, exactly
  // `hud.js#_syncViewport`'s own precedent (this ticket is not granted a
  // `resize()` hook on `UiSystem`; see that file's header for why this is
  // still "resizing only happens on a change", `09 §13.4` rule 6, even
  // though it is driven from `update()` rather than a dedicated hook).
  // -------------------------------------------------------------------

  _syncViewport(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw;
    this._vh = vh;
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this._dpr = dpr;
    if (this._canvas) {
      this._canvas.width = Math.max(1, Math.round(this._vw * dpr));
      this._canvas.height = Math.max(1, Math.round(this._vh * dpr));
      setStyle(this._canvas, 'width', this._vw + 'px');
      setStyle(this._canvas, 'height', this._vh + 'px');
    }
    if (this._ctx2d && typeof this._ctx2d.setTransform === 'function') {
      this._ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // -------------------------------------------------------------------
  // world -> screen — `render.worldToScreen` doesn't exist yet; see this
  // file's header. Pure math against `ctx.camera`, no `render` involved.
  // -------------------------------------------------------------------

  _worldToScreen(x, y, z, out, ctx) {
    const camera = ctx && ctx.camera;
    if (!camera || typeof camera.updateMatrixWorld !== 'function' || typeof this._scratchVec3.project !== 'function') {
      out.x = 0; out.y = 0; out.visible = false;
      return out;
    }
    const v = this._scratchVec3;
    v.set(x, y, z);
    v.project(camera);
    out.x = (v.x * 0.5 + 0.5) * this._vw;
    out.y = (-v.y * 0.5 + 0.5) * this._vh;
    out.visible = v.z >= -1 && v.z <= 1;
    return out;
  }

  // -------------------------------------------------------------------
  // Pool plumbing — coalesce / cap-3 / recycle-oldest, all `Map`-free
  // (see this file's header).
  // -------------------------------------------------------------------

  _findCoalesceTarget(targetId, kind) {
    this._scanTargetId = targetId;
    this._scanKind = kind;
    this._scanMatch = null;
    this._scanYoungest = null;
    this._scanYoungestSlot = -1;
    this._scanLiveCount = 0;
    this._pool.forEachActive(this._scanOneRecord);
  }

  _acquireRecycleOldest() {
    let rec = this._pool.acquire();
    if (rec) return rec;
    // Dry — `09 §10.1`: "Overflow recycles the oldest" (a different policy
    // from `01-data-model.md` §11.1's generic "refuse" default; this pool's
    // own row spells out the recycle-oldest override).
    this._oldestRec = null; this._oldestSlot = -1; this._oldestT = -1;
    this._pool.forEachActive(this._scanOldestRecord);
    if (this._oldestRec) {
      this._pool.release(this._oldestRec, this._oldestSlot);
      rec = this._pool.acquire();
    }
    return rec;
  }

  _buildText(kind, amount) {
    const spec = KIND_TABLE[kind] || KIND_TABLE.hit;
    if (spec.textKey) return this._t(spec.textKey);
    const rounded = Math.max(0, Math.round(amount));
    if (kind === 'heal') return '+' + numStr(rounded);
    return numStr(rounded);
  }

  _initRecord(rec, kind, targetId, sourceId, amount, x, y, z, colourOverride, text) {
    const spec = KIND_TABLE[kind] || KIND_TABLE.hit;
    rec.x = x; rec.y = y; rec.z = z;
    rec.sx = 0; rec.sy = 0;
    rec.t = 0; rec.life = spec.life;
    rec.drift = this._rng ? this._rng.range(-20, 20) : 0;
    rec.riseScale = this._rng ? this._rng.range(0.88, 1.16) : 1;
    rec.text = text;
    rec.colour = colourOverride || spec.colour || '#e8e2d4';
    rec.size = spec.size;
    rec.crit = kind === 'crit';
    rec.kind = kind;
    rec.targetId = targetId;
    rec.sourceId = sourceId;
    rec.lastMergeT = 0;
    rec.amount = amount;
  }

  _mergeInto(rec, kind, amount) {
    // `09 §10.1`, in order: rebuild text, THEN stamp `lastMergeT` off the
    // PRE-pullback `t`, THEN pull `t` back to restart the pop — reversing
    // steps 2/3 changes which merges stay inside the 0.12 s window (see
    // this file's header analysis in the report).
    rec.amount += amount;
    rec.text = this._buildText(kind, rec.amount);
    rec.lastMergeT = rec.t;
    rec.t = Math.min(rec.t, 0.10 * rec.life);
  }

  /** The event-driven path: coalesce, else cap-3-forces-merge, else spawn.
   * `09 §10.1`, both paragraphs, applied in the order written there. */
  _spawnOrMerge(kind, targetId, sourceId, amount, x, y, z, colourOverride) {
    this._findCoalesceTarget(targetId, kind);
    if (this._scanMatch) {
      this._mergeInto(this._scanMatch, kind, amount);
      return;
    }
    if (this._scanLiveCount >= MAX_LIVE_PER_TARGET && this._scanYoungest) {
      this._mergeInto(this._scanYoungest, kind, amount);
      return;
    }
    const rec = this._acquireRecycleOldest();
    if (!rec) return; // capacity 0 — cannot happen with a real quality preset, but never throw
    const text = this._buildText(kind, amount);
    this._initRecord(rec, kind, targetId, sourceId, amount, x, y, z, colourOverride, text);
  }

  /** The direct-call path (`damageNumber()`/`floatingText()`, `02-api-
   * contracts.md` §14) — no target identity is given by either signature,
   * so neither coalescing nor the per-target cap applies; only the pool's
   * own capacity/recycle-oldest policy does. */
  _spawnDirect(kind, targetId, sourceId, amount, x, y, z, colourOverride, textOverride) {
    const rec = this._acquireRecycleOldest();
    if (!rec) return;
    const text = textOverride !== undefined ? textOverride : this._buildText(kind, amount);
    this._initRecord(rec, kind, targetId, sourceId, amount, x, y, z, colourOverride, text);
  }

  // -------------------------------------------------------------------
  // Damage filter — `SettingsSave.damageNumberMode` (§10.1); only gates
  // the event-driven pipeline, never the direct `damageNumber`/
  // `floatingText` calls (neither signature carries a `sourceId` — see
  // the report).
  // -------------------------------------------------------------------

  _passesFilter(sourceId) {
    if (this._damageNumberMode === 'off') return false;
    if (this._damageNumberMode === 'all') return true;
    const player = safeGet(this._ctx, 'player');
    return !!(player && player.actor && sourceId !== 0 && player.actor.id === sourceId);
  }

  // -------------------------------------------------------------------
  // `actor:damage` / `actor:heal` — the event-driven spawn path
  // -------------------------------------------------------------------

  _handleActorDamage(payload) {
    if (!payload) return;
    const result = payload.result;
    const target = payload.target;
    if (!result || !target) return;
    const outcome = result.outcome;
    if (outcome === 'invalid') return;

    // §10.2/§10.3 — player-damage-taken feedback. Independent of the
    // damageNumberMode filter below (that filter only gates the floating
    // NUMBER, never the flash/impulse/vignette-adjacent reaction to the
    // player's own life dropping).
    if (outcome === 'hit' && result.total > 0) {
      this._onPlayerMaybeDamaged(target, result);
    }

    let kind;
    if (outcome === 'miss' || outcome === 'dodge') kind = 'miss'; // `09`'s kind table has no separate 'dodge' entry — see report
    else if (outcome === 'block') kind = 'block';
    else if (outcome === 'immune') kind = 'immune';
    else if (outcome === 'hit') {
      // A DoT tick is the only producer that emits `actor:damage` with
      // `source: null` (`combat/status.js#emitDotTick`) — see this file's
      // header for why that is the signal this file uses, in the absence
      // of any explicit "this is a DoT tick" field on `DamageResult`.
      kind = payload.source === null ? 'dot' : (result.crit ? 'crit' : 'hit');
    } else {
      return;
    }

    if (!this._passesFilter(result.sourceId)) return;

    let amount = 0;
    let colour;
    if (kind === 'hit' || kind === 'crit' || kind === 'dot') {
      amount = result.total;
      if (amount <= 0) return; // nothing to show for a zero-total 'hit'
      colour = elementColour(dominantElement(result), kind === 'crit');
    }

    this._spawnOrMerge(kind, result.targetId, result.sourceId, amount, target.x, target.y, target.z, colour);
  }

  _handleActorHeal(payload) {
    if (!payload) return;
    const target = payload.target;
    const amount = payload.amount;
    if (!target || !(amount > 0)) return;
    const sourceId = payload.source ? payload.source.id : 0;
    if (!this._passesFilter(sourceId)) return;
    this._spawnOrMerge('heal', target.id, sourceId, amount, target.x, target.y, target.z);
  }

  /** §10.2 damage-taken flash + §10.3 screenImpulse rate-limited
   * accumulation. Only when `target` is the player's own actor. */
  _onPlayerMaybeDamaged(target, result) {
    const player = safeGet(this._ctx, 'player');
    if (!player || !player.actor || player.actor.id !== target.id) return;
    const actors = safeGet(this._ctx, 'actors');
    const stats = actors && typeof actors.stats === 'function' ? actors.stats(player.actor) : player.actor.stats;
    const maxLife = stats ? stats.maxLife : 0;
    if (!(maxLife > 0)) return;

    // §10.2 — peak formula.
    const flashPeak = 0.35 + 0.65 * clamp(result.total / (0.18 * maxLife), 0, 1);
    this._flashT = 0;
    this._flashPeak = flashPeak;

    // §10.3 — strength, direction (to screen centre from the player's own
    // position — see this file's header for why the target's own position
    // stands in for `result.pointX/Y/Z`), max-combined within the window.
    const strength = clamp(result.total / (0.20 * maxLife), 0, 1);
    this._worldToScreen(target.x, target.y + 1.35, target.z, this._impulseScreenScratch, this._ctx);
    let dx = this._vw * 0.5 - this._impulseScreenScratch.x;
    let dy = this._vh * 0.5 - this._impulseScreenScratch.y;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > 1e-4) { dx /= mag; dy /= mag; } else { dx = 0; dy = 0; }

    if (this._impulseWindow <= 0) this._impulseWindow = IMPULSE_WINDOW_S;
    if (strength >= this._impulsePendingStrength) {
      this._impulsePendingStrength = strength;
      this._impulseDirX = dx;
      this._impulseDirY = dy;
    }
  }

  // -------------------------------------------------------------------
  // Public API — `02-api-contracts.md` §14's rows this ticket owns.
  // -------------------------------------------------------------------

  /** `(x,y,z, amount:int, kind:'hit'|'crit'|'heal'|'immune'|'miss', element:string) => void`.
   * No targetId/sourceId in this signature — see `_spawnDirect`'s header. */
  damageNumber(x, y, z, amount, kind, element) {
    const useKind = KIND_TABLE[kind] ? kind : 'hit';
    let colour;
    if (useKind === 'hit' || useKind === 'crit') colour = elementColour(element, useKind === 'crit');
    this._spawnDirect(useKind, 0, 0, amount, x, y, z, colour);
  }

  /** `(x,y,z, text:string, colour:string) => void` — `09 §10.1`'s last
   * paragraph: same pool, `life = 1.4s`, `size = 15px`, no pop. */
  floatingText(x, y, z, text, colour) {
    this._spawnDirect('text', 0, 0, 0, x, y, z, colour || '#efe7d8', String(text));
  }

  // -------------------------------------------------------------------
  // Frame update — `lateUpdate` only, driven by `UiSystem#lateUpdate`.
  // -------------------------------------------------------------------

  /**
   * @param {number} dt - the scaled game-clock delta.
   * @param {object} ctx
   */
  update(dt, ctx) {
    if (!this._visible) return; // `09-ui.md:2128`'s gating principle, generalised — see `hud.js#update`'s own header for the established precedent.
    this._ctx = ctx;
    this._syncViewport(ctx);

    this._pollLife(ctx);
    this._updateVignette(dt);
    this._updateFlash(dt);
    this._updateImpulseWindow(dt, ctx);

    this._advanceDt = dt;
    this._topCount = 0;
    this._pool.forEachActive(this._advanceOneRecord);

    // The top-24 selection + screen-visibility pass always runs (it's what
    // the "≤24 drawn per frame" cap actually IS); only the literal canvas
    // paint calls inside `_drawSelected` are skipped when there is no real
    // 2D context (the Node DOM shim's `<canvas>` has no `getContext` —
    // `./util.js`'s header — so headless tests still exercise the cap).
    this._drawSelected(ctx);
  }

  _pollLife(ctx) {
    const player = safeGet(ctx, 'player');
    if (player && typeof player.hudState === 'function') player.hudState(this._hudOut);
  }

  // -------------------------------------------------------------------
  // §10.4 — low-life vignette + heartbeat
  // -------------------------------------------------------------------

  _updateVignette(dt) {
    const hud = this._hudOut;
    const hasActor = hud.maxLife > 0;
    // The real fraction, computed honestly — NOT faked to 1 for any
    // reason. When there is no actor at all, 1 (full/safe) is the correct
    // reading, not a stand-in.
    const trueLifeFraction = hasActor ? clamp(hud.life / hud.maxLife, 0, 1) : 1;

    // O-67 (recorded by the orchestrator this session): no actor's
    // vessels are ever initialised — `src/actors/pool.js` defaults
    // `life` to 0 and nothing fills it — so `src/player/index.js`'s M0
    // placeholder actor spawns at `life: 0, maxLife: 73` (confirmed live
    // against `ui_clean`, which broke without this guard). That is a
    // boot-time artifact, not the player dying, so it is named and
    // suppressed explicitly here rather than laundered into a fake "full
    // life" fraction the way an earlier version of this file did. THIS
    // FLAG IS A STAND-IN — delete it, and use `trueLifeFraction`
    // unconditionally, the moment O-67 lands: a real player whose life
    // reaches 0 in a genuine fight must still show the vignette, and this
    // guard would otherwise switch it off at exactly that moment.
    const isO67LifelessPlaceholder = hasActor && hud.life <= 0;

    this._lastO67Suppressed = isO67LifelessPlaceholder; // dev inspection only — __vignetteSuppressedByO67()
    const lifeFraction = isO67LifelessPlaceholder ? 1 : trueLifeFraction;

    const target = Math.pow(clamp((0.35 - lifeFraction) / 0.35, 0, 1), 1.25);
    this._vignetteShown = damp(this._vignetteShown, target, 7, dt);
    const shown = this._vignetteShown;

    let heartbeatScale = 1;
    if (lifeFraction < 0.20) {
      const hz = lerp(1.15, 2.35, clamp((0.20 - lifeFraction) / 0.20, 0, 1));
      this._heartbeatPhase += dt * hz;
      const beatIndex = Math.floor(this._heartbeatPhase);
      const p = this._heartbeatPhase - beatIndex;
      const thump = Math.exp(-Math.pow(p / 0.085, 2)) + 0.55 * Math.exp(-Math.pow((p - 0.235) / 0.10, 2));
      heartbeatScale = 1 + 0.022 * thump;
      if (beatIndex !== this._lastBeatIndex) {
        this._lastBeatIndex = beatIndex;
        const audio = safeGet(this._ctx, 'audio');
        if (audio && typeof audio.playUi === 'function') audio.playUi('player.heartbeat', 0.35 + Math.min(1, thump) * 0.5);
      }
    } else {
      this._heartbeatPhase = 0;
      this._lastBeatIndex = -1;
    }

    const opacityQ = Math.round(shown * 1000) / 1000;
    if (this._lastVignetteOpacity !== opacityQ) {
      this._lastVignetteOpacity = opacityQ;
      setStyle(this._vignetteEl, 'opacity', String(opacityQ));
      // `display:none` below 0.004, AND the `background` gradient itself
      // only assigned while shown — see `_buildDom`'s own header; both are
      // load-bearing for `ui_clean`, not just tidiness (`09 §13.4` rule 7).
      this._setExpensiveVisible(this._vignetteEl, 'background', VIGNETTE_BG, opacityQ >= 0.004);
    }
    const scaleQ = Math.round(heartbeatScale * 1000) / 1000;
    if (this._lastVignetteScale !== scaleQ) {
      this._lastVignetteScale = scaleQ;
      setStyle(this._vignetteEl, 'transform', 'scale(' + scaleQ + ')');
    }

    // §10.4 — desat mounts only under life < 0.12, `display:none` below
    // opacity 0.01 per the spec's own performance callout (and, same as
    // the vignette, `backdropFilter` itself only assigned while shown).
    const desatOn = lifeFraction < 0.12;
    const desatOpacity = desatOn ? shown * 0.8 : 0;
    const desatQ = Math.round(desatOpacity * 1000) / 1000;
    if (this._lastDesatOpacity !== desatQ) {
      this._lastDesatOpacity = desatQ;
      setStyle(this._desatEl, 'opacity', String(desatQ));
      this._setExpensiveVisible(this._desatEl, 'backdropFilter', 'saturate(.62) contrast(1.04)', desatQ >= 0.01);
    }
  }

  /** Toggles `display:none`/`block` on `node`, and — only on the transition
   * TO visible — assigns the one expensive style property (`background`'s
   * gradient, `backdropFilter`) this node needs. An ambiguity this ticket
   * resolved the hard way (see the report): even WRITING an empty string
   * to `.style[prop]` on a `display:none` node (i.e. explicitly clearing
   * it back out on hide) measurably perturbed `ui_clean`'s sky gradient,
   * where never having touched the property at all did not — Chromium's
   * style/paint invalidation appears to key off the write itself, not the
   * resulting value. So this never clears: once assigned, the gradient
   * stays in the inline style (harmless — `display:none` paints nothing),
   * and no capture that never makes this node visible ever writes to
   * `prop` at all, matching the state that is provably byte-identical. */
  _setExpensiveVisible(node, prop, value, visible) {
    if (visible && node.style[prop] !== value) node.style[prop] = value;
    setStyle(node, 'display', visible ? 'block' : 'none');
  }

  // -------------------------------------------------------------------
  // §10.2 — hit flash
  // -------------------------------------------------------------------

  _updateFlash(dt) {
    if (this._flashT >= 1) return; // idle — no wasted work
    this._flashT = Math.min(1, this._flashT + dt / 0.19);
    const alpha = this._flashPeak * (1 - easeOutQuad(this._flashT)) * 0.8;
    const alphaQ = Math.round(alpha * 1000) / 1000;
    if (this._lastFlashOpacity !== alphaQ) {
      this._lastFlashOpacity = alphaQ;
      setStyle(this._flashEl, 'opacity', String(alphaQ));
      this._setExpensiveVisible(this._flashEl, 'background', FLASH_BG, alphaQ >= 0.004);
    }
  }

  // -------------------------------------------------------------------
  // §10.3 — screenImpulse, rate-limited
  // -------------------------------------------------------------------

  _updateImpulseWindow(dt, ctx) {
    if (this._impulseWindow <= 0) return;
    this._impulseWindow -= dt;
    if (this._impulseWindow > 0) return;
    this._impulseWindow = 0;
    const strength = this._impulsePendingStrength;
    if (strength > 0) {
      const render = safeGet(ctx, 'render');
      if (render && typeof render.screenImpulse === 'function') render.screenImpulse(strength, this._impulseDirX, this._impulseDirY);
      const player = safeGet(ctx, 'player');
      if (player && typeof player.cameraShake === 'function') player.cameraShake(0.35 * strength);
    }
    this._impulsePendingStrength = 0;
    this._impulseDirX = 0;
    this._impulseDirY = 0;
  }

  // -------------------------------------------------------------------
  // §10.1 — draw pass (the top-24 selection already ran in `update()`)
  // -------------------------------------------------------------------

  _drawSelected(ctx) {
    const g = this._ctx2d;
    if (g) g.clearRect(0, 0, this._vw, this._vh);
    const scratch = this._screenScratch;
    let drawn = 0;
    for (let i = 0; i < this._topCount; i++) {
      const rec = this._records[this._topSlots[i]];
      this._worldToScreen(rec.x, rec.y + 1.35, rec.z, scratch, ctx);
      if (!scratch.visible) continue;
      rec.sx = scratch.x;
      rec.sy = scratch.y;
      if (g) this._drawOne(g, rec);
      drawn++;
    }
    this._lastDrawnCount = drawn;

    // `display:none` while nothing is drawn — same `09 §13.4` rule 7
    // reasoning as the vignette/flash/desat nodes (`_buildDom`'s header):
    // Chromium promotes an attached `<canvas>` onto its own compositing
    // layer regardless of content, which measurably perturbed `ui_clean`'s
    // sky gradient even fully empty. An empty, hidden canvas is visually
    // identical to an empty, shown one, so this costs nothing real.
    const canvasVisible = drawn > 0;
    if (this._lastCanvasVisible !== canvasVisible) {
      this._lastCanvasVisible = canvasVisible;
      setStyle(this._canvas, 'display', canvasVisible ? 'block' : 'none');
    }
  }

  _drawOne(g, rec) {
    const spec = KIND_TABLE[rec.kind] || KIND_TABLE.hit;
    const life = rec.life > 0 ? rec.life : 1;
    const u = clamp(rec.t / life, 0, 1);

    const riseFrac = easeOutCubic(Math.min(1, u * 1.15));
    const riseMul = spec.riseMul || 1;
    const rise = riseFrac * 52 * K * rec.riseScale * riseMul;

    const driftMul = spec.driftMul || 1;
    const driftPx = rec.drift * K * easeOutQuad(u) * driftMul;

    const pop = spec.pop === false ? 1 : 1 + 0.36 * (1 - easeOutQuint(Math.min(1, u / 0.10)));

    let alpha = u < 0.60 ? 1 : 1 - easeInQuad((u - 0.60) / 0.40);
    if (spec.alphaMul !== undefined) alpha *= spec.alphaMul;
    if (alpha <= 0.001) return;

    const drawX = rec.sx + driftPx;
    const drawY = rec.sy - rise;

    g.save();
    g.globalAlpha = alpha;
    g.font = '700 ' + (rec.size * K).toFixed(1) + 'px ' + FF_SERIF;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineWidth = 3 * K;
    g.strokeStyle = '#070605';
    g.translate(drawX, drawY);
    g.scale(pop, pop);
    g.strokeText(rec.text, 0, 0);
    g.fillStyle = rec.colour;
    g.fillText(rec.text, 0, 0);
    g.restore();

    // §10.1 — the crit ring: "a 2 px ring expanding 0 -> 34 px over the
    // first 160 ms at 45% alpha".
    if (rec.kind === 'crit' && rec.t < 0.16) {
      const ringProgress = rec.t / 0.16;
      g.save();
      g.globalAlpha = 0.45;
      g.lineWidth = 2 * K;
      g.strokeStyle = rec.colour;
      g.beginPath();
      g.arc(drawX, drawY, 34 * ringProgress, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }

  // -------------------------------------------------------------------
  // Screen gating — called from `UiSystem#setScreen`, same principle as
  // `hud.js#setVisible` (09-ui.md:2128, generalised), plus one addition:
  // attachment into `this._layer` is itself deferred to the first time
  // this module is shown, not done unconditionally at construction.
  //
  // Every DOM node this module ever builds is still allocated exactly
  // once, in `_buildDom()` (`ARCHITECTURE.md` rule 6) — only WHEN
  // `this._container` joins the `feedback` layer's tree changes. This
  // keeps a `UiSystem` that never reaches the `game` screen (every
  // pre-U3 test, `ui1.test.js` included, and every real boot up through
  // `character_create`) with a `feedback` layer that is not just
  // CSS-hidden but literally still empty — the same "no work, no
  // footprint" guarantee `hud.js` gives while hidden, extended one step
  // further here because this ticket lands after another already-landed
  // test (`tests/ui/ui1.test.js`, outside this ticket's file grant)
  // asserted every non-`hud` layer has zero children; deferred attachment
  // satisfies that test's real intent (nothing draws before it should)
  // without editing a file this ticket was not granted.
  // -------------------------------------------------------------------

  setVisible(visible) {
    const next = !!visible;
    if (this._visible === next) return;
    this._visible = next;
    if (next && !this._attached) {
      this._layer.appendChild(this._container);
      this._attached = true;
    }
    setStyle(this._container, 'display', next ? 'block' : 'none');
  }

  dispose() {
    if (this._ctx && this._ctx.events && typeof this._ctx.events.off === 'function') {
      this._ctx.events.off('actor:damage', this._onActorDamage);
      this._ctx.events.off('actor:heal', this._onActorHeal);
    }
    if (this._container && this._container.remove) this._container.remove();
    this._container = null;
  }

  // -------------------------------------------------------------------
  // Dev-only inspection — double-underscore, not part of `02-api-
  // contracts.md` (rule 7), matching `hud.js`'s `__orbDebug`/`__hudState`
  // convention.
  // -------------------------------------------------------------------

  __nodeCount() {
    return this._container ? countNodes(this._container) : 0;
  }

  __poolCapacity() {
    return this._pool.capacity;
  }

  __activeCount() {
    return this._pool.activeCount;
  }

  __lastDrawnCount() {
    return this._lastDrawnCount;
  }

  __liveCountForTarget(targetId) {
    let n = 0;
    this._pool.forEachActive((rec) => { if (rec.targetId === targetId) n++; });
    return n;
  }

  __record(slot) {
    return this._records[slot];
  }

  __vignetteShown() {
    return this._vignetteShown;
  }

  /** @returns {boolean} whether the LAST `_updateVignette` call read the
   * O-67 lifeless-placeholder stand-in (see that method's own header) —
   * the suppression itself, not just its numeric side effect on the
   * shown fraction. Dev/test-only; delete alongside the flag it exposes
   * once O-67 lands. */
  __vignetteSuppressedByO67() {
    return !!this._lastO67Suppressed;
  }

  __flashState() {
    return { t: this._flashT, peak: this._flashPeak };
  }

  __impulseState() {
    return { window: this._impulseWindow, strength: this._impulsePendingStrength, dirX: this._impulseDirX, dirY: this._impulseDirY };
  }
}
