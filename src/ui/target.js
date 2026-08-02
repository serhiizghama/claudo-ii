// src/ui/target.js
//
// UI-8 — `09-ui.md` §15's U4 row: "Target bar and the buff strip." §4.5's
// four rank layouts (normal/minion, champion, unique, boss) with the ghost
// band, segment ticks, affix chips and immunity marks, plus §4.6's 24-entry
// buff/debuff strip with radial depletion. Owned by `ui`, constructed and
// driven by `UiSystem` (`./index.js`) — same shape every other U-ticket's
// module already establishes: a container of preallocated nodes, an
// `update(dt, ctx)` that no-ops while hidden, `setVisible(visible)` gated on
// the active screen, `dispose()`.
//
// Both widgets attach into `layers.hud` (this ticket's own file-grant
// instruction) — the target bar and the buff strip are both persistent HUD
// chrome, the same layer `./hud.js`'s plinth/orbs/XP bar and `./hotbar.js`'s
// hotbar/belt already occupy.
//
// ---------------------------------------------------------------------------
// D-41 — `ai.debugStage`/champion-boss promotion do not exist; staged from
// hand-built records instead, never faked
// ---------------------------------------------------------------------------
// `09` U4's own acceptance text names `ai.debugStage('champion')`/`('boss')`,
// but `src/ai/index.js:16` documents that `debugStage` (and champion/boss
// rank promotion generally, AI-8/M6) is left UNIMPLEMENTED — not stubbed.
// Per this ticket's ruling (D-41), the four rank layouts are proven instead
// by staging PLAIN, hand-built actor-shaped records with `rank`/`flags`/
// `stats`/`affixes` set directly (`__debugStageRank`, bottom of this file) —
// the same tier `./hotbar.js`'s `__debugStageCooldown` already occupies for
// its own "the real data source doesn't exist yet" gap. `ai.debugStage`
// itself is NOT implemented here, and no `typeof ai.debugStage === 'function'`
// guard exists anywhere in this file — the O-27/O-39 anti-pattern this
// project has hit nine times, most recently forbidden by name in this
// ticket's own brief.
//
// ---------------------------------------------------------------------------
// The buff strip shows the PLAYER's own statuses/buffs, not the target's
// ---------------------------------------------------------------------------
// `09 §4.6` sits in the general "4. HUD" section, not under "target bar",
// and `09 §10.8`'s own transient table confirms it directly: "`actor:status`
// **on the player** | the buff strip's new icon pops...". This is the same
// "your own buffs sit near your own portrait" convention every ARPG in this
// lineage uses. `Target#update` therefore reads `ctx.get('player').actor`
// for the strip — independently of whatever `setTargetBar(actor)` was last
// called with — never the hovered/boss target.
//
// ---------------------------------------------------------------------------
// `skills.describe()` is not implemented (checked live, `src/skills/index.js`
// has no `describe` method today) — a buff's total duration is derived
// locally instead
// ---------------------------------------------------------------------------
// `buffList(actor, out)` entries are `{ buffId, level, remaining, stacks }` —
// no `total`/`duration` field (`02-api-contracts.md` §10). `describe()`
// WOULD carry `duration`, but grepping `src/skills/*.js` turns up no
// `describe` implementation anywhere — calling it would throw, and guarding
// it with `typeof skills.describe === 'function'` would be exactly the
// O-27/O-39 shape this ticket's brief singles out (even though that ruling
// is written about `ai.debugStage` specifically, the same reasoning applies:
// a contracted method that genuinely does not exist yet must not be probed
// for and silently skipped in a production code path). Debuffs carry their
// own `appliedStep`/`expiresStep` (`01-data-model.md` §7.1) so their total is
// exact and needs no tracking. Buffs do not, so this file derives one
// per-slot, per-buffId, the same "compare this frame's polled value against
// the last one" discipline `./hud.js`'s XP chase / ghost band already uses
// for D-A: the first time a `buffId` is observed (or its `remaining` is seen
// to have INCREASED, i.e. a refresh/reapply), that `remaining` becomes the
// new 100% baseline; every following frame's radial sweep is measured
// against it until the buff disappears or refreshes again. See
// `_buffTotalFor` below. Reported as a gap for whichever ticket lands
// `skills.describe()` to close cleanly.
//
// ---------------------------------------------------------------------------
// No `src/ui/icons.js` (09 §7.6) — placeholder glyphs, CSS-drawn not canvas
// ---------------------------------------------------------------------------
// §7.6's shared 512×512 icon atlas is real work with its own ticket-sized
// scope (`icons.js` is not in this ticket's file grant, and does not exist
// in the tree) — `./hotbar.js` U2 already established the precedent
// ("Skill icons come from a placeholder glyph") for exactly this gap. This
// file's own placeholder differs from hotbar's `<canvas>` disc for a
// concrete budget reason: a `<canvas>` per buff-strip entry would cost a 4th
// node × 24 entries, blowing the §13.1 72-node ceiling this ticket is
// measured against. The glyph is instead a `radial-gradient` baked into the
// icon well's own `background` (zero extra nodes) — an honest placeholder,
// not a faked procedural icon.
//
// ---------------------------------------------------------------------------
// O-70 — no combat/status/affix i18n keys exist; called via `t()` anyway
// ---------------------------------------------------------------------------
// `status.<id>` (debuff names), `skill.<id>.name` (buff names — buffs ARE
// skills) and `monsterAffix.<id>` (affix chip labels) are all real,
// documented key conventions (`09 §14.2`'s data-owned-strings table) but
// none of the specific keys this file needs exist in `src/ui/i18n.js` yet
// (checked live — `i18n.js` is off-limits to this ticket). Every label below
// goes through `this._t(key)` regardless, exactly like `./feedback.js`'s own
// `combat.miss`/`combat.block`/`combat.absorb` gap: `t()`'s documented
// `[missing]<key>` fallback means this never throws, only shows an ugly
// placeholder string until the keys land. Full list in this ticket's report.

import { el, setText, setStyle, damp, clamp, numStr, countNodes } from './util.js';

// ---------------------------------------------------------------------------
// Constants transcribed from the read ranges — never fabricated numbers.
// ---------------------------------------------------------------------------

// `09 §4.5`, verbatim.
const FILL_DAMP_RATE = 14;
const GHOST_HOLD_S = 0.50; // "500 ms hold"
const GHOST_DRAIN_PER_S = 1.20; // "1.20 of max per second"
const PHASE_THRESHOLDS = [0.60, 0.25]; // "60% and 25%, the phase thresholds from the plan"
const PHASE_FLASH_S = 0.5; // §10.7: "a 500 ms --ember rule sweep, the phase tick... flashing --ink-1" — the same beat, reused for the tick's own flash window.
const AFFIX_CHIP_MAX = 4; // "up to 4" (§4.5) — also §13.1's own "4 affix chips" node budget.
const IMMUNITY_MARK_MAX = 4; // §13.1's own "4 immunity marks" node budget — 6 elements exist (ARCHITECTURE.md), capped here to hold the node ceiling; see report.
const CLEAR_HOLD_S = 1.2; // "Cleared 1.2 s after the target dies or leaves the cursor" — player's job to call setTargetBar(null); this file only remembers it never enforces the delay itself.

// `01-data-model.md` §1.2 `ACTOR_FLAG.boss` — transcribed (not imported;
// `actors` is another subsystem's module, ARCHITECTURE.md rule 2).
const ACTOR_FLAG_BOSS = 1 << 6;

// ARCHITECTURE.md "Damage elements": physical, fire, cold, lightning,
// poison, magic — the fixed order `combat.isImmune` is probed in.
const ELEMENT_LIST = ['physical', 'fire', 'cold', 'lightning', 'poison', 'magic'];

// `06-monsters-ai.md` §9.4's immunity table: only these three affixes grant
// an element, the other six ("swift", "mighty", "stoneskin", "hexing",
// "vampiric", "multishot") are power/utility with no element of their own —
// an ambiguity this ticket resolved (see report): those chips get a neutral
// border instead of inventing an element they do not have.
const AFFIX_ELEMENT = { burning: 'fire', charged: 'lightning', frostbound: 'cold' };

// `01-data-model.md` §7.2's `STATUS_ORDER`, transcribed (same "cannot import
// actors" reasoning as `ACTOR_FLAG_BOSS` above).
const STATUS_ORDER = ['burning', 'poisoned', 'bleeding', 'shocked', 'chilled', 'frozen', 'slowed', 'stunned', 'blinded', 'cursed'];

const RANK_LAYOUT = {
  // w/h = bar box, nameY/barY = literal px inset from the top edge (09
  // §4.5's own table — an "inset from the top", the same convention
  // ./hud.js's header documents for its own bottom/edge anchors, so this
  // lands the same at both the 1920x1080 and 1280x720 capture resolutions).
  normal:   { w: 280, h: 8,  nameToken: 'body-em', nameY: 26, barY: 46, seam: null, tickPct: 25, chips: false, pips: 0, plate: false, percentage: false, levelPrefix: true },
  minion:   { w: 280, h: 8,  nameToken: 'body-em', nameY: 26, barY: 46, seam: null, tickPct: 25, chips: false, pips: 0, plate: false, percentage: false, levelPrefix: true },
  champion: { w: 360, h: 12, nameToken: 'name',    nameY: 24, barY: 48, seam: 'var(--property)',      tickPct: 25, chips: true,  pips: 0, plate: false, percentage: false, levelPrefix: false },
  unique:   { w: 420, h: 14, nameToken: 'name',    nameY: 24, barY: 48, seam: 'var(--rarity-unique)',  tickPct: 25, chips: true,  pips: 3, plate: false, percentage: false, levelPrefix: false },
  boss:     { w: 720, h: 20, nameToken: 'display', nameY: 18, barY: 64, seam: null, tickPct: 10, chips: false, pips: 0, plate: true, percentage: true, levelPrefix: false },
};
const BOSS_PLATE_W = 800;
const BOSS_PLATE_H = 78;

// `09 §4.6`, verbatim.
const BUFF_ICON = 34;
const BUFF_GAP = 4;
const BUFF_COLS = 12;
const BUFF_ROWS = 2;
const BUFF_MAX = BUFF_COLS * BUFF_ROWS; // 24
const BUFF_ORIGIN_X = 24;
const BUFF_ORIGIN_Y = 892;
const BUFF_REMAINING_SHOW_S = 5; // "below 5 s, the seconds appear bottom-left"
const BUFF_PULSE_S = 2; // "below 2 s the whole icon pulses"
const BUFF_PULSE_RATE = 6.0; // "phi += dt * 6.0"
const BUFF_POP_S = 0.18; // §10.8: "pops scale 1.3 -> 1.0 over 180 ms"

function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(id); } catch { return null; }
  }
  return null;
}

/** "1 decimal below 10 s, integer above" (`09 §4.2`'s own convention,
 * reused here — the buff strip only ever shows this below 5 s anyway). */
function formatSeconds(remaining) {
  if (remaining < 10) return (Math.round(remaining * 10) / 10).toFixed(1);
  return numStr(Math.round(remaining));
}

/** Effective rank for layout purposes: `ACTOR_FLAG.boss` always wins over
 * whatever `actor.rank` says (`09 §4.5`: "force-set for the boss whenever
 * actor.flags & ACTOR_FLAG.boss"), then falls back to `actor.rank`, then
 * `'normal'`. */
function effectiveRank(actor) {
  if (actor && typeof actor.flags === 'number' && (actor.flags & ACTOR_FLAG_BOSS) !== 0) return 'boss';
  return (actor && RANK_LAYOUT[actor.rank]) ? actor.rank : 'normal';
}

/** A fixed-thickness (2 px) coloured mark at `pct` along a `trackWidthPx`
 * wide bar, as one `linear-gradient` layer — used for both the boss's phase
 * ticks and (indirectly) nothing else; kept standalone for readability. */
function markGradient(pct, color, trackWidthPx) {
  const halfPct = trackWidthPx > 0 ? (100 * 1) / trackWidthPx : 0.15; // 1 px half-thickness => 2 px total
  const p0 = clamp(pct - halfPct, 0, 100);
  const p1 = clamp(pct + halfPct, 0, 100);
  return `linear-gradient(90deg, transparent 0%, transparent ${p0}%, ${color} ${p0}%, ${color} ${p1}%, transparent ${p1}%, transparent 100%)`;
}

/** §13.1's node-saving trick applied a third time in this codebase (the
 * inventory lattice, the XP ticks, now this): segment ticks, the boss's two
 * phase ticks and the unique's three rank pips are all ONE node's
 * `background`, composited as extra gradient layers — never a DOM node per
 * mark. */
function ticksBackground(rank, layout, trackWidthPx, phase60Color, phase25Color) {
  const layers = [`repeating-linear-gradient(90deg, var(--hair) 0, var(--hair) 1px, transparent 1px, transparent ${layout.tickPct}%)`];
  if (rank === 'boss') {
    layers.push(markGradient(60, phase60Color, trackWidthPx));
    layers.push(markGradient(25, phase25Color, trackWidthPx));
  } else if (rank === 'unique' && layout.pips > 0) {
    // 3 static, always-lit dots — §4.5 names "3 rank pips" with no data
    // field driving fill state anywhere in the read ranges; rendered
    // decoratively fully-lit. See this ticket's report.
    const dots = [];
    for (let i = 0; i < layout.pips; i++) dots.push(`radial-gradient(circle 3px at ${6 + i * 10}px 50%, var(--rarity-unique) 99%, transparent 100%)`);
    layers.push(...dots);
  }
  return layers.join(', ');
}

export class Target {
  /**
   * @param {object} ctx
   * @param {object} layer - the `hud` `cl2-layer` DOM node.
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} [rng] - the shared `ui`-subsystem RNG fork
   *   (ARCHITECTURE.md's one-fork-per-subsystem rule). Unused today (no
   *   jitter anywhere in this widget) — carried for parity with every other
   *   module `UiSystem.init()` hands the same fork to.
   */
  constructor(ctx, layer, translate, rng) {
    this._layer = layer;
    this._t = translate || ((key) => key);
    this._rng = rng || null;
    this._ctx = ctx || null;
    this._visible = false;

    this._vw = 1920;
    this._vh = 1080;

    this._targetActor = null;
    this._lastRank = null;
    this._fillFrac = 0; // damped, shown value
    this._trueFrac = 0;
    this._ghostFrac = 0;
    this._ghostHold = 0;
    this._prevFrac = 1; // for phase-cross detection
    this._phaseFlash = new Float32Array(PHASE_THRESHOLDS.length);
    this._lastFillQ = -1;
    this._lastGhostQ = -1;

    this._buildTargetBarDom();

    // -------------------------------------------------------------------
    // Buff strip — 24 pooled entries x 3 nodes = 72 (§13.1's own ceiling).
    // -------------------------------------------------------------------
    this._buffPlates = new Array(BUFF_MAX);
    this._buffStackText = new Array(BUFF_MAX);
    this._buffRemainText = new Array(BUFF_MAX);
    this._buffSlotState = new Array(BUFF_MAX); // {kind, id, lastKey, popT}
    this._buildBuffStripDom();

    // Debuffs+buffs merged scratch (preallocated, reused every frame — no
    // per-frame array growth, ARCHITECTURE.md rule 6).
    this._mergedEntries = new Array(BUFF_MAX);
    for (let i = 0; i < BUFF_MAX; i++) this._mergedEntries[i] = { kind: '', id: '', remaining: 0, total: 0, stacks: 1, color: 'var(--ash-500)' };
    this._buffListScratch = new Array(BUFF_MAX);
    for (let i = 0; i < BUFF_MAX; i++) this._buffListScratch[i] = { buffId: null, level: 0, remaining: 0, stacks: 0 };

    // Per-buffId observed-baseline table for the radial sweep's "total" —
    // see this file's header. Small, fixed, linear-scanned (never a Map —
    // `./util.js#Pool`'s own "Map is banned for pooled state" precedent).
    this._buffTotals = new Array(16);
    for (let i = 0; i < 16; i++) this._buffTotals[i] = { buffId: null, total: 0, lastRemaining: 0 };

    this._layoutStatic();
  }

  // -------------------------------------------------------------------
  // Target bar construction — 15 nodes, fixed, built once (ARCHITECTURE.md
  // rule 6/7). See this file's header for the exact accounting against the
  // 16-node ceiling.
  // -------------------------------------------------------------------

  _buildTargetBarDom() {
    // plate — e1, boss-only visually, but the SAME node backs every rank
    // (hidden via opacity for the other four) rather than a second node.
    this._plate = el('div', 'cl2-tb-plate');
    setStyle(this._plate, 'position', 'absolute');
    setStyle(this._plate, 'background', 'var(--e1-fill)');
    setStyle(this._plate, 'borderTop', 'var(--edge)');
    setStyle(this._plate, 'boxShadow', 'var(--e1-shadow)');
    setStyle(this._plate, 'display', 'none');
    this._layer.appendChild(this._plate);

    this._track = el('div', 'cl2-tb-track');
    setStyle(this._track, 'position', 'absolute');
    setStyle(this._track, 'background', 'var(--void)');
    setStyle(this._track, 'boxShadow', 'var(--well)');
    setStyle(this._track, 'overflow', 'hidden');
    setStyle(this._track, 'display', 'none');
    this._layer.appendChild(this._track);

    this._ghost = el('div', 'cl2-tb-ghost');
    setStyle(this._ghost, 'position', 'absolute');
    setStyle(this._ghost, 'left', '0');
    setStyle(this._ghost, 'top', '0');
    setStyle(this._ghost, 'height', '100%');
    setStyle(this._ghost, 'background', 'var(--life-ghost)');
    setStyle(this._ghost, 'transformOrigin', '0 0');
    setStyle(this._ghost, 'display', 'none');
    this._layer.appendChild(this._ghost);

    this._fill = el('div', 'cl2-tb-fill');
    setStyle(this._fill, 'position', 'absolute');
    setStyle(this._fill, 'left', '0');
    setStyle(this._fill, 'top', '0');
    setStyle(this._fill, 'height', '100%');
    setStyle(this._fill, 'background', 'var(--life-top)');
    setStyle(this._fill, 'transformOrigin', '0 0');
    setStyle(this._fill, 'display', 'none');
    this._layer.appendChild(this._fill);

    this._ticks = el('div', 'cl2-tb-ticks');
    setStyle(this._ticks, 'position', 'absolute');
    setStyle(this._ticks, 'left', '0');
    setStyle(this._ticks, 'top', '0');
    setStyle(this._ticks, 'width', '100%');
    setStyle(this._ticks, 'height', '100%');
    setStyle(this._ticks, 'display', 'none');
    this._layer.appendChild(this._ticks);

    this._name = el('div', 'cl2-tb-name');
    setStyle(this._name, 'position', 'absolute');
    setStyle(this._name, 'textAlign', 'center');
    setStyle(this._name, 'whiteSpace', 'nowrap');
    setStyle(this._name, 'color', 'var(--ink-1)');
    setStyle(this._name, 'textShadow', 'var(--sh-o1)');
    setStyle(this._name, 'fontFamily', 'var(--ff-sans)');
    setStyle(this._name, 'display', 'none');
    this._layer.appendChild(this._name);

    this._chips = new Array(AFFIX_CHIP_MAX);
    for (let i = 0; i < AFFIX_CHIP_MAX; i++) {
      const chip = el('div', 'cl2-tb-chip');
      setStyle(chip, 'position', 'absolute');
      setStyle(chip, 'height', '12px');
      setStyle(chip, 'fontFamily', 'var(--ff-sans)');
      setStyle(chip, 'fontSize', 'var(--t-micro-size)');
      setStyle(chip, 'fontWeight', 'var(--t-micro-weight)');
      setStyle(chip, 'letterSpacing', 'var(--t-micro-tracking)');
      setStyle(chip, 'textTransform', 'var(--t-micro-transform)');
      setStyle(chip, 'lineHeight', '12px');
      setStyle(chip, 'padding', '0 4px');
      setStyle(chip, 'background', 'var(--ash-700)');
      setStyle(chip, 'color', 'var(--ink-2)');
      setStyle(chip, 'whiteSpace', 'nowrap');
      setStyle(chip, 'display', 'none');
      this._layer.appendChild(chip);
      this._chips[i] = chip;
    }

    this._marks = new Array(IMMUNITY_MARK_MAX);
    for (let i = 0; i < IMMUNITY_MARK_MAX; i++) {
      const mark = el('div', 'cl2-tb-immune');
      setStyle(mark, 'position', 'absolute');
      setStyle(mark, 'width', '10px');
      setStyle(mark, 'height', '10px');
      setStyle(mark, 'display', 'none');
      this._layer.appendChild(mark);
      this._marks[i] = mark;
    }

    this._percentage = el('div', 'cl2-tb-pct');
    setStyle(this._percentage, 'position', 'absolute');
    setStyle(this._percentage, 'fontFamily', 'var(--ff-mono)');
    setStyle(this._percentage, 'fontSize', 'var(--t-num-l-size)');
    setStyle(this._percentage, 'fontWeight', 'var(--t-num-l-weight)');
    setStyle(this._percentage, 'lineHeight', 'var(--t-num-l-lh)');
    setStyle(this._percentage, 'letterSpacing', 'var(--t-num-l-tracking)');
    setStyle(this._percentage, 'color', 'var(--ink-1)');
    setStyle(this._percentage, 'textShadow', 'var(--sh-o1)');
    setStyle(this._percentage, 'textAlign', 'right');
    setStyle(this._percentage, 'display', 'none');
    this._layer.appendChild(this._percentage);

    // Every node this widget owns, for setVisible()/dispose()/node-count.
    this._targetBarNodes = [this._plate, this._track, this._ghost, this._fill, this._ticks, this._name, this._percentage, ...this._chips, ...this._marks];
  }

  // -------------------------------------------------------------------
  // Buff strip construction — 24 x 3 = 72 nodes (§13.1's own ceiling).
  // -------------------------------------------------------------------

  _buildBuffStripDom() {
    for (let i = 0; i < BUFF_MAX; i++) {
      const plate = el('div', 'cl2-buff-plate');
      setStyle(plate, 'position', 'absolute');
      setStyle(plate, 'width', BUFF_ICON + 'px');
      setStyle(plate, 'height', BUFF_ICON + 'px');
      setStyle(plate, 'boxSizing', 'border-box');
      setStyle(plate, 'borderWidth', '1px');
      setStyle(plate, 'borderStyle', 'solid');
      setStyle(plate, 'borderBottomWidth', '2px');
      setStyle(plate, 'background', 'var(--ash-800)');
      setStyle(plate, 'pointerEvents', 'auto'); // O-78 — see setAttribute below
      plate.setAttribute('data-ui-solid', ''); // O-78: a solid HUD node must not leak a click through to world click-to-move
      setStyle(plate, 'display', 'none');
      this._layer.appendChild(plate);
      this._buffPlates[i] = plate;

      const stackText = el('div', 'cl2-buff-stack');
      setStyle(stackText, 'position', 'absolute');
      setStyle(stackText, 'right', '2px');
      setStyle(stackText, 'bottom', '1px');
      setStyle(stackText, 'fontFamily', 'var(--ff-mono)');
      setStyle(stackText, 'fontSize', 'var(--t-num-s-size)');
      setStyle(stackText, 'fontWeight', 'var(--t-num-s-weight)');
      setStyle(stackText, 'color', 'var(--ink-1)');
      setStyle(stackText, 'textShadow', 'var(--sh-o1)');
      setStyle(stackText, 'pointerEvents', 'none');
      setStyle(stackText, 'display', 'none');
      this._layer.appendChild(stackText);
      this._buffStackText[i] = stackText;

      const remainText = el('div', 'cl2-buff-remain');
      setStyle(remainText, 'position', 'absolute');
      setStyle(remainText, 'left', '2px');
      setStyle(remainText, 'bottom', '1px');
      setStyle(remainText, 'fontFamily', 'var(--ff-mono)');
      setStyle(remainText, 'fontSize', 'var(--t-num-s-size)');
      setStyle(remainText, 'fontWeight', 'var(--t-num-s-weight)');
      setStyle(remainText, 'color', 'var(--ink-1)');
      setStyle(remainText, 'textShadow', 'var(--sh-o1)');
      setStyle(remainText, 'pointerEvents', 'none');
      setStyle(remainText, 'display', 'none');
      this._layer.appendChild(remainText);
      this._buffRemainText[i] = remainText;

      this._buffSlotState[i] = { kind: '', id: '', lastKey: '', popT: BUFF_POP_S, lastAngleQ: -1, lastStackText: null, lastRemainText: null, lastScaleQ: 1000, lastOpacityQ: 100, pulsePhi: 0 };
    }
  }

  // -------------------------------------------------------------------
  // Layout — viewport-relative, recomputed on resize only (D-B: never a
  // per-frame layout read/write of geometry that hasn't changed).
  // -------------------------------------------------------------------

  _syncViewport(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw;
    this._vh = vh;
    this._layoutStatic();
    this._lastRank = null; // force a full re-layout of the target bar next update
  }

  _layoutStatic() {
    const cx = this._vw / 2;
    for (let i = 0; i < BUFF_MAX; i++) {
      const row = Math.floor(i / BUFF_COLS);
      const col = i % BUFF_COLS;
      const x = BUFF_ORIGIN_X + col * (BUFF_ICON + BUFF_GAP);
      const y = BUFF_ORIGIN_Y - row * (BUFF_ICON + BUFF_GAP); // "growing right then up"
      setStyle(this._buffPlates[i], 'left', x + 'px');
      setStyle(this._buffPlates[i], 'top', y + 'px');
      setStyle(this._buffStackText[i], 'left', x + 'px');
      setStyle(this._buffStackText[i], 'top', y + 'px');
      setStyle(this._buffStackText[i], 'width', BUFF_ICON + 'px');
      setStyle(this._buffRemainText[i], 'left', x + 'px');
      setStyle(this._buffRemainText[i], 'top', y + 'px');
      setStyle(this._buffRemainText[i], 'width', BUFF_ICON + 'px');
    }
    this._buffCx = cx;
  }

  /** Re-lays the fixed target-bar geometry for `rank` — called only when
   * the rank (or viewport) actually changes, never per frame. */
  _layoutTargetBar(rank) {
    const layout = RANK_LAYOUT[rank];
    const cx = this._vw / 2;
    const w = layout.w;
    const h = layout.h;
    const left = cx - w / 2;

    if (layout.plate) {
      setStyle(this._plate, 'left', (cx - BOSS_PLATE_W / 2) + 'px');
      setStyle(this._plate, 'top', (layout.nameY - 8) + 'px');
      setStyle(this._plate, 'width', BOSS_PLATE_W + 'px');
      setStyle(this._plate, 'height', BOSS_PLATE_H + 'px');
      setStyle(this._plate, 'display', 'block');
    } else {
      setStyle(this._plate, 'display', 'none');
    }

    setStyle(this._track, 'left', left + 'px');
    setStyle(this._track, 'top', layout.barY + 'px');
    setStyle(this._track, 'width', w + 'px');
    setStyle(this._track, 'height', h + 'px');
    setStyle(this._track, 'borderBottom', layout.seam ? `2px solid ${layout.seam}` : 'none');
    setStyle(this._track, 'display', 'block');

    setStyle(this._ghost, 'width', w + 'px');
    setStyle(this._ghost, 'display', 'block');
    setStyle(this._fill, 'width', w + 'px');
    setStyle(this._fill, 'display', 'block');

    setStyle(this._ticks, 'display', 'block');

    setStyle(this._name, 'left', (cx - w / 2 - 40) + 'px'); // generous width, centred text
    setStyle(this._name, 'top', (layout.nameY - 12) + 'px');
    setStyle(this._name, 'width', (w + 80) + 'px');
    setStyle(this._name, 'fontSize', `var(--t-${layout.nameToken}-size)`);
    setStyle(this._name, 'fontWeight', `var(--t-${layout.nameToken}-weight)`);
    setStyle(this._name, 'lineHeight', `var(--t-${layout.nameToken}-lh)`);
    setStyle(this._name, 'letterSpacing', `var(--t-${layout.nameToken}-tracking)`);
    setStyle(this._name, 'display', 'block');

    for (let i = 0; i < AFFIX_CHIP_MAX; i++) {
      const chipY = layout.barY + h + 4;
      const chipX = left + i * 60;
      setStyle(this._chips[i], 'left', chipX + 'px');
      setStyle(this._chips[i], 'top', chipY + 'px');
    }

    for (let i = 0; i < IMMUNITY_MARK_MAX; i++) {
      const markX = left + w - 10 - i * 14; // right-aligned, growing left
      setStyle(this._marks[i], 'left', markX + 'px');
      setStyle(this._marks[i], 'top', (layout.nameY - 12) + 'px');
    }

    if (layout.percentage) {
      setStyle(this._percentage, 'left', (left + w - 90) + 'px');
      setStyle(this._percentage, 'top', (layout.barY - 34) + 'px');
      setStyle(this._percentage, 'width', '90px');
    }

    this._layoutRankCache = { left, w, h };
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /** `02-api-contracts.md` §14: `setTargetBar(actor:Actor|null) => void`,
   * `Fixed:N Alloc:no`. Stores the reference; `update()` does all the work.
   * Does NOT implement the 1.2 s clear-on-death/leave delay itself — that
   * is the CALLER's job (`player`, per `09 §4.5`'s own "Set by player
   * through..." sentence); this method only ever reflects whatever it was
   * last called with. */
  setTargetBar(actor) {
    this._targetActor = actor || null;
    if (!this._targetActor) {
      // Reset the animated state so a NEW target never inherits a stale
      // fraction/ghost from whatever was last shown.
      this._fillFrac = 0;
      this._trueFrac = 0;
      this._ghostFrac = 0;
      this._ghostHold = 0;
      this._prevFrac = 1;
      this._phaseFlash[0] = 0;
      this._phaseFlash[1] = 0;
      this._hideTargetBar();
    }
  }

  _hideTargetBar() {
    for (let i = 0; i < this._targetBarNodes.length; i++) setStyle(this._targetBarNodes[i], 'display', 'none');
    this._lastRank = null;
  }

  setVisible(visible) {
    const next = !!visible;
    if (this._visible === next) return;
    this._visible = next;
    if (!next) {
      for (let i = 0; i < this._targetBarNodes.length; i++) setStyle(this._targetBarNodes[i], 'display', 'none');
      for (let i = 0; i < BUFF_MAX; i++) {
        setStyle(this._buffPlates[i], 'display', 'none');
        setStyle(this._buffStackText[i], 'display', 'none');
        setStyle(this._buffRemainText[i], 'display', 'none');
      }
      this._lastRank = null;
    } else if (this._targetActor) {
      this._lastRank = null; // force a redraw of the target bar next update
    }
  }

  dispose() {
    for (let i = 0; i < this._targetBarNodes.length; i++) if (this._targetBarNodes[i].remove) this._targetBarNodes[i].remove();
    for (let i = 0; i < BUFF_MAX; i++) {
      if (this._buffPlates[i].remove) this._buffPlates[i].remove();
      if (this._buffStackText[i].remove) this._buffStackText[i].remove();
      if (this._buffRemainText[i].remove) this._buffRemainText[i].remove();
    }
  }

  /**
   * @param {number} dt - `ctx.time.dt`, the scaled game clock.
   * @param {object} ctx
   */
  update(dt, ctx) {
    if (!this._visible) return;
    this._ctx = ctx;
    this._syncViewport(ctx);
    this._updateTargetBar(dt, ctx);
    this._updateBuffStrip(dt, ctx);
  }

  // -------------------------------------------------------------------
  // Target bar — presentation only, integrates `dt` (rule 5 / D-D). Reads
  // `actor.life`/`actor.stats.maxLife`/`.statuses` directly off the shared
  // Actor record — the same "not an import" distinction
  // `src/combat/resolve.js#isImmuneOf`'s own header documents for reading
  // `target.stats` straight off the record it was handed.
  // -------------------------------------------------------------------

  _updateTargetBar(dt, ctx) {
    const actor = this._targetActor;
    if (!actor) return;

    const rank = effectiveRank(actor);
    if (rank !== this._lastRank) {
      this._layoutTargetBar(rank);
      this._lastRank = rank;
    }
    const layout = RANK_LAYOUT[rank];

    const maxLife = actor.stats && actor.stats.maxLife > 0 ? actor.stats.maxLife : 0;
    const life = typeof actor.life === 'number' ? actor.life : 0;
    const trueFrac = maxLife > 0 ? clamp(life / maxLife, 0, 1) : 0;

    if (trueFrac < this._trueFrac) {
      // A drop: the ghost catches the OLD (higher) value and holds before
      // draining (09 §4.5 "Ghost", the same shape as ./hud.js's own orb
      // ghost band, different numbers per this widget's own spec line).
      if (this._ghostFrac < this._trueFrac) this._ghostFrac = this._trueFrac;
      this._ghostHold = GHOST_HOLD_S;
    }
    this._trueFrac = trueFrac;
    this._fillFrac = damp(this._fillFrac, trueFrac, FILL_DAMP_RATE, dt);
    if (this._ghostFrac < this._fillFrac) this._ghostFrac = this._fillFrac;
    if (this._ghostHold > 0) this._ghostHold -= dt;
    else this._ghostFrac = Math.max(this._fillFrac, this._ghostFrac - GHOST_DRAIN_PER_S * dt);

    // Quantised to 1/1000 and change-guarded — the same "the string only
    // changes when the visible value actually moves" discipline
    // ./hud.js's own XP-fill `scaleX` write and ./hotbar.js's cooldown
    // sweep both already apply (09 §13.3 rule, ARCHITECTURE.md rule 6).
    const fillQ = Math.round(this._fillFrac * 1000);
    if (fillQ !== this._lastFillQ) {
      this._lastFillQ = fillQ;
      setStyle(this._fill, 'transform', 'scaleX(' + (fillQ / 1000).toFixed(3) + ')');
    }
    const ghostQ = Math.round(this._ghostFrac * 1000);
    if (ghostQ !== this._lastGhostQ) {
      this._lastGhostQ = ghostQ;
      setStyle(this._ghost, 'transform', 'scaleX(' + (ghostQ / 1000).toFixed(3) + ')');
    }

    // Name (+ level prefix for normal/minion).
    const nameText = layout.levelPrefix
      ? this._t('hud.levelShort') + numStr(typeof actor.level === 'number' ? actor.level : 0) + ' ' + (actor.name || '')
      : (actor.name || '');
    setText(this._name, nameText);

    // Phase ticks — boss only. Crossing DOWNWARD through a threshold since
    // last frame flashes that tick --ink-1 for PHASE_FLASH_S, integrated
    // from dt (the trap this ticket's brief calls out by name: no CSS
    // transition anywhere).
    let phase60Color = 'var(--ember)';
    let phase25Color = 'var(--ember)';
    if (rank === 'boss') {
      for (let i = 0; i < PHASE_THRESHOLDS.length; i++) {
        const threshold = PHASE_THRESHOLDS[i];
        if (this._prevFrac >= threshold && trueFrac < threshold) this._phaseFlash[i] = PHASE_FLASH_S;
        else if (this._phaseFlash[i] > 0) this._phaseFlash[i] = Math.max(0, this._phaseFlash[i] - dt);
      }
      phase60Color = this._phaseFlash[0] > 0 ? 'var(--ink-1)' : 'var(--ember)';
      phase25Color = this._phaseFlash[1] > 0 ? 'var(--ink-1)' : 'var(--ember)';
    }
    this._prevFrac = trueFrac;

    const trackWidthPx = this._layoutRankCache ? this._layoutRankCache.w : layout.w;
    setStyle(this._ticks, 'background', ticksBackground(rank, layout, trackWidthPx, phase60Color, phase25Color));

    // Affix chips — champion/unique only, from actor.affixes (an
    // ai.spawnOne-passed-through array, see this ticket's report).
    if (layout.chips && Array.isArray(actor.affixes)) {
      let shown = 0;
      for (let i = 0; i < actor.affixes.length && shown < AFFIX_CHIP_MAX; i++) {
        const id = actor.affixes[i];
        const chip = this._chips[shown];
        setText(chip, this._t('monsterAffix.' + id));
        const element = AFFIX_ELEMENT[id];
        setStyle(chip, 'borderWidth', '1px');
        setStyle(chip, 'borderStyle', 'solid');
        setStyle(chip, 'borderColor', element ? `var(--element-${element})` : 'var(--ash-500)');
        setStyle(chip, 'display', 'block');
        shown++;
      }
      for (let i = shown; i < AFFIX_CHIP_MAX; i++) setStyle(this._chips[i], 'display', 'none');
    } else {
      for (let i = 0; i < AFFIX_CHIP_MAX; i++) setStyle(this._chips[i], 'display', 'none');
    }

    // Immunity marks — `combat.isImmune(actor, element)`, right-aligned,
    // fixed ELEMENT_LIST order, capped at IMMUNITY_MARK_MAX (§13.1's own
    // node budget; see this ticket's report).
    const combat = safeGet(ctx, 'combat');
    let shownMarks = 0;
    if (combat && typeof combat.isImmune === 'function' && actor.stats) {
      for (let i = 0; i < ELEMENT_LIST.length && shownMarks < IMMUNITY_MARK_MAX; i++) {
        const el2 = ELEMENT_LIST[i];
        if (!combat.isImmune(actor, el2)) continue;
        const mark = this._marks[shownMarks];
        setStyle(mark, 'background', `linear-gradient(45deg, transparent 45%, var(--ash-900) 45%, var(--ash-900) 55%, transparent 55%), var(--element-${el2})`);
        setStyle(mark, 'display', 'block');
        shownMarks++;
      }
    }
    for (let i = shownMarks; i < IMMUNITY_MARK_MAX; i++) setStyle(this._marks[i], 'display', 'none');

    // Percentage — boss only.
    if (layout.percentage) {
      setText(this._percentage, numStr(Math.round(trueFrac * 100)) + ' %');
      setStyle(this._percentage, 'display', 'block');
    } else {
      setStyle(this._percentage, 'display', 'none');
    }
  }

  // -------------------------------------------------------------------
  // Buff strip — the PLAYER's own statuses (debuffs, STATUS_ORDER) then
  // buffs (skills.buffList order), merged and truncated to 24. Every field
  // is polled fresh every frame (D-A) — `buffList`/`isImmune`-style
  // methods are `Alloc:no` even at 1e6 calls, so there is no cost concern
  // reading them at 60 Hz instead of throttling to the spec's literal
  // 10 Hz DOM-rebuild cadence; see this ticket's report for that scoped-down
  // simplification.
  // -------------------------------------------------------------------

  _updateBuffStrip(dt, ctx) {
    const player = safeGet(ctx, 'player');
    const skills = safeGet(ctx, 'skills');
    const actor = player && player.actor;
    if (!actor) {
      for (let i = 0; i < BUFF_MAX; i++) this._hideBuffSlot(i);
      return;
    }

    let n = 0;
    const merged = this._mergedEntries;

    // Debuffs first, STATUS_ORDER, one entry per StatusEffectInstance
    // (matching §4.6's own "same cap as the statuses array" reasoning —
    // see this file's header for why this is per-INSTANCE, not per-type).
    const statuses = actor.statuses;
    const step = (ctx && ctx.time && typeof ctx.time.step === 'number') ? ctx.time.step : 0;
    if (Array.isArray(statuses)) {
      for (let s = 0; s < STATUS_ORDER.length && n < BUFF_MAX; s++) {
        const type = STATUS_ORDER[s];
        for (let i = 0; i < statuses.length && n < BUFF_MAX; i++) {
          const inst = statuses[i];
          if (!inst || inst.status !== type) continue;
          const remaining = Math.max(0, (inst.expiresStep - step) / 60);
          const total = Math.max(remaining, (inst.expiresStep - inst.appliedStep) / 60);
          const entry = merged[n];
          entry.kind = 'debuff';
          entry.id = type;
          entry.remaining = remaining;
          entry.total = total;
          entry.stacks = inst.stacks || 1;
          entry.color = `var(--element-${inst.element || 'physical'})`;
          n++;
        }
      }
    }

    // Buffs — skills.buffList(actor, out), its own documented order.
    if (skills && typeof skills.buffList === 'function' && n < BUFF_MAX) {
      const out = this._buffListScratch;
      const count = skills.buffList(actor, out);
      for (let i = 0; i < count && n < BUFF_MAX; i++) {
        const src = out[i];
        const total = this._buffTotalFor(src.buffId, src.remaining);
        const entry = merged[n];
        entry.kind = 'buff';
        entry.id = src.buffId;
        entry.remaining = src.remaining;
        entry.total = total;
        entry.stacks = src.stacks || 1;
        entry.color = 'var(--verdigris)'; // no per-buff element data available — see this file's header.
        n++;
      }
    }

    for (let i = 0; i < n; i++) this._applyBuffSlot(i, merged[i], dt);
    for (let i = n; i < BUFF_MAX; i++) this._hideBuffSlot(i);
  }

  /** See this file's header — buffList carries no total/duration. Tracked
   * per `buffId`, refreshed whenever `remaining` is observed to increase
   * (a fresh application) or the id is seen for the first time. Linear
   * scan over a small fixed array — never a Map (util.js#Pool's own
   * "banned for pooled state" precedent). */
  _buffTotalFor(buffId, remaining) {
    const table = this._buffTotals;
    let free = -1;
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      if (row.buffId === buffId) {
        if (remaining > row.lastRemaining) row.total = remaining; // refreshed/reapplied
        row.lastRemaining = remaining;
        return row.total;
      }
      if (free < 0 && row.buffId === null) free = i;
    }
    const slot = free >= 0 ? table[free] : table[table.length - 1];
    slot.buffId = buffId;
    slot.total = remaining;
    slot.lastRemaining = remaining;
    return remaining;
  }

  _applyBuffSlot(i, entry, dt) {
    const plate = this._buffPlates[i];
    const state = this._buffSlotState[i];
    const key = entry.kind + ':' + entry.id;

    if (state.lastKey !== key) {
      state.lastKey = key;
      state.popT = 0; // §10.8: pop scale 1.3 -> 1.0 over 180 ms on a new icon
      state.lastAngleQ = -1; // force the depletion/glyph background write below to run this frame
      const label = entry.kind === 'buff' ? this._t('skill.' + entry.id + '.name') : this._t('status.' + entry.id);
      plate.title = label; // best-effort hover text; the full tooltip (name/source/magnitude/unit) is out of this ticket's scope — see report.
      setStyle(plate, 'borderColor', entry.color);
      setStyle(plate, 'borderBottomColor', entry.kind === 'buff' ? 'var(--verdigris)' : 'var(--danger)');
      setStyle(plate, 'backgroundColor', 'var(--ash-800)');
      setStyle(plate, 'display', 'block');
    }

    if (state.popT < BUFF_POP_S) {
      state.popT = Math.min(BUFF_POP_S, state.popT + dt);
      const t = state.popT / BUFF_POP_S;
      const scale = 1.3 + (1.0 - 1.3) * t; // linear ease is close enough for a 180 ms pop; §10.8 names no curve for this one (contrast ./hotbar.js's punch, which does)
      const scaleQ = Math.round(scale * 1000);
      if (scaleQ !== state.lastScaleQ) {
        state.lastScaleQ = scaleQ;
        setStyle(plate, 'transform', 'scale(' + (scaleQ / 1000).toFixed(3) + ')');
      }
    } else if (state.lastScaleQ !== 1000) {
      state.lastScaleQ = 1000;
      setStyle(plate, 'transform', 'scale(1)');
    }

    // Radial depletion — conic sweep, quantised to 1 degree so the string
    // only changes 360 times over the buff's life (./hotbar.js's own
    // cooldown-sweep precedent), integrated every frame from real
    // `remaining`, never a CSS transition (this ticket's own named trap).
    const frac = entry.total > 0 ? clamp(1 - entry.remaining / entry.total, 0, 1) : 0;
    const angle = Math.round(360 * frac);
    if (angle !== state.lastAngleQ) {
      state.lastAngleQ = angle;
      // Two background layers: the depletion sweep on top, the placeholder
      // glyph field beneath — one `backgroundImage` write, no extra node.
      setStyle(plate, 'backgroundImage', `conic-gradient(from 0deg, rgba(7,6,5,.66) 0deg ${angle}deg, transparent ${angle}deg), radial-gradient(circle at 50% 45%, ${entry.color} 0%, transparent 65%)`);
    }

    // Stacks — bottom-right, only when > 1.
    if (entry.stacks > 1) {
      const stackStr = '×' + numStr(entry.stacks);
      if (state.lastStackText !== stackStr) {
        state.lastStackText = stackStr;
        setText(this._buffStackText[i], stackStr);
      }
      setStyle(this._buffStackText[i], 'display', 'block');
    } else {
      setStyle(this._buffStackText[i], 'display', 'none');
      state.lastStackText = null;
    }

    // Remaining — bottom-left, below 5 s; sub-2 s pulse, integrated phase.
    if (entry.remaining < BUFF_REMAINING_SHOW_S) {
      const remainStr = formatSeconds(entry.remaining);
      if (state.lastRemainText !== remainStr) {
        state.lastRemainText = remainStr;
        setText(this._buffRemainText[i], remainStr);
      }
      setStyle(this._buffRemainText[i], 'display', 'block');
    } else {
      setStyle(this._buffRemainText[i], 'display', 'none');
      state.lastRemainText = null;
    }

    if (entry.remaining < BUFF_PULSE_S && entry.remaining > 0) {
      // "0.55 + 0.45*|sin(phi)|, phi += dt*6.0" (09 §4.6) — quantised to
      // 1/100 and change-guarded (./hotbar.js's own punch-scale precedent),
      // so the string is only rebuilt when the visible value actually moves.
      state.pulsePhi += dt * BUFF_PULSE_RATE;
      const opacity = 0.55 + 0.45 * Math.abs(Math.sin(state.pulsePhi));
      const opacityQ = Math.round(opacity * 100);
      if (opacityQ !== state.lastOpacityQ) {
        state.lastOpacityQ = opacityQ;
        setStyle(plate, 'opacity', (opacityQ / 100).toFixed(2));
      }
    } else if (state.lastOpacityQ !== 100) {
      state.pulsePhi = 0;
      state.lastOpacityQ = 100;
      setStyle(plate, 'opacity', '1');
    }
  }

  _hideBuffSlot(i) {
    const state = this._buffSlotState[i];
    if (state.lastKey === '') return; // already hidden, change-guard
    state.lastKey = '';
    state.lastAngleQ = -1;
    state.lastStackText = null;
    state.lastRemainText = null;
    state.lastScaleQ = 1000;
    state.lastOpacityQ = 100;
    state.pulsePhi = 0;
    setStyle(this._buffPlates[i], 'display', 'none');
    setStyle(this._buffStackText[i], 'display', 'none');
    setStyle(this._buffRemainText[i], 'display', 'none');
  }

  // -------------------------------------------------------------------
  // Dev/test-only inspection and staging — double-underscore, not part of
  // `02-api-contracts.md` (rule 7), matching hud.js/hotbar.js's own
  // convention for this tier. D-41: this is how champion/boss layouts are
  // proven WITHOUT `ai.debugStage` (unimplemented) or champion/boss rank
  // promotion (AI-8, M6) — hand-built records, rank/flags/stats/affixes
  // set directly.
  // -------------------------------------------------------------------

  /** @returns {number} real, measured node count for the target bar's own
   * subtree — `countNodes()` on each of its 15 tracked top-level nodes
   * (each currently a leaf, so this equals `this._targetBarNodes.length`,
   * but it is a genuine DOM walk, not a hardcoded return — see report). */
  __targetBarNodeCount() {
    let n = 0;
    for (let i = 0; i < this._targetBarNodes.length; i++) n += countNodes(this._targetBarNodes[i]);
    return n;
  }

  /** @returns {number} real, measured node count for the buff strip's own
   * subtree (72-node ceiling). */
  __buffStripNodeCount() {
    let n = 0;
    for (let i = 0; i < BUFF_MAX; i++) n += countNodes(this._buffPlates[i]) + countNodes(this._buffStackText[i]) + countNodes(this._buffRemainText[i]);
    return n;
  }

  /**
   * Stages a hand-built, actor-SHAPED record (never a real pooled `Actor`,
   * never routed through `actors.spawn()`/`ai.spawnOne()`) with `rank` set
   * directly, and calls `setTargetBar()` with it — the D-41 path.
   * @param {'normal'|'minion'|'champion'|'unique'|'boss'} rank
   * @param {object} [overrides]
   */
  __debugStageRank(rank, overrides) {
    const isBoss = rank === 'boss';
    const record = {
      id: 999000,
      generation: 1,
      kind: 'monster',
      rank,
      archetypeId: isBoss ? 'molgrim' : 'bone_ranker',
      name: this._t('monster.' + (isBoss ? 'molgrim' : 'bone_ranker')),
      level: isBoss ? 30 : 14,
      flags: isBoss ? ACTOR_FLAG_BOSS : 0,
      life: 412,
      stats: { maxLife: 540, fireResist: 0, coldResist: 0, lightResist: 0, poisonResist: 0, magicResist: 0 },
      statuses: [],
      affixes: rank === 'champion' || rank === 'unique' ? ['burning', 'stoneskin'] : [],
    };
    Object.assign(record, overrides || {});
    this.setTargetBar(record);
  }
}
